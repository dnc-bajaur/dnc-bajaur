/**
 * The administration console — M1a.
 *
 * ADR-0010 made the DC Office and the AC Headquarter Bajaur Office the authority for the
 * whole district. This module is what that authority actually does: create and retire
 * departments, set the acknowledgement deadlines everything is measured against, and see
 * the district whole.
 *
 * **It no longer decides where an emergency goes.** Routing signals lived here until
 * ADR-0022; the control room assigns by hand now, so the console configures who exists and
 * what they are measured against, and stops there.
 *
 * Two rules run through every function here.
 *
 * **The gate is one function.** `requireAdministration` is the only place the question is
 * asked, so there is exactly one thing to audit and exactly one thing to get wrong. It is
 * asked on reads as well as writes: the district-wide performance view is every department's
 * responsiveness in one table, which is not a thing one department gets to browse about
 * another (INV-05).
 *
 * **Nothing is deleted.** Departments retire; the config log keeps every change.
 * A department that stops existing must not take its incidents' meaning with it (ADR-0001).
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Severity } from '../domain/events.js';
import { SEVERITY_ORDER } from '../domain/events.js';
import {
  listDepartments,
  loadSlaConfiguration,
  recentConfigChanges,
  setSlaTarget,
  clearSlaTarget,
  type ConfigActor,
  type Department,
} from '../db/configStore.js';
import { sweep, type IntegrityReport } from '../ops/integrity.js';

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

/**
 * The gate.
 *
 * **403 rather than 404**, which is the opposite of what incident reads do — and the
 * difference is deliberate. An incident's existence is itself sensitive, so a seat with no
 * authority over one is told it does not exist. The administration console is not a secret:
 * every account knows the console exists and an `operator` or `viewer` knows it is not theirs.
 * A 404 there would only make a legitimate access problem — an account demoted an hour ago —
 * look like a broken URL at the moment they are trying to work out why.
 *
 * `identity.isAdministration` is the access role, re-read every request — since ADR-0032
 * phase 2b it is exactly `role === 'owner' || role === 'admin'`, never a seat. A duty post is
 * not required and is not looked at; an account minted through Settings holds no seat at all.
 */
export function requireAdministration<T>(identity: Identity): AdminResult<T> | null {
  if (!identity.isAdministration) {
    return refuse(
      403,
      'only the DC Office and the AC Headquarter Bajaur Office may configure the district',
    );
  }
  return null;
}

function actorOf(identity: Identity): ConfigActor {
  return { seatId: identity.seatId, personId: identity.personId };
}

//------------------------------------------------------------------------------
// The department registry, as the console needs it
//------------------------------------------------------------------------------

export interface DepartmentView extends Department {
  /** Only the severities this department has overridden. Empty means it uses the default. */
  readonly slaOverrides: Partial<Record<Severity, number>>;
  /**
   * Live posts in this department that nobody currently holds.
   *
   * A department with no holder is a department the control room can assign an emergency to
   * and then not be able to tell anybody about — which is exactly Rescue 1122's situation in
   * the district's own contact list, and exactly the kind of gap that stays invisible until
   * the night it matters (ADR-0005). It mattered when signals sent work here on their own;
   * it matters just as much now that an operator does, and the console says so either way.
   */
  readonly vacantSeats: number;
  readonly seats: number;
}

export async function departmentsForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<readonly DepartmentView[]>> {
  const denied = requireAdministration<readonly DepartmentView[]>(identity);
  if (denied !== null) return denied;

  // Three queries, whatever the district's size.
  //
  // There were four until ADR-0022, and before that eighty: a per-department signal lookup
  // ran in a loop, which on a test database of 1528 departments produced a console that never
  // finished loading. The fix was one grouped query; the removal of routing took even that
  // away. The rule the incident left behind still stands for everything below — read the
  // whole table once, never once per row.
  const [departments, sla, staffing] = await Promise.all([
    listDepartments(pool),
    loadSlaConfiguration(pool),
    seatCounts(pool),
  ]);

  return {
    ok: true,
    value: departments.map((d) => ({
      ...d,
      slaOverrides: sla.byDepartment[d.departmentId] ?? {},
      seats: staffing[d.departmentId]?.seats ?? 0,
      vacantSeats: staffing[d.departmentId]?.vacant ?? 0,
    })),
  };
}

function seatCounts(
  _pool: Pool,
): Promise<Readonly<Record<string, { seats: number; vacant: number }>>> {
  /**
   * ⚠️ **ALWAYS EMPTY SINCE ADR-0030, AND IT TOUCHES NO DATABASE.**
   *
   * It counted posts and vacancies PER DEPARTMENT, for the console's department cards — and
   * `departmentsForConsole` above now has no cards to put them on, because `listDepartments`
   * answers an empty list. Migration 0039 dropped the column it grouped by.
   *
   * The district's own count of posts and vacancies is not lost: `rosterFor` returns
   * `unreachablePosts` over the whole roster, which is the same question asked once instead of
   * seventy-nine times.
   */
  const rows: { department_id: string; seats: string; vacant: string }[] = [];

  const out: Record<string, { seats: number; vacant: number }> = {};
  for (const r of rows) {
    out[r.department_id] = { seats: Number(r.seats), vacant: Number(r.vacant) };
  }
  return Promise.resolve(out);
}

