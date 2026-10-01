/**
 * Bajaur's weather, fetched by the server — M4-04, ADR-0013.
 *
 * Why the server and not the television:
 *
 * **One fetch serves every screen.** Two offices with a screen each, plus anybody who opens
 * the app, is one request every fifteen minutes instead of a request per viewer per load.
 *
 * **A kiosk browser is a public browser.** Any key it holds is a key on the wall. Open-Meteo
 * needs no key, which is most of why it was chosen (ADR-0007: the boring option) — but a
 * decision that only works because today's provider is free is a decision that breaks on the
 * day it is not.
 *
 * **A district with no internet says so once, honestly.** If each screen fetched for itself,
 * a line failure would leave three televisions each showing a different stale number with no
 * way to tell. Here there is one reading, with one age, and the panel states it.
 *
 * Nothing here throws on a failed fetch. Weather is the least important thing on the screen
 * and must never be able to take the screen down with it.
 */

import type { Pool } from 'pg';
import { latestWeather, pruneWeather, storeWeather } from '../db/wallStore.js';

/**
 * Where Bajaur is.
 *
 * These are approximate coordinates for Khar, Bajaur's headquarters, and they are a **default, not a
 * finding**: the district may want the reading taken somewhere else entirely — the DC office,
 * or a tehsil that floods first. `WEATHER_LAT` / `WEATHER_LON` override them, and R-16 asks
 * the district to confirm the point they actually want watched.
 *
 * (This asked for "R-13" until 2026-08-03. That number was already Rescue 1122's list of
 * response actions, so the weather question was renumbered rather than the older row.)
 */
const DEFAULT_LAT = 34.7167;
const DEFAULT_LON = 71.5167;

/** Pakistan Standard Time. Open-Meteo returns local times when told the zone. */
const TIMEZONE = 'Asia/Karachi';

export interface Weather {
  readonly temperatureC: number | null;
  readonly apparentC: number | null;
  readonly humidity: number | null;
  readonly windKph: number | null;
  readonly precipitationChance: number | null;
  readonly code: number | null;
  readonly condition: string;
  readonly sunrise: string | null;
  readonly sunset: string | null;
  readonly observedAt: string;
}

/**
 * WMO weather codes, in the words a person would use.
 *
 * The unmapped fallback is deliberately "unknown" rather than a guess at the nearest
 * neighbour. A wall screen reading "Cloudy" when the code meant freezing drizzle is worse
 * than one reading "code 56" — the first is confidently wrong and the second sends somebody
 * to look it up.
 */
const CONDITIONS: Readonly<Record<number, string>> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

export function describeCode(code: number | null): string {
  if (code === null) return 'unknown';

  return CONDITIONS[code] ?? `unknown (code ${String(code)})`;
}

/** The subset of Open-Meteo's response this uses. Everything is optional; providers change. */
interface OpenMeteoResponse {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    sunrise?: string[];
    sunset?: string[];
    precipitation_probability_max?: number[];
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Turn a provider response into the shape the screen uses.
 *
 * Exported so the mapping is tested without a network. Every field is read defensively: a
 * provider that renames one column should cost that field, not the panel.
 */
export function readOpenMeteo(body: unknown, fallbackTime: string): Weather {
  const parsed = (body ?? {}) as OpenMeteoResponse;
  const current = parsed.current ?? {};
  const daily = parsed.daily ?? {};
  const code = num(current.weather_code);

  return {
    temperatureC: num(current.temperature_2m),
    apparentC: num(current.apparent_temperature),
    humidity: num(current.relative_humidity_2m),
    windKph: num(current.wind_speed_10m),
    precipitationChance: num(daily.precipitation_probability_max?.[0]),
    code,
    condition: describeCode(code),
    sunrise: daily.sunrise?.[0] ?? null,
    sunset: daily.sunset?.[0] ?? null,
    observedAt: typeof current.time === 'string' ? current.time : fallbackTime,
  };
}

export interface FetchResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Injected so the test never touches a network, and so a timeout is the caller's choice. */
export type Fetcher = (
  url: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export function weatherUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
    daily: 'sunrise,sunset,precipitation_probability_max',
    wind_speed_unit: 'kmh',
    timezone: TIMEZONE,
    forecast_days: '1',
  });

  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

/**
 * Fetch once and store it, or record that it could not be done.
 *
 * A failure leaves the previous reading in place and untouched. That is the whole design:
 * the screen then shows the old number *with its real age*, which is a true statement, rather
 * than a blank panel that says nothing about whether the district's line is down.
 */
export async function refreshWeather(
  pool: Pool,
  options: { fetcher?: Fetcher; lat?: number; lon?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  const lat = options.lat ?? Number(process.env['WEATHER_LAT'] ?? DEFAULT_LAT);
  const lon = options.lon ?? Number(process.env['WEATHER_LON'] ?? DEFAULT_LON);

  const fetcher: Fetcher =
    options.fetcher ??
    ((url) =>
      fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) }).then((r) => ({
        ok: r.ok,
        status: r.status,
        json: () => r.json() as Promise<unknown>,
      })));

  try {
    const response = await fetcher(weatherUrl(lat, lon));

    if (!response.ok) {
      return { ok: false, error: `provider replied ${String(response.status)}` };
    }

    const reading = readOpenMeteo(await response.json(), new Date().toISOString());

    // A response that parsed but carries no temperature is a changed API, not weather.
    // Storing it would replace a good old reading with a blank new one and reset its age —
    // the one outcome worse than a failed fetch.
    if (reading.temperatureC === null) {
      return { ok: false, error: 'provider returned no temperature' };
    }

    await storeWeather(pool, {
      observedAt: reading.observedAt,
      payload: reading as unknown as Record<string, unknown>,
    });
    await pruneWeather(pool);

    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface WeatherPanel {
  readonly reading: Weather | null;
  readonly fetchedAt: string | null;
  readonly ageMinutes: number | null;
}

/** What the screen is given: the reading, and how old it is. Never one without the other. */
export async function weatherPanel(pool: Pool, now = new Date()): Promise<WeatherPanel> {
  const stored = await latestWeather(pool);

  if (stored === null) return { reading: null, fetchedAt: null, ageMinutes: null };

  const fetched = new Date(stored.fetchedAt).getTime();
  const ageMinutes = Number.isNaN(fetched)
    ? null
    : Math.max(0, Math.floor((now.getTime() - fetched) / 60_000));

  return {
    reading: stored.payload as unknown as Weather,
    fetchedAt: stored.fetchedAt,
    ageMinutes,
  };
}
