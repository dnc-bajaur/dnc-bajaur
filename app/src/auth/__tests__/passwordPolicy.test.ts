/**
 * The password minimum is ONE value now — ADR-0032.
 *
 * `assertUsable` said 10; `grantAccount` and `grantRosterAccount` each said 12. The answer to
 * "how long must a password be" depended on which door you came through. This pins that there
 * is one door.
 */

import { describe, expect, it } from 'vitest';

import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, assertUsable } from '../passwords.js';

describe('assertUsable', () => {
  it('the minimum is 12 — the stricter of the two it replaced', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('refuses one character short of the minimum', () => {
    expect(() => assertUsable('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(/at least 12/);
  });

  it('accepts exactly the minimum', () => {
    expect(() => assertUsable('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('refuses one character over the maximum', () => {
    expect(() => assertUsable('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(/at most/);
  });

  it('the old 10/11-character passwords are now refused', () => {
    expect(() => assertUsable('x'.repeat(10))).toThrow();
    expect(() => assertUsable('x'.repeat(11))).toThrow();
  });
});
