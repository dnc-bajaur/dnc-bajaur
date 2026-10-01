/**
 * One day's report, gathered and rendered — M9-46…51.
 *
 * `domain/dailyReport.ts` folds; this gathers and renders. The split is the same one
 * `api/report.ts` makes for the post-incident report, and for the same reason: every judgement
 * about what a day contains is testable without a database.
 *
 * ## Two formats, one document
 *
 * **PDF is the print stylesheet, not a library.** ADR-0007 refuses a PDF dependency and that
 * stands — the browser already has a renderer, every officer already knows Ctrl+P, and the
 * printed page is then **the same document that was on screen**, which is the property that
 * matters when somebody signs one. A library would produce a second layout that drifts from the
 * first, and the drift is only ever discovered by the person holding the paper.
 *
 * **CSV is for analysis**, with the BOM the district's other exports carry so Excel opens Urdu
 * and Pashto names correctly rather than as mojibake.
 *
 * ## Authority is the incident's, not the report's
 *
 * `inRangeForDay` runs the same `evaluateRead` the board, the search and the existing exports
 * run, per incident. There is no separate "may read reports" permission to fall out of step with
 * it (INV-05) — and a report is the worst place for a leak to appear, because it is a file that
 * gets emailed onward.
 *
 * ~~The owner asked for **both** tiers (2026-08-13): the administration takes the district's day,
 * a department takes its own.~~ **⚠️ ONE TIER SINCE ADR-0029, 2026-08-25 — the district's.** That
 * request was answered under a model where a department signed in; ADR-0024 removed the accounts
 * on 2026-08-22 and this sentence outlived it by three days, which is this project's own most
 * expensive recurring failure. What was left was a `scope` line that could print *"This
 * department"* on the one document most likely to be read by somebody who was not there, and a
 * presence query narrowed by a department id only the control room ever carries.
 *
 * **The per-incident check is untouched and is still the whole of the authority here.**
 * `inRangeForDay` runs `evaluateRead` per incident, so what changed is the paper's title and one
 * `WHERE` clause — never who may read what.
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { loadRecentIncidents } from '../db/eventStore.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { evaluateRead, type Seat } from '../domain/authority.js';
import { departmentDirectory } from '../ops/directory.js';
import {
  buildDailyReport,
  type DailyReport,
  type DayAdvisory,
  type DayIncident,
  type DayOutstanding,
} from '../domain/dailyReport.js';
import {
  districtDate,
  endOfNamedDistrictDay,
  startOfNamedDistrictDay,
} from '../domain/districtTime.js';
import { isGeneral, type Uuid } from '../domain/events.js';
import { ownershipOf } from '../domain/ownership.js';
import { groupsFromEvents } from '../domain/recipientGroups.js';
import type { PresenceStatus } from '../domain/wall.js';
import { seatOf } from './lifecycle.js';

const BOM = '﻿';

/**
 * How far back the outstanding list looks.
 *
 * Long enough that a genuine forgotten emergency surfaces, short enough that the block stays a
 * signal rather than a graveyard. If this list is ever routinely long, the answer is not a bigger
 * number — it is that ADR-0020's assumption (the district closes its work within the day) is not
 * holding, which is the condition that ADR names for revisiting itself.
 */
const OUTSTANDING_DAYS = 30;

export type DailyResult =
  | { readonly ok: true; readonly report: DailyReport }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * The day, as a **date** rather than an instant — M9-49.
 *
 * `reports.ts` already paid for this lesson: Bajaur is UTC+05:00, so the start of 6 August
 * locally is 5 August at 19:00 UTC, and a report keyed to an instant files five hours of every
 * evening under the wrong day. `startOfNamedDistrictDay` is the one clock (Phase 1); nothing
 * here computes a boundary of its own.
 */
function boundsOf(date: string): { from: string; to: string } | null {
  const from = startOfNamedDistrictDay(date);
  const to = endOfNamedDistrictDay(date);
  if (from === null || to === null) return null;
  return { from, to };
}

interface DayStates {
  readonly states: readonly IncidentState[];
  /**
   * The saved groups each incident's dispatches expanded — Case 3, read off the same events the
   * fold sees, since `domain/dailyReport.ts` stays pure and takes only `states`. Group NAMES
   * only, keyed by incident id; the daily report has no per-recipient list to partition, unlike
   * the drawer/board/post-incident report, so a name is all a line can carry.
   */
  readonly groupsByIncident: ReadonlyMap<Uuid, readonly string[]>;
}

