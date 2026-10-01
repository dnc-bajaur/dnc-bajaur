/**
 * The district's own reports — M7-26…M7-30.
 *
 * The owner's requirement, in their words: *"data and performance tracking only on the data the
 * control room gives, and who responded to their WhatsApp messages, how many acknowledgments,
 * how many resolutions — and date-wise reports with a download option."*
 *
 * Three things here, and one rule that governs all of them.
 *
 * ## The rule: the three acknowledgement routes are never added together
 *
 * M7-30, and it is the reason these are not one report. *The officer tapped a link*, *the
 * officer replied*, and *an operator says they were told on the telephone* are evidence of very
 * different strength — and a provider's `delivered` is not evidence of anything a human did.
 * A single "acknowledged: 43" merges a machine's observation with a person's recollection, and
 * that is a figure nobody can defend in a meeting with the Deputy Commissioner.
 *
 * So every report carries the routes as separate columns **and** says so in a header line, and
 * the totals are only ever presented as a breakdown.
 *
 * ## Date ranges, not "the last 30 days"
 *
 * M7-27. A district reports on *July*, or on *the week of the flood* — a rolling window cannot
 * express either, and a report that silently means "the last 30 days" is one that gives a
 * different answer to the same question next Tuesday. `from` and `to` are dates the district
 * chose, they are echoed in the file, and the file is named after them.
 */

import type { Pool } from '../db/pool.js';
import type { Seat } from '../domain/authority.js';
import { evaluateRead } from '../domain/authority.js';
import {
  districtDate,
  endOfNamedDistrictDay,
  startOfNamedDistrictDay,
} from '../domain/districtTime.js';
import { foldIncident, type IncidentState, type NotificationAttempt } from '../domain/incident.js';
import { loadRecentIncidents } from '../db/eventStore.js';
import { departmentDirectory } from '../ops/directory.js';
import { withDesignation } from '../domain/recipients.js';

/** U+FEFF. Excel reads a UTF-8 file as the local codepage without one — see `exportCsv.ts`. */
const BOM = '﻿';

/** The same ceiling the incident export uses, for the same reason: a short file is worse. */
export const REPORT_LIMIT = 5000;

export interface DateRange {
  /** Inclusive, at the start of that day in the server's own reckoning (Bajaur). */
  readonly from: string;
  /** Inclusive, at the end of that day. */
  readonly to: string;
  /**
   * The same two days as **the district would write them**, `YYYY-MM-DD`.
   *
   * Carried rather than derived from the instants above, and the reason is a bug this project
   * has already paid for once. Bajaur is UTC+05:00, so the start of 6 August locally is
   * `2026-08-05T19:00:00Z` — and `from.slice(0, 10)` therefore says **the fifth**. A report a
   * district downloads for one day would be headed "5 August to 6 August" and named after two
   * days it did not ask for.
   *
   * `board.ts` had the same fault in a different disguise, where `setHours` and `setUTCHours`
   * disagreed about when the district's day began and the dashboard and the board it opened
   * counted different incidents for five hours every night. Same lesson: **a date and an
   * instant are different things, and slicing one out of the other is where they part.**
   */
  readonly fromDate: string;
  readonly toDate: string;
  /** How far back the selection query has to reach to cover `from`. */
  readonly days: number;
}

export type RangeResult =
  { readonly ok: true; readonly range: DateRange } | { readonly ok: false; readonly error: string };

/**
 * Read `?from=&to=` as whole days, in the district's own timezone — M9-02.
 *
 * **Whole days, and Bajaur's midnight.** A district asking for "July" means the first of July to
 * the thirty-first, not 30.4 rolling days ending whenever the request was made — and the
 * midnight is the *district's*, because a handset set to another timezone would otherwise ask a
 * different question from the same screen. That is the exact bug `board.ts` had for four days,
 * where `setHours` and `setUTCHours` disagreed about when Bajaur's day began.
 *
 * **This function then made the same mistake in its third disguise.** `setHours` is the
 * *machine's* midnight, and the machine is Hetzner Helsinki on `Etc/UTC` (ADR-0019, confirmed
 * 2026-08-13) — so a report the district asked for as "13 August" was cut at 05:00 Bajaur time on
 * both ends, silently omitting five hours of the requested day and including five hours of the
 * one before. Now every boundary comes from `domain/districtTime.ts`.
 *
 * A named day is also **validated** rather than parsed loosely: `new Date('2026-02-30')` is
 * silently the 2nd of March, and a report headed with a day the district did not ask for is
 * worse than a refusal.
 *
 * Absent dates fall back to the last 30 days, which is what every existing caller gets today.
 */
