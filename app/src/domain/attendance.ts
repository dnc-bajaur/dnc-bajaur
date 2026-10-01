/**
 * Who is coming to the meeting — Phase D, 2026-08-20.
 *
 * The district has been able to *ask* since 19 August: `district_notice_v2` puts **Attending ·
 * Not attending · Sending someone** on a meeting notice, and a tap has settled the obligation and
 * gone onto the incident ever since. What it could not do is **count**. Twelve officers answered
 * and the only way to learn that eight were coming was to open twelve rows one at a time — so the
 * question the district actually asks out loud, *"who is coming on Thursday?"*, had no answer on
 * any screen. That is the second half of O-34.
 *
 * ## Nothing here is stored, and that is the whole design
 *
 * This is `stages.ts`'s rule applied to a second question: **an attendance is a function of the
 * notification ledger, computed wherever it is shown.** There is no attendance column, no
 * attendance event, and no place a tally can disagree with the log — because the moment two
 * answers to *"is the DEO coming"* exist, one of them starts being wrong and nothing says which.
 *
 * It costs nothing to have refused the alternative. Every fact this file needs is **already on
 * the attempt**: `via` says how the district found out, and `said` carries the words the officer
 * chose. Delete this file and the district loses a panel, not a record.
 *
 * ## Why the words are declared here rather than in the template
 *
 * `ops/whatsappTemplate.ts` needs these three strings because Meta approved them and `doctor`
 * compares them; this file needs them because a tap comes back as **nothing but its own words**
 * and they are the only thing that says which answer it was. Two copies would be two things to
 * change, and the one that drifts silently is the tally — the message would keep sending, the
 * taps would keep arriving, and *"Attending"* would quietly stop being counted as attending.
 *
 * So the words live **here**, in the domain, and the template imports them. That is the right way
 * round: which answers the district offers is a fact about the district; which template carries
 * them is a fact about the transport.
 *
 * ⚠️ **Changing one of these strings without changing it at Meta breaks the count, silently.**
 * `npm run doctor` is what notices, because it reads the approved buttons back from the Graph API
 * and compares them against `TemplateShape.quickReplies`, which is built from these.
 */

import type { MessageKind } from './events.js';

/**
 * The three answers, exactly as Meta approved them on `district_notice_v2`.
 *
 * In the approved **order**, because `TemplateShape.quickReplies` is built from this array and
 * Meta matches a template's buttons by position — the same trap `urlButton.index` carries, which
 * has already cost this district one outage's worth of care.
 */
export const ATTENDANCE_ANSWERS = ['Attending', 'Not attending', 'Sending someone'] as const;

export const [ATTENDING, NOT_ATTENDING, SENDING_SOMEONE] = ATTENDANCE_ANSWERS;

/**
 * What one recipient has said about a meeting.
 *
 * `unanswered` and `other` are deliberately not the same thing, for the reason ADR-0005 gives
 * about absence being the signal. **Nobody has answered** is the district's problem to chase;
 * **they answered some other way** — an operator recorded a telephone call, or the officer typed
 * a sentence instead of tapping — is somebody who *has* responded and whose words are on the
 * record. A tally that merged them would report a district as unreachable when it had been rung.
 */
export type AttendanceAnswer =
  'attending' | 'not_attending' | 'sending_someone' | 'other' | 'unanswered';

export interface AttendanceRow {
  readonly attemptId: string;
  readonly seatId: string | null;
  readonly personId?: string;
  readonly departmentId?: string;
  readonly answer: AttendanceAnswer;
  /** The officer's own words, when there are any. Shown verbatim for `other`. */
  readonly said?: string;
  /** `link`, `reply`, `operator`, `provider` — absent on attempts settled before M7-06. */
  readonly via?: string;
  /**
   * **Answered, but about the date this meeting used to be on** — 2026-08-22.
   *
   * An officer who said *Attending* for Monday has said nothing about Thursday, so this row is
   * counted as `unanswered` for the new date — and it **keeps their words**, because nothing
   * about a reschedule erases what somebody said. The record and the count answer two
   * different questions and this is the field that lets a screen show both.
   */
  readonly stale?: true;
  /**
   * **Answered after the count had closed** — the owner's rule of 2026-08-18.
   *
   * Recorded, readable, and outside the tally. A late answer is not a failure by the officer
   * and is never discarded; what it may not do is move a number the district has already read
   * out in a meeting.
   */
  readonly late?: true;
}

