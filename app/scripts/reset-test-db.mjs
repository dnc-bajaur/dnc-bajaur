/**
 * Empty the **test** database and re-apply every migration.
 *
 * Why this exists: the local test database is never cleaned, so every run leaves its seats,
 * departments and events behind. After a few weeks of that it held **1528 departments** —
 * where Bajaur has 79 — and the administration console's browser test began timing out
 * rendering a screen no real district will ever produce.
 *
 * That is worth more than an annoyance. A test database that drifts this far stops telling
 * the truth in both directions: it hides real slowness behind noise, and it invents slowness
 * that does not exist. It also pushed several suites into inventing per-run name suffixes to
 * avoid colliding with their own history.
 *
 * CI never hits this — the workflow starts a fresh PostgreSQL service container every run —
 * so this is a local hygiene tool, run when the local database has drifted, not part of the
 * normal test command.
 *
 *     node scripts/reset-test-db.mjs
 *
 * **It refuses to run against anything but a database named for testing.** `incident_event`
 * blocks TRUNCATE by trigger (ADR-0001), which is correct and non-negotiable, so the only way
 * to empty it is to drop the schema — and dropping the wrong schema is the one mistake here
 * with no undo.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.loadEnvFile('.env');

const url = process.env['TEST_DATABASE_URL'];

if (url === undefined) {
  console.error('TEST_DATABASE_URL is not set. Nothing to reset.');
  process.exit(1);
}

// Two independent checks, both of which must pass. A single substring test is one typo away
// from dropping the district's data, and this script exists to be run in a hurry.
const named = /(^|[/_-])(dnc_test|test)($|[?_-])/.test(url);
const notProduction = !/dnc_dev|prod|production/.test(url);

if (!named || !notProduction) {
  console.error(
    `Refusing to reset ${url}\n\n` +
      'This drops and recreates the whole schema. It will only run against a database whose\n' +
      'name marks it as a test database, and never against one that looks like dev or\n' +
      'production. If this is genuinely your test database, rename it.',
  );
  process.exit(1);
}

const { createPool, migrate } = await import('../dist/db/pool.js');

const pool = createPool(url);

console.log(`resetting ${url}`);
await pool.query('DROP SCHEMA public CASCADE');
await pool.query('CREATE SCHEMA public');

const here = dirname(fileURLToPath(import.meta.url));
const applied = await migrate(pool, join(here, '..', 'db', 'migrations'));
console.log(`applied ${String(applied.length)} migrations`);

const counts = await pool.query(
  `SELECT (SELECT count(*) FROM seat)           AS seats,
          (SELECT count(*) FROM incident_event) AS events`,
);
console.log('now:', counts.rows[0]);

await pool.end();
