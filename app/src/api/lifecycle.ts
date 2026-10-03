/**
 * The incident lifecycle as commands: triage, route, acknowledge, act, reassign, override,
 * resolve, close. M0-24…28, 30, 31.
 *
 * Until now this logic existed and was proven, and was reachable only by a client appending
 * raw events through `/sync`. That is fine for a device replaying what it captured offline —
 * it is not fine for an operator action, because a raw append trusts the caller to have
 * checked their own authority. This module is the gate `domain/authority.ts` describes:
 * the policy table decides, and every command passes through it (INV-05).
 *
 * Three properties hold for every command here:
 *
 * 1. **Nothing mutates.** A command appends one event. There is no update path, here or in
 *    the store beneath it (ADR-0001).
 * 2. **The actor is stamped from the session**, never read from the body — the same rule
 *    `/sync` follows, for the same reason: the audit trail is the record, and a record that
 *    can be told who to name is not one.
 * 3. **The decision is data.** No command compares a role. It builds a `WriteAttempt` and
 *    asks the policy table, so adding a department stays rows rather than a release.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import {
  defaultRules,
  evaluateRead,
  evaluateWrite,
  type Decision,
  type Seat,
} from '../domain/authority.js';
import {
  CARRIES_SLA,
  MESSAGE_KINDS,
  isGeneral,
  type CommunicationDetails,
  type MessageKind,
  SEVERITY_ORDER,
  type AssessedSeverity,
  type IncidentEvent,
  type Uuid,
} from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { departmentDirectory } from '../ops/directory.js';
import { stageOf, type Stage } from '../domain/stages.js';
import { ownershipOf } from '../domain/ownership.js';
import { attendanceFor } from '../domain/attendance.js';
import { groupsFromEvents } from '../domain/recipientGroups.js';
import { attendanceClosesAt } from '../domain/meetings.js';
import { checkEscalation, targetsFor } from '../domain/sla.js';
import { loadSlaConfiguration } from '../db/configStore.js';
import { formatReference } from '../domain/reference.js';
import { referenceFor } from '../db/referenceStore.js';
import type { Identity } from '../auth/sessions.js';

/**
 * What intake fills in when a caller did not say.
 *
 * Defined in `domain/assumptions.ts` and re-exported here, because routing must also know
 * what a placeholder looks like in order to refuse to route on one, and a domain module
 * importing from the API layer would be the wrong way round.
 */
import { ASSUMED_CATEGORY, ASSUMED_SEVERITY } from '../domain/assumptions.js';

export { ASSUMED_CATEGORY, ASSUMED_SEVERITY };

export type CommandKind =
  | 'triage'
  | 'route'
  | 'acknowledge'
  | 'log_action'
  | 'reassign'
  | 'override'
  | 'resolve'
  | 'close'
  | 'correct'
  | 'withdraw'
  | 'restore'
  | 'hold'
  | 'release'
  | 'reschedule';

export type Command =
  | {
      readonly kind: 'triage';
      readonly severity: AssessedSeverity;
      readonly category: string;
      readonly reason?: string;
    }
  /**
   * Give an incident to one or more departments, explicitly.
   *
   * ⚠️ **`reason` stays required, and this was reconsidered when routing was removed.** The
   * argument for dropping it was that assignment had become the control room's ordinary job
   * rather than an override of the configuration — and it was wrong on the facts: **the
   * ordinary path does not come through here at all.** Choosing who to tell already routes an
   * unheld incident by itself (`api/dispatch.ts`), naming the operator and supplying its own
   * reason, so nobody types a sentence forty times a day.
   *
   * What is left on this command is the deliberate act — an operator opening an incident and
   * assigning it on purpose — and `incident.responsibleDepartment` is owned by nobody in
   * `defaultRules`, so every one of them is an override by a district seat. ADR-0003 requires
   * a reason for exactly that, and removing it here would have quietly hollowed out an
   * invariant to save a keystroke nobody was pressing.
   */
  | { readonly kind: 'route'; readonly departmentIds: readonly Uuid[]; readonly reason: string }
  | { readonly kind: 'acknowledge'; readonly reason?: string }
  | {
      readonly kind: 'log_action';
      readonly note: string;
      /**
       * When it actually happened, if not now.
       *
       * An operator logs "on scene" ten minutes after arriving, and a crew back from a call
       * writes up an hour of work at once. Recording all of it as happening at the moment
       * somebody typed would put a lie in the one record a post-incident report is folded
       * from — and it is the same lie ADR-0002 already refuses for a report captured
       * offline. A stated time in the future is ignored rather than trusted.
       */
      readonly occurredAt?: string;
    }
  | { readonly kind: 'reassign'; readonly departmentIds: readonly Uuid[]; readonly reason: string }
  | {
      readonly kind: 'override';
      readonly field: 'severity' | 'category';
      readonly value: string;
      readonly reason: string;
    }
  /**
   * `reason` on resolve and close is **not decoration** — without it the control room could
   * not close anything at all (found 2026-08-06, M7-05).
   *
   * `incident.closure` is owned by the responsible department and requires a reason from
   * anybody overriding it. The control room is district tier, so it is always overriding — and
   * `parseCommand` accepted no reason for these two, so `evaluateWrite` refused every one of
   * them with *"requires a reason to override"*. Nothing caught it because every test that
   * closed an incident did so as the **owning department's** seat, which is an audience
   * ADR-0018 has just removed. The district would have discovered it the first time an
   * operator tried to close a resolved emergency, on the only screen they have.
   *
   * Optional, because an owning department still needs none: they are closing their own work.
   */
  | { readonly kind: 'resolve'; readonly outcome: string; readonly reason?: string }
  | { readonly kind: 'close'; readonly notes: string; readonly reason?: string }
  /**
   * **What we sent was wrong** — M9-52.
   *
   * `reason` is required and `correction` is not. *"Ignore this, we will confirm the venue
   * later"* is a real and honest thing to record, and demanding a replacement would produce
   * invented ones.
   */
  | { readonly kind: 'correct'; readonly reason: string; readonly correction?: string }
  /**
   * Take it off the board — M10-11. `reason` is required and there is no optional half:
   * *"why is this not worth the control room's attention"* is the entire content of the record.
   */
  | { readonly kind: 'withdraw'; readonly reason: string }
  /** Put it back — M10-18. No reason; see the `restored` payload for why. */
  | { readonly kind: 'restore' }
  /**
   * **Keep this one on the wall past midnight** — the district's five, 2026-08-22.
   *
   * `reason` required on **both** directions, unlike `restore` which asks for none. Restoring
   * undoes a removal and carries its own justification; these two do not undo anything — each
   * changes what a control room looks at for days, and the sentence is the whole content of
   * that decision.
   */
  | { readonly kind: 'hold'; readonly reason: string }
  /**
   * Let it clear with the day. ⚠️ **Not a resolution**, and no screen may offer it as one — it
   * says the room stopped watching this on that panel, not that the flood is over.
   */
  | { readonly kind: 'release'; readonly reason: string }
  /**
   * **The meeting moved. It has NOT finished** — the district's five, 2026-08-22.
   *
   * 🔴 **Never offered beside *Conducted* and *Cancelled* as a third way to close one.**
   * Those two resolve; this one changes a date and leaves the meeting on the dashboard, which
   * is what the district asked for.
   *
   * `date` is required and the rest is not, on `requiredFieldsFor`'s own reasoning: a meeting
   * whose room is not decided yet is a real meeting, and refusing it sends the district back to
   * a personal handset.
   */
  | {
      readonly kind: 'reschedule';
      readonly date: string;
      readonly time?: string;
      readonly venue?: string;
      readonly reason: string;
    };

