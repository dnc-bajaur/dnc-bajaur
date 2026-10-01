/**
 * The two things the event log genuinely cannot be — M6-19, M6-22.
 *
 * Everything else in this system folds from the log (ADR-0001), and these two do not, for one
 * reason each:
 *
 *   * **A provider's message id is born in the middle of the order of operations INV-03 rests
 *     on.** The attempt is recorded, *then* the message is sent, *then* the outcome is
 *     recorded. Meta's id exists only after the second step, and a webhook arriving an hour
 *     later carries that id and nothing else. Something has to map one to the other.
 *   * **An acknowledge token must be single-use.** "Has this been used" is a fact that
 *     *changes*, which is precisely what an append-only log cannot represent without a second
 *     query per tap — and the whole point of the link is that it works in one.
 *
 * Both are lookup tables, and neither is history. Every state change either of them learns
 * about is still **appended to the log** as a `notification_delivered`, a `notification_failed`
 * or an `acknowledged` event. Drop both tables and the district loses the ability to interpret
 * future webhooks and future taps; it loses no record of anything that happened.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from './pool.js';
import type { AccountNotice, ProviderStatus } from '../ops/whatsapp.js';

/** How long an acknowledge link works for. */
export const ACK_TTL_HOURS = 24;

export interface SentMessage {
  readonly providerMessageId: string;
  readonly attemptId: string;
  readonly incidentId: string;
  readonly toPhone: string;
}

