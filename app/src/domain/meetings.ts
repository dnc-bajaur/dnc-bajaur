/**
 * **How a meeting ends, and the one way it does not** — the district's five, 2026-08-22.
 *
 * The district asked for three controls on a meeting: *Conducted*, *Cancelled* and
 * *Rescheduled*. They look like three of a kind and they are **two different shapes**, which is
 * the whole of this file.
 *
 * 🔴 **A rescheduled meeting has not finished.** It is still going to happen, on a new date.
 * Folding all three into one "close" control would take a live meeting off the dashboard — the
 * exact opposite of what the district asked for when they said *"rahegi till its done"*.
 *
 * So `Conducted` and `Cancelled` are outcomes of `resolve`, and a reschedule is its own event
 * that changes the date and **leaves the meeting running**.
 *
 * ## Why the outcomes are a declared vocabulary and not free text
 *
 * `ATTENDANCE_ANSWERS`'s reasoning, applied to the other end of the same meeting: a report has
 * to be able to count *how many meetings were cancelled last month* without matching strings,
 * and a string match is a report that silently stops counting the day somebody types
 * *"cancelled - venue unavailable"*.
 *
 * ⚠️ **It is a vocabulary, not a refusal.** `resolve` still accepts whatever an operator writes,
 * because refusing a resolution is refusing to record something that happened (INV-01's own
 * direction). What this buys is that anything written *from the district's own control* is
 * countable, and `meetingOutcomeOf` is the only place the comparison lives.
 */

import { endOfNamedDistrictDay, endOfDistrictDay, districtDate } from './districtTime.js';
import type { Instant } from './events.js';

/**
 * The two endings, in the district's own words, declared once.
 *
 * `Rescheduled` is deliberately **absent**. It is not an ending, and putting it here would
 * invite exactly the control that closes a meeting which is still going to happen.
 */
export const MEETING_OUTCOMES = ['Conducted', 'Cancelled'] as const;

export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

/**
 * Which of the two an outcome is, or null when somebody wrote their own sentence.
 *
 * Null is a complete answer and is not a failure to classify — the same rule `answerOf` follows
 * for an officer who replies in their own words. A report counts what it can count and says how
 * many it could not, rather than guessing a meeting into a bucket on a substring.
 */
export function meetingOutcomeOf(resolution: string | null): MeetingOutcome | null {
  if (resolution === null) return null;
  const said = resolution.trim().toLowerCase();
  return MEETING_OUTCOMES.find((o) => o.toLowerCase() === said) ?? null;
}

/**
 * **When a meeting stops asking who is coming** — the owner's decision, 2026-08-18, and this is
 * the first thing that has ever had a tally for it to act on.
 *
 * Their rule: attendance closes at the end of the district day, **rolling to the next district
 * day when fewer than three hours of this one are left**. A notice sent at 22:00 that closed at
 * midnight would give officers two hours, half of them asleep — which is not a deadline, it is a
 * way of recording that nobody answered.
 *
 * ⚠️ **The district's day, through `districtTime.ts`, never the server's.** This process runs in
 * Helsinki and Bajaur is UTC+05:00: computed locally, *"end of today"* lands five hours early
 * every single day, which is this project's own two-midnights defect arriving as a shortened
 * deadline.
 *
 * ⚠️ **It closes the COUNT and nothing else.** A late answer is still recorded, still on the
 * incident, and still readable — see `Attendance.late`. Nothing here refuses a message, settles
 * an obligation or resolves anything: a meeting whose attendance has closed is still a meeting
 * that has not happened.
 */
export const ATTENDANCE_GRACE_HOURS = 3;

export function attendanceClosesAt(issuedAt: Instant): Instant | null {
  const at = Date.parse(issuedAt);
  if (Number.isNaN(at)) return null;

  const tonight = endOfDistrictDay(issuedAt);
  const left = Date.parse(tonight) - at;
  if (left >= ATTENDANCE_GRACE_HOURS * 3_600_000) return tonight;

  /**
   * Fewer than three hours left, so it rolls.
   *
   * Named through `districtDate` and `endOfNamedDistrictDay` rather than by adding 24 hours to
   * an instant — a day is a calendar question and only the district's calendar may answer it.
   */
  const tomorrow = districtDate(new Date(Date.parse(tonight) + 3_600_000));
  return endOfNamedDistrictDay(tomorrow);
}