async function statesForDay(
  pool: Pool,
  seat: Seat,
  bounds: { from: string; to: string },
  now: Date,
): Promise<DayStates> {
  /**
   * Two days of history to cover one.
   *
   * `loadRecentIncidents` counts back in whole days from now, and "yesterday's report, run at
   * 09:00" needs a window that reaches back past yesterday's midnight. Asking for the number of
   * days between the requested date and today, plus two, is generous on purpose: a report that
   * is short by an hour at the boundary is a report that is silently wrong on exactly the
   * incidents most likely to matter.
   */
  const spanDays = Math.ceil((now.getTime() - Date.parse(bounds.from)) / 86_400_000) + 2;
  const grouped = await loadRecentIncidents(pool, Math.max(2, Math.min(spanDays, 400)), 5000);

  const states: IncidentState[] = [];
  const groupsByIncident = new Map<Uuid, readonly string[]>();
  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    // `occurredAt`, never arrival — the rule search and the exports already follow (ADR-0002).
    // A report captured offline in the morning and delivered at noon belongs to the morning.
    const at = state.occurredAt;
    if (at === null || at < bounds.from || at > bounds.to) continue;

    if (!evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds }).allowed) {
      continue;
    }
    states.push(state);
    const names = groupsFromEvents(events).map((g) => g.name);
    if (names.length > 0) groupsByIncident.set(state.incidentId, names);
  }
  return { states, groupsByIncident };
}

export async function dailyReport(
  pool: Pool,
  identity: Identity,
  date: string | null,
  now = new Date(),
): Promise<DailyResult> {
  const seat = seatOf(identity);

  const day = date ?? districtDate(now);
  const bounds = boundsOf(day);
  if (bounds === null) {
    return { ok: false, status: 400, error: 'date must be a real date, as YYYY-MM-DD' };
  }

  /**
   * **Only on today's report** — ADR-0020.
   *
   * *"Still outstanding"* is a statement about **now**. Putting it on a report for a past day
   * would make a printed page change meaning every time it was reprinted, which is the one thing
   * a record of a finished day must never do — the same reason advisories are the ones *issued*
   * that day rather than the ones currently live.
   */
  const isToday = day === districtDate(now);

  const [dayStates, departments, advisories, availability, outstanding] = await Promise.all([
    statesForDay(pool, seat, bounds, now),
    departmentDirectory(pool),
    advisoriesForDay(pool, bounds),
    availabilityForDay(pool, bounds),
    isToday ? outstandingBefore(pool, seat, bounds) : Promise.resolve([]),
  ]);
  const { states, groupsByIncident } = dayStates;

  const departmentNames: Record<string, string> = {};
  for (const [id, d] of Object.entries(departments)) departmentNames[id] = d.name;

  const [seats, people] = await Promise.all([seatTitles(pool), peopleNames(pool)]);

  return {
    ok: true,
    report: buildDailyReport({
      date: day,
      /**
       * Whose day this is, said on the paper — and since ADR-0029 there is one answer.
       *
       * This used to name the reader's own department when they were not the administration,
       * because a department's report and the district's are different documents and must not
       * be mistaken for each other on a desk. That distinction had already stopped existing:
       * ADR-0024 left no department holding an account, so the only people who can ask for
       * this report are the control room, and the branch drew *"This department"* on the one
       * document most likely to be read by somebody who was not there.
       *
       * ⚠️ **It is stated rather than derived, and that is the point.** A scope computed from
       * the reader is a report whose title changes depending on who printed it, which is the
       * one property a document that gets filed must not have.
       */
      scope: 'District Bajaur',
      generatedAt: now.toISOString(),
      states,
      groupsByIncident,
      outstanding,
      advisories,
      availability,
      departments: departmentNames,
      seats,
      people,
    }),
  };
}

/**
 * Emergencies from earlier days that **nobody ever responded to** — ADR-0020's obligation.
 *
 * The district's board resets nightly and escalation stops with the day. This is the only place
 * an emergency that survived a midnight is put back in front of a person, and it is deliberately
 * in the **morning report** rather than on the board: the reset was asked for in full, and what
 * this buys is that the case is found by somebody doing ordinary work rather than only by
 * somebody who already suspects something went wrong.
 *
 * **Not defined as "has an `escalation_ended` event."** That event is written by a job, and a job
 * that did not run is one of the exact conditions this list exists to expose. The definition is
 * the fact itself — *it is old, it is an emergency, and nobody responded to it* — so a stopped
 * scheduler makes the list longer rather than shorter.
 */
