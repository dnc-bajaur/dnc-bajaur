/**
 * **What an officer is offered once they have acknowledged** — the district's own workflow,
 * 2026-08-24.
 *
 * They sent five pages titled *Official WhatsApp Response and Acknowledgement Workflow*: ten
 * categories, each with three to five things an officer may say, a shared *Unable to Respond*
 * branch under nine of them, and one closing sentence. The whole design and the ten questions it
 * left open are in `backlog/whatsapp-response-workflow.md`.
 *
 * ## 🔴 No Meta template is altered by any of this, and that was the district's first condition
 *
 * Their words through the owner: *"wo template ko change nhe karna chah rahe hain, wo chahte hain
 * k template wahi wo okay hai"*. Everything here is sent **after** the *Acknowledge* tap, inside
 * the 24-hour service window that tap opens, where a free-form message needs no approval. Nothing
 * is submitted, nothing waits in a review queue, and `npm run doctor` must go on passing unchanged.
 *
 * ## Nothing here is stored — `attendance.ts`'s argument, applied a second time
 *
 * An option is **a statement an officer made**, and it is recorded exactly where a meeting answer
 * is recorded: as the settled attempt's `said`, in the district's own words, with `via` saying how
 * we found out. `optionOfSaid` reads it back the way `answerOf` reads back *Attending*.
 *
 * **There is no option column, no `response_type` event and no second place for it to live** —
 * because the moment two answers to *"what did this officer say"* exist, one of them starts being
 * wrong and nothing says which (ADR-0001). What an option additionally *implies* about the
 * emergency goes through the machinery that already exists: `records: 'responded'` appends the
 * `action_logged` the fold already turns into *Responding*, and `records: 'resolved'` appends the
 * `resolved` event, exactly as the stage buttons and the acknowledgement page do.
 *
 * ## ⚠️ The Meeting category is deliberately absent
 *
 * The district's §9 is *Attending · Sending a Representative · Not Attending*, and those three are
 * `ATTENDANCE_ANSWERS` — **approved at Meta as quick replies on `district_notice_v2`**, matched by
 * position. Rewording them here would mean resubmitting the template the district asked us not to
 * touch, and a second copy of the same three answers would drift from the approved one within a
 * month. A meeting already works; the only thing their document adds is a reason under *Not
 * Attending*, and that belongs beside the attendance flow rather than here.
 *
 * ## ⚠️ Two limits from Meta, and they are the whole reason for `headline`
 *
 * A list row's **title is 24 characters** and its **description is 72**. Twenty-two of the
 * district's thirty-three options are longer than 24 — two of them by a single character — so
 * every row carries a short headline on the first line and **the district's wording, uncut, on the
 * second**. Both caps are held by `__tests__/responseOptions.test.ts` rather than by care, because
 * a title of 25 characters is a 400 from Meta on a real night and reads as *"the alert did not
 * send"*.
 *
 * 🔴 **`wording` is what reaches the record, never `headline`.** A tap returns the id, the wording
 * is looked up from it, and that is what the board, the incident screen, the daily report and the
 * export all read. The headline exists only on the glass of a handset.
 */

import type { MessageKind } from './events.js';

/** Meta's cap on a list row's title. */
export const HEADLINE_MAX = 24;

/** Meta's cap on the line under it. Every one of the district's sentences fits. */
export const WORDING_MAX = 72;

/**
 * What an option means for the emergency itself.
 *
 * ⚠️ **`acknowledged` is legal here and produced by NOTHING — 2026-09-04.** It was the outcome for
 * a handful of the old in-window options (`cognizance`, `alert_more_info`, `adv_clarify`,
 * `info_noted`, `info_clarify`) back when this catalog's whole premise was "sent after the
 * *Acknowledge* tap, so a plain acknowledgement is a real, distinct thing an option can mean".
 * That premise stopped being true the day `TEMPLATE_OPTIONS` shipped (ADR-0034): every one of the
 * new per-category templates' three buttons maps to `responded` or `resolved`, on every category,
 * with no exception — the first tap already **is** the response, so there is no tap left that
 * means only "I saw this and nothing else". The five options above were re-mapped to `responded`
 * to match: an officer who typed "Taking Cognizance" or "Information Noted" answered in their own
 * words, which is a response, not a lesser thing standing beside one. The value is kept in the
 * type rather than deleted so old events already on the log (which named it) keep meaning what
 * they meant, and so nothing has to guess what a future option that genuinely needs it would be
 * called.
 *
 * `no_owner` records nothing on the incident, and that is the point rather than an omission:
 * *"I cannot"* and *"this is not mine"* are **answers**, so the obligation is met and the officer
 * leaves the chase list — but nobody has taken the emergency, which is what `domain/ownership.ts`
 * reads back off these same words.
 */
