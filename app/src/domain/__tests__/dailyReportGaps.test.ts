/**
 * **What the Deputy Commissioner's morning report says went wrong** — RX-04, 2026-08-25.
 *
 * Pure, no database. `buildDailyReport` is a fold over states, and the one sentence per row that
 * says *what went wrong with this one* is the whole of INV-03 on paper: a gap is **stated** where
 * it belongs, never counted in a corner.
 *
 * 🔴 **The report said nothing at all about an emergency every recipient had declined.** Declining
 * is answering, so `acknowledgedAt` is set — and the clause that catches an unanswered emergency
 * never fired. `gapOf` returned **null**: no gap, on the line that most needed a sentence.
 *
 * Only **one** sentence is returned per row, deliberately — three in a cell is a cell nobody reads
 * — so these tests are as much about the **order** as about the words.
 */

import { describe, expect, it } from 'vitest';

import { buildDailyReport, type DailySources } from '../dailyReport.js';
import type { IncidentState } from '../incident.js';

const SEAT = '22222222-2222-2222-2222-222222222222';

interface Told {
  readonly said?: string;
  readonly state?: 'pending' | 'delivered' | 'failed';
}

function incident(told: readonly Told[], overrides: Partial<IncidentState> = {}): IncidentState {
  return {
    incidentId: '11111111-1111-1111-1111-111111111111',
    status: 'acknowledged',
    kind: 'emergency',
    severity: { value: 'high' },
    category: { value: 'fire' },
    occurredAt: '2026-08-25T05:00:00.000Z',
    lastRecordedAt: '2026-08-25T05:05:00.000Z',
    acknowledgedAt: '2026-08-25T05:02:00.000Z',
    acknowledgedBySeatId: SEAT,
    acknowledgedByPersonId: null,
    responsibleDepartmentIds: [],
    dispatchedTo: told.map((_, i) => ({ kind: 'post', id: `seat-${String(i)}` })),
    notifications: told.map((t, i) => ({
      attemptId: `attempt-${String(i)}`,
      seatId: `seat-${String(i)}`,
      channel: 'whatsapp',
      reason: 'dispatched',
      attemptedAt: '2026-08-25T05:01:00.000Z',
      state: t.state ?? 'delivered',
      ...(t.said === undefined ? {} : { via: 'link', said: t.said }),
    })),
    resolution: null,
    withdrawalReason: null,
    correctionReason: null,
    ...overrides,
  } as unknown as IncidentState;
}

function reportOf(
  state: IncidentState,
  seats: Record<string, string> = {},
): ReturnType<typeof buildDailyReport> {
  const sources: DailySources = {
    date: '2026-08-25',
    scope: 'district',
    generatedAt: '2026-08-25T18:00:00.000Z',
    states: [state],
    advisories: [],
    availability: [],
    departments: {},
    seats,
    people: {},
  } as unknown as DailySources;

  return buildDailyReport(sources);
}

function gapOf(state: IncidentState): string | null {
  return reportOf(state).emergencies[0]?.gap ?? null;
}

describe('the sentence beside an emergency nobody took', () => {
  it('says so, and says how many refused', () => {
    const gap = gapOf(incident([{ said: 'Unable to Respond' }, { said: 'Not Related to Me' }]));

    expect(gap).toBe('all 2 recipients declined — nobody has taken it');
  });

  /** One officer is not *all 1 recipients*. The report is read aloud in a morning meeting. */
  it('reads properly when there was only one of them', () => {
    expect(gapOf(incident([{ said: 'Unable to Respond' }]))).toBe(
      'the one recipient declined — nobody has taken it',
    );
  });

  it('says nothing while somebody is still holding it', () => {
    const gap = gapOf(
      incident([{ said: 'Unable to Respond' }, { said: 'Deploying Relevant Staff / Team' }]),
    );

    expect(gap).toBeNull();
  });

  /**
   * ⚠️ **Ordered by what the reader should act on first**, and this pair is the reason the order
   * is written down. A message that never arrived is a **different** failure from an officer who
   * received it and refused: the first is the district's own system letting somebody down, and it
   * is fixed by a different person than the second.
   */
  it('reports an undelivered message ahead of a refusal', () => {
    const gap = gapOf(
      incident([{ said: 'Unable to Respond' }, { state: 'failed' }, { state: 'pending' }]),
    );

    expect(gap).toBe('2 of 3 were not reached');
  });

  /** And nobody chosen at all still comes first, because there is nothing else to say yet. */
  it('reports nobody having been told ahead of everything', () => {
    expect(gapOf(incident([], { dispatchedTo: [] } as Partial<IncidentState>))).toBe(
      'nobody was told',
    );
  });

  /**
   * 🔴 The regression itself, stated as its own test. Before RX-04 this row's gap was `null` — the
   * report printed a fire that four officers had refused with **no sentence at all**.
   */
  it('no longer returns null for an emergency everybody refused', () => {
    expect(
      gapOf(
        incident([
          { said: 'Unable to Respond' },
          { said: 'On Leave' },
          { said: 'Otherwise Unavailable' },
          { said: 'Not Related to Me' },
        ]),
      ),
    ).not.toBeNull();
  });
});

/**
 * **Option C — the line and the totals stop reading a refusal as a response** — 2026-09-10.
 *
 * `gapOf` above already carries the sentence; these cover the rest of the row and the
 * `unacknowledged` total, which read `acknowledgedAt` / the status directly and so counted a
 * fire every office had refused as one somebody was on.
 */
