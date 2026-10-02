/**
 * Activities — departments' daily pictures, inside the app (ADR-0039, Bajaur — phase C1).
 *
 * A **separate module**. It writes nothing to the incident event log or to `evidence`, reads
 * no seat, and knows nothing of the removed operational department layer. Its "Department" is
 * `activity_unit`, a list the DC keeps for filing and filtering only — no authority attaches
 * to it (ADR-0039 §2).
 *
 * **Who may do what** is `domain/roles.ts` (ADR-0038 §3), asked here for every request, never
 * in the router and never in the page (INV-05):
 *
 *   * `activities.upload`      — post; refused until a forced password change is done;
 *   * `activities.read_all`    — see everyone's posts (without it: one's own only);
 *   * `activities.delete_own`  — permanently delete one's own posts;
 *   * `activities.moderate`    — hide (Recycle bin), restore, or permanently delete any post;
 *   * `activities.departments` — keep the Department list and set people's default department.
 *
 * **Every create, delete and restore is attributable** (INV-06): it appends to `activity_log`,
 * which outlives the post — a hard delete leaves exactly one line saying who deleted which post
 * and when, and never the media.
 *
 * **Files** follow evidence's rules (`ops/evidence.ts`): the server chooses every path, the bytes
 * decide the type (`decideType`), and the file is written before its row. Unlike evidence,
 * photos are served **inline** so the page can show them — safe only because nothing but JPEG,
 * PNG and WebP is ever stored, each checked by its magic number, and each served with its sniffed
 * type, `nosniff` and a sandboxing CSP.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { Permission } from '../domain/roles.js';
import { districtDate } from '../domain/districtTime.js';
import { decideType } from '../ops/fileType.js';
import { fits, zipWriter } from '../ops/zip.js';
import { log } from '../obs/log.js';
import { permissionsOf } from './settings.js';

export type ActivitiesResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse<T>(status: number, error: string): ActivitiesResult<T> {
  return { ok: false, status, error };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Up to ten photos on one post (ADR-0039 §3). */
export const MAX_PHOTOS_PER_POST = 10;

/**
 * The largest photo accepted. The phone shrinks every photo to a 2048 px long edge before it is
 * sent (ADR-0039 §4), which is about one megabyte; eight leaves room for a PNG or a phone that
 * could not shrink it, without letting one upload fill the disk. Enforced while reading.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** The small copy for the list, made on the phone alongside the photo. */
export const MAX_THUMB_BYTES = 512 * 1024;

/**
 * Every post is deleted this many days after it was uploaded — Recycle bin included
 * (ADR-0039 §7). Counted from upload, not from the activity's date: a post sent late still gets
 * its thirty days.
 */
export const RETENTION_DAYS = 30;

/** How many days before that the DC is warned and offered the ZIP. */
export const WARNING_DAYS = 3;

const PHOTO_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Where Activities files live unless told otherwise — beside evidence, never in the web root. */
export function defaultActivitiesRoot(): string {
  return join(process.cwd(), 'var', 'activities');
}

function inside(root: string, relative: string): string {
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(resolve(root) + sep)) {
    throw new Error('refusing to touch a file outside the Activities root');
  }
  return absolute;
}

//------------------------------------------------------------------------------
// Who is asking
//------------------------------------------------------------------------------

interface Caller {
  readonly identity: Identity;
  readonly can: ReadonlySet<Permission>;
}

async function caller(pool: Pool, identity: Identity): Promise<Caller> {
  return { identity, can: await permissionsOf(pool, identity) };
}

async function writeLog(
  pool: Pool,
  entry: {
    readonly type: string;
    readonly actor: string;
    readonly postId?: string | null;
    readonly unitId?: string | null;
    readonly detail?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO activity_log (type, actor_person_id, post_id, unit_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.type,
      entry.actor,
      entry.postId ?? null,
      entry.unitId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ],
  );
}

//------------------------------------------------------------------------------
// What the page needs to know about the caller
//------------------------------------------------------------------------------

export interface ActivitiesMe {
  readonly personId: string;
  readonly fullName: string;
  readonly role: string;
  readonly mustChangePassword: boolean;
  readonly permissions: readonly Permission[];
  readonly defaultUnitId: string | null;
  /** Today in the district — the latest date a post may carry. */
  readonly today: string;
}

/**
 * The caller's Activities permissions, so the page can draw the right buttons. Drawing is all
 * the page does with it: every action below asks again (INV-05).
 */
export async function me(pool: Pool, identity: Identity): Promise<ActivitiesResult<ActivitiesMe>> {
  const c = await caller(pool, identity);
  const row = await pool.query<{ activity_unit_id: string | null }>(
    `SELECT p.activity_unit_id
       FROM person p
       LEFT JOIN activity_unit u ON u.unit_id = p.activity_unit_id
      WHERE p.person_id = $1 AND u.retired_at IS NULL`,
    [identity.personId],
  );
  return {
    ok: true,
    value: {
      personId: identity.personId,
      fullName: identity.fullName,
      role: identity.role,
      mustChangePassword: identity.mustChangePassword,
      permissions: [...c.can].filter((p) => p.startsWith('activities.')),
      defaultUnitId: row.rows[0]?.activity_unit_id ?? null,
      today: districtDate(),
    },
  };
}

//------------------------------------------------------------------------------
// The Department list (ADR-0039 §2)
//------------------------------------------------------------------------------

