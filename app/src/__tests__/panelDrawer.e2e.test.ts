/**
 * "Expand" a dashboard panel and its whole list opens in the right-hand drawer — ADR-0036.
 *
 * The district's ask: panels like *Public utilities* and *District services* carry more rows
 * than fit, and on the wall those rows travel one past the other, so reading all of them means
 * waiting for the rotation to come round. Expanding a panel lifts the **same list node** out
 * into a drawer where it sits still.
 *
 * Two properties are load-bearing and neither is visible in a screenshot:
 *
 *   1. **It is a move, not a copy.** The list keeps its id and its `leadsTo` handlers — a row
 *      in the drawer leads exactly where it led on the wall — and the twenty-second poll keeps
 *      painting into it wherever it now lives. So the test asserts on node identity: the very
 *      element that was under the panel is the one now under `.od-body`, and it is back in the
 *      panel after the drawer closes.
 *
 *   2. **The drawer is not a detail view.** A row still hands off to the screen it always did
 *      (here the board); the drawer just showed the list first, and closes itself once the
 *      hand-off fires.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
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

describe.skipIf(dbUrl === undefined)('a dashboard panel expands into the drawer', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  let office: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    office = await seedActor(pool, { title: 'Drawer Test DC Office', tier: 'district' });

    // One live emergency, so "Live emergencies by kind" has a real, clickable row to follow
    // out of the drawer.
    const res = await fetch(`${origin}/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ category: 'rta', severity: 'high' }),
    });
    expect(res.status).toBe(201);

    browser = await chromium.launch();
    page = await browser.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', office.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function openDashboard(): Promise<void> {
    const shown = await page.locator('#dashboardView').isVisible();
    if (!shown) {
      await page.waitForSelector('#navDashboard');
      await page.click('#navDashboard');
    }
    await page.waitForSelector('#dashboardView:not([hidden])');
    await page.waitForFunction(
      () => document.querySelectorAll('#dashKeys .key').length > 0,
      undefined,
      {
        timeout: 20_000,
      },
    );
  }

  /** Click a panel's heading the way a person does — it carries `role="button"`. */
  async function expand(panel: string): Promise<void> {
    await page.evaluate((p: string) => {
      document
        .querySelector<HTMLElement>(`#dashboardView .panel[data-panel="${p}"] h2[data-expand]`)
        ?.click();
    }, panel);
    await page.waitForSelector('.od-backdrop.od-open');
  }

  it('offers the expander on the rows-that-travel panels, not on District or Emergency situation', async () => {
    await openDashboard();
    const state = await page.evaluate(() => ({
      // The panels the district named: more rows than fit, so they travel on the wall.
      wired: ['services', 'utilities', 'presence', 'facts', 'news'].every(
        (p) =>
          document.querySelector(`#dashboardView .panel[data-panel="${p}"] h2[data-expand]`) !==
          null,
      ),
      // Read in one glance already — left alone.
      skipped: ['keys', 'situation'].every(
        (p) =>
          document.querySelector(`#dashboardView .panel[data-panel="${p}"] h2[data-expand]`) ===
          null,
      ),
    }));
    expect(state).toEqual({ wired: true, skipped: true });
  });

  it('moves the panel’s own list node into the drawer, and puts it back on close', async () => {
    await openDashboard();

    // Mark the live list node, then expand: the marked element itself must be what lands in
    // the drawer, not a look-alike.
    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('#dashFacts');
      if (list !== null) list.dataset['drawerProbe'] = 'facts';
    });

    await expand('facts');

    const inDrawer = await page.evaluate(
      () => document.querySelector('.od-body [data-drawer-probe="facts"]')?.id ?? null,
    );
    expect(inDrawer).toBe('dashFacts');

    // The panel does not read as broken while its list is away.
    const parked = await page.evaluate(
      () =>
        document.querySelector('.panel[data-panel="facts"] .od-parked') !== null &&
        document.querySelector('.panel[data-panel="facts"] #dashFacts') === null,
    );
    expect(parked).toBe(true);

    // Escape closes it, and the same node is back under the panel.
    await page.keyboard.press('Escape');
    await page.waitForSelector('.od-backdrop', { state: 'detached' });

    const home = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(
        '.panel[data-panel="facts"] [data-drawer-probe="facts"]',
      );
      return {
        back: list?.id ?? null,
        parkedGone: document.querySelector('.panel[data-panel="facts"] .od-parked') === null,
        drawerGone: document.querySelector('.od-backdrop') === null,
      };
    });
    expect(home).toEqual({ back: 'dashFacts', parkedGone: true, drawerGone: true });
  });

  it('a panel gets its travel window back on close, in the same tick', async () => {
    await openDashboard();

    // `flowPanels` wraps every non-skip panel's list in a `.pflow` window whether it rolls or
    // not. If the drawer put a bare list back and left the re-wrap to the next poll, the panel
    // would sit the wrong height — unclipped — and shove the wall's layout for up to 20s.
    // Pick whichever eligible panel the local data has actually flowed.
    const panel = await page.evaluate(() => {
      for (const sec of Array.from(
        document.querySelectorAll('#dashboardView .panel[data-panel]'),
      )) {
        if (sec.querySelector(':scope .lift > .pflow')) return sec.getAttribute('data-panel');
      }
      return null;
    });
    expect(panel).not.toBeNull();

    await expand(panel as string);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.od-backdrop', { state: 'detached' });

    // No repaint waited for — the check runs immediately after close. The list belongs back
    // inside `.lift > .pflow > .pfilm`, never bare in `.lift`.
    const after = await page.evaluate((p: string) => {
      const lift = document.querySelector(`.panel[data-panel="${p}"] .lift`);
      const liftKids = lift
        ? Array.from(lift.children).map((c) => c.tagName + '.' + (c.className || '—'))
        : null;
      return {
        pflow: lift?.querySelectorAll(':scope > .pflow').length ?? -1,
        pfilmHasList: !!lift?.querySelector(':scope > .pflow > .pfilm > div'),
        // A list container (`.plist` / `.alist` / `.factgrid` / `.keys` / `.strack`) sitting
        // straight in `.lift` is the bug.
        bareList: !!lift?.querySelector(
          ':scope > .plist, :scope > .alist, :scope > .factgrid, :scope > .keys, :scope > .strack',
        ),
        liftKids,
      };
    }, panel as string);
    expect(after.pflow).toBe(1);
    expect(after.pfilmHasList).toBe(true);
    expect(after.bareList).toBe(false);
  });

  it('renders the borrowed rows flat — no card sheen or lifted-text shadow in the drawer', async () => {
    await openDashboard();
    await expand('services');

    const flat = await page.evaluate(() => {
      const sheen = document.querySelector('.od-body .tilt > .stack > .face > .sheen');
      const z3 = document.querySelector('.od-body .tilt .z3');
      return {
        sheenHidden: sheen ? getComputedStyle(sheen).display === 'none' : 'no-sheen',
        z3NoShadow: z3 ? getComputedStyle(z3).textShadow === 'none' : 'no-z3',
        z3NoTransform: z3 ? getComputedStyle(z3).transform === 'none' : 'no-z3',
      };
    });
    // Whichever panel it is, if it has a sheen it must be hidden and if it has a z3 it must be flat.
    expect(flat.sheenHidden === true || flat.sheenHidden === 'no-sheen').toBe(true);
    expect(flat.z3NoShadow === true || flat.z3NoShadow === 'no-z3').toBe(true);
    expect(flat.z3NoTransform === true || flat.z3NoTransform === 'no-z3').toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForSelector('.od-backdrop', { state: 'detached' });
  });

  // Last: this one navigates off the dashboard, so anything after it would have to walk back.
  it('a row followed from inside the drawer lands on its screen and the drawer closes', async () => {
    await openDashboard();
    await expand('categories');

    // The row is the same `.pitem.go` the wall has; following it is the district's existing
    // journey to the board, unchanged.
    await page.click('.od-body .pitem[role="button"]');

    await page.waitForSelector('#boardView:not([hidden])');
    await page.waitForSelector('.od-backdrop', { state: 'detached' });

    expect(await page.locator('#boardView').isVisible()).toBe(true);
    expect(await page.locator('.od-backdrop').count()).toBe(0);
  });
});
