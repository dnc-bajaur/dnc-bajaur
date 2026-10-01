/**
 * The roster: who holds which post in which department, and how to reach them.
 *
 * The system routes to a **post**, not a person (ADR-0004). "Rescue 1122 — District
 * Emergency Officer" exists whether or not anyone is sitting in it, and it survives every
 * transfer order. This module is what turns *tell the District Emergency Officer* into a
 * human with a number.
 *
 * Three rules run through everything here, and all three are the same rule:
 *
 * 1. **Nothing is deleted.** Posts retire, people are removed, assignments end. Past events
 *    name the seat that acted and the person who held it, and those must keep resolving
 *    (ADR-0001). A deleted post makes its own history unreadable.
 * 2. **A directory contact is not an account.** Adding somebody so the system can *notify*
 *    them is one act; giving them a *login* is a second, deliberate one. Creating a
 *    credential for a person who has never been told this system exists is a liability, not
 *    a convenience — a password nobody chose, on an account nobody watches.
 * 3. **Every change is recorded** in `config_event`, with a reason where it stops somebody
 *    being reachable. *Who took the duty officer off that post the week nobody answered?* is
 *    the question this table exists to answer.
 *
 * Scoping lives in `api/roster.ts`, not here. This is the store.
 */

import type { Pool, PoolClient } from 'pg';

import type { Uuid } from '../domain/events.js';
import { inTransaction, recordChange, type ConfigActor } from './configStore.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.js';

export type { Tier } from '../domain/authority.js';
import type { Tier } from '../domain/authority.js';

export interface RosterPerson {
  readonly personId: Uuid;
  readonly fullName: string;
  readonly phone: string;
  /** The number is a stand-in, not theirs. Never notified, always labelled (migration 0008). */
  readonly placeholder: boolean;
  /** They can sign in. A directory contact cannot, and most of the district's list cannot. */
  readonly hasAccount: boolean;
  readonly disabledAt: string | null;
}

export interface RosterPost {
  readonly seatId: Uuid;
  readonly title: string;
  readonly departmentId: Uuid | null;
  readonly tier: Tier;
  readonly retiredAt: string | null;
  /** Whoever holds it right now, or null. A null holder is a real operational gap. */
  readonly holder: RosterPerson | null;
  readonly heldSince: string | null;
}

export interface DepartmentRoster {
  /**
   * ⚠️ **NULL SINCE ADR-0030.** There is one roster and it is the district's, so there is no
   * department for it to belong to. Kept on the shape rather than removed, because the console
   * reads it and taking it off would put that edit inside this change rather than beside it.
   */
  readonly departmentId: Uuid | null;
  readonly departmentName: string;
  readonly posts: readonly RosterPost[];
  /** Live posts with nobody in them, or with a placeholder number. Nothing can reach these. */
  readonly unreachablePosts: number;
}

interface PostRow {
  seat_id: string;
  title: string;
  department_id: string | null;
  tier: Tier;
  retired_at: string | null;
  person_id: string | null;
  full_name: string | null;
  phone: string | null;
  placeholder: boolean | null;
  has_account: boolean | null;
  disabled_at: string | null;
  from_at: string | null;
}

function toPost(r: PostRow): RosterPost {
  return {
    seatId: r.seat_id,
    title: r.title,
    departmentId: r.department_id,
    tier: r.tier,
    retiredAt: r.retired_at,
    holder:
      r.person_id === null
        ? null
        : {
            personId: r.person_id,
            fullName: r.full_name ?? '',
            phone: r.phone ?? '',
            placeholder: r.placeholder === true,
            hasAccount: r.has_account === true,
            disabledAt: r.disabled_at,
          },
    heldSince: r.from_at,
  };
}

/**
 * The `has_account` column is derived, not stored.
 *
 * A person can authenticate exactly when they have a password hash — the same condition
 * `login()` filters on (migration 0006). Storing a second boolean beside it would create two
 * answers to "can this person sign in?", and they would disagree eventually.
 */
const POST_SELECT = `
  -- ADR-0030 — departmentId stays on the row as NULL so every screen reading a post keeps
  -- one shape. Nothing writes it, and there is no column left to read.
  SELECT s.seat_id, s.title, NULL::uuid AS department_id, s.tier, s.retired_at,
         p.person_id, p.full_name, p.phone, p.placeholder,
         (p.password_hash IS NOT NULL) AS has_account,
         p.disabled_at, d.from_at
    FROM seat s
    LEFT JOIN duty_assignment d
           ON d.seat_id = s.seat_id AND d.to_at IS NULL
    LEFT JOIN person p
           ON p.person_id = d.person_id AND p.removed_at IS NULL`;

