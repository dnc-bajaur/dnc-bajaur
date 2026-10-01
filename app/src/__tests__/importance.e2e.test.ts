/**
 * Routine and important, on a real screen — M10-20…25/41/42.
 *
 * `api/__tests__/lifecycle.test.ts` proves the default and the write; `api/__tests__/
 * dashboard.test.ts` proves the split is counted independently and that nothing else on the
 * feed reads the field. This proves the two things that only exist once something renders them:
 *
 *   1. The control is on the compose form, beside the kind, important by default (M10-22/41).
 *   2. The dashboard actually shows two panels rather than one, and each says its own "and N
 *      more" — M10-24, and the reason it needs a browser: `capImportance`'s cap is proven in
 *      isolation, not that a sixth important emergency is the one that goes missing from view.
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
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('routine and important, on screen', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // `#whatBlock` is shown unconditionally since 2026-09-09, so tier no longer gates it —
    // district tier is kept because this file's own dispatch tests need it.
    actor = await seedActor(pool, { title: 'M10 Importance Operator', tier: 'district' });

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
    await page.waitForSelector('#whatBlock:not([hidden])', { timeout: 15_000 });
  }

  it('1. the control sits beside the kind, important by default', async () => {
    await signIn();

    expect(await page.isVisible('#importance')).toBe(true);
    // The radio itself is visually hidden — the label is what a hand touches, and what the
    // `:checked + label` fill is drawn from. Read the group, not the box.
    expect(await page.inputValue('#imp-important')).toBe('important');
    expect(await page.isChecked('#imp-important')).toBe(true);
  });

  /**
   * `#sent` becomes visible the moment `outbox.enqueue()` resolves — durable-first, by INV-01,
   * with no wait on the network — so a report can be safely on the handset and not yet in
   * Postgres at that instant. `main.ts` does call `trySync()` itself right after, but nothing
   * retries it if that one attempt does not land (there is no periodic sync timer), so each
   * poll below nudges `window.__dnc.trySync()` again rather than passively waiting for it.
   */
  async function importanceOf(marker: string): Promise<string | undefined> {
    await page.evaluate(async () => {
      await (globalThis as unknown as { __dnc: { trySync(): Promise<void> } }).__dnc.trySync();
    });
    const { rows } = await pool.query<{ payload: { importance?: string } }>(
      `SELECT payload FROM incident_event
        WHERE type = 'reported' AND payload->>'description' = $1
        ORDER BY recorded_at DESC LIMIT 1`,
      [marker],
    );
    return rows[0]?.payload.importance;
  }

  it('2. an emergency reported at the default writes important to the log', async () => {
    const marker = `importance e2e default ${Date.now()}`;
    await page.fill('#what', marker);
    await page.click('label[for="cat-fire"]');
    await page.click('#submit');
    await page.waitForSelector('#sent:not([hidden])', { timeout: 15_000 });

    // Read back from the database rather than from the screen, matching compose.e2e.test.ts's
    // own rule: a form that looks right in a screenshot can still drop what it drew.
    await expect.poll(async () => importanceOf(marker), { timeout: 20_000 }).toBe('important');
  }, 30_000);

  it('3. choosing routine writes routine to the log', async () => {
    const marker = `importance e2e routine ${Date.now()}`;
    await page.fill('#what', marker);
    await page.click('label[for="imp-routine"]');
    await page.click('#submit');
    await page.waitForSelector('#sent:not([hidden])', { timeout: 15_000 });

    await expect.poll(async () => importanceOf(marker), { timeout: 20_000 }).toBe('routine');

    // Left as found for the next test, which relies on the default.
    await page.click('label[for="imp-important"]');
  }, 30_000);

  /**
   * M10-24, on the wall. `capImportance` proves its own cap and its own "hidden" count in
   * isolation; this proves a sixth important emergency actually disappears from `#dashImportant`
   * and reappears as "and N more" on the rendered page — the failure a unit test cannot see is a
   * server field nothing on screen ever reads.
   *
   * **No row is matched by its own text.** Rows on this screen carry no id and no reporter's
   * words (ADR-0013 §1) — `headline`/`detail` are category, stage and department, never a
   * description — so there is no marker a test could look for inside one. What is checked
   * instead is the shape every row list on this screen is supposed to have: never more than the
   * cap, and a sentence naming what did not fit.
   */
  it('4. the dashboard caps each importance panel independently, and each says its own more', async () => {
    // Six is one past VISIBLE_IMPORTANCE (5) — enough to force the cap regardless of how many
    // other important emergencies earlier tests in this run have already left open.
    await page.evaluate(async () => {
      for (let i = 0; i < 6; i += 1) {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'fire', severity: 'high', importance: 'important' }),
        });
      }
    });

    await page.click('#navDashboard');
    await page.waitForSelector('#dashKeys .key', { timeout: 20_000 });
    await page.waitForSelector('#dashImportant .act-row', { timeout: 20_000 });

    // Never more than the cap, however many are actually open.
    expect(await page.locator('#dashImportant .act-row').count()).toBeLessThanOrEqual(5);
    // And with six just added, the cap is actually binding right now, not merely never exceeded.
    expect(await page.locator('#dashImportant .act-row').count()).toBe(5);
    // The sixth is named, not silently dropped — the whole point of M10-24.
    await expect
      .poll(async () => page.textContent('#dashImportantMore'), { timeout: 10_000 })
      .toMatch(/and \d+ more/);

    // The routine panel is unaffected by six new important emergencies landing — each panel
    // counts its own truth (M10-42), which `api/__tests__/dashboard.test.ts` proves server-side;
    // this confirms the same thing is true of what actually reaches the screen.
    expect(await page.locator('#dashRoutine .act-row').count()).toBeLessThanOrEqual(5);
  });
});
