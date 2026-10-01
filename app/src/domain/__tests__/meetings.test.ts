/**
 * **How a meeting ends, and the one way it does not** — the district's five, 2026-08-22.
 *
 * Pure, no database. Two properties run through everything here and both come from the district
 * rather than from tidiness:
 *
 * 🔴 **A rescheduled meeting has NOT finished.** If any assertion in this file ever ends up
 * saying that moving a date resolved something, the design has gone wrong.
 *
 * 🔴 **Nothing is erased.** An officer's *Attending* for Monday stays on the record for ever;
 * what changes is only whether it is counted towards Thursday.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTENDANCE_GRACE_HOURS,
  MEETING_OUTCOMES,
  attendanceClosesAt,
  meetingOutcomeOf,
} from '../meetings.js';
import { attendanceFor } from '../attendance.js';
import { foldIncident } from '../incident.js';
import { endOfNamedDistrictDay } from '../districtTime.js';
import { INCIDENT, ev } from './fixtures.js';

describe('the two endings', () => {
  it('offers Conducted and Cancelled, and deliberately not Rescheduled', () => {
    /**
     * The sharpest line in this phase. *Conducted* and *Cancelled* close a meeting; a
     * rescheduled one is still going to happen, and putting it in this list is precisely how a
     * live meeting would come to be taken off the dashboard by a control that looked like the
     * other two.
     */
    expect(MEETING_OUTCOMES).toEqual(['Conducted', 'Cancelled']);
    expect(MEETING_OUTCOMES).not.toContain('Rescheduled');
  });

  it('classifies an outcome without matching strings at the call site', () => {
    // A report counts *how many meetings were cancelled* through this and nowhere else, so a
    // reworded control cannot silently stop being counted.
    expect(meetingOutcomeOf('Cancelled')).toBe('Cancelled');
    expect(meetingOutcomeOf('  conducted ')).toBe('Conducted');
  });

  it('says null for a sentence somebody wrote themselves, rather than guessing', () => {
    // `answerOf`'s rule at the other end of the same meeting: a report counts what it can count
    // and says how many it could not. "Cancelled - venue unavailable" is not a bucket to guess.
    expect(meetingOutcomeOf('cancelled - venue unavailable')).toBeNull();
    expect(meetingOutcomeOf(null)).toBeNull();
  });
});

describe('when the attendance count closes', () => {
  /** 06:00 UTC is 11:00 in Bajaur, so the district's day has thirteen hours left in it. */
  const MORNING = '2026-08-22T06:00:00.000Z';
  /** 17:00 UTC is 22:00 in Bajaur — two hours left, which is inside the grace. */
  const LATE = '2026-08-22T17:00:00.000Z';

  it('closes at the end of the district day a notice went out in', () => {
    expect(attendanceClosesAt(MORNING)).toBe(endOfNamedDistrictDay('2026-08-22'));
  });

  it('rolls to the next district day when fewer than three hours are left', () => {
    /**
     * The owner's rule, 2026-08-18. A notice sent at 22:00 that closed at midnight would give
     * officers two hours with half of them asleep — that is not a deadline, it is a way of
     * recording that nobody answered.
     */
    expect(attendanceClosesAt(LATE)).toBe(endOfNamedDistrictDay('2026-08-23'));
    expect(ATTENDANCE_GRACE_HOURS).toBe(3);
  });

  it('is the DISTRICT’s day and never the server’s', () => {
    /**
     * 🔴 This process runs in Helsinki and Bajaur is UTC+05:00. Computed locally, *"end of
     * today"* lands five hours early every single day — the two-midnights defect arriving as a
     * shortened deadline. The boundary is 19:00 UTC, not midnight UTC.
     */
    // The LAST MILLISECOND of the district's day, which is 23:59:59.999 in Bajaur — not
    // midnight UTC, which would be five hours early, every night.
    expect(attendanceClosesAt(MORNING)).toBe('2026-08-22T18:59:59.999Z');
  });

  it('answers null rather than throwing on an instant it cannot read', () => {
    // ADR-0005's direction: an unknown is not a deadline, and it is certainly not "closed".
    expect(attendanceClosesAt('not an instant')).toBeNull();
  });
});

const TOLD = (over: Record<string, unknown> = {}) => ({
  attemptId: `att-${String(Math.random())}`,
  seatId: 'seat-1',
  reason: 'dispatched',
  via: 'link',
  said: 'Attending',
  ...over,
});

