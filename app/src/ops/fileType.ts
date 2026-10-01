/**
 * What a file **actually is** — M9-14.
 *
 * `ops/evidence.ts` has always kept an allow-list, and the allow-list has always been checked
 * against the `content-type` header **the uploading device chose**. A header is a claim, not a
 * fact: anything that can POST can call a PHP script `image/jpeg`, and the allow-list would wave
 * it through into a directory the server also reads from.
 *
 * Nothing downstream trusted that claim — `evidenceRoutes.ts` serves every file back as
 * `application/octet-stream` under `nosniff` and a `default-src 'none'; sandbox` CSP, which is
 * what has kept this safe. That is defence in depth doing its job, and it is not a reason to skip
 * the check: the day somebody adds a thumbnail preview, an "open in browser" link, or a virus
 * scanner that trusts the recorded type, the claim becomes load-bearing retroactively.
 *
 * ## What this is careful about
 *
 * **It reports what it finds, and reports nothing when it is not sure.** A sniffer that guesses
 * is worse than none: it would refuse a legitimate photograph on a bad day and let something
 * through on a worse one. `null` means *these bytes are not one of the formats this district
 * stores*, and the caller decides what that means.
 *
 * **The signatures are the boring, documented ones.** No heuristics, no entropy checks, no
 * partial matches. Every constant below is a magic number published in the format's own
 * specification, and each carries the specification's own words for it.
 */

/**
 * `ftyp` box brands, for the ISO base media formats — MP4, QuickTime, HEIC, M4A.
 *
 * All four are the same container with a different brand at byte 8, which is why they are one
 * table rather than four checks. Byte 4–7 is the literal `ftyp`; the length prefix before it is
 * not checked, because a valid file may declare any box size and we are identifying, not parsing.
 */
const FTYP_BRANDS: Readonly<Record<string, string>> = {
  // ISO/IEC 14496-12. `isom`, `mp42` and `avc1` are all ordinary MP4 from a phone.
  isom: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  dash: 'video/mp4',
  // QuickTime — what an iPhone writes when it is not writing MP4.
  'qt  ': 'video/quicktime',
  // HEIF/HEIC. `mif1` and `msf1` are the still-image brands; `heic`/`heix`/`hevc` the codec ones.
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  mif1: 'image/heic',
  msf1: 'image/heic',
  // Apple audio.
  M4A: 'audio/mp4',
  'M4A ': 'audio/mp4',
};

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

function asciiAt(bytes: Buffer, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return bytes.subarray(offset, offset + length).toString('latin1');
}

/**
 * The content type these bytes actually are, or null when they are not a format we store.
 *
 * Ordered cheapest and most certain first. Nothing here reads more than the first few dozen
 * bytes, so it is safe to call before deciding whether to keep a twenty-megabyte upload.
 */
