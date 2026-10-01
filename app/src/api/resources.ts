/**
 * What a department can send, over HTTP — M1-02 and M1-03.
 *
 * Scoped exactly like the roster: **a department manages its own units, the two offices
 * manage anyone's** (ADR-0010). The gate is `reach`, imported rather than reimplemented, so
 * there is one function to audit for both screens.
 *
 * Two kinds of thing live here and the split matters:
 *
 * - **The registry** — what exists, what is on the run, who is on which team. Configuration,
 *   recorded in `config_event`.
 * - **Dispatch and release** — what is committed to an incident right now. Those are facts
 *   about an *emergency*, so they are `incident_event`s and go through the same authority
 *   check as every other incident command (INV-05).
 *
 * Putting dispatch in the incident log rather than in a resource table is what makes "which
 * ambulance went to the bazaar fire, and when did it leave" answerable a year later.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { IncidentEvent, Uuid } from '../domain/events.js';
import { append, loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import {
  canDispatch,
  summarise,
  type ResourceAvailability,
  type ResourceKind,
} from '../domain/resources.js';
import {
  addMember,
  availabilityFor,
  commitmentsFor,
  createResource,
  resourceExists,
  findResource,
  removeMember,
  setOutOfService,
  setResourceRetired,
  updateResource,
  type ResourceResult,
} from '../db/resourceStore.js';
import type { AdminResult } from './admin.js';
import { mayEditRoster } from './roster.js';

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

function settle<T>(result: ResourceResult<T>): AdminResult<T> {
  return result.ok ? { ok: true, value: result.value } : refuse(409, result.why);
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function isKind(v: unknown): v is ResourceKind {
  return v === 'vehicle' || v === 'team' || v === 'equipment';
}

function actorOf(identity: Identity): { seatId: string | null; personId: string | null } {
  return { seatId: identity.seatId, personId: identity.personId };
}

//------------------------------------------------------------------------------
// The registry
//------------------------------------------------------------------------------

export interface FleetView {
  readonly units: readonly ResourceAvailability[];
  readonly summary: ReturnType<typeof summarise>;
}

/**
 * The district's fleet — one list, no scope. ADR-0031 (phase 4) dropped the `departmentId`
 * parameter: migration 0039 dropped `resource.department_id`, so there was one fleet already
 * and the argument only ever chose a nil placeholder.
 */
export async function readFleet(pool: Pool, identity: Identity): Promise<AdminResult<FleetView>> {
  const denied = mayEditRoster<FleetView>(identity);
  if (denied !== null) return denied;

  const units = await availabilityFor(pool, DISTRICT_WIDE);
  return { ok: true, value: { units, summary: summarise(units) } };
}

export async function addResource(
  pool: Pool,
  identity: Identity,
  input: { readonly kind?: unknown; readonly name?: unknown; readonly identifier?: unknown },
): Promise<AdminResult<unknown>> {
  const denied = mayEditRoster<unknown>(identity);
  if (denied !== null) return denied;

  if (!isKind(input.kind)) {
    return refuse(400, 'a unit is a "vehicle", a "team" or a piece of "equipment"');
  }
  const name = text(input.name);
  if (name === undefined) return refuse(400, 'a unit needs a name somebody would say on the radio');
  if (name.length > 120) return refuse(400, 'that name is too long');

  return settle(
    await createResource(
      pool,
      DISTRICT_WIDE,
      {
        kind: input.kind,
        name,
        ...(text(input.identifier) !== undefined ? { identifier: text(input.identifier) } : {}),
      },
      actorOf(identity),
    ),
  );
}

/**
 * The roster's gate, then the unit's existence — in that order, and the order is the point.
 *
 * ⚠️ **IT RAN THE LOOKUP FIRST AND THAT WAS BOTH A 500 AND THE WRONG REFUSAL.** The lookup
 * asked for a dropped column, so every fleet action answered 500; and had it merely returned
 * null, a caller with no authority would have been told *no such unit* — which is the honest
 * answer to a stranger and the wrong one to the control room, whose real problem would be that
 * they may not do this. `api/roster.ts` moved its own gate above its own lookup for exactly
 * this reason: the refusal has to name the real reason (INV-05).
 */
async function reachResource<T>(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
): Promise<AdminResult<T> | null> {
  const denied = mayEditFleet<T>(identity);
  if (denied !== null) return denied;
  if (!(await resourceExists(pool, resourceId))) return refuse(404, 'no such unit');
  return null;
}

/** One gate for the fleet, the same one the roster uses (ADR-0024). */
function mayEditFleet<T>(identity: Identity): AdminResult<T> | null {
  return mayEditRoster<T>(identity);
}

/**
 * A nil placeholder for the id the store functions still take and no longer read.
 *
 * ADR-0030 left that parameter in place because `reach`'s own note says removing it would be a
 * different rule wearing the same signature. Nothing looks this up.
 */
const DISTRICT_WIDE = '00000000-0000-0000-0000-000000000000';

export async function editResource(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  input: { readonly name?: unknown; readonly identifier?: unknown },
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  return settle(
    await updateResource(
      pool,
      resourceId,
      {
        ...(text(input.name) !== undefined ? { name: text(input.name)! } : {}),
        ...(input.identifier !== undefined ? { identifier: text(input.identifier) ?? null } : {}),
      },
      actorOf(identity),
    ),
  );
}

