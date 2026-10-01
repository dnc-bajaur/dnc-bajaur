/**
 * What a wall screen shows, and when it stops claiming to know — M4, ADR-0013.
 *
 * Pure logic, no database, no clock of its own. Everything here takes `now` as an argument
 * for the same reason the rest of the domain does: a rule about staleness that reads the
 * system clock cannot be tested at the boundary, and the boundary is the only interesting
 * part.
 *
 * The one idea worth holding on to: **a report has an age, and past a threshold it stops
 * being an answer.** The prototype this came from writes `Electricity (PESCO): Normal` in
 * the same typeface as a live incident count, and there is no way to tell that one was
 * counted a second ago and the other typed last Tuesday. On a screen people trust without
 * touching, that is the most expensive confusion in the system — a room full of officers
 * looking at a green dot from nine hours ago is worse off than a room with no screen, because
 * they would have picked up a phone.
 *
 * So nothing here returns a bare status. It returns a status **and** what is known about how
 * much that status is worth.
 */

/** How a utility is doing, as reported by whoever is answerable for it. */
export type UtilityStatus = 'normal' | 'degraded' | 'down';

/**
 * Whether an officer is available — ADR-0033.
 *
 * **Two states, set by hand.** M9-31 made this a five-answer list — present · absent · office ·
 * field · leave — on the theory that a control room at 02:00 wants both *is this person
 * reachable* and *where are they*. The district asked for only the first:
 *
 *   > *"ju officer avaialble hai unko available and ju nhe hai un ko unavailable mark hum manual
 *   > kare"*
 *
 *   * `available`   — the control room may send this officer something
 *   * `unavailable` — it may not
 *
 * The old five fold in deterministically (migration 0046): present/office/field → `available`,
 * absent/leave → `unavailable`. The location detail is genuinely lost; the district traded it
 * away for a control that answers the one question it is asked.
 *
 * Nothing polls an officer, so nothing about this expires — ADR-0025's answer to the utility
 * timer, applied here. A reading stands until the control room changes it. `NEEDS_END` is
 * therefore gone: there is no answer that must state when it ends.
 */
export type PresenceStatus = 'available' | 'unavailable';

/** In the order the Status screen draws them, so no screen invents its own sequence. */
export const PRESENCE_STATUSES: readonly PresenceStatus[] = ['available', 'unavailable'];

/**
 * What the screen may say about a panel's value.
 *
 * `fresh` — reported recently enough to be worth acting on
 * `stale` — reported, but too long ago to assert; the screen shows *when*, not *what*
 * `never` — nobody has ever reported this
 *
 * `stale` and `never` are separate because they call for different actions. A stale reading
 * means somebody stopped updating; an absent one means nobody was ever asked to.
 */
export type Freshness = 'fresh' | 'stale' | 'never';

export interface Aged<T> {
  readonly value: T | null;
  readonly freshness: Freshness;
  /** When the value was last reported. `null` exactly when `freshness` is `never`. */
  readonly asOf: string | null;
  /** Whole minutes since `asOf`, floored. `null` when nothing has been reported. */
  readonly ageMinutes: number | null;
}

/**
 * Decide whether a report still speaks for the present.
 *
 * A future `reportedAt` is treated as age zero rather than as a negative age. It happens —
 * a handset with a wrong clock, a report backdated by a minute — and the alternative is a
 * panel that reads "updated -3 minutes ago", which looks like a bug and hides the value.
 *
 * ## `staleMinutes: null` means the report never expires on its own — ADR-0025, 2026-08-23
 *
 * **The district asked for this in plain words:** *"koi time cap nhe dena chah rahe hain … hum
 * es ko khud hi manually handle karenge … control wale control karenge, close karenge"*. A
 * public utility is not a sensor that stops answering. It is a **statement a person made** —
 * *twelve-hour loadshedding* — and that statement does not become false because a clock
 * passed a threshold nobody in Bajaur chose.
 *
 * What the cap actually produced was worse than no cap: Electricity carried the install
 * default of four hours against a twelve-hour schedule, so the wall replaced a true sentence
 * with *no report since 08:00* every single day, and the district learned to read the wall as
 * broken rather than as informative.
 *
 * ⚠️ **This is not INV-02 being waived, and the difference is the whole argument.** INV-02
 * forbids rendering stale data **as current** — it does not require a value to be withdrawn on
 * a timer. The age still travels with every reading (`asOf`, `ageMinutes`) and the wall still
 * prints it beside the status, climbing between polls. A reader is never told the report is
 * fresh; they are told exactly how old it is and left to judge it, which is what the people
 * who run the district asked to be allowed to do.
 *
 * ⚠️ **Presence passes `null` too now — ADR-0033.** The district asked for the availability
 * timer gone the same way it asked for the utility one: *"hum manual kare"*. Nothing polls an
 * officer, so a reading stands until the control room changes it. INV-02 is still met — the age
 * rides every reading and the wall prints it — presence is *dated*, it just no longer degrades.
 */
