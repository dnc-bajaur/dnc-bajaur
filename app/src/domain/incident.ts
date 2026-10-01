/**
 * The fold: events -> current state. See ADR-0001.
 *
 * `Incident` has no mutable status column anywhere in this system. Its state is computed
 * from its events every time. That is what makes the audit trail incapable of disagreeing
 * with the data, and it is what makes offline replay and central override fall out of one
 * mechanism instead of three.
 */

import type {
  CommunicationDetails,
  DispatchTarget,
  Instant,
  IncidentEvent,
  MessageKind,
  ReportedLocation,
  Severity,
  SeveritySummary,
  Uuid,
} from './events.js';
import { isGeneral, worstSeverity } from './events.js';

export type IncidentStatus =
  'reported' | 'triaged' | 'routed' | 'acknowledged' | 'responding' | 'resolved' | 'closed';

export interface Actor {
  readonly personId: Uuid | null;
  readonly seatId: Uuid | null;
}

/**
 * A value plus the answer to "who set this, when, and was it overridden?".
 *
 * ADR-0003: an override never erases what the department entered. Both are carried, so
 * nobody can be blamed for a figure they did not enter, and the UI can always show the
 * department's own assessment alongside the district's correction.
 */
export interface Provenanced<T> {
  readonly value: T;
  readonly setBy: Actor;
  readonly setAt: Instant;
  readonly overriddenFrom?: {
    readonly value: T;
    readonly setBy: Actor;
    readonly setAt: Instant;
    readonly reason: string;
    readonly overriddenBy: Actor;
    readonly overriddenAt: Instant;
  };
}

export interface ResponseAction {
  readonly at: Instant;
  readonly by: Actor;
  readonly note: string;
}

/**
 * One notification attempt and what became of it.
 *
 * Kept as a list on the incident, never reduced to `notified: true` — that reduction is
 * precisely what INV-03 forbids, because it is the step that makes a failure invisible.
 */
export interface NotificationAttempt {
  readonly attemptId: Uuid;
  /** Null when the obligation was to a department with no post to notify. See INV-03. */
  readonly seatId: Uuid | null;
  /** Present when the obligation was to a department rather than a named seat. */
  readonly departmentId?: Uuid;
  /** Present when the obligation was to a named officer rather than a post (M6-03). */
  readonly personId?: Uuid;
  readonly channel: string;
  readonly reason: string;
  readonly attemptedAt: Instant;
  /**
   * **The words that actually reached the handset** — 2026-08-23, from `message_sent`.
   *
   * ⚠️ **Absent means UNKNOWN, never “nothing was sent”.** Nothing before 2026-08-23 carries
   * one, and none can be reconstructed: the composer runs off current state, so rebuilding an
   * old message would produce what it *would* say today — a different sentence wherever the
   * incident has since been corrected. The attempt beside it already says something was sent.
   */
  readonly sent?: { readonly what: string; readonly where: string };
  readonly state: 'pending' | 'delivered' | 'failed';
  /** Why it failed. Present only when `state` is `failed`. */
  readonly failure?: string;
  /** The failure was a provider deferring, not refusing. The next pass may try again (M6-24). */
  readonly retryable?: boolean;
  /**
   * How this was settled — M7-06. Absent on attempts settled before it was recorded.
   *
   * Carried on the attempt rather than derived from the channel, because they answer different
   * questions: `channel` is what was used to reach out, `via` is how we found out it worked.
   * A WhatsApp message answered by an operator's telephone call is `whatsapp` + `operator`,
   * and collapsing that into one field loses whichever half somebody later needs.
   */
  readonly via?: string;
  /** What the officer said, when a person heard it and typed it in (`via: 'operator'`). */
  readonly said?: string;
  readonly settledAt?: Instant;
}

