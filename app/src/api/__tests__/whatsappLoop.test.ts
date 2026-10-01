/**
 * The WhatsApp loop, end to end against real PostgreSQL — M6-18…M6-24, ADR-0014.
 *
 * The provider is stubbed and **nothing else is**: real events, real fold, real webhook route
 * with a real HMAC, real single-use tokens. What is being proved is the ledger's behaviour, and
 * the four assertions that matter all say the same thing in different ways — **the system never
 * claims somebody was told when nothing established it.**
 *
 *   * Meta accepting a message leaves the attempt `pending`. An HTTP 200 from a datacentre is
 *     not an officer knowing about an emergency.
 *   * A `read` receipt settles nothing, ever. An officer with read receipts disabled never
 *     produces one, so a board built on blue ticks manufactures invisible failures at exactly
 *     the rate officers value their privacy.
 *   * The acknowledge tap **is** the thing that meets the obligation, and it works for an
 *     officer with no account — which is most of the district's directory.
 *   * A rate limit is not a failure, and the next pass tries again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { runNotifyPass } from '../../jobs/notify.js';
import { whatsappChannel } from '../../jobs/whatsappChannel.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident, type NotificationAttempt } from '../../domain/incident.js';
import type { WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  // Off, as it is in production until Meta approves a template with a media header (M9-17).
};

/**
 * What the URL button actually carries, read out of the sent body rather than matched in it.
 *
 * These tests used to assert `sentBodies[0]).toContain('https://dnc.example.invalid/ack/')`,
 * which passed for as long as the bug existed: the code was sending a whole URL as the button
 * parameter, and the assertion was written against the code rather than against the template
 * Meta had approved. Meta **appends** that parameter to the approved prefix, so what an officer
 * received was `https://<template-host>/ack/https://dnc.example.invalid/ack/<token>` — a link
 * whose host is the template's, resolving nowhere. The send returned 200, the message was
 * delivered, and nothing anywhere recorded a fault.
 *
 * The same shape as the `dashboard.test.ts` fixture that encoded the seatless-caller bug: a
 * test that asserts what the code does proves only that the code does it.
 */
function ackParameter(body: string): string {
  const sent = JSON.parse(body) as {
    template: {
      components: readonly {
        type: string;
        parameters: readonly { text: string }[];
      }[];
    };
  };
  const button = sent.template.components.find((c) => c.type === 'button');
  return button?.parameters[0]?.text ?? '';
}

