/**
 * A sign-in link: the officer sets their own password (ADR-0043, Bajaur — E5).
 *
 * The rules are the acknowledge link's (`db/whatsappStore.ts`), for the same reasons:
 *
 *   * **Only the token's SHA-256 is stored.** A leaked database must hand out no live sign-in.
 *   * **Opening it spends nothing.** WhatsApp fetches a link to draw its preview, and a preview
 *     crawler must never set anybody's password. `peekLoginLink` draws the page; only the form's
 *     submit (`redeemLoginLink`) uses the link.
 *   * **Once, and not for long.** 72 hours — an officer may not read the message the same day,
 *     but a link that lives for weeks in a chat history is a password lying around. A newer link
 *     for the same person cancels an older unused one; an account that is suspended, removed or
 *     disabled has no working link.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

import { recordAccessEvent } from '../db/accessLog.js';
import { assertUsable, hashPassword } from './passwords.js';
import { resolveIdentity, startSession, type LoginResult } from './sessions.js';

export const LOGIN_LINK_TTL_HOURS = 72;

export type LinkSentVia = 'whatsapp' | 'by_hand' | 'failed';

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * A password nobody knows — for an account given with a link instead of a typed password. The
 * account exists and is a login (the rest of the system reads "has a password" as "can sign
 * in"), but nobody can use it until the link sets a real one.
 */
export async function unknowablePassword(): Promise<string> {
  return hashPassword(randomBytes(32).toString('base64url'));
}

/**
 * A new link for `personId`. Any unused one is cancelled first, so only the newest works. The
 * caller sends it and then records how (`noteLinkSent`); until then it reads as `by_hand`.
 */
