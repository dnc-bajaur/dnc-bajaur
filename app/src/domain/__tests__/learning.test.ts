/**
 * The system learns who the control room tells — M7-15…M7-22, pure.
 *
 * Every threshold here is a judgement about **how wrong it is safe to be**, and the tests are
 * written to pin the direction of the error rather than the arithmetic. A proposal that fires
 * too readily trains operators to accept pre-ticks without reading them, and then one quiet
 * Tuesday's mistake becomes the district's standing rule. A proposal that fires too rarely
 * costs a few seconds at 02:00.
 *
 * The second failure is much cheaper than the first, and every test below is on that side.
 */

import { describe, expect, it } from 'vitest';

import {
  groupSuggestions,
  proposalsFor,
  PROPOSE_SHARE,
  PROPOSE_TIMES,
  SUGGEST_GROUP_TIMES,
  type PastDispatch,
} from '../learning.js';
import type { DispatchTarget } from '../events.js';

// Duty-post ids. Since ADR-0031 (phase 2) `'department'` has left `RecipientKind`, so what the
// district's habit teaches is a post — authority attaches to the post (ADR-0004), and so does
// this. The `never learns a person` test below is unchanged and still load-bearing.
const RESCUE = '11111111-1111-4111-8111-111111111111';
const POLICE = '22222222-2222-4222-8222-222222222222';
const HEALTH = '33333333-3333-4333-8333-333333333333';
const OFFICER = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';

function post(id: string): DispatchTarget {
  return { kind: 'post', id };
}

function fires(n: number, targets: readonly DispatchTarget[]): PastDispatch[] {
  return Array.from({ length: n }, () => ({ category: 'fire', targets: [...targets] }));
}

describe('what the district usually does', () => {
  it('proposes a post the control room reaches for every time', () => {
    const proposals = proposalsFor(fires(9, [post(RESCUE)]), 'fire');

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe(RESCUE);
    // **Both numbers, never the ratio alone** — "90%" reads identically at nine-of-ten and at
    // ninety-of-a-hundred, and only one of those is worth acting on.
    expect(proposals[0]?.because).toBe('you told them for 9 of the last 9 fire reports');
  });

  it('says nothing at all until it has seen enough', () => {
    /**
     * Four perfect dispatches is 100%, and 100% of four is a fortnight of one operator's
     * habit — quite possibly one operator who was on nights. The share alone is a trap: one
     * dispatch is 100% of one dispatch.
     */
    expect(proposalsFor(fires(PROPOSE_TIMES - 1, [post(RESCUE)]), 'fire')).toHaveLength(0);
    expect(proposalsFor(fires(PROPOSE_TIMES, [post(RESCUE)]), 'fire')).toHaveLength(1);
  });

  it('says nothing about a post the district only sometimes tells', () => {
    // Five appearances out of eleven — over the count, under the share. Pre-ticking a
    // department chosen fewer than half the time is the software making a decision the
    // operator was already making better.
    const history = [...fires(5, [post(RESCUE), post(POLICE)]), ...fires(6, [post(RESCUE)])];

    const proposals = proposalsFor(history, 'fire');
    expect(proposals.map((p) => p.id)).toEqual([RESCUE]);
    expect(5 / 11).toBeLessThan(PROPOSE_SHARE);
  });

  it('never learns a person, however often they are chosen', () => {
    /**
     * M7-19, and the reason is not privacy. A model that learns *"we always call this
     * officer"* wakes one person every night, **through a system**, and they will never
     * complain — they will silence the phone, and then the district has an officer who cannot
     * be reached and no way to know it. Authority attaches to the post (ADR-0004), and so does
     * this.
     */
    const history = fires(20, [
      { kind: 'person', id: OFFICER },
      { kind: 'post', id: POST },
    ]);

    const proposals = proposalsFor(history, 'fire');
    expect(proposals.map((p) => p.kind)).toEqual(['post']);
  });

  it('counts one dispatch once, however many ways it named the same recipients', () => {
    /**
     * A selection can name a post **and** another post held by the same officer — `collapseSelection` records
     * what was absorbed rather than dropping it, so both survive onto the event. Counting each
     * appearance would let one operator's habit of ticking both push a department past the
     * threshold on half the actual evidence.
     */
    const history: PastDispatch[] = Array.from({ length: 6 }, () => ({
      category: 'fire',
      targets: [post(RESCUE), post(RESCUE), { kind: 'post', id: POST }],
    }));

    const rescue = proposalsFor(history, 'fire').find((p) => p.id === RESCUE);
    expect(rescue?.times).toBe(6);
    expect(rescue?.outOf).toBe(6);
  });

  it('keeps categories apart', () => {
    const history = [
      ...fires(8, [post(RESCUE)]),
      ...Array.from({ length: 8 }, () => ({ category: 'disease', targets: [post(HEALTH)] })),
    ];

    expect(proposalsFor(history, 'fire').map((p) => p.id)).toEqual([RESCUE]);
    expect(proposalsFor(history, 'disease').map((p) => p.id)).toEqual([HEALTH]);
    // A category nobody has dispatched on proposes nothing, rather than falling back to
    // whoever is generally popular — which would be the software guessing.
    expect(proposalsFor(history, 'flood')).toHaveLength(0);
  });

  it('puts the strongest evidence first', () => {
    // Rescue in 12 of 12, Police in 10 of 12. Both clear the bar; a screen that shows the first
    // few should show the ones most worth reading.
    const history = [...fires(10, [post(RESCUE), post(POLICE)]), ...fires(2, [post(RESCUE)])];

    expect(proposalsFor(history, 'fire').map((p) => p.id)).toEqual([RESCUE, POLICE]);
  });

  it('drops a post that falls just under the share, rather than rounding it up', () => {
    /**
     * Ten of seventeen is 58.8%, which is a hair under the threshold — and it stays out.
     *
     * Worth a test of its own because this is the boundary somebody will be tempted to soften
     * ("it's basically 60"). The direction of the error is the whole point: a proposal that
     * fires too readily trains operators to accept pre-ticks without reading them, and a
     * proposal that does not fire costs a few seconds.
     */
    const history = [...fires(10, [post(RESCUE)]), ...fires(7, [post(POLICE)])];

    expect(10 / 17).toBeLessThan(PROPOSE_SHARE);
    expect(proposalsFor(history, 'fire')).toHaveLength(0);
  });
});

