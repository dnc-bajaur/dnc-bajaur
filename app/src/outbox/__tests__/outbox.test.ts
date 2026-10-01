/**
 * Outbox logic tests.
 *
 * The store here is in-memory, and that is legitimate *for these tests* — what is under
 * test is the queueing, release and blocking logic, not durability. Durability is proven
 * separately against real IndexedDB in a real browser, because only that can prove it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { Outbox, type OutboxEntry, type OutboxStore, type SyncTransport } from '../outbox.js';
import type { IncidentEvent, Uuid } from '../../domain/events.js';

class MemoryStore implements OutboxStore {
  entries = new Map<string, OutboxEntry>();
  seqs = new Map<string, number>();
  cursor = 0;

  async put(entry: OutboxEntry): Promise<void> {
    this.entries.set(entry.event.eventId, entry);
  }
  async delete(ids: readonly Uuid[]): Promise<void> {
    for (const id of ids) this.entries.delete(id);
  }
  async all(): Promise<readonly OutboxEntry[]> {
    return [...this.entries.values()];
  }
  async nextClientSeq(incidentId: Uuid): Promise<number> {
    const next = (this.seqs.get(incidentId) ?? 0) + 1;
    this.seqs.set(incidentId, next);
    return next;
  }
  async getCursor(): Promise<number> {
    return this.cursor;
  }
  async setCursor(c: number): Promise<void> {
    this.cursor = c;
  }
}

class FakeServer implements SyncTransport {
  held = new Set<string>();
  offline = false;
  rejectIds = new Set<string>();
  pushCalls = 0;
  /** Hook to create the mid-run race deterministically. */
  beforePush: (() => void) | null = null;
  pullQueue: IncidentEvent[] = [];

  async push(events: readonly IncidentEvent[]) {
    this.pushCalls += 1;
    this.beforePush?.();
    if (this.offline) throw new Error('network unreachable');

    const accepted: string[] = [];
    const rejected: { eventId: string | null; reason: string }[] = [];
    for (const e of events) {
      if (this.rejectIds.has(e.eventId)) {
        rejected.push({ eventId: e.eventId, reason: 'clientSeq: must be a non-negative integer' });
      } else {
        this.held.add(e.eventId);
        accepted.push(e.eventId);
      }
    }
    return { accepted, rejected, cursor: this.held.size };
  }

  async pull(cursor: number) {
    if (this.offline) throw new Error('network unreachable');
    const events = this.pullQueue.slice(cursor);
    return { events, nextCursor: cursor + events.length, hasMore: false };
  }
}

let store: MemoryStore;
let server: FakeServer;
let outbox: Outbox;
let incidentId: string;

function draft(type: string, payload: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    incidentId,
    type,
    occurredAt: '2026-08-01T14:02:00.000Z',
    actorPersonId: randomUUID(),
    actorSeatId: randomUUID(),
    sourceChannel: 'mobile',
    payload,
  } as unknown as Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>;
}

beforeEach(() => {
  store = new MemoryStore();
  server = new FakeServer();
  outbox = new Outbox({ store, transport: server });
  incidentId = randomUUID();
});

describe('enqueue', () => {
  it('returns once durable, before anything is sent', async () => {
    await outbox.enqueue(draft('reported', { severity: 'critical' }));

    expect(await outbox.pendingCount()).toBe(1);
    expect(server.pushCalls).toBe(0);
    expect(server.held.size).toBe(0);
  });

  it('assigns a monotonic clientSeq per incident (ADR-0008)', async () => {
    const a = await outbox.enqueue(draft('reported'));
    const b = await outbox.enqueue(draft('triaged'));
    const c = await outbox.enqueue(draft('acknowledged'));

    expect([a.clientSeq, b.clientSeq, c.clientSeq]).toEqual([1, 2, 3]);
  });

  it('counts separately for separate incidents', async () => {
    const a = await outbox.enqueue(draft('reported'));
    incidentId = randomUUID();
    const b = await outbox.enqueue(draft('reported'));

    expect(a.clientSeq).toBe(1);
    expect(b.clientSeq).toBe(1);
  });
});

