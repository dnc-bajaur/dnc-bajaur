/**
 * THE M9 GATE — one journey, end to end, with nothing stubbed but the provider — M9-55, M9-56.
 *
 * The milestone's own claim, made once, in the order a district would make it:
 *
 *   compose a meeting notice → tell a whole department in one click → attach a PDF →
 *   send → the officer acknowledges from their handset → records a response → resolves →
 *   tells us where they are → it is on the dashboard's last 24 hours → it is on the daily
 *   report → the control room corrects it → the correction is on the record and on the paper
 *
 * ## Why one long test and not eleven short ones
 *
 * Every phase already has its own suite, and those are where a defect gets diagnosed. **This
 * one exists to catch what none of them can see: the seams.** A phase that works alone and
 * breaks the phase before it produces exactly the failure this project keeps finding — the
 * action succeeds, nothing errors, and the district finds out weeks later.
 *
 * It is deliberately written as a single `it`. A shared journey split across eight `it` blocks
 * pretends the steps are independent; they are not, and a run that stops at step four should say
 * so by stopping, not by reporting four failures that are all one failure.
 *
 * ## What is real here
 *
 * The database, the HTTP server, the fold, the authority table, the tokens, the print document,
 * the CSV. Only Meta is stubbed, and only because they have no test account for a district that
 * has not finished verification (M9-58).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../testing/seed.js';
import { loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { mintAckToken } from '../db/whatsappStore.js';
import { districtDate } from '../domain/districtTime.js';
import { VISIBLE_ACTIVITY } from '../domain/activity.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/** A real PDF, byte for byte at the header — `fileType.ts` sniffs the magic number, not the name. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('meeting agenda\n%%EOF\n')]);

describe.skipIf(dbUrl === undefined)('THE M9 GATE', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let control: string;
  let dutySeat: string;
  let dutyPerson: string;
  let rescue: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (m9 ${RUN})`);
    control = (
      await seedActor(pool, {
        title: `Control Room (m9 ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    rescue = await seedDepartment(pool, `Rescue (m9 ${RUN})`);
    const duty = await seedActor(pool, { title: `Duty Officer (m9 ${RUN})`, departmentId: rescue });
    dutySeat = duty.seatId;
    dutyPerson = duty.personId;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  it('carries one meeting notice through every phase of M9', async () => {
    const post = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: authHeaders(control),
        body: JSON.stringify(body),
      });

    //------------------------------------------------------------------ Phase 2
    // A General communication, with the boxes its kind asks for. A category no
    // routing signal can match, so this gate depends on nothing it did not set up.
    const created = (await (
      await post('/incidents', {
        category: `m9-${RUN}`,
        severity: 'moderate',
        kind: 'meeting',
        description: `Monthly coordination meeting ${RUN}`,
        details: {
          subject: `Monthly coordination ${RUN}`,
          date: '2026-08-20',
          time: '10:00',
          venue: 'DC Office, Bajaur',
        },
      })
    ).json()) as { incidentId: string };
    const id = created.incidentId;
    expect(id).toBeTruthy();

    //------------------------------------------------------------------ Phase 3
    // The attachment rides the report, and the type is decided by the BYTES.
    const attached = await fetch(`${base}/incidents/${id}/evidence`, {
      method: 'POST',
      headers: {
        ...authHeaders(control),
        'content-type': 'application/pdf',
        'x-filename': 'agenda.pdf',
      },
      body: PDF,
    });
    expect(attached.status, await attached.text()).toBe(201);

    //------------------------------------------------------------------ Phase 4
    // Tell the officer. The picker's "Tell all" ticks the OFFICERS and never the
    // department row — collapseSelection would fold them back into one duty seat.
    const told = await post(`/incidents/${id}/dispatch-to`, {
      targets: [{ kind: 'post', id: dutySeat }],
    });
    expect(told.status).toBe(200);

    const afterDispatch = foldIncident(id, await loadIncident(pool, id));
    expect(afterDispatch.notifications.length).toBeGreaterThan(0);

    //----------------------------------------------------------------- M9-11
    /**
     * **A meeting is not a mild emergency**, and the board must not draw it as one.
     *
     * Checked HERE, while the notice is still live on the board — that is the only moment the
     * confusion can happen, and by the end of this journey the incident is resolved and off it.
     *
     * This was M9's last open task, and it was open for a reason worth keeping: the board row
     * carried a severity for everything, so a notice read as *"moderate · unacknowledged"* and
     * was indistinguishable at a glance from an emergency nobody had answered.
     */
    const board = (await (
      await fetch(`${base}/incidents`, { headers: authHeaders(control) })
    ).json()) as { incidents: { incidentId: string; kind: string; general: boolean }[] };

    const row = board.incidents.find((r) => r.incidentId === id);
    expect(row?.kind).toBe('meeting');
    // Resolved on the server, so the one row renderer does not carry a second copy of which
    // kinds are emergencies.
    expect(row?.general).toBe(true);

    //------------------------------------------------------------------ Phase 5
    // The officer taps the one URL button Meta approved. No account, no login.
    const attempt = [...afterDispatch.notifications][0]!;
    const mint = async (stage: 'acknowledge' | 'respond' | 'resolve' | 'availability') =>
      mintAckToken(pool, {
        attemptId: attempt.attemptId,
        incidentId: id,
        seatId: dutySeat,
        personId: dutyPerson,
        stage,
      });

    const ackPage = await fetch(`${base}/ack/${await mint('acknowledge')}`);
    expect(ackPage.status).toBe(200);
    const ackHtml = await ackPage.text();
    expect(ackHtml).toContain('Acknowledged');
    // The page the button opens carries the rest of the lifecycle — that is the whole of M9-27.
    expect(ackHtml).toContain('Mark as responded');
    expect(foldIncident(id, await loadIncident(pool, id)).acknowledgedAt).not.toBeNull();

    const form = async (token: string, fields: Record<string, string>): Promise<Response> =>
      fetch(`${base}/ack/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    expect((await form(await mint('respond'), {})).status).toBe(200);
    expect(foldIncident(id, await loadIncident(pool, id)).status).toBe('responding');

    expect((await form(await mint('resolve'), { said: 'meeting confirmed' })).status).toBe(200);
    const resolved = foldIncident(id, await loadIncident(pool, id));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('meeting confirmed');

    //------------------------------------------------------------------ Phase 6
    // Whether they are available, on a token this system minted — and no phone number anywhere.
    const where = await form(await mint('availability'), { status: 'unavailable' });
    expect(await where.text()).toContain('The district knows where you are');

    const presence = await pool.query<{ status: string; person_id: string | null }>(
      `SELECT status, person_id FROM presence_report WHERE seat_id = $1
        ORDER BY reported_at DESC LIMIT 1`,
      [dutySeat],
    );
    expect(presence.rows[0]?.status).toBe('unavailable');
    // Against the PERSON as well as the post — a post is not on leave, an officer is.
    expect(presence.rows[0]?.person_id).toBe(dutyPerson);

    //------------------------------------------------------------------ Phase 7
    const dashboard = (await (
      await fetch(`${base}/dashboard`, { headers: authHeaders(control) })
    ).json()) as {
      activity: {
        visible: { headline: string }[];
        hidden: number;
        more: string | null;
      };
    };

    expect(dashboard.activity.visible.length).toBeLessThanOrEqual(VISIBLE_ACTIVITY);
    // What is not shown is reported as a number and named as a sentence — never dropped quietly.
    if (dashboard.activity.hidden > 0) expect(dashboard.activity.more).toContain('board');

    //------------------------------------------------------------------ Phase 9
    const today = districtDate(new Date());
    const paper = await (
      await fetch(`${base}/reports/daily?date=${today}`, { headers: authHeaders(control) })
    ).text();

    expect(paper).toContain('Daily report');
    expect(paper).toContain(`m9-${RUN}`);
    // The printed page is the page on screen — no PDF library, per ADR-0007.
    expect(paper).toContain('@media print');

    //------------------------------------------------------------------ Phase 10
    const corrected = await post(`/incidents/${id}/correct`, {
      reason: 'the venue moved',
      correction: 'AC Headquarter Bajaur Office',
    });
    expect(corrected.status).toBe(200);

    const after = foldIncident(id, await loadIncident(pool, id));
    expect(after.correctionReason).toBe('the venue moved');
    // Nothing was removed: the resolution and the acknowledgement are still there.
    expect(after.resolution).toBe('meeting confirmed');
    expect(after.acknowledgedAt).not.toBeNull();
    expect(after.status).toBe('resolved');

    // And it reaches the paper, beside the original rather than instead of it.
    const paperAgain = await (
      await fetch(`${base}/reports/daily?date=${today}`, { headers: authHeaders(control) })
    ).text();
    expect(paperAgain).toContain('Corrected: the venue moved');
    expect(paperAgain).toContain('AC Headquarter Bajaur Office');
    expect(paperAgain).not.toContain('line-through');

    //------------------------------------------------------------- Phase 1 & M9-56
    /**
     * The clock, and the authorization, checked last because they are properties of everything
     * above rather than a step of their own.
     */
    const csv = await (
      await fetch(`${base}/reports/daily?date=${today}&format=csv`, {
        headers: authHeaders(control),
      })
    ).arrayBuffer();
    const bytes = new Uint8Array(csv);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    // Nobody signed in sees nothing at all — every one of these is behind a session.
    for (const path of [
      '/reports/daily',
      '/dashboard',
      '/incidents',
      `/incidents/${id}`,
      '/contacts/recipients',
    ]) {
      expect((await fetch(`${base}${path}`)).status, `${path} answered without a session`).toBe(
        401,
      );
    }

    // A spent lifecycle token is spent, however many times it is tapped (M9-28).
    const spent = await mint('respond');
    await form(spent, {});
    expect(await (await form(spent, {})).text()).toContain('Already recorded');
  }, 120_000);
});
