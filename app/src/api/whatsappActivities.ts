/**
 * WhatsApp → Activities (ADR-0040, amended by ADR-0041 — Bajaur phases D and E1).
 *
 * Officers already send their activity pictures over WhatsApp, so a photo, video or voice note
 * sent to the district's number becomes an Activities post. The same number carries emergency
 * alerts, and an officer's photo in reply to one has been evidence on that emergency since
 * 2026-08-21 — the two must not be confused, so this decides **before** today's path runs:
 *
 *   * **The sender has an open emergency** (the incident today's path would attach it to is not
 *     resolved or closed) → the media is held and the officer is asked, with two buttons:
 *     *Emergency report* / *Daily activity*. *Emergency report* runs **exactly today's path**
 *     (`recordReply` in `webhooks.ts`) with the bytes already fetched; *Daily activity* posts it.
 *     **No tap within an hour → today's path as well** (ADR-0041 §3): only the officer's own
 *     *Daily activity* tap ever puts it in Activities, so no report lands there by default.
 *   * **No open emergency, and the number belongs to one person** — a Directory contact or an
 *     account, no login needed (ADR-0041 §1) → straight onto a post under that person, in their
 *     default department, or in "General" if they have none (§2).
 *   * **Otherwise** (an unknown number, or a person who may not post) → the DC's Pending list,
 *     where the DC approves, adds the number to the Directory, or rejects (hard delete).
 *
 * An unknown number that has had no alert from us is not dropped either (ADR-0041 §5): its words,
 * files and places go to the Pending list as **messages**, so nothing sent to the number is lost.
 *
 * Media from one sender within five minutes is one post (an album). It is downloaded from Meta on
 * arrival, because Meta's links expire, and kept under the Activities root like every other
 * Activities file.
 *
 * ## What this never does
 *
 * It never writes to the incident log or `evidence` itself — the emergency branch hands the media
 * to `recordReply`, which is the one writer of that record. And it never loses an emergency's
 * picture: a file that cannot be fetched or is not one Activities accepts, from a sender with an
 * open emergency, goes down today's path at once (which names the failure on the incident); a
 * question that cannot be sent, or is not answered, does the same.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { loadIncident } from '../db/eventStore.js';
import { lastMessageTo, messageById, sessionWindowOpen } from '../db/whatsappStore.js';
import { referenceFor } from '../db/referenceStore.js';
import { foldIncident } from '../domain/incident.js';
import { formatReference } from '../domain/reference.js';
import { districtDate } from '../domain/districtTime.js';
import { resolvePermissions, type Role } from '../domain/roles.js';
import { decideType } from '../ops/fileType.js';
import {
  downloadMedia,
  sendSession,
  toE164,
  type InboundLocation,
  type InboundMedia,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import { log } from '../obs/log.js';
import {
  AUDIO_TYPES,
  EXT,
  IS_CONTACT_SQL,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_PER_POST,
  MAX_PHOTOS_PER_POST,
  MAX_PHOTO_BYTES,
  MAX_VIDEOS_PER_POST,
  MAX_VIDEO_BYTES,
  PHOTO_TYPES,
  RETENTION_DAYS,
  VIDEO_TYPES,
  inside,
  removeFiles,
  writeLog,
  type ActivitiesResult,
} from './activities.js';
import { addContact } from './roster.js';
import { loadOverrides, permissionsOf } from './settings.js';

/** Media from one sender within this many minutes of the last is one post (ADR-0040 §4). */
export const ALBUM_MINUTES = 5;

/** How long the officer has to tap before the media goes to the emergency (ADR-0041 §3). */
export const ANSWER_MINUTES = 60;

/** A tap being applied for longer than this was interrupted; the DC decides instead. */
const STUCK_MINUTES = 10;

/** The caption of a post whose media came with no words. `activity_post.caption` is required. */
export const NO_CAPTION = 'Sent on WhatsApp';

/** The department a known sender with none of their own posts under (ADR-0041 §2). */
export const GENERAL_UNIT = 'General';

/** ADR-0040 §6, verbatim. */
export const ADDED_REPLY = 'Received — added to Activities.';

/** Said once when media goes to the Pending list, so the sender is not left wondering. */
export const PENDING_REPLY = 'Received — the DC office will add it to Activities.';

/** Said once when an unknown number's words reach the Pending list (ADR-0041 §5). */
export const MESSAGE_REPLY = 'Received — the DC office will see your message.';

/** The two buttons' ids start with this. Never one of `webhooks.ts`'s own prefixes. */
export const CHOICE_PREFIX = 'wact';

/** Meta allows twenty characters on a button title, so the incident number goes in the text. */
export const EMERGENCY_BUTTON = 'Emergency report';
export const ACTIVITY_BUTTON = 'Daily activity';

/**
 * Why something waits for the DC. `no_department` and `no_answer` are no longer produced (ADR-0041
 * §2–§3) but rows written before it still carry them.
 */
export type PendingReason = 'unknown_sender' | 'no_department' | 'not_allowed' | 'no_answer';

type FileKind = 'photo' | 'video' | 'audio';

/** What the server hands this module. Absent: the feature is switched off (ADR-0040). */
export interface WhatsAppActivities {
  /** The Activities root — the same directory `api/activities.ts` uses. */
  readonly root: string;
  /** Wakes the video converter when a video is ready for it. */
  readonly onVideo?: () => void;
}

/** One inbound message, as much of it as this module reads. */
export interface InboundForActivities {
  readonly fromPhone: string;
  /** Meta's id for the officer's message — what makes a retried webhook harmless. */
  readonly messageId: string | null;
  readonly text: string;
  readonly at: string;
  readonly tapped?: boolean;
  readonly media?: InboundMedia;
  readonly location?: InboundLocation;
  readonly reaction?: unknown;
  readonly replyId?: string;
  readonly replyContextId?: string;
}

/** The bytes, already fetched, handed to today's path so it does not fetch them again. */
export interface Prefetched {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sha256: string | null;
}

/** Today's evidence path (`recordReply`), as the emergency branch calls it. */
export type EmergencyPath = (input: {
  readonly text: string;
  readonly at: string;
  readonly media: InboundMedia;
  readonly prefetched: Prefetched;
  readonly replyContextId?: string;
  /** Tapped *Emergency report*, did not answer within the hour, or was never asked. */
  readonly why: 'tapped' | 'unanswered' | 'unasked';
}) => Promise<void>;

/** Today's evidence path for one sender — what the sweep needs when an hour runs out. */
export type EmergencyPathFor = (fromPhone: string) => EmergencyPath;

interface Context {
  readonly pool: Pool;
  readonly config: WhatsAppConfig;
  readonly fetchImpl: typeof fetch;
  readonly activities: WhatsAppActivities;
  readonly emergency: EmergencyPath;
}

/** One file, fetched and checked, not yet anywhere. */
interface Arrived {
  readonly kind: FileKind;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly caption: string | null;
  readonly messageId: string | null;
  readonly replyContextId: string | null;
  readonly at: string;
}

/** Words (or a file's name, or a place) from an unknown number — no file is kept. */
interface Message {
  readonly body: string;
  readonly messageId: string | null;
  readonly at: string;
}

