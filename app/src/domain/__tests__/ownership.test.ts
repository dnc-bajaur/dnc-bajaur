/**
 * **The green board over an emergency nobody has taken** — 2026-08-24.
 *
 * Pure, no database. This file exists for one scenario, and the rest of it is the corners around
 * that scenario: four officers are told about a fire, all four tap *Acknowledge*, two say they are
 * deploying staff and two say they cannot. Before `ownershipOf` the district's board read
 * `4/4 acknowledged` in green, the SLA clock had stopped, and no escalation was coming — over a
 * fire that two people had declined and nobody else had picked up.
 */

import { describe, expect, it } from 'vitest';

import { ownershipOf, type OwnershipInput } from '../ownership.js';

let n = 0;

function told(
  said?: string,
  via = 'link',
  reason = 'dispatched',
  settledAt?: string,
): OwnershipInput {
  n += 1;
  return {
    attemptId: `attempt-${String(n)}`,
    seatId: `seat-${String(n)}`,
    reason,
    ...(said === undefined ? {} : { said, via }),
    ...(settledAt === undefined ? {} : { settledAt }),
  };
}

/** Not settled at all — no `via`, no words. */
function silent(): OwnershipInput {
  n += 1;
  return { attemptId: `attempt-${String(n)}`, seatId: `seat-${String(n)}`, reason: 'dispatched' };
}

describe('the fire nobody took', () => {
  it('reads two deploying and two declining as ownerless', () => {
    const owned = ownershipOf([
      told('Deploying Relevant Staff / Team'),
      told('Deploying Relevant Staff / Team'),
      told('Unable to Respond'),
      told('Not Related to Me'),
    ]);

    expect(owned.told).toBe(4);
    expect(owned.holding).toBe(2);
    expect(owned.declined).toBe(2);
    expect(owned.silent).toBe(0);
    /** Two people ARE going, so this is covered. The flag is about nobody, not about anybody. */
    expect(owned.ownerless).toBe(false);
  });

  it('raises the flag the moment the last holder is gone', () => {
    const owned = ownershipOf([
      told('Unable to Respond'),
      told('Not Related to Me'),
      told('On Leave'),
      told('Otherwise Unavailable'),
    ]);

    expect(owned.holding).toBe(0);
    expect(owned.declined).toBe(4);
    expect(owned.ownerless).toBe(true);
  });

  /**
   * 🔴 The district filed a named deputy under *Unable to Respond*, and about the officer that is
   * right. It is still not a reason to reassign: somebody is on the way and was named.
   */
  it('does not raise the flag when a representative has been named', () => {
    const owned = ownershipOf([
      told('Unable to Respond'),
      told('Sending a Responsible Representative'),
    ]);

    expect(owned.holding).toBe(1);
    expect(owned.declined).toBe(1);
    expect(owned.ownerless).toBe(false);
  });
});

describe('what counts as holding', () => {
  it('counts every option that is not a decline', () => {
    for (const said of [
      'Taking Cognizance',
      'Issue Already Resolved',
      'Matter Being Taken Up with the Concerned Department',
      'Proceeding to the Site',
      'Police / Rescue / Relevant Department Informed',
      'Information Noted',
      'Further Information Required',
    ]) {
      expect(ownershipOf([told(said)]).holding, said).toBe(1);
      expect(ownershipOf([told(said)]).ownerless, said).toBe(false);
    }
  });

  it('counts the four ways of declining, and the three under them', () => {
    for (const said of [
      'Not Related to Me',
      'Unable to Respond',
      'Unable to Attend / Respond',
      'On Leave',
      'Otherwise Unavailable',
    ]) {
      expect(ownershipOf([told(said)]).declined, said).toBe(1);
      expect(ownershipOf([told(said)]).ownerless, said).toBe(true);
    }
  });

  /**
   * 🔴 The rule that keeps this honest. An officer who typed *"on my way"* has taken the emergency
   * more clearly than any row could say it, and a classifier that could not recognise their
   * sentence must never read that as a refusal.
   */
  it("treats an officer's own words as holding, never as declining", () => {
    const owned = ownershipOf([told('on my way, ten minutes'), told('Unable to Respond')]);
    expect(owned.holding).toBe(1);
    expect(owned.declined).toBe(1);
    expect(owned.ownerless).toBe(false);
    expect(owned.rows[0]?.option).toBeUndefined();
    expect(owned.rows[1]?.option).toBe('unable');
  });
});

describe('silence is not a decline', () => {
  it('never raises the flag when nobody has answered at all', () => {
    const owned = ownershipOf([silent(), silent(), silent()]);
    expect(owned.silent).toBe(3);
    expect(owned.declined).toBe(0);
    /** Silence is what the board has always shown in red. An orange flag on every emergency in
     * its first minute would teach the district to ignore the colour. */
    expect(owned.ownerless).toBe(false);
  });

  it('raises it while others are still silent, because the control room must reassign now', () => {
    const owned = ownershipOf([told('Unable to Respond'), silent(), silent()]);
    expect(owned.declined).toBe(1);
    expect(owned.silent).toBe(2);
    expect(owned.ownerless).toBe(true);
  });

  /**
   * Meta reporting that a handset received the message decides nothing. A count built on delivery
   * would report a district as covered when it had merely been reached.
   */
  it('does not let a delivery receipt hold an emergency', () => {
    const owned = ownershipOf([told('Deploying Relevant Staff / Team', 'provider')]);
    expect(owned.holding).toBe(0);
    expect(owned.silent).toBe(1);
  });

  it('accepts a link tap, a typed reply and a telephone call the operator recorded', () => {
    for (const via of ['link', 'reply', 'operator']) {
      expect(ownershipOf([told('Taking Cognizance', via)]).holding, via).toBe(1);
    }
  });
});

