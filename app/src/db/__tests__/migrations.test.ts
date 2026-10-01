/**
 * Every migration has to record itself.
 *
 * `migrate()` is deliberately minimal — no checksums, no framework, forward only (ADR-0007) —
 * and the whole of its bookkeeping is the `schema_migration` row that each file inserts at the
 * end of itself. Nothing checks that the row is there, so a file that forgets it is simply
 * re-applied on every boot, silently, for ever.
 *
 * That is not hypothetical. `0019_search_by_occurrence` shipped without the line and ran on
 * every start from the day it landed. It was harmless because `CREATE INDEX IF NOT EXISTS` is
 * idempotent and because the district had not yet been given a machine that boots twice — every
 * test in this repository starts from a fresh cluster, so not one of them could have seen it.
 * It was found by an installer running its first-run step a second time.
 *
 * The lesson is the one this project keeps paying for and keeps writing down: **the comment
 * saying "remember to do X" is not what makes X happen.** Same shape as the service worker's
 * `CACHE` string, which was read, was right, and was forgotten across four commits until a test
 * made it impossible. This is that test, for the other one.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'db',
  'migrations',
);

const files = readdirSync(migrations)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('the migrations', () => {
  it('has some', () => {
    // A glob that matches nothing passes every assertion below it. Ask first.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s records itself in schema_migration', (file) => {
    const version = file.replace(/\.sql$/, '');
    const sql = readFileSync(join(migrations, file), 'utf8');

    /**
     * Matched on the version string inside an INSERT rather than on the statement's shape,
     * because the failure this catches is a file that inserts the *wrong* version — copied
     * from the migration beside it, which is exactly how the line gets written at all. That
     * one is worse than a missing row: it marks its neighbour as applied and skips it.
     */
    const records = new RegExp(
      String.raw`INSERT\s+INTO\s+schema_migration[\s\S]*?'${version}'`,
      'i',
    ).test(sql);

    expect(
      records,
      `${file} never inserts its own version into schema_migration, so migrate() will ` +
        're-apply it on every start of the server for ever.',
    ).toBe(true);
  });

  it('numbers each migration once, with no gaps', () => {
    /**
     * Two files numbered 0012 is a race decided by whichever string sorts first, and a gap is
     * usually a migration that was written, reviewed and never committed. Both are cheap to
     * check here and expensive to notice on a district's machine at 02:00.
     */
    const numbers = files.map((f) => Number(f.slice(0, 4)));

    expect(new Set(numbers).size, `duplicate migration numbers in ${files.join(', ')}`).toBe(
      numbers.length,
    );

    for (let i = 0; i < numbers.length; i++) {
      expect(numbers[i], `expected migration ${String(i + 1).padStart(4, '0')}`).toBe(i + 1);
    }
  });
});
