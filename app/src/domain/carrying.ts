/**
 * **The things that do not finish at midnight** — the district's five, 2026-08-22.
 *
 * The district asked for Security, Flood, Alert & Advisory, Meetings and Information to have
 * their own place on the dashboard, outside the daily reset, closed only by the control room.
 * That reads as five categories and is not. Their own words are the design:
 *
 * * a meeting — *"Monday ko hai ya agle hafte … rahegi till its done"*
 * * a flood — *"kisi bhi din tak chal sakta hai"*
 * * security — *"kisi bhi din tak security risk ho sakta hai"*
 * * information — *"iski date bhi specific nahi hoti"*
 *
 * **Five examples of one rule.** So this file holds **one predicate**, not five lists, and the
 * dashboard grows **one panel** with five named lanes inside it rather than five panels.
 *
 * ## What that dissolves
 *
 * *"Does a security alert belong under Security or under Alert & Advisory?"* was the question
 * that looked hardest, and it has no answer because it is the wrong question — a panel that
 * selects on **"has this finished?"** is not a taxonomy. A security alert keeps **both** its
 * labels (`kind: 'alert'`, `category: 'security'`) and appears because it is still running.
 *
 * ## Pure, and computed rather than stored
 *
 * `stages.ts`'s argument applied again: nothing here is written to a column or an event.
 * The moment two answers to *"is this still running"* exist, one of them starts being wrong and
 * nothing says which. The **override** is a pair of events, because that is a decision somebody
 * made — but the default is a function, recomputed wherever it is shown.
 */

import { districtDate, endOfNamedDistrictDay } from './districtTime.js';
import type { Instant, MessageKind } from './events.js';
import type { IncidentState } from './incident.js';

/**
 * The kinds that carry past the district's midnight on their own.
 *
 * `meeting` is the district's *Meetings*; `alert` and `advisory` are their *Alert & Advisory*;
 * `other` is their *Information* — the kind `communications.ts` labels *Notice*, and the one
 * they described as *"iski date bhi specific nahi hoti"*.
 *
 * ⚠️ **`schedule` is deliberately absent, and it is the one entry I am unsure of.** A duty
 * roster spans days by definition, so an argument exists for including it — but the district
 * listed five things and a schedule was not among them, and adding a sixth on my own reasoning
 * would put rows on their wall they never asked for. It is written down for them to answer in
 * `backlog/for-the-owner.md`; until then a schedule about a flood still carries, through
 * `CARRIED_CATEGORIES` below.
 */
/**
 * ⚠️ **Exported as arrays so the QUERY that narrows candidates can be handed the same
 * vocabulary this file decides on** — `db/eventStore.ts`'s `loadCarriedIncidents`.
 *
 * The alternative is these four words written a second time inside SQL, and the day somebody
 * adds a fifth kind here the loader would go on selecting four of them: the panel would simply
 * stop showing a category, silently, with every test in this file still green. Passing them as
 * query parameters keeps one definition, and the SQL only ever **narrows** — the fold decides.
 */
export const CARRIED_KIND_LIST: readonly MessageKind[] = ['meeting', 'alert', 'advisory', 'other'];

const CARRIED_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(CARRIED_KIND_LIST);

/**
 * The subjects that carry past midnight whatever kind of message announced them.
 *
 * The district's *Security* and *Flood*. Both are conditions rather than events: a flood is
 * running for as long as the water is up, and a security risk for as long as the risk is there.
 *
 * The other four categories — `fire`, `rta`, `medical` and `other` — are **not** here, and that
 * is the district's own answer to Q5: they keep clearing at the district's midnight exactly as
 * they do now, and are found afterwards by date in the daily report.
 */
export const CARRIED_CATEGORY_LIST: readonly string[] = ['security', 'flood'];

const CARRIED_CATEGORIES: ReadonlySet<string> = new Set<string>(CARRIED_CATEGORY_LIST);

/**
 * **The whole of the district's five, as one boolean.**
 *
 * ⚠️ **`kind` is checked before `category`, and the order is not cosmetic.** A security *alert*
 * is both; either branch returns true, so the result is identical either way — but a reader must
 * not be able to conclude that this function is deciding **which of the five** something is.
 * It is not. It decides one thing: does this finish at midnight, or not.
 *
 * `category` is nullable because the fold's is: an incident whose first report carried no
 * category has none, and null is a complete answer here — it simply is not one of the two.
 */
