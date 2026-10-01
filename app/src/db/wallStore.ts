/**
 * What the dashboard shows about the district itself — M4.
 *
 * Three things live here because they arrived together for the dashboard: utility reports,
 * presence reports, and the cached weather reading.
 *
 * The shape that repeats: **the latest report, with its own timestamp.** Never a status
 * column. A column answers "what is it now" and destroys "since when, and who says so" —
 * which, on a panel somebody glances at from across a room, is the entire question.
 */

import type { Pool } from 'pg';
import type { PresenceStatus, UtilityStatus } from '../domain/wall.js';

export interface Utility {
  readonly utilityId: string;
  readonly name: string;
  /** Which panel it appears in: the utilities, or the district's services. */
  readonly panel: 'utility' | 'services';
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly staleMinutes: number;
  readonly position: number;
  readonly status: UtilityStatus | null;
  readonly note: string | null;
  readonly reportedAt: string | null;
  readonly reportedBy: string | null;
}

interface UtilityRow {
  utility_id: string;
  name: string;
  panel: 'utility' | 'services';
  department_id: string | null;
  department_name: string | null;
  stale_minutes: number;
  position: number;
  status: UtilityStatus | null;
  note: string | null;
  reported_at: string | null;
  reported_by: string | null;
}

/**
 * Every utility the district watches, each with its most recent report.
 *
 * A LATERAL join rather than a window function or a `MAX(reported_at)` self-join: with an
 * index on `(utility_id, reported_at DESC)` it reads exactly one row per utility however many
 * years of reports are behind it. The alternative sorts the whole history to discard all but
 * the last of each — which is fine at ten reports and not at ten thousand.
 *
 * Retired utilities are excluded. A service the district stopped watching is not a service
 * that has gone quiet, and a wall screen must not confuse the two.
 */
export async function listUtilities(pool: Pool): Promise<Utility[]> {
  const result = await pool.query<UtilityRow>(
    // ADR-0030 — a utility answers to the district. The Status screen stopped OFFERING the
    // assign control on 2026-08-23 on the owner's own reasoning ("humnai departments hata deye
    // hain tou kis ko asign hoga"); migration 0039 dropped the column it wrote to, two days
    // later. `departmentId`/`departmentName` stay on the row as null so no screen reading them
    // has to change in the same commit that removes what they described.
    `SELECT u.utility_id, u.name, u.panel,
            NULL::uuid AS department_id, NULL::text AS department_name,
            u.stale_minutes, u.position,
            r.status, r.note, r.reported_at, s.title AS reported_by
       FROM utility u
       LEFT JOIN LATERAL (
            SELECT status, note, reported_at, reported_by
              FROM utility_report
             WHERE utility_id = u.utility_id
             ORDER BY reported_at DESC
             LIMIT 1
       ) r ON true
       LEFT JOIN seat s ON s.seat_id = r.reported_by
      WHERE u.retired_at IS NULL
      ORDER BY u.position, u.name`,
  );

  return result.rows.map((row) => ({
    utilityId: row.utility_id,
    name: row.name,
    panel: row.panel,
    departmentId: row.department_id,
    departmentName: row.department_name,
    staleMinutes: row.stale_minutes,
    position: row.position,
    status: row.status,
    note: row.note,
    reportedAt: row.reported_at,
    reportedBy: row.reported_by,
  }));
}

export async function addUtility(
  pool: Pool,
  input: {
    name: string;
    departmentId: string | null;
    panel?: 'utility' | 'services';
    staleMinutes?: number;
    position?: number;
  },
): Promise<string> {
  const result = await pool.query<{ utility_id: string }>(
    // ADR-0030 — `input.departmentId` is accepted and not written. The caller's shape is
    // unchanged so nothing upstream has to move in this commit; there is nowhere to put it.
    `INSERT INTO utility (name, panel, stale_minutes, position)
     VALUES ($1, COALESCE($2, 'utility'), COALESCE($3, 240), COALESCE($4, 0))
     RETURNING utility_id`,
    [input.name, input.panel ?? null, input.staleMinutes ?? null, input.position ?? null],
  );

  return result.rows[0]!.utility_id;
}

/**
 * Say which department answers for a service.
 *
 * Null is allowed and means "nobody yet" — a service the district watches but has not
 * assigned. That is a visible, fixable gap and it is better than either inventing an owner or
 * refusing to list the service.
 */