async function outstandingBefore(
  pool: Pool,
  seat: Seat,
  bounds: { from: string; to: string },
): Promise<readonly DayOutstanding[]> {
  const grouped = await loadRecentIncidents(pool, OUTSTANDING_DAYS, 2000);
  const departments = await departmentDirectory(pool);
  const out: DayOutstanding[] = [];

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;

    const state = foldIncident(first.incidentId, events);
    // Emergencies only. A meeting notice nobody replied to is not an unanswered emergency, and
    // putting it here would teach people that this block is mostly noise (M9-10, CARRIES_SLA).
    if (isGeneral(state.kind)) continue;
    // Option C: a decline fills `acknowledgedAt` but takes nothing. An emergency every
    // recipient refused is exactly what this list is for, so it is skipped only when somebody
    // is actually holding it.
    if (state.acknowledgedAt !== null && !ownershipOf(state.notifications).ownerless) continue;
    if (state.status === 'resolved' || state.status === 'closed') continue;

    // Strictly **before** today. Today's emergencies nobody has responded to yet are on today's
    // board, being chased right now, and listing them here would put live work under a heading
    // about the past.
    const at = state.occurredAt;
    if (at === null || at >= bounds.from) continue;

    if (!evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds }).allowed) {
      continue;
    }

    const date = districtDate(at);
    out.push({
      incidentId: state.incidentId,
      date,
      severity: state.severity?.value ?? 'unassessed',
      category: state.category?.value ?? 'unknown',
      departments: state.responsibleDepartmentIds.map((id) => departments[id]?.name ?? id),
      escalations: state.escalationCount,
      daysAgo: Math.max(
        1,
        Math.round(
          (Date.parse(bounds.from) - Date.parse(startOfNamedDistrictDay(date) ?? at)) / 86_400_000,
        ),
      ),
    });
  }

  return out;
}

async function seatTitles(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ seat_id: string; title: string }>(
    'SELECT seat_id, title FROM seat',
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.seat_id] = r.title;
  return out;
}

async function peopleNames(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ person_id: string; full_name: string }>(
    'SELECT person_id, full_name FROM person',
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.person_id] = r.full_name;
  return out;
}

/**
 * Advisories **issued** that day, whether or not they are still in force.
 *
 * `liveAlerts` answers a different question — what is in force *now* — and using it here would
 * make yesterday's report change every time somebody read it, which is the one thing a report
 * of a past day must never do.
 */
async function advisoriesForDay(
  pool: Pool,
  bounds: { from: string; to: string },
): Promise<DayAdvisory[]> {
  const { rows } = await pool.query<{
    issued_at: string;
    tag: string;
    message: string;
    until_at: string;
    issued_by: string | null;
  }>(
    `SELECT a.issued_at, a.tag, a.message, a.until_at, s.title AS issued_by
       FROM district_alert a
       LEFT JOIN seat s ON s.seat_id = a.issued_by
      WHERE a.issued_at >= $1 AND a.issued_at <= $2
      ORDER BY a.issued_at`,
    [bounds.from, bounds.to],
  );

  return rows.map((r) => ({
    issuedAt: r.issued_at,
    tag: r.tag,
    message: r.message,
    untilAt: r.until_at,
    issuedBy: r.issued_by,
  }));
}

/**
 * Every availability answer given that day — the district's, and since ADR-0029 only that.
 *
 * It took an 'Identity' to narrow to the reader's own department. ADR-0024 left no department
 * holding an account, so that narrowing selected on a value only the control room ever carries
 * and could quietly have hidden an officer's answer from the one document that reports the day.
 */
async function availabilityForDay(
  pool: Pool,
  bounds: { from: string; to: string },
): Promise<
  {
    reportedAt: string;
    seat: string;
    person: string | null;
    status: PresenceStatus;
    untilAt: string | null;
    reportedBy: string | null;
  }[]
