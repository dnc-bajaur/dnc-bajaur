/**
 * Activities, phase C1 — ADR-0039 (Bajaur). Over real HTTP (INV-05: refusals proven from
 * outside the UI).
 *
 * What is pinned:
 *
 *   * only the DC / DNC keep the Department list; names are unique among live departments;
 *   * posting is refused until a forced password change is done, and a date in the future is
 *     refused;
 *   * photos are checked by their bytes, ten per post at most, added by the author only;
 *   * a member sees only their own posts — in the list and when fetching a photo; an operator
 *     sees everyone's; the filters narrow by department, person and date;
 *   * the author hard-deletes their own post — rows and files gone, one log line left; a deny
 *     override takes that away; a moderator hides, restores and hard-deletes anybody's;
 *   * a photo is served inline with its sniffed type, `nosniff` and a sandbox, and revalidates
 *     to 304;
 *   * `activity_log` is append-only, and nothing is written to the incident log or evidence.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'activities-password-2026';

/** Enough of a JPEG for the magic-number check: SOI and the first marker, then filler. */
function jpeg(size = 64): Buffer {
  const b = Buffer.alloc(size, 0x11);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  return b;
}

const maybe = dbUrl ? describe : describe.skip;

maybe('Activities (ADR-0039, phase C1)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;

  let admin: string;
  let operator: string;
  let memberA: { token: string; personId: string };
  let memberB: { token: string; personId: string };
  let unitId: string;
  let otherUnitId: string;

  async function account(
    role: Role,
    mustChange = false,
  ): Promise<{ token: string; personId: string }> {
    const phone = `+92301${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [`Activities ${role}`, phone, await hashPassword(PASSWORD), role, mustChange],
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

  async function post(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; postId: string }> {
    const res = await call(token, '/activities/posts', 'POST', {
      unitId,
      activityDate: districtDate(),
      caption: 'Cleaned the drains on the main road',
      place: 'Khar',
      ...overrides,
    });
    const body = (await res.json()) as { postId: string };
    return { status: res.status, postId: body.postId };
  }

  const photo = (
    token: string,
    postId: string,
    bytes = jpeg(),
    thumb?: Buffer,
  ): Promise<Response> =>
    call(
      token,
      `/activities/posts/${postId}/photos`,
      'POST',
      thumb === undefined ? bytes : Buffer.concat([thumb, bytes]),
      {
        'content-type': 'image/jpeg',
        ...(thumb === undefined ? {} : { 'x-thumb-bytes': String(thumb.length) }),
      },
    );

  async function feed(token: string, query = ''): Promise<string[]> {
    const res = await call(token, `/activities/posts${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { posts: { postId: string }[] };
    return body.posts.map((p) => p.postId);
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-activities-'));
    server = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      activitiesRoot: root,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    admin = (await account('admin')).token;
    operator = (await account('operator')).token;
    memberA = await account('member');
    memberB = await account('member');

    const made = await call(admin, '/activities/units', 'POST', { name: `Rescue ${randomUUID()}` });
    expect(made.status).toBe(201);
    unitId = ((await made.json()) as { unitId: string }).unitId;
    const other = await call(admin, '/activities/units', 'POST', { name: `TMA ${randomUUID()}` });
    otherUnitId = ((await other.json()) as { unitId: string }).unitId;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  describe('the Department list', () => {
    it('is kept by the DC / DNC only', async () => {
      const res = await call(memberA.token, '/activities/units', 'POST', { name: 'Mine' });
      expect(res.status).toBe(403);
      const op = await call(operator, '/activities/units', 'POST', { name: 'Mine' });
      expect(op.status).toBe(403);
    });

    it('refuses a second live department with the same name, in any case', async () => {
      const name = `Health ${randomUUID()}`;
      expect((await call(admin, '/activities/units', 'POST', { name })).status).toBe(201);
      const again = await call(admin, '/activities/units', 'POST', { name: name.toUpperCase() });
      expect(again.status).toBe(409);
    });

    it('renames and retires; a retired one cannot take new posts', async () => {
      const made = await call(admin, '/activities/units', 'POST', { name: `Old ${randomUUID()}` });
      const id = ((await made.json()) as { unitId: string }).unitId;
      const renamed = await call(admin, `/activities/units/${id}`, 'PATCH', {
        name: `New ${randomUUID()}`,
      });
      expect(renamed.status).toBe(200);
      expect((await call(admin, `/activities/units/${id}/retire`, 'POST')).status).toBe(200);
      expect((await post(memberA.token, { unitId: id })).status).toBe(400);
    });

    it('lets anyone set their own default, but only the DC / DNC set somebody else’s', async () => {
      const own = await call(memberA.token, '/activities/default-unit', 'PUT', { unitId });
      expect(own.status).toBe(200);
      const me = (await (await call(memberA.token, '/activities/me')).json()) as {
        defaultUnitId: string;
      };
      expect(me.defaultUnitId).toBe(unitId);

      const other = await call(memberA.token, '/activities/default-unit', 'PUT', {
        personId: memberB.personId,
        unitId,
      });
      expect(other.status).toBe(403);
      const byAdmin = await call(admin, '/activities/default-unit', 'PUT', {
        personId: memberB.personId,
        unitId: otherUnitId,
      });
      expect(byAdmin.status).toBe(200);
    });
  });

  it('takes the default department from "Add account"', async () => {
    const phone = `+92302${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const res = await call(admin, '/settings/accounts', 'POST', {
      fullName: 'New Officer',
      phone,
      role: 'member',
      password: 'temporary-password-2026',
      activityUnitId: unitId,
    });
    expect(res.status).toBe(201);
    const { personId } = (await res.json()) as { personId: string };
    const row = await pool.query<{ activity_unit_id: string }>(
      'SELECT activity_unit_id FROM person WHERE person_id = $1',
      [personId],
    );
    expect(row.rows[0]!.activity_unit_id).toBe(unitId);
  });

  describe('posting', () => {
    it('is refused until a forced password change is done', async () => {
      const fresh = await account('member', true);
      expect((await post(fresh.token)).status).toBe(403);

      const changed = await call(fresh.token, '/auth/password', 'POST', {
        currentPassword: PASSWORD,
        newPassword: 'activities-own-password-2026',
      });
      expect(changed.status).toBe(200);
      expect((await post(fresh.token)).status).toBe(201);
    });

    it('refuses a date in the future and an empty caption', async () => {
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      expect((await post(memberA.token, { activityDate: future })).status).toBe(400);
      expect((await post(memberA.token, { caption: '   ' })).status).toBe(400);
    });

    it('is refused when the upload permission is denied', async () => {
      const denied = await account('member');
      await pool.query(
        `INSERT INTO person_permission (person_id, permission, effect)
         VALUES ($1, 'activities.upload', 'deny')`,
        [denied.personId],
      );
      expect((await post(denied.token)).status).toBe(403);
    });
  });

  describe('photos', () => {
    it('are checked by their bytes, not by what the phone said', async () => {
      const { postId } = await post(memberA.token);
      const fake = Buffer.from('<script>alert(1)</script>', 'utf8');
      expect((await photo(memberA.token, postId, fake)).status).toBe(415);
      expect((await photo(memberA.token, postId, jpeg(), Buffer.from('not a jpeg'))).status).toBe(
        415,
      );
      expect((await photo(memberA.token, postId, jpeg(), jpeg(32))).status).toBe(201);
    });

    it('are added only by the author, ten at most', async () => {
      const { postId } = await post(memberA.token);
      // Somebody else's post is not even visible to another member.
      expect((await photo(memberB.token, postId)).status).toBe(404);
      // An operator can see it, and still may not add to it.
      expect((await photo(operator, postId)).status).toBe(403);

      for (let i = 0; i < 10; i += 1) {
        expect((await photo(memberA.token, postId)).status).toBe(201);
      }
      expect((await photo(memberA.token, postId)).status).toBe(409);
    });

    it('are served inline, safely, and revalidate', async () => {
      const { postId } = await post(memberA.token);
      const added = await photo(memberA.token, postId, jpeg(100), jpeg(40));
      const { mediaId } = (await added.json()) as { mediaId: string };

      const full = await call(memberA.token, `/activities/media/${mediaId}`);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('image/jpeg');
      expect(full.headers.get('x-content-type-options')).toBe('nosniff');
      expect(full.headers.get('content-security-policy')).toContain('sandbox');
      expect((await full.arrayBuffer()).byteLength).toBe(100);

      const thumb = await call(memberA.token, `/activities/media/${mediaId}?size=thumb`);
      expect((await thumb.arrayBuffer()).byteLength).toBe(40);

      const again = await call(memberA.token, `/activities/media/${mediaId}`, 'GET', undefined, {
        'if-none-match': full.headers.get('etag')!,
      });
      expect(again.status).toBe(304);

      // Another member cannot fetch it; an operator can.
      expect((await call(memberB.token, `/activities/media/${mediaId}`)).status).toBe(404);
      expect((await call(operator, `/activities/media/${mediaId}`)).status).toBe(200);
    });
  });

  describe('who sees what', () => {
    it('shows a member only their own posts, and an operator everyone’s', async () => {
      const a = await post(memberA.token);
      const b = await post(memberB.token, { unitId: otherUnitId });

      const seenByA = await feed(memberA.token);
      expect(seenByA).toContain(a.postId);
      expect(seenByA).not.toContain(b.postId);
      // Asking for somebody else's posts does not widen a member's view.
      expect(await feed(memberA.token, `?person=${memberB.personId}`)).not.toContain(b.postId);

      const seenByOp = await feed(operator);
      expect(seenByOp).toEqual(expect.arrayContaining([a.postId, b.postId]));

      // The people list is for those who may see everyone.
      expect((await call(memberA.token, '/activities/people')).status).toBe(403);
      expect((await call(operator, '/activities/people')).status).toBe(200);
    });

    it('filters by department, person and date', async () => {
      const a = await post(memberA.token);
      const b = await post(memberB.token, { unitId: otherUnitId, activityDate: '2026-01-15' });

      const byUnit = await feed(operator, `?unit=${otherUnitId}`);
      expect(byUnit).toContain(b.postId);
      expect(byUnit).not.toContain(a.postId);

      const byPerson = await feed(operator, `?person=${memberA.personId}`);
      expect(byPerson).toContain(a.postId);
      expect(byPerson).not.toContain(b.postId);

      const byDate = await feed(operator, '?from=2026-01-15&to=2026-01-15');
      expect(byDate).toContain(b.postId);
      expect(byDate).not.toContain(a.postId);

      expect((await call(operator, '/activities/posts?from=yesterday')).status).toBe(400);
    });
  });

  describe('deleting', () => {
    it('lets the author hard-delete their own post: rows and files gone, one log line left', async () => {
      const { postId } = await post(memberA.token);
      expect((await photo(memberA.token, postId, jpeg(), jpeg(20))).status).toBe(201);
      expect(readdirSync(join(root, postId))).toHaveLength(2);

      // Another member cannot see it, so cannot delete it.
      expect((await call(memberB.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(404);

      expect((await call(memberA.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(200);
      expect(existsSync(join(root, postId))).toBe(false);
      const rows = await pool.query(
        `SELECT (SELECT count(*) FROM activity_post WHERE post_id = $1)::int AS posts,
                (SELECT count(*) FROM activity_media WHERE post_id = $1)::int AS media`,
        [postId],
      );
      expect(rows.rows[0]).toEqual({ posts: 0, media: 0 });

      const logged = await pool.query<{ actor_person_id: string; detail: { photos: number } }>(
        `SELECT actor_person_id, detail FROM activity_log WHERE post_id = $1 AND type = 'deleted'`,
        [postId],
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0]!.actor_person_id).toBe(memberA.personId);
      expect(logged.rows[0]!.detail.photos).toBe(1);
    });

    it('is refused to an author whose delete permission is denied', async () => {
      const denied = await account('member');
      const { postId } = await post(denied.token);
      await pool.query(
        `INSERT INTO person_permission (person_id, permission, effect)
         VALUES ($1, 'activities.delete_own', 'deny')`,
        [denied.personId],
      );
      expect((await call(denied.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(403);
    });

    it('lets a moderator hide, restore and hard-delete anybody’s post', async () => {
      const { postId } = await post(memberA.token);

      expect((await call(memberA.token, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(
        403,
      );
      expect((await call(operator, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(403);
      expect((await call(memberA.token, '/activities/posts?bin=1')).status).toBe(403);

      expect((await call(admin, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(200);
      expect(await feed(memberA.token)).not.toContain(postId);
      expect(await feed(operator)).not.toContain(postId);
      expect(await feed(admin, '?bin=1')).toContain(postId);

      expect((await call(admin, `/activities/posts/${postId}/restore`, 'POST')).status).toBe(200);
      expect(await feed(memberA.token)).toContain(postId);

      expect((await call(admin, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(200);
      expect((await call(admin, `/activities/posts/${postId}`, 'DELETE')).status).toBe(200);
      expect(await feed(admin, '?bin=1')).not.toContain(postId);

      const types = await pool.query<{ type: string }>(
        'SELECT type FROM activity_log WHERE post_id = $1 ORDER BY seq',
        [postId],
      );
      expect(types.rows.map((r) => r.type)).toEqual([
        'posted',
        'hidden',
        'restored',
        'hidden',
        'deleted',
      ]);

      expect((await call(memberA.token, '/activities/log')).status).toBe(403);
      expect((await call(admin, '/activities/log')).status).toBe(200);
    });
  });

  describe('the record', () => {
    it('keeps the Activities log append-only', async () => {
      await expect(pool.query('UPDATE activity_log SET type = type')).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query('DELETE FROM activity_log')).rejects.toThrow(/append-only/);
    });

    it('writes nothing to the incident log or to evidence', async () => {
      const count = async (): Promise<{ events: number; evidence: number }> => {
        const r = await pool.query<{ events: number; evidence: number }>(
          `SELECT (SELECT count(*) FROM incident_event)::int AS events,
                  (SELECT count(*) FROM evidence)::int AS evidence`,
        );
        return r.rows[0]!;
      };
      const before = await count();
      const { postId } = await post(memberA.token);
      await photo(memberA.token, postId);
      await call(admin, `/activities/posts/${postId}/hide`, 'POST');
      await call(admin, `/activities/posts/${postId}`, 'DELETE');
      expect(await count()).toEqual(before);
    });
  });
});
