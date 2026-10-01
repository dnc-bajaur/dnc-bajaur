/**
 * The weather panel — M4-04.
 *
 * The interesting cases are all failures. Weather is the least important thing on the wall
 * screen and the most likely to break: it is the only panel that depends on a machine outside
 * the district. So what is pinned here is that it fails **without lying** and **without
 * taking anything else down**.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createPool, migrate } from '../../db/pool.js';
import { join } from 'node:path';
import {
  describeCode,
  readOpenMeteo,
  refreshWeather,
  weatherPanel,
  weatherUrl,
  type Fetcher,
} from '../weather.js';

const dbUrl = process.env['TEST_DATABASE_URL'];

const SAMPLE = {
  current: {
    time: '2026-08-03T12:00',
    temperature_2m: 38.4,
    apparent_temperature: 41.1,
    relative_humidity_2m: 31,
    wind_speed_10m: 14.2,
    weather_code: 0,
  },
  daily: {
    sunrise: ['2026-08-03T05:32'],
    sunset: ['2026-08-03T19:14'],
    precipitation_probability_max: [5],
  },
};

const replies =
  (body: unknown, ok = true, status = 200): Fetcher =>
  () =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

describe('reading a provider response', () => {
  it('maps every field the panel shows', () => {
    const w = readOpenMeteo(SAMPLE, '2026-08-03T12:00:00Z');

    expect(w.temperatureC).toBe(38.4);
    expect(w.apparentC).toBe(41.1);
    expect(w.humidity).toBe(31);
    expect(w.windKph).toBe(14.2);
    expect(w.precipitationChance).toBe(5);
    expect(w.condition).toBe('Clear');
    expect(w.sunrise).toBe('2026-08-03T05:32');
  });

  it('loses one field rather than the panel when a provider renames a column', () => {
    const w = readOpenMeteo(
      { current: { temperature_2m: 38.4, humidity_pct: 31 } },
      '2026-08-03T12:00:00Z',
    );

    expect(w.temperatureC).toBe(38.4);
    expect(w.humidity).toBeNull();
  });

  it('survives a response that is not the shape at all', () => {
    for (const body of [null, undefined, 'error', 42, [], { unexpected: true }]) {
      expect(() => readOpenMeteo(body, '2026-08-03T12:00:00Z')).not.toThrow();
    }
  });

  it('falls back to the given time when the provider omits one', () => {
    expect(readOpenMeteo({ current: {} }, '2026-08-03T12:00:00Z').observedAt).toBe(
      '2026-08-03T12:00:00Z',
    );
  });

  it('says a code is unknown rather than guessing the nearest one', () => {
    // "Cloudy" when the code meant freezing drizzle is confidently wrong. "code 56" sends
    // somebody to look it up, which is the correct outcome.
    expect(describeCode(56)).toBe('unknown (code 56)');
    expect(describeCode(null)).toBe('unknown');
    expect(describeCode(95)).toBe('Thunderstorm');
  });
});

describe('the request', () => {
  it('asks for Bajaur, in kilometres per hour, on Pakistan time', () => {
    const url = weatherUrl(34.7167, 71.5167);

    expect(url).toContain('latitude=34.7167');
    expect(url).toContain('longitude=71.5167');
    expect(url).toContain('wind_speed_unit=kmh');
    expect(url).toContain('timezone=Asia%2FKarachi');
  });

  it('carries no key, because a kiosk browser is a public browser', () => {
    expect(weatherUrl(1, 2)).not.toMatch(/key|token|secret|apikey/i);
  });
});

describe.skipIf(dbUrl === undefined)('storing and ageing a reading', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, join(process.cwd(), 'db', 'migrations'));
    await pool.query('DELETE FROM weather_reading');
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('stores a good reading and reports its age', async () => {
    const result = await refreshWeather(pool, { fetcher: replies(SAMPLE) });
    expect(result.ok).toBe(true);

    const panel = await weatherPanel(pool);
    expect(panel.reading?.temperatureC).toBe(38.4);
    expect(panel.ageMinutes).toBe(0);
    expect(panel.fetchedAt).not.toBeNull();
  });

  it('reports the real age of an old reading rather than hiding it', async () => {
    const panel = await weatherPanel(pool, new Date(Date.now() + 3 * 3600 * 1000));

    // Still shows 38.4 — and says it is three hours old. That is a true statement. A blank
    // panel would say nothing about whether the district's line is down.
    expect(panel.reading?.temperatureC).toBe(38.4);
    expect(panel.ageMinutes).toBe(180);
  });

  it('keeps the old reading when the provider is unreachable', async () => {
    const before = await weatherPanel(pool);

    const result = await refreshWeather(pool, {
      fetcher: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');

    const after = await weatherPanel(pool);
    expect(after.fetchedAt).toBe(before.fetchedAt);
  });

  it('keeps the old reading when the provider errors', async () => {
    const before = await weatherPanel(pool);
    const result = await refreshWeather(pool, { fetcher: replies({}, false, 503) });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
    expect((await weatherPanel(pool)).fetchedAt).toBe(before.fetchedAt);
  });

  it('refuses a parseable response with no temperature in it', async () => {
    // The one outcome worse than a failed fetch: replacing a good old reading with a blank
    // new one, which resets its age and makes the panel claim to be current.
    const before = await weatherPanel(pool);
    const result = await refreshWeather(pool, { fetcher: replies({ current: { time: 'x' } }) });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no temperature');
    expect((await weatherPanel(pool)).fetchedAt).toBe(before.fetchedAt);
  });

  it('never throws, whatever the provider does', async () => {
    const nasty: Fetcher[] = [
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('bad json')),
        }),
      () => Promise.reject(new Error('socket hang up')),
      () => {
        throw new Error('synchronous');
      },
    ];

    for (const fetcher of nasty) {
      await expect(refreshWeather(pool, { fetcher })).resolves.toMatchObject({ ok: false });
    }
  });

  it('says nothing has been fetched rather than inventing a zero', async () => {
    await pool.query('DELETE FROM weather_reading');
    const panel = await weatherPanel(pool);

    expect(panel.reading).toBeNull();
    expect(panel.ageMinutes).toBeNull();
  });
});
