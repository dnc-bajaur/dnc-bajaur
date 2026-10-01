/**
 * Rotation is presentation only — M9-39.
 *
 * `domain/__tests__/activity.test.ts` proves the windowing arithmetic. **This file proves the
 * only thing that actually matters about it:** what falls off the dashboard is still in the
 * record, and still reachable by the screens that exist to reach things.
 *
 * That claim cannot be made against a pure function. It needs a real database, a real fold, and
 * the real board — because the failure being guarded against is not a bug in `slice(0, 20)`. It
 * is somebody, later, deciding that a rotating panel may as well stop loading what it does not
 * show, and turning a window into a memory hole one reasonable-looking optimisation at a time.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startOfDistrictDay } from '../../domain/districtTime.js';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { VISIBLE_ACTIVITY } from '../../domain/activity.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);
/** Five more than fit, so there is always something that rotated off to go looking for. */
const REPORTED = VISIBLE_ACTIVITY + 5;

interface Activity {
  since: string;
  hours: number;
  total: number;
  hidden: number;
  more: string | null;
  visible: { at: string; kind: string; headline: string; detail: string | null }[];
}

describe.skipIf(dbUrl === undefined)('what rotates off the dashboard', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let token: string;
  const created: string[] = [];

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (act ${RUN})`);
    token = (
      await seedActor(pool, {
        title: `Control Room (act ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    // Reported in order, so the oldest of them is the one certain to be pushed out.
    for (let i = 0; i < REPORTED; i += 1) {
      const res = await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          category: 'fire',
          severity: 'high',
          description: `act ${RUN} #${String(i)}`,
        }),
      });
      created.push(((await res.json()) as { incidentId: string }).incidentId);
    }
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  const dashboard = async (): Promise<{ activity: Activity }> =>
    (await (await fetch(`${base}/dashboard`, { headers: authHeaders(token) })).json()) as {
      activity: Activity;
    };

  it('1. shows twenty, and says how many more there are', async () => {
    const { activity } = await dashboard();

    expect(activity.visible).toHaveLength(VISIBLE_ACTIVITY);
    expect(activity.total).toBeGreaterThanOrEqual(REPORTED);
    expect(activity.hidden).toBe(activity.total - VISIBLE_ACTIVITY);

    // The sentence, not just the number. "and 5 more" alone tells somebody they are missing
    // something without telling them how to stop missing it.
    // The window is the district's DAY from 2026-08-19 (ADR-0021), so the sentence names
    // today rather than a rolling twenty-four hours. What it must still do is unchanged:
    // say how many are held back, and where they went.
    expect(activity.more).toContain('more earlier today');
    expect(activity.more).toContain('board');
  });

  it('2. the ones it is not showing are still in the record, whole', async () => {
    const { activity } = await dashboard();
    expect(activity.hidden).toBeGreaterThan(0);

    /**
     * The oldest of the ones just reported. It is certainly not on the panel — twenty newer
     * things exist — and its events must still load exactly as they did before it rotated off.
     */
    const rotated = created[0]!;
    const events = await loadIncident(pool, rotated);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.incidentId).toBe(rotated);
  });

  it('3. and are still reachable on the board, which is where reaching things happens', async () => {
    // `GET /incidents` is the board — scoped by the caller's seat, server-side (INV-05).
    const board = (await (
      await fetch(`${base}/incidents`, { headers: authHeaders(token) })
    ).json()) as { incidents: { incidentId: string }[] };

    const ids = new Set(board.incidents.map((r) => r.incidentId));
    // Every one of them, not merely the visible twenty. The dashboard is a window on the
    // district; the board is the district.
    for (const id of created) {
      expect(ids.has(id), `${id} fell out of the board as well`).toBe(true);
    }
  });

  it('4. carries no ids on the panel itself — ADR-0013 §1', async () => {
    const { activity } = await dashboard();

    /**
     * The dashboard shows aggregates and nothing on it is a thing to open. `PanelRow` has
     * carried no id since M4 for exactly this reason, and an activity row is the same kind of
     * thing: sending a handle is the first step towards a screen a room full of people can
     * click through to a named emergency.
     *
     * Asserted against the JSON rather than the renderer, because a field that is *sent* will
     * eventually be *used* — by a future panel, in good faith.
     */
    for (const item of activity.visible) {
      expect(Object.keys(item).sort()).toEqual(['at', 'detail', 'headline', 'kind']);
    }
  });

  it('5. is recomputed from the events, so a restart cannot lose the rotation', async () => {
    // No rotation state exists anywhere: no cursor, no seen flag, no queue. Two calls a moment
    // apart, with nothing reported between them, return the same window — and would after a
    // restart, because the window is a function of the events and the clock.
    const first = await dashboard();
    const second = await dashboard();

    expect(second.activity.total).toBe(first.activity.total);
    expect(second.activity.visible.map((i) => i.headline)).toEqual(
      first.activity.visible.map((i) => i.headline),
    );
  });

  /**
   * **The window opens at the district's own midnight** — ADR-0021, reversing ADR-0020 §5.
   *
   * This test asserted the opposite until 2026-08-19, and the old reasoning was sound at the
   * time: the panel answers *what has been happening*, which is a different question from *what
   * is today's*, and the rest of the screen was then a rolling seven days anyway. Once every
   * figure above it resets at midnight, a rolling window puts last night's hours on a screen
   * whose counters have already forgotten them.
   *
   * ⚠️ **`hours` is gone from the payload rather than left at 24.** A window that is a day cannot
   * honestly print a number of hours; `since` says where it starts and is what every screen
   * reads. Asserting it here is what caught the field still being expected — on CI, not locally.
   */
  it('6. opens the window at the district’s own midnight, not 24 hours back', async () => {
    const { activity } = await dashboard();

    expect(activity.since).toBe(startOfDistrictDay(new Date()));
    expect((activity as { hours?: number }).hours).toBeUndefined();
  });
});
