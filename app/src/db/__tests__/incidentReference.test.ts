/**
 * The district's own number, against a real PostgreSQL — 2026-08-24.
 *
 * Against the real database and not a stub, for the same reason the event store's own suite is:
 * the three properties this feature has are **database** properties. Gaplessness is a lock and a
 * `MAX(seq)`; assign-once is a trigger; idempotence is an `ON CONFLICT`. A fake would let all
 * three be marked proven while proving none of them.
 *
 * ⚠️ **Nothing here may assume it starts at 1.** The table is append-only, the suite shares one
 * cluster with every other integration test, and an assertion that the first number is 1 would
 * pass alone and fail in `npm test`. Every case here reads the highest number first and asserts
 * a *relationship* to it — which is also the only thing that is true on a district that has been
 * running for a month.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { append } from '../eventStore.js';
import {
  assignReferences,
  incidentForReference,
  referenceFor,
  referencesFor,
} from '../referenceStore.js';
import { createPool, migrate, type Pool } from '../pool.js';
import type { IncidentEvent } from '../../domain/events.js';

const url = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe.skipIf(url === undefined)('the district numbers its own emergencies', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url);
    await migrate(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function highest(): Promise<number> {
    const res = await pool.query<{ max: string | null }>(
      'SELECT MAX(seq)::text AS max FROM incident_reference',
    );
    return Number(res.rows[0]?.max ?? 0);
  }

  function reported(incidentId: string, over: Record<string, unknown> = {}): IncidentEvent {
    return {
      eventId: randomUUID(),
      incidentId,
      type: 'reported',
      occurredAt: new Date().toISOString(),
      clientSeq: 1,
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'test',
      payload: { reportId: randomUUID(), category: 'fire', severity: 'high' },
      ...over,
    } as unknown as IncidentEvent;
  }

  it('gives a report the next number, on the append that stores it', async () => {
    const before = await highest();
    const incidentId = randomUUID();

    await append(pool, [reported(incidentId)]);

    expect(await referenceFor(pool, incidentId)).toBe(before + 1);
  });

  it('counts without gaps, in the order the server recorded them', async () => {
    const before = await highest();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();

    // Three separate appends: the ordinary case, three reports arriving one after another, and
    // the one the counter has to be right about.
    await append(pool, [reported(first)]);
    await append(pool, [reported(second)]);
    await append(pool, [reported(third)]);

    expect(await referenceFor(pool, first)).toBe(before + 1);
    expect(await referenceFor(pool, second)).toBe(before + 2);
    expect(await referenceFor(pool, third)).toBe(before + 3);
  });

  it('numbers a batch that arrives together without repeating or skipping', async () => {
    const before = await highest();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    // One sync from a handset that was offline: four reports in a single append.
    await append(
      pool,
      ids.map((id) => reported(id)),
    );

    const given = await referencesFor(pool, ids);
    const numbers = [...given.values()].sort((a, b) => a - b);
    expect(numbers).toEqual([before + 1, before + 2, before + 3, before + 4]);
  });

  it('is a no-op the second time, so a retried sync never renumbers anything', async () => {
    const incidentId = randomUUID();
    const events = [reported(incidentId)];

    await append(pool, events);
    const first = await referenceFor(pool, incidentId);

    // The same events again — an offline client retrying a sync it is not sure landed (INV-08).
    await append(pool, events);
    await assignReferences(pool);

    expect(await referenceFor(pool, incidentId)).toBe(first);
  });

  it('numbers nothing that was never reported', async () => {
    // An acknowledgement arriving for an incident whose report has not synced yet. It has no
    // number, because the report is what creates an incident.
    const incidentId = randomUUID();
    await append(pool, [reported(incidentId, { type: 'acknowledged', payload: {} })]);

    expect(await referenceFor(pool, incidentId)).toBeNull();
  });

  it('picks up anything an earlier sweep missed, in arrival order', async () => {
    // What the first boot after this ships does to a district that has been running a month:
    // rows already in the log with no number, numbered in the order the server recorded them.
    const before = await highest();
    const older = randomUUID();
    const newer = randomUUID();

    // Written straight to the table, past `append` — so nothing numbers them on the way in.
    for (const [id, recordedAt] of [
      [newer, '2026-08-24T10:00:00.000Z'],
      [older, '2026-08-24T09:00:00.000Z'],
    ] as const) {
      await pool.query(
        `INSERT INTO incident_event
           (event_id, incident_id, type, occurred_at, recorded_at, client_seq, source_channel, payload)
         VALUES ($1, $2, 'reported', $3::timestamptz, $3::timestamptz, 1, 'test', '{}'::jsonb)`,
        [randomUUID(), id, recordedAt],
      );
    }

    await assignReferences(pool);

    // Arrival order, not insertion order — the older report is numbered first even though it was
    // written second.
    expect(await referenceFor(pool, older)).toBe(before + 1);
    expect(await referenceFor(pool, newer)).toBe(before + 2);
  });

  it('finds the incident from the number, which is what search does', async () => {
    const incidentId = randomUUID();
    await append(pool, [reported(incidentId)]);
    const seq = await referenceFor(pool, incidentId);

    expect(seq).not.toBeNull();
    expect(await incidentForReference(pool, seq as number)).toBe(incidentId);
  });

  it('answers nothing for a number never issued, rather than failing', async () => {
    expect(await incidentForReference(pool, (await highest()) + 10_000)).toBeNull();
  });

  it('never moves a number once it has been given out', async () => {
    const incidentId = randomUUID();
    await append(pool, [reported(incidentId)]);

    // A number printed on a report submitted upward must still point at the same night a year
    // later. The database refuses, not a code review — the rule `incident_event` already follows.
    await expect(
      pool.query('UPDATE incident_reference SET seq = seq + 1000 WHERE incident_id = $1', [
        incidentId,
      ]),
    ).rejects.toThrow(/assign-once/);

    await expect(
      pool.query('DELETE FROM incident_reference WHERE incident_id = $1', [incidentId]),
    ).rejects.toThrow(/assign-once/);
  });

  it('asks for nothing when asked about nothing', async () => {
    expect((await referencesFor(pool, [])).size).toBe(0);
  });
});
