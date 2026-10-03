import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { append, currentCursor, loadIncident, loadSince } from '../db/eventStore.js';
import { onBoardChange } from '../db/boardStream.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import {
  changeOwnPassword,
  login,
  resolveSession as resolveAnySession,
  revokeSession,
  SESSION_TTL_HOURS,
  type Identity,
} from '../auth/sessions.js';
import { validateBatch, type PullResponse, type PushResponse } from './protocol.js';
import {
  applyCommand,
  intake,
  isSeverity,
  readIncident,
  seatOf,
  type Command,
  type CommandKind,
} from './lifecycle.js';
import { dispatchTo, recordContactOpened } from './dispatch.js';
import { escalateByHand } from './escalate.js';
import { followUp } from './followUp.js';
import { recordAcknowledgement } from './acknowledgement.js';
import { loadCapabilities } from '../db/configStore.js';
import { notifyNow } from '../jobs/scheduler.js';
import type { NotificationChannel } from '../jobs/notify.js';
import { messageFor, whatsappChannel } from '../jobs/whatsappChannel.js';
import { foldIncident } from '../domain/incident.js';
import { buildBoard, BOARD_SORTS, parseSort } from './board.js';
import { districtDate, startOfNamedDistrictDay } from '../domain/districtTime.js';
import {
  isRecordDateAvailable,
  recordDateRange,
  recordWindowLookbackDays,
} from '../domain/recordWindow.js';
import { buildExport, buildPerformanceExport, EXPORT_LIMIT } from './exportCsv.js';
import { search } from './search.js';
import { districtSummaryFor } from './summary.js';
import { LoginThrottle, sleep, sourceAddress, withScryptSlot } from '../auth/throttle.js';
import type { WhatsAppConfig } from '../ops/whatsapp.js';
import {
  ackPage,
  applyAvailability,
  applyStage,
  filePage,
  fileReadyPage,
  handleWhatsAppWebhook,
  OPENS_IN_PLACE,
  applyResponse,
  redeemAck,
  verifyWebhookSubscription,
  viewAvailability,
  viewResponse,
  viewStage,
} from './webhooks.js';
import { peekAckToken } from '../db/whatsappStore.js';
import {
  configHistory,
  departmentsForConsole,
  setTarget,
  slaForConsole,
  integrity,
  type AdminResult,
} from './admin.js';
import {
  acknowledgementCsv,
  acknowledgementReport,
  parseRange,
  resolutionCsv,
  resolutionReport,
  type AcknowledgementRow,
  type ResolutionRow,
} from './reports.js';
import {
  accessLog,
  clearOverride,
  createAccount,
  grantLogin,
  sendSignInLink,
  dashboardLayout,
  forceLogout,
  installationCapabilities,
  listAccounts,
  reactivateAccount,
  removeAccount,
  resetPassword,
  securityPolicy,
  setAccountRole,
  setDashboardLayout,
  setOverride,
  suspendAccount,
  toggleCapability,
  type SettingsResult,
} from './settings.js';
import type { LinkDeps } from './loginLinks.js';
import { peekLoginLink, redeemLoginLink } from '../auth/loginLink.js';
import { dailyCsv, dailyHtml, dailyReport } from './dailyReport.js';
import {
  groupsForConsole,
  retireGroupForConsole,
  saveGroupForConsole,
  suggestedGroupsForConsole,
} from './groups.js';
import { districtPerformance } from './performance.js';
import {
  addPost,
  addRosterPerson,
  assign,
  editPost,
  editRosterPerson,
  grantRosterAccount,
  readRoster,
  relieve,
  removeRosterPerson,
  retirePost,
  // ADR-0029 — the district's own phone book, under `/roster/contacts`.
  addContact,
  deleteContact,
  editContact,
  readContacts,
  setAdministration,
} from './roster.js';
import {
  addResource,
  crew,
  dispatch,
  editResource,
  readFleet,
  release,
  retireResource,
  serviceState,
} from './resources.js';
import { download, listEvidence, upload } from './evidenceRoutes.js';
import { postIncidentReport } from './report.js';
import { backupNow, backupsForConsole } from './backups.js';
import { handleDashboard, writeDashboard } from './dashboard.js';
import { handleStatus, writeStatus } from './status.js';
import { handleContacts, writeContacts } from './contacts.js';
import { defaultEvidenceRoot, fetch as fetchEvidence, listFor } from '../ops/evidence.js';
import { peekFileToken, redeemFileToken } from '../db/fileTokenStore.js';
import { backupHealth } from '../ops/backup.js';
import { replicationHealthSafe } from '../ops/replication.js';
import type { Nightly } from '../jobs/nightly.js';
import { correlationIdFrom, log, withContext } from '../obs/log.js';
import {
  addPhoto,
  changeDate,
  createPost,
  createUnit,
  defaultActivitiesRoot,
  deletePost,
  giveOfficerLogin,
  listOfficers,
  listPeople,
  listPosts,
  listUnits,
  me as activitiesMe,
  moderatePost,
  readLog as readActivitiesLog,
  expiring as activitiesExpiring,
  downloadExpiring as downloadExpiringActivities,
  renameUnit,
  retireUnit,
  receiveChunk,
  serveMedia,
  setDefaultUnit,
  setOfficerActivities,
  startVideo,
  uploadState,
  type ActivitiesResult,
} from './activities.js';
import {
  addToDirectory,
  approvePending,
  listPending,
  rejectPending,
  senderTeller,
  servePendingMedia,
  type WhatsAppActivities,
} from './whatsappActivities.js';

/**
 * The sync server. Plain `node:http`, no framework — see ADR-0007.
 *
 * Two endpoints carry the whole offline story: push a batch the device has been holding,
 * and pull whatever the device has missed. Everything else in the product is built on top
 * of these two.
 */

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type AuthMode = 'stub' | 'session';

export interface ServerOptions {
  readonly pool: Pool;
  /**
   * `stub` accepts any caller and is for local development only. Startup refuses it
   * outside development — see `assertAuthUsable`.
   */
  readonly authMode?: AuthMode;
  readonly nodeEnv?: string;
  /** Directory of built web assets. When absent, the server is API-only. */
  readonly webRoot?: string;
  /**
   * Where evidence files are written (M1-05).
   *
   * Outside the web root, always — a directory the server serves statically is a directory
   * where an uploaded file becomes a URL somebody's browser will open.
   */
  readonly evidenceRoot?: string;
  /** Where Activities photos and videos are written (ADR-0039). Outside the web root. */
  readonly activitiesRoot?: string;
  /**
   * Called when the last byte of an Activities video arrives, so the converter starts now rather
   * than at its next timed pass (`jobs/activitiesVideo.ts`). Absent: the timed pass finds it.
   */
  readonly onVideoUploaded?: () => void;
  /**
   * WhatsApp → Activities (ADR-0040): photos and videos sent to the district's number become
   * Activities. Off unless set — `main.ts` sets it unless `WHATSAPP_ACTIVITIES=off`. Off, every
   * photo and video takes the evidence path exactly as before. The Pending list works either way.
   */
  readonly activitiesFromWhatsApp?: boolean;
  /**
   * Whether Bajaur's media bucket is set up (ADR-0039 §8), for the DC's warning to say so.
   * Absent means not set up — the honest default.
   */
  readonly activitiesBackup?: { readonly configured: boolean; readonly why: string | null };
  /** Where dumps are written, so the console can list what is actually on disk (M0-55). */
  readonly backupDirectory?: string;
  /**
   * The nightly backup job, when this process is running one.
   *
   * Passed in rather than constructed here: the server should not decide whether the district
   * takes backups, and a test server that quietly started a `pg_dump` loop would be a
   * surprise nobody asked for.
   */
  readonly nightly?: Nightly | null;
  /**
   * The district's WhatsApp account, when it has one — ADR-0014, M6-18.
   *
   * Null is the normal state until R-05, R-19 and R-20 are done, and the product is complete
   * without it: obligations are recorded, the inbox works, and "Reach them" is there. The two
   * routes it enables — `/webhooks/whatsapp` and `/ack/:token` — answer 404 while it is null,
   * because an endpoint that half-works is worse than one that is honestly absent.
   */
  readonly whatsapp?: WhatsAppConfig | null;
  /**
   * How `/webhooks/whatsapp` sends its follow-up question — Phase B.
   *
   * ⚠️ **Overridden by tests. Never by configuration**, exactly like `WhatsAppConfig.baseUrl`.
   * That route answers back now — a tap on *"Sending someone"* is replied to inside the
   * officer's own thread — so it needs a way out, and a suite that did not stub it would reach
   * for the real network from inside a webhook handler.
   *
   * This is the same seam `whatsappChannel` has taken since M6-18. It is a **second** one rather
   * than a reuse because the two send at different moments for different reasons: the channel
   * sends a template on the notify pass, this sends free text on an inbound.
   */
  readonly whatsappFetch?: typeof fetch;
  /**
   * The origin officers' handsets can actually reach — ADR-0017.
   *
   * Needed here as well as in the scheduler, because a dispatch notifies **immediately** rather
   * than waiting for the next tick (M6-04) — and that pass builds the acknowledge links.
   */
  readonly publicOrigin?: string;
  /**
   * The built WhatsApp channel, overriding the one this server would construct.
   *
   * Injectable for the same reason `SchedulerOptions.channel` is: a test needs a provider that
   * answers on demand rather than one that reaches out to Meta. **Never for configuration** —
   * there is one channel and no ladder, and a second one supplied here would be a ladder built
   * by an options object.
   */
  readonly whatsappChannel?: NotificationChannel;
  /**
   * Trusted reverse-proxy addresses, for `X-Forwarded-For` — M6-37, ADR-0017.
   *
   * **Empty is the safe default and must stay the default.** See `sourceAddress`.
   */
  readonly trustedProxies?: readonly string[];
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  /**
   * The Urdu face — 2026-08-19.
   *
   * It loaded perfectly well as `application/octet-stream`, because `format('woff2')` in the
   * `@font-face` is what the browser actually believes. Named properly anyway: the fallback is
   * a shrug, and the next reader of this map should not have to work out whether the district's
   * one typeface is arriving by luck.
   */
  '.woff2': 'font/woff2',
};

/**
 * Serve a built asset.
 *
 * `sw.js` is served with `Cache-Control: no-cache` on purpose. If the browser were allowed
 * to cache the service worker itself, a broken one could become unreplaceable — the very
 * component responsible for offline behaviour would be the one you could not fix.
 */
async function serveStatic(
  webRoot: string,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  // Refuse anything that escapes the web root. `..` in a URL is not a mistake to forgive.
  const target = normalize(join(webRoot, rel));
  if (!target.startsWith(normalize(webRoot) + sep) && target !== normalize(webRoot)) {
    res.writeHead(403).end();
    return true;
  }

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return false;
  }

  const ext = extname(target);
  const isServiceWorker = rel === 'sw.js';

  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': isServiceWorker ? 'no-cache' : 'no-cache',
    // The service worker must be able to control the whole origin, not just /assets.
    ...(isServiceWorker ? { 'service-worker-allowed': '/' } : {}),
  });
  res.end(body);
  return true;
}

/**
 * Refuse to start with development authentication outside development.
 *
 * This exists because "shipped with the auth stub still in place" is a routine way for
 * systems like this to be compromised, and a comment does not prevent it. INV-05 says the
 * UI is never the enforcement layer; this says the same about a developer's memory.
 */