export function assignUtility(
  _pool: Pool,
  _input: { utilityId: string; departmentId: string | null },
): Promise<boolean> {
  /**
   * ⚠️ **ALWAYS FALSE SINCE ADR-0030, AND IT WRITES NOTHING.** Migration 0039 dropped the column.
   *
   * False is what this already returned for a utility that is not there, and `api/status.ts`
   * turns it into a 404. The route is still served and still authorised — what changed is that
   * there is no department to answer for a service, which is the state the Status screen has
   * been in since 2026-08-23 when its control came off.
   */
  return Promise.resolve(false);
}

/**
 * How long a report on this service stays believable — M10-03.
 *
 * **The column has existed since migration 0015 and nothing has ever been able to change it.**
 * `addUtility` takes it once, at creation, and every seeded row has carried its install default
 * ever since: Electricity 240, Water 480, Gas 720. So the district could watch a reading go
 * stale and had no way to say the window was wrong for them — which is half of what M10-01 was
 * really about. An eight-hour load-shedding schedule reported against a four-hour window is
 * *stale by construction*, every single day, however diligently somebody reports it.
 *
 * **The bounds are not re-stated here.** `api/status.ts` holds them, in the words it already
 * used at creation, so the two doors cannot disagree about what "believable" means — the same
 * rule `NEEDS_END` follows for availability. This function takes what it is given; the check is
 * the caller's, and the database's own `CHECK (stale_minutes BETWEEN 5 AND 10080)` is the floor
 * under both.
 *
 * Retired services are excluded exactly as `assignUtility` excludes them: a row nobody watches
 * is not a row anybody may configure.
 */
