/**
 * **The half of the service window this district has never used — Phase 5, 2026-08-21.**
 *
 * ## What was already true, and what was missing
 *
 * Meta requires the *first* message of a conversation to be an approved template, and opens a
 * **24-hour service window** on a number the moment somebody there sends anything back. Inside it
 * free-form messages cost nothing, need no template and wait on no approval. `sendSession` has
 * been able to use that since Phase A on 20 August.
 *
 * Every single one of those sends has been a **reply**. An officer taps, and the district answers
 * within seconds; an officer types a name, and the district confirms. O-43(c) named the gap in one
 * sentence: *"the 24-hour window is only ever used to answer."* This file is the other half — the
 * three things worth saying **before anybody asks**:
 *
 *   * **A nudge before the ladder climbs over an officer's head.** Escalation is silent to the
 *     person being escalated past. They answered nothing, so at the deadline the district goes to
 *     their superior — and the first they hear of it is from that superior. A minute's warning is
 *     a chance to answer, and it costs the district nothing.
 *   * **A word when the emergency is closed.** An officer who was called out at 02:00 and told
 *     nothing afterwards learns to treat these messages as one-way traffic. *"This is closed,
 *     thank you"* is the cheapest thing in this whole system and it is the one that decides
 *     whether the next alert gets answered.
 *   * **One summary a day for the administration**, in the same numbers the morning report shows.
 *
 * ## 🔴 THE SWITCH IS OFF AND THE SWITCH IS THE POINT
 *
 * `WHATSAPP_PROACTIVE` absent or blank means **not one message from this file, ever** — see
 * `proactiveFromEnv`, and see the test that asserts it against a `fetch` which throws if called.
 * That is not caution about the code; it is what kind of thing this is. Everything WhatsApp has
 * ever sent from this system was **asked for** by somebody in the control room or by the officer
 * themselves. This messages a handset because **time passed**, which is a decision about how a
 * district's own number behaves towards its own officers, and it belongs to whoever owns that
 * number rather than to whoever ships the build.
 *
 * ## What this file may never do
 *
 * ⚠️ **Nothing here changes what happens to an emergency.** No event is appended, no obligation is
 * met, no ladder is altered, no clock is stopped. Escalation fires at exactly the moment it always
 * did whether or not a nudge was sent, arrived, or was switched on at all — because the day this
 * becomes load-bearing is the day a district that left the flag off has a quietly worse product.
 *
 * ⚠️ **And every send is claimed before it is attempted.** The scheduler ticks every fifteen
 * seconds and *"unacknowledged and running out of time"* is a standing condition, not an event.
 * Without `claimProactive` this would be four messages a minute to an officer at 02:00 — INV-08's
 * notification storm arriving through a door nobody had built yet. See migration 0033.
 */

import { loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { resolveIdentity } from '../auth/sessions.js';
import { loadSlaConfiguration } from '../db/configStore.js';
import {
  claimProactive,
  handsetsToldAbout,
  sessionWindowOpen,
  type ProactiveKind,
} from '../db/whatsappStore.js';
import { districtDate, startOfDistrictDay, endOfDistrictDay } from '../domain/districtTime.js';
import { CARRIES_SLA } from '../domain/events.js';
import { foldIncident } from '../domain/incident.js';
import {
  checkNudge,
  targetsFor,
  PLACEHOLDER_SLA,
  type SlaConfig,
  type SlaTargets,
} from '../domain/sla.js';
import { stageButtonId, stageButtonWords, stagesOfferedFrom } from '../domain/stages.js';
import { log } from '../obs/log.js';
import {
  sendSession,
  toE164,
  type ProactiveSettings,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import { dailyReport } from '../api/dailyReport.js';
import { unacknowledgedInDay } from './escalation.js';

export interface ProactiveOptions {
  readonly config: WhatsAppConfig;
  readonly settings: ProactiveSettings;
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests. Never set in production — the district's clock is `now`. */
  readonly now?: string;
  readonly limit?: number;
  /**
   * The district's acknowledgement deadlines, when a caller already holds them.
   *
   * Absent is the production path and reads `sla_target` — Q-06, the district's own figures and
   * not this build's constants. Present is `runEscalationPass`'s own seam, taken for the same
   * reason: a test that had to guess which targets the shared database happened to hold would be
   * measuring the fixture rather than the rule.
   */
  readonly targets?: SlaTargets;
  /**
   * Consider only these emergencies.
   *
   * `EscalationOptions` carries the identical field for the identical reason: this pass runs
   * against a database other suites are also writing to, and a nudge that fired for somebody
   * else's incident would make every count here a measurement of what else ran today.
   */
  readonly incidentIds?: readonly string[];
}

export interface ProactiveOutcome {
  readonly nudged: number;
  readonly closed: number;
  readonly summarised: number;
  /** Sends that were claimed and then refused by Meta. Claimed rows are not released — see below. */
  readonly failed: number;
}

const NOTHING: ProactiveOutcome = { nudged: 0, closed: 0, summarised: 0, failed: 0 };

/**
 * **The hour the administration's summary goes out, in the district's own clock.**
 *
 * Morning rather than midnight, and the reasoning is `outstandingBefore`'s: what this buys is that
 * the day's picture lands in front of somebody **doing their ordinary morning work**, rather than
 * on a handset at 00:01 beside the emergencies it is summarising. It reports the day that has just
 * **ended**, which is the only day it can report completely.
 */
const SUMMARY_HOUR = 8;

/**
 * How far back a closing word is worth sending.
 *
 * Long enough to survive a server that was off overnight — the same reason `nightly.ts` gives for
 * being self-healing rather than fired at an instant. Short enough that switching the flag on does
 * not open with a burst of thank-yous for emergencies closed last week, which would be the
 * district's officers learning on day one that these messages are noise.
 */
const CLOSED_LOOKBACK_HOURS = 6;

/**
 * One pass. Safe to call repeatedly, and safe to call concurrently.
 *
 * Returns `NOTHING` without touching the database when the flag is off — asked first, and asked
 * as the very first statement, so that the *"not one message"* guarantee does not depend on every
 * branch below it being right.
 */
export async function runProactivePass(
  pool: Pool,
  options: ProactiveOptions,
): Promise<ProactiveOutcome> {
  const { enabled } = options.settings;
  if (enabled.size === 0) return NOTHING;

  const now = options.now ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;

  const [nudged, closed, summarised] = await Promise.all([
    enabled.has('nudge') ? nudgePass(pool, options, now, fetchImpl) : Promise.resolve(NOTHING),
    enabled.has('closed') ? closedPass(pool, options, now, fetchImpl) : Promise.resolve(NOTHING),
    enabled.has('summary') ? summaryPass(pool, options, now, fetchImpl) : Promise.resolve(NOTHING),
  ]);

  return {
    nudged: nudged.nudged,
    closed: closed.closed,
    summarised: summarised.summarised,
    failed: nudged.failed + closed.failed + summarised.failed,
  };
}

/**
 * **Send one proactive message, having first claimed the right to.**
 *
 * The order is the whole safety of this file and it is `recordQuestion`'s, for the same reason:
 *
 *   1. is the window open — because a shut one is a `131047` nobody in a district office can read
 *   2. **claim**, atomically, before anything is sent
 *   3. send
 *
 * ⚠️ **A claim is never released when the send fails.** It costs the officer one message that was
 * never promised to them; releasing it would turn a provider's bad minute into the same message
 * every fifteen seconds until it recovered, which is a manufactured storm sitting on top of a real
 * fault. Every one of the three has another road to the same place — the alert's own buttons, the
 * board, and the morning report.
 */
async function sendOnce(
  pool: Pool,
  config: WhatsAppConfig,
  claim: { readonly kind: ProactiveKind; readonly subject: string; readonly phone: string },
  message: Parameters<typeof sendSession>[1],
  fetchImpl: typeof fetch,
): Promise<'sent' | 'failed' | 'skipped'> {
  if (!(await sessionWindowOpen(pool, claim.phone))) return 'skipped';
  if (!(await claimProactive(pool, claim))) return 'skipped';

  const result = await sendSession(config, message, fetchImpl);
  if (result.ok) return 'sent';

  /**
   * Logged and swallowed, always. **This pass must never be the reason an escalation does not
   * run** — it shares a tick with one, and trading a live emergency for a courtesy message is the
   * wrong way round in every case. `closeOutYesterday`'s rule, applied to a message.
   */
  log('warn', 'a proactive message was refused', {
    kind: claim.kind,
    subject: claim.subject,
    failure: result.failure,
  });
  return 'failed';
}

/**
 * **The nudge — before the ladder climbs, and never after.**
 *
 * ## Who it goes to, and why it is read off `whatsapp_message`
 *
 * Every handset this district **actually dialled** about this emergency, and no others. Not the
 * obligation's seat, and not the roster: an obligation names a post, turning a post into a number
 * is a question whose answer moves, and a nudge to somebody who was never told about the emergency
 * in the first place is a message with no context at 02:00. `handsetsToldAbout` is that set.
 *
 * ## 🔴 It costs the district nothing against `TIER_250`, and that is not an accident
 *
 * Meta caps **unique recipients** in a rolling 24 hours. Every handset here was messaged about
 * this emergency minutes or hours ago — inside that same rolling day, by construction, because the
 * nudge fires within one SLA allowance of the alert. So the district's allowance is already spent
 * on this number and the nudge adds **zero**. A design that nudged from the roster instead could
 * spend the district's remaining capacity on reminders, on the evening it needs it for alerts.
 *
 * ## What it does not do
 *
 * It does not escalate, delay an escalation, acknowledge anything, or meet an obligation. If it
 * fails, is refused, or was never switched on, the ladder climbs at exactly the same second.
 */
async function nudgePass(
  pool: Pool,
  options: ProactiveOptions,
  now: string,
  fetchImpl: typeof fetch,
): Promise<ProactiveOutcome> {
  // The district's own deadlines, not the constants in this build — Q-06. Loaded once per pass,
  // and a pass that cannot read them falls back rather than nudging nothing, which is
  // `runEscalationPass`'s own choice about the same table.
  const config: SlaConfig =
    options.targets !== undefined
      ? { district: options.targets, byDepartment: {} }
      : await loadSlaConfiguration(pool).catch(() => ({
          district: PLACEHOLDER_SLA,
          byDepartment: {},
        }));

  const limit = options.limit ?? 500;
  const today = { from: startOfDistrictDay(now), to: endOfDistrictDay(now) };
  const ids = await unacknowledgedInDay(pool, limit, today, options.incidentIds);

  let nudged = 0;
  let failed = 0;

  for (const incidentId of ids) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);
    if (state.severity === null || state.occurredAt === null || state.lastRecordedAt === null) {
      continue;
    }

    // A General communication never escalates (M9-10), so there is no ladder to warn anybody
    // about. The same set `board.ts` and `runEscalationPass` read, read from one place.
    if (!CARRIES_SLA.has(state.kind)) continue;

    const verdict = checkNudge(
      {
        severity: state.severity.value,
        occurredAt: state.occurredAt,
        recordedAt: state.lastRecordedAt,
        acknowledgedAt: state.acknowledgedAt,
        now,
      },
      targetsFor(config, state.responsibleDepartmentIds),
    );

    if (!verdict.shouldNudge) continue;

    /**
     * ⚠️ **Read from the incident's CURRENT status, exactly as `offerNextStages` reads it.** An
     * emergency a colleague resolved thirty seconds ago offers nothing, and this sends nothing at
     * all rather than a button that would refuse — *there is no such thing here as a control that
     * is present and refuses.*
     */
    const stages = stagesOfferedFrom(state.status);
    if (stages.length === 0) continue;

    const what = describe(state.category?.value ?? null, state.severity.value);

    for (const handset of await handsetsToldAbout(pool, incidentId)) {
      const outcome = await sendOnce(
        pool,
        options.config,
        { kind: 'nudge', subject: incidentId, phone: handset.phone },
        {
          toPhone: handset.phone,
          /**
           * **It says what happens next, and it says it as a fact rather than a threat.**
           *
           * The officer is not being told off; they are being told that in `n` minutes their
           * superior will be rung about this, which is information they can act on and currently
           * only ever learn afterwards from that superior. Naming the emergency matters because
           * this arrives in a thread that may hold several of the district's notices — the same
           * reason `askWhoIsComing` quotes the officer's own words back at them.
           */
          text:
            `Still waiting on an answer about ${what}.\n\n` +
            `If nothing is recorded in about ${String(verdict.minutesLeft)} minutes, ` +
            `the control room takes this to the office above yours.`,
          buttons: stages.map((stage) => ({
            id: stageButtonId(stage, incidentId, handset.attemptId),
            title: stageButtonWords(stage, state.kind),
          })),
        },
        fetchImpl,
      );

      if (outcome === 'sent') nudged += 1;
      if (outcome === 'failed') failed += 1;
    }
  }

  return { ...NOTHING, nudged, failed };
}

