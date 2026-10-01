/**
 * The panel registry, and the layout the district composes from it — ADR-0015, M6-27…M6-29.
 *
 * ## The problem this is actually solving
 *
 * The district asked for a "unified screen, no scrolling". That reads as a layout problem and
 * is not one: **fourteen panels exist, roughly nine fit a 1920×1080 television, and the wrong
 * person was choosing which five to cut.** Every attempt to solve it by making things smaller
 * produced a screen nobody could read from across a room, which is the one thing an office
 * screen has to be.
 *
 * So the choice moves to the people who read it. A layout is configuration — rows in
 * `config_event` like every other setting (ADR-0001 applied to settings) — and the screen fits
 * because the district picked what is on it.
 *
 * ## Why a registry and not a free-form grid
 *
 * **Every panel carries an authority rule, and a layout engine that can place anything can
 * place a phone number on a wall.** `wallSafetyViolations` still walks the composed response
 * and still *fails* the request rather than stripping a field — but a grid that accepted
 * arbitrary content would make that check the only thing standing between an officer's mobile
 * and a screen a room can read (ADR-0013 §1). A registry means the set of things that can
 * appear on a wall is a list somebody wrote down, and adding to it is a code change that gets
 * reviewed.
 *
 * The registry is also what makes the editor honest: it knows a panel's plain-language name, so
 * an administrator arranges *"Emergency numbers"* and *"This system"* rather than `dashKeys`
 * and `dashCondition`.
 */

export type PanelSize = 'small' | 'medium' | 'large';

/** Who may see a panel at all. Enforced when the layout is resolved, never by the editor. */
export type PanelAudience =
  /** Everybody with a dashboard — the two offices and every department. */
  | 'all'
  /** The two administrative offices only. Theirs to fix, and nobody else's to be alarmed by. */
  | 'administration';

export interface PanelDefinition {
  readonly id: string;
  /** What an administrator sees in the editor. Never the element id. */
  readonly name: string;
  /** One sentence, so somebody choosing between fourteen of these can tell them apart. */
  readonly what: string;
  readonly audience: PanelAudience;
  /**
   * The sizes this panel is legible at.
   *
   * Not every panel survives every size, and that is a property of the content rather than a
   * preference: the district counters are five big numbers and read fine small; the department
   * table is eighty rows and is unreadable at anything but large. Offering a size that produces
   * an illegible panel is offering a way to break the screen.
   */
  readonly sizes: readonly PanelSize[];
  /** Roughly how much of a 1920×1080 screen it takes at each size. See `fits`. */
  readonly weight: Readonly<Record<PanelSize, number>>;
}

/**
 * How much of the target screen one panel occupies, in units of "one ordinary panel".
 *
 * The dashboard is a three-column grid, so a **medium** panel is one cell, a **large** one
 * spans two, and a **small** one is a cell with less in it — three-quarters, because the panel
 * chrome costs the same whatever is inside. Nine cells of it are above the fold on 1920×1080.
 *
 * Deliberately crude, and the crudeness is load-bearing. The exact answer depends on the
 * browser, the font, how much the district has configured into each panel and how much a
 * television crops — a precise model would be precisely wrong in the room. What this has to
 * support is one sentence, *"this will not fit"*, and being roughly right is enough for a
 * warning that is never a refusal (M6-32).
 *
 * **Calibrated against `DEFAULT_LAYOUT`, and a test pins that.** The default is nine panels the
 * district can read on day one; a model that called its own default too big would be a model
 * that cried wolf on the one arrangement it shipped with, and nobody would read the warning
 * again.
 */
const SLOTS_ON_1080P = 9;

const SMALL = 0.75;
const MEDIUM = 1;
const LARGE = 2;

function w(small = SMALL, medium = MEDIUM, large = LARGE): Record<PanelSize, number> {
  return { small, medium, large };
}

/**
 * Every panel the dashboard can show.
 *
 * **This list is the scope of what may appear on a wall.** Adding a row is a deliberate act
 * reviewed like any other code change — see the header on why that is the point.
 */
