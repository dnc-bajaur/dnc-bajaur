/**
 * The in-product guide, reachable on a real screen.
 *
 * Three things this proves, and none of them is covered by TypeScript compiling cleanly:
 *
 *   1. **It is reachable at all.** `web/src/help.ts` shipped with `search.js` and `report.js`
 *      as precedent for "an endpoint — or a screen — with no door is not a capability".
 *   2. **It is offered whatever this installation has turned on**, deliberately never behind
 *      `offers(...)` — it is documentation about the product, not a part of it, and a fresh
 *      installation with every optional screen off must not also lose the paragraph explaining
 *      what those screens do. This suite calls `disableAllCapabilities` rather than trusting a
 *      freshly migrated database to already be in that state, because `capability_state` is one
 *      row for the whole installation and a file that ran earlier in the same run may have
 *      called `enableAllCapabilities` and left it set.
 *   3. **It keeps working with no connection**, once loaded — the one way it differs from
 *      search and report, which need a connection for every use rather than only the first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  disableAllCapabilities,
} from '../testing/seed.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the "How to use" guide, on a real screen', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  /**
   * ⚠️ **`#helpView:not([hidden])` IS NOT THE GUIDE BEING THERE.**
   *
   * `help.js` is fetched lazily and is deliberately not in `SHELL` — the view is unhidden while
   * the chapters are still on the wire, and `#helpBody` is empty for that gap. Every assertion
   * in this file reads that body straight after unhiding, which on a laptop is fast enough to
   * hide the race and on a loaded CI runner is not: the guide chapters came back as `''` on
   * 2026-09-08, reported as the guide having lost the words *Report emergency*.
   *
   * Waiting on the content rather than the container is the whole fix, and it is also the more
   * honest wait — an empty guide is exactly the failure this file exists to catch, and it cannot
   * catch it while it can also produce it.
   */
  async function waitForGuide(): Promise<void> {
    await page.waitForFunction(
      () => (document.getElementById('helpBody')?.textContent ?? '').length > 0,
      undefined,
      { timeout: 20_000 },
    );
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Not left to a freshly migrated database's assumed default: `capability_state` is one row
    // for the whole installation, db tests share one cluster, and a file that ran earlier in
    // this same run may have called `enableAllCapabilities` and left it set. This suite's whole
    // point is proving the guide survives every capability being off, so it makes that true
    // itself rather than trusting the order other files happened to run in.
    await disableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Help Test Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('is offered with every capability off, unlike the screens beside it', async () => {
    /**
     * Search is capability-gated — confirms the precondition this suite set actually holds.
     * The guide sits beside it in the nav and must not be gated the same way; if that ever
     * regresses to `!offers('...')`, this is what catches it.
     *
     * ⚠️ **The subject moved with Phase 4b and the property did not.** Search stopped being a
     * tab and became the find controls on the Record, so the capability now hides `#boardFind`.
     * Folding one screen into another must never quietly switch it on for an installation that
     * turned it off, which is exactly what this line is here to refuse.
     */
    expect(await page.isHidden('#boardFind')).toBe(true);
    expect(await page.isHidden('#navHelp')).toBe(false);
  });

  it('opens from the navigation and covers every screen it documents', async () => {
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])');
    await waitForGuide();

    // Normalised, not raw: `textContent` keeps the template literal's own line breaks and
    // indentation as literal whitespace, and a phrase this test cares about is free to wrap
    // across a line in the source without that becoming a false failure here.
    const text = ((await page.locator('#helpBody').textContent()) ?? '').replace(/\s+/g, ' ');

    // One mention per chapter that mirrors an actual nav item — a guide that drifts from the
    // screens it describes is worse than none (CLAUDE.md §5, "a document that outlives the
    // decision it was written under").
    for (const mustMention of [
      'Report emergency',
      'Who should know',
      'Who was told',
      // The board's own word for it since 2026-08-18 — the guide teaches what is on the
      // screen, and a guide still saying `nobody told` would be teaching a figure that is
      // no longer there under a name that was never quite what it counted.
      'no one chosen',
      'Administration',
      'Screens offered',
      'Who was told, and who answered',
      'WhatsApp',
      'Acknowledged',
      'Glossary',
      // M9's six. A guide written before the milestone teaches an officer a screen that has
      // moved — which is the failure v21 of the service worker is a monument to.
      'Meetings, schedules and notices',
      'Attaching a file',
      'Telling a whole department at once',
      'Correcting something sent in error',
      'The daily report',
      'Are you available?',
    ]) {
      expect(text).toContain(mustMention);
    }
  });

  it('never lets an operator believe a correction unsent the message', async () => {
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])');
    await waitForGuide();
    const text = ((await page.locator('#helpBody').textContent()) ?? '').replace(/\s+/g, ' ');

    /**
     * **The one sentence in this guide that is load-bearing.**
     *
     * The district asked for undo/delete. Nothing can unsend a delivered WhatsApp message, and
     * an operator who believes otherwise leaves forty officers holding a notice with the wrong
     * date and never rings them. The app says it twice on screen; the guide says it a third
     * time, and this is what stops somebody tidying it away as repetition.
     */
    expect(text).toContain('It does not unsend the message, and nothing can');
    expect(text).toContain('tell them again or ring them');
    // And it must never describe the button as a deletion, anywhere. Plain string checks
    // rather than a regex: this line carried two literal backspace characters for a while,
    // because a backslash-b means one thing inside a regex and a control character in
    // nearly every language's string escapes. ESLint's no-control-regex caught it; a
    // reader would not have.
    expect(text.toLowerCase()).not.toContain('delete the message');
    expect(text.toLowerCase()).not.toContain('message is deleted');
  });

  it('says an attachment travels as a link, because today it does', async () => {
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])');
    await waitForGuide();
    const text = ((await page.locator('#helpBody').textContent()) ?? '').replace(/\s+/g, ' ');

    // Meta will only put a document on a template approved to carry one, and Bajaur's was not.
    // A guide that promised a file attachment would be teaching a feature that is switched off.
    expect(text).toContain('travels as a link, not as a file');
  });

  it('never claims a message is sent automatically before it is', async () => {
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])');
    await waitForGuide();
    const text = ((await page.locator('#helpBody').textContent()) ?? '').replace(/\s+/g, ' ');

    // The one factual claim in this document that would be actively wrong on this
    // installation today: WhatsApp is not configured, so "Tell them" opens a number by hand.
    expect(text).toContain('the software itself sends nothing');
  });

  it('keeps working with no connection, once it has loaded', async () => {
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])');
    await waitForGuide();
    const before = (await page.locator('#helpBody').textContent()) ?? '';

    await page.click('#navBoard');
    await context.setOffline(true);
    try {
      await page.click('#navHelp');
      await page.waitForSelector('#helpView:not([hidden])');
      await waitForGuide();
      const after = (await page.locator('#helpBody').textContent()) ?? '';
      expect(after).toBe(before);
    } finally {
      await context.setOffline(false);
    }
  });
});
