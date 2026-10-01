/**
 * The incident lifecycle over HTTP — M0-24…28, 30, 31.
 *
 * Every one of these goes through the real server against the real database. Nothing is
 * driven through a browser and nothing is stubbed, for the reason INV-05 exists: an
 * authority rule that only holds when you use the app is not a rule, and the people this
 * system must withstand will use `curl`.
 *
 * The suite is organised around what each check is protecting, not around the endpoints, so
 * a deleted test is visibly a deleted protection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { saveGroup } from '../../db/groupStore.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';
import { ASSUMED_CATEGORY, ASSUMED_SEVERITY } from '../lifecycle.js';
import { PLACEHOLDER_SLA } from '../../domain/sla.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('incident lifecycle over HTTP (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;

  let rescueToken: string;
  let rescueSupervisorToken: string;
  let policeToken: string;
  let controlRoomToken: string;
  let dcToken: string;
  let seatlessToken: string;

  let rescueSeat: string;
  let controlRoomSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    rescueSeat = await makeSeat('Rescue 1122 Station In-Charge', 'station');
    const rescueSupervisorSeat = await makeSeat('Rescue 1122 Tehsil Supervisor', 'tehsil');
    const policeSeat = await makeSeat('SHO Bajaur City', 'station');
    controlRoomSeat = await makeSeat('District Control Room', 'district');
    const dcSeat = await makeSeat('Deputy Commissioner Bajaur', 'district', true);

    rescueToken = await actor('Rescue Duty Officer', rescueSeat);
    rescueSupervisorToken = await actor('Rescue Supervisor', rescueSupervisorSeat);
    policeToken = await actor('Police Duty Officer', policeSeat);
    controlRoomToken = await actor('Control Room Operator', controlRoomSeat);
    dcToken = await actor('Deputy Commissioner', dcSeat);
    seatlessToken = await actor('Transferred Officer', null);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(title: string, tier: string, breakGlass = false): Promise<string> {
    const res = await pool.query<{ seat_id: string }>(
      // ADR-0030 — the trigger derives `tier` from `is_administration` alone (migration 0039), so
      // the value passed for it is overwritten. Asking for `district` and writing nothing else
      // gets a `department` seat, and every assertion below then fails a long way from the cause.
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, $3, $4) RETURNING seat_id`,
      [title, tier, breakGlass, tier === 'district'],
    );
    return res.rows[0]!.seat_id;
  }

  /** A person, optionally holding a seat, signed in. Null seat = authenticated, no authority. */
  async function actor(name: string, seatId: string | null): Promise<string> {
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    if (seatId !== null) {
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seatId,
        person.rows[0]!.person_id,
      ]);
    }
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return result.token;
  }

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const sendsBody = method !== 'GET' && method !== 'HEAD' && body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(sendsBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>,
    };
  }

  /** A reported incident, already routed to Rescue. The starting point for most tests. */
  async function routedIncident(): Promise<string> {
    const created = await call('POST', '/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'high',
    });
    const id = created.body['incidentId'] as string;
    const routed = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
      departmentIds: [rescueDept],
      reason: 'road traffic accident on the Khar road',
    });
    expect(routed.status).toBe(200);
    return id;
  }

  /**
   * A reported incident that somebody has actually been told about.
   *
   * ⚠️ **ROUTING IS NO LONGER ENOUGH TO ACKNOWLEDGE — ADR-0030.** The guard in `lifecycle.ts`
   * used to ask for a responsible department, and migration 0039 left that list empty on every
   * incident for ever; it now asks the question it was really asking — has anybody been given
   * this — and a dispatch is what gives it to somebody. A fixture that only routes therefore
   * gets `nobody has been told about this yet`, which is the guard working, not a regression.
   */
  async function toldIncident(): Promise<string> {
    const id = await routedIncident();
    const told = await call('POST', `/incidents/${id}/dispatch-to`, controlRoomToken, {
      targets: [{ kind: 'post', id: rescueSeat }],
      reason: 'rescue is nearest',
    });
    expect(told.status).toBe(200);
    return id;
  }

  describe('intake never refuses (M0-24, INV-01)', () => {
    it('accepts a complete report', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'fire',
        severity: 'critical',
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual([]);
    });

    it('accepts a report with no fields at all, and says what it assumed', async () => {
      // Someone told us an emergency is happening. Refusing that to enforce a schema would
      // be the system choosing to lose it.
      const res = await call('POST', '/incidents', rescueToken, {});
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['category', 'severity']);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      // One: the report. An automatic routing pass appended a second here until ADR-0022,
      // and nothing follows a report into the log now until a person acts on it.
      expect(events.map((e) => e.type)).toEqual(['reported']);
      expect(events[0]!.payload).toMatchObject({
        category: ASSUMED_CATEGORY,
        severity: ASSUMED_SEVERITY,
      });

      // Nothing is assigned at intake since ADR-0022 — the control room does that — and the
      // reporter is told so rather than being left to infer it from an empty list (ADR-0005).
      expect(res.body['unassigned']).toBe(true);
      expect(res.body['routedTo']).toEqual([]);
    });

    it('accepts a report whose body is not even valid json', async () => {
      const res = await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${rescueToken}` },
        body: '{this is not json',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { assumed: string[] };
      expect(body.assumed).toContain('severity');
    });

    it('replaces a nonsense severity rather than rejecting the report', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'flood',
        severity: 'apocalyptic',
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['severity']);
    });

    it('records an unstated severity as unknown, never as a guessed level (ADR-0009)', async () => {
      // The old behaviour guessed `high`. It was defensible and it was wrong: on a screen,
      // an assumption is indistinguishable from an assessment.
      const res = await call('POST', '/incidents', rescueToken, { category: 'flood' });
      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect((events[0]!.payload as { severity: string }).severity).toBe('unknown');
      expect(ASSUMED_SEVERITY).toBe('unknown');
    });

    it('refuses to let triage set a severity back to unknown', async () => {
      // Triage is the act of assessing. Revising an assessment to "no assessment" is not a
      // thing an operator does, and `unknown` is intake's value alone.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'unknown',
        category: 'rta',
      });
      expect(res.status).toBe(400);
    });

    it('escalates an unassessed report on the high deadline, not the low one', async () => {
      // The urgency the old guess expressed now lives in the SLA target, where it does not
      // lie on a screen. Same effect on escalation; no false claim about who judged what.
      expect(PLACEHOLDER_SLA.unknown).toBe(PLACEHOLDER_SLA.high);
    });

    it('refuses to accept an occurredAt in the future', async () => {
      // A clock skewed forward would push the SLA deadline out and quietly buy the incident
      // extra time before it escalates. The report is still accepted; the claim is not.
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'rta',
        severity: 'high',
        occurredAt: future,
      });
      expect(res.status).toBe(201);
      expect(res.body['assumed']).toEqual(['occurredAt']);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect(events[0]!.occurredAt < future).toBe(true);
    });

    it('keeps a stated past occurredAt — the offline case', async () => {
      const earlier = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'rta',
        severity: 'high',
        occurredAt: earlier,
      });
      expect(res.body['assumed']).toEqual([]);

      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect(new Date(events[0]!.occurredAt).toISOString()).toBe(earlier);
      // recordedAt is the server's, and it is later. That gap is the district's measured
      // connectivity picture (ADR-0002).
      expect(events[0]!.recordedAt > events[0]!.occurredAt).toBe(true);
    });
  });

  describe('importance (M10-20/41/42)', () => {
    it('defaults an emergency to important, written explicitly', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'fire',
        severity: 'high',
      });
      const events = await loadIncident(pool, res.body['incidentId'] as string);
      // Explicit, not merely absent — the fold's own absent-value reading is `routine`
      // (M10-21, for events written before this field existed), the opposite of what a fresh
      // emergency should get.
      expect((events[0]!.payload as { importance: string }).importance).toBe('important');
    });

    it('lets the operator move it to routine', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        category: 'fire',
        severity: 'low',
        importance: 'routine',
      });
      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect((events[0]!.payload as { importance: string }).importance).toBe('routine');
    });

    it('never writes importance for a General communication, where it has no meaning', async () => {
      const res = await call('POST', '/incidents', rescueToken, {
        kind: 'meeting',
        details: { subject: 'Monthly coordination' },
        // Sent anyway, to prove the server ignores it here rather than merely defaulting it.
        importance: 'routine',
      });
      const events = await loadIncident(pool, res.body['incidentId'] as string);
      expect(events[0]!.payload).not.toHaveProperty('importance');
    });
  });

  /**
   * **The detail screen's identity line** — 2026-08-24.
   *
   * It read `Incident 297e3fba-accf-4298-808a-c3c4d01d3337`, which is the right identity for
   * the software and unusable by the control room that reads it out over a telephone. Both
   * identities are on the response: the uuid on `state`, because every action on the screen is
   * built on it, and the number beside it because that is what a human quotes.
   */
  describe('the incident carries the number the district counts by', () => {
    it('answers with the number in the printed form, beside the record id', async () => {
      const id = await routedIncident();
      const res = await call('GET', `/incidents/${id}`, controlRoomToken);

      expect(res.status).toBe(200);
      expect(res.body['reference']).toMatch(/^DNC-BAJAUR-[1-9][0-9]*$/);
      // Beside the uuid, never instead of it — the URL and every action still use that.
      expect((res.body['state'] as Record<string, unknown>)['incidentId']).toBe(id);
    });

    it('gives the same incident the same number on every read', async () => {
      const id = await routedIncident();
      const first = await call('GET', `/incidents/${id}`, controlRoomToken);
      await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      const second = await call('GET', `/incidents/${id}`, controlRoomToken);

      // A number printed on a report must keep pointing at the same night. Acting on the
      // incident is exactly the thing that must not move it.
      expect(second.body['reference']).toBe(first.body['reference']);
    });
  });

  describe('authentication and seats', () => {
    it('refuses every lifecycle path without a session', async () => {
      const id = await routedIncident();
      for (const [method, path] of [
        ['POST', '/incidents'],
        ['GET', `/incidents/${id}`],
        ['POST', `/incidents/${id}/triage`],
        ['POST', `/incidents/${id}/acknowledge`],
        ['POST', `/incidents/${id}/close`],
      ] as const) {
        const res = await call(method, path, null, method === 'GET' ? undefined : {});
        expect(res.status).toBe(401);
      }
    });

    it('lets a signed-in account with no duty seat act as the control room (ADR-0032)', async () => {
      // An account minted through Settings → Accounts holds a role and no `duty_assignment`.
      // Since ADR-0018/0024 the only accounts that sign in are the control room's, and since
      // ADR-0030 the district is the only read scope left — so a seatless account reads and
      // acts on the district. A duty post is no longer required to use the system.
      const id = await routedIncident();

      const board = await call('GET', '/incidents', seatlessToken);
      expect(board.status).toBe(200);

      const detail = await call('GET', `/incidents/${id}`, seatlessToken);
      expect(detail.status).toBe(200);

      const triage = await call('POST', `/incidents/${id}/triage`, seatlessToken, {
        severity: 'critical',
        category: 'rta-multiple-casualty',
      });
      expect(triage.status).toBe(200);
      expect((triage.body['state'] as { severity: { value: string } }).severity.value).toBe(
        'critical',
      );
    });
  });

  describe('routing (M0-27) and reassignment (M0-30)', () => {
    it('lets the control room route an unrouted incident', async () => {
      // A category nothing can match, on purpose. `fire` would be auto-routed by whatever
      // signals the district has configured — which is the correct behaviour and the wrong
      // fixture for a test about routing something by hand.
      const created = await call('POST', '/incidents', controlRoomToken, {
        category: `nothing-routes-this-${randomUUID().slice(0, 8)}`,
        severity: 'high',
      });
      const id = created.body['incidentId'] as string;

      const res = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [rescueDept],
        reason: 'structure fire, Rescue leads',
      });
      expect(res.status).toBe(200);
      expect(
        (res.body['state'] as { responsibleDepartmentIds: string[] }).responsibleDepartmentIds,
      ).toEqual([rescueDept]);
    });

    it('refuses a station-tier seat trying to route', async () => {
      // Routing authority is tehsil and above. A station in-charge cannot hand work to
      // another department by themselves.
      const created = await call('POST', '/incidents', rescueToken, {
        category: `nothing-routes-this-${randomUUID().slice(0, 8)}`,
        severity: 'high',
      });
      const res = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/route`,
        rescueToken,
        { departmentIds: [policeDept], reason: 'not ours' },
      );
      /**
       * ⚠️ **404, NOT 403, SINCE ADR-0030 — and it is this file's own rule arriving one layer
       * earlier.** *"A read the caller has no authority for is a 404"*: confirming an incident
       * exists is itself a disclosure about somebody else's operations. Nothing can be placed
       * with a department any more, so `evaluateRead` refuses this seat the incident outright
       * and the write check below it is never reached. The refusal is the same refusal and it
       * is stricter — it does not say what it is refusing. The authority table's own answer is
       * still pinned, in `domain/__tests__/authority.test.ts`.
       */
      expect(res.status).toBe(404);
    });

    it('requires a reason to route', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const res = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/route`,
        controlRoomToken,
        { departmentIds: [rescueDept] },
      );
      expect(res.status).toBe(400);
      expect(res.body['error']).toMatch(/reason/);
    });

    it('sends a second routing attempt to reassign, so the handover is recorded as one', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'wrong department',
      });
      expect(res.status).toBe(409);
      expect(res.body['error']).toMatch(/reassign/);
    });

    it('reassigns with a reason, and the reason is in the log', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'crowd control required; Police leads from here',
      });
      expect(res.status).toBe(200);

      const events = await loadIncident(pool, id);
      const reassigned = events.find((e) => e.type === 'reassigned');
      expect(reassigned?.payload).toMatchObject({
        toDepartmentIds: [policeDept],
        reason: 'crowd control required; Police leads from here',
      });
    });

    it('refuses a reassignment with no reason (INV-06)', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('triage (M0-26)', () => {
    /**
     * 🔴 **WAS *"lets the owning department triage its own incident"* — 2026-08-22.**
     *
     * The district removed the whole idea of a department acting: *"department ko koi access nahi
     * milne wala hai, un ka koi account nahi banega."* Ownership of every governed field moved to
     * the seat's **tier** — see `ownerTiers` in `domain/authority.ts`, and the note there on why it
     * had to be ownership rather than `overrideTiers`.
     */
    it('lets the control room triage, with no reason asked for', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, controlRoomToken, {
        severity: 'critical',
        category: 'rta-multiple-casualty',
      });
      expect(res.status).toBe(200);
      const state = res.body['state'] as { severity: { value: string }; status: string };
      expect(state.severity.value).toBe('critical');
    });

    it('refuses the responsible department, which no longer owns anything', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'critical',
        category: 'rta-multiple-casualty',
      });
      /**
       * ⚠️ **404, NOT 403, SINCE ADR-0030 — and it is this file's own rule arriving one layer
       * earlier.** *"A read the caller has no authority for is a 404"*: confirming an incident
       * exists is itself a disclosure about somebody else's operations. Nothing can be placed
       * with a department any more, so `evaluateRead` refuses this seat the incident outright
       * and the write check below it is never reached. The refusal is the same refusal and it
       * is stricter — it does not say what it is refusing. The authority table's own answer is
       * still pinned, in `domain/__tests__/authority.test.ts`.
       */
      expect(res.status).toBe(404);
    });

    it('refuses a department with no stake in the incident', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, policeToken, {
        severity: 'low',
        category: 'nothing to see',
      });
      // Not a 403: Police has no authority to read this incident either, and confirming it
      // exists would itself disclose another department's operations.
      expect(res.status).toBe(404);
    });

    it('rejects a severity outside the scale', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/triage`, controlRoomToken, {
        severity: 'extremely bad',
        category: 'rta',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('acknowledgement (M0-28)', () => {
    it('records the seat from the session, not from the body', async () => {
      // The whole audit trail rests on this. A client that can name its own seat can put a
      // lie into the record, and the record is faithful — it would preserve it forever.
      const id = await toldIncident();
      // The body names the RESCUE seat; the session is the control room. The session wins.
      const res = await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {
        seatId: rescueSeat,
        actorSeatId: rescueSeat,
      });
      expect(res.status).toBe(200);

      const events = await loadIncident(pool, id);
      const ack = events.find((e) => e.type === 'acknowledged')!;
      expect(ack.actorSeatId).toBe(controlRoomSeat);
      expect((ack.payload as { seatId: string }).seatId).toBe(controlRoomSeat);
    });

    /**
     * ⚠️ **Was *"before the incident has been ROUTED"* until ADR-0030.**
     *
     * The guard asked for a responsible department, and migration 0039 emptied that list on
     * every incident there will ever be — so the guard as written refused every acknowledgement
     * in the district, on the one act this whole system exists to record, with the SLA clock
     * still running behind the refusal. It now asks what it was always really asking: **has
     * anybody been given this yet.**
     *
     * The refusal is kept rather than dropped, which is why this test is kept rather than
     * deleted: acknowledging an emergency nobody was told about is somebody claiming work that
     * was never handed to them, and it stops the clock on it.
     *
     * The second half is the half that is new. A routed incident used to pass this guard, and a
     * routing is now a note about who ought to have it — nobody's handset has rung yet.
     */
    it('refuses an acknowledgement before anybody has been told', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const untouched = await call(
        'POST',
        `/incidents/${created.body['incidentId'] as string}/acknowledge`,
        controlRoomToken,
        {},
      );
      expect(untouched.status).toBe(409);
      expect(untouched.body['error']).toMatch(/nobody has been told/);

      // Routed, and still nobody has been told: a routing records who should have it, and a
      // dispatch is what actually reaches a human.
      const routed = await call(
        'POST',
        `/incidents/${await routedIncident()}/acknowledge`,
        controlRoomToken,
        {},
      );
      expect(routed.status).toBe(409);
      expect(routed.body['error']).toMatch(/nobody has been told/);
    });

    it('refuses a second acknowledgement rather than restarting the clock', async () => {
      const id = await toldIncident();
      expect(
        (await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {})).status,
      ).toBe(200);
      const again = await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      expect(again.status).toBe(409);
      expect(again.body['error']).toMatch(/already acknowledged/);
    });

    it('refuses a supervisor in the responsible department too', async () => {
      // Seniority inside a department was never the rule — the department's ownership was. With
      // that gone, a supervisor is refused exactly as the duty seat is.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/acknowledge`, rescueSupervisorToken, {});
      // ⚠️ 404 since ADR-0030 — `evaluateRead` refuses this seat the incident before the write
      // check is reached, which is this file's own *"a read you have no authority for is a 404"*
      // rule arriving one layer earlier. Stricter: the refusal does not say what it refused.
      expect(res.status).toBe(404);
    });

    /**
     * ⚠️ **Was *"only with a reason"* until 2026-08-22, and the reason is what stopped being
     * asked for.**
     *
     * A reason was demanded because the control room was **overriding the department that owned
     * the acknowledgement**. There is no such owner now, so there is nothing to override and
     * nobody to explain it to. Keeping `reasonRequired` would have meant a typed justification on
     * every acknowledgement of every emergency, extracted from the only people left who can act —
     * which is how a required field becomes a field people paste *"ok"* into.
     */
    it('lets the control room acknowledge without explaining itself', async () => {
      const id = await toldIncident();
      const res = await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      expect(res.status).toBe(200);
    });
  });

  /**
   * **Who took a message that went to more than one office — Option C, 2026-09-10.**
   *
   * The fold has one `acknowledgedBy*` slot and the first answer of any kind fills it, a
   * refusal included, so on a wide dispatch "Taken by" has been naming whoever tapped first.
   * `readIncident` now also carries the `ownershipOf` roll-up as `response`: the office that
   * first *committed*, `null` while everyone is silent, `ownerless` when all of them refused.
   */
  describe('the response roll-up on a wide dispatch (Option C)', () => {
    interface Roll {
      told: number;
      holding: number;
      declined: number;
      silent: number;
      ownerless: boolean;
      takenBySeatId: string | null;
      respondedAt: string | null;
    }
    interface DetailBody {
      state: {
        acknowledgedBySeatId: string | null;
        notifications: { attemptId: string; seatId: string | null }[];
      };
      sla?: { carries: boolean };
      response: Roll | null;
    }

    async function toldMany(seatIds: readonly string[]): Promise<string> {
      const id = await routedIncident();
      const told = await call('POST', `/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: seatIds.map((sid) => ({ kind: 'post', id: sid })),
        reason: 'every nearby post',
      });
      expect(told.status).toBe(200);
      return id;
    }

    async function detail(id: string): Promise<DetailBody> {
      const res = await call('GET', `/incidents/${id}`, controlRoomToken);
      expect(res.status).toBe(200);
      return res.body as unknown as DetailBody;
    }

    async function answer(id: string, seatId: string, said: string): Promise<void> {
      const attempt = (await detail(id)).state.notifications.find((n) => n.seatId === seatId);
      const res = await call('POST', `/incidents/${id}/acknowledged-by`, controlRoomToken, {
        attemptId: attempt!.attemptId,
        outcome: 'confirmed',
        said,
      });
      expect(res.status).toBe(200);
    }

    it('names nobody while every recipient is still silent', async () => {
      const id = await toldMany([
        await makeSeat('Silent Post A', 'station'),
        await makeSeat('Silent Post B', 'station'),
      ]);

      const d = await detail(id);
      expect(d.response?.told).toBe(2);
      expect(d.response?.takenBySeatId).toBeNull();
      expect(d.response?.ownerless).toBe(false);
      // The deadline snapshot rides along now — it was computed and never sent before Option C.
      expect(d.sla?.carries).toBe(true);
    });

    it('names the office that committed, not the one that answered first with a refusal', async () => {
      const decliner = await makeSeat('Busy Post', 'station');
      const taker = await makeSeat('Nearest Post', 'station');
      const id = await toldMany([decliner, taker]);

      // The first answer on the record is a refusal — it fills the fold's one ack slot.
      await answer(id, decliner, 'Unable to Respond');
      // A second office then takes it.
      await answer(id, taker, 'Proceeding to the Site');

      const d = await detail(id);
      // The fold still names the first tap, which was the decline.
      expect(d.state.acknowledgedBySeatId).toBe(decliner);
      // The roll-up names the office that is actually going.
      expect(d.response?.takenBySeatId).toBe(taker);
      expect(d.response?.holding).toBe(1);
      expect(d.response?.declined).toBe(1);
      expect(d.response?.ownerless).toBe(false);
      expect(d.response?.respondedAt).not.toBeNull();
    });

    it('is ownerless, and names nobody, when every office refuses', async () => {
      const a = await makeSeat('On-Leave Post', 'station');
      const b = await makeSeat('Off-Area Post', 'station');
      const id = await toldMany([a, b]);

      await answer(id, a, 'Unable to Respond');
      await answer(id, b, 'Not Related to Me');

      const d = await detail(id);
      expect(d.response?.ownerless).toBe(true);
      expect(d.response?.takenBySeatId).toBeNull();
      expect(d.response?.respondedAt).toBeNull();
      expect(d.response?.declined).toBe(2);
    });
  });

  /**
   * **The attendance tally on a notice that asked who is coming** — the Case 2 (meeting) work.
   *
   * `readIncident` now also carries an `attendance` roll-up: null for everything that is not
   * asking (every emergency, `schedule`, a plain notice), and the `attendanceFor` tally for a
   * `meeting` or an `asksAttendance` notice — the same numbers the wall's *Still running* card
   * already reads, so the drawer can show "3 of 5 coming" instead of `status` / "Taken by".
   */
  describe('the attendance roll-up on a meeting notice (Case 2)', () => {
    interface Attendance {
      told: number;
      coming: number;
      answered: number;
      attending: number;
      sendingSomeone: number;
      notAttending: number;
      unanswered: number;
      rows: { seatId: string | null; answer: string; said: string | null }[];
    }
    interface Body {
      state: { notifications: { attemptId: string; seatId: string | null }[] };
      response: unknown;
      attendance: Attendance | null;
    }

    async function detail(id: string): Promise<Body> {
      const res = await call('GET', `/incidents/${id}`, controlRoomToken);
      expect(res.status).toBe(200);
      return res.body as unknown as Body;
    }

    async function meetingToldMany(seatIds: readonly string[]): Promise<string> {
      const created = await call('POST', '/incidents', controlRoomToken, {
        kind: 'meeting',
        details: { subject: 'Monthly coordination meeting' },
      });
      const id = created.body['incidentId'] as string;
      const told = await call('POST', `/incidents/${id}/dispatch-to`, controlRoomToken, {
        targets: seatIds.map((sid) => ({ kind: 'post', id: sid })),
        reason: 'every tehsildar',
      });
      expect(told.status).toBe(200);
      return id;
    }

    async function reply(id: string, seatId: string, said: string): Promise<void> {
      const attempt = (await detail(id)).state.notifications.find((n) => n.seatId === seatId);
      const res = await call('POST', `/incidents/${id}/acknowledged-by`, controlRoomToken, {
        attemptId: attempt!.attemptId,
        outcome: 'confirmed',
        said,
      });
      expect(res.status).toBe(200);
    }

    it('is null for an emergency — nobody attends a road accident', async () => {
      const id = await toldIncident();
      const d = await detail(id);
      expect(d.attendance).toBeNull();
      // The response roll-up is still there for the emergency path.
      expect(d.response).not.toBeNull();
    });

    it('counts who is coming, a representative included, off the officers own words', async () => {
      const a = await makeSeat('Tehsildar A', 'station');
      const b = await makeSeat('Tehsildar B', 'station');
      const c = await makeSeat('Tehsildar C', 'station');
      const dSeat = await makeSeat('Tehsildar D', 'station');
      const id = await meetingToldMany([a, b, c, dSeat]);

      await reply(id, a, 'Attending');
      await reply(id, b, 'Sending someone');
      await reply(id, c, 'Not attending');
      // d stays silent

      const att = (await detail(id)).attendance;
      expect(att).not.toBeNull();
      expect(att?.told).toBe(4);
      expect(att?.attending).toBe(1);
      expect(att?.sendingSomeone).toBe(1);
      expect(att?.notAttending).toBe(1);
      expect(att?.unanswered).toBe(1);
      // A representative counts — "2 of 4 coming".
      expect(att?.coming).toBe(2);
      expect(att?.answered).toBe(3);
      expect(att?.rows).toHaveLength(4);
    });

    it('reads 0 coming and 0 answered on a meeting nobody has replied to', async () => {
      const id = await meetingToldMany([
        await makeSeat('Silent Tehsildar A', 'station'),
        await makeSeat('Silent Tehsildar B', 'station'),
      ]);
      const att = (await detail(id)).attendance;
      expect(att?.told).toBe(2);
      expect(att?.coming).toBe(0);
      expect(att?.answered).toBe(0);
    });
  });

  /**
   * **The group a dispatch expanded, kept for the drawer's heading — Case 3, 2026-09-10.**
   *
   * `expand()` dissolves a ticked group into loose recipients before anything is stored, so
   * `dispatchedTo` has no idea a group was used. `readIncident` now also reads the group's name
   * back off `dispatched.payload.fromGroups` as `recipientGroups`, display only: `[]` for an
   * incident told by hand, one entry with its roster for one told through a group. Nothing here
   * is folded into `IncidentState`.
   */
  describe('the group a dispatch expanded (Case 3)', () => {
    interface Body {
      recipientGroups: { groupId: string; name: string; members: { kind: string; id: string }[] }[];
    }

    async function detail(id: string): Promise<Body> {
      const res = await call('GET', `/incidents/${id}`, controlRoomToken);
      expect(res.status).toBe(200);
      return res.body as unknown as Body;
    }

    // Written straight through `saveGroup` — the console route is gated on an account role
    // (`requireAdministration`), which this suite's SQL-seeded seats do not carry. `groups.test.ts`
    // covers the route; this suite only needs a group to exist so `dispatch-to` can expand it.
    async function makeGroup(name: string, seatIds: readonly string[]): Promise<string> {
      const res = await saveGroup(
        pool,
        { name, members: seatIds.map((id) => ({ kind: 'post', id })) },
        { seatId: controlRoomSeat, personId: null },
      );
      if (!res.ok) throw new Error(`saveGroup: ${res.problem.kind}`);
      return res.group.groupId;
    }

    it('is empty when the control room dispatched everybody by hand', async () => {
      const id = await toldIncident();
      expect((await detail(id)).recipientGroups).toEqual([]);
    });

    it('carries the group name and roster when a dispatch expanded one', async () => {
      const name = `All Tehsildars ${randomUUID().slice(0, 8)}`;
      const seats = [
        await makeSeat('Tehsildar One', 'station'),
        await makeSeat('Tehsildar Two', 'station'),
        await makeSeat('Tehsildar Three', 'station'),
      ];
      const groupId = await makeGroup(name, seats);

      const id = await routedIncident();
      const told = await call('POST', `/incidents/${id}/dispatch-to`, controlRoomToken, {
        groups: [groupId],
        reason: 'every tehsildar',
      });
      expect(told.status).toBe(200);

      const groups = (await detail(id)).recipientGroups;
      expect(groups).toHaveLength(1);
      expect(groups[0]?.groupId).toBe(groupId);
      expect(groups[0]?.name).toBe(name);
      expect(groups[0]?.members.map((m) => m.id).sort()).toEqual([...seats].sort());
    });

    it('does not move when the group is edited afterwards — the name is copied', async () => {
      const name = `Rescue Group ${randomUUID().slice(0, 8)}`;
      const seats = [
        await makeSeat('Rescue Seat A', 'station'),
        await makeSeat('Rescue Seat B', 'station'),
      ];
      const groupId = await makeGroup(name, seats);

      const id = await routedIncident();
      expect(
        (
          await call('POST', `/incidents/${id}/dispatch-to`, controlRoomToken, {
            groups: [groupId],
            reason: 'rescue group',
          })
        ).status,
      ).toBe(200);

      // Empty the group after the fact — the incident's heading must not change.
      const edited = await saveGroup(
        pool,
        { groupId, name, members: [] },
        { seatId: controlRoomSeat, personId: null },
      );
      expect(edited.ok).toBe(true);

      const groups = (await detail(id)).recipientGroups;
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members).toHaveLength(2);
    });
  });

  describe('override (ADR-0003)', () => {
    it("keeps the department's own assessment underneath the district's", async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/triage`, rescueToken, {
        severity: 'high',
        category: 'rta',
      });

      const res = await call('POST', `/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
        reason: 'second reporter confirms multiple casualties',
      });
      expect(res.status).toBe(200);

      const state = res.body['state'] as {
        severity: { value: string; overriddenFrom?: { value: string; reason: string } };
      };
      expect(state.severity.value).toBe('critical');
      expect(state.severity.overriddenFrom?.value).toBe('high');
      expect(state.severity.overriddenFrom?.reason).toMatch(/multiple casualties/);
    });

    it('refuses an override with no reason', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'critical',
      });
      expect(res.status).toBe(400);
    });

    /**
     * ⚠️ **Q-17 is answered, and not by this file — 2026-08-22.**
     *
     * This pinned a live question: the policy table let the **owning department** emit an
     * `overridden` event on its own fields, and whether it should have been able to, rather than
     * triaging again, was left open on purpose so that changing it would be deliberate.
     *
     * The district settled it from the other end. No department acts at all, so the question of
     * what a department may override does not arise. Pinned again in its new shape, for the same
     * reason: if a department ever holds a seat again, this is where that decision resurfaces.
     */
    it('refuses the owning department an override, which answers Q-17', async () => {
      const id = await routedIncident();
      const refused = await call('POST', `/incidents/${id}/override`, rescueToken, {
        field: 'severity',
        value: 'low',
        reason: 'downgrading our own call',
      });
      // ⚠️ 404 since ADR-0030 — `evaluateRead` refuses this seat the incident before the write
      // check is reached, which is this file's own *"a read you have no authority for is a 404"*
      // rule arriving one layer earlier. Stricter: the refusal does not say what it refused.
      expect(refused.status).toBe(404);

      const res = await call('POST', `/incidents/${id}/override`, controlRoomToken, {
        field: 'severity',
        value: 'low',
        reason: 'downgrading on the control room’s own assessment',
      });
      expect(res.status).toBe(200);

      // Attributable, which is the half of ADR-0003 that has not changed: the event names the
      // seat that actually emitted it, so nobody can manufacture the appearance of a decision
      // somebody else took.
      const events = await loadIncident(pool, id);
      expect(events.find((e) => e.type === 'overridden')?.actorSeatId).toBe(controlRoomSeat);
    });
  });

  describe('resolution and closure (M0-31)', () => {
    it('walks an incident to closed', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      await call('POST', `/incidents/${id}/actions`, controlRoomToken, {
        note: 'two ambulances dispatched from Bajaur station',
      });

      const resolved = await call('POST', `/incidents/${id}/resolve`, controlRoomToken, {
        outcome: 'four casualties transported to DHQ; road cleared',
      });
      expect(resolved.status).toBe(200);

      const closed = await call('POST', `/incidents/${id}/close`, controlRoomToken, {
        notes: 'handover to Police for the report',
      });
      expect(closed.status).toBe(200);
      expect((closed.body['state'] as { status: string }).status).toBe('closed');
    });

    it('refuses to close an incident that was never resolved', async () => {
      // Closure completeness is a metric this system exists to be honest about, and an
      // incident closed with no recorded outcome is the failure it measures.
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/close`, controlRoomToken, {
        notes: 'nothing to report',
      });
      expect(res.status).toBe(409);
      expect(res.body['error']).toMatch(/resolve/);
    });

    it('refuses further changes once closed', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/resolve`, controlRoomToken, { outcome: 'stood down' });
      await call('POST', `/incidents/${id}/close`, controlRoomToken, { notes: 'false alarm' });

      const res = await call('POST', `/incidents/${id}/triage`, controlRoomToken, {
        severity: 'low',
        category: 'rta',
      });
      expect(res.status).toBe(409);
    });

    it('still accepts a response action after closure, because it is a fact that happened', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/resolve`, controlRoomToken, { outcome: 'stood down' });
      await call('POST', `/incidents/${id}/close`, controlRoomToken, { notes: 'false alarm' });

      const res = await call('POST', `/incidents/${id}/actions`, controlRoomToken, {
        note: 'crew debrief logged the next morning',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('cross-department access is denied by default', () => {
    it('hides an incident from a department with no stake in it', async () => {
      const id = await routedIncident();
      const res = await call('GET', `/incidents/${id}`, policeToken, undefined);
      expect(res.status).toBe(404);
    });

    it('shows it to the owning department', async () => {
      const id = await routedIncident();
      const res = await call('GET', `/incidents/${id}`, controlRoomToken, undefined);
      expect(res.status).toBe(200);
      expect((res.body['state'] as { incidentId: string }).incidentId).toBe(id);
    });

    it('shows it to the district, which holds override authority over it', async () => {
      const id = await routedIncident();
      expect((await call('GET', `/incidents/${id}`, controlRoomToken, undefined)).status).toBe(200);
      expect((await call('GET', `/incidents/${id}`, dcToken, undefined)).status).toBe(200);
    });

    /**
     * 🔴 **THIS ASSERTED THE OPPOSITE UNTIL ADR-0030, AND THE OLD REASONING IS KEPT BECAUSE IT
     * WAS RIGHT WHEN IT WAS WRITTEN.**
     *
     * It said: *an emergency nobody is permitted to see is an emergency nobody picks up
     * (INV-01)* — and required an unrouted incident to be visible to every seat. That is a true
     * argument about a district where department officers sign in and might be the one to pick
     * something up. **ADR-0018 removed that audience on 2026-08-06** and nobody came back to
     * this line; ADR-0024 then left no department holding a seat at all.
     *
     * What made it urgent is that ADR-0030 turned *unrouted* from a window seconds wide into
     * the permanent state of every incident in Bajaur: nothing can be placed with anybody now.
     * Read as it stood, this test's rule hands the entire district to every account that
     * exists, for ever.
     *
     * ⚠️ **INV-01 is not weakened, and the distinction is exact.** That invariant is about an
     * emergency never being LOST — reported, stored, and acted on. It is acted on by the
     * control room, which is who holds every unplaced incident (`defaultRules`' own note) and
     * is the only account this district has. What is refused here is a seat that could not act
     * on it either way.
     */
    it('does not show an unrouted incident to a seat with no district authority', async () => {
      const created = await call('POST', '/incidents', controlRoomToken, { category: 'rta' });
      const id = created.body['incidentId'] as string;

      expect((await call('GET', `/incidents/${id}`, policeToken, undefined)).status).toBe(404);
      // And the control room, which is who actually picks it up, still has it.
      expect((await call('GET', `/incidents/${id}`, dcToken, undefined)).status).toBe(200);
    });

    it('returns the full history alongside the state, so provenance is renderable', async () => {
      const id = await routedIncident();
      await call('POST', `/incidents/${id}/triage`, controlRoomToken, {
        severity: 'critical',
        category: 'rta',
      });
      const res = await call('GET', `/incidents/${id}`, controlRoomToken, undefined);
      const events = res.body['events'] as { type: string }[];
      /**
       * **One routing entry, not two.**
       *
       * There were two until ADR-0022: an automatic pass wrote one at intake and the control
       * room's own decision wrote the second, and keeping both apart was how the record
       * answered which of the two actually sent help. That question has one answer now — a
       * human — so the second event never existed and there is nothing to collapse.
       */
      expect(events.map((e) => e.type)).toEqual(['reported', 'routed', 'triaged']);
    });
  });

  describe('nothing here mutates (ADR-0001)', () => {
    it('every command appends exactly one event and rewrites none', async () => {
      const id = await toldIncident();
      const before = await loadIncident(pool, id);

      await call('POST', `/incidents/${id}/triage`, controlRoomToken, {
        severity: 'critical',
        category: 'rta',
      });
      await call('POST', `/incidents/${id}/acknowledge`, controlRoomToken, {});
      await call('POST', `/incidents/${id}/resolve`, controlRoomToken, { outcome: 'cleared' });

      const after = await loadIncident(pool, id);
      expect(after).toHaveLength(before.length + 3);
      // The events that were already there are byte-for-byte what they were.
      expect(after.slice(0, before.length)).toEqual(before);
    });

    it('a refused command leaves no trace in the log', async () => {
      const id = await routedIncident();
      const before = await loadIncident(pool, id);
      await call('POST', `/incidents/${id}/triage`, policeToken, {
        severity: 'low',
        category: 'x',
      });
      await call('POST', `/incidents/${id}/close`, controlRoomToken, { notes: 'no' });
      expect(await loadIncident(pool, id)).toHaveLength(before.length);
    });
  });

  describe('routes that do not exist', () => {
    it('404s an unknown incident', async () => {
      const res = await call('GET', `/incidents/${randomUUID()}`, controlRoomToken, undefined);
      expect(res.status).toBe(404);
    });

    it('404s a malformed incident id without touching the database', async () => {
      const res = await call('GET', '/incidents/not-a-uuid', controlRoomToken, undefined);
      expect(res.status).toBe(404);
    });

    it('404s an unknown action', async () => {
      const id = await routedIncident();
      const res = await call('POST', `/incidents/${id}/annihilate`, controlRoomToken, {});
      expect(res.status).toBe(404);
    });

    it('405s the wrong method', async () => {
      const id = await routedIncident();
      expect((await call('DELETE', `/incidents/${id}`, controlRoomToken, undefined)).status).toBe(
        405,
      );
      expect(
        (await call('GET', `/incidents/${id}/triage`, controlRoomToken, undefined)).status,
      ).toBe(405);
    });
  });
});
