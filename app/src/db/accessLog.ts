/**
 * Recording and reading the access history — `access_event` (migration 0044, ADR-0032).
 *
 * The same shape `configStore.ts` follows for `config_event`: an account or access change is a
 * thing that happened, and a table holding only the current role cannot answer *"why could
 * that officer still sign in?"* at an incident review weeks later (INV-06, ADR-0001). Every
 * write path in `api/settings.ts`, plus `login()`, appends a row here.
 *
 * No authority checks live in this file. It is the store; `api/settings.ts` is the gate
 * (INV-05).
 */

import type { Pool, PoolClient } from 'pg';

export type AccessEventType =
  | 'granted'
  | 'role_changed'
  | 'permission_set'
  | 'permission_cleared'
  | 'password_reset'
  | 'password_changed'
  | 'suspended'
  | 'reactivated'
  | 'removed'
  | 'session_revoked'
  | 'login_succeeded'
  | 'login_failed'
  | 'login_link_issued'
  | 'login_link_used';

export interface AccessEventInput {
  readonly type: AccessEventType;
  /** Who performed it. Null for a `login_failed` with no session, or a system act. */
  readonly actorPersonId?: string | null;
  /** Whose account it concerns. Null for a `login_failed` against an unknown number. */
  readonly subjectPersonId?: string | null;
  /** Required by the database for `removed` and `suspended`; supplied by the UI otherwise. */
  readonly reason?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

/**
 * Append one `access_event`. Takes a `Pool` or a `PoolClient`, so a caller inside a
 * transaction records the event in the same transaction as the change it describes — the
 * `configStore` pattern.
 */
export async function recordAccessEvent(
  db: Pool | PoolClient,
  input: AccessEventInput,
): Promise<void> {
  await db.query(
    `INSERT INTO access_event
       (type, actor_person_id, subject_person_id, reason, before, after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.type,
      input.actorPersonId ?? null,
      input.subjectPersonId ?? null,
      input.reason ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
    ],
  );
}

export interface AccessEventRow {
  readonly eventId: string;
  readonly seq: number;
  readonly type: AccessEventType;
  readonly actorPersonId: string | null;
  readonly actorName: string | null;
  readonly subjectPersonId: string | null;
  readonly subjectName: string | null;
  readonly reason: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly recordedAt: string;
}

export interface AccessLogQuery {
  readonly subjectPersonId?: string;
  readonly actorPersonId?: string;
  readonly type?: AccessEventType;
  /** ISO date or timestamp — rows at or after this. */
  readonly since?: string;
  /** Page size. Clamped 1..200. */
  readonly limit?: number;
  /** Rows with `seq` strictly below this — the cursor from a previous page's last row. */
  readonly beforeSeq?: number;
}

/**
 * Read the access history, newest first.
 *
 * Names are resolved from *today's* `person` rows — the same known limitation the incident
 * timeline documents (a renamed person is renamed throughout history). The event stores the
 * id, which cannot change.
 */
export async function readAccessLog(
  db: Pool | PoolClient,
  query: AccessLogQuery = {},
): Promise<{ readonly rows: readonly AccessEventRow[]; readonly nextBeforeSeq: number | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (query.subjectPersonId) add('e.subject_person_id = $?', query.subjectPersonId);
  if (query.actorPersonId) add('e.actor_person_id = $?', query.actorPersonId);
  if (query.type) add('e.type = $?', query.type);
  if (query.since) add('e.recorded_at >= $?', query.since);
  if (typeof query.beforeSeq === 'number') add('e.seq < $?', query.beforeSeq);

  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  params.push(limit + 1);

  const res = await db.query<{
    event_id: string;
    seq: string;
    type: AccessEventType;
    actor_person_id: string | null;
    actor_name: string | null;
    subject_person_id: string | null;
    subject_name: string | null;
    reason: string | null;
    before: unknown;
    after: unknown;
    recorded_at: string;
  }>(
    `SELECT e.event_id, e.seq, e.type,
            e.actor_person_id,   a.full_name AS actor_name,
            e.subject_person_id, s.full_name AS subject_name,
            e.reason, e.before, e.after, e.recorded_at
       FROM access_event e
       LEFT JOIN person a ON a.person_id = e.actor_person_id
       LEFT JOIN person s ON s.person_id = e.subject_person_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.seq DESC
      LIMIT $${params.length}`,
    params,
  );

  const rows = res.rows.slice(0, limit).map((r): AccessEventRow => ({
    eventId: r.event_id,
    seq: Number(r.seq),
    type: r.type,
    actorPersonId: r.actor_person_id,
    actorName: r.actor_name,
    subjectPersonId: r.subject_person_id,
    subjectName: r.subject_name,
    reason: r.reason,
    before: r.before,
    after: r.after,
    recordedAt: r.recorded_at,
  }));

  const nextBeforeSeq =
    res.rows.length > limit && rows.length > 0 ? rows[rows.length - 1]!.seq : null;

  return { rows, nextBeforeSeq };
}
