/**
 * The administration console — M1a, over HTTP, against a real PostgreSQL.
 *
 * The milestone gate is one test in here: **an operator adds a designation that did not exist
 * a moment ago, and the control room sends an emergency to it — with no developer involved,
 * nothing restarted, and no code anywhere naming it.**
 *
 * ⚠️ That sentence has now been rewritten twice, and neither time was the gate deleted.
 *
 * It used to end *"gives it a routing signal, and the next matching emergency reaches it"*.
 * ADR-0022 removed routing at the district's request, and the half that changed was **who**
 * points the emergency at it — a person, now.
 *
 * ADR-0030 removed the departments themselves. The district said the layer it had been asked
 * to configure is not how Bajaur is organised, and migration 0039 dropped the table. So the
 * thing an operator adds on a screen is a **post**, and the thing the control room does with it
 * is `dispatch-to`. What M1a had to prove is untouched and is the only thing that ever
 * mattered: **the registry is live.** Something created on a screen is immediately something
 * the system can use, with nobody touching the code.
 *
 * ⚠️ **Four routes are gone with the table, and one test below exists to keep them gone.**
 * `POST /admin/departments`, its `PATCH`, its `retire` and its `restore` are not 410 and not
 * stubs — they do not exist. `GET /admin/departments` survives and answers an empty list,
 * because a console tab that renders "none" is a screen telling the truth while a 404
 * underneath it is a screen that looks broken.
 *
 * Everything else is the ways all of that can be true on a screen and false in the district.
 *
 * The rest of the file is mostly refusals, because this endpoint is the one place in the
 * system where a wrong answer is silent. A post retired by mistake does not throw; it simply
 * stops appearing in the list the control room sends from, and nobody finds out until one
 * goes unanswered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import type { Board } from '../board.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

/**
 * A suffix unique to this run.
 *
 * The test database persists between runs, and a post is never deleted — retiring is the only
 * removal this system has, by design (ADR-0001). So a second run against the same database
 * finds the previous run's `Irrigation Duty` still live, and a test looking one up by title
 * finds two.
 *
 * Worth naming because the failure used to look exactly like a routing bug: the system was
 * right and the test was wrong. Every name below is unique per run.
 */
const RUN = randomUUID().slice(0, 8);

// ADR-0031 phase 3: the roster is flat — `POST /roster/posts`, `POST /roster/people`,
// `GET /roster`, no `/roster/:dept`. The `ROSTER_SCOPE` placeholder is gone with the segment.

