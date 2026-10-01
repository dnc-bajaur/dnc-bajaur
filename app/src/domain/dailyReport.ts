/**
 * One day, folded — M9-46, M9-48, M9-51.
 *
 * Pure. Takes states and rows, returns a report. The gathering is `api/dailyReport.ts`; every
 * judgement about what a day *contains* is here, where it can be tested without a database.
 *
 * ## What a daily report is for, and what it must never become
 *
 * It is the thing an officer prints at 08:00 and puts in front of the DC. That makes it the one
 * artefact in this system most likely to be read by somebody who was **not** there — and the one
 * most likely to be believed without question, because it is on paper.
 *
 * So two rules run through the whole file:
 *
 * **A gap is stated, never omitted.** An emergency nobody responded to, a message that reached
 * nobody, a communication with no recipients — each gets a line saying so. A report that lists
 * only what went well is a report that makes a bad night look like a quiet one, which is INV-03
 * and INV-04 arriving on paper instead of on a screen.
 *
 * **An empty day says it is empty** (M9-51). Never a blank page, never an error. *"Nothing was
 * reported on 12 August"* is a finding; a zero-byte file is a fault somebody has to chase, and
 * the chase ends with the district trusting the report less.
 *
 * ## Ordering is deterministic, and that is a requirement rather than a nicety
 *
 * Two people run the same report for the same day and diff the files. If the order wobbles, the
 * diff is noise and the comparison is abandoned. Everything sorts by time, then by a stable
 * tiebreak that is never a uuid the reader cannot see.
 */

import type { IncidentState } from './incident.js';
import { isGeneral, isGathering, type Uuid } from './events.js';
import { stageLabel, stageOf } from './stages.js';
import { ownershipOf } from './ownership.js';
import { attendanceFor } from './attendance.js';
import { attendanceClosesAt } from './meetings.js';
import { presenceLabel, type PresenceStatus } from './wall.js';

/** One line about one emergency or communication. */
export interface DayIncident {
  readonly incidentId: Uuid;
  /** `emergency`, `alert`, `meeting`… — the kind as the district chose it. */
  readonly kind: string;
  readonly general: boolean;
  readonly occurredAt: string;
  readonly category: string;
  readonly severity: string;
  /** Issued / Responded / Resolved — the district's words (M9-25, narrowed 2026-09-04). */
  readonly stage: string;
  readonly departments: readonly string[];
  /** When the SLA/escalation clock stopped. Printed as "Responded", never "Acknowledged" — see
   *  `domain/stages.ts`'s header; the field name is unchanged underneath (ADR-0001: no event is
   *  renamed after the fact, and nothing here reads or writes a second field for the same fact). */
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  /**
   * Answered, and nobody is holding it — Option C. A refusal fills `acknowledgedAt` and takes
   * nothing; on a wide dispatch that is *every* recipient. Kept beside `acknowledgedAt` so the
   * `unacknowledged` total counts these and a reader can tell "not answered" from "all refused".
   */
  readonly ownerless: boolean;
  /**
   * **Who is coming, when this row asked who is coming** — the Case 2 (meeting) work,
   * 2026-09-10.
   *
   * Non-null only for a `meeting` or an `asksAttendance` notice; on those rows the report's
   * *Responded* cell shows this instead of *responded by* — a meeting has no single responder.
   * Null for every emergency and plain notice, where the row is unchanged. `coming` is
   * `attending + sendingSomeone`.
   */
  readonly attendance: {
    readonly told: number;
    readonly coming: number;
    readonly answered: number;
    readonly attending: number;
    readonly sendingSomeone: number;
    readonly notAttending: number;
    readonly unanswered: number;
  } | null;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
  /** How many were owed a message, and how many of those did not get one. */
  readonly told: number;
  readonly unmet: number;
  /**
   * **The saved groups a dispatch on this incident expanded** — Case 3, 2026-09-10. Names only,
   * read off `dispatched.payload.fromGroups`; `[]` for every incident told only by hand. Display
   * only — `told` above is unchanged and still counts every recipient independently; this only
   * says that some of them were one tick.
   */
  readonly toldGroups: readonly string[];
  /**
   * The sentence that must be on the paper when something went wrong.
   *
   * Null when nothing did. Never an empty string — a column of empty cells reads as a column
   * nobody filled in, and a reader stops looking at it.
   */
  readonly gap: string | null;
  /**
   * What was wrong with it, if anything — M9-52.
   *
   * On the report because a corrected communication that looks identical to an uncorrected one
   * is the reason somebody turns up to a meeting on the wrong day. The original line stays;
   * this rides beside it.
   */
  readonly corrected: string | null;
  /**
   * **Why it is not on the board any more** — M10-15, and this line is what makes withdrawal
   * safe to offer at all.
   *
   * The district asked to take things off the dashboard, emergencies included. A row that left
   * the screen **and** the day's own paper record would be a delete wearing another name, and
   * this is the artefact most likely to be read by somebody who was not there and believed
   * without question. So it stays on the report, in its place, saying what happened to it.
   *
   * Null for the overwhelming majority of rows, exactly like `corrected`.
   */
  readonly withdrawn: string | null;
}

