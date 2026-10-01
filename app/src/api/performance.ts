/**
 * The district whole — ~~every department's~~ **every officer's** work and responsiveness in one
 * table (ADR-0029, CD-05b).
 *
 * This is the thing the two administrative offices exist to see (ADR-0010), and it is the
 * one screen in the system whose entire purpose is comparison. That makes it the easiest
 * place to accidentally lie, so three rules apply to every number on it:
 *
 * 1. **A number is never an average of things that are not comparable.** Acknowledgement
 *    time is measured from `occurredAt`, so a two-hour connectivity outage shows up as two
 *    hours (ADR-0002). It is not quietly re-based on arrival to make the district look
 *    faster.
 * 2. **A median, not a mean.** One incident acknowledged nine hours later after a flood
 *    should not make a department's whole month look bad, and one instant acknowledgement
 *    should not rescue it. The mean is reported too, because the gap between them is itself
 *    the signal, but the median leads.
 * 3. **Nothing missing is rendered as zero.** A row with nothing acknowledged in the period has
 *    `null` response times, not `0`. Zero minutes is the best possible performance and no
 *    data is no performance at all; a table that confuses them ranks the idle above the
 *    excellent (ADR-0005).
 *
 * ⚠️ **AND SINCE ADR-0029, A ROW WITH NOTHING AT ALL IS ABSENT RATHER THAN EMPTY.** Every
 * department in the registry used to be pre-seeded a bucket, so one that had held nothing all
 * month still appeared as a line of dashes. That was right about departments — receiving nothing
 * could mean routing was broken, and ADR-0005 refuses to render an absence as normal. It is
 * wrong about officers: routing has not existed since ADR-0022, the control room chooses by
 * hand, *nobody was told* is already its own counter, and pre-seeding would rebuild the **79
 * near-singleton rows** the district asked to be rid of on the very screen they complained about.
 *
 * Folded from the event log like everything else. There is no metrics table to drift.
 */

import { loadRecentIncidents } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { IncidentEvent, Instant } from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { unmetObligations } from '../domain/notifications.js';
import { checkEscalation, responseMinutes, targetsFor, type SlaConfig } from '../domain/sla.js';
import { listDepartments, loadSlaConfiguration } from '../db/configStore.js';
import { requireAdministration, type AdminResult } from './admin.js';
// ADR-0029 — the board's own recipient lookup, exported rather than written a third time.
// `dashboard.ts` reaches for the same one, and for the same reason: two files each answering
// *what is this recipient called* is how one screen starts naming somebody the other cannot.
import { dispatchNames } from './board.js';
import type { DispatchTarget } from '../domain/events.js';

/**
 * One officer's row — ADR-0029, CD-05b. **This was `DepartmentPerformance`.**
 *
 * The district's answer to `contacts-without-departments.md` §10 question 3 was *per officer*,
 * and the fold key had to move rather than a second calculation appearing beside this one:
 * `performanceOver`'s own header says two ways of selecting is fine and two ways of calculating
 * is not, because a second median would eventually disagree with this table **in front of the
 * officer it is about**. So the dashboard panel, `/summary` and the Reports screen all moved
 * together, and none of them computes anything of its own.
 *
 * ⚠️ **`retired` is gone rather than carried over.** It answered *is this department still in
 * the registry* — a question about a row somebody has to maintain. A contact that held work in
 * the window belongs on the record of that window whether or not it has since been removed, and
 * a removed contact is already absent from every list that offers one.
 */
export interface OfficerPerformance {
  /**
   * `kind:id`, the way `dispatchedTo` keys itself — a person, a post, or a department from the
   * record's own past. Sent so a screen has something stable to key a row on, and deliberately
   * **not** something to look anything up by: `name` is what a reader acts on.
   */
  readonly key: string;
  readonly name: string;
  /** Incidents this officer was told about at any point in the window. */
  readonly total: number;
  readonly open: number;
  readonly unacknowledged: number;
  /** Open, unacknowledged, and past the deadline that applies to it. */
  readonly overdue: number;
  readonly escalated: number;
  readonly closed: number;
  /** Minutes from when it happened to when somebody took it. Null when nothing was. */
  readonly medianAckMinutes: number | null;
  readonly meanAckMinutes: number | null;
  readonly slowestAckMinutes: number | null;
  /** Share of acknowledged incidents that made their deadline, 0–1. Null when none were. */
  readonly withinTarget: number | null;
  /** Somebody was supposed to be told and was not (INV-03). */
  readonly notificationsUnmet: number;
}

export interface DistrictPerformance {
  readonly asOf: Instant;
  readonly windowDays: number;
  /**
   * ⚠️ **This was `departments` — ADR-0029, CD-05b.** Renamed rather than kept and repurposed,
   * because a field called `departments` holding officers is the kind of half-migration this
   * project has paid for repeatedly: everything reading it goes on compiling and starts
   * describing the wrong thing.
   */
  readonly officers: readonly OfficerPerformance[];
  readonly district: {
    readonly total: number;
    readonly open: number;
    readonly overdue: number;
    /**
     * Emergencies the routing signals could not place.
     *
     * Deliberately at district level and not attributed to any department, because no
     * department has them. They belong to the two offices, and their existence is a
     * configuration gap rather than anyone's poor performance.
     */
    readonly unassigned: number;
    readonly medianAckMinutes: number | null;
    readonly notificationsUnmet: number;
  };
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function round(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10) / 10;
}

