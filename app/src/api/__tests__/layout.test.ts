/**
 * The district composes its own dashboard, against real PostgreSQL — ADR-0015, M6-28…M6-32.
 *
 * `domain/__tests__/panels.test.ts` covers the rules. This covers what those rules are useless
 * without: that a layout survives the round trip, that it is answerable like every other
 * setting, and — the two that matter most — that a **corrupt** one still renders a screen and
 * that a crafted one cannot show a department a panel it may not see.
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
import { buildDashboard } from '../dashboard.js';
import { DEFAULT_LAYOUT } from '../../domain/panels.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface LayoutView {
  available: { id: string; name: string; sizes: string[] }[];
  layout: { id: string; size: string }[];
  isDefault: boolean;
  slots: number;
  overflows: boolean;
  problems: { panelId: string; why: string }[];
}

describe.skipIf(dbUrl === undefined)('the dashboard layout (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let adminToken: string;
  let departmentToken: string;
  let ordinaryDept: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (layout ${RUN})`);
    adminToken = (
      await seedActor(pool, {
        title: `Control Room (layout ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    ordinaryDept = await seedDepartment(pool, `Rescue (layout ${RUN})`);
    departmentToken = (
      await seedActor(pool, { title: `Duty Officer (layout ${RUN})`, departmentId: ordinaryDept })
    ).token;
  }, 90_000);

  afterAll(async () => {
    // Left as the district's own arrangement would be. Reset so a re-run starts from "nobody
    // has chosen", which is the state one of these tests is about.
    await pool?.query('DELETE FROM dashboard_layout');
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function get(
    token: string,
    path = '/settings/dashboard-layout',
  ): Promise<{ status: number; body: LayoutView }> {
    const res = await fetch(`${base}${path}`, { headers: authHeaders(token) });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? ({} as LayoutView) : JSON.parse(raw) };
  }

  async function put(
    token: string,
    panels: { id: string; size: string }[],
  ): Promise<{ status: number; body: LayoutView & { error?: string } }> {
    const res = await fetch(`${base}/settings/dashboard-layout`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ layout: { panels } }),
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? ({} as never) : JSON.parse(raw) };
  }

  it('starts as the built-in arrangement, and says so', async () => {
    await pool.query('DELETE FROM dashboard_layout');
    const { status, body } = await get(adminToken);

    expect(status).toBe(200);
    // "Nobody has chosen" and "somebody chose exactly this" look identical once rendered, and
    // only the first one is an invitation.
    expect(body.isDefault).toBe(true);
    expect(body.layout.map((p) => p.id)).toEqual(DEFAULT_LAYOUT.panels.map((p) => p.id));
    expect(body.overflows).toBe(false);
  });

  it('is administration only, on the read as well as the write', async () => {
    // A department arranging the district's screen is not a thing the district asked for, and
    // the gate is one function rather than a check in the router (INV-05).
    expect((await get(departmentToken)).status).toBe(403);
    expect((await put(departmentToken, [{ id: 'keys', size: 'large' }])).status).toBe(403);
  });

  it('saves an arrangement and serves it back', async () => {
    const { status, body } = await put(adminToken, [
      { id: 'keys', size: 'large' },
      { id: 'alerts', size: 'small' },
    ]);

    expect(status).toBe(200);
    expect(body.isDefault).toBe(false);
    expect(body.layout).toEqual([
      { id: 'keys', size: 'large' },
      { id: 'alerts', size: 'small' },
    ]);
  });

  it('records who changed the screen, like every other setting', async () => {
    await put(adminToken, [{ id: 'keys', size: 'medium' }]);

    const history = await pool.query<{ actor_seat_id: string | null; after: unknown }>(
      `SELECT actor_seat_id, after FROM config_event
        WHERE subject = 'dashboard_layout' ORDER BY seq DESC LIMIT 1`,
    );

    // A settings table alone cannot answer "why was this not on the screen in March?".
    expect(history.rows[0]?.actor_seat_id).not.toBeNull();
    expect(history.rows[0]?.after).toMatchObject({ panels: [{ id: 'keys', size: 'medium' }] });
  });

  it('refuses a panel that does not exist, rather than storing it', async () => {
    // An unknown id stored today is a panel that quietly disappears from somebody's screen
    // tomorrow with nothing saying why — and the person who could fix it is the one saving
    // this form right now.
    const { status, body } = await put(adminToken, [{ id: 'the-numbers-panel', size: 'small' }]);

    expect(status).toBe(400);
    expect(body.error).toContain('the-numbers-panel');
  });

  it('refuses an empty screen', async () => {
    expect((await put(adminToken, [])).status).toBe(400);
  });

  it('accepts an arrangement that overflows, and warns', async () => {
    /**
     * M6-32. The district may be running a larger screen, may be happy to scroll at a desk, or
     * may simply want one more panel today. A tool that refuses on an estimate is a tool that
     * gets worked around.
     */
    const everything = [
      'keys',
      'situation',
      'categories',
      'departments',
      'utilities',
      'services',
      'presence',
      'weather',
      'alerts',
      'facts',
      'resources',
      'performance',
      'condition',
      'reporting',
    ].map((id) => ({ id, size: 'large' }));

    const { status, body } = await put(adminToken, everything);

    expect(status).toBe(200);
    expect(body.overflows).toBe(true);
    expect(body.slots).toBeGreaterThan(9);
  });

  //--------------------------------------------------------------------------
  // What the dashboard does with it
  //--------------------------------------------------------------------------

  it('sends the arrangement with the feed, resolved for the viewer', async () => {
    await put(adminToken, [
      { id: 'keys', size: 'large' },
      { id: 'condition', size: 'small' },
    ]);

    const district = await buildDashboard(pool, {
      scope: 'District',
      departmentId: null,
      isAdministration: true,
      seated: true,
    });

    expect(district.layout.map((p) => p.id)).toEqual(['keys', 'condition']);
  });

  it('never sends a department an administration-only panel, whatever is stored', async () => {
    /**
     * The security half, and the reason `resolveLayout` runs server-side. A department falls
     * back to the district's layout when it has none of its own — so the district's own
     * arrangement, containing "This system", is exactly what a department is resolved against.
     * The editor not offering it is a courtesy; this is the control (INV-05).
     */
    await put(adminToken, [
      { id: 'keys', size: 'large' },
      { id: 'condition', size: 'small' },
    ]);

    const theirs = await buildDashboard(pool, {
      scope: 'Rescue',
      departmentId: ordinaryDept,
      isAdministration: false,
      seated: true,
    });

    expect(theirs.layout.map((p) => p.id)).toEqual(['keys']);
  });

  it('renders the built-in arrangement when the stored one is corrupt', async () => {
    /**
     * The case that decides whether this feature is safe to ship. A layout is edited by
     * configuration, restored from dumps and — one day — poked at in `psql`. **A screen that
     * goes blank because a row was malformed is a district that cannot see its own
     * emergencies**, which is a worse outcome than an arrangement nobody chose.
     */
    await pool.query('DELETE FROM dashboard_layout');
    // ⚠️ No `department_id` — migration 0039 dropped it with the table it pointed at. This
    // INSERT still named it, so the one test that decides whether a corrupt layout can blank
    // the district’s wall was failing on the column instead of exercising the guard.
    await pool.query(
      `INSERT INTO dashboard_layout (layout) VALUES ('{"panels":"all of them"}'::jsonb)`,
    );

    const feed = await buildDashboard(pool, {
      scope: 'District',
      departmentId: null,
      isAdministration: true,
      seated: true,
    });

    expect(feed.layout.length).toBeGreaterThan(0);
    expect(feed.layout.map((p) => p.id)).toEqual(DEFAULT_LAYOUT.panels.map((p) => p.id));
  });

  it('gives a department the district’s arrangement until it sets its own', async () => {
    // The order the district would expect: the two offices set up the screen, and a department
    // that has not touched it gets what the district decided rather than what a source file
    // decided a year ago.
    await pool.query('DELETE FROM dashboard_layout');
    await put(adminToken, [
      { id: 'keys', size: 'large' },
      { id: 'weather', size: 'small' },
    ]);

    const theirs = await buildDashboard(pool, {
      scope: 'Rescue',
      departmentId: ordinaryDept,
      isAdministration: false,
      seated: true,
    });

    expect(theirs.layout.map((p) => p.id)).toEqual(['keys', 'weather']);
  });
});
