/**
 * Print the district configuration sweep.
 *
 *     npm run sweep
 *
 * Reads only. Nothing here changes a single row — every finding is either a decision for the
 * district or a fact somebody has to look at, and a sweep that quietly corrected things would
 * destroy the evidence that anything was wrong.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.loadEnvFile('.env');

const url = process.env['DATABASE_URL'];
if (url === undefined) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const { createPool, migrate } = await import('../dist/db/pool.js');
const { sweep, formatReport } = await import('../dist/ops/integrity.js');

const pool = createPool(url);
const here = dirname(fileURLToPath(import.meta.url));
await migrate(pool, join(here, '..', 'db', 'migrations'));

console.log(formatReport(await sweep(pool)));

await pool.end();
