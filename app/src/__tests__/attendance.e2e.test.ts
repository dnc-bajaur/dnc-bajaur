/**
 * "Who is coming" on the screen — Phase D, 2026-08-20.
 *
 * A real browser, a real database, a real webhook, and only Meta stubbed. Three officers are told
 * about a meeting; one taps **Attending**, one **Not attending**, one **Sending someone**; and the
 * incident's own screen adds them up. That last step is the whole of O-34's second half — the
 * district has been able to *ask* since 19 August and the only way to learn that one was coming
 * was to read three rows one at a time.
 *
 * `domain/__tests__/attendance.test.ts` proves the counting, exhaustively and in isolation. **What
 * this file proves is that it reaches a screen**, which is the part this project has been caught
 * by four times: an endpoint with no door, a panel answering a question the counters beside it had
 * stopped answering, and twice a figure that looked right in a screenshot and led nowhere.
 *
 * ⚠️ **It asserts the NUMBERS on the rendered page, never the markup alone.** A tally that renders
 * beautifully and counts the escalation ladder's own messages is worse than no tally, because the
 * district would act on it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { hashPassword } from '../auth/passwords.js';
import { login } from '../auth/sessions.js';
import { enableAllCapabilities } from '../testing/seed.js';
import { runNotifyPass } from '../jobs/notify.js';
import { whatsappChannel } from '../jobs/whatsappChannel.js';
import { toE164, type WhatsAppConfig } from '../ops/whatsapp.js';
import { measurePage } from '../../scripts/contrast.mjs';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'district-nerve-centre-test';

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  /** Named, so a meeting goes out on the template whose three answers this test taps. */
  noticeTemplate: { name: 'district_notice_v2', language: 'en' },
};