> {
  const { rows } = await pool.query<{
    reported_at: string;
    seat: string;
    person: string | null;
    status: PresenceStatus;
    until_at: string | null;
    reported_by: string | null;
  }>(
    `SELECT p.reported_at, st.title AS seat, who.full_name AS person, p.status, p.until_at,
            by.title AS reported_by
       FROM presence_report p
       JOIN seat st ON st.seat_id = p.seat_id
       LEFT JOIN person who ON who.person_id = p.person_id
       LEFT JOIN seat by ON by.seat_id = p.reported_by
      WHERE p.reported_at >= $1 AND p.reported_at <= $2
      ORDER BY p.reported_at, st.title`,
    [bounds.from, bounds.to],
  );

  return rows.map((r) => ({
    reportedAt: r.reported_at,
    seat: r.seat,
    person: r.person,
    status: r.status,
    untilAt: r.until_at,
    reportedBy: r.reported_by,
  }));
}

//------------------------------------------------------------------------------
// CSV — M9-48
//------------------------------------------------------------------------------

function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // The same formula guard the other exports use: a cell opening with = + - @ is executed by
  // Excel, and this file is opened on the district's own machines.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const DAY_COLUMNS = [
  'section',
  'time',
  'kind',
  'category',
  'severity',
  'stage',
  'departments',
  // Was 'acknowledged at' / 'acknowledged by' — renamed 2026-09-04 with the concept
  // (`domain/stages.ts`'s header). The column underneath is unchanged: `acknowledgedAt`.
  'responded at',
  'responded by',
  // Case 2 (meeting): who is coming, on the rows that asked. Blank on every other row, and
  // `responded at` / `responded by` are blank on the rows that fill this one — a meeting has no
  // single responder. A column of its own so the spreadsheet stays pivot-friendly.
  'attendance',
  'resolved at',
  'resolution',
  'told',
  // Case 3 — the saved group a dispatch expanded, when one was; blank for a hand-picked
  // dispatch. A column of its own for the same reason 'attendance' is: `told` stays a count,
  // this only names which of them were one tick, and a spreadsheet pivoting on it needs the two
  // apart.
  'told via group',
  'not reached',
  'what was missing',
  'corrected',
  // M10-15. The column exists even on days nothing was withdrawn, because a district that
  // works from the spreadsheet must not be the district that never learns this can happen.
  'taken off the board',
];

/**
 * Who is coming, as one cell — the Case 2 (meeting) work. Empty for every row that did not ask.
 * `2 of 3 coming; 1 attending; 1 sending someone; 1 not attending; 1 silent`.
 */
function attendanceSummary(row: DayIncident): string {
  const a = row.attendance;
  if (a === null) return '';
  if (a.told === 0) return 'nobody asked';
  return [
    `${String(a.coming)} of ${String(a.told)} coming`,
    ...(a.attending > 0 ? [`${String(a.attending)} attending`] : []),
    ...(a.sendingSomeone > 0 ? [`${String(a.sendingSomeone)} sending someone`] : []),
    ...(a.notAttending > 0 ? [`${String(a.notAttending)} not attending`] : []),
    ...(a.unanswered > 0 ? [`${String(a.unanswered)} silent`] : []),
  ].join('; ');
}

function incidentRow(section: string, row: DayIncident): string {
  return [
    cell(section),
    cell(row.occurredAt),
    cell(row.kind),
    cell(row.category),
    cell(row.severity),
    cell(row.stage),
    cell(row.departments.join('; ')),
    cell(row.acknowledgedAt),
    cell(row.acknowledgedBy),
    cell(attendanceSummary(row)),
    cell(row.resolvedAt),
    cell(row.resolution),
    cell(row.told),
    cell(row.toldGroups.join('; ')),
    cell(row.unmet),
    cell(row.gap),
    cell(row.corrected),
    cell(row.withdrawn),
  ].join(',');
}

