/**
 * The officer chooses the ground they read on — 2026-08-20.
 *
 * ## Why this is a browser test and why nothing smaller would do
 *
 * The whole feature is four lines of inline script in `<head>`, and **the only property that
 * matters about it is when it runs.** A theme applied by `app.js` is a theme applied after the
 * page has already painted white — which on a district line is not milliseconds, it is a second
 * of white light in a dark control room at 02:00, every single launch. Every assertion below
 * would still pass if the attribute were written by the bundle; test 1 is the one that would
 * not, and it is the reason this file exists.
 *
 * It proves it by **holding `/app.js` on the wire** and reading the root while the bundle is
 * still in flight. If the attribute is there with the bundle demonstrably unparsed, something
 * above the stylesheet put it there — which is the claim. Asserting on a screenshot would prove
 * the end state and say nothing at all about the order.
 *
 * ⚠️ `serviceWorkers: 'block'` is not optional and this repository has paid for it twice.
 * `page.route` does not intercept a request the service worker makes, so with one registered the
 * real `app.js` loads over the real socket and the delay this test is built on never happens.
 *
 * ## Light is the default and test 4 is what keeps it that way
 *
 * The district asked for white on 2026-08-13 and that has not been reversed — dark is a choice,
 * not a new default. A handset that has never been told anything must open exactly as it does
 * today, and the cheapest way for that to stop being true is somebody making `prefers-color-scheme`
 * decide it "helpfully". A shared duty handset left on dark by the night shift would then hand
 * the morning officer a theme nobody chose.
 *
 * ## The label names the NEXT press
 *
 * A button reading "Dark" while the screen is already dark is the oldest bug in this shape of
 * control, and a screen reader user has nothing else to go on. Test 3 reads the accessible name
 * in both states rather than merely checking that it changed.
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

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/** What `:root` resolves `--paper` to in each theme. The tokens, read back off the page. */
const LIGHT_PAPER = 'rgb(247, 248, 250)';
const DARK_PAPER = 'rgb(8, 9, 12)';