export type Records = 'acknowledged' | 'responded' | 'resolved' | 'no_owner';

/**
 * What is asked next, if anything.
 *
 * `branch` opens the three sub-options of *Unable to Respond*. The other three name a question
 * whose answer is the officer's own sentence — and each is a **separate** kind rather than one
 * "ask something", for `askWhatHappened`'s reason: a shared helper is one wording away from asking
 * an officer who is coming when the district wanted to know why they cannot.
 */
export type Asks = 'nothing' | 'message' | 'branch' | 'name' | 'until' | 'reason';

export interface ResponseOption {
  /** Stable, short, and carried inside a button id. **Never change one that has shipped.** */
  readonly id: string;
  /** What the officer reads on the row. At most `HEADLINE_MAX`. */
  readonly headline: string;
  /** The district's own sentence, word for word. At most `WORDING_MAX`. */
  readonly wording: string;
  readonly records: Records;
  readonly asks: Asks;
}

/**
 * The nine lists. Meeting is absent for the reason in this file's header.
 *
 * Named after the district's own headings rather than after this system's categories, so the two
 * documents can be read side by side. `rta` is the one exception — it is what every other file
 * here calls a road accident, and inventing `road_accident` for one module would be worse.
 */
export type ResponseList =
  | 'other'
  | 'fire'
  | 'medical'
  | 'rta'
  | 'alert'
  | 'flood'
  | 'security'
  | 'advisory'
  | 'information';

/**
 * The three ways to be unavailable, shared by every list that offers *Unable to Respond*.
 *
 * ⚠️ **Each asks a different question, and that is the district's request answered rather than
 * refused.** They asked that a reason be taken back on *Unable to Respond* itself and not only on
 * *Otherwise Unavailable*. Three sub-options plus a fourth free-text question is three taps at
 * 02:00, which is where an officer puts the phone down — so instead **every branch returns
 * something**, and each returns the thing that is actually useful:
 *
 *   * a representative is a **person**, so it asks who (`askWhoIsComing`, which already exists)
 *   * leave is a **duration**, so it asks how long — *why* somebody is on leave is their own
 *     business and of no use to a control room, while *how long* is exactly what it plans around
 *   * anything else is genuinely open, so it asks for their words
 */
export const UNABLE_BRANCH: readonly ResponseOption[] = [
  /**
   * 🔴 **This one is `responded`, not `no_owner`, and it is the one place this file disagrees
   * with where the district filed it.**
   *
   * They put it under *Unable to Respond*, and about the **officer** that is exactly right: they
   * personally cannot come. But `records` does not answer *can this officer come* — it answers
   * *does the control room need to send somebody else*, and here the answer is **no**. A Naib
   * Tehsildar is on the way and the officer has named them.
   *
   * Reading it as a decline would put an orange *reassign this* flag on an emergency that is
   * already covered, and the orange flag is only worth anything while it means what it says
   * (INV-08's alert fatigue, arriving through a panel instead of a handset).
   *
   * It also matches what the software already does: `recordSubstitute` has appended an
   * `action_logged` for a named deputy since Phase B, and that event is what moves an incident to
   * *Responding*. Filing this as `no_owner` would have left the fold and the ownership count
   * saying opposite things about one tap.
   */
  {
    id: 'unable_rep',
    headline: 'Sending a representative',
    wording: 'Sending a Responsible Representative',
    records: 'responded',
    asks: 'name',
  },
  {
    id: 'unable_leave',
    headline: 'On Leave',
    wording: 'On Leave',
    records: 'no_owner',
    asks: 'until',
  },
  {
    id: 'unable_other',
    headline: 'Otherwise Unavailable',
    wording: 'Otherwise Unavailable',
    records: 'no_owner',
    asks: 'reason',
  },
];

/**
 * *Unable to Respond*, as it appears at the foot of eight lists.
 *
 * ⚠️ **Category 1 does not use this one.** The district wrote *"Unable to Attend / Respond"* there
 * and *"Unable to Respond"* in the other eight. It is almost certainly the same thing — the design
 * document says so and asks them to confirm — but **their wording is what reaches the record**, so
 * the two are two options rather than one with the difference quietly ironed out.
 */
