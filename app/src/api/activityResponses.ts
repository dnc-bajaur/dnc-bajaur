/**
 * Respond — one WhatsApp message from the DC office to the person who sent an Activities post,
 * and that person's answer coming back to the post (ADR-0044 §6–§7; Bajaur, PLAN §4b G3).
 *
 * **Not an alert, and nothing like one.** It writes no incident, no event, no obligation: there
 * is no SLA, no escalation and nothing to acknowledge. The message says so itself — it opens
 * *"Activities — message from the DC office"* and ends *"This is not an emergency alert."*
 *
 * **Who may:** accounts that hold `activities.respond` — the DC and the control room (`owner`,
 * `admin`, `operator`). The button, every message sent and every answer are shown to them only;
 * for everybody else the server leaves them out of the post (INV-05).
 *
 * **Sending.** Meta accepts a plain message only within 24 hours of the officer's last message to
 * the district number (`sessionWindowOpen`). Outside that, only an approved template —
 * `WHATSAPP_TEMPLATE_ACTIVITY`. With neither, **nothing is sent and the caller is told so**; a
 * Respond is never dropped quietly. Every attempt that reached Meta is kept on the post — sent,
 * delivered, read, or failed with Meta's own reason (INV-03) — and logged (`responded`, INV-06).
 *
 * **The answer.** Sent with WhatsApp's reply to our message, it is exact. Plain words with no
 * reply are taken as the answer to the last Respond sent to that number in the last 24 hours —
 * an inference, marked as one, and made **only when no alert went to that number in that time**:
 * an officer's words about an emergency are never diverted here. A photo or a voice note sent as
 * a reply is kept on the answer; everything else is described in words. Nothing here ever reaches
 * the incident record.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { sessionWindowOpen, SESSION_WINDOW_HOURS } from '../db/whatsappStore.js';
import { decideType } from '../ops/fileType.js';
import {
  downloadMedia,
  sendActivityResponse,
  sendSession,
  toE164,
  type InboundLocation,
  type InboundMedia,
  type ProviderStatus,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import { log } from '../obs/log.js';
import {
  caller,
  refuse,
  UUID_RE,
  visiblePost,
  type ActivitiesResult,
  type Caller,
} from './activitiesAccess.js';
import {
  AUDIO_TYPES,
  EXT,
  MAX_AUDIO_BYTES,
  MAX_PHOTO_BYTES,
  PHOTO_TYPES,
  inside,
  parseRange,
  writeLog,
} from './activities.js';

/** A Respond is a short message to one officer, not a circular. */
export const MAX_RESPONSE_LENGTH = 1000;

/** The caption a WhatsApp post is given when its media came with no words — never quoted back. */
const NO_CAPTION = 'Sent on WhatsApp';

export const RESPONSE_HEADING = '*Activities — message from the DC office*';
export const RESPONSE_FOOTER = 'This is not an emergency alert. To answer, reply to this message.';

/** What the server hands this module: the district's WhatsApp account, when there is one. */
export interface RespondDeps {
  readonly whatsapp: WhatsAppConfig | null;
  readonly fetchImpl: typeof fetch;
}

export interface ResponseView {
  readonly responseId: string;
  /** `out`: the DC office wrote it. `in`: the officer answered. */
  readonly direction: 'out' | 'in';
  readonly body: string;
  readonly createdAt: string;
  /** Who pressed Respond. Null on an answer. */
  readonly byName: string | null;
  /** How it stands with Meta. Null on an answer. */
  readonly status: ProviderStatus | null;
  readonly failure: string | null;
  /** `latest`: sent without WhatsApp's reply, and matched to the last Respond by time. */
  readonly matchedBy: 'reply' | 'latest' | null;
  /** A photo or a voice note on an answer, at `/activities/responses/{id}/media`. */
  readonly media: 'photo' | 'audio' | null;
}

interface ResponseRow {
  response_id: string;
  post_id: string;
  direction: 'out' | 'in';
  body: string;
  created_at: string;
  by_name: string | null;
  status: ProviderStatus | null;
  failure: string | null;
  matched_by: 'reply' | 'latest' | null;
  media_kind: 'photo' | 'audio' | null;
}

