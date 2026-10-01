/**
 * `npm run dev:account` — a sign-in for the local development database.
 *
 * ## Why this exists separately from everything else
 *
 * The installer's `first-run.mjs` creates the district's first account, and it is careful about
 * it: it takes a phone number the district gives it, matches it against the loaded directory,
 * and tells the operator if that number belongs to a department rather than one of the two
 * administrative offices. None of that care makes sense on a laptop, and running the installer
 * to look at a screen is not a thing anybody should have to do.
 *
 * So this is the development-only shortcut, and it says so in three ways.
 *
 * **It refuses anything that looks like production**, the same two-check way `reset-test-db.mjs`
 * and `demo-data.mjs` do. A script that mints an account with a printed password is exactly the
 * kind of tool that must not be able to run against a district's real record.
 *
 * **The password is printed**, which is the whole point and also why this can never be anything
 * but a development tool.
 *
 * **The account is named so nobody mistakes it for a real officer** — it appears in the roster,
 * on the "who could I tell" list and in the audit trail, and a plausible-looking name there is
 * the beginning of somebody trusting it.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';

process.loadEnvFile('.env');

const url = process.env['DATABASE_URL'];

if (url === undefined) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

// Two checks, not one. The name is the obvious guard; the host is the one that catches a `.env`
// somebody copied from the office machine to look at something.
if (/prod|production/i.test(url) || !/127\.0\.0\.1|localhost/.test(url)) {
  console.error(`Refusing to create a printed-password account in ${url.replace(/:[^:@]*@/, ':***@')}`);
  console.error('This is a development tool. Use the installer for a real district.');
  process.exit(1);
}

const { createPool } = await import('../dist/db/pool.js');
const { hashPassword } = await import('../dist/auth/passwords.js');

const pool = createPool(url);

const PHONE = process.argv[2] ?? '03000000001';
const PASSWORD = 'district-nerve-centre-dev';
const NAME = 'Development Login (not a real officer)';

try {
  /**
   * An **administrative** office, so this account sees the district rather than one department.
   *
   * That is what makes it useful for looking at the control room: a district-tier seat lands on
   * intake (M6-11), sees every incident on the board, and gets the administration console. A
   * department seat would show a correct but much smaller product.
   */
  const office = await pool.query(
    `SELECT department_id, name FROM department
      WHERE is_administration = true AND retired_at IS NULL
      ORDER BY name LIMIT 1`,
  );

  let departmentId = office.rows[0]?.department_id;
  let departmentName = office.rows[0]?.name;

  if (departmentId === undefined) {
    // An empty database — no directory loaded. Make one office so there is something to hold.
    const made = await pool.query(
      `INSERT INTO department (code, name, is_administration)
       VALUES ($1, $2, true) RETURNING department_id, name`,
      [`dev-office-${randomUUID().slice(0, 8)}`, 'DC Office (development)'],
    );
    departmentId = made.rows[0].department_id;
    departmentName = made.rows[0].name;
    console.log(`  created ${departmentName} — the database had no administrative office`);
  }

  const seat = await pool.query(
    `INSERT INTO seat (title, department_id) VALUES ($1, $2) RETURNING seat_id, tier`,
    ['Development Control Room', departmentId],
  );

  const person = await pool.query(
    `INSERT INTO person (full_name, phone, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING person_id`,
    [NAME, PHONE, await hashPassword(PASSWORD)],
  );

  if (person.rows[0] === undefined) {
    console.error('');
    console.error(`That number already has an account: ${PHONE}`);
    console.error('Pass a different one:  npm run dev:account -- 03000000002');
    process.exit(1);
  }

  await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
    seat.rows[0].seat_id,
    person.rows[0].person_id,
  ]);

  console.log('');
  console.log('  Sign in with:');
  console.log('');
  console.log(`      Phone     ${PHONE}`);
  console.log(`      Password  ${PASSWORD}`);
  console.log('');
  console.log(`  Post: Development Control Room · ${departmentName}`);
  // The tier is derived by a database trigger from whether the office is administrative
  // (migration 0010), so it is read back rather than asserted — an account that silently came
  // out department-tier would show a correct but much smaller product, and that exact bug is
  // recorded in CHANGELOG.md for 2026-08-05.
  const tier = await pool.query('SELECT tier FROM seat WHERE seat_id = $1', [
    seat.rows[0].seat_id,
  ]);
  console.log(`  Tier: ${tier.rows[0].tier}${tier.rows[0].tier === 'district' ? ' — sees the whole district' : ''}`);
  console.log('');
} finally {
  await pool.end();
}
