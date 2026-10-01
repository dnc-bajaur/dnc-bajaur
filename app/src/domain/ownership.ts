/**
 * **Who is actually holding this emergency** — the district's response workflow, 2026-08-24.
 *
 * The one thing their five-page document does not answer. It designs the officer's screen in
 * detail — *Unable to Respond*, then a representative, leave or a reason — and then stops. Nobody
 * wrote down what the **control room** is supposed to see once an officer has said *"I cannot"*.
 * Asked, and the answer through the owner was that there is no standing procedure: *"unable to
 * respond k lye un ka apna SOP nhe hai"*.
 *
 * ## 🔴 Why the software cannot simply record it and move on
 *
 * Today this record knows two colours, and neither of them is honest here:
 *
 *   * **not answered** — chase them. Unfair to an officer who *did* answer, and it would go on
 *     telephoning somebody who has already said they are on leave.
 *   * **acknowledged** — it is in hand. **This is the dangerous one.** Four officers can each tap
 *     *Acknowledge*, each answer *Unable to Respond*, and the board reads `4/4 acknowledged` in
 *     green over an emergency **nobody has taken**. The acknowledgement has also stopped the SLA
 *     clock, so no escalation is coming either.
 *
 * That is INV-03 defeated politely: a real failure, invisible, with every number saying fine. So
 * there is a third reading — **answered, and nobody is holding it** — and `api/board.ts`,
 * `api/lifecycle.ts` and `domain/sla.ts` all ask this one function for it.
 *
 * ## Nothing new is stored, and that is not a saving — it is the only way this stays true
 *
 * `responseOptions.ts` puts the district's sentence in the attempt's `said`. This reads it back
 * out. There is no ownership column, no `declined` event and no flag an operator could forget to
 * clear, because the moment a stored flag and the officers' own words can disagree, one of them is
 * wrong and nothing says which (ADR-0001). `attendanceFor` counts a meeting the same way, off the
 * same field, for the same reason.
 *
 * ⚠️ **An officer's own words are holding, never declining.** Somebody who typed *"on my way"*
 * instead of tapping has taken the emergency more clearly than any row could say it. Only the
 * district's own `no_owner` sentences — *Not Related to Me*, *Unable to Respond* and the three
 * under it — count as a decline, and `optionOfSaid` is what recognises them.
 *
 * ## `takenBy` — the office that has it, not the first to tap
 *
 * On a wide dispatch the incident's single `acknowledgedAt` slot is filled by whoever answers
 * first, a decline included, so "Taken by" on the incident screen has been naming the officer who
 * said *Not Related to Me*. `takenBy` is the honest answer: the **earliest holding row**, by
 * `settledAt`. Derived here beside `ownerless` for the same reason — one rule about who is holding
 * an emergency, so a screen, a report and the board cannot drift apart about the same night.
 */

import type { Instant } from './events.js';
import { optionOfSaid } from './responseOptions.js';

/**
 * The three routes that mean a **person** decided something.
 *
 * The same list and the same reasoning as `attendance.ts`: `provider` is Meta reporting that a
 * handset received the message, which settles the attempt and **decides nothing**. An officer
 * whose phone received an alert has not said they are dealing with it, and an ownership count
 * built on delivery would report a district as covered when it had merely been reached.
 */
const ANSWERED: readonly string[] = ['link', 'reply', 'operator'];

/** What one recipient has done about this emergency. */
export type Holding = 'holding' | 'declined' | 'silent';

export interface OwnershipRow {
  readonly attemptId: string;
  readonly seatId: string | null;
  readonly personId?: string;
  readonly departmentId?: string;
  readonly holding: Holding;
  /** The officer's own words, when there are any. Shown verbatim on the panel. */
  readonly said?: string;
  /**
   * The id of the district's option, when what they said was one of them.
   *
   * Absent for an officer who answered in their own words — which is `AttendanceAnswer`'s `other`
   * and is not a failure to classify.
   */
  readonly option?: string;
  readonly via?: string;
  /** When the attempt settled — what `takenBy` is ordered by. Absent on pre-M7-06 attempts. */
  readonly settledAt?: Instant;
}

