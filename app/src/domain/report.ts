/**
 * The post-incident report — M1-06.
 *
 * **Folded from the event log. Nothing here is typed by anybody.** If an operator has to
 * retype what the system already knows, the system has failed — and worse, the retyped
 * version becomes a second account of the same night, free to disagree with the first.
 *
 * Q-01 established that departments already run other systems and Q-02 turned that into an
 * export target rather than an integration one: this produces the account a department has to
 * submit upward, so the platform **replaces** work instead of adding to it. That is the
 * single strongest argument against the double-entry problem that kills adoption.
 *
 * Three rules, and all three are the same rule in different places:
 *
 * 1. **A gap is stated, never omitted.** No response, no evidence, nobody notified —
 *    each says so in words. A report that silently leaves out what did not happen reads as a
 *    clean response, which is exactly the reading a review must not be handed.
 * 2. **Every duration is measured from `occurredAt`.** The district's real response time
 *    includes the hour a report spent on a handset with no signal. Measuring from arrival
 *    would make an outage look like speed (ADR-0002).
 * 3. **Nothing is inferred.** Where the log does not say, the report says the log does not
 *    say.
 */

import type { Instant, IncidentEvent, RecipientKind, Uuid } from './events.js';
import type { IncidentState, NotificationAttempt } from './incident.js';
import { arrivalGapMinutes, minutesBetween } from './sla.js';
import { ownershipOf } from './ownership.js';
import { attendanceFor } from './attendance.js';
import { attendanceClosesAt } from './meetings.js';
import { absorbedKeys, groupRecipients, groupsFromEvents } from './recipientGroups.js';

export interface Actor {
  readonly seatId: Uuid | null;
  readonly seatTitle: string | null;
  readonly personName: string | null;
}

/** One line of the narrative. Ordered by when it happened, not by when it was recorded. */
export interface ReportEntry {
  readonly at: Instant;
  /** How much later the server learned of it. Zero for anything done online. */
  readonly recordedLaterMinutes: number;
  readonly what: string;
  readonly by: Actor;
  readonly detail: string | null;
  /**
   * This line happened **after** the incident was resolved — 2026-09-07.
   *
   * A responder tapping "on it" two minutes after the control room closed the emergency is
   * ordinary, and the fold keeps the status resolved. But on a filed page the two lines read
   * as a contradiction unless the later one says which side of the line it fell. Not tagged
   * when the incident was reopened — work after a reopen is not "after resolution".
   */
  readonly afterResolution: boolean;
}

/**
 * One recipient the control room told, and what became of it — 2026-09-07.
 *
 * The district asked for this by name: for each person or post that was told, whether the
 * message reached them, and what they said back. The three facts live in three places in the
 * fold — `dispatchedTo` (chosen), `notifications` (sent), `actions`/`acknowledged` (replied) —
 * and this row is the join.
 */
export interface ReportRecipient {
  /** Person first, then the post (ADR-0035). One string when the two would restate each other. */
  readonly name: string;
  /**
   * `delivered` / `failed` / `pending` from the send ledger; `unknown` when they were chosen
   * but no attempt is on the record. Absence is never read as "not sent" (ADR-0026).
   */
  readonly delivery: 'delivered' | 'failed' | 'pending' | 'unknown';
  /** Why the send failed. Present only when `delivery` is `failed`. */
  readonly failure: string | null;
  /** What this recipient replied — their own words, or the action they logged. */
  readonly response: string | null;
  readonly respondedAt: Instant | null;
  /**
   * **The saved group this recipient came from** — Case 3, 2026-09-10. The name only, read off
   * `dispatched.payload.fromGroups`; `null` for anybody the control room ticked by hand. The
   * "Who was told" section groups its rows under it — display only, no group entity in the
   * fold and every recipient still counted independently.
   */
  readonly group: string | null;
}

export interface ReportTiming {
  readonly label: string;
  readonly at: Instant | null;
  /** Minutes from when the emergency happened. Null when the moment never came. */
  readonly minutesFromOccurrence: number | null;
  /** Present when the moment never came, saying so rather than leaving a blank. */
  readonly missing: string | null;
}

export interface UnitInvolvement {
  readonly resourceId: Uuid;
  readonly name: string;
  readonly sentAt: Instant;
  readonly releasedAt: Instant | null;
  readonly minutesCommitted: number | null;
}

export interface ReportGap {
  readonly what: string;
  readonly why: string;
}

export interface PostIncidentReport {
  readonly incidentId: Uuid;
  /**
   * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
   *
   * This report is the thing that leaves the building. It is pasted into an email, printed and
   * submitted upward, read out on a telephone — and until now the only identity on it was a
   * uuid, which is unusable in every one of those. The number is what somebody quotes back.
   *
   * **Passed in, never derived.** This module folds the event log and nothing else (which is
   * what lets its judgements be tested with no database), and the number is not in the log —
   * it is assigned by the primary after the events commit. `api/report.ts` supplies it.
   *
   * Null when the sweep has not reached this incident yet, and the renderer says so in words
   * rather than printing a blank: a report with no identity at all is worse than one that
   * admits it has not been given a number.
   */
  readonly reference: string | null;
  readonly generatedAt: Instant;

  readonly what: {
    readonly category: string;
    readonly categorySetBy: Actor | null;
    readonly severity: string;
    readonly severityAssessed: boolean;
    readonly severitySetBy: Actor | null;
    /** Both values, when a higher authority replaced the department's own (ADR-0003). */
    readonly severityOverriddenFrom: string | null;
    readonly overrideReason: string | null;
  };

  readonly who: {
    readonly reportedBy: Actor;
    readonly departments: readonly string[];
    readonly departmentsItLeft: readonly string[];
    readonly acknowledgedBy: Actor | null;
  };

  readonly timings: readonly ReportTiming[];

  readonly connectivity: {
    /** Minutes the report spent unseen by the server. The district's real coverage picture. */
    readonly arrivalGapMinutes: number;
    readonly lateArrival: boolean;
  };

