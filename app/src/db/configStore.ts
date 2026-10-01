/**
 * Reading and writing the district's configuration — departments, routing signals, SLA
 * targets — and recording every change.
 *
 * The write functions here all follow one shape: **do the thing and append a `config_event`
 * in the same transaction.** Not as a courtesy. A settings table that only holds the current
 * value cannot answer "why was this not flagged late?" six weeks later, and the two offices'
 * own decisions become unattributable. Migration 0007 has the longer argument.
 *
 * No authority checks live in this file. It is the store; `api/admin.ts` is the gate
 * (INV-05, and the same split `api/lifecycle.ts` uses for incidents).
 */

import type { Pool, PoolClient } from 'pg';

import type { Severity, Uuid } from '../domain/events.js';
import type { SlaTargets } from '../domain/sla.js';
import { panelById, parseLayout, type Layout } from '../domain/panels.js';
import {
  defaultCapabilities,
  parseCapabilities,
  type Capability,
  type CapabilityState,
} from '../domain/capabilities.js';

export interface Department {
  readonly departmentId: Uuid;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly contactPhone: string | null;
  readonly isAdministration: boolean;
  readonly retiredAt: string | null;
}

export interface ConfigActor {
  readonly seatId: Uuid | null;
  readonly personId: Uuid | null;
}

export type ConfigSubject =
  // ⚠️ 'department' is off this union (ADR-0031, phase 4) — nothing has written a `department`
  // config row since ADR-0030 deleted the create/edit/retire functions. The CHECK constraint
  // `config_event_subject_known` is deliberately NOT narrowed: it is append-only and validating
  // `ADD CONSTRAINT` against an install that holds old `department` rows would refuse at boot
  // (migration 0039 spells this out). `recentConfigChanges` still reads whatever the column says.
  | 'sla_target'
  | 'seat'
  | 'person'
  | 'duty'
  | 'resource'
  | 'channel_ladder'
  // Which services the district watches, and which televisions may read the wall feed. Both
  // are decisions of the two offices, so both are answerable for here (M4, ADR-0013).
  | 'utility'
  | 'wall_screen'
  // The district status board: its standing facts, and the advisories it issues (M4).
  | 'district_fact'
  | 'district_alert'
  // Which panels the district put on its own screen, and how big (ADR-0015, M6-28).
  | 'dashboard_layout'
  // Which screens this installation offers at all (ADR-0016, M6-42).
  | 'capability';

export type ConfigAction = 'created' | 'updated' | 'retired' | 'restored';

export interface ConfigChange {
  readonly eventId: Uuid;
  readonly seq: string;
  readonly subject: ConfigSubject;
  readonly subjectId: Uuid;
  readonly action: ConfigAction;
  readonly before: unknown;
  readonly after: unknown;
  readonly actorSeatId: Uuid | null;
  readonly actorSeatTitle: string | null;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
}

// ⚠️ `toDepartment`, `DEPARTMENT_COLUMNS` and `DepartmentRow` went with the writers below
// (ADR-0030) — all three only ever described a row of a table that no longer exists.
//
// The `Department` INTERFACE above stays: `listDepartments` still returns that shape, empty, so
// its three callers keep one type rather than each inventing a narrower one.

/**
 * Append a configuration change. Always inside the caller's transaction.
 *
 * Taking a `PoolClient` rather than a `Pool` is the point: the change and its record commit
 * together or not at all. A configuration change with no record of who made it is exactly
 * the thing this table exists to prevent, and a separate connection would make that a
 * possible outcome of a badly timed crash.
 */
export async function recordChange(
  tx: PoolClient,
  entry: {
    subject: ConfigSubject;
    subjectId: Uuid;
    action: ConfigAction;
    before: unknown;
    after: unknown;
    actor: ConfigActor;
    reason?: string | undefined;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO config_event
       (subject, subject_id, action, before, after, actor_seat_id, actor_person_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.subject,
      entry.subjectId,
      entry.action,
      entry.before === null || entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === null || entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.actor.seatId,
      entry.actor.personId,
      entry.reason ?? null,
    ],
  );
}

export async function inTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

//------------------------------------------------------------------------------
// Departments
//------------------------------------------------------------------------------

