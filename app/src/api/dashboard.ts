/**
 * The dashboard — M4.
 *
 * **One feed for one app.** The same endpoint answers a phone in a moving vehicle, a desk PC
 * in the AC Headquarter, and a large screen on an office wall. What differs between them is
 * the layout the browser chooses, and nothing else — no second page, no second codebase, and
 * no second set of numbers that can drift from the first.
 *
 * It is **scoped to whoever asked**. The two administrative offices get the district; a
 * department gets its own work. Both get the facts that belong to everybody — the weather,
 * the utilities and the services — because a department planning around a power cut needs to
 * know about the power cut.
 *
 * What it returns is a **summary**: counts, and panels that carry their own age. Rows live on
 * the board, where the authority model scopes them per incident. A dashboard that started
 * listing individual emergencies would be a second board, drifting from the first.
 *
 * One rule survives from the display design and is worth keeping: **a large screen in an
 * office is read by whoever is in the room.** So this response carries no reporter, no phone
 * number, no address and no coordinate, and `wallSafetyViolations` checks that on the way out
 * rather than trusting it. The check is cheap and the boundary is one careless join away.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { loadCarriedIncidents, loadRecentIncidents } from '../db/eventStore.js';
import type { DispatchTarget, IncidentEvent, MessageKind, Uuid } from '../domain/events.js';
import { isGeneral, isGathering } from '../domain/events.js';
// ADR-0029 — the board's own recipient lookup, exported rather than written a second time.
// `startOfDay` already comes from there for the reason this does: two files each deciding one
// question is how the board and the dashboard came to disagree about when a day starts.
import { dispatchNames } from './board.js';
import { foldIncident, type IncidentState, type IncidentStatus } from '../domain/incident.js';
import { listDepartments, loadLayout } from '../db/configStore.js';
import { DEFAULT_LAYOUT, resolveLayout } from '../domain/panels.js';
import {
  listFacts,
  listPresence,
  listUtilities,
  liveAlerts,
  type Presence,
  type Utility,
} from '../db/wallStore.js';
import { weatherPanel, type WeatherPanel } from '../ops/weather.js';
import { newsPanel, type NewsPanel } from '../ops/news.js';
import { replicationHealthSafe } from '../ops/replication.js';
import {
  LIMIT_SUBJECT,
  accountTrouble,
  messagingTier,
  recipientsReached,
  whatsappHealth,
} from '../db/whatsappStore.js';
import { tierAllows } from '../ops/whatsappNumber.js';
import { availabilityFor } from '../db/resourceStore.js';
import { summarise } from '../domain/resources.js';
import { computePerformance } from './performance.js';
import { belongsToDay, startOfDay } from './board.js';
import { endOfDistrictDay } from '../domain/districtTime.js';
import {
  moreSentence,
  windowActivity,
  type ActivityItem,
  type ActivityWindow,
} from '../domain/activity.js';
import {
  capImportance,
  moreImportanceSentence,
  type ImportanceRow,
  type ImportanceWindow,
} from '../domain/importancePanels.js';
import {
  CARRIED_CATEGORY_LIST,
  CARRIED_KIND_LIST,
  capCarried,
  carryReason,
  laneOf,
  moreCarriedSentence,
  outlivesTheDay,
  reviewLabel,
  reviewOf,
  reviewSentence,
  type CarriedRow,
  type CarriedWindow,
} from '../domain/carrying.js';
import { attendanceFor } from '../domain/attendance.js';
import { ownershipOf } from '../domain/ownership.js';
import { attendanceClosesAt } from '../domain/meetings.js';
import { stageLabel, stageOf, type Stage } from '../domain/stages.js';
import {
  age,
  presenceAge,
  presenceLabel,
  reportingGap,
  utilityLabel,
  wallSafetyViolations,
  type Aged,
  type PresenceStatus,
  type UtilityStatus,
} from '../domain/wall.js';

export interface PanelRow {
  /**
   * No id.
   *
   * The dashboard shows aggregates; nothing on it is a thing to open. Sending a row id would
   * be sending a handle to something, which is the first step towards a screen that lets a
   * room click through to an emergency (ADR-0013 §1).
   */
  readonly name: string;
  readonly status: string | null;
  readonly label: string;
  readonly freshness: 'fresh' | 'stale' | 'never';
  readonly asOf: string | null;
  readonly ageMinutes: number | null;
  readonly note: string | null;
  /**
   * The officer this row is about — ADR-0033, availability panel only.
   *
   * A **scoped exception to ADR-0013 §1**: an on-duty officer's name beside the post they hold
   * is operational, not reporter PII, and the district asked for it. Only carried for a seat the
   * control room has curated onto the wall (`seat.on_wall`). `wallSafetyViolations` still stops
   * a phone number or a coordinate here; `officer` is deliberately NOT a forbidden key.
   */
  readonly officer?: string | null;
}

