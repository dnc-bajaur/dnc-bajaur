/**
 * Reading and writing what a department has to send — M1-02.
 *
 * The interesting query in this file is `commitmentsFor`. Everything else is CRUD.
 *
 * **Commitment is derived from the event log, not stored.** There is no status column and
 * there must not be one (migration 0011). A vehicle is committed exactly when some incident
 * that nobody has closed has it in its live assigned set — which is a fold over events, and
 * therefore cannot disagree with the record the way a cached status eventually would.
 */

import type { Pool, PoolClient } from 'pg';

import type { Instant, Uuid } from '../domain/events.js';
import type { Commitment, Resource, ResourceKind } from '../domain/resources.js';
import { blockedBy, type ResourceAvailability } from '../domain/resources.js';
import { inTransaction, recordChange, type ConfigActor } from './configStore.js';

interface ResourceRow {
  resource_id: string;
  department_id: string;
  kind: ResourceKind;
  name: string;
  identifier: string | null;
  out_of_service_at: string | null;
  out_of_service_reason: string | null;
  retired_at: string | null;
}

function toResource(
  r: ResourceRow,
  members: readonly { personId: Uuid; fullName: string }[] = [],
): Resource {
  return {
    resourceId: r.resource_id,
    departmentId: r.department_id,
    kind: r.kind,
    name: r.name,
    identifier: r.identifier,
    outOfServiceAt: r.out_of_service_at,
    outOfServiceReason: r.out_of_service_reason,
    retiredAt: r.retired_at,
    members,
  };
}

// ADR-0030 — `department_id` is gone from the table (migration 0039). `departmentId` stays on
// the `Resource` row as null so nothing rendering a unit has to change in the same commit.
const COLUMNS = `resource_id, NULL::uuid AS department_id, kind, name, identifier,
                 out_of_service_at, out_of_service_reason, retired_at`;

export type ResourceResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

//------------------------------------------------------------------------------
// Commitments — the fold that replaces a status column
//------------------------------------------------------------------------------

/**
 * Which units are committed to an open incident right now, and to what.
 *
 * One query for the whole district rather than one per unit, for the same reason the board
 * loads its departments once: a dispatch screen asks this about every unit a department has,
 * and a round trip each would make the slowest moment of the night the slowest screen.
 *
 * The shape of it: take every `assigned`, subtract every later `released`, drop anything on
 * an incident that has been resolved or closed. Expressed as SQL because it is a filter, not
 * a decision — the *rules* about dispatch live in `domain/resources.ts`, and this only
 * narrows which rows they run against.
 */
export async function commitmentsFor(
  pool: Pool,
  _departmentId: Uuid,
): Promise<Readonly<Record<string, Commitment[]>>> {
  const { rows } = await pool.query<{
    resource_id: string;
    incident_id: string;
    since: string;
    category: string | null;
    severity: string | null;
  }>(
    `WITH mine AS (
       -- ADR-0030: the fleet is the district’s, so this is every unit rather than one
       -- department’s.
       SELECT resource_id FROM resource
     ),
     assigned AS (
       SELECT e.incident_id,
              r.resource_id,
              min(e.occurred_at) AS since
         FROM incident_event e
         CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'resourceIds') AS a(resource_id)
         JOIN mine r ON r.resource_id = a.resource_id::uuid
        WHERE e.type = 'assigned'
        GROUP BY e.incident_id, r.resource_id
     ),
     released AS (
       SELECT e.incident_id, a.resource_id::uuid AS resource_id, max(e.occurred_at) AS at
         FROM incident_event e
         CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'resourceIds') AS a(resource_id)
        WHERE e.type = 'released'
        GROUP BY e.incident_id, a.resource_id
     ),
     latest_assignment AS (
       SELECT e.incident_id, a.resource_id::uuid AS resource_id, max(e.occurred_at) AS at
         FROM incident_event e
         CROSS JOIN LATERAL jsonb_array_elements_text(e.payload->'resourceIds') AS a(resource_id)
        WHERE e.type = 'assigned'
        GROUP BY e.incident_id, a.resource_id
     )
     SELECT asg.resource_id,
            asg.incident_id,
            asg.since,
            (SELECT r.payload->>'category' FROM incident_event r
              WHERE r.incident_id = asg.incident_id AND r.type = 'reported'
              ORDER BY r.seq LIMIT 1) AS category,
            (SELECT t.payload->>'severity' FROM incident_event t
              WHERE t.incident_id = asg.incident_id
                AND t.type IN ('reported', 'triaged')
              ORDER BY t.seq DESC LIMIT 1) AS severity
       FROM assigned asg
       JOIN latest_assignment la
         ON la.incident_id = asg.incident_id AND la.resource_id = asg.resource_id
       LEFT JOIN released rel
         ON rel.incident_id = asg.incident_id AND rel.resource_id = asg.resource_id
      WHERE (rel.at IS NULL OR rel.at < la.at)
        AND NOT EXISTS (
              SELECT 1 FROM incident_event c
               WHERE c.incident_id = asg.incident_id
                 AND c.type IN ('resolved', 'closed')
            )
      ORDER BY asg.since`,
  );

  const out: Record<string, Commitment[]> = {};
  for (const r of rows) {
    (out[r.resource_id] ??= []).push({
      incidentId: r.incident_id,
      since: r.since,
      category: r.category ?? 'unknown',
      severity: r.severity ?? 'unknown',
    });
  }
  return out;
}

