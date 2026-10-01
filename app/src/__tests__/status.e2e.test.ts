/**
 * The Status screen — M4, in a real browser.
 *
 * This is the screen that makes the dashboard true. Everything the dashboard displays about
 * the district's own condition is typed here, so the loop that matters is: **somebody states
 * a fact on one screen and it appears on the other**, with an author and a time attached.
 *
 * Two things are pinned besides that loop.
 *
 * **A department sees only what it may change.** The generous failure here is the same one
 * migration 0010 already produced once — a department able to act on another's data — and it
 * would be invisible until the day somebody used it.
 *
 * **A hidden control is not a control.** Every refusal asserted through the interface is also
 * asserted directly against the API, because INV-05 says the UI is never the enforcement
 * layer and a test that only clicks buttons cannot tell the difference.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('M4: the Status screen', () => {
  /**
   * The row for one named thing.
   *
   * `locator('.sreport', { hasText: name })` looks right and is not: `hasText` searches the
   * whole subtree, so a row matches on anything inside it — its own note, or a longer service
   * name that contains this one. Unrelated rows matched, and the assertion read whichever one
   * Playwright reached first.
   *
   * ⚠️ **`.sreport` and not `.srow` since 2026-08-23.** `.srow` now belongs to the "still
   * running" panel alone; see the note at the top of `office.css` for why the Status screen
   * stopped sharing it.
   *
   * Matching the `.sname` element exactly is the only form that means what it reads as.
   */
  function rowFor(page: Page, name: string) {
    return page.locator('.sreport').filter({ has: page.getByText(name, { exact: true }) });
  }

  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;

  let office: BrowserContext;
  let officePage: Page;
  let department: BrowserContext;
  let departmentPage: Page;

  let deptId: string;
  let deptActor: TestActor;
  /** The seeded utility, so a test can report on it through the API — see 5b. */
  let feederId: string;

  async function signIn(page: Page, actor: TestActor): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  async function openStatus(page: Page): Promise<void> {
    await page.click('#navStatus');
    await page.waitForFunction(
      () => (document.getElementById('statusBody')?.childElementCount ?? 0) > 0,
      undefined,
      { timeout: 15_000 },
    );
  }

  /**
   * Wait until `#statusBody` has stopped being rebuilt.
   *
   * `paint()` does `clear(root)` and appends a whole new tree, so the identity of the body's
   * first child changes on every repaint. When it has held still for 600ms, nothing is in
   * flight.
   */
  async function waitForPanelStable(page: Page): Promise<void> {
    await page.waitForFunction(
      () => {
        const body = document.getElementById('statusBody');
        if (body === null) return false;
        const w = window as unknown as { __stamp?: Element | null; __since?: number };
        if (w.__stamp !== body.firstElementChild) {
          w.__stamp = body.firstElementChild;
          w.__since = Date.now();
          return false;
        }
        return Date.now() - (w.__since ?? 0) > 600;
      },
      undefined,
      { timeout: 15_000 },
    );
  }

  /**
   * ⚠️ **THE PANEL REBUILDS ITSELF UNDER THE TYPING, AND THE FAILURE LANDS TWO TESTS AWAY.**
   *
   * `mountStatus().show()` calls `reload()`, which replaces the whole of `#statusBody` — form
   * and all. `openStatus` returns as soon as the body has *a* child, and that child can be the
   * previous render; the fill then lands on an input the reload is about to throw away. The
   * advisory is never issued, `#issueAlert` answers *"say what the advisory is"* into a note
   * nothing reads, and what the run reports instead is test 5 timing out on the dashboard and
   * test 8 finding an empty change log — neither of which is where the problem is.
   *
   * Filling once and checking is not enough: the reload can land between the check and the
   * click. This re-fills until the value is still there at the moment the button is pressed, and
   * then waits on the server rather than on the screen.
   */
  async function issueAdvisory(page: Page, message: string): Promise<void> {
    await page.waitForSelector('#alertMessage');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForPanelStable(page);
      await page.fill('#alertMessage', message);
      if ((await page.inputValue('#alertMessage')) !== message) continue;
      await page.click('#issueAlert');
      const landed = await page
        .waitForFunction(
          async (needle: string) => {
            const res = await fetch('/status');
            if (!res.ok) return false;
            const body = (await res.json()) as { alerts?: { message: string }[] };
            return (body.alerts ?? []).some((a) => a.message === needle);
          },
          message,
          { timeout: 5_000 },
        )
        .then(
          () => true,
          () => false,
        );
      if (landed) return;
    }
    throw new Error(`the advisory "${message}" never reached the server`);
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

    const dcDept = await seedDepartment(pool, `DC Office (status ${RUN})`);
    const dc = await seedActor(pool, {
      title: `Deputy Commissioner (status ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });

    deptId = await seedDepartment(pool, `PESCO (status ${RUN})`);
    deptActor = await seedActor(pool, {
      title: `XEN (status ${RUN})`,
      departmentId: deptId,
    });

    /**
     * ⚠️ **NO `department_id` — migration 0039 dropped it, and this INSERT killed the suite.**
     *
     * It failed in `beforeAll`, so all seven tests reported as SKIPPED rather than failed: the
     * M4 Status screen had no coverage at all and the run still looked tidy. A hook that throws
     * is the one failure mode a summary line makes invisible.
     *
     * *“A service this department answers for, and one it does not”* has no second half any more
     * — no utility is answered for by anybody. Both are plain services now, which is what the
     * screen actually shows.
     */
    const feeder = await pool.query<{ utility_id: string }>(
      `INSERT INTO utility (name, panel) VALUES ($1, 'utility') RETURNING utility_id`,
      [`Feeder ${RUN}`],
    );
    feederId = feeder.rows[0]!.utility_id;

    await pool.query(`INSERT INTO utility (name, panel) VALUES ($1, 'services')`, [
      `Markets ${RUN}`,
    ]);

    browser = await chromium.launch();

    office = await browser.newContext();
    officePage = await office.newPage();
    await signIn(officePage, dc);

    department = await browser.newContext();
    departmentPage = await department.newPage();
    await signIn(departmentPage, deptActor);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. is offered to everybody signed in, department and office alike', async () => {
    // Not an administration screen. Every department states its own condition, which was the
    // owner's instruction about departmental data, applied to this.
    //
    // `isVisible` rather than Playwright's `expect(...).toBeVisible()`: this suite asserts
    // with vitest's expect, which does not carry Playwright's matchers.
    expect(await officePage.isVisible('#navStatus')).toBe(true);
    expect(await departmentPage.isVisible('#navStatus')).toBe(true);
  });

  /**
   * ⚠️ **Was *"a department reports its own service"* — ADR-0024, 2026-08-22.**
   *
   * `mayReportFor` no longer admits a department seat: the district decided no department does
   * anything inside the app, and this was one of the five capabilities that had stayed open on
   * the server after the screens went in August.
   *
   * **The loop this test exists for is untouched** — stated on one screen, visible on the other.
   * Only the hand that types it moved, and it moved to the office that has the district's only
   * account. What the row shows beside the status changed on 2026-09-08: the age is gone from
   * this panel at the district's request, and the assertion below now pins its absence.
   */
  it('2. the office reports a service, and the dashboard says so', async () => {
    /**
     * ⚠️ **Its own page, from the office's own context.**
     *
     * This used to run on the **department's** page, which nothing else reused — so ending on
     * the dashboard cost nothing. `officePage` is shared by the advisory tests below, and
     * `openStatus` returns as soon as `#statusBody` has children, which is already true on a
     * second visit: reusing it here leaves those tests filling fields on a panel mid-rebuild.
     *
     * A second page in the same context carries the same session and the same authority, and
     * touches nothing they depend on.
     */
    const reporter = await office.newPage();
    await reporter.goto(origin);
    await reporter.waitForSelector('#nav:not([hidden])');

    await openStatus(reporter);

    const row = rowFor(reporter, `Feeder ${RUN}`);
    await row.locator('input.snote').fill('Transformer failed at Nawagai');
    await row.locator('button.sbtn.down').click();

    await reporter.click('#navDashboard');

    // The loop this screen exists for: stated on one screen, visible on the other.
    await reporter.waitForFunction(
      () =>
        document.getElementById('dashUtilities')?.textContent?.includes('Transformer failed') ===
        true,
      undefined,
      { timeout: 15_000 },
    );

    const panel = (await reporter.textContent('#dashUtilities')) ?? '';
    expect(panel).toContain('Down');

    /**
     * ⚠️ **And the wall says it without a time — the district's instruction (2026-09-08).**
     *
     * This assertion is the reverse of the one it replaces. The row used to be required to
     * carry `just now` / `min ago` *whether or not anything was wrong*, so that nobody could
     * learn a missing age meant fine (ADR-0005). The owner watched the wall and asked for those
     * words gone, twice, knowing what they were holding up.
     *
     * Both halves are checked, because they fail apart. The **text** catches an age written as
     * ordinary words; the **`[data-since]` count** catches one that paints empty at first and is
     * then filled in by `startAges` a second later — the form this file's own history says a
     * text-only assertion sails straight past.
     */
    expect(panel).not.toMatch(/just now|min ago|hours? ago|days? ago|yesterday/);
    expect(
      await reporter.evaluate(
        () => document.querySelectorAll('#dashUtilities [data-since]').length,
      ),
    ).toBe(0);

    await reporter.close();
  });

  /**
   * ⚠️ **Was *"shows a department nothing it does not answer for"* — ADR-0030.**
   *
   * The scoping it proved cannot exist any more: `utility.department_id` and `seat.department_id`
   * were both dropped by migration 0039, so the filter behind it compared `null` with `null` and
   * passed everything. The old assertion could not be made true by any fixture.
   *
   * 🔴 **And leaving it would have hidden the live fault rather than caught it.** The screen
   * went on heading that list *"The services your department answers for"* while showing every
   * utility in Bajaur — everything shown, and a false reason given for showing it. What is
   * asserted now is the half that still means something and is the half INV-05 is about: **the
   * screen must not claim a scope it does not have.**
   */
  it('3. does not tell a seat that the whole district is its own department', async () => {
    await openStatus(departmentPage);

    const body = (await departmentPage.textContent('#statusBody')) ?? '';

    // Nothing is filtered any more, so both are there — and that is the point: the sentence
    // above them has to match.
    expect(body).toContain(`Feeder ${RUN}`);
    expect(body).toContain(`Markets ${RUN}`);

    expect(body).not.toContain('your department');
    expect(body).toContain('The control room reports these.');

    // And the control room's own copy still says it may act, which is the other branch.
    await openStatus(officePage);
    const office = (await officePage.textContent('#statusBody')) ?? '';
    expect(office).toContain('You may report any of these.');
  });

  it('4. refuses a department that reaches past the screen (INV-05)', async () => {
    // The interface did not offer it. That is a courtesy; this is the control.
    const refused = await departmentPage.evaluate(async () => {
      const res = await fetch('/status/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'road', message: 'not mine to issue', untilAt: '2030-01-01' }),
      });
      return res.status;
    });

    expect(refused).toBe(403);
  });

  it('5. an office issues an advisory, and it reaches the dashboard', async () => {
    await openStatus(officePage);

    await issueAdvisory(officePage, `Khar Road closed ${RUN}`);

    await officePage.click('#navDashboard');
    await officePage.waitForFunction(
      (needle) => document.getElementById('dashAlerts')?.textContent?.includes(needle) === true,
      `Khar Road closed ${RUN}`,
      { timeout: 15_000 },
    );
  });

  /**
   * 🔴 **The panel used to throw away what somebody had typed, and say nothing — 2026-09-08.**
   *
   * Ten places call `reload()` after a save, and every one of them repaints: `clear(root)` and a
   * new tree. An operator part-way through an advisory when a service report landed lost the
   * words, `POST /status/alerts` answered *"say what the advisory is"*, and that refusal appears
   * in a note beside a form they have already looked away from. They believe it was sent.
   *
   * This drives the real collision rather than describing it: type an advisory, then save
   * something else from the same screen so a repaint is genuinely in flight, and require the
   * words to still be there afterwards.
   *
   * ⚠️ **The second half is the half that can rot.** Carrying *everything* across a repaint
   * would leave a stale reading on screen looking current — the one thing this screen exists to
   * prevent — so an untouched field must still take the server's fresh value. The note below is
   * asserted to have been overwritten by exactly that.
   */
  it('5b. a repaint keeps what was typed and not yet sent, and nothing else', async () => {
    await openStatus(officePage);
    await waitForPanelStable(officePage);

    const typed = `Half-written advisory ${RUN}`;
    await officePage.fill('#alertMessage', typed);

    // Somebody else's report on the same screen, landing while the advisory is half-written.
    // Written through the API so it is a real repaint and not a second thing to type.
    const serverNote = `Reported elsewhere ${RUN}`;
    await officePage.evaluate(
      async ([id, text]) => {
        await fetch('/status/utility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ utilityId: id, status: 'degraded', note: text }),
        });
      },
      [feederId, serverNote] as const,
    );
    await officePage.click('#navStatus');
    await openStatus(officePage);
    await waitForPanelStable(officePage);

    // The words survive the rebuild.
    expect(await officePage.inputValue('#alertMessage')).toBe(typed);

    // And a field nobody touched still shows what the server now says, rather than a copy of
    // whatever was on screen before.
    const feeder = rowFor(officePage, `Feeder ${RUN}`);
    expect(await feeder.locator('input.snote').inputValue()).toBe(serverNote);
  });

  it('6. refuses an advisory with no end, rather than accepting one that never expires', async () => {
    // The whole reason advisory boards rot: the road reopens and the notice stays up until it
    // is furniture. The server requires an end; this proves it says so rather than silently
    // storing one.
    const problem = await officePage.evaluate(async () => {
      const res = await fetch('/status/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'road', message: 'no end given' }),
      });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    });

    expect(problem.status).toBe(400);
    expect(problem.body.error).toContain('ends');
  });

  it('8. records who said what, in the change log', async () => {
    const changes = await pool.query<{ subject: string; reason: string | null }>(
      `SELECT subject, reason FROM config_event
        WHERE subject IN ('district_alert', 'utility')
        ORDER BY seq DESC LIMIT 5`,
    );

    // A configuration change with nobody's name on it is exactly what the log exists to
    // prevent (migration 0007).
    expect(changes.rows.length).toBeGreaterThan(0);
    expect(changes.rows.some((r) => r.subject === 'district_alert')).toBe(true);
  });
});