export interface Ownership {
  /** Everyone the control room told. The denominator every other number here is read against. */
  readonly told: number;
  /** Answered, and did not decline. Cognizance, a deployment, a resolution, or their own words. */
  readonly holding: number;
  /** Answered *Not Related to Me*, or one of the four *Unable* sentences. */
  readonly declined: number;
  /** Has not answered at all. Still the chase list's problem, unchanged. */
  readonly silent: number;
  /**
   * 🔴 **Somebody answered, and nobody is holding this.**
   *
   * ⚠️ **True even while others are still silent, and that is deliberate.** *"Two declined and two
   * have not answered"* is not a reason to hide the declines until the silence resolves — the
   * control room needs to reassign now, and the silent two are already red on the same panel. The
   * two readings sit side by side because they are two different facts.
   *
   * False when nobody has answered at all: that is silence, which the board has always shown, and
   * calling it ownerless would put an orange flag on every emergency in the first minute of its
   * life.
   */
  readonly ownerless: boolean;
  /**
   * **The office that has taken this** — the earliest `holding` row by `settledAt`, or null when
   * nobody is holding it (all silent, or `ownerless`). This is what "Taken by" reads instead of
   * the incident's first-tap `acknowledgedBy` slot.
   */
  readonly takenBy: OwnershipRow | null;
  /** `takenBy`'s post and person, lifted for callers that only want the ids. Null when none. */
  readonly takenBySeatId: string | null;
  readonly takenByPersonId: string | null;
  /**
   * When the taker committed — `takenBy`'s `settledAt` (or its attempt time when settled before
   * M7-06). Null when nobody is holding it. This is the honest "Responded at" for the reports and
   * the SLA milestone, in place of the first-tap `acknowledgedAt`.
   */
  readonly respondedAt: Instant | null;
  readonly rows: readonly OwnershipRow[];
}

/**
 * What this function is given — narrower than `NotificationAttempt` on purpose.
 *
 * `attendance.ts` makes the same argument for its own input: this counts who is holding an
 * emergency, and it has no business being handed a failure string or a retry flag it might one day
 * start reasoning about.
 */
export interface OwnershipInput {
  readonly attemptId: string;
  readonly seatId: string | null;
  readonly personId?: string;
  readonly departmentId?: string;
  readonly reason: string;
  readonly via?: string;
  readonly said?: string;
  /** When the attempt settled (M7-06). `takenBy` is the earliest holding row by this. */
  readonly settledAt?: Instant;
  /** When the message was attempted — the fallback order when `settledAt` is absent. */
  readonly attemptedAt?: Instant;
}

function holdingOf(attempt: OwnershipInput): Holding {
  if (attempt.via === undefined || !ANSWERED.includes(attempt.via)) return 'silent';
  return optionOfSaid(attempt.said)?.records === 'no_owner' ? 'declined' : 'holding';
}

/**
 * Read who is holding this emergency off the obligations the control room created.
 *
 * ⚠️ **Only `dispatched` attempts count**, exactly as `attendanceFor` filters. An escalation to a
 * senior officer is the system saying *nobody answered*; counting it as somebody who was asked
 * would make an emergency look more widely covered the longer it went unanswered.
 */
export function ownershipOf(notifications: readonly OwnershipInput[]): Ownership {
  const dispatched = notifications.filter((n) => n.reason === 'dispatched');
  const rows = dispatched.map((attempt): OwnershipRow => {
    const holding = holdingOf(attempt);
    const option = optionOfSaid(attempt.said);
    return {
      attemptId: attempt.attemptId,
      seatId: attempt.seatId,
      ...(attempt.personId === undefined ? {} : { personId: attempt.personId }),
      ...(attempt.departmentId === undefined ? {} : { departmentId: attempt.departmentId }),
      holding,
      ...(attempt.said === undefined ? {} : { said: attempt.said }),
      ...(option === null ? {} : { option: option.id }),
      ...(attempt.via === undefined ? {} : { via: attempt.via }),
      ...(attempt.settledAt === undefined ? {} : { settledAt: attempt.settledAt }),
    };
  });

  const count = (what: Holding): number => rows.filter((r) => r.holding === what).length;
  const holding = count('holding');
  const declined = count('declined');

  /**
   * The taker: the earliest `holding` row by when it settled. A row with no time sorts after
   * every row that has one — a pre-M7-06 attempt should never outrank a dated commit — and ties
   * keep dispatch order. `at` carries `settledAt` where there is one and the attempt time
   * otherwise, so `respondedAt` is the best time available rather than null whenever a holder
   * predates M7-06.
   */
  const holders = rows
    .map((row, i) => ({ row, at: dispatched[i]?.settledAt ?? dispatched[i]?.attemptedAt }))
    .filter((h) => h.row.holding === 'holding')
    .sort((a, b) => {
      if (a.at === b.at) return 0;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return a.at < b.at ? -1 : 1;
    });
  const taker = holders[0] ?? null;

  return {
    told: rows.length,
    holding,
    declined,
    silent: count('silent'),
    ownerless: declined > 0 && holding === 0,
    takenBy: taker?.row ?? null,
    takenBySeatId: taker?.row.seatId ?? null,
    takenByPersonId: taker?.row.personId ?? null,
    respondedAt: taker?.at ?? null,
    rows,
  };
}