export interface DayAdvisory {
  readonly issuedAt: string;
  readonly tag: string;
  readonly message: string;
  readonly untilAt: string;
  readonly issuedBy: string | null;
}

export interface DayAvailability {
  readonly reportedAt: string;
  readonly seat: string;
  readonly person: string | null;
  readonly status: PresenceStatus;
  readonly label: string;
  readonly untilAt: string | null;
  readonly reportedBy: string | null;
}

export interface DailyReport {
  /** The district's own day, as a name: `2026-08-13`. Never an instant (M9-49). */
  readonly date: string;
  readonly scope: string;
  readonly generatedAt: string;
  readonly emergencies: readonly DayIncident[];
  readonly communications: readonly DayIncident[];
  readonly advisories: readonly DayAdvisory[];
  readonly availability: readonly DayAvailability[];
  readonly totals: {
    readonly emergencies: number;
    readonly communications: number;
    readonly advisories: number;
    readonly availability: number;
    readonly unacknowledged: number;
    readonly unresolved: number;
    readonly nobodyTold: number;
    readonly unmet: number;
  };
  /**
   * The one sentence at the top.
   *
   * Written here rather than by whichever renderer got there first, so the printed page, the
   * CSV header and any later screen cannot each summarise the same day differently.
   */
  readonly summary: string;
  /** True when the day held nothing at all. The renderers say so rather than drawing nothing. */
  readonly empty: boolean;
  /**
   * **Emergencies from earlier days that nobody ever responded to** — ADR-0020's obligation.
   *
   * The district chose a board that resets nightly and escalation that stops with the day. That
   * decision accepts one failure: an emergency nobody has responded to at midnight is pursued by
   * no software afterwards. **This block is the whole of what stands in its place.**
   *
   * It is in the report and not on the board, because the reset was asked for in full. What it
   * buys is that the case lands in front of somebody **doing their ordinary morning work**,
   * rather than only in front of somebody who already suspects a problem.
   *
   * Empty on a district that closes its work within the day — which is the assumption the whole
   * decision rests on, so a list that grows and stays grown is the measurement of that assumption
   * failing, and is the signal ADR-0020 names for revisiting itself.
   */
  readonly outstanding: readonly DayOutstanding[];
}

export interface DayOutstanding {
  readonly incidentId: string;
  /** The district day it belongs to — the day to open to see it in full. */
  readonly date: string;
  readonly severity: string;
  readonly category: string;
  readonly departments: readonly string[];
  /** How far the ladder got before the day ended. Zero means nobody was ever escalated to. */
  readonly escalations: number;
  /** How many days ago, in the district's own reckoning. */
  readonly daysAgo: number;
}

