/**
 * WhatsApp → Activities: the minute-by-minute sweep (ADR-0040, Bajaur — phase D).
 *
 * An officer with an open emergency who sends a picture is asked *emergency report or daily
 * activity?*. If they have not tapped within the hour, this sends the picture to that emergency,
 * exactly as *Emergency report* would (ADR-0041 §3); a tap interrupted mid-way goes to the DC's
 * Pending list. Anything held past the 30-day rule is deleted.
 * The work is `sweepInbound` in `api/whatsappActivities.ts`; this only runs it on a timer.
 *
 * **Who restarts it, and how do they know?** It is a timer inside the server process, like the
 * Activities housekeeping beside it: it lives and dies with the server, and a pass that throws is
 * logged at `error` and the next minute tries again. A picture that waits a few minutes longer for
 * the Pending list is the whole cost of a missed pass.
 */

import type { Pool } from '../db/pool.js';
import {
  sweepInbound,
  type EmergencyPathFor,
  type InboundSweep,
} from '../api/whatsappActivities.js';
import { log } from '../obs/log.js';

const CHECK_INTERVAL_MS = 60_000;

export interface InboundSweeper {
  start(): void;
  stop(): void;
  /** One pass now. Null if a pass was already running, or this one threw. */
  tick(): Promise<InboundSweep | null>;
}

export function createInboundSweeper(options: {
  readonly pool: Pool;
  readonly root: string;
  /**
   * Today's evidence path, for a picture whose officer did not answer within the hour (ADR-0041
   * §3). Absent when the district has no WhatsApp account — then nothing was ever asked.
   */
  readonly emergencyFor?: EmergencyPathFor;
  readonly intervalMs?: number;
}): InboundSweeper {
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<InboundSweep | null> {
    if (running) return null;
    running = true;
    try {
      const o = await sweepInbound(options.pool, options.root, options.emergencyFor);
      if (o.unanswered > 0 || o.expired > 0) log('info', 'WhatsApp activities sweep', { ...o });
      return o;
    } catch (err) {
      // A failed pass must never stop the timer; the next one tries again.
      log('error', 'WhatsApp activities sweep threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
