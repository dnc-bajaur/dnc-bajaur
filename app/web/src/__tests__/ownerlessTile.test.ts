/**
 * **The one wall tile whose presence is a decision** — RX-03, 2026-08-25.
 *
 * Pure, no DOM, no database. It exists because a decision that lives inside a DOM-painting
 * function is a decision nothing can test — and this district paid for that exact shape the
 * morning before, when the acknowledgement page shipped with a response form that rendered
 * **nothing at all** and every test that existed was about the WhatsApp thread instead.
 *
 * Each rule below was learned from something measured, not chosen:
 *
 *   * **`undefined` is not zero** — an older server cannot answer this question, and a `0` on the
 *     wall would assert that nothing has been declined in a district where nobody has looked.
 *   * **Zero draws nothing** — `dashboardLive` test 14 measures the shipped deck on a real
 *     1920×1080 wall, and a ninth tile put *Routine emergencies* and *Presence* below the fold.
 *   * **It carries its series** — test 9 pins `sparks === tiles`; a tile with a sparkline and one
 *     without are different heights, and a mixed deck goes ragged.
 */

import { describe, expect, it } from 'vitest';

import { ownerlessTile } from '../dashboard.js';

describe('the tile that is not there on an ordinary day', () => {
  it('draws nothing when nobody has declined', () => {
    expect(ownerlessTile(0, [0, 0, 0])).toBeNull();
  });

  /**
   * 🔴 The distinction that keeps the wall honest. `0` is *we looked and there are none*;
   * `undefined` is *this server cannot tell you* — and only one of those is worth printing.
   */
  it('draws nothing when the server cannot answer, which is not the same as zero', () => {
    expect(ownerlessTile(undefined, undefined)).toBeNull();
    expect(ownerlessTile(undefined, [1, 2, 3])).toBeNull();
  });

  it('appears the moment one emergency has been declined by everybody', () => {
    const tile = ownerlessTile(1, [0, 0, 1]);

    expect(tile).not.toBeNull();
    expect(tile?.n).toBe(1);
    expect(tile?.k).toBe('Nobody took it');
    expect(tile?.flag).toBe('ownerless');
  });

  /**
   * ⚠️ **`alarm` and never `warn`.** Its neighbour *No one chosen* warns, because an emergency two
   * minutes old that nobody has been picked for is not yet a failure. Everybody having refused is
   * one at any age.
   */
  it('alarms rather than warns, unlike the tile beside it', () => {
    expect(ownerlessTile(3, undefined)?.tone).toBe('alarm');
    expect(ownerlessTile(3, undefined)?.group).toBe('alarm');
  });

  it('carries its series, so the deck does not go ragged', () => {
    expect(ownerlessTile(2, [0, 1, 2])?.series).toEqual([0, 1, 2]);
  });

  /**
   * A tile drawn without a series is still drawn — an older server that counts but does not
   * replay is worth listening to. What must never happen is the number going missing because the
   * picture could not be built.
   */
  it('still appears when the server counts but cannot replay', () => {
    const tile = ownerlessTile(4, undefined);
    expect(tile?.n).toBe(4);
    expect(tile?.series).toBeUndefined();
  });

  /** Copied, not aliased: a wall that mutated the feed it was handed would corrupt the next paint. */
  it('does not hand the caller the feed’s own array', () => {
    const series = [1, 2, 3];
    const tile = ownerlessTile(1, series);
    tile?.series?.push(99);
    expect(series).toEqual([1, 2, 3]);
  });
});
