/**
 * The district's clock — M9-04.
 *
 * **These tests would have failed on the production server and passed on the laptop**, which is
 * the entire reason they exist. The bug they lock down was invisible for exactly that reason:
 * `setHours` reads the machine's own zone, the laptop that wrote it sits in Pakistan, and the
 * server the district actually runs on is `Etc/UTC` in Helsinki (confirmed 2026-08-13).
 *
 * So the rule here is that **nothing below may depend on the zone the test runner is in.** Every
 * assertion is written against a fixed UTC instant and a known Bajaur wall-clock reading — never
 * against "now", never against a local-time constructor, and never against anything `TZ` can
 * move. A test for a timezone bug that inherits the developer's timezone is the test that let
 * this ship in the first place.
 *
 * Verified by running the file under four deliberately different zones — `Etc/UTC`,
 * `Pacific/Kiritimati` (UTC+14), `America/Anchorage` (UTC-9) and `Asia/Karachi` — all green.
 * Worth repeating by hand if these assertions are ever rewritten:
 *
 *     TZ=Pacific/Kiritimati npx vitest run src/domain/__tests__/districtTime.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  DISTRICT_TIMEZONE,
  districtDate,
  endOfDistrictDay,
  endOfNamedDistrictDay,
  last24Hours,
  rollingWindowStart,
  startOfDistrictDay,
  startOfNamedDistrictDay,
} from '../districtTime.js';

/**
 * Bajaur is UTC+05:00, so a district day begins at 19:00 UTC on the calendar day before.
 * Every expectation below is a restatement of that one sentence.
 */
const PLUS_FIVE = '19:00:00.000Z';

describe('the district timezone', () => {
  it('is Asia/Karachi and is not read from the machine', () => {
    expect(DISTRICT_TIMEZONE).toBe('Asia/Karachi');
  });
});

describe('startOfDistrictDay', () => {
  it('begins the day at 19:00 UTC the previous calendar day', () => {
    // 13 August, 02:01 in Bajaur — the exact moment the live defect was confirmed.
    expect(startOfDistrictDay('2026-08-12T21:01:36.000Z')).toBe(`2026-08-12T${PLUS_FIVE}`);
  });

  it('is the SAME day for 00:01 Bajaur and 23:59 Bajaur', () => {
    // The whole bug in one assertion. Under the old `setHours` on a UTC server these two
    // landed in different days, because the first is 19:01 UTC on the 12th and the second is
    // 18:59 UTC on the 13th.
    const justAfterMidnight = startOfDistrictDay('2026-08-12T19:01:00.000Z');
    const justBeforeMidnight = startOfDistrictDay('2026-08-13T18:59:00.000Z');
    expect(justAfterMidnight).toBe(justBeforeMidnight);
    expect(justAfterMidnight).toBe(`2026-08-12T${PLUS_FIVE}`);
  });

  it('rolls to the next day exactly at Bajaur midnight, not UTC midnight', () => {
    // One millisecond before and after 2026-08-13T00:00:00+05:00.
    expect(startOfDistrictDay('2026-08-12T18:59:59.999Z')).toBe(`2026-08-11T${PLUS_FIVE}`);
    expect(startOfDistrictDay('2026-08-12T19:00:00.000Z')).toBe(`2026-08-12T${PLUS_FIVE}`);
  });

  it('does NOT roll at UTC midnight', () => {
    // 00:00 UTC is 05:00 in Bajaur — the middle of the morning, and the same district day as
    // 23:00 UTC before it. This is the assertion that fails against the shipped code.
    const beforeUtcMidnight = startOfDistrictDay('2026-08-12T23:00:00.000Z');
    const afterUtcMidnight = startOfDistrictDay('2026-08-13T00:00:00.000Z');
    expect(beforeUtcMidnight).toBe(afterUtcMidnight);
  });

  it('crosses a month boundary correctly', () => {
    expect(startOfDistrictDay('2026-08-31T20:00:00.000Z')).toBe(`2026-08-31T${PLUS_FIVE}`);
    expect(startOfDistrictDay('2026-08-31T18:00:00.000Z')).toBe(`2026-08-30T${PLUS_FIVE}`);
  });

  it('crosses a year boundary correctly', () => {
    // 1 January 2027, 00:30 Bajaur.
    expect(startOfDistrictDay('2026-12-31T19:30:00.000Z')).toBe(`2026-12-31T${PLUS_FIVE}`);
  });

  it('handles a leap day', () => {
    expect(startOfDistrictDay('2028-02-29T10:00:00.000Z')).toBe(`2028-02-28T${PLUS_FIVE}`);
  });

  it('accepts a Date as readily as an instant', () => {
    const at = new Date('2026-08-12T21:01:36.000Z');
    expect(startOfDistrictDay(at)).toBe(startOfDistrictDay(at.toISOString()));
  });
});

