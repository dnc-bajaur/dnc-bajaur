/**
 * The central board — M0-33.
 *
 * One projection, not a copy. This reads the same event log everything else reads and folds
 * it on demand; there is no board table to fall out of step with the record (ADR-0001, and
 * root idea #4: one source of truth).
 *
 * Three properties this file exists to hold:
 *
 * 1. **It never renders stale data as current (INV-02).** Every response carries `asOf` and
 *    every row carries `lastRecordedAt`, so a client can always say how old what it is
 *    showing actually is. A board with no clock on it is a board that lies during an outage.
 * 2. **It never hides a critical, and never hides an unassessed report either (INV-04,
 *    ADR-0009).** The summary reports both numbers and folds neither into the other.
 * 3. **Scoping is server-side (INV-05).** Rows a seat may not see are not sent and then
 *    hidden — they are not sent.
 */

import { loadRecentIncidents } from '../db/eventStore.js';
import { referencesFor } from '../db/referenceStore.js';
import { formatReference } from '../domain/reference.js';
import type { Pool } from '../db/pool.js';
import { evaluateRead, type Seat } from '../domain/authority.js';
import {
  CARRIES_SLA,
  isAssessed,
  isGeneral,
  isGathering,
  MESSAGE_KINDS,
  severityRank,
  SEVERITY_ORDER,
  type AssessedSeverity,
  type DispatchTarget,
  type IncidentEvent,
  type Instant,
  type Severity,
  type Uuid,
} from '../domain/events.js';
import {
  endOfNamedDistrictDay,
  startOfDistrictDay,
  startOfNamedDistrictDay,
} from '../domain/districtTime.js';
import { recordDateRange, recordLookbackDays } from '../domain/recordWindow.js';
import { districtSeverity, foldIncident, type IncidentState } from '../domain/incident.js';
import { unmetObligations, whyUnmetReads } from '../domain/notifications.js';
import { ownershipOf, type Holding } from '../domain/ownership.js';
import { attendanceFor } from '../domain/attendance.js';
import {
  absorbedKeys,
  groupRecipients,
  groupsFromEvents,
  type DispatchGroup,
} from '../domain/recipientGroups.js';
import { attendanceClosesAt } from '../domain/meetings.js';
import { withDesignation } from '../domain/recipients.js';
import { departmentDirectory } from '../ops/directory.js';
import {
  checkEscalation,
  PLACEHOLDER_SLA,
  targetsFor,
  type SlaConfig,
  type SlaTargets,
} from '../domain/sla.js';
import { loadSlaConfiguration } from '../db/configStore.js';
import { log } from '../obs/log.js';
import { STAGES, stageOf, type Stage } from '../domain/stages.js';

export interface BoardRow {
  readonly incidentId: Uuid;
  /**
   * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
   *
   * Formatted on the server, beside the id rather than instead of it. The uuid is what every
   * URL, every fold and the outbox are built on; this is what a control room says on a
   * telephone. Formatting it here rather than on the row keeps one definition of the shape
   * (`domain/reference.ts`) — a second template on a screen is how the board and the printed
   * report begin quoting one incident two ways.
   *
   * **Null is a real state and every screen must survive it.** The number is assigned after the
   * events commit and outside their transaction (INV-01 — the record outranks the counter), so
   * an incident can exist for a moment, or until the next restart, with no number at all.
   */
  readonly reference: string | null;
  readonly status: IncidentState['status'];
  /**
   * The same status in the four words the district uses — M9-25.
   *
   * Sent **beside** `status`, never instead of it. The seven are what the board reasons with;
   * the four are what somebody says out loud, and collapsing to them here would take *"routed
   * to Rescue"* and *"not routed to anybody"* and call them the same thing on the one screen
   * whose job is to show that gap. Computed, not stored — see `domain/stages.ts`.
   */
  readonly stage: Stage;
  /**
   * **What kind of thing this is** — M9-11, and it was the last gap in M9.
   *
   * Without it, a meeting notice renders on the board **exactly like an emergency**: a severity
   * word and the sentence "unacknowledged". An operator scanning at 02:00 sees a row nobody has
   * answered and cannot tell that nobody was ever supposed to.
   *
   * `general` is `isGeneral(kind)` resolved **here**, so the one renderer does not carry a
   * second copy of which kinds are emergencies — the same rule `CARRIES_SLA` already follows a
   * few lines below.
   */
  readonly kind: string;
  readonly general: boolean;
  /**
   * **What we sent was wrong** — M9-52/53, and the wording is load-bearing.
   *
   * Sent as a flag **and** a sentence, because a flag alone reads as *deleted* and this is not
   * a deletion. Nothing was removed and the people who were told still received what they were
   * told; an operator who believes otherwise will not ring them.
   */
  readonly corrected: boolean;
  readonly correctionReason: string | null;
  /**
   * **Taken off the board** — M10-11/15, and this flag exists *because* the board hides it.
   *
   * The board drops these rows; **search and the daily report keep them and mark them with
   * this**. That pairing is the whole of the district's request being safe: a row leaves the
   * screen a control room acts on, and stays in every surface somebody goes looking in. A
   * `withdrawn` row arriving on a screen with no way to say so would read as an ordinary
   * emergency, which is worse than either behaviour on its own.
   */
  readonly withdrawn: boolean;
  readonly withdrawalReason: string | null;
  readonly severity: Severity;
  /** False when nobody has assessed it. The label, never a colour, carries this (INV-04). */
  readonly assessed: boolean;
  /** Present only when a higher authority replaced the department's own value (ADR-0003). */
  readonly overriddenFrom: AssessedSeverity | 'unknown' | null;
  readonly category: string;
  readonly responsibleDepartmentIds: readonly Uuid[];
  /**
   * The same departments, named (M0-51).
   *
   * Ids are what the event log stores; names are the only form an operator can act on.
   * Resolved server-side and sent alongside, so no screen is ever tempted to render the id
   * because the name was one request away.
   */
  readonly responsibleDepartments: readonly string[];
  /**
   * **Who was actually told, by name** — and the reason this is not `responsibleDepartments`.
   *
   * That field answers *which department holds this*. This answers *who did we send it to*, and
   * since M10-07/08/09 made the person row the only row the picker draws, the two are different
   * on most of Bajaur's record: the board printed **"told directly"** for every emergency the
   * control room dispatched to an officer by name, which is a sentence that names nobody on the
   * one screen the district reads at 02:00.
   *
   * Named here for the same reason the departments are (M0-51): ids are what the log stores and
   * names are the only form an operator can act on, so a screen is never tempted to render an id
   * because the name was one request away.
   *
   * Empty is honest and means two different things, which `nobodyTold` separates: nobody was
   * chosen at all, or the recipients could not be named. The row says which.
   */
  readonly toldNames: readonly string[];
  /**
   * **What the officer said when they resolved it** — the district asked for this on the row,
   * 2026-08-23.
   *
   * `resolved.outcome` is an officer's own words: a WhatsApp reply lands here verbatim through
   * `webhooks.ts` -> `recordResolution`, and a control-room resolution carries whatever was
   * typed. It is the answer to *"kya hua us ka"* and it was reachable only by opening the
   * incident.
   *
   * ⚠️ **Null until the incident is actually resolved**, never an empty string. A row that
   * carried a blank resolution would draw an empty box under every live emergency on the board,
   * which is the noise this screen has just had removed from it.
   */
  readonly resolution: string | null;
  /**
   * **What the district actually told people about this** — 2026-08-23, Phase B.
   *
   * The `what` and `where` of the message that went out, taken from the most recent attempt that
   * has them. Those are the only two parts of an outbound message a human reads; the acknowledge
   * token, the media id and the template name are the envelope.
   *
   * ⚠️ **Null means UNKNOWN, not “nothing was sent”**, and the row must say so in those words.
   * Nothing sent before 2026-08-23 carries a `message_sent` event and none can be reconstructed:
   * the composer runs off current state, so rebuilding an old message would produce what it
   * *would* say today — a different sentence wherever the incident has since been corrected,
   * rescheduled or reassessed. That is the exact case “Correct this” exists to be careful about,
   * and a board that showed a recomposed message as *what we sent* would be lying in it.
   *
   * The **most recent** rather than the first: an incident told twice was told about the second
   * state of the world, and that is the sentence the officer is acting on.
   */
  readonly sentMessage: { readonly what: string; readonly where: string } | null;
  /**
   * **Whether this alert was chased, and whether the chase got through** — 2026-08-23.
   *
   * `note` is the most recent chase, composed by `api/followUp.ts` and already carrying the
   * operator’s own words and which alert it follows. `count` is how many there have been, because
   * *chased once* and *chased four times* are different situations on the same row.
   *
   * 🔴 **`failed` is the field this exists for.** It is true when ANY chase could not be sent —
   * not just the latest — because the thing an operator acts on is a handset the district cannot
   * reach, and a later success does not undo an earlier dead number. `delivered` here is Meta
   * accepting the message and never an officer reading it (ADR-0014).
   *
   * Null when nothing was ever chased, which is most rows.
   */
  readonly followUp: {
    readonly note: string;
    readonly count: number;
    readonly failed: boolean;
  } | null;
  readonly occurredAt: Instant | null;
  /**
   * When the incident first reached the server (its earliest `reported` event). The `recorded`
   * sort orders on this — "the latest thing entered", as against `occurredAt`'s "when it
   * happened". See `IncidentState.arrivedAt`.
   */
  readonly arrivedAt: Instant | null;
  /** How current this row is. The client renders it; it does not get to omit it (INV-02). */
  readonly lastRecordedAt: Instant | null;
  readonly acknowledgedAt: Instant | null;
  readonly escalationCount: number;
  /** Past its acknowledgement deadline and still unacknowledged. Decided server-side. */
  readonly overdue: boolean;
  readonly overdueByMinutes: number;
  /**
   * Notifications that have not reached anybody — INV-03's "unmet obligation".
   *
   * Two numbers, not one. `failed` means the attempt could not be made at all (a vacant
   * post, a dead gateway) and needs someone to fix a roster or a channel. `undelivered`
   * means it was queued and nobody has picked it up, which needs someone to pick up a
   * phone. Collapsing them would leave the control room unable to tell which.
   */
  readonly notificationsFailed: number;
  /**
   * Why, in a sentence an operator can act on. Absent when nothing has failed.
   *
   * A sentence rather than a code, and **one** rather than all of them: three failures with
   * three different fixes are three different jobs, and the row has space for the one that is
   * this row's alone (`whyUnmetReads`).
   */
  readonly notificationsWhy?: string;
  readonly notificationsUndelivered: number;
  /**
   * Routing ran and matched no department (ADR-0010).
   *
   * Distinct from "not routed yet", which is what an empty `responsibleDepartmentIds` means
   * on its own. This one is a configuration gap the administration can close, and it is the
   * row that must never sit quietly at the bottom of a list.
   */
  readonly unassigned: boolean;
  /** The acknowledgement deadline actually applied to this row, in minutes. */
  readonly targetMinutes: number;

