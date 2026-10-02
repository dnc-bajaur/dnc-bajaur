/**
 * Backup and restore — M0-37, and the mechanism M0-38's human drill follows.
 *
 * **This is a real round trip.** It runs `pg_dump` against the real cluster, writes a real
 * file, replays it into a real second database with `psql`, and then reads the event log
 * back out and compares it. Nothing here is mocked, because the only property worth testing
 * is the one a mock cannot have: that the emergencies come back.
 *
 * What this does **not** do is close M0-38. A restore performed by the person who wrote the
 * restore code, on their own machine, against their own dump, is a test of the code. The
 * gate asks for a drill by somebody else, and it stays open until somebody else has done it.
 * See `docs/08-runbook.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import type { IncidentEvent } from '../../domain/events.js';
import { foldIncident } from '../../domain/incident.js';
import { runBackup, backupHealth, countEventsInDump, BACKUP_STALE_HOURS } from '../backup.js';
import { restoreInto, verifyRestoredIntegrity } from '../restore.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

/**
 * The portable cluster is deliberately not on PATH (scripts/dev-db.ps1), so tests find its
 * binaries the same way a deployment would: by configuration, not by luck.
 */
const pgBin =
  process.env['PG_BIN'] ??
  (process.platform === 'win32' ? 'D:\\dnc-bajaur-postgres\\pgsql\\bin' : undefined);

