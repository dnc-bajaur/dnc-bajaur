/**
 * First run — turn a freshly copied set of files into a district that can be signed into.
 *
 * The installer copies bytes. This does everything that is not copying: it creates the
 * PostgreSQL cluster, brings it up, creates the role and database, writes the configuration,
 * applies the migrations, loads Bajaur's contact directory, marks the two administrative
 * offices, and creates the one account that can sign in. It is the difference between a
 * folder of files and a working system, and it must survive being run by somebody who has
 * never seen a terminal.
 *
 * Two rules shape all of it:
 *
 *   * **Say what failed, in the words of the person reading it.** This runs behind an
 *     installer progress bar on a machine in the DC office. "ECONNREFUSED 127.0.0.1:55432"
 *     is not an error message, it is a puzzle. Every failure here names the thing that went
 *     wrong and what to do about it.
 *   * **Safe to run twice.** An installer can be re-run, an upgrade re-runs this, and a
 *     half-finished first attempt must not poison the second. Every step checks for its own
 *     result before doing anything, and none of them destroy data.
 *
 *     Usage:
 *       node first-run.mjs --install-dir <dir> --data-dir <dir>
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

//------------------------------------------------------------------------------------------
// Arguments and layout
//------------------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined && fallback === undefined) {
    fail(`--${name} was not supplied. This script is run by the installer, not by hand.`);
  }
  return value ?? fallback;
}

/**
 * Stop, with something a human can act on.
 *
 * The exit code matters: the installer shows its own message on any non-zero exit, and this
 * text is what it shows underneath.
 */
function fail(message, detail) {
  process.stderr.write(`\n${message}\n`);
  if (detail !== undefined && String(detail).trim().length > 0) {
    process.stderr.write(`\n${String(detail).trim()}\n`);
  }
  process.exit(1);
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

const installDir = arg('install-dir');
const dataDir = arg('data-dir');

const appDir = join(installDir, 'app');
const pgBin = join(installDir, 'pgsql', 'bin');
const pgData = join(dataDir, 'pgdata');
const backupDir = join(dataDir, 'backups');
const logDir = join(dataDir, 'logs');
const envFile = join(appDir, '.env');
const stateFile = join(dataDir, 'install.json');

for (const dir of [dataDir, backupDir, logDir]) mkdirSync(dir, { recursive: true });

//------------------------------------------------------------------------------------------
// The credentials the installer collected
//------------------------------------------------------------------------------------------

/**
 * Read the administrator's details from the file the installer wrote, then destroy it.
 *
 * A file rather than a command-line argument, deliberately: a command line is visible to
 * every process on the machine for as long as this one runs, and Task Manager will show it.
 * This file lives in the installation directory, which on Windows is writable only by
 * administrators, exists for the few seconds this script takes, and is deleted below before
 * anything else happens — including before any step that could fail and leave it behind.
 */
const handoffFile = join(installDir, 'first-run.json');

let account = null;
if (existsSync(handoffFile)) {
  try {
    account = JSON.parse(readFileSync(handoffFile, 'utf8'));
  } catch {
    fail('The account details from the installer could not be read. Please run Setup again.');
  } finally {
    rmSync(handoffFile, { force: true });
  }
}

//------------------------------------------------------------------------------------------
// Running the PostgreSQL tools
//------------------------------------------------------------------------------------------

function pg(tool, args, options = {}) {
  const exe = join(pgBin, `${tool}.exe`);
  if (!existsSync(exe)) {
    fail(`The database program ${tool}.exe is missing from this installation.`, exe);
  }

  const result = spawnSync(exe, args, {
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });

  if (result.error) fail(`Could not run ${tool}.`, result.error.message);
  return result;
}

function bindable(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    if (host === undefined) probe.listen(port);
    else probe.listen(port, host);
  });
}

