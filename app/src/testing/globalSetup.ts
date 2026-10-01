import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/**
 * The canary for the per-file clean — and it used to be the warning itself.
 *
 * ## What this file used to say, and why it is worth keeping the story
 *
 * It said: *"The test database is never cleaned. Every run leaves its departments, seats and
 * events behind, and after a few weeks the count is in the thousands where a real directory has about 80."* It
 * counted, it warned, and it named the command that fixed it. **It had still cost an evening
 * twice**, and by 13 August the database held **1,335 departments** — because a warning is not a
 * fix, and a warning nobody is obliged to act on is a warning people learn to scroll past.
 *
 * Worse than slow: routing signals left by one suite changed what another suite's incidents did.
 * That produced the three long-standing order-dependent failures in `whatsappLoop.test.ts`, and
 * the same shape twice more — in `dailyReport.test.ts` and `search.e2e.test.ts`. Three files,
 * one disease, chased one at a time across a whole milestone.
 *
 * ## What it says now
 *
 * `testing/freshDatabase.ts` rebuilds the schema before **every** test file, so the drift this
 * was written to warn about **can no longer happen**. The query is kept anyway, and its meaning
 * is inverted: if it ever fires again, the per-file clean has stopped working, and that is worth
 * knowing before somebody spends a third evening on it.
 *
 * Still a **warning, not a failure**. Stopping the run would be a worse trade than printing four
 * lines — and if the clean is broken, the suite's own failures will say so far more loudly.
 *
 * CI never sees this — the workflow starts a fresh PostgreSQL container every run.
 */

/** A real district directory has about 80 entries. Past this, the data is the suite's own residue, not a district. */
const DRIFTED = 200;

export async function setup(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '..', '..', '.env');

  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }

  const url = process.env['TEST_DATABASE_URL'];

  if (url === undefined || process.env['CI'] !== undefined) {
    return;
  }

  const client = new Client(url);

  try {
    await client.connect();
    // ADR-0030 — the department table is gone, so the drift this warned about cannot happen in
    // the shape it watched for. Counting POSTS instead asks the same question about the thing
    // that is actually accumulated now: a real directory has ~80, so the threshold still means something.
    const result = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM seat WHERE retired_at IS NULL',
    );
    const departments = Number(result.rows[0]?.n ?? '0');

    if (departments > DRIFTED) {
      process.stderr.write(
        `\n  The test database holds ${String(departments)} departments. A real directory has about 80.\n` +
          '  Since 13 August this should be IMPOSSIBLE: src/testing/freshDatabase.ts rebuilds\n' +
          '  the schema before every test file. Seeing this means that clean has stopped\n' +
          '  working, and the order-dependent failures it ended are on their way back.\n\n' +
          '  Check setupFiles in vitest.config.ts, then:\n\n' +
          '      npm run test:reset\n\n',
      );
    }
  } catch {
    // No cluster, no schema, no permission — every one of those is the suites' own problem to
    // report, in their own words. A hygiene check must never be the thing that fails a run.
  } finally {
    await client.end().catch(() => undefined);
  }
}
