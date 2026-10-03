/**
 * "Somebody with that name is already here" — M10-35.
 *
 * ⚠️ **The load-bearing assertion in this file is that a repeated NUMBER is a warning and not a
 * refusal.** Two officers can genuinely share one office handset (`03000000171` in the example below),
 * as in the original deployment's directory — which is why migration 0006 moved phone uniqueness off
 * `person` at all (Q-19). A check that treated a repeated number as an error could not enter the
 * district's own roster.
 */
import { describe, expect, it } from 'vitest';
import { findDuplicate, duplicateSentence } from '../duplicates.js';

const KNOWN = [
  { name: 'Officer Alpha', phone: '03000000171' },
  { name: 'Officer Charlie', phone: '03005551234' },
  { name: 'Officer Juliet', phone: null },
];

describe('finding a duplicate before an officer is added', () => {
  it('says nothing about a name and number nobody has', () => {
    expect(findDuplicate('Shah Golf', '03001112222', KNOWN)).toBeNull();
  });

  it('recognises the district’s own shared handset, and calls it normal', () => {
    // The case this whole check had to be a warning for.
    const match = findDuplicate('Officer Bravo', '03000000171', KNOWN);
    expect(match?.on).toBe('phone');
    expect(match?.who).toEqual(['Officer Alpha']);
    expect(duplicateSentence(match!, 'district')).toContain('normal here');
  });

  it('reads one number four ways and calls them the same number', () => {
    // A district types a number however it likes; a check that compared strings would never fire.
    for (const written of ['0300 000 0171', '+923000000171', '92-300-000-0171', '3000000171']) {
      expect(findDuplicate('', written, KNOWN)?.on, written).toBe('phone');
    }
  });

  it('ignores a half-typed number rather than matching everything', () => {
    // A warning that appears before it can be true is one people learn to ignore.
    for (const partial of ['', '0', '0333', '030000001']) {
      expect(findDuplicate('', partial, KNOWN), partial).toBeNull();
    }
  });

  it('matches a name whatever the spacing and case', () => {
    expect(findDuplicate('  officer   CHARLIE ', '', KNOWN)?.on).toBe('name');
  });

  it('says BOTH when it is very probably the same person', () => {
    const match = findDuplicate('Officer Charlie', '03005551234', KNOWN);
    expect(match?.on).toBe('both');
    expect(duplicateSentence(match!, 'district')).toContain('same person');
  });

  it('does not trip over somebody with no number at all', () => {
    // A placeholder holder and a vacant designation both reach this list; neither has a number,
    // and two of them must not match each other.
    expect(findDuplicate('Somebody Else', '', KNOWN)).toBeNull();
    expect(findDuplicate('Officer Juliet', '', KNOWN)?.on).toBe('name');
  });

  it('names where it looked, because the roster can only see one department', () => {
    const match = findDuplicate('Officer Charlie', '', KNOWN)!;
    expect(duplicateSentence(match, 'department')).toContain('this department');
    expect(duplicateSentence(match, 'district')).toContain('the directory');
  });
});
