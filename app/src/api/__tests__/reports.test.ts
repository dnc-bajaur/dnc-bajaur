/**
 * The district's own reports — M7-26…M7-30, over HTTP, against real PostgreSQL.
 *
 * The owner asked for two things a paper register cannot give them: *how many acknowledgments,
 * how many resolutions*, **date-wise**, with a download. What is worth testing is not the
 * arithmetic — it is the three properties that make the numbers usable in a meeting:
 *
 *   * **the three acknowledgement routes are never added together** (M7-30). A tapped link, a
 *     reply, and an operator's recollection of a telephone call are evidence of very different
 *     strength, and a provider's `delivered` is evidence of nothing a human did.
 *   * **the range is dates, not a rolling window** (M7-27). "July" is a question a district
 *     asks; "the last 30 days" is a question that gives a different answer next Tuesday.
 *   * **a short file says it is short.** A truncated report that does not admit it is the one
 *     failure the whole export was written to avoid, because nobody counts rows before
 *     submitting a document upward.
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
import { parseRange } from '../reports.js';
import { districtDate, DISTRICT_TIMEZONE } from '../../domain/districtTime.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe('the report date range', () => {
  it('reads whole days, in the district’s own reckoning', () => {
    const parsed = parseRange('2026-07-01', '2026-07-31', new Date('2026-08-06T09:00:00'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    /**
     * The first instant of the first, to the last instant of the thirty-first. A district asking
     * for July means July, not 30.4 rolling days ending whenever they pressed the link.
     *
     * ⚠️ **Asked in the DISTRICT's clock, not the machine's.** This read `getHours()`, which is
     * whatever zone the machine is set to — so it passed on a laptop in Asia/Karachi and returned
     * **19** on CI's UTC runner the first time anything but that laptop ever ran it. The product
     * was never wrong: `parseRange` uses the district clock, and the test was the only thing here
     * reading a machine.
     */
    const hourInDistrict = (at: string): number =>
      Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: DISTRICT_TIMEZONE,
          hour: '2-digit',
          hour12: false,
        }).format(new Date(at)),
      );

    expect(hourInDistrict(parsed.range.from)).toBe(0);
    expect(hourInDistrict(parsed.range.to)).toBe(23);
    expect(districtDate(parsed.range.from) <= '2026-07-01').toBe(true);
  });

  it('refuses a backwards range rather than quietly swapping it', () => {
    // A swapped range would hand back a file that looks right and answers a question nobody
    // asked — which is worse than an error, because the error is noticed.
    const parsed = parseRange('2026-07-31', '2026-07-01');
    expect(parsed.ok).toBe(false);
  });

  it('falls back to the last 30 days when nobody named a period', () => {
    const parsed = parseRange(null, null, new Date('2026-08-06T09:00:00'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.range.days).toBeGreaterThanOrEqual(30);
  });
});

