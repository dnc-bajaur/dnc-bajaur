/**
 * A meeting notice answered **after it was already delivered** — 2026-09-10.
 *
 * Every other test that taps a `district_notice_v2` button (`substitute.test.ts`,
 * `attendance.e2e.test.ts`) does it the instant the notice goes out, while the obligation is
 * still `pending`. That is not how the district works: Meta reports the handset received it,
 * the control room chases it twice, and only then does the officer tap. By that point the
 * attempt is `delivered`, and the code that recorded what a tap said behaved completely
 * differently — it wrote the `action_logged` note and **nothing else**.
 *
 * The district saw the result on DNC-BAJAUR-86: the tap showed in *Latest update* and nowhere
 * its answer belonged. *The response we received* read "No reply received yet", the attendance
 * tally counted the officer silent, and *Who was told* offered a "They confirmed / No answer"
 * recorder for a recipient who had answered.
 *
 * What these tests hold down:
 *
 *   * **A tap on a delivered obligation still lands `via` and `said` on the ledger row** — the
 *     thing `attendanceFor`, the confirmed count and *The response we received* all read.
 *   * **`Attending` is answered.** It asks no follow-up question, so it used to be answered with
 *     silence — a tap that, on a handset, looks like a message that failed to send.
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
import { attendanceFor, type AttendanceInput } from '../../domain/attendance.js';
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
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  /** Named, so a meeting goes out on the template whose three answers these tests tap. */
  noticeTemplate: { name: 'district_notice_v2', language: 'en' },
};

describe.skipIf(dbUrl === undefined)('a meeting answered after it was delivered', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  /** Every outbound body, from the channel and from the webhook, in order. */
  let sent: { url: string; body: string }[];
  /** Never `sent.length` — see the note in `lifecycleInWhatsApp.test.ts`. */
  let outbound = 0;

  const stubFetch = (async (url: string, init?: { body?: string }) => {
    outbound += 1;
    sent.push({ url: String(url), body: init?.body ?? '' });
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

    const dc = await seedDepartment(pool, `DC Office (mtg ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (mtg ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const line = await seedDepartment(pool, `Line Dept (mtg ${RUN})`);
    const officer = await seedActor(pool, { title: `AC HQ (mtg ${RUN})`, departmentId: line });
    officerPerson = officer.personId;

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

  /**
   * A meeting notice, told to one officer, sent, and then **delivered** — the state the real
   * district is in every time an officer taps: Meta has reported the handset received it and
   * the control room has had time to chase.
   */
  async function deliveredMeeting(subject: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category: `mtg-${RUN}`,
          severity: 'low',
          kind: 'meeting',
          description: subject,
          details: { subject },
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officerPerson }] }),
    });

    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });

    // The provider id Meta would quote in a delivery receipt — read from the ledger rather than
    // guessed from the stub's counter, so an extra outbound call cannot shift it.
    const wamid = (
      await pool.query<{ provider_message_id: string }>(
        'SELECT provider_message_id FROM whatsapp_message WHERE incident_id = $1',
        [created.incidentId],
      )
    ).rows[0]?.provider_message_id;
    expect(wamid).toBeTruthy();

    // Meta says the handset received it. This is what turns the obligation from `pending` to
    // `delivered`, and it is the whole point of this file.
    await webhook({
      entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'delivered' }] } }] }],
    });

    const attempt = foldIncident(
      created.incidentId,
      await loadIncident(pool, created.incidentId),
    ).notifications.find((n) => n.reason === 'dispatched');
    expect(attempt?.state).toBe('delivered');

    return created.incidentId;
  }

  /** One signed webhook body — a status update or an inbound message. */
  async function webhook(body: unknown): Promise<number> {
    const raw = JSON.stringify(body);
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

  const tap = (label: string): Promise<number> =>
    webhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: officerPhone,
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

  const dispatchedAttempt = async (
    id: string,
  ): Promise<{ via: string | undefined; said: string | undefined; state: string } | undefined> => {
    const state = foldIncident(id, await loadIncident(pool, id));
    const a = state.notifications.find((n) => n.reason === 'dispatched');
    return a === undefined ? undefined : { via: a.via, said: a.said, state: a.state };
  };

  const tally = async (id: string): Promise<ReturnType<typeof attendanceFor>> => {
    const state = foldIncident(id, await loadIncident(pool, id));
    return attendanceFor('meeting', state.notifications as readonly AttendanceInput[]);
  };

  it('lands via and said on an obligation Meta already settled', async () => {
    const id = await deliveredMeeting(`Flood review ${RUN}`);
    sent = [];

    expect(await tap('Sending someone')).toBe(200);

    // The ledger row — not just the narrative — now carries what the officer said.
    const a = await dispatchedAttempt(id);
    expect(a?.state).toBe('delivered');
    expect(a?.via).toBe('reply');
    expect(a?.said).toBe('Sending someone');

    // Which is exactly what the attendance tally reads.
    const counted = await tally(id);
    expect(counted?.sendingSomeone).toBe(1);
    expect(counted?.unanswered).toBe(0);
  });

  it('answers an Attending tap instead of leaving the thread silent', async () => {
    const id = await deliveredMeeting(`Revenue review ${RUN}`);
    sent = [];

    expect(await tap('Attending')).toBe(200);

    // The ledger row is filled in...
    const a = await dispatchedAttempt(id);
    expect(a?.via).toBe('reply');
    expect(a?.said).toBe('Attending');
    expect((await tally(id))?.attending).toBe(1);

    // ...and the district said something back — its own verbatim meeting sentence, no buttons.
    const replies = sent
      .filter((s) => s.url.includes('/messages'))
      .map((s) => JSON.parse(s.body || '{}') as { type?: string; text?: { body?: string } });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.type).toBe('text');
    expect(replies[0]?.text?.body).toContain(
      'Kindly make it convenient to attend the subject meeting',
    );
  });
});