describe.skipIf(dbUrl === undefined)('the WhatsApp loop (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let rescueDept: string;
  let rescueSeat: string;
  let rescuePerson: string;

  /** What the stubbed provider does next, and what it was asked to send. */
  let nextReply: { status: number; body: unknown };
  let sentUrls: string[];
  let sentBodies: string[];

  const stubFetch = (async (_url: string, init?: { body?: string }) => {
    sentUrls.push(String(_url));
    sentBodies.push(init?.body ?? '');
    return new Response(JSON.stringify(nextReply.body), { status: nextReply.status });
  }) as unknown as typeof fetch;

  const channel = (): ReturnType<typeof whatsappChannel> =>
    whatsappChannel({
      pool,
      config,
      publicOrigin: 'https://dnc.example.invalid',
      fetchImpl: stubFetch,
    });

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    /**
     * The **stubbed** channel is injected, not the config.
     *
     * A dispatch runs the notify pass before it answers (M6-04), so the server sends through
     * WhatsApp itself — and given only a config it would build a channel around the real
     * `fetch`, reach for `example.invalid`, and record a failure before this file's own pass
     * ever ran. That is the same seam `SchedulerOptions.channel` already offers, for the same
     * reason: a test needs a provider that answers on demand.
     */
    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      get whatsappChannel() {
        // Late-bound: `pool` is assigned above but the closure has to read `stubFetch`'s
        // captured state at send time rather than at construction.
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (wa ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (wa ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (wa ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (wa ${RUN})`,
      departmentId: rescueDept,
    });
    rescueSeat = duty.seatId;
    // The **holder** of that post, kept so this suite can dispatch to a named officer rather
    // than to their designation — which is what the picker now offers by default (M10-07/08/09)
    // and is the shape the acknowledgement defect of 2026-08-17 lived in.
    rescuePerson = duty.personId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  beforeAll(() => {
    sentUrls = [];
    sentBodies = [];
  });

  async function reportAndDispatch(
    /**
     * Who to tell. Defaults to the **post**, which is what every test here asked for before
     * 2026-08-17 — and is exactly why none of them could see that telling the *person* who holds
     * that same post recorded no acknowledgement at all.
     */
    target: { kind: 'post' | 'person'; id: string } = {
      kind: 'post',
      id: rescueSeat,
    },
  ): Promise<string> {
    sentUrls = [];
    sentBodies = [];

    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        /**
         * **A category nothing else in the suite reaches for, and that is the fix for O-08's
         * three.**
         *
         * This said `'fire'`, and every one of the three long-standing order-dependent failures
         * in this file came from it. Intake used to run an automatic routing pass; when some
         * **other** suite had left a signal matching `fire` in the shared test database, the
         * incident was routed before this test dispatched anything, the notify pass sent to
         * that department's duty seat as well, and:
         *
         *   * `sentBodies[0]` was somebody else's message, so the acknowledge test tapped the
         *     wrong token and left its own attempt pending;
         *   * the retry test counted 4 attempts where it expected 2;
         *   * the no-retry test counted 2 where it expected 1.
         *
         * Every one of them was the same defect as `dailyReport.test.ts`'s test 3: **a test
         * asserting on configuration it does not own.** A per-run category cannot be matched by
         * a signal nobody wrote, so this suite now depends only on what it sets up itself.
         *
         * It is not a fix for the shared database — that is still the real problem, and it is
         * still O-08. It is a fix for this file's dependence on it.
         */
        body: JSON.stringify({
          category: `wa-${RUN}`,
          severity: 'high',
          description: `wa ${RUN}`,
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [target] }),
    });

    return created.incidentId;
  }

  const attempts = async (incidentId: string): Promise<NotificationAttempt[]> => {
    const events = await loadIncident(pool, incidentId);
    return [...foldIncident(incidentId, events).notifications];
  };

  const wa = async (incidentId: string): Promise<NotificationAttempt | undefined> =>
    (await attempts(incidentId)).find((a) => a.channel === 'whatsapp');

  async function webhook(body: unknown, secret = config.appSecret): Promise<number> {
    const raw = JSON.stringify(body);
    const signature = `sha256=${createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex')}`;

    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    return res.status;
  }

  function statusEvent(id: string, status: string): unknown {
    return { entry: [{ changes: [{ value: { statuses: [{ id, status }] } }] }] };
  }

  //--------------------------------------------------------------------------
  // Sending
  //--------------------------------------------------------------------------

  it('sends a templated message and leaves the attempt pending', async () => {
    nextReply = { status: 200, body: { messages: [{ id: `wamid.${RUN}.1` }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    expect(sentUrls[0]).toContain('/999/messages');
    // A template, because outside a 24-hour window opened by the recipient replying, Meta
    // permits nothing else — and every alert this district sends is the first message of a
    // conversation at 02:00.
    expect(sentBodies[0]).toContain('"type":"template"');
    expect(sentBodies[0]).toContain('district_message');
    /**
     * The acknowledge button carries the **token and nothing else**.
     *
     * The origin lives in the approved template (ADR-0017 — the district's own domain, never
     * an office IP no handset in Bajaur can resolve), and Meta appends this parameter to it.
     * A parameter containing `://` is the 2026-08-12 dead link: the officer is sent to the
     * template's host with our URL as the path, and every part of the system reports success.
     */
    const ack = ackParameter(sentBodies[0] ?? '');
    expect(ack).not.toContain('://');
    expect(ack).toMatch(/^[A-Za-z0-9_-]+$/);

    // **Accepted is not delivered.** The attempt stays open until a webhook or a tap.
    expect((await wa(id))?.state).toBe('pending');
  });

  it('sends an advisory through the same template, the same way, answerable the same way', async () => {
    /**
     * M7-23, M7-24, M7-25 in one test, because they are one decision.
     *
     * An advisory, an alert and an order are the same act as an emergency: the control room
     * writes something down and chooses who should know. A second path for them would mean a
     * second ledger, a second acknowledgement route and two answers to *"who was told?"* —
     * and the district would then have to remember which screen a message went out from.
     *
     * The template is the load-bearing half. The body used to say `Location: {{2}}`, which
     * would have made **one word of fixed text** force a second submission to Meta and a
     * second approval queue for every kind that is not an emergency.
     */
    nextReply = { status: 200, body: { messages: [{ id: `wamid.${RUN}.adv` }] } };
    sentUrls = [];
    sentBodies = [];

    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category: 'advisory',
          severity: 'low',
          description: `Khar Road closed for repairs until Friday (wa ${RUN})`,
          kind: 'advisory',
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });

    // The same template name, so the district submits one thing to Meta and waits once.
    expect(sentBodies[0]).toContain('district_message');
    // The kind is the **subject line**, not a different message. An officer with four kinds
    // arriving on one lock screen has to be able to tell them apart at a glance, or they
    // learn to treat all four the same and the one that mattered goes unread.
    expect(sentBodies[0]).toContain('ADVISORY');
    // And it is answerable exactly like an emergency — same link, same ledger (M7-25).
    expect(ackParameter(sentBodies[0] ?? '')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await wa(created.incidentId))?.state).toBe('pending');
  });

  it('is the only channel — one obligation, one message, one record', async () => {
    /**
     * This test used to say *"sends beside the inbox, not instead of it"*, and asserted two
     * channels for one obligation. **The inbox is gone (ADR-0018)**: nobody outside the
     * control room signs in, so an in-app copy was a message addressed to a door with
     * nobody behind it.
     *
     * The assertion is inverted rather than deleted, because the number it pins is the one
     * that goes wrong quietly. Two attempts for one obligation is two buzzes on one handset
     * at 02:00, and it is also two rows the "who was told" panel has to agree about. Every
     * time a second channel has been added here it has arrived as a duplicate first.
     *
     * Still not a ladder. ADR-0012 built one so delivery would always *succeed*; this is one
     * channel so delivery is always *known*.
     */
    nextReply = { status: 200, body: { messages: [{ id: `wamid.${RUN}.2` }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    const channels = (await attempts(id))
      .filter((a) => a.reason === 'dispatched')
      .map((a) => a.channel)
      .sort();

    expect(channels).toEqual(['whatsapp']);
  });

  //--------------------------------------------------------------------------
  // The four states — M6-21
  //--------------------------------------------------------------------------

  it('settles on delivered, and never on read', async () => {
    const providerId = `wamid.${RUN}.3`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    expect(await webhook(statusEvent(providerId, 'sent'))).toBe(200);
    expect((await wa(id))?.state).toBe('pending');

    expect(await webhook(statusEvent(providerId, 'delivered'))).toBe(200);
    expect((await wa(id))?.state).toBe('delivered');
  });

  it('carries read without letting it meet the obligation', async () => {
    /**
     * ADR-0014's sharpest line, and the one most likely to be "fixed" by somebody later. An
     * officer who has disabled read receipts never produces one — so a dashboard built on blue
     * ticks manufactures invisible failures at exactly the rate officers value their privacy.
     */
    const providerId = `wamid.${RUN}.4`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    expect(await webhook(statusEvent(providerId, 'read'))).toBe(200);

    // The message row knows. The ledger does not, and the obligation is still open.
    const row = await pool.query<{ status: string }>(
      'SELECT status FROM whatsapp_message WHERE provider_message_id = $1',
      [providerId],
    );
    expect(row.rows[0]?.status).toBe('read');
    expect((await wa(id))?.state).toBe('pending');
  });

  it('does not walk a message backwards when webhooks arrive out of order', async () => {
    // Three separate webhooks over an unordered channel. A `sent` landing after a `delivered`
    // must not un-deliver it — a screen reading "delivered, then sent again" is one the
    // district would be right to stop believing.
    const providerId = `wamid.${RUN}.5`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    await webhook(statusEvent(providerId, 'delivered'));
    await webhook(statusEvent(providerId, 'sent'));

    expect((await wa(id))?.state).toBe('delivered');
    // And the second webhook appended nothing: one delivery, not two.
    const delivered = (await attempts(id)).filter(
      (a) => a.channel === 'whatsapp' && a.state === 'delivered',
    );
    expect(delivered).toHaveLength(1);
  });

  it('records a provider failure with Meta’s own words', async () => {
    const providerId = `wamid.${RUN}.6`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    await webhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: providerId,
                    status: 'failed',
                    errors: [{ title: 'Message undeliverable', code: 131_026 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const attempt = await wa(id);
    expect(attempt?.state).toBe('failed');
    expect(attempt?.failure).toContain('Message undeliverable');
  });

  //--------------------------------------------------------------------------
  // The perimeter — M6-20
  //--------------------------------------------------------------------------

  it('refuses a webhook whose signature does not verify, and changes nothing', async () => {
    const providerId = `wamid.${RUN}.7`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    // This is the entire perimeter of the one endpoint with no session behind it. Anybody able
    // to forge one could mark every obligation in Bajaur as met, and the board would go quiet
    // on a night when nothing was delivered at all.
    expect(await webhook(statusEvent(providerId, 'delivered'), 'the-wrong-secret')).toBe(401);
    expect((await wa(id))?.state).toBe('pending');
  });

  it('answers Meta’s subscription handshake only for the right verify token', async () => {
    const ok = await fetch(
      `${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=42`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('42');

    const bad = await fetch(
      `${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
    );
    expect(bad.status).toBe(403);
  });

  //--------------------------------------------------------------------------
  // The acknowledge tap — M6-22, and it is what meets the obligation
  //--------------------------------------------------------------------------

  it('acknowledges the incident from one tap, and settles every attempt it was owed', async () => {
    const providerId = `wamid.${RUN}.8`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    // The token as Meta receives it, then the URL an officer's handset actually opens — the
    // template's prefix plus that token. Building it here rather than matching it in the body
    // is the point: this is the join the dead link of 2026-08-12 got wrong.
    const token = ackParameter(sentBodies[0] ?? '');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const tapped = await fetch(`${base}/ack/${token}`);
    expect(tapped.status).toBe(200);
    expect(await tapped.text()).toContain('Acknowledged');

    const events = await loadIncident(pool, id);
    const state = foldIncident(id, events);

    // The obligation is met, by a deliberate act (ADR-0014).
    expect(state.acknowledgedAt).not.toBeNull();

    /**
     * **And every attempt against that obligation is settled**, not just the one that carried
     * the link.
     *
     * When this was written the second attempt was the in-app inbox, and that channel is gone
     * (ADR-0018). The rule it established is not, and the cases that produce a sibling attempt
     * have if anything grown: a `manual` attempt recorded while the district had no WhatsApp
     * account, and — M7-05 — an operator recording what an officer told them on the telephone.
     *
     * An officer who tapped the link has demonstrably been reached, and leaving a sibling open
     * would be a failure the system **invented**. INV-03 exists to make real failures visible,
     * not to manufacture them; a district that learns to ignore the unmet count has lost the
     * number that matters at 02:00.
     */
    const dispatched = state.notifications.filter((a) => a.reason === 'dispatched');
    expect(dispatched.every((a) => a.state === 'delivered')).toBe(true);
  });

  it('acknowledges when the officer was told BY NAME, not only when their post was', async () => {
    /**
     * **The defect the district reported on 2026-08-17, and it made the acknowledge button
     * useless in practice.**
     *
     * A dispatch to a named officer carries `personId` and **no seat** — `obligationsFor` builds
     * it that way because the control room chose *them*, not their designation. Every
     * acknowledgement path then read that null as *this officer holds no post* and stopped short
     * of appending an `acknowledged` event, quoting ADR-0004 while doing it. The rule was right;
     * the question was wrong. The null meant **nobody had looked**.
     *
     * The consequence was not cosmetic. The board went on saying *unacknowledged*, the
     * dashboard's counter went on counting it, and `escalation.ts`'s candidate query — which
     * selects on `NOT EXISTS (type = 'acknowledged')` — went on escalating over the head of the
     * officer who had already answered, for the rest of the district day. Meanwhile the page the
     * officer was looking at said *"the control room can see that you have this"*.
     *
     * ⚠️ **It only became the normal case on 2026-08-16.** M10-07/08/09 made the person row the
     * one row the picker draws for a reachable officer, so from that day almost every dispatch in
     * Bajaur was person-kinded. Before it, an operator ticking the post hit the working path — which
     * is what every other test in this file does, and why 1321 of them stayed green over it.
     *
     * The officer here **holds `rescueSeat`**, which is the whole distinction: this is not the
     * post-less officer of `acknowledgement.test.ts`, whose refusal is deliberate and still holds.
     */
    const providerId = `wamid.${RUN}.byname`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch({ kind: 'person', id: rescuePerson });
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    const token = ackParameter(sentBodies[0] ?? '');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const tapped = await fetch(`${base}/ack/${token}`);
    expect(tapped.status).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));

    // The one assertion this test exists for. It read `null` before the fix.
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedVia).toBe('link');

    /**
     * **Attributed to the post the officer holds**, resolved when the link was *minted* rather
     * than when it was tapped (`whatsappChannel.ts`). A handover in between must not move the
     * acknowledgement onto whoever holds the post at the later moment — the same rule
     * `mintAckToken` already states for the seat it was given.
     */
    expect(state.acknowledgedBySeatId).toBe(rescueSeat);

    // And the ledger still says what it always said. The obligation and the incident's clock are
    // two different facts and this change must not have merged them.
    expect((await wa(id))?.state).toBe('delivered');
  });

  it('acknowledges from a tap even when the officer holds no post at all', async () => {
    /**
     * **The owner's reversal of 2026-08-17, on the door most officers actually use.**
     *
     * Its sibling in `acknowledgement.test.ts` covers the control room's telephone record; this
     * one covers the tap, and the pair exists because the two must never disagree about what an
     * acknowledgement means. Both used to refuse a post-less officer on ADR-0004 grounds. The
     * control room chose them, so the refusal was software overruling the district.
     *
     * `acknowledgedBySeatId` is null here and `personId` carries the attribution — the shape the
     * `acknowledged` payload has always allowed.
     */
    const contact = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, NULL) RETURNING person_id`,
      [`Directory Officer (wa ${RUN})`, `+92305${randomUUID().slice(0, 8)}`],
    );
    const seatless = contact.rows[0]!.person_id;

    nextReply = { status: 200, body: { messages: [{ id: `wamid.${RUN}.nopost` }] } };

    const id = await reportAndDispatch({ kind: 'person', id: seatless });
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    const token = ackParameter(sentBodies[0] ?? '');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((await fetch(`${base}/ack/${token}`)).status).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));

    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedVia).toBe('link');
    // Nobody to name a post for, so none is named. The officer is on the payload instead.
    expect(state.acknowledgedBySeatId).toBeNull();
    expect((await wa(id))?.state).toBe('delivered');
  });

  it('spends an acknowledge link exactly once, and says so plainly the second time', async () => {
    const providerId = `wamid.${RUN}.9`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });
    void id;

    const token = ackParameter(sentBodies[0] ?? '');

    expect((await fetch(`${base}/ack/${token}`)).status).toBe(200);

    // A link that works twice acknowledges an incident again a week later, out of somebody's
    // message history. And "already acknowledged" is a different sentence from "invalid",
    // because they send an officer to different next actions.
    const second = await fetch(`${base}/ack/${token}`);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Already acknowledged');
  });

  it('does not recognise a token that was never minted', async () => {
    const res = await fetch(`${base}/ack/${'x'.repeat(43)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not recognised');
  });

  //--------------------------------------------------------------------------
  // Rate limits — M6-24
  //--------------------------------------------------------------------------

  it('treats a rate limit as retryable and sends on the next pass', async () => {
    /**
     * A new number is capped by Meta until its usage earns the tier up. Recording that as a
     * failure would mean `alreadyAttempted` never trying again — a ninety-second cap turned
     * into an emergency nobody was ever told about, on the district's own board.
     */
    nextReply = { status: 429, body: { error: { message: 'rate limit hit', code: 130_429 } } };

    // The dispatch itself sends (M6-04), so the first attempt is already in the log here — no
    // explicit pass, or this test would count a third.
    const id = await reportAndDispatch();

    const first = await wa(id);
    expect(first?.state).toBe('failed');
    expect(first?.retryable).toBe(true);

    nextReply = { status: 200, body: { messages: [{ id: `wamid.${RUN}.10` }] } };
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    // A second attempt, with its own id — which is what actually happened, and the district can
    // see there were two.
    const all = (await attempts(id)).filter((a) => a.channel === 'whatsapp');
    expect(all).toHaveLength(2);
    expect(all.some((a) => a.state === 'pending')).toBe(true);
  });

  it('does not retry a refusal no retry can fix', async () => {
    // An unapproved template will never accept any message. Retrying it is a notification
    // storm aimed at a wall (INV-08).
    nextReply = {
      status: 400,
      body: { error: { message: 'Template name does not exist', code: 132_001 } },
    };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    expect((await attempts(id)).filter((a) => a.channel === 'whatsapp')).toHaveLength(1);
  });

  //--------------------------------------------------------------------------
  // Replies — M6-23
  //--------------------------------------------------------------------------

  it('lands a reply on the incident, says the match is inferred, and meets the obligation', async () => {
    const providerId = `wamid.${RUN}.11`;
    nextReply = { status: 200, body: { messages: [{ id: providerId }] } };

    const id = await reportAndDispatch();
    await runNotifyPass(pool, { incidentIds: [id], whatsapp: channel() });

    const to = await pool.query<{ to_phone: string }>(
      'SELECT to_phone FROM whatsapp_message WHERE provider_message_id = $1',
      [providerId],
    );

    await webhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: to.rows[0]!.to_phone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    text: { body: 'crew on the way' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const state = foldIncident(id, await loadIncident(pool, id));
    const note = state.actions.map((a) => a.note).join('\n');

    expect(note).toContain('crew on the way');
    // The match is a guess — an officer told about two emergencies ten minutes apart who
    // replies "on my way" is answering one of them, and nothing in the message says which.
    expect(note).toContain('inferred');

    // A reply is a deliberate act by the person who was owed the message, which is exactly
    // what ADR-0014 names as the thing that counts — unlike a read receipt.
    expect((await wa(id))?.state).toBe('delivered');

    /**
     * **And it stops the incident's clock — the owner's instruction, 2026-08-17.**
     *
     * This assertion is new and the line above it is not, which is the shape of the defect: the
     * ledger was settled and the incident was **not** acknowledged, so an officer who typed
     * *"crew on the way"* left the emergency on the board as unanswered and escalating. ADR-0014
     * named three deliberate acts that meet an obligation — the tap, the in-app acknowledgement
     * and a reply — and only two of them had ever been built.
     *
     * `route: 'reply'` is asserted beside it deliberately. The match from a number to an incident
     * is an **inference** (see the note this test already makes about it), and it now stops an
     * SLA clock — so the record has to keep saying which of the three routes this was. M7-30's
     * rule stands: never add the routes together in a report.
     */
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedVia).toBe('reply');
    // The officer's own words, so the board shows what they said and not merely that they spoke.
    expect(state.acknowledgedSaid).toBe('crew on the way');
  });
});
