/**
 * The part of the permanent event record an operator can browse at once.
 *
 * Events are retained indefinitely. This is deliberately only the window the Record can search
 * interactively, so a slow control-room screen never turns an ordinary lookup into an unbounded
 * database read. The same ceiling must govern Search, the Record's open queue, and its day picker:
 * three answers to "how far back can I look?" would make an empty screen ambiguous again.
 */

import { districtDate, startOfDistrictDay, startOfNamedDistrictDay } from './districtTime.js';

/** Two years: enough for last year's floods without making every Record query unbounded. */
export const MAX_RECORD_DAYS = 730;

const DAY_MS = 86_400_000;

export interface RecordDateRange {
  /** Oldest district date the interactive Record can show. */
  readonly from: string;
  /** Newest district date the interactive Record can show. */
  readonly to: string;
}

/**
 * The date limits belong to Bajaur's calendar, not to the browser or server clock.
 *
 * `from` begins at a district midnight so the date picker never offers a partial or differently
 * zoned day. The query that reads a selected day adds its own small boundary buffer afterwards.
 */
export function recordDateRange(now: Date | string = new Date()): RecordDateRange {
  const at = now instanceof Date ? now : new Date(now);
  const start = new Date(startOfDistrictDay(at));
  return {
    from: districtDate(new Date(start.getTime() - MAX_RECORD_DAYS * DAY_MS)),
    to: districtDate(at),
  };
}

/**
 * Is one named district day old enough to fall outside the Record's interactive window?
 *
 * The date picker stops at today, but the API has always accepted a future day: daily-board
 * callers use that to ask whether today's case carries forward. Keep that compatibility here;
 * this guard exists to prevent the opposite failure, an old day falsely appearing empty because
 * its history was never loaded.
 */
export function isRecordDateAvailable(date: string, now: Date | string = new Date()): boolean {
  if (startOfNamedDistrictDay(date) === null) return false;
  const range = recordDateRange(now);
  // YYYY-MM-DD sorts in calendar order, unlike instants in two different timezones.
  return date >= range.from;
}

/**
 * How many arrival-days the event query must read to answer one selected district day.
 *
 * The extra two days are not a wider promise. They cover the current partial day and the district
 * boundary before the fold decides the incident's actual `occurredAt` day.
 */
export function recordLookbackDays(date: string, now: Date | string = new Date()): number | null {
  const from = startOfNamedDistrictDay(date);
  if (from === null) return null;
  const at = now instanceof Date ? now : new Date(now);
  return Math.max(2, Math.ceil((at.getTime() - Date.parse(from)) / DAY_MS) + 2);
}

/**
 * Arrival history needed for the open queue to cover every day inside its declared window.
 *
 * This uses the same boundary buffer as a selected oldest day. The extra arrival-days do not
 * extend what the Record promises to show; they keep an early-morning event on the first offered
 * date from falling outside a rolling query that starts later that same day.
 */
export function recordWindowLookbackDays(now: Date | string = new Date()): number {
  const at = now instanceof Date ? now : new Date(now);
  const range = recordDateRange(at);
  return recordLookbackDays(range.from, at) ?? MAX_RECORD_DAYS + 2;
}
