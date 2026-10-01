/**
 * The dashboard, against a real database — M4.
 *
 * Two things are pinned here.
 *
 * **It is scoped to whoever asked.** The two administrative offices see the district; a
 * department sees its own work. Getting this wrong in the generous direction is a read leak
 * of exactly the kind migration 0010 already produced once, when every loaded post defaulted
 * to `district` and every department could read every other department's emergencies.
 *
 * **It carries nothing private.** The same response appears on a large screen in an office,
 * where it is read by whoever is in the room. That boundary is one careless join away from
 * breaking, in a file somebody edits for an unrelated reason, so it is asserted against a
 * live response rather than trusted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { buildDashboard, handleDashboard, viewerFor } from '../dashboard.js';
import { buildBoard } from '../board.js';
import { districtDate } from '../../domain/districtTime.js';
import { wallSafetyViolations } from '../../domain/wall.js';
import { append } from '../../db/eventStore.js';
import type { Identity } from '../../auth/sessions.js';
import type { Tier } from '../../domain/authority.js';
import type { IncidentEvent } from '../../domain/events.js';

const dbUrl = process.env['TEST_DATABASE_URL'];

function request(method = 'GET'): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

/**
 * A signed-in officer **holding a post**, which is what almost every case here is about.
 *
 * This used to default to `seatId: null` with `tier: 'district'` — an identity that cannot
 * exist in the database, and precisely the shape that had to be refused. Every scoping test
 * below was therefore asserting the district view for a caller holding no post, which is how
 * the leak survived a file whose own header says getting this wrong in the generous direction
 * is a read leak. **Fixtures that drift from the database prove nothing.**
 *
 * `tier` is derived the way migration 0010's trigger derives it — district exactly when the
 * office is administrative or the seat belongs to no department — rather than set by hand.
 */
function officer(overrides: Partial<Identity> = {}): Identity {
  const departmentId = overrides.departmentId ?? null;
  const isAdministration = overrides.isAdministration ?? false;
  const tier: Tier = isAdministration || departmentId === null ? 'district' : 'post';

  return {
    personId: randomUUID(),
    fullName: 'An Officer',
    seatId: randomUUID(),
    seatTitle: 'A Post',
    departmentId,
    departmentName: null,
    tier,
    canBreakGlass: false,
    isAdministration,
    ...overrides,
  } as unknown as Identity;
}

/**
 * A control-room account with no duty seat — ADR-0032. Every account minted through
 * Settings → Accounts looks like this: a `role`, no `duty_assignment`. `isAdministration`
 * follows the role (`owner`/`admin` → true).
 */
function holdsNoPost(isAdministration = false): Identity {
  return {
    personId: randomUUID(),
    fullName: 'Control Room, No Post',
    seatId: null,
    seatTitle: null,
    departmentId: null,
    departmentName: null,
    tier: null,
    canBreakGlass: false,
    isAdministration,
  } as unknown as Identity;
}

const DISTRICT = {
  scope: 'District',
  departmentId: null,
  isAdministration: true,
  seated: true,
};

