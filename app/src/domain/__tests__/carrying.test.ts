/**
 * **The things that do not finish at midnight** — the district's five, 2026-08-22.
 *
 * Pure, no database. What is protected here is that the five stay **one rule**: a predicate over
 * the two facts the record already holds, plus a per-item override the control room can move in
 * either direction. If this file ever needs to know which of the five something *is*, the design
 * has gone wrong — that is the taxonomy the panel deliberately is not.
 */

import { describe, expect, it } from 'vitest';

import { MESSAGE_KINDS, type MessageKind } from '../events.js';
import {
  CARRIED_LANES,
  LANE_LABELS,
  PLACEHOLDER_REVIEW_DAYS,
  VISIBLE_CARRIED,
  capCarried,
  laneOf,
  moreCarriedSentence,
  type CarriedRow,
  UNTIL_FURTHER_NOTICE,
  carriesByDefault,
  carryReason,
  outlivesTheDay,
  reviewLabel,
  reviewOf,
  reviewSentence,
} from '../carrying.js';
import { foldIncident } from '../incident.js';
import { INCIDENT, RESCUE, controlRoom, ev, shuffle } from './fixtures.js';

/** The six the reporting screen offers — `api/dashboard.ts`'s own `WATCHED`. */
const CATEGORIES: readonly string[] = ['fire', 'flood', 'rta', 'medical', 'security', 'other'];

describe('carriesByDefault', () => {
  it('carries the district four kinds: meeting, alert, advisory and information', () => {
    // Their words, in order: "rahegi till its done", the two that stay live for days, and
    // "iski date bhi specific nahi hoti".
    for (const kind of ['meeting', 'alert', 'advisory', 'other'] as const) {
      expect(carriesByDefault(kind, 'rta'), `${kind} should carry`).toBe(true);
    }
  });

  it('carries security and flood whatever kind of message announced them', () => {
    // The point of the whole design: a flood reported as an emergency is still a flood.
    expect(carriesByDefault('emergency', 'flood')).toBe(true);
    expect(carriesByDefault('emergency', 'security')).toBe(true);
    expect(carriesByDefault('order', 'flood')).toBe(true);
    expect(carriesByDefault('schedule', 'security')).toBe(true);
  });

  it('lets fire, rta and medical clear at the district midnight, which is Q5 answered yes', () => {
    for (const category of ['fire', 'rta', 'medical', 'other']) {
      expect(carriesByDefault('emergency', category), `${category} should clear`).toBe(false);
    }
  });

  it('treats an incident with no category at all as one of the ones that clear', () => {
    // Null is a complete answer here — it simply is not one of the two. It must not throw and
    // must not be read as "unknown, so keep it for ever", which is how a panel fills up.
    expect(carriesByDefault('emergency', null)).toBe(false);
    // …and a kind that carries still carries, because the kind is checked first.
    expect(carriesByDefault('meeting', null)).toBe(true);
  });

  it('answers for every kind the record can hold, without throwing', () => {
    // The property that must not rot. A kind added to `MESSAGE_KINDS` with no answer here would
    // silently decide the dashboard's reset behaviour for it, either way, and nothing would say.
    for (const kind of MESSAGE_KINDS) {
      for (const category of [...CATEGORIES, null]) {
        expect(typeof carriesByDefault(kind, category), `${kind}/${String(category)}`).toBe(
          'boolean',
        );
      }
    }
  });

  it('gives a security alert the same answer down either branch', () => {
    /**
     * The question that looked hardest — *Security, or Alert & Advisory?* — and this is what
     * dissolves it. A security alert is both, either branch returns true, and the panel never
     * has to decide which of the five it is.
     */
    expect(carriesByDefault('alert', 'security')).toBe(true);
    expect(carriesByDefault('alert', 'rta')).toBe(true);
    expect(carriesByDefault('emergency', 'security')).toBe(true);
  });

  it('the schedule kind is decided by its subject alone, which is the open question', () => {
    // Written down for the owner in backlog/for-the-owner.md. A duty roster spans days, but the
    // district listed five things and a schedule was not one of them. This test exists so the
    // day somebody changes it, they change it on purpose.
    expect(carriesByDefault('schedule', 'rta')).toBe(false);
    expect(carriesByDefault('schedule', 'flood')).toBe(true);
  });
});