export interface Attendance {
  readonly attending: number;
  readonly notAttending: number;
  readonly sendingSomeone: number;
  /** Answered, but not with one of the three. See `AttendanceAnswer`. */
  readonly other: number;
  readonly unanswered: number;
  /**
   * **How many will be in the room** — `attending + sendingSomeone`, 2026-09-10.
   *
   * The numerator of the sentence every surface reads out (*"3 of 5 coming"*). A **representative
   * is attendance**: the district asked who would be there, and *Sending someone* is a yes with a
   * name attached. That decision is a fact about the district, so it is stated once here rather
   * than added up again on the detail screen, the board row, the daily line and the report.
   * `other` is not in it — *"I'll try"* is an answer, not a commitment to a seat — and neither is
   * a stale or late row, for the same reason it is not in `attending`.
   */
  readonly coming: number;
  /**
   * **Anyone has replied at all** — `attending + notAttending + sendingSomeone + other`.
   *
   * The attendance answer to the question `ownershipOf`'s `holding > 0` answers for an emergency:
   * *has this notice had any response yet*. `answered === 0` on a dispatched meeting is the gap a
   * report states and the detail screen reads as *"no replies yet"* rather than *"0 of 5
   * coming"*, which looks like five refusals. A decline is an answer; silence, and a reply about
   * the old date (`stale`) or after the count closed (`late`), are not.
   */
  readonly answered: number;
  /** Everyone who was told, in the order they were told. */
  readonly rows: readonly AttendanceRow[];
  /** Told at all. Not `rows.length` by accident — it is the denominator the panel reads. */
  readonly told: number;
  /**
   * Answered about an earlier date, before this meeting moved. Counted as `unanswered` above.
   *
   * Reported as its own number so the panel can say *"5 answered for the old date"* rather than
   * showing a meeting that looks as though nobody ever replied to it.
   */
  readonly stale: number;
  /** Answered after the count closed. Same rule: its own number, never folded into a silence. */
  readonly late: number;
  /**
   * When the count closes, or null when it has no closing time — the owner's rule of
   * 2026-08-18, and `domain/meetings.ts` owns the arithmetic.
   */
  readonly closesAt: string | null;
}

/**
 * The three routes that mean a person decided something.
 *
 * The same list `web/src/dispatch.ts` calls `ANSWERED`, and the same reasoning: `provider` is
 * Meta reporting that a handset received the message, which settles the attempt and **decides
 * nothing**. An officer whose phone received a meeting notice has not said they are coming, and
 * a tally built on delivery would fill a room that nobody agreed to attend.
 */
const ANSWERED: readonly string[] = ['link', 'reply', 'operator'];

/**
 * Exactly what this file reads off an obligation, and nothing else.
 *
 * **Declared rather than importing `NotificationAttempt`**, so the same function serves the
 * server's fold and the browser's `ToldEntry` — which carries no `channel` and would not satisfy
 * the wider type. Both already have every field named here.
 *
 * The narrower shape is also the honest one: this counts answers, and it has no business being
 * handed a failure reason or a settlement time it must be trusted not to read.
 */
export interface AttendanceInput {
  readonly attemptId: string;
  readonly seatId: string | null;
  readonly personId?: string;
  readonly departmentId?: string;
  readonly reason: string;
  readonly via?: string;
  readonly said?: string;
  /**
   * When it was settled — needed only to answer *"was this said about THIS date?"*.
   *
   * Optional, because attempts settled before it was recorded genuinely do not carry one. An
   * absent instant is treated as **not stale and not late**: the honest reading is *we do not
   * know when*, and dropping an answer out of a count on the strength of a missing field would
   * be the software deciding an officer never replied.
   */
  readonly settledAt?: string;
}

/** Match a tap or a typed answer against the three, forgiving case and stray spaces. */
function answerOf(attempt: AttendanceInput): AttendanceAnswer {
  if (attempt.via === undefined || !ANSWERED.includes(attempt.via)) return 'unanswered';

  const said = attempt.said?.trim().toLowerCase();
  if (said === undefined || said === '') return 'other';

  if (said === ATTENDING.toLowerCase()) return 'attending';
  if (said === NOT_ATTENDING.toLowerCase()) return 'not_attending';
  if (said === SENDING_SOMEONE.toLowerCase()) return 'sending_someone';

  /**
   * Somebody answered in their own words, and that is not a failure to classify.
   *
   * *"I'll be there but late"* is a better answer than any of the three buttons and the district
   * should read it as written. Guessing which bucket it belongs in — matching on *"attend"*, say
   * — would put a sentence into a count that somebody then acts on, and *"I cannot attend"* would
   * land under **Attending** on the strength of a substring.
   */
  return 'other';
}

