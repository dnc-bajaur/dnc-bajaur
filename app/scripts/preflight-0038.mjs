/**
 * `node scripts/preflight-0038.mjs` — ask the database ADR-0029's questions **before** the restart.
 *
 * ## Why this is a script and not a guard inside the migration
 *
 * O-40, and it is the most expensive lesson this project has learned:
 *
 * > Migration `0031` refused to run because the district's data contradicted it. The refusal was
 * > correct. But migrations run **when the service boots**, so refusing meant the service could
 * > not start — systemd retried every five seconds and Bajaur served 502 from 19:08:52 to 19:42:54
 * > UTC, about 98 restarts, on an ordinary evening.
 *
 * *A check that can only speak by killing the service is not a check, it is an outage with a good
 * explanation.* So `0038` contains no `RAISE EXCEPTION` at all, and everything worth refusing over
 * is asked here instead — against the live database, **before** anything is deployed, changing
 * nothing either way.
 *
 * ## What it asks
 *
 * **1. Will anybody be the administration afterwards?** This is the only question that can produce
 * an outage. `identity.isAdministration` moves from the `department` table onto `seat`, and every
 * write authority in the system rests on that one boolean — issuing an advisory, editing the
 * directory, maintaining groups. If the backfill would tick nobody, then after the deploy nobody
 * can act, and the first person to find out is the control room at 02:00.
 *
 * **2. How many contacts are being retired, and are any of them wrong?** The district asked for
 * vacant posts to be dropped. `vacant` is **not** `no_number`: an officer whose number was never
 * recorded is not a vacancy, and four of Bajaur's rows are exactly that — including Rescue 1122's
 * District Emergency Officer. This prints both counts separately so that a number nobody expected
 * is seen before it is acted on rather than after.
 *
 * ## What it does not do
 *
 * **It changes nothing.** No writes, no migration, no `.env`. It reads and reports, and its exit
 * code is advisory: non-zero means *stop and read*, never *the database is broken*.
 */

import process from 'node:process';

const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set. Nothing to check.');
  process.exit(2);
}

const { createPool } = await import('../dist/db/pool.js');
const pool = createPool(url);

let stop = false;