function reported(kind: MessageKind, category: string) {
  return ev('reported', { reportId: 'rep-1', category, severity: 'moderate', kind });
}

describe('outlivesTheDay', () => {
  it('follows the default when the control room has said nothing', () => {
    const flood = foldIncident(INCIDENT, [reported('emergency', 'flood')]);
    const fire = foldIncident(INCIDENT, [reported('emergency', 'fire')]);

    expect(outlivesTheDay(flood)).toBe(true);
    expect(carryReason(flood)).toBe('default');
    expect(outlivesTheDay(fire)).toBe(false);
    expect(carryReason(fire)).toBe('default');
  });

  it('holds a fire past midnight when the control room says so', () => {
    /**
     * The three-day fire. Default-only would have taken it off the wall on day two, which is the
     * district's own complaint arriving from the other direction.
     */
    const state = foldIncident(INCIDENT, [
      reported('emergency', 'fire'),
      ev(
        'held_over',
        { reason: 'burning into a third day, DC wants it on the wall' },
        { actorSeatId: controlRoom.seatId },
      ),
    ]);

    expect(outlivesTheDay(state)).toBe(true);
    expect(carryReason(state)).toBe('held');
    expect(state.holdReason).toBe('burning into a third day, DC wants it on the wall');
    expect(state.heldOverBy?.seatId).toBe(controlRoom.seatId);
  });

  it('releases a flood that was over by lunchtime', () => {
    // The other direction, and it is the one that keeps the panel readable. Without it the
    // default holds a finished flood for ever, and the panel is as useless as the nightly reset.
    const state = foldIncident(INCIDENT, [
      reported('emergency', 'flood'),
      ev('hold_ended', { reason: 'water down by midday, nothing left to watch' }),
    ]);

    expect(outlivesTheDay(state)).toBe(false);
    expect(carryReason(state)).toBe('released');
    expect(state.holdEndReason).toBe('water down by midday, nothing left to watch');
  });

  it('lets a decision be reversed, and the latest one wins', () => {
    const held = foldIncident(INCIDENT, [
      reported('emergency', 'flood'),
      ev('hold_ended', { reason: 'looked finished' }),
      ev('held_over', { reason: 'rain again overnight' }),
    ]);

    expect(outlivesTheDay(held)).toBe(true);
    expect(carryReason(held)).toBe('held');
    // The one it replaced is cleared from the read fields, so a screen cannot render both.
    expect(held.holdEndedAt).toBeNull();
    expect(held.holdEndReason).toBeNull();
  });

  it('neither event moves the status, and that is the whole point of the pair', () => {
    /**
     * ⚠️ The single most important property in this feature. Releasing a flood from the panel
     * says the control room stopped watching it there; it does not say the flood is over. The
     * software cannot know that, and a fold that quietly resolved something would be the screen
     * making a claim nobody made.
     */
    const state = foldIncident(INCIDENT, [
      reported('emergency', 'flood'),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'rule-1' }),
      ev('held_over', { reason: 'still rising' }),
      ev('hold_ended', { reason: 'stood down' }),
    ]);

    expect(state.status).toBe('routed');
    expect(state.resolution).toBeNull();
  });

  it('folds the same whatever order the two events arrive in', () => {
    // Offline replay. `clientSeq` carries the ordering; the assertion is that these two events
    // do not become order-dependent on arrival time.
    const events = [
      reported('emergency', 'flood'),
      ev('held_over', { reason: 'still rising' }),
      ev('hold_ended', { reason: 'stood down' }),
    ];
    const inOrder = foldIncident(INCIDENT, events);
    for (const seed of [1, 2, 3, 11]) {
      expect(foldIncident(INCIDENT, shuffle(events, seed))).toEqual(inOrder);
    }
  });

  it('is independent of withdrawal — a row can be off the board and still carried', () => {
    // Two different questions about the same row: *should this be on the screen at all* and
    // *does this survive the daily reset*. Folding them together would make one unanswerable.
    const state = foldIncident(INCIDENT, [
      reported('emergency', 'flood'),
      ev('withdrawn', { reason: 'duplicate of the Nawagai report' }),
    ]);

    expect(state.withdrawnAt).not.toBeNull();
    expect(outlivesTheDay(state)).toBe(true);
  });
});