  /**
   * The three flags the dashboard's district counters are clickable through.
   *
   * **Decided here, on the server, and never recomputed by a screen.** Each of these answers
   * exactly the question one counter asks, and the counter and the rows it leads to are folded
   * from the same events in the same pass — so a counter reading 5 lands on 5 rows, always.
   *
   * A client-side predicate would be a second implementation of each rule, and the first one
   * to drift would put a number on the district's home screen that its own board disagrees
   * with. `occurredToday` in particular cannot be redone safely on a client at all: it is
   * measured against **the server's midnight**, and a handset with a different timezone would
   * quietly answer a different question.
   */
  readonly held: boolean;
  readonly acknowledged: boolean;
  readonly occurredToday: boolean;
  readonly notificationsUnmet: boolean;
  /**
   * **Nobody has been told** — the control room has chosen no recipients (M6-09).
   *
   * Not the same question as `notificationsUnmet`, and the difference is the one the district
   * cares about. An unmet obligation is somebody who was owed a message and did not get it; this
   * is an emergency where nobody was even *named*. Routing may have placed it perfectly and the
   * duty post may have acknowledged — and the road department, the hospital and the officer who
   * knows that road have still not heard, because that decision lives in an operator's head and
   * a paper register.
   *
   * That is the gap M6 exists to close, so it gets its own number on the district's home screen.
   */
  readonly nobodyTold: boolean;
  /**
   * 🔴 **Everybody who answered said they could not** — RX-02, 2026-08-25.
   *
   * The district's response workflow shipped with this fact on the **incident's own panel**,
   * and that was half the job. **The control room does not open an incident at 02:00 — it reads
   * this board.** An emergency two officers declined has an `acknowledgedAt`, so the row said
   * `acknowledged` and looked exactly like one somebody is dealing with.
   *
   * ⚠️ **Not the negation of `acknowledged`, and not a kind of silence.** Nobody answering is
   * `unacknowledged` and always has been; this is the opposite — **everybody** answered, and
   * every one of them said no. Those are two different things for an operator to do.
   *
   * Server-side for `held`’s reason: a client predicate would be a second implementation of
   * `ownershipOf`, and the first to drift would put a colour on this board that the incident
   * screen disagrees with about the same emergency.
   */
  readonly ownerless: boolean;
  /** How many of them declined. The row says *how bad*, not only *that it happened*. */
  readonly declined: number;
  /**
   * **What came back from the people who were told — the Record's "Response", 2026-08-31.**
   *
   * The `state` sentence beside it says where the *incident* stands; this says what the
   * *officers* actually said. Folded from the same `ownershipOf` the board already uses for
   * `ownerless`/`declined`, so a second rule about who is holding an emergency cannot drift in
   * beside the first — and resolved to names here, where the dispatch directory already is.
   *
   * ⚠️ **Null when nobody was dispatched** (`told === 0`), the same withholding `sentMessage`
   * and `toldNames` do: a "no responses yet" line under a row nobody was asked about is a
   * sentence about a conversation that never started, and forty of them is the noise this
   * screen has repeatedly had removed.
   *
   * `latest` is null until an officer answers **in words** — an acknowledgement with no reply
   * is a tap, not a response, and the `acknowledged` sentence already carries it. The
   * `breakdown` is one line per dispatched recipient, for the row's own in-place disclosure:
   * the row shows the aggregate, the disclosure opens to this.
   */
  readonly response: {
    /** Everyone the control room actually messaged — the denominator for the three below. */
    readonly told: number;
    /** Answered and taken it: a deployment, a resolution, cognizance, or their own words. */
    readonly holding: number;
    /** Answered one of the district's decline sentences (*Unable to Respond* and its four). */
    readonly declined: number;
    /** Has not answered at all. Still the chase list's problem. */
    readonly silent: number;
    /** Somebody answered and nobody is holding it — RX-02, carried here so one row shows it. */
    readonly ownerless: boolean;
    /** The most recent officer reply, verbatim, with who said it and when. Null until one exists. */
    readonly latest: {
      readonly who: string | null;
      readonly said: string;
      readonly at: Instant | null;
    } | null;
    /**
     * **When the first office committed** — the honest "responded at" for a wide dispatch,
     * Option C. `takenBy`'s settle time, or null while everyone is silent and when `ownerless`.
     * The CSV's `acknowledged_at` reads this over the fold's first-tap slot once `told > 1`.
     */
    readonly respondedAt: Instant | null;
    readonly breakdown: readonly {
      readonly who: string | null;
      readonly holding: Holding;
      readonly said: string | null;
      /**
       * **The saved group this recipient came from** — Case 3, 2026-09-10. The name only, read
       * off `dispatched.payload.fromGroups`; `null` for anybody the control room ticked by
       * hand. The row's disclosure heads its lines with it — display only, no group entity in
       * `IncidentState` and not one count on this row changed.
       */
      readonly group: string | null;
    }[];
  } | null;
  /**
   * **Who is coming, when this row is a notice that asked who is coming** — the Case 2 (meeting)
   * work, 2026-09-10.
   *
   * Non-null only for a `meeting` or an `asksAttendance` notice — the same `attendanceFor` tally
   * the incident drawer and the wall's *Still running* card read. Where it is set, the row's
   * *Response* column shows `attending / representative / not attending / silent` rather than
   * the generic `holding / declined / silent` (a meeting has no "holding"), and `compareRows`
   * orders unanswered gatherings above settled ones. Null for every emergency, a plain notice
   * and `schedule` — the row is unchanged there, and `response` above still carries it.
   */
  readonly attendance: {
    readonly told: number;
    readonly coming: number;
    readonly answered: number;
    readonly attending: number;
    readonly sendingSomeone: number;
    readonly notAttending: number;
    readonly other: number;
    readonly unanswered: number;
  } | null;
  /**
   * **The two figures whose counters had no row flag to land on — M11-06.**
   *
   * Every flag above answers exactly the question one counter asks. These two did not exist, so
   * the *only* attributes a screen could filter on were `acknowledged` and `assessed` — which
   * are facts about the incident and **not** the sets the summary counts. The difference is not
   * theoretical:
   *
   * - `summary.unacknowledged` excludes General communications (M11-02) and `acknowledged` does
   *   not, so a board narrowed on `acknowledged=false` showed a meeting notice under a figure
   *   that had deliberately stopped counting it. **Phase 0a created that gap and nothing caught
   *   it** — `districtKeys.e2e.test.ts` asserts set *membership* (every row shown carries the
   *   flag) and stays green while the number beside it counts a different set.
   * - `summary.unassessed` is counted over live incidents only, while `assessed` is true of a
   *   closed one too — so *"not yet assessed"* on the `?closed=1` view would have led to rows
   *   that were dealt with yesterday.
   *
   * Both are decided here for the same reason every flag above is, and `buildBoard` now folds
   * **the summary out of these rows** rather than counting a second set beside them. The number
   * and the rows are then one set by construction, which is stronger than two predicates that
   * happen to agree today.
   */
  readonly unacknowledged: boolean;
  readonly unassessed: boolean;
}