export interface DailySources {
  readonly date: string;
  readonly scope: string;
  readonly generatedAt: string;
  readonly states: readonly IncidentState[];
  /**
   * Emergencies from **before** this day that were never responded to — ADR-0020.
   *
   * Passed in rather than derived from `states`, because they are by definition not in this day's
   * selection. Absent on a report for a past day: *"still outstanding"* is a statement about now,
   * and putting today's outstanding list on August's report would make a printed page change
   * meaning every time it was reprinted.
   */
  readonly outstanding?: readonly DayOutstanding[];
  /**
   * **The saved groups each incident's dispatches expanded** — Case 3, 2026-09-10. Group names
   * by `incidentId`, computed by the caller off the same events the fold reads (this module
   * stays pure — no event log, only `states`). Absent, or an incident missing from it, both mean
   * *no group was used* — `[]` on that row's `toldGroups`, no different from an older caller.
   */
  readonly groupsByIncident?: ReadonlyMap<Uuid, readonly string[]>;
  readonly advisories: readonly DayAdvisory[];
  readonly availability: readonly {
    readonly reportedAt: string;
    readonly seat: string;
    readonly person: string | null;
    readonly status: PresenceStatus;
    readonly untilAt: string | null;
    readonly reportedBy: string | null;
  }[];
  /** Department names by id, so no line in the report renders a uuid. */
  readonly departments: Readonly<Record<string, string>>;
  /** Seat titles by id, for who responded. */
  readonly seats: Readonly<Record<string, string>>;
  /** Person names by id — the report leads with the officer, then the post (ADR-0035). */
  readonly people: Readonly<Record<string, string>>;
}

/**
 * Person first, then post — ADR-0035. Authority still attaches to the post (ADR-0004); this is
 * the reading order the district asked for. One string when the two would restate each other.
 */
function personFirst(personName: string | null, postTitle: string | null): string | null {
  if (personName === null) return postTitle;
  if (postTitle === null || postTitle === personName) return personName;
  return `${personName} — ${postTitle}`;
}

/**
 * What went wrong with this one, in a sentence — or null.
 *
 * Ordered by what the reader should act on first. Only **one** is returned, deliberately: three
 * sentences in a cell is a cell nobody reads, and the first is always the one that matters most.
 * The rest are still recoverable from the counts beside it.
 */
function gapOf(
  state: IncidentState,
  unmet: number,
  owned: ReturnType<typeof ownershipOf>,
  attendance: DayIncident['attendance'],
): string | null {
  if (state.dispatchedTo.length === 0 && !isGeneral(state.kind)) {
    return 'nobody was told';
  }
  if (unmet > 0) {
    return `${String(unmet)} of ${String(state.notifications.length)} were not reached`;
  }
  // A notice that asked who is coming, and not one of the people asked answered it.
  if (attendance !== null && attendance.told > 0 && attendance.answered === 0) {
    return 'nobody said whether they were coming';
  }
  /**
   * 🔴 **Everybody answered, and every one of them declined** — RX-04, 2026-08-25.
   *
   * This report said **nothing at all** about those. An emergency four officers had refused
   * counts as *responded to* (declining is answering), so the clause below never fired and
   * `gapOf` returned **null** — no gap — on the one line of the Deputy Commissioner's morning
   * report that most needed a sentence.
   *
   * ⚠️ **Placed above the response clause even though the two cannot both be true.** They are
   * mutually exclusive today, so the order changes no output; it is written this way because
   * this list is *ordered by what the reader should act on first*, and of the pair this is the
   * more urgent — *nobody has answered yet* may still resolve itself, and *everybody has
   * refused* will not.
   */
  if (owned.ownerless) {
    return owned.declined === 1
      ? 'the one recipient declined — nobody has taken it'
      : `all ${String(owned.declined)} recipients declined — nobody has taken it`;
  }
  if (state.acknowledgedAt === null && !isGeneral(state.kind)) {
    return 'nobody responded to it';
  }
  return null;
}

