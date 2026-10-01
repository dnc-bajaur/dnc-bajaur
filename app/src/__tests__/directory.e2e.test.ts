/**
 * Telling a whole department, and fixing the directory from where the gap is found — M9-24.
 *
 * Phase 4 in a real browser: the "Tell all N" control (M9-20), the rule it must not break
 * (M9-21), the unreachable count that rides on it (M9-22), and the add-an-officer door that
 * makes the directory maintainable without leaving the screen (M9-23).
 *
 * ## The test that matters most is the second one
 *
 * **The department row must stay unticked.** `collapseSelection` absorbs a post into its own
 * department, so a control that ticked both would send *one* message to *one* duty seat while
 * showing eight ticks on screen — the exact behaviour the client asked us to move away from,
 * wearing the appearance of the fix. `domain/__tests__/recipients.test.ts` proves the collapse
 * still happens; this proves the picker never asks for it.
 *
 * ## And the last one is the one that will rot first
 *
 * A seat with no administrative authority is offered no directory doors. That is a courtesy,
 * not a control — the server refuses those endpoints on its own (INV-05) — but a courtesy that
 * silently stops working is how a screen starts offering buttons that only ever produce 403s.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { randomUUID } from 'node:crypto';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  ensureDepartment,
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/**
 * The department the district's own history has learned to pre-tick.
 *
 * A **constant** id, unlike everything else in this file. `seedLearnedFixture` carries the
 * reasoning; the short version is that a proposal is a share of every dispatch ever made in
 * that category, and `incident_event` is append-only, so a fixture that came back as a new
 * department every run would outvote itself on the second one.
 */
const LEARNED_DEPT_ID = '5f6a1c30-9d2e-4d7b-b0a1-7c3e0f9b4d21';
const LEARNED_DEPT = 'M9 Usually Told';

/**
 * A **designation** the district's history has learned, beside the department it has learned.
 *
 * Both are needed since the directory went flat (2026-08-22), and they test opposite halves:
 * every dispatch made before that date is department-kinded, and a department has no row on this
 * screen any more — so the department fixture proves such a proposal is **dropped rather than
 * ticked invisibly**, and this one proves the band still works for the kind that can be drawn.
 *
 * Constant id, for `seedLearnedFixture`'s own reason: `incident_event` is append-only, so a
 * fixture that came back as a new seat every run would outvote itself on the second one.
 */
const LEARNED_POST_ID = '5f6a1c30-9d2e-4d7b-b0a1-7c3e0f9b4d22';
/**
 * ⚠️ **Deliberately does NOT contain `LEARNED_DEPT`.** Playwright's `hasText` is a substring
 * match, so a designation named *"M9 Usually Told Officer"* matches a filter looking for the
 * department *"M9 Usually Told"* — and test 12's assertion that the undrawable department is not
 * named would have passed or failed on the spelling rather than on the behaviour.
 */
const LEARNED_POST = 'M9 Habitual Officer';
/**
 * The two held designations `seedLearnedFixture` writes, and the only handle it has on them.
 *
 * ⚠️ **These titles are load-bearing since ADR-0030.** The fixture used to find its own holders
 * through `seat.department_id`, and migration 0039 dropped that column — so the titles are now
 * both what it writes and what it counts. Change one of them in one place and the fixture stops
 * recognising what it seeded last run, adds two more every time, and grows the roster without
 * bound, which is the exact failure its own header explains it was pinned to avoid.
 */
const LEARNED_HOLDER_TITLES = ['Learned Day Officer', 'Learned Night Officer'] as const;

