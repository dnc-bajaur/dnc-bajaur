/**
 * What the control room has actually done — read back out of the event log (M7-15).
 *
 * **There is no table.** This is a projection over `dispatched` events, for exactly the reason
 * the board has no board table (ADR-0001): a stored model can drift from what happened, has to
 * be migrated, and has to be corrected by editing it. This cannot drift, needs no migration, and
 * a wrong lesson is corrected by dispatching correctly — which the district was going to do
 * anyway.
 *
 * The judgement all lives in `domain/learning.ts`. This file is the query and nothing else.
 */

import type { Pool } from './pool.js';
import type { DispatchTarget } from '../domain/events.js';
import { LEARNING_STARTS_AT, type PastDispatch } from '../domain/learning.js';

/**
 * How far back to look.
 *
 * A year, and a limit, because this runs on the machine that is also accepting emergency
 * reports and it runs on **every open of the intake screen**. Bajaur dispatches perhaps forty
 * times a day; the limit is generous enough never to bite at that rate and low enough that a
 * district ten times the size still gets an answer while the operator is still typing.
 */
const LOOKBACK_DAYS = 365;
const LIMIT = 5000;

export async function loadDispatchHistory(
  pool: Pool,
  options: { readonly since?: string } = {},
): Promise<readonly PastDispatch[]> {
  /**
   * The category taken from the **first `reported` event**, not from the incident's current one.
   *
   * They diverge whenever somebody triages or overrides afterwards, and the reported one is the
   * right key here for a reason that is easy to miss: the proposal is made at **intake**, when
   * the only category that exists is what the operator has just typed. Learning against the
   * assessed category would mean training on a field the screen asking the question does not
   * have, and the proposals would be subtly wrong in exactly the cases where triage changed
   * somebody's mind — which is to say, the interesting ones.
   */
  const res = await pool.query<{ category: string | null; targets: DispatchTarget[] | null }>(
    `SELECT first.category, d.payload->'targets' AS targets
       FROM incident_event d
       JOIN LATERAL (
              SELECT r.payload->>'category' AS category
                FROM incident_event r
               WHERE r.incident_id = d.incident_id
                 AND r.type = 'reported'
               ORDER BY r.occurred_at ASC, r.client_seq ASC
               LIMIT 1
            ) first ON true
      WHERE d.type = 'dispatched'
        AND d.occurred_at >= $1::timestamptz
        AND d.occurred_at >= now() - make_interval(days => $2)
      ORDER BY d.occurred_at DESC
      LIMIT $3`,
    [options.since ?? LEARNING_STARTS_AT, LOOKBACK_DAYS, LIMIT],
  );

  const out: PastDispatch[] = [];
  for (const row of res.rows) {
    // A dispatch with no category answers no question this is asked, and one with no targets is
    // not a dispatch. Both are dropped rather than counted as an empty answer, which would drag
    // every share downwards for a reason nobody could see.
    if (row.category === null || row.targets === null || row.targets.length === 0) continue;
    out.push({ category: row.category, targets: row.targets });
  }
  return out;
}
