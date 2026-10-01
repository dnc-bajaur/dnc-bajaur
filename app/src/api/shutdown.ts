/**
 * Stopping the server without taking the district off the air for ninety seconds — O-29.
 *
 * ## The defect this exists to fix
 *
 * `shutdown()` awaited `new Promise((r) => server.close(() => r()))`, and **Node's
 * `server.close()` waits for every open connection to end.** `/board/live` is a connection
 * deliberately held open for ever — `server.ts` calls `req.socket.setTimeout(0)` on it and
 * heartbeats it every 25 seconds precisely so nothing reclaims it, and `sw.ts` keeps it out of
 * the cache for the same reason. So **one control-room tab left open anywhere made the shutdown
 * hang**, `TimeoutStopSec=90s` ran out, and systemd killed the process:
 *
 * ```
 * dnc.service: State 'stop-sigterm' timed out. Killing.
 * dnc.service: Main process exited, code=killed, status=9/KILL
 * ```
 *
 * That happened on **all seven restarts in the fortnight to 2026-08-16**, so every deploy was a
 * ninety-second hole in which Bajaur could not report an emergency — INV-01's whole subject — and
 * `"stopped"` never once reached the journal. Nothing was ever lost or corrupted: the record is
 * an append-only log and the kill lands after the writes.
 *
 * ## The shape, and why each step is in this order
 *
 * 1. **Stop accepting.** `close()` refuses new connections immediately; its callback fires only
 *    when the existing ones have all ended.
 * 2. **Drop the idle ones at once.** `closeIdleConnections()` takes the keep-alive sockets that
 *    are between requests. Nobody is waiting on those, so there is nothing to be polite about.
 * 3. **Give whatever is genuinely in flight a moment**, then take the rest. A request that is
 *    mid-write gets its couple of seconds; a stream that would never end gets cut. **The grace is
 *    small on purpose** — this is a shutdown, and the alternative to cutting an SSE stream is not
 *    a tidier shutdown, it is SIGKILL ninety seconds later.
 *
 * **It reports which of the two happened rather than returning void.** A shutdown that had to
 * force connections is a normal outcome here (a control-room tab is usually open) and a shutdown
 * that did not is worth being able to tell apart in a journal — the same reason `/health` reports
 * `degraded` rather than failing.
 */

import type { Server } from 'node:http';

/** How long a request that is genuinely mid-flight gets to finish. */
export const SHUTDOWN_GRACE_MS = 2000;

export type ShutdownOutcome =
  /** Every connection ended on its own inside the grace. */
  | 'clean'
  /** Something was still open — almost always `/board/live` — and was closed. */
  | 'forced';

export async function closeServer(
  server: Server,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<ShutdownOutcome> {
  let forced = false;

  const closed = new Promise<void>((resolve) => {
    /**
     * The error is deliberately swallowed rather than thrown.
     *
     * `close()` calls back with `ERR_SERVER_NOT_RUNNING` if the server was already stopped, and
     * a shutdown path that throws on "already shut down" turns a second SIGTERM into a process
     * that never exits — the failure this whole module exists to remove, arriving by a new door.
     */
    server.close(() => resolve());
  });

  // Between requests, so nobody is waiting on them.
  server.closeIdleConnections();

  const timer = setTimeout(() => {
    forced = true;
    server.closeAllConnections();
  }, graceMs);
  // Never hold the process open on account of the timer that exists to help it exit.
  timer.unref();

  await closed;
  clearTimeout(timer);

  return forced ? 'forced' : 'clean';
}
