import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { IncidentEvent } from '../events.js';

import { foldIncident, districtSeverity } from '../incident.js';
import { INCIDENT, RESCUE, POLICE, controlRoom, ev, shuffle } from './fixtures.js';

describe('foldIncident', () => {
  it('derives status and values from the event log alone', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('triaged', { severity: 'high', category: 'rta' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }),
      ev('action_logged', { note: 'ambulance dispatched' }),
      ev('resolved', { outcome: 'casualties shifted to DHQ' }),
      ev('closed', { notes: 'road cleared' }),
    ];

    const state = foldIncident(INCIDENT, events);

    expect(state.status).toBe('closed');
    expect(state.severity?.value).toBe('high');
    expect(state.responsibleDepartmentIds).toEqual([RESCUE]);
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.actions).toHaveLength(1);
    expect(state.resolution).toBe('casualties shifted to DHQ');
    expect(state.eventCount).toBe(7);
  });

  it('carries who acknowledged, from an explicit event and from the first real response', () => {
    // An explicit `acknowledged` event: the payload names the officer when it has one, and
    // falls back to the envelope actor when it does not (an in-app tap by a signed-in officer).
    const explicit = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'fire', severity: 'high' }),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }, { actorPersonId: 'officer-7' }),
    ]);
    expect(explicit.acknowledgedBySeatId).toBe('seat-rescue-duty');
    expect(explicit.acknowledgedByPersonId).toBe('officer-7');

    // The operator relay (M7-05): the actor is the operator, so only the payload's own
    // `personId` is trustworthy for who took it.
    const relayed = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'fire', severity: 'high' }),
      ev(
        'acknowledged',
        { seatId: 'seat-rescue-duty', personId: 'officer-9', route: 'operator' },
        { actorPersonId: 'operator-2' },
      ),
    ]);
    expect(relayed.acknowledgedByPersonId).toBe('officer-9');

    // Since 2026-09-04 the first response acknowledges under its own power — the person on
    // that event is the one who took it.
    const firstResponse = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'fire', severity: 'high' }),
      ev('dispatched', { targets: [{ kind: 'post', id: 'seat-rescue-duty' }] }),
      ev(
        'action_logged',
        { note: 'Fire Team Dispatched', acknowledges: true },
        {
          actorPersonId: 'officer-3',
          actorSeatId: 'seat-rescue-duty',
        },
      ),
    ]);
    expect(firstResponse.acknowledgedAt).not.toBeNull();
    expect(firstResponse.acknowledgedByPersonId).toBe('officer-3');
  });

  it('never lets a fallback acknowledgement drag a reply back down from responding', () => {
    // A meeting's `Attending` tap: it matches none of the district's response options (a
    // gathering carries no options list), so `api/webhooks.ts` writes the plain `action_logged`
    // note of the tap — with no `acknowledges` flag, since nothing matched — and then its
    // `appendAcknowledgement` fallback, because the tap looked like a bare "I saw this" and
    // nothing upstream had set `acknowledgedAt` yet to stop it. The tap already moved this to
    // `responding`; the fallback must not undo that.
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'general', severity: 'low', kind: 'meeting' }),
      ev(
        'action_logged',
        { note: 'Tapped "Attending" on WhatsApp' },
        { actorPersonId: 'officer-3', actorSeatId: 'seat-rescue-duty' },
      ),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }, { actorPersonId: 'officer-3' }),
    ]);
    expect(state.status).toBe('responding');
  });

  it('is deterministic regardless of the order events arrive in', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'moderate' }),
      ev('triaged', { severity: 'high', category: 'rta' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: 'seat-rescue-duty' }),
      ev('resolved', { outcome: 'done' }),
    ];

    const inOrder = foldIncident(INCIDENT, events);
    for (const seed of [1, 7, 42, 99]) {
      expect(foldIncident(INCIDENT, shuffle(events, seed))).toEqual(inOrder);
    }
  });

  it('reads importance from the first report, defaulting an old event to routine — M10-20/21/42', () => {
    // An event written before this field existed. The fold must read it as `routine`, never
    // as `important` — inventing an assessment nobody made would be the same class of failure
    // as guessing a severity.
    const old = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'fire', severity: 'high' }),
    ]);
    expect(old.importance).toBe('routine');

    const stated = foldIncident(INCIDENT, [
      ev('reported', {
        reportId: 'rep-1',
        category: 'fire',
        severity: 'high',
        importance: 'important',
      }),
    ]);
    expect(stated.importance).toBe('important');
  });

  it('keeps what was sent once the attempt settles — 2026-09-05', () => {
    // A district reported this the same afternoon it happened, on an incident from that day:
    // "what was sent is not recorded" over a message that plainly had been. `notified` opens
    // the attempt, `message_sent` records the words, and — moments later, on the ordinary
    // path — `notification_delivered` settles it. That settling case rebuilt the attempt from
    // its own fields and never carried `sent` forward, so the words were erased the instant
    // delivery was confirmed, which for a real WhatsApp send is nearly always before anyone
    // opens the incident. Verified failing: without `...attempt.sent` in that branch, `sent`
    // comes back `undefined` here.
    const attemptId = 'attempt-1';
    const delivered = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'other', severity: 'high' }),
      ev('notified', {
        attemptId,
        seatId: 'seat-rescue-duty',
        channel: 'whatsapp',
        reason: 'dispatched',
      }),
      ev('message_sent', {
        attemptId,
        what: 'ALERT · other · high',
        where: 'A description of the emergency',
      }),
      ev('notification_delivered', {
        attemptId,
        seatId: 'seat-rescue-duty',
        channel: 'whatsapp',
        via: 'provider',
      }),
    ]);
    const deliveredAttempt = delivered.notifications.find((n) => n.attemptId === attemptId);
    expect(deliveredAttempt?.state).toBe('delivered');
    expect(deliveredAttempt?.sent).toEqual({
      what: 'ALERT · other · high',
      where: 'A description of the emergency',
    });

    // Same carry-through on the other side of a settlement — a failed send must not cost the
    // record the words that were actually composed either.
    const failed = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'other', severity: 'high' }),
      ev('notified', {
        attemptId,
        seatId: 'seat-rescue-duty',
        channel: 'whatsapp',
        reason: 'dispatched',
      }),
      ev('message_sent', {
        attemptId,
        what: 'ALERT · other · high',
        where: 'A description of the emergency',
      }),
      ev('notification_failed', {
        attemptId,
        seatId: 'seat-rescue-duty',
        channel: 'whatsapp',
        failure: 'no_channel',
      }),
    ]);
    expect(failed.notifications.find((n) => n.attemptId === attemptId)?.sent).toEqual({
      what: 'ALERT · other · high',
      where: 'A description of the emergency',
    });
  });

  it('ignores events belonging to another incident', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'low' }),
      ev('closed', { notes: 'not ours' }, { incidentId: 'inc-9999' }),
    ];

    expect(foldIncident(INCIDENT, events).status).toBe('reported');
  });

  describe('point-in-time replay', () => {
    const events = [
      ev(
        'reported',
        { reportId: 'rep-1', category: 'rta', severity: 'high' },
        {
          occurredAt: '2026-08-01T14:02:00.000Z',
          recordedAt: '2026-08-01T16:40:00.000Z',
        },
      ),
      ev(
        'acknowledged',
        { seatId: 'seat-rescue-duty' },
        {
          occurredAt: '2026-08-01T16:45:00.000Z',
          recordedAt: '2026-08-01T16:45:00.000Z',
        },
      ),
    ];

    it('knownAt answers "what did the control room see then"', () => {
      // At 15:00 the report had happened but had not yet synced.
      const seen = foldIncident(INCIDENT, events, { knownAt: '2026-08-01T15:00:00.000Z' });
      expect(seen.eventCount).toBe(0);
    });

    it('happenedBy answers "what was actually true then"', () => {
      const truth = foldIncident(INCIDENT, events, { happenedBy: '2026-08-01T15:00:00.000Z' });
      expect(truth.eventCount).toBe(1);
      expect(truth.status).toBe('reported');
    });
  });
});

