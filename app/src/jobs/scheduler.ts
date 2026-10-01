/**
 * The scheduler.
 *
 * Deliberately not a job queue. ADR-0007 allows a Postgres-backed queue for background
 * work, and notification retries will genuinely need one — but SLA escalation is a
 * periodic *scan*, not a set of enqueued items, and building a queue to hold one recurring
 * task would be operational surface bought for nothing.
 *
 * Two instances running at once must not both escalate the same incident. A Postgres
 * advisory lock gives that in one line, with no extra table, no leader election and
 * nothing new for anyone to debug at 02:00.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import { withContext } from '../obs/log.js';
import type { SlaTargets } from '../domain/sla.js';
import { runEscalationPass, type EscalationOutcome } from './escalation.js';
import { runNotifyPass, type NotificationChannel, type NotifyOutcome } from './notify.js';
import { runProactivePass, type ProactiveOptions, type ProactiveOutcome } from './proactive.js';

/**
 * Arbitrary but fixed. Advisory locks are keyed by number and share one namespace across
 * the database, so this must not collide with any other lock the application takes.
 */
const ESCALATION_LOCK_KEY = 4_112_026;

export interface SchedulerOptions {
  readonly pool: Pool;
  /** How often to scan. Must be well below the tightest SLA target. */
  readonly intervalMs?: number;
  /**
   * Acknowledgement deadlines. These are operational commitments made by the departments
   * and the DC office, not engineering constants — see Q-06. Injectable so they can come
   * from configuration once those numbers are agreed.
   */
  readonly targets?: SlaTargets;
  readonly onOutcome?: (outcome: EscalationOutcome) => void;
  readonly onNotify?: (outcome: NotifyOutcome) => void;
  readonly onError?: (error: unknown) => void;
  /** Injectable so a test can supply a channel that fails on purpose. */
  readonly channel?: NotificationChannel;
  /**
   * WhatsApp, when the district has an account — ADR-0014, M6-18.
   *
   * Absent is the normal state until R-05, R-19 and R-20 are done. **Beside the inbox, never
   * below it**: this is one channel, not the second rung of a ladder.
   */
  readonly whatsapp?: NotificationChannel;
  /**
   * The 24-hour service window, used without being asked — Phase 5, ADR-0014.
   *
   * ⚠️ **Absent is the ordinary state and absent means silence.** `main.ts` passes this only when
   * `WHATSAPP_PROACTIVE` names something, so on a district that has not set it there is no
   * proactive pass in the tick at all — the guarantee is made twice, here by not constructing the
   * work and again in `runProactivePass` by refusing to do it.
   */
  readonly proactive?: ProactiveOptions;
}

export interface PassOutcome {
  readonly escalation: EscalationOutcome;
  readonly notification: NotifyOutcome;
  /** Absent when the district has not switched any proactive message on, which is the default. */
  readonly proactive?: ProactiveOutcome;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Run one pass now, respecting the lock. Exposed for tests and for an operator. */
  tick(): Promise<PassOutcome | null>;
}

/**
 * Run one pass if this instance can take the lock.
 *
 * Returns null when another instance holds it — which is a normal outcome, not a failure.
 * The lock is released in a `finally` so a thrown pass cannot wedge every future tick.
 */