const UNABLE: ResponseOption = {
  id: 'unable',
  headline: 'Unable to respond',
  wording: 'Unable to Respond',
  records: 'no_owner',
  asks: 'branch',
};

const UNABLE_ATTEND: ResponseOption = {
  id: 'unable_attend',
  headline: 'Unable to respond',
  wording: 'Unable to Attend / Respond',
  records: 'no_owner',
  asks: 'branch',
};

/**
 * **The two sentences the district reuses across lists get one id each, not one per list.**
 *
 * *"Matter Already Being Handled"* appears under Fire and under Security; *"Matter Already Being
 * Attended"* under Medical and under Road Accident. The first draft gave each list its own id and
 * `responseOptions.test.ts` refused it on the first run — and the refusal is right rather than
 * pedantic.
 *
 * 🔴 **`optionOfSaid` reads an option back out of the wording, because the wording is the record.**
 * Two ids sharing one sentence means the record cannot say which was tapped, so the id would be
 * carrying a distinction that survives only until the tap is over. Worse, it would be a *false*
 * distinction: an officer saying a fire is already being handled has said exactly what an officer
 * says about a security matter, and a report that separated them would be separating them by which
 * list the operator happened to file the message under.
 *
 * One sentence, one option, however many lists offer it — which is `UNABLE` shared eight ways, for
 * the same reason.
 */
/**
 * 🔴 **`resolved`, and that is the DISTRICT'S answer of 2026-08-25 rather than a reading.**
 *
 * This shipped as `responded` on 24 August with the reasoning written down: *somebody else is on
 * it* sounded like an emergency in progress, and closing one on an officer's report about a
 * colleague looked like the more dangerous mistake of the two. **§9 Q4 put exactly that to the
 * district**, and they answered plainly — *"han g Already being handlled ka matlab khatm hai"*.
 *
 * ⚠️ **So this option now CLOSES an emergency.** It comes off the board, the SLA clock stops, and
 * the ladder ends. The district's own sentence goes in as the outcome, so the record says who
 * closed it and on what words — and `reopened` exists for the tap somebody regrets.
 *
 * The concern is left written here rather than deleted, because it was raised before the answer
 * and the answer does not make it untrue: if a live emergency is ever found closed on one of
 * these three, **this comment is where to start**.
 */
const ALREADY_HANDLED: ResponseOption = {
  id: 'already_handled',
  headline: 'Already being handled',
  wording: 'Matter Already Being Handled',
  records: 'resolved',
  asks: 'nothing',
};

/** The same answer and the same reasoning as `ALREADY_HANDLED` — §9 Q4, 2026-08-25. */
const ALREADY_ATTENDED: ResponseOption = {
  id: 'already_attended',
  headline: 'Already being attended',
  wording: 'Matter Already Being Attended',
  records: 'resolved',
  asks: 'nothing',
};

/**
 * The district's ten categories, less the meeting, in their order.
 *
 * ⚠️ **`records` on *"Matter Already Being Handled / Attended / Under Control"* is `resolved`,
 * answered by the district on 2026-08-25.** It shipped as `responded` the day before, on the
 * reading that *somebody else is on it* describes an emergency in progress. §9 Q4 asked them and
 * they said it means the matter is finished, so all four of these sentences now close it.
 * Closing an emergency on an officer's report that a colleague is dealing with it would put a live
 * fire into the resolved column, and the district is asked to confirm the split in §9 Q4.
 */
