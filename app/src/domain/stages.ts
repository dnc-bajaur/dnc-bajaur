/**
 * The three stages the district reads — M9-25, narrowed 2026-09-04.
 *
 * The client originally asked for **Issued → Acknowledged → Responded → Resolved**. That
 * fourth word is gone: ADR-0034's per-category templates mean every button an officer can
 * press already IS a response, so `acknowledged` stopped being a moment anything distinct
 * happened at (see `markRespondedIfUnacknowledged` in `domain/incident.ts`, and the owner's own
 * words — *"jaha jaha acknowledge ka concept tha wo ab khtam"*). Keeping a stage for a status
 * nothing produces on purpose any more would be a word on the wall describing a tap that no
 * longer exists.
 *
 * `acknowledged` is still a real `IncidentStatus` — the old in-window workflow's own Acknowledge
 * tap and the control room's manual telephone-confirm endpoint (`api/acknowledgement.ts`) both
 * still write it, deliberately, and are not part of this change. It reads as **Issued** here:
 * an officer who has only confirmed receipt has not yet said what they are doing about it, which
 * is exactly what *Issued* already means below.
 *
 * This system still folds seven statuses: `reported`, `triaged`, `routed`, `acknowledged`,
 * `responding`, `resolved`, `closed` — three of them now share one stage instead of two.
 *
 * ## Why this is a view and not a second status
 *
 * **Nothing here is stored.** There is no stage column, no stage event, and no place a stage can
 * disagree with the log — because the moment two answers to *"what is happening with this
 * emergency"* exist, one of them starts being wrong and nothing says which. ADR-0001 puts the
 * record in the event log; a status column would be a second record, and a second record with a
 * pretty name is still a second record.
 *
 * So a stage is a **function of the status**, computed wherever it is shown, from the same fold
 * the board already runs. Delete this file and nothing is lost but the vocabulary.
 *
 * ## Where the seven collapse, and what that costs
 *
 * `reported`, `triaged` and `routed` are all **Issued**: the district has it, nobody has yet
 * said they are taking it. Those three distinctions are real and stay on the detail screen —
 * *routed to Rescue* is not the same as *not routed to anybody*, and the second is a gap the
 * board must keep showing. What the four stages give is a sentence somebody can say out loud in
 * a meeting, not a replacement for the detail.
 *
 * `resolved` and `closed` are both **Resolved**. Closing is the district's own bookkeeping after
 * the outcome is recorded, and an officer who resolved something at 03:00 should not see it
 * described differently because an administrator has not been to the screen yet.
 *
 * `responding` is **Responded**, and it is the one worth watching: nothing sets it directly.
 * It falls out of somebody *doing* something — an action logged, a unit assigned — which is the
 * honest definition. A stage that could be claimed without an act would be a button that says
 * work is happening.
 */

import type { MessageKind } from './events.js';
import { isGathering } from './events.js';
import type { IncidentStatus } from './incident.js';

export type Stage = 'issued' | 'responded' | 'resolved';

/** In order, so a screen can draw the three without hardcoding the sequence twice. */
export const STAGES: readonly Stage[] = ['issued', 'responded', 'resolved'];

const OF_STATUS: Readonly<Record<IncidentStatus, Stage>> = {
  reported: 'issued',
  triaged: 'issued',
  routed: 'issued',
  // Confirmed receipt is not a response — see the file header. Reads exactly like `reported`.
  acknowledged: 'issued',
  responding: 'responded',
  resolved: 'resolved',
  closed: 'resolved',
};

export function stageOf(status: IncidentStatus): Stage {
  return OF_STATUS[status];
}

/** How far along, 0-based. For a progress strip that must not invent its own ordering. */
export function stageIndex(status: IncidentStatus): number {
  return STAGES.indexOf(stageOf(status));
}

/**
 * What the district calls it.
 *
 * Past tense throughout, because every one of these is a thing that **happened** — and the one
 * place tense matters is *Responded*: "Responding" would be a claim about right now, which
 * nothing in the log can support once the officer has put the phone down.
 */
const LABELS: Readonly<Record<Stage, string>> = {
  issued: 'Issued',
  responded: 'Responded',
  resolved: 'Resolved',
};

export function stageLabel(stage: Stage): string {
  return LABELS[stage];
}

/**
 * The stages a token may still move an incident to — M9-26.
 *
 * **Forward only, and never past Resolved.** This is the whole transition table and it is
 * deliberately tiny: the interesting refusals already live in `checkPrecondition`, which every
 * command goes through. What this adds is the rule a *link* needs, because a link is tapped
 * hours later from a message history, on an emergency that has moved on without it.
 *
 * Returning an empty list is a complete answer and not an error — an officer tapping *Resolved*
 * on something a colleague resolved first has done nothing wrong, and M9-28 says so in words on
 * the page rather than showing them a failure.
 */
export function stagesOfferedFrom(status: IncidentStatus): readonly Stage[] {
  const at = stageIndex(status);
  // Never offered as a next step: it is where the incident already is, or behind it.
  return STAGES.filter((s) => STAGES.indexOf(s) > at && s !== 'issued');
}

/** Whether a token for `stage` still has anything to do on an incident at `status`. */
export function stageIsStillAhead(stage: Stage, status: IncidentStatus): boolean {
  return STAGES.indexOf(stage) > stageIndex(status);
}