export async function rosterFor(pool: Pool): Promise<DepartmentRoster> {
  /**
   * ⚠️ **THE WHOLE DISTRICT, SINCE ADR-0030 — this no longer narrows to one department.**
   *
   * It used to refuse with null for a department that did not exist, which is what the console
   * turned into a 404. Every id now names a department that does not exist, so refusing would
   * make the roster unreachable rather than unscoped — and there is exactly one roster to show.
   * ⚠️ **So the `null` came off the return type as well as out of the body**: leaving it would
   * have kept a 404 branch in the caller that nothing can reach, and an unreachable refusal is
   * how a screen ends up with a message nobody can explain.
   *
   * The name it returns is the district's, because that is whose list this is.
   */
  const { rows } = await pool.query<PostRow>(
    `${POST_SELECT}
      ORDER BY s.retired_at IS NOT NULL, s.title`,
  );

  const posts = rows.map(toPost);
  return {
    // ADR-0030 — there is one roster and it is the district's. `departmentId` stays on the shape
    // as null so the console's own rendering does not change in this commit; the NAME is what a
    // screen prints, and it now says whose list this actually is.
    departmentId: null,
    departmentName: 'District Bajaur',
    posts,
    // A post nothing can reach, counted the same way whether it is empty or holds a
    // stand-in number. Both mean the same thing on the night it matters, and the console
    // should not make an administrator work out that they are equivalent.
    unreachablePosts: posts.filter(
      (p) => p.retiredAt === null && (p.holder === null || p.holder.placeholder),
    ).length,
  };
}

/**
 * People who may be put into a post.
 *
 * ⚠️ **THE WHOLE DISTRICT SINCE ADR-0030.** It was *this department's own, plus anyone
 * unassigned* — a scope with no meaning once there is one list, and one whose column migration
 * 0039 dropped.
 */
export async function peopleFor(pool: Pool): Promise<readonly RosterPerson[]> {
  const { rows } = await pool.query<{
    person_id: string;
    full_name: string;
    phone: string;
    placeholder: boolean;
    has_account: boolean;
    disabled_at: string | null;
  }>(
    `SELECT DISTINCT p.person_id, p.full_name, p.phone, p.placeholder,
            (p.password_hash IS NOT NULL) AS has_account, p.disabled_at
       FROM person p
       JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
       JOIN seat s ON s.seat_id = d.seat_id
      WHERE p.removed_at IS NULL
      ORDER BY p.full_name`,
  );

  return rows.map((r) => ({
    personId: r.person_id,
    fullName: r.full_name,
    phone: r.phone,
    placeholder: r.placeholder,
    hasAccount: r.has_account,
    disabledAt: r.disabled_at,
  }));
}

/**
 * The post an officer is holding right now — the missing half of "who was told".
 *
 * **This exists because `seatId === null` was being read as a fact and is not one.** A dispatch
 * to a named officer carries `personId` and no seat (`domain/notifications.ts`), because the
 * control room chose *them*, not their post. Every acknowledgement path then bailed out on that
 * null with a comment about ADR-0004 — *a named officer holding no post has no post to take it
 * with* — which is the correct rule applied to the wrong question. The null did not mean **this
 * officer holds no post**; it meant **nobody looked**. After M10-07/08/09 made the person row the
 * only row a picker normally draws, that made the acknowledge button record nothing at all, on
 * essentially every dispatch in Bajaur.
 *
 * So the rule stays exactly as it was — acknowledgement is an act of a **post** — and this is
 * what lets it be asked properly. An officer who genuinely holds nothing still returns `null`
 * here and is still refused, which is `acknowledgement.test.ts`'s `seatlessPerson` case and is
 * the behaviour that was always right.
 *
 * ⚠️ **`ORDER BY d.from_at ASC LIMIT 1`, and the reason is on the record.** Three people in
 * Bajaur's live directory hold two posts at once (M10-05), so this query can honestly return more
 * than one row — the same trap `resolveIdentity` was fixed for on 2026-08-17, and deliberately
 * the same answer: the post held **longest** wins, deterministically. A stopgap rather than a
 * considered answer to *"which seat is this officer acting as right now"*, which belongs to
 * ADR-0004 and is not reopened here. Without the ordering, one officer's acknowledgement could
 * be attributed to a different one of their posts on each tap.
 *
 * A retired post is excluded: it cannot take an emergency, and attributing an acknowledgement to
 * one would put a live duty on a post the district has closed.
 */
export async function dutySeatOfPerson(pool: Pool, personId: Uuid): Promise<Uuid | null> {
  const { rows } = await pool.query<{ seat_id: string }>(
    `SELECT d.seat_id
       FROM duty_assignment d
       JOIN seat s ON s.seat_id = d.seat_id
      WHERE d.person_id = $1
        AND d.to_at IS NULL
        AND s.retired_at IS NULL
      ORDER BY d.from_at ASC
      LIMIT 1`,
    [personId],
  );
  return rows[0]?.seat_id ?? null;
}

//------------------------------------------------------------------------------
// Posts
//------------------------------------------------------------------------------

export type RosterResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

