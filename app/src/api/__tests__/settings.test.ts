/**
 * The Settings panel's account model — ADR-0032 phase 2, `api/settings.ts`.
 *
 * The whole matrix, over real HTTP (INV-05 — a refusal proven from outside the UI):
 *
 *   * each permission gates its own endpoint, and an `allow` / `deny` override folds on top —
 *     **deny wins**;
 *   * the `owner` row is untouchable from inside the app, an `admin` may not act on a peer
 *     `admin`, and nobody removes or suspends themselves;
 *   * ownership moves only by handover, which demotes the previous holder in the same breath;
 *   * suspend, reset-password, force-logout and remove all drop the account's live sessions;
 *   * every act appends its `access_event`, and the access log refuses a reader without
 *     `access_log.read`.
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
import type { Role } from '../../domain/roles.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PW = 'settings-test-password-2026';
const NEW_PW = 'settings-second-password-2026';

const maybe = dbUrl ? describe : describe.skip;

maybe('the Settings account model', () => {
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

  async function makeAccount(
    opts: { role?: Role; mustChange?: boolean } = {},
  ): Promise<{ personId: string; phone: string }> {
    const phone = `+92300${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, is_administration) VALUES ($1, 'post', false) RETURNING seat_id`,
      ['Settings Test Seat'],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5) RETURNING person_id`,
      [
        'Test Person',
        phone,
        await hashPassword(PW),
        opts.role ?? 'operator',
        opts.mustChange ?? false,
      ],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    return { personId: person.rows[0]!.person_id, phone };
  }

  const tokenFor = async (phone: string): Promise<string> => (await login(pool, phone, PW))!.token;

  const call = (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const eventsFor = async (
    subjectPersonId: string,
    type?: string,
  ): Promise<Array<{ type: string; reason: string | null }>> => {
    const res = await pool.query<{ type: string; reason: string | null }>(
      `SELECT type, reason FROM access_event
        WHERE subject_person_id = $1 ${type ? 'AND type = $2' : ''}
        ORDER BY seq ASC`,
      type ? [subjectPersonId, type] : [subjectPersonId],
    );
    return res.rows;
  };

  //--------------------------------------------------------------------------
  // The gate
  //--------------------------------------------------------------------------

  it('refuses an unauthenticated request', async () => {
    const res = await call('GET', '/settings/accounts', null);
    expect(res.status).toBe(401);
  });

  it('refuses an operator the account list (403)', async () => {
    const { phone } = await makeAccount({ role: 'operator' });
    const res = await call('GET', '/settings/accounts', await tokenFor(phone));
    expect(res.status).toBe(403);
  });

  it('lets the owner list accounts', async () => {
    const { phone } = await makeAccount({ role: 'owner' });
    const res = await call('GET', '/settings/accounts', await tokenFor(phone));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ role: string }>;
    expect(rows.some((r) => r.role === 'owner')).toBe(true);
  });

  //--------------------------------------------------------------------------
  // Create
  //--------------------------------------------------------------------------

  it('creates an operator, and it appears on the list with a granted event', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const token = await tokenFor(owner.phone);
    const phone = `+92311${randomUUID().slice(0, 7)}`;

    const made = await call('POST', '/settings/accounts', token, {
      fullName: 'New Operator',
      phone,
      role: 'operator',
      password: PW,
    });
    expect(made.status).toBe(201);
    const { personId } = (await made.json()) as { personId: string };

    const list = (await (await call('GET', '/settings/accounts', token)).json()) as Array<{
      personId: string;
      mustChangePassword: boolean;
    }>;
    const row = list.find((r) => r.personId === personId);
    expect(row).toBeDefined();
    expect(row!.mustChangePassword).toBe(true);

    expect((await eventsFor(personId, 'granted')).length).toBe(1);
  });

  it('refuses an operator the create endpoint (403)', async () => {
    const { phone } = await makeAccount({ role: 'operator' });
    const res = await call('POST', '/settings/accounts', await tokenFor(phone), {
      fullName: 'X',
      phone: `+9231${randomUUID().slice(0, 9)}`,
      role: 'operator',
      password: PW,
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin create an operator but not an admin', async () => {
    const admin = await makeAccount({ role: 'admin' });
    const token = await tokenFor(admin.phone);

    const asOperator = await call('POST', '/settings/accounts', token, {
      fullName: 'Op',
      phone: `+9232${randomUUID().slice(0, 9)}`,
      role: 'operator',
      password: PW,
    });
    expect(asOperator.status).toBe(201);

    const asAdmin = await call('POST', '/settings/accounts', token, {
      fullName: 'Ad',
      phone: `+9233${randomUUID().slice(0, 9)}`,
      role: 'admin',
      password: PW,
    });
    expect(asAdmin.status).toBe(403);
  });

  it('refuses a short password and a duplicate phone', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const token = await tokenFor(owner.phone);

    const short = await call('POST', '/settings/accounts', token, {
      fullName: 'Short',
      phone: `+9234${randomUUID().slice(0, 9)}`,
      role: 'operator',
      password: 'too-short',
    });
    expect(short.status).toBe(400);

    const dup = await call('POST', '/settings/accounts', token, {
      fullName: 'Dup',
      phone: owner.phone,
      role: 'operator',
      password: PW,
    });
    expect(dup.status).toBe(409);
  });

  //--------------------------------------------------------------------------
  // Member accounts and "Give login" — ADR-0038 §5, Bajaur
  //--------------------------------------------------------------------------

  /** A directory contact: a post and its holder, with no login — as `load-directory` makes. */
  async function makeContact(
    opts: { placeholder?: boolean } = {},
  ): Promise<{ personId: string; phone: string }> {
    const phone = `+92340${randomUUID().slice(0, 7)}`;
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier, is_administration) VALUES ($1, 'post', false) RETURNING seat_id`,
      ['Rescue 1122 Duty Officer'],
    );
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, $3) RETURNING person_id`,
      ['Contact Officer', phone, opts.placeholder ?? false],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    return { personId: person.rows[0]!.person_id, phone };
  }

  it('creates a member with a post, shown on the account list', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const token = await tokenFor(owner.phone);

    const made = await call('POST', '/settings/accounts', token, {
      fullName: 'TMA Officer',
      designation: 'Tehsil Municipal Officer',
      phone: `+92312${randomUUID().slice(0, 7)}`,
      role: 'member',
      password: PW,
    });
    expect(made.status).toBe(201);
    const { personId } = (await made.json()) as { personId: string };

    const list = (await (await call('GET', '/settings/accounts', token)).json()) as Array<{
      personId: string;
      role: string;
      designation: string | null;
    }>;
    const row = list.find((r) => r.personId === personId);
    expect(row?.role).toBe('member');
    expect(row?.designation).toBe('Tehsil Municipal Officer');
  });

  it('refuses a new account for a number already in the contact list (409)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const contact = await makeContact();

    const res = await call('POST', '/settings/accounts', await tokenFor(owner.phone), {
      fullName: 'Second Copy',
      phone: contact.phone,
      role: 'member',
      password: PW,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/contact list/);
  });

  it('gives a contact a login on the same row, which then signs in as a member', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const contact = await makeContact();

    const res = await call(
      'POST',
      `/settings/accounts/${contact.personId}/grant`,
      await tokenFor(owner.phone),
      { role: 'member', password: PW },
    );
    expect(res.status).toBe(201);

    const row = await pool.query<{
      role: string;
      must_change_password: boolean;
      designation: string | null;
      n: string;
    }>(
      `SELECT role, must_change_password, designation,
              (SELECT count(*) FROM person WHERE phone = $2) AS n
         FROM person WHERE person_id = $1`,
      [contact.personId, contact.phone],
    );
    expect(row.rows[0]).toMatchObject({
      role: 'member',
      must_change_password: true,
      designation: 'Rescue 1122 Duty Officer',
      n: '1',
    });
    expect(await login(pool, contact.phone, PW)).not.toBeNull();
    expect((await eventsFor(contact.personId, 'granted')).length).toBe(1);
  });

  it('refuses giving a login twice, to a stand-in, or by an operator', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const ownerToken = await tokenFor(owner.phone);

    const contact = await makeContact();
    const grant = (id: string, token: string): Promise<Response> =>
      call('POST', `/settings/accounts/${id}/grant`, token, { role: 'member', password: PW });

    expect((await grant(contact.personId, ownerToken)).status).toBe(201);
    expect((await grant(contact.personId, ownerToken)).status).toBe(409);

    const standIn = await makeContact({ placeholder: true });
    expect((await grant(standIn.personId, ownerToken)).status).toBe(400);

    const operator = await makeAccount({ role: 'operator' });
    const other = await makeContact();
    expect((await grant(other.personId, await tokenFor(operator.phone))).status).toBe(403);
  });

  it('applies the creation role rules to Give login', async () => {
    const admin = await makeAccount({ role: 'admin' });
    const contact = await makeContact();
    const token = await tokenFor(admin.phone);

    const asOwner = await call('POST', `/settings/accounts/${contact.personId}/grant`, token, {
      role: 'owner',
      password: PW,
    });
    expect(asOwner.status).toBe(400);

    const asAdmin = await call('POST', `/settings/accounts/${contact.personId}/grant`, token, {
      role: 'admin',
      password: PW,
    });
    expect(asAdmin.status).toBe(403);
  });

  //--------------------------------------------------------------------------
  // Role
  //--------------------------------------------------------------------------

  it('lets only the owner raise an account to admin, and writes role_changed', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const subject = await makeAccount({ role: 'operator' });

    const res = await call(
      'PATCH',
      `/settings/accounts/${subject.personId}/role`,
      await tokenFor(owner.phone),
      { role: 'admin' },
    );
    expect(res.status).toBe(200);
    expect((await eventsFor(subject.personId, 'role_changed')).length).toBe(1);
  });

  it("refuses an admin changing another admin's role (403)", async () => {
    const actor = await makeAccount({ role: 'admin' });
    const subject = await makeAccount({ role: 'admin' });
    const res = await call(
      'PATCH',
      `/settings/accounts/${subject.personId}/role`,
      await tokenFor(actor.phone),
      { role: 'operator' },
    );
    expect(res.status).toBe(403);
  });

  it('refuses demoting the owner (409)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const res = await call(
      'PATCH',
      `/settings/accounts/${owner.personId}/role`,
      await tokenFor(owner.phone),
      { role: 'admin' },
    );
    expect(res.status).toBe(409);
  });

  it('hands ownership over and demotes the previous holder', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const heir = await makeAccount({ role: 'admin' });
    const ownerToken = await tokenFor(owner.phone);

    const res = await call('PATCH', `/settings/accounts/${heir.personId}/role`, ownerToken, {
      role: 'owner',
    });
    expect(res.status).toBe(200);

    // The heir can now read the account list; the previous owner is an admin.
    expect((await call('GET', '/settings/accounts', await tokenFor(heir.phone))).status).toBe(200);
    const me = (await (
      await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${ownerToken}` } })
    ).json()) as { identity: { role: string } };
    expect(me.identity.role).toBe('admin');

    expect((await eventsFor(heir.personId, 'role_changed')).length).toBe(1);
    expect((await eventsFor(owner.personId, 'role_changed')).length).toBe(1);
  });

  //--------------------------------------------------------------------------
  // Overrides — deny wins
  //--------------------------------------------------------------------------

  it('an allow override grants a permission the role lacks, and clearing it removes it', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);
    const opToken = await tokenFor(op.phone);

    expect((await call('GET', '/settings/accounts', opToken)).status).toBe(403);

    expect(
      (
        await call('POST', `/settings/accounts/${op.personId}/permissions`, ownerToken, {
          permission: 'accounts.read',
          effect: 'allow',
        })
      ).status,
    ).toBe(200);
    expect((await call('GET', '/settings/accounts', opToken)).status).toBe(200);

    expect(
      (
        await call(
          'DELETE',
          `/settings/accounts/${op.personId}/permissions/accounts.read`,
          ownerToken,
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', '/settings/accounts', opToken)).status).toBe(403);
  });

  it('a deny override strips a permission the role has, and clearing it restores it', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const admin = await makeAccount({ role: 'admin' });
    const ownerToken = await tokenFor(owner.phone);
    const adminToken = await tokenFor(admin.phone);

    const attempt = (): Promise<Response> =>
      call('POST', '/settings/accounts', adminToken, {
        fullName: 'Op',
        phone: `+9235${randomUUID().slice(0, 9)}`,
        role: 'operator',
        password: PW,
      });

    expect((await attempt()).status).toBe(201);

    await call('POST', `/settings/accounts/${admin.personId}/permissions`, ownerToken, {
      permission: 'accounts.create',
      effect: 'deny',
    });
    expect((await attempt()).status).toBe(403);

    await call(
      'DELETE',
      `/settings/accounts/${admin.personId}/permissions/accounts.create`,
      ownerToken,
    );
    expect((await attempt()).status).toBe(201);
  });

  //--------------------------------------------------------------------------
  // Suspend / reset / force-logout / remove — all drop sessions
  //--------------------------------------------------------------------------

  it('suspend needs a reason, then freezes the account and drops its session', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);
    const opToken = await tokenFor(op.phone);

    const noReason = await call(
      'POST',
      `/settings/accounts/${op.personId}/suspend`,
      ownerToken,
      {},
    );
    expect(noReason.status).toBe(400);

    const done = await call('POST', `/settings/accounts/${op.personId}/suspend`, ownerToken, {
      reason: 'left the district',
    });
    expect(done.status).toBe(200);

    const stale = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(stale.status).toBe(401);
    expect(await login(pool, op.phone, PW)).toBeNull();
    expect((await eventsFor(op.personId, 'suspended')).length).toBe(1);

    const back = await call('POST', `/settings/accounts/${op.personId}/reactivate`, ownerToken);
    expect(back.status).toBe(200);
    expect(await login(pool, op.phone, PW)).not.toBeNull();
  });

  it('refuses suspending your own account (409)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const admin = await makeAccount({ role: 'admin' });
    const res = await call(
      'POST',
      `/settings/accounts/${admin.personId}/suspend`,
      await tokenFor(admin.phone),
      { reason: 'testing' },
    );
    expect(res.status).toBe(409);
    void owner;
  });

  it('reset-password forces a change, revokes sessions, and writes password_reset', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const opToken = await tokenFor(op.phone);

    const res = await call(
      'POST',
      `/settings/accounts/${op.personId}/reset-password`,
      await tokenFor(owner.phone),
      { newPassword: NEW_PW },
    );
    expect(res.status).toBe(200);

    const stale = await fetch(`${base}/auth/me`, {
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(stale.status).toBe(401);
    expect(await login(pool, op.phone, PW)).toBeNull();

    const fresh = await login(pool, op.phone, NEW_PW);
    expect(fresh).not.toBeNull();
    expect(fresh!.identity.mustChangePassword).toBe(true);
    expect((await eventsFor(op.personId, 'password_reset')).length).toBe(1);
  });

  it('force sign-out revokes every session and writes session_revoked', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const a = await tokenFor(op.phone);
    const b = await tokenFor(op.phone);

    const res = await call(
      'POST',
      `/settings/accounts/${op.personId}/force-logout`,
      await tokenFor(owner.phone),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionsRevoked: number };
    expect(body.sessionsRevoked).toBeGreaterThanOrEqual(2);

    for (const t of [a, b]) {
      const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${t}` } });
      expect(me.status).toBe(401);
    }
    expect((await eventsFor(op.personId, 'session_revoked')).length).toBe(1);
  });

  it('remove sets removed_at, refuses sign-in, and drops the account from the list', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);

    const noReason = await call('DELETE', `/settings/accounts/${op.personId}`, ownerToken, {});
    expect(noReason.status).toBe(400);

    const done = await call('DELETE', `/settings/accounts/${op.personId}`, ownerToken, {
      reason: 'account no longer needed',
    });
    expect(done.status).toBe(200);

    expect(await login(pool, op.phone, PW)).toBeNull();
    const list = (await (await call('GET', '/settings/accounts', ownerToken)).json()) as Array<{
      personId: string;
    }>;
    expect(list.some((r) => r.personId === op.personId)).toBe(false);
    expect((await eventsFor(op.personId, 'removed')).length).toBe(1);
  });

  it('a phone freed by removal can be given a new account (migration 0045)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const ownerToken = await tokenFor(owner.phone);
    const phone = `+92312${randomUUID().slice(0, 7)}`;

    const first = await call('POST', '/settings/accounts', ownerToken, {
      fullName: 'First Holder',
      phone,
      role: 'operator',
      password: PW,
    });
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { personId: string }).personId;

    const removed = await call('DELETE', `/settings/accounts/${firstId}`, ownerToken, {
      reason: 'wrong person',
    });
    expect(removed.status).toBe(200);

    // Before 0045 the removed row still held the phone's uniqueness slot, so this was a 409
    // for an account that no longer showed anywhere.
    const second = await call('POST', '/settings/accounts', ownerToken, {
      fullName: 'Second Holder',
      phone,
      role: 'operator',
      password: PW,
    });
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { personId: string }).personId;
    expect(secondId).not.toBe(firstId);

    const list = (await (await call('GET', '/settings/accounts', ownerToken)).json()) as Array<{
      personId: string;
    }>;
    expect(list.some((r) => r.personId === secondId)).toBe(true);
    expect(list.some((r) => r.personId === firstId)).toBe(false);

    // The number now signs in as the new account, never the ghost.
    const session = await login(pool, phone, PW);
    expect(session?.identity.personId).toBe(secondId);
  });

  it('refuses removing the owner, and removing yourself (409)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const admin = await makeAccount({ role: 'admin' });
    const adminToken = await tokenFor(admin.phone);

    const removeOwner = await call('DELETE', `/settings/accounts/${owner.personId}`, adminToken, {
      reason: 'trying it on',
    });
    expect(removeOwner.status).toBe(409);

    const removeSelf = await call('DELETE', `/settings/accounts/${admin.personId}`, adminToken, {
      reason: 'trying it on',
    });
    expect(removeSelf.status).toBe(409);
  });

  //--------------------------------------------------------------------------
  // The access log
  //--------------------------------------------------------------------------

  it('the access log lists events for a reader with access_log.read, and refuses one without', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);

    // Generate at least one event.
    await call('POST', `/settings/accounts/${op.personId}/force-logout`, ownerToken);

    const asOwner = await call('GET', '/settings/access-log', ownerToken);
    expect(asOwner.status).toBe(200);
    const body = (await asOwner.json()) as { rows: unknown[] };
    expect(body.rows.length).toBeGreaterThan(0);

    const asOperator = await call('GET', '/settings/access-log', await tokenFor(op.phone));
    expect(asOperator.status).toBe(403);
  });

  //--------------------------------------------------------------------------
  // Security policy — read-only (ADR-0032 phase 3)
  //--------------------------------------------------------------------------

  it('reports the security policy to the owner and refuses an operator (403)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });

    const asOwner = await call('GET', '/settings/security-policy', await tokenFor(owner.phone));
    expect(asOwner.status).toBe(200);
    const body = (await asOwner.json()) as {
      minPasswordLength: number;
      sessionTtlHours: number;
    };
    expect(body.minPasswordLength).toBe(12);
    expect(body.sessionTtlHours).toBe(12);

    const asOperator = await call('GET', '/settings/security-policy', await tokenFor(op.phone));
    expect(asOperator.status).toBe(403);
  });

  //--------------------------------------------------------------------------
  // Installation configuration — moved here from Administration (ADR-0032 phase 4)
  //--------------------------------------------------------------------------

  it('gates the dashboard wall on dashboard_layout.write', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);

    // The admin/owner role holds it; an operator holds none of the ADR-0032 permissions.
    expect((await call('GET', '/settings/dashboard-layout', ownerToken)).status).toBe(200);
    expect((await call('GET', '/settings/dashboard-layout', await tokenFor(op.phone))).status).toBe(
      403,
    );

    const saved = await call('PUT', '/settings/dashboard-layout', ownerToken, {
      layout: { panels: [{ id: 'keys', size: 'large' }] },
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { layout: { id: string }[]; isDefault: boolean };
    expect(body.layout.map((p) => p.id)).toEqual(['keys']);
    expect(body.isDefault).toBe(false);

    await pool.query('DELETE FROM dashboard_layout');
  });

  it('gates which screens are on, on capabilities.write', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const op = await makeAccount({ role: 'operator' });
    const ownerToken = await tokenFor(owner.phone);

    expect((await call('GET', '/settings/capabilities', ownerToken)).status).toBe(200);
    expect((await call('GET', '/settings/capabilities', await tokenFor(op.phone))).status).toBe(
      403,
    );

    const toggled = await call('POST', '/settings/capabilities', ownerToken, {
      capability: 'search',
      offered: true,
    });
    expect(toggled.status).toBe(200);
    const body = (await toggled.json()) as {
      capabilities: { id: string; offered: boolean }[];
    };
    expect(body.capabilities.find((c) => c.id === 'search')?.offered).toBe(true);

    await pool.query('DELETE FROM capability_state');
  });

  it('a deny override on dashboard_layout.write refuses an otherwise-admin (deny wins)', async () => {
    const owner = await makeAccount({ role: 'owner' });
    const admin = await makeAccount({ role: 'admin' });
    const ownerToken = await tokenFor(owner.phone);

    // An admin holds it by role.
    expect(
      (await call('GET', '/settings/dashboard-layout', await tokenFor(admin.phone))).status,
    ).toBe(200);

    await call('POST', `/settings/accounts/${admin.personId}/permissions`, ownerToken, {
      permission: 'dashboard_layout.write',
      effect: 'deny',
    });

    // …and loses it the moment an override says so — no sign-out, the seat is re-read per request.
    expect(
      (await call('GET', '/settings/dashboard-layout', await tokenFor(admin.phone))).status,
    ).toBe(403);
    // The capabilities endpoint is a separate permission and is untouched.
    expect((await call('GET', '/settings/capabilities', await tokenFor(admin.phone))).status).toBe(
      200,
    );
  });
});