export const PANELS: readonly PanelDefinition[] = [
  {
    id: 'keys',
    name: 'District counters',
    // The owner's own five words, kept in step with the deck `web/src/dashboard.ts` actually
    // draws (2026-08-17, narrowed to five 2026-09-04 when `Issued`, `Acknowledged` and
    // `Not yet assessed` came off it — see that file's own header for the reasoning).
    what: 'Reported today, Responded, Resolved today, No one chosen, Message failed',
    audience: 'all',
    sizes: ['small', 'medium', 'large'],
    weight: w(),
  },
  {
    id: 'situation',
    name: 'Emergency situation',
    what: 'How each kind of emergency stands right now',
    audience: 'all',
    sizes: ['medium', 'large'],
    weight: w(),
  },
  /**
   * The two importance panels — M10-20…25/41/42.
   *
   * **One list, split in two, never one list with a badge.** M10-42 is the whole containment:
   * importance decides which of these two a row is *in*, and reads nothing else — the board, the
   * SLA clock and the escalation ladder never look at it. Splitting the panel rather than
   * flagging a row inside one is what makes that containment visible: a district that has never
   * marked anything routine sees an empty routine panel and a full important one, which is the
   * truth, rather than a mixed list with no way to tell the two apart at a glance.
   *
   * **`small` only, deliberately below the default 0.75 weight of an ordinary small panel.**
   * Both replace `situation` in `DEFAULT_LAYOUT` — see the note there — and `situation` weighed
   * 1 (medium). Two panels at the ordinary 0.75 would cost 1.5, overflowing the 9-slot budget by
   * the exact amount `panels.test.ts` refuses. `0.5` each keeps the combined cost at 1 — what was
   * freed — so nothing else the district asked for (weather, news) has to be evicted to make room.
   */
  {
    id: 'importantEmergencies',
    name: 'Important emergencies',
    what: 'Open emergencies marked important, most urgent first',
    audience: 'all',
    sizes: ['small'],
    weight: w(0.5),
  },
  {
    id: 'routineEmergencies',
    name: 'Routine emergencies',
    what: 'Open emergencies marked routine, most urgent first',
    audience: 'all',
    sizes: ['small'],
    weight: w(0.5),
  },
  {
    id: 'categories',
    name: 'Open by category',
    what: 'A count per category, leading to the board',
    audience: 'all',
    sizes: ['small', 'medium'],
    weight: w(),
  },
  {
    // ⚠️ THE ID STAYS `departments` AND ITS ROWS ARE OFFICERS — ADR-0029.
    //
    // A panel id is a key in the district's own stored layout (ADR-0015), so renaming it would
    // drop this panel off the wall of every district that had chosen it, silently, with nothing
    // on any screen saying why. What the district asked to change was the rows, not the handle.
    id: 'departments',
    name: 'Open by officer',
    what: 'What each officer is holding, and how much of it nobody has acknowledged',
    audience: 'all',
    // Eighty rows. Legible at one size, and offering the others would be offering a way to
    // produce a panel nobody can read from across a room.
    sizes: ['large'],
    // Eighty rows. Taller than a cell at every size, so it costs more than one.
    weight: w(1.5, 1.5, 2.5),
  },
  {
    id: 'utilities',
    name: 'Utilities',
    what: 'Power, water, gas and the rest, with how old each report is',
    audience: 'all',
    sizes: ['small', 'medium', 'large'],
    weight: w(),
  },
  {
    id: 'services',
    name: 'Markets, schools, hospital, roads',
    what: 'The same shape as a utility, reported the same way',
    audience: 'all',
    sizes: ['small', 'medium', 'large'],
    weight: w(),
  },
  {
    id: 'presence',
    name: 'Who is where',
    what: 'Presence by post — never by person (ADR-0013 §1)',
    audience: 'all',
    sizes: ['small', 'medium', 'large'],
    weight: w(),
  },
  {
    id: 'news',
    name: 'Pakistan headlines',
    what: 'Headlines from outside the district, with their source and their age named',
    audience: 'all',
    sizes: ['small', 'medium'],
    weight: w(),
  },
  {
    id: 'weather',
    name: 'Weather',
    what: 'The one panel that depends on a machine outside the district',
    audience: 'all',
    sizes: ['small', 'medium'],
    weight: w(),
  },
  {
    /**
     * Weather above, headlines below, in one frame — 2026-08-19, the owner's decision.
     *
     * ## This is a THIRD panel, not a replacement, and that is the whole of why it is safe
     *
     * `weather` and `news` are **left exactly where they are** and stay choosable on their own.
     * A district whose stored layout names either of them keeps rendering it — which is the one
     * thing merging them properly would have broken, and ADR-0015 says the arrangement is the
     * district's to hold, not ours to invalidate. What this row adds is the option of asking for
     * the pair as one thing.
     *
     * ## It draws nothing of its own
     *
     * On screen it is a frame: `applyLayout` moves the existing weather and news sections inside
     * it and strips their chrome. `renderWeather` and `renderNews` are untouched, every element
     * id is untouched, and the scene and the ticker keep running because neither is rebuilt.
     * A panel that re-implemented either would be a second renderer for one fold, which is the
     * mistake `incidentRow.ts` exists to have not made.
     *
     * ## Why the weight is 1.5 and not 0.75
     *
     * It is one column wide and two panels tall, so it costs what the two cost together — the
     * default's total is **unchanged at 8.75 of 9**. Calling it a small panel would tell
     * `fits()` the wall had gained a slot it has not, and this file's own header says the model
     * is only worth having while it refuses to flatter the default it ships with.
     */
    id: 'outside',
    name: 'Weather and Pakistan headlines',
    what: 'The two panels that are not about Bajaur, in one frame — weather above, news below',
    audience: 'all',
    sizes: ['small', 'medium'],
    weight: w(1.5, 2),
  },
  /**
   * **The things that do not finish at midnight** — the district's five, 2026-08-22.
   *
   * Security · Flood · Alert & Advisory · Meetings · Information, and it is **one panel with
   * five named lanes rather than five panels**, because they are five examples of one rule
   * (`domain/carrying.ts`). Five panels would have cost about 2.5 slots and would have forced
   * the question this design dissolves — *which box does a security alert go in?*
   *
   * ⚠️ **It is OPEN work, and the counters above it are TODAY's.** Two honest numbers
   * answering different questions on one screen is INV-04's trap, so the panel says which it is
   * **in words on the wall** and not only here.
   *
   * `medium`/`large` only. Eight rows carrying a lane, an age, a review mark and an attendance
   * tally are not legible in a small cell, and offering a size that produces an unreadable panel
   * is offering a way to break the screen.
   *
   * The weight is `activity`'s exactly, and that is not a coincidence: it replaces it in
   * `DEFAULT_LAYOUT`, so the wall's arithmetic does not move.
   */
  {
    id: 'stillRunning',
    name: 'Still running',
    what: "Meetings, floods, security, alerts and information that have not finished — with each one's age, and the control room closes them",
    audience: 'all',
    sizes: ['medium', 'large'],
    weight: w(1.5, 1.5, 2),
  },
  {
    id: 'activity',
    name: 'The last 24 hours',
    what: 'Alerts and emergency updates, twenty at a time, newest first — and how many more',
    audience: 'all',
    sizes: ['medium', 'large'],
    // Twenty rows. Taller than a cell at every size, so it costs more than one.
    weight: w(1.5, 1.5, 2),
  },
  {
    id: 'alerts',
    name: 'Advisories',
    what: 'What the two offices have told the district',
    audience: 'all',
    sizes: ['small', 'medium', 'large'],
    weight: w(),
  },
  {
    id: 'facts',
    name: 'District facts',
    what: 'Tehsils, union councils, population, area',
    audience: 'all',
    sizes: ['small'],
    weight: w(),
  },
  {
    id: 'resources',
    name: 'Fleet',
    what: 'What can be sent, and what is already out',
    audience: 'all',
    sizes: ['small', 'medium'],
    weight: w(),
  },
  {
    id: 'performance',
    name: 'Response times',
    what: 'Median minutes to acknowledge, per officer',
    audience: 'all',
    sizes: ['medium', 'large'],
    weight: w(),
  },
  {
    id: 'condition',
    name: 'This system',
    what: 'Backup, standby and whether WhatsApp can actually send',
    // The two offices only. A department shown three red rows it can do nothing about learns
    // to ignore red rows, and that habit costs something the day one of them is its own.
    audience: 'administration',
    sizes: ['small', 'medium'],
    weight: w(),
  },
  {
    id: 'reporting',
    name: 'Reporting gaps',
    what: 'How many utilities, services and posts have gone quiet',
    audience: 'all',
    sizes: ['small'],
    weight: w(),
  },
];

