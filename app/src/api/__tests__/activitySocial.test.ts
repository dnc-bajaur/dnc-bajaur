/**
 * Reactions and comments on an Activities post — ADR-0044 §4–§5 (Bajaur, PLAN §4b G2). Over real
 * HTTP (INV-05: refusals proven from outside the UI).
 *
 * What is pinned:
 *
 *   * every role reacts and comments by default — a `viewer` and a `member` included — and a
 *     `deny` of `activities.comment` takes both away; a forced password change holds them back;
 *   * one mark per person per post: it can be changed and taken off; the card carries the counts,
 *     the names and the caller's own mark;
 *   * a comment is trimmed, never empty, at most 1000 characters; the feed carries the newest
 *     three and the count, and the full list is one request away;
 *   * a comment is deleted by its author or a moderator, nobody else; a moderator removing
 *     somebody else's leaves one log line without the words;
 *   * a post the caller cannot see takes neither, and says no more than "no such post"; a post in
 *     the Recycle bin takes neither;
 *   * both go with the post when it is deleted — and nothing is sent on WhatsApp for either.
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
import type { WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'activities-social-password-2026';

interface Account {
  readonly token: string;
  readonly personId: string;
}

interface Comment {
  readonly commentId: string;
  readonly authorName: string;
  readonly body: string;
  readonly mayDelete: boolean;
}

interface Social {
  readonly reactions: { kind: string; count: number; names: string[] }[];
  readonly myReaction: string | null;
  readonly commentCount: number;
  readonly comments: Comment[];
  readonly mayComment: boolean;
}

const maybe = dbUrl ? describe : describe.skip;

maybe('Activities: reactions and comments (ADR-0044)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;

  let admin: Account;
  let author: Account;
  let unitId: string;

  /** Everything this server tried to send to Meta. It must stay empty. */
  const sentToMeta: string[] = [];
  const whatsapp: WhatsAppConfig = {
    phoneNumberId: '999',
    accessToken: 'not-a-real-token',
    appSecret: 'not-a-real-secret',
    verifyToken: 'not-a-real-verify-token',
    templateName: 'district_message_v3',
    templateLanguage: 'en',
    baseUrl: 'https://example.invalid/v21.0',
  };

  async function account(
    role: Role,
    name = `Social ${role}`,
    mustChange = false,
  ): Promise<Account> {
    const phone = `+92303${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD), role, mustChange],
    );
    return { token: (await login(pool, phone, PASSWORD))!.token, personId: res.rows[0]!.person_id };
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

  async function post(token = author.token): Promise<string> {
    const res = await call(token, '/activities/posts', 'POST', {
      unitId,
      activityDate: districtDate(),
      caption: 'Inspected the water scheme',
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { postId: string }).postId;
  }

  const react = (token: string, postId: string, kind: string | null): Promise<Response> =>
    call(token, `/activities/posts/${postId}/reaction`, 'PUT', { kind });

  const comment = (token: string, postId: string, body: unknown): Promise<Response> =>
    call(token, `/activities/posts/${postId}/comments`, 'POST', { body });

  /** The post as the feed hands it to this caller. */
  async function inFeed(token: string, postId: string): Promise<Social | undefined> {
    const res = await call(token, '/activities/posts');
    expect(res.status).toBe(200);
    const posts = ((await res.json()) as { posts: ({ postId: string } & Social)[] }).posts;
    return posts.find((p) => p.postId === postId);
  }

  const countOf = (s: Social, kind: string): number =>
    s.reactions.find((r) => r.kind === kind)?.count ?? -1;

  const deny = (personId: string, permission: string): Promise<unknown> =>
    pool.query(
      `INSERT INTO person_permission (person_id, permission, effect, set_by_person_id)
       VALUES ($1, $2, 'deny', $3)`,
      [personId, permission, admin.personId],
    );

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-social-'));
    server = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      activitiesRoot: root,
      whatsapp,
      whatsappFetch: (async (url: string) => {
        sentToMeta.push(String(url));
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.never' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    admin = await account('admin');
    author = await account('member', 'Social author');
    const made = await call(admin.token, '/activities/units', 'POST', {
      name: `Social ${randomUUID()}`,
    });
    unitId = ((await made.json()) as { unitId: string }).unitId;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  describe('who may', () => {
    it('lets every role react and comment, a viewer and a member included', async () => {
      const postId = await post();
      for (const role of ['owner', 'admin', 'operator', 'viewer', 'member'] as const) {
        const a = await account(role);
        expect((await react(a.token, postId, 'seen')).status, role).toBe(200);
        expect((await comment(a.token, postId, `from ${role}`)).status, role).toBe(201);
        expect((await inFeed(a.token, postId))?.mayComment, role).toBe(true);
      }
    });

    it('takes both away with a deny of activities.comment', async () => {
      const postId = await post();
      const quiet = await account('member');
      await deny(quiet.personId, 'activities.comment');
      expect((await react(quiet.token, postId, 'seen')).status).toBe(403);
      expect((await comment(quiet.token, postId, 'hello')).status).toBe(403);
      // Still reads the post, and what others said on it.
      expect((await inFeed(quiet.token, postId))?.mayComment).toBe(false);
      expect((await call(quiet.token, `/activities/posts/${postId}/comments`)).status).toBe(200);
    });

    it('holds both back until a temporary password is replaced', async () => {
      const postId = await post();
      const fresh = await account('member', 'Social fresh', true);
      expect((await react(fresh.token, postId, 'seen')).status).toBe(403);
      expect((await comment(fresh.token, postId, 'hello')).status).toBe(403);
    });

    it('says no more than "no such post" about one the caller cannot see', async () => {
      const postId = await post();
      const narrowed = await account('member');
      await deny(narrowed.personId, 'activities.read_all');
      for (const res of [
        await react(narrowed.token, postId, 'seen'),
        await comment(narrowed.token, postId, 'hello'),
        await call(narrowed.token, `/activities/posts/${postId}/comments`),
        await react(admin.token, randomUUID(), 'seen'),
      ]) {
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe('no such post');
      }
    });

    it('takes neither on a post in the Recycle bin', async () => {
      const postId = await post();
      expect((await call(admin.token, `/activities/posts/${postId}/hide`, 'POST')).status).toBe(
        200,
      );
      expect((await react(admin.token, postId, 'seen')).status).toBe(409);
      expect((await comment(admin.token, postId, 'hello')).status).toBe(409);
    });
  });

  describe('a reaction', () => {
    it('is one mark per person: set, changed, taken off', async () => {
      const postId = await post();
      const dc = await account('owner', 'Social DC');
      const other = await account('operator', 'Social operator');

      const first = (await (await react(dc.token, postId, 'seen')).json()) as Social;
      expect(countOf(first, 'seen')).toBe(1);
      expect(first.myReaction).toBe('seen');

      await react(other.token, postId, 'seen');
      // The same mark twice is still one.
      await react(dc.token, postId, 'seen');
      const changed = (await (await react(dc.token, postId, 'well_done')).json()) as Social;
      expect(countOf(changed, 'seen')).toBe(1);
      expect(countOf(changed, 'well_done')).toBe(1);
      expect(changed.myReaction).toBe('well_done');
      expect(changed.reactions.find((r) => r.kind === 'well_done')?.names).toEqual(['Social DC']);
      expect(changed.reactions.find((r) => r.kind === 'seen')?.names).toEqual(['Social operator']);

      // Each caller is told their own mark, not somebody else's.
      expect((await inFeed(other.token, postId))?.myReaction).toBe('seen');
      expect((await inFeed(author.token, postId))?.myReaction).toBeNull();

      const off = (await (await react(dc.token, postId, null)).json()) as Social;
      expect(countOf(off, 'well_done')).toBe(0);
      expect(off.myReaction).toBeNull();
    });

    it('refuses a mark that is not one of the two', async () => {
      const postId = await post();
      expect((await react(admin.token, postId, 'angry')).status).toBe(400);
      expect(
        (await call(admin.token, `/activities/posts/${postId}/reaction`, 'PUT', {})).status,
      ).toBe(400);
    });
  });

  describe('a comment', () => {
    it('is trimmed, never empty, and at most 1000 characters', async () => {
      const postId = await post();
      expect((await comment(admin.token, postId, '   ')).status).toBe(400);
      expect((await comment(admin.token, postId, 42)).status).toBe(400);
      expect((await comment(admin.token, postId, 'x'.repeat(1001))).status).toBe(400);
      const res = await comment(admin.token, postId, '  Good work.  ');
      expect(res.status).toBe(201);
      expect(((await res.json()) as Social).comments.at(-1)?.body).toBe('Good work.');
    });

    it('rides with the post in the feed — the newest three and the count — and lists in full', async () => {
      const postId = await post();
      for (let i = 1; i <= 5; i += 1) {
        expect((await comment(admin.token, postId, `comment ${i}`)).status).toBe(201);
      }
      const card = await inFeed(author.token, postId);
      expect(card?.commentCount).toBe(5);
      expect(card?.comments.map((c) => c.body)).toEqual(['comment 3', 'comment 4', 'comment 5']);
      expect(card?.comments[0]?.authorName).toBe('Social admin');

      const all = await call(author.token, `/activities/posts/${postId}/comments`);
      expect(((await all.json()) as Comment[]).map((c) => c.body)).toEqual([
        'comment 1',
        'comment 2',
        'comment 3',
        'comment 4',
        'comment 5',
      ]);
    });

    it('is deleted by its author or a moderator, and by nobody else', async () => {
      const postId = await post();
      const writer = await account('member', 'Social writer');
      const bystander = await account('operator');
      const made = (await (await comment(writer.token, postId, 'mine')).json()) as Social;
      const id = made.comments[0]!.commentId;
      expect(made.comments[0]!.mayDelete).toBe(true);

      // The post's own author is not the comment's author.
      expect((await inFeed(author.token, postId))?.comments[0]?.mayDelete).toBe(false);
      expect((await call(bystander.token, `/activities/comments/${id}`, 'DELETE')).status).toBe(
        403,
      );
      expect((await call(author.token, `/activities/comments/${id}`, 'DELETE')).status).toBe(403);

      const logged = async (): Promise<number> =>
        (
          await pool.query(
            `SELECT 1 FROM activity_log WHERE type = 'comment_removed' AND post_id = $1`,
            [postId],
          )
        ).rowCount ?? 0;

      // Its author: gone, and no log line — nobody removed anybody else's words.
      const gone = await call(writer.token, `/activities/comments/${id}`, 'DELETE');
      expect(gone.status).toBe(200);
      expect(((await gone.json()) as Social).commentCount).toBe(0);
      expect(await logged()).toBe(0);
      expect((await call(writer.token, `/activities/comments/${id}`, 'DELETE')).status).toBe(404);

      // A moderator removing somebody else's: one line, who and whose, never the words.
      const second = (await (
        await comment(writer.token, postId, 'a secret word')
      ).json()) as Social;
      const removed = await call(
        admin.token,
        `/activities/comments/${second.comments[0]!.commentId}`,
        'DELETE',
      );
      expect(removed.status).toBe(200);
      const line = await pool.query<{ actor_person_id: string; detail: unknown }>(
        `SELECT actor_person_id, detail FROM activity_log
          WHERE type = 'comment_removed' AND post_id = $1`,
        [postId],
      );
      expect(line.rows).toHaveLength(1);
      expect(line.rows[0]!.actor_person_id).toBe(admin.personId);
      expect(line.rows[0]!.detail).toEqual({ authorPersonId: writer.personId });
      expect(JSON.stringify(line.rows[0]!.detail)).not.toContain('secret');
    });
  });

  it('goes with its post, and sends nothing on WhatsApp', async () => {
    const postId = await post();
    await react(admin.token, postId, 'well_done');
    await comment(admin.token, postId, 'Well done.');
    expect((await call(author.token, `/activities/posts/${postId}`, 'DELETE')).status).toBe(200);
    const left = await pool.query(
      `SELECT 1 FROM activity_reaction WHERE post_id = $1
       UNION ALL SELECT 1 FROM activity_comment WHERE post_id = $1`,
      [postId],
    );
    expect(left.rowCount).toBe(0);
    expect(sentToMeta).toEqual([]);
  });
});
