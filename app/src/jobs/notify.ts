/**
 * The notification pass — M0-32, INV-03.
 *
 * `domain/notifications.ts` knows who is owed a message. This is the thing that actually
 * tries, and — far more importantly — the thing that records what happened when it did.
 *
 * The order of operations is the whole design:
 *
 *   1. work out who is owed a notification, from **state**, not from the last event
 *   2. append `notified` *before* attempting anything
 *   3. attempt delivery
 *   4. append `notification_delivered` or `notification_failed`
 *
 * Step 2 looks redundant and is not. A crash between 2 and 4 leaves a **pending** attempt,
 * which the board shows as an unmet obligation — the correct answer, because we genuinely
 * do not know whether anyone was told. Attempting first and recording afterwards would
 * leave nothing at all, and INV-03 would be violated by a process dying quietly.
 *
 * Idempotency comes from comparing obligations against attempts already in the log, the
 * same way escalation compares against the ladder. No marker anyone has to remember to set.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { foldIncident } from '../domain/incident.js';
import {
  alreadyAttempted,
  obligationsFor,
  shouldAttempt,
  targetKey,
} from '../domain/notifications.js';
import type { AcknowledgementRoute, IncidentEvent, NotifyReason, Uuid } from '../domain/events.js';
import type { NotifyTarget } from '../domain/notifications.js';

const LOOKBACK_DAYS = 7;

/**
 * The channels an attempt can be recorded against.
 *
 * Written once rather than repeated at each `record`/`settle` call, because M6-18 adds a second
 * one and the pair of string literals that used to be here are exactly the kind of thing that
 * gets updated in one place and not the other.
 */
type ChannelName = 'whatsapp' | 'manual';

/**
 * A way of reaching a seat.
 *
 * One method, and it returns a **reason** on failure rather than throwing, because "why did
 * this not arrive" is the question the control room will ask and an exception message is
 * not an answer anyone can act on.
 *
 * The interface exists so SMS and voice (M3, blocked on Q-07) slot in without touching the
 * ledger around them. Do not let a channel decide whether an attempt is worth recording —
 * that decision belongs to the caller, and a channel that skipped the record is exactly how
 * a failure becomes invisible.
 */
