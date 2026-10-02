/**
 * Urdu / English, in a real Chromium (Bajaur E4, ADR-0042).
 *
 * What is pinned:
 *
 *   * the switch reads "اردو" on an English page; pressing it reopens the page right-to-left
 *     with the tabs in Urdu — and it survives a reload (per device);
 *   * what people wrote is never translated: a caption that happens to read exactly like a
 *     button ("Approve") stays English on an Urdu page;
 *   * the switch then reads "English", and pressing it brings the English back;
 *   * the control room shell gets the same switch and the same right-to-left page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('Urdu / English (E4)', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let root: string;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-urdu-e2e-'));

    api = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      webRoot,
      activitiesRoot: root,
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  async function signIn(page: Page, phone: string): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
  }

  const tabLabels = (page: Page): Promise<string[]> =>
    page.locator('#tabs button').allTextContents();

  it('turns Activities into Urdu, leaves people’s words alone, and comes back', async () => {
    const member = await seedActor(pool, { title: 'Urdu e2e member', role: 'member' });
    const unit = await pool.query<{ unit_id: string }>(
      `INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id`,
      [`Urdu e2e ${randomUUID()}`],
    );
    // A caption that is, word for word, a button on the page.
    await pool.query(
      `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption)
       VALUES ($1, $2, CURRENT_DATE, 'Approve')`,
      [unit.rows[0]!.unit_id, member.personId],
    );

    const page = await (await browser.newContext()).newPage();
    await signIn(page, member.phone);
    await page.waitForURL('**/activities.html');
    await page.waitForSelector('#tabs:not([hidden]) button');
    expect(await page.locator('#langSwitch').textContent()).toBe('اردو');
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', 'My account']);

    await Promise.all([page.waitForEvent('load'), page.click('#langSwitch')]);
    await page.waitForSelector('#tabs:not([hidden]) button');
    await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending'));
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ur');
    await page.waitForFunction(
      () => document.querySelector('#tabs button')?.textContent === 'سرگرمیاں',
    );
    expect(await tabLabels(page)).toEqual(['سرگرمیاں', 'نئی پوسٹ', 'میرا اکاؤنٹ']);
    expect(await page.locator('#langSwitch').textContent()).toBe('English');

    // The caption "Approve" is someone's words, not the button.
    await page.waitForSelector('#feed .caption');
    expect(await page.locator('#feed .caption').first().textContent()).toBe('Approve');

    // Drawn after the first pass: the New post tab's form is translated too.
    await page.locator('#tabs button[data-tab="new"]').click();
    expect(await page.locator('#postSubmit').textContent()).toBe('پوسٹ کریں');

    // Per device: a reload stays Urdu.
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector('#tabs button')?.textContent === 'سرگرمیاں',
    );

    await Promise.all([page.waitForEvent('load'), page.click('#langSwitch')]);
    await page.waitForSelector('#tabs:not([hidden]) button');
    expect(await page.evaluate(() => document.documentElement.dir)).not.toBe('rtl');
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', 'My account']);
  }, 120_000);

  it('gives the control room the same switch, its words, and Urdu dialogs', async () => {
    const owner = await seedActor(pool, { title: 'Urdu e2e DC', role: 'owner' });
    const page = await (await browser.newContext()).newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    expect(await page.locator('#langSwitch').textContent()).toBe('اردو');
    await Promise.all([page.waitForEvent('load'), page.click('#langSwitch')]);
    await page.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending'));
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    expect(await page.locator('#langSwitch').textContent()).toBe('English');
    expect(await page.locator('#loginSubmit').textContent()).toBe('سائن اِن');

    await page.fill('#phone', owner.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
    // Drawn after sign-in, so translated by the observer, not the first pass.
    await page.waitForFunction(() => document.getElementById('navBoard')?.textContent === 'ریکارڈ');
    expect(await page.locator('#navReport').textContent()).toBe('رپورٹ');
    // The signed-in name is someone's name, never translated.
    expect(await page.locator('#whoName').getAttribute('translate')).toBe('no');

    // A dialog the screens raise in English is shown in Urdu.
    const said = new Promise<string>((resolve) => {
      page.once('dialog', (d) => {
        resolve(d.message());
        void d.dismiss();
      });
    });
    await page.evaluate(() => {
      confirm('Delete this for good? This cannot be undone.');
    });
    expect(await said).toBe('اسے ہمیشہ کے لیے حذف کر دیں؟ یہ واپس نہیں ہو سکے گا۔');
  }, 120_000);
});
