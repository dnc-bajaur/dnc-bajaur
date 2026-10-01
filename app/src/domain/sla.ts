/**
 * Response deadlines and the timestamp problem. See ADR-0002 and
 * docs/02-connectivity-ladder.md.
 *
 * An incident reported at 14:02 during an outage may reach the server at 16:40. If SLA
 * logic uses receipt time, the response looks instantaneous and the metrics lie. If it
 * uses report time, a reconnect fires two hours of retroactive escalations at once.
 * Neither is acceptable, so the two uses are separated explicitly:
 *
 *   measurement      -> occurredAt   (tells the truth: this took 2h 41m)
 *   escalation firing -> recordedAt   (one labelled late-arrival alert, not a storm)
 *
 * The gap between them is not noise to be smoothed away. It is the district's real
 * connectivity picture, and it is what the DC needs to see.
 */

import type { Instant, Severity } from './events.js';

export const MINUTE_MS = 60_000;

/** Acknowledgement deadlines per severity, in minutes. */
export type SlaTargets = Readonly<Record<Severity, number>>;

/**
 * The values a fresh install starts from — **not** the district's rule.
 *
 * Q-06 asked what Bajaur's real acknowledgement targets are; the owner's answer was that the
 * DC and AC Headquarter offices set them inside the software. Migration 0007 seeds these
 * five numbers into `sla_target` so nothing changes behaviour on the day it runs, and from
 * that point the database is the authority. Everything that reads a deadline should be
 * reading configuration, not this constant.
 *
 * It survives for two honest uses: the seed, and the fallback when configuration cannot be
 * read at all. A board that refuses to draw because it could not load a settings table is
 * worse than a board drawn against last week's defaults, provided it is drawn once and not
 * relied on quietly — which is why `loadSlaConfiguration` failing is logged loudly.
 */
export const PLACEHOLDER_SLA: SlaTargets = {
  critical: 5,
  high: 15,
  moderate: 60,
  low: 240,
  /**
   * `unknown` is not a level (ADR-0009), but it still needs a deadline — and a tight one.
   *
   * An unassessed report must reach a human quickly; that is exactly why intake used to
   * guess `high`. It now expresses that urgency **here**, through the deadline, instead of
   * through a severity value that would lie on a screen. Same effect on escalation, no
   * false claim about what anyone assessed.
   */
  unknown: 15,
};

/**
 * The whole district's deadlines: a default per severity, plus whatever departments have
 * overridden. Mirrors the `sla_target` table; see `db/configStore.ts` for the loader.
 */
export interface SlaConfig {
  readonly district: SlaTargets;
  readonly byDepartment: Readonly<Record<string, Partial<Record<Severity, number>>>>;
}

/**
 * The deadlines that apply to an incident, given who is responsible for it.
 *
 * Two steps, and they are different operations — conflating them was a real bug caught by
 * the M1a tests, where a department given a *longer* deadline than the district silently
 * kept the district's shorter one.
 *
 * 1. **Per department, an override replaces the default.** If the district says 240 minutes
 *    for `low` and a department is set to 999, that department's answer is 999. An override
 *    that only ever tightens is not an override; it is a floor, and nobody asked for a
 *    floor. The administration set 999 deliberately and the screen must say 999.
 *
 * 2. **Across departments, the tightest wins.** If Rescue must acknowledge a critical in 5
 *    minutes and Police in 15, the incident is late at 5 — at that moment one of the two
 *    responsible departments is genuinely late, and showing "on time" would be reporting the
 *    more comfortable of two true statements. Same principle as the severity aggregate:
 *    never let one row's good news hide another's bad.
 *
 * An unrouted incident falls to the district default, which is correct — nobody has a
 * department deadline until somebody has the incident.
 */
export function targetsFor(config: SlaConfig, departmentIds: readonly string[]): SlaTargets {
  if (departmentIds.length === 0) return config.district;

  let merged: Record<string, number> | null = null;

  for (const id of departmentIds) {
    // Step 1: this department's own view of the deadlines.
    const effective: Record<string, number> = { ...config.district, ...config.byDepartment[id] };

    if (merged === null) {
      merged = effective;
      continue;
    }

    // Step 2: the strictest obligation among the departments that hold it.
    for (const [severity, minutes] of Object.entries(effective)) {
      const current = merged[severity];
      if (current === undefined || minutes < current) merged[severity] = minutes;
    }
  }

  return (merged ?? config.district) as unknown as SlaTargets;
}

/**
 * Grace applied to escalation firing after a late arrival, so a two-hour outage produces
 * one alert per incident rather than a retroactive cascade (INV-08).
 */
export const LATE_ARRIVAL_GRACE_MINUTES = 10;

/** Beyond this, an incident is tagged as late-arriving and surfaced to the control room. */
export const LATE_ARRIVAL_THRESHOLD_MINUTES = 15;

