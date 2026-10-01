import { describe, expect, it } from 'vitest';

import { defaultRules, evaluateWrite, resolveConflict } from '../authority.js';
import { foldIncident } from '../incident.js';
import {
  INCIDENT,
  RESCUE,
  controlRoom,
  dc,
  ev,
  policeOperator,
  rescueOperator,
  rescueSupervisor,
} from './fixtures.js';

const rules = defaultRules(RESCUE);
const severityRule = rules.find((r) => r.fieldKey === 'incident.severity')!;
const closureRule = rules.find((r) => r.fieldKey === 'incident.closure')!;

describe('evaluateWrite', () => {
  /**
   * 🔴 **THE CONTROL ROOM OWNS THESE FIELDS; A DEPARTMENT OWNS NOTHING — 2026-08-22.**
   *
   * The three tests this replaces asserted the old shape: the responsible department wrote its own
   * field as **owner**, and a district seat could **override** it with a reason. The district
   * removed the first half outright — *"department ko koi access nahi milne wala hai, un ka koi
   * account nahi banega"* — and the second half went with it, because there is no longer an owner
   * to override.
   *
   * ⚠️ **The reason is what makes this a real change rather than a relabelling.** Had ownership
   * simply been dropped, every act by the control room would have become an override, and
   * `reasonRequired` would have demanded a typed justification on **every triage, every
   * acknowledgement, every resolve** — a sentence extracted from the only people left who can act,
   * for overriding nobody. `ownerTiers` exists to say what they actually have.
   */
  it('lets the control room write a governed field as its owner, with no reason', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.severity', seat: controlRoom });
    expect(d).toEqual({ allowed: true, as: 'owner' });
  });

  it('refuses the responsible department, which no longer owns anything', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.severity', seat: rescueOperator });
    expect(d.allowed).toBe(false);
  });

  it('refuses a department seat even when it offers a reason', () => {
    // A reason lifts `reasonRequired` on an override. It is not a way in for a tier that has
    // neither ownership nor override authority — otherwise the rule would be advisory.
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: rescueOperator,
      reason: 'second reporter confirms casualties',
    });
    expect(d.allowed).toBe(false);
  });

  it('refuses a seat with no relationship to the field', () => {
    const d = evaluateWrite(severityRule, {
      fieldKey: 'incident.severity',
      seat: policeOperator,
      reason: 'anything',
    });
    expect(d.allowed).toBe(false);
  });

  it('refuses a rule that does not govern the attempted field', () => {
    const d = evaluateWrite(severityRule, { fieldKey: 'incident.closure', seat: rescueOperator });
    expect(d.allowed).toBe(false);
  });

  describe('break-glass', () => {
    it('allows a DC-tier seat to act outside the table, with a reason', () => {
      /**
       * ⚠️ **`ownerTiers` stripped as well as `overrideTiers`, since 2026-08-22.**
       *
       * Both fixtures here are district-tier, and district now **owns** every governed field — so
       * a rule that only removed `overrideTiers` would be answered by ownership long before
       * break-glass was reached, and these two tests would pass while measuring nothing.
       */
      const noAuthority = { ...closureRule, overrideTiers: [] as const, ownerTiers: [] as const };
      const d = evaluateWrite(noAuthority, {
        fieldKey: 'incident.closure',
        seat: dc,
        reason: 'department unreachable during shutdown; closing on radio confirmation',
        breakGlass: true,
      });
      expect(d).toEqual({ allowed: true, as: 'break_glass' });
    });

    it('is not available to a seat without the flag', () => {
      const noAuthority = { ...closureRule, overrideTiers: [] as const, ownerTiers: [] as const };
      const d = evaluateWrite(noAuthority, {
        fieldKey: 'incident.closure',
        seat: controlRoom,
        reason: 'urgent',
        breakGlass: true,
      });
      expect(d.allowed).toBe(false);
    });
  });

  it('generates a decision for every rule in the table', () => {
    // The policy table is data, so every row is exercised rather than hand-picked.
    for (const rule of rules) {
      // A post-tier seat has no authority over any governed field since ADR-0024 — ownership is
      // the district tier's, and `ownerDepartmentId` is gone entirely (ADR-0031, phase 4).
      const outsider = evaluateWrite(rule, {
        fieldKey: rule.fieldKey,
        seat: policeOperator,
        reason: 'x',
      });
      expect(outsider.allowed).toBe(false);
    }
  });
});

describe('resolveConflict', () => {
  it('higher authority wins over a later timestamp', () => {
    const r = resolveConflict(
      { seat: controlRoom, at: '2026-08-01T10:00:00.000Z' },
      { seat: rescueOperator, at: '2026-08-01T10:05:00.000Z' },
    );
    expect(r).toEqual({ winner: 'a', by: 'authority' });
  });

  it('falls back to time at equal authority', () => {
    const r = resolveConflict(
      { seat: rescueOperator, at: '2026-08-01T10:00:00.000Z' },
      { seat: policeOperator, at: '2026-08-01T10:05:00.000Z' },
    );
    expect(r).toEqual({ winner: 'b', by: 'time' });
  });
});

describe('override provenance (ADR-0003)', () => {
  const events = [
    ev('reported', { reportId: 'rep-1', category: 'rta', severity: 'moderate' }),
    ev('triaged', { severity: 'high', category: 'rta' }, { actorSeatId: rescueOperator.seatId }),
    ev(
      'overridden',
      {
        field: 'severity',
        value: 'critical',
        reason: 'multiple casualties confirmed by second reporter',
      },
      { actorSeatId: controlRoom.seatId, actorPersonId: 'control-1' },
    ),
  ];

  it('the override wins the projection', () => {
    expect(foldIncident(INCIDENT, events).severity?.value).toBe('critical');
  });

  it("the department's own assessment survives underneath", () => {
    const from = foldIncident(INCIDENT, events).severity?.overriddenFrom;
    expect(from?.value).toBe('high');
    expect(from?.setBy.seatId).toBe(rescueOperator.seatId);
    expect(from?.reason).toBe('multiple casualties confirmed by second reporter');
    expect(from?.overriddenBy.seatId).toBe(controlRoom.seatId);
  });

  it('a later department reassessment does not silently undo the override', () => {
    const withReassess = [
      ...events,
      ev(
        'triaged',
        { severity: 'moderate', category: 'rta' },
        {
          actorSeatId: rescueSupervisor.seatId,
        },
      ),
    ];
    expect(foldIncident(INCIDENT, withReassess).severity?.value).toBe('critical');
  });
});