export async function setUtilityWindow(
  pool: Pool,
  input: { utilityId: string; staleMinutes: number },
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE utility SET stale_minutes = $2 WHERE utility_id = $1 AND retired_at IS NULL',
    [input.utilityId, input.staleMinutes],
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Rename a service the district watches — the Status screen's **Rename** control.
 *
 * **Why this is a rename and not a retire-and-re-add.** A utility carries its reports: every
 * `utility_report` row hangs off `utility_id`, and the district's history of *"Electricity —
 * down — 12 hours"* is the thing the panel exists for. Retiring "Electricity" and adding
 * "PESCO Bajaur" would leave that history attached to a row no screen lists again, which reads
 * on every later screen as *the district stopped watching the power and started watching
 * something new* — a different fact, and a false one. The name is a **label on a watched
 * thing**, so it changes in place and the readings stay where they are.
 *
 * Retired services are excluded for the same reason `setUtilityWindow` excludes them: a row
 * nobody watches is not a row anybody may configure.
 */
export async function renameUtility(
  pool: Pool,
  input: { utilityId: string; name: string },
): Promise<{ before: string } | null> {
  const result = await pool.query<{ name: string }>(
    // The name it had, returned so the config log can record what was replaced. `RETURNING`
    // on an `UPDATE` hands back the row as it is **after** the write, so the old value has to
    // be read out of the CTE that did the reading — the alternative is a SELECT and an UPDATE
    // with a gap between them, which is where two offices renaming one service at once would
    // land a log entry saying the name changed from something it never was.
    `WITH before AS (
         SELECT utility_id, name FROM utility
          WHERE utility_id = $1 AND retired_at IS NULL
          FOR UPDATE
     ), renamed AS (
         UPDATE utility SET name = $2
          WHERE utility_id = (SELECT utility_id FROM before)
     )
     SELECT name FROM before`,
    [input.utilityId, input.name],
  );

  const row = result.rows[0];
  return row === undefined ? null : { before: row.name };
}

export async function retireUtility(pool: Pool, utilityId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE utility SET retired_at = now() WHERE utility_id = $1 AND retired_at IS NULL',
    [utilityId],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function reportUtility(
  pool: Pool,
  input: {
    utilityId: string;
    status: UtilityStatus;
    note: string | null;
    reportedBy: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO utility_report (utility_id, status, note, reported_by)
     VALUES ($1, $2, $3, $4)`,
    [input.utilityId, input.status, input.note, input.reportedBy],
  );
}

/**
 * Does this utility exist?
 *
 * 🔴 **WAS `utilityOwner`, AND IT ANSWERED 500 ON EVERY UTILITY REPORT — ADR-0030.**
 *
 * It selected `department_id` from `utility`, a column migration 0039 dropped along with the
 * table it pointed at, so `POST /status/utility` — power, water or gas reported down — answered
 * **500**. The fifth instance of one fault, and the same repair as the other four: the caller
 * used the answer for exactly one thing, `null` meaning *no such utility*, and the department
 * beside it went unread the day `mayReportFor` stopped consulting one.
 */
export async function utilityExists(pool: Pool, utilityId: string): Promise<boolean> {
  const result = await pool.query<{ one: number }>(
    'SELECT 1 AS one FROM utility WHERE utility_id = $1 AND retired_at IS NULL',
    [utilityId],
  );
  return result.rows.length > 0;
}

export interface Presence {
  readonly seatId: string;
  readonly seatTitle: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  /** True for a seat in the DC Office or AC Headquarter — the posts a wall screen lists. */
  readonly isAdministration: boolean;
  readonly status: PresenceStatus | null;
  readonly note: string | null;
  readonly reportedAt: string | null;
  readonly untilAt: string | null;
  /**
   * Whoever holds this post right now — ADR-0033.
   *
   * From today's roster, so a handover retitles it (the incident-detail screen's documented
   * limitation, M0-35). Null when the post is vacant. The Dashboard names this on the wall for
   * a curated seat; the Status screen shows it so the control room knows whose availability it
   * is setting.
   */
  readonly officer: string | null;
  /** The control room has chosen to show this seat on the Dashboard wall (ADR-0033). */
  readonly onWall: boolean;
}

interface PresenceRow {
  seat_id: string;
  seat_title: string;
  department_id: string | null;
  department_name: string | null;
  is_administration: boolean | null;
  status: PresenceStatus | null;
  note: string | null;
  reported_at: string | null;
  until_at: string | null;
  officer: string | null;
  on_wall: boolean | null;
}

/**
 * Presence for the seats the district watches.
 *
 * `departmentId` filters to one department's own seats — the path a department uses to set
 * its own people's presence. Passing null lists every live seat, which is what the two
 * offices and the wall screen see.
 *
 * A seat with no report at all is still returned. That is the point: "AAC Barang — not
 * reported" is a fact the district should be looking at, and omitting the row would turn a
 * visible gap into an invisible one (ADR-0005).
 */
export async function listPresence(pool: Pool, _departmentId?: string | null): Promise<Presence[]> {
  const result = await pool.query<PresenceRow>(
    // ADR-0030 — presence is the district's whole roster. The scoping parameter is kept in the
    // signature and ignored: `sessions.ts` now always answers a null department, so every caller
    // was already asking for the unscoped list and this makes that true rather than incidental.
    `SELECT st.seat_id, st.title AS seat_title,
            NULL::uuid AS department_id, NULL::text AS department_name,
            st.is_administration, st.on_wall,
            p.status, p.note, p.reported_at, p.until_at,
            who.full_name AS officer
       FROM seat st
       LEFT JOIN LATERAL (
            SELECT status, note, reported_at, until_at
              FROM presence_report
             WHERE seat_id = st.seat_id
             ORDER BY reported_at DESC
             LIMIT 1
       ) p ON true
       LEFT JOIN LATERAL (
            -- ADR-0033: name the officer who holds the post now. One row, longest-held first
            -- (dutySeatOfPerson's ordering rule), so a person in two posts reads consistently.
            SELECT pr.full_name
              FROM duty_assignment a
              JOIN person pr ON pr.person_id = a.person_id AND pr.removed_at IS NULL
             WHERE a.seat_id = st.seat_id
               AND a.from_at <= now()
               AND (a.to_at IS NULL OR a.to_at > now())
             ORDER BY a.from_at ASC
             LIMIT 1
       ) who ON true
      WHERE st.retired_at IS NULL
      -- Was ORDER BY the department's name, then the title. With no departments the title is
      -- the whole of what a reader scans, and the administration first is what every other
      -- ordered list in this product does.
      ORDER BY st.is_administration DESC, st.title`,
    [],
  );

  return result.rows.map((row) => ({
    seatId: row.seat_id,
    seatTitle: row.seat_title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    isAdministration: row.is_administration ?? false,
    status: row.status,
    note: row.note,
    reportedAt: row.reported_at,
    untilAt: row.until_at,
    officer: row.officer,
    onWall: row.on_wall ?? false,
  }));
}

/**
 * Put a seat on the Dashboard wall, or take it off — ADR-0033.
 *
 * A display preference, not a `config_event`: the control room adjusts it as shifts change,
 * and a future reader does not need its history the way they need a routing change's.
 */
export async function setSeatOnWall(pool: Pool, seatId: string, onWall: boolean): Promise<void> {
  await pool.query('UPDATE seat SET on_wall = $2 WHERE seat_id = $1', [seatId, onWall]);
}

export async function reportPresence(
  pool: Pool,
  input: {
    seatId: string;
    status: PresenceStatus;
    note: string | null;
    reportedBy: string | null;
    /**
     * **Whose availability this is** — M9-32. Distinct from `reportedBy`, which is whoever
     * typed it, and from `seatId`, which is the post.
     *
     * Three different people, deliberately. A department clerk recording that the AAC is on
     * leave is not the AAC, and a district that flattened them could not answer *"who said he
     * was on leave?"* — the first question asked when he says he was not.
     *
     * Null is a real answer: a post with nobody in it can still be reported on, and *"nobody
     * holds this and nobody is coming"* is the state ADR-0004's escalation ladder exists to
     * surface.
     */
    personId?: string | null;
  },
): Promise<void> {
  await pool.query(
    // `until_at` stays NULL — ADR-0033 took the timer away. The column is inert on the table.
    `INSERT INTO presence_report (seat_id, status, note, until_at, reported_by, person_id)
     VALUES ($1, $2, $3, NULL, $4, $5)`,
    [input.seatId, input.status, input.note, input.reportedBy, input.personId ?? null],
  );
}

/** Who is in a post right now, so a report about the post can say who it is about. */
export async function holderOfSeat(pool: Pool, seatId: string): Promise<string | null> {
  const result = await pool.query<{ person_id: string }>(
    `SELECT a.person_id
       FROM duty_assignment a
       JOIN person p ON p.person_id = a.person_id AND p.removed_at IS NULL
      WHERE a.seat_id = $1
        AND a.from_at <= now()
        AND (a.to_at IS NULL OR a.to_at > now())
      ORDER BY a.from_at DESC
      LIMIT 1`,
    [seatId],
  );
  return result.rows[0]?.person_id ?? null;
}

/**
 * Does this post exist?
 *
 * 🔴 **WAS `seatDepartment`, AND IT ANSWERED 500 ON EVERY PRESENCE REPORT — ADR-0030.**
 *
 * It selected `department_id` from `seat`, a column migration 0039 dropped, so
 * `POST /status/presence` — an officer telling the district where they are — answered **500**
 * on the machine that is also taking emergency reports. The fourth of exactly this fault:
 * `departmentOfSeat` in `api/roster.ts`, `departmentOfResource` in `resourceStore.ts`, and the
 * `ORDER BY d.name` in `api/contacts.ts` are the other three.
 *
 * ⚠️ **The department it fetched was already dead before this broke.** `mayReportFor` stopped
 * reading it on 2026-08-22 — *"mujhe yeh concept hi nahi chahiye ke department khud kuch kar
 * sake app ke andar"* — and says so with a `void`. The only thing the caller still used the
 * answer for was `false` meaning *no such seat*. So the query fetching a value nobody wanted was
 * the only part still able to fail, and the question the caller means is the one asked here.
 */
export async function seatExists(pool: Pool, seatId: string): Promise<boolean> {
  const result = await pool.query<{ one: number }>(
    'SELECT 1 AS one FROM seat WHERE seat_id = $1 AND retired_at IS NULL',
    [seatId],
  );
  return result.rows.length > 0;
}

export interface WeatherReading {
  readonly observedAt: string;
  readonly fetchedAt: string;
  readonly payload: Record<string, unknown>;
}

export async function storeWeather(
  pool: Pool,
  input: { observedAt: string; payload: Record<string, unknown> },
): Promise<void> {
  await pool.query('INSERT INTO weather_reading (observed_at, payload) VALUES ($1, $2)', [
    input.observedAt,
    JSON.stringify(input.payload),
  ]);
}

export async function latestWeather(pool: Pool): Promise<WeatherReading | null> {
  const result = await pool.query<{
    observed_at: string;
    fetched_at: string;
    payload: Record<string, unknown>;
  }>(
    'SELECT observed_at, fetched_at, payload FROM weather_reading ORDER BY fetched_at DESC LIMIT 1',
  );

  const row = result.rows[0];

  if (row === undefined) return null;

  return { observedAt: row.observed_at, fetchedAt: row.fetched_at, payload: row.payload };
}

/**
 * Keep the last few readings and drop the rest.
 *
 * The table is written every fifteen minutes forever. Nobody will ever read the third-newest
 * row, and an unbounded table of weather observations would end up in every nightly dump the
 * district ships off-site — paid for, encrypted, and pointless.
 */
export async function pruneWeather(pool: Pool, keep = 50): Promise<number> {
  const result = await pool.query(
    `DELETE FROM weather_reading
      WHERE reading_id NOT IN (
            SELECT reading_id FROM weather_reading ORDER BY fetched_at DESC LIMIT $1
      )`,
    [keep],
  );

  return result.rowCount ?? 0;
}

//--------------------------------------------------------------------------------
// The facts about Bajaur that do not change on a Tuesday
//--------------------------------------------------------------------------------

export interface DistrictFact {
  readonly key: string;
  readonly label: string;
  readonly value: string | null;
}

/**
 * Tehsils, union councils, population, area.
 *
 * Returned with `value` null when nobody has supplied one, rather than omitted. The gap is
 * the point: a district status board missing its population is a board with a job for
 * somebody, and dropping the row would turn that into a board that looks complete.
 */
export async function listFacts(pool: Pool): Promise<DistrictFact[]> {
  const result = await pool.query<{ key: string; label: string; value: string | null }>(
    'SELECT key, label, value FROM district_fact ORDER BY position, label',
  );

  return result.rows.map((row) => ({ key: row.key, label: row.label, value: row.value }));
}

export async function setFact(
  pool: Pool,
  input: { key: string; value: string | null; seatId: string | null },
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE district_fact SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1',
    [input.key, input.value, input.seatId],
  );

  return (result.rowCount ?? 0) > 0;
}

//--------------------------------------------------------------------------------
// Alerts and advisories
//--------------------------------------------------------------------------------

export type AlertTag = 'vip' | 'security' | 'road' | 'weather' | 'other';

export interface DistrictAlert {
  readonly alertId: string;
  readonly tag: AlertTag;
  readonly message: string;
  readonly issuedAt: string;
  readonly issuedBy: string | null;
  readonly untilAt: string;
}

/**
 * What the district is currently advising.
 *
 * Live only: withdrawn advisories and expired ones are excluded, because an advisory board
 * that keeps yesterday's road closure on it is a board people stop reading. The rows are
 * still in the table — "we told the district the road was shut" is a thing somebody may have
 * to answer for (ADR-0001).
 */
export async function liveAlerts(pool: Pool, limit = 8): Promise<DistrictAlert[]> {
  const result = await pool.query<{
    alert_id: string;
    tag: AlertTag;
    message: string;
    issued_at: string;
    issued_by: string | null;
    until_at: string;
  }>(
    `SELECT a.alert_id, a.tag, a.message, a.issued_at, s.title AS issued_by, a.until_at
       FROM district_alert a
       LEFT JOIN seat s ON s.seat_id = a.issued_by
      WHERE a.withdrawn_at IS NULL AND a.until_at > now()
      ORDER BY a.issued_at DESC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    alertId: row.alert_id,
    tag: row.tag,
    message: row.message,
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    untilAt: row.until_at,
  }));
}

export async function issueAlert(
  pool: Pool,
  input: { tag: AlertTag; message: string; untilAt: string; issuedBy: string | null },
): Promise<string> {
  const result = await pool.query<{ alert_id: string }>(
    `INSERT INTO district_alert (tag, message, until_at, issued_by)
     VALUES ($1, $2, $3, $4)
     RETURNING alert_id`,
    [input.tag, input.message, input.untilAt, input.issuedBy],
  );

  return result.rows[0]!.alert_id;
}

export async function withdrawAlert(
  pool: Pool,
  input: { alertId: string; reason: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE district_alert
        SET withdrawn_at = now(), withdrawn_reason = $2
      WHERE alert_id = $1 AND withdrawn_at IS NULL`,
    [input.alertId, input.reason],
  );

  return (result.rowCount ?? 0) > 0;
}
