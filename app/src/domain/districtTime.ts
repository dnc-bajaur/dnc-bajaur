/**
 * The district's clock — M9-01.
 *
 * **One timezone, named once, read by everything that has to decide when a day begins.**
 *
 * ## Why this file exists
 *
 * Four places computed a day boundary before it did, each with its own `setHours`, and all four
 * were wrong on the machine the district actually runs on.
 *
 * `CLAUDE.md` §5 records fixing a `setHours`/`setUTCHours` disagreement once already — the
 * dashboard counted a slice of yesterday as today for five hours every night while the board it
 * linked to did not. The fix was to make everything use `setHours`, on the reasoning that the
 * server sits in the DC office and its local midnight *is* Bajaur's midnight.
 *
 * **That reasoning stopped being true when ADR-0019 moved the application to Hetzner Helsinki.**
 * `installer/cloud/setup.sh` enables NTP and never sets a timezone, and Ubuntu's default there is
 * UTC — confirmed on the running server, 2026-08-13: `Time zone: Etc/UTC (UTC, +0000)`. So the
 * district's "today" had been beginning at **05:00 Bajaur time**, and every counter, flag, report
 * boundary and nightly-backup check that said "today" was wrong between midnight and dawn.
 *
 * The lesson worth keeping: **the server's own timezone is not a fact about the district.** It is
 * a property of a rented machine in another country, and it can change without anybody here
 * touching a line of code. So nothing below reads it. The zone is named as data, and every
 * boundary is computed against that name.
 *
 * ## Rolling windows do not need a timezone, and calendar days cannot do without one
 *
 * Both live here because they are asked for together and confusing them is easy.
 * `rollingWindowStart` is pure subtraction — "the last 24 hours" means the same thing in every
 * zone on earth, which is exactly why the district asked for it (requirement 11). A *calendar*
 * day is the opposite: "the 13th of August" is a claim that only means something once somebody
 * says whose 13th, and that is what everything else here is for.
 */

/**
 * Bajaur. Confirmed by the owner, 2026-08-13.
 *
 * An IANA name rather than a fixed `+05:00`, even though Pakistan currently observes no daylight
 * saving. It has twice before — 2002, and 2008–2009 — and both times by an ordinance issued
 * weeks ahead. A fixed offset would need a code change and a deployment to follow that; a zone
 * name needs a `tzdata` update, which the operating system does on its own.
 */
export const DISTRICT_TIMEZONE = 'Asia/Karachi';

/** An ISO-8601 instant, as `domain/events.ts` uses the word. */
type Instant = string;

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Built once. `Intl.DateTimeFormat` is expensive to construct and free to reuse, and this is on
 * the path of every board request on a machine that is also accepting emergency reports.
 */
const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: DISTRICT_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** What a clock on a wall in Bajaur reads at this instant. */
function wallClockAt(at: Date): WallClock {
  const found: Record<string, number> = {};
  for (const part of PARTS.formatToParts(at)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value);
  }
  return {
    year: found['year'] ?? 0,
    month: found['month'] ?? 1,
    day: found['day'] ?? 1,
    // `hourCycle: 'h23'` so midnight is 0 and not 24. Without it this reads 24 for the first
    // hour of the day in some ICU versions, and every day boundary lands one day late.
    hour: (found['hour'] ?? 0) % 24,
    minute: found['minute'] ?? 0,
    second: found['second'] ?? 0,
  };
}

/**
 * How far ahead of UTC the district is at this instant, in milliseconds.
 *
 * Computed by reading the wall clock and asking how far it has drifted from the same instant
 * read as UTC — the standard trick, and the only one that does not require hardcoding an offset
 * this file has just finished explaining it will not hardcode.
 */
