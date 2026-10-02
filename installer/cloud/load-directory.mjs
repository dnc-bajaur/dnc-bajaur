/**
 * Load Bajaur's directory into a cloud installation, and repair the two things the migration
 * order leaves wrong afterwards.
 *
 *   cd /opt/dnc-bajaur/app && node ../installer/cloud/load-directory.mjs
 *
 * ------------------------------------------------------------------------------------------
 * Why this file exists
 * ------------------------------------------------------------------------------------------
 *
 * `setup.sh` deliberately does not load the district's own data — the seed file holds ~40 named
 * officials' mobile numbers, it is gitignored, and it reaches the server by `scp` rather than
 * through a clone. But nothing else loaded it either, so the first cloud installation came up
 * with **zero departments**: every migration applied, `/health` green, and a control room with
 * nobody to tell. Found on 2026-08-10 by counting rows after the deploy rather than by trusting
 * that a successful install meant a usable one.
 *
 * `installer/runtime/first-run.mjs` has done all of this since 2026-08-05 for Windows. The two
 * repairs below are copied from it deliberately rather than shared: that file runs inside a
 * packaged Inno Setup runtime and importing across the two would tie a Linux deployment to the
 * Windows release. **If you change one, change the other** — and the reasoning, which is the
 * part that matters, lives there in full.
 *
 * It is safe to re-run. `loadDirectory` reports conflicts instead of resolving them, and both
 * repairs are idempotent.
 */

import process from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const say = (m) => console.log(`    ${m}`);
const die = (m) => {
  console.error(`\nstopped: ${m}\n`);
  process.exit(1);
};

process.loadEnvFile('.env');

const url = process.env['DATABASE_URL'];
if (url === undefined) die('DATABASE_URL is not set — run this from /opt/dnc-bajaur/app');

const seedFile = join(process.cwd(), 'db', 'seed', 'directory.json');
if (!existsSync(seedFile)) {
  die(
    `${seedFile} does not exist.\n` +
      '    It is gitignored on purpose — real mobile numbers do not go in a repository — so it\n' +
      '    has to be copied up separately:\n' +
      '        scp app/db/seed/directory.json root@<server>:/opt/dnc-bajaur/app/db/seed/',
  );
}

// Resolved against the working directory, not against this file. A bare `./dist/...` specifier
// would resolve beside this script — which lives in `installer/cloud/`, two directories away
// from the build it is trying to import.
const dist = pathToFileURL(join(process.cwd(), 'dist/')).href;
const { createPool } = await import(`${dist}db/pool.js`);
const { loadDirectory } = await import(`${dist}ops/directory.js`);

const pool = createPool(url);

try {
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  const outcome = await loadDirectory(pool, seed.rows ?? []);

  say(
    // ⚠️ No department count: `loadDirectory` reports 0 since ADR-0030 and printing it would
    // read as a failed load rather than as a layer that no longer exists.
    `loaded — ${String(outcome.seats)} posts, ` +
      `${String(outcome.people)} people, ${String(outcome.assignments)} assignments, ` +
      `${String(outcome.vacant)} vacant`,
  );

  // Both lists are printed, and the distinction is the loader's own: a problem did not load, a
  // note loaded and still wants a human's eye. A shared handset is ordinary in this district and
  // is also exactly what a mistyped digit looks like — only the district can tell which it is,
  // so printing one list and not the other would hide the half that needs a person.
  // Identified by post, not by the officer's name or number. This output goes to a deploy log,
  // and the whole reason the seed file is gitignored is that those two do not belong in one.
  const where = (row) => `${row?.department ?? '?'} · ${row?.designation ?? '—'}`;
  for (const p of outcome.problems) say(`  did not load — ${where(p.row)}: ${p.problem}`);
  for (const n of outcome.notes) say(`  note — ${where(n.row)}: ${n.problem}`);

  /**
   * 🔴 **THE THREE REPAIRS BELOW ALL PIVOTED ON A TABLE THAT NO LONGER EXISTS — ADR-0030.**
   *
   * They marked two departments administrative, ticked the seats filed under them, and re-fired
   * the tier trigger through `seat.department_id`. Migration 0039 dropped all of it, so this
   * script died at the first `UPDATE department` — **after `loadDirectory` had already written
   * the posts and people.** The directory therefore loaded and **not one seat carried the tick
   * or district tier**, which is precisely the catastrophe the note below was written about,
   * arriving through the repair that was supposed to prevent it.
   *
   * Found on 2026-08-27, during the deploy of ADR-0030 itself, by counting rows after running
   * this script rather than trusting that it had run.
   *
   * ⚠️ **The tick is now the ONLY thing that grants authority** — `seat.is_administration`,
   * with no department left to satisfy it in `sessions.ts`'s second branch. So this is no longer
   * a repair of a migration's ordering; it is the one act that decides whether the district has
   * any administrative power at all.
   *
   * The two offices are read **from the seed**, not hardcoded here: it is the same source that
   * names every other post, and the old code keyed on exactly these two department names,
   * slugified. A designation reaching the tick has to come from a row whose department is one
   * of them, which keeps the district's own file the thing that decides.
   */
  const OFFICES = new Set(['deputy-commissioner-office', 'assistant-commissioner-bajaur']);
  const slug = (s) =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const officePosts = [
    ...new Set(
      (seed.rows ?? [])
        .filter((r) => OFFICES.has(slug(r.department)))
        .map((r) => String(r.designation ?? '').trim())
        .filter((t) => t !== ''),
    ),
  ];

  if (officePosts.length === 0) {
    die(
      'the seed names no post in either administrative office.\n' +
        '    Nobody would be able to issue an advisory, edit the directory or configure\n' +
        '    anything, and nothing would fail at the moment it happened.',
    );
  }

  /**
   * ⚠️ **`tier` is NAMED in the SET list, and that is not a no-op.**
   *
   * Migration 0010's trigger is `UPDATE OF tier`: naming the column is what fires it, and since
   * 0039 it derives the tier from `is_administration` alone. Setting the tick without naming
   * `tier` would leave both offices reading `department` — a district seat that cannot see the
   * district — and nothing would say so.
   */
  const ticked = await pool.query(
    `UPDATE seat SET is_administration = true, tier = tier
      WHERE title = ANY($1::text[]) AND retired_at IS NULL AND NOT is_administration
      RETURNING seat_id, title`,
    [officePosts],
  );
  for (const row of ticked.rows) say(`  ${row.title} carries the administration tick`);

  const district = await pool.query(
    "SELECT count(*)::int AS n FROM seat WHERE tier = 'district' AND is_administration",
  );
  say(`  ${String(district.rows[0].n)} post(s) carry district authority`);

  if (district.rows[0].n === 0) {
    die(
      'no post carries district authority, so nobody can see Bajaur as a whole.\n' +
        '    The directory did not load, or the seed\u2019s office names have changed.',
    );
  }
} finally {
  await pool.end();
}
