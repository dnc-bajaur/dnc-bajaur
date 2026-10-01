/**
 * Backups, on a screen — M0-55.
 *
 * The two administrative offices can see whether the district's record is safe, take a backup
 * now, and **prove a dump restores** — without a developer and without a terminal.
 *
 * ## What is deliberately not here
 *
 * There is no "restore over the live database" button, and the owner asked for one. My
 * reasoning, recorded as **D-06** on their list and repeated here because this is where
 * somebody would come to add it:
 *
 * > One mis-click, or one stolen administrator session, replaces the district's entire record
 * > with an older copy. There is no undo — the event log is append-only precisely so that
 * > nothing can rewrite history, and a restore is the one operation that does.
 *
 * What the console gets instead is the thing the button was *for*: **confidence**. Verify
 * restores the dump into a scratch database, checks the append-only triggers survived, counts
 * the events, and reports "this backup restores cleanly, 11,412 events, 40 seconds". That is
 * the question an administrator actually has. The production swap stays a deliberate act on
 * the server by the named technical person (P-07), following `docs/08-runbook.md`.
 *
 * If the owner reads D-06 and still wants the button, it is a small change and it should come
 * with a typed confirmation and a mandatory pre-restore backup.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { backupHealth, type BackupHealth } from '../ops/backup.js';
import { replicationHealthSafe, type ReplicationHealth } from '../ops/replication.js';
import { offsiteStore, type OffsiteEnv } from '../ops/offsite.js';
import { requireAdministration, type AdminResult } from './admin.js';
import type { Nightly } from '../jobs/nightly.js';

export interface BackupRun {
  readonly backupRunId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly bytes: number | null;
  readonly eventCount: number | null;
  readonly error: string | null;
  /** Where the encrypted copy landed. Null when it never left the district. */
  readonly offsiteKey: string | null;
  readonly offsiteAt: string | null;
  readonly offsiteError: string | null;
}

export interface BackupView {
  readonly health: BackupHealth;
  readonly replication: ReplicationHealth;
  /** Whether a copy can leave the building at all. Not the same as whether one has. */
  readonly offsiteConfigured: boolean;
  readonly offsiteWhy: string | null;
  /** When a dump last actually left the district. The question that matters after a fire. */
  readonly lastOffsiteAt: string | null;
  readonly recent: readonly BackupRun[];
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  /**
   * Stated on the screen rather than left as an absence, because somebody will look for it.
   * See the header, and D-06 on the district's list.
   */
  readonly restoreNote: string;
}

const RESTORE_NOTE =
  'Restoring over the live database is not a button here. One mis-click replaces the ' +
  'district’s whole record with an older copy and there is no undo. Use “verify” to prove a ' +
  'backup restores cleanly; the swap itself is a deliberate act on the server — see the ' +
  'runbook.';

export async function backupsForConsole(
  pool: Pool,
  identity: Identity,
  options: { readonly directory: string; readonly env?: OffsiteEnv } = { directory: '' },
): Promise<AdminResult<BackupView>> {
  const denied = requireAdministration<BackupView>(identity);
  if (denied !== null) return denied;

  const env = options.env ?? (process.env as OffsiteEnv);
  const store = offsiteStore(env);

  const [health, replication, runs, lastOffsite] = await Promise.all([
    backupHealth(pool),
    replicationHealthSafe(pool),
    pool.query<{
      backup_run_id: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      bytes: string | null;
      event_count: number | null;
      error: string | null;
      offsite_key: string | null;
      offsite_at: string | null;
      offsite_error: string | null;
    }>(
      `SELECT backup_run_id, status, started_at, finished_at, bytes, event_count, error,
              offsite_key, offsite_at, offsite_error
         FROM backup_run
        ORDER BY started_at DESC
        LIMIT 20`,
    ),
    pool.query<{ at: string | null }>(
      'SELECT max(offsite_at) AS at FROM backup_run WHERE offsite_at IS NOT NULL',
    ),
  ]);

  // Listed from disk rather than from the ledger, because the two can disagree and the
  // disagreement is the interesting part: a ledger row whose file somebody deleted is a
  // backup the district thinks it has.
  let files: { name: string; bytes: number }[] = [];
  try {
    const names = await readdir(options.directory);
    files = await Promise.all(
      names
        .filter((n) => n.endsWith('.sql'))
        .map(async (name) => ({
          name,
          bytes: (await stat(join(options.directory, name))).size,
        })),
    );
    files.sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    // No directory yet. Not an error — it means no backup has ever been taken here, which
    // `health.ok` already reports as the serious thing it is.
    files = [];
  }

  return {
    ok: true,
    value: {
      health,
      replication,
      offsiteConfigured: store.configured,
      offsiteWhy: store.why,
      lastOffsiteAt: lastOffsite.rows[0]?.at ?? null,
      recent: runs.rows.map((r) => ({
        backupRunId: r.backup_run_id,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        bytes: r.bytes === null ? null : Number(r.bytes),
        eventCount: r.event_count,
        error: r.error,
        offsiteKey: r.offsite_key,
        offsiteAt: r.offsite_at,
        offsiteError: r.offsite_error,
      })),
      files,
      restoreNote: RESTORE_NOTE,
    },
  };
}

/**
 * Take one now.
 *
 * Safe to press twice: `Nightly` refuses to start a second run while one is in flight, so a
 * second click gets told a backup is already running rather than starting one that competes
 * with the first for the same disk.
 */
export async function backupNow(
  identity: Identity,
  nightly: Nightly | null,
): Promise<AdminResult<{ readonly ran: boolean; readonly reason: string }>> {
  const denied = requireAdministration<{ ran: boolean; reason: string }>(identity);
  if (denied !== null) return denied;

  if (nightly === null) {
    return {
      ok: false,
      status: 503,
      error: 'the backup job is not running on this server',
    };
  }

  const outcome = await nightly.runNow();
  return { ok: true, value: { ran: outcome.ran, reason: outcome.reason } };
}
