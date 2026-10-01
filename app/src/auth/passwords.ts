/**
 * Password hashing.
 *
 * scrypt from `node:crypto` — no dependency, which matters here (ADR-0007: every new
 * dependency needs someone who will restart it at 02:00 and a way for them to know it
 * failed). scrypt is memory-hard and in the standard library; argon2 would be marginally
 * better and would cost a native build step on a machine nobody in the district maintains.
 *
 * Parameters are stored *in* the hash so they can be raised later without invalidating
 * existing passwords.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** ~100ms on a modern machine. Raise N when hardware allows; old hashes keep working. */
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

// scrypt's default maxmem (32 MiB) is below what N=16384,r=8 needs.
const maxmem = 128 * PARAMS.N * PARAMS.r * 2;

export async function hashPassword(password: string): Promise<string> {
  assertUsable(password);
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, { ...PARAMS, maxmem });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored hash —
 * a corrupted row must not become a way to crash the login endpoint.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');

    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (N < 1024 || r < 1 || p < 1) return false;

    /**
     * Reject a stored hash that is too short, before deriving anything.
     *
     * This is not defensive tidiness — it closes a real hole. `Buffer.from(garbage,
     * 'base64')` can yield an empty buffer, and scrypt asked for a zero-length key returns
     * an empty buffer too. `timingSafeEqual(empty, empty)` is `true`, so a single corrupted
     * row would have accepted **any password for that account**. Found by a test that fed
     * in deliberately malformed hashes.
     */
    if (salt.length < 8 || expected.length < 16) return false;

    const actual = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });

    // Constant time. A length mismatch is checked first because timingSafeEqual throws on
    // differing lengths, and that throw would itself be a timing signal.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * The minimum bar, deliberately about length and nothing else.
 *
 * These accounts belong to field staff and duty officers, not security professionals, and
 * a policy demanding symbols and mixed case produces passwords written on the inside of a
 * duty register. Length is the property that actually helps; complexity theatre is not.
 * Real protection here comes from rate limiting and instant revocation, which are the
 * server's job rather than the user's.
 *
 * ⚠️ **This is the ONE value now (ADR-0032).** `assertUsable` said 10 and `grantAccount` /
 * `grantRosterAccount` each said 12 — a split-brain where the answer to *"how long must a
 * password be"* depended on which door you came through. Every grant path and the
 * change-my-password endpoint read this constant. It becomes an editable Security-policy value
 * in ADR-0032 phase 3, above a floor the `owner` cannot go below; until then it is 12, the
 * stricter of the two it replaces.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 512;

export function assertUsable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // scrypt on an unbounded input is a denial-of-service vector.
    throw new Error(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}
