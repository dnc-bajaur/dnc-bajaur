/**
 * A category alert answers on its own `dnc_response_<category>` template — ADR-0034, 2026-09-03.
 *
 * End to end against real PostgreSQL and the real webhook route, Meta stubbed. What is proved is
 * the district's own workflow: a fire alert goes out on `dnc_response_fire_v1` — three quick
 * replies, **no *Acknowledge* button and no link** — and the officer's first tap on one of the
 * three is their response. The clock stops, the incident moves to Responded (or Resolved), and
 * the district's closing sentence comes back.
 *
 * The four assertions that matter:
 *
 *   * **A switched-on category goes out on its own template**, with no button component.
 *   * **A tap on one of its three labels moves the emergency** — Responded, or Resolved for the
 *     "already done" label — not the uninterpreted acknowledgement it was before this change.
 *   * **The first tap still acknowledges.** There is no separate acknowledge step on these
 *     templates, so the tap has to do both.
 *   * **A category the district has NOT switched on is untouched** — it still answers on
 *     `district_emergency_v2`, and a tap on that template's label is not read as a response.
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
import { RESPONSE_THANKS } from '../../domain/acknowledgementThanks.js';
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
  /** Named, so a category that is NOT switched on still gets a tappable template to contrast with. */
  emergencyTemplate: { name: 'district_emergency_v2', language: 'en' },
  /** `security` is deliberately left out — its `_v2` was PENDING at Meta when this shipped. */
  responseCategories: new Set(['fire', 'medical']),
};

describe.skipIf(dbUrl === undefined)('a category alert answers on its own template', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  let sent: { url: string; body: string }[];
  /**
   * A monotonic id, never `sent.length` — the tests reset `sent` between them, and a
   * `provider_message_id` that restarts at 0 collides with an earlier alert's, whose
   * `recordSent` then silently drops the new row on `ON CONFLICT DO NOTHING`. `lastMessageTo`
   * then matches a stale incident. This repository has paid for that exact trap once already.
   */
  let wamidSeq = 0;

  const stubFetch = (async (url: string, init?: { body?: string }) => {
    sent.push({ url: String(url), body: init?.body ?? '' });
    wamidSeq += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${wamidSeq}` }] }), {
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
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    sent = [];

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
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (resp ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (resp ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (resp ${RUN})`);
    const deo = await seedActor(pool, { title: `DEO (resp ${RUN})`, departmentId: rescue });
    officerPerson = deo.personId;

    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [officerPerson],
    );
    officerPhone = row.rows[0]?.phone ?? '';
    expect(officerPhone).not.toBe('');
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** An emergency of a given category, told to one named officer, actually sent. */
  async function sendEmergency(category: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category,
          severity: 'high',
          kind: 'emergency',
          description: `${category} at grid ${RUN}`,
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officerPerson }] }),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });
    return created.incidentId;
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

  const tap = (label: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    button: { text: label, payload: label },
  });

  const templateName = (body: string): string | undefined =>
    (JSON.parse(body || '{}') as { template?: { name?: string } }).template?.name;

  const hasButton = (body: string): boolean =>
    (
      (JSON.parse(body || '{}') as { template?: { components?: { type?: string }[] } }).template
        ?.components ?? []
    ).some((c) => c.type === 'button');

  const status = async (id: string): Promise<string> =>
    foldIncident(id, await loadIncident(pool, id)).status;

  it('sends a switched-on fire alert on dnc_response_fire_v1, with no button', async () => {
    await sendEmergency('fire');

    const fire = sent.find((s) => templateName(s.body) === 'dnc_response_fire_v1');
    expect(fire, 'a fire alert should go out on its own template').toBeDefined();
    expect(hasButton(fire?.body ?? '')).toBe(false);
  });

  it('reads the first tap as an acknowledgement AND a response, and closes the workflow', async () => {
    const id = await sendEmergency('fire');
    sent = [];

    expect(await inbound(tap('Fire Team Dispatched'))).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));
    // The first tap stops the clock — there is no separate acknowledge step on this template.
    expect(state.acknowledgedAt).not.toBeNull();
    // ...and it moves the emergency, because the tap is the response.
    expect(state.status).toBe('responding');

    // The officer's exact words are on the record.
    const notes = (await loadIncident(pool, id))
      .filter((e) => e.type === 'action_logged')
      .map((e) => String((e.payload as { note?: unknown }).note ?? ''));
    expect(notes.some((n) => n.includes('Fire Team Dispatched'))).toBe(true);

    // And the district's closing sentence comes back — three taps, then thank you.
    const back = sent.map((s) => JSON.parse(s.body || '{}') as { text?: { body?: string } });
    expect(back.some((m) => m.text?.body === RESPONSE_THANKS)).toBe(true);
  });

  it('resolves the emergency on the "already done" label', async () => {
    sent = [];
    const id = await sendEmergency('medical');
    expect(
      sent.find((s) => templateName(s.body) === 'dnc_response_medical_v1'),
      'the medical alert should have gone out on its own template',
    ).toBeDefined();

    expect(await inbound(tap('Aid Already Provided'))).toBe(200);

    expect(await status(id)).toBe('resolved');
    const events = await loadIncident(pool, id);
    expect(events.some((e) => e.type === 'resolved')).toBe(true);
  });

  it('leaves a category the district has not switched on exactly as it was', async () => {
    const id = await sendEmergency('security');

    // `security` is not in `responseCategories`, so it still goes out on the ordinary tappable
    // template — with its Acknowledge quick reply and its link.
    const out = sent.find((s) => templateName(s.body) === 'district_emergency_v2');
    expect(out, 'security should still use district_emergency_v2').toBeDefined();

    // And a tap on the response template's own label means nothing here — it is not one of that
    // template's buttons, so it lands as a plain first reply: acknowledged, not resolved.
    sent = [];
    expect(await inbound(tap('Security Deployed'))).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.status).not.toBe('resolved');
  });
});
