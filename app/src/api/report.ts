/**
 * The post-incident report over HTTP — M1-06.
 *
 * This module gathers; `domain/report.ts` folds. The split matters because the fold is where
 * every judgement lives — what counts as a gap, what a duration is measured from — and those
 * are testable without a database.
 *
 * **Authority is the incident's.** You may take a report of an emergency you are permitted to
 * read, and there is no separate report permission to fall out of step with that (INV-05).
 * A refused read is a 404, as everywhere else: confirming an incident exists to a seat with
 * no business seeing it is itself a disclosure.
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Uuid } from '../domain/events.js';
import { buildReport, renderReport, type PostIncidentReport } from '../domain/report.js';
import { readIncident } from './lifecycle.js';
import { departmentDirectory } from '../ops/directory.js';
import { listFor } from '../ops/evidence.js';

export type ReportResult =
  | { readonly ok: true; readonly report: PostIncidentReport; readonly text: string }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Every unit the district has, by id.
 *
 * The whole table rather than the ones this incident used, because a report may name a unit
 * that has since been retired — and a retired ambulance rendering as a uuid in the account of
 * the night it attended is precisely the failure the department registry was built to end.
 */
async function resourceNames(pool: Pool): Promise<Readonly<Record<string, string>>> {
  const { rows } = await pool.query<{ resource_id: string; name: string }>(
    'SELECT resource_id, name FROM resource',
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.resource_id] = r.name;
  return out;
}

export async function postIncidentReport(
  pool: Pool,
  incidentId: Uuid,
  identity: Identity,
  options: { readonly now?: string } = {},
): Promise<ReportResult> {
  const readable = await readIncident(pool, incidentId, identity);
  if (!readable.ok) return { ok: false, status: readable.status, error: readable.error };

  const [departments, resources, evidence] = await Promise.all([
    departmentDirectory(pool),
    resourceNames(pool),
    listFor(pool, incidentId),
  ]);

  const departmentNames: Record<string, string> = {};
  for (const [id, d] of Object.entries(departments)) departmentNames[id] = d.name;

  const seatTitles: Record<string, string> = {};
  const seatHolders: Record<string, string> = {};
  for (const [id, seat] of Object.entries(readable.actors.seats)) {
    seatTitles[id] = seat.title;
    if (seat.holder !== undefined) seatHolders[id] = seat.holder;
  }

  const report = buildReport({
    state: readable.state,
    // Already resolved by `readIncident`, which the authority check above went through anyway.
    // Fetching it again here would be a second query for a value this function is holding.
    reference: readable.reference,
    events: readable.events,
    generatedAt: options.now ?? new Date().toISOString(),
    seats: seatTitles,
    people: readable.actors.people,
    // `Ali Khan — AC HQ Bajaur` (a person) / `Imtiaz Ahmad — IT Soft` (a post) on the "Told:"
    // line and the "Who was told" section — the human then the post, either way
    // (whatsapp-response-workflow.md §6). Both resolved by `readIncident`.
    recipientDesignations: readable.actors.personSeats,
    seatHolders,
    departments: departmentNames,
    resources,
    evidence: evidence.map((e) => ({ filename: e.filename, capturedAt: e.capturedAt })),
  });

  return { ok: true, report, text: renderReport(report) };
}
