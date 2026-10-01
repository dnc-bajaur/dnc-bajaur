/**
 * What happened in the district over a chosen period — capability group 9.
 *
 * *"District summaries for any period"* was in the scope list. What existed was the console's
 * performance table, fixed to a rolling window of recent arrivals, offered only to the two
 * offices. Somebody asked "how did we do in July" and there was no way to answer.
 *
 * Three things this shares rather than reimplements, and each for a reason already paid for:
 *
 * 1. **The selection is `loadIncidentsMatching`** — the same occurred-at window search uses.
 *    A summary of July must mean emergencies that *happened* in July. A report captured on a
 *    handset with no signal on 30 June and delivered on 2 July belongs to June, and counting
 *    it in July would move the district's worst nights into whichever month the network came
 *    back (ADR-0002).
 * 2. **The calculation is `performanceOver`** — the same medians the console shows. A second
 *    one would eventually disagree with the table in front of the officer it is about.
 * 3. **The scoping is `evaluateRead`**, per incident, exactly as on the board. A department
 *    may summarise its own work and learns nothing about a neighbour's.
 *
 * So a summary cannot say something the board, the export and the console would not also say
 * about the same emergencies. What is new here is only the window and who may ask.
 */

import { loadIncidentsMatching } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import { evaluateRead, type Seat } from '../domain/authority.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { performanceOver, type DistrictPerformance } from './performance.js';
import { projectIncidents } from './board.js';
import { windowFor, type SearchRequest } from './search.js';
import { districtDate } from '../domain/districtTime.js';