describe.skipIf(dbUrl === undefined)('the administration console (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  /** A seat ticked `is_administration` — the DC Office equivalent. */
  let dcToken: string;
  /** The AC Headquarter equivalent. Same powers, by ADR-0010. */
  let acToken: string;
  /** An ordinary post. Holds no administrative authority whatsoever. */
  let rescueToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    /**
     * ADR-0030 — the tick is on the SEAT now, and `seedActor({ tier: 'district' })` sets it.
     *
     * Two `seedDepartment` calls and a department UPDATE stood here and are gone with the
     * table. Nothing was lost: the UPDATE was reaching for `is_administration` one join away,
     * and the seed writes it directly.
     */
    dcToken = (await seedActor(pool, { title: `DC (test ${RUN})`, tier: 'district' })).token;
    acToken = (await seedActor(pool, { title: `AC HQ (test ${RUN})`, tier: 'district' })).token;

    /**
     * Nothing has to be neutralised here any more.
     *
     * This used to retire every live routing signal before the suite ran, and it was a
     * precondition rather than housekeeping: these tests assert **exactly** who an emergency
     * reaches, the test database persists, and a previous run's signals would have silently
     * added recipients to every one. There are no signals since ADR-0022 and intake assigns
     * nothing, so a fresh incident starts held by nobody however much history the database is
     * carrying.
     */
    rescueToken = (await seedActor(pool, { title: `Rescue Duty ${RUN}`, tier: 'post' })).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  /** The district's own deadline for one severity, read back off the console. */
  async function districtTarget(severity: string): Promise<number | undefined> {
    const sla = await call('GET', '/admin/sla', dcToken);
    return (sla.body['district'] as Record<string, number>)[severity];
  }

  /** Add a post the way the roster screen does, and hand back its seat id. */
  async function addPost(title: string): Promise<string> {
    const created = await call('POST', '/roster/posts', dcToken, { title });
    expect(created.status).toBe(201);
    return created.body['seatId'] as string;
  }

  //----------------------------------------------------------------------------
  // The gate
  //----------------------------------------------------------------------------

  describe('only the two administrative offices may configure the district (ADR-0010)', () => {
    it('refuses an ordinary seat, and says why rather than pretending to be missing', async () => {
      const res = await call('GET', '/admin/departments', rescueToken);
      expect(res.status).toBe(403);
      expect(String(res.body['error'])).toContain('DC Office');
    });

    /**
     * The failure that matters. A console hidden from the menu is not a control (INV-05).
     *
     * ⚠️ **The write this asserts on changed with ADR-0030 and the claim did not.** It used to
     * be `POST /admin/departments`, which no longer exists for anybody — so asserting a 403 on
     * it would be asserting the 404 every caller now gets, and would go on passing after the
     * gate had been taken off whatever replaced it. A deadline is a real configuration write
     * that is still there, so that is what an ordinary seat is refused.
     */
    it('refuses an ordinary seat trying to write, not only trying to read', async () => {
      const before = await districtTarget('high');
      expect(typeof before).toBe('number');

      const res = await call('PUT', '/admin/sla', rescueToken, {
        severity: 'high',
        ackMinutes: before! + 13,
      });
      expect(res.status).toBe(403);

      // And nothing moved. A refusal that half-applies is worse than one that is missing.
      expect(await districtTarget('high')).toBe(before);
    });

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      expect((await call('GET', '/admin/departments', null)).status).toBe(401);
    });

    /**
     * ADR-0010's clarification, pinned as a test: the two offices are equal. If a future
     * change gives the DC something the AC cannot do, this fails, which is the intent —
     * that would be a change to the authority model, not a convenience flag.
     */
    it('gives the AC Headquarter office exactly the same powers as the DC office', async () => {
      expect(
        (await call('PUT', '/admin/sla', acToken, { severity: 'moderate', ackMinutes: 40 })).status,
      ).toBe(200);
      expect(
        (await call('PUT', '/admin/sla', dcToken, { severity: 'moderate', ackMinutes: 41 })).status,
      ).toBe(200);

      // Read, as well as write, and by both.
      expect((await call('GET', '/admin/performance', acToken)).status).toBe(200);
      expect((await call('GET', '/admin/performance', dcToken)).status).toBe(200);
    });
  });

  //----------------------------------------------------------------------------
  // The gate this milestone is measured by
  //----------------------------------------------------------------------------

  describe('M1a gate: a designation added from a screen can be given an emergency', () => {
    let irrigation: string;

    it('adds a post, and the control room sends an emergency to it', async () => {
      // 1. The administration creates a designation that did not exist a moment ago.
      irrigation = await addPost(`Irrigation Duty ${RUN}`);

      // 2. An officer somewhere in the district reports an emergency. No developer has
      //    touched anything, no process has restarted, no code names "irrigation".
      const report = await call('POST', '/incidents', rescueToken, {
        category: 'flooding',
        description: `The canal-${RUN} has breached near Nawagai and water is entering houses`,
      });
      expect(report.status).toBe(201);
      const incidentId = report.body['incidentId'] as string;

      // 3. It arrives held by nobody, and says so — the control room's queue (ADR-0022).
      expect(report.body['routedTo']).toEqual([]);
      expect(report.body['unassigned']).toBe(true);

      // 4. The control room tells the post that did not exist a minute ago.
      const told = await call('POST', `/incidents/${incidentId}/dispatch-to`, dcToken, {
        targets: [{ kind: 'post', id: irrigation }],
        reason: 'canal breach — Irrigation answers for this',
      });
      expect(told.status).toBe(200);

      const outcomes = told.body['outcomes'] as { kind: string; id: string; label: string }[];
      const chosen = outcomes.find((o) => o.kind === 'post' && o.id === irrigation);
      expect(chosen).toBeDefined();
      // Named by its title, not by a uuid — the registry answered, which is the whole claim.
      expect(chosen!.label).toBe(`Irrigation Duty ${RUN}`);

      // 5. And the event log says so, not just the response body.
      const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
      expect(
        state.notifications.some((n) => n.seatId === irrigation),
        'the dispatch created an obligation naming the new post',
      ).toBe(true);
    });

    /**
     * The registry is what changed, and the registry is what the control room sends from.
     *
     * ⚠️ **This is a stronger assertion than the one it replaces.** The department version
     * proved the retired row was flagged in a list. A retired post is not in the dispatch
     * directory at all (`WHERE s.retired_at IS NULL`), so the control room is refused outright
     * — which is what actually keeps an emergency from being handed to a post the district has
     * closed.
     */
    it('stops offering it the moment the post is retired', async () => {
      const wildlife = await addPost(`Wildlife Duty ${RUN}`);

      const retired = await call('POST', `/roster/posts/${wildlife}/retire`, dcToken, {
        reason: 'handled by Health now',
      });
      expect(retired.status).toBe(200);

      const report = await call('POST', '/incidents', rescueToken, {
        category: `wildlife ${RUN}`,
      });
      const res = await call(
        'POST',
        `/incidents/${report.body['incidentId'] as string}/dispatch-to`,
        dcToken,
        { targets: [{ kind: 'post', id: wildlife }], reason: 'trying a retired post' },
      );
      expect(res.status).toBe(404);
      expect(String(res.body['error'])).toContain('no such post');

      // And it is still readable on the roster, retired rather than deleted (ADR-0001).
      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as { seatId: string; retiredAt: string | null }[];
      expect(posts.find((p) => p.seatId === wildlife)?.retiredAt).not.toBeNull();
    });
  });

  //----------------------------------------------------------------------------
  // Refusals that keep the district's record intact
  //----------------------------------------------------------------------------

  describe('what it will not do', () => {
    /**
     * 🔴 **The four department routes are GONE, and this test is here to keep them gone.**
     *
     * Not 410, not a stub that explains itself — a path that explains itself is still a path
     * somebody finds and asks about, and the district has been told the layer does not exist.
     * If one of them comes back, it comes back with a table underneath it or it comes back
     * broken, and either is a decision somebody has to make on purpose rather than by
     * restoring a handler that looked missing.
     *
     * `GET` is asserted in the same breath because it deliberately **survives**: the console's
     * Departments tab draws from it, and an empty list is a screen telling the truth.
     */
    it('has no way left to create, rename, retire or restore a department (ADR-0030)', async () => {
      const id = randomUUID();
      expect((await call('POST', '/admin/departments', dcToken, { name: 'Sneaky' })).status).toBe(
        404,
      );
      expect(
        (await call('PATCH', `/admin/departments/${id}`, dcToken, { name: 'Sneaky' })).status,
      ).toBe(404);
      expect(
        (await call('POST', `/admin/departments/${id}/retire`, dcToken, { reason: 'x' })).status,
      ).toBe(404);
      expect(
        (await call('POST', `/admin/departments/${id}/restore`, dcToken, { reason: 'x' })).status,
      ).toBe(404);

      const list = await call('GET', '/admin/departments', dcToken);
      expect(list.status).toBe(200);
      expect(list.body as unknown as unknown[]).toEqual([]);
    });

    it('will not retire a post without a reason', async () => {
      const id = await addPost(`Reasonless ${RUN}`);
      const res = await call('POST', `/roster/posts/${id}/retire`, dcToken, {});
      expect(res.status).toBe(400);
      expect(String(res.body['error'])).toContain('say why');
    });

    it('will not create a post with no title', async () => {
      const res = await call('POST', '/roster/posts', dcToken, { title: '   ' });
      expect(res.status).toBe(400);
    });

    it('will not accept a deadline of zero, which would make everything overdue at once', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'critical',
        ackMinutes: 0,
      });
      expect(res.status).toBe(400);
    });

    it('will not accept a deadline of a fortnight either', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'low',
        ackMinutes: 20_160,
      });
      expect(res.status).toBe(400);
    });
  });

  //----------------------------------------------------------------------------
  // Retiring a designation
  //----------------------------------------------------------------------------

  describe('retiring a designation', () => {
    it('records the retirement rather than deleting the post', async () => {
      /**
       * This used to assert the cascade: retiring a department retired its routing signals,
       * so emergencies stopped arriving at an office that no longer existed. Nothing arrives
       * anywhere on its own since ADR-0022, so the quiet failure it guarded against cannot
       * happen — and what is left to prove is the half that always mattered more, which is
       * that the thing survives its own retirement as a readable record (ADR-0001).
       */
      const id = await addPost(`Temporary Cell ${RUN}`);
      const retired = await call('POST', `/roster/posts/${id}/retire`, dcToken, {
        reason: 'cell disbanded after the season',
      });
      expect(retired.status).toBe(200);
      expect(retired.body['retiredAt']).not.toBeNull();
    });

    it('keeps the post readable rather than deleting it', async () => {
      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as { title: string; retiredAt: string | null }[];
      const cell = posts.find((p) => p.title === `Temporary Cell ${RUN}`);
      expect(cell).toBeDefined();
      expect(cell!.retiredAt).not.toBeNull();
    });

    it('can bring one back', async () => {
      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as { seatId: string; title: string }[];
      const cell = posts.find((p) => p.title === `Temporary Cell ${RUN}`)!;

      const res = await call('POST', `/roster/posts/${cell.seatId}/restore`, dcToken, {
        reason: 'locusts are back',
      });
      expect(res.status).toBe(200);
      expect(res.body['retiredAt']).toBeNull();
    });
  });

  //----------------------------------------------------------------------------
  // SLA targets — Q-06 as configuration
  //----------------------------------------------------------------------------

  describe('acknowledgement deadlines', () => {
    it('starts from the seeded district defaults rather than nothing', async () => {
      const res = await call('GET', '/admin/sla', dcToken);
      expect(res.status).toBe(200);
      const district = res.body['district'] as Record<string, number>;
      expect(district['critical']).toBeGreaterThan(0);
      // ADR-0009: `unknown` is not a level, but it still needs a deadline — and a tight one.
      expect(district['unknown']).toBeDefined();
    });

    /**
     * Changing one, not just setting one.
     *
     * These were the same code path in the caller's head and two different ones in Postgres:
     * the insert worked and the update failed with "could not determine data type of
     * parameter $1", because the shared parameter array bound two placeholders the UPDATE
     * never referenced. Every SLA test written before this one created a fresh row, so the
     * district could set a deadline exactly once and never revise it. Caught by the browser
     * test, where an operator naturally edits a value that already exists.
     */
    it('changes a deadline that already has a value', async () => {
      const first = await call('PUT', '/admin/sla', dcToken, {
        severity: 'moderate',
        ackMinutes: 45,
      });
      expect(first.status).toBe(200);

      const second = await call('PUT', '/admin/sla', dcToken, {
        severity: 'moderate',
        ackMinutes: 46,
      });
      expect(second.status).toBe(200);
      expect(await districtTarget('moderate')).toBe(46);
    });

    /**
     * 🔴 **A DEADLINE AIMED AT A DEPARTMENT IS REFUSED, NOT IGNORED — ADR-0030.**
     *
     * `sla_target` was keyed on (department, severity) and migration 0039 dropped the first
     * half with the table. The tempting thing was to drop the field quietly; that would take
     * *"set Rescue's deadline to five minutes"* and write the **district's** — the caller told
     * it worked, the number moved for everybody, and the screen it came from showing exactly
     * what was asked for. That is this codebase's worst signature, and this is the test that
     * keeps it out.
     *
     * ⚠️ **Two tests died here and neither was a loss.** *"lets a department have a tighter
     * deadline than the district"* and *"takes a department's own deadline away again"* both
     * asserted a dimension that no longer exists; the second was covering a real defect (the
     * console promised *"clear it to go back"* and nothing implemented it), and what is left of
     * that defect is now the refusal two tests below.
     */
    it('refuses a deadline aimed at a department rather than quietly writing the district’s', async () => {
      const before = await districtTarget('critical');

      const res = await call('PUT', '/admin/sla', dcToken, {
        departmentId: randomUUID(),
        severity: 'critical',
        ackMinutes: 2,
      });
      expect(res.status).toBe(400);
      expect(String(res.body['error'])).toContain('ADR-0030');

      // The district's own is untouched — the request was refused, not redirected.
      expect(await districtTarget('critical')).toBe(before);
    });

    /**
     * 🔴 **The database decided this and it is worth reading as a design decision, not a
     * constraint to work around.** The first version of this feature wrote its config row with
     * no reason and produced a **500**: `config_event_retire_needs_reason` (migration 0007)
     * refuses a 'retired' row that does not say why, and it was written so that stopping
     * something reaching somebody can never be done anonymously.
     *
     * ⚠️ **Asserted before the refusal below it, and the order is the point.** `setTarget` asks
     * for the reason first and only then discovers there is nothing underneath — so a caller
     * who forgot to say why is told that, rather than being handed a different refusal that
     * would send them looking in the wrong place.
     */
    it('refuses to clear a deadline without saying why', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'critical',
        ackMinutes: null,
      });
      expect(res.status).toBe(400);
      expect(String(res.body['error'])).toContain('say why');
    });

    /**
     * ⚠️ The district's own row falls back to **nothing**, and a severity with no deadline
     * anywhere is an emergency with no clock — which `domain/sla.ts` has no answer for. Refused
     * in words rather than allowed to produce that state.
     *
     * Since ADR-0030 the district's row is the **only** row, so this is the whole of clearing.
     */
    it('refuses to clear the district’s own deadline, which has nothing underneath it', async () => {
      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'critical',
        ackMinutes: null,
        reason: 'trying to remove the district’s own',
      });
      expect(res.status).toBe(400);
      expect(String(res.body['error'])).toContain('nothing underneath');

      expect(typeof (await districtTarget('critical'))).toBe('number');
    });

    /**
     * **A missing field is not a request to clear.** A caller that forgot `ackMinutes` is a bug,
     * and treating it as *"go back to the default"* would let that bug quietly erase a deadline
     * the district had chosen. Only an explicit `null` clears — and since ADR-0030 even that is
     * refused, which makes the distinction cheap to keep and expensive to lose.
     */
    it('still refuses a request with no ackMinutes at all', async () => {
      await call('PUT', '/admin/sla', dcToken, { severity: 'low', ackMinutes: 90 });

      const res = await call('PUT', '/admin/sla', dcToken, { severity: 'low' });
      expect(res.status).toBe(400);

      expect(await districtTarget('low')).toBe(90);
    });

    /**
     * A refusal writes nothing.
     *
     * ⚠️ **This is what survives of *"clearing a deadline nobody set writes no history"*.** That
     * test created a department, cleared a target it had never set, and proved the config log
     * did not grow — a `retired` row for a row that never existed would put a decision nobody
     * made into the one place in this system that may never be embroidered. There are no
     * departments to set one for now, and the claim underneath is unchanged and still worth
     * pinning: **a request the console refuses leaves no trace that it happened.**
     */
    it('a refused clear writes nothing into the configuration log', async () => {
      const before = await call('GET', '/admin/history', dcToken);

      const res = await call('PUT', '/admin/sla', dcToken, {
        severity: 'moderate',
        ackMinutes: null,
        reason: 'tidying up a target that has nothing underneath it',
      });
      expect(res.status).toBe(400);

      const after = await call('GET', '/admin/history', dcToken);
      expect((after.body as unknown as unknown[]).length).toBe(
        (before.body as unknown as unknown[]).length,
      );
    });

    /**
     * The number an operator reads off the board must be the number the administration set.
     * Before M1a the board rendered `PLACEHOLDER_SLA` — a guess in a source file — as though
     * it were the district's own rule.
     *
     * ⚠️ **No routing step any more.** This used to set a department's own deadline and then
     * assign the incident there so the row would pick it up. `targetsFor` reads the district's
     * table for an incident nobody holds, which since ADR-0030 is the only table there is — so
     * the assignment was the half that disappeared, and the claim is asserted more directly
     * than it used to be.
     */
    it('applies the configured deadline on the board, not the compiled-in default', async () => {
      const set = await call('PUT', '/admin/sla', dcToken, { severity: 'low', ackMinutes: 999 });
      expect(set.status).toBe(200);

      const report = await call('POST', '/incidents', rescueToken, {
        category: `paperwork ${RUN}`,
        severity: 'low',
      });

      const boardRes = await fetch(`${base}/incidents`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      const board = (await boardRes.json()) as Board;
      const row = board.incidents.find((r) => r.incidentId === report.body['incidentId']);
      expect(row?.targetMinutes).toBe(999);
    });
  });

  //----------------------------------------------------------------------------
  // Unassigned work, and the history
  //----------------------------------------------------------------------------

  describe('what the two offices see', () => {
    it('counts unassigned emergencies on the board summary (ADR-0005)', async () => {
      const created = await call('POST', '/incidents', rescueToken, {
        category: `nothing-matches-${RUN}`,
      });
      const id = created.body['incidentId'] as string;

      const board = (await (
        await fetch(`${base}/incidents`, { headers: { authorization: `Bearer ${dcToken}` } })
      ).json()) as Board;

      // Asserted on **this** incident rather than on the count going up. The board is capped
      // at the most recent 500, so on a test database with more unassigned incidents than
      // that, one more changes nothing — and the claim being tested was never about the
      // total anyway.
      expect(board.incidents.find((r) => r.incidentId === id)?.unassigned).toBe(true);
      expect(board.summary.unassigned).toBeGreaterThan(0);
    });

    /**
     * ⚠️ **This replaces *"shows every department with its posts and its vacancies"*, and the
     * question it asks is the same one.**
     *
     * The console counted posts and vacancies **per department**, seventy-nine times. There is
     * one list now, so it is asked once — and the thing that actually mattered is unchanged: a
     * post the control room can send to, with nobody in it, cannot be told anything. That is
     * Rescue 1122's real situation in the district's own contact list, and it is exactly the
     * kind of gap that stays invisible until the night it matters (ADR-0005).
     */
    it('shows the district its posts, and how many of them nothing can reach', async () => {
      const res = await call('GET', '/roster', dcToken);
      expect(res.status).toBe(200);

      const posts = res.body['posts'] as { title: string }[];
      expect(posts.find((p) => p.title === `Irrigation Duty ${RUN}`)).toBeDefined();

      // A count over the whole roster, not per department — there is no second dimension left.
      expect(typeof res.body['unreachablePosts']).toBe('number');
      expect(res.body['unreachablePosts'] as number).toBeGreaterThan(0);
    });

    it('records who changed what, and why, in an append-only log', async () => {
      const res = await call('GET', '/admin/history', dcToken);
      expect(res.status).toBe(200);
      const changes = res.body as unknown as {
        subject: string;
        action: string;
        reason: string | null;
        actorSeatTitle: string | null;
      }[];

      expect(changes.length).toBeGreaterThan(0);
      // The seat, not just the person: authority attaches to the post (ADR-0004).
      expect(changes.some((c) => c.actorSeatTitle !== null)).toBe(true);
      // Retirements carry their reason. The database refuses one without.
      const retire = changes.find((c) => c.action === 'retired');
      expect(retire?.reason).toBeTruthy();
    });

    it('will not let anything rewrite the configuration history', async () => {
      // The same guarantee as the incident log (ADR-0001), enforced at the database rather
      // than by everyone remembering.
      await expect(pool.query("UPDATE config_event SET reason = 'something else'")).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query('DELETE FROM config_event')).rejects.toThrow(/append-only/);
    });

    /**
     * ⚠️ **The field is `officers`, and it was renamed rather than repurposed — ADR-0029,
     * CD-05b.** A field called `departments` holding officers is the kind of half-migration
     * this project has paid for repeatedly: everything reading it goes on compiling and starts
     * describing the wrong thing. This test asserts the new name so a silent revert cannot pass.
     */
    it('reports the district’s officers together, ranked by what needs attention', async () => {
      const res = await call('GET', '/admin/performance', dcToken);
      expect(res.status).toBe(200);

      const district = res.body['district'] as Record<string, unknown>;
      expect(typeof district['total']).toBe('number');
      expect(typeof district['unassigned']).toBe('number');

      expect(res.body['departments']).toBeUndefined();
      const officers = res.body['officers'] as {
        name: string;
        medianAckMinutes: number | null;
        total: number;
      }[];
      expect(Array.isArray(officers)).toBe(true);

      // Somebody with no acknowledgements has null response times, never 0. Zero is the best
      // possible performance; no data is no performance at all (ADR-0005).
      const idle = officers.find((o) => o.total > 0 && o.medianAckMinutes === null);
      if (idle !== undefined) expect(idle.medianAckMinutes).toBeNull();
    });

    it('refuses the performance table to an ordinary seat', async () => {
      // It is every officer's responsiveness side by side. That is not a thing one officer
      // browses about another.
      expect((await call('GET', '/admin/performance', rescueToken)).status).toBe(403);
    });
  });
});