function offsetAt(at: Date): number {
  const wall = wallClockAt(at);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // Milliseconds are dropped from both sides rather than carried: `formatToParts` has no
  // millisecond field, so keeping them on one side only would put a sub-second error into
  // every boundary.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which a given district calendar day begins.
 *
 * The offset is resolved twice on purpose. The first pass asks "what is the offset around this
 * date"; if midnight happens to sit on the far side of a transition, the second pass corrects
 * it. Pakistan has no such transition today, which is precisely why this would otherwise go
 * untested until the ordinance that reintroduces one.
 */
function startOfDayOn(year: number, month: number, day: number): Date {
  const midnightAsIfUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  const first = offsetAt(new Date(midnightAsIfUtc));
  const candidate = midnightAsIfUtc - first;

  const second = offsetAt(new Date(candidate));
  return second === first ? new Date(candidate) : new Date(midnightAsIfUtc - second);
}

/**
 * The district's date at this instant, as `YYYY-MM-DD`.
 *
 * **Never `instant.slice(0, 10)`.** `reports.ts` carries a long comment about the bug that
 * produces: Bajaur is UTC+05:00, so the start of 6 August locally is `2026-08-05T19:00:00Z`, and
 * slicing the date out of it says the fifth. A date and an instant are different things, and
 * slicing one out of the other is where they part.
 */
export function districtDate(at: Instant | Date = new Date()): string {
  const wall = wallClockAt(at instanceof Date ? at : new Date(at));
  const month = String(wall.month).padStart(2, '0');
  const day = String(wall.day).padStart(2, '0');
  return `${String(wall.year)}-${month}-${day}`;
}

/**
 * Midnight at the start of the district day containing this instant.
 *
 * This is what "today" means everywhere in this system: the board's `occurredToday` flag, the
 * dashboard's counter beside it, the nightly backup's "have we already run" check, and the day
 * a report is filed under. One function, one answer — which is the same rule the previous fix
 * established and this one is keeping, against a zone that does not move under it.
 */
export function startOfDistrictDay(at: Instant | Date = new Date()): Instant {
  const wall = wallClockAt(at instanceof Date ? at : new Date(at));
  return startOfDayOn(wall.year, wall.month, wall.day).toISOString();
}

/** The last instant of the district day containing this one. Inclusive, to the millisecond. */
export function endOfDistrictDay(at: Instant | Date = new Date()): Instant {
  const start = new Date(startOfDistrictDay(at));
  const wall = wallClockAt(start);
  const nextDay = startOfDayOn(wall.year, wall.month, wall.day + 1);
  return new Date(nextDay.getTime() - 1).toISOString();
}

/**
 * Midnight at the start of a district day named as `YYYY-MM-DD`.
 *
 * For a report the district asked for by date. Returns null on anything that is not a real
 * calendar date, including `2026-02-30` — which `new Date()` would silently accept and roll
 * forward into March, filing a report under a day the district did not choose.
 */
export function startOfNamedDistrictDay(date: string): Instant | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const start = startOfDayOn(year, month, day);
  // The round trip is the validation. A rolled-over date renders as a different day than the
  // one asked for, and that is the only reliable way to catch it across every month length.
  if (districtDate(start) !== date) return null;

  return start.toISOString();
}

/** The last instant of a district day named as `YYYY-MM-DD`, or null if it is not one. */
export function endOfNamedDistrictDay(date: string): Instant | null {
  const start = startOfNamedDistrictDay(date);
  return start === null ? null : endOfDistrictDay(start);
}

/**
 * The start of a rolling window ending now — requirement 11.
 *
 * **Deliberately timezone-free.** At 23:30 the district wants to see back to 23:30 yesterday,
 * and that is subtraction: no zone, no calendar, no midnight. The zone above matters for what a
 * *day* is; it must not creep into what *the last 24 hours* is, or the window would jump by
 * five hours the first time somebody changed the constant at the top of this file.
 *
 * Kept here anyway, beside the calendar functions, because these two are asked for together and
 * a reader comparing them is exactly who needs to see that only one of them takes a zone.
 */
export function rollingWindowStart(hours: number, now: Instant | Date = new Date()): Instant {
  const at = now instanceof Date ? now : new Date(now);
  return new Date(at.getTime() - hours * 3_600_000).toISOString();
}

/** The district's rolling last 24 hours, as the dashboard's main activity view uses it. */
export function last24Hours(now: Instant | Date = new Date()): Instant {
  return rollingWindowStart(24, now);
}
