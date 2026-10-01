/**
 * **The group heading that survives expansion** — Case 3, 2026-09-10.
 *
 * Pure, no database. `expand()` dissolves a ticked group into loose recipients on purpose; this
 * file is about the one thing that dissolves with it — the group's name — being read back out of
 * `dispatched.payload.fromGroups` and joined to the rows a surface already draws, without any
 * group entity reaching `IncidentState`.
 */

import { describe, expect, it } from 'vitest';

import type { DispatchTarget, IncidentEvent } from '../events.js';
import {
  groupRecipients,
  groupsFromEvents,
  targetKey,
  type DispatchGroup,
} from '../recipientGroups.js';

let seq = 0;

/** A `dispatched` event carrying the given targets and, optionally, the groups they came from. */
function dispatched(
  targets: readonly DispatchTarget[],
  fromGroups?: readonly DispatchGroup[],
): IncidentEvent {
  seq += 1;
  return {
    eventId: `event-${String(seq)}`,
    incidentId: 'incident-1',
    type: 'dispatched',
    occurredAt: '2026-09-10T10:00:00.000Z',
    recordedAt: '2026-09-10T10:00:00.000Z',
    actorPersonId: null,
    actorSeatId: null,
    sourceChannel: 'web',
    clientSeq: seq,
    payload: {
      targets,
      ...(fromGroups === undefined ? {} : { fromGroups }),
    },
  } as unknown as IncidentEvent;
}

const post = (id: string): DispatchTarget => ({ kind: 'post', id });
const person = (id: string): DispatchTarget => ({ kind: 'person', id });

/** A recipient row as a surface holds one — just enough for `keyOf` to resolve it. */
interface Row {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
}
const rowKey = (r: Row): string => `${r.kind}:${r.id}`;

describe('groupsFromEvents', () => {
  it('is empty for the ordinary incident — one dispatch, no group', () => {
    const events = [dispatched([post('a'), post('b')])];
    expect(groupsFromEvents(events)).toEqual([]);
  });

  it('reads the group name and its roster off the dispatched event', () => {
    const tehsildars: DispatchGroup = {
      groupId: 'g-teh',
      name: 'All Tehsildars',
      members: [post('t1'), post('t2'), post('t3')],
    };
    const events = [dispatched([post('t1'), post('t2'), post('t3')], [tehsildars])];

    const groups = groupsFromEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('All Tehsildars');
    expect(groups[0]?.members.map(targetKey)).toEqual(['post:t1', 'post:t2', 'post:t3']);
  });

  it('keeps the first expansion when the same group is dispatched twice', () => {
    const first: DispatchGroup = {
      groupId: 'g',
      name: 'Rescue Group',
      members: [post('r1'), post('r2')],
    };
    // The group was edited between the two dispatches — a third member, a new name.
    const second: DispatchGroup = {
      groupId: 'g',
      name: 'Rescue Group (renamed)',
      members: [post('r1'), post('r2'), post('r3')],
    };
    const groups = groupsFromEvents([
      dispatched([post('r1'), post('r2')], [first]),
      dispatched([post('r3')], [second]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('Rescue Group');
    expect(groups[0]?.members).toHaveLength(2);
  });

  it('appends a second, different group from a later dispatch', () => {
    const a: DispatchGroup = { groupId: 'a', name: 'Group A', members: [post('a1')] };
    const b: DispatchGroup = { groupId: 'b', name: 'Group B', members: [post('b1')] };
    const groups = groupsFromEvents([dispatched([post('a1')], [a]), dispatched([post('b1')], [b])]);
    expect(groups.map((g) => g.name)).toEqual(['Group A', 'Group B']);
  });
});

describe('groupRecipients', () => {
  const tehsildars: DispatchGroup = {
    groupId: 'g-teh',
    name: 'All Tehsildars',
    members: [post('t1'), post('t2'), post('t3')],
  };

  it('returns null when no group was used — the flat list stays untouched', () => {
    const rows: Row[] = [{ kind: 'post', id: 'x', name: 'X' }];
    expect(groupRecipients([], rows, rowKey)).toBeNull();
  });

  it('groups the rows that belong to a group and leaves the rest ungrouped', () => {
    const rows: Row[] = [
      { kind: 'post', id: 't1', name: 'Tehsildar One' },
      { kind: 'post', id: 't2', name: 'Tehsildar Two' },
      { kind: 'post', id: 't3', name: 'Tehsildar Three' },
      { kind: 'person', id: 'ac', name: 'AC HQ' },
    ];
    const grouped = groupRecipients([tehsildars], rows, rowKey);

    expect(grouped).not.toBeNull();
    expect(grouped?.blocks).toHaveLength(1);
    expect(grouped?.blocks[0]?.group.name).toBe('All Tehsildars');
    expect(grouped?.blocks[0]?.rows.map((r) => r.name)).toEqual([
      'Tehsildar One',
      'Tehsildar Two',
      'Tehsildar Three',
    ]);
    expect(grouped?.ungrouped.map((r) => r.name)).toEqual(['AC HQ']);
  });

  it('keeps each row in one block only — the first group that claims it', () => {
    const groupA: DispatchGroup = {
      groupId: 'a',
      name: 'A',
      members: [post('shared'), post('a1')],
    };
    const groupB: DispatchGroup = {
      groupId: 'b',
      name: 'B',
      members: [post('shared'), post('b1')],
    };
    const rows: Row[] = [
      { kind: 'post', id: 'shared', name: 'Shared' },
      { kind: 'post', id: 'a1', name: 'A One' },
      { kind: 'post', id: 'b1', name: 'B One' },
    ];
    const grouped = groupRecipients([groupA, groupB], rows, rowKey);

    expect(grouped?.blocks.map((b) => b.group.name)).toEqual(['A', 'B']);
    expect(grouped?.blocks[0]?.rows.map((r) => r.name)).toEqual(['Shared', 'A One']);
    expect(grouped?.blocks[1]?.rows.map((r) => r.name)).toEqual(['B One']);
  });

  it('claims the surviving row when a group member was collapsed into a post', () => {
    // The group named the officer by person; `collapseSelection` absorbed them into the post
    // they hold, so `dispatchedTo` carries `post:held` and no `person:off` row exists.
    const group: DispatchGroup = {
      groupId: 'g',
      name: 'Field Team',
      members: [person('off'), post('other')],
    };
    const rows: Row[] = [
      { kind: 'post', id: 'held', name: 'Held Post' },
      { kind: 'post', id: 'other', name: 'Other Post' },
    ];
    const absorbedInto = new Map<string, string>([['person:off', 'post:held']]);

    const grouped = groupRecipients([group], rows, rowKey, absorbedInto);
    expect(grouped?.blocks).toHaveLength(1);
    expect(grouped?.blocks[0]?.rows.map((r) => r.name)).toEqual(['Held Post', 'Other Post']);
    expect(grouped?.ungrouped).toEqual([]);
  });

  it('drops a group whose every member is missing from the rows', () => {
    const present: DispatchGroup = { groupId: 'p', name: 'Present', members: [post('here')] };
    const absent: DispatchGroup = { groupId: 'x', name: 'Absent', members: [post('gone')] };
    const rows: Row[] = [{ kind: 'post', id: 'here', name: 'Here' }];

    const grouped = groupRecipients([present, absent], rows, rowKey);
    expect(grouped?.blocks.map((b) => b.group.name)).toEqual(['Present']);
  });
});
