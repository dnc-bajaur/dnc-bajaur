/**
 * Groups — the sets of people the control room tells together (M7-09…M7-13).
 *
 * *"Flood on the river"* is six departments, and an operator who ticks those six forty times a
 * month will one night tick five. Nothing on any screen would show it, because five ticked
 * deliberately and five ticked by accident look identical.
 *
 * ## Two rules this module is built around
 *
 * **Every change writes a `config_event` in the same transaction as the change itself.** Same
 * argument as every other setting here (ADR-0001 applied to configuration): a table holding only
 * the current membership cannot answer *"why was the AC not told about the March flood?"*, and
 * that is precisely the question a group generates six weeks later. In the same transaction
 * because a settings table and a history that can disagree is worse than no history — the one
 * that survived a crash becomes the truth, and nobody knows which.
 *
 * **A group is never a reference an incident holds** (M7-10). This module hands back members;
 * `dispatchTo` expands them and writes them onto the event. Nothing here is ever read while
 * displaying an old incident.
 */

import type { Pool } from './pool.js';
import type { RecipientKind, Uuid } from '../domain/events.js';

export interface GroupMember {
  readonly kind: RecipientKind;
  readonly id: Uuid;
}

export interface RecipientGroup {
  readonly groupId: Uuid;
  readonly name: string;
  /** In the district's own order. See the migration on why that is not alphabetical. */
  readonly members: readonly GroupMember[];
  /**
   * A small square photo, `data:` URI, or null — 2026-09-01, migration 0040.
   *
   * Carried on the picker payload deliberately: Bajaur has a handful of groups and the client
   * resizes to ~128px, so this is a few kilobytes, and a named face beside "Flood Commanders"
   * at 02:00 is worth it. See `domain/picture.ts` for what a value may be.
   */
  readonly picture: string | null;
}

const KINDS: readonly RecipientKind[] = ['post', 'person'];

/** Every group that still exists, with its members, in one round trip. */
export async function listGroups(pool: Pool): Promise<readonly RecipientGroup[]> {
  const res = await pool.query<{
    group_id: string;
    name: string;
    picture: string | null;
    kind: string | null;
    member_id: string | null;
    position: number | null;
  }>(
    `SELECT g.group_id, g.name, g.picture, m.kind, m.member_id, m.position
       FROM recipient_group g
       LEFT JOIN recipient_group_member m ON m.group_id = g.group_id
      WHERE g.retired_at IS NULL
      ORDER BY lower(g.name) ASC, m.position ASC`,
  );

  const byId = new Map<string, { name: string; picture: string | null; members: GroupMember[] }>();
  const order: string[] = [];

  for (const row of res.rows) {
    let group = byId.get(row.group_id);
    if (group === undefined) {
      group = { name: row.name, picture: row.picture, members: [] };
      byId.set(row.group_id, group);
      order.push(row.group_id);
    }
    // A LEFT JOIN, because **an empty group is a real thing and must be shown.** A district
    // that created "Flood" and has not filled it in yet needs to see it sitting empty; dropping
    // it would look like the creation had failed.
    if (row.kind !== null && row.member_id !== null) {
      group.members.push({ kind: row.kind as RecipientKind, id: row.member_id });
    }
  }

  return order.map((id) => ({
    groupId: id,
    name: byId.get(id)!.name,
    picture: byId.get(id)!.picture,
    members: byId.get(id)!.members,
  }));
}

export type GroupProblem =
  | { readonly kind: 'name_taken' }
  | { readonly kind: 'no_such_group' }
  | { readonly kind: 'bad_member'; readonly member: GroupMember };

export type GroupResult =
  | { readonly ok: true; readonly group: RecipientGroup }
  | { readonly ok: false; readonly problem: GroupProblem };

/**
 * Create or replace a group's name and membership, with its history, in one transaction.
 *
 * One function for both because a rename, a reorder and a membership change are the same act
 * from the console: the district edits the group and saves it. Splitting them would mean three
 * `config_event` rows for one edit, and a history screen that reads as three separate decisions
 * somebody made in the same second.
 *
 * **Members are validated against the live directory** and a bad one refuses the whole save.
 * The same argument as `dispatchTo`: a group saved with five of six members, reported as saved,
 * is discovered on the night it is used.
 */
