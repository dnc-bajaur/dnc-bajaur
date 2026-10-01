/**
 * The words the district uses — M4.
 *
 * Small, and worth pinning: both of these were wrong on a screen before anybody noticed, and
 * both were only noticed once the board became cards and the text got larger. A raw code and
 * a raw minute count are the two ways this application leaks its own internals at a person.
 */

import { describe, expect, it } from 'vitest';
import { categoryWords, duration } from '../words.js';

describe('categories, in words', () => {
  it('gives the six the report form offers', () => {
    expect(categoryWords('rta')).toBe('Road accident');
    expect(categoryWords('fire')).toBe('Fire');
    expect(categoryWords('medical')).toBe('Medical');
    expect(categoryWords('flood')).toBe('Flood');
    expect(categoryWords('security')).toBe('Security');
    expect(categoryWords('other')).toBe('Other');
  });

  it('shows a category nobody has a word for as the district typed it', () => {
    // Capitalised, never guessed at. "Nehr breach" is a category a district might add; a
    // mapping that reached for the nearest known word would show it as something else
    // entirely, which is worse than showing it plainly.
    expect(categoryWords('nehr-breach')).toBe('Nehr-breach');
    expect(categoryWords('landslide')).toBe('Landslide');
  });

  it('does not fall over on an empty code', () => {
    expect(categoryWords('')).toBe('');
  });
});

describe('durations, as a person would say them', () => {
  it('keeps minutes while minutes are the useful unit', () => {
    expect(duration(1)).toBe('1 min');
    expect(duration(45)).toBe('45 min');
    expect(duration(59)).toBe('59 min');
  });

  it('switches to hours, and stops being precise once precision stops mattering', () => {
    expect(duration(60)).toBe('1 hr');
    expect(duration(95)).toBe('1 hr 35 min');
    // Past six hours nobody acts differently on the minutes, and "7 hr 21 min past deadline"
    // reads as a measurement rather than as an alarm.
    expect(duration(441)).toBe('7 hr');
  });

  it('switches to days rather than reporting 1641 of anything', () => {
    // The number that started this: the board said "1641m past deadline".
    expect(duration(1641)).toBe('1 day');
    expect(duration(2880)).toBe('2 days');
  });

  it('says less than a minute rather than zero', () => {
    // "0 min past deadline" reads as "not past it", which is the opposite of what it means.
    expect(duration(0)).toBe('less than a minute');
  });
});
