/**
 * The central board on a real screen — M0-33.
 *
 * `api/__tests__/board.test.ts` proves the projection. This proves the three things that
 * only exist once something renders it, and that a JSON test cannot see:
 *
 *   1. An unassessed report is spelled out as **unassessed**, in words. Not shown as a
 *      severity level, and not distinguished by colour alone (INV-04, ADR-0009).
 *   2. When the board cannot reach the server it says so, loudly, instead of continuing to
 *      display its last good data as though it were live (INV-02). This is the failure mode
 *      that ends with nobody being sent, because the screen said someone already was.
 *   3. The board is behind a sign-in, and intake is not (INV-01).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('M0-33: the central board', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /**
   * The officer this board's incidents are handed to. **Not the seat driving the browser.**
   *
   * ⚠️ **THE BROWSER SIGNS IN AS THE CONTROL ROOM SINCE ADR-0030, AND THAT IS WHO USES THIS
   * SCREEN.** It drove as a station officer, which worked while a department could hold an
   * emergency: routing to that officer's department put the row on their board. Migration 0039
   * left `seat.department_id` behind, so `evaluateRead` refuses a non-administrative seat every
   * routed incident and the board came up **empty** — twenty-nine tests timing out waiting for a
   * row, on the screen the district lives in. Nobody outside the control room signs in anyway
   * (ADR-0024), so the browser is now the reader this screen actually has.
   */
  let actor: TestActor;
  /** District tier: the seat driving the browser, and the only one that can route or dispatch. */
  let controlRoom: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Every screen this suite drives, made available first — ADR-0016, M6-45. A fresh
    // installation offers the control room and nothing else, so a test asserting a screen
    // works has to turn it on, and this is the visible act of doing so.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Board Test Duty Officer' });
    controlRoom = await seedActor(pool, { title: 'Board Test Control Room', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', controlRoom.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * An incident, genuinely routed to this officer's department.
   *
   * The routing goes through a **district-tier** seat, and the result is asserted. An
   * earlier version did both from the page — as the signed-in station officer, who has no
   * authority to route — so every call returned 403 and was thrown away. The board tests
   * still passed, because an *unrouted* incident is readable by everyone (that is
   * deliberate: an emergency nobody may see is an emergency nobody picks up). So "lists
   * live incidents scoped to the seat" was green while proving nothing about scoping.
   *
   * A test helper that ignores a status code is a test that grades its own homework.
   */
  async function seedIncident(severity?: string): Promise<string> {
    const created = await page.evaluate(async (sev: string | undefined) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', ...(sev === undefined ? {} : { severity: sev }) }),
      });
      return (await res.json()) as { incidentId: string };
    }, severity);

    /**
     * ⚠️ **DISPATCHED TO A POST, NOT ROUTED AT A DEPARTMENT — ADR-0030.**
     *
     * This routed to `actor.departmentId`, which is now an id naming nothing: `seedDepartment`
     * is a no-op returning a fresh uuid. The call still answered 200 and the fold still called
     * the incident *routed*, so the fixture looked healthy while writing a `routed` event
     * naming a department that does not exist — the very thing that put raw uuids on three
     * screens. A dispatch is what places an emergency with somebody now, and it is what the
     * rows below are about.
     */
    const told = await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({
        targets: [{ kind: 'post', id: actor.seatId }],
        reason: 'board e2e',
      }),
    });
    expect(told.status).toBe(200);

    return created.incidentId;
  }

  async function openBoard(): Promise<void> {
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#boardRows .row').length > 0, {
      timeout: 15_000,
    });
  }

  it('says when the Record is incomplete instead of presenting a working-limited queue as whole', async () => {
    await seedIncident('high');
    // `?open=1` now carries the Record's opening order (`&sort=-recorded`, 2026-09-06), so the
    // glob has to allow a query tail after it.
    await page.route('**/incidents?open=1*', async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, body: JSON.stringify({ ...data, truncated: true }) });
    });

    try {
      await openBoard();
      await page.waitForSelector('#boardTruncated:not([hidden])');
      expect(await page.locator('#boardTruncated').textContent()).toContain('may omit older rows');
    } finally {
      await page.unroute('**/incidents?open=1*');
    }
  });

  /**
   * **The row counts who was told, and the count opens the names without leaving the board** —
   * 2026-08-23, the district's own request; the count replaced `+N` on 2026-08-24 at theirs.
   *
   * ⚠️ **The assertion that earns this test is the last one: the board is still on screen.**
   * Everything else here could be checked from the API. What could not is the interaction risk
   * this feature is built on top of — `#boardRows` opens an incident when a row is clicked, and
   * this button lives *inside* a row. A count that fell through to the row handler would take the
   * operator to the detail screen, which is the exact opposite of the thing that was asked for.
   * That is a real-browser fact and it belongs in a real browser.
   */
  it('2. counts who was told, and the count opens the names without leaving the board', async () => {
    /**
     * ⚠️ **Three named PEOPLE, inserted directly — and every word of that is load-bearing.**
     *
     * **People, not posts.** Dispatching to a post makes that post's department answer for the
     * incident, so `responsibleDepartments` fills in and the row shows departments — the branch
     * this test is about never runs. A named officer with no department answering is precisely
     * the row that used to read *"told directly"* and name nobody.
     *
     * **Inserted rather than seeded.** `seedActor` signs each actor in, and `login` burns a
     * scrypt slot: three extra logins in the middle of this suite tripped the throttle and turned
     * every later request in the file into a 401 — the sign-in this test never needed was
     * breaking the twelve tests after it. Nothing here wants a session, and the hash below is a
     * placeholder because nobody ever authenticates as these three.
     */
    const names = ['Told One', 'Told Two', 'Told Three'];
    const told = await Promise.all(
      names.map(async (full) => {
        const res = await pool.query<{ person_id: string }>(
          `INSERT INTO person (full_name, phone, password_hash)
           VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
          [
            full,
            `+92300${Math.floor(Math.random() * 9e9)
              .toString()
              .padStart(10, '0')}`,
          ],
        );
        return { personId: res.rows[0]?.person_id ?? '' };
      }),
    );

    // Reported and dispatched to three PEOPLE, and deliberately never routed to a department —
    // this is the row that used to read "told directly" and name nobody.
    const created = await page.evaluate(async () => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', severity: 'high' }),
      });
      return (await res.json()) as { incidentId: string };
    });

    const sent = await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({ targets: told.map((t) => ({ kind: 'person', id: t.personId })) }),
    });
    expect(sent.status).toBe(200);

    await openBoard();
    const row = `#boardRows .row[data-incident="${created.incidentId}"]`;
    await page.waitForSelector(`${row} .toldmore`, { timeout: 15_000 });

    /**
     * Three of three would not fit the column, so the **count** carries it alone — the district's
     * own words on 2026-08-24 were *"just number ho"*. This asserted `+2` until then, which was
     * one name out of three and read as though that officer held the incident.
     */
    expect(await page.textContent(`${row} .toldmore`)).toBe('3 told');
    expect(await page.isVisible(`${row} .rowmore`)).toBe(false);

    await page.click(`${row} .toldmore`);

    // ⚠️ 15s like every other wait in this file. At 5s this was the one red in a full run and
    // green on its own — a disclosure opening is not what the test is about, and a timeout tight
    // enough to fail on a loaded machine reports a defect that is not there.
    await page.waitForSelector(`${row} .rowmore`, { state: 'visible', timeout: 15_000 });
    const all = (await page.textContent(`${row} .toldall`)) ?? '';
    for (const full of names) expect(all).toContain(full);

    /**
     * ⚠️ **And it stays open through a refresh — 2026-10-02.** The board redraws every ten
     * seconds, and every redraw used to put back a closed row: the names vanished while the
     * operator was reading them. This test was "flaky" for exactly that reason — red whenever a
     * poll landed between the click above and the check after it. Waited for, not slept for.
     */
    await page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/incidents',
      { timeout: 15_000 },
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(await page.isVisible(`${row} .rowmore`)).toBe(true);
    expect(await page.getAttribute(`${row} .toldmore`, 'aria-expanded')).toBe('true');

    // A real change redraws the row (the count moves to 4); it must come back open too.
    const fourth = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ('Told Four', $1, 'not-a-login') RETURNING person_id`,
      [
        `+92300${Math.floor(Math.random() * 9e9)
          .toString()
          .padStart(10, '0')}`,
      ],
    );
    const again = await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({ targets: [{ kind: 'person', id: fourth.rows[0]!.person_id }] }),
    });
    expect(again.status).toBe(200);
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent === '4 told',
      `${row} .toldmore`,
      { timeout: 15_000 },
    );
    expect(await page.isVisible(`${row} .rowmore`)).toBe(true);
    expect(await page.textContent(`${row} .toldall`)).toContain('Told Four');

    // The whole point: still on the board, not on the incident.
    expect(await page.isVisible('#boardView')).toBe(true);
    expect(await page.isVisible('#detailView')).toBe(false);

    /**
     * **And what we sent is on the FACE of the row — the district asked for it 2026-08-24.**
     *
     * It was inside the disclosure above until they asked a second time, which is the answer:
     * *"msg mein kya tha"* is not something somebody goes looking for, it is what the row is
     * about, and nobody presses forty buttons to read forty messages.
     *
     * 🔴 **Nothing was sent here and the line still appears**, which is the case that matters:
     * this environment has no WhatsApp account (R-05), so no `message_sent` exists — and the row
     * says **not recorded** rather than drawing a blank. Absence means UNKNOWN and never
     * *nothing was sent* (ADR-0026); the `notified` events beside it say something was.
     */
    expect(await page.isVisible(`${row} .rowsaid`)).toBe(true);
    expect(await page.textContent(`${row} .rowsaid`)).toBe('We sent: not recorded');
    expect(await page.getAttribute(`${row} .rowsaid`, 'class')).toContain('none');
  });

  /**
   * **The line is withheld where it would be a sentence about a message that never existed.**
   *
   * *"We sent: not recorded"* under every row nobody has been chosen for is forty sentences
   * about nothing, on the screen this project has twice had noise removed from. `toldNames` is
   * the only field that separates *nobody was told* from *we cannot name who was*, and it is the
   * server's own — the same value `no one chosen` is drawn from two columns to the left.
   */
  it('2b. says nothing about a message on a row nobody was told about', async () => {
    const created = await page.evaluate(async () => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'other', severity: 'low' }),
      });
      return (await res.json()) as { incidentId: string };
    });

    await openBoard();
    const row = `#boardRows .row[data-incident="${created.incidentId}"]`;
    await page.waitForSelector(row, { timeout: 15_000 });

    expect(await page.textContent(`${row} .who`)).toBe('no one chosen');
    expect(await page.locator(`${row} .rowsaid`).count()).toBe(0);
  });

  it('1. is offered only once signed in, unlike intake', async () => {
    // Intake is never behind a sign-in — an emergency captured by a signed-out officer is
    // still an emergency (INV-01). The board needs a seat to scope it, so it is.
    expect(await page.isVisible('#nav')).toBe(true);

    /**
     * This click is the M4 landing rule, and it is worth stating rather than hiding.
     *
     * On a screen wide enough for a desk — which is what a headless Chromium is — signing in
     * now lands on the dashboard, because somebody at a desk opened the app to find out what
     * is happening. On a phone it still lands on the report form, because that person is
     * standing at a scene.
     *
     * What INV-01 protects is untouched and is asserted where it belongs: signed **out**, the
     * form is on screen with nothing in front of it. Here the officer is signed in, and the
     * form being one tab away is the intended behaviour, not a regression.
     */
    await page.click('#navReport');
    expect(await page.isVisible('#report')).toBe(true);
  });

  it('2. lists live incidents scoped to the seat', async () => {
    const id = await seedIncident('high');
    await openBoard();
    expect(await page.isVisible(`.row[data-incident="${id}"]`)).toBe(true);
  });

  it('3. spells out "unassessed" instead of showing a severity nobody chose', async () => {
    const id = await seedIncident();
    await page.click('#navReport');
    await openBoard();

    const row = page.locator(`.row[data-incident="${id}"] .sev`);
    // The word, not the colour. A colour-blind operator, a photocopied screen and a
    // screen reader all have to get the same answer (INV-04).
    expect((await row.textContent())?.trim()).toBe('unassessed');
    expect(await row.getAttribute('data-level')).toBe('unknown');
  });

  it('4. reports the unassessed count separately from the worst assessed severity', async () => {
    const text = (await page.textContent('#boardSummary')) ?? '';
    expect(text).toContain('not yet assessed');
    expect(text).toContain('worst assessed');
  });

  it('5. says it is live, and when', async () => {
    const asOf = (await page.textContent('#boardAsOfText')) ?? '';
    expect(asOf).toMatch(/^Live as of /);
    expect(await page.getAttribute('#boardAsOf', 'data-stale')).toBe('false');
  });

  it('6. stops claiming to be live the moment it cannot reach the server (INV-02)', async () => {
    // The failure this test exists for: a board that keeps showing its last good data
    // during an outage, unlabelled, is worse than a blank screen — an operator decides not
    // to send a crew because the screen says a crew is already going.
    await context.setOffline(true);

    await page.evaluate(async () => {
      const dnc = (
        globalThis as unknown as {
          __dnc: { refreshBoard(): Promise<void>; backdateBoard(ms: number): void };
        }
      ).__dnc;
      await dnc.refreshBoard();
      // The clock is time-based; drive it rather than sitting for thirty real seconds.
      dnc.backdateBoard(45_000);
    });

    await page.waitForFunction(
      () => document.getElementById('boardAsOf')?.dataset['stale'] === 'true',
      { timeout: 15_000 },
    );

    const warning = (await page.textContent('#boardAsOfText')) ?? '';
    expect(warning).toContain('NOT LIVE');
    expect(warning).toMatch(/Do not act on this without checking/);

    await context.setOffline(false);
  }, 60_000);

  it('7. keeps the rows on screen while offline rather than blanking them', async () => {
    // Deliberate: the last known picture is still useful to somebody standing in a control
    // room during an outage. It is the *unlabelled* version that is dangerous, and test 6
    // is what stops that.
    expect(await page.locator('#boardRows .row').count()).toBeGreaterThan(0);
  });

  /**
   * **Steps 8, 9 and 10 were the seat inbox, and they are gone with it (ADR-0018, 2026-08-06).**
   *
   * They drove `#navInbox`, clicked `.inbox-row .seen`, and proved the rule that mattered
   * about it: rendering a message is not delivering it, and delivery is recorded only when a
   * human says they have seen it. That rule is not repealed — it moved. **Nobody outside the
   * control room signs in now**, so there is no screen for an officer to open and the
   * deliberate act that meets an obligation is a WhatsApp acknowledgement or an operator
   * recording what they were told on the telephone. `whatsappLoop.test.ts` holds the first,
   * and M7-05 the second.
   *
   * The step numbers are left with the gap rather than closed up. They are cited in CLAUDE.md
   * and in the changelog, and renumbering would silently repoint every one of those references
   * at a different test — the same reason `for-the-district.md` never reuses an R-number.
   */
  /**
   * **11. Was *"names the department instead of saying 'your department'"* — ADR-0030.**
   *
   * The claim was that the board must not fall back to a placeholder where a name belongs. That
   * claim is **kept**; what changed is that there is no name to fall back to. `departmentName`
   * is null for every non-district seat for ever, so *"your department"* stopped being a
   * placeholder for a missing name and became the permanent label — **a board headed with a
   * scope its reader does not have.** It says what the board actually holds now.
   *
   * ⚠️ **A separate context, because the browser is the CONTROL ROOM now.** The half this test
   * exists for is the non-district one, and the suite's own session is district-tier — asserting
   * it on `page` would silently assert the other branch and pass for the wrong reason, which is
   * exactly how the original fault survived test 14 for as long as it did.
   */
  it('11. tells a seat with no district authority what its board actually holds', async () => {
    const officerContext = await browser.newContext();
    try {
      const officerPage = await officerContext.newPage();
      await officerPage.goto(origin);
      await officerPage.waitForSelector('#login');
      await officerPage.fill('#phone', actor.phone);
      await officerPage.fill('#password', TEST_PASSWORD);
      await officerPage.click('#loginSubmit');
      await officerPage.waitForSelector('#nav:not([hidden])');

      await officerPage.click('#navBoard');
      await officerPage.waitForSelector('#boardView:not([hidden])');
      await officerPage.waitForFunction(
        () => (document.getElementById('boardScope')?.textContent ?? '').length > 0,
        { timeout: 15_000 },
      );

      const scope = await officerPage.textContent('#boardScope');
      expect(scope).toBe('what you were told about');
      // The original claim, kept literally: never a placeholder standing in for a real name.
      expect(scope).not.toBe('your department');
    } finally {
      await officerContext.close();
    }
  });

  it('12. keeps the severity word where it is when a row goes overdue', async () => {
    /**
     * A layout defect that shipped, and that nothing here could see — 2026-08-14.
     *
     * `incidentRow.ts` adds `flag` to the state sentence once an emergency is past its deadline,
     * and adds `flag unmet` to the separate line about nobody being reachable. One `.row .flag`
     * rule carried `grid-column: 1 / -1` for both — correct for the second, wrong for the first.
     * On an overdue row the state spanned the whole of row 1, where `.sev` already sat, and the
     * severity word was pushed into an implicit third column: **x=89 on an ordinary row, x=1138
     * on an overdue one**, same viewport.
     *
     * So the one word INV-04 relies on to carry meaning moved to the far side of the card on
     * exactly the rows an operator scans for. Nothing overlapped and nothing errored, which is
     * why eleven board tests and a contrast pass over eight screens all stayed green.
     *
     * The class is applied here rather than by waiting out a real deadline: what broke is the
     * **styling contract for that class**, and the renderer's decision to apply it is already
     * covered where that decision is made.
     */
    const id = await seedIncident('critical');
    await openBoard();
    await page.waitForSelector(`.row[data-incident="${id}"]`);

    const boxes = await page.evaluate((incident: string) => {
      const row = document.querySelector(`.row[data-incident="${incident}"]`);
      if (row === null) return null;
      row.querySelector('.state')?.classList.add('flag');
      const at = (sel: string) => {
        const el = row.querySelector(sel);
        return el === null ? null : el.getBoundingClientRect();
      };
      const sev = at('.sev');
      const state = at('.state');
      const card = row.getBoundingClientRect();
      return sev === null || state === null
        ? null
        : { sevX: sev.x, stateX: state.x, cardX: card.x, cardRight: card.right };
    }, id);

    expect(boxes, 'the row or its parts were not found').not.toBeNull();
    // The severity reads first, on the left of its own card, exactly as on every other row.
    expect(boxes!.sevX).toBeLessThan(boxes!.stateX);
    // And it is still inside the card rather than in a column the grid invented.
    expect(boxes!.sevX).toBeLessThan(boxes!.cardRight);
  });

  it('13. an acknowledged emergency that is still overdue does not read as calm', async () => {
    /**
     * The board was made quieter rather than louder on 2026-08-14: a row somebody has answered
     * recedes to `--card2`, so the ones nobody has answered stand out without anything having to
     * shout. That is only safe while **late outranks answered**.
     *
     * An emergency can be both. Acknowledged means a human took it; overdue means they took it
     * and the deadline passed anyway — which is exactly the row a control room has to chase, and
     * the one it would stop seeing if "answered" won. The rule expresses that with a `:not()`
     * chain, and a chain is precisely what a later tidy-up shortens.
     *
     * Read as a computed background rather than as a class list: what matters is what an operator
     * sees, and either the ground is the overdue one or it is not.
     */
    const id = await seedIncident('critical');
    await openBoard();
    await page.waitForSelector(`.row[data-incident="${id}"]`);

    const grounds = await page.evaluate((incident: string) => {
      const row = document.querySelector(`.row[data-incident="${incident}"]`);
      if (row === null) return null;

      /**
       * Drop M8's arrival flash first, or this measures the wrong thing entirely.
       *
       * A row that has just appeared carries `entering`, whose keyframes paint `--primary-wash`
       * over whatever ground the state would give it. The first version of this test read
       * `rgba(91, 63, 214, 0.12)` for every case and failed comparing it with itself. That
       * flash is correct behaviour — it is how the board says *look here* — and it is simply
       * not the thing under test.
       */
      row.classList.remove('entering', 'updated');

      const read = () =>
        getComputedStyle(row).backgroundImage + ' | ' + getComputedStyle(row).backgroundColor;

      row.setAttribute('data-acknowledged', 'true');
      row.setAttribute('data-overdue', 'false');
      const answered = read();

      row.setAttribute('data-overdue', 'true');
      const answeredButLate = read();

      row.setAttribute('data-acknowledged', 'false');
      const late = read();

      return { answered, answeredButLate, late };
    }, id);

    expect(grounds, 'the row was not found').not.toBeNull();
    // Answered and on time is the quiet one, and it is genuinely different from the rest.
    expect(grounds!.answered).not.toBe(grounds!.late);
    // Answered but late is still late. This is the assertion the `:not()` chain exists for.
    expect(grounds!.answeredButLate).toBe(grounds!.late);
  });

  /**
   * **13b. A meeting notice's row reads the attendance tally, not a single reply — Case 2.**
   *
   * A meeting has no owner and no "holding". The row's Response column shows who is coming —
   * `N of M coming · X attending · Y sending someone · Z silent` — rather than the last reply
   * text or the generic *answered* / *sent · no answer needed*.
   */
  it('13b. shows who is coming on a meeting notice row', async () => {
    const seat = async (title: string): Promise<string> => {
      const row = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'station', false, false) RETURNING seat_id`,
        [title],
      );
      return row.rows[0]!.seat_id;
    };
    const token = controlRoom.token;
    const a = await seat(`Tehsildar Row A ${Date.now()}`);
    const b = await seat(`Tehsildar Row B ${Date.now()}`);
    const c = await seat(`Tehsildar Row C ${Date.now()}`);

    const created = (await (
      await fetch(`${origin}/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind: 'meeting', details: { subject: 'Row attendance meeting' } }),
      })
    ).json()) as { incidentId: string };
    await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        targets: [a, b, c].map((id) => ({ kind: 'post', id })),
        reason: 'board e2e',
      }),
    });

    const detail = (await (
      await fetch(`${origin}/incidents/${created.incidentId}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
    const reply = async (seatId: string, said: string): Promise<void> => {
      const attemptId = detail.state.notifications.find((n) => n.seatId === seatId)?.attemptId;
      await fetch(`${origin}/incidents/${created.incidentId}/acknowledged-by`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ attemptId, outcome: 'confirmed', said }),
      });
    };
    await reply(a, 'Attending');
    await reply(b, 'Sending someone');
    // c stays silent

    await openBoard();
    await page.waitForSelector(`.row[data-incident="${created.incidentId}"]`);
    const state = await page.textContent(`.row[data-incident="${created.incidentId}"] .state`);
    expect(state).toMatch(/2 of 3 coming/);
    expect(state).toMatch(/1 attending/);
    expect(state).toMatch(/1 sending someone/);
    expect(state).toMatch(/1 silent/);
  });

  /**
   * **14. A district-tier seat that holds a department still sees the district — M11-04.**
   *
   * Test 11 above is the *department* half of this and passes either way, which is why the fault
   * survived it: a station officer is labelled with their department's name whether the label
   * keys on `departmentId` or on `tier`. Only an **administrative office** separates the two —
   * it has a department id *and* district authority — and there was no test signing in as one.
   *
   * That is Bajaur's real configuration: `seedActor({ tier: 'district' })` marks the department
   * administrative precisely because migration 0010 derives the tier from the office, and AC HQ
   * Bajaur is exactly this shape. So the board carrying **every incident in the district** was
   * labelled *"Board Test Control Room's department"*, and an operator reading it would take the
   * screen for their own office's work and stop looking at the rest of Bajaur on the one surface
   * showing it to them.
   *
   * A **separate browser context**, because the session is per-context and the suite's other
   * tests depend on staying signed in as the station officer.
   */
  it('14. tells a district-tier office its board is district-wide, not its own department', async () => {
    // ⚠️ No second context any more: this suite's own session IS the district-tier office since
    // ADR-0030, and test 11 is the half that now needs one. The pair still straddles the branch.
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');
    await page.waitForFunction(
      () => (document.getElementById('boardScope')?.textContent ?? '').length > 0,
      { timeout: 15_000 },
    );

    expect(await page.textContent('#boardScope')).toBe('district-wide');
  });

  /**
   * **The context strip — M11-06…09. The figures on this screen do something now.**
   *
   * The defect these replace was not a missing feature so much as an unfinished one: `tally()`
   * returned a bare `<div>` and **nothing anywhere listened for a click on `#boardSummary`**,
   * while the *same seven numbers* on the Dashboard have drilled through to their own rows since
   * M4, using machinery (`FLAG_FILTERS` plus server-set `data-*`) that was already built and
   * proven. Seven inert figures occupied the top third of the one screen an operator works in
   * for a whole shift.
   *
   * ⚠️ **These are browser tests because nothing else can see any of it.** `board.test.ts` can
   * prove the summary and the rows are one set; it cannot prove a figure is a button, that the
   * button narrows the queue, or that a figure reading zero is inert. The board has shipped
   * three defects that only a rendered page could show, and this file's own test 12 is one.
   */
  describe('15. the context strip leads to what it counted', () => {
    /** The figure a named segment is showing, and whether it is a door. */
    async function seg(kind: string): Promise<{ value: string; clickable: boolean }> {
      return page.evaluate((k: string) => {
        const node = document.querySelector(`#boardSummary .seg[data-kind="${k}"]`);
        return {
          value: node?.querySelector('b')?.textContent ?? '',
          clickable: node?.tagName === 'BUTTON',
        };
      }, kind);
    }

    it('narrows the board to exactly the rows the figure counted', async () => {
      await seedIncident();
      await openBoard();

      const issued = await seg('issued');
      expect(issued.clickable).toBe(true);
      expect(Number(issued.value)).toBeGreaterThan(0);

      await page.click('#boardSummary .seg[data-kind="issued"]');
      await page.waitForSelector('#boardFilter:not([hidden])');
      await page.waitForTimeout(600);

      /**
       * **Membership, not a total**, for the reason `districtKeys.e2e.test.ts` records at
       * length: the local test database is shared and never cleaned, so comparing the figure to
       * a row count measures the clock between two fetches rather than the filter. Every row
       * shown carries the flag and every row hidden does not — which a filter that merely
       * narrows cannot satisfy.
       */
      const sel = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[];
        return {
          shown: rows.filter((r) => !r.hidden).length,
          // `data-stage`, the word the SERVER chose — the same value the figure was folded
          // from. Re-deriving "unanswered" from any other attribute here would be the second
          // implementation this whole table exists to refuse.
          wrongShown: rows.filter((r) => !r.hidden && r.dataset['stage'] !== 'issued').length,
          wrongHidden: rows.filter((r) => r.hidden && r.dataset['stage'] === 'issued').length,
        };
      });
      expect(sel.shown).toBeGreaterThan(0);
      expect(sel.wrongShown).toBe(0);
      expect(sel.wrongHidden).toBe(0);
    });

    /**
     * **M11-08 — the chip says how much was narrowed away, not only what was narrowed to.**
     *
     * A chip reading *"Showing only: not yet acknowledged"* is true and still lets an operator
     * read eight rows as though they were the whole of Bajaur. That is INV-02's failure arriving
     * through presentation rather than through staleness, and it is the one this screen is most
     * exposed to now that a figure can be clicked by accident.
     */
    it('says how many matched, out of how many are on the board', async () => {
      const text = (await page.textContent('#boardFilterText')) ?? '';
      // The chip names the STAGE filter now, because that is the segment it came from —
      // `FLAG_FILTERS.stageIssued`'s own words, which are the server's word for the rows.
      expect(text).toMatch(/Showing only: still to be answered — \d+ of \d+/);

      const [, matched, total] = /(\d+) of (\d+)/.exec(text) ?? [];
      expect(Number(matched)).toBeLessThanOrEqual(Number(total));

      const counted = await page.evaluate(
        () =>
          (Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[]).filter(
            (r) => !r.hidden,
          ).length,
      );
      expect(Number(matched)).toBe(counted);
    });

    it('marks where the view is standing, and clears back to the whole board', async () => {
      expect(await page.getAttribute('#boardSummary .seg[data-kind="issued"]', 'data-on')).toBe(
        'true',
      );

      await page.click('#boardSummary .seg[data-kind="open"]');
      await page.waitForTimeout(600);

      // `open` is the board itself, not a slice of it, so nothing is left hidden and the chip
      // goes — the same property `districtKeys.e2e.test.ts` requires of the counter it shares.
      expect(await page.locator('#boardFilter').isHidden()).toBe(true);
      const hidden = await page.evaluate(
        () =>
          (Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[]).filter(
            (r) => r.hidden,
          ).length,
      );
      expect(hidden).toBe(0);
      expect(await page.getAttribute('#boardSummary .seg[data-kind="open"]', 'data-on')).toBe(
        'true',
      );
    });

    /**
     * **`worst assessed` leads nowhere on purpose, and a figure reading zero leads nowhere
     * either.**
     *
     * The first is not a set — *"show me the rows that are the worst"* is not a question rows
     * can answer, and the category filter is what "show me the criticals" already means. The
     * second is this product's own standing rule: a zero that opens a board saying *"nothing
     * matches"* answers a question the figure had already answered, and teaches that these
     * numbers lead somewhere unreliable.
     */
    it('offers no door on a figure that is not a set, or one that counted nothing', async () => {
      expect((await seg('worst')).clickable || (await seg('worst-critical')).clickable).toBe(false);

      const zeros = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#boardSummary .seg'))
          .filter((n) => n.querySelector('b')?.textContent === '0')
          .map((n) => ({
            kind: (n as HTMLElement).dataset['kind'] ?? '',
            clickable: n.tagName === 'BUTTON',
          })),
      );
      for (const zero of zeros) {
        expect(zero.clickable, `"${zero.kind}" reads 0 and must not be clickable`).toBe(false);
      }
    });

    /**
     * **M11-09 kept the two questions apart; 2026-08-18 took the second one off the screen.**
     *
     * M11-09's own test asserted that `nobody told` and `nobody has it` were two segments,
     * because the strip had once carried one tile labelled with the first question and fed with
     * the second's number. That property is **stronger** now rather than weaker: the department
     * figure is not on this strip at all, so the two cannot be confused here.
     *
     * ⚠️ **The rewrite is deliberate and the old assertion is not merely deleted.** What it was
     * protecting — *this figure is about who was CHOSEN, never about which department holds it* —
     * is exactly what is asserted below, against the words the wall uses. `summary.unassigned` is
     * still sent, still on every row, and still on the console and the export.
     */
    /**
     * 🔴 **THE BANNER COUNTED THE WRONG NUMBER, AND NOTHING GUARDED IT — 2026-08-18.**
     *
     * `#boardUnassigned` is the loudest line on this screen. It says *"N that nobody has been
     * told about"* and it read **`summary.unassigned`** — the *department* question. On the live
     * record that was **31 where the honest answer was 12**, and the sentence then tells the
     * operator to go and choose who should know, about emergencies they had already chosen for.
     *
     * ⚠️ **The existing tests could not see it, and the reason is the point.** `admin.e2e` asserts
     * the banner's *wording* and M11-03 asserts its *noun* — both true on either side of this
     * fix, because only the number moved. **Asserting words never catches a figure reading the
     * wrong set.**
     *
     * This seeds the case that separates the two questions and cannot exist by accident: an
     * emergency **dispatched to a named officer** (so somebody was chosen) with **no department
     * routed** (so it is unassigned). Since M10-07/08/09 that is the ordinary shape of Bajaur's
     * traffic, which is exactly why the defect mattered.
     */
    it('counts the banner off who was chosen, never off which department holds it', async () => {
      async function seen(): Promise<{ unassigned: number; nobodyTold: number; banner: number }> {
        return page.evaluate(async () => {
          const res = await fetch('/incidents');
          const body = (await res.json()) as {
            summary: { unassigned: number; nobodyTold: number };
          };
          const node = document.getElementById('boardUnassigned');
          const text = node?.hidden === true ? '' : (node?.textContent ?? '');
          return {
            unassigned: body.summary.unassigned,
            nobodyTold: body.summary.nobodyTold,
            banner: Number(/^(\d+)/.exec(text.trim())?.[1] ?? '0'),
          };
        });
      }

      /**
       * ⚠️ **THE OLD QUESTION HAS ONLY ONE SIDE LEFT — ADR-0030, and the test is re-aimed rather
       * than deleted.**
       *
       * It proved the banner counted `nobodyTold` and **not** `unassigned`, by moving one figure
       * without the other: `seedIncident()` routed and never dispatched, so `nobodyTold` rose by
       * one while a department now held it and `unassigned` did not move. Migration 0039 makes
       * that impossible — `unassigned` is folded from `dispatchedTo` too now (see the note on
       * `IncidentState.unassigned`, which explains why: left as it was, every row in Bajaur would
       * have been painted permanently red). **The two figures are the same fold, so no fixture can
       * separate them.**
       *
       * What survives is the half an operator acts on, and it is asserted in **both directions**,
       * which the original never did: an emergency nobody has been told about is IN the banner,
       * and telling somebody takes it OUT. Restore a department-shaped count anywhere in the
       * chain and the second half fails, because a dispatch would stop moving the figure.
       */
      const before = await seen();

      const id = await page.evaluate(async () => {
        const res = await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'rta', severity: 'high' }),
        });
        return ((await res.json()) as { incidentId: string }).incidentId;
      });
      await openBoard();
      await page.waitForTimeout(600);

      const told = await seen();

      // Reported, nobody chosen: it is in the figure, and the banner moved with it.
      expect(told.nobodyTold).toBe(before.nobodyTold + 1);
      expect(told.banner).toBe(told.nobodyTold);
      expect(told.banner).toBe(before.banner + 1);

      // Now tell somebody. The banner is about who was chosen, so it must come back down.
      const sent = await fetch(`${origin}/incidents/${id}/dispatch-to`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controlRoom.token}`,
        },
        body: JSON.stringify({ targets: [{ kind: 'post', id: actor.seatId }] }),
      });
      expect(sent.status).toBe(200);

      await openBoard();
      await page.waitForTimeout(600);

      const after = await seen();
      expect(after.nobodyTold).toBe(before.nobodyTold);
      expect(after.banner).toBe(after.nobodyTold);
    });

    /**
     * **The row says it too, in the same words — 2026-08-18.**
     *
     * `incidentRow.ts` answered *who has it* with the **department** question and printed
     * *"nobody told yet"* whenever no department was responsible. On the live record that was
     * false on **19 of 40 rows** — every emergency dispatched to an officer by name.
     *
     * ⚠️ **This asserts the half that can be constructed here, and the other half is stated
     * rather than claimed.** An incident nobody was told about is one `POST /incidents` away, so
     * `no one chosen` is pinned below. The `told directly` branch needs an officer holding **no
     * department**, which this seeded directory does not have — a person dispatch here places
     * that person's own department and the row correctly shows its name. That branch is covered
     * by `api/__tests__/dashboard.test.ts`, which pins the identical three cases on the panels,
     * and it is **not** covered by a browser test. Said plainly rather than rounded up.
     */
    it('says no one chosen on a row, never the department question', async () => {
      await page.evaluate(async () => {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'other', severity: 'low' }),
        });
      });

      await openBoard();
      await page.waitForTimeout(600);

      const who = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#boardRows .row .who')).map(
          (n) => n.textContent ?? '',
        ),
      );

      expect(who).toContain('no one chosen');
      expect(who.some((w) => w.includes('nobody told yet'))).toBe(false);
    });

    it('speaks the four words, and the department figure is not among them', async () => {
      const strip = (await page.textContent('#boardSummary')) ?? '';

      // The four words and the two alarms, exactly as the deck says them.
      expect(strip).toContain('issued');
      expect(strip).toContain('no one chosen');
      expect(strip).toContain('message failed');

      // And not one word of the private language the owner could not tell apart.
      expect(strip).not.toContain('nobody has it');
      expect(strip).not.toContain('nobody told');
      expect(strip).not.toContain('nobody reached');
      expect(strip).not.toContain('unacknowledged');
    });
  });

  /**
   * **16. The strip, measured — M11-18.**
   *
   * ⚠️ **Every layout defect this project has shipped was found by asking the browser where the
   * box actually is**, and none by an assertion about text: the severity word rendering at
   * x=1138 on overdue rows (test 12 above), the `ISSUED` chip stretching a whole card, four
   * report links running together. `panels.test.ts` cannot see reflow — it renders nothing —
   * and `contrast.e2e` measures colour pairings, which were fine in all three cases.
   *
   * The strip now sits in the left sidebar (the Command Center redesign, and the owner's call
   * to keep it there rather than move it horizontal). Anything that changes its height still
   * moves the figures an operator is reading, so both claims the CSS makes about it — a clean
   * vertical stack, and no reflow when one of its own figures is chosen — are measured here.
   */
  it('16. stacks in the sidebar, and does not move when a figure is selected', async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openBoard();
    await page.click('#boardSummary .seg[data-kind="open"]');
    await page.waitForTimeout(400);

    const before = await page.evaluate(() => {
      const strip = document.getElementById('boardSummary')!;
      const segs = Array.from(strip.querySelectorAll('.seg')) as HTMLElement[];
      const tops = new Set(segs.map((s) => Math.round(s.getBoundingClientRect().top)));
      return {
        top: Math.round(strip.getBoundingClientRect().top),
        height: Math.round(strip.getBoundingClientRect().height),
        rows: tops.size,
        segments: segs.length,
      };
    });

    // ⚠️ **Seven, not eight — the department figure came off on 2026-08-18** with the deck's
    // own the day before (ADR-0018: departments are a directory, not an audience). In the
    // narrow sidebar the seven figures are a single-column vertical list — one row each, so
    // `rows === segments` — rather than the one horizontal band they were above the queue.
    // Two columns wrapped them to four ragged rows and read as broken.
    expect(before.segments).toBe(7);
    expect(before.rows).toBe(before.segments);

    await page.click('#boardSummary .seg[data-kind="issued"]');
    await page.waitForSelector('#boardFilter:not([hidden])');
    await page.waitForTimeout(600);

    const after = await page.evaluate(() => {
      const strip = document.getElementById('boardSummary')!;
      return {
        top: Math.round(strip.getBoundingClientRect().top),
        height: Math.round(strip.getBoundingClientRect().height),
        rows: new Set(
          (Array.from(strip.querySelectorAll('.seg')) as HTMLElement[]).map((s) =>
            Math.round(s.getBoundingClientRect().top),
          ),
        ).size,
      };
    });

    /**
     * **The strip does not move when one of its own figures is clicked**, and both halves of
     * that are measured because both were wrong in a first version found by photographing the
     * page.
     *
     * `height` — the selected segment is marked with an **inset** shadow and a wash, never a
     * border, so choosing one changes nothing's size.
     *
     * `top` — the applied-filter chip is drawn in the right-hand column, not over the sidebar,
     * so choosing a figure moves nothing in the strip.
     */
    expect(after.height).toBe(before.height);
    expect(after.top).toBe(before.top);
    expect(after.rows).toBe(before.segments);
  });

  /**
   * **17. The board as a table — M11-10/11/12/13.**
   *
   * The same markup as the cards, laid out by CSS at a second width (ADR-0013). What is under
   * test is the pair of things a JSON test cannot see: that the **columns line up with the
   * header**, and that clicking a header actually **reorders the rows on screen**.
   */
  describe('17. the board as a table at desk width', () => {
    async function openWide(): Promise<void> {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openBoard();
      await page.waitForSelector('#boardHead:not([hidden])');
      await page.waitForTimeout(400);
    }

    it('lines every cell up under the header it belongs to', async () => {
      await seedIncident('high');
      await seedIncident();
      await openWide();

      /**
       * ⚠️ **Measured, not asserted about.** A header drifting from its rows labels the wrong
       * column with complete confidence, and nothing errors — which is exactly the shape of the
       * three layout defects this project has already shipped from this screen. `--board-cols`
       * is declared once on `#boardTable` for precisely this reason; this checks it took.
       */
      const aligned = await page.evaluate(() => {
        const head = document.getElementById('boardHead')!;
        const row = document.querySelector('#boardRows .row') as HTMLElement | null;
        if (row === null) return null;
        const at = (sel: string, root: Element): number | null => {
          const node = root.querySelector(sel) as HTMLElement | null;
          return node === null ? null : Math.round(node.getBoundingClientRect().left);
        };
        return {
          pairs: [
            ['[data-col="sev"]', '.sev'],
            ['[data-col="cat"]', '.cat'],
            ['[data-col="stage"]', '.stage'],
            ['[data-col="who"]', '.who'],
            ['[data-col="age"]', '.age'],
            ['[data-col="state"]', '.state'],
          ].map(([h, c]) => ({ col: c, head: at(h!, head), cell: at(c!, row) })),
          rowHeight: Math.round(row.getBoundingClientRect().height),
          lineHeight: Math.round(parseFloat(getComputedStyle(row).fontSize) * 1.6),
        };
      });

      expect(aligned).not.toBeNull();
      for (const p of aligned!.pairs) {
        expect(p.head, `${p.col} header`).not.toBeNull();
        expect(p.cell, `${p.col} cell`).not.toBeNull();
        expect(Math.abs(p.head! - p.cell!), `${p.col} is under its header`).toBeLessThanOrEqual(2);
      }
      /**
       * ⚠️ **THE BOUND WAS `* 3` AND THE ROWS IT MEASURED HAD NEVER BEEN TOLD TO ANYBODY.**
       *
       * `seedIncident()` routed at a department and dispatched to nobody, so every row this
       * assertion ever saw was one with no recipient. Since ADR-0030 the fixture dispatches —
       * because that is what placing an emergency with somebody now IS — and a told row carries
       * a line the old one could not: **`We sent: …`**, which the district genuinely reads on
       * this screen. In this environment it also carries *"nothing was sent — no WhatsApp
       * account"*, which the district does **not** see (R-05) and which is why the allowance is
       * four lines rather than three and a half.
       *
       * ⚠️ **The bound stays absolute, and an equal-heights check was tried here and was WRONG.**
       * Rows are supposed to differ: one that was told carries a `We sent` line and one that was
       * not does not, so on a board holding both, a difference of about a line and a half is the
       * screen being honest. `.marks` exists to keep those marks from breaking the column grid —
       * which is what the six alignment pairs above assert — not to make every row the same
       * height. A guard that demanded equality would fail on exactly the mixed board the district
       * actually has.
       */
      // ⚠️ `* 6`, not `* 4`: the Command Center redesign gave the desk-width row a roomier
      // `1.1rem` vertical padding, so a comfortable row with a case ref, a two-line category, a
      // two-line "who" and a `We sent` line measures ~5 lines. The real failure this still catches
      // is the grid collapsing so every cell stacks — eight lines and more at desk width.
      expect(aligned!.rowHeight).toBeLessThan(aligned!.lineHeight * 6);
    });

    /**
     * 🔴 **The assertion this whole sub-suite exists for.**
     *
     * `applyBoardRows` could not reorder the board and had not been able to since M8: both of
     * its replace branches use `replaceWith`, which puts the new node exactly where the old one
     * was, and the branch that corrected position was unreachable because
     * `existing.outerHTML !== fresh.outerHTML` was always true (`existing` carried `data-sig`
     * and `fresh` did not yet). So the rows' **content** was right and their **order** was never
     * applied at all. Found by rendering the table and reading it — the header said `AGE ↑` over
     * rows plainly in the queue's order, and a direct probe of the route proved the server had
     * been right the whole time.
     */
    it('reorders the rows on screen, not merely in the response', async () => {
      await openWide();

      const ids = async (): Promise<string[]> =>
        page.evaluate(() =>
          (Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[]).map(
            (r) => r.dataset['incident'] ?? '',
          ),
        );

      const queueOrder = await ids();
      expect(queueOrder.length).toBeGreaterThan(1);

      await page.click('#boardHead button[data-sort="age"]');
      await page.waitForTimeout(700);
      const ascending = await ids();

      await page.click('#boardHead button[data-sort="age"]');
      await page.waitForTimeout(700);
      const descending = await ids();

      // The same incidents, and the DOM genuinely the other way round.
      expect([...ascending].sort()).toEqual([...descending].sort());
      expect(descending).toEqual([...ascending].reverse());
    });

    /**
     * The indicator describes **the order that arrived**, never the click. A header claiming an
     * order the rows do not have is INV-02's failure in a quieter place — and quieter is worse,
     * because nobody checks a column heading.
     */
    it('marks the sorted column, and offers the way back to the queue order', async () => {
      expect(await page.getAttribute('#boardHead button[data-sort="age"]', 'data-dir')).toBe(
        'desc',
      );
      expect(await page.getAttribute('#boardHead button[data-sort="age"]', 'aria-sort')).toBe(
        'descending',
      );
      expect(await page.getAttribute('#boardHead button[data-sort="stage"]', 'aria-sort')).toBe(
        'none',
      );
      expect(await page.locator('#boardSortReset').isVisible()).toBe(true);

      await page.click('#boardSortReset');
      await page.waitForTimeout(700);

      expect(await page.getAttribute('#boardHead button[data-sort="age"]', 'data-dir')).toBeNull();
      expect(await page.locator('#boardSortReset').isHidden()).toBe(true);
    });

    /** M11-12. CSS only: shorter rows, and not one word different. */
    it('compacts without changing anything it says', async () => {
      const readRows = async (): Promise<string[]> =>
        page.evaluate(() =>
          (Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[]).map(
            (r) => r.textContent ?? '',
          ),
        );

      const before = await readRows();
      const tall = await page.evaluate(
        () =>
          (document.querySelector('#boardRows .row') as HTMLElement).getBoundingClientRect().height,
      );

      await page.click('#boardDensity');
      await page.waitForTimeout(300);

      const short = await page.evaluate(
        () =>
          (document.querySelector('#boardRows .row') as HTMLElement).getBoundingClientRect().height,
      );
      expect(short).toBeLessThan(tall);
      // Every word survives. A density control that dropped a column would be hiding an
      // emergency's own words to save vertical space.
      expect(await readRows()).toEqual(before);

      await page.click('#boardDensity');
      await page.waitForTimeout(300);
    });

    /**
     * **M11-13 — below the breakpoint it is today's card, and the header is gone.**
     *
     * ADR-0013: one app, laid out by CSS at three widths. A row of column titles above a stack
     * of cards labels nothing, so it is not drawn — and the run-on defect this board has already
     * shipped once (`Fire — issuednobody told yet`) is checked for directly, because splitting
     * `.meta` into two cells is exactly how that class of bug is reintroduced.
     */
    it('reflows to the cards on a handset, with the separator intact', async () => {
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForTimeout(400);

      expect(await page.locator('#boardHead').isHidden()).toBe(true);

      const card = await page.evaluate(() => {
        const row = document.querySelector('#boardRows .row') as HTMLElement;
        const who = row.querySelector('.who') as HTMLElement;
        const age = row.querySelector('.age') as HTMLElement;
        return {
          text: row.textContent ?? '',
          // Two cells, one line: the age sits beside the department, not under it.
          sameLine:
            Math.abs(
              Math.round(who.getBoundingClientRect().top) -
                Math.round(age.getBoundingClientRect().top),
            ) <= 2,
          separator: getComputedStyle(age, '::before').content,
        };
      });

      expect(card.sameLine).toBe(true);
      // The middot is CSS, and without it the card reads "nobody told yetjust now".
      expect(card.separator).toContain('·');
      expect(card.text).not.toMatch(/yetjust|yet\d/);

      await page.setViewportSize({ width: 1280, height: 900 });
    });
  });

  /**
   * **18. The queue stays alive while an incident is open — M11-14.**
   *
   * The fault this closes: `showView('detail')` hid the board, closed `/board/live` and cleared
   * the poll. The operator lost their place, and **the board behind it silently stopped updating
   * while its own "Live as of…" clock kept ticking** — INV-02 with the clock still running.
   *
   * 🔴 **And the fix introduced a second fault that these assertions caught.** Keeping the board
   * alive removed the `closeBoardStream()` that used to run on every view change, so arriving at
   * the board again opened **another** `EventSource` — one per visit, each holding a connection
   * on the district's one server, and each firing `refreshBoard` on every announcement. The board
   * repainted several times per event and never sat still; two tests timed out clicking a control
   * being replaced under the pointer, which is exactly what an operator would have felt.
   *
   * ⚠️ Coming back is `#back` (the drawer's own close), not `#navBoard` — the Command Center
   * redesign made the incident a modal slide-out over a full-viewport backdrop, so a nav click
   * while it is open is intercepted exactly as it would be for an operator. Closing the drawer is
   * how you leave it, and `#back` runs `showView('board')`.
   */
  describe('18. an open incident does not stop the queue', () => {
    it('keeps one stream, not one per visit, and keeps the board mounted', async () => {
      const streams: string[] = [];
      const onRequest = (r: { url(): string }): void => {
        if (r.url().includes('/board/live')) streams.push(r.url());
      };
      page.on('request', onRequest);

      try {
        const id = await seedIncident('high');
        await openBoard();
        /**
         * ⚠️ Recorded rather than required to be non-zero. By the time this test runs the stream
         * is **already open** from an earlier test in the file, so a correct app makes no new
         * request here at all — a first version asserted `> 0` and failed for that reason. What
         * catches the leak is that this number does not MOVE across the journey below.
         */
        const opened = streams.length;

        // Open an incident, then come back — twice, because one visit could pass by luck.
        for (let i = 0; i < 2; i += 1) {
          await page.click(`.row[data-incident="${id}"]`);
          await page.waitForSelector('#detailView:not([hidden])', { timeout: 15_000 });

          /**
           * ⚠️ **The board is still mounted while the incident is open.** Asserted on the rows
           * being in the DOM rather than on them being visible: below the pane's breakpoint the
           * board is correctly off screen, and what M11-14 is about is that it was never
           * *unmounted* and never stopped updating.
           */
          const stillThere = await page.evaluate(
            () => document.querySelectorAll('#boardRows .row').length,
          );
          expect(stillThere).toBeGreaterThan(0);

          await page.click('#back');
          await page.waitForSelector('#detailView[hidden]', { state: 'attached', timeout: 15_000 });
          await page.waitForSelector('#boardView:not([hidden])');
          await page.waitForTimeout(400);
        }

        // One stream for the whole journey. A second is a leaked connection AND a board that
        // repaints once per stream per announcement.
        expect(streams.length).toBe(opened);
      } finally {
        page.off('request', onRequest);
      }
    });
  });

  /**
   * **`'other'` on the Record row read as "could not be classified" — 2026-09-05.**
   *
   * A district reported an incident it had itself tagged Alert and asked why the Record row's
   * category badge said *Other*. `web/src/main.ts`'s `TILES` (2026-08-24) writes the literal
   * category `'other'` on Alert, Advisory, Order, Meeting, Schedule and Information alike,
   * because none of those tiles ever asks the operator to classify anything — only the seven
   * emergency tiles have a real category to show. `domain/communications.ts`'s `hasCategory` is
   * the fix; this is the one test that watches the actual `.cat` badge a real browser paints,
   * which a unit test on the function cannot.
   */
  it("the Record row shows an Alert's kind, not the category grid never asked it for", async () => {
    const created = await page.evaluate(async () => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Exactly what the Alert tile writes — `web/src/main.ts`'s `TILES`.
        body: JSON.stringify({ category: 'other', severity: 'high', kind: 'alert' }),
      });
      return (await res.json()) as { incidentId: string };
    });

    const told = await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({ targets: [{ kind: 'post', id: actor.seatId }], reason: 'board e2e' }),
    });
    expect(told.status).toBe(200);

    /**
     * A fresh page rather than the suite's shared `page` — by this point in the file `page` may
     * carry a sort, a density or a facet narrowing left by an earlier test, any of which can hide
     * a row this test never asked to be filtered. `#board` with no query narrows to nothing.
     */
    const fresh = await context.newPage();
    try {
      await fresh.goto(`${origin}/#board`);
      await fresh.waitForSelector('#boardView:not([hidden])');
      await fresh.waitForSelector(`.row[data-incident="${created.incidentId}"]`, {
        timeout: 15_000,
      });
      const cat = await fresh.evaluate((incidentId: string) => {
        const row = document.querySelector(`.row[data-incident="${incidentId}"] .cat`);
        return row?.textContent ?? null;
      }, created.incidentId);

      expect(cat).toContain('Alert');
      expect(cat).not.toContain('Other');
    } finally {
      await fresh.close();
    }
  });

  /**
   * The faceted panel — M11-16.
   *
   * ## The property, asserted the only way it means anything
   *
   * Not "does clicking a facet filter the board". It is **that the number on the facet and the
   * rows it lands on are the same set** — the requirement the owner stated for the dashboard's
   * counters (*straight to those, not randomly clickable*) and the one this milestone has now
   * had to restore three times: on the strip (M11-06/07), on the dashboard (`districtKeys.e2e`)
   * and on the departments panel (2026-08-18, where two department names fused into one string).
   *
   * ⚠️ **Both halves are read in ONE `page.evaluate`.** The board polls every ten seconds and
   * repaints the panel together with the rows; reading the facet's number in one call and the
   * row count in the next would let a refresh land between them and fail a test whose subject
   * was never the arithmetic. One synchronous read sees one paint.
   */
  describe('narrowing the board by a facet', () => {
    async function openNarrow(): Promise<void> {
      await openBoard();
      await page.waitForSelector('#boardNarrow:not([hidden])', { timeout: 15_000 });
      if (await page.isHidden('#boardFacets')) await page.click('#boardNarrowToggle');
      await page.waitForSelector('#boardFacets:not([hidden])', { timeout: 15_000 });
    }

    /**
     * Click the nth clickable facet and return, from one read: what it claimed, and what the
     * board actually shows.
     *
     * The attribute is deliberately **not** named here. The test derives which attribute the
     * shown rows agree on; naming it would put a second copy of the facet-to-attribute mapping
     * in the test, which is the exact thing the design exists to avoid having anywhere.
     */
    async function applyNth(n: number): Promise<{
      label: string;
      claimed: number;
      shown: number;
      disagreeing: number;
    } | null> {
      return page.evaluate((index: number) => {
        const buttons = Array.from(
          document.querySelectorAll('#boardFacets button.facet'),
        ) as HTMLButtonElement[];
        const button = buttons[index];
        if (button === undefined) return null;

        button.click();

        const label = button.querySelector('.fl')?.textContent ?? '';
        const claimed = Number(button.querySelector('b')?.textContent ?? '-1');
        const rows = Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[];
        const shownRows = rows.filter((r) => !r.hidden);
        const hiddenRows = rows.filter((r) => r.hidden);

        // Whichever attribute the selection was made on, the shown rows must all share a value
        // for it that no hidden row carries. If no attribute satisfies that, the selection was
        // not a set — which is the failure this test exists to catch.
        const attrs = ['severity', 'kind', 'stage', 'unassessed', 'departments'];
        let coherent = false;
        for (const attr of attrs) {
          const values = new Set(shownRows.map((r) => r.dataset[attr] ?? ''));
          if (shownRows.length === 0 || values.size !== 1) continue;
          const only = [...values][0] ?? '';
          if (only === '') continue;
          const leaked = hiddenRows.filter((r) =>
            (r.dataset[attr] ?? '').split('').includes(only),
          ).length;
          if (leaked === 0) {
            coherent = true;
            break;
          }
        }

        return { label, claimed, shown: shownRows.length, disagreeing: coherent ? 0 : 1 };
      }, n);
    }

    it('17. a facet lands on exactly the rows it counted', async () => {
      await seedIncident('critical');
      await seedIncident('low');
      await seedIncident();
      await openNarrow();

      // Several, not one: the groups differ in how they match — `is` for severity and stage,
      // `has` for a department an incident may share with another — and a bug in either shape
      // is a number sitting over the wrong rows.
      for (const n of [0, 1, 2]) {
        const result = await applyNth(n);
        if (result === null) continue;
        expect({ facet: result.label, rows: result.shown }).toEqual({
          facet: result.label,
          rows: result.claimed,
        });
        expect(result.disagreeing).toBe(0);
        await page.click('#boardFilterClear');
      }
    });

    /**
     * A facet that counted nothing is drawn and is not clickable.
     *
     * The strip's own rule, and ADR-0005's: at 02:00 the absence of the word *critical* and
     * *critical 0* are two different statements, and only one of them is an answer. A zero that
     * opens a board saying "nothing matches" answers a question the figure already answered,
     * and teaches that these numbers lead somewhere unreliable.
     */
    it('18. draws a facet that counted nothing, and refuses to make it a button', async () => {
      await openNarrow();

      const zeros = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#boardFacets .facet'))
          .filter((n) => Number(n.querySelector('b')?.textContent ?? '-1') === 0)
          .map((n) => n.tagName),
      );

      // There is at least one: severity and stage are fixed vocabularies, and a test board never
      // holds all eight of their values at once.
      expect(zeros.length).toBeGreaterThan(0);
      for (const tag of zeros) expect(tag).toBe('SPAN');
    });

    /**
     * ⚠️ *Not assessed* is offered beside the severities and is never one of them — ADR-0009.
     *
     * Among them, a panel ordered worst-first would sit it between `low` and `moderate`, and the
     * district would read "somebody judged this smallish" off a row nobody has looked at. The
     * heading is what keeps them apart, so the heading is what is asserted.
     */
    it('19. offers not-assessed beside the severities, never among them', async () => {
      await seedIncident();
      await openNarrow();

      const group = await page.evaluate(() => {
        const section = Array.from(document.querySelectorAll('#boardFacets .fgroup')).find(
          (n) => n.querySelector('h4')?.textContent === 'severity',
        );
        return section === undefined
          ? null
          : Array.from(section.querySelectorAll('.facet .fl')).map((n) => n.textContent);
      });

      expect(group).not.toBeNull();
      // The four bands worst first — ordered by rank and never by size (INV-04) — and the
      // absence of an assessment last, as its own entry.
      expect(group).toEqual(['critical', 'high', 'moderate', 'low', 'not assessed']);
    });

    /** The same gesture back out, so undoing a click does not mean hunting for another control. */
    it('20. clicking the applied facet again clears it', async () => {
      await seedIncident('high');
      await openNarrow();

      await applyNth(0);
      expect(await page.isVisible('#boardFilter')).toBe(true);

      const cleared = await page.evaluate(() => {
        const on = document.querySelector('#boardFacets button.facet[data-on="true"]');
        if (on === null) return false;
        (on as HTMLButtonElement).click();
        return true;
      });
      expect(cleared).toBe(true);

      /**
       * ⚠️ Not `waitForSelector('#boardFilter[hidden]')`, which is how this was first written.
       *
       * That call waits for the element to become **visible** by default, and a hidden element
       * never can — so it sat for the full timeout reporting "locator resolved to hidden",
       * which was the product doing exactly the right thing.
       */
      await page.waitForFunction(
        () => document.getElementById('boardFilter')?.hidden === true,
        undefined,
        { timeout: 15_000 },
      );
      const hidden = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('#boardRows .row')).filter(
            (r) => (r as HTMLElement).hidden,
          ).length,
      );
      expect(hidden).toBe(0);
    });
  });
  /**
   * Saved views, in the URL — M11-17.
   *
   * ## The one that matters is test 24
   *
   * ⚠️ **A saved view is presentation and never authority (INV-05).** The plan says so and says
   * to pin it with a test, because this is the feature where that line is easiest to cross: a
   * link carries state, state written by whoever sends the link, and the temptation is to let it
   * describe what to *fetch*. It does not. Everything a view restores is applied to rows the
   * server already scoped and sent — so a link can narrow what somebody sees and can never widen
   * it, whoever wrote the link.
   *
   * The other three cover the ordinary promise: what is on screen can be copied out of the
   * address bar, and pasting it back gives the same screen.
   */
  describe('a view that can be copied out of the address bar', () => {
    async function openNarrow(): Promise<void> {
      await openBoard();
      await page.waitForSelector('#boardNarrow:not([hidden])', { timeout: 15_000 });
      if (await page.isHidden('#boardFacets')) await page.click('#boardNarrowToggle');
      await page.waitForSelector('#boardFacets:not([hidden])', { timeout: 15_000 });
    }

    it('21. writes what is on screen into the URL', async () => {
      await seedIncident('critical');
      await openNarrow();

      const applied = await page.evaluate(() => {
        const button = document.querySelector('#boardFacets button.facet') as HTMLButtonElement;
        button.click();
        return {
          label: button.querySelector('.fl')?.textContent ?? '',
          hash: location.hash,
        };
      });

      expect(applied.hash).toContain('#board?');
      expect(applied.hash).toContain('narrow=facet');
      expect(decodeURIComponent(applied.hash)).toContain(applied.label);

      await page.click('#boardFilterClear');
      // Cleared is a view too: the link must stop describing a narrowing nobody is standing in.
      expect(await page.evaluate(() => location.hash)).not.toContain('narrow=');
    });

    it('22. gives the same screen back when the link is opened fresh', async () => {
      await seedIncident('critical');
      await openNarrow();

      const link = await page.evaluate(() => {
        const button = document.querySelector('#boardFacets button.facet') as HTMLButtonElement;
        button.click();
        return location.href;
      });

      const shownBefore = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('#boardRows .row')).filter(
            (r) => !(r as HTMLElement).hidden,
          ).length,
      );

      // A genuinely fresh load of the copied link, not a re-render of the page that wrote it.
      const fresh = await context.newPage();
      try {
        await fresh.goto(link);
        await fresh.waitForSelector('#boardFilter:not([hidden])', { timeout: 20_000 });
        const restored = await fresh.evaluate(() => ({
          chip: document.getElementById('boardFilterText')?.textContent ?? '',
          shown: Array.from(document.querySelectorAll('#boardRows .row')).filter(
            (r) => !(r as HTMLElement).hidden,
          ).length,
        }));

        expect(restored.chip).toContain('Showing only');
        expect(restored.shown).toBe(shownBefore);
      } finally {
        await fresh.close();
      }
    });

    it('23. carries the order and the density too', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(`${origin}/#board?sort=-age&density=compact`);
        await fresh.waitForSelector('#boardView:not([hidden])', { timeout: 20_000 });
        await fresh.waitForFunction(
          () => document.querySelectorAll('#boardRows .row').length > 0,
          undefined,
          { timeout: 20_000 },
        );

        const state = await fresh.evaluate(() => ({
          density: document.getElementById('boardTable')?.dataset['density'] ?? '',
          sorted:
            document.querySelector('#boardHead button.bh[data-dir]')?.getAttribute('data-sort') ??
            '',
          dir:
            document.querySelector('#boardHead button.bh[data-dir]')?.getAttribute('data-dir') ??
            '',
        }));

        expect(state.density).toBe('compact');
        expect(state.sorted).toBe('age');
        expect(state.dir).toBe('desc');
      } finally {
        await fresh.close();
      }
    });

    /**
     * ⚠️ **INV-05, pinned. A saved view narrows and can never widen.**
     *
     * Three crafted links, each asking for something the seat may not have:
     *
     * 1. A facet the server never offered. It is **not applied at all** — the operator gets the
     *    whole board rather than a chip describing a selection nobody made. Applying it would
     *    make the URL a second source for the one thing M11-16 keeps in one place: which
     *    attribute a count belongs to.
     * 2. A department that exists but is not on this board. It narrows to nothing and says so.
     *    It cannot summon the rows, because the rows it would match were never sent — the fetch
     *    used the recipient's own session and the server decided its contents before any of this
     *    ran.
     * 3. An order the server does not offer. The board is **empty and says why**, because
     *    `?sort=` is validated server-side and answers 400 — a crafted sort becomes an error,
     *    never a board.
     *
     * The property under all three: **the number of rows in the document is never larger than
     * what this seat's own unfiltered board returns.** A saved view can hide rows. There is no
     * link that adds one.
     */
    it('24. narrows what the seat could already see, and can never widen it', async () => {
      await seedIncident('high');
      await openBoard();
      const ownRows = await page.evaluate(
        () => document.querySelectorAll('#boardRows .row').length,
      );
      expect(ownRows).toBeGreaterThan(0);

      /**
       * ⚠️ Each case says what it expects to SEE, not merely that it saw no more.
       *
       * A bare `rows <= ownRows` is satisfied by a board that never loaded, which would make
       * this test pass for the wrong reason on the day the feature broke. `loads` states
       * whether the fetch should have produced a board at all, so the comparison is made
       * against something.
       */
      const crafted: { view: string; loads: boolean; wholeBoard: boolean }[] = [
        // A facet nobody offered — an invented attribute and an invented value. Not applied
        // at all, so the operator gets their whole board rather than a chip describing a
        // selection nobody made.
        { view: '#board?narrow=facet:secretClearance:top', loads: true, wholeBoard: true },
        // A real shape naming a department this board does not carry. It narrows to nothing
        // and cannot summon the rows, because they were never sent.
        {
          view: '#board?narrow=department:Directorate%20Of%20Somewhere%20Else',
          loads: true,
          wholeBoard: false,
        },
        // An order the server refuses — 400, so there is no board rather than a wrong one.
        { view: '#board?sort=-whatever', loads: false, wholeBoard: false },
      ];

      for (const { view, loads, wholeBoard } of crafted) {
        const fresh = await context.newPage();
        try {
          /**
           * ⚠️ **Waited for, not slept for — 2026-10-02.** This slept 1200 ms and assumed the
           * board had painted by then. On a loaded machine it had not, the "loads" case saw zero
           * rows, and the test went red on a commit that changed only a Markdown file. Now it
           * waits for the board's own fetch to answer, then for the outcome that answer must
           * produce: rows when it loads, the stale mark when the server refuses.
           */
          const answered = fresh.waitForResponse(
            (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/incidents',
            { timeout: 20_000 },
          );
          await fresh.goto(`${origin}/${view}`);
          await fresh.waitForSelector('#boardView:not([hidden])', { timeout: 20_000 });
          await answered;
          await fresh.waitForFunction(
            (expectRows) =>
              expectRows
                ? document.querySelectorAll('#boardRows .row').length > 0
                : document.getElementById('boardAsOf')?.dataset['stale'] === 'true',
            loads,
            { timeout: 15_000 },
          );
          await fresh.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

          const seen = await fresh.evaluate(() => ({
            rows: document.querySelectorAll('#boardRows .row').length,
            visible: Array.from(document.querySelectorAll('#boardRows .row')).filter(
              (r) => !(r as HTMLElement).hidden,
            ).length,
          }));

          // The whole invariant, in one line: never more than this seat's own board.
          expect(seen.rows).toBeLessThanOrEqual(ownRows);
          expect(seen.visible).toBeLessThanOrEqual(ownRows);

          // And the comparison was made against something.
          if (loads) expect(seen.rows).toBeGreaterThan(0);
          else expect(seen.rows).toBe(0);

          // A narrowing the server never offered is not applied — nothing is hidden.
          if (wholeBoard) expect(seen.visible).toBe(seen.rows);
          // A real narrowing that matches nothing hides everything, and says so on the chip.
          if (loads && !wholeBoard) expect(seen.visible).toBe(0);
        } finally {
          await fresh.close();
        }
      }
    });
  });
});