const LISTS: Readonly<Record<ResponseList, readonly ResponseOption[]>> = {
  other: [
    {
      id: 'cognizance',
      headline: 'Taking Cognizance',
      wording: 'Taking Cognizance',
      // Was 'acknowledged' — reclassified 2026-09-04. The district's new template mechanism
      // (ADR-0034) never produces a bare acknowledgement: every button on every category maps
      // to responded or resolved, because the first tap already IS the response. Taking
      // Cognizance is the officer answering in their own words, which is a response — nothing
      // less — so it is counted the same way rather than through a separate, disappearing
      // "acknowledged" stage. See the note on `Records` above.
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'already_resolved',
      headline: 'Issue Already Resolved',
      wording: 'Issue Already Resolved',
      records: 'resolved',
      asks: 'nothing',
    },
    {
      id: 'dept_taking_up',
      headline: 'Taken up with department',
      wording: 'Matter Being Taken Up with the Concerned Department',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'not_mine',
      headline: 'Not Related to Me',
      wording: 'Not Related to Me',
      records: 'no_owner',
      asks: 'nothing',
    },
    UNABLE_ATTEND,
  ],
  fire: [
    {
      id: 'fire_personally',
      headline: 'Responding Personally',
      wording: 'Responding Personally',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'fire_deploy',
      headline: 'Deploying staff / team',
      wording: 'Deploying Relevant Staff / Team',
      records: 'responded',
      asks: 'nothing',
    },
    ALREADY_HANDLED,
    UNABLE,
  ],
  medical: [
    {
      id: 'med_immediate',
      headline: 'Taking Immediate Action',
      wording: 'Taking Immediate Action',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'med_teams',
      headline: 'Medical Teams Ready',
      wording: 'Medical Teams Ready',
      records: 'responded',
      asks: 'nothing',
    },
    ALREADY_ATTENDED,
    UNABLE,
  ],
  rta: [
    {
      id: 'rta_site',
      headline: 'Proceeding to the site',
      wording: 'Proceeding to the Site',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'rta_dispatch',
      headline: 'Team being dispatched',
      wording: 'Relevant Team Being Dispatched',
      records: 'responded',
      asks: 'nothing',
    },
    ALREADY_ATTENDED,
    {
      id: 'rta_police',
      headline: 'Police / Rescue informed',
      wording: 'Police / Rescue / Relevant Department Informed',
      records: 'responded',
      asks: 'nothing',
    },
    UNABLE,
  ],
  alert: [
    {
      id: 'alert_action',
      headline: 'Noted — taking action',
      wording: 'Alert Noted — Taking Necessary Action',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'alert_team',
      headline: 'Field team alerted',
      wording: 'Relevant Staff / Field Team Alerted',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'alert_control',
      headline: 'Already under control',
      wording: 'Matter Already Under Control',
      // §9 Q4, 2026-08-25 — see `ALREADY_HANDLED`. Under control is over, and it closes.
      records: 'resolved',
      asks: 'nothing',
    },
    {
      id: 'alert_more_info',
      headline: 'More information needed',
      wording: 'Further Information Required',
      // Was 'acknowledged' — reclassified 2026-09-04, same reasoning as `cognizance` above.
      records: 'responded',
      asks: 'message',
    },
    UNABLE,
  ],
  flood: [
    {
      id: 'flood_preventive',
      headline: 'Taking preventive steps',
      wording: 'Taking Preventive Measures',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'flood_deploy',
      headline: 'Field team deployed',
      wording: 'Field Team Being Deployed',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'flood_monitor',
      headline: 'Situation monitored',
      wording: 'Situation Being Monitored',
      records: 'responded',
      asks: 'nothing',
    },
    UNABLE,
  ],
  security: [
    {
      id: 'sec_measures',
      headline: 'Security measures taken',
      wording: 'Security Measures Being Taken',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'sec_personnel',
      headline: 'Personnel deployed',
      wording: 'Security Personnel Being Deployed',
      records: 'responded',
      asks: 'nothing',
    },
    ALREADY_HANDLED,
    {
      id: 'sec_agency',
      headline: 'Security agency informed',
      wording: 'Relevant Security Agency / Department Informed',
      records: 'responded',
      asks: 'nothing',
    },
    UNABLE,
  ],
  advisory: [
    {
      id: 'adv_measures',
      headline: 'Noted — taking measures',
      wording: 'Advisory Noted — Necessary Measures Being Taken',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'adv_conveyed',
      headline: 'Conveyed to staff',
      wording: 'Advisory Conveyed to Relevant Staff',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'adv_in_place',
      headline: 'Already in place',
      wording: 'Necessary Preventive Measures Already in Place',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'adv_clarify',
      headline: 'Need clarification',
      wording: 'Further Clarification Required',
      // Was 'acknowledged' — reclassified 2026-09-04, same reasoning as `cognizance` above.
      records: 'responded',
      asks: 'message',
    },
    /**
     * ⚠️ **The district's document lists this option here and then never gives its three
     * sub-options** — it jumps straight to *"If Otherwise Unavailable is selected"*. Read as a slip
     * and given the same branch as everywhere else; §9 Q2 asks them to confirm. Offering nothing
     * would have been the other reading, and it would leave an officer who cannot act on an
     * advisory with no way to say so.
     */
    UNABLE,
  ],
  /**
   * ⚠️ **Information has no *Unable to Respond*, and here that is left exactly as written.**
   * Unlike the advisory above there is no internal contradiction to repair — the district simply
   * did not offer one, and information asks nobody to go anywhere. §9 Q3 asks whether that is
   * deliberate; until it is answered, adding an option they did not write would be this software
   * inventing a district's words.
   */
  information: [
    {
      id: 'info_noted',
      headline: 'Information Noted',
      wording: 'Information Noted',
      // Was 'acknowledged' — reclassified 2026-09-04, same reasoning as `cognizance` above.
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'info_conveyed',
      headline: 'Conveyed to staff',
      wording: 'Information Conveyed to Relevant Staff',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'info_action',
      headline: 'Action being taken',
      wording: 'Necessary Action Being Taken',
      records: 'responded',
      asks: 'nothing',
    },
    {
      id: 'info_clarify',
      headline: 'Need clarification',
      wording: 'Information Requires Further Clarification',
      // Was 'acknowledged' — reclassified 2026-09-04, same reasoning as `cognizance` above.
      records: 'responded',
      asks: 'message',
    },
  ],
};

