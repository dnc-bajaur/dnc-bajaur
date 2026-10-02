/**
 * Activities, phase C3 — videos (ADR-0039 §3–4, Bajaur). Over real HTTP (INV-05: refusals
 * proven from outside the UI); the converter runs with stand-in tools here, and with the real
 * ffmpeg in `jobs/__tests__/activitiesVideoTools.test.ts`.
 *
 * What is pinned:
 *
 *   * a video arrives in chunks, in order: the server says how much arrived, a chunk at the
 *     wrong offset is refused, and the last one makes it `processing` and logs who sent it;
 *   * the first chunk is checked by its bytes — not a video, and the place is given back;
 *   * 300 MB, three minutes (when the phone says so) and three videos a post; only the author
 *     sends, and only after a forced password change;
 *   * the converter makes it `ready` — 720p file served with byte ranges, a poster frame, the
 *     original deleted — or `failed` with the reason, a log line, and its place given back;
 *   * with ffmpeg missing, nothing is failed: the video waits, and converts once it is there;
 *   * a post deleted mid-upload leaves no file; an upload abandoned for a day is given up;
 *   * only a ready video is backed up, counted in the 30-day warning, and put in the ZIP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import { districtDate } from '../../domain/districtTime.js';
import type { Role } from '../../domain/roles.js';
import { dropAbandonedUploads, parseRange } from '../activities.js';
import { runConversions, ToolMissing, type VideoTools } from '../../jobs/activitiesVideo.js';
import { runHousekeeping } from '../../jobs/activitiesRetention.js';
import type { MediaStore } from '../../ops/offsite.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'activities-video-password-2026';

/** Enough of an MP4 for the magic-number check: a `ftyp` box with the `isom` brand. */
function mp4(size: number): Buffer {
  const b = Buffer.alloc(size, 0x22);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}

/** A JPEG for the stand-in poster. */
const POSTER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

/** Stand-in ffmpeg: "converts" by copying, and reports the length it is told to. */
function fakeTools(seconds = 42): VideoTools & { converted: string[] } {
  const converted: string[] = [];
  return {
    converted,
    probe: () => Promise.resolve({ durationSeconds: seconds }),
    async convert(input, output) {
      converted.push(input);
      await copyFile(input, output);
    },
    async poster(_video, output) {
      await writeFile(output, POSTER);
    },
  };
}

const missingTools: VideoTools = {
  probe: () => Promise.reject(new ToolMissing('ffprobe is not installed on this server')),
  convert: () => Promise.reject(new ToolMissing('ffmpeg is not installed on this server')),
  poster: () => Promise.reject(new ToolMissing('ffmpeg is not installed on this server')),
};

describe('parseRange — what a video player asks for', () => {
  it('reads the three forms, clamps the end, and refuses what lies past the end', () => {
    expect(parseRange(undefined, 100)).toBe('whole');
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=20-10', 100)).toBeNull();
    // Several ranges, or another unit: the whole file, as RFC 9110 permits.
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('whole');
    expect(parseRange('items=0-1', 100)).toBe('whole');
  });
});

const maybe = dbUrl ? describe : describe.skip;

