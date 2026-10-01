import { EventEmitter } from 'node:events';

/**
 * The signal that something changed, decoupled from what changed or who may see it.
 *
 * ------------------------------------------------------------------------------------------
 * Why this is a doorbell, not a feed
 * ------------------------------------------------------------------------------------------
 *
 * The tempting design is a stream that pushes the changed row itself, scoped to each
 * connection's seat. That means re-deriving `buildBoard`'s authority scoping (department
 * visibility, seat tier, retired departments) a second time, in a second place, under a
 * different set of constraints (a long-lived connection instead of a request/response) — and
 * a scoping rule that drifts between the two is exactly the class of bug ADR-0003 and INV-05
 * exist to prevent. `board.ts` has one job and does it well; this module's job is only to say
 * *"ask again"*, as fast as possible, to whoever is listening.
 *
 * So a client that receives `changed` does exactly what the 10-second poll it replaces already
 * did — calls `GET /incidents` — except now it is told to call it within milliseconds of a
 * change landing, rather than up to ten seconds late. Every authorisation guarantee `/incidents`
 * already has stays exactly where it was proven correct. What changes is *when* the client asks,
 * never *what* it is allowed to see.
 *
 * ------------------------------------------------------------------------------------------
 * Why `eventStore.append` is where this fires
 * ------------------------------------------------------------------------------------------
 *
 * `append` is the one place every incident-affecting write already passes through — lifecycle
 * commands, a dispatch, an acknowledgement, an offline device's `/sync` replay, the escalation
 * job. Announcing from there means no call site has to remember to announce; a code path that
 * forgot would be a code path that already forgot to append, which is a bigger problem than this
 * one. Same reasoning as `recorded_at` being stamped in one place rather than trusted from many.
 *
 * ------------------------------------------------------------------------------------------
 * Why in-process and not `LISTEN`/`NOTIFY`
 * ------------------------------------------------------------------------------------------
 *
 * ADR-0007: one deployable, one Node process, on one machine. A second process would need
 * Postgres `LISTEN`/`NOTIFY` (or a message queue) to hear about a change; a single process only
 * needs to tell itself. `EventEmitter` is the boring answer for the boring stack this already is
 * — if the district's deployment topology ever grows a second process, this is the seam to widen,
 * not a reason to build the wider thing now (ADR-0007's whole argument, applied here).
 */
const emitter = new EventEmitter();
// A control room's worth of connections — a handful of tabs, not an internet's worth. The
// default limit of 10 exists to catch a *leak*; it is not a ceiling this system should ever
// approach on purpose, but raising it removes a spurious warning on a night with several tabs
// open across a shift handover.
emitter.setMaxListeners(50);

const CHANGE = 'changed';

/**
 * Say that the board may have changed. Never throws, and never awaits anything — a slow or
 * broken subscriber must not be able to slow down `append`, which is on every write path in the
 * system including offline sync.
 *
 * **Each listener is called in its own try/catch, not `emitter.emit()` wrapped in one.**
 * `EventEmitter.emit` calls listeners synchronously in registration order and does not catch
 * for you — a throw from the first listener propagates straight out of `emit()`, so a single
 * `try` around the whole call stops it there and every listener registered after the broken one
 * never runs. One tab with a bug would go silent *and* silence every other tab's connection
 * behind it. Iterating and isolating each call is what actually delivers on "a broken subscriber
 * cannot affect another" — the promise the type signature makes.
 */
export function announceBoardChange(incidentIds: readonly string[]): void {
  if (incidentIds.length === 0) return;
  for (const listener of emitter.listeners(CHANGE)) {
    try {
      (listener as (ids: readonly string[]) => void)(incidentIds);
    } catch {
      // That listener's bug, not the write's. `append` already committed; the rest still hear.
    }
  }
}

/** Subscribe for as long as a connection is open. Returns the unsubscribe function. */
export function onBoardChange(listener: (incidentIds: readonly string[]) => void): () => void {
  emitter.on(CHANGE, listener);
  return () => emitter.off(CHANGE, listener);
}
