/**
 * **The loader that does not count in days** — the district's five, 2026-08-22.
 *
 * Integration, against a real PostgreSQL, for the reason `eventStore.test.ts` gives in its own
 * header: what is under test is a **query**, and a stub would only demonstrate that a stub does
 * what its author believed.
 *
 * 🔴 **The property this file exists for is the one that cannot be tested by moving a clock.**
 * `loadRecentIncidents` filters on `recorded_at > now() - interval`, evaluated by the *database*,
 * so passing a later `now` into JavaScript does not widen it and back-dating a row is impossible
 * — the log is append-only under a trigger and `recorded_at` is the server's. The honest way to
 * prove a loader ignores the window is therefore to ask the *other* loader for a window that
 * excludes everything, and show this one still finds the row.
 *
 * That is the whole of the district's second complaint: a meeting three weeks out falls out of a
 * seven-day fetch on day eight, and the panel would have gone quiet about it with no error
 * anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { append, loadCarriedIncidents, loadRecentIncidents } from '../eventStore.js';
import { createPool, migrate, type Pool } from '../pool.js';
import { CARRIED_CATEGORY_LIST, CARRIED_KIND_LIST } from '../../domain/carrying.js';
import type { IncidentEvent, MessageKind } from '../../domain/events.js';

const url = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe.skipIf(url === undefined)('the carried loader (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url);
    await migrate(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool?.end();
  });

  let seq = 0;

  async function report(
    incidentId: string,
    category: string,
    kind: MessageKind = 'emergency',
  ): Promise<void> {
    seq += 1;
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: seq,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category, severity: 'moderate', kind },
      } as unknown as IncidentEvent,
    ]);
  }

  async function add(incidentId: string, type: string, payload: unknown): Promise<void> {
    seq += 1;
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type,
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: seq,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'app',
        payload,
      } as unknown as IncidentEvent,
    ]);
  }

  async function carriedIds(): Promise<Set<string>> {
    const groups = await loadCarriedIncidents(pool, CARRIED_KIND_LIST, CARRIED_CATEGORY_LIST);
    return new Set(groups.map((g) => g[0]?.incidentId ?? ''));
  }

  it('selects what carries and leaves what clears', async () => {
    const flood = randomUUID();
    const meeting = randomUUID();
    const fire = randomUUID();

    await report(flood, 'flood');
    await report(meeting, 'other', 'meeting');
    await report(fire, 'fire');

    const ids = await carriedIds();

    expect(ids.has(flood)).toBe(true);
    expect(ids.has(meeting)).toBe(true);
    // Q5, answered yes by the district: fire, road accidents and medical still clear at midnight.
    expect(ids.has(fire)).toBe(false);
  });

  it('🔴 finds a carried row a seven-day window would never have shown it', async () => {
    /**
     * The assertion the whole phase rests on, and the only honest way to make it.
     *
     * `loadRecentIncidents(pool, 0, …)` is a window that excludes **everything** — the same
     * shape as the day-eight window that made a meeting three weeks out disappear. This loader
     * is asked the same database and still finds the row, because it selects on *has this
     * finished* rather than on *when did it arrive*.
     */
    const meeting = randomUUID();
    await report(meeting, 'other', 'meeting');

    const windowed = await loadRecentIncidents(pool, 0, 500);
    expect(windowed.some((g) => g[0]?.incidentId === meeting)).toBe(false);

    expect((await carriedIds()).has(meeting)).toBe(true);
  });

  it('carries anything the control room held, whatever it is about', async () => {
    // Q7's other direction: a fire burning into a third day. The default would have taken it off
    // the wall on day two, so the query has to admit it on the strength of the event alone.
    const fire = randomUUID();
    await report(fire, 'fire');
    expect((await carriedIds()).has(fire)).toBe(false);

    await add(fire, 'held_over', { reason: 'burning into a third day' });
    expect((await carriedIds()).has(fire)).toBe(true);
  });

  it('drops what has been resolved, and takes it back when it is reopened', async () => {
    /**
     * ⚠️ **The one place this query reads the log's meaning at all**, and it is deliberately the
     * cheap proxy `jobs/escalation.ts` already uses: narrow the candidates, let the fold decide.
     * Generous in the direction the fold can undo — a candidate that turns out to be finished is
     * dropped downstream, while a candidate never selected is a row nobody can see.
     */
    const flood = randomUUID();
    await report(flood, 'flood');
    expect((await carriedIds()).has(flood)).toBe(true);

    await add(flood, 'resolved', { outcome: 'water down, villages clear' });
    expect((await carriedIds()).has(flood)).toBe(false);

    await add(flood, 'reopened', { reason: 'rain again overnight' });
    expect((await carriedIds()).has(flood)).toBe(true);
  });

  it('takes its vocabulary from the domain, so the two cannot drift apart', async () => {
    /**
     * ⚠️ Handed as parameters rather than written into the SQL. The day somebody adds a sixth
     * kind to `carrying.ts`, a hardcoded query would go on selecting the old five — the panel
     * would silently stop showing a category, with every test in `carrying.test.ts` still green.
     *
     * Asked with an EMPTY vocabulary, this returns only what was explicitly held, which is what
     * proves the lists are load-bearing rather than decorative.
     */
    const flood = randomUUID();
    await report(flood, 'flood');

    const none = await loadCarriedIncidents(pool, [], []);
    expect(none.some((g) => g[0]?.incidentId === flood)).toBe(false);
  });
});
