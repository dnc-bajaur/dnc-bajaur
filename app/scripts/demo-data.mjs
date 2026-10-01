/**
 * Fill the dashboard with plausible demo data — M4.
 *
 * Why this exists. The owner asked to see the prototype's dashboard working, and a dashboard
 * that is honest about having no data is a dashboard where eleven panels read "not reported".
 * That is correct and it is useless for judging a design. So: one command puts a district's
 * worth of plausible activity behind the screen, and one command takes it away again.
 *
 *     node scripts/demo-data.mjs         # fill
 *     node scripts/demo-data.mjs --clear # remove every trace of it
 *
 * **Everything it writes is marked.** Utility notes end with a marker, alerts carry it, and
 * presence notes carry it. That is what `--clear` finds, and it is also what stops this
 * quietly becoming the district's real data six months from now. The marker is deliberately
 * visible in the interface rather than hidden in a column: a green tick nobody earned is the
 * most expensive kind of lie a control room can tell, and one that says "(demo)" beside it is
 * not a lie at all.
 *
 * It refuses to run against a database that looks like production, for the same two-check
 * reason `reset-test-db.mjs` does.
 */

import process from 'node:process';

process.loadEnvFile('.env');

const url = process.env['DATABASE_URL'];

if (url === undefined) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

if (/prod|production/i.test(url)) {
  console.error(`Refusing to write demo data into ${url}`);
  process.exit(1);
}

/** The marker. Short, readable on a screen, and unique enough to search for. */
const MARK = '(demo)';

const { createPool } = await import('../dist/db/pool.js');
const pool = createPool(url);

const clearing = process.argv.includes('--clear');

if (clearing) {
  const alerts = await pool.query('DELETE FROM district_alert WHERE message LIKE $1', [`%${MARK}`]);
  const utils = await pool.query('DELETE FROM utility_report WHERE note LIKE $1', [`%${MARK}`]);
  const presence = await pool.query('DELETE FROM presence_report WHERE note LIKE $1', [`%${MARK}`]);
  const facts = await pool.query('UPDATE district_fact SET value = NULL WHERE value LIKE $1', [
    `%${MARK}`,
  ]);

  console.log(
    `cleared — ${String(alerts.rowCount)} advisories, ${String(utils.rowCount)} utility reports, ` +
      `${String(presence.rowCount)} presence reports, ${String(facts.rowCount)} facts`,
  );
  console.log('Emergencies are NOT removed: the event log is append-only by design (ADR-0001).');
  await pool.end();
  process.exit(0);
}

/**
 * Clear anything a previous run left, before writing.
 *
 * Found by running it twice: four advisories became eight, and the board read "8 in force"
 * for a district that had issued four. Seeding that is not idempotent is a seeding script
 * that lies the second time somebody uses it — and the second time is exactly when they are
 * showing it to somebody.
 */
await pool.query('DELETE FROM district_alert WHERE message LIKE $1', [`%${MARK}`]);
await pool.query('DELETE FROM utility_report WHERE note LIKE $1', [`%${MARK}`]);
await pool.query('DELETE FROM presence_report WHERE note LIKE $1', [`%${MARK}`]);

/** A seat to attribute the reports to, so they render with an author like a real one would. */
const seat = await pool.query(
  `SELECT s.seat_id FROM seat s
     JOIN department d ON d.department_id = s.department_id
    WHERE d.is_administration AND s.retired_at IS NULL
    LIMIT 1`,
);
const seatId = seat.rows[0]?.seat_id ?? null;

//------------------------------------------------------------------------------
// The condition board
//------------------------------------------------------------------------------
//
// Deliberately mixed. Two things down, two degraded, one never reported — because a board
// where everything is green teaches nobody anything about how the design reads under strain,
// and a board where everything is red is not a district anybody recognises.

const conditions = [
  ['Electricity (PESCO)', 'degraded', `Load shedding, 4 hrs on 2 off ${MARK}`, 40],
  ['Water supply', 'normal', `Supply normal ${MARK}`, 90],
  ['Sui Gas', 'degraded', `Low pressure, bazaar side ${MARK}`, 200],
  ['Internet', 'down', `Fibre cut near Khar Road ${MARK}`, 25],
  ['PTCL / Landline', 'normal', `Working ${MARK}`, 300],
  ['Markets', 'normal', `All open ${MARK}`, 120],
  ['Schools', 'normal', `Open ${MARK}`, 150],
  ['DHQ Hospital', 'normal', `Normal intake ${MARK}`, 60],
  ['Roads', 'degraded', `2 closures — Khar Rd, Mamund bypass ${MARK}`, 75],
];