export function parseRange(from: string | null, to: string | null, now = new Date()): RangeResult {
  const toDate = to ?? districtDate(now);
  const fromDate = from ?? districtDate(new Date(now.getTime() - 29 * 86_400_000));

  const startOfDay = startOfNamedDistrictDay(fromDate);
  const endOfDay = endOfNamedDistrictDay(toDate);

  if (startOfDay === null || endOfDay === null) {
    return { ok: false, error: 'from and to must be dates, as YYYY-MM-DD' };
  }

  if (startOfDay > endOfDay) {
    // Said plainly rather than silently swapped. A swapped range would hand back a file that
    // looks right and answers a question nobody asked.
    return { ok: false, error: 'from is after to' };
  }

  const days = Math.ceil((now.getTime() - new Date(startOfDay).getTime()) / 86_400_000) + 1;

  return {
    ok: true,
    range: {
      from: startOfDay,
      to: endOfDay,
      fromDate,
      toDate,
      // Bounded the same way the incident export bounds `days`: a range nobody chose is a
      // range that grows until the report starts refusing.
      days: Math.min(Math.max(days, 1), 366),
    },
  };
}

/**
 * Every incident this seat may see whose emergency **occurred** inside the range.
 *
 * `occurredAt`, never arrival — the same rule search follows (ADR-0002). A report captured
 * offline in March and delivered in August belongs in March's report, or the district's worst
 * weeks, when devices were offline longest, are exactly the weeks that report emptiest.
 */
async function inRange(
  pool: Pool,
  seat: Seat,
  range: DateRange,
): Promise<{ readonly states: readonly IncidentState[]; readonly truncated: boolean }> {
  const grouped = await loadRecentIncidents(pool, range.days, REPORT_LIMIT + 1);

  const states: IncidentState[] = [];
  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    // Null only for an incident with no `reported` event at all, which cannot be placed in
    // any range and is dropped rather than filed under a date nobody chose.
    const at = state.occurredAt;
    if (at === null || at < range.from || at > range.to) continue;

    // The same `evaluateRead` the board, the export and search use. Not a second rule: a
    // report that showed one department's emergency to another would be a leak arriving
    // through a file that gets emailed onward.
    if (!evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds }).allowed) {
      continue;
    }

    states.push(state);
  }

  states.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
  return { states, truncated: grouped.length > REPORT_LIMIT };
}

//------------------------------------------------------------------------------
// The acknowledgement report — M7-28
//------------------------------------------------------------------------------

export interface AcknowledgementRow {
  readonly incidentId: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly category: string;
  readonly recipient: string;
  readonly reason: string;
  readonly channel: string;
  readonly toldAt: string;
  readonly state: string;
  /** `link`, `reply`, `operator`, `provider`, or blank. Never summed with the others. */
  readonly route: string;
  readonly minutesToAnswer: string;
  readonly said: string;
  readonly failure: string;
}

/** One line per **obligation**, not per incident — the question is who was told. */
export async function acknowledgementReport(
  pool: Pool,
  seat: Seat,
  range: DateRange,
): Promise<{ readonly rows: readonly AcknowledgementRow[]; readonly truncated: boolean }> {
  const [{ states, truncated }, departments] = await Promise.all([
    inRange(pool, seat, range),
    departmentDirectory(pool),
  ]);

  const names = new Map(Object.values(departments).map((d) => [d.departmentId, d.name]));
  const seats = await seatTitles(pool);
  const people = await personNames(pool);

  const rows: AcknowledgementRow[] = [];

  for (const state of states) {
    for (const attempt of state.notifications) {
      rows.push({
        incidentId: state.incidentId,
        occurredAt: state.occurredAt ?? '',
        kind: state.kind,
        category: state.category?.value ?? '',
        recipient: nameOf(attempt, names, seats, people),
        reason: attempt.reason,
        channel: attempt.channel,
        toldAt: attempt.attemptedAt,
        state: attempt.state,
        /**
         * Blank rather than a guess when the record does not know.
         *
         * Attempts settled before routes were recorded genuinely carry no route, and writing
         * one in would put a fact in a document that nobody observed — which is the same
         * failure ADR-0014 refuses for read receipts, arriving in a spreadsheet.
         */
        route: attempt.via ?? '',
        minutesToAnswer:
          attempt.settledAt === undefined || attempt.state !== 'delivered'
            ? ''
            : String(
                Math.max(
                  0,
                  Math.round(
                    (Date.parse(attempt.settledAt) - Date.parse(attempt.attemptedAt)) / 60_000,
                  ),
                ),
              ),
        said: attempt.said ?? '',
        failure: attempt.failure ?? '',
      });
    }
  }

  return { rows, truncated };
}