describe.skipIf(dbUrl === undefined)('backup and restore (M0-37)', () => {
  let pool: Pool;
  let dir: string;
  let incidentId: string;
  /** Databases created by these tests, dropped in teardown. */
  const scratch: string[] = [];

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    dir = await mkdtemp(join(tmpdir(), 'dnc-backup-'));

    // A real incident with a real history, so the round trip has something to lose.
    incidentId = randomUUID();
    const now = new Date().toISOString();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: now,
        recordedAt: now,
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category: 'flood', severity: 'critical' },
      } as unknown as IncidentEvent,
    ]);
  }, 120_000);

  afterAll(async () => {
    for (const name of scratch) {
      await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    }
    await pool?.end();
    await rm(dir, { recursive: true, force: true });
  });

  /** `exactOptionalPropertyTypes` is on, so optionals are omitted rather than set to undefined. */
  const bin = pgBin === undefined ? {} : { pgBin };

  function backupOptions(): { directory: string; connectionString: string; pgBin?: string } {
    return { directory: dir, connectionString: dbUrl!, ...bin };
  }

  /** A fresh, empty database to restore into. Never the live one — see `restore.ts`. */
  async function scratchDatabase(): Promise<string> {
    const name = `dnc_restore_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await pool.query(`CREATE DATABASE ${name}`);
    scratch.push(name);
    return name;
  }

  function urlFor(database: string): string {
    const url = new URL(dbUrl!);
    url.pathname = `/${database}`;
    return url.toString();
  }

  describe('taking one', () => {
    it('writes a dump and records it as succeeded', async () => {
      const result = await runBackup(pool, backupOptions());

      expect(result.ok).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.eventCount).toBeGreaterThan(0);
    }, 120_000);

    it('records the attempt before the dump, so a killed process leaves a trace', async () => {
      // The row exists from the moment the run starts. A process killed mid-dump therefore
      // leaves a visible `running` row rather than no row at all — and a gap in this table
      // is the one thing nobody would notice.
      const before = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM backup_run');
      await runBackup(pool, backupOptions());
      const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM backup_run');

      expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
    }, 120_000);

    it('records a failure rather than throwing when pg_dump cannot run', async () => {
      const result = await runBackup(pool, {
        ...backupOptions(),
        pgBin: join(dir, 'no-such-directory'),
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();

      const row = await pool.query<{ status: string; error: string }>(
        'SELECT status, error FROM backup_run WHERE backup_run_id = $1',
        [result.backupRunId],
      );
      expect(row.rows[0]?.status).toBe('failed');
    }, 120_000);

    it('refuses to call an unreachable database a backup', async () => {
      const result = await runBackup(pool, {
        ...backupOptions(),
        connectionString: 'postgresql://nobody@127.0.0.1:1/none',
      });
      expect(result.ok).toBe(false);
    }, 120_000);
  });

  describe('the round trip', () => {
    it('restores into a fresh database and the emergencies come back', async () => {
      const backup = await runBackup(pool, backupOptions());
      expect(backup.ok).toBe(true);

      const target = await scratchDatabase();
      const result = await restoreInto({
        dumpPath: backup.path!,
        targetUrl: urlFor(target),
        ...bin,
        expectEvents: backup.eventCount!,
      });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.eventCount).toBe(backup.eventCount);
    }, 180_000);

    it('the restored incident folds to the same state, event for event', async () => {
      // Counting rows proves the data arrived. Folding it proves the *system* arrived — the
      // ordering, the payloads, the provenance. A restore that gets the count right and the
      // order wrong would pass a row count and fail an audit (ADR-0008).
      const backup = await runBackup(pool, backupOptions());
      const target = await scratchDatabase();
      await restoreInto({ dumpPath: backup.path!, targetUrl: urlFor(target), ...bin });

      const live = foldIncident(
        incidentId,
        (
          await pool.query<{ payload: unknown }>(
            'SELECT * FROM incident_event WHERE incident_id = $1 ORDER BY occurred_at, client_seq',
            [incidentId],
          )
        ).rows as never,
      );

      const restored = createPool(urlFor(target));
      try {
        const rows = await restored.query(
          'SELECT * FROM incident_event WHERE incident_id = $1 ORDER BY occurred_at, client_seq',
          [incidentId],
        );
        const after = foldIncident(incidentId, rows.rows as never);
        expect(after.eventCount).toBe(live.eventCount);
      } finally {
        await restored.end();
      }
    }, 180_000);

    it('the restored database still refuses to have its history rewritten', async () => {
      // The failure this catches: a restore that brings back the rows but not the triggers
      // gives you a database where the event log can be edited, and nobody finds out until
      // an audit. The data would be back and the guarantee would be gone.
      const backup = await runBackup(pool, backupOptions());
      const target = await scratchDatabase();
      await restoreInto({ dumpPath: backup.path!, targetUrl: urlFor(target), ...bin });

      const restored = createPool(urlFor(target));
      try {
        const report = await verifyRestoredIntegrity(restored);
        expect(report.problems).toEqual([]);
        expect(report.ok).toBe(true);
      } finally {
        await restored.end();
      }
    }, 180_000);

    /**
     * **An empty district restores fine, and the software says what it could not check — O-37.**
     *
     * The append-only guard is proven by attempting a forbidden `UPDATE` on a real row. With no
     * rows there is nothing to attempt it on, and that is **neither a pass nor a failure**. Until
     * 2026-08-20 it was counted as a problem, which was defensible while nothing read `ok` — and
     * became wrong the moment `restoreInto` did, because every restore of a new installation
     * would then report failure.
     *
     * ⚠️ **The direction matters more than the value.** A check that reddens on a correct restore
     * is one people learn to step past, and then it is not there on the night the guard really is
     * missing — which is how this repository's own shell-version guard was rubber-stamped for
     * four commits. So the honest answer is `ok` **plus the sentence**, never silence and never a
     * false alarm: the same shape `/health` already uses when it reports `degraded`.
     */
    it('calls an empty restore ok, and still says what it could not prove', async () => {
      const source = await scratchDatabase();
      const sourcePool = createPool(urlFor(source));
      let backupPath: string;
      try {
        // Migrated but never used: every trigger and every schema_migration row in place, and
        // not one event. That is a brand-new installation, exactly.
        await migrate(sourcePool, migrationsDir);
        const taken = await runBackup(sourcePool, {
          directory: dir,
          connectionString: urlFor(source),
          ...bin,
        });
        expect(taken.ok).toBe(true);
        backupPath = taken.path!;
      } finally {
        await sourcePool.end();
      }

      const target = await scratchDatabase();
      const result = await restoreInto({
        dumpPath: backupPath,
        targetUrl: urlFor(target),
        ...bin,
      });

      // A correct restore of a district that has recorded nothing yet.
      expect(result.ok).toBe(true);
      expect(result.eventCount).toBe(0);
      // And it does not go quiet about the half it could not carry out.
      expect(result.unproven ?? []).toHaveLength(1);
      expect((result.unproven ?? []).join(' ')).toContain('could not be proven');
    }, 180_000);

    it('reports how long it took, because an untimed drill is an untested one', async () => {
      const backup = await runBackup(pool, backupOptions());
      const target = await scratchDatabase();
      const result = await restoreInto({
        dumpPath: backup.path!,
        targetUrl: urlFor(target),
        ...bin,
      });
      expect(result.seconds).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.seconds)).toBe(true);
    }, 180_000);

    it('refuses a truncated dump instead of restoring most of it', async () => {
      const backup = await runBackup(pool, backupOptions());
      const truncated = join(dir, 'truncated.sql');
      const full = await readFile(backup.path!, 'utf8');
      await writeFile(truncated, full.slice(0, Math.floor(full.length / 2)), 'utf8');

      const target = await scratchDatabase();
      const result = await restoreInto({
        dumpPath: truncated,
        targetUrl: urlFor(target),
        ...bin,
        expectEvents: backup.eventCount!,
      });

      // Either psql stops on the error, or the verification catches the short count. Both
      // are correct; silently succeeding is the only wrong answer.
      expect(result.ok).toBe(false);
    }, 180_000);

    it('cannot read a dump that does not exist', async () => {
      const result = await restoreInto({
        dumpPath: join(dir, 'nothing-here.sql'),
        targetUrl: urlFor('postgres'),
        ...bin,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cannot read');
    });
  });

  describe('a failing backup is visible (ADR-0005: silence is not success)', () => {
    it('reports healthy after a successful run', async () => {
      await runBackup(pool, backupOptions());
      const health = await backupHealth(pool);
      expect(health.ok).toBe(true);
      expect(health.lastSuccessAt).not.toBeNull();
      expect(health.ageHours).toBeLessThan(1);
    }, 120_000);

    it('reports unhealthy once the last success is old', async () => {
      // A backup that stopped working three weeks ago and told nobody is the normal way
      // this goes wrong.
      const health = await backupHealth(pool, -1);
      expect(health.ok).toBe(false);
    });

    it('counts a run that started and never finished', async () => {
      // The process died mid-dump. Nothing was alive to record a failure, so the absence of
      // a finish is the only evidence there is.
      const stuck = await pool.query<{ backup_run_id: string }>(
        `INSERT INTO backup_run (status, started_at)
         VALUES ('running', now() - interval '6 hours') RETURNING backup_run_id`,
      );
      try {
        const health = await backupHealth(pool);
        expect(health.stuckRuns).toBeGreaterThan(0);
        expect(health.ok).toBe(false);
      } finally {
        await pool.query('DELETE FROM backup_run WHERE backup_run_id = $1', [
          stuck.rows[0]!.backup_run_id,
        ]);
      }
    });

    it('a database that has never been backed up is unhealthy, not silent', async () => {
      const target = await scratchDatabase();
      const fresh = createPool(urlFor(target));
      try {
        await migrate(fresh, migrationsDir);
        const health = await backupHealth(fresh);
        expect(health.ok).toBe(false);
        expect(health.lastSuccessAt).toBeNull();
      } finally {
        await fresh.end();
      }
    }, 120_000);

    it('uses a 24-hour staleness threshold by default', () => {
      expect(BACKUP_STALE_HOURS).toBe(24);
    });
  });

  describe('counting what is actually in the dump', () => {
    it('reads the event count out of the file rather than trusting the database', async () => {
      const backup = await runBackup(pool, backupOptions());
      const counted = await countEventsInDump(backup.path!);
      const live = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM incident_event',
      );
      expect(counted).toBeGreaterThanOrEqual(Number(live.rows[0]!.n) - 1);
    }, 120_000);

    it('returns zero for a file with no event table in it', async () => {
      const empty = join(dir, 'empty.sql');
      await writeFile(empty, '-- nothing here\n', 'utf8');
      expect(await countEventsInDump(empty)).toBe(0);
    });
  });
});