export interface Dashboard {
  readonly asOf: string;
  /** Whose dashboard this is — "District", or the department's own name. */
  readonly scope: string;
  readonly isAdministration: boolean;
  readonly district: {
    readonly openIncidents: number;
    readonly today: number;
    readonly unassigned: number;
    readonly overdueUnacknowledged: number;
    readonly unassessed: number;
    readonly oldestUnassignedMinutes: number | null;
    /**
     * **What is NOT today's, fenced off from everything that is** — the owner's decision,
     * 2026-08-19, and the only safety net this design has.
     *
     * The dashboard is one district day and an incident belongs to the day it started, so an
     * emergency opened six days ago is in **none** of the counters above. Escalation stopped
     * chasing it at its own midnight (ADR-0020 §4b). **These two numbers are therefore the only
     * place in the product where it is still visible at all**, and that is why they exist rather
     * than being folded into anything.
     *
     * **Sent as a separate object on purpose.** Mixing either figure into `openIncidents` or
     * `stages` would put a period the screen does not describe back inside the numbers this
     * whole change exists to make honest — the exact defect being repaired. The screen fences
     * them under a label saying they are not today's, and must go on doing so.
     *
     * **Wall-safe by construction:** two counts and one instant. No name, no number, no place.
     */
    readonly carriedOver: {
      /**
       * Started earlier, **finished today** — the district's own work on old cases, which the
       * strict day rule otherwise makes invisible.
       *
       * Without this the control room can resolve five things this afternoon and read
       * `Resolved 0` on the wall that evening, because every one of them belongs to an earlier
       * day. That is true and useless. Counted from the **resolving event's** `recordedAt`, not
       * from the incident's own day.
       */
      readonly resolvedToday: number;
      /**
       * Started earlier and **still open**. The warning half, and the one that must never go
       * quiet: nothing else on this screen counts these, and no software is chasing them.
       *
       * Emergencies only. A General communication left open owes nobody an answer (M9-02), and
       * counting stale meeting notices here would put a number nobody acts on beside the one
       * number on this screen that must be acted on.
       */
      readonly stillOpen: number;
      /**
       * When the oldest of those started. `null` exactly when `stillOpen` is 0.
       *
       * The count alone reads the same on the day it becomes 3 and a fortnight later; the date
       * is what says which of those is happening. Sent as the instant rather than as "6 days"
       * so the screen ages it with everything else (INV-02) instead of freezing between polls.
       */
      readonly oldestOpenAt: string | null;
    };
    /**
     * **Where the district's work has reached — the wall is arranged around this from
     * 2026-08-17, on the owner's decision.**
     *
     * Three words now (narrowed 2026-09-04, was four under M9-25): the only sequence in this
     * product that every emergency actually walks, `Issued -> Responded -> Resolved`. It
     * replaces a row of counters whose names the owner could not tell apart on the wall —
     * *nobody has it*, *nobody told*, *nobody reached*, *not acknowledged* — and he was right
     * that three of those read as one thing at four metres.
     *
     * `Acknowledged` was the fourth and is gone with the word: ADR-0034 means confirming
     * receipt is no longer a distinct act separate from responding, so an emergency only
     * confirmed and not yet responded to reads as `issued` — see `domain/stages.ts`'s header.
     *
     * **Counted over LIVE incidents only, so `resolved` here means "resolved today and still
     * on the board"**, not the district's whole history. The board is one district day
     * (ADR-0020) and this figure has to agree with what is under it.
     *
     * ⚠️ **A stage cannot say anything went wrong, and that is why the alarms beside it stay.**
     * An emergency sitting at `issued` because nobody has answered yet and one sitting at
     * `issued` because **the message never arrived** are the same word here — INV-03's whole
     * subject, invisible on a stage board. `notificationsUnmet` and `unassessed` are not stages
     * and must never be folded into these three.
     */
    readonly stages: {
      readonly issued: number;
      readonly responded: number;
      readonly resolved: number;
    };
    /**
     * Live emergencies nobody has been told about — M6-09.
     *
     * Counted here in the same fold as every other counter, for the reason §5 has stated since
     * the counters were built: **a predicate re-derived in the browser is a second
     * implementation of each rule**, and the first to drift puts a number on the district's home
     * screen that its own board disagrees with. The board's `nobodyTold` flag and this counter
     * ask the same question of the same state.
     */
    readonly nobodyTold: number;
    /**
     * 🔴 **Live emergencies every recipient has declined** — RX-03, 2026-08-25.
     *
     * The district's response workflow gave officers a way to answer *Unable to Respond* and
     * *Not Related to Me*. Both are answers, so both stop the emergency being **unacknowledged**
     * — and on this screen that meant it stopped being counted at all. An emergency four
     * officers declined left `overdueUnacknowledged`, left `unassigned` (it is assigned), and
     * appeared under **Acknowledged** on the stage row. Every tile on the wall said fine.
     *
     * ⚠️ **Not a kind of `nobodyTold`.** That one is *the control room named nobody*; this is
     * *the control room named people, they all answered, and every one of them said no*. The
     * first is an operator who has not finished; the second is one who has to start again.
     *
     * Counted in the same fold as every other counter, for the reason this file has stated
     * since the counters were built: a predicate re-derived in the browser is a second
     * implementation of the rule, and the first to drift puts a number on the home screen that
     * the district's own board disagrees with. `board.ts`'s `ownerless` flag and this counter
     * ask the same question of the same state.
     */
    readonly ownerless: number;
    /**
     * The last day's shape behind each counter — M9/L7, 2026-08-14.
     *
     * **Every series ends on the counter it sits under.** `openIncidents[last]` *is*
     * `openIncidents`, and a test asserts it, because the failure this invites is a picture that
     * quietly disagrees with the number printed above it — which is the same disagreement §5 has
     * warned about since the counters were built, drawn instead of written.
     *
     * **These are states replayed, not events counted, and that distinction is the whole point.**
     * "How many were open at 14:00 yesterday" cannot be answered by counting what arrived; it
     * needs the fold run again with only what was known by then. Counting arrivals would have
     * been far cheaper and would have put a graphic under "11 open now" that answers a different
     * question — the INV-04 trap phase 6 turned down, in its subtler form.
     *
     * `today` is the exception and is honest for a different reason: it is cumulative from
     * midnight, so its shape is simply *when today's reports arrived*, which is exactly what the
     * number counts.
     *
     * Costs no extra query — `loadRecentIncidents` has already fetched seven days and the events
     * are in memory (the M9-40 reasoning). Measured against production on 2026-08-14: **32
     * incidents, 211 events, all time.** Eight replays is ~1,700 in-memory fold steps.
     */
    readonly trend: {
      readonly hours: number;
      readonly openIncidents: readonly number[];
      /** One per stage tile, so every tile on the deck carries a shape behind its number. */
      readonly stageIssued: readonly number[];
      readonly stageResponded: readonly number[];
      readonly stageResolved: readonly number[];
      readonly overdueUnacknowledged: readonly number[];
      readonly nobodyTold: readonly number[];
      readonly ownerless: readonly number[];
      readonly notificationsUnmet: readonly number[];
      readonly unassessed: readonly number[];
      readonly today: readonly number[];
    };
  };
  readonly categories: readonly {
    readonly category: string;
    readonly label: string;
    readonly open: number;
  }[];
  /**
   * The district's own condition, in the three sentences its administration is answerable for.
   *
   * This is on a wall screen deliberately. Every one of these is a thing that fails silently
   * and stays failed for months because the only place it was visible was a console somebody
   * had to remember to open. On the wall, in the room where the two offices sit, it is read
   * by accident — which is the only reliable way any of it gets fixed (R-05, R-06, R-07).
   */
  readonly condition: readonly {
    readonly what: string;
    readonly state: 'ok' | 'pending' | 'critical';
    readonly detail: string;
  }[];
  /**
   * ⚠️ **NOTHING WRITES THIS ANY MORE — ADR-0029.** Kept in the type and always empty.
   *
   * It folded `responsibleDepartmentIds`, and new emergencies do not have one: the district
   * removed the layer, and 79 of Bajaur's 80 departments held a single person whose designation
   * said the department's name a second time. The field survives so an older client meeting a
   * newer server draws nothing rather than throwing — the same road ADR-0018, ADR-0022 and
   * ADR-0023 built, where the type stays so the past reads and nothing new is written into it.
   */
  readonly departments: readonly {
    readonly name: string;
    readonly open: number;
    readonly unacknowledged: number;
  }[];
  /**
   * **What each officer is holding** — the district's own answer to
   * `backlog/contacts-without-departments.md` §10 question 3.
   *
   * Folded from `dispatchedTo` — *who the control room chose to tell* — and deliberately not
   * from `responsibleDepartmentIds`, which is the question that stopped having an answer. The
   * panel it draws is the same panel: its registry id stays `departments`, because that id is a
   * key in the district's own stored layout (ADR-0015) and renaming it would quietly drop the
   * panel off the wall of every district that had chosen it.
   *
   * ⚠️ **A name here is a name the board already prints.** `dispatchNames` resolves a person to
   * their full name and a post to its designation, which is exactly what the board's `who`
   * column has drawn since 2026-08-23 — so this puts nothing on a screen that was not already
   * on one. It carries **no id and no number**: ADR-0013 §1, and `wallSafetyViolations` is the
   * enforcement rather than this comment.
   */
  readonly officers: readonly {
    readonly name: string;
    readonly open: number;
    readonly unacknowledged: number;
  }[];
  readonly utilities: readonly PanelRow[];
  /**
   * Markets, schools, the hospital, the roads.
   *
   * The same shape as a utility and reported the same way, because they *are* the same kind
   * of fact: a name, a state, a note and an age. One mechanism rather than four (migration
   * 0017).
   */
  readonly services: readonly PanelRow[];
  readonly presence: readonly PanelRow[];
  /**
   * How each kind of emergency stands right now — the prototype's "Emergency Situation".
   *
   * Derived from the log on every request; nothing is stored. A status word rather than a
   * count alone, because "Fire · 3 open, one unacknowledged" is read at a glance and "3" is
   * not.
   */
  readonly situation: readonly {
    readonly category: string;
    readonly label: string;
    readonly state: 'ok' | 'pending' | 'critical';
    readonly status: string;
    readonly open: number;
    readonly lastAt: string | null;
  }[];
  /** Tehsils, union councils, population, area. Null where the district has not said. */
  readonly facts: readonly { readonly label: string; readonly value: string | null }[];
  /**
   * What the district can send, and what is already out.
   *
   * The prototype had no panel for this because it had no fleet behind it. It belongs beside
   * the emergency counters for an obvious reason: "4 open" and "2 ambulances available" are
   * the same decision, and reading them on two different screens is how somebody sends a unit
   * that is already committed.
   */
  readonly resources: {
    readonly total: number;
    readonly available: number;
    readonly committed: number;
    readonly outOfService: number;
    /** Named so the panel can say whose fleet this is: a department's, or the district's. */
    readonly scope: string;
  };
  /**
   * How quickly emergencies are being taken up, over seven days.
   *
   * A median rather than a mean: one incident acknowledged four hours late drags a mean into
   * meaninglessness, and it is the typical case a duty roster is judged on.
   *
   * `null` where nothing has been acknowledged — never zero. Zero minutes is the best
   * possible performance and no data is not performance at all (ADR-0005).
   */
  readonly performance: readonly {
    readonly name: string;
    readonly open: number;
    readonly overdue: number;
    readonly medianAckMinutes: number | null;
  }[];
  /**
   * Emergencies where somebody was supposed to be told and demonstrably was not.
   *
   * INV-03 on the home screen. It is a count of **unmet obligations**, not of log lines, and
   * it is the one number here that means the system itself failed rather than the district.
   */
  readonly notificationsUnmet: number;
  /**
   * Which panels this screen should show, in order, and how big — ADR-0015, M6-30.
   *
   * **Resolved server-side and sent with the data**, rather than the client reading a layout of
   * its own. Two reasons, and the second is the load-bearing one:
   *
   *   * The feed and the arrangement then arrive together, so a screen never renders a panel
   *     against data from a different request.
   *   * **A panel's audience is enforced here.** `condition` is administration-only, and a
   *     client that decided its own layout would be a client deciding what it may see —
   *     precisely what INV-05 refuses. The editor will not offer it to a department; that is a
   *     courtesy, and this is the control.
   *
   * The panel *content* is unchanged: every field above is still sent to everybody entitled to
   * it. This says what to draw and in what order, never what to fetch — a layout that could
   * narrow the response would be a second scoping rule beside `viewerFor`.
   */
  readonly layout: readonly { readonly id: string; readonly size: string }[];
  /** Live advisories: VIP movement, road closures, weather warnings (two offices issue them). */
  /**
   * The last 24 hours, twenty at a time — M9-38, M9-40.
   *
   * `hidden` and `more` are the load-bearing half. A panel that shows twenty and says nothing
   * about the rest is read as *this is everything*, and the district stops believing the board
   * the first time somebody asks about an eleven o'clock alert the screen has rotated past.
   */
  readonly activity: ActivityWindow & { readonly more: string | null };
  /**
   * Open emergencies, split by importance and nothing else — M10-20…25/41/42, replacing
   * `situation` in the default layout (see `domain/panels.ts`).
   *
   * **This is the whole of M10-42.** Every other number on this feed — `district`, `categories`,
   * `situation`, `departments`, the trend — is computed from the same fold and reads none of
   * `importance`. A row marked routine by mistake is still counted everywhere else exactly as
   * before; only which of these two lists it is in moves.
   */
  readonly importantEmergencies: ImportanceWindow & { readonly more: string | null };
  readonly routineEmergencies: ImportanceWindow & { readonly more: string | null };
  /**
   * **The things that do not finish at midnight** — the district's five, 2026-08-22.
   *
   * ⚠️ **This is OPEN work and everything else on this feed is TODAY's.** It is the one
   * panel here measured over a different period from the counters above it, and the screen has
   * to say so in words — two honest numbers answering different questions on one wall is
   * INV-04's trap arriving through a new door.
   *
   * ⚠️ **`district.carriedOver.stillOpen` deliberately no longer counts what is on this
   * panel.** One item, one row: the carry-over strip and this panel counting the same flood
   * would give it two ages on one screen, which is the M9-37 defect that put every advisory in
   * `alerts` and `activity` at once.
   */
  readonly stillRunning: CarriedWindow & { readonly more: string | null };
  /**
   * Headlines from **outside** the district — M9-59.
   *
   * Carried beside the district's own panels and never mixed into them. The source and the age
   * both travel with it, because a national headline read as a district fact is a mistake the
   * district cannot correct: they did not write the story.
   */
  readonly news: NewsPanel;
  readonly alerts: readonly {
    readonly tag: string;
    readonly message: string;
    readonly issuedAt: string;
    readonly untilAt: string;
  }[];
  readonly reporting: {
    readonly utilities: { total: number; answering: number; quiet: number };
    readonly services: { total: number; answering: number; quiet: number };
    readonly presence: { total: number; answering: number; quiet: number };
  };
  readonly weather: WeatherPanel;
}

