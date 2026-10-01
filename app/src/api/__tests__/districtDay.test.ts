/**
 * ADR-0020 — the district's day ends at midnight, on every surface.
 *
 * The district asked for a board that resets daily and for escalation to stop with the day. That
 * decision **accepts a failure mode**: an emergency unacknowledged at midnight is pursued by no
 * software afterwards. Everything here exists because a decision that costly must be the one
 * actually running, not the one somebody remembers agreeing to.
 *
 * Four things are under test, and the last two are the ones that matter:
 *
 *   1. The board shows one district day, and `?date=` reaches any other.
 *   2. **An emergency that happened yesterday and arrived today is on today's board.** Without
 *      this the offline story breaks exactly where it is most expensive: a fire reported at 23:40
 *      from a village with no signal, synced at 06:10, would be filed under a day nobody is
 *      looking at while it is still burning.
 *   3. **Yesterday's unacknowledged emergency is not escalated today.** This is the decision
 *      itself. If this test ever fails, the district is getting behaviour it explicitly refused.
 *   4. **And it does not merely go quiet — it says it stopped.** Silence and a recorded stop must
 *      never be indistinguishable, because a crashed job, a switched-off server, an exhausted
 *      ladder and a normal midnight all look the same in a log that says nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { runEscalationPass } from '../../jobs/escalation.js';
import {
  districtDate,
  endOfNamedDistrictDay,
  startOfNamedDistrictDay,
} from '../../domain/districtTime.js';
import { recordDateRange } from '../../domain/recordWindow.js';
import type { IncidentEvent } from '../../domain/events.js';
import type { Board } from '../board.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';
const DAY = 86_400_000;

describe.skipIf(dbUrl === undefined)('the district day (ADR-0020)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let token: string;
  let department: string;
  let deptSeat: string;

  const today = districtDate();
  const tomorrow = districtDate(new Date(Date.now() + DAY));

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    department = await seedDepartment(pool);
    deptSeat = await seat('Day Test Station In-Charge', 'post');
    // A rung above, so the ladder has somewhere to climb when it is allowed to.
    await seat('Day Test Control Room', 'district');
    // ADR-0030 — the reader is the CONTROL ROOM, and since ADR-0018 there is nobody else with
    // an account. This signed in a department-tier duty officer, which was harmless while an
    // unplaced incident was readable by anybody; it is not readable by anybody now, and this
    // file is about which DAY the board shows rather than about who may see it.
    token = await signIn('Day Test Control Room Reader', 'district');
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  // ADR-0030 — no department parameter. Migration 0039 dropped the column, and the tier is now
  // the only thing this helper was ever really being asked for.
  async function seat(title: string, tier: string): Promise<string> {
    const s = await pool.query<{ seat_id: string }>(
      // ADR-0030 — the trigger derives `tier` from `is_administration` alone (migration 0039), so
      // the value passed for it is overwritten. Asking for `district` and writing nothing else
      // gets a `department` seat, and every assertion below then fails a long way from the cause.
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, false, $3) RETURNING seat_id`,
      [title, tier, tier === 'district'],
    );
    const seatId = s.rows[0]!.seat_id;
    const p = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, 'x') RETURNING person_id`,
      [title, `+92300${randomUUID().slice(0, 9)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      p.rows[0]!.person_id,
    ]);
    return seatId;
  }

  async function signIn(name: string, tier: string): Promise<string> {
    const s = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, false, $3) RETURNING seat_id`,
      [name, tier, tier === 'district'],
    );
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      s.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return result.token;
  }

  /**
   * An open, unacknowledged emergency.
   *
   * `occurredAt` is ours to choose; **`recorded_at` is the database's** and always now. That is
   * not a limitation of the test, it is the property that makes the audit trail worth having —
   * so "yesterday" is expressed by moving the clock the reader uses, never by backdating a row.
   */
  async function emergency(
    occurredAt = new Date().toISOString(),
    kind = 'emergency',
  ): Promise<string> {
    const incidentId = randomUUID();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: deptSeat,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category: 'rta', severity: 'critical', kind },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 2,
        actorPersonId: null,
        actorSeatId: deptSeat,
        sourceChannel: 'system',
        payload: { departmentIds: [department], ruleId: 'manual' },
      } as unknown as IncidentEvent,
    ]);
    return incidentId;
  }

  async function boardFor(date: string | null): Promise<Board> {
    const url = date === null ? `${base}/incidents` : `${base}/incidents?date=${date}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as Board;
  }

  const ids = (board: Board): readonly string[] => board.incidents.map((r) => r.incidentId);

  it('shows today by default, and says which day it is showing', async () => {
    const id = await emergency();
    const board = await boardFor(null);

    expect(ids(board)).toContain(id);
    // Always present, not only when the date is not today. A date that appears sometimes is a
    // date operators stop looking for — and the whole hazard this decision accepts is somebody
    // reading one day's board as the current state of Bajaur.
    expect(board.date).toBe(today);
  });

  it('does not carry today’s emergency onto tomorrow’s board', async () => {
    const id = await emergency();
    expect(ids(await boardFor(tomorrow))).not.toContain(id);
  });

  it('reaches any other day by date, which is what makes the reset acceptable', async () => {
    const id = await emergency();
    const board = await boardFor(today);
    expect(ids(board)).toContain(id);
    expect(board.date).toBe(today);
  });

  /**
   * **The Record's own view: every record, newest first, whatever day it started** — Phase 4c,
   * widened 2026-09-06 to carry closed rows too (the owner's call).
   *
   * This is the other half of the reset being survivable. The Dashboard is one district day and
   * an incident belongs to the day it started, so an emergency opened last week is in **no**
   * counter and, since ADR-0020 §4b, chased by **no** escalation. If the Record also opened on
   * today, the only route left to it would be to already know it is there — and a thing you have
   * to know to look for is a thing nobody looks for.
   *
   * ⚠️ **Closed rows are part of this view now.** Dropping them left the top of the list on a
   * stale still-open case while the newest thing that happened — resolved by lunchtime — was
   * nowhere on screen. So `?open=1` folds open and closed alike; `open` is a historical param
   * name for the Record's own whole-record view.
   *
   * `date` comes back `null`, and the screen is required to say so: ADR-0020's rule that every
   * surface names the period it is showing applies hardest to the one view that is not a day.
   */
  it('opens on every record, newest first, from any day — closed rows included', async () => {
    const openId = await emergency();
    const closedId = await emergency();
    // Resolve one of them. `recorded_at` is still now, so this stays "a record from today" for
    // the day rule while being finished work the old view would have dropped.
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: closedId,
        type: 'resolved',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 3,
        actorPersonId: null,
        actorSeatId: deptSeat,
        sourceChannel: 'system',
        payload: { outcome: 'dealt with by lunchtime' },
      } as unknown as IncidentEvent,
    ]);

    const res = await fetch(`${base}/incidents?open=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const board = (await res.json()) as Board;
    expect(ids(board)).toContain(openId);
    // The finished one is on the Record's own view now — this is the change.
    expect(ids(board)).toContain(closedId);
    expect(board.incidents.find((r) => r.incidentId === closedId)?.status).toBe('resolved');
    expect(board.date).toBeNull();

    // And tomorrow's board still does not carry either — this view is a wider selection, not the
    // day rule being softened. Both are true at once, which is the whole point.
    expect(ids(await boardFor(tomorrow))).not.toContain(openId);
    expect(ids(await boardFor(tomorrow))).not.toContain(closedId);
  });

  it('refuses being asked for a day AND for the whole record, rather than choosing', async () => {
    /**
     * *"The whole record, newest first"* and *"this Tuesday"* are two different questions, and a
     * caller sending both has lost track of which it is asking. Answering one silently is how a
     * screen comes to print a date it is not showing — the failure the test above this one
     * exists for, arriving through a second door.
     */
    const res = await fetch(`${base}/incidents?open=1&date=${today}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed date rather than quietly showing today', async () => {
    // Falling back would hand an operator a board that is real, current, and **not the day they
    // asked for**, with nothing on screen disagreeing with them.
    const res = await fetch(`${base}/incidents?date=not-a-date`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a day outside the visible Record window rather than returning a false empty board', async () => {
    const range = recordDateRange();
    const before = new Date(`${range.from}T12:00:00.000Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    const tooOld = before.toISOString().slice(0, 10);

    const res = await fetch(`${base}/incidents?date=${tooOld}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain(range.from);
    expect(body.error).toContain(range.to);
  });

  it('puts an emergency that happened last night and arrived this morning on BOTH days', async () => {
    /**
     * The offline case, and the most expensive one to get wrong.
     *
     * A fire at 23:40 in a village with no signal, synced at 06:10. It is **yesterday's fact**
     * and **today's work**, and those are different questions:
     *
     *   - yesterday's board and yesterday's report, because that is when it happened (ADR-0002)
     *   - today's board, because the fire may still be burning and nobody is looking at yesterday
     */
    const yesterday = districtDate(new Date(Date.now() - DAY));
    const lateLastNight = endOfNamedDistrictDay(yesterday);
    expect(lateLastNight).not.toBeNull();

    const id = await emergency(new Date(Date.parse(lateLastNight!) - 20 * 60_000).toISOString());

    expect(ids(await boardFor(today))).toContain(id);
    expect(ids(await boardFor(yesterday))).toContain(id);
  });

  it('files an emergency by the district’s midnight, not by UTC’s', async () => {
    /**
     * Bajaur is UTC+05:00, so 19:30Z is already 00:30 the next morning there. An incident 30
     * minutes either side of the district's midnight must land on different days — this is the
     * exact ground the timezone defect (O-01) lived on, and it was live on the district's own
     * board for a week.
     */
    const dayStart = startOfNamedDistrictDay(today);
    expect(dayStart).not.toBeNull();

    const justBefore = new Date(Date.parse(dayStart!) - 30 * 60_000).toISOString();
    const justAfter = new Date(Date.parse(dayStart!) + 30 * 60_000).toISOString();

    expect(districtDate(justBefore)).not.toBe(districtDate(justAfter));
    expect(districtDate(justAfter)).toBe(today);
  });

  describe('the morning report carries what survived a midnight', () => {
    /**
     * ADR-0020's obligation, and the only thing standing where the board used to.
     *
     * The district accepted that an emergency unacknowledged at midnight is pursued by no
     * software. This block is what puts it back in front of a person — and it must be in front of
     * somebody doing **ordinary** work, not somebody already looking for a problem.
     */
    async function todaysReport(): Promise<{ status: number; body: string }> {
      const res = await fetch(`${base}/reports/daily`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.text() };
    }

    it('names an emergency from an earlier day that nobody ever responded to', async () => {
      const yesterday = districtDate(new Date(Date.now() - DAY));
      const at = startOfNamedDistrictDay(yesterday);
      expect(at).not.toBeNull();

      await emergency(new Date(Date.parse(at!) + 6 * 60 * 60_000).toISOString());

      const report = await todaysReport();
      expect(report.status).toBe(200);
      // Was "Never acknowledged, from earlier days" until 2026-09-04 — see
      // `domain/dailyReport.ts` and `api/dailyReport.ts`'s headers.
      expect(report.body).toContain('Never responded to, from earlier days');
      // Said in words. A red heading alone is colour carrying meaning on its own (INV-04), and
      // this is the sentence somebody has to act on.
      expect(report.body).toContain('nothing is chasing them any more');
      expect(report.body).toContain(yesterday);
    });

    it('says nothing at all when there is nothing outstanding', async () => {
      // A permanent "Still outstanding: 0" is a heading people learn to skip, which is exactly
      // how the one morning it says 3 gets skipped too (the same reason `moreSentence` returns
      // null rather than "and 0 more").
      const fresh = await fetch(`${base}/reports/daily?date=${tomorrow}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await fresh.text();
      expect(fresh.status).toBe(200);
      expect(body).not.toContain('Never responded to, from earlier days');
    });
  });

  describe('escalation stops with the day', () => {
    it('does not escalate an emergency once its district day has ended', async () => {
      const id = await emergency();

      /**
       * **The pass must land inside the incident's own district day** — 2026-08-14.
       *
       * `now: Date.now() + 90 minutes` was hard-coded here, and it quietly destroyed this test's
       * own premise for the last ninety minutes of every district day. Reported at 22:35 and
       * escalated at 00:05, the incident belongs to *yesterday*, `candidates` does not return it,
       * and the precondition below fails — for exactly the reason the second half of this test
       * exists to prove. Found that way at 22:35 on 2026-08-14; it had passed all afternoon.
       *
       * ⚠️ **Backdating `occurredAt` is not the alternative, and it looks like it should be.**
       * `append` assigns `recorded_at` from the **database** clock, never from the event, so a
       * backdated report becomes a huge `arrivalGapMinutes`: `lateArrival` turns true, the clock
       * starts at `recorded_at` — which is real *now* — and any earlier instant passed as `now`
       * gives negative elapsed time. Tried, and it fails in a second, quieter way.
       *
       * So the incident stays at real time and the pass is clamped to just inside the day.
       * `critical: 1` keeps the margin it needs, since the clamp can leave very little of the day.
       */
      const dayEnd = endOfNamedDistrictDay(today);
      expect(dayEnd).not.toBeNull();
      const passAt = Math.min(Date.now() + 90 * 60_000, Date.parse(dayEnd!) - 1_000);

      // Proof the emergency is escalatable at all — otherwise the next assertion passes for the
      // wrong reason, which is how a test comes to guard nothing.
      const sameDay = await runEscalationPass(pool, {
        incidentIds: [id],
        now: new Date(passAt).toISOString(),
        targets: { critical: 1, high: 15, moderate: 60, low: 240, unknown: 15 },
      });
      expect(sameDay.escalated).toBe(1);

      const nextDay = await runEscalationPass(pool, {
        incidentIds: [id],
        now: new Date(Date.now() + DAY).toISOString(),
        targets: { critical: 1, high: 15, moderate: 60, low: 240, unknown: 15 },
      });
      expect(nextDay.scanned).toBe(0);
      expect(nextDay.escalated).toBe(0);
    });

    it('records that the chase ended, so silence is never mistaken for a crash', async () => {
      const id = await emergency();

      const pass = await runEscalationPass(pool, {
        incidentIds: [id],
        now: new Date(Date.now() + DAY).toISOString(),
        targets: { critical: 5, high: 15, moderate: 60, low: 240, unknown: 15 },
      });
      expect(pass.ended).toBe(1);

      const events = await loadIncident(pool, id);
      const closing = events.filter((e) => e.type === 'escalation_ended');
      expect(closing).toHaveLength(1);
      expect(closing[0]!.payload).toMatchObject({ reason: 'day_ended', districtDate: today });
    });

    it('writes that record once, however many times the job runs', async () => {
      const id = await emergency();
      const now = new Date(Date.now() + DAY).toISOString();
      const opts = {
        incidentIds: [id],
        now,
        targets: { critical: 5, high: 15, moderate: 60, low: 240, unknown: 15 },
      };

      // Webhooks retry, schedulers overlap, and servers get restarted. A bookkeeping event that
      // is not idempotent becomes a second kind of noise in the record it exists to clarify.
      await runEscalationPass(pool, opts);
      const second = await runEscalationPass(pool, opts);
      expect(second.ended).toBe(0);

      const events = await loadIncident(pool, id);
      expect(events.filter((e) => e.type === 'escalation_ended')).toHaveLength(1);
    });

    it('says nothing about a meeting notice, which was never being chased', async () => {
      // Recording the end of something that never began would put a line in the district's
      // record describing a chase that was never owed (M9-10, `CARRIES_SLA`).
      const id = await emergency(new Date().toISOString(), 'meeting');

      const pass = await runEscalationPass(pool, {
        incidentIds: [id],
        now: new Date(Date.now() + DAY).toISOString(),
        targets: { critical: 5, high: 15, moderate: 60, low: 240, unknown: 15 },
      });
      expect(pass.ended).toBe(0);

      const events = await loadIncident(pool, id);
      expect(events.filter((e) => e.type === 'escalation_ended')).toHaveLength(0);
    });
  });
});
