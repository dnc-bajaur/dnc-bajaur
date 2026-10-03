/**
 * "Who is coming in your place?" — Phase B, 2026-08-20.
 *
 * End to end against real PostgreSQL and the real webhook route, with only Meta stubbed. What is
 * being proved is the thing the owner asked for and was told did not exist: a meeting notice is
 * answered with *Sending someone*, the district asks who, the officer types a name, and the name
 * lands **on that meeting** — none of it leaving WhatsApp.
 *
 * The four assertions that matter, and each is a way of losing the answer:
 *
 *   * **The question is asked at all**, as free text and not as a template. Buttons cannot ask
 *     this: a deputy is a person, not a fixed vocabulary of three.
 *   * **The name lands on the incident the question was about.** Every other inbound in this
 *     system is matched to an incident *by the number it came from*, which is an inference stated
 *     as one. This one is not — the question carries its own subject.
 *   * **A tap is never read as the name.** An officer answering a different meeting while this
 *     one is outstanding must not have that tap recorded as a substitute's name.
 *   * **A second delivery of the same reply changes nothing.** Meta redelivers on any non-2xx,
 *     and a district reading two people attending in one officer's place is worse than one
 *     reading none.
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
import { pendingQuestion } from '../../db/whatsappStore.js';
import { toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';

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
  /** Named, so a meeting actually goes out on the template whose buttons this test taps. */
  noticeTemplate: { name: 'district_notice_v2', language: 'en' },
};