export interface NotificationChannel {
  readonly name: 'whatsapp';
  deliver(target: {
    /** The post being told, or null when the obligation names a person and nothing else. */
    readonly seatId: Uuid | null;
    /** The named officer, when the control room chose one (M6-03). */
    readonly personId: Uuid | null;
    readonly incidentId: Uuid;
    readonly reason: NotifyReason;
    /**
     * The attempt this delivery belongs to — already appended, before this was called.
     *
     * Passed in rather than returned, because a channel that minted its own id would be a
     * channel that decided when the record was written. The order of operations is the caller's
     * and the whole of INV-03 rests on it: the attempt exists before anything is sent, so a
     * process dying mid-send leaves a visibly pending obligation rather than nothing at all.
     *
     * WhatsApp needs it to bind the acknowledge link to the obligation the ledger is tracking.
     */
    readonly attemptId: Uuid;
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly failure: string;
        /** The provider deferred rather than refused. The next pass tries again (M6-24). */
        readonly retryable?: boolean;
        /**
         * Handed off, outcome unknown — and therefore **not settled either way**.
         *
         * WhatsApp accepting a message is not delivery: the attempt stays `pending` until a
         * status webhook or, better, the officer's own acknowledge tap. A channel returning
         * `ok: true` here would tell the control room somebody knows about an emergency on the
         * strength of an HTTP 200 from a datacentre.
         */
        readonly pending?: boolean;
        /**
         * **The words that went out** — 2026-08-23. Present only alongside `pending`, because
         * that is the only branch where a message actually left the building.
         *
         * Returned rather than written by the channel, for the same reason `attemptId` is passed
         * *in* rather than minted there: the order of operations is the caller’s and INV-03
         * rests on it. A channel that appended its own events would be a channel deciding when
         * the record is written.
         */
        readonly sent?: {
          readonly what: string;
          readonly where: string;
          readonly providerMessageId?: string;
        };
      }
  >;
}

/**
 * **The in-app channel was here, and it is gone — ADR-0018, M7-02.**
 *
 * It delivered into a seat holder's inbox, and settlement meant that holder opening the app.
 * Nobody outside the control room signs in, and nobody will: departments are a directory the
 * control room picks from, not an audience. So every obligation it created sat pending, aged
 * past UNDELIVERED_AFTER_MINUTES, and became a permanent unmet obligation on the board.
 *
 * **That is worse than useless. INV-03 exists to make real failures visible, and this
 * manufactured false ones** at a rate of one per recipient per emergency — teaching the
 * district to ignore the one number that matters at 02:00.
 *
 * What is **not** gone, and must not follow it out:
 *
 *   * **The ledger** — `notified`, `notification_delivered`, `notification_failed`,
 *     `obligationsFor`, `unmetObligations` and the board's unmet counts. That *is* INV-03, and
 *     WhatsApp settles it through the same events. One channel was deleted, not the accounting.
 *   * **The outbox.** It is not an "in-app" feature in the sense deleted here: it is how the
 *     control room's **own** reports become durable before they reach the server, and it is
 *     what `spine.e2e.test.ts` proves INV-01 with. Deleting it because the phrase "in-app"
 *     appears near it would remove the one claim this project exists to make, from an
 *     installation that uses it every day.
 */

export interface NotifyOutcome {
  readonly scanned: number;
  readonly attempted: number;
  /** Attempts that failed outright — a vacant post, a dead gateway. Needs a human. */
  readonly failed: number;
  readonly truncated: boolean;
}

/** Incidents recent enough to still be worth notifying anyone about. */
async function candidates(
  pool: Pool,
  limit: number,
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($3::uuid[] IS NULL OR e.incident_id = ANY($3::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type = 'closed'
            )
      GROUP BY e.incident_id
      ORDER BY first_seen ASC
      LIMIT $2`,
    [LOOKBACK_DAYS, limit, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

/**
 * The seat currently holding a department's duty.
 *
 * ⚠️ **ALWAYS NULL SINCE ADR-0030, AND IT TOUCHES NO DATABASE.** Migration 0039 dropped
 * `seat.department_id`; this query would throw rather than return nothing.
 *
 * **Null is a state this caller was already written for**, which is why it survives as a shape
 * rather than being torn out along with everything that leads here. A department with no seat
 * has always been possible — that is `no_duty_holder`, and `whyUnmetReads` has a sentence for
 * it. So a department-kinded obligation now settles as *needing a person*, named, on the ledger
 * (INV-03), instead of silently reaching nobody.
 *
 * ⚠️ **Nothing creates one any more.** `obligationsFor` derives a department obligation from
 * `responsibleDepartmentIds`, which no new emergency carries — ADR-0022 stopped anything routing
 * on its own, and ADR-0030 removed the thing it routed to.
 */
function dutySeatFor(_pool: Pool, _departmentId: Uuid): Promise<Uuid | null> {
  return Promise.resolve(null);
}

/** An obligation with its department already turned into the seat that will receive it. */
interface ResolvedTarget extends NotifyTarget {
  readonly seatId: Uuid | null;
}

/**
 * Is there a human at the other end of this obligation, and if not, why not?
 *
 * **This lived inside the in-app channel and nearly went out with it (M7-02).** It looked like a
 * delivery concern and is not: whether a post is vacant, whether its holder is a stand-in, and
 * whether they have a number are facts about the **recipient**, true no matter what carries the
 * message. Deleting them with the channel would have collapsed four different answers into one
 * unhelpful `no_channel`, and ADR-0004's rule — *a vacant post must never swallow an obligation*
 * — would have quietly stopped being enforced. The tests caught it; nothing else would have.
 *
 * Each answer sends the district somewhere different: `no_duty_holder` needs somebody appointed,
 * `placeholder_contact` needs the real number, `no_number` needs the roster filled in, and
 * `disabled` is somebody who should probably not be in the list. Returns null when there is
 * genuinely somebody reachable.
 */
async function whyUnreachable(
  pool: Pool,
  seatId: Uuid | null,
  personId: Uuid | null,
): Promise<string | null> {
  if (personId !== null) {
    const res = await pool.query<{ phone: string | null; placeholder: boolean; disabled: boolean }>(
      `SELECT phone, placeholder, (disabled_at IS NOT NULL) AS disabled
         FROM person WHERE person_id = $1 AND removed_at IS NULL`,
      [personId],
    );
    const person = res.rows[0];
    if (person === undefined) {
      return 'no_such_person: this officer is no longer on the roster';
    }
    if (person.disabled) return 'disabled: this officer’s account is disabled';
    if (person.placeholder) {
      return 'placeholder_contact: a stand-in entry, not a real officer — nobody would be reached';
    }
    if ((person.phone ?? '').trim() === '') {
      return 'no_number: this officer has no number on the roster';
    }
    return null;
  }

  if (seatId === null) return 'no_addressee: this obligation names nobody';

  const res = await pool.query<{
    holder: string | null;
    phone: string | null;
    placeholder: boolean | null;
  }>(
    `SELECT p.person_id AS holder, p.phone, p.placeholder
       FROM seat s
       LEFT JOIN duty_assignment a
              ON a.seat_id = s.seat_id
             AND a.from_at <= now()
             AND (a.to_at IS NULL OR a.to_at > now())
       LEFT JOIN person p
              ON p.person_id = a.person_id
             AND p.removed_at IS NULL
             AND p.disabled_at IS NULL
      WHERE s.seat_id = $1`,
    [seatId],
  );

  const seat = res.rows[0];
  if (seat === undefined) return 'no_such_post: this post no longer exists';
  if (seat.holder === null) {
    return 'no_duty_holder: nobody currently holds this post, so nothing can reach it';
  }
  if (seat.placeholder === true) {
    return 'placeholder_contact: this post holds a stand-in number, not a real one';
  }
  if ((seat.phone ?? '').trim() === '') {
    return 'no_number: the holder has no number on the roster';
  }

  return null;
}

/**
 * **One emergency, one message per recipient** — and the record still says why.
 *
 * `obligationsFor` is pure and returns every reason somebody is owed a message. That is right:
 * a department routed an emergency *and* chosen by the control room genuinely has two reasons,
 * and both belong in the record. What a pure function cannot know is that both resolve to the
 * **same duty officer**, because a department is turned into a seat here and nowhere else.
 *
 * Left alone, the control room ticking Rescue on an unassigned emergency buzzed one officer
 * twice at 02:00 — once for becoming responsible, once for being chosen. That is exactly the
 * double-buzz `collapseSelection` exists to prevent, arriving through a door it cannot see. It
 * was found by a WhatsApp test counting four messages where two belonged; in Bajaur it would
 * have been found by somebody muting the number.
 *
 * ## Why `dispatched` wins
 *
 * When two reasons land on one seat, the surviving obligation keeps **`dispatched`**. It is the
 * more specific fact — *a named operator chose you* rather than *a rule placed this* — and it is
 * the one the district asked to be able to answer. It is also what the "who was told" panel
 * matches on: suppress it and the screen shows a chosen recipient stuck at "being recorded"
 * for ever, which is worse than a duplicate message.
 *
 * ## What is deliberately not collapsed
 *
 * **An escalation is never swallowed.** A seat owed an escalation is owed it whatever else it
 * was told, because escalation is the system saying *nobody has answered* — collapsing it into
 * "you were told" is how an unanswered emergency goes quiet (ADR-0004, ADR-0005). Likewise
 * `lost_responsibility`: a department being told it no longer holds something is not the same
 * message as being told it does.
 */
async function oneMessagePerRecipient(
  pool: Pool,
  obligations: readonly NotifyTarget[],
): Promise<readonly ResolvedTarget[]> {
  const resolved: ResolvedTarget[] = [];

  for (const target of obligations) {
    const seatId =
      target.seatId ??
      (target.departmentId === null ? null : await dutySeatFor(pool, target.departmentId));
    resolved.push({ ...target, seatId });
  }

  /** Only these two ever merge. Everything else is a different thing to say. */
  const mergeable = (reason: string): boolean => reason === 'routed' || reason === 'dispatched';

  const out: ResolvedTarget[] = [];

  for (const target of resolved) {
    if (!mergeable(target.reason)) {
      out.push(target);
      continue;
    }

    // Keyed on the **resolved** recipient — the seat a department turned into — because that is
    // the thing that receives the message. Keyed on the department, this would miss the case it
    // exists for entirely: a post chosen directly and its own department being routed.
    const who = target.seatId ?? targetKey(target);
    const already = out.findIndex((t) => mergeable(t.reason) && (t.seatId ?? targetKey(t)) === who);

    if (already === -1) {
      out.push(target);
      continue;
    }

    // The same seat, twice. Keep the more specific reason; the other is already covered.
    if (target.reason === 'dispatched') out[already] = target;
  }

  return out;
}

export interface NotifyOptions {
  readonly now?: string;
  readonly limit?: number;
  readonly incidentIds?: readonly string[];
  /** The in-app channel. Overridden by tests; never by configuration. */
  readonly channel?: NotificationChannel;
  /**
   * WhatsApp, when the district has an account — ADR-0014, M6-18.
   *
   * Absent is the normal state until the Meta account exists (R-05, R-19, R-20), and the system
   * is complete without it: obligations are recorded, the inbox works, and "Reach them" is
   * there. What must not happen is the district believing messages go out when no account
   * exists, which is what the condition row is for (M6-25).
   *
   * **Never a ladder.** This is one channel beside the inbox, not the second rung of anything
   * (see the note above `runNotifyPass`).
   */
  readonly whatsapp?: NotificationChannel;
}

/**
 * One pass. Safe to call repeatedly and safe to call concurrently (see `scheduler.ts`).
 *
 * **One obligation, one channel: the in-app inbox.**
 *
 * There used to be a ladder here — WhatsApp, then a voice call, then SMS, then a modem in the
 * DC office — and it is gone, at the owner's instruction (ADR-0012 superseded, 2026-08-03).
 * The software sends nothing. It records what each post is owed, shows it in that post's
 * inbox, and an officer who needs to reach somebody presses **Reach them** and rings them.
 *
 * What this job still does is the part that matters and is not obvious: it writes the
 * obligation **before** anything is attempted, so a crash leaves a visibly pending duty rather
 * than nothing at all. "Delivered" means the seat holder's own client collected it — not that
 * a queue accepted it — which is why the in-app channel is the only one whose delivery ever
 * meant anything (INV-03).
 */
export async function runNotifyPass(
  pool: Pool,
  options: NotifyOptions = {},
): Promise<NotifyOutcome> {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;
  const whatsapp = options.whatsapp;

  const ids = await candidates(pool, limit, options.incidentIds);

  let attempted = 0;
  let failed = 0;

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);

    // A running sequence, not `state.eventCount + 1` per append.
    //
    // Two obligations on one incident used to produce two events with the same
    // `clientSeq`, and a ladder of five rungs would produce ten. Ordering then fell to the
    // event id, which is random — deterministic, and causally wrong, which is the exact
    // mistake ADR-0008 was written about.
    let seq = state.eventCount;
    const nextSeq = (): number => (seq += 1);

    for (const target of await oneMessagePerRecipient(pool, obligationsFor(state))) {
      const seatId = target.seatId;

      // A department with no post at all is a configuration gap, and it is recorded **on
      // the incident** rather than only counted here.
      //
      // This used to `continue` after incrementing a counter, which meant the board showed
      // nothing: an emergency routed to a department with no posts looked notified. INV-03
      // says an unmet obligation surfaces on the board and not as a log line, and a number
      // in a job's return value is a log line.
      //
      // A person-addressed obligation has no department and needs no seat: it is skipped by
      // neither half, which is why `personId` is in this condition and not merely beside it.
      if (seatId === null && target.departmentId === null && target.personId === null) continue;

      /**
       * The obligation's identity, and **`personId` is deliberately kept beside `seatId`**.
       *
       * `targetKey` prefers the person, so an officer named directly and the post they happen
       * to hold stay two obligations. Dropping the person here — recording only the seat that
       * will carry the message — would merge them, and the one the control room actually chose
       * would vanish from the ledger the moment somebody else took the post.
       */
      const key = {
        seatId,
        departmentId: target.departmentId,
        personId: target.personId,
      };

      const record = async (attemptId: string, channelName: ChannelName): Promise<void> => {
        // Recorded before anything is attempted. A crash between the two leaves a visibly
        // pending obligation rather than nothing at all — see the header.
        await append(pool, [
          {
            eventId: randomUUID(),
            incidentId,
            occurredAt: now,
            recordedAt: now,
            actorPersonId: null,
            actorSeatId: null,
            sourceChannel: 'system' as const,
            type: 'notified',
            clientSeq: nextSeq(),
            payload: {
              attemptId,
              seatId,
              ...(target.departmentId === null ? {} : { departmentId: target.departmentId }),
              ...(target.personId === null ? {} : { personId: target.personId }),
              channel: channelName,
              reason: target.reason,
            },
          } as unknown as IncidentEvent,
        ]);
        attempted += 1;
      };

      const settle = async (
        attemptId: string,
        channelName: ChannelName,
        result: { ok: true } | { ok: false; failure: string; retryable?: boolean },
      ): Promise<void> => {
        await append(pool, [
          {
            eventId: randomUUID(),
            incidentId,
            occurredAt: now,
            recordedAt: now,
            actorPersonId: null,
            actorSeatId: null,
            sourceChannel: 'system' as const,
            type: result.ok ? 'notification_delivered' : 'notification_failed',
            clientSeq: nextSeq(),
            payload: {
              attemptId,
              seatId,
              ...(target.personId === null ? {} : { personId: target.personId }),
              channel: channelName,
              ...(result.ok ? {} : { failure: result.failure }),
              ...(!result.ok && result.retryable === true ? { retryable: true } : {}),
            },
          } as unknown as IncidentEvent,
        ]);
        if (!result.ok) failed += 1;
      };

      //------------------------------------------------------------------
      // No automatic channel — say so, rather than leaving it pending — M7-03
      //------------------------------------------------------------------
      //
      // Until the district's WhatsApp account exists there is nothing that can carry a message
      // by itself. The obligation is still recorded — **somebody was owed one** — and settled
      // immediately as needing a person, naming why.
      //
      // The alternative was leaving it `pending`, which is what the in-app channel did and is
      // exactly why it was deleted (ADR-0018): a pending attempt nobody can settle ages into a
      // permanent unmet obligation, and a board full of those teaches the district to ignore
      // the number that matters at 02:00. **Pending must mean "we are waiting on an answer",
      // never "we never had a way to ask".**
      //
      // What closes it is the operator: "Reach them" opens WhatsApp or the dialler on their own
      // handset, and they record what they were told (M7-05).

      if (
        whatsapp === undefined &&
        !alreadyAttempted(state.notifications, key, target.reason, 'manual')
      ) {
        const attemptId = randomUUID();
        await record(attemptId, 'manual');

        /**
         * **Who is unreachable comes before what channel is missing**, and the order is the
         * whole point.
         *
         * A vacant post and a missing WhatsApp account are entirely different problems: one
         * needs somebody appointed, the other needs an account bought. Reporting the second
         * while the first is true would send the district to the wrong fix — and would let a
         * vacant post hide behind a temporary configuration gap, which is exactly the
         * swallowing ADR-0004 forbids.
         */
        const unreachable =
          seatId === null && target.personId === null
            ? 'no_post: this department has no post to notify — nobody can be told until one exists'
            : await whyUnreachable(pool, seatId, target.personId);

        await settle(attemptId, 'manual', {
          ok: false,
          failure:
            unreachable ??
            'no_channel: no WhatsApp account is configured, so nothing was sent — ' +
              'use “Reach them” and record what they said',
        });
      }

      //------------------------------------------------------------------
      // WhatsApp. Beside the inbox, never below it — ADR-0014, M6-18.
      //------------------------------------------------------------------
      //
      // **This is not a ladder rung.** A ladder tries the next provider when the last one
      // fails, so that delivery always *succeeds*; ADR-0012 built one and it was removed. This
      // is one channel, sent alongside the inbox, so that delivery is always *known* — and the
      // inbox is not its fallback any more than it is the inbox's.
      //
      // Skipped entirely when the district has no account, which is the normal state until
      // R-05, R-19 and R-20 are done. Nothing else changes when it is absent.

      if (
        whatsapp !== undefined &&
        shouldAttempt(state.notifications, key, target.reason, 'whatsapp')
      ) {
        const attemptId = randomUUID();
        await record(attemptId, 'whatsapp');

        const result = await whatsapp
          .deliver({
            seatId,
            personId: target.personId,
            incidentId,
            reason: target.reason,
            attemptId,
          })
          .catch(
            (
              err: unknown,
            ): {
              ok: false;
              failure: string;
              retryable?: boolean;
              pending?: boolean;
              // Widened with the contract above: an annotation narrower than the interface
              // silently drops the field from the union, and the append below stops compiling.
              sent?: { what: string; where: string; providerMessageId?: string };
            } => ({
              ok: false,
              failure: `channel threw: ${String(err)}`,
              // A thrown channel is this process's problem, not the provider's verdict.
              // Retryable, because the alternative is one bad moment recorded for ever as
              // "could not tell anybody" — INV-03 satisfied by a lie in the right direction.
              retryable: true,
            }),
          );

        /**
         * `pending` settles nothing, deliberately.
         *
         * Meta accepting a message is not delivery. The attempt stays open until a status
         * webhook says otherwise or — better — until the officer taps the acknowledge link,
         * which is what actually meets the obligation (ADR-0014). Writing a delivery here
         * would tell the control room somebody knows about an emergency on the strength of an
         * HTTP 200 from a datacentre.
         */
        if (!result.ok && result.pending !== true) await settle(attemptId, 'whatsapp', result);

        /**
         * **What we said, onto the record** — 2026-08-23, and it is a separate append on purpose.
         *
         * It cannot ride on `notified`: that one is written **before** the send, which is the
         * order INV-03 rests on, and the message does not exist yet at that point — it is composed
         * from the incident’s state inside the channel, moments later. An append-only log does not
         * go back and fill a field in, so the thing that happened second is its own event.
         *
         * ⚠️ **It settles nothing.** `message_sent` records words, not an outcome; the attempt
         * stays pending until a status webhook or the officer’s own tap (ADR-0014). That is why
         * this sits *after* the settle line and never inside it.
         *
         * Guarded on `sent` rather than on `pending`, so a channel that hands a message off
         * without saying what it said simply records nothing — which is honest, and is what every
         * message before today looks like.
         */
        if (result.ok === false && result.sent !== undefined) {
          const said = result.sent;
          await append(pool, [
            {
              eventId: randomUUID(),
              incidentId,
              occurredAt: now,
              recordedAt: now,
              actorPersonId: null,
              actorSeatId: null,
              sourceChannel: 'system' as const,
              type: 'message_sent',
              clientSeq: nextSeq(),
              payload: {
                attemptId,
                what: said.what,
                where: said.where,
                ...(said.providerMessageId === undefined
                  ? {}
                  : { providerMessageId: said.providerMessageId }),
              },
            } as unknown as IncidentEvent,
          ]);
        }
      }
    }
  }

  return { scanned: ids.length, attempted, failed, truncated: ids.length >= limit };
}

/**
 * Somebody actually answered — settle every attempt that was owed to them.
 *
 * Called when an officer taps an acknowledge link (M6-22) or replies (M6-23). It settles the
 * attempt that was answered **and every other pending attempt for the same obligation**, and
 * that second half is the part worth arguing about.
 *
 * One obligation now produces two attempts: the inbox and WhatsApp. An officer who taps the
 * link in WhatsApp has demonstrably been reached — but the in-app copy is still sitting
 * uncollected in an inbox they may never open, and the board would keep carrying it as an unmet
 * obligation for ever. **That is a failure the system would be inventing**, and INV-03 exists to
 * make real failures visible, not to manufacture them. A district that learns to ignore the
 * unmet count has lost the number that matters at 02:00.
 *
 * What it does *not* do is settle a **failed** attempt. A message that could not be sent stays
 * failed in the record — the officer was reached another way, and the fact that one channel
 * could not reach them is still true and still needs fixing.
 */
export async function markObligationMet(
  pool: Pool,
  incidentId: string,
  attemptId: string,
  by: { readonly personId: string | null; readonly seatId: string | null },
  /**
   * How we found out, and what they said — M7-06.
   *
   * Optional so the two callers that predate routes keep working unchanged, and **not
   * defaulted**: an attempt settled with no route says truthfully that this record does not
   * know how, which is better than every old settlement claiming to have been a link tap.
   */
  how: { readonly via?: AcknowledgementRoute; readonly said?: string } = {},
  now = new Date().toISOString(),
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;

  const state = foldIncident(incidentId, events);
  const answered = state.notifications.find((a) => a.attemptId === attemptId);
  if (answered === undefined) return;

  const key = targetKey(answered);
  const siblings = state.notifications.filter(
    (a) => targetKey(a) === key && a.reason === answered.reason && a.state === 'pending',
  );

  if (siblings.length === 0) return;

  let seq = state.eventCount;

  await append(
    pool,
    siblings.map(
      (attempt) =>
        ({
          eventId: randomUUID(),
          incidentId,
          occurredAt: now,
          recordedAt: now,
          clientSeq: (seq += 1),
          // Who answered, on the record. A delivery with nobody attached is a claim nobody can
          // check afterwards — and this one arrives from a link in a message, so it matters more
          // here than anywhere else.
          actorPersonId: by.personId,
          actorSeatId: by.seatId,
          sourceChannel: 'web' as const,
          type: 'notification_delivered',
          payload: {
            attemptId: attempt.attemptId,
            seatId: attempt.seatId,
            ...(attempt.personId === undefined ? {} : { personId: attempt.personId }),
            channel: attempt.channel,
            ...(how.via === undefined ? {} : { via: how.via }),
            ...(how.said === undefined ? {} : { said: how.said }),
          },
        }) as unknown as IncidentEvent,
    ),
  );
}

/**
 * **What the officer said, onto an obligation that has already been settled** — the district's
 * response workflow, 2026-08-24.
 *
 * `markObligationMet` answers *"this is no longer outstanding"*, and it does so **once**: it works
 * on `pending` siblings and finds none the second time. That was the whole story while an
 * acknowledgement was the end of the conversation.
 *
 * It is not the end any more. The district's workflow puts a question **after** the tap — the
 * officer acknowledges, the obligation settles, and only then do they choose *Deploying Relevant
 * Staff / Team* or *Unable to Respond*. Their words arrive at a ledger row that is already closed.
 *
 * ## Why this is a second `notification_delivered` and not a new event type
 *
 * The fold sets an attempt from the last outcome it sees, so a second delivered event carrying
 * `said` simply **updates what that attempt says the officer told us**. That is exactly what has
 * happened: the district learned more about an answer it already had. A new event type would need
 * the fold, the ledger, the exports and every report taught about it, to record a fact one of
 * them already models.
 *
 * ⚠️ **Both states are handled and they are not the same act.** An attempt still `pending` here —
 * an officer who somehow reaches an option without the acknowledgement having settled — goes
 * through `markObligationMet`, so its **siblings settle too**. A settled attempt gets this one
 * event and nothing else: re-settling siblings on a second answer would overwrite what other
 * officers said with what this one said.
 *
 * ⚠️ **Silent on an attempt this incident does not have.** A row id can arrive from a message
 * history days old, on an emergency that has since been merged away; writing a delivery for an
 * obligation nobody can find would put a settlement in the ledger with nothing behind it.
 */
export async function recordWhatTheySaid(
  pool: Pool,
  incidentId: string,
  attemptId: string,
  how: { readonly via: AcknowledgementRoute; readonly said: string },
  now = new Date().toISOString(),
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;

  const state = foldIncident(incidentId, events);
  const attempt = state.notifications.find((a) => a.attemptId === attemptId);
  if (attempt === undefined) return;

  if (attempt.state === 'pending') {
    await markObligationMet(
      pool,
      incidentId,
      attemptId,
      { personId: attempt.personId ?? null, seatId: attempt.seatId },
      how,
      now,
    );
    return;
  }

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: attempt.personId ?? null,
      actorSeatId: attempt.seatId,
      // The same channel a tap on the alert records, because it is the same act: something the
      // officer did from a message on a handset.
      sourceChannel: 'sms' as const,
      type: 'notification_delivered' as const,
      payload: {
        attemptId,
        seatId: attempt.seatId,
        ...(attempt.personId === undefined ? {} : { personId: attempt.personId }),
        channel: attempt.channel,
        via: how.via,
        said: how.said,
      },
    } as unknown as IncidentEvent,
  ]);
}