/**
 * ⚠️ **ALWAYS EMPTY SINCE ADR-0030, AND IT TOUCHES NO DATABASE.** Migration 0039 dropped the
 * table; this query would not merely return nothing, it would throw.
 *
 * It survives as a shape rather than as a lookup because three callers ask it one question —
 * *what is this department called* — while naming targets on the district's own past record
 * (`dispatchNames`, `performanceOver`, the utilities panel). Deleting it would have put that
 * removal inside this change instead of beside it, and each of those call sites has its own
 * reasoning about what an unnameable row should do.
 *
 * **They all already handle a name they cannot find**, because a department could be retired
 * from the registry long before this. So an empty directory is a case every one of them was
 * written for, and the answer it produces is the correct one: nothing is named, and nothing
 * draws a raw id in its place.
 *
 * The write half — create, edit, retire — is **deleted** rather than stubbed. A door onto a
 * thing the district has been told does not exist is the screen arguing for the old model,
 * which is the rule CD-07 applied to the picker's own *"Add a department"*.
 */
export function listDepartments(_pool: Pool): Promise<readonly Department[]> {
  return Promise.resolve([]);
}

/**
 * A stable slug from a name.
 *
 * The code is what the seed file and the code can both name while ids are generated and
 * names get corrected. Non-Latin names — and the district writes some — would slugify to
 * nothing, so those fall back to a generated code rather than colliding on the empty string.
 */
export function slugify(name: string, fallback: string): string {
  // Lowercase, trimmed, runs of whitespace collapsed. This lived in `domain/routing.ts` as
  // `normalise` and was shared with signal matching; ADR-0022 removed that module and left
  // slugging as the only caller, so it is inlined here rather than kept as a shared helper
  // with one user.
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

/**
 * ADR-0030 — CREATING, EDITING AND RETIRING A DEPARTMENT ARE GONE, WITH THE TABLE.
 *
 * `NewDepartment`, `DepartmentEdit`, `createDepartment`, `updateDepartment` and
 * `setDepartmentRetired` were removed here. Phase 2 took their callers off `api/admin.ts` and
 * their routes off the server; migration 0039 then dropped the table their SQL names, so they
 * could only ever throw.
 *
 * ⚠️ What they enforced, recorded because nothing else does: a department **code** was unique
 * and generated from the name by `slugify`, which survives above and is still what the seed
 * loader uses; retiring wrote a `retired` row to the config log **with a reason**, because
 * migration 0007 refuses one without — the same CHECK that caught `clearSlaTarget` twice.
 */

//------------------------------------------------------------------------------
// SLA targets
//------------------------------------------------------------------------------

export interface SlaConfiguration {
  /** Applied when a department has set nothing of its own. */
  readonly district: SlaTargets;
  /** departmentId → the severities that department has overridden. Partial by design. */
  readonly byDepartment: Readonly<Record<string, Partial<Record<Severity, number>>>>;
}

interface SlaRow {
  department_id: string | null;
  severity: Severity;
  ack_minutes: number;
}

/**
 * Read the whole SLA configuration in one query.
 *
 * One query rather than one per department because the board evaluates deadlines for every
 * open incident in the district at once, and a per-row lookup there is the classic way a
 * board that was fast in testing becomes slow on the night it matters.
 */
export async function loadSlaConfiguration(pool: Pool): Promise<SlaConfiguration> {
  const { rows } = await pool.query<{ severity: string; ack_minutes: number }>(
    'SELECT severity, ack_minutes FROM sla_target',
  );

  const district: Record<string, number> = {};
  for (const r of rows) district[r.severity] = r.ack_minutes;

  /**
   * ⚠️ **`byDepartment` IS ALWAYS EMPTY SINCE ADR-0030, and it is kept rather than removed.**
   *
   * Migration 0039 dropped `sla_target.department_id` — and deleted the per-department rows
   * first, because without that every one of them became a second row for a severity the
   * district already had, and the unique index could not be rebuilt.
   *
   * `targetsFor(config, departmentIds)` in `domain/sla.ts` reads this and already falls back to
   * the district's numbers when it finds nothing, which is what a department without its own
   * deadline has always meant. So every caller lands on the district's figures with no branch
   * changed — the empty object is not a stub, it is the answer.
   */
  return { district: district as unknown as SlaTargets, byDepartment: {} };
}

export type SetTargetResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Set one acknowledgement deadline.
 *
 * `departmentId === null` sets the district default. Bounds are enforced here as well as in
 * the CHECK constraint, so the caller gets a sentence rather than a Postgres error string.
 */
export async function setSlaTarget(
  pool: Pool,
  departmentId: Uuid | null,
  severity: Severity,
  ackMinutes: number,
  actor: ConfigActor,
): Promise<SetTargetResult> {
  if (!Number.isInteger(ackMinutes) || ackMinutes < 1 || ackMinutes > 10_080) {
    return { ok: false, why: 'a deadline must be a whole number of minutes between 1 and 10080' };
  }

  /**
   * ⚠️ **A NAMED DEPARTMENT IS REFUSED HERE TOO, AND THAT IS NOT BELT AND BRACES.**
   *
   * `api/admin.ts` already refuses one, and this is a different door: `setSlaTarget` is exported
   * and the store is what a job or a script would reach for. The failure it guards against is
   * the silent one — writing the DISTRICT'S deadline while the caller believes it set one
   * department's, so the number moves for everybody and the screen shows exactly what was asked
   * for. That is worth two refusals.
   */
  if (departmentId !== null) {
    return { ok: false, why: 'deadlines are the district’s now — ADR-0030' };
  }

  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<SlaRow & { target_id: string }>(
      `SELECT target_id, severity, ack_minutes FROM sla_target
        WHERE severity = $1 FOR UPDATE`,
      [severity],
    );

    const before = existing.rows[0] ?? null;

    // Two statements, each with only the parameters it uses.
    //
    // They were one call with a shared parameter array, and the UPDATE branch referenced
    // only `$3` and `$4` — leaving `$1` and `$2` bound but unmentioned, which Postgres
    // rejects with "could not determine data type of parameter $1". So **changing an
    // existing deadline failed every time while setting a new one worked**, and every test
    // written until then happened to create rather than change.
    const { rows } =
      before === null
        ? await tx.query<{ target_id: string }>(
            `INSERT INTO sla_target (severity, ack_minutes)
             VALUES ($1, $2) RETURNING target_id`,
            [severity, ackMinutes],
          )
        : await tx.query<{ target_id: string }>(
            `UPDATE sla_target SET ack_minutes = $1, updated_at = now()
              WHERE target_id = $2 RETURNING target_id`,
            [ackMinutes, before.target_id],
          );

    await recordChange(tx, {
      subject: 'sla_target',
      subjectId: rows[0]!.target_id,
      action: before === null ? 'created' : 'updated',
      before,
      after: { department_id: departmentId, severity, ack_minutes: ackMinutes },
      actor,
    });
    return { ok: true as const };
  });
}