export interface CreateDepartmentInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly contactPhone?: unknown;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * ADR-0030 — ADDING, EDITING, RETIRING AND RESTORING A DEPARTMENT ARE GONE.
 *
 * These three handlers were the M1a gate in one function: an operator created a department
 * from a screen and an emergency reached it with nobody touching the code. That gate is not
 * failed, it is ANSWERED — the district said the layer it configured is not how Bajaur is
 * organised, and migration 0039 dropped the table underneath it.
 *
 * Removed rather than left refusing, and a sentence is left in their place because the next
 * person to look for them will be looking for a bug. departmentsForConsole survives above
 * and answers an empty list; the POST and PATCH routes no longer exist.
 */

//------------------------------------------------------------------------------
// SLA targets
//------------------------------------------------------------------------------

function isSeverityValue(v: unknown): v is Severity {
  return (
    typeof v === 'string' && ((SEVERITY_ORDER as readonly string[]).includes(v) || v === 'unknown')
  );
}

/**
 * Set one acknowledgement deadline — for a department, or for the district.
 *
 * `unknown` is a settable severity here, and it has to be. It is not a level (ADR-0009), but
 * an unassessed report still needs a deadline, and that deadline is precisely where the
 * urgency lives now that intake no longer guesses `high`. Leaving it unsettable would put
 * the one number that expresses "get a human to look at this" back into a source file.
 */
export async function setTarget(
  pool: Pool,
  identity: Identity,
  input: {
    readonly departmentId?: unknown;
    readonly severity?: unknown;
    readonly ackMinutes?: unknown;
  },
): Promise<AdminResult<{ readonly set: true }>> {
  const denied = requireAdministration<{ readonly set: true }>(identity);
  if (denied !== null) return denied;

  if (!isSeverityValue(input.severity)) {
    return refuse(400, 'severity must be critical, high, moderate, low, or unknown');
  }
  /**
   * `null` means **take this department's own deadline away**, so it inherits the district's
   * again — 2026-08-19.
   *
   * 🔴 The console has told administrators *"clear it to go back"* since M1a and nothing
   * implemented it: this route refused anything that was not a number, so an exception once
   * made was permanent. The workaround that leaves is worse than the gap — typing the
   * district's own figure into the box looks identical and behaves differently, because the
   * row then stops following the district the day the district changes its default.
   *
   * ⚠️ **Undefined is still refused.** A caller that forgot the field is not a caller asking
   * for the district's value back, and treating the two alike would let a bug erase a
   * deadline. Only an explicit `null` clears.
   */
  const clearing = input.ackMinutes === null;
  if (!clearing && typeof input.ackMinutes !== 'number') {
    return refuse(400, 'ackMinutes must be a number of minutes, or null to clear');
  }

  /**
   * ADR-0030 — A DEADLINE IS THE DISTRICT'S, AND THERE IS NO LONGER A SECOND DIMENSION.
   *
   * `sla_target` was keyed on (department, severity) and migration 0039 dropped the first half
   * with the table. A row is per severity now, and `departmentId` is pinned to null rather than
   * read from the request.
   *
   * ⚠️ **A REQUEST THAT NAMES ONE IS REFUSED, NOT IGNORED.** Silently dropping the field would
   * take *"set Rescue's fire deadline to five minutes"* and write the DISTRICT'S — a caller
   * would be told it worked, the number would move for everybody, and the screen it came from
   * would show exactly what was asked for. That is this codebase's worst signature.
   */
  if (input.departmentId !== undefined && input.departmentId !== null) {
    return refuse(
      400,
      'deadlines are the district’s now — a department cannot have its own (ADR-0030)',
    );
  }
  const departmentId = null;

  // Asked for before anything is written, and the database refuses a 'retired' row without one
  // anyway, so collecting it afterwards would mean discovering the refusal after the operator
  // believed it was done.
  const why = clearing ? text((input as { readonly reason?: unknown }).reason) : undefined;
  if (clearing && why === undefined) {
    return refuse(400, 'say why this deadline is being cleared');
  }

  const result = clearing
    ? await clearSlaTarget(pool, departmentId, input.severity, actorOf(identity), why!)
    : await setSlaTarget(
        pool,
        departmentId,
        input.severity,
        input.ackMinutes as number,
        actorOf(identity),
      );
  return result.ok ? { ok: true, value: { set: true } } : refuse(400, result.why);
}

export async function slaForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<Awaited<ReturnType<typeof loadSlaConfiguration>>>> {
  const denied = requireAdministration<Awaited<ReturnType<typeof loadSlaConfiguration>>>(identity);
  if (denied !== null) return denied;
  return { ok: true, value: await loadSlaConfiguration(pool) };
}

//------------------------------------------------------------------------------
// The configuration history
//------------------------------------------------------------------------------

/**
 * What is wrong with the district's configuration, right now (W-01).
 *
 * On the console rather than only in a terminal, because the findings are the two offices'
 * to act on: a post nobody holds, a department no signal reaches, a stand-in number still
 * standing in. Nothing here is a decision this system gets to make.
 */
export async function integrity(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<IntegrityReport>> {
  const denied = requireAdministration<IntegrityReport>(identity);
  if (denied !== null) return denied;
  return { ok: true, value: await sweep(pool) };
}

export async function configHistory(
  pool: Pool,
  identity: Identity,
  limit?: number,
): Promise<AdminResult<Awaited<ReturnType<typeof recentConfigChanges>>>> {
  const denied = requireAdministration<Awaited<ReturnType<typeof recentConfigChanges>>>(identity);
  if (denied !== null) return denied;
  return { ok: true, value: await recentConfigChanges(pool, limit ?? 50) };
}