interface Bucket {
  total: number;
  open: number;
  unacknowledged: number;
  overdue: number;
  escalated: number;
  closed: number;
  ackMinutes: number[];
  withinTarget: number;
  ackedForTarget: number;
  notificationsUnmet: number;
}

function emptyBucket(): Bucket {
  return {
    total: 0,
    open: 0,
    unacknowledged: 0,
    overdue: 0,
    escalated: 0,
    closed: 0,
    ackMinutes: [],
    withinTarget: 0,
    ackedForTarget: 0,
    notificationsUnmet: 0,
  };
}

const CLOSED: ReadonlySet<IncidentState['status']> = new Set(['closed', 'resolved']);

export interface PerformanceOptions {
  readonly now?: Instant;
  readonly days?: number;
  readonly limit?: number;
}

/**
 * Fold the district's recent incidents into a per-OFFICER picture (ADR-0029).
 *
 * An incident somebody told to two officers counts for **both**. Not a bug and not double
 * counting in any sense that matters: both were told, both were expected to act, and
 * splitting the credit would mean neither shows a full incident on a screen designed to ask
 * "did you answer?".
 */
/**
 * The district's view, for the two offices.
 *
 * The authority check lives here and the calculation lives in `computePerformance` below.
 * ⚠️ The split was made so the dashboard could show a department **its own** row without handing
 * it everybody else's; ADR-0024 left no department holding an account and ADR-0029 removed the
 * layer, so what the split now buys is the one thing it always bought best — **one median,
 * computed once**, rather than a second one elsewhere that would eventually disagree with this
 * table in front of the officer it is about.
 */
export async function districtPerformance(
  pool: Pool,
  identity: Identity,
  options: PerformanceOptions = {},
): Promise<AdminResult<DistrictPerformance>> {
  const denied = requireAdministration<DistrictPerformance>(identity);
  if (denied !== null) return denied;

  return { ok: true, value: await computePerformance(pool, options) };
}

/** The calculation, with no authority check. Callers scope what they show. */
export async function computePerformance(
  pool: Pool,
  options: PerformanceOptions = {},
): Promise<DistrictPerformance> {
  const grouped = await loadRecentIncidents(pool, options.days ?? 30, options.limit ?? 5000);
  return performanceOver(pool, grouped, options);
}

/**
 * The calculation itself, over incidents somebody else selected.
 *
 * Split out when the arbitrary-period summary arrived, for the third time in this codebase and
 * the same reason each time (`projectIncidents`, `incidentRow`): **two ways of selecting is
 * fine, two ways of calculating is not.** A second median computed elsewhere would eventually
 * disagree with this table in front of the officer it is about.
 *
 * The caller decides which incidents and, if it needs to, which the asking seat may see.
 */