maybe('Activities videos (ADR-0039, phase C3)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;
  let kicks = 0;

  let admin: string;
  let author: { token: string; personId: string };
  let other: { token: string; personId: string };
  let unitId: string;

  async function account(
    role: Role,
    mustChange = false,
  ): Promise<{ token: string; personId: string }> {
    const phone = `+92303${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [`Video ${role}`, phone, await hashPassword(PASSWORD), role, mustChange],
    );
    return {
      token: (await login(pool, phone, PASSWORD))!.token,
      personId: res.rows[0]!.person_id,
    };
  }

  const call = (
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined || Buffer.isBuffer(body)
          ? {}
          : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

  async function newPost(token = author.token): Promise<string> {
    const res = await call(token, '/activities/posts', 'POST', {
      unitId,
      activityDate: districtDate(),
      caption: 'Polio campaign, day two',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { postId: string }).postId;
  }

  interface State {
    mediaId: string;
    status: string;
    received: number;
    bytes: number;
    chunkBytes: number;
  }

  async function start(
    postId: string,
    input: Record<string, unknown>,
    token = author.token,
  ): Promise<Response> {
    return call(token, `/activities/posts/${postId}/videos`, 'POST', input, {});
  }

  const chunk = (mediaId: string, offset: number, bytes: Buffer, token = author.token) =>
    call(token, `/activities/uploads/${mediaId}`, 'PUT', bytes, {
      'content-type': 'application/octet-stream',
      'x-upload-offset': String(offset),
    });

  /** A whole video, sent in chunks of `size`. Returns its media id. */
  async function upload(postId: string, video: Buffer, size = 1000): Promise<string> {
    const res = await start(postId, { bytes: video.length, contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    const { mediaId } = (await res.json()) as State;
    for (let at = 0; at < video.length; at += size) {
      const sent = await chunk(mediaId, at, video.subarray(at, at + size));
      expect(sent.status).toBe(200);
    }
    return mediaId;
  }

  async function postView(postId: string, token = author.token) {
    const res = await call(token, '/activities/posts');
    const body = (await res.json()) as {
      posts: {
        postId: string;
        mayAddVideos: boolean;
        videos: {
          mediaId: string;
          status: string;
          durationSeconds: number | null;
          failure: string | null;
          hasPoster: boolean;
        }[];
      }[];
    };
    return body.posts.find((p) => p.postId === postId)!;
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-videos-'));
    server = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      activitiesRoot: root,
      onVideoUploaded: () => {
        kicks += 1;
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    admin = (await account('admin')).token;
    author = await account('member');
    other = await account('member');

    const made = await call(admin, '/activities/units', 'POST', { name: `Health ${randomUUID()}` });
    expect(made.status).toBe(201);
    unitId = ((await made.json()) as { unitId: string }).unitId;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  describe('sending', () => {
    it('arrives in chunks, in order, and resumes from what the server says arrived', async () => {
      const postId = await newPost();
      const video = mp4(2500);
      const started = await start(postId, { bytes: video.length, contentType: 'video/mp4' });
      expect(started.status).toBe(201);
      const s = (await started.json()) as State;
      expect(s).toMatchObject({ status: 'uploading', received: 0, bytes: 2500 });
      expect(s.chunkBytes).toBeGreaterThan(0);

      expect((await chunk(s.mediaId, 0, video.subarray(0, 1000))).status).toBe(200);
      // The answer to the next chunk was lost; the phone sends it again.
      expect((await chunk(s.mediaId, 1000, video.subarray(1000, 2000))).status).toBe(200);
      const twice = await chunk(s.mediaId, 1000, video.subarray(1000, 2000));
      expect(twice.status).toBe(409);
      // Skipping ahead is refused too.
      expect((await chunk(s.mediaId, 2400, video.subarray(2400))).status).toBe(409);

      const asked = await call(author.token, `/activities/uploads/${s.mediaId}`);
      expect(await asked.json()).toMatchObject({ status: 'uploading', received: 2000 });

      // More than the video has left is refused.
      expect((await chunk(s.mediaId, 2000, mp4(600))).status).toBe(413);

      const kicked = kicks;
      const last = await chunk(s.mediaId, 2000, video.subarray(2000));
      expect(last.status).toBe(200);
      expect(await last.json()).toMatchObject({ status: 'processing', received: 2500 });
      expect(kicks).toBe(kicked + 1);

      const after = await chunk(s.mediaId, 2500, mp4(10));
      expect(after.status).toBe(409);

      const logged = await pool.query<{ actor_person_id: string }>(
        `SELECT actor_person_id FROM activity_log WHERE type = 'video_added' AND post_id = $1`,
        [postId],
      );
      expect(logged.rows).toEqual([{ actor_person_id: author.personId }]);

      // Not shown until converted.
      expect((await call(author.token, `/activities/media/${s.mediaId}`)).status).toBe(409);
      expect((await postView(postId)).videos[0]).toMatchObject({ status: 'processing' });
    });

    it('checks the first chunk by its bytes, and gives the place back', async () => {
      const postId = await newPost();
      const res = await start(postId, { bytes: 100, contentType: 'video/mp4' });
      const { mediaId } = (await res.json()) as State;
      const jpeg = Buffer.alloc(100, 1);
      jpeg[0] = 0xff;
      jpeg[1] = 0xd8;
      jpeg[2] = 0xff;
      expect((await chunk(mediaId, 0, jpeg)).status).toBe(415);
      const row = await pool.query('SELECT 1 FROM activity_media WHERE media_id = $1', [mediaId]);
      expect(row.rowCount).toBe(0);
      expect(readdirSync(join(root, postId))).toEqual([]);
    });

    it('refuses what is too large, too long, not a video, or one too many', async () => {
      const postId = await newPost();
      expect(
        (await start(postId, { bytes: 300 * 1024 * 1024 + 1, contentType: 'video/mp4' })).status,
      ).toBe(413);
      expect((await start(postId, { bytes: 10, contentType: 'image/jpeg' })).status).toBe(415);
      expect(
        (await start(postId, { bytes: 10, contentType: 'video/mp4', durationSeconds: 200 })).status,
      ).toBe(400);
      expect((await start(postId, { contentType: 'video/mp4' })).status).toBe(400);

      for (let i = 0; i < 3; i += 1) {
        expect((await start(postId, { bytes: 10, contentType: 'video/quicktime' })).status).toBe(
          201,
        );
      }
      expect((await start(postId, { bytes: 10, contentType: 'video/mp4' })).status).toBe(409);
      expect((await postView(postId)).mayAddVideos).toBe(false);
    });

    it('is the author’s alone, and only after a forced password change', async () => {
      const postId = await newPost();
      expect(
        (await start(postId, { bytes: 10, contentType: 'video/mp4' }, other.token)).status,
      ).toBe(403);
      const res = await start(postId, { bytes: 10, contentType: 'video/mp4' });
      const { mediaId } = (await res.json()) as State;
      expect((await chunk(mediaId, 0, mp4(10), other.token)).status).toBe(404);
      expect((await call(other.token, `/activities/uploads/${mediaId}`)).status).toBe(404);
      expect((await chunk(mediaId, 0, mp4(10), admin)).status).toBe(404);

      const fresh = await account('member', true);
      const own = await pool.query<{ post_id: string }>(
        `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption)
         VALUES ($1, $2, current_date, 'Not yet') RETURNING post_id`,
        [unitId, fresh.personId],
      );
      expect(
        (await start(own.rows[0]!.post_id, { bytes: 10, contentType: 'video/mp4' }, fresh.token))
          .status,
      ).toBe(403);
    });
  });

  describe('converting', () => {
    it('makes it ready: served with byte ranges, a poster, the original deleted', async () => {
      const postId = await newPost();
      const video = mp4(3000);
      const mediaId = await upload(postId, video);
      const tools = fakeTools(42.5);

      const pass = await runConversions({ pool, root, tools });
      expect(pass.ran).toBe(true);
      expect(pass.converted).toBeGreaterThanOrEqual(1);
      expect(readdirSync(join(root, postId)).sort()).toEqual(
        [`${mediaId}.mp4`, `${mediaId}.poster.jpg`].sort(),
      );

      const view = await postView(postId);
      expect(view.videos[0]).toEqual({
        mediaId,
        status: 'ready',
        durationSeconds: 42.5,
        failure: null,
        hasPoster: true,
      });
      // Seen by those who may see the post: the DC office, not another member.
      expect((await postView(postId, admin)).videos[0]?.status).toBe('ready');

      const whole = await call(author.token, `/activities/media/${mediaId}`);
      expect(whole.status).toBe(200);
      expect(whole.headers.get('content-type')).toBe('video/mp4');
      expect(whole.headers.get('accept-ranges')).toBe('bytes');
      expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
      expect(whole.headers.get('content-security-policy')).toContain('sandbox');
      expect(Buffer.from(await whole.arrayBuffer()).equals(video)).toBe(true);

      const part = await call(author.token, `/activities/media/${mediaId}`, 'GET', undefined, {
        range: 'bytes=100-199',
      });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 100-199/3000');
      expect(Buffer.from(await part.arrayBuffer()).equals(video.subarray(100, 200))).toBe(true);

      const past = await call(author.token, `/activities/media/${mediaId}`, 'GET', undefined, {
        range: 'bytes=5000-',
      });
      expect(past.status).toBe(416);
      expect(past.headers.get('content-range')).toBe('bytes */3000');

      const poster = await call(author.token, `/activities/media/${mediaId}?size=thumb`);
      expect(poster.status).toBe(200);
      expect(poster.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await poster.arrayBuffer()).equals(POSTER)).toBe(true);

      const etag = whole.headers.get('etag')!;
      const again = await call(author.token, `/activities/media/${mediaId}`, 'GET', undefined, {
        'if-none-match': etag,
      });
      expect(again.status).toBe(304);

      // Every account sees every post (ADR-0041 §7) — so the converted video plays for them too.
      expect((await call(other.token, `/activities/media/${mediaId}`)).status).toBe(200);
    });

    it('fails one that is too long — the reason kept, logged, its place given back', async () => {
      const postId = await newPost();
      const mediaId = await upload(postId, mp4(1200));
      const pass = await runConversions({ pool, root, tools: fakeTools(185) });
      expect(pass.failed).toBeGreaterThanOrEqual(1);

      const view = await postView(postId);
      expect(view.videos[0]).toMatchObject({ mediaId, status: 'failed' });
      expect(view.videos[0]!.failure).toMatch(/3:05 long/);
      expect(view.mayAddVideos).toBe(true);
      expect(readdirSync(join(root, postId))).toEqual([]);

      const logged = await pool.query<{
        actor_person_id: string | null;
        detail: { reason: string };
      }>(
        `SELECT actor_person_id, detail FROM activity_log WHERE type = 'video_failed' AND post_id = $1`,
        [postId],
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0]!.actor_person_id).toBeNull();
      expect(logged.rows[0]!.detail.reason).toMatch(/at most 3 minutes/);

      for (let i = 0; i < 3; i += 1) {
        expect((await start(postId, { bytes: 10, contentType: 'video/mp4' })).status).toBe(201);
      }
    });

    it('fails one ffmpeg refuses, with ffmpeg’s own words', async () => {
      const postId = await newPost();
      const mediaId = await upload(postId, mp4(800));
      const broken: VideoTools = {
        ...fakeTools(),
        convert: () => Promise.reject(new Error('moov atom not found')),
      };
      await runConversions({ pool, root, tools: broken });
      const row = await pool.query<{ status: string; failure: string }>(
        'SELECT status, failure FROM activity_media WHERE media_id = $1',
        [mediaId],
      );
      expect(row.rows[0]).toEqual({
        status: 'failed',
        failure: 'ffmpeg could not convert it: moov atom not found',
      });
    });

    it('with ffmpeg missing, fails nothing: the video waits, then converts', async () => {
      const postId = await newPost();
      const mediaId = await upload(postId, mp4(900));
      const waiting = await runConversions({ pool, root, tools: missingTools });
      expect(waiting.waiting).toMatch(/not installed/);
      expect(waiting.failed).toBe(0);
      const still = await pool.query<{ status: string }>(
        'SELECT status FROM activity_media WHERE media_id = $1',
        [mediaId],
      );
      expect(still.rows[0]!.status).toBe('processing');
      expect(existsSync(join(root, postId, `${mediaId}.upload`))).toBe(true);

      // The DC's warning counts it once it has waited an hour.
      await pool.query(
        `UPDATE activity_media SET status_at = now() - interval '2 hours' WHERE media_id = $1`,
        [mediaId],
      );
      const warn = await call(admin, '/activities/expiring');
      const x = (await warn.json()) as { conversion: { waiting: number } };
      expect(x.conversion.waiting).toBeGreaterThanOrEqual(1);

      await runConversions({ pool, root, tools: fakeTools() });
      const done = await pool.query<{ status: string }>(
        'SELECT status FROM activity_media WHERE media_id = $1',
        [mediaId],
      );
      expect(done.rows[0]!.status).toBe('ready');
    });
  });

  describe('deleting and giving up', () => {
    it('removes a half-sent video with its post, and says how many videos went', async () => {
      const postId = await newPost();
      const res = await start(postId, { bytes: 5000, contentType: 'video/mp4' });
      const { mediaId } = (await res.json()) as State;
      expect((await chunk(mediaId, 0, mp4(1000))).status).toBe(200);

      expect((await call(author.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(200);
      expect(existsSync(join(root, postId))).toBe(false);
      const line = await pool.query<{ detail: { photos: number; videos: number } }>(
        `SELECT detail FROM activity_log WHERE type = 'deleted' AND post_id = $1`,
        [postId],
      );
      expect(line.rows[0]!.detail).toMatchObject({ photos: 0, videos: 1 });
    });

    it('gives up an upload with no chunk for a day', async () => {
      const postId = await newPost();
      const res = await start(postId, { bytes: 5000, contentType: 'video/mp4' });
      const { mediaId } = (await res.json()) as State;
      expect((await chunk(mediaId, 0, mp4(1000))).status).toBe(200);
      await pool.query(
        `UPDATE activity_media SET status_at = now() - interval '25 hours' WHERE media_id = $1`,
        [mediaId],
      );
      expect(await dropAbandonedUploads(pool, root)).toBeGreaterThanOrEqual(1);
      const row = await pool.query('SELECT 1 FROM activity_media WHERE media_id = $1', [mediaId]);
      expect(row.rowCount).toBe(0);
      expect(existsSync(join(root, postId, `${mediaId}.upload`))).toBe(false);
      expect((await call(author.token, `/activities/uploads/${mediaId}`)).status).toBe(404);
    });
  });

  describe('thirty days and the backup', () => {
    it('backs up, counts and zips only a ready video', async () => {
      const postId = await newPost();
      const ready = await upload(postId, mp4(1500));
      await runConversions({ pool, root, tools: fakeTools() });
      const half = await start(postId, { bytes: 5000, contentType: 'video/mp4' });
      const unfinished = ((await half.json()) as State).mediaId;
      expect((await chunk(unfinished, 0, mp4(1000))).status).toBe(200);

      const keys: string[] = [];
      const bucket: MediaStore = {
        configured: true,
        why: null,
        put: (key) => {
          keys.push(key);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      };
      await runHousekeeping({
        pool,
        root,
        store: bucket,
        passphrase: 'activities-video-passphrase-2026',
      });
      expect(keys).toContain(`activities/${postId}/${ready}.mp4.enc`);
      expect(keys).toContain(`activities/${postId}/${ready}.poster.jpg.enc`);
      expect(keys.some((k) => k.includes(unfinished))).toBe(false);

      // Into the warning window: 28 days old.
      await pool.query(
        `UPDATE activity_post SET created_at = now() - interval '28 days' WHERE post_id = $1`,
        [postId],
      );
      const warn = await call(admin, '/activities/expiring');
      const x = (await warn.json()) as { videos: number; bytes: number };
      expect(x.videos).toBeGreaterThanOrEqual(1);

      const zip = await call(admin, '/activities/expiring.zip');
      expect(zip.status).toBe(200);
      const bytes = Buffer.from(await zip.arrayBuffer());
      const names = bytes.toString('latin1');
      expect(names).toMatch(new RegExp(`${postId.slice(0, 8)}/video-01\\.mp4`));
      expect(names).not.toMatch(/video-02/);

      await call(admin, `/activities/posts/${postId}`, 'DELETE');
    });
  });
});