/**
 * What sits above the options on the acknowledgement **page**.
 *
 * ⚠️ **Not a WhatsApp heading, because a WhatsApp list has none.** `sendSession` builds one
 * unnamed section on purpose — *"five answers to one question are not a catalogue, and a heading
 * over them would be the question asked twice"* — so in the thread the body text carries it. A
 * page has room and a reader who is scrolling rather than tapping, and the two are allowed to
 * differ for that reason alone.
 */
const LIST_TITLES: Readonly<Record<ResponseList, string>> = {
  other: 'Your response',
  fire: 'Fire — your response',
  medical: 'Medical — your response',
  rta: 'Accident — response',
  alert: 'Alert — your response',
  flood: 'Flood — your response',
  security: 'Security — response',
  advisory: 'Advisory — response',
  information: 'Information — response',
};

export function listTitle(list: ResponseList): string {
  return LIST_TITLES[list];
}

export function optionsOf(list: ResponseList): readonly ResponseOption[] {
  return LISTS[list];
}

/**
 * Which list a message gets — the district's ten mapped onto the two labels the record keeps.
 *
 * Their categories mix **what a message is about** (`category`: fire, flood, rta, medical,
 * security, other) with **what kind of message it is** (`MessageKind`). A security alert is
 * genuinely both at once, which is the question `backlog/five-categories-questions.md` has had
 * open since 2026-08-22.
 *
 * ⚠️ **Answered here as: the KIND wins, so a flood alert gets the Alert list.** This is option (a)
 * of that document, and it is the one that cannot be filed wrongly — the operator already chooses
 * a kind correctly today, and nothing new is asked of them. The subject's own list is then what an
 * **emergency** about that subject gets, which is where *"Proceeding to the Site"* belongs.
 *
 * It is one line to reverse if the district answers the other way, and §9 Q6 asks them.
 *
 * ⚠️ **Null for a meeting, and null is not an omission** — `attendanceFor` owns that conversation
 * and its three answers are approved at Meta. See this file's header.
 *
 * Total over every kind and every category: a kind added later falls to `information`, which is
 * the list that merely asks little rather than the one that asks the wrong thing.
 */
export function listFor(kind: MessageKind, category: string | null): ResponseList | null {
  if (kind === 'meeting') return null;
  if (kind === 'alert') return 'alert';
  if (kind === 'advisory') return 'advisory';
  if (kind === 'emergency') {
    if (category === 'fire') return 'fire';
    if (category === 'medical') return 'medical';
    if (category === 'rta') return 'rta';
    if (category === 'flood') return 'flood';
    if (category === 'security') return 'security';
    return 'other';
  }
  /**
   * An **order** is an instruction from the DC office with an expectation of compliance, and the
   * *Other* list is the one that lets an officer say they have taken cognizance, that it is
   * already done, or that it is not theirs. The district's document names no list for it — §9 Q5.
   */
  if (kind === 'order') return 'other';
  return 'information';
}

/** Every option this software offers, across every list, plus the three under *Unable*. */
export function allOptions(): readonly ResponseOption[] {
  const seen = new Map<string, ResponseOption>();
  for (const list of Object.values(LISTS)) {
    for (const option of list) if (!seen.has(option.id)) seen.set(option.id, option);
  }
  for (const option of UNABLE_BRANCH) if (!seen.has(option.id)) seen.set(option.id, option);
  return [...seen.values()];
}

