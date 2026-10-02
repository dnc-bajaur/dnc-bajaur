/**
 * Roles and per-account permission overrides — ADR-0032.
 *
 * ## The decision, in one sentence
 *
 * **Access is a role plus a set of allow/deny overrides, and it is data an administrator reads
 * and changes — never a scattered `if (role === …)`.**
 *
 * This is the same principle as `domain/authority.ts` (ADR-0003: authority is a table), applied
 * to a different question. `authority.ts` answers *"who owns this incident field, and who may
 * override it, with a reason"*. This answers *"who may create an account, turn a screen off, or
 * read the access log"* — a question with no incident, no field, and no reason-required
 * override, so it is a **sibling** table rather than a reuse. Routing account edits through
 * `evaluateWrite` would demand a typed justification on every ordinary role change, which is the
 * trap ADR-0024 stepped around.
 *
 * ## What this file is not
 *
 * It is not the gate. Every Settings endpoint calls `requirePermission` for itself (INV-05, and
 * the router does not); this file only says what a role *is*. And the role is never derived from
 * the designation text (ADR-0029 §2) — it is an explicit `person.role` column.
 */

/**
 * `member` (ADR-0038, Bajaur) is an officer who signs in for Activities only. It holds none of
 * the permissions below, and the server refuses it on every operational route — see the gated
 * `resolveSession` in `api/server.ts`.
 */
export type Role = 'owner' | 'admin' | 'operator' | 'viewer' | 'member';

/** Order is authority-descending, for anything that needs to compare two roles. */
export const ROLES: readonly Role[] = ['owner', 'admin', 'operator', 'viewer', 'member'];

/**
 * The closed enumeration of permissions.
 *
 * Kept here rather than in a database CHECK so a permission added in a later release does not
 * need a migration — the same reasoning that keeps capability strings out of a constraint.
 * `person_permission` stores whatever string it is handed; the API validates it against this.
 */
export type Permission =
  /** See the list of accounts and their roles. */
  | 'accounts.read'
  /** Create a login for a person. */
  | 'accounts.create'
  /** Remove an account (sets `removed_at`; never a DELETE). */
  | 'accounts.remove'
  /** Suspend or reactivate an account. */
  | 'accounts.suspend'
  /** Change an account's role. Capped at `admin` unless the actor is `owner`. */
  | 'accounts.set_role'
  /** Write or clear an allow/deny override on another account. */
  | 'accounts.set_permission'
  /** Reset another account's password (forces a change on next sign-in). */
  | 'accounts.reset_password'
  /** Force-sign-out every session for an account — the compromised-account response. */
  | 'accounts.force_logout'
  /** Read the access and login history. */
  | 'access_log.read'
  /** Read the security policy (password minimum, session timeout, idle logout). */
  | 'security_policy.read'
  /** Change the security policy. `owner` alone may lower a floor. */
  | 'security_policy.write'
  /** Turn installation screens on and off (was in Administration — ADR-0016). */
  | 'capabilities.write'
  /** Arrange the dashboard wall (was in Administration — ADR-0015). */
  | 'dashboard_layout.write';

export const PERMISSIONS: readonly Permission[] = [
  'accounts.read',
  'accounts.create',
  'accounts.remove',
  'accounts.suspend',
  'accounts.set_role',
  'accounts.set_permission',
  'accounts.reset_password',
  'accounts.force_logout',
  'access_log.read',
  'security_policy.read',
  'security_policy.write',
  'capabilities.write',
  'dashboard_layout.write',
];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * The base permission set for each role.
 *
 * `owner` and `admin` share the same set: the difference between them is not a coarse
 * permission but a **scope** enforced in the handlers — an `admin` may not act on the `owner`
 * account, may not raise anyone to `admin` or `owner` without being `owner`, and may not lower
 * a security-policy floor. Putting those as separate permissions would multiply the enumeration
 * for three rules that are really *"is the subject a peer or above"*. See `api/settings.ts`.
 *
 * `operator` and `viewer` hold none of these: an operator's authority is operational (the
 * roster, the console's operational tabs) and is expressed as its own permissions when those
 * call sites are re-gated (ADR-0032 phase 2). A `viewer` differs from an `operator` only on the
 * operational write paths, which this file does not yet name.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  operator: [],
  viewer: [],
  member: [],
};

export type OverrideEffect = 'allow' | 'deny';

export interface PermissionOverride {
  readonly permission: string;
  readonly effect: OverrideEffect;
}

/**
 * The role's set, plus every `allow`, minus every `deny` — **deny wins**.
 *
 * The `person_permission` primary key is `(person_id, permission)`, so the list handed in here
 * carries at most one effect per permission and the precedence never actually bites. It is
 * still applied deny-last, because that is the rule an administrator expects and the one that
 * survives the table's uniqueness being loosened later.
 */
export function resolvePermissions(
  role: Role,
  overrides: readonly PermissionOverride[],
): ReadonlySet<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const o of overrides) {
    if (o.effect === 'allow' && isPermission(o.permission)) set.add(o.permission);
  }
  for (const o of overrides) {
    if (o.effect === 'deny' && isPermission(o.permission)) set.delete(o.permission);
  }
  return set;
}

/** Does this role, with these overrides, hold this permission? */
export function can(
  role: Role,
  overrides: readonly PermissionOverride[],
  permission: Permission,
): boolean {
  return resolvePermissions(role, overrides).has(permission);
}

/** True for `owner` and `admin` — the two roles that see the Settings panel at all. */
export function isAdministrative(role: Role): boolean {
  return role === 'owner' || role === 'admin';
}
