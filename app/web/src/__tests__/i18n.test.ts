/**
 * The Urdu word list and its lookup (Bajaur E4, ADR-0042).
 *
 * Pinned here: only whole phrases are replaced — nothing word by word, nothing guessed; a
 * `{placeholder}` carries its part across; and the shipped `web/ur.json` is well formed: every
 * placeholder on the English side appears on the Urdu side, so no number or name is dropped.
 * How the page applies it (and leaves `translate="no"` alone) is pinned in a real browser by
 * `activitiesUrdu.e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compile, translateMessage, translateText } from '../i18n.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('the lookup', () => {
  const dict = compile({
    'Sign out': 'سائن آؤٹ',
    'Pending ({n})': 'زیرِ التوا ({n})',
    'Department of {name}': '{name} کا محکمہ',
    Fire: 'آگ',
    'Category: {c}': 'قسم: {c}',
    'Not yet': '',
    '// a note': 'ignored',
  });

  it('replaces a known phrase, ignoring the white space around and inside it', () => {
    expect(translateText(dict, 'Sign out')).toBe('سائن آؤٹ');
    expect(translateText(dict, '  Sign\n   out ')).toBe('سائن آؤٹ');
  });

  it('carries a placeholder across', () => {
    expect(translateText(dict, 'Pending (3)')).toBe('زیرِ التوا (3)');
    expect(translateText(dict, 'Department of Amina Khan')).toBe('Amina Khan کا محکمہ');
  });

  it('translates a carried part only when it is itself a known phrase', () => {
    expect(translateText(dict, 'Category: Fire')).toBe('قسم: آگ');
    expect(translateText(dict, 'Category: Landslide')).toBe('قسم: Landslide');
  });

  it('never translates part of a phrase, or a phrase it does not know', () => {
    expect(translateText(dict, 'Sign out now')).toBeNull();
    expect(translateText(dict, 'Fire station')).toBeNull();
    expect(translateText(dict, 'Something else')).toBeNull();
  });

  it('lets a number placeholder match only a number', () => {
    const d = compile({ '{n} today': 'آج {n}', 'Showing only: {what}': 'صرف: {what}' });
    expect(translateText(d, '3 today')).toBe('آج 3');
    expect(translateText(d, 'Nothing reported today')).toBeNull();
    expect(translateText(d, 'Showing only: past deadline')).toBe('صرف: past deadline');
  });

  it('translates the known labels of a line joined by " · " or " — ", and only those', () => {
    const d = compile({ fire: 'آگ', issued: 'جاری', 'not in the Directory': 'ڈائریکٹری میں نہیں' });
    expect(translateText(d, 'fire — issued')).toBe('آگ — جاری');
    expect(translateText(d, '0300 · Amina Khan · not in the Directory')).toBe(
      '0300 · Amina Khan · ڈائریکٹری میں نہیں',
    );
    expect(translateText(d, 'fire · DNC-BAJAUR-4 — issued')).toBe('آگ · DNC-BAJAUR-4 — جاری');
    expect(translateText(d, 'Amina Khan · 0300')).toBeNull();
  });

  it('translates a dialog paragraph by paragraph', () => {
    const d = compile({
      'Remove {name}?': '{name} کو ہٹا دیں؟',
      'They stay in the record.': 'وہ ریکارڈ میں رہیں گے۔',
    });
    expect(translateMessage(d, 'Remove Amina Khan?\n\nThey stay in the record.')).toBe(
      'Amina Khan کو ہٹا دیں؟\n\nوہ ریکارڈ میں رہیں گے۔',
    );
    expect(translateMessage(d, 'Unknown\n\nThey stay in the record.')).toBe(
      'Unknown\n\nوہ ریکارڈ میں رہیں گے۔',
    );
  });

  it('skips an empty Urdu side and notes in the file', () => {
    expect(translateText(dict, 'Not yet')).toBeNull();
    expect(translateText(dict, '// a note')).toBeNull();
  });
});

describe('web/ur.json', () => {
  const raw = JSON.parse(readFileSync(join(here, '..', '..', 'ur.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('is a flat map of strings', () => {
    for (const [k, v] of Object.entries(raw)) {
      expect(typeof v, k).toBe('string');
    }
  });

  it('keeps every placeholder on the Urdu side', () => {
    for (const [en, ur] of Object.entries(raw as Record<string, string>)) {
      if (en.startsWith('//') || ur === '') continue;
      const names = [...en.matchAll(/\{([a-zA-Z0-9]+)\}/g)].map((m) => m[1]);
      for (const n of names) expect(ur, en).toContain(`{${n}}`);
    }
  });

  it('compiles', () => {
    expect(compile(raw as Record<string, string>).exact.size).toBeGreaterThan(100);
  });
});
