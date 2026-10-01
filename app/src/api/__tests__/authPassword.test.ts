/**
 * `POST /auth/password`, login events, and a suspended account — ADR-0032 phase 1.
 *
 * Every refusal is a direct HTTP call (INV-05). What is pinned:
 *
 *   * a signed-in account changes its own password with the current one;
 *   * a wrong current password, or a too-short new one, is refused and nothing changes;
 *   * a password change revokes every OTHER session and keeps the caller's;
 *   * `must_change_password` is cleared by a successful change;
 *   * every login writes an `access_event` — `login_succeeded`, or `login_failed` with a
 *     reason and no secret;
 *   * a suspended account cannot sign in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { hashPassword } from '../../auth/passwords.js';
import { login } from '../../auth/sessions.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const CURRENT = 'first-password-2026';
const NEXT = 'second-password-2026';

const maybe = dbUrl ? describe : describe.skip;

maybe('POST /auth/password and access events', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeAccount(opts: { mustChange?: boolean } = {}): Promise<{
    personId: string;
    phone: string;
  }> {
    const phone = `+92300${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, is_administration) VALUES ($1, 'post', false) RETURNING seat_id`,
      ['Test Duty Seat'],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, 'operator', $4) RETURNING person_id`,
      ['Test Officer', phone, await hashPassword(CURRENT), opts.mustChange ?? false],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    return { personId: person.rows[0]!.person_id, phone };
  }

  const changePassword = (token: string | null, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/auth/password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const eventsFor = async (
    personId: string,
    type?: string,
  ): Promise<Array<{ type: string; reason: string | null; after: unknown }>> => {
    const res = await pool.query<{ type: string; reason: string | null; after: unknown }>(
      `SELECT type, reason, after FROM access_event
        WHERE subject_person_id = $1 ${type ? 'AND type = $2' : ''}
        ORDER BY seq ASC`,
      type ? [personId, type] : [personId],
    );
    return res.rows;
  };

  it('rejects an unauthenticated call', async () => {
    const res = await changePassword(null, { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(401);
  });

  it('changes the password with the current one, and the new one then signs in', async () => {
    const { phone } = await makeAccount();
    const token = (await login(pool, phone, CURRENT))!.token;

    const res = await changePassword(token, { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);

    expect(await login(pool, phone, NEXT)).not.toBeNull();
    expect(await login(pool, phone, CURRENT)).toBeNull();
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const { phone } = await makeAccount();
    const token = (await login(pool, phone, CURRENT))!.token;

    const res = await changePassword(token, {
      currentPassword: 'not-the-current-one',
      newPassword: NEXT,
    });
    expect(res.status).toBe(400);
    expect(await login(pool, phone, CURRENT)).not.toBeNull();
  });

  it('refuses a new password below the minimum length', async () => {
    const { phone } = await makeAccount();
    const token = (await login(pool, phone, CURRENT))!.token;

    const res = await changePassword(token, {
      currentPassword: CURRENT,
      newPassword: 'short-11chr',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at least 12/);
    expect(await login(pool, phone, CURRENT)).not.toBeNull();
  });

  it('revokes every OTHER session and keeps the caller', async () => {
    const { phone } = await makeAccount();
    const staleToken = (await login(pool, phone, CURRENT))!.token;
    const callerToken = (await login(pool, phone, CURRENT))!.token;

    const meBefore = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${staleToken}` },
    });
    expect(meBefore.status).toBe(200);

    const res = await changePassword(callerToken, { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);

    const staleAfter = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${staleToken}` },
    });
    expect(staleAfter.status).toBe(401);

    const callerAfter = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(callerAfter.status).toBe(200);
  });

  it('clears must_change_password and writes a password_changed event', async () => {
    const { personId, phone } = await makeAccount({ mustChange: true });
    const token = (await login(pool, phone, CURRENT))!.token;

    const me = (await (
      await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { identity: { mustChangePassword: boolean; role: string } };
    expect(me.identity.mustChangePassword).toBe(true);
    expect(me.identity.role).toBe('operator');

    await changePassword(token, { currentPassword: CURRENT, newPassword: NEXT });

    const after = await pool.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM person WHERE person_id = $1',
      [personId],
    );
    expect(after.rows[0]!.must_change_password).toBe(false);
    expect((await eventsFor(personId, 'password_changed')).length).toBe(1);
  });

  it('writes login_succeeded on a good sign-in', async () => {
    const { personId, phone } = await makeAccount();
    await login(pool, phone, CURRENT);
    const rows = await eventsFor(personId, 'login_succeeded');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect((rows[0]!.after as { role: string }).role).toBe('operator');
  });

  it('writes login_failed with a reason and no secret on a wrong password', async () => {
    const { personId, phone } = await makeAccount();
    await login(pool, phone, 'the-wrong-password');
    const rows = await eventsFor(personId, 'login_failed');
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason).toBe('wrong-password');
    expect(JSON.stringify(rows[0]!.after)).not.toContain('the-wrong-password');
  });

  it('refuses a suspended account and records login_failed / suspended', async () => {
    const { personId, phone } = await makeAccount();
    await pool.query('UPDATE person SET suspended_at = now() WHERE person_id = $1', [personId]);

    expect(await login(pool, phone, CURRENT)).toBeNull();
    const rows = await eventsFor(personId, 'login_failed');
    expect(rows.some((r) => r.reason === 'suspended')).toBe(true);
  });
});
