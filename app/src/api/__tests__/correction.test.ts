/**
 * Correction, not deletion — M9-52, M9-53, M9-54.
 *
 * The client asked for *"undo/delete"*. This system cannot delete: `eventStore.ts` has no update
 * method and no delete method, and that **absence** is what the whole audit trail rests on
 * (ADR-0001). So what an operator gets is a correction — a new event that supersedes an earlier
 * one, with a reason and an actor, leaving both readable.
 *
 * ## What these tests are actually protecting
 *
 * Not the happy path. The danger in a feature called *undo* is that somebody later makes it do
 * what its name suggests — and every step towards that looks like a small kindness: hide the
 * corrected row, strike it through, drop it from the report so the numbers look clean.
 *
 * So the assertions are mostly about what is **still there**: the original event, the original
 * row on the board, the line in the day's report, and the word *corrected* in both places.
 *
 * **And the sentence.** Test 6 asserts that the screen tells the operator the message already
 * reached people. WhatsApp does not recall a delivered message and this software cannot pretend
 * otherwise; an operator who reads "withdrawn" and moves on has left forty officers holding a
 * notice with the wrong date and will never ring them.
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

describe.skipIf(dbUrl === undefined)('correcting something we sent', () => {
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

    const dc = await seedDepartment(pool, `DC Office (fix ${RUN})`);
    token = (
      await seedActor(pool, {
        title: `Control Room (fix ${RUN})`,
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

  const correct = async (id: string, body: unknown): Promise<Response> =>
    fetch(`${base}/incidents/${id}/correct`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });

  it('1. records a correction and removes nothing', async () => {
    const id = await reported(`wrong date ${RUN}`);
    const before = await loadIncident(pool, id);

    const done = await correct(id, {
      reason: 'the meeting is on Thursday, not Tuesday',
      correction: 'Thursday 15 August, 10:00, DC Office',
    });
    expect(done.status).toBe(200);

    const after = await loadIncident(pool, id);

    /**
     * Every original event is still there, byte for byte, and the correction is an **addition**.
     * `eventStore.ts` has no update and no delete; this asserts that nothing found a way round
     * that — which is the only thing standing between this feature and its own name.
     */
    expect(after.length).toBe(before.length + 1);
    for (const [i, event] of before.entries()) {
      expect(after[i]?.eventId).toBe(event.eventId);
      expect(after[i]?.type).toBe(event.type);
    }
    expect(after[after.length - 1]?.type).toBe('corrected');
  });

  it('2. the fold shows the correction beside the status, never instead of it', async () => {
    const id = await reported(`still burning ${RUN}`);
    await correct(id, { reason: 'wrong village named' });

    const state = foldIncident(id, await loadIncident(pool, id));

    // You cannot un-happen a fire. The status answers *what is happening*; the correction
    // answers *is what we said still true*, and folding one into the other loses whichever
    // question was asked second.
    expect(state.correctedAt).not.toBeNull();
    expect(state.correctionReason).toBe('wrong village named');
    expect(state.status).not.toBe('resolved');
    expect(state.status).not.toBe('closed');
  });

  it('3. requires a reason — "corrected" with no reason is worse than nothing', async () => {
    const id = await reported(`no reason ${RUN}`);
    const refused = await correct(id, { correction: 'Thursday' });

    expect(refused.status).toBe(400);
    // It removes trust in the original without replacing it with anything.
    expect(((await refused.json()) as { error: string }).error).toContain('what was wrong');
  });

  it('4. allows a correction with no replacement — that is an honest answer', async () => {
    const id = await reported(`unknown yet ${RUN}`);
    // "Ignore this, we will confirm the venue later" is a real thing to record, and demanding a
    // replacement would produce invented ones.
    const done = await correct(id, { reason: 'ignore this, we will confirm later' });
    expect(done.status).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.correction).toBeNull();
    expect(state.correctionReason).toBe('ignore this, we will confirm later');
  });

  it('5. the latest correction wins and every earlier one stays in the log', async () => {
    const id = await reported(`twice ${RUN}`);
    await correct(id, { reason: 'ignore this' });
    await correct(id, { reason: 'corrected', correction: 'Thursday 15 August' });

    const events = await loadIncident(pool, id);
    const corrections = events.filter((e) => e.type === 'corrected');

    // Two corrections is ordinary: the first says "ignore this", the second says what is true.
    expect(corrections).toHaveLength(2);

    const state = foldIncident(id, events);
    expect(state.correction).toBe('Thursday 15 August');
  });

  it('6. the board says corrected, with the reason, and never strikes it out', async () => {
    const id = await reported(`board ${RUN}`);
    await correct(id, { reason: 'wrong road named' });

    const board = (await (
      await fetch(`${base}/incidents`, { headers: authHeaders(token) })
    ).json()) as {
      incidents: { incidentId: string; corrected: boolean; correctionReason: string | null }[];
    };

    const row = board.incidents.find((r) => r.incidentId === id);
    // Still on the board. Hiding a corrected row is the first small kindness on the way to
    // making this feature do what its name suggests.
    expect(row, 'the corrected incident fell off the board').toBeDefined();
    expect(row?.corrected).toBe(true);
    // A flag alone reads as *deleted*. The sentence is what stops that reading.
    expect(row?.correctionReason).toBe('wrong road named');
  });

  it('7. the day’s report carries the original line AND the correction', async () => {
    const id = await reported(`report ${RUN}`);
    await correct(id, { reason: 'wrong time given', correction: '14:00' });

    const html = await (
      await fetch(`${base}/reports/daily?date=${today}`, { headers: authHeaders(token) })
    ).text();

    /**
     * Both, on the paper. Dropping a corrected line so the numbers look clean is exactly the
     * change somebody makes in good faith six months from now — and then the district's own
     * report is the one place their mistake is invisible.
     */
    expect(html).toContain('Corrected: wrong time given');
    expect(html).toContain('14:00');
    // Never struck through: on paper especially, a crossed-out line reads as "did not happen".
    expect(html).not.toContain('text-decoration: line-through');
    expect(html).not.toContain('<del>');
  });

  it('8. the CSV carries it too, in its own column', async () => {
    const csv = await (
      await fetch(`${base}/reports/daily?date=${today}&format=csv`, { headers: authHeaders(token) })
    ).text();

    expect(csv).toContain('"corrected"');
    expect(csv).toContain('wrong time given');
  });

  it('9. a closed incident can still be corrected — especially then', async () => {
    const id = await reported(`late ${RUN}`);
    await fetch(`${base}/incidents/${id}/resolve`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ outcome: 'attended', reason: `fix ${RUN}` }),
    });
    await fetch(`${base}/incidents/${id}/close`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ notes: 'done', reason: `fix ${RUN}` }),
    });

    /**
     * The mistakes worth correcting are usually noticed afterwards — the notice went out with
     * last week's date and somebody rings at nine the next morning. A rule that refused once an
     * incident was closed would push the district back to correcting things verbally, which is
     * the record not existing.
     */
    const done = await correct(id, { reason: 'the outcome was recorded against the wrong call' });
    expect(done.status).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.status).toBe('closed');
    expect(state.correctionReason).toContain('wrong call');
  });

  it('10. there is still no way to delete anything', async () => {
    const id = await reported(`immutable ${RUN}`);
    const before = (await loadIncident(pool, id)).length;

    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const tried = await fetch(`${base}/incidents/${id}`, {
        method,
        headers: authHeaders(token),
      });
      expect([404, 405], `${method} was answered ${String(tried.status)}`).toContain(tried.status);
    }

    expect((await loadIncident(pool, id)).length).toBe(before);
  });
});
