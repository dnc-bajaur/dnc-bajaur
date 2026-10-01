/**
 * What a department can send, and whether it can send it right now — M1-02.
 *
 * A unit is one of three things — a vehicle, a team, a piece of equipment — and to dispatch
 * they are the same thing: something a department commits to an incident.
 *
 * **Availability is computed, never stored.** There is no status column (see migration
 * 0011). Whether an ambulance is committed is a fact about the event log: it was assigned to
 * an incident nobody has closed. A stored status would be a second copy of that, and the way
 * a second copy drifts is a screen saying an ambulance is free while the log says it is at a
 * road accident.
 *
 * The one thing the log cannot know is *out of service*, because a vehicle in the workshop is
 * not a fact about any incident. That is stored, with a reason.
 */

import type { Instant, Uuid } from './events.js';

export type ResourceKind = 'vehicle' | 'team' | 'equipment';

/**
 * Why a unit cannot be sent, in the order an operator would ask.
 *
 * `committed` is deliberately **not** a refusal on its own — see `canDispatch`. A district
 * with one ambulance and two emergencies has to be able to send it to the second, and a
 * system that refuses would be substituting its own judgement for the duty officer's at the
 * worst possible moment.
 */
export type Unavailability = 'retired' | 'out_of_service' | 'committed';

export interface Resource {
  readonly resourceId: Uuid;
  readonly departmentId: Uuid;
  readonly kind: ResourceKind;
  readonly name: string;
  readonly identifier: string | null;
  readonly outOfServiceAt: Instant | null;
  readonly outOfServiceReason: string | null;
  readonly retiredAt: Instant | null;
  /** Members, for a team. Always empty for the other kinds. */
  readonly members: readonly { readonly personId: Uuid; readonly fullName: string }[];
}

/** An incident this unit is currently committed to. Derived from the event log. */
export interface Commitment {
  readonly incidentId: Uuid;
  readonly since: Instant;
  readonly category: string;
  readonly severity: string;
}

export interface ResourceAvailability {
  readonly resource: Resource;
  /** Empty means free to send. */
  readonly blockedBy: readonly Unavailability[];
  readonly commitments: readonly Commitment[];
}

export function isRetired(r: Resource): boolean {
  return r.retiredAt !== null;
}

export function isOutOfService(r: Resource): boolean {
  return r.outOfServiceAt !== null;
}

/**
 * Why this unit is not simply available.
 *
 * Returns every reason rather than the first. An ambulance that is both in the workshop and
 * still recorded against an open incident is two different problems for two different people
 * — one is a mechanic, one is a duty officer who never closed a job — and collapsing them to
 * the first one found hides the second indefinitely.
 */
export function blockedBy(
  resource: Resource,
  commitments: readonly Commitment[],
): readonly Unavailability[] {
  const reasons: Unavailability[] = [];
  if (isRetired(resource)) reasons.push('retired');
  if (isOutOfService(resource)) reasons.push('out_of_service');
  if (commitments.length > 0) reasons.push('committed');
  return reasons;
}

export interface DispatchVerdict {
  readonly allowed: boolean;
  /** Shown to the operator before they commit. Never a silent refusal, never a silent yes. */
  readonly warning: string | null;
  readonly why: string | null;
}

/**
 * May this unit be sent to this incident?
 *
 * The interesting rule is the one that says **yes with a warning**.
 *
 * A retired unit or one in the workshop cannot go: those are facts about the world, and
 * pretending otherwise would put a vehicle on a screen that is not going to arrive. But a
 * unit already committed elsewhere is a **judgement**, and it is the duty officer's. A
 * district with one ambulance and two road accidents has to be able to move it, and a system
 * that refused would be overruling the only person who can see both scenes.
 *
 * So the answer is yes, and the screen says out loud what else the unit is already on —
 * because the failure this prevents is not double-dispatch, it is double-dispatch that
 * **nobody noticed** (ADR-0005).
 *
 * Note what the warning does **not** claim. Dispatching a committed unit here does not stand
 * it down from the other incident: that would be this screen making a decision about an
 * emergency it is not looking at. The unit shows as committed to both, which is the truth,
 * until somebody with that incident in front of them releases it.
 */
export function canDispatch(
  resource: Resource,
  commitments: readonly Commitment[],
): DispatchVerdict {
  if (isRetired(resource)) {
    return { allowed: false, warning: null, why: `${resource.name} has been retired` };
  }
  if (isOutOfService(resource)) {
    return {
      allowed: false,
      warning: null,
      why: `${resource.name} is out of service: ${resource.outOfServiceReason ?? 'no reason given'}`,
    };
  }
  if (commitments.length > 0) {
    const where = commitments.map((c) => `${c.severity} ${c.category}`).join(', ');
    return {
      allowed: true,
      warning: `${resource.name} is already committed to ${String(commitments.length)} open ${
        commitments.length === 1 ? 'incident' : 'incidents'
      } (${where}). It will show as committed to both until somebody stands it down.`,
      why: null,
    };
  }
  return { allowed: true, warning: null, why: null };
}

export interface ResourceSummary {
  readonly total: number;
  readonly available: number;
  readonly committed: number;
  readonly outOfService: number;
}

/**
 * What a department can field right now, in four numbers.
 *
 * Counted so that they add up: every live unit is in exactly one of the three states, worst
 * first. A unit both out of service and committed counts as out of service — it is not
 * coming either way, and a summary where the parts exceed the whole is a summary nobody
 * trusts twice.
 */
export function summarise(availability: readonly ResourceAvailability[]): ResourceSummary {
  const live = availability.filter((a) => !isRetired(a.resource));

  const outOfService = live.filter((a) => isOutOfService(a.resource)).length;
  const committed = live.filter(
    (a) => !isOutOfService(a.resource) && a.commitments.length > 0,
  ).length;

  return {
    total: live.length,
    available: live.length - outOfService - committed,
    committed,
    outOfService,
  };
}