export type CommandResult =
  | { readonly ok: true; readonly event: IncidentEvent; readonly state: IncidentState }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): CommandResult {
  return { ok: false, status, error };
}

/**
 * The seat the caller acts as.
 *
 * Authority used to come from the seat and nothing else (ADR-0004), so an account holding no
 * `duty_assignment` could do nothing — the correct amount **while every account was an
 * officer's**. That stopped being true:
 *
 * - **ADR-0018 / ADR-0024** — the only accounts that sign in are the control room's. There are
 *   no department officers with logins, so there is no "officer between postings" to refuse.
 * - **ADR-0030 / ADR-0031** — departments are gone. `evaluateRead` has one non-empty scope
 *   left, *the district*, reached by a `district`-tier seat; every other seat reads nothing.
 *   The M5 leak this null once guarded against needed departments to leak between.
 * - **ADR-0032** — an account minted through Settings → Accounts carries a `role`
 *   (`owner` · `admin` · `operator` · `viewer`) and **no seat**. It is a control-room account,
 *   and requiring somebody to also pin it to a roster post before it can see the board was the
 *   seat model outliving the decision that removed it.
 *
 * So a caller with no seat acts as a **district-tier control-room seat**. `identity.personId`
 * stands in for `seatId` in the authority decision; nothing that resolves a real seat row is
 * reached this way, and every event still records `actorPersonId` as the true attribution.
 * A real seat, when the caller holds one, still wins.
 */
