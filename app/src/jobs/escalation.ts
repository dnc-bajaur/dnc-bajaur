/**
 * The escalation job. INV-07 made true of a running system rather than only of a function.
 *
 * `domain/sla.ts` has known *when* to escalate since the first day. Nothing invoked it, so
 * the invariant held in theory and not in fact — a closed laptop still stopped an
 * escalation, because no server-side thing was watching. This is that thing.
 *
 * One rule shapes the design: **the escalation rule is never duplicated in SQL.** The
 * query narrows candidates; `checkEscalation` decides. Business rules expressed twice
 * drift, and a district would eventually be escalating by one rule and reporting by
 * another.
 */

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { foldIncident } from '../domain/incident.js';
import { ownershipOf } from '../domain/ownership.js';
import {
  checkEscalation,
  targetsFor,
  type SlaConfig,
  type SlaTargets,
  PLACEHOLDER_SLA,
} from '../domain/sla.js';
import { loadSlaConfiguration } from '../db/configStore.js';
import { TIER_ORDER, tierRank, type Tier } from '../domain/authority.js';
import { CARRIES_SLA, type IncidentEvent } from '../domain/events.js';
import { randomUUID } from 'node:crypto';
import { districtDate, endOfDistrictDay, startOfDistrictDay } from '../domain/districtTime.js';
import { log } from '../obs/log.js';

/**
 * **How far back the query reads — not how far back escalation applies.**
 *
 * ADR-0020 bounds escalation to **one district day**. That bound is the `HAVING` clause in
 * `candidates`, expressed against the district's own midnight; this constant only keeps the scan
 * off the whole table. Two days rather than one because Bajaur is UTC+05:00 and `now() - 1 day` is
 * not the same instant as the start of the district's day — a window of exactly one would clip
 * five hours off every evening, which is the shape of the defect O-01 already cost a day to.
 */
const SCAN_DAYS = 2;

export interface EscalationOutcome {
  readonly scanned: number;
  readonly escalated: number;
  /** Past SLA, but there is no higher seat to reach. Needs a human, urgently. */
  readonly exhausted: readonly string[];
  /** Past SLA, but the tier above has nobody on duty. Also needs a human. */
  readonly noHolder: readonly string[];
  /**
   * Emergencies whose chase ended with the district's day, still unacknowledged — ADR-0020.
   *
   * Counted rather than listed, because this number is a **health signal about the district**,
   * not a work queue: the day's work should have been closed within the day, and a figure that
   * climbs is the measurement of the assumption the whole daily reset rests on.
   */
  readonly ended: number;
  /**
   * The scan hit its cap, so open incidents were left unexamined this pass.
   *
   * Surfaced rather than swallowed: a district with more open incidents than the cap is
   * either in a genuine crisis or has a backlog nobody is closing, and both are things
   * the control room needs told rather than quietly absorbed by a `LIMIT`.
   */
  readonly truncated: boolean;
}

interface SeatRow {
  seat_id: string;
  tier: Tier;
  is_administration: boolean;
  has_holder: boolean;
}

/**
 * The next seat up the ladder from a given tier.
 *
 * ⚠️ **THE LADDER HAS ONE RUNG NOW — ADR-0030, and this is the largest behavioural change in
 * the sweep.** It used to prefer a seat in the same department, then a department-agnostic
 * seat, then an administrative office; migration 0039 dropped the column all three of those
 * preferences read, so what is left is the distinction that was always doing the work:
 * **a post, and the administration above it.**
 *
 * `departmentId` is kept in the signature and is ignored. Two callers pass it — `api/escalate.ts`
 * and the pass below — and removing the parameter would put that edit inside this change rather
 * than beside it. It is `_departmentId` so nothing can read it by accident.
 *
 * ⚠️ **What is genuinely lost is *escalate within the department first*.** On this district that
 * cost nothing: ADR-0010 said there were two rungs and no third, and 0024 then left no
 * department holding an account, so the intermediate rung had nobody standing on it.
 */