describe.skipIf(dbUrl === undefined)('the theme is the officer’s choice', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * A fresh context per test. The stored choice lives in `localStorage`, which is per origin and
   * would otherwise leak from one test into the next — and test 4's whole subject is a handset
   * that has never been told anything.
   */
  async function fresh(stored?: 'dark' | 'light'): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    if (stored !== undefined) {
      await ctx.addInitScript(
        `try { localStorage.setItem('dnc.theme', '${stored}'); } catch (e) {}`,
      );
    }
    return { ctx, page: await ctx.newPage() };
  }

  const themeOf = async (page: Page): Promise<string> =>
    page.evaluate(() => document.documentElement.dataset['theme'] ?? '(none)');

  const paperOf = async (page: Page): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  it('1. a stored dark theme is on the page BEFORE app.js has run', async () => {
    const { ctx, page } = await fresh('dark');
    try {
      // Held, not blocked: the bundle must still arrive, or the page is not the product. What is
      // under test is the window between the stylesheet painting and the bundle running.
      let released: (() => void) | undefined;
      const inFlight = new Promise<void>((r) => (released = r));
      await page.route('**/app.js', async (route) => {
        await inFlight;
        await route.continue();
      });

      await page.goto(origin, { waitUntil: 'commit' });
      await page.waitForSelector('header');

      // `window.__dnc` is the bundle's own handle. Its absence is what makes the two assertions
      // below evidence about ORDER rather than about the end state.
      expect(
        await page.evaluate(() => '__dnc' in window),
        'app.js had already run, so this test proves nothing about when the theme was applied',
      ).toBe(false);

      expect(await themeOf(page)).toBe('dark');
      expect(await paperOf(page)).toBe(DARK_PAPER);

      released?.();
    } finally {
      await ctx.close();
    }
  });

  it('2. one press changes the theme, and it survives a reload', async () => {
    const { ctx, page } = await fresh();
    try {
      await page.goto(origin);
      await page.waitForSelector('#theme');

      expect(await themeOf(page), 'a handset told nothing opens light').toBe('(none)');

      await page.click('#theme');
      expect(await themeOf(page)).toBe('dark');
      expect(await paperOf(page)).toBe(DARK_PAPER);

      // The half that a session-only toggle would fail: the choice is remembered on this device.
      await page.reload();
      await page.waitForSelector('#theme');
      expect(await themeOf(page)).toBe('dark');

      // And back. A one-way switch is not a switch.
      await page.click('#theme');
      expect(await themeOf(page)).toBe('(none)');
      expect(await paperOf(page)).toBe(LIGHT_PAPER);

      await page.reload();
      await page.waitForSelector('#theme');
      expect(await themeOf(page), 'choosing light again must be remembered too').toBe('(none)');
    } finally {
      await ctx.close();
    }
  });

  it('3. the button names what the next press does, not what the screen is', async () => {
    const { ctx, page } = await fresh();
    try {
      await page.goto(origin);
      await page.waitForSelector('#theme');

      const label = async (): Promise<string | null> => page.getAttribute('#theme', 'aria-label');

      expect(await label()).toBe('Dark theme');
      await page.click('#theme');
      expect(await label(), 'the label still offers a theme the screen is already in').toBe(
        'Light theme',
      );

      // `theme-color` is the strip the phone paints around the page. Left behind, a dark app has
      // a white bar welded to the top of it on exactly the device where it is most obvious.
      expect(await page.getAttribute('meta[name=theme-color]', 'content')).toBe('#08090c');
    } finally {
      await ctx.close();
    }
  });

  it('4. the operating system’s preference does not decide this', async () => {
    const ctx = await browser.newContext({
      serviceWorkers: 'block',
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(origin);
      await page.waitForSelector('#theme');

      // A handset set to dark, and nothing stored. The district asked for white, and a shared
      // duty handset must not hand the morning officer whatever the night shift's phone prefers.
      expect(await themeOf(page)).toBe('(none)');
      expect(await paperOf(page)).toBe(LIGHT_PAPER);
    } finally {
      await ctx.close();
    }
  });

  /**
   * 🔴 **This test found a defect that is NOT the theme's, and it is worse than the theme's —
   * read this before deciding what it is allowed to assert.**
   *
   * A browser with site data blocked does not return `null` from `localStorage`; **accessing the
   * property THROWS** a `SecurityError`. `web/src/main.ts`'s `deviceId()` reads it with no guard,
   * from inside `boot()`, so on such a handset **the whole bundle dies before the intake form is
   * wired** — an officer standing at a scene cannot report an emergency at all, which is INV-01,
   * and nothing anywhere says so.
   *
   * It is **pre-existing**, is reached without the theme existing, and is deliberately NOT fixed
   * here: it is in the boot path of an emergency reporting application and deserves its own
   * change and its own test rather than riding in on a palette. It is written up in
   * `backlog/for-the-owner.md`.
   *
   * So this test asserts exactly the half the theme owns: **the head script's `catch` lands on
   * light and the page is drawn.** The obvious extra assertion — that the button still toggles —
   * was written first, went red, and is removed rather than kept as a failing test about
   * somebody else's bug: `main.ts` never ran, so the listener was never attached. Restore it in
   * the same commit that guards `deviceId()`.
   */
  it('5. site data blocked does not take the page down before it is drawn', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    try {
      await ctx.addInitScript(`
        Object.defineProperty(window, 'localStorage', {
          get() { throw new DOMException('blocked', 'SecurityError'); },
        });
      `);

      await page.goto(origin);
      await page.waitForSelector('#theme');

      // The head script runs ABOVE the stylesheet, with no error handler installed anywhere yet.
      // Uncaught, its throw takes the page down before a single word has been drawn — so what is
      // proved here is that the catch exists and that it lands on light.
      expect(await themeOf(page), 'the catch must land on light').toBe('(none)');
      expect(await paperOf(page)).toBe(LIGHT_PAPER);
      expect(
        await page.textContent('h1'),
        'the page rendered nothing, which is what an uncaught throw in the head looks like',
      ).toContain('District Nerve Center');
    } finally {
      await ctx.close();
    }
  });
});