try {
  // ── 1. Who will be the administration? ────────────────────────────────────────────────────
  //
  // Deliberately computed the OLD way — through the join to `department` — because that is what
  // the migration's backfill will do, and asking the same question by the same route is the whole
  // point of a preflight. Asking it a cleverer way would test a different thing.
  const admin = await pool.query(
    `SELECT s.seat_id, s.title, p.full_name
       FROM seat s
       JOIN department d ON d.department_id = s.department_id
       LEFT JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
       LEFT JOIN person p ON p.person_id = a.person_id
      WHERE d.is_administration
        AND s.retired_at IS NULL
      ORDER BY s.title`,
  );

  console.log('\n── Who carries the administration tick after this migration ──\n');
  if (admin.rows.length === 0) {
    stop = true;
    console.log('  🔴 NOBODY.\n');
    console.log('  After this deploy no account can issue an advisory, edit the directory or');
    console.log('  maintain a group, because every one of those rests on this flag.');
    console.log('  DO NOT DEPLOY. Tick `department.is_administration` on the DC Office and the');
    console.log('  AC Headquarter first, then run this again.\n');
  } else {
    for (const r of admin.rows) {
      console.log(`  ✓ ${r.title} — ${r.full_name ?? '(vacant)'}`);
    }
    console.log(`\n  ${admin.rows.length} contact(s). Expected: three or four.\n`);
  }

  // ── 2. What is being retired, and is any of it a person? ──────────────────────────────────
  const counts = await pool.query(
    `SELECT
       count(*) FILTER (WHERE holder IS NULL)                    AS vacant,
       -- ⚠️ "phone IS NULL" ALONE WAS WRONG, AND IT MADE THIS GUARD UNPASSABLE.
       --
       -- It was written from the seed file, where these four rows simply have no phone key. The
       -- LOADER does not store them that way: a post somebody holds with no number on file is
       -- loaded ON A STAND-IN (see ops/directory.ts, "A post with somebody in it and no
       -- number"), so the person arrives with placeholder = true and a number that is real
       -- enough to store and must never be dialled.
       --
       -- So on a correctly loaded district this counter read **zero** — and zero is exactly what
       -- this script prints its red line about. It told the operator to re-run the load, the
       -- load was already right, and running it again could not change the answer. A guard that
       -- cannot go green is worse than no guard: the next person past it learns to step over it.
       count(*) FILTER (WHERE holder IS NOT NULL AND (phone IS NULL OR placeholder))
         AS named_no_number,
       count(*) FILTER (WHERE holder IS NOT NULL)                AS held
     FROM (
       SELECT p.person_id AS holder, p.phone AS phone, p.placeholder AS placeholder
         FROM seat s
         LEFT JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
         LEFT JOIN person p ON p.person_id = a.person_id
        WHERE s.retired_at IS NULL
     ) x`,
  );
  const c = counts.rows[0];

  console.log('── What the vacancy sweep will touch ──\n');
  console.log(`  Retired (no holder):                 ${c.vacant}`);
  console.log(`  Kept, held by somebody:              ${c.held}`);
  console.log(`  ...of those, with no number on file: ${c.named_no_number}  ← these are R-01, and they STAY\n`);

  // The four are named rather than counted, because a count of four is a number and a list of
  // four is a decision somebody can disagree with.
  const noNumber = await pool.query(
    `SELECT s.title, p.full_name
       FROM seat s
       JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
       JOIN person p ON p.person_id = a.person_id
      WHERE s.retired_at IS NULL AND (p.phone IS NULL OR p.placeholder)
      ORDER BY s.title`,
  );
  if (noNumber.rows.length > 0) {
    console.log('  Held, but no number recorded — kept in the list, marked unreachable:\n');
    for (const r of noNumber.rows) console.log(`    · ${r.title} — ${r.full_name}`);
    console.log('');
  } else {
    /**
     * 🔴 **ZERO HERE IS THE ONE ANSWER THAT LOOKS FINE AND IS NOT — CD-08.**
     *
     * `ops/directory.ts` used to test `isBlank(row.name) || isBlank(row.phone)`, so a post held
     * by a **named officer whose number was never recorded** loaded as a **vacancy**: no person,
     * no duty assignment, the name discarded. Bajaur's own list has four of those, and the first
     * is **Rescue 1122's District Emergency Officer**.
     *
     * The sweep below retires every seat nobody holds. Against a directory loaded by the old
     * code those four are indistinguishable from genuine vacancies, so they would be retired —
     * exactly what ADR-0029 §3 was written to prevent, one layer below where that argument was
     * made. **The database cannot tell the two apart; only the seed file still has the names.**
     *
     * So this stops rather than reports. The repair is to re-run the directory load with the
     * fixed loader BEFORE applying 0038, which restores the holders from the source list.
     */
    stop = true;
    console.log('  🔴 NONE — AND THAT IS THE ANSWER TO CHECK, NOT THE ONE TO ACCEPT.\n');
    console.log('  A directory loaded before CD-08 recorded a named officer with no number as a');
    console.log('  VACANCY, discarding the name. Bajaur has four of those, including Rescue');
    console.log('  1122’s District Emergency Officer — and the sweep below would retire all four.');
    console.log('  Only the seed file still holds those names; the database cannot tell them from');
    console.log('  a real vacancy.\n');
    console.log('  Re-run the directory load with the current code, then run this again. If this');
    console.log('  district genuinely has nobody in that state, that is what to confirm before');
    console.log('  going any further.\n');
  }

  console.log(stop ? '── STOP. Read the red line above. ──\n' : '── Safe to deploy. ──\n');
} finally {
  await pool.end?.();
}

process.exit(stop ? 1 : 0);
