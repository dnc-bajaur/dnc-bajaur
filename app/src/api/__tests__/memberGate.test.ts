/**
 * The member gate — ADR-0038, Bajaur. A permanent test (INV-05).
 *
 * A `member` is an officer who signs in for Activities only. What is pinned:
 *
 *   * **every** session-gated route in `api/server.ts` refuses a member with 403 — the route
 *     list is read from the router's own source, so a route added later is walked too;
 *   * the incident, evidence and sync routes refuse a member, for reads and writes alike;
 *   * a member may still read `/auth/me`, change their own password and sign out;
 *   * an operator is not affected — the same routes answer them as before;
 *   * only the deliberate exceptions call the ungated resolver, so the gate cannot be skipped
 *     by a route quietly calling `resolveAnySession`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const serverSource = readFileSync(join(here, '..', 'server.ts'), 'utf8');

const PASSWORD = 'member-password-2026';

/** Reachable without a session, or open to a member on purpose. Everything else is refused. */
const NOT_GATED = new Set([
  '/health',
  '/webhooks/whatsapp',
  '/auth/login',
  '/auth/logout',
  '/auth/password',
  '/auth/me',
  // Activities (ADR-0039): open to a member; each action asks the Activities permissions.
  '/activities',
  '/activities/anything',
]);

/** Every literal path the router matches, read from its source. */
function routerPaths(): string[] {
  const found = new Set<string>();
  for (const m of serverSource.matchAll(/url\.pathname === '([^']+)'/g)) found.add(m[1]!);
  for (const m of serverSource.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)) {
    found.add(`${m[1]!.replace(/\/$/, '')}/anything`);
  }
  return [...found].filter((p) => !NOT_GATED.has(p)).sort();
}

describe('the router source', () => {
  it('finds the routes it is meant to walk', () => {
    const paths = routerPaths();
    // A floor, not an exact count: the point is that the scan is reading the router at all.
    expect(paths.length).toBeGreaterThanOrEqual(15);
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/settings');
  });

  it('calls the ungated resolver only where a member is allowed', () => {
    // Code only: a mention in a comment is written in backticks and is not counted.
    const calls = [...serverSource.matchAll(/(?<!`)\bresolveAnySession\b(?!`)/g)].length;
    // The import alias, the gated wrapper's own call, `/auth/me` and Activities. A new call is
    // a new hole in the gate until this number is raised on purpose.
    expect(calls).toBe(4);
  });
});

const maybe = dbUrl ? describe : describe.skip;

maybe('a member is refused everywhere outside Activities (ADR-0038)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let memberToken: string;
  let operatorToken: string;

  async function account(role: 'member' | 'operator'): Promise<string> {
    const phone = `+92300${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
    await pool.query(
      `INSERT INTO person (full_name, phone, password_hash, role) VALUES ($1, $2, $3, $4)`,
      [`Test ${role}`, phone, await hashPassword(PASSWORD), role],
    );
    return (await login(pool, phone, PASSWORD))!.token;
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    server = createSyncServer({ pool, authMode: 'session', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    memberToken = await account('member');
    operatorToken = await account('operator');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  const call = (token: string, path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

  it('refuses every gated route in the router, for GET and POST', async () => {
    for (const path of routerPaths()) {
      for (const method of ['GET', 'POST']) {
        const res = await call(memberToken, path, method, method === 'POST' ? {} : undefined);
        expect(res.status, `${method} ${path}`).toBe(403);
        await res.body?.cancel();
      }
    }
  });

  it('refuses the incident, evidence and sync routes', async () => {
    const id = randomUUID();
    const routes: Array<[string, string]> = [
      ['GET', '/incidents'],
      ['POST', '/incidents'],
      ['GET', `/incidents/${id}`],
      ['POST', `/incidents/${id}/close`],
      ['POST', `/incidents/${id}/dispatch`],
      ['GET', `/evidence/${id}`],
      ['GET', '/sync'],
      ['POST', '/sync'],
    ];
    for (const [method, path] of routes) {
      const res = await call(memberToken, path, method, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      await res.body?.cancel();
    }
  });

  it('lets a member read who they are', async () => {
    const res = await call(memberToken, '/auth/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { role: string } };
    expect(body.identity.role).toBe('member');
  });

  it('lets a member change their own password and sign out', async () => {
    const token = await account('member');
    const changed = await call(token, '/auth/password', 'POST', {
      currentPassword: PASSWORD,
      newPassword: 'member-new-password-2026',
    });
    expect(changed.status).toBe(200);

    const out = await call(token, '/auth/logout', 'POST');
    expect(out.status).toBe(200);
  });

  it('lets a member into Activities', async () => {
    const res = await call(memberToken, '/activities/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toContain('activities.upload');
    // ADR-0041 §7: a member sees everyone's posts; it still may not moderate.
    expect(body.permissions).toContain('activities.read_all');
    expect(body.permissions).not.toContain('activities.moderate');
  });

  it('does not affect an operator', async () => {
    for (const path of ['/dashboard', '/incidents', '/sync']) {
      const res = await call(operatorToken, path);
      expect(res.status, path).toBe(200);
      await res.body?.cancel();
    }
  });

  it('refuses a member even after the role is set on a live session', async () => {
    const token = await account('operator');
    const before = await call(token, '/dashboard');
    expect(before.status).toBe(200);
    await before.body?.cancel();

    // The role is re-read on every request, so a demotion takes effect without a new sign-in.
    const me = (await (await call(token, '/auth/me')).json()) as {
      identity: { personId: string };
    };
    await pool.query(`UPDATE person SET role = 'member' WHERE person_id = $1`, [
      me.identity.personId,
    ]);

    const after = await call(token, '/dashboard');
    expect(after.status).toBe(403);
    await after.body?.cancel();
  });
});