export function dailyCsv(report: DailyReport): string {
  const lines: string[] = [
    cell(`Daily report — ${report.scope}, ${report.date}`),
    cell(report.summary),
    cell(`Generated ${report.generatedAt}. Times are Asia/Karachi, the district's own clock.`),
    '',
    DAY_COLUMNS.map(cell).join(','),
  ];

  for (const row of report.emergencies) lines.push(incidentRow('emergency', row));
  for (const row of report.communications) lines.push(incidentRow('communication', row));

  /**
   * The outstanding block is in the CSV too, not only on the printed page.
   *
   * A district that works from the spreadsheet must not be the district that never sees this.
   */
  if (report.outstanding.length > 0) {
    lines.push(
      '',
      cell('Never responded to, from earlier days — nothing is chasing these any more'),
      ['Day', 'Days ago', 'Severity', 'Category', 'Responsible', 'Escalations'].map(cell).join(','),
    );
    for (const o of report.outstanding) {
      lines.push(
        [
          o.date,
          String(o.daysAgo),
          o.severity,
          o.category,
          o.departments.join('; '),
          String(o.escalations),
        ]
          .map(cell)
          .join(','),
      );
    }
  }

  /**
   * Advisories and availability go in the **same file**, under their own headers.
   *
   * Three files is three things to email and two to lose. A spreadsheet with sections is
   * awkward to pivot and trivial to read, and the reader here is a person before it is a tool.
   */
  if (report.advisories.length > 0) {
    lines.push(
      '',
      cell('Advisories issued'),
      ['issued', 'tag', 'until', 'by', 'message'].map(cell).join(','),
    );
    for (const a of report.advisories) {
      lines.push(
        [cell(a.issuedAt), cell(a.tag), cell(a.untilAt), cell(a.issuedBy), cell(a.message)].join(
          ',',
        ),
      );
    }
  }

  if (report.availability.length > 0) {
    lines.push(
      '',
      cell('Where officers said they were'),
      ['reported', 'post', 'officer', 'status', 'until', 'recorded by'].map(cell).join(','),
    );
    for (const a of report.availability) {
      lines.push(
        [
          cell(a.reportedAt),
          cell(a.seat),
          cell(a.person),
          cell(a.label),
          cell(a.untilAt),
          cell(a.reportedBy),
        ].join(','),
      );
    }
  }

  // Never a blank file (M9-51). A zero-byte export is a fault somebody chases; a sentence is
  // an answer.
  if (report.empty) lines.push('', cell('Nothing was recorded on this day.'));

  return `${BOM}${lines.join('\r\n')}\r\n`;
}

//------------------------------------------------------------------------------
// The printed page — M9-47
//------------------------------------------------------------------------------

// The Seal of the Deputy Commissioner, Bajaur — the mark on the district's WhatsApp
// number, a base64 JPEG so the printed page needs no network (ADR-0007).
const DC_SEAL =
  'data:image/jpeg;base64,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';

/**
 * The district's official letterhead — the Deputy Commissioner's office, above the
 * report's own title. The seal (the mark on the district's WhatsApp number) is a
 * base64 JPEG carried inline: ADR-0007 says this page must render with no network.
 * Static — no interpolation, so it needs no escaping.
 */
const LETTERHEAD =
  '<header class="letterhead">' +
  '<p class="letterhead-eyebrow">Government of Khyber Pakhtunkhwa</p>' +
  '<img class="letterhead-seal" alt="Seal of the Deputy Commissioner, Bajaur" src="' +
  DC_SEAL +
  '" />' +
  '<p class="letterhead-office">Office of the Deputy Commissioner</p>' +
  '<p class="letterhead-district">District Bajaur</p>' +
  '<hr class="letterhead-rule" /><hr class="letterhead-rule" />' +
  '<p class="letterhead-system">District Nerve Center &middot; DNC Bajaur</p>' +
  '</header>';

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const td = (v: unknown): string =>
  `<td>${escape(v === null || v === undefined ? '—' : String(v))}</td>`;

