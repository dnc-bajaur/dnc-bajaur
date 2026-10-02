/**
 * Activities housekeeping — the 30-day rule and the media backup (ADR-0039 §7–8, Bajaur — C2).
 *
 * One pass does three things, in this order, and the order is the design:
 *
 *   1. **Expire.** Every post uploaded more than 30 days ago is hard-deleted — Recycle bin
 *      included — through the same `removePost` a person's delete uses, logged as `expired`.
 *   2. **Remove from the bucket.** Every object queued by a delete (a person's or the rule's)
 *      is deleted from Bajaur's media bucket. A refusal leaves it queued for the next pass and
 *      records why; the bucket's own 30-day lifecycle rule is the safety net under that.
 *   3. **Copy.** Every photo not yet in the bucket is encrypted and sent.
 *
 * Expiring before copying means nothing is uploaded only to be deleted a moment later.
 *
 * **Hourly, not once at 02:00**, for the reason `nightly.ts` gives at length: a timer set hours
 * away is a timer that never fires on a server that was rebooted, and the failure is invisible.
 * Every step is idempotent, so running it more often than the ADR's "nightly" costs one cheap
 * query when there is nothing to do — and a photo reaches the bucket within the hour, not the day.
 *
 * **A failure is loud.** Logged at error, and visible on the DC's Activities warning and in
 * `npm run doctor` (photos not copied after a day; deletes still waiting after a day).
 *
 * **Not part of the emergency path.** Separate timer, separate advisory lock: nothing here can
 * delay an escalation, and this never touches incidents or evidence (ADR-0039 "Does NOT touch").
 */

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';
import { RETENTION_DAYS, removePost } from '../api/activities.js';
import { encryptDump, type MediaStore } from '../ops/offsite.js';

/** Fixed, and distinct from the escalation scheduler's (`scheduler.ts`). */
const ACTIVITIES_LOCK_KEY = 4_112_039;

const CHECK_INTERVAL_MS = 60 * 60_000;

/** Per pass, so one pass after a long outage cannot hold the lock for an hour. */
const BATCH = 500;

export interface HousekeepingOutcome {
  /** False when another process held the lock — a normal outcome. */
  readonly ran: boolean;
  readonly expired: number;
  readonly removed: number;
  readonly removeFailed: number;
  readonly copied: number;
  readonly copyFailed: number;
  /** Why nothing was copied, when the bucket or the passphrase is not set. */
  readonly copySkipped?: string;
}

export interface HousekeepingOptions {
  readonly pool: Pool;
  readonly root: string;
  readonly store: MediaStore;
  readonly passphrase: string | undefined;
}

function inside(root: string, relative: string): string {
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(resolve(root) + sep)) {
    throw new Error('refusing to touch a file outside the Activities root');
  }
  return absolute;
}

async function expire(options: HousekeepingOptions): Promise<number> {
  const { rows } = await options.pool.query<{ post_id: string }>(
    `SELECT post_id FROM activity_post
      WHERE created_at <= now() - make_interval(days => $1)
      ORDER BY created_at LIMIT $2`,
    [RETENTION_DAYS, BATCH],
  );
  let n = 0;
  for (const r of rows) {
    if (await removePost(options.pool, options.root, r.post_id, 'expired', null)) n += 1;
  }
  return n;
}

async function removeFromBucket(
  options: HousekeepingOptions,
): Promise<{ removed: number; failed: number }> {
  const { pool, store } = options;
  const { rows } = await pool.query<{ object_key: string }>(
    'SELECT object_key FROM activity_backup_removal ORDER BY queued_at LIMIT $1',
    [BATCH],
  );
  let removed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await store.remove(r.object_key);
      await pool.query('DELETE FROM activity_backup_removal WHERE object_key = $1', [r.object_key]);
      removed += 1;
    } catch (e) {
      failed += 1;
      const error = e instanceof Error ? e.message : String(e);
      await pool.query('UPDATE activity_backup_removal SET last_error = $2 WHERE object_key = $1', [
        r.object_key,
        error,
      ]);
      log('error', 'an Activities photo could not be removed from the media bucket', {
        key: r.object_key,
        error,
      });
    }
  }
  return { removed, failed };
}

/** The bucket key for a file: its path on disk, with `.enc` because it is encrypted. */
function keyFor(storedPath: string): string {
  return `activities/${storedPath.replace(/\\/g, '/')}.enc`;
}

