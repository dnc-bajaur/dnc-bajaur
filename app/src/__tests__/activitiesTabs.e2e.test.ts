/**
 * Activities tabs and its first screen, in a real Chromium (Bajaur — PLAN §4 E3 "fewer tabs",
 * then §4b G1 "feed first", ADR-0044).
 *
 * What is pinned:
 *
 *   * the DC sees Activities · New post · Pending (with its count, and only while something
 *     waits) · More; Officers, History and My account open from More; the Department list is
 *     under Officers;
 *   * History holds the log and the Recycle bin, one at a time;
 *   * a member sees exactly Activities · New post · My account;
 *   * the page opens on the posts — All / Departments, the filter folded away — and a card says
 *     who sent it, with their number; Departments lists each department with its count.
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

  /** The tabs as the account sees them — one not drawn (Pending at nought, More's own) is not one. */
  const tabLabels = (page: Page): Promise<string[]> =>
    page.locator('#tabs button:visible').allTextContents();

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

  it('gives the DC Activities, New post, Pending with its count, and the rest under More', async () => {
    const dc = await seedActor(pool, { title: 'Tabs e2e DC', role: 'owner' });
    const count = await addPending();

    const page = await openActivities(dc.phone, false);
    await page.waitForSelector(`#tabs button[data-tab="pending"]:has-text("(${count})")`);
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', `Pending (${count})`, 'More']);

    await page.locator('#tabs button[data-more]').click();
    expect(await tabLabels(page)).toEqual([
      'Activities',
      'New post',
      `Pending (${count})`,
      'More',
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

    // Back on a front tab, More folds away again.
    await page.locator('#tabs button[data-tab="posts"]').click();
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', `Pending (${count})`, 'More']);
  }, 120_000);

  it('opens on the feed: All and Departments, no form, and a card that says who sent it', async () => {
    const dc = await seedActor(pool, { title: 'Feed e2e DC', role: 'owner' });
    const officer = await seedActor(pool, { title: 'Feed e2e officer', role: 'member' });
    const tag = randomUUID().slice(0, 8);
    const unit = await pool.query<{ unit_id: string }>(
      `INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id`,
      [`Feed e2e ${tag}`],
    );
    await pool.query(`INSERT INTO activity_unit (name) VALUES ($1)`, [`Feed e2e quiet ${tag}`]);
    await pool.query(
      `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption)
       VALUES ($1, $2, CURRENT_DATE, $3)`,
      [unit.rows[0]!.unit_id, officer.personId, `School visit ${tag}`],
    );

    const photoId = randomUUID();
    await pool.query(
      `INSERT INTO activity_media (media_id, post_id, kind, status, content_type, byte_size, sha256, stored_path)
       SELECT $1, post_id, 'photo', 'ready', 'image/jpeg', 3, $2, $3
         FROM activity_post WHERE caption = $4`,
      [photoId, 'a'.repeat(64), `${photoId}.jpg`, `School visit ${tag}`],
    );

    const page = await openActivities(dc.phone, false);
    // The first thing on the page is the posts: the filter's fields are folded away.
    await page.waitForSelector('#feed article');
    expect(await page.locator('#feedPick button').allTextContents()).toEqual([
      'All',
      'Departments',
    ]);
    expect(await page.locator('#filterBox').isVisible()).toBe(false);
    // Nothing to choose or fill before the posts: no list to pick from, no date to enter. (A
    // card's own comment box is not a form in the way.)
    expect(
      await page
        .locator('#view-posts select:visible, #view-posts input[type="date"]:visible')
        .count(),
    ).toBe(0);

    // The card names its sender, with the number (ADR-0044 §2).
    const card = page.locator('#feed article', { hasText: `School visit ${tag}` });
    expect(await card.locator('.author').textContent()).toContain('Test Officer');
    expect(await card.locator('a.phone').textContent()).toBe(officer.phone);
    expect(await card.locator('a.phone').getAttribute('href')).toMatch(/^tel:\+?\d+$/);
    // Every photo carries its own Download.
    const save = card.locator('.photos a.save');
    expect(await save.getAttribute('href')).toBe(`/activities/media/${photoId}?download=1`);
    expect(await save.getAttribute('aria-label')).toBe('Download');

    // Departments: a row each with its count; one tap is that department's posts, and a way back.
    await page.locator('#feedPick button[data-feed="units"]').click();
    const tile = page.locator(`#unitTiles button[data-unit="${unit.rows[0]!.unit_id}"]`);
    await tile.waitFor();
    expect(await tile.textContent()).toContain(`Feed e2e ${tag}`);
    expect(await tile.textContent()).toContain('1 post');
    expect(
      await page.locator('#unitTiles button', { hasText: `Feed e2e quiet ${tag}` }).textContent(),
    ).toContain('No posts');
    expect(await page.locator('#feed').isVisible()).toBe(false);

    await tile.click();
    await page.waitForSelector('#unitHead:not([hidden])');
    expect(await page.locator('#unitTitle').textContent()).toBe(`Feed e2e ${tag}`);
    await page.waitForSelector('#feed article');
    expect(await page.locator('#feed article').count()).toBe(1);

    await page.locator('#unitBack').click();
    await tile.waitFor();

    // Filter is one tap away, and All brings every department back.
    await page.locator('#feedPick button[data-feed="all"]').click();
    await page.waitForSelector('#feed article');
    await page.locator('#filterToggle').click();
    expect(await page.locator('#fFrom').isVisible()).toBe(true);
  }, 120_000);

  it('does not draw Pending while nothing waits', async () => {
    const dc = await seedActor(pool, { title: 'Tabs e2e DC quiet', role: 'owner' });
    const page = await (await browser.newContext()).newPage();
    await page.route('**/activities/pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', dc.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
    await page.goto(`${origin}/activities.html`);
    await page.waitForSelector('#feedPick button');
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', 'More']);
  }, 120_000);

  it('gives a member three tabs', async () => {
    const member = await seedActor(pool, { title: 'Tabs e2e member', role: 'member' });
    const page = await openActivities(member.phone, true);
    expect(await tabLabels(page)).toEqual(['Activities', 'New post', 'My account']);
  }, 120_000);
});