  readonly unitsSent: readonly UnitInvolvement[];
  readonly narrative: readonly ReportEntry[];

  /** Every person and post the control room told, with delivery and their reply. */
  readonly recipients: readonly ReportRecipient[];

  /**
   * **Who was coming, when this notice asked who is coming** — the Case 2 (meeting) work,
   * 2026-09-10.
   *
   * Null for everything that is not asking — every emergency, a plain notice, `schedule` — where
   * the report is unchanged. For a `meeting` or an `asksAttendance` notice this is the tally the
   * filed page carries, in place of a report that had a recipient list and no count of it.
   * `coming` is `attending + sendingSomeone` (a representative is a yes); `closesAt` is when the
   * count closed, or null when it had no closing time.
   */
  readonly attendance: {
    readonly told: number;
    readonly coming: number;
    readonly answered: number;
    readonly attending: number;
    readonly sendingSomeone: number;
    readonly notAttending: number;
    readonly other: number;
    readonly unanswered: number;
    readonly closesAt: Instant | null;
  } | null;

  readonly notifications: {
    readonly attempted: number;
    readonly delivered: number;
    readonly failed: number;
    readonly stillPending: number;
    readonly failures: readonly string[];
  };

  readonly escalations: number;
  readonly evidence: readonly { readonly filename: string; readonly capturedAt: Instant | null }[];

  readonly outcome: string | null;
  readonly closureNotes: string | null;

  /** Everything the log does not contain. Stated, because a review must see the holes. */
  readonly gaps: readonly ReportGap[];
}

export interface ReportSources {
  readonly state: IncidentState;
  readonly events: readonly IncidentEvent[];
  readonly generatedAt: Instant;
  /** seatId → title, personId → name. Resolved by the caller; this module stays pure. */
  readonly seats: Readonly<Record<string, string>>;
  readonly people: Readonly<Record<string, string>>;
  /**
   * personId → the post that officer holds now — 2026-09-07.
   *
   * So a dispatched officer reads `Ali Khan — AC HQ Bajaur` in the "Told:" line and the
   * "Who was told" section, person then post, the way ADR-0035 names every actor on this
   * document. Until now a `person` recipient here carried a name and no post, because only a
   * `post` target had a `postTitle`. Optional: a caller that does not pass it (the older tests)
   * gets the bare name it always did. Provenance is untouched — an event's actor is still named
   * through `actorName`.
   */
  readonly recipientDesignations?: Readonly<Record<string, string>>;
  /**
   * seatId → the officer holding that post now — 2026-09-08, the other half.
   *
   * A `post` recipient (a learned proposal usually is one) read as its title alone; with this
   * it reads `Imtiaz Ahmad — IT Soft`, holder then title, symmetric with a `person` recipient.
   * Absent for a vacant post — the title stands alone. Optional, same as above.
   */
  readonly seatHolders?: Readonly<Record<string, string>>;
  readonly departments: Readonly<Record<string, string>>;
  readonly resources: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly filename: string; readonly capturedAt: Instant | null }[];
  /**
   * The district's own number for this incident, or null if it has none yet.
   *
   * Optional so that every existing caller — the tests especially — keeps compiling and keeps
   * folding exactly what it folded before. An absent number and an unassigned one are the same
   * thing to this module and read the same on the page.
   */
  readonly reference?: string | null | undefined;
}

function actorOf(event: IncidentEvent, sources: ReportSources): Actor {
  return {
    seatId: event.actorSeatId,
    seatTitle: event.actorSeatId === null ? null : (sources.seats[event.actorSeatId] ?? null),
    personName: event.actorPersonId === null ? null : (sources.people[event.actorPersonId] ?? null),
  };
}

/** The system, when nobody did it. Rendered as "the system", never as a blank. */
const NOBODY: Actor = { seatId: null, seatTitle: null, personName: null };

/**
 * An actor's name for the page — **the person first, then the post** (ADR-0035).
 *
 * ADR-0004 is untouched: the duty attaches to the post, and a district override is still
 * "the District Control Room did this". This is only what a human reads on a filed page,
 * where the officer's name is what a DC office quotes back on the telephone. When the two
 * strings would restate each other — a control-room seat whose holder's name is the seat's
 * name — it is printed once.
 */
export function actorName(actor: Actor | null): string {
  if (actor === null) return 'nobody recorded';
  const { seatTitle, personName } = actor;
  if (seatTitle === null && personName === null) return 'the system';
  if (personName === null) return seatTitle ?? 'unknown seat';
  if (seatTitle === null) return personName;
  return personName === seatTitle ? personName : `${personName} — ${seatTitle}`;
}

function timing(
  label: string,
  at: Instant | null,
  occurredAt: Instant | null,
  missing: string,
): ReportTiming {
  if (at === null || occurredAt === null) {
    return { label, at: null, minutesFromOccurrence: null, missing };
  }
  return {
    label,
    at,
    // From when it happened, always. Measuring from arrival would turn an hour on a handset
    // with no signal into an apparently instant response (ADR-0002).
    minutesFromOccurrence: Math.round(minutesBetween(occurredAt, at)),
    missing: null,
  };
}

/**
 * Name a dispatch target from whichever directory it belongs to.
 *
 * Falls back to the id rather than to a blank. A target this report cannot name is a directory
 * gap — somebody removed after being told — and the id at least leads back to the row. A blank
 * would read as *nobody was told*, which is the opposite of what happened.
 */
