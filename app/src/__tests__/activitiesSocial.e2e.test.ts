/**
 * Reactions, comments and Respond on the Activities page, in a real Chromium (Bajaur — PLAN §4b
 * G2/G3, ADR-0044). Meta is stubbed; everything else is real.
 *
 * What is pinned:
 *
 *   * the DC marks a post *Seen* and takes it off again; the card carries the count;
 *   * a comment written on the card appears on it, and is read by the officer on their own page;
 *   * **Respond** is drawn for the DC and not for the officer; a message sent with it shows under
 *     the post as *Sent*, and nothing of it is on the officer's page;
 *   * a send that cannot go says why on the card.
 *
 * What an account is *allowed* is the server's (`activitySocial.test.ts`,
 * `activityResponses.test.ts`); this pins that the page offers it, and shows what happened.
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
import { noteInbound } from '../db/whatsappStore.js';
import { toE164, type WhatsAppConfig } from '../ops/whatsapp.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('Activities — reactions, comments, Respond (ADR-0044)', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let root: string;

  const sent: Record<string, unknown>[] = [];
  const whatsapp: WhatsAppConfig = {
    phoneNumberId: '999',
    accessToken: 'not-a-real-token',
    appSecret: 'not-a-real-secret',
    verifyToken: 'not-a-real-verify-token',
    templateName: 'district_message_v3',
    templateLanguage: 'en',
    baseUrl: 'https://example.invalid/v21.0',
  };

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-social-e2e-'));

    api = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      webRoot,
      activitiesRoot: root,
      whatsapp,
      whatsappFetch: (async (_url: string, init?: { body?: unknown }) => {
        if (typeof init?.body === 'string') {
          sent.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return new Response(JSON.stringify({ messages: [{ id: `wamid.e2e.${randomUUID()}` }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
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

  /** An officer with one post, and the caption that finds its card. */
  async function officerWithPost(): Promise<{ phone: string; caption: string }> {
    const officer = await seedActor(pool, { title: `Social e2e ${randomUUID()}`, role: 'member' });
    const caption = `Canal inspection ${randomUUID().slice(0, 8)}`;
    const unit = await pool.query<{ unit_id: string }>(
      `INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id`,
      [`Social e2e ${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption)
       VALUES ($1, $2, CURRENT_DATE, $3)`,
      [unit.rows[0]!.unit_id, officer.personId, caption],
    );
    return { phone: officer.phone, caption };
  }

  it('marks a post, comments on it, and the officer reads the comment', async () => {
    const dc = await seedActor(pool, { title: 'Social e2e DC', role: 'owner' });
    const { phone, caption } = await officerWithPost();

    const page = await openActivities(dc.phone, false);
    const card = page.locator('#feed article', { hasText: caption });
    await card.waitFor();

    const seen = card.locator('button.mark[data-kind="seen"]');
    expect(await seen.getAttribute('aria-pressed')).toBe('false');
    await seen.click();
    await card.locator('button.mark[data-kind="seen"][aria-pressed="true"]').waitFor();
    expect(await card.locator('button.mark[data-kind="seen"] .count').textContent()).toBe('1');
    // The other mark replaces it: one per person.
    await card.locator('button.mark[data-kind="well_done"]').click();
    await card.locator('button.mark[data-kind="well_done"][aria-pressed="true"]').waitFor();
    expect(await card.locator('button.mark[data-kind="seen"] .count').count()).toBe(0);
    // And a second tap takes it off.
    await card.locator('button.mark[data-kind="well_done"]').click();
    await card.locator('button.mark[data-kind="well_done"][aria-pressed="false"]').waitFor();

    await card.locator('.comment-form input').fill('Good work — send the measurements too.');
    await card.locator('.comment-form button').click();
    await card.locator('.comment', { hasText: 'Good work — send the measurements too.' }).waitFor();
    expect(await card.locator('.comment .author').textContent()).toContain('Test Officer');
    // Its own author may delete it.
    expect(await card.locator('.comment button', { hasText: 'Delete' }).count()).toBe(1);

    const theirs = await openActivities(phone, true);
    const same = theirs.locator('#feed article', { hasText: caption });
    await same.locator('.comment', { hasText: 'Good work — send the measurements too.' }).waitFor();
    // Somebody else's comment: nothing to delete it with.
    expect(await same.locator('.comment button', { hasText: 'Delete' }).count()).toBe(0);
  }, 120_000);

  it('offers Respond to the DC only, sends it, and shows it under the post', async () => {
    const dc = await seedActor(pool, { title: 'Respond e2e DC', role: 'owner' });
    const { phone, caption } = await officerWithPost();
    // The officer wrote to the district number today: a plain message may go.
    await noteInbound(pool, toE164(phone), new Date().toISOString());

    const page = await openActivities(dc.phone, false);
    const card = page.locator('#feed article', { hasText: caption });
    await card.waitFor();
    expect(await card.locator('.respond-form').isVisible()).toBe(false);

    await card.getByRole('button', { name: 'Respond' }).click();
    expect(await card.locator('.respond-form').textContent()).toContain(phone);
    await card.locator('.respond-form textarea').fill('Please send the staff list.');
    const before = sent.length;
    await card.getByRole('button', { name: 'Send on WhatsApp' }).click();

    await card.locator('.response.out', { hasText: 'Please send the staff list.' }).waitFor();
    expect(await card.locator('.response.out .state').textContent()).toBe('Sent');
    expect(await card.locator('.respond-form').isVisible()).toBe(false);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!['to']).toBe(toE164(phone));

    // The officer's own page: no button, no message, no heading for either.
    const theirs = await openActivities(phone, true);
    const same = theirs.locator('#feed article', { hasText: caption });
    await same.waitFor();
    expect(await same.getByRole('button', { name: 'Respond' }).count()).toBe(0);
    expect(await same.locator('.responses').count()).toBe(0);
    expect(await same.textContent()).not.toContain('Please send the staff list.');
  }, 120_000);

  it('says on the card why a message could not go', async () => {
    const dc = await seedActor(pool, { title: 'Respond e2e DC shut', role: 'owner' });
    // No message from this officer in the last day, and no template: nothing can be sent.
    const { caption } = await officerWithPost();

    const page = await openActivities(dc.phone, false);
    const card = page.locator('#feed article', { hasText: caption });
    await card.getByRole('button', { name: 'Respond' }).click();
    await card.locator('.respond-form textarea').fill('Hello');
    const before = sent.length;
    await card.getByRole('button', { name: 'Send on WhatsApp' }).click();
    await card.locator('.responses > .error:not([hidden])').waitFor();
    expect(await card.locator('.responses > .error').textContent()).toContain('Nothing was sent');
    expect(sent.length).toBe(before);
    // The words are still in the box, to send another way.
    expect(await card.locator('.respond-form textarea').inputValue()).toBe('Hello');
  }, 120_000);
});
