/**
 * Activities tabs, in a real Chromium (Bajaur — PLAN §4 E3, "fewer tabs").
 *
 * What is pinned:
 *
 *   * the DC sees exactly Activities · New post · Pending (with its count) · Officers · History ·
 *     My account, in that order; the Department list is under Officers;
 *   * History holds the log and the Recycle bin, one at a time;
 *   * a member sees exactly Activities · New post · My account.
 *
 * Which tabs exist is a convenience only; the server refuses the DC's routes to a member
 * (`memberGate.test.ts`, `activities.test.ts`).
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

describe.skipIf(dbUrl === undefined)('Activities — fewer tabs (E3)', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let root: string;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-tabs-e2e-'));

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

  /** A member lands on Activities by itself; anyone else lands on the control room first. */
  async function openActivities(phone: string, member: boolean): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    if (member) {
      await page.waitForURL('**/activities.html');
    } else {
      await page.waitForSelector('#nav:not([hidden])');
      await page.goto(`${origin}/activities.html`);
    }
    await page.waitForSelector('#tabs:not([hidden]) button');
    return page;
  }

  const tabLabels = (page: Page): Promise<string[]> =>
    page.locator('#tabs button').allTextContents();

  /** Something waiting on the Pending list: an unknown number's words. Returns how many wait. */
  async function addPending(): Promise<number> {
    const inbound = await pool.query<{ inbound_id: string }>(
      `INSERT INTO activity_inbound (from_phone, state, reason)
       VALUES ($1, 'pending', 'unknown_sender') RETURNING inbound_id`,
      [`+92300${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`],
    );
    await pool.query(
      `INSERT INTO activity_inbound_media (media_id, inbound_id, wa_message_id, kind, body, received_at)
       VALUES ($1, $2, $3, 'text', 'Road blocked near the bridge', now())`,
      [randomUUID(), inbound.rows[0]!.inbound_id, `wamid.tabs-${randomUUID()}`],
    );
    const waiting = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_inbound i
        WHERE i.state = 'pending'
          AND EXISTS (SELECT 1 FROM activity_inbound_media m WHERE m.inbound_id = i.inbound_id)`,
    );
    return Number(waiting.rows[0]!.n);
  }

  it('keeps the Pending count current without a reload', async () => {
    const dc = await seedActor(pool, { title: 'Tabs e2e DC count', role: 'owner' });
    const before = await addPending();

    const page = await (await browser.newContext()).newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', dc.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
    // The page's own timers, driven by hand: a minute passes when this test says so.
    await page.clock.install();
    await page.goto(`${origin}/activities.html`);
    const pending = '#tabs button[data-tab="pending"]';
    await page.waitForSelector(`${pending}:has-text("(${before})")`);

    // Sent on WhatsApp while the page sits open: nothing yet, then the next minute's ask.
    expect(await addPending()).toBe(before + 1);
    expect(await page.locator(pending).textContent()).toBe(`Pending (${before})`);
    await page.clock.fastForward(61_000);
    await page.waitForSelector(`${pending}:has-text("(${before + 1})")`);

    // And at once when the DC comes back to the page, without waiting for the minute.
    expect(await addPending()).toBe(before + 2);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector(`${pending}:has-text("(${before + 2})")`);
    await page.context().close();
  }, 120_000);

  it('gives the DC six tabs, the Pending count, Departments under Officers, and History', async () => {
    const dc = await seedActor(pool, { title: 'Tabs e2e DC', role: 'owner' });
    const count = await addPending();

    const page = await openActivities(dc.phone, false);
    await page.waitForSelector(`#tabs button[data-tab="pending"]:has-text("(${count})")`);
    expect(await tabLabels(page)).toEqual([
      'Activities',
      'New post',
      `Pending (${count})`,
      'Officers',
      'History',
      'My account',
    ]);

    await page.getByRole('button', { name: 'Officers' }).click();
    expect(await page.locator('#view-officers #departments').isVisible()).toBe(true);
    expect(await page.locator('#view-officers #unitForm').isVisible()).toBe(true);

    await page.getByRole('button', { name: 'History' }).click();
    expect(await page.locator('#history-log').isVisible()).toBe(true);
    expect(await page.locator('#history-bin').isVisible()).toBe(false);
    await page.locator('#historyPick button[data-part="bin"]').click();
    expect(await page.locator('#history-bin').isVisible()).toBe(true);
    expect(await page.locator('#history-log').isVisible()).toBe(false);
    expect(
      await page.locator('#historyPick button[data-part="bin"]').getAttribute('aria-pressed'),
    ).toBe('true');
  }, 120_000);

  it('gives a member three tabs', async () => {
    const member = await seedActor(pool, { title: 'Tabs e2e member', role: 'member' });
    const page = await openActivities(member.phone, true);
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', 'My account']);
  }, 120_000);
});