describe('sync while offline', () => {
  beforeEach(() => {
    server.offline = true;
  });

  it('keeps everything and reports offline rather than failing', async () => {
    await outbox.enqueue(draft('reported', { severity: 'critical' }));
    await outbox.enqueue(draft('triaged'));

    const result = await outbox.sync();

    expect(result.offline).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.stillPending).toBe(2);
  });

  it('loses nothing across many failed attempts', async () => {
    await outbox.enqueue(draft('reported', { severity: 'critical' }));

    for (let i = 0; i < 20; i++) await outbox.sync();

    expect(await outbox.pendingCount()).toBe(1);
    expect((await store.all())[0]!.state).toBe('pending');
  });

  it('delivers everything once the network returns', async () => {
    await outbox.enqueue(draft('reported', { severity: 'critical' }));
    await outbox.enqueue(draft('acknowledged'));
    await outbox.sync();

    server.offline = false;
    const result = await outbox.sync();

    expect(result.pushed).toBe(2);
    expect(result.stillPending).toBe(0);
    expect(server.held.size).toBe(2);
  });
});

describe('release rules', () => {
  it('deletes only what the server confirmed it holds', async () => {
    const kept = await outbox.enqueue(draft('reported'));
    await outbox.enqueue(draft('triaged'));

    // Server acknowledges one and says nothing at all about the other.
    server.push = async (events) => {
      const first = events[0]!;
      server.held.add(first.eventId);
      return { accepted: [first.eventId], rejected: [], cursor: 1 };
    };

    await outbox.sync();

    const remaining = await store.all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.event.eventId).not.toBe(kept.eventId);
    expect(remaining[0]!.state).toBe('pending');
  });

  it('releases an already-held event, so an ambiguous retry drains', async () => {
    await outbox.enqueue(draft('reported'));
    await outbox.sync();
    expect(await outbox.pendingCount()).toBe(0);

    // Re-enqueue the same event id, as a client unsure whether its push landed would.
    const same = [...server.held][0]!;
    await store.put({
      event: { eventId: same, incidentId, clientSeq: 1 } as IncidentEvent,
      state: 'pending',
      attempts: 1,
    });

    const result = await outbox.sync();
    expect(result.pushed).toBe(1);
    expect(await outbox.pendingCount()).toBe(0);
  });
});

describe('blocked entries', () => {
  it('stops retrying an event the server calls unusable, but keeps it (INV-01)', async () => {
    const bad = await outbox.enqueue(draft('reported'));
    server.rejectIds.add(bad.eventId);

    const first = await outbox.sync();
    expect(first.blocked).toBe(1);

    // Not retried again — an unusable event would never succeed, and endless retries
    // would bury it.
    const callsAfterFirst = server.pushCalls;
    await outbox.sync();
    expect(server.pushCalls).toBe(callsAfterFirst);

    // But it is still here, and visible to an operator.
    const blocked = await outbox.blocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.lastError).toMatch(/clientSeq/);
  });

  it('a blocked entry does not hold up the rest of the queue', async () => {
    const bad = await outbox.enqueue(draft('reported'));
    server.rejectIds.add(bad.eventId);
    await outbox.enqueue(draft('triaged', { severity: 'critical' }));

    const result = await outbox.sync();

    expect(result.pushed).toBe(1);
    expect(result.blocked).toBe(1);
    expect(server.held.size).toBe(1);
  });
});

describe('ordering', () => {
  it("sends in the operator's order, not insertion or hash order", async () => {
    const a = await outbox.enqueue(draft('reported'));
    const b = await outbox.enqueue(draft('triaged'));
    const c = await outbox.enqueue(draft('overridden'));

    let sent: readonly IncidentEvent[] = [];
    server.push = async (events) => {
      sent = events;
      for (const e of events) server.held.add(e.eventId);
      return { accepted: events.map((e) => e.eventId), rejected: [], cursor: events.length };
    };

    await outbox.sync();

    expect(sent.map((e) => e.eventId)).toEqual([a.eventId, b.eventId, c.eventId]);
  });

  it('batches without losing or reordering anything', async () => {
    outbox = new Outbox({ store, transport: server, batchSize: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await outbox.enqueue(draft('action_logged'))).eventId);

    const seen: string[] = [];
    const original = server.push.bind(server);
    server.push = async (events) => {
      seen.push(...events.map((e) => e.eventId));
      return original(events);
    };

    const result = await outbox.sync();

    expect(result.pushed).toBe(10);
    expect(seen).toEqual(ids);
    expect(await outbox.pendingCount()).toBe(0);
  });
});