/**
 * One narrowing the board offers, with the count it will land on.
 *
 * ## The shape is the whole point — M11-16
 *
 * A facet does **not** send a name for the client to interpret. It sends the **`data-` attribute
 * the server already wrote onto the row**, the value to compare, and how to compare it. So the
 * browser holds no predicate of its own: it reads the attribute this object names and shows the
 * rows that match. The count and the rows it lands on are the same set **by construction**,
 * which is the property this whole milestone has been buying back one screen at a time — the
 * strip (M11-06/07), the dashboard's counters (`districtKeys.e2e`), and now the panel.
 *
 * Written any other way — `severity: { high: 4 }` and a browser that works out what *high* means
 * — this would be a second implementation of every rule the fold already applied, and the first
 * one to drift would put a 4 above three rows.
 */
export interface BoardFacet {
  /** The `data-` attribute, in `dataset` form. Never a predicate the client derives. */
  readonly attr: string;
  readonly value: string;
  /** What a person reads. Never parsed, never matched on. */
  readonly label: string;
  readonly count: number;
  /**
   * `is` — the attribute equals `value`.
   * `has` — the attribute is a ``-separated list and `value` is one of its members.
   *
   * The second exists because **an incident can be answered by more than one department**, and
   * that is not an edge case: it is what the district's routing signals produce for a bazaar
   * fire. It is also why the department counts below do not sum to the board.
   */
  readonly match: 'is' | 'has';
}

/**
 * The four questions a control room narrows by, each folded from the rows that were sent.
 *
 * **Severity and stage are fixed vocabularies and are always present, including at zero** — the
 * board's own strip already works this way, and for the reason ADR-0005 gives: on a screen
 * somebody reads at 02:00, *"critical 0"* and the absence of the word *critical* are two
 * different statements, and only one of them is an answer.
 *
 * **Kind is an open set, so only what is on the board appears.** ⚠️ There was a fourth facet,
 * `department`, folded from `responsibleDepartments`. It is gone — [ADR-0031](../../docs/adr/ADR-0031-no-department-vocabulary.md)
 * phase 4 — along with the `department` sort: migration 0039 leaves that list empty on every
 * row, and "department" is not a word this product narrows or orders by any more.
 */
export interface BoardFacets {
  /** ⚠️ Assessed severities only. *Not assessed* is beside them and is not one of them. */
  readonly severity: readonly BoardFacet[];
  /**
   * **Its own entry, never folded into a severity — ADR-0009.**
   *
   * *Nobody has assessed this* is not a mild severity, it is the absence of one, and a panel
   * that sorted it between `low` and `moderate` would be answering a question nobody asked with
   * a number that means something else.
   */
  readonly unassessed: BoardFacet;
  readonly kind: readonly BoardFacet[];
  readonly stage: readonly BoardFacet[];
}

export interface Board {
  /** Server time when this was folded. A client showing it without this is guessing. */
  readonly asOf: Instant;
  /**
   * **Which district day this board is showing** — ADR-0020.
   *
   * Always present, and the screen must always show it, not only when it is not today. A date
   * that appears sometimes is a date people stop looking for, and the whole hazard this decision
   * accepts is somebody reading one day's board as though it were the current state of Bajaur.
   *
   * `null` only for the export, which asks for a span rather than a day.
   */
  readonly date: string | null;
  /**
   * The exact interactive-history window, chosen by the server in the district's timezone.
   *
   * The Record's date picker reads this rather than deciding two years from the handset clock.
   * That keeps an operator from choosing a day the server cannot honestly answer.
   */
  readonly recordWindow: {
    readonly from: string;
    readonly to: string;
  };
  /**
   * The source selection overflowed the Record's working limit.
   *
   * Optional because `projectIncidents` is also used by Search, which has its own explicit
   * truncation contract. The Record route always sends this field.
   */
  readonly truncated?: boolean;
  readonly summary: {
    readonly open: number;
    readonly unacknowledged: number;
    /**
     * **How many are at `Issued` — the district's own first word (M9-25).**
     *
     * Added 2026-08-18 so the board's strip can speak the same four words as the wall. It is
     * **not** `unacknowledged` renamed, and the difference is exactly why this exists rather than
     * a relabelling: `unacknowledged` deliberately excludes a General communication (M11-02,
     * because a notice owes nobody an answer), while a stage is a fact about **every** incident —
     * a meeting notice that has gone out and had no reply *is* issued, and its own row says
     * *"sent · no answer needed"* beside it. Labelling the narrower figure `Issued` while the wall
     * counts the wider one would be M11-06's defect rebuilt: one word, two numbers, two screens.
     *
     * Folded from `r.stage`, the value the row carries and the header displays, so the figure and
     * the rows it narrows to are one set by construction.
     */
    readonly issued: number;
    readonly overdue: number;
    /** The worst severity anyone actually assessed. */
    readonly worst: AssessedSeverity | null;
    /** How many nobody has assessed. Never folded into `worst` (ADR-0009). */
    readonly unassessed: number;
    /**
     * Incidents where somebody was supposed to be told and demonstrably was not.
     *
     * INV-03 in one number, on the board, where the invariant says it must be — *an unmet
     * obligation, not a log line*.
     */
    readonly notificationsUnmet: number;
    /**
     * Emergencies the routing signals could not place. Nobody has them.
     *
     * On the summary rather than only in the rows, because this is the number the two
     * administrative offices are answerable for: every one of them is an emergency waiting
     * on a human, and every one of them is also a signal somebody forgot to configure.
     */
    readonly unassigned: number;
    /**
     * **How many left the board today** — M10-40, and it is what makes the rest safe.
     *
     * Nothing may leave this screen in silence. An operator who withdraws the wrong row, or
     * withdraws three because the first did not seem to work, has to be able to see it happen
     * — and so does whoever walks in afterwards. It is counted over the same rows the board
     * selected, before they were dropped, so it can never disagree with what was removed.
     *
     * Zero is not rendered (`web/src/main.ts`): a permanent "0 withdrawn" is a line people
     * stop reading, and then it is not there on the morning it says four.
     */
    readonly withdrawn: number;
    /**
     * Live emergencies nobody has been told about — M6-09.
     *
     * The number that measures whether the paper register is actually gone. `unassigned` says
     * the signals could not place it; `notificationsUnmet` says a message failed. **This one
     * says no message was ever owed**, because nobody chose a recipient — which, before M6,
     * was every single incident.
     */
    readonly nobodyTold: number;
  };
  /**
   * What the board can be narrowed by, counted in the same fold that produced the rows — M11-16.
   *
   * Not a second query and not a second definition: `buildBoard` folds these from the very array
   * it is about to send, so a facet reading 4 is four of the rows in `incidents` below.
   */
  readonly facets: BoardFacets;
  readonly incidents: readonly BoardRow[];
}

const CLOSED: ReadonlySet<IncidentState['status']> = new Set(['closed', 'resolved']);

/** How many incident groups one live Record view may fold before it has to say it is incomplete. */
export const BOARD_LIMIT = 500;

/**
 * Order for a work queue, which is not the same thing as a rank for an aggregate.
 *
 * ADR-0009 forbids giving `unknown` a rank *in aggregation*, because both available answers
 * lie about what the district's severity is. A queue is a different question — "what should
 * a human look at first?" — and there it has an honest answer: **immediately after
 * critical.** A report nobody has assessed could be anything, including worse than the
 * `high` beneath it, so it does not wait behind assessed work. It is still labelled
 * `unassessed` in every row; it is ordered, never relabelled.
 */