function view(r: ResponseRow): ResponseView {
  return {
    responseId: r.response_id,
    direction: r.direction,
    body: r.body,
    createdAt: r.created_at,
    byName: r.by_name,
    status: r.status,
    failure: r.failure,
    matchedBy: r.matched_by,
    media: r.media_kind,
  };
}

/**
 * The messages and answers on a page of posts, oldest first — for a caller who may respond, and
 * **nothing at all** for anybody else.
 */
export async function responsesFor(
  pool: Pool,
  c: Caller,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ResponseView[]>> {
  const out = new Map<string, ResponseView[]>();
  if (postIds.length === 0 || !c.can.has('activities.respond')) return out;
  const { rows } = await pool.query<ResponseRow>(
    `SELECT r.response_id, r.post_id, r.direction, r.body, r.created_at, a.full_name AS by_name,
            r.status, r.failure, r.matched_by, r.media_kind
       FROM activity_response r
       LEFT JOIN person a ON a.person_id = r.actor_person_id
      WHERE r.post_id = ANY($1)
      ORDER BY r.created_at, r.response_id`,
    [postIds],
  );
  for (const r of rows) {
    const list = out.get(r.post_id) ?? [];
    list.push(view(r));
    out.set(r.post_id, list);
  }
  return out;
}

/** A date as an officer reads it in a message: `3 October 2026`. */
function longDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The plain message, as sent inside the 24-hour window. */
export function responseText(
  post: { activityDate: string; caption: string },
  message: string,
): string {
  const words = post.caption.replace(/\s+/g, ' ').trim();
  const quoted =
    words === '' || words === NO_CAPTION
      ? ''
      : `: "${words.length > 80 ? `${words.slice(0, 79)}…` : words}"`;
  return [
    RESPONSE_HEADING,
    `About your post of ${longDate(post.activityDate)}${quoted}`,
    '',
    message,
    '',
    RESPONSE_FOOTER,
  ].join('\n');
}

/**
 * Send a message to the person who sent this post. Returns what now stands under the post — the
 * new message included, with how it went.
 */
export async function respond(
  pool: Pool,
  identity: Identity,
  postId: string,
  input: Record<string, unknown>,
  deps: RespondDeps,
): Promise<ActivitiesResult<readonly ResponseView[]>> {
  const c = await caller(pool, identity);
  const seen = await visiblePost(pool, c, postId);
  if ('ok' in seen) return seen;
  if (!c.can.has('activities.respond')) {
    return refuse(403, 'you do not have permission to respond to a post');
  }
  if (seen.hidden) return refuse(409, 'this post is in the Recycle bin');

  const message = typeof input['message'] === 'string' ? input['message'].trim() : '';
  if (message === '') return refuse(400, 'write the message first');
  if (message.length > MAX_RESPONSE_LENGTH) {
    return refuse(400, `a message is at most ${MAX_RESPONSE_LENGTH} characters`);
  }

  const found = await pool.query<{ phone: string | null; activity_date: string; caption: string }>(
    `SELECT a.phone, to_char(p.activity_date, 'YYYY-MM-DD') AS activity_date, p.caption
       FROM activity_post p JOIN person a ON a.person_id = p.author_person_id
      WHERE p.post_id = $1`,
    [postId],
  );
  const post = found.rows[0];
  if (post === undefined) return refuse(404, 'no such post');
  const digits = (post.phone ?? '').replace(/[^0-9]/g, '');
  if (digits === '') return refuse(409, 'this person has no mobile number to send it to');
  const phone = toE164(post.phone!);

  const config = deps.whatsapp;
  if (config === null) {
    return refuse(
      503,
      "The district's WhatsApp account is not set up on this server yet. Nothing was sent.",
    );
  }

  const open = await sessionWindowOpen(pool, phone);
  if (!open && config.activityTemplate === undefined) {
    return refuse(
      409,
      `It is more than ${SESSION_WINDOW_HOURS} hours since this person last wrote to the district ` +
        'number, and the Activities message template is not approved yet. Nothing was sent.',
    );
  }

  const sent = open
    ? await sendSession(
        config,
        {
          toPhone: phone,
          text: responseText({ activityDate: post.activity_date, caption: post.caption }, message),
        },
        deps.fetchImpl,
      )
    : await sendActivityResponse(
        config,
        { toPhone: phone, postDate: longDate(post.activity_date), message },
        deps.fetchImpl,
      );

  const responseId = randomUUID();
  await pool.query(
    `INSERT INTO activity_response
       (response_id, post_id, direction, actor_person_id, phone, body, via,
        provider_message_id, status, failure, status_at)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      responseId,
      postId,
      identity.personId,
      phone,
      message,
      open ? 'session' : 'template',
      sent.ok ? sent.providerMessageId : null,
      sent.ok ? 'sent' : 'failed',
      sent.ok ? null : sent.failure,
    ],
  );
  await writeLog(pool, {
    type: 'responded',
    actor: identity.personId,
    postId,
    unitId: seen.unitId,
    detail: { responseId, via: open ? 'session' : 'template', sent: sent.ok },
  });

  if (!sent.ok) {
    log('warn', 'an Activities response could not be sent', { failure: sent.failure });
    return refuse(502, `WhatsApp did not take the message: ${sent.failure}`);
  }
  return { ok: true, value: (await responsesFor(pool, c, [postId])).get(postId) ?? [] };
}

/** What stands under one post — for the page to redraw after a send, sent or not. */
export async function listResponses(
  pool: Pool,
  identity: Identity,
  postId: string,
): Promise<ActivitiesResult<readonly ResponseView[]>> {
  const c = await caller(pool, identity);
  const seen = await visiblePost(pool, c, postId);
  if ('ok' in seen) return seen;
  if (!c.can.has('activities.respond')) {
    return refuse(403, 'you do not have permission to see the responses to a post');
  }
  return { ok: true, value: (await responsesFor(pool, c, [postId])).get(postId) ?? [] };
}

//------------------------------------------------------------------------------
// What Meta says happened to it
//------------------------------------------------------------------------------

const RANK: Readonly<Record<string, number>> = { sent: 1, delivered: 2, read: 3 };

/**
 * A status webhook about one of our Responds. Returns false when the message is not one — the
 * caller then treats it as it always has. Statuses arrive out of order, so a later one is never
 * walked back by an earlier one (`applyStatus` in `whatsappStore.ts` fights the same thing);
 * `failed` is not a rung but the message having stopped.
 */
export async function applyResponseStatus(
  pool: Pool,
  providerMessageId: string,
  status: ProviderStatus,
  failure: string | null,
): Promise<boolean> {
  const found = await pool.query<{ status: string }>(
    `SELECT status FROM activity_response WHERE provider_message_id = $1 AND direction = 'out'`,
    [providerMessageId],
  );
  const row = found.rows[0];
  if (row === undefined) return false;
  const backwards = status !== 'failed' && (RANK[status] ?? 0) <= (RANK[row.status] ?? 0);
  if (!backwards && row.status !== 'failed') {
    await pool.query(
      `UPDATE activity_response SET status = $2, failure = $3, status_at = now()
        WHERE provider_message_id = $1`,
      [providerMessageId, status, status === 'failed' ? (failure ?? 'no reason given') : null],
    );
  }
  return true;
}

//------------------------------------------------------------------------------
// The officer's answer
//------------------------------------------------------------------------------

/** As much of an inbound message as this module reads (`InboundForActivities`). */
export interface InboundAnswer {
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

export interface AnswerDeps {
  readonly pool: Pool;
  readonly config: WhatsAppConfig;
  readonly fetchImpl: typeof fetch;
  /** The Activities root: an answer's photo or voice note is kept in its post's folder. */
  readonly root: string;
}

/** `continue`: recorded, and the caller goes on as if this module were not here (a video). */
export type AnswerTaken = 'taken' | 'continue' | 'not_ours';

interface Target {
  readonly responseId: string;
  readonly postId: string;
  readonly matchedBy: 'reply' | 'latest';
}

async function targetOf(pool: Pool, phone: string, answer: InboundAnswer): Promise<Target | null> {
  if (answer.replyContextId !== undefined) {
    const named = await pool.query<{ response_id: string; post_id: string }>(
      `SELECT response_id, post_id FROM activity_response
        WHERE provider_message_id = $1 AND direction = 'out' AND phone = $2`,
      [answer.replyContextId, phone],
    );
    const r = named.rows[0];
    // A reply to something else — an alert, their own message — is not an answer to a Respond.
    return r === undefined
      ? null
      : { responseId: r.response_id, postId: r.post_id, matchedBy: 'reply' };
  }
  // No reply used: only plain words are inferred, onto the last Respond — and only for a number
  // that has had **no alert in the last day**. With one, the words may be about the emergency,
  // and today's path (`recordReply`, which matches by the last alert) must have them: an answer
  // to an emergency is never diverted into Activities. Without one, today's path would drop them.
  if (
    answer.media !== undefined ||
    answer.location !== undefined ||
    answer.reaction !== undefined
  ) {
    return null;
  }
  if (answer.text.trim() === '') return null;
  const latest = await pool.query<{ response_id: string; post_id: string }>(
    `SELECT r.response_id, r.post_id
       FROM activity_response r
      WHERE r.direction = 'out' AND r.phone = $1 AND r.status <> 'failed'
        AND r.created_at > now() - make_interval(hours => $2)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_message m
                         WHERE m.to_phone = $1
                           AND m.sent_at > now() - make_interval(hours => $2))
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [phone, SESSION_WINDOW_HOURS],
  );
  const r = latest.rows[0];
  return r === undefined
    ? null
    : { responseId: r.response_id, postId: r.post_id, matchedBy: 'latest' };
}