describe('concurrency', () => {
  it('never invents a connectivity answer for an overlapping caller', async () => {
    // The bug this pins: an overlapping sync used to return a fabricated
    // `{ offline: false }`. The UI derives its connectivity state from this field, so that
    // put "Connected. Reports are delivered immediately." on screen during a real outage.
    server.offline = true;
    await outbox.enqueue(draft('reported', { severity: 'critical' }));

    const original = server.push.bind(server);
    server.push = async (events) => {
      await new Promise((r) => setTimeout(r, 20));
      return original(events);
    };

    const [a, b] = await Promise.all([outbox.sync(), outbox.sync()]);

    // Both callers get the same, true answer — not one measured and one guessed.
    expect(a.offline).toBe(true);
    expect(b.offline).toBe(true);
    expect(a).toEqual(b);
  });

  it('collapses overlapping syncs instead of double-pushing', async () => {
    await outbox.enqueue(draft('reported'));

    const original = server.push.bind(server);
    server.push = async (events) => {
      await new Promise((r) => setTimeout(r, 20));
      return original(events);
    };

    const [a, b] = await Promise.all([outbox.sync(), outbox.sync()]);

    // One push over the wire, and both callers receive the same real outcome. This
    // assertion used to read `a.pushed + b.pushed === 1`, which quietly encoded the bug:
    // it only held because the second caller was handed a fabricated empty result.
    expect(server.pushCalls).toBe(1);
    expect(a).toEqual(b);
    expect(a.pushed).toBe(1);
  });
});

describe('pull', () => {
  it('advances the cursor and stores it durably', async () => {
    server.pullQueue = [
      { eventId: randomUUID(), incidentId, clientSeq: 1 } as IncidentEvent,
      { eventId: randomUUID(), incidentId, clientSeq: 2 } as IncidentEvent,
    ];

    const result = await outbox.sync();

    expect(result.pulled).toBe(2);
    expect(await store.getCursor()).toBe(2);
  });

  it('does not pull while offline', async () => {
    server.pullQueue = [{ eventId: randomUUID(), incidentId, clientSeq: 1 } as IncidentEvent];
    server.offline = true;
    await outbox.enqueue(draft('reported'));

    const result = await outbox.sync();

    expect(result.pulled).toBe(0);
    expect(result.offline).toBe(true);
  });

  describe('work that arrives while a sync is already running', () => {
    it('is sent without waiting for another trigger', async () => {
      // `runSync` reads the queue once, at the start. A report submitted mid-run therefore
      // missed the batch — and the caller got that run's result, which correctly said the
      // server was reachable. Nothing was wrong with the answer and nothing would have sent
      // the report: it sat in the outbox until the next `online` event, the next submit, or
      // an app restart, while the screen said "Connected. Reports are delivered
      // immediately." Not lost, but not delivered, and indistinguishable from delivered.
      await outbox.enqueue(draft('reported'));

      let enqueuedMidRun: Promise<unknown> | null = null;
      server.beforePush = () => {
        // Exactly the race: a second report arrives while the first batch is in flight.
        enqueuedMidRun ??= outbox.enqueue(draft('action_logged'));
      };

      await outbox.sync();
      await enqueuedMidRun;

      expect(await outbox.pendingCount()).toBe(0);
      expect(server.held.size).toBe(2);
    });

    it('does not retry against a server it could not reach', async () => {
      // The follow-up run is for work that was missed, not for work that failed. Chaining
      // on an offline result would busy-loop against a dead network — which in Bajaur is the
      // normal state, not an exception.
      await outbox.enqueue(draft('reported'));
      server.offline = true;
      server.beforePush = () => {
        void outbox.enqueue(draft('action_logged'));
      };

      const result = await outbox.sync();

      expect(result.offline).toBe(true);
      // One attempt against an unreachable server, not two.
      expect(server.pushCalls).toBe(1);
    });
  });
});
