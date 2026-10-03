/**
 * Who is asking, and may they see this post — the two questions every Activities module asks
 * (ADR-0039 §5). Kept in one place so posts (`activities.ts`), reactions and comments
 * (`activitySocial.ts`) and Respond (`activityResponses.ts`) cannot answer them differently.
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Permission } from '../domain/roles.js';
import { permissionsOf } from './settings.js';

export type ActivitiesResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

export function refuse<T>(status: number, error: string): ActivitiesResult<T> {
  return { ok: false, status, error };
}

export interface Caller {
  readonly identity: Identity;
  readonly can: ReadonlySet<Permission>;
}

export async function caller(pool: Pool, identity: Identity): Promise<Caller> {
  return { identity, can: await permissionsOf(pool, identity) };
}

/**
 * May this caller see this post at all? Hidden posts only in the Recycle bin, and only to a
 * moderator. Otherwise: everyone's with `read_all`, one's own without it.
 */
export function maySee(c: Caller, authorPersonId: string, hiddenAt: string | null): boolean {
  if (hiddenAt !== null) return c.can.has('activities.moderate');
  return c.can.has('activities.read_all') || authorPersonId === c.identity.personId;
}

/**
 * A person's post, as text: the account's own, else the Directory post the contact holds
 * (ADR-0029). `alias` is the `person` row's alias in the query this is spliced into.
 */
export function designationSql(alias: string): string {
  return `COALESCE(${alias}.designation,
                  (SELECT s.title FROM duty_assignment d JOIN seat s ON s.seat_id = d.seat_id
                    WHERE d.person_id = ${alias}.person_id AND d.to_at IS NULL
                      AND s.retired_at IS NULL
                    ORDER BY d.from_at DESC LIMIT 1))`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The post a reaction, a comment or a Respond is about — or the refusal, saying no more. */
export async function visiblePost(
  pool: Pool,
  c: Caller,
  postId: string,
): Promise<
  | { readonly authorPersonId: string; readonly unitId: string; readonly hidden: boolean }
  | ActivitiesResult<never>
> {
  if (!UUID_RE.test(postId)) return refuse(404, 'no such post');
  const found = await pool.query<{
    author_person_id: string;
    unit_id: string;
    hidden_at: string | null;
  }>('SELECT author_person_id, unit_id, hidden_at FROM activity_post WHERE post_id = $1', [postId]);
  const post = found.rows[0];
  if (post === undefined || !maySee(c, post.author_person_id, post.hidden_at)) {
    return refuse(404, 'no such post');
  }
  return {
    authorPersonId: post.author_person_id,
    unitId: post.unit_id,
    hidden: post.hidden_at !== null,
  };
}