function lineFor(state: IncidentState, sources: DailySources): DayIncident {
  const unmet = state.notifications.filter(
    (n) => n.state === 'failed' || n.state === 'pending',
  ).length;

  /**
   * Who took this, off the officers' own words — Option C. `told > 1` switches the line's
   * "Responded" / "Responded by" and its stage to the first office that **committed**; the
   * fold's `acknowledgedBy*` slot has named whoever answered first, a refusal included. On a
   * single recipient the slot and the roll-up are the same, so those lines do not move.
   */
  const owned = ownershipOf(state.notifications);
  const wide = owned.told > 1;
  const respondedAt = wide ? owned.respondedAt : state.acknowledgedAt;
  const takenBySeatId = wide ? owned.takenBySeatId : state.acknowledgedBySeatId;
  const takenByPersonId = wide ? owned.takenByPersonId : state.acknowledgedByPersonId;
  const heldElsewhere = wide && owned.ownerless && !isGathering(state.kind);

  /**
   * Who is coming — null unless this notice asked who is coming. On those rows the *Responded*
   * cell shows the tally instead of *responded by*: a meeting has no single responder.
   */
  const askedAt = state.dispatchedAt ?? state.occurredAt;
  const tally = attendanceFor(state.kind, state.notifications, {
    rescheduledAt: state.rescheduledAt,
    closesAt: askedAt === null ? null : attendanceClosesAt(askedAt),
    invited: state.asksAttendance,
  });
  const attendance =
    tally === null
      ? null
      : {
          told: tally.told,
          coming: tally.coming,
          answered: tally.answered,
          attending: tally.attending,
          sendingSomeone: tally.sendingSomeone,
          notAttending: tally.notAttending,
          unanswered: tally.unanswered,
        };

  return {
    incidentId: state.incidentId,
    kind: state.kind,
    general: isGeneral(state.kind),
    occurredAt: state.occurredAt ?? '',
    category: state.category?.value ?? 'unknown',
    // "unassessed" spelled out, never left blank and never rendered as a level nobody chose
    // (ADR-0009). On paper this matters more than on a screen: a blank cell reads as "low".
    severity: state.severity?.value ?? 'unassessed',
    // A wide dispatch every office declined does not read "Responded" — see `api/dashboard.ts`,
    // which makes the same read for the wall. `domain/incident.ts` drives the status to
    // `responding` on any inbound reply, a refusal included.
    stage:
      heldElsewhere && stageOf(state.status) === 'responded'
        ? stageLabel('issued')
        : stageLabel(stageOf(state.status)),
    /**
     * ⚠️ **A DEPARTMENT NOBODY CAN NAME IS DROPPED, NOT PRINTED AS AN ID — ADR-0030.**
     *
     * `?? id` was right while a registry existed: a department that had vanished from it was a
     * real configuration problem, and falling back to the id surfaced it rather than hiding it.
     * Migration 0039 dropped the table, so there is no registry to vanish from and every
     * historical id is unnameable — which would put thirty-six characters of hexadecimal in the
     * *Responsible* column of the one document most likely to be read by somebody who was not
     * there, and filed. That is the identity line ADR-0027 exists to have taken off a screen.
     *
     * `performance.ts` took the same decision for the same reason, and the two must agree: a
     * figure and a row that disagree about one district is what this project keeps paying for.
     */
    departments: state.responsibleDepartmentIds.flatMap((id) => {
      const name = sources.departments[id];
      return name === undefined ? [] : [name];
    }),
    // A notice that asked who is coming has no single responder — the *Responded* cell shows
    // the attendance tally instead (see `attendance` below), so these two are blank there.
    acknowledgedAt: attendance !== null ? null : respondedAt,
    // Person first, then post — ADR-0035. One string when the two would restate each other.
    // On a wide dispatch this is the first office to commit, from the roll-up; otherwise the slot.
    acknowledgedBy:
      attendance !== null
        ? null
        : personFirst(
            takenByPersonId === null ? null : (sources.people[takenByPersonId] ?? null),
            takenBySeatId === null ? null : (sources.seats[takenBySeatId] ?? takenBySeatId),
          ),
    ownerless: owned.ownerless,
    attendance,
    resolvedAt:
      state.status === 'resolved' || state.status === 'closed' ? state.lastRecordedAt : null,
    resolution: state.resolution,
    told: state.notifications.length,
    toldGroups: sources.groupsByIncident?.get(state.incidentId) ?? [],
    unmet,
    gap: gapOf(state, unmet, owned, attendance),
    withdrawn: state.withdrawalReason,
    corrected:
      state.correctionReason === null
        ? null
        : state.correction === null
          ? state.correctionReason
          : `${state.correctionReason} — instead: ${state.correction}`,
  };
}