describe('groups the district has been making without naming', () => {
  it('offers a combination chosen together often enough', () => {
    const history = Array.from({ length: SUGGEST_GROUP_TIMES }, () => ({
      category: 'flood',
      targets: [post(RESCUE), post(POLICE), post(HEALTH)],
    }));

    const [suggestion] = groupSuggestions(history);
    expect(suggestion?.members).toHaveLength(3);
    expect(suggestion?.because).toBe('you have chosen these 3 together 4 times');
  });

  it('offers the whole selection and not the pairs inside it', () => {
    /**
     * Six departments chosen together four times is one group. The fifteen pairs inside those
     * six are an artefact of the arithmetic, and offering them would bury the one real
     * suggestion under a screen of noise — which is how a suggestion feature gets switched off.
     */
    const history = Array.from({ length: 6 }, () => ({
      category: 'flood',
      targets: [post(RESCUE), post(POLICE), post(HEALTH)],
    }));

    expect(groupSuggestions(history)).toHaveLength(1);
  });

  it('does not suggest a group the district has already saved', () => {
    const history = Array.from({ length: 9 }, () => ({
      category: 'flood',
      targets: [post(RESCUE), post(POLICE)],
    }));

    // Compared as an unordered set — a group is the same group whichever order somebody
    // happened to tick it in, and suggesting it back would read as the software not noticing.
    expect(groupSuggestions(history, [[post(POLICE), post(RESCUE)]])).toHaveLength(0);
  });

  it('never suggests a single recipient as a group', () => {
    const history = Array.from({ length: 40 }, () => ({
      category: 'fire',
      targets: [post(RESCUE)],
    }));

    // A district that mostly tells Rescue would otherwise be offered "Rescue" as a group,
    // forever, on every visit to the console.
    expect(groupSuggestions(history)).toHaveLength(0);
  });
});

// `describe('whether anything would propose this department at all — M7-22')` lived here and is
// gone with ADR-0031 (phase 2), along with `hasSomethingToProposeIt` itself — its one caller,
// the integrity console's `department-with-no-signal` finding, went with ADR-0022's routing
// signals, and a proposal can no longer be department-kinded.
