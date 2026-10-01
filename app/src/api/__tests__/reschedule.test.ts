/**
 * **Rescheduled is not an ending** — the district's five, 2026-08-22.
 *
 * The district asked for three controls on a meeting: *Conducted*, *Cancelled* and
 * *Rescheduled*. They look like three of a kind and they are two different shapes, and the
 * danger this file guards is the tidy version of that mistake: somebody later folds all three
 * into one "close" control, because they sit next to each other on a screen — and a live meeting
 * comes off the dashboard, which is the exact opposite of what was asked for.
 *
 * So the assertions here are mostly about what has **not** happened: the status did not move,
 * nothing resolved, nothing was withdrawn, and the meeting is still on the panel afterwards.
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
import { outlivesTheDay } from '../../domain/carrying.js';
import { buildReport } from '../../domain/report.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('a meeting that moved', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (move ${RUN})`);
    token = (
      await seedActor(pool, {
        title: `Control Room (move ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function meeting(subject: string): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          category: 'other',
          severity: 'moderate',
          kind: 'meeting',
          description: subject,
          details: { subject, date: '2026-08-24', time: '10:00', venue: 'DC office' },
        }),
      })
    ).json()) as { incidentId: string };
    return created.incidentId;
  }

  const post = async (id: string, action: string, body: unknown): Promise<Response> =>
    fetch(`${base}/incidents/${id}/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

  it('1. moves the date and removes nothing', async () => {
    const id = await meeting(`monthly ${RUN}`);
    const before = await loadIncident(pool, id);

    const done = await post(id, 'reschedule', {
      date: '2026-08-27',
      reason: 'DC is out of the district on Monday',
    });
    expect(done.status).toBe(200);

    const after = await loadIncident(pool, id);

    // An addition, never an edit. `eventStore.ts` has no update and no delete, and the original
    // date is still readable on the `reported` event that carried it.
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]?.type).toBe('rescheduled');

    const state = foldIncident(id, after);
    expect(state.details?.date).toBe('2026-08-27');
    // Not retyped, so not lost.
    expect(state.details?.venue).toBe('DC office');
    expect(state.details?.time).toBe('10:00');
  });

  it('2. 🔴 does NOT end the meeting, and it is still on the panel afterwards', async () => {
    const id = await meeting(`quorum ${RUN}`);
    await post(id, 'reschedule', { date: '2026-09-01', reason: 'no quorum' });

    const state = foldIncident(id, await loadIncident(pool, id));

    /**
     * The whole file, in four lines. *Conducted* and *Cancelled* close a meeting; this one is
     * still going to happen, so nothing about it may read as finished — and it must still be
     * carried, because "rahegi till its done" is what the district actually said.
     */
    expect(state.status).not.toBe('resolved');
    expect(state.status).not.toBe('closed');
    expect(state.resolution).toBeNull();
    expect(state.withdrawnAt).toBeNull();
    expect(outlivesTheDay(state)).toBe(true);
  });

  it('3. refuses a reschedule with no new date, in words', async () => {
    const id = await meeting(`nodate ${RUN}`);

    const refused = await post(id, 'reschedule', { reason: 'postponed' });
    expect(refused.status).toBe(400);

    // A meeting taken off its own date and left nowhere is not a reschedule — and the follow-up
    // that goes to every officer already told would say a meeting moved without saying where to.
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('date');
  });

  it('4. refuses one with no reason, because the officers already told are sent it', async () => {
    const id = await meeting(`noreason ${RUN}`);

    const refused = await post(id, 'reschedule', { date: '2026-09-02' });
    expect(refused.status).toBe(400);
  });

  it('5. refuses to reschedule anything that is not a meeting, and names what it is', async () => {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ category: 'fire', severity: 'high', description: `fire ${RUN}` }),
      })
    ).json()) as { incidentId: string };

    const refused = await post(created.incidentId, 'reschedule', {
      date: '2026-09-03',
      reason: 'no',
    });
    expect(refused.status).toBe(409);

    // `checkPrecondition`'s own rule: never "cannot" without "because".
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('only a meeting');
  });

  it('6. refuses to move a meeting already recorded as finished, and names the way back', async () => {
    const id = await meeting(`finished ${RUN}`);
    const resolved = await post(id, 'resolve', {
      outcome: 'Cancelled',
      reason: 'the DC cancelled it',
    });
    expect(resolved.status).toBe(200);

    const refused = await post(id, 'reschedule', { date: '2026-09-04', reason: 'back on' });
    expect(refused.status).toBe(409);

    /**
     * Moving the date of a meeting somebody recorded as Cancelled would leave the record saying
     * both. `reopened` exists for exactly this, so the operator is sent to it rather than left
     * guessing at a refusal.
     */
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('reopen');
  });

  it('7. the report says Rescheduled, never Corrected and never Resolved', async () => {
    const id = await meeting(`timeline ${RUN}`);
    await post(id, 'reschedule', {
      date: '2026-09-05',
      time: '11:00',
      venue: 'AC office',
      reason: 'venue changed',
    });

    const events = await loadIncident(pool, id);
    const report = buildReport({
      state: foldIncident(id, events),
      events,
      generatedAt: new Date().toISOString(),
      seats: {},
      people: {},
      departments: {},
      resources: {},
      evidence: [],
    });

    const line = report.narrative.find((t) => t.what === 'Rescheduled');
    /**
     * Somebody reading this six weeks later has to be able to tell *we sent the wrong date* from
     * *the date moved* from *the meeting is over*. Three facts, three words, and only one of them
     * belongs on this line — which is why the two it is NOT are asserted as well.
     */
    expect(line, 'the report does not say Rescheduled').toBeDefined();
    expect(line?.detail).toContain('2026-09-05');
    expect(line?.detail).toContain('AC office');
    expect(line?.detail).toContain('venue changed');
    expect(report.narrative.some((t) => t.what === 'Corrected')).toBe(false);
    expect(report.narrative.some((t) => t.what === 'Resolved')).toBe(false);
  });
});
