/**
 * Taking something off the board, on a real screen — M10-17/18/40.
 *
 * `api/__tests__/withdrawal.test.ts` proves the server: a reason is required, nothing is
 * removed from the log, search and the daily report keep the row. This proves the three
 * things that only exist once something renders them:
 *
 *   1. The confirmation says, before anything is recorded, that this does not resolve
 *      anything and does not unsend anything already told — the same discipline
 *      `correction`'s own confirmation follows, and the reason `directory.e2e.test.ts`'s
 *      header calls "the sentence that is the point of the whole feature".
 *   2. The board actually stops showing it, and says how many are missing — M10-40 is not a
 *      server number sitting unread; it has to reach the screen.
 *   3. The way back exists and needs nobody's memory of an id — `?withdrawn=1`, reached by a
 *      button on the board rather than typed into an address bar.
 *
 * ## Why each test seeds its own incident
 *
 * `board.ts`'s `summary.withdrawn` counts every withdrawal for the day, across the whole
 * suite. A test asserting an absolute count would break the moment a second test ran before
 * it. Every assertion here reads the count **before** its own action and checks the change,
 * never the number itself — the same reasoning `board.e2e.test.ts`'s own incident count uses.
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

describe.skipIf(dbUrl === undefined)('M10-17/18/40: taking something off the board', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /** District tier — withdrawal is `overrideTiers: ['district']` (M10-16). */
  let controlRoom: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Every screen this suite drives, made available first — ADR-0016, M6-45.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    controlRoom = await seedActor(pool, {
      title: 'Withdrawal Test Control Room',
      tier: 'district',
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', controlRoom.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** An incident, reported through the real route, in the signed-in seat's own session. */
  async function seedIncident(marker: string): Promise<string> {
    const created = await page.evaluate(async (description: string) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'fire', severity: 'moderate', description }),
      });
      return (await res.json()) as { incidentId: string };
    }, marker);
    return created.incidentId;
  }

  async function openDetail(id: string): Promise<void> {
    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, id);
    await page.waitForSelector('#detailView:not([hidden]) #detailTiles .d-tile');
  }

  /**
   * The record tools (Correct this · Withdraw · Restore · Report) live behind the footer's
   * "More" button since 2026-09-06, and every re-render closes it. Call this before touching
   * one of them, and again after any action that re-renders the drawer.
   */
  async function openMore(): Promise<void> {
    await page.click('#detailMoreBtn');
    await page.waitForSelector('#detailMoreMenu:not([hidden])');
  }

  /** The board's own count of how many were withdrawn today — `summary.withdrawn`. */
  async function withdrawnCount(): Promise<number> {
    return page.evaluate(async () => {
      const res = await fetch('/incidents');
      const body = (await res.json()) as { summary: { withdrawn: number } };
      return body.summary.withdrawn;
    });
  }

  /**
   * Answer the next dialogs in order, and record what each one said.
   *
   * Since 2026-09-01 withdrawing is a `confirm()`, not a `prompt()` — it states the cost and no
   * longer asks *why* (the server still takes a fixed reason; INV-06 turns on the actor, the
   * seat and the time). `true` accepts, `null` dismisses; a string still accepts, which is what
   * the correction flow's own optional "what is true instead?" prompt needs.
   *
   * One listener for the whole queue, not one `page.once('dialog')` per expected dialog — two
   * `once` listeners both fire on the first dialog, and the second `accept()` then throws
   * against one already handled. See `roster.e2e.test.ts`'s own version of this helper.
   */
  function answer(replies: readonly (string | true | null)[]): string[] {
    const messages: string[] = [];
    const pending = [...replies];
    const handler = (dialog: {
      message(): string;
      accept(v?: string): Promise<void>;
      dismiss(): Promise<void>;
    }): void => {
      messages.push(dialog.message());
      const next = pending.shift();
      if (next === undefined || next === null) void dialog.dismiss();
      else void dialog.accept(next === true ? undefined : next);
      if (pending.length === 0) page.off('dialog', handler);
    };
    page.on('dialog', handler);
    return messages;
  }

  it('1. asks before it leaves, and backing out changes nothing', async () => {
    const id = await seedIncident(`withdrawal e2e cancel ${Date.now()}`);
    await openDetail(id);

    const before = await withdrawnCount();
    const messages = answer([null]); // dismiss — the operator backed out

    await openMore();
    await page.click('#withdrawIncident');
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBe(1);

    /**
     * The sentence the whole feature rests on — the same three assurances
     * `backlog/m10-plan.md` names as what keeps this from being a delete: it does not resolve
     * anything, it does not unsend anything already told, and it stays in search and on the
     * daily report.
     */
    expect(messages[0]).toMatch(/does NOT resolve/);
    expect(messages[0]).toMatch(/does NOT unsend/);
    /**
     * ⚠️ **This asserted the word `search` until 2026-08-19, and the word had to go.**
     *
     * The promise a control room needs before it acts is *where does this row still live* — and
     * "in search" stops being an answer the moment Search is a control on the Record rather than
     * a screen of its own (Phase 4). What is durable on both sides of that merge is that
     * **nothing is deleted and it can be shown again**, so that is what the sentence says and
     * what this asserts. The property is unchanged; only the place it names is.
     */
    expect(messages[0]).toMatch(/shown again/);
    expect(messages[0]).toMatch(/daily report/);

    // Nothing recorded: the button is still "Withdraw", never "Restore". The pick closed the
    // menu — reopen it to read the footer's tools.
    await page.waitForTimeout(200);
    await openMore();
    expect(await page.isVisible('#withdrawIncident')).toBe(true);
    expect(await page.isVisible('#restoreIncident')).toBe(false);
    expect(await withdrawnCount()).toBe(before);
  });

  it('2. withdraws on one confirmation, leaves the board, and the toggle brings it back marked', async () => {
    const id = await seedIncident(`withdrawal e2e reason ${Date.now()}`);
    await openDetail(id);

    const before = await withdrawnCount();
    // No question is asked any more — the confirmation is accepted and a fixed reason goes with
    // it. The note and the row's title show that reason rather than an operator's sentence.
    const reason = 'Withdrawn from the console';
    answer([true]);
    await openMore();
    await page.click('#withdrawIncident');

    const note = page.locator('.wnote');
    await expect.poll(() => note.textContent(), { timeout: 10_000 }).toContain(reason);
    expect(await note.textContent()).toMatch(/Taken off the Record/);
    expect(await note.textContent()).toMatch(/nothing was deleted/);

    // The button swaps in place — a control room reading this screen afterwards never has to
    // go looking for the way back. Reopen the (re-rendered, closed) menu to see it.
    await openMore();
    await page.waitForSelector('#restoreIncident', { timeout: 10_000 });
    expect(await page.isVisible('#withdrawIncident')).toBe(false);

    expect(await withdrawnCount()).toBe(before + 1);

    // Board: gone from the default view.
    await page.evaluate(() => {
      const dnc = (globalThis as unknown as { __dnc: { showBoard(x: boolean): void } }).__dnc;
      dnc.showBoard(true);
    });
    await page.evaluate(async () => {
      const dnc = (globalThis as unknown as { __dnc: { refreshBoard(): Promise<void> } }).__dnc;
      await dnc.refreshBoard();
    });
    expect(await page.isVisible(`.row[data-incident="${id}"]`)).toBe(false);

    /**
     * **M10-40, on the screen.** The count line names how many left, and the toggle is the
     * only door back to a row an operator does not have the id for.
     */
    await expect.poll(() => page.isVisible('#boardWithdrawn'), { timeout: 10_000 }).toBe(true);
    const line = await page.locator('#boardWithdrawnText').textContent();
    expect(line).toContain(String(before + 1));

    await page.click('#boardWithdrawnToggle');
    await page.waitForSelector(`.row[data-incident="${id}"][data-withdrawn="true"]`, {
      timeout: 10_000,
    });

    const mark = page.locator(`.row[data-incident="${id}"] .withdrawn`);
    expect(await mark.textContent()).toBe('withdrawn');
    expect(await mark.getAttribute('title')).toBe(reason);

    // Turn the toggle back off so the next test starts from the ordinary view.
    await page.click('#boardWithdrawnToggle');
  });

  it('3. restore asks for no reason and puts it back among the live rows', async () => {
    const id = await seedIncident(`withdrawal e2e restore ${Date.now()}`);

    // Withdrawn via the API directly — this test is about restoring, not about withdrawing a
    // second time.
    await page.evaluate(async (target: string) => {
      await fetch(`/incidents/${target}/withdraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'set up for the restore test' }),
      });
    }, id);

    await openDetail(id);
    await openMore();
    expect(await page.isVisible('#restoreIncident')).toBe(true);
    expect(await page.isVisible('#withdrawIncident')).toBe(false);

    const before = await withdrawnCount();
    // No `answer(...)` armed: if restore ever asked a question, this click would hang the
    // test rather than pass it by accident.
    await page.click('#restoreIncident');

    await expect.poll(() => page.isVisible('.wnote'), { timeout: 10_000 }).toBe(false);
    await openMore();
    await page.waitForSelector('#withdrawIncident', { timeout: 10_000 });
    expect(await page.isVisible('#restoreIncident')).toBe(false);

    // The count over the whole day is unchanged — the events both stay in the log
    // (`withdrawal.test.ts`'s own test 6), and `summary.withdrawn` counts today's withdrawn
    // rows as they stand now, not the ones that were ever withdrawn.
    expect(await withdrawnCount()).toBe(before - 1);

    // Board: back in the default view, no toggle needed.
    await page.evaluate(() => {
      const dnc = (globalThis as unknown as { __dnc: { showBoard(x: boolean): void } }).__dnc;
      dnc.showBoard(true);
    });
    await page.evaluate(async () => {
      const dnc = (globalThis as unknown as { __dnc: { refreshBoard(): Promise<void> } }).__dnc;
      await dnc.refreshBoard();
    });
    await page.waitForSelector(`.row[data-incident="${id}"]`, { timeout: 10_000 });
    expect(await page.getAttribute(`.row[data-incident="${id}"]`, 'data-withdrawn')).toBe('false');
  });
});
