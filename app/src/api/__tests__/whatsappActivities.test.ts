/**
 * WhatsApp → Activities (ADR-0040, Bajaur — phase D), end to end.
 *
 * Real PostgreSQL, the real webhook route with a real HMAC, real files under a real Activities
 * root, and the real evidence path; only Meta is stubbed. The sharpest test is the emergency
 * branch: ADR-0040 says that after the tap the media takes **exactly today's path** — the same
 * evidence, the same note, the same settled obligation — and that is checked here against the same
 * facts `inboundMedia.test.ts` pins for today's path itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { runNotifyPass } from '../../jobs/notify.js';
import { whatsappChannel } from '../../jobs/whatsappChannel.js';
import { append, loadIncident } from '../../db/eventStore.js';
import type { IncidentEvent } from '../../domain/events.js';
import { foldIncident } from '../../domain/incident.js';
import { districtDate } from '../../domain/districtTime.js';
import { listFor } from '../../ops/evidence.js';
import { toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';
import {
  ACTIVITY_BUTTON,
  ADDED_REPLY,
  EMERGENCY_BUTTON,
  MESSAGE_REPLY,
  PENDING_REPLY,
  sweepInbound,
} from '../whatsappActivities.js';
import { emergencyPathFor } from '../webhooks.js';

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

/** A real JPEG header, because `ops/fileType.ts` reads the bytes and the bytes win. */
const jpeg = (words: string): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from(words.repeat(8), 'latin1'),
  ]);

/** A real MP4 header (`ftyp` box). */
const mp4 = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypmp42', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('mp42isom', 'latin1'),
    Buffer.from('video bytes'.repeat(20), 'latin1'),
  ]);

/** A real Ogg/Opus header: `OggS`, then `OpusHead` at byte 28, as a handset records. */
const ogg = (): Buffer =>
  Buffer.concat([
    Buffer.from('OggS', 'latin1'),
    Buffer.alloc(24),
    Buffer.from('OpusHead', 'latin1'),
    Buffer.from('voice bytes'.repeat(20), 'latin1'),
  ]);

/** A number no account in any suite holds: digits only, and per run. */
const unknownPhone = `92399${String(parseInt(RUN.slice(0, 6), 16))
  .padStart(8, '0')
  .slice(0, 7)}`;

