/**
 * Server-side sessions, seat-scoped.
 *
 * `docs/05-stack.md` chose server-side sessions over tokens for one reason: **revocation
 * must be instant.** A compromised account in a district emergency system cannot wait for
 * a JWT to expire, and there is no acceptable answer to "how long until that officer loses
 * access?" other than "immediately".
 *
 * The token is never stored. Only its SHA-256 is, so a leaked database hands out no live
 * sessions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import type { Tier } from '../domain/authority.js';
import { ROLES, type Role } from '../domain/roles.js';
import { recordAccessEvent } from '../db/accessLog.js';
import { normalisePhone } from '../ops/directory.js';
import { assertUsable, hashPassword, verifyPassword } from './passwords.js';

/** Long enough to cover a full shift without a re-login during an incident. */
export const SESSION_TTL_HOURS = 12;

export interface Identity {
  readonly personId: string;
  readonly fullName: string;
  /** Null when the person holds no seat right now — authenticated, but with no authority. */
  readonly seatId: string | null;
  readonly departmentId: string | null;
  /**
   * The department's name, so a screen can say whose view it is showing.
   *
   * Null for a department-agnostic seat — the control room and the DC — which is how
   * "district-wide" is expressed rather than being a separate flag.
   */
  readonly departmentName: string | null;
  readonly seatTitle: string | null;
  readonly tier: Tier | null;
  readonly canBreakGlass: boolean;
  /**
   * The account's access role — ADR-0032/0038. `owner` · `admin` · `operator` · `viewer` ·
   * `member`, on `person.role`, an explicit column an administrator sets. NEVER derived from the
   * designation text (ADR-0029 §2). Re-read on every request, like the seat.
   */
  readonly role: Role;
  /**
   * Set when an administrator reset this account's password. Sign-in lands the holder on
   * "change my password" and will not leave until they do (ADR-0032 phase 3).
   */
  readonly mustChangePassword: boolean;
  /**
   * ⚠️ **The access role, and nothing else — `role === 'owner' || role === 'admin'`.** It used
   * to come from `seat.is_administration`; phase 1 kept a `|| seat.is_administration` bridge so
   * suites that had not yet learned to set `person.role` still passed `requireAdministration`,
   * and **ADR-0032 phase 2b (2026-09-01) removed that bridge**. Migration 0044 backfilled the
   * live installation; `seedActor` sets `role: 'admin'` for a `district`-tier seat. Kept on
   * `Identity` because the operational screens (`status.ts`, `contacts.ts`, the dashboard's
   * layout scoping) read it to gate their nav.
   */
  readonly isAdministration: boolean;
}

export interface LoginResult {
  readonly token: string;
  readonly identity: Identity;
}

/** Why a sign-in was refused. Recorded in the journal, never in the response. */
export type LoginRefusal =
  'no-account' | 'ambiguous-number' | 'wrong-password' | 'disabled' | 'suspended' | 'no-identity';

/**
 * What a refused sign-in was, for the district's own journal — never for the response.
 *
 * The response stays one message for every failure, because telling the caller *which* part
 * was wrong hands an attacker the list of real officers. But the people who run this machine
 * are not the attacker, and on 2026-08-27 two brand-new accounts were refused from a browser
 * while the same credentials passed from `curl` seconds apart, with nothing anywhere saying
 * why. A door that refuses without recording what it refused cannot be fixed while somebody
 * is standing outside it.
 *
 * **No value is carried — not the number, not the password, not a hash.** The length is here
 * because it is the one fact that separates *typed it wrong* from *the browser filled in a
 * saved password for a different account*, which is a difference nothing else can see.
 *
 * ⚠️ **The field names avoid the words `phone` and `password` deliberately, and must keep
 * avoiding them.** `redact` in `obs/log.ts` blanks any key whose name *contains* either — a
 * good rule, and the first version of this interface tripped it and logged
 * `"[redacted]"` for both, which is how this note came to be written. A boolean saying
 * whether an account exists and an integer counting characters are not credentials; naming
 * them `phoneKnown` and `passwordLength` made the redactor treat them as though they were.
 */
export interface LoginAttempt {
  /** True when the number matched an account. False means no account holds that number. */
  readonly accountFound: boolean;
  /** How many characters were submitted as the secret. Never the secret itself. */
  readonly submittedLength: number;
  readonly reason: LoginRefusal;
}

