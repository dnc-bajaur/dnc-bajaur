/**
 * The spreadsheet export — capability group 9.
 *
 * Three properties, and only one of them is about CSV formatting.
 *
 * **It carries no citizen contact detail** (capability 12), and that is asserted against the
 * real column list rather than trusted, so that adding a reporter's number to the board
 * cannot quietly add it to a file departments email around.
 *
 * **It cannot be turned into a payload.** Every text field in here originates as something
 * somebody typed into the administration console, and a spreadsheet executes a leading `=`.
 *
 * **It never truncates quietly.** A short file is worse than no file, because nobody counts
 * rows before submitting a report upward.
 */

import { describe, expect, it } from 'vitest';
import {
  buildExport,
  buildPerformanceExport,
  COLUMNS,
  EXPORT_LIMIT,
  PERFORMANCE_COLUMNS,
  toCsv,
  toPerformanceCsv,
} from '../exportCsv.js';
import type { Board, BoardRow } from '../board.js';
import type { DistrictPerformance } from '../performance.js';

function boardRow(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    incidentId: '11111111-1111-1111-1111-111111111111',
    status: 'reported',
    severity: 'critical',
    assessed: true,
    overriddenFrom: null,
    category: 'road accident',
    responsibleDepartmentIds: ['22222222-2222-2222-2222-222222222222'],
    responsibleDepartments: ['Rescue 1122'],
    occurredAt: '2026-08-04T09:00:00.000Z',
    lastRecordedAt: '2026-08-04T09:05:00.000Z',
    acknowledgedAt: null,
    declined: 0,
    ownerless: false,
    escalationCount: 0,
    overdue: false,
    overdueByMinutes: 0,
    notificationsFailed: 0,
    notificationsUndelivered: 0,
    unassigned: false,
    targetMinutes: 15,
    ...overrides,
  } as BoardRow;
}

function board(rows: readonly BoardRow[]): Board {
  return { asOf: '2026-08-04T10:00:00.000Z', summary: {}, incidents: rows } as unknown as Board;
}

