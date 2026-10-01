/**
 * Reporting the district's own condition — M4.
 *
 * Two facts the system did not previously hold:
 *
 *   * **Utilities** — is the power on, the water, the gas, the line?
 *   * **Presence** — is the AAC in his office, in the field, or on leave?
 *
 * The scoping follows the rule already established for the roster, and for the same stated
 * reason (owner, 2026-08-02): a department manages **its own** data, and nobody types on its
 * behalf. PESCO says whether PESCO is up. The AAC's office says where the AAC is. The two
 * administrative offices may do either for anyone, because somebody has to be able to correct
 * a department that has gone quiet — but they do it visibly, through the same recorded path.
 *
 * What a department may **not** do is decide which utilities the district watches. That is
 * configuration, and configuration belongs to the two offices for the same reason routing
 * signals do (ADR-0010): a department able to remove itself from the list could go quiet
 * without anybody seeing it happen.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { inTransaction, listDepartments, recordChange } from '../db/configStore.js';
import {
  addUtility,
  assignUtility,
  issueAlert,
  listFacts,
  listPresence,
  listUtilities,
  liveAlerts,
  reportPresence,
  renameUtility,
  reportUtility,
  retireUtility,
  holderOfSeat,
  seatExists,
  setFact,
  setSeatOnWall,
  setUtilityWindow,
  utilityExists,
  withdrawAlert,
  type AlertTag,
} from '../db/wallStore.js';
import { PRESENCE_STATUSES, type PresenceStatus, type UtilityStatus } from '../domain/wall.js';

const UTILITY_STATUSES: readonly string[] = ['normal', 'degraded', 'down'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALERT_TAGS: readonly string[] = ['vip', 'security', 'road', 'weather', 'other'];
/**
 * Which of the two boards a watched thing sits on — migration 0017's `utility.panel`.
 *
 * `utility` is the power, the water, the gas; `services` is the bazaar, the schools, the
 * hospital, the roads. One table because they are the same shape — somebody with authority
 * states a condition and it is stamped — and two panels because a control room reads them as
 * two different questions.
 *
 * ⚠️ **This has been on the table since August and no route could set it.** `addUtility` has
 * taken it all along and `/status/utilities` never passed it, so everything created through the
 * product landed on `utility` (the column default) and District services could only ever hold
 * what migration 0017 seeded. That is the half of "add a service" that was missing.
 */
const UTILITY_PANELS: readonly string[] = ['utility', 'services'];

/**
 * A district fact is keyed by a word, not a uuid, and `config_event.subject_id` is a uuid
 * column. One fixed id stands for "the district status board" so the change still lands in
 * the log people read — the key itself is in the payload, where it can be seen.
 */
const FACT_SUBJECT = '00000000-0000-0000-0000-000000000001';

/** Free text that reaches a wall four metres away. Long enough to be useful, short enough to read. */
const MAX_NOTE = 120;

/**
 * What the district is told when it asks for an impossible window — M10-03.
 *
 * **One sentence, one place.** Two doors now set `stale_minutes` — creating a service and
 * changing an existing one — and the refusal an operator reads must be the same words from both,
 * or the district learns two different rules for one column.
 */
const WINDOW_REFUSAL = 'a report stays believable between 5 minutes and a week';

/**
 * A staleness window, or null if it is not one.
 *
 * The bounds match migration 0015's own `CHECK (stale_minutes BETWEEN 5 AND 10080)`, deliberately.
 * The database is the floor and this is the message: without the check here the district gets a
 * 500 and a constraint name, which tells an operator nothing they can act on.
 *
 * **Rounded here rather than at each call site**, so a caller cannot store a fractional minute the
 * column would reject on one path and accept on another.
 */
function staleWindow(value: unknown): number | null {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10_080) return null;

  return Math.round(minutes);
}

export interface StatusReply {
  readonly status: number;
  readonly body: unknown;
}