/**
 * **The closing word, to everybody who was told and did not do the closing.**
 *
 * ## Why the person who closed it is left out
 *
 * They have already been thanked, by name, in their own thread — `say()` does it in the same
 * breath as recording what they typed. A second *"this is closed"* seconds later reads as the
 * software having lost track, which is the opposite of what this message exists to establish.
 *
 * The exclusion is resolved from the **closing event's own actor**, through the roster, to a
 * number — never guessed from who replied last. A guess here would silence exactly one officer at
 * random on an emergency several people were sent to.
 *
 * ## Why it is bounded to a few hours
 *
 * Self-healing rather than fired at an instant, for `nightly.ts`'s reason: a district server gets
 * rebooted and is occasionally a laptop somebody closed. But a lookback of days would mean the
 * morning the flag is switched on opens with a burst of thank-yous for last week — officers
 * learning on day one that these messages are noise.
 */
async function closedPass(
  pool: Pool,
  options: ProactiveOptions,
  now: string,
  fetchImpl: typeof fetch,
): Promise<ProactiveOutcome> {
  const res = await pool.query<{ incident_id: string }>(
    `SELECT DISTINCT incident_id
       FROM incident_event
      WHERE type IN ('resolved', 'closed')
        AND recorded_at > $1::timestamptz - make_interval(hours => $2)
        AND ($4::uuid[] IS NULL OR incident_id = ANY($4::uuid[]))
      LIMIT $3`,
    [now, CLOSED_LOOKBACK_HOURS, options.limit ?? 500, options.incidentIds ?? null],
  );

  let closed = 0;
  let failed = 0;

  for (const { incident_id: incidentId } of res.rows) {
    const events = await loadIncident(pool, incidentId);
    if (events.length === 0) continue;

    const state = foldIncident(incidentId, events);
    // Only what somebody was called out to. A meeting notice that was never an obligation to
    // attend an emergency does not get a *"this is closed"*, which would be the district
    // announcing the end of something nobody was waiting on.
    if (!CARRIES_SLA.has(state.kind)) continue;

    // The last event that closed it, so the actor is the one who actually did the closing rather
    // than whoever happened to touch the incident first.
    const closer = [...events]
      .reverse()
      .find((e) => e.type === 'resolved' || e.type === 'closed')?.actorPersonId;
    const closerPhone =
      closer === null || closer === undefined ? null : await phoneOf(pool, closer);

    const what = describe(state.category?.value ?? null, state.severity?.value ?? null);

    for (const handset of await handsetsToldAbout(pool, incidentId)) {
      if (closerPhone !== null && handset.phone === closerPhone) continue;

      const outcome = await sendOnce(
        pool,
        options.config,
        { kind: 'closed', subject: incidentId, phone: handset.phone },
        {
          toPhone: handset.phone,
          /**
           * No buttons, deliberately. There is nothing left to record, and a control offered on a
           * finished emergency is one that exists only to refuse — the rule `offerNextStages`
           * holds and the acknowledge page holds before it.
           */
          text:
            `${capitalise(what)} is now closed. Nothing further is needed — ` +
            `thank you for your help.`,
        },
        fetchImpl,
      );

      if (outcome === 'sent') closed += 1;
      if (outcome === 'failed') failed += 1;
    }
  }

  return { ...NOTHING, closed, failed };
}

