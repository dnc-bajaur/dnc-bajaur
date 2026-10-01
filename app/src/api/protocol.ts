/**
 * The sync wire protocol.
 *
 * One rule shapes all of this: the client must be able to work out, from the response
 * alone, exactly which events it may delete from its outbox. Anything ambiguous gets kept
 * and retried, because deleting an event the server does not actually hold would lose an
 * emergency (INV-01).
 *
 * Validation is deliberately asymmetric:
 *
 *   the envelope is strict     — without a usable id, incident id and timestamp, the event
 *                                cannot be stored or ordered at all
 *   the payload is permissive  — an incomplete report is accepted and enriched later, never
 *                                refused. A reporter under stress who omits a field has
 *                                still told us something happened (INV-01).
 */

import type { IncidentEvent } from '../domain/events.js';

/** An event as it arrives from a client: no `recordedAt`, which only the server may set. */
export type InboundEvent = Omit<IncidentEvent, 'recordedAt'>;

export interface PushRequest {
  readonly deviceId: string;
  readonly events: readonly unknown[];
}

export interface PushResponse {
  /**
   * Events the server definitively holds — newly appended *and* already present.
   * These, and only these, are safe for the client to delete from its outbox.
   */
  readonly accepted: readonly string[];
  /**
   * Structurally unusable events. Kept out of storage, but reported so they surface for
   * operator attention rather than being retried forever or dropped silently.
   */
  readonly rejected: readonly { readonly eventId: string | null; readonly reason: string }[];
  readonly appended: number;
  readonly duplicates: number;
  /** The server's current position. Pass to `GET /sync` to pull what you are missing. */
  readonly cursor: number;
}

export interface PullResponse {
  readonly events: readonly IncidentEvent[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

export interface ValidationOutcome {
  readonly valid: readonly InboundEvent[];
  readonly rejected: readonly { readonly eventId: string | null; readonly reason: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHANNELS = new Set(['web', 'mobile', 'sms', 'call', 'radio', 'walk_in', 'system']);

function isIsoInstant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

function fieldError(field: string, why: string): string {
  return `${field}: ${why}`;
}

/**
 * Validate a batch, partitioning it rather than failing it.
 *
 * A malformed event must never take down the batch around it. During an outage a device
 * may be carrying the only record of several emergencies, and one bad row is not a reason
 * to refuse the rest.
 */
export function validateBatch(events: readonly unknown[]): ValidationOutcome {
  const valid: InboundEvent[] = [];
  const rejected: { eventId: string | null; reason: string }[] = [];

  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) {
      rejected.push({ eventId: null, reason: 'event is not an object' });
      continue;
    }

    const e = raw as Record<string, unknown>;
    const id = typeof e['eventId'] === 'string' ? e['eventId'] : null;
    const problems: string[] = [];

    if (id === null || !UUID_RE.test(id)) {
      problems.push(fieldError('eventId', 'must be a uuid'));
    }
    if (typeof e['incidentId'] !== 'string' || !UUID_RE.test(e['incidentId'])) {
      problems.push(fieldError('incidentId', 'must be a uuid'));
    }
    if (typeof e['type'] !== 'string' || e['type'].length === 0) {
      problems.push(fieldError('type', 'required'));
    }
    if (!isIsoInstant(e['occurredAt'])) {
      problems.push(fieldError('occurredAt', 'must be an ISO-8601 instant'));
    }
    if (!Number.isInteger(e['clientSeq']) || (e['clientSeq'] as number) < 0) {
      // Without this the fold order is a coin toss. See ADR-0008.
      problems.push(fieldError('clientSeq', 'must be a non-negative integer'));
    }
    if (typeof e['sourceChannel'] !== 'string' || !CHANNELS.has(e['sourceChannel'])) {
      problems.push(fieldError('sourceChannel', `must be one of ${[...CHANNELS].join(', ')}`));
    }
    if (e['actorPersonId'] !== null && typeof e['actorPersonId'] !== 'string') {
      problems.push(fieldError('actorPersonId', 'must be a uuid or null'));
    }
    if (e['actorSeatId'] !== null && typeof e['actorSeatId'] !== 'string') {
      problems.push(fieldError('actorSeatId', 'must be a uuid or null'));
    }

    if (problems.length > 0) {
      rejected.push({ eventId: id, reason: problems.join('; ') });
      continue;
    }

    // The payload is accepted as-is. An emergency reported with three of five fields is
    // still an emergency; enrichment happens later, refusal never does.
    const payload = typeof e['payload'] === 'object' && e['payload'] !== null ? e['payload'] : {};

    valid.push({
      eventId: id as string,
      incidentId: e['incidentId'] as string,
      type: e['type'] as InboundEvent['type'],
      occurredAt: e['occurredAt'] as string,
      clientSeq: e['clientSeq'] as number,
      actorPersonId: (e['actorPersonId'] ?? null) as string | null,
      actorSeatId: (e['actorSeatId'] ?? null) as string | null,
      sourceChannel: e['sourceChannel'] as InboundEvent['sourceChannel'],
      payload,
    } as InboundEvent);
  }

  return { valid, rejected };
}
