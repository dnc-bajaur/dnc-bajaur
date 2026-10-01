/**
 * The district's own number — 2026-08-24.
 *
 * `DNC-BAJAUR-1`, `DNC-BAJAUR-2`, and on. One incident, one number, for the whole life of the
 * installation.
 *
 * The owner asked for this after reading the detail screen and finding the line above the
 * buttons unusable: *"Incident 297e3fba-accf-4298-808a-c3c4d01d3337"*. A uuid is the right
 * identity for the software — it is generated on the handset before any network attempt, which
 * is what makes an offline retry a no-op rather than a duplicate (ADR-0002) — and it is the
 * wrong identity for a control room that rings people. Their reason for the shape they asked
 * for is the second half of the feature: *"es ka faeda ye hoga k aik qesam ka counter bhi mil
 * jaega 1 sai"* — the highest number is how many emergencies the district has recorded.
 *
 * **This module is the only place that knows the format**, and that is what makes the number
 * safe to print. A second `` `DNC-BAJAUR-${n}` `` on a screen somewhere is how the board and the
 * report begin quoting one incident two ways.
 *
 * Nothing here touches the record. The number is assigned by the primary after the events
 * commit (`db/referenceStore.ts`) and travels beside the fold, never inside it — see
 * `db/migrations/0035_incident_reference.sql` for why it is not an event.
 */

/**
 * The district, in the number.
 *
 * A constant rather than configuration, on the same terms as `DISTRICT_TIMEZONE`: this is one
 * district's installation and has been since the first line of it. A second district gets its
 * own deployment, its own database and its own counter starting at 1 — which is the correct
 * answer anyway, because two districts sharing one counter would interleave their numbers and
 * neither could say how many emergencies it had had.
 */
export const REFERENCE_PREFIX = 'DNC-BAJAUR';

/**
 * The number as the district writes it.
 *
 * **Not padded.** `DNC-BAJAUR-0001` sorts prettily in a file listing and lies about the size of
 * the thing being counted — it says the district planned for ten thousand and has had one. The
 * counter reads `1`, `2`, `17`, `342`, and the width grows when the district does.
 */
export function formatReference(seq: number): string {
  return `${REFERENCE_PREFIX}-${String(seq)}`;
}

/**
 * Read a number back out of whatever somebody typed into search.
 *
 * Forgiving about the separators and the case, and about nothing else. An officer reading a
 * number off a slip types `dnc-bajaur 42`, `DNC BAJAUR 42` or `DNCBAJAUR42` depending on the
 * handset, and a search that answered "nothing found" to two of those would send them back to
 * asking the control room.
 *
 * **A bare `42` counts too**, and that is a judgement rather than an oversight. It is what
 * somebody actually types, and the caller (`api/search.ts`) *adds* the referenced incident to
 * the text results rather than replacing them — so a district where `42` is also a house number
 * in a description gets both, and neither reading is lost.
 *
 * Returns null for anything that is not a whole positive number, `0` and leading-zero forms
 * included: `DNC-BAJAUR-0` was never issued (the counter starts at 1) and `DNC-BAJAUR-007` is a
 * different string from the number seven, so treating them as found would teach the district a
 * format this system does not print.
 */
export function parseReference(text: string): number | null {
  /**
   * Only the separators this number is ever written with — space, hyphen, underscore.
   *
   * ⚠️ **Not "everything that is not a letter or a digit"**, which is what this said first and
   * what a test caught within the hour: stripping a decimal point turns `4.2` into `42` and
   * opens somebody else's emergency. A separator an officer might type is forgiven; a character
   * that changes what the number *is* never can be.
   */
  const squashed = text
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]/g, '');
  if (squashed.length === 0) return null;

  const bare = REFERENCE_PREFIX.replace(/[\s\-_]/g, '');
  const digits = squashed.startsWith(bare) ? squashed.slice(bare.length) : squashed;

  // `^[1-9]\d*$` rather than a parseInt: `42abc` and `4.2` are not references, and parseInt
  // would read both as 42 and hand back an incident nobody asked for.
  if (!/^[1-9]\d*$/.test(digits)) return null;

  const seq = Number(digits);
  // Beyond this a number is no longer exact in JavaScript, and an inexact incident number is
  // worse than none — it would open a different emergency.
  return Number.isSafeInteger(seq) ? seq : null;
}
