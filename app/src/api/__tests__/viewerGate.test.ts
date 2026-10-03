/**
 * The viewer gate — ADR-0032 (`viewer`: read-only), enforced 2026-10-03. A permanent test (INV-05).
 *
 * What is pinned:
 *
 *   * **every** session-gated route refuses a viewer's write (POST, PUT, PATCH, DELETE) with the
 *     viewer refusal — the route list is read from the router's own source, so a route added
 *     later is walked too;
 *   * a viewer's reads are not refused by this gate (a read may still need a permission the
 *     viewer lacks, and says so in its own words);
 *   * a viewer may still change their own password, sign out and use Activities;
 *   * an operator's writes are not affected.
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

const PASSWORD = 'viewer-password-2026';
const VIEWER_REFUSED = 'this account is read-only (viewer)';

/** Reachable without a session, or deliberately outside the operational gate. */
const NOT_GATED = new Set([
  '/health',
  '/webhooks/whatsapp',
  '/auth/login',
  '/auth/logout',
  '/auth/password',
  '/auth/me',
  '/activities',
  '/activities/anything',
]);

function routerPaths(): string[] {
  const found = new Set<string>();
  for (const m of serverSource.matchAll(/url\.pathname === '([^']+)'/g)) found.add(m[1]!);
  for (const m of serverSource.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)) {
    found.add(`${m[1]!.replace(/\/$/, '')}/anything`);
  }
  return [...found].filter((p) => !NOT_GATED.has(p)).sort();
}

const maybe = dbUrl ? describe : describe.skip;

maybe('a viewer is read-only (ADR-0032)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let viewerToken: string;
  let operatorToken: string;

  async function account(role: 'viewer' | 'operator'): Promise<string> {
    const phone = `+92307${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
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
    viewerToken = await account('viewer');
    operatorToken = await account('operator');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  const call = async (
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; error: string | undefined }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    // `/board/live` is a stream that never ends; its answer is the status alone.
    if ((res.headers.get('content-type') ?? '').includes('event-stream')) {
      await res.body?.cancel();
      return { status: res.status, error: undefined };
    }
    const text = await res.text();
    let error: string | undefined;
    try {
      error = (JSON.parse(text) as { error?: string }).error;
    } catch {
      error = undefined;
    }
    return { status: res.status, error };
  };

  it('refuses a viewer’s write on every gated route, and not their reads', async () => {
    const paths = routerPaths();
    expect(paths.length).toBeGreaterThanOrEqual(15);
    for (const path of paths) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await call(viewerToken, path, method, {});
        expect(res, `${method} ${path}`).toEqual({ status: 403, error: VIEWER_REFUSED });
      }
      const read = await call(viewerToken, path, 'GET');
      expect(read.error, `GET ${path}`).not.toBe(VIEWER_REFUSED);
    }
  });

  it('refuses the incident record’s writes and sync pushes', async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ['POST', '/incidents'],
      ['POST', `/incidents/${id}/close`],
      ['POST', `/incidents/${id}/dispatch`],
      ['POST', '/sync'],
    ] as const) {
      expect(await call(viewerToken, path, method, {}), `${method} ${path}`).toEqual({
        status: 403,
        error: VIEWER_REFUSED,
      });
    }
    expect((await call(viewerToken, '/sync')).error).not.toBe(VIEWER_REFUSED);
    expect((await call(viewerToken, '/incidents')).status).toBe(200);
  });

  it('still lets a viewer change their password, sign out and use Activities', async () => {
    const pw = await call(viewerToken, '/auth/password', 'POST', {});
    expect(pw.status).toBe(400);
    const unit = await call(viewerToken, '/activities/posts', 'POST', {});
    expect(unit.error).not.toBe(VIEWER_REFUSED);
    expect((await call(viewerToken, '/auth/me')).status).toBe(200);
  });

  it('does not touch an operator’s writes', async () => {
    for (const path of routerPaths()) {
      const res = await call(operatorToken, path, 'POST', {});
      expect(res.error, `POST ${path}`).not.toBe(VIEWER_REFUSED);
    }
  });
});