describe('districtDate', () => {
  it('never slices the date out of a UTC instant', () => {
    // `'2026-08-12T21:01:36Z'.slice(0, 10)` says the twelfth. In Bajaur it is the thirteenth,
    // and a report filed under the twelfth is filed under a day the district did not choose.
    expect(districtDate('2026-08-12T21:01:36.000Z')).toBe('2026-08-13');
  });

  it('agrees with startOfDistrictDay on both sides of Bajaur midnight', () => {
    expect(districtDate('2026-08-12T18:59:59.999Z')).toBe('2026-08-12');
    expect(districtDate('2026-08-12T19:00:00.000Z')).toBe('2026-08-13');
  });

  it('reads midnight as 00 and not 24', () => {
    // `hourCycle` guards this. Read as 24 the day rolls one forward and every boundary is a
    // day late — a failure that only shows on one instant out of 86.4 million.
    expect(districtDate(`2026-08-12T${PLUS_FIVE}`)).toBe('2026-08-13');
  });
});

describe('endOfDistrictDay', () => {
  it('is one millisecond before the next day begins', () => {
    const end = endOfDistrictDay('2026-08-12T21:01:36.000Z');
    expect(end).toBe('2026-08-13T18:59:59.999Z');
    expect(new Date(end).getTime() + 1).toBe(
      new Date(startOfDistrictDay('2026-08-13T20:00:00.000Z')).getTime(),
    );
  });

  it('leaves no gap and no overlap across a month end', () => {
    const end = endOfDistrictDay('2026-08-31T20:00:00.000Z');
    const nextStart = startOfDistrictDay('2026-09-01T20:00:00.000Z');
    expect(new Date(end).getTime() + 1).toBe(new Date(nextStart).getTime());
  });
});

describe('startOfNamedDistrictDay', () => {
  it('reads a date the district asked for', () => {
    expect(startOfNamedDistrictDay('2026-08-13')).toBe(`2026-08-12T${PLUS_FIVE}`);
  });

  it('round-trips through districtDate', () => {
    for (const date of ['2026-01-01', '2026-08-13', '2026-12-31', '2028-02-29']) {
      expect(districtDate(startOfNamedDistrictDay(date)!)).toBe(date);
    }
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    // `new Date('2026-02-30')` is silently March. A report for the 30th of February must be
    // an error, not a report for the 2nd of March filed under a day nobody chose.
    expect(startOfNamedDistrictDay('2026-02-30')).toBeNull();
    expect(startOfNamedDistrictDay('2027-02-29')).toBeNull();
    expect(startOfNamedDistrictDay('2026-04-31')).toBeNull();
  });

  it('refuses anything that is not YYYY-MM-DD', () => {
    for (const bad of ['', '2026-8-13', '13-08-2026', '2026-13-01', '2026-00-10', 'yesterday']) {
      expect(startOfNamedDistrictDay(bad)).toBeNull();
    }
  });

  it('gives a whole day between its own start and end', () => {
    const start = startOfNamedDistrictDay('2026-08-13')!;
    const end = endOfNamedDistrictDay('2026-08-13')!;
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(86_400_000 - 1);
  });
});

describe('the rolling window', () => {
  it('is exactly 24 hours back, with no reference to midnight', () => {
    // The district's own example: at 23:30, show back to 23:30 yesterday.
    expect(last24Hours('2026-08-13T18:30:00.000Z')).toBe('2026-08-12T18:30:00.000Z');
  });

  it('includes an event exactly 24 hours old and excludes one a millisecond older', () => {
    const now = '2026-08-13T18:30:00.000Z';
    const start = last24Hours(now);

    const exactly24hAgo = '2026-08-12T18:30:00.000Z';
    const justOver = '2026-08-12T18:29:59.999Z';
    const justUnder = '2026-08-12T18:30:00.001Z';

    expect(exactly24hAgo >= start).toBe(true);
    expect(justOver >= start).toBe(false);
    expect(justUnder >= start).toBe(true);
  });

  it('does not jump at midnight, in either zone', () => {
    // The point of a rolling window: nothing happens to it when a day ticks over.
    const beforeBajaurMidnight = last24Hours('2026-08-12T18:59:59.999Z');
    const afterBajaurMidnight = last24Hours('2026-08-12T19:00:00.000Z');
    expect(new Date(afterBajaurMidnight).getTime() - new Date(beforeBajaurMidnight).getTime()).toBe(
      1,
    );
  });

  it('takes no timezone at all', () => {
    // Stated as a test because it is a design decision that would otherwise look like an
    // oversight: the window is subtraction, and a zone creeping into it would move it by five
    // hours the first time DISTRICT_TIMEZONE changed.
    expect(rollingWindowStart(24, '2026-08-13T18:30:00.000Z')).toBe('2026-08-12T18:30:00.000Z');
    expect(rollingWindowStart(1, '2026-08-13T00:00:00.000Z')).toBe('2026-08-12T23:00:00.000Z');
  });
});