function nameOfTarget(
  target: { readonly kind: RecipientKind; readonly id: string },
  sources: ReportSources,
): string {
  switch (target.kind) {
    case 'post':
      // Holder then title (`Imtiaz Ahmad — IT Soft`), or the title alone for a vacant post —
      // `recipientName` is the shared rule, the same as the `person` arm below.
      return recipientName(
        sources.seatHolders?.[target.id] ?? null,
        sources.seats[target.id] ?? null,
        target.id,
      );
    case 'person': {
      const name = sources.people[target.id];
      if (name === undefined) return target.id;
      // Person then post, on this document's ` — ` (ADR-0035), collapsing when they restate
      // each other — `recipientName` is the shared rule.
      return recipientName(name, sources.recipientDesignations?.[target.id] ?? null, target.id);
    }
    default:
      // ADR-0031, phase 2: `'department'` left `RecipientKind`, so no live dispatch is one.
      // A `dispatched` event written on some other installation before ADR-0023 may still
      // carry a department-kinded target — name it from the departments source if it is
      // there, otherwise its id (the log is not rewritten; the read stays honest).
      return sources.departments[target.id] ?? target.id;
  }
}

function describe(
  event: IncidentEvent,
  sources: ReportSources,
): { what: string; detail: string | null } {
  switch (event.type) {
    case 'reported':
      return { what: 'Reported', detail: event.payload.category };
    case 'triaged':
      return {
        what: 'Assessed',
        detail: `${event.payload.severity} · ${event.payload.category}`,
      };
    case 'routed': {
      const names = event.payload.departmentIds.map((id) => sources.departments[id] ?? id);
      return names.length === 0
        ? { what: 'Routing found no department', detail: event.payload.reason ?? null }
        : { what: 'Routed', detail: names.join(', ') };
    }
    case 'acknowledged':
      return { what: 'Acknowledged', detail: null };
    case 'assigned':
      return {
        what: 'Sent',
        detail: event.payload.resourceIds.map((id) => sources.resources[id] ?? id).join(', '),
      };
    case 'released':
      return {
        what: 'Stood down',
        detail: `${event.payload.resourceIds
          .map((id) => sources.resources[id] ?? id)
          .join(', ')} — ${event.payload.reason}`,
      };
    case 'action_logged':
      return { what: 'Action', detail: event.payload.note };
    /**
     * The control room chased somebody by hand — Phase 8b.
     *
     * Worded as *followed up* and never as an action, for the same reason it is not an
     * `action_logged` event: an action says work is happening on the emergency, and a follow-up
     * is sent precisely because it is not. On the printed page that distinction is the whole
     * account of a night nobody answered.
     *
     * A refused send says so on the line. The report is the artefact most likely to be read by
     * somebody who was not there and believed without question, so a chase that never left the
     * building must not read like one that did.
     */
    case 'followed_up':
      return {
        what: event.payload.delivered ? 'Followed up' : 'Follow-up could not be sent',
        detail: event.payload.note,
      };
    case 'escalated':
      // The reason, when a person gave one. Since Phase 8a an escalation messages nobody, so the
      // mark IS the act - and a post-incident report that showed only `(manual)` would be showing
      // that somebody escalated this while withholding the only part worth reading.
      return {
        what: 'Escalated',
        detail: [
          `${sources.seats[event.payload.toSeatId] ?? event.payload.toSeatId} (${
            event.payload.trigger
          })`,
          event.payload.reason,
        ]
          .filter((part): part is string => part !== undefined && part !== '')
          .join(' — '),
      };
    case 'reassigned':
      return {
        what: 'Reassigned',
        detail: `to ${event.payload.toDepartmentIds
          .map((id) => sources.departments[id] ?? id)
          .join(', ')} — ${event.payload.reason}`,
      };
    case 'overridden':
      return {
        what: 'Overridden',
        detail: `${event.payload.field} → ${event.payload.value} — ${event.payload.reason}`,
      };
    case 'resolved':
      return { what: 'Resolved', detail: event.payload.outcome };
    case 'closed':
      return { what: 'Closed', detail: event.payload.notes };
    case 'reopened':
      return { what: 'Reopened', detail: event.payload.reason };
    case 'withdrawn':
      /**
       * On the paper, always — M10-15.
       *
       * This is the line that stops withdrawal being a delete. It left the board; it did not
       * leave the day. A report that quietly omitted it would let an operator remove an
       * emergency from the district's own account of a shift, and nothing anywhere would say
       * so — which is the one outcome the district's request must not be allowed to produce.
       */
      return { what: 'Taken off the Record', detail: event.payload.reason };
    case 'restored':
      return { what: 'Put back on the board', detail: null };
    /**
     * **Kept past the day, and released from it** — the district's five, 2026-08-22.
     *
     * On the paper for `withdrawn`'s reason. A row that stayed on the wall for six weeks is a
     * thing somebody asks about afterwards, and *"who decided that, and why"* has an answer
     * only if the report carries it.
     *
     * ⚠️ **"Let it clear with the day", never "Ended" or "Closed".** Releasing a flood from the
     * panel says the control room stopped watching it there; it says nothing about the flood.
     * A report that wrote the second would be a claim this system cannot support.
     */
    /**
     * **The meeting moved, and the paper says so as a MOVE** — the district's five, 2026-08-22.
     *
     * 🔴 *"Rescheduled"*, never *"Corrected"* and never *"Resolved"*. Somebody reading this
     * report six weeks later has to be able to tell *we sent the wrong date* from *the date
     * moved*, and from *the meeting is over* — three different facts about one line, and the
     * only one of them this event describes is the middle one.
     *
     * The new date is printed with the reason, because a reschedule with no date is a line that
     * says a meeting moved and not where to.
     */
    case 'rescheduled':
      return {
        what: 'Rescheduled',
        detail: `to ${event.payload.date}${
          event.payload.time === undefined ? '' : ` at ${event.payload.time}`
        }${event.payload.venue === undefined ? '' : `, ${event.payload.venue}`} — ${
          event.payload.reason
        }`,
      };
    case 'held_over':
      return { what: 'Kept past the day', detail: event.payload.reason };
    case 'hold_ended':
      return { what: 'Let it clear with the day', detail: event.payload.reason };
    case 'corrected':
      return {
        // "Corrected", never "Withdrawn" or "Deleted" — M9-53. Nothing was removed, and the
        // people who were told still received what they were told.
        what: 'Corrected',
        detail:
          event.payload.correction === undefined
            ? event.payload.reason
            : `${event.payload.reason} — instead: ${event.payload.correction}`,
      };
    case 'late_arrival_flagged':
      return {
        what: 'Flagged as late-arriving',
        detail: `${String(Math.round(event.payload.gapMinutes))} minutes between happening and arriving`,
      };

    /**
     * **The chase stopped, and the report says so** — ADR-0020.
     *
     * The wording is the whole value of this line. *"No further escalation"* would read as a
     * setting; **"nobody responded to it"** is what actually happened, and it is what somebody
     * reading this report months later needs to know. The escalation count is carried because
     * *"the ladder never left the department"* and *"it reached the DC and stopped"* are two very
     * different failures with two different people to ask about them.
     */
    case 'escalation_ended':
      return {
        what: 'Escalation stopped — the district day ended',
        detail:
          event.payload.escalations === 0
            ? 'nobody responded to it, and it was never escalated'
            : `nobody responded to it after ${String(event.payload.escalations)} escalation${
                event.payload.escalations === 1 ? '' : 's'
              }`,
      };

    /**
     * Narrated, not summarised — unlike the notification traffic below (M6-04).
     *
     * This is a named operator's decision, taken on a telephone call, and it is the single
     * thing the paper register was keeping that nothing else in this report could answer. The
     * upward submission Q-02 exists for is read by people asking *who was informed*; a report
     * that renders that as plumbing is a report that lost the district's own question.
     */
    case 'dispatched': {
      const named = event.payload.targets.map((t) => nameOfTarget(t, sources));
      const also = (event.payload.absorbed ?? []).length;
      return {
        what: 'Told',
        detail:
          (named.length === 0 ? 'nobody' : named.join(', ')) +
          (also === 0
            ? ''
            : ` · ${String(also)} already covered by ${also === 1 ? 'another selection' : 'other selections'}`),
      };
    }

    /**
     * Also narrated, and **worded so it cannot be read as a conversation.**
     *
     * "Opened WhatsApp" is the whole of what is known. Rendering this as *Contacted* would put
     * a claim in the district's own upward report that nothing observed — the exact substitution
     * the three-state notification ledger exists to refuse (ADR-0014).
     */
    case 'contact_opened':
      return {
        what: `Opened ${event.payload.channel === 'call' ? 'the dialler' : event.payload.channel}`,
        detail: event.payload.label ?? null,
      };
    /**
     * Notification traffic is summarised rather than narrated. Three lines per attempt would
     * bury the response in its own plumbing.
     *
     * — and `message_sent` joins them, 2026-08-23. The report deals with what happened to the
     * incident; who was told, and what they were told, is its own question with its own section,
     * so the text we sent goes wherever the rest of that traffic goes.
     *
     * It is worth its own line in this document eventually — *what did the district actually tell
     * people* is exactly what a review asks — but that is a change to the report the owner has not
     * asked for, and adding it as a side effect of a board change is how a document somebody
     * prints for the DC grows a section nobody chose.
     */
    case 'notified':
    case 'notification_delivered':
    case 'notification_failed':
    case 'message_sent':
    case 'merged':
    case 'unmerged':
      return { what: '', detail: null };
  }
}