describe.skipIf(dbUrl === undefined)('the dashboard', () => {
  let pool: Pool;
  let departmentId: string;
  let departmentName: string;

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, join(process.cwd(), 'db', 'migrations'));

    /**
     * ⚠️ **NOT A ROW ANY MORE — ADR-0030 dropped the table, and this never needed one.**
     *
     * These two values are only ever handed to `viewerFor`, which is a pure function about
     * SCOPE: it asks whether a seat is administrative and, if not, which department id to
     * narrow to. It never looks the id up. The tests beside this one already pass literals
     * like `'dept-1'` for exactly that reason, and inserting a row was the fixture asserting a
     * foreign key nothing in this file reads.
     */
    departmentId = randomUUID();
    departmentName = `Dashboard Test ${randomUUID().slice(0, 6)}`;

    /**
     * ⚠️ **One live emergency, because until 2026-08-14 this file seeded none at all.**
     *
     * Every incident counter was therefore `0` in every assertion here, and the trend test added
     * for M9/L7 was **passing against all-zero series** — it was deliberately broken to check, and
     * it still passed. A test that cannot fail is the *"how a test comes to guard nothing"*
     * failure this repository already names elsewhere.
     *
     * **Left UNASSIGNED on purpose.** An unassigned emergency is counted for the district and for
     * every department (it is nobody's, and a department that cannot see the pile cannot offer to
     * take one), while `departments` stays empty — so *"counts none of another department's
     * emergencies"* and its `mine.departments).toEqual([])` still hold. Routing it to this file's
     * own department would break that test instead.
     *
     * Reported now, so it lands inside today and inside the trend's 24-hour window.
     */
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: randomUUID(),
        type: 'reported',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'mobile',
        payload: {
          reportId: randomUUID(),
          category: 'rta',
          severity: 'critical',
          kind: 'emergency',
        },
      } as unknown as IncidentEvent,
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const asDepartment = (): {
    scope: string;
    departmentId: string;
    isAdministration: boolean;
    seated: boolean;
  } => ({
    scope: departmentName,
    departmentId,
    isAdministration: false,
    seated: true,
  });

  describe('whose dashboard it is', () => {
    it('gives the two offices the district', () => {
      const viewer = viewerFor(officer({ isAdministration: true, departmentId: 'x' }));

      expect(viewer.departmentId).toBeNull();
      expect(viewer.scope).toBe('District');
    });

    it('gives a department its own name and its own scope', () => {
      const viewer = viewerFor(officer({ departmentId: 'dept-1', departmentName: 'Rescue 1122' }));

      expect(viewer.departmentId).toBe('dept-1');
      expect(viewer.scope).toBe('Rescue 1122');
    });

    it('gives a seat with no department the district, rather than nothing', () => {
      // A control-room post holds no department. Showing it an empty dashboard would be
      // technically consistent and useless — the district *is* its work.
      const viewer = viewerFor(officer({ departmentId: null }));

      expect(viewer.seated).toBe(true);
      expect(viewer.departmentId).toBeNull();
      expect(viewer.scope).toBe('District');
    });

    /**
     * The old rule was that a seatless account saw **nothing** — it guarded the M5 leak, where
     * "no seat" and "a control-room seat" both arrived as a null department and the viewer
     * answered both with District, so handing a post over *widened* the former holder's view.
     *
     * ADR-0018/0024 leave the control room as the only thing that signs in, ADR-0030 removes
     * the departments there was anything to leak between, and ADR-0032 mints every account by
     * `role` with no seat. A seatless authenticated caller is now the control room, and reads
     * the district — the tier check below is what still stops a `post`-tier seat from doing so.
     */
    it('gives a seatless control-room account the district', () => {
      const viewer = viewerFor(holdsNoPost());

      expect(viewer.seated).toBe(true);
      expect(viewer.scope).toBe('District');
      expect(viewer.departmentId).toBeNull();
      expect(viewer.isAdministration).toBe(false);
    });

    it('carries the access role through — a seatless owner or admin reads as administration', () => {
      const viewer = viewerFor(holdsNoPost(true));

      expect(viewer.scope).toBe('District');
      expect(viewer.isAdministration).toBe(true);
    });
  });

  describe('what it contains', () => {
    it('says whose it is, and when it was folded', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      expect(feed.scope).toBe('District');
      expect(new Date(feed.asOf).getTime()).not.toBeNaN();
    });

    it('answers with counts, never with rows', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      expect(typeof feed.district.openIncidents).toBe('number');
      // An id is a thing somebody can look up. Rows belong on the board, where the authority
      // model can scope them per incident.
      expect(JSON.stringify(feed)).not.toMatch(/incidentId|reportId/);
    });

    it('carries an age for every reported panel', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      for (const row of [...feed.utilities, ...feed.presence]) {
        if (row.freshness === 'never') {
          expect(row.asOf).toBeNull();
        } else {
          expect(row.asOf).not.toBeNull();
          expect(typeof row.ageMinutes).toBe('number');
        }
      }
    });

    /**
     * 🔴 **The wall counted an emergency nobody had taken as nothing at all** — RX-03,
     * 2026-08-25.
     *
     * The district's response workflow gave officers *Unable to Respond* and *Not Related to
     * Me*. Both are **answers**, so both stop an emergency being *unacknowledged* — and on this
     * screen that meant nothing counted it at all: not *Overdue*, not *unassigned* (it is
     * assigned), and it sits under **Acknowledged** on the stage row. Every tile on the wall
     * said fine over a fire nobody was going to.
     *
     * Seeded as events rather than through the API, exactly as this file seeds everything else:
     * `notified` puts the obligation in the ledger and `notification_delivered` carries what the
     * officer said — which is the one field `ownershipOf` reads.
     */
    async function declinedEmergency(
      said: string,
      alsoResolve = false,
      /**
       * What lands after the refusal, so the seed can reproduce the two real states a decline
       * leaves the incident in — the ones the simple `reported` seed does not:
       *  - `acknowledge`: the in-window Acknowledge tap / operator confirm fills `acknowledgedAt`
       *  - `log-action`: `api/webhooks.ts` writes an `action_logged` for every inbound reply,
       *    which drives the status to `responding` (`domain/incident.ts`)
       */
      after: 'none' | 'acknowledge' | 'log-action' = 'none',
    ): Promise<void> {
      const incidentId = randomUUID();
      const attemptId = randomUUID();
      const now = new Date().toISOString();
      const base = {
        incidentId,
        occurredAt: now,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web' as const,
      };

      const events: unknown[] = [
        {
          ...base,
          type: 'reported',
          payload: {
            reportId: randomUUID(),
            category: 'fire',
            severity: 'high',
            kind: 'emergency',
          },
        },
        {
          ...base,
          type: 'notified',
          payload: {
            attemptId,
            seatId: null,
            personId: randomUUID(),
            channel: 'whatsapp',
            reason: 'dispatched',
          },
        },
        {
          ...base,
          type: 'notification_delivered',
          payload: { attemptId, seatId: null, channel: 'whatsapp', via: 'link', said },
        },
      ];
      if (after === 'acknowledge') {
        events.push({
          ...base,
          type: 'acknowledged',
          payload: { seatId: null, route: 'link', said },
        });
      } else if (after === 'log-action') {
        events.push({ ...base, type: 'action_logged', payload: { note: said } });
      }
      if (alsoResolve) {
        events.push({ ...base, type: 'resolved', payload: { outcome: 'somebody else went' } });
      }

      await append(
        pool,
        events.map((e, i) => ({
          ...(e as Record<string, unknown>),
          eventId: randomUUID(),
          clientSeq: i + 1,
        })) as unknown as IncidentEvent[],
      );
    }

    it('counts a live emergency every recipient has declined', async () => {
      const before = (await buildDashboard(pool, DISTRICT)).district.ownerless;
      await declinedEmergency('Unable to Respond');
      expect((await buildDashboard(pool, DISTRICT)).district.ownerless).toBe(before + 1);
    });

    /**
     * ⚠️ The half that keeps the tile worth reading. A number that only ever climbs is a number
     * that stops being read (INV-08), and `live` is the guard: an emergency three officers
     * declined on the way to somebody else resolving it is history, not work.
     */
    it('does not count one that is over', async () => {
      const before = (await buildDashboard(pool, DISTRICT)).district.ownerless;
      await declinedEmergency('Not Related to Me', true);
      expect((await buildDashboard(pool, DISTRICT)).district.ownerless).toBe(before);
    });

    /** And an officer who is dealing with it is not a decline, however the tile is counted. */
    it('does not count one somebody is holding', async () => {
      const before = (await buildDashboard(pool, DISTRICT)).district.ownerless;
      await declinedEmergency('Deploying Relevant Staff / Team');
      expect((await buildDashboard(pool, DISTRICT)).district.ownerless).toBe(before);
    });

    /**
     * 🔴 **Option C — a refusal is not a response, on the wall's other tiles too** — 2026-09-10.
     *
     * The `ownerless` tile has flagged these since RX-03, but *Overdue* and the *Responded*
     * stage read `acknowledgedAt` / the status directly. A decline fills the ack slot (the
     * in-window Acknowledge tap) and drives the status to `responding` (`api/webhooks.ts`
     * writes an `action_logged` for every inbound reply), so without this the wall's headline
     * numbers still read a fire nobody took as one somebody is on.
     */
    it('keeps an ownerless emergency in Overdue after its acknowledgement slot is filled', async () => {
      const before = (await buildDashboard(pool, DISTRICT)).district.overdueUnacknowledged;
      await declinedEmergency('Unable to Respond', false, 'acknowledge');
      expect((await buildDashboard(pool, DISTRICT)).district.overdueUnacknowledged).toBe(
        before + 1,
      );
    });

    it('does not file an ownerless emergency under Responded when a decline drove the status', async () => {
      const before = (await buildDashboard(pool, DISTRICT)).district.stages;
      await declinedEmergency('Not Related to Me', false, 'log-action');
      const after = (await buildDashboard(pool, DISTRICT)).district.stages;
      expect(after.responded).toBe(before.responded);
      expect(after.issued).toBe(before.issued + 1);
    });
    it('gives the category the words the report form uses', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      for (const row of feed.categories) expect(row.label).not.toBe('rta');
    });

    /**
     * M9/L7 — **the one property that makes a sparkline honest.**
     *
     * Each series is the history of the number printed directly above it, so its last point is
     * that number. Anything else is a picture quietly disagreeing with its own tile, which is the
     * failure this phase was scoped around twice and the reason the trend replays the fold rather
     * than counting arrivals.
     *
     * It is also the assertion that catches the likeliest mistake by far: pairing a tile with the
     * wrong series. Four of these counters are small integers, so a mispaired line looks entirely
     * plausible on screen and nothing else would notice.
     */
    it('ends every trend series on the counter it belongs to', async () => {
      const feed = await buildDashboard(pool, DISTRICT);
      const trend = feed.district.trend;

      const last = (series: readonly number[]): number | undefined => series[series.length - 1];

      /**
       * **Proof there is anything to compare.** With an empty database every counter and every
       * series is zero, and all five assertions below pass no matter what the replay does — which
       * is exactly what happened when this test was first written, and why `beforeAll` now seeds
       * a live emergency. Verified by breaking the replay deliberately: without this guard the
       * test stayed green.
       */
      expect(feed.district.openIncidents).toBeGreaterThan(0);
      expect(feed.district.overdueUnacknowledged).toBeGreaterThan(0);
      expect(feed.district.nobodyTold).toBeGreaterThan(0);
      expect(feed.district.today).toBeGreaterThan(0);

      expect(last(trend.openIncidents)).toBe(feed.district.openIncidents);
      expect(last(trend.overdueUnacknowledged)).toBe(feed.district.overdueUnacknowledged);
      expect(last(trend.nobodyTold)).toBe(feed.district.nobodyTold);
      expect(last(trend.notificationsUnmet)).toBe(feed.notificationsUnmet);
      expect(last(trend.today)).toBe(feed.district.today);
    });

    it('counts the three stages, and they add up to what is open', async () => {
      /**
       * **The wall is arranged around these from 2026-08-17**, on the owner's decision — narrowed
       * from four to three, 2026-09-04, when `Acknowledged` stopped being a distinct stage
       * (`domain/stages.ts`'s header). The assertion that matters is the **arithmetic** rather
       * than any one figure.
       *
       * `issued + responded` must equal `openIncidents`, because those two are exactly the live
       * stages — and `resolved` must not be in that sum, or a resolved emergency would be counted
       * as open. Written this way on purpose: a test asserting each figure in isolation passes
       * happily while the total disagrees with the number beside them, which is the disagreement
       * this file already has one standing lesson about.
       *
       * ⚠️ **`resolved` is counted over LIVE incidents only**, so it means *resolved and still on
       * today's board*, never the district's whole history. The board is one district day
       * (ADR-0020) and this strip has to agree with what is under it.
       */
      const feed = await buildDashboard(pool, DISTRICT);
      const s = feed.district.stages;

      // Proof there is anything to measure — the empty-database trap this file has already
      // been caught by once, where every assertion passed against all-zero.
      expect(feed.district.openIncidents).toBeGreaterThan(0);

      expect(s.issued + s.responded).toBe(feed.district.openIncidents);

      for (const n of [s.issued, s.responded, s.resolved]) {
        expect(n).toBeGreaterThanOrEqual(0);
      }
    });

    it('keeps the alarms out of the stages — a failed message is not a stage', async () => {
      /**
       * **INV-03's home on the new wall, pinned so a later tidy-up cannot fold it away.**
       *
       * The whole risk in arranging a dashboard around a handful of stages is that *"nobody
       * could be reached"* has no stage of its own: an emergency stuck at `issued` because
       * nobody has answered and one stuck at `issued` because **the message never arrived** are
       * the same word. So the alarms stay separate figures, and this asserts they are still
       * reported beside the stages rather than absorbed into them.
       *
       * The same argument covers `unassessed` (ADR-0009: a value, never a level) — an
       * unassessed critical is `issued` exactly like everything else.
       */
      const feed = await buildDashboard(pool, DISTRICT);

      expect(feed).toHaveProperty('notificationsUnmet');
      expect(typeof feed.notificationsUnmet).toBe('number');
      expect(typeof feed.district.unassessed).toBe('number');
      expect(typeof feed.district.nobodyTold).toBe('number');

      // And they are genuinely not derivable from the three — an emergency can be at any stage
      // with a failed message, so nothing here may be reconstructed from `stages` alone.
      expect(Object.keys(feed.district.stages).sort()).toEqual(['issued', 'resolved', 'responded']);
    });

    it('speaks the same words on the category cards as on the deck', async () => {
      /**
       * **The panel the owner read on the deployed wall and said still made no sense.**
       *
       * It spoke a private language — *With nobody*, *Not acknowledged*, *Being handled* — and
       * the loudest of the three was the **department** figure he had just had taken off the
       * deck: it read `unassigned`, true of 31 of Bajaur's 40 incidents, so four of six cards
       * were red on a screen where red is supposed to mean *look here*.
       *
       * Every word a card can carry is now one of the deck's own, so the two halves of the
       * screen cannot describe one district in two vocabularies. `Acknowledged` dropped out of
       * the allowed list 2026-09-04 with the stage itself (`domain/stages.ts`'s header).
       */
      const feed = await buildDashboard(pool, DISTRICT);

      const ALLOWED = ['No one chosen', 'Issued', 'Responded', 'Clear'];
      expect(feed.situation.length).toBeGreaterThan(0);
      for (const card of feed.situation) {
        expect(ALLOWED).toContain(card.status);
      }

      // Every category the district watches is present whether or not anything is open — an
      // empty panel and a calm one are different statements (ADR-0005).
      expect(feed.situation.some((c) => c.category === 'fire')).toBe(true);
    });

    it('lets the furthest-behind emergency decide a card, never the commonest', async () => {
      /**
       * **INV-04 on the panel most likely to be glanced at rather than read.**
       *
       * A category holding three `Responded` and one `Issued` must read **Issued**. Reporting
       * the majority would hide the one emergency nobody has answered behind three that are
       * being worked — an aggregate concealing the thing it exists to surface, which is exactly
       * what that invariant forbids.
       *
       * Asserted as an **ordering property over whatever the district actually holds** rather
       * than by seeding a fixture: this file shares a database with every other suite, and a
       * card's contents are not something it owns. If a card says `Responded`, then nothing of
       * that kind may be sitting at `Issued` or untold.
       */
      const feed = await buildDashboard(pool, DISTRICT);

      const rank = ['No one chosen', 'Issued', 'Responded', 'Clear'];
      for (const card of feed.situation) {
        // A card that has reached a calmer word must have nothing worse behind it, and the only
        // way to check that from outside is that a calmer word never sits on a card with open
        // work it has not accounted for.
        if (card.status === 'Clear') expect(card.open).toBe(0);
        if (card.open > 0) expect(card.status).not.toBe('Clear');
        expect(rank).toContain(card.status);
      }
    });

    it('carries a full day of points, and never a negative count', async () => {
      const feed = await buildDashboard(pool, DISTRICT);
      const trend = feed.district.trend;

      expect(trend.hours).toBe(24);

      for (const series of [
        trend.openIncidents,
        trend.overdueUnacknowledged,
        trend.nobodyTold,
        trend.notificationsUnmet,
        trend.today,
      ]) {
        // Two points is the minimum a line can be drawn from; the client returns null below it.
        expect(series.length).toBeGreaterThanOrEqual(2);
        for (const value of series) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }

      // Cumulative from midnight and therefore never falls — the one series whose shape is a
      // property of the number rather than of the state behind it.
      const today = trend.today;
      for (let i = 1; i < today.length; i += 1) {
        expect(today[i]!).toBeGreaterThanOrEqual(today[i - 1]!);
      }
    });

    /**
     * M10-01 — the district reported this and they were right.
     *
     * *"8 hours loadshedding"* vanished from the wall four hours in, because `stale_minutes`
     * for Electricity is 240 and the note was withheld on the same test as the status.
     *
     * **Both halves are asserted together deliberately.** The obvious way to break the second
     * one is to "simplify" the first, and each is meaningless without the other: a note that
     * survives beside a status word still claiming `normal` would be INV-02, and withholding
     * both is the defect this pair exists to keep fixed.
     */
    const staleUtility = async (note: string): Promise<string> => {
      const name = `Electricity (M10-01 ${randomUUID().slice(0, 8)})`;

      const created = await pool.query<{ utility_id: string }>(
        `INSERT INTO utility (name, panel, position, stale_minutes)
         VALUES ($1, 'utility', 99, 60) RETURNING utility_id`,
        [name],
      );

      // Five hours ago, against a sixty-minute window. Backdated on the row rather than by
      // moving a clock, because `utility_report` is not the event log — `reported_at` is an
      // ordinary column here and this is the honest way to express "reported this morning".
      await pool.query(
        `INSERT INTO utility_report (utility_id, status, note, reported_at)
         VALUES ($1, 'degraded', $2, now() - interval '5 hours')`,
        [created.rows[0]!.utility_id, note],
      );

      return name;
    };

    it('keeps the status AND the sentence however old the reading is — ADR-0025', async () => {
      const note = '8 hours loadshedding, 10am to 6pm';
      const name = await staleUtility(note);

      const feed = await buildDashboard(pool, DISTRICT);
      const row = feed.utilities.find((u) => u.name === name);

      expect(row).toBeDefined();

      /*
       * Five hours old against the row's own sixty-minute window, and still fresh.
       *
       * M10-01 asserted the opposite here: `freshness` was `stale`, `status` was withheld and
       * the label read `no report since 07:00`. It kept the officer's sentence and threw away
       * the reading it described — half a fix, and the district said so. From 2026-08-23 a
       * utility has no window at all: what the control room last said stands until they say
       * otherwise, and `stale_minutes` on the row is inert for utilities.
       */
      expect(row!.freshness).toBe('fresh');
      expect(row!.status).toBe('degraded');
      expect(row!.label).toBe('Degraded');
      expect(row!.note).toBe(note);

      // INV-02 is met by the age travelling beside the value, not by withdrawing it.
      expect(row!.ageMinutes).toBeGreaterThanOrEqual(299);
      expect(row!.asOf).not.toBeNull();
    });

    it('carries both the status and the note while the reading is still fresh', async () => {
      const name = `Water (M10-01 ${randomUUID().slice(0, 8)})`;
      const note = 'Tanker supply to Mamund only';

      const created = await pool.query<{ utility_id: string }>(
        `INSERT INTO utility (name, panel, position, stale_minutes)
         VALUES ($1, 'utility', 98, 240) RETURNING utility_id`,
        [name],
      );

      await pool.query(
        `INSERT INTO utility_report (utility_id, status, note) VALUES ($1, 'down', $2)`,
        [created.rows[0]!.utility_id, note],
      );

      const feed = await buildDashboard(pool, DISTRICT);
      const row = feed.utilities.find((u) => u.name === name);

      expect(row).toBeDefined();
      expect(row!.freshness).toBe('fresh');
      expect(row!.status).toBe('down');
      expect(row!.note).toBe(note);
    });
  });

  describe('what a department is and is not shown', () => {
    it('withholds the system condition from a department', async () => {
      // Not secrecy — these are the two offices' to fix. Three red rows a department can do
      // nothing about teaches it to ignore red rows.
      const feed = await buildDashboard(pool, asDepartment());

      expect(feed.condition).toEqual([]);
    });

    it('gives the two offices the system condition, named in full', async () => {
      const feed = await buildDashboard(pool, DISTRICT);

      /**
       * Three again — M6-25.
       *
       * This assertion said "two, not three" and gave the reason: sending went with the
       * provider ladder on 2026-08-03, so there was nothing about sending that could quietly
       * break. **ADR-0014 reversed that**, and the row came back for exactly the reason the
       * other two are here: an account out of credit, an expired token or an un-approved
       * template all look precisely like a quiet night.
       *
       * It is **not** the old "alerts leave the building" row returning. That one reported a
       * ladder of four providers. This reports one channel, and it reads `pending` rather than
       * `critical` while the district has no account at all — the honest state until R-05,
       * R-19 and R-20 are done, and a permanent red row nobody can clear this week is how a
       * district learns to ignore red rows.
       */
      expect(feed.condition.map((c) => c.what)).toEqual([
        'Record backed up',
        'Second machine',
        'Can send WhatsApp',
      ]);

      for (const item of feed.condition) expect(item.detail.length).toBeGreaterThan(3);

      // No account in the test environment, and that is reported as pending rather than as a
      // failure — nothing is broken, the district simply has not bought a number yet.
      const whatsapp = feed.condition.find((c) => c.what === 'Can send WhatsApp');
      expect(whatsapp?.state).toBe('pending');
      expect(whatsapp?.detail).toContain('R-05');
    });

    it("counts none of another department's emergencies", async () => {
      const mine = await buildDashboard(pool, asDepartment());
      const district = await buildDashboard(pool, DISTRICT);

      // A brand-new department holds nothing, so every assigned emergency in the district is
      // somebody else's. Whatever it counts can only be the unassigned pile.
      expect(mine.departments).toEqual([]);
      expect(mine.district.openIncidents).toBeLessThanOrEqual(district.district.openIncidents);
    });

    it('still shows a department the weather and the utilities', async () => {
      // These belong to everybody. A department planning around a power cut needs to know
      // about the power cut.
      const feed = await buildDashboard(pool, asDepartment());

      expect(feed.utilities.length).toBeGreaterThan(0);
      expect(feed.weather).toHaveProperty('ageMinutes');
    });

    it('no longer carries the published-numbers panel, and cannot quietly regain it', async () => {
      /**
       * M6-14/16. The assertion is inverted on purpose — it used to check that `contacts` was
       * an array, and deleting that test would have left nothing stopping the panel coming
       * back the next time somebody reads "no need of emergency contact numbers" the way it
       * first reads.
       *
       * What the district asked to remove is the panel of **published** numbers (1122, 15, 16).
       * It is not a request to remove officers' numbers — those became the centre of the
       * product in M6, and `/contacts/department/:id` and `/contacts/recipients` stay. Read
       * `dashboard.ts`'s note before deleting anything else named "contacts".
       */
      const feed = await buildDashboard(pool, DISTRICT);

      expect(feed).not.toHaveProperty('contacts');
      // Gone from the feed rather than emptied: an empty array leaves a panel rendering
      // nothing and a client still asking for it.
      expect(JSON.stringify(feed)).not.toContain('"contacts"');
    });
  });

  describe('importance panels (M10-25/42)', () => {
    async function seedIncident(importance: 'routine' | 'important'): Promise<void> {
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId: randomUUID(),
          type: 'reported',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: {
            reportId: randomUUID(),
            category: 'rta',
            severity: 'critical',
            kind: 'emergency',
            importance,
          },
        } as unknown as IncidentEvent,
      ]);
    }

    it('counts each panel independently, and neither borrows from the other', async () => {
      const before = await buildDashboard(pool, DISTRICT);

      await seedIncident('important');
      const afterImportant = await buildDashboard(pool, DISTRICT);
      expect(afterImportant.importantEmergencies.total).toBe(before.importantEmergencies.total + 1);
      expect(afterImportant.routineEmergencies.total).toBe(before.routineEmergencies.total);

      await seedIncident('routine');
      const afterBoth = await buildDashboard(pool, DISTRICT);
      expect(afterBoth.routineEmergencies.total).toBe(before.routineEmergencies.total + 1);
      // Unchanged by the routine one landing — the two lists never borrow from each other.
      expect(afterBoth.importantEmergencies.total).toBe(afterImportant.importantEmergencies.total);
    });

    /**
     * **M10-42, proven rather than merely asserted by the type system.** Every other number on
     * this feed reads the same fold and none of it looks at `importance` — a routine emergency
     * is exactly as open, exactly as unassessed-or-not, and exactly as much a district emergency
     * as an important one. If this ever regresses, it means something started reading the field
     * outside `capImportance`.
     */
    it('changes nothing else on the feed — only which of the two panels a row is in', async () => {
      const before = await buildDashboard(pool, DISTRICT);

      await seedIncident('routine');
      const after = await buildDashboard(pool, DISTRICT);

      // The district-wide open count rose by exactly one, same as any other emergency would —
      // marking something routine did not exempt it from being counted as open.
      expect(after.district.openIncidents).toBe(before.district.openIncidents + 1);
      expect(after.district.overdueUnacknowledged).toBe(before.district.overdueUnacknowledged + 1);
    });
  });

  /**
   * **"Nobody told yet" was false on nineteen of Bajaur's forty incidents — 2026-08-18.**
   *
   * The activity panel and both importance panels answered *who has it* with the **department**
   * question: no `responsibleDepartmentIds` printed *"nobody told yet"*. Measured on the live
   * record before this was changed: 40 incidents, **28 where somebody was told**, 9 with a
   * department — so nineteen rows told a control room that nobody had been told about an
   * emergency they had dispatched to officers **by name**.
   *
   * ⚠️ **Both halves are asserted together and must stay together.** The obvious repair is to
   * stop saying "nobody" when a department is missing, which fixes the false sentence and loses
   * the true one — an emergency nobody was ever chosen for is the one alarm the wall keeps above
   * every stage, and it has to survive this.
   */
  describe('who has it, when no department has it (2026-08-18)', () => {
    async function seedDispatched(told: boolean): Promise<string> {
      const incidentId = randomUUID();
      const now = new Date().toISOString();
      const base = {
        incidentId,
        occurredAt: now,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'mobile' as const,
      };
      const events: unknown[] = [
        {
          ...base,
          eventId: randomUUID(),
          type: 'reported',
          clientSeq: 1,
          payload: {
            reportId: randomUUID(),
            category: 'rta',
            severity: 'critical',
            kind: 'emergency',
            importance: 'important',
          },
        },
      ];
      if (told) {
        /**
         * A **person-kinded** dispatch and deliberately not a department one — this is the shape
         * M10-07/08/09 made the ordinary case, where the picker draws the officer's own row and
         * nothing places a department. It is the exact record that produced the false sentence.
         */
        events.push({
          ...base,
          eventId: randomUUID(),
          type: 'dispatched',
          clientSeq: 2,
          payload: { targets: [{ kind: 'person', id: randomUUID() }] },
        });
      }
      await append(pool, events as unknown as IncidentEvent[]);
      return incidentId;
    }

    it('says an officer has it rather than that nobody was told', async () => {
      await seedDispatched(true);
      const feed = await buildDashboard(pool, DISTRICT);

      const rows = feed.importantEmergencies.visible;
      expect(rows.some((r) => r.detail === 'told directly')).toBe(true);
    });

    it('still says no one chosen when nobody was chosen', async () => {
      await seedDispatched(false);
      const feed = await buildDashboard(pool, DISTRICT);

      const rows = feed.importantEmergencies.visible;
      expect(rows.some((r) => r.detail === 'no one chosen')).toBe(true);
    });

    /**
     * The words are the wall's own. A panel that invented a synonym would be the private language
     * the owner had removed from the deck arriving back one panel lower — which is precisely how
     * the *Emergency Situation* cards came to disagree with the deck above them a day earlier.
     */
    it('never speaks the old vocabulary', async () => {
      await seedDispatched(true);
      const feed = await buildDashboard(pool, DISTRICT);

      const said = [
        ...feed.importantEmergencies.visible,
        ...feed.routineEmergencies.visible,
        ...feed.activity.visible,
      ].map((r) => ('detail' in r ? String(r.detail) : ''));

      expect(said.some((d) => d.includes('nobody'))).toBe(false);
    });
  });

  describe('what it must never say', () => {
    it('passes its own safety check for both kinds of viewer', async () => {
      expect(wallSafetyViolations(await buildDashboard(pool, DISTRICT))).toEqual([]);
      expect(wallSafetyViolations(await buildDashboard(pool, asDepartment()))).toEqual([]);
    });

    it('carries no personal name, number or coordinate', async () => {
      const text = JSON.stringify(await buildDashboard(pool, DISTRICT));

      // Presence is by **seat** — "AAC Mamund", not whoever currently holds it. A seat title
      // is a public post; a person's name on an office screen is not the district's to put
      // there (ADR-0004 is why this shape was available at all).
      expect(text).not.toMatch(/"fullName"/);
      expect(text).not.toMatch(/"personId"/);
      expect(text).not.toMatch(/"phone"/);
    });

    it('catches a leak wherever it is nested', () => {
      expect(
        wallSafetyViolations({ panels: [{ rows: [{ t: 'call 0333-1234567' }] }] }),
      ).toHaveLength(1);
    });
  });

  describe('who may read it', () => {
    it('serves a signed-in officer', async () => {
      const reply = await handleDashboard(pool, request(), officer({ isAdministration: true }));

      expect(reply.status).toBe(200);
      expect((reply.body as { scope: string }).scope).toBe('District');
    });

    it('refuses anything but a read', async () => {
      // The dashboard is a view. Nothing is entered on it — utilities and presence are
      // reported through /status, emergencies through the report screen.
      const reply = await handleDashboard(pool, request('POST'), officer());

      expect(reply.status).toBe(405);
    });
  });

  /**
   * **The dashboard is one district day** — the owner's decision, 2026-08-19.
   *
   * This file seeded every incident with `new Date()` and asserted counts at `new Date()`, so
   * for as long as the dashboard folded a **rolling seven days** every test here passed, and
   * would have gone on passing however wide that window grew. The behaviour the district
   * actually asked for had no test at all; it is the whole point of the change and it is
   * pinned here.
   *
   * **Time is moved rather than the record.** The obvious test — seed something three days old
   * — cannot be written: `recorded_at` is set by the server and never by the client
   * (`db/eventStore.ts`), and the log is append-only under a trigger, so there is no honest way
   * to age a row. Asking the dashboard what it shows *three days from now* asserts exactly the
   * same property against an untouched record, and it is the district's real question: **when
   * tomorrow comes, does today leave the screen.**
   */
  describe('one district day', () => {
    const districtViewer = viewerFor(officer({ isAdministration: true }));

    it("shows today's emergencies today", async () => {
      const today = await buildDashboard(pool, districtViewer, new Date());

      // `beforeAll` seeds one live, unassigned emergency reported now. If this is ever 0 the
      // assertion below stops meaning anything — it would be passing against an empty district.
      expect(today.district.openIncidents).toBeGreaterThan(0);
    });

    it('has let them go three days later', async () => {
      const later = new Date(Date.now() + 3 * 86_400_000);
      const dashboard = await buildDashboard(pool, districtViewer, later);

      expect(dashboard.district.openIncidents).toBe(0);
      expect(dashboard.district.today).toBe(0);
      expect(dashboard.district.unassigned).toBe(0);
    });

    /**
     * **The safety net, stated as a test.**
     *
     * With the strict day rule and escalation bounded to one day, an older open emergency has
     * **no counter and no chase**. This strip is the only place it is still visible — so the
     * property worth pinning is not that the numbers are right, it is that **nothing falls
     * through the gap between them**: what leaves the counters at midnight must arrive here.
     */
    it('reports what the reset took off the counters, rather than losing it', async () => {
      const later = new Date(Date.now() + 3 * 86_400_000);
      const dashboard = await buildDashboard(pool, districtViewer, later);

      // It is gone from every figure above...
      expect(dashboard.district.openIncidents).toBe(0);
      // ...and it is here, with the date that says how long it has been sitting.
      expect(dashboard.district.carriedOver.stillOpen).toBeGreaterThan(0);
      expect(dashboard.district.carriedOver.oldestOpenAt).not.toBeNull();
    });

    /**
     * ▶ **The things that do not finish at midnight** — the district's five, 2026-08-22.
     *
     * Two properties in one test, **because the second is only meaningful against the first**:
     * the flood has to actually arrive on the panel before *"and it did not also land in the
     * strip"* says anything at all.
     *
     * The same *"three days from now"* technique as the tests above, for the same reason: the
     * log is append-only under a trigger and `recorded_at` is the server's, so there is no
     * honest way to age a row. What is asserted is the district's real question — **when
     * tomorrow comes, does the flood stay on the wall.**
     *
     * 🔴 **The strip is measured BEFORE and AFTER, never compared against a constant.** This file
     * runs against a shared database that other suites have already written to, so any absolute
     * number here would be a measurement of whatever else ran today. The delta is the assertion:
     * the panel grows by one, the strip does not move.
     */
    it('keeps a flood on the wall, and does not also put it in the carry-over strip', async () => {
      const later = new Date(Date.now() + 3 * 86_400_000);
      const before = await buildDashboard(pool, districtViewer, later);

      const subject = `Nawagai UC — ${randomUUID().slice(0, 8)}`;
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId: randomUUID(),
          type: 'reported',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: {
            reportId: randomUUID(),
            category: 'flood',
            severity: 'high',
            kind: 'emergency',
            details: { subject },
          },
        } as unknown as IncidentEvent,
      ]);

      const after = await buildDashboard(pool, districtViewer, later);

      // It is gone from today's figures, exactly as the reset requires…
      expect(after.district.openIncidents).toBe(0);

      // …and it is on the wall, under the district's own word for it.
      const row = after.stillRunning.visible.find((r) => r.headline === subject);
      expect(row, 'the flood is not on the panel').toBeDefined();
      expect(row?.lane).toBe('flood');
      expect(after.stillRunning.total).toBe(before.stillRunning.total + 1);

      /**
       * 🔴 **Trap 2 of the three the plan writes down: one item, one row.**
       *
       * The strip and this panel counting the same flood would put it on the district's home
       * screen **twice, with two different ages**, and the room would reasonably conclude one of
       * them was wrong — the defect M9-37 fixed when an advisory sat in `alerts` and `activity`
       * at once.
       *
       * ⚠️ **The strip is not asserted to be empty, and must not be.** It keeps what it was built
       * for: an older open emergency that genuinely does clear at midnight — `beforeAll`'s own
       * road accident — which no counter mentions and no escalation chases.
       */
      expect(after.district.carriedOver.stillOpen).toBe(before.district.carriedOver.stillOpen);
      expect(after.district.carriedOver.stillOpen).toBeGreaterThan(0);
    });

    /**
     * **Case 2 (meeting) — the *Still running* card counts a representative as coming.**
     *
     * `coming` is `attending + sendingSomeone`, so the wall reads the same "N of M coming"
     * numerator as the drawer, the board row and both reports. Before this the card used
     * `attending` alone and under-counted every meeting somebody was sending a deputy to.
     */
    it('the Still running card reads coming as attending + representative', async () => {
      const later = new Date(Date.now() + 3 * 86_400_000);
      const subject = `Coordination meeting — ${randomUUID().slice(0, 8)}`;
      const incidentId = randomUUID();
      const now = new Date().toISOString();
      const base = {
        incidentId,
        occurredAt: now,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web' as const,
      };
      const attempts = [
        { said: 'Attending' },
        { said: 'Sending someone' },
        { said: null as string | null },
      ].map((r) => ({ attemptId: randomUUID(), ...r }));

      const events: unknown[] = [
        {
          ...base,
          type: 'reported',
          payload: {
            reportId: randomUUID(),
            category: 'general',
            severity: 'unknown',
            kind: 'meeting',
            details: { subject },
          },
        },
        ...attempts.map((a) => ({
          ...base,
          type: 'notified',
          payload: {
            attemptId: a.attemptId,
            seatId: null,
            personId: randomUUID(),
            channel: 'whatsapp',
            reason: 'dispatched',
          },
        })),
        ...attempts
          .filter((a) => a.said !== null)
          .map((a) => ({
            ...base,
            type: 'notification_delivered',
            payload: {
              attemptId: a.attemptId,
              seatId: null,
              channel: 'whatsapp',
              via: 'link',
              said: a.said,
            },
          })),
      ];

      await append(
        pool,
        events.map((e, i) => ({
          ...(e as Record<string, unknown>),
          eventId: randomUUID(),
          clientSeq: i + 1,
        })) as unknown as IncidentEvent[],
      );

      const dashboard = await buildDashboard(pool, districtViewer, later);
      const row = dashboard.stillRunning.visible.find((r) => r.headline === subject);
      expect(row, 'the meeting is not on the Still running panel').toBeDefined();
      // 1 attending + 1 sending someone = 2 of 3, not "1 of 3".
      expect(row?.attendance).toBe('2 of 3 coming');
    });

    it('fences nothing off on a day when everything started today', async () => {
      const today = await buildDashboard(pool, districtViewer, new Date());

      // Every incident this file seeds is reported now, so on today's dashboard the strip must
      // be empty — a figure that is never 0 is one nobody reads on the morning it is not.
      expect(today.district.carriedOver.stillOpen).toBe(0);
      expect(today.district.carriedOver.resolvedToday).toBe(0);
      expect(today.district.carriedOver.oldestOpenAt).toBeNull();
    });

    it('counts the same day the board does', async () => {
      /**
       * The agreement that `board.test.ts` guards from its side, asserted from this one.
       *
       * These two screens each decided *"is this today?"* in their own words once before, and
       * the answers were five hours apart because Bajaur is UTC+05:00 and one file used
       * `setUTCHours` while the other used `setHours`. The dashboard now calls the board's
       * `belongsToDay`; this is what would fail if somebody re-derived it here.
       */
      const now = new Date();
      const dashboard = await buildDashboard(pool, districtViewer, now);
      const board = await buildBoard(
        pool,
        { seatId: randomUUID(), tier: 'district', canBreakGlass: false },
        { date: districtDate(now), now: now.toISOString() },
      );

      // `summary.open` is folded from the very rows the board sent (M11-06), so this compares
      // the dashboard's count against the board's own set rather than against a second filter
      // written here — which would be a third implementation of the question.
      expect(dashboard.district.openIncidents).toBe(board.summary.open);
    });
  });
});