function hhmm(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/**
 * The words on the report form, so the wall says the same thing the handset does.
 *
 * Resolved here rather than in the browser because the district may add a category the
 * display has never heard of, and a screen that renders the raw code for that one is a screen
 * reading "rta" next to "Fire". Anything unmapped falls back to the code itself, capitalised.
 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  rta: 'Road accident',
  fire: 'Fire',
  medical: 'Medical',
  flood: 'Flood',
  security: 'Security',
  // The district's thirteenth tile, 2026-08-24. Mapped in both places, for the reason the
  // comment above gives: the wall and the handset must say the same word.
  rescue: 'Rescue emergency',
  other: 'Other',
};

function categoryLabel(code: string): string {
  return CATEGORY_LABELS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

/**
 * **Who has it — three answers, because there were only ever two and one of them was false.**
 *
 * This read *"nobody told yet"* whenever no **department** was responsible, on the activity panel
 * and on both importance panels. Measured on Bajaur's live record on 2026-08-18: **40 incidents,
 * 28 where somebody was told, 9 with a department — so 19 rows said nobody had been told about an
 * emergency the control room had told officers about by name.** M10-07/08/09 made the person row
 * the only row the picker draws, and a person-kinded dispatch places no department, so from
 * 2026-08-16 that was the *ordinary* case rather than an edge one.
 *
 * The two questions had one sentence between them, and the sentence answered the wrong one — the
 * same fault as `With nobody` on the category cards the day before, in the place it does the most
 * damage: an operator scanning for what needs picking up.
 *
 * ⚠️ **`dispatchedTo` is what separates them and no other field can.** An empty
 * `responsibleDepartmentIds` means *no department holds this*, which is true of every emergency
 * handed straight to an officer. Only `dispatchedTo` answers *was anybody chosen at all* — the
 * same value `countsFor` reads for `nobodyTold`, so this panel and that counter cannot disagree.
 */
function whoHasIt(
  state: { responsibleDepartmentIds: readonly Uuid[]; dispatchedTo: readonly unknown[] },
  directory: Map<Uuid, string>,
): string {
  if (state.responsibleDepartmentIds.length > 0) {
    return state.responsibleDepartmentIds.map((id) => directory.get(id) ?? id).join(', ');
  }
  // The wall's own word for this, so the panel and the deck above it say one thing (2026-08-17).
  if (state.dispatchedTo.length === 0) return 'no one chosen';
  /**
   * Somebody was chosen and no department holds it — which is what *"tell this officer"* looks
   * like in the record, and is now most of Bajaur's traffic.
   *
   * Deliberately does **not** name them. `PanelRow` carries no id for ADR-0013 §1's reason and
   * the same argument reaches names: this screen is read by a room, and printing an officer's
   * name beside an emergency on a wall is a different decision from showing it in the control
   * room's own picker. The fact an operator needs here is *this is with a person, not a
   * department* — the incident's own page says which person.
   */
  return 'told directly';
}

function panelRow(
  name: string,
  reading: Aged<UtilityStatus | PresenceStatus>,
  label: string,
  note: string | null,
  officer?: string | null,
): PanelRow {
  return {
    name,
    ...(officer === undefined ? {} : { officer }),
    // A stale value is not sent as a status. The screen would render it, somebody would style
    // it green, and the label saying "no report since 02:00" would be the small text under a
    // large green word. Withholding it here makes that mistake impossible downstream.
    status: reading.freshness === 'fresh' ? (reading.value as string) : null,
    label,
    freshness: reading.freshness,
    asOf: reading.asOf,
    ageMinutes: reading.ageMinutes,
    /**
     * The note survives staleness. The status above does not — M10-01.
     *
     * **The district reported this as a defect and they were right.** An officer types
     * *"8 hours loadshedding"* into the Status screen; `stale_minutes` for Electricity is 240,
     * so four hours into an eight-hour cut the sentence disappeared from the wall — at exactly
     * the moment it was most worth reading.
     *
     * **A note is not a reading, and that was the whole distinction.** M10-01 kept the note and
     * went on withholding the stale *status*, on the argument that a four-hour-old `normal`
     * rendered as a large green word is INV-02 in one line.
     *
     * ⚠️ **2026-08-23, ADR-0025: for a utility there is no longer a stale status to withhold.**
     * The district asked for the timer to go entirely — *"koi time cap nhe … control wale
     * control karenge"* — so `utilityRows` ages utilities with a **null** window and what the
     * control room last said now stands until they say otherwise. M10-01's half-measure is
     * obsolete in the direction it was already pointing: it saved the sentence and lost the
     * status, and the district wanted both kept.
     *
     * **INV-02 is satisfied by what sits beside it, not by hiding it** — the same argument,
     * carrying more weight now. `asOf` and `ageMinutes` travel with every reading and the wall
     * prints the age beside the status, with `startAges` keeping it climbing between polls. A
     * reader is never told a reading is current; they are told how old it is. **Since ADR-0033
     * presence is the same** — a null window, so an availability reading never degrades either;
     * the district asked for that timer gone too.
     *
     * **`never` is still null, and it is not the same test as before.** `age()` returns `never`
     * both when nothing was ever reported *and* when `reportedAt` will not parse — and in that
     * second case a note can exist beside a reading the screen refuses to believe.
     * `renderStatusList` draws "nobody has reported this" for `never` and shows no note at all,
     * so passing one would be sending a field no screen may render.
     */
    note: reading.freshness === 'never' ? null : note,
  };
}

/**
 * The counters, as predicates on **one** folded incident — M9/L7, 2026-08-14.
 *
 * ⚠️ **Extracted so the live count and the trend replay cannot drift apart.** Before this there
 * was one copy, inline in the counting loop; the trend needed the same questions asked of a state
 * as it stood some hours ago, and writing them a second time is precisely the mistake this file's
 * own comments describe — *"the rule was written twice rather than shared"*, which is how the
 * dashboard came to disagree with its own board once already. **A new counter belongs here, not
 * in the loop.**
 */
interface CountedIncident {
  readonly live: boolean;
  readonly nobodyTold: boolean;
  /** Live, and every recipient who answered declined — RX-03. */
  readonly ownerless: boolean;
  readonly unacknowledged: boolean;
  readonly notificationUnmet: boolean;
  /**
   * **Where the work has reached** — the district's own four words, and from 2026-08-17 the
   * thing the wall is arranged around.
   *
   * Read from `stageOf`, which is a **view** of the seven statuses the fold already produces
   * (`domain/stages.ts`). Nothing is stored and nothing new is decided here — this counter is
   * the same mapping the board row and the detail heading have printed since M9-25, counted.
   * That is the whole reason it is cheap: there is no second definition of *Acknowledged* to
   * drift away from the first.
   */
  readonly stage: Stage;
}

function countsFor(state: {
  status: IncidentStatus;
  kind: MessageKind;
  dispatchedTo: readonly unknown[];
  acknowledgedAt: string | null;
  notifications: readonly {
    state: string;
    reason?: string;
    attemptId?: string;
    seatId?: string | null;
    via?: string;
    said?: string;
  }[];
}): CountedIncident {
  const live = state.status !== 'resolved' && state.status !== 'closed';

  /**
   * Who is actually holding this, off the officers' own words — RX-03 / Option C.
   *
   * One read, shared by three counters below. `ownerless` is *answered, and nobody is holding
   * it*; a decline that filled the incident's `acknowledgedAt` slot or drove the status to
   * `responding` (every inbound reply does — `domain/incident.ts`) must not let this screen
   * count the emergency as handled.
   */
  const owned = ownershipOf(
    state.notifications.map((n) => ({
      attemptId: n.attemptId ?? '',
      seatId: n.seatId ?? null,
      reason: n.reason ?? '',
      ...(n.via === undefined ? {} : { via: n.via }),
      ...(n.said === undefined ? {} : { said: n.said }),
    })),
  );
  /**
   * A live emergency every recipient has declined does not read as `Responded` on the wall —
   * Option C. `domain/incident.ts` moves the status to `responding` on any inbound reply, a
   * refusal included, so `stageOf` alone would file *four offices said no* under the same word
   * as *a unit is rolling*. A gathering keeps its own stage: `attendanceFor` is its counter and
   * its options are not `ownershipOf`'s.
   */
  const rawStage = stageOf(state.status);
  const stage: Stage =
    live && owned.ownerless && !isGathering(state.kind) && rawStage === 'responded'
      ? 'issued'
      : rawStage;

  return {
    live,
    stage,
    /**
     * **A notice nobody was told about is still a real gap**, so this one deliberately counts
     * General communications. A meeting notice exists in order to be sent; one sitting on the
     * board with no recipient is exactly the paper-register failure M6-09 measures.
     */
    nobodyTold: live && state.dispatchedTo.length === 0,
    /**
     * ⚠️ **`live` first, and it is the whole guard.** A resolved emergency that three officers
     * declined on the way to somebody else resolving it is history, not work — and a wall tile
     * that counted it would climb all day and never come down, which is how a number stops
     * being read (INV-08).
     */
    ownerless: live && owned.ownerless,
    /**
     * **Emergencies only — M11-02, and it had to be changed here as well as on the board.**
     *
     * `board.ts`'s `summary.unacknowledged` stopped counting General communications, because a
     * notice owes nobody an answer (M9-02) and its row already says *"sent · no answer needed"*.
     * Fixing only the board would have left the district's **home screen** counting a meeting
     * notice as unacknowledged while the board it opens does not — two numbers for one question,
     * which is the `setHours`/`setUTCHours` two-midnights defect arriving through a new door.
     *
     * It lands in `countsFor` rather than in either loop for the reason this function's own
     * history gives: the rule is written once, the live count and the sparkline replay both read
     * it, and they cannot drift apart.
     */
    unacknowledged:
      live &&
      !isGeneral(state.kind) &&
      (state.acknowledgedAt === null || (owned.ownerless && !isGathering(state.kind))),
    // Per incident, never per attempt: three failed rungs against one duty officer is one
    // emergency nobody is coming to, not three problems (INV-03).
    notificationUnmet:
      live &&
      (state.notifications.some((n) => n.state === 'failed') ||
        (state.notifications.length > 0 &&
          state.notifications.every((n) => n.state === 'pending'))),
  };
}

/** How many points a sparkline carries, and over how long. */
const TREND_POINTS = 8;
const TREND_HOURS = 24;

/**
 * The last day's shape behind each counter, by **replaying the fold** — M9/L7, 2026-08-14.
 *
 * ⚠️ **The expensive choice, made on purpose.** *"How many were open at 14:00 yesterday"* is a
 * question about a **state**, and no amount of counting arrivals answers it: an emergency reported
 * on Tuesday and still open counts at every point after Tuesday, and one resolved at noon stops
 * counting at noon. So the fold is run again at each point with only the events known by then.
 *
 * Counting arrivals per bucket would have been one cheap pass. It would also have drawn, under a
 * tile reading *"11 open now"*, a line answering *"how many arrived"* — a graphic disagreeing with
 * its own number, which is the INV-04 trap phase 6 turned down in its obvious form and this is its
 * subtle one.
 *
 * **`recordedAt`, not `occurredAt`, decides what was known.** A report captured offline at 23:40
 * and synced at 06:10 was not on anybody's screen at midnight, and a trend claiming otherwise
 * would be redrawing history the district never saw.
 *
 * No extra query: `loadRecentIncidents` has already fetched seven days (the M9-40 reasoning).
 * Measured against production, 2026-08-14: 32 incidents and 211 events, all time — eight replays
 * is roughly 1,700 in-memory fold steps.
 */
function districtTrend(
  grouped: readonly (readonly IncidentEvent[])[],
  now: Date,
  midnight: Date,
  onlyDepartmentId: string | null,
): Dashboard['district']['trend'] {
  const stepMs = (TREND_HOURS * 3_600_000) / (TREND_POINTS - 1);

  const openIncidents: number[] = [];
  const stageIssued: number[] = [];
  const stageResponded: number[] = [];
  const stageResolved: number[] = [];
  const overdueUnacknowledged: number[] = [];
  const nobodyTold: number[] = [];
  const ownerless: number[] = [];
  const notificationsUnmet: number[] = [];
  const unassessed: number[] = [];
  const today: number[] = [];

  for (let point = 0; point < TREND_POINTS; point += 1) {
    // The last point is `now` exactly, so every series ends on the counter it sits under.
    const at = new Date(now.getTime() - (TREND_POINTS - 1 - point) * stepMs);

    let open = 0;
    let unack = 0;
    let told = 0;
    let unheld = 0;
    let unmet = 0;
    let reported = 0;
    // ADR-0009's figure needs a shape too, or its tile is the one short line in a deck of eight
    // — and a tile without one is a different height from a tile with one.
    let unassessedAt = 0;
    /**
     * The three stages, as they stood at this instant — the shape under each of the deck's main
     * tiles. Replayed rather than counted, exactly like everything else here: *"how many were
     * still unanswered at 14:00"* is a question about a **state**, and counting arrivals would
     * draw a picture answering a different question from the number above it.
     */
    const stagesAt: Record<Stage, number> = {
      issued: 0,
      responded: 0,
      resolved: 0,
    };

    for (const events of grouped) {
      const known = events.filter((e) => new Date(e.recordedAt) <= at);
      const first = known[0];
      // Nothing had reached us yet. Not an incident with nothing happening — an incident that,
      // as far as this district was concerned, did not exist.
      if (first === undefined) continue;

      const state = foldIncident(first.incidentId, known);

      /**
       * Withdrawn rows are out of the trend too — M10-14.
       *
       * The replay asks *how many were open at 14:00 yesterday*, and it must answer with the
       * same rule the counter beside it uses, or the line under "11 open now" would end
       * somewhere the number does not. **`withdrawnAt` is read from the state as it stood at
       * that instant**, so a row withdrawn this morning still counts in yesterday's shape —
       * which is what actually happened, and the honest answer.
       */
      if (state.withdrawnAt !== null) continue;

      // The same scoping rule the live loop applies, asked of the state as it stood then.
      if (
        onlyDepartmentId !== null &&
        state.responsibleDepartmentIds.length > 0 &&
        !state.responsibleDepartmentIds.includes(onlyDepartmentId)
      ) {
        continue;
      }

      if (
        state.occurredAt !== null &&
        new Date(state.occurredAt) >= midnight &&
        new Date(state.occurredAt) <= at
      ) {
        reported += 1;
      }

      const counted = countsFor(state);

      /**
       * ⚠️ **`resolved` is tallied ABOVE the live guard, and it has to be.**
       *
       * A resolved incident is not live, so a stage tallied below would read 0 at every point —
       * the same trap the live counter fell into and a browser test caught. It uses the identical
       * today-window as the figure it draws under, or the line would end somewhere the number
       * does not, which is the one thing this whole replay exists to prevent.
       */
      if (
        counted.stage === 'resolved' &&
        state.occurredAt !== null &&
        new Date(state.occurredAt) >= midnight
      ) {
        stagesAt.resolved += 1;
      }

      if (!counted.live) continue;

      open += 1;
      // The two live stages. `resolved` cannot arrive here; it is handled above.
      stagesAt[counted.stage] += 1;
      if (counted.unacknowledged) unack += 1;
      if (counted.nobodyTold) told += 1;
      if (counted.ownerless) unheld += 1;
      if (counted.notificationUnmet) unmet += 1;
      // "We do not know yet" is not a level of seriousness — the same test the live loop applies.
      if (state.severity === null) unassessedAt += 1;
    }

    openIncidents.push(open);
    stageIssued.push(stagesAt.issued);
    stageResponded.push(stagesAt.responded);
    stageResolved.push(stagesAt.resolved);
    overdueUnacknowledged.push(unack);
    nobodyTold.push(told);
    ownerless.push(unheld);
    notificationsUnmet.push(unmet);
    unassessed.push(unassessedAt);
    today.push(reported);
  }

  return {
    hours: TREND_HOURS,
    openIncidents,
    stageIssued,
    stageResponded,
    stageResolved,
    overdueUnacknowledged,
    nobodyTold,
    ownerless,
    notificationsUnmet,
    unassessed,
    today,
  };
}

function utilityRows(utilities: readonly Utility[], now: Date): PanelRow[] {
  return utilities.map((u) => {
    // `null`, not `u.staleMinutes` — ADR-0025. A utility reading no longer expires on a timer;
    // what the control room last said stands until they say something else. The column is left
    // alone rather than dropped: presence still uses it, and a migration to delete a value
    // nothing reads would be a migration for tidiness.
    const reading = age(u.status, u.reportedAt, null, now);

    return panelRow(u.name, reading, utilityLabel(reading), u.note);
  });
}

function presenceRows(people: readonly Presence[], now: Date): PanelRow[] {
  return people.map((p) => {
    // ADR-0033: a null window, so this never degrades — the wall still prints the age.
    const reading = presenceAge(p.status, p.reportedAt, now);

    // The seat title is the designation; `officer` is the holder's name. Both on the wall, for
    // the seats the control room curated — the scoped exception to ADR-0013 §1.
    return panelRow(p.seatTitle, reading, presenceLabel(reading), p.note, p.officer);
  });
}

/**
 * **Was this incident finished inside the given day?**
 *
 * Asked of the **events**, not of the folded state, because the fold keeps no instant for when
 * an incident was resolved — and the question here is precisely *when*, not *whether*.
 *
 * `resolved` wins over `closed` when both exist: resolving is when the district's work on it
 * actually ended, and closing is the paperwork, which may be days later. Reading the closure
 * instead would credit today with an emergency dealt with last week.
 */
function finishedInside(
  events: readonly IncidentEvent[],
  bounds: { readonly from: string; readonly to: string },
): boolean {
  const ended =
    events.find((e) => e.type === 'resolved') ?? events.find((e) => e.type === 'closed');
  if (ended === undefined) return false;

  return ended.recordedAt >= bounds.from && ended.recordedAt <= bounds.to;
}

/**
 * Fold the district down to counts.
 *
 * Deliberately not `buildBoard`. That function takes a seat and evaluates read authority per
 * incident, which is exactly right for a person and meaningless for a television — there is
 * no seat to evaluate. Reaching for it would have meant inventing a seat for the wall to
 * borrow, which is the "sign the TV in as the DC" mistake ADR-0013 §2 rejects, arriving
 * through a side door.
 *
 * So this reads the same events and counts them, and never produces a row.
 */
async function districtSummary(
  pool: Pool,
  now: Date,
  onlyDepartmentId: string | null,
): Promise<{
  district: Dashboard['district'];
  notificationsUnmet: number;
  categories: Dashboard['categories'];
  situation: Dashboard['situation'];
  departments: Dashboard['departments'];
  officers: Dashboard['officers'];
  /** Raw, unwindowed. `buildDashboard` merges the advisories in and then applies the window. */
  updates: ActivityItem[];
  /** Raw, uncapped — M10-42. `buildDashboard` caps each independently (M10-24). */
  important: ImportanceRow[];
  routine: ImportanceRow[];
  carried: CarriedRow[];
}> {
  /**
   * **Seven days fetched to show one, and the gap is on purpose.**
   *
   * The screen is today (see `bounds` below), so this could ask for two days and be correct
   * about every counter. It asks for seven because the **carry-over strip** — the one thing
   * standing between an older open incident and silence, now that neither a counter nor an
   * escalation will mention it — is computed from the same fold, and it cannot report what was
   * never read.
   *
   * The window is therefore a floor on how far back that strip can see, not a period the screen
   * describes. Nothing below counts an incident because it arrived inside these seven days.
   */
  const recent = await loadRecentIncidents(pool, 7, 500);

  /**
   * ▶ **The things that do not finish at midnight are selected because they are STILL
   * RUNNING, never because of their date** — the district's five, 2026-08-22.
   *
   * This is the district's headline complaint, and it has two halves that look like one.
   * `belongsToDay` files an incident under the day it **started**, so a meeting notice issued on
   * Saturday for Monday leaves the screen on **Sunday** — and the seven-day fetch above is the
   * other half: a meeting three weeks out ages out of it on day eight, so fixing only the day
   * rule would have fixed the near case and left the far one.
   *
   * ⚠️ **A second loader rather than a wider window on the first.** Asking
   * `loadRecentIncidents` for a year would drag this feed through months of history on every
   * poll, on the machine also taking emergency reports, to find a handful of rows. See
   * `loadCarriedIncidents` for why the query only narrows and the fold decides.
   *
   * ⚠️ **Merged by incident id, and the overlap is the ordinary case.** Nearly everything
   * carried today is also inside the last seven days, so the two sets mostly agree — folding an
   * incident twice would put a flood on the panel twice, which is trap 2 arriving by a
   * different door from the carry-over strip.
   */
  const carriedGroups = await loadCarriedIncidents(pool, CARRIED_KIND_LIST, CARRIED_CATEGORY_LIST);
  const byIncident = new Map<string, readonly IncidentEvent[]>();
  for (const events of [...recent, ...carriedGroups]) {
    const first = events[0];
    if (first !== undefined) byIncident.set(first.incidentId, events);
  }
  const grouped = [...byIncident.values()];

  const directory = new Map((await listDepartments(pool)).map((d) => [d.departmentId, d.name]));

  /**
   * The board's midnight, not a second one.
   *
   * This used to be `setUTCHours(0, 0, 0, 0)` while `board.ts` used `setHours` — **a five-hour
   * disagreement about when the district's day starts**, because Bajaur is UTC+05:00. Between
   * local midnight and 05:00, the two answered different questions: the counter counted a
   * slice of yesterday as today, and the board it opens flagged fewer rows than the counter
   * had promised.
   *
   * That is precisely the failure the counters were built to end (§5: *"a predicate re-derived
   * elsewhere would be a second implementation of each rule, and the first to drift would put
   * a number on the district's home screen that its own board disagrees with"*) — and it was
   * sitting inside the server the whole time, in two files, because the rule was written twice
   * rather than shared. Caught by `board.test.ts`'s agreement test, which exists for this and
   * had to wait for a run holding incidents on both sides of the boundary to prove it.
   */
  const midnight = new Date(startOfDay(now.toISOString()));

  /**
   * **The dashboard is one district day** — the owner's decision, 2026-08-19, and the correction
   * this whole change exists to make.
   *
   * Until now this function folded a **rolling seven days** while the tile beside the count said
   * `today`, and while the board underneath it showed one day. Three surfaces, three periods,
   * one of them lying: an empty board sat beside a dashboard reporting 37 issued and 13 with
   * nobody chosen, and the district asked — correctly — which of the two to believe.
   *
   * The bounds are today's, from `domain/districtTime.ts`, and the predicate is
   * **`belongsToDay` itself, imported from `board.ts`, not a second copy of the rule**. That is
   * the whole point of this fix. A dashboard that decided *"is this today?"* in its own words
   * would drift from the board within a milestone, and drift is what produced the defect above.
   *
   * The fetch below still reaches back further than one day, deliberately — see there.
   */
  const bounds = { from: startOfDay(now.toISOString()), to: endOfDistrictDay(now.toISOString()) };

  /**
   * The fenced strip's three figures — see `Dashboard['district']['carriedOver']`.
   *
   * Accumulated in **this** loop rather than in a pass of their own, for the reason the activity
   * panel above already gives: the fold is running over these events anyway, and a second read
   * of what is sitting in memory is a second answer that can disagree with the first.
   */
  let carriedResolvedToday = 0;
  let carriedStillOpen = 0;
  let oldestCarriedOpenAt: string | null = null;

  /**
   * **A department sees its own work, and the fenced strip must not see more.**
   *
   * Extracted rather than written twice. It was inline in the loop below and the carry-over
   * tally needs the identical question — and this file has already been caught once shipping a
   * panel that answered a question the counters beside it had stopped answering.
   *
   * An unassigned incident counts for **everybody**, deliberately: it is nobody's, and a
   * department that cannot see the pile waiting to be assigned cannot offer to take one.
   */
  const visibleHere = (state: IncidentState): boolean =>
    onlyDepartmentId === null ||
    state.responsibleDepartmentIds.length === 0 ||
    state.responsibleDepartmentIds.includes(onlyDepartmentId);

  let openIncidents = 0;
  let notificationsUnmet = 0;
  let today = 0;
  let unassigned = 0;
  let unassessed = 0;
  let overdueUnacknowledged = 0;
  let oldestUnassigned: number | null = null;
  let nobodyTold = 0;
  let ownerless = 0;
  /**
   * The three stages, tallied in the same pass as everything else.
   *
   * Keyed by the `Stage` union so a new stage cannot be added to `domain/stages.ts` and silently
   * miss the wall — the compiler asks for it here.
   */
  const stages: Record<Stage, number> = { issued: 0, responded: 0, resolved: 0 };

  const byCategory = new Map<
    string,
    {
      open: number;
      /** Nobody was ever chosen to be told — the one alarm that outranks a stage. */
      nobodyTold: number;
      issued: number;
      responded: number;
      lastAt: string | null;
    }
  >();
  // ADR-0029: keyed `kind:id` the way `dispatchedTo` keys itself, so the names can be resolved
  // in ONE batch after the loop rather than a lookup per incident on the screen a room reads all
  // day. Names cannot be resolved here — that needs the database, and this loop is pure.
  const byOfficer = new Map<string, { open: number; unacknowledged: number }>();
  const officerTargets: DispatchTarget[] = [];

  /**
   * The last day's updates, gathered in **this** loop — M9-40.
   *
   * Not a second query. `loadRecentIncidents` has already fetched seven days of events and the
   * fold is already running over them; asking the database again for a subset of what is
   * sitting in memory would be a second read that could disagree with the first, on the one
   * screen a room reads without touching.
   *
   * Every live emergency is included and then `windowActivity` decides what is recent, because
   * *recent* is one rule that belongs in one place (`domain/activity.ts`) rather than as a
   * comparison written here and again wherever the next panel needs it.
   */
  const updates: ActivityItem[] = [];
  // M10-24. Gathered in this same loop, on the same live/non-withdrawn incidents, for the
  // reason `updates` above already gives: a second read of what is sitting in memory would be
  // a second implementation that could disagree with the first.
  const important: ImportanceRow[] = [];
  const routine: ImportanceRow[] = [];
  /**
   * The district's five, gathered in **this** loop for the reason `updates` above already
   * gives — the fold is running over these events anyway, and a second read of what is
   * sitting in memory is a second answer that can disagree with the first.
   */
  const carried: CarriedRow[] = [];

  /**
   * One row of the *Still running* panel, in the district's own words.
   *
   * Deliberately built from the **same headline vocabulary** the activity and importance panels
   * use, so one emergency does not read three different ways on one screen.
   */
  const carriedRowFor = (state: IncidentState): CarriedRow => {
    const review = reviewOf(state, now);
    /**
     * The tally for the date this meeting is on **now**.
     *
     * `rescheduledAt` restarts the count, so a meeting moved to Thursday does not show Monday's
     * eight as though they had agreed to Thursday. `attendanceClosesAt` is the owner's rule of
     * 2026-08-18, computed from when the notice went out rather than from now — a deadline that
     * moved every time somebody looked at the wall would not be one.
     */
    const askedAt = state.dispatchedAt ?? state.occurredAt;
    const tally = attendanceFor(state.kind, state.notifications, {
      rescheduledAt: state.rescheduledAt,
      closesAt: askedAt === null ? null : attendanceClosesAt(askedAt),
      // An Information notice counts who is coming only when the operator asked it to.
      invited: state.asksAttendance,
    });
    return {
      incidentId: state.incidentId,
      lane: laneOf(state.kind, state.category?.value ?? null),
      headline:
        state.details?.subject?.trim() ||
        `${categoryLabel(state.category?.value ?? 'other')} — ${stageLabel(
          stageOf(state.status),
        ).toLowerCase()}`,
      detail: whoHasIt(state, directory),
      since: state.occurredAt,
      // The district's own requirement: "rozana iska pata hona zaroori hai". A day-5 flood
      // updated two hours ago and one with nothing for 31 hours are different situations.
      lastRecordedAt: state.lastRecordedAt,
      reviewMark: reviewSentence(review),
      reviewLabel: reviewLabel(review),
      // Already built (`domain/attendance.ts`), null for anything that is not a meeting —
      // never a tally of zeroes, which invites "nobody is coming" about a road accident.
      // `coming` is `attending + sendingSomeone` — a representative is a yes, and this card now
      // reads the same numerator as the drawer, the board row and both reports (Case 2).
      attendance: tally === null ? null : `${String(tally.coming)} of ${String(tally.told)} coming`,
      reason: carryReason(state),
    };
  };

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);

    /**
     * **Not today's, not on today's dashboard.**
     *
     * `belongsToDay` is the board's own predicate, called here rather than reimplemented, so the
     * two screens cannot answer differently about the same emergency. It admits an incident two
     * ways — *it happened today*, or *it first arrived today* — and the second is not a
     * convenience: a report captured offline at 23:40 in a village with no signal and synced at
     * 06:10 is **yesterday's fact and today's work** (ADR-0002), and a dashboard that filed it
     * under a day nobody is looking at would be wrong while the fire was still burning.
     *
     * What it deliberately does **not** admit is an older incident that merely *moved* today.
     * The owner was asked directly and chose the strict rule: an incident belongs to the day it
     * started, and acknowledging a six-day-old case this afternoon does not bring it back onto
     * this screen. What that costs is real — it is why the carry-over strip exists, and the
     * strip is the only place those cases are now visible at all.
     */
    if (!belongsToDay(state, events, bounds, now.toISOString())) {
      /**
       * **Not today's — so it is counted HERE and nowhere else.**
       *
       * This is the whole of the safety net. Both halves obey the same two rules the counters
       * below obey — a withdrawn row is off this screen (M10-14), and a department sees only
       * its own — through `visibleHere`, so the fenced strip cannot describe a wider district
       * than the numbers beside it.
       */
      if (state.withdrawnAt === null && visibleHere(state)) {
        if (state.status === 'resolved' || state.status === 'closed') {
          if (finishedInside(events, bounds)) carriedResolvedToday += 1;
        } else if (outlivesTheDay(state)) {
          /**
           * ▶ **On the panel, and deliberately NOT in the strip** — the district's five,
           * 2026-08-22, and it is trap 2 of the three the plan writes down.
           *
           * One item, one row. A flood counted here *and* in `carriedStillOpen` would appear
           * twice on one screen with two different ages, and the district would reasonably
           * conclude one of them was wrong — which is exactly the defect M9-37 fixed when an
           * advisory sat in `alerts` and `activity` at once.
           *
           * The strip keeps what it was built for: an older open emergency that **does** clear
           * at midnight — a fire, a road accident, a medical case — which no counter mentions
           * and no escalation chases (ADR-0020/0021). Those still have nowhere else to be seen.
           */
          carried.push(carriedRowFor(state));
        } else if (!isGeneral(state.kind)) {
          carriedStillOpen += 1;
          const at = state.occurredAt;
          if (at !== null && (oldestCarriedOpenAt === null || at < oldestCarriedOpenAt)) {
            oldestCarriedOpenAt = at;
          }
        }
      }
      continue;
    }

    /**
     * **Taken off the board is taken off the dashboard** — M10-14.
     *
     * Both halves, and they are one line because they read the same fold: the district
     * counters, and the last-24-hours panel built below. A row that leaves the board and stays
     * on the wall would be the district's request half-done in the most confusing possible
     * way — the operator removes it, watches it vanish from one screen, and finds it on the
     * other one in the room.
     *
     * It is still in **search** and on the **daily report**, marked (M10-15). That is what
     * makes this a screen decision rather than a deletion.
     */
    if (state.withdrawnAt !== null) continue;

    // A department counts only what is its own — `visibleHere`, which the carry-over tally
    // above asks the identical question of. The reasoning lives with the function.
    if (!visibleHere(state)) continue;

    const live = state.status !== 'resolved' && state.status !== 'closed';

    const occurredToday = state.occurredAt !== null && new Date(state.occurredAt) >= midnight;
    if (occurredToday) today += 1;

    /**
     * **The end of the sequence, and the one figure in the deck's main row measured over TODAY
     * rather than over what is open.**
     *
     * It has to be. The loop below skips anything not live, so a `resolved` tallied there would
     * read **0 for ever** — which is what the first version of this shipped as, caught by a
     * browser test rather than by reading the code. *Resolved* and *open* are contradictory
     * categories; there is no set of "open resolved emergencies" to count.
     *
     * So it answers the question a control room actually asks beside *Reported today*: **of
     * today's work, how much is finished.** The tile says `Resolved today` in as many words,
     * because a figure measured over a different window from the three beside it must say so on
     * the wall and not only here.
     */
    if (occurredToday && !live) stages.resolved += 1;

    /**
     * An update, with **no id on it** — ADR-0013 §1.
     *
     * `PanelRow` carries no id for a stated reason: the dashboard shows aggregates, nothing on
     * it is a thing to open, and sending a handle is the first step towards a screen a room can
     * click through to an emergency. An activity row is the same kind of thing, so it carries
     * words and a time and nothing that could be followed.
     *
     * `lastRecordedAt` rather than `occurredAt`: this panel answers *what has been happening*,
     * and an emergency from Tuesday that was resolved an hour ago **is** an update. Ordering by
     * when it happened would put it below yesterday and out of the window entirely.
     *
     * **The second line is the officer's own answer once there is one** — 2026-09-05, the owner
     * tested the WhatsApp flow on themselves, replied to *"what happened?"*, and could not find
     * that reply anywhere on the screen they actually watch. It already lived on the Record row
     * (`incidentRow.ts`'s `Resolved: …`, since 2026-08-23) but this panel is the one place
     * "what has been happening" is read without opening anything, so a resolution here now says
     * what closed it rather than who had it — `whoHasIt` stays the answer for every other stage,
     * where there is no sentence yet to prefer. Same label as the Record row, deliberately: one
     * word for the same fact in both places.
     */
    const movedAt = state.lastRecordedAt ?? state.occurredAt;
    if (movedAt !== null) {
      const resolvedDetail =
        state.status === 'resolved' && state.resolution !== null && state.resolution !== ''
          ? `Resolved: ${state.resolution}`
          : whoHasIt(state, directory);
      updates.push({
        at: movedAt,
        kind: 'incident',
        headline: `${categoryLabel(state.category?.value ?? 'other')} — ${stageLabel(
          stageOf(state.status),
        ).toLowerCase()}`,
        detail: resolvedDetail,
      });
    }

    if (!live) continue;

    /**
     * The importance panels — M10-42. Same headline/detail words as the update above (the
     * district's own vocabulary, kept in one place), same "no id" rule, and scoped to what is
     * open right now rather than to what has recently moved.
     *
     * `state.importance` is the only thing read here. Nothing about severity, acknowledgement
     * or the department it is with decides which of the two panels a row lands in — only which
     * order it sorts within one, in `capImportance`.
     */
    const importanceRow: ImportanceRow = {
      headline: `${categoryLabel(state.category?.value ?? 'other')} — ${stageLabel(
        stageOf(state.status),
      ).toLowerCase()}`,
      detail: whoHasIt(state, directory),
      acknowledged: state.acknowledgedAt !== null,
      severity: state.severity?.value ?? 'unknown',
      at: state.occurredAt,
    };
    (state.importance === 'important' ? important : routine).push(importanceRow);

    /**
     * **Today's carried items are on the panel too** — and this is the half that is easy to
     * miss.
     *
     * A meeting issued this morning for Monday has not finished, so it belongs on *Still
     * running* from the moment it is sent, not from tomorrow. The branch above catches the ones
     * that are no longer today's; this catches the ones that still are, and between them the
     * panel is the answer to *what has not finished*, whatever day it started on.
     */
    if (outlivesTheDay(state)) carried.push(carriedRowFor(state));

    // The same predicates the trend replay asks of an older state. One copy, deliberately.
    const counted = countsFor(state);

    openIncidents += 1;

    // Nobody was ever named as needing to know (M6-09). Distinct from `unassigned`, which is
    // the signals failing to place it, and from an unmet obligation, which is a message that
    // failed — this is the one that says the decision is still living in somebody's head.
    if (counted.nobodyTold) nobodyTold += 1;
    if (counted.ownerless) ownerless += 1;

    // Nobody has assessed it. Counted separately and never folded into a severity, because
    // "we do not know yet" is not a level of seriousness (ADR-0009).
    if (state.severity === null) unassessed += 1;

    const category = state.category?.value ?? 'other';
    const bucket = byCategory.get(category) ?? {
      open: 0,
      nobodyTold: 0,
      issued: 0,
      responded: 0,
      lastAt: null as string | null,
    };
    bucket.open += 1;
    /**
     * **Read from `counted`, never re-derived here — 2026-08-17.**
     *
     * These used to be `unacknowledged` (from `acknowledgedAt`) and `unassigned` (from
     * `responsibleDepartmentIds`), each tested inline, which is how this panel came to be
     * saying something the deck above it no longer said. `countsFor` decides both, so the card
     * and the tile answer with one rule.
     */
    if (counted.nobodyTold) bucket.nobodyTold += 1;
    if (counted.stage === 'issued') bucket.issued += 1;
    else if (counted.stage === 'responded') bucket.responded += 1;
    if (state.occurredAt !== null && (bucket.lastAt === null || state.occurredAt > bucket.lastAt)) {
      bucket.lastAt = state.occurredAt;
    }
    byCategory.set(category, bucket);

    if (state.responsibleDepartmentIds.length === 0) {
      unassigned += 1;

      if (state.occurredAt !== null) {
        const minutes = Math.max(
          0,
          Math.floor((now.getTime() - new Date(state.occurredAt).getTime()) / 60_000),
        );
        oldestUnassigned =
          oldestUnassigned === null ? minutes : Math.max(oldestUnassigned, minutes);
      }
    }

    // Where this one has reached. `countsFor` decided it, so the wall and the sparkline replay
    // read one definition — the rule this function's own header exists to state.
    stages[counted.stage] += 1;

    if (counted.unacknowledged) overdueUnacknowledged += 1;

    // Somebody was owed an alert and did not get one — see `countsFor`, which holds the rule for
    // this and for the replay behind the sparkline.
    if (counted.notificationUnmet) notificationsUnmet += 1;

    // ADR-0029 — WHO WAS TOLD, never which department holds it.
    //
    // `responsibleDepartmentIds` is the question that stopped having an answer: the district
    // removed the layer, so every emergency reported from here on carries an empty one and this
    // panel would have drained to nothing while still calling itself a panel.
    //
    // `dispatchedTo` is the field that separates *was anybody chosen at all* from *does a
    // department hold it* — the same field `nobodyTold` and `whoHasIt` already read, so this
    // panel and the counters above it cannot come to disagree about one emergency.
    for (const target of state.dispatchedTo) {
      officerTargets.push(target);
      const key = `${target.kind}:${target.id}`;
      const row = byOfficer.get(key) ?? { open: 0, unacknowledged: 0 };
      row.open += 1;
      if (state.acknowledgedAt === null) row.unacknowledged += 1;
      byOfficer.set(key, row);
    }
  }

  /**
   * The names, in one batch, AFTER the fold — ADR-0029.
   *
   * `dispatchNames` is `board.ts`'s, exported rather than written a second time: it is the same
   * question on a second screen, and the board has already paid for getting it wrong once
   * (`actorsFor` named the actors on the events and left four recipients as raw uuids).
   *
   * ⚠️ It runs **once for the whole feed**, never per incident. This screen is on a twenty-second
   * poll in front of a room, and a lookup per row is forty round trips every twenty seconds for
   * a panel that is usually not being read — `dispatchNames`'s own header makes that argument
   * about the board, and it is truer here.
   */
  const officerNames = await dispatchNames(
    pool,
    officerTargets,
    Object.fromEntries([...directory.entries()].map(([id, name]) => [id, { name }])),
  );

  return {
    district: {
      openIncidents,
      today,
      unassigned,
      overdueUnacknowledged,
      unassessed,
      oldestUnassignedMinutes: oldestUnassigned,
      carriedOver: {
        resolvedToday: carriedResolvedToday,
        stillOpen: carriedStillOpen,
        oldestOpenAt: oldestCarriedOpenAt,
      },
      nobodyTold,
      ownerless,
      stages,
      trend: districtTrend(grouped, now, midnight, onlyDepartmentId),
    },
    notificationsUnmet,
    categories: [...byCategory.entries()]
      .map(([category, b]) => ({ category, label: categoryLabel(category), open: b.open }))
      .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label)),
    situation: situationFrom(byCategory),
    // ADR-0029: nothing writes this any more. Kept and empty so an older client meeting a newer
    // server draws nothing rather than throwing.
    departments: [],
    officers: [...byOfficer.entries()]
      // A row nobody could name is DROPPED rather than drawn as an id. `wallSafetyViolations`
      // skips uuid-shaped strings, so an id here would not fail the request — it would simply
      // put thirty-six characters of hexadecimal on a screen read from four metres away, which
      // is the identity line ADR-0027 exists to have taken off the one screen that had it.
      .flatMap(([key, row]) => {
        const name = officerNames.get(key);
        return name === undefined ? [] : [{ name, ...row }];
      })
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)),
    updates,
    important,
    routine,
    carried,
  };
}