async function readPost(tx: PoolClient, seatId: Uuid): Promise<RosterPost | null> {
  const { rows } = await tx.query<PostRow>(`${POST_SELECT} WHERE s.seat_id = $1`, [seatId]);
  return rows[0] === undefined ? null : toPost(rows[0]);
}

export async function createPost(
  pool: Pool,
  title: string,
  tier: Tier,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    // ADR-0030 — there is no department to be missing or retired, so those two refusals go.

    const dup = await tx.query(
      'SELECT 1 FROM seat WHERE lower(title) = lower($1) AND retired_at IS NULL',
      [title],
    );
    if ((dup.rowCount ?? 0) > 0) {
      // ⚠️ A DESIGNATION IS NOW UNIQUE ACROSS THE DISTRICT, not within a department. Two live
      // posts with one title make "who do I notify" ambiguous in exactly the way
      // `duty_one_current_holder_per_seat` exists to prevent one level down — and the district's
      // own list is where that ambiguity actually bites, because the picker draws one flat list.
      return { ok: false as const, why: 'the district already has a post with that title' };
    }

    const { rows } = await tx.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass)
       VALUES ($1, $2, false) RETURNING seat_id`,
      [title, tier],
    );
    const post = (await readPost(tx, rows[0]!.seat_id))!;

    await recordChange(tx, {
      subject: 'seat',
      subjectId: post.seatId,
      action: 'created',
      // ⚠️ **`departmentId` came off the payload, and it is the one line here worth reading.**
      // It was still being written after ADR-0030 dropped the column — an id naming a row that
      // does not exist, recorded into the configuration log, which is the one place in this
      // system that is meant to be true forever. A dead field on a screen is a tidiness problem;
      // a dead field in the record is somebody in 2027 trying to resolve it.
      before: null,
      after: { title, tier },
      actor,
    });
    return { ok: true as const, value: post };
  });
}

export async function renamePost(
  pool: Pool,
  seatId: Uuid,
  title: string,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    const before = await readPost(tx, seatId);
    if (before === null) return { ok: false as const, why: 'no such post' };

    await tx.query('UPDATE seat SET title = $2 WHERE seat_id = $1', [seatId, title]);
    const after = (await readPost(tx, seatId))!;

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'updated',
      before: { title: before.title },
      after: { title },
      actor,
    });
    return { ok: true as const, value: after };
  });
}

/**
 * Retire a post, or bring one back.
 *
 * Retiring ends the current assignment too. A post that no longer exists cannot be held, and
 * leaving somebody attached to it would keep them in the notification path for work nobody
 * is meant to be doing — silently, which is the failure mode that matters.
 */
export async function setPostRetired(
  pool: Pool,
  seatId: Uuid,
  retired: boolean,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<RosterPost>> {
  return inTransaction(pool, async (tx) => {
    const before = await readPost(tx, seatId);
    if (before === null) return { ok: false as const, why: 'no such post' };

    await tx.query(
      `UPDATE seat SET retired_at = ${retired ? 'now()' : 'NULL'} WHERE seat_id = $1`,
      [seatId],
    );
    if (retired) {
      await tx.query(
        'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
        [seatId],
      );
    }

    const after = (await readPost(tx, seatId))!;
    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: retired ? 'retired' : 'restored',
      // Summarised, not the whole post. A `RosterPost` carries its holder's **phone number**,
      // and `config_event` is rendered on a screen and copied into every backup that leaves
      // the district. The person row is the one place a contact number needs to live — the
      // same rule `obs/log.ts` applies to log lines, one table over. A test pins it.
      before: { title: before.title, heldBy: before.holder?.fullName ?? null },
      after: { title: after.title, heldBy: after.holder?.fullName ?? null },
      actor,
      reason,
    });
    return { ok: true as const, value: after };
  });
}

//------------------------------------------------------------------------------
// People
//------------------------------------------------------------------------------

export interface NewPerson {
  readonly fullName: string;
  readonly phone: string;
  /** Mark the number as a stand-in. Filled post, no real contact (migration 0008). */
  readonly placeholder?: boolean;
}

/**
 * Add somebody to the directory, and optionally put them straight into a post.
 *
 * **No password.** They become someone the system can notify, not someone who can sign in;
 * see rule 2 in the header. `grantAccount` is the separate, deliberate second step.
 */
export async function addPerson(
  pool: Pool,
  input: NewPerson,
  seatId: Uuid | null,
  actor: ConfigActor,
): Promise<RosterResult<RosterPerson>> {
  return inTransaction(pool, async (tx) => {
    const fullName = input.fullName.trim();
    const phone = input.phone.trim();

    const { rows } = await tx.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder, created_by_seat_id)
       VALUES ($1, $2, $3, $4) RETURNING person_id`,
      [fullName, phone, input.placeholder === true, actor.seatId],
    );
    const personId = rows[0]!.person_id;

    if (seatId !== null) {
      const assigned = await assignWithin(tx, seatId, personId, actor);
      if (!assigned.ok) return assigned;
    }

    const person: RosterPerson = {
      personId,
      fullName,
      phone,
      placeholder: input.placeholder === true,
      hasAccount: false,
      disabledAt: null,
    };

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'created',
      before: null,
      // The number is deliberately not written into the log. `config_event` is read on a
      // screen and dumped in backups; the person row is the one place a contact number
      // needs to live, and `obs/log.ts` already refuses to let one reach a log line.
      after: { fullName, placeholder: input.placeholder === true },
      actor,
    });
    return { ok: true as const, value: person };
  });
}