export function panelById(id: string): PanelDefinition | undefined {
  return PANELS.find((p) => p.id === id);
}

export interface PlacedPanel {
  readonly id: string;
  readonly size: PanelSize;
}

export interface Layout {
  readonly panels: readonly PlacedPanel[];
}

/**
 * What a district sees before it has chosen anything — M6-29.
 *
 * **Nine panels that fit 1920×1080**, and the choice of *which* nine is the one this file is
 * allowed to make, because somebody has to make it on day one. Everything the control room
 * needs to answer "what is happening" leads; the district's own condition is included because
 * it is the thing that fails silently; the department table is left out because it is the
 * panel most likely to be long and least likely to be read from across a room.
 *
 * Used when no layout is set **and when one is corrupt**. That second case matters more than it
 * sounds: a layout is edited by hand-typed configuration, and a screen that goes blank because
 * a row was malformed is a district that cannot see its own emergencies. A default that renders
 * is always better than an empty wall.
 */
export const DEFAULT_LAYOUT: Layout = {
  panels: [
    { id: 'keys', size: 'large' },
    /**
     * `importantEmergencies` and `routineEmergencies` replace `situation` here — M10-23.
     *
     * Not a deletion (ADR-0015): `situation`'s per-category breakdown is a different question
     * from importance and stays fully choosable. It comes off the *default* because it is the
     * one panel here that was never something the owner specifically asked to keep — unlike
     * weather and news, fought for by name on 2026-08-13 — so it is the "medium" this phase's own
     * weight budget can spend without evicting anything the district would notice missing.
     */
    { id: 'importantEmergencies', size: 'small' },
    { id: 'utilities', size: 'medium' },
    /**
     * `activity` replaces `alerts` in the default — M9-37, M9-38.
     *
     * Not an economy. The activity panel **already carries the advisories**, merged with the
     * emergency updates, because that is what "what has been happening" means to somebody
     * reading a wall. Keeping both would put every advisory on the screen twice, in two places
     * with two different ages — and the district would reasonably conclude that one of them was
     * wrong.
     *
     * The `alerts` panel itself is untouched and still choosable (ADR-0015): a district that
     * wants advisories alone, larger, can lay it out. What changed is the built-in nine.
     *
     * ~~`weather` comes out too.~~ **It went out here on 2026-08-13 and came back the same day,
     * at the owner's instruction.** The trade moved to `services` and `resources` instead — see
     * the note further down. Recorded rather than tidied away, because the reasoning that took
     * weather off was sound and the decision was still not mine to keep.
     */
    /**
     * ▶ **`stillRunning` replaces `activity` in the default — the district's five,
     * 2026-08-22, and the owner chose it.**
     *
     * Not a deletion (ADR-0015). `activity` stays in the registry, fully choosable, and a
     * district that wants *what has been happening* back can lay it out in one setting.
     *
     * It is the right panel to trade, for the same reason `alerts` was traded for `activity` in
     * the first place: **this panel largely carries what that one carried.** `activity` is a
     * rolling day of updates; the five are the things whose updates matter for longer than a
     * day, and every one of them shows here with its own age on it. What is genuinely lost is
     * the last 24 hours of the emergencies that DO clear at midnight — fire, road accidents,
     * medical — and those are on the Record, on the day they happened, which is where the
     * district said they belong.
     *
     * The weights are identical (1.5 at `medium`), so the wall's arithmetic and its measured
     * height are unchanged. Position is unchanged too, and that is geometry: this is one of the
     * three TALL panels, and the note further down explains why all three sit in one row.
     */
    { id: 'stillRunning', size: 'medium' },
    /**
     * **Weather is back, at the owner's instruction (2026-08-13): *"har surat mai"*.**
     *
     * It came off in Phase 7 to fit the twenty-row activity panel, and that was my call to
     * make and theirs to reverse. It is reversed.
     *
     * `news` joins it, for the reason they gave: *"proper live feel"*. A wall that only ever
     * shows the district's own bad news is a wall people stop looking at, and a room that has
     * stopped looking at the wall does not see the emergency either.
     *
     * **Two panels had to come off to fit them**, because the shipped default must not overflow
     * 1920×1080 (`panels.test.ts`) and a model that cries wolf on its own default is one nobody
     * reads again. `services` and `resources` went, and both remain choosable (ADR-0015):
     *
     *   * `services` is the same shape as `utilities`, reported the same way, and `utilities`
     *     stays — so the district keeps the pattern, at half the space.
     *   * `resources` answers *what can we send*, which the shift screen answers better and
     *     closer to the person who needs it. It is the only panel here whose question already
     *     has a better home.
     *
     * Neither is a deletion. Both are one setting away, and the console says so.
     */
    /**
     * ~~`weather` and `news` sat here as two rows.~~ **They are one frame on the wall since
     * 2026-08-19 — the owner asked for it, having seen them side by side.**
     *
     * `outside` is a **frame around those same two panels**, not a new rendering of them, and
     * both are still in the registry and still choosable on their own. So this is a change to
     * what the shipped default looks like, and to nothing else.
     *
     * The total is unchanged: 0.75 + 0.75 became 1.5.
     */
    { id: 'outside', size: 'small' },
    /**
     * ⚠️ **`routineEmergencies` and `presence` are LAST because they are the two SHORT panels,
     * and that is geometry rather than a judgement about them — measured 2026-08-19.**
     *
     * The wall is three columns and eight column-slots, so the bottom row always holds two of
     * the six single panels, and **the bottom row is what decides whether the wall fits 1080**.
     * `utilities` and `activity` render about 388px; the merged `outside` frame is about 380.
     * Put the frame in the bottom row and the wall ends at **1305** — 225px of the district's
     * home screen below the fold, which is M11-32/33's defect returning.
     *
     * Put all three tall panels in ONE row instead and the row is 388 either way: the frame
     * costs the wall **nothing**. That is the whole reason this order looks different from the
     * one it replaced, and it is why moving either of these two back up is not a tidy-up.
     */
    { id: 'routineEmergencies', size: 'small' },
    { id: 'presence', size: 'small' },
    /**
     * ~~`condition` was here.~~ **It came off the default on 2026-08-18 — M11-32/33.**
     *
     * ## It was measured off, not argued off
     *
     * The wall was rendered at 1920×1080 and every panel's box was read off the page. The
     * default laid out in four rows ending at **1385px on a 1080px screen**, and `condition`
     * was the fourth row on its own: `top: 1068`, `bottom: 1320`. **Twelve pixels of a
     * 252-pixel panel were above the fold.** Nobody in the control room has ever seen it. The
     * abstract weight model said the layout fitted — 8.75 of 9 — and it was wrong, which is
     * this project's own standing lesson: *look at the screen at the size it is read at.*
     *
     * ## And it is the right panel to lose
     *
     * Two reasons beyond the geometry, either of which would stand alone:
     *
     *   * It is `audience: 'administration'`, so it was never the district's shared reading —
     *     the wall's own job. Every other panel in this default answers *what is happening in
     *     Bajaur*; this one answers *is the software well*.
     *   * **That question now has a better home.** The administration console grew an overview
     *     and a Backups tab, where backup health is a table somebody can act on rather than
     *     three words on a wall four metres away. This is the same reasoning `resources` came
     *     off with: the only panels that leave are the ones whose question is answered better
     *     somewhere else.
     *
     * ## Not a deletion (ADR-0015)
     *
     * `condition` is untouched in the registry above and stays fully choosable. A district that
     * wants it on the wall lays it out and the console says so. What changed is the built-in
     * nine — which is a reviewed change to this file, which is exactly the reviewed act
     * ADR-0015 asks a layout change to be.
     *
     * The freed weight is deliberately **not** spent. The wall now fits the screen it is read
     * on, and the first thing to do with room on a screen that has never had any is to leave it
     * empty.
     */
  ],
};