export interface IncidentState {
  readonly incidentId: Uuid;
  readonly status: IncidentStatus;
  readonly severity: Provenanced<Severity> | null;
  readonly category: Provenanced<string> | null;
  readonly responsibleDepartmentIds: readonly Uuid[];
  /**
   * When a department was last assigned, or null if none ever has been.
   *
   * **Historical.** Until ADR-0022 an automatic pass wrote a `routed` event at intake even
   * when it matched nothing, and this recorded that the pass had run. Nothing writes such an
   * event any more — a `routed` event now only ever comes from a human — so on incidents
   * reported after ADR-0022 this is null until the control room assigns. Kept because the log
   * is append-only: incidents from before it still carry those events and must fold the same
   * way they always did (INV-08).
   */
  readonly routingAttemptedAt: Instant | null;
  /**
   * Nobody holds this yet.
   *
   * **Plainly the absence of a department, since ADR-0022** — it used to mean *"the routing
   * signals ran and matched nothing"*, which was a configuration gap the administration was
   * expected to close. There are no signals now: assignment is the control room's job, every
   * emergency arrives unheld, and this is the queue of what they have not got to yet. It is a
   * worklist, not a fault. Resolved and closed incidents are excluded — an incident that is
   * over needs nobody assigned to it, and counting it would grow the queue for ever.
   *
   * 🔴 **AND SINCE ADR-0030 IT IS NOT A DEPARTMENT IT IS THE ABSENCE OF — READ THIS BEFORE
   * "RESTORING" THE OLD TEST.**
   *
   * Migration 0039 dropped the table, so `responsibleDepartmentIds` can never be filled again:
   * `/route` takes ids for rows that do not exist, and the dispatch path's own assignment
   * resolves a chosen post to `null` and so never fires. Left as it was, this field is **true
   * for every live incident in Bajaur, for ever** — and it is not an unread number:
   * `.row[data-unassigned='true']` paints the critical wash and is declared so that it OUTRANKS
   * the rule that lets an acknowledged row recede. Every row on the district's board would have
   * been red permanently, and the board's whole loud/quiet design — which this project spent a
   * milestone getting right — would have gone with it.
   *
   * So the question moves to the one the district actually acts on, and it is the one their own
   * wall has asked since 2026-08-18: **has anybody been told?** `dispatchedTo` is what
   * `nobodyTold` already counts, what the board's loudest banner already reads, and what an
   * operator can do something about in ten seconds. A department was never that: the figure was
   * true of 28 of 37 open emergencies on the day it was taken off the deck.
   *
   * ⚠️ **The record is untouched.** `responsibleDepartmentIds` still folds, still carries every
   * `routed` event Bajaur ever wrote, and is still what `evaluateRead` scopes on — this changes
   * what the WORD means on a screen, not what happened. A past incident routed to a department
   * and never dispatched to anybody now reads as unassigned, which is exactly what it was.
   */
  readonly unassigned: boolean;
  /**
   * Departments that held this and no longer do.
   *
   * Kept because a handover has two sides. The department losing an incident has to be told
   * it is no longer theirs, and without this the projection cannot say who that was.
   */
  readonly reassignedFrom: readonly Uuid[];
  readonly reportIds: readonly Uuid[];
  /**
   * Who the control room chose to tell — M6-03/04.
   *
   * Kept apart from `responsibleDepartmentIds` on purpose, and the distinction is the point of
   * the whole feature. Routing says **who is responsible**; this says **who was told**, and in
   * a district where a road is closed those are routinely different lists. Merging them would
   * make an incident look assigned to everybody an operator thought to inform.
   *
   * Already collapsed: one emergency, one message per person (`collapseSelection`).
   */
  readonly dispatchedTo: readonly DispatchTarget[];
  /** Ticked and covered by something else, with what covered it. Kept, never dropped. */
  readonly dispatchAbsorbed: readonly { target: DispatchTarget; coveredBy: DispatchTarget }[];
  /** When the control room last chose, or null if nobody has. */
  readonly dispatchedAt: Instant | null;
  /**
   * Times an officer opened WhatsApp, the dialler or messages from a number this system gave
   * them (M6-10).
   *
   * A count and its last time, never folded into "contacted". **Nothing here observed a
   * conversation**, and the one thing this must not become is evidence that somebody was
   * reached — see the `contact_opened` payload.
   */
  readonly contactsOpened: readonly {
    readonly at: Instant;
    readonly by: Actor;
    readonly channel: string;
    readonly label: string | null;
  }[];
  /**
   * What kind of thing this is — M7-23. `emergency` unless somebody said otherwise.
   *
   * Read by the WhatsApp subject line and by the board. Everything else in this fold treats
   * all four identically, which is the point: one mechanism, four subjects.
   */
  readonly kind: MessageKind;
  /**
   * *How urgently the wall should carry it* — M10-20/42, independent of severity. `routine`
   * unless the first report said `important`, mirroring `kind`'s own read-time default and for
   * the same reason: an event written before this field existed genuinely carries neither value,
   * and reading it as `important` would be inventing an assessment nobody made (M10-21).
   */
  readonly importance: 'routine' | 'important';
  /**
   * **What the operator filled in on the form** — the subject, the date, the venue, the note.
   *
   * From the **first** report, on `kind`'s and `importance`'s own rule: a later report is
   * somebody adding detail, not re-typing the meeting notice.
   *
   * ⚠️ **Folded here for the first time on 2026-08-22, and everything downstream still reads it
   * off the `reported` payload.** `jobs/whatsappChannel.ts` does, correctly — it needs the
   * payload anyway for `description`. What it exists for is `domain/carrying.ts`, which asks a
   * question of the **state**: *when should somebody be asked whether this is still running?*
   * Re-reading the event log at every place that asks would be a second path to one answer.
   */
  readonly details: CommunicationDetails | null;
  /**
   * Where the first report said this happened, restored 2026-09-05 — see `ReportedLocation` and
   * `domain/communications.ts`'s `locationLine`, which is what actually reads this back now.
   *
   * From the **first** `reported` event, on `kind`'s and `details`'s own rule: a later report is
   * somebody adding detail to an incident that already has a place, not relocating it.
   */
  readonly location: ReportedLocation | null;
  /**
   * **When the meeting was last moved**, or null if it never has been.
   *
   * 🔴 **The attendance count starts again from here, and the earlier answers are NOT erased.**
   * An officer who said *Attending* for Monday has said nothing about Thursday — agreed with the
   * district — so the tally for the new date begins empty. Every one of those answers is still
   * on the incident, still in the log, and still rendered beside the new ones marked as what
   * they are (`AttendanceRow.stale`). Nothing about a reschedule deletes anything.
   *
   * The status is untouched. A rescheduled meeting has not finished.
   */
  /**
   * **This notice asks who is coming** — the district's five, 2026-08-22. False unless the
   * first report said so, on `kind`'s and `importance`'s own rule.
   *
   * Only ever true on `other`. It buys the three attendance buttons and a tally, and buys
   * nothing else: no clock, no ladder, and no row in any unmet count.
   */
  readonly asksAttendance: boolean;
  readonly rescheduledAt: Instant | null;
  readonly rescheduleReason: string | null;
  /** How many times it has moved. A meeting on its third date is worth seeing as one. */
  readonly rescheduleCount: number;
  readonly acknowledgedAt: Instant | null;
  readonly acknowledgedBySeatId: Uuid | null;
  /**
   * **The human who acknowledged**, when the event named one — 2026-09-07.
   *
   * Kept beside `acknowledgedBySeatId`, never folded into it: the post is what carries the
   * duty (ADR-0004) and the person is who the control room quotes on the telephone. Null
   * when only a post was recorded — an in-app tap by a signed-in officer whose person was
   * not on the event, or any acknowledgement from before this was carried.
   */
  readonly acknowledgedByPersonId: Uuid | null;
  /**
   * How we know — M7-06. Null on acknowledgements recorded before routes existed, and on
   * acknowledgements made in the app by a signed-in officer, which is the case the original
   * command was written for.
   *
   * **This is shown on screen, in different words for each route.** *"Rescue confirmed"* and
   * *"Control room recorded: Rescue confirmed by telephone"* are two different claims about how
   * sure the district is, and a screen that renders them identically has thrown that away.
   */
  readonly acknowledgedVia: string | null;
  /** What they said, when a person heard it and typed it in. */
  readonly acknowledgedSaid: string | null;
  readonly escalationCount: number;
  readonly currentEscalationSeatId: Uuid | null;
  readonly assignedResourceIds: readonly Uuid[];
  readonly actions: readonly ResponseAction[];
  /** Every attempt, in order, with its outcome. Never collapsed to a boolean (INV-03). */
  readonly notifications: readonly NotificationAttempt[];
  /**
   * **Times the control room chased an alert it had already sent** — 2026-08-23.
   *
   * Folded because the board needs it, and until today nothing folded it at all: `followed_up`
   * was appended by `api/followUp.ts` and read by the post-incident report straight off the event
   * list, so the state knew nothing about it and no screen could ask.
   *
   * ⚠️ **`delivered` is Meta ACCEPTING the message, never an officer reading it** (ADR-0014).
   * A follow-up that could not be sent is the one an operator has to act on — usually a dead
   * number in the roster — which is why it is kept per attempt rather than reduced to a count.
   */
  readonly followUps: readonly {
    readonly at: Instant;
    readonly note: string;
    readonly delivered: boolean;
  }[];
  readonly mergedIncidentIds: readonly Uuid[];
  readonly resolution: string | null;
  readonly closureNotes: string | null;
  readonly reopenCount: number;
  /**
   * **What we sent was wrong** — M9-52. Null when nothing has been corrected.
   *
   * Beside the status, never folded into it. A meeting notice with the wrong date is not
   * *resolved*, it is wrong; a fire cannot be un-happened. The status answers *what is
   * happening* and this answers *is what we said still true*.
   */
  readonly correctedAt: Instant | null;
  readonly correctedBy: Actor | null;
  readonly correctionReason: string | null;
  /** What is true instead, when the operator knew. Null is an honest answer here. */
  readonly correction: string | null;
  /**
   * **Taken off the board** — M10-11. Null when it is on the board, which is nearly always.
   *
   * Beside the status and never folded into it, for the same reason `correctedAt` is: nobody
   * resolved anything, and an emergency does not stop having happened because a screen stopped
   * showing it. The board and the dashboard drop it; **search and the daily report keep it and
   * mark it** (M10-15), which is what stops this being a delete.
   */
  readonly withdrawnAt: Instant | null;
  readonly withdrawnBy: Actor | null;
  readonly withdrawalReason: string | null;
  /**
   * **Kept on the wall past midnight by the control room's own decision** — the district's five,
   * 2026-08-22. Null unless somebody said so about this one item.
   *
   * Beside the status and never folded into it, exactly like `withdrawnAt` — and the pair is
   * that field's other end. `withdrawn` answers *should this be on the screen at all*; this
   * answers *does this survive the daily reset*, and an item can honestly be one and not the
   * other.
   *
   * At most one of this and `holdEndedAt` is ever set: each event clears the other, so *latest
   * wins* falls out of the fold rather than needing a comparison at the point of use. Both
   * events stay in the log; only these read-time fields move.
   *
   * Read by `domain/carrying.ts`'s `outlivesTheDay`, which is the only thing that should
   * interpret them.
   */
  readonly heldOverAt: Instant | null;
  readonly heldOverBy: Actor | null;
  readonly holdReason: string | null;
  /**
   * **Released — let it clear with the day**, against a default that would have carried it.
   *
   * ⚠️ **Not a resolution and must never be read as one.** A flood released from the panel is
   * not a flood that is over; it is a flood the control room has stopped watching on that
   * screen. The software cannot know the first thing, and the status is untouched here.
   */
  readonly holdEndedAt: Instant | null;
  readonly holdEndedBy: Actor | null;
  readonly holdEndReason: string | null;
  /**
   * When the **emergency** happened, per the reporter.
   *
   * Taken from the earliest `reported` event, and from nothing else. It used to be the
   * earliest `occurredAt` of any event, which was the same thing right up until M1-04 let an
   * action state when it actually happened — after which a crew logging "on scene" with a
   * time earlier than the report **moved the incident's start**, and every SLA deadline with
   * it. An incident could become overdue, or stop being overdue, because somebody wrote up
   * their notes honestly.
   *
   * Found by the M1 gate, in the post-incident report's own timings, where "Happened" and
   * "Reported" were twelve minutes apart on an incident reported the moment it happened.
   */
  readonly occurredAt: Instant | null;
  /**
   * When the incident **first reached the server** — the `recordedAt` of its earliest `reported`
   * event, and nothing else.
   *
   * Distinct from `occurredAt`, which is when the reporter says it happened and which a
   * backdated report moves into the past. This is the moment the district could first have seen
   * it, so it is what "the latest thing recorded" means on the Record (2026-09-06) — a report
   * typed in now sits at the top even if it is filed about last night (ADR-0002, ADR-0020's
   * "arrival").
   */
  readonly arrivedAt: Instant | null;
  /** Latest `recordedAt` seen — how current this projection is. */
  readonly lastRecordedAt: Instant | null;
  readonly eventCount: number;
}

