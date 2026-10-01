/**
 * **What the control room says when it chases** — 2026-08-24.
 *
 * The owner read a live chase and said the obvious thing: *"follow up msgs ju jate hain wo tou
 * abhi har aik k lye same hi msg jata hai, so mai chahta hon k wo bhi accordingly chala jaye"*.
 *
 * ## What was already right, and what was not
 *
 * The **subject** of a chase has been kind-aware since 2026-08-22 — `describe()` gives a meeting
 * its subject, date, time and venue, and an emergency its category and severity. That is not what
 * was wrong. What was wrong is that underneath it, **every officer in the district read the same
 * two sentences**: *"The control room is following up on … Please tap below to record where this
 * stands."* Sent about a meeting, that asks a man invited to the DC's office to report the status
 * of an incident.
 *
 * ## Three buckets, and they are not a new opinion
 *
 * `followUpKindFor` is **two existing decisions joined**, not a third one:
 *
 * * `isGathering` — the same predicate `stageButtonWords` uses to choose *Attending* over
 *   *Responding*. 🔴 **The sentence and the button are read together in one bubble**, so a chase
 *   that asks about attendance while its button says *Responding* is the message arguing with
 *   itself. Sharing the predicate makes that impossible rather than merely unlikely.
 * * `thanksKindFor` — for everything that is not a gathering, the urgent/information split the
 *   district themselves drew when they wrote their three acknowledgement replies.
 *
 * A kind added later falls to `information`, which asks for a confirmation nobody is harmed by.
 *
 * ## A gathering's chase is a reminder, and carries nothing to press
 *
 * The owner again, and it is a behaviour rule rather than a wording one: *"Meeting k follow up mai
 * kuch button dene ki zarurt nhe hi just simple ho, a kind of reminder ho, acknowledge etc karne
 * ki zarurt nhe hai"*. ⚠️ **Attendance was already asked once** — the meeting notice goes on
 * `district_notice_v2`, which carries the three attendance quick replies. A chase is a reminder,
 * not a second poll, and `api/followUp.ts` offers no buttons at all on one.
 *
 * ⚠️ **No buttons is not no record.** The `followed_up` event still carries the note, the handset,
 * and whether the message actually left the building (INV-03). That distinction is the same one
 * the acknowledgement thank-you was given on 2026-08-23.
 *
 * ## The one thing these words cannot fix
 *
 * When the 24-hour service window is shut the chase goes on `district_message_v3`, and **that
 * template has a URL button baked into it**. A reminder that says no reply is needed will still
 * arrive with a link under it. Removing it means a new template and a fresh Meta approval; the
 * owner was given both options on 2026-08-24 and chose to accept the link for now. The words
 * below are honest about what is being asked either way, which is all they can be.
 */

import { isGathering, type MessageKind } from './events.js';
import { thanksKindFor } from './acknowledgementThanks.js';

export type FollowUpKind = 'gathering' | 'urgent' | 'information';

/**
 * Which of the three a chase is owed. Total over every `MessageKind` and every category.
 *
 * ⚠️ **`kind` is asked before `category`**, the same ordering `thanksKindFor` uses and for the
 * same reason: a meeting **about the flood** is still a meeting somebody attends. Category answers
 * *what a message is about*; this answers *what the reader is being asked to do*.
 */
export function followUpKindFor(kind: MessageKind, category: string | null): FollowUpKind {
  if (isGathering(kind)) return 'gathering';
  return thanksKindFor(kind, category) === 'urgent' ? 'urgent' : 'information';
}

/**
 * The noun a gathering is called by.
 *
 * *"The subject meeting"* is the district's own phrase — it is in the acknowledgement reply they
 * wrote themselves. A duty schedule is not a meeting, and telling forty officers to attend one
 * would describe the message wrongly, so the noun follows the kind and nothing else does.
 */
function gatheringNoun(kind: MessageKind): string {
  return kind === 'schedule' ? 'schedule' : 'meeting';
}

/**
 * The first line, which names what is being chased.
 *
 * A gathering opens as a **reminder** rather than as a follow-up, because that is what it is: the
 * district is not waiting on an answer, it is making sure nobody forgot. Everything else opens by
 * saying the control room is following up, which is the sentence that has been going out since
 * this endpoint existed and which the owner did not ask to change.
 */
export function followUpOpening(kind: MessageKind, category: string | null, what: string): string {
  if (followUpKindFor(kind, category) === 'gathering') {
    return `Reminder regarding the subject ${gatheringNoun(kind)}: ${what}`;
  }
  return `The control room is following up on ${what}.`;
}

/**
 * The second line, when the control room typed nothing of its own.
 *
 * `hasButtons` is false when the stages are exhausted — an emergency somebody already resolved —
 * and asking such an officer to *"tap below"* would be the software naming a control that is not
 * there. ⚠️ **A gathering ignores it entirely**, because a gathering never has buttons and its
 * sentence must not imply it might.
 */
export function followUpAsk(
  kind: MessageKind,
  category: string | null,
  hasButtons: boolean,
): string {
  switch (followUpKindFor(kind, category)) {
    case 'gathering':
      return kind === 'schedule'
        ? 'Kindly note the same. This is a reminder only; no reply is required.'
        : 'Kindly make it convenient to attend. This is a reminder only; no reply is required.';
    case 'urgent':
      return hasButtons
        ? 'Kindly record where this stands by tapping below.'
        : 'Kindly update the control room when you can.';
    default:
      return hasButtons
        ? 'Kindly confirm below that this has been actioned.'
        : 'Kindly update the control room when you can.';
  }
}

/**
 * What rides in the template's second parameter when the service window is shut.
 *
 * Shorter and self-contained: this arrives without the thread around it, so it cannot lean on a
 * quoted message the way the session text does. ⚠️ **The template itself is untouched** — only
 * the value of a parameter changes, which needs no approval from anybody.
 */
export function followUpTemplateAsk(kind: MessageKind, category: string | null): string {
  switch (followUpKindFor(kind, category)) {
    case 'gathering':
      return kind === 'schedule'
        ? 'A reminder regarding the subject schedule. Kindly note the same.'
        : 'A reminder regarding the subject meeting. Kindly make it convenient to attend.';
    case 'urgent':
      return 'The control room is awaiting your response.';
    default:
      return 'Kindly confirm that this has been actioned.';
  }
}

/**
 * The whole session message.
 *
 * The control room's own words replace **the ask and never the opening**: a chase that dropped the
 * subject line would arrive in a thread holding several of the district's notices saying only
 * *"Meeting moved to Tuesday"*, and the officer would have to guess which meeting. Keeping the
 * opening is what makes a reschedule readable — which is the case this endpoint exists for.
 */
export function followUpText(
  kind: MessageKind,
  category: string | null,
  what: string,
  note: string | undefined,
  hasButtons: boolean,
): string {
  const said = note === undefined || note === '' ? followUpAsk(kind, category, hasButtons) : note;
  return `${followUpOpening(kind, category, what)}\n\n${said}`;
}