function attentionRank(row: BoardRow): number {
  if (!row.assessed) return severityRank('critical') - 0.5;
  return severityRank(row.severity as AssessedSeverity);
}

function compareRows(a: BoardRow, b: BoardRow): number {
  // Work to do, before work already picked up. Option C: a wide dispatch every office declined
  // has an `acknowledgedAt` (the first tap filled it) and is still nobody's — it ranks with the
  // unacknowledged, not with the handled. `takenBy != null` (`!ownerless` with a filled slot)
  // is what lets a row recede.
  const ackA = a.acknowledgedAt === null || a.ownerless ? 0 : 1;
  const ackB = b.acknowledgedAt === null || b.ownerless ? 0 : 1;
  if (ackA !== ackB) return ackA - ackB;

  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;

  const rankA = attentionRank(a);
  const rankB = attentionRank(b);
  if (rankA !== rankB) return rankB - rankA;

  // Two notices that asked who is coming: the one with more people still to answer is the one
  // the control room chases, so it sorts first. Only between gatherings — an emergency's order
  // is decided entirely above.
  if (a.attendance !== null && b.attendance !== null) {
    if (a.attendance.unanswered !== b.attendance.unanswered) {
      return b.attendance.unanswered - a.attendance.unanswered;
    }
  }

  // Oldest first. The same reason the escalation scan is oldest-first: without it, whichever
  // incident keeps losing the ordering lottery is the one that gets forgotten.
  return (a.occurredAt ?? '') < (b.occurredAt ?? '') ? -1 : 1;
}

/**
 * **The orders the board's column headers offer — M11-11, and they are decided HERE.**
 *
 * ⚠️ **A comparator in the browser would be a second ordering rule beside `compareRows`**, and
 * the drift would be silent and specifically harmful: `attentionRank`'s whole reasoning is that
 * an **unassessed** report sorts *just above* `critical`, because it could be anything. That is
 * a domain decision (ADR-0009) written in one function; a client sorting on `severity` would
 * reimplement it from the row's own words and put the report nobody has looked at at the bottom
 * of the queue, under a heading claiming to be sorted by severity. The screen would look correct.
 *
 * Every one of these **falls back to `compareRows`**, so the order is total and deterministic:
 * ties are broken by the queue's own answer rather than by whatever order the fold happened to
 * produce. Two boards asked the same question give the same answer, which is the same property
 * ADR-0008 requires of the event comparator and for the same reason.
 */
export const BOARD_SORTS = [
  'attention',
  'age',
  'severity',
  'deadline',
  'stage',
  'recorded',
] as const;

export type BoardSort = (typeof BOARD_SORTS)[number];

/** `age`, or `-age` for the other direction. `null` for anything this does not offer. */
export function parseSort(raw: string | null): { key: BoardSort; desc: boolean } | null {
  if (raw === null || raw === '') return { key: 'attention', desc: false };
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  return (BOARD_SORTS as readonly string[]).includes(key) ? { key: key as BoardSort, desc } : null;
}

function sorterFor(key: BoardSort): (a: BoardRow, b: BoardRow) => number {
  switch (key) {
    case 'attention':
      return compareRows;
    /**
     * Oldest first, and an incident with no stated time sorts last rather than first: a missing
     * instant is not the beginning of time, and treating it as one would put every report whose
     * `occurredAt` nobody captured at the top of a queue sorted by age.
     *
     * 🔴 **This must return 0 for equal instants, and the first version did not** — it was written
     * as `a < b ? -1 : 1`, copied from `compareRows`'s own last line, where that shape is correct
     * because it is the final total tie-break. Here it is the **primary** comparator, so never
     * returning 0 meant the `compareRows` fallback below was unreachable *and* the comparator was
     * inconsistent (`cmp(a,b)` and `cmp(b,a)` both `1` when equal), which lets `Array.sort`
     * produce an arbitrary order. The board came back sorted by nothing in particular with
     * **`AGE ↑` printed above it** — the exact lie `paintSortState` is written to prevent,
     * arriving from underneath it. Found by looking at the rendered board, not by a test.
     */
    case 'age':
      return (a, b) => {
        const at = a.occurredAt ?? '9999';
        const bt = b.occurredAt ?? '9999';
        return at < bt ? -1 : at > bt ? 1 : 0;
      };
    /**
     * Oldest into the record first — so `-recorded` opens the Record on the most recently
     * entered incident (2026-09-06, the owner's call). Same shape as `age`, including the
     * `=== 0` case that keeps the `compareRows` tie-break reachable; the difference is the
     * field — arrival, not occurrence, so a report filed now about last night still leads.
     * `arrivedAt` is set from a `reported` event, which every incident has, so the `'9999'`
     * fallback is only ever exercised by a malformed fold.
     */
    case 'recorded':
      return (a, b) => {
        const at = a.arrivedAt ?? '9999';
        const bt = b.arrivedAt ?? '9999';
        return at < bt ? -1 : at > bt ? 1 : 0;
      };
    // Worst first, through `attentionRank` — so `unassessed` keeps its place just above
    // `critical` here too. One rule, read by both orders.
    case 'severity':
      return (a, b) => attentionRank(b) - attentionRank(a);
    // Most overdue first. `overdueByMinutes` is 0 on anything not overdue, so the rows an
    // operator is chasing come to the top and the rest keep the queue's own order beneath them.
    case 'deadline':
      return (a, b) => b.overdueByMinutes - a.overdueByMinutes;
    /**
     * Earliest stage first — issued before resolved, which is the direction work moves.
     *
     * Ordered on `row.stage`, the value the row **carries and the header displays**, rather than
     * re-deriving it from `status`. `stages.ts`'s own header says nothing is stored and there
     * must be no second place the mapping lives; a sort that walked `status` again could order a
     * board differently from the words printed on it.
     */
    case 'stage':
      return (a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage);
  }
}

function sortRows(rows: BoardRow[], sort: { key: BoardSort; desc: boolean }): BoardRow[] {
  if (sort.key === 'attention' && !sort.desc) return rows.sort(compareRows);
  const primary = sorterFor(sort.key);
  return rows.sort((a, b) => {
    const first = primary(a, b);
    if (first !== 0) return sort.desc ? -first : first;
    // The queue's own answer breaks every tie, in its own direction always. Reversing the
    // tie-break with the column would make "sort by stage, descending" quietly reorder work
    // *within* a stage as well, which is not what the header says it does.
    return compareRows(a, b);
  });
}

export interface BoardOptions {
  readonly now?: Instant;
  readonly targets?: SlaTargets;
  readonly days?: number;
  readonly limit?: number;
  /** Include resolved and closed incidents. The board defaults to live work only. */
  readonly includeClosed?: boolean;
  /**
   * Drop the rows somebody took off the board — M10-13.
   *
   * ⚠️ **Opt OUT, not opt in, and the default is chosen to fail in the visible direction.**
   * The board passes `true`; search, the export and the daily report pass nothing and keep
   * every withdrawn row (M10-15). A caller who forgets shows a row that should have gone —
   * mildly wrong, and obvious on the screen. The other default loses an emergency from the
   * record's own surfaces, silently, which is the failure this whole phase is written around.
   */
  readonly hideWithdrawn?: boolean;
  /**
   * **The district day this board shows** — `YYYY-MM-DD`, ADR-0020.
   *
   * Set by the board route and defaulted to today there rather than here, so that the one caller
   * that genuinely wants a span — the export — cannot acquire a day by forgetting to pass one.
   *
   * When absent, selection is the old recency window (`days`), which is what the export needs: an
   * emergency captured offline in March and delivered in August belongs to March, and a period
   * report asks a different question from a working screen.
   */
  readonly date?: string;
  /**
   * **Which column the board is ordered by — M11-11.** Absent is the queue's own order.
   *
   * Only the board route passes this. Search, the export and the daily report deliberately do
   * not: an ordering an operator chose for a screen is not a property of a file somebody emails
   * onward, and a report whose row order depends on what was clicked before it was generated is
   * one two people can compare and disagree about.
   */
  readonly sort?: { readonly key: BoardSort; readonly desc: boolean };
}