export interface UnitView {
  readonly unitId: string;
  readonly name: string;
  readonly retired: boolean;
}

export async function listUnits(pool: Pool): Promise<ActivitiesResult<readonly UnitView[]>> {
  const { rows } = await pool.query<{ unit_id: string; name: string; retired: boolean }>(
    `SELECT unit_id, name, retired_at IS NOT NULL AS retired
       FROM activity_unit ORDER BY retired_at IS NOT NULL, lower(name)`,
  );
  return {
    ok: true,
    value: rows.map((r) => ({ unitId: r.unit_id, name: r.name, retired: r.retired })),
  };
}

function unitName(input: Record<string, unknown>): string | ActivitiesResult<never> {
  const name = text(input['name']);
  if (name === '') return refuse(400, 'a department needs a name');
  if (name.length > 120) return refuse(400, 'that name is too long');
  return name;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

export async function createUnit(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<UnitView>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.departments')) {
    return refuse(403, 'you do not have permission to keep the Department list');
  }
  const name = unitName(input);
  if (typeof name !== 'string') return name;

  let unitId: string;
  try {
    const res = await pool.query<{ unit_id: string }>(
      'INSERT INTO activity_unit (name, created_by_person_id) VALUES ($1, $2) RETURNING unit_id',
      [name, identity.personId],
    );
    unitId = res.rows[0]!.unit_id;
  } catch (e) {
    if (isUniqueViolation(e)) return refuse(409, 'there is already a department with that name');
    throw e;
  }
  await writeLog(pool, {
    type: 'unit_created',
    actor: identity.personId,
    unitId,
    detail: { name },
  });
  return { ok: true, value: { unitId, name, retired: false } };
}

export async function renameUnit(
  pool: Pool,
  identity: Identity,
  unitId: string,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<UnitView>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.departments')) {
    return refuse(403, 'you do not have permission to keep the Department list');
  }
  const name = unitName(input);
  if (typeof name !== 'string') return name;

  const before = await pool.query<{ name: string }>(
    'SELECT name FROM activity_unit WHERE unit_id = $1 AND retired_at IS NULL',
    [unitId],
  );
  if (before.rows[0] === undefined) return refuse(404, 'no such department');
  try {
    await pool.query('UPDATE activity_unit SET name = $2 WHERE unit_id = $1', [unitId, name]);
  } catch (e) {
    if (isUniqueViolation(e)) return refuse(409, 'there is already a department with that name');
    throw e;
  }
  await writeLog(pool, {
    type: 'unit_renamed',
    actor: identity.personId,
    unitId,
    detail: { from: before.rows[0].name, to: name },
  });
  return { ok: true, value: { unitId, name, retired: false } };
}

/**
 * Retire a department. Never deleted: its old posts still name it. It leaves the list a new post
 * chooses from, and anybody whose default it was is left with none.
 */
export async function retireUnit(
  pool: Pool,
  identity: Identity,
  unitId: string,
): Promise<ActivitiesResult<{ readonly unitId: string }>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.departments')) {
    return refuse(403, 'you do not have permission to keep the Department list');
  }
  const res = await pool.query<{ name: string }>(
    `UPDATE activity_unit SET retired_at = now()
      WHERE unit_id = $1 AND retired_at IS NULL RETURNING name`,
    [unitId],
  );
  if (res.rows[0] === undefined) return refuse(404, 'no such department');
  await pool.query('UPDATE person SET activity_unit_id = NULL WHERE activity_unit_id = $1', [
    unitId,
  ]);
  await writeLog(pool, {
    type: 'unit_retired',
    actor: identity.personId,
    unitId,
    detail: { name: res.rows[0].name },
  });
  return { ok: true, value: { unitId } };
}

/**
 * Set an account's default department. Anyone may set their own — it only pre-fills a form.
 * Setting somebody else's is keeping the Department list, and needs that permission.
 */
export async function setDefaultUnit(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<{ readonly unitId: string | null }>> {
  const personId = text(input['personId']) || identity.personId;
  const unitId = input['unitId'] === null ? null : text(input['unitId']);
  if (!UUID_RE.test(personId)) return refuse(404, 'no such account');

  if (personId !== identity.personId) {
    const c = await caller(pool, identity);
    if (!c.can.has('activities.departments')) {
      return refuse(403, "you do not have permission to set another account's department");
    }
  }
  if (unitId !== null) {
    if (!UUID_RE.test(unitId)) return refuse(404, 'no such department');
    const live = await pool.query(
      'SELECT 1 FROM activity_unit WHERE unit_id = $1 AND retired_at IS NULL',
      [unitId],
    );
    if (live.rowCount === 0) return refuse(404, 'no such department');
  }

  const res = await pool.query(
    `UPDATE person SET activity_unit_id = $2
      WHERE person_id = $1 AND password_hash IS NOT NULL AND removed_at IS NULL`,
    [personId, unitId],
  );
  if (res.rowCount === 0) return refuse(404, 'no such account');
  await writeLog(pool, {
    type: 'default_unit_set',
    actor: identity.personId,
    unitId,
    detail: { personId },
  });
  return { ok: true, value: { unitId } };
}

//------------------------------------------------------------------------------
// People — for the "by person" view
//------------------------------------------------------------------------------

export interface PersonView {
  readonly personId: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly defaultUnitId: string | null;
}

/** Everyone who can sign in. Only for a caller who may see everyone's posts. */
export async function listPeople(
  pool: Pool,
  identity: Identity,
): Promise<ActivitiesResult<readonly PersonView[]>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.read_all')) {
    return refuse(403, "you do not have permission to see other people's posts");
  }
  const { rows } = await pool.query<{
    person_id: string;
    full_name: string | null;
    designation: string | null;
    activity_unit_id: string | null;
  }>(
    `SELECT person_id, full_name, designation, activity_unit_id
       FROM person
      WHERE password_hash IS NOT NULL AND removed_at IS NULL
      ORDER BY lower(full_name)`,
  );
  return {
    ok: true,
    value: rows.map((r) => ({
      personId: r.person_id,
      fullName: r.full_name ?? '',
      designation: r.designation,
      defaultUnitId: r.activity_unit_id,
    })),
  };
}

