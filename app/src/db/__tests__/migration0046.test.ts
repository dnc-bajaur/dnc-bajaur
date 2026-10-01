/**
 * Migration 0046 folds the five presence values into two ON A TABLE THAT ALREADY HOLDS ROWS.
 *
 * The first version of 0046 ran `UPDATE presence_report SET status = 'available' ...` and only
 * then dropped the old `presence_report_status_known` CHECK (five location values). On a fresh
 * schema — which is what every DB-backed suite gets from `freshDatabase.ts` — `presence_report`
 * is empty, the UPDATE touches zero rows, and the ordering never bites. On Bajaur's live table it
 * boot-looped: `new row for relation "presence_report" violates check constraint
 * "presence_report_status_known"` (2026-09-02). This test reproduces that by recreating the
 * pre-0046 state with a real old-value row, then re-running `migrate()`.
 */

import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate } from '../pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');
const url = process.env['TEST_DATABASE_URL'];

describe('migration 0046 (officer availability)', () => {
  it('folds an existing old-value presence row without tripping the old CHECK', async () => {
    if (url === undefined) throw new Error('TEST_DATABASE_URL is not set');
    const pool = createPool(url);
    try {
      // The suite setup has already applied every migration, 0046 included. Wind `presence_report`
      // back to how it looked the moment before 0046 ran on the live box: the old five-value CHECK
      // in force, a real row carrying one of the old values, and 0046 un-recorded so `migrate()`
      // re-applies it.
      await pool.query(
        `ALTER TABLE presence_report DROP CONSTRAINT IF EXISTS presence_report_status_known_v2`,
      );
      await pool.query(
        `ALTER TABLE presence_report ADD CONSTRAINT presence_report_status_known
           CHECK (status IN ('present', 'absent', 'office', 'field', 'leave'))`,
      );

      const seat = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass, is_administration)
           VALUES ('Migration 0046 test seat', 'district', false, false)
         RETURNING seat_id`,
      );
      const seatId = seat.rows[0]!.seat_id;
      await pool.query(`INSERT INTO presence_report (seat_id, status) VALUES ($1, 'field')`, [
        seatId,
      ]);

      await pool.query(`DELETE FROM schema_migration WHERE version = '0046_officer_availability'`);

      // Re-apply exactly what the box runs at boot. `migrate()` returns the list of files it
      // applied; the boot-loop was a REJECTION, so resolving-with-0046-in-the-list is the pass.
      await expect(migrate(pool, migrationsDir)).resolves.toContain(
        '0046_officer_availability.sql',
      );

      const folded = await pool.query<{ status: string }>(
        `SELECT status FROM presence_report WHERE seat_id = $1`,
        [seatId],
      );
      expect(folded.rows[0]!.status).toBe('available');

      const constraints = await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'presence_report'::regclass AND contype = 'c'`,
      );
      const names = constraints.rows.map((r) => r.conname);
      expect(names).toContain('presence_report_status_known_v2');
      expect(names).not.toContain('presence_report_status_known');

      const onWall = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'seat' AND column_name = 'on_wall'`,
      );
      expect(onWall.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
