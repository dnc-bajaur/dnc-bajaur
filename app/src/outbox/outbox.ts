/**
 * The outbox. The piece the whole project rests on.
 *
 * ADR-0002: offline is the substrate, not a feature. Every write goes here first, durably,
 * before any network attempt is made. Only once the server has confirmed it does an entry
 * leave. If the process dies between those two moments, the entry is still here on restart.
 *
 * Storage is behind a port so the logic can be tested exhaustively without a browser, and
 * so the same logic can run against IndexedDB in the field. The adapter is tested
 * separately, in a real browser — a fake IndexedDB would prove nothing about the thing
 * that matters (see `adapters/`).
 */

import type { IncidentEvent, Uuid } from '../domain/events.js';

export type EntryState =
  /** Waiting to be sent. */
  | 'pending'
  /** Handed to the network; outcome unknown. Stays durable until confirmed. */
  | 'inflight'
  /** The server rejected it as unusable. Needs a human, not another retry. */
  | 'blocked';

export interface OutboxEntry {
  readonly event: IncidentEvent;
  readonly state: EntryState;
  readonly attempts: number;
  /** Set when state is `blocked`. Shown to an operator. */
  readonly lastError?: string;
}

/**
 * Durable storage for the outbox.
 *
 * Every method must survive process death. An implementation that keeps entries in memory
 * satisfies the types and defeats the purpose.
 */
export interface OutboxStore {
  put(entry: OutboxEntry): Promise<void>;
  delete(eventIds: readonly Uuid[]): Promise<void>;
  all(): Promise<readonly OutboxEntry[]>;
  /** Monotonic per incident, and durable across restarts. See ADR-0008. */
  nextClientSeq(incidentId: Uuid): Promise<number>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
}

export interface SyncTransport {
  push(events: readonly IncidentEvent[]): Promise<{
    readonly accepted: readonly Uuid[];
    readonly rejected: readonly { readonly eventId: string | null; readonly reason: string }[];
    readonly cursor: number;
  }>;
  pull(cursor: number): Promise<{
    readonly events: readonly IncidentEvent[];
    readonly nextCursor: number;
    readonly hasMore: boolean;
  }>;
}

/**
 * The server refused us, rather than being unreachable.
 *
 * A distinct type because "signed out" and "no signal" are different facts and must not be
 * shown as the same thing. Telling an operator the network is down when their session
 * expired sends them looking for signal on a working connection, and the report sits
 * undelivered while they do.
 *
 * Defined here rather than in the transport because it is part of the transport contract,
 * and the outbox is the thing that has to react to it.
 */
export class AuthRequiredError extends Error {
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export interface SyncResult {
  readonly pushed: number;
  readonly blocked: number;
  readonly pulled: number;
  readonly stillPending: number;
  /** True when the network could not be reached. Not an error — the normal case here. */
  readonly offline: boolean;
  /**
   * True when the server refused the credential. Queued events are **kept**, exactly as
   * when offline — being signed out must never cost an emergency (INV-01).
   */
  readonly authRequired: boolean;
}

export interface OutboxOptions {
  readonly store: OutboxStore;
  readonly transport: SyncTransport;
  /** Batch size per push. Kept modest: a weak link should not have to carry 500 events. */
  readonly batchSize?: number;
}

export class Outbox {
  private readonly store: OutboxStore;
  private readonly transport: SyncTransport;
  private readonly batchSize: number;
  /** The sync currently running, if any. Overlapping callers join it rather than racing. */
  private inFlight: Promise<SyncResult> | null = null;

  /** Set when `enqueue` lands mid-run, so the run that missed it can chain another. */
  private arrivedDuringSync = false;

  constructor(options: OutboxOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Record an event locally. Returns once it is durable — **not** once it is sent.
   *
   * The caller may show "saved", never "delivered". A user must never believe an emergency
   * has reached the control room when it is still on the handset
   * (docs/02-connectivity-ladder.md, rung L2).
   */
  async enqueue(event: Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>): Promise<IncidentEvent> {
    const clientSeq = await this.store.nextClientSeq(event.incidentId);
    const full = {
      ...event,
      clientSeq,
      // A placeholder only. The server assigns the authoritative value and it is never
      // read from here — a device clock must not be able to influence escalation timing.
      recordedAt: event.occurredAt,
    } as IncidentEvent;

    await this.store.put({ event: full, state: 'pending', attempts: 0 });

    // Note that this arrived mid-run, if one is in progress. `runSync` snapshots the queue
    // when it starts, so this event is not in the batch being sent — and without this flag
    // nothing would send it until some external trigger came along. See `sync`.
    if (this.inFlight !== null) this.arrivedDuringSync = true;

    return full;
  }

  async pendingCount(): Promise<number> {
    return (await this.store.all()).filter((e) => e.state !== 'blocked').length;
  }

  async blocked(): Promise<readonly OutboxEntry[]> {
    return (await this.store.all()).filter((e) => e.state === 'blocked');
  }

  /**
   * Push everything queued, then pull whatever we have missed.
   *
   * Safe to call at any time, including repeatedly and on every reconnect. Concurrent
   * calls collapse into one: two sync passes racing could push the same batch twice, which
   * the server would deduplicate, but which would also double-count attempts and confuse
   * the blocked-entry logic.
   */
  async sync(): Promise<SyncResult> {
    // An overlapping call joins the run already in progress and gets its real answer.
    //
    // An earlier version returned a fabricated `{ offline: false }` here, which was a
    // lie: a caller that happened to overlap another sync was told the server was
    // reachable when nothing had checked. The UI derives its connectivity state from this
    // field, so that lie put "Connected. Reports are delivered immediately." on screen
    // during an outage — the same class of failure as trusting `navigator.onLine`.
    //
    // Never invent a connectivity answer. Either measure it, or return the measurement
    // someone else is already taking.
    if (this.inFlight !== null) return this.inFlight;

    this.arrivedDuringSync = false;
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });

