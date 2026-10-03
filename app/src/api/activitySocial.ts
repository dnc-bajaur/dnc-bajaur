/**
 * Reactions and comments on an Activities post — ADR-0044 §4–§5 (Bajaur, PLAN §4b G2).
 *
 * **In the app only.** Nothing here sends anything on WhatsApp: the owner asked for no noise on
 * the channel emergencies use. An officer who posts by WhatsApp and never signs in does not see
 * them; what reaches that officer is a Respond (`activityResponses.ts`), sent on purpose.
 *
 * **Who may:** any account that can see the post and holds `activities.comment` — every role by
 * default, a `viewer` included, and the DC can deny it to one account. Asked here for every
 * request (INV-05), and refused until a forced password change is done, like posting.
 *
 * A reaction is one mark per person per post: *Seen* or *Well done*. A comment is deleted by its
 * author, or by a moderator — and a moderator removing somebody else's words leaves a line in the
 * Activities log (INV-06). Both go with their post (`ON DELETE CASCADE`): a hard delete, or the
 * 30-day rule.
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import {
  caller,
  designationSql,
  refuse,
  UUID_RE,
  visiblePost,
  type ActivitiesResult,
  type Caller,
} from './activitiesAccess.js';

export const REACTION_KINDS = ['seen', 'well_done'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** As long as a WhatsApp caption may be; a comment is a remark, not a report. */
export const MAX_COMMENT_LENGTH = 1000;

/** How many comments ride with a post in the feed; the rest are one request away. */
export const COMMENTS_IN_FEED = 3;

export interface CommentView {
  readonly commentId: string;
  readonly authorName: string;
  readonly authorDesignation: string | null;
  readonly body: string;
  readonly createdAt: string;
  /** Its author, or a moderator. Drawn by the page, enforced again by the delete. */
  readonly mayDelete: boolean;
}

export interface SocialView {
  readonly reactions: readonly {
    readonly kind: ReactionKind;
    readonly count: number;
    /** Who, oldest first. */
    readonly names: readonly string[];
  }[];
  readonly myReaction: ReactionKind | null;
  readonly commentCount: number;
  /** The newest few, oldest first. */
  readonly comments: readonly CommentView[];
  /** May the caller react and comment on this post? */
  readonly mayComment: boolean;
}

function mayTakePart(c: Caller, hidden: boolean): boolean {
  return c.can.has('activities.comment') && !c.identity.mustChangePassword && !hidden;
}

function refusal<T>(c: Caller, hidden: boolean): ActivitiesResult<T> | null {
  if (!c.can.has('activities.comment')) {
    return refuse(403, 'you do not have permission to react or comment');
  }
  if (c.identity.mustChangePassword) {
    return refuse(403, 'choose your own password before you react or comment');
  }
  if (hidden) return refuse(409, 'this post is in the Recycle bin');
  return null;
}

interface CommentRow {
  comment_id: string;
  post_id: string;
  author_person_id: string;
  author_name: string | null;
  author_designation: string | null;
  body: string;
  created_at: string;
}

const COMMENT_COLUMNS = `c.comment_id, c.post_id, c.author_person_id, a.full_name AS author_name,
         ${designationSql('a')} AS author_designation, c.body, c.created_at`;

function commentView(c: Caller, r: CommentRow): CommentView {
  return {
    commentId: r.comment_id,
    authorName: r.author_name ?? '',
    authorDesignation: r.author_designation,
    body: r.body,
    createdAt: r.created_at,
    mayDelete: r.author_person_id === c.identity.personId || c.can.has('activities.moderate'),
  };
}

/**
 * Reactions and the newest comments for a page of posts — two queries for the whole page, not
 * two per post. The caller has already decided these posts may be seen.
 */
export async function socialFor(
  pool: Pool,
  c: Caller,
  posts: readonly { readonly postId: string; readonly hidden: boolean }[],
): Promise<ReadonlyMap<string, SocialView>> {
  const ids = posts.map((p) => p.postId);
  const out = new Map<string, SocialView>();
  if (ids.length === 0) return out;

  const reactions = await pool.query<{
    post_id: string;
    person_id: string;
    kind: ReactionKind;
    full_name: string | null;
  }>(
    `SELECT r.post_id, r.person_id, r.kind, p.full_name
       FROM activity_reaction r JOIN person p ON p.person_id = r.person_id
      WHERE r.post_id = ANY($1)
      ORDER BY r.created_at, r.person_id`,
    [ids],
  );
  const comments = await pool.query<CommentRow & { total: number }>(
    `SELECT * FROM (
       SELECT ${COMMENT_COLUMNS},
              (count(*) OVER (PARTITION BY c.post_id))::int AS total,
              row_number() OVER (PARTITION BY c.post_id
                                 ORDER BY c.created_at DESC, c.comment_id DESC) AS rn
         FROM activity_comment c JOIN person a ON a.person_id = c.author_person_id
        WHERE c.post_id = ANY($1)) x
      WHERE rn <= $2
      ORDER BY created_at, comment_id`,
    [ids, COMMENTS_IN_FEED],
  );

  for (const p of posts) {
    const mine = reactions.rows.filter((r) => r.post_id === p.postId);
    const said = comments.rows.filter((r) => r.post_id === p.postId);
    out.set(p.postId, {
      reactions: REACTION_KINDS.map((kind) => {
        const of = mine.filter((r) => r.kind === kind);
        return { kind, count: of.length, names: of.map((r) => r.full_name ?? '') };
      }),
      myReaction: mine.find((r) => r.person_id === c.identity.personId)?.kind ?? null,
      commentCount: said[0]?.total ?? 0,
      comments: said.map((r) => commentView(c, r)),
      mayComment: mayTakePart(c, p.hidden),
    });
  }
  return out;
}