/**
 * Causal order: when it happened, then the client's own sequence, then when we learned of
 * it, then the id as a last resort.
 *
 * `clientSeq` carries the weight. An earlier version ordered by timestamps and fell back
 * to `eventId`, which is a random uuid — and an integration test caught the consequence: a
 * batch of events created in the same millisecond, stored in one transaction with an
 * identical `recordedAt`, folded in random order. `triaged` landed after `overridden` and
 * silently discarded a district override.
 *
 * That version was deterministic. It was also wrong. Determinism was never the hard part.
 */
export function compareEvents(a: IncidentEvent, b: IncidentEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  if (a.clientSeq !== b.clientSeq) return a.clientSeq < b.clientSeq ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  return 0;
}

export interface FoldOptions {
  /**
   * Reconstruct a past state.
   *
   * `knownAt` answers "what did the control room see at 14:20?" — it filters on
   * `recordedAt`, so events that had not yet synced are correctly absent.
   *
   * `happenedBy` answers "what was actually true at 14:20?" — it filters on `occurredAt`,
   * including events that only reached the server hours later.
   *
   * These give different answers during an outage, and both questions get asked after a
   * serious incident. Neither is the "right" one, so the caller must choose.
   */
  readonly knownAt?: Instant;
  readonly happenedBy?: Instant;
}

