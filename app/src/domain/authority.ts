/**
 * Authority as data, not `if` statements. See ADR-0003 and docs/04-authority-model.md.
 *
 * Every writable field carries a rule. The rules are a table an administrator can read
 * and change; they are not scattered role comparisons that nobody can audit. Adding a
 * department is rows, not a release.
 *
 * Nothing here is a substitute for enforcing this server-side at every mutation endpoint
 * (INV-05). This module is the decision; the endpoint is the gate.
 */

import type { Uuid } from './events.js';

/**
 * Where a seat sits in the ladder. Higher wins a conflict. **There are two rungs.**
 *
 * This was `station | tehsil | district | provincial` — a generic hierarchy invented before
 * anybody had told us how Bajaur is organised. ADR-0010 replaced it with the district's own
 * answer, and migration 0010 collapsed the column to match. The lower rung was called
 * `department` until [ADR-0031](../../docs/adr/ADR-0031-no-department-vocabulary.md) removed
 * that word from the product — a contact is a post, not a member of a department, so the
 * ordinary seat is a `post` and the two administrative offices are `district`.
 *
 * The dead values it replaced were not harmless while they lasted. The contact list had no
 * tier column, so the loader defaulted all 83 of the district's posts to `district` — and
 * `evaluateRead` widened at tehsil, which meant every seat could read every other seat's
 * incidents. Values nobody chose from produced a default nobody noticed.
 *
 * A seat is `district` exactly when its office is administrative. That is not a caller's
 * choice: a database trigger derives it from `seat.is_administration` (migration 0042).
 */
export type Tier = 'post' | 'district';

export const TIER_ORDER: readonly Tier[] = ['post', 'district'];

export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

export interface Seat {
  readonly seatId: Uuid;
  readonly tier: Tier;
  /** Seats permitted to act outside the policy table, with a reason. Always audited. */
  readonly canBreakGlass?: boolean;
}
// ⚠️ `departmentId` is off this interface — [ADR-0031](../../docs/adr/ADR-0031-no-department-vocabulary.md)
// phase 4. It has been `null` for every seat since ADR-0024 left no department owning anything, and
// `evaluateWrite`/`evaluateRead` only ever compared it against `ownerDepartmentId` (always null) or
// `responsibleDepartmentIds` (always empty since migration 0039). Ownership is the seat's tier now.

export interface AuthorityRule {
  readonly fieldKey: string;
  /**
   * Tiers that own the field outright — 2026-08-22, and it is the district's own decision.
   *
   * > *"Department ko koi access nahi milne wala hai, un ka koi account nahi banega … mujhe yeh
   * > concept hi nahi chahiye ke department khud kuch kar sake app ke andar."*
   *
   * ## Why this is a new field and not `overrideTiers`
   *
   * `overrideTiers` already let a district seat act. **It is the wrong instrument**, and using it
   * would have changed the district's day rather than their permissions: an override carries
   * `reasonRequired`, so the control room would have had to type a justification on **every
   * resolve, every triage, every reassignment** — a sentence demanded of the only people left who
   * can act, for overriding an owner who no longer exists.
   *
   * Ownership is what they actually have. `ownerDepartmentId` cannot express it: it is
   * parameterised by the *incident's* responsible department, and the answer here is about the
   * **seat**, whichever incident it is.
   *
   * ## And it is what lets an action be logged at all
   *
   * `appendOnly` refuses a field to anybody but its owner, deliberately — and it returns before
   * `overrideTiers` is ever consulted. So with departments owning nothing, `incident.actions`
   * would have been writable by **nobody, including the DC**. This closes a gap that was already
   * there: the control room could not log an action on an emergency held by another department,
   * which went unnoticed only because the four buttons on the incident screen are follow-up,
   * escalate, resolve and close — `log_action` is reachable over the API alone.
   */
  readonly ownerTiers?: readonly Tier[];
  /** Seat ids, or tiers, permitted to override the owner. */
  readonly overrideSeatIds?: readonly Uuid[];
  readonly overrideTiers?: readonly Tier[];
  readonly reasonRequired: boolean;
  readonly visibleToOwner: 'none' | 'yes' | 'yes_and_notify';
  /** Append-only fields cannot be overridden by anyone. */
  readonly appendOnly?: boolean;
}

