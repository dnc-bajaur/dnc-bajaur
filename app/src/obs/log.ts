/**
 * Structured logging with a correlation id — M0-03.
 *
 * The gap this closes: the server logged nothing per request. If an operator says "I filed a
 * report at 14:20 and it vanished", there was no way to find out what happened. ADR-0007's
 * whole premise is a system operable by one person at 02:00, and that person needs to be
 * able to follow one emergency through sync, lifecycle, escalation and notification.
 *
 * **The correlation id lives in `AsyncLocalStorage`, not in a parameter.** That is a
 * deliberate exception to this project's preference for the boring, explicit option. The
 * alternative is threading a context argument through the event store, the fold, the
 * authority check and the notifier — dozens of signatures, every one of them a place for a
 * future change to forget it. Making "every line carries the id" true *by construction* is
 * worth one stdlib import (`node:async_hooks`, no dependency).
 *
 * **Nothing sensitive is ever logged.** Not request bodies, not tokens, not phone numbers.
 * Actor and seat **ids** are logged, because "who did this" is the question logs exist to
 * answer and those ids are already in the audit trail. Names and numbers are not.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const configured = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return ORDER[configured as Level] ?? ORDER.info;
}

export interface LogContext {
  readonly correlationId: string;
  /** Set for background passes, so a scheduled action is distinguishable from a request. */
  readonly job?: string;
}

const context = new AsyncLocalStorage<LogContext>();

export function currentContext(): LogContext | undefined {
  return context.getStore();
}

export function currentCorrelationId(): string | undefined {
  return context.getStore()?.correlationId;
}

/** Run `fn` with a correlation id attached to everything it logs, however deep. */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run(ctx, fn);
}

/**
 * Field names whose values never reach a log, at any depth.
 *
 * A denylist rather than an allowlist is the weaker choice, and it is the right one here:
 * an allowlist silently drops the diagnostic detail this exists to provide, and the failure
 * mode of a missing field is "cannot debug" rather than "leaked a phone number". The list
 * below is checked case-insensitively and by substring, so `reporterPhone` and
 * `PASSWORD_HASH` are both caught.
 */
const NEVER_LOG = [
  'password',
  'phone',
  'token',
  'secret',
  'authorization',
  'cookie',
  'credential',
  'apikey',
  'api_key',
];

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return NEVER_LOG.some((banned) => k.includes(banned));
}

/** Replace sensitive values, recursively. Depth-bounded so a cycle cannot hang a log call. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitive(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * One JSON object per line, on stdout.
 *
 * Boring on purpose (ADR-0007): `journalctl`, `grep` and `jq` all work on it, and there is
 * no logging framework for anyone to configure, break, or have to understand at 02:00.
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;

  const ctx = context.getStore();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(ctx === undefined ? {} : { correlationId: ctx.correlationId }),
    ...(ctx?.job === undefined ? {} : { job: ctx.job }),
    ...(redact(fields) as Record<string, unknown>),
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

/**
 * Accept a caller's correlation id, or mint one.
 *
 * A client that retries a held batch should be able to reuse its id, so one emergency's
 * several delivery attempts are one story in the log rather than four unrelated ones.
 *
 * The value is **sanitised, not trusted**. It is echoed into a response header and into
 * every log line, so an unchecked value is a header-splitting and log-forging primitive.
 * Anything outside a conservative character set, or too long, is discarded in favour of a
 * fresh id — quietly, because a malformed id is not worth failing an emergency report over.
 */
export function correlationIdFrom(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return randomUUID();
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : randomUUID();
}
