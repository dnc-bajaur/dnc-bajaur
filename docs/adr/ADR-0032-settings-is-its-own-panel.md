# ADR-0032 — Settings is its own panel, and access is a role plus overrides

**Status:** Accepted · 2026-09-01
**Decided by:** the owner, who asked for the account model brought to *"industry standard"*:
*"jese k aik account aisa ho jis ki pas admin access ho wo account ki andar kuch bhi kar skta ho
— kese ko add karna, remove karna, access allow karna, revoke karna ya restrict karna, passwords
change karna etc etc ju bhi main admin k sath hota hai wo sub ho es mai."* Refined across four
messages: it is a **new top-level nav panel** called **Settings**, beside Dashboard / Report /
Record / Administration / Status / How to use — **not** a tab inside the Administration console —
styled like Administration and the Record; and *"Which screens are on"* and *"Dashboard layout"*
move into it from Administration.
**Amends:** [ADR-0018](./ADR-0018-control-room-only.md) — sign-in stays district-staff-only, but
those accounts stop being interchangeable: one is a true administrator, the rest are graded.
**Extends:** [ADR-0003](./ADR-0003-declarative-authority.md) — a role and its per-account
overrides are a table an administrator reads and changes, never scattered `if (role === …)`.
[ADR-0016](./ADR-0016-control-room-first.md) and [ADR-0015](./ADR-0015-the-district-composes-the-dashboard.md)
— capabilities and the dashboard layout keep their meaning; only their door moves.
**Rests on:** [ADR-0007](./ADR-0007-boring-stack.md) — no external identity provider, no
Keycloak, no new heavy dependency.

---

## Context

Every account that can sign in today is effectively all-powerful. `identity.isAdministration` is a
single boolean, ticked on a seat, and it gates the **whole** Administration console through one
function (`requireAdministration` in `api/admin.ts`). There is no *"add a user but not remove
one"*, no *"this account may look but not change"*, no per-account restriction. Concretely:

* `revokeAllForPerson` — *"the response to a compromised account"* — is written, tested, and has
  **zero callers**.
* There is no self-service password change. `POST /auth/password` does not exist.
* There is no suspend / reactivate. `disabled_at` is set only by the directory loader and by
  removal.
* No access or login history is persisted. `LoginAttempt` goes to the journal via an optional
  callback and nowhere durable.
* The password minimum is split-brained — `assertUsable` says 10, `grantAccount` and
  `grantRosterAccount` say 12.

The existing "authority model" (`domain/authority.ts`, ADR-0003, `docs/04-authority-model.md`)
governs **incident fields only** — who owns `severity`, who may override `closure`, and whether a
reason is required. It says nothing about who may create an account or turn a screen off. So a
genuine access-control layer has to be added; it should reuse ADR-0003's *authority is data*
philosophy without reusing that table, whose shape is wrong for this (see Rationale).

The owner wants this to read and behave like an admin console anyone has used before.

## Decision

### 1. Settings is a top-level panel

A new nav item — **Settings** — beside the six that exist. Visible only to the `owner` and
`admin` roles. Its internal shape matches Administration and the Record: an **Overview** landing
where each count is a door, then grouped sections with tables. It is a **lazy-loaded bundle**
(`settings.js` / `settings.css`), because the shell budget is tight and Administration is already
out of the shell (`office.js`); `CACHE` is bumped.

Administration keeps the **district's operational record** — rosters, groups, deadlines, backups,
history. Settings holds **how this installation behaves** — accounts, access, security policy,
and the two controls moving over: *Which screens are on* (capabilities, ADR-0016) and *Dashboard
layout* (ADR-0015). Those two keep their exact meaning; they are *what is offered* and *how the
wall is arranged*, never authority. They move because they are installation configuration, which
is what Settings is for.

### 2. Four roles

Stored as `person.role`. Never derived from the designation text (ADR-0029 §2's rule, restated —
a typo or an *"AC HQ (acting)"* must not move who may create an account).

