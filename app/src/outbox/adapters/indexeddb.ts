/**
 * IndexedDB implementation of `OutboxStore`.
 *
 * This is the one that runs in the field, on a constable's Android handset in a union
 * council with no signal. Everything it stores must survive the page being closed, the
 * browser being killed, and the phone running out of battery mid-report.
 *
 * Tested against real IndexedDB in a real browser, across an actual page reload — see
 * `__tests__/indexeddb.browser.test.ts`. A fake IndexedDB would satisfy the interface and
 * prove nothing about the only property that matters here.
 */

import type { OutboxEntry, OutboxStore } from '../outbox.js';
import type { Uuid } from '../../domain/events.js';

const DB_NAME = 'dnc-outbox';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const META = 'meta';

/** Persisted so the counter survives a restart. A reset would reintroduce ties (ADR-0008). */
const SEQ_PREFIX = 'seq:';
const CURSOR_KEY = 'cursor';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openOutboxDb(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES)) {
        db.createObjectStore(ENTRIES, { keyPath: 'eventId' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open outbox database'));
  });
}

interface StoredEntry {
  eventId: string;
  entry: OutboxEntry;
}

export class IndexedDbOutboxStore implements OutboxStore {
  constructor(private readonly db: IDBDatabase) {}

  static async open(name?: string): Promise<IndexedDbOutboxStore> {
    return new IndexedDbOutboxStore(await openOutboxDb(name));
  }

  async put(entry: OutboxEntry): Promise<void> {
    const tx = this.db.transaction(ENTRIES, 'readwrite');
    tx.objectStore(ENTRIES).put({ eventId: entry.event.eventId, entry } satisfies StoredEntry);
    await done(tx);
  }

  async delete(eventIds: readonly Uuid[]): Promise<void> {
    if (eventIds.length === 0) return;
    const tx = this.db.transaction(ENTRIES, 'readwrite');
    const store = tx.objectStore(ENTRIES);
    for (const id of eventIds) store.delete(id);
    await done(tx);
  }

  async all(): Promise<readonly OutboxEntry[]> {
    const tx = this.db.transaction(ENTRIES, 'readonly');
    const rows = await promisify(tx.objectStore(ENTRIES).getAll() as IDBRequest<StoredEntry[]>);
    return rows.map((r) => r.entry);
  }

  /**
   * Read-modify-write inside a single IndexedDB transaction.
   *
   * Two enqueues racing must not receive the same sequence number, and the increment must
   * be durable before it is handed out — a counter that resets after a crash would produce
   * ties, which is exactly the failure ADR-0008 exists to prevent.
   */
  async nextClientSeq(incidentId: Uuid): Promise<number> {
    const tx = this.db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const key = SEQ_PREFIX + incidentId;
    const current = await promisify(store.get(key) as IDBRequest<number | undefined>);
    const next = (current ?? 0) + 1;
    store.put(next, key);
    await done(tx);
    return next;
  }

  async getCursor(): Promise<number> {
    const tx = this.db.transaction(META, 'readonly');
    const value = await promisify(
      tx.objectStore(META).get(CURSOR_KEY) as IDBRequest<number | undefined>,
    );
    return value ?? 0;
  }

  async setCursor(cursor: number): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put(cursor, CURSOR_KEY);
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Ask the browser not to evict this data under storage pressure.
 *
 * Best-effort: the browser may refuse, and on some platforms it prompts. Worth asking —
 * the default eviction policy treats an unreported emergency the same as a cached image.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
