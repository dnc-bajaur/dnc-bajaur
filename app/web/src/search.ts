/**
 * Finding an old emergency, on a screen — capability group 9.
 *
 * `/search` existed for a day with nothing calling it, which is not a capability. An officer
 * asked to produce a post-incident report about something from March had no way to reach it
 * unless somebody had written the incident id down.
 *
 * Two things this screen must do that a results list does not do by default:
 *
 * **Say what it searched.** An empty result and an empty *window* look identical, and only one
 * of them means the emergency never happened. The server resolves and echoes the window
 * precisely so a screen can print it; printing it is the whole point (ADR-0005 — an absence is
 * never rendered as a fact).
 *
 * **Say when there is more.** "200 results" and "at least 200 results" are different answers,
 * and only one of them means somebody should narrow the search.
 *
 * Rows are built by the same `incidentRow` the board uses, so an incident found here reads
 * exactly as it does there — including its unmet notifications, which is the thing a search
 * result would otherwise quietly drop.
 */

import { incidentRow, type IncidentRowData } from './incidentRow.js';

interface SearchResponse {
  asOf: string;
  searched: { from: string; to: string; text: string | null; status: string | null };
  total: number;
  truncated: boolean;
  incidents: IncidentRowData[];
}

export interface SearchPanel {
  show(): void;
  /** So the shell can stop work when somebody leaves the screen. */
  reset(): void;
}

export interface SearchOptions {
  /** Opening one goes through the shell's existing detail screen, never a second one. */
  readonly onOpen: (incidentId: string) => void;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** A date for an `<input type="date">`, in the browser's own reckoning. */
function asDateValue(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function readable(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function mountSearch(options: SearchOptions): SearchPanel {
  const form = el<HTMLFormElement>('searchForm');
  const text = el<HTMLInputElement>('searchText');
  /**
   * **The Record's one date range** — Phase 5, and these ids are the seam.
   *
   * They used to be this form's own `searchFrom`/`searchTo`, which meant the district chose a
   * period in three separate places — here, in the download block and on the Reports screen —
   * with nothing keeping them in step. One pair now serves all three, addressed by name.
   */
  const from = el<HTMLInputElement>('reportFrom');
  const to = el<HTMLInputElement>('reportTo');
  const status = el<HTMLSelectElement>('searchStatus');
  const summary = el('searchSummary');
  const rows = el('searchRows');
  const note = el('searchNote');
  const error = el('searchError');

  let running = false;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    error.hidden = true;
    summary.textContent = 'Searching…';

    const params = new URLSearchParams();
    if (text.value.trim().length > 0) params.set('q', text.value.trim());
    if (from.value.length > 0) params.set('from', `${from.value}T00:00:00.000Z`);
    if (to.value.length > 0) params.set('to', `${to.value}T23:59:59.999Z`);
    if (status.value.length > 0) params.set('status', status.value);

    try {
      const res = await fetch(`/search?${params.toString()}`, { cache: 'no-store' });

      if (!res.ok) {
        // Said in words rather than as a code. An operator who sees "403" goes to find
        // somebody; an operator who sees what happened decides what to do next.
        error.hidden = false;
        error.textContent =
          res.status === 403
            ? 'You hold no post at the moment, so there is nothing to search.'
            : 'Could not search just now. The record is fine — this screen could not reach it.';
        summary.textContent = '';
        rows.replaceChildren();
        return;
      }

      const data = (await res.json()) as SearchResponse;
      const at = Date.parse(data.asOf);

      rows.replaceChildren(...data.incidents.map((row) => incidentRow(row, at)));

      /**
       * The window, always, and especially when nothing was found.
       *
       * "Nothing matched" and "nothing matched in the fortnight you happened to search" are
       * different statements about the district, and an operator reading the first when the
       * truth is the second concludes an emergency never happened.
       */
      const window = `${readable(data.searched.from)} to ${readable(data.searched.to)}`;

      if (data.incidents.length === 0) {
        summary.textContent =
          data.searched.text === null
            ? `Nothing recorded between ${window}.`
            : `Nothing matching “${data.searched.text}” happened between ${window}.`;
      } else {
        summary.textContent =
          `${String(data.total)} ` +
          `${data.total === 1 ? 'emergency' : 'emergencies'} between ${window}.`;
      }

      // Its own sentence, not a full page left to speak for itself.
      note.hidden = !data.truncated;
      if (data.truncated) {
        note.textContent =
          'There are more than these. Narrow the dates or the words — what is shown is the ' +
          'most recent, and the rest are not on this screen.';
      }
    } catch {
      error.hidden = false;
      error.textContent =
        'No connection. Search reads the record on the server, so it needs one — ' +
        'reporting an emergency does not.';
      summary.textContent = '';
      rows.replaceChildren();
    } finally {
      running = false;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });

  rows.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
    const id = row?.dataset['incident'];
    if (id !== undefined) options.onOpen(id);
  });

  return {
    show(): void {
      // Ninety days back by default: wide enough that the first search somebody tries
      // usually finds the thing, narrow enough to stay quick.
      if (from.value.length === 0) {
        from.value = asDateValue(new Date(Date.now() - 90 * 86_400_000).toISOString());
      }
      if (to.value.length === 0) to.value = asDateValue(new Date().toISOString());
      text.focus();
    },
    reset(): void {
      running = false;
    },
  };
}
