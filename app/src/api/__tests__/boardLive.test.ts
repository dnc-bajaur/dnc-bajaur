/**
 * `GET /board/live` — the board's doorbell on the wire.
 *
 * What is under test is the promise `boardStream.ts` makes and nothing more: a connection is
 * told when something changed, and told nothing about what. The scoping guarantee itself —
 * which incidents a seat may see — belongs to `board.test.ts`, and stays proven there; this
 * suite would be the wrong place to re-derive it, for the same reason the route doesn't.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, authHeaders, type TestActor } from '../../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the board doorbell, on the wire (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let actor: TestActor;
  let incidentId: string;
  let seq: number;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    actor = await seedActor(pool, { tier: 'district' });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  beforeEach(() => {
    incidentId = randomUUID();
    seq = 0;
  });

  function ev(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
    seq += 1;
    return {
      eventId: randomUUID(),
      incidentId,
      type,
      occurredAt: '2026-08-01T14:02:00.000Z',
      clientSeq: seq,
      actorPersonId: actor.personId,
      actorSeatId: actor.seatId,
      sourceChannel: 'mobile',
      payload,
    };
  }

  async function push(events: unknown[]): Promise<void> {
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: authHeaders(actor.token),
      body: JSON.stringify({ deviceId: randomUUID(), events }),
    });
    expect(res.status).toBe(200);
  }

  it('refuses a connection with no session', async () => {
    const res = await fetch(`${base}/board/live`);
    expect(res.status).toBe(401);
  });

  it('refuses anything but GET', async () => {
    const res = await fetch(`${base}/board/live`, {
      method: 'POST',
      headers: authHeaders(actor.token),
    });
    expect(res.status).toBe(405);
  });

  it('streams as an event source, not a request that ends', async () => {
    const res = await fetch(`${base}/board/live`, { headers: authHeaders(actor.token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('retry:');

    await reader.cancel();
  });

  it('tells an open connection within a couple of seconds of a genuinely new event landing', async () => {
    const res = await fetch(`${base}/board/live`, { headers: authHeaders(actor.token) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the opening `retry:` line first, so the assertion below is watching for the
    // *next* thing on the wire rather than racing the connection's own open.
    await reader.read();

    const heard = readUntil(reader, decoder, 'event: changed', 5_000);

    await push([ev('reported', { category: 'fire', severity: 'critical' })]);

    await expect(heard).resolves.toBe(true);
    await reader.cancel();
  });

  it('a batch that is entirely duplicates announces nothing — a retried sync must not flicker the board', async () => {
    const batch = [ev('reported', { category: 'flood', severity: 'high' })];
    await push(batch); // lands for real, and — deliberately — before the stream below opens

    const res = await fetch(`${base}/board/live`, { headers: authHeaders(actor.token) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // the opening `retry:` line

    const heardSomething = readUntil(reader, decoder, 'event: changed', 1_500);

    // The exact retry a flaky-network client makes: the same eventId, again. `append`'s
    // `ON CONFLICT (event_id) DO NOTHING` means this appends nothing new — and this is the
    // one behaviour this whole feature must get right, because a client that legitimately
    // retries an ambiguous send is the common case offline, not the rare one.
    await push(batch);

    await expect(heardSomething).resolves.toBe(false);
    await reader.cancel();
  }, 10_000);
});

/**
 * Read chunks until `marker` appears or `timeoutMs` elapses. Resolves `true`/`false` rather than
 * throwing either way — a timeout here is a real, useful "it did not arrive" answer for the
 * duplicate-batch test, not a broken harness.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  marker: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
    ]);
    if (chunk === 'timeout') return false;
    if (chunk.done) return false;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes(marker)) return true;
  }
  return false;
}