/**
 * Turn the per-category counts into the sentence the prototype's cards carry.
 *
 * The wording is chosen so the three states are distinguishable **without the colour** — one
 * man in twelve cannot separate the red from the green, and this is read by whoever is on
 * duty (INV-04).
 *
 * "Clear" here means *no open emergencies of this kind*, not "nothing to worry about" — the word
 * was **Normal** until 2026-08-17 and was changed for exactly that reason: a card asserting that
 * things are fine has to be right about the district, and this one only ever knew that its own
 * list was empty. The
 * district's categories are listed whether or not anything is open, so an empty board reads
 * as six calm cards rather than as a blank panel that might mean the page failed to load.
 */
const WATCHED: readonly string[] = ['fire', 'flood', 'rta', 'medical', 'security', 'other'];

function situationFrom(
  byCategory: ReadonlyMap<
    string,
    {
      open: number;
      nobodyTold: number;
      issued: number;
      responded: number;
      lastAt: string | null;
    }
  >,
): Dashboard['situation'] {
  const keys = [...new Set([...WATCHED, ...byCategory.keys()])];

  return keys
    .map((category) => {
      const b = byCategory.get(category) ?? {
        open: 0,
        nobodyTold: 0,
        issued: 0,
        responded: 0,
        lastAt: null,
      };

      /**
       * **The district's own words here too — 2026-08-17, narrowed 2026-09-04.**
       *
       * This panel used to speak a private language: *With nobody*, *Not acknowledged*, *Being
       * handled*. He read the deployed wall and said the deck above it made sense now and this
       * did not, and he was right twice over.
       *
       * **`With nobody` was the department figure he had just had taken off the wall**, arriving
       * again in the loudest position on the screen — it read `unassigned`, which is true of
       * **31 of Bajaur's 40 incidents**, so four of six cards were red on a screen where red is
       * supposed to mean *look here*. That is the alert fatigue this codebase already removed the
       * permanently-green *online* bar for, rebuilt in the other direction.
       *
       * **`Acknowledged` was a fifth word here and is gone with it, 2026-09-04** — ADR-0034 means
       * confirming receipt is no longer a distinct act from responding (`domain/stages.ts`'s
       * header), so a category that would have read *Acknowledged* now reads *Issued*: nobody has
       * said what they are doing about it yet, which is the truth this word already carried.
       *
       * **The order is worst-first and unchanged in spirit**, which is what makes this a
       * translation rather than a new invention:
       *
       *   * **No one chosen** — nobody was ever told. Still the most specific bad thing that can
       *     be true of an open emergency, and it outranks a stage because an emergency nobody was
       *     told about *is* Issued; saying only *Issued* would lose the part somebody can fix in
       *     ten seconds.
       *   * **Issued** — waiting for an answer. What *Not acknowledged* meant, in the word the
       *     rest of the product now uses.
       *   * **Responded** — somebody has it, somebody is working on it. What *Being handled*
       *     meant.
       *   * **Clear** — nothing of this kind is open. **Not "nothing to worry about"**, which is
       *     why the word is not *Normal* any more: a card that says everything is fine is a card
       *     that has to be right, and this one only ever knew that its own list was empty.
       *
       * ⚠️ **The furthest-behind stage wins, never the commonest.** A category with three
       * Responded and one Issued reads **Issued**, because an aggregate that reported the
       * majority would hide the one emergency nobody has answered — INV-04, on the panel most
       * likely to be glanced at rather than read.
       */
      const [state, status]: ['ok' | 'pending' | 'critical', string] =
        b.nobodyTold > 0
          ? ['critical', 'No one chosen']
          : b.issued > 0
            ? ['pending', 'Issued']
            : b.responded > 0
              ? ['ok', 'Responded']
              : ['ok', 'Clear'];

      return {
        category,
        label: categoryLabel(category),
        state,
        status,
        open: b.open,
        lastAt: b.lastAt,
      };
    })
    .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}

