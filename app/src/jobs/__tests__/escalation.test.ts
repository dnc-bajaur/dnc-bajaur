/**
 * INV-07: an SLA clock never runs on a client.
 *
 * The domain logic has known *when* to escalate since day one, and `invariants.test.ts`
 * proves that in isolation. What it could not prove is that anything actually calls it —
 * so until now the invariant held of a function rather than of a running system.
 *
 * Nothing in this file opens a browser or touches a client. The only inputs are stored
 * events, the roster, and server time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { runEscalationPass, nextSeatUp } from '../escalation.js';
import { createScheduler, runLockedPass } from '../scheduler.js';
import { districtDate, endOfNamedDistrictDay } from '../../domain/districtTime.js';
import type { IncidentEvent } from '../../domain/events.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const MINUTE = 60_000;

describe.skipIf(dbUrl === undefined)('escalation job (INV-07)', () => {
  let pool: Pool;
  let department: string;
  let stationSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    department = await seedDepartment(pool);
    stationSeat = await seat('Rescue Station In-Charge', 'post', true);
    // A second post in the same department. There is no rung between them (ADR-0010) —
    // it exists so the ladder has something to *not* climb to.
    await seat('Rescue Supervisor', 'post', true);
    // Department-agnostic, so it serves as the fallback rung above any department.
    await seat('District Control Room', 'district', true);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  // ADR-0030 — no department parameter. Migration 0039 dropped the column, and a helper still
  // asking for one describes a model the district does not have, in the file somebody reads to
  // learn how escalation is seeded.
  async function seat(title: string, tier: string, withHolder: boolean): Promise<string> {
    // ⚠️ ADR-0030 — migration 0039's trigger derives `tier` from `is_administration` alone, so
    // the value passed for it is overwritten. Asking for `district` and writing nothing else
    // gets a `department` seat, and the ladder then has nothing above it to climb to.
    const s = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, is_administration) VALUES ($1, $2, $3) RETURNING seat_id`,
      [title, tier, tier === 'district'],
    );
    const seatId = s.rows[0]!.seat_id;

    if (withHolder) {
      const p = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, 'x') RETURNING person_id`,
        [title, `+92300${randomUUID().slice(0, 9)}`],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        p.rows[0]!.person_id,
      ]);
    }
    return seatId;
  }

  /**
   * Time is driven forward by passing `now` to the pass, not by backdating rows.
   *
   * `recorded_at` is assigned by the database and the event table is append-only, so there
   * is no way to fabricate "the server has known about this for 30 minutes" — which is
   * correct, and exactly the property that makes the audit trail trustworthy. Advancing
   * the clock the job reads is the honest equivalent, and it proves the point directly:
   * the only inputs are stored timestamps and server time.
   */
  /**
   * Later today — and **never tomorrow** (2026-08-14).
   *
   * ⚠️ **This is the second file found with the same defect, hours after the first.** Every
   * incident here is reported at real *now*, and escalation stops at the end of the district day
   * (ADR-0020): `candidates` only returns incidents belonging to the day of the `now` it is given.
   * So `Date.now() + 30 minutes` silently became *a different district day* for the last half hour
   * of every night, `candidates` returned nothing, and five tests failed together. Observed at
   * 23:59 on 2026-08-14; green all day before it.
   *
   * Clamped to just inside the day, which is safe because **no caller here wants tomorrow** —
   * every one asks for 1 or 30 minutes, to get past an SLA target rather than to cross a
   * boundary. A test that genuinely wants the next day must say so explicitly rather than reach
   * for this.
   *
   * `districtDay.test.ts` carries the same fix and the note on why backdating `occurredAt` is not
   * an alternative: `append` assigns `recorded_at` from the database clock.
   */
  function minutesLater(minutes: number): string {
    const wanted = Date.now() + minutes * MINUTE;
    const dayEnd = endOfNamedDistrictDay(districtDate());
    if (dayEnd === null) return new Date(wanted).toISOString();

    return new Date(Math.min(wanted, Date.parse(dayEnd) - 1_000)).toISOString();
  }

  /** An open, unacknowledged incident, reported now. */
  async function openIncident(
    _unused = 0,
    severity = 'critical',
    opts: { actorSeatId?: string | null } = {},
  ): Promise<string> {
    const incidentId = randomUUID();
    const occurredAt = new Date().toISOString();

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: opts.actorSeatId ?? stationSeat,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category: 'rta', severity },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt,
        recordedAt: occurredAt,
        clientSeq: 2,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { departmentIds: [department], ruleId: 'manual' },
      } as unknown as IncidentEvent,
    ]);

    return incidentId;
  }

  async function escalationsFor(incidentId: string): Promise<readonly IncidentEvent[]> {
    return (await loadIncident(pool, incidentId)).filter((e) => e.type === 'escalated');
  }

  /**
   * The ladder has two rungs now (ADR-0010, migration 0010).
   *
   * These tests used to climb station → tehsil → district, and the middle rung was fiction:
   * the district's contact list has no tier column, so every real seat defaulted to
   * `district` and there was never a tehsil above anything. What the ladder actually does in
   * Bajaur is one step — a department, then the administration — and that is what is asserted
   * here.
   */
  describe('the ladder', () => {
    it('escalates from a department straight to a district seat', async () => {
      // Asserted on tier rather than identity: district seats are department-agnostic by
      // design, so any held district seat is a correct answer. Pinning one id would only
      // pass on an empty database, and this one is append-only and never cleaned.
      const next = await nextSeatUp(pool, 'post', department);
      expect(next?.tier).toBe('district');
      expect(next?.hasHolder).toBe(true);
    });

    /**
     * ⚠️ **THE QUESTION SURVIVED ADR-0030; THE COLUMN IT WAS ASKED THROUGH DID NOT.**
     *
     * This selected `DISTINCT tier FROM seat WHERE department_id = $1` and required every post
     * in one office to be `department` tier — a department could not create a rung above itself
     * by naming a post *"Supervisor"*, because migration 0010's trigger derived tier from the
     * office rather than from the title. Migration 0039 dropped the column, and the rule it was
     * protecting is now **stronger and easier to state**: tier is derived from a single ticked
     * column, so the only thing that can put a post on the upper rung is somebody ticking it.
     * A title cannot, and neither can anything else a department could do to itself.
     */
    it('has no rung a post can climb to by being renamed', async () => {
      const grand = await seat('Grand Supervisor Of Everything', 'post', true);

      const tier = await pool.query<{ tier: string; is_administration: boolean }>(
        'SELECT tier, is_administration FROM seat WHERE seat_id = $1',
        [grand],
      );
      expect(tier.rows[0]?.tier).toBe('post');
      expect(tier.rows[0]?.is_administration).toBe(false);

      // And there is still a rung above it, held, so the ladder is not merely flat.
      expect(await nextSeatUp(pool, 'post', department)).not.toBeNull();
    });

    it('returns null at the top, because there is nothing above the district', async () => {
      // Q-10, closed: provincial escalation is out of scope. An emergency that reaches the
      // top unacknowledged surfaces as *needs a human, urgently* rather than climbing to a
      // rung that does not exist.
      expect(await nextSeatUp(pool, 'district', department)).toBeNull();
    });
  });

  describe('escalation fires with no client involved', () => {
    it('escalates an unacknowledged critical past its deadline', async () => {
      // Critical target is 5 minutes; this one is 30 minutes old and untouched.
      const incidentId = await openIncident();

      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [incidentId],
      });
      expect(outcome.escalated).toBeGreaterThanOrEqual(1);

      const escalations = await escalationsFor(incidentId);
      expect(escalations).toHaveLength(1);

      // Onto a **district** seat, not onto a second post inside the same department.
      // Before ADR-0010 this asserted a "tehsil supervisor" rung that the district's real
      // roster never had — every loaded post defaulted to `district`, so the middle of the
      // ladder was a fiction the tests were keeping alive.
      const toSeatId = (escalations[0]!.payload as { toSeatId: string }).toSeatId;
      const tier = await pool.query<{ tier: string }>('SELECT tier FROM seat WHERE seat_id = $1', [
        toSeatId,
      ]);
      expect(tier.rows[0]?.tier).toBe('district');

      // A system escalation names no person — it was not a human decision.
      expect(escalations[0]!.actorPersonId).toBeNull();
    });

    it('leaves an incident inside its deadline alone', async () => {
      const incidentId = await openIncident();
      await runEscalationPass(pool, { now: minutesLater(1), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });

    it('respects the severity-specific target', async () => {
      // Low severity has a 240-minute target; 30 minutes is well inside it.
      const incidentId = await openIncident(0, 'low');
      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('it does not storm', () => {
    it('does not escalate the same incident twice at the same tier', async () => {
      const incidentId = await openIncident();

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      const afterFirst = (await escalationsFor(incidentId)).length;

      // Four more passes in quick succession, as a 15-second scan loop would do.
      for (let i = 0; i < 4; i++)
        await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });

      expect(afterFirst).toBe(1);

      // **One**, not two. The ladder has a single rung now (ADR-0010): a department, then
      // the administration, then nothing. Five passes in quick succession produce exactly
      // the one escalation the first pass produced — which is the property INV-08 is about,
      // and it is a stronger statement with two rungs than it was with four.
      expect(await escalationsFor(incidentId)).toHaveLength(1);
    });

    it('a late-arriving incident gets its grace window rather than instant escalation', async () => {
      // Reported 3 hours ago, only reached the server now. Escalating immediately would
      // page the duty officer about every queued incident at once (INV-08).
      const incidentId = randomUUID();
      const occurredAt = new Date(Date.now() - 180 * MINUTE).toISOString();

      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'reported',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: stationSeat,
          sourceChannel: 'mobile',
          payload: { reportId: randomUUID(), category: 'rta', severity: 'critical' },
        } as unknown as IncidentEvent,
      ]);

      // `recordedAt` is server-assigned and therefore ~now, so the gap is ~3 hours.
      await runEscalationPass(pool, { incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('nothing is starved by the scan cap', () => {
    it('scans the oldest open incidents first and says when it hit the cap', async () => {
      // The bug this pins: the candidate query used to take an arbitrary `LIMIT` of the
      // open set with no ordering. Once a district had more open incidents than the cap,
      // *which* ones got scanned was down to whatever order Postgres happened to return —
      // so an emergency could lose that lottery on every single pass and sit unescalated
      // indefinitely, with nothing anywhere reporting a problem.
      const first = await openIncident();
      await new Promise((r) => setTimeout(r, 20));
      const second = await openIncident();

      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [first, second],
        limit: 1,
      });

      // Oldest first, so the one that has been waiting longest is the one seen.
      expect(await escalationsFor(first)).toHaveLength(1);
      expect(await escalationsFor(second)).toHaveLength(0);
      // And the cap being hit is reported, never silently absorbed.
      expect(outcome.truncated).toBe(true);
    });

    it('does not claim truncation when everything was scanned', async () => {
      const incidentId = await openIncident();
      const outcome = await runEscalationPass(pool, {
        now: minutesLater(30),
        incidentIds: [incidentId],
        limit: 500,
      });
      expect(outcome.truncated).toBe(false);
    });
  });

  describe('it stops when it should', () => {
    it('never escalates an acknowledged incident', async () => {
      const incidentId = await openIncident();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'acknowledged',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 3,
          actorPersonId: randomUUID(),
          actorSeatId: stationSeat,
          sourceChannel: 'web',
          payload: { seatId: stationSeat },
        } as unknown as IncidentEvent,
      ]);

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });

    it('never escalates a closed incident', async () => {
      const incidentId = await openIncident();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'closed',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 3,
          actorPersonId: randomUUID(),
          actorSeatId: stationSeat,
          sourceChannel: 'web',
          payload: { notes: 'resolved on scene' },
        } as unknown as IncidentEvent,
      ]);

      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });
      expect(await escalationsFor(incidentId)).toHaveLength(0);
    });
  });

  describe('a vacant post never swallows an escalation (ADR-0004)', () => {
    it('escalates to an unheld seat and reports it as needing a human', async () => {
      // A department whose escalation lands on an **unheld district post**. Migration 0010
      // derives tier from the office, so the vacant post has to sit in an administrative one
      // — which is the real shape of this failure anyway: the rung above a department is the
      // administration, and the question is what happens when nobody is in it.
      /**
       * ADR-0030 — the **administrative** department that stood here is gone, and the comment
       * above is the reason it existed: a vacant district post had to sit in an administrative
       * office, because migration 0010 derived tier from the office. Migration 0039 derives it
       * from `seat.is_administration`, so the tier is asked for directly and there is nothing
       * left to file the post under.
       *
       * ⚠️ **`dept` stays, and it is not the same thing.** It is never a seat's home now — it is
       * the opaque id this incident is ROUTED to, which `routed` still carries and the fold still
       * reads. The question the test asks is untouched: what happens when the rung above a
       * department is vacant.
       */
      const dept = await seedDepartment(pool);
      await seat('Understaffed Station', 'post', true);
      const vacant = await seat('Vacant District Post', 'district', false);

      // Empty every **other** district post for the duration, and put them back afterwards.
      //
      // Not a trick to make the test pass — it is the only way to construct the scenario at
      // all. The ladder now prefers any *held* seat at the rung above, which is correct and
      // is what makes the district's real configuration safe: with two administrative
      // offices staffed, an escalation reaches a person. This test is about the case where
      // it cannot, so every other person at that rung has to be off duty.
      const others = await pool.query<{
        assignment_id: string;
        seat_id: string;
        person_id: string;
      }>(
        `UPDATE duty_assignment d SET to_at = now()
           FROM seat s
          WHERE s.seat_id = d.seat_id AND s.tier = 'district' AND d.to_at IS NULL
        RETURNING d.assignment_id, d.seat_id, d.person_id`,
      );

      const incidentId = randomUUID();
      const occurredAt = new Date(Date.now() - 30 * MINUTE).toISOString();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'reported',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        } as unknown as IncidentEvent,
        {
          eventId: randomUUID(),
          incidentId,
          type: 'routed',
          occurredAt,
          recordedAt: occurredAt,
          clientSeq: 2,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'system',
          payload: { departmentIds: [dept], ruleId: 'manual' },
        } as unknown as IncidentEvent,
      ]);

      // Everything the assertions need is read **while the district is still unstaffed**.
      // Reading it afterwards asked whether the chosen seat had a holder once everyone had
      // been put back on duty, which is a different question with the opposite answer.
      let outcome;
      let payload: { toSeatId: string; trigger: string } | undefined;
      let chosenSeatWasEmpty = false;
      let escalationCount = 0;

      try {
        outcome = await runEscalationPass(pool, {
          now: minutesLater(30),
          incidentIds: [incidentId],
        });

        const escalations = await escalationsFor(incidentId);
        escalationCount = escalations.length;
        payload = escalations[0]?.payload as { toSeatId: string; trigger: string } | undefined;

        if (payload !== undefined) {
          const held = await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM duty_assignment
              WHERE seat_id = $1 AND to_at IS NULL`,
            [payload.toSeatId],
          );
          chosenSeatWasEmpty = Number(held.rows[0]!.n) === 0;
        }
      } finally {
        // Back on duty, whatever happened above. A failing assertion must not leave the rest
        // of this file running against a district with nobody at the top of the ladder.
        for (const row of others.rows) {
          await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
            row.seat_id,
            row.person_id,
          ]);
        }
      }

      expect(outcome.noHolder).toContain(incidentId);
      expect(escalationCount).toBe(1);

      // Asserted as "the seat it landed on had nobody in it" rather than "it landed on the
      // seat this test created". Several district posts were unheld at that moment — the ones
      // relieved above among them — and which unheld one wins is not what this invariant is
      // about. ADR-0004's claim is that the escalation **lands** and is **reported**, not
      // that it lands anywhere in particular.
      expect(chosenSeatWasEmpty).toBe(true);
      expect(payload?.toSeatId).toBeTruthy();
      // The post this test created is a live, unheld district post, so the scenario really
      // did offer the ladder somewhere empty to go.
      const stillThere = await pool.query<{ tier: string; retired_at: string | null }>(
        'SELECT tier, retired_at FROM seat WHERE seat_id = $1',
        [vacant],
      );
      expect(stillThere.rows[0]).toEqual({ tier: 'district', retired_at: null });

      // Distinguishable from an ordinary missed deadline, for whoever reviews it after.
      expect(payload?.trigger).toBe('no_duty_holder');
    });
  });

  describe('the whole chain still folds correctly', () => {
    it('an escalated incident reports its escalation count and current seat', async () => {
      const incidentId = await openIncident();
      await runEscalationPass(pool, { now: minutesLater(30), incidentIds: [incidentId] });

      const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
      expect(state.escalationCount).toBe(1);
      expect(state.acknowledgedAt).toBeNull();

      // The seat it now sits on is a district one. Asserted on tier rather than on a fixed
      // id: any held district seat is a correct answer, and this database is append-only and
      // never cleaned, so pinning one would only pass on an empty cluster.
      expect(state.currentEscalationSeatId).not.toBeNull();
      const tier = await pool.query<{ tier: string }>('SELECT tier FROM seat WHERE seat_id = $1', [
        state.currentEscalationSeatId,
      ]);
      expect(tier.rows[0]?.tier).toBe('district');
    });
  });

  describe('two instances cannot both escalate', () => {
    it('only one of two concurrent passes takes the lock', async () => {
      const results = await Promise.all([runLockedPass(pool), runLockedPass(pool)]);
      const ran = results.filter((r) => r !== null);
      // The other returned null, which is a normal outcome and not a failure.
      expect(ran.length).toBeGreaterThanOrEqual(1);
      expect(results.length).toBe(2);
    });

    it('the lock is released even when a pass throws', async () => {
      // A pass that wedged the lock would silently stop every future escalation.
      await runLockedPass(pool);
      expect(await runLockedPass(pool)).not.toBeNull();
    });
  });

  describe('the scheduler', () => {
    /**
     * The scheduler is responsible for *invoking* passes, stopping cleanly, and surviving
     * a failure. Whether a given incident escalates is `runEscalationPass`'s job and is
     * proven above with the clock driven explicitly.
     *
     * Keeping those separate matters: a scheduler test that also asserts on escalation
     * outcomes has to manufacture a real-time deadline breach, and the only way to do that
     * against a server-assigned `recorded_at` is a zero-minute target — which every
     * incident then trips as a "late arrival", so nothing escalates and the test proves
     * the opposite of what it claims.
     */
    it('invokes passes on an interval and stops cleanly', async () => {
      const outcomes: unknown[] = [];
      const scheduler = createScheduler({
        pool,
        intervalMs: 50,
        onOutcome: (o) => outcomes.push(o),
      });

      scheduler.start();

      // Wait for the work, not for a guessed duration. This log is append-only and never
      // cleaned, so the candidate scan grows with every run; a fixed sleep passes on a
      // fresh database and fails later, which is the worst kind of test.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && outcomes.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await scheduler.stop();
      expect(outcomes.length).toBeGreaterThanOrEqual(1);

      // Stopped means stopped.
      const countAtStop = outcomes.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(outcomes).toHaveLength(countAtStop);
    });

    it('a failing pass never kills the loop', async () => {
      // An escalation loop that dies after one bad database moment is worse than none,
      // because everyone still believes it is watching.
      const errors: unknown[] = [];
      const broken = { connect: () => Promise.reject(new Error('db gone')) } as unknown as Pool;

      const scheduler = createScheduler({
        pool: broken,
        intervalMs: 30,
        onError: (e) => errors.push(e),
      });

      scheduler.start();
      await new Promise((r) => setTimeout(r, 200));
      await scheduler.stop();

      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