async function socialOf(
  pool: Pool,
  c: Caller,
  postId: string,
  hidden: boolean,
): Promise<SocialView> {
  return (await socialFor(pool, c, [{ postId, hidden }])).get(postId)!;
}

/**
 * Put one's mark on a post, change it, or — with `kind: null` — take it off. Returns the post's
 * reactions and comments as they now stand, so the page redraws one card and not the feed.
 */
export async function react(
  pool: Pool,
  identity: Identity,
  postId: string,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<SocialView>> {
  const c = await caller(pool, identity);
  const post = await visiblePost(pool, c, postId);
  if ('ok' in post) return post;
  const denied = refusal<SocialView>(c, post.hidden);
  if (denied !== null) return denied;

  const kind = input['kind'];
  if (kind === null) {
    await pool.query('DELETE FROM activity_reaction WHERE post_id = $1 AND person_id = $2', [
      postId,
      identity.personId,
    ]);
  } else if (typeof kind === 'string' && (REACTION_KINDS as readonly string[]).includes(kind)) {
    await pool.query(
      `INSERT INTO activity_reaction (post_id, person_id, kind) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, person_id) DO UPDATE SET kind = EXCLUDED.kind, created_at = now()`,
      [postId, identity.personId, kind],
    );
  } else {
    return refuse(400, "'kind' must be 'seen', 'well_done' or null");
  }
  return { ok: true, value: await socialOf(pool, c, postId, post.hidden) };
}

export async function addComment(
  pool: Pool,
  identity: Identity,
  postId: string,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<SocialView>> {
  const c = await caller(pool, identity);
  const post = await visiblePost(pool, c, postId);
  if ('ok' in post) return post;
  const denied = refusal<SocialView>(c, post.hidden);
  if (denied !== null) return denied;

  const body = typeof input['body'] === 'string' ? input['body'].trim() : '';
  if (body === '') return refuse(400, 'write the comment first');
  if (body.length > MAX_COMMENT_LENGTH) {
    return refuse(400, `a comment is at most ${MAX_COMMENT_LENGTH} characters`);
  }
  await pool.query(
    'INSERT INTO activity_comment (post_id, author_person_id, body) VALUES ($1, $2, $3)',
    [postId, identity.personId, body],
  );
  return { ok: true, value: await socialOf(pool, c, postId, post.hidden) };
}

/** Every comment on a post, oldest first — what "Show all comments" asks for. */
export async function listComments(
  pool: Pool,
  identity: Identity,
  postId: string,
): Promise<ActivitiesResult<readonly CommentView[]>> {
  const c = await caller(pool, identity);
  const post = await visiblePost(pool, c, postId);
  if ('ok' in post) return post;
  const { rows } = await pool.query<CommentRow>(
    `SELECT ${COMMENT_COLUMNS}
       FROM activity_comment c JOIN person a ON a.person_id = c.author_person_id
      WHERE c.post_id = $1
      ORDER BY c.created_at, c.comment_id`,
    [postId],
  );
  return { ok: true, value: rows.map((r) => commentView(c, r)) };
}

/**
 * Delete a comment: its author, or a moderator. A moderator removing somebody else's leaves one
 * line in the Activities log — who removed whose comment, and never the words.
 */
export async function removeComment(
  pool: Pool,
  identity: Identity,
  commentId: string,
): Promise<ActivitiesResult<SocialView>> {
  if (!UUID_RE.test(commentId)) return refuse(404, 'no such comment');
  const c = await caller(pool, identity);
  const found = await pool.query<{ post_id: string; author_person_id: string }>(
    'SELECT post_id, author_person_id FROM activity_comment WHERE comment_id = $1',
    [commentId],
  );
  const comment = found.rows[0];
  if (comment === undefined) return refuse(404, 'no such comment');
  const post = await visiblePost(pool, c, comment.post_id);
  if ('ok' in post) return refuse(404, 'no such comment');

  const own = comment.author_person_id === identity.personId;
  if (!own && !c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to delete this comment');
  }
  const gone = await pool.query('DELETE FROM activity_comment WHERE comment_id = $1', [commentId]);
  if ((gone.rowCount ?? 0) > 0 && !own) {
    await pool.query(
      `INSERT INTO activity_log (type, actor_person_id, post_id, unit_id, detail)
       VALUES ('comment_removed', $1, $2, $3, $4)`,
      [
        identity.personId,
        comment.post_id,
        post.unitId,
        JSON.stringify({ authorPersonId: comment.author_person_id }),
      ],
    );
  }
  return { ok: true, value: await socialOf(pool, c, comment.post_id, post.hidden) };
}