export async function updatePerson(
  pool: Pool,
  personId: Uuid,
  edit: { readonly fullName?: string; readonly phone?: string },
  actor: ConfigActor,
): Promise<RosterResult<RosterPerson>> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{
      full_name: string;
      phone: string;
      placeholder: boolean;
      has_account: boolean;
      disabled_at: string | null;
    }>(
      `SELECT full_name, phone, placeholder, (password_hash IS NOT NULL) AS has_account, disabled_at
         FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE`,
      [personId],
    );
    const before = existing.rows[0];
    if (before === undefined) return { ok: false as const, why: 'no such person' };

    const fullName = edit.fullName?.trim() ?? before.full_name;
    const phone = edit.phone?.trim() ?? before.phone;

    // Typing a real number over a stand-in is how a placeholder is meant to end. Clearing
    // the flag here rather than requiring a second action means nobody has to remember —
    // and a placeholder nobody remembers to clear is a post that silently stops escalating.
    const stillPlaceholder = before.placeholder && phone === before.phone;

    await tx.query(
      'UPDATE person SET full_name = $2, phone = $3, placeholder = $4 WHERE person_id = $1',
      [personId, fullName, phone, stillPlaceholder],
    );

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'updated',
      before: { fullName: before.full_name, placeholder: before.placeholder },
      after: { fullName, placeholder: stillPlaceholder },
      actor,
    });

    return {
      ok: true as const,
      value: {
        personId,
        fullName,
        phone,
        placeholder: stillPlaceholder,
        hasAccount: before.has_account,
        disabledAt: before.disabled_at,
      },
    };
  });
}

/**
 * Remove somebody from the roster.
 *
 * Not a delete. They stop being offered as a contact and stop holding any post; every event
 * naming them still resolves to a name. An account, if they had one, is disabled and its
 * sessions are left to expire on their own short TTL.
 */
export async function removePerson(
  pool: Pool,
  personId: Uuid,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly removed: true }>> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{ full_name: string }>(
      'SELECT full_name FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE',
      [personId],
    );
    if (existing.rows[0] === undefined) return { ok: false as const, why: 'no such person' };

    await tx.query(
      'UPDATE person SET removed_at = now(), disabled_at = coalesce(disabled_at, now()) WHERE person_id = $1',
      [personId],
    );
    await tx.query(
      'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
      [personId],
    );
    await tx.query(
      'UPDATE session SET revoked_at = now() WHERE person_id = $1 AND revoked_at IS NULL',
      [personId],
    );

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'retired',
      before: { fullName: existing.rows[0].full_name },
      after: null,
      actor,
      reason,
    });
    return { ok: true as const, value: { removed: true } };
  });
}

/**
 * Give somebody a login.
 *
 * Separate from adding them, and it stays separate. The district's contact list is ~80
 * officials the system must be able to reach; that is not ~80 people who should have
 * credentials. Creating an account for someone who has not been told the system exists is a
 * password nobody chose on an account nobody watches.
 *
 * A shared office handset is fine for a contact and impossible for an account: migration
 * 0006 puts phone uniqueness only where a password hash exists, so this fails loudly at the
 * moment somebody tries — which is the right moment and the right person to tell.
 */