/**
 * **One summary a day for the administration, in the district's own numbers.**
 *
 * ## Why it reuses the morning report rather than counting anything itself
 *
 * `buildDailyReport` already writes the day's one sentence, and its own comment says why it lives
 * there: *"so the printed page, the CSV header and any later screen cannot each summarise the same
 * day differently."* A handset is a later screen. A count assembled here would be a fourth opinion
 * about the same day, and the one that arrives on the DC's phone before anybody has opened the
 * printed one.
 *
 * ## Why it is built per recipient, from that recipient's real identity
 *
 * `resolveIdentity` is asked for the officer this is being sent to, and the report is generated as
 * **theirs** — the same `evaluateRead` filter, the same scope line. Nothing is fabricated. What
 * lands on a handset is exactly what that officer would see on opening the report themselves,
 * which is the only way this message can be trusted enough to act on.
 *
 * ## Who counts as the administration
 *
 * `department.is_administration` — the DC Office and AC Headquarter Bajaur (ADR-0010, migration
 * 0007). ⚠️ **Deliberately that flag rather than a department code.** 0007 says in its own words
 * that the flag is not settable through the admin API and that changing it is a deliberate act at
 * the database: it is the only definition of *the administration* the schema itself maintains and
 * defends. A hardcoded `'deputy-commissioner-office'` would be a second definition, correct only
 * for the district whose contact list happened to produce that code, and silently sending nothing
 * anywhere else.
 *
 * ⚠️ **And the window still gates it.** An officer who has never sent this number anything has no
 * open window and gets no summary — which is the correct answer and the reason the first person to
 * receive one will be somebody who already talks to this system.
 */
