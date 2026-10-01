/**
 * The district's day, twenty at a time — M9-38, M9-39, M9-40, rewindowed 2026-08-19.
 *
 * Pure, no database. The database half — *the item that rotated off the screen is still in the
 * record and still reachable* — is in `api/__tests__/dashboard.test.ts`, because that is the
 * only place it can honestly be proved.
 *
 * **The assertion to read first is "reports what it is not showing".** Everything else here is
 * ordinary windowing; that one is the property that stops a rotating panel becoming a memory
 * hole, and it is the one a future simplification would delete first.
 */

import { describe, expect, it } from 'vitest';

import { startOfDistrictDay } from '../districtTime.js';

import { VISIBLE_ACTIVITY, moreSentence, windowActivity, type ActivityItem } from '../activity.js';

const NOW = new Date('2026-08-13T12:00:00.000Z');

function at(minutesAgo: number, headline = `item ${String(minutesAgo)}`): ActivityItem {
  return {
    at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    kind: 'incident',
    headline,
    detail: null,
  };
}

describe('windowActivity', () => {
  it('shows the newest first', () => {
    const window = windowActivity([at(60), at(10), at(30)], NOW);
    expect(window.visible.map((i) => i.headline)).toEqual(['item 10', 'item 30', 'item 60']);
  });

  it('shows at most twenty, and the twenty it shows are the newest', () => {
    const many = Array.from({ length: 35 }, (_, i) => at(i + 1));
    const window = windowActivity(many, NOW);

    expect(window.visible).toHaveLength(VISIBLE_ACTIVITY);
    // A new one replaces the oldest **visible** one — which is what "visible" means when the
    // list is rebuilt from scratch on every render rather than pushed into.
    expect(window.visible[0]?.headline).toBe('item 1');
    expect(window.visible[VISIBLE_ACTIVITY - 1]?.headline).toBe(`item ${String(VISIBLE_ACTIVITY)}`);
  });

  it('reports what it is not showing — the assertion this file exists for', () => {
    const many = Array.from({ length: 35 }, (_, i) => at(i + 1));
    const window = windowActivity(many, NOW);

    /**
     * Fifteen fell inside the window and outside the twenty, and the window **says so**. A
     * panel that showed twenty and reported nothing would be read as "this is everything that
     * happened" — and the first time somebody asks about an alert the screen has rotated past,
     * the true answer stops being believed, because the screen is what people trust.
     */
    expect(window.hidden).toBe(15);
    expect(window.total).toBe(35);
    expect(window.visible.length + window.hidden).toBe(window.total);
  });

  it('drops nothing quietly: total counts everything in the window', () => {
    const window = windowActivity([at(5), at(600), at(1_000)], NOW);
    /**
     * 1,000 minutes is 16h40m, which at `NOW` (17:00 in Bajaur) is **this morning** — inside.
     * Nothing is discarded for being merely old.
     *
     * ⚠️ It used to be 1,400 (23h20m), which was inside the **rolling twenty-four hours** and is
     * yesterday under the district day this panel windows by from 2026-08-19. The number moved
     * because the window did; the property being asserted is unchanged.
     */
    expect(window.total).toBe(3);
    expect(window.hidden).toBe(0);
  });

  /**
   * **The window is the district's day, and this test is written so the old rule fails it.**
   *
   * `NOW` is 12:00 UTC, which is **17:00 in Bajaur** (UTC+05:00), so today began seventeen hours
   * ago. An item **eighteen** hours old is therefore **yesterday's** — and under the rolling
   * twenty-four hours this panel used until 2026-08-19 it was comfortably inside the window.
   * That one item is the whole difference between the two rules, which is why it is the item
   * chosen.
   */
  it("excludes what belongs to yesterday, and starts at the district's own midnight", () => {
    const window = windowActivity([at(60 * 16), at(60 * 18)], NOW);

    expect(window.total).toBe(1);
    expect(window.visible.map((i) => i.headline)).toEqual([`item ${String(60 * 16)}`]);
    expect(window.since).toBe(startOfDistrictDay(NOW));
  });

  it('drops an item whose time cannot be read rather than sorting it to an end', () => {
    // A row that cannot be placed in time, on a panel whose entire meaning is *recently*, would
    // look current and not be. That is the one failure a wall screen must never produce.
    const broken: ActivityItem = { at: 'not a time', kind: 'alert', headline: 'x', detail: null };
    const window = windowActivity([at(5), broken], NOW);

    expect(window.total).toBe(1);
    expect(window.visible.map((i) => i.headline)).toEqual(['item 5']);
  });

  it('merges the two kinds into one ordering rather than interleaving by kind', () => {
    const alert: ActivityItem = {
      at: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
      kind: 'alert',
      headline: 'road closed at Mamund',
      detail: null,
    };
    const window = windowActivity([at(30), alert, at(10)], NOW);

    // Advisories and emergency updates are the same thing to somebody reading a wall: what has
    // been happening. Two lists would rotate separately and hold items of two different ages.
    expect(window.visible.map((i) => i.kind)).toEqual(['incident', 'alert', 'incident']);
  });
});

describe('moreSentence', () => {
  it('says how many and where the rest is', () => {
    const window = windowActivity(
      Array.from({ length: 34 }, (_, i) => at(i + 1)),
      NOW,
    );
    const sentence = moreSentence(window);

    expect(sentence).toContain('14 more');
    // It names the period too, and the period is the district's day rather than a rolling
    // twenty-four hours — a panel saying "in the last 24 hours" beside counters that reset at
    // midnight is one surface describing two periods.
    expect(sentence).toContain('earlier today');
    // Naming where it went is the whole job. "and 14 more" alone tells somebody they are
    // missing something without telling them how to stop missing it.
    expect(sentence).toContain('board');
  });

  it('says nothing at all when nothing is held back', () => {
    // A permanent "and 0 more" teaches people to stop reading the line, and then the line is
    // not there on the morning it says 40.
    expect(moreSentence(windowActivity([at(5)], NOW))).toBeNull();
  });
});