/**
 * Name every person, post and department the shown rows were dispatched to — one pass, two queries.
 *
 * ## Why this is not `actorsFor`
 *
 * `lifecycle.ts` has a lookup that looks almost identical and answers a different question: it
 * names the **actors on the events** — who did things — from `actorPersonId` / `actorSeatId`. This
 * names the **addressees**, which come off `state.dispatchedTo`, and on this district those are
 * mostly people who never touched the incident at all. Reusing that one would have named the
 * control room forty times and no recipient once.
 *
 * ## Why it is batched
 *
 * Two queries for the whole board, keyed `kind:id` the way `dispatchedTo` already keys itself.
 * The board is the screen the control room leaves open all night on a ten-second poll, so a query
 * per row is forty round trips every ten seconds for a screen that is usually not being read.
 *
 * Departments come from the directory the caller already loaded — a third query for names that
 * are already in hand is the kind of thing this file exists not to do.
 */
export async function dispatchNames(
  pool: Pool,
  /**
   * The targets themselves, deliberately not the states they came off.
   *
   * ADR-0029 gave this a second caller: the dashboard's *Open by officer* panel folds the same
   * `dispatchedTo` in a loop that has already computed its states, and handing this the states
   * again would mean folding every incident twice on the one screen a room reads all day.
   * Taking the targets is also honest about what it reads — it never touched anything else on
   * a state.
   */
  targets: readonly DispatchTarget[],
  departments: Readonly<Record<string, { readonly name: string }>>,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  const personIds = new Set<string>();
  const seatIds = new Set<string>();

  for (const target of targets) {
    if (target.kind === 'person') personIds.add(target.id);
    // A `post` IS a `seat` row — the district's word and the table's word for one thing
    // (ADR-0004). The key keeps the district's word so it matches `dispatchedTo` directly.
    else if (target.kind === 'post') seatIds.add(target.id);
    else {
      const name = departments[target.id]?.name;
      if (name !== undefined) names.set(`department:${target.id}`, name);
    }
  }

  if (personIds.size > 0) {
    /**
     * **Name AND designation — `Rustam Khan — DDMA`, the district's own shape**
     * (`backlog/whatsapp-response-workflow.md` §6, asked for 2026-08-23).
     *
     * The designation is the post the officer has held longest — `dutySeatOfPerson`'s rule
     * (three people in Bajaur's live directory hold two posts at once, M10-05), batched here as
     * a correlated subquery so the whole board is still one round trip. A retired post is not a
     * designation anybody can act on and is excluded, matching that function. A named officer
     * who genuinely holds no live post is named alone — there is nothing to append.
     *
     * Both branches compose. The district picks a **person** or a **post** in the picker (and a
     * learned proposal is usually a post), and either way the "who was told" list is answering
     * one question — *which human was reached* — so a `post` recipient reads `Imtiaz Ahmad —
     * IT Soft`, its holder then its title, exactly as a `person` reads their name then the post
     * they hold. A vacant post keeps its title alone (ADR-0004: it must still be visible).
     */
    const res = await pool.query<{
      person_id: string;
      full_name: string;
      designation: string | null;
    }>(
      `SELECT p.person_id,
              p.full_name,
              (SELECT s.title
                 FROM duty_assignment d
                 JOIN seat s ON s.seat_id = d.seat_id
                WHERE d.person_id = p.person_id
                  AND d.to_at IS NULL
                  AND s.retired_at IS NULL
                ORDER BY d.from_at ASC
                LIMIT 1) AS designation
         FROM person p
        WHERE p.person_id = ANY($1::uuid[])`,
      [[...personIds]],
    );
    for (const row of res.rows) {
      names.set(`person:${row.person_id}`, withDesignation(row.full_name, row.designation));
    }
  }

  if (seatIds.size > 0) {
    // The holder now, if the post has one — `duty_one_current_holder_per_seat` guarantees at
    // most one open assignment, so no ordering is needed. A removed person is not a holder.
    const res = await pool.query<{ seat_id: string; title: string; holder: string | null }>(
      `SELECT s.seat_id,
              s.title,
              (SELECT p.full_name
                 FROM duty_assignment d
                 JOIN person p ON p.person_id = d.person_id
                WHERE d.seat_id = s.seat_id
                  AND d.to_at IS NULL
                  AND p.removed_at IS NULL
                LIMIT 1) AS holder
         FROM seat s
        WHERE s.seat_id = ANY($1::uuid[])`,
      [[...seatIds]],
    );
    for (const row of res.rows) {
      names.set(
        `post:${row.seat_id}`,
        row.holder !== null ? withDesignation(row.holder, row.title) : row.title,
      );
    }
  }

  return names;
}

