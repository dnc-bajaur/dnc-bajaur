/**
 * Ask, before the restart, the questions migration 0039 must never ask at boot.
 *
 *   npm run preflight:0039
 *
 * ------------------------------------------------------------------------------------------
 * Why this exists at all
 * ------------------------------------------------------------------------------------------
 *
 * 0039 drops the department table. Two things about that are worth refusing over, and neither
 * may be checked from inside the migration:
 *
 *   1. **Authority.** After the drop, seat.is_administration is the ONLY thing that decides who
 *      may issue an advisory, edit the directory or configure anything. Today it can also be
 *      satisfied by the department a seat is filed under (0038's transition clause, read by both
 *      the identity query and the tier trigger). If nobody carries the tick ON THE SEAT, the
 *      drop takes every administrative power in the district away, at once, and NOTHING FAILS AT
 *      THE MOMENT IT HAPPENS — the next person to try something is simply refused.
 *
 *   2. **The record.** Past incidents name their departments. ADR-0030 was accepted on the basis
 *      that the district asked for the record to go and it went; on an installation where it did
 *      not, dropping the table leaves those events unreadable.
 *
 * ⚠️ **AND THE REASON IT IS A SCRIPT RATHER THAN A `RAISE` IN THE MIGRATION** is written into
 * 0039's own header and is this project's most expensive operational lesson: migrations run at
 * BOOT, so a migration that refuses does not warn anybody, it serves 502 until a human looks.
 * Migration 0031 did exactly that for 34 minutes across ~98 restarts (O-40).
 *
 * This changes NOTHING. It reads, it prints, and it exits 1 if the answer is stop.
 */

import process from 'node:process';

const say = (m) => console.log(m);
const url = process.env['DATABASE_URL'];
if (url === undefined) {
  console.error('DATABASE_URL is not set. Nothing to check.');
  process.exit(1);
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: url });

let stop = false;

try {
  /**
   * ⚠️ **CHECK THE SCHEMA IS WHERE THIS SCRIPT THINKS IT IS, FIRST.**
   *
   * Run against a database that has not had 0038 applied, the query below fails on
   * `column s.is_administration does not exist` — and a preflight that answers an operator with
   * a Postgres error and a Node stack trace has told them nothing they can act on. Found by
   * running this against the development database, which is exactly the mistake somebody makes
   * at 02:00 with the wrong DATABASE_URL in their shell.
   */
  const ready = await pool.query(
    `SELECT to_regclass('department') IS NOT NULL AS has_department,
            EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'seat' AND column_name = 'is_administration') AS has_tick`,
  );
  const { has_department: hasDepartment, has_tick: hasTick } = ready.rows[0];

  if (!hasDepartment) {
    say('');
    say('  ✓ Nothing to do — this database has no department table.');
    say('    Migration 0039 has already been applied here.');
    say('');
    process.exit(0);
  }
  if (!hasTick) {
    say('');
    say('  🔴 THIS DATABASE HAS NOT HAD MIGRATION 0038 APPLIED.');
    say('');
    say('    seat.is_administration does not exist, so the question this script asks —');
    say('    who will still hold authority afterwards — cannot be answered here.');
    say('');
    say('    Check DATABASE_URL points at the installation you mean to deploy to.');
    say('');
    process.exit(1);
  }

  say('');
  say('── Who will still hold administrative authority ──');
  say('');

  const ticked = await pool.query(
    `SELECT s.title, p.full_name
       FROM seat s
       LEFT JOIN duty_assignment d ON d.seat_id = s.seat_id AND d.to_at IS NULL
       LEFT JOIN person p ON p.person_id = d.person_id
      WHERE s.retired_at IS NULL AND s.is_administration
      ORDER BY s.title`,
  );

  // Named rather than counted, for preflight-0038's own reason: a count of two is a number and
  // a list of two is a decision somebody can disagree with.
  for (const r of ticked.rows) {
    say(`  ✓ ${r.title}${r.full_name === null ? '  (nobody holds this post)' : ' — ' + r.full_name}`);
  }
  if (ticked.rowCount === 0) say('  (none)');
  say('');
  say(`  ${ticked.rowCount} post(s) carry the tick ON THE SEAT.`);
  say('');

  if (ticked.rowCount === 0) {
    stop = true;
    say('  🔴 NOBODY. DO NOT RESTART.');
    say('');
    say('  Today authority can also come from the department a seat is filed under —');
    say('  migration 0038 reads both while both exist. Dropping the department table');
    say('  removes that half, and with no seat carrying the tick the district is left');
    say('  with NO administrative authority at all: no advisory, no directory edit, no');
    say('  configuration, by anybody.');
    say('');
    say('  Nothing fails at the moment it happens. The next person to try something is');
    say('  simply refused, and the reason is a table that no longer exists.');
    say('');
    say('  Fix: tick the two offices on their SEATS first, then run this again.');
    say('');
  }

  // ── The record ────────────────────────────────────────────────────────────────────────────
  const rec = await pool.query('SELECT count(*)::int AS n FROM incident_event');
  const events = rec.rows[0].n;

  say('── What the drop would make unreadable ──');
  say('');
  say(`  Incident events in the record:      ${events}`);

  const dept = await pool.query('SELECT count(*)::int AS n FROM department');
  const filed = await pool.query(
    'SELECT count(*)::int AS n FROM seat WHERE department_id IS NOT NULL AND retired_at IS NULL',
  );
  say(`  Departments in the registry:        ${dept.rows[0].n}`);
  say(`  Live seats still filed under one:   ${filed.rows[0].n}`);
  say('');

  if (events > 0) {
    stop = true;
    say('  🔴 THE RECORD IS NOT EMPTY. DO NOT RESTART.');
    say('');
    say('  Those events name departments — which held an emergency, who was told. Drop');
    say('  the table under them and the only thing that could name them back is gone, so');
    say('  the district keeps its history and stops being able to read it.');
    say('');
    say('  ADR-0030 was accepted on the basis of an emptied record. This installation');
    say('  does not have one, so the decision it rests on has not happened here.');
    say('');
  }

  // ── The one the migration itself creates ─────────────────────────────────────────────────
  //
  // `resource` carried its uniqueness as (department_id, lower(name)). With the column gone the
  // name has to carry it alone, so two departments that each ran an "Ambulance 1" become a
  // duplicate and CREATE UNIQUE INDEX fails — at boot, which is the whole thing this script
  // exists to keep out of the migration.
  const clash = await pool.query(
    `SELECT lower(name) AS name, count(*)::int AS n
       FROM resource
      WHERE retired_at IS NULL
      GROUP BY lower(name)
     HAVING count(*) > 1
      ORDER BY count(*) DESC, lower(name)`,
  );

  say('── What the district still has, by name ──');
  say('');
  if (clash.rowCount === 0) {
    say('  ✓ no two live vehicles, teams or equipment share a name.');
    say('');
  } else {
    stop = true;
    say('  🔴 NAMES SHARED BY MORE THAN ONE LIVE RESOURCE. DO NOT RESTART.');
    say('');
    for (const r of clash.rows) say(`    · ${r.name} — ${r.n} of them`);
    say('');
    say('  A resource was unique per (department, name). With departments gone the name has');
    say('  to be unique on its own, and the migration creates that index — which fails on');
    say('  these, at boot.');
    say('');
    say('  Fix: rename or retire the duplicates first, then run this again.');
    say('');
  }

  say(stop ? '── STOP. Read the red above. ──' : '── Safe to deploy. ──');
  say('');
} finally {
  await pool.end();
}

process.exit(stop ? 1 : 0);
