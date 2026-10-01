/**
 * **The district's response options, on the page rather than in the thread** — RX-01, 2026-08-25.
 *
 * Real PostgreSQL, real HTTP, real single-use tokens, real fold. Nothing stubbed.
 *
 * ## 🔴 Why this file had to be written the morning after the workflow shipped
 *
 * The page is not a fallback for these officers. It is **the only road**. Two of this district's
 * live templates carry a link and no quick reply — `district_message_img_v2` (anything with a
 * photograph) and `district_message_v3` (schedules, plain information, a cancelled meeting) — and
 * **a URL button opens no WhatsApp service window**, so the thread can never reach the officer who
 * tapped one. Everything `api/__tests__/acknowledgementThanks.e2e.test.ts` proves about the list in
 * the thread proves nothing at all about them.
 *
 * It shipped to Bajaur on 24 August with no test behind it. This is that gap closed.
 *
 * ## What each test is actually protecting
 *
 * **The full wording reaches the page** (`2`). The 24-character headline exists because Meta caps a
 * list row's title; a page has no such cap, and an officer reading a shortened sentence here would
 * be reading words the Deputy Commissioner's office never wrote.
 *
 * **A GET spends nothing** (`3`). WhatsApp fetches URLs to build link previews, so a crawler
 * following one of these would otherwise answer on an officer's behalf before any human saw it.
 *
 * **An empty reason is refused BEFORE the token is spent** (`7`). The district's own document says
 * a reason is *required* under *Otherwise Unavailable*. Spending first would burn the officer's
 * single-use link on their own blank box and leave them with nothing but a telephone number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { mintAckToken } from '../../db/whatsappStore.js';
import { RESPONSE_THANKS } from '../../domain/acknowledgementThanks.js';

const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the district’s options, on the page', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let controlToken: string;
  let seatId: string;
  let personId: string;

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (rsp ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (rsp ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (rsp ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (rsp ${RUN})`,
      departmentId: rescue,
    });
    seatId = duty.seatId;
    personId = duty.personId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** An emergency somebody was told about, so there is an obligation for a token to answer. */
  async function dispatched(body: Record<string, unknown> = {}): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category: 'fire',
          severity: 'high',
          description: `rsp ${RUN}`,
          ...body,
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: seatId }] }),
    });

    return created.incidentId;
  }

  async function attemptOn(incidentId: string): Promise<string> {
    const events = await loadIncident(pool, incidentId);
    const first = foldIncident(incidentId, events).notifications[0];
    if (first === undefined) throw new Error('no obligation was recorded to answer');
    return first.attemptId;
  }

  async function mint(incidentId: string, stage: 'acknowledge' | 'response'): Promise<string> {
    return mintAckToken(pool, {
      attemptId: await attemptOn(incidentId),
      incidentId,
      seatId,
      personId,
      stage,
    });
  }

  const get = async (token: string): Promise<string> =>
    (await fetch(`${base}/ack/${token}`)).text();

  const choose = async (token: string, option?: string, said?: string): Promise<Response> =>
    fetch(`${base}/ack/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...(option === undefined ? {} : { option }),
        ...(said === undefined ? {} : { said }),
      }).toString(),
    });

  const state = async (incidentId: string) =>
    foldIncident(incidentId, await loadIncident(pool, incidentId));

  //--------------------------------------------------------------------------

  it('1. hands the officer the options on the page the acknowledge tap opens', async () => {
    const id = await dispatched();
    const page = await get(await mint(id, 'acknowledge'));

    expect(page).toContain('name="option"');
    /** And the acknowledgement is thanked without spending the district's closing sentence. */
    expect(page).toContain('Acknowledged');
    expect(page).not.toContain('0000-000000');
  });

  it('2. shows the district’s sentences at full length, not the handset’s headlines', async () => {
    const id = await dispatched();
    const page = await get(await mint(id, 'response'));

    // Fire, in the district's own words.
    expect(page).toContain('Deploying Relevant Staff / Team');
    expect(page).toContain('Matter Already Being Handled');
    // The 24-character headline belongs on a WhatsApp row and must not appear here.
    expect(page).not.toContain('Deploying staff / team');
  });

  it('3. draws the branch open, and spends nothing to do it', async () => {
    const id = await dispatched();
    const token = await mint(id, 'response');

    const page = await get(token);
    expect(page).toContain('Sending a Responsible Representative');
    expect(page).toContain('On Leave');
    expect(page).toContain('Otherwise Unavailable');

    /**
     * 🔴 The crawler test. A link preview is a GET, and if a GET spent the token the officer would
     * open their own message and find the answer already given.
     */
    const again = await get(token);
    expect(again).toContain('name="option"');
  });

  it('4. records the district’s full sentence on the obligation, and closes with their words', async () => {
    const id = await dispatched();
    const res = await choose(await mint(id, 'response'), 'fire_deploy');

    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('Deploying Relevant Staff / Team');
    expect(page).toContain('0000-000000');

    const after = await state(id);
    expect(after.notifications.some((n) => n.said === 'Deploying Relevant Staff / Team')).toBe(
      true,
    );
    /** Somebody is dealing with it, so the emergency moved. */
    expect(after.status).toBe('responding');
  });

  it('5. closes an emergency on the sentence the district says means it is over', async () => {
    const id = await dispatched();
    await choose(await mint(id, 'response'), 'already_handled');

    const after = await state(id);
    expect(after.status).toBe('resolved');

    /**
     * ⚠️ The outcome, not the status. A resolution recorded as the word *resolved* answers nothing
     * six weeks later (M9-27); the district's own sentence is the only account of why it stopped.
     */
    const events = await loadIncident(pool, id);
    const closed = events.filter((e) => e.type === 'resolved');
    expect(closed).toHaveLength(1);
    expect(JSON.stringify(closed[0]?.payload)).toContain('Matter Already Being Handled');
  });

  it('6. takes no ownership when the officer says it is not theirs', async () => {
    const id = await dispatched();
    /** Acknowledged first, exactly as a real officer reaches this page: the tap, then the options. */
    await get(await mint(id, 'acknowledge'));
    await choose(await mint(id, 'response'), 'not_mine');

    const after = await state(id);
    expect(after.notifications.some((n) => n.said === 'Not Related to Me')).toBe(true);
    /** Answered, and nothing has taken it. The obligation is met; the emergency is not. */
    expect(after.status).toBe('acknowledged');
  });

  //--------------------------------------------------------------------------
  // The refusals, and every one of them refuses BEFORE spending anything
  //--------------------------------------------------------------------------

  it('7. refuses an empty reason without burning the officer’s only link', async () => {
    const id = await dispatched();
    const token = await mint(id, 'response');

    const refused = await choose(token, 'unable_other', '   ');
    expect(refused.status).toBe(200);
    const page = await refused.text();
    expect(page).toContain('reason');
    expect(page).toContain('name="option"');

    /** 🔴 The point of the test: the same token still works, so they can answer properly. */
    const second = await choose(token, 'unable_other', 'vehicle broken down at Nawagai');
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('0000-000000');

    const events = await loadIncident(pool, id);
    expect(JSON.stringify(events)).toContain('vehicle broken down at Nawagai');
  });

  it('8. refuses a submit with nothing chosen, and the link survives it', async () => {
    const id = await dispatched();
    const token = await mint(id, 'response');

    const refused = await choose(token);
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain('name="option"');

    expect((await choose(token, 'cognizance')).status).toBe(200);
  });

  it('9. spends the link exactly once', async () => {
    const id = await dispatched();
    const token = await mint(id, 'response');

    expect((await choose(token, 'cognizance')).status).toBe(200);

    const twice = await choose(token, 'fire_deploy');
    const page = await twice.text();
    expect(page).toContain('Already recorded');

    /** And the second, contradicting answer went nowhere near the record. */
    const after = await state(id);
    expect(after.notifications.some((n) => n.said === 'Deploying Relevant Staff / Team')).toBe(
      false,
    );
  });

  it('10. ignores an option this version does not know', async () => {
    const id = await dispatched();
    const token = await mint(id, 'response');

    const refused = await choose(token, 'not_an_option_at_all');
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain('name="option"');
  });

  /**
   * ⚠️ A meeting's three answers are approved at Meta as quick replies and attendance owns them.
   * Drawing a second, unapproved set of options beside them is how two counts of *who is coming*
   * start disagreeing.
   */
  it('11. offers no options at all for a meeting', async () => {
    const id = await dispatched({ kind: 'meeting', category: 'other' });
    const page = await get(await mint(id, 'acknowledge'));

    expect(page).toContain('Acknowledged');
    expect(page).not.toContain('name="option"');
  });

  it('12. says the district’s closing sentence exactly as they wrote it', async () => {
    const id = await dispatched();
    const page = await (await choose(await mint(id, 'response'), 'cognizance')).text();

    // The apostrophe and the spacing are theirs. `ackPage` escapes for HTML, so compare the
    // fragment that survives escaping unchanged rather than the whole sentence.
    expect(page).toContain('Thank you for your response.');
    expect(page).toContain('District Nerve Center at 0000-000000');
    expect(RESPONSE_THANKS).toContain('Thank you for your response.');
  });
});