/**
 * Is this TCP port free?
 *
 * Asked rather than assumed. The district's machine may already run PostgreSQL, or anything
 * else that wanted port 3000 — a department that bought a system before this one is exactly
 * the situation this project exists in the middle of — and a process that silently fails to
 * bind is the kind of fault that surfaces as "the app does not open" three weeks later.
 *
 * **Both bindings are checked, and the reason is a bug this found.** The first version probed
 * `127.0.0.1` only. The server binds every interface, so it has to: a test installation
 * recorded port 3000 as free while another copy of this very application was already serving
 * on it, because a loopback-only bind succeeded underneath an all-interfaces one. The two
 * questions are genuinely different — PostgreSQL here listens on loopback alone and the
 * application listens on everything — so a port is only free when neither is taken.
 */
function portFree(port) {
  return Promise.all([bindable(port, undefined), bindable(port, '127.0.0.1')]).then((r) =>
    r.every(Boolean),
  );
}

async function firstFreePort(from, tries = 40) {
  for (let port = from; port < from + tries; port++) {
    if (await portFree(port)) return port;
  }
  fail(`No free port between ${String(from)} and ${String(from + tries)}.`);
}

/**
 * Sleep, synchronously.
 *
 * The readiness loop below has to block — `pg_isready` is a synchronous spawn and there is
 * nothing else for this process to be doing — and `Atomics.wait` is the only way to hold a
 * thread without a busy loop that pins a core on the machine that is also starting a
 * database.
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

//------------------------------------------------------------------------------------------
// 1. The cluster
//------------------------------------------------------------------------------------------

/**
 * Where the district's record will live, and the state carried between runs.
 *
 * The port is recorded because it is *chosen* rather than fixed — if this reruns and picks a
 * different one, the `.env` written below and the cluster actually running would disagree,
 * and the application would start and fail to reach a database that is up.
 */
let state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

const clusterExists = existsSync(join(pgData, 'PG_VERSION'));