export async function grantAccount(
  pool: Pool,
  personId: Uuid,
  password: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly granted: true }>> {
  if (password.trim().length < MIN_PASSWORD_LENGTH) {
    return { ok: false, why: `a password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const hash = await hashPassword(password);

  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{ placeholder: boolean; full_name: string }>(
      'SELECT placeholder, full_name FROM person WHERE person_id = $1 AND removed_at IS NULL FOR UPDATE',
      [personId],
    );
    const person = existing.rows[0];
    if (person === undefined) return { ok: false as const, why: 'no such person' };

    if (person.placeholder) {
      // The number on this row is a stand-in. An account on it would be an account nobody
      // can be told about, reached at a number that is not theirs.
      return {
        ok: false as const,
        why: 'this person holds a placeholder number — enter their real number first',
      };
    }

    try {
      await tx.query(
        'UPDATE person SET password_hash = $2, disabled_at = NULL WHERE person_id = $1',
        [personId, hash],
      );
    } catch {
      return {
        ok: false as const,
        why: 'another account already uses this number — a shared handset cannot have two logins',
      };
    }

    await recordChange(tx, {
      subject: 'person',
      subjectId: personId,
      action: 'updated',
      before: { hasAccount: false },
      after: { hasAccount: true },
      actor,
    });
    return { ok: true as const, value: { granted: true } };
  });
}

//------------------------------------------------------------------------------
// Assignments
//------------------------------------------------------------------------------

async function assignWithin(
  tx: PoolClient,
  seatId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly assigned: true }>> {
  const seat = await tx.query<{ retired_at: string | null }>(
    'SELECT retired_at FROM seat WHERE seat_id = $1 FOR UPDATE',
    [seatId],
  );
  if (seat.rows[0] === undefined) return { ok: false, why: 'no such post' };
  if (seat.rows[0].retired_at !== null) return { ok: false, why: 'that post is retired' };

  // One holder per post, enforced by a unique index. Ending the previous assignment here
  // rather than failing is the honest reading of what an administrator means by "put this
  // person in that post": the handover is the point, and the outgoing holder's dates stay
  // in the record.
  await tx.query('UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL', [
    seatId,
  ]);
  await tx.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
    seatId,
    personId,
  ]);

  await recordChange(tx, {
    subject: 'duty',
    subjectId: seatId,
    action: 'updated',
    before: null,
    after: { seatId, personId },
    actor,
  });
  return { ok: true, value: { assigned: true } };
}

export async function assignToPost(
  pool: Pool,
  seatId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly assigned: true }>> {
  return inTransaction(pool, (tx) => assignWithin(tx, seatId, personId, actor));
}

/**
 * Take somebody out of a post without removing them from the district.
 *
 * A reason is required, and the database requires one too. This is the change most likely to
 * be asked about afterwards — *who took the duty officer off that post the week nobody
 * answered?* — and it leaves the post unreachable until somebody else is put in it.
 */
export async function relieveFromPost(
  pool: Pool,
  seatId: Uuid,
  reason: string,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly relieved: true }>> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
      [seatId],
    );
    if ((rowCount ?? 0) === 0)
      return { ok: false as const, why: 'nobody currently holds that post' };

    await recordChange(tx, {
      subject: 'duty',
      subjectId: seatId,
      action: 'retired',
      before: { seatId },
      after: null,
      actor,
      reason,
    });
    return { ok: true as const, value: { relieved: true } };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A contact — ADR-0029
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The district asked for one thing and said it plainly:
//
//   > "Mujhe simple phone ki tarha contact add karne ka option chahiye, jis mein main Name,
//   >  phone, post/designation de sakta hoon."
//
// Everything above this line reaches that through three operations — create a post inside a
// department, add a person, assign them to it — because the model was built for a district
// organised into departments. Bajaur is not: 79 departments held 81 posts, and 77 of them held
// exactly one person whose designation restated the department's name (ADR-0029 §2).
//
// So this is the district's operation, not a convenience wrapper over the other three. One
// transaction, three fields, `department_id` NULL. The functions above stay because the record
// they wrote is still read, and because a district that ever does reorganise into real
// departments gets them back without a migration.

export interface NewContact {
  readonly fullName: string;
  /** The post — "AC HQ Bajaur". Authority attaches here, not to the name (ADR-0004). */
  readonly designation: string;
  readonly phone: string;
  /**
   * The DC Office / AC Headquarter tick — ADR-0029 §2, and the only structure that survived the
   * removal.
   *
   * Deliberately a parameter and never inferred from `designation`. The district's own rule —
   * *"agar AC HQ likha hai to pata chal gaya ke administration hai"* — is exactly right for a
   * person reading the screen and unusable as an authorisation rule: an officer entered as
   * "AC HQ (acting)" would silently gain or lose the right to issue an advisory, and nothing on
   * any screen would show it.
   */
  readonly isAdministration?: boolean;
  /** Mark the number as a stand-in. Filled post, no real contact (migration 0008). */
  readonly placeholder?: boolean;
  /**
   * A `data:` URI photo, or null/absent for none — 2026-09-01, migration 0041.
   *
   * The server accepts and stores it; **no screen sets one yet** (the district asked for the
   * group photo first, and the contact admin tab needs rewiring before it can carry this). See
   * `backlog/for-the-owner.md`. Validated by `addContact` in `api/roster.ts`.
   */
  readonly picture?: string | null;
}

export interface Contact {
  readonly seatId: Uuid;
  readonly personId: Uuid;
  readonly fullName: string;
  readonly designation: string;
  readonly phone: string;
  readonly isAdministration: boolean;
  readonly picture: string | null;
}

/**
 * Add a contact. Name, designation, number — the whole of it.
 *
 * One transaction on purpose. Half of this succeeding leaves a post nobody holds, which is
 * precisely the vacancy the district has just asked to stop seeing.
 */
export async function createContact(
  pool: Pool,
  input: NewContact,
  actor: ConfigActor,
): Promise<RosterResult<Contact>> {
  const fullName = input.fullName.trim();
  const designation = input.designation.trim();
  const phone = input.phone.trim();

  if (fullName === '') return { ok: false as const, why: 'a contact needs a name' };
  if (designation === '') return { ok: false as const, why: 'a contact needs a designation' };

  return inTransaction(pool, async (tx) => {
    // The district's own rule, in their own words: a contact is blocked ONLY when the same
    // phone number is already on another live contact — never for sharing a designation. Two
    // contacts under one designation ("AC Salarzai" and "TMO Salarzai") are ordinary; two contacts
    // on one handset are almost always a mistyped digit. `phone = $1` catches an exact repeat
    // and the `right(..., 10)` clause catches `0300-1234567` vs `+92 300 1234567`.
    if (phone !== '') {
      const digits = phone.replace(/\D/g, '').slice(-10);
      // Only a LIVE contact claims a number, and the join is `listContacts`'s own — an open
      // `duty_assignment` to a seat still on the books. A `person` row with no such assignment
      // is not a contact: a removed contact whose row stays for the record (ADR-0001), a
      // sign-in account that never held a post (ADR-0032), a directory person parked without
      // one. "A contact with that phone number already exists" about one of those is the
      // district's own re-add bug — they delete a contact, or make themselves an account, and
      // then cannot add the matching contact back.
      const dupPhone = await tx.query(
        `SELECT 1
           FROM person p
           JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
           JOIN seat s ON s.seat_id = d.seat_id AND s.retired_at IS NULL
          WHERE p.removed_at IS NULL
            AND (p.phone = $1
                 OR (length(regexp_replace(p.phone, '\\D', '', 'g')) >= 10
                     AND right(regexp_replace(p.phone, '\\D', '', 'g'), 10) = $2))`,
        [phone, digits],
      );
      if ((dupPhone.rowCount ?? 0) > 0) {
        return { ok: false as const, why: 'a contact with that phone number already exists' };
      }
    }

    // `tier` is passed but not chosen: the trigger derives it from `is_administration` and
    // overwrites whatever arrives here. Written explicitly rather than defaulted so that reading
    // this does not suggest a caller has a say.
    const seat = await tx.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, 'post', false, $2) RETURNING seat_id`,
      [designation, input.isAdministration === true],
    );
    const seatId = seat.rows[0]!.seat_id as Uuid;

    const person = await tx.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder, created_by_seat_id, picture)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [fullName, phone, input.placeholder === true, actor.seatId, input.picture ?? null],
    );
    const personId = person.rows[0]!.person_id as Uuid;

    const assigned = await assignWithin(tx, seatId, personId, actor);
    if (!assigned.ok) return assigned;

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'created',
      before: null,
      // The number is not written into the log — `config_event` is read on a screen and dumped
      // in backups, and `obs/log.ts` already refuses to let a contact number reach a log line.
      after: { designation, fullName, isAdministration: input.isAdministration === true },
      actor,
    });

    return {
      ok: true as const,
      value: {
        seatId,
        personId,
        fullName,
        designation,
        phone,
        isAdministration: input.isAdministration === true,
        picture: input.picture ?? null,
      },
    };
  });
}