const EMPTY_ACTOR: Actor = { personId: null, seatId: null };

function actorOf(e: IncidentEvent): Actor {
  return { personId: e.actorPersonId, seatId: e.actorSeatId };
}

/**
 * Replace a value while keeping what it replaced.
 *
 * The immediately previous value is carried in `overriddenFrom` so the UI can always show
 * both without a second query. The complete chain, if an override is itself overridden,
 * remains in the event log — which is the record. This is the projection.
 */
function withOverride<T>(
  prev: Provenanced<T> | null,
  value: T,
  reason: string,
  by: Actor,
  at: Instant,
): Provenanced<T> {
  if (prev === null) return { value, setBy: by, setAt: at };
  return {
    value,
    setBy: by,
    setAt: at,
    overriddenFrom: {
      value: prev.value,
      setBy: prev.setBy,
      setAt: prev.setAt,
      reason,
      overriddenBy: by,
      overriddenAt: at,
    },
  };
}

/**
 * Fold an incident's events into its current state.
 *
 * Duplicate `eventId`s are dropped rather than applied twice. That is what makes an
 * offline client safe to retry after an ambiguous network failure, and what stops a
 * reconnect from double-counting (INV-08).
 */
export function foldIncident(
  incidentId: Uuid,
  events: readonly IncidentEvent[],
  options: FoldOptions = {},
): IncidentState {
  const seen = new Set<string>();
  const ordered = events
    .filter((e) => {
      if (e.incidentId !== incidentId) return false;
      if (options.knownAt !== undefined && e.recordedAt > options.knownAt) return false;
      if (options.happenedBy !== undefined && e.occurredAt > options.happenedBy) return false;
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    })
    .sort(compareEvents);

  let status: IncidentStatus = 'reported';
  let severity: Provenanced<Severity> | null = null;
  let category: Provenanced<string> | null = null;
  let responsibleDepartmentIds: readonly Uuid[] = [];
  let routingAttemptedAt: Instant | null = null;
  const reassignedFrom: Uuid[] = [];
  const reportIds: Uuid[] = [];
  // Keyed so a second dispatch adding one name does not report the first two as new. The
  // control room dispatches more than once per incident, routinely — a second department is
  // remembered a minute later — and the ledger has to answer "who has been told" for the
  // incident, not "who was named in the most recent tick".
  const dispatchedTo = new Map<string, DispatchTarget>();
  const followUps: { at: Instant; note: string; delivered: boolean }[] = [];
  const dispatchAbsorbed = new Map<string, { target: DispatchTarget; coveredBy: DispatchTarget }>();
  let dispatchedAt: Instant | null = null;
  const contactsOpened: {
    at: Instant;
    by: Actor;
    channel: string;
    label: string | null;
  }[] = [];
  let kind: MessageKind | null = null;
  let importance: 'routine' | 'important' | null = null;
  let details: CommunicationDetails | null = null;
  let location: ReportedLocation | null = null;
  let asksAttendance: boolean | null = null;
  let rescheduledAt: Instant | null = null;
  let rescheduleReason: string | null = null;
  let rescheduleCount = 0;
  let acknowledgedAt: Instant | null = null;
  let acknowledgedBySeatId: Uuid | null = null;
  let acknowledgedByPersonId: Uuid | null = null;
  let acknowledgedVia: string | null = null;
  let acknowledgedSaid: string | null = null;

  /**
   * **The first real response acknowledges too, if nothing has already — 2026-09-04.**
   *
   * Since ADR-0034 every category's own template puts three buttons on the officer's *first*
   * message and none of them means only "I saw this" — all three map straight to Responded or
   * Resolved (`domain/responseOptions.ts`'s `TEMPLATE_OPTIONS`). So the tap that used to be two
   * things — an `acknowledged` event to stop the clock, then an `action_logged`/`resolved` event
   * to record the answer — is now one thing, and writing it as two events at the same instant is
   * what the district read as a duplicate on the record panel.
   *
   * `acknowledgedAt` is still the field `sla.ts`'s `checkEscalation` stops the clock on, so it has
   * to be set from *somewhere*. This is that somewhere: the first event that moves the incident
   * off `reported`/`triaged`/`routed` under its own power — `assigned`, `action_logged`,
   * `resolved` — sets it, exactly as an explicit `acknowledged` event would, if nothing already
   * has. An incident that DOES carry an explicit `acknowledged` event (the old in-window workflow,
   * still requiring its own tap; a manual telephone confirmation) is untouched — this only fills
   * the gap for the caller that no longer writes one.
   *
   * ⚠️ **This also closes a real gap the `assigned` case below already flagged in its own
   * comment**: committing a resource used to move an incident to `responding` with NO
   * acknowledgement ever written, so the SLA clock went on running and escalation kept climbing
   * over an emergency someone had visibly taken. That was true before this change and is fixed by
   * it, not merely worked around.
   */
  const markRespondedIfUnacknowledged = (e: IncidentEvent): void => {
    if (acknowledgedAt !== null) return;
    acknowledgedAt = e.occurredAt;
    acknowledgedBySeatId = e.actorSeatId;
    acknowledgedByPersonId = e.actorPersonId;
    // `acknowledgedVia` names how we know an officer confirmed — a tap, a reply, an operator's
    // record. None of those describes "inferred from the fact that a response was logged", so
    // this is left null rather than inventing a route that never happened. `readIncident` already
    // treats a null route as "acknowledged in the app", which is the nearest true reading.
  };
  let escalationCount = 0;
  let currentEscalationSeatId: Uuid | null = null;
  const assignedResourceIds: Uuid[] = [];
  const actions: ResponseAction[] = [];
  // Keyed by attemptId so an outcome updates its attempt rather than appending beside it.
  const notifications = new Map<Uuid, NotificationAttempt>();
  const mergedIncidentIds: Uuid[] = [];
  let resolution: string | null = null;
  let closureNotes: string | null = null;
  let reopenCount = 0;
  let correctedAt: Instant | null = null;
  let correctedBy: Actor | null = null;
  let withdrawnAt: Instant | null = null;
  let withdrawnBy: Actor | null = null;
  let withdrawalReason: string | null = null;
  let heldOverAt: Instant | null = null;
  let heldOverBy: Actor | null = null;
  let holdReason: string | null = null;
  let holdEndedAt: Instant | null = null;
  let holdEndedBy: Actor | null = null;
  let holdEndReason: string | null = null;
  let correctionReason: string | null = null;
  let correction: string | null = null;
  let occurredAt: Instant | null = null;
  let arrivedAt: Instant | null = null;
  let lastRecordedAt: Instant | null = null;

  for (const e of ordered) {
    // From the report, not from whatever sorted first. See `occurredAt` above.
    if (e.type === 'reported' && (occurredAt === null || e.occurredAt < occurredAt)) {
      occurredAt = e.occurredAt;
    }
    // `ordered` is ascending by `recordedAt`, so the first `reported` we meet is the earliest —
    // when the incident first reached the server. See `arrivedAt` above.
    if (e.type === 'reported' && arrivedAt === null) arrivedAt = e.recordedAt;
    if (lastRecordedAt === null || e.recordedAt > lastRecordedAt) lastRecordedAt = e.recordedAt;

    switch (e.type) {
      case 'reported': {
        reportIds.push(e.payload.reportId);
        // The first report decides what kind of thing this is (M7-23). A later report on the
        // same incident is somebody adding detail, not changing an advisory into an order —
        // and if the district ever needs that, it is a deliberate act with its own event.
        if (kind === null) kind = e.payload.kind ?? 'emergency';
        if (importance === null) importance = e.payload.importance ?? 'routine';
        // The first report's form, on the same rule as the two lines above it.
        if (details === null) details = e.payload.details ?? null;
        if (location === null) location = e.payload.location ?? null;
        if (asksAttendance === null) asksAttendance = e.payload.asksAttendance ?? false;
        if (severity === null) {
          severity = { value: e.payload.severity, setBy: actorOf(e), setAt: e.occurredAt };
        }
        if (category === null) {
          category = { value: e.payload.category, setBy: actorOf(e), setAt: e.occurredAt };
        }
        break;
      }

      case 'triaged': {
        // A department reassessment never silently discards a district override. The
        // override stands until it is itself changed by someone with the authority.
        if (severity?.overriddenFrom === undefined) {
          severity = { value: e.payload.severity, setBy: actorOf(e), setAt: e.occurredAt };
        }
        category = { value: e.payload.category, setBy: actorOf(e), setAt: e.occurredAt };
        if (status === 'reported') status = 'triaged';
        break;
      }

      case 'routed': {
        responsibleDepartmentIds = [...e.payload.departmentIds];
        routingAttemptedAt = e.occurredAt;
        // Only advance the status if it actually reached somebody. Since ADR-0022 a human
        // writes every one of these, so an empty list means an operator cleared the holders
        // rather than that an automatic pass matched nothing — but the reading on a board is
        // the same either way: calling that "routed" would tell an operator help is on its
        // way to a department that does not exist. Incidents from before ADR-0022 still carry
        // empty automatic events, and this is why they still fold correctly.
        if (e.payload.departmentIds.length > 0 && (status === 'reported' || status === 'triaged')) {
          status = 'routed';
        }
        break;
      }

      case 'dispatched': {
        for (const target of e.payload.targets) {
          dispatchedTo.set(`${target.kind}:${target.id}`, target);
        }
        for (const entry of e.payload.absorbed ?? []) {
          const key = `${entry.target.kind}:${entry.target.id}`;
          // An earlier dispatch may have sent this target for real. Being absorbed later must
          // never retract that — the message went, and the ledger says what happened.
          if (dispatchedTo.has(key)) continue;
          dispatchAbsorbed.set(key, entry);
        }
        dispatchedAt = e.occurredAt;
        break;
      }

      case 'contact_opened': {
        contactsOpened.push({
          at: e.occurredAt,
          by: actorOf(e),
          channel: e.payload.channel,
          label: e.payload.label ?? null,
        });
        break;
      }

      case 'acknowledged': {
        if (acknowledgedAt === null) {
          acknowledgedAt = e.occurredAt;
          acknowledgedBySeatId = e.payload.seatId;
          // The officer who took it, not the envelope's actor. On `route: 'operator'` the
          // actor is the operator relaying a telephone call (M7-05) — a different person —
          // so the payload's own `personId` is the only trustworthy source there. On every
          // other route the actor IS the acknowledger, so it is the right fallback.
          acknowledgedByPersonId =
            e.payload.personId ?? (e.payload.route === 'operator' ? null : e.actorPersonId);
          acknowledgedVia = e.payload.route ?? null;
          acknowledgedSaid = e.payload.said ?? null;
        }
        /**
         * ⚠️ **Never backward from `responding` either — a meeting's first reply, 2026-09-19.**
         *
         * A gathering has no `Acknowledge` button: `Attending` / `Not attending` / `Sending
         * someone` is the officer's first and only tap, and it matches none of `webhooks.ts`'s
         * response options (a meeting carries no options list). So the same reply produces an
         * `action_logged` event that correctly moves this straight to `responding`, immediately
         * followed by `appendAcknowledgement`'s fallback write — its own guard only refuses a
         * *second* acknowledgement (`acknowledgedAt !== null`), which this is not, since nothing
         * upstream set it. Without this exclusion that fallback event dragged a meeting a tap had
         * just answered back down to `acknowledged`, which reads as `Issued` (`stages.ts`) —
         * the tap recorded, the district thanked for it, and the wall still said nobody had
         * replied.
         */
        if (status !== 'resolved' && status !== 'closed' && status !== 'responding') {
          status = 'acknowledged';
        }
        break;
      }

      case 'assigned': {
        for (const id of e.payload.resourceIds) {
          if (!assignedResourceIds.includes(id)) assignedResourceIds.push(id);
        }
        // ⚠️ Same rule as `action_logged` above, and for the same reason: committing a unit to
        // an emergency is responding to it, whether or not anybody acknowledged it first — and
        // since ADR-0030 nothing reaches `acknowledged` on its own. `markRespondedIfUnacknowledged`
        // is what closes that: assigning a resource now stops the SLA clock if nothing already had.
        markRespondedIfUnacknowledged(e);
        if (status !== 'resolved' && status !== 'closed') status = 'responding';
        break;
      }

      case 'released': {
        // Removed from the live set rather than flagged. "Assigned, then released" stays
        // fully readable in the event history; what the projection has to answer is the live
        // question — is this unit committed *right now* — and a list that only grows cannot
        // answer it.
        for (const id of e.payload.resourceIds) {
          const at = assignedResourceIds.indexOf(id);
          if (at !== -1) assignedResourceIds.splice(at, 1);
        }
        break;
      }

      case 'action_logged': {
        actions.push({ at: e.occurredAt, by: actorOf(e), note: e.payload.note });
        /**
         * 🔴 **THIS STOPPED MOVING ANYTHING AT ALL — ADR-0030.**
         *
         * The set was `acknowledged` or `routed`, and `routed` is now unreachable: nothing
         * produces it since migration 0039 dropped the departments `/route` takes. So an officer
         * who tapped *"Deploying Relevant Staff / Team"* on the response page left the emergency
         * reading **reported** — and `stageOf` derives the stage straight from the status, so the
         * board showed **Issued** on an emergency somebody had already said they were handling.
         * The control room would have gone on chasing it.
         *
         * The rule it was reaching for is simply *somebody is dealing with this*, and the only
         * thing the old list was really protecting was the far end: an action logged after the
         * fact must not drag a resolved emergency back to responding. That is what is guarded
         * now, rather than a list of the states an incident used to be able to be in.
         */
        /**
         * ⚠️ **`markRespondedIfUnacknowledged` fires ONLY when `payload.acknowledges` is set —
         * 2026-09-04, and NOT unconditionally the way `assigned`/`resolved` below do.**
         *
         * `action_logged` is overloaded: `api/webhooks.ts` writes one for *every* inbound reply —
         * a tap, a typed sentence, a decline, a photograph — as the plain record of what arrived,
         * long before it knows whether that reply matched one of the district's response options.
         * Treating every one of those as an acknowledgement would have stopped the SLA clock on a
         * free-text reply that answered nothing, which is precisely what an officer typing "on my
         * way" being read as *un*acknowledged used to cost the district (see `appendAcknowledgement`
         * in `api/webhooks.ts`). The flag is set only on the one `action_logged` event that a
         * matched, non-resolving response option produces, and it is that event's own words that
         * describe the response — nothing else needs to be appended to say the clock stopped.
         */
        if (e.payload.acknowledges === true) markRespondedIfUnacknowledged(e);
        if (status !== 'resolved' && status !== 'closed') status = 'responding';
        break;
      }

      case 'escalated': {
        escalationCount += 1;
        currentEscalationSeatId = e.payload.toSeatId;
        break;
      }

      case 'reassigned': {
        // Prefer what the event recorded; fall back to what we currently believe, so an
        // event written before `fromDepartmentIds` was populated still yields the truth.
        const from =
          e.payload.fromDepartmentIds.length > 0
            ? e.payload.fromDepartmentIds
            : responsibleDepartmentIds;
        for (const id of from) {
          if (!reassignedFrom.includes(id)) reassignedFrom.push(id);
        }
        responsibleDepartmentIds = [...e.payload.toDepartmentIds];
        break;
      }

      case 'overridden': {
        // The heart of ADR-0003. The previous value is carried forward, not replaced.
        if (e.payload.field === 'severity') {
          const prev: Provenanced<Severity> | null = severity;
          severity = withOverride(
            prev,
            e.payload.value as Severity,
            e.payload.reason,
            actorOf(e),
            e.occurredAt,
          );
        } else if (e.payload.field === 'category') {
          const prev: Provenanced<string> | null = category;
          category = withOverride(
            prev,
            e.payload.value,
            e.payload.reason,
            actorOf(e),
            e.occurredAt,
          );
        }
        break;
      }

      case 'merged': {
        if (!mergedIncidentIds.includes(e.payload.absorbedIncidentId)) {
          mergedIncidentIds.push(e.payload.absorbedIncidentId);
        }
        break;
      }

      case 'unmerged': {
        const i = mergedIncidentIds.indexOf(e.payload.restoredIncidentId);
        if (i !== -1) mergedIncidentIds.splice(i, 1);
        break;
      }

      case 'resolved': {
        // An emergency resolved with nothing acknowledging it first — the district's own
        // "Already Being Handled" / "Already Under Control" options do exactly this, on one
        // tap — still stops the clock. Resolving IS the response.
        markRespondedIfUnacknowledged(e);
        resolution = e.payload.outcome;
        status = 'resolved';
        break;
      }

      case 'closed': {
        closureNotes = e.payload.notes;
        status = 'closed';
        break;
      }

      case 'corrected': {
        /**
         * The **latest** correction wins, and every earlier one stays in the log.
         *
         * A second correction of the same communication is ordinary: the first said "ignore
         * this", the second says what is true instead. What the screen must show is the current
         * answer; what the record must keep is both.
         *
         * The status is untouched — see the payload's own comment.
         */
        correctedAt = e.occurredAt;
        correctedBy = actorOf(e);
        correctionReason = e.payload.reason;
        correction = e.payload.correction ?? null;
        break;
      }

      case 'withdrawn': {
        withdrawnAt = e.occurredAt;
        withdrawnBy = actorOf(e);
        withdrawalReason = e.payload.reason;
        break;
      }

      case 'restored': {
        /**
         * Back on the board, and **the withdrawal is still in the log.**
         *
         * Only the three fields the screens read are cleared. A withdraw-then-restore is not a
         * round trip that erases itself — it is two facts about what the control room believed,
         * and `readIncident` renders both on the timeline.
         *
         * The status is untouched here too, because it was untouched on the way out.
         */
        withdrawnAt = null;
        withdrawnBy = null;
        withdrawalReason = null;
        break;
      }

      /**
       * **Keep it past midnight** — the district's five, 2026-08-22.
       *
       * Each of the pair clears the other, which is what makes *latest wins* a property of the
       * fold rather than a comparison every reader has to remember. The two events themselves
       * are still both in the log, and `readIncident` renders both on the timeline — a hold
       * that was later released is two decisions, not a round trip that erases itself.
       *
       * The status is untouched, on `withdrawn`'s reasoning: nobody resolved anything by
       * deciding to keep watching it.
       */
      case 'held_over': {
        heldOverAt = e.occurredAt;
        heldOverBy = actorOf(e);
        holdReason = e.payload.reason;
        holdEndedAt = null;
        holdEndedBy = null;
        holdEndReason = null;
        break;
      }

      /**
       * **The meeting moved** — the district's five, 2026-08-22.
       *
       * The new date REPLACES the old one in `details`, because `details` is what every screen
       * and every message renders and a meeting notice that still showed Monday would be the
       * software arguing with the message the district has just sent out. The old date is not
       * lost: the `reported` event still carries it and the timeline prints both.
       *
       * ⚠️ `time` and `venue` are replaced ONLY when the reschedule states them. A meeting
       * moved to Thursday at the same place and hour should not silently lose its venue because
       * an operator did not retype it.
       *
       * The status is deliberately untouched.
       */
      case 'rescheduled': {
        rescheduledAt = e.occurredAt;
        rescheduleReason = e.payload.reason;
        rescheduleCount += 1;
        details = {
          ...(details ?? {}),
          date: e.payload.date,
          ...(e.payload.time === undefined ? {} : { time: e.payload.time }),
          ...(e.payload.venue === undefined ? {} : { venue: e.payload.venue }),
        };
        break;
      }

      /** Let it clear with the day. Not a resolution — see the payload, and `IncidentState`. */
      case 'hold_ended': {
        holdEndedAt = e.occurredAt;
        holdEndedBy = actorOf(e);
        holdEndReason = e.payload.reason;
        heldOverAt = null;
        heldOverBy = null;
        holdReason = null;
        break;
      }

      case 'reopened': {
        reopenCount += 1;
        closureNotes = null;
        resolution = null;
        status = 'responding';
        break;
      }

      case 'notified': {
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: e.payload.seatId,
          ...(e.payload.departmentId === undefined ? {} : { departmentId: e.payload.departmentId }),
          ...(e.payload.personId === undefined ? {} : { personId: e.payload.personId }),
          channel: e.payload.channel,
          reason: e.payload.reason,
          attemptedAt: e.occurredAt,
          state: 'pending',
        });
        break;
      }

      /**
       * The text, attached to the attempt it was sent for — 2026-08-23.
       *
       * ## It never creates an attempt, and that is the whole of this case
       *
       * `notified` is appended before the send and is what puts the obligation in the ledger;
       * this only fills in what was said. An event for an attempt this fold never saw is
       * **dropped**, which is the opposite of what `notification_delivered` does one case below
       * — and the difference is deliberate. A delivery for an unknown attempt is still evidence
       * that something reached somebody, so discarding it would make the ledger disagree with
       * the log. A *message text* for an unknown attempt is evidence of nothing: inventing an
       * attempt from it would put an obligation on the board that no `notified` event created,
       * with no addressee and no reason, which INV-03 counts as an unmet duty for ever.
       *
       * It also never changes `state`. Meta accepting a message is not delivery (ADR-0014), and
       * a fold that settled an attempt because the text was recorded would tell the control room
       * an officer knows about an emergency on the strength of an HTTP 200.
       */
      /**
       * Kept in the order they happened, all of them.
       *
       * Not reduced to *the latest* here: a district that chased a handset three times and failed
       * every time has a roster problem, and a fold that kept only the last one would leave the
       * board unable to say so. What a screen shows is the screen's decision; what the state
       * carries is what happened.
       *
       * `delivered` defaults to **true** when absent, because the only events without the field
       * predate it and were all successful sends. Defaulting the other way would invent failures
       * in the record, which is the direction INV-03 must never be wrong in.
       */
      case 'followed_up': {
        followUps.push({
          at: e.occurredAt,
          note: e.payload.note,
          delivered: e.payload.delivered !== false,
        });
        break;
      }

      case 'message_sent': {
        const attempt = notifications.get(e.payload.attemptId);
        if (attempt !== undefined) {
          notifications.set(e.payload.attemptId, {
            ...attempt,
            sent: { what: e.payload.what, where: e.payload.where },
          });
        }
        break;
      }

      case 'notification_delivered': {
        const attempt = notifications.get(e.payload.attemptId);
        // An outcome for an attempt we never saw is not discarded — it is still evidence
        // that something was delivered, and dropping it would make the ledger disagree with
        // the log it is folded from.
        //
        // The addressee is taken from the attempt when there is one. An outcome event carries
        // enough to be found by its own id; the attempt is what recorded *who was owed this*,
        // and preferring the outcome's copy would let a settling event silently retarget the
        // obligation it settles — which is precisely how `targetKey` stops matching and the
        // same obligation gets attempted a second time on the next pass (INV-08).
        const personId = attempt?.personId ?? e.payload.personId;
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: attempt?.seatId ?? e.payload.seatId,
          ...(attempt?.departmentId === undefined ? {} : { departmentId: attempt.departmentId }),
          ...(personId === undefined ? {} : { personId }),
          channel: e.payload.channel,
          reason: attempt?.reason ?? 'unknown',
          attemptedAt: attempt?.attemptedAt ?? e.occurredAt,
          // Carried through from the attempt, or `message_sent` — which almost always lands
          // before this — is undone the moment delivery is confirmed. A control room reading
          // "what was sent is not recorded" on an incident from this afternoon was exactly this:
          // the words were on the log and this case was the one erasing them from the fold.
          ...(attempt?.sent === undefined ? {} : { sent: attempt.sent }),
          state: 'delivered',
          ...(e.payload.via === undefined ? {} : { via: e.payload.via }),
          ...(e.payload.said === undefined ? {} : { said: e.payload.said }),
          settledAt: e.occurredAt,
        });
        break;
      }

      case 'notification_failed': {
        const attempt = notifications.get(e.payload.attemptId);
        const personId = attempt?.personId ?? e.payload.personId;
        notifications.set(e.payload.attemptId, {
          attemptId: e.payload.attemptId,
          seatId: attempt?.seatId ?? e.payload.seatId,
          ...(attempt?.departmentId === undefined ? {} : { departmentId: attempt.departmentId }),
          ...(personId === undefined ? {} : { personId }),
          channel: e.payload.channel,
          reason: attempt?.reason ?? 'unknown',
          attemptedAt: attempt?.attemptedAt ?? e.occurredAt,
          // Same carry-through as `notification_delivered`, and for the same reason: a failure
          // settling the attempt must not cost the record the words that were actually sent.
          ...(attempt?.sent === undefined ? {} : { sent: attempt.sent }),
          state: 'failed',
          failure: e.payload.failure,
          ...(e.payload.retryable === true ? { retryable: true } : {}),
          ...(e.payload.via === undefined ? {} : { via: e.payload.via }),
          settledAt: e.occurredAt,
        });
        break;
      }

      case 'late_arrival_flagged':
        // Recorded for audit; no effect on incident state.
        break;
    }
  }

  return {
    incidentId,
    status,
    correctedAt,
    correctedBy,
    withdrawnAt,
    withdrawnBy,
    withdrawalReason,
    heldOverAt,
    heldOverBy,
    holdReason,
    holdEndedAt,
    holdEndedBy,
    holdEndReason,
    correctionReason,
    correction,
    severity,
    category,
    responsibleDepartmentIds,
    routingAttemptedAt,
    // ADR-0030 — nobody TOLD, not no department. See the field's own note above.
    unassigned: dispatchedTo.size === 0 && status !== 'resolved' && status !== 'closed',
    reassignedFrom,
    reportIds,
    dispatchedTo: [...dispatchedTo.values()],
    followUps,
    dispatchAbsorbed: [...dispatchAbsorbed.values()],
    dispatchedAt,
    contactsOpened,
    kind: kind ?? 'emergency',
    importance: importance ?? 'routine',
    details,
    location,
    asksAttendance: asksAttendance ?? false,
    rescheduledAt,
    rescheduleReason,
    rescheduleCount,
    acknowledgedAt,
    acknowledgedBySeatId,
    acknowledgedByPersonId,
    acknowledgedVia,
    acknowledgedSaid,
    escalationCount,
    currentEscalationSeatId,
    assignedResourceIds,
    actions,
    notifications: [...notifications.values()],
    mergedIncidentIds,
    resolution,
    closureNotes,
    reopenCount,
    occurredAt,
    arrivedAt,
    lastRecordedAt,
    eventCount: ordered.length,
  };
}