export interface LayoutProblem {
  readonly panelId: string;
  readonly why: string;
}

export interface ResolvedLayout {
  readonly panels: readonly PlacedPanel[];
  /**
   * What was dropped, and why.
   *
   * Reported rather than swallowed. A panel that vanished because an administrator typed an id
   * that no longer exists is a configuration mistake somebody has to be told about — and the
   * editor is the only place they will ever see it.
   */
  readonly problems: readonly LayoutProblem[];
}

/**
 * Turn a stored layout into what this viewer may actually be shown.
 *
 * Three things happen here, and the second is a security boundary rather than tidying:
 *
 *   1. **Unknown ids are dropped, and reported.** A panel that was removed from the registry in
 *      a release leaves a stale row in a layout somebody wrote a year ago.
 *   2. **A panel above the viewer's audience is dropped**, whatever the layout says. The editor
 *      will not offer it, but an editor is not a control (INV-05) — a layout is data, and data
 *      can be written by a `config_event` somebody crafted.
 *   3. **A size the panel cannot be legible at is corrected**, not refused. The layout is still
 *      broadly what the district asked for, and refusing the whole thing over one bad size
 *      would take the screen down.
 */
export function resolveLayout(
  layout: Layout,
  viewer: { readonly isAdministration: boolean },
): ResolvedLayout {
  const panels: PlacedPanel[] = [];
  const problems: LayoutProblem[] = [];
  const seen = new Set<string>();

  for (const placed of layout.panels) {
    const definition = panelById(placed.id);

    if (definition === undefined) {
      problems.push({ panelId: placed.id, why: 'no panel with that id exists any more' });
      continue;
    }

    // The same panel twice is one panel. It happens: a list long enough to scroll is a list
    // somebody drags a row into twice.
    if (seen.has(placed.id)) continue;
    seen.add(placed.id);

    if (definition.audience === 'administration' && !viewer.isAdministration) {
      // Silently, and without a problem reported: this is not a mistake anybody made, it is
      // the panel doing what it is for. Reporting it would put "you are not allowed to see
      // this" on a department's own screen, which is the opposite of the intent.
      continue;
    }

    const size = definition.sizes.includes(placed.size)
      ? placed.size
      : (definition.sizes[definition.sizes.length - 1] ?? 'medium');

    if (size !== placed.size) {
      problems.push({
        panelId: placed.id,
        why: `${placed.size} is not a size this panel is legible at — showing it ${size}`,
      });
    }

    panels.push({ id: placed.id, size });
  }

  return { panels, problems };
}

