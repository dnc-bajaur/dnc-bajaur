/**
 * How long a report stays believable, set by the district — M10-03.
 *
 * **This closes the other half of what the district actually reported.** M10-01 stopped the
 * sentence *"8 hours loadshedding"* vanishing from the wall; it did not stop the **reading**
 * going stale after four hours, because Electricity has carried migration 0015's install default
 * of `stale_minutes = 240` since the day it was seeded and **nothing in the product could change
 * it**. An eight-hour schedule measured against a four-hour window is stale by construction,
 * every single day, however diligently anybody reports it.
 *
 * The first test is the one that matters: it reproduces that exact situation and then fixes it
 * the way the district now can — end to end, through the real route, and read back through the
 * real dashboard fold rather than by asking the column what it says.
 *
 * ## Why so much of this file is about who may do it
 *
 * `api/status.ts`'s own header says a department may not decide which utilities the district
 * watches, because one that could remove itself **could go quiet without anybody seeing it
 * happen**. The window is that same lever through a subtler door: a department that widened its
 * own to a week would never appear as *"not reporting"* again. Reporting a condition and
 * deciding how long your silence stays invisible are two different powers, and only the second
 * is configuration.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { buildDashboard } from '../dashboard.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const DISTRICT = {
  scope: 'District',
  departmentId: null,
  isAdministration: true,
  seated: true,
};

describe.skipIf(dbUrl === undefined)('the district sets its own staleness window', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let officeToken: string;
  let departmentToken: string;

  /** A service with a deliberately tight window and one report, already past it. */
  const seedStaleService = async (window: number, note: string): Promise<[string, string]> => {
    const name = `Electricity (win ${RUN} ${randomUUID().slice(0, 6)})`;

    const created = await pool.query<{ utility_id: string }>(
      `INSERT INTO utility (name, panel, position, stale_minutes)
       VALUES ($1, 'utility', 97, $2) RETURNING utility_id`,
      [name, window],
    );

    await pool.query(
      `INSERT INTO utility_report (utility_id, status, note, reported_at)
       VALUES ($1, 'degraded', $2, now() - interval '3 hours')`,
      [created.rows[0]!.utility_id, note],
    );

    return [created.rows[0]!.utility_id, name];
  };

  const setWindow = async (
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}/status/utilities/window`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

    return { status: res.status, body: await res.json().catch(() => null) };
  };

  beforeAll(async () => {
    pool = createPool(dbUrl!);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (win ${RUN})`);
    officeToken = (
      await seedActor(pool, {
        title: `Control Room (win ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const pesco = await seedDepartment(pool, `PESCO (win ${RUN})`);
    departmentToken = (
      await seedActor(pool, { title: `PESCO Duty (win ${RUN})`, departmentId: pesco })
    ).token;
  }, 120_000);

  afterAll(async () => {
    server.close();
    await pool.end();
  });

  /**
   * The district's own report — answered a second time, and properly — ADR-0025, 2026-08-23.
   *
   * M10-03 answered *"it says no report since 08:00 while the load shedding is still going
   * on"* by letting an office **widen** the window, and this test proved a narrow one went
   * stale and a wide one came back. The district read that answer and rejected it: they do not
   * want to pick a number at all. *"koi time cap nhe dena chah rahe hain … control wale
   * control karenge"*.
   *
   * So the window no longer governs a utility on the wall, and what this test now proves is
   * the **absence** of the behaviour it used to prove: three hours old against a sixty-minute
   * window — the narrowest case the old rule had — and the wall still names the status.
   *
   * **Read back through `buildDashboard`, not through the column.** Asserting `stale_minutes`
   * would prove the UPDATE ran; it would not prove what the wall does, and the wall is the
   * thing the district is looking at.
   */
  it('leaves a utility reading fresh however narrow the window is', async () => {
    const note = '8 hours loadshedding, 10am to 6pm';
    const [utilityId, name] = await seedStaleService(60, note);

    const before = (await buildDashboard(pool, DISTRICT)).utilities.find((u) => u.name === name);
    expect(before?.freshness).toBe('fresh');
    expect(before?.status).toBe('degraded');
    expect(before?.note).toBe(note);

    // The endpoint still stores a window — presence uses the column, and the guards below are
    // still worth having — but writing one changes nothing about what the wall says.
    expect((await setWindow(officeToken, { utilityId, staleMinutes: 600 })).status).toBe(200);

    const after = (await buildDashboard(pool, DISTRICT)).utilities.find((u) => u.name === name);
    expect(after?.freshness).toBe('fresh');
    expect(after?.status).toBe('degraded');
    expect(after?.note).toBe(note);
  });

  it('refuses a department its own window — silence must not be self-configurable', async () => {
    const [utilityId] = await seedStaleService(60, 'Feeder tripped at Nawagai');

    const refused = await setWindow(departmentToken, { utilityId, staleMinutes: 10_000 });
    expect(refused.status).toBe(403);

    // And it really did not happen — a 403 that still writes is worse than no check at all.
    const row = await pool.query<{ stale_minutes: number }>(
      'SELECT stale_minutes FROM utility WHERE utility_id = $1',
      [utilityId],
    );
    expect(row.rows[0]!.stale_minutes).toBe(60);
  });

  /**
   * Both ends, and in the words the creation route already used.
   *
   * A second copy of this rule is how the district comes to learn two different answers for one
   * column, so the sentence lives in one constant and both doors read it.
   */
  it('refuses a window outside what a report can believably cover', async () => {
    const [utilityId] = await seedStaleService(60, 'Feeder tripped at Nawagai');

    for (const staleMinutes of [4, 10_081, 'soon', Number.NaN]) {
      const refused = await setWindow(officeToken, { utilityId, staleMinutes });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        error: 'a report stays believable between 5 minutes and a week',
      });
    }
  });

  /**
   * Absent is refused, and it is deliberately not treated as "use the default".
   *
   * Creating a service without naming a window is answered by the install default. **Changing
   * one** without naming it is a caller that has lost track of what it is asking for, and quietly
   * writing 240 over a window the district chose itself is the worse of the two answers.
   */
  it('refuses a change that names no window at all', async () => {
    const [utilityId] = await seedStaleService(720, 'Gas pressure low');

    expect((await setWindow(officeToken, { utilityId })).status).toBe(400);

    const row = await pool.query<{ stale_minutes: number }>(
      'SELECT stale_minutes FROM utility WHERE utility_id = $1',
      [utilityId],
    );
    expect(row.rows[0]!.stale_minutes).toBe(720);
  });

  it('answers 404 for a service that does not exist, and 400 for something that is not an id', async () => {
    expect(
      (await setWindow(officeToken, { utilityId: randomUUID(), staleMinutes: 600 })).status,
    ).toBe(404);

    expect(
      (await setWindow(officeToken, { utilityId: 'not-a-uuid', staleMinutes: 600 })).status,
    ).toBe(400);
  });

  /**
   * It lands in the config log, because it is configuration (ADR-0001 applied to settings).
   *
   * A table holding only today's value cannot answer *"why was this not flagged stale in
   * October?"* six weeks later — and this is precisely the column that question is about.
   */
  it('records the change, who made it and why', async () => {
    const [utilityId] = await seedStaleService(60, 'Transformer failed at Nawagai');

    await setWindow(officeToken, {
      utilityId,
      staleMinutes: 480,
      reason: 'PESCO publishes an eight-hour schedule',
    });

    const logged = await pool.query<{ action: string; after: unknown; reason: string }>(
      `SELECT action, after, reason FROM config_event
        WHERE subject = 'utility' AND subject_id = $1
        ORDER BY recorded_at DESC LIMIT 1`,
      [utilityId],
    );

    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0]!.action).toBe('updated');
    expect(logged.rows[0]!.after).toMatchObject({ staleMinutes: 480 });
    expect(logged.rows[0]!.reason).toBe('PESCO publishes an eight-hour schedule');
  });
});
