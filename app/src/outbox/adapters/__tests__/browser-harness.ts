/**
 * Browser-side harness for the IndexedDB durability tests.
 *
 * Bundled and injected into a real Chromium page. It exposes the *real* adapter and the
 * *real* outbox — nothing here reimplements either, because a reimplementation is exactly
 * what the test is supposed to catch. The only stand-in is the network transport, which is
 * not what this suite is testing.
 */

import { IndexedDbOutboxStore } from '../indexeddb.js';
import { HttpTransport } from '../httpTransport.js';
import { Outbox, type OutboxStore, type SyncTransport } from '../../outbox.js';
import type { IncidentEvent } from '../../../domain/events.js';

function uuid(): string {
  return crypto.randomUUID();
}

export async function openStore(name: string): Promise<IndexedDbOutboxStore> {
  return IndexedDbOutboxStore.open(name);
}

export function makeEvent(type: string, payload: unknown, clientSeq: number): IncidentEvent {
  return {
    eventId: uuid(),
    incidentId: 'incident-1',
    type,
    occurredAt: '2026-08-01T14:02:00.000Z',
    recordedAt: '2026-08-01T14:02:00.000Z',
    clientSeq,
    actorPersonId: null,
    actorSeatId: null,
    sourceChannel: 'mobile',
    payload,
  } as unknown as IncidentEvent;
}

export function draft(type: string, payload: unknown = {}, incidentId = 'incident-1'): unknown {
  return {
    eventId: uuid(),
    incidentId,
    type,
    occurredAt: '2026-08-01T14:02:00.000Z',
    actorPersonId: null,
    actorSeatId: null,
    sourceChannel: 'mobile',
    payload,
  };
}

/** A transport that is either unreachable or accepts everything. */
class TestTransport implements SyncTransport {
  constructor(private readonly offline: boolean) {}

  async push(events: readonly IncidentEvent[]) {
    if (this.offline) throw new Error('network unreachable');
    return { accepted: events.map((e) => e.eventId), rejected: [], cursor: events.length };
  }

  async pull(cursor: number) {
    if (this.offline) throw new Error('network unreachable');
    return { events: [], nextCursor: cursor, hasMore: false };
  }
}

export function makeOutbox(store: OutboxStore, opts: { offline: boolean }): Outbox {
  return new Outbox({ store, transport: new TestTransport(opts.offline) });
}

/**
 * An outbox wired to the real HTTP transport and a real server.
 *
 * Used by the end-to-end test, where "offline" is the browser's actual network being cut
 * rather than a flag — so `fetch` genuinely fails the way it does in the field.
 */
export function makeRealOutbox(store: OutboxStore, baseUrl: string): Outbox {
  return new Outbox({
    store,
    transport: new HttpTransport({ baseUrl, deviceId: uuid(), timeoutMs: 4000 }),
  });
}

export function reportDraft(incidentId: string, note: string, severity: string): unknown {
  return {
    eventId: uuid(),
    incidentId,
    type: 'reported',
    occurredAt: new Date().toISOString(),
    actorPersonId: null,
    actorSeatId: null,
    sourceChannel: 'mobile',
    payload: { reportId: uuid(), category: 'rta', severity, note },
  };
}