/**
 * Take a department's own deadline away, so it inherits the district's again — 2026-08-19.
 *
 * 🔴 **The console has promised this since M1a and nothing has ever implemented it.** The
 * Deadlines screen says, in words, *"type over it to set one, and clear it to go back"*; the
 * browser's `change` handler returns early on an empty box, and `setTarget` refuses anything
 * that is not a number. **So an exception, once made, was permanent** — and the workaround an
 * administrator would reach for is worse than the gap: typing the district's own number into
 * the box looks identical and behaves differently, because the row stops following the district
 * the day the district changes its mind. A silent divergence, created by somebody trying to
 * undo something.
 *
 * ⚠️ **The district's own default cannot be cleared, and that is not symmetry for its own sake.**
 * A department's row falls back to the district; the district's row falls back to nothing, and a
 * severity with no deadline anywhere is an emergency with no clock — which `domain/sla.ts` has
 * no answer for. Refused with words rather than allowed to produce that state.
 *
 * **Clearing something that is not there is not an error and records nothing.** It is the
 * caller asking for a state that already holds; writing a `removed` row for a row that never
 * existed would put a decision nobody made into the config log, which is the one place in this
 * system that may never be embroidered.
 */
export function clearSlaTarget(
  _pool: Pool,
  departmentId: Uuid | null,
  _severity: Severity,
  _actor: ConfigActor,
  _reason: string,
): Promise<SetTargetResult> {
  /**
   * ⚠️ **THIS ALWAYS REFUSES SINCE ADR-0030, AND THE REASON IS THE ONE IT ALREADY HAD.**
   *
   * It only ever cleared a DEPARTMENT'S row, so that severity fell back to the district's. With
   * no departments there is no such row, and the district's own deadline still cannot be
   * cleared — because it falls back to nothing, and a severity with no deadline anywhere is an
   * emergency with no clock, which `domain/sla.ts` has no answer for.
   *
   * ⚠️ **THE CONSOLE STILL OFFERS IT.** The Deadlines screen has promised *"clear it to go
   * back"* since M1a, that promise went unimplemented for months, and 2026-08-19 finally built
   * it. Two days later it has nothing to go back TO. The control is now refused with words
   * rather than silently doing nothing — the failure that screen was fixed for — and taking it
   * off is a client change with a `CACHE` bump, deliberately not in this commit.
   */
  return Promise.resolve({
    ok: false,
    why:
      departmentId === null
        ? 'the district’s own deadline cannot be cleared — there is nothing underneath it'
        : 'deadlines are the district’s now, so there is nothing to clear back to (ADR-0030)',
  });
}

