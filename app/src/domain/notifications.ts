/**
 * Who has to be told, and when not being told becomes a visible failure. INV-03.
 *
 * The invariant is one sentence — *a message that did not reach the duty officer surfaces
 * on the central board as an unmet obligation, not as a log line* — and everything here
 * exists to make that literally true rather than aspirationally true.
 *
 * Three states, never two. "Sent" is not "delivered", and a system that conflates them is
 * telling the control room an officer knows about an emergency when nobody has established
 * that. An attempt is `pending` until something settles it; pending for too long is itself
 * the failure, because an obligation nobody has picked up is indistinguishable from one
 * nobody was told about.
 *
 * **What this is not.** The channel is in-app only (Q-07 has not been answered, so which
 * channels actually work in Bajaur is still unverified and this file does not pretend
 * otherwise). An officer who is not looking at the app is not reached. That is a real gap,
 * it is M3's to close, and the shape here — attempt, then outcome, per channel — is what
 * lets SMS or voice slot in without any of this changing.
 */

import type { IncidentState, NotificationAttempt } from './incident.js';
import type { NotifyReason, Uuid } from './events.js';

/**
 * How long an attempt may sit unacknowledged before it counts as an unmet obligation.
 *
 * Deliberately tighter than any SLA target: the point is to catch a notification that never
 * landed *before* the acknowledgement deadline it was supposed to prompt, not afterwards
 * when the escalation has already fired and the question is why nobody moved.
 */
export const UNDELIVERED_AFTER_MINUTES = 3;

export interface NotifyTarget {
  /** The seat acquiring — or losing — the obligation. */
  readonly seatId: Uuid | null;
  /** Resolved from the department when no seat is named directly. */
  readonly departmentId: Uuid | null;
  /**
   * A **named officer**, owed this message as themselves rather than as a post — M6-03.
   *
   * The third addressee, and the one the district asked for. Until it existed an operator who
   * meant *"tell Nawaz, he knows that road"* could only express it by naming his post, which
   * says something different: a post is held by whoever holds it tonight, so the obligation
   * would have quietly retargeted itself at the next shift change and the record would show
   * somebody else having been told.
   *
   * Null on every obligation the system derives for itself. Only a dispatch produces one.
   */
  readonly personId: Uuid | null;
  readonly reason: NotifyReason;
}

/**
 * The obligations an incident's current state implies, regardless of what has been sent.
 *
 * Derived from state rather than from "the last event", so a pass that crashes halfway
 * through simply produces the same answer next time. Idempotency comes from comparing this
 * against the attempts already in the log, not from a marker someone has to remember to
 * write — the same reasoning as the escalation ladder.
 */
