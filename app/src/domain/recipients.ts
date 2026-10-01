/**
 * Who the control room can tell, and whether telling them would actually reach anybody — M6.
 *
 * This is the domain half of the district's first requirement (ADR-0016): an alert arrives by
 * telephone, the operator types it, and then **chooses who should know** — a department, a
 * post, or a named officer, several of them at once. Today that choice happens on a personal
 * handset and leaves no trace.
 *
 * Everything here is pure. The queries live in `api/contacts.ts`; what this file owns is the
 * two judgements that must not be made twice in two places:
 *
 *   1. **whether a recipient is reachable at all**, and
 *   2. **what one person selecting overlapping things actually means**
 *
 * Both look like formatting concerns and are not. The first decides whether the district
 * believes somebody was told; the second decides whether an officer's phone rings twice at
 * 02:00 for one emergency, which is the fastest way to teach somebody to mute it.
 */

import type { RecipientKind, Uuid } from './events.js';

/**
 * Re-exported, not redefined.
 *
 * It moved into `events.ts` when the `dispatched` payload started carrying it (M6-03), because
 * an event catalog importing from a module built on top of it is the wrong way round. Every
 * existing import of it from here still works, which is the whole reason this line exists.
 */
export type { RecipientKind };

/**
 * Why a recipient cannot be reached.
 *
 * A closed set rather than a free string, because these are shown on screen next to a
 * checkbox and each one needs a different action from the district: `vacant` needs somebody
 * appointed, `placeholder` needs the real number, `no_number` needs the roster filled in, and
 * `disabled` is somebody who should probably not be in the list at all.
 */
export type Unreachable = 'vacant' | 'placeholder' | 'no_number' | 'disabled';

export interface Recipient {
  readonly kind: RecipientKind;
  /** The seat, the person, or the department — whichever this row *is*. */
  readonly id: Uuid;
  /** The post title, the person's name, or the department's name. */
  readonly label: string;
  /** Which department this belongs to. Null for a district-tier post. */
  readonly departmentId: Uuid | null;
  readonly departmentName: string | null;
  /** Who holds the post, when this is a post and somebody does. */
  readonly holderName: string | null;
  readonly holderPersonId: Uuid | null;
  /**
   * The designation this person holds **in this department** — M10-06.
   *
   * Only ever set on a `person` row, and only when they hold one. A post row's designation is
   * already its `label`, and a department has none.
   *
   * ⚠️ **It is per row, not per person, and that is the whole of O-27.** A person row now exists
   * once for each department they serve, so somebody holding two designations in two departments
   * is two rows carrying their own designation each — rather than one row naming whichever the
   * database happened to return first. Three officers in Bajaur are in exactly that position, and
   * two of them across different departments.
   */
  readonly designation: string | null;
  readonly phone: string | null;
  /**
   * Null when there is nothing standing in the way.
   *
   * Note what this is *not*: a filter. An unreachable recipient is still offered, still
   * selectable, and selecting one still records the obligation — which then fails loudly.
   * See `assertOfferedAnyway` below for why that is deliberate.
   */
  readonly unreachable: Unreachable | null;
}

/**
 * `Name — Designation` — the one way this district names a told or responding officer.
 *
 * The district asked for a named officer on the "who was told" list, the board's `who` column
 * and the response breakdown to carry the post they hold beside their name — `Rustam Khan —
 * DDMA` (`backlog/whatsapp-response-workflow.md` §6). It is the same rule ADR-0035 set for every
 * actor-naming site ("the person leads the name; one string when the two restate each other"),
 * reaching the **recipient** list that ADR left name-only. The separator matches `actorName` in
 * `domain/report.ts` — ` — ` — so provenance and the recipient list read the same way; §6's
 * mock predates ADR-0035. This takes a bare designation string rather than an `Actor` because a
 * `person` recipient carries no seat id.
 *
 * The **collapse** matters here: Bajaur's directory holds 79 single-person "departments" whose
 * name restates the designation, and control-room seats whose holder's name IS the seat's name —
 * `District Nerve Center — District Nerve Center` is printed once.
 *
 * A `null` or blank designation means the officer holds no live post to name — they are named
 * alone. Only a `person` recipient is composed this way: a `post` recipient's label already
 * IS the designation.
 */