export function carriesByDefault(kind: MessageKind, category: string | null): boolean {
  if (CARRIED_KINDS.has(kind)) return true;
  if (category !== null && CARRIED_CATEGORIES.has(category)) return true;
  return false;
}

/**
 * **Is this still on the wall tomorrow morning?**
 *
 * The default, unless the control room said otherwise about this one item — `Q7`, answered by
 * the owner as **both**: the five are the default, *and* the room may change it either way.
 *
 * **Why both directions.** Duration is a property of the **event**, not of its category. A large
 * fire can burn for three days; a small flood can be over by lunchtime. Default-only would be
 * wrong in both of those, and in opposite ways — the fire would vanish off the wall on day two,
 * and the flood would sit there for ever waiting for somebody to close it by hand.
 *
 * At most one of the two timestamps is ever set: each event clears the other in the fold, so
 * *latest wins* falls out of the fold rather than needing a comparison here.
 */
export function outlivesTheDay(state: IncidentState): boolean {
  if (state.heldOverAt !== null) return true; // the control room said so
  if (state.holdEndedAt !== null) return false; // …or said not
  return carriesByDefault(state.kind, state.category?.value ?? null);
}

/**
 * Why it is on the wall — for a screen that has to explain a row somebody is questioning.
 *
 * `held` and `released` are a person's decision and carry that person's sentence; `default` is
 * this file's rule. Three answers rather than a boolean, because *"why is this still here"* and
 * *"why did this stop being tracked"* are the two questions the panel will generate, and a
 * caller that could only say *true* would have to guess at both.
 */
export type CarryReason = 'held' | 'released' | 'default';

export function carryReason(state: IncidentState): CarryReason {
  if (state.heldOverAt !== null) return 'held';
  if (state.holdEndedAt !== null) return 'released';
  return 'default';
}

/* ------------------------------------------------------------------------------------------- *
 * Phase 2 — the review date, which flags and never closes.
 * ------------------------------------------------------------------------------------------- */

/**
 * **What the operator says when there is honestly no end in sight.**
 *
 * Stored in `CommunicationDetails.reviewBy` in place of a date. It is not a date, so
 * `endOfNamedDistrictDay` cannot parse it and returns null — which is already the answer this
 * means: **no review date, so nothing is ever flagged.** The semantics fall out of the parse
 * rather than needing a branch of their own, and any other unparseable value degrades to the
 * same safe end: a row that is never nagged, never hidden and never closed.
 */
export const UNTIL_FURTHER_NOTICE = 'further-notice';

/**
 * **How long a carried item goes untouched before somebody is asked about it.**
 *
 * ⚠️ **These numbers are MINE and the district has not seen them.** They are a guess, in the
 * `PLACEHOLDER_SLA` sense and labelled the same way: the district may want different ones and
 * should be able to read what they are overriding. Nothing here is the district's rule.
 *
 * They are days of **silence**, measured from the last thing recorded on the incident rather
 * than from when it started — which is the district's own suggestion in `Q6` (*"an item with no
 * activity for seven days is flagged for review"*), and it is the better instrument for what
 * this exists to catch. A flood being updated twice a day is being worked; a flood nobody has
 * touched in a week is the one that fills the panel. A fixed window from the start would nag
 * the first and, once dismissed, say nothing about the second.
 *
 * ⚠️ **An operator's own date is absolute and is never measured this way.** A date somebody
 * typed is a promise about a day; this is a staleness detector. They answer different
 * questions and only one of them slides.
 */
export const PLACEHOLDER_REVIEW_DAYS: Readonly<Record<MessageKind, number>> = {
  // Only ever carried because of `security` or `flood`, and both of those are live conditions.
  emergency: 2,
  alert: 3,
  advisory: 7,
  order: 7,
  // A meeting almost always carries its own date, so this is the fallback for one that does not.
  meeting: 7,
  schedule: 7,
  // The district's Information. The least urgent content and the row that will fill the panel
  // first — but a programme announced three weeks out must not be flagged on day three.
  other: 14,
};