//------------------------------------------------------------------------------
// Posts
//------------------------------------------------------------------------------

export interface PostView {
  readonly postId: string;
  readonly unitId: string;
  readonly unitName: string;
  readonly authorPersonId: string;
  readonly authorName: string;
  readonly authorDesignation: string | null;
  readonly activityDate: string;
  readonly caption: string;
  readonly place: string | null;
  readonly createdAt: string;
  readonly hiddenAt: string | null;
  /** When the 30-day rule deletes it (ADR-0039 §7). */
  readonly expiresAt: string;
  readonly photos: readonly { readonly mediaId: string; readonly hasThumb: boolean }[];
  /** What the caller may do with it — drawn by the page, enforced again by each action. */
  readonly mayDelete: boolean;
  readonly mayModerate: boolean;
  readonly mayAddPhotos: boolean;
}

interface PostRow {
  post_id: string;
  unit_id: string;
  unit_name: string;
  author_person_id: string;
  author_name: string | null;
  author_designation: string | null;
  activity_date: string;
  caption: string;
  place: string | null;
  created_at: string;
  hidden_at: string | null;
  expires_at: string;
  photos: { mediaId: string; hasThumb: boolean }[] | null;
}

const POST_SELECT = `
  SELECT p.post_id, p.unit_id, u.name AS unit_name, p.author_person_id,
         a.full_name AS author_name, a.designation AS author_designation,
         to_char(p.activity_date, 'YYYY-MM-DD') AS activity_date,
         p.caption, p.place, p.created_at, p.hidden_at,
         p.created_at + make_interval(days => ${RETENTION_DAYS}) AS expires_at,
         (SELECT json_agg(json_build_object('mediaId', m.media_id,
                                            'hasThumb', m.thumb_path IS NOT NULL)
                          ORDER BY m.created_at, m.media_id)
            FROM activity_media m WHERE m.post_id = p.post_id) AS photos
    FROM activity_post p
    JOIN activity_unit u ON u.unit_id = p.unit_id
    JOIN person a        ON a.person_id = p.author_person_id`;

function toView(c: Caller, r: PostRow): PostView {
  const own = r.author_person_id === c.identity.personId;
  const photos = r.photos ?? [];
  return {
    postId: r.post_id,
    unitId: r.unit_id,
    unitName: r.unit_name,
    authorPersonId: r.author_person_id,
    authorName: r.author_name ?? '',
    authorDesignation: r.author_designation,
    activityDate: r.activity_date,
    caption: r.caption,
    place: r.place,
    createdAt: r.created_at,
    hiddenAt: r.hidden_at,
    expiresAt: r.expires_at,
    photos,
    mayDelete: c.can.has('activities.moderate') || (own && c.can.has('activities.delete_own')),
    mayModerate: c.can.has('activities.moderate'),
    mayAddPhotos:
      own &&
      r.hidden_at === null &&
      photos.length < MAX_PHOTOS_PER_POST &&
      c.can.has('activities.upload') &&
      !c.identity.mustChangePassword,
  };
}

/**
 * May this caller see this post at all? Hidden posts only in the Recycle bin, and only to a
 * moderator. Otherwise: everyone's with `read_all`, one's own without it.
 */
function maySee(c: Caller, authorPersonId: string, hiddenAt: string | null): boolean {
  if (hiddenAt !== null) return c.can.has('activities.moderate');
  return c.can.has('activities.read_all') || authorPersonId === c.identity.personId;
}

const PAGE_SIZE = 30;

/**
 * The views: all departments, by department, by person, by date range — limited by what the
 * caller may see (ADR-0039 §5). `bin=1` is the Recycle bin: hidden posts, moderators only.
 * Newest first, thirty at a time; `before` is the `createdAt` of the last post already shown.
 */