let written = 0;
for (const [name, status, note, minutesAgo] of conditions) {
  const found = await pool.query('SELECT utility_id FROM utility WHERE name = $1', [name]);
  const id = found.rows[0]?.utility_id;
  if (id === undefined) continue;

  await pool.query(
    `INSERT INTO utility_report (utility_id, status, note, reported_by, reported_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))`,
    [id, status, note, seatId, minutesAgo],
  );
  written += 1;
}

//------------------------------------------------------------------------------
// Where the officers are
//------------------------------------------------------------------------------

const presence = [
  ['Deputy Commissioner', 'office', null, 30, null],
  ['AC HQ Bajaur', 'field', `Nawagai side ${MARK}`, 55, 3],
  ['AAC Nawagai', 'office', `At desk ${MARK}`, 20, null],
  ['AAC Mamund', 'field', `Flood survey ${MARK}`, 95, 2],
  ['AAC Salarzai', 'leave', `Back Thursday ${MARK}`, 600, 72],
  ['AAC Barang', 'office', `At desk ${MARK}`, 45, null],
];

let placed = 0;
for (const [title, status, note, minutesAgo, hoursUntil] of presence) {
  const found = await pool.query(
    'SELECT seat_id FROM seat WHERE title = $1 AND retired_at IS NULL LIMIT 1',
    [title],
  );
  const id = found.rows[0]?.seat_id;
  if (id === undefined) continue;

  await pool.query(
    `INSERT INTO presence_report (seat_id, status, note, reported_by, reported_at, until_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5),
             CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(hours => $6::int) END)`,
    [id, status, note, seatId, minutesAgo, hoursUntil],
  );
  placed += 1;
}

//------------------------------------------------------------------------------
// Advisories
//------------------------------------------------------------------------------

const alerts = [
  ['vip', `VIP movement — main bazaar route, 14:00–16:00 ${MARK}`, 6],
  ['security', `Security advisory in force for Mamund tehsil ${MARK}`, 48],
  ['road', `Khar Road closed for maintenance, bazaar to bypass ${MARK}`, 30],
  ['weather', `Dust storm expected this evening, secure loose structures ${MARK}`, 12],
];

for (const [tag, message, hours] of alerts) {
  await pool.query(
    `INSERT INTO district_alert (tag, message, issued_by, until_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [tag, message, seatId, hours],
  );
}

//------------------------------------------------------------------------------
// The standing facts
//------------------------------------------------------------------------------
//
// **These are the district's to correct.** They are marked like everything else here, and the
// numbers are placeholders rather than findings — I have not verified Bajaur's population or
// area and will not invent them as fact (R-15).

const facts = [
  ['tehsils', `4 ${MARK}`],
  ['union_councils', `27 ${MARK}`],
  ['population', `— confirm ${MARK}`],
  ['area', `— confirm ${MARK}`],
];

for (const [key, value] of facts) {
  await pool.query('UPDATE district_fact SET value = $2, updated_by = $3 WHERE key = $1', [
    key,
    value,
    seatId,
  ]);
}

//------------------------------------------------------------------------------
// The published emergency numbers
//------------------------------------------------------------------------------
//
// 1122, 15 and 16 are **not demo data**. They are Pakistan's national emergency numbers,
// printed on posters and answered by a control room — which is exactly why they are safe on a
// screen a room can read, and why they carry no marker: they are not something to clear later.
//
// Set only where the district has not already put something, so this never overwrites a real
// number somebody typed.

const numbers = [
  ['Rescue 1122', '1122'],
  ['District Police Officer', '15'],
  ['Fire', '16'],
];

let numbered = 0;
for (const [match, number] of numbers) {
  const updated = await pool.query(
    `UPDATE department
        SET contact_phone = $2
      WHERE name ILIKE $1
        AND retired_at IS NULL
        AND (contact_phone IS NULL OR contact_phone = '')`,
    [`%${match}%`, number],
  );
  numbered += updated.rowCount ?? 0;
}

console.log(
  `demo data written — ${String(written)} condition reports, ${String(placed)} presence reports, ` +
    `${String(numbered)} published numbers, ` +
    `${String(alerts.length)} advisories, ${String(facts.length)} facts`,
);
console.log(`Everything is marked "${MARK}". Remove it with:  node scripts/demo-data.mjs --clear`);

await pool.end();
