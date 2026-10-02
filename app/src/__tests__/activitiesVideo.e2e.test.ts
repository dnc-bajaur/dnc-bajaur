/**
 * Activities videos from the page, in a real Chromium (ADR-0039 §4, Bajaur — C3).
 *
 * The server's half of a chunked upload is pinned over HTTP in `activitiesVideo.test.ts`. What
 * only a browser can show is the page's half: an officer picks a video, posts, and **the
 * connection drops part-way** — the page must carry on from what the server says arrived, not
 * start again and not give up, and every byte must arrive exactly once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** A little over two of the page's 4 MB chunks, starting as an MP4 does. */
function mp4(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) b[i] = (i * 31) % 251;
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}

describe.skipIf(dbUrl === undefined)('Activities — sending a video from the page', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let root: string;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-video-e2e-'));

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

  it('carries on after a dropped chunk, and every byte arrives once', async () => {
    const member = await seedActor(pool, { title: 'Video e2e member', role: 'member' });
    const unit = await pool.query<{ unit_id: string }>(
      `INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id`,
      [`Video e2e ${randomUUID()}`],
    );
    await pool.query('UPDATE person SET activity_unit_id = $2 WHERE person_id = $1', [
      member.personId,
      unit.rows[0]!.unit_id,
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();

    // The second chunk's first attempt never reaches the server, as on a weak mobile link.
    let dropped = 0;
    await page.route('**/activities/uploads/*', async (route) => {
      const offset = route.request().headers()['x-upload-offset'];
      if (route.request().method() === 'PUT' && offset !== '0' && dropped === 0) {
        dropped += 1;
        return route.abort('failed');
      }
      return route.continue();
    });

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', member.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForURL('**/activities.html');
    await page.waitForSelector('#who:not(:empty)');

    await page.getByRole('button', { name: 'New post' }).click();
    await page.fill('#pCaption', 'Vaccination team, Union Council 4');
    const video = mp4(9 * 1024 * 1024 + 123);
    await page.setInputFiles('#pVideos', {
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      buffer: video,
    });
    await page.waitForSelector('#pickedVideos .list-row');
    await page.click('#postSubmit');

    // Back on the list once everything is sent, with the video waiting to be prepared.
    await page.waitForSelector('#view-posts:not([hidden]) .video .state', { timeout: 60_000 });
    expect(dropped).toBe(1);

    const row = await pool.query<{
      status: string;
      received_bytes: string;
      byte_size: string;
      upload_path: string;
    }>(
      `SELECT m.status, m.received_bytes, m.byte_size, m.upload_path
         FROM activity_media m JOIN activity_post p ON p.post_id = m.post_id
        WHERE p.author_person_id = $1 AND m.kind = 'video'`,
      [member.personId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      status: 'processing',
      received_bytes: String(video.length),
      byte_size: String(video.length),
    });
    expect(readFileSync(join(root, row.rows[0]!.upload_path)).equals(video)).toBe(true);
    expect(await page.locator('.video .state').first().textContent()).toContain('Being prepared');

    await context.close();
  }, 120_000);
});
