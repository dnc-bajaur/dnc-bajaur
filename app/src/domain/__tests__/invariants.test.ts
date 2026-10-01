/**
 * Permanent tests for the invariants in docs/01-invariants.md.
 *
 * These are not ordinary unit tests. Each one guards something whose failure would cause
 * real harm in a district emergency, and a build that breaks one is broken regardless of
 * what else passes. Do not delete or weaken a test here to make a change go through —
 * if an invariant genuinely needs to change, that is an ADR and an owner decision.
 *
 * Four invariants are guarded here, at the domain layer: INV-04, INV-06, INV-07, INV-08.
 *
 * Two more are guarded elsewhere, because they are properties of the running system and a
 * pure-domain test cannot demonstrate either:
 *   - INV-01 (an emergency is never lost) — `src/__tests__/spine.e2e.test.ts`, real
 *     Chromium with the network cut, real IndexedDB, real PostgreSQL.
 *   - INV-05 (the UI is never the enforcement layer) — `src/auth/__tests__/auth.test.ts`,
 *     every refusal made by direct HTTP call, never through a rendered page.
 *
 *   - INV-03 (a notification failure is never invisible) — the domain half is below; the
 *     running-system half is `src/jobs/__tests__/notify.test.ts`, which proves a failed
 *     attempt reaches the central board rather than a log line.
 *
 * One is still uncovered and stays listed here so the gap is visible rather than forgotten:
 *   - INV-02 (stale data is never rendered as current) — enforced by the board and detail
 *     screens and tested there (`board.e2e.test.ts` tests 5 and 6), but it has no
 *     domain-level guard, because staleness is a property of a rendering rather than of a
 *     fold. If a third screen is built, that test is the one to copy.
 */

import { describe, expect, it } from 'vitest';

import { foldIncident, districtSeverity, type NotificationAttempt } from '../incident.js';
import { unmetObligations } from '../notifications.js';
import { evaluateWrite, defaultRules } from '../authority.js';
import { checkEscalation } from '../sla.js';
import {
  INCIDENT,
  RESCUE,
  controlRoom,
  dc,
  policeOperator,
  rescueOperator,
  ev,
} from './fixtures.js';

const severityRule = defaultRules(RESCUE).find((r) => r.fieldKey === 'incident.severity')!;
const actionsRule = defaultRules(RESCUE).find((r) => r.fieldKey === 'incident.actions')!;