function emojiOf(reaction: unknown): string {
  const emoji = (reaction as { emoji?: unknown } | null)?.emoji;
  return typeof emoji === 'string' ? emoji : '';
}

/** What a file or a place is, in words — for the kinds an answer does not keep. */
function described(answer: InboundAnswer): string {
  const parts: string[] = [];
  if (answer.text.trim() !== '') parts.push(answer.text.trim());
  if (answer.reaction !== undefined) parts.push(emojiOf(answer.reaction));
  const media = answer.media;
  if (media !== undefined) {
    parts.push(
      media.kind === 'video'
        ? '(sent a video — it is in Activities as a new post)'
        : media.kind === 'sticker'
          ? '(sent a sticker)'
          : `(sent a file${media.filename === null ? '' : `: ${media.filename}`})`,
    );
  }
  if (answer.location !== undefined) {
    const l = answer.location;
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
  return parts
    .filter((p) => p !== '')
    .join('\n')
    .slice(0, 4000);
}

/**
 * Is this inbound an officer's answer to a Respond? If so it is kept on that post and never
 * reaches the incident path.
 *
 * Never throws on a provider's failure: like the rest of the webhook, a bad minute at Meta must
 * not cost the district a 500.
 */
export async function takeAnswer(
  deps: AnswerDeps,
  fromPhone: string,
  answer: InboundAnswer,
): Promise<AnswerTaken> {
  // A tap on one of our buttons is somebody else's question being answered.
  if (answer.tapped === true || answer.replyId !== undefined) return 'not_ours';
  const phone = toE164(fromPhone);
  const target = await targetOf(deps.pool, phone, answer);
  if (target === null) return 'not_ours';

  const isVideo = answer.media?.kind === 'video';
  if (answer.messageId !== null) {
    const have = await deps.pool.query('SELECT 1 FROM activity_response WHERE wa_message_id = $1', [
      answer.messageId,
    ]);
    // Meta retried a webhook: already kept. A video still goes on to be a post, as it did.
    if ((have.rowCount ?? 0) > 0) return isVideo ? 'continue' : 'taken';
  }

  const kind =
    answer.media?.kind === 'image'
      ? 'photo'
      : answer.media?.kind === 'voice' || answer.media?.kind === 'audio'
        ? 'audio'
        : null;
  const responseId = randomUUID();
  let file: {
    readonly contentType: string;
    readonly storedPath: string;
    readonly sha256: string;
    readonly bytes: number;
  } | null = null;

  if (kind !== null) {
    const got = await downloadMedia(deps.config, answer.media!.mediaId, deps.fetchImpl);
    const verdict = got.ok
      ? decideType(got.contentType, got.bytes, kind === 'photo' ? PHOTO_TYPES : AUDIO_TYPES)
      : null;
    const tooLarge =
      got.ok && got.bytes.length > (kind === 'photo' ? MAX_PHOTO_BYTES : MAX_AUDIO_BYTES);
    if (!got.ok || verdict === null || !verdict.ok || tooLarge) {
      log('warn', 'an answer to an Activities response could not be kept', {
        why: !got.ok ? got.failure : verdict !== null && !verdict.ok ? verdict.why : 'too large',
      });
      const told = await sendSession(
        deps.config,
        {
          toPhone: phone,
          text:
            kind === 'photo'
              ? 'Your picture could not be received. Please send it again.'
              : 'Your voice note could not be received. Please send it again.',
        },
        deps.fetchImpl,
      );
      if (!told.ok) log('info', 'could not reply about an answer', { failure: told.failure });
      return 'taken';
    }
    const storedPath = join(target.postId, 'replies', `${responseId}.${EXT[verdict.contentType]!}`);
    const absolute = inside(deps.root, storedPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, got.bytes, { flag: 'wx' });
    file = {
      contentType: verdict.contentType,
      storedPath,
      sha256: createHash('sha256').update(got.bytes).digest('hex'),
      bytes: got.bytes.length,
    };
  }

  const body = file === null ? described(answer) : answer.text.trim().slice(0, 4000);
  if (file === null && body === '') return 'not_ours';

  // The post may have gone (deleted, or its thirty days) between the Respond and the answer.
  const kept = await deps.pool.query(
    `INSERT INTO activity_response
       (response_id, post_id, direction, phone, body, in_reply_to, matched_by, wa_message_id,
        media_kind, content_type, stored_path, sha256, byte_size, created_at)
     -- Dated by when it reached us, not by the handset's clock (whole seconds, and not ours): an
     -- answer must sort after the message it answers.
     SELECT $1, $2, 'in', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()
      WHERE EXISTS (SELECT 1 FROM activity_post WHERE post_id = $2)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [
      responseId,
      target.postId,
      phone,
      body,
      target.responseId,
      target.matchedBy,
      answer.messageId,
      file === null ? null : kind,
      file?.contentType ?? null,
      file?.storedPath ?? null,
      file?.sha256 ?? null,
      file?.bytes ?? null,
    ],
  );
  if ((kept.rowCount ?? 0) === 0 && file !== null) {
    await rm(inside(deps.root, file.storedPath), { force: true }).catch(() => {});
  }
  return isVideo ? 'continue' : 'taken';
}

//------------------------------------------------------------------------------
// An answer's photo or voice note
//------------------------------------------------------------------------------

/**
 * Hand an answer's file back, inline — to a caller who may respond, and nobody else. The same
 * rules as a post's own media (`serveMedia`): only types checked by their bytes are ever stored,
 * the stored type is the one sent, `nosniff`, and a sandboxing CSP. A voice note answers byte
 * ranges so a phone's player can seek.
 */
export async function serveResponseMedia(
  pool: Pool,
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  responseId: string,
): Promise<ActivitiesResult<null> | null> {
  if (!UUID_RE.test(responseId)) return refuse(404, 'no such file');
  const c = await caller(pool, identity);
  if (!c.can.has('activities.respond')) return refuse(404, 'no such file');
  const found = await pool.query<{
    post_id: string;
    content_type: string | null;
    stored_path: string | null;
    sha256: string | null;
  }>(
    'SELECT post_id, content_type, stored_path, sha256 FROM activity_response WHERE response_id = $1',
    [responseId],
  );
  const row = found.rows[0];
  if (row === undefined || row.stored_path === null || row.content_type === null) {
    return refuse(404, 'no such file');
  }
  const seen = await visiblePost(pool, c, row.post_id);
  if ('ok' in seen) return refuse(404, 'no such file');

  const etag = `"${(row.sha256 ?? '').slice(0, 32)}"`;
  const headers = {
    'content-type': row.content_type,
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'accept-ranges': 'bytes',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(inside(root, row.stored_path));
  } catch {
    return refuse(410, 'the file is recorded but missing from disk');
  }
  const range = parseRange(req.headers.range, bytes.length);
  if (range === null) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}` }).end();
    return null;
  }
  if (range === 'whole') {
    res.writeHead(200, { ...headers, 'content-length': bytes.length });
    res.end(bytes);
    return null;
  }
  res.writeHead(206, {
    ...headers,
    'content-length': range.end - range.start + 1,
    'content-range': `bytes ${range.start}-${range.end}/${bytes.length}`,
  });
  res.end(bytes.subarray(range.start, range.end + 1));
  return null;
}
