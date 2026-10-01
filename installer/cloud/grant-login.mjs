/**
 * Give somebody who is already in the district's directory a sign-in.
 *
 *   cd /opt/dnc/app && node ../installer/cloud/grant-login.mjs 03000000558
 *   cd /opt/dnc/app && node ../installer/cloud/grant-login.mjs 03000000558 --reset
 *
 * ------------------------------------------------------------------------------------------
 * Why this is not `npm run dev:account`
 * ------------------------------------------------------------------------------------------
 *
 * That script creates a **new person** called "Development Login (not a real officer)" holding a
 * **new seat** called "Development Control Room", with a password printed in its own source. It
 * is exactly right for looking at the product on a laptop and exactly wrong for a district: it
 * would put a fictional officer in the roster of a live installation, and the real Assistant
 * Commissioner still could not sign in.
 *
 * ------------------------------------------------------------------------------------------
 * What it does, and the rule underneath it
 * ------------------------------------------------------------------------------------------
 *
 * **Adding a contact and granting a login stay separate acts** (M0-51). The directory loads ~40
 * officers with a null `password_hash`, meaning they can be notified and cannot sign in — that
 * is deliberate, because ~80 credentials nobody is watching is worse than none. This script is
 * the second act, performed one person at a time, on purpose.
 *
 * It prints what the account will actually be able to see, because that is decided by the seat's
 * **tier** and not by anything typed here. A number belonging to an officer whose post sits in
 * an ordinary department produces an account that administers *that department only* — it works,
 * it looks right, and it becomes "the dashboard is wrong" weeks later with nothing on any screen
 * explaining why. `first-run.mjs` learned this on a real installation; it is printed rather than
 * guessed at.
 *
 * The password is generated here and shown **once**. It is not derived from anything about the
 * person: this district's numbers are semi-public, the roster says who holds which post, and a
 * password anybody can look up on an account that can see all of Bajaur is not a password.
 */

import process from 'node:process';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const say = (m) => console.log(`    ${m}`);
const die = (m) => {
  console.error(`\nstopped: ${m}\n`);
  process.exit(1);
};

process.loadEnvFile('.env');

const url = process.env['DATABASE_URL'];
if (url === undefined) die('DATABASE_URL is not set — run this from /opt/dnc/app');

const phone = process.argv[2];
const reset = process.argv.includes('--reset');

/**
 * `--password` sets a chosen one instead of generating it.
 *
 * It exists because the district asked for it and it is their system to run. It is **not** the
 * default, and the reason is worth keeping next to the flag: a password chosen to be memorable
 * is usually chosen from the same facts that are already written down about the person — their
 * name, their post, their number — and all three of those are in this district's roster. The
 * generated one is four groups of five from an alphabet with no lookalike characters, which is
 * readable down a telephone line and is not derivable from anything.
 *
 * `hashPassword` enforces the 10-character minimum either way, and that minimum is low on
 * purpose: `passwords.ts` says the real protection here is the throttle and instant revocation,
 * both of which exist (auth/throttle.ts, and sessions store only a token hash).
 */
const chosenAt = process.argv.indexOf('--password');
const chosen = chosenAt === -1 ? undefined : process.argv[chosenAt + 1];
if (chosenAt !== -1 && (chosen === undefined || chosen.startsWith('--'))) {
  die('--password needs a value');
}

if (phone === undefined || phone.startsWith('--')) {
  die('usage: node ../installer/cloud/grant-login.mjs <phone> [--reset] [--password <value>]');
}

const dist = pathToFileURL(join(process.cwd(), 'dist/')).href;
const { createPool } = await import(`${dist}db/pool.js`);
const { hashPassword } = await import(`${dist}auth/passwords.js`);
const { normalisePhone } = await import(`${dist}ops/directory.js`);

/**
 * Readable, and long enough to be worth having. Four groups of five from an alphabet with no
 * `0/O` or `1/l/I`, because this gets read down a telephone line at least once.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const password =
  chosen ??
  Array.from({ length: 4 }, () =>
    Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
  ).join('-');

const pool = createPool(url);

try {
  const wanted = normalisePhone(phone);

  /**
   * Every seat this person holds, with the office and the tier. `resolveIdentity` selects a seat
   * with no ORDER BY, so a person holding two posts gets whichever row the database returns —
   * a known gap (§5). Listing them here means nobody grants a login into that ambiguity without
   * seeing it first.
   */
  const found = await pool.query(
    `SELECT p.person_id, p.full_name, p.password_hash IS NOT NULL AS has_login,
            s.title, s.tier, d.name AS department, d.is_administration
       FROM person p
       LEFT JOIN duty_assignment da ON da.person_id = p.person_id
       LEFT JOIN seat s ON s.seat_id = da.seat_id
       LEFT JOIN department d ON d.department_id = s.department_id
      WHERE p.phone = $1`,
    [wanted],
  );

  if (found.rows.length === 0) {
    die(
      `nobody in the directory has the number ${wanted}.\n` +
        '    A login is granted to somebody already in the roster — it does not create a person.',
    );
  }

  const who = found.rows[0];
  say(`${who.full_name} — ${wanted}`);

  const posts = found.rows.filter((r) => r.title !== null);
  if (posts.length === 0) {
    die(
      `${who.full_name} holds no post, so this account would be able to see nothing.\n` +
        '    A seat is re-resolved on every request and authority comes from it, never from the\n' +
        '    session — an account with no seat is refused by every route (the M5 review).',
    );
  }
  for (const post of posts) {
    say(`  holds ${post.title} · ${post.department} · ${post.tier} tier`);
  }
  if (posts.length > 1) {
    say('  NOTE: more than one post. Which one authority resolves to is not currently ordered.');
  }

  if (posts.some((p) => p.is_administration)) {
    say('  this account will see the whole district, and the administration console');
  } else {
    say('  this account will see ONLY this department — not the district. Read that twice.');
  }

  if (who.has_login && !reset) {
    die(
      `${who.full_name} already has a sign-in.\n` +
        '    Pass --reset to replace the password. Revocation is instant either way, because\n' +
        '    sessions store only a hash of their token and the seat is re-resolved per request.',
    );
  }

  await pool.query('UPDATE person SET password_hash = $1 WHERE person_id = $2', [
    await hashPassword(password),
    who.person_id,
  ]);

  console.log('');
  console.log(`  Sign in at   ${process.env['PUBLIC_ORIGIN'] ?? 'the district address'}`);
  console.log(`  Username     ${wanted}      (the number IS the username)`);
  console.log(`  Password     ${password}`);
  console.log('');
  console.log('  Shown once. It is stored only as a scrypt hash and cannot be read back.');
  if (chosen !== undefined) {
    console.log('  Chosen, not generated — change it if it can be guessed from the roster.');
  }
  console.log('');
} finally {
  await pool.end();
}