function bad(status: number, error: string): StatusReply {
  return { status, body: { error } };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/**
 * Who may speak for a department.
 *
 * The administration may speak for anyone. Anybody else may speak only for their own
 * department — and a caller with no department at all (a control-room seat, a district post
 * outside the two offices) may speak for nobody, which is correct: they have no department
 * whose condition they could report.
 */
function mayReportFor(identity: Identity): boolean {
  if (identity.isAdministration) return true;

  /**
   * 🔴 **A department no longer speaks for itself — 2026-08-22, the district's decision.**
   *
   * This returned true when the caller's own department matched. The district removed the
   * concept: *"mujhe yeh concept hi nahi chahiye ke department khud kuch kar sake app ke andar."*
   * The two offices report on everybody's behalf, which is what they were already doing — no
   * department has ever held an account on this installation.
   */
  return false;
}

export async function handleStatus(
  pool: Pool,
  req: IncomingMessage,
  path: string,
  identity: Identity,
  body: Record<string, unknown> | null,
): Promise<StatusReply> {
  const method = req.method ?? 'GET';

  //--------------------------------------------------------------------------------
  // Reading
  //--------------------------------------------------------------------------------

  if (method === 'GET' && path === '/status') {
    // Everyone signed in sees the whole picture. There is nothing private in it — it is the
    // same aggregate a television shows — and a department that cannot see whether the power
    // is out cannot plan around it.
    const [utilities, presence, facts, alerts, departments] = await Promise.all([
      listUtilities(pool),
      listPresence(pool, identity.isAdministration ? null : identity.departmentId),
      listFacts(pool),
      liveAlerts(pool, 20),
      // Only the two offices assign a service to a department, so only they need the list.
      identity.isAdministration ? listDepartments(pool) : Promise.resolve([]),
    ]);

    return {
      status: 200,
      body: {
        utilities,
        presence,
        facts,
        alerts,
        departments: departments
          .filter((d) => d.retiredAt === null)
          .map((d) => ({ departmentId: d.departmentId, name: d.name })),
        // What this caller is allowed to change, so the screen renders the right controls
        // rather than offering buttons that will be refused.
        canConfigure: identity.isAdministration,
        departmentId: identity.departmentId,
      },
    };
  }

  //--------------------------------------------------------------------------------
  // Reporting a utility
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/utility') {
    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    const status = body?.['status'];

    if (!UUID_RE.test(utilityId)) return bad(400, 'which utility?');
    if (typeof status !== 'string' || !UTILITY_STATUSES.includes(status)) {
      return bad(400, 'status must be normal, degraded or down');
    }

    // ⚠️ Gate first, lookup second — see the note on the presence route above. And the
    // refusal no longer names a department as the thing that entitles somebody: since
    // 2026-08-22 no department answers for anything, so saying so would be a false reason.
    if (!mayReportFor(identity)) {
      return bad(403, 'only the control room reports a utility');
    }

    if (!(await utilityExists(pool, utilityId))) return bad(404, 'no such utility');

    await reportUtility(pool, {
      utilityId,
      status: status as UtilityStatus,
      note: text(body?.['note'], MAX_NOTE),
      reportedBy: identity.seatId,
    });

    return { status: 201, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Reporting presence
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/presence') {
    const seatId = typeof body?.['seatId'] === 'string' ? body['seatId'] : '';
    const status = body?.['status'];

    if (!UUID_RE.test(seatId)) return bad(400, 'which seat?');
    if (typeof status !== 'string' || !(PRESENCE_STATUSES as readonly string[]).includes(status)) {
      return bad(400, `status must be one of ${PRESENCE_STATUSES.join(', ')}`);
    }

    /**
     * ⚠️ **THE GATE MOVED ABOVE THE LOOKUP — the other half of the ADR-0030 repair.**
     *
     * The lookup came first, so a caller with no authority to report presence for anybody was
     * told *no such seat* — honest to a stranger, and wrong: their real problem is that they may
     * not do this at all, whatever seat they named. INV-05 puts the refusal on the real reason.
     * It also stops this route confirming which seat ids exist to a caller who may not use them.
     */
    if (!mayReportFor(identity)) {
      return bad(403, 'only the control room sets presence');
    }

    if (!(await seatExists(pool, seatId))) return bad(404, 'no such seat');

    // ADR-0033: two states, set by hand. No end to state, no timer — nothing polls an officer,
    // so `NEEDS_END` is gone and there is nothing to validate a time against.
    await reportPresence(pool, {
      seatId,
      status: status as PresenceStatus,
      note: text(body?.['note'], MAX_NOTE),
      reportedBy: identity.seatId,
      /**
       * Whose availability this is — M9-32. Resolved from the post **now**, at the moment the
       * report is made, and then frozen onto the row: a handover tomorrow must not silently
       * re-point yesterday's answer at whoever inherits the desk.
       */
      personId: await holderOfSeat(pool, seatId),
    });

    return { status: 201, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Which officers show on the Dashboard wall — the control room's curated pick (ADR-0033)
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/presence/wall') {
    const seatId = typeof body?.['seatId'] === 'string' ? body['seatId'] : '';
    const onWall = body?.['onWall'];

    if (!UUID_RE.test(seatId)) return bad(400, 'which seat?');
    if (typeof onWall !== 'boolean') return bad(400, 'onWall must be true or false');

    // Same gate as reporting presence — the wall pick is the control room's, INV-05 on the
    // real reason before the seat is confirmed to exist.
    if (!mayReportFor(identity)) {
      return bad(403, 'only the control room sets the wall');
    }

    if (!(await seatExists(pool, seatId))) return bad(404, 'no such seat');

    await setSeatOnWall(pool, seatId, onWall);

    return { status: 201, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Which utilities the district watches — configuration, so the two offices only
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/utilities') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const name = text(body?.['name'], 60);
    if (name === null) return bad(400, 'a utility needs a name');

    const departmentId = typeof body?.['departmentId'] === 'string' ? body['departmentId'] : null;
    if (departmentId !== null && !UUID_RE.test(departmentId)) return bad(400, 'which department?');

    const stale = staleWindow(body?.['staleMinutes'] ?? 240);
    if (stale === null) return bad(400, WINDOW_REFUSAL);

    // Which board it goes on. Defaulted rather than required, so every caller written before
    // this parameter existed keeps landing where it always landed.
    const panelRaw = body?.['panel'] ?? 'utility';
    if (typeof panelRaw !== 'string' || !UTILITY_PANELS.includes(panelRaw)) {
      return bad(400, 'a service sits on either the utilities panel or the services panel');
    }
    const panel = panelRaw as 'utility' | 'services';

    const utilityId = await addUtility(pool, {
      name,
      departmentId,
      panel,
      staleMinutes: stale,
    });

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'created',
        before: null,
        // The name and who answers for it. Never a number: config_event is rendered on a
        // screen and copied into every backup that leaves the district.
        after: { name, departmentId, panel, staleMinutes: stale },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'added to the district status board',
      }),
    );

    return { status: 201, body: { utilityId } };
  }

  if (method === 'POST' && path === '/status/utilities/assign') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    if (!UUID_RE.test(utilityId)) return bad(400, 'which service?');

    // An empty department means "nobody yet", which is a legitimate answer — the district may
    // be watching something it has not yet decided who answers for.
    const raw = body?.['departmentId'];
    const departmentId = typeof raw === 'string' && raw !== '' ? raw : null;
    if (departmentId !== null && !UUID_RE.test(departmentId)) return bad(400, 'which department?');

    if (!(await assignUtility(pool, { utilityId, departmentId }))) {
      return bad(404, 'no such service');
    }

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'updated',
        before: null,
        after: { departmentId },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'assigned an answerable department',
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  /**
   * How long a report on this service stays believable — M10-03.
   *
   * **The district asked for this by reporting a symptom.** They type *"8 hours loadshedding"*
   * and the reading went stale after four, because Electricity has carried migration 0015's
   * install default of 240 since the day it was seeded and **nothing in the product could change
   * it**. An eight-hour schedule measured against a four-hour window is stale by construction,
   * every day, no matter how diligently anybody reports.
   *
   * ⚠️ **Administration only, and that is not this route copying its neighbours.** It is the same
   * argument this file's own header makes about which utilities the district watches: a
   * department that could quietly widen its own window to a week would **never appear as "not
   * reporting" again**, and could go silent with nothing on any screen showing it happen. That is
   * the identical failure as removing itself from the list, arriving through a subtler door — a
   * department reports its condition, it does not decide how long its silence stays invisible.
   *
   * The window is **configuration**, so it lands in the config log like every other configuration
   * change (ADR-0001 applied to settings): a table holding only today's value cannot answer *why
   * was this not flagged stale in October?* six weeks later, and this is exactly the column that
   * question would be about.
   */
  if (method === 'POST' && path === '/status/utilities/window') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    if (!UUID_RE.test(utilityId)) return bad(400, 'which service?');

    // No default here, unlike creation. Creating a service without saying is answered by the
    // install default; *changing* one without saying is a caller that has lost track of what it
    // is asking for, and silently writing 240 over the district's own choice is the worse answer.
    const minutes = staleWindow(body?.['staleMinutes']);
    if (minutes === null) return bad(400, WINDOW_REFUSAL);

    if (!(await setUtilityWindow(pool, { utilityId, staleMinutes: minutes }))) {
      return bad(404, 'no such service');
    }

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'updated',
        before: null,
        after: { staleMinutes: minutes },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'changed how long a report stays believable',
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  /**
   * Rename a service the district watches — the Status screen's **Rename** control.
   *
   * **Administration only, for the reason this file's header already gives.** A name is what every
   * other screen calls the thing: the wall panel, the daily report, the config log. A department
   * able to rename its own row could turn *"Electricity"* into something nobody scans for and be
   * absent from the board without ever going quiet — the same failure as removing itself from the
   * list, through the same subtler door `/status/utilities/window` describes.
   *
   * **The old name is in the log, not just the new one.** `before` is the whole value of this
   * entry: *"Electricity → PESCO Bajaur"* answers a question six weeks later that *"renamed to
   * PESCO Bajaur"* cannot, because by then nothing on any screen still says what it used to be.
   */
  if (method === 'POST' && path === '/status/utilities/rename') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    if (!UUID_RE.test(utilityId)) return bad(400, 'which service?');

    const name = text(body?.['name'], 60);
    if (name === null) return bad(400, 'a service cannot be renamed to nothing');

    const renamed = await renameUtility(pool, { utilityId, name });
    if (renamed === null) return bad(404, 'no such service');

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'updated',
        before: { name: renamed.before },
        after: { name },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'renamed on the district status board',
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  if (method === 'POST' && path === '/status/utilities/retire') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const utilityId = typeof body?.['utilityId'] === 'string' ? body['utilityId'] : '';
    if (!UUID_RE.test(utilityId)) return bad(400, 'which utility?');

    const reason = text(body?.['reason'], MAX_NOTE);
    if (reason === null) return bad(400, 'say why');

    if (!(await retireUtility(pool, utilityId))) return bad(404, 'no such utility');

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'utility',
        subjectId: utilityId,
        action: 'retired',
        before: null,
        after: null,
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason,
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // Alerts and advisories — the two offices issue them
  //--------------------------------------------------------------------------------
  //
  // Owner, 2026-08-03: only the DC and AC Headquarter offices. A district-wide advisory is an
  // administrative announcement that every department reads and plans around; a board any
  // department could post to is a board nobody can trust.

  if (method === 'POST' && path === '/status/alerts') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const tag = body?.['tag'];
    if (typeof tag !== 'string' || !ALERT_TAGS.includes(tag)) {
      return bad(400, 'tag must be vip, security, road, weather or other');
    }

    const message = text(body?.['message'], 200);
    if (message === null || message.length < 3) return bad(400, 'say what the advisory is');

    /**
     * An advisory must state when it stops mattering.
     *
     * Without this, the road reopens and the notice stays up for eleven months until it is
     * furniture nobody reads. Requiring an end means the board empties itself rather than
     * relying on somebody remembering to tidy it.
     */
    const until = text(body?.['untilAt'], 40);
    if (until === null) return bad(400, 'say when this advisory ends');

    const ends = new Date(until).getTime();
    if (Number.isNaN(ends)) return bad(400, 'that is not a time');
    if (ends <= Date.now()) return bad(400, 'that time has already passed');

    const alertId = await issueAlert(pool, {
      tag: tag as AlertTag,
      message,
      untilAt: until,
      issuedBy: identity.seatId,
    });

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'district_alert',
        subjectId: alertId,
        action: 'created',
        before: null,
        after: { tag, message, untilAt: until },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: 'issued to the district',
      }),
    );

    return { status: 201, body: { alertId } };
  }

  if (method === 'POST' && path === '/status/alerts/withdraw') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const alertId = typeof body?.['alertId'] === 'string' ? body['alertId'] : '';
    if (!UUID_RE.test(alertId)) return bad(400, 'which advisory?');

    const reason = text(body?.['reason'], MAX_NOTE);
    if (reason === null) return bad(400, 'say why');

    // Withdrawn, never deleted. "We told the district the road was shut" is a thing somebody
    // may have to answer for (ADR-0001).
    if (!(await withdrawAlert(pool, { alertId, reason }))) {
      return bad(404, 'no such advisory, or it is already withdrawn');
    }

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'district_alert',
        subjectId: alertId,
        action: 'retired',
        before: null,
        after: null,
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason,
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  //--------------------------------------------------------------------------------
  // The district's standing facts
  //--------------------------------------------------------------------------------

  if (method === 'POST' && path === '/status/facts') {
    if (!identity.isAdministration) return bad(403, 'only the DC or AC Headquarter office');

    const key = text(body?.['key'], 40);
    if (key === null) return bad(400, 'which fact?');

    // Free text, and empty clears it back to "not supplied" rather than storing a blank that
    // renders as a value nobody typed.
    const value = text(body?.['value'], 60);

    if (!(await setFact(pool, { key, value, seatId: identity.seatId }))) {
      return bad(404, 'no such fact');
    }

    await inTransaction(pool, (tx) =>
      recordChange(tx, {
        subject: 'district_fact',
        subjectId: FACT_SUBJECT,
        action: 'updated',
        before: null,
        after: { key, value },
        actor: { seatId: identity.seatId, personId: identity.personId },
        reason: text(body?.['reason'], MAX_NOTE) ?? 'district status board',
      }),
    );

    return { status: 200, body: { ok: true } };
  }

  return bad(404, 'no such endpoint');
}

export function writeStatus(res: ServerResponse, reply: StatusReply): void {
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
