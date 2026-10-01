/**
 * Integration tests against a real PostgreSQL.
 *
 * These deliberately do not run against a stub. The property under test is durability and
 * genuine immutability, and an in-memory fake cannot demonstrate either — it would let
 * INV-01 be marked proven while proving nothing. If TEST_DATABASE_URL is absent the suite
 * refuses to run rather than passing quietly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { append, currentCursor, loadIncident, loadSince, lateArrivals } from '../eventStore.js';
import { createPool, migrate, type Pool } from '../pool.js';
import { compareEvents, foldIncident } from '../../domain/incident.js';
import type { IncidentEvent, Severity } from '../../domain/events.js';

const url = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe.skipIf(url === undefined)('event store (integration)', () => {
  let pool: Pool;
  let incidentId: string;

  beforeAll(async () => {
    pool = createPool(url);
    await migrate(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    // A fresh incident id per test. Nothing is ever deleted between tests — the table is
    // append-only, and pretending otherwise in the test suite would undermine the point.
    incidentId = randomUUID();
    baseInstant = new Date().toISOString();
  });

  let seq = 0;
  let baseInstant: string;

  function ev(
    type: string,
    payload: Record<string, unknown>,
    over: Partial<{
      eventId: string;
      occurredAt: string;
      incidentId: string;
      clientSeq: number;
    }> = {},
  ): IncidentEvent {
    seq += 1;
    return {
      eventId: over.eventId ?? randomUUID(),
      incidentId: over.incidentId ?? incidentId,
      type,
      // Deliberately one shared instant for every event in a test. This is the real case —
      // a batch created offline shares a millisecond — and it is what broke the fold
      // before migration 0002.
      occurredAt: over.occurredAt ?? baseInstant,
      recordedAt: new Date().toISOString(),
      clientSeq: over.clientSeq ?? seq,
      actorPersonId: randomUUID(),
      actorSeatId: randomUUID(),
      sourceChannel: 'mobile',
      payload,
    } as IncidentEvent;
  }

  it('round-trips events and folds them into the expected state', async () => {
    const events = [
      ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'high' as Severity }),
      ev('triaged', { severity: 'critical' as Severity, category: 'rta' }),
      ev('acknowledged', { seatId: randomUUID() }),
    ];

    const result = await append(pool, events);
    expect(result).toEqual({ appended: 3, duplicates: 0 });

    const loaded = await loadIncident(pool, incidentId);
    expect(loaded).toHaveLength(3);

    const state = foldIncident(incidentId, loaded);
    expect(state.status).toBe('acknowledged');
    expect(state.severity?.value).toBe('critical');
  });

  it('stores recorded_at server-side, not from the client', async () => {
    // A device with a wrong clock must not be able to misreport when we learned of an
    // emergency, because escalation timing depends on it.
    const bogus = { ...ev('reported', { reportId: randomUUID(), category: 'x', severity: 'low' }) };
    (bogus as { recordedAt: string }).recordedAt = '1999-01-01T00:00:00.000Z';

    await append(pool, [bogus]);
    const [stored] = await loadIncident(pool, incidentId);

    expect(stored!.recordedAt.startsWith('1999')).toBe(false);
  });

  describe('idempotency (INV-08)', () => {
    it('re-appending the same events is a no-op', async () => {
      const events = [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'high' }),
        ev('routed', { departmentIds: [randomUUID()], ruleId: 'manual' }),
      ];

      expect(await append(pool, events)).toEqual({ appended: 2, duplicates: 0 });
      expect(await append(pool, events)).toEqual({ appended: 0, duplicates: 2 });
      expect(await loadIncident(pool, incidentId)).toHaveLength(2);
    });

    it('a partially-synced batch appends only what is missing', async () => {
      // Exactly what a client sees after an ambiguous network failure: it does not know
      // which of its queued events landed, so it resends all of them.
      const a = ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'high' });
      const b = ev('triaged', { severity: 'critical', category: 'rta' });

      await append(pool, [a]);
      expect(await append(pool, [a, b])).toEqual({ appended: 1, duplicates: 1 });
      expect(await loadIncident(pool, incidentId)).toHaveLength(2);
    });

    it('folding a doubly-replayed log gives the same state', async () => {
      const events = [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'high' }),
        ev('acknowledged', { seatId: randomUUID() }),
      ];
      await append(pool, events);
      await append(pool, events);

      const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
      expect(state.eventCount).toBe(2);
    });
  });

  describe('append-only is enforced by the database (ADR-0001)', () => {
    beforeEach(async () => {
      await append(pool, [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'high' }),
      ]);
    });

    it('rejects UPDATE', async () => {
      await expect(
        pool.query(`UPDATE incident_event SET type = 'tampered' WHERE incident_id = $1`, [
          incidentId,
        ]),
      ).rejects.toThrow(/append-only/i);
    });

    it('rejects DELETE', async () => {
      await expect(
        pool.query(`DELETE FROM incident_event WHERE incident_id = $1`, [incidentId]),
      ).rejects.toThrow(/append-only/i);
    });

    it('rejects TRUNCATE, which row triggers would otherwise miss', async () => {
      await expect(pool.query('TRUNCATE incident_event')).rejects.toThrow(/append-only/i);
    });

    it('the row survives every attempt', async () => {
      expect(await loadIncident(pool, incidentId)).toHaveLength(1);
    });
  });

  describe('sync cursor', () => {
    it('returns only events after the cursor, and advances it', async () => {
      // `currentCursor` rather than paging the whole log. An earlier version took the
      // `nextCursor` of a 10,000-row page, which is the end of the log right up until the
      // log has more than ten thousand events in it — and then it quietly is not.
      const before = await currentCursor(pool);
      await append(pool, [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'low' }),
      ]);

      const after = await loadSince(pool, before);
      expect(after.events.some((e) => e.incidentId === incidentId)).toBe(true);
      expect(after.nextCursor).toBeGreaterThan(before);

      const drained = await loadSince(pool, after.nextCursor);
      expect(drained.events).toHaveLength(0);
    });

    it('pages through a batch without losing events sharing one recorded_at', async () => {
      // Every event written in one transaction shares a recorded_at. A timestamp cursor
      // would resume past the whole batch and lose the remainder — invisibly, and forever.
      const batch = Array.from({ length: 5 }, (_, i) => ev('action_logged', { note: `step ${i}` }));
      const start = await currentCursor(pool);
      await append(pool, batch);

      const seen: string[] = [];
      let cursor = start;
      for (let i = 0; i < 10; i++) {
        const page = await loadSince(pool, cursor, 2);
        if (page.events.length === 0) break;
        seen.push(...page.events.map((e) => e.eventId));
        cursor = page.nextCursor;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });

  describe('causal ordering (migration 0002)', () => {
    it('preserves client order when every event shares one instant', async () => {
      // The regression that migration 0002 exists for. Before clientSeq, these four
      // folded in random uuid order and the override was silently lost.
      const events = [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'moderate' }),
        ev('triaged', { severity: 'high', category: 'rta' }),
        ev('overridden', { field: 'severity', value: 'critical', reason: 'casualties confirmed' }),
        ev('acknowledged', { seatId: randomUUID() }),
      ];

      await append(pool, events);
      const loaded = await loadIncident(pool, incidentId);

      expect(loaded.map((e) => e.type)).toEqual([
        'reported',
        'triaged',
        'overridden',
        'acknowledged',
      ]);
    });

    it('storage order matches the domain comparator exactly', async () => {
      const events = [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'low' }),
        ev('triaged', { severity: 'high', category: 'rta' }),
        ev('escalated', { fromSeatId: null, toSeatId: randomUUID(), trigger: 'manual' }),
      ];
      await append(pool, events);

      const fromDb = (await loadIncident(pool, incidentId)).map((e) => e.eventId);
      const sorted = [...events].sort(compareEvents).map((e) => e.eventId);

      expect(fromDb).toEqual(sorted);
    });
  });

  describe('late arrivals', () => {
    it('surfaces an incident that reached us long after it happened', async () => {
      // Reported during an outage at 14:02, synced at 16:40.
      const hoursAgo = new Date(Date.now() - 158 * 60_000).toISOString();
      await append(pool, [
        ev(
          'reported',
          { reportId: randomUUID(), category: 'rta', severity: 'critical' },
          { occurredAt: hoursAgo },
        ),
      ]);

      const late = await lateArrivals(pool, 15);
      const mine = late.find((l) => l.incidentId === incidentId);

      expect(mine).toBeDefined();
      expect(Math.round(mine!.gapMinutes)).toBeGreaterThanOrEqual(157);
    });

    it('ignores incidents that arrived promptly', async () => {
      await append(pool, [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'low' }),
      ]);
      const late = await lateArrivals(pool, 15);
      expect(late.some((l) => l.incidentId === incidentId)).toBe(false);
    });
  });

  describe('projection rebuild (M0-09)', () => {
    it('state derived from the database matches state derived in memory', async () => {
      const events = [
        ev('reported', { reportId: randomUUID(), category: 'rta', severity: 'moderate' }),
        ev('triaged', { severity: 'high', category: 'rta' }),
        ev('overridden', {
          field: 'severity',
          value: 'critical',
          reason: 'second reporter confirms casualties',
        }),
        ev('acknowledged', { seatId: randomUUID() }),
      ];

      await append(pool, events);

      const fromDb = foldIncident(incidentId, await loadIncident(pool, incidentId));
      const inMemory = foldIncident(incidentId, events);

      expect(fromDb.status).toBe(inMemory.status);
      expect(fromDb.severity?.value).toBe('critical');
      // The department's own assessment survived the round trip through storage.
      expect(fromDb.severity?.overriddenFrom?.value).toBe('high');
    });
  });
});

describe('database suite guard', () => {
  it('warns loudly if TEST_DATABASE_URL is missing', () => {
    if (url === undefined) {
      // Visible in output rather than a silent skip: an unproven invariant must look
      // unproven. See docs/01-invariants.md.
      expect.soft(url, 'TEST_DATABASE_URL not set — event store suite did NOT run').toBeDefined();
    }
    expect(true).toBe(true);
  });
});