const TYPES: Readonly<Record<FileKind, ReadonlySet<string>>> = {
  photo: PHOTO_TYPES,
  video: VIDEO_TYPES,
  audio: AUDIO_TYPES,
};
const MAX_BYTES: Readonly<Record<FileKind, number>> = {
  photo: MAX_PHOTO_BYTES,
  video: MAX_VIDEO_BYTES,
  audio: MAX_AUDIO_BYTES,
};
const PER_POST: Readonly<Record<FileKind, number>> = {
  photo: MAX_PHOTOS_PER_POST,
  video: MAX_VIDEOS_PER_POST,
  audio: MAX_AUDIO_PER_POST,
};
const NOUN: Readonly<Record<FileKind, string>> = {
  photo: 'picture',
  video: 'video',
  audio: 'voice note',
};

function fileKindOf(media: InboundMedia | undefined): FileKind | null {
  if (media === undefined) return null;
  if (media.kind === 'image') return 'photo';
  if (media.kind === 'video') return 'video';
  if (media.kind === 'voice' || media.kind === 'audio') return 'audio';
  return null;
}

//------------------------------------------------------------------------------
// The webhook's question: is this one ours?
//------------------------------------------------------------------------------

/**
 * Take this inbound for Activities, or say it is not ours.
 *
 * Returns `true` when it was handled here (including a duplicate Meta retried) and `false` when
 * the caller must go on down today's path exactly as before. Never throws on a provider's
 * failure: like the rest of the webhook, a bad minute at Meta must not cost the district a 500.
 */
export async function takeForActivities(
  ctx: Context,
  reply: InboundForActivities,
): Promise<boolean> {
  const phone = toE164(reply.fromPhone);

  if (reply.replyId !== undefined && reply.replyId.startsWith(`${CHOICE_PREFIX}:`)) {
    await applyChoice(ctx, phone, reply.replyId);
    return true;
  }

  const kind = fileKindOf(reply.media);
  if (kind === null) return takeMessage(ctx, phone, reply);
  const media = reply.media!;

  if (reply.messageId !== null && (await alreadyHave(ctx.pool, reply.messageId))) return true;

  const open = await openEmergencyFor(ctx.pool, phone, reply.replyContextId);

  const got = await downloadMedia(ctx.config, media.mediaId, ctx.fetchImpl);
  if (!got.ok) {
    // An emergency's picture is never lost: today's path fetches again and, if it still cannot,
    // names the failure on the incident (INV-03).
    if (open !== null) return false;
    log('warn', 'whatsapp activity media could not be fetched', { failure: got.failure });
    await tell(ctx, phone, `Your ${NOUN[kind]} could not be received. Please send it again.`);
    return true;
  }

  const verdict = decideType(got.contentType, got.bytes, TYPES[kind]);
  const tooLarge = got.bytes.length > MAX_BYTES[kind];
  if (!verdict.ok || tooLarge) {
    // Evidence accepts more kinds than Activities does; an emergency's file goes there as today.
    if (open !== null) return false;
    log('warn', 'whatsapp activity media was refused', {
      kind,
      why: verdict.ok ? 'too large' : verdict.why,
    });
    await tell(
      ctx,
      phone,
      kind === 'photo'
        ? 'This picture could not be added to Activities. Please send it as a photo (JPEG).'
        : kind === 'video'
          ? 'This video could not be added to Activities. Please send it as an MP4 video.'
          : 'This voice note could not be added to Activities. Please record it again.',
    );
    return true;
  }

  const arrived: Arrived = {
    kind,
    contentType: verdict.contentType,
    bytes: got.bytes,
    sha256: createHash('sha256').update(got.bytes).digest('hex'),
    caption: reply.text.trim() === '' ? null : reply.text.trim(),
    messageId: reply.messageId,
    replyContextId: reply.replyContextId ?? null,
    at: reply.at,
  };

  if (open !== null) {
    await holdAndAsk(ctx, phone, open, arrived);
    return true;
  }

  const sender = await senderOf(ctx.pool, phone);
  if (sender.ok) {
    const fresh = await postDirect(ctx, phone, sender, arrived);
    if (fresh) await tell(ctx, phone, ADDED_REPLY);
  } else {
    const fresh = await holdPending(ctx, phone, sender.reason, sender.personId, arrived);
    if (fresh) await tell(ctx, phone, PENDING_REPLY);
  }
  return true;
}

/**
 * Words, a file or a place from a number that is **nobody's** and has had **no alert from us** —
 * the one inbound today's path drops (`recordReply`: "no recent message to match it to"). It goes
 * to the Pending list as a message instead (ADR-0041 §5). Everything else is not ours: a reply to
 * an alert, a tap, a reaction, and anything from a known person take today's path unchanged.
 */
async function takeMessage(
  ctx: Context,
  phone: string,
  reply: InboundForActivities,
): Promise<boolean> {
  if (reply.tapped === true || reply.replyId !== undefined || reply.reaction !== undefined) {
    return false;
  }
  const body = messageBody(reply);
  if (body === null) return false;

  const named =
    reply.replyContextId === undefined ? null : await messageById(ctx.pool, reply.replyContextId);
  if (named !== null && named.toPhone === phone) return false;
  if ((await lastMessageTo(ctx.pool, phone)) !== null) return false;
  if ((await senderOf(ctx.pool, phone)).personId !== null) return false;

  if (reply.messageId !== null && (await alreadyHave(ctx.pool, reply.messageId))) return true;

  const { fresh } = await forSender(ctx.pool, phone, (client) =>
    intoInbound(client, ctx.activities.root, pendingGroup(client, phone, 'unknown_sender', null), {
      body,
      messageId: reply.messageId,
      at: reply.at,
    }),
  );
  if (fresh) await tell(ctx, phone, MESSAGE_REPLY);
  return true;
}

/** What an unknown number sent, in words a person reads. Null for nothing worth keeping. */
function messageBody(reply: InboundForActivities): string | null {
  const parts: string[] = [];
  if (reply.text.trim() !== '') parts.push(reply.text.trim());
  if (reply.media !== undefined) {
    parts.push(
      reply.media.kind === 'sticker'
        ? '(sent a sticker)'
        : `(sent a file${reply.media.filename === null ? '' : `: ${reply.media.filename}`})`,
    );
  }
  if (reply.location !== undefined) {
    const l = reply.location;
    parts.push(
      `(shared a location: ${[
        l.name,
        l.address,
        `${l.latitude.toFixed(6)}, ${l.longitude.toFixed(6)}`,
      ]
        .filter((p): p is string => p !== null && p !== '')
        .join(' — ')})`,
    );
  }
  return parts.length === 0 ? null : parts.join('\n').slice(0, 4000);
}