describe('district aggregation', () => {
  it('never lets a calm average hide an open critical (INV-04)', () => {
    const routine = Array.from({ length: 20 }, (_, i) =>
      foldIncident(`inc-r${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'x', severity: 'low' },
          {
            incidentId: `inc-r${i}`,
          },
        ),
      ]),
    );

    const critical = foldIncident('inc-crit', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'inc-crit',
        },
      ),
    ]);

    expect(districtSeverity([...routine, critical])).toEqual({ worst: 'critical', unassessed: 0 });
  });

  it('excludes closed incidents from the district picture', () => {
    const closed = foldIncident('inc-c', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'inc-c',
        },
      ),
      ev('closed', { notes: 'handled' }, { incidentId: 'inc-c' }),
    ]);

    const open = foldIncident('inc-o', [
      ev('reported', { reportId: 'ro', category: 'x', severity: 'low' }, { incidentId: 'inc-o' }),
    ]);

    expect(districtSeverity([closed, open])).toEqual({ worst: 'low', unassessed: 0 });
  });

  /**
   * **A General communication is not part of the district's severity picture — M11-01.**
   *
   * A meeting notice carries a severity only because intake asks every report for one; nobody
   * ever assessed it, and there is nothing about a meeting for a severity to describe. Counting
   * it made a coordination meeting set the district's `worst assessed` — read on the wall, at
   * four metres, as *the worst thing happening in Bajaur right now*.
   *
   * M9-11 fixed exactly this confusion in the **row** renderer, where a notice stopped showing a
   * severity word at all. The **aggregation** was never brought with it, so the value the screen
   * had stopped printing was still the value the summary was ranking.
   *
   * The rule is `isGeneral`, from `events.ts` beside `CARRIES_SLA` — deliberately the same list
   * `overdue` already reads, so "which kinds are emergencies" cannot come to have two answers.
   */
  it('excludes General communications, whose severity nobody ever assessed', () => {
    const notice = foldIncident('inc-m', [
      ev(
        'reported',
        { reportId: 'rm', category: 'general', severity: 'critical', kind: 'meeting' },
        { incidentId: 'inc-m' },
      ),
    ]);

    const emergency = foldIncident('inc-e', [
      ev('reported', { reportId: 're', category: 'rta', severity: 'low' }, { incidentId: 'inc-e' }),
    ]);

    // The notice's `critical` is ignored entirely; the emergency's `low` is the district's worst.
    expect(districtSeverity([notice, emergency])).toEqual({ worst: 'low', unassessed: 0 });

    // And a district holding nothing but notices has no assessed severity at all — `null`,
    // which the board prints as "none". Not `low`, and certainly not `critical`.
    expect(districtSeverity([notice])).toEqual({ worst: null, unassessed: 0 });
  });

  /**
   * **It is dropped, not counted as unassessed — and that distinction is the whole of ADR-0009.**
   *
   * `unassessed` is a number the district acts on: *somebody has to go and look at these*. A
   * meeting notice is not waiting for anybody to assess it, so folding it in there would trade a
   * figure that was wrongly high for a different figure that is wrongly high, and send an
   * operator looking for an emergency that does not exist.
   */
  it('does not count a General communication as unassessed either', () => {
    const notice = foldIncident('inc-m2', [
      ev(
        'reported',
        { reportId: 'rm2', category: 'general', severity: 'unknown', kind: 'schedule' },
        { incidentId: 'inc-m2' },
      ),
    ]);

    expect(districtSeverity([notice])).toEqual({ worst: null, unassessed: 0 });
  });

  /**
   * **An emergency carrying no severity at all is `unassessed`, not absent — M11-06.**
   *
   * `districtSeverity` used to drop it: `.map(s => s.severity?.value).filter(s => s !== undefined)`
   * removed the incident from the count entirely, so the district's *"not yet assessed"* figure
   * silently excluded the reports nobody had assessed **at all** — while `toRow` gave the same
   * incident `severity: 'unknown'` and printed the word **unassessed** on its own row, one line
   * below the figure that was not counting it.
   *
   * It looks unreachable and is not, and where it is reachable is the point: `POST /incidents`
   * cannot refuse (INV-01) so `assumptions.ts` fills a severity in there, but `/sync` appends
   * whatever a handset captured and the fold above only records a severity **if the payload
   * carried one**. So the gap sits exactly on the offline path — the reports that arrive latest,
   * from the parts of the district with the least signal, which is where ADR-0002 says the worst
   * weeks will look emptiest.
   */
  it('counts an emergency with no severity at all as unassessed, never as absent', () => {
    /**
     * ⚠️ **The cast is the test, not a shortcut around the types.**
     *
     * `ReportedPayload` requires a severity, so no well-typed caller can produce this — and that
     * is exactly why it survived. `protocol.ts`'s rule is **strict envelope, permissive
     * payload**: `/sync` accepts a report from a handset that captured no severity and enriches
     * it later, deliberately, because refusing one would lose an emergency (INV-01). The fold
     * then writes `{ value: undefined }` through the branch above, and TypeScript never sees it.
     * Writing this test in the type system's terms would be writing a different test.
     */
    const noSeverity = foldIncident('inc-ns', [
      ev(
        'reported',
        { reportId: 'r-ns', category: 'rta' } as unknown as {
          reportId: string;
          category: string;
          severity: 'unknown';
        },
        { incidentId: 'inc-ns' },
      ),
    ]);

    expect(noSeverity.severity?.value).toBeUndefined();
    expect(districtSeverity([noSeverity])).toEqual({ worst: null, unassessed: 1 });

    // And it does not become a severity on the way: `worst` is what somebody assessed, and
    // nobody assessed this (ADR-0009). Two numbers, neither folded into the other.
    const assessed = foldIncident('inc-a', [
      ev(
        'reported',
        { reportId: 'r-a', category: 'rta', severity: 'low' },
        { incidentId: 'inc-a' },
      ),
    ]);
    expect(districtSeverity([noSeverity, assessed])).toEqual({ worst: 'low', unassessed: 1 });
  });

  describe('unassessed reports (ADR-0009)', () => {
    const unassessed = (id: string): ReturnType<typeof foldIncident> =>
      foldIncident(id, [
        ev(
          'reported',
          { reportId: `r-${id}`, category: 'unknown', severity: 'unknown' },
          { incidentId: id },
        ),
      ]);

    it('counts an unassessed incident instead of ranking it', () => {
      const low = foldIncident('inc-low', [
        ev(
          'reported',
          { reportId: 'rl', category: 'x', severity: 'low' },
          { incidentId: 'inc-low' },
        ),
      ]);

      expect(districtSeverity([low, unassessed('u1'), unassessed('u2')])).toEqual({
        worst: 'low',
        unassessed: 2,
      });
    });

    it('never lets an unassessed report masquerade as a level', () => {
      // Both available lies, refused. Counting it as `low` hides an emergency nobody has
      // looked at; counting it as `critical` drowns the ones somebody has.
      const summary = districtSeverity([unassessed('u1')]);
      expect(summary.worst).toBeNull();
      expect(summary.unassessed).toBe(1);
    });

    it('reports both numbers when the district has criticals and unassessed at once', () => {
      const critical = foldIncident('inc-crit', [
        ev(
          'reported',
          { reportId: 'rc', category: 'flood', severity: 'critical' },
          { incidentId: 'inc-crit' },
        ),
      ]);

      expect(districtSeverity([critical, unassessed('u1')])).toEqual({
        worst: 'critical',
        unassessed: 1,
      });
    });
  });
});

describe('reassignment', () => {
  it('moves responsibility without duplicating the incident', () => {
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev(
        'reassigned',
        {
          fromDepartmentIds: [RESCUE],
          toDepartmentIds: [POLICE],
          reason: 'law and order, not medical',
        },
        { actorSeatId: controlRoom.seatId },
      ),
    ]);

    expect(state.responsibleDepartmentIds).toEqual([POLICE]);
    expect(state.incidentId).toBe(INCIDENT);
  });

  /**
   * The incident's start comes from the report, and from nothing else.
   *
   * M1-04 let an action state when it actually happened — a crew writes up an hour of work at
   * once, and "on scene" belongs at the time they arrived. The fold used to take the earliest
   * `occurredAt` of **any** event, so a backdated action moved the incident's start and every
   * SLA deadline measured from it: an incident could become overdue, or stop being overdue,
   * because somebody wrote their notes up honestly.
   *
   * Found by the M1 gate, in the post-incident report's own timings.
   */
  describe('when the emergency happened', () => {
    const incidentId = 'inc-backdated';
    const reportedAt = '2026-08-03T10:00:00.000Z';

    function event(over: Record<string, unknown>): IncidentEvent {
      return {
        eventId: randomUUID(),
        incidentId,
        recordedAt: '2026-08-03T10:30:00.000Z',
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        ...over,
      } as unknown as IncidentEvent;
    }

    it('is the report time, not the earliest event', () => {
      const state = foldIncident(incidentId, [
        event({
          type: 'reported',
          occurredAt: reportedAt,
          clientSeq: 1,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        }),
        event({
          // Backdated an hour before the report, which is unusual and legitimate: a crew can
          // be on scene before anybody thinks to report it.
          type: 'action_logged',
          occurredAt: '2026-08-03T09:00:00.000Z',
          clientSeq: 2,
          payload: { note: 'on scene' },
        }),
      ]);

      expect(state.occurredAt).toBe(reportedAt);
    });

    it('is the earliest report when an incident has more than one', () => {
      // One incident, many reports (ADR-0006). The emergency started when the first person
      // said so, not when the second confirmed it.
      const state = foldIncident(incidentId, [
        event({
          type: 'reported',
          occurredAt: '2026-08-03T10:05:00.000Z',
          clientSeq: 2,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'high' },
        }),
        event({
          type: 'reported',
          occurredAt: reportedAt,
          clientSeq: 1,
          payload: { reportId: randomUUID(), category: 'fire', severity: 'critical' },
        }),
      ]);

      expect(state.occurredAt).toBe(reportedAt);
    });

    it('is null when nothing has been reported yet', () => {
      // Rather than borrowing a time from some other event and presenting it as the moment
      // an emergency began.
      const state = foldIncident(incidentId, [
        event({ type: 'action_logged', occurredAt: reportedAt, payload: { note: 'orphan' } }),
      ]);

      expect(state.occurredAt).toBeNull();
    });
  });
});