/**
 * Remove a contact — off every list, still in the record.
 *
 * "Delete" is what the district means and this is what they get: `retired_at IS NOT NULL` is
 * already filtered out of the directory, the picker, the roster and the escalation ladder. The
 * rows themselves stay, because past incidents name the seat they were sent to, and deleting
 * one would either break that reference or rewrite the record — which ADR-0001 does not permit.
 *
 * **Nobody is asked for a reason, and the record still carries one.** Those are two different
 * statements and the database insisted on the second: migration 0007's
 * `config_event_retire_needs_reason` refuses a `retired` config row that does not say why, and
 * the first version of this function produced a **500** on its own test for exactly that. The
 * same constraint caught `clearSlaTarget` in August.
 *
 * The guarantee that CHECK exists for is that stopping something reaching a department can never
 * happen anonymously — and it does not: `recordChange` writes the actor, so who did it is on the
 * record whatever the sentence says. What is deliberately not extracted is a **typed
 * justification from an operator**, because `relieveFromPost` needs one (taking somebody off a
 * post while the post remains is a thing that gets asked about afterwards) and this does not:
 * removing a contact is the district maintaining their own phone book, and a box demanding
 * *why* on every removal is how a phone book stops being maintained — it fills up with "wrong",
 * and then there is no reason on the record either.
 *
 * So the reason states the act. That is honest, it satisfies the constraint rather than routing
 * around it, and the actor beside it is what actually answers *who*.
 *
 * The seat is retired and its holder is marked `removed_at` (when they hold no other live seat).
 * The `person` row stays for the same reason the `seat` row does — past incidents name it — but
 * without `removed_at` its phone number goes on counting as taken, and `createContact` would
 * then refuse the same contact for ever.
 */