describe('the daily line for an emergency nobody took', () => {
  it('counts a wide dispatch everybody declined among the unresponded, despite the filled slot', () => {
    const report = reportOf(
      incident([{ said: 'Unable to Respond' }, { said: 'Not Related to Me' }]),
    );
    expect(report.emergencies[0]?.ownerless).toBe(true);
    expect(report.totals.unacknowledged).toBe(1);
  });

  it('counts the lone recipient who declined, too', () => {
    const report = reportOf(incident([{ said: 'On Leave' }]));
    expect(report.totals.unacknowledged).toBe(1);
  });

  it('does not count one an office is holding', () => {
    const report = reportOf(
      incident([{ said: 'Not Related to Me' }, { said: 'Deploying Relevant Staff / Team' }]),
    );
    expect(report.emergencies[0]?.ownerless).toBe(false);
    expect(report.totals.unacknowledged).toBe(0);
  });

  it('reads Issued, not Responded, when a decline drove the status to responding', () => {
    const report = reportOf(
      incident([{ said: 'Unable to Respond' }, { said: 'Not Related to Me' }], {
        status: 'responding',
      } as Partial<IncidentState>),
    );
    expect(report.emergencies[0]?.stage).toBe('Issued');
  });

  it('names the office that committed on a wide dispatch, not the first-tap slot', () => {
    const report = reportOf(
      incident([{ said: 'Not Related to Me' }, { said: 'Proceeding to the Site' }]),
      { 'seat-1': 'Nearest Post' },
    );
    expect(report.emergencies[0]?.acknowledgedBy).toBe('Nearest Post');
    // The commit time from the roll-up, not the 05:02 the fixture's slot carries.
    expect(report.emergencies[0]?.acknowledgedAt).toBe('2026-08-25T05:01:00.000Z');
  });
});

/**
 * **Case 2 (meeting) — the daily line shows who is coming, not "responded by"** — 2026-09-10.
 *
 * A meeting has no single responder. The row carries an `attendance` tally, and its
 * `acknowledgedAt` / `acknowledgedBy` are blank so a reader is not handed a name that means "the
 * first person to tap Attending".
 */
describe('the daily line for a meeting notice', () => {
  function meeting(told: readonly Told[]): IncidentState {
    return incident(told, {
      kind: 'meeting',
      status: 'responding',
      category: { value: 'general' },
      severity: null,
    } as unknown as Partial<IncidentState>);
  }

  it('carries the attendance tally and leaves responded-by blank', () => {
    const report = reportOf(
      meeting([{ said: 'Attending' }, { said: 'Sending someone' }, { state: 'delivered' }]),
      { 'seat-0': 'Tehsildar A' },
    );
    const row = report.communications[0];
    expect(row?.attendance).not.toBeNull();
    expect(row?.attendance?.told).toBe(3);
    expect(row?.attendance?.coming).toBe(2);
    expect(row?.attendance?.attending).toBe(1);
    expect(row?.attendance?.sendingSomeone).toBe(1);
    expect(row?.attendance?.unanswered).toBe(1);
    // No single responder for a meeting — the cell that would name one is blank.
    expect(row?.acknowledgedBy).toBeNull();
    expect(row?.acknowledgedAt).toBeNull();
  });

  it('states the gap when nobody said whether they were coming', () => {
    const report = reportOf(meeting([{ state: 'delivered' }, { state: 'delivered' }]));
    expect(report.communications[0]?.gap).toBe('nobody said whether they were coming');
  });

  it('is null attendance for an ordinary emergency', () => {
    const report = reportOf(incident([{ said: 'Proceeding to the Site' }]));
    expect(report.emergencies[0]?.attendance ?? null).toBeNull();
  });
});

/**
 * **The saved group a dispatch expanded, named beside the count — Case 3, 2026-09-10.**
 *
 * The daily line has no per-recipient list to partition (unlike the drawer, the Record row and
 * the post-incident report) — `told` is already a bare count. `toldGroups` is the group's name
 * alongside it, read off the events by the caller (`api/dailyReport.ts`) and passed in as
 * `groupsByIncident`, since this module stays pure and takes only `states`. Display only: `told`
 * is unchanged and still counts every recipient independently.
 */
describe('the group a dispatch expanded, on the daily line', () => {
  it('is empty for an incident dispatched only by hand', () => {
    const report = reportOf(incident([{ said: 'Proceeding to the Site' }]));
    expect(report.emergencies[0]?.toldGroups).toEqual([]);
  });

  it('names the group when the caller supplies one for this incident', () => {
    const state = incident([{ said: 'Proceeding to the Site' }, {}]);
    const sources: DailySources = {
      date: '2026-08-25',
      scope: 'district',
      generatedAt: '2026-08-25T18:00:00.000Z',
      states: [state],
      groupsByIncident: new Map([[state.incidentId, ['All Tehsildars']]]),
      advisories: [],
      availability: [],
      departments: {},
      seats: {},
      people: {},
    } as unknown as DailySources;

    const report = buildDailyReport(sources);
    expect(report.emergencies[0]?.toldGroups).toEqual(['All Tehsildars']);
  });

  it('is empty when the caller sends no groupsByIncident at all — an older caller', () => {
    const sources: DailySources = {
      date: '2026-08-25',
      scope: 'district',
      generatedAt: '2026-08-25T18:00:00.000Z',
      states: [incident([{ said: 'Proceeding to the Site' }])],
      advisories: [],
      availability: [],
      departments: {},
      seats: {},
      people: {},
    } as unknown as DailySources;

    expect(buildDailyReport(sources).emergencies[0]?.toldGroups).toEqual([]);
  });
});