/** Where a row's review date came from. Four answers, because a screen has to explain itself. */
export type ReviewSource = 'operator' | 'meeting' | 'further_notice' | 'default';

export interface Review {
  /**
   * The district date the review falls due on, `YYYY-MM-DD`, or **null** when there is none —
   * which is *until further notice*, and is a complete answer rather than a missing one.
   */
  readonly date: string | null;
  readonly source: ReviewSource;
  /**
   * **The district day named by `date` has ended and nobody has said anything since.**
   *
   * 🔴 **This closes nothing.** It does not resolve the incident, does not take it off the
   * panel, does not stop it notifying and does not change its status. It is a **mark**, and the
   * only thing behind it is a question for a person: *is this still running?* The software
   * cannot know whether a flood is over, and a screen that guessed would be wrong on the day it
   * mattered.
   */
  readonly due: boolean;
}

function trimmed(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * **When somebody should be asked whether this is still running.**
 *
 * Four sources, in order, and the order is the argument:
 *
 * 1. **What the operator typed** (`details.reviewBy`) — the district's *"kab tak"*. A person
 *    said a date; nothing here may second-guess it.
 * 2. **A schedule's own span** (`details.untilDate`). A roster that runs to the 20th should be
 *    reviewed on the 20th — that field already *is* this question for that one kind, which is
 *    why it is read rather than duplicated.
 * 3. **A meeting's own date.** It already carries the day it happens; asking the operator for a
 *    second date about the same meeting is a form asking a question it can answer itself.
 * 4. **The default window** for the kind, from the last thing recorded — a staleness detector,
 *    and the only one of the four that slides.
 *
 * **`endOfNamedDistrictDay` is the boundary, always.** Do not write new timezone logic here:
 * this project has paid twice for interpreting a district date at the wrong layer, and a review
 * that fell due at the server's midnight would nag Bajaur five hours early, every night.
 */
export function reviewOf(state: IncidentState, now: Instant | Date = new Date()): Review {
  const at = now instanceof Date ? now.toISOString() : now;

  const typed = trimmed(state.details?.reviewBy);
  if (typed !== null) {
    const boundary = endOfNamedDistrictDay(typed);
    // Not a district date — `UNTIL_FURTHER_NOTICE`, or anything else that will not parse. Both
    // land here, and both mean the same thing: there is no day to measure against.
    if (boundary === null) return { date: null, source: 'further_notice', due: false };
    return { date: typed, source: 'operator', due: at > boundary };
  }

  if (state.kind === 'schedule') {
    const span = trimmed(state.details?.untilDate);
    const boundary = span === null ? null : endOfNamedDistrictDay(span);
    if (span !== null && boundary !== null) {
      return { date: span, source: 'operator', due: at > boundary };
    }
  }

  if (state.kind === 'meeting') {
    const own = trimmed(state.details?.date);
    const boundary = own === null ? null : endOfNamedDistrictDay(own);
    if (own !== null && boundary !== null) {
      return { date: own, source: 'meeting', due: at > boundary };
    }
  }

  /**
   * The anchor is the last thing recorded, falling back to when it happened.
   *
   * `lastRecordedAt` is null only on a state folded from no events at all, which the fold does
   * not produce in practice — but a null anchor must answer *not due* rather than throw, on
   * ADR-0005's rule: an unknown is not an alarm.
   */
  const anchor = state.lastRecordedAt ?? state.occurredAt;
  if (anchor === null) return { date: null, source: 'default', due: false };

  const dueAt = new Date(Date.parse(anchor) + PLACEHOLDER_REVIEW_DAYS[state.kind] * 86_400_000);
  const date = districtDate(dueAt);
  const boundary = endOfNamedDistrictDay(date);
  return { date, source: 'default', due: boundary !== null && at > boundary };
}

/**
 * **The mark on the row, in words, or null when there is nothing to say.**
 *
 * Null when the review is not due, on `moreImportanceSentence`'s rule: a line that is always
 * there is a line people stop reading, and then it is not there on the morning it means
 * something.
 *
 * ⚠️ **It asks; it never asserts.** *"Its date has passed"* is a fact about the calendar and is
 * the only claim this system can make. *"This is finished"* is a claim about Bajaur, and only a
 * person in the control room can make it.
 */
export function reviewSentence(review: Review): string | null {
  if (!review.due) return null;
  return 'its date has passed — is this still running?';
}

/** What the panel prints in its own column: a date, or the district's *no end date*. */
export function reviewLabel(review: Review): string {
  if (review.date === null) return 'no end date';
  return review.date;
}

/* ------------------------------------------------------------------------------------------- *
 * Phase 3 — the panel: one panel, five named lanes, and an age on every row.
 * ------------------------------------------------------------------------------------------- */

/**
 * **The district's five, as the words they used.**
 *
 * 🔴 **This is presentation and decides nothing.** `carriesByDefault` decides whether a row is on
 * the panel at all; this decides only which word sits in its first column. If the two ever get
 * confused the panel becomes the taxonomy it exists not to be, and *"is a security alert filed
 * under Security or under Alert & Advisory?"* comes back as a question the software has to
 * answer rather than one it never asks.
 *
 * A row can genuinely be two of these at once — a security alert is both — and the panel simply
 * prints one of them. **The incident keeps both its labels**; nothing here is written anywhere.
 */
export type CarriedLane = 'meeting' | 'flood' | 'security' | 'alert' | 'info';

/** In the district's own order, so a screen does not invent one. */
export const CARRIED_LANES: readonly CarriedLane[] = [
  'meeting',
  'flood',
  'security',
  'alert',
  'info',
];

/** The word on the row. Short, because it is read at four metres across a control room. */
export const LANE_LABELS: Readonly<Record<CarriedLane, string>> = {
  meeting: 'MEETING',
  flood: 'FLOOD',
  security: 'SECURITY',
  alert: 'ALERT',
  info: 'INFO',
};

/**
 * **Which of the five words this row wears.**
 *
 * ⚠️ **The subject wins over the kind here, and it is the opposite order from
 * `carriesByDefault`.** That is deliberate and the two are not in tension: the predicate checks
 * the kind first so that a reader cannot conclude it is choosing between the five, and this one
 * checks the category first because *a movement advisory about security* is what a room scanning
 * for security is looking for. The plan's own worked example draws it exactly that way —
 * `SECURITY · day 2 · Movement advisory`.
 *
 * ⚠️ **It is also the reverse of the recommendation put to the district in
 * `backlog/five-categories-questions.md`**, which argued for the message type winning on the
 * grounds that *Alert & Advisory* would otherwise become a leftovers panel. That argument was
 * made when these were five separate **panels**, where a leftovers panel sits half-empty beside
 * two full ones. As five **lanes in one panel** the cost is a word in one column and the row is
 * on screen either way. Recorded for the owner as `O-49`; changing it is this function and
 * nothing else.
 */
export function laneOf(kind: MessageKind, category: string | null): CarriedLane {
  if (category === 'flood') return 'flood';
  if (category === 'security') return 'security';
  if (kind === 'meeting') return 'meeting';
  if (kind === 'alert' || kind === 'advisory') return 'alert';
  return 'info';
}

/**
 * One row of the panel, already resolved to words on the server.
 *
 * **No id, on ADR-0013 §1's rule** — the same rule `ActivityItem` and `ImportanceRow` follow.
 * The dashboard shows aggregates; nothing on it is a thing to open, and a handle is the first
 * step towards a screen a room can click through to a named emergency.
 */
export interface CarriedRow {
  /**
   * **Which incident this row is**, so the panel can be opened rather than only read.
   *
   * ⚠️ **Permitted on a wall, and checked rather than assumed.** ADR-0013 §1 forbids
   * anything that identifies a *person*; `wallSafetyViolations` names `personId` and does not
   * name this, and it skips UUID-shaped strings outright. An incident id identifies an
   * **event in the district**, which is the whole subject of the screen.
   *
   * 🔴 **It does not widen what the wall shows — it is a door, not a disclosure.** The
   * row still carries no reporter, no number and no description. Following it lands on the
   * **board**, where the authority model scopes the incident to the person who signed in, which
   * is what ADR-0013 says rows are for: *"on the board … for a person who has signed in and is
   * looking at their own work."*
   */
  readonly incidentId: string;
  readonly lane: CarriedLane;
  /** What it is, in the district's own words. */
  readonly headline: string;
  readonly detail: string | null;
  /**
   * When it started, so the screen can age it — *day 5* — and keep ageing it between polls.
   *
   * An instant, never a formatted span: `startAges` rewrites every `[data-since]` on a one-second
   * sweep, and a number this panel had baked into text would freeze while the clock beside it
   * moved (INV-02).
   */
  readonly since: Instant | null;
  /**
   * **When anything last happened on it**, and this is a requirement rather than a nicety.
   *
   * The district's own words: *"rozana iska pata hona zaroori hai"*. A day-5 flood updated two
   * hours ago and a day-5 flood with nothing for 31 hours are **different situations**, and a
   * panel that draws them identically is lying. `domain/wall.ts`'s whole header is this argument.
   */
  readonly lastRecordedAt: Instant | null;
  /** The mark, when its date has passed. Null the rest of the time — see `reviewSentence`. */
  readonly reviewMark: string | null;
  /** What the review column prints: a date, or *no end date*. */
  readonly reviewLabel: string;
  /** For a meeting, the tally that is already built. Null for everything else, never a zero. */
  readonly attendance: string | null;
  /** Why it is here — so a row somebody questions can be explained without opening anything. */
  readonly reason: CarryReason;
}

export interface CarriedWindow {
  readonly visible: readonly CarriedRow[];
  /** How many are carried and outside the visible cap. Reported, never zero-by-omission. */
  readonly hidden: number;
  readonly total: number;
}

/**
 * How many rows fit and stay legible at four metres.
 *
 * More than `VISIBLE_IMPORTANCE`'s five, because this panel is `medium` rather than `small` and
 * because it is the one the district asked to be able to read every day. Fewer than
 * `activity.ts`'s twenty: these do not expire, so the list only ever grows until a person ends
 * something, and a panel that showed twenty would spend its worst weeks showing twenty rows
 * nobody has read to the bottom of.
 */
export const VISIBLE_CARRIED = 8;

/**
 * **What needs asking about first, then what has been running longest.**
 *
 * Two rules, in that order, and both come from the district rather than from tidiness:
 *
 * 1. **A row whose review has fallen due goes to the top.** It is the only thing on this panel
 *    that is *asking* for something — and the failure Phase 2 exists to prevent is precisely a
 *    finished item nobody closed, sitting below the fold under `and 35 more`.
 * 2. **Then oldest first.** *"Rozana iska pata hona zaroori hai"* — the day-9 flood is the one
 *    the room has stopped noticing, and it is the one that has to be in front of them.
 *
 * ⚠️ **Never ordered by lane.** Grouping the rows into five blocks would rebuild the five panels
 * this whole design refused, and would put a quiet meeting above a flood on its ninth day.
 */
export function capCarried(
  rows: readonly CarriedRow[],
  visibleCount: number = VISIBLE_CARRIED,
): CarriedWindow {
  const ordered = [...rows].sort((a, b) => {
    const dueA = a.reviewMark === null ? 0 : 1;
    const dueB = b.reviewMark === null ? 0 : 1;
    if (dueA !== dueB) return dueB - dueA;

    // Oldest first. A null start sorts last, never first — an unknown time is not "long ago".
    const sinceA = a.since ?? '9999';
    const sinceB = b.since ?? '9999';
    if (sinceA !== sinceB) return sinceA < sinceB ? -1 : 1;
    return 0;
  });

  return {
    visible: ordered.slice(0, visibleCount),
    hidden: Math.max(0, ordered.length - visibleCount),
    total: ordered.length,
  };
}

/**
 * What the panel says underneath its visible rows, or null when nothing is held back.
 *
 * Null rather than *"and 0 more"*, on `moreImportanceSentence`'s rule — and it names **the
 * Record**, because that is where the rest of them genuinely are. A sentence that held something
 * back without saying where it went would be the memory hole `activity.ts` refuses.
 */
export function moreCarriedSentence(window: CarriedWindow): string | null {
  if (window.hidden === 0) return null;
  return `and ${String(window.hidden)} more — all of it is on the Record`;
}