/** Every unit a department has, with why each one can or cannot be sent. */
export async function availabilityFor(
  pool: Pool,
  departmentId: Uuid,
): Promise<readonly ResourceAvailability[]> {
  const [resources, commitments] = await Promise.all([
    listResources(pool, departmentId),
    commitmentsFor(pool, departmentId),
  ]);

  return resources.map((resource) => {
    const mine = commitments[resource.resourceId] ?? [];
    return { resource, blockedBy: blockedBy(resource, mine), commitments: mine };
  });
}

//------------------------------------------------------------------------------
// The registry
//------------------------------------------------------------------------------

export async function listResources(pool: Pool, _departmentId: Uuid): Promise<readonly Resource[]> {
  const { rows } = await pool.query<ResourceRow>(
    `SELECT ${COLUMNS} FROM resource
      ORDER BY retired_at IS NOT NULL, kind, name`,
  );

  const members = await pool.query<{ resource_id: string; person_id: string; full_name: string }>(
    `SELECT m.resource_id, m.person_id, p.full_name
       FROM resource_member m
       JOIN resource r ON r.resource_id = m.resource_id
       JOIN person p ON p.person_id = m.person_id
      WHERE m.to_at IS NULL AND p.removed_at IS NULL
      ORDER BY p.full_name`,
  );

  const byResource: Record<string, { personId: string; fullName: string }[]> = {};
  for (const m of members.rows) {
    (byResource[m.resource_id] ??= []).push({ personId: m.person_id, fullName: m.full_name });
  }

  return rows.map((r) => toResource(r, byResource[r.resource_id] ?? []));
}

export async function findResource(pool: Pool, resourceId: Uuid): Promise<Resource | null> {
  const { rows } = await pool.query<ResourceRow>(
    `SELECT ${COLUMNS} FROM resource WHERE resource_id = $1`,
    [resourceId],
  );
  return rows[0] === undefined ? null : toResource(rows[0]);
}

/**
 * 🔴 **THIS ASKED FOR A COLUMN MIGRATION 0039 HAD DROPPED, SO EVERY FLEET ACTION ANSWERED 500.**
 *
 * It was `departmentOfResource`, and its two callers used the answer for one thing only: a
 * `null` meant *no such unit*, and anything else went to `reach`, which since ADR-0030 ignores
 * the department it is handed. So the department was already doing nothing, and the query that
 * fetched it was the only part still able to fail — on dispatch, stand-down, rename and retire,
 * on the machine that is also taking emergency reports.
 *
 * The question those callers were really asking is **does this unit exist**, and the answer to
 * that is a 404. Exactly the fault `api/roster.ts`'s `departmentOfSeat` had, one file along, and
 * the same repair: ask the question you mean.
 */
export async function resourceExists(pool: Pool, resourceId: Uuid): Promise<boolean> {
  const { rows } = await pool.query<{ one: number }>(
    'SELECT 1 AS one FROM resource WHERE resource_id = $1',
    [resourceId],
  );
  return rows.length > 0;
}

