/**
 * What a file actually is — M9-14, M9-19.
 *
 * The requirement is *"validate actual file content, not only extension"*, and the case that
 * matters is the one a header cannot catch: **a file that lies about itself.** Anything that can
 * POST can label a script `image/jpeg`, and until this existed the allow-list was checking that
 * label rather than the file.
 *
 * Nothing downstream ever trusted the label — evidence is served back as `octet-stream` under
 * `nosniff` and a sandbox CSP — so this is defence in depth rather than a hole being closed. It
 * is worth having anyway: the day somebody adds a thumbnail preview or an "open in browser"
 * link, the label becomes load-bearing retroactively, and that change will not think to check
 * whether the label was ever verified.
 */

import { describe, expect, it } from 'vitest';

import { decideType, sniff } from '../fileType.js';
import { ACCEPTED_TYPES, COMMUNICATION_TYPES } from '../evidence.js';

/** Real headers, from each format's own specification. Bodies are irrelevant to identification. */
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
]);
const MP3_TAGGED = Buffer.from('ID3\x03\x00\x00\x00', 'latin1');
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
]);
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
]);
const QUICKTIME = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypqt  ', 'latin1'),
]);

/**
 * **A WhatsApp voice note** — 2026-08-21, and it is the reason `audio/ogg` is on the list at all.
 *
 * An Ogg page header is 27 bytes plus a one-byte segment table, so the codec's identification
 * header sits at byte 28. `OggS` alone is deliberately not enough: the container also carries
 * codecs this district has no way to play.
 */
function ogg(codec: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from('OggS', 'latin1'),
    Buffer.alloc(23), // the rest of the page header
    Buffer.from([0x01]), // one segment
    codec,
  ]);
}
const OPUS = ogg(Buffer.from('OpusHead', 'latin1'));
const VORBIS = ogg(Buffer.concat([Buffer.from([0x01]), Buffer.from('vorbis', 'latin1')]));
const OGG_UNKNOWN = ogg(Buffer.from('SPEEX   ', 'latin1'));

describe('sniff', () => {
  it('recognises every format this district stores', () => {
    expect(sniff(PDF)).toBe('application/pdf');
    expect(sniff(JPEG)).toBe('image/jpeg');
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(WEBP)).toBe('image/webp');
    expect(sniff(MP3_TAGGED)).toBe('audio/mpeg');
    expect(sniff(MP4)).toBe('video/mp4');
    expect(sniff(HEIC)).toBe('image/heic');
    expect(sniff(QUICKTIME)).toBe('video/quicktime');
    expect(sniff(OPUS)).toBe('audio/ogg');
    expect(sniff(VORBIS)).toBe('audio/ogg');
  });

  /**
   * **`OggS` is the container, not the codec, and the check requires both.**
   *
   * Same reasoning as the RIFF check beside it: RIFF alone is also WAV and AVI. An Ogg carrying
   * something this district cannot play is reported as unknown rather than stored as audio it
   * would then be unable to open.
   */
  it('refuses an ogg carrying a codec this district cannot play', () => {
    expect(sniff(OGG_UNKNOWN)).toBeNull();
  });

  /**
   * A voice note is what an officer sends from a vehicle, and until 2026-08-21 this district
   * could not store one at all — `audio/ogg` was on no list, so the bytes were refused even
   * after the webhook learned to fetch them.
   */
  it('accepts a voice note as evidence', () => {
    expect(decideType('audio/ogg; codecs=opus', OPUS, ACCEPTED_TYPES)).toEqual({
      ok: true,
      contentType: 'audio/ogg',
    });
  });

  it('says nothing rather than guessing', () => {
    // A sniffer that guesses is worse than none: it refuses a real photograph on a bad day and
    // lets something through on a worse one.
    expect(sniff(Buffer.from('<svg onload="alert(1)"/>'))).toBeNull();
    expect(sniff(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull();
    expect(sniff(Buffer.from('MZ\x90\x00', 'latin1'))).toBeNull(); // a Windows executable
    expect(sniff(Buffer.from('PK\x03\x04', 'latin1'))).toBeNull(); // a zip, or a docx
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xff]))).toBeNull(); // one byte of what could have been a JPEG
  });

  it('does not mistake RIFF for WEBP without the form type', () => {
    // RIFF alone is also WAV and AVI, neither of which this district stores.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(sniff(wav)).toBeNull();
  });

  it('does not accept an ftyp box with a brand it does not know', () => {
    const odd = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypXXXX', 'latin1')]);
    expect(sniff(odd)).toBeNull();
  });

  it('requires the whole PNG signature, not the first four bytes', () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

describe('decideType — the bytes win', () => {
  it('accepts a file that is what it says it is', () => {
    expect(decideType('application/pdf', PDF, ACCEPTED_TYPES)).toEqual({
      ok: true,
      contentType: 'application/pdf',
    });
  });

  it('REFUSES a PDF wearing a JPEG label — the whole point', () => {
    const verdict = decideType('image/jpeg', PDF, ACCEPTED_TYPES);
    expect(verdict.ok).toBe(false);
    // Named plainly rather than as a generic 415, because the two causes need different
    // responses: a broken uploader is fixed, and a probe is noticed.
    if (!verdict.ok) expect(verdict.why).toContain('sent as image/jpeg');
  });

  it('REFUSES a script wearing an image label', () => {
    const verdict = decideType(
      'image/png',
      Buffer.from('<?php system($_GET["c"]); ?>'),
      ACCEPTED_TYPES,
    );
    expect(verdict.ok).toBe(false);
  });

  it('refuses an empty file before looking at anything else', () => {
    const verdict = decideType('application/pdf', Buffer.alloc(0), ACCEPTED_TYPES);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('empty');
  });

  it('accepts image/jpg, which is not a real media type and is what half the world sends', () => {
    // Refusing it would be technically correct and would lose a photograph of a scene.
    expect(decideType('image/jpg', JPEG, ACCEPTED_TYPES)).toEqual({
      ok: true,
      contentType: 'image/jpeg',
    });
  });

  it('ignores charset and other parameters on the declared type', () => {
    expect(decideType('application/pdf; charset=binary', PDF, ACCEPTED_TYPES).ok).toBe(true);
    expect(decideType('IMAGE/JPEG', JPEG, ACCEPTED_TYPES).ok).toBe(true);
  });
});

describe('a communication is narrower than evidence — M9-16', () => {
  it('takes PDF and JPEG', () => {
    expect(decideType('application/pdf', PDF, COMMUNICATION_TYPES).ok).toBe(true);
    expect(decideType('image/jpeg', JPEG, COMMUNICATION_TYPES).ok).toBe(true);
  });

  it('refuses a PNG that evidence would happily take', () => {
    // Not a security judgement — a scope one. The client asked for PDF and JPG/JPEG, and every
    // extra format on a WhatsApp attachment is one more thing that must open on every handset.
    expect(decideType('image/png', PNG, ACCEPTED_TYPES).ok).toBe(true);
    expect(decideType('image/png', PNG, COMMUNICATION_TYPES).ok).toBe(false);
  });

  it('refuses video, which evidence exists for and a notice does not', () => {
    expect(decideType('video/mp4', MP4, COMMUNICATION_TYPES).ok).toBe(false);
  });

  it('the two lists are actually different, so these tests cannot pass vacuously', () => {
    expect(COMMUNICATION_TYPES.size).toBeLessThan(ACCEPTED_TYPES.size);
    for (const type of COMMUNICATION_TYPES) expect(ACCEPTED_TYPES.has(type)).toBe(true);
  });
});
