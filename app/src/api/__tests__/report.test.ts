/**
 * The post-incident report — M1-06.
 *
 * The report exists so that a department does not retype what the system already knows. So
 * the tests are mostly about two things:
 *
 *   **Is it actually folded?** Every field is checked against something that was *done*
 *   during the test, never against something the test also typed into the report.
 *
 *   **Does it say what is missing?** A report handed to a review with the holes removed reads
 *   as a clean response, and that is the one thing this document must never do. The
 *   bare-incident test at the bottom is the important one in the file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { saveGroup } from '../../db/groupStore.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import type { PostIncidentReport } from '../../domain/report.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(dbUrl === undefined)('the post-incident report (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  /**
   * ⚠️ **The control room walks this incident, not Rescue — 2026-08-22.**
   *
   * Every write below used to go through the responsible department's own seat, which is what
   * the authority table allowed until the district removed it: *"department ko koi access nahi
   * milne wala hai."* The report itself is unchanged — it is folded from the log, and the log
   * does not care which seat wrote each event, only that it recorded one.
   *
   * `outsiderToken` still measures what it always did: **reading** is scoped by
   * `evaluateRead`, which this change did not touch.
   */
  let rescueDept: string;
  let outsiderToken: string;

  /** Named rather than passed inline, so `afterAll` has something to delete. */
  let evidenceRoot: string;

  beforeAll(async () => {
    evidenceRoot = await mkdtemp(join(tmpdir(), 'dnc-report-'));
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      evidenceRoot,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (report ${RUN})`);
    dcToken = (
      await seedActor(pool, { title: `DC (report ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    // The department still exists and still holds the incident — it simply has no seat that
    // acts, which is the district's decision rather than a change to the report.
    rescueDept = await seedDepartment(pool, `Rescue 1122 (report ${RUN})`);

    const other = await seedDepartment(pool, `Unrelated (report ${RUN})`);
    outsiderToken = (await seedActor(pool, { title: `Outsider ${RUN}`, departmentId: other }))
      .token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    // The directory this suite made, removed. Five suites created one and only one deleted
    // it, so every full run left its dumps and evidence behind in the system temp folder —
    // 287 directories and 840 MB of them by the time somebody's disk filled up. A test that
    // litters is a test that eventually stops the machine it runs on.
    if (evidenceRoot !== undefined) await rm(evidenceRoot, { recursive: true, force: true });
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    };
  }

  async function report(incidentId: string, token: string): Promise<PostIncidentReport> {
    const res = await call('GET', `/incidents/${incidentId}/report`, token);
    expect(res.status).toBe(200);
    return res.body as unknown as PostIncidentReport;
  }

  /** An incident routed to Rescue and nothing else. */
  async function bare(category: string): Promise<string> {
    const created = await call('POST', '/incidents', dcToken, { category });
    const id = created.body['incidentId'] as string;
    await call('POST', `/incidents/${id}/route`, dcToken, {
      departmentIds: [rescueDept],
      reason: 'report test',
    });
    return id;
  }

  /**
   * An incident taken all the way through, the way a real one would be.
   *
   * The unit name is unique per call. Several tests build one of these, and a fixed name
   * meant the second call collided with the first — two live units with the same name in one
   * department is refused, correctly, and the dispatch that followed then had nothing to
   * send. The report was right; the fixture was wrong.
   */
  async function complete(): Promise<{ id: string; unit: string; unitName: string }> {
    const id = await bare(`full-${RUN}`);
    const unitName = `Ambulance ${RUN}-${randomUUID().slice(0, 6)}`;

    await call('POST', `/incidents/${id}/triage`, dcToken, {
      severity: 'critical',
      category: `structure fire ${RUN}`,
    });
    /**
     * ⚠️ **TOLD FIRST — an acknowledgement needs somebody to have been told (ADR-0030).**
     *
     * This acknowledged an incident nobody had been dispatched to, so the guard answered 409 and
     * the acknowledgement never happened — which left the “fully handled” fixture reporting
     * *Nobody responded to this* as a gap and a null Responded milestone, in the one test
     * whose whole job is to have no gaps.
     */
    const told = await seedActor(pool, { title: `Told Officer ${randomUUID().slice(0, 6)}` });
    await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      targets: [{ kind: 'post', id: told.seatId }],
    });
    await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});

    // Flat `/fleet/units` — ADR-0031 (phase 4) dropped the `/fleet/:departmentId` segment.
    const created = await call('POST', `/fleet/units`, dcToken, {
      kind: 'vehicle',
      name: unitName,
    });
    expect(created.status).toBe(201);
    const unit = created.body['resourceId'] as string;

    await call('POST', `/incidents/${id}/dispatch`, dcToken, { resourceIds: [unit] });
    await call('POST', `/incidents/${id}/actions`, dcToken, {
      note: 'first crew on scene, two casualties',
    });
    await call('POST', `/incidents/${id}/release`, dcToken, {
      resourceIds: [unit],
      reason: 'casualties removed',
    });

    await fetch(`${base}/incidents/${id}/evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': `scene-${RUN}.png`,
        authorization: `Bearer ${dcToken}`,
      },
      body: new Uint8Array(PNG),
    });

    await call('POST', `/incidents/${id}/resolve`, dcToken, {
      outcome: 'fire extinguished, two casualties to DHQ',
    });
    await call('POST', `/incidents/${id}/close`, dcToken, { notes: 'handed to Police' });

    return { id, unit, unitName };
  }

  //----------------------------------------------------------------------------

  describe('it is folded, not typed', () => {
    it('names what happened and who assessed it', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);

      expect(r.what.category).toBe(`structure fire ${RUN}`);
      expect(r.what.severity).toBe('critical');
      expect(r.what.severityAssessed).toBe(true);
      // The seat, because authority attaches to the post (ADR-0004).
      // The seat that assessed it, whichever seat that was — the control room since 2026-08-22.
      // What this holds is that the report NAMES an assessor rather than stating a severity
      // nobody signed for (ADR-0009).
      expect(r.what.severitySetBy?.seatTitle).toContain('DC (report');
    });

    /**
     * ⚠️ **Was *"names the department that held it"* — ADR-0030, and it is kept rather than
     * deleted because of what it now refuses.**
     *
     * `who.departments` folds `responsibleDepartmentIds`, which migration 0039 leaves empty on
     * every incident there will ever be. The old assertion cannot be satisfied by any fixture.
     * What is worth guarding is the other direction: the field must stay **empty**, not fill
     * with raw ids. `sources.departments[id] ?? id` is exactly the fallback that put
     * thirty-six characters of hexadecimal on three screens, and a report is the one artefact
     * here that gets printed and filed.
     */
    it('names no department, and does not fall back to an id', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);
      expect(r.who.departments).toEqual([]);
      expect(r.who.departmentsItLeft).toEqual([]);
    });

    it('lists what was sent, and for how long', async () => {
      const { id, unitName } = await complete();
      const r = await report(id, dcToken);

      expect(r.unitsSent).toHaveLength(1);
      expect(r.unitsSent[0]?.name).toBe(unitName);
      // Stood down, so the commitment has an end. A unit still out would read as null rather
      // than as zero minutes.
      expect(r.unitsSent[0]?.releasedAt).not.toBeNull();
      expect(r.unitsSent[0]?.minutesCommitted).not.toBeNull();
    });

    it('carries the action log, in the order things happened', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);

      const actions = r.narrative.filter((e) => e.what === 'Action');
      expect(actions[0]?.detail).toBe('first crew on scene, two casualties');

      const times = r.narrative.map((e) => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('lists the evidence by the name the device gave it', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);
      expect(r.evidence.map((e) => e.filename)).toContain(`scene-${RUN}.png`);
    });

    it('carries the outcome and the closing notes', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);
      expect(r.outcome).toContain('fire extinguished');
      expect(r.closureNotes).toBe('handed to Police');
    });

    it('names a retired unit rather than rendering its id', async () => {
      // A report may describe a night on which an ambulance the district has since retired
      // attended. Rendering it as a uuid is the failure the department registry ended.
      const { id, unit, unitName } = await complete();
      await call('POST', `/fleet/units/${unit}/retire`, dcToken, { reason: 'sold' });

      const r = await report(id, dcToken);
      expect(r.unitsSent[0]?.name).toBe(unitName);
    });
  });

  describe('times are measured from when it happened', () => {
    it('reports every milestone as minutes from the emergency itself', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);

      const acknowledged = r.timings.find((t) => t.label === 'Responded');
      expect(acknowledged?.at).not.toBeNull();
      expect(acknowledged?.minutesFromOccurrence).not.toBeNull();
      expect(acknowledged?.missing).toBeNull();
    });

    /**
     * ADR-0002, in the one document that will be read by somebody deciding whether the
     * district responded well. Measuring from arrival would turn an hour on a handset with no
     * signal into an apparently instant response.
     */
    it('states the gap between happening and arriving as its own fact', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);
      expect(typeof r.connectivity.arrivalGapMinutes).toBe('number');
    });
  });

  //----------------------------------------------------------------------------
  // The important one
  //----------------------------------------------------------------------------

  describe('it says what the record does not contain', () => {
    /**
     * The most valuable section, and the one a hand-written report always omits.
     *
     * This incident was reported and routed and then nothing happened to it. Every one of
     * those absences is a separate finding, because a review handed a document with the holes
     * removed reads a clean response.
     */
    it('names every hole in an incident nobody acted on', async () => {
      const id = await bare(`abandoned-${RUN}`);
      const r = await report(id, dcToken);

      const gaps = r.gaps.map((g) => g.what);
      expect(gaps).toContain('Nobody responded to this');
      expect(gaps).toContain('Nobody assessed the severity');
      expect(gaps).toContain('No unit was assigned in the app');
      expect(gaps).toContain('No actions were logged');
      expect(gaps).toContain('No photographs or files were attached');
      expect(gaps).toContain('No outcome was recorded');
    });

    it('explains each hole rather than only naming it', async () => {
      const id = await bare(`explained-${RUN}`);
      const r = await report(id, dcToken);

      // The units line is `assigned`-only; it must not read as "nothing happened" now that a
      // WhatsApp responder can be sent without an in-app assignment. It points at the list.
      const sent = r.gaps.find((g) => g.what === 'No unit was assigned in the app');
      expect(sent?.why).toContain('Responders may still have been sent');
      for (const gap of r.gaps) expect(gap.why.length).toBeGreaterThan(20);
    });

    it('has nothing to report about an incident that was handled fully', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);

      // Notifications are the one thing this test does not drive, so they may legitimately
      // appear. Everything a human did is present.
      const gaps = r.gaps.map((g) => g.what);
      expect(gaps).not.toContain('Nobody responded to this');
      expect(gaps).not.toContain('No actions were logged');
      expect(gaps).not.toContain('No outcome was recorded');
    });
  });

  //----------------------------------------------------------------------------

  describe('as a document', () => {
    it('renders as plain text somebody can paste into a form', async () => {
      const { id, unitName } = await complete();
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');

      const text = await res.text();
      expect(text).toContain('POST-INCIDENT REPORT');
      expect(text).toContain(`structure fire ${RUN}`);
      expect(text).toContain(unitName);
      expect(text).toContain('first crew on scene');
      expect(text).toContain('fire extinguished');
      // Q-02: the platform produces the account rather than integrating with whatever
      // receives it, and nobody on the other end should need this software installed.
      expect(text).toContain('WHAT THIS RECORD DOES NOT CONTAIN');
    });

    /**
     * **The district's number leads, the uuid follows it** — 2026-08-24.
     *
     * This is the page that leaves the building — pasted into an email, printed, submitted
     * upward — and until now the only identity on it was a uuid, which is unusable in every
     * one of those. Both are asserted: the number because it is what a DC office writes on a
     * file, and the record id because dropping it would make a filed report impossible to tie
     * back to the log it was folded from.
     */
    it("carries the district's own number and the record id", async () => {
      const { id } = await complete();
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      const text = await res.text();

      expect(text).toMatch(/Incident DNC-BAJAUR-[1-9][0-9]*/);
      expect(text).toContain(`Record id ${id}`);
    });

    it('says in the document that it was folded rather than typed', async () => {
      const { id } = await complete();
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      expect(await res.text()).toContain('folded from the event log, not typed');
    });

    it('spells out an absence in the text, not as a blank line', async () => {
      const id = await bare(`blank-${RUN}`);
      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      const text = await res.text();

      expect(text).toContain('Nobody responded.');
      expect(text).toContain('No unit was assigned in the app');
      expect(text).toContain('No outcome was recorded');
    });
  });

  describe('who may take one', () => {
    it('refuses somebody who cannot read the incident, as a 404', async () => {
      const { id } = await complete();
      const res = await call('GET', `/incidents/${id}/report`, outsiderToken);
      // Same as an incident read: confirming it exists is itself a disclosure.
      expect(res.status).toBe(404);
    });

    it('refuses an unauthenticated caller', async () => {
      const { id } = await complete();
      expect((await call('GET', `/incidents/${id}/report`, null)).status).toBe(401);
    });

    it('lets the administration take a report of any incident', async () => {
      const { id } = await complete();
      expect((await call('GET', `/incidents/${id}/report`, dcToken)).status).toBe(200);
    });
  });

  describe('who acknowledged it', () => {
    it('names the officer, not only the post — the person leads (ADR-0035)', async () => {
      const { id } = await complete();
      const r = await report(id, dcToken);

      expect(r.who.acknowledgedBy).not.toBeNull();
      // The post is still carried — authority attaches to it (ADR-0004) — but the name is
      // there now, where before this the report hardcoded it to null.
      expect(r.who.acknowledgedBy?.seatTitle).toContain('DC (report');
      expect(r.who.acknowledgedBy?.personName).toBe('Test Officer');
    });

    /**
     * **Option C — on a wide dispatch "Responded by" is the office that committed, not the
     * first to tap.** The fold's one `acknowledgedBy*` slot is filled by whoever answers first,
     * a refusal included, so a filed report has named the officer who said *Not Related to Me*.
     */
    async function answerFor(id: string, seatId: string, said: string): Promise<void> {
      const detail = (await (
        await fetch(`${base}/incidents/${id}`, { headers: { authorization: `Bearer ${dcToken}` } })
      ).json()) as { state: { notifications: { attemptId: string; seatId: string | null }[] } };
      const attemptId = detail.state.notifications.find((n) => n.seatId === seatId)?.attemptId;
      const res = await call('POST', `/incidents/${id}/acknowledged-by`, dcToken, {
        attemptId,
        outcome: 'confirmed',
        said,
      });
      expect(res.status).toBe(200);
    }

    it('names the office that committed, not the one that refused first', async () => {
      const id = await bare(`wide-taker-${RUN}`);
      const decliner = await seedActor(pool, {
        title: `Busy post ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      const taker = await seedActor(pool, {
        title: `Nearest post ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [
          { kind: 'post', id: decliner.seatId },
          { kind: 'post', id: taker.seatId },
        ],
      });

      await answerFor(id, decliner.seatId, 'Unable to Respond');
      await answerFor(id, taker.seatId, 'Proceeding to the Site');

      const r = await report(id, dcToken);
      expect(r.who.acknowledgedBy?.seatTitle).toContain('Nearest post');
      expect(r.timings.find((t) => t.label === 'Responded')?.at).not.toBeNull();
    });

    it('carries a "Who is coming" section for a meeting, and none for an emergency', async () => {
      const created = await call('POST', '/incidents', dcToken, {
        kind: 'meeting',
        details: { subject: `Report attendance meeting ${RUN}` },
      });
      const id = created.body['incidentId'] as string;
      const a = await seedActor(pool, { title: `Meeting post A ${randomUUID().slice(0, 6)}` });
      const b = await seedActor(pool, { title: `Meeting post B ${randomUUID().slice(0, 6)}` });
      const c = await seedActor(pool, { title: `Meeting post C ${randomUUID().slice(0, 6)}` });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [
          { kind: 'post', id: a.seatId },
          { kind: 'post', id: b.seatId },
          { kind: 'post', id: c.seatId },
        ],
      });
      await answerFor(id, a.seatId, 'Attending');
      await answerFor(id, b.seatId, 'Sending someone');
      // c stays silent

      const r = await report(id, dcToken);
      expect(r.attendance).not.toBeNull();
      expect(r.attendance?.told).toBe(3);
      expect(r.attendance?.coming).toBe(2);
      expect(r.attendance?.attending).toBe(1);
      expect(r.attendance?.sendingSomeone).toBe(1);
      expect(r.attendance?.unanswered).toBe(1);

      const text = await (
        await fetch(`${base}/incidents/${id}/report?format=text`, {
          headers: { authorization: `Bearer ${dcToken}` },
        })
      ).text();
      expect(text).toContain('WHO IS COMING');
      expect(text).toMatch(/2 of 3 coming/);

      // An emergency taken through the same shape carries no attendance section.
      const emergency = await bare(`no-attendance-${RUN}`);
      expect((await report(emergency, dcToken)).attendance ?? null).toBeNull();
    });

    it('flags "Nobody said whether they were coming" on a meeting nobody answered', async () => {
      const created = await call('POST', '/incidents', dcToken, {
        kind: 'meeting',
        details: { subject: `Silent meeting ${RUN}` },
      });
      const id = created.body['incidentId'] as string;
      const s = await seedActor(pool, { title: `Silent meeting post ${randomUUID().slice(0, 6)}` });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [{ kind: 'post', id: s.seatId }],
      });

      const r = await report(id, dcToken);
      expect(r.gaps.some((g) => g.what === 'Nobody said whether they were coming')).toBe(true);
      // Not the emergency-framed one — a meeting is attended, not "responded to".
      expect(r.gaps.some((g) => g.what === 'Nobody responded to this')).toBe(false);
    });

    it('reads "Nobody responded" when every office on a wide dispatch refused', async () => {
      const id = await bare(`wide-ownerless-${RUN}`);
      const a = await seedActor(pool, {
        title: `On-leave post ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      const b = await seedActor(pool, {
        title: `Off-area post ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [
          { kind: 'post', id: a.seatId },
          { kind: 'post', id: b.seatId },
        ],
      });

      await answerFor(id, a.seatId, 'Unable to Respond');
      await answerFor(id, b.seatId, 'Not Related to Me');

      const r = await report(id, dcToken);
      expect(r.who.acknowledgedBy).toBeNull();
      expect(r.timings.find((t) => t.label === 'Responded')?.at).toBeNull();
      expect(r.gaps.some((g) => g.what === 'Nobody responded to this')).toBe(true);
    });
  });

  describe('who was told, and what they said', () => {
    it('joins each recipient to whether it landed and what they replied', async () => {
      const id = await bare(`recipients-${RUN}`);
      const replied = await seedActor(pool, {
        title: `Rescue duty ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      const silent = await seedActor(pool, {
        title: `Irrigation XEN ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [
          { kind: 'post', id: replied.seatId },
          { kind: 'post', id: silent.seatId },
        ],
      });
      await call('POST', `/incidents/${id}/actions`, replied.token, {
        note: 'Fire Team Dispatched',
      });

      const r = await report(id, dcToken);

      const a = r.recipients.find((x) => x.name.includes('Rescue duty'));
      const b = r.recipients.find((x) => x.name.includes('Irrigation XEN'));

      // The join the district asked for: the reply lands against the recipient who made it.
      expect(a?.response).toBe('Fire Team Dispatched');
      expect(b?.response).toBeNull();

      // Delivery comes from the send ledger. There is no WhatsApp channel in this suite, so
      // each attempt settles as `failed` with a reason — never a blank, never "not sent".
      for (const row of [a, b]) {
        expect(['delivered', 'failed', 'pending', 'unknown']).toContain(row?.delivery);
        if (row?.delivery === 'failed') expect(row.failure).toBeTruthy();
      }
    });

    it('is empty, and the report says so, when nobody was told', async () => {
      const id = await bare(`told-nobody-${RUN}`);
      const r = await report(id, dcToken);
      expect(r.recipients).toEqual([]);

      const res = await fetch(`${base}/incidents/${id}/report?format=text`, {
        headers: { authorization: `Bearer ${dcToken}` },
      });
      expect(await res.text()).toContain('WHO WAS TOLD');
    });

    /**
     * **The group a dispatch expanded, on the filed report — Case 3, 2026-09-10.**
     *
     * `expand()` dissolves a ticked group into loose recipients at send, so `recipients()` is
     * per-person as ever; it now also names the group each row came from, read off
     * `dispatched.payload.fromGroups`. Display only — every recipient is still its own row and
     * a hand-picked one carries `group: null`.
     */
    it('names the group each recipient came from, on the JSON and the printed text', async () => {
      const groupName = `All Tehsildars ${randomUUID().slice(0, 6)}`;
      const a = await seedActor(pool, {
        title: `Tehsildar One ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      const b = await seedActor(pool, {
        title: `Tehsildar Two ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      const saved = await saveGroup(
        pool,
        {
          name: groupName,
          members: [
            { kind: 'post', id: a.seatId },
            { kind: 'post', id: b.seatId },
          ],
        },
        { seatId: null, personId: null },
      );
      if (!saved.ok) throw new Error(`saveGroup: ${saved.problem.kind}`);

      const grouped = await bare(`recipients-grouped-${RUN}`);
      await call('POST', `/incidents/${grouped}/dispatch-to`, dcToken, {
        groups: [saved.group.groupId],
        reason: 'every tehsildar',
      });

      const byHand = await bare(`recipients-byhand-${RUN}`);
      const c = await seedActor(pool, {
        title: `Loner Post ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      await call('POST', `/incidents/${byHand}/dispatch-to`, dcToken, {
        targets: [{ kind: 'post', id: c.seatId }],
      });

      // `bare()` routes to Rescue, and routing notifies the department's own duty seat too — a
      // third recipient on both incidents, correctly carrying `group: null` since it was never
      // a member of anything. So the group members are found by name, not by an exact count.
      const gr = await report(grouped, dcToken);
      const ga = gr.recipients.find((r) => r.name.includes('Tehsildar One'));
      const gb = gr.recipients.find((r) => r.name.includes('Tehsildar Two'));
      expect(ga?.group).toBe(groupName);
      expect(gb?.group).toBe(groupName);

      const hr = await report(byHand, dcToken);
      const hc = hr.recipients.find((r) => r.name.includes('Loner Post'));
      expect(hc?.group).toBeNull();

      const text = await (
        await fetch(`${base}/incidents/${grouped}/report?format=text`, {
          headers: { authorization: `Bearer ${dcToken}` },
        })
      ).text();
      expect(text).toContain(`— ${groupName} —`);

      // A hand-picked dispatch prints no group heading at all.
      const handText = await (
        await fetch(`${base}/incidents/${byHand}/report?format=text`, {
          headers: { authorization: `Bearer ${dcToken}` },
        })
      ).text();
      expect(handText).not.toContain('Individually notified');
    });
  });

  describe('a reply after the incident was resolved', () => {
    it('is tagged so it does not read as a contradiction of the outcome', async () => {
      const id = await bare(`post-resolution-${RUN}`);
      const late = await seedActor(pool, {
        title: `Late responder ${randomUUID().slice(0, 6)}`,
        tier: 'district',
      });
      await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
        targets: [{ kind: 'post', id: late.seatId }],
      });
      await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});
      await call('POST', `/incidents/${id}/resolve`, dcToken, { outcome: 'controlled' });
      await call('POST', `/incidents/${id}/actions`, late.token, { note: 'Being Handled' });

      const r = await report(id, dcToken);
      const afterwards = r.narrative.find((e) => e.detail === 'Being Handled');
      const reported = r.narrative.find((e) => e.what === 'Reported');
      expect(afterwards?.afterResolution).toBe(true);
      expect(reported?.afterResolution).toBe(false);
    });
  });

  describe('an override is shown as both values', () => {
    it('keeps what the department said as well as what replaced it', async () => {
      const id = await bare(`override-${RUN}`);
      await call('POST', `/incidents/${id}/triage`, dcToken, {
        severity: 'moderate',
        category: `rta ${RUN}`,
      });
      await call('POST', `/incidents/${id}/override`, dcToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms multiple casualties',
      });

      const r = await report(id, dcToken);

      expect(r.what.severity).toBe('critical');
      // An override that erased what the department originally said would be the system
      // taking a side (ADR-0003).
      expect(r.what.severityOverriddenFrom).toBe('moderate');
      expect(r.what.overrideReason).toContain('second reporter');
    });
  });
});
