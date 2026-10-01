/**
 * The control room chooses who should know — M6-03/04/05/10, over HTTP, against real PostgreSQL.
 *
 * This is the loop the whole milestone exists for, and the assertions worth reading first are
 * the ones that look wrong:
 *
 *   * **a vacant post is dispatched to, and fails** — because a refusal here would produce
 *     silence, and silence reads as everybody having been told (ADR-0004, ADR-0005)
 *   * **a person and the post they hold are two obligations, not one** — a post is held by
 *     whoever holds it tonight, and merging them would lose the one the operator chose
 *   * **an opened WhatsApp never settles anything** — an app opening is not an acknowledgement,
 *     and a board that can be quietened by tapping a link is worse than no board (ADR-0014)
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
import type { NotificationAttempt } from '../../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface Outcome {
  kind: string;
  id: string;
  label: string;
  coveredBy: { kind: string; id: string; label: string } | null;
  unreachable: string | null;
}

describe.skipIf(dbUrl === undefined)('the control room dispatch (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let rescueToken: string;
  let rescueDept: string;
  let policeDept: string;
  let rescueSeat: string;
  let reliefSeat: string;
  let rescuePerson: string;
  let policePerson: string;
  let vacantSeat: string;
  /** An officer in the directory with no sign-in — most of Bajaur's ~80 officials. */
  let contactOnlyPerson: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (disp ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (disp ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (disp ${RUN})`);
    const rescue = await seedActor(pool, {
      title: `Duty Officer (disp ${RUN})`,
      departmentId: rescueDept,
    });
    rescueToken = rescue.token;
    rescueSeat = rescue.seatId;
    rescuePerson = rescue.personId;

    policeDept = await seedDepartment(pool, `Police (disp ${RUN})`);
    policePerson = (await seedActor(pool, { title: `SHO (disp ${RUN})`, departmentId: policeDept }))
      .personId;

    // ADR-0030 — a SECOND designation held by the same officer. With no department above a
    // post, this is the only overlap the picker can still produce, and it is the one Bajaur has:
    // four of its officers are two contacts (M10-05).
    reliefSeat = randomUUID();
    await pool.query('INSERT INTO seat (seat_id, title) VALUES ($1, $2)', [
      reliefSeat,
      `Duty Officer Relief (disp ${RUN})`,
    ]);
    await pool.query(
      'INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())',
      [reliefSeat, rescuePerson],
    );

    vacantSeat = randomUUID();
    await pool.query('INSERT INTO seat (seat_id, title) VALUES ($1, $2)', [
      vacantSeat,
      `Night Duty (disp ${RUN})`,
    ]);

    const contact = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, NULL) RETURNING person_id`,
      [`Directory Officer (disp ${RUN})`, `+92301${randomUUID().slice(0, 8)}`],
    );
    contactOnlyPerson = contact.rows[0]!.person_id;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function report(token: string): Promise<string> {
    const res = await fetch(`${base}/incidents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ category: 'fire', severity: 'high', description: `disp ${RUN}` }),
    });
    const body = (await res.json()) as { incidentId: string };
    return body.incidentId;
  }

  async function dispatch(
    token: string,
    incidentId: string,
    body: unknown,
  ): Promise<{ status: number; body: { outcomes?: Outcome[]; error?: string } }> {
    const res = await fetch(`${base}/incidents/${incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? {} : JSON.parse(raw) };
  }

  async function attemptsFor(incidentId: string): Promise<NotificationAttempt[]> {
    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const body = (await res.json()) as { state: { notifications: NotificationAttempt[] } };
    return body.state.notifications;
  }

  //--------------------------------------------------------------------------
  // The loop itself
  //--------------------------------------------------------------------------

  it('records who was chosen, and turns each one into an obligation', async () => {
    const id = await report(controlToken);

    // A post and an officer who does not hold it. Overlapping selections collapse, and this
    // test is about the kinds surviving the trip rather than about the collapse.
    //
    // ⚠️ **A DEPARTMENT WAS THE FIRST OF THESE UNTIL ADR-0030 AND IS NOW A 404.** The kinds a
    // control room can choose between are the two that name a human: a post, and a person.
    const { status, body } = await dispatch(controlToken, id, {
      targets: [
        { kind: 'post', id: rescueSeat },
        { kind: 'person', id: policePerson },
      ],
      reason: 'caller says the road is blocked as well',
    });

    expect(status).toBe(200);
    expect(body.outcomes).toHaveLength(2);

    /**
     * **Two recipients, one obligation each — and they arrive under different reasons.**
     *
     * The officer's is `dispatched`: before M6-03 a named individual had no representation at
     * all, so this is the assertion that proves that gap closed.
     *
     * ⚠️ **`routed` USED TO BE HALF OF THIS TEST AND CANNOT HAPPEN ANY MORE.** A department
     * target placed the emergency as well as telling it, so its obligation arrived under the
     * other reason. There is nothing left to place an emergency with, so both obligations are
     * `dispatched` — and the assertion below is unchanged in shape and stricter in meaning: no
     * `routed` obligation is created, because nothing routes.
     */
    const attempts = await attemptsFor(id);

    expect(attempts.filter((a) => a.personId === policePerson)).toHaveLength(1);
    expect(attempts.filter((a) => a.reason === 'dispatched')).toHaveLength(2);
    // **One message each, and nothing arrives under a second reason.** `oneMessagePerRecipient`
    // keeps `dispatched` wherever two obligations meet, because "a named operator chose you" is
    // the more specific fact and is what the "who was told" panel matches on.
    expect(attempts.filter((a) => a.reason === 'routed')).toHaveLength(0);
  });

  it('sends one message when a post and its own holder are both ticked', async () => {
    const id = await report(controlToken);

    // The overlap the control room produces constantly and correctly: "tell the duty post, and
    // tell the officer on it" is one sentence about one handset. Sent literally it buzzes twice
    // for one emergency, which is the fastest way to teach somebody to mute it.
    await dispatch(controlToken, id, {
      targets: [
        { kind: 'post', id: rescueSeat },
        { kind: 'person', id: rescuePerson },
      ],
    });

    const dispatched = (await attemptsFor(id)).filter((a) => a.reason === 'dispatched');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.seatId).toBe(rescueSeat);
  });

  it('keeps a person and a post they do not hold as two separate obligations', async () => {
    const id = await report(controlToken);

    // Nothing absorbs either, so `targetKey` has to tell them apart — and it prefers the
    // person, so an officer named directly never merges into a post that merely reaches the
    // same building.
    await dispatch(controlToken, id, {
      targets: [
        { kind: 'post', id: rescueSeat },
        { kind: 'person', id: policePerson },
      ],
    });

    const dispatched = (await attemptsFor(id)).filter((a) => a.reason === 'dispatched');

    expect(dispatched).toHaveLength(2);
    expect(dispatched.filter((a) => a.personId === policePerson)).toHaveLength(1);
    expect(
      dispatched.filter((a) => a.personId === undefined && a.seatId === rescueSeat),
    ).toHaveLength(1);
  });

  /**
   * ⚠️ **THIS ABSORBED A POST INTO ITS DEPARTMENT UNTIL ADR-0030. There is no layer above a post
   * to absorb anything now, and the overlap it was written about has moved rather than gone.**
   *
   * With one contact per designation, an officer holding two IS two rows, and ticking both is
   * the obvious thing to do — Bajaur has four such officers (M10-05). Uncollapsed that is two
   * messages to one handset for one emergency.
   *
   * 🔴 The rule that does this has existed since 2026-08-22 and **had never once run**:
   * `collapseSelection` takes `holderOfPost` as an optional argument and `api/dispatch.ts` never
   * passed it, so the omission compiled and the collapse silently did not happen. It was masked
   * for as long as the department above absorbed the posts first.
   */
  it('absorbs a second designation into the first and says what absorbed it', async () => {
    const id = await report(controlToken);

    const { body } = await dispatch(controlToken, id, {
      targets: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: reliefSeat },
      ],
    });

    const covered = body.outcomes?.find((o) => o.id === reliefSeat);

    // Returned naming what covered it, not dropped. An operator who ticks two things and sees
    // one go stops trusting the control — and *"tell the Relief officer"* was really said.
    expect(covered?.coveredBy?.kind).toBe('post');
    expect(covered?.coveredBy?.id).toBe(rescueSeat);
    expect(covered?.coveredBy?.label).toContain('Duty Officer');
  });

  //--------------------------------------------------------------------------
  // The things that look like bugs
  //--------------------------------------------------------------------------

  it('dispatches to a vacant post, marks it, and lets the obligation fail', async () => {
    const id = await report(controlToken);

    const { status, body } = await dispatch(controlToken, id, {
      targets: [{ kind: 'post', id: vacantSeat }],
    });

    // Accepted, not refused. Refusing would hide the vacancy from the one person about to
    // notice it, and would let a vacant post swallow an obligation in silence (ADR-0004).
    expect(status).toBe(200);
    expect(body.outcomes?.[0]?.unreachable).toBe('nobody holds this designation');

    const failed = (await attemptsFor(id)).filter(
      (a) => a.reason === 'dispatched' && a.state === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failure).toContain('no_duty_holder');
  });

  it('does not treat "cannot sign in" as a reason an officer is unreachable', async () => {
    /**
     * **This assertion was inverted by ADR-0018, and the inversion is the decision.**
     *
     * It used to read *"fails an in-app message to an officer with no sign-in"* and expected
     * `no_account`. That was correct while there was an inbox: a message left in an app for
     * somebody who cannot open it reaches nobody, for ever, and saying so is what sent an
     * operator to the telephone.
     *
     * There is no inbox now. Almost the whole district is this officer — a name and a number,
     * no credentials, deliberately (M0-51) — and a WhatsApp message goes to a **number**, so
     * having no account has stopped being a defect in the recipient. The only thing missing
     * here is the district's own WhatsApp account (R-05), and the record must say **that**.
     *
     * The two are worth telling apart to the point of a test, because they send the district
     * to opposite fixes: one to the roster, one to Meta.
     */
    const id = await report(controlToken);

    await dispatch(controlToken, id, { targets: [{ kind: 'person', id: contactOnlyPerson }] });

    const attempt = (await attemptsFor(id)).find((a) => a.personId === contactOnlyPerson);

    // Still failed, and still loud — nothing was sent, because this installation has no
    // account yet. INV-03: an obligation nobody acted on is never left looking met.
    expect(attempt?.state).toBe('failed');
    expect(attempt?.failure).toContain('no_channel');
    expect(attempt?.failure).not.toContain('no_account');
  });

  it('refuses the whole dispatch when one target does not exist', async () => {
    const id = await report(controlToken);

    const { status } = await dispatch(controlToken, id, {
      targets: [
        { kind: 'post', id: rescueSeat },
        { kind: 'post', id: randomUUID() },
      ],
    });

    expect(status).toBe(404);

    // Not partially applied. "Three of your four went" is unrecoverable on a telephone call at
    // 02:00; refusing the lot costs one tap.
    expect((await attemptsFor(id)).filter((a) => a.reason === 'dispatched')).toHaveLength(0);
  });

  //--------------------------------------------------------------------------
  // Authority — INV-05, by direct HTTP, never through a browser
  //--------------------------------------------------------------------------

  it('refuses a caller with no session', async () => {
    const id = await report(controlToken);
    const res = await fetch(`${base}/incidents/${id}/dispatch-to`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });
    expect(res.status).toBe(401);
  });

  it('answers 404, not 403, to a department with no authority over the incident', async () => {
    const id = await report(controlToken);
    // Routed away from Rescue, so the Rescue seat may not read it at all.
    await fetch(`${base}/incidents/${id}/route`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ departmentIds: [policeDept], reason: 'law and order' }),
    });

    const { status } = await dispatch(rescueToken, id, {
      targets: [{ kind: 'post', id: rescueSeat }],
    });

    // Confirming the incident exists is itself a disclosure about another department.
    expect(status).toBe(404);
  });

  it('refuses an empty selection and a malformed one', async () => {
    const id = await report(controlToken);

    expect((await dispatch(controlToken, id, { targets: [] })).status).toBe(400);
    expect((await dispatch(controlToken, id, { targets: 'rescue' })).status).toBe(400);
    expect(
      (await dispatch(controlToken, id, { targets: [{ kind: 'squadron', id: rescueSeat }] }))
        .status,
    ).toBe(400);
    // ADR-0031, phase 2: `'department'` left `RecipientKind`, so it is now an unknown kind.
    expect(
      (await dispatch(controlToken, id, { targets: [{ kind: 'department', id: rescueDept }] }))
        .status,
    ).toBe(400);
  });

  //--------------------------------------------------------------------------
  // A person-addressed obligation — M6-03, after the inbox was removed
  //--------------------------------------------------------------------------

  it('records a person-addressed obligation against the officer, not a post', async () => {
    /**
     * These two assertions used to be made through the inbox: the officer opened the app and
     * their message was there. **The inbox is gone (ADR-0018)** — nobody outside the control
     * room signs in — so the property is asserted where it actually lives, in the ledger.
     *
     * That is arguably the better test. The inbox was one *surface* onto the obligation; what
     * M6-03 closed was the gap where a named individual had no representation **at all**, and
     * that is a fact about the record rather than about a screen.
     */
    const id = await report(controlToken);
    await dispatch(controlToken, id, { targets: [{ kind: 'person', id: rescuePerson }] });

    const attempts = await attemptsFor(id);
    const mine = attempts.filter((a) => a.personId === rescuePerson);

    expect(mine).toHaveLength(1);
    // Addressed to the human, and carrying no post — a post is held by whoever holds it
    // tonight, and this obligation follows the man rather than the chair.
    expect(mine[0]?.seatId).toBeNull();
  });

  it('records one for an officer who holds no post at all', async () => {
    // The case that had nowhere to go before M6-03. Most of Bajaur is exactly this: a name and
    // a number in the directory, no post, no account, and now no app to open either.
    const seatless = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, NULL) RETURNING person_id`,
      [`Seatless Officer (disp ${RUN})`, `+92302${randomUUID().slice(0, 8)}`],
    );
    const personId = seatless.rows[0]!.person_id;

    const id = await report(controlToken);
    await dispatch(controlToken, id, { targets: [{ kind: 'person', id: personId }] });

    expect((await attemptsFor(id)).filter((a) => a.personId === personId)).toHaveLength(1);
  });
  //--------------------------------------------------------------------------
  // M6-10 — "Reach them" leaves a trace, and only the trace it can honestly leave
  //--------------------------------------------------------------------------

  it('records that an app was opened, and never that anyone was reached', async () => {
    const id = await report(controlToken);
    await dispatch(controlToken, id, { targets: [{ kind: 'post', id: rescueSeat }] });

    const res = await fetch(`${base}/incidents/${id}/contact-opened`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ channel: 'whatsapp', seatId: rescueSeat, label: 'Duty Officer' }),
    });
    expect(res.status).toBe(200);

    const detail = (await (
      await fetch(`${base}/incidents/${id}`, { headers: authHeaders(controlToken) })
    ).json()) as {
      state: { contactsOpened: { channel: string }[]; notifications: NotificationAttempt[] };
    };

    expect(detail.state.contactsOpened).toHaveLength(1);
    expect(detail.state.contactsOpened[0]?.channel).toBe('whatsapp');

    // The assertion that matters. Opening WhatsApp observed no ring, no answer and no
    // conversation, so the obligation is exactly as unmet as it was a second ago (ADR-0014).
    const dispatched = detail.state.notifications.find((a) => a.reason === 'dispatched');
    expect(dispatched?.state).not.toBe('delivered');
  });

  it('refuses a contact record that does not say whose number it was', async () => {
    const id = await report(controlToken);
    const res = await fetch(`${base}/incidents/${id}/contact-opened`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ channel: 'call' }),
    });
    expect(res.status).toBe(400);
  });

  //--------------------------------------------------------------------------
  // A dispatch places an emergency nobody holds
  //--------------------------------------------------------------------------

  async function stateOf(incidentId: string): Promise<{
    unassigned: boolean;
    responsibleDepartmentIds: string[];
  }> {
    const res = await fetch(`${base}/incidents/${incidentId}`, {
      headers: authHeaders(controlToken),
    });
    const body = (await res.json()) as {
      state: { unassigned: boolean; responsibleDepartmentIds: string[] };
    };
    return body.state;
  }

  /**
   * 🔴 **THE DISTRICT'S OWN COMPLAINT, ANSWERED BY A DIFFERENT MECHANISM — ADR-0030.**
   *
   * The thing that read as the product being broken: an operator chose Rescue 1122, told them,
   * and the board went on saying **nobody has this** while the dashboard counted it unassigned.
   * Both statements were true of the data and neither was true of the district.
   *
   * M6 answered it by making a dispatch ROUTE the emergency — the control room choosing a
   * department is the human assignment ADR-0010 asks for. Migration 0039 took the departments,
   * so nothing can be placed with anybody ever again, and left alone that answer would have
   * come undone in the loudest possible way: `unassigned` true for every live incident for
   * ever, and `.row[data-unassigned='true']` paints the critical wash and outranks the rule
   * that lets an acknowledged row recede. **Every row on Bajaur's board, permanently red.**
   *
   * So the field asks the question the district acts on instead, which is the one their own wall
   * has asked since 2026-08-18: **has anybody been told?** Choosing who to tell is what clears
   * it — the same operator action, the same moment, the same relief of the same complaint.
   *
   * ⚠️ **Two tests stood here and the second has no successor.** *"takes the department from a
   * chosen post, not only from a chosen department"* existed because picking *Duty Officer* had
   * picked Rescue, and making the operator tick the department too would be the screen knowing
   * something and refusing to use it. There is nothing left for it to know.
   */
  it('stops saying nobody has an emergency once the control room has told somebody', async () => {
    const id = await report(controlToken);
    expect((await stateOf(id)).unassigned).toBe(true);

    await dispatch(controlToken, id, { targets: [{ kind: 'post', id: rescueSeat }] });

    const after = await stateOf(id);
    expect(after.unassigned).toBe(false);
    // ⚠️ And the RECORD is untouched: nobody is responsible, because nobody can be. The word on
    // the screen changed; what happened did not.
    expect(after.responsibleDepartmentIds).toEqual([]);
  });

  it('never takes an emergency away from a department that already holds it', async () => {
    /**
     * The one-directional half, and the one worth guarding. Telling four extra departments
     * about a fire must not make four departments responsible for it — and it must certainly
     * not move it off whoever was holding it. That is what `reassign` is for, and reassign
     * demands a reason precisely because a handover has to be explainable afterwards.
     */
    const id = await report(controlToken);
    await fetch(`${base}/incidents/${id}/route`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ departmentIds: [policeDept], reason: 'law and order' }),
    });

    await dispatch(controlToken, id, { targets: [{ kind: 'post', id: rescueSeat }] });

    // Still Police. The duty officer was told; nothing moved the emergency off whoever held it.
    expect((await stateOf(id)).responsibleDepartmentIds).toEqual([policeDept]);
  });

  it('makes nobody responsible when only a named officer was chosen', async () => {
    // A person is not a department. Choosing one tells them and places the emergency nowhere,
    // which is correct — and it stays visible as unassigned rather than looking handled.
    const id = await report(controlToken);
    await dispatch(controlToken, id, { targets: [{ kind: 'person', id: policePerson }] });

    expect((await stateOf(id)).responsibleDepartmentIds).toEqual([]);
  });

  /**
   * ⚠️ **THE SUBJECT MOVED WITH THE ROUTING — ADR-0030.**
   *
   * This read a `routed` event and required `ruleId: 'manual'` with the operator's seat on it:
   * six months later, *"why did Rescue get this"* has to have the right answer, and the answer
   * has to be a person rather than a signal that matched. Nothing routes any more, so there is
   * no `routed` event to read — and the question survives whole, because the act that places
   * work with somebody is the dispatch itself now.
   */
  it('records that a person decided who was told, with their own seat on it', async () => {
    const id = await report(controlToken);
    await dispatch(controlToken, id, { targets: [{ kind: 'post', id: rescueSeat }] });

    const detail = (await (
      await fetch(`${base}/incidents/${id}`, { headers: authHeaders(controlToken) })
    ).json()) as {
      events: { type: string; actorSeatId: string | null }[];
    };

    const dispatches = detail.events.filter((e) => e.type === 'dispatched');
    expect(dispatches).toHaveLength(1);
    // Not null. A `dispatched` event nobody performed would read as *"the system"* on the
    // incident's own timeline, which is what `nameOf` draws for an actorless event — and the
    // whole point of this record is that a named operator decided it.
    expect(dispatches[0]?.actorSeatId).not.toBeNull();
  });
});