function toRow(
  state: IncidentState,
  now: Instant,
  config: SlaConfig,
  departments: Readonly<Record<string, { readonly name: string }>>,
  /**
   * Names for the things the control room dispatched to — people, posts and departments.
   *
   * Built once for the whole board rather than per row (see `dispatchNames`), because a row is
   * not allowed to make its own query: forty rows each naming their own recipients is forty
   * round trips on the screen the control room leaves open all night.
   */
  told: ReadonlyMap<string, string>,
  /**
   * The district's numbers, fetched once for the whole board — the same rule `told` above
   * follows, and for the same reason: a row is not allowed to make its own query.
   */
  references: ReadonlyMap<string, number>,
  /**
   * The saved groups this incident's dispatches expanded — Case 3, read off the events in
   * `projectIncidents` because `IncidentState` deliberately carries no group entity. `[]` for
   * every incident dispatched only by hand; the row's response breakdown then reads flat.
   */
  groups: readonly DispatchGroup[] = [],
): BoardRow {
  const severity: Severity = state.severity?.value ?? 'unknown';
  // Whether this row is one of the ones the district's own figures are counted over — M11-06.
  const onBoard = !CLOSED.has(state.status) && state.withdrawnAt === null;
  // Resolved per row, because the deadline belongs to whoever is holding the incident.
  // Rescue's five minutes are not the Education department's five minutes.
  const targets = targetsFor(config, state.responsibleDepartmentIds);
  const unmet = unmetObligations(state.notifications, now);

  /**
   * Who is actually holding this, off the officers own words — RX-02.
   *
   * Computed here beside `unmet` because the two are the pair an operator reads together: one is
   * *somebody was owed a message and did not get it*, the other is *they got it, they answered,
   * and every one of them said no*. Neither is the other, and a board that showed only the first
   * is the board that read `4/4 acknowledged` over a fire nobody was going to.
   */
  const owned = ownershipOf(state.notifications);

  /**
   * Where this has reached — Issued / Responded / Resolved. Option C: a live wide dispatch every
   * office declined does not read `Responded`, even though `domain/incident.ts` drives the
   * status to `responding` on any inbound reply. The same read `api/dashboard.ts` and
   * `domain/dailyReport.ts` make, so the board column, the wall tile and the morning report
   * agree about the same night. Gatherings keep their own stage.
   */
  const rawStage = stageOf(state.status);
  const stage: Stage =
    !CLOSED.has(state.status) &&
    owned.ownerless &&
    !isGathering(state.kind) &&
    rawStage === 'responded'
      ? 'issued'
      : rawStage;

  /**
   * **The officers' own answers, resolved to names — the Record's "Response", 2026-08-31.**
   *
   * The aggregate is `owned`'s, unchanged: one rule decides who is holding an emergency. What
   * this adds is the human-readable half — the latest reply verbatim, and a per-recipient line
   * for the row's disclosure — resolved through `told`, the dispatch directory already built
   * once for the whole board (a row is not allowed to make its own query).
   */
  const nameOfAttempt = (a: {
    readonly personId?: string;
    readonly seatId: string | null;
    readonly departmentId?: string;
  }): string | null =>
    a.personId !== undefined
      ? (told.get(`person:${a.personId}`) ?? null)
      : a.seatId !== null
        ? (told.get(`post:${a.seatId}`) ?? null)
        : a.departmentId !== undefined
          ? (told.get(`department:${a.departmentId}`) ?? null)
          : null;

  // The most recent reply an officer typed, in the fold's order — the same "latest wins" rule
  // `sentMessage` follows one field over. An acknowledgement tap carries no `said`, so this is
  // the words and not the gesture.
  const latestReply = [...state.notifications]
    .reverse()
    .find((n) => n.reason === 'dispatched' && n.said !== undefined);

  /**
   * The group each `owned` row came from, if any — Case 3. `groupRecipients` does the matching
   * (member key, or the surviving key of a member the collapse absorbed); this flattens its
   * blocks to a `key -> group name` lookup the `breakdown` map reads. `null` everywhere when no
   * dispatch used a group.
   */
  const ownKey = (a: {
    readonly personId?: string;
    readonly seatId: string | null;
    readonly departmentId?: string;
  }): string =>
    a.personId !== undefined
      ? `person:${a.personId}`
      : a.seatId !== null
        ? `post:${a.seatId}`
        : a.departmentId !== undefined
          ? `department:${a.departmentId}`
          : 'unkeyed';
  const groupNameByKey = new Map<string, string>();
  {
    const grouped = groupRecipients(
      groups,
      owned.rows,
      ownKey,
      absorbedKeys(state.dispatchAbsorbed),
    );
    if (grouped !== null) {
      for (const block of grouped.blocks) {
        for (const row of block.rows) groupNameByKey.set(ownKey(row), block.group.name);
      }
    }
  }

  const response: BoardRow['response'] =
    owned.told === 0
      ? null
      : {
          told: owned.told,
          holding: owned.holding,
          declined: owned.declined,
          silent: owned.silent,
          ownerless: owned.ownerless,
          latest:
            latestReply?.said === undefined
              ? null
              : {
                  who: nameOfAttempt(latestReply),
                  said: latestReply.said,
                  at: latestReply.settledAt ?? null,
                },
          respondedAt: owned.respondedAt,
          breakdown: owned.rows.map((r) => ({
            who: nameOfAttempt(r),
            holding: r.holding,
            said: r.said ?? null,
            group: groupNameByKey.get(ownKey(r)) ?? null,
          })),
        };

  /**
   * Who is coming — null unless this row is a notice that asked who is coming. Same three inputs
   * the drawer and the wall pass: the count restarts from `rescheduledAt`, closes at
   * `attendanceClosesAt` from when the notice went out, `invited` is per-message.
   */
  const askedAt = state.dispatchedAt ?? state.occurredAt;
  const tally = attendanceFor(state.kind, state.notifications, {
    rescheduledAt: state.rescheduledAt,
    closesAt: askedAt === null ? null : attendanceClosesAt(askedAt),
    invited: state.asksAttendance,
  });
  const attendance: BoardRow['attendance'] =
    tally === null
      ? null
      : {
          told: tally.told,
          coming: tally.coming,
          answered: tally.answered,
          attending: tally.attending,
          sendingSomeone: tally.sendingSomeone,
          notAttending: tally.notAttending,
          other: tally.other,
          unanswered: tally.unanswered,
        };

  /**
   * **A General communication has no deadline, so it is never overdue — M9-10.**
   *
   * `null` here is the same value an incident with no `occurredAt` produces, and it flows into
   * `overdue: false` below by the path that already existed. That is the whole change: no second
   * branch, no `overdue` special case, nothing for a later reader to find surprising.
   *
   * The decision is in `CARRIES_SLA`, beside the kinds themselves, rather than here — a screen
   * asking "is this overdue" and a job asking "should this escalate" must not be able to answer
   * from two different lists. `jobs/escalation.ts` reads the same set.
   */
  const verdict =
    state.occurredAt === null || state.lastRecordedAt === null || !CARRIES_SLA.has(state.kind)
      ? null
      : checkEscalation(
          {
            severity,
            occurredAt: state.occurredAt,
            recordedAt: state.lastRecordedAt,
            acknowledgedAt: state.acknowledgedAt,
            now,
          },
          targets,
        );

  const seq = references.get(state.incidentId);

  return {
    incidentId: state.incidentId,
    // Absent, not zero. Nothing was ever numbered 0, and a row reading a missing number as one
    // would print `DNC-BAJAUR-0` on a screen the district quotes from.
    reference: seq === undefined ? null : formatReference(seq),
    status: state.status,
    stage,
    kind: state.kind,
    general: isGeneral(state.kind),
    corrected: state.correctedAt !== null,
    correctionReason: state.correctionReason,
    withdrawn: state.withdrawnAt !== null,
    withdrawalReason: state.withdrawalReason,
    severity,
    assessed: isAssessed(severity),
    overriddenFrom: state.severity?.overriddenFrom?.value ?? null,
    category: state.category?.value ?? 'unknown',
    responsibleDepartmentIds: state.responsibleDepartmentIds,
    // An id with no matching row is shown as an id rather than hidden. A department that
    // vanished from the registry is a real problem, and a blank column would conceal it.
    /**
     * ⚠️ **AN ID NOBODY CAN NAME IS DROPPED, NOT PRINTED — ADR-0030.**
     *
     * `?? id` was right while a registry existed: a department missing from it was a real
     * configuration fault, and the id surfaced it. Migration 0039 dropped the table, so every
     * historical id is unnameable and this fell back to thirty-six characters of hexadecimal —
     * on the screens ADR-0027 exists to have taken exactly that off. `performance.ts` and
     * `domain/dailyReport.ts` drop it for the same reason, and the three must agree.
     */
    responsibleDepartments: state.responsibleDepartmentIds.flatMap((id) => {
      const name = departments[id]?.name;
      return name === undefined ? [] : [name];
    }),
    /**
     * The order the control room chose them in, kept. An operator who picked Rescue first reads
     * Rescue first, and a set re-sorted alphabetically would quietly change which name the row
     * shows when it only has room for one.
     *
     * A target with no name left is dropped rather than shown as a uuid: `dispatchedTo` survives
     * an officer being removed from the roster, and *"told 3"* over a row naming two of them is
     * a truthful shortfall, while a raw id on the wall is not a name at all.
     */
    toldNames: state.dispatchedTo
      .map((t) => told.get(`${t.kind}:${t.id}`))
      .filter((name): name is string => name !== undefined),
    /**
     * Only once it is actually resolved. `state.resolution` is set by the `resolved` event and
     * is null before it, so this is the fold's own answer rather than a second rule about which
     * statuses count as finished.
     */
    resolution: state.resolution,
    /**
     * Latest wins — `notifications` is ordered by the fold, so the last one carrying words is
     * the most recent thing the district said. `?? null` rather than leaving it absent, because
     * absent and null read the same on the wire and null is the one the row is written against.
     */
    sentMessage: [...state.notifications].reverse().find((n) => n.sent !== undefined)?.sent ?? null,
    followUp:
      state.followUps.length === 0
        ? null
        : {
            // The latest chase is the one describing the current situation.
            note: state.followUps[state.followUps.length - 1]?.note ?? '',
            count: state.followUps.length,
            // ANY, not the latest — see the field's note. A number that could not be reached
            // stays a fact somebody has to fix even if the next attempt happened to go.
            failed: state.followUps.some((f) => !f.delivered),
          },
    occurredAt: state.occurredAt,
    arrivedAt: state.arrivedAt,
    lastRecordedAt: state.lastRecordedAt,
    acknowledgedAt: state.acknowledgedAt,
    escalationCount: state.escalationCount,
    overdue: state.acknowledgedAt === null && (verdict?.shouldEscalate ?? false),
    overdueByMinutes: Math.round(verdict?.overdueByMinutes ?? 0),
    notificationsFailed: unmet.filter((u) => u.why === 'failed').length,
    // The most specific reason, in words — not a count. See `whyUnmetReads`.
    ...(whyUnmetReads(unmet) === null ? {} : { notificationsWhy: whyUnmetReads(unmet)! }),
    notificationsUndelivered: unmet.filter((u) => u.why === 'undelivered').length,
    unassigned: state.unassigned,
    targetMinutes: targets[severity],

    /**
     * The flags the dashboard's counters lead through. Same predicates the counters use, on
     * the same fold, in the same pass — see the note on `BoardRow`.
     *
     * `held` is "some department has this", which is **not** the negation of `unassigned`:
     * that one means routing ran and matched nobody, while an incident nobody has routed yet
     * is also held by nobody and has not failed at anything (ADR-0010). The counter asks the
     * first question, so this answers the first question.
     */
    held: state.responsibleDepartmentIds.length > 0,
    acknowledged: state.acknowledgedAt !== null,
    occurredToday: state.occurredAt !== null && state.occurredAt >= startOfDay(now),
    notificationsUnmet: unmet.length > 0,
    nobodyTold: state.dispatchedTo.length === 0,
    attendance,
    ownerless: owned.ownerless,
    declined: owned.declined,
    response,

    /**
     * The two the summary is folded from — M11-06. See the note on `BoardRow`.
     *
     * `onBoard` is the same three-part test `buildBoard` uses to pick `live`: not closed, not
     * withdrawn. It is written here rather than left to the caller because a row must be able to
     * answer *"are you one of the ones counted?"* on its own — that is the whole property, and a
     * caller that has to remember to intersect two sets is a caller that will forget.
     */
    unacknowledged: onBoard && !isGeneral(state.kind) && state.acknowledgedAt === null,
    unassessed: onBoard && !isGeneral(state.kind) && !isAssessed(severity),
  };
}

