/**
 * **An escalation by a person's hand — Phase 8c, 2026-08-21.**
 *
 * ## Why a person needs this at all, and it is the second half of a deletion
 *
 * Escalating used to be something only the **software** did. `jobs/escalation.ts` ran on a
 * deadline, appended `escalated`, and the notification pass told the seat above. The district
 * then asked for the telling to stop — *"officers ka follow up aggressively nahi lena hai, na hi
 * un ke high up office ko inform/shikayat karni hai"* — and chose, out of the two options put to
 * them, the one where an escalation **marks the board and messages nobody**:
 *
 * > *"escalation ke liye B theek hai, but us par action lene ka option bhi hona chahiye."*
 *
 * Phase 8a did the first half by deleting four lines from `domain/notifications.ts`. **This file
 * is the second half**: the mark that had only ever been made by a clock can now be made by a
 * person, deliberately, with a sentence attached.
 *
 * ## What it does NOT do, and this is the sentence the button repeats to the operator
 *
 * ⚠️ **It messages nobody.** Not the officer, not the seat it escalates to, not that seat's
 * office. `domain/notifications.ts` produces no obligation for `currentEscalationSeatId` any
 * more, so appending this event reaches no handset — by design, and by the district's own
 * instruction. An operator who presses *Escalate* expecting a telephone to ring somewhere has
 * misunderstood the button, so the confirmation says so before anything is recorded, and the way
 * to actually reach somebody sits beside it: **Follow up** (Phase 8b).
 *
 * ## 🔴 THE STARTING RUNG IS THE RESPONSIBLE DEPARTMENT, NOT WHOEVER LAST TOUCHED THE SCREEN
 *
 * The ladder itself is shared with the job — `nextSeatUp`, `tierOfSeat`, one answer to *who is
 * above whom* (ADR-0010). What is **not** shared is where the climb begins, and the difference is
 * deliberate rather than an oversight.
 *
 * `jobs/escalation.ts` starts from `currentEscalationSeatId ?? lastActingSeat(events)`. On this
 * district's actual path the last acting seat is **the control room itself**: the control room
 * reports or receives, then dispatches, and its seat is district tier. `nextSeatUp` from
 * `district` in a two-rung ladder returns null — *nobody is above you* — so a manual escalation
 * written that way would refuse the very case it exists for, on the ordinary journey, every time.
 *
 * An un-escalated emergency **sits with the department it was given to**, whoever last typed on
 * the screen about it. So the climb starts at that department's rung and lands on the district,
 * which is what everybody involved means by "escalate this". Once it has been escalated,
 * `currentEscalationSeatId` is where it stands, and the climb starts there.
 *
 * ⚠️ The same reasoning applies to the **job**, which does not do this — recorded as **O-47** for
 * the owner rather than changed here. Altering what the software does automatically is a decision
 * that belongs to the district, and this phase was asked for the opposite: the parts a person
 * presses.
 *
 * ## Refusals say what to do instead
 *
 * Three of them, and each names the act that is actually available: an emergency nobody holds
 * cannot be escalated (choose who should know), one already at the top cannot climb (ring them),
 * and a closed one takes no further changes (reopen it). "Refused" with no second sentence sends
 * an operator to the telephone to ask a developer, which is the failure mode this whole screen
 * exists to remove.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { defaultRules, evaluateRead, evaluateWrite } from '../domain/authority.js';
import type { IncidentEvent } from '../domain/events.js';
import { foldIncident } from '../domain/incident.js';
import { nextSeatUp, tierOfSeat } from '../jobs/escalation.js';
import { seatOf } from './lifecycle.js';

export interface EscalateOptions {
  readonly pool: Pool;
  readonly identity: Identity;
  readonly incidentId: string;
  /**
   * Why, in the district's own words. **Required** — see `incident.escalation` in
   * `domain/authority.ts`: the mark is now the entire act, so a mark with no words behind it is a
   * row on a board that nobody can act on afterwards.
   */
  readonly reason: string;
  /** Fixed by a test, real otherwise. The one clock never comes from a client. */
  readonly now?: string;
}