/** Which units were sent, and for how long each one was committed. */
function unitsSent(sources: ReportSources): readonly UnitInvolvement[] {
  const sent = new Map<string, { sentAt: Instant; releasedAt: Instant | null }>();

  for (const event of sources.events) {
    if (event.type === 'assigned') {
      for (const id of event.payload.resourceIds) {
        if (!sent.has(id)) sent.set(id, { sentAt: event.occurredAt, releasedAt: null });
      }
    }
    if (event.type === 'released') {
      for (const id of event.payload.resourceIds) {
        const existing = sent.get(id);
        if (existing !== undefined) existing.releasedAt = event.occurredAt;
      }
    }
  }

  return [...sent.entries()].map(([resourceId, when]) => ({
    resourceId,
    name: sources.resources[resourceId] ?? resourceId,
    sentAt: when.sentAt,
    releasedAt: when.releasedAt,
    minutesCommitted:
      when.releasedAt === null ? null : Math.round(minutesBetween(when.sentAt, when.releasedAt)),
  }));
}

/** Person first, then post — ADR-0035 — and one string when the two would restate each other. */
function recipientName(
  personName: string | null,
  postTitle: string | null,
  fallbackId: string,
): string {
  if (personName !== null && postTitle !== null) {
    return personName === postTitle ? personName : `${personName} — ${postTitle}`;
  }
  return personName ?? postTitle ?? fallbackId;
}

/**
 * Who the control room told, joined to whether it landed and what they said back — 2026-09-07.
 *
 * `dispatchedTo` is the district's own question — *who was informed* — so it leads and sets the
 * order. `notifications` fills delivery, and adds a row for anyone the send ledger knows that no
 * dispatch named (a follow-up to a number, say). Responses come from `actions` logged by that
 * recipient, then from their acknowledgement — the latest wins, because "Fire Team Dispatched"
 * said after "on my way" is the line the district needs to see.
 */