export function age<T>(
  value: T | null,
  reportedAt: string | null,
  staleMinutes: number | null,
  now: Date,
): Aged<T> {
  if (value === null || reportedAt === null) {
    return { value: null, freshness: 'never', asOf: null, ageMinutes: null };
  }

  const then = new Date(reportedAt).getTime();

  if (Number.isNaN(then)) {
    return { value: null, freshness: 'never', asOf: null, ageMinutes: null };
  }

  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60_000));

  return {
    // The value is still carried when stale. The screen chooses not to lead with it; a
    // caller asking "what was the last thing anybody said" deserves an answer either way.
    value,
    freshness: staleMinutes !== null && minutes > staleMinutes ? 'stale' : 'fresh',
    asOf: reportedAt,
    ageMinutes: minutes,
  };
}

/**
 * How a utility panel reads out loud.
 *
 * **There is no longer a stale form, and that is ADR-0025 rather than an omission.** This
 * function used to answer `no report since 08:00` once a reading passed its window — a
 * different sentence, about time, that did not contain the status at all. The district asked
 * for that to stop: what the control room last said stands until the control room says
 * something else.
 *
 * `age()` called with a null window can no longer return `stale`, so a stale branch here would
 * be a branch that never runs — and a reader would take it as live behaviour and plan around a
 * rule the software no longer has. **The `clock` parameter went with it** rather than being
 * kept against a possible future: an argument every caller must supply and no line reads is
 * the same lie in a quieter form. `presenceLabel` no longer takes one either — ADR-0033 took
 * the availability timer away, so it has no stale form left.
 */
export function utilityLabel(reading: Aged<UtilityStatus>): string {
  if (reading.value === null) return 'not reported';

  return { normal: 'Normal', degraded: 'Degraded', down: 'Down' }[reading.value];
}

/**
 * How an availability row reads out loud — ADR-0033.
 *
 * `never` is *nobody has said yet* (ADR-0005, a gap is stated). There is no `stale` form: with a
 * null window `age()` cannot return it, and the district asked for the timer gone.
 */
export function presenceLabel(reading: Aged<PresenceStatus>): string {
  if (reading.value === null) return 'not reported';

  return { available: 'Available', unavailable: 'Unavailable' }[reading.value];
}

/**
 * The age of an availability reading — ADR-0033.
 *
 * A thin wrapper on `age()` with a null window: nothing polls an officer, so a reading is fresh
 * from the moment it is set until the control room sets it again. The wall still prints the age
 * beside the word (INV-02 — dated, not degraded). `until_at` is inert on the table and read by
 * nothing, on ADR-0025's precedent for `stale_minutes`.
 */
export function presenceAge(
  status: PresenceStatus | null,
  reportedAt: string | null,
  now: Date,
): Aged<PresenceStatus> {
  return age(status, reportedAt, null, now);
}

/**
 * Whether the whole district is reporting at all.
 *
 * A wall screen full of "not reported" panels has failed, and it has failed quietly — every
 * individual panel is telling the truth. This counts the failure so the screen can say it
 * once, in a sentence, rather than leaving a person to notice that eleven small greyed boxes
 * add up to something.
 */
export function reportingGap(readings: readonly Aged<unknown>[]): {
  readonly total: number;
  readonly answering: number;
  readonly quiet: number;
} {
  const answering = readings.filter((r) => r.freshness === 'fresh').length;

  return { total: readings.length, answering, quiet: readings.length - answering };
}

