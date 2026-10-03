/**
 * The Record's table fits the space it is given — PLAN F5.
 *
 * Found on a 1366px laptop: beside the filter column the table is about 855px wide, and its seven
 * tracks needed 1038px. The **Action** column — the header and every row's *Inspect →* — hung off
 * the right edge, and the whole page scrolled sideways. Nothing errored; `board.e2e` measures that
 * each cell sits under its title, and it did.
 *
 * What is pinned, at three widths (with the filter column, at its breakpoint, and without it), in
 * English and in Urdu (right-to-left):
 *
 *   * the page does not scroll sideways;
 *   * every header cell lies inside the header, and every cell of a row inside its row;
 *   * the Action header is on screen.
 *
 * And at 800px, where the page is still as narrow as a form: the rows are cards, not a table
 * (the table layout used to start at 768px, in a page 510px wide).
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
import { seedActor, TEST_PASSWORD, enableAllCapabilities } from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the Record fits its own width', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);
    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const controlRoom = await seedActor(pool, {
      title: `Record Width Control Room ${Date.now()}`,
      tier: 'district',
    });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', controlRoom.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
    // A row to measure: the widest words the columns carry by default.
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'fire', severity: 'critical', description: 'width' }),
      });
    });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  interface Measured {
    readonly sideways: number;
    readonly outside: string[];
    readonly action: { left: number; right: number } | null;
    readonly width: number;
  }

  async function measure(width: number, lang: 'en' | 'ur'): Promise<Measured> {
    await page.setViewportSize({ width, height: 768 });
    await page.evaluate((l) => localStorage.setItem('dnc-bajaur.lang', l), lang);
    await page.reload();
    await page.waitForSelector('#nav:not([hidden])');
    await page.click('#navBoard');
    await page.waitForSelector('#boardRows .row');
    if (lang === 'ur') {
      await page.waitForFunction(
        () => document.getElementById('navBoard')?.textContent === 'ریکارڈ',
      );
    }
    return page.evaluate(() => {
      const outside: string[] = [];
      const within = (box: Element, label: string): void => {
        const b = box.getBoundingClientRect();
        for (const cell of Array.from(box.children)) {
          const c = cell.getBoundingClientRect();
          if (c.width === 0) continue; // a cell this layout does not draw
          if (c.left < b.left - 0.5 || c.right > b.right + 0.5) {
            outside.push(`${label}: "${(cell.textContent ?? '').trim().slice(0, 24)}"`);
          }
        }
      };
      const head = document.getElementById('boardHead')!;
      within(head, 'header');
      for (const row of Array.from(document.querySelectorAll('#boardRows .row')))
        within(row, 'row');
      // What a failure needs to be read: how wide the table was, and the tracks it was given.
      if (outside.length > 0) {
        const table = document.getElementById('boardTable')!.getBoundingClientRect().width;
        outside.unshift(
          `table ${Math.round(table)}px: ${getComputedStyle(head).gridTemplateColumns}`,
        );
      }
      const action = head.lastElementChild?.getBoundingClientRect() ?? null;
      const root = document.documentElement;
      return {
        sideways: root.scrollWidth - root.clientWidth,
        outside,
        action: action === null ? null : { left: action.left, right: action.right },
        width: root.clientWidth,
      };
    });
  }

  for (const lang of ['en', 'ur'] as const) {
    for (const width of [1366, 1024, 900]) {
      it(`${width}px, ${lang === 'en' ? 'English' : 'Urdu'}: nothing hangs past the edge`, async () => {
        const m = await measure(width, lang);
        expect(m.outside).toEqual([]);
        expect(m.sideways).toBeLessThanOrEqual(0);
        expect(m.action).not.toBeNull();
        expect(m.action!.right - m.action!.left).toBeGreaterThan(0);
        expect(m.action!.left).toBeGreaterThanOrEqual(0);
        expect(m.action!.right).toBeLessThanOrEqual(m.width);
      }, 60_000);
    }

    it(`800px, ${lang === 'en' ? 'English' : 'Urdu'}: the page is form-narrow, so rows are cards`, async () => {
      const m = await measure(800, lang);
      // No column titles in card mode — the header is not drawn at all.
      expect(m.action!.right - m.action!.left).toBe(0);
      expect(m.outside).toEqual([]);
      expect(m.sideways).toBeLessThanOrEqual(0);
    }, 60_000);
  }
});
