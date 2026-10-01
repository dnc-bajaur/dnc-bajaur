/**
 * The two importance panels' row list and "and N more" line — M10-20…25/41/42.
 *
 * Pure. No database, no clock — `capImportance` is handed rows already gathered by
 * `api/dashboard.ts`'s own fold, the same way `domain/activity.ts` is.
 *
 * ## Why this is not `activity.ts` with a different filter
 *
 * `windowActivity` caps by a **rolling time window** — the last 24 hours, whatever that holds.
 * These panels cap a list of **currently open** emergencies, which do not expire by age: an
 * emergency unacknowledged for three days is exactly as open as one from ten minutes ago, and a
 * time window would let it silently age out of the panel that exists to keep it visible. So the
 * cap here is by **count**, ordered by what needs attention first, never by a clock.
 *
 * ## No id, on the same rule as everything else on this screen
 *
 * ADR-0013 §1: the dashboard shows aggregates, nothing on it is a thing to open. A row here is
 * words and a time, exactly like an `ActivityItem`, and for the same reason — see that file's
 * own header.
 */

import { severityRank, type AssessedSeverity, type Severity } from './events.js';

/**
 * How many rows a `small` panel can hold and stay legible at four metres.
 *
 * Deliberately fewer than `activity.ts`'s twenty: that panel is `medium`/`large`, these are
 * `small` by design (see `domain/panels.ts`'s note on why they had to be, to fit the weight
 * budget without evicting anything else).
 */
export const VISIBLE_IMPORTANCE = 5;

export interface ImportanceRow {
  /** One line, already resolved to words — the same vocabulary `activity`'s rows use. */
  readonly headline: string;
  readonly detail: string | null;
  readonly acknowledged: boolean;
  readonly severity: Severity;
  /** For the oldest-first tiebreak. Null sorts last, never first — an unknown time is not "now". */
  readonly at: string | null;
}

export interface ImportanceWindow {
  readonly visible: readonly ImportanceRow[];
  /** How many were open and outside the visible cap — reported, never zero-by-omission. */
  readonly hidden: number;
  readonly total: number;
}

/**
 * Unassessed ranks above `critical`, mirroring `board.ts`'s own `attentionRank` — it could be
 * anything, so it is queued as though it might be the worst thing on the panel rather than
 * folded into a level nobody has actually assigned (ADR-0009).
 */
function urgency(row: ImportanceRow): number {
  if (row.severity === 'unknown') return severityRank('critical') + 1;
  return severityRank(row.severity as AssessedSeverity);
}

/**
 * Unacknowledged first, then most urgent, then oldest among ties — the same shape as the
 * board's own ordering, written fresh against a folded state rather than a `BoardRow` because
 * this runs before that projection exists in the caller.
 */
export function capImportance(
  rows: readonly ImportanceRow[],
  visibleCount: number = VISIBLE_IMPORTANCE,
): ImportanceWindow {
  const ordered = [...rows].sort((a, b) => {
    const ackA = a.acknowledged ? 1 : 0;
    const ackB = b.acknowledged ? 1 : 0;
    if (ackA !== ackB) return ackA - ackB;

    const urgencyDiff = urgency(b) - urgency(a);
    if (urgencyDiff !== 0) return urgencyDiff;

    return (a.at ?? '') < (b.at ?? '') ? -1 : 1;
  });

  return {
    visible: ordered.slice(0, visibleCount),
    hidden: Math.max(0, ordered.length - visibleCount),
    total: ordered.length,
  };
}

/**
 * What the panel says underneath its visible rows — mirrors `activity.ts`'s `moreSentence`.
 *
 * Null when nothing is held back, for the same reason: a permanent "and 0 more" is a line
 * people learn to stop reading, and then it is not there on the morning it says something.
 */
export function moreImportanceSentence(window: ImportanceWindow): string | null {
  if (window.hidden === 0) return null;
  return `and ${String(window.hidden)} more — all of it is on the board`;
}