/** Note that a message left the building, so a webhook about it can be understood later. */
export async function recordSent(pool: Pool, message: SentMessage): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_message (provider_message_id, attempt_id, incident_id, to_phone, status)
     VALUES ($1, $2, $3, $4, 'sent')
     ON CONFLICT (provider_message_id) DO NOTHING`,
    [message.providerMessageId, message.attemptId, message.incidentId, message.toPhone],
  );
}

export interface TrackedMessage {
  readonly attemptId: string;
  readonly incidentId: string;
  readonly status: ProviderStatus | 'queued';
}

/**
 * Move a message to a new status, and say whether that is news.
 *
 * Returns null when the webhook refers to a message this district never sent — which happens,
 * because a Meta account can be shared with a test harness and because webhooks are retried
 * for hours across a redeploy. Acting on an unknown id would mean appending an outcome event
 * for an attempt that does not exist.
 *
 * `changed` is what stops a retried webhook appending a second `notification_delivered`. Meta
 * retries on any non-2xx and on a timeout, so the same delivery arrives more than once as a
 * matter of routine — not an edge case.
 */
export async function applyStatus(
  pool: Pool,
  providerMessageId: string,
  status: ProviderStatus,
  failure: string | null,
): Promise<{ readonly message: TrackedMessage; readonly changed: boolean } | null> {
  const existing = await pool.query<{ attempt_id: string; incident_id: string; status: string }>(
    'SELECT attempt_id, incident_id, status FROM whatsapp_message WHERE provider_message_id = $1',
    [providerMessageId],
  );

  const row = existing.rows[0];
  if (row === undefined) return null;

  /**
   * Statuses arrive out of order, routinely, and a later one must never be overwritten by an
   * earlier one.
   *
   * Meta delivers `sent`, `delivered` and `read` as three separate webhooks over an unordered
   * channel. Without this, a `sent` arriving after a `delivered` would walk the message
   * backwards — and on a screen that reads "delivered, then sent again" the district would be
   * right to stop believing any of it.
   *
   * `failed` is deliberately outside the ordering: it is not a later rung, it is the message
   * having stopped, and it can legitimately follow `sent`.
   */
  const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
  const goingBackwards = status !== 'failed' && (RANK[status] ?? 0) <= (RANK[row.status] ?? 0);

  if (goingBackwards) {
    return {
      message: {
        attemptId: row.attempt_id,
        incidentId: row.incident_id,
        status: row.status as ProviderStatus | 'queued',
      },
      changed: false,
    };
  }

  await pool.query(
    `UPDATE whatsapp_message
        SET status = $2, failure = $3, updated_at = now()
      WHERE provider_message_id = $1`,
    [providerMessageId, status, failure],
  );

  return {
    message: {
      attemptId: row.attempt_id,
      incidentId: row.incident_id,
      status,
    },
    changed: true,
  };
}

/**
 * The most recent message sent to a number — M6-23.
 *
 * How an inbound reply is matched to an incident, and **the match is inferred**, which is why
 * the screen has to say so. An officer who was told about two emergencies in ten minutes and
 * replies "on my way" is answering one of them, and nothing in the message says which. Guessing
 * the most recent is the best available answer and a guess all the same; presenting it as a
 * certainty would put a fact in the record that nobody established.
 */
export async function lastMessageTo(
  pool: Pool,
  phone: string,
  withinHours = 24,
): Promise<SentMessage | null> {
  const res = await pool.query<{
    provider_message_id: string;
    attempt_id: string;
    incident_id: string;
    to_phone: string;
  }>(
    `SELECT provider_message_id, attempt_id, incident_id, to_phone
       FROM whatsapp_message
      WHERE to_phone = $1
        AND sent_at > now() - make_interval(hours => $2)
      ORDER BY sent_at DESC
      LIMIT 1`,
    [phone, withinHours],
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  return {
    providerMessageId: row.provider_message_id,
    attemptId: row.attempt_id,
    incidentId: row.incident_id,
    toPhone: row.to_phone,
  };
}

/**
 * The exact message an officer replied to — 2026-08-21.
 *
 * ## Why this exists beside `lastMessageTo` rather than replacing it
 *
 * `lastMessageTo` answers *"which of our messages is this probably about"* and says, in three
 * places, that the answer is a guess. It has to: a typed *"on my way"* carries nothing that names
 * an incident, and an officer told about two emergencies ten minutes apart is answering one of
 * them with nothing in the message saying which.
 *
 * **But WhatsApp does say which, whenever the officer used its reply control** — and it has said
 * so on every webhook this district has ever received. Meta puts the id of the message being
 * replied to in `context.id`, and that id is our own `provider_message_id`: the primary key of
 * this very table. The guess was being made beside an exact answer nobody was reading.
 *
 * So this is not a replacement. It is the **stronger** of two matches, tried first, with the
 * weaker one still there for the reply that genuinely carries nothing — which is most of them,
 * because typing into the thread is easier than long-pressing a message to reply to it.
 *
 * ⚠️ **A tap on a template's quick reply carries one too.** Meta sends `context` on a
 * `type: "button"` message naming the template message the button sat on — so *Acknowledge* and
 * *Attending*, which have been matched by the number since 19 August, become exact as well.
 *
 * Returns null for an id we have no row for, which is the ordinary state rather than an error:
 * an officer can reply to **their own** earlier message, and Meta reports that the same way.
 */
export async function messageById(
  pool: Pool,
  providerMessageId: string,
): Promise<SentMessage | null> {
  const res = await pool.query<{
    provider_message_id: string;
    attempt_id: string;
    incident_id: string;
    to_phone: string;
  }>(
    `SELECT provider_message_id, attempt_id, incident_id, to_phone
       FROM whatsapp_message
      WHERE provider_message_id = $1`,
    [providerMessageId],
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  return {
    providerMessageId: row.provider_message_id,
    attemptId: row.attempt_id,
    incidentId: row.incident_id,
    toPhone: row.to_phone,
  };
}

//------------------------------------------------------------------------------
// The acknowledge link — M6-22
//------------------------------------------------------------------------------

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * What a token may do — M9-27.
 *
 * `acknowledge` is what the template's one URL button carries. The other two are minted **by the
 * page that button opens**, for the officer who has just proved they are reading it.
 */
export type AckStage = 'acknowledge' | 'respond' | 'resolve' | 'availability' | 'response';

export interface AckSubject {
  readonly attemptId: string;
  readonly incidentId: string;
  readonly seatId: string | null;
  readonly personId: string | null;
  /** Absent on rows minted before M9-27; the column defaults to `acknowledge` for them. */
  readonly stage?: AckStage;
}

/**
 * Mint a single-use acknowledge token.
 *
 * **The token is never stored, only its SHA-256** — the same rule sessions follow, for the same
 * reason: a leaked database must hand out no live acknowledgements. This one matters more than
 * it looks, because these links live in officers' message history for months.
 *
 * The seat and the person are captured **as they are now** and written into the resulting
 * event, so a handover between the message going out and the tap arriving does not silently
 * attribute the acknowledgement to whoever holds the post at that later moment (ADR-0004).
 */
export async function mintAckToken(pool: Pool, subject: AckSubject): Promise<string> {
  // 32 bytes, url-safe. It travels in a URL inside a WhatsApp message, where anything a phone
  // might "helpfully" reformat is a link that silently stops working.
  const token = randomBytes(32).toString('base64url');

  await pool.query(
    `INSERT INTO ack_token
       (token_hash, attempt_id, incident_id, seat_id, person_id, stage, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
    [
      hash(token),
      subject.attemptId,
      subject.incidentId,
      subject.seatId,
      subject.personId,
      subject.stage ?? 'acknowledge',
      /**
       * **The same 24 hours for every stage, and that is a decision.**
       *
       * A longer life for `resolve` was tempting — an emergency can run past midnight. It was
       * refused because the token's whole authority is *this officer was reading this message a
       * moment ago*, and that claim decays. A three-day resolve link is a resolution that can
       * be applied by whoever picks the handset up on Thursday, to a record nobody is watching.
       * Past 24 hours the answer is the app or the control room, and the page says so.
       */
      ACK_TTL_HOURS,
    ],
  );

  return token;
}

