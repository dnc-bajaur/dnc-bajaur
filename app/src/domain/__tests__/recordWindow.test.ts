import { describe, expect, it } from 'vitest';

import {
  isRecordDateAvailable,
  MAX_RECORD_DAYS,
  recordDateRange,
  recordLookbackDays,
  recordWindowLookbackDays,
} from '../recordWindow.js';

describe('the Record history window', () => {
  const now = new Date('2026-08-26T10:00:00.000Z');

  function dayBefore(date: string): string {
    const at = new Date(`${date}T12:00:00.000Z`);
    at.setUTCDate(at.getUTCDate() - 1);
    return at.toISOString().slice(0, 10);
  }

  it('offers one server-decided Bajaur date range, including both ends', () => {
    const range = recordDateRange(now);

    expect(range.to).toBe('2026-08-26');
    expect(isRecordDateAvailable(range.from, now)).toBe(true);
    expect(isRecordDateAvailable(range.to, now)).toBe(true);
    expect(isRecordDateAvailable(dayBefore(range.from), now)).toBe(false);
    // The API's daily-board contract permits a future day; the picker itself is capped at today.
    expect(isRecordDateAvailable('2026-08-27', now)).toBe(true);
  });

  it('reads enough arrival history to answer the oldest offered day', () => {
    const range = recordDateRange(now);
    const days = recordLookbackDays(range.from, now);

    // The selected day plus the district-boundary buffer is still a bounded two-year query.
    expect(days).not.toBeNull();
    expect(days).toBeLessThanOrEqual(MAX_RECORD_DAYS + 3);
    expect(recordWindowLookbackDays(now)).toBe(days);
    expect(recordLookbackDays('not-a-date', now)).toBeNull();
  });
});
