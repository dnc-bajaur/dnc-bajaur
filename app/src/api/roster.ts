/**
 * The roster over HTTP — M1a-10.
 *
 * **One set of endpoints, two audiences.** The DC and AC Headquarter offices maintain every
 * department's roster; a department maintains its own. Same operations, same screen, scoped
 * by the caller's department. Owner, 2026-08-02:
 *
 *   > department ki data sai mera matlab ye hai wo apne dashboard pr data edit kr ske, yaane
 *   > k kese ko add kar ske, remove kar ske, data daik ske… ye mera matlab nhe hai k ju
 *   > signals 2 offices assign karenge us edit kr skenge.
 *
 * So the split is exact, and it is the whole design of this file:
 *
 * | | Two offices | A department |
 * |---|---|---|
 * | Its own people and posts | yes, for all | **yes** |
 * | Another department's roster | yes | no |
 * | Routing signals, SLA deadlines | yes | **no** |
 * | Creating or retiring departments | yes | no |
 *
 * Routing signals stay with the administration for a reason worth restating: a department
 * able to edit its own routing could quietly remove the signal that sends it night-time fire
 * calls, and nothing on any screen would show that it had happened.
 *
 * Every scoping decision goes through `mayEditRoster`. One function to audit, and an endpoint
 * added without calling it fails closed rather than opening a hole (INV-05).
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import type { Uuid } from '../domain/events.js';
import {
  addPerson,
  assignToPost,
  createPost,
  // ADR-0029 — a contact belongs to no department, so these take no department id.
  createContact,
  listContacts,
  updateContact,
  removeContact,
  setContactAdministration,
  type Contact,
  grantAccount,
  peopleFor,
  relieveFromPost,
  removePerson,
  renamePost,
  rosterFor,
  setPostRetired,
  updatePerson,
  type DepartmentRoster,
  type RosterPerson,
  type RosterPost,
  type RosterResult,
  type Tier,
} from '../db/rosterStore.js';
import type { AdminResult } from './admin.js';
import { validatePicture } from '../domain/picture.js';

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

/**
 * May this caller touch this department's roster?
 *
 * Two ways in, and no third: you are the administration, or it is your own department.
 *
 * **403, not 404.** Unlike an incident, a department's existence is not sensitive — every
 * officer in Bajaur knows the other departments exist. Pretending otherwise would turn a
 * legitimate configuration problem, like being between postings, into what looks like a
 * broken link at the moment somebody is trying to fix something.
 */
// ⚠️ `reach(identity, departmentId)` is gone — ADR-0031, phase 4. It had been a shim over
// `mayEditRoster` since ADR-0030, `void`ing the department id it was handed. `resources.ts` — its
// only caller — now asks `mayEditRoster` directly, which is the one gate the whole roster uses.

/**
 * May this seat edit the roster at all?
 *
 * ⚠️ **Not a weaker gate than the old `reach`.** Since ADR-0024 there has been exactly one way
 * through — *you are the administration* — and ADR-0030 removed the parameter it was ignoring
 * to reach that answer. This is the same rule with the dead argument gone.
 */
