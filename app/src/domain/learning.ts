/**
 * The system learns who the control room tells — M7-15…M7-22.
 *
 * Bajaur's routing signals are configuration: somebody sits down and writes *"category `fire` →
 * Rescue"*. That gap has been the district's one functional hole since M1a — the matcher, the
 * storage and the screen all exist and **no department has a signal**, so every emergency lands
 * unassigned. Asking a district to configure a system before it can help them is asking them to
 * do the work first.
 *
 * They are already doing the work. Forty times a day an operator picks who to tell, and that
 * choice is recorded on the `dispatched` event. This module reads it back.
 *
 * ## Six decisions, all the owner's, all of which look arbitrary without their reasons
 *
 * **Category only, never keywords.** Both were asked for and both will come; this is the half
 * that is right in a month of data. A keyword rule learned from free text needs far more history
 * before it says anything, and a wrong one is invisible: nobody can tell why "canal" started
 * pre-ticking Irrigation.
 *
 * **Departments and posts, never people** (M7-19). A model that learns *"we always call this
 * officer"* wakes one person every night, through a system, and they will never complain —
 * they will silence the phone. Authority attaches to the post (ADR-0004) and so does this.
 *
 * **A projection, with no table** (M7-15). Same argument as the board having no board table
 * (ADR-0001): it cannot drift from what actually happened, there is nothing to migrate, and a
 * wrong lesson is corrected by dispatching correctly rather than by editing a store somebody
 * has to find.
 *
 * **It proposes and never decides** (M7-17). Auto-routing from a learned rule would let one
 * quiet Tuesday's mistake become the district's standing rule — and then reinforce itself,
 * because pre-ticked things get accepted. A human ticks. Always.
 *
 * **Every proposal explains itself, in words** (M7-18). *"Rescue — you told them for 9 of the
 * last 10 fires."* A silent pre-tick is a rule nobody can audit or disagree with, and the whole
 * value of showing a proposal is that somebody is judging it.
 *
 * **From 2026-08-06 forward only** (M7-20). Before that date the board wrongly said *"nobody
 * has this"* after a dispatch, so operators worked around it — dispatching twice, dispatching
 * to departments they did not mean, routing by hand afterwards. Those choices encode a bug, not
 * a preference. The learning clock starts with the fix.
 */

import type { DispatchTarget, RecipientKind, Uuid } from './events.js';

/**
 * The day the district's own choices became worth learning from.
 *
 * A constant and not a setting. A district that could move it could quietly re-admit the
 * fortnight of workarounds this exists to exclude, and would have no way to tell afterwards
 * which of the two windows a proposal came from.
 */
export const LEARNING_STARTS_AT = '2026-08-06T00:00:00.000Z';

/** How much of a category's dispatches a target must take before it is worth pre-ticking. */
export const PROPOSE_SHARE = 0.6;

/**
 * And how many times, at minimum.
 *
 * The share alone is a trap: one dispatch is 100% of one dispatch. Five is small enough that a
 * district sees the system start helping inside a fortnight and large enough that a single
 * unusual night cannot create a standing proposal.
 */
export const PROPOSE_TIMES = 5;

/** Times the same combination must be chosen before it is worth offering to save (M7-21). */
export const SUGGEST_GROUP_TIMES = 4;

/** One past dispatch, as the projection reads it back. */
export interface PastDispatch {
  /** The category the report carried when the operator was looking at it. */
  readonly category: string;
  readonly targets: readonly DispatchTarget[];
}

export interface LearnedProposal {
  readonly kind: RecipientKind;
  readonly id: Uuid;
  /** How many dispatches of this category included them. */
  readonly times: number;
  /** Out of how many. Both numbers, never the ratio alone — see `because`. */
  readonly outOf: number;
  /**
   * The sentence shown beside the tick.
   *
   * Carries both numbers because a percentage hides the sample: *"90%"* reads identically at
   * nine-of-ten and at ninety-of-a-hundred, and only one of those is worth acting on. It is
   * built here rather than in the client so the console, the intake screen and any later report
   * cannot each round it differently.
   */
  readonly because: string;
}