/**
 * ~~The published emergency numbers.~~ **Removed — M6-14.**
 *
 * 1122, 15 and 16 used to be a panel here. The district asked for them to go, and the sentence
 * they asked in — *"no need of emergency contact numbers"* — means the opposite of how it first
 * reads and is worth stating plainly so nothing rebuilds this:
 *
 * It does **not** mean remove officers' numbers. Those became the centre of the product in M6:
 * the control room selects who to tell, and `GET /contacts/department/:id`, `web/src/contact.ts`
 * and `/contacts/recipients` are what that runs on. **Do not delete anything named "contacts"
 * on the strength of this comment.**
 *
 * What went is the panel of *published* numbers, and it went because it earns nothing on a
 * 1920×1080 screen with fourteen panels competing for nine slots (ADR-0015). Everybody in that
 * room already knows 1122. The numbers a district needs on a wall are the ones nobody has
 * memorised, and those are somebody's mobile, which must never be on a screen a room can read
 * (ADR-0013 §1).
 *
 * The `contacts` field is gone from the feed rather than emptied. An empty array would leave a
 * panel that renders nothing and a client that keeps asking; a missing field makes the removal
 * visible to whoever next reads this response, and a test pins that it stays gone.
 */

/**
 * 🔴 **WHAT THE WALL MAY CALL THE THING META IS COMPLAINING ABOUT — AND THE NUMBER IS NEVER
 * PRINTED.** Found 2026-08-21, by CI, and it was a live defect rather than a hardening task.
 *
 * ## The failure, which is the worst shape this product has
 *
 * `accountTrouble`'s rows are keyed `(kind, subject)`, and for `kind: 'number'` the **subject is
 * the district's own phone number**. That went into this row verbatim, as
 * *"Meta says 923363920520 is FLAGGED"* — and `wallSafetyViolations` matches a Pakistani number
 * shape anywhere in the payload and **fails the whole request** rather than stripping the field.
 *
 * So `GET /dashboard` answered **500** and **the wall went blank** — on exactly the morning Meta
 * flagged Bajaur's number, which is the one morning that row exists to be read on. A safety check
 * whose only way of speaking is to kill the screen is O-40's lesson arriving on a different
 * surface: *the check was right and where it fired was not.*
 *
 * ⚠️ **It is data-dependent, which is why it passed for two days.** The row is only drawn when
 * Meta is saying something **worse than `ok`**, and the district's number has been `GREEN`
 * throughout. It reddened CI on a run where a test's own `FLAGGED` fixture happened to be the
 * worst standing notice, and passed on the runs where it was not.
 *
 * ## The rule this settles, and it is not "sanitise the string"
 *
 * **Print what an operator must choose between; name what there is only one of.**
 *
 *   * A **template** keeps its name. There are four, the operator has to know *which* one Meta
 *     paused, and the names are this district's own rather than arbitrary digits.
 *   * The **number** is named and never printed. There is exactly one, so the digits tell a
 *     control room nothing it does not know — and ADR-0013 §1 is that nothing private goes on a
 *     screen a room can read. The wall rule was right; the row was wrong to feed it.
 *   * The **account** is named for the same reason twice over: a WABA id is a long run of digits
 *     that is both unreadable at four metres and one unlucky substring away from tripping the
 *     same rule.
 *
 * ⚠️ **Nothing is lost.** The verbatim subject is still in `whatsapp_account_state`, still in the
 * `error` line the webhook writes, and still what somebody pastes into a Meta console — a journal
 * is opened on purpose by one person, and a wall is read by accident by a room.
 */