function ms(a: Instant, b: Instant): number {
  return Date.parse(b) - Date.parse(a);
}

export function minutesBetween(a: Instant, b: Instant): number {
  return ms(a, b) / MINUTE_MS;
}

/** How long the district actually took. Always measured from when it happened. */
export function responseMinutes(occurredAt: Instant, acknowledgedAt: Instant): number {
  return minutesBetween(occurredAt, acknowledgedAt);
}

/** How long the report spent unseen by the server. The connectivity signal. */
export function arrivalGapMinutes(occurredAt: Instant, recordedAt: Instant): number {
  return Math.max(0, minutesBetween(occurredAt, recordedAt));
}

export function isLateArrival(occurredAt: Instant, recordedAt: Instant): boolean {
  return arrivalGapMinutes(occurredAt, recordedAt) > LATE_ARRIVAL_THRESHOLD_MINUTES;
}

export interface EscalationCheck {
  readonly severity: Severity;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  readonly acknowledgedAt: Instant | null;
  readonly now: Instant;
  /**
   * 🔴 **Everybody answered, and every one of them declined** — the district's response workflow,
   * 2026-08-24.
   *
   * Until that workflow existed, an acknowledgement and *somebody has taken this* were the same
   * fact, and the early return below was simply true. They came apart the day officers were given
   * a way to say *"Unable to Respond"* and *"Not Related to Me"*: four officers can each tap
   * *Acknowledge*, each decline, and this function would call the emergency answered — the clock
   * stops, the ladder never climbs, and the board sits green over a fire nobody is going to.
   *
   * That is INV-03 defeated politely, and it is precisely the night this ladder exists for. So an
   * acknowledgement stops the clock **only while somebody is holding it**, and who is holding it
   * is `domain/ownership.ts`'s question, asked off the officers' own words.
   *
   * ⚠️ **Optional and defaulting to false**, so the two callers that predate the workflow keep
   * their exact behaviour. Absent means *nobody has told this function otherwise*, which is the
   * safe reading in the direction that does not invent escalations.
   */
  readonly ownerless?: boolean;
}

export interface EscalationVerdict {
  readonly shouldEscalate: boolean;
  /** True when the deadline was already past on arrival — label it, do not storm. */
  readonly lateArrival: boolean;
  /** Minutes past the acknowledgement deadline, measured honestly from occurredAt. */
  readonly overdueByMinutes: number;
  readonly reason: string;
}

/**
 * **The one clock, read once and shared** — 2026-08-21.
 *
 * `checkEscalation` has always computed this and kept it to itself. Phase 5 asks a second
 * question of exactly the same arithmetic — *is this officer running out of time* — and a nudge
 * that derived its own `clockStart` would eventually disagree with the ladder about when the
 * allowance began. That is the `severityOf` rule applied to a deadline: **the interesting
 * decisions get made in one place, or they get made twice and drift.**
 *
 * Not exported. What leaves this file is a verdict, never the workings — a caller holding
 * `allowance` would be a caller one arithmetic slip away from its own escalation rule, which is
 * the duplication `jobs/escalation.ts`'s header refuses in SQL and must equally refuse here.
 */
interface Clock {
  /** When the district could first have acted: occurrence, or arrival for a late report. */
  readonly clockStart: Instant;
  /** How long it has, from `clockStart`. The severity target, or the grace after a late arrival. */
  readonly allowance: number;
  readonly elapsed: number;
  readonly lateArrival: boolean;
  /** Minutes between arrival and occurrence. Carried so the reason can say it. */
  readonly gap: number;
}

function clockFor(check: EscalationCheck, target: number): Clock {
  const gap = arrivalGapMinutes(check.occurredAt, check.recordedAt);
  const lateArrival = gap > target;

  // Escalation is timed from when we could first have acted on it, plus grace. Anything
  // else punishes the district for a network outage it did not cause and cannot fix.
  const clockStart = lateArrival ? check.recordedAt : check.occurredAt;
  const allowance = lateArrival ? LATE_ARRIVAL_GRACE_MINUTES : target;

  return {
    clockStart,
    allowance,
    elapsed: minutesBetween(clockStart, check.now),
    lateArrival,
    gap,
  };
}

/**
 * Decide whether an unacknowledged incident should escalate now.
 *
 * This runs on the server, from a durable job queue — never on a client. A closed laptop
 * must not stop an escalation (INV-07).
 */