export async function listPosts(
  pool: Pool,
  identity: Identity,
  query: URLSearchParams,
): Promise<ActivitiesResult<{ readonly posts: readonly PostView[]; readonly more: boolean }>> {
  const c = await caller(pool, identity);
  const bin = query.get('bin') === '1';
  if (bin && !c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to open the Recycle bin');
  }

  const where: string[] = [bin ? 'p.hidden_at IS NOT NULL' : 'p.hidden_at IS NULL'];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  // Without `read_all`, the server narrows to one's own — whatever the query asked for.
  if (!bin && !c.can.has('activities.read_all')) add('p.author_person_id = ?', identity.personId);

  const unit = query.get('unit');
  if (unit !== null && unit !== '') {
    if (!UUID_RE.test(unit)) return refuse(400, 'unknown department');
    add('p.unit_id = ?', unit);
  }
  const person = query.get('person');
  if (person !== null && person !== '') {
    if (!UUID_RE.test(person)) return refuse(400, 'unknown person');
    add('p.author_person_id = ?', person);
  }
  for (const [key, op] of [
    ['from', '>='],
    ['to', '<='],
  ] as const) {
    const value = query.get(key);
    if (value === null || value === '') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) {
      return refuse(400, `${key} must be a date (YYYY-MM-DD)`);
    }
    add(`p.activity_date ${op} ?::date`, value);
  }
  const before = query.get('before');
  if (before !== null && before !== '') {
    if (!Number.isFinite(Date.parse(before))) return refuse(400, 'before must be a time');
    add('p.created_at < ?::timestamptz', before);
  }

  params.push(PAGE_SIZE + 1);
  const { rows } = await pool.query<PostRow>(
    `${POST_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC, p.post_id DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    ok: true,
    value: {
      posts: rows.slice(0, PAGE_SIZE).map((r) => toView(c, r)),
      more: rows.length > PAGE_SIZE,
    },
  };
}

function mayUpload<T>(c: Caller): ActivitiesResult<T> | null {
  if (!c.can.has('activities.upload')) return refuse(403, 'you do not have permission to post');
  if (c.identity.mustChangePassword) {
    return refuse(403, 'choose your own password before you post');
  }
  return null;
}

/**
 * Start a post: department, date, caption, place. Photos follow one request each
 * (`addPhoto`) — each one that arrives is safe on its own, which on a weak connection beats one
 * request that fails at 90%.
 */
export async function createPost(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
): Promise<ActivitiesResult<PostView>> {
  const c = await caller(pool, identity);
  const denied = mayUpload<PostView>(c);
  if (denied !== null) return denied;

  const unitId = text(input['unitId']);
  const activityDate = text(input['activityDate']);
  const caption = text(input['caption']);
  const place = text(input['place']);

  if (!UUID_RE.test(unitId)) return refuse(400, 'choose a department');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate) || !Number.isFinite(Date.parse(activityDate))) {
    return refuse(400, 'choose the date of the activity');
  }
  if (activityDate > districtDate()) return refuse(400, 'the date cannot be in the future');
  if (caption === '') return refuse(400, 'write what the activity was');
  if (caption.length > 2000) return refuse(400, 'that description is too long');
  if (place.length > 200) return refuse(400, 'that place is too long');

  const unit = await pool.query(
    'SELECT 1 FROM activity_unit WHERE unit_id = $1 AND retired_at IS NULL',
    [unitId],
  );
  if (unit.rowCount === 0) return refuse(400, 'that department is not on the list');

  const res = await pool.query<{ post_id: string }>(
    `INSERT INTO activity_post (unit_id, author_person_id, activity_date, caption, place)
     VALUES ($1, $2, $3, $4, $5) RETURNING post_id`,
    [unitId, identity.personId, activityDate, caption, place === '' ? null : place],
  );
  const postId = res.rows[0]!.post_id;
  await writeLog(pool, { type: 'posted', actor: identity.personId, postId, unitId });

  const row = await pool.query<PostRow>(`${POST_SELECT} WHERE p.post_id = $1`, [postId]);
  return { ok: true, value: toView(c, row.rows[0]!) };
}

/**
 * Read the body with a hard cap, applied while reading — never after (`evidenceRoutes.ts`).
 */
async function readCapped(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Add one photo to one's own post.
 *
 * The body is the photo, as raw bytes — the same choice as evidence, for the same reasons. When
 * the phone also made a small copy for the list, the body is `thumb ++ photo` and the
 * `x-thumb-bytes` header says where the first ends: one request, so a photo never arrives
 * without its thumbnail or the other way round. Both are checked by their magic numbers.
 *
 * Checks run before the body is read: refusing after reading eight megabytes off a weak link
 * wastes an officer's data allowance.
 */
export async function addPhoto(
  pool: Pool,
  root: string,
  req: IncomingMessage,
  identity: Identity,
  postId: string,
): Promise<ActivitiesResult<{ readonly mediaId: string }>> {
  const c = await caller(pool, identity);
  const denied = mayUpload<{ readonly mediaId: string }>(c);
  if (denied !== null) return denied;

  const post = await pool.query<{ author_person_id: string; hidden_at: string | null; n: string }>(
    `SELECT p.author_person_id, p.hidden_at,
            (SELECT count(*) FROM activity_media m WHERE m.post_id = p.post_id) AS n
       FROM activity_post p WHERE p.post_id = $1`,
    [postId],
  );
  const found = post.rows[0];
  if (found === undefined || !maySee(c, found.author_person_id, found.hidden_at)) {
    return refuse(404, 'no such post');
  }
  if (found.author_person_id !== identity.personId) {
    return refuse(403, 'photos can be added only to your own post');
  }
  if (found.hidden_at !== null) return refuse(409, 'this post is in the Recycle bin');
  if (Number(found.n) >= MAX_PHOTOS_PER_POST) {
    return refuse(409, `a post holds at most ${MAX_PHOTOS_PER_POST} photos`);
  }

  const declared = req.headers['content-type'];
  if (typeof declared !== 'string' || declared.trim() === '') {
    return refuse(400, 'content-type is required');
  }
  const thumbHeader = req.headers['x-thumb-bytes'];
  const thumbBytes = typeof thumbHeader === 'string' ? Number(thumbHeader) : 0;
  if (!Number.isInteger(thumbBytes) || thumbBytes < 0 || thumbBytes > MAX_THUMB_BYTES) {
    return refuse(400, 'x-thumb-bytes is not a size this server accepts');
  }

  const body = await readCapped(req, MAX_PHOTO_BYTES + thumbBytes);
  if (body === null) return refuse(413, 'that photo is larger than 8 MB');
  if (body.length <= thumbBytes) return refuse(400, 'the photo is missing');

  const thumb = thumbBytes > 0 ? body.subarray(0, thumbBytes) : null;
  const photo = body.subarray(thumbBytes);

  const verdict = decideType(declared, photo, PHOTO_TYPES);
  if (!verdict.ok) return refuse(415, verdict.why);
  let thumbType: string | null = null;
  if (thumb !== null) {
    // The thumbnail is always JPEG — the phone makes it with `canvas.toBlob('image/jpeg')`.
    const t = decideType('image/jpeg', thumb, PHOTO_TYPES);
    if (!t.ok) return refuse(415, `thumbnail: ${t.why}`);
    thumbType = t.contentType;
  }

  const mediaId = randomUUID();
  const storedPath = join(postId, `${mediaId}.${EXT[verdict.contentType]!}`);
  const thumbPath = thumbType === null ? null : join(postId, `${mediaId}.thumb.${EXT[thumbType]!}`);

  // Written before the row, like evidence: a file with no row is an orphan a sweep can find; a
  // row with no file is a photo the system claims and cannot show.
  const absolute = inside(root, storedPath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, photo, { flag: 'wx' });
  if (thumb !== null && thumbPath !== null) {
    await writeFile(inside(root, thumbPath), thumb, { flag: 'wx' });
  }

  // The count is checked again in the insert itself, so two photos racing for the tenth slot
  // cannot both win.
  const inserted = await pool.query(
    `INSERT INTO activity_media
       (media_id, post_id, kind, content_type, byte_size, sha256, stored_path, thumb_path)
     SELECT $1, $2, 'photo', $3, $4, $5, $6, $7
      WHERE (SELECT count(*) FROM activity_media WHERE post_id = $2) < $8`,
    [
      mediaId,
      postId,
      verdict.contentType,
      photo.length,
      createHash('sha256').update(photo).digest('hex'),
      storedPath,
      thumbPath,
      MAX_PHOTOS_PER_POST,
    ],
  );
  if (inserted.rowCount === 0) {
    await removeFiles(root, [storedPath, thumbPath]);
    return refuse(409, `a post holds at most ${MAX_PHOTOS_PER_POST} photos`);
  }

  await writeLog(pool, {
    type: 'photo_added',
    actor: identity.personId,
    postId,
    detail: { mediaId },
  });
  return { ok: true, value: { mediaId } };
}

async function removeFiles(root: string, paths: readonly (string | null)[]): Promise<void> {
  for (const p of paths) {
    if (p === null) continue;
    try {
      await rm(inside(root, p), { force: true });
    } catch (e) {
      // The row is already gone; the file is now an orphan. Said in the journal, never silent.
      log('error', 'an Activities file could not be removed from disk', {
        path: p,
        error: String(e),
      });
    }
  }
}

/**
 * Hard delete — the post, its rows and its files, immediately (ADR-0039 §6).
 *
 * The uploader may delete their own; a moderator may delete anybody's, hidden or not. The log
 * keeps one line: who deleted which post, and when. Its copies in the media bucket are queued
 * for removal in the same transaction (`removePost`).
 */
export async function deletePost(
  pool: Pool,
  root: string,
  identity: Identity,
  postId: string,
): Promise<ActivitiesResult<{ readonly postId: string }>> {
  const c = await caller(pool, identity);
  const found = await pool.query<{ author_person_id: string; hidden_at: string | null }>(
    'SELECT author_person_id, hidden_at FROM activity_post WHERE post_id = $1',
    [postId],
  );
  const post = found.rows[0];
  const own = post?.author_person_id === identity.personId;
  // An author may still delete their own post after a moderator hid it.
  if (post === undefined || !(own || maySee(c, post.author_person_id, post.hidden_at))) {
    return refuse(404, 'no such post');
  }
  const allowed = c.can.has('activities.moderate') || (own && c.can.has('activities.delete_own'));
  if (!allowed) return refuse(403, 'you do not have permission to delete this post');

  const removed = await removePost(pool, root, postId, 'deleted', identity.personId);
  return removed ? { ok: true, value: { postId } } : refuse(404, 'no such post');
}

/**
 * Remove one post for good: its media rows, the post, one log line, and then its files.
 *
 * Shared by a person's hard delete (`deleted`, with who) and the 30-day rule (`expired`, with
 * nobody — ADR-0039 §7). In the same transaction, every object the post has in the media bucket
 * is queued for removal there (ADR-0039 §8), so a delete cannot be forgotten by the bucket even
 * if the bucket cannot be reached tonight.
 *
 * Returns false if the post was already gone — a second delete racing the first, or the expiry
 * job meeting a post somebody deleted a moment earlier.
 */
export async function removePost(
  pool: Pool,
  root: string,
  postId: string,
  type: 'deleted' | 'expired',
  actorPersonId: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  let files: { stored_path: string; thumb_path: string | null }[];
  try {
    await client.query('BEGIN');
    // Locked first, so two removals of one post cannot both write a log line.
    const found = await client.query<{
      author_person_id: string;
      hidden_at: string | null;
      unit_id: string;
      unit_name: string;
      author_name: string | null;
      activity_date: string;
      created_at: string;
    }>(
      `SELECT p.author_person_id, p.hidden_at, p.unit_id, u.name AS unit_name,
              a.full_name AS author_name, to_char(p.activity_date, 'YYYY-MM-DD') AS activity_date,
              p.created_at
         FROM activity_post p
         JOIN activity_unit u ON u.unit_id = p.unit_id
         JOIN person a ON a.person_id = p.author_person_id
        WHERE p.post_id = $1
        FOR UPDATE OF p`,
      [postId],
    );
    const post = found.rows[0];
    if (post === undefined) {
      await client.query('ROLLBACK');
      return false;
    }
    const media = await client.query<{
      stored_path: string;
      thumb_path: string | null;
      backup_key: string | null;
      thumb_backup_key: string | null;
    }>(
      `DELETE FROM activity_media WHERE post_id = $1
       RETURNING stored_path, thumb_path, backup_key, thumb_backup_key`,
      [postId],
    );
    files = media.rows;
    const keys = media.rows
      .flatMap((m) => [m.backup_key, m.thumb_backup_key])
      .filter((k): k is string => k !== null);
    if (keys.length > 0) {
      await client.query(
        `INSERT INTO activity_backup_removal (object_key)
         SELECT unnest($1::text[]) ON CONFLICT (object_key) DO NOTHING`,
        [keys],
      );
    }
    await client.query('DELETE FROM activity_post WHERE post_id = $1', [postId]);
    await client.query(
      `INSERT INTO activity_log (type, actor_person_id, post_id, unit_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        type,
        actorPersonId,
        postId,
        post.unit_id,
        JSON.stringify({
          department: post.unit_name,
          author: post.author_name,
          authorPersonId: post.author_person_id,
          activityDate: post.activity_date,
          photos: media.rowCount,
          fromRecycleBin: post.hidden_at !== null,
          ...(type === 'expired' ? { postedAt: post.created_at } : {}),
        }),
      ],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  await removeFiles(
    root,
    files.flatMap((f) => [f.stored_path, f.thumb_path]),
  );
  await rm(inside(root, postId), { recursive: true, force: true }).catch(() => {});
  return true;
}