function table(caption: string, rows: readonly DayIncident[]): string {
  if (rows.length === 0) return `<h2>${escape(caption)}</h2><p class="none">None.</p>`;

  return (
    `<h2>${escape(caption)} <span class="n">${String(rows.length)}</span></h2>` +
    '<table><thead><tr>' +
    ['Time', 'Kind', 'Category', 'Severity', 'Stage', 'Responsible', 'Responded', 'Outcome']
      .map((h) => `<th>${h}</th>`)
      .join('') +
    '</tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          // The gap rides on the row it belongs to, in words, rather than being counted in a
          // corner — the same rule the board follows (INV-03).
          `<tr${r.gap === null ? '' : ' class="gap"'}>` +
          td(r.occurredAt.slice(11, 16)) +
          td(r.kind) +
          td(r.category) +
          td(r.severity) +
          td(r.stage) +
          td(r.departments.join(', ') || 'nobody') +
          // Case 2 (meeting): the Responded column shows who is coming for a row that asked —
          // a meeting has no single responder — and `acknowledgedBy` otherwise.
          td(
            r.attendance !== null
              ? attendanceSummary(r) || '—'
              : (r.acknowledgedBy ?? (r.general ? '—' : 'nobody')),
          ) +
          `<td>${escape(r.resolution ?? '—')}` +
          (r.gap === null ? '' : `<br /><strong class="warn">${escape(r.gap)}</strong>`) +
          // "Corrected", never struck through and never removed — M9-53. On paper especially:
          // a line that is crossed out is a line somebody assumes did not happen.
          (r.corrected === null
            ? ''
            : `<br /><strong class="corrected">Corrected: ${escape(r.corrected)}</strong>`) +
          /**
           * On the paper, in its place, saying what happened to it — M10-15.
           *
           * **Not struck through and not moved to a footnote**, for the reason M9-53 already
           * settled for corrections: a crossed-out line reads as *this did not happen*, and
           * what happened here is that an emergency was reported and somebody decided it did
           * not belong on the board. Both halves are facts about the day.
           */
          (r.withdrawn === null
            ? ''
            : `<br /><strong class="corrected">Taken off the Record: ${escape(r.withdrawn)}</strong>`) +
          '</td></tr>',
      )
      .join('') +
    '</tbody></table>'
  );
}

/**
 * The whole document, self-contained, with a print stylesheet.
 *
 * No script, no fetch, no shell. It is opened, read, and printed — often on a machine in an
 * office with a fussy connection — and the one thing it must do is render. `report.css` is not
 * linked for the same reason: a stylesheet that fails to load turns a signed document into a
 * wall of unformatted text, and this page is small enough to carry its own.
 */
/**
 * **What survived a midnight** — ADR-0020's obligation, and the first thing on the page.
 *
 * Above the day's own tables on purpose. The district accepted that an emergency nobody has
 * responded to at midnight is pursued by no software afterwards; this block is what stands in
 * its place, and a
 * safety net printed below two tables is a safety net people scroll past.
 *
 * **Renders nothing at all when the list is empty** — which is the normal morning. A permanent
 * heading reading "Still outstanding: 0" is a heading that teaches people to stop reading it, the
 * same reason `moreSentence` returns null rather than "and 0 more".
 */
function outstandingHtml(report: DailyReport): string {
  if (report.outstanding.length === 0) return '';

  const rows = report.outstanding
    .map(
      (o) =>
        `<tr><td>${escape(o.date)}</td>` +
        `<td>${escape(o.daysAgo === 1 ? 'yesterday' : `${String(o.daysAgo)} days ago`)}</td>` +
        `<td>${escape(o.severity)}</td>` +
        `<td>${escape(o.category)}</td>` +
        `<td>${escape(o.departments.length === 0 ? 'nobody' : o.departments.join(', '))}</td>` +
        `<td>${escape(
          o.escalations === 0 ? 'never escalated' : `${String(o.escalations)} escalations`,
        )}</td></tr>`,
    )
    .join('');

  return (
    `<section class="outstanding">` +
    `<h2 class="warn">Never responded to, from earlier days ` +
    `<span class="n">${String(report.outstanding.length)}</span></h2>` +
    // Said in words, not left to the reader to infer from a red heading. Colour is never the
    // only carrier (INV-04), and this sentence is the one somebody must act on.
    `<p class="none">Nobody answered these, and nothing is chasing them any more. ` +
    `Open the day shown to see each one in full.</p>` +
    `<table><thead><tr><th>Day</th><th>When</th><th>Severity</th><th>Category</th>` +
    `<th>Responsible</th><th>Escalation</th></tr></thead><tbody>${rows}</tbody></table>` +
    `</section>`
  );
}

