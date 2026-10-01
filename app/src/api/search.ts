/**
 * Finding an old emergency — capability group 9, "full-history search".
 *
 * ⚠️ AMENDED 2026-08-19 (ADR-0021): this screen is FOLDED INTO THE RECORD and is no longer a
 * tab of its own. What follows describes why the selection is separate, which is unchanged.
 *
 * The board used to show the last seven days because that is what a shift needs. Everything
 * older was
 * reachable only by already knowing its incident id, which means a post-incident report about
 * something from March could be produced by anybody who had written the id down and by nobody
 * else. A record you cannot search is a filing cabinet without a drawer label.
 *
 * **This shares the board's projection and differs only in selection.** `projectIncidents`
 * does the fold, `evaluateRead` and `toRow`; search only decides *which* incidents to hand it.
 * That split is the point: two implementations of "what is the state of this incident" would
 * eventually disagree, and then a search result and the board would say different things about
 * the same emergency on the same screen.
 *
 * **Scoping is therefore the board's scoping, not a copy of it.** A department searching finds
 * its own incidents and never learns that a neighbour's exists — not hidden in the results,
 * never returned (INV-05).
 */

import { loadIncident, loadIncidentsMatching } from '../db/eventStore.js';
import { incidentForReference } from '../db/referenceStore.js';
import { parseReference } from '../domain/reference.js';
import { MAX_RECORD_DAYS } from '../domain/recordWindow.js';
import type { Pool } from '../db/pool.js';
import type { Seat } from '../domain/authority.js';
import { projectIncidents, type BoardRow } from './board.js';

/**
 * The widest window a single search may cover.
 *
 * Two years, because "what happened in last year's floods" is a real question and a limit that
 * cannot answer it would send people back to the paper register this system exists to replace.
 */
export const MAX_SEARCH_DAYS = MAX_RECORD_DAYS;

/** How many incidents one search may fold. Truncation is reported, never silent. */
export const SEARCH_LIMIT = 200;

export interface SearchRequest {
  readonly text?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchResult {
  readonly asOf: string;
  /** Echoed back, resolved. A screen must be able to say what it actually searched. */
  readonly searched: {
    readonly from: string;
    readonly to: string;
    readonly text: string | null;
    readonly status: string | null;
  };
  readonly total: number;
  /**
   * True when more incidents matched than could be folded.
   *
   * Named rather than implied by a full page, because "exactly 200 results" and "at least 200
   * results" are different answers and only one of them means somebody should narrow.
   */
  readonly truncated: boolean;
  readonly incidents: readonly BoardRow[];
}

function isInstant(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

/**
 * Work out the window actually searched.
 *
 * Both ends are resolved here rather than left to the database so the response can state them.
 * A search screen that cannot say *what period it looked at* invites the reading that an empty
 * result means "this never happened", when it may only mean "not in the fortnight I chose".
 * That is ADR-0005's rule — an absence must never be rendered as a fact — applied to a query.
 */
export function windowFor(request: SearchRequest, now: Date): { from: string; to: string } {
  const to = isInstant(request.to) ? new Date(request.to) : now;
  const widestFrom = new Date(to.getTime() - MAX_SEARCH_DAYS * 24 * 60 * 60 * 1000);

  const requestedFrom = isInstant(request.from)
    ? new Date(request.from)
    : new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Clamped rather than refused: somebody asking for ten years wants everything there is, and
  // an error page teaches them to stop using search rather than to pick a better date.
  const from = requestedFrom < widestFrom ? widestFrom : requestedFrom;

  return { from: from.toISOString(), to: to.toISOString() };
}

export async function search(
  pool: Pool,
  seat: Seat,
  request: SearchRequest,
  now = new Date(),
): Promise<SearchResult> {
  const { from, to } = windowFor(request, now);
  const limit = Math.min(Math.max(request.limit ?? SEARCH_LIMIT, 1), SEARCH_LIMIT);

  // One more than asked for, so a full page is distinguishable from an overflowing one.
  const grouped = await loadIncidentsMatching(pool, {
    from,
    to,
    text: request.text,
    limit: limit + 1,
  });

  const truncated = grouped.length > limit;

  /**
   * **Typing the district's own number finds the incident** — 2026-08-24.
   *
   * The number exists so a control room can quote one emergency to each other, and a number you
   * cannot then type into search is a number that sends them back to asking whoever wrote it
   * down. `DNC-BAJAUR-42`, `dnc-bajaur 42` and a bare `42` all land here (`parseReference`).
   *
   * **Added to the text results, never instead of them**, and that is the whole care in this
   * block. A district where `42` is also a house number in somebody's description keeps both
   * readings; replacing the results with the one exact hit would silently drop matches the
   * operator was looking at.
   *
   * ⚠️ **It deliberately ignores the date window.** Everything else here is a question about
   * when something happened; a number is a question about *which* incident, and answering
   * "nothing found" because an operator's period happened to start after it would be the
   * filing-cabinet-without-a-drawer-label failure this whole screen exists to end. Scoping is
   * untouched — the row still goes through `projectIncidents`, so a seat with no authority
   * over it gets nothing back and never learns the number belongs to anything (INV-05).
   *
   * Never counted against `truncated`: that flag is about the text search overflowing, and one
   * extra exact hit does not mean somebody should narrow.
   */
  const matched = truncated ? grouped.slice(0, limit) : grouped;
  const seq = request.text === undefined ? null : parseReference(request.text);
  const byReference =
    seq === null || matched.length >= limit ? null : await incidentForReference(pool, seq);
  const alreadyFound =
    byReference !== null && matched.some((events) => events[0]?.incidentId === byReference);
  const extra = byReference === null || alreadyFound ? [] : [await loadIncident(pool, byReference)];

  const board = await projectIncidents(pool, seat, [...extra, ...matched], {
    now: now.toISOString(),
    includeClosed: true,
  });

  const status = request.status?.trim().toLowerCase();
  const wanted =
    status === undefined || status.length === 0
      ? board.incidents
      : board.incidents.filter((row) => row.status === status);

  return {
    asOf: board.asOf,
    searched: {
      from,
      to,
      text: request.text?.trim() || null,
      status: status && status.length > 0 ? status : null,
    },
    total: wanted.length,
    truncated,
    incidents: wanted,
  };
}