/** A message Meta already delivered once — held, posted, or on the Pending list. */
async function alreadyHave(pool: Pool, messageId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM activity_media WHERE wa_message_id = $1
     UNION ALL
     SELECT 1 FROM activity_inbound_media WHERE wa_message_id = $1`,
    [messageId],
  );
  return (rowCount ?? 0) > 0;
}

interface OpenEmergency {
  readonly incidentId: string;
  readonly providerMessageId: string;
}

/**
 * The incident today's path would attach this media to — matched exactly as `recordReply` matches
 * it (the message they replied to, or the most recent alert to that number) — if it is still open.
 */
async function openEmergencyFor(
  pool: Pool,
  phone: string,
  replyContextId: string | undefined,
): Promise<OpenEmergency | null> {
  const named = replyContextId === undefined ? null : await messageById(pool, replyContextId);
  const message =
    named !== null && named.toPhone === phone ? named : await lastMessageTo(pool, phone);
  if (message === null) return null;

  const events = await loadIncident(pool, message.incidentId);
  if (events.length === 0) return null;
  const state = foldIncident(message.incidentId, events);
  if (state.status === 'resolved' || state.status === 'closed') return null;

  return { incidentId: message.incidentId, providerMessageId: message.providerMessageId };
}

//------------------------------------------------------------------------------
// Who sent it
//------------------------------------------------------------------------------

type Sender =
  | { readonly ok: true; readonly personId: string; readonly unitId: string }
  | { readonly ok: false; readonly reason: PendingReason; readonly personId: string | null };

/** `toE164` in SQL, applied to a stored phone — the same digits the webhook gives us. */
const E164_SQL = `(CASE WHEN d LIKE '92%' THEN d WHEN d LIKE '0%' THEN '92' || substr(d, 2) ELSE d END)`;

/**
 * The person this number belongs to — a Directory contact or an account, no login needed
 * (ADR-0041 §1) — if exactly one does, and the department they post under. Two people on one
 * number are not guessed between: the DC chooses.
 *
 * May they post? An account by its role and overrides, and not while suspended. A contact with no
 * login has no role to ask, so it may — unless the DC has denied `activities.upload` to it.
 */
async function senderOf(pool: Pick<Pool, 'query'>, phone: string): Promise<Sender> {
  const { rows } = await pool.query<{
    person_id: string;
    role: Role;
    has_login: boolean;
    blocked: boolean;
    unit_id: string | null;
  }>(
    `SELECT person_id, role, has_login, blocked, unit_id
       FROM (SELECT p.person_id, p.role, p.password_hash IS NOT NULL AS has_login,
                    (p.suspended_at IS NOT NULL OR p.disabled_at IS NOT NULL) AS blocked,
                    u.unit_id,
                    regexp_replace(p.phone, '[^0-9]', '', 'g') AS d
               FROM person p
               LEFT JOIN activity_unit u
                      ON u.unit_id = p.activity_unit_id AND u.retired_at IS NULL
              WHERE p.removed_at IS NULL
                AND (p.password_hash IS NOT NULL OR ${IS_CONTACT_SQL})) x
      WHERE d <> '' AND ${E164_SQL} = $1`,
    [phone],
  );
  if (rows.length !== 1) return { ok: false, reason: 'unknown_sender', personId: null };
  const r = rows[0]!;
  const overrides = await loadOverrides(pool, r.person_id);
  const may = r.has_login
    ? resolvePermissions(r.role, overrides).has('activities.upload')
    : !overrides.some((o) => o.permission === 'activities.upload' && o.effect === 'deny');
  if (r.blocked || !may) return { ok: false, reason: 'not_allowed', personId: r.person_id };
  return { ok: true, personId: r.person_id, unitId: r.unit_id ?? (await generalUnit(pool)) };
}

/**
 * The "General" department, made the first time a known sender with none needs it (ADR-0041 §2).
 * Found by name, so a General the DC made (or renamed) themselves is the one used.
 */
async function generalUnit(pool: Pick<Pool, 'query'>): Promise<string> {
  const find = async (): Promise<string | undefined> =>
    (
      await pool.query<{ unit_id: string }>(
        `SELECT unit_id FROM activity_unit
          WHERE lower(btrim(name)) = lower($1) AND retired_at IS NULL LIMIT 1`,
        [GENERAL_UNIT],
      )
    ).rows[0]?.unit_id;
  const found = await find();
  if (found !== undefined) return found;
  const made = await pool.query<{ unit_id: string }>(
    `INSERT INTO activity_unit (name) VALUES ($1)
     ON CONFLICT (lower(btrim(name))) WHERE retired_at IS NULL DO NOTHING
     RETURNING unit_id`,
    [GENERAL_UNIT],
  );
  const unitId = made.rows[0]?.unit_id;
  if (unitId === undefined) return (await find())!;
  await writeLog(pool, { type: 'unit_created', actor: null, unitId, detail: { automatic: true } });
  return unitId;
}

//------------------------------------------------------------------------------
// Writing: one transaction per arrival, serialised per sender
//------------------------------------------------------------------------------

/**
 * Run `work` in a transaction holding a lock on this sender, so the photos of one album —
 * which Meta delivers as separate webhooks within the same second — join one post instead of
 * racing to make three.
 */
async function forSender<T>(
  pool: Pool,
  phone: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wa-activity:' || $1))", [phone]);
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Write a file the server named. Before the row commits: a file with no row is an orphan. */
async function writeNew(root: string, relative: string, bytes: Buffer): Promise<void> {
  const absolute = inside(root, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes, { flag: 'wx' });
}

/** Where a file of this kind lands on a post. A video is the converter's input, not its output. */
function postPath(postId: string, mediaId: string, kind: FileKind, contentType: string): string {
  return join(postId, `${mediaId}.${kind === 'video' ? 'upload' : EXT[contentType]!}`);
}

interface GroupQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly create: () => Promise<string>;
}

/** The sender's open Pending group of the last five minutes, or a new one. */
function pendingGroup(
  client: PoolClient,
  phone: string,
  reason: PendingReason,
  personId: string | null,
): GroupQuery {
  return {
    sql: `SELECT inbound_id FROM activity_inbound
           WHERE from_phone = $1 AND state = 'pending' AND reason <> 'no_answer'
             AND last_media_at > now() - make_interval(mins => $2)
           ORDER BY last_media_at DESC LIMIT 1`,
    params: [phone, ALBUM_MINUTES],
    create: async () => {
      const res = await client.query<{ inbound_id: string }>(
        `INSERT INTO activity_inbound (from_phone, state, reason, person_id)
         VALUES ($1, 'pending', $2, $3) RETURNING inbound_id`,
        [phone, reason, personId],
      );
      return res.rows[0]!.inbound_id;
    },
  };
}

/** Hold a file or a message in an inbound group — joining the sender's open one when there is. */
async function intoInbound(
  client: PoolClient,
  root: string,
  group: GroupQuery,
  item: Arrived | Message,
): Promise<{ readonly inboundId: string; readonly fresh: boolean }> {
  const found = await client.query<{ inbound_id: string }>(group.sql, [...group.params]);
  let inboundId = found.rows[0]?.inbound_id;
  const fresh = inboundId === undefined;
  if (inboundId === undefined) inboundId = await group.create();
  else {
    await client.query('UPDATE activity_inbound SET last_media_at = now() WHERE inbound_id = $1', [
      inboundId,
    ]);
  }

  const mediaId = randomUUID();
  if ('body' in item) {
    await client.query(
      `INSERT INTO activity_inbound_media (media_id, inbound_id, wa_message_id, kind, body, received_at)
       VALUES ($1, $2, $3, 'text', $4, $5)`,
      [mediaId, inboundId, item.messageId, item.body, item.at],
    );
    return { inboundId, fresh };
  }

  const ext = item.kind === 'video' ? 'upload' : EXT[item.contentType]!;
  const storedPath = join('inbox', inboundId, `${mediaId}.${ext}`);
  await writeNew(root, storedPath, item.bytes);
  await client.query(
    `INSERT INTO activity_inbound_media
       (media_id, inbound_id, wa_message_id, kind, content_type, byte_size, sha256, stored_path,
        caption, reply_context_id, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      mediaId,
      inboundId,
      item.messageId,
      item.kind,
      item.contentType,
      item.bytes.length,
      item.sha256,
      storedPath,
      item.caption,
      item.replyContextId,
      item.at,
    ],
  );
  return { inboundId, fresh };
}

