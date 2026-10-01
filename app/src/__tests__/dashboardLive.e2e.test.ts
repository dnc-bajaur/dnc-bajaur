/**
 * The dashboard is reconciled, not rebuilt — liveness phase 2, 2026-08-14.
 *
 * ## Why this test exists, and why it asserts on node IDENTITY
 *
 * Every `render*` in `dashboard.ts` used to begin with `clear(node)`. The screen was always
 * correct and it always looked dead: highlighting what changed was not merely unimplemented, it
 * was **impossible**, because the node that would have been highlighted had already been
 * destroyed and replaced by an identical one.
 *
 * That is a property no assertion about *content* can see. A wiped-and-rebuilt panel and a
 * reconciled one render byte-for-byte the same HTML — so a test that reads text or counts rows
 * passes over the entire defect, which is precisely how this survived from M4 to M9.
 *
 * **So the assertion is that the element SURVIVES a refresh.** A marker is written onto a live
 * DOM node, the dashboard is made to repaint with unchanged data, and the marker has to still be
 * there. Only reconciliation can do that; `clear()` cannot, whatever it draws afterwards.
 *
 * ## And the second half: silence
 *
 * A refresh where nothing changed must flash **nothing**. This is the half a future change is
 * most likely to break — widening the flash to "anything we replaced" is a one-line edit that
 * makes the whole screen pulse every twenty seconds, and a screen that always flashes is one
 * nobody reads, which is the alert fatigue this product removed the green `online` wash over.
 *
 * The ticking age (`startAges`, phase 1) is the specific thing that would cause it: it rewrites
 * text every second and re-anchors `data-since` on every poll, so a naive comparison reports
 * every panel as changed forever. `signatureOf` strips both, and test 2 is what holds it there.
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

describe.skipIf(dbUrl === undefined)('the dashboard is reconciled, not rebuilt', () => {
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

    actor = await seedActor(pool, { title: 'Liveness Operator', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * Sign in only if this context is not already signed in.
   *
   * The session survives between tests in one browser context, so a second `#login` wait would
   * sit on a form that is correctly hidden until it times out — which is a test failing on its
   * own setup rather than on the product.
   */
  async function openDashboard(): Promise<void> {
    await page.goto(origin);
    // Whichever of the two the boot settles on. Asking `isVisible` straight after `goto` races
    // the boot and answers "not signed in" for a session that is — which then waits out the full
    // timeout on a sign-in form that is correctly hidden.
    await page.waitForSelector('#who:not([hidden]), #login:not([hidden])', { timeout: 20_000 });
    const signedIn = await page.isVisible('#who');
    if (!signedIn) {
      await page.waitForSelector('#login', { state: 'visible', timeout: 20_000 });
      await page.fill('#phone', actor.phone);
      await page.fill('#password', TEST_PASSWORD);
      await page.click('#loginSubmit');
      await page.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
    }
    await page.click('#navDashboard');
    await page.waitForSelector('#dashKeys .key', { timeout: 20_000 });
  }

  /**
   * Force a genuine repaint with unchanged data.
   *
   * Leaving the dashboard calls `stop()` and returning calls `show()`, which runs a real fetch
   * and a real `paint()` — the same path the twenty-second poll takes. Driving it this way rather
   * than waiting out the timer keeps the test deterministic without lowering the interval, which
   * would be testing a configuration this product never ships.
   */
  async function repaint(): Promise<void> {
    await page.click('#navBoard');
    await page.waitForSelector('#dashboardView', { state: 'hidden', timeout: 20_000 });

    /**
     * ⚠️ **Wait for the ANSWER, not for the tiles — and the difference is a real flake CI found.**
     *
     * This used to end at `waitForSelector('#dashKeys .key')`, which **returns immediately**:
     * those tiles are still in the document from the previous paint, because reconciliation is
     * the whole point of this file. So `repaint()` resolved while the `/dashboard` fetch was
     * still in flight, and whatever followed read the screen as it was **before** the refresh.
     *
     * It passed almost always — the fetch is against a local server — and failed roughly one run
     * in six, on test 10, with the old note still on the wall. On CI it failed on the first push
     * that ran the whole suite. It is the same shape as the search screen's date inputs, which
     * this repository fixed the same week: **waiting for something that is already true.**
     *
     * Waiting on the response is the honest signal. The click is inside the `Promise.all` so the
     * listener is attached before the request can be made.
     */
    await Promise.all([
      page.waitForResponse((res) => res.url().endsWith('/dashboard') && res.status() === 200, {
        timeout: 20_000,
      }),
      page.click('#navDashboard'),
    ]);
    await page.waitForSelector('#dashKeys .key', { timeout: 20_000 });
  }

  it('1. a district counter survives a refresh as the SAME element', async () => {
    await openDashboard();

    // Written onto the live node. It is not an attribute, deliberately — an attribute would be
    // reproduced by a rebuild that happened to render the same markup, and would prove nothing.
    // An expando exists only on this object, so it can only survive if the object does.
    await page.evaluate(() => {
      const tile = document.querySelector('#dashKeys .key');
      if (tile !== null) (tile as HTMLElement & { __kept?: number }).__kept = 1;
    });

    await repaint();

    const kept = await page.evaluate(() => {
      const tile = document.querySelector('#dashKeys .key');
      return tile === null ? null : ((tile as HTMLElement & { __kept?: number }).__kept ?? null);
    });

    // `clear(node)` would have thrown this element away and built an identical one. The marker is
    // the only difference between those two outcomes that is visible from here — and it is the
    // difference between a screen that can highlight a change and one that cannot.
    expect(kept).toBe(1);
  }, 120_000);

  it('2. a refresh that changed nothing flashes nothing', async () => {
    await openDashboard();
    await repaint();

    /**
     * Counted across the whole screen, not one panel.
     *
     * The failure this guards against is not subtle in production and is very easy to introduce:
     * compare rendered markup instead of `signatureOf`, and the ticking age alone makes every row
     * differ on every poll — the entire dashboard pulses every twenty seconds, forever, and the
     * flash stops meaning anything at all.
     */
    const flashing = await page.evaluate(
      () => document.querySelectorAll('#dashboardView .flash').length,
    );

    expect(flashing).toBe(0);
  }, 120_000);

  /**
   * Phase 3, and the assertion that matters is the LAST one.
   *
   * A counter that animates is pleasant; a counter that animates and then settles on the wrong
   * number is a defect on the screen a district believes. So this drives a real change through
   * the real API and then compares what the tile says against what the server says — not against
   * a number the test worked out for itself, which would only prove the test can do arithmetic.
   *
   * It also pins the shape the animation leaves behind. `slideNumber` builds a two-line track and
   * is expected to tear it down on `animationend`; a counter left as markup would still *read*
   * correctly while making every later signature comparison differ from a freshly built node —
   * which would quietly turn every poll into a full replacement and undo phase 2.
   */
  it('3. a counter that changed slides, and settles on the server’s own number', async () => {
    await openDashboard();

    // Armed before the change. `rollNumbers` adds `.rolling` to a node that is still DETACHED —
    // it prepares the incoming element and only then swaps it in — so an attribute observer would
    // never see it. The childList mutation of the swap is the moment it becomes observable.
    await page.evaluate(() => {
      (window as unknown as { __sawRoll?: boolean }).__sawRoll = false;
      const keys = document.getElementById('dashKeys');
      if (keys === null) return;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const added of Array.from(record.addedNodes)) {
            if (added instanceof HTMLElement && added.querySelector('.rolling') !== null) {
              (window as unknown as { __sawRoll?: boolean }).__sawRoll = true;
            }
          }
        }
      }).observe(keys, { childList: true, subtree: true });
    });

    // A real emergency through the real route, so the counter moves the way it does in Bajaur.
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'fire', severity: 'moderate', description: 'phase 3' }),
      });
    });

    await repaint();

    await page.waitForFunction(
      () => (window as unknown as { __sawRoll?: boolean }).__sawRoll === true,
      undefined,
      { timeout: 20_000 },
    );

    // The track is temporary by design. If this never clears, the teardown is broken.
    await page.waitForFunction(
      () => document.querySelector('#dashKeys .rolltrack') === null,
      undefined,
      {
        timeout: 10_000,
      },
    );

    const { shown, expected } = await page.evaluate(async () => {
      const response = await fetch('/dashboard', { headers: { accept: 'application/json' } });
      const feed = (await response.json()) as { district: { today: number } };
      const tile = Array.from(document.querySelectorAll('#dashKeys .key')).find(
        (t) => t.querySelector('.k')?.textContent === 'Reported today',
      );
      return {
        shown: tile?.querySelector('.n')?.textContent ?? null,
        expected: String(feed.district.today),
      };
    });

    expect(shown).toBe(expected);
  }, 120_000);

  /**
   * Phase 4 — the doorbell, and the timing IS the assertion.
   *
   * `GET /board/live` has existed since M8 and only the board listened, so an emergency reported
   * now reached the wall up to twenty seconds later. There is no way to test "it arrived by push"
   * other than to show it arrived **sooner than the poll could have delivered it** — so this
   * reports an emergency and requires the screen to move well inside the poll interval, without
   * navigating away or touching anything.
   *
   * The window is deliberately far below the 20s poll and far above the 3s debounce. A regression
   * that silently drops the stream does not make this flaky, it makes it fail — which is the
   * point, because losing the stream is otherwise invisible: the screen still updates, just
   * twenty seconds late, exactly as it did before this phase existed.
   */
  it('4. an emergency reaches the dashboard without waiting for the poll', async () => {
    await openDashboard();

    const before = await page.evaluate(() => {
      const tile = Array.from(document.querySelectorAll('#dashKeys .key')).find(
        (t) => t.querySelector('.k')?.textContent === 'Reported today',
      );
      return tile?.querySelector('.n')?.textContent ?? '';
    });

    const started = Date.now();

    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'fire', severity: 'moderate', description: 'phase 4' }),
      });
    });

    await page.waitForFunction(
      (prev) => {
        const tile = Array.from(document.querySelectorAll('#dashKeys .key')).find(
          (t) => t.querySelector('.k')?.textContent === 'Reported today',
        );
        return (tile?.querySelector('.n')?.textContent ?? '') !== prev;
      },
      before,
      { timeout: 15_000 },
    );

    // Stated as its own assertion so a failure reads as "the push did not happen" rather than as
    // a timeout somewhere in Playwright.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 120_000);

  /**
   * And the half that keeps the doorbell from being a denial of service on the district's own
   * server.
   *
   * Building this feed runs about ten queries at once. A dispatch to eight officers announces
   * repeatedly, and one rebuild per announcement would aim a burst of eighty queries at the one
   * machine that is also taking emergency reports — the failure mode where the monitoring makes
   * the outage worse, which `inFlight` in `dashboard.ts` was already written for once.
   *
   * So the count of `/dashboard` requests is what is asserted, not the wall clock. Three
   * emergencies in quick succession must not produce three rebuilds.
   */
  it('5. a burst of changes costs one rebuild, not one per change', async () => {
    await openDashboard();

    // Counted in the page, by wrapping fetch. Reading the server's log would count this test's own
    // /incidents calls too, and could not tell the two apart.
    await page.evaluate(() => {
      const w = window as unknown as { __dashCalls?: number; __wrapped?: boolean };
      w.__dashCalls = 0;
      if (w.__wrapped === true) return;
      w.__wrapped = true;
      const real = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/dashboard')) w.__dashCalls = (w.__dashCalls ?? 0) + 1;
        return real(input, init);
      };
    });

    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'fire', severity: 'moderate', description: 'burst' }),
        });
      }
    });

    // Long enough for the debounce to fire and settle, short enough that the 20s poll cannot have
    // contributed a second rebuild of its own.
    await page.waitForTimeout(8_000);

    const calls = await page.evaluate(
      () => (window as unknown as { __dashCalls?: number }).__dashCalls ?? 0,
    );

    // One is the expected answer. Two is tolerated so the test does not fail on a boundary it does
    // not own; three would mean the coalescing is gone.
    expect(calls).toBeLessThanOrEqual(2);
    expect(calls).toBeGreaterThan(0);
  }, 120_000);

  /**
   * Phase 5, and **both halves are asserted in one test because the guard is the hard part.**
   *
   * A feed that animates new rows is easy. A feed that animates new rows *and stays still on the
   * first paint* is the whole difficulty: on first paint every row is new, so an unguarded
   * version slides a week of open work in on arrival and tells a room that all of it just
   * happened. That failure looks completely correct in a screenshot, which is why it needs a
   * test rather than an eye.
   *
   * **Observed rather than sampled.** `act-entering` is added before the row is inserted and
   * removed again on `animationend` roughly half a second later, so polling for it races the
   * animation. A `MutationObserver` watching `childList` records every arrival whatever the
   * timing — and it is installed *before the dashboard has ever painted*, which is the only way
   * to see the first paint at all.
   */
  it('6. a new row arrives from above — and the first paint animates nothing', async () => {
    await openDashboard();

    /**
     * ▶ **Watched on *Still running* rather than on *Today*, because that is the panel the
     * district actually has — 2026-08-22.**
     *
     * `activity` came off `DEFAULT_LAYOUT` when the five landed (`domain/panels.ts`), so
     * `applyLayout` hides its section and its rows are no longer **visible** — which is what
     * this test failed on, correctly, the first time it was run after that swap. It is still in
     * the registry and still choosable; what changed is which panel a district sees by default.
     *
     * ⚠️ **The guard under test is `reconcile`'s, and both panels share it**, so moving the
     * assertion here keeps it covered on the wall somebody reads. What is no longer covered by a
     * browser is `renderActivity`'s own call into that same mechanism — stated rather than
     * rounded up, and the day `activity` returns to a default this is the test to point back.
     */
    const flood = async (description: string): Promise<void> => {
      await page.evaluate(async (what: string) => {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // A flood carries past the district's midnight by default (`domain/carrying.ts`), so
          // this lands on the panel under test. A fire deliberately would not.
          body: JSON.stringify({ category: 'flood', severity: 'serious', description: what }),
        });
      }, description);
    };

    // The panel has to hold something before the first paint can be asserted to be silent — an
    // empty panel draws its own empty box and primes nothing, which would pass for the wrong
    // reason.
    await flood('phase 3 seed');

    // A genuine first paint. `data-primed` lives on the DOM node, so a reload is what clears it —
    // and the observer has to be watching before the panel is ever filled.
    await page.reload();
    await page.waitForSelector('#navDashboard', { state: 'visible', timeout: 20_000 });

    await page.evaluate(() => {
      const w = window as unknown as { __entered?: number };
      w.__entered = 0;
      const panel = document.getElementById('dashStill');
      if (panel === null) return;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof HTMLElement && node.classList.contains('act-entering')) {
              w.__entered = (w.__entered ?? 0) + 1;
            }
          }
        }
      }).observe(panel, { childList: true, subtree: true });
    });

    await page.click('#navDashboard');
    await page.waitForSelector('#dashStill .srow', { timeout: 20_000 });

    const onFirstPaint = await page.evaluate(
      () => (window as unknown as { __entered?: number }).__entered ?? 0,
    );

    // The whole point. Every one of these rows is new to the DOM; none of them is news.
    expect(onFirstPaint).toBe(0);

    await flood('phase 3 arrival');

    await page.waitForFunction(
      () => ((window as unknown as { __entered?: number }).__entered ?? 0) > 0,
      undefined,
      { timeout: 20_000 },
    );

    expect(
      await page.evaluate(() => (window as unknown as { __entered?: number }).__entered ?? 0),
    ).toBeGreaterThan(0);
  }, 120_000);

  /**
   * The ticker rotates, and **rotation must not lose anything.**
   *
   * This is the assertion the chosen design most needs. Splitting the facts across frames means
   * only about a third are on screen at any instant — an accepted cost — but a frame that never
   * comes round, or a fact that lands in no frame at all, turns that cost into a silent loss on
   * the widest element of the dashboard.
   *
   * So a full cycle is sampled and the union is checked, rather than any single frame.
   */
  it('7. the ticker rotates, and a full cycle still says everything', async () => {
    await openDashboard();
    await page.waitForSelector('#tickerText', { timeout: 20_000 });

    // A frame holds for 8s and there are up to three, so 26s covers a whole cycle with room.
    const seen = new Set<string>();
    for (let i = 0; i < 26; i++) {
      const text = await page.evaluate(
        () => document.getElementById('tickerText')?.textContent ?? '',
      );
      if (text.trim() !== '') seen.add(text.trim());
      await page.waitForTimeout(1_000);
    }

    const union = [...seen].join(' · ');

    // It moved at all. One frame for 26 seconds is the static bar this phase replaced.
    expect(seen.size).toBeGreaterThan(1);

    // And the district's own counts are still reachable somewhere in the cycle — a fact dealt
    // into no frame would be a fact the wall screen stopped carrying.
    expect(union).toContain('reported today');
    expect(union).toContain('open');
  }, 120_000);

  /**
   * Phase 6 — and what is asserted is that the rail is a **measure**, not a decoration.
   *
   * A hairline that merely exists proves nothing: the risk with a graphic like this is that it
   * looks alive while meaning nothing, which is worse than no rail at all on a screen a district
   * believes. So three ages are driven through it and the width is read back at each — full when
   * fresh, exactly half at half the panel's tolerance, and spent past it.
   *
   * **Driven through the product's own one-second sweep**, not by calling anything directly. If
   * `startAges` ever stops carrying the rails, this fails — which is the regression worth having
   * a test for, because a rail frozen at its last width looks completely normal.
   *
   * 90 minutes is the weather panel's own `data-full`, and it is the same number the age text
   * beside it turns amber at. The two are not allowed to disagree.
   */
  it("8. the freshness hairline drains with the age, and empties at the panel's threshold", async () => {
    await openDashboard();
    await page.waitForSelector('#dashWeatherFresh', { state: 'attached', timeout: 20_000 });

    const railAt = async (minutesAgo: number): Promise<string> => {
      await page.evaluate((m) => {
        const rail = document.getElementById('dashWeatherFresh');
        if (rail !== null) rail.dataset['at'] = String(Date.now() - m * 60_000);
      }, minutesAgo);
      // Long enough for the product's own 1s timer to come round. Nothing here calls the paint.
      await page.waitForTimeout(1_400);
      return page.evaluate(() => {
        const rail = document.getElementById('dashWeatherFresh');
        return `${rail?.style.width ?? ''}|${rail?.dataset['spent'] ?? ''}`;
      });
    };

    // The browser normalises the `100.0%` the code writes down to `100%` on the way back out.
    expect(await railAt(0)).toBe('100%|');
    expect(await railAt(45)).toBe('50%|');

    // Past 90 minutes the rail stops being a measure and says so: a flat line in the quiet
    // border colour, with the heading beside it already amber.
    expect(await railAt(200)).toBe('|true');
  }, 120_000);

  /**
   * Phase 7, and the second assertion is the one worth having.
   *
   * **It measures the tile.** Phase 6 turned up the fact that nothing in this repository renders
   * the dashboard to check it does not grow — `panels.test.ts` is a domain test and never draws
   * anything, despite comments all over the source claiming otherwise. So the sparkline, which is
   * the first thing added *inside* a tile since that was discovered, brings the missing check with
   * it: draw the tile, measure it, remove the sparklines, measure again, and require the same
   * number.
   *
   * Eighteen pixels per tile would be invisible in review and would push every panel below the
   * keys row down, on a screen whose entire layout budget is "nine panels fit 1920x1080".
   */
  it('9. every tile carries its own shape, and no tile grew to hold it', async () => {
    await openDashboard();
    /**
     * At 1920×1080, the size this assertion's own notes are measured at. The default Playwright
     * context is 1280×720, which since 2026-09-01 is inside the HDMI-laptop tier — eight tiles
     * across a two-column-wide panel, where the stretched sparkline runs narrower than 0.7 of
     * the tile it sits on and this test's last assertion fails on a layout it was never about.
     */
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForSelector('#dashKeys .key .spark', { timeout: 20_000 });
    await page.waitForTimeout(200);

    const drawn = await page.evaluate(() => ({
      sparks: document.querySelectorAll('#dashKeys .key .spark').length,
      tiles: document.querySelectorAll('#dashKeys .key').length,
      // Eight points over twenty-four hours, as the server sends them.
      points: (
        document.querySelector('#dashKeys .key .spark polyline')?.getAttribute('points') ?? ''
      )
        .trim()
        .split(/\s+/).length,
      // The number is the fact and is already read out; the line only shows its shape.
      hidden: document.querySelector('#dashKeys .key .spark')?.getAttribute('aria-hidden'),
    }));

    /**
     * **The count has moved twice, and both moves were the owner's.**
     *
     * It was five until 2026-08-17, then eight — four stages and four figures beside them, with
     * the stage tiles carrying no line, because `district.trend` replays four series and none of
     * them is a stage.
     *
     * ⚠️ **It is five again, and this assertion is the last thing still saying eight.** When
     * *Acknowledged* went as a word, the deck dropped to *"exactly the owner's five"* —
     * **Reported today, Responded, Resolved today, No one chosen, Message failed**. `Issued` and
     * `Acknowledged` came off as tiles (the stages themselves are untouched and still filter the
     * board), and `Not yet assessed` came off with them, settling the open ADR-0009 question in
     * the owner's favour. The conditional `Nobody took it` tile is a different concept and is not
     * counted here. The deliberate change is recorded in `CHANGELOG.md`; only this number was
     * left behind, because the suite has not run since 2026-08-28.
     *
     * The property is unchanged and is the one worth keeping: **every tile has a shape**. A tile
     * with a line is taller than a tile without, so a deck where only some had one went ragged at
     * 1920×1080 — which is what the next assertion measures.
     */
    expect(drawn.tiles).toBe(5);
    expect(drawn.sparks).toBe(drawn.tiles);
    expect(drawn.points).toBe(8);
    expect(drawn.hidden).toBe('true');

    /**
     * ⚠️ **This assertion was reversed on 2026-08-15, by decision, and the old one is worth
     * keeping in view.**
     *
     * It read: *"Absolutely positioned, so taking it away can change nothing. In flow this fails
     * by ~18px a tile — which is exactly the regression that would otherwise reach the wall
     * unnoticed."* That was true and the number was nearly right — **measured, it is 23px**.
     *
     * The owner took the cost knowingly. Tucked into a corner at 40px wide the line was a smudge
     * at the four metres ADR-0015 says this screen is read from, so it was spending its pixels on
     * somebody sitting at a desk. Full width it is a shape a room can read.
     *
     * **The page does not pay 23px, it pays 7** — measured at 1920×1080: the keys panel shares
     * its row with a taller neighbour, so most of the growth lands in space that already existed.
     *
     * What is asserted now is what still has to be true: every tile is the **same** height as
     * every other, so the row cannot go ragged, and the line is genuinely full width rather than
     * a stretched 40px stub. A tile growing alone is the regression that would reach the wall.
     */
    const shape = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('#dashKeys .key'));
      const spark = document.querySelector('#dashKeys .key .spark');
      const face = document.querySelector('#dashKeys .key .face');
      return {
        heights: tiles.map((t) => Math.round(t.getBoundingClientRect().height)),
        sparkWidth: spark === null ? 0 : Math.round(spark.getBoundingClientRect().width),
        faceWidth: face === null ? 0 : Math.round(face.getBoundingClientRect().width),
        ratio: spark?.getAttribute('preserveAspectRatio') ?? '',
      };
    });

    expect(new Set(shape.heights).size).toBe(1);
    // Stretched to the card rather than kept at its own 40px viewBox. The padding is the only
    // thing between the two, so this is a lower bound rather than an equality.
    expect(shape.ratio).toBe('none');
    expect(shape.sparkWidth).toBeGreaterThan(shape.faceWidth * 0.7);

    // Back to the context's default width for the tests that follow and do not set their own.
    await page.setViewportSize({ width: 1280, height: 720 });
  }, 120_000);

  /**
   * M10-02 — the district's own sentence, on its own line, and reaching the screen when it CHANGES.
   *
   * **The second half is the one that needs a browser.** `signatureOf` strips `[data-since]`
   * elements' text, and until this change the note rode inside one as a prefix on the age — it
   * survived comparison only because `data-pre` happened not to be stripped as well. Move it into
   * that element's text at any point in the future and the row silently stops repainting: the
   * screen keeps showing *"4 hrs on 2 off"* long after somebody typed *"restored"*, and every
   * assertion about the API still passes.
   *
   * So this changes **only the note** — same service, same status — and requires the new words to
   * arrive. Nothing about it can be proved from the server side, which is why it lives here.
   */
  it('10. a note that changed reaches the wall, on its own line', async () => {
    const name = `Electricity (note ${Date.now().toString(36)})`;
    const created = await pool.query<{ utility_id: string }>(
      `INSERT INTO utility (name, panel, position, stale_minutes)
       VALUES ($1, 'utility', 96, 600) RETURNING utility_id`,
      [name],
    );
    const utilityId = created.rows[0]!.utility_id;

    await pool.query(
      `INSERT INTO utility_report (utility_id, status, note) VALUES ($1, 'degraded', $2)`,
      [utilityId, '8 hours loadshedding, 10am to 6pm'],
    );

    await openDashboard();
    await repaint();

    /** The row's own note element — never the age line it used to hide inside. */
    const noteOf = async (): Promise<string | null> =>
      page.evaluate((utility: string) => {
        const row = Array.from(document.querySelectorAll('#dashUtilities .pitem')).find(
          (item) => item.querySelector('.pn')?.textContent === utility,
        );
        return row?.querySelector('.pnote')?.textContent ?? null;
      }, name);

    expect(await noteOf()).toBe('8 hours loadshedding, 10am to 6pm');

    // Only the sentence changes. Same status, same service — so a comparison that cannot see the
    // note sees a row with nothing new about it and leaves the old words on the wall.
    await pool.query(
      `INSERT INTO utility_report (utility_id, status, note) VALUES ($1, 'degraded', $2)`,
      [utilityId, 'restored, schedule suspended'],
    );

    await repaint();

    /**
     * Waited for rather than read once. `repaint()` now waits for the `/dashboard` response, but
     * the paint that follows it is a separate turn of the event loop — and this is the one
     * assertion in the file about a value arriving, so waiting for it is the assertion rather
     * than a way of avoiding one. If the note never reaches the wall this times out and fails,
     * which is exactly the defect it exists to catch.
     */
    await page.waitForFunction(
      (utility: string) => {
        const row = Array.from(document.querySelectorAll('#dashUtilities .pitem')).find(
          (item) => item.querySelector('.pn')?.textContent === utility,
        );
        return row?.querySelector('.pnote')?.textContent === 'restored, schedule suspended';
      },
      name,
      { timeout: 20_000 },
    );

    expect(await noteOf()).toBe('restored, schedule suspended');
  }, 120_000);

  /**
   * Card depth — a counter answers the pointer, and settles again when it leaves.
   *
   * Only the values are asserted, never how they look. Everything visible about the card is a
   * consequence of these properties, and a test that read a rendered shadow would be measuring
   * the browser's compositor rather than the product's own behaviour.
   *
   * The rest state is the half worth having. `tilt.ts` writes nothing at all until a pointer
   * moves, so a wall screen — which never has one — gets the `var()` fallbacks in the stylesheet.
   * What this pins is the return: after the pointer leaves, the card is measurably back at zero
   * rather than left leaning at whatever angle it last saw.
   */
  it('11. a counter tilts towards the pointer, and settles when it leaves', async () => {
    await openDashboard();

    const tile = page.locator('#dashKeys .key').first();
    await tile.hover();
    await page.waitForTimeout(200);

    const moved = await page.evaluate(() => {
      const t = document.querySelector('#dashKeys .key') as HTMLElement | null;
      return {
        rx: t?.style.getPropertyValue('--tilt-rx') ?? '',
        ry: t?.style.getPropertyValue('--tilt-ry') ?? '',
        live: t?.classList.contains('live') ?? false,
      };
    });

    expect(moved.live).toBe(true);
    // Written at all, and not both zero — a pointer at the exact centre would be, and `hover()`
    // aims there, so the assertion is that the pair exists and the deck is live rather than that
    // either number is large.
    expect(moved.rx).not.toBe('');
    expect(moved.ry).not.toBe('');

    // Off the deck entirely, not onto a neighbour — a neighbour keeps the row leaning towards it.
    await page.mouse.move(10, 700);
    await page.waitForTimeout(300);

    const settled = await page.evaluate(() => {
      const t = document.querySelector('#dashKeys .key') as HTMLElement | null;
      return {
        rx: Number.parseFloat(t?.style.getPropertyValue('--tilt-rx') ?? '1'),
        ry: Number.parseFloat(t?.style.getPropertyValue('--tilt-ry') ?? '1'),
        live: t?.classList.contains('live') ?? true,
      };
    });

    expect(settled.live).toBe(false);
    expect(settled.rx).toBe(0);
    expect(settled.ry).toBe(0);
  }, 120_000);

  /**
   * ⚠️ **The guard for the trap this whole change was built around.**
   *
   * `tilt.ts` writes `--tilt-*` properties into a card's inline `style`. `style` is part of
   * `outerHTML`, and `outerHTML` is what `signatureOf` compares — so without `stripTiltStyles` a
   * card somebody is hovering differs from the same card built fresh on **every poll**. Both of
   * `reconcile`'s comparison branches would fire, and the node the pointer is on would be
   * replaced twenty seconds into somebody reading it: the card snaps back to rest under their
   * cursor, the counter re-rolls, and the tile flashes as though something had happened.
   *
   * **Nothing about that is visible in a screenshot and no server-side assertion can see it.**
   * The rendered markup is identical either way; only the node's identity differs. So this is
   * test 1 with one thing added — the pointer is resting on the card while the repaint happens —
   * and it asserts the same expando survives.
   *
   * Verified failing against a tree with the `stripTiltStyles` call removed from `signatureOf`.
   */
  it('12. a counter the pointer is resting on survives a repaint as the SAME node', async () => {
    await openDashboard();

    const tile = page.locator('#dashKeys .key').first();
    await tile.hover();
    await page.waitForTimeout(200);

    // The properties are actually on the node — otherwise this test would pass by proving
    // nothing, which is the failure mode `dashboard.test.ts`'s trend assertions had.
    const dirty = await page.evaluate(() => {
      const t = document.querySelector('#dashKeys .key') as HTMLElement | null;
      return (t?.getAttribute('style') ?? '').includes('--tilt-');
    });
    expect(dirty).toBe(true);

    await page.evaluate(() => {
      const t = document.querySelector('#dashKeys .key');
      if (t !== null) (t as HTMLElement & { __hovered?: number }).__hovered = 1;
    });

    await repaint();

    const kept = await page.evaluate(() => {
      const t = document.querySelector('#dashKeys .key');
      return t === null ? null : ((t as HTMLElement & { __hovered?: number }).__hovered ?? null);
    });

    expect(kept).toBe(1);
  }, 120_000);

  /**
   * The card's ground stays measurable.
   *
   * `scripts/contrast.mjs` walks up for the nearest **opaque** ancestor and reports a gradient as
   * *unmeasured* rather than guessing a stop. The face paints a sheen over its ground, so if that
   * sheen were the whole background the district's five counters would drop out of the contrast
   * pass — and `contrast.e2e.test.ts` would keep passing while covering five fewer surfaces.
   *
   * This asserts the property that keeps them in it: the face resolves to a real, opaque colour,
   * and it is the tile's own `--card2` rather than the panel's white showing through.
   */
  /**
   * The shipped default is measured on a real wall — M11-32/33.
   *
   * ## This test used to assert the opposite, and that is the point of it
   *
   * Until 2026-08-18 it ended `expect(wall.lastBottom).toBeGreaterThan(1080)`: the default
   * **overflowed**, and the overflow was recorded rather than hidden. Meanwhile the abstract
   * weight model in `domain/panels.ts` said the same layout fitted — 8.75 of its 9 slots — and
   * `panels.test.ts` agreed with it, because a model that renders nothing cannot see reflow.
   *
   * Reading the boxes off the real page showed why. The page was **1385 tall on a 1080 screen**,
   * in four rows, and the fourth was `condition` alone at `top: 1068`. **Twelve pixels of a
   * 252-pixel panel were above the fold.** Nobody in the control room has ever seen it.
   *
   * Three changes, each measured rather than argued:
   *
   *   1. `condition` came off the **default** — not the registry, ADR-0015 keeps it choosable.
   *      It is `audience: 'administration'`, so it was never the district's shared reading, and
   *      the console's overview and Backups tab answer it better than three words read from four
   *      metres. 1385 → 1115.
   *   2. `main`'s 32px bottom padding is dropped on this screen. Every other screen needs it;
   *      the dashboard does not, because the ticker is `position: sticky` and already holds the
   *      last band. 1115 → 1083.
   *   3. `#dashScope`'s top margin goes one step down the existing scale, 1.4rem → 0.9rem.
   *      1083 → **1080 exactly.**
   *
   * ## ⚠️ And what is deliberately NOT asserted, because it is not mine to fix
   *
   * The wall fits at rest and **still exceeds one screen when the district is busy**: with the
   * activity panel at its cap the page measures ~1159. The lever is `VISIBLE_ACTIVITY`, and that
   * file says plainly *"twenty is the client's number, taken as given"*. Cutting it to sixteen
   * would make this fit in every state — the panel's own *"and N more in the last 24 hours"*
   * line keeps that honest (ADR-0005) — but it is the district's number and the decision is
   * theirs. It is written up in `backlog/for-the-owner.md`.
   *
   * So this asserts the two things that are true in **every** state and that the defect above
   * violated: eight panels with `condition` gone, and **no panel starting below the fold**. A
   * panel nobody can see is the failure this test exists to catch; a page that scrolls by the
   * height of one list on a busy morning is a trade somebody chose.
   */
  it('14. the shipped default is measured on a real wall, and nothing sits below the fold', async () => {
    await openDashboard();

    /**
     * ⚠️ **One important and one routine emergency are opened first, on purpose — 2026-09-08.**
     *
     * Since that date `importantEmergencies` and `routineEmergencies` leave the wall when nothing
     * of their kind is open (the owner's ask — an empty emergency card reads as clutter, not as
     * calm). So an unseeded run would measure a **five**-panel wall — a state a district sees only
     * before its first emergency ever — and the fold guard at the end of this test, which exists
     * for a panel that sat 12px below the fold on the *fullest* wall (M11-32/33), would be
     * checking the one layout that cannot reproduce the defect. Opening one of each puts all seven
     * back and keeps this test measuring what it is for. Test 24 covers the hide/return itself.
     */
    await page.evaluate(async () => {
      for (const importance of ['important', 'routine']) {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'fire', severity: 'high', importance }),
        });
      }
    });
    await repaint();

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(600);

    const wall = await page.evaluate(() => {
      const visible = (
        Array.from(document.querySelectorAll('#dashboardView .panels > .panel')) as HTMLElement[]
      ).filter((p) => p.offsetParent !== null && !p.hidden);
      const nested = (
        Array.from(document.querySelectorAll('#dashboardView .panel[data-nested]')) as HTMLElement[]
      ).map((p) => p.dataset['panel'] ?? '');
      return {
        panels: visible.length,
        nested,
        ids: visible.map((p) => p.dataset['panel'] ?? ''),
        tops: visible.map((p) => ({
          id: p.dataset['panel'] ?? '',
          top: Math.round(p.getBoundingClientRect().top + window.scrollY),
        })),
        lastBottom: Math.round(
          Math.max(...visible.map((p) => p.getBoundingClientRect().bottom + window.scrollY)),
        ),
        docHeight: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
      };
    });

    /**
     * The layout the district gets with nothing configured. A panel joining it is a decision,
     * and this is where that decision has to be made deliberately rather than noticed later.
     *
     * **Seven since 2026-08-19**, and the count moved because two panels became one *frame*
     * rather than because anything left the wall — `weather` and `news` are still rendered,
     * still their own sections, and still choosable on their own (ADR-0015). What changed is
     * that `outside` holds them.
     *
     * ⚠️ **`.panels > .panel` and not `.panel`.** The nested pair are `.panel` elements too, so
     * the old selector counts them a second time — which is how this assertion first went red at
     * 9, describing the *same* wall it had described at 8.
     *
     * Eight before that, since M11-32. `importantEmergencies` and `routineEmergencies` still
     * stand in for `situation` (M10-23) — two panels for one, by design.
     *
     * Seven holds here only because the two emergencies opened above put the conditional pair on
     * the wall (2026-09-08 — see the note at the top of this test). The resting default with
     * nothing open is five, and that is deliberate.
     */
    expect(wall.panels).toBe(7);
    expect(wall.ids).toContain('keys');
    expect(wall.ids).toContain('importantEmergencies');
    expect(wall.ids).toContain('routineEmergencies');
    expect(wall.ids).toContain('outside');
    expect(wall.ids).not.toContain('situation');
    expect(wall.ids).not.toContain('condition');

    /**
     * ⚠️ **The frame's whole point is that it is a frame.** If `outside` ever drew weather or
     * headlines of its own, there would be two of each on this page and `getElementById` would
     * paint whichever it reached first. This says the real sections are inside it, in order,
     * weather above.
     */
    expect(wall.nested).toEqual(['weather', 'news']);

    /**
     * **Nothing starts below the fold**, which is the defect that was found and the one thing a
     * wall cannot survive: a panel whose first pixel is off-screen is a panel that is not on the
     * wall at all, while every model and every count says it is.
     */
    const unseen = wall.tops.filter((p) => p.top >= wall.viewport);
    expect(unseen).toEqual([]);

    /**
     * And the page is within one activity panel of fitting — the honest statement of where this
     * stands. It fits exactly at rest; the excess on a busy morning is the twenty-row list, and
     * that number is the district's.
     */
    expect(wall.docHeight - wall.viewport).toBeLessThan(200);
    expect(wall.lastBottom).toBeLessThan(wall.viewport + 200);
  }, 120_000);

  it('13. the card face is an opaque ground, so the contrast pass can still see it', async () => {
    await openDashboard();

    const ground = await page.evaluate(() => {
      const face = document.querySelector('#dashKeys .key .face') as HTMLElement | null;
      return face === null ? null : getComputedStyle(face).backgroundColor;
    });

    expect(ground).not.toBeNull();
    // No alpha channel at all, and not the transparent keyword.
    expect(ground).toMatch(/^rgb\(/);
    expect(ground).not.toBe('rgba(0, 0, 0, 0)');
  }, 120_000);

  //----------------------------------------------------------------------------
  // The dashboard is fetched, not shipped — M11-34.
  //----------------------------------------------------------------------------

  /**
   * ## Why these three, and why here
   *
   * The dashboard left the shell because the shell had **1,800 bytes** of its 163,840 left and
   * the faceted panel does not fit in 1,800 bytes. Moving it out returned **22 KB**, which is
   * the whole of `tilt.ts` plus all of `dashboard.ts` except the running clock.
   *
   * Every byte of that saving rests on one line in `main.ts` — its import list. Add
   * `createDashboard` back to it and esbuild pulls the module in whole again, **with no type
   * error, no failing behaviour, and nothing on screen to see**. The thirteen tests above would
   * all still pass. Only the budget would notice, in another file, as a number nobody reads
   * until it goes red.
   *
   * So test 15 asserts the split directly, at the two files the browser actually receives.
   */
  it('15. the shell does not carry the dashboard, and the fetched file does', async () => {
    const shell = await fetch(`${origin}/app.js`);
    const lazy = await fetch(`${origin}/dashboard.js`);

    expect(shell.status).toBe(200);
    expect(lazy.status).toBe(200);

    const shellText = await shell.text();
    const lazyText = await lazy.text();

    /**
     * ⚠️ **Matched on a string the district would notice losing, not on a symbol name.**
     *
     * `createDashboard` is minified away, so asserting on it would assert on nothing. These are
     * user-visible strings from `dashboard.ts` that survive minification because they are text
     * somebody reads on the wall — which also means a rename that moves them is a change to the
     * screen, and this test failing then is the correct outcome rather than a nuisance.
     */
    // Was "...and acknowledged." until 2026-09-04 — see `web/src/dashboard.ts`'s header.
    const wall = 'Everything open is with a department and somebody is on it.';

    expect(lazyText).toContain(wall);
    expect(shellText).not.toContain(wall);

    // And the half that must NOT have moved: the running clock and the counting ages are chrome
    // on every screen, signed in or out, so they stay in the shell. `dashboard.js` carries its
    // own copy — 1,351 bytes, deliberately duplicated rather than paid for with a third bundle.
    expect(shellText).toContain('dateline');
  }, 120_000);

  /**
   * The half that lets the dashboard be lazy at all.
   *
   * This project's rule for lazy screens is **"for screens somebody chooses to open, never for
   * the one they land on"** (`dispatchBundle.ts`), and an office seat on a laptop lands on this
   * screen straight out of sign-in. The rule is not bent here, it is paid for: the fetch starts
   * the moment sign-in says the seat has a dashboard, before anything is clicked.
   *
   * Without this the change would be a regression dressed as a saving — the office would wait
   * for a network round trip on the screen they opened the app to read.
   */
  it('16. sign-in fetches the dashboard before anybody clicks Dashboard', async () => {
    const fresh = await context.browser()?.newContext();
    if (fresh === undefined) throw new Error('no browser');
    const solo = await fresh.newPage();

    const asked: string[] = [];
    solo.on('request', (req) => {
      if (req.url().endsWith('/dashboard.js')) asked.push(req.url());
    });

    try {
      await solo.goto(origin);
      await solo.waitForSelector('#login', { state: 'visible', timeout: 20_000 });
      await solo.fill('#phone', actor.phone);
      await solo.fill('#password', TEST_PASSWORD);
      /**
       * ⚠️ **The wait is armed before the click, and that is not decoration.**
       *
       * Written the other way round — sign in, then `waitForRequest` — this test failed while
       * the product was working: `waitForRequest` only ever resolves on a *future* event, and
       * the prefetch had already been and gone in the milliseconds between `#who` appearing and
       * the next line running. It is the same shape as `repaint()`'s own recorded flake above:
       * **waiting for something that is already true.**
       */
      const prefetched = solo.waitForRequest((req) => req.url().endsWith('/dashboard.js'), {
        timeout: 20_000,
      });

      await solo.click('#loginSubmit');
      await solo.waitForSelector('#who', { state: 'visible', timeout: 20_000 });

      // Asserted without ever touching #navDashboard.
      await prefetched;
      expect(asked.length).toBeGreaterThan(0);

      /**
       * ⚠️ **And exactly once.**
       *
       * `paintIdentity` runs from three paths, and a guard on the built screen alone is still
       * null while the first fetch is in the air — so two calls milliseconds apart would append
       * two script tags and build two dashboards, each polling the district's one server on its
       * own timer. That is the shape of the `EventSource` leak this milestone already paid for
       * one screen along, which is why the in-flight promise is held and not just the result.
       */
      await solo.click('#navDashboard');
      await solo.waitForSelector('#dashKeys .key', { timeout: 20_000 });
      expect(asked.length).toBe(1);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  /**
   * A screen that did not arrive is a sentence, not a dead tab — the rule every lazy screen
   * here follows, and the one this file is the newest member of.
   *
   * The sentence names what still works without a connection, because for this product that is
   * the useful half: intake and the board are the two things an officer must never be told are
   * unavailable, and neither of them is in this file.
   */
  it('17. a dashboard that could not be fetched says so, and names what still works', async () => {
    /**
     * ⚠️ **`serviceWorkers: 'block'`, and it took a failing test to learn why.**
     *
     * Written without it, this test passed the abort and then sat waiting for an error that
     * never came — because **Playwright's `route` does not intercept requests a service worker
     * makes**, and this app registers one. The SW's generic handler fetched the real file over
     * the real socket, the dashboard loaded perfectly, and the test timed out waiting for a
     * failure it had not actually caused.
     *
     * Blocking the worker puts the request back on the page, where `route` can refuse it. What
     * is being tested here is the client's own handling of a screen that did not arrive, and
     * that is a question about `loadScreen`, not about the cache in front of it.
     */
    const fresh = await context.browser()?.newContext({ serviceWorkers: 'block' });
    if (fresh === undefined) throw new Error('no browser');
    const solo = await fresh.newPage();
    await solo.route('**/dashboard.js', (route) => route.abort());

    try {
      await solo.goto(origin);
      await solo.waitForSelector('#login', { state: 'visible', timeout: 20_000 });
      await solo.fill('#phone', actor.phone);
      await solo.fill('#password', TEST_PASSWORD);
      await solo.click('#loginSubmit');
      await solo.waitForSelector('#who', { state: 'visible', timeout: 20_000 });

      await solo.click('#navDashboard');
      await solo.waitForSelector('#dashError:not([hidden])', { timeout: 20_000 });

      const said = (await solo.textContent('#dashError')) ?? '';
      expect(said).toContain('connection');
      expect(said.toLowerCase()).toContain('board');

      // The tab is still a tab. Nothing is disabled, nothing is hidden, and the operator can
      // try again the moment they are back — the failed fetch is not remembered as an answer.
      expect(await solo.isVisible('#navDashboard')).toBe(true);
      expect(await solo.isVisible('#navBoard')).toBe(true);
    } finally {
      await fresh.close();
    }
  }, 120_000);
  /**
   * **18. what the reset took off the counters is on the wall, fenced off from today.**
   *
   * The dashboard is one district day and an incident belongs to the day it started, so an
   * emergency opened six days ago is in **none** of the figures above this band — and escalation
   * stopped chasing it at its own midnight (ADR-0020 §4b). **This strip is the only place in the
   * product where it is still visible**, so what is asserted here is not a rendering detail: it
   * is whether an old open emergency can be seen at all.
   *
   * ⚠️ **The feed is intercepted rather than seeded, and it has to be.** Producing a real
   * carry-over needs an incident that started on an earlier day, and `recorded_at` is assigned by
   * the database with the event log append-only under a trigger — there is **no honest way to age
   * a row**. The server half is proved against a real database in `api/__tests__/dashboard.test.ts`
   * by moving the clock; what is left for a browser is *does the screen draw what it was sent*,
   * and that is exactly what routing the response asks.
   *
   * ⚠️ **`serviceWorkers: 'block'`, and without it this test times out on a fault it did not
   * cause.** `page.route` does not intercept a request the service worker makes, so the real
   * `/dashboard` would answer over the real socket and the injected figures would never arrive.
   * This project has already paid for that lesson once, in M11-34.
   */
  it('18. the carry-over strip shows what the day reset took off the counters', async () => {
    const fresh = await browser.newContext({ serviceWorkers: 'block' });

    try {
      const sheet = await fresh.newPage();

      // Six days back, so the age the strip prints is one nobody could mistake for today's.
      const oldest = new Date(Date.now() - 6 * 86_400_000).toISOString();

      /**
       * ⚠️ **Matched on the exact path, never on a trailing-wildcard glob.**
       *
       * The dashboard left the shell as a lazy bundle (M11-34), so **`/dashboard.js` is fetched
       * over the same origin** and a trailing wildcard catches it too. The handler then parses
       * JavaScript as JSON, the bundle never loads, and the failure that surfaces is a timeout
       * waiting for a strip whose whole screen was never built — a symptom pointing at the
       * feature under test rather than at the route.
       */
      await sheet.route(
        (url) => url.pathname === '/dashboard',
        async (route) => {
          const real = await route.fetch();
          const feed = (await real.json()) as {
            district: Record<string, unknown>;
          };

          feed.district['carriedOver'] = { resolvedToday: 5, stillOpen: 13, oldestOpenAt: oldest };
          await route.fulfill({ response: real, json: feed });
        },
      );

      await sheet.goto(origin);
      await sheet.waitForSelector('#who:not([hidden]), #login:not([hidden])', { timeout: 20_000 });
      if (!(await sheet.isVisible('#who'))) {
        await sheet.fill('#phone', actor.phone);
        await sheet.fill('#password', TEST_PASSWORD);
        await sheet.click('#loginSubmit');
        await sheet.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
      }
      await sheet.click('#navDashboard');
      await sheet.waitForSelector('#dashCarried:not([hidden])', { timeout: 20_000 });

      // Both halves are said, and the warning names its own age — the count alone reads the same
      // on the day it becomes 13 and a fortnight later.
      const done = (await sheet.textContent('#dashCarriedDone')) ?? '';
      const open = (await sheet.textContent('#dashCarriedOpen')) ?? '';

      expect(done).toContain('5');
      expect(done).toContain('resolved today');
      expect(open).toContain('13');
      expect(open).toContain('still open');
      expect(open).toContain('oldest');

      /**
       * ⚠️ The age must be a `[data-since]` element, not text.
       *
       * `signatureOf` blanks those before comparing, so a number rewriting itself every second
       * cannot make this panel read as changed on every poll. Written as plain text it would
       * repaint the strip twenty seconds into somebody reading it — the trap `overdueByMinutes`
       * cost the board once, where one new emergency flashed the entire screen.
       */
      expect(await sheet.getAttribute('#dashCarriedOpen .cage', 'data-since')).not.toBeNull();

      /**
       * And it is fenced BELOW the district's own figures, never among them. Above the tiles it
       * would read as part of today, which is the confusion this whole change exists to remove.
       */
      const keysBottom = (await sheet.locator('#dashKeys').boundingBox())?.y ?? 0;
      const bandTop = (await sheet.locator('#dashCarried').boundingBox())?.y ?? 0;
      expect(bandTop).toBeGreaterThan(keysBottom);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  /**
   * **19. a quiet district shows no band at all.**
   *
   * The other half of the rule, and it is what keeps the band worth reading. A line permanently
   * on screen is one an operator stops seeing, and then it is not there on the morning it says
   * three — `moreSentence` follows the same rule for the activity panel and `.note:empty` for
   * every note in the product.
   */
  it('19. nothing is fenced off when nothing was carried over', async () => {
    const fresh = await browser.newContext({ serviceWorkers: 'block' });

    try {
      const sheet = await fresh.newPage();

      /**
       * ⚠️ **Matched on the exact path, never on a trailing-wildcard glob.**
       *
       * The dashboard left the shell as a lazy bundle (M11-34), so **`/dashboard.js` is fetched
       * over the same origin** and a trailing wildcard catches it too. The handler then parses
       * JavaScript as JSON, the bundle never loads, and the failure that surfaces is a timeout
       * waiting for a strip whose whole screen was never built — a symptom pointing at the
       * feature under test rather than at the route.
       */
      await sheet.route(
        (url) => url.pathname === '/dashboard',
        async (route) => {
          const real = await route.fetch();
          const feed = (await real.json()) as { district: Record<string, unknown> };

          feed.district['carriedOver'] = { resolvedToday: 0, stillOpen: 0, oldestOpenAt: null };
          await route.fulfill({ response: real, json: feed });
        },
      );

      await sheet.goto(origin);
      await sheet.waitForSelector('#who:not([hidden]), #login:not([hidden])', { timeout: 20_000 });
      if (!(await sheet.isVisible('#who'))) {
        await sheet.fill('#phone', actor.phone);
        await sheet.fill('#password', TEST_PASSWORD);
        await sheet.click('#loginSubmit');
        await sheet.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
      }
      await sheet.click('#navDashboard');
      await sheet.waitForSelector('#dashKeys .key', { timeout: 20_000 });

      expect(await sheet.isVisible('#dashCarried')).toBe(false);
    } finally {
      await fresh.close();
    }
  }, 120_000);
  it('20. a carried row opens the incident on the board, where it can be closed', async () => {
    /**
     * 🔴 **The panel says what is still running; it cannot say it has finished.**
     *
     * That gap is the whole reason this row leads anywhere. *"Its date has passed — is this
     * still running?"* is a question, and the two answers are *leave it* and *close it* —
     * the second is an act by a named person with a reason (ADR-0003), which a wall read by a
     * room must never perform. So the row hands the incident to the board and stops.
     *
     * ⚠️ **Asserted by keyboard, not by mouse.** `leadsTo` gives these rows
     * `role="button"` and a tab stop precisely so an officer at a desk can reach them; a test
     * that only clicks would pass with the keyboard path broken, which is the state this
     * project has shipped before.
     */
    await page.click('#navDashboard');
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: 'flood',
          severity: 'serious',
          description: 'clickable row seed',
        }),
      });
    });

    await page.waitForSelector('#dashStill .srow', { timeout: 20_000 });

    const row = page.locator('#dashStill .srow').first();
    // The affordance itself: a div with only a click handler is a control that does not exist
    // for somebody driving this with Tab.
    expect(await row.getAttribute('role')).toBe('button');
    expect(await row.getAttribute('tabindex')).toBe('0');

    await row.focus();
    await page.keyboard.press('Enter');

    // The board's detail, opened on one incident — and the actions panel is the thing that
    // was missing from the wall.
    await page.waitForSelector('#detailHead h2', { state: 'visible', timeout: 20_000 });
    await page.waitForSelector('#takeAction:not([hidden])', { timeout: 20_000 });

    const actions = await page.textContent('#takeActionRows');
    expect(actions ?? '').toMatch(/resolve/i);
  }, 120_000);
  it('21. the carried rows travel, seamlessly, and stop for anybody reaching for one', async () => {
    /**
     * The owner's own words: *"news ki tarha hi ye neche sai upar jaa rahe ho"*.
     *
     * 🔴 **The pause is the assertion that matters.** These rows open an incident
     * (test 20), so a row that slid out from under the pointer would have made the panel worse
     * by making it prettier — the click would land on whichever row had moved into that
     * position. Nothing about a ticker is worth that.
     */
    /**
     * ⚠️ **Close test 20's incident first.** It opens one and leaves it open, and an incident is
     * a modal slide-out now: `main[data-pane="open"]` puts `#detailBackdrop` over the whole page
     * and it intercepts the click meant for the nav. Playwright reported it exactly — *"…
     * intercepts pointer events"* — and this test spent 30s on it while reading as a failure of
     * the ticker.
     */
    const back = page.locator('#back');
    if (await back.isVisible()) {
      await back.click();
      await page.waitForSelector('main:not([data-pane="open"])');
    }
    await page.click('#navDashboard');

    // Four is one more than `STILL_ROLLS_ABOVE`, which is where the film starts doubling.
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(async (n: number) => {
        await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            category: 'flood',
            severity: 'serious',
            description: `ticker seed ${String(n)}`,
          }),
        });
      }, i);
    }

    /**
     * ⚠️ **Two poll cycles, not one.** The dashboard refreshes every 20 seconds
     * (`createDashboard`'s own default), so a 20-second wait for a row seeded a moment ago is a
     * coin toss on the request landing before the next tick — which is how this file and
     * `contrast` test 5 both failed on CI while passing on a laptop whose database already had
     * carried rows in it.
     */
    await page.waitForFunction(
      () => document.querySelectorAll('#dashStill .srow').length > 3,
      undefined,
      { timeout: 60_000 },
    );

    /**
     * Every row is on screen twice, and the second copy is hidden from a screen reader.
     *
     * That is what makes the loop seamless: the track travels -50% of its own height, so with
     * two identical copies the last frame is pixel-identical to the first. Counted rather than
     * described, because a film with one copy scrolls to blank and jumps.
     */
    const film = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#dashStill .srow'));
      const hidden = rows.filter((r) => r.getAttribute('aria-hidden') === 'true').length;
      const track = document.getElementById('dashStill');
      return {
        total: rows.length,
        hidden,
        rolling: track?.dataset['rolling'] ?? null,
        playing: track === null ? null : getComputedStyle(track).animationPlayState,
      };
    });

    expect(film.rolling).toBe('yes');

    /**
     * 🔴 **NOTHING IS CUT, which is the half of this the first attempt got wrong.**
     *
     * The window was a constant in the stylesheet and it clipped the panel to roughly half its
     * rows — *"ye panel half ho gaye hain … es ko cut nhe karna maqsod tha"*. Motion was
     * never a reason to hide anything: the film is two identical copies and travels -50%
     * whatever the window is, so the height only decides how much a room reads at once.
     *
     * One copy is all of them, so the window must be **half the track**, and every row of the
     * first copy must sit inside it. A tolerance of one pixel, because a half of an odd number
     * of pixels is not an integer and nothing here is worth a rounding argument.
     */
    const fit = await page.evaluate(() => {
      const list = document.querySelector('.slist');
      const track = document.getElementById('dashStill');
      if (list === null || track === null) return null;
      const rows = Array.from(track.querySelectorAll<HTMLElement>('.srow')).filter(
        (r) => r.getAttribute('aria-hidden') !== 'true',
      );
      const listBox = list.getBoundingClientRect();
      const lowest = rows.reduce((worst, r) => {
        const b = r.getBoundingClientRect();
        return Math.max(worst, b.bottom - listBox.top);
      }, 0);
      return { window: list.clientHeight, oneCopy: track.scrollHeight / 2, lowest };
    });

    expect(fit, 'the ticker window is not on the page').not.toBeNull();
    expect(
      Math.abs(fit!.window - fit!.oneCopy),
      `the window is ${String(fit!.window)}px for a copy that is ${String(fit!.oneCopy)}px`,
    ).toBeLessThanOrEqual(1);
    // And said the other way round, from the rows rather than from the arithmetic: the last row
    // of the first copy ends inside the window rather than under its edge.
    expect(fit!.lowest, 'a row of the first copy is clipped by the window').toBeLessThanOrEqual(
      fit!.window + 1,
    );
    // Two copies: half the rows are the silent one.
    expect(film.hidden * 2).toBe(film.total);
    expect(film.playing).toBe('running');

    /**
     * 🔴 **`mouse.move`, NOT `page.hover`, and the reason is the feature itself.**
     *
     * `page.hover` waits for the element to be *stable* — the same bounding box across two
     * animation frames — before it will touch it. A row on a moving film is never stable, so
     * that call retried for thirty seconds and timed out on CI: **Playwright refused to reach
     * for a moving row for precisely the reason a person cannot.** Moving the pointer to a
     * fixed point over the panel is what a hand actually does, and it asks the page for no
     * permission.
     */
    const spot = await page.evaluate(() => {
      const list = document.querySelector('.slist');
      if (list === null) return null;
      const r = list.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    expect(spot, 'the ticker window is not on the page').not.toBeNull();

    await page.mouse.move(spot!.x, spot!.y);
    const hovered = await page.evaluate(
      () =>
        getComputedStyle(document.getElementById('dashStill') as HTMLElement).animationPlayState,
    );
    expect(hovered, 'the film did not stop for the pointer').toBe('paused');

    /**
     * And the officer at a desk driving it with Tab. `:hover` and `:focus-within` are two
     * selectors sharing one declaration, so either could be dropped without the other noticing
     * — which is why both are pressed rather than one taken as evidence of the pair.
     */
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#dashStill .srow')?.focus();
    });
    const focused = await page.evaluate(
      () =>
        getComputedStyle(document.getElementById('dashStill') as HTMLElement).animationPlayState,
    );
    expect(focused, 'the film did not stop for the keyboard').toBe('paused');
  }, 120_000);

  it('22. a panel is wrapped for travel once, not once per repaint', async () => {
    /**
     * 🔴 **`flowPanels()` runs on EVERY `paint()`, so it has to recognise its own work.**
     *
     * The first version found the list as *"the first `<div>` child of `.lift`"* and asked
     * whether that div's parent was a `.pfilm`. After the first paint the first `<div>` child of
     * `.lift` **is the `.pflow` window it just built**, whose parent is `.lift`, not a `.pfilm`
     * — so the check never matched again. Every subsequent repaint wrapped the previous wrapper
     * in another `.pflow`/`.pfilm` and cloned the whole growing subtree for the seam copy, so
     * each panel's DOM roughly doubled every twenty seconds. On the wall it was fine for a
     * minute or two and then the tab — and then the machine — stopped responding.
     *
     * So: repaint several times, and the count of windows must not move, and no window may sit
     * inside another.
     */
    await openDashboard();
    await repaint();

    const after = async (): Promise<{ windows: number; nested: number }> =>
      page.evaluate(() => ({
        windows: document.querySelectorAll('#dashboardView .pflow').length,
        nested: document.querySelectorAll('#dashboardView .pflow .pflow').length,
      }));

    const first = await after();
    // At least one panel on the shipped dashboard is a flowed panel — the mechanism is doing
    // nothing at all if this is zero.
    expect(first.windows).toBeGreaterThan(0);
    expect(first.nested, 'a travel window is already nested on the first paint').toBe(0);

    for (let i = 0; i < 4; i += 1) await repaint();

    const later = await after();
    expect(
      later.windows,
      `${String(first.windows)} travel windows became ${String(later.windows)} after four repaints`,
    ).toBe(first.windows);
    expect(later.nested, 'repaints nested travel windows inside each other').toBe(0);
  }, 120_000);

  /**
   * The DC does not do data entry — the wall IS the job — and the DC office drives it from a
   * laptop over HDMI, at 1366×768 or whatever the room's projector is. On that screen the
   * shipped default lands in the 56rem two-column tier, which is a deliberate scroll (its own
   * note: *"Narrower screens keep four columns, where two rows of four ARE the intended
   * reading"*), so the DC sees the counters and a sliver of the next row and nothing else.
   *
   * `index.html`'s HDMI-laptop tier — `min-width: 64rem` AND `max-height: 51rem`, so 1920×1080
   * never enters it and test 14 above is untouched — puts the wall's three columns on the short
   * screen and compresses the vertical rhythm to match.
   *
   * ⚠️ **Until 2026-09-07 this asserted the whole default fitted with NO scroll** — every panel
   * starting on screen and the last one ending short of the fold. The lever that bought that was
   * `--pflow-h: 4rem` on this tier: a one-row travel window, so `utilities` / `importantEmergencies`
   * / `routineEmergencies` / `presence` / `stillRunning` each showed one service at a time and
   * crawled the rest past. The owner watched that and asked for the opposite — *"card mai aik hi
   * show ho raha hai … km si kam 3 show ho"* — so the window is now `10.5rem`, the wall's own,
   * ~three compact rows. Five windows six rem taller is about a screen's worth of extra height on
   * a 768 laptop, and **the owner chose the three rows over the no-scroll** (2026-09-07).
   *
   * So this test's contract is now the weaker, honest one: **the tier is on (three columns), the
   * counters and the first row of panels are on screen without scrolling, and the page does not
   * run away** — a sanity ceiling, not a fold. The rows below the first come round on the loop or
   * on a scroll, which is what the district asked for.
   */
  it('23. the HDMI-laptop tier keeps the three columns and the first panel row on screen', async () => {
    await openDashboard();

    for (const screen of [
      { w: 1366, h: 768 },
      { w: 1280, h: 720 },
    ]) {
      await page.setViewportSize({ width: screen.w, height: screen.h });
      await page.waitForTimeout(600);

      const wall = await page.evaluate(() => {
        const visible = (
          Array.from(document.querySelectorAll('#dashboardView .panels > .panel')) as HTMLElement[]
        ).filter((p) => p.offsetParent !== null && !p.hidden);
        return {
          columns: getComputedStyle(document.querySelector('#dashboardView .panels') as HTMLElement)
            .gridTemplateColumns.trim()
            .split(/\s+/).length,
          tops: visible.map((p) => ({
            id: p.dataset['panel'] ?? '',
            top: Math.round(p.getBoundingClientRect().top + window.scrollY),
          })),
          lastBottom: Math.round(
            Math.max(...visible.map((p) => p.getBoundingClientRect().bottom + window.scrollY)),
          ),
          viewport: window.innerHeight,
        };
      });

      const where = `${String(screen.w)}×${String(screen.h)}`;

      // The tier is on: the wall's three columns, not the laptop tier's two.
      expect(wall.columns, `${where}: not in the three-column tier — ${JSON.stringify(wall)}`).toBe(
        3,
      );

      // The counters and the first row of panels are on screen without a scroll: the full-width
      // `keys` panel plus the three that sit in the grid's first row — four panels, all starting
      // above the fold. Everything after that may come round on the loop or on a scroll.
      const onScreen = wall.tops.filter((p) => p.top < wall.viewport);
      expect(
        onScreen.length,
        `${where}: fewer than four panels start on screen — ${JSON.stringify(wall.tops)}`,
      ).toBeGreaterThanOrEqual(4);

      // The page does not run away — a sanity ceiling, not the fold it used to be. Under twice
      // the viewport keeps a regression that doubled a window (or lost the tier) visible while
      // allowing the ~one screen of scroll the three-row windows now cost.
      expect(
        wall.lastBottom,
        `${where}: page is ${String(wall.lastBottom)} on a ${String(wall.viewport)} screen — ${JSON.stringify(wall.tops)}`,
      ).toBeLessThan(wall.viewport * 2);
    }
  }, 120_000);

  /**
   * The owner's ask, 2026-09-08: a titled card with an empty body reads as clutter on a wall
   * meant to be scanned at four metres. `routineEmergencies` and `importantEmergencies` — and
   * the `alerts` panel, for a district that has laid it out — come off the wall when nothing of
   * their kind is open, and come straight back the moment something is. `renderCondition` has
   * hidden itself this way since M6-30; this extends the same `data-empty` mark, which
   * `applyLayout` reads after every paint.
   *
   * ⚠️ **Driven by a feed mock, not by opening real emergencies.** The shared browser context
   * this file uses carries incidents opened by earlier tests, so *"nothing routine is open"* is
   * not a state the live server can be put back into here without resolving everything first.
   * The mock pins exactly the two windows under test and leaves the rest of the feed real — the
   * same technique test 19 uses for the carry-over strip.
   */
  it('24. an emergency panel with nothing open leaves the wall, and returns when something opens', async () => {
    const fresh = await browser.newContext({ serviceWorkers: 'block' });

    try {
      const sheet = await fresh.newPage();

      let important: Record<string, unknown> = { visible: [], hidden: 0, total: 0, more: null };
      const routine: Record<string, unknown> = { visible: [], hidden: 0, total: 0, more: null };

      await sheet.route(
        (url) => url.pathname === '/dashboard',
        async (route) => {
          const real = await route.fetch();
          const feed = (await real.json()) as Record<string, unknown>;
          feed['importantEmergencies'] = important;
          feed['routineEmergencies'] = routine;
          await route.fulfill({ response: real, json: feed });
        },
      );

      await sheet.goto(origin);
      await sheet.waitForSelector('#who:not([hidden]), #login:not([hidden])', { timeout: 20_000 });
      if (!(await sheet.isVisible('#who'))) {
        await sheet.fill('#phone', actor.phone);
        await sheet.fill('#password', TEST_PASSWORD);
        await sheet.click('#loginSubmit');
        await sheet.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
      }
      await sheet.click('#navDashboard');
      await sheet.waitForSelector('#dashKeys .key', { timeout: 20_000 });

      const isHidden = async (panel: string): Promise<boolean | null> =>
        sheet.evaluate((id) => {
          const node = document.querySelector<HTMLElement>(
            `#dashboardView .panel[data-panel="${id}"]`,
          );
          return node === null ? null : node.hidden;
        }, panel);

      // Nothing open of either kind: neither panel is on the wall.
      expect(await isHidden('importantEmergencies')).toBe(true);
      expect(await isHidden('routineEmergencies')).toBe(true);

      // One important emergency opens. Its panel returns; the routine one, still empty, does not.
      important = {
        visible: [
          {
            at: null,
            headline: 'Fire · Mamund',
            detail: 'Rescue 1122 on scene',
            acknowledged: false,
          },
        ],
        hidden: 0,
        total: 1,
        more: null,
      };

      await sheet.click('#navBoard');
      await sheet.waitForSelector('#dashboardView', { state: 'hidden', timeout: 20_000 });
      await Promise.all([
        sheet.waitForResponse((res) => res.url().endsWith('/dashboard') && res.status() === 200, {
          timeout: 20_000,
        }),
        sheet.click('#navDashboard'),
      ]);
      await sheet.waitForSelector('#dashImportant .act-row', { timeout: 20_000 });

      expect(await isHidden('importantEmergencies')).toBe(false);
      expect(await isHidden('routineEmergencies')).toBe(true);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  /**
   * ⚠️ **The three status panels carry no age at all — the district's instruction, 2026-09-08.**
   *
   * The owner, watching the wall the control room actually looks at: *"en k sath ju time show
   * hota hai jese k: 1 hr ago, 2 days ago … ye time yaha par show nhe hona chaye hai."* Asked a
   * second time, with INV-02 and ADR-0025 put in front of them, they chose the same thing. So
   * this is not a tidy-up somebody can undo on taste — it is the district's decision, and this
   * test is what stops it drifting back one refactor at a time.
   *
   * **Both halves are checked, because they fail apart.** The text catches an age written as
   * ordinary words. The `[data-since]` count catches the form a text assertion sails past: an
   * `ageSpan` paints empty and `startAges` fills it a second later, so a screenshot taken at the
   * wrong moment agrees with a test that only reads strings.
   *
   * **And `.pitem` is asserted first.** Zero ages on an empty panel is a test that passes
   * because nothing rendered — the vacuous green this file has been bitten by before. The rows
   * must be on the wall for their silence about time to mean anything.
   *
   * ⚠️ **Scope is proved by its sibling, not here.** The rest of the wall still ages, and test
   * 18's `#dashCarriedOpen .cage` assertion is what holds `ageSpan` and `startAges` intact — if
   * this removal had reached the shared machinery rather than these three panels, that test goes
   * red, not this one. The two are a pair; do not delete one without reading the other.
   */
  it('25. shows services, utilities and officers with no age anywhere on the cards', async () => {
    const run = Date.now().toString(36);
    const utility = `Electricity (age ${run})`;
    const service = `DHQ Hospital (age ${run})`;

    for (const [name, panel] of [
      [utility, 'utility'],
      [service, 'services'],
    ] as const) {
      const created = await pool.query<{ utility_id: string }>(
        `INSERT INTO utility (name, panel, position, stale_minutes)
         VALUES ($1, $2, 97, 600) RETURNING utility_id`,
        [name, panel],
      );
      await pool.query(
        `INSERT INTO utility_report (utility_id, status, note) VALUES ($1, 'degraded', $2)`,
        [created.rows[0]!.utility_id, 'transformer under repair'],
      );
    }

    // The officers panel is the curated pick (ADR-0033), so a seat has to be put on the wall
    // before it has a card here at all.
    await pool.query('UPDATE seat SET on_wall = true WHERE seat_id = $1', [actor.seatId]);
    await pool.query(
      `INSERT INTO presence_report (seat_id, status, note) VALUES ($1, 'available', $2)`,
      [actor.seatId, 'at the office'],
    );

    await openDashboard();
    await repaint();

    await page.waitForFunction(
      (names: readonly string[]) =>
        names.every((name) => document.body.textContent?.includes(name) === true),
      [utility, service],
      { timeout: 20_000 },
    );

    for (const panelId of ['dashServices', 'dashUtilities', 'dashPresence']) {
      const found = await page.evaluate((id: string) => {
        const node = document.getElementById(id);
        return {
          rows: node?.querySelectorAll('.pitem').length ?? 0,
          ages: node?.querySelectorAll('[data-since]').length ?? 0,
          text: node?.textContent ?? '',
        };
      }, panelId);

      expect(found.rows).toBeGreaterThan(0);
      expect(found.ages).toBe(0);
      expect(found.text).not.toMatch(/just now|min ago|hours? ago|days? ago|yesterday/);
    }
  }, 120_000);
});