| Role | What it is |
|---|---|
| `owner` | The single super-administrator. Exactly one exists. Cannot be removed, demoted or suspended from inside the app — only handed over (`owner` → `owner`, which demotes the previous holder to `admin` in the same transaction). |
| `admin` | Everything the owner does **except** touch the owner account or lower the security policy's hard floors. Adds, removes, suspends, reactivates, resets passwords, changes roles up to `admin`, sets overrides. |
| `operator` | Today's control-room account. Full operational use of the product. No account management, no security policy. |
| `viewer` | Read-only. Sees the operational screens; every write endpoint refuses. |

### 3. Per-account overrides — this is "restrict access"

A `person_permission` table: `(person_id, permission, effect)`, `effect ∈ {allow, deny}`.
`resolvePermissions(role, overrides)` in `domain/roles.ts` starts from the role's fixed permission
set, applies every `allow`, then every `deny` — **deny wins**. The permission list is a closed
enumeration in that module, inspectable and finite:

`accounts.read` · `accounts.create` · `accounts.remove` · `accounts.suspend` ·
`accounts.set_role` · `accounts.set_permission` · `accounts.reset_password` ·
`accounts.force_logout` · `access_log.read` · `security_policy.read` · `security_policy.write` ·
`capabilities.write` · `dashboard_layout.write` · plus the operational reads/writes the roster
and console already gate.

So *"restrict this Operator from the roster"* is a `deny` on `roster.read`; *"let this Operator
reset passwords"* is an `allow` on `accounts.reset_password`. The role list stays short; the
exceptions are explicit rows an administrator can see and an `access_event` records.

### 4. The gate is server-side, per endpoint (INV-05)

Every Settings endpoint asks `requirePermission(identity, '<permission>')` for itself. The router
does not gate — each handler does, exactly as `api/admin.ts` gates itself today. Hiding the nav
item is a courtesy; the server refuses regardless.

### 5. Every account and access change is an appended event (INV-06, ADR-0001)

A new `access_event` table, append-only, enforced by triggers, modelled on `config_event`:
`granted` · `role_changed` · `permission_set` · `permission_cleared` · `password_reset` ·
`password_changed` · `suspended` · `reactivated` · `removed` · `session_revoked` ·
`login_succeeded` · `login_failed`. Every row carries the actor, the subject, a reason where the
act needs one, and the before/after. **Nothing is hard-deleted** — removing an account sets
`person.removed_at`, revokes its sessions, and leaves the row. The persisted login history is
what makes *Access log* a real screen rather than a promise.

### 6. Server-side sessions stay; TTL and idle-logout become policy

`docs/05-stack.md` chose server sessions over JWT for instant revocation, and that is unchanged.
`revokeAllForPerson` gets its first caller — a **Force sign-out** button (the compromised-account
response). `SESSION_TTL_HOURS` stops being a source constant and becomes a Security-policy value
with an owner-proof floor, alongside an idle-logout timeout.

### 7. "Change my password" for everyone

In every signed-in account's profile menu, regardless of Settings access. `POST /auth/password`
— current password required, writes `password_changed`. An administrator resetting *someone
else's* password is `accounts.reset_password`, writes `password_reset`, and can set
`must_change_password` so the holder is forced to change it on next sign-in.

### 8. One password policy

The 10-vs-12 split collapses to a single `MIN_PASSWORD_LENGTH`, read by `assertUsable` and every
grant path, editable in Security policy above a hard floor.

### It lands in phases, deployable at each one

1. **Foundations, server-only.** Migration `0044` (`person.role`, `person.suspended_at`,
   `person.must_change_password`, `person.removed_at`; `access_event`; `person_permission`).
   `domain/roles.ts`. Password-policy unification. `POST /auth/password`. `login()` writes
   `login_succeeded` / `login_failed`. No shell change.
2. **The accounts model server-side.** `requirePermission`. `api/settings.ts` — list, create,
   set role, set/clear permission, suspend/reactivate, reset password, force-logout, remove.
   `requireAdministration` re-expressed as `requirePermission` across `api/admin.ts` and the
   roster / capability / layout routes. `GET /settings/access-log`.
3. **The Settings panel.** Nav item, lazy bundle, Overview + Accounts + Access log + Security
   policy, styled like Administration. `CACHE` bump.