/**
 * The sender has an open emergency: hold the media and ask. The question is sent once per album
 * — a second photo a minute later joins the first and waits for the same tap.
 *
 * If the question cannot be sent, nothing is left waiting on a tap that cannot come: the media
 * goes down today's path at once, as it would have before ADR-0040.
 */
async function holdAndAsk(
  ctx: Context,
  phone: string,
  open: OpenEmergency,
  arrived: Arrived,
): Promise<void> {
  const sender = await senderOf(ctx.pool, phone);
  const { inboundId, fresh } = await forSender(ctx.pool, phone, (client) =>
    intoInbound(
      client,
      ctx.activities.root,
      {
        sql: `SELECT inbound_id FROM activity_inbound
               WHERE from_phone = $1 AND state = 'asking' AND incident_id = $2
                 AND last_media_at > now() - make_interval(mins => $3)
               ORDER BY last_media_at DESC LIMIT 1`,
        params: [phone, open.incidentId, ALBUM_MINUTES],
        create: async () => {
          const res = await client.query<{ inbound_id: string }>(
            `INSERT INTO activity_inbound
               (from_phone, state, incident_id, matched_message_id, asked_at, person_id)
             VALUES ($1, 'asking', $2, $3, now(), $4) RETURNING inbound_id`,
            [phone, open.incidentId, open.providerMessageId, sender.personId],
          );
          return res.rows[0]!.inbound_id;
        },
      },
      arrived,
    ),
  );
  if (!fresh) return;

  const seq = await referenceFor(ctx.pool, open.incidentId);
  const which = seq === null ? 'an open emergency' : `an open emergency, ${formatReference(seq)}`;
  const sent = await sendSession(
    ctx.config,
    {
      toPhone: phone,
      text: `You have ${which}. Is this ${NOUN[arrived.kind]} a report for it, or a daily activity?`,
      buttons: [
        { id: `${CHOICE_PREFIX}:${inboundId}:e`, title: EMERGENCY_BUTTON },
        { id: `${CHOICE_PREFIX}:${inboundId}:a`, title: ACTIVITY_BUTTON },
      ],
    },
    ctx.fetchImpl,
  );
  if (!sent.ok) {
    log('warn', 'could not ask emergency-or-activity; taking the emergency path', {
      incidentId: open.incidentId,
      failure: sent.failure,
    });
    const claimed = await claim(ctx.pool, inboundId, phone);
    if (claimed !== null) {
      await asEmergency(ctx.pool, ctx.activities.root, ctx.emergency, claimed, 'unasked');
    }
  }
}

/** Unknown sender, or a person who may not post: the DC's Pending list. */
async function holdPending(
  ctx: Context,
  phone: string,
  reason: PendingReason,
  personId: string | null,
  arrived: Arrived,
): Promise<boolean> {
  const { fresh } = await forSender(ctx.pool, phone, (client) =>
    intoInbound(
      client,
      ctx.activities.root,
      pendingGroup(client, phone, reason, personId),
      arrived,
    ),
  );
  return fresh;
}

/** The caption a post starts with, or grows by, when media joins it. */
function captionWith(current: string | null, added: string | null): string {
  if (added === null) return current ?? NO_CAPTION;
  if (current === null || current === NO_CAPTION) return added.slice(0, 2000);
  if (current.split('\n').includes(added)) return current;
  return `${current}\n${added}`.slice(0, 2000);
}

/**
 * A known sender with no open emergency: straight onto a post, joining their WhatsApp post of
 * the last five minutes when it has room. Returns true when a new post was made — the moment
 * the officer is told it arrived (once per album, not once per photo).
 */
async function postDirect(
  ctx: Context,
  phone: string,
  sender: { readonly personId: string; readonly unitId: string },
  arrived: Arrived,
): Promise<boolean> {
  const root = ctx.activities.root;
  const fresh = await forSender(ctx.pool, phone, async (client) => {
    const recent = await client.query<{ post_id: string; caption: string }>(
      `SELECT p.post_id, p.caption
         FROM activity_post p
        WHERE p.author_person_id = $1 AND p.source = 'whatsapp' AND p.hidden_at IS NULL
          AND (SELECT max(m.created_at) FROM activity_media m WHERE m.post_id = p.post_id)
              > now() - make_interval(mins => $2)
          AND (SELECT count(*) FROM activity_media m
                WHERE m.post_id = p.post_id AND m.kind = $3 AND m.status <> 'failed') < $4
        ORDER BY p.created_at DESC LIMIT 1`,
      [sender.personId, ALBUM_MINUTES, arrived.kind, PER_POST[arrived.kind]],
    );
    let postId = recent.rows[0]?.post_id;
    if (postId === undefined) {
      const made = await client.query<{ post_id: string }>(
        `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption, source)
         VALUES ($1, $2, $3, $4, 'whatsapp') RETURNING post_id`,
        [
          sender.unitId,
          sender.personId,
          districtDate(arrived.at),
          captionWith(null, arrived.caption),
        ],
      );
      postId = made.rows[0]!.post_id;
      await writeLog(client, {
        type: 'posted',
        actor: sender.personId,
        postId,
        unitId: sender.unitId,
        detail: { via: 'whatsapp' },
      });
    } else {
      const caption = captionWith(recent.rows[0]!.caption, arrived.caption);
      if (caption !== recent.rows[0]!.caption) {
        await client.query('UPDATE activity_post SET caption = $2 WHERE post_id = $1', [
          postId,
          caption,
        ]);
      }
    }
    await addMedia(client, root, postId, sender.personId, {
      mediaId: randomUUID(),
      kind: arrived.kind,
      contentType: arrived.contentType,
      sha256: arrived.sha256,
      byteSize: arrived.bytes.length,
      messageId: arrived.messageId,
      source: { bytes: arrived.bytes },
    });
    return recent.rows[0] === undefined;
  });
  if (arrived.kind === 'video') ctx.activities.onVideo?.();
  return fresh;
}

/**
 * One file onto one post. A photo or voice note is ready at once; a video is `processing`, its
 * original where the converter (`jobs/activitiesVideo.ts`) looks for it — exactly as if every
 * chunk had arrived. The file comes as bytes (direct) or as a held file that is moved (inbox).
 */