export function buildDailyReport(sources: DailySources): DailyReport {
  /**
   * Emergencies and communications are separated, not filtered.
   *
   * A meeting notice and a house fire are both things the district sent that day, and both
   * belong on the paper — but a table that mixes them makes the emergency count wrong at a
   * glance, which is the number the DC reads first.
   */
  const all = [...sources.states].sort(
    (a, b) =>
      (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') ||
      a.incidentId.localeCompare(b.incidentId),
  );

  const emergencies = all.filter((s) => !isGeneral(s.kind)).map((s) => lineFor(s, sources));
  const communications = all.filter((s) => isGeneral(s.kind)).map((s) => lineFor(s, sources));

  const advisories = [...sources.advisories].sort(
    (a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.message.localeCompare(b.message),
  );

  const availability = [...sources.availability]
    .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt) || a.seat.localeCompare(b.seat))
    .map((row) => ({
      ...row,
      // Resolved through the same function the dashboard uses, so the paper and the wall call
      // the same state by the same name. `fresh` because this is a record of what was said at
      // the time, not a claim about now — staleness is a question about the present.
      label: presenceLabel({
        value: row.status,
        freshness: 'fresh',
        asOf: row.reportedAt,
        ageMinutes: 0,
      }),
    }));

  const totals = {
    emergencies: emergencies.length,
    communications: communications.length,
    advisories: advisories.length,
    availability: availability.length,
    // `acknowledgedAt` is already null on a wide dispatch every office declined (the line reads
    // the roll-up); `|| e.ownerless` also catches the single recipient who declined — Option C.
    unacknowledged: emergencies.filter((e) => e.acknowledgedAt === null || e.ownerless).length,
    unresolved: emergencies.filter((e) => e.resolvedAt === null).length,
    nobodyTold: emergencies.filter((e) => e.told === 0).length,
    unmet: emergencies.reduce((n, e) => n + e.unmet, 0),
  };

  const empty =
    emergencies.length === 0 &&
    communications.length === 0 &&
    advisories.length === 0 &&
    availability.length === 0;

  const outstanding = [...(sources.outstanding ?? [])].sort(
    (a, b) => b.daysAgo - a.daysAgo || a.incidentId.localeCompare(b.incidentId),
  );

  return {
    date: sources.date,
    scope: sources.scope,
    generatedAt: sources.generatedAt,
    emergencies,
    communications,
    advisories,
    availability,
    totals,
    summary: summarise(sources.date, sources.scope, totals, empty),
    /**
     * **A day with nothing in it is still not empty if something is outstanding.**
     *
     * Otherwise the renderers would print *"nothing happened"* on a morning when three
     * emergencies from last week are sitting with nobody having responded — which is the
     * precise sentence ADR-0020's accepted failure would hide behind.
     */
    empty: empty && outstanding.length === 0,
    outstanding,
  };
}

/**
 * The sentence at the top of the page.
 *
 * **It leads with what is wrong.** Somebody who reads one line of this report should get the bad
 * news in the line they read — the same rule the dashboard's ticker follows. A summary that
 * opened with "14 emergencies" and buried "3 nobody responded to" would be technically complete
 * and practically silent.
 */
function summarise(
  date: string,
  scope: string,
  totals: DailyReport['totals'],
  empty: boolean,
): string {
  if (empty) {
    // A finding, not a fault. Said as a whole sentence so nobody reads a blank page as a
    // failed export and goes looking for a system that is working perfectly well.
    return `Nothing was recorded for ${scope} on ${date}.`;
  }

  const wrong: string[] = [];
  if (totals.nobodyTold > 0) wrong.push(`${String(totals.nobodyTold)} nobody was told about`);
  if (totals.unmet > 0) wrong.push(`${String(totals.unmet)} messages reached nobody`);
  if (totals.unacknowledged > 0) wrong.push(`${String(totals.unacknowledged)} nobody responded to`);
  if (totals.unresolved > 0) wrong.push(`${String(totals.unresolved)} still open`);

  const counted = [
    `${String(totals.emergencies)} emergencies`,
    `${String(totals.communications)} communications`,
    `${String(totals.advisories)} advisories`,
  ].join(', ');

  return wrong.length === 0
    ? `${scope}, ${date}: ${counted}. Nothing was left without a response or unreached.`
    : `${scope}, ${date}: ${wrong.join(', ')}. ${counted}.`;
}