async function copyToBucket(
  options: HousekeepingOptions,
  passphrase: string,
): Promise<{ copied: number; failed: number }> {
  const { pool, store, root } = options;
  const { rows } = await pool.query<{
    media_id: string;
    stored_path: string;
    thumb_path: string | null;
  }>(
    `SELECT media_id, stored_path, thumb_path FROM activity_media
      WHERE backed_up_at IS NULL ORDER BY created_at LIMIT $1`,
    [BATCH],
  );
  let copied = 0;
  let failed = 0;
  for (const m of rows) {
    const key = keyFor(m.stored_path);
    const thumbKey = m.thumb_path === null ? null : keyFor(m.thumb_path);
    try {
      await store.put(key, encryptDump(await readFile(inside(root, m.stored_path)), passphrase));
      if (m.thumb_path !== null && thumbKey !== null) {
        await store.put(
          thumbKey,
          encryptDump(await readFile(inside(root, m.thumb_path)), passphrase),
        );
      }
    } catch (e) {
      failed += 1;
      log('error', 'an Activities photo could not be copied to the media bucket', {
        mediaId: m.media_id,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const done = await pool.query(
      `UPDATE activity_media SET backup_key = $2, thumb_backup_key = $3, backed_up_at = now()
        WHERE media_id = $1`,
      [m.media_id, key, thumbKey],
    );
    if (done.rowCount === 0) {
      // Deleted while it was on its way up: the delete could not know about these objects, so
      // they are queued here instead — otherwise they would sit in the bucket until its
      // lifecycle rule, outliving a delete somebody asked for.
      await pool.query(
        `INSERT INTO activity_backup_removal (object_key)
         SELECT unnest($1::text[]) ON CONFLICT (object_key) DO NOTHING`,
        [[key, thumbKey].filter((k): k is string => k !== null)],
      );
      continue;
    }
    copied += 1;
  }
  return { copied, failed };
}

/** One full pass, under the lock. Exposed for tests and for an operator. */
export async function runHousekeeping(options: HousekeepingOptions): Promise<HousekeepingOutcome> {
  const client = await options.pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ACTIVITIES_LOCK_KEY],
    );
    if (got.rows[0]?.locked !== true) {
      return { ran: false, expired: 0, removed: 0, removeFailed: 0, copied: 0, copyFailed: 0 };
    }
    try {
      const expired = await expire(options);

      let copySkipped: string | undefined;
      if (!options.store.configured) {
        copySkipped = options.store.why ?? 'no media bucket';
      } else if (options.passphrase === undefined || options.passphrase.length < 16) {
        // The same rule as the database backup: refused rather than sent in the clear.
        copySkipped =
          'no BACKUP_PASSPHRASE of at least 16 characters — refusing to send photos out unencrypted';
      }

      // Removals need only the bucket, not the passphrase: a delete must reach the bucket even
      // on a night nothing can be copied.
      const { removed, failed: removeFailed } = options.store.configured
        ? await removeFromBucket(options)
        : { removed: 0, failed: 0 };

      const { copied, failed: copyFailed } =
        copySkipped === undefined
          ? await copyToBucket(options, options.passphrase!)
          : { copied: 0, failed: 0 };

      return {
        ran: true,
        expired,
        removed,
        removeFailed,
        copied,
        copyFailed,
        ...(copySkipped === undefined ? {} : { copySkipped }),
      };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ACTIVITIES_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export interface ActivitiesHousekeeping {
  start(): void;
  stop(): void;
  tick(): Promise<HousekeepingOutcome | null>;
}

export function createActivitiesHousekeeping(
  options: HousekeepingOptions & { readonly intervalMs?: number },
): ActivitiesHousekeeping {
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  async function tick(): Promise<HousekeepingOutcome | null> {
    if (running) return null;
    running = true;
    try {
      const o = await runHousekeeping(options);
      if (o.ran && (o.expired > 0 || o.removed > 0 || o.copied > 0)) {
        log('info', 'Activities housekeeping', { ...o });
      }
      if (o.removeFailed > 0 || o.copyFailed > 0) {
        log('error', 'Activities housekeeping could not reach the media bucket', { ...o });
      }
      return o;
    } catch (err) {
      // A failed pass must never stop the timer; the next one tries again.
      log('error', 'Activities housekeeping threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      // One shortly after start, so a server that was off past a post's thirtieth day does not
      // keep it for another hour; then hourly.
      first = setTimeout(() => void tick(), 60_000);
      first.unref?.();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (first !== null) clearTimeout(first);
      if (timer !== null) clearInterval(timer);
      first = null;
      timer = null;
    },
    tick,
  };
}
