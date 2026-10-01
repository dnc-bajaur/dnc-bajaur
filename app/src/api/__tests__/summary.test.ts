/**
 * "How did we do in July" — capability group 9.
 *
 * The two properties that matter are not the arithmetic — `performance.test.ts` covers that,
 * and this deliberately reuses the same calculation rather than growing a second one.
 *
 * **A summary must be scoped before it is counted.** A department summarising its own month
 * must be built from its own incidents, not from the district's totals with a filter applied
 * afterwards: the second leaks through any aggregate somebody forgot to filter (INV-05).
 *
 * **A summary must never quietly under-count.** A board showing fewer rows is visibly a list;
 * a total that is short is a number somebody writes into a report and defends in a meeting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import { districtSummaryFor } from '../summary.js';
import type { Seat } from '../../domain/authority.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const migrationsDir = join(process.cwd(), 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('a summary for a chosen period', () => {
  let pool: Pool;
  /** Two held posts — since ADR-0030 a contact IS a designation, and this table folds them. */
  let rescue: string;
  let police: string;

  const seatIn = (_departmentId: string | null, tier: 'post' | 'district'): Seat => ({
    seatId: randomUUID(),
    tier,
  });

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);
    rescue = await heldPost(`Rescue Summary ${randomUUID().slice(0, 6)}`);
    police = await heldPost(`Police Summary ${randomUUID().slice(0, 6)}`);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  /**
   * A post somebody holds, so `dispatchNames` can name it.
   *
   * ⚠️ **A row nobody can name is DROPPED from this table**, which is what made the old fixture
   * stop working: it routed to a department, and with the table gone nothing could name one.
   */
  async function heldPost(title: string): Promise<string> {
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, 'station', false, false) RETURNING seat_id`,
      [title],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone) VALUES ($1, $2) RETURNING person_id`,
      [`${title} holder`, `+92300${randomUUID().slice(0, 10)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    return seat.rows[0]!.seat_id;
  }

  /**
   * An incident that happened `daysAgo`, told to one post.
   *
   * ⚠️ **IT USED TO BE ROUTED TO A DEPARTMENT, AND THAT IS NOT A FIXTURE DETAIL.** CD-05b folds
   * this table on **who was told**, and ADR-0030 left nothing that can be routed to — so the
   * whole subject of these tests moved from the department that held an emergency to the
   * officer the control room chose. `dispatchNames` names a post from the roster, so the rows
   * survive; a department key has nothing left to name it and is dropped.
   */
  async function incidentOn(daysAgo: number, seatId: string): Promise<string> {
    const incidentId = randomUUID();
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const now = new Date().toISOString();

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: at,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        clientSeq: 1,
        payload: { reportId: randomUUID(), category: 'rta', severity: 'high' },
      },
      {
        eventId: randomUUID(),
        incidentId,
        type: 'dispatched',
        occurredAt: at,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        clientSeq: 2,
        payload: { targets: [{ kind: 'post', id: seatId }] },
      },
    ]);

    return incidentId;
  }

  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  /**
   * This department's own total, not the district's.
   *
   * **The local test database is shared and never cleaned**, so it holds whatever every other
   * suite has left behind — an assertion on a district total would be measuring the rest of
   * the test run. Each department here is created fresh in `beforeAll`, so its row contains
   * only what these tests put in it. A first version of this file asserted district totals
   * were zero and found 199 incidents from elsewhere; the numbers were right and the
   * assertion was measuring the wrong thing.
   */
  function totalFor(
    summary: Awaited<ReturnType<typeof districtSummaryFor>>,
    seatId: string,
  ): number {
    // ADR-0029 moved the fold onto whoever was TOLD, and ADR-0030 left the post as the only
    // thing that can be. `post:<seatId>` is the key `dispatchedTo` itself carries.
    return summary.performance.officers.find((d) => d.key === `post:${seatId}`)?.total ?? 0;
  }

  describe('the period is the period', () => {
    it('counts what happened inside the window and not outside it', async () => {
      await incidentOn(120, rescue);

      const inside = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(150),
        to: daysAgo(90),
      });
      const outside = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(30),
        to: daysAgo(1),
      });

      expect(totalFor(inside, rescue)).toBeGreaterThan(0);
      expect(totalFor(outside, rescue)).toBe(0);

      // The window is echoed so a screen can say what it counted, for the same reason search
      // echoes it: an empty summary and an empty window read identically otherwise (ADR-0005).
      expect(inside.period.from.slice(0, 10)).toBe(daysAgo(150).slice(0, 10));
      expect(inside.period.to.slice(0, 10)).toBe(daysAgo(90).slice(0, 10));
    });

    /**
     * A summary of July means emergencies that *happened* in July.
     *
     * Every incident these tests seed arrived seconds ago — `append` assigns `recorded_at`
     * server-side and ignores the client — so if the window were on arrival, the 200-day-old
     * incident below would land in every period, including "the last week". That is the
     * ADR-0002 failure: the district's worst nights would move into whichever month the
     * network came back.
     */
    it('files an offline report in the month it happened, not the month it arrived', async () => {
      await incidentOn(200, police);

      const recent = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(7),
      });
      const historical = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(365),
        to: daysAgo(180),
      });

      expect(totalFor(historical, police)).toBeGreaterThan(0);
      // It arrived seconds ago. It must not be in a summary of the last week.
      expect(totalFor(recent, police)).toBe(0);
    });
  });

  describe('scoped before it is counted (INV-05)', () => {
    /**
     * ⚠️ **TWO TESTS STOOD HERE AND BOTH WERE ABOUT A DEPARTMENT SUMMARISING ITS OWN MONTH.**
     *
     * One required a department's totals to hold its own work and none of a neighbour's; the
     * other, sharper one required that its neighbour's row could not be read out of the
     * per-department table even though the table has a row for everybody. Together they held
     * INV-05's shape for this surface: **scoped before it is counted**, never the district's
     * totals with a filter applied afterwards, because the second leaks through any aggregate
     * somebody forgot to filter.
     *
     * ADR-0030 leaves nobody to be scoped. There is no department to summarise, no account
     * outside the control room (ADR-0018), and nothing that can be responsible for an
     * emergency — so what is asserted is the same rule with the only two callers this district
     * has: the control room counts what it can see, and a seat with no district authority
     * counts nothing at all. The refusal happens before the arithmetic, which is the half that
     * matters — a zero produced by filtering afterwards looks identical and is not the same.
     */
    it('counts nothing at all for a seat with no district authority', async () => {
      await incidentOn(10, rescue);
      await incidentOn(10, police);

      const ordinary = await districtSummaryFor(pool, seatIn(null, 'post'), {
        from: daysAgo(20),
      });
      const district = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(20),
      });

      expect(district.scope).toBe('district');

      // The district sees both officers' work.
      expect(totalFor(district, rescue)).toBeGreaterThan(0);
      expect(totalFor(district, police)).toBeGreaterThan(0);

      // And the other seat is handed neither — not a row of zeroes it could read a name out of,
      // and not a total it could subtract from something else.
      expect(totalFor(ordinary, rescue)).toBe(0);
      expect(totalFor(ordinary, police)).toBe(0);
      expect(ordinary.performance.officers).toHaveLength(0);
    });
  });

  describe('what it says about its own completeness', () => {
    it('reports truncation as a field rather than leaving a short total to speak for itself', async () => {
      const summary = await districtSummaryFor(pool, seatIn(null, 'district'), {
        from: daysAgo(365),
      });

      // A total nobody can tell is short is the failure this field exists to prevent.
      expect(typeof summary.truncated).toBe('boolean');
      expect(summary.truncated).toBe(false);
    });
  });

  /**
   * 🔴 **`GET /summary` answered a different period from the one it was asked for — M11-28.**
   *
   * The route handed `?from=&to=` straight to `windowFor`, which takes **instants**. And
   * `Date.parse('2026-07-01')` is a perfectly good instant: **UTC midnight**. Bajaur is UTC+05:00,
   * so a district asking for one day was answered from **05:00 that morning to 05:00 the next**
   * — the last nineteen hours of the requested day missing, five hours of the day before
   * included instead, and `period` reporting that window in confident ISO.
   *
   * **Nothing in `web/src/` had ever called this route**, which is why nobody had seen it. That
   * is the whole reason M11-28 reads *"`GET /summary` gets its door"* and not *"wire it up"*:
   * an endpoint with no door is an endpoint nobody has checked.
   *
   * Fourth instance of this shape here — after `board.ts`'s `setHours`/`setUTCHours`, the report
   * filename, and `parseRange`'s own third disguise. **A date and an instant are different
   * things**, and this route was where the two met without anybody looking.
   *
   * ⚠️ Asserted **through the HTTP route**, deliberately. `districtSummaryFor` was never wrong —
   * it folds whatever window it is handed. The defect was entirely in how the query string became
   * that window, so a test calling the function directly passes over the whole of it, exactly as
   * every existing test in this file does.
   */
  describe('the period it was asked for is the period it answers (M11-28)', () => {
    it('covers the whole of a district day, not from 05:00 to 05:00', async () => {
      const { createSyncServer } = await import('../server.js');
      const { hashPassword } = await import('../../auth/passwords.js');
      const { login } = await import('../../auth/sessions.js');
      const { districtDate, startOfNamedDistrictDay, endOfNamedDistrictDay } =
        await import('../../domain/districtTime.js');

      const seat = await pool.query<{ seat_id: string }>(
        // ADR-0030 — the trigger derives `tier` from `is_administration` alone (migration 0039), so
        // the value passed for it is overwritten. Asking for `district` and writing nothing else
        // gets a `department` seat, and every assertion below then fails a long way from the cause.
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'district', false, true) RETURNING seat_id`,
        [`Summary Route ${randomUUID().slice(0, 6)}`],
      );
      const phone = `+92300${randomUUID().slice(0, 10)}`;
      const person = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash) VALUES ($1, $2, $3)
         RETURNING person_id`,
        ['Summary Route Operator', phone, await hashPassword('duty-officer-2026')],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seat.rows[0]!.seat_id,
        person.rows[0]!.person_id,
      ]);
      const session = await login(pool, phone, 'duty-officer-2026');
      if (session === null) throw new Error('login failed');

      /**
       * **Yesterday, at one minute to its district midnight.**
       *
       * Yesterday rather than today so the day is closed and cannot move underneath the
       * assertion, and the last minute because that is precisely the part the old window cut:
       * `to = Date.parse(day)` is 05:00 Bajaur, so everything after it was outside the period.
       */
      const day = districtDate(new Date(Date.now() - 86_400_000));
      const lastMinute = new Date(Date.parse(endOfNamedDistrictDay(day)!) - 60_000).toISOString();

      const incidentId = randomUUID();
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'reported',
          occurredAt: lastMinute,
          recordedAt: new Date().toISOString(),
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'web',
          clientSeq: 1,
          payload: { reportId: randomUUID(), category: 'rta', severity: 'high' },
        },
      ]);

      const server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/summary?from=${day}&to=${day}`, {
          headers: { authorization: `Bearer ${session.token}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as Awaited<ReturnType<typeof districtSummaryFor>>;

        // The window is the district's own day, both ends.
        expect(body.period.from).toBe(startOfNamedDistrictDay(day));
        expect(body.period.to).toBe(endOfNamedDistrictDay(day));

        /**
         * And the days are reported as the district writes them — carried, never sliced out of
         * the instants above. `from.slice(0, 10)` on a UTC+05:00 midnight names the day before,
         * which is the bug this pair exists to prevent and which this repository has shipped.
         */
        expect(body.period.fromDate).toBe(day);
        expect(body.period.toDate).toBe(day);

        // The emergency in the last minute of that day is inside the period — the assertion the
        // old 05:00-to-05:00 window failed.
        expect(body.performance.district.total).toBeGreaterThan(0);

        const bad = await fetch(`http://127.0.0.1:${port}/summary?from=not-a-date`, {
          headers: { authorization: `Bearer ${session.token}` },
        });
        // Said plainly rather than silently falling back to a window nobody asked for.
        expect(bad.status).toBe(400);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }, 60_000);
  });
});