export function assertAuthUsable(authMode: AuthMode, nodeEnv: string): void {
  if (authMode === 'stub' && nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(
      `Refusing to start: authMode="stub" is development-only and NODE_ENV="${nodeEnv}". ` +
        'Real authentication landed in M0-19 — pass authMode: "session".',
    );
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * Once: authenticated but holding no post meant *look at nothing, do nothing*, because
 * authority came from the seat alone (ADR-0004) and every account was an officer's. The gap it
 * closed was the M5 leak — "no seat" and "a seat with no department" both arrived as a null
 * department, and a relieved officer was handed the district view instead of nothing.
 *
 * That world is gone. **ADR-0018 / ADR-0024** leave the control room as the only thing that
 * signs in; **ADR-0030 / ADR-0031** remove departments, so there is nothing to leak between
 * and one read scope left (*the district*); **ADR-0032** mints accounts by `role`, with no
 * seat. Every authenticated caller here is a control-room account, and `seatOf` gives a
 * seatless one a district-tier seat to act as. So this no longer refuses anybody — it is kept
 * only so the call sites do not have to change, and as the one place to re-tighten if account
 * types ever diverge again.
 *
 * Returns false having already answered the request; today it never does.
 */
function requireSeat(res: ServerResponse, identity: Identity): boolean {
  // ADR-0038: account types diverged again. A `member` never reaches here — the gated
  // `resolveSession` below refuses it first — but this was named the place to re-tighten, so
  // it refuses too, rather than relying on a check somewhere else.
  if (identity.role === 'member') {
    json(res, 403, { error: MEMBER_REFUSED });
    return false;
  }
  return true;
}

/**
 * ADR-0038 — the one gate that keeps a `member` out of the control room.
 *
 * A member is an officer who signs in for Activities only. Every operational route in this
 * file authenticates its caller through `resolveSession`, and this one refuses a member by
 * throwing `MemberRefused`, which the request handler answers with 403. So the gate is **deny
 * by default**: a route added later is closed to members without anybody remembering to close
 * it. The few routes a member may use — `/auth/me`, and Activities — call `resolveAnySession`
 * on purpose, and a test pins that list (`memberGate.test.ts`).
 */
const MEMBER_REFUSED = 'this account may use Activities only';

class MemberRefused extends Error {}

async function resolveSession(pool: Pool, token: string): Promise<Identity | null> {
  const identity = await resolveAnySession(pool, token);
  if (identity?.role === 'member') throw new MemberRefused(MEMBER_REFUSED);
  return identity;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const SESSION_COOKIE = 'dnc_bajaur_session';

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * The credential, in order of preference.
 *
 * The cookie is the browser path. The `Authorization: Bearer` header exists for the SMS
 * gateway and any future non-browser client, and because an auth model that can only be
 * exercised through a browser cannot be tested from outside the UI — which is precisely
 * what INV-05 requires.
 */
function readToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth !== undefined && auth.startsWith('Bearer ')) return auth.slice(7);
  return readCookie(req, SESSION_COOKIE);
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Accept a batch a device has been holding.
 *
 * The response names every event the server now holds, whether it was appended just now
 * or was already present. That distinction does not matter to the client — what matters is
 * that it can safely stop holding them. Anything absent from `accepted` stays queued.
 */
async function handlePush(
  pool: Pool,
  res: ServerResponse,
  raw: string,
  identity: Identity,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'invalid json' });
    return;
  }

  const body = parsed as { events?: unknown };
  if (!Array.isArray(body.events)) {
    json(res, 400, { error: 'events must be an array' });
    return;
  }

  const { valid, rejected } = validateBatch(body.events);

  // Identity is stamped from the session, never taken from the payload.
  //
  // Without this, any authenticated user could submit an event claiming to be the DC seat,
  // and the audit trail — which is the whole record (ADR-0001) — would faithfully preserve
  // the lie. Whatever the client sent in `actorPersonId` / `actorSeatId` is discarded.
  // Same principle as `recorded_at`: facts the client is not entitled to assert are
  // assigned by the server.
  const attributed = valid.map((e) => ({
    ...e,
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
  }));

  // recorded_at is assigned by the database, never by the caller. A device with a wrong
  // clock can misreport when something happened; it must not be able to misreport when we
  // learned of it, because escalation timing depends on that.
  const toStore = attributed as unknown as readonly IncidentEvent[];
  const result = await append(pool, toStore);

  // Nothing is routed here any more — ADR-0022.
  //
  // An automatic pass used to run on every report that arrived through `/sync`, because the
  // field path does not go through `POST /incidents` and emergencies captured on a handset
  // were otherwise reaching nobody. That hole is closed differently now: there is no
  // automatic pass on either path, both leave the incident unheld, and it appears in the
  // control room's queue of things to assign. One rule, one place, for both journeys.

  const response: PushResponse = {
    accepted: valid.map((e) => e.eventId),
    rejected,
    appended: result.appended,
    duplicates: result.duplicates,
    cursor: await currentCursor(pool),
  };

  json(res, 200, response);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMAND_PATHS: Readonly<Record<string, CommandKind>> = {
  triage: 'triage',
  route: 'route',
  acknowledge: 'acknowledge',
  actions: 'log_action',
  reassign: 'reassign',
  override: 'override',
  resolve: 'resolve',
  close: 'close',
  // "correct", never "delete" or "withdraw" — M9-52/53. The path is read by whoever is
  // debugging at 02:00 as well as by the client.
  correct: 'correct',
  /**
   * M10-11/18, and these two are **not** the sibling of `correct` they look like.
   *
   * `correct` answers *is what we said still true*; these answer *should this still be on the
   * screen*. Both append and neither erases — there is no `delete` here and there cannot be
   * one, because `eventStore.ts` has no delete method (ADR-0001).
   */
  withdraw: 'withdraw',
  restore: 'restore',
  /**
   * The district's five, 2026-08-22 — and a third question, not a synonym for the two above.
   *
   * `withdraw` takes a row off the board entirely. **These decide whether a row survives the
   * daily reset**, which is a thing you do to something you are still watching. The words are
   * the district's own: a meeting *"rahegi till its done"*, and this is what holds it there.
   */
  hold: 'hold',
  release: 'release',
  /**
   * The meeting moved — and the path is `reschedule`, never `correct` and never `resolve`.
   *
   * Whoever is reading a journal at 02:00 sees which of the three happened, and the three are
   * genuinely different facts: *we sent the wrong date*, *the date moved*, *the meeting is over*.
   */
  reschedule: 'reschedule',
};

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function departmentIds(v: unknown): readonly string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((d): d is string => typeof d === 'string' && UUID_RE.test(d))) return null;
  return v;
}

/**
 * Body to command, or a reason it is not one.
 *
 * Strict, unlike intake and unlike a sync payload. These are operator actions taken against
 * a system that is answering them: a reassignment missing its reason has to be refused
 * loudly, because accepting it would put an unexplained change into the record — and the
 * record is the whole point (ADR-0001, INV-06).
 */
function parseCommand(kind: CommandKind, body: Record<string, unknown>): Command | string {
  switch (kind) {
    case 'triage': {
      if (!isSeverity(body['severity'])) return 'severity must be low, moderate, high or critical';
      if (!nonEmpty(body['category'])) return 'category is required';
      return {
        kind,
        severity: body['severity'],
        category: body['category'].trim(),
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };
    }

    case 'route':
    case 'reassign': {
      const ids = departmentIds(body['departmentIds']);
      if (ids === null) return 'departmentIds must be a non-empty array of uuids';
      if (!nonEmpty(body['reason'])) return 'reason is required';
      return { kind, departmentIds: ids, reason: body['reason'].trim() };
    }

    case 'acknowledge':
      return {
        kind,
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };

    case 'log_action': {
      if (!nonEmpty(body['note'])) return 'note is required';

      // A stated time is accepted only if it parses and is not in the future. A clock skewed
      // forward would otherwise let an action be logged as having happened after the
      // incident closed, and the timeline would read as nonsense to whoever reviews it.
      const stated = body['occurredAt'];
      const when =
        typeof stated === 'string' && Number.isFinite(Date.parse(stated))
          ? new Date(stated).toISOString()
          : null;

      return {
        kind,
        note: body['note'].trim(),
        ...(when !== null && when <= new Date().toISOString() ? { occurredAt: when } : {}),
      };
    }

    case 'override': {
      const field = body['field'];
      if (field !== 'severity' && field !== 'category') {
        return "field must be 'severity' or 'category'";
      }
      if (!nonEmpty(body['value'])) return 'value is required';
      if (field === 'severity' && !isSeverity(body['value'])) {
        return 'severity must be low, moderate, high or critical';
      }
      if (!nonEmpty(body['reason'])) return 'reason is required';
      return { kind, field, value: body['value'].trim(), reason: body['reason'].trim() };
    }

    // A reason is carried through when given, and demanded by nobody here — the authority
    // table decides who needs one. See the note on `Command` in `lifecycle.ts`: without this,
    // the control room, which is now the only user, could not close an incident at all.
    case 'resolve':
      if (!nonEmpty(body['outcome'])) return 'outcome is required';
      return {
        kind,
        outcome: body['outcome'].trim(),
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };

    case 'close':
      if (!nonEmpty(body['notes'])) return 'notes are required';
      return {
        kind,
        notes: body['notes'].trim(),
        ...(nonEmpty(body['reason']) ? { reason: body['reason'].trim() } : {}),
      };

    case 'correct':
      /**
       * The reason is the whole value of the record here — M9-52.
       *
       * *"Corrected"* with no reason is a row that tells the next reader something was wrong
       * and nothing about what, which is worse than not correcting it: it removes trust in the
       * original without replacing it with anything.
       */
      if (!nonEmpty(body['reason'])) return 'say what was wrong with it';
      return {
        kind,
        reason: body['reason'].trim().slice(0, 2000),
        ...(nonEmpty(body['correction'])
          ? { correction: body['correction'].trim().slice(0, 2000) }
          : {}),
      };

    case 'withdraw':
      /**
       * The reason is the whole record — M10-11.
       *
       * A row that leaves the board saying nothing tells the next reader an emergency was
       * removed and not whether it was a duplicate, a test, or a mistake. **Search and the
       * daily report both print this sentence** (M10-15), so it is what somebody asking
       * *"what happened to the 11:00 report?"* six weeks later actually reads.
       */
      if (!nonEmpty(body['reason'])) return 'say why it should not be on the board';
      return { kind, reason: body['reason'].trim().slice(0, 2000) };

    case 'restore':
      // No reason, deliberately — see the `restored` payload in `domain/events.ts`.
      return { kind };

    /**
     * A reason on both, unlike `restore` — the district's five, 2026-08-22.
     *
     * Each of these changes what a room looks at for **days**, and the sentence is the whole
     * content of the decision. The wording of each refusal asks for the thing the panel will
     * actually be questioned about, rather than saying "reason is required".
     */
    case 'hold':
      if (!nonEmpty(body['reason'])) return 'say why this should stay past the end of the day';
      return { kind, reason: body['reason'].trim().slice(0, 2000) };

    case 'release':
      /**
       * ⚠️ **Deliberately not phrased as "why is it finished".** Releasing says the control room
       * has stopped watching this on the panel; it does not say the flood is over, and a prompt
       * that asked the second would be teaching the operator a claim the record cannot make.
       */
      if (!nonEmpty(body['reason'])) return 'say why this no longer needs to be carried';
      return { kind, reason: body['reason'].trim().slice(0, 2000) };

    case 'reschedule': {
      /**
       * 🔴 **A reschedule with no new date is not a reschedule.** It is a meeting taken off
       * its own date and left nowhere, and the follow-up that goes to every officer already told
       * would say a meeting moved without saying where to.
       */
      if (!nonEmpty(body['date'])) return 'give the new date';
      if (!nonEmpty(body['reason']))
        return 'say why it moved — the officers already told will be sent this';
      return {
        kind,
        date: body['date'].trim().slice(0, 20),
        ...(nonEmpty(body['time']) ? { time: body['time'].trim().slice(0, 20) } : {}),
        ...(nonEmpty(body['venue']) ? { venue: body['venue'].trim().slice(0, 200) } : {}),
        reason: body['reason'].trim().slice(0, 2000),
      };
    }
  }
}

/** `/incidents`, `/incidents/:id`, `/incidents/:id/:action`. */
function matchIncidentRoute(
  pathname: string,
): { readonly incidentId: string | null; readonly action: string | null } | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  if (parts[0] !== 'incidents') return null;
  if (parts.length === 1) return { incidentId: null, action: null };
  if (parts.length === 2) return { incidentId: parts[1]!, action: null };
  if (parts.length === 3) return { incidentId: parts[1]!, action: parts[2]! };
  return null;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The administration console — M1a. Everything under `/admin`.
 *
 * The authority check is **not** here. Every function in `api/admin.ts` asks
 * `requireAdministration` itself, so an endpoint added to this switch without a check is
 * still refused rather than silently open. A gate that lives in the router is a gate that
 * gets bypassed by the next route somebody adds in a hurry (INV-05).
 *
 * Malformed JSON is a 400 here, unlike intake, which cannot refuse anything (INV-01). The
 * asymmetry is the point: nobody's emergency is lost because a configuration form was
 * mis-submitted, and silently accepting a broken routing rule would be far worse than
 * rejecting it.
 */
