/**
 * The compose form follows the kind — M9-08, from a real browser.
 *
 * This project verifies a UI change by driving it, not by reading the code that draws it. Three
 * separate defects in `CLAUDE.md` §5 were found this way and would not have been found otherwise,
 * and one of them is the reason this feature exists at all: the owner typed into a box that
 * nothing downstream read.
 *
 * ## What is actually being checked here
 *
 * **That the boxes exist, and that what is typed into them reaches the payload.** Those are two
 * different claims and only the second one matters to an officer. A form that draws a Venue field
 * and drops it on submit looks perfect in a screenshot.
 *
 * The last test is the one worth keeping longest: **a field officer's handset never fetches
 * `compose.js`.** That is the whole reason the module is lazy, and it is the kind of property
 * that quietly stops being true.
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
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the compose form follows the kind', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  /** Every script the browser asked for, so the lazy split can be asserted rather than assumed. */
  const fetched: string[] = [];

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // `#whatBlock` (the kind picker) is shown unconditionally since 2026-09-09, so district
    // tier is no longer what reveals it — signing in at all is enough to reach `signIn()`'s own
    // wait below. Kept at district tier anyway: several tests here dispatch to a department.
    actor = await seedActor(pool, { title: 'M9 Compose Operator', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
    page.on('request', (r) => fetched.push(r.url()));
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

  it('1. an emergency asks for no extra boxes, and the button still says so', async () => {
    await signIn();

    // No structured fields — an emergency's screen already asks what an emergency needs, and
    // adding a Subject box to it would be a second place to write the same sentence.
    expect(await page.locator('#detailsBlock [data-field]').count()).toBe(0);
    expect((await page.textContent('#submit'))?.trim()).toBe('Report emergency');
  });

  it('1b. but it DOES offer an attachment — a photograph of the scene is the best case', async () => {
    // M9-15: the client asked for attachments on emergencies as well as General communications,
    // and this is where it helps most. The block used to hide itself when a kind had no fields.
    expect(await page.isVisible('#attachFile')).toBe(true);
    expect(await page.getAttribute('#attachFile', 'accept')).toContain('pdf');
  });

  it('1c. the attachment never blocks the button — an emergency is still two taps', async () => {
    // INV-01 and M0-36 together. An operator who ignores the file row loses nothing.
    await page.click('label[for="cat-fire"]');
    expect(await page.isDisabled('#submit')).toBe(false);
  });

  it('2. choosing Meeting draws exactly the fields the client named', async () => {
    /**
     * **The tile, not the select — 2026-08-24, ADR-0028.**
     *
     * The kind was a dropdown and is now one of thirteen tiles; the `<select>` survives as the
     * field the tile writes and is `hidden`, so `selectOption` waits for a control nobody can
     * touch and times out. Clicking the tile is what a hand does, and it is also what proves the
     * wiring this suite depends on: a tile that failed to write `kind` would draw no fields at
     * all, which is exactly what the next line asserts.
     */
    await page.click('label[for="cat-meeting"]');
    await page.waitForSelector('#detail_subject', { timeout: 10_000 });

    for (const field of ['subject', 'date', 'time', 'venue', 'note']) {
      expect(await page.isVisible(`#detail_${field}`), `${field} should be drawn`).toBe(true);
    }

    // The button says what it will do. "Report emergency" on a meeting invitation is the same
    // category of lie as a box that reaches nothing.
    expect((await page.textContent('#submit'))?.trim()).toBe('Send Meeting');
  });

  it('3. a Schedule swaps venue for a span, and keeps the subject already typed', async () => {
    await page.fill('#detail_subject', 'Monthly coordination');
    await page.click('label[for="cat-schedule"]');
    await page.waitForSelector('#detail_untilDate', { timeout: 10_000 });

    expect(await page.isVisible('#detail_venue')).toBe(false);
    // Losing what somebody already typed teaches them not to touch the dropdown — and then they
    // send the wrong kind rather than lose a sentence.
    expect(await page.inputValue('#detail_subject')).toBe('Monthly coordination');
  });

  it('4. the button waits for a subject, and frees on the first keystroke', async () => {
    /**
     * One tile now answers both questions, so the second click is gone — and it had to go.
     *
     * This used to choose *Meeting* from the dropdown and then tap **Fire** to satisfy the
     * category, which were two independent facts. Under ADR-0028 tapping *Fire* would rewrite
     * `kind` back to `emergency` and take the subject box off the screen with it, so the test
     * would be asserting the button's state on a form that no longer had the field it is waiting
     * for.
     */
    await page.click('label[for="cat-meeting"]');
    await page.waitForSelector('#detail_subject');

    await page.fill('#detail_subject', '');
    expect(await page.isDisabled('#submit')).toBe(true);

    // `input`, not `change`. An operator who types and reaches straight for the button must not
    // find it still disabled — they would conclude the form was broken.
    await page.type('#detail_subject', 'Flood review');
    expect(await page.isDisabled('#submit')).toBe(false);
  });

  it('5. what was typed reaches the record — the claim that actually matters', async () => {
    await page.fill('#detail_subject', 'Monthly coordination');
    await page.fill('#detail_date', '2026-08-20');
    await page.fill('#detail_time', '10:30');
    await page.fill('#detail_venue', 'DC Office committee room');

    await page.click('#submit');
    await page.waitForSelector('#sent:not([hidden])', { timeout: 15_000 });

    // Read back from the database rather than from the screen. A form that draws a Venue field
    // and drops it on submit looks perfect in a screenshot.
    //
    // Polled, as 5b does: `#sent` means *durable in the outbox*, not *synced* — the push to the
    // server follows it. Read once, this raced the sync and failed under a loaded full run.
    type Payload = { kind?: string; details?: Record<string, string> };
    const deadline = Date.now() + 15_000;
    let payload: Payload | undefined;
    while (Date.now() < deadline && payload === undefined) {
      const { rows } = await pool.query<{ payload: Payload }>(
        `SELECT payload FROM incident_event
          WHERE type = 'reported' AND payload->>'kind' = 'meeting'
          ORDER BY recorded_at DESC LIMIT 1`,
      );
      payload = rows[0]?.payload;
      if (payload === undefined) await new Promise((r) => setTimeout(r, 150));
    }

    expect(payload, 'a meeting should have reached the log').toBeDefined();
    expect(payload?.details).toMatchObject({
      subject: 'Monthly coordination',
      date: '2026-08-20',
      time: '10:30',
      venue: 'DC Office committee room',
    });
  });

  it('5b. "Where is it?" rides the reported event as `location.text`', async () => {
    /**
     * **The box moved into `#whatBlock` on 2026-09-06** — it had been trailing below `#submit`
     * in `.rcolwide`, where the owner sent a live Alert, never scrolled past the red button, and
     * the WhatsApp message went out reading *"no details were entered"*. It sits beside "Incident
     * details" now, so this suite — the only one signed in as a district-tier operator with
     * `#whatBlock` revealed — is where the assertion belongs (it was `rapidIntake.e2e` test 9,
     * which drives a field seat that never sees `#whatBlock`).
     *
     * Read back from the database, not the screen: `#place` writes `location.text` on the
     * `reported` event itself — no second event — and `domain/communications.ts`'s `locationLine`
     * is what puts it on the message.
     */
    // Already signed in from test 1 — a second `signIn()` would wait on a `#login` that never
    // reappears. Reload to a fresh form; the session persists in the context.
    await page.reload();
    await page.waitForSelector('#whatBlock:not([hidden])', { timeout: 15_000 });

    const landmark = `Near the canal bridge ${randomUUID()}`;
    await page.click('label[for="cat-rescue"]');
    await page.click('label[for="sev-critical"]');
    await page.fill('#place', landmark);
    await page.click('#submit');
    await page.waitForSelector('#sent:not([hidden])', { timeout: 15_000 });

    const deadline = Date.now() + 15_000;
    let location: { text?: string } | null = null;
    while (Date.now() < deadline && location === null) {
      const { rows } = await pool.query<{ payload: { location?: { text?: string } } }>(
        `SELECT payload FROM incident_event
          WHERE type = 'reported' AND payload->>'category' = 'rescue'
          ORDER BY recorded_at DESC LIMIT 1`,
      );
      location = rows[0]?.payload.location ?? null;
      if (location?.text === undefined) {
        location = null;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    expect(location?.text).toBe(landmark);
  });

  it('6. a signed-out handset costs nothing until "Report an emergency" is pressed', async () => {
    /**
     * ⚠️ **This used to assert compose.js is NEVER fetched for a signed-out handset — true
     * until 2026-09-09, when `#whatBlock` was administrative-seat-only.** The owner asked for
     * that same rich form for everyone, signed in or not, so a signed-out visitor who presses
     * "Report an emergency" now gets it too, exactly like the control-room seat in test 7.
     *
     * What survives from the original claim: **merely opening the page must still cost
     * nothing.** `#reportView` starts collapsed behind its own link for a confirmed-signed-out
     * visitor, and `paintIdentity()`'s prefetch is gated on `reportRevealed` for exactly this
     * reason (see the comment beside it in `main.ts`) — an anonymous visitor who never presses
     * the link never downloads a control-room bundle, which is the M1 gate's shell budget
     * (M9-08) applied to the one person on a weak connection who has not asked for anything yet.
     */
    const clean = await browser.newContext();
    const officer = await clean.newPage();
    const asked: string[] = [];
    officer.on('request', (r) => asked.push(r.url()));

    await officer.goto(origin);
    await officer.waitForSelector('#revealReport', { timeout: 15_000 });
    expect(asked.some((u) => u.includes('compose.js'))).toBe(false);

    // Now they have asked for the form, and get exactly what the control room gets.
    await officer.click('#revealReport');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !asked.some((u) => u.includes('compose.js'))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(asked.some((u) => u.includes('compose.js'))).toBe(true);
    await clean.close();
  });

  it('7. the control room DID fetch it — so test 6 is not passing by accident', async () => {
    // Without this, test 6 would still pass if the bundle were renamed, deleted, or never built.
    expect(fetched.some((u) => u.includes('compose.js'))).toBe(true);
  });
});