//------------------------------------------------------------------------------
// The history
//------------------------------------------------------------------------------

/**
 * Recent configuration changes, newest first, with the actor resolved to a name.
 *
 * Joined rather than stored denormalised: the seat is the record (ADR-0004), and the name
 * is a convenience for the screen. If the holder changes, the change stays attributed to
 * the seat that made it and the display simply follows whoever holds it now.
 */
export async function recentConfigChanges(
  pool: Pool,
  limit = 50,
): Promise<readonly ConfigChange[]> {
  const { rows } = await pool.query<{
    event_id: string;
    seq: string;
    subject: ConfigSubject;
    subject_id: string;
    action: ConfigAction;
    before: unknown;
    after: unknown;
    actor_seat_id: string | null;
    seat_title: string | null;
    full_name: string | null;
    reason: string | null;
    recorded_at: string;
  }>(
    `SELECT c.event_id, c.seq, c.subject, c.subject_id, c.action, c.before, c.after,
            c.actor_seat_id, s.title AS seat_title, p.full_name, c.reason, c.recorded_at
       FROM config_event c
       LEFT JOIN seat   s ON s.seat_id   = c.actor_seat_id
       LEFT JOIN person p ON p.person_id = c.actor_person_id
      ORDER BY c.seq DESC
      LIMIT $1`,
    [Math.min(Math.max(1, limit), 500)],
  );

  return rows.map((r) => ({
    eventId: r.event_id,
    seq: r.seq,
    subject: r.subject,
    subjectId: r.subject_id,
    action: r.action,
    before: r.before,
    after: r.after,
    actorSeatId: r.actor_seat_id,
    actorSeatTitle: r.seat_title,
    actorName: r.full_name,
    reason: r.reason,
    recordedAt: r.recorded_at,
  }));
}

//------------------------------------------------------------------------------
// The dashboard layout — ADR-0015, M6-28
//------------------------------------------------------------------------------

/**
 * What the district chose to have on its screen, or null if it has not chosen.
 *
 * **Null is a real answer and not an error.** "Nobody has arranged this yet" is different from
 * "the district chose the default arrangement", and the editor says so — one reads as a decision
 * and the other as a gap. `DEFAULT_LAYOUT` renders either way, so nothing is at stake but
 * honesty (M6-29).
 *
 * `departmentId === null` is the district's own arrangement — what the two administrative
 * offices see.
 */
export async function loadLayout(pool: Pool, _departmentId: Uuid | null): Promise<Layout | null> {
  /**
   * ⚠️ **ONE WALL, SO ONE LAYOUT — ADR-0030.** Migration 0039 dropped `department_id` from this
   * table and deleted any per-department row with it.
   *
   * `departmentId` is kept in the signature and ignored, so the callers that still pass
   * `viewer.departmentId` — which `sessions.ts` now always answers null — keep compiling. Both
   * halves of that say the same thing: there is one arrangement of the screen, and it is the
   * district's.
   *
   * ⚠️ **A row is still parsed rather than cast**, for its own reason, unchanged: nothing that
   * came out of a `jsonb` column is trusted to be the shape it was written in.
   */
  const { rows } = await pool.query<{ layout: unknown }>(
    'SELECT layout FROM dashboard_layout LIMIT 1',
  );

  if (rows[0] === undefined) return null;

  // Parsed rather than cast. Nothing that came out of a `jsonb` column is trusted to be the
  // shape it was written in — a migration, a restore or somebody's `psql` session could all
  // have put something else there, and a screen that throws is a district that cannot see its
  // own emergencies.
  return parseLayout(rows[0].layout);
}

/**
 * Set one scope's layout.
 *
 * Written with its `config_event` in **one transaction**, like every other setting here: a
 * screen that changed with no record of who changed it is exactly what that table exists to
 * prevent, and a separate connection makes that a possible outcome of a badly timed crash.
 *
 * The layout is **validated before it is stored**, not on the way out. An unknown panel id
 * stored today is a panel that quietly disappears from somebody's screen tomorrow with nothing
 * saying why — and the person who could fix it is the one saving this form right now.
 */