/**
 * What this category's history says the control room usually does.
 *
 * Ordered by how strong the evidence is, so a screen that shows only the first few shows the
 * ones most worth reading.
 */
export function proposalsFor(
  history: readonly PastDispatch[],
  category: string,
): readonly LearnedProposal[] {
  const matching = history.filter((d) => d.category === category);
  if (matching.length === 0) return [];

  const times = new Map<string, number>();

  for (const dispatch of matching) {
    /**
     * Counted **once per dispatch**, not once per appearance.
     *
     * A selection can name a department and a post inside it; both survive onto the event
     * (`collapseSelection` records what was absorbed rather than dropping it). Counting each
     * would let one operator's habit of ticking both push a department past the threshold on
     * half the actual evidence.
     */
    const seen = new Set<string>();
    for (const target of dispatch.targets) {
      // Never people. See the header — a model that learns an individual wakes them nightly.
      if (target.kind === 'person') continue;
      seen.add(`${target.kind}:${target.id}`);
    }
    for (const key of seen) times.set(key, (times.get(key) ?? 0) + 1);
  }

  const out: LearnedProposal[] = [];

  for (const [key, count] of times) {
    if (count < PROPOSE_TIMES) continue;
    if (count / matching.length < PROPOSE_SHARE) continue;

    const [kind, id] = key.split(':') as [RecipientKind, Uuid];
    out.push({
      kind,
      id,
      times: count,
      outOf: matching.length,
      because: `you told them for ${String(count)} of the last ${String(matching.length)} ${category} reports`,
    });
  }

  return out.sort((a, b) => b.times / b.outOf - a.times / a.outOf || b.times - a.times);
}

export interface GroupSuggestion {
  readonly members: readonly DispatchTarget[];
  readonly times: number;
  readonly because: string;
}

/**
 * Combinations chosen together often enough to be worth naming — M7-21.
 *
 * **The whole selection, not every subset.** A district that told six departments together four
 * times has a group; the fifteen pairs inside those six are an artefact of the arithmetic, and
 * offering them would bury the one real suggestion under a screen of noise.
 *
 * `already` is what the district has saved, so a suggestion never repeats a group they made.
 * Compared as an unordered set: a group is the same group whichever order somebody ticked it in.
 */
export function groupSuggestions(
  history: readonly PastDispatch[],
  already: readonly (readonly DispatchTarget[])[] = [],
): readonly GroupSuggestion[] {
  const counts = new Map<string, { members: DispatchTarget[]; times: number }>();

  for (const dispatch of history) {
    // Two or more, and no people. One recipient is not a group, and a "group" of one would be
    // offered constantly to a district that mostly tells Rescue.
    const members = dispatch.targets.filter((t) => t.kind !== 'person');
    if (members.length < 2) continue;

    const key = signature(members);
    const entry = counts.get(key) ?? { members: [...members], times: 0 };
    entry.times += 1;
    counts.set(key, entry);
  }

  const saved = new Set(already.map((m) => signature(m.filter((t) => t.kind !== 'person'))));

  return [...counts.values()]
    .filter((entry) => entry.times >= SUGGEST_GROUP_TIMES && !saved.has(signature(entry.members)))
    .map((entry) => ({
      members: entry.members,
      times: entry.times,
      because: `you have chosen these ${String(entry.members.length)} together ${String(entry.times)} times`,
    }))
    .sort((a, b) => b.times - a.times);
}

/** An order-independent identity for a selection. */
function signature(targets: readonly DispatchTarget[]): string {
  return [...new Set(targets.map((t) => `${t.kind}:${t.id}`))].sort().join('|');
}

/*
 * `hasSomethingToProposeIt` lived here — M7-22, "would a signal or the district's own habit
 * propose this department?" — and it is gone with ADR-0031, phase 2. Its one caller was the
 * integrity console's `department-with-no-signal` finding, removed when ADR-0022 took routing
 * signals out; a proposal can no longer be department-kinded anyway, since `'department'` left
 * `RecipientKind`. Nothing in the product asked the question any more.
 */
