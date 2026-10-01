/**
 * Evidence — M1-05, and the timed action log — M1-04.
 *
 * Most of this file is about the two ways an upload endpoint gets a control room
 * compromised: **where the file is written**, and **how it is served back**. Neither is
 * decided by anything the client sends, and these tests try to make them be.
 *
 * The rest is about a claim the system must be able to keep years later: *this is the
 * photograph the crew took.* That is a hash, checked on the way out, reported rather than
 * enforced.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { pathFor, safeLabel, verifyAll } from '../../ops/evidence.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

/** A one-pixel PNG. Small, and genuinely a PNG rather than bytes we called one. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(dbUrl === undefined)('evidence (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let root: string;

  /**
   * ⚠️ **THE LEGITIMATE UPLOADER IS THE CONTROL ROOM SINCE ADR-0030.**
   *
   * It was the Rescue duty officer, whose department held the incident. `evaluateRead` refuses
   * every non-administrative seat every incident now — deliberately: an empty responsible list
   * is the permanent state after migration 0039, and reading an absent value as permissive
   * would have handed the whole district to every account that exists. So the officer at the
   * scene was answered **404 on their own emergency**, and no dispatch could change that.
   *
   * `outsiderToken` below is still a non-administrative seat and is still refused — a
   * **stronger** claim than it used to make: it was refused for being in the wrong department,
   * and is now refused for having no district authority at all.
   */
  let dcToken: string;
  let rescueDept: string;
  let rescueSeat: string;
  let outsiderToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    root = await mkdtemp(join(tmpdir(), 'dnc-evidence-'));

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      evidenceRoot: root,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (evidence ${RUN})`);
    dcToken = (
      await seedActor(pool, {
        title: `DC (evidence ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (evidence ${RUN})`);
    const rescue = await seedActor(pool, {
      title: `Rescue Duty (evidence ${RUN})`,
      departmentId: rescueDept,
    });
    rescueSeat = rescue.seatId;

    const otherDept = await seedDepartment(pool, `Unrelated (evidence ${RUN})`);
    outsiderToken = (
      await seedActor(pool, { title: `Outsider (evidence ${RUN})`, departmentId: otherDept })
    ).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
    // The directory this suite made, removed. Five suites created one and only one deleted
    // it, so every full run left its dumps and evidence behind in the system temp folder —
    // 287 directories and 840 MB of them by the time somebody's disk filled up. A test that
    // litters is a test that eventually stops the machine it runs on.
    await rm(root, { recursive: true, force: true });
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

  async function put(
    incidentId: string,
    token: string,
    bytes: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}/incidents/${incidentId}/evidence`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-filename': 'scene.png',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: new Uint8Array(bytes),
    });
  }

  /**
   * An incident the Rescue officer has actually been TOLD about, so the outsider genuinely
   * cannot read it and the officer at the scene genuinely can.
   *
   * ⚠️ **ROUTING IS NOT ENOUGH SINCE ADR-0030.** It routed to `rescueDept`, and migration 0039
   * left `seat.department_id` behind — so `evaluateRead` refuses a non-administrative seat every
   * routed incident and the officer uploading the photograph was answered **404 on their own
   * emergency**. Which non-administrative seat may attach evidence is the whole subject of the
   * refusal tests below, so switching the uploader to the control room would have deleted the
   * question rather than answered it.
   */
  async function incident(): Promise<string> {
    const created = await call('POST', '/incidents', dcToken, {
      category: `evidence-${RUN}`,
      severity: 'high',
    });
    const id = created.body['incidentId'] as string;
    await call('POST', `/incidents/${id}/dispatch-to`, dcToken, {
      targets: [{ kind: 'post', id: rescueSeat }],
      reason: 'test fixture',
    });
    return id;
  }

  //----------------------------------------------------------------------------
  // Storing
  //----------------------------------------------------------------------------

  it('stores a photograph and records its hash', async () => {
    const id = await incident();
    const res = await put(id, dcToken, PNG, { 'x-caption': 'the bazaar, from the north' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      evidenceId: string;
      sha256: string;
      byteSize: number;
      caption: string;
    };

    expect(body.byteSize).toBe(PNG.length);
    expect(body.sha256).toHaveLength(64);
    expect(body.caption).toBe('the bazaar, from the north');
  });

  it('puts the bytes on disk, not in the database', async () => {
    // Migration 0012 spells out why: photographs inside the nightly dump would take it from
    // megabytes to gigabytes, and the thing that then fails is the restore.
    const id = await incident();
    await put(id, dcToken, PNG);

    const files = await readdir(join(root, id));
    expect(files).toHaveLength(1);
    expect(await readFile(join(root, id, files[0]!))).toEqual(PNG);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'evidence'`,
    );
    const names = columns.rows.map((c) => c.column_name);
    expect(names).not.toContain('bytes');
    expect(names).not.toContain('data');
  });

  /**
   * The client never chooses the path.
   *
   * A filename is a label. It is recorded and shown to operators and never joined onto
   * anything, so a crafted one has nowhere to go — but a test that proves it is cheaper than
   * a review that assumes it.
   */
  it('ignores a filename that is trying to be a path', async () => {
    const id = await incident();
    const res = await put(id, dcToken, PNG, {
      'x-filename': '../../../db/migrations/0001_event_store.sql',
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { evidenceId: string; filename: string };
    expect(body.filename).not.toContain('..');
    expect(body.filename).not.toContain('/');

    // And it landed where the server decided, under this incident.
    const files = await readdir(join(root, id));
    expect(files.some((f) => f.startsWith(body.evidenceId))).toBe(true);

    // The migration it was aiming at is untouched.
    const migration = await readFile(join(migrationsDir, '0001_event_store.sql'), 'utf8');
    expect(migration).toContain('append-only');
  });

  it('refuses a kind of file it does not store', async () => {
    const id = await incident();
    // `image/svg+xml` is the one that matters: browsers execute script inside SVG, and an
    // allow-list is the only defence that does not need updating every browser release.
    const svg = await put(id, dcToken, Buffer.from('<svg onload="alert(1)"/>'), {
      'content-type': 'image/svg+xml',
      'x-filename': 'nasty.svg',
    });
    expect(svg.status).toBe(415);
  });

  it('refuses an empty file', async () => {
    const id = await incident();
    expect((await put(id, dcToken, Buffer.alloc(0))).status).toBe(409);
  });

  it('ignores a capture time from a phone with a clock set to next year', async () => {
    const id = await incident();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await put(id, dcToken, PNG, { 'x-captured-at': future });

    const body = (await res.json()) as { capturedAt: string | null };
    // Trusting it would date a photograph after the incident closed, and the timeline would
    // read as nonsense to whoever reviews it.
    expect(body.capturedAt).toBeNull();
  });

  it('keeps a capture time the device actually recorded', async () => {
    const id = await incident();
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    const res = await put(id, dcToken, PNG, { 'x-captured-at': earlier });

    const body = (await res.json()) as { capturedAt: string | null };
    // Taken during the fire, uploaded when the crew got back to signal. Two different facts.
    expect(body.capturedAt).toBe(earlier);
  });

  //----------------------------------------------------------------------------
  // Who may attach and who may look
  //----------------------------------------------------------------------------

  it('refuses an upload from somebody who cannot read the incident', async () => {
    const id = await incident();
    const res = await put(id, outsiderToken, PNG);
    // 404 rather than 403, matching how incident reads already behave: confirming an
    // incident exists to a seat with no business seeing it is itself a disclosure.
    expect(res.status).toBe(404);
  });

  it('refuses the download to somebody who cannot read the incident', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };

    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('refuses an unauthenticated download', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };
    expect((await fetch(`${base}/evidence/${uploaded.evidenceId}`)).status).toBe(401);
  });

  /**
   * Authority is decided before anything is read off disk.
   *
   * `download` used to fetch the file and hash it *first*, then ask whether the caller could
   * read the incident — up to 20 MB of disk read and a SHA-256 over it for a request about to
   * be refused, on the single machine that is also taking emergency reports. `upload` had
   * always stated the opposite rule for itself; the download path had simply missed it.
   *
   * Pinned without mocking, by deleting the file and reading which refusal comes back. An
   * outsider must be told "no such evidence" — the authority answer. If the bytes were read
   * first, the missing file would answer instead, and the message says which happened.
   */
  it('decides authority before touching the disk', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };

    const { rows } = await pool.query<{ stored_path: string }>(
      'SELECT stored_path FROM evidence WHERE evidence_id = $1',
      [uploaded.evidenceId],
    );
    await rm(resolve(root, rows[0]!.stored_path));

    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${outsiderToken}` },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    // The authority refusal, not the disk one — which is the whole assertion.
    expect(body.error).not.toMatch(/missing from disk/);
  });

  //----------------------------------------------------------------------------
  // Serving it back
  //----------------------------------------------------------------------------

  /**
   * The second way an upload endpoint compromises a control room.
   *
   * Whatever the device declared, the file goes back as a download that the browser will not
   * render or execute. The declared type is recorded as a fact and is deliberately not used
   * to decide how it is served.
   */
  it('hands the file back as a download, never as something a browser will run', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };

    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${dcToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // What the device claimed, kept as information rather than as an instruction.
    expect(res.headers.get('x-declared-type')).toBe('image/png');

    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('says the bytes are verified when they are', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };
    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${dcToken}` },
    });
    expect(res.headers.get('x-integrity')).toBe('verified');
  });

  /**
   * Evidence nobody can verify is not evidence — but withholding it is worse.
   *
   * A file whose bytes no longer match is still handed over: it may be the only photograph
   * of the scene. What must never happen is presenting it as verified.
   */
  it('still serves a file whose bytes have changed, and says so loudly', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };

    const stored = await pool.query<{ stored_path: string }>(
      'SELECT stored_path FROM evidence WHERE evidence_id = $1',
      [uploaded.evidenceId],
    );
    await writeFile(resolve(root, stored.rows[0]!.stored_path), Buffer.from('not the photograph'));

    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${dcToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-integrity')).toBe('MISMATCH');
  });

  it('says plainly when the record survives and the file does not', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };
    // Unique per run: `stored_path` carries a UNIQUE constraint, and the test database is
    // never cleaned, so a fixed value collides with the previous run's row.
    await pool.query('UPDATE evidence SET stored_path = $2 WHERE evidence_id = $1', [
      uploaded.evidenceId,
      `gone/missing-${RUN}-${randomUUID().slice(0, 8)}.png`,
    ]);

    const res = await fetch(`${base}/evidence/${uploaded.evidenceId}`, {
      headers: { authorization: `Bearer ${dcToken}` },
    });
    const body = (await res.json()) as { error: string };
    // Not "no such evidence". Somebody reading that would conclude the photograph was never
    // taken, when in fact the district has lost a file it recorded.
    expect(body.error).toContain('missing from disk');
  });

  //----------------------------------------------------------------------------
  // On the incident
  //----------------------------------------------------------------------------

  it('comes back with the incident, so the detail screen needs one request', async () => {
    const id = await incident();
    await put(id, dcToken, PNG, { 'x-caption': `attached ${RUN}` });

    const detail = await call('GET', `/incidents/${id}`, dcToken);
    const evidence = detail.body['evidence'] as { caption: string }[];
    expect(evidence.map((e) => e.caption)).toContain(`attached ${RUN}`);
  });

  it('can be referenced by a closure', async () => {
    const id = await incident();
    const uploaded = (await (await put(id, dcToken, PNG)).json()) as { evidenceId: string };

    await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});
    const resolved = await call('POST', `/incidents/${id}/resolve`, dcToken, {
      outcome: 'fire out, no casualties',
      evidenceIds: [uploaded.evidenceId],
    });
    expect(resolved.status).toBe(200);
  });

  //----------------------------------------------------------------------------
  // M1-04 — an action can say when it actually happened
  //----------------------------------------------------------------------------

  describe('the action log records when it happened, not when it was typed', () => {
    it('accepts a stated time in the past', async () => {
      const id = await incident();
      await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});

      const earlier = new Date(Date.now() - 20 * 60_000).toISOString();
      const logged = await call('POST', `/incidents/${id}/actions`, dcToken, {
        note: 'on scene',
        occurredAt: earlier,
      });
      expect(logged.status).toBe(200);

      const events = await loadIncident(pool, id);
      const action = events.find((e) => e.type === 'action_logged')!;

      // Twenty minutes ago, because that is when the crew arrived...
      expect(action.occurredAt).toBe(earlier);
      // ...and recorded now, because that is when the server learned of it. Keeping the two
      // apart is the whole of ADR-0002, and it is what stops a post-incident report claiming
      // the crew arrived the moment somebody found time to type.
      expect(Date.parse(action.recordedAt)).toBeGreaterThan(Date.parse(earlier));
    });

    it('refuses to backdate into the future', async () => {
      const id = await incident();
      await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});

      const future = new Date(Date.now() + 3_600_000).toISOString();
      await call('POST', `/incidents/${id}/actions`, dcToken, {
        note: 'from a device with a bad clock',
        occurredAt: future,
      });

      const events = await loadIncident(pool, id);
      const action = events.find((e) => e.type === 'action_logged')!;
      expect(Date.parse(action.occurredAt)).toBeLessThan(Date.parse(future));
    });

    it('still defaults to now when nobody says otherwise', async () => {
      const id = await incident();
      await call('POST', `/incidents/${id}/acknowledge`, dcToken, {});
      await call('POST', `/incidents/${id}/actions`, dcToken, { note: 'casualty removed' });

      const state = foldIncident(id, await loadIncident(pool, id));
      expect(state.actions.map((a) => a.note)).toContain('casualty removed');
    });
  });

  //----------------------------------------------------------------------------
  // The pure parts
  //----------------------------------------------------------------------------

  describe('paths and labels', () => {
    it('never builds a path outside the evidence root', () => {
      const incidentId = randomUUID();
      const evidenceId = randomUUID();
      const relative = pathFor('/srv/evidence', incidentId, evidenceId, 'jpg');
      expect(relative).toContain(incidentId);
      expect(relative).toContain(evidenceId);
      expect(relative).not.toContain('..');
    });

    it('keeps a filename recognisable, including in Urdu', () => {
      // `IMG_2041.jpg` and `بازار.jpg` are both what somebody will look for later.
      expect(safeLabel('IMG_2041.jpg')).toBe('IMG_2041.jpg');
      expect(safeLabel('بازار.jpg')).toBe('بازار.jpg');
      expect(safeLabel('/etc/passwd')).toBe('passwd');
      expect(safeLabel('')).toBe('file');
    });
  });

  it('can check every stored file against its recorded hash', async () => {
    // For the runbook, and for whoever is asked months later whether the district's evidence
    // is still what it was.
    const report = await verifyAll(pool, root);
    expect(report.checked).toBeGreaterThan(0);
    // One test above deliberately corrupted a file and one made a row point at nothing.
    expect(report.corrupt.length + report.missing.length).toBeGreaterThan(0);
  });
});