4. **The move.** *Which screens are on* and *Dashboard layout* leave the Administration console
   for Settings; Administration keeps rosters / groups / deadlines / backups / history. Signpost
   left where each control was.
5. **Optional, later.** TOTP MFA (RFC 6238, `node:crypto`, no dependency) for `owner` / `admin`.

`npm run check` green before any deploy; migrations carry no `RAISE` and no guard (O-40);
deployed in a quiet window.

## Rationale

**Why a top-level panel and not a tab.** The owner asked for it, twice, plainly. It also draws
the cleaner line: Administration is the *district's* record and Settings is *this software's*
configuration and *its* accounts — two kinds of decision, and folding them into one console is
how *"turn off a screen"* ends up next to *"hand over a duty post"*.

**Why role + overrides, not roles alone.** Four roles cannot say *"this one Operator may also
reset passwords"* or *"this Admin may not see the roster"* without breeding a dozen half-roles.
Overrides keep the list short and every exception an explicit, audited row. Deny-wins is the
precedence every operator has already met elsewhere.

**Why extend ADR-0003's philosophy but not its table.** `authority.ts` answers *"who owns this
incident field, and who may override it, with a reason"*. Account management has no incident, no
field, and no override-with-reason — and routing it through `evaluateWrite` would demand a typed
justification on every ordinary role change, which is the exact trap ADR-0024 stepped around. So
this is a **sibling** declarative table: same principle (authority is data an administrator
reads), its own module.

**Why no external IdP.** ADR-0007. One person operable at 02:00, no Keycloak, no OAuth round
trip that fails when the district's line does. `node:crypto` sessions and a permissions table are
the whole of it.

## Consequences

### We gain

* A true administrator / super-administrator, and non-admin accounts that differ.
* Per-account restriction and elevation, explicit and audited.
* Self-service password change; forced change on reset.
* A persisted access and login history.
* `revokeAllForPerson` finally wired to a button.
* One password policy instead of two.

### We give up

* *"One boolean, one gate."* Every Settings endpoint now names a permission.
* `identity.isAdministration` is superseded by `role`. Migration `0044` backfills `owner` for the
  current single administration account, `admin` for any other administration-ticked seat,
  `operator` for everyone else who can sign in. `isAdministration` stays on `Identity` as a
  derived convenience (`role === 'owner' || role === 'admin'`) so nothing reading it breaks in
  the same change.
* `requireAdministration` → `requirePermission(identity, …)` across `api/admin.ts` and the
  roster / capability / layout routes — wide, but mechanical, and each call site names what it
  actually needs.

### We must therefore also

* Bump `CACHE`; add `settings.js` / `settings.css` as a lazy bundle (shell budget — CLAUDE.md §5).
* Put one decision to the owner in `backlog/for-the-owner.md`: **how the single `owner` account
  is established** — set at go-live from the installer, and recoverable by a break-glass CLI
  (`npm run grant-login` style) if it is ever lost — since it cannot be created or reset from
  inside the app by anyone below it.
* Keep the migration guard-free (O-40) and `npm run check` green before deploy.

## Alternatives considered

**A tab inside Administration.** Rejected by the owner (message 3): it must be its own panel.

**Roles only, no overrides.** Rejected — it multiplies the role count and buries every exception
inside a role name nobody can inspect.

**Reuse `authority.ts`.** Rejected — wrong shape, and it would force reason-required overrides
onto ordinary account edits (ADR-0024's lesson).

**JWT with short expiry.** Already rejected in `docs/05-stack.md` for revocation latency;
unchanged here.

**Derive the role from the designation.** Rejected — ADR-0029 §2. Permission from typed words
fails silently on a typo.

## How we would know this was wrong

* **Nobody ever creates a second account.** The district runs for months on the lone `owner`
  login and the role machinery is scaffolding for a building nobody moved into — collapse it back
  toward one account.
* **The same `allow` override keeps getting granted.** That permission belongs in the `operator`
  role and the default was drawn too tight.
* **The access log is never opened during an incident review.** INV-06's cost here was not
  repaid — an argument for making it easier to read, not for removing it.
* **Operators ask *"where is X now?"* more than they did with the single console.** The split
  cost more clarity than it bought.
