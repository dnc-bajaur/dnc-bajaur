/**
 * A token link from WhatsApp must reach the server, not the cached shell — 2026-08-14.
 *
 * ## The defect this exists for
 *
 * The approved template's URL button is `https://dnc.example.com/ack/{{1}}`. An officer taps
 * it, the browser performs a **navigation**, and `sw.ts`'s navigation branch answered every
 * navigation with the cached `/index.html` — the line that makes the app open during a shutdown
 * (ADR-0002), doing exactly its job on a path that is not the application.
 *
 * So the officer got the **report screen**. No acknowledge page, no `acknowledged` event, the
 * obligation still unmet on the board, and the token not even spent. It was found by the owner
 * tapping the button on the first real message this district ever sent, on the first browser
 * that had ever opened the app.
 *
 * **This is the third instance of one fault.** `/privacy` was the first (the district's own
 * privacy link answered with the report screen), `/terms` and `/data-deletion` came with it, and
 * `sw.ts` grew a `NOT_THE_APP` list naming them. `/ack/` and `/file/` could not go on that list
 * as written — the token is part of the path, so they need a prefix — and nothing said so.
 *
 * ## Why nothing caught it
 *
 * `lifecycleLink.test.ts` covers `/ack/:token` exhaustively, including every adversarial case,
 * and **all of it passes over this bug**: it uses `fetch()`, whose request mode is never
 * `navigate`. The service worker does not interpose on it. `curl` proves nothing here for the
 * same reason, and neither does a crawler — Meta's link preview fetch always saw the real page.
 *
 * **Only a real browser that has registered the service worker and then *navigates* can see
 * this**, which is what this file does and why it is expensive enough to be worth explaining.
 *
 * And it could only ever hit somebody who has opened the app. The officers this feature exists
 * for never sign in and never open it (ADR-0018), so the audience that was broken was the
 * control room — the one audience able to report it.
 *
 * ## The assertion to keep
 *
 * `#submit` is the report form's button. **Its presence is the bug**, exactly as the owner saw
 * it, and asserting on it rather than on a title means a future rewording of the acknowledge
 * page cannot quietly turn this test green.
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
import { authHeaders, seedActor, seedDepartment, enableAllCapabilities } from '../testing/seed.js';
import { loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { mintAckToken } from '../db/whatsappStore.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('a token link is not the application', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let controlToken: string;
  let dutySeat: string;
  let dutyPerson: string;

  beforeAll(async () => {
    const webRoot = await buildWeb();

    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (tok ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (tok ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (tok ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (tok ${RUN})`,
      departmentId: rescue,
    });
    dutySeat = duty.seatId;
    dutyPerson = duty.personId;

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** An emergency with a real obligation, and a real single-use acknowledge token for it. */
  async function emergencyWithAckToken(): Promise<{ incidentId: string; token: string }> {
    const created = (await (
      await fetch(`${origin}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: 'fire', severity: 'high', description: `tok ${RUN}` }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: dutySeat }] }),
    });

    const events = await loadIncident(pool, created.incidentId);
    const first = [...foldIncident(created.incidentId, events).notifications][0];
    if (first === undefined) throw new Error('no obligation was recorded to answer');

    const token = await mintAckToken(pool, {
      attemptId: first.attemptId,
      incidentId: created.incidentId,
      seatId: dutySeat,
      personId: dutyPerson,
      stage: 'acknowledge',
    });

    return { incidentId: created.incidentId, token };
  }

  /**
   * The precondition, and it must be established rather than assumed.
   *
   * With no service worker controlling the page this whole suite passes trivially and proves
   * nothing — which is the state every other test of `/ack/` is in.
   */
  it('1. registers a service worker, which is the precondition for the bug', async () => {
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  }, 60_000);

  it('2. a NAVIGATION to /ack/<token> reaches the acknowledge page, not the app shell', async () => {
    const { incidentId, token } = await emergencyWithAckToken();

    await page.goto(`${origin}/ack/${token}`, { waitUntil: 'load' });

    // The symptom, exactly as the owner saw it: the report form instead of the acknowledgement.
    expect(await page.locator('#submit').count()).toBe(0);

    // And the page that should have been there. `h1` rather than the wording, so that rephrasing
    // the acknowledgement cannot turn this green while the shell is being served.
    expect(await page.locator('h1').count()).toBeGreaterThan(0);

    /**
     * **The half that matters more than the page: it was recorded.**
     *
     * A page that renders correctly and writes nothing is this project's worst signature — the
     * action succeeds — and it is precisely what happened here, so the assertion cannot stop at
     * what the browser drew.
     */
    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.acknowledgedAt).not.toBeNull();
  }, 60_000);

  it('3. a NAVIGATION to /file/<token> is not answered with the app shell either', async () => {
    // A well-formed token that redeems to nothing: the server answers its own "not recognised"
    // page. Any answer from the server is the pass — being handed the shell is the failure.
    const shaped = 'a'.repeat(40);

    await page.goto(`${origin}/file/${shaped}`, { waitUntil: 'load' });

    expect(await page.locator('#submit').count()).toBe(0);
  }, 60_000);

  /**
   * The line that must not be broken while fixing the line above.
   *
   * `/incidents/<id>` as a navigation **is** a person opening the app and must still resolve to
   * the shell offline — `sw.ts` already carries a paragraph about this, because a previous fix
   * in this same handler broke exactly it.
   */
  it('4. an ordinary in-app navigation still gets the shell', async () => {
    await page.goto(`${origin}/incidents/${randomUUID()}`, { waitUntil: 'load' });

    expect(await page.locator('#submit').count()).toBeGreaterThan(0);
  }, 60_000);
});