/**
 * The district's live picture: the worst thing anyone assessed, and how much nobody has
 * looked at yet.
 *
 * Unacknowledged criticals are the thing that must never be lost in a summary (INV-04), and
 * an unassessed report is the thing that must never be *made to look* assessed (ADR-0009).
 * Both are returned; neither is folded into the other.
 *
 * **General communications are not in this picture at all — M11-01.**
 *
 * A meeting notice carries a severity only because intake asks every report for one. Nobody
 * assessed it and there is nothing about a meeting for a severity to describe, so counting it
 * let a coordination meeting set the district's `worst assessed` — read on a wall at four
 * metres as *the worst thing happening in Bajaur right now*. M9-11 removed that severity from
 * the **row**, where a notice now shows its kind instead; the value the screen had stopped
 * printing was still the value this function was ranking.
 *
 * **Dropped rather than counted as `unassessed`**, and the distinction is ADR-0009's own.
 * `unassessed` is a number somebody acts on — *these need looking at* — and a notice is not
 * waiting for anybody. Folding it in there would trade one wrong figure for another and send
 * an operator hunting an emergency that does not exist.
 *
 * The test is `isGeneral`, which lives beside `CARRIES_SLA` in `events.ts` — deliberately the
 * same list `overdue` already reads in `board.ts`, so *which kinds are emergencies* cannot come
 * to have two answers in two files.
 *
 * ⚠️ **An emergency carrying NO severity at all is `unassessed`, not absent — M11-06.**
 *
 * `severity` is `null` until some event sets one, and this function used to `.filter()` those
 * out entirely — so an emergency **nobody had assessed at all** was missing from the very number
 * that exists to count them, while `toRow` gave the same incident `severity: 'unknown'` and its
 * own row printed the word **unassessed**. One incident, described two ways, on one screen.
 *
 * It reads as unreachable and is not: `POST /incidents` cannot refuse (INV-01) and
 * `assumptions.ts` supplies a severity there, but `/sync` appends a `reported` event with
 * whatever a handset captured, and the fold only records a severity `if` the payload carried
 * one. The gap is therefore exactly on the offline path — the reports that arrive latest, from
 * the places with least signal.
 *
 * `?? 'unknown'` is the whole fix, and it is the honest direction: ADR-0009 says this number
 * means *somebody must look at these*, and an emergency with no severity is the one most in
 * need of a look. `worstSeverity` then counts it, because `isAssessed('unknown')` is false —
 * the rule stays in the one place that already held it.
 */
export function districtSeverity(states: readonly IncidentState[]): SeveritySummary {
  return worstSeverity(
    states
      .filter((s) => s.status !== 'closed' && s.status !== 'resolved')
      .filter((s) => !isGeneral(s.kind))
      .map((s) => s.severity?.value ?? 'unknown'),
  );
}

export { EMPTY_ACTOR };
