/**
 * Every test file starts with an empty district — M9-57's real fix.
 *
 * ## The disease, which this project has documented three times and fixed none of
 *
 * `globalSetup.ts`'s own header says it plainly: *"The test database is never cleaned. Every run
 * leaves its departments, seats and events behind."* It warns, counts, and names the command —
 * and it has still cost an evening twice, because a warning is not a fix.
 *
 * What that residue actually does is worse than being slow:
 *
 *   * **1,335 departments** had accumulated by 13 August, against Bajaur's 79. Two browser suites
 *     spend their whole budget painting a screen no real district will ever produce.
 *   * **Routing signals left by one suite change what another suite's incidents do.** That is
 *     not cosmetic at all. It is what caused all three of the long-standing order-dependent
 *     failures in `whatsappLoop.test.ts`: an emergency reported with category `fire` was
 *     auto-routed by a rule a different file had written, a second message went out, and the
 *     test then tapped the wrong acknowledge token.
 *   * The same shape appeared twice more in one milestone, in `dailyReport.test.ts` and in
 *     `search.e2e.test.ts`. **Three files, one disease.**
 *
 * Those three were fixed one at a time, by making each test stop depending on configuration it
 * did not own. That was right, and it was treating symptoms. This is the cause.
 *
 * ## Why the schema is dropped rather than emptied
 *
 * The first attempt was `TRUNCATE`, and **the database refused it**:
 *
 *     config_event is append-only; TRUNCATE is not permitted.
 *     Correct a mistake by appending a new event.
 *
 * That is a trigger in migration 0007, and one in 0001 for `incident_event`, enforcing ADR-0001
 * **in PostgreSQL** rather than in code — because, as 0001's own header says, the log is only
 * genuinely immutable if the database says so.
 *
 * The obvious way round it is to disable the trigger for the duration. **That was refused**:
 * it would put a working "make the district's record mutable" procedure into the repository,
 * one environment variable away from being pointed at Bajaur. A test harness that can defeat an
 * invariant is a test harness that has already defeated it.
 *
 * So the schema is dropped and rebuilt from the migrations, which is what `npm run test:reset`
 * has always done — the guard is passed through, not around. It costs the twenty-eight
 * migrations per file, and that is the price of not owning a tool that can erase a district.
 *
 * ## Why not a database per worker
 *
 * `vitest.config.ts` sets `fileParallelism: false` — files run **serially**. There is no
 * concurrent interference to isolate against; there is only accumulation, and a fresh schema
 * ends accumulation.
 *
 * ## What this must never do
 *
 * **Touch anything but the test database.** It reads `TEST_DATABASE_URL` and nothing else, it
 * runs only when that variable is set, and it is imported solely by `vitest.config.ts`'s
 * `setupFiles`. It cannot reach production: production's URL is `DATABASE_URL`, a different
 * variable this file never reads.
 */

import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate } from '../db/pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

/**
 * Rebuild the test database's schema, once, before a test file runs.
 *
 * Silent on success — a line per file across eighty-eight files is noise that hides the one line
 * somebody needs to read. It throws on failure rather than continuing quietly: a file that starts
 * against a database it could not clean is a file whose result cannot be trusted, and that is
 * exactly the outcome this exists to end.
 */
export async function emptyTestDatabase(url: string): Promise<void> {
  const client = new Client(url);
  await client.connect();

  try {
    /**
     * `DROP SCHEMA public CASCADE` takes the append-only tables with it, and the guard does not
     * object — it forbids changing the **contents** of a log, not removing a schema that holds
     * no district's record. `npm run test:reset` has always worked this way.
     *
     * `AUTHORIZATION CURRENT_USER` on the recreate, because the default owner of a schema
     * created by a superuser is not necessarily the role the tests then connect as.
     */
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
    await client.query('GRANT ALL ON SCHEMA public TO public');
  } finally {
    await client.end();
  }

  // Re-applied through the same `migrate` the application runs at boot, so a test can never be
  // running against a schema shape production has never seen.
  const pool = createPool(url);
  try {
    await migrate(pool, migrationsDir);
  } finally {
    await pool.end();
  }
}