describe.skipIf(dbUrl === undefined)('WhatsApp → Activities (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let activitiesRoot: string;

  let controlToken: string;
  let dcToken: string;
  let memberToken: string;
  /** An officer with an account, a default department, and — in some tests — an emergency. */
  let officer: { personId: string; phone: string; token: string };
  /** A second account, for the DC to approve unknown media under. */
  let other: { personId: string };
  let unitId: string;

  /** Every file Meta is asked for: id → bytes and type. */
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
    if (typeof init?.body === 'string') sent.push(JSON.parse(init.body) as Record<string, unknown>);
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
    evidenceRoot = await mkdtemp(join(tmpdir(), 'dnc-wa-evidence-'));
    activitiesRoot = await mkdtemp(join(tmpdir(), 'dnc-wa-activities-'));

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
      evidenceRoot,
      activitiesRoot,
      activitiesFromWhatsApp: true,
      get whatsappChannel() {
        return channel();
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (wa-act ${RUN})`);
    const control = await seedActor(pool, {
      title: `Control Room (wa-act ${RUN})`,
      departmentId: dc,
      tier: 'district',
    });
    controlToken = control.token;
    dcToken = (
      await seedActor(pool, { title: `DC (wa-act ${RUN})`, departmentId: dc, role: 'owner' })
    ).token;
    memberToken = (
      await seedActor(pool, { title: `Member (wa-act ${RUN})`, departmentId: dc, role: 'member' })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (wa-act ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (wa-act ${RUN})`,
      departmentId: rescue,
      role: 'member',
    });
    const phone = await pool.query<{ phone: string }>(
      'SELECT phone FROM person WHERE person_id = $1',
      [duty.personId],
    );
    officer = { personId: duty.personId, phone: phone.rows[0]!.phone, token: duty.token };
    other = {
      personId: (
        await seedActor(pool, {
          title: `Other (wa-act ${RUN})`,
          departmentId: rescue,
          role: 'member',
        })
      ).personId,
    };

    const unit = await pool.query<{ unit_id: string }>(
      'INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id',
      [`Rescue ${RUN}`],
    );
    unitId = unit.rows[0]!.unit_id;
    await pool.query('UPDATE person SET activity_unit_id = $2 WHERE person_id = $1', [
      officer.personId,
      unitId,
    ]);
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true });
    if (activitiesRoot !== undefined) await rm(activitiesRoot, { recursive: true, force: true });
  });

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

  let n = 0;
  /** A photo (or video) from `from`, held by the stubbed Meta under a fresh media id. */
  function picture(
    from: string,
    options: { caption?: string; video?: boolean; voice?: boolean; id?: string } = {},
  ): { message: unknown; bytes: Buffer; id: string } {
    n += 1;
    const mediaId = `wa-media-${RUN}-${n}`;
    const bytes =
      options.video === true ? mp4() : options.voice === true ? ogg() : jpeg(`picture ${RUN} ${n}`);
    const type =
      options.video === true ? 'video/mp4' : options.voice === true ? 'audio/ogg' : 'image/jpeg';
    files.set(mediaId, { bytes, type });
    const id = options.id ?? `wamid.in.${RUN}.${n}`;
    const kind = options.video === true ? 'video' : options.voice === true ? 'audio' : 'image';
    return {
      id,
      bytes,
      message: {
        from,
        id,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: kind,
        [kind]: {
          id: mediaId,
          mime_type: type,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ...(options.caption === undefined ? {} : { caption: options.caption }),
          ...(options.voice === true ? { voice: true } : {}),
        },
      },
    };
  }

  /** Words from `from`, with no file. */
  const words = (from: string, text: string): unknown => {
    n += 1;
    return {
      from,
      id: `wamid.in.${RUN}.${n}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: text },
    };
  };

  /** A fresh number nobody holds, per call. */
  let strangers = 0;
  const stranger = (): string => {
    strangers += 1;
    return `${unknownPhone.slice(0, -2)}${String(10 + strangers).slice(-2)}`;
  };

  const tap = (from: string, id: string, title: string): unknown => ({
    from,
    id: `wamid.tap.${RUN}.${randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    interactive: { button_reply: { id, title } },
  });

  /** Texts the server sent to a number since `from` (an index into `sent`). */
  function textsTo(phone: string, from = 0): string[] {
    return sent
      .slice(from)
      .filter((m) => m['to'] === toE164(phone) && m['type'] === 'text')
      .map((m) => (m['text'] as { body: string }).body);
  }

  /** The last question with buttons sent to a number. */
  function lastQuestionTo(
    phone: string,
  ): { text: string; buttons: { id: string; title: string }[] } | null {
    const q = sent
      .filter((m) => m['to'] === toE164(phone) && m['type'] === 'interactive')
      .at(-1) as
      | {
          interactive: {
            body: { text: string };
            action: { buttons: { reply: { id: string; title: string } }[] };
          };
        }
      | undefined;
    if (q === undefined) return null;
    return {
      text: q.interactive.body.text,
      buttons: q.interactive.action.buttons.map((b) => b.reply),
    };
  }

  async function postsBy(personId: string): Promise<
    {
      post_id: string;
      caption: string;
      source: string;
      unit_id: string;
      activity_date: string;
      photos: number;
      videos: number;
      audios: number;
    }[]
  > {
    const { rows } = await pool.query<{
      post_id: string;
      caption: string;
      source: string;
      unit_id: string;
      activity_date: string;
      photos: string;
      videos: string;
      audios: string;
    }>(
      `SELECT p.post_id, p.caption, p.source, p.unit_id,
              to_char(p.activity_date, 'YYYY-MM-DD') AS activity_date,
              (SELECT count(*) FROM activity_media m WHERE m.post_id = p.post_id AND m.kind = 'photo') AS photos,
              (SELECT count(*) FROM activity_media m WHERE m.post_id = p.post_id AND m.kind = 'video') AS videos,
              (SELECT count(*) FROM activity_media m WHERE m.post_id = p.post_id AND m.kind = 'audio') AS audios
         FROM activity_post p WHERE p.author_person_id = $1 ORDER BY p.created_at`,
      [personId],
    );
    return rows.map((r) => ({
      ...r,
      photos: Number(r.photos),
      videos: Number(r.videos),
      audios: Number(r.audios),
    }));
  }

  async function clearPosts(personId: string): Promise<void> {
    await pool.query(`DELETE FROM activity_post WHERE author_person_id = $1`, [personId]);
  }

  /** An emergency, told to the officer over WhatsApp. */
  async function raise(what: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: `wa-act-${RUN}`, severity: 'high', description: what }),
      })
    ).json()) as { incidentId: string };
    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'person', id: officer.personId }] }),
    });
    await runNotifyPass(pool, { incidentIds: [created.incidentId], whatsapp: channel() });
    return created.incidentId;
  }

  /** Close an emergency, so the officer has none open. */
  async function close(incidentId: string): Promise<void> {
    const events = await loadIncident(pool, incidentId);
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'resolved',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: events.length + 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { outcome: 'test over' },
      } as unknown as IncidentEvent,
    ]);
    expect(foldIncident(incidentId, await loadIncident(pool, incidentId)).status).toBe('resolved');
  }

  //----------------------------------------------------------------------------
  // No open emergency
  //----------------------------------------------------------------------------

  it('posts a known sender’s photo to Activities, once, and tells them', async () => {
    await clearPosts(officer.personId);
    const before = sent.length;
    const p = picture(officer.phone, { caption: 'Polio campaign, Khar' });
    expect(await inbound(p.message)).toBe(200);

    const posts = await postsBy(officer.personId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      caption: 'Polio campaign, Khar',
      source: 'whatsapp',
      unit_id: unitId,
      activity_date: districtDate(),
      photos: 1,
    });

    // The bytes are on disk, where the row says, and unchanged.
    const media = await pool.query<{ stored_path: string; sha256: string }>(
      'SELECT stored_path, sha256 FROM activity_media WHERE post_id = $1',
      [posts[0]!.post_id],
    );
    const onDisk = await readFile(join(activitiesRoot, media.rows[0]!.stored_path));
    expect(onDisk.equals(p.bytes)).toBe(true);
    expect(media.rows[0]!.sha256).toBe(createHash('sha256').update(p.bytes).digest('hex'));

    expect(textsTo(officer.phone, before)).toEqual([ADDED_REPLY]);

    // Meta retries a webhook as a matter of routine: the same message is never a second photo.
    expect(await inbound(p.message)).toBe(200);
    expect((await postsBy(officer.personId))[0]!.photos).toBe(1);

    // And it is attributable (INV-06).
    const logged = await pool.query(
      `SELECT 1 FROM activity_log WHERE type = 'posted' AND post_id = $1 AND actor_person_id = $2`,
      [posts[0]!.post_id, officer.personId],
    );
    expect(logged.rowCount).toBe(1);
  });

  it('makes one post of an album sent within five minutes, and confirms it once', async () => {
    await clearPosts(officer.personId);
    const before = sent.length;
    expect(await inbound(picture(officer.phone).message)).toBe(200);
    expect(await inbound(picture(officer.phone, { caption: 'Cleanliness drive' }).message)).toBe(
      200,
    );
    expect(await inbound(picture(officer.phone, { video: true }).message)).toBe(200);

    const posts = await postsBy(officer.personId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ photos: 2, videos: 1, caption: 'Cleanliness drive' });
    expect(textsTo(officer.phone, before)).toEqual([ADDED_REPLY]);

    // The video waits for the converter exactly as an in-app upload does.
    const video = await pool.query<{ status: string; upload_path: string }>(
      `SELECT status, upload_path FROM activity_media WHERE post_id = $1 AND kind = 'video'`,
      [posts[0]!.post_id],
    );
    expect(video.rows[0]!.status).toBe('processing');
    await access(join(activitiesRoot, video.rows[0]!.upload_path));
  });

  it('leaves a voice note and a document alone', async () => {
    await clearPosts(officer.personId);
    expect(
      await inbound({
        from: officer.phone,
        id: `wamid.in.${RUN}.voice`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'audio',
        audio: { id: `wa-media-${RUN}-voice`, mime_type: 'audio/ogg', voice: true },
      }),
    ).toBe(200);
    expect(await postsBy(officer.personId)).toHaveLength(0);
  });

  //----------------------------------------------------------------------------
  // The Pending list
  //----------------------------------------------------------------------------

  it('sends an unknown number to the Pending list, and the DC approves it', async () => {
    const before = sent.length;
    const a = picture(unknownPhone, { caption: 'Road repair, Nawagai' });
    const b = picture(unknownPhone);
    expect(await inbound(a.message)).toBe(200);
    expect(await inbound(b.message)).toBe(200);
    expect(textsTo(unknownPhone, before)).toEqual([PENDING_REPLY]);

    // A member may not see it (INV-05) …
    const refused = await fetch(`${base}/activities/pending`, {
      headers: authHeaders(memberToken),
    });
    expect(refused.status).toBe(403);

    // … the DC may, as one group of two.
    const list = (await (
      await fetch(`${base}/activities/pending`, { headers: authHeaders(dcToken) })
    ).json()) as {
      inboundId: string;
      fromPhone: string;
      reason: string;
      captions: string[];
      media: { mediaId: string; kind: string }[];
    }[];
    const mine = list.find((g) => g.fromPhone === unknownPhone);
    expect(mine).toMatchObject({ reason: 'unknown_sender', captions: ['Road repair, Nawagai'] });
    expect(mine!.media).toHaveLength(2);

    // The DC can look before deciding; nobody else can.
    const seen = await fetch(`${base}/activities/pending/media/${mine!.media[0]!.mediaId}`, {
      headers: authHeaders(dcToken),
    });
    expect(seen.status).toBe(200);
    expect(Buffer.from(await seen.arrayBuffer()).equals(a.bytes)).toBe(true);
    expect(
      (
        await fetch(`${base}/activities/pending/media/${mine!.media[0]!.mediaId}`, {
          headers: authHeaders(memberToken),
        })
      ).status,
    ).toBe(403);

    const approved = await fetch(`${base}/activities/pending/${mine!.inboundId}/approve`, {
      method: 'POST',
      headers: authHeaders(dcToken),
      body: JSON.stringify({ personId: other.personId, unitId }),
    });
    expect(approved.status).toBe(200);

    const posts = await postsBy(other.personId);
    expect(posts.at(-1)).toMatchObject({
      caption: 'Road repair, Nawagai',
      photos: 2,
      source: 'whatsapp',
      unit_id: unitId,
    });
    const gone = await pool.query('SELECT 1 FROM activity_inbound WHERE inbound_id = $1', [
      mine!.inboundId,
    ]);
    expect(gone.rowCount).toBe(0);
    const logged = await pool.query(
      `SELECT 1 FROM activity_log WHERE type = 'pending_approved' AND detail->>'inboundId' = $1`,
      [mine!.inboundId],
    );
    expect(logged.rowCount).toBe(1);

    // Approving twice finds nothing.
    const again = await fetch(`${base}/activities/pending/${mine!.inboundId}/approve`, {
      method: 'POST',
      headers: authHeaders(dcToken),
      body: JSON.stringify({ personId: other.personId, unitId }),
    });
    expect(again.status).toBe(404);
  });

  it('lets the DC reject from the Pending list: rows and files gone, one log line', async () => {
    const stranger = `${unknownPhone.slice(0, -1)}${(Number(unknownPhone.at(-1)) + 1) % 10}`;
    expect(await inbound(picture(stranger).message)).toBe(200);
    const group = await pool.query<{ inbound_id: string }>(
      `SELECT inbound_id FROM activity_inbound WHERE from_phone = $1 AND state = 'pending'`,
      [stranger],
    );
    const inboundId = group.rows[0]!.inbound_id;

    const res = await fetch(`${base}/activities/pending/${inboundId}/reject`, {
      method: 'POST',
      headers: authHeaders(dcToken),
    });
    expect(res.status).toBe(200);
    expect(
      (await pool.query('SELECT 1 FROM activity_inbound WHERE inbound_id = $1', [inboundId]))
        .rowCount,
    ).toBe(0);
    await expect(access(join(activitiesRoot, 'inbox', inboundId))).rejects.toThrow();
    const logged = await pool.query(
      `SELECT 1 FROM activity_log WHERE type = 'pending_rejected' AND detail->>'inboundId' = $1`,
      [inboundId],
    );
    expect(logged.rowCount).toBe(1);
  });

  it('posts a known person with no department under "General" (ADR-0041 §2)', async () => {
    await pool.query('UPDATE person SET activity_unit_id = NULL WHERE person_id = $1', [
      officer.personId,
    ]);
    try {
      await clearPosts(officer.personId);
      expect(await inbound(picture(officer.phone).message)).toBe(200);
      const posts = await postsBy(officer.personId);
      expect(posts).toHaveLength(1);
      const unit = await pool.query<{ name: string }>(
        'SELECT name FROM activity_unit WHERE unit_id = $1',
        [posts[0]!.unit_id],
      );
      expect(unit.rows[0]!.name.toLowerCase()).toBe('general');
    } finally {
      await pool.query('UPDATE person SET activity_unit_id = $2 WHERE person_id = $1', [
        officer.personId,
        unitId,
      ]);
    }
  });

  it('posts a Directory contact’s picture with no login at all (ADR-0041 §1)', async () => {
    const number = `0399${String(parseInt(RUN.slice(2, 8), 16))
      .padStart(7, '0')
      .slice(-7)}`;
    const made = await fetch(`${base}/roster/contacts`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({
        fullName: `Contact ${RUN}`,
        designation: `Field Officer ${RUN}`,
        phone: number,
      }),
    });
    expect(made.status).toBe(201);
    const contact = (await made.json()) as { personId: string };
    const login = await pool.query<{ has: boolean }>(
      'SELECT password_hash IS NOT NULL AS has FROM person WHERE person_id = $1',
      [contact.personId],
    );
    expect(login.rows[0]!.has).toBe(false);

    const before = sent.length;
    expect(await inbound(picture(number, { caption: 'Plantation drive' }).message)).toBe(200);
    expect(await postsBy(contact.personId)).toEqual([
      expect.objectContaining({ caption: 'Plantation drive', photos: 1, source: 'whatsapp' }),
    ]);
    expect(textsTo(number, before)).toEqual([ADDED_REPLY]);
  });

  it('posts a voice note like a picture (ADR-0041 §4)', async () => {
    await clearPosts(officer.personId);
    const v = picture(officer.phone, { voice: true });
    expect(await inbound(v.message)).toBe(200);
    expect(await inbound(picture(officer.phone).message)).toBe(200);
    const posts = await postsBy(officer.personId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ audios: 1, photos: 1 });

    // It plays back for anyone who can see the post.
    const media = await pool.query<{ media_id: string }>(
      `SELECT media_id FROM activity_media WHERE post_id = $1 AND kind = 'audio'`,
      [posts[0]!.post_id],
    );
    const played = await fetch(`${base}/activities/media/${media.rows[0]!.media_id}`, {
      headers: authHeaders(memberToken),
    });
    expect(played.status).toBe(200);
    expect(played.headers.get('content-type')).toBe('audio/ogg');
    expect(Buffer.from(await played.arrayBuffer()).equals(v.bytes)).toBe(true);
  });

  it('keeps an unknown number’s words on the Pending list, and adds it to the Directory', async () => {
    const number = stranger();
    const before = sent.length;
    expect(await inbound(words(number, 'Salam, I am the new tehsildar'))).toBe(200);
    expect(textsTo(number, before)).toEqual([MESSAGE_REPLY]);

    const list = (await (
      await fetch(`${base}/activities/pending`, { headers: authHeaders(controlToken) })
    ).json()) as { inboundId: string; fromPhone: string; messages: string[]; media: unknown[] }[];
    const mine = list.find((g) => g.fromPhone === number)!;
    expect(mine.messages).toEqual(['Salam, I am the new tehsildar']);
    expect(mine.media).toEqual([]);

    // Nothing to post: approving words alone is refused.
    const approve = await fetch(`${base}/activities/pending/${mine.inboundId}/approve`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ personId: officer.personId, unitId }),
    });
    expect(approve.status).toBe(409);

    // Add to Directory: the number becomes a contact, and the group is cleared.
    const added = await fetch(`${base}/activities/pending/${mine.inboundId}/add-contact`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({
        fullName: `Tehsildar ${RUN}`,
        designation: `Tehsildar ${RUN}`,
        unitId,
      }),
    });
    expect(added.status).toBe(201);
    const { personId } = (await added.json()) as { personId: string };
    expect(
      (await pool.query('SELECT 1 FROM activity_inbound WHERE inbound_id = $1', [mine.inboundId]))
        .rowCount,
    ).toBe(0);
    const logged = await pool.query(
      `SELECT 1 FROM activity_log WHERE type = 'contact_added' AND detail->>'personId' = $1`,
      [personId],
    );
    expect(logged.rowCount).toBe(1);

    // From now on their pictures post themselves, in the department the DC chose.
    expect(await inbound(picture(number).message)).toBe(200);
    expect(await postsBy(personId)).toEqual([expect.objectContaining({ unit_id: unitId })]);
  });

  it('adds an unknown number with pictures to the Directory and posts them under it', async () => {
    const number = stranger();
    expect(await inbound(picture(number, { caption: 'Desilting the canal' }).message)).toBe(200);
    expect(await inbound(words(number, 'Work done today'))).toBe(200);
    const group = await pool.query<{ inbound_id: string }>(
      `SELECT inbound_id FROM activity_inbound WHERE from_phone = $1 AND state = 'pending'`,
      [number],
    );
    expect(group.rows).toHaveLength(1);

    const added = await fetch(
      `${base}/activities/pending/${group.rows[0]!.inbound_id}/add-contact`,
      {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ fullName: `Engineer ${RUN}`, designation: `SDO Irrigation ${RUN}` }),
      },
    );
    expect(added.status).toBe(201);
    const { personId, postIds } = (await added.json()) as {
      personId: string;
      postIds: string[];
    };
    expect(postIds).toHaveLength(1);
    const posts = await postsBy(personId);
    // The words sent alongside became the caption; no department chosen → General.
    expect(posts[0]).toMatchObject({ photos: 1, caption: 'Desilting the canal\nWork done today' });

    // Only the administration adds to the Directory.
    expect(await inbound(picture(stranger()).message)).toBe(200);
    const other = await pool.query<{ inbound_id: string }>(
      `SELECT inbound_id FROM activity_inbound
        WHERE state = 'pending' AND reason = 'unknown_sender' ORDER BY created_at DESC LIMIT 1`,
    );
    const refused = await fetch(
      `${base}/activities/pending/${other.rows[0]!.inbound_id}/add-contact`,
      {
        method: 'POST',
        headers: authHeaders(memberToken),
        body: JSON.stringify({ fullName: 'x', designation: 'y' }),
      },
    );
    expect(refused.status).toBe(403);
  });

  //----------------------------------------------------------------------------
  // An open emergency: ask first
  //----------------------------------------------------------------------------

  /**
   * 🔴 **The emergency branch is exactly today's path** — ADR-0040's one hard requirement.
   *
   * The same facts `inboundMedia.test.ts` pins for a photo arriving today: the file is evidence on
   * the incident with the officer's own hash, it is named on the reply's own event, the obligation
   * is settled and the incident acknowledged. And nothing at all happens before the tap.
   */
  it('asks, and "Emergency report" produces exactly today’s evidence and settlement', async () => {
    await clearPosts(officer.personId);
    const incidentId = await raise('house collapse in Mamund');
    const p = picture(officer.phone, { caption: 'this is the house' });
    expect(await inbound(p.message)).toBe(200);

    // Asked, with two buttons naming the incident — and nothing recorded yet, anywhere.
    const q = lastQuestionTo(officer.phone);
    expect(q?.text).toMatch(/open emergency, DNC-BAJAUR-\d+/);
    expect(q?.buttons.map((b) => b.title)).toEqual([EMERGENCY_BUTTON, ACTIVITY_BUTTON]);
    expect(await listFor(pool, incidentId)).toHaveLength(0);
    expect(
      foldIncident(incidentId, await loadIncident(pool, incidentId)).acknowledgedAt,
    ).toBeNull();
    expect(await postsBy(officer.personId)).toHaveLength(0);

    expect(await inbound(tap(officer.phone, q!.buttons[0]!.id, EMERGENCY_BUTTON))).toBe(200);

    const held = await listFor(pool, incidentId);
    expect(held).toHaveLength(1);
    expect(held[0]?.contentType).toBe('image/jpeg');
    expect(held[0]?.sha256).toBe(createHash('sha256').update(p.bytes).digest('hex'));
    const onDisk = await readFile(join(evidenceRoot, incidentId, `${held[0]!.evidenceId}.jpg`));
    expect(onDisk.equals(p.bytes)).toBe(true);

    const events = await loadIncident(pool, incidentId);
    const logged = events
      .filter((e) => e.type === 'action_logged')
      .map((e) => e.payload as { note: string; evidenceIds?: readonly string[] })
      .find((x) => x.evidenceIds !== undefined);
    expect(logged?.evidenceIds).toEqual([held[0]!.evidenceId]);
    expect(logged?.note).toContain('this is the house');
    expect(logged?.note).toContain('the match is exact');

    const state = foldIncident(incidentId, events);
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.notifications.every((a) => a.state !== 'pending')).toBe(true);

    // Nothing left held, nothing posted.
    expect(
      (await pool.query('SELECT 1 FROM activity_inbound WHERE incident_id = $1', [incidentId]))
        .rowCount,
    ).toBe(0);
    expect(await postsBy(officer.personId)).toHaveLength(0);

    // A second tap on the same question does nothing but say so.
    const before = sent.length;
    expect(await inbound(tap(officer.phone, q!.buttons[0]!.id, EMERGENCY_BUTTON))).toBe(200);
    expect(await listFor(pool, incidentId)).toHaveLength(1);
    expect(textsTo(officer.phone, before)).toEqual(['This has already been dealt with.']);

    await close(incidentId);
  });

  it('"Daily activity" posts it and leaves the emergency untouched', async () => {
    await clearPosts(officer.personId);
    const incidentId = await raise('flood warning, Salarzai');
    expect(await inbound(picture(officer.phone, { caption: 'Tree plantation' }).message)).toBe(200);
    // A second photo within five minutes joins the same question rather than asking again.
    const asked = sent.filter((m) => m['type'] === 'interactive').length;
    expect(await inbound(picture(officer.phone).message)).toBe(200);
    expect(sent.filter((m) => m['type'] === 'interactive').length).toBe(asked);

    const q = lastQuestionTo(officer.phone)!;
    const before = sent.length;
    expect(await inbound(tap(officer.phone, q.buttons[1]!.id, ACTIVITY_BUTTON))).toBe(200);

    const posts = await postsBy(officer.personId);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ photos: 2, caption: 'Tree plantation', source: 'whatsapp' });
    expect(textsTo(officer.phone, before)).toEqual([ADDED_REPLY]);

    expect(await listFor(pool, incidentId)).toHaveLength(0);
    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.acknowledgedAt).toBeNull();
    expect(state.notifications.some((a) => a.state === 'pending')).toBe(true);

    await close(incidentId);
  });

  it('sends an unanswered picture to its emergency after an hour, never to Activities', async () => {
    await clearPosts(officer.personId);
    const incidentId = await raise('fire in the bazaar');
    expect(await inbound(picture(officer.phone).message)).toBe(200);
    const q = lastQuestionTo(officer.phone)!;
    const toEmergency = emergencyPathFor(pool, config, evidenceRoot, stubFetch);

    // Fifty-nine minutes: still waiting.
    await pool.query(
      `UPDATE activity_inbound SET state_at = now() - interval '59 minutes' WHERE incident_id = $1`,
      [incidentId],
    );
    await sweepInbound(pool, activitiesRoot, toEmergency);
    expect(await listFor(pool, incidentId)).toHaveLength(0);

    await pool.query(
      `UPDATE activity_inbound SET state_at = now() - interval '61 minutes' WHERE incident_id = $1`,
      [incidentId],
    );
    await sweepInbound(pool, activitiesRoot, toEmergency);

    // Today's evidence, today's settlement — and the note says they did not answer.
    expect(await listFor(pool, incidentId)).toHaveLength(1);
    const events = await loadIncident(pool, incidentId);
    const note = events
      .filter((e) => e.type === 'action_logged')
      .map((e) => (e.payload as { note: string }).note)
      .join('\n');
    expect(note).toContain('did not answer within the hour');
    expect(note).not.toContain('they chose this incident');
    expect(foldIncident(incidentId, events).acknowledgedAt).not.toBeNull();
    expect(await postsBy(officer.personId)).toHaveLength(0);
    expect(
      (await pool.query('SELECT 1 FROM activity_inbound WHERE incident_id = $1', [incidentId]))
        .rowCount,
    ).toBe(0);

    // A tap after that finds nothing left to decide.
    const before = sent.length;
    expect(await inbound(tap(officer.phone, q.buttons[1]!.id, ACTIVITY_BUTTON))).toBe(200);
    expect(textsTo(officer.phone, before)).toEqual(['This has already been dealt with.']);
    expect(await postsBy(officer.personId)).toHaveLength(0);

    await close(incidentId);
  });

  it('posts directly once the emergency is closed', async () => {
    await clearPosts(officer.personId);
    const incidentId = await raise('landslide on the road');
    await close(incidentId);
    expect(await inbound(picture(officer.phone).message)).toBe(200);
    expect(await postsBy(officer.personId)).toHaveLength(1);
    expect(await listFor(pool, incidentId)).toHaveLength(0);
  });

  //----------------------------------------------------------------------------
  // The date (ADR-0040 §5)
  //----------------------------------------------------------------------------

  it('lets the author change the date, never into the future, and logs it', async () => {
    const post = (await postsBy(officer.personId)).at(-1)!;
    const yesterday = districtDate(new Date(Date.now() - 36 * 3600_000));
    const res = await fetch(`${base}/activities/posts/${post.post_id}/date`, {
      method: 'PUT',
      headers: authHeaders(officer.token),
      body: JSON.stringify({ activityDate: yesterday }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { activityDate: string }).activityDate).toBe(yesterday);

    const future = await fetch(`${base}/activities/posts/${post.post_id}/date`, {
      method: 'PUT',
      headers: authHeaders(officer.token),
      body: JSON.stringify({ activityDate: '2999-01-01' }),
    });
    expect(future.status).toBe(400);

    // Somebody else's post is theirs to see (ADR-0041 §7), not to change.
    const notYours = await fetch(`${base}/activities/posts/${post.post_id}/date`, {
      method: 'PUT',
      headers: authHeaders(memberToken),
      body: JSON.stringify({ activityDate: yesterday }),
    });
    expect(notYours.status).toBe(403);

    const logged = await pool.query(
      `SELECT 1 FROM activity_log WHERE type = 'date_changed' AND post_id = $1`,
      [post.post_id],
    );
    expect(logged.rowCount).toBe(1);
  });
});
