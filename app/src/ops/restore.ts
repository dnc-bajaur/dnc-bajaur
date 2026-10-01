/**
 * Restore — the half of M0-37 that actually matters, and the mechanism M0-38 drills.
 *
 * **A backup is a claim. A restore is the evidence.** Everything in `backup.ts` is
 * worthless until this has been run by somebody who did not write it, against a dump they
 * did not produce, on a day when it matters. That is M0-38 and it needs a person.
 *
 * What this file can do is make the path known-good, so the person running the drill is
 * following a procedure that has been executed rather than one that has been written down.
 * `docs/08-runbook.md` is the human version of exactly these steps.
 *
 * Two things it deliberately refuses to do:
 *
 * - **It will not restore over an existing database.** Every restore goes into a named
 *   target that the caller has to state. A restore tool whose easiest path overwrites
 *   production is a tool that will eventually overwrite production, at 02:00, by someone
 *   tired.
 * - **It will not report success on `psql` exiting 0.** The dump is replayed and then the
 *   result is *counted and compared*. "The command completed" is not "the district's
 *   emergencies are back".
 */

import { readFile } from 'node:fs/promises';

import { createPool, type Pool } from '../db/pool.js';
import { runTool } from './backup.js';
import { join } from 'node:path';

function binary(name: string, pgBin?: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return pgBin === undefined || pgBin === '' ? exe : join(pgBin, exe);
}

export interface RestoreOptions {
  /** The dump to replay. */
  readonly dumpPath: string;
  /**
   * A connection string for the **target**, which must already exist and should be empty.
   * Never defaulted, never inferred: naming the target is the safety mechanism.
   */
  readonly targetUrl: string;
  readonly pgBin?: string;
  /** Compare the restored event count against this. Usually the live database's count. */
  readonly expectEvents?: number;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly eventCount: number;
  readonly error?: string;
  /** Wall-clock seconds. The drill has to be timed — a restore nobody timed is untested. */
  readonly seconds: number;
  /**
   * Checks that could not be **carried out** — O-37, 2026-08-20. Present on a successful restore.
   *
   * ⚠️ **These are not failures and must never be rendered as ok.** *"The guard is missing"* and
   * *"the guard could not be tried"* are different sentences: the first is a database somebody
   * must not put into service, the second is usually an empty target and is a perfectly good
   * restore. Collapsing them either loses the alarm or cries wolf on every new installation — and
   * a check that cries wolf is one people learn to step past, which is how this repository's own
   * shell-version guard was rubber-stamped for four commits.
   *
   * The same shape `/health` already uses: `degraded` rather than a failing status code.
   */
  readonly unproven?: readonly string[];
}

/**
 * Replay a dump into a named target and verify what came back.
 *
 * The verification is the point. It reloads the event log, counts it, and — when the caller
 * says what to expect — refuses to call a short restore a success.
 */
