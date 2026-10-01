/**
 * The operator records what they were told — M7-05, M7-06, M7-07.
 *
 * Bajaur's control room rings people. It rang them before this software existed and it will go
 * on ringing them after the WhatsApp account arrives, because some nights the API is down, some
 * officers do not tap links, and some things are faster said than typed. **Until this endpoint
 * existed the system had no way to hear about any of it** — an obligation the operator had
 * personally closed on a two-minute telephone call stayed on the board as an emergency nobody
 * had been told about, for ever.
 *
 * That is not a cosmetic gap. INV-03 exists so that a real failure is visible; a board carrying
 * dozens of obligations that were met by telephone teaches the district to ignore the number,
 * and then the one that matters at 02:00 is ignored with the rest.
 *
 * ## The line this module is built around
 *
 * **The operator's word and the machine's observation are never the same field.** ADR-0014 drew
 * this line around read receipts and refused to count them; it is the same line here, from the
 * other side. What is recorded is *"the control room says Rescue confirmed by telephone"*, with
 * the operator named, in their own words — never *"Rescue acknowledged"*, which is what the
 * record would say if an officer had tapped the link themselves.
 *
 *   * the envelope's actor is **the operator**, because they are the one making the statement
 *   * `payload.seatId` is **the recipient**, because they are the one who took the emergency
 *   * `route: 'operator'` is on the event, so no report can add this to the link taps (M7-30)
 *
 * Those three are different people and different facts, and a system that flattened them would
 * be unable to answer *"who said Rescue was told?"* — which is the first question asked when
 * Rescue says they were not.
 *
 * ## Why it settles the existing attempt rather than adding one
 *
 * The tempting alternative — record a fresh `manual` attempt and settle *that* — was rejected.
 * A recipient would end up with two rows for one obligation, and the board counts unmet
 * obligations by attempt, so *"we rang them and could not get through"* would make the district
 * look **twice** as badly reached as doing nothing at all.
 *
 * Settling the attempt that already exists is also the more truthful record. `channel` stays
 * whatever carried the message and `via` says how we found out, so `whatsapp` + `operator` reads
 * exactly as it happened: the software sent it, and a human confirmed it by telephone. Every
 * intermediate state is still in the log, which is what the log is for (ADR-0001).
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { defaultRules, evaluateRead, evaluateWrite } from '../domain/authority.js';
import type { IncidentEvent, Uuid } from '../domain/events.js';
import { foldIncident } from '../domain/incident.js';
import { markObligationMet } from '../jobs/notify.js';
import { dutySeatOfPerson } from '../db/rosterStore.js';
import { seatOf } from './lifecycle.js';
import type { Identity } from '../auth/sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a note may be. Generous — it is a sentence somebody said, not a form field. */
const SAID_MAX = 2000;

export type AcknowledgementOutcome = 'confirmed' | 'could_not_reach';

export interface AcknowledgementInput {
  /** Which obligation this answers. The "Who was told" panel already has it on every row. */
  readonly attemptId?: unknown;
  readonly outcome?: unknown;
  /** What they said, or what happened when the operator rang. */
  readonly said?: unknown;
}

export interface AcknowledgementResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

function refuse(status: number, error: string): AcknowledgementResult {
  return { status, body: { error } };
}

/**
 * Record an acknowledgement the control room heard, or a recipient they could not reach.
 *
 * Both outcomes go through one endpoint on purpose. They are the two halves of one act — the
 * operator picks up the telephone and something happens — and an interface offering only the
 * happy half teaches operators that "could not reach them" is not worth recording. It is the
 * more valuable of the two: a confirmation closes an obligation, an unreachable officer is a
 * roster to fix or a post to fill (ADR-0004).
 */
