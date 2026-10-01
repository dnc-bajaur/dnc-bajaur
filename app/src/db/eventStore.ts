import type { IncidentEvent, Uuid } from '../domain/events.js';
import type { Pool } from './pool.js';
import { announceBoardChange } from './boardStream.js';
import { assignReferences } from './referenceStore.js';
import { log } from '../obs/log.js';

/**
 * The only way events enter and leave the system.
 *
 * There is no update method and no delete method, and that is not an oversight — it is
 * the interface making ADR-0001 impossible to violate by accident. The database enforces
 * the same rule independently (see 0001_event_store.sql), because one of the two will
 * eventually be bypassed.
 */

export interface AppendResult {
  /** Events written for the first time. */
  readonly appended: number;
  /** Events already present, recognised by `eventId` and skipped. */
  readonly duplicates: number;
}

interface Row {
  event_id: string;
  incident_id: string;
  type: string;
  occurred_at: string;
  recorded_at: string;
  client_seq: number;
  seq: string;
  actor_person_id: string | null;
  actor_seat_id: string | null;
  source_channel: string;
  payload: Record<string, unknown>;
}

function toDomain(r: Row): IncidentEvent {
  return {
    eventId: r.event_id,
    incidentId: r.incident_id,
    type: r.type,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    clientSeq: r.client_seq,
    actorPersonId: r.actor_person_id,
    actorSeatId: r.actor_seat_id,
    sourceChannel: r.source_channel,
    payload: r.payload,
  } as IncidentEvent;
}

/**
 * Append events. Re-appending an event already stored is a no-op, not an error.
 *
 * This is what lets an offline client retry a sync it is not sure landed, and what stops
 * a reconnect from replaying a queue into duplicates (INV-08). The caller does not have
 * to know which of its events the server already has.
 */