export function obligationsFor(state: IncidentState): readonly NotifyTarget[] {
  const targets: NotifyTarget[] = [];

  // Whoever currently owns it has to know they own it. `routed` and `reassigned` are the
  // same obligation from the recipient's side, and the reason is recorded so the message
  // can differ even though the duty is identical.
  for (const departmentId of state.responsibleDepartmentIds) {
    targets.push({
      seatId: null,
      departmentId,
      personId: null,
      reason: state.reassignedFrom.length > 0 ? 'reassigned' : 'routed',
    });
  }

  // The department it was taken away from is told too. A handover nobody announced is how
  // two departments each assume the other went (docs/04-authority-model.md).
  for (const departmentId of state.reassignedFrom) {
    if (state.responsibleDepartmentIds.includes(departmentId)) continue;
    targets.push({ seatId: null, departmentId, personId: null, reason: 'lost_responsibility' });
  }

  /**
   * 🔴 **AN ESCALATION TELLS NOBODY. THE DISTRICT DECIDED THAT, 2026-08-21 — READ THIS BEFORE
   * PUTTING IT BACK.**
   *
   * The line that stood here was `if (state.currentEscalationSeatId !== null) targets.push(…)`,
   * under the comment ***"an escalation that nobody is told about is just a row in a table."***
   * That sentence was the whole argument, it is kept above deliberately, and **the district has
   * overturned the assumption underneath it.**
   *
   * ## What they said, and it is a statement about their own officers
   *
   * *"Officers ka follow up aggressively nahi lena hai, na hi un ke high up office ko
   * inform/shikayat karni hai. Officers ke paas ikhtiyar hai ke woh jab chahen din ke andar
   * response den. Main initially yeh chahta hoon ke software khud se koi follow up na bheje —
   * control room hi follow up bheje."*
   *
   * A ladder that messages an officer's superior when a deadline passes is **precisely** *inform
   * the high-up office*, decided by a timer, with no person in the loop. That is the one thing
   * they asked this software not to do.
   *
   * ## What is still true, which is why this is a deletion of four lines and not of a feature
   *
   * **The escalation still happens.** `jobs/escalation.ts` is untouched: the pass still runs, the
   * `escalated` event is still appended, the ladder still records the seat it reached — which is
   * also what keeps it **idempotent**, since an incident only escalates to a tier strictly above
   * the one it has already reached (INV-08). The board still marks the emergency **overdue** from
   * `overdueByMinutes`, so the control room still sees that a deadline went past.
   *
   * **What stops is the message.** The row exists, the mark is on the wall, and no handset buzzes.
   * The old comment called that *"just a row in a table"*; the district calls it *the room finds
   * out and nobody is complained to*, and it is their district.
   *
   * ⚠️ **INV-07 IS NOT WEAKENED AND MUST NOT BE READ AS WEAKENED.** That invariant is *an SLA
   * clock never runs on a client* — it is about **where** escalation is computed, and it is still
   * computed on the server, from a durable job, with a closed laptop unable to stop it. Nothing
   * here moves a clock.
   *
   * ⚠️ **INV-03 IS NOT WEAKENED EITHER, AND THIS IS THE SUBTLE HALF.** *A notification failure is
   * never invisible* — and an obligation that is never created cannot fail invisibly. The failure
   * this invariant exists to catch is *we tried to tell somebody and it did not arrive*; there is
   * now nothing to try. What would have broken it is the opposite change: keeping the obligation
   * and quietly refusing to send it, which manufactures a permanent unmet row — the exact defect
   * ADR-0018 deleted the in-app inbox over.
   *
   * ⚠️ **AND THE HALF THAT IS NOT BUILT YET IS WHAT MAKES THIS HONEST.** Taking the chasing off the
   * software is only fair if the **room** is given it: the control room's own *take action* — follow
   * up, close, mark resolved, and escalate **by a person's hand** — is the other half, and until it
   * exists this district can see an overdue emergency and has no button for it. See the owner's
   * O-45/O-46 rows.
   *
   * **Reversing this is a decision, not a tidy-up.** It needs the district, not a reading of this
   * comment.
   */

  /**
   * Whoever the control room chose — M6-03, the obligation the district actually asked for.
   *
   * Two shapes, because a post and a person are different addressees and flattening them would
   * lose the one thing this feature exists to record. A post is the seat itself; **a person is
   * the person**, which is the case that had no representation at all before this.
   *
   * ⚠️ **`'department'` was the third shape and is gone — ADR-0031, phase 2.** The picker has
   * offered contacts only since ADR-0023 and this installation carries no department-kinded
   * `dispatched` target, so the case is dead. The `routed` path below still resolves a
   * responsible department to its duty post — that is a different question (who *holds* the
   * incident) and `departmentId` stays on the obligation for it.
   *
   * `dispatchedTo` is already collapsed, so a post inside a selection cannot produce a second
   * buzz on one handset (`collapseSelection`).
   */
  for (const target of state.dispatchedTo) {
    switch (target.kind) {
      case 'post':
        targets.push({
          seatId: target.id,
          departmentId: null,
          personId: null,
          reason: 'dispatched',
        });
        break;
      case 'person':
        targets.push({
          seatId: null,
          departmentId: null,
          personId: target.id,
          reason: 'dispatched',
        });
        break;
    }
  }

  return targets;
}

