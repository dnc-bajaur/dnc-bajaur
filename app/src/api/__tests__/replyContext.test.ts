/**
 * The reply lands on the emergency it answers — 2026-08-21.
 *
 * ## What was wrong, and it was never a bug
 *
 * Since M6-23 every inbound has been matched to an incident by **the most recent alert sent to
 * that number**, and the code says in three places that the match is a guess. It has to be, for a
 * typed *"on my way"* that names nothing — `lastMessageTo`'s own comment makes the argument
 * properly and it is right.
 *
 * **What was wrong is that WhatsApp answers the question exactly, and nothing was reading it.**
 * An officer who uses the reply control gets `context.id` on the webhook, naming the message they
 * answered, and that id is this district's own `provider_message_id`. The guess was being made
 * beside a fact.
 *
 * ## The test that matters
 *
 * Two emergencies to one handset ten minutes apart, and the officer answers the **first**. Under
 * the guess that reply lands on the second — the one nobody has been to yet — stopping its clock
 * and leaving the real one running. It is the same shape as the sharpest test in
 * `lifecycleInWhatsApp.test.ts`, arriving one door along.
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

describe.skipIf(dbUrl === undefined)('matching a reply to what it answers (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  /**
   * Every id this stub hands out, in the order Meta issued them.
   *
   * ⚠️ **Unique per send, and that is not decoration.** `lifecycleInWhatsApp.test.ts` minted them
   * from an array length that was emptied between tests, two alerts went out carrying the same
   * `wamid`, `recordSent`'s `ON CONFLICT DO NOTHING` left the second with no row at all, and
   * three tests went red pointing at a feature that was working. This file's whole subject is
   * which message an id names, so a colliding id would make it prove nothing.
   */
  let outbound = 0;
  const sentIds: string[] = [];

  const stubFetch = (async () => {
    outbound += 1;
    const id = `wamid.${RUN}.${outbound}`;
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
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (ctx ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (ctx ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (ctx ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (ctx ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;

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

  /** An emergency, told to one named officer, actually sent. Returns it and the id Meta gave. */
  async function raise(what: string): Promise<{ incidentId: string; wamid: string }> {
    const before = sentIds.length;

    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category: `ctx-${RUN}`,
          severity: 'high',
          description: what,
        }),
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
    return { incidentId: created.incidentId, wamid: wamid! };
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

  function typed(body: string, contextId?: string): unknown {
    return {
      from: officerPhone,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body },
      ...(contextId === undefined ? {} : { context: { id: contextId } }),
    };
  }

  async function acknowledgedAt(incidentId: string): Promise<string | null> {
    return foldIncident(incidentId, await loadIncident(pool, incidentId)).acknowledgedAt;
  }

  async function notesOn(incidentId: string): Promise<string> {
    return (await loadIncident(pool, incidentId))
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note)
      .join('\n');
  }

  /**
   * 🔴 **The sharpest test in this file, and the reason the change exists.**
   *
   * Two emergencies, ten minutes apart in real life and one after the other here. The officer
   * uses WhatsApp's reply control on the **first**. Under the old rule the reply is matched to
   * the most recent alert — so it lands on the **second**, stops that clock, and leaves the
   * emergency somebody actually answered running unanswered all day.
   */
  it('lands on the emergency the officer replied to, not the most recent one', async () => {
    const first = await raise('road accident on the bypass');
    const second = await raise('smoke near the canal');

    expect(await inbound(typed('on my way', first.wamid))).toBe(200);

    expect(await acknowledgedAt(first.incidentId)).not.toBeNull();
    // The one nobody has been to yet is untouched. This is the assertion that fails without the
    // change, and it fails by acknowledging exactly the wrong emergency.
    expect(await acknowledgedAt(second.incidentId)).toBeNull();
  });

  /**
   * **The record says which claim it is making.**
   *
   * *The officer replied to this message* and *this was the last thing we sent that number* are
   * evidence of different strength, and M7-30's rule is that two such claims are never worded the
   * same. A reader must not have to guess which one they are looking at.
   */
  it('says the match is exact, and says it is inferred when it is', async () => {
    const named = await raise('vehicle overturned near the bridge');
    expect(await inbound(typed('reached', named.wamid))).toBe(200);
    expect(await notesOn(named.incidentId)).toContain('the match is exact');

    const guessed = await raise('wall collapsed in the bazaar');
    expect(await inbound(typed('on it'))).toBe(200);
    expect(await notesOn(guessed.incidentId)).toContain('the match is inferred');
  });

  /**
   * **A context naming nothing we sent falls back rather than failing.**
   *
   * An officer can use the reply control on **their own** earlier message, and Meta reports that
   * identically. There is no row for it, and the honest answer is the guess this district has
   * been living with — never a dropped reply.
   */
  it('falls back to the guess when the context names a message we did not send', async () => {
    const incident = await raise('power lines down at the chowk');

    expect(await inbound(typed('checking now', 'wamid.SOMETHING_THE_OFFICER_SENT'))).toBe(200);

    expect(await acknowledgedAt(incident.incidentId)).not.toBeNull();
    expect(await notesOn(incident.incidentId)).toContain('the match is inferred');
  });

  /**
   * ⚠️ **A context naming a message sent to a DIFFERENT number is refused.**
   *
   * The id is chosen by whoever is sending, and this endpoint is public — a signature proves the
   * webhook is *Meta's*, never that it is *this officer's*. Accepting it unchecked would let one
   * handset acknowledge an emergency somebody else was told about. Refusing it falls back to the
   * guess, which is where the district already was: never worse.
   */
  it('refuses a context naming a message sent to somebody else', async () => {
    const theirs = await raise('gas leak reported on the ring road');

    // A second handset that was never told about `theirs`, answering with its id.
    const other = await seedActor(pool, {
      title: `Other Officer (ctx ${RUN})`,
      departmentId: await seedDepartment(pool, `Other Dept (ctx ${RUN})`),
    });
    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [other.personId],
    );

    const raw = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: row.rows[0]?.phone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'I have this' },
                    context: { id: theirs.wamid },
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
    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    expect(res.status).toBe(200);

    // The emergency that officer was never told about is untouched. Nothing was told to that
    // second number at all, so the fallback finds nothing and the reply is correctly dropped.
    expect(await acknowledgedAt(theirs.incidentId)).toBeNull();
  });
});