describe('the incident export', () => {
  describe('what it must never contain', () => {
    /**
     * Capability 12: citizen contact details are excluded from general exports.
     *
     * Pinned against the column list itself. The export is built from `BoardRow`, which has
     * never held a reporter's name, number or location — so this passes today by construction.
     * It is here for the day somebody adds one of those to the board for a good reason and
     * does not think about the file that departments email to each other.
     */
    it('has no column for a reporter, a number, or a location', () => {
      const forbidden = ['phone', 'reporter', 'caller', 'name', 'contact', 'lat', 'lon', 'place'];

      // Matched on whole name parts, not as substrings — `escalations` contains "lat", and a
      // check that fires on that is a check somebody deletes rather than fixes. Same reason
      // routing signals match on whole words (M1a-01).
      for (const column of COLUMNS) {
        for (const part of column.split('_')) {
          expect(forbidden).not.toContain(part);
        }
      }
    });

    /**
     * 🔴 **New columns go on the END, and this is the assertion that keeps it true** — RX-04,
     * 2026-08-25.
     *
     * A district opens this file in a spreadsheet and keeps formulae, filters and column
     * widths pointed at **positions**. A column inserted in the middle silently shifts every
     * one of them, in a file that is emailed between offices and cannot be recalled.
     */
    it('appends new columns rather than inserting them', () => {
      expect(COLUMNS.indexOf('declined')).toBe(COLUMNS.length - 2);
      expect(COLUMNS.indexOf('nobody_took_it')).toBe(COLUMNS.length - 1);
      expect(COLUMNS[0]).toBe('reference');
    });

    /**
     * ⚠️ **Two columns rather than one**, for `notifications_failed`’s own reason: a count can
     * be summed in a monthly return and a flag cannot — while *did anybody take it* is the
     * question an operator asks at 02:00, and deriving it from the count in a spreadsheet is
     * the sort of formula that goes wrong quietly.
     */
    it('carries how many declined and whether that left nobody', () => {
      const csv = toCsv([boardRow({ declined: 3, ownerless: true })]);
      const line = csv.trim().split('\r\n')[1] ?? '';

      /** Every cell is quoted, which is what makes a district name with a comma survive Excel. */
      expect(line.endsWith('"3","true"')).toBe(true);
    });

    it('says zero and false for an emergency nobody has declined', () => {
      const csv = toCsv([boardRow({ declined: 0, ownerless: false })]);
      const line = csv.trim().split('\r\n')[1] ?? '';

      expect(line.endsWith('"0","false"')).toBe(true);
    });

    /**
     * **Option C — `acknowledged_at` is when the first office COMMITTED on a wide dispatch**,
     * from the `ownershipOf` roll-up, not the fold's single slot the first tap fills. Column
     * name kept: downstream spreadsheets point formulae at it.
     */
    const wideResponse = (over: Partial<BoardRow['response'] & object>): BoardRow['response'] => ({
      told: 3,
      holding: 1,
      declined: 1,
      silent: 1,
      ownerless: false,
      latest: null,
      respondedAt: '2026-09-10T21:43:00.000Z',
      breakdown: [],
      ...over,
    });
    const ackCell = (row: BoardRow): string =>
      (toCsv([row]).trim().split('\r\n')[1] ?? '').split(',')[10] ?? '';

    it('reads acknowledged_at from the commit time on a dispatch to more than one office', () => {
      expect(
        ackCell(
          boardRow({
            acknowledgedAt: '2026-09-10T21:41:00.000Z',
            response: wideResponse({}),
          }),
        ),
      ).toBe('"2026-09-10T21:43:00.000Z"');
    });

    it('blanks acknowledged_at when every office on a wide dispatch declined', () => {
      expect(
        ackCell(
          boardRow({
            acknowledgedAt: '2026-09-10T21:41:00.000Z',
            response: wideResponse({
              holding: 0,
              declined: 3,
              silent: 0,
              ownerless: true,
              respondedAt: null,
            }),
          }),
        ),
      ).toBe('');
    });

    it('keeps acknowledged_at as the fold slot for a single recipient', () => {
      expect(
        ackCell(
          boardRow({
            acknowledgedAt: '2026-09-10T21:41:00.000Z',
            response: wideResponse({ told: 1, silent: 0, respondedAt: '2026-09-10T21:50:00.000Z' }),
          }),
        ),
      ).toBe('"2026-09-10T21:41:00.000Z"');
    });

    it('would catch a reporter column if one were ever added', () => {
      // The guard above only means something if it fails on the thing it is guarding against.
      const forbidden = ['phone', 'reporter', 'caller', 'name', 'contact', 'lat', 'lon', 'place'];
      const hypothetical = 'reporter_phone';

      expect(hypothetical.split('_').some((part) => forbidden.includes(part))).toBe(true);
    });

    it('carries no coordinate or phone number in a rendered file', () => {
      const csv = toCsv([boardRow()]);

      expect(csv).not.toMatch(/\+92|03\d{9}/);
      expect(csv).not.toMatch(/\b\d{2}\.\d{4,}\b/);
    });
  });

  describe('what a spreadsheet does with it', () => {
    /**
     * A department named `=HYPERLINK("http://…","click")` is a live formula in whatever
     * office opens the file. The district's own data, turned into a payload, delivered by
     * the export that exists to be trusted.
     */
    it('neutralises a field that would otherwise be a formula', () => {
      const csv = toCsv([
        boardRow({ responsibleDepartments: ['=HYPERLINK("http://evil","payroll")'] }),
      ]);

      expect(csv).toContain(`"'=HYPERLINK`);
      expect(csv).not.toContain('"=HYPERLINK');
    });

    it.each(['=cmd', '+1', '-1', '@SUM(A1)'])('neutralises a leading %s', (value) => {
      expect(toCsv([boardRow({ category: value })])).toContain(`"'${value}"`);
    });

    it('leaves ordinary text alone', () => {
      expect(toCsv([boardRow({ category: 'road accident' })])).toContain('"road accident"');
    });

    it('escapes a quote by doubling it, not by stripping it', () => {
      const csv = toCsv([boardRow({ responsibleDepartments: ['The "old" office'] })]);

      expect(csv).toContain('"The ""old"" office"');
    });

    it('starts with a byte order mark so Excel reads Urdu correctly', () => {
      // Without one, Excel reads UTF-8 as the local codepage and every non-Latin department
      // name arrives as mojibake — useless for the district this is built for.
      expect(toCsv([])).toMatch(/^\uFEFF/);
    });
  });

  describe('what it says about severity', () => {
    it('writes the word unassessed rather than a severity nobody chose', () => {
      // ADR-0009, and a spreadsheet has no colour to lean on — which is the case that rule
      // was always really about.
      const csv = toCsv([boardRow({ assessed: false, severity: 'unknown' })]);

      expect(csv).toContain('"unassessed"');
    });
  });

  describe('when there is too much', () => {
    it('refuses rather than handing back a file that quietly left emergencies out', () => {
      const reply = buildExport(board([]), 30, true);

      expect(reply.status).toBe(413);
      expect(reply.error).toMatch(/shorter period/);
      expect(reply.body).toBe('');
    });

    it('exports normally when the cap was not reached', () => {
      const reply = buildExport(board([boardRow()]), 30, false);

      expect(reply.status).toBe(200);
      expect(reply.contentType).toMatch(/text\/csv/);
      expect(reply.filename).toBe('incidents-2026-08-04-last-30-days.csv');
    });

    it('has a cap high enough to be a real answer for a district', () => {
      // Bajaur is 79 offices. A cap so low that an ordinary month refuses would teach
      // everybody to export in fragments and stitch them together by hand.
      expect(EXPORT_LIMIT).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('the shape of the file', () => {
    it('writes a header row and one line per incident', () => {
      const csv = toCsv([boardRow(), boardRow()]);
      const lines = csv
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(COLUMNS.join(','));
    });

    /**
     * **The district's own number is the leftmost column** — 2026-08-24.
     *
     * A spreadsheet is where this matters most: somebody sorting Bajaur's month in Excel reads
     * the leftmost column, and forty rows of uuid are forty rows they cannot act on.
     */
    it("leads with the district's own number, keeping the record id beside it", () => {
      expect(COLUMNS[0]).toBe('reference');
      expect(COLUMNS[1]).toBe('incident_id');

      const csv = toCsv([boardRow({ reference: 'DNC-BAJAUR-42' })]);
      expect(csv).toContain('"DNC-BAJAUR-42"');
      expect(csv).toContain('"11111111-1111-1111-1111-111111111111"');
    });

    /**
     * An incident the numbering sweep has not reached is an empty cell, never `DNC-BAJAUR-null`.
     * The number is assigned after the events commit (INV-01), so this is a real state.
     */
    it('leaves the cell empty for an incident with no number yet', () => {
      const csv = toCsv([boardRow({ reference: null })]);

      expect(csv).not.toContain('null');
      expect(csv.split('\r\n')[1]?.startsWith(',')).toBe(true);
    });

    it('joins several responsible departments rather than dropping any', () => {
      // Several departments answering one emergency is the correct answer (ADR-0010).
      const csv = toCsv([boardRow({ responsibleDepartments: ['Rescue 1122', 'Police'] })]);

      expect(csv).toContain('"Rescue 1122; Police"');
    });
  });
});

/**
 * The performance export — M6-12.
 *
 * The one property that matters is not about CSV at all: **this file and the console must never
 * disagree about a department's median.** The file is what gets submitted upward and the screen
 * is what gets argued about in the room, and two numbers for one department is worse than
 * neither — so `toPerformanceCsv` formats a `DistrictPerformance` somebody else calculated and
 * computes nothing of its own. These tests hold that by feeding it a fixture and asserting the
 * numbers come out unchanged.
 */
describe('the performance export', () => {
  function performance(overrides: Partial<DistrictPerformance> = {}): DistrictPerformance {
    return {
      asOf: '2026-08-06T09:00:00.000Z',
      windowDays: 30,
      officers: [
        {
          key: 'person:33333333-3333-3333-3333-333333333333',
          name: 'Rescue 1122',
          total: 12,
          open: 3,
          unacknowledged: 1,
          overdue: 1,
          escalated: 2,
          closed: 9,
          medianAckMinutes: 7.5,
          meanAckMinutes: 19.2,
          slowestAckMinutes: 91,
          withinTarget: 0.8333,
          notificationsUnmet: 1,
        },
      ],
      district: {
        total: 12,
        open: 3,
        overdue: 1,
        unassigned: 0,
        medianAckMinutes: 7.5,
        notificationsUnmet: 1,
      },
      ...overrides,
    };
  }

  it('writes the medians it was given, unchanged', () => {
    const csv = toPerformanceCsv(performance());

    expect(csv).toContain('"Rescue 1122"');
    expect(csv).toContain('"7.5"');
    expect(csv).toContain('"91"');
  });

  it('leaves a missing figure empty, never zero', () => {
    /**
     * The rule the whole performance table is built on (ADR-0005). Zero minutes is the best
     * possible response time and no data is no performance at all — a file that confuses them
     * ranks the idle above the excellent, in a document read without the screen beside it.
     */
    const csv = toPerformanceCsv(
      performance({
        officers: [
          {
            key: 'person:44444444-4444-4444-4444-444444444444',
            name: 'Education',
            total: 0,
            open: 0,
            unacknowledged: 0,
            overdue: 0,
            escalated: 0,
            closed: 0,
            medianAckMinutes: null,
            meanAckMinutes: null,
            slowestAckMinutes: null,
            withinTarget: null,
            notificationsUnmet: 0,
          },
        ],
      }),
    );

    const row = csv.split('\r\n').find((line) => line.startsWith('"Education"'));
    expect(row).toBeDefined();
    // Four empty cells in a row: median, mean, slowest, within-target. Not "0".
    expect(row).toContain(',,,,');
    expect(row).not.toContain('"0.0"');
  });

  it('labels the district line so nobody adds the column up', () => {
    /**
     * An incident held by two departments counts in **both** of their rows and once in the
     * district's, deliberately — both were told and both were expected to act. Summing the
     * column would give a bigger number than the district had emergencies, and somebody would
     * eventually publish it.
     */
    const csv = toPerformanceCsv(performance());

    expect(csv).toContain('not a total of the rows above');
  });

  it('turns the within-target share into a percentage, rounded once', () => {
    // Rounded here so the file and the screen round the same number rather than each rounding
    // its own copy — 83.3, not 83 in one place and 83.33 in the other.
    expect(toPerformanceCsv(performance())).toContain('"83.3"');
  });

  it('neutralises a department name a spreadsheet would execute', () => {
    // Same defence as the incident export, and it has to be here too: a department name is
    // text somebody typed into the console, and this file is emailed around a district.
    const csv = toPerformanceCsv(
      performance({
        officers: [
          {
            key: 'person:55555555-5555-5555-5555-555555555555',
            name: '=HYPERLINK("http://x","click")',
            total: 0,
            open: 0,
            unacknowledged: 0,
            overdue: 0,
            escalated: 0,
            closed: 0,
            medianAckMinutes: null,
            meanAckMinutes: null,
            slowestAckMinutes: null,
            withinTarget: null,
            notificationsUnmet: 0,
          },
        ],
      }),
    );

    expect(csv).toContain(`"'=HYPERLINK`);
  });

  it('names the file after the window it covers', () => {
    const reply = buildPerformanceExport(performance({ windowDays: 7 }));

    expect(reply.filename).toBe('performance-2026-08-06-last-7-days.csv');
    expect(reply.contentType).toBe('text/csv; charset=utf-8');
  });

  it('carries every column the console shows', () => {
    // The console's table and this file answer the same question. A column on screen with no
    // column in the file sends somebody back to the screen to retype it.
    for (const column of ['median_ack_minutes', 'within_target_percent', 'notifications_unmet']) {
      expect(PERFORMANCE_COLUMNS).toContain(column);
    }
  });
});
