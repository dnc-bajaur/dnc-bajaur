/**
 * Which services the district watches, and what they are called — 2026-09-08.
 *
 * **The district asked for three buttons and the API could serve one and a half of them.** The
 * owner, watching the Status screen: *"subi panels mai … add and remove buttons plus rename
 * button hona chaye hain taake control es ko accordingly adjust kar ske."*
 *
 * Add and Remove have been routed since M4 and **no screen ever drew them**, so which utilities
 * Bajaur watches has been whatever migration 0017 seeded. Two things were genuinely missing
 * underneath, and this file is about those two:
 *
 *   * **`panel` was ignored on creation.** `addUtility` has taken it since migration 0017 and
 *     `/status/utilities` never passed it, so everything the product could create landed on
 *     `utility` — **District services was unreachable by construction**, and a control room
 *     adding "DHQ Hospital" would have watched it appear under Public utilities.
 *   * **There was no rename at all.** The only way to correct a name was retire-and-re-add,
 *     which detaches every report ever filed against the service (see `renameUtility`).
 *
 * ## Why the authority tests are half the file
 *
 * `api/status.ts`'s header: a department that could decide which utilities the district watches
 * **could go quiet without anybody seeing it happen**. A rename is that same lever through the
 * quietest door of all — a service renamed to something nobody scans for is absent from the
 * board without one report having stopped. So rename is administration-only for the same
 * reason retire is, and the refusal is asserted to have written nothing rather than merely to
 * have returned 403.
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

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface Listed {
  name: string;
  panel: string;
  status: string | null;
  note: string | null;
}

describe.skipIf(dbUrl === undefined)('the control room adjusts its own status board', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let officeToken: string;
  let departmentToken: string;

  const post = async (
    token: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };

  /** What `/status` actually offers the screen — not what the column says. */
  const listed = async (token: string): Promise<Listed[]> => {
    const res = await fetch(`${base}/status`, { headers: authHeaders(token) });
    const feed = (await res.json()) as { utilities: Listed[] };
    return feed.utilities;
  };

  /** Add a service and hand back its id — the first half of nearly every test below. */
  const add = async (name: string, panel?: string): Promise<string> => {
    const body: Record<string, unknown> = { name };
    if (panel !== undefined) body['panel'] = panel;

    const created = await post(officeToken, '/status/utilities', body);
    expect(created.status).toBe(201);

    return created.body?.['utilityId'] as string;
  };

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (board ${RUN})`);
    officeToken = (
      await seedActor(pool, {
        title: `Control Room (board ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const pesco = await seedDepartment(pool, `PESCO (board ${RUN})`);
    departmentToken = (
      await seedActor(pool, { title: `PESCO Duty (board ${RUN})`, departmentId: pesco })
    ).token;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await pool.end();
  });

  /**
   * 🔴 **The defect: District services could not be added to.**
   *
   * Not a refusal and not an error — the service was created, and it appeared on the **other**
   * panel. A control room adding "DHQ Hospital" to District services would have found it under
   * Public utilities beside the power and the gas, with nothing on any screen explaining why.
   */
  it('adds a service to the panel the control room asked for', async () => {
    const name = `DHQ Hospital (board ${RUN})`;
    await add(name, 'services');

    expect((await listed(officeToken)).find((u) => u.name === name)?.panel).toBe('services');
  });

  /**
   * The parameter is defaulted, not required.
   *
   * Every caller written before today omits it, and the column's own default is `utility` — so
   * an omitted panel must land exactly where it has always landed rather than be refused.
   */
  it('puts a service with no stated panel on the utilities board, as it always did', async () => {
    const name = `Sui Gas (board ${RUN})`;
    await add(name);

    expect((await listed(officeToken)).find((u) => u.name === name)?.panel).toBe('utility');
  });

  it('refuses a panel that is not one of the two boards', async () => {
    const name = `Nowhere (board ${RUN})`;

    const refused = await post(officeToken, '/status/utilities', { name, panel: 'weather' });
    expect(refused.status).toBe(400);

    expect((await listed(officeToken)).some((u) => u.name === name)).toBe(false);
  });

  /**
   * A rename keeps the service's reports, which is the whole reason it is not a retire-and-add.
   *
   * The assertion that matters is the last one: the report filed under the old name is still the
   * service's current reading afterwards. A district that renamed "Electricity" to "PESCO Bajaur"
   * and lost *"12 hours loadshedding"* in the doing would have been handed a worse tool than the
   * one it had.
   */
  it('renames a service in place, keeping every report filed against it', async () => {
    const before = `Electricty (board ${RUN})`;
    const after = `Electricity (board ${RUN})`;

    const utilityId = await add(before);

    const reported = await post(officeToken, '/status/utility', {
      utilityId,
      status: 'down',
      note: '12 hours loadshedding',
    });
    expect(reported.status).toBe(201);

    const renamed = await post(officeToken, '/status/utilities/rename', { utilityId, name: after });
    expect(renamed.status).toBe(200);

    const rows = await listed(officeToken);
    expect(rows.some((u) => u.name === before)).toBe(false);

    const row = rows.find((u) => u.name === after);
    expect(row?.status).toBe('down');
    expect(row?.note).toBe('12 hours loadshedding');
  });

  /**
   * The old name is in the change log, not only the new one.
   *
   * Six weeks later *"renamed to PESCO Bajaur"* answers nothing, because by then no screen still
   * says what it used to be called. `before` is the entry (ADR-0001).
   */
  it('records what the service used to be called', async () => {
    const before = `Bazaar (board ${RUN})`;
    const after = `Main Bazaar (board ${RUN})`;

    const utilityId = await add(before, 'services');
    await post(officeToken, '/status/utilities/rename', { utilityId, name: after });

    const logged = await pool.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM config_event
        WHERE subject = 'utility' AND subject_id = $1 AND action = 'updated'
        ORDER BY seq DESC LIMIT 1`,
      [utilityId],
    );

    expect(logged.rows[0]?.before).toEqual({ name: before });
    expect(logged.rows[0]?.after).toEqual({ name: after });
  });

  /**
   * ⚠️ **A department may not rename a service, for the reason it may not remove one.**
   *
   * And the 403 is asserted to have written nothing. A refusal that still renames is worse than
   * no check at all — it reports the rule while breaking it.
   */
  it('refuses a department a rename, and writes nothing when it does', async () => {
    const name = `Water Supply (board ${RUN})`;
    const utilityId = await add(name);

    const refused = await post(departmentToken, '/status/utilities/rename', {
      utilityId,
      name: `TMA Bajaur (board ${RUN})`,
    });
    expect(refused.status).toBe(403);

    expect((await listed(officeToken)).some((u) => u.name === name)).toBe(true);
  });

  it('refuses a rename to nothing, and a rename of a service that is not there', async () => {
    const utilityId = await add(`Roads (board ${RUN})`, 'services');

    const blank = await post(officeToken, '/status/utilities/rename', { utilityId, name: '   ' });
    expect(blank.status).toBe(400);

    const missing = await post(officeToken, '/status/utilities/rename', {
      utilityId: randomUUID(),
      name: 'X',
    });
    expect(missing.status).toBe(404);
  });

  /**
   * Remove is retire, and a retired service leaves the screen without leaving the record.
   *
   * The route has existed since M4 and nothing has ever called it; this pins what the Status
   * screen's new **Remove** button now does, end to end.
   */
  it('removes a service from the board and keeps it in the record', async () => {
    const name = `Cattle Market (board ${RUN})`;
    const utilityId = await add(name, 'services');

    const removed = await post(officeToken, '/status/utilities/retire', {
      utilityId,
      reason: 'Removed from the status board',
    });
    expect(removed.status).toBe(200);

    expect((await listed(officeToken)).some((u) => u.name === name)).toBe(false);

    const kept = await pool.query<{ retired_at: string | null }>(
      'SELECT retired_at FROM utility WHERE utility_id = $1',
      [utilityId],
    );
    expect(kept.rows[0]?.retired_at).not.toBeNull();
  });
});