const REMOVAL_REASON = 'removed from the district contact list';
export async function removeContact(
  pool: Pool,
  seatId: Uuid,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly removed: true }>> {
  return inTransaction(pool, async (tx) => {
    const before = await readPost(tx, seatId);
    if (before === null) return { ok: false as const, why: 'no such contact' };
    if (before.retiredAt !== null) {
      return { ok: false as const, why: 'that contact is already removed' };
    }

    // Who holds this contact-seat right now. A contact is a post AND its one holder, created
    // together in `createContact` (ADR-0029) — so removing the contact has to retire the person
    // too. Leave `person.removed_at` NULL and the number stays claimed by a contact that is off
    // every screen: `createContact`'s phone-duplicate check reads `WHERE removed_at IS NULL`, so
    // the same contact can never be re-added. The district reported exactly that.
    const holders = await tx.query<{ person_id: string }>(
      'SELECT person_id FROM duty_assignment WHERE seat_id = $1 AND to_at IS NULL',
      [seatId],
    );

    await tx.query(
      'UPDATE duty_assignment SET to_at = now() WHERE seat_id = $1 AND to_at IS NULL',
      [seatId],
    );
    await tx.query('UPDATE seat SET retired_at = now() WHERE seat_id = $1', [seatId]);

    // Retire the holder only when they hold no OTHER live seat — the flat directory has one
    // holder per post, but a person assigned to two must not be removed out from under the
    // second. Same shape as `removePerson`: `removed_at` marks the record, `disabled_at` stops
    // any login the row might carry.
    for (const { person_id } of holders.rows) {
      const elsewhere = await tx.query(
        'SELECT 1 FROM duty_assignment WHERE person_id = $1 AND to_at IS NULL LIMIT 1',
        [person_id],
      );
      if ((elsewhere.rowCount ?? 0) === 0) {
        await tx.query(
          `UPDATE person SET removed_at = now(), disabled_at = coalesce(disabled_at, now())
            WHERE person_id = $1 AND removed_at IS NULL`,
          [person_id],
        );
      }
    }

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'retired',
      before: { title: before.title },
      after: null,
      actor,
      reason: REMOVAL_REASON,
    });
    return { ok: true as const, value: { removed: true } };
  });
}

/**
 * Tick or untick the DC Office / AC Headquarter box.
 *
 * 🔴 **This is the whole authority model in one boolean** (ADR-0029 §2). Untick every contact
 * and nobody can issue an advisory, edit the directory or maintain a group — so this refuses to
 * remove the last one. The refusal is here, in a single-row update, and *not* in migration 0038:
 * a guard that can only speak by killing the service is O-40's outage, and one that answers an
 * HTTP request is just an error message.
 */
export async function setContactAdministration(
  pool: Pool,
  seatId: Uuid,
  on: boolean,
  actor: ConfigActor,
): Promise<RosterResult<{ readonly isAdministration: boolean }>> {
  return inTransaction(pool, async (tx) => {
    const before = await tx.query<{ is_administration: boolean }>(
      'SELECT is_administration FROM seat WHERE seat_id = $1 AND retired_at IS NULL FOR UPDATE',
      [seatId],
    );
    if (before.rows[0] === undefined) return { ok: false as const, why: 'no such contact' };
    if (before.rows[0].is_administration === on) {
      return { ok: true as const, value: { isAdministration: on } };
    }

    if (!on) {
      const others = await tx.query(
        `SELECT 1 FROM seat
          WHERE is_administration AND retired_at IS NULL AND seat_id <> $1
          LIMIT 1`,
        [seatId],
      );
      if ((others.rowCount ?? 0) === 0) {
        return {
          ok: false as const,
          why: 'this is the last contact marked as the administration — tick another one first, or nobody will be able to issue an advisory',
        };
      }
    }

    await tx.query('UPDATE seat SET is_administration = $2 WHERE seat_id = $1', [seatId, on]);

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'updated',
      before: { isAdministration: !on },
      after: { isAdministration: on },
      actor,
    });
    return { ok: true as const, value: { isAdministration: on } };
  });
}

/**
 * Every contact, in one flat list — the district's phone book.
 *
 * No grouping, no department header, no tree. 47 rows sorted by designation, which is what
 * ADR-0029 asked for and what `listRecipients` has already drawn since ADR-0023.
 *
 * Retired contacts are absent rather than greyed: the district asked for removal to mean
 * removal, and a list that still shows what was deleted is a list somebody stops trusting.
 */
export async function listContacts(pool: Pool): Promise<readonly Contact[]> {
  const { rows } = await pool.query<{
    seat_id: string;
    person_id: string | null;
    full_name: string | null;
    phone: string | null;
    picture: string | null;
    title: string;
    is_administration: boolean;
  }>(
    `SELECT s.seat_id, s.title, s.is_administration,
            p.person_id, p.full_name, p.phone, p.picture
       FROM seat s
       LEFT JOIN duty_assignment d ON d.seat_id = s.seat_id AND d.to_at IS NULL
       LEFT JOIN person p ON p.person_id = d.person_id AND p.removed_at IS NULL
      WHERE s.retired_at IS NULL
      ORDER BY s.is_administration DESC, s.title`,
  );

  // A row whose holder has gone is not returned. Migration 0038 retired every seat nobody
  // held, so this can only happen to a contact whose person was removed afterwards — and the
  // district's instruction covers that case identically: no holder, no contact.
  return rows
    .filter((r) => r.person_id !== null)
    .map((r) => ({
      seatId: r.seat_id as Uuid,
      personId: r.person_id as Uuid,
      fullName: r.full_name ?? '',
      designation: r.title,
      phone: r.phone ?? '',
      isAdministration: r.is_administration,
      picture: r.picture,
    }));
}

