/**
 * What each kind of communication asks for, and what its message says — M9-08, M9-09.
 *
 * **Pure. No database, no framework, no `Date.now()`.** The screen reads `fieldsFor` to decide
 * which boxes to draw; the WhatsApp channel reads `messageSubject` and `messageWhere` to decide
 * what two strings go into the approved template. Both answers live here so a form and a message
 * cannot drift apart — which is the failure the reporting screen already shipped once, where an
 * operator typed into a box that never reached WhatsApp and the message went out saying *"no
 * details were entered"*.
 *
 * ## The constraint this file is shaped by
 *
 * `district_message_v2` is approved with **two body parameters and one URL button**, and per the
 * owner's instruction coding never waits on a template review. So a meeting's subject, date,
 * time and venue do not get four parameters — they get folded into the two that exist. That is
 * not a workaround to be replaced later; it is the design, because a template is approved once
 * and changed slowly (M6-26) and a message shape that needs Meta's permission to improve is a
 * message shape that will not improve.
 *
 * `whatsappTemplate.ts` holds the parameter *count* against the code with a test. Nothing here
 * may change that count.
 */

import type { CommunicationDetails, MessageKind, ReportedLocation } from './events.js';

/** A field a screen should offer for a given kind, in the order it should offer them. */
export type DetailField = keyof CommunicationDetails;

/**
 * Which boxes to draw, per kind — the client's *"selecting a subtype changes the UI"*.
 *
 * The emergency kinds get nothing here, and that is deliberate rather than an omission: their
 * screen is the report screen, which already asks the questions an emergency needs and has been
 * in use since M0. Adding a `subject` box to it would be a second place to write the same
 * sentence.
 */
const FIELDS: Readonly<Record<MessageKind, readonly DetailField[]>> = {
  emergency: [],
  /**
   * **A review date and nothing else** — the district's five, 2026-08-22.
   *
   * An alert and an advisory carry past the district's midnight by default
   * (`domain/carrying.ts`), so each one needs an answer to *"kab tak?"*. The rest of their
   * screen is still the report screen, exactly as this file's own note says: adding a subject
   * box here would be a second place to write the same sentence.
   */
  alert: ['reviewBy'],
  advisory: ['reviewBy'],
  order: [],
  // The client named these four explicitly: subject, date, time, venue, and relevant details.
  // `reviewBy` joins them for the district's five: a meeting that is postponed twice needs a
  // day on which somebody is asked whether it is still going to happen.
  meeting: ['subject', 'date', 'time', 'venue', 'reviewBy', 'note'],
  // A schedule spans days rather than happening at one, so it takes a second date and no venue
  // by default — "the flood duty roster, 14th to 20th" is the shape the district described.
  // It gets no `reviewBy`: `untilDate` already *is* its review date, and `carrying.ts` reads it
  // as one. Two boxes asking one question is how they come to disagree.
  schedule: ['subject', 'date', 'untilDate', 'time', 'note'],
  // Everything else — the district's Information. `reviewBy` is the "kab tak" they approved,
  // and without it this is the one kind with no natural end at all: the row that fills the
  // panel first, with the least urgent content in it.
  other: ['subject', 'reviewBy', 'note'],
};

export function fieldsFor(kind: MessageKind): readonly DetailField[] {
  return FIELDS[kind];
}

/**
 * The fields that must be filled for a kind, if any.
 *
 * **A subject, and nothing else.** Requiring a venue would refuse a meeting whose venue is not
 * decided yet, which is a real meeting the district would then send by WhatsApp from a personal
 * handset — the exact behaviour this whole system exists to replace. `INV-01`'s reasoning
 * generalises here: refusing a communication is worse than storing an incomplete one.
 */
export function requiredFieldsFor(kind: MessageKind): readonly DetailField[] {
  /**
   * ⚠️ **Keyed on whether this kind asks for a subject, never on whether it asks for
   * anything at all.** It used to read `FIELDS[kind].length === 0 ? [] : ['subject']`, which was
   * the same answer for every kind that existed — and stopped being so the moment `alert` and
   * `advisory` gained a review date and nothing else. Written the old way, adding one optional
   * box to a kind would have started **refusing every alert with no subject**, silently, on the
   * screen the control room sends from.
   */
  return FIELDS[kind].includes('subject') ? ['subject'] : [];
}

/** Human wording for each kind, in one place so a screen and a message cannot disagree. */
const LABELS: Readonly<Record<MessageKind, string>> = {
  emergency: 'Emergency',
  alert: 'Alert',
  advisory: 'Advisory',
  order: 'Order',
  meeting: 'Meeting',
  schedule: 'Schedule',
  other: 'Notice',
};

export function labelFor(kind: MessageKind): string {
  return LABELS[kind];
}