/** Soft delete (`hide`) or `restore` — moderators only, both logged. */
export async function moderatePost(
  pool: Pool,
  identity: Identity,
  postId: string,
  action: 'hide' | 'restore',
): Promise<ActivitiesResult<{ readonly postId: string }>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to hide or restore posts');
  }
  const res =
    action === 'hide'
      ? await pool.query<{ unit_id: string }>(
          `UPDATE activity_post SET hidden_at = now(), hidden_by_person_id = $2
            WHERE post_id = $1 AND hidden_at IS NULL RETURNING unit_id`,
          [postId, identity.personId],
        )
      : await pool.query<{ unit_id: string }>(
          `UPDATE activity_post SET hidden_at = NULL, hidden_by_person_id = NULL
            WHERE post_id = $1 AND hidden_at IS NOT NULL RETURNING unit_id`,
          [postId],
        );
  if (res.rows[0] === undefined) {
    const exists = await pool.query('SELECT 1 FROM activity_post WHERE post_id = $1', [postId]);
    return exists.rowCount === 0
      ? refuse(404, 'no such post')
      : refuse(409, action === 'hide' ? 'already in the Recycle bin' : 'not in the Recycle bin');
  }
  await writeLog(pool, {
    type: action === 'hide' ? 'hidden' : 'restored',
    actor: identity.personId,
    postId,
    unitId: res.rows[0].unit_id,
  });
  return { ok: true, value: { postId } };
}