export async function restoreInto(options: RestoreOptions): Promise<RestoreResult> {
  const startedAt = Date.now();
  const seconds = (): number => Math.round((Date.now() - startedAt) / 100) / 10;

  const sql = await readFile(options.dumpPath, 'utf8').catch(() => null);
  if (sql === null) {
    return { ok: false, eventCount: 0, error: `cannot read ${options.dumpPath}`, seconds: 0 };
  }

  // `ON_ERROR_STOP` is not optional. Without it psql reports success after replaying a dump
  // that half-failed, which is the single most dangerous default in this whole procedure:
  // you get a database, it is missing things, and nothing said so.
  const replay = await runTool(binary('psql', options.pgBin), [
    '--quiet',
    '--set',
    'ON_ERROR_STOP=1',
    '--file',
    options.dumpPath,
    options.targetUrl,
  ]);

  if (replay.code !== 0) {
    return {
      ok: false,
      eventCount: 0,
      error: `psql exited ${String(replay.code)}: ${replay.stderr || 'no output'}`,
      seconds: seconds(),
    };
  }

  let pool: Pool | null = null;
  try {
    pool = createPool(options.targetUrl);
    const res = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM incident_event');
    const eventCount = Number(res.rows[0]?.n ?? 0);

    if (options.expectEvents !== undefined && eventCount < options.expectEvents) {
      return {
        ok: false,
        eventCount,
        error: `restored ${eventCount} events, expected at least ${String(options.expectEvents)}`,
        seconds: seconds(),
      };
    }

    /**
     * **And the guarantee, not only the rows — O-37, 2026-08-20.**
     *
     * Until this line, a restore was called a success on two facts: `psql` exited cleanly and the
     * event count was not short. **Neither of them can see the append-only triggers**, and a
     * `pg_dump` puts those at the very end of the file — measured on a real dump, the event data
     * begins at **43%** and the first `CREATE TRIGGER` sits at **85%**. So a dump truncated
     * anywhere between the two restores every row, satisfies both checks, and hands somebody a
     * database where **the event log can be edited and nothing says so.**
     *
     * ⚠️ **`verifyRestoredIntegrity` was written for exactly this, is correct, and nothing called
     * it.** The runbook's step 5 tells a human to run the same three checks by hand, so anybody
     * following the paper was protected — the hole was for whoever trusted this function's own
     * answer instead. **The guard existed; the wiring did not.**
     */
    const integrity = await verifyRestoredIntegrity(pool);
    if (!integrity.ok) {
      return {
        ok: false,
        eventCount,
        error: `restored ${eventCount} events, but ${integrity.problems.join('; ')}`,
        seconds: seconds(),
      };
    }

    return {
      ok: true,
      eventCount,
      seconds: seconds(),
      // Spread rather than assigned: `exactOptionalPropertyTypes` is on, and *nothing to report*
      // must be the field being absent rather than an empty array somebody has to check for.
      ...(integrity.unproven.length > 0 ? { unproven: integrity.unproven } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      eventCount: 0,
      error: `restored database is not queryable: ${String(err)}`,
      seconds: seconds(),
    };
  } finally {
    await pool?.end();
  }
}

export interface IntegrityReport {
  /** False only when a guarantee is **provably** missing. See `unproven`. */
  readonly ok: boolean;
  readonly problems: readonly string[];
  /**
   * Checks that could not be carried out — O-37, 2026-08-20.
   *
   * **An empty `incident_event` is the whole of this today.** The append-only guard is proven by
   * attempting a forbidden `UPDATE` on a real row; with no rows there is nothing to attempt it on,
   * and that is neither a pass nor a failure. It was counted as a **problem** until this date,
   * which is defensible in isolation and wrong once `restoreInto` reads `ok`: every restore of a
   * new installation would then report failure, and the district would learn to ignore the word.
   */
  readonly unproven: readonly string[];
}

/**
 * Is the restored database actually the system, or just its data?
 *
 * The distinction has bitten real projects: a restore that brings back rows but not the
 * append-only triggers gives you a database where the event log can be edited, and nobody
 * notices until an audit. The whole of `ADR-0001` is enforced by those triggers, so a
 * restore that loses them has restored the data and lost the guarantee.
 */
export async function verifyRestoredIntegrity(pool: Pool): Promise<IntegrityReport> {
  const problems: string[] = [];
  const unproven: string[] = [];

  const triggers = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'incident_event'::regclass AND NOT tgisinternal`,
  );
  if (triggers.rows.length === 0) {
    problems.push(
      'incident_event has no append-only triggers: the data is back but ADR-0001 is not enforced',
    );
  }

  // Prove it rather than trust the catalogue: try an actual mutation and require it to be
  // refused.
  //
  // Two details, both learned by getting this wrong. The guard is a **row-level** trigger
  // (migration 0001), so a probe with `WHERE false` matches nothing, fires nothing, and
  // reports a healthy database as broken. It has to target a real row. And it runs inside a
  // transaction that is **always** rolled back, so that on the one database where this
  // check matters — the one where the guard is missing — the probe cannot be the thing that
  // rewrites history.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query<{ event_id: string }>(
      'SELECT event_id FROM incident_event LIMIT 1',
    );
    const eventId = target.rows[0]?.event_id;

    if (eventId === undefined) {
      /**
       * Nothing to probe with, and **that is not a failure** — moved out of `problems` on
       * 2026-08-20 when `restoreInto` began reading `ok`.
       *
       * The honest answer is still to say so, which `unproven` does. What changed is that saying
       * *"I could not check"* no longer means *"this restore failed"*: a brand-new installation
       * has no events, its restore is perfectly good, and reporting it red would teach whoever is
       * at the keyboard at 02:00 to ignore the one word that matters on the night it is real.
       */
      unproven.push(
        'incident_event is empty, so the append-only guard could not be proven by trying it',
      );
    } else {
      const res = await client.query(
        'UPDATE incident_event SET source_channel = source_channel WHERE event_id = $1',
        [eventId],
      );
      if ((res.rowCount ?? 0) > 0) {
        problems.push('UPDATE on incident_event was accepted; the append-only guard is not active');
      }
    }
  } catch {
    // Expected on a healthy database: the trigger raised.
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  const migrations = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM schema_migration',
  );
  if (Number(migrations.rows[0]?.n ?? 0) === 0) {
    problems.push('schema_migration is empty: the restored database will re-run every migration');
  }

  return { ok: problems.length === 0, problems, unproven };
}
