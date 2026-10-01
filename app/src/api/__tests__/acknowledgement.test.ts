/**
 * The operator records what they were told — M7-05, M7-06, M7-07, over HTTP, real PostgreSQL.
 *
 * The district rings people. It did before this software and it will after the WhatsApp account
 * arrives, and until this endpoint existed **none of it reached the record** — an obligation an
 * operator had personally closed on a two-minute call stayed on the board for ever as an
 * emergency nobody had been told about.
 *
 * The assertions worth reading first are the ones about attribution, because they are what
 * stops this feature from being the thing ADR-0014 refuses:
 *
 *   * **the operator is the actor, the recipient is the subject** — three different facts, and
 *     a system that flattened them could not answer *"who said Rescue was told?"*, which is the
 *     first question asked when Rescue says they were not
 *   * **`route: 'operator'` is on the record**, so no report can add a telephone call to the
 *     link taps (M7-30)
 *   * **"could not reach them" settles nothing** — it is a better *reason* for an obligation
 *     that is still owed, not a way to make it go quiet
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
import { foldIncident, type NotificationAttempt } from '../../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the operator records an acknowledgement', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let controlSeat: string;
  let controlPerson: string;
  let rescueDept: string;
  let rescueSeat: string;
  let rescuePerson: string;
  /** A directory contact with a number and no post — most of Bajaur (M0-51). */
  let seatlessPerson: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (ack ${RUN})`);
    const control = await seedActor(pool, {
      title: `Control Room (ack ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });
    controlToken = control.token;
    controlSeat = control.seatId;
    controlPerson = control.personId;

    rescueDept = await seedDepartment(pool, `Rescue (ack ${RUN})`);
    const rescue = await seedActor(pool, {
      title: `Duty Officer (ack ${RUN})`,
      departmentId: rescueDept,
    });
    rescueSeat = rescue.seatId;
    rescuePerson = rescue.personId;

    const contact = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, NULL) RETURNING person_id`,
      [`Directory Officer (ack ${RUN})`, `+92303${randomUUID().slice(0, 8)}`],
    );
    seatlessPerson = contact.rows[0]!.person_id;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function report(): Promise<string> {
    const res = await fetch(`${base}/incidents`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ category: 'fire', severity: 'high', description: `ack ${RUN}` }),
    });
    return ((await res.json()) as { incidentId: string }).incidentId;
  }

  /** Report, then tell somebody — which is what produces an obligation to answer. */
  async function reportAndTell(target: { kind: string; id: string }): Promise<string> {
    const id = await report();
    await fetch(`${base}/incidents/${id}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [target] }),
    });
    return id;
  }

  async function attemptsFor(incidentId: string): Promise<NotificationAttempt[]> {
    const events = await loadIncident(pool, incidentId);
    return [...foldIncident(incidentId, events).notifications];
  }

  async function record(
    token: string,
    incidentId: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}/incidents/${incidentId}/acknowledged-by`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? {} : JSON.parse(raw) };
  }

  //--------------------------------------------------------------------------
  // The thing itself — M7-05
  //--------------------------------------------------------------------------

  it('settles the obligation and acknowledges the incident', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });

    // Before: the district has no WhatsApp account, so the attempt already failed saying
    // exactly that. This is the state Bajaur is in today and the state this feature is for.
    const before = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat);
    expect(before?.state).toBe('failed');
    expect(before?.failure).toContain('no_channel');

    const { status, body } = await record(controlToken, id, {
      attemptId: before!.attemptId,
      outcome: 'confirmed',
      said: 'Ambulance nikal gai hai — ETA 10 minutes',
    });

    expect(status).toBe(200);
    expect(body['acknowledged']).toBe(true);

    const after = (await attemptsFor(id)).find((a) => a.attemptId === before!.attemptId);
    expect(after?.state).toBe('delivered');
    expect(after?.via).toBe('operator');
    expect(after?.said).toBe('Ambulance nikal gai hai — ETA 10 minutes');
    // **One attempt, not two.** Recording a fresh `manual` attempt beside the failed one was
    // the obvious implementation and would have made a recipient the district *did* reach look
    // like two obligations on the board, one of them unmet for ever.
    expect((await attemptsFor(id)).filter((a) => a.seatId === rescueSeat)).toHaveLength(1);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedBySeatId).toBe(rescueSeat);
    expect(state.status).toBe('acknowledged');
  });

  //--------------------------------------------------------------------------
  // The operator's word is not the machine's observation — M7-06
  //--------------------------------------------------------------------------

  it('attributes the statement to the operator and the acknowledgement to the recipient', async () => {
    /**
     * The three-way split, in one assertion each. It is the whole of M7-06 and it is the
     * difference between this feature and the read receipt ADR-0014 refuses to count:
     * a person is on the record as having said this, and it is possible to go and ask them.
     */
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'Confirmed by DO on 0333',
    });

    const ack = (await loadIncident(pool, id)).find((e) => e.type === 'acknowledged')!;

    // Who typed it: the operator.
    expect(ack.actorSeatId).toBe(controlSeat);
    expect(ack.actorPersonId).toBe(controlPerson);
    // Who took the emergency: Rescue's duty post. Not the same person, deliberately.
    expect((ack.payload as { seatId: string }).seatId).toBe(rescueSeat);
    // How we know — never merged with a link tap (M7-30).
    expect((ack.payload as { route: string }).route).toBe('operator');
    expect((ack.payload as { said: string }).said).toBe('Confirmed by DO on 0333');
    // The channel it arrived by, because that is part of how much weight it carries.
    expect(ack.sourceChannel).toBe('call');
  });

  it('refuses a confirmation with nothing said, because that is the entire record', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    // The authority table already demands a reason for acknowledging on somebody's behalf
    // (`incident.acknowledgement`, reasonRequired). This refuses it in words an operator on a
    // telephone can act on, rather than as "requires a reason to override".
    const { status, body } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
    });

    expect(status).toBe(400);
    expect(String(body['error'])).toContain('what they told you');

    expect(foldIncident(id, await loadIncident(pool, id)).acknowledgedAt).toBeNull();
  });

  //--------------------------------------------------------------------------
  // Could not reach them — M7-07
  //--------------------------------------------------------------------------

  it('records an unreachable recipient without settling anything', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    const { status } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'could_not_reach',
      said: 'rang twice, number is dead',
    });
    expect(status).toBe(200);

    const after = (await attemptsFor(id)).find((a) => a.attemptId === attempt.attemptId);

    // Still owed, still visible, still counted against the district. What changed is the
    // **reason**: not "no account is configured" but "a person rang and got nothing", which
    // sends somebody to the roster instead of to Meta.
    expect(after?.state).toBe('failed');
    expect(after?.failure).toContain('could_not_reach');
    expect(after?.failure).toContain('number is dead');
    expect(after?.via).toBe('operator');

    // And it is emphatically not an acknowledgement.
    expect(foldIncident(id, await loadIncident(pool, id)).acknowledgedAt).toBeNull();
  });

  it('will not let a later entry erase an operator who recorded a conversation', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'they have it',
    });

    const second = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'could_not_reach',
      said: 'actually no',
    });

    expect(second.status).toBe(409);
    expect((await attemptsFor(id)).find((a) => a.attemptId === attempt.attemptId)?.state).toBe(
      'delivered',
    );
  });

  //--------------------------------------------------------------------------
  // The edges that would otherwise be found in Bajaur
  //--------------------------------------------------------------------------

  it('acknowledges for an officer with no post — the control room chose them', async () => {
    /**
     * **This test asserted the opposite until 2026-08-17, and the owner reversed it.**
     *
     * It used to require that a post-less officer settled the ledger and **stopped short of
     * acknowledging**, reasoning from ADR-0004 that the incident's clock stops because a *duty*
     * took the emergency. That reading is defensible and it was still wrong here, for a reason
     * that is about the district rather than about the model: **the control room chose this
     * officer, by name, deliberately.** Software answering *"they hold no post, so this does not
     * count"* overrules an operational decision the district made on purpose — and it left the
     * record unable to say that somebody the control room had assigned work to had confirmed it.
     *
     * The owner's words: *"control room se jin ko bhi assignment milti hai wo sab official hain,
     * record hona, acknowledge hona sab lazmi hai."*
     *
     * **`acknowledgedBySeatId` stays null and that is the honest shape**, not a gap: there is no
     * post to name, and `personId` on the payload carries who it was. The event's own schema has
     * always allowed exactly this — *"the officer, when the acknowledgement is theirs rather than
     * a post's"* — so nothing here is being bent to fit.
     *
     * ⚠️ **What it costs, kept in the test so it is not rediscovered as a bug:** acknowledging
     * stops the clock and stops escalation, so a post-less officer who confirms and then does
     * nothing leaves no software chasing it. That is not a new class of risk — the same is true of
     * a post-holder who goes quiet — and the district widened it knowingly.
     *
     * Identical to what the acknowledge tap does, deliberately: two routes to one fact must not
     * disagree about what that fact means.
     */
    const id = await reportAndTell({ kind: 'person', id: seatlessPerson });
    const attempt = (await attemptsFor(id)).find((a) => a.personId === seatlessPerson)!;

    const { status, body } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'he will pass it on',
    });

    expect(status).toBe(200);
    expect(body['acknowledged']).toBe(true);

    expect((await attemptsFor(id)).find((a) => a.attemptId === attempt.attemptId)?.state).toBe(
      'delivered',
    );

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.acknowledgedAt).not.toBeNull();
    // No post to name, so no post is named — and the person is who it was.
    expect(state.acknowledgedBySeatId).toBeNull();
    expect(state.acknowledgedVia).toBe('operator');
    expect(state.acknowledgedSaid).toBe('he will pass it on');
  });

  it('acknowledges for an officer told BY NAME who does hold a post', async () => {
    /**
     * **The other half of the test above, and the pair is the whole point.**
     *
     * Both dispatch to a `person`. The one above names an officer who genuinely holds nothing and
     * is correctly refused; this one names an officer who **holds `rescueSeat`** and must not be.
     * Until 2026-08-17 they behaved identically, because the code asked `seatId === null` — which
     * a person-kinded obligation always carries — instead of asking whether this officer holds a
     * post. One question stood in for the other and the answers only agree half the time.
     *
     * What it cost here specifically: the control room's **telephone** record was the documented
     * way round the broken acknowledge button, and it was shut by the identical null. The
     * operator rang, typed what they were told, and got `200 ok` with `acknowledged: false` —
     * while the board went on showing the emergency as unanswered with nothing saying why.
     *
     * The seat is resolved **now** rather than frozen, unlike the acknowledge tap's: an operator
     * is asserting a fact about a call happening at this moment, so the post held at this moment
     * is the right one. There is no earlier instant here to be faithful to.
     */
    const id = await reportAndTell({ kind: 'person', id: rescuePerson });
    const attempt = (await attemptsFor(id)).find((a) => a.personId === rescuePerson)!;

    const { status, body } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'crew dispatched, arriving in ten minutes',
    });

    expect(status).toBe(200);
    // `false` before the fix, on an officer who holds a post and had just confirmed by telephone.
    expect(body['acknowledged']).toBe(true);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.acknowledgedAt).not.toBeNull();
    expect(state.acknowledgedBySeatId).toBe(rescueSeat);
    // Still the operator's statement about somebody else, never rendered as the officer's own
    // acknowledgement — the line this whole module is built around (M7-06).
    expect(state.acknowledgedVia).toBe('operator');
    expect(state.acknowledgedSaid).toBe('crew dispatched, arriving in ten minutes');
  });

  it('refuses an attempt id that belongs to no message on this incident', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });

    const { status } = await record(controlToken, id, {
      attemptId: randomUUID(),
      outcome: 'confirmed',
      said: 'they have it',
    });

    // 404 and not 200-with-nothing-done. An operator who typed the wrong row and was told
    // "ok" would believe an officer had been recorded as reached.
    expect(status).toBe(404);
  });

  it('refuses an outcome it does not understand rather than guessing', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    const { status } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'maybe',
      said: 'not sure',
    });
    expect(status).toBe(400);
  });

  it('refuses a seat with no authority over the incident', async () => {
    /**
     * There is one user (ADR-0018), and the boundary is still enforced server-side (INV-05).
     * Removing an audience does not remove the boundary — if department access is ever granted
     * again it has to be already there, rather than rebuilt under time pressure.
     */
    const otherDept = await seedDepartment(pool, `Education (ack ${RUN})`);
    const outsider = await seedActor(pool, {
      title: `DEO (ack ${RUN})`,
      departmentId: otherDept,
    });

    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    // Placed with Rescue, so an Education seat cannot even see it.
    await fetch(`${base}/incidents/${id}/route`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ departmentIds: [rescueDept], reason: `ack ${RUN}` }),
    });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    const { status } = await record(outsider.token, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'nothing to do with me',
    });

    // 404, never 403 — confirming the incident exists is itself a disclosure.
    expect(status).toBe(404);
  });

  it('is refused on a closed incident', async () => {
    const id = await reportAndTell({ kind: 'post', id: rescueSeat });
    const attempt = (await attemptsFor(id)).find((a) => a.seatId === rescueSeat)!;

    /**
     * **The control room closing its own district's emergency, which it could not do until
     * today.** `incident.closure` is owned by the responsible department and requires a reason
     * from an overrider; the control room is district tier, so it is always overriding — and
     * `parseCommand` accepted no reason for resolve or close, so every one was refused.
     *
     * Nothing caught it because every test that closed an incident did so as the **owning
     * department's** seat, and ADR-0018 has just removed that audience entirely. Asserted here
     * rather than left implicit: if the reason stops being carried, this goes red.
     */
    const resolved = await fetch(`${base}/incidents/${id}/resolve`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ outcome: 'resolved', reason: `control room closing, ack ${RUN}` }),
    });
    expect(resolved.status).toBe(200);

    const closed = await fetch(`${base}/incidents/${id}/close`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ notes: `ack ${RUN}`, reason: `control room closing, ack ${RUN}` }),
    });
    expect(closed.status).toBe(200);

    const { status } = await record(controlToken, id, {
      attemptId: attempt.attemptId,
      outcome: 'confirmed',
      said: 'late',
    });
    expect(status).toBe(409);

    // Named so the post has a holder at all — without it `rescueSeat` is a vacant chair and
    // every assertion in this file would be about a different failure.
    expect(rescuePerson).toBeTruthy();
  });
});