/**
 * Midnight in **Bajaur**, as an ISO instant — M9-02.
 *
 * The district's day is the day in the DC office. A client deciding this for itself would ask
 * a different question on a handset whose clock is set elsewhere, and "reported today" would
 * mean two things at once.
 *
 * **Exported because the dashboard's counter must mean the same thing this flag means**, and
 * for four days it did not: `districtSummary` had its own midnight built with `setUTCHours`
 * while this one used `setHours`. One function, one answer; see the note in `dashboard.ts`.
 *
 * **That fix was half a fix, and this is the other half.** `setHours` reads the *machine's*
 * zone, on the reasoning that the server sits in the DC office. ADR-0019 then moved the
 * application to Hetzner Helsinki, where `installer/cloud/setup.sh` never sets a timezone and
 * Ubuntu defaults to UTC — confirmed on the running server, 2026-08-13. So the district's day
 * had been starting at 05:00 Bajaur time, and this flag was wrong every night between midnight
 * and dawn on the one machine it actually runs on.
 *
 * It now delegates to `domain/districtTime.ts`, which names the zone as data and reads nothing
 * from the machine. Kept as a named export here so every existing call site and test keeps
 * working, and because "the board's midnight" is the concept the rest of this file talks about.
 */
export function startOfDay(now: Instant): Instant {
  return startOfDistrictDay(now);
}

/**
 * The district's deadlines, from the table the administration edits (Q-06).
 *
 * The failure path is the interesting part. If `sla_target` cannot be read, this falls back
 * to `PLACEHOLDER_SLA` and **says so at error level** rather than throwing. The reasoning:
 * a board that will not draw because a settings table is unreachable is a control room with
 * no screen during the exact incident that broke the database — while a board drawn against
 * last week's defaults is still every incident, every severity, every overdue flag, off only
 * in the deadline numbers. The one thing that would make that unacceptable is doing it
 * quietly, so it does not.
 */
async function slaConfig(pool: Pool, override?: SlaTargets): Promise<SlaConfig> {
  if (override !== undefined) return { district: override, byDepartment: {} };

  try {
    return await loadSlaConfiguration(pool);
  } catch (err) {
    log('error', 'could not read SLA configuration; falling back to install defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { district: PLACEHOLDER_SLA, byDepartment: {} };
  }
}

/**
 * Build the board one seat is entitled to see.
 *
 * The department board (M0-34) is this same function with the same arguments — the scoping
 * falls out of the seat, not out of a second endpoint with a second query that would
 * eventually disagree with this one.
 */
export async function buildBoard(
  pool: Pool,
  seat: Seat,
  options: BoardOptions = {},
): Promise<Board> {
  /**
   * **How far back to read in order to show one day** — ADR-0020.
   *
   * `loadRecentIncidents` counts back in whole days from *now*, so asking for a day that is not
   * today needs a window that reaches past it. `api/dailyReport.ts` solved this first and its
   * reasoning is copied deliberately rather than reinvented: the number of days between the
   * requested date and today, **plus two**, because a window short by an hour at the boundary is
   * silently wrong on exactly the incidents most likely to matter.
   *
   * The selection is by *arrival*; the day filter below is by `occurredAt`. Both are needed — the
   * first is what the query can do cheaply, the second is what the district means by "today".
   */
  const now = options.now ?? new Date().toISOString();
  const days =
    options.date === undefined
      ? (options.days ?? 7)
      : (recordLookbackDays(options.date, now) ?? options.days ?? 7);

  /**
   * Read one more group than we can show. A full queue and an overflowing queue look identical
   * without this extra row, and silently dropping an older open emergency is worse than showing
   * a plainly incomplete view.
   */
  const limit = Math.max(1, options.limit ?? BOARD_LIMIT);
  const grouped = await loadRecentIncidents(pool, days, limit + 1);
  const truncated = grouped.length > limit;
  /**
   * **The board is the one surface that hides a withdrawn row** — M10-13.
   *
   * Set here rather than at the route, so the department board (M0-34) — which is this same
   * function — cannot end up with a different answer. Search and the export call
   * `projectIncidents` directly and keep every row (M10-15).
   *
   * A caller may still ask for them back: `hideWithdrawn: false` in `options` wins, because
   * the spread is second. That is the "way back" this task asked for at the data layer, and
   * `?withdrawn=1` on the route is the one an operator uses.
   */
  const board = await projectIncidents(pool, seat, truncated ? grouped.slice(0, limit) : grouped, {
    hideWithdrawn: true,
    ...options,
  });
  return { ...board, truncated };
}

/**
 * Does this incident belong to one district day? — ADR-0020, amended 2026-08-19.
 *
 * **Exported because the dashboard asks the same question**, and the last time these two screens
 * each answered it in their own words the result was a five-hour disagreement about when the
 * district's day begins. There is one rule and this is it; a second copy is the defect, not the
 * duplication.
 *
 * **Two ways in, and the second one is not a convenience.**
 *
 * *It happened that day* — `occurredAt` — is the obvious one, and it is the only rule the daily
 * report uses, correctly: a report captured offline in a village overnight is a fact about the
 * night it happened, and filing it under the morning it synced would make the district's own
 * record wrong (ADR-0002).
 *
 * *It first arrived that day* is the other, and without it the offline story breaks on the board.
 * An emergency that happened at 23:40 in a village with no signal and reached the server at 06:10
 * would be filed under **yesterday**, on a board nobody is looking at, while the fire is still
 * burning. **It is yesterday's fact and today's work**, and those are different questions. So it
 * shows on today's board and in yesterday's report, and neither of them is lying.
 *
 * **What deliberately does NOT bring an incident back:** anything else happening to it later. An
 * acknowledgement, an action, a correction on a three-day-old incident does not return it to
 * today's board. That is the reset the district asked for, and widening this to *"any event
 * today"* would quietly undo it.
 */
export function belongsToDay(
  state: IncidentState,
  events: readonly IncidentEvent[],
  bounds: { readonly from: Instant; readonly to: Instant },
  now: Instant,
): boolean {
  const at = state.occurredAt;
  if (at !== null && at >= bounds.from && at <= bounds.to) return true;

  // The first event is the incident's arrival. `loadRecentIncidents` returns each group in
  // causal order (ADR-0008), so this is the earliest, not merely the first one read.
  const arrived = events[0]?.recordedAt;
  if (arrived === undefined) return false;
  if (arrived < bounds.from || arrived > bounds.to) return false;

  /**
   * One guard on the arrival rule: it applies to a day that has finished only if the incident
   * really arrived inside it. For **today**, `bounds.to` is tonight's midnight and therefore in
   * the future, which is exactly what we want — anything arriving later today is today's. The
   * comparison above already does that, and this line exists so the next reader does not "fix"
   * it into `arrived <= now`, which would make a board built at 09:00 disagree with the same
   * board built at 09:01.
   */
  void now;
  return true;
}

/**
 * Fold, scope, and project — **the half that must be identical on every surface.**
 *
 * Split out of `buildBoard` when search arrived. Search genuinely needs a different
 * *selection*: the board asks for the last seven days, search asks for whatever somebody is
 * looking for, and no single query serves both. What must not differ is everything after the
 * selection — the fold, `evaluateRead`, and `toRow` — because that is where a second
 * implementation would start quietly disagreeing with the screen about a district's own
 * emergencies.
 *
 * So the board, the export and search now share this and differ only in which incidents they
 * hand it. Any incident that appears on two of them says exactly the same thing on both.
 */
export async function projectIncidents(
  pool: Pool,
  seat: Seat,
  grouped: readonly (readonly IncidentEvent[])[],
  options: BoardOptions = {},
): Promise<Board> {
  const now = options.now ?? new Date().toISOString();
  const config = await slaConfig(pool, options.targets);

  // Fetched once for the whole board, not per row. Same reason the detail endpoint returns
  // an actor directory with the events: a screen should never have to ask twice.
  const departments = await departmentDirectory(pool);

  /**
   * **The day boundary, applied after the fold** — ADR-0020.
   *
   * It lives inside the shared function for one reason: the value it selects on, `occurredAt`,
   * **is produced by the fold**. Filtering before it would mean folding twice, and two folds is
   * how two surfaces begin quietly disagreeing about a district's own emergencies — the thing
   * this function was split out to prevent.
   *
   * It is still a **selection**, and it is gated by `options.date`. Search and the export never
   * pass one, so for them not a line of this executes.
   */
  const bounds =
    options.date === undefined
      ? null
      : (() => {
          const from = startOfNamedDistrictDay(options.date);
          const to = endOfNamedDistrictDay(options.date);
          return from === null || to === null ? null : { from, to };
        })();

  const visible: IncidentState[] = [];
  /**
   * The saved groups each incident's dispatches expanded — Case 3. Kept beside the fold rather
   * than on `IncidentState`, because `state` deliberately carries no group entity: this is a
   * display label the row's disclosure reads, computed here off the same events the fold sees.
   * Empty for every incident dispatched only by hand.
   */
  const groupsByIncident = new Map<string, readonly DispatchGroup[]>();
  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);

    if (bounds !== null && !belongsToDay(state, events, bounds, now)) continue;

    const readable = evaluateRead({
      seat,
      responsibleDepartmentIds: state.responsibleDepartmentIds,
    });
    if (!readable.allowed) continue;

    visible.push(state);
    const fromGroups = groupsFromEvents(events);
    if (fromGroups.length > 0) groupsByIncident.set(state.incidentId, fromGroups);
  }

  const withdrawn = visible.filter((s) => s.withdrawnAt !== null);
  const live = visible.filter((s) => !CLOSED.has(s.status) && s.withdrawnAt === null);
  const all =
    options.includeClosed === true ? visible : visible.filter((s) => !CLOSED.has(s.status));
  const shown = options.hideWithdrawn === true ? all.filter((s) => s.withdrawnAt === null) : all;

  // Ordered on the server, always — M11-11. The summary below is folded from these rows and is
  // order-independent, so a chosen column changes what an operator reads first and never what
  // the district's own figures say.
  const told = await dispatchNames(
    pool,
    shown.flatMap((s) => s.dispatchedTo),
    departments,
  );
  /**
   * The district's own numbers for the rows about to be sent — 2026-08-24.
   *
   * One query for the whole board, beside `dispatchNames` and for its reason. Fetched for the
   * rows that survived scoping rather than for everything folded: a seat that may not read an
   * incident must not learn its number either, and the cheapest way to guarantee that is never
   * to ask for it.
   */
  const references = await referencesFor(
    pool,
    shown.map((state) => state.incidentId),
  );

  const rows = sortRows(
    shown.map((s) =>
      toRow(
        s,
        now,
        config,
        departments,
        told,
        references,
        groupsByIncident.get(s.incidentId) ?? [],
      ),
    ),
    options.sort ?? { key: 'attention', desc: false },
  );
  const summary = districtSeverity(live);

  return {
    asOf: now,
    // Echoed back rather than assumed by the client: the screen must be able to say which day it
    // is showing without recomputing a midnight in the handset's own timezone (ADR-0020, and the
    // reason `occurredToday` is decided here too).
    date: options.date ?? null,
    recordWindow: recordDateRange(now),
    summary: {
      open: live.length,
      /**
       * **Emergencies only — M11-02, and `overdue` two lines down was already right.**
       *
       * *Unacknowledged* is a complaint: it says somebody owes an answer and has not given one.
       * A General communication owes none by decision (M9-02), and `incidentRow.ts` already
       * prints exactly that on the row — *"sent · no answer needed"*. Counting it here put a
       * figure directly above that row contradicting it, on one strip, on the screen a control
       * room reads at 02:00.
       *
       * `overdue` below never had the fault, and the reason is the fix: it is folded from
       * `toRow`, which puts every row through `CARRIES_SLA`. So a single meeting notice on an
       * otherwise empty board produced `1 unacknowledged · 0 past deadline` — one rule applied
       * in one of the two places that needed it, which is what made this look like polish and
       * not a defect.
       *
       * `open` above deliberately still counts it: the notice **is** on the board, and the
       * board's own count of what it is showing must not start disagreeing with the rows.
       *
       * ⚠️ **Counted off the rows now, not off `live` — M11-06**, and the change is the point
       * rather than a tidy-up. The predicate has moved into `toRow` as `BoardRow.unacknowledged`,
       * so the figure and the rows a screen can narrow to are **the same set by construction**.
       * Written as two expressions over two collections, they agreed only for as long as somebody
       * remembered to change both — and Phase 0a is the proof they do not: it changed this line
       * and left `acknowledged`, which is what the board's own filter was reading, untouched.
       */
      unacknowledged: rows.filter((r) => r.unacknowledged).length,
      // Live rows only, like `open` above and for the same reason. `stageOf` cannot return
      // `issued` for a closed incident anyway, so the guard is a statement of intent rather than
      // a filter that removes anything — and it is what keeps this figure honest on `?closed=1`.
      issued: rows.filter((r) => r.stage === 'issued' && !CLOSED.has(r.status)).length,
      overdue: rows.filter((r) => r.overdue).length,
      worst: summary.worst,
      /**
       * Also folded from the rows now — and it must keep agreeing with `districtSeverity`, which
       * is what the **dashboard** aggregates with. `board.test.ts` pins the two together rather
       * than trusting that a reader notices they are two statements of one rule.
       */
      unassessed: rows.filter((r) => r.unassessed).length,
      notificationsUnmet: rows.filter(
        (r) => r.notificationsFailed > 0 || r.notificationsUndelivered > 0,
      ).length,
      unassigned: rows.filter((r) => r.unassigned).length,
      // Counted over the live rows only, like `open` above. A closed incident nobody was told
      // about is a fact about last week, and putting it on the district's home screen would
      // grow a number nobody can act on until it is ignored.
      nobodyTold: rows.filter((r) => r.nobodyTold && !CLOSED.has(r.status)).length,
      withdrawn: withdrawn.length,
    },
    facets: foldFacets(rows),
    incidents: rows,
  };
}

