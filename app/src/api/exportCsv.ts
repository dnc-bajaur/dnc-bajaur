/**
 * Incidents out, as a spreadsheet — capability group 9.
 *
 * **This exists because of a decision, not because a list asked for a feature.** Q-01 and Q-02
 * settled that the district runs independently and integrates with no government-issued
 * system. The stated price of that independence is double entry, which `CLAUDE.md` names as
 * the top adoption risk, and the stated mitigation is export. Until now the mitigation did not
 * exist: a department that has to retype this month's incidents into whatever it submits
 * upward will eventually stop using the system it has to retype *from*.
 *
 * Three things this deliberately does not do:
 *
 * 1. **It does not run its own query.** `buildBoard` already folds incidents from the log and
 *    scopes them by seat; a second query would eventually disagree with the board about what
 *    happened, and then two documents would disagree about a district's emergencies. Same
 *    rule as M0-34.
 * 2. **It never truncates quietly.** If more incidents match than can be folded in one pass,
 *    it refuses and says to narrow the range. A short file is worse than no file: nobody
 *    checks a row count before submitting a report upward, and the numbers would simply be
 *    wrong. Same reasoning as a `pg_dump` holding fewer events than the live database being
 *    recorded as a failure rather than a warning.
 * 3. **It carries no citizen contact details** — capability 12. That is true by construction
 *    rather than by filtering: `BoardRow` has never held a reporter's name, number or
 *    location, and a test pins it so that adding one to the board cannot quietly add it here.
 */

import type { Board, BoardRow } from './board.js';
import type { DistrictPerformance, OfficerPerformance } from './performance.js';

/**
 * Fields that make a spreadsheet execute something when the file is opened.
 *
 * A category name, a department name and a status all originate as text somebody typed into
 * the administration console. Excel, LibreOffice and Sheets all treat a leading `=`, `+`, `-`
 * or `@` as the start of a formula, so a department named `=HYPERLINK(...)` becomes a live
 * formula in whatever office opens the file — a district's own data turned into a payload,
 * delivered by the export that exists to be trusted.
 *
 * Prefixing with an apostrophe is the standard defence: the cell shows the original text and
 * the spreadsheet treats it as literal.
 */
function neutralise(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** RFC 4180 quoting: wrap in quotes, and double any quote inside. */
function cell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = neutralise(String(value));
  return `"${text.replace(/"/g, '""')}"`;
}

export const COLUMNS: readonly string[] = [
  /**
   * **The district's own number, and it is the first column** — 2026-08-24.
   *
   * A spreadsheet is where this matters most. Somebody sorting Bajaur's month in Excel reads the
   * leftmost column, and forty rows of uuid are forty rows of nothing they can act on — while
   * `DNC-BAJAUR-42` is what they will write in the file, the email and the register.
   *
   * `incident_id` stays, one column across, because a spreadsheet is also how somebody comes
   * back and asks the log about a row.
   */
  'reference',
  'incident_id',
  'status',
  'severity',
  'assessed',
  'overridden_from',
  'category',
  'departments',
  'unassigned',
  'occurred_at',
  'acknowledged_at',
  'last_recorded_at',
  'target_minutes',
  'overdue',
  'overdue_by_minutes',
  'escalations',
  'notifications_failed',
  'notifications_undelivered',
  /**
   * How many recipients answered that they could not, and whether that left nobody — RX-04.
   *
   * ⚠️ **Appended, never inserted.** A district opens these in a spreadsheet and keeps
   * formulae, filters and column widths pointed at positions; a new column in the middle
   * silently shifts every one of them. New columns go on the end, always.
   *
   * Two columns rather than one, for `notifications_failed`'s own reason: **a count can be
   * summed and a flag cannot**, and *how many refused* is the question a monthly return asks —
   * while *did anybody take it* is the one an operator asks at 02:00.
   */
  'declined',
  'nobody_took_it',
];

function row(r: BoardRow): string {
  const resp = r.response ?? null;
  // Option C: on a dispatch to more than one office `acknowledged_at` is when the first office
  // COMMITTED, from the `ownershipOf` roll-up — not the fold's single slot, which the first tap
  // fills, a refusal included. Blank when a wide dispatch is `ownerless`. `told <= 1` keeps the
  // slot, so single-recipient rows and every historical export are unchanged. Column name kept:
  // it is the acknowledgement-time contract downstream spreadsheets point formulae at.
  const acknowledgedAt = resp !== null && resp.told > 1 ? resp.respondedAt : r.acknowledgedAt;

  return [
    cell(r.reference),
    cell(r.incidentId),
    cell(r.status),
    // The word, always — `unassessed` is a value and never a level (ADR-0009). A spreadsheet
    // has no colour to lean on, which is the case this rule was always really about.
    cell(r.assessed ? r.severity : 'unassessed'),
    cell(r.assessed),
    cell(r.overriddenFrom),
    cell(r.category),
    // Several departments answering one emergency is correct, not a conflict (ADR-0010).
    cell(r.responsibleDepartments.join('; ')),
    cell(r.unassigned),
    cell(r.occurredAt),
    cell(acknowledgedAt),
    cell(r.lastRecordedAt),
    cell(r.targetMinutes),
    cell(r.overdue),
    cell(r.overdueByMinutes),
    cell(r.escalationCount),
    cell(r.notificationsFailed),
    cell(r.notificationsUndelivered),
    cell(r.declined),
    cell(r.ownerless),
  ].join(',');
}