export interface EscalateDone {
  readonly toSeatId: string;
  readonly toSeatTitle: string;
  /**
   * Whether anybody currently holds the post it landed on.
   *
   * Reported rather than swallowed: ADR-0004 says a vacant post must never absorb an obligation,
   * and a control room that escalated into an empty chair has to be told so it can ring a person
   * instead of waiting on one.
   */
  readonly hasHolder: boolean;
}

export type EscalateResult =
  | { readonly ok: true; readonly escalated: EscalateDone }
  | { readonly ok: false; readonly status: number; readonly error: string };

const refuse = (status: number, error: string): EscalateResult => ({ ok: false, status, error });

export async function escalateByHand(options: EscalateOptions): Promise<EscalateResult> {
  const { pool, identity, incidentId } = options;
  const now = options.now ?? new Date().toISOString();

  const reason = options.reason.trim();
  if (reason === '') return refuse(400, 'say why this should go up; the reason is the record');

  const seat = seatOf(identity);

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  // A refused read is a 404, never a 403 — confirming an incident exists is itself a disclosure
  // about another department's operations.
  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  const rule = defaultRules(state.responsibleDepartmentIds[0] ?? null).find(
    (r) => r.fieldKey === 'incident.escalation',
  );
  // Fails closed: a field with no rule is refused rather than allowed.
  if (rule === undefined) return refuse(403, 'no authority rule governs incident.escalation');

  const decision = evaluateWrite(rule, { fieldKey: 'incident.escalation', seat, reason });
  if (!decision.allowed) return refuse(403, decision.why);

  /**
   * A closed emergency takes no further changes, the same rule `lifecycle.ts` applies — and
   * escalating one would be a claim nobody can act on: the work has stopped.
   */
  if (state.status === 'closed') {
    return refuse(409, 'incident is closed; reopen it before escalating');
  }

  const departmentId = state.responsibleDepartmentIds[0] ?? null;
  if (departmentId === null && state.currentEscalationSeatId === null) {
    // Nothing to escalate FROM. The honest next act is to give it to somebody.
    return refuse(409, 'nobody holds this yet — choose who should know first');
  }

  /**
   * Where it stands now. See this file's header: **not** `lastActingSeat`, which on the ordinary
   * journey is the control room's own district-tier seat and would leave every escalation
   * reporting that there is nobody above it.
   */
  const from = state.currentEscalationSeatId;
  const currentTier = from === null ? 'post' : ((await tierOfSeat(pool, from)) ?? 'post');

  const next = await nextSeatUp(pool, currentTier, departmentId);
  if (next === null) {
    return refuse(
      409,
      'this is already at the top of the district ladder — there is nobody above it to escalate ' +
        'to. Follow up with whoever holds it, or ring them.',
    );
  }

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      type: 'escalated',
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      /**
       * ⚠️ **The actor is a person, and that is the whole difference from the job's escalations**,
       * which carry no actor at all. `nameOf` in the detail screen reads a null actor as *"the
       * system"* and says so — a deliberate distinction, because *"nobody did this, the deadline
       * did"* is a real and important thing for a reviewer to be able to tell apart from *"the
       * duty officer decided this at 21:40"*.
       */
      actorPersonId: identity.personId,
      actorSeatId: seat.seatId,
      sourceChannel: 'web',
      payload: {
        fromSeatId: from,
        toSeatId: next.seatId,
        trigger: 'manual',
        reason,
      },
    } as unknown as IncidentEvent,
  ]);

  const title = await pool.query<{ title: string }>('SELECT title FROM seat WHERE seat_id = $1', [
    next.seatId,
  ]);

  return {
    ok: true,
    escalated: {
      toSeatId: next.seatId,
      toSeatTitle: title.rows[0]?.title ?? next.seatId,
      hasHolder: next.hasHolder,
    },
  };
}