/**
 * Edit a contact — any of the three fields, in one call.
 *
 * The name and number live on `person`, the designation on `seat`, and the district does not
 * know that and should not have to. One screen, one save, one transaction.
 */
export async function updateContact(
  pool: Pool,
  seatId: Uuid,
  edit: {
    readonly fullName?: string;
    readonly designation?: string;
    readonly phone?: string;
    /** `undefined` leaves the photo alone; `null` clears it; a `data:` URI sets it. Validated upstream. */
    readonly picture?: string | null;
  },
  actor: ConfigActor,
): Promise<RosterResult<Contact>> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{
      title: string;
      is_administration: boolean;
      person_id: string | null;
      full_name: string | null;
      phone: string | null;
      placeholder: boolean | null;
      picture: string | null;
    }>(
      `SELECT s.title, s.is_administration, p.person_id, p.full_name, p.phone, p.placeholder, p.picture
         FROM seat s
         LEFT JOIN duty_assignment d ON d.seat_id = s.seat_id AND d.to_at IS NULL
         LEFT JOIN person p ON p.person_id = d.person_id AND p.removed_at IS NULL
        WHERE s.seat_id = $1 AND s.retired_at IS NULL
        FOR UPDATE OF s`,
      [seatId],
    );
    const before = existing.rows[0];
    if (before === undefined) return { ok: false as const, why: 'no such contact' };
    if (before.person_id === null) return { ok: false as const, why: 'nobody holds that contact' };

    const designation = edit.designation?.trim() ?? before.title;
    const fullName = edit.fullName?.trim() ?? before.full_name ?? '';
    const phone = edit.phone?.trim() ?? before.phone ?? '';

    if (designation === '') return { ok: false as const, why: 'a contact needs a designation' };
    if (fullName === '') return { ok: false as const, why: 'a contact needs a name' };

    // Every refusal comes BEFORE any write — `inTransaction` commits whatever the callback
    // returns and only rolls back on a throw, so a `return { ok: false }` after `UPDATE seat`
    // would rename the contact and still report failure.
    if (phone !== '' && phone !== (before.phone ?? '')) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      // Same rule as `createContact`: only a person holding a live, non-retired seat counts as
      // a contact whose number is taken. An account or a removed contact on that number is not.
      const dupPhone = await tx.query(
        `SELECT 1
           FROM person p
           JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
           JOIN seat s ON s.seat_id = d.seat_id AND s.retired_at IS NULL
          WHERE p.removed_at IS NULL
            AND p.person_id <> $3
            AND (p.phone = $1
                 OR (length(regexp_replace(p.phone, '\\D', '', 'g')) >= 10
                     AND right(regexp_replace(p.phone, '\\D', '', 'g'), 10) = $2))`,
        [phone, digits, before.person_id],
      );
      if ((dupPhone.rowCount ?? 0) > 0) {
        return { ok: false as const, why: 'a contact with that phone number already exists' };
      }
    }

    if (designation.toLowerCase() !== before.title.toLowerCase()) {
      // No designation-duplicate check — the district allows any number of contacts under one
      // designation (see `createContact`). Only the phone is unique.
      await tx.query('UPDATE seat SET title = $2 WHERE seat_id = $1', [seatId, designation]);
    }

    // Typing a real number over a stand-in is how a placeholder is meant to end — the same
    // rule `updatePerson` applies, and for the same reason: a placeholder nobody remembers to
    // clear is a post that silently stops escalating.
    const stillPlaceholder = before.placeholder === true && phone === before.phone;
    const picture = edit.picture === undefined ? before.picture : edit.picture;

    await tx.query(
      'UPDATE person SET full_name = $2, phone = $3, placeholder = $4, picture = $5 WHERE person_id = $1',
      [before.person_id, fullName, phone, stillPlaceholder, picture],
    );

    await recordChange(tx, {
      subject: 'seat',
      subjectId: seatId,
      action: 'updated',
      // The number is deliberately absent from both sides. `config_event` is read on a screen
      // and dumped in backups, and a diff is not a good enough reason to put a personal mobile
      // in either.
      before: { designation: before.title, fullName: before.full_name },
      after: { designation, fullName },
      actor,
    });

    return {
      ok: true as const,
      value: {
        seatId,
        personId: before.person_id as Uuid,
        fullName,
        designation,
        phone,
        isAdministration: before.is_administration,
        picture,
      },
    };
  });
}