/**
 * The number as a comparable key.
 *
 * Sign-in matched `phone = $1` byte for byte until this change. That is right for a machine
 * and wrong for a person: the control room copies a number out of a message, and a trailing
 * space, a dash, spaces between the groups, or a `+92` prefix all read to a human as *the same
 * number* and to Postgres as a different one. Bajaur's two new accounts were refused this way
 * on 2026-08-27, and the screen said "Phone number or password is not correct", which was true
 * of neither.
 *
 * `normalisePhone` is already the project's own definition of *the same number* — it is what
 * wrote these rows into `person` in the first place (`loadDirectory`). The front door now
 * agrees with the loader instead of being stricter than it.
 */
function phoneKey(raw: string): string {
  return normalisePhone(raw.trim()).replace(/\D/g, '');
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

interface IdentityRow {
  person_id: string;
  full_name: string;
  seat_id: string | null;
  seat_title: string | null;
  tier: Tier | null;
  can_break_glass: boolean | null;
  role: string;
  must_change_password: boolean | null;
}

/**
 * A stored role that is not a known one is read as the least-privileged, never trusted. That is
 * `member` since ADR-0038 — `viewer` is not enforced on operational writes (PLAN.md §4).
 */
function toRole(value: string): Role {
  return (ROLES as readonly string[]).includes(value) ? (value as Role) : 'member';
}

function toIdentity(r: IdentityRow): Identity {
  const role = toRole(r.role);
  return {
    personId: r.person_id,
    fullName: r.full_name,
    seatId: r.seat_id,
    seatTitle: r.seat_title,
    role,
    mustChangePassword: r.must_change_password === true,
    /**
     * ⚠️ ALWAYS NULL SINCE ADR-0030, AND KEPT RATHER THAN REMOVED.
     *
     * The same road ADR-0018, ADR-0022, ADR-0023 and ADR-0029 all built: the field survives in
     * the type so nothing reading it has to be rewritten in the same change that removes the
     * thing it described, and nothing writes it any more.
     *
     * It matters here more than it did there, because these two are read by SCOPING code.
     * `viewerFor` keys on tier and treats a null department as *not one department's* — which
     * is now true of everybody, which is exactly what ADR-0024 decided when it left no
     * department holding an account. So the narrowing paths do not fail, they stop narrowing,
     * and that is the intended answer rather than a gap to be patched.
     */
    departmentId: null,
    departmentName: null,
    tier: r.tier,
    canBreakGlass: r.can_break_glass === true,
    /**
     * ⚠️ **Authority is the access role now — ADR-0032 phase 2b (2026-09-01) removed the
     * seat-tick bridge.** Through phase 1 this also read `|| r.is_administration === true`, so a
     * suite that inserted a bare administration seat kept passing `requireAdministration` before
     * it had learned to set `person.role`. `seedActor` sets `role: 'admin'` for a
     * `district`-tier seat, migration 0044 backfilled the live installation, and every gate
     * (`requireAdministration`, `mayEditRoster`, `reachContacts`, the Settings endpoints) now
     * answers from this one value. `seat.is_administration` still exists — it drives the `tier`
     * trigger (migration 0042) — but it no longer confers account authority.
     */
    isAdministration: role === 'owner' || role === 'admin',
  };
}

/**
 * Authenticate and open a session.
 *
 * Returns null for every failure — unknown phone, wrong password, disabled account — with
 * no indication of which. Distinguishing them tells an attacker which numbers are real
 * officers, which is exactly the list they want.
 */
export async function login(
  pool: Pool,
  phone: string,
  password: string,
  audit?: (attempt: LoginAttempt) => void,
): Promise<LoginResult | null> {
  const typed = phone.trim();
  const key = phoneKey(phone);

  // Only people who can actually authenticate are candidates.
  //
  // A phone number no longer identifies exactly one person: two officers may share an office
  // handset, and both are in the directory (migration 0006). Directory entries have no
  // password hash and cannot sign in, so excluding them here keeps "who is signing in?"
  // single-valued. Without this filter the query could return the contact row and the
  // account row and pick between them arbitrarily.
  //
  // A removed account (`removed_at IS NOT NULL`) keeps its hash — removal is not a DELETE
  // (ADR-0001) — but it is not a sign-in candidate: `resolveIdentity` already refuses it, and
  // migration 0045 stops it holding the phone number's uniqueness slot. Filtered here too so
  // the two agree, and so a removed number's login attempt is a plain `no-account` rather than
  // a later `no-identity`.
  const res = await pool.query<{
    person_id: string;
    phone: string;
    password_hash: string;
    disabled_at: string | null;
    suspended_at: string | null;
  }>(
    `SELECT person_id, phone, password_hash, disabled_at, suspended_at
       FROM person
      WHERE password_hash IS NOT NULL
        AND removed_at IS NULL
        AND (phone = $1 OR ($2 <> '' AND regexp_replace(phone, '[^0-9]', '', 'g') = $2))`,
    [typed, key],
  );

  /**
   * Exact first, then an *unambiguous* normalised match.
   *
   * Two stored numbers can share one key — `03001234567` and `3001234567` are one handset
   * written twice. Taking `rows[0]` there would make **which account you get** depend on the
   * order Postgres felt like returning, on the query that decides authority; it is the same
   * trap `resolveIdentity` documents below. When the key is ambiguous and nothing matched
   * exactly this refuses, because an officer the control room can let back in is a smaller
   * failure than an officer quietly signed in as somebody else.
   */
  const exact = res.rows.find((r) => r.phone === typed);
  const row = exact ?? (res.rows.length === 1 ? res.rows[0] : undefined);

  // Always run a verification, even with no such person, so the response time does not
  // reveal whether the number exists.
  const hash =
    row?.password_hash ??
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, hash);

  if (row === undefined || !ok || row.disabled_at !== null || row.suspended_at !== null) {
    const reason: LoginRefusal =
      res.rows.length === 0
        ? 'no-account'
        : row === undefined
          ? 'ambiguous-number'
          : row.disabled_at !== null
            ? 'disabled'
            : row.suspended_at !== null
              ? 'suspended'
              : 'wrong-password';
    audit?.({
      accountFound: res.rows.length > 0,
      submittedLength: password.length,
      reason,
    });
    // ADR-0032: the Access log's "failed attempts". No value is carried — not the number, not
    // the secret — only whether an account matched, how long the secret was, and why it was
    // refused, which is the same discipline `LoginAttempt` follows.
    await recordAccessEvent(pool, {
      type: 'login_failed',
      subjectPersonId: row?.person_id ?? null,
      reason,
      after: { accountFound: res.rows.length > 0, submittedLength: password.length },
    }).catch(() => {
      // A login is not failed harder because the log write failed. Swallow.
    });
    return null;
  }

  const identity = await resolveIdentity(pool, row.person_id);
  if (identity === null) {
    audit?.({ accountFound: true, submittedLength: password.length, reason: 'no-identity' });
    await recordAccessEvent(pool, {
      type: 'login_failed',
      subjectPersonId: row.person_id,
      reason: 'no-identity',
      after: { submittedLength: password.length },
    }).catch(() => {});
    return null;
  }

  return startSession(pool, identity);
}