    const result = await this.inFlight;

    // Anything enqueued *during* that run was not in it.
    //
    // `runSync` reads the queue once, at the start. A report submitted while a sync was
    // already in flight therefore missed the batch — and the caller that enqueued it got
    // this run's result, which correctly says the server was reachable. Nothing was wrong
    // with that answer and nothing would have sent the report: it would have sat in the
    // outbox until the next `online` event, the next submit, or an app restart, while the
    // screen said "Connected. Reports are delivered immediately."
    //
    // Not lost, but not delivered, and indistinguishable from delivered on screen. That is
    // the same shape as the failures INV-01 keeps turning up.
    //
    // One follow-up run, not a loop: it clears the flag first, so a run that itself
    // receives new work sets it again and chains exactly once more. A server that is
    // unreachable or refusing does **not** trigger a retry here — that would busy-loop
    // against a dead network, which is the normal state in Bajaur, not an exception.
    if (this.arrivedDuringSync && !result.offline && !result.authRequired) {
      this.arrivedDuringSync = false;
      return this.sync();
    }

    return result;
  }

  private async runSync(): Promise<SyncResult> {
    let pushed = 0;
    let blocked = 0;
    let pulled = 0;
    let offline = false;
    let authRequired = false;

    const queued = (await this.store.all())
      .filter((e) => e.state !== 'blocked')
      // Send in the order the operator created things, so the server sees causal order
      // even if it only ever receives one batch.
      .sort((a, b) => {
        if (a.event.occurredAt !== b.event.occurredAt) {
          return a.event.occurredAt < b.event.occurredAt ? -1 : 1;
        }
        return a.event.clientSeq - b.event.clientSeq;
      });

    for (let i = 0; i < queued.length; i += this.batchSize) {
      const batch = queued.slice(i, i + this.batchSize);

      // Mark in-flight *before* the request. If the process dies mid-flight the entry is
      // still here on restart, and re-sending is harmless because the server deduplicates
      // on eventId (INV-08).
      await Promise.all(
        batch.map((e) => this.store.put({ ...e, state: 'inflight', attempts: e.attempts + 1 })),
      );

      let result;
      try {
        result = await this.transport.push(batch.map((e) => e.event));
      } catch (err) {
        // Unreachable or refused — either way everything goes back on the queue. The two
        // are distinguished only so the operator can be told the truth about which it is.
        if (err instanceof AuthRequiredError) {
          authRequired = true;
        } else {
          // The normal case in Bajaur, not an exception.
          offline = true;
        }
        await Promise.all(
          batch.map((e) => this.store.put({ ...e, state: 'pending', attempts: e.attempts + 1 })),
        );
        break;
      }

      const accepted = new Set(result.accepted);
      const rejected = new Map(result.rejected.map((r) => [r.eventId, r.reason]));

      // Delete only what the server confirmed it holds. Anything else stays queued —
      // releasing an event the server does not actually have would lose an emergency.
      const releasable = batch.filter((e) => accepted.has(e.event.eventId));
      if (releasable.length > 0) {
        await this.store.delete(releasable.map((e) => e.event.eventId));
        pushed += releasable.length;
      }

      for (const entry of batch) {
        if (accepted.has(entry.event.eventId)) continue;

        const reason = rejected.get(entry.event.eventId);
        if (reason !== undefined) {
          // Structurally unusable. Retrying forever would never succeed and would hide it.
          // Keep it, stop retrying, and surface it to an operator (INV-01: not lost).
          await this.store.put({
            ...entry,
            state: 'blocked',
            attempts: entry.attempts + 1,
            lastError: reason,
          });
          blocked += 1;
        } else {
          // Neither accepted nor rejected — the server said nothing about it. Assume the
          // worst and keep it.
          await this.store.put({ ...entry, state: 'pending', attempts: entry.attempts + 1 });
        }
      }

      await this.store.setCursor(result.cursor);
    }

    if (!offline && !authRequired) {
      try {
        let cursor = await this.store.getCursor();
        for (let guard = 0; guard < 100; guard++) {
          const page = await this.transport.pull(cursor);
          pulled += page.events.length;
          cursor = page.nextCursor;
          await this.store.setCursor(cursor);
          if (!page.hasMore) break;
        }
      } catch (err) {
        if (err instanceof AuthRequiredError) authRequired = true;
        else offline = true;
      }
    }

    return {
      pushed,
      blocked,
      pulled,
      stillPending: await this.pendingCount(),
      offline,
      authRequired,
    };
  }
}
