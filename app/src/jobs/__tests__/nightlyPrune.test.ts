/**
 * Housekeeping that hourly backups made necessary — 2026-08-14.
 *
 * At one dump a night nothing pruned them and nothing needed to. At twenty-four a day a
 * directory nobody empties fills a disk, and **a full disk does not merely stop the backup, it
 * stops PostgreSQL** — this project has already lost a development cluster exactly that way
 * (`No space left on device`, mid-recovery).
 *
 * So the deletion is real, and the second test here is the one that matters: **a cleanup that
 * removes something it did not create is how a backup directory becomes the thing that lost the
 * data.**
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneLocalDumps } from '../nightly.js';

describe('pruning the local dump directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dnc-prune-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Named exactly as `runBackup` names them, so the sort is the real one. */
  async function dump(iso: string): Promise<void> {
    await writeFile(join(dir, `dnc-${iso}.sql`), 'x');
  }

  it('keeps the newest 48 and removes what is older', async () => {
    for (let i = 0; i < 60; i++) {
      // Zero-padded, because these sort lexically and that IS the ordering the job relies on.
      await dump(
        `2026-08-14T${String(i % 24).padStart(2, '0')}-00-00-${String(i).padStart(3, '0')}Z`,
      );
    }

    await pruneLocalDumps(dir);

    const left = (await readdir(dir)).filter((n) => n.endsWith('.sql'));
    expect(left).toHaveLength(48);
  });

  it('never touches a file it did not write', async () => {
    /**
     * The safety property, and the reason this test exists at all.
     *
     * Somebody restoring at 02:00 puts `restored.sql` in this directory — the runbook's own
     * command produces exactly that name. A prune that deleted anything old would take it, and
     * take it at the single worst moment.
     */
    await writeFile(join(dir, 'restored.sql'), 'the district being brought back');
    await writeFile(join(dir, 'notes.txt'), 'do not delete');
    for (let i = 0; i < 60; i++) {
      await dump(`2026-08-14T00-00-00-${String(i).padStart(3, '0')}Z`);
    }

    await pruneLocalDumps(dir);

    const left = await readdir(dir);
    expect(left).toContain('restored.sql');
    expect(left).toContain('notes.txt');
  });

  it('says nothing and throws nothing when the directory is not there', async () => {
    // Housekeeping must never be the reason a backup does not happen.
    await expect(pruneLocalDumps(join(dir, 'no-such-place'))).resolves.toBeUndefined();
  });
});