export function mayEditRoster<T>(identity: Identity): AdminResult<T> | null {
  if (identity.isAdministration) return null;

  return refuse(403, 'only the DC Office and the AC Headquarter Bajaur Office may edit the roster');
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function isTier(v: unknown): v is Tier {
  return v === 'post' || v === 'district';
}

/** Turn a store refusal into an HTTP one. 409: well-formed request, state disagrees. */
function settle<T>(result: RosterResult<T>): AdminResult<T> {
  return result.ok ? { ok: true, value: result.value } : refuse(409, result.why);
}

//------------------------------------------------------------------------------
// Reading
//------------------------------------------------------------------------------

export interface RosterView extends DepartmentRoster {
  /** Whether this caller may change it, so the screen can render read-only honestly. */
  readonly editable: boolean;
  readonly people: readonly RosterPerson[];
}

export async function readRoster(pool: Pool, identity: Identity): Promise<AdminResult<RosterView>> {
  /**
   * 🔴 **THE GATE IS IN FRONT OF THE LOOKUP.**
   *
   * It used to resolve *"which department is this about"* first and answer **404** when the
   * caller had none of their own — which after ADR-0030 is **every caller**, because no seat
   * belongs to a department any more. A department officer asking for a roster they may not
   * have was being told *"there is nothing here"* instead of *"you may not"*, and the two are
   * not interchangeable: one sends somebody looking for a broken link, the other tells them
   * the truth about their own authority.
   *
   * ⚠️ ADR-0031 phase 3 dropped the `departmentId` parameter and the `/roster/:dept` route
   * with it — there is one roster and it is the district's.
   */
  const denied = mayEditRoster<RosterView>(identity);
  if (denied !== null) return denied;

  const roster = await rosterFor(pool);

  return { ok: true, value: { ...roster, editable: true, people: await peopleFor(pool) } };
}

//------------------------------------------------------------------------------
// Posts
//------------------------------------------------------------------------------

export async function addPost(
  pool: Pool,
  identity: Identity,
  input: { readonly title?: unknown; readonly tier?: unknown },
): Promise<AdminResult<RosterPost>> {
  // ADR-0031 phase 3: no `departmentId` and no `/roster/:dept/posts` — `POST /roster/posts`
  // is flat, because a seat belongs to no department.
  const denied = mayEditRoster<RosterPost>(identity);
  if (denied !== null) return denied;

  const title = text(input.title);
  if (title === undefined) return refuse(400, 'a designation needs a title');
  if (title.length > 200) return refuse(400, 'that title is too long');

  // Tier is not really a parameter any more.
  //
  // Migration 0042 derives it at the database from `seat.is_administration` — the post's own
  // tick — because a tier that can drift out of step with that column is a silent widening of
  // who may read what. The check below therefore refuses an impossible request rather than
  // guarding the write: asking for a district post is asking to see every incident in Bajaur, and
  // it should be told no rather than quietly given something else.
  //
  // ⚠️ **A POST ADDED HERE IS ALWAYS AN ORDINARY POST, INCLUDING FOR THE DC.** Nothing on this
  // route ticks `is_administration`, so nothing on it can produce a district-tier post. That is
  // deliberate and it is the safer half of ADR-0031: the tick is now the only thing standing
  // between a designation and sight of every incident in the district, and it is granted on the
  // contact screen, deliberately, one row at a time — never as a side effect of where a post
  // was filed.
  if (!identity.isAdministration && isTier(input.tier) && input.tier !== 'post') {
    return refuse(
      403,
      'only the DC Office and the AC Headquarter Office hold district-tier designations (ADR-0010)',
    );
  }
  const tier: Tier = 'post';

  return settle(await createPost(pool, title, tier, actorOf(identity)));
}

export async function editPost(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  input: { readonly title?: unknown },
): Promise<AdminResult<RosterPost>> {
  const denied = mayEditRoster<RosterPost>(identity);
  if (denied !== null) return denied;
  if (!(await postExists(pool, seatId))) return refuse(404, 'no such designation');

  const title = text(input.title);
  if (title === undefined) return refuse(400, 'a designation cannot be renamed to nothing');

  return settle(await renamePost(pool, seatId, title, actorOf(identity)));
}

export async function retirePost(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  retired: boolean,
  reason: unknown,
): Promise<AdminResult<RosterPost>> {
  const denied = mayEditRoster<RosterPost>(identity);
  if (denied !== null) return denied;
  if (!(await postExists(pool, seatId))) return refuse(404, 'no such post');

  const why = text(reason);
  if (why === undefined) {
    return refuse(400, retired ? 'say why this post is being retired' : 'say why it is returning');
  }

  return settle(await setPostRetired(pool, seatId, retired, why, actorOf(identity)));
}

//------------------------------------------------------------------------------
// People
//------------------------------------------------------------------------------

export async function addRosterPerson(
  pool: Pool,
  identity: Identity,
  input: {
    readonly fullName?: unknown;
    readonly phone?: unknown;
    readonly seatId?: unknown;
    readonly placeholder?: unknown;
  },
): Promise<AdminResult<RosterPerson>> {
  // ADR-0031 phase 3: flat `POST /roster/people`, no `departmentId` — see `addPost`.
  const denied = mayEditRoster<RosterPerson>(identity);
  if (denied !== null) return denied;

  const fullName = text(input.fullName);
  if (fullName === undefined) return refuse(400, 'a person needs a name');

  const phone = text(input.phone);
  if (phone === undefined) {
    return refuse(400, 'a person needs a number — mark it as a placeholder if it is a stand-in');
  }

  // Putting them into a post is optional, and if a post is named it has to be a real one.
  //
  // ⚠️ **This used to check that the post was in the CALLER'S department**, which is what
  // stopped a department staffing somebody else's post from its own screen. That rule went with
  // ADR-0024 — no department holds a seat, and since 2026-08-22 no department holds an account
  // either, so the only caller who reaches this line is the administration and every post is
  // already theirs. What remains is the half that was never about scoping: **a post that does
  // not exist must not come back as a silent success.** Dropping the check entirely would have
  // let a mistyped id create a person attached to nothing, and the roster screen would have
  // shown them unassigned with no explanation of why.
  let seatId: Uuid | null = null;
  if (typeof input.seatId === 'string') {
    if (!(await postExists(pool, input.seatId))) return refuse(400, 'no such post');
    seatId = input.seatId;
  }

  return settle(
    await addPerson(
      pool,
      { fullName, phone, placeholder: input.placeholder === true },
      seatId,
      actorOf(identity),
    ),
  );
}

export async function editRosterPerson(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  input: { readonly fullName?: unknown; readonly phone?: unknown },
): Promise<AdminResult<RosterPerson>> {
  const denied = await reachPerson<RosterPerson>(pool, identity, personId);
  if (denied !== null) return denied;

  return settle(
    await updatePerson(
      pool,
      personId,
      {
        ...(text(input.fullName) !== undefined ? { fullName: text(input.fullName)! } : {}),
        ...(text(input.phone) !== undefined ? { phone: text(input.phone)! } : {}),
      },
      actorOf(identity),
    ),
  );
}

export async function removeRosterPerson(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  reason: unknown,
): Promise<AdminResult<{ readonly removed: true }>> {
  const denied = await reachPerson<{ readonly removed: true }>(pool, identity, personId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why they are being removed');

  // Removing yourself would end your own session mid-request and, for the last
  // administrator, leave the district with nobody able to undo it.
  if (personId === identity.personId) {
    return refuse(409, 'you cannot remove yourself — ask the other office to do it');
  }

  return settle(await removePerson(pool, personId, why, actorOf(identity)));
}

export async function grantRosterAccount(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
  input: { readonly password?: unknown },
): Promise<AdminResult<{ readonly granted: true }>> {
  const denied = await reachPerson<{ readonly granted: true }>(pool, identity, personId);
  if (denied !== null) return denied;

  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return refuse(400, `a password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  return settle(await grantAccount(pool, personId, password, actorOf(identity)));
}

//------------------------------------------------------------------------------
// Assignments
//------------------------------------------------------------------------------

export async function assign(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  input: { readonly personId?: unknown },
): Promise<AdminResult<{ readonly assigned: true }>> {
  const denied = mayEditRoster<{ readonly assigned: true }>(identity);
  if (denied !== null) return denied;
  if (!(await postExists(pool, seatId))) return refuse(404, 'no such post');

  if (typeof input.personId !== 'string') return refuse(400, 'name the person to put in the post');

  return settle(await assignToPost(pool, seatId, input.personId, actorOf(identity)));
}

export async function relieve(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  reason: unknown,
): Promise<AdminResult<{ readonly relieved: true }>> {
  const denied = mayEditRoster<{ readonly relieved: true }>(identity);
  if (denied !== null) return denied;
  if (!(await postExists(pool, seatId))) return refuse(404, 'no such post');

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why they are being taken off this post');

  return settle(await relieveFromPost(pool, seatId, why, actorOf(identity)));
}

//------------------------------------------------------------------------------

function actorOf(identity: Identity): { seatId: string | null; personId: string | null } {
  return { seatId: identity.seatId, personId: identity.personId };
}

/**
 * Does this post exist?
 *
 * 🔴 **THIS WAS `departmentOfSeat`, AND IT WAS THROWING ON EVERY ROSTER WRITE.** It selected
 * `seat.department_id`, which migration 0039 dropped — so assign, relieve, retire, rename and
 * *add a person to a post* each answered **500** in production, from a query nothing on any
 * screen mentioned. Two questions were riding on one lookup: *whose is this* and *is this real*.
 * ADR-0030 answered the first permanently — every post is the district's — and left the second,
 * which is the one the 404 was always for.
 *
 * ⚠️ Retired posts count as existing. A retired post is still a real row that can be renamed,
 * restored, and reasoned about; *"no such post"* for one would be a lie, and it is the
 * distinction that lets a retirement be undone.
 */
async function postExists(pool: Pool, seatId: Uuid): Promise<boolean> {
  const { rowCount } = await pool.query('SELECT 1 FROM seat WHERE seat_id = $1', [seatId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Scope a person to a department.
 *
 * Two ways a person belongs to a department, and the second one is not obvious:
 *
 * 1. **They hold a post in it.** The ordinary case.
 * 2. **A seat in it created them, and they hold no post anywhere.** Adding a contact and
 *    assigning them to a post are separate acts, deliberately — a department needs to record
 *    somebody before deciding which post they will hold, and it must be able to correct a
 *    mistyped number in between. Without this, a department could create a person and then
 *    immediately be locked out of the row it had just written.
 *
 * The moment somebody holds a post in **another** department, that department owns them and
 * this returns 403 — which is the case worth protecting: an officer who has transferred out
 * must not still have their number editable by the department they left.
 */
async function reachPerson<T>(
  pool: Pool,
  identity: Identity,
  personId: Uuid,
): Promise<AdminResult<T> | null> {
  if (identity.isAdministration) return null;

  /**
   * 🔴 **A DEPARTMENT NO LONGER REACHES ITS OWN PEOPLE — 2026-08-22, and this one granted
   * ACCOUNTS.**
   *
   * The three-way query this replaces let a department seat edit, remove and — through
   * `grantRosterAccount` — **give a login to** anybody holding a post in its own department, or
   * anybody it had created who held none. That was `D-02`, decided on the reasoning that routing
   * every account request through the DC office does not scale and ends in shared passwords.
   *
   * The district reversed it: *"department ko koi access nahi milne wala hai, un ka koi account
   * nahi banega, software mein sirf wahi users hain jo abhi hain ya future mein add karenge."*
   *
   * ⚠️ **It was the most consequential of the department gates**, because it was self-propagating:
   * one department account could mint more, and each of those could mint more again — so the rule
   * that no department holds an account could not be enforced by simply not issuing the first one.
   *
   * The `pool` and `personId` parameters stay: the signature is what every caller in this file
   * awaits, and every one of them still needs the refusal to arrive the same way.
   */
  void pool;
  void personId;

  return refuse(403, 'only the DC Office and the AC Headquarter Bajaur Office may edit the roster');
}

//------------------------------------------------------------------------------
// Contacts — ADR-0029
//------------------------------------------------------------------------------
//
// The district's own phone book. Name, designation, number; add one, edit one, remove one.
//
// These sit beside the post and person endpoints rather than replacing them, because the
// record those wrote is still read and a district that reorganises into real departments gets
// them back without a migration. What is different here is that **a contact belongs to no
// department**, so none of this can go through `reach` — there is no department id to pass it.

/**
 * May this caller maintain the contact list?
 *
 * The same answer `reach` gives, asked without a department. Since ADR-0024 `reach` has had
 * exactly one way through — *you are the administration* — so this is not a weaker gate, it is
 * the same gate with the dead parameter removed.
 *
 * One function, so an endpoint added without calling it fails closed rather than opening a
 * hole (INV-05).
 */
export function reachContacts<T>(identity: Identity): AdminResult<T> | null {
  if (identity.isAdministration) return null;
  return refuse(
    403,
    'only the DC Office and the AC Headquarter Bajaur Office may edit the contact list',
  );
}

export async function readContacts(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<{ readonly contacts: readonly Contact[]; readonly editable: boolean }>> {
  // Reading is not gated on administration. Everybody signed in is the control room (ADR-0018,
  // ADR-0024) and the list of who to ring is the thing they signed in to use; `editable` is
  // what the screen renders read-only from, so the two questions stay separate.
  return {
    ok: true,
    value: { contacts: await listContacts(pool), editable: identity.isAdministration },
  };
}

export async function addContact(
  pool: Pool,
  identity: Identity,
  input: {
    readonly fullName?: unknown;
    readonly designation?: unknown;
    readonly phone?: unknown;
    readonly isAdministration?: unknown;
    readonly picture?: unknown;
  },
): Promise<AdminResult<Contact>> {
  const denied = reachContacts<Contact>(identity);
  if (denied !== null) return denied;

  const fullName = text(input.fullName);
  const designation = text(input.designation);
  const phone = text(input.phone);

  if (fullName === undefined) return refuse(400, 'a contact needs a name');
  if (designation === undefined) return refuse(400, 'a contact needs a designation');
  if (phone === undefined) {
    // Not a vacancy. A contact with no number is R-01's four officers, and they exist because
    // somebody could not find the number — never because a form let it through empty.
    return refuse(400, 'a contact needs a number — if you do not have it yet, do not add them');
  }
  if (designation.length > 200) return refuse(400, 'that designation is too long');
  if (fullName.length > 200) return refuse(400, 'that name is too long');

  let picture: string | null = null;
  if ('picture' in input) {
    const judged = validatePicture(input.picture);
    if (!judged.ok) return refuse(400, judged.why);
    picture = judged.value;
  }

  return settle(
    await createContact(
      pool,
      { fullName, designation, phone, isAdministration: input.isAdministration === true, picture },
      actorOf(identity),
    ),
  );
}

export async function editContact(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  input: {
    readonly fullName?: unknown;
    readonly designation?: unknown;
    readonly phone?: unknown;
    readonly picture?: unknown;
  },
): Promise<AdminResult<Contact>> {
  const denied = reachContacts<Contact>(identity);
  if (denied !== null) return denied;

  const edit: { fullName?: string; designation?: string; phone?: string; picture?: string | null } =
    {};
  const fullName = text(input.fullName);
  const designation = text(input.designation);
  const phone = text(input.phone);
  if (fullName !== undefined) edit.fullName = fullName;
  if (designation !== undefined) edit.designation = designation;
  if (phone !== undefined) edit.phone = phone;
  if ('picture' in input) {
    const judged = validatePicture(input.picture);
    if (!judged.ok) return refuse(400, judged.why);
    edit.picture = judged.value;
  }

  if (Object.keys(edit).length === 0) return refuse(400, 'nothing to change');

  return settle(await updateContact(pool, seatId, edit, actorOf(identity)));
}

export async function deleteContact(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
): Promise<AdminResult<{ readonly removed: true }>> {
  const denied = reachContacts<{ readonly removed: true }>(identity);
  if (denied !== null) return denied;
  return settle(await removeContact(pool, seatId, actorOf(identity)));
}

/**
 * Tick or untick *"this is the DC Office / AC Headquarter"*.
 *
 * 🔴 The single most consequential write in the roster. `setContactAdministration` refuses to
 * remove the last tick, because a district in which nobody is the administration is a district
 * in which nobody can issue an advisory — and the first person to discover that would be the
 * control room at 02:00.
 */
export async function setAdministration(
  pool: Pool,
  identity: Identity,
  seatId: Uuid,
  on: boolean,
): Promise<AdminResult<{ readonly isAdministration: boolean }>> {
  const denied = reachContacts<{ readonly isAdministration: boolean }>(identity);
  if (denied !== null) return denied;
  return settle(await setContactAdministration(pool, seatId, on, actorOf(identity)));
}
