/**
 * The backup job — M0-53, ADR-0011. **Hourly since 2026-08-14.**
 *
 * P-08 held this up for weeks: the backup was built and verified and **nothing scheduled it**,
 * because where the server runs decides how. ADR-0011 answered that, so this is the thing that
 * puts the district's record somewhere a fire cannot reach.
 *
 * ## Why hourly, and what it is actually buying
 *
 * It ran once a night, at 02:00. That is a **seventeen-hour hole**: a machine lost at 20:00
 * restores to 02:57 that morning, and everything between is **gone — not delayed, gone.** Not
 * "data": every emergency reported that day, every acknowledgement, every record of who was
 * told. Restoring gives you yesterday's district with today erased.
 *
 * And the consequence nobody thinks of first: **the reporters.** Somebody rang at 10:00 about a
 * fire; that report is gone, so nobody knows to ring them back. **The district does not know
 * what it does not know.**
 *
 * The dump is ~200 KB. Twenty-four a day is about 5 MB — so this trades **seventeen hours of the
 * district's record for a few megabytes**, which is why the owner locked it in one line. It is a
 * change of schedule, not of architecture: everything below already worked this way.
 *
 * Two decisions worth reading before changing anything here.
 *
 * **It checks every ten minutes rather than sleeping until the hour.** A district server gets
 * rebooted, loses power, and is occasionally a laptop somebody closed. A timer set hours away is
 * a timer that never fires, and the failure is invisible: nobody notices a backup that did not
 * happen. Asking "has one been taken this hour?" on a short interval survives every one of
 * those, and takes one cheap query to answer.
 *
 * **It dumps the database it verifies against.** `runBackup` falls back to `DATABASE_URL`
 * when no connection string is given, and a server whose pool was built from a different URL
 * would then back up the wrong database and compare the result against the right one. The
 * event-count check catches it — that is how this was found — but catching it is not the same
 * as not doing it, so the caller states which database this is.
 *
 * **A run that fails is louder than a run that succeeds.** Nothing is logged on success
 * beyond a line; a failure is logged at error level, recorded in the ledger, and surfaced by
 * `/health` as `degraded`. A backup that silently stopped working a year ago is worse than no
 * backup, because the district spent that year believing it was covered.
 */

import { readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';
import { runBackup, type BackupOptions } from '../ops/backup.js';
import { offsiteStore, uploadDump, type OffsiteEnv, type OffsiteStore } from '../ops/offsite.js';

/** How often to ask whether this hour's backup has been taken. Not how often to take one. */
const CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * How many local dumps to keep on the server's own disk.
 *
 * **This exists because hourly made it necessary.** At one a night, nothing pruned them and
 * nothing needed to. At twenty-four a day, a directory nobody empties fills a disk — and a full
 * disk does not merely stop the backup, it stops **PostgreSQL**, which is how this project
 * already lost a development cluster mid-recovery (`No space left on device`, 2026-08-13). The
 * production box has 70 GB free and a 200 KB dump today; the dump grows with the district.
 *
 * Forty-eight is two days. **The local copies are a convenience, not the record** — the record
 * is the encrypted off-site copy, and those are never pruned by this. A restore reaching for a
 * dump older than two days should be reaching for the bucket anyway (`docs/08-runbook.md`).
 */
const KEEP_LOCAL_DUMPS = 48;

export interface NightlyOptions {
  readonly pool: Pool;
  readonly backup: BackupOptions;
  readonly env?: OffsiteEnv;
  readonly store?: OffsiteStore;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onRun?: (outcome: NightlyOutcome) => void;
}

export interface NightlyOutcome {
  readonly ran: boolean;
  readonly reason: string;
  readonly backupOk?: boolean;
  readonly offsiteOk?: boolean;
  readonly offsiteSkipped?: string;
}

export interface Nightly {
  start(): void;
  stop(): void;
  /** Run the check now. Exposed for tests and for an operator who wants one immediately. */
  tick(): Promise<NightlyOutcome>;
  /** Take one right now regardless of the schedule. The console's "back up now" button. */
  runNow(): Promise<NightlyOutcome>;
}

/**
 * Has a backup already succeeded in the current clock hour?
 *
 * **This used to ask about the district's *day*, and the paragraph here explained at length why
 * the zone mattered.** It did matter, and getting it wrong was a real defect: `setHours` reads
 * the *machine's* zone, the machine is Hetzner Helsinki on `Etc/UTC` (ADR-0019), and Bajaur is
 * UTC+05:00 — so a day check written that way took a second backup every night.
 *
 * **An hour does not have that problem, and adding a timezone here would reintroduce it.** Every
 * zone this district cares about is a whole number of hours from UTC, so the top of the hour is
 * the same instant whatever you call it. `startOfDistrictDay` remains the right call for a *day*
 * — a day genuinely depends on the zone — and this one deliberately does not use it.
 *
 * The old comment is summarised rather than deleted because its lesson outlived its code: **a
 * comment stating the right rule above code that does something else is worse than no comment**,
 * since it stops the next reader from looking.
 */
async function alreadyThisHour(pool: Pool, now: Date): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM backup_run
      WHERE status = 'ok' AND finished_at >= $1`,
    [startOfHour(now)],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * The top of the current clock hour, as an instant.
 *
 * **No timezone is involved and none should be added.** Zeroing the minutes of an instant lands
 * on the same moment whatever zone you name it in, because every zone this district cares about
 * is a whole number of hours from UTC. `startOfDistrictDay` is still the right call for a *day*
 * — that one genuinely depends on the zone, and getting it wrong is what O-01 cost a week to.
 */
function startOfHour(now: Date): string {
  const at = new Date(now.getTime());
  at.setUTCMinutes(0, 0, 0);
  return at.toISOString();
}

/**
 * Delete all but the newest `KEEP_LOCAL_DUMPS` files in the backup directory.
 *
 * **Only ever the directory this job writes to, and only files it recognises.** The name pattern
 * is matched rather than assumed, so a stray file somebody put there by hand is never deleted by
 * a housekeeping routine — a cleanup that removes something it did not create is how a backup
 * directory becomes the thing that lost the data.
 *
 * Failures are logged and swallowed. **Housekeeping must never be the reason a backup does not
 * happen**, which would trade the district's record for tidiness.
 */
export async function pruneLocalDumps(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    const dumps = entries.filter((n) => /^dnc-.*\.sql$/.test(n)).sort();
    const doomed = dumps.slice(0, Math.max(0, dumps.length - KEEP_LOCAL_DUMPS));
    for (const name of doomed) {
      await unlink(join(directory, name)).catch(() => undefined);
    }
    if (doomed.length > 0) {
      log('info', 'pruned old local dumps', { removed: doomed.length, kept: KEEP_LOCAL_DUMPS });
    }
  } catch (error) {
    log('warn', 'could not prune old local dumps', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createNightly(options: NightlyOptions): Nightly {
  const { pool } = options;
  const env = options.env ?? (process.env as OffsiteEnv);
  // Whichever the district configured — S3 when both are set. See `offsiteStore`.
  const store = options.store ?? offsiteStore(env);
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const now = options.now ?? ((): Date => new Date());

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function take(reason: string): Promise<NightlyOutcome> {
    const result = await runBackup(pool, options.backup);

    if (!result.ok) {
      log('error', 'nightly backup failed', { error: result.error ?? 'unknown' });
      const outcome = { ran: true, reason, backupOk: false };
      options.onRun?.(outcome);
      return outcome;
    }

    // Uploaded only after the dump verified. Sending an unverified dump off-site would put a
    // file in the bucket that nobody can restore, which is worse than an empty bucket
    // because it looks like cover.
    const upload = await uploadDump(pool, result.backupRunId, result.path!, store, env);

    // After the upload, never before. Pruning first could delete the only local copy of a dump
    // that is still on its way to the bucket.
    await pruneLocalDumps(dirname(result.path!));

    const outcome: NightlyOutcome = {
      ran: true,
      reason,
      backupOk: true,
      offsiteOk: upload.ok,
      ...(upload.skipped === undefined ? {} : { offsiteSkipped: upload.skipped }),
    };

    if (upload.ok) {
      log('info', 'nightly backup taken and sent off-site', {
        events: result.eventCount ?? 0,
        key: upload.key ?? '',
      });
    } else if (upload.skipped !== undefined) {
      // Not an error — the district has not bought a bucket yet (R-06). Said once per night
      // at warn, so it is visible without being alarming.
      log('warn', 'nightly backup taken but not sent off-site', { why: upload.skipped });
    } else {
      log('error', 'nightly backup taken but the off-site copy failed', {
        error: upload.error ?? 'unknown',
      });
    }

    options.onRun?.(outcome);
    return outcome;
  }

  async function tick(): Promise<NightlyOutcome> {
    // Overlap is possible on a slow dump and a short interval. The second run would compete
    // with the first for the same disk and produce two dumps of the same night.
    if (running) return { ran: false, reason: 'a backup is already running' };

    const at = now();
    if (await alreadyThisHour(pool, at)) return { ran: false, reason: 'already taken this hour' };

    running = true;
    try {
      // "None yet this hour" rather than "at exactly hh:00". A server that was off for three
      // hours takes one the moment it comes back, which is the whole reason this is a poll and
      // not a timer — and it is what makes an hourly schedule survive a reboot without leaving
      // a hole nobody would ever notice.
      return await take('scheduled');
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick().catch((err: unknown) => {
          log('error', 'nightly backup check threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
    async runNow(): Promise<NightlyOutcome> {
      if (running) return { ran: false, reason: 'a backup is already running' };
      running = true;
      try {
        return await take('asked for');
      } finally {
        running = false;
      }
    },
  };
}