/**
 * The privacy rule of ADR-0013 §1, as a function rather than as a paragraph in a document.
 *
 * A wall screen is read by whoever is in the room. This is the boundary that erodes: the
 * single most requested feature of a control-room display is the one it must not have, and
 * it will be requested by somebody senior, in a hurry, with a good reason. So the rule is
 * executable and a test walks the real response through it.
 *
 * It looks for the shapes that identify a person rather than for particular fields, because
 * a field-name allowlist protects only against the mistakes somebody already thought of.
 */
/**
 * A uuid, exactly.
 *
 * Checked *before* the shapes below, and it is not a nicety. A uuid is 32 hex characters, so
 * some of them contain a run that reads as a Pakistani number — `…-0207-00f846…` is one
 * digit away. This fired for real: the dashboard started returning 500 for every caller
 * because one seeded utility happened to draw an unlucky id, and the error blamed a phone
 * number that was not there.
 *
 * Skipping them is safe in the direction that matters: a uuid identifies a row, not a person,
 * and nothing in this system encodes a number as one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A string that is **entirely** a web address — added 2026-08-19, when headlines became links.
 *
 * ## This is the uuid lesson arriving a second time, and it was going to arrive
 *
 * Google News addresses an article by a long machine-generated token —
 * `…/rss/articles/CBMiW2h0dHBzOi8v…` — and a token drawn from an alphabet that includes digits
 * will eventually contain a run of nine that reads as `0333-1234567`. The consequence is not a
 * wrong headline. `wallSafetyViolations` **fails the request**, so one unlucky article would
 * blank the dashboard in the DC office for every caller, and the error would name a phone
 * number that does not exist. That is exactly what one unlucky seeded uuid did above.
 *
 * ## What the exemption does and does not cover
 *
 * **The phone shape is skipped; the coordinate shape is not** — see `inLinks` below. Skipping
 * the digit run is safe in the direction that matters, on the same reasoning as the uuid: a web
 * address names a published page, not a person, and nothing here encodes a district phone
 * number as one. A coordinate is a different matter — `…/maps?q=34.715,71.514` would put an
 * incident's location on the wall, and base64 carries neither a dot nor a comma, so keeping
 * that rule live costs this nothing and closes the one leak a link could actually carry.
 *
 * `^…$` and no whitespace, deliberately. A sentence that *contains* a link is prose somebody
 * wrote, and prose is where a number hides — the same reason the uuid exemption is anchored.
 */
const LINK = /^https?:\/\/\S+$/i;

const FORBIDDEN: readonly {
  readonly what: string;
  readonly re: RegExp;
  /** Whether this rule still applies to a string that is nothing but a web address. */
  readonly inLinks: boolean;
}[] = [
  // Pakistani mobile and landline forms, with or without separators or country code.
  { what: 'a phone number', re: /(\+?92|0)\s?\d{2,4}[\s-]?\d{6,8}/, inLinks: false },
  // Bare coordinates. Two signed decimals with three or more places, next to each other.
  { what: 'a coordinate', re: /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/, inLinks: true },
];

/** Field names that carry a private value even when its shape is innocent. */
const FORBIDDEN_KEYS: readonly string[] = [
  'phone',
  'contactPhone',
  'reporterName',
  'reporterPhone',
  'fullName',
  'personId',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'address',
  'description',
];

/**
 * Returns the reasons a payload may not go on a wall, or an empty array.
 *
 * Empty means it passed. It never throws: the caller decides whether a violation is a refused
 * response or a failed test, and both are wanted in different places.
 */
export function wallSafetyViolations(payload: unknown): string[] {
  const found: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      if (UUID.test(node)) return;

      const link = LINK.test(node);

      for (const rule of FORBIDDEN) {
        if (link && !rule.inLinks) continue;
        if (rule.re.test(node)) found.push(`${path} looks like ${rule.what}`);
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${path}[${String(i)}]`);
      });
      return;
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.includes(key)) {
          found.push(`${path}.${key} is not permitted on a wall screen`);
          continue;
        }
        walk(value, `${path}.${key}`);
      }
    }
  };

  walk(payload, '$');

  return found;
}