/**
 * Roughly how much of a 1920×1080 screen this layout uses — M6-32.
 *
 * **A warning, never a refusal.** The district may know something this model does not: they may
 * be running a larger screen, they may be happy to scroll on a desk, or they may simply want
 * one more panel today. A tool that refuses on an estimate is a tool that gets worked around,
 * and the workaround is somebody keeping a second screen nobody maintains.
 */
export function fits(layout: Layout): { readonly slots: number; readonly overflows: boolean } {
  const slots = layout.panels.reduce((total, placed) => {
    const definition = panelById(placed.id);
    if (definition === undefined) return total;
    return total + (definition.weight[placed.size] ?? 1);
  }, 0);

  return { slots: Math.round(slots * 10) / 10, overflows: slots > SLOTS_ON_1080P };
}

/**
 * Read a layout out of whatever was stored, refusing to trust any of it.
 *
 * Returns null rather than throwing when the value is not a layout at all, so the caller can
 * fall back to the default. **A screen that goes blank because a configuration row was
 * malformed is a district that cannot see its own emergencies** — which is a worse outcome
 * than showing them a layout they did not choose.
 */
export function parseLayout(value: unknown): Layout | null {
  if (typeof value !== 'object' || value === null) return null;

  const panels = (value as { panels?: unknown }).panels;
  if (!Array.isArray(panels)) return null;

  const out: PlacedPanel[] = [];
  for (const entry of panels as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { id?: unknown; size?: unknown };
    if (typeof record.id !== 'string') continue;

    const size =
      record.size === 'small' || record.size === 'medium' || record.size === 'large'
        ? record.size
        : 'medium';

    out.push({ id: record.id, size });
  }

  // An empty list is a layout that shows nothing, which is never what anybody meant. Treated as
  // absent so the default renders.
  return out.length === 0 ? null : { panels: out };
}