/** The option an id names, or null for an id this version does not know. */
export function optionById(id: string): ResponseOption | null {
  return allOptions().find((option) => option.id === id) ?? null;
}

/**
 * The district’s options, **written into the message itself** — the owner, 2026-08-26.
 *
 * ## Why the words are repeated in a message that already carries them
 *
 * A WhatsApp list renders as a **button**, and the rows live in a sheet behind it. Nothing in
 * Meta’s interactive message draws a row inline, and the only control that sits directly under a
 * message is a reply button — three of them, at twenty characters. Every one of the district’s
 * nine lists has four or five options, so buttons cannot carry them without cutting the
 * district's own answers. The officer therefore saw *“Tap to reply”* and no hint of what was
 * behind it.
 *
 * So the options are written into the body as well. They are read **before** the tap rather than
 * after it, and the tap still does the choosing.
 *
 * ⚠️ **Numbered, and the numbers are load-bearing.** An officer who can see a numbered list will
 * type `2` — and until `optionTyped` existed that typed `2` went onto the record as the literal
 * character, matched no option, and left the emergency short of `responded` with the word “2”
 * showing on the board. The number in this text and the number that function counts are the same
 * number, and that is why both live in this file.
 *
 * ⚠️ **`wording` and never `headline`.** The headline is a 24-character label invented to fit
 * Meta’s row title; the wording is the district’s own sentence. A message has room for the real
 * one, and the officer should read what the record will say.
 */
export function optionsWrittenOut(lead: string, options: readonly ResponseOption[]): string {
  const lines = options.map((option, i) => `${String(i + 1)}. ${option.wording}`);
  return `${lead}\n\n${lines.join('\n')}`;
}

/**
 * Read a **typed** answer as one of the options that were offered — the other half of
 * `optionsWrittenOut`, and the reason writing them out is safe.
 *
 * Three ways an officer can name an option, all of them things people actually do:
 *
 * - **`2`** — the number they can see. Only within range; `7` of five options is not an answer.
 * - **the district's sentence**, typed or pasted back.
 * - **the row label**, which is what they would have seen had they opened the sheet.
 *
 * ⚠️ **Scoped to the list that was offered, never to every option this software knows.** A bare
 * `2` means nothing on its own — it means the second thing this officer was shown. `optionById`
 * is the global lookup and it is right for a row id, which carries its own identity; a number
 * carries none.
 *
 * ⚠️ **Deliberately not forgiving of anything else.** A sentence that is not one of these is the
 * officer’s own words, which is a different and often better thing — `optionOfSaid` draws the
 * same line and says so. Reading *“1 casualty”* as option 1 would put an answer on the record
 * that nobody gave.
 */