/** The next calendar day, `YYYY-MM-DD` → `YYYY-MM-DD`. A calendar question, not a clock one. */
function nextDate(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/** How many incidents one summary may fold. Truncation is reported, never silent. */
export const SUMMARY_LIMIT = 5000;

/**
 * One figure on the report's KPI row, and the rows it leads to — M11-22.
 *
 * ## Why this waited, and what changed
 *
 * M11-22 was left `PART` on purpose, with the reason written into `reports.ts`: the figures came
 * from `performanceOver` and the drill-down's rows came from `projectIncidents`. **Two folds over
 * the same events**, and wiring a figure to a list across that gap would claim an agreement
 * nothing guaranteed — the exact defect this milestone spent itself removing, reintroduced on the
 * last screen.
 *
 * These counts close it by not being a second fold at all. They are folded from
 * **`projectIncidents`** — the same projection `GET /search` runs to produce the drill-down, and
 * the same one the board renders — so a figure and the rows it opens are one definition.
 *
 * ## The one difference that remains, and why it is stated rather than hidden
 *
 * A summary considers up to `SUMMARY_LIMIT` (5,000) incidents; one page of drill-down is
 * `SEARCH_LIMIT` (200). For any period inside that page the two sets are **identical**. Beyond
 * it the figure is still right and the list is one page of it — which the screen already says in
 * words (*"more matched than one page can fold"*). ⚠️ **That sentence is load-bearing now**: it
 * is what keeps a figure of 500 above 200 rows an honest statement rather than a contradiction.
 *
 * ## The shape is M11-16's, deliberately
 *
 * `attr`/`value`/`match` are exactly what a board facet carries, for exactly the same reason: the
 * browser reads the `data-` attribute the server wrote onto the row and compares as told, so it
 * holds no predicate of its own. One mechanism, two screens — rather than a second one here that
 * would drift from the first.
 */
export interface SummaryCount {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /**
   * The `data-` attribute to narrow the drill-down by, or `null` for a figure that **is** the
   * whole list — `reported` counts every row, so it clears the narrowing rather than applying
   * one. The board's `open` segment does the same thing for the same reason.
   */
  readonly attr: string | null;
  readonly value: string;
  readonly match: 'is' | 'has';
}

export interface Summary {
  /**
   * The period folded, as instants **and** as the two days the district would write — M11-28/30.
   *
   * 🔴 **`fromDate`/`toDate` are carried, never derived from the instants beside them**, and this
   * project has now paid for that four times: `board.ts`'s `setHours`/`setUTCHours`, the report
   * filename, `parseRange`'s own third disguise — and this endpoint, which was the fourth.
   *
   * **The defect here, found by giving this route its door (M11-28):** it read `?from=&to=`
   * through `windowFor`, which takes **instants** — and `Date.parse('2026-07-01')` is a perfectly
   * good instant, **UTC midnight**. Bajaur is UTC+05:00, so a district asking for July was answered
   * with 1 July **05:00 Bajaur** to 31 July **05:00 Bajaur**: the last nineteen hours of the month
   * missing, five hours of 30 June included instead, and `period` reporting the wrong window
   * confidently in ISO. Nobody had seen it because **nothing in `web/src/` had ever called this
   * route** — an endpoint with no door, which is this repository's own standing lesson.
   *
   * The route now parses with `parseRange` — whole **district** days, the same function the two
   * report downloads already use — so one district cannot come to have two definitions of "July".
   */
  readonly period: {
    readonly from: string;
    readonly to: string;
    readonly fromDate: string;
    readonly toDate: string;
  };
  /**
   * True when more incidents happened in the period than could be folded.
   *
   * **A summary is the one thing that must never quietly under-count.** A board that shows
   * fewer rows is visibly a list; a total that is short is a number somebody writes into a
   * report and defends in a meeting. Said out loud, so the answer can be "narrow the period"
   * rather than a wrong figure nobody questioned.
   */
  readonly truncated: boolean;
  /** `'post'` never occurs on this installation — every account is district tier (ADR-0031). */
  readonly scope: 'district' | 'post';
  readonly performance: DistrictPerformance;
  /**
   * **What the charts are drawn from — M11-23.** All three are folded in the pass that was
   * already happening, from the states this function already builds to scope them.
   *
   * Sent as **counts, not as a picture**: the shape belongs to whatever draws it, and a server
   * that returned pixels would have to be changed to change a chart.
   */
  readonly overTime: readonly { readonly date: string; readonly reported: number }[];
  readonly severityMix: readonly { readonly severity: string; readonly count: number }[];
  /**
   * 🔴 **The three routes an emergency is answered by, and they are NEVER summed — M11-24, M7-30.**
   *
   * `link` is an officer tapping the button on their own handset. `reply` is a message matched to
   * them by number, which is an **inference**. `operator` is the control room recording what they
   * were told on the telephone — a human statement. And a provider's `delivered` is evidence that
   * a handset received something, **not that any human did anything**.
   *
   * These are evidence of different strength about different acts, so there is no honest total.
   * **No `acknowledged: 43` anywhere** — not as a figure, not as a stacked bar's height, not in a
   * tooltip. Returned as separate rows precisely so that adding them requires somebody to write
   * the addition down, where it can be seen and refused.
   */
  readonly answerRoutes: readonly { readonly route: string; readonly count: number }[];
  /**
   * The clickable figures — M11-22, folded from `projectIncidents` so each leads to its own rows.
   *
   * ⚠️ **INV-04: `worst` and `unassessed` are never folded into one figure here.** They are
   * different facts — the worst thing somebody judged, and how many nobody judged at all — and a
   * KPI row is exactly where the temptation to compress them is strongest, because the space is
   * tightest. `unassessed` is its own count, and `worst` is not a count at all.
   */
  readonly counts: readonly SummaryCount[];
}

export async function districtSummaryFor(
  pool: Pool,
  seat: Seat,
  request: SearchRequest,
  now = new Date(),
  /**
   * The two days the caller actually asked for, `YYYY-MM-DD` — M11-28.
   *
   * Passed **in** rather than sliced out of the instants below, because slicing is the bug this
   * whole field exists to prevent. The route resolves them with `parseRange`; callers that only
   * have instants (the tests, and anything wanting a rolling window) get the district's own
   * reckoning of the instants instead, which is still never `from.slice(0, 10)`.
   */
  dates?: { readonly fromDate: string; readonly toDate: string },
): Promise<Summary> {
  const { from, to } = windowFor(request, now);

  const grouped = await loadIncidentsMatching(pool, {
    from,
    to,
    limit: SUMMARY_LIMIT + 1,
  });

  const truncated = grouped.length > SUMMARY_LIMIT;
  const considered = truncated ? grouped.slice(0, SUMMARY_LIMIT) : grouped;

  // Scoped before anything is counted. A department's summary must be built from its own
  // incidents, not from the district's totals with a filter applied afterwards — the second
  // would leak through any aggregate somebody forgot to filter (INV-05).
  const visible: (readonly IncidentEvent[])[] = [];
  /**
   * The folded states, kept rather than discarded — M11-23.
   *
   * This loop already folds every incident in order to scope it; the charts below need exactly
   * those states. Folding a second time to draw a chart would be the same work twice and, worse,
   * a second opportunity for the picture and the figures beside it to describe different sets.
   */
  const states: IncidentState[] = [];
  for (const events of considered) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    const readable = evaluateRead({
      seat,
      responsibleDepartmentIds: state.responsibleDepartmentIds,
    });
    if (readable.allowed) {
      visible.push(events);
      states.push(state);
    }
  }

  /**
   * **When things happened, by the district's own day** — never by the day they arrived.
   *
   * ADR-0002: a report captured on a handset with no signal on the 30th and delivered on the 2nd
   * belongs to the 30th. Counting arrivals would move the district's worst nights onto whichever
   * day the network came back, which is the same reasoning the whole period selection rests on.
   *
   * Every day in the range is present, including the empty ones. A chart that omitted quiet days
   * would close the gaps up and draw a district that was busier than it was (ADR-0005).
   */
  const byDay = new Map<string, number>();
  const fromDay = dates?.fromDate ?? districtDate(new Date(from));
  const toDay = dates?.toDate ?? districtDate(new Date(to));
  for (let day = fromDay; day <= toDay; day = nextDate(day)) byDay.set(day, 0);
  for (const state of states) {
    if (state.occurredAt === null) continue;
    const day = districtDate(new Date(state.occurredAt));
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const bySeverity = new Map<string, number>();
  for (const state of states) {
    // `unassessed` is a value and never a level (ADR-0009), so it is its own bar rather than
    // being folded into one of the four.
    const key = state.severity?.value ?? 'unknown';
    bySeverity.set(key, (bySeverity.get(key) ?? 0) + 1);
  }

  // 🔴 Counted apart and returned apart — see the note on `answerRoutes`. Nothing here adds them.
  const byRoute = new Map<string, number>();
  for (const state of states) {
    if (state.acknowledgedAt === null) continue;
    const route = state.acknowledgedVia ?? 'unrecorded';
    byRoute.set(route, (byRoute.get(route) ?? 0) + 1);
  }

  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

  /**
   * The rows themselves, through the projection the drill-down uses — M11-22.
   *
   * ⚠️ **This is the whole point of the task and it must not become `states.filter(...)`.** The
   * flags being counted (`unassessed`, `unacknowledged`, `overdue`, `nobodyTold`) are decided in
   * `toRow`, inside `projectIncidents`. Re-deriving them here from `IncidentState` would be a
   * second implementation of each rule, and the first one to drift would put a figure above rows
   * that disagree with it — which is precisely why M11-22 was left unfinished rather than wired
   * up across two folds.
   *
   * The cost is one more pass over events already in memory, on an office report screen.
   * `performanceOver` beside it already does the same.
   */
  const projected = await projectIncidents(pool, seat, visible, {
    now: now.toISOString(),
    /**
     * ⚠️ **`includeClosed`, and a test is what found it missing.**
     *
     * `projectIncidents` drops closed incidents unless asked, because its first caller was the
     * live board, where something already dealt with is not a queue item. A **report** is the
     * opposite question — it is *about* a period that has finished, and an emergency resolved on
     * the Tuesday is one of the things the district wants counted.
     *
     * `GET /search` passes this for the same reason, and that is the point: the drill-down and
     * these figures now make the same selection as well as the same fold. Without it the KPI
     * read 3 over a list of 4, which is this milestone's own defect wearing a new hat — and
     * `reports.e2e` test 15 caught it the moment the fixture grew an incident resolved without
     * ever being acknowledged.
     */
    includeClosed: true,
  });
  const rows = projected.incidents;
  const tally = (p: (r: (typeof rows)[number]) => boolean): number => rows.filter(p).length;

  const counts: SummaryCount[] = [
    // The whole list. No attribute, because there is nothing to narrow to — clicking it clears.
    { key: 'reported', label: 'reported', count: rows.length, attr: null, value: '', match: 'is' },
    {
      key: 'unacknowledged',
      label: 'nobody answered',
      count: tally((r) => r.unacknowledged),
      attr: 'unacknowledged',
      value: 'true',
      match: 'is',
    },
    {
      key: 'overdue',
      label: 'past deadline',
      count: tally((r) => r.overdue),
      attr: 'overdue',
      value: 'true',
      match: 'is',
    },
    {
      key: 'nobodyTold',
      label: 'no one chosen',
      count: tally((r) => r.nobodyTold),
      attr: 'nobodytold',
      value: 'true',
      match: 'is',
    },
    /**
     * ⚠️ Its own figure, and never merged with the worst severity — ADR-0009 and INV-04.
     *
     * *Nobody assessed these* is not a mild severity and it is not a footnote to `worst`. A row
     * reading `worst: critical (7 unknown)` is the aggregate hiding a fact in the one place the
     * invariant is most tempting to break, because a KPI row is where space is tightest.
     */
    {
      key: 'unassigned',
      label: 'no department',
      count: tally((r) => r.unassigned),
      attr: 'unassigned',
      value: 'true',
      match: 'is',
    },
    {
      key: 'unmet',
      label: 'message failed',
      count: tally((r) => r.notificationsUnmet),
      attr: 'unmet',
      value: 'true',
      match: 'is',
    },
    {
      key: 'unassessed',
      label: 'nobody assessed',
      count: tally((r) => r.unassessed),
      attr: 'unassessed',
      value: 'true',
      match: 'is',
    },
  ];

  return {
    counts,
    period: {
      from,
      to,
      // `districtDate` and never `slice(0, 10)` — see the note on `Summary.period`.
      fromDate: dates?.fromDate ?? districtDate(new Date(from)),
      toDate: dates?.toDate ?? districtDate(new Date(to)),
    },
    truncated,
    scope: seat.tier === 'district' ? 'district' : 'post',
    performance: await performanceOver(pool, visible, { now: now.toISOString(), days }),
    overTime: [...byDay.entries()].map(([date, reported]) => ({ date, reported })),
    severityMix: [...bySeverity.entries()].map(([severity, count]) => ({ severity, count })),
    answerRoutes: [...byRoute.entries()].map(([route, count]) => ({ route, count })),
  };
}
