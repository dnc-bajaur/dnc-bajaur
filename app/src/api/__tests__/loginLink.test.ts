/**
 * The sign-in link — ADR-0043 (Bajaur, E5). Over real HTTP, against a stubbed Meta.
 *
 * What is pinned:
 *
 *   * a login given with a link has a password nobody knows, and only the link's hash is stored;
 *   * opening the link (GET) spends nothing — WhatsApp's preview crawler must not use it;
 *   * the form (POST) refuses a weak password and leaves the link usable, then sets the password,
 *     signs every other session of the account out, signs the officer in, and the link is spent;
 *   * a newer link cancels an older one; an expired link and a suspended account's link refuse;
 *   * with the login template configured the link goes by WhatsApp (the token only, in the URL
 *     button) and is not handed back; without it, or when Meta refuses, the DC is given the link
 *     and told why (INV-03);
 *   * only an account with `accounts.reset_password` sends one, and nobody can for the owner;
 *   * the access log has both lines.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { hashPassword } from '../../auth/passwords.js';
import { login, resolveSession } from '../../auth/sessions.js';
import type { Role } from '../../domain/roles.js';
import type { WhatsAppConfig } from '../../ops/whatsapp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'login-link-password-2026';
const NEW_PASSWORD = 'my-own-new-password-2026';
const RUN = randomUUID().slice(0, 8);

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  loginTemplate: { name: 'dnc_bajaur_login_link', language: 'en' },
};

interface LinkSent {
  sentVia: 'whatsapp' | 'by_hand' | 'failed';
  failure: string | null;
  url: string | null;
  expiresAt: string;
}

const maybe = dbUrl ? describe : describe.skip;

maybe('the sign-in link (ADR-0043)', () => {
  let pool: Pool;
  let plain: Server; // no WhatsApp: links are handed to the DC
  let wired: Server; // WhatsApp with a login template, against the stub
  let plainBase: string;
  let wiredBase: string;
  let owner: { token: string; personId: string };
  let admin: { token: string; personId: string };
  let operator: { token: string; personId: string };

  const sent: Record<string, unknown>[] = [];
  /** A number Meta refuses, to see a failure reach the DC. */
  let refusedPhone = '';
  const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const digits = (v: unknown): string => String(v).replace(/\D/g, '');
    if (refusedPhone !== '' && digits(body['to']).endsWith(digits(refusedPhone).slice(-9))) {
      return new Response(
        JSON.stringify({
          error: { message: 'Recipient phone number not in allowed list', code: 131030 },
        }),
        { status: 400 },
      );
    }
    sent.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${RUN}.${sent.length}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  async function account(role: Role): Promise<{ token: string; personId: string }> {
    const phone = `+92304${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const res = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash, role)
       VALUES ($1, $2, $3, $4) RETURNING person_id`,
      [`Link ${role} ${RUN}`, phone, await hashPassword(PASSWORD), role],
    );
    return {
      token: (await login(pool, phone, PASSWORD))!.token,
      personId: res.rows[0]!.person_id,
    };
  }

  /** A Directory contact with no login, as the Officers tab shows one. */
  async function contact(): Promise<{ personId: string; phone: string; fullName: string }> {
    const phone = `+92305${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    const fullName = `Link Officer ${randomUUID().slice(0, 8)}`;
    const person = await pool.query<{ person_id: string }>(
      'INSERT INTO person (full_name, phone) VALUES ($1, $2) RETURNING person_id',
      [fullName, phone],
    );
    const seat = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title, tier) VALUES ($1, 'post') RETURNING seat_id`,
      [`Link Post ${randomUUID().slice(0, 8)}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seat.rows[0]!.seat_id,
      person.rows[0]!.person_id,
    ]);
    return { personId: person.rows[0]!.person_id, phone, fullName };
  }

  const call = (
    base: string,
    token: string | null,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

  const tokenOf = (url: string | null): string => {
    expect(url).toMatch(/\/set-password\/[A-Za-z0-9_-]{40,}$/);
    return url!.split('/').pop()!;
  };

  async function giveByLink(base: string, personId: string): Promise<LinkSent> {
    const res = await call(base, admin.token, `/activities/officers/${personId}/login`, 'POST', {
      link: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { role: string; sent: LinkSent };
    expect(body.role).toBe('member');
    return body.sent;
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    plain = createSyncServer({ pool, authMode: 'session', nodeEnv: 'test' });
    wired = createSyncServer({
      pool,
      authMode: 'session',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
      whatsappFetch: stubFetch,
    });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => wired.listen(0, '127.0.0.1', r));
    plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    wiredBase = `http://127.0.0.1:${(wired.address() as AddressInfo).port}`;

    const existingOwner = await pool.query<{ person_id: string }>(
      `SELECT person_id FROM person WHERE role = 'owner' AND removed_at IS NULL LIMIT 1`,
    );
    owner =
      existingOwner.rows[0] === undefined
        ? await account('owner')
        : { token: '', personId: existingOwner.rows[0].person_id };
    admin = await account('admin');
    operator = await account('operator');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => plain?.close(() => r()));
    await new Promise<void>((r) => wired?.close(() => r()));
    await pool?.end();
  });

  it('gives a login by link with no WhatsApp: the DC is handed the link, and only its hash is kept', async () => {
    const officer = await contact();
    const link = await giveByLink(plainBase, officer.personId);
    expect(link.sentVia).toBe('by_hand');
    const token = tokenOf(link.url);

    const stored = await pool.query<{ token_hash: Buffer; sent_via: string }>(
      'SELECT token_hash, sent_via FROM login_link WHERE person_id = $1',
      [officer.personId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.token_hash.equals(createHash('sha256').update(token).digest())).toBe(
      true,
    );
    expect(stored.rows[0]!.sent_via).toBe('by_hand');

    // A login exists, with a password nobody was told.
    const person = await pool.query<{ has_hash: boolean; role: string }>(
      'SELECT password_hash IS NOT NULL AS has_hash, role FROM person WHERE person_id = $1',
      [officer.personId],
    );
    expect(person.rows[0]).toEqual({ has_hash: true, role: 'member' });
    expect(await login(pool, officer.phone, '')).toBeNull();
  });

  it('opens without spending, refuses a weak password, then sets it, signs in and is spent', async () => {
    const officer = await contact();
    const token = tokenOf((await giveByLink(plainBase, officer.personId)).url);

    for (let i = 0; i < 2; i += 1) {
      const peek = await call(plainBase, null, `/auth/link/${token}`);
      expect(peek.status).toBe(200);
      expect(await peek.json()).toEqual({ fullName: officer.fullName });
    }
    const page = await call(plainBase, null, `/set-password/${token}`);
    // No web root in this server: the page itself is not served here, only the API is tested.
    expect([200, 404]).toContain(page.status);

    const weak = await call(plainBase, null, `/auth/link/${token}`, 'POST', { password: 'short' });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { reason: string }).reason).toBe('weak');

    const used = await call(plainBase, null, `/auth/link/${token}`, 'POST', {
      password: NEW_PASSWORD,
    });
    expect(used.status).toBe(200);
    expect(used.headers.get('set-cookie')).toMatch(/dnc_bajaur_session=/);
    expect(((await used.json()) as { identity: { role: string } }).identity.role).toBe('member');

    expect(await login(pool, officer.phone, NEW_PASSWORD)).not.toBeNull();
    const row = await pool.query<{ must_change_password: boolean }>(
      'SELECT must_change_password FROM person WHERE person_id = $1',
      [officer.personId],
    );
    expect(row.rows[0]!.must_change_password).toBe(false);

    const again = await call(plainBase, null, `/auth/link/${token}`, 'POST', {
      password: 'another-password-2026',
    });
    expect(again.status).toBe(410);
    expect(((await again.json()) as { reason: string }).reason).toBe('used');
    expect((await call(plainBase, null, `/auth/link/${token}`)).status).toBe(410);

    const log = await pool.query<{ type: string }>(
      `SELECT type FROM access_event WHERE subject_person_id = $1 ORDER BY seq`,
      [officer.personId],
    );
    expect(log.rows.map((r) => r.type)).toEqual([
      'granted',
      'login_link_issued',
      'login_link_used',
      'login_succeeded',
      'login_succeeded',
    ]);
  });

  it('resets a forgotten password: the old one works until the link is used, then every session ends', async () => {
    const member = await account('member');
    const res = await call(
      plainBase,
      admin.token,
      `/activities/officers/${member.personId}/login-link`,
      'POST',
    );
    expect(res.status).toBe(200);
    const token = tokenOf(((await res.json()) as LinkSent).url);
    expect(await resolveSession(pool, member.token)).not.toBeNull();

    const used = await call(plainBase, null, `/auth/link/${token}`, 'POST', {
      password: NEW_PASSWORD,
    });
    expect(used.status).toBe(200);
    expect(await resolveSession(pool, member.token)).toBeNull();
  });

  it('cancels an older link when a newer one is sent; refuses an expired one and a suspended account', async () => {
    const officer = await contact();
    const first = tokenOf((await giveByLink(plainBase, officer.personId)).url);
    const res = await call(
      plainBase,
      admin.token,
      `/activities/officers/${officer.personId}/login-link`,
      'POST',
    );
    const second = tokenOf(((await res.json()) as LinkSent).url);

    const cancelled = await call(plainBase, null, `/auth/link/${first}`);
    expect(cancelled.status).toBe(410);
    expect(((await cancelled.json()) as { reason: string }).reason).toBe('cancelled');

    await pool.query(
      `UPDATE login_link SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [createHash('sha256').update(second).digest()],
    );
    const expired = await call(plainBase, null, `/auth/link/${second}`, 'POST', {
      password: NEW_PASSWORD,
    });
    expect(((await expired.json()) as { reason: string }).reason).toBe('expired');

    const third = tokenOf(
      (
        (await (
          await call(
            plainBase,
            admin.token,
            `/activities/officers/${officer.personId}/login-link`,
            'POST',
          )
        ).json()) as LinkSent
      ).url,
    );
    await pool.query(`UPDATE person SET suspended_at = now() WHERE person_id = $1`, [
      officer.personId,
    ]);
    const inactive = await call(plainBase, null, `/auth/link/${third}`);
    expect(((await inactive.json()) as { reason: string }).reason).toBe('inactive');
  });

  it('sends by WhatsApp when the login template is set — the token only, in the button — and does not hand it back', async () => {
    const officer = await contact();
    sent.length = 0;
    const link = await giveByLink(wiredBase, officer.personId);
    expect(link).toMatchObject({ sentVia: 'whatsapp', failure: null, url: null });

    expect(sent).toHaveLength(1);
    const template = sent[0]!['template'] as {
      name: string;
      components: { type: string; parameters: { text: string }[] }[];
    };
    expect(template.name).toBe('dnc_bajaur_login_link');
    expect(template.components[0]!.parameters[0]!.text).toBe(officer.fullName);
    const token = template.components[1]!.parameters[0]!.text;
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await call(wiredBase, null, `/auth/link/${token}`)).status).toBe(200);
  });

  it('tells the DC when Meta refuses, and hands over the link to send by hand', async () => {
    const officer = await contact();
    refusedPhone = officer.phone;
    const link = await giveByLink(wiredBase, officer.personId);
    expect(link.sentVia).toBe('failed');
    expect(link.failure).toMatch(/whatsapp_400/);
    tokenOf(link.url);

    const res = await call(wiredBase, admin.token, '/activities/officers');
    const listed = ((await res.json()) as { personId: string; link: unknown }[]).find(
      (o) => o.personId === officer.personId,
    );
    expect(listed?.link).toEqual({ state: 'waiting', sentVia: 'failed' });
  });

  it('is sent only with accounts.reset_password, and never for the owner', async () => {
    const member = await account('member');
    const byOperator = await call(
      plainBase,
      operator.token,
      `/settings/accounts/${member.personId}/login-link`,
      'POST',
    );
    expect(byOperator.status).toBe(403);
    const byMember = await call(
      plainBase,
      member.token,
      `/settings/accounts/${admin.personId}/login-link`,
      'POST',
    );
    expect([401, 403]).toContain(byMember.status);
    const forOwner = await call(
      plainBase,
      admin.token,
      `/settings/accounts/${owner.personId}/login-link`,
      'POST',
    );
    expect(forOwner.status).toBe(409);
    const byAdmin = await call(
      plainBase,
      admin.token,
      `/settings/accounts/${member.personId}/login-link`,
      'POST',
    );
    expect(byAdmin.status).toBe(200);
  });
});
