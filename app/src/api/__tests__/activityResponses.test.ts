/**
 * Respond — a message from the DC office to the person who sent a post, and their answer coming
 * back to it (ADR-0044 §6–§7; Bajaur, PLAN §4b G3). Real PostgreSQL, the real webhook route with
 * a real HMAC, real files under a real Activities root; only Meta is stubbed.
 *
 * What is pinned:
 *
 *   * only the DC and the control room (`owner`, `admin`, `operator`) may respond; a `viewer` and
 *     a `member` are refused, are handed no response with a post, and cannot fetch an answer's file;
 *   * inside the 24-hour window it is a plain message to the sender's number only, that says it is
 *     Activities, quotes the post and says it is not an emergency alert;
 *   * outside the window with no template, **nothing is sent, nothing is kept, and the caller is
 *     told**; with the template it goes on the template;
 *   * with no WhatsApp account at all it is refused as such;
 *   * delivery is known: sent → delivered → read, never walked backwards; a refusal by Meta is
 *     kept on the post with Meta's reason and reported to the caller;
 *   * the officer's answer returns to the post: by WhatsApp's reply, exactly; plain words by time
 *     — unless an alert went to that number since; a reaction; a photo and a voice note kept on
 *     the answer; a video noted there and posted as it always was;
 *   * none of it writes an incident event or evidence, and all of it goes with the post.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import { noteInbound, recordSent } from '../../db/whatsappStore.js';
import { districtDate } from '../../domain/districtTime.js';
import type { Role } from '../../domain/roles.js';
import { toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';
import { RESPONSE_FOOTER, RESPONSE_HEADING } from '../activityResponses.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'activities-respond-password-2026';
const TEMPLATE = 'dnc_bajaur_activity_response';

interface Account {
  readonly token: string;
  readonly personId: string;
  readonly phone: string;
}

interface ResponseBody {
  readonly responseId: string;
  readonly direction: 'out' | 'in';
  readonly body: string;
  readonly byName: string | null;
  readonly status: string | null;
  readonly failure: string | null;
  readonly matchedBy: string | null;
  readonly media: string | null;
}

const jpeg = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from(`answer ${randomUUID()}`.repeat(8), 'latin1'),
  ]);

const ogg = (): Buffer =>
  Buffer.concat([
    Buffer.from('OggS', 'latin1'),
    Buffer.alloc(24),
    Buffer.from('OpusHead', 'latin1'),
    Buffer.from('voice bytes'.repeat(20), 'latin1'),
  ]);

const mp4 = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmp42', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom', 'latin1'),
    Buffer.from('video bytes'.repeat(20), 'latin1'),
  ]);

describe.skipIf(dbUrl === undefined)('Activities: Respond (ADR-0044)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;

  let dc: Account;
  let operator: Account;
  let unitId: string;

  /** Mutable on purpose: a test names the template, or takes it away again. */
  const config: { -readonly [K in keyof WhatsAppConfig]: WhatsAppConfig[K] } = {
    phoneNumberId: '999',
    accessToken: 'not-a-real-token',
    appSecret: `secret-${RUN}`,
    verifyToken: `verify-${RUN}`,
    templateName: 'district_message_v3',
    templateLanguage: 'en',
    baseUrl: 'https://example.invalid/v21.0',
  };

  const files = new Map<string, { bytes: Buffer; type: string }>();
  /** Every message the server sent, as Meta received it. */
  const sent: Record<string, unknown>[] = [];

  const stubFetch = (async (url: string, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.startsWith('https://lookaside.invalid/')) {
      const f = files.get(u.slice('https://lookaside.invalid/'.length));
      return f === undefined
        ? new Response('gone', { status: 404 })
        : new Response(new Uint8Array(f.bytes), { status: 200 });
    }
    const lookup = /\/(wa-media-[^/?]+)$/.exec(u);
    if (lookup !== null) {
      const f = files.get(lookup[1]!);
      return f === undefined
        ? new Response(JSON.stringify({ error: { message: 'not found', code: 100 } }), {
            status: 404,
          })
        : new Response(
            JSON.stringify({
              url: `https://lookaside.invalid/${lookup[1]!}`,
              mime_type: f.type,
              sha256: createHash('sha256').update(f.bytes).digest('hex'),
              file_size: f.bytes.length,
            }),
            { status: 200 },
          );
    }
    if (typeof init?.body !== 'string') return new Response('{}', { status: 200 });
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // Marking an officer's message read is not a message sent.
    if (body['status'] === 'read') return new Response('{"success":true}', { status: 200 });
    if (init.body.includes('META-REFUSES-THIS')) {
      return new Response(
        JSON.stringify({ error: { message: '(#131026) Message undeliverable', code: 131026 } }),
        { status: 400 },
      );
    }
    sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${RUN}.${sent.length}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  async function account(role: Role, name = `Respond ${role}`): Promise<Account> {
    const phone = `+92304${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD), role],
    );
    return {
      token: (await login(pool, phone, PASSWORD))!.token,
      personId: res.rows[0]!.person_id,
      phone,
    };
  }

  const call = (
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
    at = base,
  ): Promise<Response> =>
    fetch(`${at}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

  /** A fresh officer with one post. `open`: they wrote to the district number a moment ago. */
  async function officerWithPost(
    open: boolean,
    caption = 'Visited the health unit',
  ): Promise<{ officer: Account; postId: string }> {
    const officer = await account('member', 'Respond officer');
    const res = await call(officer.token, '/activities/posts', 'POST', {
      unitId,
      activityDate: districtDate(),
      caption,
    });
    expect(res.status).toBe(201);
    if (open) await noteInbound(pool, toE164(officer.phone), new Date().toISOString());
    return { officer, postId: ((await res.json()) as { postId: string }).postId };
  }

  const respond = (token: string, postId: string, message: unknown): Promise<Response> =>
    call(token, `/activities/posts/${postId}/responses`, 'POST', { message });

  /** What stands under a post, as the DC sees it. */
  async function under(postId: string, token = dc.token): Promise<ResponseBody[]> {
    const res = await call(token, `/activities/posts/${postId}/responses`);
    expect(res.status).toBe(200);
    return (await res.json()) as ResponseBody[];
  }

  async function inFeed(
    token: string,
    postId: string,
  ): Promise<{ mayRespond: boolean; responses: ResponseBody[] } | undefined> {
    const res = await call(token, '/activities/posts');
    expect(res.status).toBe(200);
    const posts = (
      (await res.json()) as {
        posts: { postId: string; mayRespond: boolean; responses: ResponseBody[] }[];
      }
    ).posts;
    return posts.find((p) => p.postId === postId);
  }

  async function webhook(value: unknown): Promise<number> {
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value }] }] });
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

  const status = (id: string, state: string, errors?: unknown): Promise<number> =>
    webhook({ statuses: [{ id, status: state, ...(errors === undefined ? {} : { errors }) }] });

  let n = 0;
  /** An inbound message from `from`; `replyTo` is the id of ours they used WhatsApp's reply on. */
  function message(from: string, content: Record<string, unknown>, replyTo?: string): unknown {
    n += 1;
    return {
      from: toE164(from),
      id: `wamid.in.${RUN}.${n}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...content,
      ...(replyTo === undefined ? {} : { context: { id: replyTo } }),
    };
  }

  const words = (from: string, text: string, replyTo?: string): Promise<number> =>
    webhook({ messages: [message(from, { type: 'text', text: { body: text } }, replyTo)] });

  function file(kind: 'image' | 'audio' | 'video', bytes: Buffer, type: string): unknown {
    n += 1;
    const mediaId = `wa-media-${RUN}-${n}`;
    files.set(mediaId, { bytes, type });
    return {
      type: kind,
      [kind]: {
        id: mediaId,
        mime_type: type,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(kind === 'audio' ? { voice: true } : {}),
      },
    };
  }

  /** The id Meta gave the last message this server sent. */
  const lastSentId = (): string => `wamid.out.${RUN}.${sent.length}`;

  /** Send a Respond inside the window and return Meta's id for it. */
  async function sendTo(
    postId: string,
    text = 'Please send the attendance figures.',
  ): Promise<string> {
    const res = await respond(dc.token, postId, text);
    expect(res.status).toBe(201);
    return lastSentId();
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = await mkdtemp(join(tmpdir(), 'dnc-bajaur-respond-'));
    server = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      activitiesRoot: root,
      activitiesFromWhatsApp: true,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    dc = await account('owner', 'Respond DC');
    operator = await account('operator');
    const made = await call(dc.token, '/activities/units', 'POST', {
      name: `Respond ${randomUUID()}`,
    });
    unitId = ((await made.json()) as { unitId: string }).unitId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  describe('who may', () => {
    it('is the DC and the control room, and nobody else', async () => {
      const { postId } = await officerWithPost(true);
      for (const role of ['viewer', 'member'] as const) {
        const a = await account(role);
        const before = sent.length;
        expect((await respond(a.token, postId, 'hello')).status, role).toBe(403);
        expect(sent.length, role).toBe(before);
        expect((await call(a.token, `/activities/posts/${postId}/responses`)).status, role).toBe(
          403,
        );
      }
      for (const a of [dc, operator, await account('admin')]) {
        expect((await respond(a.token, postId, 'Noted, thank you.')).status).toBe(201);
      }
    });

    it('hands a response to nobody who cannot respond — not even the post’s own author', async () => {
      const { officer, postId } = await officerWithPost(true);
      await sendTo(postId, 'A word for the DC office only.');
      expect((await inFeed(dc.token, postId))?.mayRespond).toBe(true);
      expect((await inFeed(dc.token, postId))?.responses).toHaveLength(1);
      expect((await inFeed(operator.token, postId))?.responses).toHaveLength(1);

      for (const a of [officer, await account('viewer'), await account('member')]) {
        const card = await inFeed(a.token, postId);
        expect(card?.mayRespond).toBe(false);
        expect(card?.responses).toEqual([]);
        expect(JSON.stringify(card)).not.toContain('A word for the DC office only.');
      }
    });

    it('says no more than "no such post" about a post that is not there', async () => {
      const res = await respond(dc.token, randomUUID(), 'hello');
      expect(res.status).toBe(404);
    });
  });

  describe('sending', () => {
    it('inside the window: a plain message, to the sender only, that says what it is', async () => {
      const { officer, postId } = await officerWithPost(true, 'Visited the health unit at Khar');
      const before = sent.length;
      const res = await respond(dc.token, postId, '  Good work. Send the staff list too.  ');
      expect(res.status).toBe(201);

      expect(sent.length).toBe(before + 1);
      const out = sent.at(-1)!;
      expect(out['to']).toBe(toE164(officer.phone));
      expect(out['type']).toBe('text');
      const text = (out['text'] as { body: string }).body;
      expect(text.startsWith(RESPONSE_HEADING)).toBe(true);
      expect(text).toContain('"Visited the health unit at Khar"');
      expect(text).toContain('Good work. Send the staff list too.');
      expect(text.endsWith(RESPONSE_FOOTER)).toBe(true);
      expect(text).toContain('not an emergency alert');
      // Nothing an alert carries: no template, no buttons.
      expect(out['template']).toBeUndefined();
      expect(out['interactive']).toBeUndefined();

      const kept = (await res.json()) as ResponseBody[];
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        direction: 'out',
        body: 'Good work. Send the staff list too.',
        byName: 'Respond DC',
        status: 'sent',
        failure: null,
      });

      const logged = await pool.query<{ actor_person_id: string; detail: { sent: boolean } }>(
        `SELECT actor_person_id, detail FROM activity_log WHERE type = 'responded' AND post_id = $1`,
        [postId],
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0]!.actor_person_id).toBe(dc.personId);
      expect(logged.rows[0]!.detail.sent).toBe(true);
      expect(JSON.stringify(logged.rows[0]!.detail)).not.toContain('staff list');
    });

    it('refuses an empty message and one over 1000 characters, before anything is sent', async () => {
      const { postId } = await officerWithPost(true);
      const before = sent.length;
      expect((await respond(dc.token, postId, '   ')).status).toBe(400);
      expect((await respond(dc.token, postId, 'x'.repeat(1001))).status).toBe(400);
      expect((await respond(dc.token, postId, 7)).status).toBe(400);
      expect(sent.length).toBe(before);
    });

    it('outside the window with no template: nothing sent, nothing kept, and it says so', async () => {
      const { postId } = await officerWithPost(false);
      const before = sent.length;
      const res = await respond(dc.token, postId, 'hello');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('Nothing was sent');
      expect(sent.length).toBe(before);
      expect(await under(postId)).toEqual([]);
    });

    it('outside the window with the template: goes on the template, in one line', async () => {
      const { officer, postId } = await officerWithPost(false);
      config.activityTemplate = { name: TEMPLATE, language: 'en' };
      try {
        const res = await respond(dc.token, postId, 'Line one.\n\nLine two.');
        expect(res.status).toBe(201);
        const out = sent.at(-1)!;
        expect(out['to']).toBe(toE164(officer.phone));
        expect(out['type']).toBe('template');
        const template = out['template'] as {
          name: string;
          components: { type: string; parameters: { text: string }[] }[];
        };
        expect(template.name).toBe(TEMPLATE);
        const body = template.components.find((c) => c.type === 'body')!;
        expect(body.parameters).toHaveLength(2);
        // Meta refuses a parameter with a line break in it.
        expect(body.parameters[1]!.text).toBe('Line one. Line two.');
        // What the DC office reads back is what was typed.
        expect((await under(postId))[0]!.body).toBe('Line one.\n\nLine two.');
      } finally {
        delete config.activityTemplate;
      }
    });

    it('with no WhatsApp account at all: refused as that, nothing kept', async () => {
      const bare = createSyncServer({
        pool,
        authMode: 'session',
        nodeEnv: 'test',
        activitiesRoot: root,
      });
      await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
      const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
      try {
        const { postId } = await officerWithPost(true);
        const res = await call(
          dc.token,
          `/activities/posts/${postId}/responses`,
          'POST',
          {
            message: 'hello',
          },
          at,
        );
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('Nothing was sent');
        expect(await under(postId)).toEqual([]);
      } finally {
        await new Promise<void>((r) => bare.close(() => r()));
      }
    });

    it('a refusal by Meta is kept on the post with Meta’s reason, and reported', async () => {
      const { postId } = await officerWithPost(true);
      const res = await respond(dc.token, postId, 'META-REFUSES-THIS');
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain('131026');
      const kept = await under(postId);
      expect(kept).toHaveLength(1);
      expect(kept[0]!.status).toBe('failed');
      expect(kept[0]!.failure).toContain('131026');
    });

    it('is refused on a post in the Recycle bin', async () => {
      const { postId } = await officerWithPost(true);
      expect((await call(dc.token, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(200);
      expect((await respond(dc.token, postId, 'hello')).status).toBe(409);
    });
  });

  describe('delivery is known', () => {
    it('moves sent → delivered → read, and is never walked backwards', async () => {
      const { postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      const now = async (): Promise<string | null> => (await under(postId))[0]!.status;

      expect(await status(id, 'delivered')).toBe(200);
      expect(await now()).toBe('delivered');
      expect(await status(id, 'read')).toBe(200);
      expect(await now()).toBe('read');
      // Statuses arrive out of order as a matter of routine.
      expect(await status(id, 'delivered')).toBe(200);
      expect(await status(id, 'sent')).toBe(200);
      expect(await now()).toBe('read');
    });

    it('a failure reported later is shown with its reason', async () => {
      const { postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      expect(await status(id, 'failed', [{ title: 'Message undeliverable', code: 131026 }])).toBe(
        200,
      );
      const kept = (await under(postId))[0]!;
      expect(kept.status).toBe('failed');
      expect(kept.failure).toContain('Message undeliverable');
    });

    it('a status about a message that is nobody’s is answered and changes nothing', async () => {
      expect(await status(`wamid.nobody.${randomUUID()}`, 'delivered')).toBe(200);
    });
  });

  describe('the officer’s answer', () => {
    /** How much the incident record holds — test files run one at a time, so it moves only here. */
    async function onTheRecord(): Promise<string> {
      const { rows } = await pool.query<{ events: string; evidence: string }>(
        `SELECT (SELECT count(*) FROM incident_event) AS events,
                (SELECT count(*) FROM evidence) AS evidence`,
      );
      return `${rows[0]!.events} events, ${rows[0]!.evidence} files`;
    }

    it('sent with WhatsApp’s reply: lands on that post, for the DC office only', async () => {
      const before = await onTheRecord();
      const { officer, postId } = await officerWithPost(true);
      const older = await sendTo(postId, 'First question.');
      await sendTo(postId, 'Second question.');

      // Replying to the FIRST message, though a second has gone since: exact, not by time.
      expect(await words(officer.phone, 'Twelve staff were present.', older)).toBe(200);
      const kept = await under(postId);
      expect(kept.map((r) => [r.direction, r.body])).toEqual([
        ['out', 'First question.'],
        ['out', 'Second question.'],
        ['in', 'Twelve staff were present.'],
      ]);
      expect(kept[2]).toMatchObject({
        matchedBy: 'reply',
        byName: null,
        status: null,
        media: null,
      });

      // Not a post, not shown to the officer's own account, and nothing on the incident record.
      const posts = await pool.query('SELECT 1 FROM activity_post WHERE author_person_id = $1', [
        officer.personId,
      ]);
      expect(posts.rowCount).toBe(1);
      expect((await inFeed(officer.token, postId))?.responses).toEqual([]);
      expect(await onTheRecord()).toBe(before);
    });

    it('a retried webhook keeps one answer, not two', async () => {
      const { officer, postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      const once = message(officer.phone, { type: 'text', text: { body: 'Yes.' } }, id);
      expect(await webhook({ messages: [once] })).toBe(200);
      expect(await webhook({ messages: [once] })).toBe(200);
      expect((await under(postId)).filter((r) => r.direction === 'in')).toHaveLength(1);
    });

    it('plain words with no reply: matched by time to the last Respond, and marked so', async () => {
      const { officer, postId } = await officerWithPost(true);
      await sendTo(postId);
      expect(await words(officer.phone, 'Sending it now.')).toBe(200);
      const answer = (await under(postId)).at(-1)!;
      expect(answer).toMatchObject({
        direction: 'in',
        body: 'Sending it now.',
        matchedBy: 'latest',
      });
    });

    it('plain words from a number alerted in the last day are never taken as an answer', async () => {
      const { officer, postId } = await officerWithPost(true);
      // An alert went first, the Respond after it: "On my way" may still be about the emergency,
      // and an answer to an emergency is never diverted into Activities.
      await recordSent(pool, {
        providerMessageId: `wamid.alert.${randomUUID()}`,
        attemptId: randomUUID(),
        incidentId: randomUUID(),
        toPhone: toE164(officer.phone),
      });
      await sendTo(postId);
      expect(await words(officer.phone, 'On my way.')).toBe(200);
      expect((await under(postId)).filter((r) => r.direction === 'in')).toEqual([]);
    });

    it('words from somebody who was never sent a Respond are not an answer to anything', async () => {
      const { officer, postId } = await officerWithPost(true);
      expect(await words(officer.phone, 'Hello?')).toBe(200);
      expect(await under(postId)).toEqual([]);
    });

    it('a reaction on our message is an answer', async () => {
      const { officer, postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      const reaction = message(officer.phone, {
        type: 'reaction',
        reaction: { message_id: id, emoji: '👍' },
      });
      expect(await webhook({ messages: [reaction] })).toBe(200);
      expect((await under(postId)).at(-1)).toMatchObject({ direction: 'in', body: '👍' });
    });

    it('a photo and a voice note sent as a reply are kept on the answer, for the DC office only', async () => {
      const { officer, postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      const photo = jpeg();
      expect(
        await webhook({
          messages: [message(officer.phone, file('image', photo, 'image/jpeg') as never, id)],
        }),
      ).toBe(200);
      expect(
        await webhook({
          messages: [message(officer.phone, file('audio', ogg(), 'audio/ogg') as never, id)],
        }),
      ).toBe(200);

      const answers = (await under(postId)).filter((r) => r.direction === 'in');
      expect(answers.map((r) => r.media)).toEqual(['photo', 'audio']);

      const got = await call(dc.token, `/activities/responses/${answers[0]!.responseId}/media`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/jpeg');
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await got.arrayBuffer()).equals(photo)).toBe(true);
      const voice = await call(dc.token, `/activities/responses/${answers[1]!.responseId}/media`);
      expect(voice.headers.get('content-type')).toBe('audio/ogg');

      // Not a new post, and not for anybody who cannot respond.
      const posts = await pool.query('SELECT 1 FROM activity_post WHERE author_person_id = $1', [
        officer.personId,
      ]);
      expect(posts.rowCount).toBe(1);
      for (const a of [officer, await account('viewer')]) {
        const refused = await call(
          a.token,
          `/activities/responses/${answers[0]!.responseId}/media`,
        );
        expect(refused.status).toBe(404);
      }
    });

    it('a video sent as a reply is noted on the answer and posted as it always was', async () => {
      const { officer, postId } = await officerWithPost(true);
      const id = await sendTo(postId);
      expect(
        await webhook({
          messages: [message(officer.phone, file('video', mp4(), 'video/mp4') as never, id)],
        }),
      ).toBe(200);
      const answer = (await under(postId)).at(-1)!;
      expect(answer.direction).toBe('in');
      expect(answer.body).toContain('sent a video');
      expect(answer.media).toBeNull();
      const posts = await pool.query('SELECT 1 FROM activity_post WHERE author_person_id = $1', [
        officer.personId,
      ]);
      expect(posts.rowCount).toBe(2);
    });

    it('a picture sent with no reply is a new post, as it always was', async () => {
      const { officer, postId } = await officerWithPost(true);
      await sendTo(postId);
      expect(
        await webhook({
          messages: [message(officer.phone, file('image', jpeg(), 'image/jpeg') as never)],
        }),
      ).toBe(200);
      expect((await under(postId)).filter((r) => r.direction === 'in')).toEqual([]);
      const posts = await pool.query('SELECT 1 FROM activity_post WHERE author_person_id = $1', [
        officer.personId,
      ]);
      expect(posts.rowCount).toBe(2);
    });
  });

  it('goes with its post — the messages, the answers and their files', async () => {
    const { officer, postId } = await officerWithPost(true);
    const id = await sendTo(postId);
    await webhook({
      messages: [message(officer.phone, file('image', jpeg(), 'image/jpeg') as never, id)],
    });
    const stored = await pool.query<{ stored_path: string }>(
      `SELECT stored_path FROM activity_response WHERE post_id = $1 AND stored_path IS NOT NULL`,
      [postId],
    );
    expect(stored.rows).toHaveLength(1);
    const path = join(root, stored.rows[0]!.stored_path);
    expect(existsSync(path)).toBe(true);

    expect((await call(dc.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(200);
    const left = await pool.query('SELECT 1 FROM activity_response WHERE post_id = $1', [postId]);
    expect(left.rowCount).toBe(0);
    expect(existsSync(path)).toBe(false);

    // An answer that arrives after the post has gone is dropped without a fault.
    expect(await words(officer.phone, 'Too late.', id)).toBe(200);
  });
});