export async function serviceState(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  out: boolean,
  reason: unknown,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) {
    // "Out of service" with no reason is a decision the next shift cannot act on: they
    // cannot tell whether to wait an hour or find another ambulance.
    return refuse(400, out ? 'say why it is off the run' : 'say why it is back');
  }

  return settle(await setOutOfService(pool, resourceId, out, why, actorOf(identity)));
}

export async function retireResource(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  retired: boolean,
  reason: unknown,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  const why = text(reason);
  if (why === undefined) return refuse(400, 'say why');

  return settle(await setResourceRetired(pool, resourceId, retired, why, actorOf(identity)));
}

export async function crew(
  pool: Pool,
  identity: Identity,
  resourceId: Uuid,
  personId: unknown,
  add: boolean,
): Promise<AdminResult<unknown>> {
  const denied = await reachResource<unknown>(pool, identity, resourceId);
  if (denied !== null) return denied;

  if (typeof personId !== 'string') return refuse(400, 'name the person');

  const result = add
    ? await addMember(pool, resourceId, personId, actorOf(identity))
    : await removeMember(pool, resourceId, personId, actorOf(identity));

  return settle<unknown>(result);
}

//------------------------------------------------------------------------------
// Dispatch — M1-03
//------------------------------------------------------------------------------

export interface DispatchResult {
  readonly incidentId: Uuid;
  readonly assigned: readonly Uuid[];
  /**
   * Things the operator should know, having already been done.
   *
   * Warnings, not refusals. A unit already committed elsewhere may still be sent — that is
   * the duty officer's call and the system does not get a veto (see `domain/resources.ts`).
   * What it owes them is that the consequence is said out loud rather than discovered.
   */
  readonly warnings: readonly string[];
}

/**
 * Send units to an incident.
 *
 * **Authority is the department's own.** Dispatch is the act of committing your own vehicles
 * and crews, so the check is "is this unit yours", not the incident policy table — a
 * department that holds the incident can send what it has, and cannot send another
 * department's ambulance. The two administrative offices can do either, as everywhere else.
 *
 * All-or-nothing on refusals: if any named unit cannot go, none of them do. A partial
 * dispatch would leave the operator believing they had sent three things when two went, and
 * the one that did not go is the one they would have replaced.
 */
export async function dispatch(
  pool: Pool,
  identity: Identity,
  incidentId: Uuid,
  input: { readonly resourceIds?: unknown },
): Promise<AdminResult<DispatchResult>> {
  const ids = Array.isArray(input.resourceIds)
    ? input.resourceIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return refuse(400, 'name at least one unit to send');

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');
  const state = foldIncident(incidentId, events);

  if (state.status === 'closed') {
    return refuse(409, 'this incident is closed; reopen it before sending anything');
  }

  const warnings: string[] = [];

  for (const resourceId of ids) {
    const resource = await findResource(pool, resourceId);
    if (resource === null) return refuse(404, `no such unit: ${resourceId}`);

    const denied = mayEditFleet<DispatchResult>(identity);
    if (denied !== null) return denied;

    const commitments = (await commitmentsFor(pool, DISTRICT_WIDE))[resourceId] ?? [];
    const verdict = canDispatch(
      resource,
      commitments.filter((c) => c.incidentId !== incidentId),
    );

    if (!verdict.allowed) return refuse(409, verdict.why ?? `${resource.name} cannot be sent`);
    if (verdict.warning !== null) warnings.push(verdict.warning);
  }

  const now = new Date().toISOString();
  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      type: 'assigned',
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: identity.personId,
      actorSeatId: identity.seatId,
      sourceChannel: 'web',
      payload: { resourceIds: ids },
    } as unknown as IncidentEvent,
  ]);

  return { ok: true, value: { incidentId, assigned: ids, warnings } };
}

/**
 * Stand units down from an incident.
 *
 * A reason is required — by this function, by `REASON_REQUIRED`, and by whoever reviews the
 * incident afterwards. Taking a unit off a live emergency is the decision most likely to be
 * asked about, and "it was needed elsewhere" and "it was never actually sent" are very
 * different answers.
 */
export async function release(
  pool: Pool,
  identity: Identity,
  incidentId: Uuid,
  input: { readonly resourceIds?: unknown; readonly reason?: unknown },
): Promise<AdminResult<{ readonly released: readonly Uuid[] }>> {
  const reason = text(input.reason);
  if (reason === undefined) return refuse(400, 'say why it is being stood down');

  const ids = Array.isArray(input.resourceIds)
    ? input.resourceIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return refuse(400, 'name at least one unit to stand down');

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');
  const state = foldIncident(incidentId, events);

  for (const resourceId of ids) {
    if (!state.assignedResourceIds.includes(resourceId)) {
      // Not an error to be forgiving about. "Release X" when X was never on this incident
      // usually means the operator is looking at the wrong incident.
      return refuse(409, 'that unit is not currently on this incident');
    }
    const denied = await reachResource<{ readonly released: readonly Uuid[] }>(
      pool,
      identity,
      resourceId,
    );
    if (denied !== null) return denied;
  }

  const now = new Date().toISOString();
  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      type: 'released',
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: identity.personId,
      actorSeatId: identity.seatId,
      sourceChannel: 'web',
      payload: { resourceIds: ids, reason },
    } as unknown as IncidentEvent,
  ]);

  return { ok: true, value: { released: ids } };
}
