/**
 * A lazily-fetched screen arrives **styled** — 2026-08-14.
 *
 * ## Why this exists, and why nothing else could have caught it
 *
 * On 2026-08-14 the office screens' and the recipient picker's CSS left `index.html` for
 * `office.css` and `dispatch.css`, because their bundles had been fetched on first use since
 * 2026-08-04 and M7-26 respectively and **their styling had never followed them**. The shell was
 * sending 20 KB of rules to a field officer in Mamund for screens that officer cannot open.
 *
 * The move introduced a failure mode this repository has now been bitten by five times, always
 * with the same signature: **the action succeeds.** Get `loadScreen`'s second argument wrong,
 * or let `build.mjs` stop copying one of the files, and there is no error anywhere — the bundle
 * loads, the screen renders, every existing test passes, and an operator gets an unstyled
 * console. `contrast.e2e.test.ts` would not see it either: black text on a white browser default
 * passes AA comfortably.
 *
 * So this measures what an operator actually gets, on the rendered page, for a property that
 * **only the moved stylesheet supplies**. `.sbtn`'s 44px minimum is a thumb rather than a
 * cursor; a `<button>` with no stylesheet has no minimum at all.
 *
 * ## The fourth test is the one that will fail years from now
 *
 * If somebody moves a rule back into the shell, `office.css` quietly becomes dead weight — still
 * fetched, still cached, overridden by a copy in `index.html` that ships to every handset. That
 * is the drift this repository has a standing lesson about, and it is invisible: the screen
 * looks right either way. Test 4 asserts the shell does **not** define these selectors.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readdir } from 'node:fs/promises';
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

/**
 * Selectors whose declarations left the shell — `.sbtn` for `office.css`, `.dsearch` for
 * `dispatch.css`. Test 4 asserts the shell has not taken them back.
 *
 * The properties each one is measured by live in tests 2 and 3 beside the assertion, rather
 * than in a table here. Both are values a browser default does not produce — a `<button>` has
 * no minimum height, an `<input>` has square corners — which is what makes them proof that the
 * file arrived rather than merely that the element exists.
 */
const MOVED = ['.sbtn', '.dsearch', '.settings-card'];

describe.skipIf(dbUrl === undefined)('a lazily-fetched screen arrives styled', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let webRoot: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  beforeAll(async () => {
    webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // District tier, so the console and the Status screen are both reachable.
    actor = await seedActor(pool, { title: 'Lazy Styles Operator', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function signIn(): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
  }

  /**
   * The computed value of one property on the first element matching a selector.
   *
   * Read from the live element rather than from the stylesheet: a rule that is present but
   * overridden, or a file that 404s, both measure what an officer actually sees.
   */
  async function computed(selector: string, property: string): Promise<string | null> {
    return page.evaluate(
      ([sel, prop]) => {
        const node = document.querySelector(sel as string);
        return node === null ? null : getComputedStyle(node).getPropertyValue(prop as string);
      },
      [selector, property],
    );
  }

  it('1. every stylesheet the build emits is actually served', async () => {
    // Guards `build.mjs` forgetting a `cp`. A missing stylesheet is a 404 the app never reports:
    // `loadScreen` appends the <link> and does not wait for it, correctly — a screen must not be
    // held hostage by its own decoration.
    const sheets = (await readdir(webRoot)).filter((f) => f.endsWith('.css'));
    expect(sheets, 'the build emitted no stylesheets at all').toContain('office.css');
    expect(sheets).toContain('dispatch.css');

    for (const name of sheets) {
      const res = await fetch(`${origin}/${name}`);
      expect(res.status, `${name} is not served`).toBe(200);
      expect((await res.text()).length, `${name} is served empty`).toBeGreaterThan(0);
    }
  });

  it('2. the Status screen arrives with its own stylesheet applied', async () => {
    await signIn();
    await page.click('#navStatus');
    await page.waitForSelector('#statusView:not([hidden])', { timeout: 20_000 });
    await page.waitForSelector('.sbtn', { timeout: 25_000 });

    // The <link> exists at all — `loadScreen(name, true)` was asked for the stylesheet.
    expect(await page.locator('#officeCss').count(), 'office.css was never requested').toBe(1);

    // And it arrived and applied. 44px is a thumb; a bare <button> has no minimum height.
    expect(await computed('.sbtn', 'min-height')).toBe('44px');
  });

  it('3. the recipient picker arrives with its own stylesheet applied', async () => {
    /**
     * The picker opens only after a report is already in the outbox — the M0-36 ordering, and
     * the reason M9-23 puts the directory doors here rather than in the console.
     */
    await page.goto(origin);
    await page.waitForSelector('#submit', { timeout: 20_000 });
    await page.click('label[for="cat-fire"]');
    await page.click('#submit');
    await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });
    await page.waitForSelector('#dispatchPanel .dsearch', { timeout: 20_000 });

    expect(await page.locator('#dispatchCss').count(), 'dispatch.css was never requested').toBe(1);
    // A bare <input> has square corners.
    expect(await computed('.dsearch', 'border-radius')).toBe('12px');
  });

  it('4a. the Settings panel arrives with its own stylesheet applied', async () => {
    // Test 2 already signed in on this page and the session cookie persists in the context, so
    // re-running `signIn()` would hang waiting for a login form the boot has already hidden.
    await page.goto(origin);
    await page.waitForSelector('#navSettings', { state: 'visible', timeout: 20_000 });
    await page.click('#navSettings');
    await page.waitForSelector('#settingsView:not([hidden])', { timeout: 20_000 });
    // The tab bar is drawn on first render, so `#settingsTabs button` exists at once.
    await page.waitForSelector('#settingsTabs button', { timeout: 25_000 });

    expect(await page.locator('#settingsCss').count(), 'settings.css was never requested').toBe(1);

    // 38px is `settings.css`'s own rule for a tab; a bare <button> has no minimum height.
    expect(await computed('#settingsTabs button', 'min-height')).toBe('38px');
  });

  it('4. the shell does not still carry the rules that moved out of it', async () => {
    /**
     * The silent half of this change. A rule copied back into `index.html` would leave the
     * lazy file fetched, cached and overridden — 20 KB going to every handset again, with every
     * screen looking exactly right. Read from `document.styleSheets` on a page where **only**
     * the shell has loaded.
     *
     * **Its own context, deliberately.** The tests above leave a session behind, and a signed-in
     * page has already fetched both lazy stylesheets — so reusing that page would measure a
     * document where they are legitimately present and prove nothing. A fresh context is a
     * browser that has never opened this app, which is the state this assertion is about.
     */
    const clean = await browser.newContext();
    const first = await clean.newPage();
    await first.goto(origin);
    await first.waitForSelector('#login');

    const inShell = await first.evaluate((selectors: string[]) => {
      const found: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        // Only the shell's own inline <style> is loaded here; it has no href.
        if (sheet.href !== null) continue;
        for (const rule of Array.from(sheet.cssRules)) {
          const text = (rule as CSSStyleRule).selectorText;
          if (typeof text !== 'string') continue;
          for (const s of selectors) if (text.includes(s)) found.push(`${s} -> ${text}`);
        }
      }
      return found;
    }, MOVED);

    await clean.close();

    expect(
      inShell,
      `these moved to a lazy stylesheet and are back in the shell:\n  ${inShell.join('\n  ')}`,
    ).toHaveLength(0);
  });
});
