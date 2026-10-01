/**
 * The board's doorbell (`boardStream.ts`) — a pure in-process contract, no database needed.
 *
 * What matters here is narrower than it looks: that a subscriber is told, that an empty batch
 * tells nobody (a duplicate-only append must never make the board flicker), that a listener
 * throwing cannot propagate back into the writer that woke it, and that unsubscribing actually
 * stops delivery. The integration test alongside `server.test.ts`-style suites proves the wire
 * format; this proves the mechanism it rides on.
 */

import { describe, expect, it, vi } from 'vitest';
import { announceBoardChange, onBoardChange } from '../boardStream.js';

describe('the board doorbell', () => {
  it('tells every subscriber which incidents changed', () => {
    const heard: (readonly string[])[] = [];
    const unsubscribe = onBoardChange((ids) => heard.push(ids));

    announceBoardChange(['inc-1', 'inc-2']);

    expect(heard).toEqual([['inc-1', 'inc-2']]);
    unsubscribe();
  });

  it('tells nobody about an empty batch — a duplicate-only append must not flicker the board', () => {
    const heard: unknown[] = [];
    const unsubscribe = onBoardChange((ids) => heard.push(ids));

    announceBoardChange([]);

    expect(heard).toEqual([]);
    unsubscribe();
  });

  it('stops delivering once unsubscribed', () => {
    const heard: unknown[] = [];
    const unsubscribe = onBoardChange((ids) => heard.push(ids));
    unsubscribe();

    announceBoardChange(['inc-1']);

    expect(heard).toEqual([]);
  });

  it('a listener throwing does not propagate into the caller that announced', () => {
    const unsubscribe = onBoardChange(() => {
      throw new Error('a broken subscriber');
    });

    expect(() => announceBoardChange(['inc-1'])).not.toThrow();
    unsubscribe();
  });

  it('does not let one subscriber block or affect another', () => {
    const secondHeard: unknown[] = [];
    const unsubFirst = onBoardChange(() => {
      throw new Error('first subscriber is broken');
    });
    const unsubSecond = onBoardChange((ids) => secondHeard.push(ids));

    announceBoardChange(['inc-1']);

    expect(secondHeard).toEqual([['inc-1']]);
    unsubFirst();
    unsubSecond();
  });

  it('supports many simultaneous subscribers without warning about a leak', () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const unsubscribers = Array.from({ length: 20 }, () => onBoardChange(() => {}));

    announceBoardChange(['inc-1']);

    expect(warn).not.toHaveBeenCalled();
    unsubscribers.forEach((u) => u());
    warn.mockRestore();
  });
});