export function seatOf(identity: Identity): Seat {
  if (identity.seatId !== null && identity.tier !== null) {
    return {
      seatId: identity.seatId,
      tier: identity.tier,
      canBreakGlass: identity.canBreakGlass,
    };
  }
  return {
    seatId: identity.personId,
    tier: 'district',
    canBreakGlass: identity.canBreakGlass,
  };
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The known detail fields, and how much of each is kept — M9-07.
 *
 * An allow-list rather than "copy whatever arrived", for the same reason `ops/evidence.ts` uses
 * one: this object goes straight into an append-only payload that can never be edited afterwards,
 * so anything a client invents is in the district's record for ever. `note` is generous because
 * it is where an operator writes the thing that actually matters; the rest are short because a
 * date is a date.
 */
const DETAIL_LIMITS: Readonly<Record<keyof CommunicationDetails, number>> = {
  subject: 200,
  date: 20,
  time: 20,
  venue: 200,
  untilDate: 20,
  // A date, or `carrying.ts`'s UNTIL_FURTHER_NOTICE. Short for the same reason the rest are.
  reviewBy: 20,
  note: 2000,
};

/**
 * Keep the detail fields that arrived, drop everything else, and omit the field entirely when
 * nothing survives.
 *
 * Returns a spreadable object so the call site reads as one line and cannot accidentally write
 * `details: undefined` into a payload — a key whose value is `undefined` survives `JSON.stringify`
 * as an absent key here but not everywhere, and the log is not a place to rely on that.
 */
function cleanDetails(input: unknown): { details?: CommunicationDetails } {
  if (typeof input !== 'object' || input === null) return {};

  const out: Record<string, string> = {};
  for (const [field, limit] of Object.entries(DETAIL_LIMITS)) {
    const value = (input as Record<string, unknown>)[field];
    if (isNonEmpty(value)) out[field] = value.trim().slice(0, limit);
  }

  return Object.keys(out).length === 0 ? {} : { details: out as CommunicationDetails };
}

/**
 * An **assessed** severity, which is the only kind a command may set.
 *
 * `unknown` is deliberately not accepted here (ADR-0009). Triage is the act of assessing;
 * revising an assessment to "no assessment" is not a thing an operator does, and letting a
 * command write it would put the one value only intake may produce back into play.
 */
export function isSeverity(v: unknown): v is AssessedSeverity {
  return typeof v === 'string' && (SEVERITY_ORDER as readonly string[]).includes(v);
}

/**
 * Which policy rows govern which command.
 *
 * In one place, so the mapping can be read and tested rather than discovered by reading
 * eight handlers. A command lists every field it touches: `triage` writes severity *and*
 * category, so it needs authority over both, while an override names the one field it is
 * changing and must not require authority over the other.
 */
export function governedFields(command: Command): readonly string[] {
  switch (command.kind) {
    case 'triage':
      return ['incident.severity', 'incident.category'];
    case 'route':
    case 'reassign':
      return ['incident.responsibleDepartment'];
    case 'acknowledge':
      return ['incident.acknowledgement'];
    case 'log_action':
      return ['incident.actions'];
    case 'override':
      return [`incident.${command.field}`];
    case 'resolve':
    case 'close':
      return ['incident.closure'];
    /**
     * Governed by `incident.actions`, not by closure.
     *
     * Correcting is **append-only** — it adds a fact and removes nothing — and that is exactly
     * what the actions rule already describes. Putting it under closure would demand a reason
     * to override from the control room on every correction of their own message, and would
     * imply that correcting something ends it. It does not: an emergency whose category was
     * wrong is still running.
     */
    case 'correct':
      return ['incident.correction'];

    case 'withdraw':
      return ['incident.withdrawal'];

    // Its own row, and only because of `reasonRequired` — see the table's own comment.
    case 'restore':
      return ['incident.restoration'];

    /**
     * One row for both directions, and here that is right where `withdraw`/`restore` needed two.
     *
     * The split there existed only because restoring demands no reason and an overrider with no
     * reason is refused. Both of these carry one, so both evaluate identically — and they are
     * genuinely the same authority: whoever may decide a flood stays on the wall is whoever may
     * decide it comes off.
     */
    case 'hold':
    case 'release':
      return ['incident.carrying'];

    /**
     * Its own row, and deliberately not `incident.closure`.
     *
     * Closure is *this is over*; a reschedule is the opposite claim about the same meeting, and
     * governing them together would mean the authority to END something and the authority to
     * say it is STILL HAPPENING could never be given apart. It is also not
     * `incident.correction`: that answers *is what we said still true*, and what was sent was
     * true when it was sent.
     */
    case 'reschedule':
      return ['incident.schedule'];
  }
}

function reasonOf(command: Command): string | undefined {
  return 'reason' in command && isNonEmpty(command.reason) ? command.reason : undefined;
}

/**
 * Ask the policy table about every field a command touches.
 *
 * All of them must permit it. A triage that may set category but not severity is not a
 * triage half-allowed — it is refused, because a partially applied command would leave the
 * operator believing something happened that did not.
 */
function authorise(command: Command, seat: Seat, state: IncidentState): Decision {
  const rules = defaultRules(state.responsibleDepartmentIds[0] ?? null);
  const reason = reasonOf(command);

  let best: Decision = { allowed: true, as: 'owner' };

  for (const fieldKey of governedFields(command)) {
    const rule = rules.find((r) => r.fieldKey === fieldKey);
    if (rule === undefined) {
      // A command naming a field with no rule must fail closed. An unknown field is not an
      // unrestricted one.
      return { allowed: false, why: `no authority rule governs ${fieldKey}` };
    }

    const decision = evaluateWrite(rule, { fieldKey, seat, reason });
    if (!decision.allowed) return decision;
    if (decision.as === 'override' && best.allowed) best = decision;
  }

  return best;
}

/**
 * Refuse commands that cannot mean anything in the incident's current state.
 *
 * These are not authority checks — an operator with every permission still cannot
 * acknowledge an incident that was never routed anywhere. Each returns the state the caller
 * is actually in, because "cannot acknowledge" without saying why sends them to the phone.
 */
function checkPrecondition(command: Command, state: IncidentState): string | null {
  /**
   * A closed incident takes no further changes — with two exceptions, and the second is new.
   *
   * `log_action` was always allowed: the account of what happened keeps being written after the
   * work stops. `correct` joins it for a stronger reason — **the mistakes worth correcting are
   * usually noticed afterwards.** The notice went out with last week's date and somebody rings
   * at nine the next morning. A rule that refused would push the district back to correcting
   * things verbally, which is the record not existing.
   */
  if (
    state.status === 'closed' &&
    command.kind !== 'log_action' &&
    command.kind !== 'correct' &&
    // A closed incident can still be the wrong one to have on the board, and the withdrawal
    // is usually noticed the next morning — the same reasoning `correct` is exempted for.
    command.kind !== 'withdraw' &&
    command.kind !== 'restore' &&
    // A closed incident that is still on the panel is exactly the row somebody needs to be able
    // to take off it, and a reopened one may need holding again.
    command.kind !== 'hold' &&
    command.kind !== 'release'
  ) {
    return 'incident is closed; reopen it before making further changes';
  }

  switch (command.kind) {
    case 'route':
      return state.responsibleDepartmentIds.length > 0
        ? 'incident is already routed; use reassign, which records a reason and notifies the ' +
            'department losing it'
        : null;

    case 'reassign':
      return state.responsibleDepartmentIds.length === 0
        ? 'incident has never been routed; use route'
        : null;

    case 'acknowledge':
      /**
       * 🔴 **THIS REFUSED EVERY ACKNOWLEDGEMENT IN THE DISTRICT — ADR-0030.**
       *
       * It required a responsible department, on the sound reasoning that acknowledging is a
       * department saying *we have this*, and there is nothing to say it about until somebody
       * has been given it. Migration 0039 dropped the departments, so
       * `responsibleDepartmentIds` is empty on every incident for ever and the control room's
       * own **Acknowledge** button answered *"there is nothing to acknowledge"* on all of
       * them — on the act the entire product exists to record, with the SLA clock still
       * running behind the refusal.
       *
       * The question the guard was really asking is **has anybody been given this yet**, and
       * the answer is now the one the district acts on: has anybody been told. Same shape as
       * `state.unassigned`, and the same reason — a dispatch is what places an emergency with
       * somebody now.
       *
       * ⚠️ **The refusal is kept rather than dropped.** An acknowledgement of an emergency
       * nobody has been told about is somebody claiming an emergency that was never handed to
       * them, and it would stop the clock on it.
       */
      if (state.dispatchedTo.length === 0) {
        return 'nobody has been told about this yet; there is nothing to acknowledge';
      }
      if (state.acknowledgedAt !== null) {
        return `already acknowledged at ${state.acknowledgedAt}`;
      }
      if (state.status === 'resolved') return 'incident is already resolved';
      return null;

    case 'close':
      // Closing straight past resolution is how incidents get closed blank, and closure
      // completeness is one of the metrics this system exists to be honest about. The
      // outcome has to be recorded before the incident stops being live.
      return state.status === 'resolved' ? null : 'resolve the incident before closing it';

    case 'resolve':
      return state.status === 'resolved' ? 'incident is already resolved' : null;

    /**
     * Correctable at any point, including after closure, and **especially** then.
     *
     * The mistakes worth correcting are usually noticed afterwards — the meeting notice went
     * out with last week's date and somebody rings at nine the next morning. A rule that
     * refused once an incident was closed would push the district back to correcting things
     * verbally, which is the record not existing.
     *
     * Twice is allowed too: the first correction says "ignore this", the second says what is
     * true instead. Both stay in the log; the fold shows the latest.
     */
    /**
     * `withdraw` and `restore` join it, and neither moves the status — the whole of M10-12.
     * Nobody resolved anything by taking a row off a screen, and an emergency does not stop
     * having happened because one stopped showing it.
     */
    /**
     * `hold` and `release` join them, and for the third time the reason is the same: neither
     * moves the status. Deciding to keep watching a flood resolves nothing, and deciding to stop
     * watching it on one panel resolves nothing either — which is the single most important
     * thing about this whole feature and is written down in three places on purpose.
     */
    case 'correct':
    case 'withdraw':
    case 'restore':
    case 'hold':
    case 'release':
      return null;

    /**
     * **Only a meeting has a date to move, and only one that is still going to happen.**
     *
     * A resolved meeting is one somebody recorded as Conducted or Cancelled. Moving its date
     * would leave the record saying both, so it is refused **in words that name the way back**
     * — `reopened` exists for exactly this and the operator should be sent to it rather than
     * left guessing. `checkPrecondition`'s own rule: never *"cannot"* without *"because"*.
     */
    case 'reschedule':
      if (state.kind !== 'meeting') {
        return `only a meeting can be rescheduled; this is ${state.kind === 'emergency' ? 'an emergency' : `a ${state.kind}`}`;
      }
      if (state.status === 'resolved') {
        return 'this meeting is already recorded as finished; reopen it before giving it a new date';
      }
      return null;

    default:
      return null;
  }
}

/** Turn a validated command into the single event that records it. */
function eventFor(
  command: Command,
  incidentId: Uuid,
  identity: Identity,
  now: string,
  clientSeq: number,
  state: IncidentState,
): IncidentEvent {
  // `recordedAt` is always now and is never the caller's to state — it is when the server
  // learned of it, and a client that could set it could rewrite how long the district took.
  // `occurredAt` may be earlier when the actor says so, which is the whole point of keeping
  // the two apart (ADR-0002).
  const stated =
    command.kind === 'log_action' && isNonEmpty(command.occurredAt) ? command.occurredAt : null;
  const occurredAt = stated !== null && stated <= now ? stated : now;

  const envelope = {
    eventId: randomUUID(),
    incidentId,
    occurredAt,
    recordedAt: now,
    clientSeq,
    // Stamped from the session. Whatever the body claimed is not consulted.
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web' as const,
  };

  switch (command.kind) {
    case 'triage':
      return {
        ...envelope,
        type: 'triaged',
        payload: {
          severity: command.severity,
          category: command.category,
          ...(isNonEmpty(command.reason) ? { reason: command.reason } : {}),
        },
      } as IncidentEvent;

    case 'route':
      return {
        ...envelope,
        type: 'routed',
        payload: {
          departmentIds: command.departmentIds,
          ruleId: 'manual',
          reason: command.reason,
        },
      } as IncidentEvent;

    case 'acknowledge':
      return {
        ...envelope,
        type: 'acknowledged',
        // The seat is the session's, not the body's. Acknowledging on someone else's behalf
        // is a thing the record must not be able to be told.
        payload: { seatId: identity.seatId },
      } as IncidentEvent;

    case 'log_action':
      return {
        ...envelope,
        type: 'action_logged',
        payload: { note: command.note },
      } as IncidentEvent;

    case 'reassign':
      return {
        ...envelope,
        type: 'reassigned',
        payload: {
          // Who is losing it, recorded at the moment it happens. An earlier version wrote
          // an empty array here, which made the event unable to answer half of what a
          // handover is — and the department being handed *from* is the one that has to be
          // told it is no longer going.
          fromDepartmentIds: state.responsibleDepartmentIds,
          toDepartmentIds: command.departmentIds,
          reason: command.reason,
        },
      } as IncidentEvent;

    case 'override':
      return {
        ...envelope,
        type: 'overridden',
        payload: { field: command.field, value: command.value, reason: command.reason },
      } as IncidentEvent;

    case 'resolve':
      return {
        ...envelope,
        type: 'resolved',
        payload: { outcome: command.outcome },
      } as IncidentEvent;

    case 'close':
      return {
        ...envelope,
        type: 'closed',
        payload: { notes: command.notes },
      } as IncidentEvent;

    case 'correct':
      return {
        ...envelope,
        type: 'corrected',
        payload: {
          reason: command.reason,
          // Spread rather than `correction: command.correction`, because
          // `exactOptionalPropertyTypes` distinguishes an absent field from an explicit
          // undefined — and an explicit undefined would land in the JSONB payload as null,
          // which reads as "they said there is no replacement" rather than "they did not say".
          ...(command.correction === undefined ? {} : { correction: command.correction }),
        },
      } as IncidentEvent;

    case 'withdraw':
      return {
        ...envelope,
        type: 'withdrawn',
        payload: { reason: command.reason },
      } as IncidentEvent;

    case 'restore':
      return { ...envelope, type: 'restored', payload: {} } as IncidentEvent;

    case 'hold':
      return {
        ...envelope,
        type: 'held_over',
        payload: { reason: command.reason },
      } as IncidentEvent;

    case 'release':
      return {
        ...envelope,
        type: 'hold_ended',
        payload: { reason: command.reason },
      } as IncidentEvent;

    case 'reschedule':
      return {
        ...envelope,
        type: 'rescheduled',
        payload: {
          date: command.date,
          // Spread rather than an explicit undefined — `exactOptionalPropertyTypes`, and an
          // explicit undefined lands in the JSONB payload as null, which reads as *"they said
          // there is no venue"* rather than *"they did not say"*. `corrected` already argues this.
          ...(command.time === undefined ? {} : { time: command.time }),
          ...(command.venue === undefined ? {} : { venue: command.venue }),
          reason: command.reason,
        },
      } as IncidentEvent;
  }
}

export interface ApplyOptions {
  readonly now?: string;
}

/**
 * Run one command against one incident.
 *
 * Order is deliberate: exist, then may-you-see-it, then does-it-make-sense, then
 * may-you-do-it. A caller with no authority over an incident learns that it exists and
 * nothing else, and a caller who cannot even read it learns nothing at all — an authority
 * check that answers "no, and here is what you were refused" is a disclosure.
 */
export async function applyCommand(
  pool: Pool,
  incidentId: Uuid,
  command: Command,
  identity: Identity,
  options: ApplyOptions = {},
): Promise<CommandResult> {
  const seat = seatOf(identity);

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  const precondition = checkPrecondition(command, state);
  if (precondition !== null) return refuse(409, precondition);

  const decision = authorise(command, seat, state);
  if (!decision.allowed) return refuse(403, decision.why);

  const now = options.now ?? new Date().toISOString();

  // `eventCount + 1` follows the escalation job's convention for server-issued events.
  // Ordering does not actually rest on it here — a command's `occurredAt` is server time
  // and strictly later than everything already stored — but a consistent sequence keeps
  // the comparator's tie-breaks meaningful when a server event and an offline batch land
  // in the same millisecond (ADR-0008).
  const event = eventFor(command, incidentId, identity, now, state.eventCount + 1, state);

  await append(pool, [event]);

  return { ok: true, event, state: foldIncident(incidentId, [...events, event]) };
}

export interface IntakeInput {
  readonly category?: unknown;
  readonly severity?: unknown;
  readonly occurredAt?: unknown;
  readonly placeId?: unknown;
  readonly description?: unknown;
  /** `emergency` (the default), `alert`, `advisory` or `order` — M7-23. */
  readonly kind?: unknown;
  /** `important` (the default) or `routine` — M10-20/22/41. Ignored on General kinds. */
  readonly importance?: unknown;
  /** Structured detail for a General communication (M9-07). Sanitised by `cleanDetails`. */
  readonly details?: unknown;
  /**
   * Ask who is coming, on an Information notice — the district's five, 2026-08-22.
   *
   * Read for `other` and for nothing else. `unknown` like everything else here: the strictness
   * is at the envelope, and the payload is permissive by design (`protocol.ts`).
   */
  readonly asksAttendance?: unknown;
}

export interface IntakeResult {
  readonly incidentId: Uuid;
  readonly reportId: Uuid;
  readonly event: IncidentEvent;
  /** Fields the server supplied because the caller did not. Never silently filled. */
  readonly assumed: readonly string[];
  /**
   * Departments holding this incident. **Always empty since ADR-0022.**
   *
   * Kept in the shape rather than removed, because handsets cache the shell and an older one
   * still reads these three fields. A response that dropped them would break a client the
   * district cannot be asked to reinstall on a night when it matters.
   */
  readonly routedTo: readonly Uuid[];
  /** Nobody holds this yet. Always true at intake — the control room assigns (ADR-0022). */
  readonly unassigned: boolean;
  /** Plain language, for the reporter's confirmation screen and for the audit trail. */
  readonly routingReason: string;
}

/**
 * Take a report. **This endpoint does not refuse** (M0-24, INV-01).
 *
 * Every other endpoint in this file can say no. This one cannot, because the thing on the
 * other end of it is someone telling us an emergency is happening, and a validation error
 * returned to a caller under stress is an emergency the system chose to lose. Missing
 * fields are filled with a stated assumption and recorded as assumed; unusable values are
 * replaced rather than rejected.
 *
 * The one thing it will not do is invent an `occurredAt` in the future — a clock skewed
 * forward would push the SLA deadline out and quietly buy the incident extra time before
 * it escalates.
 */
export async function intake(
  pool: Pool,
  input: IntakeInput,
  identity: Identity,
  options: ApplyOptions = {},
): Promise<IntakeResult> {
  const now = options.now ?? new Date().toISOString();
  const assumed: string[] = [];

  let category = ASSUMED_CATEGORY;
  if (isNonEmpty(input.category)) {
    category = input.category.trim();
  } else {
    assumed.push('category');
  }

  let severity = ASSUMED_SEVERITY;
  if (isSeverity(input.severity)) {
    severity = input.severity;
  } else {
    assumed.push('severity');
  }

  let occurredAt = now;
  if (typeof input.occurredAt === 'string' && Number.isFinite(Date.parse(input.occurredAt))) {
    const stated = new Date(input.occurredAt).toISOString();
    if (stated <= now) occurredAt = stated;
    else assumed.push('occurredAt');
  } else if (input.occurredAt !== undefined) {
    assumed.push('occurredAt');
  }

  const incidentId = randomUUID();
  const reportId = randomUUID();

  // Computed once and reused below by both `kind` and `importance` — the second needs to know
  // whether this is a General communication, and `kind`'s own field logic already has to work
  // this out.
  const kind =
    typeof input.kind === 'string' && (MESSAGE_KINDS as readonly string[]).includes(input.kind)
      ? (input.kind as MessageKind)
      : 'emergency';

  const event = {
    eventId: randomUUID(),
    incidentId,
    type: 'reported',
    occurredAt,
    recordedAt: now,
    clientSeq: 1,
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web',
    payload: {
      reportId,
      category,
      severity,
      ...(typeof input.placeId === 'string' ? { placeId: input.placeId } : {}),
      ...(isNonEmpty(input.description) ? { description: input.description.trim() } : {}),
      /**
       * What kind of thing this is — M7-23.
       *
       * Omitted when it is an emergency, rather than written as `'emergency'`. The absent value
       * already means that, every event in the log already reads correctly, and a field that
       * appears on 95% of rows saying the default is a field somebody eventually starts
       * matching on instead of using the fold.
       *
       * **An unrecognised value is dropped, never refused** (INV-01). Intake cannot refuse: a
       * client sending `kind: "urgent"` has still recorded an emergency, and losing it to a
       * validation error would be the failure this endpoint exists to prevent.
       */
      ...(kind !== 'emergency' ? { kind } : {}),
      /**
       * Importance — M10-20/41. Written explicitly for anything that carries an SLA, defaulting
       * to `important` unless the operator chose `routine` on the compose form (M10-22).
       *
       * **This cannot be left to the same "absent means the default" convention `kind` uses
       * two lines up.** The fold's own absent-value reading is `routine` (M10-21, for events
       * recorded before this field existed) — the *opposite* of what a fresh emergency should
       * get. Omitting it here would silently invert M10-41. Omitted entirely for General
       * communications, where importance has no meaning (`isGeneral`).
       */
      ...(!isGeneral(kind)
        ? { importance: input.importance === 'routine' ? 'routine' : 'important' }
        : {}),
      /**
       * The structured detail a General communication carries — M9-07.
       *
       * **Sanitised, never refused**, on exactly the reasoning above it: a meeting typed into
       * this endpoint is a meeting somebody meant to announce, and losing it to a validation
       * error would be the same failure INV-01 names, for a smaller reason. An unknown field is
       * dropped; an over-long one is cut; an entirely empty object is omitted rather than stored,
       * because `{}` is a claim that somebody was asked and left every box blank.
       */
      ...cleanDetails(input.details),
      /**
       * **Ask who is coming, on a notice** — the district's five, 2026-08-22.
       *
       * Written only for `other`, and only when the caller said so. Absent means no, which is
       * what every notice sent before today was, so the fold's absent-value reading and this
       * agree — unlike `importance` two blocks up, which is why that one has to be written
       * explicitly and this one does not.
       *
       * ⚠️ Refused on every other kind rather than stored and ignored. A flag sitting on a
       * road accident is a field somebody eventually reads.
       */
      ...(kind === 'other' && input.asksAttendance === true ? { asksAttendance: true } : {}),
      // Which values came from the reporter and which from this function. A downstream
      // consumer can then tell an assessment from a placeholder, the same way location
      // capture records which layers actually produced a fix.
      ...(assumed.length > 0 ? { assumed } : {}),
    },
  } as unknown as IncidentEvent;

  await append(pool, [event]);

  /**
   * Nothing is assigned here — ADR-0022.
   *
   * Until then an automatic pass ran on this line, matched the report against the
   * administration's routing signals, and wrote a `routed` event before any human saw it. The
   * control room asked for that to stop: they assign, and a system that pre-decided it was
   * confusing them about work they were doing themselves anyway.
   *
   * So intake now ends where it should have all along — the report is stored, and the
   * district's answer to *who goes* is the district's to give. The reporter is told exactly
   * that rather than being left to infer it from an empty list (ADR-0005).
   */
  return {
    incidentId,
    reportId,
    event,
    assumed,
    routedTo: [],
    unassigned: true,
    routingReason: 'recorded — the control room assigns this',
  };
}

export interface ActorDirectory {
  /** personId → full name. */
  readonly people: Readonly<Record<string, string>>;
  /**
   * seatId → the post held, which is what authority actually attaches to (ADR-0004), plus its
   * current `holder` when it has one — so a `post` recipient on the "who was told" list reads
   * `Officer November — IT Soft`. `holder` is absent for a vacant post; provenance's `nameOf`
   * reads only `title`.
   */
  readonly seats: Readonly<
    Record<string, { readonly title: string; readonly tier: string; readonly holder?: string }>
  >;
  /**
   * personId → the post this officer holds now, for the ones that hold one — 2026-09-07.
   *
   * The "who was told" panel names a dispatched officer `Officer India — DDMA`
   * (`backlog/whatsapp-response-workflow.md` §6); this is the second half. Kept apart from
   * `people` because provenance leads with the seat and does not repeat it. An officer holding
   * no live post is simply absent here and is named alone.
   */
  readonly personSeats: Readonly<Record<string, string>>;
  /**
   * departmentId → name, for a department the control room **told** — 2026-08-24.
   *
   * ⚠️ **Not the same set as `responsibleDepartments`**, which is who *holds* this. A
   * department can be told about an emergency another department answers for, and the "who was
   * told" panel resolved exactly those against `responsibleDepartmentIds` — so it printed a
   * **uuid** for them. Optional, because a screen built against an older server must keep
   * rendering what it always did rather than throwing.
   */
  readonly departments?: Readonly<Record<string, string>>;
}

/**
 * Names for the ids an event carries.
 *
 * Without this, "who set this" is answered with a uuid, which is not an answer. The seat
 * matters more than the person — authority attaches to the post (ADR-0004) — so both are
 * returned and the screen leads with the seat.
 *
 * Resolved **as they are now**, which is a deliberate limitation worth stating: if an
 * officer has since been transferred, the event still names the person and seat recorded at
 * the time (that is in the log and cannot change), but the display name comes from today's
 * roster. Renaming a seat therefore retitles it throughout history. That is the right
 * trade for M0 — the alternative is denormalising names into every event — but it is a real
 * limitation, not an oversight.
 *
 * 🔴 **It also names the ADDRESSEES, since 2026-08-24, and it had to.** This read only
 * `actorPersonId`/`actorSeatId` — *who performed an event* — while the "who was told" panel
 * on the same screen lists `state.dispatchedTo`, which is *who we sent it to*. Since
 * M10-07/08/09 made the person row the only row the picker draws, the ordinary recipient is a
 * named officer **who never touches the incident** — so the panel resolved nothing and printed
 * a **raw uuid per recipient**, on the one screen the district was told to open for *"kis ko
 * gaya hai"*. `api/board.ts` had already met this and answered it with `dispatchNames`; this is
 * the same fix on the same day's other surface. Found by rendering the window and reading it,
 * which is the only way it could have been: every assertion about that panel matches on a
 * `.tname` whose contents nothing checks.
 */
async function actorsFor(
  pool: Pool,
  events: readonly IncidentEvent[],
  /** Who the control room chose to tell. Empty on an incident nobody has been told about. */
  told: readonly { readonly kind: string; readonly id: string }[] = [],
): Promise<ActorDirectory> {
  const personIds = [
    ...new Set([
      ...events.map((e) => e.actorPersonId).filter((id) => id !== null),
      ...told.filter((t) => t.kind === 'person').map((t) => t.id),
    ]),
  ];
  // A `post` IS a `seat` row — the district's word and the table's word for one thing
  // (ADR-0004), and `dispatchedTo` keeps the district's.
  const seatIds = [
    ...new Set([
      ...events.map((e) => e.actorSeatId).filter((id) => id !== null),
      ...told.filter((t) => t.kind === 'post').map((t) => t.id),
    ]),
  ];

  const people: Record<string, string> = {};
  const seats: Record<string, { title: string; tier: string; holder?: string }> = {};
  const personSeats: Record<string, string> = {};

  if (personIds.length > 0) {
    /**
     * The name, and — since the district asked for `Officer India — DDMA` on the "who was told"
     * list (`backlog/whatsapp-response-workflow.md` §6) — the post the officer holds, as its
     * own map. `people` stays the bare name: provenance ("X overrode this") already leads with
     * the seat (ADR-0004) and does not want the designation twice. `personSeats` is what
     * `nameForTarget` composes for a `person` recipient.
     *
     * The post is the one held longest — `dutySeatOfPerson`'s rule, three people in Bajaur hold
     * two at once — and a retired one is not a designation anybody acts on.
     */
    const res = await pool.query<{
      person_id: string;
      full_name: string;
      designation: string | null;
    }>(
      `SELECT p.person_id,
              p.full_name,
              (SELECT s.title
                 FROM duty_assignment d
                 JOIN seat s ON s.seat_id = d.seat_id
                WHERE d.person_id = p.person_id
                  AND d.to_at IS NULL
                  AND s.retired_at IS NULL
                ORDER BY d.from_at ASC
                LIMIT 1) AS designation
         FROM person p
        WHERE p.person_id = ANY($1::uuid[])`,
      [personIds],
    );
    for (const row of res.rows) {
      people[row.person_id] = row.full_name;
      if (row.designation !== null && row.designation.trim() !== '') {
        personSeats[row.person_id] = row.designation.trim();
      }
    }
  }

  if (seatIds.length > 0) {
    // `holder` — the officer in this post now, so a `post` recipient on the "who was told"
    // list reads `Officer November — IT Soft`, its holder then its title, the same shape a
    // `person` recipient gets (2026-09-08). `nameForTarget` composes it; provenance's `nameOf`
    // reads only `title` and is unaffected. `duty_one_current_holder_per_seat` bounds it to one.
    const res = await pool.query<{
      seat_id: string;
      title: string;
      tier: string;
      holder: string | null;
    }>(
      `SELECT s.seat_id,
              s.title,
              s.tier,
              (SELECT p.full_name
                 FROM duty_assignment d
                 JOIN person p ON p.person_id = d.person_id
                WHERE d.seat_id = s.seat_id
                  AND d.to_at IS NULL
                  AND p.removed_at IS NULL
                LIMIT 1) AS holder
         FROM seat s
        WHERE s.seat_id = ANY($1::uuid[])`,
      [seatIds],
    );
    for (const row of res.rows) {
      seats[row.seat_id] = {
        title: row.title,
        tier: row.tier,
        ...(row.holder !== null ? { holder: row.holder } : {}),
      };
    }
  }

  return { people, seats, personSeats };
}

/**
 * One incident: its folded state, its full history, and names for everyone in it.
 *
 * All three in one response, on purpose. Provenance has to be renderable without a second
 * request (docs/04-authority-model.md), and a detail screen that shows a value without
 * being able to answer "who set this, when, why" is the thing this project exists not to
 * build.
 */
export async function readIncident(
  pool: Pool,
  incidentId: Uuid,
  identity: Identity,
): Promise<
  | {
      readonly ok: true;
      readonly state: IncidentState;
      readonly events: readonly IncidentEvent[];
      readonly actors: ActorDirectory;
      readonly responsibleDepartments: readonly string[];
      /**
       * The same departments, by id.
       *
       * Sent alongside the names so the detail screen can offer "reach them" without a second
       * request. Names are what an operator reads; an id is what a lookup needs, and a screen
       * that has one and not the other ends up matching on a name somebody may rename.
       */
      readonly responsibleDepartmentIds: readonly string[];
      /**
       * The four-stage view of `state.status` — M9-25.
       *
       * Resolved here rather than on the screen, so the board, the detail view and any later
       * report cannot each map the seven statuses to the four slightly differently. The full
       * status is still on `state`: this is vocabulary, not a replacement.
       */
      readonly stage: Stage;
      /**
       * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
       *
       * The line above the buttons on this screen used to be the uuid, and the owner said so:
       * thirty-six characters of hexadecimal, on the one screen a control room reads out over a
       * telephone. Formatted on the server for one reason — the board, this screen and the
       * printed report must all be quoting the same string, and three templates is how they
       * stop agreeing.
       *
       * Beside `state.incidentId`, never instead of it: the uuid is what the URL, the fold and
       * every action on this page are built on. Null until the sweep reaches it — see
       * `db/referenceStore.ts` for why that is a state and not a fault.
       */
      readonly reference: string | null;
      /**
       * **The acknowledgement deadline for this incident, right now** — for the Record
       * drawer's Deadline tile (2026-09-04).
       *
       * The same numbers `api/board.ts`'s row carries, from the same `checkEscalation` over the
       * same `targetsFor`, so the drawer and the board cannot disagree about whether an
       * emergency is late. `carries: false` for a General communication (M9-10) and for anything
       * with no `occurredAt` — the tile then says "no deadline" rather than counting against
       * nothing.
       */
      readonly sla: {
        readonly carries: boolean;
        readonly targetMinutes: number;
        readonly overdueByMinutes: number;
        readonly lateArrival: boolean;
      };
      /**
       * **Who is holding this, off the officers' own words** — Option C, 2026-09-10.
       *
       * The same `ownershipOf` roll-up `api/board.ts`'s row carries, so the incident screen
       * and the board cannot disagree about who took a wide dispatch. Null when nobody was
       * told yet. On a **single-recipient** incident this names the same office, at the same
       * time, as the fold's `acknowledgedBy*` slot — the screen only reads it instead of the
       * slot once `told > 1`, where the slot has been naming whoever tapped first, a decline
       * included. `takenBy*` / `respondedAt` are null while everyone is still silent and when
       * `ownerless` (answered, nobody holding — reassign).
       */
      readonly response: {
        readonly told: number;
        readonly holding: number;
        readonly declined: number;
        readonly silent: number;
        readonly ownerless: boolean;
        readonly takenBySeatId: string | null;
        readonly takenByPersonId: string | null;
        readonly takenBySaid: string | null;
        readonly respondedAt: string | null;
      } | null;
      /**
       * **Who is coming, when this notice asks who is coming** — the Case 2 (meeting) work,
       * 2026-09-10.
       *
       * The same `attendanceFor` tally the wall's *Still running* card already reads, sent on
       * the detail payload so the drawer stops showing incident `status` / "Taken by" / "The
       * response we received" for a `meeting` (and any `asksAttendance` notice) and shows the
       * attendance summary and per-person answers instead. **Null for everything that is not
       * asking** — every emergency, a plain notice, and `schedule` (it carries Acknowledge, not
       * the three attendance replies) — where the drawer is unchanged. `rows` is every recipient
       * the control room told, in the order they were told.
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
        readonly stale: number;
        readonly late: number;
        readonly closesAt: string | null;
        readonly rows: readonly {
          readonly attemptId: string;
          readonly seatId: string | null;
          readonly personId: string | null;
          readonly answer:
            'attending' | 'not_attending' | 'sending_someone' | 'other' | 'unanswered';
          readonly said: string | null;
          readonly stale: boolean;
          readonly late: boolean;
        }[];
      } | null;
      /**
       * **The saved groups a dispatch on this incident expanded** — Case 3, 2026-09-10.
       *
       * `dispatched.payload.fromGroups`, read back out (`domain/recipientGroups.ts`). Display
       * only: the drawer's "Who was told" panel groups its recipient rows under the group's
       * name — *"All Tehsildars — 6 of 8 responded"* — and lists anybody chosen by hand
       * beneath. Empty for every incident that was never dispatched through a group, and the
       * panel then renders its flat list exactly as before. **Nothing here is in `IncidentState`
       * and nothing reads it to decide who holds anything** — `expand()` still dissolves the
       * group at send and the eight obligations are still independent.
       */
      readonly recipientGroups: readonly {
        readonly groupId: string;
        readonly name: string;
        readonly members: readonly { readonly kind: string; readonly id: string }[];
      }[];
    }
  | { readonly ok: false; readonly status: number; readonly error: string }
> {
  const seat = seatOf(identity);

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return { ok: false, status: 404, error: 'no such incident' };

  const state = foldIncident(incidentId, events);

  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  // Refused reads are a 404, not a 403. Confirming an incident exists to a seat with no
  // authority over it is itself a disclosure about another department's operations.
  if (!readable.allowed) return { ok: false, status: 404, error: 'no such incident' };

  const [actors, departments, seq, slaConfig] = await Promise.all([
    actorsFor(pool, events, state.dispatchedTo),
    departmentDirectory(pool),
    referenceFor(pool, incidentId),
    loadSlaConfiguration(pool),
  ]);

  /**
   * The deadline snapshot the drawer's Deadline tile reads — 2026-09-04.
   *
   * `CARRIES_SLA` is the same set `api/board.ts` and `jobs/escalation.ts` read, so "is this
   * late" is answered from one list. The verdict is null exactly where the board's is: a
   * General communication, or an incident with no `occurredAt`/`lastRecordedAt`.
   */
  /**
   * Who is actually holding this, off the officers' own words — RX-02 / Option C.
   *
   * Read here beside the deadline for the reason `api/board.ts` reads it beside its own: an
   * acknowledgement stops the clock **only while somebody is holding it**. On a wide dispatch
   * where everyone answered and every one of them declined, `state.acknowledgedAt` is set (the
   * first tap filled the slot) but `owned.ownerless` is true, and the clock must keep running.
   */
  const owned = ownershipOf(state.notifications);

  /**
   * Who is coming — null unless this notice asked who is coming (a `meeting`, or an `other` the
   * operator marked `asksAttendance`). The same three inputs the wall's *Still running* card
   * passes (`api/dashboard.ts`): the count restarts from `rescheduledAt`, closes at
   * `attendanceClosesAt` measured from when the notice went out, and `invited` is per-message.
   */
  const askedAt = state.dispatchedAt ?? state.occurredAt;
  const attendance = attendanceFor(state.kind, state.notifications, {
    rescheduledAt: state.rescheduledAt,
    closesAt: askedAt === null ? null : attendanceClosesAt(askedAt),
    invited: state.asksAttendance,
  });

  /**
   * The saved groups this incident's dispatches expanded — Case 3, read straight off the
   * `dispatched` events the way `sentMessage` and the tallies above are read off the ledger.
   * `[]` for the ordinary incident, and the drawer then draws its flat recipient list.
   */
  const recipientGroups = groupsFromEvents(events);

  const slaTargets = targetsFor(slaConfig, state.responsibleDepartmentIds);
  const slaSeverity = state.severity?.value ?? 'unknown';
  const slaVerdict =
    state.occurredAt === null || state.lastRecordedAt === null || !CARRIES_SLA.has(state.kind)
      ? null
      : checkEscalation(
          {
            severity: slaSeverity,
            occurredAt: state.occurredAt,
            recordedAt: state.lastRecordedAt,
            acknowledgedAt: state.acknowledgedAt,
            ownerless: owned.ownerless,
            now: new Date().toISOString(),
          },
          slaTargets,
        );

  /**
   * The departments the control room **told**, named — 2026-08-24.
   *
   * ⚠️ **Always empty since ADR-0031, phase 2.** `'department'` left `RecipientKind`, so no
   * `dispatchedTo` target can be one. `responsibleDepartments` below still answers the
   * different question — who *holds* the incident — from `responsibleDepartmentIds`, which
   * `routed` events carry.
   */
  const toldDepartments: Record<string, string> = {};

  return {
    ok: true,
    state,
    events,
    actors: { ...actors, departments: toldDepartments },
    // Named, not just identified (M0-51). An unmatched id is shown as an id rather than
    // hidden — a department missing from the registry is a problem, not a blank field.
    /**
     * ⚠️ **AN ID NOBODY CAN NAME IS DROPPED, NOT PRINTED — ADR-0030.**
     *
     * `?? id` was right while a registry existed: a department missing from it was a real
     * configuration fault, and the id surfaced it. Migration 0039 dropped the table, so every
     * historical id is unnameable and this fell back to thirty-six characters of hexadecimal —
     * on the screens ADR-0027 exists to have taken exactly that off. `performance.ts` and
     * `domain/dailyReport.ts` drop it for the same reason, and the three must agree.
     */
    responsibleDepartments: state.responsibleDepartmentIds.flatMap((id) => {
      const name = departments[id]?.name;
      return name === undefined ? [] : [name];
    }),
    responsibleDepartmentIds: state.responsibleDepartmentIds,
    stage: stageOf(state.status),
    reference: seq === null ? null : formatReference(seq),
    sla: {
      carries: slaVerdict !== null,
      targetMinutes: slaTargets[slaSeverity],
      overdueByMinutes: Math.round(slaVerdict?.overdueByMinutes ?? 0),
      lateArrival: slaVerdict?.lateArrival ?? false,
    },
    response:
      owned.told === 0
        ? null
        : {
            told: owned.told,
            holding: owned.holding,
            declined: owned.declined,
            silent: owned.silent,
            ownerless: owned.ownerless,
            takenBySeatId: owned.takenBySeatId,
            takenByPersonId: owned.takenByPersonId,
            takenBySaid: owned.takenBy?.said ?? null,
            respondedAt: owned.respondedAt,
          },
    attendance:
      attendance === null
        ? null
        : {
            told: attendance.told,
            coming: attendance.coming,
            answered: attendance.answered,
            attending: attendance.attending,
            sendingSomeone: attendance.sendingSomeone,
            notAttending: attendance.notAttending,
            other: attendance.other,
            unanswered: attendance.unanswered,
            stale: attendance.stale,
            late: attendance.late,
            closesAt: attendance.closesAt,
            rows: attendance.rows.map((r) => ({
              attemptId: r.attemptId,
              seatId: r.seatId,
              personId: r.personId ?? null,
              answer: r.answer,
              said: r.said ?? null,
              stale: r.stale === true,
              late: r.late === true,
            })),
          },
    recipientGroups: recipientGroups.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      members: g.members.map((m) => ({ kind: m.kind, id: m.id })),
    })),
  };
}