describe.skipIf(dbUrl === undefined)('who is coming in your place', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let officerPerson: string;
  /** As the directory holds it — `03xx…`, which is what an inbound webhook says it came from. */
  let officerPhone: string;
  /**
   * The same number as the **store** keys on, and they are deliberately not the same string.
   *
   * `noteInbound` and `recordQuestion` write `toE164(...)`, because a number stored two ways is a
   * conversation the district believes it is having with somebody who never hears from it. A test
   * that looked this up in the directory's own format would report *no question pending* while
   * one was — which is how this test failed the first time it ran, and it is worth keeping as
   * the reason the two variables exist.
   */
  let officerKey: string;

  /** Everything the stub was asked to send, in order, both from the channel and from the webhook. */
  let sent: { url: string; body: string }[];

  const stubFetch = (async (url: string, init?: { body?: string }) => {
    sent.push({ url: String(url), body: init?.body ?? '' });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${sent.length}` }] }), {
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
      // The webhook answers back now, so it needs a stub of its own. See `ServerOptions`.
      whatsappFetch: stubFetch,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (sub ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (sub ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const education = await seedDepartment(pool, `Education (sub ${RUN})`);
    const deo = await seedActor(pool, { title: `DEO (sub ${RUN})`, departmentId: education });
    officerPerson = deo.personId;

    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [officerPerson],
    );
    officerPhone = row.rows[0]?.phone ?? '';
    expect(officerPhone).not.toBe('');
    officerKey = toE164(officerPhone);
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** A meeting notice, told to one named officer, actually sent. */
  async function sendMeeting(subject: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          // A category no routing signal can match — `whatsappLoop.test.ts` paid for this lesson
          // three times over. A per-run value cannot be matched by a signal nobody wrote.
          category: `sub-${RUN}`,
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
    return created.incidentId;
  }

  /** One inbound message, signed as Meta signs it. */
  async function inbound(message: unknown): Promise<number> {
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [message] } }] }],
    });
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

  const typed = (words: string): unknown => ({
    from: officerPhone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    text: { body: words },
  });

  const notes = async (incidentId: string): Promise<string[]> => {
    const events = await loadIncident(pool, incidentId);
    return events
      .filter((e) => e.type === 'action_logged')
      .map((e) => String((e.payload as { note?: unknown }).note ?? ''));
  };

  it('asks who is coming, in words, inside WhatsApp', async () => {
    await sendMeeting(`Flood coordination ${RUN}`);
    sent = [];

    expect(await inbound(tap('Sending someone'))).toBe(200);

    // Exactly one message went out in answer, and it is NOT a template — which is the whole
    // point of Phase A. A template would have needed Meta's approval and could not have asked
    // for a name at all.
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]?.body ?? '{}') as { type?: string; text?: { body?: string } };
    expect(body.type).toBe('text');
    expect(body.text?.body).toContain('Who is coming in your place?');
    // Their own words are echoed, because this arrives as a bare message in a thread that may
    // hold several of the district's notices.
    expect(body.text?.body).toContain('Sending someone');

    // And the district is now waiting on an answer from that number.
    expect(await pendingQuestion(pool, officerKey)).not.toBeNull();
  });

  it('records the name against the meeting the question was about', async () => {
    const id = await sendMeeting(`Revenue review ${RUN}`);
    await inbound(tap('Sending someone'));

    /**
     * Held **before** answering, because the assertion below has to be about *this* question.
     *
     * The first attempt asserted that nothing was pending for this number afterwards, and it
     * failed — correctly. An earlier test in this file taps *"Sending someone"* and never
     * answers, so an older question is legitimately still waiting, and `pendingQuestion` returns
     * the most recent unanswered one by design. **That was a test asserting on state it does not
     * own**, which is a shape this repository has already paid for four times.
     */
    const asked = await pendingQuestion(pool, officerKey);
    expect(asked).not.toBeNull();

    expect(await inbound(typed('Officer Lima, ADC Revenue'))).toBe(200);

    const written = await notes(id);
    expect(written.some((n) => n.includes('Sending someone in their place'))).toBe(true);
    expect(written.some((n) => n.includes('Officer Lima, ADC Revenue'))).toBe(true);
    /**
     * **And it says the match was NOT inferred.** Every other reply in this system carries the
     * opposite sentence, because it is matched to an incident by the number it came from. This
     * one knows its subject, and the record has to be able to tell a reader which kind it is
     * looking at — the two claims are not equally strong and must never read alike (M7-30).
     */
    expect(written.some((n) => n.includes('not inferred'))).toBe(true);

    // And *this* question is closed, so the officer's next message is an ordinary reply again.
    const closed = await pool.query<{ answer: string; answered_at: Date | null }>(
      'SELECT answer, answered_at FROM whatsapp_question WHERE question_id = $1',
      [asked?.questionId],
    );
    expect(closed.rows[0]?.answered_at).not.toBeNull();
    expect(closed.rows[0]?.answer).toBe('Officer Lima, ADC Revenue');
  });

  it('does not read a tap on another meeting as the name', async () => {
    const asked = await sendMeeting(`Sanitation drive ${RUN}`);
    await inbound(tap('Sending someone'));

    // A second meeting, answered with a TAP while the first question is still outstanding.
    const other = await sendMeeting(`School inspection ${RUN}`);
    expect(await inbound(tap('Attending'))).toBe(200);

    // The tap is recorded as itself, on its own incident...
    expect((await notes(other)).some((n) => n.includes('Tapped "Attending"'))).toBe(true);
    // ...and nothing anywhere claims somebody named "Attending" is coming.
    expect((await notes(asked)).some((n) => n.includes('in their place'))).toBe(false);
    // The question is still waiting, because a tap did not answer it.
    expect(await pendingQuestion(pool, officerKey)).not.toBeNull();
  });

  it('appends the name once, however many times Meta delivers it', async () => {
    const id = await sendMeeting(`Water supply ${RUN}`);
    await inbound(tap('Sending someone'));

    const reply = typed(`Officer Mike, AAC Mamund ${RUN}`);
    await inbound(reply);
    // Meta retries any non-2xx and redelivers on a timeout. Byte-identical, deliberately.
    await inbound(reply);

    const written = await notes(id);
    const named = written.filter((n) => n.includes(`Officer Mike, AAC Mamund ${RUN}`));
    expect(named).toHaveLength(1);
  });

  it('leaves the tap recorded when the question cannot be sent', async () => {
    /**
     * The direction that must hold: everything the officer told the district is written **before**
     * the follow-up is attempted, so a Meta outage costs the name and never the answer.
     */
    const id = await sendMeeting(`Bridge repair ${RUN}`);

    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), {
        status: 400,
      })) as unknown as typeof fetch;

    const failingServer = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: failing,
    });
    await new Promise<void>((r) => failingServer.listen(0, '127.0.0.1', r));
    const failingBase = `http://127.0.0.1:${(failingServer.address() as AddressInfo).port}`;

    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [tap('Sending someone')] } }] }],
    });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${failingBase}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    // 200, because Meta retries any non-2xx for hours onto the machine also taking emergency
    // reports — and a retry would redeliver the tap, not the question.
    expect(res.status).toBe(200);

    await new Promise<void>((r) => failingServer.close(() => r()));

    // The officer's answer is on the record regardless.
    expect((await notes(id)).some((n) => n.includes('Tapped "Sending someone"'))).toBe(true);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.acknowledgedAt).not.toBeNull();
  });
});