export function withDesignation(name: string, designation: string | null | undefined): string {
  const post = designation?.trim() ?? '';
  if (post === '' || post.toLowerCase() === name.trim().toLowerCase()) return name;
  return `${name} — ${post}`;
}

/**
 * Work out whether this recipient can be reached, and if not, why.
 *
 * Order matters and is not arbitrary. A vacant post is reported as vacant even though it also
 * has no number, because "nobody holds this post" is the fact the district must act on and
 * "there is no number" is merely its consequence. Reporting the consequence would send
 * somebody to fix a roster entry that should not exist yet.
 */
export function reachabilityOf(holder: {
  readonly holderPersonId: Uuid | null;
  readonly phone: string | null;
  readonly placeholder: boolean;
  readonly disabledAt: string | null;
}): Unreachable | null {
  if (holder.holderPersonId === null) return 'vacant';
  if (holder.disabledAt !== null) return 'disabled';

  // A stand-in fills a post so the roster is complete (migration 0008). Dialling it reaches
  // nobody, and finding that out at 02:00 is the failure this whole system exists to prevent.
  if (holder.placeholder) return 'placeholder';

  if (holder.phone === null || holder.phone.trim() === '') return 'no_number';

  return null;
}

/**
 * An unreachable recipient is offered, never hidden.
 *
 * This function does nothing but hold the reasoning, because the reasoning is the part that
 * gets lost. Filtering the list to reachable recipients only is the obvious kindness and it
 * is wrong twice:
 *
 *   * The control room would not know the post exists. A district that cannot see that
 *     Rescue's night duty post is vacant cannot ask anybody to fill it — and the one moment
 *     they would have noticed is the moment they went looking for somebody to tell.
 *   * **A vacant post must never swallow an obligation** (ADR-0004, and the same rule
 *     escalation follows). Selecting one records that somebody was owed a message and did not
 *     get one, which surfaces on the board as an unmet obligation. Hidden, it produces
 *     silence — and silence reads as "everybody was told".
 */
export function assertOfferedAnyway(): void {
  /* Intentionally empty. See the doc comment. */
}

export interface SelectedTarget {
  readonly kind: RecipientKind;
  readonly id: Uuid;
}

export interface ResolvedTarget extends SelectedTarget {
  /**
   * Why this target survived, or what absorbed it.
   *
   * Kept rather than discarded so the incident's record can say *"the DC office was selected
   * and is already covered by the Revenue department"* — an operator who sees their selection
   * silently shrink stops trusting the screen.
   */
  readonly coveredBy: SelectedTarget | null;
}

/**
 * Collapse a selection so that one emergency produces one message per person.
 *
 * The control room will select overlapping things, constantly and correctly: "tell Rescue,
 * and tell the District Emergency Officer" is a natural sentence, and the second is a post
 * inside the first. Sent literally, that officer's phone buzzes twice for one emergency.
 *
 * The rule, in one line: **a person is absorbed by a post they hold that is also selected, and
 * a post is absorbed by another post held by the same officer.** Nothing else is collapsed —
 * two officers in one office are two people and both are meant to be told.
 *
 * ⚠️ **A post being absorbed by its own *department* was the third rule and is gone — ADR-0031,
 * phase 2.** The picker has offered contacts only since ADR-0023, `'department'` has left
 * `RecipientKind`, and no selection carries one — so `departmentOfPost` stays on the `index`
 * for its callers' sake but nothing here reads it any more.
 *
 * What this deliberately does **not** do is deduplicate by phone number. Two officers
 * genuinely share `03000000171` in Bajaur's directory, which is ordinary here (migration 0006,
 * Q-19) — and collapsing them would mean the district telling one post and recording that it
 * told two. The duplicate message is the lesser problem, and the honest ledger is the point.
 */
