/**
 * The nightly backup — M0-53.
 *
 * P-08 held this up for weeks: the backup was built and verified and nothing scheduled it.
 * These tests are about the ways a schedule silently stops happening, which is the failure
 * that matters — a backup nobody notices has stopped is worse than no backup, because the
 * district spends a year believing it is covered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { createNightly, type Nightly } from '../nightly.js';
import type { OffsiteStore } from '../../ops/offsite.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSPHRASE = 'a-passphrase-long-enough-to-be-accepted';

/**
 * Where `pg_dump` lives.
 *
 * The local cluster is portable and deliberately not on PATH (see `scripts/dev-db.ps1`), so
 * the binaries are found by configuration rather than by luck — the same way a deployment
 * does it, and the same fallback `ops/__tests__/backup.test.ts` uses.
 */
const pgBin =
  process.env['PG_BIN'] ??
  (process.env['LOCALAPPDATA'] === undefined
    ? undefined
    : join(process.env['LOCALAPPDATA'], 'dnc-postgres', 'pgsql', 'bin'));

function fakeStore(): OffsiteStore & { puts: Map<string, Buffer> } {
  const puts = new Map<string, Buffer>();
  return {
    puts,
    name: 'fake',
    configured: true,
    why: null,
    put: async (key, bytes) => {
      puts.set(key, bytes);
    },
    list: async () => [...puts.entries()].map(([key, b]) => ({ key, bytes: b.length })),
  };
}

describe.skipIf(dbUrl === undefined)('the nightly backup (integration)', () => {
  let pool: Pool;
  let directory: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    directory = await mkdtemp(join(tmpdir(), 'dnc-nightly-'));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    // The directory this suite made, removed. Five suites created one and only one deleted
    // it, so every full run left its dumps and evidence behind in the system temp folder —
    // 287 directories and 840 MB of them by the time somebody's disk filled up. A test that
    // litters is a test that eventually stops the machine it runs on.
    await rm(directory, { recursive: true, force: true });
  });

  function nightly(at: Date, store: OffsiteStore): Nightly {
    return createNightly({
      pool,
      backup: {
        directory,
        // The database the pool is on, not whatever `DATABASE_URL` happens to say. In this
        // repository those differ — the pool is on `dnc_test` and `DATABASE_URL` points at
        // `dnc_dev` — and without this the job dumps one and verifies against the other.
        // `runBackup`'s event-count check caught exactly that, which is the check earning
        // its keep rather than a reason to leave the ambiguity in place.
        connectionString: dbUrl!,
        ...(pgBin === undefined ? {} : { pgBin }),
      },
      store,
      env: { BACKUP_PASSPHRASE: PASSPHRASE },
      now: () => at,
    });
  }

  /** Push every recent success out of the window, so a test can assert on "none taken yet". */
  async function forgetRecent(): Promise<void> {
    await pool.query(
      `UPDATE backup_run SET finished_at = finished_at - interval '2 days'
        WHERE finished_at >= now() - interval '2 days'`,
    );
  }

  /**
   * The reason this is a poll and not a timer, and why hourly needs it more than nightly did.
   *
   * A district server gets rebooted, loses power, and is occasionally a laptop somebody closed.
   * A timer set for the top of the hour is a timer that never fires if the machine was asleep
   * at that moment — and at twenty-four chances a day, silently skipping the ones that fall in
   * an outage is exactly how an hourly schedule quietly becomes a daily one.
   */
  it('takes one immediately on a server that was off when the hour turned', async () => {
    await forgetRecent();

    // Well past the top of the hour: a timer would have missed it, a poll does not.
    const at = new Date();
    at.setMinutes(47, 0, 0);

    const outcome = await nightly(at, fakeStore()).tick();
    expect(outcome.ran).toBe(true);
    expect(outcome.backupOk).toBe(true);
  }, 120_000);

  it('does not take a second one in the same hour', async () => {
    // The previous test already took this hour's.
    const at = new Date();
    at.setMinutes(59, 0, 0);

    const outcome = await nightly(at, fakeStore()).tick();
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain('already taken this hour');
  });

  it('takes another one as soon as the hour turns — the seventeen-hour hole is the point', async () => {
    /**
     * The whole change, in one assertion.
     *
     * Nightly meant a machine lost at 20:00 restored to 02:57 that morning and **every
     * emergency, acknowledgement and notification in between was gone** — not delayed, gone.
     * This is what closes that to an hour, so it is worth a test of its own rather than being
     * left implied by the one above.
     */
    const at = new Date();
    at.setMinutes(59, 0, 0);
    const nextHour = new Date(at.getTime() + 60 * 60_000);

    const outcome = await nightly(nextHour, fakeStore()).tick();
    expect(outcome.ran).toBe(true);
    expect(outcome.backupOk).toBe(true);
  }, 120_000);

  it('writes a dump and sends an encrypted copy out of the district', async () => {
    await forgetRecent();
    const store = fakeStore();

    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const outcome = await nightly(at, store).tick();

    expect(outcome.backupOk).toBe(true);
    expect(outcome.offsiteOk).toBe(true);

    const files = await readdir(directory);
    expect(files.some((f) => f.endsWith('.sql'))).toBe(true);

    // What left the building is encrypted, and it is not the file on disk.
    expect(store.puts.size).toBeGreaterThan(0);
    const [key] = [...store.puts.keys()];
    expect(key).toMatch(/\.sql\.enc$/);
  }, 120_000);

  /**
   * A district with no bucket still gets a local backup, and the ledger still says the copy
   * did not leave. "We did not try" must not render as "it worked" (R-06).
   */
  it('takes the local backup even when nothing can leave the building', async () => {
    await forgetRecent();

    const unconfigured: OffsiteStore = {
      name: 'none',
      configured: false,
      why: 'no bucket yet (R-06)',
      put: () => Promise.reject(new Error('not configured')),
      list: () => Promise.resolve([]),
    };

    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const outcome = await nightly(at, unconfigured).tick();

    expect(outcome.backupOk).toBe(true);
    expect(outcome.offsiteOk).toBe(false);
    expect(outcome.offsiteSkipped).toContain('R-06');
  }, 120_000);

  it('takes one on demand, whatever the hour', async () => {
    // The console's "back up now" button. It ignores the schedule on purpose: an
    // administrator pressing it has a reason, usually just before something risky.
    const at = new Date();
    at.setHours(11, 0, 0, 0);

    const outcome = await nightly(at, fakeStore()).runNow();
    expect(outcome.ran).toBe(true);
    expect(outcome.reason).toBe('asked for');
  }, 120_000);

  it('refuses to start a second run while one is in flight', async () => {
    // Two `pg_dump`s competing for the same disk produce two dumps of the same night and
    // make the slower one slower still.
    const at = new Date();
    at.setHours(3, 0, 0, 0);
    const job = nightly(at, fakeStore());

    const [first, second] = await Promise.all([job.runNow(), job.runNow()]);
    const ran = [first, second].filter((o) => o.ran);
    const refused = [first, second].filter((o) => !o.ran);

    expect(ran).toHaveLength(1);
    expect(refused[0]?.reason).toContain('already running');
  }, 120_000);
});