function recipients(sources: ReportSources): readonly ReportRecipient[] {
  const { state } = sources;

  interface Row {
    order: number;
    seatId: Uuid | null;
    personId: Uuid | null;
    postTitle: string | null;
    personName: string | null;
    delivery: 'delivered' | 'failed' | 'pending' | 'unknown';
    failure: string | null;
    response: string | null;
    respondedAt: Instant | null;
  }

  const rows = new Map<string, Row>();
  let order = 0;
  const keyFor = (seatId: Uuid | null, personId: Uuid | null): string =>
    seatId !== null ? `post:${seatId}` : personId !== null ? `person:${personId}` : `row:${order}`;

  const ensure = (seatId: Uuid | null, personId: Uuid | null): Row => {
    const key = keyFor(seatId, personId);
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        order: order++,
        seatId,
        personId,
        // The post half: a `post` target's is the seat's title; a `person` target's is the
        // post they hold now (ADR-0035 reaching the recipient list — it only had a title for
        // the `post` case).
        postTitle:
          seatId !== null
            ? (sources.seats[seatId] ?? null)
            : personId !== null
              ? (sources.recipientDesignations?.[personId] ?? null)
              : null,
        // The human half: a `person` target's own name, or — for a `post` target — the officer
        // holding it, so the row reads `Imtiaz Ahmad — IT Soft` and not the title alone.
        personName:
          personId !== null
            ? (sources.people[personId] ?? null)
            : seatId !== null
              ? (sources.seatHolders?.[seatId] ?? null)
              : null,
        delivery: 'unknown',
        failure: null,
        response: null,
        respondedAt: null,
      };
      rows.set(key, row);
    }
    return row;
  };

  // 1. Who the control room chose to tell — this sets the list and its order.
  for (const target of state.dispatchedTo) {
    ensure(target.kind === 'post' ? target.id : null, target.kind === 'person' ? target.id : null);
  }

  // 2. Every send attempt — fills delivery, and surfaces a recipient the ledger knows even when
  //    no dispatch target named them. A settled outcome outranks a pending one.
  const rank = { delivered: 3, failed: 2, pending: 1, unknown: 0 } as const;
  for (const attempt of state.notifications) {
    const row = ensure(attempt.seatId, attempt.personId ?? null);
    if (rank[attempt.state] >= rank[row.delivery]) {
      row.delivery = attempt.state;
      row.failure = attempt.state === 'failed' ? (attempt.failure ?? 'no reason given') : null;
    }
    // The recipient's own words, when a person heard them and typed them in (`via: operator`).
    if (attempt.said !== undefined && attempt.said.trim() !== '') {
      row.response = attempt.said.trim();
      row.respondedAt = attempt.settledAt ?? null;
    }
  }

  // 3. What each recipient said — an action they logged, then their acknowledgement. Latest wins.
  for (const row of rows.values()) {
    const isThisRecipient = (by: { seatId: Uuid | null; personId: Uuid | null }): boolean =>
      (row.seatId !== null && by.seatId === row.seatId) ||
      (row.personId !== null && by.personId === row.personId);

    for (const action of state.actions) {
      if (
        isThisRecipient(action.by) &&
        (row.respondedAt === null || action.at >= row.respondedAt)
      ) {
        row.response = action.note;
        row.respondedAt = action.at;
      }
    }

    if (
      row.response === null &&
      state.acknowledgedAt !== null &&
      isThisRecipient({
        seatId: state.acknowledgedBySeatId,
        personId: state.acknowledgedByPersonId,
      })
    ) {
      row.response = state.acknowledgedSaid ?? 'Acknowledged';
      row.respondedAt = state.acknowledgedAt;
    }
  }

  const ordered = [...rows.values()].sort((a, b) => a.order - b.order);

  /**
   * The saved group each row came from, if any — Case 3. `groupRecipients` matches on the
   * `post:` / `person:` key (or the surviving key of a member the collapse absorbed); this
   * flattens its blocks to a `key -> group name` lookup. Empty everywhere when no dispatch on
   * this incident used a group, and the section then reads flat as it always did.
   */
  const rowKey = (r: Row): string =>
    r.seatId !== null ? `post:${r.seatId}` : r.personId !== null ? `person:${r.personId}` : 'row';
  const groupNameByKey = new Map<string, string>();
  const grouped = groupRecipients(
    groupsFromEvents(sources.events),
    ordered,
    rowKey,
    absorbedKeys(state.dispatchAbsorbed),
  );
  if (grouped !== null) {
    for (const block of grouped.blocks) {
      for (const r of block.rows) groupNameByKey.set(rowKey(r), block.group.name);
    }
  }

  return ordered.map((r) => ({
    name: recipientName(
      r.personName,
      r.postTitle,
      r.seatId ?? r.personId ?? 'someone no longer in the directory',
    ),
    delivery: r.delivery,
    failure: r.failure,
    response: r.response,
    respondedAt: r.respondedAt,
    group: groupNameByKey.get(rowKey(r)) ?? null,
  }));
}

function notifications(
  attempts: readonly NotificationAttempt[],
): PostIncidentReport['notifications'] {
  return {
    attempted: attempts.length,
    delivered: attempts.filter((a) => a.state === 'delivered').length,
    failed: attempts.filter((a) => a.state === 'failed').length,
    stillPending: attempts.filter((a) => a.state === 'pending').length,
    failures: attempts
      .filter((a) => a.state === 'failed')
      .map((a) => a.failure ?? 'no reason given'),
  };
}

/**
 * Everything the log does not contain.
 *
 * The most important part of the report, and the part a hand-written one always omits. A
 * review that is handed an account with the holes removed reads a clean response.
 */
