/**
 * A profile picture for a group or a contact — 2026-09-01.
 *
 * The district asked for the thing a phone's contact list has: a small round photo beside a
 * name. It is stored as a `data:` URI in a `text` column (migrations 0040, 0041), because the
 * alternative — a file on disk plus a token, like evidence — is a store, a route and a cleanup
 * job for something that is decoration, not record. Nothing here is folded into an incident and
 * nothing here is ever read while displaying one.
 *
 * ## Why the validation is strict rather than trusting
 *
 * The string arrives from a browser and lands in a column that is served back to every signed-in
 * officer, on the intake picker, on the machine that is also taking emergency reports. So the
 * two things that matter are **size** — the client resizes to ~128px before sending, and a
 * cap here is what stops a caller that did not — and **shape**: only the three raster types a
 * browser will render inline, only base64, no `svg` (a script vector on a page a room can read),
 * no remote `http(s)` URL smuggled in where a data URI is expected.
 *
 * `undefined` is *"the caller did not mention it"* and is the caller's to handle. `null` and the
 * empty string are *"remove it"*. Everything else is judged.
 */

/** Decoded-bytes ceiling. A 128px WebP is ~6–12 KB; this leaves generous room and still refuses a photo nobody resized. */
export const PICTURE_MAX_BYTES = 48 * 1024;

/** The only inline raster types worth rendering, and the only ones a browser will show from a `data:` URI without a download. */
export const PICTURE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PictureMime = (typeof PICTURE_MIME)[number];

const DATA_URI = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export type PictureResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly why: string };

/**
 * Judge a picture value on its way into the database.
 *
 * A caller that wants *"leave whatever is there"* checks for `undefined` before calling; this
 * function only ever sees a value somebody meant.
 */
export function validatePicture(raw: unknown): PictureResult {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, why: 'a picture must be a data: URI or empty' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };

  const match = DATA_URI.exec(trimmed);
  if (match === null) {
    return { ok: false, why: `a picture must be a base64 data: URI of ${PICTURE_MIME.join(', ')}` };
  }

  const base64 = match[2]!;
  // `Buffer.byteLength(base64, 'base64')` is the decoded size without allocating the buffer.
  const bytes = Buffer.byteLength(base64, 'base64');
  if (bytes === 0) return { ok: false, why: 'that picture is empty' };
  if (bytes > PICTURE_MAX_BYTES) {
    return {
      ok: false,
      why: `that picture is ${Math.round(bytes / 1024)} KB — it must be under ${PICTURE_MAX_BYTES / 1024} KB (the app resizes it for you)`,
    };
  }

  // Re-encode from the decoded bytes so what lands in the column is canonical: no whitespace,
  // no data-URI parameters, exactly the mime the regex matched.
  const mime = match[1] as PictureMime;
  const canonical = `data:${mime};base64,${Buffer.from(base64, 'base64').toString('base64')}`;
  return { ok: true, value: canonical };
}
