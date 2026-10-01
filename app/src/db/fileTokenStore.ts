/**
 * The link that carries a file to a handset — M9-18.
 *
 * Modelled on `whatsappStore.ts`'s acknowledge token, deliberately and almost line for line,
 * because the problem is the same one: **an officer who holds no account, on a personal handset,
 * needs to reach exactly one thing this system holds.** `/evidence/:id` cannot serve them — it
 * requires a session and authority over the incident, which most of the district's directory
 * does not have (M0-51).
 *
 * ## Three differences from the acknowledge token, each with a reason
 *
 * **It is not single-use.** An officer opens the notice, closes WhatsApp, and opens it again at
 * the meeting on Thursday. A token that died on first use is indistinguishable from a broken
 * link, and the officer's next action is a telephone call to the control room — which is the
 * thing this whole system exists to remove.
 *
 * **It lives longer.** A meeting notice sent on Monday for a Thursday meeting must open on
 * Thursday. Time is the whole of this token's safety, so the number is a real decision rather
 * than a default, and it is stated below.
 *
 * **`person_id` is recorded and never enforced.** It answers *who was this minted for* for the
 * audit trail. Enforcing it would require identifying whoever opened the link, and the only
 * thing that could identify them is the token itself — a circular check that would also break
 * the ordinary case of an officer forwarding the notice to their own department.
 *
 * ## What is stored is a hash
 *
 * The same rule as the acknowledge token and as passwords: a database dump, or a backup that
 * leaves the district (and one does, nightly), must not contain working links to the district's
 * files. What is in the table cannot be put in a URL.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from './pool.js';
import type { Uuid } from '../domain/events.js';

/**
 * How long a file link works.
 *
 * **Fourteen days**, and the number is a judgement rather than a convention. The acknowledge
 * token's 24 hours is right for its job: an emergency acknowledged tomorrow was not
 * acknowledged. A file is the opposite — a schedule issued for next week is *supposed* to be
 * opened next week, and the district also sends meeting notices several days ahead.
 *
 * Shorter would produce the failure this project cares most about: an officer standing at a
 * meeting, opening the notice, and finding it dead. Longer starts to mean a link pasted into a
 * WhatsApp group in March still works in June, which is a leak with a long tail.
 */
export const FILE_TOKEN_TTL_DAYS = 14;

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export interface FileTokenSubject {
  readonly evidenceId: Uuid;
  readonly incidentId: Uuid;
  readonly seatId: Uuid | null;
  readonly personId: Uuid | null;
}

/**
 * Mint a link for one file and one recipient.
 *
 * **One token per recipient, never one shared token per file.** Two officers who both received
 * the notice hold two different links, so `opened_count` answers *which of them opened it* and
 * not merely *whether anybody did* — and revoking one recipient's access later is possible at
 * all. A shared token would make both questions unanswerable.
 */
export async function mintFileToken(pool: Pool, subject: FileTokenSubject): Promise<string> {
  // 32 bytes, url-safe. It travels inside a WhatsApp message, where anything a phone might
  // "helpfully" reformat is a link that silently stops working.
  const token = randomBytes(32).toString('base64url');

  await pool.query(
    `INSERT INTO file_token (token_hash, evidence_id, incident_id, seat_id, person_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
    [
      hash(token),
      subject.evidenceId,
      subject.incidentId,
      subject.seatId,
      subject.personId,
      FILE_TOKEN_TTL_DAYS,
    ],
  );

  return token;
}

export type FileTokenResult =
  | { readonly ok: true; readonly subject: FileTokenSubject }
  | { readonly ok: false; readonly why: 'unknown' | 'expired' };

/**
 * Read a file link **without counting it as opened** — 2026-08-14.
 *
 * The link an officer taps now draws a page before it serves any bytes, so there are two reads
 * of one token where there used to be one. `opened_count` is the district's only answer to
 * *"did this officer actually see the notice?"*, and a page that a WhatsApp preview crawler
 * fetches is not that officer seeing anything — so the page peeks and only `/file/:token/raw`
 * redeems. The count keeps meaning **the bytes went out**, which is what it has always meant.
 *
 * Deliberately a separate function rather than a flag on `redeemFileToken`: a boolean parameter
 * that decides whether an audit column moves is exactly the kind of argument somebody passes
 * wrongly at 02:00, and the two call sites are two sentences apart in `server.ts`.
 */
export async function peekFileToken(pool: Pool, token: string): Promise<FileTokenResult> {
  const { rows } = await pool.query<{
    evidence_id: string;
    incident_id: string;
    seat_id: string | null;
    person_id: string | null;
  }>(
    `SELECT evidence_id, incident_id, seat_id, person_id
       FROM file_token
      WHERE token_hash = $1
        AND expires_at > now()`,
    [hash(token)],
  );

  const row = rows[0];
  if (row !== undefined) {
    return {
      ok: true,
      subject: {
        evidenceId: row.evidence_id,
        incidentId: row.incident_id,
        seatId: row.seat_id,
        personId: row.person_id,
      },
    };
  }

  const { rows: found } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM file_token WHERE token_hash = $1',
    [hash(token)],
  );

  return { ok: false, why: Number(found[0]?.n ?? 0) > 0 ? 'expired' : 'unknown' };
}

/**
 * Spend a file link — or rather, use one, since it is not spent.
 *
 * **`unknown` and `expired` are two answers, not one.** *"This link is too old"* and *"this link
 * is not recognised"* send an officer to two different next actions, and a single "invalid"
 * sends them to the telephone at 02:00. The same distinction `redeemAckToken` draws, for the
 * same reason.
 *
 * The open is counted in the same statement that reads the row, so a reader cannot forget to
 * record it and two concurrent opens cannot lose one another.
 */
export async function redeemFileToken(pool: Pool, token: string): Promise<FileTokenResult> {
  const { rows } = await pool.query<{
    evidence_id: string;
    incident_id: string;
    seat_id: string | null;
    person_id: string | null;
    expired: boolean;
  }>(
    `UPDATE file_token
        SET opened_count = opened_count + 1,
            last_opened_at = now()
      WHERE token_hash = $1
        AND expires_at > now()
      RETURNING evidence_id, incident_id, seat_id, person_id, false AS expired`,
    [hash(token)],
  );

  const row = rows[0];
  if (row !== undefined) {
    return {
      ok: true,
      subject: {
        evidenceId: row.evidence_id,
        incidentId: row.incident_id,
        seatId: row.seat_id,
        personId: row.person_id,
      },
    };
  }

  /**
   * Nothing was updated. Two causes, and telling them apart takes a second read.
   *
   * Worth the extra query: this only runs on the failure path, and the alternative is an
   * officer at a meeting being told "not recognised" about a link that simply aged out.
   */
  const { rows: found } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM file_token WHERE token_hash = $1',
    [hash(token)],
  );

  return { ok: false, why: Number(found[0]?.n ?? 0) > 0 ? 'expired' : 'unknown' };
}

/**
 * Delete tokens that expired more than a week ago.
 *
 * A week after expiry rather than at expiry, so that `redeemFileToken` can still tell an
 * officer *"this link is too old"* rather than *"not recognised"* for the period where somebody
 * is actually likely to tap an old one. A token table that only grows is a table somebody
 * eventually truncates by hand at 02:00.
 */
export async function sweepExpiredFileTokens(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    "DELETE FROM file_token WHERE expires_at < now() - interval '7 days'",
  );
  return rowCount ?? 0;
}