export async function runLockedPass(
  pool: Pool,
  targets?: SlaTargets,
  channel?: NotificationChannel,
  whatsapp?: NotificationChannel,
  proactive?: ProactiveOptions,
): Promise<PassOutcome | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ESCALATION_LOCK_KEY],
    );
    if (got.rows[0]?.locked !== true) return null;

    try {
      // Escalation first, then notification, and the order matters: an escalation appended
      // this tick moves the obligation to a new seat, and the notify pass reads state, so
      // that seat is told in the same tick rather than one interval later. A minute of
      // silence after an escalation is a minute nobody is moving.
      const escalation = await runEscalationPass(pool, targets === undefined ? {} : { targets });
      const notification = await runNotifyPass(pool, {
        ...(channel === undefined ? {} : { channel }),
        ...(whatsapp === undefined ? {} : { whatsapp }),
      });

      /**
       * **Last, and it is the only order that is defensible** — Phase 5.
       *
       * A nudge exists to be read *before* the ladder climbs, so running it before the escalation
       * pass would be its natural home. It runs after anyway, because this pass sends a message to
       * a handset over the network and **nothing that does that may sit between an emergency and
       * its escalation.** A slow Meta would delay the ladder itself, which is INV-07 traded away
       * for a courtesy. The cost is that a nudge computed on this tick reflects state from moments
       * ago; `checkNudge`'s own lead time is minutes wide and does not notice.
       *
       * Never in `notifyNow`: that path exists so a dispatch is not fifteen seconds behind an
       * operator's finger, and it must stay the smallest thing that achieves it.
       */
      const proactiveOutcome =
        proactive === undefined ? undefined : await runProactivePass(pool, proactive);

      return {
        escalation,
        notification,
        ...(proactiveOutcome === undefined ? {} : { proactive: proactiveOutcome }),
      };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ESCALATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Notify one incident **now**, without waiting for the next tick — M6-04.
 *
 * The control room dispatches on a live telephone call. Fifteen seconds of an operator watching
 * a screen that has not yet said anybody was told is fifteen seconds in which they reach for the
 * personal handset this feature exists to replace.
 *
 * **Under the same advisory lock as the scheduler**, and that is the whole reason this lives
 * here rather than being a call to `runNotifyPass` from the request handler. Two passes reading
 * the same state concurrently would both find the obligation unattempted and both append —
 * `alreadyAttempted` compares against the log, so it is only idempotent against passes that do
 * not overlap. That is a notification storm caused by promptness (INV-08).
 *
 * Returns null when the scheduler holds the lock, which is a normal outcome and not a failure:
 * the pass already running will see this incident, or the next one will within the interval. The
 * caller must not treat null as an error, and must never retry in a loop.
 */
export async function notifyNow(
  pool: Pool,
  incidentId: string,
  channel?: NotificationChannel,
  whatsapp?: NotificationChannel,
): Promise<NotifyOutcome | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ESCALATION_LOCK_KEY],
    );
    if (got.rows[0]?.locked !== true) return null;

    try {
      return await runNotifyPass(pool, {
        incidentIds: [incidentId],
        ...(channel === undefined ? {} : { channel }),
        ...(whatsapp === undefined ? {} : { whatsapp }),
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ESCALATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { pool } = options;
  const intervalMs = options.intervalMs ?? 15_000;

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;
  let stopped = false;

  async function tick(): Promise<PassOutcome | null> {
    try {
      // Each pass gets its own correlation id, so the escalations and notifications one
      // tick produced are a single story in the log rather than scattered lines nobody can
      // group (M0-03). A request-triggered action and a scheduled one are also then
      // distinguishable, which matters when working out why a seat was notified at 02:14.
      const outcome = await withContext({ correlationId: randomUUID(), job: 'scheduler' }, () =>
        runLockedPass(pool, options.targets, options.channel, options.whatsapp, options.proactive),
      );
      if (outcome !== null) {
        options.onOutcome?.(outcome.escalation);
        options.onNotify?.(outcome.notification);
      }
      return outcome;
    } catch (err) {
      // A failed pass must never kill the scheduler. An escalation loop that stops after
      // one bad database moment is worse than no escalation loop, because everyone
      // believes it is still watching.
      options.onError?.(err);
      return null;
    }
  }

  return {
    start(): void {
      if (timer !== null || stopped) return;
      timer = setInterval(() => {
        // Skip a tick rather than overlap. A slow pass must not stack up behind itself.
        if (running !== null) return;
        running = tick().finally(() => {
          running = null;
        });
      }, intervalMs);
      // Do not hold the process open on this alone.
      timer.unref?.();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // Let an in-flight pass finish, so shutdown never leaves a half-written escalation.
      if (running !== null) await running.catch(() => undefined);
    },

    tick,
  };
}