async function summaryPass(
  pool: Pool,
  options: ProactiveOptions,
  now: string,
  fetchImpl: typeof fetch,
): Promise<ProactiveOutcome> {
  /**
   * The day that has **ended**, and the hour that releases it — both in Bajaur's clock.
   *
   * Never `now() - 1 day`: Bajaur is UTC+05:00, so rolling arithmetic crosses every midnight and
   * would file five hours of every evening under the wrong day. That is O-01, which was live on
   * this district's own board for a week.
   */
  const yesterday = districtDate(new Date(Date.parse(startOfDistrictDay(now)) - 1).toISOString());
  const hour = hourOfDistrictDay(now);
  if (hour < SUMMARY_HOUR) return NOTHING;

  const res = await pool.query<{ person_id: string; phone: string }>(
    `SELECT DISTINCT p.person_id, p.phone
       FROM duty_assignment a
       -- ADR-0030: the tick is on the SEAT now. It was on the department, and 0039 dropped
       -- that table — so this reads the one column somebody ticked, which is what ADR-0029
       -- section 2 asked for from the beginning. The rule is unchanged: the summary goes to
       -- BOTH administrative offices, never to a hardcoded department code, because that flag
       -- is the only definition of *the administration* the database itself maintains.
       JOIN seat s   ON s.seat_id = a.seat_id AND s.retired_at IS NULL AND s.is_administration
       JOIN person p ON p.person_id = a.person_id
      WHERE a.from_at <= now()
        AND (a.to_at IS NULL OR a.to_at > now())
        AND p.removed_at IS NULL
        AND p.disabled_at IS NULL
        -- A stand-in fills a post so the roster is complete (migration 0008). Sending to one
        -- reaches nobody, and numberFor refuses it for the same reason on the alert path.
        AND p.placeholder = false
        AND p.phone IS NOT NULL
        AND btrim(p.phone) <> ''`,
  );

  let summarised = 0;
  let failed = 0;

  for (const row of res.rows) {
    const phone = toE164(row.phone);

    // Asked before the report is built. Generating a day's report for a handset that cannot be
    // reached is a scan of the incident table per administrator per tick, for nothing.
    if (!(await sessionWindowOpen(pool, phone))) continue;

    const identity = await resolveIdentity(pool, row.person_id);
    if (identity === null || identity.seatId === null) continue;

    const built = await dailyReport(pool, identity, yesterday, new Date(now));
    if (!built.ok) {
      log('warn', 'could not build the day for a summary', { error: built.error });
      continue;
    }

    const { report } = built;
    const outstanding =
      report.outstanding.length === 0
        ? ''
        : `\n\n${String(report.outstanding.length)} emergency reports from earlier days are still unacknowledged.`;

    const outcome = await sendOnce(
      pool,
      options.config,
      { kind: 'summary', subject: yesterday, phone },
      {
        toPhone: phone,
        // The report's own sentence, verbatim. Rewording it here would be this file having an
        // opinion about a day it did not compute.
        text: `${report.scope} — ${yesterday}\n\n${report.summary}${outstanding}`,
      },
      fetchImpl,
    );

    if (outcome === 'sent') summarised += 1;
    if (outcome === 'failed') failed += 1;
  }

  return { ...NOTHING, summarised, failed };
}

/**
 * The emergency in as few words as a handset needs.
 *
 * Category and severity are both `Provenanced` and either may be absent — an unassessed report has
 * no severity by design (ADR-0009), and saying *"unknown"* on a handset would be the software
 * reporting its own gap to somebody who cannot fill it. So the words degrade rather than
 * apologise, and the fallback still names something real: *this emergency*.
 */
function describe(category: string | null, severity: string | null): string {
  const words = [category, severity].filter((w): w is string => w !== null && w.trim() !== '');
  return words.length === 0 ? 'this emergency' : `the ${words.join(' — ')} report`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The hour of the district's own day, 0–23.
 *
 * Derived from the district's midnight rather than read off a `Date` — the one clock, Phase 1. A
 * server whose system timezone is UTC would otherwise release the summary five hours early, which
 * on this feature means at 03:00 local.
 */
function hourOfDistrictDay(now: string): number {
  const since = Date.parse(now) - Date.parse(startOfDistrictDay(now));
  return Math.floor(since / 3_600_000);
}

/** One number, for the one officer who closed it. Null is ordinary — the console has no phone. */
async function phoneOf(pool: Pool, personId: string): Promise<string | null> {
  const res = await pool.query<{ phone: string | null }>(
    'SELECT phone FROM person WHERE person_id = $1 AND removed_at IS NULL',
    [personId],
  );
  const phone = res.rows[0]?.phone;
  return phone === null || phone === undefined || phone.trim() === '' ? null : toE164(phone);
}
