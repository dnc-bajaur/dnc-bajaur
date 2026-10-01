/**
 * Which deadline applies, and to whom.
 *
 * This file exists because `targetsFor` shipped wrong the first time. It merged a
 * department's override into the district default by taking whichever was **tighter**, which
 * looks defensible and is not: a department given a longer deadline than the district
 * silently kept the district's shorter one, so the administration set 999 minutes on a
 * screen and the board went on measuring against 240. The number an operator reads was not
 * the number anybody chose.
 *
 * The bug was caught by an integration test asserting what the board rendered, which is the
 * only place it was visible. These are the unit tests that should have existed first.
 */

import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_SLA, targetsFor, type SlaConfig } from '../sla.js';

const RESCUE = 'dept-rescue';
const POLICE = 'dept-police';

const config: SlaConfig = {
  district: { critical: 5, high: 15, moderate: 60, low: 240, unknown: 15 },
  byDepartment: {
    [RESCUE]: { critical: 2, low: 999 },
    [POLICE]: { critical: 10 },
  },
};

describe('targetsFor', () => {
  it('falls back to the district default when nobody holds the incident', () => {
    // Correct rather than merely convenient: there is no department deadline until there is
    // a department.
    expect(targetsFor(config, [])).toEqual(config.district);
  });

  it('uses the district default for a department that has set nothing', () => {
    expect(targetsFor(config, ['dept-with-no-overrides'])).toEqual(config.district);
  });

  it('applies a department override that is tighter than the district', () => {
    expect(targetsFor(config, [RESCUE]).critical).toBe(2);
  });

  /**
   * The regression. An override replaces the default; it does not merely tighten it.
   *
   * If this ever goes back to 240, the administration can no longer give a department more
   * time than the district — and worse, the screen will not say so.
   */
  it('applies a department override that is LOOSER than the district', () => {
    expect(targetsFor(config, [RESCUE]).low).toBe(999);
  });

  it('leaves the severities a department did not override at the district value', () => {
    const t = targetsFor(config, [RESCUE]);
    expect(t.high).toBe(config.district.high);
    expect(t.moderate).toBe(config.district.moderate);
  });

  /**
   * Across departments, the strictest obligation governs. At 2 minutes Rescue is genuinely
   * late even though Police is not, and a board reporting "on time" would be choosing the
   * more comfortable of two true statements.
   */
  it('takes the tightest deadline when two departments hold one incident', () => {
    expect(targetsFor(config, [RESCUE, POLICE]).critical).toBe(2);
    expect(targetsFor(config, [POLICE, RESCUE]).critical).toBe(2);
  });

  it('does not let one department’s loose override relax another department’s deadline', () => {
    // Rescue has 999 for `low`; Police inherits the district's 240. The pair is 240.
    expect(targetsFor(config, [RESCUE, POLICE]).low).toBe(240);
  });

  it('is unaffected by the order departments are listed in', () => {
    expect(targetsFor(config, [RESCUE, POLICE])).toEqual(targetsFor(config, [POLICE, RESCUE]));
  });

  it('never mutates the configuration it was given', () => {
    const before = JSON.stringify(config);
    targetsFor(config, [RESCUE, POLICE]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('gives `unknown` a deadline, because an unassessed report still needs one', () => {
    // ADR-0009: not a level, but the urgency has to live somewhere, and it lives here.
    expect(targetsFor(config, [RESCUE]).unknown).toBeGreaterThan(0);
    expect(PLACEHOLDER_SLA.unknown).toBe(PLACEHOLDER_SLA.high);
  });
});
