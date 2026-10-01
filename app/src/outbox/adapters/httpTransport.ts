/**
 * The real network transport. Talks to the sync endpoints in `src/api/server.ts`.
 *
 * It throws on any failure — unreachable, timeout, 5xx — and that is deliberate. The
 * outbox treats a thrown transport as "offline", puts everything back, and waits. In this
 * district that is the normal case, not an exception, so it must be the cheap path
 * (ADR-0002).
 */

import type { IncidentEvent } from '../../domain/events.js';
import { AuthRequiredError, type SyncTransport } from '../outbox.js';
import type { PullResponse, PushResponse } from '../../api/protocol.js';

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly deviceId: string;
  /**
   * Give up and treat as offline after this long.
   *
   * A hanging request is worse than a failed one: it holds events in flight while an
   * operator waits, with no way to tell whether anything is happening.
   */
  readonly timeoutMs?: number;
}

export class HttpTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly deviceId: string;
  private readonly timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.deviceId = options.deviceId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      // 401 and 403 mean the server heard us and said no. That is a different fact from
      // being unreachable, and the operator must be told which one it is.
      if (res.status === 401 || res.status === 403) {
        throw new AuthRequiredError(`sync refused: ${res.status}`);
      }
      if (!res.ok) throw new Error(`sync failed: ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async push(events: readonly IncidentEvent[]): Promise<{
    accepted: readonly string[];
    rejected: readonly { eventId: string | null; reason: string }[];
    cursor: number;
  }> {
    const body = await this.request<PushResponse>('/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId, events }),
    });
    return { accepted: body.accepted, rejected: body.rejected, cursor: body.cursor };
  }

  async pull(cursor: number): Promise<{
    events: readonly IncidentEvent[];
    nextCursor: number;
    hasMore: boolean;
  }> {
    return this.request<PullResponse>(`/sync?cursor=${cursor}`);
  }
}