//------------------------------------------------------------------------------
// Serving a photo
//------------------------------------------------------------------------------

/**
 * Hand a photo back, **inline**, for the page to show.
 *
 * Safe to render because only JPEG, PNG and WebP are ever stored (checked by their bytes), the
 * type sent is the sniffed one, `nosniff` stops the browser guessing, and the CSP sandbox means
 * that even opened on its own the response can run nothing. `no-cache` with an ETag: the
 * permission is asked on every view, and an unchanged photo costs a 304, not a download.
 *
 * Answers the request itself on success; returns a refusal otherwise.
 */
export async function servePhoto(
  pool: Pool,
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  mediaId: string,
  thumb: boolean,
): Promise<ActivitiesResult<null> | null> {
  const c = await caller(pool, identity);
  const found = await pool.query<{
    author_person_id: string;
    hidden_at: string | null;
    content_type: string;
    sha256: string;
    stored_path: string;
    thumb_path: string | null;
  }>(
    `SELECT p.author_person_id, p.hidden_at, m.content_type, m.sha256, m.stored_path, m.thumb_path
       FROM activity_media m JOIN activity_post p ON p.post_id = m.post_id
      WHERE m.media_id = $1`,
    [mediaId],
  );
  const row = found.rows[0];
  if (row === undefined || !maySee(c, row.author_person_id, row.hidden_at)) {
    return refuse(404, 'no such photo');
  }

  const useThumb = thumb && row.thumb_path !== null;
  const etag = `"${row.sha256.slice(0, 32)}${useThumb ? '-t' : ''}"`;
  const headers = {
    'content-type': useThumb ? 'image/jpeg' : row.content_type,
    'cache-control': 'private, no-cache',
    etag,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(inside(root, useThumb ? row.thumb_path! : row.stored_path));
  } catch {
    return refuse(410, 'the photo is recorded but missing from disk');
  }
  res.writeHead(200, { ...headers, 'content-length': bytes.length });
  res.end(bytes);
  return null;
}

