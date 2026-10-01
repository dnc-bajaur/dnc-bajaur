/**
 * The Settings panel in a real browser — ADR-0032 phase 3.
 *
 * `settings.test.ts` proves the server half exhaustively. This proves the parts only a browser
 * can:
 *
 *  1. **The lazy bundle mounts.** `settings.js` + `settings.css` are fetched on first open, and
 *     all four tabs (Overview · Accounts · Access log · Security policy) render.
 *  2. **The "Add account" drawer posts what it collected**, and the new row reads
 *     *Must change password* — `createAccount` sets the flag for every account made this way.
 *     Every editable row here opens a right-hand drawer (2026-09-01), `admin.ts`'s pattern.
 *  3. **A `must_change_password` account is held on "change my password" and cannot leave it.**
 *     The forced dialog has no Cancel, Esc does not dismiss it, and completing it clears the
 *     flag server-side and lets the account into the app. This lives in the shell (`main.ts`),
 *     not the lazy bundle, because a forced `operator` may have no Settings access at all.
 *  4. **INV-05 — the tab is a courtesy.** An `operator` reaching `/settings/accounts` with their
 *     own token is refused by the server whatever the shell would draw.
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
import { seedActor, TEST_PASSWORD, type TestActor } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const TEMP_PASSWORD = 'temp-pass-8899-x';
const NEW_PASSWORD = 'operator-new-pw-2026';

describe.skipIf(dbUrl === undefined)('the Settings panel', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let owner: TestActor;

  /** The operator the first test adds through the panel — its phone is read back in later tests. */
  const operatorPhone = `+92311${randomUUID().slice(0, 7).replace(/\D/g, '9')}`;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    owner = await seedActor(pool, { title: 'Settings Owner', tier: 'district', role: 'owner' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function signIn(
    p: Page,
    phone: string,
    password: string,
    settled: 'who' | 'forced',
  ): Promise<void> {
    await p.goto(origin);
    await p.waitForSelector('#login');
    await p.fill('#phone', phone);
    await p.fill('#password', password);
    await p.click('#loginSubmit');
    if (settled === 'forced') await p.waitForSelector('.pwdlg[open]', { timeout: 20_000 });
    else await p.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
  }

  async function openSettings(): Promise<void> {
    await page.click('#navSettings');
    await page.waitForSelector('#settingsView:not([hidden])', { timeout: 20_000 });
    await page.waitForSelector('#settingsTabs button[data-tab="overview"]', { timeout: 25_000 });
  }

  /** The `input`/`select` of the open drawer's `.settings-field` whose caps label contains `label`. */
  function drawerField(label: string) {
    return page
      .locator('#settingsDrawerBackdrop .settings-field', { hasText: label })
      .locator('input, select');
  }

  it('1. mounts lazily and renders all six tabs', async () => {
    await signIn(page, owner.phone, TEST_PASSWORD, 'who');
    await openSettings();

    // The bundle and its stylesheet were both fetched.
    expect(await page.locator('#settingsCss').count()).toBe(1);

    // Overview — the counts-as-doors grid.
    await page.waitForSelector('#settingsOverview .settings-cards', { timeout: 20_000 });

    await page.click('#settingsTabs button[data-tab="accounts"]');
    await page.waitForSelector('#settingsAccounts table.settings-table', { timeout: 20_000 });

    await page.click('#settingsTabs button[data-tab="access"]');
    await page.waitForSelector('#settingsAccess table.settings-table', { timeout: 20_000 });

    await page.click('#settingsTabs button[data-tab="security"]');
    await page.waitForSelector('#settingsSecurity table', { timeout: 20_000 });
    // Read-only, and it shows the two values the server enforces (MIN_PASSWORD_LENGTH,
    // SESSION_TTL_HOURS — both 12).
    const security = (await page.textContent('#settingsSecurity')) ?? '';
    expect(security).toContain('12 characters');
    expect(security).toContain('12 hours');

    // The two tabs that moved here from Administration (ADR-0032 phase 4).
    await page.click('#settingsTabs button[data-tab="capabilities"]');
    await page.waitForSelector('#settingsCapabilities table.settings-table', { timeout: 20_000 });

    await page.click('#settingsTabs button[data-tab="layout"]');
    await page.waitForSelector('#settingsLayout table.settings-table', { timeout: 20_000 });
    expect(await page.locator('#settingsLayout .settings-fit').count()).toBeGreaterThan(0);
    // The 1920×1080 preview — a real iframe, styled by the rules that moved into settings.css.
    expect(await page.locator('#layoutPreviewFrame').count()).toBe(1);
  });

  it('2. adds an operator through the add-account drawer, marked must-change-password', async () => {
    await page.click('#settingsTabs button[data-tab="accounts"]');
    await page.waitForSelector('#settingsAccounts table.settings-table', { timeout: 20_000 });

    await page.click('#settingsAccounts .settings-head button');
    await page.waitForSelector('#settingsDrawerBackdrop.open', { timeout: 10_000 });

    await drawerField('Full name').fill('New Operator');
    await drawerField('Phone number').fill(operatorPhone);
    await drawerField('Role').selectOption('operator');
    await drawerField('Temporary password').fill(TEMP_PASSWORD);
    await page.click('#settingsDrawerBackdrop .settings-drawer-actions button');

    const row = page.locator(`#settingsAccounts tr[data-account]`, { hasText: operatorPhone });
    await row.waitFor({ timeout: 20_000 });
    const rowText = (await row.textContent()) ?? '';
    expect(rowText).toContain('operator');
    expect(rowText).toContain('Must change password');
  }, 60_000);

  it('3. forces the new operator through "change my password" and will not let go', async () => {
    const opContext = await browser.newContext();
    const op = await opContext.newPage();
    await signIn(op, operatorPhone, TEMP_PASSWORD, 'forced');

    const dlg = op.locator('.pwdlg');
    // A forced dialog has no Cancel, and Esc does not dismiss it.
    expect(await dlg.locator('button', { hasText: 'Cancel' }).count()).toBe(0);
    await op.keyboard.press('Escape');
    expect(await dlg.isVisible()).toBe(true);

    const fields = dlg.locator('input[type="password"]');
    await fields.nth(0).fill(TEMP_PASSWORD);
    await fields.nth(1).fill(NEW_PASSWORD);
    await fields.nth(2).fill(NEW_PASSWORD);
    await dlg.locator('button', { hasText: 'Change password' }).click();

    // It closes, the flag is cleared server-side, and the account is in the app.
    await op.waitForSelector('.pwdlg', { state: 'detached', timeout: 20_000 });
    expect(await op.isVisible('#who')).toBe(true);

    await opContext.close();

    // A fresh sign-in (its own context, no cookie) with the new password is not forced anywhere.
    const freshContext = await browser.newContext();
    const again = await freshContext.newPage();
    await signIn(again, operatorPhone, NEW_PASSWORD, 'who');
    expect(await again.locator('.pwdlg').count()).toBe(0);

    await freshContext.close();
  }, 90_000);

  it('4. INV-05 — an operator reaching the endpoint directly is refused by the server', async () => {
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: operatorPhone, password: NEW_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    // Accounts, and the two that moved here in phase 4 — each its own permission, all refused.
    expect((await fetch(`${origin}/settings/accounts`, { headers: auth })).status).toBe(403);
    expect((await fetch(`${origin}/settings/capabilities`, { headers: auth })).status).toBe(403);
    expect((await fetch(`${origin}/settings/dashboard-layout`, { headers: auth })).status).toBe(
      403,
    );
  });

  it('5. the owner works the two moved tabs — a screen toggles, a panel is added', async () => {
    // Shares the page with test 1, still signed in as the owner.
    await page.click('#settingsTabs button[data-tab="capabilities"]');
    await page.waitForSelector('#settingsCapabilities tr[data-capability="search"]', {
      timeout: 20_000,
    });

    const wasOff = (
      (await page.textContent('#settingsCapabilities tr[data-capability="search"]')) ?? ''
    ).includes('Off');
    // The row opens a drawer; the drawer's one action button carries the toggle, which still
    // routes through `ask()` for the consequence.
    await page.click('#settingsCapabilities tr[data-capability="search"]');
    await page.waitForSelector('#settingsDrawerBackdrop.open', { timeout: 10_000 });
    await page.click('#settingsDrawerBackdrop .settings-drawer-actions button');
    await page.locator('dialog.settings-ask .settings-askyes').click();
    // The whole tab re-renders on success; the row comes back with the opposite status.
    await page.waitForFunction(
      (off: boolean) => {
        const row = document.querySelector('#settingsCapabilities tr[data-capability="search"]');
        return row !== null && (row.textContent ?? '').includes(off ? 'On' : 'Off');
      },
      wasOff,
      { timeout: 20_000 },
    );

    await page.click('#settingsTabs button[data-tab="layout"]');
    await page.waitForSelector('#settingsLayout table.settings-table', { timeout: 20_000 });
    const placedBefore = await page.locator('#settingsLayout tr[data-panel]').count();

    await page.selectOption('#settingsLayoutAdd', { index: 0 });
    await page.click('#settingsLayout .settings-head button');
    await page.waitForFunction(
      (n: number) => document.querySelectorAll('#settingsLayout tr[data-panel]').length === n + 1,
      placedBefore,
      { timeout: 20_000 },
    );
    // Saved server-side, so it is no longer the built-in default.
    expect(await page.locator('#settingsLayout').textContent()).not.toContain(
      'Nobody has arranged this yet',
    );
  }, 60_000);
});
