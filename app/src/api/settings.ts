/**
 * The Settings panel's server half — ADR-0032, phase 2.
 *
 * Accounts, per-account overrides and the access history. This file is the **gate**: every
 * function asks `requirePermission` for itself, exactly as `api/admin.ts`'s functions each ask
 * `requireAdministration`. The router (`handleSettings` in `server.ts`) does not check
 * authority, so an endpoint added there without a `requirePermission` call is refused rather
 * than silently open (INV-05).
 *
 * ## Two layers of authority, and they are not the same question
 *
 *   1. **The permission** — `accounts.create`, `accounts.set_role`, … — answered by
 *      `can(role, overrides, permission)` from `domain/roles.ts`. This is *may this account do
 *      this kind of thing at all*.
 *   2. **The subject scope** — enforced in `guardSubject`, in the handler, never the router.
 *      *May this account do it **to that account**.* The `owner` row is untouchable from inside
 *      the app; an `admin` may not act on a peer `admin` or the `owner`; nobody removes or
 *      suspends themselves. Putting these as coarse permissions would multiply the enumeration
 *      for three rules that are really "is the subject a peer or above" (ADR-0032, `roles.ts`).
 *
 * ## Every change is an `access_event`
 *
 * Appended through `recordAccessEvent` (migration 0044, append-only). INV-06: no sensitive
 * action is unattributable. Nothing is hard-deleted — removal sets `person.removed_at` and
 * revokes the account's sessions, and the row, its history and every incident it touched stay
 * readable (ADR-0001).
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { revokeAllForPerson, SESSION_TTL_HOURS } from '../auth/sessions.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { unknowablePassword } from '../auth/loginLink.js';
import { issueAndSend, type LinkDeps, type LinkOutcome } from './loginLinks.js';
import {
  ROLES,
  can,
  isPermission,
  resolvePermissions,
  type Permission,
  type PermissionOverride,
  type Role,
} from '../domain/roles.js';
import {
  readAccessLog,
  recordAccessEvent,
  type AccessEventType,
  type AccessLogQuery,
} from '../db/accessLog.js';
import {
  loadLayout,
  saveLayout,
  loadCapabilities,
  setCapability,
  type ConfigActor,
} from '../db/configStore.js';
import { DEFAULT_LAYOUT, fits, PANELS, parseLayout, resolveLayout } from '../domain/panels.js';
import { CAPABILITIES, type Capability } from '../domain/capabilities.js';

export type SettingsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse<T>(status: number, error: string): SettingsResult<T> {
  return { ok: false, status, error };
}

/** A stored role string that is not a known one is read as the least-privileged (`member`). */
function asRole(value: string): Role {
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : 'member';
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

//------------------------------------------------------------------------------
// The gate
//------------------------------------------------------------------------------

/**
 * Load the acting account's allow/deny overrides, so `can()` can fold them onto its role.
 *
 * Read fresh on every request, like the seat (`resolveIdentity`) — an override cleared a
 * second ago must bite on the next call, not on the next sign-in.
 */
export async function loadOverrides(
  pool: Pick<Pool, 'query'>,
  personId: string,
): Promise<PermissionOverride[]> {
  const res = await pool.query<{ permission: string; effect: string }>(
    'SELECT permission, effect FROM person_permission WHERE person_id = $1',
    [personId],
  );
  return res.rows.map((r) => ({
    permission: r.permission,
    effect: r.effect === 'deny' ? 'deny' : 'allow',
  }));
}

/**
 * Everything this account may do right now — its role folded with its overrides. For a module
 * that asks several questions at once (Activities: may I see all posts? moderate?), so it reads
 * the overrides once rather than once per question.
 */
export async function permissionsOf(
  pool: Pool,
  identity: Identity,
): Promise<ReadonlySet<Permission>> {
  return resolvePermissions(identity.role, await loadOverrides(pool, identity.personId));
}

/**
 * The one authority question, asked the same way everywhere.
 *
 * Returns a 403 refusal or `null`. Shaped exactly like `requireAdministration` so a call site
 * reads `const denied = await requirePermission(...); if (denied) return denied;`.
 */
export async function requirePermission<T>(
  pool: Pool,
  identity: Identity,
  permission: Permission,
): Promise<SettingsResult<T> | null> {
  const overrides = await loadOverrides(pool, identity.personId);
  if (!can(identity.role, overrides, permission)) {
    return refuse(403, `you do not have permission for ${permission}`);
  }
  return null;
}

//------------------------------------------------------------------------------
// The subject scope — handler-level, never the router
//------------------------------------------------------------------------------

interface AccountRecord {
  readonly personId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly role: Role;
  readonly suspendedAt: string | null;
  readonly mustChangePassword: boolean;
}

async function loadAccount(pool: Pool, personId: string): Promise<AccountRecord | null> {
  const res = await pool.query<{
    person_id: string;
    full_name: string | null;
    phone: string | null;
    role: string;
    suspended_at: string | null;
    must_change_password: boolean | null;
    removed_at: string | null;
    has_hash: boolean;
  }>(
    `SELECT person_id, full_name, phone, role, suspended_at, must_change_password, removed_at,
            (password_hash IS NOT NULL) AS has_hash
       FROM person WHERE person_id = $1`,
    [personId],
  );
  const r = res.rows[0];
  // A removed account, or one that never held a login, is not an account this panel acts on.
  if (r === undefined || r.removed_at !== null || !r.has_hash) return null;
  return {
    personId: r.person_id,
    fullName: r.full_name ?? '',
    phone: r.phone ?? '',
    role: asRole(r.role),
    suspendedAt: r.suspended_at,
    mustChangePassword: r.must_change_password === true,
  };
}

/**
 * Whether the acting account may act **on this subject**.
 *
 * * The `owner` row is untouchable from inside the app. Ownership moves by handover
 *   (`setAccountRole` to `owner`), which is the only path and demotes the previous holder in
 *   the same transaction.
 * * An `admin` may not act on a peer `admin` or the `owner` — only the `owner` may.
 * * `self: 'refuse'` blocks acting on your own account (remove, suspend), the "ask the other
 *   office" precedent from `removeRosterPerson`.
 */
function guardSubject(
  actor: Identity,
  subject: AccountRecord,
  self: 'ok' | 'refuse',
): SettingsResult<never> | null {
  if (subject.role === 'owner') {
    return refuse(409, 'the owner account cannot be changed from inside the app');
  }
  // Checked before the peer-`admin` rule so "you cannot do this to yourself" is the reason an
  // administrator sees, rather than the less useful "only the owner may act on an admin".
  if (self === 'refuse' && subject.personId === actor.personId) {
    return refuse(409, 'you cannot do this to your own account — ask another administrator');
  }
  if (subject.role === 'admin' && actor.role !== 'owner') {
    return refuse(403, 'only the owner may act on another admin account');
  }
  return null;
}

//------------------------------------------------------------------------------
// Accounts — read
//------------------------------------------------------------------------------

export interface AccountView {
  readonly personId: string;
  readonly fullName: string;
  /** The post, as text (migration 0049). Null when none was given. Display only. */
  readonly designation: string | null;
  readonly phone: string;
  readonly role: Role;
  readonly suspended: boolean;
  readonly mustChangePassword: boolean;
  /** Last successful sign-in, from `access_event`. Null if the account has never signed in. */
  readonly lastSignInAt: string | null;
  readonly overrides: readonly { readonly permission: string; readonly effect: 'allow' | 'deny' }[];
}

export async function listAccounts(
  pool: Pool,
  identity: Identity,
): Promise<SettingsResult<readonly AccountView[]>> {
  const denied = await requirePermission<readonly AccountView[]>(pool, identity, 'accounts.read');
  if (denied !== null) return denied;

  const accounts = await pool.query<{
    person_id: string;
    full_name: string | null;
    designation: string | null;
    phone: string | null;
    role: string;
    suspended_at: string | null;
    must_change_password: boolean | null;
    last_sign_in_at: string | null;
  }>(
    `SELECT p.person_id, p.full_name, p.designation, p.phone, p.role, p.suspended_at,
            p.must_change_password,
            (SELECT max(e.recorded_at) FROM access_event e
              WHERE e.subject_person_id = p.person_id AND e.type = 'login_succeeded') AS last_sign_in_at
       FROM person p
      WHERE p.password_hash IS NOT NULL AND p.removed_at IS NULL
      ORDER BY array_position(ARRAY['owner','admin','operator','viewer','member'], p.role), p.full_name`,
  );

  const overrides = await pool.query<{ person_id: string; permission: string; effect: string }>(
    'SELECT person_id, permission, effect FROM person_permission',
  );
  const byPerson = new Map<string, { permission: string; effect: 'allow' | 'deny' }[]>();
  for (const o of overrides.rows) {
    const list = byPerson.get(o.person_id) ?? [];
    list.push({ permission: o.permission, effect: o.effect === 'deny' ? 'deny' : 'allow' });
    byPerson.set(o.person_id, list);
  }

  return {
    ok: true,
    value: accounts.rows.map((r) => ({
      personId: r.person_id,
      fullName: r.full_name ?? '',
      designation: r.designation,
      phone: r.phone ?? '',
      role: asRole(r.role),
      suspended: r.suspended_at !== null,
      mustChangePassword: r.must_change_password === true,
      lastSignInAt: r.last_sign_in_at,
      overrides: byPerson.get(r.person_id) ?? [],
    })),
  };
}

//------------------------------------------------------------------------------
// Accounts — create
//------------------------------------------------------------------------------

export async function createAccount(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly personId: string }>> {
  const denied = await requirePermission<{ readonly personId: string }>(
    pool,
    identity,
    'accounts.create',
  );
  if (denied !== null) return denied;

  const fullName = text(input['fullName']);
  const designation = text(input['designation']);
  const phone = text(input['phone']);
  const role = text(input['role']) as Role;
  const password = typeof input['password'] === 'string' ? input['password'] : '';

  if (fullName === '') return refuse(400, 'a name is required');
  if (phone === '') return refuse(400, 'a phone number is required');
  if (designation.length > 200) return refuse(400, 'that post is too long');
  const roleRefused = refuseGrantedRole<{ readonly personId: string }>(identity, role);
  if (roleRefused !== null) return roleRefused;

  // ADR-0038 §5: one person never appears twice. A number already in the contact list gets its
  // login from there ("Give login"), so the contact and the account stay one row.
  const contact = await pool.query(
    `SELECT 1 FROM person
      WHERE phone = $1 AND password_hash IS NULL AND removed_at IS NULL AND NOT placeholder
      LIMIT 1`,
    [phone],
  );
  if (contact.rowCount !== 0) {
    return refuse(
      409,
      'that number is already in the contact list — give them a login from their contact, so they are not listed twice',
    );
  }

  let hash: string;
  try {
    hash = await hashPassword(password);
  } catch (e) {
    return refuse(400, (e as Error).message);
  }

  // Default: the creator set a temporary password, so the holder must change it on first
  // sign-in and never keeps one the creator has seen. `false` only if asked for explicitly.
  const mustChange = input['mustChangePassword'] !== false;

  let personId: string;
  try {
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password, designation)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING person_id`,
      [fullName, phone, hash, role, mustChange, designation === '' ? null : designation],
    );
    personId = res.rows[0]!.person_id;
  } catch {
    // Migration 0006 makes phone unique among rows that hold a password hash.
    return refuse(409, 'that phone number already has an account');
  }

  await setActivityUnit(pool, personId, input['activityUnitId']);

  await recordAccessEvent(pool, {
    type: 'granted',
    actorPersonId: identity.personId,
    subjectPersonId: personId,
    after: { role, fullName },
  }).catch(() => {});

  return { ok: true, value: { personId } };
}

/**
 * The account's default Activities department (ADR-0038 §5, ADR-0039 §2), when the form gave
 * one. Optional and harmless — it only pre-fills the Activities form — so an unknown or retired
 * department is ignored rather than failing the account the administrator just made.
 */
async function setActivityUnit(pool: Pool, personId: string, unitId: unknown): Promise<void> {
  const id = text(unitId);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;
  await pool.query(
    `UPDATE person SET activity_unit_id = $2
      WHERE person_id = $1
        AND EXISTS (SELECT 1 FROM activity_unit WHERE unit_id = $2 AND retired_at IS NULL)`,
    [personId, id],
  );
}

/**
 * The roles an account may be given at creation, and by whom — shared by `createAccount` and
 * `grantLogin` so the two doors cannot drift apart.
 */
function refuseGrantedRole<T>(identity: Identity, role: string): SettingsResult<T> | null {
  if (!(ROLES as readonly string[]).includes(role)) {
    return refuse(400, `role must be one of ${ROLES.join(', ')}`);
  }
  // The owner is established at go-live and moves only by handover — never created here.
  if (role === 'owner') {
    return refuse(400, 'there is exactly one owner; hand it over from the owner account');
  }
  // Only the owner mints an admin. An admin creating an admin is an admin widening the set of
  // accounts it cannot itself touch.
  if (role === 'admin' && identity.role !== 'owner') {
    return refuse(403, 'only the owner may create an admin account');
  }
  return null;
}

//------------------------------------------------------------------------------
// Accounts — give a contact a login (ADR-0038 §5)
//------------------------------------------------------------------------------

/**
 * Give a person already in the contact list a sign-in — "Give login".
 *
 * The contact's own row gets the password and the role, so the person is never listed twice:
 * their name, number and post are the ones the directory already holds. The post (the seat's
 * title) is copied onto the account for display. The same permission and the same role rules
 * as `createAccount`; the password is temporary and must be changed at first sign-in.
 */
export async function grantLogin(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
  /** Needed only for `link: true` — how to send the sign-in link (ADR-0043). */
  deps?: LinkDeps,
): Promise<SettingsResult<GrantedLogin>> {
  const denied = await requirePermission<GrantedLogin>(pool, identity, 'accounts.create');
  if (denied !== null) return denied;

  const role = text(input['role']);
  const roleRefused = refuseGrantedRole<GrantedLogin>(identity, role);
  if (roleRefused !== null) return roleRefused;
  // A sign-in link instead of a typed password: nobody — the DC included — ever sees it.
  const byLink = input['link'] === true;
  if (byLink && deps === undefined) return refuse(500, 'sign-in links are not available here');

  const found = await pool.query<{
    full_name: string;
    phone: string;
    has_hash: boolean;
    placeholder: boolean;
    post: string | null;
  }>(
    `SELECT p.full_name, p.phone, (p.password_hash IS NOT NULL) AS has_hash, p.placeholder,
            (SELECT s.title FROM duty_assignment d JOIN seat s ON s.seat_id = d.seat_id
              WHERE d.person_id = p.person_id AND d.to_at IS NULL AND s.retired_at IS NULL
              ORDER BY d.from_at DESC LIMIT 1) AS post
       FROM person p
      WHERE p.person_id = $1 AND p.removed_at IS NULL`,
    [subjectId],
  );
  const contact = found.rows[0];
  if (contact === undefined) return refuse(404, 'no such contact');
  if (contact.has_hash) return refuse(409, 'this contact already has a login');
  if (contact.placeholder) {
    return refuse(400, 'this is a stand-in number, not a person — put the real officer in first');
  }

  let hash: string;
  try {
    hash = byLink
      ? await unknowablePassword()
      : await hashPassword(typeof input['password'] === 'string' ? input['password'] : '');
  } catch (e) {
    return refuse(400, (e as Error).message);
  }

  try {
    await pool.query(
      `UPDATE person
          SET password_hash = $2, role = $3, must_change_password = true,
              designation = COALESCE(designation, $4)
        WHERE person_id = $1 AND password_hash IS NULL`,
      [subjectId, hash, role, contact.post],
    );
  } catch {
    // Migration 0045: one live account per number. Another account already holds this one.
    return refuse(409, 'that phone number already has an account');
  }

  await setActivityUnit(pool, subjectId, input['activityUnitId']);

  await recordAccessEvent(pool, {
    type: 'granted',
    actorPersonId: identity.personId,
    subjectPersonId: subjectId,
    after: { role, fullName: contact.full_name, fromContact: true, byLink },
  }).catch(() => {});

  if (!byLink || deps === undefined) return { ok: true, value: { personId: subjectId } };
  const link = await issueAndSend(
    pool,
    deps,
    { personId: subjectId, fullName: contact.full_name, phone: contact.phone },
    identity.personId,
  );
  return { ok: true, value: { personId: subjectId, link } };
}

export interface GrantedLogin {
  readonly personId: string;
  /** Present when the login was given by a sign-in link: how it went out (ADR-0043). */
  readonly link?: LinkOutcome;
}

/**
 * "Send sign-in link" — a new link for an existing account, which is also how a forgotten
 * password is reset without the DC inventing one (ADR-0043). The same permission and the same
 * owner/admin rule as resetting a password; the old password keeps working until the link is
 * used, and using it signs every other session out.
 */
export async function sendSignInLink(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  deps: LinkDeps,
): Promise<SettingsResult<LinkOutcome>> {
  const denied = await requirePermission<LinkOutcome>(pool, identity, 'accounts.reset_password');
  if (denied !== null) return denied;

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');
  if (subject.personId === identity.personId) {
    return refuse(409, 'use "change my password" for your own account');
  }
  const scope = guardSubject(identity, subject, 'refuse');
  if (scope !== null) return scope;
  if (subject.suspendedAt !== null) return refuse(409, 'this account is suspended');

  const link = await issueAndSend(
    pool,
    deps,
    { personId: subject.personId, fullName: subject.fullName, phone: subject.phone },
    identity.personId,
  );
  return { ok: true, value: link };
}

//------------------------------------------------------------------------------
// Accounts — role
//------------------------------------------------------------------------------

export async function setAccountRole(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly role: Role }>> {
  const denied = await requirePermission<{ readonly role: Role }>(
    pool,
    identity,
    'accounts.set_role',
  );
  if (denied !== null) return denied;

  const role = text(input['role']) as Role;
  if (!(ROLES as readonly string[]).includes(role)) {
    return refuse(400, `role must be one of ${ROLES.join(', ')}`);
  }

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  //----------------------------------------------------------------------------
  // Handover — the ONLY path to `owner`, and it demotes the caller in the same breath.
  //----------------------------------------------------------------------------
  if (role === 'owner') {
    if (identity.role !== 'owner') {
      return refuse(403, 'only the owner may hand over ownership');
    }
    if (subject.personId === identity.personId) {
      return refuse(409, 'you already hold the owner account');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE person SET role = $2 WHERE person_id = $1', [
        subject.personId,
        'owner',
      ]);
      await client.query('UPDATE person SET role = $2 WHERE person_id = $1', [
        identity.personId,
        'admin',
      ]);
      await recordAccessEvent(client, {
        type: 'role_changed',
        actorPersonId: identity.personId,
        subjectPersonId: subject.personId,
        before: { role: subject.role },
        after: { role: 'owner' },
        reason: 'ownership handover',
      });
      await recordAccessEvent(client, {
        type: 'role_changed',
        actorPersonId: identity.personId,
        subjectPersonId: identity.personId,
        before: { role: 'owner' },
        after: { role: 'admin' },
        reason: 'ownership handover',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return { ok: true, value: { role: 'owner' } };
  }

  const scope = guardSubject(identity, subject, 'refuse');
  if (scope !== null) return scope;

  // Raising anyone to `admin` is an owner-only act, for the same reason creating one is.
  if (role === 'admin' && identity.role !== 'owner') {
    return refuse(403, 'only the owner may raise an account to admin');
  }

  if (subject.role === role) return { ok: true, value: { role } };

  await pool.query('UPDATE person SET role = $2 WHERE person_id = $1', [subject.personId, role]);
  await recordAccessEvent(pool, {
    type: 'role_changed',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    before: { role: subject.role },
    after: { role },
    ...(text(input['reason']) !== '' ? { reason: text(input['reason']) } : {}),
  }).catch(() => {});

  return { ok: true, value: { role } };
}

//------------------------------------------------------------------------------
// Accounts — overrides
//------------------------------------------------------------------------------

export async function setOverride(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly set: true }>> {
  const denied = await requirePermission<{ readonly set: true }>(
    pool,
    identity,
    'accounts.set_permission',
  );
  if (denied !== null) return denied;

  const permission = text(input['permission']);
  const effect = text(input['effect']);
  if (!isPermission(permission)) return refuse(400, 'unknown permission');
  if (effect !== 'allow' && effect !== 'deny')
    return refuse(400, "effect must be 'allow' or 'deny'");

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'ok');
  if (scope !== null) return scope;

  await pool.query(
    `INSERT INTO person_permission (person_id, permission, effect, set_by_person_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (person_id, permission)
       DO UPDATE SET effect = EXCLUDED.effect, set_at = now(), set_by_person_id = EXCLUDED.set_by_person_id`,
    [subject.personId, permission, effect, identity.personId],
  );
  await recordAccessEvent(pool, {
    type: 'permission_set',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    after: { permission, effect },
  }).catch(() => {});

  return { ok: true, value: { set: true } };
}

export async function clearOverride(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  permission: string,
): Promise<SettingsResult<{ readonly cleared: true }>> {
  const denied = await requirePermission<{ readonly cleared: true }>(
    pool,
    identity,
    'accounts.set_permission',
  );
  if (denied !== null) return denied;

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'ok');
  if (scope !== null) return scope;

  const res = await pool.query(
    'DELETE FROM person_permission WHERE person_id = $1 AND permission = $2',
    [subject.personId, permission],
  );
  if ((res.rowCount ?? 0) === 0) return refuse(404, 'no such override on that account');

  await recordAccessEvent(pool, {
    type: 'permission_cleared',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    before: { permission },
  }).catch(() => {});

  return { ok: true, value: { cleared: true } };
}

//------------------------------------------------------------------------------
// Accounts — suspend / reactivate
//------------------------------------------------------------------------------

export async function suspendAccount(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly suspended: true }>> {
  const denied = await requirePermission<{ readonly suspended: true }>(
    pool,
    identity,
    'accounts.suspend',
  );
  if (denied !== null) return denied;

  const reason = text(input['reason']);
  // The database CHECK demands it too (access_event_destructive_needs_reason); asked here so
  // the operator gets a sentence rather than a constraint name.
  if (reason === '') return refuse(400, 'say why this account is being suspended');

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'refuse');
  if (scope !== null) return scope;

  if (subject.suspendedAt !== null) return { ok: true, value: { suspended: true } };

  await pool.query('UPDATE person SET suspended_at = now() WHERE person_id = $1', [
    subject.personId,
  ]);
  const revoked = await revokeAllForPerson(pool, subject.personId);
  await recordAccessEvent(pool, {
    type: 'suspended',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    reason,
    after: { sessionsRevoked: revoked },
  }).catch(() => {});

  return { ok: true, value: { suspended: true } };
}

export async function reactivateAccount(
  pool: Pool,
  identity: Identity,
  subjectId: string,
): Promise<SettingsResult<{ readonly reactivated: true }>> {
  const denied = await requirePermission<{ readonly reactivated: true }>(
    pool,
    identity,
    'accounts.suspend',
  );
  if (denied !== null) return denied;

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'ok');
  if (scope !== null) return scope;

  if (subject.suspendedAt === null) return { ok: true, value: { reactivated: true } };

  await pool.query('UPDATE person SET suspended_at = NULL WHERE person_id = $1', [
    subject.personId,
  ]);
  await recordAccessEvent(pool, {
    type: 'reactivated',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
  }).catch(() => {});

  return { ok: true, value: { reactivated: true } };
}

//------------------------------------------------------------------------------
// Accounts — reset password
//------------------------------------------------------------------------------

export async function resetPassword(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly reset: true }>> {
  const denied = await requirePermission<{ readonly reset: true }>(
    pool,
    identity,
    'accounts.reset_password',
  );
  if (denied !== null) return denied;

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  if (subject.personId === identity.personId) {
    return refuse(409, 'use "change my password" for your own account');
  }
  const scope = guardSubject(identity, subject, 'refuse');
  if (scope !== null) return scope;

  const newPassword = typeof input['newPassword'] === 'string' ? input['newPassword'] : '';
  let hash: string;
  try {
    hash = await hashPassword(newPassword);
  } catch (e) {
    return refuse(400, (e as Error).message);
  }

  // Forces a change on next sign-in, so the holder never keeps a password an administrator has
  // seen; and every existing session is dropped, so the old password stops working now.
  await pool.query(
    'UPDATE person SET password_hash = $2, must_change_password = true WHERE person_id = $1',
    [subject.personId, hash],
  );
  const revoked = await revokeAllForPerson(pool, subject.personId);
  await recordAccessEvent(pool, {
    type: 'password_reset',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    after: { sessionsRevoked: revoked },
  }).catch(() => {});

  return { ok: true, value: { reset: true } };
}

//------------------------------------------------------------------------------
// Accounts — force sign-out
//------------------------------------------------------------------------------

export async function forceLogout(
  pool: Pool,
  identity: Identity,
  subjectId: string,
): Promise<SettingsResult<{ readonly sessionsRevoked: number }>> {
  const denied = await requirePermission<{ readonly sessionsRevoked: number }>(
    pool,
    identity,
    'accounts.force_logout',
  );
  if (denied !== null) return denied;

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'ok');
  if (scope !== null) return scope;

  const revoked = await revokeAllForPerson(pool, subject.personId);
  await recordAccessEvent(pool, {
    type: 'session_revoked',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    after: { sessionsRevoked: revoked },
  }).catch(() => {});

  return { ok: true, value: { sessionsRevoked: revoked } };
}

//------------------------------------------------------------------------------
// Accounts — remove
//------------------------------------------------------------------------------

export async function removeAccount(
  pool: Pool,
  identity: Identity,
  subjectId: string,
  input: Record<string, unknown>,
): Promise<SettingsResult<{ readonly removed: true }>> {
  const denied = await requirePermission<{ readonly removed: true }>(
    pool,
    identity,
    'accounts.remove',
  );
  if (denied !== null) return denied;

  const reason = text(input['reason']);
  if (reason === '') return refuse(400, 'say why this account is being removed');

  const subject = await loadAccount(pool, subjectId);
  if (subject === null) return refuse(404, 'no such account');

  const scope = guardSubject(identity, subject, 'refuse');
  if (scope !== null) return scope;

  // Not a DELETE — the row, its history and every incident it touched stay readable (ADR-0001).
  await pool.query('UPDATE person SET removed_at = now() WHERE person_id = $1', [subject.personId]);
  const revoked = await revokeAllForPerson(pool, subject.personId);
  await recordAccessEvent(pool, {
    type: 'removed',
    actorPersonId: identity.personId,
    subjectPersonId: subject.personId,
    reason,
    after: { sessionsRevoked: revoked },
  }).catch(() => {});

  return { ok: true, value: { removed: true } };
}

//------------------------------------------------------------------------------
// The access log
//------------------------------------------------------------------------------

const ACCESS_EVENT_TYPES: readonly AccessEventType[] = [
  'granted',
  'role_changed',
  'permission_set',
  'permission_cleared',
  'password_reset',
  'password_changed',
  'suspended',
  'reactivated',
  'removed',
  'session_revoked',
  'login_succeeded',
  'login_failed',
  'login_link_issued',
  'login_link_used',
];

export async function accessLog(
  pool: Pool,
  identity: Identity,
  params: URLSearchParams,
): Promise<SettingsResult<Awaited<ReturnType<typeof readAccessLog>>>> {
  const denied = await requirePermission<Awaited<ReturnType<typeof readAccessLog>>>(
    pool,
    identity,
    'access_log.read',
  );
  if (denied !== null) return denied;

  const nonBlank = (key: string): string | null => {
    const v = params.get(key);
    return v !== null && v !== '' ? v : null;
  };
  const subject = nonBlank('subject');
  const actor = nonBlank('actor');
  const since = nonBlank('since');
  const limit = params.get('limit');
  const beforeSeq = params.get('beforeSeq');
  const type = params.get('type');

  const query: AccessLogQuery = {
    ...(subject !== null ? { subjectPersonId: subject } : {}),
    ...(actor !== null ? { actorPersonId: actor } : {}),
    ...(type !== null && (ACCESS_EVENT_TYPES as readonly string[]).includes(type)
      ? { type: type as AccessEventType }
      : {}),
    ...(since !== null ? { since } : {}),
    ...(limit !== null && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
    ...(beforeSeq !== null && Number.isFinite(Number(beforeSeq))
      ? { beforeSeq: Number(beforeSeq) }
      : {}),
  };

  return { ok: true, value: await readAccessLog(pool, query) };
}

//------------------------------------------------------------------------------
// Security policy — read-only for this phase
//------------------------------------------------------------------------------

/**
 * The two values the Security-policy tab shows. ADR-0032 makes them editable — above a floor the
 * `owner` cannot go below — in a later step; for now the panel renders the constants the server
 * already enforces so an administrator can *see* the policy without a place to change it yet.
 */
export interface SecurityPolicyView {
  readonly minPasswordLength: number;
  readonly sessionTtlHours: number;
}

export async function securityPolicy(
  pool: Pool,
  identity: Identity,
): Promise<SettingsResult<SecurityPolicyView>> {
  const denied = await requirePermission<SecurityPolicyView>(
    pool,
    identity,
    'security_policy.read',
  );
  if (denied !== null) return denied;

  return {
    ok: true,
    value: {
      minPasswordLength: MIN_PASSWORD_LENGTH,
      sessionTtlHours: SESSION_TTL_HOURS,
    },
  };
}

//------------------------------------------------------------------------------
// The dashboard wall and the installation's screens — ADR-0032 phase 4
//------------------------------------------------------------------------------

/**
 * *"Which screens are on"* (ADR-0016) and *"Dashboard layout"* (ADR-0015) were tabs inside the
 * Administration console. ADR-0032 §1 moves them here: they are **installation configuration**
 * — what this software offers, and how its wall is arranged — not the district's operational
 * record, which is what Administration keeps.
 *
 * They gate on `capabilities.write` / `dashboard_layout.write`, the two permissions
 * `domain/roles.ts` has carried since phase 1 for exactly this. Reading the editor is part of
 * editing it — there is no separate `.read` permission and none is wanted, since only `owner`
 * and `admin` see this panel at all. The router (`handleSettings`) checks no authority (INV-05);
 * each function asks for itself, the discipline the rest of this file already keeps.
 *
 * `resolveLayout` still drops an administration-only panel server-side whatever the stored
 * layout says, exactly as it did on the old route.
 */
function configActor(identity: Identity): ConfigActor {
  return { seatId: identity.seatId, personId: identity.personId };
}

export interface DashboardLayoutView {
  readonly available: readonly {
    readonly id: string;
    readonly name: string;
    readonly what: string;
    readonly audience: string;
    readonly sizes: readonly string[];
  }[];
  readonly layout: readonly { readonly id: string; readonly size: string }[];
  /** Whether the district has ever arranged this, or is looking at the built-in default. */
  readonly isDefault: boolean;
  /** Roughly how much of a 1920×1080 screen this uses, and whether it spills (M6-32). */
  readonly slots: number;
  readonly overflows: boolean;
  readonly problems: readonly { readonly panelId: string; readonly why: string }[];
}

export async function dashboardLayout(
  pool: Pool,
  identity: Identity,
): Promise<SettingsResult<DashboardLayoutView>> {
  const denied = await requirePermission<DashboardLayoutView>(
    pool,
    identity,
    'dashboard_layout.write',
  );
  if (denied !== null) return denied;

  const stored = await loadLayout(pool, null);
  const layout = stored ?? DEFAULT_LAYOUT;
  const resolved = resolveLayout(layout, { isAdministration: true });

  return {
    ok: true,
    value: {
      available: PANELS.map((p) => ({
        id: p.id,
        name: p.name,
        what: p.what,
        audience: p.audience,
        sizes: p.sizes,
      })),
      layout: resolved.panels,
      isDefault: stored === null,
      ...fits({ panels: resolved.panels }),
      problems: resolved.problems,
    },
  };
}

/**
 * Save an arrangement. Refused rather than repaired when a panel does not exist (`saveLayout`).
 * An overflowing layout is accepted — M6-32 is a warning, and this system does not get to tell
 * the district what fits on their own television.
 */
export async function setDashboardLayout(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<SettingsResult<DashboardLayoutView>> {
  const denied = await requirePermission<DashboardLayoutView>(
    pool,
    identity,
    'dashboard_layout.write',
  );
  if (denied !== null) return denied;

  const layout = parseLayout(input['layout'] ?? input);
  if (layout === null) {
    return refuse(400, 'send a layout: { panels: [{ id, size }, …] }');
  }

  const reason = text(input['reason']);
  const saved = await saveLayout(
    pool,
    null,
    layout,
    configActor(identity),
    reason === '' ? undefined : reason,
  );
  if (!saved.ok) return refuse(400, saved.why);

  return dashboardLayout(pool, identity);
}

export interface InstallationCapabilitiesView {
  readonly capabilities: readonly {
    readonly id: string;
    readonly name: string;
    readonly what: string;
    readonly offered: boolean;
  }[];
  /** Whether anybody has ever decided, or this is the shape the product ships with. */
  readonly chosen: boolean;
}

export async function installationCapabilities(
  pool: Pool,
  identity: Identity,
): Promise<SettingsResult<InstallationCapabilitiesView>> {
  const denied = await requirePermission<InstallationCapabilitiesView>(
    pool,
    identity,
    'capabilities.write',
  );
  if (denied !== null) return denied;

  const { state, chosen } = await loadCapabilities(pool);

  return {
    ok: true,
    value: {
      capabilities: CAPABILITIES.map((c) => ({
        id: c.id,
        name: c.name,
        what: c.what,
        offered: state[c.id],
      })),
      chosen,
    },
  };
}

/**
 * Turn one screen on or off. **This changes nothing about authority** — a capability decides
 * whether a screen is offered; every endpoint behind it still asks the policy table (INV-05).
 */
export async function toggleCapability(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<SettingsResult<InstallationCapabilitiesView>> {
  const denied = await requirePermission<InstallationCapabilitiesView>(
    pool,
    identity,
    'capabilities.write',
  );
  if (denied !== null) return denied;

  const id = input['capability'];
  const offered = input['offered'];

  if (typeof id !== 'string' || !CAPABILITIES.some((c) => c.id === id)) {
    return refuse(400, `capability must be one of ${CAPABILITIES.map((c) => c.id).join(', ')}`);
  }
  if (typeof offered !== 'boolean') return refuse(400, 'offered must be true or false');

  const reason = text(input['reason']);
  await setCapability(
    pool,
    id as Capability,
    offered,
    configActor(identity),
    reason === '' ? undefined : reason,
  );

  return installationCapabilities(pool, identity);
}