export interface NewResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly identifier?: string | undefined;
}

async function read(tx: PoolClient, resourceId: Uuid): Promise<Resource | null> {
  const { rows } = await tx.query<ResourceRow>(
    `SELECT ${COLUMNS} FROM resource WHERE resource_id = $1`,
    [resourceId],
  );
  return rows[0] === undefined ? null : toResource(rows[0]);
}

export async function createResource(
  pool: Pool,
  _departmentId: Uuid,
  input: NewResource,
  actor: ConfigActor,
): Promise<ResourceResult<Resource>> {
  return inTransaction(pool, async (tx) => {
    // ADR-0030 — there is no department to check for, so the two refusals that read one are
    // gone. The unit belongs to the district.

    const clash = await tx.query(
      `SELECT 1 FROM resource
        WHERE lower(name) = lower($1) AND retired_at IS NULL`,
      [input.name],
    );
    if ((clash.rowCount ?? 0) > 0) {
      // ⚠️ THE NAME IS NOW UNIQUE ACROSS THE WHOLE DISTRICT, not within a department, and that
      // is the migration's own index rather than a preference here. Two live units with one name
      // make a radio call ambiguous, which is the exact failure the name exists to prevent —
      // and across one district it is a sharper refusal than it was across one department.
      return { ok: false as const, why: 'the district already has a unit with that name' };
    }

    const { rows } = await tx.query<{ resource_id: string }>(
      `INSERT INTO resource (kind, name, identifier)
       VALUES ($1, $2, $3) RETURNING resource_id`,
      [input.kind, input.name.trim(), input.identifier?.trim() ?? null],
    );
    const created = (await read(tx, rows[0]!.resource_id))!;

    await recordChange(tx, {
      subject: 'resource',
      subjectId: created.resourceId,
      action: 'created',
      before: null,
      after: { kind: created.kind, name: created.name, identifier: created.identifier },
      actor,
    });
    return { ok: true as const, value: created };
  });
}

export async function updateResource(
  pool: Pool,
  resourceId: Uuid,
  edit: { readonly name?: string; readonly identifier?: string | null },
  actor: ConfigActor,
): Promise<ResourceResult<Resource>> {
  return inTransaction(pool, async (tx) => {
    const before = await read(tx, resourceId);
    if (before === null) return { ok: false as const, why: 'no such unit' };

    const name = edit.name?.trim() ?? before.name;
    const identifier =
      edit.identifier === undefined ? before.identifier : (edit.identifier?.trim() ?? null);

    await tx.query('UPDATE resource SET name = $2, identifier = $3 WHERE resource_id = $1', [
      resourceId,
      name,
      identifier,
    ]);

    const after = (await read(tx, resourceId))!;
    await recordChange(tx, {
      subject: 'resource',
      subjectId: resourceId,
      action: 'updated',
      before: { name: before.name, identifier: before.identifier },
      after: { name, identifier },
      actor,
    });
    return { ok: true as const, value: after };
  });
}

/**
 * Take a unit off the run, or put it back.
 *
 * A reason is required, and the database requires one too. A vehicle nobody can dispatch is
 * a vehicle somebody has to decide about, and "out of service" with no reason is a decision
 * the next shift cannot act on — they do not know whether to wait an hour or find another
 * ambulance.
 */
export async function setOutOfService(
  pool: Pool,
  resourceId: Uuid,
  out: boolean,
  reason: string,
  actor: ConfigActor,
): Promise<ResourceResult<Resource>> {
  return inTransaction(pool, async (tx) => {
    const before = await read(tx, resourceId);
    if (before === null) return { ok: false as const, why: 'no such unit' };

    await tx.query(
      out
        ? `UPDATE resource SET out_of_service_at = now(), out_of_service_reason = $2
            WHERE resource_id = $1`
        : `UPDATE resource SET out_of_service_at = NULL, out_of_service_reason = NULL
            WHERE resource_id = $1`,
      out ? [resourceId, reason] : [resourceId],
    );

    const after = (await read(tx, resourceId))!;
    await recordChange(tx, {
      subject: 'resource',
      subjectId: resourceId,
      // `retired` rather than `updated` when going out of service, because that is the
      // action the reason requirement is attached to in the database.
      action: out ? 'retired' : 'restored',
      before: { name: before.name, outOfService: before.outOfServiceAt !== null },
      after: { name: after.name, outOfService: out },
      actor,
      reason,
    });
    return { ok: true as const, value: after };
  });
}

