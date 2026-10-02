/**
 * Activities housekeeping, phase C2 — ADR-0039 §7–8 (Bajaur). Against a real database.
 *
 * What is pinned:
 *
 *   * a post is deleted 30 days after upload — rows, files, Recycle bin included — and leaves
 *     one `expired` log line with no person; a younger post is untouched;
 *   * every photo and thumbnail is copied to the media bucket, encrypted, once;
 *   * a delete — by a person or by the rule — reaches the bucket; a refusal stays queued with
 *     its reason, and shows in the backlog after a day;
 *   * no bucket, or no passphrase, copies nothing and says why — but the 30-day rule still runs;
 *   * two processes never run a pass at once.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { backupBacklog, removePost } from '../../api/activities.js';
import { decryptDump, type MediaStore } from '../../ops/offsite.js';
import { runHousekeeping } from '../activitiesRetention.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSPHRASE = 'activities-backup-passphrase-2026';

/** An in-memory bucket that can be told to refuse. */
function fakeBucket(): MediaStore & {
  objects: Map<string, Buffer>;
  refuse: boolean;
} {
  const objects = new Map<string, Buffer>();
  const bucket = {
    configured: true,
    why: null,
    objects,
    refuse: false,
    put(key: string, bytes: Buffer): Promise<void> {
      if (bucket.refuse) return Promise.reject(new Error('the bucket said no'));
      objects.set(key, bytes);
      return Promise.resolve();
    },
    remove(key: string): Promise<void> {
      if (bucket.refuse) return Promise.reject(new Error('the bucket said no'));
      objects.delete(key);
      return Promise.resolve();
    },
  };
  return bucket;
}

const maybe = dbUrl ? describe : describe.skip;

