/**
 * The acknowledge page becomes the lifecycle page — M9-27, M9-28, M9-30.
 *
 * Real PostgreSQL, real HTTP, real single-use tokens, real fold. Nothing is stubbed here at all:
 * the whole claim being tested is that an officer **with no account** can move an emergency from
 * Acknowledged to Responded to Resolved using nothing but links this system minted, and that
 * every hostile version of that goes the right way.
 *
 * ## Why this file exists apart from `whatsappLoop.test.ts`
 *
 * That file owns the ledger — what a `read` receipt does and does not settle. This one owns the
 * **record**: what gets written to the event log, by whom, and what happens when a link arrives
 * late, twice, or against an emergency that has moved on. They fail for different reasons and
 * should say so separately.
 *
 * ## The three that matter most
 *
 * **A GET never records progress** (`4`). WhatsApp fetches URLs to build link previews, so a
 * crawler following a Responded link would otherwise mark an emergency on an officer's behalf,
 * before any human saw it. The acknowledge link cannot be protected this way — it is a URL
 * button in an approved template and can only be a GET — but everything this system mints on its
 * own page is a form that POSTs.
 *
 * **A late link does not walk the record backwards** (`8`). An officer taps *Responded* an hour
 * after a colleague resolved it. Nothing has gone wrong, nothing may change, and the page must
 * not tell them off.
 *
 * **The act is attributed to whoever the token was minted for** (`6`), never to whoever holds the
 * post at the moment of the tap. ADR-0004: a handover between the message going out and the tap
 * arriving must not silently reattribute a resolution.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { mintAckToken, type AckStage } from '../../db/whatsappStore.js';
import { stageOf } from '../../domain/stages.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the lifecycle link', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let controlToken: string;
  let rescueSeat: string;
  let rescuePerson: string;
  /** A second officer, for the token-minted-for-one-used-against-another's-record test. */
  let otherSeat: string;
  let otherPerson: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (life ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (life ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (life ${RUN})`);
    const duty = await seedActor(pool, {
      title: `Duty Officer (life ${RUN})`,
      departmentId: rescue,
    });
    rescueSeat = duty.seatId;
    rescuePerson = duty.personId;

    const other = await seedActor(pool, {
      title: `Night Officer (life ${RUN})`,
      departmentId: rescue,
    });
    otherSeat = other.seatId;
    otherPerson = other.personId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  /** An emergency, routed to Rescue and dispatched, so there is an obligation to answer. */
  async function reportAndDispatch(): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: 'fire', severity: 'high', description: `life ${RUN}` }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: rescueSeat }] }),
    });

    return created.incidentId;
  }

  async function attemptOn(incidentId: string): Promise<string> {
    const events = await loadIncident(pool, incidentId);
    const first = [...foldIncident(incidentId, events).notifications][0];
    if (first === undefined) throw new Error('no obligation was recorded to answer');
    return first.attemptId;
  }

  async function mint(
    incidentId: string,
    stage: AckStage,
    who: { seatId: string; personId: string } = { seatId: rescueSeat, personId: rescuePerson },
  ): Promise<string> {
    return mintAckToken(pool, {
      attemptId: await attemptOn(incidentId),
      incidentId,
      seatId: who.seatId,
      personId: who.personId,
      stage,
    });
  }

  const statusOf = async (incidentId: string): Promise<string> =>
    foldIncident(incidentId, await loadIncident(pool, incidentId)).status;

  const post = async (token: string, said?: string): Promise<Response> =>
    fetch(`${base}/ack/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: said === undefined ? '' : new URLSearchParams({ said }).toString(),
    });

  //--------------------------------------------------------------------------
  // The happy path, one stage at a time
  //--------------------------------------------------------------------------

  it('1. offers the next two stages on the page the acknowledge tap opens', async () => {
    const id = await reportAndDispatch();
    const page = await (await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`)).text();

    expect(page).toContain('Acknowledged');
    // The whole of M9-27: one approved button, and the page it opens carries the rest.
    expect(page).toContain('Mark as responded');
    expect(page).toContain('Mark as resolved');
    expect(await statusOf(id)).toBe('acknowledged');
  });

  it('2. records a response, and the incident moves without a status ever being set', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    const token = await mint(id, 'respond');
    const done = await post(token);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Recorded as responded');

    /**
     * `responding` is not a status anything assigns — it falls out of somebody having **done**
     * something. So what is written is an action, in the officer's name, and the fold moves
     * itself. A stage that could be claimed without an act would be a button saying work is
     * happening.
     */
    const events = await loadIncident(pool, id);
    const logged = events.filter((e) => e.type === 'action_logged');
    expect(logged).toHaveLength(1);
    expect(await statusOf(id)).toBe('responding');
    expect(stageOf('responding')).toBe('responded');
  });

  it('3. resolves with what the officer typed, and puts it on the record verbatim', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    const said = 'fire out, two taken to DHQ, crew stood down';
    const done = await post(await mint(id, 'resolve'), said);
    expect(done.status).toBe(200);

    const state = foldIncident(id, await loadIncident(pool, id));
    expect(state.status).toBe('resolved');
    // The district reads this back afterwards. A resolution recorded as "Resolved." is a closure
    // that answers nothing, which is why the page asks.
    expect(state.resolution).toBe(said);
  });

  //--------------------------------------------------------------------------
  // The adversarial half — M9-30
  //--------------------------------------------------------------------------

  it('4. a GET never records anything, because WhatsApp fetches links to preview them', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    const token = await mint(id, 'resolve');
    // Twice, as a crawler and then a human might.
    const first = await fetch(`${base}/ack/${token}`);
    await fetch(`${base}/ack/${token}`);

    expect(first.status).toBe(200);
    expect(await first.text()).toContain('Mark this as resolved?');
    // Nothing moved, and the token is still spendable — which is the second half of the claim:
    // a preview must not consume the officer's one link either.
    expect(await statusOf(id)).toBe('acknowledged');

    expect((await post(token, 'fire out')).status).toBe(200);
    expect(await statusOf(id)).toBe('resolved');
  });

  it('5. refuses a replayed token, and says "already recorded" rather than failing', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    const token = await mint(id, 'respond');
    expect((await post(token)).status).toBe(200);

    const replay = await post(token);
    // Not an error. The officer did nothing wrong, and a red page at 02:00 sends them to the
    // telephone to ask what broke.
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('Already recorded');

    // And exactly one action was written, not two.
    const events = await loadIncident(pool, id);
    expect(events.filter((e) => e.type === 'action_logged')).toHaveLength(1);
  });

  it('6. attributes the act to whoever the token was minted for, never to the post now', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    // Minted for the night officer, who does not hold the post this emergency was sent to.
    const token = await mint(id, 'respond', { seatId: otherSeat, personId: otherPerson });
    expect((await post(token)).status).toBe(200);

    const logged = (await loadIncident(pool, id)).filter((e) => e.type === 'action_logged')[0];
    expect(logged?.actorPersonId).toBe(otherPerson);
    expect(logged?.actorSeatId).toBe(otherSeat);
    // The channel says how it arrived, which is what lets a report tell a link tap from typing.
    expect(logged?.sourceChannel).toBe('sms');
  });

  it('7. refuses to resolve on an empty box, and does not spend the link doing so', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    const token = await mint(id, 'resolve');
    const empty = await post(token, '   ');
    expect(await empty.text()).toContain('Say what happened first');
    expect(await statusOf(id)).toBe('acknowledged');

    // Burning the link on the officer's own blank box would leave them with nothing but the
    // control room's telephone number. It is still good.
    expect((await post(token, 'fire out')).status).toBe(200);
    expect(await statusOf(id)).toBe('resolved');
  });

  it('8. a link for a stage the incident has passed changes nothing and reads as done', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    // Minted while the emergency was live; tapped after a colleague resolved it.
    const late = await mint(id, 'respond');
    expect((await post(await mint(id, 'resolve'), 'handled by the night crew')).status).toBe(200);
    expect(await statusOf(id)).toBe('resolved');

    const page = await post(late);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Already recorded as responded');
    // The record did not go backwards.
    expect(await statusOf(id)).toBe('resolved');
  });

  it('9. will not acknowledge with a progress token, or progress with an acknowledge one', async () => {
    const id = await reportAndDispatch();

    // One path carries three kinds of token because the URL prefix is baked into an approved
    // Meta template. The stage on the token is the only thing that tells them apart, so it is
    // checked on redemption rather than trusted from the shape of the request.
    // ⚠️ **Asserted as UNCHANGED, not as a named status.** This said `routed`, which was true
    // while `reportAndDispatch()` also routed; since ADR-0030 it dispatches and nothing else,
    // because a dispatch is what places an emergency with somebody now. The claim here has
    // never been about which status the incident is in — it is that redeeming the WRONG stage
    // of token moves the record nowhere — so it is read before and compared after.
    const before = await statusOf(id);

    const respond = await mint(id, 'respond');
    const refused = await fetch(`${base}/ack/${respond}`);
    expect(await refused.text()).not.toContain('The control room can see');
    expect(await statusOf(id)).toBe(before);

    const ack = await mint(id, 'acknowledge');
    const wrongWay = await post(ack);
    expect(wrongWay.status).toBe(405);
    // And the acknowledge token was not spent by the attempt.
    expect((await fetch(`${base}/ack/${ack}`)).status).toBe(200);
    expect(await statusOf(id)).toBe('acknowledged');
  });

  it('10. offers nothing further once an emergency is resolved', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);
    await post(await mint(id, 'resolve'), 'fire out');

    // A second officer taps their own acknowledge link afterwards. They are still acknowledged
    // — the ledger records that they read it — but there is nothing left for them to record.
    const page = await (await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`)).text();
    expect(page).not.toContain('Mark as responded');
    expect(page).not.toContain('Mark as resolved');
  });

  it('11. an unknown token is told apart from an expired one', async () => {
    const unknown = await fetch(`${base}/ack/${'x'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    // Two sentences, not one "invalid" — they send an officer to two different next actions.
    expect(await unknown.text()).toContain('not recognised');

    const id = await reportAndDispatch();
    const stale = await mint(id, 'resolve');
    // Hashed here rather than in SQL: `digest()` is pgcrypto, which this database does not
    // install, and the store hashes in Node for exactly the same reason.
    await pool.query(
      `UPDATE ack_token SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`,
      [createHash('sha256').update(stale).digest()],
    );
    const expired = await fetch(`${base}/ack/${stale}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('too old');
  });
});
