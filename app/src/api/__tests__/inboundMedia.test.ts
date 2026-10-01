/**
 * An officer photographs the scene and sends it — 2026-08-21, end to end.
 *
 * ## The defect these tests were written against
 *
 * `readWebhook` read words and a button's label, and dropped everything else **without a line in
 * the log**. So a photograph was not a quiet feature gap: the officer had **answered**, and the
 * message was discarded before anything looked at it — the obligation stayed open, the SLA clock
 * kept running, escalation climbed over their head, and the board carried them for the rest of
 * the district day as somebody nobody had reached. They could see their own photograph in their
 * own thread the whole time.
 *
 * That is the same shape as the quick-reply defect of 2026-08-19, and test 1 is what pins it.
 *
 * ## What is stubbed and what is not
 *
 * **Only Meta.** Real PostgreSQL, the real webhook route with a real HMAC, the real notify pass,
 * the real fold, and `ops/evidence.ts` writing real bytes to a real directory — because the
 * question is whether the district ends up holding a file somebody can open, and a mocked
 * evidence layer would answer a different one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { runNotifyPass } from '../../jobs/notify.js';
import { whatsappChannel } from '../../jobs/whatsappChannel.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { listFor } from '../../ops/evidence.js';
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
};

/** A real JPEG header, because `ops/fileType.ts` reads the bytes and the bytes win (M9-14). */
const PHOTO = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from('the scene at khar road'.repeat(8), 'latin1'),
]);
const PHOTO_HASH = createHash('sha256').update(PHOTO).digest('hex');

