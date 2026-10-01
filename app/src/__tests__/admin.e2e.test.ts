/**
 * The administration console on a real screen — M1a.
 *
 * `api/__tests__/admin.test.ts` proves the endpoints. This proves the things that only exist
 * once something renders them, and that a JSON test cannot see:
 *
 *   1. **The tab is not offered to a department**, and — the part that matters — offering it
 *      was never the control. A department seat that reaches the endpoint anyway is refused
 *      by the server (INV-05).
 *   2. **The whole loop happens in a browser.** An operator types a department name, and an
 *      emergency reaches it. No developer, no restart, no code.
 *   3. **Unassigned emergencies are loud.** Above the summary, above every row, in words
 *      (ADR-0005, INV-04).
 *
 * ⚠️ There was a fourth — *a department with no routing signal says so* — and it went with
 * ADR-0022 along with the thing it was about. Its lesson outlived it and is written into the
 * console: an amber edge and a per-card warning were spent on 154 of 159 departments, for a
 * gap the district had chosen not to close, and the one card that genuinely meant an alert
 * would reach nobody had nothing left to stand out against.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  seedDepartment,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/** Unique per run: departments are never deleted, so a fixed name collides on the second run. */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('M1a: the administration console', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let dc: TestActor;
  let rescue: TestActor;

  async function signIn(actor: TestActor): Promise<void> {
    // Clear the session first, or the sign-in form is not there to fill in.
    //
    // The suite signs in as two different officers, and the second call sat waiting for a
    // `#login` that stays hidden while somebody is still signed in — which is the app
    // behaving correctly. Sessions are HttpOnly cookies, so dropping the cookie is how a
    // test starts from signed-out; reaching for the sign-out button would only work when
    // the previous test happened to leave the page in a state that shows one.
    await context.clearCookies();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  /**
   * Poll in the test process until a condition holds.
   *
   * Not `page.waitForFunction`. Given an async callback it resolves on the returned Promise
   * object, which is always truthy, so it succeeded instantly and the assertion after it read
   * a value the server had not been given yet. That produced a failure that looked like the
   * SLA configuration being ignored, and was a broken wait.
   */
  async function until<T>(read: () => Promise<T>, holds: (v: T) => boolean): Promise<T> {
    const deadline = Date.now() + 10_000;
    let last = await read();
    while (!holds(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      last = await read();
    }
    return last;
  }

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

    const dcDept = await seedDepartment(pool, `DC Office (e2e ${RUN})`);

    dc = await seedActor(pool, {
      title: `Deputy Commissioner (e2e ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });
    rescue = await seedActor(pool, { title: `Rescue Duty (e2e ${RUN})`, tier: 'post' });

    // Nothing to neutralise since ADR-0022 — an incident arrives held by nobody whatever the
    // shared test database is carrying. See the same note in `api/__tests__/admin.test.ts`.

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * Close anything modal this test left open.
   *
   * 🔴 **Found by watching test 4b fail on purpose.** A `<dialog>` opened with `showModal()`
   * makes the rest of the page inert, so an assertion that fails while one is open leaves
   * every later test unable to click anything: one red test became six, all of them timeouts,
   * and none of them about their own subject. A failing test may cost its own assertion and
   * must never cost the file.
   */
  afterEach(async () => {
    await page?.evaluate(() => {
      document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((open) => {
        open.close();
      });
      document.querySelectorAll('dialog.ask').forEach((stale) => {
        stale.remove();
      });
      // The Directory tab's drawer is a `.backdrop`, not a `<dialog>` — a failure that leaves it
      // `open` covers the page for every later test exactly as an inert modal would.
      document.getElementById('adminDrawerBackdrop')?.classList.remove('open');
    });
  });
  it('1. does not offer the console to a department seat', async () => {
    await signIn(rescue);
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });

  it('2. and refuses it server-side when the tab is bypassed entirely (INV-05)', async () => {
    // The tab being hidden is a courtesy. This is the control. A department officer who
    // knows the URL — or a stolen session in a script — gets the same answer.
    const status = await page.evaluate(async () => {
      const res = await fetch('/admin/departments');
      return res.status;
    });
    expect(status).toBe(403);
  });

  it('3. offers it to the administration', async () => {
    await signIn(dc);
    await page.waitForSelector('#navAdmin:not([hidden])');
    expect(await page.locator('#navAdmin').isVisible()).toBe(true);
  });

  /**
   * The console lands on a summary of the district's own setup, and every figure on it is a
   * door to the tab that fixes what it names.
   *
   * **Why this is a test and not a screenshot:** the failure it guards is a figure that leads
   * nowhere. Nine flat tabs told an operator nothing about where a vacancy or a missing office
   * number is fixed, and a landing screen that only *states* those numbers would be the same
   * screen with more reading. The assertion is therefore on the **journey** — click the
   * departments figure, arrive at the departments — not on the number, which a shared test
   * database makes a measurement of the clock rather than of the console.
   *
   * It also pins the nav's handles. Every `data-tab` value is a contract four suites address
   * these buttons by. `layout` and `capabilities` left for the Settings panel (ADR-0032 phase
   * 4), leaving a signpost the way Performance did.
   */
  it('3b. lands on an overview whose figures are doors', async () => {
    await page.click('#navAdmin');
    await page.waitForSelector('#adminOverview');

    // Grouped, not one flat row. The signpost box counts as a `.tabgroup` for layout but has no
    // name of its own.
    expect(await page.locator('#adminTabs .tabgroup').count()).toBe(4);
    expect(await page.locator('#adminTabs .tabgroupname').allTextContents()).toEqual([
      'The district',
      'Records',
    ]);

    for (const handle of [
      'overview',
      'departments',
      'deadlines',
      // ⚠️ **`roster` belongs here.** It was dropped from this loop on 2026-09-01 to match a nav
      // that had lost the button in `9ddf42d` — read then as ADR-0029 folding the roster into the
      // Directory tab. ADR-0029 does not mention the roster, and `renderDepartments` builds a
      // phone book from `/roster/contacts` and mounts no roster panel, so nothing folded: the
      // button had been deleted by a commit that only meant to rename a label. Asserting it here
      // again is what stops that happening a third time.
      'roster',
      'groups',
      // 'layout' and 'capabilities' are gone — moved to the Settings panel (ADR-0032 phase 4).
      // 'performance' is deliberately absent — the Record draws those figures now (2026-08-19).
      'backups',
      'history',
    ]) {
      expect(
        await page.locator(`#adminTabs button[data-tab="${handle}"]`).count(),
        `the ${handle} tab lost its handle`,
      ).toBe(1);
    }
    for (const gone of ['layout', 'capabilities']) {
      expect(
        await page.locator(`#adminTabs button[data-tab="${gone}"]`).count(),
        `the ${gone} tab should have moved to Settings`,
      ).toBe(0);
    }
    // The door left where the group stood.
    expect(await page.locator('#installationMoved').textContent()).toContain('Settings');

    // ⚠️ **The overview is four `.g-card`s now, not `.orow` rows with a `data-go` button.** The
    // rows went in the console's own redesign; this test kept asserting them and hung for the
    // full 30s on a `.orow` that no longer renders — the claim below is the same one, read off
    // the markup that is actually there.
    //
    // The record's two questions stay two clauses on one card: a dump on the disk covers a bad
    // restore, and only a copy that left the district covers the building.
    const record = page.locator('.g-card', { hasText: 'The Record & Backups' });
    expect(await record.locator('.g-desc').textContent()).toContain('·');

    // The door. The whole card is the control — there is no separate button inside it.
    await page.locator('.g-card', { hasText: 'District Directory' }).click();
    await page.waitForSelector('#adminDepartments');
  });

  /**
   * ⚠️ **The M1a gate is not failed, it is ANSWERED — ADR-0030.**
   *
   * It added a **department** and routed an emergency to it. `POST /admin/departments` is a 404
   * now and `/route` takes ids for rows that do not exist, so the gate as written could not run.
   *
   * What the gate has to prove is unchanged and is the whole reason it exists: **the registry is
   * live** — a person types a new entry on a screen, with no developer and no restart, and an
   * emergency reported a moment later can be given to it. The thing an operator adds is a
   * **post**, and the way an emergency reaches somebody is a **dispatch**. `admin.test.ts` holds
   * the server's half of this; here it happens on the screen, in a browser.
   */
  it('4. the gate: an operator adds a post and an emergency reaches it', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="roster"]');
    await page.waitForSelector('#rosterBody');

    // Typed into the form, by a person, on a screen.
    const title = `Canal Officer e2e ${RUN}`;
    await page.fill('.addpost .tt', title);
    await page.click('.addpost button');

    const card = page.locator('.post', { hasText: title });
    await card.waitFor();

    // The gap the roster exists to close, named on the card rather than left to a blank space.
    expect(await card.locator('.nobody').textContent()).toContain('reaches no one');

    const seatId = await card.getAttribute('data-post');
    expect(seatId).toBeTruthy();

    /**
     * The loop the gate is about, with the half that changed shown plainly: the emergency
     * arrives held by nobody, and a person on this screen gives it to the post that did not
     * exist a minute ago. Nothing restarted, no code names it.
     */
    const outcome = await page.evaluate(
      async ([post]) => {
        const res = await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'flooding',
            description: 'the nehr has breached near Nawagai',
          }),
        });
        const created = (await res.json()) as {
          incidentId: string;
          routedTo: string[];
          unassigned: boolean;
        };

        const told = await fetch(`/incidents/${created.incidentId}/dispatch-to`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            targets: [{ kind: 'post', id: post }],
            reason: 'the canal is theirs',
          }),
        });

        return { created, toldStatus: told.status };
      },
      [seatId],
    );

    expect(outcome.created.unassigned).toBe(true);
    expect(outcome.created.routedTo).toEqual([]);
    expect(outcome.toldStatus).toBe(200);
  });

  /**
   * A destructive configuration change **confirms** in the app — it says what the action costs
   * before it happens, and Esc means nothing happened — but it no longer asks the operator
   * *why*. An ordinary edit is not an interrogation (2026-09-01).
   *
   * The server and the config log still require a reason (INV-06 — the actor, the seat and the
   * time are what that invariant turns on), so the console sends a fixed one; the dialog has no
   * text field at all.
   *
   * ⚠️ **The drift this comment used to warn about is fixed below, 2026-09-08.** It read: *the
   * `{ name: 'Retire' }` selector is stale — the button reads Delete Group and lives in the
   * group's edit drawer.* That was correct, and the note was written on 2026-09-01 in place of
   * the repair because the suite could not be run: `format:check` sits ahead of `test` in
   * `npm run check` and had been failing on whitespace since 2026-08-28. A known-red test with
   * an accurate comment is still a test that proves nothing, and this one is the only browser
   * coverage the console's destructive actions have.
   */
  it('4b. confirms a destructive config change, states the cost, and Esc means nothing', async () => {
    /**
     * ⚠️ **THE DOOR MOVED, THE DIALOG DID NOT — ADR-0030.**
     *
     * This retired a **department** to open `ask()`. `POST /admin/departments` is a 404 now, so
     * the card never appeared and the only browser coverage the console's destructive
     * configuration actions have ever had sat out its timeout, testing nothing.
     *
     * Retiring a **group** goes through the same `ask()` with the same `danger: true` and the
     * same INV-06 obligation, and groups are alive. The three assertions are unchanged, and they
     * are still the three things `prompt()` could not do.
     */
    await page.click('#adminTabs button[data-tab="groups"]');
    await page.waitForSelector('#adminGroups');

    /**
     * ⚠️ **BOTH DOORS MOVED INTO THE DRAWER, AND THIS TEST SAT OUT ITS TIMEOUT ON THE OLD ONES.**
     *
     * The Groups tab used to carry a blank `.card[data-group="new"]` with a `.gname` input and a
     * *Create group* button, and each card carried its own *Retire*. The redesign made both a
     * drawer: `+ Create New Group` in the header opens it empty, clicking a card opens it on that
     * group, and the destructive action inside reads **Delete Group**.
     *
     * The comment above this test named that drift on 2026-09-01 and left it red. It stayed red
     * because `format:check` was failing, so nothing ran to make the case. The three assertions
     * are still the three things `prompt()` could not do — only the journey to them is rewritten.
     */
    const name = `Retire e2e ${RUN}`;
    const drawer = page.locator('#adminDrawerBackdrop');

    const before = await page.$$eval('#adminGroups .g-card', (cards) =>
      cards.map((c) => (c as HTMLElement).dataset['group'] ?? ''),
    );

    await page.click('#adminGroups button:has-text("+ Create New Group")');
    await drawer.waitFor({ state: 'visible' });
    await drawer.locator('.d-input').first().fill(name);
    await drawer.getByRole('button', { name: 'Create Group' }).click();

    // Found by id, never by name — the card renders the name inside its own markup and a
    // freshly created group is the one id that was not on screen a moment ago.
    const handle = await page.waitForFunction((prev: string[]) => {
      const ids = Array.from(document.querySelectorAll('#adminGroups .g-card')).map(
        (c) => (c as HTMLElement).dataset['group'] ?? '',
      );
      return ids.find((id) => id !== '' && !prev.includes(id)) ?? false;
    }, before);
    const groupId = (await handle.jsonValue()) as string;
    const card = page.locator(`#adminGroups .g-card[data-group="${groupId}"]`);
    await card.waitFor();

    // The card is the door onto the drawer; the drawer is where the destructive action lives.
    await card.click();
    await drawer.waitFor({ state: 'visible' });
    await drawer.getByRole('button', { name: 'Delete Group' }).click();

    const dialog = page.locator('dialog.ask[open]');
    await dialog.waitFor();

    // The consequence, before the act rather than discovered after it.
    expect(await dialog.locator('.askbody').textContent()).toContain('stops being offered');
    // A plain confirmation — no reason field, nothing to type.
    expect(await dialog.locator('.askinput').count()).toBe(0);
    expect(await dialog.locator('.askyes').isDisabled()).toBe(false);

    // Esc is the browser's own "I did not mean this", and it must change nothing at all — the
    // dialog goes, the drawer behind it stays open, and the group is still there.
    await page.keyboard.press('Escape');
    expect(await page.locator('dialog.ask').count()).toBe(0);
    expect(await page.locator(`#adminGroups .g-card[data-group="${groupId}"]`).count()).toBe(1);

    // Again, and confirm this time.
    await drawer.getByRole('button', { name: 'Delete Group' }).click();
    await dialog.waitFor();
    await dialog.locator('.askyes').click();

    // Deleted means gone from the editor — a deleted group is not offered at intake.
    await page
      .locator(`#adminGroups .g-card[data-group="${groupId}"]`)
      .waitFor({ state: 'detached' });
  });

  /**
   * The live bug this whole ADR-0031 sweep started from: adding a contact in the Directory
   * answered `{"error":"no such department"}`. That sentence is gone — and the contact still
   * did not save, because the tab listed from `/contacts/recipients` (posts) and its Add
   * button posted a bare `/roster/people` (a person with no post, invisible to a post-keyed
   * list). This drives the drawer and reads the result back off BOTH the re-rendered list and
   * the server, because a form that draws a field and drops it on submit looks perfect in a
   * screenshot.
   */
  it('4d. an operator adds a contact from the Directory tab, and it saves', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="departments"]');
    await page.waitForSelector('#adminDepartments');

    const name = `Directory Officer e2e ${RUN}`;
    const designation = `Canal Contact e2e ${RUN}`;
    const phone = '0300-7654321';

    await page.click('#adminDepartments button:has-text("+ Add New Contact")');
    const drawer = page.locator('#adminDrawerBackdrop');
    await drawer.waitFor({ state: 'visible' });

    const fields = drawer.locator('.d-input');
    await fields.nth(0).fill(name);
    await fields.nth(1).fill(designation);
    await fields.nth(2).fill(phone);
    await drawer.getByRole('button', { name: 'Create Contact' }).click();

    // Read it back off the list the console re-renders, not off the drawer.
    const card = page.locator('#adminDepartments .g-card', { hasText: name });
    await card.waitFor();
    expect(await card.locator('.g-desc').textContent()).toContain(designation);
    expect(await card.locator('.g-foot span').first().textContent()).toContain(phone);

    // And the server agrees — it is a real `/roster/contacts` row, not a screen artefact.
    const listed = await page.evaluate(async () => {
      const res = await fetch('/roster/contacts');
      return (await res.json()) as {
        contacts: { fullName: string; designation: string; phone: string }[];
      };
    });
    expect(
      listed.contacts.some(
        (c) => c.fullName === name && c.designation === designation && c.phone === phone,
      ),
    ).toBe(true);
  });

  /**
   * The owner's report: a rejected contact form threw its error into `#adminError`, above
   * `#adminBody`, which shoved the whole tab down while they were looking at the drawer. A
   * drawer action reports inside the drawer now, and the page behind it does not move.
   */
  it('4e. a rejected contact form reports inside the drawer, not the top banner', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="departments"]');
    await page.waitForSelector('#adminDepartments');

    const phone = '0301-2223344';
    await page.click('#adminDepartments button:has-text("+ Add New Contact")');
    const drawer = page.locator('#adminDrawerBackdrop');
    await drawer.waitFor({ state: 'visible' });
    let fields = drawer.locator('.d-input');
    await fields.nth(0).fill(`Dup One e2e ${RUN}`);
    await fields.nth(1).fill(`Dup Post A e2e ${RUN}`);
    await fields.nth(2).fill(phone);
    await drawer.getByRole('button', { name: 'Create Contact' }).click();
    await page.locator('#adminDepartments .g-card', { hasText: `Dup One e2e ${RUN}` }).waitFor();

    // Same number again — the server refuses it.
    await page.click('#adminDepartments button:has-text("+ Add New Contact")');
    await drawer.waitFor({ state: 'visible' });
    fields = drawer.locator('.d-input');
    await fields.nth(0).fill(`Dup Two e2e ${RUN}`);
    await fields.nth(1).fill(`Dup Post B e2e ${RUN}`);
    await fields.nth(2).fill(phone);
    await drawer.getByRole('button', { name: 'Create Contact' }).click();

    const drawerError = drawer.locator('.drawer-error');
    await drawerError.waitFor({ state: 'visible' });
    expect(await drawerError.textContent()).toContain('phone number already exists');
    // The drawer stays open, and the top banner is untouched.
    expect(await drawer.isVisible()).toBe(true);
    expect(await page.locator('#adminError').isHidden()).toBe(true);
  });

  /**
   * ⚠️ **Steps 4c and 6b are gone with the screens that were their subject — ADR-0030.**
   *
   * **4c** narrowed a list of seventy-nine department cards and checked the count beside the
   * search was folded from the rows it left. `GET /admin/departments` answers an empty list now,
   * so there is nothing to narrow and no count to disagree with it. The tab it lived on is
   * *Setup check*, and ⚠️ its handle is still `departments` on purpose — four suites address it
   * by that `data-tab`, and the configuration sweep that lives there is the more useful half.
   *
   * **6b** gave one department its own deadline exception and checked that emptying the box
   * asked why. A deadline aimed at a department is **refused** now rather than quietly written
   * as the district's, which `admin.test.ts` asserts directly — a stronger claim than this made,
   * and one that cannot be reached from a screen because the screen offers no department to aim
   * at. The district's own deadlines, and the reason INV-06 demands for changing them, are
   * covered there and in test 4b above.
   *
   * The numbers are left with the gap rather than closed up: they are cited in CLAUDE.md and the
   * changelog, and renumbering would silently repoint those references at different tests.
   */

  it('5. shows an unassigned emergency loudly on the board, in words', async () => {
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'a category the control room has not assigned yet' }),
      });
    });

    await page.click('#navBoard');
    await page.waitForSelector('#boardUnassigned:not([hidden])');

    const banner = (await page.textContent('#boardUnassigned')) ?? '';
    /**
     * **The word, not a colour — and it names what the operator does, on the screen they are on.**
     *
     * It used to assert the banner said *"routing signal"*, because it told the district to go
     * and write one. That advice went on 2026-08-06, and ADR-0022 removed the feature it was
     * advising about altogether.
     *
     * The second assertion is the one that keeps it honest — **the old advice must not come
     * back**. It cannot be acted on now even if somebody writes it.
     */
    expect(banner).toContain('nobody has been told');
    expect(banner).not.toContain('routing signal');

    /**
     * **The strip carries the chosen-recipient question and no longer the department one.**
     *
     * M11-09 split them into two segments, because one tile had been labelled with the first
     * question and fed the second's number. On 2026-08-18 the department figure came off this
     * strip altogether, with the deck's own the day before (ADR-0018: departments are a
     * directory the control room picks from, not an audience) — so the confusion this originally
     * asserted against cannot occur here at all.
     *
     * ⚠️ **The banner above is the half that was actually WRONG, and it is asserted at the top
     * of this test.** It said *"nobody has been told"* over `summary.unassigned` — the department
     * number — which on the live record read **31 where the truth was 12**. It reads
     * `summary.nobodyTold` now, so the sentence and the figure finally answer one question.
     */
    const told = (await page.textContent('#boardSummary .seg[data-kind="nobodytold"]')) ?? '';
    expect(told).toContain('no one chosen');

    const strip = (await page.textContent('#boardSummary')) ?? '';
    expect(strip).not.toContain('nobody has it');
  });

  it('6. sets an acknowledgement deadline, and the board measures against it', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="deadlines"]');
    await page.waitForSelector('#adminDeadlines');

    /**
     * The district default for `unknown` — the deadline that carries the urgency an unassessed
     * report used to express by pretending to be `high` (ADR-0009).
     *
     * ⚠️ **The figure is set in a drawer now, not typed into the grid.** The five district
     * values used to be `input.ack[data-severity]` fields that saved on blur; the redesign made
     * each severity a `.g-card` that opens `openDeadlinesDrawer`, where the number is a
     * `.d-input` and *Save SLA Target* is the thing that writes. The claim under test is
     * untouched — set a deadline in the console, read it back from the server, and watch the
     * board measure against it — so only these five lines move.
     */
    const drawer = page.locator('#adminDrawerBackdrop');
    await page.locator('#adminDeadlines .g-card', { hasText: 'NOT YET ASSESSED' }).click();
    await drawer.waitFor({ state: 'visible' });
    await drawer.locator('.d-input').fill('37');
    await drawer.getByRole('button', { name: 'Save SLA Target' }).click();

    // ⚠️ **No `waitFor({ state: 'hidden' })` on the drawer.** It closes by losing an `open`
    // class, and the element it leaves behind is `opacity: 0` with a real bounding box — which
    // Playwright calls *visible*, so that wait can only ever time out. The poll below is the
    // better wait anyway: it settles on the server having the figure, not on an animation.
    //
    // Read it back from the server rather than from the field we just typed into.
    const stored = await until(
      () =>
        page.evaluate(async () => {
          const res = await fetch('/admin/sla');
          const body = (await res.json()) as { district: { unknown: number } };
          return body.district.unknown;
        }),
      (v) => v === 37,
    );
    expect(stored).toBe(37);

    const applied = await page.evaluate(async () => {
      const res = await fetch('/incidents');
      const board = (await res.json()) as {
        incidents: { targetMinutes: number; assessed: boolean }[];
      };
      return board.incidents.find((r) => !r.assessed)?.targetMinutes;
    });
    expect(applied).toBe(37);
  });

  /**
   * **The district's performance is drawn once, and it is drawn in the Record — 2026-08-19.**
   *
   * This test used to open the console's own Performance tab and assert its table, including
   * *a dash, never a zero* (ADR-0005). The Record draws those figures from the same fold, with
   * the same medians and the same dash, so the console's copy was a **second door onto one
   * calculation** — which is how two screens come to disagree about a district in front of the
   * people who run it.
   *
   * ⚠️ **The dash assertion moved first**, to `reports.e2e` test 19, and only then was this one
   * changed — so the property was never unguarded for a single commit. That ordering is the
   * whole point: deleting a guard and writing its replacement afterwards is the same act with a
   * window left in it.
   */
  it('7. draws the district’s performance nowhere, and says where it went', async () => {
    expect(await page.locator('#adminTabs button[data-tab="performance"]').count()).toBe(0);

    // The signpost sits where the tab was, and it leaves this screen for the Record — because a
    // door that simply vanishes teaches people the software lost something.
    await page.click('#performanceMoved');
    await page.waitForSelector('#adminView', { state: 'hidden', timeout: 20_000 });

    // Back again, so the tests after this one still have a console to click in.
    await page.click('#navAdmin');
    await page.waitForSelector('#adminView:not([hidden])', { timeout: 20_000 });
  });

  it('8. records who changed what, and why, where the operator can read it', async () => {
    await page.click('#adminTabs button[data-tab="history"]');
    await page.waitForSelector('#adminHistory');

    const entries = await page.locator('.change').count();
    expect(entries).toBeGreaterThan(0);

    // The seat, because authority attaches to the post and survives the transfer (ADR-0004).
    const who = await page.locator('.change .who').first().textContent();
    expect(who).toContain('Deputy Commissioner');
  });

  it('9. refuses a bad deadline and says so, rather than appearing to save it', async () => {
    await page.click('#adminTabs button[data-tab="deadlines"]');
    await page.waitForSelector('#adminDeadlines');

    // Zero would make every incident overdue the instant it arrived.
    await page.evaluate(async () => {
      await fetch('/admin/sla', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ severity: 'critical', ackMinutes: 0 }),
      });
    });

    const still = await page.evaluate(async () => {
      const res = await fetch('/admin/sla');
      const body = (await res.json()) as { district: { critical: number } };
      return body.district.critical;
    });
    expect(still).toBeGreaterThan(0);
  });

  it('10. hides the console again the moment the operator signs out', async () => {
    await page.click('#logout');
    // `attached`, not the default `visible`: the assertion is that these go away, and an
    // element that is hidden never becomes visible, so the default state would wait forever
    // for the thing the test wants gone.
    await page.waitForSelector('#nav[hidden]', { state: 'attached' });
    expect(await page.locator('#adminView').isVisible()).toBe(false);
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });
});