export async function performanceOver(
  pool: Pool,
  grouped: readonly (readonly IncidentEvent[])[],
  options: PerformanceOptions = {},
): Promise<DistrictPerformance> {
  const now = options.now ?? new Date().toISOString();
  const windowDays = options.days ?? 30;

  const [departments, config] = await Promise.all([
    listDepartments(pool),
    loadSlaConfiguration(pool) as Promise<SlaConfig>,
  ]);

  /**
   * Keyed `kind:id`, and **nothing is pre-seeded** — ADR-0029, CD-05b.
   *
   * This used to open a bucket for **every department in the registry**, so one that had held
   * nothing all month still got a row of dashes. That was right about departments: a department
   * receiving nothing could mean routing was broken, and ADR-0005 refuses to render an absence
   * as normal.
   *
   * It is wrong about officers. An officer nobody told anything is not a gap — the control room
   * chose not to tell them, routing has not existed since ADR-0022, and *nobody was told* is
   * already its own counter. Pre-seeding here would rebuild the **79 near-singleton rows** the
   * district asked to be rid of, in the one place they complained about it.
   */
  const buckets = new Map<string, Bucket>();
  const heldTargets: DispatchTarget[] = [];

  let districtTotal = 0;
  let districtOpen = 0;
  let districtOverdue = 0;
  let districtUnassigned = 0;
  let districtUnmet = 0;
  const districtAck: number[] = [];

  for (const events of grouped) {
    const first = events[0];
    if (first === undefined) continue;
    const state = foldIncident(first.incidentId, events);

    const live = !CLOSED.has(state.status);
    const targets = targetsFor(config, state.responsibleDepartmentIds);
    const severity = state.severity?.value ?? 'unknown';

    const overdue =
      live &&
      state.acknowledgedAt === null &&
      state.occurredAt !== null &&
      state.lastRecordedAt !== null &&
      checkEscalation(
        {
          severity,
          occurredAt: state.occurredAt,
          recordedAt: state.lastRecordedAt,
          acknowledgedAt: null,
          now,
        },
        targets,
      ).shouldEscalate;

    const ack =
      state.acknowledgedAt !== null && state.occurredAt !== null
        ? responseMinutes(state.occurredAt, state.acknowledgedAt)
        : null;

    const unmet = unmetObligations(state.notifications, now).length;

    districtTotal += 1;
    if (live) districtOpen += 1;
    if (overdue) districtOverdue += 1;
    if (state.unassigned && live) districtUnassigned += 1;
    if (unmet > 0) districtUnmet += 1;
    if (ack !== null) districtAck.push(ack);

    /**
     * **Everybody who was told about this emergency** — ADR-0029.
     *
     * It was every department that had held it, `reassignedFrom` included, so a department that
     * dropped an emergency could not disappear from the record of it. **That property survives
     * by construction rather than by being restated:** `dispatchedTo` is a Map the fold only
     * ever adds to, so it already carries everyone ever told, including anybody the control room
     * moved on from.
     *
     * ⚠️ **This measures who was TOLD, not who HELD it**, and that is the same shift CD-05a made
     * on the panel beside it — for the same reason. `responsibleDepartmentIds` is the question
     * that stopped having an answer, and a table folded on it would quietly report a district
     * where nobody is ever slow because nobody is ever anything.
     */
    /**
     * ⚠️ **`dispatchedTo` alone — ADR-0031, phase 2, matching the panel beside it (CD-05a).**
     *
     * This table used to synthesize a `department:<id>` row from `responsibleDepartmentIds`
     * and `reassignedFrom` so that Bajaur's department-shaped past stayed readable. That past
     * is gone — ADR-0030 rebuilt the record with zero historical data — and `'department'`
     * has left `RecipientKind`, so there is no target to synthesize. New work keys on the
     * people who were actually told; any department-keyed row on some other installation
     * drains by itself.
     */
    const held: DispatchTarget[] = [...state.dispatchedTo];

    for (const target of held) {
      const key = `${target.kind}:${target.id}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        heldTargets.push(target);
        bucket = emptyBucket();
        buckets.set(key, bucket);
      }

      bucket.total += 1;
      if (live) bucket.open += 1;
      else bucket.closed += 1;
      if (live && state.acknowledgedAt === null) bucket.unacknowledged += 1;
      if (overdue) bucket.overdue += 1;
      if (state.escalationCount > 0) bucket.escalated += 1;
      if (unmet > 0) bucket.notificationsUnmet += 1;

      if (ack !== null) {
        bucket.ackMinutes.push(ack);
        bucket.ackedForTarget += 1;
        if (ack <= targets[severity]) bucket.withinTarget += 1;
      }
    }
  }

  /**
   * The names, in one batch — `board.ts`'s own lookup, exported rather than written a third time.
   *
   * ⚠️ **A row nobody can name is DROPPED, not printed as an id.** The old code counted an
   * unregistered department *under its id* on purpose, because a department that vanished from
   * the registry was a real configuration problem and a missing row would have concealed it.
   * That reasoning does not carry: there is no registry to vanish from any more, so an
   * unnameable key is a person or post removed from the record's own past — and thirty-six
   * characters of hexadecimal in the `name` column of a table an officer reads is the identity
   * line ADR-0027 exists to have taken off a screen, not a problem being surfaced.
   */
  const officerNames = await dispatchNames(
    pool,
    heldTargets,
    Object.fromEntries(departments.map((d) => [d.departmentId, { name: d.name }])),
  );

  const rows: OfficerPerformance[] = [...buckets.entries()].flatMap(([key, b]) => {
    const name = officerNames.get(key);
    if (name === undefined) return [];
    return [
      {
        key,
        name,
        total: b.total,
        open: b.open,
        unacknowledged: b.unacknowledged,
        overdue: b.overdue,
        escalated: b.escalated,
        closed: b.closed,
        medianAckMinutes: round(median(b.ackMinutes)),
        meanAckMinutes: round(mean(b.ackMinutes)),
        slowestAckMinutes: b.ackMinutes.length === 0 ? null : round(Math.max(...b.ackMinutes)),
        withinTarget: b.ackedForTarget === 0 ? null : b.withinTarget / b.ackedForTarget,
        notificationsUnmet: b.notificationsUnmet,
      },
    ];
  });

  // Ordered by what needs attention, not alphabetically. A table sorted by name makes the
  // reader do the ranking, and the reader is the person this screen is supposed to help.
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    if (a.unacknowledged !== b.unacknowledged) return b.unacknowledged - a.unacknowledged;
    if (a.notificationsUnmet !== b.notificationsUnmet) {
      return b.notificationsUnmet - a.notificationsUnmet;
    }
    if (a.open !== b.open) return b.open - a.open;
    return a.name.localeCompare(b.name);
  });

  return {
    asOf: now,
    windowDays,
    officers: rows,
    district: {
      total: districtTotal,
      open: districtOpen,
      overdue: districtOverdue,
      unassigned: districtUnassigned,
      medianAckMinutes: round(median(districtAck)),
      notificationsUnmet: districtUnmet,
    },
  };
}