/**
 * Read a token **without spending it** — M9-27.
 *
 * The lifecycle page needs this and the acknowledge link does not, because the two are reached
 * differently. The acknowledge link is a URL button in an approved template: it can only ever be
 * a GET, and it has to act on that GET or the district's one button does nothing.
 *
 * *Responded* and *Resolved* are links on a page **this system renders**, so they can be a form
 * that POSTs — and they are. That splits the act in two: `peek` draws the page, redemption
 * happens on the submit. It costs one extra tap and buys two things. **Any GET is safe**, which
 * matters because WhatsApp fetches URLs to build link previews and a preview crawler must never
 * resolve an emergency. And the officer sees what they are about to do to which incident before
 * they do it, rather than discovering it from the confirmation.
 */
export async function peekAckToken(pool: Pool, token: string): Promise<AckRedemption> {
  const found = await pool.query<{
    attempt_id: string;
    incident_id: string;
    seat_id: string | null;
    person_id: string | null;
    stage: AckStage;
    used: boolean;
    expired: boolean;
  }>(
    `SELECT attempt_id, incident_id, seat_id, person_id, stage,
            (used_at IS NOT NULL) AS used, (expires_at <= now()) AS expired
       FROM ack_token WHERE token_hash = $1`,
    [hash(token)],
  );

  const row = found.rows[0];
  if (row === undefined) return { ok: false, why: 'unknown' };
  if (row.used) return { ok: false, why: 'used' };
  if (row.expired) return { ok: false, why: 'expired' };

  return {
    ok: true,
    subject: {
      attemptId: row.attempt_id,
      incidentId: row.incident_id,
      seatId: row.seat_id,
      personId: row.person_id,
      stage: row.stage,
    },
  };
}

export type AckRedemption =
  | { readonly ok: true; readonly subject: AckSubject }
  | { readonly ok: false; readonly why: 'unknown' | 'used' | 'expired' };

