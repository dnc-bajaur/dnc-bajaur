/**
 * **The group the operator ticked, kept for the display only** — Case 3, 2026-09-10.
 *
 * `api/dispatch.ts` `expand()` turns a ticked group into its member `DispatchTarget`s before the
 * selection is validated or collapsed, so by the time anything is stored **there is no group** —
 * a notice to *All Tehsildars* is eight loose recipients, tracked independently, and that is
 * deliberate (`backlog/recipient-cases-breakdown.md`, Case 3). The one thing lost with the group
 * is its *name*: after expansion no screen can say *"All Tehsildars — 6 of 8 responded"*, and the
 * operator is left to remember that eight rows were one tick.
 *
 * The name is not lost from the record — `dispatched.payload.fromGroups` carries it, *"copied,
 * never referenced"* (`domain/events.ts`). This module reads it back out and joins it to the
 * per-recipient rows a surface is already drawing, so *"who was told"* can carry the group
 * heading again.
 *
 * ## Nothing here is folded into `IncidentState`, and that is the whole design
 *
 * `attendanceFor` and `ownershipOf` fold a *tally* out of the notification ledger; this folds a
 * *label*. There is no group entity in `state`, no `broadcast` row, and nothing downstream reads
 * this to decide who is holding an emergency or who is coming to a meeting — because the moment a
 * stored "the group" and the eight independent obligations can disagree, one of them is wrong and
 * nothing says which (ADR-0001, and the breakdown doc is firm on it). Delete this file and the
 * district loses a heading, not a fact: every recipient is still there, still tracked, still
 * counted the same way.
 *
 * So this is display-only provenance, computed wherever it is shown, exactly like the two tallies
 * beside it.
 */

import type { DispatchTarget, IncidentEvent } from './events.js';

/**
 * One group a dispatch on this incident expanded, as it stood at that moment.
 *
 * `members` is the group's roster **before `collapseSelection` ran** — the same list
 * `dispatched.payload.fromGroups` stored — so a member who was absorbed into a post they hold is
 * still named here. It is the denominator of *"6 of 8"*; the caller maps it onto the recipient
 * rows that actually exist.
 */
export interface DispatchGroup {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly DispatchTarget[];
}

/** `post:<uuid>` / `person:<uuid>` — the key both a member and a recipient row resolve to. */
export function targetKey(t: { readonly kind: string; readonly id: string }): string {
  return `${t.kind}:${t.id}`;
}

/**
 * `state.dispatchAbsorbed` as the `absorbedInto` map `groupRecipients` takes: the key of a
 * target the collapse covered → the key of the recipient that stood in for it. So a group whose
 * member was folded into a post they hold still claims that post's row.
 */
export function absorbedKeys(
  dispatchAbsorbed: readonly {
    readonly target: { readonly kind: string; readonly id: string };
    readonly coveredBy: { readonly kind: string; readonly id: string };
  }[],
): Map<string, string> {
  return new Map(dispatchAbsorbed.map((a) => [targetKey(a.target), targetKey(a.coveredBy)]));
}

/**
 * Every group any dispatch on this incident expanded — first-seen order, deduplicated by id.
 *
 * An incident dispatched twice through the same group keeps the **first** expansion's name and
 * roster: that is the provenance of when the group was actually used, and a later edit to the
 * group must not rewrite it (the reason `fromGroups` copies rather than references). A second,
 * different group in a later dispatch is appended.
 *
 * Returns `[]` for the ordinary incident — one dispatch, no groups — and every caller treats an
 * empty result as *"render the flat list, unchanged"*.
 */
export function groupsFromEvents(events: readonly IncidentEvent[]): DispatchGroup[] {
  const seen = new Map<string, DispatchGroup>();
  for (const e of events) {
    if (e.type !== 'dispatched') continue;
    for (const g of e.payload.fromGroups ?? []) {
      if (seen.has(g.groupId)) continue;
      seen.set(g.groupId, {
        groupId: g.groupId,
        name: g.name,
        members: g.members.map((m) => ({ kind: m.kind, id: m.id })),
      });
    }
  }
  return [...seen.values()];
}

/**
 * The shape `groupRecipients` needs from a group — its name, and members it can key.
 *
 * Looser than `DispatchGroup` on purpose: the incident drawer's payload carries `members` as
 * `{ kind: string; id: string }` (a `RecipientKind` does not survive the wire as its literal
 * union), and this function only ever reads `targetKey(member)`. A server-side caller passes a
 * real `DispatchGroup` and `G` narrows to it.
 */
export interface GroupLike {
  readonly groupId: string;
  readonly name: string;
  readonly members: readonly { readonly kind: string; readonly id: string }[];
}

export interface GroupBlock<G, T> {
  readonly group: G;
  readonly rows: readonly T[];
}

export interface GroupedRecipients<G, T> {
  /** One block per group that has at least one recipient row, in `groupsFromEvents` order. */
  readonly blocks: readonly GroupBlock<G, T>[];
  /**
   * Recipients that belong to no group — ticked by hand, or a group member that
   * `collapseSelection` folded into somebody who is not themselves in any group. Rendered
   * beneath the blocks, in the order the surface passed them.
   */
  readonly ungrouped: readonly T[];
}

/**
 * Partition a surface's per-recipient rows into group blocks and a hand-picked remainder.
 *
 * `keyOf` turns a row into its `post:` / `person:` key; `absorbedInto` maps a ticked target that
 * `collapseSelection` covered (`state.dispatchAbsorbed`) onto the recipient key that survived, so
 * a group whose member was absorbed still claims the row that stands in for them.
 *
 * A row that matches two groups is placed under the **first** — the operator sees it once, where
 * they first put it. A group with no surviving row is dropped rather than drawn as an empty
 * heading.
 *
 * Returns `null` when `groups` is empty — the signal to render the flat list with no change at
 * all, which is every incident that was never dispatched through a group.
 */
export function groupRecipients<G extends GroupLike, T>(
  groups: readonly G[],
  rows: readonly T[],
  keyOf: (row: T) => string,
  absorbedInto: ReadonlyMap<string, string> = new Map(),
): GroupedRecipients<G, T> | null {
  if (groups.length === 0) return null;

  // Each group's claim: its members' keys, plus the surviving key of any member the collapse
  // absorbed. Built once, in group order, so the "first group wins" rule below is stable.
  const claims = groups.map((g) => {
    const keys = new Set<string>();
    for (const m of g.members) {
      const key = targetKey(m);
      keys.add(key);
      const survivor = absorbedInto.get(key);
      if (survivor !== undefined) keys.add(survivor);
    }
    return { group: g, keys };
  });

  const blocks = new Map<string, T[]>();
  const ungrouped: T[] = [];

  for (const row of rows) {
    const key = keyOf(row);
    const claim = claims.find((c) => c.keys.has(key));
    if (claim === undefined) {
      ungrouped.push(row);
      continue;
    }
    const bucket = blocks.get(claim.group.groupId);
    if (bucket === undefined) blocks.set(claim.group.groupId, [row]);
    else bucket.push(row);
  }

  return {
    blocks: claims.flatMap((c) => {
      const rowsInBlock = blocks.get(c.group.groupId);
      return rowsInBlock === undefined ? [] : [{ group: c.group, rows: rowsInBlock }];
    }),
    ungrouped,
  };
}