function troubleSubject(trouble: { readonly kind: string; readonly subject: string }): string {
  if (trouble.kind === 'template') return trouble.subject;
  if (trouble.kind === 'number') {
    // The tier's reserved subject is not a number at all — see `LIMIT_SUBJECT`, which exists so a
    // `FLAGGED` notice and the messaging tier cannot overwrite each other.
    return trouble.subject === LIMIT_SUBJECT ? 'the messaging limit' : 'this district’s own number';
  }
  return 'the WhatsApp account';
}

/**
 * Whether the district's own machinery is working.
 *
 * Three facts, each one a thing that fails quietly:
 *
 *   * **the record is being copied** — a backup that stopped running looks exactly like one
 *     that is running, right up until somebody needs it
 *   * **there is a second machine** — one server holds Bajaur's entire emergency record
 *     (R-07), and nothing about a working system says so
 *   * **alerts can leave the building** — until the accounts exist, an alert reaches the app
 *     and nothing else, which an officer not looking at the app cannot know (R-05)
 *
 * All three are already computed elsewhere and already visible in a console. The point of
 * repeating them here is that a console is opened on purpose and a wall is read by accident.
 */
async function districtCondition(
  pool: Pool,
  now: Date,
  /** Whether this installation has a WhatsApp account at all — M6-25. */
  whatsappConfigured = false,
): Promise<Dashboard['condition']> {
  const [backup, replication, whatsapp, trouble, reached, tier] = await Promise.all([
    pool
      .query<{ last: string | null }>(
        `SELECT max(finished_at) AS last FROM backup_run WHERE status = 'succeeded'`,
      )
      .then((r) => r.rows[0]?.last ?? null)
      .catch(() => null),
    replicationHealthSafe(pool),
    // Never allowed to take the panel down with it. A diagnostic that can break the screen it
    // reports on is the same mistake `replicationHealthSafe` already exists to avoid.
    whatsappHealth(pool).catch(() => ({ sent: 0, delivered: 0, failed: 0 })),
    /**
     * **What Meta says about the account, which this row has argued for since M6-25 and never
     * had** — 2026-08-21.
     *
     * The comment below names *"a template somebody un-approved"* as one of the three silent
     * failures this panel exists for, and until now the row was folded from `whatsapp_message`:
     * how many of **our own sends** succeeded in the last day. That answers a weaker question. A
     * template Meta paused this morning reads as a perfectly quiet night until the first send
     * after it — and that send is at 02:00.
     *
     * Caught for the same reason its neighbour is: a diagnostic must never take down the screen
     * it reports on.
     */
    accountTrouble(pool).catch(() => null),
    /**
     * **How close the district is to Meta's own cap** — 2026-08-21.
     *
     * The numerator is free: `whatsapp_message` has recorded every send since M6-19, and the cap
     * counts *unique recipients*, so this is a `count(DISTINCT to_phone)`. The denominator is
     * Meta's and is polled by `ops/whatsappNumber.ts` — see `tierAllows` for why an unknown tier
     * draws no fraction at all rather than one against a guessed number.
     */
    recipientsReached(pool).catch(() => 0),
    messagingTier(pool).catch(() => null),
  ]);

  /**
   * `null` whenever the tier has never been read, or is one this code does not know, or is
   * uncapped. **The wall then says nothing about capacity**, which is ADR-0005's rule applied to a
   * denominator: a fraction against an assumed cap would read as measured.
   */
  const allowed = tierAllows(tier);
  const usedShare = allowed === null ? null : reached / allowed;

  const hours =
    backup === null ? null : Math.floor((now.getTime() - new Date(backup).getTime()) / 3_600_000);

  return [
    {
      what: 'Record backed up',
      state: hours === null ? 'critical' : hours > 36 ? 'critical' : hours > 24 ? 'pending' : 'ok',
      detail:
        hours === null
          ? 'never — no successful backup has been taken on this machine'
          : hours < 1
            ? 'within the last hour'
            : `${String(hours)} hours ago`,
    },
    {
      what: 'Second machine',
      state: replication.role === 'primary' && replication.ok ? 'ok' : 'critical',
      detail:
        replication.role === 'standalone'
          ? 'none — one machine holds the district’s whole record'
          : replication.role === 'primary'
            ? `${String(replication.connectedStandbys)} standby connected`
            : replication.role,
    },
    /**
     * Whether the district can actually send a message — M6-25.
     *
     * Here beside the backup and the standby for the same reason all three are here: **it fails
     * silently.** An account out of credit, an expired token, a template somebody un-approved
     * — every one of them looks exactly like a quiet night, and the district finds out on the
     * night it matters. On the wall, in the room where the two offices sit, it is read by
     * accident, which is the only reliable way any of this gets fixed.
     *
     * "Not configured" is `pending`, not `critical`. It is the honest state until the Meta
     * account exists (R-05, R-19, R-20), the product works without it, and a permanent red row
     * that nobody can clear this week is how a district learns to ignore red rows.
     */
    /**
     * ⚠️ **What META says outranks what our own sends did, and the order is the point** —
     * 2026-08-21.
     *
     * A paused template refuses **every** message on it, so the district's own delivery figures
     * go on looking calm until the next send — and the row would report *"configured — nothing
     * sent in the last 24 hours"* over an account that cannot send at all. Meta's own word is
     * the stronger evidence and it is the one that names something somebody can act on: resubmit
     * the template, appeal the number, ring Meta about the account.
     *
     * The delivery figures are **not deleted** and remain the answer whenever Meta is saying
     * nothing — they are what catches the failures Meta does not report, such as a district line
     * that is down.
     */
    {
      what: 'Can send WhatsApp',
      state: !whatsappConfigured
        ? 'pending'
        : trouble !== null
          ? // This panel's three words are `ok`/`pending`/`critical` and Meta's grading is
            // `warn`/`critical`. Mapped here rather than by widening the panel: `pending` is what
            // every other amber row on this screen says, and a fourth word would be a new colour
            // on a wall to describe a state the district already has a word for.
            trouble.severity === 'critical'
            ? 'critical'
            : 'pending'
          : /**
             * ⚠️ **The cap outranks the delivery figures, and it is the one that fails forwards.**
             *
             * Every other signal on this row is about sends that already happened. This one is
             * about the ones that are **about to be refused** — at the cap, Meta rejects every
             * message to a handset this district has not already reached today, and the officers
             * that hits are precisely the ones nobody has managed to tell yet.
             *
             * `>= 1` is critical because there is nothing left. `>= 0.8` is amber because a
             * district that can see it coming can start telephoning, and finding out at 100% is
             * finding out too late.
             */
            usedShare !== null && usedShare >= 1
            ? 'critical'
            : usedShare !== null && usedShare >= 0.8
              ? 'pending'
              : whatsapp.sent > 0 && whatsapp.failed === whatsapp.sent
                ? 'critical'
                : whatsapp.failed > 0
                  ? 'pending'
                  : 'ok',
      detail: !whatsappConfigured
        ? 'no account yet — alerts are in-app only, and “Reach them” opens WhatsApp by hand (R-05)'
        : trouble !== null
          ? // Meta's own word, kept verbatim — it is what somebody pastes into a Meta console to
            // find out more, and a paraphrase is a state nobody can look up. **The SUBJECT is a
            // different matter — see `troubleSubject`.**
            `Meta says ${troubleSubject(trouble)} is ${trouble.event}` +
            (trouble.detail === null ? '' : ` — ${trouble.detail}`)
          : /**
             * **The capacity sentence wins over the delivery one when it is worth saying, and
             * only then.**
             *
             * A permanently-present *"3 of 250 officers reached today"* is a figure people stop
             * reading, and then it is not there on the morning it says 240 — `moreSentence`'s rule
             * and the carry-over strip's, applied to a third place. So it is drawn from 50%, and
             * below that the row goes on answering the older and still useful question of whether
             * what we sent actually arrived.
             */
            usedShare !== null && usedShare >= 0.5 && allowed !== null
            ? `${String(reached)} of ${String(allowed)} officers reached today — Meta caps this number per 24 hours`
            : whatsapp.sent === 0
              ? 'configured — nothing sent in the last 24 hours'
              : `${String(whatsapp.delivered)} of ${String(whatsapp.sent)} delivered in 24 hours` +
                (whatsapp.failed === 0 ? '' : ` · ${String(whatsapp.failed)} failed`),
    },
  ];
}

