/**
 * M0-12: the app must open with no network.
 *
 * Until the service worker existed, a handset that closed the browser during a shutdown
 * could not reach the app at all — the queued report was safe on disk and completely
 * unreachable. This suite is the proof that is no longer true.
 *
 * It also guards the single most dangerous thing a cache could do here: serve a stale
 * `/sync` response. That would tell a client its emergency was accepted when it was not,
 * and the outbox — which releases only what the server confirms — would delete it. INV-01
 * violated silently, by a caching layer, with no error anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
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

describe.skipIf(dbUrl === undefined)('M0-12: the app opens with no network', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  /**

   * The incident reported in step 4, captured from the page after submit.
   *
   * Identified by its incident id rather than by a typed field: the rapid-intake path
   * (M0-36) requires no typing at all, and tagging a report by a form value would couple
   * this suite to the intake form's shape.
   */
  let reportedIncidentId: string | null = null;

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

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function serviceWorkerReady(): Promise<void> {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });
  }

  it('1. loads online and registers a service worker', async () => {
    await page.goto(origin);
    // `attached`, not the default `visible`: `#reportView` starts collapsed behind its own
    // "Report an emergency" link for a signed-out visitor since 2026-09-09 (`reportRevealed`
    // in `main.ts`). This is a readiness gate before the login below, not a UI assertion.
    await page.waitForSelector('#report', { state: 'attached' });

    // Sign in through the real endpoint. The session cookie is then carried automatically
    // by the transport, as it would be on a handset.
    /**
     * ⚠️ **DISTRICT TIER, BECAUSE THE READ IN TEST 11 HAS TO SUCCEED — ADR-0030.**
     *
     * This was a station officer, who since migration 0039 is refused every incident by
     * `evaluateRead`: with no departments left, an unplaced incident is readable only by a seat
     * with district authority, and every incident is unplaced for ever. So the officer could
     * report an emergency and was answered **404 reading back the one they had just reported**
     * — and test 11 says in as many words that the read must actually succeed, or it passes by
     * never caching a 401. Nobody outside the control room signs in anyway (ADR-0024).
     */
    const actor = await seedActor(pool, {
      title: 'Offline Launch Control Room',
      tier: 'district',
    });
    const loggedIn = await page.evaluate(
      async ([phone, password]) => {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        });
        return res.ok;
      },
      [actor.phone, TEST_PASSWORD],
    );
    expect(loggedIn).toBe(true);

    // First load registers; the worker claims clients on activate.
    await serviceWorkerReady();

    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    expect(controlled).toBe(true);
  });

  it('2. opens with the network cut — the whole point of M0-12', async () => {
    await context.setOffline(true);

    // Would have failed with ERR_INTERNET_DISCONNECTED before the service worker existed.
    await page.reload();
    await page.waitForSelector('#report', { timeout: 20_000 });

    const heading = await page.textContent('h1');
    expect(heading).toContain('District Nerve Center');
  });

  it('3. says plainly that it is offline, rather than implying anything', async () => {
    // The status must settle from an actual sync attempt, not from navigator.onLine.
    await page.waitForFunction(
      () => document.getElementById('status')?.dataset['state'] === 'offline',
      undefined,
      { timeout: 15_000 },
    );

    const text = await page.textContent('#status');
    expect(text).toMatch(/saved on this device/i);
    expect(text).not.toMatch(/delivered immediately/i);
  });

  it('3b. never trusts navigator.onLine to claim it is connected', async () => {
    // The regression this pins: Playwright cuts the network at the driver, but Chromium
    // still reports navigator.onLine === true. A handset on a cell tower with dead
    // backhaul does exactly the same. An app that trusts it displays "Connected. Reports
    // are delivered immediately." during precisely the outage the operator needs to know
    // about — INV-02 applied to connectivity itself.
    const browserThinksOnline = await page.evaluate(() => navigator.onLine);
    const displayed = await page.getAttribute('#status', 'data-state');

    expect(browserThinksOnline).toBe(true);
    expect(displayed).toBe('offline');
  });

  it('4. captures a critical report while offline', async () => {
    // Two taps and the button — the rapid-intake path (M0-36). No typing on the critical
    // path, so the report is tagged by its incident id rather than by a typed field.
    await page.click('label[for="cat-rta"]');
    await page.click('label[for="sev-critical"]');
    await page.click('#submit');

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 1,
      undefined,
      { timeout: 10_000 },
    );

    const badge = await page.textContent('.badge');
    // Never a tick, never "sent". Only what is actually true.
    expect(badge).toMatch(/saved on this device/i);
    expect(badge).not.toMatch(/sent|delivered/i);

    reportedIncidentId = await page.evaluate(() =>
      (
        globalThis as unknown as { __dnc: { lastIncidentId(): string | null } }
      ).__dnc.lastIncidentId(),
    );
    expect(reportedIncidentId).not.toBeNull();
  });

  it('5. the offline report survives closing and reopening the app, still offline', async () => {
    await page.reload();
    await page.waitForSelector('#report', { timeout: 20_000 });

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 1,
      undefined,
      { timeout: 10_000 },
    );

    expect(await page.textContent('#count')).toBe('(1)');
  });

  it('6. delivers itself when signal returns', async () => {
    await context.setOffline(false);

    await page.evaluate(async () => {
      await (globalThis as unknown as { __dnc: { trySync(): Promise<void> } }).__dnc.trySync();
    });

    await page.waitForFunction(
      () => document.querySelectorAll('#entries .entry').length === 0,
      undefined,
      { timeout: 15_000 },
    );

    /**
     * The report, and nothing after it.
     *
     * A routing pass ran the moment it arrived until ADR-0022, and it was the fix the M1 gate
     * forced: until then `/sync` appended raw events and never routed, so an emergency
     * captured offline — the whole point of this file — reached nobody once it got through.
     * The claim this file exists for is untouched: **it got through**, whole, by itself.
     */
    const stored = await pool.query<{ type: string }>(
      `SELECT type FROM incident_event WHERE incident_id = $1 ORDER BY seq`,
      [reportedIncidentId],
    );
    expect(stored.rows.map((r) => r.type)).toEqual(['reported']);
  });

  describe('the cache must never serve /sync', () => {
    it('7. no sync or health response is in any cache', async () => {
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
      });

      expect(cached).not.toContain('/sync');
      expect(cached).not.toContain('/health');
      // ...but the shell is there, which is what makes offline launch work.
      expect(cached).toContain('/index.html');
    });

    it('8. a push while offline fails rather than being answered from cache', async () => {
      // A cached "accepted" would make the outbox delete an emergency the server never got.
      await context.setOffline(true);

      const outcome = await page.evaluate(async () => {
        try {
          const res = await fetch('/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: 'x', events: [] }),
          });
          return { threw: false, status: res.status };
        } catch {
          return { threw: true, status: 0 };
        }
      });

      expect(outcome.threw).toBe(true);
      await context.setOffline(false);
    });

    it('9. a queued report is never released on a failed push', async () => {
      await context.setOffline(true);

      const result = await page.evaluate(async () => {
        const dnc = (
          globalThis as unknown as {
            __dnc: {
              outbox: {
                enqueue(d: unknown): Promise<{ eventId: string }>;
                sync(): Promise<{ offline: boolean; pushed: number }>;
                pendingCount(): Promise<number>;
              };
            };
          }
        ).__dnc;

        await dnc.outbox.enqueue({
          eventId: crypto.randomUUID(),
          incidentId: crypto.randomUUID(),
          type: 'reported',
          occurredAt: new Date().toISOString(),
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'mobile',
          payload: { severity: 'critical', category: 'fire' },
        });

        // Restoring the network at the end of the previous test fires the browser's
        // `online` event, which starts a sync of its own. `sync()` deliberately joins a
        // run already in progress rather than racing it, so the first call here can
        // legitimately return that earlier run's online answer. Drive it until a sync
        // actually starts while offline — that is the state under test.
        let sync = await dnc.outbox.sync();
        for (let i = 0; i < 20 && !sync.offline; i++) {
          await new Promise((r) => setTimeout(r, 50));
          sync = await dnc.outbox.sync();
        }

        return {
          offline: sync.offline,
          pushed: sync.pushed,
          pending: await dnc.outbox.pendingCount(),
        };
      });

      expect(result.offline).toBe(true);
      expect(result.pushed).toBe(0);
      // The property that actually matters: a failed push never releases the report.
      expect(result.pending).toBe(1);

      await context.setOffline(false);
    });
  });

  it('10. a navigation to an unknown path still resolves offline', async () => {
    await context.setOffline(true);

    await page.goto(`${origin}/incidents/${randomUUID()}`);
    await page.waitForSelector('#report', { timeout: 20_000 });

    expect(await page.textContent('h1')).toContain('District Nerve Center');
    await context.setOffline(false);
  });

  describe('/incidents is two different things at the same URL', () => {
    /**
     * Test 10 above is one half of this and caught the bug that produced this block: adding
     * `/incidents` to the service worker's never-cache list made an operator opening the app
     * at `/incidents/<id>` during an outage get ERR_INTERNET_DISCONNECTED instead of the
     * app. These two tests pin both halves, because a fix for either one alone reintroduces
     * the other.
     *
     *   navigation to /incidents/:id  → must always resolve, offline included
     *   fetch of    /incidents/:id    → must never be served from cache (INV-02)
     */
    it('11. incident state fetched over the network is never put in a cache', async () => {
      const created = await page.evaluate(async () => {
        const res = await fetch('/incidents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category: 'rta', severity: 'high' }),
        });
        const body = (await res.json()) as { incidentId: string };
        const read = await fetch(`/incidents/${body.incidentId}`);
        return { incidentId: body.incidentId, status: read.status };
      });

      // The read has to actually succeed, or this test would pass by never caching a 401.
      expect(created.status).toBe(200);

      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
      });

      expect(cached.filter((u) => u.startsWith('/incidents'))).toEqual([]);
    });

    it('12. and offline, that fetch fails rather than answering with yesterday', async () => {
      // A cached incident is a screen showing an emergency as unacknowledged when a crew is
      // already on the way, or as open when it was closed an hour ago — on the screen used
      // to decide whether to send anyone. Failing is the honest answer.
      await context.setOffline(true);

      const outcome = await page.evaluate(async (id: string) => {
        try {
          const res = await fetch(`/incidents/${id}`);
          return { threw: false, status: res.status };
        } catch {
          return { threw: true, status: 0 };
        }
      }, randomUUID());

      expect(outcome.threw).toBe(true);
      await context.setOffline(false);
    });
  });

  //--------------------------------------------------------------------------
  // The origin this gate cannot otherwise see — M6-39, ADR-0017
  //--------------------------------------------------------------------------

  describe('13. an origin that is not secure', () => {
    /**
     * **This gate has been passing against the one origin where the fault cannot occur.**
     *
     * Every test above drives `127.0.0.1`, which *is* a secure context by explicit exception in
     * the specification — so a service worker registers, the app opens offline, and the suite
     * goes green. On every real handset in Bajaur the app was opened at
     * `http://<office-IP>:3000`, which is **not** a secure context: the service worker never
     * registered and the app did not open without a network, which is the single claim
     * ADR-0002 exists to make. Nothing here could see it. Same shape as the `npm start` fault
     * of 2026-08-04 — the tests were right about the code and wrong about the deployment.
     *
     * The real fix is the proxy and the district's own domain (M6-36, R-21). What this pins is
     * the part that has to hold **until every handset has been re-added from it**: the failure
     * stops being silent. An officer whose app quietly does not work offline finds out at the
     * scene; an officer told on the screen finds out in the office.
     *
     * Driven by overriding `isSecureContext` before any script runs, because Playwright cannot
     * be handed an insecure origin that a browser will treat as one — which is the same
     * exception that hid this in the first place.
     */
    let insecure: BrowserContext;
    let insecurePage: Page;

    beforeAll(async () => {
      insecure = await browser.newContext();
      insecurePage = await insecure.newPage();
      await insecurePage.addInitScript(() => {
        Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      });
      await insecurePage.goto(origin);
      // `attached`, not `visible` — this context never signs in, so `#reportView` stays
      // collapsed behind its reveal link (2026-09-09). See test 1's comment above.
      await insecurePage.waitForSelector('#report', { state: 'attached' });
    }, 60_000);

    afterAll(async () => {
      await insecure?.close();
    });

    it('says so on the screen, in words an officer can act on', async () => {
      const warning = insecurePage.locator('#insecureOrigin');

      expect(await warning.isVisible()).toBe(true);

      const text = (await warning.textContent()) ?? '';
      // Names the consequence and the fix. "Insecure context" is not a sentence anybody in a
      // district office can do anything with.
      expect(text).toContain('will not work at a scene');
      expect(text).toContain('https://');
    });

    it('does not register a service worker it knows cannot work', async () => {
      // Not registered, rather than registered-and-failing. A caught rejection is precisely how
      // this stayed invisible for the life of the product.
      const registrations = await insecurePage.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 0;
        return (await navigator.serviceWorker.getRegistrations()).length;
      });

      expect(registrations).toBe(0);
    });

    it('still lets an emergency be reported', async () => {
      /**
       * INV-01 outranks every other concern here, including this one.
       *
       * The warning is about what happens **later**, at a scene with no signal. Somebody
       * standing in front of this screen right now with an emergency to report must still be
       * able to report it — a banner that disabled the form would turn a degraded install into
       * no install at all.
       */
      expect(await insecurePage.locator('#submit').count()).toBe(1);
    });

    it('shows nothing of the sort on the secure origin the rest of this suite uses', async () => {
      // The warning must never appear where it does not apply, or it becomes wallpaper. This
      // is also what proves the check is the browser's own answer rather than a guess at the
      // protocol — `127.0.0.1` is plain HTTP and is a secure context.
      expect(await page.locator('#insecureOrigin').isVisible()).toBe(false);
    });
  });
});
