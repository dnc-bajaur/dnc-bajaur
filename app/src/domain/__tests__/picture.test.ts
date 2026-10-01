/**
 * `validatePicture` — 2026-09-01.
 *
 * The value arrives from a browser and lands in a column served back to every signed-in officer
 * on the intake picker. So the two things under test are the two that matter: **shape** (only a
 * small set of inline rasters, base64, no `svg`, no remote URL) and **size** (a cap that catches
 * a photo nobody resized).
 */

import { describe, expect, it } from 'vitest';
import { validatePicture, PICTURE_MAX_BYTES } from '../picture.js';

// A real 1×1 PNG.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('validatePicture', () => {
  it('accepts a small PNG data URI and returns it canonicalised', () => {
    const r = validatePicture(PNG_1PX);
    expect(r).toEqual({ ok: true, value: PNG_1PX });
  });

  it('accepts JPEG and WebP', () => {
    for (const mime of ['jpeg', 'webp']) {
      const r = validatePicture(`data:image/${mime};base64,AAAA`);
      expect(r.ok).toBe(true);
    }
  });

  it('treats null and empty string as "remove it"', () => {
    expect(validatePicture(null)).toEqual({ ok: true, value: null });
    expect(validatePicture('')).toEqual({ ok: true, value: null });
    expect(validatePicture('   ')).toEqual({ ok: true, value: null });
  });

  it('strips data-URI parameters and surrounding whitespace', () => {
    const r = validatePicture(`  data:image/png;charset=utf-8;base64,AAAA  `);
    // The `;charset=utf-8` breaks the shape — a picture is exactly `data:image/<t>;base64,<b64>`.
    expect(r.ok).toBe(false);
  });

  it('refuses a remote URL where a data URI belongs', () => {
    const r = validatePicture('https://example.com/face.png');
    expect(r.ok).toBe(false);
  });

  it('refuses an SVG — a script vector on a screen a room can read', () => {
    const r = validatePicture('data:image/svg+xml;base64,PHN2Zy8+');
    expect(r.ok).toBe(false);
  });

  it('refuses a gif', () => {
    expect(validatePicture('data:image/gif;base64,AAAA').ok).toBe(false);
  });

  it('refuses non-base64 payloads', () => {
    expect(validatePicture('data:image/png;base64,not valid base64!!').ok).toBe(false);
  });

  it('refuses a picture over the size cap', () => {
    // base64 is 4 chars per 3 bytes, so this decodes to ~1.33× the cap.
    const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((PICTURE_MAX_BYTES * 4) / 3) + 8)}`;
    const r = validatePicture(oversized);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('KB');
  });

  it('refuses a non-string that is not null', () => {
    expect(validatePicture(42).ok).toBe(false);
    expect(validatePicture({}).ok).toBe(false);
    expect(validatePicture(undefined).ok).toBe(false);
  });
});
