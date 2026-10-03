/**
 * The sign-in link's page, in a real Chromium (ADR-0043, Bajaur E5).
 *
 * The rules are pinned over HTTP in `loginLink.test.ts`. What only a browser shows: the officer
 * opens the link, sees their own name, chooses a password, and lands signed in on Activities;
 * opening the same link again says it is used and points to the sign-in page.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { seedActor, TEST_PASSWORD } from '../testing/seed.js';
import { login } from '../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the sign-in link page (E5)', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    api = createSyncServer({ pool, authMode: 'session', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('lets the officer choose a password and lands them on Activities; a second visit says used', async () => {
    const dc = await seedActor(pool, { title: 'Link e2e DC', role: 'admin' });
    const dcToken = (await login(pool, dc.phone, TEST_PASSWORD))!.token;

    const phone = `+92306${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const fullName = `Link e2e Officer ${randomUUID().slice(0, 6)}`;
    const person = await pool.query<{ person_id: string }>(
      'INSERT INTO person (full_name, phone) VALUES ($1, $2) RETURNING person_id',
      [fullName, phone],
    );
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier) VALUES ($1, 'post') RETURNING seat_id`,
      [`Link e2e Post ${randomUUID().slice(0, 6)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);

    const given = await fetch(`${origin}/activities/officers/${person.rows[0]!.person_id}/login`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dcToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ link: true }),
    });
    expect(given.status).toBe(201);
    const url = ((await given.json()) as { sent: { url: string } }).sent.url;
    const path = new URL(url).pathname;

    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}${path}`);
    await page.waitForSelector('#form:not([hidden])');
    expect(await page.locator('#who').textContent()).toBe(fullName);

    await page.fill('#pw1', 'my-chosen-password-2026');
    await page.fill('#pw2', 'a-different-password-2026');
    await page.click('#save');
    await page.waitForSelector('#error:not([hidden])');

    await page.fill('#pw2', 'my-chosen-password-2026');
    await page.click('#save');
    await page.waitForURL('**/activities.html');
    await page.waitForSelector('#who:not(:empty)');
    expect(await page.locator('#who').textContent()).toBe(fullName);

    const again = await (await browser.newContext()).newPage();
    await again.goto(`${origin}${path}`);
    await again.waitForSelector('#toSignIn:not([hidden])');
    expect(await again.locator('#status').textContent()).toContain('already been used');
  }, 120_000);
});