export type Decision =
  | { readonly allowed: true; readonly as: 'owner' | 'override' | 'break_glass' }
  | { readonly allowed: false; readonly why: string };

export interface WriteAttempt {
  readonly fieldKey: string;
  readonly seat: Seat;
  readonly reason?: string | undefined;
  /** Set only when the actor is deliberately invoking emergency powers. */
  readonly breakGlass?: boolean;
}

/**
 * Decide whether a write is permitted.
 *
 * Order matters: ownership first, then delegated override authority, then break-glass.
 * Break-glass is deliberately last and deliberately present — an escape hatch that does
 * not exist gets replaced by shared passwords, which is strictly worse than one that is
 * logged and reviewed.
 */
export function evaluateWrite(rule: AuthorityRule, attempt: WriteAttempt): Decision {
  if (rule.fieldKey !== attempt.fieldKey) {
    return { allowed: false, why: `rule ${rule.fieldKey} does not govern ${attempt.fieldKey}` };
  }

  const isOwner = rule.ownerTiers?.includes(attempt.seat.tier) ?? false;

  if (rule.appendOnly) {
    return isOwner
      ? { allowed: true, as: 'owner' }
      : { allowed: false, why: `${rule.fieldKey} is append-only by its owning department` };
  }

  if (isOwner) return { allowed: true, as: 'owner' };

  const bySeat = rule.overrideSeatIds?.includes(attempt.seat.seatId) ?? false;
  const byTier = rule.overrideTiers?.includes(attempt.seat.tier) ?? false;

  if (bySeat || byTier) {
    if (rule.reasonRequired && !isNonEmpty(attempt.reason)) {
      return { allowed: false, why: `${rule.fieldKey} requires a reason to override` };
    }
    return { allowed: true, as: 'override' };
  }

  if (attempt.breakGlass === true && attempt.seat.canBreakGlass === true) {
    // Never waived, no matter who is asking. An unexplained emergency override is
    // indistinguishable from an abuse of one.
    if (!isNonEmpty(attempt.reason)) {
      return { allowed: false, why: 'break-glass always requires a reason' };
    }
    return { allowed: true, as: 'break_glass' };
  }

  return {
    allowed: false,
    why: `seat ${attempt.seat.seatId} has no authority over ${rule.fieldKey}`,
  };
}

export interface ReadAttempt {
  readonly seat: Seat;
  /** Empty while an incident is still unrouted — nobody owns it yet. */
  readonly responsibleDepartmentIds: readonly Uuid[];
}

/**
 * Decide whether a seat may read an incident at all.
 *
 * Cross-department access is denied by default (docs/04-authority-model.md). A station-tier
 * Police seat has no business reading Rescue's incidents, and "the UI does not link to it"
 * is not a control (INV-05).
 *
 * Two deliberate widenings:
 *
 * - **The two administrative offices may read everything.** Not a convenience. They hold
 *   the routing and override authority in the policy table, and authority to change a value
 *   you are not allowed to look at is not authority, it is guesswork. This used to say
 *   "tehsil and above", which in the district's real data meant everybody — see `Tier`.
 * - **An unrouted incident is readable by any seat.** Until routing has happened nobody owns
 *   it, and an emergency nobody is permitted to see is an emergency nobody picks up
 *   (INV-01). The window is small and closes at the first `routed` event.
 */