export async function saveLayout(
  pool: Pool,
  departmentId: Uuid | null,
  layout: Layout,
  actor: ConfigActor,
  reason?: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: string }> {
  const unknown = layout.panels.filter((p) => panelById(p.id) === undefined);
  if (unknown.length > 0) {
    return { ok: false, why: `no panel called ${unknown.map((p) => p.id).join(', ')}` };
  }
  if (layout.panels.length === 0) {
    // A layout with nothing on it is never what anybody meant, and it would render as the
    // default anyway — so saving it would be a decision the district cannot see it made.
    return { ok: false, why: 'a dashboard needs at least one panel' };
  }

  return inTransaction(pool, async (tx) => {
    // ADR-0030 — one row, so `FOR UPDATE` on it and nothing to key by. The transaction and the
    // lock stay: two operators saving the district's arrangement at once is exactly what this
    // was written for, and that is no less possible with one row than with several.
    const existing = await tx.query<{ layout: unknown }>(
      'SELECT layout FROM dashboard_layout LIMIT 1 FOR UPDATE',
    );

    const before = existing.rows[0]?.layout ?? null;

    if (before === null) {
      await tx.query('INSERT INTO dashboard_layout (layout) VALUES ($1::jsonb)', [
        JSON.stringify(layout),
      ]);
    } else {
      await tx.query('UPDATE dashboard_layout SET layout = $1::jsonb, updated_at = now()', [
        JSON.stringify(layout),
      ]);
    }

    await recordChange(tx, {
      subject: 'dashboard_layout',
      // The scope this layout belongs to. A district-wide layout has no department, and the
      // nil uuid names that rather than leaving the column empty — `subject_id` is how the
      // history screen groups changes, and a null there would group every district-wide edit
      // with every other subject that happens to have no id.
      subjectId: departmentId ?? '00000000-0000-0000-0000-000000000000',
      action: before === null ? 'created' : 'updated',
      before,
      after: layout,
      actor,
      ...(reason === undefined ? {} : { reason }),
    });

    return { ok: true as const };
  });
}

//------------------------------------------------------------------------------
// What this installation offers — ADR-0016, M6-42
//------------------------------------------------------------------------------

/**
 * Which screens this district shows, and whether anybody has ever decided.
 *
 * `chosen: false` is a real answer, not a missing one. "Nobody has looked at this" and
 * "somebody chose exactly these" render identically and mean entirely different things — only
 * the first is an invitation, and the console says which it is looking at.
 */
export async function loadCapabilities(
  pool: Pool,
): Promise<{ readonly state: CapabilityState; readonly chosen: boolean }> {
  const { rows } = await pool.query<{ state: unknown }>('SELECT state FROM capability_state');

  if (rows[0] === undefined) return { state: defaultCapabilities(), chosen: false };

  // Parsed rather than cast. A flag added in a later release takes its default and a flag
  // removed in one is dropped, without either needing a migration — and neither may throw, on
  // a value read on the way to every screen.
  return { state: parseCapabilities(rows[0].state), chosen: true };
}

/**
 * Turn one screen on or off.
 *
 * One flag per call rather than the whole set, because the `config_event` row is then a sentence
 * — *"the search screen was turned on"* — instead of a diff of six booleans somebody has to
 * read carefully to see which one moved.
 */
export async function setCapability(
  pool: Pool,
  capability: Capability,
  offered: boolean,
  actor: ConfigActor,
  reason?: string,
): Promise<{ readonly ok: true; readonly state: CapabilityState }> {
  return inTransaction(pool, async (tx) => {
    const existing = await tx.query<{ state: unknown }>(
      'SELECT state FROM capability_state FOR UPDATE',
    );

    const before =
      existing.rows[0] === undefined ? null : parseCapabilities(existing.rows[0].state);
    const after = { ...(before ?? defaultCapabilities()), [capability]: offered };

    if (existing.rows[0] === undefined) {
      await tx.query('INSERT INTO capability_state (state) VALUES ($1::jsonb)', [
        JSON.stringify(after),
      ]);
    } else {
      await tx.query('UPDATE capability_state SET state = $1::jsonb, updated_at = now()', [
        JSON.stringify(after),
      ]);
    }

    await recordChange(tx, {
      subject: 'capability',
      // The capability is the subject, so the history screen groups every change to one screen
      // together. Not a uuid: this is one of the few settings whose identity is a name, and a
      // synthetic id would make the log unreadable to answer nothing.
      subjectId: capability,
      action: existing.rows[0] === undefined ? 'created' : 'updated',
      before,
      after,
      actor,
      ...(reason === undefined ? {} : { reason }),
    });

    return { ok: true as const, state: after };
  });
}