//------------------------------------------------------------------------------
// The log
//------------------------------------------------------------------------------

export interface LogLine {
  readonly type: string;
  readonly actorName: string | null;
  readonly postId: string | null;
  readonly unitName: string | null;
  readonly detail: unknown;
  readonly recordedAt: string;
}

/** The latest two hundred lines of the Activities log — moderators only. */
export async function readLog(
  pool: Pool,
  identity: Identity,
): Promise<ActivitiesResult<readonly LogLine[]>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to read the Activities log');
  }
  const { rows } = await pool.query<{
    type: string;
    actor_name: string | null;
    post_id: string | null;
    unit_name: string | null;
    detail: unknown;
    recorded_at: string;
  }>(
    `SELECT l.type, a.full_name AS actor_name, l.post_id, u.name AS unit_name, l.detail,
            l.recorded_at
       FROM activity_log l
       LEFT JOIN person a        ON a.person_id = l.actor_person_id
       LEFT JOIN activity_unit u ON u.unit_id = l.unit_id
      ORDER BY l.seq DESC
      LIMIT 200`,
  );
  return {
    ok: true,
    value: rows.map((r) => ({
      type: r.type,
      actorName: r.actor_name,
      postId: r.post_id,
      unitName: r.unit_name,
      detail: r.detail,
      recordedAt: r.recorded_at,
    })),
  };
}

//------------------------------------------------------------------------------
// Thirty days: the warning and the ZIP (ADR-0039 §7)
//------------------------------------------------------------------------------

/** What the media backup has not done yet — read by the DC's warning and by `doctor`. */
export interface BackupBacklog {
  /** Photos uploaded more than a day ago and still not in the media bucket. */
  readonly notCopied: number;
  /** Bucket objects whose delete has been waiting more than a day. */
  readonly removalsWaiting: number;
  /** The bucket's last refusal of a delete, if one is waiting. */
  readonly lastError: string | null;
}

export async function backupBacklog(pool: Pool): Promise<BackupBacklog> {
  const { rows } = await pool.query<{
    not_copied: number;
    removals: number;
    last_error: string | null;
  }>(
    `SELECT (SELECT count(*) FROM activity_media
              WHERE backed_up_at IS NULL AND created_at < now() - interval '1 day')::int AS not_copied,
            (SELECT count(*) FROM activity_backup_removal
              WHERE queued_at < now() - interval '1 day')::int AS removals,
            (SELECT last_error FROM activity_backup_removal
              WHERE last_error IS NOT NULL ORDER BY queued_at DESC LIMIT 1) AS last_error`,
  );
  const r = rows[0]!;
  return { notCopied: r.not_copied, removalsWaiting: r.removals, lastError: r.last_error };
}

export interface ExpiringView {
  readonly retentionDays: number;
  readonly warningDays: number;
  /** Posts the 30-day rule deletes within the warning window — Recycle bin included. */
  readonly posts: number;
  readonly photos: number;
  readonly bytes: number;
  readonly firstExpiresAt: string | null;
  /** False when the ZIP would be too large to make; the page then says so instead of offering it. */
  readonly zipFits: boolean;
  readonly backup: {
    readonly configured: boolean;
    readonly why: string | null;
  } & BackupBacklog;
}

/** `created_at` on or before this is inside the warning window. */
const IN_WARNING = `p.created_at <= now() - make_interval(days => ${RETENTION_DAYS - WARNING_DAYS})`;

/**
 * The DC's warning: what the 30-day rule is about to delete, and whether the media backup is
 * keeping up. Moderators only — they are the ones who can keep a copy (the ZIP) and the ones
 * whose job is to know the backup is not running.
 */
export async function expiring(
  pool: Pool,
  identity: Identity,
  backup: { readonly configured: boolean; readonly why: string | null },
): Promise<ActivitiesResult<ExpiringView>> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to see what is about to be deleted');
  }
  const { rows } = await pool.query<{
    posts: number;
    photos: number;
    bytes: string;
    first_expires_at: string | null;
  }>(
    `SELECT count(DISTINCT p.post_id)::int AS posts,
            count(m.media_id)::int AS photos,
            coalesce(sum(m.byte_size), 0)::text AS bytes,
            min(p.created_at) + make_interval(days => ${RETENTION_DAYS}) AS first_expires_at
       FROM activity_post p
       LEFT JOIN activity_media m ON m.post_id = p.post_id
      WHERE ${IN_WARNING}`,
  );
  const r = rows[0]!;
  const bytes = Number(r.bytes);
  return {
    ok: true,
    value: {
      retentionDays: RETENTION_DAYS,
      warningDays: WARNING_DAYS,
      posts: r.posts,
      photos: r.photos,
      bytes,
      firstExpiresAt: r.first_expires_at,
      // One more entry for the index; its size is a rounding error against 4 GB.
      zipFits: fits(r.photos + 1, bytes),
      backup: { ...backup, ...(await backupBacklog(pool)) },
    },
  };
}