export function evaluateRead(attempt: ReadAttempt): Decision {
  /**
   * 🔴 **NOBODY HOLDING IT IS NOT EVERYBODY OWNING IT — ADR-0030, and this branch used to say
   * it was.**
   *
   * It answered *allowed, as owner* to any seat whenever `responsibleDepartmentIds` was empty,
   * and that was correct for as long as it described a WINDOW: the seconds between a report
   * arriving and a human placing it, during which the control room is who holds it. The comment
   * on `defaultRules` below still says so.
   *
   * Migration 0039 turned the window into the permanent state. `/route` takes department ids and
   * there are no departments left to take; the dispatch path's own assignment resolves a chosen
   * post to `null` and so never fires. **Every incident in Bajaur is unplaced for ever**, so read
   * as it was written this line hands the whole district to every account that exists.
   *
   * That is the mistake this codebase has now made four times — an absent value read as a
   * permissive one, after the four-value `Tier` defaulting every loaded post to `district`,
   * `navigator.onLine`, and `viewerFor`'s null department meaning *the district*. CLAUDE.md has
   * carried the warning for this specific one since 2026-08-22.
   *
   * ⚠️ **The window's own answer is kept, narrowed to who it was always about.** A district seat
   * still reads an unplaced incident as its owner, which is what let the control room work
   * before routing and is now simply what lets it work. Everybody else is refused — and since
   * ADR-0018 there is nobody else with an account, which is why nothing in Bajaur was exposed and
   * why the refusal has to be here before a second one is ever issued.
   */
  if (attempt.responsibleDepartmentIds.length === 0) {
    if (tierRank(attempt.seat.tier) >= tierRank('district')) {
      return { allowed: true, as: 'owner' };
    }
    return {
      allowed: false,
      why: `seat ${attempt.seat.seatId} has no district authority, and nobody holds this incident`,
    };
  }

  // ⚠️ The branch that read `seat.departmentId` here — *this seat is in a department that holds
  // the incident, so it may read it as owner* — is gone with the field (ADR-0031, phase 4). It
  // has been unreachable since migration 0039 left `responsibleDepartmentIds` empty on every
  // incident: the `length === 0` window above is the only branch that ever fires on this
  // installation. A placed incident (some other install's log) is now readable by a district
  // seat as `override` and by nobody else, which is what the tier check below already said.
  if (tierRank(attempt.seat.tier) >= tierRank('district')) {
    return { allowed: true, as: 'override' };
  }

  return {
    allowed: false,
    why: `seat ${attempt.seat.seatId} is not in a responsible department for this incident`,
  };
}

/**
 * Resolve two writes to the same field in the same window.
 *
 * Authority first, then time. The loser is never silently discarded — the caller is
 * expected to surface it as a visible conflict, so a disagreement between a department
 * and the control room is made explicit rather than settled by whoever saved last.
 */
export function resolveConflict(
  a: { readonly seat: Seat; readonly at: string },
  b: { readonly seat: Seat; readonly at: string },
): { readonly winner: 'a' | 'b'; readonly by: 'authority' | 'time' } {
  const ra = tierRank(a.seat.tier);
  const rb = tierRank(b.seat.tier);
  if (ra !== rb) return { winner: ra > rb ? 'a' : 'b', by: 'authority' };
  return { winner: a.at >= b.at ? 'a' : 'b', by: 'time' };
}

function isNonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * The starting policy table from docs/04-authority-model.md.
 *
 * Department ids are placeholders until the registry exists. This lives in code only
 * until there is a database to hold it — it is a table, not logic, by design.
 *
 * `responsibleDepartmentId` is null while an incident is unrouted. Every owner-held field
 * then has no owner, which leaves only the override tiers — so an untriaged, unrouted
 * incident can be acted on by the control room and by nobody else. That is the correct
 * answer: before routing, the control room is who holds it.
 */
/**
 * **The control room owns every governed field — 2026-08-22, the district's decision.**
 *
 * Named once so the ten rules below cannot drift apart, and so the one line to change if a
 * department ever holds a seat again is this one.
 */
const DISTRICT_OWNS: readonly Tier[] = ['district'];