describe.skipIf(dbUrl === undefined)('who is coming, on the screen', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let controlToken: string;
  let officers: { phone: string; personId: string }[] = [];

  /** Never `sent.length` — see `lifecycleInWhatsApp.test.ts` for what that cost. */
  let outbound = 0;
  const stubFetch = (async () => {
    outbound += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${outbound}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const channel = (): ReturnType<typeof whatsappChannel> =>
    whatsappChannel({
      pool,
      config,
      publicOrigin: 'https://dnc.example.invalid',
      fetchImpl: stubFetch,
    });

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      webRoot,
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const control = await actor(`Control Room (att ${RUN})`, `Control (att ${RUN})`, 'district');
    controlToken = control.token;

    // ADR-0030 — the department this seeded had nowhere left to be filed. Contacts are the
    // district’s one flat list now, so the officers below are seeded straight into it.
    officers = [];
    for (const n of [1, 2, 3]) {
      const made = await actor(
        `Officer ${String(n)} (att ${RUN})`,
        `Post ${String(n)} (att ${RUN})`,
        'post',
      );
      officers.push({ phone: made.phone, personId: made.personId });
    }

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', control.phone);
    await page.fill('#password', PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function actor(
    name: string,
    title: string,
    tier: string,
  ): Promise<{ phone: string; token: string; personId: string }> {
    const seat = await pool.query<{ seat_id: string }>(
      // ADR-0031 — the trigger derives `tier` from `is_administration` alone (migration 0042), so
      // the value passed for it is overwritten. Asking for `district` and writing nothing else
      // gets a `post` seat, and every assertion below then fails a long way from the cause.
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, false, $3) RETURNING seat_id`,
      [title, tier, tier === 'district'],
    );
    const phone = `+92300${randomUUID().replace(/\D/g, '').slice(0, 7)}${String(outbound++)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]?.seat_id,
      person.rows[0]?.person_id,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return { phone, token: result.token, personId: person.rows[0]?.person_id ?? '' };
  }

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${controlToken}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /** One communication, told to whoever is named, actually sent. */
  async function raise(kind: string, who: { personId: string }[]): Promise<string> {
    const created = (await post('/incidents', {
      kind,
      category: `att-${RUN}`,
      severity: 'moderate',
      description: `${kind} ${RUN}`,
      ...(kind === 'meeting' ? { details: { subject: `Flood review ${RUN}` } } : {}),
    })) as { incidentId: string };

    await post(`/incidents/${created.incidentId}/dispatch-to`, {
      targets: who.map((o) => ({ kind: 'person', id: o.personId })),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });
    return created.incidentId;
  }

  /** A tap on one of Meta's approved template buttons — words only, no id. */
  async function tap(phone: string, label: string): Promise<void> {
    const raw = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: toE164(phone),
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    button: { text: label, payload: label },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${origin}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    expect(res.status).toBe(200);
  }

  async function openDetail(id: string): Promise<void> {
    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, id);
    await page.waitForSelector('#detailView:not([hidden]) #detailTiles .d-tile');
    // Attendance is part of the full audit now; the default incident read stays concise.
    await page.locator('#whoTold').evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
  }

  it('1. adds up the three answers, on the meeting’s own screen', async () => {
    const id = await raise('meeting', officers);

    // One of each, so no two figures can be confused for one another by a wrong bucket.
    await tap(officers[0]?.phone ?? '', 'Attending');
    await tap(officers[1]?.phone ?? '', 'Not attending');
    await tap(officers[2]?.phone ?? '', 'Sending someone');

    await openDetail(id);
    await page.waitForSelector('#whoToldRows .att', { timeout: 20_000 });

    const tally = await page.evaluate(() => {
      const panel = document.querySelector('#whoToldRows .att');
      const read = (cls: string): string =>
        panel?.querySelector(`.attc-${cls}`)?.textContent?.trim() ?? '';
      return {
        heading: panel?.querySelector('.atth')?.textContent?.trim() ?? '',
        attending: read('attending'),
        notAttending: read('not-attending'),
        sending: read('sending-someone'),
        unanswered: read('unanswered'),
        of: panel?.querySelector('.attof')?.textContent?.trim() ?? '',
      };
    });

    expect(tally.heading.toLowerCase()).toContain('who is coming');
    expect(tally.attending).toBe('1 attending');
    expect(tally.notAttending).toBe('1 not attending');
    expect(tally.sending).toBe('1 sending someone');
    /**
     * Everybody answered, so this reads **zero** rather than being hidden — the one exception to
     * *a zero is not drawn*, because "nobody is outstanding" is the district's best news and the
     * whole reason for asking. Every other figure hides at zero.
     */
    expect(tally.unanswered).toBe('0 no answer yet');
    expect(tally.of).toBe('of 3 people told');
  }, 120_000);

  it('2. says how many have not answered, while any are outstanding', async () => {
    const id = await raise('meeting', officers);
    await tap(officers[0]?.phone ?? '', 'Attending');

    await openDetail(id);
    await page.waitForSelector('#whoToldRows .att', { timeout: 20_000 });

    const seen = await page.evaluate(() => {
      const panel = document.querySelector('#whoToldRows .att');
      return {
        unanswered: panel?.querySelector('.attc-unanswered')?.textContent?.trim() ?? '',
        // Hidden at zero: a figure permanently on screen is one people stop reading.
        notAttending: panel?.querySelector('.attc-not-attending') === null,
        of: panel?.querySelector('.attof')?.textContent?.trim() ?? '',
      };
    });

    expect(seen.unanswered).toBe('2 no answer yet');
    expect(seen.notAttending).toBe(true);
    expect(seen.of).toBe('of 3 people told');
  }, 120_000);

  /**
   * ⚠️ **`contrast.e2e` cannot reach this panel, and that is why the measurement is here.**
   *
   * That suite walks eight screens and none of them is a **meeting's** detail view, so every
   * colour introduced today would have left the palette pass unmeasured — the exact gap `7b` was
   * added to close when the console's Overview replaced the cards it used to measure.
   *
   * ## And the ground is the reason this is not a formality
   *
   * These tokens are measured by that suite on **`--card`**. This panel sits on **`--card2`**, a
   * different ground, and this product has already been caught by exactly that distance:
   * `--ok` read **5.31 on white and 4.37 on its own wash**, and was darkened twice. A token that
   * passes somewhere else is not a token that passes here.
   *
   * Both themes, because since 2026-08-20 both are live on one build and a palette that passes on
   * one says nothing about the other.
   */
  it('4. every colour on the tally clears AA, in both themes', async () => {
    const id = await raise('meeting', officers);
    await tap(officers[0]?.phone ?? '', 'Attending');
    await tap(officers[1]?.phone ?? '', 'Not attending');

    await openDetail(id);
    await page.waitForSelector('#whoToldRows .att', { timeout: 20_000 });

    const inTheme = async (
      theme: 'dark' | null,
    ): Promise<
      {
        selector: string;
        ratio: number;
        threshold: number;
        colour: string;
        ground: string;
        passes: boolean;
      }[]
    > => {
      await page.evaluate((t) => {
        if (t === null) delete document.documentElement.dataset['theme'];
        else document.documentElement.dataset['theme'] = t;
      }, theme);
      // Longer than the slowest colour transition on any screen (.tilt .face, 420ms).
      await page.waitForTimeout(500);
      const { results } = (await measurePage(page)) as {
        results: {
          selector: string;
          ratio: number;
          threshold: number;
          colour: string;
          ground: string;
          passes: boolean;
        }[];
      };
      return results.filter((r) => r.selector.includes('att'));
    };

    for (const theme of [null, 'dark'] as const) {
      const pairs = await inTheme(theme);
      const where = theme === null ? 'light' : 'dark';

      /**
       * **Measured at all** comes first. A filter that matches nothing passes vacuously, which is
       * the shape of a guard that guards nothing — and this file would then report a palette as
       * sound on the strength of having looked at zero elements.
       */
      expect(pairs.length, `${where}: nothing on the tally was measured`).toBeGreaterThan(0);

      const failures = pairs.filter((p) => !p.passes);
      const why = failures
        .map(
          (p) =>
            `  ${String(p.ratio)} (needs ${String(p.threshold)}) — ` +
            `${p.colour} on ${p.ground}  ${p.selector}`,
        )
        .join('\n');

      // Every failure printed in full — a count tells nobody which colour to change.
      expect(failures, `${where} tally:\n${why}`).toEqual([]);
    }

    await page.evaluate(() => {
      delete document.documentElement.dataset['theme'];
    });
  }, 120_000);

  it('3. draws no tally at all on an emergency', async () => {
    /**
     * Null rather than a tally of zeroes, and the panel simply absent rather than empty.
     * *"Attending"* is not an answer to a road accident — which is exactly why `answersFor`
     * refuses to put those buttons on one — and an empty tally invites *"nobody is coming"*
     * about an emergency.
     */
    const id = await raise('emergency', officers);

    await openDetail(id);
    // The panel it would have sat above is present, so this is the tally being absent rather
    // than the screen having failed to render.
    await page.waitForSelector('#whoToldRows', { timeout: 20_000 });

    expect(await page.locator('#whoToldRows .att').count()).toBe(0);
    expect(await page.locator('#whoToldRows .told').count()).toBeGreaterThan(0);
  }, 120_000);
});
