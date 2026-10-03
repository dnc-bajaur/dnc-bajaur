/**
 * Who the control room can tell — the two judgements this must not get wrong.
 *
 * Pure functions, no database. The queries are tested against a real Postgres in
 * `api/__tests__/contacts.test.ts`; this file is about the rules.
 *
 * The tests worth reading before changing anything here are the last two groups: an
 * unreachable recipient stays in the list, and a shared number is reported rather than
 * deduplicated. Both look like bugs and are the whole point.
 */

import { describe, expect, it } from 'vitest';

import {
  collapseSelection,
  effectiveTargets,
  reachabilityOf,
  sharedNumbers,
  type Recipient,
  type SelectedTarget,
} from '../recipients.js';

const RESCUE = '11111111-1111-4111-8111-111111111111';
const HEALTH = '22222222-2222-4222-8222-222222222222';
const DEO_POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const NIGHT_POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const DOCTOR_POST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const KHAN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
/** Holds two designations, the way three officers in Bajaur's real directory do — see O-27. */
const DELTA = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const NIGHT_OFFICER = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

function held(over: Partial<Parameters<typeof reachabilityOf>[0]> = {}) {
  return {
    holderPersonId: KHAN,
    phone: '03001112222',
    placeholder: false,
    disabledAt: null,
    ...over,
  };
}

function recipient(over: Partial<Recipient> = {}): Recipient {
  return {
    kind: 'post',
    id: DEO_POST,
    label: 'District Emergency Officer',
    departmentId: RESCUE,
    departmentName: 'Rescue 1122',
    holderName: 'Officer Juliet',
    holderPersonId: KHAN,
    designation: null,
    phone: '03001112222',
    unreachable: null,
    ...over,
  };
}

describe('reachabilityOf', () => {
  it('reports nothing in the way when a real holder has a real number', () => {
    expect(reachabilityOf(held())).toBeNull();
  });

  it('reports a vacant post as vacant, not as missing a number', () => {
    // Both are true. Only one of them is the thing the district must act on — appointing
    // somebody — and reporting the consequence would send them to fix a roster row that
    // should not exist until a post has a holder.
    expect(reachabilityOf(held({ holderPersonId: null, phone: null }))).toBe('vacant');
  });

  it('reports a stand-in number as a placeholder rather than as reachable', () => {
    expect(reachabilityOf(held({ placeholder: true }))).toBe('placeholder');
  });

  it('reports a disabled person before it looks at their number', () => {
    expect(reachabilityOf(held({ disabledAt: '2026-08-01T00:00:00.000Z' }))).toBe('disabled');
  });

  it('reports an empty or whitespace number as no number', () => {
    expect(reachabilityOf(held({ phone: '' }))).toBe('no_number');
    expect(reachabilityOf(held({ phone: '   ' }))).toBe('no_number');
  });
});