export async function mintLoginLink(
  pool: Pool,
  personId: string,
  issuedBy: string | null,
): Promise<{ readonly token: string; readonly expiresAt: string }> {
  // 32 bytes, url-safe: it travels at the end of a URL in a WhatsApp button.
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `UPDATE login_link SET revoked_at = now()
      WHERE person_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [personId],
  );
  // Timestamps come back as text in this project's pool, or as a Date in another; either reads.
  const row = await pool.query<{ expires_at: string | Date }>(
    `INSERT INTO login_link (token_hash, person_id, issued_by, expires_at, sent_via)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), 'by_hand')
     RETURNING expires_at`,
    [hash(token), personId, issuedBy, LOGIN_LINK_TTL_HOURS],
  );
  return { token, expiresAt: new Date(row.rows[0]!.expires_at).toISOString() };
}

/** How the link went out — what the DC is told, and what the Officers tab shows later. */
export async function noteLinkSent(
  pool: Pool,
  token: string,
  sentVia: LinkSentVia,
  failure: string | null,
  issuedBy: string | null,
  personId: string,
): Promise<void> {
  await pool.query('UPDATE login_link SET sent_via = $2, send_failure = $3 WHERE token_hash = $1', [
    hash(token),
    sentVia,
    failure,
  ]);
  await recordAccessEvent(pool, {
    type: 'login_link_issued',
    actorPersonId: issuedBy,
    subjectPersonId: personId,
    after: { sentVia, ...(failure === null ? {} : { failure }) },
  }).catch(() => {});
}

export type LinkRefusal = 'unknown' | 'used' | 'expired' | 'cancelled' | 'inactive';

const REFUSAL_TEXT: Readonly<Record<LinkRefusal, string>> = {
  unknown: 'This link is not valid. Ask the DC office for a new one.',
  used: 'This link has already been used. Sign in with your phone number and password.',
  expired: 'This link has expired. Ask the DC office for a new one.',
  cancelled: 'A newer link was sent for this account. Use the newest one.',
  inactive: 'This account cannot sign in. Ask the DC office.',
};

export type PeekResult =
  | { readonly ok: true; readonly fullName: string; readonly phone: string }
  | { readonly ok: false; readonly reason: LinkRefusal; readonly message: string };

interface LinkRow {
  person_id: string;
  used_at: string | Date | null;
  revoked_at: string | Date | null;
  expired: boolean;
  full_name: string;
  phone: string;
  active: boolean;
}

const LINK_QUERY = `
  SELECT l.person_id, l.used_at, l.revoked_at, (l.expires_at <= now()) AS expired,
         p.full_name, p.phone,
         (p.removed_at IS NULL AND p.suspended_at IS NULL AND p.disabled_at IS NULL
          AND p.password_hash IS NOT NULL) AS active
    FROM login_link l JOIN person p ON p.person_id = l.person_id
   WHERE l.token_hash = $1`;

function refusal(row: LinkRow | undefined): LinkRefusal | null {
  if (row === undefined) return 'unknown';
  if (row.used_at !== null) return 'used';
  if (row.revoked_at !== null) return 'cancelled';
  if (row.expired) return 'expired';
  if (!row.active) return 'inactive';
  return null;
}

/** Whose link this is, without using it — what the page draws on a GET. */
export async function peekLoginLink(pool: Pool, token: string): Promise<PeekResult> {
  const found = await pool.query<LinkRow>(LINK_QUERY, [hash(token)]);
  const row = found.rows[0];
  const refused = refusal(row);
  if (refused !== null) return { ok: false, reason: refused, message: REFUSAL_TEXT[refused] };
  return { ok: true, fullName: row!.full_name, phone: row!.phone };
}

export type RedeemResult =
  | ({ readonly ok: true } & LoginResult)
  | {
      readonly ok: false;
      readonly reason: LinkRefusal | 'weak';
      readonly message: string;
    };

/**
 * Use the link: set the password, end every other session of the account, and sign in.
 *
 * In one transaction with the link's row locked, so two taps on the same link (a double submit,
 * two handsets) cannot both set a password: the second finds it used.
 */
export async function redeemLoginLink(
  pool: Pool,
  token: string,
  password: string,
): Promise<RedeemResult> {
  try {
    assertUsable(password);
  } catch (e) {
    return { ok: false, reason: 'weak', message: (e as Error).message };
  }
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  let personId: string;
  try {
    await client.query('BEGIN');
    const found = await client.query<LinkRow>(`${LINK_QUERY} FOR UPDATE OF l`, [hash(token)]);
    const row = found.rows[0];
    const refused = refusal(row);
    if (refused !== null) {
      await client.query('ROLLBACK');
      return { ok: false, reason: refused, message: REFUSAL_TEXT[refused] };
    }
    personId = row!.person_id;
    await client.query('UPDATE login_link SET used_at = now() WHERE token_hash = $1', [
      hash(token),
    ]);
    await client.query(
      'UPDATE person SET password_hash = $2, must_change_password = false WHERE person_id = $1',
      [personId, passwordHash],
    );
    // Whoever was signed in as this account before — with the old password, or a handset left
    // signed in — is signed out: the person holding the link has just become the account.
    await client.query(
      'UPDATE session SET revoked_at = now() WHERE person_id = $1 AND revoked_at IS NULL',
      [personId],
    );
    await recordAccessEvent(client, {
      type: 'login_link_used',
      actorPersonId: personId,
      subjectPersonId: personId,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const identity = await resolveIdentity(pool, personId);
  if (identity === null) {
    // The password is set; only the automatic sign-in could not happen (no current duty, say).
    // The page sends them to the sign-in screen, where the new password works.
    return { ok: false, reason: 'inactive', message: 'Your password is set. Sign in to continue.' };
  }
  return { ok: true, ...(await startSession(pool, identity)) };
}

/** The newest link for a person, for the DC's screens: is one waiting, and how was it sent? */
export interface LinkStatus {
  readonly sentVia: LinkSentVia;
  readonly sendFailure: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: 'waiting' | 'used' | 'expired' | 'cancelled';
}

export async function latestLinkFor(pool: Pool, personId: string): Promise<LinkStatus | null> {
  const found = await pool.query<{
    sent_via: LinkSentVia;
    send_failure: string | null;
    created_at: string | Date;
    expires_at: string | Date;
    used_at: string | Date | null;
    revoked_at: string | Date | null;
    expired: boolean;
  }>(
    `SELECT sent_via, send_failure, created_at, expires_at, used_at, revoked_at,
            (expires_at <= now()) AS expired
       FROM login_link WHERE person_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [personId],
  );
  const r = found.rows[0];
  if (r === undefined) return null;
  return {
    sentVia: r.sent_via,
    sendFailure: r.send_failure,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    state:
      r.used_at !== null
        ? 'used'
        : r.revoked_at !== null
          ? 'cancelled'
          : r.expired
            ? 'expired'
            : 'waiting',
  };
}
