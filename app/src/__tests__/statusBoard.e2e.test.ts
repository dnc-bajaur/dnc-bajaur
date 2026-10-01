/**
 * Add · Remove · Rename, on the Status screen, in a real browser — 2026-09-08.
 *
 * The district asked for it in one sentence: *"subi panels mai … add and remove buttons plus
 * rename button hona chaye hain taake control es ko accordingly adjust kar ske."*
 *
 * ## Why this needs a browser and `statusBoard.test.ts` is not enough
 *
 * That file drives the routes and proves the server does the right thing. It cannot see the two
 * failures this screen is actually likely to have, and both have happened in this repository
 * before:
 *
 *   * **A form that draws a field and drops it on submit looks perfect in a screenshot.** The
 *     `panel` argument is threaded from `paint()` through `conditionRows` into `addServiceForm`,
 *     and the whole point of it is that adding on the District services panel lands on District
 *     services. Nothing but a click can say that the right one arrived.
 *   * **A control drawn for the wrong audience.** `canConfigure` decides whether these are drawn
 *     at all; INV-05 says the server refuses regardless, and `statusBoard.test.ts` asserts that
 *     — what is asserted here is the courtesy half, that a duty officer is not shown two buttons
 *     that will be refused.
 *
 * ## And one thing only the browser can say at all
 *
 * The officer card's **Add to dashboard / Remove from dashboard** replaces the checkbox ADR-0033
 * shipped. Same route, same one field — so every server test passes on both sides of the change,
 * and the only way to know the button reaches it is to press the button.
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

describe.skipIf(dbUrl === undefined)('the control room adjusts the Status board', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;

  let office: BrowserContext;
  let officePage: Page;
  let duty: BrowserContext;
  let dutyPage: Page;

  /**
   * The panel with this heading, and the row for one named thing inside it.
   *
   * `hasText` searches the whole subtree, so a row matches on anything inside it — its own note,
   * or a longer name that contains this one. `status.e2e.test.ts` already carries that lesson;
   * matching the `.sname` element exactly is the only form that means what it reads as.
   */
  function panelFor(page: Page, heading: string) {
    return page.locator('.panel').filter({ has: page.getByRole('heading', { name: heading }) });
  }

  function rowFor(page: Page, name: string) {
    return page.locator('.sreport').filter({ has: page.getByText(name, { exact: true }) });
  }

  async function signIn(page: Page, actor: TestActor): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

  /**
   * ⚠️ **Waiting for `childElementCount > 0` is the version that cost this suite two runs.**
   *
   * Opening the Status screen a second time re-runs `show()`, which re-fetches and repaints —
   * and the old content is still on screen while that request is in flight, so that condition
   * is satisfied **immediately, by the previous paint**. A test then fills the add box, the
   * pending repaint replaces the field mid-test, and the click lands on an empty input: the
   * service is never created, nothing errors, and *a different test fails on each run* — which
   * is what said it was a race rather than the wiring.
   *
   * Stamping the current first child and waiting for one without the mark waits for the paint
   * itself. `clear()` removes the children, so the mark cannot survive it; on the very first
   * open there is nothing to stamp and the wait is the original one.
   */
  async function openStatus(page: Page): Promise<void> {
    await page.evaluate(() => {
      document.getElementById('statusBody')?.firstElementChild?.setAttribute('data-stale', '1');
    });
    await page.click('#navStatus');
    await page.waitForFunction(
      () => {
        const first = document.getElementById('statusBody')?.firstElementChild;
        return first !== null && first !== undefined && !first.hasAttribute('data-stale');
      },
      undefined,
      { timeout: 15_000 },
    );
  }

  /** What `/status` says right now — the screen's own source, read behind its back. */
  async function listed(): Promise<{ name: string; panel: string }[]> {
    const res = await pool.query<{ name: string; panel: string }>(
      'SELECT name, panel FROM utility WHERE retired_at IS NULL',
    );
    return res.rows;
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (board ${RUN})`);
    const dc = await seedActor(pool, {
      title: `Deputy Commissioner (board ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });

    const pesco = await seedDepartment(pool, `PESCO (board ${RUN})`);
    const xen = await seedActor(pool, { title: `XEN (board ${RUN})`, departmentId: pesco });

    browser = await chromium.launch();

    office = await browser.newContext();
    officePage = await office.newPage();
    await signIn(officePage, dc);

    duty = await browser.newContext();
    dutyPage = await duty.newPage();
    await signIn(dutyPage, xen);
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * 🔴 **The defect this test exists for: District services could not be added to.**
   *
   * Not a refusal and not an error — the service was created and appeared on the **other**
   * panel, because `/status/utilities` ignored `panel` until today. The assertion is read out of
   * the database rather than off the screen: the row would be on screen either way, one panel up.
   */
  it('1. adds a service to the panel the control room typed it into', async () => {
    const name = `DHQ Hospital (board ${RUN})`;
    await openStatus(officePage);

    const services = panelFor(officePage, 'District services');
    await services.locator('.sadd input').fill(name);
    await services.locator('.sadd button').click();

    await rowFor(officePage, name).waitFor({ timeout: 15_000 });

    // Read behind the screen's back: on the wrong panel the row is still drawn, one heading up.
    const row = (await listed()).find((u) => u.name === name);
    expect(row?.panel).toBe('services');
  });

  it('2. adds a utility to the utilities panel, from its own form', async () => {
    const name = `Sui Gas (board ${RUN})`;
    await openStatus(officePage);

    const utilities = panelFor(officePage, 'Public utilities');
    await utilities.locator('.sadd input').fill(name);
    await utilities.locator('.sadd button').click();

    await rowFor(officePage, name).waitFor({ timeout: 15_000 });
    expect((await listed()).find((u) => u.name === name)?.panel).toBe('utility');
  });

  /**
   * Rename and Remove, on the card, through the dialogs the district actually meets.
   *
   * ⚠️ **A `prompt` nobody is listening for is auto-dismissed**, so a test written without the
   * handler would pass just as happily against a screen that asks nothing at all — the counting
   * lesson `takeAction.e2e` already paid for. The handler is the test as much as the assertion.
   */
  it('3. renames a service in place, and the reports it carries come with it', async () => {
    const before = `Electricty (board ${RUN})`;
    const after = `Electricity (board ${RUN})`;
    await openStatus(officePage);

    const utilities = panelFor(officePage, 'Public utilities');
    await utilities.locator('.sadd input').fill(before);
    await utilities.locator('.sadd button').click();
    await rowFor(officePage, before).waitFor({ timeout: 15_000 });

    // A reading, so the rename has something to carry.
    await rowFor(officePage, before).locator('button.sbtn.down').click();
    await officePage.waitForFunction(
      () => document.getElementById('statusNote')?.textContent === 'Saved.',
      undefined,
      { timeout: 15_000 },
    );

    officePage.once('dialog', (d) => void d.accept(after));
    await rowFor(officePage, before).getByRole('button', { name: 'Rename' }).click();

    await rowFor(officePage, after).waitFor({ timeout: 15_000 });
    expect(await rowFor(officePage, before).count()).toBe(0);

    // The reading filed under the old name is still this service's current one.
    const kept = await pool.query<{ status: string }>(
      `SELECT r.status FROM utility u
         JOIN utility_report r ON r.utility_id = u.utility_id
        WHERE u.name = $1`,
      [after],
    );
    expect(kept.rows[0]?.status).toBe('down');
  });

  it('4. removes a service from the panel, after saying what it will cost', async () => {
    const name = `Cattle Market (board ${RUN})`;
    await openStatus(officePage);

    const services = panelFor(officePage, 'District services');
    await services.locator('.sadd input').fill(name);
    await services.locator('.sadd button').click();
    await rowFor(officePage, name).waitFor({ timeout: 15_000 });

    let said = '';
    officePage.once('dialog', (d) => {
      said = d.message();
      void d.accept();
    });
    await rowFor(officePage, name).getByRole('button', { name: 'Remove' }).click();

    await rowFor(officePage, name).waitFor({ state: 'detached', timeout: 15_000 });

    // ⚠️ The sentence is the feature. A control room that believes Remove erases the record
    // will use it to erase a record — so it must say that everything reported stays.
    expect(said).toContain('stays in the record');

    const kept = await pool.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM utility WHERE name = $1',
      [name],
    );
    expect(kept.rows[0]?.retired_at).not.toBeNull();
  });

  /**
   * The officer card's wall pick, as two words rather than a checkbox — ADR-0033's own route.
   *
   * 🔴 **Add / Remove here mean THIS PANEL ON THE WALL, never the post.** The button says
   * *Remove from dashboard* in those words, and this asserts it: anything shorter reads as
   * *retire this designation* to somebody who has not read `officerAdmin`'s comment.
   */
  it('5. adds an officer to the dashboard and takes them off again', async () => {
    await openStatus(officePage);

    const officers = panelFor(officePage, 'Where the officers are');
    const first = officers.locator('.sreport').first();
    const title = (await first.locator('.sname').textContent())?.trim() ?? '';
    expect(title).not.toBe('');

    await first.getByRole('button', { name: 'Add to dashboard' }).click();
    await first.getByRole('button', { name: 'Remove from dashboard' }).waitFor({ timeout: 15_000 });

    const on = await pool.query<{ on_wall: boolean }>('SELECT on_wall FROM seat WHERE title = $1', [
      title,
    ]);
    expect(on.rows[0]?.on_wall).toBe(true);

    await first.getByRole('button', { name: 'Remove from dashboard' }).click();
    await first.getByRole('button', { name: 'Add to dashboard' }).waitFor({ timeout: 15_000 });

    const off = await pool.query<{ on_wall: boolean }>(
      'SELECT on_wall FROM seat WHERE title = $1',
      [title],
    );
    expect(off.rows[0]?.on_wall).toBe(false);
  });

  /**
   * A duty officer is shown none of it — and the server refuses regardless (INV-05).
   *
   * The screen is still theirs: they report a condition exactly as they did yesterday. What is
   * withheld is the configuration, which `api/status.ts`'s own header says is the two offices'
   * because a department able to remove itself from the list could go quiet unseen.
   */
  it('6. shows a duty officer the reporting and none of the configuration', async () => {
    await openStatus(dutyPage);

    await dutyPage.locator('button.sbtn.normal').first().waitFor({ timeout: 15_000 });

    expect(await dutyPage.locator('.sadmin').count()).toBe(0);
    expect(await dutyPage.locator('.sadd').count()).toBe(0);
  });
});