if (!clusterExists) {
  say('Creating the district database…');

  /**
   * The superuser password. Generated, never typed by anyone, and never used by the running
   * application — that connects as the `dnc` role with its own password in `.env`.
   *
   * It exists because initdb requires one when host authentication is scram, and it is kept in
   * `install.json` because **this script has to be able to run again**: an interrupted install,
   * a repair, or an upgrade all need to reach the cluster as a superuser to check the role and
   * the database are there. Throwing it away would make the second run of this file impossible
   * and the only recovery a fresh cluster.
   */
  const superPassword = randomBytes(24).toString('base64url');
  const pwFile = join(dataDir, 'initdb.pw');
  writeFileSync(pwFile, superPassword, 'utf8');

  try {
    const out = pg('initdb', [
      '-D',
      pgData,
      '-U',
      'postgres',
      '--pwfile',
      pwFile,
      '-A',
      'scram-sha-256',
      '-E',
      'UTF8',
      // `C` rather than the machine's locale on purpose. Collation is what index ordering is
      // built on, and a cluster created under one Windows locale and restored onto a machine
      // with another gives corrupt indexes with no error — the restore drill (R-08) is
      // supposed to be a rehearsal, not a discovery.
      '--locale=C',
    ]);

    if (out.status !== 0) {
      fail(
        'The database could not be created.\n' +
          'This usually means the installation folder is on a drive that is full, or that ' +
          'antivirus software blocked it.',
        `${out.stdout ?? ''}\n${out.stderr ?? ''}`,
      );
    }
  } finally {
    rmSync(pwFile, { force: true });
  }

  state.superPassword = superPassword;
  state.port = await firstFreePort(55432);

  /**
   * Bind to this machine only.
   *
   * The *application* is reachable from the district's network — that is the whole point,
   * field handsets sync from anywhere (ADR-0011). The database is not, and must not be:
   * everything that reaches the record goes through the server's authority checks, and a
   * database listening on the network is a way around every one of them (INV-05).
   */
  writeFileSync(
    join(pgData, 'postgresql.auto.conf'),
    [
      '# Written by the District Nerve Center installer. Edited by hand at your own risk.',
      `port = ${String(state.port)}`,
      "listen_addresses = '127.0.0.1'",
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
} else {
  say('Using the database that is already installed…');
  if (typeof state.port !== 'number') {
    fail(
      'A database exists here but the installation record is missing, so the port it runs ' +
        'on is unknown.\nRemove the data folder to start clean, or restore install.json ' +
        'from a backup.',
      dataDir,
    );
  }
}

//------------------------------------------------------------------------------------------
// 2. Start it
//------------------------------------------------------------------------------------------

const pgLog = join(logDir, 'postgres.log');

function pgReady() {
  return pg('pg_isready', ['-h', '127.0.0.1', '-p', String(state.port), '-q']).status === 0;
}

if (!pgReady()) {
  say('Starting the database…');

  /**
   * Detached, with output redirected.
   *
   * `pg_ctl start` leaves the server holding this process's stdout handle, so the installer
   * would sit at 99% for ever with a database that is actually up and running perfectly.
   * `scripts/dev-db.ps1` learned this first and carries the same note.
   */
  const child = spawn(
    join(pgBin, 'pg_ctl.exe'),
    ['-D', pgData, '-l', pgLog, '-o', `-p ${String(state.port)}`, 'start'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + 60_000;
  while (!pgReady()) {
    if (Date.now() > deadline) {
      const log = existsSync(pgLog) ? readFileSync(pgLog, 'utf8').split('\n').slice(-25) : [];
      fail(
        'The database did not start within a minute.\n' +
          'The most common cause is antivirus software holding the database files.',
        log.join('\n'),
      );
    }
    sleep(400);
  }
}

//------------------------------------------------------------------------------------------
// 3. The role and the database
//------------------------------------------------------------------------------------------

/**
 * Run one statement as the superuser.
 *
 * `ON_ERROR_STOP` is not optional. Without it `psql` reports success after a script whose
 * statements failed one by one — the same trap `ops/restore.ts` documents, and the reason a
 * restore can appear to work and produce an empty database.
 */
function superSql(sql, database = 'postgres') {
  const out = pg(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(state.port),
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-t',
      '-A',
      '-c',
      sql,
    ],
    { env: { PGPASSWORD: state.superPassword } },
  );
  if (out.status !== 0) {
    fail('A database command failed while setting up.', `${out.stdout ?? ''}\n${out.stderr ?? ''}`);
  }
  return (out.stdout ?? '').trim();
}

if (typeof state.appPassword !== 'string') {
  state.appPassword = randomBytes(24).toString('base64url');
}

/**
 * The application connects as its own role, not as the superuser.
 *
 * `pg_monitor` is granted because `/health` reports whether the standby is keeping up, and
 * `pg_stat_replication` is readable only with it. `ops/replication.ts` already survives not
 * having the permission — it reports the check as unavailable rather than failing the health
 * endpoint — but a health screen that cannot answer the question is one nobody trusts, and
 * this is the one moment where granting it costs nothing.
 */
const roleExists = superSql("SELECT 1 FROM pg_roles WHERE rolname = 'dnc'") === '1';
if (roleExists) {
  superSql(`ALTER ROLE dnc WITH LOGIN PASSWORD '${state.appPassword}'`);
} else {
  superSql(`CREATE ROLE dnc WITH LOGIN PASSWORD '${state.appPassword}'`);
}
superSql('GRANT pg_monitor TO dnc');

const dbExists = superSql("SELECT 1 FROM pg_database WHERE datname = 'dnc'") === '1';
if (!dbExists) superSql('CREATE DATABASE dnc OWNER dnc');

writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

//------------------------------------------------------------------------------------------
// 4. Configuration
//------------------------------------------------------------------------------------------

const appPort = typeof state.appPort === 'number' ? state.appPort : await firstFreePort(3000);
state.appPort = appPort;

const databaseUrl = `postgres://dnc:${encodeURIComponent(state.appPassword)}@127.0.0.1:${String(
  state.port,
)}/dnc`;

/**
 * `.env` beside the application, because that is where `main.ts` looks for it and where
 * `docs/05-stack.md` says configuration lives. On this deployment the file **is** the secret
 * store, by decision rather than by default (ADR-0007, ADR-0011, and the note in `config.ts`).
 *
 * `BACKUP_PASSPHRASE` is deliberately absent rather than filled in with something generated.
 * Off-site backup is R-06 and waiting on the district; a passphrase this installer invented
 * and nobody wrote down would encrypt every copy that ever leaves the building with a secret
 * that exists only on the machine the copies are protecting against losing.
 */
writeFileSync(
  envFile,
  [
    '# District Nerve Center — written by the installer.',
    '#',
    '# This file is the secret store for this machine. Anyone who can read it can read the',
    '# district’s record. Do not copy it, do not email it, and do not put it in a repository.',
    '',
    'NODE_ENV=production',
    `PORT=${String(appPort)}`,
    'LOG_LEVEL=info',
    '',
    `DATABASE_URL=${databaseUrl}`,
    `PG_BIN=${pgBin}`,
    `BACKUP_DIR=${backupDir}`,
    '',
    '# Off-site backup — R-06, waiting on the district.',
    '#',
    '# Until all three are set, nightly dumps are taken and verified but never leave this',
    '# building, and Administration → Backups says exactly that. The passphrase must be at',
    '# least 16 characters and must be kept somewhere that is NOT this machine: without it,',
    '# every off-site copy is unreadable.',
    '# GCS_BUCKET=',
    '# GCS_TOKEN=',
    '# BACKUP_PASSPHRASE=',
    '',
  ].join('\n'),
  'utf8',
);

//------------------------------------------------------------------------------------------
// 5. Schema, directory, administration, account
//------------------------------------------------------------------------------------------

process.env.DATABASE_URL = databaseUrl;

const dist = pathToFileURL(join(appDir, 'dist')).href;
const { createPool, migrate } = await import(`${dist}/db/pool.js`);
const { loadDirectory } = await import(`${dist}/ops/directory.js`);
const { hashPassword } = await import(`${dist}/auth/passwords.js`);

const pool = createPool(databaseUrl);

try {
  say('Preparing the record…');
  const applied = await migrate(pool, join(appDir, 'db', 'migrations'));
  if (applied.length > 0) say(`  ${String(applied.length)} migrations applied`);

  //----------------------------------------------------------------------------------------
  // The district's own contact list
  //----------------------------------------------------------------------------------------

  const seedFile = join(appDir, 'db', 'seed', 'directory.json');
  if (existsSync(seedFile) && state.directoryLoaded !== true) {
    say('Loading the district directory…');
    const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
    const outcome = await loadDirectory(pool, seed.rows ?? []);

    say(
      `  ${String(outcome.departments)} offices, ${String(outcome.seats)} posts, ` +
        `${String(outcome.people)} officers`,
    );

    // Reported, never swallowed. A loader whose refusals are only visible in a log is the
    // same mistake as a notification with no delivery state (INV-03).
    for (const p of outcome.problems) say(`  NOT LOADED: ${p.problem}`);

    state.directoryLoaded = true;
  }

  /**
   * Mark the two administrative offices.
   *
   * Migration 0007 already contains this statement and on a fresh installation it matches
   * **nothing**: migrations run against an empty database, so the departments it names are
   * created minutes later by the directory load above. Every office therefore came out as an
   * ordinary department, no seat was district tier, and nobody could see the district — on a
   * machine where every test in the repository passes, because the tests build their
   * departments before asserting rather than in this order.
   *
   * ADR-0010 decides which two these are. It is not a guess and it is not the installer's to
   * choose; what the installer owns is making sure the decision survives the ordering.
   */
  const administration = await pool.query(
    `UPDATE department SET is_administration = true
      WHERE code IN ('deputy-commissioner-office', 'assistant-commissioner-bajaur')
        AND NOT is_administration
      RETURNING code`,
  );
  for (const row of administration.rows) say(`  ${row.code} is an administrative office`);

  const administrationCount = await pool.query(
    'SELECT count(*)::int AS n FROM department WHERE is_administration',
  );
  if (administrationCount.rows[0].n === 0) {
    fail(
      'No administrative office exists in this installation, so nobody would be able to see ' +
        'the district as a whole.\nThis means the district directory did not load. Please ' +
        'run Setup again and report this if it happens twice.',
    );
  }

  /**
   * Re-derive every seat's tier, now that the offices above are marked.
   *
   * Migration 0010 makes a seat district tier if its office is administrative, and enforces it
   * with a trigger — but the trigger fires when the **seat** is written, and every seat here
   * was written by the directory load a moment ago, while `is_administration` was still false
   * on every department. So the Deputy Commissioner's own post came out `department` tier.
   *
   * That is not cosmetic. `viewerFor` keys on tier — deliberately, because it is the one value
   * a caller cannot assert and the M5 security review moved the decision there. A DC signing in
   * would have been scoped to the DC Office alone and shown none of the district, which is the
   * opposite of the authority the post carries. **Found by installing this and signing in as
   * the real Deputy Commissioner**; every test in the repository creates its departments before
   * its seats, so the order that produces it does not occur anywhere else.
   *
   * `SET tier = tier` is not a no-op: naming the column in SET is what `UPDATE OF tier` means,
   * so the trigger runs and recomputes the value from the department. The trigger stays the
   * only thing that decides a tier, which is the point of it.
   */
  const retiered = await pool.query(
    `UPDATE seat SET tier = tier
      WHERE department_id IS NOT NULL
      RETURNING seat_id`,
  );
  const districtSeats = await pool.query(
    "SELECT count(*)::int AS n FROM seat WHERE tier = 'district'",
  );
  say(
    `  ${String(retiered.rowCount)} posts re-checked — ` +
      `${String(districtSeats.rows[0].n)} carry district authority`,
  );

  //----------------------------------------------------------------------------------------
  // The one account that can sign in
  //----------------------------------------------------------------------------------------

  if (account !== null) {
    const phone = String(account.phone ?? '').replace(/[^0-9+]/g, '');
    const password = String(account.password ?? '');
    const fullName = String(account.name ?? '').trim() || 'District Administrator';

    if (phone.length < 7) fail('The mobile number collected by Setup is not a usable number.');
    if (password.length < 12) fail('The password collected by Setup is shorter than 12 characters.');

    say('Setting up the administrator account…');

    const hash = await hashPassword(password);

    /**
     * Migration 0006 put phone uniqueness only where a password hash exists, because two
     * officers in Bajaur genuinely share a handset. So the number given here may already be in
     * the directory as a contact — that row is the person, and it gets the account rather than
     * a second row being created beside it.
     *
     * Which is the normal case, not the edge case: the district is expected to give the number
     * of somebody already on their own contact list.
     */
    const existing = await pool.query(
      `SELECT p.person_id, p.full_name,
              s.seat_id, s.title AS seat_title, s.tier,
              d.name AS department_name
         FROM person p
         LEFT JOIN duty_assignment a ON a.person_id = p.person_id AND a.to_at IS NULL
         LEFT JOIN seat s ON s.seat_id = a.seat_id
         LEFT JOIN department d ON d.department_id = s.department_id
        WHERE p.phone = $1
        ORDER BY (s.seat_id IS NOT NULL) DESC, p.created_at
        LIMIT 1`,
      [phone],
    );

    const known = existing.rows[0] ?? null;

    const personId =
      known === null
        ? (
            await pool.query(
              `INSERT INTO person (full_name, phone, password_hash)
               VALUES ($1, $2, $3) RETURNING person_id`,
              [fullName, phone, hash],
            )
          ).rows[0].person_id
        : (
            await pool.query(
              `UPDATE person
                  SET password_hash = $2, disabled_at = NULL, removed_at = NULL,
                      placeholder = false
                WHERE person_id = $1
              RETURNING person_id`,
              [known.person_id, hash],
            )
          ).rows[0].person_id;

    /**
     * If they already hold a post, that post is their authority. Full stop.
     *
     * The first version of this always created a `System Administrator` seat and assigned the
     * account to it. Given the Deputy Commissioner's own number — the most likely number the
     * district will type — that made **one person the current holder of two posts**, and
     * `resolveIdentity` selects a seat with no `ORDER BY`: the authority that came back was
     * whichever row PostgreSQL felt like returning, and could differ between two requests in
     * the same session. Signing in landed on the DC's post; it could as easily have been the
     * other.
     *
     * Authority attaches to the post (ADR-0004), and the district decided who holds which post
     * before this installer ran. An installer's job is to let somebody in, not to quietly
     * promote them.
     */
    let seatId = known?.seat_id ?? null;

    if (seatId === null) {
      const office = await pool.query(
        `SELECT department_id FROM department
          WHERE code = 'deputy-commissioner-office' OR is_administration
          ORDER BY (code = 'deputy-commissioner-office') DESC
          LIMIT 1`,
      );
      const departmentId = office.rows[0].department_id;

      /**
       * A post of its own, for somebody the district's list does not have.
       *
       * Not one of the real ones: putting a person into a post they do not hold, in a record
       * whose whole purpose is to say who did what, would attribute everything they do to the
       * officer who actually holds it. The district can retire this post from the roster
       * screen the moment their own people have accounts.
       *
       * **Without break-glass.** District tier already carries the override authority this
       * post needs (ADR-0003). Break-glass is the system's highest authority, and an installer
       * must not mint it silently for whoever happened to run Setup — that is a decision for
       * the two offices, made deliberately and recorded.
       */
      const created = await pool.query(
        `INSERT INTO seat (title, department_id, can_break_glass)
         SELECT 'System Administrator', $1, false
          WHERE NOT EXISTS (
                SELECT 1 FROM seat WHERE title = 'System Administrator' AND department_id = $1)
         RETURNING seat_id`,
        [departmentId],
      );

      seatId =
        created.rows.length > 0
          ? created.rows[0].seat_id
          : (
              await pool.query(
                `SELECT seat_id FROM seat
                  WHERE title = 'System Administrator' AND department_id = $1`,
                [departmentId],
              )
            ).rows[0].seat_id;

      // Relieve whoever holds it, then take it. `duty_one_current_holder_per_seat` is a unique
      // index, so doing this the other way round fails rather than double-booking.
      await pool.query(
        'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
        [seatId],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        personId,
      ]);
    }

    /**
     * Say what the account actually is, including when that is not what was asked for.
     *
     * If the number belonged to somebody already in the district's list, the name typed into
     * Setup is **not** what this account is called — the record's name for that person is, and
     * inventing a second row so the typed name could win would put the same officer in the
     * system twice. Announcing the typed name here would have been the installer telling a
     * small lie about the one account the district is about to depend on.
     */
    const final = await pool.query(
      `SELECT p.full_name, s.title AS seat_title, s.tier, d.name AS department_name
         FROM person p
         LEFT JOIN duty_assignment a ON a.person_id = p.person_id AND a.to_at IS NULL
         LEFT JOIN seat s ON s.seat_id = a.seat_id
         LEFT JOIN department d ON d.department_id = s.department_id
        WHERE p.person_id = $1`,
      [personId],
    );
    const who = final.rows[0];

    say(`  ${who.full_name} can sign in with ${phone}`);
    say(`  Post: ${who.seat_title} — ${who.department_name}`);

    if (who.tier !== 'district') {
      /**
       * Not a failure, and not hidden either.
       *
       * The account works and can run its own department. It cannot see the district, because
       * its post does not carry that authority — and silently widening it here would be the
       * exact inversion the M5 security review closed. What the district needs is to know,
       * now, rather than at the moment somebody asks why the dashboard looks small.
       */
      say('');
      say(`  NOTE: this post administers ${who.department_name} only, not the whole district.`);
      say('  To administer the district, give this person a post in the DC Office or the');
      say('  AC Headquarter Office from the roster screen.');
    }

    state.administratorPhone = phone;
  }

  state.installedAt = new Date().toISOString();
  state.appPort = appPort;
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  say('');
  say(`Ready. The District Nerve Center will open at http://localhost:${String(appPort)}`);
} catch (err) {
  fail(
    'Setting up the district record failed.\n' +
      'Nothing has been lost — running Setup again will continue from where this stopped.',
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
  );
} finally {
  await pool.end();
}