export async function recordAcknowledgement(
  pool: Pool,
  incidentId: Uuid,
  input: AcknowledgementInput,
  identity: Identity,
): Promise<AcknowledgementResult> {
  const seat = seatOf(identity);

  const attemptId = input.attemptId;
  if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) {
    return refuse(400, 'attemptId must be the uuid of the message this answers');
  }

  const outcome = input.outcome;
  if (outcome !== 'confirmed' && outcome !== 'could_not_reach') {
    return refuse(400, "outcome must be 'confirmed' or 'could_not_reach'");
  }

  const said =
    typeof input.said === 'string' && input.said.trim() !== '' ? input.said.trim() : null;
  if (said !== null && said.length > SAID_MAX) {
    return refuse(400, `what they said is too long (${SAID_MAX} characters)`);
  }

  /**
   * A confirmation must carry what was said; an unreachable recipient need not.
   *
   * Not symmetry for its own sake. A confirmation is **this operator asserting a fact about
   * somebody else**, and it stops the SLA clock — the authority table already demands a reason
   * for exactly that act, and refusing here is only saying so in words an operator can act on
   * rather than letting `evaluateWrite` answer "requires a reason to override".
   *
   * "Could not reach them" asserts nothing about anybody else and stops no clock.
   */
  if (outcome === 'confirmed' && said === null) {
    return refuse(400, 'record what they told you — it is the whole point of this entry');
  }

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  // A refused read is a 404, never a 403 — confirming an incident exists is itself a
  // disclosure about another department's operations.
  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  if (state.status === 'closed') {
    return refuse(409, 'incident is closed; reopen it before recording anything against it');
  }

  /**
   * Two outcomes, two rules, and the split is the honest one.
   *
   * A confirmation stops the incident's clock, so it is governed by `incident.acknowledgement`
   * — the row whose own comment already describes this exact case: *the control room
   * acknowledging on a department's behalf is exactly the thing that should be explainable
   * afterwards.* The explanation is what the officer said.
   *
   * "Could not reach them" changes no assessment and stops no clock. It records the fate of a
   * message the control room sent, which is `incident.dispatch`.
   */
  const fieldKey = outcome === 'confirmed' ? 'incident.acknowledgement' : 'incident.dispatch';
  const rule = defaultRules(state.responsibleDepartmentIds[0] ?? null).find(
    (r) => r.fieldKey === fieldKey,
  );
  // Fails closed. A command naming a field with no rule is refused rather than allowed.
  if (rule === undefined) return refuse(403, `no authority rule governs ${fieldKey}`);

  const decision = evaluateWrite(rule, {
    fieldKey,
    seat,
    ...(said === null ? {} : { reason: said }),
  });
  if (!decision.allowed) return refuse(403, decision.why);

  const answered = state.notifications.find((a) => a.attemptId === attemptId);
  if (answered === undefined) {
    return refuse(404, 'no message on this incident with that id');
  }

  /**
   * The guard is on **who answered**, never on the attempt merely being settled — and the
   * difference is ADR-0014's whole argument.
   *
   * A recipient already recorded as having answered cannot be overwritten: that would let a
   * later entry quietly erase an earlier operator's account of a conversation they had. If the
   * district genuinely needs to say *"they confirmed and then nothing arrived"*, that is a
   * logged action, which keeps the first statement in the record beside the second.
   *
   * **A provider's delivery is not an answer.** An attempt Meta reports as `delivered` is
   * settled in the ledger and nobody has decided anything — the message reached a handset. The
   * operator ringing to find out whether anyone read it is precisely the right next move, and
   * a guard on `state === 'delivered'` would have refused it. That was the first version of
   * this check, and it would have made this feature useless on exactly the nights the WhatsApp
   * account works and nobody is answering.
   */
  const ANSWERED: readonly string[] = ['link', 'reply', 'operator'];
  if (answered.state === 'delivered' && ANSWERED.includes(answered.via ?? '')) {
    return refuse(409, 'this message is already recorded as answered');
  }

  const now = new Date().toISOString();
  const recipient = {
    seatId: answered.seatId,
    ...(answered.personId === undefined ? {} : { personId: answered.personId }),
  };

  const settlement: IncidentEvent = {
    eventId: randomUUID(),
    incidentId,
    occurredAt: now,
    recordedAt: now,
    clientSeq: state.eventCount + 1,
    // **The operator, not the recipient.** This is their statement about a call they made.
    actorPersonId: identity.personId,
    actorSeatId: seat.seatId,
    sourceChannel: 'call',
    type: outcome === 'confirmed' ? 'notification_delivered' : 'notification_failed',
    payload: {
      attemptId,
      ...recipient,
      channel: answered.channel,
      via: 'operator',
      ...(outcome === 'confirmed'
        ? { ...(said === null ? {} : { said }) }
        : {
            failure:
              said === null
                ? 'could_not_reach: the control room rang and did not reach them'
                : `could_not_reach: ${said}`,
          }),
    },
  } as unknown as IncidentEvent;

  await append(pool, [settlement]);

  if (outcome === 'could_not_reach') {
    // Nothing else follows. The obligation is still owed, still visible, and now carries the
    // better reason: not "no account is configured" but "a person rang and got nothing",
    // which sends the district to the roster instead of to Meta.
    return { status: 200, body: { ok: true, attemptId, acknowledged: false, alsoSettled: 0 } };
  }

  /**
   * The other messages owed to the same recipient are settled too.
   *
   * Somebody who told the operator on the telephone that they are on their way has been
   * reached, whatever else was sent to them — and leaving a WhatsApp attempt to the same post
   * pending would be a failure the system invented. Same argument as the acknowledge tap, and
   * `markObligationMet` is the same function, so the two cannot drift apart.
   */
  const before = state.notifications.filter((a) => a.state === 'pending').length;
  await markObligationMet(
    pool,
    incidentId,
    attemptId,
    { personId: identity.personId, seatId: seat.seatId },
    { via: 'operator', ...(said === null ? {} : { said }) },
  );

  const acknowledged = await acknowledgeIncidentIfDue(pool, incidentId, recipient, seat.seatId, {
    personId: identity.personId,
    said,
  });

  const after = foldIncident(incidentId, await loadIncident(pool, incidentId));
  const stillPending = after.notifications.filter((a) => a.state === 'pending').length;

  return {
    status: 200,
    body: { ok: true, attemptId, acknowledged, alsoSettled: Math.max(0, before - stillPending) },
  };
}

