/**
 * "Install this app" — the banner on the shell and on Activities (Bajaur, PLAN §4 A).
 *
 * Headless Chromium never decides a page is installable on its own, so the browser's
 * `beforeinstallprompt` is dispatched by hand with a stand-in `prompt()`. What is proved is
 * the page's half: the banner appears only when the browser offers, its button replays the
 * browser's own dialog, "Not now" is remembered, an iPhone is told the Share steps, and an
 * app already opened from the home screen is offered nothing.
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
import { seedActor, TEST_PASSWORD } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Fire the browser's install event, with a `prompt()` that records it was called. */
async function browserOffersInstall(page: Page, outcome: 'accepted' | 'dismissed'): Promise<void> {
  await page.evaluate((choice) => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: string }>;
    };
    event.prompt = () => {
      (window as { __prompted?: boolean }).__prompted = true;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: choice });
    window.dispatchEvent(event);
  }, outcome);
}

describe.skipIf(dbUrl === undefined)('Install this app', () => {
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

  it('offers nothing when the browser does not', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    expect(await page.locator('#installBanner').count()).toBe(0);
    await context.close();
  });

  it('Android / Windows: one tap replays the browser’s own install dialog', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');

    await browserOffersInstall(page, 'accepted');
    const banner = page.locator('#installBanner');
    await banner.waitFor();
    expect(await banner.textContent()).toContain('Install this app');

    await banner.getByRole('button', { name: 'Install' }).click();
    await banner.waitFor({ state: 'detached' });
    expect(await page.evaluate(() => (window as { __prompted?: boolean }).__prompted)).toBe(true);
    await context.close();
  });

  it('“Not now” is remembered in this browser', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');

    await browserOffersInstall(page, 'accepted');
    const banner = page.locator('#installBanner');
    await banner.getByRole('button', { name: 'Not now' }).click();
    await banner.waitFor({ state: 'detached' });

    await page.reload();
    await page.waitForSelector('#login');
    await browserOffersInstall(page, 'accepted');
    expect(await page.locator('#installBanner').count()).toBe(0);
    await context.close();
  });

  it('iPhone: says the Share steps, with no button that cannot work', async () => {
    const context = await browser.newContext({ userAgent: IPHONE });
    const page = await context.newPage();
    await page.goto(origin);

    const banner = page.locator('#installBanner');
    await banner.waitFor();
    expect(await banner.textContent()).toContain('Add to Home Screen');
    expect(await banner.getByRole('button', { name: 'Install' }).count()).toBe(0);
    await context.close();
  });

  it('opened from the home screen: offers nothing', async () => {
    const context = await browser.newContext({ userAgent: IPHONE });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    expect(await page.locator('#installBanner').count()).toBe(0);
    await context.close();
  });

  it('Activities — where an officer lands — is installable and offers it too', async () => {
    // Signed out, Activities sends you to sign-in; a member signing in lands on it. So sign in
    // as one, or this would be testing the shell twice.
    const member = await seedActor(pool, { title: 'Install e2e member', role: 'member' });
    const context = await browser.newContext({ userAgent: IPHONE });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', member.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForURL('**/activities.html');
    await page.waitForSelector('#who:not(:empty)');

    expect(await page.locator('link[rel="manifest"]').getAttribute('href')).toBe(
      '/manifest.webmanifest',
    );
    await page.locator('#installBanner').waitFor();
    expect(new URL(page.url()).pathname).toBe('/activities.html');
    await context.close();
  });
});