/**
 * Spend a token, once.
 *
 * The single-use check and the update are **one statement**, so two taps in the same second
 * cannot both succeed. Read-then-write would leave a window, and the window is not theoretical:
 * a link tapped on a phone that then retries the request is the ordinary case.
 *
 * A used token and an expired one are told apart on purpose. "You have already acknowledged
 * this" and "this link is too old" send an officer to two different next actions, and a single
 * "invalid" sends them to the telephone to ask what happened.
 */
export async function redeemAckToken(pool: Pool, token: string): Promise<AckRedemption> {
  const claimed = await pool.query<{
    attempt_id: string;
    incident_id: string;
    seat_id: string | null;
    person_id: string | null;
    stage: AckStage;
  }>(
    `UPDATE ack_token
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING attempt_id, incident_id, seat_id, person_id, stage`,
    [hash(token)],
  );

  const row = claimed.rows[0];
  if (row !== undefined) {
    return {
      ok: true,
      subject: {
        attemptId: row.attempt_id,
        incidentId: row.incident_id,
        seatId: row.seat_id,
        personId: row.person_id,
        stage: row.stage,
      },
    };
  }

  // It did not claim. Work out which of the three reasons, for the message alone.
  const found = await pool.query<{ used: boolean; expired: boolean }>(
    `SELECT (used_at IS NOT NULL) AS used, (expires_at <= now()) AS expired
       FROM ack_token WHERE token_hash = $1`,
    [hash(token)],
  );

  const state = found.rows[0];
  if (state === undefined) return { ok: false, why: 'unknown' };
  return { ok: false, why: state.used ? 'used' : 'expired' };
}

/**
 * Whether WhatsApp is actually working, for the district's own condition board — M6-25.
 *
 * A gateway out of credit fails silently, and that is the whole reason this exists: an account
 * with no balance, a token that expired, or a template somebody un-approved all look exactly
 * like a quiet night. Counted over a window rather than reported as a last-error, because one
 * failure is noise and a run of them is an outage.
 */