export function defaultRules(responsibleDepartmentId: Uuid | null): readonly AuthorityRule[] {
  /**
   * ⚠️ **Accepted and deliberately unused since 2026-08-22 — no department owns anything.**
   *
   * Every rule below used to name the incident's responsible department as its owner, so a
   * department could triage, acknowledge, resolve and close its own emergencies. The district
   * removed that outright: *"department ko koi access nahi milne wala hai, un ka koi account nahi
   * banega."* Ownership moved to the seat's **tier** (`ownerTiers`), which is a fact about who is
   * acting rather than about which incident it is.
   *
   * The parameter stays because every call site passes it and because this is the seam a future
   * reorganisation would come back through — Bajaur may one day have real departments with many
   * officers each (ADR-0023). Deleting it would make that a signature change across the codebase
   * rather than a change to this file.
   */
  void responsibleDepartmentId;

  return [
    {
      fieldKey: 'incident.severity',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes',
    },
    {
      fieldKey: 'incident.category',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes',
    },
    {
      fieldKey: 'incident.responsibleDepartment',
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    {
      /**
       * New row (M0-28). Acknowledgement is an act of the department that owns the
       * incident — but the escalation ladder can move the obligation to a district seat
       * when the department stays silent (ADR-0004, ADR-0005), and that seat must then be
       * able to take it. Hence a district override, with a reason: the control room
       * acknowledging on a department's behalf is exactly the thing that should be
       * explainable afterwards, since acknowledgement stops the SLA clock.
       */
      fieldKey: 'incident.acknowledgement',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    {
      /**
       * New row (M6-04). **Who the control room chose to tell.**
       *
       * Owned by the responsible department and overridable by the district, like every other
       * row here — but the direction that matters is the second one. The control room's whole
       * job is telling *other people's* departments, and before routing has run the incident
       * has no owner at all, which leaves the district tier holding it. That is the correct
       * answer and it falls out of the table rather than out of a check in the handler.
       *
       * **No reason is required, and that is a decision rather than an omission.** Every other
       * override here changes a value somebody else entered, so demanding an explanation is
       * proportionate. A dispatch changes nothing: it adds an obligation, fully attributed to
       * the seat that created it, at the moment they created it. Requiring a sentence for the
       * single most frequent act in the control room — forty times a day, on a telephone call —
       * would buy an audit trail that is already complete and cost the one thing intake speed
       * is a correctness property for. A reason is accepted and recorded when given.
       *
       * `visibleToOwner: 'yes_and_notify'` because a department finding out from the district
       * that somebody else was told about its incident is exactly the handover-nobody-announced
       * failure `lost_responsibility` exists for.
       */
      fieldKey: 'incident.dispatch',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: false,
      visibleToOwner: 'yes_and_notify',
    },
    {
      fieldKey: 'incident.actions',
      ownerTiers: DISTRICT_OWNS,
      reasonRequired: false,
      visibleToOwner: 'none',
      appendOnly: true,
    },
    /**
     * **Correcting what we sent** — M9-52.
     *
     * Its own rule, and it needed one. `incident.actions` was the obvious home — correcting is
     * append-only and adds a fact rather than replacing one — but `actions` is `appendOnly`,
     * and this table refuses an append-only field to **anybody but its owner**, deliberately:
     * an action log somebody else can write to is a log that cannot be read as one department's
     * own account of what it did.
     *
     * That is exactly wrong here. The message that went out wrong was usually sent **by the
     * control room**, on behalf of a department that had nothing to do with it — and the
     * control room being unable to correct its own message is how a wrong meeting notice stays
     * uncorrected. So the district may override, and it must give a reason, which it must give
     * anyway (`parseCommand` refuses a correction without one).
     *
     * `visibleToOwner: 'yes_and_notify'` because a department whose emergency was corrected by
     * somebody else needs to hear about it — the same treatment closure and dispatch get.
     */
    {
      fieldKey: 'incident.correction',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    /**
     * **Taking it off the board** — M10-16.
     *
     * Its own row rather than sharing `incident.correction`, because the two answer different
     * questions and one day the district may want a department able to do one and not the
     * other. Sharing a key would make that a schema change instead of a table edit.
     *
     * The shape is `incident.correction`'s, and for the same reason: **the row that went out
     * wrong was usually put there by the control room**, on behalf of a department that had
     * nothing to do with it. A district unable to take its own mistake off its own board would
     * leave it there — which is how a board stops being read.
     *
     * `visibleToOwner: 'yes_and_notify'`, because a department whose emergency somebody else
     * removed from the board needs to hear it from the system rather than notice the gap.
     */
    {
      fieldKey: 'incident.withdrawal',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    /**
     * **Putting it back is its own row, and the difference is `reasonRequired`** — M10-18.
     *
     * This was found by a test rather than designed: `restore` shared the row above, the
     * control room is an **overrider** on an unassigned incident, and `evaluateWrite` refuses an
     * override with no reason — so restoring answered **403** and the way back did not exist.
     *
     * Sharing the row and then demanding a reason would have been the easy fix and the wrong
     * one. **Withdrawing removes a row from the screen a control room acts on, so it owes an
     * explanation. Restoring undoes that**, and the act carries its own — *it should not have
     * been withdrawn*. Asking anyway produces "mistake" forty times, which is the argument
     * `corrected.correction` already makes for being optional.
     *
     * Authority is still required and is identical: whoever may take a row off may put it back.
     * Only the sentence is not.
     */
    {
      fieldKey: 'incident.restoration',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: false,
      visibleToOwner: 'yes_and_notify',
    },
    /**
     * **Whether it survives the daily reset** — the district's five, 2026-08-22.
     *
     * A third question about the same row, and genuinely distinct from the two above it.
     * `incident.correction` answers *is what we said still true*; `incident.withdrawal` answers
     * *should this be on the screen at all*; this answers *does this still count as running
     * tomorrow morning*. An item can honestly be corrected, on the board, and released from the
     * panel all at once.
     *
     * **One row for both directions**, where withdrawal needed two. The split there existed only
     * because restoring demands no reason and `evaluateWrite` refuses an overrider who gives
     * none. Both of these carry a reason, so both evaluate identically — and they are the same
     * authority in substance: whoever may decide a flood stays on the wall is whoever may decide
     * it comes off.
     *
     * `reasonRequired: true` on both, and it is the point rather than a formality. The panel
     * will generate exactly two questions — *"why is this still here"* and *"why did this stop
     * being tracked"* — and neither has an answer anywhere else. The act is rare, so this costs
     * a sentence on something that happens seldom.
     *
     * `visibleToOwner: 'yes_and_notify'`, for `incident.withdrawal`'s reason: a department whose
     * flood somebody else released from the district's panel needs to hear it from the system
     * rather than notice the gap.
     */
    {
      fieldKey: 'incident.carrying',
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    /**
     * **The meeting moved** — the district's five, 2026-08-22.
     *
     * Its own row rather than `incident.closure`, and the reason is that the two make opposite
     * claims about the same meeting: closure says *this is over*, a reschedule says *this is
     * still happening, later*. Sharing a key would mean the authority to end something and the
     * authority to insist it has not ended could never be given apart, and the day the district
     * wants exactly that it would be a schema change rather than a table edit.
     *
     * `reasonRequired: true`, and it is the message rather than the record that needs it: the
     * follow-up that goes back to every officer already told is built from this sentence, so a
     * reschedule with no reason is a second WhatsApp message saying a meeting moved and not why.
     *
     * `visibleToOwner: 'yes_and_notify'` — a department whose meeting somebody else moved must
     * hear it from the system rather than turn up on the wrong day.
     */
    {
      fieldKey: 'incident.schedule',
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    /**
     * **Escalating by a person's hand** - Phase 8c, 2026-08-21, and it is a new kind of act here.
     *
     * Until Phase 8a an escalation was only ever something the **software** did: the ladder ran on
     * a deadline, appended `escalated`, and told the seat above. The district then asked for the
     * telling to stop - *"un ke high up office ko inform/shikayat nahi karni hai"* - and chose the
     * option where an escalation **marks the board and messages nobody**, with the actions left on
     * it for a person to take.
     *
     * That leaves an act with no rule, because the ladder never needed one: a job runs as the
     * system and asks nothing. A **person** pressing *Escalate* is asserting something about a
     * department - *this went past its deadline and they did not answer* - and that is precisely
     * the kind of claim this table exists to govern.
     *
     * **Owned by the responsible department, overridable by the district**, like every row here,
     * and both directions are real. A department escalating its own emergency is the honest act
     * *"this is beyond us, it should sit higher"*, and refusing it would leave the only way up
     * running through the control room. The control room escalating **past** a department is the
     * override, and it is the frequent one.
     *
     * ⚠️ **`reasonRequired: true`, and it is the point rather than a formality.** An
     * escalation now *only* leaves a mark - nobody is messaged, so the mark is the entire content
     * of the act, and a mark that does not say why is a row on a board nobody can act on
     * afterwards. It is also rare: the ladder has produced **zero** escalations in this district's
     * whole history, so this costs a sentence on an act that happens seldom - unlike
     * `incident.dispatch`, which is exactly why that row deliberately requires none.
     *
     * `visibleToOwner: 'yes_and_notify'` for `incident.withdrawal`'s reason: a department that was
     * escalated past must hear it from the system rather than find the mark later.
     */
    {
      fieldKey: 'incident.escalation',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
    {
      fieldKey: 'incident.closure',
      ownerTiers: DISTRICT_OWNS,
      overrideTiers: ['district'],
      reasonRequired: true,
      visibleToOwner: 'yes_and_notify',
    },
  ];
}