function gaps(
  state: IncidentState,
  report: Omit<PostIncidentReport, 'gaps'>,
): readonly ReportGap[] {
  const found: ReportGap[] = [];

  if (report.attendance !== null) {
    // A notice that asked who is coming is attended, not "responded to" — the gap is that
    // nobody said whether they would be there.
    if (report.attendance.told > 0 && report.attendance.answered === 0) {
      found.push({
        what: 'Nobody said whether they were coming',
        why: 'The notice went out and not one of the people asked answered it.',
      });
    }
  } else if ((report.timings.find((t) => t.label === 'Responded')?.at ?? null) === null) {
    // Option C: the "Responded" timing, not `state.acknowledgedAt` — on a wide dispatch every
    // recipient can decline (which fills the ack slot) and still leave nobody holding it.
    found.push({
      what: 'Nobody responded to this',
      why: 'No seat took responsibility for it in the record.',
    });
  }
  if (state.severity === null || state.severity.value === 'unknown') {
    found.push({
      what: 'Nobody assessed the severity',
      why: 'It was handled at the deadline for an unassessed report (ADR-0009).',
    });
  }
  if (report.unitsSent.length === 0) {
    found.push({
      what: 'No unit was assigned in the app',
      why: 'No vehicle, team or equipment was formally committed to this incident here. Responders may still have been sent — see who was told and their replies.',
    });
  }
  if (state.actions.length === 0) {
    found.push({
      what: 'No actions were logged',
      why: 'What was done at the scene is not in this system.',
    });
  }
  if (report.evidence.length === 0) {
    found.push({ what: 'No photographs or files were attached', why: 'Nothing to corroborate.' });
  }
  if (report.notifications.attempted === 0) {
    found.push({
      what: 'Nobody was notified',
      why: 'No notification was even attempted, so nobody was told by the system.',
    });
  }
  if (report.notifications.failed > 0) {
    found.push({
      what: `${String(report.notifications.failed)} notification(s) failed`,
      why: report.notifications.failures.join('; '),
    });
  }
  /**
   * 🔴 **THIS SENTENCE WAS ABOUT TO APPEAR ON EVERY REPORT THE DISTRICT PRINTS — ADR-0030.**
   *
   * *"No department held this — routing matched nothing and nobody assigned it by hand"* is a
   * real gap, and it was worth spelling out while a department could hold an emergency.
   * Migration 0039 left nothing that can, so it would have been true of every incident for
   * ever — a permanent line in the *what went wrong* block of a document a district files, and
   * a section that always reports the same fault is one people stop reading, which is the whole
   * value of this block gone.
   *
   * The gap it was pointing at survives and is the one somebody can act on: **nobody was
   * given it.** `dispatchedTo` is what the board's loudest banner already counts, and unlike a
   * department it is something the control room can put right in ten seconds.
   */
  if (state.dispatchedTo.length === 0) {
    found.push({
      what: 'Nobody was given this',
      why: 'The control room never chose anybody to tell about it.',
    });
  }
  if (state.resolution === null) {
    found.push({ what: 'No outcome was recorded', why: 'The incident was never resolved.' });
  }

  return found;
}