async function addMedia(
  client: PoolClient,
  root: string,
  postId: string,
  actor: string | null,
  m: {
    readonly mediaId: string;
    readonly kind: FileKind;
    readonly contentType: string;
    readonly sha256: string;
    readonly byteSize: number;
    readonly messageId: string | null;
    readonly source: { readonly bytes: Buffer } | { readonly heldPath: string };
  },
): Promise<void> {
  const target = postPath(postId, m.mediaId, m.kind, m.contentType);
  if ('bytes' in m.source) await writeNew(root, target, m.source.bytes);
  else {
    const absolute = inside(root, target);
    await mkdir(dirname(absolute), { recursive: true });
    await rename(inside(root, m.source.heldPath), absolute);
  }

  if (m.kind === 'video') {
    await client.query(
      `INSERT INTO activity_media
         (media_id, post_id, kind, status, content_type, byte_size, received_bytes,
          stored_path, upload_path, wa_message_id)
       VALUES ($1, $2, 'video', 'processing', $3, $4, $4, $5, $6, $7)`,
      [
        m.mediaId,
        postId,
        m.contentType,
        m.byteSize,
        join(postId, `${m.mediaId}.mp4`),
        target,
        m.messageId,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO activity_media
         (media_id, post_id, kind, content_type, byte_size, sha256, stored_path, wa_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [m.mediaId, postId, m.kind, m.contentType, m.byteSize, m.sha256, target, m.messageId],
    );
  }
  await writeLog(client, {
    type: m.kind === 'photo' ? 'photo_added' : m.kind === 'video' ? 'video_added' : 'audio_added',
    actor,
    postId,
    detail: { mediaId: m.mediaId, via: 'whatsapp' },
  });
}

//------------------------------------------------------------------------------
// The tap — and what the DC does from the Pending list
//------------------------------------------------------------------------------

interface InboundRow {
  inbound_id: string;
  from_phone: string;
  state: string;
  reason: PendingReason | null;
  person_id: string | null;
  incident_id: string | null;
  matched_message_id: string | null;
}

interface HeldMedia {
  media_id: string;
  wa_message_id: string | null;
  kind: FileKind | 'text';
  content_type: string | null;
  byte_size: string | null;
  sha256: string | null;
  stored_path: string | null;
  caption: string | null;
  body: string | null;
  reply_context_id: string | null;
  received_at: string;
}

/** A held file — everything but a message. */
type HeldFile = HeldMedia & {
  kind: FileKind;
  content_type: string;
  byte_size: string;
  sha256: string;
  stored_path: string;
};

const isFile = (h: HeldMedia): h is HeldFile => h.kind !== 'text';

/**
 * Take an inbound group for one decision, so a second tap — or the DC approving while the officer
 * taps — finds nothing to do. Only a group still waiting for its officer's answer can be claimed
 * by a tap: one the DC is to decide (unknown sender) is not the officer's to move.
 */
async function claim(pool: Pool, inboundId: string, phone: string): Promise<InboundRow | null> {
  const { rows } = await pool.query<InboundRow>(
    `UPDATE activity_inbound SET state = 'choosing', state_at = now()
      WHERE inbound_id = $1 AND from_phone = $2
        AND (state = 'asking' OR (state = 'pending' AND reason = 'no_answer'))
      RETURNING inbound_id, from_phone, state, reason, person_id, incident_id, matched_message_id`,
    [inboundId, phone],
  );
  return rows[0] ?? null;
}

async function heldMedia(pool: Pick<Pool, 'query'>, inboundId: string): Promise<HeldMedia[]> {
  const { rows } = await pool.query<HeldMedia>(
    `SELECT media_id, wa_message_id, kind, content_type, byte_size, sha256, stored_path, caption,
            body, reply_context_id, received_at
       FROM activity_inbound_media WHERE inbound_id = $1
      ORDER BY received_at, created_at, media_id`,
    [inboundId],
  );
  return rows;
}

async function applyChoice(ctx: Context, phone: string, replyId: string): Promise<void> {
  const m = /^wact:([0-9a-f-]{36}):(e|a)$/i.exec(replyId);
  if (m === null) return;
  const claimed = await claim(ctx.pool, m[1]!, phone);
  if (claimed === null) {
    await tell(ctx, phone, 'This has already been dealt with.');
    return;
  }
  if (m[2] === 'e') {
    await asEmergency(ctx.pool, ctx.activities.root, ctx.emergency, claimed, 'tapped');
    return;
  }

  const sender = await senderOf(ctx.pool, phone);
  if (!sender.ok) {
    await toPending(ctx.pool, claimed.inbound_id, sender.reason, sender.personId);
    await tell(ctx, phone, PENDING_REPLY);
    return;
  }
  await postFromInbound(ctx.pool, ctx.activities, claimed.inbound_id, {
    personId: sender.personId,
    unitId: sender.unitId,
    actor: sender.personId,
    activityDate: null,
  });
  await tell(ctx, phone, ADDED_REPLY);
}

async function toPending(
  pool: Pool,
  inboundId: string,
  reason: PendingReason,
  personId: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE activity_inbound
        SET state = 'pending', state_at = now(), reason = $2, person_id = COALESCE($3, person_id)
      WHERE inbound_id = $1`,
    [inboundId, reason, personId],
  );
}

/**
 * *Emergency report* — or an hour with no answer (ADR-0041 §3): each file goes down today's path,
 * in the order it arrived, exactly as if it had just come in — the same evidence, the same note,
 * the same settled obligation — matched to the incident the officer was asked about. Each held
 * file is removed once today's path has it.
 */
async function asEmergency(
  pool: Pool,
  root: string,
  emergency: EmergencyPath,
  row: InboundRow,
  why: 'tapped' | 'unanswered' | 'unasked',
): Promise<void> {
  for (const h of (await heldMedia(pool, row.inbound_id)).filter(isFile)) {
    const bytes = await readFile(inside(root, h.stored_path));
    const contextId = h.reply_context_id ?? row.matched_message_id;
    await emergency({
      text: h.caption ?? '',
      at: new Date(h.received_at).toISOString(),
      media: {
        mediaId: '',
        mimeType: h.content_type,
        sha256: h.sha256,
        filename: null,
        kind: h.kind === 'photo' ? 'image' : h.kind === 'video' ? 'video' : 'voice',
      },
      prefetched: { bytes, contentType: h.content_type, sha256: h.sha256 },
      why,
      ...(contextId === null ? {} : { replyContextId: contextId }),
    });
    await pool.query('DELETE FROM activity_inbound_media WHERE media_id = $1', [h.media_id]);
    await removeFiles(root, [h.stored_path]);
  }
  await pool.query('DELETE FROM activity_inbound WHERE inbound_id = $1', [row.inbound_id]);
  await rm(inside(root, join('inbox', row.inbound_id)), { recursive: true, force: true }).catch(
    () => {},
  );
}

/**
 * Turn a held group into posts — one post, or more when it holds more than a post may (ten
 * photos, three videos, ten voice notes). The files are moved from the inbox, never copied; any
 * messages in the group become the caption. The group is gone afterwards. Shared by *Daily
 * activity*, the DC's approval, and *Add to Directory*.
 */
async function postFromInbound(
  pool: Pool,
  activities: WhatsAppActivities,
  inboundId: string,
  to: {
    readonly personId: string;
    readonly unitId: string;
    /** Who did it, for the log: the officer (their tap), or the DC (approval). */
    readonly actor: string;
    /** Null: the day the first file arrived (ADR-0040 §5). */
    readonly activityDate: string | null;
  },
): Promise<readonly string[]> {
  const root = activities.root;
  const client = await pool.connect();
  const moved: { from: string; to: string }[] = [];
  const posts: string[] = [];
  let videos = false;
  try {
    await client.query('BEGIN');
    const held = await heldMedia(client, inboundId);
    const words = held.filter((h) => h.kind === 'text').map((h) => h.body!);
    const queues: Record<FileKind, HeldFile[]> = {
      photo: held.filter(isFile).filter((h) => h.kind === 'photo'),
      video: held.filter(isFile).filter((h) => h.kind === 'video'),
      audio: held.filter(isFile).filter((h) => h.kind === 'audio'),
    };
    let first = true;
    while (queues.photo.length + queues.video.length + queues.audio.length > 0) {
      const batch = [
        ...queues.photo.splice(0, PER_POST.photo),
        ...queues.video.splice(0, PER_POST.video),
        ...queues.audio.splice(0, PER_POST.audio),
      ].sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime());
      let caption: string | null = null;
      for (const h of batch) caption = captionWith(caption, h.caption);
      // The words sent alongside belong to the first post of the group.
      if (first) for (const w of words) caption = captionWith(caption, w);
      first = false;
      const date = to.activityDate ?? districtDate(new Date(batch[0]!.received_at));
      const made = await client.query<{ post_id: string }>(
        `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption, source)
         VALUES ($1, $2, $3, $4, 'whatsapp') RETURNING post_id`,
        [to.unitId, to.personId, date, caption ?? NO_CAPTION],
      );
      const postId = made.rows[0]!.post_id;
      posts.push(postId);
      await writeLog(client, {
        type: 'posted',
        actor: to.actor,
        postId,
        unitId: to.unitId,
        detail: { via: 'whatsapp', author: to.personId },
      });
      for (const h of batch) {
        await addMedia(client, root, postId, to.actor, {
          mediaId: h.media_id,
          kind: h.kind,
          contentType: h.content_type,
          sha256: h.sha256,
          byteSize: Number(h.byte_size),
          messageId: null,
          source: { heldPath: h.stored_path },
        });
        moved.push({
          from: h.stored_path,
          to: postPath(postId, h.media_id, h.kind, h.content_type),
        });
        if (h.kind === 'video') videos = true;
      }
    }
    // The held rows go first, so the Meta id is free for the post's own media row.
    await client.query('DELETE FROM activity_inbound WHERE inbound_id = $1', [inboundId]);
    for (const h of held.filter(isFile)) {
      if (h.wa_message_id === null) continue;
      await client.query('UPDATE activity_media SET wa_message_id = $2 WHERE media_id = $1', [
        h.media_id,
        h.wa_message_id,
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Put back whatever was already moved, so the held rows still point at their files.
    for (const f of moved.reverse()) {
      await rename(inside(root, f.to), inside(root, f.from)).catch(() => {});
    }
    throw e;
  } finally {
    client.release();
  }
  await rm(inside(root, join('inbox', inboundId)), { recursive: true, force: true }).catch(
    () => {},
  );
  if (videos) activities.onVideo?.();
  return posts;
}

/** One line into the sender's thread, inside the window their own message just opened. */
async function tell(ctx: Context, phone: string, text: string): Promise<void> {
  const sent = await sendSession(ctx.config, { toPhone: phone, text }, ctx.fetchImpl);
  if (!sent.ok) log('info', 'could not reply about an activity', { failure: sent.failure });
}

//------------------------------------------------------------------------------
// The sweep: no answer within the hour, and the 30-day rule
//------------------------------------------------------------------------------

export interface InboundSweep {
  /** Questions nobody answered within the hour, sent down the emergency path. */
  readonly unanswered: number;
  /** Groups past the 30-day rule, deleted. */
  readonly expired: number;
}

/**
 * Run by `jobs/activitiesInbound.ts` every minute.
 *
 * A question unanswered for an hour goes down **today's emergency path** (ADR-0041 §3) — only the
 * officer's own *Daily activity* tap puts a picture in Activities. Without the emergency path (no
 * WhatsApp account: nothing was ever asked) such a group falls back to the Pending list. A tap
 * interrupted mid-way (a crash) goes to the Pending list, and the DC decides. Anything held longer
 * than the 30-day rule allows any Activities post is deleted, with one log line each.
 */
export async function sweepInbound(
  pool: Pool,
  root: string,
  emergencyFor?: EmergencyPathFor,
): Promise<InboundSweep> {
  let unanswered = 0;
  if (emergencyFor !== undefined) {
    const due = await pool.query<InboundRow>(
      `UPDATE activity_inbound SET state = 'choosing', state_at = now()
        WHERE state = 'asking' AND state_at < now() - make_interval(mins => $1)
        RETURNING inbound_id, from_phone, state, reason, person_id, incident_id, matched_message_id`,
      [ANSWER_MINUTES],
    );
    for (const row of due.rows) {
      try {
        await asEmergency(pool, root, emergencyFor(row.from_phone), row, 'unanswered');
        unanswered += 1;
      } catch (err) {
        log('error', 'an unanswered picture could not be sent to its emergency', {
          incidentId: row.incident_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const fallback = await pool.query(
    `UPDATE activity_inbound
        SET state = 'pending', reason = 'no_answer', state_at = now()
      WHERE (state = 'asking' AND state_at < now() - make_interval(mins => $1))
         OR (state = 'choosing' AND state_at < now() - make_interval(mins => $2))`,
    [ANSWER_MINUTES, STUCK_MINUTES],
  );
  unanswered += fallback.rowCount ?? 0;

  const old = await pool.query<{ inbound_id: string; from_phone: string; n: string }>(
    `DELETE FROM activity_inbound i
      WHERE i.created_at < now() - make_interval(days => $1) AND i.state <> 'choosing'
      RETURNING i.inbound_id, i.from_phone,
                (SELECT count(*) FROM activity_inbound_media m WHERE m.inbound_id = i.inbound_id) AS n`,
    [RETENTION_DAYS],
  );
  for (const r of old.rows) {
    await writeLog(pool, {
      type: 'pending_expired',
      actor: null,
      detail: { inboundId: r.inbound_id, fromPhone: r.from_phone, media: Number(r.n) },
    });
    await rm(inside(root, join('inbox', r.inbound_id)), { recursive: true, force: true }).catch(
      () => {},
    );
  }
  return { unanswered, expired: old.rows.length };
}

//------------------------------------------------------------------------------
// The DC's Pending list (`activities.pending`)
//------------------------------------------------------------------------------

export interface PendingView {
  readonly inboundId: string;
  readonly fromPhone: string;
  readonly reason: PendingReason;
  /** The person the number matched, when it matched one. */
  readonly personId: string | null;
  readonly personName: string | null;
  /** Their default department — the DC's starting choice. */
  readonly suggestedUnitId: string | null;
  /** The emergency the officer was asked about, for a question nobody answered. */
  readonly incidentReference: string | null;
  readonly receivedAt: string;
  /** The day it would be posted under unless the DC chooses another. */
  readonly activityDate: string;
  readonly captions: readonly string[];
  /** Words, files and places sent with no picture (ADR-0041 §5). */
  readonly messages: readonly string[];
  readonly media: readonly { readonly mediaId: string; readonly kind: FileKind }[];
  /** When the 30-day rule deletes it. */
  readonly expiresAt: string;
}

function refuse<T>(status: number, error: string): ActivitiesResult<T> {
  return { ok: false, status, error };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mayClear(pool: Pool, identity: Identity): Promise<boolean> {
  return (await permissionsOf(pool, identity)).has('activities.pending');
}

export async function listPending(
  pool: Pool,
  identity: Identity,
): Promise<ActivitiesResult<readonly PendingView[]>> {
  if (!(await mayClear(pool, identity))) {
    return refuse(403, 'you do not have permission to open the Pending list');
  }
  const { rows } = await pool.query<{
    inbound_id: string;
    from_phone: string;
    reason: PendingReason;
    person_id: string | null;
    full_name: string | null;
    unit_id: string | null;
    incident_seq: string | null;
    received_at: string;
    expires_at: string;
    captions: string[] | null;
    messages: string[] | null;
    media: { mediaId: string; kind: FileKind }[] | null;
  }>(
    `SELECT i.inbound_id, i.from_phone, i.reason, i.person_id, p.full_name, u.unit_id,
            r.seq AS incident_seq,
            (SELECT min(m.received_at) FROM activity_inbound_media m
              WHERE m.inbound_id = i.inbound_id) AS received_at,
            i.created_at + make_interval(days => ${RETENTION_DAYS}) AS expires_at,
            (SELECT json_agg(m.caption ORDER BY m.received_at, m.created_at)
               FROM activity_inbound_media m
              WHERE m.inbound_id = i.inbound_id AND m.caption IS NOT NULL) AS captions,
            (SELECT json_agg(m.body ORDER BY m.received_at, m.created_at)
               FROM activity_inbound_media m
              WHERE m.inbound_id = i.inbound_id AND m.kind = 'text') AS messages,
            (SELECT json_agg(json_build_object('mediaId', m.media_id, 'kind', m.kind)
                             ORDER BY m.received_at, m.created_at, m.media_id)
               FROM activity_inbound_media m
              WHERE m.inbound_id = i.inbound_id AND m.kind <> 'text') AS media
       FROM activity_inbound i
       LEFT JOIN person p ON p.person_id = i.person_id
       LEFT JOIN activity_unit u ON u.unit_id = p.activity_unit_id AND u.retired_at IS NULL
       LEFT JOIN incident_reference r ON r.incident_id = i.incident_id
      WHERE i.state = 'pending'
      ORDER BY i.created_at DESC`,
  );
  return {
    ok: true,
    value: rows
      .filter((r) => r.received_at !== null)
      .map((r) => ({
        inboundId: r.inbound_id,
        fromPhone: r.from_phone,
        reason: r.reason,
        personId: r.person_id,
        personName: r.full_name,
        suggestedUnitId: r.unit_id,
        incidentReference: r.incident_seq === null ? null : formatReference(Number(r.incident_seq)),
        receivedAt: new Date(r.received_at).toISOString(),
        activityDate: districtDate(new Date(r.received_at)),
        captions: r.captions ?? [],
        messages: r.messages ?? [],
        media: r.media ?? [],
        expiresAt: new Date(r.expires_at).toISOString(),
      })),
  };
}

/** One held file, for the DC to look at before deciding. Never served to anyone else. */
export async function servePendingMedia(
  pool: Pool,
  root: string,
  res: ServerResponse,
  identity: Identity,
  mediaId: string,
): Promise<ActivitiesResult<never> | null> {
  if (!(await mayClear(pool, identity))) {
    return refuse(403, 'you do not have permission to open the Pending list');
  }
  const { rows } = await pool.query<{ stored_path: string; content_type: string }>(
    `SELECT m.stored_path, m.content_type
       FROM activity_inbound_media m JOIN activity_inbound i ON i.inbound_id = m.inbound_id
      WHERE m.media_id = $1 AND i.state = 'pending' AND m.kind <> 'text'`,
    [mediaId],
  );
  const row = rows[0];
  if (row === undefined) return refuse(404, 'no such file');
  const absolute = inside(root, row.stored_path);
  const size = (await stat(absolute).catch(() => null))?.size;
  if (size === undefined) return refuse(404, 'no such file');
  res.writeHead(200, {
    'content-type': row.content_type,
    'content-length': String(size),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(absolute);
    s.on('error', reject);
    s.on('end', resolve);
    s.pipe(res);
  });
  return null;
}

function dateFrom(input: Record<string, unknown>): string | ActivitiesResult<never> {
  const dateIn = typeof input['activityDate'] === 'string' ? input['activityDate'].trim() : '';
  if (dateIn === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIn) || !Number.isFinite(Date.parse(dateIn))) {
    return refuse(400, 'choose the date of the activity');
  }
  if (dateIn > districtDate()) return refuse(400, 'the date cannot be in the future');
  return dateIn;
}

async function liveUnit(pool: Pool, unitId: string): Promise<boolean> {
  const unit = await pool.query(
    'SELECT 1 FROM activity_unit WHERE unit_id = $1 AND retired_at IS NULL',
    [unitId],
  );
  return (unit.rowCount ?? 0) > 0;
}

/** Claim a Pending group for the DC, with how many files it holds. */
async function claimPending(
  pool: Pool,
  inboundId: string,
): Promise<{ readonly fromPhone: string; readonly files: number; readonly all: number } | null> {
  const claimed = await pool.query<{ from_phone: string; files: string; all: string }>(
    `UPDATE activity_inbound SET state = 'choosing', state_at = now()
      WHERE inbound_id = $1 AND state = 'pending'
      RETURNING from_phone,
                (SELECT count(*) FROM activity_inbound_media m
                  WHERE m.inbound_id = $1 AND m.kind <> 'text') AS files,
                (SELECT count(*) FROM activity_inbound_media m WHERE m.inbound_id = $1) AS all`,
    [inboundId],
  );
  const row = claimed.rows[0];
  return row === undefined
    ? null
    : { fromPhone: row.from_phone, files: Number(row.files), all: Number(row.all) };
}

async function unclaim(pool: Pool, inboundId: string): Promise<void> {
  await pool.query(
    `UPDATE activity_inbound SET state = 'pending', state_at = now()
      WHERE inbound_id = $1 AND state = 'choosing'`,
    [inboundId],
  );
}

/**
 * The DC approves: posted under the person and department they choose, on the day it arrived
 * unless they choose another. The sender is told, if their thread is still open. A group of
 * messages alone has nothing to post: add the number to the Directory, or delete it.
 */
export async function approvePending(
  pool: Pool,
  activities: WhatsAppActivities,
  identity: Identity,
  inboundId: string,
  input: Record<string, unknown>,
  tellSender?: (phone: string, text: string) => Promise<void>,
): Promise<ActivitiesResult<{ readonly postIds: readonly string[] }>> {
  if (!(await mayClear(pool, identity))) {
    return refuse(403, 'you do not have permission to approve from the Pending list');
  }
  const personId = typeof input['personId'] === 'string' ? input['personId'].trim() : '';
  const unitId = typeof input['unitId'] === 'string' ? input['unitId'].trim() : '';
  if (!UUID_RE.test(personId)) return refuse(400, 'choose whose activity this is');
  if (!UUID_RE.test(unitId)) return refuse(400, 'choose a department');
  const date = dateFrom(input);
  if (typeof date !== 'string') return date;

  const person = await pool.query(
    `SELECT 1 FROM person p
      WHERE p.person_id = $1 AND p.removed_at IS NULL
        AND (p.password_hash IS NOT NULL OR ${IS_CONTACT_SQL})`,
    [personId],
  );
  if (person.rowCount === 0) return refuse(400, 'that person is not in the Directory');
  if (!(await liveUnit(pool, unitId))) return refuse(400, 'that department is not on the list');

  const row = await claimPending(pool, inboundId);
  if (row === null) return refuse(404, 'this is no longer on the Pending list');
  if (row.files === 0) {
    await unclaim(pool, inboundId);
    return refuse(
      409,
      'there is no picture to post — add the number to the Directory, or delete it',
    );
  }

  let postIds: readonly string[];
  try {
    postIds = await postFromInbound(pool, activities, inboundId, {
      personId,
      unitId,
      actor: identity.personId,
      activityDate: date === '' ? null : date,
    });
  } catch (e) {
    await unclaim(pool, inboundId);
    throw e;
  }
  await writeLog(pool, {
    type: 'pending_approved',
    actor: identity.personId,
    postId: postIds[0] ?? null,
    unitId,
    detail: {
      inboundId,
      fromPhone: row.fromPhone,
      author: personId,
      posts: postIds,
      media: row.files,
    },
  });
  if (tellSender !== undefined) await tellSender(row.fromPhone, ADDED_REPLY).catch(() => {});
  return { ok: true, value: { postIds } };
}

/** `920300…` as the Directory writes a number: `0300…` for Pakistan, `+…` otherwise. */
function directoryPhone(e164: string): string {
  return e164.startsWith('92') && e164.length === 12 ? `0${e164.slice(2)}` : `+${e164}`;
}

/**
 * *Add to Directory* (ADR-0041 §6): the number becomes a Directory contact under the name and post
 * the DC types — exactly as Administration → Directory adds one, with its rules — and whatever it
 * sent is posted under that contact. From now on its pictures post themselves. A group of messages
 * alone is cleared once the contact exists. ⚠️ A Directory contact can be sent emergency alerts.
 */
export async function addToDirectory(
  pool: Pool,
  activities: WhatsAppActivities,
  identity: Identity,
  inboundId: string,
  input: Record<string, unknown>,
  tellSender?: (phone: string, text: string) => Promise<void>,
): Promise<ActivitiesResult<{ readonly personId: string; readonly postIds: readonly string[] }>> {
  if (!(await mayClear(pool, identity))) {
    return refuse(403, 'you do not have permission to clear the Pending list');
  }
  const unitIn = typeof input['unitId'] === 'string' ? input['unitId'].trim() : '';
  if (unitIn !== '' && (!UUID_RE.test(unitIn) || !(await liveUnit(pool, unitIn)))) {
    return refuse(400, 'that department is not on the list');
  }
  const date = dateFrom(input);
  if (typeof date !== 'string') return date;

  const row = await claimPending(pool, inboundId);
  if (row === null) return refuse(404, 'this is no longer on the Pending list');

  const made = await addContact(pool, identity, {
    fullName: input['fullName'],
    designation: input['designation'],
    phone: directoryPhone(row.fromPhone),
  });
  if (!made.ok) {
    await unclaim(pool, inboundId);
    return made;
  }
  const personId = made.value.personId;
  const unitId = unitIn === '' ? await generalUnit(pool) : unitIn;
  await pool.query('UPDATE person SET activity_unit_id = $2 WHERE person_id = $1', [
    personId,
    unitId,
  ]);
  await writeLog(pool, {
    type: 'contact_added',
    actor: identity.personId,
    unitId,
    detail: { inboundId, fromPhone: row.fromPhone, personId },
  });

  let postIds: readonly string[] = [];
  if (row.files > 0) {
    postIds = await postFromInbound(pool, activities, inboundId, {
      personId,
      unitId,
      actor: identity.personId,
      activityDate: date === '' ? null : date,
    });
    await writeLog(pool, {
      type: 'pending_approved',
      actor: identity.personId,
      postId: postIds[0] ?? null,
      unitId,
      detail: {
        inboundId,
        fromPhone: row.fromPhone,
        author: personId,
        posts: postIds,
        media: row.files,
      },
    });
    if (tellSender !== undefined) await tellSender(row.fromPhone, ADDED_REPLY).catch(() => {});
  } else {
    await pool.query('DELETE FROM activity_inbound WHERE inbound_id = $1', [inboundId]);
  }
  return { ok: true, value: { personId, postIds } };
}

/** The DC rejects: the rows and the files are deleted for good; one log line remains. */
export async function rejectPending(
  pool: Pool,
  root: string,
  identity: Identity,
  inboundId: string,
): Promise<ActivitiesResult<{ readonly inboundId: string }>> {
  if (!(await mayClear(pool, identity))) {
    return refuse(403, 'you do not have permission to reject from the Pending list');
  }
  const { rows } = await pool.query<{ from_phone: string; n: string }>(
    `DELETE FROM activity_inbound i WHERE i.inbound_id = $1 AND i.state = 'pending'
      RETURNING i.from_phone,
                (SELECT count(*) FROM activity_inbound_media m WHERE m.inbound_id = i.inbound_id) AS n`,
    [inboundId],
  );
  const row = rows[0];
  if (row === undefined) return refuse(404, 'this is no longer on the Pending list');
  await writeLog(pool, {
    type: 'pending_rejected',
    actor: identity.personId,
    detail: { inboundId, fromPhone: row.from_phone, media: Number(row.n) },
  });
  await rm(inside(root, join('inbox', inboundId)), { recursive: true, force: true }).catch(
    () => {},
  );
  return { ok: true, value: { inboundId } };
}

/** For the sender's thread after an approval: only inside Meta's 24-hour window. */
export function senderTeller(
  pool: Pool,
  config: WhatsAppConfig | null,
  fetchImpl: typeof fetch,
): ((phone: string, text: string) => Promise<void>) | undefined {
  if (config === null) return undefined;
  return async (phone, text) => {
    if (!(await sessionWindowOpen(pool, phone))) return;
    const sent = await sendSession(config, { toPhone: phone, text }, fetchImpl);
    if (!sent.ok) {
      log('info', 'could not tell the sender their activity was approved', {
        failure: sent.failure,
      });
    }
  };
}