/**
 * Acknowledge the incident, if that is still a thing to do.
 *
 * Split out because the conditions are the acknowledge tap's, exactly (`webhooks.ts`), and the
 * two must not disagree about when an acknowledgement counts:
 *
 *   * **once only** — a second one would move `acknowledgedAt` and give an incident that was
 *     taken at 02:04 an acknowledgement time of 02:31
 *   * **not after resolution** — the emergency has moved past this
 *   * **only for a post** — acknowledgement stops the clock because a **duty** took the
 *     emergency (ADR-0004). A named officer with no post has genuinely been reached, which the
 *     ledger above records, but holds no duty to take it with
 */
async function acknowledgeIncidentIfDue(
  pool: Pool,
  incidentId: Uuid,
  recipient: { readonly seatId: Uuid | null; readonly personId?: Uuid },
  operatorSeatId: Uuid,
  operator: { readonly personId: Uuid | null; readonly said: string | null },
): Promise<boolean> {
  const state = foldIncident(incidentId, await loadIncident(pool, incidentId));

  if (state.acknowledgedAt !== null) return false;
  if (state.status === 'closed' || state.status === 'resolved') return false;

  /**
   * The recipient's post, resolved from the **ledger row's** person when the row carries no seat.
   *
   * A dispatch to a named officer records `personId` and no seat, so this refused every telephone
   * confirmation about anybody the control room had chosen by name — which after M10-07/08/09 is
   * almost everybody. The operator rang, typed what they were told, got `200 ok`, and the
   * emergency stayed unacknowledged on the board with nothing on screen saying why. **The manual
   * route out of the acknowledge-button defect was shut by the same null**, which is what made
   * this worth fixing in the same change rather than after it.
   *
   * Resolved **now**, deliberately unlike the acknowledge tap's frozen seat: the operator is
   * asserting a fact about a conversation happening at this moment, so the post this officer
   * holds at this moment is the right one. There is no earlier instant here to be faithful to.
   *
   * ⚠️ **A post-less officer is acknowledged too, since the owner's reversal of 2026-08-17.** This
   * used to return `false` for them, reasoning from ADR-0004 that the clock stops because a duty
   * took the emergency. The control room **chose** that officer, so the refusal was the software
   * overruling the district's own operational decision — and it left the record unable to say that
   * somebody the control room had assigned work to had confirmed it. `seatId` stays null in that
   * case and `personId` carries the attribution, which is what the event's schema always allowed.
   * See `appendAcknowledgement` in `api/webhooks.ts` for the full note; the two must agree.
   */
  const seatId =
    recipient.seatId ??
    (recipient.personId === undefined ? null : await dutySeatOfPerson(pool, recipient.personId));
  if (seatId === null && recipient.personId === undefined) return false;

  const now = new Date().toISOString();

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: operator.personId,
      actorSeatId: operatorSeatId,
      // `call`, because that is what happened. The channel an event arrived by is part of how
      // much weight to give it, and rendering this identically to an in-app acknowledgement
      // would hide the difference the whole module exists to preserve.
      sourceChannel: 'call',
      type: 'acknowledged',
      payload: {
        seatId,
        ...(recipient.personId === undefined ? {} : { personId: recipient.personId }),
        route: 'operator',
        ...(operator.said === null ? {} : { said: operator.said }),
      },
    } as unknown as IncidentEvent,
  ]);

  return true;
}