export function optionTyped(
  text: string | null | undefined,
  options: readonly ResponseOption[],
): ResponseOption | null {
  if (text === null || text === undefined) return null;
  const wanted = text.trim().toLowerCase();
  if (wanted === '') return null;

  if (/^[0-9]+$/.test(wanted)) {
    const n = Number(wanted);
    return n >= 1 && n <= options.length ? (options[n - 1] ?? null) : null;
  }

  return (
    options.find(
      (option) =>
        option.wording.toLowerCase() === wanted || option.headline.toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * Read an option back out of what an officer said — `attendance.ts`'s `answerOf`, exactly.
 *
 * **This is what makes the record the only record.** The attempt carries the district's sentence
 * in `said`; every screen, count and report that needs to know *which* option it was asks here
 * rather than reading a column that would have to be kept in step with it.
 *
 * Forgiving of case and stray space, and of nothing else. A sentence that is not one of the
 * district's is not an option — it is an officer's own words, which is a different and often
 * better thing (`AttendanceAnswer`'s `other` makes the same distinction).
 */
export function optionOfSaid(said: string | null | undefined): ResponseOption | null {
  if (said === null || said === undefined) return null;
  const wanted = said.trim().toLowerCase();
  if (wanted === '') return null;
  return allOptions().find((option) => option.wording.toLowerCase() === wanted) ?? null;
}

/**
 * **The per-category `dnc_response_*` Meta templates — 2026-09-03, wired 2026-09-XX.**
 *
 * Everything above this line is the **in-window** response workflow: sent by `sendSession` as an
 * interactive list *after* the officer taps *Acknowledge* on `district_emergency_v2`, or drawn on
 * the `/ack/` page. It is untouched.
 *
 * What follows is a second road the district asked for: each emergency category has its own
 * **approved Meta template** carrying three category-specific quick replies and nothing else — no
 * *Acknowledge* button, no link. The template *is* the first message, and the officer's first tap
 * **is** their response. There is no *Unable to Respond* branch on these — the officer types a
 * free reply if none of the three fits (`backlog/whatsapp-response-workflow.md`, ADR-0034).
 *
 * ## Why this lives here and not in `ops/whatsappTemplate.ts`
 *
 * `whatsappTemplate.ts` owns the template *shapes* — what is submitted to Meta. This owns what a
 * *tap comes back as*: `webhooks.ts` matches an inbound button label against
 * {@link templateOptionFor} and runs the same `applyResponseStage` / `askWhatFollows` machinery a
 * `resp:` row runs. `whatsappTemplate.ts`'s header comment has warned since it was written that
 * *"these labels and the option catalogue in `domain/responseOptions.ts` must stay in step"* —
 * this is that step, and `whatsappTemplate.test.ts` pins the two arrays byte for byte.
 *
 * ⚠️ **NOT in `allOptions()`, on purpose.** `allOptions()` feeds `optionOfSaid` and, through it,
 * `domain/ownership.ts`, and `responseOptions.test.ts` asserts an exact count of `resolved`
 * options across it. These are a parallel catalogue, matched only by {@link templateOptionFor},
 * scoped to one category at a time — a label shared across categories (`Coordinating w/ Dept`
 * appears on five templates) is three distinct rows here, not one, and that is fine because the
 * lookup is never global.
 *
 * ⚠️ **`records` on a `btn 3` such as `Being Handled` is `resolved`** — the district's own answer
 * of §9 Q4, *"Already being handlled ka matlab khatm hai"*. One tap takes the emergency off the
 * board and stops its clock; `reopened` exists for the tap somebody regrets. The `resolved` cells
 * are called out in `backlog/for-the-owner.md` for a final look.
 */
export type TemplateCategory =
  | 'security'
  | 'fire'
  | 'road_accident'
  | 'medical'
  | 'flood'
  | 'rescue'
  | 'other'
  | 'alert'
  | 'advisory'
  | 'order'
  | 'schedule'
  | 'information';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'security',
  'fire',
  'road_accident',
  'medical',
  'flood',
  'rescue',
  'other',
  'alert',
  'advisory',
  'order',
  'schedule',
  'information',
];

/** A tap on one of the three quick replies of a `dnc_response_<category>` template. */
function tmpl(id: string, label: string, records: Records): ResponseOption {
  return { id, headline: label, wording: label, records, asks: 'nothing' };
}

/**
 * The three quick replies of each `dnc_response_<category>` template, **in the approved order**.
 *
 * ⚠️ **Every `wording` here must equal the matching entry in `RESPONSE_TEMPLATES`
 * (`ops/whatsappTemplate.ts`) exactly** — a tap comes back as the label, and a label that has
 * drifted is a tap this software cannot read. `whatsappTemplate.test.ts` asserts the two arrays
 * are identical. `domain/` may not import `ops/`, which is why the words are written twice and a
 * test — not a shared constant — holds them together.
 */
export const TEMPLATE_OPTIONS: ReadonlyMap<
  TemplateCategory,
  readonly [ResponseOption, ResponseOption, ResponseOption]
> = new Map([
  [
    'security',
    [
      tmpl('t_security_a', 'Security Deployed', 'responded'),
      tmpl('t_security_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_security_c', 'Being Handled', 'resolved'),
    ],
  ],
  [
    'fire',
    [
      tmpl('t_fire_a', 'Fire Team Dispatched', 'responded'),
      tmpl('t_fire_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_fire_c', 'Being Handled', 'resolved'),
    ],
  ],
  [
    'road_accident',
    [
      tmpl('t_rta_a', 'Response Team Sent', 'responded'),
      tmpl('t_rta_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_rta_c', 'Being Attended', 'responded'),
    ],
  ],
  [
    'medical',
    [
      tmpl('t_medical_a', 'Medical Aid Arranged', 'responded'),
      tmpl('t_medical_b', 'Coord w/ Health Dept', 'responded'),
      tmpl('t_medical_c', 'Aid Already Provided', 'resolved'),
    ],
  ],
  [
    'flood',
    [
      tmpl('t_flood_a', 'Relief Team Sent', 'responded'),
      tmpl('t_flood_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_flood_c', 'Being Handled', 'resolved'),
    ],
  ],
  [
    'rescue',
    [
      tmpl('t_rescue_a', 'Rescue Aid Arranged', 'responded'),
      tmpl('t_rescue_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_rescue_c', 'Operation Underway', 'responded'),
    ],
  ],
  [
    'other',
    [
      tmpl('t_other_a', 'Action Taken', 'responded'),
      tmpl('t_other_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_other_c', 'Already Handled', 'resolved'),
    ],
  ],
  [
    'alert',
    [
      tmpl('t_alert_a', 'Acting on Alert', 'responded'),
      tmpl('t_alert_b', 'Coordinating w/ Dept', 'responded'),
      tmpl('t_alert_c', 'Being Handled', 'resolved'),
    ],
  ],
  [
    'advisory',
    [
      tmpl('t_advisory_a', 'Acting on Advisory', 'responded'),
      tmpl('t_advisory_b', 'Conveyed to Dept', 'responded'),
      tmpl('t_advisory_c', 'Already Addressed', 'resolved'),
    ],
  ],
  [
    'order',
    [
      tmpl('t_order_a', 'Received & Acting', 'responded'),
      tmpl('t_order_b', 'Action Completed', 'resolved'),
      tmpl('t_order_c', 'Unable to Act', 'responded'),
    ],
  ],
  [
    'schedule',
    [
      tmpl('t_schedule_a', 'Schedule Accepted', 'responded'),
      tmpl('t_schedule_b', 'Coord. Accordingly', 'responded'),
      tmpl('t_schedule_c', 'Unable to Follow', 'responded'),
    ],
  ],
  [
    'information',
    [
      tmpl('t_information_a', 'Received & Acting', 'responded'),
      tmpl('t_information_b', 'Conveyed to Dept', 'responded'),
      tmpl('t_information_c', 'Already Addressed', 'resolved'),
    ],
  ],
]);

/**
 * Which `dnc_response_<category>` template a message gets, or `null` for one that has none.
 *
 * Finer-grained than {@link listFor}: that one collapses `order`→`other` and `schedule`→
 * `information` because the in-window lists were written that way; the Meta templates are one per
 * category, so this keeps them apart.
 *
 * `category` (`state.category?.value`) is only meaningful for `kind === 'emergency'` — every other
 * kind carries `category: 'other'` from the intake `TILES` table (`web/src/main.ts`), so the
 * **kind** is what tells `alert` from `advisory` from `schedule` from `information` there.
 *
 * ⚠️ **Total, and `null` for a meeting** — `district_notice_v2` owns that conversation with its
 * three approved attendance replies.
 */
export function templateCategoryFor(
  kind: MessageKind,
  category: string | null,
): TemplateCategory | null {
  if (kind === 'meeting') return null;
  if (kind === 'alert') return 'alert';
  if (kind === 'advisory') return 'advisory';
  if (kind === 'order') return 'order';
  if (kind === 'schedule') return 'schedule';
  if (kind === 'other') return 'information';
  // kind === 'emergency'
  if (category === 'fire') return 'fire';
  if (category === 'medical') return 'medical';
  if (category === 'rta') return 'road_accident';
  if (category === 'rescue') return 'rescue';
  if (category === 'flood') return 'flood';
  if (category === 'security') return 'security';
  return 'other';
}

/**
 * Read an inbound quick-reply tap on a `dnc_response_*` template back as the option it names.
 *
 * ⚠️ **Scoped to this incident's own category**, never to every template label this software
 * knows: `Coordinating w/ Dept` is on five of the templates, so a bare label match would be
 * ambiguous. `webhooks.ts` passes the incident's `kind` and `category`, this resolves the
 * template, and the label is matched only against that template's own three.
 *
 * Returns `null` for a label that is not one of that template's three — which is the ordinary
 * outcome for a typed sentence or a tap on `district_emergency_v2` / `district_notice_v2`.
 */
export function templateOptionFor(
  kind: MessageKind,
  category: string | null,
  text: string | null | undefined,
): ResponseOption | null {
  if (text === null || text === undefined) return null;
  const slug = templateCategoryFor(kind, category);
  if (slug === null) return null;
  const options = TEMPLATE_OPTIONS.get(slug);
  if (options === undefined) return null;
  const wanted = text.trim().toLowerCase();
  if (wanted === '') return null;
  return options.find((option) => option.wording.toLowerCase() === wanted) ?? null;
}
