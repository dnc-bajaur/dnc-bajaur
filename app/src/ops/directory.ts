/**
 * Loading the district directory — M0-51.
 *
 * The source is a list the district maintains: department/office, officer name,
 * designation, mobile number. Each row becomes a **seat** (the post), optionally held by a
 * **person** (whoever is in it today) — which is precisely the model ADR-0004 already
 * describes, so nothing new is invented to hold it.
 *
 * Three rules, and all three exist because a directory is where a system quietly starts
 * lying about the district:
 *
 * 1. **Nothing is inferred.** The department is the row's own "Department/Office" value,
 *    verbatim. Several of those are obviously posts within a larger body — `ADC (General)`
 *    sits under the DC Office, `DSP City` under the DPO — but *which* belongs to *what* is a
 *    fact about how Bajaur is organised, and this file is not the place to guess it. The
 *    grouping is Q-18.
 * 2. **A directory entry is not an account.** People are loaded with no password hash, which
 *    means they cannot sign in. The system needs to notify these officers; it has no mandate
 *    to create logins for people who have not been told it exists.
 * 3. **Conflicts are reported, never resolved.** The loader does not decide anything a human
 *    should. Where a resolution has been given it is honoured; where none has, the row is
 *    left out and named, because a directory that is confidently wrong is worse than one
 *    that is visibly incomplete.
 *
 * Two kinds of outcome, and the difference matters. A **problem** means a row did not load.
 * A **note** means it did, and somebody should still know — a shared handset is real and
 * ordinary here, and it is also the shape a transcription error takes, so it is never
 * silent.
 *
 * Idempotent: run it again after the district sends more rows and only the new ones land.
 */

import type { Pool } from '../db/pool.js';

export interface DirectoryRow {
  /** The "Department/Office" column, verbatim. */
  readonly department: string;
  /** The post. Falls back to the department name when the source leaves it blank. */
  readonly designation?: string;
  readonly name?: string;
  readonly phone?: string;
  /**
   * Ignored on load, and kept only so an existing seed file still parses.
   *
   * The source list has no tier column, so this defaulted every one of the district's 83
   * posts to `district` — which, with the old four-value ladder, let every department read
   * every other department's incidents. Tier is now derived from the department by a
   * database trigger (migration 0010) and is not a thing a seed file gets to state.
   */
  readonly tier?: string;
}

export interface DirectoryProblem {
  readonly row: DirectoryRow;
  readonly problem: string;
}

export interface DirectoryOutcome {
  readonly departments: number;
  readonly seats: number;
  readonly people: number;
  readonly assignments: number;
  /** Rows with **no officer named**. Loaded as a vacant post, and counted. */
  readonly vacant: number;
  /**
   * Rows where somebody **holds** the post and no number was recorded — ADR-0029 §3, CD-08.
   *
   * Counted apart from `vacant` because they are a different gap needing a different action:
   * a vacancy needs somebody appointed, this needs a telephone call. Conflating them is what
   * would have taken Rescue 1122's District Emergency Officer off the contact list.
   */
  readonly placeholders: number;
  /** Rows that could not be loaded without a guess. Never silently dropped. */
  readonly problems: readonly DirectoryProblem[];
  /**
   * Rows that **did** load but that somebody should still look at.
   *
   * A shared handset is ordinary in this district and is also exactly what a mistyped digit
   * looks like. Loading it and saying nothing would make the two indistinguishable.
   */
  readonly notes: readonly DirectoryProblem[];
}

/** A stable slug for a department name. Deterministic, so re-running matches what is there. */
export function codeFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Normalise a Pakistani mobile number to a comparable form.
 *
 * Only enough to spot that `0300 123 9000` and `03001239000` are the same number. It does
 * **not** try to validate: a number that looks wrong is still the number the district gave
 * us, and refusing it would lose a contact to satisfy a regex.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+92')) return `0${digits.slice(3)}`;
  if (digits.startsWith('92') && digits.length > 10) return `0${digits.slice(2)}`;
  return digits;
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim().length === 0;
}

