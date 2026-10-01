/**
 * The words the district uses, in one place.
 *
 * Category codes and raw minute counts leaked onto the board the moment it became cards and
 * the text got larger: "rta" beside "Fire", and "1641m past deadline" where a person would
 * say "27 hours". Both were there before and were simply small enough to overlook.
 *
 * The mapping is duplicated on the server for the dashboard feed, which is deliberate: the
 * dashboard sends words because it is read by people who may never open the report form, and
 * the board translates locally because it already holds the code for filtering. Sharing one
 * module across the wire would mean the client could not filter without a round trip.
 */

const CATEGORY_WORDS: Record<string, string> = {
  rta: 'Road accident',
  fire: 'Fire',
  medical: 'Medical',
  flood: 'Flood',
  security: 'Security',
  // A rescue call that is not a road accident, a fire, a flood or a medical case — the
  // district's own thirteenth tile, 2026-08-24.
  rescue: 'Rescue emergency',
  other: 'Other',
};

/** Unmapped codes are shown as typed, capitalised — never invented into a nearby word. */
export function categoryWords(code: string): string {
  return CATEGORY_WORDS[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

/**
 * A duration a person would say out loud.
 *
 * Rounded down, and never more precise than it is useful: "27 hours" rather than
 * "27 hours 21 minutes", because nobody acts differently on the twenty-one.
 */
export function duration(mins: number): string {
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return `${String(mins)} min`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest === 0 || hours >= 6
      ? `${String(hours)} hr`
      : `${String(hours)} hr ${String(rest)} min`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${String(days)} days`;
}
