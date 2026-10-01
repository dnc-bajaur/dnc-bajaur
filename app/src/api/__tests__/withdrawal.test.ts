/**
 * Taking something off the board — M10-11…M10-19, M10-40.
 *
 * The district asked to be able to remove things from the dashboard, **emergencies included**.
 * That is a reasonable request and a dangerous feature, and the danger is not the code: it is
 * that every step from here towards its obvious name looks like a small kindness. Drop it from
 * the report so the day reads cleanly. Skip the reason, nobody fills those in. Let the counter
 * of what left be zero-suppressed into never existing.
 *
 * So, as with `correction.test.ts`, most of these assertions are about **what is still there** —
 * the events, the search hit, the line on the paper, the count on the board — rather than about
 * the row being gone. The row being gone is one assertion and it is the easy one.
 *
 * ## The distinction this file exists to hold
 *
 * `corrected` (M9-52) answers *is what we said still true*. `withdrawn` answers *should this
 * still be on the screen*. They are different questions about the same incident, both append,
 * and **neither erases** — `eventStore.ts` has no update method and no delete method (ADR-0001).
 *
 * **INV-01 is not in tension with this and the reading is exact:** it is about the record being
 * durable, not about what a board displays. ADR-0020 already relies on the same distinction when
 * it stops pursuing an unacknowledged emergency at midnight.
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
import { districtDate } from '../../domain/districtTime.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface BoardReply {
  summary: { open: number; withdrawn: number };
  incidents: { incidentId: string; withdrawn: boolean; withdrawalReason: string | null }[];
}

describe.skipIf(dbUrl === undefined)('taking something off the board', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let token: string;
  let today: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (wd ${RUN})`);
    token = (
      await seedActor(pool, {
        title: `Control Room (wd ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    today = districtDate(new Date());
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function reported(description: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ category: 'fire', severity: 'high', description }),
      })
    ).json()) as { incidentId: string };
    return created.incidentId;
  }

  const withdraw = async (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/incidents/${id}/withdraw`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

  const restore = async (id: string): Promise<Response> =>
    fetch(`${base}/incidents/${id}/restore`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });

  const board = async (query = ''): Promise<BoardReply> =>
    (await (
      await fetch(`${base}/incidents?date=${today}${query}`, { headers: authHeaders(token) })
    ).json()) as BoardReply;

  it('1. refuses to withdraw without a reason', async () => {
    const id = await reported(`no reason given ${RUN}`);

    const bare = await withdraw(id, {});
    expect(bare.status).toBe(400);

    // Whitespace is not a reason. The obvious way past a required field is a space bar, and
    // "withdrawn: ' '" is a row that tells the next reader nothing at all.
    expect((await withdraw(id, { reason: '   ' })).status).toBe(400);

    // And nothing was recorded by either attempt.
    expect(foldIncident(id, await loadIncident(pool, id)).withdrawnAt).toBeNull();
  });

  it('2. removes nothing — the withdrawal is an addition to the log', async () => {
    const id = await reported(`duplicate of the 11:00 call ${RUN}`);
    const before = await loadIncident(pool, id);

    expect((await withdraw(id, { reason: 'duplicate of the 11:00 report' })).status).toBe(200);

    const after = await loadIncident(pool, id);

    /**
     * The assertion this whole file is built around. Every original event is still there, byte
     * for byte, and the withdrawal is appended — which is the only thing standing between this
     * feature and the name the district used for it.
     */
    expect(after.length).toBe(before.length + 1);
    for (const [i, event] of before.entries()) {
      expect(after[i]?.eventId).toBe(event.eventId);
      expect(after[i]?.type).toBe(event.type);
    }
    expect(after[after.length - 1]?.type).toBe('withdrawn');
  });

  it('3. leaves the status exactly where it was — nobody resolved anything', async () => {
    const id = await reported(`still burning ${RUN}`);
    const wasStatus = foldIncident(id, await loadIncident(pool, id)).status;

    await withdraw(id, { reason: 'reported twice' });
    const state = foldIncident(id, await loadIncident(pool, id));

    // M10-12. A row leaving a screen is not an outcome, and folding the two together would
    // put "resolved" in the record of an emergency nobody attended.
    expect(state.status).toBe(wasStatus);
    expect(state.withdrawnAt).not.toBeNull();
    expect(state.withdrawalReason).toBe('reported twice');
  });

  it('4. drops it from the board, and says how many left', async () => {
    const id = await reported(`goes off the board ${RUN}`);

    const before = await board();
    expect(before.incidents.some((r) => r.incidentId === id)).toBe(true);
    const wasOpen = before.summary.open;
    const wasWithdrawn = before.summary.withdrawn;

    await withdraw(id, { reason: 'test run at 11:00, not a real fire' });

    const after = await board();
    expect(after.incidents.some((r) => r.incidentId === id)).toBe(false);
    expect(after.summary.open).toBe(wasOpen - 1);

    /**
     * **M10-40, and it is what makes the rest safe.** Nothing leaves this screen in silence.
     * An operator who withdraws the wrong row — or withdraws three because the first did not
     * seem to work — has to be able to see it happen, and so does whoever walks in afterwards.
     */
    expect(after.summary.withdrawn).toBe(wasWithdrawn + 1);
  });

  it('5. offers a way back: the board shows them again on request, marked', async () => {
    const id = await reported(`the way back ${RUN}`);
    await withdraw(id, { reason: 'wrong district' });

    // Without `?withdrawn=1` a row an operator took off has no door at all — they would need
    // its id, which is precisely the state "we deleted it" leaves somebody in.
    const shown = await board('&withdrawn=1');
    const row = shown.incidents.find((r) => r.incidentId === id);

    expect(row).toBeDefined();
    expect(row?.withdrawn).toBe(true);
    // Marked, never silently ordinary: a withdrawn row arriving on a screen with no way to say
    // so reads as a live emergency, which is worse than either behaviour on its own.
    expect(row?.withdrawalReason).toBe('wrong district');
  });

  it('6. restore puts it back, and the withdrawal stays in the log', async () => {
    const id = await reported(`restored again ${RUN}`);
    await withdraw(id, { reason: 'thought it was a duplicate' });

    expect((await restore(id)).status).toBe(200);

    const events = await loadIncident(pool, id);
    const state = foldIncident(id, events);

    expect(state.withdrawnAt).toBeNull();
    expect(state.withdrawalReason).toBeNull();
    expect((await board()).incidents.some((r) => r.incidentId === id)).toBe(true);

    /**
     * **A withdraw-then-restore is not a round trip that erases itself.** Both events are still
     * in the log, ten minutes apart, and the timeline renders both — because what the control
     * room believed at 11:05 is a fact about the day even after they changed their mind.
     */
    expect(events.filter((e) => e.type === 'withdrawn')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'restored')).toHaveLength(1);
  });

  it('7. keeps it on the daily report, marked, which is what stops this being a delete', async () => {
    const id = await reported(`on the paper anyway ${RUN}`);
    await withdraw(id, { reason: 'sent to the wrong district' });

    const res = await fetch(`${base}/reports/daily?date=${today}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const paper = await res.text();

    /**
     * The report is the artefact most likely to be read by somebody who was **not** there, and
     * most likely to be believed without question. A row that left the screen and the day's own
     * account of itself would be a delete wearing another name.
     */
    // The screen is the Record from 2026-08-19 (ADR-0021), and the paper the district reads
    // says the same word. Renaming one and leaving the other is the drift this project keeps
    // having to pay for.
    expect(paper).toContain('Taken off the Record');
    expect(paper).toContain('sent to the wrong district');

    // And in the spreadsheet, which is how a district that works from CSV learns this exists.
    const csv = await (
      await fetch(`${base}/reports/daily?date=${today}&format=csv`, { headers: authHeaders(token) })
    ).text();
    expect(csv).toContain('taken off the board');
    expect(csv).toContain('sent to the wrong district');
  });

  it('8. keeps it in search, so "what happened to that report?" has an answer', async () => {
    const id = await reported(`findable afterwards ${RUN}`);
    await withdraw(id, { reason: 'duplicate' });

    const found = (await (
      await fetch(`${base}/search?q=${encodeURIComponent(`findable afterwards ${RUN}`)}`, {
        headers: authHeaders(token),
      })
    ).json()) as BoardReply;

    const row = found.incidents.find((r) => r.incidentId === id);
    expect(row).toBeDefined();
    expect(row?.withdrawn).toBe(true);
    expect(row?.withdrawalReason).toBe('duplicate');
  });
  it('9. drops it from the dashboard too — the wall and the board agree', async () => {
    const dash = async (): Promise<{ district: { openIncidents: number } }> =>
      (await (await fetch(`${base}/dashboard`, { headers: authHeaders(token) })).json()) as {
        district: { openIncidents: number };
      };

    const id = await reported(`off the wall as well ${RUN}`);
    const before = (await dash()).district.openIncidents;

    await withdraw(id, { reason: 'somebody rang twice' });

    /**
     * **M10-14, and it is one line in the code because both halves read the same fold.**
     *
     * A row that leaves the board and stays on the wall is the district's request half-done in
     * the most confusing possible way: the operator removes it, watches it vanish from one
     * screen, and finds it on the other one in the room.
     */
    expect((await dash()).district.openIncidents).toBe(before - 1);
  });
});