export function sniff(bytes: Buffer): string | null {
  // %PDF-  — ISO 32000-1 §7.5.2. The header may be preceded by junk in tolerant readers; we
  // require it at offset 0, because a PDF with a prefix is not something the district produced.
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  // FF D8 FF — SOI followed by the first marker. ITU-T T.81. Every JPEG variant shares it:
  // JFIF, Exif and raw all differ only in the marker after.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // \x89PNG\r\n\x1a\n — RFC 2083 §3.1. The whole eight bytes, because the first four alone
  // are also the start of several unrelated formats.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // RIFF....WEBP — a RIFF container whose form type is WEBP. Both halves are required: RIFF
  // alone is also WAV and AVI, neither of which this district stores.
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';

  // ID3 — an MPEG audio file with a tag. The overwhelming majority of real mp3s.
  if (asciiAt(bytes, 0, 3) === 'ID3') return 'audio/mpeg';

  /**
   * `OggS` and then the codec's own identification header — RFC 3533 §6, RFC 7845 §5.1.
   *
   * **This is what a WhatsApp voice note is**, and until 2026-08-21 nothing in this district
   * could store one. An officer holding the microphone button is the fastest report there is
   * from a vehicle at 02:00, and it was the one kind of answer this system threw away.
   *
   * Both halves are required, in the same spirit as the RIFF check above: `OggS` alone is the
   * container, and the container also carries codecs this district has no way to play. The first
   * page of a logical stream carries exactly one segment, so the codec header sits at byte 28 —
   * 27 bytes of page header plus a one-byte segment table. A file that disagrees with that is
   * not one a handset produced.
   */
  if (asciiAt(bytes, 0, 4) === 'OggS') {
    // Opus is what a handset records; Vorbis is `01 'vorbis'`, kept because a district
    // machine converting one is the obvious next thing somebody does with it.
    if (asciiAt(bytes, 28, 8) === 'OpusHead') return 'audio/ogg';
    if (bytes[28] === 0x01 && asciiAt(bytes, 29, 6) === 'vorbis') return 'audio/ogg';
  }

  /**
   * A bare MPEG audio frame sync: eleven set bits, then a version and layer that are not the
   * reserved values.
   *
   * Deliberately strict. `FF Ex`/`FF Fx` alone matches far too much — it is two bytes, and two
   * bytes match noise. Requiring the version and layer fields to be legal makes a false positive
   * unlikely enough to be worth having, and an mp3 this rejects is one an operator can convert.
   */
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const version = (bytes[1]! >> 3) & 0x03;
    const layer = (bytes[1]! >> 1) & 0x03;
    if (version !== 0x01 && layer !== 0x00) return 'audio/mpeg';
  }

  // The ISO base media family — MP4, QuickTime, HEIC, M4A. `ftyp` at byte 4, brand at byte 8.
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4);
    const found = FTYP_BRANDS[brand] ?? FTYP_BRANDS[brand.trimEnd()];
    if (found !== undefined) return found;
  }

  return null;
}

export type SniffVerdict =
  | { readonly ok: true; readonly contentType: string }
  | { readonly ok: false; readonly why: string };

/**
 * Decide what to store a file as, given what the device claimed and what the bytes say.
 *
 * **The bytes win, always.** The declared type is kept as a separate fact about what the device
 * said — `evidence.content_type` records the sniffed type, and a mismatch is refused rather than
 * quietly corrected, because a device sending a PDF labelled `image/jpeg` is either broken or
 * probing, and both are worth a 415 rather than a silent fix.
 *
 * `allowed` is passed in rather than read from a constant here, because the two callers want
 * different lists: **evidence** attached to an incident accepts photographs, video, audio and
 * PDF, while a **communication attachment** accepts PDF and JPEG only (M9-16, the client's own
 * scope). One function, two lists, no second implementation of the comparison.
 */
export function decideType(
  declared: string,
  bytes: Buffer,
  allowed: ReadonlySet<string>,
): SniffVerdict {
  if (bytes.length === 0) return { ok: false, why: 'that file is empty' };

  const claimed = declared.split(';')[0]!.trim().toLowerCase();
  const actual = sniff(bytes);

  if (actual === null) {
    return {
      ok: false,
      why:
        `this does not look like a ${claimed} file — the content does not match any kind of ` +
        'file this system stores',
    };
  }

  if (!allowed.has(actual)) {
    return { ok: false, why: `${actual} is not a kind of file this system stores` };
  }

  /**
   * JPEG has two spellings and they mean the same thing.
   *
   * `image/jpg` is not a registered media type and is nonetheless what a good deal of software
   * sends. Refusing it would be technically correct and would lose a photograph of a scene.
   */
  const normalisedClaim = claimed === 'image/jpg' ? 'image/jpeg' : claimed;

  if (normalisedClaim !== actual) {
    return {
      ok: false,
      why: `this was sent as ${claimed} and the content is ${actual}`,
    };
  }

  return { ok: true, contentType: actual };
}