/**
 * Count the answers to one meeting, or say that counting does not apply.
 *
 * **Null for anything that is not a meeting**, rather than an empty tally, and the difference
 * matters on the screen: an empty tally invites *"nobody is coming"*, while null is the panel not
 * being drawn at all. An emergency has no attendance — *"Attending"* is not an answer to a road
 * accident, which is exactly why `answersFor` refuses to put those buttons on one.
 *
 * Only **dispatched** obligations are counted. The escalation ladder's own messages are attempts
 * too, and counting them would let a meeting nobody answered grow a denominator as the system
 * chased it — the district would watch attendance get *worse* the harder it tried.
 */
export interface AttendanceWindow {
  /**
   * When the meeting was last moved, if it ever was — `IncidentState.rescheduledAt`.
   *
   * 🔴 **The count starts again from here.** Agreed with the district: an *Attending* for
   * Monday says nothing about Thursday. The earlier answers stay on the record for ever and are
   * marked `stale`; only the tally begins empty.
   */
  readonly rescheduledAt?: string | null;
  /** When the count closes — `attendanceClosesAt`, the owner's rule of 2026-08-18. */
  readonly closesAt?: string | null;
  /**
   * **This notice asked who is coming** — the district's five, 2026-08-22.
   *
   * Only ever true on `other`, and only when the operator ticked it. It is what lets a Milad
   * programme count who is coming while a road-closure notice still, correctly, counts nothing.
   */
  readonly invited?: boolean;
}

export function attendanceFor(
  kind: MessageKind,
  notifications: readonly AttendanceInput[],
  window: AttendanceWindow = {},
): Attendance | null {
  /**
   * Null for anything that is not asking, and the difference matters on the screen: an empty
   * tally invites *"nobody is coming"* about a road accident, while null is the panel not being
   * drawn at all.
   *
   * A **meeting** always asks. An **`other`** asks only when the operator said so — per message,
   * never per kind, which is what keeps *"Attending"* off a notice about a closed road.
   */
  const asking = kind === 'meeting' || (kind === 'other' && window.invited === true);
  if (!asking) return null;

  const movedAt = window.rescheduledAt ?? null;
  const closesAt = window.closesAt ?? null;

  const rows = notifications
    .filter((n) => n.reason === 'dispatched')
    .map((attempt): AttendanceRow => {
      const answer = answerOf(attempt);
      /**
       * ⚠️ **An answer with no `settledAt` is never marked.** The honest reading of a missing
       * instant is *we do not know when*, and dropping somebody out of a count on the strength
       * of an absent field would be the software deciding an officer never replied — which is
       * the same class of mistake as reading `seatId: null` as *"holds no post"*.
       */
      const at = attempt.settledAt;
      const stale = answer !== 'unanswered' && at !== undefined && movedAt !== null && at < movedAt;
      const late =
        answer !== 'unanswered' && at !== undefined && closesAt !== null && at > closesAt;

      return {
        attemptId: attempt.attemptId,
        seatId: attempt.seatId,
        ...(attempt.personId === undefined ? {} : { personId: attempt.personId }),
        ...(attempt.departmentId === undefined ? {} : { departmentId: attempt.departmentId }),
        answer,
        ...(attempt.said === undefined ? {} : { said: attempt.said }),
        ...(attempt.via === undefined ? {} : { via: attempt.via }),
        ...(stale ? { stale: true as const } : {}),
        ...(late ? { late: true as const } : {}),
      };
    });

  /**
   * A row that is stale or late counts as **unanswered** and keeps its words.
   *
   * The two are reported separately above rather than folded into the silence, because
   * *"nobody replied"* and *"five replied about the date this used to be on"* are very
   * different things to read off a wall at four metres.
   */
  const counts = (a: AttendanceAnswer): number =>
    rows.filter((r) => r.answer === a && r.stale !== true && r.late !== true).length;

  const set = rows.filter((r) => r.stale === true || r.late === true).length;

  const attending = counts('attending');
  const notAttending = counts('not_attending');
  const sendingSomeone = counts('sending_someone');
  const other = counts('other');

  return {
    attending,
    notAttending,
    sendingSomeone,
    other,
    unanswered: counts('unanswered') + set,
    // A representative counts — see `coming`'s note. Stale/late rows are already out of the four
    // bucket counts above, so they are out of these two derived totals for free.
    coming: attending + sendingSomeone,
    answered: attending + notAttending + sendingSomeone + other,
    rows,
    told: rows.length,
    stale: rows.filter((r) => r.stale === true).length,
    late: rows.filter((r) => r.late === true).length,
    closesAt,
  };
}
