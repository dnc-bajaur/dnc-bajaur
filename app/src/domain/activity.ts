/**
 * What the district has been doing **today** — M9-38, M9-39, M9-40, and the window changed
 * 2026-08-19 (see `windowActivity`).
 *
 * Pure. No database, no clock of its own, `now` passed in like everything else in the domain.
 *
 * ## The requirement, and the word in it that decides the design
 *
 * The client asked for **twenty** visible alerts and updates, and for a new one to replace the
 * oldest **visible** one. *Visible* is the whole sentence. It is a statement about a screen, not
 * about a record — and the difference is the thing this file exists to keep true.
 *
 * A dashboard that "keeps the last 20" is one line of code and one very expensive habit: within
 * a week somebody asks *"what happened at eleven?"*, the screen has rotated past it, and the
 * honest answer — **it is in the record, on the board, in the search, in the daily report** —
 * is not the answer anybody believes, because the screen is what they trust. So this never
 * silently drops anything. It returns what it is not showing, **as a number**, and the panel
 * says it out loud: *"and 14 more earlier today"*.
 *
 * That sentence is the difference between a window and a memory hole.
 *
 * ## Why rotation is presentation and nothing else
 *
 * Nothing here writes. Nothing here is stored. `windowActivity` is called on every render from
 * the same events every other panel folds, so there is no rotation *state* that could disagree
 * with the log — no "seen" flag, no cursor, no queue that could lose an item during a restart.
 * Restart the server and the same twenty come back, because they are a function of the events
 * and the clock.
 *
 * ## No ids, deliberately
 *
 * `PanelRow` in `api/dashboard.ts` carries no id, and its comment explains why: the dashboard
 * shows aggregates, nothing on it is a thing to open, and sending a handle is the first step
 * towards a screen a room can click through to an emergency (ADR-0013 §1). An activity item is
 * the same kind of thing and follows the same rule. *Reachable* in M9-39 means reachable through
 * the board and the search — the screens with a session behind them — never from the wall.
 */

import { startOfDistrictDay } from './districtTime.js';
import type { Instant } from './events.js';

/**
 * How many the district sees at once.
 *
 * Twenty is the client's number, taken as given. Worth recording what it is a trade between:
 * fewer and a busy morning scrolls past before anybody reads it; more and the panel stops being
 * legible from across a room, which is the one thing a wall screen is for (ADR-0013).
 */
export const VISIBLE_ACTIVITY = 20;

/**
 * ~~How far back the main activity view looks. Phase 1's rolling window, M9-40.~~
 *
 * **Removed 2026-08-19, and the constant is gone rather than left at 24 unused** — the typecheck
 * is what finds the last caller, which is how this project closed the `FLAG_FILTERS.unassigned`
 * removal too. The window is now **the district's own day**; see `windowActivity`.
 */

export type ActivityKind = 'alert' | 'incident';

export interface ActivityItem {
  /** When it happened, not when it was recorded. Ordering the district would recognise. */
  readonly at: Instant;
  readonly kind: ActivityKind;
  /** One line, already resolved to words on the server. No screen re-derives this. */
  readonly headline: string;
  /** The second line, or null. Never a duplicate of the headline in different words. */
  readonly detail: string | null;
}

export interface ActivityWindow {
  /** The start of the rolling window, so the panel can say what it is looking at. */
  readonly since: Instant;
  readonly visible: readonly ActivityItem[];
  /**
   * How many fell inside the window and outside the twenty.
   *
   * **Reported, never zero-by-omission.** This number is what stops the panel being read as
   * "this is everything that happened", which is the reading that makes a rotating list
   * dangerous rather than merely partial.
   */
  readonly hidden: number;
  /** Everything in the window, hidden included. The panel says this out loud. */
  readonly total: number;
}

/**
 * The last day's alerts and updates, newest first, capped at what a screen can hold.
 *
 * An item with an unparseable time is **dropped rather than sorted to an end**. A row that
 * cannot be placed in time on a panel whose entire meaning is *recently* would be a row that
 * looks current and is not, and that is the one failure a wall screen must never produce
 * (`domain/wall.ts`'s whole header is about this).
 */
export function windowActivity(
  items: readonly ActivityItem[],
  now: Date | Instant = new Date(),
  visibleCount: number = VISIBLE_ACTIVITY,
): ActivityWindow {
  /**
   * **The district's day, not a rolling twenty-four hours** — the owner's decision, 2026-08-19.
   *
   * M9-37 chose the rolling window deliberately and said so: this panel answers *what has been
   * happening*, which is a different question from *what is today's*, and at the time the rest
   * of the screen was a rolling seven days anyway. **That reasoning no longer holds.** Every
   * other figure on this dashboard now resets at the district's midnight, and a panel still
   * counting backwards from `now` would put last night's hours on a screen whose counters had
   * already forgotten them — one surface describing two periods, which is the whole defect this
   * change exists to remove.
   *
   * The cost, stated: at 00:30 this panel is nearly empty where it used to carry the evening.
   * That is the reset being honest rather than the panel being broken, and it is the same trade
   * the counters above it already made.
   */
  const since = startOfDistrictDay(now);
  const floor = Date.parse(since);

  const inWindow = items
    .filter((item) => {
      const at = Date.parse(item.at);
      return !Number.isNaN(at) && at >= floor;
    })
    /**
     * Newest first, and **ties broken by nothing at all**.
     *
     * Two things recorded in the same millisecond keep the order they arrived in, which is the
     * order the caller folded them in. Inventing a tiebreak — by kind, by headline — would put
     * a stable-looking sequence on the screen that no one could explain, and the district would
     * eventually ask why an alert sorts above an emergency.
     */
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    since,
    visible: inWindow.slice(0, visibleCount),
    hidden: Math.max(0, inWindow.length - visibleCount),
    total: inWindow.length,
  };
}

/**
 * What the panel says underneath the twenty.
 *
 * Returned as a sentence rather than a count so the screen cannot render "14" beside a list of
 * twenty and leave a reader to work out what it counts. Null when there is nothing being held
 * back — a permanent "and 0 more" teaches people to stop reading the line, and then the line is
 * not there on the morning it says 40.
 */
export function moreSentence(window: ActivityWindow): string | null {
  if (window.hidden === 0) return null;

  return (
    `and ${String(window.hidden)} more earlier today — ` +
    'all of it is on the board and in the daily report'
  );
}
