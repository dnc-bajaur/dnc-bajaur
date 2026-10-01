/**
 * **An officer answers without typing, and the district answers back** — Phases 6 and 7,
 * 2026-08-21.
 *
 * ## Two gaps O-43 named and nobody had priced
 *
 * **(d) Location messages were dropped**, so *"where are you"* still needed the five-row list —
 * and the list can never carry what a pin carries. `present` is the honest answer when somebody
 * is working and nobody knows where; a pin says exactly where, and it was thrown away.
 *
 * **(e) Reactions were dropped** — *"a ✅ is the cheapest deliberate answer an officer can give
 * and it is invisible to us."* One long-press, no typing, no data worth speaking of, from a
 * moving vehicle at 02:00.
 *
 * Both were **an officer answering**, discarded before anything looked at them: the obligation
 * stayed open, the clock kept running, escalation climbed over their head, and the board carried
 * them for the rest of the district day as somebody nobody had reached. That is the same sentence
 * this repository has now written four times — the quick-reply tap on 19 August, the photograph on
 * 21 August, and these two.
 *
 * ## And the mirror of it, which is Phase 7
 *
 * Every one of those messages, once read, left **one grey tick in the officer's own thread**. This
 * system read it, recorded it, settled the obligation and often answered back, and never once said
 * *we have seen this* on the channel the officer was looking at. `markRead` is that, and it is a
 * **read receipt rather than a message**: no template, no service window, and nothing against
 * `TIER_250`.
 *
 * Real PostgreSQL, a real HMAC, the real webhook route. Only Meta is stubbed.
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
import { foldIncident } from '../../domain/incident.js';
import { type WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

interface ReadReceipt {
  readonly messaging_product: string;
  readonly status: string;
  readonly message_id: string;
}

describe.skipIf(dbUrl === undefined)('answering without typing (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  /**
   * Ids for messages **we** sent. Unique per send, and that is not decoration —
   * `lifecycleInWhatsApp.test.ts` once minted them from an array length that was emptied between
   * tests, two alerts went out carrying the same `wamid`, and three tests reddened pointing at a
   * feature that was working.
   */
  let outbound = 0;
  const sentIds: string[] = [];

  /** Every read receipt the district asked Meta for. Phase 7's only evidence. */
  let receipts: ReadReceipt[] = [];

  /** Set to fail the next receipt, to prove a refusal cannot cost the district its webhook. */
  let receiptStatus = 200;

  const stubFetch = (async (_url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(body) as { status?: string };

    /**
     * ⚠️ **A read receipt goes to the same URL as a message and must not be counted as one.**
     * Meta tells them apart by `status: 'read'` in the body and so does this stub — counting one
     * as a send would make `sentIds` name a receipt, and every match assertion in this file would
     * then be measuring the harness.
     */
    if (parsed.status === 'read') {
      receipts.push(JSON.parse(body) as ReadReceipt);
      return new Response(JSON.stringify(receiptStatus === 200 ? { success: true } : {}), {
        status: receiptStatus,
      });
    }

    outbound += 1;
    const id = `wamid.${RUN}.${String(outbound)}`;
    sentIds.push(id);
    return new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
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

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const dc = await seedDepartment(pool, `DC Office (gest ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (gest ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (gest ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (gest ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;
    officerPhone = duty.phone;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** An emergency, told to one named officer, actually sent. Returns it and the id Meta gave. */
  async function raise(what: string): Promise<{ incidentId: string; wamid: string }> {
    const before = sentIds.length;

    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: `gest-${RUN}`, severity: 'high', description: what }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officerPerson }] }),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });

    const wamid = sentIds[before];
    expect(wamid).toBeDefined();
    return { incidentId: created.incidentId, wamid: wamid as string };
  }

  async function inbound(message: unknown): Promise<number> {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    return res.status;
  }

  const from = (over: Record<string, unknown>): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    id: `wamid.theirs.${randomUUID().slice(0, 8)}`,
    ...over,
  });

  async function acknowledgedAt(incidentId: string): Promise<string | null> {
    return foldIncident(incidentId, await loadIncident(pool, incidentId)).acknowledgedAt;
  }

  async function notesOn(incidentId: string): Promise<string> {
    return (await loadIncident(pool, incidentId))
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note)
      .join('\n');
  }

  it('records a dropped pin on the incident, and it settles the obligation', async () => {
    const { incidentId } = await raise('smoke near the canal');

    expect(
      await inbound(
        from({
          type: 'location',
          location: {
            latitude: 34.7167,
            longitude: 71.5167,
            name: 'Khar Road',
            address: 'Bajaur',
          },
        }),
      ),
    ).toBe(200);

    const note = await notesOn(incidentId);
    // The handset's own words lead, because they are worth more to a control room than six
    // decimal places; the degrees follow for whoever has to type them into a map.
    expect(note).toContain('Shared their location on WhatsApp');
    expect(note).toContain('Khar Road');
    expect(note).toContain('34.716700');

    /**
     * 🔴 **The half that is not about words at all.** Dropping a pin is a deliberate act by the
     * person who was owed the message — ADR-0014's own test for what counts — so the clock stops.
     * Before this, that officer went on being chased and escalated over.
     */
    expect(await acknowledgedAt(incidentId)).not.toBeNull();
  });

  it('reads a ✅ and lands it on the message it was put on, exactly', async () => {
    const first = await raise('road accident on the bypass');
    const second = await raise('wall collapse at the school');

    // The officer reacts to the FIRST alert while the second is the most recent thing sent to
    // them. A reaction names its own subject, so there is nothing here to infer.
    expect(
      await inbound(from({ type: 'reaction', reaction: { message_id: first.wamid, emoji: '✅' } })),
    ).toBe(200);

    expect(await acknowledgedAt(first.incidentId)).not.toBeNull();
    // The one nobody has been to yet is untouched. Under the old guess this assertion fails by
    // acknowledging exactly the wrong emergency.
    expect(await acknowledgedAt(second.incidentId)).toBeNull();

    const note = await notesOn(first.incidentId);
    // Meta's own characters, and worded as a gesture rather than as a reply — nobody typed
    // anything, which is the distinction `tapped` already draws.
    expect(note).toContain('Reacted ✅');
    expect(note).not.toContain('Replied on WhatsApp');
    expect(note).toContain('the match is exact');
  });

  /**
   * 🔴 **THE LOAD-BEARING TEST OF THIS FILE.**
   *
   * Meta reports a reaction being **taken off** as the same message shape with an empty `emoji`.
   * The obvious implementation — `if (m.reaction) …` — reads that as an answer, which is not
   * merely wrong but **backwards**: it records an officer un-answering as though they had just
   * answered, at the exact moment they changed their mind. Nothing at all may happen.
   */
  it('changes nothing when a reaction is taken off again', async () => {
    const { incidentId, wamid } = await raise('flooding on the link road');
    const before = await notesOn(incidentId);

    expect(
      await inbound(from({ type: 'reaction', reaction: { message_id: wamid, emoji: '' } })),
    ).toBe(200);

    expect(await notesOn(incidentId)).toBe(before);
    expect(await acknowledgedAt(incidentId)).toBeNull();
  });

  it('marks the officer’s own message read, and never our own', async () => {
    receipts = [];
    const { wamid } = await raise('grid failure in the bazaar');

    const theirs = `wamid.theirs.${RUN}.read-me`;
    expect(await inbound(from({ id: theirs, type: 'text', text: { body: 'on my way' } }))).toBe(
      200,
    );

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: theirs,
    });

    /**
     * ⚠️ **Their message, never ours.** Reading `context.id` for this would mark the district's
     * own alert as read *by the district*, which is meaningless and untraceable — and it is one
     * character of a typo away in the handler.
     */
    expect(receipts[0]?.message_id).not.toBe(wamid);
  });

  it('still answers Meta 200 when the read receipt is refused', async () => {
    /**
     * A refusal here is **ordinary**: Meta will not mark a message read once it is a few days old,
     * and a webhook it retried across a deploy window can easily be that old.
     *
     * 🔴 **And the failure this pins is the expensive one.** A throw in the webhook handler is a
     * 500, and Meta retries a 500 **for hours** onto the machine that is also taking emergency
     * reports. A tick that did not appear costs an officer a moment's doubt; a retry storm costs
     * the district its server.
     */
    const { incidentId } = await raise('tree down on the main road');
    receiptStatus = 400;
    receipts = [];

    try {
      expect(await inbound(from({ type: 'text', text: { body: 'reached the scene' } }))).toBe(200);
    } finally {
      receiptStatus = 200;
    }

    expect(receipts).toHaveLength(1);
    // And the reply itself was recorded regardless, which is the property that must not move: a
    // courtesy failing may never cost an officer their acknowledgement.
    expect(await acknowledgedAt(incidentId)).not.toBeNull();
  });
});