export function buildReport(sources: ReportSources): PostIncidentReport {
  const { state, events } = sources;

  const reported = events.find((e) => e.type === 'reported');
  const occurredAt = state.occurredAt;
  const arrivedAt = reported?.recordedAt ?? null;

  /**
   * Who was coming — null unless this notice asked who is coming. The count restarts from
   * `rescheduledAt` and closes at `attendanceClosesAt` measured from when the notice went out,
   * exactly as the drawer and the wall compute it.
   */
  const askedAt = state.dispatchedAt ?? occurredAt;
  const tally = attendanceFor(state.kind, state.notifications, {
    rescheduledAt: state.rescheduledAt,
    closesAt: askedAt === null ? null : attendanceClosesAt(askedAt),
    invited: state.asksAttendance,
  });
  const attendance: PostIncidentReport['attendance'] =
    tally === null
      ? null
      : {
          told: tally.told,
          coming: tally.coming,
          answered: tally.answered,
          attending: tally.attending,
          sendingSomeone: tally.sendingSomeone,
          notAttending: tally.notAttending,
          other: tally.other,
          unanswered: tally.unanswered,
          closesAt: tally.closesAt,
        };

  /**
   * Who took this, off the officers' own words — Option C.
   *
   * On a message to more than one office the fold's single `acknowledgedBy*` slot names
   * whoever answered first, a refusal included, so a filed report has read *"Responded by"* as
   * the officer who said *Not Related to Me*. `told > 1` switches "Responded" and "Responded
   * by" to the first office that **committed**; on a single recipient the slot and the roll-up
   * are the same office at the same time, so those reports are unchanged.
   */
  const owned = ownershipOf(state.notifications);
  const wide = owned.told > 1;
  const respondedAt = wide ? owned.respondedAt : state.acknowledgedAt;
  const takenBy = wide
    ? owned.takenBySeatId === null && owned.takenByPersonId === null
      ? null
      : {
          seatId: owned.takenBySeatId,
          seatTitle:
            owned.takenBySeatId === null ? null : (sources.seats[owned.takenBySeatId] ?? null),
          personName:
            owned.takenByPersonId === null ? null : (sources.people[owned.takenByPersonId] ?? null),
        }
    : state.acknowledgedBySeatId === null && state.acknowledgedByPersonId === null
      ? null
      : {
          seatId: state.acknowledgedBySeatId,
          seatTitle:
            state.acknowledgedBySeatId === null
              ? null
              : (sources.seats[state.acknowledgedBySeatId] ?? null),
          personName:
            state.acknowledgedByPersonId === null
              ? null
              : (sources.people[state.acknowledgedByPersonId] ?? null),
        };

  const resolvedEvent = events.find((e) => e.type === 'resolved');
  const closedEvent = events.find((e) => e.type === 'closed');

  /**
   * When this incident was resolved for good — the last `resolved` event, and only if it is
   * still resolved or closed now. A reopen puts it back to live, and work done afterwards is
   * not "after resolution".
   */
  const resolvedForGoodAt =
    state.status === 'resolved' || state.status === 'closed'
      ? (events.filter((e) => e.type === 'resolved').at(-1)?.occurredAt ?? null)
      : null;

  const narrative: ReportEntry[] = [];
  for (const event of events) {
    const { what, detail } = describe(event, sources);
    if (what === '') continue;
    narrative.push({
      at: event.occurredAt,
      // Zero online; hours after a shutdown. Shown per line because a report where one entry
      // arrived two hours late and the rest did not is a different night from one where
      // everything did.
      recordedLaterMinutes: Math.round(arrivalGapMinutes(event.occurredAt, event.recordedAt)),
      what,
      detail,
      by:
        event.actorSeatId === null && event.actorPersonId === null
          ? NOBODY
          : actorOf(event, sources),
      afterResolution:
        resolvedForGoodAt !== null &&
        event.occurredAt > resolvedForGoodAt &&
        event.type !== 'closed',
    });
  }

  const withoutGaps: Omit<PostIncidentReport, 'gaps'> = {
    incidentId: state.incidentId,
    reference: sources.reference ?? null,
    generatedAt: sources.generatedAt,

    what: {
      category: state.category?.value ?? 'not stated',
      categorySetBy:
        state.category === null
          ? null
          : {
              seatId: state.category.setBy.seatId,
              seatTitle:
                state.category.setBy.seatId === null
                  ? null
                  : (sources.seats[state.category.setBy.seatId] ?? null),
              personName:
                state.category.setBy.personId === null
                  ? null
                  : (sources.people[state.category.setBy.personId] ?? null),
            },
      severity: state.severity?.value ?? 'unknown',
      severityAssessed: state.severity !== null && state.severity.value !== 'unknown',
      severitySetBy:
        state.severity === null
          ? null
          : {
              seatId: state.severity.setBy.seatId,
              seatTitle:
                state.severity.setBy.seatId === null
                  ? null
                  : (sources.seats[state.severity.setBy.seatId] ?? null),
              personName:
                state.severity.setBy.personId === null
                  ? null
                  : (sources.people[state.severity.setBy.personId] ?? null),
            },
      // Both values, never just the winner. An override that erased what the department
      // originally said would be the system taking a side (ADR-0003).
      severityOverriddenFrom: state.severity?.overriddenFrom?.value ?? null,
      overrideReason: state.severity?.overriddenFrom?.reason ?? null,
    },

    who: {
      reportedBy: reported === undefined ? NOBODY : actorOf(reported, sources),
      /**
       * 🔴 **A ROW NOBODY CAN NAME IS DROPPED, NEVER DRAWN AS AN ID — ADR-0030.**
       *
       * `?? id` was right while a registry existed: a department missing from it was a real
       * configuration fault and the id surfaced it. Migration 0039 dropped the table, so there
       * is no registry to be missing from and **every** historical id is unnameable — the
       * fallback stopped being a diagnostic and became the ordinary case.
       *
       * ⚠️ **This is the sixth place that fallback lived and the last one found.** The board
       * row, the incident detail and the daily report were repaired together; this one was
       * missed, and it is the worst of them to miss: a post-incident report is the artefact the
       * district **prints and files**, so thirty-six characters of hexadecimal under
       * *Responsible* outlive every screen. `performance.ts` settled the rule for its own table
       * long before this — a row nobody can name is dropped — and the seven now agree.
       */
      departments: state.responsibleDepartmentIds.flatMap((id) => {
        const name = sources.departments[id];
        return name === undefined ? [] : [name];
      }),
      departmentsItLeft: state.reassignedFrom.flatMap((id) => {
        const name = sources.departments[id];
        return name === undefined ? [] : [name];
      }),
      acknowledgedBy: takenBy,
    },

    timings: [
      timing('Happened', occurredAt, occurredAt, 'The reporter did not say when.'),
      timing('Reached the server', arrivedAt, occurredAt, 'No report event.'),
      timing('Responded', respondedAt, occurredAt, 'Nobody responded.'),
      timing(
        'First unit sent',
        events.find((e) => e.type === 'assigned')?.occurredAt ?? null,
        occurredAt,
        'No unit was assigned in the app — see who was told, below.',
      ),
      timing('Resolved', resolvedEvent?.occurredAt ?? null, occurredAt, 'Never resolved.'),
      timing('Closed', closedEvent?.occurredAt ?? null, occurredAt, 'Never closed.'),
    ],

    connectivity: {
      arrivalGapMinutes:
        occurredAt === null || arrivedAt === null
          ? 0
          : Math.round(arrivalGapMinutes(occurredAt, arrivedAt)),
      lateArrival: events.some((e) => e.type === 'late_arrival_flagged'),
    },

    unitsSent: unitsSent(sources),
    narrative,
    recipients: recipients(sources),
    attendance,
    notifications: notifications(state.notifications),
    escalations: state.escalationCount,
    evidence: sources.evidence,
    outcome: state.resolution,
    closureNotes: state.closureNotes,
  };

  return { ...withoutGaps, gaps: gaps(state, withoutGaps) };
}

/**
 * The report as plain text, for submitting upward.
 *
 * Q-02: departments keep their existing reporting obligations, and this platform generates
 * the account rather than integrating with the system that receives it. Plain text because it
 * can be pasted into anything — an email, a register, a form — with no tooling on the other
 * end, and because a district office should never need this software installed to read what
 * it produced.
 */