export interface Viewer {
  /** What the heading says this dashboard is: "District" or the department's own name. */
  readonly scope: string;
  /**
   * Null means **the whole district**, and it is only ever reached by a district-tier seat.
   * It must never be reached by a caller who simply has no department, which is what a
   * person holding no post looks like — see `viewerFor`.
   */
  readonly departmentId: string | null;
  readonly isAdministration: boolean;
  /**
   * False only for a caller holding no post. Nothing may be built from such a viewer; it
   * exists so that a missing seat is a value this module can refuse rather than a null that
   * reads, one branch later, as "the district".
   */
  readonly seated: boolean;
}

/**
 * What the district can send.
 *
 * A department gets its own fleet. The two offices get the sum of every department's, which is
 * the only figure that answers "is there anything left in the district" — the question asked
 * at the moment a second emergency arrives.
 */
async function resourcePanel(pool: Pool, viewer: Viewer): Promise<Dashboard['resources']> {
  const departments =
    viewer.departmentId !== null
      ? [viewer.departmentId]
      : (await listDepartments(pool))
          .filter((d) => d.retiredAt === null)
          .map((d) => d.departmentId);

  let total = 0;
  let available = 0;
  let committed = 0;
  let outOfService = 0;

  for (const id of departments) {
    const summary = summarise(await availabilityFor(pool, id));
    total += summary.total;
    available += summary.available;
    committed += summary.committed;
    outOfService += summary.outOfService;
  }

  return { total, available, committed, outOfService, scope: viewer.scope };
}