/** An obligation is met once an attempt for that seat and reason exists in any state. */
/**
 * What makes two attempts the same obligation.
 *
 * A **person** first, when the obligation names one; then the seat; then the department. Order
 * matters and is not arbitrary, because a person-addressed obligation is normally resolved to a
 * seat before delivery — so both fields are set on the attempt, and keying on the seat would
 * make *"tell the DEO"* and *"tell Nawaz, who holds the DEO post"* the same obligation. They are
 * not: the first follows the post through a handover and the second follows the man. Merged,
 * the second one silently disappears the moment somebody else takes the post.
 *
 * The department half exists so that every pass does not record a fresh failure against a
 * department that has no post — the notification storm INV-08 exists to prevent, aimed at the
 * one department least able to answer it.
 */
export function targetKey(target: {
  readonly seatId: Uuid | null;
  readonly departmentId?: Uuid | null;
  readonly personId?: Uuid | null;
}): string {
  if (target.personId !== null && target.personId !== undefined) return `person:${target.personId}`;
  return target.seatId ?? `department:${String(target.departmentId ?? 'unknown')}`;
}

/**
 * Has this exact rung already been tried for this obligation?
 *
 * **Per channel**, because the ladder is a sequence: WhatsApp having been tried and failed is
 * precisely the reason to try a voice call, and a check that ignored the channel would stop
 * the ladder at its first rung forever.
 */
export function alreadyAttempted(
  attempts: readonly NotificationAttempt[],
  target: {
    readonly seatId: Uuid | null;
    readonly departmentId?: Uuid | null;
    readonly personId?: Uuid | null;
  },
  reason: NotifyReason,
  channel?: string,
): boolean {
  const key = targetKey(target);
  return attempts.some(
    (a) =>
      targetKey(a) === key &&
      a.reason === reason &&
      (channel === undefined || a.channel === channel),
  );
}

/**
 * Has anything already reached this person for this obligation?
 *
 * The ladder stops at the first success and **must not restart on the next pass**. Without
 * this, a notification delivered by WhatsApp at 02:00 would be followed by a voice call at
 * 02:00 and thirty seconds, because `voice` had never been attempted — a notification storm
 * aimed at somebody who is already awake and driving (INV-08).
 *
 * The in-app rung does not count. It settles only when the holder's client collects it, so
 * "pending in an inbox nobody has opened" is not somebody having been told, and the external
 * ladder must still run.
 */
export function externallyReached(
  attempts: readonly NotificationAttempt[],
  target: {
    readonly seatId: Uuid | null;
    readonly departmentId?: Uuid | null;
    readonly personId?: Uuid | null;
  },
  reason: NotifyReason,
): boolean {
  const key = targetKey(target);
  return attempts.some(
    (a) =>
      targetKey(a) === key && a.reason === reason && a.channel !== 'web' && a.state === 'delivered',
  );
}

/**
 * Should this rung be tried on this pass? — M6-24.
 *
 * `alreadyAttempted` answers *"has this been tried"*, which was the whole question while every
 * channel either worked or did not. A provider that **defers** makes it the wrong question: a
 * WhatsApp number Meta has rate limited refused this message and will accept the next one, and
 * treating that as tried-and-failed turns a ninety-second cap into an emergency nobody was ever
 * told about.
 *
 * So: try when nothing has been tried, **or** when the most recent attempt on this channel was
 * a retryable failure. Anything else — pending, delivered, or a real failure like a vacant post
 * or an unapproved template — is left alone, because retrying those produces a notification
 * storm aimed at a problem no retry can fix (INV-08).
 *
 * "Most recent" is by `attemptedAt`, not by array order: attempts are keyed by id in the fold
 * and their order in the list is the order their events happened to be seen.
 */