/**
 * The facets, folded from the rows that are about to be sent — M11-16.
 *
 * Takes `rows` and nothing else **on purpose**. Given the array, there is no way for a count
 * here to disagree with the rows a screen can narrow to: it is the same array, filtered by the
 * same attribute the client will read. Passing `states` instead — the shape every other
 * aggregate in this file once used — is what allowed the strip's figures to drift from its
 * filters twice before M11-06.
 */
function foldFacets(rows: readonly BoardRow[]): BoardFacets {
  const count = (p: (r: BoardRow) => boolean): number => rows.filter(p).length;

  /**
   * Severity, worst first.
   *
   * **Ordered by rank and never by count**, which is INV-04 applied to a list: sorting by size
   * would put `critical 1` below `low 30` on the screen whose job is to make the critical one
   * impossible to miss. `SEVERITY_ORDER` runs low → critical, so it is reversed here rather
   * than written out a second time.
   */
  const severity: BoardFacet[] = [...SEVERITY_ORDER].reverse().map((value) => ({
    attr: 'severity',
    value,
    label: value,
    // `assessed` as well as the value: a row whose severity is unknown carries `unknown`, and
    // that row belongs to `unassessed` below, not to any band here.
    count: count((r) => r.assessed && r.severity === value),
    match: 'is' as const,
  }));

  /**
   * Kinds, in the order `MESSAGE_KINDS` declares them — emergencies first, General's three last.
   *
   * Only the kinds actually on the board. A control room narrowing a live board does not need
   * `schedule 0` offered to it; that is a vocabulary, and this is a panel about today.
   */
  const kind: BoardFacet[] = MESSAGE_KINDS.map((value) => ({
    attr: 'kind',
    value,
    label: value,
    count: count((r) => r.kind === value),
    match: 'is' as const,
  })).filter((f) => f.count > 0);

  // ⚠️ The `department` facet — folded from `row.responsibleDepartments`, commonest first — is
  // gone with the word (ADR-0031, phase 4). It was empty on every row anyway since migration
  // 0039, so the panel never had a row to draw.

  /** The district's own four words, in the order things happen. A fixed vocabulary, so zeros stay. */
  const stage: BoardFacet[] = STAGES.map((value) => ({
    attr: 'stage',
    value,
    label: value,
    count: count((r) => r.stage === value),
    match: 'is' as const,
  }));

  return {
    severity,
    /**
     * Beside the severities and never among them — ADR-0009.
     *
     * It reads the row's own `unassessed` flag rather than `severity === 'unknown'`, because
     * that flag is the one the strip counts and the one `data-unassessed` carries. Two
     * expressions for one rule is how the strip's figures drifted from its filters before.
     */
    unassessed: {
      attr: 'unassessed',
      value: 'true',
      label: 'not assessed',
      count: count((r) => r.unassessed === true),
      match: 'is' as const,
    },
    kind,
    stage,
  };
}
