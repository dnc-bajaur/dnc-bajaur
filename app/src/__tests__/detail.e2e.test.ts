/**
 * Incident detail — M0-35.
 *
 * The acceptance criterion for this screen is a sentence, not a feature list: **every value
 * answers "who set this, when, why".** That is the claim `docs/04-authority-model.md` makes
 * about the whole system, and this is the only place a human ever sees it honoured.
 *
 * So the tests are about provenance surviving the trip to a screen:
 *
 *   - an override shows the district's value AND the department's underneath it, with the
 *     reason and both actors (ADR-0003) — not one replacing the other
 *   - actors are named by seat, not by uuid, because a uuid does not answer "who"
 *   - an event nobody performed says so, rather than showing a blank
 *   - the occurred/recorded gap is shown, because it is the district's connectivity picture
 *     rather than noise (ADR-0002)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { saveGroup } from '../db/groupStore.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { append } from '../db/eventStore.js';
import type { IncidentEvent } from '../domain/events.js';
import { buildWeb } from '../../build.mjs';
import { hashPassword } from '../auth/passwords.js';
import { login } from '../auth/sessions.js';
import { seedDepartment, enableAllCapabilities } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('M0-35: incident detail', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let rescueDept: string;
  let controlPhone: string;
  let controlRoomToken: string;
  let incidentId: string;

  const RESCUE_SEAT_TITLE = 'Rescue 1122 Station In-Charge';
  const CONTROL_SEAT_TITLE = 'District Control Room';
  const RESCUE_OFFICER = 'Rescue Duty Officer';
  /** The control room's own holder — since ADR-0024 it is the seat that writes everything. */
  const CONTROL_OFFICER = 'Control Room Operator';

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

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    const rescue = await actor(RESCUE_OFFICER, RESCUE_SEAT_TITLE, 'station');
    const control = await actor('Control Room Operator', CONTROL_SEAT_TITLE, 'district');
    controlPhone = control.phone;
    controlRoomToken = control.token;
    // The rescue officer is still SEEDED — the incident's history names them, and that is what
    // this screen exists to render. They simply do not sign in.
    void rescue;

    incidentId = await seedIncident();

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    /**
     * ⚠️ **THE BROWSER IS THE CONTROL ROOM, AND SINCE ADR-0018 THERE IS NOBODY ELSE.**
     *
     * It signed in as the station-tier rescue officer, which worked for as long as an unplaced
     * incident was readable by any seat. ADR-0030 made *unplaced* permanent and `evaluateRead`
     * had to stop reading it as *everybody owns it*, so this officer is now correctly refused
     * the incident and every assertion below timed out waiting for a screen that had 404ed.
     * What this file is about is what the DETAIL screen renders — provenance, actors, the
     * override — and the seat that opens it in Bajaur is the control room's.
     */
    await page.fill('#phone', controlPhone);
    await page.fill('#password', PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function actor(
    name: string,
    title: string,
    tier: string,
  ): Promise<{ phone: string; token: string }> {
    const seat = await pool.query<{ seat_id: string }>(
      // ADR-0030 — the trigger derives `tier` from `is_administration` alone (migration 0039), so
      // the value passed for it is overwritten. Asking for `district` and writing nothing else
      // gets a `department` seat, and every assertion below then fails a long way from the cause.
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, false, $3) RETURNING seat_id`,
      [title, tier, tier === 'district'],
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
    return { phone, token: result.token };
  }

  async function post(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** One incident with a full, contested history — the case detail exists for. */
  async function seedIncident(): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'moderate',
    });
    const id = created['incidentId'] as string;

    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'road traffic accident on the Khar road',
    });
    /**
     * ⚠️ **The control room assesses it, not Rescue — ADR-0024, 2026-08-22.**
     *
     * The department used to triage its own incident, which is what made the override below read
     * as *the district correcting a department*. No department seat writes anything now, so both
     * assessments are the control room's own — an earlier call, revised later.
     *
     * **What the screen is being tested on does not change.** ADR-0003's claim is that an
     * override shows the value it replaced and names who set each one; that is exactly as
     * load-bearing when one room does both, because *"who decided this, and when"* is the
     * question the record exists to answer.
     */
    await post(`/incidents/${id}/triage`, controlRoomToken, { severity: 'high', category: 'rta' });
    await post(`/incidents/${id}/override`, controlRoomToken, {
      field: 'severity',
      value: 'critical',
      reason: 'second reporter confirms multiple casualties',
    });

    // An event with nobody behind it, and a two-hour gap between happening and arriving.
    // Both are things the screen has to be able to say out loud.
    const occurred = new Date(Date.now() - 125 * 60_000).toISOString();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: id,
        type: 'escalated',
        occurredAt: occurred,
        recordedAt: occurred,
        clientSeq: 99,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { fromSeatId: null, toSeatId: randomUUID(), trigger: 'sla_breach' },
      } as unknown as IncidentEvent,
    ]);

    return id;
  }

  async function openDetail(id: string): Promise<void> {
    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, id);
    await page.waitForSelector('#detailView:not([hidden]) #detailTiles .d-tile');
  }

  /**
   * The first read is the Overview. Provenance is one collapsible (`detailFacts`), the raw event
   * log is the History tab (`timeline`), and *who was told* is a plain section that is always on
   * screen (`whoTold`) — 2026-09-04.
   */
  async function expand(id: 'detailFacts' | 'whoTold' | 'timeline'): Promise<void> {
    if (id === 'detailFacts') {
      await page.locator('#detailFacts').evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      return;
    }
    if (id === 'timeline') {
      await page.click('#tabHistory');
      await page.waitForSelector('#detailHistory:not([hidden])');
      return;
    }
    // whoTold is a section in the Overview now — always visible, nothing to open.
  }

  it('1. opens from the board by clicking a row', async () => {
    await page.click('#navBoard');
    await page.waitForSelector(`#boardRows .row[data-incident="${incidentId}"]`, {
      timeout: 15_000,
    });
    await page.click(`#boardRows .row[data-incident="${incidentId}"]`);

    await page.waitForSelector('#detailView:not([hidden])');

    /**
     * ⚠️ **This asserted `#boardView` was INVISIBLE, and M11-14 deliberately reversed it.**
     *
     * Opening an incident used to replace the board: the rows were unmounted, `/board/live` was
     * closed and the poll cleared, so an operator lost their place — and the queue behind the
     * incident **silently stopped updating while its own "Live as of…" clock kept ticking**,
     * which is INV-02 with the clock still running.
     *
     * The incident now opens **beside** the queue at desk width and as the full sheet below it,
     * decided by a media query rather than by JavaScript (ADR-0013). So the old assertion is
     * only true at narrow widths, and what actually matters at every width is the property
     * below: **the board is still mounted and still the board.** `board.e2e` test 18 pins the
     * other half — that it is still updating, on exactly one stream.
     */
    const board = await page.evaluate(() => {
      const node = document.getElementById('boardView') as HTMLElement | null;
      return {
        mounted: node !== null,
        // Never unmounted, whatever the width decides to show.
        rows: document.querySelectorAll('#boardRows .row').length,
        // The `hidden` attribute is the app's own statement about the screen; CSS decides
        // whether it is on screen at this width.
        hiddenAttribute: node?.hidden ?? true,
      };
    });
    expect(board.mounted).toBe(true);
    expect(board.rows).toBeGreaterThan(0);
    expect(board.hiddenAttribute).toBe(false);
  });

  /**
   * 🔴 **The detail screen never once showed the stage the Board shows** — D-1, 2026-08-25.
   *
   * `readIncident` has computed `stage` since M9-25 and `GET /incidents/:id` **dropped it**, so
   * this heading fell through `main.ts`'s own *older server* branch and printed the raw status on
   * every incident since the four stages were introduced. Two screens described one emergency in
   * two vocabularies — *Responded* on the board, `responding` here — which is the disagreement
   * `stageOf` exists to make impossible.
   *
   * ⚠️ **Both words, and the assertion says so.** The status is not replaced: *routed* and
   * *reported* are the same stage while being very different situations, and this is the one
   * screen that has to carry the difference.
   */
  it('1b. names the stage in the same words as the Board, beside the full status', async () => {
    await openDetail(incidentId);

    /**
     * The four-word stage leads the Stage tile; the raw status stays beside it — *routed* and
     * *reported* are one stage while being different situations, and this is the one screen
     * that carries the difference (M9-25). Both are asserted: a redesign loses no detail.
     */
    const stage = (
      (await page.locator('#detailTiles .d-tile-step').textContent()) ?? ''
    ).toLowerCase();
    expect(stage).toMatch(/issued|acknowledged|responded|resolved/);
    expect(stage).toMatch(/reported|triaged|routed/);

    // A progress pill in the head band says the same thing at a glance.
    const pills = (await page.locator('#detailHead .d-pill').allTextContents()).join(' ');
    expect(pills).toMatch(/Awaiting response|Acknowledged|Responded|Resolved/);
  });
  it('1c. opens on the current situation and keeps the record tools unchanged', async () => {
    await openDetail(incidentId);

    expect(await page.locator('#detailQuick [data-field="quick-severity"] .v').textContent()).toBe(
      'critical',
    );
    /**
     * ⚠️ **IT READ THE DEPARTMENT'S NAME HERE UNTIL ADR-0030, AND WHAT REPLACES IT IS THE
     * REGRESSION THAT WOULD OTHERWISE HAVE SHIPPED TO THIS SCREEN.**
     *
     * The name came from a registry migration 0039 dropped, and `?? id` fell back to
     * thirty-six characters of hexadecimal in the *Responsible* value of the one screen a
     * control room quotes down a telephone — which is precisely what ADR-0027 exists to have
     * taken off it. An unnameable id is dropped now, so the honest answer is that nobody is
     * responsible, because since ADR-0030 nobody can be.
     */
    const responsible = await page
      .locator('#detailQuick [data-field="responsible"] .v')
      .textContent();
    expect(responsible).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(await page.locator('#detailQuick [data-field="response"] .v').textContent()).toBe(
      'No one has been told yet',
    );
    // The Overview opens compact: provenance is collapsed and History is not the active tab.
    expect(
      await page.locator('#detailFacts').evaluate((node) => (node as HTMLDetailsElement).open),
    ).toBe(false);
    expect(await page.locator('#detailHistory').isVisible()).toBe(false);

    // The record tools keep their exact ids — they moved into the footer's "More" menu
    // (2026-09-06), not away. Closed until the button is pressed.
    expect(await page.locator('#detailReport').isVisible()).toBe(false);
    await page.click('#detailMoreBtn');
    expect(await page.locator('#detailReport').isVisible()).toBe(true);
    expect(await page.locator('#takeReport').isVisible()).toBe(true);
    expect(await page.locator('#correctIncident').isVisible()).toBe(true);
    expect(await page.locator('#withdrawIncident').isVisible()).toBe(true);
  });
  it('2. shows the override, and the value it replaced underneath it (ADR-0003)', async () => {
    await openDetail(incidentId);
    const severity = page.locator('.value[data-field="severity"]');

    expect((await severity.locator('.v').textContent())?.trim()).toBe('critical');

    /**
     * The whole of ADR-0003 in one assertion: **the superseded assessment survives**, with the
     * reason it was replaced and who did each. Nobody can be blamed for a figure they did not
     * enter, and nothing can be quietly rewritten.
     *
     * ⚠️ **It used to be the department's assessment being overridden by the district.** Since
     * ADR-0024 no department seat writes anything, so both are the control room's — an earlier
     * call and a later revision. **The claim is unchanged and if anything sharper**: *"who decided
     * this, and when"* has to be answerable even when one room decided both, because that is
     * exactly the case where a screen could get away with showing only the latest.
     */
    const was = (await severity.locator('.was').textContent()) ?? '';
    expect(was).toContain('high');
    expect(was).toContain(CONTROL_SEAT_TITLE);
    expect(was).toContain('second reporter confirms multiple casualties');
  });

  it('3. names actors by seat, not by uuid', async () => {
    // A uuid does not answer "who". Authority attaches to the post (ADR-0004), so the seat
    // leads and the individual follows.
    const prov = (await page.textContent('.value[data-field="severity"] .prov')) ?? '';
    expect(prov).toContain(CONTROL_SEAT_TITLE);
    expect(prov).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('4. names the person alongside the seat they held', async () => {
    // ADR-0004, and it is the reason both halves are asserted: **authority attaches to the post,
    // knowledge attaches to the person**, so the timeline has to carry both. Which seat it is
    // moved with ADR-0024; that the screen names a seat AND a human did not.
    const triaged = (await page.textContent('.tl[data-type="triaged"] .who')) ?? '';
    expect(triaged).toContain(CONTROL_SEAT_TITLE);
    expect(triaged).toContain(CONTROL_OFFICER);
  });

  it('5. says "the system" for an event nobody performed', async () => {
    // "Nobody did this, the deadline did" is a real and important distinction, and a blank
    // would read as missing data instead.
    const who = (await page.textContent('.tl[data-type="escalated"] .who')) ?? '';
    expect(who).toBe('the system');
  });

  it('6. shows the whole history in order, not a summary of it', async () => {
    const types = await page
      .locator('#timelineRows .tl')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['type']));
    expect(types).toContain('reported');
    expect(types).toContain('routed');
    expect(types).toContain('triaged');
    expect(types).toContain('overridden');
    expect(types).toContain('escalated');
  });

  it('7. carries the reason on every event that required one (INV-06)', async () => {
    const overridden = (await page.textContent('.tl[data-type="overridden"] .why')) ?? '';
    expect(overridden).toContain('second reporter confirms multiple casualties');

    // `.last()` is kept though there is only one match now. An incident carried **two**
    // routing entries until ADR-0022 — the automatic pass at intake and then the human
    // decision — and this asserted on the human one. There is only the human one now, and
    // `.last()` is still the locator that means "the decision somebody made".
    const routed = (await page.locator('.tl[data-type="routed"] .why').last().textContent()) ?? '';
    expect(routed).toContain('Khar road');
  });

  it('7b. shows every routing entry as a decision somebody made', async () => {
    /**
     * ⚠️ **This test asserted the opposite until ADR-0022, and what it protects is unchanged.**
     *
     * It read: *"shows the automatic routing pass as its own entry, with its own reason"* —
     * the pass ran as the system at intake and recorded what it decided even when it decided
     * nothing, so an operator asking *"why did nobody get this?"* got an answer on the
     * incident rather than in a server log they cannot read (ADR-0005).
     *
     * There is no automatic pass. The question ADR-0005 makes this file answer is now
     * answered one screen earlier — an unheld emergency sits in the control room's queue,
     * named — and what the timeline must never do is show a routing entry attributed to
     * nobody. Every one of them is a person now, and this asserts exactly that.
     */
    const whos = await page.locator('.tl[data-type="routed"] .who').allTextContents();
    expect(whos.length).toBeGreaterThan(0);
    for (const who of whos) expect(who).not.toBe('the system');
  });

  it('8. surfaces the gap between happening and arriving (ADR-0002)', async () => {
    // Not a diagnostic curiosity. An emergency that took two hours to surface is an
    // operational risk regardless of how fast the response was afterwards.
    const late = await page.locator('.tl .late').first().textContent();
    expect(late).toMatch(/reached the server \d+m later/);
  });

  /**
   * ⚠️ **IT USED TO BE THIS PAGE'S OWN SEAT BEING REFUSED, AND SINCE ADR-0030 THAT SEAT IS THE
   * CONTROL ROOM, WHICH IS REFUSED NOTHING.**
   *
   * The refusal is not gone — it is wider. A seat with no district authority is now refused
   * every incident, because nothing can be placed with it and `evaluateRead` stopped reading
   * *nobody holds this* as *everybody owns it*. So this drives a **second browser context**,
   * signed in as an ordinary post holder, which is the only way left to watch the refusal reach
   * a screen. Same pattern as `board.e2e` test 14, and for the same reason.
   */
  it('9. refuses an incident to a seat with no authority to read it', async () => {
    const theirs = await post('/incidents', controlRoomToken, {
      category: 'security',
      severity: 'high',
    });

    const ordinary = await actor('Ordinary Officer (detail)', 'Ordinary Post (detail)', 'station');
    const other = await browser.newContext();
    const theirPage = await other.newPage();
    try {
      await theirPage.goto(origin);
      await theirPage.waitForSelector('#login');
      await theirPage.fill('#phone', ordinary.phone);
      await theirPage.fill('#password', PASSWORD);
      await theirPage.click('#loginSubmit');
      await theirPage.waitForSelector('#nav:not([hidden])');

      await theirPage.evaluate(async (target: string) => {
        const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
          .__dnc;
        await dnc.openDetail(target);
      }, theirs['incidentId'] as string);

      const head = await theirPage.textContent('#detailHead');
      expect(head).toContain('not available to your seat');
      // Not "forbidden" — confirming it exists is itself a disclosure about somebody else's
      // operations, which is why the server answers 404 rather than 403.
      expect(head).not.toContain('forbidden');
    } finally {
      await other.close();
    }
  });

  /**
   * **What we sent, and who it went to — the district asked for both here, 2026-08-24.**
   *
   * *"Kis ko gaya hai … click karne pr ju window open ho jate hai us mai mazeed detail ho."*
   * This is that window, and two things it said were wrong.
   *
   * 🔴 **It named the recipients with RAW UUIDs.** `actorsFor` resolved the ids on the
   * **events** — who performed something — while this panel lists `dispatchedTo`, who we
   * **sent to**; since M10-07/08/09 made the person row the only row the picker draws, the
   * ordinary recipient is a named officer who never touches the incident, so every lookup
   * missed and fell through to the id. **Nothing in this file could have caught it**: every
   * other assertion about the panel matches on a `.tname` whose contents nothing reads, which
   * is why this one reads them.
   *
   * 🔴 **And the words the district actually sent were nowhere on this screen at all.** They
   * were on the row, behind a button; the window — the place somebody opens for detail — had
   * neither the message nor a per-recipient copy of it.
   */
  it('11. names who was told, and says what each was sent only where they differ', async () => {
    const said = await post('/incidents', controlRoomToken, {
      category: 'flood',
      severity: 'high',
    });
    const id = said['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'canal breach',
    });

    /**
     * ⚠️ **Officers inserted directly, and never signed in.** `actor()` above burns a scrypt
     * slot per login and this needs none — nobody here authenticates. It is also the honest
     * fixture: a dispatched officer with no account is the ordinary case on this district
     * (ADR-0018), and it is exactly the case that produced uuids.
     */
    const told: string[] = [];
    for (const full of ['Told Alpha', 'Told Bravo']) {
      const row = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
        [full, `+92300${randomUUID().slice(0, 10)}`],
      );
      told.push(row.rows[0]!.person_id);
    }
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: told.map((personId) => ({ kind: 'person', id: personId })),
    });

    /**
     * The words, written straight onto the log against an attempt that already exists.
     * `message_sent` binds to one, and nothing in this environment sends — there is no
     * WhatsApp account (R-05), which is the district's own state.
     */
    const attempts = await pool.query<{ attempt: string; reason: string }>(
      `SELECT payload->>'attemptId' AS attempt, payload->>'reason' AS reason
         FROM incident_event WHERE incident_id = $1 AND type = 'notified'`,
      [id],
    );
    expect(attempts.rowCount).toBeGreaterThan(0);
    /**
     * ⚠️ **The `/route` above makes a `routed` attempt too, and it is not one of these rows.**
     * `renderWhoWasTold` draws one row per `dispatchedTo` and matches it against the
     * `dispatched` attempts alone — so a differing message written onto the routed attempt
     * changes nothing on screen, and the test below fails on a change that works.
     */
    const dispatchedAttempts = attempts.rows.filter((r) => r.reason === 'dispatched');
    expect(dispatchedAttempts.length).toBeGreaterThan(1);
    let seq = 500;
    for (const row of attempts.rows) {
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId: id,
          type: 'message_sent',
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          clientSeq: seq++,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'system',
          payload: {
            attemptId: row.attempt,
            what: 'Flood, high severity',
            where: 'Mamund, Bajaur',
          },
        } as unknown as IncidentEvent,
      ]);
    }

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told .tname', { timeout: 10_000 });

    // The message, once, where somebody who opened the incident expects to find it.
    expect(await page.textContent('[data-field="sent"] .v')).toBe(
      'Flood, high severity — Mamund, Bajaur',
    );

    /**
     * ⚠️ **The assertion that earns this test.** Names, and — said separately — **no uuid**,
     * because `toContain` on two names would still pass over a third row printing an id.
     */
    const names = await page.locator('#whoToldRows .told .tname').allTextContents();
    expect(names).toContain('Told Alpha');
    expect(names).toContain('Told Bravo');
    for (const name of names) {
      expect(name).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }

    /**
     * 🔴 **And NOT a copy of that message under every name — the district's own complaint,
     * 2026-09-08.**
     *
     * Both officers hold the same sentence, the record printed it once already, and printing
     * it a second and a third time under *Status by recipient* buried what that section is
     * for. The assertion is `0`, not "shorter": one copy per recipient was the shape somebody
     * photographed.
     */
    expect(await page.locator('#whoToldRows .told .tsent').count()).toBe(0);

    // The timeline carries the words too. It printed the heading and nothing else until today:
    // the one event that exists to record WHAT WAS SAID was the one rendering none of it.
    const timeline = await page.locator('.tl[data-type="message_sent"] .why').first().textContent();
    expect(timeline).toBe('Flood, high severity — Mamund, Bajaur');

    /**
     * ⚠️ **And it comes straight back the moment the recipients differ**, which is the case
     * `.tsent` was built for on 2026-08-24: two officers holding two different sentences is
     * something no single line above the list can say.
     */
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: id,
        type: 'message_sent',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: seq++,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: {
          attemptId: dispatchedAttempts[0]!.attempt,
          what: 'Flood, SEVERE — evacuate',
          where: 'Mamund, Bajaur',
        },
      } as unknown as IncidentEvent,
    ]);

    await openDetail(id);
    /**
     * ⚠️ **Back to the Overview first, and it is not tidiness.** The timeline assertion above
     * clicks `#tabHistory`, `openDetail` does not reset the tab, and `waitForSelector` waits for
     * an element to be **visible** — so the recipient rows exist behind a hidden panel and the
     * wait times out on a change that is working perfectly.
     */
    await page.click('#tabOverview');
    await page.waitForSelector('#detailOverview:not([hidden])');
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told .tsent', { timeout: 10_000 });
    const perRecipient = await page.locator('#whoToldRows .told .tsent').allTextContents();
    expect(perRecipient.length).toBe(names.length);
    expect(new Set(perRecipient)).toEqual(
      new Set([
        'Flood, SEVERE — evacuate — Mamund, Bajaur',
        'Flood, high severity — Mamund, Bajaur',
      ]),
    );
  });

  /**
   * **One recipient reads as one line, and "Taken by" is who accepted it — 2026-09-04.**
   *
   * The district opened the redesigned drawer over a report sent to a single officer and found
   * two things that answered nothing:
   *
   *   - the "Assigned to" tile said *"see recipients below"* — a tile pointing at the section
   *     under it — and then, after a first pass, named the recipients, which is a second copy of
   *     that section. Routing to a *department* was what made "who holds this" a question apart
   *     from "who was told"; ADR-0030 deleted the department table, so that field is empty for
   *     ever and the tile had nothing of its own to say. It is **"Taken by"** now: whoever
   *     acknowledged, or *"not yet taken"* until somebody does.
   *   - "Status by recipient" still carried the `1 told · 1 confirmed · 0 silent` tally, three
   *     numbers restating the one row directly beneath them. It is drawn only at two or more
   *     recipients now; the row itself always stays.
   */
  it('11d. "Taken by" tracks the acknowledgement, and the tally is gone for one recipient', async () => {
    const tileValue = (label: string): Promise<string> =>
      page.evaluate((want) => {
        const tiles = Array.from(document.querySelectorAll('#detailTiles .d-tile'));
        const hit = tiles.find((t) => t.querySelector('.d-tile-k')?.textContent?.trim() === want);
        // Drop the <small> — .d-tile-v holds the value plus a trailing note.
        const v = hit?.querySelector('.d-tile-v')?.cloneNode(true) as HTMLElement | undefined;
        v?.querySelector('small')?.remove();
        return v?.textContent?.trim() ?? '';
      }, label);

    const person = async (name: string): Promise<string> => {
      const row = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, password_hash)
         VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
        [name, `+92300${randomUUID().slice(0, 10)}`],
      );
      return row.rows[0]!.person_id;
    };

    // --- one recipient, not yet acknowledged -------------------------------------------------
    const solo = (await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'high',
    })) as { incidentId: string };
    await post(`/incidents/${solo.incidentId}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'person', id: await person('Lone Ranger') }],
    });

    await openDetail(solo.incidentId);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told', { timeout: 15_000 });

    expect(await tileValue('Taken by')).toBe('not yet taken');
    expect(await page.locator('#whoToldRows .ackline').count()).toBe(0);
    expect(await page.locator('#whoToldRows .told').count()).toBe(1);

    // --- somebody acknowledges: the tile names that seat -----------------------------------
    const holder = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ('Khar Road Post', 'station', false, false) RETURNING seat_id`,
    );
    const heldBy = holder.rows[0]!.seat_id;
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: solo.incidentId,
        type: 'acknowledged',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 700,
        actorPersonId: null,
        actorSeatId: heldBy,
        sourceChannel: 'system',
        payload: { seatId: heldBy },
      } as unknown as IncidentEvent,
    ]);

    await openDetail(solo.incidentId);
    expect(await tileValue('Taken by')).toBe('Khar Road Post');

    // --- two recipients: the tally is the point, and it is there --------------------------
    const pair = (await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'high',
    })) as { incidentId: string };
    await post(`/incidents/${pair.incidentId}/dispatch-to`, controlRoomToken, {
      targets: [
        { kind: 'person', id: await person('Pair Alpha') },
        { kind: 'person', id: await person('Pair Bravo') },
      ],
    });

    await openDetail(pair.incidentId);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .ackline', { timeout: 15_000 });
    expect(await page.locator('#whoToldRows .ackline').first().textContent()).toMatch(
      /2 told · 0 confirmed · 2 silent/,
    );
  });

  /**
   * **"Taken by" on a wide dispatch names the office that COMMITTED, not the first to tap** —
   * Option C, Phase 2 (2026-09-10).
   *
   * The fold has one `acknowledgedBy*` slot and the first answer of any kind fills it, a
   * refusal included. On a message to more than one office the drawer now reads the server's
   * `response` roll-up instead: the office that first said it was going, and "Responded" is
   * that office at that time — not whoever tapped *Unable to Respond* a minute earlier.
   */
  it('11g. "Taken by" names the office that committed on a wide dispatch, not the first refusal', async () => {
    const tileValue = (label: string): Promise<string> =>
      page.evaluate((want) => {
        const tiles = Array.from(document.querySelectorAll('#detailTiles .d-tile'));
        const hit = tiles.find((t) => t.querySelector('.d-tile-k')?.textContent?.trim() === want);
        const v = hit?.querySelector('.d-tile-v')?.cloneNode(true) as HTMLElement | undefined;
        v?.querySelector('small')?.remove();
        return v?.textContent?.trim() ?? '';
      }, label);

    const seat = async (title: string): Promise<string> => {
      const row = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'station', false, false) RETURNING seat_id`,
        [title],
      );
      return row.rows[0]!.seat_id;
    };

    const decliner = await seat('Busy Station');
    const taker = await seat('Nearest Station');
    const wide = (await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'high',
    })) as { incidentId: string };
    await post(`/incidents/${wide.incidentId}/dispatch-to`, controlRoomToken, {
      targets: [
        { kind: 'post', id: decliner },
        { kind: 'post', id: taker },
      ],
    });

    // Read the attempt ids off the detail payload, then answer for each office through the
    // same route the who-was-told panel uses.
    const detail = (await (
      await fetch(`${origin}/incidents/${wide.incidentId}`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      })
    ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
    const attemptFor = (s: string): string =>
      detail.state.notifications.find((n) => n.seatId === s)!.attemptId;

    // The refusal lands first — it is what fills the fold's single slot.
    await post(`/incidents/${wide.incidentId}/acknowledged-by`, controlRoomToken, {
      attemptId: attemptFor(decliner),
      outcome: 'confirmed',
      said: 'Unable to Respond',
    });
    await post(`/incidents/${wide.incidentId}/acknowledged-by`, controlRoomToken, {
      attemptId: attemptFor(taker),
      outcome: 'confirmed',
      said: 'Proceeding to the Site',
    });

    await openDetail(wide.incidentId);

    expect(await tileValue('Taken by')).toBe('Nearest Station');
    expect(
      await page.locator('#detailValues [data-field="acknowledged"] .prov').textContent(),
    ).toBe('by Nearest Station');
  });

  /**
   * **When the notice asked who is coming, the drawer shows ATTENDANCE, not a single answer** —
   * the Case 2 (meeting) work, Phase 2 (2026-09-10).
   *
   * A meeting has no owner and no acknowledgement clock. The fourth tile reads "Coming — N of M"
   * not "Taken by", and "The response we received" becomes "Who is coming": the summary sentence
   * and every person asked with the answer they gave. Every other kind is unchanged (test 11d /
   * 11g above still pass).
   */
  it('11h. a meeting notice shows the attendance tally in place of "Taken by"', async () => {
    const tileValue = (label: string): Promise<string | null> =>
      page.evaluate((want) => {
        const tiles = Array.from(document.querySelectorAll('#detailTiles .d-tile'));
        const hit = tiles.find((t) => t.querySelector('.d-tile-k')?.textContent?.trim() === want);
        if (hit === undefined) return null;
        const v = hit.querySelector('.d-tile-v')?.cloneNode(true) as HTMLElement | undefined;
        v?.querySelector('small')?.remove();
        return v?.textContent?.trim() ?? '';
      }, label);

    const seat = async (title: string): Promise<string> => {
      const row = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'station', false, false) RETURNING seat_id`,
        [title],
      );
      return row.rows[0]!.seat_id;
    };

    const a = await seat('Tehsildar Sadar');
    const b = await seat('Tehsildar Mamund');
    const c = await seat('Tehsildar Nawagai');
    const meeting = (await post('/incidents', controlRoomToken, {
      kind: 'meeting',
      details: { subject: 'Monthly coordination meeting' },
    })) as { incidentId: string };
    await post(`/incidents/${meeting.incidentId}/dispatch-to`, controlRoomToken, {
      targets: [
        { kind: 'post', id: a },
        { kind: 'post', id: b },
        { kind: 'post', id: c },
      ],
    });

    const detail = (await (
      await fetch(`${origin}/incidents/${meeting.incidentId}`, {
        headers: { authorization: `Bearer ${controlRoomToken}` },
      })
    ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
    const attemptFor = (s: string): string =>
      detail.state.notifications.find((n) => n.seatId === s)!.attemptId;

    await post(`/incidents/${meeting.incidentId}/acknowledged-by`, controlRoomToken, {
      attemptId: attemptFor(a),
      outcome: 'confirmed',
      said: 'Attending',
    });
    await post(`/incidents/${meeting.incidentId}/acknowledged-by`, controlRoomToken, {
      attemptId: attemptFor(b),
      outcome: 'confirmed',
      said: 'Sending someone',
    });
    // c stays silent

    await openDetail(meeting.incidentId);

    // The fourth tile is "Coming", not "Taken by" — a representative counts, so 2 of 3.
    expect(await tileValue('Taken by')).toBeNull();
    expect(await tileValue('Coming')).toBe('2 of 3');

    // "The response we received" is now "Who is coming": the summary sentence + the per-person list.
    expect(await page.locator('#detailReceived .d-block-label').textContent()).toBe(
      'Who is coming',
    );
    expect(await page.locator('#detailReceived .d-next').textContent()).toMatch(
      /2 of 3 coming — 1 attending, 1 sending someone, 1 silent/,
    );
    expect(await page.locator('#detailReceived .d-attendance li').count()).toBe(3);
    const answers = await page.locator('#detailReceived .d-attendance .answer').allTextContents();
    expect(answers).toEqual(['Attending', 'Sending someone', 'No answer yet']);
  });

  /**
   * **The group a dispatch expanded, back as a heading on the panel — Case 3, 2026-09-10.**
   *
   * `expand()` dissolves a ticked group into loose recipients at send, so the rows are ordinary
   * `.told` rows; the server reads the group's name back off `dispatched.payload.fromGroups` and
   * `renderWhoWasTold` heads them with "<group> — N of M responded". Display only — every
   * recipient is still drawn once, and a hand-picked dispatch has no heading at all.
   */
  it('11i. heads the who-was-told rows with the group a dispatch expanded', async () => {
    const seat = async (title: string): Promise<string> => {
      const row = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
         VALUES ($1, 'station', false, false) RETURNING seat_id`,
        [title],
      );
      return row.rows[0]!.seat_id;
    };

    const groupName = `All Tehsildars ${randomUUID().slice(0, 8)}`;
    const seats = [
      await seat('Tehsildar Alef'),
      await seat('Tehsildar Bey'),
      await seat('Tehsildar Pe'),
    ];
    const saved = await saveGroup(
      pool,
      { name: groupName, members: seats.map((id) => ({ kind: 'post', id })) },
      { seatId: null, personId: null },
    );
    if (!saved.ok) throw new Error(`saveGroup: ${saved.problem.kind}`);

    const said = await post('/incidents', controlRoomToken, { category: 'fire', severity: 'high' });
    const id = said['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'structure fire in the bazaar',
    });
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      groups: [saved.group.groupId],
      reason: 'every tehsildar',
    });

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told .tname', { timeout: 15_000 });

    // One heading, naming the group, and counting responses the way the rows beneath it read.
    const heads = await page.locator('#whoToldRows .toldgroup').allTextContents();
    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain(groupName);
    expect(heads[0]).toMatch(/0 of 3 responded/);

    // Every member is still a row — grouping only adds the heading.
    const names = await page.locator('#whoToldRows .told .tname').allTextContents();
    expect(names).toEqual(
      expect.arrayContaining(['Tehsildar Alef', 'Tehsildar Bey', 'Tehsildar Pe']),
    );

    // A hand-picked dispatch on another incident draws no heading at all.
    const plain = await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'high',
    });
    const plainId = plain['incidentId'] as string;
    await post(`/incidents/${plainId}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'second fire',
    });
    await post(`/incidents/${plainId}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'post', id: seats[0] }],
    });
    await openDetail(plainId);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told .tname', { timeout: 15_000 });
    expect(await page.locator('#whoToldRows .toldgroup').count()).toBe(0);
  });

  /**
   * **`Officer India — DDMA` on the "who was told" row — name AND the post held, 2026-09-07.**
   *
   * The district's own shape for this list (`backlog/whatsapp-response-workflow.md` §6),
   * person-first per ADR-0035. Test 11 covers officers holding no post — named alone; this
   * covers one who does. Only a `person` recipient composes: a `post` recipient's `.tname` is
   * already the designation.
   */
  it('11e. names a dispatched officer as "name — designation" when they hold a post', async () => {
    const said = await post('/incidents', controlRoomToken, { category: 'fire', severity: 'high' });
    const id = said['incidentId'] as string;

    const designation = `DDMA ${randomUUID().slice(0, 8)}`;
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, 'post', false, false) RETURNING seat_id`,
      [designation],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
      ['Officer India', `+92300${randomUUID().slice(0, 10)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'person', id: person.rows[0]!.person_id }],
    });

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told', { timeout: 15_000 });

    const names = await page.locator('#whoToldRows .told .tname').allTextContents();
    expect(names).toContain(`Officer India — ${designation}`);
  });

  /**
   * **A `post` dispatch reads `<holder> — <title>` on the panel** — 2026-09-08. The owner
   * dispatched to a learned proposal (a `post` target) and saw the seat title alone; the
   * panel answers *which human was reached* either way, so a post leads with its holder.
   */
  it('11f. names a dispatched post as "holder — title" on the panel', async () => {
    const said = await post('/incidents', controlRoomToken, { category: 'fire', severity: 'high' });
    const id = said['incidentId'] as string;

    const title = `IT Soft ${randomUUID().slice(0, 8)}`;
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, 'post', false, false) RETURNING seat_id`,
      [title],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
      ['Officer November', `+92300${randomUUID().slice(0, 10)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'post', id: seat.rows[0]!.seat_id }],
    });

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told', { timeout: 15_000 });

    const names = await page.locator('#whoToldRows .told .tname').allTextContents();
    expect(names).toContain(`Officer November — ${title}`);
  });

  /**
   * **Told, and the words are not in the log — the middle of three states.**
   *
   * Nothing sent before 2026-08-23 carries a `message_sent` and none can be reconstructed
   * (ADR-0026), so this is most of Bajaur's record. It must read as **unknown** and never as
   * *nothing was sent*: the `notified` events beside it say something was.
   */
  /**
   * 🔴 **This panel did not mention follow-ups at all** — D-2, 2026-08-25.
   *
   * *Who was told* exists to answer **who was told and what came back**, and until today a
   * silence nobody had chased and a silence chased three times were rendered **identically**.
   * They are opposite situations: one needs an operator to pick up the telephone, and the other
   * needs them not to ring a number a colleague rang ten minutes ago.
   *
   * ⚠️ **It sits with the tally and not on a row**, because `api/followUp.ts` re-reaches
   * **everybody** who was told — attaching it to one recipient would say something false about
   * the rest. The assertion below is deliberately about the panel, not about a row.
   */
  it('11b. says whether the control room has chased this, and how many times', async () => {
    const said = await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'high',
    });
    const id = said['incidentId'] as string;

    const row = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
      ['Chase Target', `+92300${randomUUID().slice(0, 10)}`],
    );
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'person', id: row.rows[0]!.person_id }],
    });

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .told', { timeout: 15_000 });

    /** Nothing chased yet — and the line must be absent rather than saying *never chased*. */
    expect(await page.locator('#whoToldRows .chaseline').count()).toBe(0);

    /**
     * ⚠️ **The chase is written onto the log rather than asked for through the route**, and
     * that is this file’s own habit for the same reason test 11 gives: `api/followUp.ts`
     * refuses with a **409** when WhatsApp is not configured, and nothing in this environment
     * is — there is no account here (R-05). Asking the route would test the refusal, not the
     * panel.
     *
     * `delivered: false` is the honest fixture for a district with no account, and it is also
     * the more demanding assertion: the line has to appear **and** name the failure.
     */
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: id,
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 900,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        type: 'followed_up',
        payload: { note: 'Rang the control room, no answer', delivered: false },
      } as unknown as IncidentEvent,
    ]);

    await openDetail(id);
    await expand('whoTold');
    await page.waitForSelector('#whoToldRows .chaseline', { timeout: 15_000 });

    const chase = await page.locator('#whoToldRows .chaseline').first().textContent();
    expect(chase).toContain('Chased once');
    /** The control room’s own words, quoted rather than reworded. */
    expect(chase).toContain('Rang the control room, no answer');
    /**
     * ⚠️ **And it says the chase did not go, because in this district it usually does not.**
     * There is no WhatsApp account here (R-05), which is Bajaur’s own state on most days — a line
     * that only appeared on a delivered chase would be invisible almost every time it mattered.
     */
    expect(chase).toContain('could not be sent');
  });
  it('12. says the words are not recorded, rather than drawing a blank', async () => {
    const quiet = await post('/incidents', controlRoomToken, {
      category: 'fire',
      severity: 'moderate',
    });
    const id = quiet['incidentId'] as string;
    await post(`/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'shop fire',
    });
    const row = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, 'not-a-login') RETURNING person_id`,
      ['Told Charlie', `+92300${randomUUID().slice(0, 10)}`],
    );
    await post(`/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'person', id: row.rows[0]!.person_id }],
    });

    await openDetail(id);
    await expand('detailFacts');
    await page.waitForSelector('[data-field="sent"]', { timeout: 10_000 });

    expect(await page.textContent('[data-field="sent"] .v')).toBe('not recorded');
    // The reason, not just the gap — an operator who reads "not recorded" and stops has learnt
    // nothing they can act on.
    expect(await page.textContent('[data-field="sent"] .prov')).toContain('the message went out');
  });

  it('10. goes back to the board', async () => {
    await openDetail(incidentId);
    await page.click('#back');
    await page.waitForSelector('#boardView:not([hidden])');
    expect(await page.isVisible('#detailView')).toBe(false);
  });
});