export function shouldAttempt(
  attempts: readonly NotificationAttempt[],
  target: {
    readonly seatId: Uuid | null;
    readonly departmentId?: Uuid | null;
    readonly personId?: Uuid | null;
  },
  reason: NotifyReason,
  channel: string,
): boolean {
  const key = targetKey(target);
  const mine = attempts
    .filter((a) => targetKey(a) === key && a.reason === reason && a.channel === channel)
    .sort((a, b) => (a.attemptedAt < b.attemptedAt ? -1 : a.attemptedAt > b.attemptedAt ? 1 : 0));

  const latest = mine[mine.length - 1];
  if (latest === undefined) return true;

  return latest.state === 'failed' && latest.retryable === true;
}

export interface UnmetObligation {
  readonly attempt: NotificationAttempt;
  readonly why: 'failed' | 'undelivered';
  readonly minutesWaiting: number;
}

/**
 * Which failures matter most when several are true at once, worst first.
 *
 * **Ordered by how specific the fix is, not by severity.** `no_channel` is district-wide — one
 * account, bought once, and every row on the board clears together. A vacant post is one
 * appointment and nothing else on the board changes. Showing the district-wide one on a row
 * would tell an operator the same sentence eighty times and hide the one thing that row alone
 * needs.
 */
const FAILURE_ORDER: readonly { readonly code: string; readonly says: string }[] = [
  { code: 'no_post', says: 'this department has no post — nobody to tell' },
  { code: 'no_duty_holder', says: 'nobody holds that post' },
  { code: 'placeholder_contact', says: 'that post has a stand-in number, not a real one' },
  { code: 'no_number', says: 'no number on the roster for them' },
  { code: 'disabled', says: 'their account is disabled' },
  { code: 'could_not_reach', says: 'the control room rang and could not reach them' },
  { code: 'no_channel', says: 'nothing was sent — no WhatsApp account yet' },
];

/**
 * What to put on the board row, in words an operator can act on — or null.
 *
 * **This replaced "could not notify the duty seat", which was misleading in two ways** and had
 * become more so as the district's real state changed:
 *
 *   * it says *we tried*, and until the WhatsApp account exists **nothing is sent at all**. An
 *     operator reading "could not notify" goes looking for a network fault;
 *   * it says *duty seat*, and the control room routinely addresses a **named officer** or a
 *     department that has no post — which is the failure itself in the second case.
 *
 * INV-03 asks for failures to be visible **so somebody can fix them**, and three failures with
 * three different fixes rendered as one sentence is a count, not a fault report.
 */
export function whyUnmetReads(unmet: readonly UnmetObligation[]): string | null {
  const failures = unmet.filter((u) => u.why === 'failed');
  if (failures.length === 0) return null;

  for (const { code, says } of FAILURE_ORDER) {
    const n = failures.filter((f) => (f.attempt.failure ?? '').startsWith(code)).length;
    if (n > 0) return failures.length > n ? `${says} (+${String(failures.length - n)} more)` : says;
  }

  // A failure this build has no words for. Said as a count rather than dropped — an unmet
  // obligation the board cannot describe is still an unmet obligation (INV-03).
  return `${String(failures.length)} could not be told`;
}

/**
 * Attempts that have not reached anybody — the list the central board must never be able
 * to render as empty when it is not.
 *
 * A failure and a silence are reported as different things on purpose. "The post is vacant"
 * needs someone to fill a roster; "sent, never picked up" needs someone to pick up a phone.
 * Collapsing them into one number would leave the control room unable to tell which.
 */
export function unmetObligations(
  attempts: readonly NotificationAttempt[],
  now: string,
  afterMinutes = UNDELIVERED_AFTER_MINUTES,
): readonly UnmetObligation[] {
  const unmet: UnmetObligation[] = [];

  for (const attempt of attempts) {
    if (attempt.state === 'delivered') continue;

    const minutesWaiting = Math.max(
      0,
      (Date.parse(now) - Date.parse(attempt.attemptedAt)) / 60_000,
    );

    if (attempt.state === 'failed') {
      unmet.push({ attempt, why: 'failed', minutesWaiting });
      continue;
    }

    if (minutesWaiting >= afterMinutes) {
      unmet.push({ attempt, why: 'undelivered', minutesWaiting });
    }
  }

  return unmet;
}
