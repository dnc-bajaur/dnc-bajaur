/**
 * Counting who is coming — Phase D, 2026-08-20.
 *
 * Pure: no database, no clock, no framework. Every case here is a decision about **what the
 * district is entitled to claim** from the notification ledger, and the ones worth holding down
 * are all refusals:
 *
 *   * **A delivery is not an answer.** Meta reporting that a handset received a meeting notice
 *     settles the attempt and decides nothing — a tally built on it fills a room nobody agreed
 *     to attend.
 *   * **"Nobody answered" and "answered some other way" are different.** One is the district's
 *     problem to chase; the other is somebody who has already responded.
 *   * **Words are never guessed into a bucket.** *"I cannot attend"* contains *"attend"*, and a
 *     substring match would file it under Attending and seat somebody who said no.
 *   * **An emergency has no attendance at all**, and gets null rather than a tally of zeroes.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTENDANCE_ANSWERS,
  ATTENDING,
  NOT_ATTENDING,
  SENDING_SOMEONE,
  attendanceFor,
} from '../attendance.js';
import type { NotificationAttempt } from '../incident.js';
import { CARRIES_SLA, isGeneral, type MessageKind } from '../events.js';

let n = 0;
/** One obligation, with only the fields this file reads set to anything meaningful. */
function attempt(over: Partial<NotificationAttempt> = {}): NotificationAttempt {
  n += 1;
  return {
    attemptId: `attempt-${String(n)}`,
    seatId: `seat-${String(n)}`,
    channel: 'whatsapp',
    reason: 'dispatched',
    attemptedAt: '2026-08-20T10:00:00.000Z',
    state: 'delivered',
    ...over,
  } as NotificationAttempt;
}

describe('what counts as an answer', () => {
  it('counts the three the district actually offers', () => {
    const tally = attendanceFor('meeting', [
      attempt({ via: 'reply', said: ATTENDING }),
      attempt({ via: 'reply', said: ATTENDING }),
      attempt({ via: 'reply', said: NOT_ATTENDING }),
      attempt({ via: 'reply', said: SENDING_SOMEONE }),
    ]);

    expect(tally).not.toBeNull();
    expect(tally?.attending).toBe(2);
    expect(tally?.notAttending).toBe(1);
    expect(tally?.sendingSomeone).toBe(1);
    expect(tally?.unanswered).toBe(0);
    expect(tally?.told).toBe(4);
  });

  it('does not count a delivery as an answer', () => {
    /**
     * The assertion this whole file exists for. `delivered` means Meta handed it to a handset;
     * ADR-0014 has refused to let that meet an obligation since M6, and it must not fill a
     * meeting either. An officer whose phone received a notice has not said they are coming.
     */
    const tally = attendanceFor('meeting', [
      attempt({ state: 'delivered', via: 'provider' }),
      attempt({ state: 'delivered' }),
    ]);

    expect(tally?.attending).toBe(0);
    expect(tally?.unanswered).toBe(2);
    expect(tally?.told).toBe(2);
  });

  it('keeps "no answer" and "answered another way" apart', () => {
    // One officer has said nothing at all; the other rang the control room and an operator
    // wrote it down. Merging them would report a district as unreachable when it had been rung.
    const tally = attendanceFor('meeting', [
      attempt({ state: 'pending' }),
      attempt({ via: 'operator', said: 'Coming, but will be an hour late' }),
    ]);

    expect(tally?.unanswered).toBe(1);
    expect(tally?.other).toBe(1);
    expect(tally?.attending).toBe(0);
  });

  it('never guesses a sentence into a bucket', () => {
    /**
     * *"I cannot attend"* contains *"attend"*. A substring match — the obvious implementation —
     * would file this under **Attending** and the district would keep a seat for somebody who
     * said no, on the strength of eight characters.
     */
    const tally = attendanceFor('meeting', [
      attempt({ via: 'reply', said: 'I cannot attend' }),
      attempt({ via: 'reply', said: 'Attending if the road is open' }),
    ]);

    expect(tally?.attending).toBe(0);
    expect(tally?.other).toBe(2);
    // And the words survive, so the panel can show what was actually said.
    expect(tally?.rows.map((r) => r.said)).toEqual([
      'I cannot attend',
      'Attending if the road is open',
    ]);
  });

  it('forgives case and stray spaces, because a handset is not a form', () => {
    const tally = attendanceFor('meeting', [
      attempt({ via: 'reply', said: '  attending ' }),
      attempt({ via: 'reply', said: 'NOT ATTENDING' }),
    ]);

    expect(tally?.attending).toBe(1);
    expect(tally?.notAttending).toBe(1);
  });
});

