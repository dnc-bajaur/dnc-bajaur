/**
 * The district's own number, as a string — 2026-08-24.
 *
 * Pure, and no database anywhere near it. What is being pinned here is the *shape*: one place
 * formats it, one place reads it back, and a control room typing a number off a slip finds the
 * emergency rather than an empty result page.
 */

import { describe, expect, it } from 'vitest';

import { REFERENCE_PREFIX, formatReference, parseReference } from '../reference.js';

describe('the district writes its own number', () => {
  it("counts from one, in the district's name", () => {
    expect(formatReference(1)).toBe('DNC-BAJAUR-1');
    expect(formatReference(42)).toBe('DNC-BAJAUR-42');
  });

  it('never pads, so the width says how many there have been', () => {
    // `DNC-BAJAUR-0001` would claim the district planned for ten thousand and has had one.
    expect(formatReference(1)).not.toContain('0001');
    expect(formatReference(342)).toBe('DNC-BAJAUR-342');
  });

  it('builds every number from the one prefix', () => {
    expect(formatReference(7).startsWith(`${REFERENCE_PREFIX}-`)).toBe(true);
  });
});

describe('reading a number back out of what somebody typed', () => {
  it('takes the form it prints', () => {
    expect(parseReference('DNC-BAJAUR-42')).toBe(42);
  });

  it('forgives the case, the spacing and the punctuation', () => {
    // An officer reading a number off a slip on three different handsets.
    for (const typed of ['dnc-bajaur 42', 'DNC BAJAUR 42', 'dncbajaur42', '  DNC-BAJAUR-42  ']) {
      expect(parseReference(typed)).toBe(42);
    }
  });

  it('takes a bare number, because that is what people type', () => {
    expect(parseReference('42')).toBe(42);
  });

  it('refuses anything that is not a whole number, rather than guessing', () => {
    // `parseInt` would read the first two of these as 42 and hand back somebody else's emergency.
    for (const typed of ['42abc', '4.2', 'fire', '', '   ', 'DNC-BAJAUR-', 'DNC-BAJAUR-x']) {
      expect(parseReference(typed)).toBeNull();
    }
  });

  it('refuses zero and leading-zero forms, which were never issued', () => {
    expect(parseReference('DNC-BAJAUR-0')).toBeNull();
    expect(parseReference('0')).toBeNull();
    // A different string from the number seven. Accepting it would teach a format nothing prints.
    expect(parseReference('DNC-BAJAUR-007')).toBeNull();
  });

  it('refuses a number too large to be exact, rather than opening a different incident', () => {
    expect(parseReference('99999999999999999999')).toBeNull();
  });

  it('round-trips everything it formats', () => {
    for (const seq of [1, 2, 9, 10, 99, 100, 1234]) {
      expect(parseReference(formatReference(seq))).toBe(seq);
    }
  });
});
