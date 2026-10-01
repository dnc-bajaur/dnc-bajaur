/**
 * The server stops even when something is holding it open — O-29.
 *
 * **The bug was invisible to every test in this repository and visible in every journal.** It
 * needs three things at once: a server, a connection that never ends, and somebody trying to shut
 * down. Nothing here had ever asked for all three, so `shutdown()` was never once observed
 * completing — in production it never did, and `"stopped"` had never been written to the journal
 * in the life of the district.
 *
 * So test 1 opens the thing that actually caused it: a request that streams for ever, exactly as
 * `GET /board/live` does. **Against the old one-line `server.close()` it does not fail — it
 * hangs**, which is why it carries its own timeout rather than trusting the runner's.
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { closeServer } from '../shutdown.js';

/** A server that answers `/` at once and streams `/live` for ever, like the board's doorbell. */
async function serving(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/live') {
      // The shape `server.ts` uses for SSE: no socket timeout, heartbeats, never ends.
      req.socket.setTimeout(0);
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(': open\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

/** Fail loudly instead of hanging — the old behaviour was a hang, not a wrong answer. */
async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not finish within ${String(ms)}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('stopping the server', () => {
  /**
   * **This is O-29 itself.** One open stream is all it took to turn every deploy into a
   * ninety-second outage.
   */
  it('1. stops while a stream is being held open for ever', async () => {
    const { server, base } = await serving();

    const stream = await fetch(`${base}/live`);
    expect(stream.status).toBe(200);

    const started = Date.now();
    const outcome = await within(5000, closeServer(server, 200), 'closeServer');
    const took = Date.now() - started;

    // The connection had to be taken; nothing was going to end it.
    expect(outcome).toBe('forced');
    // Comfortably inside systemd's 90s, which is the whole point. Loose bound on purpose:
    // this asserts "it stops", never a stopwatch reading that would flake on a busy laptop.
    expect(took).toBeLessThan(3000);

    // And the port is genuinely free — a "closed" server still listening is the same outage.
    await expect(fetch(`${base}/`)).rejects.toThrow();

    await stream.body?.cancel();
  });

  /**
   * The ordinary case must not be slowed down by the fix.
   *
   * A shutdown with nothing open should not sit through the grace period waiting for permission
   * to do what it could have done immediately — a deploy script that takes two seconds every
   * time is one somebody starts running with `--force`.
   */
  it('2. stops immediately, and reports it as clean, when nothing is held open', async () => {
    const { server, base } = await serving();

    const answered = await fetch(`${base}/`);
    expect(await answered.text()).toBe('ok');

    const started = Date.now();
    const outcome = await within(5000, closeServer(server, 2000), 'closeServer');
    const took = Date.now() - started;

    expect(outcome).toBe('clean');
    // It did not wait out the 2000ms grace it was given.
    expect(took).toBeLessThan(1500);
  });

  /**
   * A second SIGTERM must not produce a process that never exits.
   *
   * `close()` calls back with `ERR_SERVER_NOT_RUNNING` when the server is already stopped, and a
   * shutdown path that threw on it would hang exactly like the bug this replaces — by a new door.
   */
  it('3. survives being asked to stop twice', async () => {
    const { server } = await serving();

    await within(5000, closeServer(server, 200), 'first close');
    await expect(within(5000, closeServer(server, 200), 'second close')).resolves.toBeDefined();
  });
});