describe('which obligations are counted', () => {
  /**
   * An escalation is the system saying *nobody answered*. Counting it as somebody who was asked
   * would make an emergency look more widely covered the longer it went unanswered.
   */
  it('counts only what the control room dispatched', () => {
    const owned = ownershipOf([
      told('Taking Cognizance'),
      told('Taking Cognizance', 'link', 'escalation'),
    ]);
    expect(owned.told).toBe(1);
    expect(owned.rows).toHaveLength(1);
  });

  it('says nothing at all about an emergency nobody was told about', () => {
    const owned = ownershipOf([]);
    expect(owned).toEqual({
      told: 0,
      holding: 0,
      declined: 0,
      silent: 0,
      ownerless: false,
      takenBy: null,
      takenBySeatId: null,
      takenByPersonId: null,
      respondedAt: null,
      rows: [],
    });
  });
});

describe('the office that took it', () => {
  it('is the earliest holding office by when it settled, not the first to tap', () => {
    const owned = ownershipOf([
      told('Not Related to Me', 'link', 'dispatched', '2026-09-10T21:41:00Z'),
      told('Proceeding to the Site', 'link', 'dispatched', '2026-09-10T21:43:00Z'),
      told('Medical Teams Ready', 'link', 'dispatched', '2026-09-10T21:44:00Z'),
    ]);
    expect(owned.takenBy?.said).toBe('Proceeding to the Site');
    expect(owned.takenBySeatId).toBe(owned.takenBy?.seatId);
    expect(owned.respondedAt).toBe('2026-09-10T21:43:00Z');
    expect(owned.ownerless).toBe(false);
  });

  it('is null when every office declined — ownerless, not taken', () => {
    const owned = ownershipOf([told('Unable to Respond'), told('Not Related to Me')]);
    expect(owned.takenBy).toBeNull();
    expect(owned.takenBySeatId).toBeNull();
    expect(owned.takenByPersonId).toBeNull();
    expect(owned.respondedAt).toBeNull();
    expect(owned.ownerless).toBe(true);
  });

  it('is null while everyone is still silent', () => {
    const owned = ownershipOf([silent(), silent()]);
    expect(owned.takenBy).toBeNull();
    expect(owned.respondedAt).toBeNull();
  });

  it("takes an officer's own words as the commit", () => {
    const owned = ownershipOf([
      told('Unable to Respond', 'reply', 'dispatched', '2026-09-10T21:41:00Z'),
      told('on my way, ten minutes', 'reply', 'dispatched', '2026-09-10T21:42:00Z'),
    ]);
    expect(owned.takenBy?.said).toBe('on my way, ten minutes');
    expect(owned.respondedAt).toBe('2026-09-10T21:42:00Z');
  });

  it('carries the person id when the taker was a named officer', () => {
    const owned = ownershipOf([
      {
        attemptId: 'a',
        seatId: null,
        personId: 'p1',
        reason: 'dispatched',
        via: 'link',
        said: 'Proceeding to the Site',
        settledAt: '2026-09-10T21:43:00Z',
      },
    ]);
    expect(owned.takenByPersonId).toBe('p1');
    expect(owned.takenBySeatId).toBeNull();
  });

  it('a dated commit outranks a holder with no settle time', () => {
    const owned = ownershipOf([
      told('Taking Cognizance', 'operator'),
      told('Proceeding to the Site', 'link', 'dispatched', '2026-09-10T21:43:00Z'),
    ]);
    expect(owned.takenBy?.said).toBe('Proceeding to the Site');
    expect(owned.respondedAt).toBe('2026-09-10T21:43:00Z');
  });

  it('still names the single holder when nothing carries a settle time', () => {
    const owned = ownershipOf([told('Taking Cognizance', 'operator')]);
    expect(owned.takenBy?.said).toBe('Taking Cognizance');
    expect(owned.respondedAt).toBeNull();
  });
});

describe('what the panel is given', () => {
  it('keeps the words, the option and the route on every row', () => {
    const owned = ownershipOf([told('On Leave', 'reply')]);
    expect(owned.rows[0]).toMatchObject({
      holding: 'declined',
      said: 'On Leave',
      option: 'unable_leave',
      via: 'reply',
    });
  });

  it('carries a named officer and a department through untouched', () => {
    const owned = ownershipOf([
      {
        attemptId: 'a',
        seatId: null,
        personId: 'p1',
        reason: 'dispatched',
        via: 'link',
        said: 'Not Related to Me',
      },
      { attemptId: 'b', seatId: 's1', departmentId: 'd1', reason: 'dispatched' },
    ]);
    expect(owned.rows[0]).toMatchObject({ seatId: null, personId: 'p1', holding: 'declined' });
    expect(owned.rows[1]).toMatchObject({ seatId: 's1', departmentId: 'd1', holding: 'silent' });
  });
});