describe.skipIf(dbUrl === undefined)('telling a department, and adding to it', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let admin: TestActor;
  let officer: TestActor;
  let vacantPostTitle: string;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // District tier means an administrative office (see `seedActor`), which is what carries
    // `isAdministration` — and therefore what the server answers `canEditDirectory: true` to.
    admin = await seedActor(pool, { title: 'M9 Control Room', tier: 'district' });
    // An ordinary department seat, for the last test. Its own department, no authority over
    // anybody else's roster.
    officer = await seedActor(pool, { title: 'M9 Station Officer', tier: 'post' });

    await seedLearnedFixture();

    /**
     * Three posts, deliberately unequal: one reachable, one holding a stand-in number, one
     * empty. The count on the button is the whole of M9-22 and a department where everybody is
     * reachable would not exercise it.
     */
    const post = async (title: string): Promise<string> => {
      const row = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier) VALUES ($1, 'post') RETURNING seat_id`,
        [title],
      );
      return row.rows[0]!.seat_id;
    };
    const person = async (name: string, phone: string, placeholder: boolean): Promise<string> => {
      const row = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, $3)
         RETURNING person_id`,
        [name, phone, placeholder],
      );
      return row.rows[0]!.person_id;
    };
    const hold = async (seatId: string, personId: string): Promise<void> => {
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        personId,
      ]);
    };

    await hold(await post('M9 Day Officer'), await person('M9 Day Holder', '03001110001', false));
    await hold(await post('M9 Night Officer'), await person('M9 Night Holder', '00000000', true));
    vacantPostTitle = 'M9 Relief Officer';
    await post(vacantPostTitle);

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function signIn(target: Page, who: TestActor): Promise<void> {
    await target.goto(origin);
    await target.waitForSelector('#login');
    await target.fill('#phone', who.phone);
    await target.fill('#password', TEST_PASSWORD);
    await target.click('#loginSubmit');
    await target.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
  }

  /**
   * Report an emergency and wait for the picker.
   *
   * The picker opens only **after** the report is already in the outbox and syncing — the
   * ordering M0-36 exists for, and a fact this helper quietly depends on: there is no other way
   * to reach this panel, which is itself the reason M9-23 puts the directory doors here.
   */
  async function openPicker(target: Page): Promise<void> {
    await openPickerAs(target, 'fire');
  }

  /**
   * The same thing, on a chosen one of the six categories rapid intake offers.
   *
   * Two tests need a category **this file alone dispatches in**, because what they exercise is
   * a proposal — and a proposal is a share of every dispatch ever made in that category. See
   * `seedLearnedFixture` for the whole argument.
   */
  async function openPickerAs(target: Page, category: 'fire' | 'security'): Promise<void> {
    await target.goto(origin);
    await target.waitForSelector('#submit', { timeout: 20_000 });
    await target.click(`label[for="cat-${category}"]`);
    await target.click('#submit');
    await target.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });
    await target.waitForSelector('#dispatchPanel .dgroup', { timeout: 20_000 });
  }

  /** A named department's section of the picker. */
  /**
   * A department this district's history has taught the system to pre-tick — M7-15…M7-18.
   *
   * ## Why this is a **fixed** department and not a per-run one
   *
   * Every other fixture in this file is created fresh per run, and this one deliberately is
   * not. `PROPOSE_SHARE` is 0.6 **of every dispatch ever made in that category**, and
   * `incident_event` is append-only so no fixture can clean up after itself. A per-run
   * department seeded with five dispatches owns 5/5 on the first run and 5/10 on the second,
   * which is below the threshold — the test would pass once and then fail for ever, on a
   * database nobody could reset.
   *
   * Pinning the department makes the arithmetic stable instead: every run adds five more
   * dispatches **to the same department**, so its share stays at 1.0 and the row count grows by
   * five a run rather than compounding.
   *
   * ## Why `security`
   *
   * It is one of the six categories rapid intake offers — the browser cannot report anything
   * else — and it is the one nothing in this suite dispatches in ordinarily. The `fire` history
   * is written to a new trial department by this file's own passing tests every run, which is
   * exactly the dilution described above.
   *
   * ## Why the events are written straight to the table
   *
   * They are *history*. The point is that they happened before the screen under test opened,
   * and driving five full dispatches through the browser would be five minutes of setup for a
   * fact the projection reads in one query.
   */
  async function seedLearnedFixture(): Promise<void> {
    await ensureDepartment(pool, LEARNED_DEPT_ID, LEARNED_DEPT);

    /**
     * Two reachable holders, once, ever. `Tell all` has to have more than one person to fold,
     * and re-adding them every run would grow the roster without bound.
     *
     * ⚠️ **COUNTED BY TITLE SINCE ADR-0030, and that is not a weaker question.** This asked
     * `WHERE s.department_id = $1` — a column migration 0039 dropped — and the department it
     * named was the fixture's own. There is one flat roster now, so the two seats are found the
     * only way left and the only way that was ever meaningful here: **by the titles this fixture
     * writes**. A count over the whole district would answer *does Bajaur have two officers*,
     * which is true on any database and would let the fixture silently stop seeding itself.
     */
    const holders = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM seat s
         JOIN duty_assignment d ON d.seat_id = s.seat_id AND d.to_at IS NULL
         JOIN person p ON p.person_id = d.person_id
        WHERE s.title = ANY($1::text[]) AND s.retired_at IS NULL
          AND p.removed_at IS NULL AND NOT p.placeholder`,
      [LEARNED_HOLDER_TITLES],
    );

    if (Number(holders.rows[0]!.n) < 2) {
      for (const [title, name, phone] of [
        [LEARNED_HOLDER_TITLES[0]!, 'Learned Day Holder', '03007770001'],
        [LEARNED_HOLDER_TITLES[1]!, 'Learned Night Holder', '03007770002'],
      ]) {
        const seat = await pool.query<{ seat_id: string }>(
          `INSERT INTO seat (title, tier) VALUES ($1, 'post') RETURNING seat_id`,
          [title],
        );
        const person = await pool.query<{ person_id: string }>(
          `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, false)
           RETURNING person_id`,
          [name, phone],
        );
        await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
          seat.rows[0]!.seat_id,
          person.rows[0]!.person_id,
        ]);
      }
    }

    /**
     * A learned **designation**, held by somebody reachable — the kind this screen can draw.
     *
     * `ON CONFLICT DO NOTHING` on a fixed id, so five runs do not make five seats.
     */
    await pool.query(
      `INSERT INTO seat (seat_id, title, tier)
       VALUES ($1, $2, 'post') ON CONFLICT (seat_id) DO NOTHING`,
      [LEARNED_POST_ID, LEARNED_POST],
    );
    const held = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM duty_assignment WHERE seat_id = $1 AND to_at IS NULL`,
      [LEARNED_POST_ID],
    );
    if (Number(held.rows[0]!.n) === 0) {
      const holder = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, false)
         RETURNING person_id`,
        ['M9 Habitual Holder', '03007770003'],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        LEARNED_POST_ID,
        holder.rows[0]!.person_id,
      ]);
    }

    // `PROPOSE_TIMES` is 5, at a share of 1.0 — see the note above for why this may be added
    // to on every run without ever going below the threshold.
    //
    // **Both kinds on the same dispatch**, so one fixture serves both halves: the department is
    // the history every real district already has, and the designation is what history looks
    // like from today.
    for (let i = 0; i < 5; i += 1) {
      const incidentId = randomUUID();
      await pool.query(
        `INSERT INTO incident_event
           (event_id, incident_id, type, occurred_at, source_channel, payload, client_seq)
         VALUES ($1, $2, 'reported', now(), 'test', $3::jsonb, 1),
                ($4, $2, 'dispatched', now(), 'test', $5::jsonb, 2)`,
        [
          randomUUID(),
          incidentId,
          JSON.stringify({ category: 'security' }),
          randomUUID(),
          JSON.stringify({
            targets: [
              { kind: 'department', id: LEARNED_DEPT_ID },
              { kind: 'post', id: LEARNED_POST_ID },
            ],
          }),
        ],
      );
    }
  }

  /** The trial department's section of the picker, found by its heading. */
  /**
   * The picker's one list.
   *
   * ⚠️ **There are no department sections any more.** This and its deleted sibling
   * `sectionNamed` both used to find a `.dgroup` by its `<h3>`, which was a department's name.
   * The directory went flat on 2026-08-22 and the picker draws **one** section with no heading,
   * so there is nothing left to pick between — use `contact` to reach a row.
   */
  function section(target: Page) {
    return target.locator('#dispatchPanel .dgroup');
  }

  /** One contact row, found by the designation on it. */
  function contact(target: Page, designation: string) {
    return target.locator('#dispatchPanel .dpick').filter({ hasText: designation });
  }

  /**
   * 🔴 **ONE ROW PER OFFICER — the district's own complaint, in a browser.**
   *
   * This file's tests 1–3 were built on *"Tell all N"* (M9-20), a control that ticked every
   * officer in **one department's section**. There are no department sections left, and on one
   * flat list that button becomes **"Tell all 40"** — the whole district in a click, beside the
   * checkbox somebody is aiming for at 02:00.
   *
   * What it measured is now measured here instead: the picker draws each officer **once**, and
   * the two kinds that made one person into three rows are gone from it entirely.
   */
  it('1. draws one flat list, with no department heading and no department row', async () => {
    await signIn(page, admin);
    await openPicker(page);

    const list = section(page);
    await expect.poll(() => list.count(), { timeout: 20_000 }).toBe(1);

    // No heading over the only section: a word that says nothing is a word people stop reading.
    expect(await list.locator('h3').count()).toBe(0);

    // The kinds that produced 200 rows for 40 handsets.
    expect(await page.locator('#dispatchPanel .dpick.k-department').count()).toBe(0);
    expect(await page.locator('#dispatchPanel .dpick.k-person').count()).toBe(0);
  });

  it('2. draws a held post as its holder, with the designation on a line beneath', async () => {
    const row = contact(page, 'M9 Day Officer');
    await expect.poll(() => row.count(), { timeout: 20_000 }).toBe(1);

    // Name-first — a phone's contact list: the holder's name is the label (2026-09-02), and the
    // post drops to a quieter line under it.
    expect(await row.locator('.dlabel').innerText()).toBe('M9 Day Holder');
    expect(await row.locator('.ddesig').innerText()).toBe('M9 Day Officer');

    // And the officer is not also present as a person row of their own.
    expect(
      await page.locator('#dispatchPanel .dpick').filter({ hasText: 'M9 Day Holder' }).count(),
    ).toBe(1);
  });

  /**
   * ⚠️ **A guard against "Tell all" coming back, and it is worth a test of its own.**
   *
   * The control was safe while it meant *this department's officers*. On a flat list the same
   * code means *everybody in Bajaur*, one click from the search box — a way to alert the district
   * by accident. The district asked for the alternative in the same breath: *"humein agar
   * zaroorat hai to Groups ki hai"*, and a saved group is a named set somebody chose.
   */
  it('3. offers no control that ticks the whole list at once', async () => {
    expect(await page.locator('#dispatchPanel .dall').count()).toBe(0);
  });

  it('4. turns a search that finds nobody into the offer to add them', async () => {
    // The moment M9-23 is about: an operator types a name at 02:00 and the district has never
    // had it. Before this, the screen said "nothing matches" and stopped.
    await page.fill('#dispatchPanel .dsearch', 'Zzq Unlikely Officer');
    await page.waitForSelector('#dispatchPanel .doffer', { timeout: 10_000 });

    /**
     * ⚠️ **ONE OFFER, NOT TWO — ADR-0029.** *"Add a department"* stood beside *"Add an officer"*
     * and has gone with the layer. A door onto a thing the district has just been told does not
     * exist is the screen arguing for the old model.
     */
    const offer = page.locator('#dispatchPanel .doffer .dadd');
    expect(await offer.count()).toBe(1);

    await offer.first().click();
    const form = page.locator('#dispatchPanel .dform');
    await form.waitFor({ timeout: 10_000 });

    // What they already typed, carried across. Asking somebody to type a name twice is how a
    // good offer gets declined.
    expect(await form.locator('.dfname').inputValue()).toBe('Zzq Unlikely Officer');

    /**
     * 🔴 **THE DEPARTMENT SELECT IS GONE, AND ITS ABSENCE IS THE ASSERTION.**
     *
     * This used to require exactly one `.dfdept`, because the form had to ask where somebody was
     * filed. M9-23's own defect was that select coming back **empty** — and with ADR-0029 it
     * empties for good, so a form that still asked would refuse every submit and the only door
     * the district has to their own directory would look broken rather than removed.
     *
     * What is required instead is the third of the district's three fields: **the designation,
     * typed.**
     */
    expect(await form.locator('.dfdept').count()).toBe(0);
    expect(await form.locator('.dfpost').count()).toBe(1);

    await form.locator('.dfcancel').click();
    await page.fill('#dispatchPanel .dsearch', '');
  });

  it('5. adds a contact from three fields, and it is on the list and ticked', async () => {
    /**
     * ⚠️ **THIS TEST ASSERTED THE REVERSE, AND THE OLD VERSION WAS RIGHT WHEN WRITTEN.**
     *
     * It filled a **vacancy that already existed** — pick the department, pick one of its empty
     * posts, watch the row stop being unreachable — and that was the whole point of adding from
     * this screen: the gap was found and closed mid-call, on the row that carried it.
     *
     * ADR-0029 removed the premise rather than the value. There are no departments to pick, and
     * the district asked to stop being shown vacancies at all — migration 0038 retires every
     * seat nobody holds. A contact's designation is now **created in the same breath as the
     * person**, so there is nothing standing empty to fill.
     *
     * What survives is what actually mattered: an operator on a call finds the name missing,
     * adds it **here**, and can tell them without leaving the screen. That is what this asserts.
     */
    const designation = `CD Added Post ${Date.now()}`;

    await page.locator('#dispatchPanel .dbar .dadd').click();
    const form = page.locator('#dispatchPanel .dform');
    await form.waitFor({ timeout: 10_000 });

    // The district's three fields, and nothing else to answer.
    expect(await form.locator('.dfdept').count()).toBe(0);
    await form.locator('.dfname').fill('CD Added Officer');
    await form.locator('.dfpost').fill(designation);
    await form.locator('.dfphone').fill('03009998877');
    await form.locator('.dfsave').click();

    // The form closes, the directory is re-read, and the contact is on the list.
    await expect
      .poll(() => page.locator('#dispatchPanel .dform').count(), { timeout: 20_000 })
      .toBe(0);

    const added = contact(page, designation);
    await expect.poll(() => added.count(), { timeout: 20_000 }).toBe(1);

    /**
     * 🔴 **REACHABLE, NOT A VACANCY — and this is the assertion that would catch a half-written
     * transaction.**
     *
     * `createContact` writes the seat, the person and the duty assignment together. If any of
     * that were split, the add would still answer 201 and the row would still appear — carrying
     * `unreachable`, which is precisely the thing the district asked to stop seeing.
     */
    await expect
      .poll(async () => (await added.getAttribute('class')) ?? '', { timeout: 20_000 })
      .not.toContain('unreachable');

    // Ticked, because telling them is why they were added — and visibly so.
    expect(await added.locator('input').count()).toBeGreaterThan(0);
    expect(await added.locator('input').isChecked()).toBe(true);
  });

  it('6. offers no directory doors at all to a seat with no authority over the roster', async () => {
    // A courtesy, not a control: `/admin/departments` and `/roster/:id/people` refuse this seat
    // on their own (INV-05). Drawing a button that can only ever produce a 403 is how a screen
    // teaches an operator to distrust it.
    const plain = await browser.newContext();
    const plainPage = await plain.newPage();
    try {
      await signIn(plainPage, officer);
      await openPicker(plainPage);

      // `:visible`, not presence. The standing "Add a department" button is built once when the
      // panel mounts and hidden by `tools.hidden` until the server says otherwise — so counting
      // it in the DOM would pass for the wrong reason and keep passing if the hiding broke.
      expect(await plainPage.locator('#dispatchPanel .dadd:visible').count()).toBe(0);
      expect(await plainPage.locator('#dispatchPanel .dtools').isHidden()).toBe(true);

      await plainPage.fill('#dispatchPanel .dsearch', 'Zzq Unlikely Officer');
      await plainPage.waitForSelector('#dispatchPanel .cnone', { timeout: 10_000 });
      expect(await plainPage.locator('#dispatchPanel .doffer').count()).toBe(0);
    } finally {
      await plain.close();
    }
  });
  /**
   * **The row says who they are and what they do — M10-06.**
   *
   * The district's words: a person's row should read *Name, Designation, Department*. It read
   * the name alone, and the consequence was the search: `paint()` filtered on `label`, so an
   * operator typing **"DHO"** or **"Health"** into a box whose own placeholder promises
   * *"departments, designations and officers"* found **nobody**.
   *
   * That is the search this screen is asked for most. At 02:00 the control room knows the post
   * it needs and not the name of whoever holds it tonight — and the one search they could do
   * was the one that needed the answer already.
   *
   * The department is deliberately **not** on the row: it is the `<h3>` the row already sits
   * under, and repeating it would print one department name eighty times down one screen.
   */
  it('7. finds a contact by the designation and by the holder’s name', async () => {
    await page.fill('#dispatchPanel .dsearch', '');
    await page.waitForSelector('#dispatchPanel .dgroup', { timeout: 10_000 });

    /**
     * **Both searches, because an operator at 02:00 knows one or the other and rarely both.**
     *
     * M10-06 widened this from `label` alone precisely for the first case: typing a designation
     * used to find nobody, on a box whose own placeholder promised it would. Flattening the
     * directory did not narrow it, and neither did making the row name-first (2026-09-02) — the
     * designation and the holder's name are both on the one row, so it answers both spellings.
     */
    await page.fill('#dispatchPanel .dsearch', 'M9 Day Officer');
    await expect.poll(() => contact(page, 'M9 Day Holder').count(), { timeout: 10_000 }).toBe(1);

    await page.fill('#dispatchPanel .dsearch', 'M9 Day Holder');
    await expect.poll(() => contact(page, 'M9 Day Officer').count(), { timeout: 10_000 }).toBe(1);

    await page.fill('#dispatchPanel .dsearch', '');
  });
  /**
   * 🔴 **EVERY CONTACT IS DRAWN, AND THIS TEST ASSERTED THE OPPOSITE UNTIL 2026-08-22.**
   *
   * M10-08 kept a **post** row off the screen whenever somebody reachable held it, because the
   * **person** row beside it already reached that handset — one officer, two rows, and this
   * chose which to show. There is no person row now: the post **is** the contact.
   *
   * So the old rule would hide the officer outright rather than de-duplicate them. It is gone,
   * and what replaces it is simpler and stronger: **everything the district has is on the list.**
   *
   * ⚠️ **The unreachable ones must still be there, and that half never changed.**
   * `assertOfferedAnyway` exists because a vacant post hidden from the picker is a vacancy hidden
   * from the one person about to notice it, and because a vacant post that swallows an obligation
   * produces silence — which reads as *everybody was told*. The audit found Rescue 1122's own
   * District Emergency Officer is exactly this shape: **vacant, no number**.
   */
  it('8. draws every contact — the reachable one as well as the vacant and the stand-in', async () => {
    await page.fill('#dispatchPanel .dsearch', '');
    await expect.poll(() => section(page).count(), { timeout: 10_000 }).toBe(1);

    const titles = await section(page).locator('.dpick .dlabel').allInnerTexts();

    // The reachable contact, which the old rule removed from the screen — held by a real person
    // now, so its label is that person's name; `contact()` still finds it by the designation.
    expect(await contact(page, 'M9 Day Officer').count()).toBe(1);
    expect(titles).toContain('M9 Day Holder');

    // The stand-in: no real holder, so the designation stays its label. Still offered, still
    // marked, still selectable.
    expect(titles).toContain('M9 Night Officer');
    expect(await contact(page, 'M9 Night Officer').getAttribute('class')).toContain('unreachable');

    // And a reachable contact is not marked — the mark still means something.
    expect(await contact(page, 'M9 Day Officer').getAttribute('class')).not.toContain(
      'unreachable',
    );
  });

  /**
   * 🔴 **A PROPOSAL THIS SCREEN CANNOT DRAW IS DROPPED, NEVER TICKED INVISIBLY — M10-09's fault,
   * arriving through a door the flat directory opened on 2026-08-22.**
   *
   * A target that is **ticked and not drawn** is the worst thing this panel can do: it sends, it
   * records, and it shows no tick anybody could have disagreed with. This project's worst
   * signature — *the action succeeds*.
   *
   * `learning.ts` proposes out of the district's own dispatch history, and **every dispatch made
   * before today is department-kinded**. A department has had no row since the directory went
   * flat. So on any district with five nights behind it, opening the picker would have pre-ticked
   * a department nobody could see — not one row in one table away, but **already true of the live
   * installation on the morning this shipped**.
   *
   * New history is post-kinded and drains this by itself, which is why the fixture writes both:
   * the department is what Bajaur already has, the designation is what history looks like from
   * today. This test holds both halves against each other.
   */
  it('9. drops a learned department it cannot draw, and still pre-ticks a learned designation', async () => {
    // `security`, not `fire`: the proposal is a share of every dispatch in the category, and
    // this file's own passing tests write `fire` history to a new department every run.
    await openPickerAs(page, 'security');
    await expect.poll(() => section(page).count(), { timeout: 20_000 }).toBe(1);

    // The department: no row, and therefore no tick.
    expect(await page.locator('#dispatchPanel .dpick.k-department').count()).toBe(0);

    // The designation: drawn, and ticked by the proposal — M7-18, a proposal says why beside it.
    const learned = contact(page, LEARNED_POST);
    await expect.poll(() => learned.count(), { timeout: 20_000 }).toBe(1);
    await expect
      .poll(() => learned.locator('input').first().isChecked(), { timeout: 10_000 })
      .toBe(true);
  });

  /**
   * **Vacancies fold, and a chosen one is never hidden — M10-34.**
   *
   * 38 of Bajaur's 82 posts are vacant (M10-05), so in the worst department M10-08 leaves a
   * column of grey rows standing between the operator and the officers they came for. The count
   * is never folded away — only the rows — because a vacancy nobody can see is a vacancy nobody
   * fills.
   *
   * ⚠️ **The second half is the one that would ship broken.** *Tell all N* deliberately ticks
   * vacant posts (M9-22: recorded as owed a message). Folding them after the tick would put
   * ticks on the screen that cannot be seen or undone — the invisible-selection fault M10-09 was
   * written about, arriving from the other direction.
   */
  it('10. folds vacancies into one line, and opens it rather than hiding a tick', async () => {
    /**
     * ⚠️ Its own vacancy, because **test 5 filled the one this file seeded** — that is what that
     * test is for. A test that depends on an earlier test's subject still existing passes until
     * somebody reorders the file, and then fails for a reason that has nothing to do with the
     * code.
     */
    const spare = 'M10 Spare Officer';
    await pool.query(`INSERT INTO seat (title, tier) VALUES ($1, 'post')`, [spare]);

    await openPicker(page);
    const group = section(page);
    await expect.poll(() => group.count(), { timeout: 20_000 }).toBe(1);

    const fold = group.locator('.dfold');
    await expect.poll(() => fold.count(), { timeout: 10_000 }).toBe(1);
    expect(await fold.textContent()).toMatch(/^\d+ designations? vacant — show$/);

    // The vacancy is not on the screen while it is folded.
    const relief = group.locator('.dpick.k-post').filter({ hasText: spare });
    expect(await relief.count()).toBe(0);

    await fold.click();
    await expect.poll(() => relief.count(), { timeout: 10_000 }).toBe(1);
    // Opened, and still marked as the gap it is — folding is not a way of calling it reachable.
    expect(await relief.first().getAttribute('class')).toContain('unreachable');
  });

  /**
   * **The number is on the row — M10-38 — and somebody with no post is their name alone —
   * M10-39.**
   *
   * The number matters because *"Reach them"* is the entire system on the night the API is down,
   * a rule kept unchanged from the 2026-08-03 reversal. It also makes a shared handset visible:
   * `03000000171` belongs to Kamran Ali **and** Kamran Aziz in the live directory, which is
   * why `collapseSelection` must never deduplicate by number.
   */
  it('11. puts the number on the row, and never a blank designation', async () => {
    await openPicker(page);
    const row = contact(page, 'M9 Day Officer');
    await expect.poll(() => row.count(), { timeout: 20_000 }).toBe(1);

    /**
     * **The number, on the row — M10-38.**
     *
     * The district asked for it and it is the one thing on this screen an operator sometimes has
     * to read out loud: the API is down and *"Reach them"* is the whole system. Hunting for it on
     * another screen at 02:00 is how a district goes back to a personal handset and the record
     * stops existing.
     */
    expect(await row.locator('.dnum').innerText()).toBe('03001110001');

    // M10-39: never a dimmed "no designation". Every contact IS a designation now, so the
    // element this guards against has nothing left to describe.
    expect(await page.locator('#dispatchPanel .ddesig.none').count()).toBe(0);
  });

  /**
   * **"Already ticked for you", above the scroller — M10-37.**
   *
   * `learning.ts` has pre-ticked rows for a milestone — the routing signals did too until
   * ADR-0022 — and the only place that was ever said was **beside the tick**, which can be the
   * fortieth row of eighty inside a 22rem scroller. A pre-selection nobody has seen is one they cannot disagree with,
   * and M7-18's whole point is that a proposal must be arguable.
   *
   * It ticks nothing: every name in it is already in `chosen`, so unticking the row empties the
   * band. That is the assertion — a band that kept naming somebody after they were removed would
   * be describing a send that is not going to happen.
   */
  it('12. names what was already ticked, and stops naming it when it is unticked', async () => {
    await openPickerAs(page, 'security');

    const band = page.locator('#dispatchPanel .dhint');
    await expect.poll(() => band.count(), { timeout: 20_000 }).toBe(1);

    const row = band.locator('.dhintrow').filter({ hasText: LEARNED_POST });
    expect(await row.count()).toBe(1);

    // ⚠️ And the department it cannot draw is not named here either — a band that named a tick
    // with no row would be describing a send nobody could disagree with. See test 9.
    expect(await band.locator('.dhintrow').filter({ hasText: LEARNED_DEPT }).count()).toBe(0);
    /**
     * Why, in words, before any scrolling.
     *
     * It named the routing signal that matched. It names how often the district has done this
     * itself now — `learned.because` carries both numbers rather than a percentage, because
     * *"90%"* reads identically at nine-of-ten and ninety-of-a-hundred. Asserted as *a sentence
     * with a number in it* rather than as fixed words, because the numerator grows by five
     * every time this suite runs.
     */
    expect(await row.locator('.dhintwhy').innerText()).toMatch(/[0-9]/);

    // Untick the contact it is describing; the band must let go of it.
    await contact(page, LEARNED_POST).locator('input').first().uncheck();
    // `:visible`, not presence — the row is hidden rather than removed, so counting it in the
    // DOM would pass for the wrong reason and keep passing if the hiding broke.
    await expect
      .poll(() => band.locator('.dhintrow:visible').filter({ hasText: LEARNED_POST }).count(), {
        timeout: 10_000,
      })
      .toBe(0);
  });
});