export async function nextSeatUp(
  pool: Pool,
  fromTier: Tier,
  _departmentId: string | null,
): Promise<{ seatId: string; tier: Tier; hasHolder: boolean } | null> {
  const higher = TIER_ORDER.filter((t) => tierRank(t) > tierRank(fromTier));
  if (higher.length === 0) return null;

  const res = await pool.query<SeatRow>(
    `SELECT s.seat_id,
            s.tier,
            s.is_administration,
            EXISTS (
              SELECT 1 FROM duty_assignment d
               WHERE d.seat_id = s.seat_id AND d.to_at IS NULL
            ) AS has_holder
       FROM seat s
      WHERE s.tier = ANY($1::text[])
        AND s.retired_at IS NULL
      -- Stable, so two runs against the same data escalate to the same seat. Arbitrary row
      -- order would make "why did it go there?" unanswerable after the fact.
      ORDER BY s.created_at, s.seat_id`,
    [higher],
  );

  for (const tier of higher) {
    const atTier = res.rows.filter((r) => r.tier === tier);
    // A **held** seat first, in every case, before any unheld one.
    //
    // ⚠️ THE ADMINISTRATION IS PREFERRED AMONG HELD SEATS, and that ordering is the whole of
    // what the department preferences used to express: climbing OUT of where this sat is the
    // point of escalating at all. Only once nothing at this rung has a holder does an empty
    // post get picked — and picking one is correct rather than a fallback failure. ADR-0004:
    // a post with nobody in it must never *swallow* an obligation, so the escalation lands
    // there and is reported as needing a human.
    const preferred =
      atTier.find((r) => r.is_administration && r.has_holder) ??
      atTier.find((r) => r.has_holder) ??
      atTier.find((r) => r.is_administration) ??
      atTier[0];

    if (preferred !== undefined) {
      return { seatId: preferred.seat_id, tier: preferred.tier, hasHolder: preferred.has_holder };
    }
  }

  return null;
}

/**
 * Incidents that might need escalating, **oldest first**.
 *
 * ⚠️ **Exported since Phase 5, and what is shared is the narrowing scan rather than the rule.**
 * The nudge job asks the same first question this pass does — *what is open, unacknowledged, and
 * belongs to the district's day* — and a second query of its own would be ADR-0020's day boundary
 * written twice, in two files, free to disagree about the five hours either side of a Bajaur
 * midnight. What is **not** shared is the verdict: `checkEscalation` decides here, `checkNudge`
 * decides there, and both read the one clock in `domain/sla.ts`.
 *
 * Deliberately loose about severity and deadlines: evaluating those here would be the
 * escalation rule written a second time, in a second language, free to drift from the
 * first.
 *
 * The ordering is not cosmetic. An earlier version selected an arbitrary `LIMIT` of the
 * open set, so once the district had more open incidents than the cap, *which* ones got
 * scanned was down to whatever order Postgres happened to return — and the same incident
 * could lose that lottery on every pass and sit unescalated indefinitely. Oldest-first
 * means the most overdue is always seen, and nothing can be starved.
 */