/**
 * The file.
 *
 * Begins with a byte order mark. Without one, Excel reads a UTF-8 file as the local codepage
 * and every Urdu or Pashto department name arrives as mojibake — which would make the export
 * useless for exactly the district it is for. CRLF for the same audience.
 */
/** U+FEFF, written as an escape: a literal one here is invisible in every diff and editor. */
const BOM = '\uFEFF';

export function toCsv(rows: readonly BoardRow[]): string {
  return `${BOM}${[COLUMNS.join(','), ...rows.map(row)].join('\r\n')}\r\n`;
}

export interface ExportReply {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly filename?: string;
  readonly error?: string;
}

/**
 * How many incidents one pass may fold before the answer stops being trustworthy.
 *
 * `buildBoard` takes the most recent `limit` incidents and says nothing about the rest, which
 * is right for a screen — an operator reads the top of it — and wrong for a document somebody
 * submits upward.
 */
export const EXPORT_LIMIT = 5000;

export function buildExport(board: Board, days: number, limitHit: boolean): ExportReply {
  if (limitHit) {
    return {
      status: 413,
      body: '',
      contentType: 'application/json; charset=utf-8',
      error:
        `more than ${EXPORT_LIMIT} incidents match the last ${days} days, which is more than ` +
        'can be exported in one pass. Ask for a shorter period — a file that quietly left ' +
        'emergencies out would be reported upward as if it were complete',
    };
  }

  const stamp = board.asOf.slice(0, 10);
  return {
    status: 200,
    body: toCsv(board.incidents),
    contentType: 'text/csv; charset=utf-8',
    filename: `incidents-${stamp}-last-${days}-days.csv`,
  };
}

//------------------------------------------------------------------------------
// Performance — M6-12
//------------------------------------------------------------------------------

/**
 * The same medians the console shows, as a file — **never a second calculation.**
 *
 * The district asked to take their performance figures away with them. The one thing that must
 * not happen is this file and the console disagreeing about a department's median: the file is
 * what gets submitted upward and the screen is what gets argued about in the room, and two
 * numbers for one department is worse than neither.
 *
 * So this takes a `DistrictPerformance` that `computePerformance` already produced and formats
 * it. It runs no query, applies no filter, and computes nothing — the same rule the incident
 * export follows against `buildBoard`, for the third time in this codebase and the same reason
 * each time.
 *
 * **Nulls stay empty, never zero.** A department with no incidents has no median, and zero
 * minutes is the best possible performance — a file that confuses them ranks the idle above the
 * excellent (ADR-0005), in a document somebody reads without the screen beside them.
 */
/**
 * ⚠️ **TWO COLUMNS CHANGED — ADR-0029, CD-05b, and this is a file the district emails onward.**
 *
 * `department` is **`officer`**, and `retired` is **gone** rather than left empty. A column
 * header that still says *department* over a list of officers is a spreadsheet that misleads
 * somebody who was not in the room, months later, with nothing on it to say otherwise — and a
 * column of blanks invites the reader to work out what it used to mean.
 *
 * A file that has already been sent cannot be corrected, which is exactly why the header moves
 * with the fold rather than after it.
 */
export const PERFORMANCE_COLUMNS: readonly string[] = [
  'officer',
  'incidents',
  'open',
  'unacknowledged',
  'overdue',
  'escalated',
  'closed',
  'median_ack_minutes',
  'mean_ack_minutes',
  'slowest_ack_minutes',
  'within_target_percent',
  'notifications_unmet',
];

function performanceRow(r: OfficerPerformance): string {
  return [
    cell(r.name),
    cell(r.total),
    cell(r.open),
    cell(r.unacknowledged),
    cell(r.overdue),
    cell(r.escalated),
    cell(r.closed),
    cell(r.medianAckMinutes),
    cell(r.meanAckMinutes),
    cell(r.slowestAckMinutes),
    // A share on the wire, a percentage in the file. Rounded once, here, so the file and the
    // screen round the same number rather than each rounding its own.
    cell(r.withinTarget === null ? null : Math.round(r.withinTarget * 1000) / 10),
    cell(r.notificationsUnmet),
  ].join(',');
}

export function toPerformanceCsv(performance: DistrictPerformance): string {
  const rows = [
    PERFORMANCE_COLUMNS.join(','),
    ...performance.officers.map(performanceRow),
    /**
     * The district's own line, last and labelled.
     *
     * Not a sum of the column above it, and it must not be read as one: an incident held by two
     * departments counts in both of their rows and once in this one, deliberately — both were
     * told and both were expected to act (see `performanceOver`). Adding the column up would
     * give a bigger number than the district had emergencies, and somebody would eventually
     * publish it.
     */
    [
      cell('District (not a total of the rows above)'),
      cell(false),
      cell(performance.district.total),
      cell(performance.district.open),
      cell(null),
      cell(performance.district.overdue),
      cell(null),
      cell(null),
      cell(performance.district.medianAckMinutes),
      cell(null),
      cell(null),
      cell(null),
      cell(performance.district.notificationsUnmet),
    ].join(','),
  ];

  return `${BOM}${rows.join('\r\n')}\r\n`;
}

export function buildPerformanceExport(performance: DistrictPerformance): ExportReply {
  const stamp = performance.asOf.slice(0, 10);
  return {
    status: 200,
    body: toPerformanceCsv(performance),
    contentType: 'text/csv; charset=utf-8',
    filename: `performance-${stamp}-last-${String(performance.windowDays)}-days.csv`,
  };
}