//------------------------------------------------------------------------------
// The resolution report — M7-29
//------------------------------------------------------------------------------

export interface ResolutionRow {
  readonly incidentId: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly category: string;
  readonly severity: string;
  readonly departments: string;
  readonly status: string;
  readonly acknowledgedAt: string;
  readonly acknowledgedVia: string;
  readonly minutesToAcknowledge: string;
  readonly resolution: string;
  readonly minutesToResolve: string;
  readonly stillOpen: string;
}

export async function resolutionReport(
  pool: Pool,
  seat: Seat,
  range: DateRange,
): Promise<{ readonly rows: readonly ResolutionRow[]; readonly truncated: boolean }> {
  const [{ states, truncated }, departments] = await Promise.all([
    inRange(pool, seat, range),
    departmentDirectory(pool),
  ]);
  const names = new Map(Object.values(departments).map((d) => [d.departmentId, d.name]));

  const rows = states.map((state) => {
    const closed = state.status === 'closed' || state.status === 'resolved';
    const settledAt = closedAt(state);

    return {
      incidentId: state.incidentId,
      occurredAt: state.occurredAt ?? '',
      kind: state.kind,
      category: state.category?.value ?? '',
      severity: state.severity?.value ?? 'unassessed',
      departments: state.responsibleDepartmentIds.map((id) => names.get(id) ?? id).join('; '),
      status: state.status,
      acknowledgedAt: state.acknowledgedAt ?? '',
      // The route is on this row too, for the same reason it is on the other report: an
      // acknowledgement a machine saw and one an operator recalls are not one number (M7-30).
      acknowledgedVia: state.acknowledgedVia ?? '',
      minutesToAcknowledge: minutes(state.occurredAt ?? '', state.acknowledgedAt),
      resolution: state.resolution ?? '',
      minutesToResolve: minutes(state.occurredAt ?? '', settledAt),
      // Spelled out rather than inferred from `status`, because this is the number the
      // district is asked for in a meeting and it should not need a lookup table to read.
      stillOpen: closed ? 'no' : 'yes',
    };
  });

  return { rows, truncated };
}

function closedAt(state: IncidentState): string | null {
  // The projection does not carry a resolution time, and the report needs one. Taken from the
  // last action rather than from the fold, because adding a field to `IncidentState` for one
  // report is how a projection grows columns nobody reads.
  return state.status === 'closed' || state.status === 'resolved'
    ? (state.actions.at(-1)?.at ?? state.lastRecordedAt)
    : null;
}

function minutes(from: string, to: string | null): string {
  if (to === null) return '';
  return String(Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000)));
}

//------------------------------------------------------------------------------
// The files
//------------------------------------------------------------------------------

/**
 * Neutralise a cell against formula injection, and quote it.
 *
 * A department name is operator-typed text and a spreadsheet executes a leading `=`. Same
 * function as `exportCsv.ts`'s, deliberately duplicated at four lines rather than exported
 * across modules — see the note there; what must never differ is the *projection*, and this is
 * formatting.
 */
/*
 * `localDate` used to live here — a calendar date built from a *local* instant with
 * `getFullYear`/`getMonth`/`getDate`. It is gone, and `districtDate` from
 * `domain/districtTime.ts` replaced it at its one call site (M9-02).
 *
 * The reason is worth leaving behind: it did the right thing on the laptop that wrote it and
 * the wrong thing on the server, for the same reason `parseRange` above did. "Local" is not a
 * property of the district; it is a property of whichever machine happens to be running.
 */

function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The header the district reads before the numbers — M7-30.
 *
 * Two lines of prose at the top of a spreadsheet, and they are the difference between a file
 * somebody can defend and a file somebody can be caught out by. It names the range, and it
 * names the four ways an answer can arrive and what each one is worth.
 */
function preamble(what: string, range: DateRange, truncated: boolean): readonly string[] {
  const lines = [
    cell(`${what} — District Nerve Center, Bajaur`),
    cell(`${range.fromDate} to ${range.toDate}, by when the emergency occurred`),
    cell(
      'How an answer arrived is recorded and never merged: link = the officer tapped the ' +
        'acknowledge link; reply = the officer replied on WhatsApp, matched by number; ' +
        'operator = the control room rang them and recorded what they said; provider = the ' +
        'message reached a handset and nobody answered.',
    ),
  ];

  if (truncated) {
    // Said in the file, not only in a response nobody keeps. A short file that does not admit
    // it is short is the one failure this whole export was written to avoid.
    lines.push(
      cell(
        `More than ${String(REPORT_LIMIT)} incidents in this range — this file is incomplete. ` +
          'Narrow the dates and download again.',
      ),
    );
  }

  lines.push('');
  return lines;
}

