/**
 * Backup — M0-37.
 *
 * In TypeScript rather than a shell script for two reasons. The hosting decision is still
 * open (P-08), so a PowerShell-only backup would be a Windows commitment made by accident;
 * and a backup nobody has tested is the least trustworthy component in any system, so it
 * belongs where the test suite can reach it.
 *
 * Three properties, and every one of them exists because of a way backups quietly fail:
 *
 * 1. **The attempt is recorded before the dump is tried.** A process killed mid-dump leaves
 *    a `running` row rather than no row at all. Same shape as a notification attempt
 *    (M0-32): the gap between starting and finishing has to be visible, because that is
 *    exactly the window in which people assume everything is fine.
 * 2. **A dump is verified, not assumed.** `pg_dump` exiting 0 is not evidence — an empty
 *    file, a truncated file and a file full of errors all exit 0 under the right
 *    circumstances. Size, checksum, and the event count inside the dump are checked against
 *    the live database.
 * 3. **Failure is loud.** The run is recorded as failed with the reason, and `/health`
 *    degrades once the last success is old enough. A backup that stopped working three
 *    weeks ago and told nobody is the normal way this goes wrong.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from '../db/pool.js';

/** Beyond this, the last successful backup is old enough to be a problem worth shouting about. */
export const BACKUP_STALE_HOURS = 24;

export interface BackupResult {
  readonly backupRunId: string;
  readonly ok: boolean;
  readonly path?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly eventCount?: number;
  readonly error?: string;
}

export interface BackupOptions {
  /** Where dumps are written. Created if absent. */
  readonly directory: string;
  /** The database to dump. Defaults to the pool's own `DATABASE_URL`. */
  readonly connectionString?: string;
  /**
   * Directory holding `pg_dump`. Defaults to whatever is on PATH.
   *
   * The local cluster is portable and deliberately not on PATH (see scripts/dev-db.ps1), so
   * this is how the development and test environments find it without a global install.
   */
  readonly pgBin?: string;
  readonly now?: () => Date;
}

function binary(name: string, pgBin?: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin === undefined || pgBin === '' ? exe : join(pgBin, exe);
}

export interface RunResult {
  readonly code: number | null;
  readonly stderr: string;
}

/** Run a Postgres client binary to completion, capturing stderr for the ledger. */
export function runTool(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: { ...process.env, ...env } });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a pathological failure must not turn an error message into a memory leak.
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * How many events the dump actually contains.
 *
 * Counted from the file rather than trusted from the database, because the number that
 * matters is what was *written*, not what was there when the dump started. `pg_dump` writes
 * the table as a COPY block terminated by a lone `\.`, so the rows between the two are the
 * rows a restore will replay.
 */
export async function countEventsInDump(path: string): Promise<number> {
  const text = await readFile(path, 'utf8');
  const start = text.indexOf('COPY public.incident_event');
  if (start === -1) return 0;

  const from = text.indexOf('\n', start) + 1;
  const end = text.indexOf('\n\\.', from);
  if (from === 0 || end === -1) return 0;

  const body = text.slice(from, end);
  if (body.trim().length === 0) return 0;
  return body.split('\n').length;
}

/**
 * Take one backup, verify it, and record what happened either way.
 *
 * Never throws for an operational failure. A backup job that crashes is a backup job whose
 * failure depends on somebody reading a stack trace; this one always leaves a row.
 */
export async function runBackup(pool: Pool, options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const connectionString = options.connectionString ?? process.env['DATABASE_URL'] ?? '';

  const started = await pool.query<{ backup_run_id: string }>(
    'INSERT INTO backup_run (status) VALUES ($1) RETURNING backup_run_id',
    ['running'],
  );
  const backupRunId = started.rows[0]!.backup_run_id;

  const fail = async (error: string): Promise<BackupResult> => {
    await pool.query(
      'UPDATE backup_run SET status = $2, finished_at = now(), error = $3 WHERE backup_run_id = $1',
      [backupRunId, 'failed', error],
    );
    return { backupRunId, ok: false, error };
  };

  try {
    if (connectionString === '') {
      return await fail('no connection string: DATABASE_URL is not set');
    }

    await mkdir(options.directory, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const path = join(options.directory, `dnc-${stamp}.sql`);

    // Plain SQL, not the custom format. A district office at 02:00 can read a .sql file,
    // grep it, and replay it with psql alone (ADR-0007). `pg_restore` is one more tool to
    // have installed and one more thing to be wrong about under pressure.
    const dump = await runTool(binary('pg_dump', options.pgBin), [
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--file',
      path,
      connectionString,
    ]);

    if (dump.code !== 0) {
      return await fail(`pg_dump exited ${String(dump.code)}: ${dump.stderr || 'no output'}`);
    }

    // pg_dump exiting 0 is not evidence of anything useful.
    const info = await stat(path).catch(() => null);
    if (info === null) return await fail('pg_dump reported success but wrote no file');
    if (info.size === 0) return await fail('pg_dump wrote an empty file');

    const [sha256, eventCount, live] = await Promise.all([
      sha256Of(path),
      countEventsInDump(path),
      pool.query<{ n: string }>('SELECT count(*)::text AS n FROM incident_event'),
    ]);

    const liveCount = Number(live.rows[0]?.n ?? 0);
    if (eventCount < liveCount) {
      // Not a warning. A dump holding fewer events than the database it came from would
      // restore to a district missing emergencies, and INV-01 does not stop applying
      // because the failure happened during maintenance.
      return await fail(
        `dump holds ${eventCount} events but the database has ${liveCount} — refusing to call this a backup`,
      );
    }

    await pool.query(
      `UPDATE backup_run
          SET status = 'ok', finished_at = now(), path = $2, bytes = $3, sha256 = $4, event_count = $5
        WHERE backup_run_id = $1`,
      [backupRunId, path, info.size, sha256, eventCount],
    );

    return { backupRunId, ok: true, path, bytes: info.size, sha256, eventCount };
  } catch (err) {
    return await fail(`backup threw: ${String(err)}`);
  }
}

export interface BackupHealth {
  readonly ok: boolean;
  readonly lastSuccessAt: string | null;
  readonly ageHours: number | null;
  /** A run that started and never finished. The process died; nothing recorded a failure. */
  readonly stuckRuns: number;
}

/**
 * Is the district's backup actually working?
 *
 * Reported by `/health`, which is the one endpoint anybody checks. `ok: false` with no
 * backup at all is the correct answer for a fresh install — silence is not success
 * (ADR-0005), and a system that has never been backed up should say so from the first day
 * rather than at the first restore.
 */
export async function backupHealth(
  pool: Pool,
  staleHours = BACKUP_STALE_HOURS,
): Promise<BackupHealth> {
  const res = await pool.query<{ last: string | null; stuck: string }>(
    `SELECT (SELECT max(finished_at) FROM backup_run WHERE status = 'ok')  AS last,
            (SELECT count(*)::text FROM backup_run
              WHERE status = 'running' AND started_at < now() - interval '2 hours') AS stuck`,
  );

  const row = res.rows[0];
  const lastSuccessAt = row?.last ?? null;
  const stuckRuns = Number(row?.stuck ?? 0);

  if (lastSuccessAt === null) {
    return { ok: false, lastSuccessAt: null, ageHours: null, stuckRuns };
  }

  const ageHours = (Date.now() - Date.parse(lastSuccessAt)) / 3_600_000;
  return { ok: ageHours <= staleHours && stuckRuns === 0, lastSuccessAt, ageHours, stuckRuns };
}