/**
 * Whether `category` is telling anybody anything, for this `kind` — 2026-09-05.
 *
 * **The report screen's own merged grid is why this question exists at all.** `web/src/main.ts`'s
 * `TILES` (2026-08-24) puts *category* and *kind* on one tile per the owner's decision, and only
 * the seven emergency tiles set a real category — Alert, Advisory, Order, Meeting, Schedule and
 * Information all write the literal string `'other'`, because none of them ever asked the
 * operator to classify anything. That string then went on to mean two different things depending
 * on which tile wrote it: on an emergency, `'other'` is what the operator saw and chose — *"not
 * fire, not flood, not rta, something else"* — worth printing. On every other tile it is not a
 * choice at all; it is the placeholder that satisfies the same field the emergency tiles use, and
 * printing it reads as *"this could not be classified"* about a message whose whole classification
 * **is** its kind — an Alert already says it is an alert.
 *
 * A control room read "ALERT · other · high" over WhatsApp and on the board's Record row, on a
 * message it had itself tagged Alert an hour earlier, and asked why. This is the line the answer
 * turned on: `category` was real, `'other'` and all — the fold, the message and the row were all
 * printing exactly what the tile wrote. What was missing was this distinction.
 *
 * `'other'` stays meaningful for `emergency`, so an operator who genuinely picked the *Other*
 * emergency tile is still told that on the message and the row. Every other kind gets no
 * category segment at all, which is not a loss: `kind` itself already carries the whole of what
 * category would have said, and `labelFor` is what prints it instead — see the two call sites in
 * `jobs/whatsappChannel.ts` and `web/src/incidentRow.ts`.
 */
export function hasCategory(kind: MessageKind, category: string): boolean {
  return kind === 'emergency' || category !== 'other';
}