describe('INV-04 — an aggregate never hides a critical', () => {
  it('one open critical dominates any number of routine incidents', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      foldIncident(`i${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'x', severity: 'low' },
          { incidentId: `i${i}` },
        ),
      ]),
    );
    const critical = foldIncident('crit', [
      ev(
        'reported',
        { reportId: 'rc', category: 'flood', severity: 'critical' },
        {
          incidentId: 'crit',
        },
      ),
    ]);
    expect(districtSeverity([...many, critical])).toEqual({ worst: 'critical', unassessed: 0 });
  });

  it('does not hide an unassessed incident behind a level either (ADR-0009)', () => {
    // The other half of the same invariant. A summary that folded unassessed reports into
    // `low` would hide them exactly as an average hides a critical — and folding them into
    // `critical` would hide the real criticals among them.
    const unassessed = Array.from({ length: 20 }, (_, i) =>
      foldIncident(`u${i}`, [
        ev(
          'reported',
          { reportId: `r${i}`, category: 'unknown', severity: 'unknown' },
          { incidentId: `u${i}` },
        ),
      ]),
    );
    const low = foldIncident('lo', [
      ev('reported', { reportId: 'rl', category: 'x', severity: 'low' }, { incidentId: 'lo' }),
    ]);

    expect(districtSeverity([...unassessed, low])).toEqual({ worst: 'low', unassessed: 20 });
  });
});

describe('INV-03 — a notification failure is never invisible', () => {
  const attempt = (over: Partial<NotificationAttempt> = {}): NotificationAttempt => ({
    attemptId: 'a-1',
    seatId: 'seat-rescue',
    channel: 'web',
    reason: 'routed',
    attemptedAt: '2026-08-02T10:00:00.000Z',
    state: 'pending',
    ...over,
  });

  it('a failed attempt is an unmet obligation immediately', () => {
    // No waiting period. We already know nobody was reached, and a delay before saying so
    // is a delay before anybody can fix it.
    const unmet = unmetObligations(
      [attempt({ state: 'failed', failure: 'no_duty_holder' })],
      '2026-08-02T10:00:01.000Z',
    );
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.why).toBe('failed');
  });

  it('a pending attempt becomes an unmet obligation once it has waited too long', () => {
    const later = '2026-08-02T10:30:00.000Z';
    expect(unmetObligations([attempt()], later)[0]?.why).toBe('undelivered');
  });

  it('reports a failure and a silence as different things', () => {
    // One needs a roster fixed, the other needs a phone answered. A single number would
    // leave the control room unable to tell which.
    const unmet = unmetObligations(
      [attempt({ attemptId: 'a-1', state: 'failed', failure: 'x' }), attempt({ attemptId: 'a-2' })],
      '2026-08-02T10:30:00.000Z',
    );
    expect(unmet.map((u) => u.why).sort()).toEqual(['failed', 'undelivered']);
  });

  it('never treats a delivered attempt as unmet', () => {
    const delivered = attempt({ state: 'delivered', settledAt: '2026-08-02T10:00:30.000Z' });
    expect(unmetObligations([delivered], '2026-08-03T10:00:00.000Z')).toHaveLength(0);
  });

  it('keeps every attempt on the incident rather than collapsing them to a boolean', () => {
    // The literal words of the invariant: "NotificationAttempt is never collapsed into a
    // boolean on the incident". The collapse is the step that makes a failure invisible.
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'r', category: 'rta', severity: 'high' }),
      ev('notified', { attemptId: 'a-1', seatId: 'seat-a', channel: 'web', reason: 'routed' }),
      ev('notified', { attemptId: 'a-2', seatId: 'seat-b', channel: 'web', reason: 'escalated' }),
      ev('notification_failed', {
        attemptId: 'a-2',
        seatId: 'seat-b',
        channel: 'web',
        failure: 'no_duty_holder',
      }),
    ]);

    expect(state.notifications).toHaveLength(2);
    expect(state.notifications.find((n) => n.attemptId === 'a-1')?.state).toBe('pending');

    const failed = state.notifications.find((n) => n.attemptId === 'a-2');
    expect(failed?.state).toBe('failed');
    // The reason survives the fold. "It failed" without "why" is not actionable.
    expect(failed?.failure).toBe('no_duty_holder');
  });

  it('an outcome never rewrites the attempt it settles', () => {
    // Append-only, all the way down: the delivery does not erase when it was attempted, so
    // "how long did this sit unread" stays answerable (ADR-0001).
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'r', category: 'rta', severity: 'high' }),
      ev(
        'notified',
        { attemptId: 'a-1', seatId: 'seat-a', channel: 'web', reason: 'routed' },
        { occurredAt: '2026-08-02T10:00:00.000Z' },
      ),
      ev(
        'notification_delivered',
        { attemptId: 'a-1', seatId: 'seat-a', channel: 'web' },
        { occurredAt: '2026-08-02T10:04:00.000Z' },
      ),
    ]);

    const settled = state.notifications[0]!;
    expect(settled.state).toBe('delivered');
    expect(settled.attemptedAt).toBe('2026-08-02T10:00:00.000Z');
    expect(settled.settledAt).toBe('2026-08-02T10:04:00.000Z');
  });
});

describe('INV-06 — no sensitive action is unattributable', () => {
  /**
   * ⚠️ **The guarantee moved layers on 2026-08-22 (ADR-0024); it did not weaken.**
   *
   * This asserted that `evaluateWrite` refuses the control room without a reason. It did so
   * because the control room was **overriding the department that owned the field** — and
   * `ownerTiers` has since made them the owner, so there is nobody left to override and nothing
   * to explain to.
   *
   * ⚠️ **The reason on an `override` is still mandatory, and `api/server.ts`'s `parseCommand`
   * is what makes it so** — `reason is required`, refused before a command is ever built. That
   * is the right home for it: *override* is a **command**, not a property of a field, and
   * `reasonRequired` on the rule only ever described overruling an owner.
   *
   * What this file must still hold is the invariant itself — **a seat with no claim on a field
   * cannot buy one with a sentence** — and that is asserted here.
   */
  it('refuses a seat with no ownership, reason or not', () => {
    const without = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
    });
    expect(without.allowed).toBe(false);

    const withReason = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
      reason: 'it looks worse to me',
    });
    expect(withReason.allowed).toBe(false);
  });

  it('refuses break-glass without a reason, even for the DC', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.closure',
      seat: dc,
      breakGlass: true,
    });
    expect(d.allowed).toBe(false);
  });

  it('records the acting seat as held at that moment, not as held today', () => {
    const state = foldIncident(INCIDENT, [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev(
        'acknowledged',
        { seatId: rescueOperator.seatId },
        {
          actorSeatId: rescueOperator.seatId,
          actorPersonId: 'officer-departed-since',
        },
      ),
    ]);
    expect(state.acknowledgedBySeatId).toBe(rescueOperator.seatId);
  });
});

describe('INV-07 — an SLA clock never runs on a client', () => {
  it('escalates an unacknowledged critical with every client offline', () => {
    // No client participated: the only inputs are stored timestamps and server time.
    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T10:00:00.000Z',
      recordedAt: '2026-08-01T10:00:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T10:06:00.000Z',
    });
    expect(verdict.shouldEscalate).toBe(true);
  });

  it('does not escalate once acknowledged', () => {
    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T10:00:00.000Z',
      recordedAt: '2026-08-01T10:00:00.000Z',
      acknowledgedAt: '2026-08-01T10:03:00.000Z',
      now: '2026-08-01T11:00:00.000Z',
    });
    expect(verdict.shouldEscalate).toBe(false);
  });
});

/**
 * 🔴 **The district's response workflow, 2026-08-24, arriving at INV-03.**
 *
 * An acknowledgement and *somebody has taken this* were one fact until officers were given a way
 * to acknowledge and then say *"Unable to Respond"*. The failure this guards is the quiet one: a
 * critical emergency, four officers, four acknowledgements, four declines — clock stopped, ladder
 * never climbing, board green, and nobody on the way.
 */
describe('INV-03 — an acknowledgement nobody is holding does not stop the ladder', () => {
  const declined = {
    severity: 'critical',
    occurredAt: '2026-08-01T10:00:00.000Z',
    recordedAt: '2026-08-01T10:00:00.000Z',
    acknowledgedAt: '2026-08-01T10:03:00.000Z',
    now: '2026-08-01T11:00:00.000Z',
  } as const;

  it('escalates an acknowledged emergency that every recipient declined', () => {
    const verdict = checkEscalation({ ...declined, ownerless: true });
    expect(verdict.shouldEscalate).toBe(true);
  });

  /**
   * The account somebody reads months later, asking why a Deputy Commissioner was woken.
   * *"Nobody answered"* and *"everybody answered and every one declined"* are different nights.
   */
  it('says which of the two nights it was', () => {
    expect(checkEscalation({ ...declined, ownerless: true }).reason).toContain(
      'every recipient declined',
    );
    expect(
      checkEscalation({ ...declined, acknowledgedAt: null, ownerless: false }).reason,
    ).toContain('unacknowledged');
  });

  it('leaves an acknowledgement somebody is holding exactly as it was', () => {
    expect(checkEscalation({ ...declined, ownerless: false }).shouldEscalate).toBe(false);
    expect(checkEscalation(declined).shouldEscalate).toBe(false);
    expect(checkEscalation({ ...declined, ownerless: false }).reason).toBe('acknowledged');
  });

  /**
   * ⚠️ **Ownerless is not a licence to escalate early.** The deadline is the deadline: an officer
   * who declines at minute three of a fifteen-minute target has not made the emergency overdue,
   * they have made it unheld. The ladder climbs when the clock says so, and not before.
   */
  it('still waits for the deadline before climbing', () => {
    const verdict = checkEscalation({
      ...declined,
      ownerless: true,
      now: '2026-08-01T10:04:00.000Z',
    });
    expect(verdict.shouldEscalate).toBe(false);
  });
});

describe('INV-08 — recovery never produces a notification storm', () => {
  it('a late-arriving incident gets a grace window, not instant retroactive escalation', () => {
    // Reported 14:02, synced 16:40 after an outage. Escalating immediately on arrival
    // would page the duty officer about every queued incident at once.
    const onArrival = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T14:02:00.000Z',
      recordedAt: '2026-08-01T16:40:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T16:40:00.000Z',
    });

    expect(onArrival.lateArrival).toBe(true);
    expect(onArrival.shouldEscalate).toBe(false);
    // ...but the metrics still tell the truth about how long it really took.
    expect(Math.round(onArrival.overdueByMinutes)).toBe(153);
  });

  it('escalates after the grace window if still unacknowledged', () => {
    const later = checkEscalation({
      severity: 'critical',
      occurredAt: '2026-08-01T14:02:00.000Z',
      recordedAt: '2026-08-01T16:40:00.000Z',
      acknowledgedAt: null,
      now: '2026-08-01T16:55:00.000Z',
    });
    expect(later.shouldEscalate).toBe(true);
  });

  it('replaying the same events twice changes nothing', () => {
    const events = [
      ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'high' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('acknowledged', { seatId: rescueOperator.seatId }),
    ];

    const once = foldIncident(INCIDENT, events);
    const twice = foldIncident(INCIDENT, [...events, ...events]);

    expect(twice).toEqual(once);
    expect(twice.eventCount).toBe(3);
  });
});

describe('cross-department access is denied by default', () => {
  it('refuses a police seat writing a Rescue-owned field', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
      reason: 'looks worse to me',
    });
    expect(d.allowed).toBe(false);
  });

  /**
   * ⚠️ **Rewritten 2026-08-22 (ADR-0024), and the half that mattered is kept.**
   *
   * This asserted that **nobody** may write an append-only field — the control room and the DC
   * included, even with break-glass. That was true while the field was owned by the responsible
   * department, and it had a cost nobody had noticed: **the control room could not log an action
   * on an emergency held by another department at all**, because `appendOnly` returns before
   * `overrideTiers` is ever consulted. `log_action` is reachable over the API alone, so it never
   * surfaced as a complaint.
   *
   * With `ownerTiers`, the control room owns it and can append — which is the fix. **What must
   * not follow is that an append-only field becomes overridable**, and two things hold that: a
   * seat that owns nothing is still refused outright, break-glass included; and `parseCommand`
   * will not build an override for any field but `severity` or `category`, so `incident.actions`
   * can never be the subject of one.
   */
  it('lets the owner append, and refuses everybody else — break-glass included', () => {
    const owner = evaluateWrite(actionsRule, { fieldKey: 'incident.actions', seat: controlRoom });
    expect(owner).toEqual({ allowed: true, as: 'owner' });

    const outsider = evaluateWrite(actionsRule, {
      fieldKey: 'incident.actions',
      seat: policeOperator,
      reason: 'correcting the record',
      breakGlass: true,
    });
    expect(outsider.allowed).toBe(false);
  });
});