export function collapseSelection(
  selected: readonly SelectedTarget[],
  index: {
    /** seatId → the department it belongs to. */
    readonly departmentOfPost: ReadonlyMap<Uuid, Uuid | null>;
    /** personId → the posts they currently hold. */
    readonly postsOfPerson: ReadonlyMap<Uuid, readonly Uuid[]>;
    /**
     * seatId → who holds it right now, when anybody does.
     *
     * Added with the flat contact directory (2026-08-22). The three maps above answered
     * *"what covers what"* across the three recipient kinds; this one answers **"are these two
     * rows the same handset"**, which is a question the picker never used to ask because the
     * person row was there to absorb the overlap.
     */
    readonly holderOfPost?: ReadonlyMap<Uuid, Uuid | null>;
  },
): readonly ResolvedTarget[] {
  const posts = new Set(selected.filter((t) => t.kind === 'post').map((t) => t.id));

  const seen = new Set<string>();
  const out: ResolvedTarget[] = [];

  /**
   * The first **kept** post for each holder, as we go — the state the rule below needs.
   *
   * Kept rather than merely selected: a post already absorbed by its department must not then
   * absorb a third post, which would record one tick as covered by another tick that is itself
   * covered. The chain has to end at something that is actually being messaged.
   */
  const keptPostOfHolder = new Map<Uuid, Uuid>();

  for (const target of selected) {
    // The same thing ticked twice is one thing. Cheap, and it happens: a list long enough to
    // scroll is a list somebody double-clicks in.
    const key = `${target.kind}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (target.kind === 'post') {
      /**
       * 🔴 **TWO DESIGNATIONS, ONE OFFICER, ONE MESSAGE — 2026-08-22.**
       *
       * The gap the flat contact directory exposes, and it was always here: nothing collapsed
       * **post against post**. It stayed harmless only because the person row existed to absorb
       * the overlap, and because ticking two posts held by one officer was an unusual thing to
       * do while the picker was grouped by department.
       *
       * It is no longer unusual. With one row per designation, *Imran* is **two rows** (C&W
       * Buildings and C&W Highways) and *Zubair Ahmad* is two (ADC General and ADC Relief) —
       * these are the district's own, read off the live directory on 2026-08-16 — and an
       * operator ticking both is ticking the obvious thing. Uncollapsed that is two obligations
       * and **two messages to one handset for one emergency**, which this file's own header
       * calls the fastest way to teach somebody to mute their phone.
       *
       * **The second tick is recorded as absorbed, never dropped.** *"Tell C&W Highways"* is a
       * real instruction that was really given, and six weeks later *"was Highways told?"* has
       * to answer yes — with what covered it. That is what `coveredBy` has always been for.
       */
      const holder = index.holderOfPost?.get(target.id) ?? null;
      if (holder !== null) {
        const covering = keptPostOfHolder.get(holder);
        if (covering !== undefined) {
          out.push({ ...target, coveredBy: { kind: 'post', id: covering } });
          continue;
        }
        keptPostOfHolder.set(holder, target.id);
      }
    }

    if (target.kind === 'person') {
      const held = index.postsOfPerson.get(target.id) ?? [];
      const coveringPost = held.find((seatId) => posts.has(seatId));
      if (coveringPost !== undefined) {
        out.push({ ...target, coveredBy: { kind: 'post', id: coveringPost } });
        continue;
      }
    }

    out.push({ ...target, coveredBy: null });
  }

  return out;
}

/** The targets that will actually be messaged — everything nothing else absorbed. */
export function effectiveTargets(resolved: readonly ResolvedTarget[]): readonly SelectedTarget[] {
  return resolved.filter((t) => t.coveredBy === null).map(({ kind, id }) => ({ kind, id }));
}

/**
 * Numbers held by more than one recipient in the same selection.
 *
 * Surfaced, never resolved. A shared handset is ordinary here and a **mistyped digit looks
 * exactly like one** — so the district is shown "these two officers have the same number"
 * and decides which it is. Guessing either way is how a wrong number stays wrong for months.
 */
export function sharedNumbers(
  recipients: readonly Recipient[],
): readonly { readonly phone: string; readonly labels: readonly string[] }[] {
  const byPhone = new Map<string, string[]>();

  for (const r of recipients) {
    const phone = (r.phone ?? '').trim();
    if (phone === '' || r.unreachable !== null) continue;

    const labels = byPhone.get(phone) ?? [];
    labels.push(r.label);
    byPhone.set(phone, labels);
  }

  return [...byPhone.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([phone, labels]) => ({ phone, labels }))
    .sort((a, b) => a.phone.localeCompare(b.phone));
}