/**
 * **The button a handset carries, and it is now built in one place** — Phase 5, 2026-08-21.
 *
 * These three lived in `api/webhooks.ts`, which was right for as long as the webhook was the only
 * thing that ever offered a stage. Phase 5's nudge offers one too, from a scheduled job, and two
 * files formatting the same id by hand is how a tap starts landing on nothing: the id is parsed
 * by `handleOurChoice` against a prefix and a field count, so a builder that put the parts in a
 * different order would produce a button that reaches Meta, reaches the officer, is pressed, and
 * is dropped as *"a choice this version does not recognise"*.
 *
 * ⚠️ **It carries the incident and the attempt, and that is what makes it safe to send late.**
 * The same property the acknowledge token has and for the same reason: these sit in an officer's
 * message history, and one pressed an hour later must still know what it is about rather than
 * asking *"what was the last thing we sent this number?"* — a question whose answer moves.
 *
 * `stage:<stage>:<incidentId>:<attemptId>` is 89 characters against Meta's cap of 256.
 */
export const STAGE_BUTTON = 'stage';

/** How each stage reads on a button. Twenty characters is Meta's limit and *Resolved* is nine. */
export const STAGE_BUTTON_WORDS: Readonly<Record<Stage, string>> = {
  issued: 'Issued',
  /**
   * ⚠️ **This was *On scene* until 2026-08-24, and it was wrong for most of what the district
   * sends.** The word now depends on the message — see `stageButtonWords` below. What stays here
   * is the answer for everything that is not a gathering.
   */
  responded: 'Responding',
  resolved: 'Resolved',
};

export function stageButtonId(stage: Stage, incidentId: string, attemptId: string): string {
  return `${STAGE_BUTTON}:${stage}:${incidentId}:${attemptId}`;
}

/**
 * **What a gathering asks instead** — 2026-08-24.
 *
 * The owner looked at a live handset and said it plainly: *“Meeting k lye Attending ho,
 * Emergency/Flood k lye Responding ho, and so on”*. **One button was wearing one word across
 * seven kinds of message, and the word only ever fitted one of them.**
 *
 * *On scene* is a claim about a place. The same button rides a **meeting notice**, an
 * **advisory** and an **information** message, none of which have a scene — so an officer
 * invited to a meeting at the DC's office was being asked to confirm they had arrived at an
 * incident. `api/webhooks.ts` has said in a comment since 2026-08-23 that *On scene* was never
 * sensible under a notice; this is that comment turned into behaviour.
 *
 * ## Why `kind` and never `category`
 *
 * A meeting **about** the flood is still a meeting somebody attends. Category answers *what a
 * message is about*; this answers *what the reader is being asked to do*, which is the same
 * split, and the same ordering, `thanksKindFor` uses one file over.
 *
 * ## Why this disagrees with `thanksKindFor` about `schedule`, on purpose
 *
 * A schedule gets the **information** thank-you, because the district's meeting sentence says
 * *“attend the subject meeting”* and a duty schedule is not a meeting — sending that would
 * describe the message wrongly. But a schedule **is** a programme with times, and an officer
 * marking themselves against one is attending it. Two questions, two answers; a shared helper
 * here would have to be wrong about one of them.
 *
 * `Attending` is nine characters and `Responding` is ten, against Meta's cap of twenty.
 *
 * ⚠️ **The gathering test is `isGathering` in `domain/events.ts`, never repeated here.** The
 * follow-up asks the same question to decide whether a chase carries controls at all, and the
 * two answers arrive in the same bubble.
 */
export const ATTENDING_WORDS = 'Attending';

/**
 * The word a stage wears on a button, for this message.
 *
 * Total over every `MessageKind`: a kind added later falls to `Responding`, which is the word
 * that is merely flat rather than the one that is false. **Every sender goes through here** —
 * the webhook, the control room's follow-up and the nudge — for the reason `stageButtonId`
 * exists: three files choosing their own wording is three officers reading three buttons for
 * one act.
 */
export function stageButtonWords(stage: Stage, kind: MessageKind): string {
  if (stage !== 'responded') return STAGE_BUTTON_WORDS[stage];
  return isGathering(kind) ? ATTENDING_WORDS : STAGE_BUTTON_WORDS.responded;
}

/**
 * **The *Where I am* button, built here for the reason `stageButtonId` is built here** —
 * 2026-08-23.
 *
 * It was formatted by hand in `api/webhooks.ts` while that file was the only thing that offered
 * it. `api/followUp.ts` offers it too now, and two files formatting one id by hand is exactly how
 * a tap starts landing on nothing: `handleOurChoice` parses against a prefix and a field count, so
 * a builder that put the parts in a different order produces a button that reaches Meta, reaches
 * the officer, is pressed, and is dropped as *"a choice this version does not recognise"*.
 *
 * ⚠️ **Its own id space, never a stage's**, and that is `mintAvailability`'s rule rather than
 * tidiness: an officer saying they are in the field has not responded to anything and certainly
 * has not resolved it. Folding the two prefixes together would lose that distinction at the one
 * layer where it is cheapest to lose.
 */
export const WHERE_BUTTON = 'where';

/** What it says. Twenty characters is Meta's limit and this is eleven. */
export const WHERE_BUTTON_WORDS = 'Where I am';

export function availabilityButtonId(incidentId: string, attemptId: string): string {
  return `${WHERE_BUTTON}:${incidentId}:${attemptId}`;
}