describe('the two derived totals the surfaces read', () => {
  it('`coming` is attending plus a representative, and nothing else', () => {
    // "3 of 5 coming" on the wall, the detail screen and the report is this number. A
    // representative is a yes with a name attached; "I'll try" and a refusal are not.
    const tally = attendanceFor('meeting', [
      attempt({ via: 'reply', said: ATTENDING }),
      attempt({ via: 'reply', said: ATTENDING }),
      attempt({ via: 'reply', said: SENDING_SOMEONE }),
      attempt({ via: 'reply', said: NOT_ATTENDING }),
      attempt({ via: 'reply', said: 'Depends on the weather' }),
      attempt({ state: 'pending' }),
    ]);

    expect(tally?.coming).toBe(3);
    expect(tally?.told).toBe(6);
  });

  it('`answered` counts every reply, a decline included, and silence never', () => {
    const tally = attendanceFor('meeting', [
      attempt({ via: 'reply', said: ATTENDING }),
      attempt({ via: 'reply', said: NOT_ATTENDING }),
      attempt({ via: 'operator', said: 'Coming late' }),
      attempt({ state: 'pending' }),
      attempt({ state: 'delivered', via: 'provider' }),
    ]);

    expect(tally?.answered).toBe(3);
    expect(tally?.unanswered).toBe(2);
    expect(tally?.answered).toBe((tally?.told ?? 0) - (tally?.unanswered ?? 0));
  });

  it('is 0 coming and 0 answered when the room has only been told', () => {
    const tally = attendanceFor('meeting', [attempt({ state: 'pending' }), attempt()]);
    expect(tally?.coming).toBe(0);
    expect(tally?.answered).toBe(0);
    expect(tally?.told).toBe(2);
  });

  it('drops a stale and a late reply out of both, the way it drops them out of `attending`', () => {
    // Answered about the date the meeting used to be on, and answered after the count closed —
    // both keep their words and both sit outside the tally. `coming`/`answered` follow.
    const tally = attendanceFor(
      'meeting',
      [
        attempt({ via: 'reply', said: ATTENDING, settledAt: '2026-08-19T09:00:00.000Z' }),
        attempt({ via: 'reply', said: SENDING_SOMEONE, settledAt: '2026-08-25T09:00:00.000Z' }),
        attempt({ via: 'reply', said: ATTENDING, settledAt: '2026-08-21T09:00:00.000Z' }),
      ],
      { rescheduledAt: '2026-08-20T00:00:00.000Z', closesAt: '2026-08-22T00:00:00.000Z' },
    );

    expect(tally?.stale).toBe(1);
    expect(tally?.late).toBe(1);
    expect(tally?.coming).toBe(1);
    expect(tally?.answered).toBe(1);
    expect(tally?.unanswered).toBe(2);
  });
});

describe('what is not a meeting', () => {
  it('has no attendance at all, and says so with null', () => {
    // Null rather than a tally of zeroes: an empty tally on screen invites "nobody is coming",
    // while null is the panel not being drawn. "Attending" is not an answer to a road accident.
    for (const kind of ['emergency', 'alert', 'advisory', 'order', 'schedule', 'other'] as const) {
      expect(attendanceFor(kind, [attempt({ via: 'reply', said: ATTENDING })])).toBeNull();
    }
    expect(attendanceFor('meeting', [])).not.toBeNull();
  });
});