/**
 * A new session for someone already proven to be who they are — by their password (`login`), or
 * by a sign-in link they have just used to set one (ADR-0043). One place, so both doors issue the
 * same kind of session and write the same `login_succeeded` line.
 */
export async function startSession(pool: Pool, identity: Identity): Promise<LoginResult> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, person_id, seat_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hashToken(token), identity.personId, identity.seatId, SESSION_TTL_HOURS],
  );

  await recordAccessEvent(pool, {
    type: 'login_succeeded',
    actorPersonId: identity.personId,
    subjectPersonId: identity.personId,
    after: { seatId: identity.seatId, role: identity.role },
  }).catch(() => {});

  return { token, identity };
}

/** The seat a person holds *right now*. Null seat means no current duty assignment. */
/**
 * A person can hold **more than one seat at once** — M10-05's audit of the live directory found
 * three (Imran: C&W Buildings and C&W Highways; Naveed: two Irrigation posts; Zubair Ahmad: ADC
 * General and ADC Relief). `LEFT JOIN duty_assignment ... to_at IS NULL` can therefore return
 * more than one row for one `person_id`, and this function has always taken `res.rows[0]` —
 * **without an `ORDER BY`, which of the two seats came back was whatever order Postgres felt
 * like giving them, and could differ between one request and the next for the same person.**
 * That is authority itself being non-deterministic, on the query every session resolves through.
 *
 * `ORDER BY d.from_at ASC` — the post held **longest** wins, deterministically. It is a
 * stopgap, stated as one: this system has no concept of an officer *switching* which of their
 * seats they are acting as, and picking the oldest is a defensible default rather than a
 * considered answer to "which seat is this person right now" — that question is ADR-0004's and
 * is not decided here. All three known cases are department-tier and hold no login today
 * (ADR-0018: only the two administrative offices sign in), so this is dormant in production —
 * fixed anyway, because "dormant" is exactly the condition under which nobody would have
 * noticed it start mattering.
 */
