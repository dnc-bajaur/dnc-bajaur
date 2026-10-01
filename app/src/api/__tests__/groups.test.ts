/**
 * Groups — M7-09…M7-14, over HTTP, against real PostgreSQL.
 *
 * *"Flood on the river"* is six departments, and an operator ticking those six forty times a
 * month will one night tick five. Nothing on any screen shows that, because five ticked
 * deliberately and five ticked by accident look identical.
 *
 * The two assertions worth reading first are the ones that look like extra work:
 *
 *   * **a group is expanded and copied onto the event, never referenced** — edit the group next
 *     month and last month's incident must still say who was actually told
 *   * **an unreachable member stays in, is marked, and is dispatched to** — a group must never
 *     be a way for a vacant post to disappear, which is `collapseSelection`'s failure mode with
 *     a bigger blast radius, because a group is exactly what somebody ticks without reading the
 *     six names
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface GroupView {
  groupId: string;
  name: string;
  picture: string | null;
  members: {
    kind: string;
    id: string;
    label: string;
    unreachable: string | null;
    missing: boolean;
  }[];
}

describe.skipIf(dbUrl === undefined)('recipient groups (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  let outsiderToken: string;
  let rescueDept: string;
  let policeDept: string;
  let rescueSeat: string;
  let policeSeat: string;
  /** The officer holding `rescueSeat`, and — deliberately — `secondSeat` as well. */
  let rescuePerson: string;
  let secondSeat: string;
  let vacantSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (grp ${RUN})`);
    dcToken = (
      await seedActor(pool, {
        title: `Control Room (grp ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (grp ${RUN})`);
    const rescue = await seedActor(pool, {
      title: `Duty Officer (grp ${RUN})`,
      departmentId: rescueDept,
    });
    rescueSeat = rescue.seatId;
    rescuePerson = rescue.personId;

    policeDept = await seedDepartment(pool, `Police (grp ${RUN})`);
    const outsider = await seedActor(pool, { title: `SHO (grp ${RUN})`, departmentId: policeDept });
    outsiderToken = outsider.token;
    policeSeat = outsider.seatId;

    // ADR-0030 — a second designation held by the SAME officer, which is what an overlap looks
    // like now that a department cannot absorb a post. Bajaur has four such officers (M10-05).
    secondSeat = randomUUID();
    await pool.query('INSERT INTO seat (seat_id, title) VALUES ($1, $2)', [
      secondSeat,
      `Duty Officer Relief (grp ${RUN})`,
    ]);
    await pool.query(
      'INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())',
      [secondSeat, rescuePerson],
    );

    vacantSeat = randomUUID();
    await pool.query('INSERT INTO seat (seat_id, title) VALUES ($1, $2)', [
      vacantSeat,
      `Night Duty (grp ${RUN})`,
    ]);
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function call(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? {} : JSON.parse(raw) };
  }

  /** The groups this run created, so an accumulated local database cannot confuse a count. */
  function mine(body: unknown): GroupView[] {
    return (body as GroupView[]).filter((g) => g.name.includes(RUN));
  }

  async function save(token: string, body: unknown, groupId?: string) {
    return call(
      'POST',
      groupId === undefined ? '/admin/groups' : `/admin/groups/${groupId}`,
      token,
      body,
    );
  }

  //--------------------------------------------------------------------------
  // The editor — M7-09, M7-13
  //--------------------------------------------------------------------------

  it('creates a group, keeps the order the district chose, and records who did it', async () => {
    const created = await save(dcToken, {
      name: `Flood ${RUN}`,
      members: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: policeSeat },
      ],
      reason: 'monsoon season',
    });

    expect(created.status).toBe(200);
    const group = mine(created.body).find((g) => g.name === `Flood ${RUN}`)!;

    // **Ordered, not alphabetical.** A group is read aloud on a telephone, and "Rescue, then
    // Police" is how the control room thinks about it.
    expect(group.members.map((m) => m.id)).toEqual([rescueSeat, policeSeat]);

    // The history, in the same transaction as the change (ADR-0001 applied to configuration).
    const log = await pool.query<{ action: string; reason: string | null }>(
      `SELECT action, reason FROM config_event
        WHERE subject = 'recipient_group' AND subject_id = $1`,
      [group.groupId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.action).toBe('created');
    expect(log.rows[0]?.reason).toBe('monsoon season');
  });

  it('records the whole membership on both sides of an edit, never a diff', async () => {
    /**
     * A diff is smaller and is read by nobody. Answering *"who was in this group in March?"*
     * from a chain of diffs means replaying every one of them correctly, and the one time it
     * matters is the one time somebody is under pressure.
     */
    const created = await save(dcToken, {
      name: `Road ${RUN}`,
      members: [{ kind: 'post', id: rescueSeat }],
    });
    const group = mine(created.body).find((g) => g.name === `Road ${RUN}`)!;

    await save(
      dcToken,
      {
        name: `Road ${RUN}`,
        members: [
          { kind: 'post', id: rescueSeat },
          { kind: 'post', id: vacantSeat },
        ],
      },
      group.groupId,
    );

    const log = await pool.query<{
      action: string;
      was: { members: unknown[] } | null;
      now: { members: unknown[] } | null;
    }>(
      `SELECT action, before AS was, after AS now FROM config_event
        WHERE subject = 'recipient_group' AND subject_id = $1 ORDER BY seq ASC`,
      [group.groupId],
    );

    expect(log.rows.map((r) => r.action)).toEqual(['created', 'updated']);
    expect(log.rows[1]?.was?.members).toHaveLength(1);
    expect(log.rows[1]?.now?.members).toHaveLength(2);
  });

  it('refuses a second live group with the same name', async () => {
    await save(dcToken, { name: `River ${RUN}`, members: [] });
    const again = await save(dcToken, { name: `river ${RUN}`, members: [] });

    // Case-insensitive, because "Flood" and "flood" at 02:00 is one of them being the wrong one.
    expect(again.status).toBe(409);
  });

  it('refuses a member that no longer exists rather than saving a shorter group', async () => {
    const attempt = await save(dcToken, {
      name: `Ghost ${RUN}`,
      members: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: randomUUID() },
      ],
    });

    expect(attempt.status).toBe(400);
    // Nothing partially saved. A group saved with five of six members, reported as saved, is
    // discovered on the night it is used.
    expect(
      mine((await call('GET', '/admin/groups', dcToken)).body).map((g) => g.name),
    ).not.toContain(`Ghost ${RUN}`);
  });

  it('lets only the two offices configure groups', async () => {
    // One user today (ADR-0018) and the boundary is still enforced server-side (INV-05).
    expect((await call('GET', '/admin/groups', outsiderToken)).status).toBe(403);
    expect((await save(outsiderToken, { name: `Sneak ${RUN}`, members: [] })).status).toBe(403);
  });

  it('retires a group without deleting it', async () => {
    const created = await save(dcToken, { name: `Old ${RUN}`, members: [] });
    const group = mine(created.body).find((g) => g.name === `Old ${RUN}`)!;

    const gone = await call('DELETE', `/admin/groups/${group.groupId}`, dcToken, {
      reason: 'season over',
    });
    expect(gone.status).toBe(200);
    expect(mine(gone.body).map((g) => g.name)).not.toContain(`Old ${RUN}`);

    // Still a row, because a `dispatched` event from March names it and a hard delete would
    // turn "told the flood group" into a uuid nobody can resolve.
    const still = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM recipient_group WHERE group_id = $1',
      [group.groupId],
    );
    expect(Number(still.rows[0]!.n)).toBe(1);
  });

  //--------------------------------------------------------------------------
  // Unreachable members — M7-12
  //--------------------------------------------------------------------------

  it('keeps an unreachable member in the group and says why', async () => {
    const created = await save(dcToken, {
      name: `Night ${RUN}`,
      members: [{ kind: 'post', id: vacantSeat }],
    });
    const group = mine(created.body).find((g) => g.name === `Night ${RUN}`)!;

    expect(group.members).toHaveLength(1);
    expect(group.members[0]?.unreachable).toBe('nobody holds this designation');
    expect(group.members[0]?.missing).toBe(false);
  });

  //--------------------------------------------------------------------------
  // Name and post on the member — 2026-09-01
  //--------------------------------------------------------------------------

  it('names a held post as "holder — designation" and a vacant one as the designation alone', async () => {
    const created = await save(dcToken, {
      name: `Named ${RUN}`,
      members: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: vacantSeat },
      ],
    });
    const group = mine(created.body).find((g) => g.name === `Named ${RUN}`)!;

    // The held post reads the way a phone's contact list does: who, then what they hold.
    expect(group.members[0]?.label).toBe(`Test Officer — Duty Officer (grp ${RUN})`);
    // A vacancy has no holder to name, so it falls back to the designation — never a dangling dash.
    expect(group.members[1]?.label).toBe(`Night Duty (grp ${RUN})`);
  });

  //--------------------------------------------------------------------------
  // Dispatch — M7-10, M7-11
  //--------------------------------------------------------------------------

  async function report(): Promise<string> {
    const res = await fetch(`${base}/incidents`, {
      method: 'POST',
      headers: authHeaders(dcToken),
      body: JSON.stringify({ category: 'fire', severity: 'high', description: `grp ${RUN}` }),
    });
    return ((await res.json()) as { incidentId: string }).incidentId;
  }

  it('expands a group onto the incident and copies the members as they stood', async () => {
    const created = await save(dcToken, {
      name: `Dispatch ${RUN}`,
      members: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: policeSeat },
      ],
    });
    const group = mine(created.body).find((g) => g.name === `Dispatch ${RUN}`)!;

    const id = await report();
    const sent = await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      groups: [group.groupId],
    });
    expect(sent.status).toBe(200);

    const dispatched = (await loadIncident(pool, id)).find((e) => e.type === 'dispatched')!;
    const payload = dispatched.payload as unknown as {
      targets: { kind: string; id: string }[];
      fromGroups?: { groupId: string; name: string; members: { id: string }[] }[];
    };

    // Both members are on the event as ordinary targets — nothing downstream knows groups exist.
    expect(payload.targets.map((t) => t.id).sort()).toEqual([rescueSeat, policeSeat].sort());
    // And the provenance: what the operator actually did, with the name spelled out.
    expect(payload.fromGroups?.[0]?.groupId).toBe(group.groupId);
    expect(payload.fromGroups?.[0]?.name).toBe(`Dispatch ${RUN}`);
    expect(payload.fromGroups?.[0]?.members).toHaveLength(2);

    /**
     * **Now change the group, and the incident must not move.**
     *
     * This is the assertion the whole of M7-10 is about. An incident whose recipients are read
     * through a live group is an incident whose own history changes when somebody saves a
     * setting six weeks later — which is exactly what ADR-0001 exists to prevent.
     */
    await save(dcToken, { name: `Dispatch ${RUN}`, members: [] }, group.groupId);

    const again = (await loadIncident(pool, id)).find((e) => e.type === 'dispatched')!;
    const stored = again.payload as unknown as { fromGroups: { members: unknown[] }[] };
    expect(stored.fromGroups[0]!.members).toHaveLength(2);
    expect(foldIncident(id, await loadIncident(pool, id)).dispatchedTo).toHaveLength(2);
  });

  it('sends one message when a group and one of its own members are both ticked', async () => {
    // M7-11. Groups collapse like anything else, because by the time `collapseSelection` runs
    // there is no such thing as a group.
    //
    // ⚠️ **THE OVERLAP UNDER TEST CHANGED WITH ADR-0030, AND IT IS THE ONE BAJAUR ACTUALLY HAS.**
    // This used to hold a DEPARTMENT in the group and tick one of its own posts, so the post was
    // absorbed by the department above it. There is no layer above a post any more. What is left
    // is the collapse the flat directory made ordinary: **two designations held by one officer**,
    // one of them in the group and one ticked by hand. Four of Bajaur's officers are two rows
    // (M10-05), so this is the tick an operator makes without noticing.
    const created = await save(dcToken, {
      name: `Overlap ${RUN}`,
      members: [{ kind: 'post', id: rescueSeat }],
    });
    const group = mine(created.body).find((g) => g.name === `Overlap ${RUN}`)!;

    const id = await report();
    await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      groups: [group.groupId],
      targets: [{ kind: 'post', id: secondSeat }],
    });

    const state = foldIncident(id, await loadIncident(pool, id));
    // One handset, so one recipient — and the absorbed tick is reported rather than dropped,
    // because *"tell the Relief officer"* was really said and has to answer yes six weeks later.
    expect(state.dispatchedTo).toHaveLength(1);
    expect(state.dispatchAbsorbed).toHaveLength(1);
  });

  it('refuses the whole dispatch when a group does not exist', async () => {
    const id = await report();
    const sent = await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      groups: [randomUUID()],
    });

    expect(sent.status).toBe(404);
    // Nothing half-applied. A group is precisely what somebody ticks without reading the six
    // names, so a silently dropped group is a silently dropped six.
    expect(foldIncident(id, await loadIncident(pool, id)).dispatchedTo).toHaveLength(0);
  });

  it('refuses a dispatch that names an empty group and nothing else', async () => {
    const created = await save(dcToken, { name: `Empty ${RUN}`, members: [] });
    const group = mine(created.body).find((g) => g.name === `Empty ${RUN}`)!;

    const id = await report();
    const sent = await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      groups: [group.groupId],
    });

    // 400 and not a silent success. "Told the flood group" when the flood group is empty is the
    // most dangerous possible reading of a screen that says something was sent.
    expect(sent.status).toBe(400);
  });

  //--------------------------------------------------------------------------
  // The group picture — 2026-09-01, migration 0040
  //--------------------------------------------------------------------------

  // A real 1×1 PNG. Small enough to be obviously fine, large enough to be a genuine data URI.
  const PNG_1PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('stores a group picture, hands it back, and clears it when asked', async () => {
    const created = await save(dcToken, {
      name: `Pic ${RUN}`,
      picture: PNG_1PX,
      members: [{ kind: 'post', id: rescueSeat }],
    });
    expect(created.status).toBe(200);
    let group = mine(created.body).find((g) => g.name === `Pic ${RUN}`)!;
    // Canonicalised on the way in — same bytes, no data-URI parameters, one predictable form.
    expect(group.picture).toBe(PNG_1PX);

    // An edit that does not mention `picture` leaves it exactly as it was.
    const renamed = await save(
      dcToken,
      { name: `Pic renamed ${RUN}`, members: [{ kind: 'post', id: rescueSeat }] },
      group.groupId,
    );
    group = (renamed.body as GroupView[]).find((g) => g.groupId === group.groupId)!;
    expect(group.picture).toBe(PNG_1PX);

    // `picture: null` clears it.
    const cleared = await save(
      dcToken,
      { name: `Pic renamed ${RUN}`, picture: null, members: [{ kind: 'post', id: rescueSeat }] },
      group.groupId,
    );
    group = (cleared.body as GroupView[]).find((g) => g.groupId === group.groupId)!;
    expect(group.picture).toBeNull();
  });

  it('refuses a picture that is not a small raster data URI', async () => {
    // Not a data URI at all.
    const link = await save(dcToken, {
      name: `Bad pic A ${RUN}`,
      picture: 'https://example.com/face.png',
      members: [],
    });
    expect(link.status).toBe(400);

    // An SVG — a script vector has no business on a screen a room can read.
    const svg = await save(dcToken, {
      name: `Bad pic B ${RUN}`,
      picture: 'data:image/svg+xml;base64,PHN2Zy8+',
      members: [],
    });
    expect(svg.status).toBe(400);

    // Over the size cap — a photo nobody resized. ~70 KB of base64 decodes to ~52 KB.
    const huge = `data:image/png;base64,${'A'.repeat(72_000)}`;
    const big = await save(dcToken, { name: `Bad pic C ${RUN}`, picture: huge, members: [] });
    expect(big.status).toBe(400);

    // None of the three created a group.
    const list = await call('GET', '/admin/groups', dcToken);
    expect(mine(list.body).some((g) => g.name.startsWith(`Bad pic`))).toBe(false);
  });

  it('carries the group picture onto the intake recipient picker', async () => {
    await save(dcToken, {
      name: `Picker pic ${RUN}`,
      picture: PNG_1PX,
      members: [{ kind: 'post', id: rescueSeat }],
    });

    const picker = await call('GET', '/contacts/recipients', dcToken);
    const groups = (picker.body as { groups: { name: string; picture: string | null }[] }).groups;
    const shown = groups.find((g) => g.name === `Picker pic ${RUN}`)!;
    expect(shown.picture).toBe(PNG_1PX);
  });
});