export async function setResourceRetired(
  pool: Pool,
  resourceId: Uuid,
  retired: boolean,
  reason: string,
  actor: ConfigActor,
): Promise<ResourceResult<Resource>> {
  return inTransaction(pool, async (tx) => {
    const before = await read(tx, resourceId);
    if (before === null) return { ok: false as const, why: 'no such unit' };

    await tx.query(
      `UPDATE resource SET retired_at = ${retired ? 'now()' : 'NULL'} WHERE resource_id = $1`,
      [resourceId],
    );
    if (retired) {
      // Nobody stays on the crew of a unit the department no longer has.
      await tx.query(
        'UPDATE resource_member SET to_at = now() WHERE resource_id = $1 AND to_at IS NULL',
        [resourceId],
      );
    }

    const after = (await read(tx, resourceId))!;
    await recordChange(tx, {
      subject: 'resource',
      subjectId: resourceId,
      action: retired ? 'retired' : 'restored',
      before: { name: before.name },
      after: { name: after.name },
      actor,
      reason,
    });
    return { ok: true as const, value: after };
  });
}

//------------------------------------------------------------------------------
// Team membership
//------------------------------------------------------------------------------

export async function addMember(
  pool: Pool,
  resourceId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<ResourceResult<{ readonly added: true }>> {
  return inTransaction(pool, async (tx) => {
    const resource = await read(tx, resourceId);
    if (resource === null) return { ok: false as const, why: 'no such unit' };
    if (resource.kind !== 'team') {
      // A vehicle does not have members; its crew is a team assigned alongside it. Allowing
      // this would produce two ways to express the same thing and no way to query either.
      return { ok: false as const, why: 'only a team has members' };
    }
    if (resource.retiredAt !== null) return { ok: false as const, why: 'that unit is retired' };

    const already = await tx.query(
      'SELECT 1 FROM resource_member WHERE resource_id = $1 AND person_id = $2 AND to_at IS NULL',
      [resourceId, personId],
    );
    if ((already.rowCount ?? 0) > 0) {
      return { ok: false as const, why: 'they are already on this team' };
    }

    await tx.query('INSERT INTO resource_member (resource_id, person_id) VALUES ($1, $2)', [
      resourceId,
      personId,
    ]);
    await recordChange(tx, {
      subject: 'resource',
      subjectId: resourceId,
      action: 'updated',
      before: null,
      after: { team: resource.name, added: personId },
      actor,
    });
    return { ok: true as const, value: { added: true } };
  });
}

export async function removeMember(
  pool: Pool,
  resourceId: Uuid,
  personId: Uuid,
  actor: ConfigActor,
): Promise<ResourceResult<{ readonly removed: true }>> {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE resource_member SET to_at = now()
        WHERE resource_id = $1 AND person_id = $2 AND to_at IS NULL`,
      [resourceId, personId],
    );
    if ((rowCount ?? 0) === 0) return { ok: false as const, why: 'they are not on this team' };

    await recordChange(tx, {
      subject: 'resource',
      subjectId: resourceId,
      action: 'updated',
      before: { member: personId },
      after: null,
      actor,
    });
    return { ok: true as const, value: { removed: true } };
  });
}

/** The people on a team as at some instant. "Who was on Rescue Team B that night." */
export async function membersAt(
  pool: Pool,
  resourceId: Uuid,
  at: Instant,
): Promise<readonly { readonly personId: Uuid; readonly fullName: string }[]> {
  const { rows } = await pool.query<{ person_id: string; full_name: string }>(
    `SELECT m.person_id, p.full_name
       FROM resource_member m
       JOIN person p ON p.person_id = m.person_id
      WHERE m.resource_id = $1
        AND m.from_at <= $2
        AND (m.to_at IS NULL OR m.to_at > $2)
      ORDER BY p.full_name`,
    [resourceId, at],
  );
  return rows.map((r) => ({ personId: r.person_id, fullName: r.full_name }));
}
