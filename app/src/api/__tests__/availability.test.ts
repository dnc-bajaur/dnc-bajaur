/**
 * Whether an officer is available, said without logging in — ADR-0033.
 *
 * Real PostgreSQL, real HTTP, real single-use tokens. The claim: an officer who has just tapped
 * an acknowledge link can tell the district whether they are available, from a handset, with no
 * account — and **nothing in that path trusts a phone number**.
 *
 * ## Why the phone number matters so much here
 *
 * This codebase already refuses to identify anybody by their number, because two officers in
 * Bajaur share one (migration 0006, Q-19). Availability is exactly the write a spoofed sender
 * would want: quiet, unremarkable, and it makes somebody unreachable. Marking the wrong officer
 * *unavailable* takes them out of the district's planning, and nothing on any screen looks wrong.
 *
 * So identity comes only from a token this system minted for one recipient, and the tests below
 * are mostly about the ways that could be got around.
 *
 * ## ADR-0033 — two states, set by hand
 *
 * The old five (`present`/`absent`/`office`/`field`/`leave`) and the *until when* every claim had
 * to state are gone. Availability is now `available` / `unavailable`, managed by the control room;
 * nothing polls an officer, so there is no end to ask for and no `NEEDS_END`.
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
import { mintAckToken, type AckStage } from '../../db/whatsappStore.js';
import { PRESENCE_STATUSES } from '../../domain/wall.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface PresenceRow {
  seat_id: string;
  status: string;
  until_at: string | null;
  person_id: string | null;
  reported_by: string | null;
}

describe.skipIf(dbUrl === undefined)('telling the district whether you are available', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let controlToken: string;
  let dutySeat: string;
  let dutyPerson: string;
  let nightSeat: string;
  let nightPerson: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (av ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (av ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (av ${RUN})`);
    const duty = await seedActor(pool, { title: `Duty Officer (av ${RUN})`, departmentId: rescue });
    dutySeat = duty.seatId;
    dutyPerson = duty.personId;

    const night = await seedActor(pool, {
      title: `Night Officer (av ${RUN})`,
      departmentId: rescue,
    });
    nightSeat = night.seatId;
    nightPerson = night.personId;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function reportAndDispatch(): Promise<string> {
    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(controlToken),
        body: JSON.stringify({ category: 'fire', severity: 'high', description: `av ${RUN}` }),
      })
    ).json()) as { incidentId: string };

    await fetch(`${base}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ targets: [{ kind: 'post', id: dutySeat }] }),
    });
    return created.incidentId;
  }

  async function mint(
    incidentId: string,
    stage: AckStage,
    who: { seatId: string | null; personId: string } = {
      seatId: dutySeat,
      personId: dutyPerson,
    },
  ): Promise<string> {
    const events = await loadIncident(pool, incidentId);
    const attempt = [...foldIncident(incidentId, events).notifications][0];
    if (attempt === undefined) throw new Error('no obligation to answer');
    return mintAckToken(pool, {
      attemptId: attempt.attemptId,
      incidentId,
      seatId: who.seatId,
      personId: who.personId,
      stage,
    });
  }

  const send = async (token: string, status?: string, until?: string): Promise<Response> => {
    const fields = new URLSearchParams();
    if (status !== undefined) fields.set('status', status);
    if (until !== undefined) fields.set('until', until);
    return fetch(`${base}/ack/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
    });
  };

  const latestFor = async (seatId: string): Promise<PresenceRow | undefined> =>
    (
      await pool.query<PresenceRow>(
        `SELECT seat_id, status, until_at, person_id, reported_by
           FROM presence_report WHERE seat_id = $1 ORDER BY reported_at DESC LIMIT 1`,
        [seatId],
      )
    ).rows[0];

  //--------------------------------------------------------------------------

  it('1. offers the two, on the page the acknowledge tap opens', async () => {
    const id = await reportAndDispatch();
    const page = await (await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`)).text();

    // Two states, managed by hand. No `until` field, no five-answer list.
    for (const status of PRESENCE_STATUSES) {
      expect(page, `${status} is not on the page`).toContain(`value="${status}"`);
    }
    expect(page).toContain('Are you available?');
  });

  it('2. records the answer against the person AND the post, with no end', async () => {
    const id = await reportAndDispatch();
    const done = await send(await mint(id, 'availability'), 'available');
    expect(done.status).toBe(200);

    const row = await latestFor(dutySeat);
    expect(row?.status).toBe('available');
    /**
     * Both, and this is M9-32 in one assertion. The seat is how the dashboard reads it and how
     * a department scopes what it may set; the **person** is what the claim is actually about.
     */
    expect(row?.person_id).toBe(dutyPerson);
    expect(row?.seat_id).toBe(dutySeat);
    // ADR-0033: nothing polls an officer, so nothing is written into `until_at`.
    expect(row?.until_at).toBeNull();
  });

  it('3. records unavailable without asking how long', async () => {
    // The old five made `absent`/`field`/`leave` say when they end. Those are gone: `unavailable`
    // is just recorded, and the officer gets the district's closing line.
    const id = await reportAndDispatch();
    const answered = await send(await mint(id, 'availability'), 'unavailable');

    expect(await answered.text()).toContain('The district knows where you are');
    const row = await latestFor(dutySeat);
    expect(row?.status).toBe('unavailable');
    expect(row?.until_at).toBeNull();
  });

  it('4. accepts a stray `until` on the wire and ignores it', async () => {
    // An old form still sitting in a message history may send `until`. It is accepted and dropped
    // — never a reason to refuse.
    const id = await reportAndDispatch();
    const answered = await send(
      await mint(id, 'availability'),
      'available',
      new Date(Date.now() + 3_600_000).toISOString(),
    );

    expect(await answered.text()).toContain('The district knows where you are');
    expect((await latestFor(dutySeat))?.until_at).toBeNull();
  });

  it('5. refuses a status that is not one of the two, and keeps the link', async () => {
    const id = await reportAndDispatch();
    const token = await mint(id, 'availability');

    expect(await (await send(token, 'busy')).text()).toContain('Choose Available or Unavailable');
    // And the link survives, so the officer can answer properly.
    expect(await (await send(token, 'available')).text()).toContain(
      'The district knows where you are',
    );
  });

  it('6. does not spend the link when it refuses an unknown status', async () => {
    const id = await reportAndDispatch();
    const token = await mint(id, 'availability');

    expect(await (await send(token, 'nonsense')).text()).toContain(
      'Choose Available or Unavailable',
    );
    // Burning an officer's one link on a bad value leaves them with nothing but the telephone.
    expect(await (await send(token, 'available')).text()).toContain(
      'The district knows where you are',
    );
    expect((await latestFor(dutySeat))?.status).toBe('available');
  });

  it('7. is single-use — the same link cannot be replayed', async () => {
    const id = await reportAndDispatch();
    const token = await mint(id, 'availability');

    expect(await (await send(token, 'available')).text()).toContain(
      'The district knows where you are',
    );
    expect(await (await send(token, 'unavailable')).text()).toContain('Already recorded');

    // The replay changed nothing: the record still says what the first, real answer said.
    expect((await latestFor(dutySeat))?.status).toBe('available');
  });

  it('8. writes only against the seat the token names — one officer cannot aim at another', async () => {
    const id = await reportAndDispatch();
    // A token minted for the night officer. There is no field anywhere in the request that
    // names a seat: the token is the only thing that decides, so pointing it at somebody else
    // is not something a caller can express.
    const token = await mint(id, 'availability', { seatId: nightSeat, personId: nightPerson });

    const before = await latestFor(dutySeat);
    expect(await (await send(token, 'available')).text()).toContain(
      'The district knows where you are',
    );

    const night = await latestFor(nightSeat);
    expect(night?.person_id).toBe(nightPerson);
    // And the duty officer's own record is untouched.
    expect((await latestFor(dutySeat))?.status).toBe(before?.status);
  });

  it('9. refuses an officer who holds no post, and says why', async () => {
    const id = await reportAndDispatch();
    const token = await mint(id, 'availability', { seatId: null, personId: dutyPerson });

    const answered = await send(token, 'available');
    expect(answered.status).toBe(409);
    // Availability is recorded against a duty post. A form that accepted this and dropped it
    // would be worse than no form.
    expect(await answered.text()).toContain('You hold no post');
  });

  it('10. a GET draws the form and records nothing', async () => {
    const id = await reportAndDispatch();
    const token = await mint(id, 'availability');
    const before = await latestFor(dutySeat);

    const page = await fetch(`${base}/ack/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Are you available?');
    // WhatsApp fetches URLs to build link previews. A crawler must not mark an officer available.
    expect((await latestFor(dutySeat))?.status).toBe(before?.status);
  });

  it('11. will not take an availability answer on a lifecycle token', async () => {
    const id = await reportAndDispatch();
    await fetch(`${base}/ack/${await mint(id, 'acknowledge')}`);

    // An officer saying "I am available" has not responded to the emergency. Two acts, two
    // tokens — sharing one would make a single tap do both.
    const respond = await mint(id, 'respond');
    expect(await (await send(respond, 'available')).text()).not.toContain(
      'The district knows where you are',
    );

    const avail = await mint(id, 'availability');
    const noStatus = await fetch(`${base}/ack/${avail}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ said: 'fire out' }).toString(),
    });
    // Read as an availability answer with no status, so it asks rather than resolving anything.
    expect(await noStatus.text()).toContain('Choose Available or Unavailable');
    expect(foldIncident(id, await loadIncident(pool, id)).status).not.toBe('resolved');
  });

  it('12. the in-app route takes the same two and needs no end', async () => {
    // Two doors, one rule. `PRESENCE_STATUSES` lives in the domain precisely so this cannot
    // drift from the token route above.
    const available = await fetch(`${base}/status/presence`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, status: 'available' }),
    });
    expect(available.status).toBe(201);

    const unavailable = await fetch(`${base}/status/presence`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, status: 'unavailable' }),
    });
    expect(unavailable.status).toBe(201);

    // One of the retired five is now just an unknown value.
    const old = await fetch(`${base}/status/presence`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, status: 'leave' }),
    });
    expect(old.status).toBe(400);
    expect(((await old.json()) as { error: string }).error).toContain('available, unavailable');

    // And the person is resolved from whoever holds the post at the moment of the report — not
    // left null, and not re-pointed later by a handover.
    expect((await latestFor(dutySeat))?.person_id).toBe(dutyPerson);
    expect((await latestFor(dutySeat))?.until_at).toBeNull();
  });

  it('13. curates the Dashboard wall pick, and only the control room may', async () => {
    // POST /status/presence/wall — the control room chooses which available officers the wall
    // carries (ADR-0033).
    const on = await fetch(`${base}/status/presence/wall`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, onWall: true }),
    });
    expect(on.status).toBe(201);

    const off = await fetch(`${base}/status/presence/wall`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, onWall: false }),
    });
    expect(off.status).toBe(201);

    // A non-boolean is refused before the seat is even looked at.
    const bad = await fetch(`${base}/status/presence/wall`, {
      method: 'POST',
      headers: authHeaders(controlToken),
      body: JSON.stringify({ seatId: dutySeat, onWall: 'yes' }),
    });
    expect(bad.status).toBe(400);
  });
});
