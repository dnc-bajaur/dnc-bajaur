/**
 * Location capture: a landmark the control room types, and nothing else — 2026-09-05.
 *
 * There are no reliable street addresses in this district, so this stays free text rather than a
 * validated address box. A report with no location typed is still a valid report — INV-01 never
 * refuses one for lacking it.
 *
 * **A device GPS fix rode alongside this for one day (2026-08-24 to 2026-09-05) and came out
 * again just as fast.** It watched `navigator.geolocation` in the background and, when a fix
 * arrived, turned it into a tappable Google Maps link on the outgoing WhatsApp message. The pin it
 * drew was wrong often enough that the owner asked for it removed rather than fixed: an officer
 * who taps a confident-looking link and arrives somewhere else has lost more than one who was
 * simply asked to type the place. The control room now writes the location by hand, exactly as it
 * writes everything else this report carries.
 */

export interface Capture {
  /** Free text typed by whoever reported it. Absent means nothing was typed. */
  readonly text?: string;
}

export function buildCapture(text: string): Capture {
  const trimmed = text.trim();
  return trimmed.length > 0 ? { text: trimmed } : {};
}