describe('collapseSelection', () => {
  const index = {
    departmentOfPost: new Map<string, string | null>([
      [DEO_POST, RESCUE],
      [NIGHT_POST, RESCUE],
      [DOCTOR_POST, HEALTH],
    ]),
    postsOfPerson: new Map<string, readonly string[]>([[KHAN, [DEO_POST]]]),
    holderOfPost: new Map<string, string | null>([
      [DEO_POST, KHAN],
      [NIGHT_POST, NIGHT_OFFICER],
      [DOCTOR_POST, null],
    ]),
  };

  const select = (...targets: SelectedTarget[]): SelectedTarget[] => targets;

  /*
   * ⚠️ **ADR-0031, phase 2: a post is no longer absorbed by its own *department*.**
   * `'department'` left `RecipientKind` and the picker has offered contacts only since
   * ADR-0023, so no selection carries a department. The tests for that collapse — and for a
   * person being absorbed into the department of a post they hold, and the M9-21 "do not tick
   * the department" pair — are gone. What `collapseSelection` still does is absorb a person
   * into a post they hold, and a post into another post held by the same officer.
   */

  /**
   * 🔴 **TWO DESIGNATIONS, ONE OFFICER, ONE MESSAGE — 2026-08-22.**
   *
   * The gap the flat contact directory exposed. Nothing ever collapsed **post against post**: it
   * stayed harmless only while the person row existed to absorb the overlap, and while ticking
   * two designations held by one officer was an odd thing to do on a picker grouped by
   * department.
   *
   * With one row per designation it is the obvious thing to do — Officer Delta is *C&W Buildings* and
   * *C&W Highways*, Officer Charlie is *ADC General* and *ADC Relief*, both from the original deployment's
   * live directory on 2026-08-16. Uncollapsed that is **two messages to one handset for one
   * emergency**, which `recipients.ts`'s own header calls the fastest way to teach somebody to
   * mute their phone.
   */
  it('absorbs a second designation held by the same officer, and records what covered it', () => {
    const twoHats = {
      ...index,
      holderOfPost: new Map<string, string | null>([
        [DOCTOR_POST, DELTA],
        [NIGHT_POST, DELTA],
      ]),
      departmentOfPost: new Map<string, string | null>([
        [DOCTOR_POST, HEALTH],
        [NIGHT_POST, RESCUE],
      ]),
    };

    const resolved = collapseSelection(
      select({ kind: 'post', id: DOCTOR_POST }, { kind: 'post', id: NIGHT_POST }),
      twoHats,
    );

    // One handset, one message.
    expect(effectiveTargets(resolved)).toEqual([{ kind: 'post', id: DOCTOR_POST }]);

    // ⚠️ And the second tick is RECORDED, never dropped. "Tell Highways" was really said, and
    // six weeks later "was Highways told?" has to answer yes, with what covered it.
    expect(resolved[1]?.coveredBy).toEqual({ kind: 'post', id: DOCTOR_POST });
  });

  it('collapses every designation of one officer to the first kept, never chaining', () => {
    /**
     * The chain has to end at something actually being messaged. Three designations held by
     * one officer, all ticked: the first is kept and the other two are each recorded as
     * covered by *that* one — never covered by a designation that is itself covered.
     */
    const threeHats = {
      ...index,
      holderOfPost: new Map<string, string | null>([
        [DEO_POST, DELTA],
        [DOCTOR_POST, DELTA],
        [NIGHT_POST, DELTA],
      ]),
    };

    const resolved = collapseSelection(
      select(
        { kind: 'post', id: DEO_POST },
        { kind: 'post', id: DOCTOR_POST },
        { kind: 'post', id: NIGHT_POST },
      ),
      threeHats,
    );

    expect(effectiveTargets(resolved)).toEqual([{ kind: 'post', id: DEO_POST }]);
    expect(resolved[1]?.coveredBy).toEqual({ kind: 'post', id: DEO_POST });
    expect(resolved[2]?.coveredBy).toEqual({ kind: 'post', id: DEO_POST });
  });

  it('keeps two posts held by different officers', () => {
    const resolved = collapseSelection(
      select({ kind: 'post', id: DEO_POST }, { kind: 'post', id: NIGHT_POST }),
      index,
    );

    expect(effectiveTargets(resolved)).toHaveLength(2);
  });

  it('absorbs a person into a post they hold that is also selected', () => {
    const resolved = collapseSelection(
      select({ kind: 'post', id: DEO_POST }, { kind: 'person', id: KHAN }),
      index,
    );

    expect(effectiveTargets(resolved)).toEqual([{ kind: 'post', id: DEO_POST }]);
    expect(resolved[1]?.coveredBy).toEqual({ kind: 'post', id: DEO_POST });
  });

  it('keeps a person who holds no selected post', () => {
    const resolved = collapseSelection(
      select({ kind: 'post', id: DOCTOR_POST }, { kind: 'person', id: KHAN }),
      index,
    );

    // KHAN holds DEO_POST, not DOCTOR_POST — nothing selected covers them.
    expect(effectiveTargets(resolved)).toHaveLength(2);
  });

  it('collapses the same thing ticked twice', () => {
    const resolved = collapseSelection(
      select({ kind: 'post', id: DEO_POST }, { kind: 'post', id: DEO_POST }),
      index,
    );

    expect(resolved).toHaveLength(1);
  });

  it('names what absorbed each target, so the screen never shrinks silently', () => {
    // An operator who ticks four things and sees three sent stops trusting the control. The
    // absorbed rows survive with a reason attached rather than being dropped.
    const twoHats = {
      ...index,
      holderOfPost: new Map<string, string | null>([
        [DEO_POST, DELTA],
        [NIGHT_POST, DELTA],
      ]),
    };

    const resolved = collapseSelection(
      select({ kind: 'post', id: DEO_POST }, { kind: 'post', id: NIGHT_POST }),
      twoHats,
    );

    expect(resolved).toHaveLength(2);
    expect(resolved.filter((t) => t.coveredBy !== null)).toHaveLength(1);
  });

  it('holds an unknown post rather than dropping it', () => {
    // A post this index has never heard of is a roster that changed under a screen somebody
    // had open. Sending is the safe answer; dropping it means an officer nobody told.
    const resolved = collapseSelection(
      select({ kind: 'post', id: DEO_POST }, { kind: 'post', id: 'unknown-seat' }),
      index,
    );

    expect(effectiveTargets(resolved)).toHaveLength(2);
  });
});

describe('sharedNumbers', () => {
  it('reports two recipients on one number rather than collapsing them', () => {
    // Ordinary in Bajaur (migration 0006, Q-19) — and a mistyped digit looks identical, so the
    // district is shown the pair and decides which it is.
    const shared = sharedNumbers([
      recipient({ id: DEO_POST, label: 'District Emergency Officer', phone: '03000000171' }),
      recipient({ id: NIGHT_POST, label: 'Night Duty Officer', phone: '03000000171' }),
      recipient({ id: DOCTOR_POST, label: 'Medical Officer', phone: '03009998888' }),
    ]);

    expect(shared).toHaveLength(1);
    expect(shared[0]?.phone).toBe('03000000171');
    expect(shared[0]?.labels).toEqual(['District Emergency Officer', 'Night Duty Officer']);
  });

  it('ignores unreachable recipients, whose numbers mean nothing', () => {
    const shared = sharedNumbers([
      recipient({ id: DEO_POST, phone: '03000000171', unreachable: 'placeholder' }),
      recipient({ id: NIGHT_POST, phone: '03000000171', unreachable: 'placeholder' }),
    ]);

    expect(shared).toEqual([]);
  });

  it('says nothing when every number is distinct', () => {
    expect(
      sharedNumbers([
        recipient({ id: DEO_POST, phone: '03001112222' }),
        recipient({ id: NIGHT_POST, phone: '03003334444' }),
      ]),
    ).toEqual([]);
  });
});