/**
 * How quickly emergencies are being taken up.
 *
 * Reuses the console's own calculation rather than a second one — a dashboard that computed
 * its own median would eventually disagree with the performance table, in front of the
 * officer whose department it is about.
 */
async function performancePanel(pool: Pool): Promise<Dashboard['performance']> {
  const report = await computePerformance(pool, { days: 7 });

  return (
    [...report.officers]
      /**
       * ⚠️ **TWO FILTERS WENT, AND NEITHER WAS DROPPED CARELESSLY — ADR-0029.**
       *
       * `!d.retired` asked *is this department still in the registry*. There is no registry to
       * be in, and an officer who held work in the window belongs on the record of that window
       * whether or not the contact has since been removed.
       *
       * The `viewer.departmentId` filter showed a department its own row and nobody else's.
       * ADR-0024 left no department holding an account, so it selected on a value only the
       * control room ever carries — and the control room's own `departmentId` is not null, so
       * it was one handover away from narrowing this panel to a single office's work with
       * nothing on the screen saying so.
       */
      // Whoever is furthest behind, first. A performance panel sorted alphabetically is one
      // where the officer who needs attention is wherever the alphabet put them.
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open)
      .slice(0, 8)
      .map((d) => ({
        name: d.name,
        open: d.open,
        overdue: d.overdue,
        medianAckMinutes: d.medianAckMinutes,
      }))
  );
}

export interface DashboardOptions {
  /** Whether this installation has a WhatsApp account, for the condition row (M6-25). */
  readonly whatsappConfigured?: boolean;
}

export async function buildDashboard(
  pool: Pool,
  viewer: Viewer,
  now = new Date(),
  options: DashboardOptions = {},
): Promise<Dashboard> {
  const [
    summary,
    utilities,
    presence,
    weather,
    news,
    facts,
    alerts,
    resources,
    performance,
    condition,
    stored,
  ] = await Promise.all([
    districtSummary(pool, now, viewer.departmentId),
    listUtilities(pool),
    // A department sees where its own posts are; the offices see the administration's.
    listPresence(pool, viewer.departmentId),
    weatherPanel(pool, now),
    /**
     * Headlines, on the same terms as the weather: whatever was last fetched, with its age.
     *
     * In the same `Promise.all` and therefore unable to delay the district's own numbers by more
     * than one database read — the network call happens on a background timer in `main.ts`, not
     * here. A dashboard that waited on Google would be a dashboard that goes down when Google
     * does, on the screen a control room watches.
     */
    newsPanel(pool, now),
    listFacts(pool),
    liveAlerts(pool),
    resourcePanel(pool, viewer),
    performancePanel(pool),
    /**
     * Whether the record is backed up, whether there is a standby, whether alerts can leave
     * the building — the two offices only.
     *
     * Not secrecy: it is that these are **theirs to fix**. A department shown three red rows
     * it can do nothing about learns to ignore red rows, and that habit costs something the
     * day one of them is about its own work (ADR-0005).
     */
    viewer.isAdministration
      ? districtCondition(pool, now, options.whatsappConfigured === true)
      : Promise.resolve([]),
    /**
     * The arrangement this scope chose, if it chose one — ADR-0015.
     *
     * A department falls back to the **district's** layout before falling back to the
     * built-in default, which is the order the district would expect: the two offices set up
     * the screen, and a department that has not touched it gets what the district decided
     * rather than what this file decided a year ago.
     */
    loadLayout(pool, viewer.departmentId).then(
      async (own) => own ?? (viewer.departmentId === null ? null : loadLayout(pool, null)),
    ),
  ]);

  // One table, two panels. The split is data, so the district can add a fifth kind of thing
  // to watch without a release (migration 0017).
  const utilityPanel = utilityRows(
    utilities.filter((u) => u.panel === 'utility'),
    now,
  );
  const servicePanel = utilityRows(
    utilities.filter((u) => u.panel === 'services'),
    now,
  );

  const gapOf = (rows: readonly PanelRow[]): { total: number; answering: number; quiet: number } =>
    reportingGap(
      rows.map((r) => ({
        value: r.status,
        freshness: r.freshness,
        asOf: r.asOf,
        ageMinutes: r.ageMinutes,
      })),
    );

  /**
   * Which officers appear — ADR-0033.
   *
   * Exactly the seats the control room has curated onto the wall (`seat.on_wall`), name and
   * designation both. A district that has picked nobody gets an empty panel, which reads as
   * *nobody on the wall* — the honest answer, not a broken one.
   *
   * The `viewer.isAdministration` split is gone: the wall pick is one list the control room
   * maintains, and there are no department accounts left to scope it to (ADR-0024). Capped at
   * twelve so a runaway pick cannot push the wall past its fold.
   */
  const presencePanel = presenceRows(
    presence.filter((p) => p.onWall),
    now,
  ).slice(0, 12);

  return {
    asOf: now.toISOString(),
    scope: viewer.scope,
    isAdministration: viewer.isAdministration,
    ...summary,
    utilities: utilityPanel,
    services: servicePanel,
    presence: presencePanel,
    facts: facts.map((f) => ({ label: f.label, value: f.value })),
    alerts: alerts.map((a) => ({
      tag: a.tag,
      message: a.message,
      issuedAt: a.issuedAt,
      untilAt: a.untilAt,
    })),
    /**
     * The two streams merged, then windowed **once** — M9-38, M9-40.
     *
     * Advisories and emergency updates are the same thing to whoever is reading the wall:
     * *what has been happening*. Keeping them in two lists would mean two rotations, and the
     * twentieth item of each would be a different age — so the screen would hold a two-hour-old
     * advisory while dropping a twenty-minute-old emergency, and nobody could say why.
     */
    activity: (() => {
      const merged = windowActivity(
        [
          ...summary.updates,
          ...alerts.map((a) => ({
            at: a.issuedAt,
            kind: 'alert' as const,
            headline: a.message,
            detail: `${a.tag} · until ${hhmm(a.untilAt)}`,
          })),
        ],
        now,
      );
      /**
       * **No `hours` any more.** The window is the district's day, so a number of hours would be
       * a figure the panel could not honestly print — `since` already says where it starts, and
       * it is what every screen reads.
       */
      return { ...merged, more: moreSentence(merged) };
    })(),
    // M10-24. Capped independently — a busy "important" panel saying "and 6 more" must never
    // borrow room from "routine", or vice versa; each says only what it is itself hiding.
    importantEmergencies: (() => {
      const w = capImportance(summary.important);
      return { ...w, more: moreImportanceSentence(w) };
    })(),
    routineEmergencies: (() => {
      const w = capImportance(summary.routine);
      return { ...w, more: moreImportanceSentence(w) };
    })(),
    /**
     * The district's five — capped independently of everything else, on `capImportance`'s own
     * rule: a panel saying "and 6 more" must never borrow room from another, and must say only
     * what it is itself holding back.
     */
    stillRunning: (() => {
      const w = capCarried(summary.carried);
      return { ...w, more: moreCarriedSentence(w) };
    })(),
    reporting: {
      utilities: gapOf(utilityPanel),
      services: gapOf(servicePanel),
      presence: gapOf(presencePanel),
    },
    weather,
    news,
    resources,
    performance,
    condition,
    /**
     * What to draw, in order — ADR-0015, M6-30.
     *
     * `resolveLayout` drops a panel this viewer's audience does not include, whatever the
     * stored layout says. That is a control and not tidying: a layout is data, and data can be
     * written by a `config_event` somebody crafted (INV-05).
     *
     * `stored ?? DEFAULT_LAYOUT` is where M6-29 lands — a layout that is missing **or corrupt**
     * (`parseLayout` returns null for both) renders the built-in nine that fit 1920×1080. A
     * screen that goes blank because a configuration row was malformed is a district that
     * cannot see its own emergencies.
     */
    layout: resolveLayout(stored ?? DEFAULT_LAYOUT, viewer).panels,
  };
}

export interface DashboardReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Who is asking, and therefore what this dashboard is about.
 *
 * The two administrative offices see the district. Everybody else sees their own department.
 * A **seat** holding no department at all — a control-room seat — sees the district too,
 * because that is what its work is; it simply has no departmental version to fall back to.
 *
 * **This used to key on `departmentId === null`, and that was a cross-department read leak.**
 * Two entirely different callers have a null department: a control-room seat, which should
 * see the district, and a person holding **no seat at all** — relieved of their post, or
 * granted a login and never given one — who should see nothing. The test that was supposed to
 * cover this hand-built its `Identity` and defaulted it to `seatId: null, departmentId: null,
 * tier: 'district'`, so it asserted the district view for precisely the shape that had to be
 * refused. Losing your post *widened* your view, which is the opposite of what re-resolving
 * the seat on every request is for.
 *
 * That leak was closed two ways, and one of them has since been overtaken. It keyed on
 * **tier** rather than on a null department — still true below — and callers with no seat were
 * refused at the router. **ADR-0032 ended the second half.** An account minted through
 * Settings → Accounts carries a `role` and no `duty_assignment`, and since ADR-0018 / ADR-0024
 * the only accounts that sign in are the control room's, and since ADR-0030 there is no
 * per-department scope for a missing seat to fall through to. So a seatless authenticated
 * caller *is* the district's control room, and reads the district — with `isAdministration`
 * from the access role, exactly as a seated one would.
 */
export function viewerFor(identity: Identity): Viewer {
  // A caller with no duty seat is a control-room account (ADR-0032). It reads the district,
  // because that is the only read scope left (ADR-0030) and its work is the whole district.
  if (identity.seatId === null || identity.tier === null) {
    return {
      scope: 'District',
      departmentId: null,
      isAdministration: identity.isAdministration,
      seated: true,
    };
  }

  if (identity.tier === 'district') {
    return {
      scope: 'District',
      departmentId: null,
      isAdministration: identity.isAdministration,
      seated: true,
    };
  }

  return {
    scope: identity.departmentName ?? 'My department',
    departmentId: identity.departmentId,
    isAdministration: false,
    seated: true,
  };
}

export async function handleDashboard(
  pool: Pool,
  req: IncomingMessage,
  identity: Identity,
  options: DashboardOptions = {},
): Promise<DashboardReply> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };

  const feed = await buildDashboard(pool, viewerFor(identity), new Date(), options);

  const violations = wallSafetyViolations(feed);

  if (violations.length > 0) {
    /**
     * Refuse outright rather than strip the offending field.
     *
     * Stripping would let a change that started leaking private data ship and keep working,
     * minus one column, with nobody ever finding out. A dashboard that goes blank in the DC
     * office gets a phone call within the hour.
     *
     * The reason this check exists at all: this same response is what appears on a large
     * screen in an office, where it is read by whoever happens to be in the room.
     */
    return {
      status: 500,
      body: { error: 'refused: this response is not safe to display', violations },
    };
  }

  return { status: 200, body: feed };
}

export function writeDashboard(res: ServerResponse, reply: DashboardReply): void {
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}