function clean(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One line for wherever a screen or a message wants to say **where** — restored 2026-09-05,
 * after `1d36b058` removed the box that fed it because nothing ever called this function's
 * predecessor.
 *
 * **The device's own GPS fix rode alongside the typed text for one day and was pulled the same
 * day the owner saw it** — the map link it built pointed at the wrong place often enough that a
 * wrong pin is worse than no pin: an officer who taps a confident-looking link and arrives
 * somewhere else has lost more time than one who was simply told to ask. The control room types
 * the location by hand instead, exactly as it always typed everything else this line carries. If
 * a trustworthy device fix becomes available later, it re-joins here — this function, not the
 * form, is where the two would be combined again.
 */
export function locationLine(location: ReportedLocation | null | undefined): string | null {
  if (location === null || location === undefined) return null;
  return clean(location.text);
}

/**
 * **The second parameter, on a template that has already written the word `Location: `** —
 * 2026-09-08, the owner's own reading of a live handset.
 *
 * Every `dnc_response_*` shape — the `_v1` six and the `_v2` six — carries `Location: {{2}}` in
 * its approved body, and the send had been putting *the incident description* into that slot. A
 * flood alert reached the district reading `Location: Flood expected at jaar`, which is not a
 * location and never was: the label was Meta's static text and the words under it were whatever
 * the operator had typed about the emergency. The owner's phrase for it was that location and
 * severity *"buri tarha incident details k sath mix ho rahe hain"*, and they were right — the
 * message asserted something false about its own contents.
 *
 * **The template cannot be changed** (owner, 2026-09-08, restating the standing 2026-08-14 rule):
 * the label, the single newline before it and the two-parameter shape are all Meta's, and moving
 * any of them means a new submission and a review the district is not spending. So the fix is
 * the only one available on this side of the wire — **put the place first, so the label is
 * telling the truth about the words that immediately follow it**, and let the description ride
 * after an em dash:
 *
 * ```
 * high
 * Location: Jaar, Bajaur — Flood expected at jaar
 * ```
 *
 * `not stated` when no location was typed, which is the honest reading of an empty field and
 * keeps the label true even then — `Location: not stated — Flood expected at jaar` tells an
 * officer exactly what the control room does and does not know. That matters more than it looks:
 * the old text made the same message *claim* a location it had never been given.
 *
 * **This costs the description its place at the front of the line, and that is the trade.** The
 * owner was shown all three orderings and chose this one: severity keeps its own line, the
 * description leaves that line, and the label stops lying. What it does not buy is the location
 * sitting alone at the end of the message — that needs the template's own text, and the template
 * is not to be touched.
 */
function locationLabelled(location: string | null, rest: string | null): string {
  const place = location ?? 'not stated';
  return rest === null ? place : `${place} — ${rest}`;
}

/**
 * The first template parameter — **what this is**.
 *
 * For an emergency this stays exactly what it has always been, because changing it would change
 * every message the district already sends. For a General kind it leads with the kind and the
 * subject, which is what an officer reads first on a locked screen.
 */
export function messageSubject(
  kind: MessageKind,
  fallback: string,
  details?: CommunicationDetails,
): string {
  const subject = clean(details?.subject);
  if (subject === null) return fallback;
  return `${labelFor(kind)}: ${subject}`;
}

/**
 * The second template parameter — **when and where**.
 *
 * Meta refuses an empty parameter, so this never returns an empty string. That is not a nicety:
 * an empty parameter is a `whatsapp_400` at 02:00, and the district reads it as the message
 * having failed rather than as a blank box on a form.
 *
 * The date and time are passed through **as the operator typed them**, in the district's own
 * calendar and clock. Formatting them would mean interpreting them, and interpreting them means
 * choosing a timezone at the layer that must not have one.
 *
 * `location` is a fifth part, alongside `venue` and `note` — a General kind's *"where"* is
 * usually the venue it already asks for, but a schedule or an information notice can carry a
 * device fix or a typed landmark too, and this is where it joins the rest without a second
 * template parameter. Callers pass `locationLine`'s output straight through.
 */
export function messageWhere(
  fallback: string,
  details?: CommunicationDetails,
  fileLink?: string,
  location?: string | null,
  /**
   * **The template prints the word `Location: ` immediately before this parameter** — every
   * `dnc_response_*` shape does, and no other template does. See {@link locationLabelled}.
   */
  templateLabelsLocation?: boolean,
): string {
  const date = clean(details?.date);
  const untilDate = clean(details?.untilDate);
  const time = clean(details?.time);
  const venue = clean(details?.venue);
  const note = clean(details?.note);

  const when =
    date === null
      ? null
      : untilDate !== null && untilDate !== date
        ? `${date} to ${untilDate}`
        : date;

  const parts = [
    when === null ? null : time === null ? when : `${when} at ${time}`,
    venue,
    note,
    // Led rather than trailed when the template has already announced it — see below.
    ...(templateLabelsLocation === true ? [] : [location ?? null]),
  ].filter((p): p is string => p !== null);

  const rest = parts.length === 0 ? clean(fallback) : parts.join(' · ').replace(/\s+/g, ' ');

  const written =
    templateLabelsLocation === true
      ? locationLabelled(location ?? null, rest)
      : (rest ?? 'no further detail was given');

  const link = clean(fileLink);
  if (link === null) return written.slice(0, MAX_WHERE);

  /**
   * **The link is reserved first, and the words are cut around it — M9-18.**
   *
   * One parameter has to carry the date, the venue, whatever the operator wrote *and* the link
   * to the attachment, inside Meta's budget. Something gives, and the owner's decision (and
   * mine) is that it must not be the link: the venue is written **inside the notice**, so an
   * officer who receives a truncated line and a working link loses nothing they cannot recover
   * by tapping it. An officer who receives the full venue and a link cut in half has a message
   * that reads complete and is not — which is the worst of the three outcomes, because nothing
   * tells them anything is missing.
   *
   * A truncated line ends in `…` so it is visibly cut rather than silently short.
   */
  const room = MAX_WHERE - link.length - SEPARATOR.length;
  if (room <= 0) return link;

  const trimmed = written.length <= room ? written : `${written.slice(0, room - 1).trimEnd()}…`;
  return `${trimmed}${SEPARATOR}${link}`;
}

/**
 * Meta's body parameter is bounded, and a very long one is unreadable on a handset anyway.
 *
 * Both are silent failures from the district's point of view — a rejected parameter reads as
 * "the alert did not go" — so the boundary is enforced here rather than discovered at the
 * provider at 02:00.
 */
const MAX_WHERE = 300;

/**
 * The link is **named**, not merely appended — 2026-08-14.
 *
 * It used to arrive as a bare URL after a middot, at the end of a line that already held a date,
 * a venue and whatever the operator wrote. The district's report was *"the jpg does not come with
 * the message"*, and from a lock screen that is what it is: an unexplained address among the
 * words, which nobody taps.
 *
 * Meta will not carry a real media header on the template Bajaur is approved on, and **the
 * template is not to be touched** (owner, 2026-08-14). So the words do the work the header would
 * have done: the officer is told there is a file and that this is where it is. Seventeen
 * characters against `MAX_WHERE`, spent deliberately — the link is reserved first and the message
 * is cut around it, so what this costs is the tail of a sentence rather than the attachment.
 */
const SEPARATOR = ' · Attached file: ';

/**
 * The detail an operator entered, as lines for a screen or a report.
 *
 * Ordered by `FIELDS` rather than by the object's own key order, so a timeline, a report and a
 * form all read the same way round. Empty fields are dropped rather than rendered blank.
 */
export function detailLines(
  kind: MessageKind,
  details?: CommunicationDetails,
): readonly { readonly label: string; readonly value: string }[] {
  if (details === undefined) return [];

  const labels: Readonly<Record<DetailField, string>> = {
    subject: 'Subject',
    date: 'Date',
    time: 'Time',
    venue: 'Venue',
    untilDate: 'Until',
    // The district's own word for it. "Review by" would be the software's.
    reviewBy: 'Until',
    note: 'Details',
  };

  const out: { label: string; value: string }[] = [];
  for (const field of FIELDS[kind]) {
    const value = clean(details[field]);
    if (value !== null) out.push({ label: labels[field], value });
  }
  return out;
}
