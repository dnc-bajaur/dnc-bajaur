import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

/**
 * Timestamps come back as ISO strings, not JS Date objects.
 *
 * The domain works in ISO-8601 strings throughout, and a Date silently applies the
 * server's local timezone on formatting. In a system where the whole point is an honest
 * record of when things happened, that is not a conversion worth risking.
 */
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v: string) => new Date(`${v}Z`).toISOString());

export type Pool = pg.Pool;

export function createPool(connectionString?: string): Pool {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is not set. Copy app/.env.example to app/.env.');
  }
  return new pg.Pool({ connectionString: url, max: 10 });
}

/**
 * Apply pending migrations in filename order.
 *
 * Deliberately minimal: no rollback, no checksums, no framework. Migrations are forward
 * only, and a mistake is corrected by writing 0002 — the same discipline the event log
 * itself follows. Revisit if this stops being adequate; do not pre-emptively adopt a
 * migration framework nobody in the district can debug (ADR-0007).
 */
export async function migrate(pool: Pool, dir: string): Promise<readonly string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migration')).rows.map(
      (r) => r.version,
    ),
  );

  const pending = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f.replace(/\.sql$/, '')));

  for (const file of pending) {
    await pool.query(readFileSync(join(dir, file), 'utf8'));
  }

  return pending;
}