async function handleAdmin(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
  backupDirectory: string,
  nightly: Nightly | null,
): Promise<void> {
  const send = <T>(result: AdminResult<T>): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, result.value);
  };

  const body = async (): Promise<Record<string, unknown> | null> => bodyOf(req);

  /**
   * Groups — M7-09/13. Under `/admin` because a group is a district configuration, decided by
   * the two offices, exactly like a routing signal.
   *
   * There is no PATCH. A save always carries the whole group — name and every member, in order
   * — because the console's editor is one form with one Save button, and three verbs for one
   * act would put three `config_event` rows in the history for a single decision.
   */
  if (req.method === 'GET' && pathname === '/admin/groups/suggested') {
    send(await suggestedGroupsForConsole(pool, identity));
    return;
  }

  if (pathname === '/admin/groups') {
    if (req.method === 'GET') {
      send(await groupsForConsole(pool, identity));
      return;
    }
    if (req.method === 'POST') {
      const input = await body();
      if (input === null) {
        json(res, 400, { error: 'that was not valid json' });
        return;
      }
      send(await saveGroupForConsole(pool, identity, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const group = /^\/admin\/groups\/([^/]+)$/.exec(pathname);
  if (group !== null) {
    const groupId = group[1]!;
    const input = await body();
    if (input === null) {
      json(res, 400, { error: 'that was not valid json' });
      return;
    }
    if (req.method === 'POST') {
      send(await saveGroupForConsole(pool, identity, input, groupId));
      return;
    }
    if (req.method === 'DELETE') {
      send(await retireGroupForConsole(pool, identity, groupId, input['reason']));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/departments') {
    send(await departmentsForConsole(pool, identity));
    return;
  }

  // ADR-0030 — CREATE, EDIT, RETIRE AND RESTORE A DEPARTMENT ARE GONE, WITH THE TABLE.
  //
  // Migration 0039 dropped it, so these four could only ever throw. They are removed rather
  // than left answering 410, because a path that explains itself is still a path somebody
  // finds and asks about -- and the district has been told the layer does not exist.
  //
  // GET /admin/departments SURVIVES and answers an empty list. It is what the console draws
  // its Departments tab from, and a tab that renders "none" is a screen telling the truth;
  // a route that 404s underneath it is a screen that looks broken. That tab comes off in the
  // client half of this change, which needs a CACHE bump and is deliberately not here.

  if (pathname === '/admin/sla') {
    if (req.method === 'GET') {
      send(await slaForConsole(pool, identity));
      return;
    }
    if (req.method === 'PUT') {
      const input = await body();
      if (input === null) {
        json(res, 400, { error: 'that was not valid json' });
        return;
      }
      send(await setTarget(pool, identity, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/backups') {
    send(await backupsForConsole(pool, identity, { directory: backupDirectory }));
    return;
  }

  if (req.method === 'POST' && pathname === '/admin/backups/now') {
    send(await backupNow(identity, nightly));
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/performance') {
    send(await districtPerformance(pool, identity));
    return;
  }

  /**
   * *Dashboard layout* (ADR-0015) and *Which screens are on* (ADR-0016) left this console for
   * the Settings panel — ADR-0032 phase 4. They are installation configuration, gated on
   * `dashboard_layout.write` / `capabilities.write`; see `/settings/dashboard-layout` and
   * `/settings/capabilities` in `handleSettings`.
   */

  if (req.method === 'GET' && pathname === '/admin/integrity') {
    send(await integrity(pool, identity));
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/history') {
    send(await configHistory(pool, identity));
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * The Settings panel — ADR-0032. Everything under `/settings`.
 *
 * A **new top-level panel**, not a tab inside `/admin` — the owner asked twice. Accounts, the
 * access log, and (in later phases) the security policy. The authority check is **not** here:
 * every function in `api/settings.ts` asks `requirePermission` for itself, so a route added to
 * this switch without one is refused rather than silently open (INV-05), exactly as `handleAdmin`
 * leans on `requireAdministration`.
 *
 * `owner` protection — no endpoint removes, suspends or demotes the `owner`, an `admin` may not
 * act on a peer `admin` — lives in `guardSubject` in the handler, never in this router. A
 * router-level check is one refactor away from being bypassed by a new route.
 */
async function handleSettings(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  identity: Identity,
  linkDeps: LinkDeps,
): Promise<void> {
  const pathname = url.pathname;
  const send = <T>(result: SettingsResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };
  const body = async (): Promise<Record<string, unknown> | null> => bodyOf(req);
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });

  if (pathname === '/settings/accounts') {
    if (req.method === 'GET') {
      send(await listAccounts(pool, identity));
      return;
    }
    if (req.method === 'POST') {
      const input = await body();
      if (input === null) return bad();
      send(await createAccount(pool, identity, input), 201);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/settings/access-log') {
    send(await accessLog(pool, identity, url.searchParams));
    return;
  }

  if (req.method === 'GET' && pathname === '/settings/security-policy') {
    send(await securityPolicy(pool, identity));
    return;
  }

  // The dashboard wall — ADR-0015, moved here from Administration by ADR-0032 phase 4.
  if (pathname === '/settings/dashboard-layout') {
    if (req.method === 'GET') {
      send(await dashboardLayout(pool, identity));
      return;
    }
    if (req.method === 'PUT') {
      const input = await body();
      if (input === null) return bad();
      send(await setDashboardLayout(pool, identity, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // Which screens this installation offers — ADR-0016, moved here by ADR-0032 phase 4. Not an
  // authority control: turning a screen off tidies a menu and revokes nothing (INV-05).
  if (pathname === '/settings/capabilities') {
    if (req.method === 'GET') {
      send(await installationCapabilities(pool, identity));
      return;
    }
    if (req.method === 'POST') {
      const input = await body();
      if (input === null) return bad();
      send(await toggleCapability(pool, identity, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // DELETE one override — matched before the `:id/:action` pattern below because the permission
  // string is a path segment of its own.
  const override = /^\/settings\/accounts\/([^/]+)\/permissions\/([^/]+)$/.exec(pathname);
  if (override !== null) {
    const subjectId = override[1]!;
    if (!UUID_RE.test(subjectId)) {
      json(res, 404, { error: 'no such account' });
      return;
    }
    if (req.method === 'DELETE') {
      send(await clearOverride(pool, identity, subjectId, decodeURIComponent(override[2]!)));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const account = /^\/settings\/accounts\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (account !== null) {
    const subjectId = account[1]!;
    const action = account[2] ?? null;
    if (!UUID_RE.test(subjectId)) {
      json(res, 404, { error: 'no such account' });
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'DELETE' && action === null) {
      send(await removeAccount(pool, identity, subjectId, input));
      return;
    }
    if (req.method === 'PATCH' && action === 'role') {
      send(await setAccountRole(pool, identity, subjectId, input));
      return;
    }
    if (req.method === 'POST' && action === 'permissions') {
      send(await setOverride(pool, identity, subjectId, input));
      return;
    }
    if (req.method === 'POST' && action === 'suspend') {
      send(await suspendAccount(pool, identity, subjectId, input));
      return;
    }
    if (req.method === 'POST' && action === 'reactivate') {
      send(await reactivateAccount(pool, identity, subjectId));
      return;
    }
    if (req.method === 'POST' && action === 'grant') {
      send(await grantLogin(pool, identity, subjectId, input, linkDeps), 201);
      return;
    }
    // A sign-in link for an existing account — a new login's first, or a forgotten password
    // (ADR-0043).
    if (req.method === 'POST' && action === 'login-link') {
      send(await sendSignInLink(pool, identity, subjectId, linkDeps));
      return;
    }
    if (req.method === 'POST' && action === 'reset-password') {
      send(await resetPassword(pool, identity, subjectId, input));
      return;
    }
    if (req.method === 'POST' && action === 'force-logout') {
      send(await forceLogout(pool, identity, subjectId));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * Activities — ADR-0039, Bajaur. Everything under `/activities/`.
 *
 * The authority check is **not** here: every function in `api/activities.ts` asks the caller's
 * Activities permissions for itself, so a route added to this switch without one is refused
 * rather than silently open (INV-05) — the same rule as `/settings`.
 */
async function handleActivities(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  identity: Identity,
  root: string,
  backup: { readonly configured: boolean; readonly why: string | null },
  onVideoUploaded: (() => void) | undefined,
  tellSender: ((phone: string, text: string) => Promise<void>) | undefined,
  linkDeps: LinkDeps,
): Promise<void> {
  const pathname = url.pathname;
  const fromWhatsApp: WhatsAppActivities = {
    root,
    ...(onVideoUploaded === undefined ? {} : { onVideo: onVideoUploaded }),
  };
  const send = <T>(result: ActivitiesResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });
  const notAllowed = (): void => void json(res, 405, { error: 'method not allowed' });

  if (pathname === '/activities/me') {
    if (req.method !== 'GET') return notAllowed();
    send(await activitiesMe(pool, identity));
    return;
  }

  if (pathname === '/activities/units') {
    if (req.method === 'GET') return send(await listUnits(pool));
    if (req.method === 'POST') {
      const input = await bodyOf(req);
      if (input === null) return bad();
      return send(await createUnit(pool, identity, input), 201);
    }
    return notAllowed();
  }

  const unit = /^\/activities\/units\/([^/]+)(?:\/(retire))?$/.exec(pathname);
  if (unit !== null) {
    if (!UUID_RE.test(unit[1]!)) return void json(res, 404, { error: 'no such department' });
    if (req.method === 'PATCH' && unit[2] === undefined) {
      const input = await bodyOf(req);
      if (input === null) return bad();
      return send(await renameUnit(pool, identity, unit[1]!, input));
    }
    if (req.method === 'POST' && unit[2] === 'retire') {
      return send(await retireUnit(pool, identity, unit[1]!));
    }
    return notAllowed();
  }

  if (pathname === '/activities/default-unit') {
    if (req.method !== 'PUT') return notAllowed();
    const input = await bodyOf(req);
    if (input === null) return bad();
    return send(await setDefaultUnit(pool, identity, input));
  }

  if (pathname === '/activities/people') {
    if (req.method !== 'GET') return notAllowed();
    return send(await listPeople(pool, identity));
  }

  if (pathname === '/activities/officers') {
    if (req.method !== 'GET') return notAllowed();
    return send(await listOfficers(pool, identity));
  }

  const officer = /^\/activities\/officers\/([^/]+)\/(activities|login|login-link)$/.exec(pathname);
  if (officer !== null) {
    if (req.method !== 'POST') return notAllowed();
    if (!UUID_RE.test(officer[1]!)) return void json(res, 404, { error: 'no such officer' });
    // A new sign-in link for an officer who has a login — ADR-0043. Settings' own rule
    // (`accounts.reset_password`) decides; the Officers tab is only another door to it.
    if (officer[2] === 'login-link') {
      return send(await sendSignInLink(pool, identity, officer[1]!, linkDeps));
    }
    const input = await bodyOf(req);
    if (input === null) return bad();
    return officer[2] === 'activities'
      ? send(await setOfficerActivities(pool, identity, officer[1]!, input))
      : send(await giveOfficerLogin(pool, identity, officer[1]!, input, linkDeps), 201);
  }

  if (pathname === '/activities/log') {
    if (req.method !== 'GET') return notAllowed();
    return send(await readActivitiesLog(pool, identity));
  }

  if (pathname === '/activities/expiring') {
    if (req.method !== 'GET') return notAllowed();
    return send(await activitiesExpiring(pool, identity, backup));
  }

  if (pathname === '/activities/expiring.zip') {
    if (req.method !== 'GET') return notAllowed();
    const reply = await downloadExpiringActivities(pool, root, res, identity);
    if (reply !== null && !reply.ok) json(res, reply.status, { error: reply.error });
    return;
  }

  if (pathname === '/activities/posts') {
    if (req.method === 'GET') return send(await listPosts(pool, identity, url.searchParams));
    if (req.method === 'POST') {
      const input = await bodyOf(req);
      if (input === null) return bad();
      return send(await createPost(pool, identity, input), 201);
    }
    return notAllowed();
  }

  // The Pending list (ADR-0040): WhatsApp media the DC approves or rejects.
  if (pathname === '/activities/pending') {
    if (req.method !== 'GET') return notAllowed();
    return send(await listPending(pool, identity));
  }

  const pendingMedia = /^\/activities\/pending\/media\/([^/]+)$/.exec(pathname);
  if (pendingMedia !== null) {
    if (req.method !== 'GET') return notAllowed();
    if (!UUID_RE.test(pendingMedia[1]!)) return void json(res, 404, { error: 'no such file' });
    const reply = await servePendingMedia(pool, root, res, identity, pendingMedia[1]!);
    if (reply !== null && !reply.ok) json(res, reply.status, { error: reply.error });
    return;
  }

  const pending = /^\/activities\/pending\/([^/]+)\/(approve|reject|add-contact)$/.exec(pathname);
  if (pending !== null) {
    if (req.method !== 'POST') return notAllowed();
    if (!UUID_RE.test(pending[1]!)) {
      return void json(res, 404, { error: 'this is no longer on the Pending list' });
    }
    if (pending[2] === 'reject')
      return send(await rejectPending(pool, root, identity, pending[1]!));
    const input = await bodyOf(req);
    if (input === null) return bad();
    if (pending[2] === 'add-contact') {
      return send(
        await addToDirectory(pool, fromWhatsApp, identity, pending[1]!, input, tellSender),
        201,
      );
    }
    return send(await approvePending(pool, fromWhatsApp, identity, pending[1]!, input, tellSender));
  }

  const post = /^\/activities\/posts\/([^/]+)(?:\/(photos|videos|hide|restore|date))?$/.exec(
    pathname,
  );
  if (post !== null) {
    const postId = post[1]!;
    const action = post[2];
    if (!UUID_RE.test(postId)) return void json(res, 404, { error: 'no such post' });
    if (req.method === 'DELETE' && action === undefined) {
      return send(await deletePost(pool, root, identity, postId));
    }
    if (req.method === 'POST' && action === 'photos') {
      return send(await addPhoto(pool, root, req, identity, postId), 201);
    }
    if (req.method === 'POST' && action === 'videos') {
      const input = await bodyOf(req);
      if (input === null) return bad();
      return send(await startVideo(pool, root, identity, postId, input), 201);
    }
    if (req.method === 'POST' && (action === 'hide' || action === 'restore')) {
      return send(await moderatePost(pool, identity, postId, action));
    }
    if (req.method === 'PUT' && action === 'date') {
      const input = await bodyOf(req);
      if (input === null) return bad();
      return send(await changeDate(pool, identity, postId, input));
    }
    return notAllowed();
  }

  // A video arriving in chunks (ADR-0039 §4): GET says how much arrived, PUT sends the next.
  const upload = /^\/activities\/uploads\/([^/]+)$/.exec(pathname);
  if (upload !== null) {
    if (!UUID_RE.test(upload[1]!)) return void json(res, 404, { error: 'no such upload' });
    if (req.method === 'GET') return send(await uploadState(pool, identity, upload[1]!));
    if (req.method === 'PUT') {
      return send(await receiveChunk(pool, root, req, identity, upload[1]!, onVideoUploaded));
    }
    return notAllowed();
  }

  const media = /^\/activities\/media\/([^/]+)$/.exec(pathname);
  if (media !== null) {
    if (req.method !== 'GET') return notAllowed();
    if (!UUID_RE.test(media[1]!)) return void json(res, 404, { error: 'no such photo' });
    const reply = await serveMedia(
      pool,
      root,
      req,
      res,
      identity,
      media[1]!,
      url.searchParams.get('size') === 'thumb',
    );
    if (reply !== null && !reply.ok) json(res, reply.status, { error: reply.error });
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * The roster — M1a-10. Everything under `/roster`.
 *
 * Separate from `/admin` because the gate is different, and the difference is the point: a
 * department may edit **its own** people and posts, while `/admin` remains the two offices
 * only. Routing signals and SLA deadlines stay on `/admin` deliberately (ADR-0010) — a
 * department able to edit its own routing could quietly stop receiving night-time calls.
 *
 * The literal segments `posts` and `people` are matched before the `:departmentId` pattern,
 * or `/roster/posts/...` would be read as a department whose id is "posts".
 */
async function handleRoster(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
): Promise<void> {
  const send = <T>(result: AdminResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };

  const body = async (): Promise<Record<string, unknown> | null> => bodyOf(req);
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });

  // A post, by id.
  const post = /^\/roster\/posts\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (post !== null) {
    const seatId = post[1]!;
    const action = post[2] ?? null;
    if (!UUID_RE.test(seatId)) {
      json(res, 404, { error: 'no such post' });
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editPost(pool, identity, seatId, input));
      return;
    }
    if (req.method === 'POST' && action === 'retire') {
      send(await retirePost(pool, identity, seatId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      send(await retirePost(pool, identity, seatId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'assign') {
      send(await assign(pool, identity, seatId, input));
      return;
    }
    if (req.method === 'POST' && action === 'relieve') {
      send(await relieve(pool, identity, seatId, input['reason']));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // A person, by id.
  const person = /^\/roster\/people\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (person !== null) {
    const personId = person[1]!;
    const action = person[2] ?? null;
    if (!UUID_RE.test(personId)) {
      json(res, 404, { error: 'no such person' });
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editRosterPerson(pool, identity, personId, input));
      return;
    }
    if (req.method === 'POST' && action === 'remove') {
      send(await removeRosterPerson(pool, identity, personId, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'account') {
      send(await grantRosterAccount(pool, identity, personId, input));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // The contact list — ADR-0029. Matched before the `:departmentId` pattern below, or
  // `/roster/contacts` would be read as a department whose id is "contacts", exactly as
  // `posts` and `people` are matched above it.
  //
  // A contact belongs to no department, so none of these carry one. The gate is
  // `reachContacts`, which is `reach` with the parameter that has meant nothing since
  // ADR-0024 taken off it.
  if (pathname === '/roster/contacts') {
    if (req.method === 'GET') {
      send(await readContacts(pool, identity));
      return;
    }
    if (req.method === 'POST') {
      const input = await body();
      if (input === null) return bad();
      send(await addContact(pool, identity, input), 201);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const contact = /^\/roster\/contacts\/([^/]+)(?:\/([a-z]+))?$/.exec(pathname);
  if (contact !== null) {
    const seatId = contact[1]!;
    const action = contact[2] ?? null;
    if (!UUID_RE.test(seatId)) {
      json(res, 404, { error: 'no such contact' });
      return;
    }

    if (req.method === 'DELETE' && action === null) {
      send(await deleteContact(pool, identity, seatId));
      return;
    }

    const input = await body();
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editContact(pool, identity, seatId, input));
      return;
    }
    if (req.method === 'POST' && action === 'administration') {
      // 🔴 The tick that carries the whole authority model (ADR-0029 §2). The store refuses to
      // remove the last one — a district where nobody is the administration is a district
      // where nobody can issue an advisory.
      send(await setAdministration(pool, identity, seatId, input['on'] === true));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // Add a post or a person. Flat, with no id in front — ADR-0031, phase 3. A seat no longer
  // belongs to a department (ADR-0029/0030), so `/roster/:dept/posts` and `/roster/:dept/people`
  // named nothing; the redesigned console posting a bare `/roster/people` was the live
  // `{"error":"no such department"}` bug (§5). These are matched before the `:seatId` /
  // `:personId` regexes above only by being literal — `/roster/posts` has no trailing id.
  if (req.method === 'POST' && (pathname === '/roster/posts' || pathname === '/roster/people')) {
    const input = await body();
    if (input === null) return bad();
    if (pathname === '/roster/posts') {
      send(await addPost(pool, identity, input), 201);
    } else {
      send(await addRosterPerson(pool, identity, input), 201);
    }
    return;
  }

  // `/roster`: the district's one flat roster (ADR-0029). There are no per-department rosters
  // any more, so any id after `/roster/` is gone with ADR-0031 phase 3.
  if (req.method === 'GET' && pathname === '/roster') {
    send(await readRoster(pool, identity));
    return;
  }

  json(res, 404, { error: 'not found' });
}

/**
 * What a department can send — M1-02. Everything under `/fleet`.
 *
 * Beside `/roster` and gated the same way, because they are the same question asked about
 * two kinds of thing: what a department has. Dispatch itself is **not** here — sending a
 * unit is a fact about an emergency, so it lives on the incident (`/incidents/:id/dispatch`)
 * and lands in the incident log where "which ambulance went to the bazaar fire" stays
 * answerable a year later.
 */
async function handleFleet(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  identity: Identity,
): Promise<void> {
  const send = <T>(result: AdminResult<T>, okStatus = 200): void => {
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, okStatus, result.value);
  };
  const bad = (): void => void json(res, 400, { error: 'that was not valid json' });

  const unit = /^\/fleet\/units\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (unit !== null) {
    const resourceId = unit[1]!;
    const action = unit[2] ?? null;
    if (!UUID_RE.test(resourceId)) {
      json(res, 404, { error: 'no such unit' });
      return;
    }

    const input = await bodyOf(req);
    if (input === null) return bad();

    if (req.method === 'PATCH' && action === null) {
      send(await editResource(pool, identity, resourceId, input));
      return;
    }
    if (req.method === 'POST' && action === 'off-run') {
      send(await serviceState(pool, identity, resourceId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'on-run') {
      send(await serviceState(pool, identity, resourceId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'retire') {
      send(await retireResource(pool, identity, resourceId, true, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'restore') {
      send(await retireResource(pool, identity, resourceId, false, input['reason']));
      return;
    }
    if (req.method === 'POST' && action === 'crew') {
      send(await crew(pool, identity, resourceId, input['personId'], true));
      return;
    }
    if (req.method === 'POST' && action === 'uncrew') {
      send(await crew(pool, identity, resourceId, input['personId'], false));
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  if (req.method === 'GET' && pathname === '/fleet') {
    send(await readFleet(pool, identity));
    return;
  }

  // Flat, like `/roster/posts` — ADR-0031 (phase 4) dropped the `/fleet/:departmentId` block.
  // Migration 0039 dropped `resource.department_id`, so there is one fleet and its id segment
  // only ever matched a nil placeholder; a non-UUID part answered `no such department`.
  if (req.method === 'POST' && pathname === '/fleet/units') {
    const input = await bodyOf(req);
    if (input === null) return bad();
    send(await addResource(pool, identity, input), 201);
    return;
  }

  json(res, 404, { error: 'not found' });
}

async function handleIncidents(
  pool: Pool,
  req: IncomingMessage,
  res: ServerResponse,
  route: { readonly incidentId: string | null; readonly action: string | null },
  identity: Identity,
  evidenceRoot: string,
  wantsText = false,
  includeClosed = false,
  /** The WhatsApp channel, when configured — so a dispatch sends immediately (M6-04/M6-18). */
  whatsappSender?: NotificationChannel,
  /**
   * `?date=` for the board — ADR-0020. Raw and unvalidated on purpose.
   *
   * Validated below rather than at the route, so the 400 belongs to the **board** and a stray
   * `?date=` on some other incident route cannot start refusing requests that never read it.
   */
  boardDate: string | null = null,
  /**
   * `?withdrawn=1` — the way back onto the board, M10-13/18.
   *
   * Without it a row an operator took off has no door: they would have to know its id, which
   * is exactly the state "we deleted it" leaves somebody in. With it the board shows the
   * withdrawn rows **marked**, so the restore button has somewhere to live.
   */
  showWithdrawn = false,
  /**
   * `?sort=` — which column the board is ordered by, M11-11. `-` reverses it.
   *
   * Passed in raw and validated **below**, for the same reason `boardDate` is: the 400 belongs
   * to the board, and a stray `?sort=` on some other incident route must not start refusing
   * requests that never read it.
   */
  boardSort: string | null = null,
  /**
   * `?open=1` — **the Record's own view: every record, newest first, whatever day it started**
   * (Phase 4c; widened 2026-09-06 to carry closed rows too — the owner's call).
   *
   * ⚠️ **`open` is a historical param name.** It began life as *what is still open, any day*,
   * because the Dashboard is one district day and an incident belongs to the day it started,
   * so an emergency opened last week is in **no** counter and is chased by **no** escalation —
   * and a Record that also opened on today would mean the only way to reach it is to already
   * know it is there. That reasoning still holds; what changed is that dropping the finished
   * rows left the top of the list on a stale still-open case while the genuinely newest
   * incident — already resolved by lunchtime — was nowhere on the screen. So this view now
   * folds **open and closed alike**, ordered newest-entered first (`-recorded`), however the
   * Record is reached. The wire name stays `open` so shared links and the browser suites do
   * not churn.
   *
   * It is a **different selection, not a different projection**: same fold, same
   * `evaluateRead`, same rows. `date` comes back `null`, and the screen is required to say so
   * — ADR-0020's rule that every surface names the period it is showing applies hardest to the
   * one view that is not a day.
   */
  openOnly = false,
  /**
   * The district's WhatsApp account and its test seam — Phase 8b.
   *
   * Added at the END of this list on purpose: every argument here is positional, and inserting
   * one anywhere else silently re-points nine existing call arguments at the wrong parameters,
   * with the types too loose in places to catch it.
   *
   * ⚠️ Null is an ordinary state, not a fault: a district that has not bought the account yet
   * (R-05) gets a 409 saying so rather than a 500 about software that is working correctly.
   */
  whatsappConfig: WhatsAppConfig | null = null,
  whatsappFetchImpl?: typeof fetch,
): Promise<void> {
  const readJson = async (): Promise<Record<string, unknown> | null> => bodyOf(req);

  if (route.incidentId === null) {
    // The central board (M0-33). Scoped by the caller's seat, server-side — rows this seat
    // may not see are never sent, rather than sent and hidden (INV-05).
    if (req.method === 'GET') {
      const seat = seatOf(identity);
      /**
       * `?closed=1` includes what has already been resolved or closed.
       *
       * Added for the dashboard's **Reported today** counter, which counts everything that
       * happened today whether or not it is still open — an emergency dealt with by lunchtime
       * still happened today. Without this the counter would say 8 and lead to 5 rows, and a
       * number that disagrees with the screen it leads to is worse than one nobody can click.
       *
       * Off by default: the board is a working screen, and a shift does not need yesterday's
       * closed incidents in the way.
       */
      /**
       * **The board is one district day** — ADR-0020, and the default is today.
       *
       * Defaulted here rather than inside `buildBoard`, so the one caller that genuinely wants a
       * span — the export — cannot acquire a day by forgetting to pass one.
       *
       * A malformed date is a **400, not a silent fall back to today**. Falling back would show
       * the operator a board that is real, current and not the day they asked for, with nothing
       * on the screen disagreeing with them — which is precisely the failure this decision
       * already accepts one instance of and must not add a second.
       */
      if (boardDate !== null && startOfNamedDistrictDay(boardDate) === null) {
        json(res, 400, { error: 'date must be YYYY-MM-DD' });
        return;
      }
      if (boardDate !== null && !isRecordDateAvailable(boardDate)) {
        const range = recordDateRange();
        json(res, 400, {
          error: `Record can show days from ${range.from} to ${range.to}. Choose a day in that range.`,
        });
        return;
      }
      /**
       * **Which column the board is ordered by — M11-11.** `?sort=age`, or `-age` to reverse.
       *
       * **A sort this route does not offer is a 400, for the date's own reason two paragraphs
       * up**: falling back to the queue's order would hand the operator a board that is real,
       * current and not the order they asked for, with a column header on screen claiming
       * otherwise. That is the same failure in a quieter place — an ordering is easier to
       * mis-read as correct than a wrong day is.
       */
      const sort = parseSort(boardSort);
      if (sort === null) {
        json(res, 400, { error: `sort must be one of ${BOARD_SORTS.join(', ')}` });
        return;
      }
      /**
       * **`?open=1` wins over the day, and asking for both is a 400 rather than a guess.**
       *
       * *"The whole record, newest first"* and *"this Tuesday"* are two different questions and
       * a caller sending both has lost track of which it is asking. Answering one of them
       * silently is how a screen comes to print a date it is not showing — the failure ADR-0020
       * spends a whole section refusing.
       */
      if (openOnly && boardDate !== null) {
        json(res, 400, { error: 'ask for a day or for the whole record, not both' });
        return;
      }

      json(
        res,
        200,
        openOnly
          ? await buildBoard(pool, seat, {
              /**
               * **No `date`, and a window as wide as the record is searchable.**
               *
               * `recordWindowLookbackDays` is derived from the same 730-day window the picker
               * receives, including only the arrival-time boundary buffer needed to cover its
               * first district day. *How far back this product can reach interactively* stays one
               * fact about the district rather than several numbers that drift.
               *
               * `buildBoard` probes one row past its working limit and declares `truncated` in
               * the response. A queue that is too large for this interactive view is therefore
               * visibly incomplete, never a list that merely happens to stop at row 500 — and
               * with the newest-first order that means the oldest groups fall off, never the
               * newest, which is the half of the list this view exists to put on top.
               */
              days: recordWindowLookbackDays(),
              sort,
              /**
               * **The Record's own view carries finished rows too** — 2026-09-06, the owner's
               * call. Without this it dropped everything resolved or closed, so the newest thing
               * that happened — dealt with by lunchtime — was absent while a stale still-open
               * case sat on top. The day views stay live-work-only (`includeClosed` is opt-in
               * there, driven by `?closed=1`); this one view is the whole record.
               */
              includeClosed: true,
              ...(showWithdrawn ? { hideWithdrawn: false } : {}),
            })
          : await buildBoard(pool, seat, {
              date: boardDate ?? districtDate(),
              sort,
              ...(includeClosed ? { includeClosed: true } : {}),
              ...(showWithdrawn ? { hideWithdrawn: false } : {}),
            }),
      );
      return;
    }

    // Intake. The one endpoint here that does not refuse — see `intake`.
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    // Even unreadable JSON does not lose the report: an empty body still records that
    // someone said something happened, with every field marked assumed (INV-01).
    const body = (await readJson()) ?? {};
    const result = await intake(pool, body, identity);
    json(res, 201, {
      incidentId: result.incidentId,
      reportId: result.reportId,
      assumed: result.assumed,
      // Where it went, told to the person who just reported it. Someone standing at the
      // scene needs to know whether help has actually been summoned — "received" and
      // "received, and nobody has it" are different answers (ADR-0005).
      routedTo: result.routedTo,
      unassigned: result.unassigned,
      routingReason: result.routingReason,
    });
    return;
  }

  if (!UUID_RE.test(route.incidentId)) {
    json(res, 404, { error: 'no such incident' });
    return;
  }

  if (route.action === null) {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const result = await readIncident(pool, route.incidentId, identity);
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }
    json(res, 200, {
      state: result.state,
      events: result.events,
      /**
       * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
       *
       * Top-level rather than on `state`, and that placement is the whole point of it: `state` is
       * the fold, and the number is not in the log — it is assigned by this primary after the
       * events commit, so two servers folding the same events cannot invent two of them.
       */
      reference: result.reference,
      /**
       * 🔴 **The four-word stage, which this route computed and then threw away** — D-1,
       * 2026-08-25.
       *
       * `readIncident` has returned `stage` since M9-25 and **nothing sent it**. So the detail
       * screen has never once shown the word the Board shows for the same emergency: it fell
       * through `web/src/main.ts`'s own *"older server"* branch and printed the raw status
       * instead, on every incident, since the day the four stages were introduced.
       *
       * The two screens described one emergency in two vocabularies — *Responded* on the board,
       * `responding` on the incident — which is exactly the disagreement `stageOf` exists to
       * make impossible. Found on 2026-08-24 while adding `reference` to this same response, and
       * left for the owner then because it changes district-visible text nobody had asked to
       * change; **the same owner has since said to fix what I can and list what needs them**.
       *
       * ⚠️ **Beside `state.status`, never instead of it.** The seven statuses are the record and
       * the detail screen still shows them; the stage is vocabulary (`domain/stages.ts`), and
       * folding one into the other would be the second answer this system refuses to keep.
       */
      stage: result.stage,
      /**
       * 🔴 **The deadline snapshot `readIncident` has returned since 2026-09-04 and nothing
       * sent** — the same story as `stage` above, found the same way (Option C, 2026-09-10).
       *
       * `0804563` added `readIncident`'s `sla`, the client `Detail['sla']` type, and the
       * drawer's Deadline tile that reads `data.sla` — but never added the field here, so the
       * tile has fallen to *"no deadline · this kind carries none"* on every incident since.
       * Wired now: the drawer shows the same "12m overdue" / "on track" / "met" the Board's
       * row shows for the same emergency, from the one `checkEscalation`.
       */
      sla: result.sla,
      /**
       * Who is holding a wide dispatch, off the officers' own words — Option C, 2026-09-10.
       *
       * The `ownershipOf` roll-up, so the drawer's "Taken by" tile and "Responded" row name
       * the first office to **commit** rather than the first to tap (a decline included). Null
       * when nobody was told; on a single-recipient incident it agrees with the fold's
       * `acknowledgedBy*` slot, which the drawer keeps reading while `told <= 1`.
       */
      response: result.response,
      /**
       * Who is coming, when this notice asks who is coming — the Case 2 (meeting) work,
       * 2026-09-10. The `attendanceFor` tally, so the drawer shows the attendance summary and
       * per-person answers in place of `status` / "Taken by" / "The response we received" for a
       * `meeting` (and any `asksAttendance` notice). Null for everything else, where the drawer
       * is unchanged.
       */
      attendance: result.attendance,
      /**
       * The saved groups a dispatch on this incident expanded — Case 3, 2026-09-10. Display
       * only: the drawer's "Who was told" panel groups its rows under the group's name. `[]`
       * for every incident dispatched only by hand, and the panel is then unchanged.
       */
      recipientGroups: result.recipientGroups,
      actors: result.actors,
      responsibleDepartments: result.responsibleDepartments,
      // The same departments by id, so the detail screen can offer "reach them" without a
      // second request (M5).
      responsibleDepartmentIds: result.responsibleDepartmentIds,
      // Sent with the incident rather than fetched separately. The detail screen needs both
      // to render one timeline, and a second round trip is a second thing that can be
      // half-loaded on a bad connection.
      evidence: await listFor(pool, route.incidentId),
    });
    return;
  }

  // The post-incident report (M1-06).
  //
  // Two formats from one fold: JSON for a screen, plain text for submitting upward. Q-02
  // made export the point rather than integration, and plain text can be pasted into an
  // email, a register or a form with no tooling on the other end — a district office should
  // never need this software installed to read what it produced.
  if (route.action === 'report') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const result = await postIncidentReport(pool, route.incidentId, identity);
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }
    if (wantsText) {
      const body = Buffer.from(result.text, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    json(res, 200, result.report);
    return;
  }

  // Evidence (M1-05). Authority comes from the incident, so these sit inside the incident
  // handler rather than beside it.
  if (route.action === 'evidence') {
    if (req.method === 'POST') {
      const reply = await upload(pool, evidenceRoot, req, route.incidentId, identity);
      if (!reply.ok) json(res, reply.status, { error: reply.error });
      else json(res, reply.status, reply.body);
      return;
    }
    if (req.method === 'GET') {
      const reply = await listEvidence(pool, route.incidentId, identity);
      if (!reply.ok) json(res, reply.status, { error: reply.error });
      else json(res, reply.status, reply.body);
      return;
    }
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  /**
   * The control room chooses who should know — M6-04.
   *
   * Named `dispatch-to` and not `dispatch`, because `/dispatch` above already means *send a
   * vehicle* (M1-03) and the two are genuinely different acts: one commits a unit, the other
   * tells a human. One route serving both would be the kind of overload that gets a fire engine
   * sent to somebody who was meant to be telephoned.
   */
  if (route.action === 'dispatch-to') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }

    const result = await dispatchTo(pool, route.incidentId, body, identity);
    if (!result.ok) {
      json(res, result.status, { error: result.error });
      return;
    }

    /**
     * Turn the choice into obligations before answering.
     *
     * The operator is on the telephone. A screen that says "told 4" while the ledger behind it
     * is still empty for another fifteen seconds is a screen an operator learns to distrust —
     * and the personal handset is right there. `notifyNow` takes the scheduler's own lock and
     * returns null rather than racing it, so the worst case is the tick doing it instead.
     */
    await notifyNow(pool, route.incidentId, undefined, whatsappSender);

    json(res, 200, result.value);
    return;
  }

  /**
   * **The control room chases, by hand — Phase 8b.**
   *
   * The other half of 8a's deletion: the ladder stopped messaging an officer's superior at the
   * district's request, and this is what was given to the room in its place. See `api/followUp.ts`
   * for why a chase is neither an `action_logged` nor a notification attempt — both would put
   * something false on the board.
   *
   * ⚠️ **No `notifyNow` here, and that is deliberate.** `dispatch-to` turns a choice into
   * obligations and needs the pass to run; a follow-up **sends inside the request** and has
   * already happened by the time this answers. Calling the pass would be asking it to re-attempt
   * an obligation that was discharged before the chase began.
   */
  if (route.action === 'follow-up') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }

    const asked = body as { note?: unknown; toPhone?: unknown };
    const result = await followUp({
      pool,
      identity,
      incidentId: route.incidentId,
      note: typeof asked.note === 'string' ? asked.note : null,
      toPhone: typeof asked.toPhone === 'string' ? asked.toPhone : null,
      config: whatsappConfig,
      ...(whatsappFetchImpl === undefined ? {} : { fetchImpl: whatsappFetchImpl }),
    });

    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, { ok: true, chased: result.chased });
    return;
  }

  /**
   * **Escalate, by a person's hand** - Phase 8c, and it is the action the district asked to sit
   * beside the mark on the board.
   *
   * ⚠️ **This route messages nobody**, which is the whole of option (b): the escalation is
   * recorded, the board shows it, and no handset rings. Since Phase 8a there is no obligation
   * produced for `currentEscalationSeatId`, so there is deliberately **no `notifyNow` here** -
   * and unlike `dispatch-to`, there is nothing for a pass to do afterwards either. The route that
   * does reach an officer is `follow-up`, immediately above.
   */
  if (route.action === 'escalate') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }

    const asked = body as { reason?: unknown };
    const result = await escalateByHand({
      pool,
      identity,
      incidentId: route.incidentId,
      reason: typeof asked.reason === 'string' ? asked.reason : '',
    });

    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, { ok: true, escalated: result.escalated });
    return;
  }

  // "Reach them" was used (M6-10). Records that an app was opened and nothing more — see
  // `recordContactOpened` for why that wording is the whole of the design.
  if (route.action === 'contact-opened') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }
    const result = await recordContactOpened(pool, route.incidentId, body, identity);
    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, { ok: true, state: result.value.state });
    return;
  }

  /**
   * The operator records what they were told on the telephone — M7-05/06/07.
   *
   * Named `acknowledged-by` rather than `acknowledge`, and the distance between the two names
   * is the distance between the two facts. `/acknowledge` is *I am taking this*, said by the
   * officer taking it. This is *they told me they are taking it*, said by somebody else about
   * them — attributed to the operator, marked with its route, and never rendered as the first.
   */
  if (route.action === 'acknowledged-by') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }
    const result = await recordAcknowledgement(pool, route.incidentId, body, identity);
    json(res, result.status, result.body);
    return;
  }

  // Dispatch and stand-down (M1-03).
  //
  // Handled before the policy-table commands because their authority question is a different
  // one: not "may this seat change this field of this incident" but "is this unit yours to
  // send". A department that holds the incident may commit what it has and may not commit
  // another department's ambulance — see `api/resources.ts`.
  if (route.action === 'dispatch' || route.action === 'release') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readJson();
    if (body === null) {
      json(res, 400, { error: 'invalid json' });
      return;
    }

    const result =
      route.action === 'dispatch'
        ? await dispatch(pool, identity, route.incidentId, body)
        : await release(pool, identity, route.incidentId, body);

    if (!result.ok) json(res, result.status, { error: result.error });
    else json(res, 200, result.value);
    return;
  }

  const kind = COMMAND_PATHS[route.action];
  if (kind === undefined) {
    json(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJson();
  if (body === null) {
    json(res, 400, { error: 'invalid json' });
    return;
  }

  const command = parseCommand(kind, body);
  if (typeof command === 'string') {
    json(res, 400, { error: command });
    return;
  }

  const result = await applyCommand(pool, route.incidentId, command, identity);
  if (!result.ok) {
    json(res, result.status, { error: result.error });
    return;
  }

  json(res, 200, { event: result.event, state: result.state });
}

async function handlePull(pool: Pool, res: ServerResponse, url: URL): Promise<void> {
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);

  if (!Number.isFinite(cursor) || cursor < 0) {
    json(res, 400, { error: 'cursor must be a non-negative number' });
    return;
  }

  const page = await loadSince(pool, cursor, limit);
  const response: PullResponse = {
    events: page.events,
    nextCursor: page.nextCursor,
    hasMore: page.events.length === limit,
  };

  json(res, 200, response);
}

export function createSyncServer(options: ServerOptions): Server {
  const { pool, webRoot } = options;
  // Defaulted rather than required, so every existing caller keeps working — but defaulted
  // to a directory **outside** the web root, because a directory the server serves
  // statically is a directory where an uploaded file becomes a URL a browser will open.
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot();
  const activitiesRoot = options.activitiesRoot ?? defaultActivitiesRoot();
  const activitiesBackup = options.activitiesBackup ?? {
    configured: false,
    why: 'no media bucket yet',
  };
  const backupDirectory = options.backupDirectory ?? join(process.cwd(), 'var', 'backups');

  /**
   * Per server, not per module.
   *
   * A module-level singleton would be shared by every server a test file starts, so one
   * suite's failed sign-ins would slow another's — and a test that mysteriously got slower
   * depending on what ran before it is a test people delete.
   */
  const throttle = new LoginThrottle();
  const throttleSweep = setInterval(() => throttle.sweep(), 5 * 60 * 1000);
  throttleSweep.unref();

  /**
   * Read at request time, never at construction.
   *
   * `main.ts` builds the server before it builds the backup job, so it passes a getter — and
   * reading `options.nightly` here would invoke that getter during construction, before the
   * `const nightly` it closes over exists. That is a temporal dead zone error, and it took
   * the whole process down at startup with "Cannot access 'nightly' before initialization".
   *
   * Found by `deployable.e2e.test.ts`, which exists because `npm start` had once never
   * worked at all while 338 tests passed. It has now caught the same class of thing twice.
   */
  const nightlyNow = (): Nightly | null => options.nightly ?? null;
  const authMode = options.authMode ?? 'stub';
  const nodeEnv = options.nodeEnv ?? process.env['NODE_ENV'] ?? 'development';
  const whatsapp = options.whatsapp ?? null;

  /**
   * How a sign-in link is sent, and the address it lives at (ADR-0043). The configured public
   * origin when there is one — it must be, for a link that goes by WhatsApp; otherwise the
   * address this request came in on, which is right for a link the DC sends by hand on a
   * development machine.
   */
  const linkDepsFor = (req: IncomingMessage): LinkDeps => ({
    whatsapp,
    publicOrigin: options.publicOrigin ?? `http://${req.headers.host ?? '127.0.0.1'}`,
    ...(options.whatsappFetch === undefined ? {} : { fetchImpl: options.whatsappFetch }),
  });
  /**
   * The same channel the scheduler uses, built once here for the immediate pass.
   *
   * A dispatch runs the notify pass before it answers (M6-04) — the operator is on the
   * telephone, and a screen that has not yet said anybody was told is a screen they stop
   * trusting. Without this the WhatsApp half of that pass would be silently missing, and the
   * message would go out fifteen seconds later on the scheduler's tick with nothing explaining
   * the gap.
   */
  /**
   * The loopback default is kept for development and is **no longer allowed to be silent.**
   *
   * It was silent until 2026-08-13, and it cost the district every acknowledge link this server
   * sent: `main.ts` never passed `publicOrigin`, so this fell through to the literal below and
   * built a channel addressing handsets at `http://127.0.0.1:3000`. The send succeeded every
   * time, which is exactly why nobody noticed — INV-03's "a notification failure is never
   * invisible", defeated by a default argument.
   *
   * A missing origin *with WhatsApp configured* is now an error in the journal naming itself.
   * Not a refusal: INV-01 outranks a broken link, and a district that can still record and
   * escalate emergencies with dead ack links is far better off than one that will not boot.
   */
  if (
    whatsapp !== null &&
    options.whatsappChannel === undefined &&
    options.publicOrigin === undefined
  ) {
    log('error', 'publicOrigin was not given to the server, so acknowledge links will be dead', {
      falling_back_to: 'http://127.0.0.1:3000',
      why: 'a dispatch notifies immediately and mints the acknowledge link here, not in the scheduler',
    });
  }

  const whatsappSender =
    options.whatsappChannel ??
    (whatsapp === null
      ? undefined
      : whatsappChannel({
          pool,
          config: whatsapp,
          publicOrigin: options.publicOrigin ?? 'http://127.0.0.1:3000',
          // The same root uploads write to — M10-34a. Passed rather than defaulted separately,
          // because a sending path looking in a different directory from the receiving one fails
          // as "the picture did not come" on a system where every other part is correct.
          evidenceRoot,
        }));
  /**
   * Empty by default, and that default is the safe one — M6-37.
   *
   * With no pinned proxy the `X-Forwarded-For` header is not read at all, which is exactly the
   * rule this system has followed since the throttle was written. Turning it on is a
   * deliberate configuration act taken in the same release as the proxy itself.
   */
  const trustedProxies = options.trustedProxies ?? [];

  assertAuthUsable(authMode, nodeEnv);

  return createServer((req, res) => {
    // Every request gets a correlation id, in the response header and on every log line it
    // causes — including the escalation and notification work it triggers downstream
    // (M0-03). Without it, "I filed a report at 14:20 and it vanished" has no answer.
    const correlationId = correlationIdFrom(req.headers['x-correlation-id']);
    res.setHeader('x-correlation-id', correlationId);

    const startedAt = Date.now();

    void withContext({ correlationId }, async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');

        /**
         * WhatsApp's own two routes — M6-20, M6-22.
         *
         * **The only endpoints in this system reachable without a session**, and they have to
         * be: Meta has no account here, and an officer tapping an acknowledge link on their own
         * handset may hold no account either — which is most of the district's directory
         * (M0-51). Handled first, before anything that reads a token, so nothing about the
         * session machinery can accidentally apply to them.
         *
         * The perimeter is entirely inside each handler: a verified HMAC for the webhook, and
         * a single-use hashed token for the acknowledgement. Neither is a check the router
         * performs on their behalf, because a gate in a router is a gate the next route added
         * in a hurry goes around (INV-05).
         */
        if (url.pathname === '/webhooks/whatsapp') {
          if (req.method === 'GET') {
            const reply = verifyWebhookSubscription(whatsapp, url.searchParams);
            res.writeHead(reply.status, { 'content-type': reply.contentType });
            res.end(reply.body);
            return;
          }

          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          /**
           * The **raw bytes**, because the signature is over exactly what was sent.
           *
           * Parsing and re-serialising to verify would compare a signature against a document
           * that differs from Meta's in key order or whitespace, and the check would fail on
           * every genuine webhook while still passing on nothing forged — a control that is
           * broken in the direction that looks like it is working.
           */
          const raw = Buffer.from(await readBody(req), 'utf8');
          const reply = await handleWhatsAppWebhook(
            pool,
            whatsapp,
            raw,
            req.headers['x-hub-signature-256'] as string | undefined,
            options.whatsappFetch ?? fetch,
            // The same directory the upload and download paths use, passed rather than
            // recomputed — see `defaultEvidenceRoot`, which exists because two copies of this
            // join once disagreed and the symptom was a file nobody could find.
            evidenceRoot,
            options.activitiesFromWhatsApp === true
              ? {
                  root: activitiesRoot,
                  ...(options.onVideoUploaded === undefined
                    ? {}
                    : { onVideo: options.onVideoUploaded }),
                }
              : undefined,
          );
          res.writeHead(reply.status, { 'content-type': reply.contentType });
          res.end(reply.body);
          return;
        }

        /**
         * One path, three kinds of token, and two methods — M6-22, M9-27.
         *
         * The prefix is fixed: `district_message_v2`'s URL button was approved as
         * `{PUBLIC_ORIGIN}/ack/{{1}}` and a second path would need a second template through
         * Meta's review, which the owner's standing rule refuses to wait on. So the **stage on
         * the token** decides what a request means, and the redemption path checks it.
         *
         * **GET acknowledges, but GET never records progress.** The acknowledge link has no
         * choice — a template URL button can only be a GET, and it has to act on it or the
         * district's one button does nothing. Everything this system mints on its own page is
         * split in two: GET draws a confirmation, POST spends the token. That matters here more
         * than it usually would, because **WhatsApp fetches URLs to build link previews** — a
         * crawler must never resolve an emergency on an officer's behalf.
         */
        const ack = /^\/ack\/([A-Za-z0-9_-]{20,120})$/.exec(url.pathname);
        if (ack !== null) {
          if (req.method !== 'GET' && req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const token = ack[1]!;
          /**
           * Which token this is, read once and reused by both methods.
           *
           * `availability` is not a lifecycle stage at all (M9-34) — it moves no emergency, it
           * says where a person is — so it takes its own branch rather than being squeezed into
           * `applyStage`'s transition rules.
           */
          const seen = await peekAckToken(pool, token);
          const kind = seen.ok ? (seen.subject.stage ?? 'acknowledge') : 'acknowledge';

          let result;
          if (req.method === 'POST') {
            // A form submit from the page above, so `application/x-www-form-urlencoded` — the
            // one body shape a page with no JavaScript can produce.
            const fields = new URLSearchParams(await readBody(req));
            result =
              kind === 'availability'
                ? await applyAvailability(pool, token, fields.get('status'), fields.get('until'))
                : kind === 'response'
                  ? await applyResponse(pool, token, fields.get('option'), fields.get('said'))
                  : await applyStage(pool, token, fields.get('said'));
          } else {
            /**
             * Which GET this is, decided by the token itself.
             *
             * `redeemAck` refuses a progress token outright rather than acknowledging with it,
             * so the peek above is the difference between an officer seeing their confirmation
             * page and seeing a refusal. It costs one read and cannot spend anything.
             */
            result =
              kind === 'acknowledge'
                ? await redeemAck(pool, token)
                : kind === 'availability'
                  ? await viewAvailability(pool, token)
                  : kind === 'response'
                    ? await viewResponse(pool, token)
                    : await viewStage(pool, token);
          }

          const page = ackPage(result);
          res.writeHead(result.status, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(page),
            // Never cached. A link that renders "Acknowledged" from a browser cache would tell
            // an officer their tap worked on a night when nothing reached the district at all.
            'cache-control': 'no-store',
          });
          res.end(page);
          return;
        }

        /**
         * A file, opened from a link in a WhatsApp message — M9-18.
         *
         * **The third route with no session, and the reasoning is M6-22's exactly.** An officer
         * on a personal handset may hold no account and may never sign in, which is most of the
         * district's directory (M0-51). `/evidence/:id` cannot serve them: it requires a session
         * and authority over the incident. So the token is the authority, the same way the
         * acknowledge token is — minted here, hashed in the table, and expiring.
         *
         * **Everything the authenticated download does, this does too.** Same
         * `application/octet-stream`, same `nosniff`, same `default-src 'none'; sandbox` CSP,
         * same `no-store`. A token is a different way of proving you may have the file; it is
         * not a different, weaker way of serving it. Getting that wrong here would be worse than
         * on the authenticated route, because this one is reachable from the open internet.
         */
        const file = /^\/file\/([A-Za-z0-9_-]{20,120})(\/raw)?$/.exec(url.pathname);
        if (file !== null) {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          /**
           * **The link draws a page; only `/raw` hands over bytes** — 2026-08-14.
           *
           * The district reported the attachment as *"not coming with the message"*, and from the
           * receiving end that is exactly what it looked like: tapping the link produced a
           * download prompt naming a file, or nothing at all, with no sign of what it belonged
           * to. So the officer now gets the same shape of thing the acknowledge button gives
           * them — a page that says what this is and shows it.
           *
           * `peek` above, `redeem` below, and that split is deliberate: `opened_count` is the
           * district's only answer to *"did this officer see it?"*, and it must keep meaning
           * **the bytes went out** rather than counting every WhatsApp preview crawler that
           * fetches the page for a thumbnail.
           */
          const wantsBytes = file[2] !== undefined;

          if (!wantsBytes) {
            const peeked = await peekFileToken(pool, file[1]!);
            if (!peeked.ok) {
              const page = filePage(peeked.why);
              res.writeHead(peeked.why === 'expired' ? 410 : 404, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': Buffer.byteLength(page),
                'cache-control': 'no-store',
              });
              res.end(page);
              return;
            }

            const seen = await fetchEvidence(pool, evidenceRoot, peeked.subject.evidenceId);
            if (!seen.ok) {
              const page = filePage('missing');
              res.writeHead(404, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': Buffer.byteLength(page),
                'cache-control': 'no-store',
              });
              res.end(page);
              return;
            }

            /**
             * What the message said this was about, taken from the **same** function that built
             * the message — never a second wording.
             *
             * An officer sent four notices this week and tapping the wrong link must be able to
             * tell. `messageFor` is what `whatsappChannel` puts in the first template parameter,
             * so this heading is word for word what they already read on their lock screen.
             *
             * A failure here loses the heading and never the file: the page falls back to a
             * plain title, because a file an officer cannot open is a far worse outcome than a
             * file whose subject line is missing.
             */
            let about: string | null = null;
            try {
              const events = await loadIncident(pool, peeked.subject.incidentId);
              if (events.length > 0) {
                const state = foldIncident(peeked.subject.incidentId, events);
                const reported = events.find((e) => e.type === 'reported');
                about = messageFor(state, reported?.payload as never).what;
              }
            } catch {
              /* The heading is a courtesy. The file is the point. */
            }

            const page = fileReadyPage({
              filename: decodeURIComponent(seen.value.evidence.filename),
              contentType: seen.value.evidence.contentType,
              byteSize: seen.value.evidence.byteSize,
              token: file[1]!,
              about,
            });
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': Buffer.byteLength(page),
              'cache-control': 'no-store',
            });
            res.end(page);
            return;
          }

          const redeemed = await redeemFileToken(pool, file[1]!);
          if (!redeemed.ok) {
            // Two answers, never one. "Too old" and "not recognised" send an officer to two
            // different next actions, and a single "invalid" sends them to the telephone.
            const page = filePage(redeemed.why);
            res.writeHead(redeemed.why === 'expired' ? 410 : 404, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': Buffer.byteLength(page),
              'cache-control': 'no-store',
            });
            res.end(page);
            return;
          }

          const found = await fetchEvidence(pool, evidenceRoot, redeemed.subject.evidenceId);
          if (!found.ok) {
            const page = filePage('missing');
            res.writeHead(404, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': Buffer.byteLength(page),
              'cache-control': 'no-store',
            });
            res.end(page);
            return;
          }

          /**
           * **The one place this route differs from the authenticated download** — 2026-08-14.
           *
           * `/evidence/:id` serves everything as `application/octet-stream; attachment`, and that
           * is right for it: its caller is the app, on a laptop, saving a file. This link's
           * caller is an officer holding a phone inside WhatsApp's own browser, and a download
           * prompt there is a file most of them never open — which is precisely the fault the
           * district reported.
           *
           * So `OPENS_IN_PLACE` — JPEG and PDF only, decided on the **sniffed** type
           * (`ops/fileType.ts`), never on anything the uploading device claimed — is served with
           * its real type and `inline`. Every other guard is untouched and stays: `nosniff`, the
           * `default-src 'none'; sandbox` CSP, `no-store`, and the integrity headers. Anything
           * else keeps the old behaviour exactly.
           */
          const openable = OPENS_IN_PLACE.has(found.value.evidence.contentType);

          res.writeHead(200, {
            'content-type': openable
              ? found.value.evidence.contentType
              : 'application/octet-stream',
            'content-length': found.value.bytes.length,
            'content-disposition': `${openable ? 'inline' : 'attachment'}; filename="${encodeURIComponent(found.value.evidence.filename)}"`,
            'cache-control': 'no-store',
            'x-declared-type': found.value.evidence.contentType,
            'x-sha256': found.value.evidence.sha256,
            // Served either way, and never presented as verified — the same rule the
            // authenticated route follows. It may be the only copy of the notice.
            'x-integrity': found.value.intact ? 'verified' : 'MISMATCH',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          });
          res.end(found.value.bytes);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/health') {
          try {
            await pool.query('SELECT 1');
            // Backup freshness lives here because /health is the one endpoint anybody
            // actually checks. A backup that stopped working three weeks ago and told
            // nobody is the normal way this goes wrong (M0-37, ADR-0005).
            //
            // **Reported as `degraded`, never as a failing status code.** A 503 here would
            // take the node out of a load balancer and stop the district reporting
            // emergencies — because a backup was old. That trade is unacceptable in both
            // directions: INV-01 outranks a stale dump, and an operator who cannot file a
            // report has no way to know a backup was the reason. Liveness and the backup
            // obligation are different questions and this answers both separately.
            const backup = await backupHealth(pool);

            // Replication, for the same reason and with the same argument (M0-54, ADR-0011).
            // A standby that fell behind three weeks ago and told nobody is not a standby; it
            // is a comforting fiction, and the district finds out at the moment it is relied
            // on. `Safe` because `pg_stat_replication` needs `pg_monitor` — a permission on a
            // diagnostic must not be able to break the endpoint everything else keys off.
            const replication = await replicationHealthSafe(pool);

            /**
             * What shape this installation is, answerable **without signing in** — M6-44.
             *
             * Somebody asked to look at a district's system — a second person on the phone at
             * 02:00, or whoever is holding the restore drill — should be able to find out
             * whether the field intake is even switched on before hunting for a login. A
             * screen that is off looks exactly like a screen that is broken, and the two send
             * you to entirely different places.
             *
             * Safe unauthenticated because a capability is **not an authority boundary**: it
             * says which screens are offered, and every endpoint behind each of them still asks
             * the policy table (INV-05). Publishing it discloses nothing an attacker could not
             * learn by requesting the screens.
             */
            const capabilities = await loadCapabilities(pool).catch(() => null);

            json(res, 200, {
              ok: true,
              db: 'up',
              authMode,
              capabilities: capabilities?.state ?? null,
              // Whether the district decided this, or is running the shape it shipped with.
              capabilitiesChosen: capabilities?.chosen ?? false,
              // Either one degrades the node. Neither takes it out of service: INV-01
              // outranks both a stale dump and a lagging standby.
              degraded: !backup.ok || !replication.ok,
              backup,
              replication,
            });
          } catch {
            // A health check that hides a dead database is worse than none.
            json(res, 503, { ok: false, db: 'down', authMode });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/auth/login') {
          let body: { phone?: unknown; password?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            json(res, 400, { error: 'invalid json' });
            return;
          }

          if (typeof body.phone !== 'string' || typeof body.password !== 'string') {
            json(res, 400, { error: 'phone and password are required' });
            return;
          }

          /**
           * The source, taken from the socket and **never from a header**.
           *
           * `X-Forwarded-For` is written by whoever is asking. Trusting it here would let an
           * attacker send a different value on every request and never accumulate a single
           * failure — a rate limiter that an attacker can opt out of is worse than none,
           * because it is believed. ADR-0011 puts this on one machine in the DC office; if a
           * reverse proxy is ever put in front of it, this is the line that has to change,
           * deliberately and with the proxy's own address pinned.
           *
           * **It changed, in the release that shipped the proxy — M6-37, ADR-0017.** The
           * default is still exactly the rule above: with no pinned proxies, the header is not
           * read at all. `sourceAddress` carries the reasoning for the case where there is one,
           * and why the *last* hop is the one to take.
           */
          const source = sourceAddress(
            req.socket.remoteAddress,
            req.headers['x-forwarded-for'],
            trustedProxies,
          );

          // Read *before* the password is checked, so the delay attaches to the attempt and
          // cannot depend on whether the account exists. A delay that appeared only for real
          // numbers would be exactly the timing oracle `login` avoids by always hashing.
          const { delayMs } = throttle.decide(body.phone, source);
          await sleep(delayMs);

          // Bounded scrypt work. An emergency report must never queue behind a flood of
          // sign-in attempts on the district's one machine (INV-01).
          const phone = body.phone;
          const password = body.password;
          const slot = await withScryptSlot(() =>
            // Recorded here, never returned. See `LoginAttempt` — the response below stays a
            // single indistinguishable message, and this is the district reading its own door.
            login(pool, phone, password, (attempt) => {
              log('warn', 'sign-in refused', { ...attempt });
            }),
          );

          if (!slot.ran) {
            // Transient, and about the server rather than about anybody's account. Never a
            // state that follows an officer around — that is the lockout this design refuses.
            res.setHeader('retry-after', '5');
            json(res, 503, { error: 'too many sign-in attempts at once — try again in a moment' });
            return;
          }

          const result = slot.value;

          if (result === null) {
            throttle.fail(phone, source);
            // One message for every failure. Distinguishing "no such number" from "wrong
            // password" hands an attacker the list of real officers.
            json(res, 401, { error: 'invalid credentials' });
            return;
          }

          throttle.succeed(phone);

          res.setHeader(
            'set-cookie',
            sessionCookie(result.token, nodeEnv === 'production', SESSION_TTL_HOURS * 3600),
          );
          json(res, 200, { token: result.token, identity: result.identity });
          return;
        }

        /**
         * The sign-in link (ADR-0043). No session — the link is the credential. A GET only
         * reads whose link it is (WhatsApp fetches links to draw previews; that must spend
         * nothing); the POST, from the page's form, uses it.
         */
        const linkRoute = /^\/auth\/link\/([A-Za-z0-9_-]{20,100})$/.exec(url.pathname);
        if (linkRoute !== null) {
          const linkToken = linkRoute[1]!;
          if (req.method === 'GET') {
            const peeked = await peekLoginLink(pool, linkToken);
            if (!peeked.ok) json(res, 410, { error: peeked.message, reason: peeked.reason });
            else json(res, 200, { fullName: peeked.fullName });
            return;
          }
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }
          let body: { password?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            json(res, 400, { error: 'invalid json' });
            return;
          }
          if (typeof body.password !== 'string') {
            json(res, 400, { error: 'password is required' });
            return;
          }
          const newPassword = body.password;
          // Bounded scrypt work, like signing in: an emergency must never queue behind this.
          const slot = await withScryptSlot(() => redeemLoginLink(pool, linkToken, newPassword));
          if (!slot.ran) {
            res.setHeader('retry-after', '5');
            json(res, 503, { error: 'busy — try again in a moment' });
            return;
          }
          const redeemed = slot.value;
          if (!redeemed.ok) {
            json(res, redeemed.reason === 'weak' ? 400 : 410, {
              error: redeemed.message,
              reason: redeemed.reason,
            });
            return;
          }
          res.setHeader(
            'set-cookie',
            sessionCookie(redeemed.token, nodeEnv === 'production', SESSION_TTL_HOURS * 3600),
          );
          json(res, 200, { identity: redeemed.identity });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/auth/logout') {
          const token = readToken(req);
          if (token !== null) await revokeSession(pool, token);
          res.setHeader('set-cookie', sessionCookie('', nodeEnv === 'production', 0));
          json(res, 200, { ok: true });
          return;
        }

        // Change my own password (ADR-0032). Session-gated, every role, no console needed.
        // The current password is required; on success every OTHER session for this person
        // is dropped and the caller's is kept.
        if (req.method === 'POST' && url.pathname === '/auth/password') {
          const token = readToken(req);
          if (token === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          let body: { currentPassword?: unknown; newPassword?: unknown };
          try {
            body = JSON.parse(await readBody(req)) as typeof body;
          } catch {
            json(res, 400, { error: 'invalid json' });
            return;
          }
          if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
            json(res, 400, { error: 'currentPassword and newPassword are required' });
            return;
          }
          const outcome = await changeOwnPassword(
            pool,
            token,
            body.currentPassword,
            body.newPassword,
          );
          if (!outcome.ok) {
            json(res, outcome.reason === 'no-session' ? 401 : 400, { error: outcome.message });
            return;
          }
          json(res, 200, { ok: true });
          return;
        }

        // Everything below requires a session. There is no path around this check, and no
        // reliance on the UI hiding anything (INV-05).
        //
        // **`/notifications` was here and is gone — ADR-0018, M7-02.** It served an inbox for
        // seat holders, and settlement meant one of them opening the app. Nobody outside the
        // control room signs in, so every obligation it created aged into a permanent unmet
        // one. The ledger it read is untouched; what is deleted is the surface nobody would
        // ever look at.

        /**
         * The dashboard (M4).
         *
         * One feed, for one app, scoped to whoever asked. The DC and AC Headquarter offices
         * get the district; a department gets its own work, alongside the district-wide facts
         * everybody needs — the weather, the utilities, the published numbers.
         *
         * It is the same endpoint on a phone, a desk PC and a screen on an office wall. What
         * changes with the device is the *layout*, in the browser, and nothing else.
         */
        /**
         * How to reach a department (M5).
         *
         * Behind a session and deliberately not scoped further: the person who needs to ring
         * Rescue at 02:00 is whoever is awake, not whoever holds the right department. The
         * numbers never reach the dashboard, which is the screen a room can read.
         */
        if (url.pathname.startsWith('/contacts/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          writeContacts(res, await handleContacts(pool, req, url.pathname, identity));
          return;
        }

        /**
         * What happened over a chosen period (capability 9).
         *
         * The console's performance table is a rolling window of recent arrivals, for the two
         * offices. This answers "how did we do in July", for whoever asks, scoped to what
         * their seat may see — same medians, same authority, a window they choose.
         */
        if (url.pathname === '/summary') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const seat = seatOf(identity);

          /**
           * 🔴 **Whole district days, through `parseRange` — M11-28, and this was a real defect.**
           *
           * It used to hand `?from=&to=` straight to `windowFor`, which takes **instants** — and
           * `Date.parse('2026-07-01')` is a perfectly good instant, **UTC midnight**. Bajaur is
           * UTC+05:00, so a district asking for July got 1 July **05:00 Bajaur** to 31 July
           * **05:00 Bajaur**: nineteen hours of the month missing, five hours of June included,
           * and `period` reporting that window confidently.
           *
           * **Nothing in `web/src/` had ever called this route**, which is why nobody had seen
           * it — and is exactly why M11-28 is "give it a door" rather than "wire it up". A
           * malformed date is a **400**, the same answer `/reports/*` and the board already give.
           */
          const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
          if (!range.ok) {
            json(res, 400, { error: range.error });
            return;
          }

          json(
            res,
            200,
            await districtSummaryFor(
              pool,
              seat,
              { from: range.range.from, to: range.range.to },
              new Date(),
              { fromDate: range.range.fromDate, toDate: range.range.toDate },
            ),
          );
          return;
        }

        /**
         * The board's doorbell — replaces the 10-second poll with a push, without re-deriving
         * `buildBoard`'s scoping in a second place.
         *
         * A connection here is told **only that something changed**, never what. The client's
         * response to that is to call `GET /incidents` — the exact request the poll it replaces
         * already made — so every authorisation guarantee that endpoint has stays exactly where
         * it was proven correct (see `boardStream.ts` for the full reasoning).
         *
         * `req.socket.setTimeout(0)` disables Node's per-socket idle timeout for this one
         * connection — with no heartbeat this would otherwise be silently cut by Node's default
         * after a period of inactivity, which on a quiet night is the common case, not the rare
         * one. The heartbeat comment line below is the second, independent reason this stays
         * open: some proxies time out an idle response even with the socket timeout disabled.
         *
         * Nothing here can throw past `announceBoardChange`, which never throws by contract —
         * so a slow or broken tab cannot slow down the write that woke it.
         */
        if (url.pathname === '/board/live') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          req.socket.setTimeout(0);
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          // Told once, immediately: a client that opens this while already stale (INV-02's
          // banner has fired) should not wait for the next actual change to be told the stream
          // itself is alive.
          res.write('retry: 3000\n\n');

          let pending: NodeJS.Timeout | null = null;
          const tell = (): void => {
            // Coalesced, not throttled: a batch sync landing as ten events is one board change,
            // not ten redraws. 200ms is short enough that a control room reads it as instant and
            // long enough to gather a whole batch behind one push.
            if (pending !== null) return;
            pending = setTimeout(() => {
              pending = null;
              res.write('event: changed\ndata: {}\n\n');
            }, 200);
          };
          const unsubscribe = onBoardChange(tell);

          // Keeps an idle connection from being reclaimed by anything between here and the
          // browser — a proxy, a corporate firewall on a phone network — none of which this
          // process controls. A `:` line is a comment in the SSE wire format: EventSource never
          // surfaces it as an event, so it costs nothing on the client.
          const heartbeat = setInterval(() => {
            res.write(': keepalive\n\n');
          }, 25_000);

          const cleanup = (): void => {
            clearInterval(heartbeat);
            if (pending !== null) clearTimeout(pending);
            unsubscribe();
          };
          req.on('close', cleanup);
          res.on('error', cleanup);
          return;
        }

        /**
         * Finding an old emergency (capability 9).
         *
         * ⚠️ The board was the last seven days when this was written; it is the Record now and
         * keeps everything (ADR-0021). Everything before that was reachable only by
         * already knowing its incident id. Same seat, same projection as the board — search
         * decides which incidents, never what they say.
         */
        if (url.pathname === '/search') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const seat = seatOf(identity);

          const limitParam = Number(url.searchParams.get('limit'));

          json(
            res,
            200,
            await search(pool, seat, {
              text: url.searchParams.get('q') ?? undefined,
              from: url.searchParams.get('from') ?? undefined,
              to: url.searchParams.get('to') ?? undefined,
              status: url.searchParams.get('status') ?? undefined,
              limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
            }),
          );
          return;
        }

        /**
         * Incidents out, as a spreadsheet (capability 9).
         *
         * The mitigation for the double entry that Q-01/Q-02 chose when the district decided
         * to integrate with nothing. Same seat, same `buildBoard`, same authority — a second
         * query would eventually disagree with the board about a district's own emergencies.
         */
        /**
         * The two reports the district asked for, by date range — M7-27/28/29/30.
         *
         * One handler for both, because they differ in nothing but which projection they run:
         * same session, same seat, same authority, same range, same refusal-rather-than-
         * truncation rule. Two handlers would be two places for the scoping to drift, on files
         * that get emailed onward.
         */
        /**
         * One day, for a human and for a spreadsheet — M9-46…51.
         *
         * `?date=YYYY-MM-DD` (defaulting to the district's today) and `?format=csv` for the
         * spreadsheet. **HTML is the default** because the reader is a person before it is a
         * tool: this is the thing somebody prints at 08:00 and puts in front of the DC, and
         * ADR-0007 refuses a PDF library — the browser has a renderer and the printed page is
         * then the same document that was on screen.
         *
         * Authority is the incident's, per incident, inside `dailyReport`. There is no separate
         * report permission to fall out of step with it (INV-05), and the owner's answer was
         * **both** tiers: the administration takes the district's day, a department its own.
         */
        if (url.pathname === '/reports/daily') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const built = await dailyReport(pool, identity, url.searchParams.get('date'));
          if (!built.ok) {
            json(res, built.status, { error: built.error });
            return;
          }

          /**
           * **`?format=json` — the same day, for the app to draw itself (M11-27, server half).**
           *
           * The district asked to read its reports **inside** the software rather than only by
           * downloading them. This is the half of that which can ship on its own: it emits
           * nothing into `web/dist`, so it needs no `CACHE` bump and changes nothing on any
           * screen until a client renders it — the same property that made M10-03's server half
           * safe to deploy while another agent held the shell's version string.
           *
           * ⚠️ **HTML and CSV are untouched, and that is a requirement rather than caution.**
           * The HTML page *is* what `Print → Save as PDF` produces — ADR-0007 refuses a PDF
           * library precisely so the printed page is the page that was read — and the CSV is what
           * the district already emails onward. M11-29: nothing that downloads today stops
           * downloading.
           *
           * It returns `built.report` **as it stands**, with no reshaping. Every renderer here
           * reads the same object, including `summary`, which `domain/dailyReport.ts` writes
           * itself precisely so the printed page, the spreadsheet and any later screen cannot
           * each summarise one day differently.
           */
          if (url.searchParams.get('format') === 'json') {
            json(res, 200, built.report);
            return;
          }

          const csv = url.searchParams.get('format') === 'csv';
          const body = csv ? dailyCsv(built.report) : dailyHtml(built.report);
          const name = `daily-${built.report.date}.csv`;

          res.writeHead(200, {
            'content-type': csv ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            // The spreadsheet downloads; the page opens. A report nobody can read without
            // saving it first is a report nobody reads.
            ...(csv ? { 'content-disposition': `attachment; filename="${name}"` } : {}),
            'cache-control': 'no-store',
          });
          res.end(body);
          return;
        }

        if (
          url.pathname === '/export/acknowledgements.csv' ||
          url.pathname === '/export/resolutions.csv'
        ) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const seat = seatOf(identity);

          const parsed = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
          if (!parsed.ok) {
            json(res, 400, { error: parsed.error });
            return;
          }

          const acknowledgements = url.pathname === '/export/acknowledgements.csv';
          const report = acknowledgements
            ? await acknowledgementReport(pool, seat, parsed.range)
            : await resolutionReport(pool, seat, parsed.range);

          const body = acknowledgements
            ? acknowledgementCsv(
                report.rows as readonly AcknowledgementRow[],
                parsed.range,
                report.truncated,
              )
            : resolutionCsv(
                report.rows as readonly ResolutionRow[],
                parsed.range,
                report.truncated,
              );

          // Named after the range, so three downloads in a morning are three files somebody
          // can tell apart in a folder six weeks later.
          const name = `${acknowledgements ? 'acknowledgements' : 'resolutions'}-${parsed.range.fromDate}-to-${parsed.range.toDate}.csv`;

          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'content-disposition': `attachment; filename="${name}"`,
            'cache-control': 'no-store',
          });
          res.end(body);
          return;
        }

        if (url.pathname === '/export/incidents.csv') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          const seat = seatOf(identity);

          /**
           * `?from=&to=` when the district names a period, `?days=` otherwise — M7-27.
           *
           * Both, and not a replacement, because they answer different questions. A district
           * reports on **July**; an operator glancing at a screen wants **the last week**. A
           * rolling window cannot express the first, and dates are clumsy for the second.
           *
           * `days` stays bounded for the same reason it always was: a range nobody chose is a
           * range that grows until the export starts refusing, and 366 keeps a year reachable.
           */
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          const dated = from !== null || to !== null;

          const parsed = parseRange(from, to);
          if (dated && !parsed.ok) {
            json(res, 400, { error: parsed.error });
            return;
          }

          const requested = Number(url.searchParams.get('days') ?? 30);
          const days =
            dated && parsed.ok
              ? parsed.range.days
              : Number.isFinite(requested)
                ? Math.min(Math.max(requested, 1), 366)
                : 30;

          const board = await buildBoard(pool, seat, {
            days,
            // One more than the cap, so hitting it is detectable rather than assumed.
            limit: EXPORT_LIMIT + 1,
            includeClosed: true,
          });

          /**
           * The dated form filters to the range **after** the fold, on `occurredAt`.
           *
           * `buildBoard` selects by how recently an incident was *recorded*, which is right for
           * a screen and wrong for a period report: an emergency captured offline in March and
           * delivered in August belongs in March (ADR-0002), and filtering on arrival would
           * make the district's worst weeks — when devices were offline longest — the weeks
           * that report emptiest.
           */
          const scoped =
            dated && parsed.ok
              ? {
                  ...board,
                  incidents: board.incidents.filter(
                    (i) =>
                      // Null only for an incident with no `reported` event at all. It cannot be
                      // placed in any range, so it is left out rather than filed under a date
                      // nobody chose.
                      i.occurredAt !== null &&
                      i.occurredAt >= parsed.range.from &&
                      i.occurredAt <= parsed.range.to,
                  ),
                }
              : board;

          const reply = buildExport(scoped, days, board.incidents.length > EXPORT_LIMIT);

          if (reply.status !== 200) {
            json(res, reply.status, { error: reply.error });
            return;
          }

          res.writeHead(200, {
            'content-type': reply.contentType,
            'content-length': Buffer.byteLength(reply.body),
            'content-disposition': `attachment; filename="${reply.filename ?? 'incidents.csv'}"`,
            'cache-control': 'no-store',
          });
          res.end(reply.body);
          return;
        }

        /**
         * The district's performance, as a spreadsheet — M6-12.
         *
         * **The same medians the console shows**, from the same `computePerformance`. A second
         * calculation would eventually put a different median for one department in the file
         * submitted upward and on the screen argued about in the room, and two numbers for one
         * department is worse than neither.
         *
         * Behind `districtPerformance`'s own authority check, which is administration-only —
         * this is the comparison table, and a department downloading everybody else's response
         * times is a different product.
         */
        if (url.pathname === '/export/performance.csv') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!requireSeat(res, identity)) return;
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }

          // Same two forms as the incident export, for the same reason (M7-27): a district
          // reports on July, an operator glances at the last week.
          const parsed = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
          const dated =
            url.searchParams.get('from') !== null || url.searchParams.get('to') !== null;
          if (dated && !parsed.ok) {
            json(res, 400, { error: parsed.error });
            return;
          }

          const requested = Number(url.searchParams.get('days') ?? 30);
          const days =
            dated && parsed.ok
              ? parsed.range.days
              : Number.isFinite(requested)
                ? Math.min(Math.max(requested, 1), 366)
                : 30;

          const performance = await districtPerformance(pool, identity, { days });
          if (!performance.ok) {
            json(res, performance.status, { error: performance.error });
            return;
          }

          const reply = buildPerformanceExport(performance.value);
          res.writeHead(200, {
            'content-type': reply.contentType,
            'content-length': Buffer.byteLength(reply.body),
            'content-disposition': `attachment; filename="${reply.filename ?? 'performance.csv'}"`,
            'cache-control': 'no-store',
          });
          res.end(reply.body);
          return;
        }

        if (url.pathname === '/dashboard') {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (!requireSeat(res, identity)) return;

          writeDashboard(
            res,
            await handleDashboard(pool, req, identity, { whatsappConfigured: whatsapp !== null }),
          );
          return;
        }

        /**
         * What the district reports about itself (M4-02, M4-03).
         *
         * Behind a session. The scoping — a department reports its own, the two offices may
         * report anyone's — lives inside `api/status.ts`, in one function, for the same
         * reason the roster's does: one place to audit (INV-05).
         */
        if (url.pathname === '/status' || url.pathname.startsWith('/status/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (!requireSeat(res, identity)) return;

          const body = req.method === 'POST' ? await bodyOf(req) : null;

          writeStatus(res, await handleStatus(pool, req, url.pathname, identity, body));
          return;
        }

        // The administration console (M1a). Behind a session; the authority check itself
        // lives inside each handler in `api/admin.ts`.
        if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleAdmin(pool, req, res, url.pathname, identity, backupDirectory, nightlyNow());
          return;
        }

        // The Settings panel (ADR-0032). Behind a session; each `api/settings.ts` function
        // asks `requirePermission` for itself, and `guardSubject` protects the owner in the
        // handler — never here (INV-05).
        if (url.pathname === '/settings' || url.pathname.startsWith('/settings/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleSettings(pool, req, res, url, identity, linkDepsFor(req));
          return;
        }

        // Fetching one file. Scoped by the incident it belongs to, resolved inside.
        const evidenceFile = /^\/evidence\/([^/]+)$/.exec(url.pathname);
        if (evidenceFile !== null) {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'method not allowed' });
            return;
          }
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);
          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }
          if (!UUID_RE.test(evidenceFile[1]!)) {
            json(res, 404, { error: 'no such evidence' });
            return;
          }

          const reply = await download(pool, evidenceRoot, res, evidenceFile[1]!, identity);
          if (reply !== null && !reply.ok) json(res, reply.status, { error: reply.error });
          return;
        }

        // What a department can send (M1-02). Same gate as the roster.
        if (url.pathname === '/fleet' || url.pathname.startsWith('/fleet/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleFleet(pool, req, res, url.pathname, identity);
          return;
        }

        // The roster (M1a-10). Behind a session; a department may edit its own, the two
        // offices may edit any. The scoping itself lives in `api/roster.ts` → `reach`.
        if (url.pathname === '/roster' || url.pathname.startsWith('/roster/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleRoster(pool, req, res, url.pathname, identity);
          return;
        }

        const incidentRoute = matchIncidentRoute(url.pathname);

        if (incidentRoute !== null) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveSession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (!requireSeat(res, identity)) return;

          await handleIncidents(
            pool,
            req,
            res,
            incidentRoute,
            identity,
            evidenceRoot,
            url.searchParams.get('format') === 'text',
            url.searchParams.get('closed') === '1',
            whatsappSender,
            url.searchParams.get('date'),
            url.searchParams.get('withdrawn') === '1',
            url.searchParams.get('sort'),
            url.searchParams.get('open') === '1',
            whatsapp,
            options.whatsappFetch,
          );
          return;
        }

        // Activities (ADR-0039) — open to a `member` on purpose, so it calls the ungated
        // resolver. Every action asks the Activities permissions for itself (`api/activities.ts`).
        if (url.pathname === '/activities' || url.pathname.startsWith('/activities/')) {
          const token = readToken(req);
          const identity = token === null ? null : await resolveAnySession(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          await handleActivities(
            pool,
            req,
            res,
            url,
            identity,
            activitiesRoot,
            activitiesBackup,
            options.onVideoUploaded,
            senderTeller(pool, whatsapp, options.whatsappFetch ?? fetch),
            linkDepsFor(req),
          );
          return;
        }

        if (url.pathname === '/auth/me' || url.pathname === '/sync') {
          const token = readToken(req);
          // `/auth/me` is open to a member (ADR-0038): the client needs the role to know which
          // screen to draw. `/sync` is the incident record, and is not.
          const resolve = url.pathname === '/auth/me' ? resolveAnySession : resolveSession;
          const identity = token === null ? null : await resolve(pool, token);

          if (identity === null) {
            json(res, 401, { error: 'authentication required' });
            return;
          }

          if (url.pathname === '/auth/me') {
            /**
             * The identity, and what this installation offers — ADR-0016, M6-43.
             *
             * Sent together because the client needs both to draw a navigation bar, and a
             * second request for the capability set is a second thing that can be half-loaded
             * on a bad connection — leaving an officer looking at a menu that is missing tabs
             * for a reason nobody can see.
             *
             * The client **hides** tabs from this. It does not enforce anything, and neither
             * does this field: every endpoint behind every hidden screen still asks the policy
             * table (INV-05).
             */
            json(res, 200, {
              identity,
              capabilities: (await loadCapabilities(pool).catch(() => null))?.state ?? null,
            });
            return;
          }

          if (req.method === 'POST') {
            // Any authenticated account may push what it captured. Since ADR-0018/0024 the only
            // accounts that sign in are the control room's, and ADR-0032 mints them by role with
            // no seat — so a report from a seatless control-room account records `actorSeatId`
            // null and `actorPersonId` as the true attribution, which is exactly what the
            // `acknowledged` event's own schema has always allowed.
            await handlePush(pool, res, await readBody(req), identity);
            return;
          }

          if (req.method === 'GET') {
            await handlePull(pool, res, url);
            return;
          }

          json(res, 405, { error: 'method not allowed' });
          return;
        }

        // Static assets last, so an API route can never be shadowed by a file on disk.
        if (webRoot !== undefined && req.method === 'GET') {
          // The sign-in link's page (ADR-0043): one static page for every token, which reads
          // the token from its own address.
          if (/^\/set-password\/[A-Za-z0-9_-]{20,100}$/.test(url.pathname)) {
            if (await serveStatic(webRoot, res, '/set-password.html')) return;
          }
          if (await serveStatic(webRoot, res, url.pathname)) return;
          // Unknown path with no matching file: fall back to the shell so client-side
          // routes work, both online and from the service worker cache.
          if (req.headers.accept?.includes('text/html') === true) {
            if (await serveStatic(webRoot, res, '/')) return;
          }
        }

        json(res, 404, { error: 'not found' });
      } catch (err) {
        // ADR-0038: a member reached an operational route. Refused, not an error.
        if (err instanceof MemberRefused) {
          if (!res.headersSent) json(res, 403, { error: MEMBER_REFUSED });
          return;
        }
        // Never leak internals to a caller, but never swallow the cause either. The
        // correlation id is already on this line, so the 500 an operator saw can be found.
        log('error', 'unhandled request error', {
          method: req.method,
          path: safePath(req.url),
          error: String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        json(res, 500, { error: 'internal error' });
      } finally {
        logRequest(req, res, startedAt);
      }
    });
  });
}

/**
 * The path, without the query string.
 *
 * `GET /sync?cursor=` is harmless, but a query string is the easiest place for something
 * that should not be in a log to end up later. Dropping it costs one diagnostic detail and
 * removes a whole category of accident.
 */
function safePath(url: string | undefined): string {
  const raw = url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * One line per request, at the end, with the outcome.
 *
 * Deliberately not one line at the start as well: doubling the volume to record that a
 * request was received buys nothing that the completion line does not already say, and a
 * log nobody can read is a log nobody reads.
 *
 * **Successful noise is filtered.** Monitoring polls `/health` continuously and the PWA
 * fetches its own assets on every launch; logging those at `info` would bury the requests
 * that matter. They are logged when they fail, which is the case anyone ever looks for.
 */
function logRequest(req: IncomingMessage, res: ServerResponse, startedAt: number): void {
  const path = safePath(req.url);
  const status = res.statusCode;

  const routine =
    status < 400 && (path === '/health' || path === '/' || /\.[a-z0-9]+$/i.test(path));
  if (routine) return;

  log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
    method: req.method,
    path,
    status,
    ms: Date.now() - startedAt,
  });
}