const ACK_COLUMNS = [
  'incident',
  'occurred',
  'kind',
  'category',
  'told',
  'why they were told',
  'channel',
  'told at',
  'outcome',
  'how we know',
  'minutes to answer',
  'what they said',
  'why it failed',
];

export function acknowledgementCsv(
  rows: readonly AcknowledgementRow[],
  range: DateRange,
  truncated: boolean,
): string {
  const body = rows.map((r) =>
    [
      cell(r.incidentId),
      cell(r.occurredAt),
      cell(r.kind),
      cell(r.category),
      cell(r.recipient),
      cell(r.reason),
      cell(r.channel),
      cell(r.toldAt),
      cell(r.state),
      cell(r.route),
      cell(r.minutesToAnswer),
      cell(r.said),
      cell(r.failure),
    ].join(','),
  );

  return `${BOM}${[
    ...preamble('Who was told, and who answered', range, truncated),
    ACK_COLUMNS.map(cell).join(','),
    ...body,
  ].join('\r\n')}\r\n`;
}

const RESOLUTION_COLUMNS = [
  'incident',
  'occurred',
  'kind',
  'category',
  'severity',
  'departments',
  'status',
  'acknowledged at',
  'how we know',
  'minutes to acknowledge',
  'resolution',
  'minutes to resolve',
  'still open',
];

export function resolutionCsv(
  rows: readonly ResolutionRow[],
  range: DateRange,
  truncated: boolean,
): string {
  const body = rows.map((r) =>
    [
      cell(r.incidentId),
      cell(r.occurredAt),
      cell(r.kind),
      cell(r.category),
      cell(r.severity),
      cell(r.departments),
      cell(r.status),
      cell(r.acknowledgedAt),
      cell(r.acknowledgedVia),
      cell(r.minutesToAcknowledge),
      cell(r.resolution),
      cell(r.minutesToResolve),
      cell(r.stillOpen),
    ].join(','),
  );

  return `${BOM}${[
    ...preamble('What was resolved, and what is still open', range, truncated),
    RESOLUTION_COLUMNS.map(cell).join(','),
    ...body,
  ].join('\r\n')}\r\n`;
}

//------------------------------------------------------------------------------
// Names
//------------------------------------------------------------------------------

async function seatTitles(pool: Pool): Promise<ReadonlyMap<string, string>> {
  // The holder, so a `post` recipient in the export's "told" column reads `Imtiaz Ahmad —
  // IT Soft`, holder then title — symmetric with `personNames` and the board / drawer. A
  // vacant post keeps its title alone.
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
       FROM seat s`,
  );
  return new Map(
    res.rows.map((r) => [
      r.seat_id,
      r.holder !== null ? withDesignation(r.holder, r.title) : r.title,
    ]),
  );
}

async function personNames(pool: Pool): Promise<ReadonlyMap<string, string>> {
  /**
   * `Rustam Khan — DDMA` — name and the post held — so the export's "told" column reads the
   * way the board and the drawer do (`backlog/whatsapp-response-workflow.md` §6). The post is
   * the one held longest (`dutySeatOfPerson`'s rule); a retired one names no designation, and
   * an officer holding none is named alone.
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
       FROM person p`,
  );
  return new Map(res.rows.map((r) => [r.person_id, withDesignation(r.full_name, r.designation)]));
}

/**
 * Who this obligation was owed to, as a human reads it.
 *
 * **Person first, then post, then department** — the same order `targetKey` prefers, because a
 * named officer and the post they happen to hold are two obligations and a report that
 * collapsed them would lose the one the control room actually chose.
 *
 * An id with no name is shown **as an id**, never blank. A blank cell in a column headed "told"
 * reads as nobody, which is the one reading a document like this must never offer.
 */
function nameOf(
  attempt: NotificationAttempt,
  departments: ReadonlyMap<string, string>,
  seats: ReadonlyMap<string, string>,
  people: ReadonlyMap<string, string>,
): string {
  if (attempt.personId !== undefined) return people.get(attempt.personId) ?? attempt.personId;
  if (attempt.seatId !== null) return seats.get(attempt.seatId) ?? attempt.seatId;
  if (attempt.departmentId !== undefined) {
    return `${departments.get(attempt.departmentId) ?? attempt.departmentId} (no post)`;
  }
  return '(unknown)';
}
