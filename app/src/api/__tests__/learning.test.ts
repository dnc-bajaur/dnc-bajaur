/**
 * Learning, end to end — M7-15…M7-22, against real PostgreSQL.
 *
 * `domain/learning.ts` pins the judgement. What this file pins is the two things that can only
 * go wrong between the log and the screen:
 *
 *   * **it is a projection with no table** — the proposals appear because dispatches happened,
 *     and nothing was written down to make them appear
 *   * **it proposes and never decides** — the pre-tick is a suggestion on a response, and no
 *     `routed` event, no obligation and no message follows from it
 *
 * Plus M7-20, which is a date and would otherwise be nobody's job to check: dispatches made
 * before the learning clock started are not counted, because they encode a workaround for a bug
 * rather than a preference.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { loadDispatchHistory } from '../../db/dispatchHistory.js';
import { proposalsFor } from '../../domain/learning.js';
import { append } from '../../db/eventStore.js';
import type { IncidentEvent } from '../../domain/events.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);
/** A category nothing else in the database has ever used, so the counts are this run's. */
const CATEGORY = `learn-${RUN}`;

describe.skipIf(dbUrl === undefined)('learning from what the control room does', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let rescueDept: string;
  /**
   * ⚠️ **WHAT THE DISTRICT IS LEARNED TO CHOOSE IS A POST NOW — ADR-0030.**
   *
   * The fixture dispatched `{ kind: 'department', id: rescueDept }`, which `dispatch-to` refuses
   * outright since migration 0039 — so six dispatches recorded nothing, the fold had nothing to
   * count, and the panel that proposes who to tell learned that the control room had never once
   * chosen anybody. The claim is unchanged: what the district keeps doing, it stops being asked.
   */
  let rescueSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (learn ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (learn ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (learn ${RUN})`);
    rescueSeat = (
      await seedActor(pool, { title: `Duty Officer (learn ${RUN})`, departmentId: rescueDept })
    ).seatId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function reportAndTell(category: string): Promise<string> {
    const created = await fetch(`${base}/incidents`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ category, severity: 'high', description: `learn ${RUN}` }),
    });
    const id = ((await created.json()) as { incidentId: string }).incidentId;

    await fetch(`${base}/incidents/${id}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });
    return id;
  }

  interface Directory {
    learned?: { kind: string; id: string; times: number; outOf: number; because: string }[];
    proposed?: { kind: string; id: string }[];
  }

  async function directory(category: string): Promise<Directory> {
    const res = await fetch(
      `${base}/contacts/recipients?category=${encodeURIComponent(category)}&description=`,
      { headers: authHeaders(controlToken) },
    );
    return (await res.json()) as Directory;
  }

  it('proposes nothing until the district has actually done something', async () => {
    // The honest starting state, and the one Bajaur is in. A system that guessed here would be
    // guessing from nothing, which is worse than a blank list because it looks like knowledge.
    expect((await directory(CATEGORY)).learned ?? []).toHaveLength(0);
  });

  it('learns a post the control room keeps choosing, and explains why', async () => {
    for (let i = 0; i < 6; i += 1) await reportAndTell(CATEGORY);

    const learned = (await directory(CATEGORY)).learned ?? [];
    const rescue = learned.find((l) => l.id === rescueSeat);

    expect(rescue).toBeDefined();
    expect(rescue?.times).toBeGreaterThanOrEqual(6);
    // Every proposal says why, in words, on the server — so the intake screen, the console and
    // any later report cannot round the same two numbers differently (M7-18).
    expect(rescue?.because).toContain('you told them for');
    expect(rescue?.because).toContain(CATEGORY);
  });

  it('learned it from the log, having written nothing down', async () => {
    /**
     * M7-15. There is no learning table, no counter and no nightly job — the proposal is a fold
     * over `dispatched` events, exactly like the board is a fold over the incident's own.
     *
     * Asserted by reading the same history the endpoint reads and getting the same answer from
     * the pure function. If a store were ever introduced, this would keep passing while the
     * endpoint drifted — so the assertion below is the one that would notice.
     */
    const history = await loadDispatchHistory(pool);
    const fromLog = proposalsFor(history, CATEGORY);
    const fromApi = (await directory(CATEGORY)).learned ?? [];

    expect(fromApi.map((p) => p.id).sort()).toEqual(fromLog.map((p) => p.id).sort());

    const tables = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%learn%'`,
    );
    expect(Number(tables.rows[0]!.n)).toBe(0);
  });

  it('proposes and does not route, however sure it is', async () => {
    /**
     * M7-17, and it is the line the whole phase turns on. Auto-routing from a learned rule
     * would let one quiet Tuesday's mistake become the district's standing rule — and then
     * reinforce itself, because pre-ticked things get accepted.
     *
     * So: report an emergency in a category the system is now confident about, and check that
     * confidence changed **nothing** about the incident.
     */
    const created = await fetch(`${base}/incidents`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ category: CATEGORY, severity: 'high', description: `learn ${RUN}` }),
    });
    const id = ((await created.json()) as { incidentId: string }).incidentId;

    const state = await fetch(`${base}/incidents/${id}`, { headers: authHeaders(controlToken) });
    const body = (await state.json()) as {
      state: { responsibleDepartmentIds: string[]; notifications: unknown[]; unassigned: boolean };
    };

    // Nobody holds it, nobody has been told, and the board says so — which is correct, because
    // no human has decided anything yet (ADR-0005: the absence is the signal).
    expect(body.state.responsibleDepartmentIds).toHaveLength(0);
    expect(body.state.notifications).toHaveLength(0);
    expect(body.state.unassigned).toBe(true);
  });

  it('ignores dispatches made before the learning clock started', async () => {
    /**
     * M7-20. Before 2026-08-06 a dispatch left the board saying *"nobody has this"*, so
     * operators worked around it — dispatching twice, dispatching to departments they did not
     * mean, routing by hand afterwards. Those choices encode a bug, not a preference, and a
     * system that learned from them would learn the workaround.
     *
     * Backdated events rather than a mocked clock, because the boundary is in the query and
     * that is where it has to hold.
     */
    const older = `${CATEGORY}-old`;
    const when = '2026-07-01T05:00:00.000Z';

    /**
     * Appended directly, with an old `occurredAt`.
     *
     * The first version of this test dispatched through the API and then backdated the rows
     * with an UPDATE — and **the database refused it**: `incident_event` is append-only and
     * the trigger says so (ADR-0001). That is the invariant working, on a test, which is the
     * cheapest place to find out it is real.
     */
    for (let i = 0; i < 8; i += 1) {
      const incidentId = randomUUID();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          occurredAt: when,
          recordedAt: when,
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'web',
          type: 'reported',
          payload: { category: older, severity: 'high', description: `learn ${RUN}` },
        },
        {
          eventId: randomUUID(),
          incidentId,
          occurredAt: when,
          recordedAt: when,
          clientSeq: 2,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'web',
          type: 'dispatched',
          // ⚠️ A POST, like every other dispatch in this file since ADR-0030. Left as a
          // `department` target this test would still pass — and for the wrong reason: nothing
          // learns a department any more, so the age boundary it exists to prove would never
          // have been reached.
          payload: { targets: [{ kind: 'post', id: rescueSeat }] },
        },
      ] as unknown as IncidentEvent[]);
    }

    expect((await directory(older)).learned ?? []).toHaveLength(0);

    // And the boundary is a boundary rather than a blanket: ask for the same history from
    // before the cutoff and the dispatches are all still there, in the log, unchanged.
    const before = await loadDispatchHistory(pool, { since: '2026-01-01T00:00:00.000Z' });
    expect(before.filter((d) => d.category === older).length).toBeGreaterThanOrEqual(8);
  });
});
