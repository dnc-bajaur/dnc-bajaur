/**
 * What a department can send, and whether it can send it now — M1-02.
 *
 * Pure functions. The database side is tested in `api/__tests__/resources.test.ts`.
 *
 * The rule worth reading this file for is `canDispatch`: a unit already committed elsewhere
 * is **allowed with a warning**, not refused. That is a deliberate choice about who decides,
 * and it is the one most likely to be "tidied" into a refusal by somebody who has not stood
 * in a control room with one ambulance and two road accidents.
 */

import { describe, expect, it } from 'vitest';

import {
  blockedBy,
  canDispatch,
  summarise,
  type Commitment,
  type Resource,
  type ResourceAvailability,
} from '../resources.js';

function unit(over: Partial<Resource> = {}): Resource {
  return {
    resourceId: 'res-1',
    departmentId: 'dept-rescue',
    kind: 'vehicle',
    name: 'Ambulance 3',
    identifier: 'BNU-1234',
    outOfServiceAt: null,
    outOfServiceReason: null,
    retiredAt: null,
    members: [],
    ...over,
  };
}

const atAnRta: Commitment = {
  incidentId: 'inc-1',
  since: '2026-08-03T09:00:00.000Z',
  category: 'road accident',
  severity: 'critical',
};

describe('blockedBy', () => {
  it('says nothing about a free unit', () => {
    expect(blockedBy(unit(), [])).toEqual([]);
  });

  it('reports being committed', () => {
    expect(blockedBy(unit(), [atAnRta])).toEqual(['committed']);
  });

  /**
   * Both reasons, not the first.
   *
   * An ambulance in the workshop that is *also* still recorded against an open incident is
   * two problems for two people: a mechanic, and a duty officer who never closed a job.
   * Returning only the first hides the second for as long as the vehicle stays in the
   * workshop — which could be weeks.
   */
  it('reports every reason a unit cannot simply be sent', () => {
    const broken = unit({
      outOfServiceAt: '2026-08-01T00:00:00.000Z',
      outOfServiceReason: 'gearbox',
    });
    expect(blockedBy(broken, [atAnRta])).toEqual(['out_of_service', 'committed']);
  });

  it('reports a retired unit as retired', () => {
    expect(blockedBy(unit({ retiredAt: '2026-01-01T00:00:00.000Z' }), [])).toEqual(['retired']);
  });
});

describe('canDispatch', () => {
  it('allows a free unit with nothing to say', () => {
    expect(canDispatch(unit(), [])).toEqual({ allowed: true, warning: null, why: null });
  });

  it('refuses a unit in the workshop, and repeats the reason somebody gave', () => {
    const broken = unit({
      outOfServiceAt: '2026-08-01T00:00:00.000Z',
      outOfServiceReason: 'gearbox stripped, at the workshop',
    });
    const verdict = canDispatch(broken, []);

    expect(verdict.allowed).toBe(false);
    // The reason the district entered, not a generic "unavailable". Whoever is looking at
    // this is deciding what to send instead, and "gearbox" and "no driver" lead somewhere
    // different.
    expect(verdict.why).toContain('gearbox');
  });

  it('refuses a retired unit', () => {
    expect(canDispatch(unit({ retiredAt: '2026-01-01T00:00:00.000Z' }), []).allowed).toBe(false);
  });

  /**
   * The rule this module exists for.
   *
   * A district with one ambulance and two road accidents must be able to move it. Refusing
   * would be the software overruling the only person who can see both scenes — and it would
   * be overruling them at the moment they are least able to argue with it.
   *
   * What the system owes them is not a veto. It is that the consequence is **said out loud**
   * before they commit (ADR-0005).
   */
  it('allows a committed unit to be moved, and says what is being taken off', () => {
    const verdict = canDispatch(unit(), [atAnRta]);

    expect(verdict.allowed).toBe(true);
    expect(verdict.why).toBeNull();
    expect(verdict.warning).toContain('already committed');
    expect(verdict.warning).toContain('road accident');
    expect(verdict.warning).toContain('committed to both');
  });

  it('names every incident it is being taken off, not just how many', () => {
    const second: Commitment = {
      incidentId: 'inc-2',
      since: '2026-08-03T09:30:00.000Z',
      category: 'structure fire',
      severity: 'high',
    };
    const verdict = canDispatch(unit(), [atAnRta, second]);

    expect(verdict.warning).toContain('road accident');
    expect(verdict.warning).toContain('structure fire');
    expect(verdict.warning).toContain('2 open incidents');
  });

  it('refuses a broken unit even when it is also committed', () => {
    // Out of service wins: it is a fact about the vehicle, and no operator judgement makes a
    // stripped gearbox drive to an incident.
    const broken = unit({
      outOfServiceAt: '2026-08-01T00:00:00.000Z',
      outOfServiceReason: 'gearbox',
    });
    expect(canDispatch(broken, [atAnRta]).allowed).toBe(false);
  });
});

describe('summarise', () => {
  function availability(
    over: Partial<ResourceAvailability> & { id: string },
  ): ResourceAvailability {
    return {
      resource: unit({ resourceId: over.id, name: over.id }),
      blockedBy: [],
      commitments: [],
      ...over,
    };
  }

  it('counts an empty fleet as empty rather than as available', () => {
    expect(summarise([])).toEqual({ total: 0, available: 0, committed: 0, outOfService: 0 });
  });

  it('counts free, committed and out of service separately', () => {
    const summary = summarise([
      availability({ id: 'free-1' }),
      availability({ id: 'free-2' }),
      availability({ id: 'busy', commitments: [atAnRta] }),
      availability({
        id: 'broken',
        resource: unit({
          name: 'broken',
          outOfServiceAt: '2026-08-01T00:00:00.000Z',
          outOfServiceReason: 'x',
        }),
      }),
    ]);

    expect(summary).toEqual({ total: 4, available: 2, committed: 1, outOfService: 1 });
  });

  /**
   * The parts must equal the whole.
   *
   * A unit that is both in the workshop and still attached to an open incident would
   * otherwise be counted twice, and a summary where 3 + 1 + 1 = 4 is a summary an operator
   * stops trusting — and then stops reading.
   */
  it('never counts a unit twice, however many things are wrong with it', () => {
    const summary = summarise([
      availability({
        id: 'both',
        resource: unit({
          name: 'both',
          outOfServiceAt: '2026-08-01T00:00:00.000Z',
          outOfServiceReason: 'x',
        }),
        commitments: [atAnRta],
      }),
      availability({ id: 'free' }),
    ]);

    expect(summary.available + summary.committed + summary.outOfService).toBe(summary.total);
    expect(summary).toEqual({ total: 2, available: 1, committed: 0, outOfService: 1 });
  });

  it('leaves retired units out of the count entirely', () => {
    // A retired unit is not a unit the department has. Counting it as unavailable would make
    // a department that had retired ten vehicles look like one in trouble.
    const summary = summarise([
      availability({ id: 'live' }),
      availability({
        id: 'gone',
        resource: unit({ name: 'gone', retiredAt: '2026-01-01T00:00:00.000Z' }),
      }),
    ]);

    expect(summary.total).toBe(1);
  });
});