describe('which obligations are counted', () => {
  it('counts what the control room chose, not what the ladder chased', () => {
    /**
     * The escalation ladder's own messages are attempts too. Counting them would let a meeting
     * nobody answered grow a denominator as the system chased it — the district would watch
     * attendance get **worse** the harder the software tried, which is the opposite of the truth.
     */
    const tally = attendanceFor('meeting', [
      attempt({ reason: 'dispatched', via: 'reply', said: ATTENDING }),
      attempt({ reason: 'escalated' }),
      attempt({ reason: 'escalated' }),
    ]);

    expect(tally?.told).toBe(1);
    expect(tally?.attending).toBe(1);
    expect(tally?.unanswered).toBe(0);
  });
});

describe('the words themselves', () => {
  it('are in the order Meta approved them', () => {
    // `TemplateShape.quickReplies` is built from this array and Meta matches a template's buttons
    // by position. Reordering here reorders them on every officer's handset.
    expect([...ATTENDANCE_ANSWERS]).toEqual(['Attending', 'Not attending', 'Sending someone']);
  });
});

/**
 * **Information** — the district's five, 2026-08-22, and the district said yes to this.
 *
 * *"12 Rabi-ul-Awwal par programme hoga, agar kisi ne join karna hai to kar sakta hai"* — general
 * information from the DC, which normally asks nobody for anything and occasionally does.
 *
 * 🔴 **The property that makes it safe to offer at all is that it costs nothing**, and that is
 * asserted here rather than described: `other` is outside `CARRIES_SLA`, so nothing starts a
 * clock or an escalation ladder, and General kinds are excluded from `summary.unacknowledged`
 * (M11-02) — **an unanswered invitation is not a gap anywhere.**
 */
describe('an Information notice that asks who is coming', () => {
  it('counts the answers, exactly as a meeting does', () => {
    const tally = attendanceFor(
      'other',
      [attempt({ via: 'link', said: ATTENDING }), attempt({ via: 'link', said: NOT_ATTENDING })],
      { invited: true },
    );

    expect(tally?.attending).toBe(1);
    expect(tally?.notAttending).toBe(1);
    expect(tally?.told).toBe(2);
  });

  it('counts nothing at all when the operator did not ask', () => {
    /**
     * Per message, never per kind. A notice about a closed road must not draw an attendance
     * panel, and **null rather than an empty tally** is the difference between the panel not
     * being drawn and the panel saying *"nobody is coming"* about a road closure.
     */
    expect(attendanceFor('other', [attempt({ via: 'link', said: ATTENDING })])).toBeNull();
    expect(
      attendanceFor('other', [attempt({ via: 'link', said: ATTENDING })], { invited: false }),
    ).toBeNull();
  });

  it('never counts on a kind the district did not ask for it on', () => {
    // "Attending" is not an answer to a duty roster for the 14th to the 20th, nor to a road
    // accident. `invited` is read for `other` and for nothing else, so a stray flag is inert.
    for (const kind of ['schedule', 'emergency', 'alert', 'advisory', 'order'] as MessageKind[]) {
      expect(
        attendanceFor(kind, [attempt({ via: 'link', said: ATTENDING })], { invited: true }),
        `${kind} must not grow a tally`,
      ).toBeNull();
    }
  });

  it('🔴 owes nobody an answer, invited or not — no clock and no ladder', () => {
    /**
     * The whole reason this was safe to build, and it is one line of existing behaviour rather
     * than anything added here. If `other` ever joins `CARRIES_SLA`, an unanswered Milad
     * invitation starts escalating over an officer's head at 02:00 — which is INV-08's
     * alert-fatigue failure arriving through the front door the district opened themselves.
     */
    expect(CARRIES_SLA.has('other')).toBe(false);
    expect(isGeneral('other')).toBe(true);
  });
});