export async function unacknowledgedInDay(
  pool: Pool,
  limit: number,
  bounds: { readonly from: string; readonly to: string },
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    /**
     * The `HAVING` clause is ADR-0020, and it is **the same rule the board applies**.
     *
     * An incident belongs to a district day if it **arrived** that day or **happened** that day.
     * Both, because a report captured offline at 23:40 in a village and synced at 06:10 is
     * yesterday's fact and today's work — and an escalation ladder that skipped it because its
     * `occurred_at` was yesterday would leave the one emergency most likely to still be burning
     * as the one nobody chases.
     *
     * Deliberately **not** "any event today". An acknowledgement or an action on a three-day-old
     * incident must not pull it back into the chase; that would quietly undo the reset the
     * district asked for.
     *
     * `MIN` on both, so this matches `foldIncident`'s own `occurredAt` — the earliest of the
     * incident's events, not whichever row Postgres returned first.
     */
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($5::uuid[] IS NULL OR e.incident_id = ANY($5::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type IN ('acknowledged', 'resolved', 'closed')
            )
      GROUP BY e.incident_id
     HAVING (MIN(e.recorded_at) >= $3::timestamptz AND MIN(e.recorded_at) <= $4::timestamptz)
         OR (MIN(e.occurred_at) >= $3::timestamptz AND MIN(e.occurred_at) <= $4::timestamptz)
      ORDER BY first_seen ASC
      LIMIT $2`,
    [SCAN_DAYS, limit, bounds.from, bounds.to, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

/**
 * 🔴 **Acknowledged, and possibly held by nobody** — the district's response workflow, 2026-08-24.
 *
 * `unacknowledgedInDay` excludes anything carrying an `acknowledged` event, and for as long as an
 * acknowledgement meant *somebody has taken this* that was exactly right. The district's workflow
 * broke the equivalence: an officer can acknowledge and then answer *"Unable to Respond"* or
 * *"Not Related to Me"*, and four of them can do it to one fire. Every one of those incidents is
 * invisible to the query above, which is why this one exists.
 *
 * ## ⚠️ Why the district's own sentences are NOT in this SQL
 *
 * This file's header refuses to duplicate decisions in SQL, and *which words count as a decline*
 * is the most district-specific decision in the whole system — it changes when they send a new
 * document. So the predicate here is **structural and domain-free**: an incident that was
 * acknowledged, is not over, and has at least one settled obligation carrying words. Whether those
 * words are a decline is `ownershipOf`'s question, asked in TypeScript against
 * `responseOptions.ts`, in one place.
 *
 * ## Why a separate query and a separate limit
 *
 * Folding this into `unacknowledgedInDay` would let acknowledged incidents — nearly all of them
 * perfectly well held — consume a limit that exists so that *"the most overdue is always seen, and
 * nothing can be starved"*. A district with 200 healthy acknowledged emergencies would push a
 * genuinely unanswered one off the end of the scan. Two queries, two budgets, and neither can
 * crowd the other out.
 */
export async function acknowledgedButAnsweredInDay(
  pool: Pool,
  limit: number,
  bounds: { readonly from: string; readonly to: string },
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($5::uuid[] IS NULL OR e.incident_id = ANY($5::uuid[]))
        AND EXISTS (
              SELECT 1 FROM incident_event a
               WHERE a.incident_id = e.incident_id
                 AND a.type = 'acknowledged'
            )
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type IN ('resolved', 'closed')
            )
        AND EXISTS (
              SELECT 1 FROM incident_event d
               WHERE d.incident_id = e.incident_id
                 AND d.type = 'notification_delivered'
                 AND d.payload ? 'said'
            )
      GROUP BY e.incident_id
     HAVING (MIN(e.recorded_at) >= $3::timestamptz AND MIN(e.recorded_at) <= $4::timestamptz)
         OR (MIN(e.occurred_at) >= $3::timestamptz AND MIN(e.occurred_at) <= $4::timestamptz)
      ORDER BY first_seen ASC
      LIMIT $2`,
    [SCAN_DAYS, limit, bounds.from, bounds.to, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

/**
 * Yesterday's unacknowledged emergencies, which nobody is chasing any more — ADR-0020.
 *
 * Selected the same way `candidates` selects today's, one district day back, and **excluding
 * anything that already carries its closing event** — which is what makes this idempotent
 * without a marker table or a precise midnight trigger.
 *
 * Self-healing on purpose, for the reason `nightly.ts` gives about the backup: a district server
 * gets rebooted, loses power, and is occasionally a laptop somebody closed. A job that fires
 * exactly at midnight is a job that silently does not fire. This runs on every pass and writes at
 * most one event per incident, ever.
 */
async function unclosedFromYesterday(
  pool: Pool,
  limit: number,
  bounds: { readonly from: string; readonly to: string },
  only?: readonly string[],
): Promise<readonly string[]> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT e.incident_id, MIN(e.recorded_at) AS first_seen
       FROM incident_event e
      WHERE e.recorded_at > now() - make_interval(days => $1)
        AND ($5::uuid[] IS NULL OR e.incident_id = ANY($5::uuid[]))
        AND NOT EXISTS (
              SELECT 1 FROM incident_event x
               WHERE x.incident_id = e.incident_id
                 AND x.type IN ('acknowledged', 'resolved', 'closed', 'escalation_ended')
            )
      GROUP BY e.incident_id
     HAVING (MIN(e.recorded_at) >= $3::timestamptz AND MIN(e.recorded_at) <= $4::timestamptz)
         OR (MIN(e.occurred_at) >= $3::timestamptz AND MIN(e.occurred_at) <= $4::timestamptz)
      ORDER BY first_seen ASC
      LIMIT $2`,
    [SCAN_DAYS + 1, limit, bounds.from, bounds.to, only ?? null],
  );
  return res.rows.map((r) => r.incident_id);
}

export interface EscalationOptions {
  readonly targets?: SlaTargets;
  readonly now?: string;
  readonly limit?: number;
  /**
   * Evaluate only these incidents. Used to re-check specific cases after a manual change,
   * and by tests that must not depend on what else is open in the database.
   */
  readonly incidentIds?: readonly string[];
}

/**
 * One pass. Safe to call repeatedly; safe to call concurrently (see `scheduler.ts`).
 *
 * Idempotency comes from the ladder itself rather than a marker: an incident is only
 * escalated to a tier strictly above the one it has already reached. A second pass a
 * second later therefore does nothing, which is what stops a scan loop from becoming a
 * notification storm (INV-08).
 */
export async function runEscalationPass(
  pool: Pool,
  options: EscalationOptions = {},
): Promise<EscalationOutcome> {
  // The district's own deadlines, not the ones compiled into this file (Q-06). Loaded once
  // per pass rather than once per incident: a scan of 500 incidents must not become 500
  // settings queries, and a deadline that changed mid-pass would make one scan apply two
  // different rules — which is exactly the kind of thing nobody can explain afterwards.
  //
  // A pass that cannot read the configuration falls back rather than escalating nothing.
  // Skipping the pass would mean **no escalations at all** while the table is unreachable,
  // and an escalation that does not fire is the failure INV-07 exists to prevent.
  const config: SlaConfig =
    options.targets !== undefined
      ? { district: options.targets, byDepartment: {} }
      : await loadSlaConfiguration(pool).catch(() => ({
          district: PLACEHOLDER_SLA,
          byDepartment: {},
        }));
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 500;

  /**
   * **Today, as the district means it** — ADR-0020, and from the one clock (Phase 1).
   *
   * Never `now() - interval '1 day'`. Bajaur is UTC+05:00, so rolling arithmetic crosses every
   * midnight and would put this job and the board on two different days — the exact discrepancy
   * this decision exists to remove, and the exact shape of the timezone defect (O-01) that was
   * live on the district's own board for a week.
   */
  const today = { from: startOfDistrictDay(now), to: endOfDistrictDay(now) };

  /**
   * Two scans, and the second is the district's response workflow arriving in the ladder.
   *
   * De-duplicated because the two predicates are disjoint today — one demands an `acknowledged`
   * event, the other forbids it — and that is exactly the kind of invariant that stops being true
   * when somebody edits one query. A `Set` costs nothing and means an emergency can never be
   * escalated twice in one pass because it matched both.
   */
  const ids = [
    ...new Set([
      ...(await unacknowledgedInDay(pool, limit, today, options.incidentIds)),
      ...(await acknowledgedButAnsweredInDay(pool, limit, today, options.incidentIds)),
    ]),
  ];

  let escalated = 0;
  const exhausted: string[] = [];
  const noHolder: string[] = [];

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);
    if (state.severity === null || state.occurredAt === null || state.lastRecordedAt === null) {
      continue;
    }

    /**
     * **A General communication never escalates — M9-10.**
     *
     * The same `CARRIES_SLA` set `board.ts` reads, and reading it from one place is the whole
     * point: a board that shows a meeting as overdue while this pass declines to escalate it, or
     * the reverse, is the kind of disagreement that gets discovered at 02:00. `domain/sla.ts`
     * deliberately does not know about kinds — it answers "is this past its deadline", which is
     * a question worth keeping pure — so the two callers that decide *whether to ask* both ask
     * the same set.
     *
     * The cost of getting this wrong is not a wrong number on a screen. It is the DC being woken
     * for a meeting notice, and then learning that escalations can be ignored.
     */
    if (!CARRIES_SLA.has(state.kind)) continue;

    /**
     * 🔴 **Whether anybody is actually holding this**, asked off the officers' own words.
     *
     * For an incident from the first scan this is almost always `false` — nobody has answered at
     * all, so nobody has declined — and it changes nothing. It earns its place on the second scan,
     * where the incident *is* acknowledged and the only question left is whether the acknowledging
     * officers then said they could not act.
     */
    const owned = ownershipOf(state.notifications);

    const verdict = checkEscalation(
      {
        severity: state.severity.value,
        occurredAt: state.occurredAt,
        recordedAt: state.lastRecordedAt,
        acknowledgedAt: state.acknowledgedAt,
        now,
        ownerless: owned.ownerless,
      },
      // Per incident, because the deadline belongs to whoever holds it. Where two
      // departments hold one incident the tightest deadline governs — see `targetsFor`.
      targetsFor(config, state.responsibleDepartmentIds),
    );

    if (!verdict.shouldEscalate) continue;

    // Where it currently sits. Before any escalation, that is the seat that last acted.
    const currentTier = await tierOfSeat(
      pool,
      state.currentEscalationSeatId ?? lastActingSeat(events),
    );
    const departmentId = state.responsibleDepartmentIds[0] ?? null;

    const next = await nextSeatUp(pool, currentTier ?? 'post', departmentId);

    if (next === null) {
      // Already at the top of the ladder and still unacknowledged. There is nothing left
      // for the system to do automatically, so it must be visible rather than silent.
      exhausted.push(incidentId);
      continue;
    }

    if (!next.hasHolder) {
      // A vacant post must not swallow an escalation (ADR-0004). Record it and surface it.
      noHolder.push(incidentId);
    }

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'escalated',
        occurredAt: now,
        recordedAt: now,
        clientSeq: state.eventCount + 1,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: {
          fromSeatId: state.currentEscalationSeatId,
          toSeatId: next.seatId,
          // A vacant post is a materially different situation from a missed deadline, and
          // whoever reviews this afterwards needs to be able to tell them apart.
          trigger: next.hasHolder ? 'sla_breach' : 'no_duty_holder',
        },
      } as unknown as IncidentEvent,
    ]);

    escalated += 1;
  }

  const ended = await closeOutYesterday(pool, limit, now, options.incidentIds);

  return {
    scanned: ids.length,
    escalated,
    exhausted,
    noHolder,
    ended,
    truncated: ids.length >= limit,
  };
}

/**
 * Write the closing event for yesterday's unacknowledged emergencies — ADR-0020.
 *
 * **This sends nothing.** Escalation stops at midnight, which is what the district asked for. All
 * this does is make the stopping **legible**: without it, an emergency with three escalations and
 * then nothing is indistinguishable from a crashed job, a server that was switched off, or a
 * ladder that ran out of rungs. Three of those four need somebody to act; one is normal.
 *
 * Failures are logged and swallowed rather than failing the pass. **A bookkeeping event must never
 * be the reason today's escalations do not run** — that would trade a live emergency for a
 * historical note, which is the wrong way round.
 */
async function closeOutYesterday(
  pool: Pool,
  limit: number,
  now: string,
  only?: readonly string[],
): Promise<number> {
  const midnight = startOfDistrictDay(now);
  const yesterday = {
    from: startOfDistrictDay(new Date(Date.parse(midnight) - 1).toISOString()),
    // One millisecond before today began — never `endOfDistrictDay(yesterday)` computed
    // separately, which would leave a gap or an overlap depending on how the day is rounded.
    to: new Date(Date.parse(midnight) - 1).toISOString(),
  };

  const ids = await unclosedFromYesterday(pool, limit, yesterday, only);
  let ended = 0;

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);
    // Only what the ladder was ever going to chase. A meeting notice was never escalating, so
    // saying the chase ended would be recording the end of something that never began.
    if (!CARRIES_SLA.has(state.kind)) continue;

    try {
      await append(pool, [
        {
          eventId: randomUUID(),
          incidentId,
          type: 'escalation_ended',
          occurredAt: now,
          recordedAt: now,
          clientSeq: state.eventCount + 1,
          actorPersonId: null,
          actorSeatId: null,
          sourceChannel: 'system',
          payload: {
            reason: 'day_ended',
            escalations: state.escalationCount,
            districtDate: districtDate(yesterday.from),
          },
        } as unknown as IncidentEvent,
      ]);
      ended += 1;
    } catch (error) {
      log('warn', 'could not record that escalation ended for the day', {
        incidentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return ended;
}

function lastActingSeat(events: readonly IncidentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const seat = events[i]!.actorSeatId;
    if (seat !== null) return seat;
  }
  return null;
}

/**
 * The tier a seat sits at, or null when it is not a seat we know.
 *
 * Exported for `api/escalate.ts` (Phase 8c). The manual path shares the **ladder**, deliberately,
 * and shares only that: it reads the rung an escalation currently stands on, and then climbs with
 * `nextSeatUp` exactly as this job does. Two implementations of *who is above whom* would be two
 * answers to the question the whole ladder exists to settle (ADR-0010).
 *
 * ⚠️ **What the manual path does NOT share is the starting rung, and that is on purpose** - see
 * `api/escalate.ts` for the reasoning and `backlog/for-the-owner.md` O-47 for the question it
 * raises about this job's own choice of `lastActingSeat`.
 */
export async function tierOfSeat(pool: Pool, seatId: string | null): Promise<Tier | null> {
  if (seatId === null) return null;
  const res = await pool.query<{ tier: Tier }>('SELECT tier FROM seat WHERE seat_id = $1', [
    seatId,
  ]);
  return res.rows[0]?.tier ?? null;
}