export async function saveGroup(
  pool: Pool,
  input: {
    readonly groupId?: Uuid;
    readonly name: string;
    readonly members: readonly GroupMember[];
    /**
     * `undefined` leaves whatever picture is there; `null` clears it; a `data:` URI sets it.
     * Already validated by `saveGroupForConsole` — this module writes what it is handed.
     */
    readonly picture?: string | null;
  },
  by: { readonly seatId: Uuid | null; readonly personId: Uuid | null; readonly reason?: string },
): Promise<GroupResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bad = await firstUnknownMember(client, input.members);
    if (bad !== null) {
      await client.query('ROLLBACK');
      return { ok: false, problem: { kind: 'bad_member', member: bad } };
    }

    let groupId = input.groupId ?? null;
    let before: RecipientGroup | null = null;

    if (groupId !== null) {
      const existing = await readOne(client, groupId);
      if (existing === null) {
        await client.query('ROLLBACK');
        return { ok: false, problem: { kind: 'no_such_group' } };
      }
      before = existing;
      // A missing `picture` (undefined) is "leave it"; a present one — including null — is a change.
      if (input.picture === undefined) {
        await client.query('UPDATE recipient_group SET name = $2 WHERE group_id = $1', [
          groupId,
          input.name,
        ]);
      } else {
        await client.query(
          'UPDATE recipient_group SET name = $2, picture = $3 WHERE group_id = $1',
          [groupId, input.name, input.picture],
        );
      }
      await client.query('DELETE FROM recipient_group_member WHERE group_id = $1', [groupId]);
    } else {
      const created = await client.query<{ group_id: string }>(
        'INSERT INTO recipient_group (name, picture) VALUES ($1, $2) RETURNING group_id',
        [input.name, input.picture ?? null],
      );
      groupId = created.rows[0]!.group_id;
    }

    const picture = input.picture === undefined ? (before?.picture ?? null) : input.picture;

    for (const [position, member] of input.members.entries()) {
      await client.query(
        `INSERT INTO recipient_group_member (group_id, kind, member_id, position)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (group_id, kind, member_id) DO UPDATE SET position = EXCLUDED.position`,
        [groupId, member.kind, member.id, position],
      );
    }

    /**
     * The whole membership goes into the log, both sides of it.
     *
     * Not a diff. A diff is smaller and is read by nobody: answering *"who was in this group in
     * March?"* from a chain of diffs means replaying every one of them correctly, and the one
     * time it matters is the one time somebody is under pressure.
     */
    await client.query(
      `INSERT INTO config_event (subject, subject_id, action, before, after,
                                 actor_seat_id, actor_person_id, reason)
       VALUES ('recipient_group', $1, $2, $3, $4, $5, $6, $7)`,
      [
        groupId,
        before === null ? 'created' : 'updated',
        before === null ? null : JSON.stringify(before),
        JSON.stringify({ groupId, name: input.name, picture, members: input.members }),
        by.seatId,
        by.personId,
        by.reason ?? null,
      ],
    );

    await client.query('COMMIT');
    return { ok: true, group: { groupId, name: input.name, picture, members: input.members } };
  } catch (err) {
    await client.query('ROLLBACK');
    // A duplicate live name is the one failure a human caused and can fix, so it is named
    // rather than thrown. Everything else is this system's problem and goes up.
    if (isUniqueViolation(err)) return { ok: false, problem: { kind: 'name_taken' } };
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retire a group. Soft, always.
 *
 * A `dispatched` event from March names this group by id (M7-10), and a hard delete would turn
 * *"told the flood group"* into a uuid nobody can resolve. The event carries the members too, so
 * the record survives either way — what is lost is the sentence a human can read, which is the
 * part anybody actually needs six months later.
 */
export async function retireGroup(
  pool: Pool,
  groupId: Uuid,
  by: { readonly seatId: Uuid | null; readonly personId: Uuid | null; readonly reason?: string },
): Promise<{ readonly ok: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await readOne(client, groupId);
    if (before === null) {
      await client.query('ROLLBACK');
      return { ok: false };
    }

    await client.query(
      'UPDATE recipient_group SET retired_at = now() WHERE group_id = $1 AND retired_at IS NULL',
      [groupId],
    );
    await client.query(
      `INSERT INTO config_event (subject, subject_id, action, before, after,
                                 actor_seat_id, actor_person_id, reason)
       VALUES ('recipient_group', $1, 'retired', $2, NULL, $3, $4, $5)`,
      [groupId, JSON.stringify(before), by.seatId, by.personId, by.reason ?? null],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A minimal client shape, so this module works against a pool or a transaction alike. */
interface Queryable {
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

async function readOne(db: Queryable, groupId: Uuid): Promise<RecipientGroup | null> {
  const res = await db.query<{
    name: string;
    picture: string | null;
    kind: string | null;
    member_id: string | null;
  }>(
    `SELECT g.name, g.picture, m.kind, m.member_id
       FROM recipient_group g
       LEFT JOIN recipient_group_member m ON m.group_id = g.group_id
      WHERE g.group_id = $1 AND g.retired_at IS NULL
      ORDER BY m.position ASC`,
    [groupId],
  );
  if (res.rows.length === 0) return null;

  const members: GroupMember[] = [];
  for (const row of res.rows) {
    if (row.kind !== null && row.member_id !== null) {
      members.push({ kind: row.kind as RecipientKind, id: row.member_id });
    }
  }
  return { groupId, name: res.rows[0]!.name, picture: res.rows[0]!.picture, members };
}

/**
 * The first member that does not name anything live, or null.
 *
 * One query per kind rather than one per member: a group is up to a dozen entries and the
 * machine running this is also accepting emergency reports (`listRecipients`, M6).
 */
async function firstUnknownMember(
  db: Queryable,
  members: readonly GroupMember[],
): Promise<GroupMember | null> {
  for (const kind of KINDS) {
    const ids = members.filter((m) => m.kind === kind).map((m) => m.id);
    if (ids.length === 0) continue;

    /**
     * ⚠️ **`'department'` left `RecipientKind` and `KINDS` — ADR-0031, phase 2.** ADR-0030
     * dropped the table and ADR-0023 had already stopped the picker offering one, so nothing
     * on this installation can save a department member. A group saved on some other
     * installation before ADR-0023 may still carry one in `recipient_group_member.kind`
     * (the log is not rewritten) — that row is simply not iterated here, and `listGroups`
     * still names it by its id, so it stays visible and removable rather than throwing.
     */
    const sql =
      kind === 'post'
        ? 'SELECT seat_id AS id FROM seat WHERE seat_id = ANY($1::uuid[]) AND retired_at IS NULL'
        : 'SELECT person_id AS id FROM person WHERE person_id = ANY($1::uuid[]) AND removed_at IS NULL';

    const found = new Set((await db.query<{ id: string }>(sql, [ids])).rows.map((r) => r.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing !== undefined) return { kind, id: missing };
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
