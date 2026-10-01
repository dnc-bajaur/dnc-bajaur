import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll } from 'vitest';

import { emptyTestDatabase } from './freshDatabase.js';

/**
 * Load app/.env if present. Node 22+ can do this without a dependency, so we do.
 *
 * Absent .env is not an error — the domain tests need no database at all, and that is
 * deliberate (ADR-0002, ADR-0007). Only the db suite requires TEST_DATABASE_URL, and it
 * says so loudly rather than passing vacuously.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * Tests are quiet by default (M0-03).
 *
 * Request logging is on in every suite that starts a server, and at `info` it buries the
 * test output that someone is actually reading. Errors still come through. Set
 * `VITEST_LOG_LEVEL=info` — or `debug` — when the logs are the thing you are debugging.
 */
process.env['LOG_LEVEL'] = process.env['VITEST_LOG_LEVEL'] ?? 'error';

/**
 * On a build server, a missing database is a failure — never a quiet skip.
 *
 * Locally, `describe.skipIf(dbUrl === undefined)` is a kindness: you can run the domain
 * tests on a laptop with no cluster started. In CI that same kindness is a trap. A
 * misconfigured secret would drop every integration suite, and the run would go **green
 * with roughly fifty tests instead of three hundred** — a build that reports success while
 * proving almost nothing, which is the exact failure mode this project keeps finding and
 * refusing (see the notes on faked databases in CLAUDE.md).
 *
 * So: if `CI` is set, the database is mandatory and its absence stops the run here.
 */
if (process.env['CI'] !== undefined && process.env['TEST_DATABASE_URL'] === undefined) {
  throw new Error(
    'TEST_DATABASE_URL is not set and CI is. Refusing to run: the integration suites would ' +
      'skip and the build would pass having tested almost nothing. Set TEST_DATABASE_URL, ' +
      'or unset CI if you genuinely want the domain-only run.',
  );
}

/**
 * **Every test file starts with an empty district** — M9-57's real fix.
 *
 * `globalSetup.ts` has warned about the un-cleaned test database since it was written, and the
 * warning did not stop it costing an evening twice, or producing three order-dependent failures
 * that took a milestone to chase down one at a time. See `freshDatabase.ts` for what the residue
 * actually did.
 *
 * A `beforeAll` here runs **once per test file**, before that file's own hooks — so a suite that
 * seeds in `beforeAll` still finds the district exactly as it left it, and finds nothing anybody
 * else left. Files run serially (`fileParallelism: false`), so there is nothing to race with.
 *
 * Skipped entirely when there is no `TEST_DATABASE_URL`: the domain tests need no database and
 * that is deliberate (ADR-0007).
 */
const testDatabaseUrl = process.env['TEST_DATABASE_URL'];

if (testDatabaseUrl !== undefined) {
  beforeAll(async () => {
    await emptyTestDatabase(testDatabaseUrl);
  }, 30_000);
}
