/**
 * What the weather panel draws, and when it refuses to draw anything — 2026-08-19.
 *
 * The canvas itself is not tested here and deliberately so: an assertion that a rain streak was
 * stroked proves the code ran, not that a room reads it as rain, and this project already has a
 * standing lesson about tests that measure a screenshot's existence rather than its meaning.
 * What **is** worth pinning is the pair of pure decisions the picture rests on — *which scene*
 * and *is it dark* — because both can be wrong in ways nothing on screen would announce.
 */
import { describe, expect, it } from 'vitest';
import { isNight, sceneFor } from '../weather.js';

describe('sceneFor', () => {
  it('draws nothing for a code nobody mapped, rather than the nearest guess', () => {
    /**
     * `describeCode` on the server refuses the same guess for the same reason: a panel confidently
     * drawing drizzle over a code that meant freezing fog is worse than a panel drawing nothing,
     * because the first is believed. 56 is real and unmapped; 4242 is not real at all.
     */
    expect(sceneFor(56)).toBeNull();
    expect(sceneFor(4242)).toBeNull();
    expect(sceneFor(null)).toBeNull();
  });

  it('agrees with the word the panel is already printing', () => {
    // One number decides both, so the picture and the sentence cannot describe two days.
    expect(sceneFor(0)?.kind).toBe('clear');
    expect(sceneFor(3)?.kind).toBe('cloud');
    expect(sceneFor(45)?.kind).toBe('fog');
    expect(sceneFor(61)?.kind).toBe('rain');
    expect(sceneFor(73)?.kind).toBe('snow');
    expect(sceneFor(95)?.kind).toBe('storm');
  });

  it('reads drizzle and violent showers as one scene at two strengths', () => {
    const drizzle = sceneFor(51);
    const violent = sceneFor(82);

    expect(drizzle?.kind).toBe('rain');
    expect(violent?.kind).toBe('rain');
    expect(drizzle?.strength).toBeLessThan(violent?.strength ?? 0);
  });

  it('puts a shower on the same footing as steady rain of the same weight', () => {
    // 80/81/82 are showers and 61/63/65 are rain. A room four metres away is being told how hard
    // it is coming down, which is the half these two lists share.
    expect(sceneFor(81)?.strength).toBe(sceneFor(63)?.strength);
  });
});

describe('isNight', () => {
  const at = (hhmm: string): Date => new Date(`2026-08-19T${hhmm}:00`);

  it('is dark before sunrise and after sunset', () => {
    expect(isNight('2026-08-19T05:30', '2026-08-19T18:45', at('04:10'))).toBe(true);
    expect(isNight('2026-08-19T05:30', '2026-08-19T18:45', at('21:00'))).toBe(true);
  });

  it('is light in between', () => {
    expect(isNight('2026-08-19T05:30', '2026-08-19T18:45', at('13:00'))).toBe(false);
  });

  it('answers day when either time is missing, because it decides only a colour', () => {
    // A bright panel that should have been dark is a smaller error than a dark one at noon, and
    // nothing here is a claim about the district.
    expect(isNight(null, '2026-08-19T18:45', at('23:00'))).toBe(false);
    expect(isNight('2026-08-19T05:30', null, at('23:00'))).toBe(false);
    expect(isNight('nonsense', 'also nonsense', at('23:00'))).toBe(false);
  });

  it('compares wall-clock minutes, never instants', () => {
    /**
     * Open-Meteo is asked for `Asia/Karachi` and answers in local time with **no offset**, so
     * parsing either string as an instant has the browser read it in its own zone. That is the
     * two-midnights defect this project has paid for four times; here it would light the panel
     * at midnight. The Z is a lie the function must be immune to, so it is fed one.
     */
    expect(isNight('2026-08-19T05:30Z', '2026-08-19T18:45Z', at('06:00'))).toBe(false);
    expect(isNight('2026-08-19T05:30Z', '2026-08-19T18:45Z', at('19:30'))).toBe(true);
  });
});
