import type { EventType, IncidentEvent, SourceChannel } from '../events.js';
import type { Seat } from '../authority.js';

export const INCIDENT = 'inc-0001';
export const RESCUE = 'dept-rescue';
export const POLICE = 'dept-police';

export const rescueOperator: Seat = {
  seatId: 'seat-rescue-duty',
  tier: 'post',
};

export const rescueSupervisor: Seat = {
  seatId: 'seat-rescue-supervisor',
  tier: 'post',
};

export const controlRoom: Seat = {
  seatId: 'seat-control-room',
  tier: 'district',
};

export const dc: Seat = {
  seatId: 'seat-dc-bajaur',
  tier: 'district',
  canBreakGlass: true,
};

export const policeOperator: Seat = {
  seatId: 'seat-police-duty',
  tier: 'post',
};

let counter = 0;

/**
 * Build an event. `occurredAt` defaults to `recordedAt` — the online case. Tests that care
 * about offline behaviour set them apart deliberately.
 */
export function ev<T extends EventType>(
  type: T,
  payload: Extract<IncidentEvent, { type: T }>['payload'],
  overrides: Partial<{
    eventId: string;
    incidentId: string;
    occurredAt: string;
    recordedAt: string;
    actorPersonId: string | null;
    actorSeatId: string | null;
    sourceChannel: SourceChannel;
    clientSeq: number;
  }> = {},
): IncidentEvent {
  counter += 1;
  const recordedAt =
    overrides.recordedAt ?? `2026-08-01T10:${String(counter).padStart(2, '0')}:00.000Z`;
  return {
    eventId: overrides.eventId ?? `evt-${String(counter).padStart(4, '0')}`,
    incidentId: overrides.incidentId ?? INCIDENT,
    type,
    occurredAt: overrides.occurredAt ?? recordedAt,
    recordedAt,
    clientSeq: overrides.clientSeq ?? counter,
    actorPersonId: overrides.actorPersonId ?? 'person-1',
    actorSeatId: overrides.actorSeatId ?? rescueOperator.seatId,
    sourceChannel: overrides.sourceChannel ?? 'mobile',
    payload,
  } as IncidentEvent;
}

export function shuffle<T>(xs: readonly T[], seed = 7): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
