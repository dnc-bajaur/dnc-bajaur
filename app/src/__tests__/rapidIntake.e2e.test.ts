/**
 * M0-36: the fifteen-second budget, measured rather than asserted.
 *
 * From `docs/00-thesis.md`: the system must be faster than the phone call it replaces. If
 * a Rescue operator can make a call in eight seconds and this takes forty, the system
 * loses, operators go back to the phone, and the central board goes quietly false. That
 * makes intake speed a correctness property, not a polish item.
 *
 * The CPU is throttled 4× to approximate a mid-range Android handset, because measuring
 * this on a developer machine would prove nothing about the device it will actually run
 * on. The clock starts when the screen is usable and stops when the report is **durably
 * stored** — not when the network confirms it, because the operator's job is done at the
 * point the emergency cannot be lost.
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

/** The budget. A requirement from the thesis, not an aspiration. */
const BUDGET_MS = 15_000;

/** Rough stand-in for a mid-range Android handset against a developer machine. */
const CPU_SLOWDOWN = 4;

describe.skipIf(dbUrl === undefined)('M0-36: rapid intake', () => {
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
    // Every screen this suite drives, made available first — ADR-0016, M6-45. A fresh
    // installation offers the control room and nothing else, so a test asserting a screen
    // works has to turn it on, and this is the visible act of doing so.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { title: 'Rapid Intake Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext({
      // A real handset in a hand, not a desktop window.
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      geolocation: { latitude: 34.7167, longitude: 71.5167 }, // Bajaur
      permissions: ['geolocation'],
    });
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#who', { state: 'visible', timeout: 15_000 });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function throttle(rate: number): Promise<void> {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  }

  /**
   * Wait until the app is actually usable, not merely painted.
   *
   * `#submit` is in the static HTML, so it appears the moment the document parses — before
   * `boot()` has opened IndexedDB and published `__dnc`. Waiting on it alone proved nothing,
   * and under the 4× CPU throttle in test 5 the gap was wide enough that CI hit
   * `Cannot read properties of undefined (reading 'store')`.
   *
   * It also makes the budget measurement honest. The clock is supposed to start "when the
   * operator could first act", and an operator cannot act on a button whose handler is not
   * attached — starting it at first paint quietly measured less than the real thing.
   */
  async function waitForReady(target: Page = page): Promise<void> {
    await target.waitForSelector('#submit', { timeout: 30_000 });
    await target.waitForFunction(
      () => (globalThis as unknown as { __dnc?: unknown }).__dnc !== undefined,
      undefined,
      { timeout: 30_000 },
    );
  }

  /**
   * Press "Report an emergency" for a context that has never signed in — 2026-09-09.
   *
   * `#reportView` starts collapsed behind that link for a confirmed-signed-out visitor
   * (`reachability === 'refused'`, see `reportRevealed` in `main.ts`); every test in this file
   * that drives a fresh, never-authenticated context needs this before `waitForReady`, which
   * otherwise waits forever on a `#submit` that is real but not on screen.
   *
   * Waits for `__dnc` first — `boot()` publishes it last, and clicking before its listeners
   * attach would just follow the anchor's plain `href` to nowhere useful.
   */
  async function revealReportForm(target: Page): Promise<void> {
    await target.waitForFunction(
      () => (globalThis as unknown as { __dnc?: unknown }).__dnc !== undefined,
      undefined,
      { timeout: 30_000 },
    );
    await target.click('#revealReport');
  }

  async function queueLength(): Promise<number> {
    return page.evaluate(
      async () =>
        (
          await (
            globalThis as unknown as { __dnc: { store: { all(): Promise<unknown[]> } } }
          ).__dnc.store.all()
        ).length,
    );
  }

  describe('the critical path', () => {
    it('1. "Incident details" and "Where is it?" now sit above the button — the traded-away guarantee', async () => {
      await page.reload();
      await waitForReady();

      /**
       * ⚠️ **THIS TEST USED TO GUARD THE OPPOSITE PROPERTY, AND IS KEPT AS A WARNING RATHER
       * THAN A GREEN TICK — 2026-09-09.**
       *
       * Until this date, "Incident details" and "Where is it?" (`#whatBlock`) were revealed
       * only to an administrative seat, so nothing an officer signed in here — a field seat —
       * had to type stood between them and `#submit`. That was M0-36's whole claim, and this
       * test asserted it three times over, each time getting stricter about what "above the
       * button" meant.
       *
       * The owner asked for that same rich form for everyone, signed in or not, and was shown
       * the cost first: on this narrow, single-column layout the two typing controls in
       * `#whatBlock` now render directly above `#submit`, for this field seat as much as for a
       * signed-out visitor. Chosen anyway — see the comment on `#whatBlock` in `index.html` and
       * `controlRoom` in `main.ts`.
       *
       * This test is kept and inverted rather than deleted, so the next person to touch that
       * gate reads why the two-tap guarantee no longer holds here, instead of discovering it
       * from a report that arrived late from a scene with a bad connection.
       */
      const submit = await page.locator('#submit').boundingBox();
      expect(submit).not.toBeNull();

      const above = await page.locator('#report input[type="text"], #report textarea').evaluateAll(
        (ns, buttonTop) =>
          ns
            .filter((n) => (n as HTMLElement).offsetParent !== null)
            .filter((n) => n.getBoundingClientRect().top < buttonTop)
            .map((n) => n.id),
        submit!.y,
      );

      // Named rather than counted: "Incident details" then "Where is it?", in document order.
      expect(above).toEqual(['what', 'place']);
    });

    it('2. will not submit until what happened is chosen', async () => {
      // Severity is pre-set, so the only required choice is the category. Submitting a
      // report with no category would produce a record nobody can route.
      expect(await page.isDisabled('#submit')).toBe(true);

      // Clicking the label, which is what a hand does. The radio itself is visually
      // hidden — it exists so the group stays keyboard- and screen-reader-navigable.
      await page.click('label[for="cat-rta"]');
      expect(await page.isDisabled('#submit')).toBe(false);
    });

    it('3. offers targets big enough for a hand in a hurry', async () => {
      for (const id of ['#cat-rta', '#sev-critical']) {
        const box = await page.locator(`label[for="${id.slice(1)}"]`).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const submitBox = await page.locator('#submit').boundingBox();
      expect(submitBox!.height).toBeGreaterThanOrEqual(60);
    });

    it('4. severity does not rely on colour alone (INV-04)', async () => {
      const label = await page.textContent('label[for="sev-critical"]');
      expect(label?.trim()).toBe('Critical');
    });
  });

  describe('the budget', () => {
    it(`5. open to durably stored in under ${BUDGET_MS / 1000}s on a throttled handset`, async () => {
      await throttle(CPU_SLOWDOWN);
      try {
        const before = await queueLength();

        // The clock starts at **open**, and open means the operator tapped the icon — not
        // the moment the app finished booting.
        //
        // Worth stating, because fixing the readiness race briefly moved this line below
        // `waitForReady()` and the measured time fell from ~800ms to ~260ms. Nothing got
        // faster; the measurement stopped counting the load. The thesis asks for "under 15
        // seconds from open to submitted", and an operator standing at a road accident is
        // waiting through startup exactly as much as through the taps.
        const started = Date.now();
        await page.reload();
        await waitForReady();

        await page.click('label[for="cat-rta"]');
        await page.click('label[for="sev-critical"]');
        await page.click('#submit');

        // Stops when it is durably stored — the moment the emergency cannot be lost.
        await page.waitForFunction(
          (n) =>
            (
              globalThis as unknown as { __dnc: { store: { all(): Promise<unknown[]> } } }
            ).__dnc.store
              .all()
              .then((all) => all.length > n),
          before,
          { timeout: 30_000 },
        );

        const elapsed = Date.now() - started;
        // eslint-disable-next-line no-console
        console.log(`rapid intake: ${elapsed}ms (budget ${BUDGET_MS}ms, cpu ${CPU_SLOWDOWN}x)`);
        expect(elapsed).toBeLessThan(BUDGET_MS);
      } finally {
        await throttle(1);
      }
    });

    it('6. does not wait on the network to consider the report saved', async () => {
      await context.setOffline(true);
      try {
        await page.reload();
        await waitForReady();
        const before = await queueLength();
        const started = Date.now();

        await page.click('label[for="cat-fire"]');
        await page.click('#submit');
        await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(BUDGET_MS);
        expect(await queueLength()).toBe(before + 1);
      } finally {
        await context.setOffline(false);
      }
    });

    it('7. submits fine with location permission denied outright', async () => {
      // There is no device GPS fix any more — 2026-09-05, see `web/src/location.ts` — so this
      // no longer proves "does not wait on a fix". What it still guards is that a browser
      // that refuses the permission outright (an operator who said no once) never blocks
      // intake, which nothing else here would catch if a future change asked for it again.
      const denied = await browser.newContext({
        viewport: { width: 390, height: 844 },
        permissions: [],
      });
      const p = await denied.newPage();
      try {
        await p.goto(origin);
        // A fresh, never-signed-in context — the form is behind its own link now (2026-09-09).
        await revealReportForm(p);
        await waitForReady(p);
        const started = Date.now();

        await p.click('label[for="cat-medical"]');
        await p.click('#submit');
        await p.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      } finally {
        await denied.close();
      }
    });
  });

  describe('submit with nothing but a category', () => {
    /**
     * **Test 9 (`#place` rides the reported event) moved to `compose.e2e.test.ts` — 2026-09-06.**
     * "Where is it?" moved into `#whatBlock` that day (the owner sent a live Alert, never saw the
     * box below `#submit`, and the message read *"no details were entered"*). `#whatBlock` was
     * control-room only at the time, and this suite's field seat never revealed it, so the
     * assertion moved to `compose.e2e.test.ts`, where a district-tier operator drives the form.
     * `#whatBlock` is shown to everyone since 2026-09-09 (test 1, above), but the assertion
     * stays where it landed — this test still proves an EMPTY one is fine, which is the
     * property that matters here regardless of who can see the boxes.
     */
    it('8. a report with no location or description is accepted (INV-01)', async () => {
      await page.reload();
      await waitForReady();

      await page.click('label[for="cat-flood"]');
      await page.click('label[for="sev-critical"]');
      await page.click('#submit');
      await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });

      const deadline = Date.now() + 20_000;
      let found: string | null = null;
      while (Date.now() < deadline && found === null) {
        const res = await pool.query<{ incident_id: string }>(
          `SELECT incident_id FROM incident_event
            WHERE payload->>'category' = 'flood' AND actor_person_id = $1
            ORDER BY recorded_at DESC LIMIT 1`,
          [actor.personId],
        );
        found = res.rows[0]?.incident_id ?? null;
        if (found === null) await new Promise((r) => setTimeout(r, 150));
      }

      expect(found).not.toBeNull();
    });
  });
});