maybe('Activities housekeeping (ADR-0039, phase C2)', () => {
  let pool: Pool;
  let root: string;
  let personId: string;
  let unitId: string;

  /** A post with one photo and its thumbnail on disk, uploaded `daysAgo` days ago. */
  async function post(
    daysAgo: number,
    hidden = false,
  ): Promise<{ postId: string; mediaId: string }> {
    const p = await pool.query<{ post_id: string }>(
      `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption, created_at,
                                  hidden_at)
       VALUES ($1, $2, current_date - $3::int, 'Housekeeping test',
               now() - make_interval(days => $3::int), CASE WHEN $4 THEN now() END)
       RETURNING post_id`,
      [unitId, personId, daysAgo, hidden],
    );
    const postId = p.rows[0]!.post_id;
    const mediaId = randomUUID();
    mkdirSync(join(root, postId), { recursive: true });
    writeFileSync(join(root, postId, `${mediaId}.jpg`), `photo ${mediaId}`);
    writeFileSync(join(root, postId, `${mediaId}.thumb.jpg`), `thumb ${mediaId}`);
    await pool.query(
      `INSERT INTO activity_media (media_id, post_id, kind, content_type, byte_size, sha256,
                                   stored_path, thumb_path, created_at)
       VALUES ($1, $2, 'photo', 'image/jpeg', 10, repeat('a', 64), $3, $4,
               now() - make_interval(days => $5::int))`,
      [mediaId, postId, `${postId}/${mediaId}.jpg`, `${postId}/${mediaId}.thumb.jpg`, daysAgo],
    );
    return { postId, mediaId };
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    root = mkdtempSync(join(tmpdir(), 'dnc-bajaur-housekeeping-'));
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone) VALUES ('Housekeeping author', $1) RETURNING person_id`,
      [`+92302${randomUUID().slice(0, 7)}`],
    );
    personId = person.rows[0]!.person_id;
    const unit = await pool.query<{ unit_id: string }>(
      'INSERT INTO activity_unit (name) VALUES ($1) RETURNING unit_id',
      [`Housekeeping ${randomUUID()}`],
    );
    unitId = unit.rows[0]!.unit_id;
  }, 60_000);

  // Other test files share this database; leave none of this file's leftovers in their way,
  // and none of theirs in this file's bucket.
  beforeEach(async () => {
    await pool.query(
      `UPDATE activity_media SET backed_up_at = now() WHERE backed_up_at IS NULL
          AND post_id NOT IN (SELECT post_id FROM activity_post WHERE unit_id = $1)`,
      [unitId],
    );
    await pool.query('DELETE FROM activity_backup_removal');
  });

  afterAll(async () => {
    await pool?.end();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  const run = (store: MediaStore, passphrase: string | undefined = PASSPHRASE) =>
    runHousekeeping({ pool, root, store, passphrase });

  it('deletes a post 30 days after upload, Recycle bin included, and leaves one line', async () => {
    const old = await post(31);
    const binned = await post(30, true);
    const young = await post(29);

    const o = await run(fakeBucket());
    expect(o.ran).toBe(true);
    expect(o.expired).toBeGreaterThanOrEqual(2);

    for (const gone of [old, binned]) {
      const rows = await pool.query(
        `SELECT (SELECT count(*) FROM activity_post WHERE post_id = $1)::int AS posts,
                (SELECT count(*) FROM activity_media WHERE post_id = $1)::int AS media`,
        [gone.postId],
      );
      expect(rows.rows[0]).toEqual({ posts: 0, media: 0 });
      expect(existsSync(join(root, gone.postId))).toBe(false);
      const logged = await pool.query<{
        actor_person_id: string | null;
        detail: { photos: number; fromRecycleBin: boolean };
      }>(
        `SELECT actor_person_id, detail FROM activity_log WHERE post_id = $1 AND type = 'expired'`,
        [gone.postId],
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0]!.actor_person_id).toBeNull();
      expect(logged.rows[0]!.detail.photos).toBe(1);
    }
    const binLine = await pool.query<{ detail: { fromRecycleBin: boolean } }>(
      `SELECT detail FROM activity_log WHERE post_id = $1`,
      [binned.postId],
    );
    expect(binLine.rows[0]!.detail.fromRecycleBin).toBe(true);

    const kept = await pool.query('SELECT 1 FROM activity_post WHERE post_id = $1', [young.postId]);
    expect(kept.rowCount).toBe(1);
    expect(existsSync(join(root, young.postId))).toBe(true);
  });

  it('copies each photo and thumbnail once, encrypted', async () => {
    const bucket = fakeBucket();
    const { postId, mediaId } = await post(1);

    const first = await run(bucket);
    expect(first.copied).toBeGreaterThanOrEqual(1);
    const key = `activities/${postId}/${mediaId}.jpg.enc`;
    const thumbKey = `activities/${postId}/${mediaId}.thumb.jpg.enc`;
    expect(bucket.objects.has(key)).toBe(true);
    expect(bucket.objects.has(thumbKey)).toBe(true);
    // Not readable in the bucket; readable with the passphrase.
    expect(bucket.objects.get(key)!.toString()).not.toContain('photo');
    expect(decryptDump(bucket.objects.get(key)!, PASSPHRASE).toString()).toBe(`photo ${mediaId}`);

    const row = await pool.query<{ backup_key: string; thumb_backup_key: string }>(
      'SELECT backup_key, thumb_backup_key FROM activity_media WHERE media_id = $1',
      [mediaId],
    );
    expect(row.rows[0]).toEqual({ backup_key: key, thumb_backup_key: thumbKey });

    const second = await run(bucket);
    expect(second.copied).toBe(0);
  });

  it('takes a person’s delete to the bucket too', async () => {
    const bucket = fakeBucket();
    const { postId, mediaId } = await post(2);
    await run(bucket);
    expect(bucket.objects.size).toBe(2);

    expect(await removePost(pool, root, postId, 'deleted', personId)).toBe(true);
    const queued = await pool.query('SELECT object_key FROM activity_backup_removal');
    expect(queued.rows.map((r: { object_key: string }) => r.object_key).sort()).toEqual([
      `activities/${postId}/${mediaId}.jpg.enc`,
      `activities/${postId}/${mediaId}.thumb.jpg.enc`,
    ]);

    const o = await run(bucket);
    expect(o.removed).toBe(2);
    expect(bucket.objects.size).toBe(0);
    expect((await pool.query('SELECT 1 FROM activity_backup_removal')).rowCount).toBe(0);
  });

  it('keeps a refused delete queued, with its reason, and reports it after a day', async () => {
    const bucket = fakeBucket();
    const { postId } = await post(3);
    await run(bucket);
    await removePost(pool, root, postId, 'deleted', personId);

    bucket.refuse = true;
    const o = await run(bucket);
    expect(o.removeFailed).toBe(2);
    expect(bucket.objects.size).toBe(2);
    const queued = await pool.query<{ last_error: string }>(
      'SELECT last_error FROM activity_backup_removal',
    );
    expect(queued.rows.every((r) => r.last_error === 'the bucket said no')).toBe(true);

    await pool.query(`UPDATE activity_backup_removal SET queued_at = now() - interval '2 days'`);
    const backlog = await backupBacklog(pool);
    expect(backlog.removalsWaiting).toBe(2);
    expect(backlog.lastError).toBe('the bucket said no');

    bucket.refuse = false;
    expect((await run(bucket)).removed).toBe(2);
    expect(bucket.objects.size).toBe(0);
  });

  it('copies nothing without a bucket or a passphrase — and still applies the 30-day rule', async () => {
    const unconfigured: MediaStore = {
      configured: false,
      why: 'no media bucket yet',
      put: () => Promise.reject(new Error('no')),
      remove: () => Promise.reject(new Error('no')),
    };
    const old = await post(40);
    const fresh = await post(0);

    const none = await run(unconfigured);
    expect(none.copySkipped).toBe('no media bucket yet');
    expect(none.copied).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM activity_post WHERE post_id = $1', [old.postId])).rowCount,
    ).toBe(0);

    const bucket = fakeBucket();
    const short = await run(bucket, 'too-short');
    expect(short.copySkipped).toMatch(/BACKUP_PASSPHRASE/);
    expect(bucket.objects.size).toBe(0);

    const media = await pool.query<{ backed_up_at: string | null }>(
      'SELECT backed_up_at FROM activity_media WHERE media_id = $1',
      [fresh.mediaId],
    );
    expect(media.rows[0]!.backed_up_at).toBeNull();
  });

  it('never runs two passes at once', async () => {
    const other = await pool.connect();
    try {
      await other.query('SELECT pg_advisory_lock(4112039)');
      const o = await run(fakeBucket());
      expect(o.ran).toBe(false);
    } finally {
      await other.query('SELECT pg_advisory_unlock(4112039)');
      other.release();
    }
  });
});