export async function resolveIdentity(pool: Pool, personId: string): Promise<Identity | null> {
  const res = await pool.query<IdentityRow>(
    `SELECT p.person_id,
            p.full_name,
            s.seat_id,
            s.title        AS seat_title,
            s.tier,
            s.can_break_glass,
            -- ADR-0032 phase 2b: account authority is p.role, never the seat.
            -- seat.is_administration is no longer read here -- it still drives the tier
            -- trigger (migration 0042), and s.tier above is what scoping keys on, but
            -- whether an account may administer is the access role and nothing else.
            --
            -- WARNING: what must never come back is deriving authority from the designation TEXT
            -- (ADR-0029 section 2). A typo, a rename or an officer entered as
            -- "AC HQ (acting)" would move who may issue a district advisory, silently, with
            -- nothing on any screen showing that it had happened.
            p.role,
            p.must_change_password
       FROM person p
       LEFT JOIN duty_assignment d
              ON d.person_id = p.person_id AND d.to_at IS NULL
       LEFT JOIN seat s ON s.seat_id = d.seat_id
      WHERE p.person_id = $1
        AND p.disabled_at IS NULL
        AND p.suspended_at IS NULL
        AND p.removed_at IS NULL
      ORDER BY d.from_at ASC
      LIMIT 1`,
    [personId],
  );

  const row = res.rows[0];
  return row === undefined ? null : toIdentity(row);
}

/**
 * Resolve a bearer token to an identity, or null.
 *
 * The seat is re-resolved from the current roster on every request rather than trusted
 * from the session row. If an officer was relieved of a post ten seconds ago, the next
 * request must reflect that — a cached seat would leave real authority in the hands of
 * someone who no longer holds the post.
 */
export async function resolveSession(pool: Pool, token: string): Promise<Identity | null> {
  if (token.length === 0 || token.length > 200) return null;

  const res = await pool.query<{ session_id: string; token_hash: Buffer; person_id: string }>(
    `SELECT session_id, token_hash, person_id
       FROM session
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [hashToken(token)],
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  // Belt and braces: the lookup was already by exact hash, but compare in constant time
  // so this stays correct if the query is ever loosened.
  const expected = hashToken(token);
  if (row.token_hash.length !== expected.length || !timingSafeEqual(row.token_hash, expected)) {
    return null;
  }

  await pool.query('UPDATE session SET last_seen_at = now() WHERE session_id = $1', [
    row.session_id,
  ]);

  return resolveIdentity(pool, row.person_id);
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(
    'UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}

/** Revoke every session for a person. The response to a compromised account. */
export async function revokeAllForPerson(pool: Pool, personId: string): Promise<number> {
  const res = await pool.query(
    'UPDATE session SET revoked_at = now() WHERE person_id = $1 AND revoked_at IS NULL',
    [personId],
  );
  return res.rowCount ?? 0;
}

export type PasswordChangeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'no-session' | 'wrong-current' | 'weak';
      readonly message: string;
    };

/**
 * Change one's own password — ADR-0032. Available to every signed-in account, whatever its
 * role, from the profile menu.
 *
 * The current password is required: a session left open on a shared handset must not be a way
 * to lock the real holder out. On success, **every other session for this person is revoked**
 * and the caller's is kept — a password change is also the answer to *"I think someone else is
 * signed in as me"*. `must_change_password` is cleared, so a forced-reset account leaves the
 * "change my password" screen the moment it complies.
 */
export async function changeOwnPassword(
  pool: Pool,
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeResult> {
  const tokenHash = hashToken(token);

  const sess = await pool.query<{ person_id: string }>(
    `SELECT person_id FROM session
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  const personId = sess.rows[0]?.person_id;
  if (personId === undefined) {
    return { ok: false, reason: 'no-session', message: 'authentication required' };
  }

  const who = await pool.query<{ password_hash: string | null }>(
    'SELECT password_hash FROM person WHERE person_id = $1',
    [personId],
  );
  const stored = who.rows[0]?.password_hash ?? null;
  if (stored === null || !(await verifyPassword(currentPassword, stored))) {
    return { ok: false, reason: 'wrong-current', message: 'current password is not correct' };
  }

  try {
    assertUsable(newPassword);
  } catch (e) {
    return { ok: false, reason: 'weak', message: (e as Error).message };
  }

  const hash = await hashPassword(newPassword);
  await pool.query(
    'UPDATE person SET password_hash = $2, must_change_password = false WHERE person_id = $1',
    [personId, hash],
  );
  await pool.query(
    `UPDATE session SET revoked_at = now()
      WHERE person_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
    [personId, tokenHash],
  );
  await recordAccessEvent(pool, {
    type: 'password_changed',
    actorPersonId: personId,
    subjectPersonId: personId,
  }).catch(() => {});

  return { ok: true };
}
