/**
 * Activities as a feed — ADR-0044 (Bajaur, PLAN §4b). Over real HTTP (INV-05).
 *
 * What is pinned:
 *
 *   * a post says who sent it — name, post and **mobile number** — to every account that can see
 *     it; a Directory contact with no post text of their own shows the post they hold;
 *   * the Departments view counts what the caller may see: everyone's posts, or one's own after a
 *     `deny` of `activities.read_all`; hidden posts are not counted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { seedActor } from '../../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'activities-feed-password-2026';

interface Account {
  readonly token: string;
  readonly personId: string;
  readonly phone: string;
}

interface PostBody {
  readonly postId: string;
  readonly authorName: string;
  readonly authorDesignation: string | null;
  readonly authorPhone: string;
}

const maybe = dbUrl ? describe : describe.skip;

maybe('Activities as a feed (ADR-0044)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;

  let admin: Account;
  let memberA: Account;
  let memberB: Account;
  let unitId: string;

  async function account(role: Role, designation: string | null = null): Promise<Account> {
    const phone = `+92302${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, designation)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [`Feed ${role}`, phone, await hashPassword(PASSWORD), role, designation],
    );
    return {
      token: (await login(pool, phone, PASSWORD))!.token,
      personId: res.rows[0]!.person_id,
      phone,
    };
  }

  const call = (token: string, path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

  async function post(token: string, unit = unitId): Promise<string> {
    const res = await call(token, '/activities/posts', 'POST', {
      unitId: unit,
      activityDate: districtDate(),
      caption: 'Visited the school',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as PostBody).postId;
  }

  async function seen(token: string, postId: string): Promise<PostBody | undefined> {
    const res = await call(token, '/activities/posts');
    expect(res.status).toBe(200);
    return ((await res.json()) as { posts: PostBody[] }).posts.find((p) => p.postId === postId);
  }

  async function newUnit(): Promise<string> {
    const made = await call(admin.token, '/activities/units', 'POST', {
      name: `Feed ${randomUUID()}`,
    });
    expect(made.status).toBe(201);
    return ((await made.json()) as { unitId: string }).unitId;
  }

  async function count(token: string, unit: string): Promise<number> {
    const res = await call(token, '/activities/units/counts');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { unitId: string; posts: number }[];
    return rows.find((r) => r.unitId === unit)?.posts ?? 0;
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-feed-'));
    server = createSyncServer({ pool, authMode: 'session', nodeEnv: 'test', activitiesRoot: root });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    admin = await account('admin');
    memberA = await account('member', 'Head Teacher (placeholder)');
    memberB = await account('member');
    unitId = await newUnit();
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  describe('who sent a post', () => {
    it('is said to every account that can see it: name, post and number', async () => {
      const postId = await post(memberA.token);
      for (const reader of [admin, memberB, await account('viewer'), await account('operator')]) {
        const p = await seen(reader.token, postId);
        expect(p?.authorName).toBe('Feed member');
        expect(p?.authorDesignation).toBe('Head Teacher (placeholder)');
        expect(p?.authorPhone).toBe(memberA.phone);
      }
    });

    it('shows the Directory post a contact holds when they have no text of their own', async () => {
      const contact = await seedActor(pool, { title: `Feed seat ${randomUUID()}`, role: 'member' });
      const seat = await pool.query<{ title: string }>(
        'SELECT title FROM seat WHERE seat_id = $1',
        [contact.seatId],
      );
      const res = await call(contact.token, '/activities/posts', 'POST', {
        unitId,
        activityDate: districtDate(),
        caption: 'Road inspection',
      });
      expect(res.status).toBe(201);
      const made = (await res.json()) as PostBody;
      expect(made.authorDesignation).toBe(seat.rows[0]!.title);
      expect(made.authorPhone).toBe(contact.phone);
    });
  });

  describe('the Departments view', () => {
    it('counts the posts a caller may see, and leaves hidden ones out', async () => {
      const unit = await newUnit();
      await post(memberA.token, unit);
      const second = await post(memberB.token, unit);
      expect(await count(admin.token, unit)).toBe(2);
      expect(await count(memberA.token, unit)).toBe(2);

      expect((await call(admin.token, `/activities/posts/${second}/hide`, 'POST')).status).toBe(
        200,
      );
      expect(await count(admin.token, unit)).toBe(1);
    });

    it('counts only one’s own once read_all is denied', async () => {
      const unit = await newUnit();
      const narrowed = await account('member');
      await post(memberA.token, unit);
      await post(narrowed.token, unit);
      await pool.query(
        `INSERT INTO person_permission (person_id, permission, effect, set_by_person_id)
         VALUES ($1, 'activities.read_all', 'deny', $2)`,
        [narrowed.personId, admin.personId],
      );
      expect(await count(narrowed.token, unit)).toBe(1);
      expect(await count(admin.token, unit)).toBe(2);
    });

    it('is a read only', async () => {
      expect((await call(admin.token, '/activities/units/counts', 'POST', {})).status).toBe(405);
    });
  });
});