describe('reviewOf', () => {
  /**
   * 12:00 UTC is 17:00 in Bajaur, so "today" in the district is 2026-08-22 and it has seven
   * hours left in it. Every boundary assertion below is measured against the district's day and
   * never against the server's — which is the defect this project has now paid for three times.
   */
  const NOW = '2026-08-22T12:00:00.000Z';

  function carried(kind: MessageKind, details?: Record<string, string>, recordedAt = NOW) {
    return foldIncident(INCIDENT, [
      ev(
        'reported',
        {
          reportId: 'rep-1',
          category: 'flood',
          severity: 'moderate',
          kind,
          ...(details === undefined ? {} : { details }),
        },
        { recordedAt, occurredAt: recordedAt },
      ),
    ]);
  }

  it('takes the date the operator typed, over everything else', () => {
    // The district's own "kab tak". A person said a date; nothing here may second-guess it.
    const state = carried('meeting', { date: '2026-08-24', reviewBy: '2026-09-01' });
    const review = reviewOf(state, NOW);

    expect(review.date).toBe('2026-09-01');
    expect(review.source).toBe('operator');
    expect(review.due).toBe(false);
  });

  it('falls back to a meeting’s own date, which it already carries', () => {
    // Asking the operator for a second date about the same meeting is a form asking a question
    // it can answer itself.
    const review = reviewOf(
      carried('meeting', { subject: 'Monthly coordination', date: '2026-08-24' }),
      NOW,
    );

    expect(review.date).toBe('2026-08-24');
    expect(review.source).toBe('meeting');
    expect(review.due).toBe(false);
  });

  it('reads a schedule’s span as its review date rather than asking twice', () => {
    // `untilDate` already *is* this question for that one kind. Two boxes asking one question is
    // how they come to disagree.
    const review = reviewOf(
      carried('schedule', {
        subject: 'Flood duty roster',
        date: '2026-08-14',
        untilDate: '2026-08-20',
      }),
      NOW,
    );

    expect(review.date).toBe('2026-08-20');
    expect(review.source).toBe('operator');
    // 20 August ended two district days ago, so this is the row somebody should be asked about.
    expect(review.due).toBe(true);
  });

  it('uses the kind’s default window when nobody said anything', () => {
    const review = reviewOf(carried('other', { subject: 'Polio drive' }), NOW);

    expect(review.source).toBe('default');
    // 14 days of silence from the last thing recorded, in the district's own calendar.
    expect(review.date).toBe('2026-09-05');
    expect(review.due).toBe(false);
  });

  it('measures the default from the last activity, never from when it started', () => {
    /**
     * The district's own suggestion in Q6, and it is the better instrument: a flood being
     * updated daily is being worked, and a flood nobody has touched in a week is the one that
     * fills the panel. A fixed window from the start would nag the first and say nothing about
     * the second.
     */
    const quiet = foldIncident(INCIDENT, [
      ev(
        'reported',
        { reportId: 'rep-1', category: 'flood', severity: 'high' },
        { recordedAt: '2026-08-01T06:00:00.000Z', occurredAt: '2026-08-01T06:00:00.000Z' },
      ),
    ]);
    const worked = foldIncident(INCIDENT, [
      ev(
        'reported',
        { reportId: 'rep-1', category: 'flood', severity: 'high' },
        { recordedAt: '2026-08-01T06:00:00.000Z', occurredAt: '2026-08-01T06:00:00.000Z' },
      ),
      ev(
        'action_logged',
        { note: 'water level checked at Nawagai' },
        { recordedAt: '2026-08-22T06:00:00.000Z', occurredAt: '2026-08-22T06:00:00.000Z' },
      ),
    ]);

    expect(reviewOf(quiet, NOW).due).toBe(true);
    expect(reviewOf(worked, NOW).due).toBe(false);
  });

  it('never flags anything when the operator said “until further notice”', () => {
    const review = reviewOf(
      carried('other', { subject: 'Milad programme', reviewBy: UNTIL_FURTHER_NOTICE }),
      NOW,
    );

    expect(review.date).toBeNull();
    expect(review.source).toBe('further_notice');
    expect(review.due).toBe(false);
    expect(reviewLabel(review)).toBe('no end date');
  });

  it('treats anything it cannot parse as “no end date”, never as overdue', () => {
    // The safe direction, deliberately. A row that is never nagged is a row somebody still sees;
    // a row wrongly marked finished is one they stop looking at.
    const review = reviewOf(
      carried('other', { subject: 'Notice', reviewBy: 'next Thursday' }),
      NOW,
    );

    expect(review.due).toBe(false);
    expect(review.date).toBeNull();
  });

  it('falls due at the end of the DISTRICT day, not the server’s', () => {
    /**
     * 🔴 The assertion this project has paid for three times. At 19:30 UTC on the 22nd it is
     * already the 23rd in Bajaur — but a review dated the 22nd is **not** due until the district
     * day ends, which is 19:00 UTC. One instant either side of that boundary.
     */
    const state = carried('meeting', { subject: 'Coordination', date: '2026-08-22' });

    expect(reviewOf(state, '2026-08-22T18:59:00.000Z').due).toBe(false);
    expect(reviewOf(state, '2026-08-22T19:01:00.000Z').due).toBe(true);
  });

  it('answers for every kind the record can hold', () => {
    // A kind added with no default window would produce `NaN` days and a review date of
    // "Invalid Date" — which reads as a bug on the wall rather than as a missing entry here.
    for (const kind of MESSAGE_KINDS) {
      expect(PLACEHOLDER_REVIEW_DAYS[kind], `${kind} has no default window`).toBeGreaterThan(0);
      expect(reviewOf(carried(kind), NOW).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('the review flags and never closes', () => {
  const NOW = '2026-08-22T12:00:00.000Z';

  const overdue = foldIncident(INCIDENT, [
    ev(
      'reported',
      { reportId: 'rep-1', category: 'flood', severity: 'high', kind: 'alert' },
      { recordedAt: '2026-08-01T06:00:00.000Z', occurredAt: '2026-08-01T06:00:00.000Z' },
    ),
    ev(
      'routed',
      { departmentIds: [RESCUE], ruleId: 'rule-1' },
      { recordedAt: '2026-08-01T06:05:00.000Z' },
    ),
  ]);

  it('marks it, and the mark asks rather than asserts', () => {
    const review = reviewOf(overdue, NOW);

    expect(review.due).toBe(true);
    // "Its date has passed" is a fact about the calendar. "This is finished" is a claim about
    // Bajaur, and only a person in the control room can make it.
    expect(reviewSentence(review)).toBe('its date has passed — is this still running?');
  });

  it('says nothing at all while the review is not due', () => {
    // `moreImportanceSentence`'s rule: a line that is always there is one people stop reading,
    // and then it is not there on the morning it means something.
    const fresh = foldIncident(INCIDENT, [
      ev(
        'reported',
        { reportId: 'rep-1', category: 'flood', severity: 'high', kind: 'alert' },
        { recordedAt: NOW, occurredAt: NOW },
      ),
    ]);

    expect(reviewSentence(reviewOf(fresh, NOW))).toBeNull();
  });

  it('🔴 does not resolve it, hide it, or stop it being carried', () => {
    /**
     * The single most important property in Phase 2, and it is asserted rather than described.
     * Without a person, an overdue review changes **nothing**: the incident is still open, still
     * carried, and still on the panel — which is exactly what makes somebody ask about it.
     */
    expect(overdue.status).toBe('routed');
    expect(overdue.resolution).toBeNull();
    expect(overdue.withdrawnAt).toBeNull();
    expect(outlivesTheDay(overdue)).toBe(true);
  });
});

describe('the five lanes', () => {
  it('gives each of the district’s five its own word', () => {
    expect(laneOf('meeting', 'other')).toBe('meeting');
    expect(laneOf('emergency', 'flood')).toBe('flood');
    expect(laneOf('emergency', 'security')).toBe('security');
    expect(laneOf('advisory', 'rta')).toBe('alert');
    expect(laneOf('other', null)).toBe('info');
  });

  it('puts a security advisory on the SECURITY lane, which is the plan’s own example', () => {
    /**
     * ⚠️ The subject wins over the kind here, and it is the **opposite** order from
     * `carriesByDefault` — deliberately. The predicate checks the kind first so a reader cannot
     * conclude it is choosing between the five; this checks the subject first because *a
     * movement advisory about security* is what a room scanning for security is looking for.
     *
     * It is also the reverse of the recommendation put to the district in
     * `five-categories-questions.md`, and that is recorded as O-49 rather than hidden. This test
     * exists so the day somebody flips it, they flip it on purpose.
     */
    expect(laneOf('advisory', 'security')).toBe('security');
    expect(laneOf('alert', 'flood')).toBe('flood');
  });

  it('never fails to name a lane, whatever the record holds', () => {
    for (const kind of MESSAGE_KINDS) {
      for (const category of [...CATEGORIES, null]) {
        const lane = laneOf(kind, category);
        expect(CARRIED_LANES, `${kind}/${String(category)}`).toContain(lane);
        expect(LANE_LABELS[lane]).toBeTruthy();
      }
    }
  });

  it('decides nothing about whether a row is on the panel at all', () => {
    // The two are separate questions and must stay so. A fire has a lane word; it is not carried.
    expect(laneOf('emergency', 'fire')).toBe('info');
    expect(carriesByDefault('emergency', 'fire')).toBe(false);
  });
});

let rowSeq = 0;

function row(over: Partial<CarriedRow> = {}): CarriedRow {
  rowSeq += 1;
  return {
    // Distinct per row on purpose: `capCarried` reorders, and a shared id would let a test
    // pass while the panel put two different floods on one node.
    incidentId: `inc-${String(rowSeq)}`,
    lane: 'flood',
    headline: 'Nawagai UC — 3 villages',
    detail: null,
    since: '2026-08-20T06:00:00.000Z',
    lastRecordedAt: '2026-08-22T06:00:00.000Z',
    reviewMark: null,
    reviewLabel: '2026-08-30',
    attendance: null,
    reason: 'default',
    ...over,
  };
}

describe('capCarried', () => {
  it('puts what is asking for something first, then what has run longest', () => {
    const window = capCarried([
      row({ headline: 'newest', since: '2026-08-22T06:00:00.000Z' }),
      row({ headline: 'oldest', since: '2026-08-14T06:00:00.000Z' }),
      row({
        headline: 'due',
        since: '2026-08-21T06:00:00.000Z',
        reviewMark: 'its date has passed',
      }),
    ]);

    // The row asking a question outranks the older one that is not, because the failure Phase 2
    // exists to prevent is precisely a finished item nobody closed sitting below the fold.
    expect(window.visible.map((r) => r.headline)).toEqual(['due', 'oldest', 'newest']);
  });

  it('never groups by lane, which would rebuild the five panels this design refused', () => {
    const window = capCarried([
      row({ lane: 'flood', headline: 'day 9', since: '2026-08-13T06:00:00.000Z' }),
      row({ lane: 'meeting', headline: 'Monday', since: '2026-08-22T06:00:00.000Z' }),
      row({ lane: 'flood', headline: 'day 2', since: '2026-08-20T06:00:00.000Z' }),
    ]);

    // Oldest first, whatever lane it wears. Grouping would put a quiet meeting above a flood on
    // its ninth day.
    expect(window.visible.map((r) => r.headline)).toEqual(['day 9', 'day 2', 'Monday']);
  });

  it('sorts a row with no start time last, never first', () => {
    // An unknown time is not "long ago" — the same rule `capImportance` follows for `at`.
    const window = capCarried([
      row({ headline: 'unknown', since: null }),
      row({ headline: 'known' }),
    ]);

    expect(window.visible.map((r) => r.headline)).toEqual(['known', 'unknown']);
  });

  it('says how many it is holding back, and names where they are', () => {
    const many = Array.from({ length: VISIBLE_CARRIED + 4 }, (_, i) =>
      row({ headline: `row ${String(i)}`, since: `2026-08-0${String((i % 9) + 1)}T06:00:00.000Z` }),
    );
    const window = capCarried(many);

    expect(window.visible).toHaveLength(VISIBLE_CARRIED);
    expect(window.hidden).toBe(4);
    expect(window.total).toBe(VISIBLE_CARRIED + 4);
    expect(moreCarriedSentence(window)).toBe('and 4 more — all of it is on the Record');
  });

  it('says nothing at all when nothing is held back', () => {
    // `moreImportanceSentence`'s rule: a permanent "and 0 more" is a line people stop reading,
    // and then it is not there on the morning it says 35.
    expect(moreCarriedSentence(capCarried([row()]))).toBeNull();
    expect(moreCarriedSentence(capCarried([]))).toBeNull();
  });
});