export function renderReport(report: PostIncidentReport): string {
  const out: string[] = [];
  const who = (a: Actor | null): string => actorName(a);
  const at = (iso: Instant | null): string => iso ?? 'time not recorded';

  out.push('POST-INCIDENT REPORT');
  /**
   * **The district's number first, the uuid underneath** — 2026-08-24.
   *
   * This line was the uuid alone. Both are here because they are read by different readers:
   * the number is what a DC office writes on a file and what an officer quotes on the phone,
   * and the uuid is what anybody debugging the record a year later needs — dropping it would
   * make a printed report impossible to tie back to the log it was folded from.
   *
   * The number leads because it is the one a human uses. An incident with no number yet says
   * so in words: a blank line here would read as a report about nothing (ADR-0005).
   */
  out.push(`Incident ${report.reference ?? 'not yet numbered'}`);
  out.push(`Record id ${report.incidentId}`);
  out.push(`Generated ${report.generatedAt} — folded from the event log, not typed`);
  out.push('');

  out.push('WHAT HAPPENED');
  out.push(`  Category: ${report.what.category}  (set by ${who(report.what.categorySetBy)})`);
  out.push(
    report.what.severityAssessed
      ? `  Severity: ${report.what.severity}  (assessed by ${who(report.what.severitySetBy)})`
      : '  Severity: never assessed by anybody',
  );
  if (report.what.severityOverriddenFrom !== null) {
    out.push(
      `  Overridden from "${report.what.severityOverriddenFrom}" — ${
        report.what.overrideReason ?? 'no reason given'
      }`,
    );
  }
  out.push('');

  out.push('WHO');
  out.push(`  Reported by: ${who(report.who.reportedBy)}`);
  out.push(
    `  Held by: ${report.who.departments.length === 0 ? 'no post was assigned' : report.who.departments.join(', ')}`,
  );
  if (report.who.departmentsItLeft.length > 0) {
    out.push(`  Previously held by: ${report.who.departmentsItLeft.join(', ')}`);
  }
  out.push(`  Responded by: ${who(report.who.acknowledgedBy)}`);
  out.push('');

  out.push('TIMES  (measured from when it happened, not from when we heard)');
  for (const t of report.timings) {
    out.push(
      t.at === null
        ? `  ${t.label.padEnd(20)} — ${t.missing ?? 'not recorded'}`
        : `  ${t.label.padEnd(20)} ${t.at}  (+${String(t.minutesFromOccurrence ?? 0)} min)`,
    );
  }
  if (report.connectivity.arrivalGapMinutes > 0) {
    out.push(
      `  The report spent ${String(report.connectivity.arrivalGapMinutes)} minutes unseen by the server${
        report.connectivity.lateArrival ? ' and was flagged as late-arriving' : ''
      }.`,
    );
  }
  out.push('');

  out.push('WHAT WAS SENT');
  if (report.unitsSent.length === 0) {
    out.push('  No unit was assigned in the app. See WHO WAS TOLD for who was sent word.');
  }
  for (const u of report.unitsSent) {
    out.push(
      u.releasedAt === null
        ? `  ${u.name} — sent ${u.sentAt}, never stood down in the record`
        : `  ${u.name} — sent ${u.sentAt}, stood down after ${String(u.minutesCommitted ?? 0)} min`,
    );
  }
  out.push('');

  if (report.attendance !== null) {
    const a = report.attendance;
    out.push('WHO IS COMING');
    if (a.told === 0) {
      out.push('  Nobody was asked.');
    } else {
      out.push(`  ${String(a.coming)} of ${String(a.told)} coming.`);
      const parts = [
        `${String(a.attending)} attending`,
        `${String(a.sendingSomeone)} sending someone`,
        `${String(a.notAttending)} not attending`,
        ...(a.other > 0 ? [`${String(a.other)} answered another way`] : []),
        `${String(a.unanswered)} did not answer`,
      ];
      out.push(`  ${parts.join(', ')}.`);
      if (a.closesAt !== null) out.push(`  The count closed ${a.closesAt}.`);
      out.push('  Each person and their answer is in WHO WAS TOLD below.');
    }
    out.push('');
  }

  out.push('WHO WAS TOLD');
  if (report.recipients.length === 0) {
    out.push('  Nobody. The control room never chose anybody to tell about this.');
  }
  /**
   * Headed by the group a dispatch expanded, when one was — Case 3. `expand()` dissolves the
   * group at send, so these are per-recipient rows; the heading only says which of them were one
   * tick. Drawn only when some recipient carries a group name; otherwise the list is flat as it
   * always was, no "Individually notified" over a page that had no group at all.
   */
  const anyGrouped = report.recipients.some((r) => r.group !== null);
  let lastGroup: string | null | undefined;
  for (const r of report.recipients) {
    if (anyGrouped && r.group !== lastGroup) {
      out.push(`  — ${r.group ?? 'Individually notified'} —`);
      lastGroup = r.group;
    }
    const delivery =
      r.delivery === 'delivered'
        ? 'delivered'
        : r.delivery === 'failed'
          ? `not delivered — ${r.failure ?? 'no reason given'}`
          : r.delivery === 'pending'
            ? 'never confirmed as delivered'
            : 'no delivery on the record';
    out.push(`  ${r.name} — ${delivery}`);
    out.push(
      r.response === null
        ? '      no reply from this recipient'
        : `      replied: ${r.response}${r.respondedAt === null ? '' : `  (${at(r.respondedAt)})`}`,
    );
  }
  out.push('');

  out.push('WHAT HAPPENED, IN ORDER');
  for (const e of report.narrative) {
    const late =
      e.recordedLaterMinutes > 0
        ? ` [reached the server ${String(e.recordedLaterMinutes)}m later]`
        : '';
    const post = e.afterResolution ? ' [after the incident was resolved]' : '';
    out.push(`  ${e.at}  ${e.what}${e.detail === null ? '' : `: ${e.detail}`}${post}`);
    out.push(`      by ${who(e.by)}${late}`);
  }
  out.push('');

  out.push('NOTIFICATIONS');
  out.push(
    `  ${String(report.notifications.attempted)} attempted, ${String(
      report.notifications.delivered,
    )} delivered, ${String(report.notifications.failed)} failed, ${String(
      report.notifications.stillPending,
    )} never settled`,
  );
  for (const f of report.notifications.failures) out.push(`  Failed: ${f}`);
  out.push('');

  if (report.escalations > 0) {
    out.push(`ESCALATED ${String(report.escalations)} time(s)`);
    out.push('');
  }

  out.push('EVIDENCE');
  if (report.evidence.length === 0) out.push('  None attached.');
  for (const e of report.evidence) {
    out.push(`  ${e.filename}${e.capturedAt === null ? '' : `  (taken ${e.capturedAt})`}`);
  }
  out.push('');

  out.push('OUTCOME');
  out.push(`  ${report.outcome ?? 'No outcome was recorded.'}`);
  if (report.closureNotes !== null) out.push(`  Closing notes: ${report.closureNotes}`);
  out.push('');

  // Last, and never omitted. A report handed to a review with the holes removed reads as a
  // clean response, and that is the one thing this document must not do.
  out.push('WHAT THIS RECORD DOES NOT CONTAIN');
  if (report.gaps.length === 0) {
    out.push('  Nothing. Every step of this incident is in the record.');
  }
  for (const g of report.gaps) out.push(`  ${g.what} — ${g.why}`);

  return out.join('\n');
}
