/**
 * Signing in, from a real browser.
 *
 * Two claims matter more than the rest, and both are about telling the truth:
 *
 *   1. "Signed out" and "no signal" are shown as different things. They need different
 *      actions from the operator, and confusing them sends someone hunting for signal on a
 *      working connection while a report sits undelivered.
 *   2. An emergency can be recorded whether or not anyone is signed in. A duty officer
 *      whose session expired overnight, on a handset with no signal, cannot sign in — and
 *      refusing them would lose the emergency outright (INV-01).
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
import { revokeAllForPerson } from '../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('signing in', () => {
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

    actor = await seedActor(pool, { title: 'Login Test Duty Officer' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function statusState(): Promise<string | null> {
    return page.getAttribute('#status', 'data-state');
  }

  async function signIn(phone: string, password: string): Promise<void> {
    await page.fill('#phone', phone);
    await page.fill('#password', password);
    await page.click('#loginSubmit');
  }

  it('1. shows the sign-in form when nobody is signed in', async () => {
    await page.goto(origin);
    await page.waitForSelector('#login');

    expect(await page.isVisible('#loginView')).toBe(true);
    expect(await page.isVisible('#who')).toBe(false);
  });

  it('2. refuses a wrong password without saying which part was wrong', async () => {
    await signIn(actor.phone, 'definitely-not-the-password');
    await page.waitForSelector('#loginError', { state: 'visible', timeout: 10_000 });

    const message = await page.textContent('#loginError');
    expect(message).toMatch(/not correct/i);
    // No hint about whether the number exists — that list is what an attacker wants.
    expect(message).not.toMatch(/no such|unknown number|user not found/i);
    expect(await page.isVisible('#loginView')).toBe(true);
  });

  it('3. signs in with correct credentials and shows who is on duty', async () => {
    await signIn(actor.phone, TEST_PASSWORD);
    await page.waitForSelector('#who', { state: 'visible', timeout: 10_000 });

    expect(await page.isVisible('#loginView')).toBe(false);
    expect(await page.textContent('#whoName')).toBeTruthy();

    await page.waitForFunction(
      () => document.getElementById('status')?.dataset['state'] === 'online',
      undefined,
      { timeout: 10_000 },
    );
  });

  it('4. stays signed in across a reload', async () => {
    await page.reload();
    await page.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
    expect(await page.isVisible('#loginView')).toBe(false);
  });

  /**
   * The rapid-intake path: two taps and the button, no typing (M0-36). Returns the
   * incident id so assertions can be made against the incident rather than a form value.
   */
  /**
   * Submit a report and return **its** incident id.
   *
   * Waits for the id to *change*, not for `#sent` to appear. `#sent` stays visible after the
   * first report, so waiting on it returns instantly on every subsequent one — and
   * `lastIncidentId()` could still be the previous report's, read before the new enqueue had
   * finished. That made a later assertion check the wrong incident: locally it passed on
   * timing, and on CI's empty database it did not. A test that depends on how fast the
   * machine is will eventually lie in whichever direction is least convenient.
   */
  async function reportEmergency(category = 'rta'): Promise<string> {
    const previous = await page.evaluate(() =>
      (
        globalThis as unknown as { __dnc: { lastIncidentId(): string | null } }
      ).__dnc.lastIncidentId(),
    );

    await page.click(`label[for="cat-${category}"]`);
    await page.click('label[for="sev-critical"]');
    await page.click('#submit');

    await page.waitForFunction(
      (prev: string | null) => {
        const id = (
          globalThis as unknown as { __dnc: { lastIncidentId(): string | null } }
        ).__dnc.lastIncidentId();
        return id !== null && id !== prev;
      },
      previous,
      { timeout: 15_000 },
    );
    await page.waitForSelector('#sent', { state: 'visible', timeout: 15_000 });

    const id = await page.evaluate(() =>
      (
        globalThis as unknown as { __dnc: { lastIncidentId(): string | null } }
      ).__dnc.lastIncidentId(),
    );
    expect(id).not.toBeNull();
    expect(id).not.toBe(previous);
    return id!;
  }

  /** Poll the database. Waiting on an empty queue races the submit that empties it. */
  async function storedCount(incidentId: string): Promise<number> {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM incident_event WHERE incident_id = $1`,
      [incidentId],
    );
    return Number(res.rows[0]!.n);
  }

  async function waitForStored(incidentId: string, timeoutMs = 15_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let n = 0;
    while (Date.now() < deadline) {
      n = await storedCount(incidentId);
      if (n > 0) return n;
      await new Promise((r) => setTimeout(r, 100));
    }
    return n;
  }

  it('5. a report delivers immediately while signed in', async () => {
    // Delivered means the report is on the server. The routing pass that follows it adds a
    // second event a moment later (the M1 gate's fix), so this asserts *at least* the
    // report — the claim here is about delivery, not about how many events an arrival
    // produces.
    const incidentId = await reportEmergency();
    expect(await waitForStored(incidentId)).toBeGreaterThanOrEqual(1);
  });

  describe('a session that goes away underneath the operator', () => {
    let revokedIncidentId: string;

    it('6. reports "signed out", not "no connection"', async () => {
      // Revoked by an administrator, exactly as a compromised account would be.
      await revokeAllForPerson(pool, actor.personId);

      /**
       * Synced until it reports the refusal, not once.
       *
       * A single call can catch the **tail of a sync that is already running**: the outbox
       * hands a concurrent caller the in-flight run's result rather than inventing a second
       * connectivity answer, and that run started before the session was revoked. So it
       * correctly reports "reachable", and the screen is correct too — for another second.
       *
       * That behaviour is right (see `Outbox.sync`), and this test was always racing it. The
       * race started losing when routing on the sync path made the push a little slower.
       * Polling is what the running app does anyway, on its own interval.
       *
       * Polled from Node rather than with `page.waitForFunction`, which resolves on the
       * Promise an async callback returns rather than on its value — so it succeeds
       * instantly and proves nothing. Same trap as in `admin.e2e.test.ts`.
       */
      const deadline = Date.now() + 15_000;
      let state = await statusState();
      while (state !== 'signedout' && Date.now() < deadline) {
        await page.evaluate(async () => {
          await (globalThis as unknown as { __dnc: { trySync(): Promise<void> } }).__dnc.trySync();
        });
        state = await statusState();
        if (state !== 'signedout') await new Promise((r) => setTimeout(r, 250));
      }

      expect(await statusState()).toBe('signedout');
      const text = await page.textContent('#status');
      expect(text).toMatch(/signed out/i);
      // The distinction that matters: this is not a connectivity problem.
      expect(text).not.toMatch(/no connection/i);
    });

    it('7. drops back to the sign-in form', async () => {
      await page.waitForSelector('#loginView', { state: 'visible', timeout: 10_000 });
      expect(await page.isVisible('#who')).toBe(false);
    });

    it('8. still records an emergency while signed out, and keeps it', async () => {
      // The revoke dropped this page onto the sign-in screen (test 7), where the report form
      // is collapsed behind "Report an emergency" for a confirmed-signed-out visitor —
      // 2026-09-09, see `reportRevealed` in `main.ts`. The operator here is not a stranger, but
      // the client has no way to tell "session just revoked" apart from "never signed in", and
      // the owner's decision was to treat them alike.
      await page.click('#revealReport');
      revokedIncidentId = await reportEmergency('fire');

      await page.waitForFunction(
        () => document.querySelectorAll('#entries .entry').length === 1,
        undefined,
        { timeout: 10_000 },
      );

      // Held, not lost, and not claimed to be delivered.
      const badge = await page.textContent('.badge');
      expect(badge).toMatch(/saved on this device/i);
      expect(await storedCount(revokedIncidentId)).toBe(0);
    });

    it('9. delivers it on the next sign-in, with no operator action', async () => {
      await signIn(actor.phone, TEST_PASSWORD);
      await page.waitForSelector('#who', { state: 'visible', timeout: 10_000 });

      // Nobody pressed anything to send it. Signing in was enough.
      expect(await waitForStored(revokedIncidentId)).toBeGreaterThanOrEqual(1);
    });

    it('10. attributes it to whoever delivered it', async () => {
      // The honest available answer. Whoever signed in is identifiable and accountable;
      // the alternative was no record at all.
      const row = await pool.query<{ actor_person_id: string | null }>(
        `SELECT actor_person_id FROM incident_event WHERE incident_id = $1`,
        [revokedIncidentId],
      );
      expect(row.rows[0]!.actor_person_id).toBe(actor.personId);
    });
  });

  describe('signing out', () => {
    it('11. returns to the sign-in form and reports being signed out', async () => {
      await page.click('#logout');
      await page.waitForSelector('#loginView', { state: 'visible', timeout: 10_000 });
      expect(await page.isVisible('#who')).toBe(false);
    });

    it('12. the old session is genuinely dead server-side, not just hidden', async () => {
      // INV-05 again: hiding the UI is not the control. The cookie must be refused.
      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'dnc_bajaur_session');
      const res = await fetch(`${origin}/auth/me`, {
        headers: session === undefined ? {} : { cookie: `dnc_bajaur_session=${session.value}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('offline sign-in', () => {
    it('13. says signing in needs a connection, rather than failing silently', async () => {
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('#login', { timeout: 20_000 });

      // Waits for a *measured* failure to reach the server. Chromium still reports
      // navigator.onLine === true here, so anything keyed on that would never appear —
      // which is exactly how this test caught the bug.
      await page.waitForSelector('#offlineLoginNote', { state: 'visible', timeout: 15_000 });
      expect(await page.isDisabled('#loginSubmit')).toBe(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    });

    it('14. records an emergency anyway — offline and signed out', async () => {
      // The worst case this district has: a shutdown, an expired session, and an accident.
      const incidentId = await reportEmergency('medical');

      await page.waitForFunction(
        () => document.querySelectorAll('#entries .entry').length >= 1,
        undefined,
        { timeout: 10_000 },
      );

      expect(await page.textContent('.badge')).toMatch(/saved on this device/i);
      expect(await storedCount(incidentId)).toBe(0);
      await context.setOffline(false);
    });
  });

  describe('the cache never holds an identity', () => {
    it('15. no /auth response is in any cache', async () => {
      // A cached identity on a shared handset shows the previous holder as signed in after
      // a shift change, and attributes their reports to someone who has gone home.
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const urls: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
        }
        return urls;
      });

      expect(cached.filter((u) => u.startsWith('/auth'))).toHaveLength(0);
      expect(cached).toContain('/index.html');
    });
  });
});