/**
 * The stand-in number, for a post somebody holds and whose number was never recorded.
 *
 * Migration 0008's own value and its own reasoning: *"put 1111111 in and move on"* has a
 * failure mode this project exists to prevent — a fake number is indistinguishable from a real
 * one — so the number goes in **and the fact that it is a stand-in goes in beside it**. It is
 * never dialled, never messaged and never counted as reached, and the flag clears the moment
 * somebody types the real number over it.
 */
const PLACEHOLDER_NUMBER = '1111111';

/**
 * Load a directory into the database. Safe to run repeatedly.
 *
 * Returns what it did and what it refused to do. The caller is expected to look at
 * `problems` — a loader whose failures are only visible if someone reads the logs is the
 * same mistake as a notification with no delivery state (INV-03).
 */
export async function loadDirectory(
  pool: Pool,
  rows: readonly DirectoryRow[],
): Promise<DirectoryOutcome> {
  const problems: DirectoryProblem[] = [];
  const notes: DirectoryProblem[] = [];
  // ⚠️ ALWAYS ZERO SINCE ADR-0030, and reported rather than removed: the loader's own
  // summary is what somebody reads after running it, and a field that vanished would look like
  // the count going missing rather than the thing being counted.
  const departments = 0;
  let seats = 0;
  let people = 0;
  let assignments = 0;
  let vacant = 0;
  let placeholders = 0;

  // phone -> the name already attached to it, so a second, different name is caught.
  const phoneOwner = new Map<string, string>();

  for (const row of rows) {
    if (isBlank(row.department)) {
      problems.push({ row, problem: 'no department/office named' });
      continue;
    }

    /**
     * ADR-0030 — NO DEPARTMENT IS CREATED, and the seed's own column is read for one thing only.
     *
     * The loader used to write a department per distinct office name and file the post under it.
     * Counted off Bajaur's own directory that produced **79 departments for 81 posts** — 77 of
     * them holding one person, with a name that restated the designation — which is the finding
     * ADR-0029 rests on and the reason the layer is gone.
     *
     * ⚠️ **The column is still READ, because a blank designation needs a title from somewhere**
     * and the office name is the best description available. That is not the department coming
     * back: it is one string being used as a post's name, once, at load.
     */
    const departmentName = row.department.trim();

    const title = isBlank(row.designation) ? departmentName : row.designation!.trim();

    // ⚠️ A TITLE IS NOW UNIQUE ACROSS THE DISTRICT, matching what `createPost` enforces and what
    // the picker draws. Two offices that each had a "Duty Officer" used to be two posts; they
    // are one, and the second row loads onto it rather than creating a duplicate nobody could
    // tell apart on a flat list.
    const existingSeat = await pool.query<{ seat_id: string }>(
      'SELECT seat_id FROM seat WHERE title = $1',
      [title],
    );

    let seatId = existingSeat.rows[0]?.seat_id;
    if (seatId === undefined) {
      const created = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier) VALUES ($1, $2) RETURNING seat_id`,
        [title, row.tier ?? 'district'],
      );
      seatId = created.rows[0]!.seat_id;
      seats += 1;
    }

    /**
     * 🔴 **THESE ARE TWO DIFFERENT ROWS AND THIS TREATED THEM AS ONE — ADR-0029 §3, CD-08.**
     *
     * It was `isBlank(row.name) || isBlank(row.phone)`, so a post held by a **named officer
     * whose number was never recorded** loaded as a **vacancy**: no person, no duty assignment,
     * and the name thrown away. On Bajaur's own list that is four rows, and they are these —
     * Rescue 1122's District Emergency Officer, Civil Defence's CDO, DHQ Hospital's Associate
     * Director and SP Traffic.
     *
     * It looked harmless while nothing acted on a vacancy. **Migration 0038 retires every seat
     * nobody holds**, so it would have taken all four off the district's contact list — the
     * exact outcome ADR-0029 §3 was written to prevent, arriving one layer below where that
     * argument was made. `domain/recipients.ts` has separated `vacant` from `no_number` all
     * along; the loader never had.
     *
     * A post with nobody named is still a real and important state, not a broken row — the
     * escalation ladder and the notifier both surface a vacant seat rather than skipping it
     * (ADR-0004), so it still loads as exactly that.
     *
     * A post with somebody in it and no number loads **the person, on a placeholder**, which is
     * what migration 0008 exists for and what its own text names Rescue 1122 as the case for:
     * the post is filled and editable, the number is labelled a stand-in everywhere it appears,
     * and it is **never dialled, messaged or counted as reached**. Typing the real number over
     * it clears the flag.
     */
    if (isBlank(row.name)) {
      vacant += 1;
      continue;
    }

    // `isBlank` is not a type guard, so the assertion carries what the branch above proved —
    // the file's own existing convention rather than a new one.
    const fullName = row.name!.trim();
    const missingNumber = isBlank(row.phone);
    if (missingNumber) {
      placeholders += 1;
      notes.push({
        row,
        problem: `"${fullName}" holds this post and has no number on file — loaded on a stand-in, never dialled`,
      });
    }
    const phone = missingNumber ? PLACEHOLDER_NUMBER : normalisePhone(row.phone!);

    const owner = phoneOwner.get(phone);
    if (owner !== undefined && owner !== fullName) {
      // An office handset covering two posts, confirmed by the owner as ordinary here
      // (Q-19). Both officers load. It is still surfaced, because a mistyped digit produces
      // exactly this shape and the two are indistinguishable from the data alone.
      notes.push({
        row,
        problem: `phone ${phone} is also listed for "${owner}" — shared handset, both loaded`,
      });
    }
    // A stand-in is never counted as an owner: every placeholder shares one number by
    // construction, and treating that as a shared handset would raise a false note per row.
    if (!missingNumber) phoneOwner.set(phone, fullName);

    // Matched on name **and** number, not number alone. Since 0006 a number can belong to
    // more than one person, so looking up by phone would otherwise hand this row whichever
    // officer happened to be inserted first and quietly attach the post to them.
    const existingPerson = await pool.query<{ person_id: string }>(
      'SELECT person_id FROM person WHERE phone = $1 AND full_name = $2',
      [phone, fullName],
    );

    let personId = existingPerson.rows[0]?.person_id;
    if (personId === undefined) {
      // No password hash: a directory entry, not an account. See migration 0005.
      const created = await pool.query<{ person_id: string }>(
        'INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, $3) RETURNING person_id',
        [fullName, phone, missingNumber],
      );
      personId = created.rows[0]!.person_id;
      people += 1;
    }

    // One officer can hold several posts — the same ADC covers General and Relief, and one
    // XEN covers two canal divisions. The model allows it; the unique index only forbids two
    // people in one seat, which is the thing that would make "who do I notify" unanswerable.
    const held = await pool.query(
      'SELECT 1 FROM duty_assignment WHERE seat_id = $1 AND person_id = $2 AND to_at IS NULL',
      [seatId, personId],
    );

    if (held.rowCount === 0) {
      const occupied = await pool.query<{ person_id: string }>(
        'SELECT person_id FROM duty_assignment WHERE seat_id = $1 AND to_at IS NULL',
        [seatId],
      );

      if (occupied.rowCount !== 0) {
        problems.push({
          row,
          problem: `seat "${title}" is already held by someone else; a handover is a deliberate act, not an import`,
        });
        continue;
      }

      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        personId,
      ]);
      assignments += 1;
    }
  }

  return { departments, seats, people, assignments, vacant, placeholders, problems, notes };
}

export interface DepartmentSummary {
  readonly departmentId: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Every department, for turning ids into names on a screen.
 *
 * Returned as a map because callers are rendering a list and would otherwise query per row —
 * the same reason the incident detail endpoint returns an actor directory alongside events.
 */
export function departmentDirectory(
  _pool: Pool,
): Promise<Readonly<Record<string, DepartmentSummary>>> {
  /**
   * ⚠️ **ALWAYS EMPTY SINCE ADR-0030, AND IT TOUCHES NO DATABASE.** Migration 0039 dropped the
   * table, so this query would throw rather than return nothing.
   *
   * Its callers name department-kinded targets on the district's own past record, and every one
   * of them already handles a name it cannot find — a department could be retired from the
   * registry long before this. An empty map is a case they were written for.
   */
  return Promise.resolve({});
}