describe.skipIf(dbUrl === undefined)('a file arriving from an officer (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let evidenceRoot: string;

  let controlToken: string;
  let officerPerson: string;
  let officerPhone: string;

  /** What the stubbed Meta does with the next media lookup. Each test sets it. */
  let mediaAnswer: { status: number; body: unknown } = { status: 200, body: {} };
  /** What the lookaside URL hands back. */
  let fileAnswer: { status: number; bytes: Buffer } = { status: 200, bytes: PHOTO };

  let outbound = 0;

  const stubFetch = (async (url: string) => {
    const u = String(url);

    // The lookaside host — the bytes themselves.
    if (u.startsWith('https://lookaside.invalid/')) {
      return new Response(new Uint8Array(fileAnswer.bytes), { status: fileAnswer.status });
    }

    // `GET /{media-id}` — the metadata carrying the one-use url.
    if (u.startsWith(`${config.baseUrl!}/media-`)) {
      return new Response(JSON.stringify(mediaAnswer.body), { status: mediaAnswer.status });
    }

    // Everything else is an outbound send.
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
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    evidenceRoot = await mkdtemp(join(tmpdir(), 'dnc-inbound-'));

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      evidenceRoot,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (media ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (media ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (media ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (media ${RUN})`,
      departmentId: rescue,
    });
    officerPerson = duty.personId;

    const row = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [officerPerson],
    );
    officerPhone = row.rows[0]?.phone ?? '';
    expect(toE164(officerPhone)).not.toBe('');
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true });
  });

  /** An emergency, told to one named officer, actually sent. */
  async function raise(what: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          // Per-run, so nothing another suite left behind can route it. `whatsappLoop.test.ts`
          // paid for this lesson three times over.
          category: `media-${RUN}`,
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

  function photo(mediaId: string, caption?: string): unknown {
    return {
      from: officerPhone,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'image',
      image: {
        id: mediaId,
        mime_type: 'image/jpeg',
        sha256: PHOTO_HASH,
        ...(caption === undefined ? {} : { caption }),
      },
    };
  }

  function lookupFor(mediaId: string): { status: number; body: unknown } {
    return {
      status: 200,
      body: {
        url: `https://lookaside.invalid/whatsapp/media/${mediaId}`,
        mime_type: 'image/jpeg',
        sha256: PHOTO_HASH,
        file_size: PHOTO.length,
      },
    };
  }

  /**
   * **The whole point of the change, in one test.**
   *
   * A photograph with no caption is a complete answer. Before today it produced nothing at all:
   * no evidence, no note, no acknowledgement, and an officer left on the board as unreached.
   */
  it('turns a photograph with no caption into evidence, and settles the obligation', async () => {
    const incidentId = await raise('road accident on the bypass');

    mediaAnswer = lookupFor('media-1');
    fileAnswer = { status: 200, bytes: PHOTO };
    expect(await inbound(photo('media-1'))).toBe(200);

    const held = await listFor(pool, incidentId);
    expect(held).toHaveLength(1);
    expect(held[0]?.contentType).toBe('image/jpeg');
    expect(held[0]?.byteSize).toBe(PHOTO.length);
    // The hash the evidence layer computed, against the bytes this test sent. If these ever
    // disagree the district is holding a file that is not the one the officer took.
    expect(held[0]?.sha256).toBe(PHOTO_HASH);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));

    // The obligation is met, and by the officer's own deliberate act — ADR-0014. A file with no
    // words settles it exactly as words do.
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.notifications.every((a) => a.state !== 'pending')).toBe(true);

    // And the district's record says what they did, in words, rather than leaving a blank after
    // "Replied on WhatsApp:".
    const note = (await loadIncident(pool, incidentId))
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note)
      .join('\n');
    expect(note).toContain('a photograph');
  });

  /**
   * **The evidence is on the incident's own event, not floating beside it.**
   *
   * `action_logged` has carried an optional `evidenceIds` since the catalog was written and
   * nothing had ever used it. The log is append-only, so a file attached afterwards would be a
   * second event pointing back at the first, and *"the photograph that came with this reply"*
   * would stop being one fact.
   */
  it('names the evidence on the reply s own event, and writes the bytes to disk', async () => {
    const incidentId = await raise('smoke reported near the canal');

    mediaAnswer = lookupFor('media-2');
    fileAnswer = { status: 200, bytes: PHOTO };
    expect(await inbound(photo('media-2', 'this is what it looks like'))).toBe(200);

    const events = await loadIncident(pool, incidentId);
    const logged = events
      .filter((e) => e.type === 'action_logged')
      .map((e) => e.payload as { note: string; evidenceIds?: readonly string[] })
      .find((p) => p.evidenceIds !== undefined);

    expect(logged).toBeDefined();
    expect(logged?.evidenceIds).toHaveLength(1);

    const held = await listFor(pool, incidentId);
    expect(logged?.evidenceIds?.[0]).toBe(held[0]?.evidenceId);

    // A caption and its picture are ONE answer — the words are the officer's, on the same note.
    expect(logged?.note).toContain('this is what it looks like');

    // And the bytes are genuinely there. A row pointing at a file that does not exist is
    // evidence the system claims to hold and cannot produce.
    const onDisk = await readFile(join(evidenceRoot, incidentId, `${held[0]!.evidenceId}.jpg`));
    expect(onDisk.equals(PHOTO)).toBe(true);
  });

  /**
   * 🔴 **The ordering rule, and it is the sharpest test here.**
   *
   * Fetching the file reaches across the network to Meta, on the machine that is also taking
   * emergency reports. If that decided whether the officer's answer was recorded, a bad minute at
   * a provider would cost an acknowledgement — and the officer would go back onto the board as
   * unreached having done exactly what they were asked to do.
   *
   * So the reply is recorded whatever happens, the obligation is settled, and the failure is
   * named **on the incident** rather than only in a log line — which is INV-03 applied to a file:
   * the district finds out something was sent and could not be fetched.
   */
  it('records the reply and settles the obligation even when the file cannot be fetched', async () => {
    const incidentId = await raise('flooding at the bridge');

    mediaAnswer = { status: 404, body: { error: { message: 'media not found', code: 100 } } };
    expect(await inbound(photo('media-3'))).toBe(200);

    // Nothing was stored — there was nothing to store.
    expect(await listFor(pool, incidentId)).toHaveLength(0);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.notifications.every((a) => a.state !== 'pending')).toBe(true);

    const note = (await loadIncident(pool, incidentId))
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note)
      .join('\n');
    expect(note).toContain('could not be fetched');
    expect(note).toContain('a photograph');
  });

  /**
   * **A file is never read as the answer to a question the district asked.**
   *
   * Both questions this system puts want words — a substitute's name, or what happened. An
   * officer who photographs the scene while a resolution question is outstanding has answered
   * neither, and recording an empty outcome would close an emergency with a blank sentence.
   *
   * The question must be left **standing**, so they can still type, and the photograph must still
   * land. This is the one case where doing the obvious thing loses the district's record.
   */
  it('leaves a pending question standing when the officer answers with a photograph', async () => {
    const incidentId = await raise('vehicle overturned near the bypass');

    // Acknowledge by tapping, then ask to resolve — which is what puts a question outstanding.
    expect(
      await inbound({
        from: officerPhone,
        timestamp: String(Math.floor(Date.now() / 1000)),
        button: { text: 'Acknowledge', payload: 'Acknowledge' },
      }),
    ).toBe(200);

    const before = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM whatsapp_question
        WHERE phone = $1 AND answered_at IS NULL`,
      [toE164(officerPhone)],
    );

    mediaAnswer = lookupFor('media-4');
    fileAnswer = { status: 200, bytes: PHOTO };
    expect(await inbound(photo('media-4'))).toBe(200);

    const after = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM whatsapp_question
        WHERE phone = $1 AND answered_at IS NULL`,
      [toE164(officerPhone)],
    );

    // Whatever was outstanding before is still outstanding: a photograph answered none of it.
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    // And the photograph is on the incident regardless.
    expect(await listFor(pool, incidentId)).toHaveLength(1);
  });
});