/** A folder or file name every unzip tool accepts — Windows' rules are the strictest. */
function safeName(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'post'
  );
}

const BOM = String.fromCharCode(0xfeff);

/** A spreadsheet must not read a caption as a formula (same defence as `exportCsv.ts`). */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const t = String(value);
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function writeOut(res: ServerResponse, bytes: Buffer): Promise<void> {
  if (!res.write(bytes)) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  }
}

/**
 * The ZIP: every post the 30-day rule is about to delete, a folder each, with its photos and
 * one `activities.csv` describing them all. The way to keep something past thirty days
 * (ADR-0039 "We give up").
 *
 * Moderators only. Logged as `zip_downloaded` before the first byte is sent, so a copy of the
 * district's pictures never leaves unattributed (INV-06) — even if the download is abandoned.
 *
 * Answers the request itself on success; returns a refusal otherwise.
 */
export async function downloadExpiring(
  pool: Pool,
  root: string,
  res: ServerResponse,
  identity: Identity,
): Promise<ActivitiesResult<null> | null> {
  const c = await caller(pool, identity);
  if (!c.can.has('activities.moderate')) {
    return refuse(403, 'you do not have permission to download these');
  }

  const { rows } = await pool.query<{
    post_id: string;
    unit_name: string;
    author_name: string | null;
    author_designation: string | null;
    activity_date: string;
    caption: string;
    place: string | null;
    created_at: string;
    expires_at: string;
    hidden_at: string | null;
    media: { path: string; type: string; bytes: number }[] | null;
  }>(
    `SELECT p.post_id, u.name AS unit_name, a.full_name AS author_name,
            a.designation AS author_designation,
            to_char(p.activity_date, 'YYYY-MM-DD') AS activity_date,
            p.caption, p.place, p.created_at, p.hidden_at,
            p.created_at + make_interval(days => ${RETENTION_DAYS}) AS expires_at,
            (SELECT json_agg(json_build_object('path', m.stored_path, 'type', m.content_type,
                                               'bytes', m.byte_size)
                             ORDER BY m.created_at, m.media_id)
               FROM activity_media m WHERE m.post_id = p.post_id) AS media
       FROM activity_post p
       JOIN activity_unit u ON u.unit_id = p.unit_id
       JOIN person a        ON a.person_id = p.author_person_id
      WHERE ${IN_WARNING}
      ORDER BY p.activity_date, lower(u.name), p.created_at`,
  );
  if (rows.length === 0) return refuse(404, 'nothing is due to be deleted in the next few days');

  const photos = rows.reduce((n, r) => n + (r.media?.length ?? 0), 0);
  const bytes = rows.reduce((n, r) => n + (r.media ?? []).reduce((b, m) => b + m.bytes, 0), 0);
  if (!fits(photos + 1, bytes)) {
    return refuse(413, 'too much to put in one ZIP — ask for a copy from the server instead');
  }

  await writeLog(pool, {
    type: 'zip_downloaded',
    actor: identity.personId,
    detail: { posts: rows.length, photos, bytes },
  });

  const zip = zipWriter();
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="bajaur-activities-${districtDate()}.zip"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });

  // Past this point the status is sent: a failure can only cut the download short, never turn
  // into an error page. It is cut, so the browser shows a failed download, not a broken file.
  try {
    const index: string[] = [
      [
        'Folder',
        'Department',
        'Posted by',
        'Post',
        'Activity date',
        'What',
        'Place',
        'Posted at',
        'Deleted from the app on',
        'Photos',
        'In Recycle bin',
      ]
        .map(csvCell)
        .join(','),
    ];

    for (const r of rows) {
      if (res.destroyed) return null;
      const folder = safeName(
        `${r.activity_date} ${r.unit_name} - ${r.author_name ?? ''} - ${r.post_id.slice(0, 8)}`,
      );
      let n = 0;
      for (const m of r.media ?? []) {
        let data: Buffer;
        try {
          data = await readFile(inside(root, m.path));
        } catch {
          // Recorded but missing from disk: said in the index rather than failing the whole ZIP.
          log('error', 'an Activities photo is recorded but missing from disk', { path: m.path });
          continue;
        }
        n += 1;
        await writeOut(
          res,
          zip.add({
            name: `${folder}/photo-${String(n).padStart(2, '0')}.${EXT[m.type] ?? 'bin'}`,
            bytes: data,
            modified: new Date(r.created_at),
          }),
        );
      }
      index.push(
        [
          folder,
          r.unit_name,
          r.author_name ?? '',
          r.author_designation,
          r.activity_date,
          r.caption,
          r.place,
          r.created_at,
          r.expires_at,
          `${n} of ${r.media?.length ?? 0}`,
          r.hidden_at === null ? 'no' : 'yes',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    // With a byte-order mark, so Excel opens Urdu and Pashto text as UTF-8.
    const csv = Buffer.from(`${BOM}${index.join('\r\n')}\r\n`, 'utf8');
    await writeOut(res, zip.add({ name: 'activities.csv', bytes: csv, modified: new Date() }));
    res.end(zip.finish());
  } catch (e) {
    log('error', 'the Activities ZIP failed part-way', { error: String(e) });
    res.destroy();
  }
  return null;
}