export function dailyHtml(report: DailyReport): string {
  const rows = (label: string, value: string): string =>
    `<div class="k"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Daily report — ${escape(report.scope)}, ${escape(report.date)}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; padding: 1.5rem;
         background: #f7f8fa; color: #111319; line-height: 1.45; }
  main { max-width: 60rem; margin: 0 auto; background: #fff; padding: 1.5rem;
         border: 1px solid #d8dce4; border-radius: 10px; }
  h1 { font-size: 1.3rem; margin: 0 0 0.3rem; }
  h2 { font-size: 1rem; margin: 1.6rem 0 0.4rem; border-bottom: 1px solid #d8dce4;
       padding-bottom: 0.2rem; }
  .n { color: #576070; font-weight: 400; }
  .summary { font-weight: 700; margin: 0.6rem 0 0; }
  .meta { color: #576070; font-size: 0.85rem; margin: 0.2rem 0 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #576070; font-weight: 700; border-bottom: 1px solid #d8dce4;
       padding: 0.3rem 0.4rem; }
  td { padding: 0.3rem 0.4rem; border-bottom: 1px solid #eef0f6; vertical-align: top; }
  tr.gap td { background: rgba(193, 20, 20, 0.06); }
  .warn { color: #c11414; }
  .corrected { color: #8a5a00; }
  .none { color: #576070; margin: 0.2rem 0 0; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.5rem;
       margin: 0.8rem 0 0; }
  .k dt { color: #576070; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .k dd { margin: 0; font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .letterhead { text-align: center; margin: 0 0 1.5rem; }
  .letterhead-eyebrow { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.22em;
       text-transform: uppercase; color: #576070; margin: 0; }
  .letterhead-seal { display: block; width: 78px; height: 78px; margin: 0.5rem auto 0.45rem;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .letterhead-office { font-family: Georgia, "Times New Roman", serif; font-size: 1.5rem;
       font-weight: 700; margin: 0; color: #111319; }
  .letterhead-district { font-family: Georgia, "Times New Roman", serif; font-size: 1.05rem;
       font-weight: 400; letter-spacing: 0.34em; text-transform: uppercase; margin: 0.15rem 0 0;
       color: #111319; }
  .letterhead-rule { border: 0; border-top: 2px solid #111319; margin: 0.7rem 0 0; }
  .letterhead-rule + .letterhead-rule { border-top-width: 0.75px; margin-top: 3px; }
  .letterhead-system { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.2em;
       text-transform: uppercase; color: #576070; margin: 0.5rem 0 0; }
  /*
    The printed page IS the page on screen (M9-47, ADR-0007 — no PDF library). What changes is
    only what paper cannot do: the card border, the ground, and page-breaking inside a row.
  */
  @media print {
    body { background: #fff; padding: 0; }
    main { border: none; padding: 0; max-width: none; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; }
    tr.gap td { background: none; }
    .warn { text-decoration: underline; }
    .letterhead { break-inside: avoid; }
  }
</style>
</head><body><main>
${LETTERHEAD}
<h1>Daily report — ${escape(report.scope)}</h1>
<p class="meta">${escape(report.date)} · times are Asia/Karachi · generated ${escape(
    report.generatedAt,
  )}</p>
<p class="summary">${escape(report.summary)}</p>
${outstandingHtml(report)}
<dl>
${rows('Emergencies', String(report.totals.emergencies))}
${rows('Communications', String(report.totals.communications))}
${rows('Not yet responded to', String(report.totals.unacknowledged))}
${rows('Still open', String(report.totals.unresolved))}
${rows('Reached nobody', String(report.totals.unmet))}
</dl>
${table('Emergencies', report.emergencies)}
${table('Communications', report.communications)}
<h2>Advisories issued ${
    report.advisories.length === 0
      ? ''
      : `<span class="n">${String(report.advisories.length)}</span>`
  }</h2>
${
  report.advisories.length === 0
    ? '<p class="none">None.</p>'
    : `<table><tbody>${report.advisories
        .map(
          (a) =>
            `<tr>${td(a.issuedAt.slice(11, 16))}${td(a.tag)}${td(a.message)}${td(
              `until ${a.untilAt.slice(0, 16).replace('T', ' ')}`,
            )}${td(a.issuedBy)}</tr>`,
        )
        .join('')}</tbody></table>`
}
<h2>Where officers said they were ${
    report.availability.length === 0
      ? ''
      : `<span class="n">${String(report.availability.length)}</span>`
  }</h2>
${
  report.availability.length === 0
    ? '<p class="none">Nobody reported.</p>'
    : `<table><tbody>${report.availability
        .map(
          (a) =>
            `<tr>${td(a.reportedAt.slice(11, 16))}${td(a.seat)}${td(a.person)}${td(a.label)}${td(
              a.untilAt === null ? '—' : `until ${a.untilAt.slice(0, 16).replace('T', ' ')}`,
            )}</tr>`,
        )
        .join('')}</tbody></table>`
}
</main></body></html>`;
}
