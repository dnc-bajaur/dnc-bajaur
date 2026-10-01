/**
 * Giving an incident the district's own number — 2026-08-24.
 *
 * `DNC-BAJAUR-42`. The shape and the reasoning are in `domain/reference.ts`; the schema and the
 * three properties it has to hold are in `db/migrations/0035_incident_reference.sql`. This file
 * is the only thing that writes the table.
 *
 * **There is one entry point and it is a sweep, not an insert.** `assignReferences` numbers
 * *everything* that is unnumbered, in arrival order, whether it arrived a second ago or in
 * March. That shape is what makes the feature safe to bolt onto a district that has been
 * running for a month:
 *
 *   * the **existing record numbers itself** on the first boot after this ships, in one call,
 *     with no backfill script anybody has to remember to run;
 *   * an assignment that fails — the database restarting mid-request, a lock timeout — is
 *     **repaired by the next append**, rather than leaving one incident permanently unnumbered;
 *   * it is **idempotent**, so calling it on every append and again at boot costs a query that
 *     normally finds nothing.
 *
 * ⚠️ **It must never be called inside the append transaction.** The record is stored first and
 * the number is a convenience; an emergency rolled back because a counter could not be
 * incremented is INV-01 failing for the smallest possible reason.
 */

import type { Uuid } from '../domain/events.js';
import type { Pool } from './pool.js';

/** What one sweep did. Returned so a caller can log a backfill without querying again. */
export interface ReferenceAssignment {
  readonly incidentId: string;
  readonly seq: number;
}

/**
 * The lock every sweep takes before reading `MAX(seq)`.
 *
 * `MAX + n` is only gapless if two sweeps cannot read the same maximum, and this is a
 * transaction-scoped advisory lock so it is released by COMMIT or ROLLBACK — there is no path
 * where a crashed request leaves the counter locked. `hashtext` of the table name rather than a
 * magic integer, so a second feature reaching for an advisory lock cannot silently pick the
 * same one.
 */
const LOCK = `SELECT pg_advisory_xact_lock(hashtext('incident_reference'))`;

/**
 * Number every incident that has been reported and has no number yet.
 *
 * Ordered by when the server first recorded the report — see the migration for why that, and
 * not `occurred_at`, is the only ordering an append-only counter can have.
 *
 * `ON CONFLICT DO NOTHING` on top of the anti-join is belt and braces: the join already
 * excludes numbered incidents, and a concurrent sweep that slipped between the two is exactly
 * what the lock above prevents. It is here so that if the lock is ever removed by somebody who
 * thinks it is redundant, the failure is a missing number and not a raised exception on the
 * write path of an emergency.
 */
export async function assignReferences(pool: Pool): Promise<readonly ReferenceAssignment[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(LOCK);

    const res = await client.query<{ incident_id: string; seq: string }>(
      `WITH unnumbered AS (
         SELECT e.incident_id,
                MIN(e.recorded_at)      AS first_recorded,
                MIN(e.event_id::text)   AS tiebreak
           FROM incident_event e
           LEFT JOIN incident_reference r ON r.incident_id = e.incident_id
          WHERE e.type = 'reported'
            AND r.incident_id IS NULL
          GROUP BY e.incident_id
       ),
       ordered AS (
         SELECT incident_id,
                ROW_NUMBER() OVER (ORDER BY first_recorded, tiebreak) AS n
           FROM unnumbered
       )
       INSERT INTO incident_reference (incident_id, seq)
       SELECT o.incident_id, (SELECT COALESCE(MAX(seq), 0) FROM incident_reference) + o.n
         FROM ordered o
       ON CONFLICT (incident_id) DO NOTHING
       RETURNING incident_id, seq`,
    );

    await client.query('COMMIT');

    // bigint arrives as a string from pg — the driver refuses to lose precision silently, and
    // a number rendered as "42" on the board is not the same thing as one rendered as `"42"`.
    return res.rows.map((r) => ({ incidentId: r.incident_id, seq: Number(r.seq) }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The numbers for a set of incidents, by id.
 *
 * One query for a whole board, never one per row — the same rule `dispatchNames` and the actor
 * directory already follow. Forty rows each fetching their own number is forty round trips on
 * the screen the control room leaves open all night.
 *
 * An incident with no row is **absent from the map, not zero**. Nothing has ever been numbered
 * 0, and a caller reading a missing number as one would print `DNC-BAJAUR-0` on a report.
 */
export async function referencesFor(
  pool: Pool,
  incidentIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const out = new Map<string, number>();
  if (incidentIds.length === 0) return out;

  const res = await pool.query<{ incident_id: string; seq: string }>(
    'SELECT incident_id, seq FROM incident_reference WHERE incident_id = ANY($1::uuid[])',
    [incidentIds],
  );
  for (const r of res.rows) out.set(r.incident_id, Number(r.seq));
  return out;
}

/** One incident's number, or null if the sweep has not reached it yet. */
export async function referenceFor(pool: Pool, incidentId: Uuid): Promise<number | null> {
  const res = await pool.query<{ seq: string }>(
    'SELECT seq FROM incident_reference WHERE incident_id = $1',
    [incidentId],
  );
  const row = res.rows[0];
  return row === undefined ? null : Number(row.seq);
}

/**
 * Which incident carries this number, if any.
 *
 * The lookup search does when somebody types `DNC-BAJAUR-42`. Returns null rather than throwing
 * for a number never issued: asking for an emergency that does not exist is an ordinary empty
 * result, not an error.
 */
export async function incidentForReference(pool: Pool, seq: number): Promise<string | null> {
  const res = await pool.query<{ incident_id: string }>(
    'SELECT incident_id FROM incident_reference WHERE seq = $1',
    [seq],
  );
  return res.rows[0]?.incident_id ?? null;
}
