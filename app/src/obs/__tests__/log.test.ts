/**
 * Structured logging and correlation ids — M0-03.
 *
 * Two things are worth testing here and they pull in opposite directions:
 *
 *   - the id reaches **every** line, however deep the call stack, because a log where some
 *     lines are correlated and some are not cannot be followed
 *   - sensitive values reach **no** line, however deep the object, because a log is the
 *     easiest place in a system for a phone number to end up by accident
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { correlationIdFrom, currentCorrelationId, log, redact, withContext } from '../log.js';

describe('redaction', () => {
  it('removes anything that looks like a secret or a contact detail', () => {
    const out = redact({
      password: 'hunter2',
      phone: '03001234567',
      token: 'abc',
      authorization: 'Bearer x',
      apiKey: 'k',
      incidentId: 'keep-me',
    }) as Record<string, unknown>;

    expect(out['password']).toBe('[redacted]');
    expect(out['phone']).toBe('[redacted]');
    expect(out['token']).toBe('[redacted]');
    expect(out['authorization']).toBe('[redacted]');
    expect(out['apiKey']).toBe('[redacted]');
    // Ids are the whole point of a log. They are already in the audit trail.
    expect(out['incidentId']).toBe('keep-me');
  });

  it('matches by substring and ignores case', () => {
    // `reporterPhone` and `PASSWORD_HASH` are the shapes this would otherwise miss.
    const out = redact({ reporterPhone: 'x', PASSWORD_HASH: 'y', sessionToken: 'z' }) as Record<
      string,
      unknown
    >;
    expect(Object.values(out)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });

  it('reaches into nested objects and arrays', () => {
    const out = redact({
      actor: { seatId: 'seat-1', phone: '0300' },
      batch: [{ password: 'p' }, { note: 'fine' }],
    }) as { actor: Record<string, unknown>; batch: Record<string, unknown>[] };

    expect(out.actor['seatId']).toBe('seat-1');
    expect(out.actor['phone']).toBe('[redacted]');
    expect(out.batch[0]!['password']).toBe('[redacted]');
    expect(out.batch[1]!['note']).toBe('fine');
  });

  it('does not hang on a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe('the correlation id', () => {
  it('accepts a caller-supplied id, so a retried batch stays one story', () => {
    expect(correlationIdFrom('abc-123_XYZ.1')).toBe('abc-123_XYZ.1');
  });

  it('replaces anything that could forge a header or a log line', () => {
    // Echoed into a response header and into every log line, so an unchecked value is a
    // header-splitting primitive. Replaced quietly — a malformed id is not worth failing an
    // emergency report over.
    for (const hostile of ['a\r\nSet-Cookie: x=1', 'a b', '<script>', 'x'.repeat(65), '']) {
      expect(correlationIdFrom(hostile)).not.toBe(hostile);
      expect(correlationIdFrom(hostile)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('mints one when the caller sends nothing', () => {
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes the first value when a header arrives twice', () => {
    expect(correlationIdFrom(['first', 'second'])).toBe('first');
  });
});

describe('context propagation', () => {
  it('is undefined outside a context', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('reaches code that was never told about it', async () => {
    // The reason this uses AsyncLocalStorage rather than a parameter: nothing between here
    // and the leaf has to know the id exists, so nothing can forget to pass it on.
    async function deep(): Promise<string | undefined> {
      await new Promise((r) => setTimeout(r, 1));
      return currentCorrelationId();
    }
    async function middle(): Promise<string | undefined> {
      return deep();
    }

    const seen = await withContext({ correlationId: 'abc' }, () => middle());
    expect(seen).toBe('abc');
  });

  it('does not leak between concurrent contexts', async () => {
    const [a, b] = await Promise.all([
      withContext({ correlationId: 'one' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentCorrelationId();
      }),
      withContext({ correlationId: 'two' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return currentCorrelationId();
      }),
    ]);

    expect([a, b]).toEqual(['one', 'two']);
  });
});

describe('log output', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    // The suite runs at `error` so server logs do not bury the test output (see
    // `testing/loadEnv.ts`). This describe block is about the logger itself, so it turns the
    // level back up rather than silently asserting against a filtered stream.
    process.env['LOG_LEVEL'] = 'debug';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['LOG_LEVEL'];
  });

  const parsed = (): Record<string, unknown> => JSON.parse(written[0]!) as Record<string, unknown>;

  it('writes one json object per line', () => {
    log('info', 'something happened', { incidentId: 'inc-1' });
    expect(written).toHaveLength(1);
    expect(parsed()).toMatchObject({
      level: 'info',
      msg: 'something happened',
      incidentId: 'inc-1',
    });
    expect(typeof parsed()['ts']).toBe('string');
  });

  it('carries the correlation id without being handed it', () => {
    withContext({ correlationId: 'trace-me', job: 'scheduler' }, () => {
      log('warn', 'escalated');
    });
    expect(parsed()).toMatchObject({ correlationId: 'trace-me', job: 'scheduler' });
  });

  it('redacts fields on the way out, not just in the helper', () => {
    log('info', 'login attempt', { phone: '03001234567', ok: false });
    expect(parsed()['phone']).toBe('[redacted]');
    expect(written[0]).not.toContain('03001234567');
  });

  it('respects LOG_LEVEL', () => {
    process.env['LOG_LEVEL'] = 'warn';
    log('info', 'quiet');
    log('debug', 'quieter');
    expect(written).toHaveLength(0);

    log('error', 'loud');
    expect(written).toHaveLength(1);
  });
});
