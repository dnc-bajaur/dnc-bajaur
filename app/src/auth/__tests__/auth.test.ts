/**
 * INV-05: the UI is never the enforcement layer.
 *
 * Every refusal below is tested by direct HTTP call. Nothing here goes through a browser,
 * because a control that only holds when you use the app is not a control at all — an
 * attacker uses curl.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../../api/server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { loadIncident } from '../../db/eventStore.js';
import { hashPassword, verifyPassword, assertUsable } from '../passwords.js';
import {
  login,
  resolveSession,
  revokeAllForPerson,
  revokeSession,
  type LoginAttempt,
} from '../sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword('duty-officer-2027', hash)).toBe(false);
  });

  it('produces a different hash each time', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('returns false for a corrupted stored hash instead of throwing', async () => {
    // A bad row must not become a way to crash the login endpoint.
    for (const bad of ['', 'garbage', 'scrypt$x$y$z$q$r', 'scrypt$16384$8$1$!!!$!!!']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('never accepts a password against a zero-length or stunted key', async () => {
    // The hole this pins: base64-decoding garbage can produce an empty buffer, scrypt
    // asked for a zero-length key returns an empty buffer, and timingSafeEqual(empty,
    // empty) is true — so one corrupted row would have accepted ANY password.
    const empties = [
      'scrypt$16384$8$1$!!!$!!!',
      'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$',
      `scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(8).toString('base64')}`,
    ];

    for (const stored of empties) {
      expect(await verifyPassword(PASSWORD, stored)).toBe(false);
      expect(await verifyPassword('literally anything', stored)).toBe(false);
      expect(await verifyPassword('', stored)).toBe(false);
    }
  });

  it('rejects absurd scrypt parameters rather than trying to honour them', async () => {
    const salt = Buffer.alloc(16).toString('base64');
    const key = Buffer.alloc(32).toString('base64');
    expect(await verifyPassword(PASSWORD, `scrypt$1$8$1$${salt}$${key}`)).toBe(false);
    expect(await verifyPassword(PASSWORD, `scrypt$16384$0$1$${salt}$${key}`)).toBe(false);
  });

  it('refuses passwords that are too short or absurdly long', () => {
    expect(() => assertUsable('short')).toThrow();
    expect(() => assertUsable('x'.repeat(600))).toThrow();
    expect(() => assertUsable('a-reasonable-one')).not.toThrow();
  });
});

describe.skipIf(dbUrl === undefined)('authentication (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueSeat: string;
  let policeSeat: string;
  let dcSeat: string;

  let rescuePerson: string;
  let policePerson: string;

  let rescuePhone: string;
  let policePhone: string;
  let seatlessPhone: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // ADR-0030 — the two departments these seats used to sit in are gone with the table. What
    // this file is about is untouched: a session resolves a SEAT, and losing a post loses the
    // authority with it (ADR-0004).
    rescueSeat = await makeSeat('Rescue 1122 Station In-Charge', 'station', false);
    policeSeat = await makeSeat('SHO Bajaur City', 'station', false);
    dcSeat = await makeSeat('Deputy Commissioner Bajaur', 'district', true);

    const suffix = randomUUID().slice(0, 8);
    rescuePhone = `+9230000${suffix}`;
    policePhone = `+9230001${suffix}`;
    seatlessPhone = `+9230002${suffix}`;

    rescuePerson = await makePerson('Rescue Duty Officer', rescuePhone);
    policePerson = await makePerson('Police Duty Officer', policePhone);
    // Deliberately given no duty assignment: authenticated, but holding no seat.
    await makePerson('Transferred Officer', seatlessPhone);

    await assign(rescueSeat, rescuePerson);
    await assign(policeSeat, policePerson);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(title: string, tier: string, breakGlass: boolean): Promise<string> {
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

  async function makePerson(name: string, phone: string): Promise<string> {
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    return res.rows[0]!.person_id;
  }

  async function assign(seatId: string, personId: string): Promise<void> {
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      personId,
    ]);
  }

  async function tokenFor(phone: string): Promise<string> {
    const result = await login(pool, phone, PASSWORD);
    expect(result).not.toBeNull();
    return result!.token;
  }

  function push(token: string | null, events: unknown[]): Promise<Response> {
    return fetch(`${base}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ deviceId: randomUUID(), events }),
    });
  }

  function reportEvent(incidentId: string, claimedSeat: string | null = null): unknown {
    return {
      eventId: randomUUID(),
      incidentId,
      type: 'reported',
      occurredAt: new Date().toISOString(),
      clientSeq: 1,
      actorPersonId: claimedSeat === null ? null : randomUUID(),
      actorSeatId: claimedSeat,
      sourceChannel: 'mobile',
      payload: { reportId: randomUUID(), category: 'rta', severity: 'critical' },
    };
  }

  describe('the door is shut by default', () => {
    it('refuses an unauthenticated push', async () => {
      const res = await push(null, [reportEvent(randomUUID())]);
      expect(res.status).toBe(401);
    });

    it('refuses an unauthenticated pull', async () => {
      expect((await fetch(`${base}/sync?cursor=0`)).status).toBe(401);
    });

    it('refuses a garbage token', async () => {
      expect((await push('not-a-real-token', [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('refuses an absurdly long token without hitting the database hard', async () => {
      expect((await push('x'.repeat(5000), [])).status).toBe(401);
    });

    it('nothing was stored by any of those attempts', async () => {
      const incidentId = randomUUID();
      await push(null, [reportEvent(incidentId)]);
      await push('bogus', [reportEvent(incidentId)]);
      expect(await loadIncident(pool, incidentId)).toHaveLength(0);
    });
  });

  describe('login', () => {
    it('issues a session for correct credentials', async () => {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: PASSWORD }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; identity: { seatId: string } };
      expect(body.token).toBeTruthy();
      expect(body.identity.seatId).toBe(rescueSeat);
    });

    it('sets an HttpOnly, SameSite=Strict cookie', async () => {
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: PASSWORD }),
      });

      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    });

    it('gives the same answer for a wrong password and an unknown number', async () => {
      // Distinguishing them hands an attacker the list of real officers.
      const wrongPassword = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: 'wrong-password-here' }),
      });
      const unknownNumber = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+923009999999', password: PASSWORD }),
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownNumber.status).toBe(401);
      expect(await wrongPassword.json()).toEqual(await unknownNumber.json());
    });

    it('refuses a disabled account', async () => {
      const phone = `+92300444${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Suspended Officer', phone);
      await assign(await makeSeat('Temp', 'station', false), personId);

      expect(await login(pool, phone, PASSWORD)).not.toBeNull();
      await pool.query('UPDATE person SET disabled_at = now() WHERE person_id = $1', [personId]);
      expect(await login(pool, phone, PASSWORD)).toBeNull();
    });

    /**
     * 🔴 **THIS LOCKED BAJAUR'S CONTROL ROOM OUT OF ITS OWN SYSTEM — 2026-08-27.**
     *
     * Two accounts were created for the district, verified from `curl`, and then refused from
     * the browser minutes later with "Phone number or password is not correct", which was true
     * of neither. `WHERE phone = $1` is a byte comparison, and the number had been copied out
     * of a message. One invisible space is not a wrong number.
     */
    it('accepts the number written the way a person actually pastes it', async () => {
      const phone = `03005${randomUUID().replace(/\D/g, '').slice(0, 6).padEnd(6, '0')}`;
      const personId = await makePerson('Pasted Number Officer', phone);
      await assign(await makeSeat('Paste Test', 'station', false), personId);

      const spellings = [
        phone,
        ` ${phone} `,
        `${phone}\n`,
        `${phone.slice(0, 4)}-${phone.slice(4)}`,
        `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`,
        `+92${phone.slice(1)}`,
        `92${phone.slice(1)}`,
      ];

      for (const typed of spellings) {
        const result = await login(pool, typed, PASSWORD);
        expect(result, `refused ${JSON.stringify(typed)}`).not.toBeNull();
        expect(result!.identity.fullName).toBe('Pasted Number Officer');
      }
    });

    it('refuses rather than guessing when two accounts write one number differently', async () => {
      // Tolerance is not the same as ambiguity. If the loosened match finds two accounts and
      // neither was typed exactly, picking one would sign somebody in AS SOMEBODY ELSE — which
      // is a worse failure than the lockout this tolerance exists to prevent.
      const digits = `03007${randomUUID().replace(/\D/g, '').slice(0, 6).padEnd(6, '0')}`;
      const dashed = `${digits.slice(0, 4)}-${digits.slice(4)}`;

      const a = await makePerson('Twin A', digits);
      const b = await makePerson('Twin B', dashed);
      await assign(await makeSeat('Twin A Post', 'station', false), a);
      await assign(await makeSeat('Twin B Post', 'station', false), b);

      // Either exact spelling still signs in its own holder — an exact match always wins.
      expect((await login(pool, digits, PASSWORD))?.identity.fullName).toBe('Twin A');
      expect((await login(pool, dashed, PASSWORD))?.identity.fullName).toBe('Twin B');

      // A third spelling matches both and is refused.
      expect(await login(pool, `${digits.slice(0, 4)} ${digits.slice(4)}`, PASSWORD)).toBeNull();
    });

    it('records why a sign-in was refused, and records no credential', async () => {
      // The district could not see why its own door was shut. This is what it now records —
      // and the test pins what it must NEVER record alongside it.
      const seen: LoginAttempt[] = [];
      const attempted = 'not-the-password';

      await login(pool, '03009999999', attempted, (a) => seen.push(a));
      await login(pool, rescuePhone, attempted, (a) => seen.push(a));

      expect(seen.map((a) => a.reason)).toEqual(['no-account', 'wrong-password']);
      expect(seen.map((a) => a.accountFound)).toEqual([false, true]);
      expect(seen.every((a) => a.submittedLength === attempted.length)).toBe(true);

      const written = JSON.stringify(seen);
      expect(written).not.toContain(attempted);
      expect(written).not.toContain(rescuePhone);
    });

    it('records nothing when the credentials are correct', async () => {
      const seen: LoginAttempt[] = [];
      expect(await login(pool, rescuePhone, PASSWORD, (a) => seen.push(a))).not.toBeNull();
      expect(seen).toEqual([]);
    });
  });

  describe('impersonation is impossible', () => {
    it('discards the actor identity the client claims', async () => {
      // The hole this closes: without server-side stamping, any authenticated user could
      // submit an event claiming to be the DC seat, and the audit trail — which IS the
      // record — would faithfully preserve the lie.
      const incidentId = randomUUID();
      const token = await tokenFor(rescuePhone);

      const res = await push(token, [reportEvent(incidentId, dcSeat)]);
      expect(res.status).toBe(200);

      const [stored] = await loadIncident(pool, incidentId);
      expect(stored!.actorSeatId).toBe(rescueSeat);
      expect(stored!.actorSeatId).not.toBe(dcSeat);
      expect(stored!.actorPersonId).toBe(rescuePerson);
    });

    it('stamps identity even when the client sends none', async () => {
      const incidentId = randomUUID();
      const token = await tokenFor(policePhone);

      await push(token, [reportEvent(incidentId)]);

      const [stored] = await loadIncident(pool, incidentId);
      expect(stored!.actorSeatId).toBe(policeSeat);
      expect(stored!.actorPersonId).toBe(policePerson);
    });
  });

  /**
   * The guarantee the throttle exists to keep, asserted over real HTTP.
   *
   * `throttle.test.ts` proves the arithmetic. This proves the thing that matters at 02:00:
   * after a sustained run of wrong passwords against a named officer's number, **that officer
   * can still sign in.** If this ever fails, somebody has turned the delay into a lockout, and
   * the district's semi-public numbers have become a way to take duty officers offline one at
   * a time.
   */
  describe('guessing is slowed, never blocked', () => {
    it('lets the real officer in after a sustained run of wrong passwords', async () => {
      // Ten, not a hundred. Each further failure costs more, so a longer run in a test
      // measures the delay curve rather than the property under test — and the property is
      // binary: does the officer still get in.
      for (let i = 0; i < 10; i += 1) {
        const wrong = await fetch(`${base}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone: rescuePhone, password: `wrong-${String(i)}` }),
        });
        expect(wrong.status).toBe(401);
      }

      const started = Date.now();
      const real = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: rescuePhone, password: PASSWORD }),
      });
      const waited = Date.now() - started;

      expect(real.status).toBe(200);
      expect(((await real.json()) as { token: string }).token.length).toBeGreaterThan(0);

      /**
       * "Not a lockout", stated as a number.
       *
       * A delay with no ceiling is a lockout wearing a different name — an officer facing four
       * minutes at 02:00 has been locked out in every sense that matters. This is the ceiling,
       * asserted where somebody changing the constants will see it fail.
       */
      expect(waited).toBeLessThan(8_000);
    }, 60_000);

    it('still says nothing about which numbers are real', async () => {
      // The delay attaches to the attempt, never to whether the account exists — so a
      // throttled unknown number and a throttled real one answer identically.
      const unknown = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+920000000000', password: 'nope' }),
      });

      expect(unknown.status).toBe(401);
      expect((await unknown.json()) as { error: string }).toEqual({ error: 'invalid credentials' });
    });
  });

  describe('authority is the access role, not a duty seat (ADR-0032)', () => {
    /**
     * The old rule was ADR-0004's: authority came from the seat, so an account holding no
     * `duty_assignment` could sign in and do nothing. That held while every account was an
     * officer's. ADR-0018/0024 leave the control room as the only thing that signs in,
     * ADR-0030 removes the departments there was anything to scope between, and ADR-0032
     * mints every account by `role` with no seat. A seatless authenticated account **is** the
     * control room now, and reads and reports on the district. Asserted by direct HTTP (INV-05).
     */
    it('an authenticated account with no duty seat may push what it captured', async () => {
      const token = await tokenFor(seatlessPhone);

      const me = await fetch(`${base}/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { identity: { seatId: null } }).identity.seatId).toBeNull();

      const res = await push(token, [reportEvent(randomUUID())]);
      expect(res.status).toBe(200);
    });

    it('serves the dashboard to a seatless account, scoped to the district', async () => {
      const token = await tokenFor(seatlessPhone);

      const res = await fetch(`${base}/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { scope: string }).scope).toBe('District');
    });

    it('serves the status screen to a seatless account', async () => {
      const token = await tokenFor(seatlessPhone);

      const res = await fetch(`${base}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
    });

    it('still serves the dashboard to a seat that holds no department', async () => {
      // A control-room post belongs to no department and the district *is* its work.
      const phone = `+92300777${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Control Room Officer', phone);
      await assign(dcSeat, personId);

      const res = await fetch(`${base}/dashboard`, {
        headers: { authorization: `Bearer ${await tokenFor(phone)}` },
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { scope: string }).scope).toBe('District');
    });

    it('a handover leaves an account able to act; suspending it in Settings is what removes access', async () => {
      const phone = `+92300555${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Reassigned Officer', phone);
      const seatId = await makeSeat('Relief Post', 'station', false);
      await assign(seatId, personId);

      const token = await tokenFor(phone);
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(200);

      // The seat is handed over. Access is the account's role now (ADR-0032), not the post,
      // so the account is still the control room and can still act.
      await pool.query(
        'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
        [personId],
      );
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(200);

      // Cutting an account off is a deliberate act in Settings — suspend, remove, or force
      // sign-out — and it takes effect on the very next request with nothing to clean up.
      await pool.query('UPDATE person SET suspended_at = now() WHERE person_id = $1', [personId]);
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(401);
    });
  });

  /**
   * M10-05 found three people in the live directory holding two posts at once (Imran, Naveed,
   * Zubair Ahmad). `resolveIdentity`'s query joins `duty_assignment` on `to_at IS NULL`, which
   * genuinely returns one row per held seat — and it had always taken the first without an
   * `ORDER BY`, so which of a dual-post person's two seats they signed in as was whatever order
   * Postgres felt like giving back, and could differ request to request for the SAME person.
   */
  describe('a person holding two seats resolves to one, deterministically', () => {
    it('always picks the seat held longest, not whichever Postgres returns first', async () => {
      const phone = `+92300888${randomUUID().slice(0, 6)}`;
      const personId = await makePerson('Dual-Post Officer', phone);
      const olderSeat = await makeSeat('Older Post', 'station', false);
      const newerSeat = await makeSeat('Newer Post', 'station', false);

      // Explicit, clearly-ordered from_at — never rely on two inserts landing in different
      // real-clock milliseconds, which is exactly the kind of test this project has a standing
      // lesson about (CLAUDE.md: `Date.now() ± N` races). Inserted NEWER-FIRST, deliberately —
      // an unordered query tends to return rows in insertion (heap) order, so if this test
      // inserted the older seat first, an unfixed query could pass "by luck", proving nothing.
      await pool.query(
        `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())`,
        [newerSeat, personId],
      );
      await pool.query(
        `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now() - interval '2 days')`,
        [olderSeat, personId],
      );

      const token = await tokenFor(phone);
      const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(me.status).toBe(200);
      const identity = ((await me.json()) as { identity: { seatId: string } }).identity;

      // The same answer every time, and it names the older seat — never the newer one, and
      // never whichever the last poll happened to return.
      for (let i = 0; i < 5; i += 1) {
        const again = await fetch(`${base}/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const seatId = ((await again.json()) as { identity: { seatId: string } }).identity.seatId;
        expect(seatId).toBe(olderSeat);
      }
      expect(identity.seatId).toBe(olderSeat);
      expect(identity.seatId).not.toBe(newerSeat);
    });
  });

  describe('revocation is instant', () => {
    it('a revoked session stops working immediately', async () => {
      const token = await tokenFor(rescuePhone);
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(200);

      await revokeSession(pool, token);

      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(401);
      expect(await resolveSession(pool, token)).toBeNull();
    });

    it('logout revokes the session it was called with', async () => {
      const token = await tokenFor(rescuePhone);
      await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await push(token, [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('a compromised account can have every session killed at once', async () => {
      const a = await tokenFor(policePhone);
      const b = await tokenFor(policePhone);

      const killed = await revokeAllForPerson(pool, policePerson);
      expect(killed).toBeGreaterThanOrEqual(2);

      expect((await push(a, [reportEvent(randomUUID())])).status).toBe(401);
      expect((await push(b, [reportEvent(randomUUID())])).status).toBe(401);
    });

    it('an expired session is refused', async () => {
      const token = await tokenFor(rescuePhone);
      await pool
        .query(
          `UPDATE session SET expires_at = now() - interval '1 minute'
          WHERE token_hash = decode(encode(digest($1, 'sha256'), 'hex'), 'hex')`,
          [token],
        )
        .catch(async () => {
          // pgcrypto may not be installed; expire every session for this person instead.
          await pool.query(
            `UPDATE session SET expires_at = now() - interval '1 minute' WHERE person_id = $1`,
            [rescuePerson],
          );
        });

      expect(await resolveSession(pool, token)).toBeNull();
    });
  });

  describe('the session token is never stored in the clear', () => {
    it('the raw token does not appear in the session table', async () => {
      const token = await tokenFor(rescuePhone);
      const res = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'`,
        [token],
      );
      expect(Number(res.rows[0]!.n)).toBe(0);
    });
  });
});