describe('a reschedule starts the count again, and erases nothing', () => {
  it('stops counting an answer given about the old date', () => {
    const tally = attendanceFor(
      'meeting',
      [
        TOLD({ settledAt: '2026-08-20T06:00:00.000Z' }),
        TOLD({ settledAt: '2026-08-23T06:00:00.000Z' }),
      ],
      { rescheduledAt: '2026-08-22T06:00:00.000Z' },
    );

    // One said yes about Thursday. The other said yes about Monday, and Monday is gone.
    expect(tally?.attending).toBe(1);
    expect(tally?.stale).toBe(1);
    expect(tally?.unanswered).toBe(1);
  });

  it('🔴 keeps the earlier answer, its words and who said it', () => {
    const tally = attendanceFor('meeting', [TOLD({ settledAt: '2026-08-20T06:00:00.000Z' })], {
      rescheduledAt: '2026-08-22T06:00:00.000Z',
    });

    const row = tally?.rows[0];
    // Nothing about a reschedule deletes anything. The record and the count answer two different
    // questions, and this is the row that has to be able to show both.
    expect(row?.said).toBe('Attending');
    expect(row?.answer).toBe('attending');
    expect(row?.stale).toBe(true);
    expect(tally?.told).toBe(1);
  });

  it('never marks an answer whose time nobody recorded', () => {
    /**
     * ⚠️ An absent `settledAt` means *we do not know when*, and dropping somebody out of a count
     * on the strength of a missing field would be the software deciding an officer never
     * replied — the same class of mistake as reading `seatId: null` as *"holds no post"*, which
     * stopped every acknowledgement in Bajaur for a day.
     */
    const tally = attendanceFor('meeting', [TOLD()], { rescheduledAt: '2026-08-22T06:00:00.000Z' });

    expect(tally?.attending).toBe(1);
    expect(tally?.stale).toBe(0);
  });

  it('keeps a late answer out of the tally and on the record', () => {
    const tally = attendanceFor('meeting', [TOLD({ settledAt: '2026-08-23T06:00:00.000Z' })], {
      closesAt: '2026-08-22T19:00:00.000Z',
    });

    expect(tally?.attending).toBe(0);
    expect(tally?.late).toBe(1);
    expect(tally?.rows[0]?.said).toBe('Attending');
  });
});

describe('the fold', () => {
  const meeting = (): ReturnType<typeof foldIncident> =>
    foldIncident(INCIDENT, [
      ev('reported', {
        reportId: 'rep-1',
        category: 'other',
        severity: 'moderate',
        kind: 'meeting',
        details: {
          subject: 'Monthly coordination',
          date: '2026-08-24',
          time: '10:00',
          venue: 'DC office',
        },
      }),
      ev('rescheduled', {
        date: '2026-08-27',
        reason: 'DC is out of the district on Monday',
      }),
    ]);

  it('moves the date and leaves everything else the operator typed', () => {
    const state = meeting();

    expect(state.details?.date).toBe('2026-08-27');
    // A meeting moved to Thursday at the same place and hour must not silently lose its venue
    // because an operator did not retype it.
    expect(state.details?.time).toBe('10:00');
    expect(state.details?.venue).toBe('DC office');
    expect(state.details?.subject).toBe('Monthly coordination');
  });

  it('🔴 does not resolve it, close it, or take it off the panel', () => {
    /**
     * The single most important property in this phase, asserted rather than described. A
     * rescheduled meeting is still going to happen — folding the three controls into one "close"
     * would take a live meeting off the dashboard, which is the exact opposite of what the
     * district asked for.
     */
    const state = meeting();

    expect(state.status).toBe('reported');
    expect(state.resolution).toBeNull();
    expect(state.withdrawnAt).toBeNull();
    expect(state.rescheduledAt).not.toBeNull();
    expect(state.rescheduleCount).toBe(1);
    expect(state.rescheduleReason).toBe('DC is out of the district on Monday');
  });

  it('counts a meeting that has moved twice', () => {
    const state = foldIncident(INCIDENT, [
      ev('reported', {
        reportId: 'rep-1',
        category: 'other',
        severity: 'moderate',
        kind: 'meeting',
        details: { subject: 'Coordination', date: '2026-08-24' },
      }),
      ev('rescheduled', { date: '2026-08-27', reason: 'DC away' }),
      ev('rescheduled', { date: '2026-09-01', reason: 'quorum' }),
    ]);

    // A meeting on its third date is worth seeing as one.
    expect(state.rescheduleCount).toBe(2);
    expect(state.details?.date).toBe('2026-09-01');
  });
});