export async function whatsappHealth(
  pool: Pool,
  windowHours = 24,
): Promise<{ readonly sent: number; readonly delivered: number; readonly failed: number }> {
  const res = await pool.query<{ sent: string; delivered: string; failed: string }>(
    `SELECT count(*)::text                                             AS sent,
            count(*) FILTER (WHERE status IN ('delivered','read'))::text AS delivered,
            count(*) FILTER (WHERE status = 'failed')::text             AS failed
       FROM whatsapp_message
      WHERE sent_at > now() - make_interval(hours => $1)`,
    [windowHours],
  );

  const row = res.rows[0];
  return {
    sent: Number(row?.sent ?? 0),
    delivered: Number(row?.delivered ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

//------------------------------------------------------------------------------
// The 24-hour service window, and the question waiting on an answer — Phase A
//------------------------------------------------------------------------------

/**
 * How long Meta keeps a service window open after a recipient sends something.
 *
 * The same 24 as `ACK_TTL_HOURS` and **not the same fact**, which is why it is a second
 * constant rather than a reuse. One is this system's rule about how long a link it minted stays
 * trustworthy; the other is Meta's rule about when it will accept a free-form message. They
 * agree today by coincidence, and a district that reads one number in two places will change it
 * once and be wrong somewhere.
 */
export const SESSION_WINDOW_HOURS = 24;

/**
 * Note that this number sent us something — the fact the whole session sender rests on.
 *
 * Called for **every** inbound, including the ones that match no incident and are dropped. A
 * message from somebody who was never alerted still opens Meta's window, and a district that
 * recorded only the inbounds it understood would believe the window shut while it was open.
 *
 * `GREATEST` rather than a plain overwrite, because webhooks arrive out of order as a matter of
 * routine (see `applyStatus`, which fights the same thing). A retried webhook carrying an older
 * timestamp must never walk the window backwards and make the district stop answering an
 * officer it is in the middle of a conversation with.
 */
export async function noteInbound(pool: Pool, phone: string, at: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_window (phone, last_inbound_at)
     VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE
        SET last_inbound_at = GREATEST(whatsapp_window.last_inbound_at, EXCLUDED.last_inbound_at)`,
    [phone, at],
  );
}

/**
 * May the district send this number a free-form message right now?
 *
 * **Asked against the database rather than assumed from context**, even at the one call site
 * where the answer is obviously yes because an inbound was just recorded. The obvious case is
 * the cheap one; the expensive one is a follow-up that gets sent minutes later by a retry, to a
 * number whose window shut in between, and is refused by Meta as an error nobody in a district
 * office can read.
 *
 * A number nobody has ever heard from has no row, and no row is a shut window. That is the
 * correct answer and the safe one: it means the ordinary template path, which is what every
 * message did before this existed.
 */
export async function sessionWindowOpen(pool: Pool, phone: string): Promise<boolean> {
  const res = await pool.query<{ open: boolean }>(
    `SELECT (last_inbound_at > now() - make_interval(hours => $2)) AS open
       FROM whatsapp_window WHERE phone = $1`,
    [phone, SESSION_WINDOW_HOURS],
  );
  return res.rows[0]?.open ?? false;
}

/**
 * What the district can be waiting to hear — 0029, widened by 0030.
 *
 * Two, and they are the two things a button cannot say: **who** is coming in somebody's place,
 * and **what happened** when an emergency was resolved. Everything else in the lifecycle is a
 * tap, because everything else says one thing and says all of it.
 *
 * Named as a union rather than a bare string so that adding a third is a typecheck away from
 * every place that reads one — the CHECK in the migration and this type are the same fact said
 * in two languages, and only one of them fails at compile time.
 */
export type QuestionKind =
  'substitute' | 'resolution' | 'clarification' | 'reason' | 'representative' | 'absence';

/** A question the district has put to a number and has not had an answer to. */
export interface PendingQuestion {
  readonly questionId: string;
  readonly incidentId: string;
  readonly attemptId: string;
  readonly asks: QuestionKind;
}

export interface QuestionToAsk {
  readonly phone: string;
  readonly incidentId: string;
  readonly attemptId: string;
  readonly asks: QuestionKind;
}

/**
 * Record that the district has asked, so the next thing this number types can be read as the
 * answer.
 *
 * **Written before the message is sent, never after.** It is the same ordering INV-03 rests on
 * throughout this system, for the same reason: an officer can type a name faster than a webhook
 * round trip completes, and a question recorded after its own send is a question whose answer
 * can arrive first and be recorded as an ordinary reply.
 *
 * The cost of that ordering is a row for a question that was never actually asked, when the send
 * then fails. That is the survivable direction — it expires unused, exactly as an ack token
 * does — and the alternative loses the answer to a question the officer definitely saw.
 */
export async function recordQuestion(pool: Pool, question: QuestionToAsk): Promise<string> {
  const questionId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_question
       (question_id, phone, incident_id, attempt_id, asks, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [
      questionId,
      question.phone,
      question.incidentId,
      question.attemptId,
      question.asks,
      SESSION_WINDOW_HOURS,
    ],
  );
  return questionId;
}

/**
 * The question this number still owes an answer to, if any.
 *
 * **The most recent unanswered one wins**, and older ones are left where they are rather than
 * being swept. An officer asked twice — two meetings, two substitutes — is answering the thing
 * they were most recently asked, which is the same inference `lastMessageTo` already makes about
 * which incident a reply belongs to, and it is stated as an inference in both places.
 */
export async function pendingQuestion(pool: Pool, phone: string): Promise<PendingQuestion | null> {
  const res = await pool.query<{
    question_id: string;
    incident_id: string;
    attempt_id: string;
    asks: string;
  }>(
    `SELECT question_id, incident_id, attempt_id, asks
       FROM whatsapp_question
      WHERE phone = $1 AND answered_at IS NULL AND expires_at > now()
      ORDER BY asked_at DESC
      LIMIT 1`,
    [phone],
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  return {
    questionId: row.question_id,
    incidentId: row.incident_id,
    attemptId: row.attempt_id,
    asks: row.asks as QuestionKind,
  };
}

/**
 * Close a question with the words that answered it.
 *
 * The `answered_at IS NULL` in the WHERE is what makes a retried webhook harmless: Meta redelivers
 * an inbound message on any non-2xx, and without it the same name would be appended to the
 * incident twice. Returns whether this call is the one that claimed it, so the caller writes the
 * event exactly once — the same shape `redeemAckToken` uses, for the same reason.
 */
export async function answerQuestion(
  pool: Pool,
  questionId: string,
  answer: string,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE whatsapp_question
        SET answered_at = now(), answer = $2
      WHERE question_id = $1 AND answered_at IS NULL`,
    [questionId, answer],
  );
  return (res.rowCount ?? 0) > 0;
}

//------------------------------------------------------------------------------
// What Meta says about the district's own account — 2026-08-21, migration 0032
//------------------------------------------------------------------------------

/**
 * Note what Meta told us about a template, the number, or the account.
 *
 * **Latest wins, one row per thing described.** Meta re-sends the current state on every change,
 * so the newest notice about `district_message_v3` is the answer to *can we send on it right
 * now* — which is the question the wall asks. A log of every transition would answer a different
 * and less useful one, and this table is deliberately a **state** rather than a history: the
 * event log is the record (ADR-0001), and this is somebody else's system described.
 */
export async function recordAccountNotice(pool: Pool, notice: AccountNotice): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_account_state (kind, subject, event, severity, detail, noticed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (kind, subject) DO UPDATE
        SET event      = EXCLUDED.event,
            severity   = EXCLUDED.severity,
            detail     = EXCLUDED.detail,
            noticed_at = EXCLUDED.noticed_at`,
    [notice.kind, notice.subject, notice.event, notice.severity, notice.detail],
  );
}

export interface AccountTrouble {
  readonly kind: 'template' | 'number' | 'account';
  readonly subject: string;
  readonly event: string;
  readonly severity: 'warn' | 'critical';
  readonly detail: string | null;
  readonly noticedAt: string;
}

/**
 * The **worst** thing Meta is currently saying, or null when it is saying nothing bad.
 *
 * ⚠️ **One row, not a list, and that is the wall's constraint rather than a simplification.** The
 * condition panel gives this one line at four metres. Handing it three would mean the screen
 * choosing which to show — and a screen that picks would eventually pick the reassuring one,
 * which is INV-04's whole subject.
 *
 * Ordered worst-first and then **newest-first within a severity**, so two paused templates show
 * the one that just happened rather than whichever the database felt like returning. That is the
 * `resolveIdentity` lesson: a query that picks one row without an `ORDER BY` picks a different
 * one on different days, and nobody notices until the answer matters.
 */
export async function accountTrouble(pool: Pool): Promise<AccountTrouble | null> {
  const res = await pool.query<{
    kind: 'template' | 'number' | 'account';
    subject: string;
    event: string;
    severity: 'warn' | 'critical';
    detail: string | null;
    noticed_at: string;
  }>(
    `SELECT kind, subject, event, severity, detail, noticed_at
       FROM whatsapp_account_state
      WHERE severity <> 'ok'
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, noticed_at DESC
      LIMIT 1`,
  );

  const row = res.rows[0];
  if (row === undefined) return null;

  return {
    kind: row.kind,
    subject: row.subject,
    event: row.event,
    severity: row.severity,
    detail: row.detail,
    noticedAt: row.noticed_at,
  };
}

/**
 * **The subject the messaging limit is filed under, and it is a reserved name.**
 *
 * `whatsapp_account_state` is keyed on `(kind, subject)`, so the tier needs a subject of its own
 * rather than sharing the number's — otherwise a `FLAGGED` notice and the tier would overwrite
 * each other, and the district would lose whichever arrived first.
 *
 * It lives here rather than in `ops/whatsappNumber.ts`, which is what writes it, because that
 * file already imports `recordAccountNotice` from this one and the other direction would be a
 * cycle. It is a database key; this is where database keys belong.
 */
export const LIMIT_SUBJECT = 'messaging limit';

/**
 * How many distinct handsets this district has reached in a rolling day — 2026-08-21.
 *
 * **This is the numerator of Meta's own cap and it costs one query**, because `whatsapp_message`
 * has recorded every send since M6-19. The denominator is the messaging tier, which has to be
 * asked for — see `ops/whatsappNumber.ts`.
 *
 * ⚠️ **DISTINCT numbers, never a count of messages, and the difference is the whole point.** Meta
 * caps *unique recipients*, so telling one officer forty times costs one, and telling forty
 * officers once costs forty. A count of rows would report a district as near its cap on a day it
 * was nowhere near, and — far worse — as comfortable on the day it is not.
 *
 * ⚠️ **A rolling 24 hours, deliberately NOT the district day.** Everything else on this wall
 * resets at Bajaur's midnight (ADR-0020), and this one must not: Meta's window rolls, so a burst
 * at 23:00 is still spending the allowance at 01:00. A figure that reset when the district's day
 * did would read comfortable at exactly the hour the cap was about to bite.
 */
export async function recipientsReached(pool: Pool, withinHours = 24): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT to_phone) AS n
       FROM whatsapp_message
      WHERE sent_at > now() - make_interval(hours => $1)`,
    [withinHours],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * The messaging tier Meta last told us, or null if it has never been asked successfully.
 *
 * Null is the honest answer on a fresh installation and on one whose poll has never got through,
 * and the wall says nothing about capacity rather than guessing — ADR-0005's rule, applied to a
 * denominator. A fraction drawn against an assumed cap would read as measured.
 */
export async function messagingTier(pool: Pool): Promise<string | null> {
  const res = await pool.query<{ event: string }>(
    `SELECT event FROM whatsapp_account_state WHERE kind = 'number' AND subject = $1`,
    [LIMIT_SUBJECT],
  );
  return res.rows[0]?.event ?? null;
}

/**
 * The three things Phase 5 says without being asked — 2026-08-21.
 *
 * Named as a union for the reason `QuestionKind` is: the CHECK in migration 0033 and this type
 * are the same fact written in two languages, and only one of them fails at compile time.
 */
export type ProactiveKind = 'nudge' | 'closed' | 'summary';

/**
 * **Claim the right to send one proactive message, or find that somebody already has.**
 *
 * ## Why this is a claim rather than a question
 *
 * `sessionWindowOpen` asks and the caller decides. This one **decides by writing**, and the
 * difference is the whole safety of Phase 5.
 *
 * A nudge is decided from a **standing condition** — an emergency that is unacknowledged and
 * running out of time — and the scheduler asks that question every fifteen seconds. A pass that
 * read the condition, sent, and then recorded would send four messages a minute to an officer at
 * 02:00 for as long as the condition held. Escalation has no such problem because the ladder is
 * its own record of where it got to; a nudge has no ladder. This table is the ladder.
 *
 * ⚠️ **The insert IS the decision, and it happens BEFORE the send.** `ON CONFLICT DO NOTHING`
 * makes that atomic against every other instance and every other tick, without a transaction to
 * hold open and without depending on the scheduler's advisory lock — which is an optimisation,
 * where a primary key is a guarantee.
 *
 * ⚠️ **A claimed send that then fails is not retried, and that is the honest direction.** It
 * costs an officer one message that was never promised to them. The alternative — release the
 * claim on failure — is a provider having a bad minute turning into the same message every
 * fifteen seconds until it recovers, which is a manufactured storm on top of a real fault. Every
 * one of the three has a path that does not depend on it: the alert's own buttons, the board,
 * and the morning report.
 *
 * `subject` is the incident id for a nudge and a closing word, and the district's own **date**
 * for a summary — see migration 0033.
 */
export async function claimProactive(
  pool: Pool,
  claim: { readonly kind: ProactiveKind; readonly subject: string; readonly phone: string },
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO whatsapp_proactive (kind, subject, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, subject, phone) DO NOTHING`,
    [claim.kind, claim.subject, claim.phone],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * **Claim the right to offer this handset the buttons, at this point in this emergency** —
 * Phase 9b, migration 0034.
 *
 * An officer who types a reply gets the stages still ahead offered back, so one tap runs the
 * machinery that has existed since Phase C. **The district never reads their words for meaning**
 * — that was proposed on 2026-08-08 and refused, because *"not handled yet"* contains
 * *"handled"* and a false auto-close is the one failure this district cannot afford. It offers
 * instead, and the officer decides.
 *
 * ⚠️ **Without the claim, every reply is answered.** An officer typing four times about one
 * emergency would be answered four times — the chattiness the owner has already named and
 * deferred rather than accepted.
 *
 * `atStatus` is in the key so it **re-arms when the emergency actually moves**: offered *Resolved*
 * at `responding`, a second reply changes nothing and is answered with nothing, because nothing
 * has changed. The insert **is** the decision — one row back means this instance won.
 */
export async function claimStageOffer(
  pool: Pool,
  claim: { readonly incidentId: string; readonly phone: string; readonly atStatus: string },
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO whatsapp_stage_offer (incident_id, phone, at_status)
     VALUES ($1, $2, $3)
     ON CONFLICT (incident_id, phone, at_status) DO NOTHING`,
    [claim.incidentId, claim.phone, claim.atStatus],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Every handset this district has messaged about one emergency, newest attempt first.
 *
 * **Read from `whatsapp_message` rather than from the incident's obligations**, and the
 * distinction matters: an obligation names a seat or a person, and turning one into a number is a
 * roster question whose answer moves — a duty assignment that ended, a post somebody was
 * transferred out of. This table records the numbers that were **actually dialled**, which is the
 * only set a follow-up may honestly be sent to. Telling a handset an emergency is closed when
 * nobody ever told that handset it was open is a message with no context at 02:00.
 *
 * `attemptId` rides along because a button sent now must carry the attempt the ledger is already
 * tracking — see `stageButtonId`. The most recent attempt to that number wins, which is the same
 * choice `lastMessageTo` makes and for the same reason.
 */
export interface HandsetTold {
  readonly phone: string;
  readonly attemptId: string;
  /**
   * **Meta's own id for the last message this district sent that handset about this emergency.**
   *
   * Carried since Phase 8b because the district asked that a follow-up be *"pehle bheje gaye msg ke
   * baare mein … taake record maintain kiya ja sake."* This is the exact alert, by the id Meta and
   * this database both key on — not *"some message we sent that number"*, whose answer moves the
   * moment another emergency is dispatched to them.
   */
  readonly providerMessageId: string;
  /** When that alert went out. Carried so a follow-up can say so without a second query. */
  readonly sentAt: string;
}

export async function handsetsToldAbout(
  pool: Pool,
  incidentId: string,
): Promise<readonly HandsetTold[]> {
  const res = await pool.query<{
    to_phone: string;
    attempt_id: string;
    provider_message_id: string;
    sent_at: string;
  }>(
    `SELECT DISTINCT ON (to_phone) to_phone, attempt_id, provider_message_id, sent_at
       FROM whatsapp_message
      WHERE incident_id = $1
      ORDER BY to_phone, sent_at DESC`,
    [incidentId],
  );
  return res.rows.map((r) => ({
    phone: r.to_phone,
    attemptId: r.attempt_id,
    providerMessageId: r.provider_message_id,
    sentAt: r.sent_at,
  }));
}