export async function append(pool: Pool, events: readonly IncidentEvent[]): Promise<AppendResult> {
  if (events.length === 0) return { appended: 0, duplicates: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      const b = i * 9;
      values.push(
        e.eventId,
        e.incidentId,
        e.type,
        e.occurredAt,
        e.clientSeq,
        e.actorPersonId,
        e.actorSeatId,
        e.sourceChannel,
        JSON.stringify(e.payload),
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4}::timestamptz,$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb)`;
    });

    // recorded_at is set by the server, never by the client. A device with a wrong clock
    // can misreport when something happened; it must not be able to misreport when we
    // learned of it, because that is what escalation timing depends on.
    const res = await client.query(
      `INSERT INTO incident_event
         (event_id, incident_id, type, occurred_at, client_seq, actor_person_id, actor_seat_id, source_channel, payload)
       VALUES ${tuples.join(',')}
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      values,
    );

    await client.query('COMMIT');
    const appended = res.rowCount ?? 0;

    // After COMMIT, not before: a subscriber acting on this must be able to read what it was
    // just told about. `res.rows` is only the newly-inserted ones (`RETURNING event_id` on a
    // query with `ON CONFLICT DO NOTHING`), so a batch that was entirely duplicates announces
    // nothing — a retried sync must not make the board flicker for every seat watching it.
    if (appended > 0) {
      const insertedIds = new Set(res.rows.map((r: { event_id: string }) => r.event_id));
      const inserted = events.filter((e) => insertedIds.has(e.eventId));
      const changedIncidents = [...new Set(inserted.map((e) => e.incidentId))];

      /**
       * **The district's own number, before anybody is told the board changed** — 2026-08-24.
       *
       * Only when this batch carried a report. Every other event belongs to an incident that
       * was numbered when its `reported` arrived, so sweeping on an acknowledgement would be a
       * query per acknowledgement that can only ever find nothing.
       *
       * ⚠️ **After COMMIT and inside a `catch` that swallows.** The number is a convenience and
       * the record is the record: an emergency that is safely stored must not be reported as
       * failed because a counter could not be incremented (INV-01). An incident that misses its
       * number here has no number until the next report arrives or the server restarts, and
       * `assignReferences` is a sweep precisely so that both of those repair it.
       *
       * Before `announceBoardChange`, not after, so a seat watching the board reads the row
       * with its number already on it rather than watching one appear a moment later.
       */
      if (inserted.some((e) => e.type === 'reported')) {
        try {
          await assignReferences(pool);
        } catch (err) {
          log('warn', 'incident reference not assigned', {
            incidents: changedIncidents.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      announceBoardChange(changedIncidents);
    }

    return { appended, duplicates: events.length - appended };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Every event for one incident, in fold order. Must match `compareEvents`. */
export async function loadIncident(
  pool: Pool,
  incidentId: Uuid,
): Promise<readonly IncidentEvent[]> {
  const res = await pool.query<Row>(
    `SELECT * FROM incident_event
      WHERE incident_id = $1
      ORDER BY occurred_at, client_seq, recorded_at, event_id`,
    [incidentId],
  );
  return res.rows.map(toDomain);
}

/**
 * Every event, grouped by incident, for incidents seen in the last `days`.
 *
 * One query, not one per incident. The board is the first thing that needs many incidents
 * at once, and folding N incidents with N round trips would make the district's live view
 * get slower exactly as the district gets busier.
 *
 * The SQL narrows candidates by recency and nothing else. **It does not decide what is
 * open** — that is the fold's answer, and expressing it here in a second language is how
 * the escalation rule nearly ended up defined twice (see `jobs/escalation.ts`).
 */
export interface SearchCriteria {
  /** Bounds on when the emergency **happened**, not when we learned of it. Always present. */
  readonly from: string;
  readonly to: string;
  /** Matched against the reporter's own words and the place, case-insensitively. */
  readonly text?: string | undefined;
  readonly limit: number;
}

/**
 * Incidents matching a search, as whole event streams ready to fold.
 *
 * **The range is on `occurred_at`, not `recorded_at`, and that is load-bearing.** Search asks
 * "what happened during the floods"; the board asks "what has arrived lately". A report
 * captured offline in March and delivered in August has `occurred_at` in March — so filtering
 * on arrival would file it under the day the network came back, and the district's worst
 * weeks, when devices were offline longest, would be exactly the weeks that searched emptiest
 * (ADR-0002). Migration 0019 adds the index this needs.
 *
 * **Always bounded by a date range**, and the caller is not allowed to omit it. The event log
 * is the record and grows forever; an unbounded `ILIKE` across it would scan every emergency
 * the district has ever had, on the one machine that is also accepting new ones.
 *
 * **The text match is deliberately unindexed.** A trigram index would need `pg_trgm` and a
 * migration, and at Bajaur's volume — a district, not a country — a bounded range already
 * reduces this to a scan of the window somebody asked for. If that stops being true, the fix
 * is an index and not a smaller window: a search that silently stops looking at older
 * emergencies is worse than a slow one.
 *
 * The `LIMIT` is on distinct incidents, applied before the events are fetched, so a single
 * long-running incident cannot crowd out the rest of a page.
 */
export async function loadIncidentsMatching(
  pool: Pool,
  criteria: SearchCriteria,
): Promise<readonly (readonly IncidentEvent[])[]> {
  const text = criteria.text?.trim();
  const hasText = text !== undefined && text.length > 0;

  const res = await pool.query<Row>(
    `WITH matched AS (
       SELECT incident_id, MIN(occurred_at) AS first_seen
         FROM incident_event
        WHERE occurred_at >= $1::timestamptz
          AND occurred_at <= $2::timestamptz
          AND ($4::boolean IS FALSE OR (
                COALESCE(payload->>'description', '') ILIKE $3
             OR COALESCE(payload->>'place', '') ILIKE $3
             OR COALESCE(payload->>'category', '') ILIKE $3
          ))
        GROUP BY incident_id
        ORDER BY first_seen DESC
        LIMIT $5
     )
     SELECT e.*
       FROM incident_event e
       JOIN matched m ON m.incident_id = e.incident_id
      ORDER BY e.incident_id, e.occurred_at, e.client_seq, e.recorded_at, e.event_id`,
    [criteria.from, criteria.to, hasText ? `%${text}%` : '%', hasText, criteria.limit],
  );

  const byIncident = new Map<string, IncidentEvent[]>();
  for (const row of res.rows) {
    const events = byIncident.get(row.incident_id);
    if (events === undefined) byIncident.set(row.incident_id, [toDomain(row)]);
    else events.push(toDomain(row));
  }
  return [...byIncident.values()];
}

export async function loadRecentIncidents(
  pool: Pool,
  days = 7,
  limit = 500,
): Promise<readonly (readonly IncidentEvent[])[]> {
  const res = await pool.query<Row>(
    `WITH recent AS (
       SELECT incident_id, MIN(recorded_at) AS first_seen
         FROM incident_event
        WHERE recorded_at > now() - make_interval(days => $1)
        GROUP BY incident_id
        ORDER BY first_seen DESC
        LIMIT $2
     )
     SELECT e.*
       FROM incident_event e
       JOIN recent r ON r.incident_id = e.incident_id
      ORDER BY e.incident_id, e.occurred_at, e.client_seq, e.recorded_at, e.event_id`,
    [days, limit],
  );

  const byIncident = new Map<string, IncidentEvent[]>();
  for (const row of res.rows) {
    const events = byIncident.get(row.incident_id);
    if (events === undefined) byIncident.set(row.incident_id, [toDomain(row)]);
    else events.push(toDomain(row));
  }
  return [...byIncident.values()];
}

/**
 * **The things that do not finish at midnight, whatever day they started on** — 2026-08-22.
 *
 * `loadRecentIncidents` counts back in whole days from now, and that is right for every screen
 * built on it. It is wrong for exactly one question. The district's headline complaint was that
 * **a meeting notice issued on Saturday for Monday disappears on Sunday** — and the seven-day
 * window is the other half of the same failure: a meeting three weeks out ages out of it on day
 * eight, so widening the day rule alone would have fixed the near case and left the far one.
 *
 * ⚠️ **Its own loader rather than a wider window on the existing one, deliberately.** Asking
 * `loadRecentIncidents` for a year would drag the dashboard through months of history on every
 * poll, on the one machine also accepting emergency reports — to find a handful of rows. These
 * are few by construction: they are what a control room has not finished.
 *
 * ## The query NARROWS; the fold DECIDES
 *
 * `jobs/escalation.ts`'s own rule, applied again: *"the escalation rule is never duplicated in
 * SQL — the query narrows candidates, `checkEscalation` decides"*. So this returns a **superset**
 * and `domain/carrying.ts` has the only vote that counts:
 *
 *   * the kinds and categories come from `carrying.ts` **as parameters**, so there is no second
 *     copy of the district's five living in a string here;
 *   * an incident the control room has explicitly **held** is a candidate whatever it is about,
 *     because `held_over` overrides the default (Q7);
 *   * anything resolved or closed is dropped **unless it was reopened**, which is the cheap SQL
 *     proxy for *not finished*. It is deliberately generous in the direction the fold can undo:
 *     a candidate that turns out to be finished is dropped by `outlivesTheDay`'s caller, while a
 *     candidate never selected is a row nobody can see.
 *
 * `limit` is small on purpose and is a **safety rail rather than a page**: if a district ever
 * has more carried items than this, the panel's own "and N more" is already lying and the
 * honest fix is the control room closing things, not a bigger number here.
 */
export async function loadCarriedIncidents(
  pool: Pool,
  kinds: readonly string[],
  categories: readonly string[],
  limit = 300,
): Promise<readonly (readonly IncidentEvent[])[]> {
  const res = await pool.query<Row>(
    `WITH candidate AS (
       SELECT incident_id
         FROM incident_event
        GROUP BY incident_id
       HAVING (
                bool_or(type = 'held_over')
                OR bool_or(
                     type = 'reported'
                     AND (payload->>'kind' = ANY($1) OR payload->>'category' = ANY($2))
                   )
              )
          AND (
                NOT bool_or(type IN ('resolved', 'closed'))
                OR bool_or(type = 'reopened')
              )
        ORDER BY MIN(recorded_at) DESC
        LIMIT $3
     )
     SELECT e.*
       FROM incident_event e
       JOIN candidate c ON c.incident_id = e.incident_id
      ORDER BY e.incident_id, e.occurred_at, e.client_seq, e.recorded_at, e.event_id`,
    [kinds, categories, limit],
  );

  const byIncident = new Map<string, IncidentEvent[]>();
  for (const row of res.rows) {
    const events = byIncident.get(row.incident_id);
    if (events === undefined) byIncident.set(row.incident_id, [toDomain(row)]);
    else events.push(toDomain(row));
  }
  return [...byIncident.values()];
}

/**
 * The server's current position in the log.
 *
 * Exists because the alternative kept being "read a big page and take its `nextCursor`",
 * which is only the end of the log while the log is smaller than the page. Two tests were
 * written that way, passed for months, and started failing the day the test database grew
 * past ten thousand events — a cursor that silently stops meaning "the end" is exactly the
 * failure `loadSince` warns about in its own comment.
 */
export async function currentCursor(pool: Pool): Promise<number> {
  const res = await pool.query<{ max: string | null }>(
    'SELECT MAX(seq)::text AS max FROM incident_event',
  );
  return Number(res.rows[0]?.max ?? 0);
}

export interface Page {
  readonly events: readonly IncidentEvent[];
  /** Pass back as `cursor` to continue. */
  readonly nextCursor: number;
}

/**
 * Everything recorded since a cursor. The basis for realtime fan-out and for a client
 * catching up after reconnection — replay from a position, not from the beginning.
 *
 * The cursor is `seq`, not a timestamp. A timestamp cursor silently skips events that
 * share a `recorded_at`, and every event written in one transaction shares one — so a
 * client resuming mid-batch would lose the rest of it, permanently and invisibly. That is
 * the same root cause as the ordering bug in migration 0002.
 */
export async function loadSince(pool: Pool, cursor = 0, limit = 500): Promise<Page> {
  const res = await pool.query<Row>(
    `SELECT * FROM incident_event
      WHERE seq > $1
      ORDER BY seq
      LIMIT $2`,
    [cursor, limit],
  );
  const last = res.rows.at(-1);
  return {
    events: res.rows.map(toDomain),
    nextCursor: last ? Number(last.seq) : cursor,
  };
}

/**
 * Incidents whose first event reached us well after it happened.
 *
 * Not a diagnostic curiosity. This is the district's measured connectivity picture, and
 * the gap is exactly what the DC needs to see — an emergency that took two hours to
 * surface is an operational risk regardless of how fast the response was afterwards.
 */
export async function lateArrivals(
  pool: Pool,
  thresholdMinutes = 15,
): Promise<readonly { incidentId: Uuid; gapMinutes: number }[]> {
  const res = await pool.query<{ incident_id: string; gap_minutes: string }>(
    `SELECT incident_id,
            EXTRACT(EPOCH FROM (recorded_at - occurred_at)) / 60 AS gap_minutes
       FROM incident_event
      WHERE recorded_at - occurred_at > make_interval(mins => $1)
      ORDER BY gap_minutes DESC`,
    [thresholdMinutes],
  );
  return res.rows.map((r) => ({
    incidentId: r.incident_id,
    gapMinutes: Number(r.gap_minutes),
  }));
}