export function checkEscalation(
  check: EscalationCheck,
  targets: SlaTargets = PLACEHOLDER_SLA,
): EscalationVerdict {
  const target = targets[check.severity];
  const deadlineFromOccurrence = minutesBetween(check.occurredAt, check.now) - target;

  /**
   * ⚠️ **An acknowledgement stops the clock only while somebody is holding the emergency.** See
   * `EscalationCheck.ownerless` — the two were the same fact until officers were given a way to
   * acknowledge and then decline.
   */
  if (check.acknowledgedAt !== null && check.ownerless !== true) {
    return {
      shouldEscalate: false,
      lateArrival: false,
      overdueByMinutes: Math.max(0, deadlineFromOccurrence),
      reason: 'acknowledged',
    };
  }

  const clock = clockFor(check, target);

  /**
   * The reason says which of the two this is, and that is not cosmetic. It is written onto the
   * `escalated` event and read months later by somebody asking why a Deputy Commissioner was
   * woken — and *"nobody answered"* and *"everybody answered and every one of them declined"* are
   * very different accounts of the same night.
   */
  const missed = clock.lateArrival
    ? `arrived ${Math.round(clock.gap)}m after it happened; grace window ${LATE_ARRIVAL_GRACE_MINUTES}m`
    : `unacknowledged past ${target}m target`;

  return {
    shouldEscalate: clock.elapsed >= clock.allowance,
    lateArrival: clock.lateArrival,
    overdueByMinutes: Math.max(0, deadlineFromOccurrence),
    reason:
      check.acknowledgedAt !== null
        ? `acknowledged, but every recipient declined; past ${target}m target`
        : missed,
  };
}

/**
 * **How much of the allowance is left, and whether it is late enough to be worth saying so** —
 * Phase 5, 2026-08-21.
 *
 * ## What this is for, and what it deliberately is not
 *
 * It is not a second escalation rule. It answers one question the ladder never asked: *this
 * officer has not answered and is running out of time — is now the moment to say so?* The
 * escalation itself is unchanged, fires on exactly the same clock, and happens whether or not a
 * nudge was ever sent, arrived, or was even switched on.
 *
 * ## Why a FRACTION of the allowance, and not a number of minutes
 *
 * 🔴 **Bajaur's own targets span five minutes to four hours.** `critical` is 5 and `low` is 240.
 * A fixed *"nudge fifteen minutes before the deadline"* would fire ten minutes before a critical
 * emergency was ever reported — that is, never — and would be indistinguishable from the
 * escalation itself on a `low` one. The only thing that means the same at both ends of that
 * range is *how much of their time is gone*.
 *
 * ⚠️ **And it is a fraction of the ALLOWANCE, not of the target**, which is the part that is easy
 * to get wrong. On a late-arriving report the allowance is ten minutes of grace, not the severity
 * target — the district only learned of it moments ago — so a nudge measured against the target
 * would already be overdue the instant the report landed, and the officer would get a reminder in
 * the same breath as the alert.
 *
 * ## The floor, and why one exists
 *
 * A nudge that lands seconds before the ladder climbs is not a chance to answer; it is noise
 * arriving beside an escalation. `MIN_NUDGE_LEAD_MINUTES` is the least lead worth interrupting
 * somebody for, and below it this returns false rather than sending — where a target is so tight
 * that no useful lead exists, the honest answer is that a nudge has nothing to offer.
 */
export interface NudgeVerdict {
  readonly shouldNudge: boolean;
  /** Whole minutes before the ladder climbs. Zero or less means it is already due. */
  readonly minutesLeft: number;
}

/**
 * How far through the allowance an officer must be before the district says anything.
 *
 * Two thirds rather than a half: a nudge at the halfway mark is a reminder about a deadline
 * nobody is near, sent on every emergency to every officer, and **the message that is there every
 * time is the message people stop reading** — `moreSentence`'s rule and the capacity line's, in a
 * third place. The last third is when it is genuinely worth interrupting somebody.
 */
export const NUDGE_AT_FRACTION = 2 / 3;

/**
 * Below this much remaining lead, no nudge is sent at all.
 *
 * A minute's warning is not a chance to answer. It would arrive beside the escalation it was
 * meant to prevent, and read as the system saying the same thing twice.
 */
export const MIN_NUDGE_LEAD_MINUTES = 2;

export function checkNudge(
  check: EscalationCheck,
  targets: SlaTargets = PLACEHOLDER_SLA,
): NudgeVerdict {
  // An acknowledged emergency is nobody's outstanding obligation and there is nothing to remind
  // anybody of. Asked first, exactly as `checkEscalation` asks it.
  if (check.acknowledgedAt !== null) return { shouldNudge: false, minutesLeft: 0 };

  const clock = clockFor(check, targets[check.severity]);
  const minutesLeft = clock.allowance - clock.elapsed;

  return {
    /**
     * Past the fraction, and still with enough lead to be worth reading.
     *
     * ⚠️ **The upper bound is not ceremony.** Once the allowance is spent the ladder has climbed
     * and the seat above has been told; a nudge to the officer below is the district chasing
     * somebody it has already gone over the head of, which is a message that arrives to say the
     * one thing nobody needs to hear.
     */
    shouldNudge:
      clock.elapsed >= clock.allowance * NUDGE_AT_FRACTION && minutesLeft >= MIN_NUDGE_LEAD_MINUTES,
    minutesLeft: Math.round(minutesLeft),
  };
}