describe.skipIf(dbUrl === undefined)('the reports (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let rescueSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (rep ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (rep ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    const rescueDept = await seedDepartment(pool, `Rescue (rep ${RUN})`);
    rescueSeat = (
      await seedActor(pool, { title: `Duty Officer (rep ${RUN})`, departmentId: rescueDept })
    ).seatId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /**
   * **The district's today — and this line has now been wrong twice, in opposite directions.**
   *
   * It began as `new Date().toISOString().slice(0, 10)`, which passed all evening and failed at
   * 00:20 Bajaur time: `toISOString()` is UTC, so for five hours every night it still says
   * **yesterday**. An incident created now fell outside a range asked for as "today", and the
   * report came back empty.
   *
   * The fix was `getFullYear`/`getMonth`/`getDate` — **the machine's local date** — and it was
   * right only for as long as the machine happened to be set to Asia/Karachi. **CI is UTC, and
   * this went red on the very first run that ever reached this branch**, three tests at once, for
   * the same reason as before with the sign flipped: at 20:09 UTC the district is already on the
   * next day, so the report was asked for yesterday and came back empty.
   *
   * `districtDate()` is the answer and has been since M9-01. It reads **nothing** from the
   * machine — the server's zone is a property of a rented box in Helsinki, not a fact about
   * Bajaur — and it is what the code under test uses. A test that asks the question in a different
   * clock from the code is not testing the code.
   *
   * **A date and an instant are different things**, and this project has now paid for that four
   * times: `board.ts`'s two midnights, the report filename, this line in UTC, and this line in
   * whatever the machine felt like.
   */
  const today = districtDate();

  async function download(path: string): Promise<{ status: number; text: string; name: string }> {
    const res = await fetch(`${base}${path}`, { headers: authHeaders(controlToken) });
    return {
      status: res.status,
      text: await res.text(),
      name: res.headers.get('content-disposition') ?? '',
    };
  }

  async function reportTellAndConfirm(): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({
          category: 'fire',
          severity: 'high',
          description: `rep ${RUN}`,
        }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });

    const detail = (await (
      await fetch(`${base}/incidents/${created.incidentId}`, {
        headers: authHeaders(controlToken),
      })
    ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };

    const attempt = detail.state.notifications.find((a) => a.seatId === rescueSeat)!;

    await fetch(`${base}/incidents/${created.incidentId}/acknowledged-by`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({
        attemptId: attempt.attemptId,
        outcome: 'confirmed',
        said: `DO says ambulance dispatched (rep ${RUN})`,
      }),
    });

    return created.incidentId;
  }

  it('names how every answer arrived, and never sums the routes', async () => {
    const id = await reportTellAndConfirm();

    const file = await download(`/export/acknowledgements.csv?from=${today}&to=${today}`);
    expect(file.status).toBe(200);

    // The header that makes the file defensible. It is prose in a spreadsheet on purpose:
    // somebody reads this before the numbers and knows what each column is worth (M7-30).
    expect(file.text).toContain('link = the officer tapped');
    expect(file.text).toContain('operator = the control room rang them');

    // The row, with the route recorded and the words the officer used.
    expect(file.text).toContain(id);
    expect(file.text).toContain('operator');
    expect(file.text).toContain(`DO says ambulance dispatched (rep ${RUN})`);
    // The post, by title — a uuid answers nobody's question about who was told (ADR-0004).
    expect(file.text).toContain(`Duty Officer (rep ${RUN})`);
  });

  it('carries the range into the file and into its name', async () => {
    const file = await download(`/export/acknowledgements.csv?from=${today}&to=${today}`);

    expect(file.text).toContain(`${today} to ${today}`);
    // Three downloads in a morning are three files somebody can tell apart in a folder six
    // weeks later, which "acknowledgements.csv (2).csv" is not.
    expect(file.name).toContain(`acknowledgements-${today}-to-${today}.csv`);
  });

  it('reports what is still open as a word, not as a status somebody has to decode', async () => {
    const id = await reportTellAndConfirm();

    const file = await download(`/export/resolutions.csv?from=${today}&to=${today}`);
    expect(file.status).toBe(200);
    expect(file.text).toContain('still open');

    const row = file.text.split('\r\n').find((line) => line.includes(id));
    expect(row).toBeDefined();
    // The number the district is asked for in a meeting, spelled out. `status: acknowledged`
    // is true and needs a lookup table; `still open: yes` does not.
    expect(row).toContain('"yes"');
    // And the route is on this row too, because an acknowledgement a machine saw and one an
    // operator recalls are still not one number here either.
    expect(row).toContain('"operator"');
  });

  it('refuses a backwards range rather than returning a file', async () => {
    const file = await download('/export/resolutions.csv?from=2026-07-31&to=2026-07-01');
    expect(file.status).toBe(400);
  });

  it('is scoped by seat, like every other way out of this system', async () => {
    /**
     * There is one user today (ADR-0018) and the boundary is still enforced server-side
     * (INV-05). It matters more here than almost anywhere: a report is a file that gets
     * emailed onward, so a leak through it outlives the request that caused it.
     */
    const otherDept = await seedDepartment(pool, `Education (rep ${RUN})`);
    const outsider = await seedActor(pool, { title: `DEO (rep ${RUN})`, departmentId: otherDept });

    const id = await reportTellAndConfirm();
    await fetch(`${base}/incidents/${id}/route`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ departmentIds: [rescueSeat], reason: `rep ${RUN}` }),
    });

    const res = await fetch(`${base}/export/acknowledgements.csv?from=${today}&to=${today}`, {
      headers: authHeaders(outsider.token),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    // The header is there — it is not an error, it is an empty answer, which is the honest one.
    expect(text).toContain('link = the officer tapped');
    expect(text).not.toContain(id);
  });

  it('needs a session, like everything else', async () => {
    const res = await fetch(`${base}/export/resolutions.csv?from=${today}&to=${today}`);
    expect(res.status).toBe(401);
  });
});
