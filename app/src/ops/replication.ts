/**
 * Is the standby keeping up? — M0-54, ADR-0011.
 *
 * ADR-0011 puts a warm standby in the AC Headquarter office: two machines, one record. The
 * decision it turns on is that **two independent primaries would give Bajaur two divergent
 * histories and no way to merge them** — so the standby is read-only and exists for one
 * night, the one where the DC office machine does not come back.
 *
 * That only works if somebody notices when it stops replicating. A standby that fell behind
 * three weeks ago and told nobody is not a standby; it is a comforting fiction, and the
 * district finds out at the moment it is relied on. So the lag goes on `/health`, beside the
 * backup age, for the same reason and with the same argument.
 *
 * **Reported, never enforced.** `/health` returns `degraded` at 200 and never a failing
 * status code. A 503 because replication is behind would take the node out of a load balancer
 * and stop the district reporting emergencies — INV-01 outranks a lagging standby, and an
 * operator who cannot file a report has no way to know replication was the reason.
 */

import type { Pool } from '../db/pool.js';

/**
 * How far behind the standby may fall before it is worth saying so.
 *
 * Sixty seconds. Streaming replication over a link between two offices in the same town is
 * normally sub-second, so a minute is already an anomaly rather than a threshold to tune. The
 * number that matters operationally is not this one — it is that somebody looks.
 */
export const REPLICATION_LAG_WARN_SECONDS = 60;

export type ReplicationRole = 'primary' | 'standby' | 'standalone';

export interface ReplicationHealth {
  readonly role: ReplicationRole;
  /** Configured standbys currently connected. Zero on a primary that has lost its standby. */
  readonly connectedStandbys: number;
  /** Seconds the furthest-behind standby is trailing. Null when there is nothing to measure. */
  readonly lagSeconds: number | null;
  readonly ok: boolean;
  /** Why it is not ok, in words an operator can act on. Null when it is. */
  readonly why: string | null;
}

/**
 * Ask Postgres directly.
 *
 * `pg_stat_replication` on the primary lists connected standbys and how far each has applied.
 * `pg_is_in_recovery()` distinguishes a standby from a primary. Nothing here is stored, for
 * the same reason resource availability is not: a cached answer about whether the other
 * machine is keeping up would be exactly the fiction this exists to prevent.
 *
 * A district running one node — which is where it starts, until R-07 — reports `standalone`
 * and `ok: false`. That is honest: one machine is a single point of failure for the whole
 * district's record, and it should be visible on the health endpoint rather than assumed.
 */
export async function replicationHealth(pool: Pool): Promise<ReplicationHealth> {
  const recovery = await pool.query<{ standby: boolean }>('SELECT pg_is_in_recovery() AS standby');

  if (recovery.rows[0]?.standby === true) {
    // Reading from the standby itself. Useful during a failover drill, and it should never
    // be the thing the district's app is pointed at in normal operation.
    const behind = await pool.query<{ lag: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8 AS lag`,
    );
    const lag = behind.rows[0]?.lag ?? null;
    const ok = lag !== null && lag <= REPLICATION_LAG_WARN_SECONDS;

    return {
      role: 'standby',
      connectedStandbys: 0,
      lagSeconds: lag === null ? null : Math.round(lag),
      ok,
      why: ok
        ? null
        : `this node is a standby and is ${lag === null ? 'not replaying at all' : `${String(Math.round(lag))}s behind`}`,
    };
  }

  const standbys = await pool.query<{ n: string; lag: number | null }>(
    `SELECT count(*)::text AS n,
            max(EXTRACT(EPOCH FROM (now() - reply_time)))::float8 AS lag
       FROM pg_stat_replication`,
  );

  const connected = Number(standbys.rows[0]?.n ?? 0);
  const lag = standbys.rows[0]?.lag ?? null;

  if (connected === 0) {
    return {
      role: 'standalone',
      connectedStandbys: 0,
      lagSeconds: null,
      ok: false,
      why:
        'no standby is connected — the district is running on one machine, so a failure of ' +
        'this one stops Bajaur until it is repaired (ADR-0011, R-07)',
    };
  }

  const behind = lag !== null && lag > REPLICATION_LAG_WARN_SECONDS;
  return {
    role: 'primary',
    connectedStandbys: connected,
    lagSeconds: lag === null ? null : Math.round(lag),
    ok: !behind,
    why: behind
      ? `the standby is ${String(Math.round(lag))}s behind — a failover now would lose that much of the record`
      : null,
  };
}

/**
 * The same question, safe to call on a cluster that cannot answer it.
 *
 * `pg_stat_replication` needs `pg_monitor` or superuser. A district whose application role
 * has neither would otherwise turn `/health` into a 500 — the endpoint everything else keys
 * off, broken by a permission on a diagnostic. Reported as "cannot tell", which is a
 * different and more honest answer than "fine".
 */
export async function replicationHealthSafe(pool: Pool): Promise<ReplicationHealth> {
  try {
    return await replicationHealth(pool);
  } catch (err) {
    return {
      role: 'standalone',
      connectedStandbys: 0,
      lagSeconds: null,
      ok: false,
      why: `cannot read replication state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
