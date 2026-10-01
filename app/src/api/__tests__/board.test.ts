/**
 * The central board — M0-33.
 *
 * What is under test is not "the list renders". It is the three things a board can silently
 * get wrong, each of which ends with somebody not being sent to an emergency:
 *
 *   - it shows another department's incidents, or hides its own (INV-05)
 *   - it folds an unassessed report into a severity level (ADR-0009, INV-04)
 *   - it presents data older than it claims (INV-02)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { saveGroup } from '../../db/groupStore.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { hashPassword } from '../../auth/passwords.js';
import { login, resolveSession } from '../../auth/sessions.js';
import { buildBoard, type Board } from '../board.js';
import { seatOf } from '../lifecycle.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { recordWhatTheySaid } from '../../jobs/notify.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('the central board (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;
  let rescueToken: string;
  let policeToken: string;
  let controlRoomToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    rescueToken = await actor('Rescue Duty Officer', 'station');
    policeToken = await actor('Police Duty Officer', 'station');
    controlRoomToken = await actor('Control Room Operator', 'district');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  // ADR-0030 — the department parameter is gone rather than voided. A seat does not sit in one
  // any more, and a test helper still asking for a department id is a signature describing a
  // model this district no longer has, in the file somebody reads to learn the model.
  //
  // ⚠️ `tier` IS NOT WRITTEN BY THIS INSERT AND MUST NOT BE READ AS IF IT WERE. Migration 0039
  // re-derives it in a trigger from `is_administration` alone, so asking for `district` and
  // writing nothing else gets a `department` seat — the control room silently loses the district
  // and every assertion below it fails somewhere far away, as an empty board rather than as
  // "this seat is not what you asked for". The tick is what the caller is really asking for.
  async function actor(name: string, tier: string): Promise<string> {
    const seat = await pool.query<{ seat_id: string }>(
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
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return result.token;
  }

  /**
   * A post somebody holds — the only thing the control room can dispatch to since ADR-0030.
   *
   * `dispatch-to` reads the directory and answers `no such department` for an id that is not in
   * it, so the department-kinded targets these tests used to send are refused outright now. That
   * refusal is the product working: a department is not a thing to tell any more.
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

  async function post(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  async function board(token: string | null): Promise<{ status: number; body: Board }> {
    const res = await fetch(`${base}/incidents`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Board };
  }

  /** An incident routed to a department, optionally with a stated severity. */
  async function incident(departmentId: string, severity?: string): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      ...(severity === undefined ? {} : { severity }),
    });
    const id = created['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [departmentId],
      reason: 'board test',
    });
    return id;
  }

  const rowFor = (b: Board, id: string) => b.incidents.find((r) => r.incidentId === id);

  it('marks a working-limited Record as incomplete instead of silently dropping its last row', async () => {
    await incident(rescueDept, 'high');
    await incident(rescueDept, 'low');

    const identity = await resolveSession(pool, controlRoomToken);
    const seat = identity === null ? null : seatOf(identity);
    expect(seat).not.toBeNull();

    const limited = await buildBoard(pool, seat!, { days: 7, limit: 1 });
    expect(limited.incidents).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });

  it('requires a session', async () => {
    expect((await board(null)).status).toBe(401);
  });

  describe('scoping is server-side (INV-05)', () => {
    /**
     * ⚠️ **THIS TEST ASKED A DIFFERENT QUESTION UNTIL ADR-0030, AND THE OLD ONE NO LONGER HAS AN
     * ANSWER.** It used to seed two departments and prove each was sent its own incidents and not
     * its neighbour's. There are no departments now, so there is no such thing as *its own*, and
     * a test written to that shape could only be made to pass by inventing one back.
     *
     * What survives is the half INV-05 is actually about, and it is the half worth guarding after
     * a migration that drops a whole layer: **dropping the department table must not have widened
     * reading.** `evaluateRead` reaches `seat.departmentId`, which is null for every seat alive —
     * so the one thing that could have gone wrong here is the null being read as *matches
     * everything* rather than *matches nothing*. This file records that exact class of mistake
     * three times over. An ordinary post holder is sent nothing that has been placed with
     * anybody, and the refusal happens on the server rather than in a screen.
     */
    it('does not send a seat with no district authority an incident somebody else is holding', async () => {
      const placed = await incident(rescueDept, 'high');
      const alsoPlaced = await incident(policeDept, 'high');

      const ordinary = await board(rescueToken);
      // Not merely hidden in the UI — never sent.
      expect(rowFor(ordinary.body, placed)).toBeUndefined();
      expect(rowFor(ordinary.body, alsoPlaced)).toBeUndefined();

      // A second ordinary seat is refused the same two, so this is the rule and not one seat.
      const another = await board(policeToken);
      expect(rowFor(another.body, placed)).toBeUndefined();
      expect(rowFor(another.body, alsoPlaced)).toBeUndefined();
    });

    /**
     * 🔴 **THE HOLE ADR-0030 OPENS, AND IT IS THE ONE THIS FILE HAS BEEN WARNED ABOUT.**
     *
     * `evaluateRead`'s first branch answers *allowed, as owner* whenever nobody is responsible
     * for an incident. That was written for the seconds between a report arriving and somebody
     * placing it, and it was right: before routing, the control room is who holds it.
     *
     * Nothing can be placed any more. `/route` takes department ids and there are no departments
     * to take, and the dispatch path's own assignment resolves a chosen post to `null`. So
     * `responsibleDepartmentIds` is empty for **every incident in Bajaur, permanently**, and that
     * first branch stops being a window and becomes the rule: every account reads everything.
     *
     * CLAUDE.md has carried the sentence for this since 2026-08-22 — *"removing them would make
     * every seat district-tier and `evaluateRead` would widen to let everybody read everything.
     * That exact failure has happened here once before."* It is the absent-value-read-as-
     * permissive mistake this project has now made four times.
     *
     * ⚠️ **Nothing is exposed in Bajaur today and that is luck, not design:** the district holds
     * one account and it is the control room's (ADR-0018). The day a second is issued, the
     * refusal has to already be here.
     */
    it('does not hand an incident nobody holds to every account in the district', async () => {
      const held = await incident(rescueDept, 'high');
      const nobodys = (await post('/incidents', controlRoomToken, { category: 'rta' }))[
        'incidentId'
      ] as string;

      const ordinary = await board(rescueToken);
      expect(rowFor(ordinary.body, held)).toBeUndefined();
      // The one that was open: unplaced is not unowned.
      expect(rowFor(ordinary.body, nobodys)).toBeUndefined();

      // And the control room still sees it, or the refusal has taken the district with it.
      expect(rowFor((await board(controlRoomToken)).body, nobodys)).toBeDefined();
    });

    it('shows the district everything', async () => {
      const a = await incident(rescueDept, 'high');
      const b = await incident(policeDept, 'low');
      const view = await board(controlRoomToken);
      expect(rowFor(view.body, a)).toBeDefined();
      expect(rowFor(view.body, b)).toBeDefined();
    });

    /**
     * The export is the board, so its scoping has to be the board's — capability 9.
     *
     * Written here rather than beside the CSV unit tests on purpose: the risk is not that the
     * formatting is wrong, it is that a *file departments email to each other* is built from a
     * different query than the screen and quietly answers a wider question. Same `buildBoard`,
     * same seat, therefore the same answer — asserted rather than assumed.
     */
    it('scopes the spreadsheet export exactly as it scopes the board', async () => {
      const placed = await incident(rescueDept, 'high');

      const asDistrict = await fetch(`${base}/export/incidents.csv?days=7`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      });

      expect(asDistrict.status).toBe(200);
      expect(asDistrict.headers.get('content-type')).toMatch(/text\/csv/);
      expect(asDistrict.headers.get('content-disposition')).toMatch(
        /attachment; filename="incidents-/,
      );
      expect(await asDistrict.text()).toContain(placed);

      // The same file, asked for by a seat the board sends nothing to, and answered the same way.
      const asOrdinary = await fetch(`${base}/export/incidents.csv?days=7`, {
        headers: { authorization: `Bearer ${rescueToken}` },
      });
      expect(asOrdinary.status).toBe(200);
      // Never sent, exactly as on the board.
      expect(await asOrdinary.text()).not.toContain(placed);
    });

    it('refuses the export without a session', async () => {
      expect((await fetch(`${base}/export/incidents.csv`)).status).toBe(401);
    });
  });

  /**
   * The dashboard's counters and the board's flags must be the same rule.
   *
   * The browser test proves clicking a counter selects exactly the rows carrying its flag.
   * This proves the other half: that the flag means what the counter counted. The two live in
   * different files — `districtSummary` in `api/dashboard.ts` and `toRow` in `api/board.ts` —
   * so nothing but this stops one being edited without the other, and a counter that says 5
   * while the board holds 4 matching rows is the failure the owner asked to be rid of.
   *
   * Fetched back to back, because the district moves: this is the tightest window available,
   * and a mismatch of one is still a mismatch of one.
   */
  describe('the district counters and the board agree on what they mean', () => {
    it('counts the same unassigned, unacknowledged and today as the rows carry', async () => {
      await incident(rescueDept, 'high');

      const [dash, board] = await Promise.all([
        fetch(`${base}/dashboard`, {
          headers: { authorization: `Bearer ${controlRoomToken}` },
        }).then((r) => r.json() as Promise<Record<string, never>>),
        fetch(`${base}/incidents?closed=1`, {
          headers: { authorization: `Bearer ${controlRoomToken}` },
        }).then((r) => r.json() as Promise<Board>),
      ]);

      const district = (dash as unknown as { district: Record<string, number> }).district;
      const live = board.incidents.filter((r) => r.status !== 'closed' && r.status !== 'resolved');

      expect(live.filter((r) => !r.held).length).toBe(district['unassigned']);
      /**
       * `!r.general` here too — M11-02. **This is the assertion that made the dashboard half of
       * the fix necessary**, and it earned its keep: excluding General communications on the
       * board alone left this comparison failing, which is precisely what it exists to catch —
       * the district's home screen and the board it opens answering one question two ways.
       */
      expect(live.filter((r) => !r.general && !r.acknowledged).length).toBe(
        district['overdueUnacknowledged'],
      );
      expect(live.length).toBe(district['openIncidents']);

      // "Reported today" is the one that counts closed incidents too — an emergency dealt
      // with by lunchtime still happened today.
      expect(board.incidents.filter((r) => r.occurredToday).length).toBe(district['today']);
    });
  });

  /**
   * **The row names who was told, and says how it ended** — the district asked for both on the
   * row, 2026-08-23.
   *
   * The first assertion is the one that matters, and it is written against the case that was
   * actually broken. An incident dispatched to a **named officer** with no department answering
   * for it used to reach the board with `responsibleDepartments` empty, and the screen printed
   * *"told directly"* — a sentence naming nobody, on the ordinary path since M10-07/08/09 made
   * the person row the only row the picker draws.
   *
   * ⚠️ **It asserts the NAME, never the id.** Sending the uuid and letting the browser look it
   * up is the shape this file exists to refuse (M0-51): ids are what the log stores, names are
   * the only form an operator can act on, and a row that had to make a second request for them
   * is a row that renders an id when the request fails.
   */
  describe('the row says who was told and how it ended (2026-08-23)', () => {
    it('names a person the control room dispatched to, rather than saying "told directly"', async () => {
      /**
       * A named officer with **no department answering for this incident** — which is the whole
       * point. Routing is deliberately not called, so `responsibleDepartments` stays empty and
       * the row has nothing but `toldNames` to say who this went to.
       */
      const name = 'Nawaz Khan (told-by-name test)';
      const person = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, $3) RETURNING person_id`,
        [name, `+92300${randomUUID().slice(0, 10)}`, await hashPassword(PASSWORD)],
      );
      const personId = person.rows[0]?.person_id ?? '';

      const created = await post('/incidents', controlRoomToken, { category: 'rta' });
      const id = created['incidentId'] as string;

      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'person', id: personId }],
      });

      const row = rowFor((await board(controlRoomToken)).body, id);
      // No department holds it — so this is exactly the row that used to read "told directly".
      expect(row?.responsibleDepartments).toEqual([]);
      // Somebody *was* chosen, and now the row can say who rather than only that somebody was.
      expect(row?.nobodyTold).toBe(false);
      expect(row?.toldNames).toContain(name);
    });

    /**
     * **`Rustam Khan — DDMA` — name AND the post held, on the row** — the district's own shape
     * (`backlog/whatsapp-response-workflow.md` §6), person-first per ADR-0035, shipped
     * 2026-09-07.
     *
     * The officer above holds no post and is named alone; this one does, and the row carries
     * both halves so the control room can tell *who* and *acting as what* without opening the
     * incident.
     */
    it('names a dispatched officer as "name — designation" when they hold a post', async () => {
      const name = 'Rustam Khan (designation test)';
      const designation = `DDMA Bajaur ${randomUUID().slice(0, 8)}`;
      const seat = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'post', false, false) RETURNING seat_id`,
        [designation],
      );
      const person = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, $3) RETURNING person_id`,
        [name, `+92300${randomUUID().slice(0, 10)}`, await hashPassword(PASSWORD)],
      );
      const personId = person.rows[0]!.person_id;
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seat.rows[0]!.seat_id,
        personId,
      ]);

      const created = await post('/incidents', controlRoomToken, { category: 'rta' });
      const id = created['incidentId'] as string;
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'person', id: personId }],
      });

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.toldNames).toContain(`${name} — ${designation}`);
    });

    /**
     * **A `post` dispatch reads `<holder> — <title>` too** — 2026-09-08. The owner tested with
     * a learned proposal (which is a `post` target) and saw the title alone; the "who was told"
     * list answers *which human was reached* either way, so a post leads with its holder.
     */
    it('names a dispatched POST as "holder — title" on the row', async () => {
      const title = `IT Soft ${randomUUID().slice(0, 8)}`;
      const holder = 'Imtiaz Ahmad (post-holder test)';
      const seat = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'post', false, false) RETURNING seat_id`,
        [title],
      );
      const person = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone) VALUES ($1, $2) RETURNING person_id`,
        [holder, `+92300${randomUUID().slice(0, 10)}`],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seat.rows[0]!.seat_id,
        person.rows[0]!.person_id,
      ]);

      const created = await post('/incidents', controlRoomToken, { category: 'rta' });
      const id = created['incidentId'] as string;
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: seat.rows[0]!.seat_id }],
      });

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.toldNames).toContain(`${holder} — ${title}`);
    });

    /**
     * A **vacant** post keeps its title alone — nobody to lead with, and ADR-0004 says the
     * empty post must still be visible on the list.
     */
    it('names a vacant dispatched POST by its title alone', async () => {
      const title = `Vacant Desk ${randomUUID().slice(0, 8)}`;
      const seat = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'post', false, false) RETURNING seat_id`,
        [title],
      );
      const created = await post('/incidents', controlRoomToken, { category: 'rta' });
      const id = created['incidentId'] as string;
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: seat.rows[0]!.seat_id }],
      });

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.toldNames).toContain(title);
    });

    /**
     * 🔴 **The green row over an emergency nobody has taken** — RX-02, 2026-08-25.
     *
     * The district's response workflow shipped this fact onto the incident's own panel, and that
     * was half the job: **the control room does not open an incident at 02:00, it reads this
     * board.** An emergency every recipient declined has an `acknowledgedAt`, so the row said
     * `acknowledged` and was indistinguishable from one somebody is dealing with.
     */
    // ⚠️ The DISPATCHED attempt, never `notifications[0]`. `ownershipOf` counts dispatches and
    // nothing else — an escalation is the system saying nobody answered — so answering whichever
    // attempt happened to fold first records the officer's words against a row that is not
    // counted, and the flag under test stays false while everything looks like it worked.
    async function answer(incidentId: string, said: string): Promise<void> {
      const events = await loadIncident(pool, incidentId);
      const attempt = foldIncident(incidentId, events).notifications.find(
        (n) => n.reason === 'dispatched',
      );
      if (attempt === undefined) throw new Error('nobody was told, so nobody can answer');
      await recordWhatTheySaid(pool, incidentId, attempt.attemptId, { via: 'link', said });
    }

    it('flags a row every recipient declined, and says how many', async () => {
      const id = await incident(rescueDept, 'high');
      const told = await heldPost(`Declining Officer ${randomUUID().slice(0, 8)}`);
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: told }],
      });

      // Before anybody answers, silence is silence — and it must not wear this flag.
      expect(rowFor((await board(controlRoomToken)).body, id)?.ownerless).toBe(false);

      await answer(id, 'Unable to Respond');

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.ownerless).toBe(true);
      expect(row?.declined).toBe(1);
    });

    /**
     * ⚠️ The other half, and the half that keeps the flag worth reading: while **anybody** is
     * holding it there is nothing to reassign, and a flag that appeared anyway would be one more
     * colour an operator learns to scan past.
     */
    it('leaves a row alone while somebody is still holding it', async () => {
      const id = await incident(rescueDept, 'high');
      const told = await heldPost(`Holding Officer ${randomUUID().slice(0, 8)}`);
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: told }],
      });

      await answer(id, 'Deploying Relevant Staff / Team');

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.ownerless).toBe(false);
      expect(row?.declined).toBe(0);
    });
    /**
     * **The Record's "Response" — what the officers themselves said, 2026-08-31.**
     *
     * The aggregate is `ownershipOf`'s, so this cannot drift from `ownerless`/`declined` above.
     * What it adds is the readable half: the latest reply verbatim, named, and a per-recipient
     * breakdown for the row's own disclosure.
     */
    it('carries the officers own answers, and only once there is one', async () => {
      const id = await incident(rescueDept, 'high');

      // Nobody dispatched — no conversation to report on, and null rather than an empty shell.
      expect(rowFor((await board(controlRoomToken)).body, id)?.response).toBeNull();

      const title = `Responding Officer ${randomUUID().slice(0, 8)}`;
      const told = await heldPost(title);
      // `heldPost` gives the seat a holder named `<title> holder`, so a `post` recipient reads
      // holder-then-title everywhere the record names who was told (2026-09-08).
      const who = `${title} holder — ${title}`;
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: told }],
      });

      // Told, not yet answered: the denominator is real, `latest` is still null (a tap is not
      // a reply), and the one recipient reads as silent.
      const before = rowFor((await board(controlRoomToken)).body, id)?.response;
      expect(before?.told).toBe(1);
      expect(before?.silent).toBe(1);
      expect(before?.holding).toBe(0);
      expect(before?.latest).toBeNull();
      // `group: null` — a hand-picked recipient, no group expanded (Case 3).
      expect(before?.breakdown).toEqual([{ who, holding: 'silent', said: null, group: null }]);

      await answer(id, 'Deploying Relevant Staff / Team');

      const after = rowFor((await board(controlRoomToken)).body, id)?.response;
      expect(after?.holding).toBe(1);
      expect(after?.silent).toBe(0);
      expect(after?.ownerless).toBe(false);
      expect(after?.latest?.said).toBe('Deploying Relevant Staff / Team');
      expect(after?.latest?.who).toBe(who);
      expect(after?.breakdown).toEqual([
        { who, holding: 'holding', said: 'Deploying Relevant Staff / Team', group: null },
      ]);
    });

    it('carries the resolution only once it is actually resolved', async () => {
      const id = await incident(rescueDept, 'high');

      // Live: no resolution to show, and null rather than an empty string — a blank box under
      // every open emergency is the noise this screen has just had removed.
      expect(rowFor((await board(controlRoomToken)).body, id)?.resolution).toBeNull();

      const said = 'road cleared, one shifted to DHQ';
      await post(`/incidents/${id}/resolve`, controlRoomToken, { outcome: said });

      // Resolved rows are off the live board, so ask for the closed ones too.
      const withClosed = await fetch(`${base}/incidents?closed=1`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      }).then((r) => r.json() as Promise<Board>);

      expect(rowFor(withClosed, id)?.resolution).toBe(said);
    });
  });

  /**
   * **The group a dispatch expanded, on the row's breakdown — Case 3, 2026-09-10.**
   *
   * `expand()` dissolves a ticked group at send, so `response.breakdown` is per-recipient as
   * ever; the server tags each line with the group's name (read off `dispatched.payload
   * .fromGroups`, `null` for a hand-picked recipient) so the row's disclosure can head them.
   * Display only — the aggregate counts are `ownershipOf`'s and unchanged.
   */
  describe('the group a dispatch expanded, on the row breakdown (Case 3)', () => {
    async function makeGroup(name: string, seatIds: readonly string[]): Promise<string> {
      const res = await saveGroup(
        pool,
        { name, members: seatIds.map((id) => ({ kind: 'post', id })) },
        { seatId: null, personId: null },
      );
      if (!res.ok) throw new Error(`saveGroup: ${res.problem.kind}`);
      return res.group.groupId;
    }

    async function answerSeat(incidentId: string, seatId: string, said: string): Promise<void> {
      const attempt = foldIncident(
        incidentId,
        await loadIncident(pool, incidentId),
      ).notifications.find((n) => n.reason === 'dispatched' && n.seatId === seatId);
      if (attempt === undefined) throw new Error(`no dispatched attempt for ${seatId}`);
      await recordWhatTheySaid(pool, incidentId, attempt.attemptId, { via: 'link', said });
    }

    it('names the group on every breakdown line it expanded, null for a hand-picked recipient', async () => {
      const groupName = `All Tehsildars ${randomUUID().slice(0, 8)}`;
      const seats = [
        await heldPost(`Tehsildar One ${randomUUID().slice(0, 6)}`),
        await heldPost(`Tehsildar Two ${randomUUID().slice(0, 6)}`),
        await heldPost(`Tehsildar Three ${randomUUID().slice(0, 6)}`),
      ];
      const groupId = await makeGroup(groupName, seats);

      const grouped = await incident(rescueDept, 'high');
      await post(`/incidents/${grouped}/dispatch-to`, controlRoomToken, {
        groups: [groupId],
        reason: 'every tehsildar',
      });
      await answerSeat(grouped, seats[0]!, 'Deploying Relevant Staff / Team');

      const gRow = rowFor((await board(controlRoomToken)).body, grouped)?.response;
      expect(gRow?.breakdown).toHaveLength(3);
      for (const b of gRow!.breakdown) expect(b.group).toBe(groupName);
      // The aggregate is untouched — one holding, two silent.
      expect(gRow?.holding).toBe(1);
      expect(gRow?.silent).toBe(2);

      // A hand-picked dispatch on another incident: no group on any line.
      const byHand = await incident(rescueDept, 'high');
      await post(`/incidents/${byHand}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: seats[0]! }],
      });
      const hRow = rowFor((await board(controlRoomToken)).body, byHand)?.response;
      expect(hRow?.breakdown).toEqual([expect.objectContaining({ group: null })]);
    });
  });

  /**
   * **The district's own number, on every row** — 2026-08-24.
   *
   * The uuid is what the row is built on and what the URL carries; the number is what an
   * operator scanning the Record reads and quotes. Asserted against the row rather than the
   * screen because the format is the SERVER's — one template for the board, the detail screen
   * and the printed report, or the three begin quoting one incident three ways.
   */
  describe('every row carries the number the district counts by', () => {
    it('gives the row a number in the printed form, beside the record id', async () => {
      const id = await incident(rescueDept, 'high');
      const row = rowFor((await board(controlRoomToken)).body, id);

      expect(row?.reference).toMatch(/^DNC-BAJAUR-[1-9][0-9]*$/);
      // Beside the uuid, never instead of it.
      expect(row?.incidentId).toBe(id);
    });

    it('counts up, so the newer emergency has the higher number', async () => {
      const first = await incident(rescueDept, 'high');
      const second = await incident(rescueDept, 'high');
      const rows = (await board(controlRoomToken)).body;

      const numberOf = (id: string): number =>
        Number(rowFor(rows, id)?.reference?.replace('DNC-BAJAUR-', '') ?? 0);

      expect(numberOf(second)).toBe(numberOf(first) + 1);
    });
  });

  describe('an unassessed report is never dressed as a level (ADR-0009, INV-04)', () => {
    it('marks the row unassessed rather than giving it a severity', async () => {
      const id = await incident(rescueDept); // no severity stated
      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.severity).toBe('unknown');
      expect(row?.assessed).toBe(false);
    });

    it('counts it separately in the summary, in neither direction', async () => {
      const view = await board(controlRoomToken);
      // It is not folded into `worst` — which is the count that would hide it — and it is
      // not counted as a critical either, which would hide the real ones among them.
      expect(view.body.summary.unassessed).toBeGreaterThan(0);
      expect(view.body.summary.worst).not.toBe('unknown');
    });

    it('still puts it near the top of the queue, because it could be anything', async () => {
      // Ordering for attention is a different question from ranking for aggregation, and
      // this is the one place they legitimately differ. See `attentionRank`.
      const view = await board(controlRoomToken);
      const unassessed = view.body.incidents.findIndex((r) => !r.assessed && !r.overdue);
      const low = view.body.incidents.findIndex(
        (r) => r.severity === 'low' && !r.overdue && r.acknowledgedAt === null,
      );
      if (unassessed !== -1 && low !== -1) expect(unassessed).toBeLessThan(low);
    });
  });

  describe('it says how old it is (INV-02)', () => {
    it('stamps every response with the server time it was folded', async () => {
      const view = await board(controlRoomToken);
      expect(Number.isFinite(Date.parse(view.body.asOf))).toBe(true);
    });

    it('carries lastRecordedAt on every row, so a client can age it', async () => {
      const id = await incident(rescueDept, 'high');
      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.lastRecordedAt).not.toBeNull();
      expect(Number.isFinite(Date.parse(row!.lastRecordedAt!))).toBe(true);
    });
  });

  describe('what the board is for', () => {
    it('puts unacknowledged work above work already picked up', async () => {
      const acked = await incident(rescueDept, 'critical');
      /**
       * ⚠️ **TOLD FIRST, BECAUSE AN ACKNOWLEDGEMENT NOW NEEDS SOMEBODY TO HAVE BEEN TOLD.**
       *
       * `incident()` routes and never dispatches, and since ADR-0030 the acknowledge guard asks
       * `dispatchedTo` rather than a responsible department. So this POST answered 409 and the
       * row stayed unacknowledged — which left the test asserting that a CRITICAL row sorts below
       * a low one, and passing that off as the acknowledged-work rule. The premise has to happen
       * for the ordering to mean anything.
       */
      const picked = await heldPost(`Picked It Up ${randomUUID().slice(0, 8)}`);
      await post(`/incidents/${acked}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: picked }],
      });
      await post(`/incidents/${acked}/acknowledge`, controlRoomToken, {});
      const open = await incident(rescueDept, 'low');

      const rows = (await board(controlRoomToken)).body.incidents;
      expect(rows.findIndex((r) => r.incidentId === open)).toBeLessThan(
        rows.findIndex((r) => r.incidentId === acked),
      );
    });

    /**
     * 🔴 **Option C — a wide dispatch every office declined sorts with the work, not below it.**
     *
     * The first answer of any kind fills the incident's one `acknowledgedAt` slot, a refusal
     * included, so `compareRows` filed a fire two offices had refused *beneath* a critical
     * somebody was on. It ranks with the unacknowledged now; `takenBy != null` is what lets a
     * row recede.
     */
    it('keeps a row every office declined above one somebody has taken', async () => {
      const held = await incident(rescueDept, 'critical');
      const heldSeat = await heldPost(`On It ${randomUUID().slice(0, 8)}`);
      await post(`/incidents/${held}/dispatch-to`, controlRoomToken, {
        targets: [{ kind: 'post', id: heldSeat }],
      });
      await post(`/incidents/${held}/acknowledge`, controlRoomToken, {});

      const refused = await incident(rescueDept, 'high');
      const a = await heldPost(`Busy A ${randomUUID().slice(0, 8)}`);
      const b = await heldPost(`Busy B ${randomUUID().slice(0, 8)}`);
      await post(`/incidents/${refused}/dispatch-to`, controlRoomToken, {
        targets: [
          { kind: 'post', id: a },
          { kind: 'post', id: b },
        ],
      });
      const detail = (await (
        await fetch(`${base}/incidents/${refused}`, {
          headers: { authorization: `Bearer ${controlRoomToken}` },
        })
      ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
      for (const seatId of [a, b]) {
        const attemptId = detail.state.notifications.find((n) => n.seatId === seatId)?.attemptId;
        await post(`/incidents/${refused}/acknowledged-by`, controlRoomToken, {
          attemptId,
          outcome: 'confirmed',
          said: 'Unable to Respond',
        });
      }

      const board1 = (await board(controlRoomToken)).body;
      const refusedRow = rowFor(board1, refused);
      // The slot is filled — the old rule would have let it recede — but nobody is holding it.
      expect(refusedRow?.acknowledgedAt).not.toBeNull();
      expect(refusedRow?.ownerless).toBe(true);
      expect(board1.incidents.findIndex((r) => r.incidentId === refused)).toBeLessThan(
        board1.incidents.findIndex((r) => r.incidentId === held),
      );
    });

    it('drops an incident once it is closed', async () => {
      const id = await incident(rescueDept, 'low');
      await post(`/incidents/${id}/acknowledge`, controlRoomToken, {});
      await post(`/incidents/${id}/resolve`, controlRoomToken, { outcome: 'cleared' });
      await post(`/incidents/${id}/close`, controlRoomToken, { notes: 'done' });

      expect(rowFor((await board(controlRoomToken)).body, id)).toBeUndefined();
    });

    it('shows a district override without erasing what the department said', async () => {
      const id = await incident(rescueDept, 'high');
      await post(`/incidents/${id}/triage`, controlRoomToken, {
        severity: 'high',
        category: 'rta',
      });
      await post(`/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms casualties',
      });

      const row = rowFor((await board(controlRoomToken)).body, id);
      expect(row?.severity).toBe('critical');
      // The department's own assessment is on the board too, not buried in a detail view.
      expect(row?.overriddenFrom).toBe('high');
    });

    it('counts open, unacknowledged and overdue honestly', async () => {
      const view = await board(controlRoomToken);
      const { summary, incidents } = view.body;
      expect(summary.open).toBe(incidents.filter((r) => r.status !== 'closed').length);
      /**
       * ⚠️ **This assertion carried the M11-02 defect and is corrected here — `!r.general`.**
       *
       * It used to read `incidents.filter((r) => r.acknowledgedAt === null)`, which is what the
       * code did rather than what the district needs, so it passed for as long as the bug
       * existed. That is the same shape as the `whatsappLoop` assertion written against the
       * code instead of against Meta's approved template, and as `dashboard.test.ts`'s fixture
       * that encoded the seatless-caller bug: **a test that asserts what the code does proves
       * only that the code does it.**
       *
       * `overdue` needed no change on the same line, and the reason is the whole point of the
       * fix: it has always gone through `CARRIES_SLA`, so it was already right.
       */
      expect(summary.unacknowledged).toBe(
        incidents.filter((r) => !r.general && r.acknowledgedAt === null).length,
      );
      expect(summary.overdue).toBe(incidents.filter((r) => r.overdue).length);
    });
  });

  /**
   * **A General communication moves none of the district's figures — M11-01/02/05.**
   *
   * The defect this pins was reported by the owner off one screenshot: a board holding a single
   * `MEETING` notice and nothing else read `1 unacknowledged · worst assessed: high`, directly
   * above a row whose own words were **"sent · no answer needed"**. One strip, contradicting
   * both itself and the row beneath it.
   *
   * The contradiction is exact and worth keeping: `past deadline` was **right** all along,
   * because `toRow` puts it through `CARRIES_SLA`. `unacknowledged` and `worst` are raw folds
   * over `live` and never asked the question. So this is not "General handling was missed" — it
   * is one rule applied in one of the three places that needed it.
   *
   * **Asserted while the notice is still live on the board**, which is the only moment the
   * confusion can happen — M9-11's own test learned this by first asserting after resolution and
   * finding nothing to catch.
   */
  describe('a General communication is not an emergency in the summary (M11-01/02)', () => {
    it('is on the board, and moves neither unacknowledged nor worst assessed', async () => {
      const before = (await board(controlRoomToken)).body.summary;

      const created = await post('/incidents', controlRoomToken, {
        kind: 'meeting',
        category: 'general',
        // The severity intake asks every report for, and which means nothing here.
        severity: 'critical',
        subject: 'District coordination meeting',
      });
      const id = created['incidentId'] as string;

      const after = (await board(controlRoomToken)).body;

      /**
       * It **is** on the board, and that is asserted first deliberately. The fix must never
       * become "filter notices out of the board" — the district asked to be told about them,
       * M10-13 is the only rule that removes a row from this screen, and a notice nobody can
       * see is a meeting nobody attends.
       */
      expect(rowFor(after, id)?.general).toBe(true);

      // Neither figure moved...
      expect(after.summary.unacknowledged).toBe(before.unacknowledged);
      expect(after.summary.worst).toBe(before.worst);
      // ...and `open` did, because the row is on the board and the board says so.
      expect(after.summary.open).toBe(before.open + 1);

      /**
       * The same claim again, order-independently — and this is the assertion that actually
       * guards the rule.
       *
       * The before/after pair above cannot catch a `worst` regression on a shared test database
       * whose worst is already `critical` from an earlier file: `critical` is the top of the
       * scale, so a notice cannot push it higher and the comparison passes either way. Checking
       * the summary against **the rows the board itself sent** cannot be gamed by residue, which
       * is this project's standing lesson about a test asserting on state it does not own.
       */
      expect(after.summary.unacknowledged).toBe(
        after.incidents.filter((r) => !r.general && r.acknowledgedAt === null).length,
      );

      /**
       * And the row carries the same answer — M11-06. Without this the notice is excluded from
       * the *figure* and still selected by the *filter* that figure leads to, which is the exact
       * shape Phase 0a shipped: `4 unacknowledged` landing on five rows.
       */
      expect(rowFor(after, id)?.unacknowledged).toBe(false);
      expect(rowFor(after, id)?.unassessed).toBe(false);
    });

    /**
     * **And `issued` DOES count it — which is why the strip gained a figure instead of a new
     * label (2026-08-18).**
     *
     * The board's strip now says the district's own first word rather than *"unacknowledged"*, so
     * the board and the wall speak one vocabulary. The cheap way to get there was to rename
     * `unacknowledged` to `Issued`, and it would have been wrong: this notice **is** issued —
     * it went out and nothing has come back — while `unacknowledged` deliberately does not count
     * it, because a notice owes nobody an answer (M11-02).
     *
     * Renaming would have put the word `Issued` on two screens over two different numbers, which
     * is M11-06's defect with the label moved instead of the predicate. This test is the reason
     * both figures exist, and it fails the moment somebody folds them back together.
     */
    it('counts a notice as issued even though it is never unacknowledged', async () => {
      const created = await post('/incidents', controlRoomToken, {
        kind: 'meeting',
        category: 'general',
        severity: 'critical',
        subject: 'Notice that is issued and owed no answer',
      });
      const id = created['incidentId'] as string;

      const after = (await board(controlRoomToken)).body;
      const row = rowFor(after, id);

      // The row itself holds both halves, and they disagree on purpose.
      expect(row?.stage).toBe('issued');
      expect(row?.unacknowledged).toBe(false);

      // And the two summary figures follow their own rows rather than each other.
      expect(after.summary.issued).toBe(after.incidents.filter((r) => r.stage === 'issued').length);
      expect(after.summary.issued).toBeGreaterThan(after.summary.unacknowledged);
    });
  });

  /**
   * **A notice that asked who is coming carries the attendance tally on its row — Case 2.**
   *
   * The row's *Response* column shows `attending / representative / not attending / silent`, not
   * the generic reply words a meeting has no use for, and `compareRows` floats a meeting more
   * people still owe an answer above one that is settled.
   */
  describe('the meeting attendance tally on the row (Case 2)', () => {
    async function meetingToldMany(seatIds: readonly string[]): Promise<string> {
      const created = await post('/incidents', controlRoomToken, {
        kind: 'meeting',
        details: { subject: 'Board attendance test meeting' },
      });
      const id = created['incidentId'] as string;
      await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: seatIds.map((sid) => ({ kind: 'post', id: sid })),
      });
      return id;
    }

    async function reply(id: string, seatId: string, said: string): Promise<void> {
      const detail = (await (
        await fetch(`${base}/incidents/${id}`, {
          headers: { authorization: `Bearer ${controlRoomToken}` },
        })
      ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
      const attemptId = detail.state.notifications.find((n) => n.seatId === seatId)?.attemptId;
      await post(`/incidents/${id}/acknowledged-by`, controlRoomToken, {
        attemptId,
        outcome: 'confirmed',
        said,
      });
    }

    it('counts who is coming, a representative included, and is null for an emergency', async () => {
      const a = await heldPost(`Tehsildar A ${randomUUID().slice(0, 8)}`);
      const b = await heldPost(`Tehsildar B ${randomUUID().slice(0, 8)}`);
      const c = await heldPost(`Tehsildar C ${randomUUID().slice(0, 8)}`);
      const id = await meetingToldMany([a, b, c]);
      await reply(id, a, 'Attending');
      await reply(id, b, 'Sending someone');
      // c stays silent

      const view = (await board(controlRoomToken)).body;
      const row = rowFor(view, id);
      expect(row?.attendance).not.toBeNull();
      expect(row?.attendance?.told).toBe(3);
      expect(row?.attendance?.coming).toBe(2);
      expect(row?.attendance?.attending).toBe(1);
      expect(row?.attendance?.sendingSomeone).toBe(1);
      expect(row?.attendance?.unanswered).toBe(1);

      // An emergency row never grows a tally — nobody attends a road accident.
      const emergency = await incident(rescueDept, 'high');
      expect(
        rowFor((await board(controlRoomToken)).body, emergency)?.attendance ?? null,
      ).toBeNull();
    });

    it('sorts a meeting more people still owe an answer above a settled one', async () => {
      const settled = await meetingToldMany([
        await heldPost(`Settled A ${randomUUID().slice(0, 8)}`),
        await heldPost(`Settled B ${randomUUID().slice(0, 8)}`),
      ]);
      const [sa, sb] = (
        (await (
          await fetch(`${base}/incidents/${settled}`, {
            headers: { authorization: `Bearer ${controlRoomToken}` },
          })
        ).json()) as { state: { notifications: { seatId: string | null }[] } }
      ).state.notifications.map((n) => n.seatId!);
      await reply(settled, sa!, 'Attending');
      await reply(settled, sb!, 'Attending');

      const open = await meetingToldMany([
        await heldPost(`Open A ${randomUUID().slice(0, 8)}`),
        await heldPost(`Open B ${randomUUID().slice(0, 8)}`),
        await heldPost(`Open C ${randomUUID().slice(0, 8)}`),
      ]);

      const rows = (await board(controlRoomToken)).body.incidents;
      expect(rows.findIndex((r) => r.incidentId === open)).toBeLessThan(
        rows.findIndex((r) => r.incidentId === settled),
      );
    });
  });

  /**
   * **The summary is folded from the rows it sent — M11-06.**
   *
   * Every figure on the board's context strip is now a door: click it and the board narrows to
   * the rows it counted. That promise is only worth making if the two are **one set**, and this
   * project has already paid for the alternative twice — `setHours`/`setUTCHours`, and Phase 0a
   * moving `summary.unacknowledged` while leaving the row attribute its own filter reads.
   *
   * So the predicate lives in `toRow` and the summary counts the marked rows. These tests pin
   * that shape rather than the arithmetic: written the old way — one expression over `live`,
   * another over `rows` — the two agree exactly until somebody changes one of them, which is
   * not a property, it is a coincidence with a good track record.
   */
  describe('the summary counts the rows it sent (M11-06)', () => {
    it('every figure equals the rows carrying its flag', async () => {
      const { summary, incidents } = (await board(controlRoomToken)).body;

      expect(summary.unacknowledged).toBe(incidents.filter((r) => r.unacknowledged).length);
      expect(summary.unassessed).toBe(incidents.filter((r) => r.unassessed).length);
      expect(summary.overdue).toBe(incidents.filter((r) => r.overdue).length);
      expect(summary.notificationsUnmet).toBe(incidents.filter((r) => r.notificationsUnmet).length);
      expect(summary.unassigned).toBe(incidents.filter((r) => r.unassigned).length);
    });

    it('marks a row with the rule the figure is counted by, not with a fact about the row', async () => {
      const { incidents } = (await board(controlRoomToken)).body;
      // A board with nothing on it would pass every assertion below by vacuum.
      expect(incidents.length).toBeGreaterThan(0);

      for (const r of incidents) {
        const counted = r.status !== 'closed' && r.status !== 'resolved' && !r.withdrawn;
        /**
         * The distinction the flags exist for: `acknowledged` and `assessed` are facts about the
         * incident and are true of a closed one too, while these are *"are you one of the ones
         * the district's figure is about"*. A screen filtering on the first kind under a figure
         * counted the second way is the defect, not a rounding difference.
         */
        expect(r.unacknowledged, r.incidentId).toBe(
          counted && !r.general && r.acknowledgedAt === null,
        );
        expect(r.unassessed, r.incidentId).toBe(counted && !r.general && !r.assessed);
      }
    });
  });

  /**
   * **The board is ordered on the server — M11-11.**
   *
   * ⚠️ A comparator in the browser would be a second ordering rule beside `compareRows`, and the
   * drift would be specific: `attentionRank` puts an **unassessed** report just above `critical`
   * because it could be anything (ADR-0009), and a client sorting on the row's own severity word
   * would bury it at the bottom under a heading claiming to be sorted by severity.
   */
  describe('ordering (M11-11)', () => {
    async function sorted(sort: string): Promise<{ status: number; body: Board }> {
      const res = await fetch(`${base}/incidents?sort=${sort}`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      });
      return { status: res.status, body: (await res.json()) as Board };
    }

    it('leaves the queue order alone when nothing asks for one', async () => {
      const plain = (await board(controlRoomToken)).body.incidents.map((r) => r.incidentId);
      const asked = (await sorted('attention')).body.incidents.map((r) => r.incidentId);
      expect(asked).toEqual(plain);
    });

    it('orders by age, oldest first, and reverses', async () => {
      const up = (await sorted('age')).body.incidents;
      expect(up.length).toBeGreaterThan(1);
      // Non-decreasing. Asserted as a property of the whole list rather than on two rows, so a
      // comparator that happens to get the first pair right cannot pass.
      for (let i = 1; i < up.length; i += 1) {
        expect((up[i - 1]!.occurredAt ?? '9999') <= (up[i]!.occurredAt ?? '9999')).toBe(true);
      }

      const down = (await sorted('-age')).body.incidents;
      for (let i = 1; i < down.length; i += 1) {
        expect((down[i - 1]!.occurredAt ?? '') >= (down[i]!.occurredAt ?? '')).toBe(true);
      }
    });

    /**
     * 🔴 **The comparator must return 0 for equal values, and the first version did not.**
     *
     * It was written `a < b ? -1 : 1`, copied from `compareRows`'s last line where that shape is
     * right because it is the *final* total tie-break. As a **primary** comparator it never
     * returns 0 — so the `compareRows` fallback was unreachable, and `cmp(a,b)` and `cmp(b,a)`
     * were both `1` for equal rows, which lets `Array.sort` return whatever it likes. The board
     * came back in no particular order with **`AGE ↑` printed above it**.
     *
     * This test pins the fallback rather than the arrows: incidents reported inside the same
     * second share an `occurredAt`, and among them the queue's own order must survive — worst
     * first, which is what `compareRows` says and what an operator scanning a column of equal
     * ages still needs.
     */
    it('orders by when the incident reached the record, and reverses', async () => {
      const up = (await sorted('recorded')).body.incidents;
      expect(up.length).toBeGreaterThan(1);
      for (let i = 1; i < up.length; i += 1) {
        expect((up[i - 1]!.arrivedAt ?? '9999') <= (up[i]!.arrivedAt ?? '9999')).toBe(true);
      }
      // `-recorded` is what the Record opens on: most recently entered first.
      const down = (await sorted('-recorded')).body.incidents;
      for (let i = 1; i < down.length; i += 1) {
        expect((down[i - 1]!.arrivedAt ?? '') >= (down[i]!.arrivedAt ?? '')).toBe(true);
      }
    });

    it('breaks a tie with the queue order, so equal rows are not shuffled', async () => {
      const rows = (await sorted('age')).body.incidents;
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1]!;
        const here = rows[i]!;
        if ((prev.occurredAt ?? '') !== (here.occurredAt ?? '')) continue;
        // Same instant: unanswered work before answered work, exactly as the queue orders it.
        const prevAck = prev.acknowledgedAt === null ? 0 : 1;
        const hereAck = here.acknowledgedAt === null ? 0 : 1;
        expect(prevAck).toBeLessThanOrEqual(hereAck);
      }
    });

    it('keeps an unassessed report above critical when ordering by severity', async () => {
      const rows = (await sorted('severity')).body.incidents;
      const firstUnassessed = rows.findIndex((r) => !r.assessed && !r.general);
      const lastCritical = rows.map((r) => r.severity).lastIndexOf('critical');
      if (firstUnassessed >= 0 && lastCritical >= 0) {
        /**
         * ADR-0009's rule, carried into the sort: `critical` outranks `unassessed`, and
         * `unassessed` outranks everything else — because a report nobody has looked at could be
         * worse than the `high` beneath it. This is the assertion a browser-side comparator
         * would fail, and it is the reason the sort is here at all.
         */
        expect(firstUnassessed).toBeGreaterThan(lastCritical);
      }
    });

    /**
     * A 400, not a quiet fall back to the queue's order — the same rule `?date=` follows, and
     * for a sharper reason: a board in the wrong **order** with a column header claiming
     * otherwise is easier to read straight past than a board showing the wrong day.
     */
    it('refuses an order it does not offer', async () => {
      const bad = await sorted('whatever');
      expect(bad.status).toBe(400);
      const res = await fetch(`${base}/incidents?sort=whatever`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      });
      expect((await res.json())['error']).toMatch(/sort must be one of/);
    });
  });

  /**
   * **The Record's own view — `?open=1` — is every record, newest first** (2026-09-06).
   *
   * It began as *what is still open, any day*, and dropping the finished rows put a stale
   * still-open case at the head of the list while the newest thing that happened — resolved by
   * lunchtime — was off-screen. So it folds open and closed alike now; `open` is a historical
   * param name for this whole-record view. The day views are untouched — they stay live-work
   * only, and `?closed=1` is still how a day asks for finished rows.
   */
  describe("the Record's own view carries closed rows (2026-09-06)", () => {
    async function wholeRecord(): Promise<Board> {
      const res = await fetch(`${base}/incidents?open=1&sort=-recorded`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Board;
    }

    it('shows a resolved incident that the day board would have dropped', async () => {
      const id = await incident(rescueDept, 'low');
      await post(`/incidents/${id}/acknowledge`, controlRoomToken, {});
      await post(`/incidents/${id}/resolve`, controlRoomToken, { outcome: 'cleared' });
      await post(`/incidents/${id}/close`, controlRoomToken, { notes: 'done' });

      // Gone from today's working board...
      expect(rowFor((await board(controlRoomToken)).body, id)).toBeUndefined();
      // ...and present on the Record's own view, which is the whole point.
      const row = rowFor(await wholeRecord(), id);
      expect(row).toBeDefined();
      expect(row?.status).toBe('closed');
    });

    it('names itself as not a day', async () => {
      expect((await wholeRecord()).date).toBeNull();
    });

    it('orders newest entered first, closed rows included', async () => {
      await incident(rescueDept, 'high');
      const later = await incident(rescueDept, 'low');
      await post(`/incidents/${later}/acknowledge`, controlRoomToken, {});
      await post(`/incidents/${later}/resolve`, controlRoomToken, { outcome: 'cleared' });

      const rows = (await wholeRecord()).incidents;
      expect(rows.length).toBeGreaterThan(1);
      // Non-increasing arrival time — a closed row sorts by when it arrived, like any other.
      for (let i = 1; i < rows.length; i += 1) {
        expect((rows[i - 1]!.arrivedAt ?? '') >= (rows[i]!.arrivedAt ?? '')).toBe(true);
      }
    });
  });

  /**
   * The facets are folded from the rows that were sent — M11-16.
   *
   * ## The property, and why it is asserted this way
   *
   * Every one of these tests re-applies the facet's **own** `attr`/`value`/`match` against
   * `body.incidents` and demands the same number back. That is deliberate: it is the closest a
   * test can get to the guarantee the shape is making, which is that a browser holding no
   * predicate of its own can read the attribute the facet names and land on exactly `count`
   * rows. A test that asserted `facets.severity[0].count === 3` against a hand-counted 3 would
   * pass just as happily if the facet named the wrong attribute — which is the failure mode,
   * not the arithmetic.
   *
   * This is the same property `districtKeys.e2e.test.ts` asserts through a browser, checked
   * here where it is cheap, one layer below.
   */
  describe('the facets it can be narrowed by', () => {
    /** Apply a facet exactly as a client must: read the attribute it names, compare as told. */
    function applied(b: Board, f: { attr: string; value: string; match: 'is' | 'has' }): number {
      return b.incidents.filter((row) => {
        const r = row as unknown as Record<string, unknown>;
        if (f.attr === 'departments') {
          return (row.responsibleDepartments as readonly string[]).includes(f.value);
        }
        if (f.attr === 'unassessed') return String(r['unassessed'] === true) === f.value;
        return String(r[f.attr] ?? '') === f.value;
      }).length;
    }

    it('counts every facet over the rows it sent, and nothing else', async () => {
      await incident(rescueDept, 'critical');
      await incident(rescueDept, 'low');
      await incident(rescueDept);

      const { body } = await board(controlRoomToken);
      const groups = [
        ...body.facets.severity,
        ...body.facets.kind,
        ...body.facets.stage,
        body.facets.unassessed,
      ];

      expect(groups.length).toBeGreaterThan(0);
      for (const f of groups) {
        expect({ facet: f.label, count: f.count }).toEqual({
          facet: f.label,
          count: applied(body, f),
        });
      }
    });

    /**
     * ⚠️ **ADR-0009, as a shape rather than a sentence.**
     *
     * *Nobody has assessed this* is not a mild severity. If it ever appears **among** the
     * severity bands, a panel sorted by rank puts it between `low` and `moderate`, and the
     * district reads "somebody looked at this and said it was smallish" off a row nobody
     * looked at. It is a sibling field precisely so that cannot be written by accident.
     */
    it('never counts an unassessed incident as a severity', async () => {
      await incident(rescueDept);

      const { body } = await board(controlRoomToken);

      expect(body.facets.severity.map((f) => f.value)).toEqual([
        'critical',
        'high',
        'moderate',
        'low',
      ]);
      expect(body.facets.unassessed.count).toBeGreaterThan(0);
      // Every severity band counts only rows somebody actually assessed.
      for (const f of body.facets.severity) {
        expect(body.incidents.filter((r) => r.severity === f.value && !r.assessed).length).toBe(0);
      }
    });

    /**
     * Worst first, and never by size.
     *
     * INV-04 applied to a list: ordering by count puts `critical 1` under `low 30` on the one
     * screen whose job is to make the critical one impossible to miss.
     */
    it('orders severity by rank, not by how many there are', async () => {
      await incident(rescueDept, 'low');
      await incident(rescueDept, 'low');
      await incident(rescueDept, 'critical');

      const { body } = await board(controlRoomToken);
      expect(body.facets.severity[0]?.value).toBe('critical');
    });

    /**
     * ⚠️ **THIS COUNTED A SHARED INCIDENT UNDER BOTH ITS DEPARTMENTS UNTIL ADR-0030.**
     *
     * That was the one facet with `match: 'has'`, and the point of it was that department
     * counts do **not** sum to the board — both departments really do have it — which the panel
     * has to say out loud rather than leave somebody to discover by adding them up.
     *
     * There are no departments to share an incident between now, and a department id that
     * nobody can name is dropped rather than printed, so `responsibleDepartments` is empty on
     * every row and this facet group can never have one. That is not a hole left behind: an
     * open set draws no zeros (ADR-0005), so the group simply does not appear on the screen.
     *
     * 🔴 **What is asserted instead is the thing that would go wrong.** Restore the `?? id`
     * fallback anywhere in this chain and every historical id floods straight back into this
     * facet as thirty-six characters of hexadecimal — a filter chip on the district's own
     * Record, labelled with a uuid, on the screen ADR-0027 exists to have cleaned. This fails
     * the moment that happens.
     */
    it('has no department facet at all — ADR-0031, phase 4', async () => {
      const created = await post('/incidents', controlRoomToken, {
        category: 'fire',
        severity: 'high',
      });
      const id = created['incidentId'] as string;
      await post(`/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [rescueDept, policeDept],
        reason: 'the historical shape of the record',
      });

      const { body } = await board(controlRoomToken);
      expect(rowFor(body, id)?.responsibleDepartments).toEqual([]);
      // The word does not narrow the board. There is no `department` key on `facets`, and a
      // routed incident (some other install's log) produces no facet chip to be labelled with
      // a uuid — the failure `?? id` used to reintroduce.
      expect(Object.keys(body.facets).sort()).toEqual(['kind', 'severity', 'stage', 'unassessed']);
    });

    /**
     * A fixed vocabulary keeps its zeros; an open set does not.
     *
     * ADR-0005: on a board somebody reads at 02:00, *"critical 0"* and the absence of the word
     * *critical* are two different statements. A department that has nothing today is not
     * making a statement — it is a directory entry, and the console is where the directory is.
     */
    it('keeps the fixed vocabularies whole and lists only the kinds present', async () => {
      const { body } = await board(controlRoomToken);

      expect(body.facets.severity).toHaveLength(4);
      // Three now, not four — `acknowledged` stopped being a stage 2026-09-04, see
      // `domain/stages.ts`'s header.
      expect(body.facets.stage.map((f) => f.value)).toEqual(['issued', 'responded', 'resolved']);
      for (const f of body.facets.kind) expect(f.count).toBeGreaterThan(0);
    });
  });
});
