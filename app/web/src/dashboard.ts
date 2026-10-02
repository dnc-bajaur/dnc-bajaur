/**
 * The dashboard screen — M4.
 *
 * One module, one set of markup, and the browser decides how much of it stands side by side.
 * There is deliberately nothing here that asks how wide the window is: every layout decision
 * lives in CSS, where it can respond to a window being resized, a phone being turned, or a
 * screen nobody predicted. Code that branched on width would be a second implementation to
 * keep in step with the first, which is precisely what was asked not to happen.
 *
 * What this file is careful about:
 *
 * **Most values carry their age — the three status panels no longer do.** A panel reporting the
 * power was normal four hours ago is a different fact from one reporting it a minute ago, and on
 * a screen somebody glances at from across a room that difference is usually the whole point.
 * Alerts, incidents, weather and the headlines still print it and keep it climbing.
 *
 * ⚠️ **District services, Public utilities and Officers are the exception, on instruction.** The
 * district asked twice for the age gone from those cards and it is gone — see `renderStatusList`
 * and ADR-0037 for what that costs and why it was still the right call to make theirs. Officers
 * keep INV-02 through degradation; the two condition panels no longer meet it at all.
 *
 * **It writes text, never HTML.** Every string here is the district's own data: a department
 * name somebody typed, a note an officer wrote. None of it is a thing to hand to an HTML
 * parser.
 *
 * **One panel's failure costs one panel.** Found the hard way: a feed missing a single field
 * threw partway through, and the six panels after it silently never rendered — four numbers
 * and five empty boxes, which looks exactly like a quiet district.
 */

/**
 * `reducedMotion` lives in `tilt.ts` and is imported rather than declared here.
 *
 * It used to be a local function in this file. `tilt.ts` needs the same answer, and the rule
 * this project keeps paying for is that one rule written in two places agrees only until
 * somebody edits one of them. The module the rule is *about* owns it.
 */
import { mountTilt, reducedMotion, stripTiltStyles, makeCard } from './tilt.js';
import { isNight, mountWeatherScene, sceneFor, type WeatherScene } from './weather.js';
import { openDrawer } from './drawer.js';
import { dateLocale } from './i18n.js';

interface PanelRow {
  name: string;
  status: string | null;
  label: string;
  freshness: 'fresh' | 'stale' | 'never';
  asOf: string | null;
  ageMinutes: number | null;
  note: string | null;
  /**
   * The officer who holds this post — availability panel only (ADR-0033).
   *
   * `name` is the designation; this is the person. Both on the wall, which is a scoped
   * exception to ADR-0013 §1 the district asked for. Absent on the utility and service rows
   * that share this renderer.
   */
  officer?: string | null;
}

interface Gap {
  total: number;
  answering: number;
  quiet: number;
}

export interface DashboardFeed {
  asOf: string;
  scope: string;
  isAdministration: boolean;
  district: {
    openIncidents: number;
    today: number;
    unassigned: number;
    overdueUnacknowledged: number;
    unassessed: number;
    oldestUnassignedMinutes: number | null;
    /**
     * The district's own words, counted over live incidents — the deck's main row.
     *
     * Three now, not four (narrowed 2026-09-04 — `acknowledged` is gone with the stage,
     * `domain/stages.ts`'s header has the reason). Mirrors `api/dashboard.ts`'s
     * `district.stages`. This file keeps its own copy of the feed's shape because the client
     * bundle is fetched at runtime and imports nothing from the server; the two are held
     * together by `dashboard.test.ts` and by the browser suite, not by a type.
     */
    stages: {
      issued: number;
      responded: number;
      resolved: number;
    };
    /** Live emergencies nobody has been chosen to be told about — M6-09. */
    nobodyTold: number;
    /**
     * Live emergencies every recipient declined — RX-03, 2026-08-25.
     *
     * ⚠️ **Optional, and absent is not zero.** This screen can meet a server older than
     * itself, and an absent field means *that server cannot answer this*. Drawing `0` would be
     * the wall asserting nothing has been declined, in a district where nobody has looked.
     */
    ownerless?: number;
    /**
     * **What is not today's** — the carry-over strip, 2026-08-19.
     *
     * **Optional, and that is not defensive coding.** This screen is fetched at runtime and an
     * installation may be running a server from before the field existed; a dashboard that threw
     * because a district had not been upgraded would take the whole wall down over a strip.
     * Absent means *this server does not answer that question*, which is a different thing from
     * zero and is drawn as nothing rather than as "0 still open".
     */
    carriedOver?: {
      resolvedToday: number;
      stillOpen: number;
      oldestOpenAt: string | null;
    };
    /**
     * The last day's shape behind each counter — M9/L7. Optional: an older server does not send
     * it, and a tile without a sparkline is the tile this screen had until today.
     */
    trend?: {
      hours: number;
      openIncidents: number[];
      stageIssued: number[];
      stageResponded: number[];
      stageResolved: number[];
      overdueUnacknowledged: number[];
      nobodyTold: number[];
      ownerless?: number[];
      notificationsUnmet: number[];
      unassessed: number[];
      today: number[];
    };
  };
  categories: { category: string; label: string; open: number }[];
  situation: {
    category: string;
    label: string;
    state: 'ok' | 'pending' | 'critical';
    status: string;
    open: number;
    lastAt: string | null;
  }[];
  facts: { label: string; value: string | null }[];
  resources: {
    total: number;
    available: number;
    committed: number;
    outOfService: number;
    scope: string;
  };
  performance: { name: string; open: number; overdue: number; medianAckMinutes: number | null }[];
  notificationsUnmet: number;
  alerts: { tag: string; message: string; issuedAt: string; untilAt: string }[];
  /** Headlines from outside the district — M9-59. Absent on an older server. */
  news?: {
    headlines: {
      title: string;
      publishedAt: string | null;
      outlet: string | null;
      /** Where the story is. Optional: an older server sends none, and a row without one is
       *  rendered as text rather than dropped. */
      url?: string | null;
      /** Which edition. Absent on an older server, and absent reads as English. */
      lang?: 'ur' | 'en';
    }[];
    source: string;
    fetchedAt: string | null;
    ageMinutes: number | null;
  };
  /**
   * **The district's day**, windowed by the server — M9-38, M9-40, rewindowed 2026-08-19.
   *
   * ⚠️ `hours` is gone. The window is a day now, so a number of hours is a figure this panel
   * cannot honestly print; `since` says where it starts and is what the screen reads.
   */
  activity?: {
    since: string;
    total: number;
    hidden: number;
    more: string | null;
    visible: { at: string; kind: string; headline: string; detail: string | null }[];
  };
  /**
   * Open emergencies, split by importance and capped independently — M10-24/42. Absent on an
   * older server, on the same terms as `activity`.
   */
  importantEmergencies?: {
    total: number;
    hidden: number;
    more: string | null;
    visible: {
      at: string | null;
      headline: string;
      detail: string | null;
      acknowledged: boolean;
    }[];
  };
  routineEmergencies?: DashboardFeed['importantEmergencies'];
  /**
   * The district's five — 2026-08-22. **Optional, and absent is not empty**: this screen is
   * fetched at runtime and may meet a server older than itself, so an absent field means *this
   * server does not send one* and the honest answer is to draw nothing.
   */
  stillRunning?: {
    visible: readonly {
      incidentId: string;
      lane: string;
      headline: string;
      detail: string | null;
      since: string | null;
      lastRecordedAt: string | null;
      reviewMark: string | null;
      reviewLabel: string;
      attendance: string | null;
      reason: string;
    }[];
    hidden: number;
    total: number;
    more: string | null;
  };
  services: PanelRow[];
  departments: { name: string; open: number; unacknowledged: number }[];
  /**
   * ADR-0029 — what each OFFICER is holding, folded from who the control room chose to tell.
   *
   * Optional because this bundle is fetched at runtime and can meet an older server; absent
   * means *this server does not send one*, never zero. `departments` above it is kept and is
   * always empty — nothing writes it any more.
   */
  officers?: { name: string; open: number; unacknowledged: number }[];
  condition: { what: string; state: 'ok' | 'pending' | 'critical'; detail: string }[];
  utilities: PanelRow[];
  presence: PanelRow[];
  reporting: { utilities: Gap; services: Gap; presence: Gap };
  weather: {
    reading: {
      temperatureC: number | null;
      apparentC: number | null;
      humidity: number | null;
      windKph: number | null;
      precipitationChance: number | null;
      /**
       * The WMO code, which the server has always sent and this file has never read — declared
       * 2026-08-19, when the panel learned to draw the weather as well as print it.
       *
       * Optional, because an older server predates nothing here but a newer client must still
       * render against one: absent draws **no scene**, which is the panel exactly as it was.
       */
      code?: number | null;
      condition: string;
      sunrise: string | null;
      sunset: string | null;
    } | null;
    fetchedAt: string | null;
    ageMinutes: number | null;
  };
  /**
   * What to draw, in order, and how big — ADR-0015, M6-30.
   *
   * Optional so an older cached shell against a newer server still renders every panel rather
   * than none. `applyLayout` treats an absent layout as "leave the markup alone", which is the
   * arrangement this file shipped with.
   */
  layout?: { id: string; size: 'small' | 'medium' | 'large' }[];
}

/**
 * Where a panel leads.
 *
 * The dashboard deliberately grows **no detail view of its own**. Every panel hands off to a
 * screen that already answers the next question — the board for emergencies, Status for the
 * things somebody reports, the console for the system's own condition. A second detail view
 * beside the board's would drift from it, and the two would disagree in front of an operator.
 */
export interface DashboardLinks {
  /** `category` is the stored code the rows carry; `label` is what a person is shown. */
  onOpenCategory?: (category: string, label: string) => void;
  onOpenDepartment?: (name: string) => void;
  /**
   * A district counter, opened on exactly what it counted.
   *
   * The flag is the *server's* name for the set — the board filters on an attribute the
   * server put on each row, so a counter reading 5 lands on 5 rows. `open` means "everything
   * live", which is the board with no filter at all.
   */
  onOpenFlag?: (
    flag:
      | 'unacknowledged'
      | 'today'
      | 'unmet'
      | 'nobodyTold'
      | 'ownerless'
      | 'unassessed'
      | 'stageIssued'
      | 'stageResponded'
      | 'stageResolved'
      | 'open',
  ) => void;
  /**
   * Open **one carried thing**, on the screen that can actually do something about it.
   *
   * Every other link here opens a *set* — a category, a department, a counter's own rows.
   * This one opens a single incident, because that is the question a row on **Still running**
   * raises: *is this still running, and if it is finished, who closes it?* Neither answer
   * exists on a wall — closing is an act, with a reason, by a named person (ADR-0003) — so
   * the panel hands the incident to the board and stops there.
   *
   * 🔴 **The dashboard does not grow a detail view of its own.** The comment on this
   * interface has said so since it was written, and a second one beside the board's would drift
   * from it and then disagree with it in front of an operator.
   */
  onOpenIncident?: (incidentId: string) => void;
  onOpenStatus?: () => void;
  onOpenAdmin?: () => void;
  /**
   * Open the console on a department — M6-15.
   *
   * It opened the signal editor until ADR-0022 removed it. The journey is the one that
   * mattered: a department's row on the Dashboard is where somebody notices something about
   * that department, and the console is where they can act on it.
   *
   * `null` means "the departments screen, no department chosen".
   */
  onOpenDepartmentInConsole?: (departmentName: string | null) => void;
  canAdmin?: () => boolean;
}

let links: DashboardLinks = {};

/**
 * Make a node open something, by mouse **and** by keyboard.
 *
 * `role="button"` and `tabindex` rather than a real `<button>`: these rows are grids of
 * several elements, and wrapping them in a button would flatten the layout and make a screen
 * reader announce the whole row as one label. What must not be lost is the keyboard — an
 * officer at a desk drives this with Tab, and a div with only a click handler is a control
 * that does not exist for them.
 */
function leadsTo(node: HTMLElement, label: string, open: () => void): void {
  node.classList.add('go');
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', label);

  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/**
 * What this row says, ignoring the parts that move on their own — 2026-08-14.
 *
 * The board learned this the expensive way: comparing rendered markup made **every** row look
 * changed whenever a refresh straddled a minute boundary, and one new incident flashed the whole
 * screen violet. The dashboard has the same trap in a worse form, because `ageSpan` rewrites its
 * text every second *and* re-anchors `data-since` on every poll — so a naive comparison would
 * report every panel as changed, forever.
 *
 * Both are stripped from the copy. **What is deliberately kept is everything else**: a status
 * word, a note, a count, a tone class. Those are the news. An age ticking is not.
 *
 * ## And a third thing, since 2026-08-15: whatever a pointer did to this card
 *
 * `tilt.ts` writes `--tilt-*` custom properties onto a card as a pointer moves over it. They land
 * in the inline `style` attribute, and `style` is part of `outerHTML` — so a card somebody happens
 * to be hovering would differ from the same card built fresh on **every** poll. The dashboard
 * would flash and re-roll its counters every twenty seconds over no news at all, and only for
 * whichever tile a pointer was resting on, which is about as hard a bug to be told about as this
 * codebase has produced.
 *
 * It is the same shape as the two above and it is stripped the same way. `stripTiltStyles` lives
 * in `tilt.ts` beside the list of properties it removes, so adding a property and forgetting to
 * strip it is one edit rather than two files.
 */
function signatureOf(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  stripTiltStyles(copy);
  for (const age of Array.from(copy.querySelectorAll<HTMLElement>('[data-since]'))) {
    age.removeAttribute('data-since');
    age.textContent = '';
  }
  return copy.outerHTML;
}

/**
 * A counter that changed **slides**; it does not count — 2026-08-14.
 *
 * ## Why this is not a numeric tween, which is what was planned
 *
 * Counting `from` to `to` frame by frame puts numbers on the screen **that were never true**.
 * `11 → 34` renders 17, 23 and 29 on the way, and somebody glancing up at the wrong moment reads
 * one of them as the district's state. That is what INV-02 refuses, with the sign flipped: not
 * stale, but fabricated.
 *
 * The obvious guard — only animate small steps — was tried on paper and **is incoherent**, and
 * the reason is integer rounding. `Math.round` between 3 and 4 yields 3, then 4: a step of one,
 * which is by far the commonest change here, produces **no intermediate frames at all** and the
 * whole "roll" is a jump delayed by 200ms. A step of two or three *does* produce a false number.
 * So the limit gives nothing where the feature is wanted and lies where it is not.
 *
 * ## What this does instead
 *
 * The old value slides up and out while the new one arrives from below, inside a box that clips.
 * **No value that was not a real reading is ever on screen**, so the honesty question does not
 * have to be traded off — it stops existing. And it reads identically whether the change is one
 * or a hundred, which the tween never could.
 *
 * Only `transform` and `opacity` are animated: both are compositor-only, so nothing reflows, and
 * `panels.test.ts` refuses a dashboard that reflows at 1920×1080. The clip is what keeps the
 * outgoing digit from painting outside the tile.
 *
 * The track is torn down on `animationend` and the element left holding **plain text** — the same
 * shape it had before — so nothing downstream has to know this ever happened.
 */
function slideNumber(node: HTMLElement, from: string, to: string): void {
  const track = document.createElement('span');
  track.className = 'rolltrack';

  const out = document.createElement('span');
  out.textContent = from;
  const incoming = document.createElement('span');
  incoming.textContent = to;

  track.appendChild(out);
  track.appendChild(incoming);

  node.textContent = '';
  node.appendChild(track);
  node.classList.add('rolling');

  const settle = (): void => {
    node.classList.remove('rolling');
    // Back to plain text, always — including if the animation never fires, which is what the
    // `cancel` listener is for. A counter left as markup would still read correctly but would
    // make every later signature comparison differ from a freshly built node.
    node.textContent = to;
  };

  track.addEventListener('animationend', settle, { once: true });
  track.addEventListener('animationcancel', settle, { once: true });
}

/**
 * Slide every counter whose value changed, using the outgoing node to say what it was.
 *
 * Only reachable because of phase 2: the old node still exists at the moment of replacement, so
 * *what the number used to be* is readable at all. Under `clear()` that was already gone, which
 * is why this phase could not have been built first.
 *
 * **Called before the swap, deliberately.** The incoming node is prepared while still detached,
 * so it enters the DOM already showing the old value and moves from it. Doing it afterwards
 * paints the new number for one frame and then animates away from it, which reads as a glitch.
 *
 * The stored signature is unaffected: `reconcile` computes it from the fully rendered node before
 * this runs, so the temporary markup never reaches it.
 */
function rollNumbers(was: HTMLElement, fresh: HTMLElement): void {
  // Somebody who asked not to be moved gets the new number immediately, which is the whole
  // meaning of the change anyway. Nothing is lost.
  if (reducedMotion()) return;

  const before = Array.from(was.querySelectorAll<HTMLElement>('[data-roll]'));
  const after = Array.from(fresh.querySelectorAll<HTMLElement>('[data-roll]'));
  // A row whose shape changed is not the same row with a different number, and pairing them by
  // position would slide one counter into an unrelated one.
  if (before.length !== after.length) return;

  after.forEach((node, index) => {
    const from = before[index]?.textContent ?? '';
    const to = node.textContent ?? '';
    if (from === '' || to === '' || from === to) return;

    slideNumber(node, from, to);
  });
}

/**
 * Reconcile a panel's children by key instead of tearing the list down — 2026-08-14.
 *
 * **This is the change the other liveness work was waiting on.** Every `render*` here began with
 * `clear(node)`, so highlighting what changed was not merely unimplemented, it was *impossible*:
 * the node that would have been highlighted had already been destroyed. The board solved this a
 * milestone ago in `applyBoardRows`; this is the same shape, generalised, and deliberately not a
 * second invention of it.
 *
 * Four outcomes, and each is a different fact:
 *
 * - **new** — inserted at its sorted position, not appended, so a fresh critical lands where it
 *   belongs rather than at the bottom.
 * - **changed** — replaced, and marked `flash` so an eye is drawn to it and to nothing else.
 * - **moved** — the *existing* node is moved. Rebuilding it would throw away its identity, and
 *   with it any animation or focus it was carrying.
 * - **gone** — removed, because it is genuinely no longer in the list.
 *
 * A row whose rendered text changed but whose signature did not is swapped **quietly**: correct
 * on screen, with no flash to justify. That is the case the ticking clock produces, forty times
 * a minute, and flashing for it would teach an operator to ignore the flash.
 */
function reconcile<T>(
  container: HTMLElement,
  items: readonly T[],
  key: (item: T) => string,
  build: (item: T) => HTMLElement,
  /**
   * Called for a row that is genuinely arriving, and **only after this container has painted
   * once** — phase 5, 2026-08-14.
   *
   * The guard is the entire subtlety. On the first paint of a screen every row is new, so an
   * unguarded version animates the whole panel on arrival and says "all of this just happened"
   * about twenty-four hours of history. That is the same trap `flash` avoided in phase 2, and it
   * is easier to fall into here because the effect looks correct in a screenshot.
   *
   * Optional, and only the activity feed passes it. Every other panel keeps exactly the silent
   * behaviour it has now — a list of departments that slid around on every poll would be motion
   * with nothing behind it.
   */
  onEnter?: (node: HTMLElement) => void,
): void {
  // Set at the end of the first pass, so "has this ever been painted" is a fact about the DOM
  // rather than a flag some caller has to keep.
  const primed = container.dataset['primed'] === 'true';
  const existing = new Map<string, HTMLElement>();
  for (const node of Array.from(container.children) as HTMLElement[]) {
    const k = node.dataset['k'];
    if (k !== undefined) existing.set(k, node);
  }

  const seen = new Set<string>();

  items.forEach((item, index) => {
    const k = key(item);
    seen.add(k);

    const was = existing.get(k);
    const fresh = build(item);
    fresh.dataset['k'] = k;
    const signature = signatureOf(fresh);
    fresh.dataset['sig'] = signature;

    if (was === undefined) {
      // Deliberately NOT flashed. On the first paint of a screen every row is new, and a panel
      // that lights up entirely on arrival says "all of this is news" when none of it is.
      //
      // `onEnter` runs after the signature is taken, so whatever class it adds never reaches the
      // stored signature and cannot make the next poll think the row changed.
      if (primed && onEnter !== undefined && !reducedMotion()) onEnter(fresh);
      container.insertBefore(fresh, container.children[index] ?? null);
      return;
    }

    if (was.dataset['sig'] !== signature) {
      fresh.classList.add('flash');
      // Only here. A new row has nothing to count up from, and a quiet swap is the clock moving —
      // rolling for either would put the whole screen in motion over no news at all.
      rollNumbers(was, fresh);
      was.replaceWith(fresh);
    } else if (signatureOf(was) !== signatureOf(fresh)) {
      /**
       * The clock moved and nothing else did. Kept current, kept quiet.
       *
       * ⚠️ **This compares both nodes through `signatureOf`, and that changed on 2026-08-15.**
       *
       * It used to read `was.outerHTML !== fresh.outerHTML`, which was right while the only thing
       * that could differ without being news was a ticking age. It stopped being right the moment
       * a pointer could write `--tilt-*` properties onto a card: a hovered tile differs from a
       * freshly built one on every poll, so this branch would fire and **replace the node the
       * pointer was on** — silently, twenty seconds into somebody reading it, with the card
       * snapping back to rest under their cursor.
       *
       * ⚠️ **Both sides go through `signatureOf`, and comparing against `signature` instead does
       * not work.** `signature` is taken *before* `data-sig` is written onto `fresh`, so a live
       * node — which carries that attribute — can never equal it, and this branch would fire on
       * every poll for every row. It was written that way first and cost tests 1 and 12; the two
       * calls are the price of comparing like with like.
       */
      was.replaceWith(fresh);
    } else if (container.children[index] !== was) {
      container.insertBefore(was, container.children[index] ?? null);
    }
  });

  for (const [k, node] of existing) {
    /**
     * Gone, and it goes **silently**.
     *
     * A leaving row is deliberately not animated out. Holding it in the DOM long enough to fade
     * means the panel is momentarily taller than its contents, and `panels.test.ts` refuses a
     * dashboard that overflows at 1920×1080 — the one screen size this actually runs at. The
     * oldest item dropping off the end of a 24-hour window is also not news anybody needs drawn
     * to: what arrives matters, what expires does not.
     */
    if (!seen.has(k)) node.remove();
  }

  container.dataset['primed'] = 'true';
}

function box(className: string, text?: string): HTMLElement {
  const node = document.createElement('div');
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function span(className: string, text: string): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * How long ago, in words read at a glance.
 *
 * Not a timestamp. Somebody who has just walked into the room has not been watching the
 * clock, and "9 minutes ago" is an answer where "13:42" is a subtraction.
 */
export function ago(minutes: number | null): string {
  if (minutes === null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/**
 * An age that keeps counting **on its own** — 2026-08-14.
 *
 * `ago()` only ever ran at paint time, so between two polls every age on this screen was frozen:
 * a panel could sit reading "9 min ago" for the whole twenty seconds while the clock beside it
 * ticked. From four metres that is a screen somebody decides has stopped, and the data was
 * perfectly correct the entire time.
 *
 * The instant is written onto the element and a one-second timer re-renders from it, so the text
 * advances **without asking the server anything**. That direction is the reason this is honest:
 * an age can only ever grow, and growing is exactly what is true while no fresh answer has
 * arrived. Nothing here invents a number — `startAges` cannot make a panel look *fresher*, only
 * older, which is what INV-02 wants a stale screen to do.
 *
 * `pre` and `post` exist because most of these ages live inside a longer sentence ("Rescue 1122 ·
 * 9 min ago", "9 min ago · until 18:00"). Keeping them on the element means the ticker rewrites
 * the whole label from its own parts, rather than trying to substring out the half that moves.
 */
function ageSpan(className: string, sinceMs: number | null, pre = '', post = ''): HTMLElement {
  const node = span(className, '');
  if (sinceMs !== null && !Number.isNaN(sinceMs)) node.dataset['since'] = String(sinceMs);
  if (pre !== '') node.dataset['pre'] = pre;
  if (post !== '') node.dataset['post'] = post;
  paintAge(node);
  return node;
}

/** Rewrite one age element from the instant stored on it. */
function paintAge(node: HTMLElement): void {
  const since = node.dataset['since'];
  const minutes =
    since === undefined ? null : Math.max(0, Math.floor((Date.now() - Number(since)) / 60_000));
  node.textContent = `${node.dataset['pre'] ?? ''}${ago(minutes)}${node.dataset['post'] ?? ''}`;
}

/**
 * The instant a server-supplied "minutes ago" refers to.
 *
 * Anchored against this machine's clock at paint time, which is the same assumption `ago()` has
 * always made about these fields — it is not a new one, it is the existing one written down so
 * the number can keep moving between polls.
 */
function sinceMinutes(minutes: number | null): number | null {
  return minutes === null ? null : Date.now() - minutes * 60_000;
}

/**
 * Start every age on the page counting.
 *
 * One timer for the whole screen rather than one per element: a dashboard carries dozens of these
 * and dozens of timers is dozens of things to cancel correctly. The sweep is a `querySelectorAll`
 * over elements that already exist, so a panel repainted between ticks is picked up on the next
 * one with nothing to register or unregister.
 */
/**
 * The freshness hairline — phase 6, 2026-08-14.
 *
 * **Two panels carry one, and it is deliberately not every panel.** Weather and Pakistan
 * headlines are the only two whose age is a fact about the *panel* rather than about a row inside
 * it, and both already print that age in words beside the heading. So the rail is a picture of a
 * sentence that is already on screen — which is what keeps it clear of INV-04. A rail on Officers
 * or Utilities would be drawing a claim the panel does not make in words ("the oldest row is this
 * stale"), and a rail driven by `asOf` would be the poll ring again, once per panel.
 *
 * **It drains, and the direction is the honesty.** Full when the reading is fresh, empty by the
 * time it is as old as that panel tolerates — `data-full`, which is the same threshold the age
 * text already turns amber at. Without a new answer from outside the district the only true thing
 * that can happen is that this gets worse, and that is the only thing it can show.
 *
 * `data-at` rather than `data-since`, so the `[data-since]` sweep does not find it and write
 * "9 min ago" into a 2px band.
 */
function paintFresh(node: HTMLElement): void {
  const at = node.dataset['at'];
  const full = Number(node.dataset['full']);

  if (at === undefined || !Number.isFinite(full) || full <= 0) {
    // No reading at all. Empty and inert — the panel's own words say why.
    delete node.dataset['spent'];
    node.style.width = '0';
    return;
  }

  const minutes = Math.max(0, (Date.now() - Number(at)) / 60_000);
  const left = 1 - minutes / full;

  if (left <= 0) {
    // Past what this panel tolerates. The rail becomes a full flat line in the quiet border
    // colour: still visibly a rail, no longer a measure. The heading has already gone amber.
    node.dataset['spent'] = 'true';
    node.style.width = '';
    return;
  }

  delete node.dataset['spent'];
  node.style.width = `${(left * 100).toFixed(1)}%`;
}

/** Point a hairline at an instant, or at nothing. */
function setFresh(id: string, atMs: number | null): void {
  const node = document.getElementById(id);
  if (node === null) return;
  if (atMs === null) delete node.dataset['at'];
  else node.dataset['at'] = String(atMs);
  paintFresh(node);
}

export function startAges(): void {
  window.setInterval(() => {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-since]'))) {
      paintAge(node);
    }
    // The same sweep, because the hairline is the same fact drawn differently — and one timer for
    // the screen is one thing to get right rather than two that can drift apart.
    for (const rail of Array.from(document.querySelectorAll<HTMLElement>('.fresh'))) {
      paintFresh(rail);
    }
  }, 1000);
}

/**
 * The colour a reported state carries.
 *
 * `never` and `stale` are grey rather than amber, and that is deliberate. "Nobody has told us"
 * is not a mild version of "there is a problem" — it is a different fact with a different fix
 * (ADR-0009's reasoning, applied to a status panel).
 */
export function toneFor(row: { status: string | null; freshness: string }): string {
  if (row.freshness !== 'fresh' || row.status === null) return 'unknown';

  switch (row.status) {
    case 'normal':
    case 'office':
      return 'ok';
    case 'degraded':
    case 'field':
      return 'pending';
    case 'down':
    case 'leave':
      return 'critical';
    default:
      return 'unknown';
  }
}

function hhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const SPARK_W = 40;
const SPARK_H = 14;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The last day's shape, 40×14 — M9/L7, 2026-08-14.
 *
 * **Zero-based, and that is the honest choice rather than the flattering one.** Scaling between
 * the series' own minimum and maximum makes a wobble between 10 and 11 look like a mountain, which
 * on a district's home screen is a graphic lying about the size of a change. Against zero, a
 * counter that barely moved draws a line that barely moves — and a flat series at eleven sits high
 * while a flat series at zero sits on the floor, which is the difference that matters.
 *
 * **`aria-hidden`, deliberately.** The number above it is the fact and is already read out; this
 * only shows its shape. A graphic that carried something the text did not would be INV-04, which
 * is the trap this phase was scoped around twice.
 */
function sparkline(series: readonly number[]): SVGSVGElement | null {
  if (series.length < 2) return null;

  const max = Math.max(...series);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(SPARK_W)} ${String(SPARK_H)}`);
  /**
   * Stretched to whatever width the card gives it — 2026-08-15.
   *
   * `preserveAspectRatio="none"` is what lets CSS set the width to 100% and the height to a fixed
   * band. Without it the browser keeps 40:14 and a full-width line becomes about sixty pixels
   * tall, which would cost the keys row far more than the twenty pixels this move is spending.
   *
   * The stroke is `vector-effect: non-scaling-stroke` in CSS for the same reason: a line drawn in
   * a stretched coordinate system would otherwise be thin horizontally and thick vertically.
   *
   * `width`/`height` attributes are deliberately not set. They would be a second, weaker opinion
   * about the size, and the one place this has to agree is the stylesheet.
   */
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  // 1.5px of room top and bottom so a full-height stroke is not clipped by its own width.
  const top = 1.5;
  const usable = SPARK_H - 3;

  const points = series
    .map((value, index) => {
      const x = (index * SPARK_W) / (series.length - 1);
      const y = max === 0 ? SPARK_H - top : SPARK_H - top - (value / max) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points);
  svg.appendChild(line);

  return svg;
}

/**
 * **The one tile that is not on the wall on an ordinary day** — RX-03, 2026-08-25.
 *
 * Pulled out of `renderKeys` and exported for one reason: it is the only tile whose PRESENCE is
 * a decision, and a decision that lives inside a DOM-painting function is a decision nothing can
 * test. `api/__tests__/responsePage.test.ts` was written the morning after a display path shipped
 * with no test and turned out to render nothing at all; this is that lesson applied one screen
 * over, before rather than after.
 *
 * Three rules, and each of them was learned from something measured:
 *
 *   * **`undefined` is not zero.** An older server cannot answer this at all, and drawing `0`
 *     would be the wall asserting nothing has been declined in a district where nobody looked.
 *   * **Zero draws nothing.** `dashboardLive` test 14 measures the shipped deck on a real
 *     1920×1080 wall, and a ninth tile pushed **Routine emergencies** and **Presence** below the
 *     fold. The wall is full; the exception earns its space by existing.
 *   * **It carries its series.** Test 9 pins `sparks === tiles`, because a tile with a line and
 *     a tile without are different heights and a mixed deck goes ragged.
 */
export function ownerlessTile(
  ownerless: number | undefined,
  series: readonly number[] | undefined,
): {
  k: string;
  n: number;
  group: 'alarm';
  flag: 'ownerless';
  goes: string;
  series?: number[];
  tone: 'alarm';
} | null {
  if (ownerless === undefined || ownerless === 0) return null;
  return {
    k: 'Nobody took it',
    n: ownerless,
    group: 'alarm',
    flag: 'ownerless',
    goes: 'the emergencies every recipient has declined',
    ...(series === undefined ? {} : { series: [...series] }),
    tone: 'alarm',
  };
}
function renderKeys(feed: DashboardFeed): void {
  const d = feed.district;
  const target = el('dashKeys');
  /**
   * The depth is mounted on the **deck**, not on a tile, and it is safe to call every render.
   *
   * `reconcile` replaces a tile node whenever its meaning changes, so a listener attached to a
   * card would be thrown away on the next poll and that card would stop responding with nothing
   * on screen to say so. One listener on the container outlives every replacement beneath it.
   *
   * `mountTilt` returns immediately if the deck already has it, so calling it from a function that
   * runs on every poll costs one attribute read.
   */
  mountTilt(target);

  type Flag =
    | 'unacknowledged'
    | 'today'
    | 'unmet'
    | 'nobodyTold'
    | 'ownerless'
    | 'stageIssued'
    | 'stageResponded'
    | 'stageResolved'
    | 'open';
  /**
   * **`Unassigned` was the first counter here and it is gone (2026-08-06).**
   *
   * It meant *the routing signals matched no department*, and it was the right first number
   * while routing was the mechanism (ADR-0010). It is not any more, and it had become a
   * **second red number for a fact `Nobody told` already states better**:
   *
   *   * telling somebody now **places** the emergency — a dispatch on an unheld incident
   *     routes it, recorded as `ruleId: 'manual'` (M6). So an emergency can only stay
   *     unassigned while nobody has been told, which is what `Nobody told` counts.
   *   * `Nobody told` is the sharper of the two. *"The signals could not place it"* is a
   *     configuration complaint; *"nobody has been told"* is the thing an operator can fix in
   *     ten seconds, and it is the gap this whole product exists to close.
   *
   * Two alarming numbers for one situation is how a district learns to read neither. The
   * server-side flag stays — the board still filters on it, and the empty `routed` event is
   * still recorded, because *we looked and found nobody* must never be inferred from an
   * absence (ADR-0005).
   */
  /**
   * Each tile's own series, and **each one is the history of the number printed above it** — the
   * server replays the fold to get them (`districtTrend`). A tile paired with the wrong series
   * would be a picture disagreeing with its own number, which is the failure this was scoped
   * around; the pairing is written once, here, beside the number it belongs to.
   */
  /**
   * **The wall is two questions now, not one row of five — the owner's decision, 2026-08-17,
   * narrowed to the owner's own five words, 2026-09-04.**
   *
   * He read this screen and could not tell its counters apart, and he was right: *nobody has it*,
   * *nobody told*, *nobody reached* and *not acknowledged* are four different failures whose names
   * read as one thing at four metres. Measured on Bajaur's own 40 incidents before anything was
   * changed: **9 had a department**, so *nobody has it* was red on four rows in five — a figure
   * nobody reads, which is the same argument that took the permanently-green "online" bar off the
   * header. ADR-0018 already says departments are a directory the control room picks from rather
   * than an audience, so that counter was measuring a mechanism this district does not use.
   *
   * **2026-09-04: `Issued`, `Acknowledged` and `Not yet assessed` came off this deck**, on the
   * owner's own instruction — *"jaha jaha acknowledge ka concept tha wo ab khtam"* — leaving
   * exactly five: **Reported today, Responded, Resolved today, No one chosen, Message failed.**
   *
   *   * `Acknowledged` is gone because ADR-0034 means confirming receipt is no longer a distinct
   *     act from responding (`domain/stages.ts`'s header) — there is nothing left for the word to
   *     count that `Responded` does not already count sooner.
   *   * `Issued` is gone as a tile, not as a concept — `Reported today` already answers *how much
   *     arrived*, and a stage tile answering *how much is still unanswered* beside it was the
   *     same complaint the owner made about `nobody has it`: two red numbers for one situation.
   *     The stage itself is unchanged and still `Issued` on the board and the incident it opens
   *     (`domain/stages.ts`); it is simply not counted a second time here.
   *   * `Not yet assessed` is gone from the deck for the same reason — ADR-0009's rule that it
   *     must never be **folded into** a severity still holds, and still governs `board.ts`'s own
   *     strip; it is not on this particular five-tile row.
   *
   * So the deck still answers two questions, in this order:
   *
   *   1. **Where is the work** — `Responded` and `Resolved today`, the two live stages this
   *      district's own vocabulary still names. Counted live, so `Resolved today` means *resolved
   *      and still on today's board*, never all history (ADR-0020).
   *   2. **What needs attention** — `Reported today`, `No one chosen`, `Message failed`, and
   *      these are deliberately **not** stages.
   *
   * ⚠️ **The second row is load-bearing and must not be folded into the first.** A stage cannot
   * say anything went wrong: an emergency at `Issued` because nobody has answered yet and one at
   * `Issued` because **the message never arrived** are the same word — INV-03's entire subject,
   * invisible on a stage board, and a thing this district has already reported once.
   *
   * **Every tile carries its own replayed series**, added server-side rather than drawn from
   * anything the client worked out. A tile with a line and a tile without are different heights,
   * so a deck where only some had one went **ragged**, which `dashboardLive` test 9 exists to
   * refuse. Reserving empty space would have been cheaper and would have left tiles with a hole
   * in them; replaying the states costs nothing measurable (the fold is already running) and
   * means no line on this screen answers a different question from the number above it — phase
   * 7's rule, kept.
   */
  const t = d.trend;
  const st = d.stages;

  const keys: {
    k: string;
    n: number;
    tone?: 'alarm' | 'warn';
    group: 'stage' | 'alarm';
    flag: Flag;
    goes: string;
    series?: number[];
  }[] = [
    {
      k: 'Reported today',
      n: d.today,
      group: 'alarm' as const,
      flag: 'today' as const,
      // Everything that happened today, closed ones included — which is why the board is asked
      // for closed rows when arriving here. Not an alarm; it carries no tone and never will.
      goes: "today's emergencies, closed ones included",
      ...(t === undefined ? {} : { series: t.today }),
    },
    {
      k: 'Responded',
      n: st.responded,
      group: 'stage' as const,
      flag: 'stageResponded' as const,
      goes: 'the ones somebody is working on',
      ...(t === undefined ? {} : { series: t.stageResponded }),
    },
    {
      // ⚠️ **Measured over TODAY, not over what is open — and the label says so.** There is no
      // such thing as an open resolved emergency, so this cannot be counted the way `Responded`
      // is; the first version tallied it in the live loop and read 0 for ever.
      k: 'Resolved today',
      n: st.resolved,
      group: 'stage' as const,
      flag: 'stageResolved' as const,
      goes: "today's resolved emergencies",
      ...(t === undefined ? {} : { series: t.stageResolved }),
    },
    /**
     * M6-09, renamed and kept. The owner doubted this one — *"control room to kisi na kisi ko
     * assign karega hi"* — and the district's own data disagreed: **12 of 40 had nobody chosen**.
     * It is the gap between an emergency arriving and anybody being told, which is the paper
     * register M6 exists to replace, so it stays. Warn rather than alarm: an emergency two
     * minutes old is not yet a failure.
     */
    {
      k: 'No one chosen',
      n: d.nobodyTold,
      group: 'alarm' as const,
      flag: 'nobodyTold' as const,
      goes: 'the emergencies no one was chosen to be told about',
      ...(t === undefined ? {} : { series: t.nobodyTold }),
      ...(d.nobodyTold > 0 ? { tone: 'warn' as const } : {}),
    },
    /**
     * 🔴 **Everybody was chosen, everybody answered, and every one of them said no** — RX-03,
     * 2026-08-25, out of the district's own response workflow.
     *
     * ⚠️ **The tile above asks the opposite question, and that is why they are neighbours.**
     * *No one chosen* is an operator who has not finished; this is an operator who has to start
     * again. Both measure the same gap — an emergency arriving and nobody being on the way.
     *
     * 🔴 **Before this, an emergency four officers had declined was counted by NOTHING on this
     * screen.** Declining is answering, so it left *Overdue*, it was never *unassigned*, and it
     * sat under **Responded** on the stage row (**Acknowledged** at the time this was written —
     * gone since 2026-09-04). Every tile on the wall said fine.
     *
     * Whether it is drawn at all is `ownerlessTile`, which is exported and tested.
     */
    ...(ownerlessTile(d.ownerless, t?.ownerless) === null
      ? []
      : [ownerlessTile(d.ownerless, t?.ownerless)!]),
    // INV-03 on the home screen, and the reason the second row exists at all: somebody was owed
    // an alert and demonstrably did not get one. Per emergency, never per attempt.
    {
      k: 'Message failed',
      n: feed.notificationsUnmet,
      group: 'alarm' as const,
      flag: 'unmet' as const,
      goes: 'the emergencies where a message failed',
      ...(t === undefined ? {} : { series: t.notificationsUnmet }),
      ...(feed.notificationsUnmet > 0 ? { tone: 'alarm' as const } : {}),
    },
    /**
     * **`Not yet assessed` came off this deck 2026-09-04**, not out of the district — ADR-0009's
     * rule survives untouched on `board.ts`'s own strip, which still refuses to fold it into a
     * severity. It simply is not one of the owner's five tiles here (`Reported today`,
     * `Responded`, `Resolved today`, `No one chosen`, `Message failed`). `d.unassessed` itself is
     * unchanged and still drives `dashLede` below when it is the day's only news.
     */
  ];

  // Keyed by the counter's own name, which is fixed and ordered — so a tile is only ever
  // replaced by the same tile, and a number changing is the one thing that can flash.
  reconcile(
    target,
    keys,
    (key) => key.k,
    (key) => {
      /**
       * A counter is an object with depth — 2026-08-15.
       *
       * The outer node keeps `key` and its tone, so every descendant rule written for this tile
       * over the last four milestones still matches: `.key .n`, `.key .k`, `.key.alarm .n` and the
       * rest go on working through the new elements without being touched. Only the handful of
       * rules that styled `.key` **itself** moved, onto `.key .face`.
       *
       * The layers, and none of them is decoration:
       *
       *   .key.tilt   the perspective box, one per card so each turns about its own centre
       *     .stack    what rotates, `preserve-3d` so its children can sit at real depths
       *       .cast   the shadow on the dashboard, sliding opposite the tilt
       *       .side   the card's thickness, showing at the edge when it turns
       *       .face   the card — everything that used to be painted on `.key`
       *         .sheen / .rim   the moving light and the lit edge
       *         .lift           the contents, at four heights
       *
       * **`leadsTo` goes on the outer node and nothing else gets a `tabindex`.** It makes a
       * counter that counted something a real tab stop; a second focusable element inside would
       * make every counter two stops, and a keyboard operator would tab through ten things to
       * cross five cards.
       */
      const node = box(`key tilt${key.tone === undefined ? '' : ` ${key.tone}`}`);
      // Which of the deck's two questions this tile answers — read by CSS only, so the
      // stage row and the alarm row can be told apart when every alarm reads zero and
      // tone alone says nothing. Never read by script: it decides no behaviour.
      node.dataset['group'] = key.group;

      const stack = box('stack');
      stack.appendChild(box('cast'));
      stack.appendChild(box('side'));

      const face = box('face');
      face.appendChild(box('sheen'));
      face.appendChild(box('rim'));

      const lift = box('lift');

      const count = span('n z3', String(key.n));
      // Slides when it changes. `.key .n` already carries `tabular-nums`, so the digits do not
      // shift under the label while it travels. `z3` is the highest layer on the card: the number
      // travels furthest as the card turns, which is how the card says which thing on it matters.
      count.dataset['roll'] = '';
      lift.appendChild(count);
      lift.appendChild(span('k z1', key.k));

      /**
       * The shape of the last day, **in flow now** rather than tucked into the corner.
       *
       * It was absolutely positioned so that no tile grew — the keys row is across the top of the
       * dashboard and eighteen pixels here pushes every panel below it down. That reasoning was
       * right and the owner has taken the trade knowingly: in flow the line is full width and
       * legible from across a room, where a 40px sparkline in a corner is a smudge.
       *
       * ⚠️ **The height this costs has to be looked at on the wall.** `panels.test.ts` cannot see
       * it — it is a domain test that renders nothing — so the only check is a screenshot at
       * 1920×1080. If it costs a row, the way back is one CSS rule, not a rewrite.
       */
      if (key.series !== undefined) {
        const spark = sparkline(key.series);
        if (spark !== null) {
          spark.classList.add('z4');
          lift.appendChild(spark);
        }
      }

      face.appendChild(lift);
      stack.appendChild(face);
      node.appendChild(stack);

      /**
       * Clickable only when it counted something.
       *
       * A zero that opens a board saying "nothing matches" is a click that answers a question
       * the counter had already answered. Worse, it teaches that these numbers lead somewhere
       * unreliable, and the one that matters — `Unassigned`, in red — is the one that must be
       * trusted at 02:00.
       */
      if (key.n > 0 && links.onOpenFlag !== undefined) {
        leadsTo(node, `Show ${key.goes}`, () => links.onOpenFlag?.(key.flag));
      }

      return node;
    },
  );

  // Said as a sentence, because "the oldest one has been sitting for 41 minutes" is the thing
  // a person acts on — a bare number is not.
  const lede = el('dashLede');
  /**
   * **The sentence is about who has not been told, not about routing (2026-08-06).**
   *
   * It used to read *"12 with nobody — the oldest 4 days ago"* and carry a **Set the routing
   * signals** button. Both went, and the button is the one worth explaining.
   *
   * It was added by M6-15 for a good reason — R-04 was the district's single functional gap,
   * no department had a signal, and the fix sat three navigations from the number that
   * announced it. **M7 removed the gap rather than the friction.** The system now learns who
   * the control room usually tells and pre-ticks them, so a district that never writes a signal
   * still gets a proposal. Telling somebody to go and configure routing is now advice for a
   * problem the software solved.
   *
   * `Nobody told` is the honest version of the same alarm: it names something an operator fixes
   * in ten seconds, on this screen, rather than a settings page they have to be taught about.
   */
  if (d.nobodyTold > 0) {
    lede.textContent = `${String(d.nobodyTold)} with no one chosen.`;
    lede.className = 'note state-critical';
  } else if (d.unassessed > 0) {
    // Never described as a severity: nobody has looked yet, which is not a level (ADR-0009).
    lede.textContent = `${String(d.unassessed)} not yet assessed by anybody.`;
    lede.className = 'note';
  } else if (d.openIncidents === 0) {
    lede.textContent = 'Nothing open.';
    lede.className = 'note';
  } else {
    // Not "...and acknowledged" any more, 2026-09-04 — see `domain/stages.ts`'s header.
    lede.textContent = 'Everything open is with a department and somebody is on it.';
    lede.className = 'note';
  }

  renderCarried(d.carriedOver);
}

/**
 * **From earlier days** — the strip that is the safety net of the whole daily reset.
 *
 * The dashboard is one district day and an incident belongs to the day it started, so an
 * emergency opened six days ago is in **none** of the figures above this. Escalation stopped
 * chasing it at its own midnight (ADR-0020 §4b). **These two sentences are the only place in the
 * product where it is still visible**, which is the reason the band exists and the reason it must
 * never be quietly tidied away.
 *
 * ⚠️ **Hidden when both are zero, and that is deliberate.** A line permanently on screen is one
 * an operator stops reading, and then it is not there on the morning it says three. Same rule
 * `moreSentence` follows for the activity panel and `.note:empty` follows for every note.
 *
 * ⚠️ **The age is an `ageSpan`, never text.** `signatureOf` blanks `[data-since]` before
 * comparing, so a number that rewrites itself every second cannot make this panel read as
 * changed on every poll — the trap `overdueByMinutes` cost the board once already, where one new
 * emergency flashed the entire screen.
 *
 * ⚠️ **Nothing here is a control.** It leads nowhere until the Record can honestly answer *show
 * me those thirteen* (Phase 4). This product has already deleted seven tiles that looked like
 * buttons and were not, and a figure landing on *"nothing matches"* is the defect M11-A1 exists
 * to remove. Wiring it early would be both.
 */
function renderCarried(carried: DashboardFeed['district']['carriedOver']): void {
  /** The figure itself. `<b>` because there is exactly one number in each line and it is the
   * emphasis of the sentence — which is what the element means, so it needs no class. */
  const count = (n: number): HTMLElement => {
    const node = document.createElement('b');
    node.textContent = String(n);
    return node;
  };

  const band = el('dashCarried');
  const done = el('dashCarriedDone');
  const open = el('dashCarriedOpen');

  // Absent is not zero: an older server does not answer this, and drawing "0 still open" would
  // be this screen asserting something it was never told.
  if (carried === undefined || (carried.resolvedToday === 0 && carried.stillOpen === 0)) {
    band.hidden = true;
    return;
  }

  band.hidden = false;

  done.hidden = carried.resolvedToday === 0;
  if (!done.hidden) {
    clear(done);
    done.appendChild(count(carried.resolvedToday));
    done.appendChild(
      span(
        '',
        carried.resolvedToday === 1
          ? 'from an earlier day was resolved today'
          : 'from earlier days were resolved today',
      ),
    );
  }

  open.hidden = carried.stillOpen === 0;
  if (!open.hidden) {
    clear(open);
    open.appendChild(count(carried.stillOpen));
    open.appendChild(span('', 'still open'));

    /**
     * The date, and it is not decoration.
     *
     * The count alone reads identically on the day it becomes three and a fortnight later. This
     * is the half that says which of those is happening, and it is the measurement ADR-0020
     * asked for of its own assumption: if this line grows and stays grown, the district is not
     * closing its work within the day and the decision behind this screen is wrong.
     */
    const at = carried.oldestOpenAt;
    if (at !== null) {
      const ms = Date.parse(at);
      if (!Number.isNaN(ms)) open.appendChild(ageSpan('cage', ms, '· oldest '));
    }
  }
}

function renderCounts(
  targetId: string,
  rows: {
    name: string;
    count: number;
    warn?: boolean;
    open?: () => void;
    label?: string;
    /** A second, smaller way in — today only the signal editor (M6-15). */
    aside?: { label: string; go: () => void };
  }[],
  empty: string,
): void {
  const target = el(targetId);

  if (rows.length === 0) {
    clear(target);
    target.appendChild(box('empty', empty));
    return;
  }

  // Keyed by name: a department keeps its node while its count changes, which is exactly the
  // row an operator wants their eye pulled to.
  reconcile(
    target,
    rows.slice(0, 10),
    (row) => row.name,
    (row) => {
      const node = box('pitem');
      node.appendChild(span('pn', row.name));
      const count = span('pc', String(row.count));
      // `.pitem .pc` carries `tabular-nums` too — see the note beside it in `index.html`.
      count.dataset['roll'] = '';
      if (row.warn === true) count.classList.add('state-pending');
      node.appendChild(count);

      if (row.open !== undefined) leadsTo(node, row.label ?? row.name, row.open);

      /**
       * A second way in, as a real button rather than a second `leadsTo` — M6-15.
       *
       * `leadsTo` makes the whole row clickable, and two overlapping click targets on one row is
       * how somebody opening a board ends up in a configuration screen at 02:00. The button
       * stops the event, so the row keeps meaning exactly one thing.
       */
      if (row.aside !== undefined) {
        const aside = document.createElement('button');
        aside.type = 'button';
        aside.className = 'aside';
        aside.textContent = row.aside.label;
        aside.addEventListener('click', (event) => {
          event.stopPropagation();
          row.aside?.go();
        });
        node.appendChild(aside);
      }

      return node;
    },
  );
}

/**
 * `expires` — whether a stale note on this panel describes something that MOVES — M10-02.
 *
 * **A utility note and a presence note age differently, and the district decided this.**
 * *"8 hours loadshedding"* is a **situation**: six hours later it is very likely still true, and
 * showing it plainly is the whole of M10-01. *"Mamund side"* is a **location**, and the officer who
 * said it also said when it ended — so a room reading it at four metres could send work to a place
 * somebody left at 13:00. Same code path, genuinely different fact.
 *
 * So a stale note on an expiring panel is prefixed **"last said:"** and reads as history, which is
 * the owner's own choice (2026-08-14) over the two alternatives of showing it plainly or hiding it.
 * Hiding it was refused for the reason ADR-0005 exists: a blank looks identical to *nobody ever
 * wrote anything*, which is a different fact and a worse one to confuse.
 */
function renderStatusList(
  targetId: string,
  gapId: string,
  rows: PanelRow[],
  quiet: number,
  expires = false,
): void {
  const target = el(targetId);

  if (rows.length === 0) {
    clear(target);
    target.appendChild(box('empty', 'nothing configured yet'));
  }

  // A department reporting the power has gone from normal to down is the single most
  // consequential change on this panel, and it is now the one thing that flashes.
  reconcile(
    target,
    rows,
    (row) => row.name,
    (row) => {
      const node = box('pitem');
      /**
       * The tone the pill already carries, put on the row as well — 2026-08-23.
       *
       * The card's left edge reads before any word does, so it needs the same answer the pill
       * gives, and `toneFor` is asked **once** for both. Two calls would be two chances for the
       * edge and the pill to disagree about one service, which is the kind of drift this file
       * has a standing lesson about.
       *
       * ⚠️ **An attribute, not a class.** `.pitem` already takes `go` from `leadsTo`, and a
       * tone class beside it would put two unrelated vocabularies in one attribute — the reason
       * `.key` carries `data-group` rather than a fifth class.
       */
      const tone = toneFor(row);
      node.dataset['tone'] = tone;
      /**
       * Three heights, and the pill is the one that leaves the surface.
       *
       * `z3` carries the service's name, because that is what somebody scans this panel for.
       * The pill goes to `z4` — the layer that gets a `drop-shadow` rather than a `text-shadow`
       * — so a shape with a ground of its own casts onto the face instead of smearing.
       */
      node.appendChild(span('pn z3', row.name));
      // Name AND designation on the wall — ADR-0033. Only the availability rows carry `officer`.
      if (row.officer != null && row.officer !== '') {
        node.appendChild(span('pofficer z2', row.officer));
      }
      node.appendChild(span(`tag ${tone} z4`, row.label));

      if (row.freshness === 'never') {
        node.appendChild(box('pw z1', 'nobody has reported this'));
      } else {
        /**
         * The district's own sentence, on its own line — M10-02.
         *
         * It used to ride inside `.pw` as a **prefix on the age**, at 0.76rem in `--slate`: the
         * smallest and dimmest text on the panel, and the one thing on the row a human actually
         * wrote. At four metres *"8 hours loadshedding"* is what a control room needs and
         * *"2h ago"* is not, and the two were the wrong way round.
         *
         * **Rendered only when there is one.** Most rows carry no note, and a line per row would
         * cost the panel height it does not have at 1920×1080.
         *
         * ⚠️ **This must stay ordinary markup, never the text of a `[data-since]` element.**
         * `signatureOf` blanks those, so a note living inside one would change without the row
         * ever repainting — the reconcile equivalent of the defect M10-01 just fixed. Today it
         * survived only because `data-pre` happened not to be stripped.
         */
        if (row.note !== null) {
          const stale = expires && row.freshness === 'stale';
          node.appendChild(box('pnote z1', stale ? `last said: ${row.note}` : row.note));
        }

        /**
         * ⚠️ **No age on this panel — the district asked for it gone (2026-09-08).**
         *
         * The wall used to print `2 days ago` under every service, and the owner, watching the
         * screen the district actually looks at: *"ye time yaha par show nhe hona chaye hai, YE
         * SAHE NHE lag raha hai."* Told what the age was holding up here, and asked again, they
         * chose to remove it from the wall too rather than shrink it or gate it on staleness.
         *
         * **This is the cost, written where somebody will hit it.** For Officers nothing is
         * lost: presence still expires, so a stale row greys through `toneFor` and its note
         * takes the `last said:` prefix — INV-02's *degrade* form, which never needed a number.
         * For the two condition panels there is no such fallback: ADR-0025 removed their expiry
         * on the district's own instruction, and the age printed here was the whole of their
         * answer to INV-02. A four-day-old *Normal* now reads exactly like a fresh one.
         *
         * **So do not restore this line on your own.** It was removed deliberately, at the
         * district's repeated request, and ADR-0037 is the argument. Putting an age back is
         * reopening a decision the people running the room have now made twice.
         */
      }

      // Ordinary children above, wrapped once here — see `makeCard`.
      makeCard(node);

      if (links.onOpenStatus !== undefined) {
        leadsTo(node, `Report on ${row.name}`, () => links.onOpenStatus?.());
      }

      return node;
    },
  );

  const gap = el(gapId);
  gap.textContent = quiet === 0 ? '' : `${String(quiet)} not reporting`;
  gap.className = quiet === 0 ? 'age' : 'age state-pending';
}

/**
 * The Emergency Situation cards.
 *
 * Every kind the district watches, always present. Six calm cards say "nothing is happening"
 * in a way an empty panel cannot — an empty panel might mean the page failed to load, and on
 * a screen nobody is touching there is no way to tell the difference.
 *
 * The status word carries the meaning; the colour repeats it. A card reading "No one chosen"
 * says the same thing to somebody who cannot see that it is red (INV-04).
 *
 * Since 2026-08-17 those words are the district's own four — `No one chosen`, `Issued`,
 * `Acknowledged`, `Responded`, `Clear` — the same vocabulary as the deck above this panel. They
 * used to be a private language (*With nobody*, *Not acknowledged*, *Being handled*), and the
 * loudest of them was the department figure the owner had just had taken off the wall. The
 * server decides the word; this file has never chosen one and must not start.
 */
function renderSituation(feed: DashboardFeed): void {
  const target = el('dashSituation');

  // The card set is fixed and always present (see the comment above), so the key is the category
  // and a card is only ever replaced by itself. Fire going from "Normal" to "With Rescue 1122" is
  // the change this panel exists to announce.
  reconcile(
    target,
    feed.situation,
    (row) => row.category,
    (row) => {
      const card = box(`sit ${row.state}${row.open === 0 ? ' quiet' : ''}`);
      /**
       * The three heights, and the middle one is the whole point.
       *
       * `z3` is the highest layer a card has, and on a counter it carries the number. Here it
       * carries the **status word** — *Clear*, *Issued*, *No one chosen* — because that is the
       * one thing on this tile somebody reads from four metres. The category above it and the
       * count below it travel less, so the word arrives first as the card turns.
       *
       * ⚠️ **The category is `z1`, not `z2`.** It is a label for the word, exactly as
       * `renderKeys` treats the caption under a counter, and lifting the two together would
       * flatten the parallax back into a picture that happens to rotate.
       */
      card.appendChild(box('kind z1', row.label));
      card.appendChild(box('state z3', row.status));

      const meta = box('meta z1');
      meta.appendChild(span('', row.open === 0 ? 'none open' : `${String(row.open)} open`));
      meta.appendChild(row.lastAt === null ? span('', '—') : ageSpan('', Date.parse(row.lastAt)));
      card.appendChild(meta);

      // Built as ordinary children above, then wrapped once — `makeCard` moves them onto the
      // card's own face. The six element names it writes live in `tilt.ts` and nowhere else.
      makeCard(card);

      if (row.open > 0 && links.onOpenCategory !== undefined) {
        // Only when there is something to open. A card reading "Normal · none open" that
        // navigates to an empty board teaches people the panel is broken.
        leadsTo(card, `Open the board for ${row.label}`, () =>
          links.onOpenCategory?.(row.category, row.label),
        );
      }

      return card;
    },
  );
}

const TAG_WORDS: Record<string, string> = {
  vip: 'VIP',
  security: 'SECURITY',
  road: 'ROAD',
  weather: 'WEATHER',
  other: 'NOTICE',
};

/**
 * The last 24 hours — M9-38, M9-39, M9-40.
 *
 * ## The line under the list is the point
 *
 * Twenty rows is what the district asked for, and a panel that shows twenty and says nothing
 * about the rest is read as *this is everything that happened*. It is not, and the first time
 * somebody asks about an eleven o'clock alert the screen has rotated past, the honest answer —
 * it is on the board, in the search, in the daily report — is the answer nobody believes,
 * because the screen is what they trust. So `more` is drawn whenever the server sends one.
 *
 * ## Nothing here is clickable, and that is deliberate
 *
 * Every other list on this dashboard that leads somewhere does so through `leadsTo`. This one
 * does not, because the rows carry **no ids** — ADR-0013 §1: the dashboard shows aggregates,
 * and a handle is the first step towards a screen a room can click through to an emergency.
 * Reaching a particular one is the board's job, behind a session.
 *
 * ## Rotation is presentation
 *
 * There is no state here. The server recomputes the window from the same events every other
 * panel folds, on every refresh, so nothing can be lost by a restart and nothing can rotate out
 * of the record — only off the screen.
 */
/**
 * Headlines from outside the district — M9-59.
 *
 * ## Everything here is about not being mistaken for the district
 *
 * The heading names the source. Each row names its outlet. The panel carries its age like every
 * other panel on this wall, and when the line has been down long enough the age is what the room
 * sees rather than the headlines — a story from this morning shown at nine in the evening as
 * though it were now is the exact failure `domain/wall.ts` exists to prevent, and this is the one
 * panel where the district cannot issue a correction, because they did not write it.
 *
 * ~~Nothing is clickable. A room reads this; it does not click it (ADR-0013 §1), and no link
 * ever leaves the server for that reason.~~ **Reversed by the owner on 2026-08-19, and the old
 * sentence is struck through rather than deleted, because it was right about the wall and wrong
 * about everything else.** ADR-0013 is *one application on every size of screen*: the same panel
 * is read on a laptop and on a handset, where a reader who wants the story has no other way to
 * reach it. Nobody clicks a television, and the wall loses nothing by the link being there.
 *
 * Every link opens in a **new tab** (`target="_blank"`, `rel="noopener noreferrer"`). On the
 * wall that matters more than anywhere else: a kiosk that navigated away from itself would sit
 * on a news site until somebody walked over and brought it back.
 *
 * ## It scrolls, and the scroll is the rotation
 *
 * The list is Urdu then English, decided **on the server** (`NEWS_LANGS`), and the track runs
 * bottom to top through both. There is no second timer, no language toggle and no rotation
 * state: what the room sees change is the same list moving, which is the cheapest honest way to
 * make a panel look alive and the one that cannot drift out of step with the panel's own paint.
 *
 * ⚠️ **It is rebuilt only when the headlines actually change.** The dashboard repaints every
 * twenty seconds, and rebuilding the track each time would restart the scroll from the top three
 * times a minute — a panel visibly jumping over no news at all, which is the defect `reconcile`
 * exists to prevent. The signature is on the container; an unchanged one is left alone.
 *
 * `textContent` throughout, never `innerHTML`. The server strips tags out of the feed already —
 * this is the second of the two, because the content comes from outside and one defence is not
 * a number of defences.
 */
function renderNews(feed: DashboardFeed): void {
  const target = document.getElementById('dashNews');
  const age = document.getElementById('dashNewsAge');
  if (target === null || age === null) return;
  clear(target);

  const news = feed.news;
  if (news === undefined) {
    age.textContent = '';
    return;
  }

  // The source, always, beside the age. A headline whose origin is not stated is a headline a
  // room will attribute to whoever owns the screen.
  if (news.fetchedAt === null) {
    delete age.dataset['since'];
    age.textContent = news.source;
  } else {
    age.dataset['pre'] = `${news.source} · `;
    const at = sinceMinutes(news.ageMinutes);
    if (at === null) delete age.dataset['since'];
    else age.dataset['since'] = String(at);
    paintAge(age);
  }
  age.className = news.ageMinutes !== null && news.ageMinutes > 120 ? 'age state-pending' : 'age';
  // Against the same 120 minutes the line above turns amber at. Null when the fetch has never
  // succeeded — an empty rail beside a source name, which is exactly the state.
  setFresh('dashNewsFresh', news.fetchedAt === null ? null : sinceMinutes(news.ageMinutes));

  if (news.headlines.length === 0) {
    // Said out loud rather than left blank: an empty panel reads as a quiet country, and the
    // district would have no way to tell that from a line that is down.
    delete target.dataset['sig'];
    target.appendChild(box('empty', 'no headlines yet'));
    return;
  }

  /**
   * The titles, in order, and nothing else.
   *
   * Deliberately **not** the ages: every row carries one and `paintAge` rewrites it every second,
   * so a signature that included them would differ on every poll and the track would restart
   * three times a minute. Same reasoning as `signatureOf`, one panel along.
   */
  const signature = JSON.stringify(news.headlines.map((item) => item.title));
  if (target.dataset['sig'] === signature && target.firstChild !== null) return;
  target.dataset['sig'] = signature;
  clear(target);

  const track = box('ntrack');

  /**
   * Every headline twice, and that is what makes the loop seamless rather than a jump.
   *
   * The track animates from `0` to `translateY(-50%)` of **its own** height — which, with two
   * identical copies, is exactly one copy — so the frame it ends on is pixel-identical to the
   * frame it starts on. `aria-hidden` on the second pass, because a screen reader should be told
   * six stories and not twelve.
   */
  for (const pass of [0, 1]) {
    for (const item of news.headlines) {
      const urdu = item.lang === 'ur';
      const url = item.url ?? null;

      // An anchor when there is somewhere to go, a plain row when there is not. A dead link on a
      // wall is worse than no link: it teaches a room that the panel does not work.
      const row = document.createElement(url === null ? 'div' : 'a');
      row.className = 'nrow';
      if (urdu) row.setAttribute('dir', 'rtl');
      if (row instanceof HTMLAnchorElement) {
        row.href = url ?? '';
        row.target = '_blank';
        row.rel = 'noopener noreferrer';
      }

      // A headline is the outlet's words — never put through the Urdu word list (ADR-0042).
      const title = span('ntitle', item.title);
      title.setAttribute('translate', 'no');
      row.appendChild(title);

      // Each story's own age, which is a different fact from when we fetched the list.
      const outlet = item.outlet !== null && item.outlet !== '' ? item.outlet : '';
      if (item.publishedAt !== null) {
        row.appendChild(
          ageSpan('nmeta', Date.parse(item.publishedAt), outlet === '' ? '' : `${outlet} · `),
        );
      } else if (outlet !== '') {
        row.appendChild(span('nmeta', outlet));
      }

      if (pass === 1) row.setAttribute('aria-hidden', 'true');
      track.appendChild(row);
    }
  }

  /**
   * How long one pass takes, and it is per **row** rather than a fixed number.
   *
   * Six seconds a headline, so a room reads a story rather than watching it go by — and so the
   * cadence does not change the day the district asks for ten headlines instead of twelve.
   * Reduced motion gets no animation at all and the panel becomes scrollable instead, because
   * the alternative is hiding half the list from somebody who asked not to be moved.
   */
  if (!reducedMotion()) {
    track.style.animationDuration = `${String(news.headlines.length * 6)}s`;
  }

  target.appendChild(track);
}

function renderActivity(feed: DashboardFeed): void {
  const target = document.getElementById('dashActivity');
  const count = document.getElementById('dashActivityCount');
  const more = document.getElementById('dashActivityMore');
  if (target === null || count === null || more === null) return;

  const activity = feed.activity;
  if (activity === undefined) {
    // An older server. Say nothing rather than an empty panel that reads as a quiet district.
    clear(target);
    more.textContent = '';
    count.textContent = '';
    return;
  }

  count.textContent = activity.total === 0 ? '' : `${String(activity.total)} today`;
  count.className = 'age';

  if (activity.visible.length === 0) {
    clear(target);
    target.appendChild(box('empty', 'nothing today'));
    more.textContent = '';
    // Cleared, so the next row to arrive is arriving into an empty panel rather than into one
    // that still believes it has been painted — otherwise the district's first event after a
    // quiet night slides in as though it were the twentieth.
    delete target.dataset['primed'];
    return;
  }

  /**
   * The one panel where a new row is genuinely news — phase 5, 2026-08-14.
   *
   * This is the last feed on the dashboard that still wiped itself (`clear()` plus an append
   * loop), which meant an emergency reported thirty seconds ago and an item from last night were
   * drawn exactly alike. On a wall screen that is the whole point of the panel, missed.
   *
   * **Keyed on time, kind and headline together, because the server sends no id here.** Any one
   * of the three alone collides: two departments acknowledge in the same minute, or one kind
   * repeats all evening. The triple is stable across polls, which is what reconciliation needs.
   * Two byte-identical events inside the same second would still collide — accepted, because the
   * only cost is that the second one does not animate.
   */
  reconcile(
    target,
    activity.visible,
    (item) => `${item.at}|${item.kind}|${item.headline}`,
    (item) => {
      const row = box('act-row');
      row.dataset['kind'] = item.kind;
      row.appendChild(span('act-when z1', hhmm(new Date(item.at))));

      /**
       * The sentence travels; the clock does not.
       *
       * `z3` goes on the body rather than on `.act-what`, for the reason the carried row
       * already carries: `.act-what` and `.act-who` are inline spans with a middot between
       * them, and `translateZ` does nothing to an inline box.
       */
      const body = box('z3');
      body.appendChild(span('act-what', item.headline));
      if (item.detail !== null) body.appendChild(span('act-who', item.detail));
      row.appendChild(body);

      // Ordinary children above, wrapped once here — see `makeCard`.
      makeCard(row);

      return row;
    },
    (row) => {
      row.classList.add('act-entering');
      // Taken off once it has played, so the next poll's comparison sees the same markup it
      // stored and does not replace a row for a class that is no longer doing anything.
      row.addEventListener('animationend', () => row.classList.remove('act-entering'), {
        once: true,
      });
    },
  );

  // Null when nothing is held back. A permanent "and 0 more" teaches people to stop reading the
  // line, and then it is not there on the morning it says 40.
  more.textContent = activity.more ?? '';
}

/**
 * One of the two importance panels — M10-20…25/41/42. Shared by both, called once per side.
 *
 * **Same shape as `renderActivity`, deliberately.** The rows are the same kind of thing — a
 * time, a headline, a detail, no id (ADR-0013 §1) — and reusing its exact markup classes
 * (`.act-row`/`.act-when`/`.act-what`/`.act-who`) means this costs no new CSS for the row itself.
 *
 * **Not time-windowed.** `activity` rotates by age; these are capped by count, on the server,
 * because an open emergency does not expire by age the way "what happened recently" does — see
 * `domain/importancePanels.ts`'s own header for why that rules out reusing `windowActivity`.
 */
function renderImportancePanel(
  window: DashboardFeed['importantEmergencies'],
  targetId: string,
  countId: string,
  moreId: string,
  emptyWord: string,
): void {
  const target = document.getElementById(targetId);
  const count = document.getElementById(countId);
  const more = document.getElementById(moreId);
  if (target === null || count === null || more === null) return;

  if (window === undefined) {
    // An older server that does not send this field. That is *"we cannot tell"*, not *"nothing
    // is open"* — so leave the section on the wall (empty) rather than hiding it on a guess.
    markPanelEmpty(targetId, false);
    clear(target);
    count.textContent = '';
    more.textContent = '';
    return;
  }

  // Nothing of this importance is open — the owner's chosen state for these two to leave the
  // wall (2026-09-08). `applyLayout` reads this and keeps the section hidden; the row it comes
  // back for is one an operator can act on.
  markPanelEmpty(targetId, window.total === 0);

  count.textContent = window.total === 0 ? '' : `${String(window.total)} open`;
  count.className = 'age';

  if (window.visible.length === 0) {
    clear(target);
    target.appendChild(box('empty', emptyWord));
    more.textContent = '';
    delete target.dataset['primed'];
    return;
  }

  reconcile(
    target,
    window.visible,
    // No id on the row (ADR-0013 §1) — the same triple `renderActivity` keys on, for the same
    // reason: any one alone can collide, and the triple is stable across polls.
    (item) => `${item.at ?? ''}|${item.headline}|${item.detail ?? ''}`,
    (item) => {
      const row = box('act-row');
      row.appendChild(span('act-when z1', item.at === null ? '—' : hhmm(new Date(item.at))));

      // Same three heights as the activity feed above — one row shape, one treatment.
      const body = box('z3');
      body.appendChild(span('act-what', item.headline));
      if (item.detail !== null) body.appendChild(span('act-who', item.detail));
      row.appendChild(body);

      // Ordinary children above, wrapped once here — see `makeCard`.
      makeCard(row);

      return row;
    },
    (row) => {
      row.classList.add('act-entering');
      row.addEventListener('animationend', () => row.classList.remove('act-entering'), {
        once: true,
      });
    },
  );

  more.textContent = window.more ?? '';
}

/**
 * **The things that do not finish at midnight** — the district's five, 2026-08-22.
 *
 * One panel, five named lanes, and an age on every row. It is the only panel on this screen
 * measured over something other than today, which is why its own heading says **OPEN** in as
 * many words: two honest numbers answering different questions on one wall is INV-04's trap,
 * and the screen has to resolve it rather than leaving a reader to.
 *
 * ⚠️ **Every age is an `ageSpan`, never text.** `signatureOf` blanks `[data-since]` before
 * comparing, so a number this panel had baked into a string would freeze between polls while
 * the clock beside it moved — and, worse, would make every row differ from its own rebuild and
 * repaint the whole panel every twenty seconds (the `overdueByMinutes` lesson).
 */
/**
 * How many carried rows the panel holds still for.
 *
 * Above this it becomes a ticker; at or below it, the rows simply sit there. A panel with three
 * things in it that crawled upwards would be motion with nothing to show — and the window is
 * `10.5rem`, so this is roughly what fits. ⚠️ **Roughly**: a flagged row carries a third
 * line, so no constant here can be a claim about pixels. It is a floor to stop an almost-empty
 * panel moving, not a measurement.
 */
const STILL_ROLLS_ABOVE = 3;

function renderStillRunning(feed: DashboardFeed): void {
  const target = document.getElementById('dashStill');
  const count = document.getElementById('dashStillCount');
  const more = document.getElementById('dashStillMore');
  if (target === null || count === null || more === null) return;

  const window_ = feed.stillRunning;
  if (window_ === undefined) {
    /**
     * An older server. **Say nothing rather than "0 still running"**, which would be this
     * screen asserting something it was never told — the rule the carry-over strip already
     * follows for the same reason.
     */
    clear(target);
    count.textContent = '';
    more.textContent = '';
    return;
  }

  count.textContent = window_.total === 0 ? '' : `${String(window_.total)} open`;
  count.className = 'age';

  if (window_.visible.length === 0) {
    clear(target);
    target.appendChild(box('empty', 'nothing is still running'));
    more.textContent = '';
    delete target.dataset['primed'];
    return;
  }

  /**
   * **The film, and it is built from the data twice rather than cloned.**
   *
   * A seamless loop needs the list to appear twice — `.strack` travels -50% of its own height,
   * so with two identical copies the last frame is the first. The news ticker does the same
   * thing a few hundred lines above.
   *
   * ⚠️ **Cloning the rendered rows would have been the obvious way and it is the wrong
   * one here.** This panel is reconciled, not rebuilt: rows keep their DOM identity across a
   * poll so nothing flashes that is not news (test 6). A clone rebuilt on every poll would
   * flicker the lower copy every few seconds, mid-travel. Rendering the data twice with
   * pass-aware keys keeps **both** copies stable across polls, which is the property that
   * matters.
   */
  const rolling = window_.visible.length > STILL_ROLLS_ABOVE;
  const film = rolling
    ? [
        ...window_.visible.map((row) => ({ row, pass: 0 })),
        ...window_.visible.map((row) => ({ row, pass: 1 })),
      ]
    : window_.visible.map((row) => ({ row, pass: 0 }));

  target.dataset['rolling'] = rolling ? 'yes' : 'no';
  /**
   * Six seconds a row, which is the news ticker's own pace and is not a coincidence — two
   * panels on one wall travelling at two speeds is a thing a room notices and cannot explain.
   * The duration is for **one** copy, so the loop reads at the same rate whether it is doubled
   * or not.
   */
  target.style.animationDuration = rolling ? `${String(window_.visible.length * 6)}s` : '';

  reconcile(
    target,
    film,
    /**
     * The incident's own id, **and which copy of the film this is**.
     *
     * The id replaced `lane|headline|since` when the row became openable — three fields that
     * were stable *enough* to tell two floods apart and were never a guarantee. The pass is
     * what keeps the two copies from being one key twice, which `reconcile` would resolve by
     * dropping half the film.
     */
    ({ row, pass }) => `${row.incidentId}|${String(pass)}`,
    ({ row, pass }) => {
      const node = box('srow');
      if (row.reviewMark !== null) node.dataset['review'] = 'due';
      // A screen reader is told the list once. The second copy exists to make the loop seamless
      // for somebody watching it, and reading every carried thing twice would be a worse
      // experience than not scrolling at all.
      if (pass === 1) node.setAttribute('aria-hidden', 'true');

      /**
       * 🔴 **The row leads somewhere, because reading it raises a question it cannot
       * answer.** The panel says a flood is on day 11 and its date has passed; what an operator
       * does next is open it, see who has it, and either close it or leave it running. None of
       * that can happen on a wall — so this hands the incident to the board and does nothing
       * else. `leadsTo` and not a click handler: an officer at a desk drives this with Tab.
       */
      if (links.onOpenIncident !== undefined) {
        const id = row.incidentId;
        leadsTo(node, `Open ${row.headline}`, () => {
          links.onOpenIncident?.(id);
        });
      }

      node.appendChild(span('slane z1', row.lane.toUpperCase()));

      /**
       * The matan travels; the lane and the ages do not.
       *
       * `z3` goes on the **whole body** rather than on `.act-what` alone, and that is a
       * constraint rather than a preference: `.act-what` and `.act-who` are inline spans with a
       * middot between them (`.act-who::before`), and `translateZ` does nothing to an inline
       * box — lifting the headline alone would need `inline-block` on it and would put the
       * review mark on a different plane from the sentence it is asking about. They are one
       * block of text about one thing, so they travel together.
       */
      const body = box('z3');
      body.appendChild(span('act-what', row.headline));
      if (row.detail !== null) body.appendChild(span('act-who', row.detail));
      if (row.attendance !== null) body.appendChild(span('act-who', row.attendance));
      /**
       * The review mark, and it **asks** rather than asserting.
       *
       * *"Its date has passed"* is a fact about the calendar. *"This is finished"* is a claim
       * about Bajaur that only a person in the control room can make — so the row carries a
       * question, and nothing on this screen closes anything.
       */
      if (row.reviewMark !== null) body.appendChild(span('sflag', row.reviewMark));
      node.appendChild(body);

      const right = box('smeta z1');
      // How long it has been running. The district asked for exactly this: "rozana iska pata
      // hona zaroori hai".
      right.appendChild(ageSpan('sage', row.since === null ? null : Date.parse(row.since)));
      /**
       * ⚠️ **And how long since anything happened on it**, which is the half that makes the
       * first honest. A day-5 flood updated two hours ago and a day-5 flood with nothing for
       * 31 hours are different situations, and a panel that drew them identically would be
       * lying about the one that needs chasing.
       */
      right.appendChild(
        ageSpan(
          'sseen',
          row.lastRecordedAt === null ? null : Date.parse(row.lastRecordedAt),
          'updated ',
        ),
      );
      right.appendChild(span('suntil', row.reviewLabel));
      node.appendChild(right);

      // Ordinary children above, wrapped once here — see `makeCard`. It runs BEFORE the
      // height below is measured, because `scrollHeight` has to describe the film as drawn.
      makeCard(node);

      return node;
    },
    (node) => {
      node.classList.add('act-entering');
      node.addEventListener('animationend', () => node.classList.remove('act-entering'), {
        once: true,
      });
    },
  );

  /**
   * 🔴 **The window is sized to exactly one copy of the film, in pixels, and it is
   * measured AFTER the rows are in the DOM.**
   *
   * A height in the stylesheet cut the panel roughly in half — the district asked for the rows
   * to travel and got most of them behind a clip. The mistake was thinking the motion came from
   * the window being short: the film always holds the rows **twice** and always travels -50% of
   * its own height, so it moves whatever the window is. The height only decides how much a room
   * reads at once, and one copy is all of it.
   *
   * ⚠️ **Measured rather than written down, because a row is two lines or three** — the
   * review mark adds one — so no constant could be right for every district on every day. And
   * measured **here**, below `reconcile`: read before it, `scrollHeight` still describes the
   * previous paint, which is a panel sized for the rows it used to hold.
   *
   * `scrollHeight` is layout and is unaffected by the `transform` that moves the track, so it
   * reads the same mid-travel as at rest.
   */
  const listWindow = target.parentElement;
  if (listWindow !== null) {
    listWindow.style.height = rolling ? `${String(target.scrollHeight / 2)}px` : '';
  }

  more.textContent = window_.more ?? '';
}

function renderAlerts(feed: DashboardFeed): void {
  const target = el('dashAlerts');
  const count = el('dashAlertCount');
  clear(target);

  // No advisory in force leaves this panel off the wall (2026-09-08, the owner). A district that
  // has not laid `alerts` out never had it anyway; one that has gets it back the moment either
  // office issues something.
  markPanelEmpty('dashAlerts', feed.alerts.length === 0);

  if (feed.alerts.length === 0) {
    target.appendChild(box('empty', 'nothing in force'));
    count.textContent = '';
    return;
  }

  count.textContent = `${String(feed.alerts.length)} in force`;
  count.className = 'age';

  for (const alert of feed.alerts) {
    const row = box('alert-row');
    // The tag is a shape with a ground of its own, so it goes to `z4` — the layer that casts
    // with a `drop-shadow` rather than smearing a `text-shadow`.
    row.appendChild(span(`atag ${alert.tag} z4`, TAG_WORDS[alert.tag] ?? 'NOTICE'));

    const body = box('z3');
    body.appendChild(span('amsg', alert.message));
    // Both ends stated. An advisory people cannot tell the age of is one they either act on
    // too long or stop reading altogether.
    body.appendChild(
      ageSpan('awhen', Date.parse(alert.issuedAt), '', ` · until ${untilWords(alert.untilAt)}`),
    );
    row.appendChild(body);

    // Ordinary children above, wrapped once here — see `makeCard`.
    makeCard(row);

    /**
     * An advisory has no screen of its own — it is two sentences. Rather than invent one, the
     * row opens Status, where the two offices can withdraw it and everybody else can see the
     * full list.
     *
     * 🔴 **It used to borrow `.pitem` for the cursor and the focus ring, and that stopped
     * working the day `.pitem` became a card — 2026-08-23.** The rule it was reaching for now
     * asks for a `.face`, which an advisory row did not have, so the one panel on this wall
     * whose rows lead somewhere lost both affordances with nothing on screen to say so.
     * `.alert-row.go` carries its own states now: a card type declares what it needs, it does
     * not wear a neighbour's class.
     */
    if (links.onOpenStatus !== undefined) {
      leadsTo(row, 'Open advisories', () => links.onOpenStatus?.());
    }

    target.appendChild(row);
  }
}

function untilWords(iso: string): string {
  const ends = new Date(iso);
  if (Number.isNaN(ends.getTime())) return 'further notice';

  const sameDay = ends.toDateString() === new Date().toDateString();
  return sameDay
    ? hhmm(ends)
    : ends.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}

function renderFacts(feed: DashboardFeed): void {
  const target = el('dashFacts');
  clear(target);

  for (const fact of feed.facts) {
    const node = box('fact');
    // The figure is what the tile is for, so it takes `z3` and travels furthest — the same
    // height `renderKeys` gives a counter's number, for the same reason.
    node.appendChild(span('k z1', fact.label));
    const tone = fact.value === null ? 'v none z3' : 'v z3';
    const value = span(tone, fact.value ?? 'not supplied yet');
    node.appendChild(value);
    // Ordinary children above, wrapped once here — see `makeCard`.
    makeCard(node);
    target.appendChild(node);
  }
}

function renderResources(feed: DashboardFeed): void {
  const r = feed.resources;
  const target = el('dashResources');
  clear(target);

  el('dashFleetScope').textContent = r.total === 0 ? '' : `${String(r.total)} in the fleet`;

  if (r.total === 0) {
    // The reason a dispatch will not happen tonight, said as a sentence. A panel of four
    // zeroes is technically correct and tells nobody what to do about it.
    target.appendChild(box('empty', `No vehicles or crews are on ${feed.scope}'s list yet.`));
    return;
  }

  const keys: { k: string; n: number; tone?: 'alarm' | 'warn' }[] = [
    // Available first, because it is the number somebody is looking for when they ask.
    // Red at zero: nothing left to send is an emergency about emergencies.
    { k: 'Available', n: r.available, ...(r.available === 0 ? { tone: 'alarm' as const } : {}) },
    { k: 'Out on a job', n: r.committed },
    {
      k: 'Out of service',
      n: r.outOfService,
      ...(r.outOfService > 0 ? { tone: 'warn' as const } : {}),
    },
    { k: 'In the fleet', n: r.total },
  ];

  for (const key of keys) {
    const node = box(`key${key.tone === undefined ? '' : ` ${key.tone}`}`);
    node.appendChild(span('n', String(key.n)));
    node.appendChild(span('k', key.k));
    target.appendChild(node);
  }
}

/** Minutes as a person would say them. */
function minutes(value: number | null): string {
  if (value === null) return '—';
  if (value < 60) return `${String(value)} min`;

  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest === 0 ? `${String(hours)} hr` : `${String(hours)} hr ${String(rest)} min`;
}

function renderPerformance(feed: DashboardFeed): void {
  const target = el('dashPerformance');
  clear(target);

  if (feed.performance.length === 0) {
    target.appendChild(box('empty', 'nothing in the last seven days'));
    return;
  }

  for (const row of feed.performance) {
    const node = box('pitem');
    node.appendChild(span('pn', row.name));

    // A dash, never a zero. Zero minutes is the best possible performance and no data is not
    // performance at all — the two must not look alike (ADR-0005, INV-04).
    const value = span('pc', minutes(row.medianAckMinutes));
    if (row.overdue > 0) value.classList.add('state-critical');
    node.appendChild(value);

    node.appendChild(
      box(
        'pw',
        row.overdue > 0
          ? `${String(row.open)} open · ${String(row.overdue)} past the deadline`
          : `${String(row.open)} open`,
      ),
    );

    if (links.onOpenDepartment !== undefined) {
      leadsTo(node, `Open the board for ${row.name}`, () => links.onOpenDepartment?.(row.name));
    }

    target.appendChild(node);
  }

  /**
   * These figures, as a file — M6-13.
   *
   * Only for the two offices, and not out of secrecy: this is the **comparison** table, and a
   * department downloading everybody else's response times is a different product from the one
   * the district asked for. The server refuses it either way (`districtPerformance` asks for
   * administration), so this is the screen agreeing with the server rather than enforcing
   * anything — INV-05 puts the control in one place and it is not here.
   */
  if (feed.isAdministration) {
    const download = document.createElement('a');
    download.className = 'pdl';
    download.href = '/export/performance.csv?days=30';
    download.setAttribute('download', '');
    download.textContent = 'Download the last 30 days';
    target.appendChild(download);
  }
}

function renderCondition(feed: DashboardFeed): void {
  const panel = el('dashConditionPanel');

  /**
   * Marked empty rather than hidden directly — M6-30.
   *
   * `applyLayout` runs last and un-hides everything the layout names, so a panel that hid
   * itself here would come straight back with nothing in it. The mark says *"there is nothing
   * to show"*, which is a different fact from *"the district did not choose this"*, and the
   * layout honours both.
   */
  panel.dataset['empty'] = String(feed.condition.length === 0);
  panel.hidden = feed.condition.length === 0;
  if (feed.condition.length === 0) return;

  const target = el('dashCondition');
  clear(target);

  for (const item of feed.condition) {
    const node = box('pitem');
    node.appendChild(span('pn', item.what));
    node.appendChild(span(`tag ${item.state}`, item.state === 'ok' ? 'Yes' : 'No'));
    node.appendChild(box('pw', item.detail));

    if (links.onOpenAdmin !== undefined && links.canAdmin?.() === true) {
      leadsTo(node, `Open the console for ${item.what}`, () => links.onOpenAdmin?.());
    }

    target.appendChild(node);
  }
}

/**
 * Keep a panel off the wall until it carries a row — 2026-09-08, the owner's ask:
 * *"ju bilkul khaali hai wo hide rakhna chah raha hon … data ajane sai wo dashboard pr dikh
 * jaega"*.
 *
 * It sets the **same `data-empty` mark `renderCondition` has used since M6-30**, and for the
 * same reason: `applyLayout` runs last and un-hides every panel the layout names, so a section
 * that hid itself here would come straight back with an empty body. The mark says *"there is
 * nothing to show"* — a different fact from *"the district did not choose this"* — and
 * `applyLayout` honours both by skipping the section without dropping it from the arrangement.
 *
 * ⚠️ **Only for panels whose emptiness genuinely says nothing.** A status list reading
 * *"nothing configured yet"* is stating a fact — nobody set the service up — and MUST stay on
 * the wall (`renderStatusList`), the same way the six calm `situation` cards do. This is for
 * `importantEmergencies` / `routineEmergencies` / `alerts`, where "nothing open" is not a
 * gap in the setup, it is the good news.
 *
 * `innerId` is the list element a render already holds; the section is its nearest
 * `[data-panel]` ancestor, which is what `applyLayout` walks.
 */
function markPanelEmpty(innerId: string, empty: boolean): void {
  const section = document.getElementById(innerId)?.closest<HTMLElement>('[data-panel]');
  if (section == null) return;
  section.dataset['empty'] = String(empty);
}

/**
 * The scene behind the reading — 2026-08-19.
 *
 * Held at module scope and mounted once, because `#dashWeatherScene` is a **sibling** of
 * `#dashWeather` and therefore survives the `clear()` at the top of every repaint. Mounting it
 * inside the reconciled node would rebuild the canvas twenty times an hour and restart the rain
 * each time — which is the same fault `reconcile` was written to remove, one element along.
 */
let scene: WeatherScene | null = null;

/** Torn down with the dashboard: a loop running behind another screen is work nobody can see. */
function stopWeatherScene(): void {
  scene?.stop();
  scene = null;
}

function renderWeather(feed: DashboardFeed): void {
  const target = el('dashWeather');
  const age = el('dashWeatherAge');
  clear(target);

  const w = feed.weather.reading;

  /**
   * The picture comes from the same number the word does.
   *
   * `sceneFor` returns null for a code it does not know, and null draws nothing — the panel then
   * reads exactly as it did before any of this existed. `describeCode` already refuses to guess a
   * condition from an unmapped code, and a picture is a worse place to start guessing than a word.
   */
  const host = document.getElementById('dashWeatherScene');
  if (host !== null) {
    scene ??= mountWeatherScene(host, reducedMotion());
    const shape = w === null ? null : sceneFor(w.code ?? null);
    scene.show(
      shape === null || w === null ? null : { ...shape, night: isNight(w.sunrise, w.sunset) },
    );
  }

  if (w === null || w.temperatureC === null) {
    target.appendChild(box('empty', 'no reading has ever been fetched'));
    age.textContent = '';
    return;
  }

  const now = box('wx');
  now.appendChild(span('t', `${String(Math.round(w.temperatureC))}°C`));
  now.appendChild(span('tag unknown', w.condition));
  target.appendChild(now);

  const grid = box('wxgrid');
  const cells: [string, string][] = [
    ['Feels like', w.apparentC === null ? '—' : `${String(Math.round(w.apparentC))}°`],
    ['Humidity', w.humidity === null ? '—' : `${String(Math.round(w.humidity))}%`],
    ['Wind', w.windKph === null ? '—' : `${String(Math.round(w.windKph))} km/h`],
    ['Rain', w.precipitationChance === null ? '—' : `${String(w.precipitationChance)}%`],
    ['Sunrise', w.sunrise === null ? '—' : w.sunrise.slice(11, 16)],
    ['Sunset', w.sunset === null ? '—' : w.sunset.slice(11, 16)],
  ];

  for (const [k, v] of cells) {
    const cell = box('');
    cell.appendChild(span('k', k));
    cell.appendChild(span('v', v));
    grid.appendChild(cell);
  }
  target.appendChild(grid);

  // The one panel that depends on a machine outside the district. When the line is down this
  // number stops moving, and its age is the only thing that says so.
  const minutes = feed.weather.ageMinutes;
  const at = sinceMinutes(minutes);
  if (at === null) delete age.dataset['since'];
  else age.dataset['since'] = String(at);
  paintAge(age);
  age.className = minutes !== null && minutes > 90 ? 'age state-pending' : 'age';
  // The rail drains against the same 90 minutes this line turns amber at, so the two can never
  // disagree — `data-full` in the markup is that number.
  setFresh('dashWeatherFresh', at);
}

function panel(name: string, draw: () => void): void {
  try {
    draw();
  } catch (cause) {
    console.error(`dashboard panel "${name}" failed`, cause);
  }
}

/**
 * Every panel's body is one normal height, and its rows travel — 2026-08-27.
 *
 * The owner, looking at the wall: *"bake sub Cards ka size same ho … but ju un panels ka content
 * hai wo upar ki tarf jaa rahe ho, jis tarha Pakistan News ka content upar jaa raha hai … content
 * continuously upar jaa raha ho so es tarha sab kuch dikh jaega"*. So every panel except the four
 * below is a fixed, normal height, and its list scrolls bottom-to-top exactly the way the
 * Pakistan panel does — a room sees all of it come round rather than a panel growing to fit.
 *
 * ⚠️ **Functionality is untouched.** The list keeps its id and is still exactly what every
 * `render*` reconciles into — `getElementById` does not care how deep it sits. The only
 * structural change is a window (`.pflow`) around the list and, when it overruns, a decorative
 * `aria-hidden` copy after it so the loop has no seam — the same shape `renderNews` and
 * `renderStillRunning` already use, deliberately not a fourth mechanism.
 *
 * Runs LAST in `paint()`, after every renderer and after `applyLayout`, so it measures the final
 * contents against the final arrangement.
 */
const FLOW_SKIP = new Set([
  // Grids of small tiles that are meant to be read in one glance.
  'keys',
  'situation',
  // `data-flat` panels that draw their own scene / run their own ticker.
  'weather',
  'news',
  'outside',
  // Already travels, and measures its own window — leave it be.
  'stillRunning',
]);
const FLOW_SECONDS_PER_ROW = 6;

function flowPanels(): void {
  const root = document.getElementById('dashboardView');
  if (root === null) return;

  for (const section of Array.from(
    root.querySelectorAll<HTMLElement>('.panels > .panel[data-panel]'),
  )) {
    const id = section.dataset['panel'] ?? '';
    // A hidden panel is still painted — `paint()` fills every panel and `applyLayout` then
    // arranges — so one the district did not choose has rows but no place on the wall.
    // A panel whose list is currently in the expand drawer (ADR-0036) is skipped too: its
    // list node is not under this `.lift` right now, and it must not travel while it is being
    // read at rest.
    if (FLOW_SKIP.has(id) || section.hidden || expandedPanels.has(id)) continue;

    const lift = section.querySelector<HTMLElement>('.lift');
    if (lift === null) continue;

    /**
     * 🔴 **Reuse the window this ran built last time — never wrap twice.** `flowPanels` runs on
     * every `paint()`, and the real list keeps its id inside the film, so the `.pflow` from the
     * previous paint is still here and still correct. The old check — "is the list's parent a
     * `.pfilm`?" — looked at *the first `<div>` child of `.lift`*, which after the first wrap is
     * the `.pflow` itself, not the list. So it never matched again: every paint wrapped the
     * previous wrapper AND cloned the whole growing subtree, doubling the panel's DOM each time
     * until style and layout stalled the tab.
     */
    let listWindow = lift.querySelector<HTMLElement>(':scope > .pflow');
    let film: HTMLElement | null = null;
    let list: HTMLElement | undefined;

    if (listWindow !== null) {
      film = listWindow.querySelector<HTMLElement>(':scope > .pfilm');
      list = film?.querySelector<HTMLElement>(':scope > div:not(.pflow-echo)') ?? undefined;
    } else {
      // The body list is the first block after the heading. Anything under it — the "and N more"
      // line — is a `<p>` and stays outside the window.
      list = Array.from(lift.children).find(
        (n): n is HTMLElement =>
          n instanceof HTMLElement && n.tagName === 'DIV' && !n.classList.contains('pflow'),
      );
      if (list === undefined) continue;
      // First time on this panel: build the window once and move the real list into it.
      listWindow = document.createElement('div');
      listWindow.className = 'pflow';
      film = document.createElement('div');
      film.className = 'pfilm';
      list.replaceWith(listWindow);
      film.appendChild(list);
      listWindow.appendChild(film);
    }
    if (film === null || listWindow === null || list === undefined) continue;

    const echo = film.querySelector<HTMLElement>(':scope > .pflow-echo');
    const overruns = list.scrollHeight > listWindow.clientHeight + 4;
    const rolling = overruns && !reducedMotion();

    if (!rolling) {
      if (echo !== null) echo.remove();
      film.dataset['rolling'] = 'no';
      film.style.animationDuration = '';
      delete film.dataset['echoSig'];
      continue;
    }

    /**
     * The second copy, rebuilt **only when the real list's contents changed** — a clone rebuilt
     * on every twenty-second poll would flicker mid-travel, which is the trap
     * `renderStillRunning` renders its rows twice to avoid.
     */
    const signature = `${String(list.childElementCount)}·${String(
      (list.textContent ?? '').length,
    )}`;
    if (echo === null || film.dataset['echoSig'] !== signature) {
      if (echo !== null) echo.remove();
      const copy = list.cloneNode(true) as HTMLElement;
      copy.classList.add('pflow-echo');
      copy.removeAttribute('id');
      for (const node of Array.from(copy.querySelectorAll<HTMLElement>('[id]'))) {
        node.removeAttribute('id');
      }
      copy.setAttribute('aria-hidden', 'true');
      film.appendChild(copy);
      film.dataset['echoSig'] = signature;
    }

    film.dataset['rolling'] = 'yes';
    // Per row, so the pace does not change with the list length — and six seconds is the news
    // ticker's own rate, because two panels on one wall at two speeds is a thing a room notices.
    film.style.animationDuration = `${String(
      Math.max(list.childElementCount, 4) * FLOW_SECONDS_PER_ROW,
    )}s`;
  }
}

/**
 * Expand a panel into a right-hand drawer — ADR-0036.
 *
 * The district's ask: several panels carry more rows than fit, and on the wall those rows
 * travel one past the other (`flowPanels` above, and the news / "Still running" tracks).
 * **Expand** lifts the whole list out into a drawer where it sits still — all of it, at once —
 * and every row still leads exactly where it led on the wall, because it is the same node
 * with the same handlers. The drawer is `drawer.ts`, shared; nothing here is a second copy of
 * the slide-in the app already has three of.
 *
 * ## It MOVES the list, it does not clone it
 *
 * A clone loses the `leadsTo` click handlers — added with `addEventListener`, not inline — and
 * freezes at one poll's values. Moving the real node keeps both: the twenty-second poll finds
 * it by id wherever it now lives and keeps it current, and `flowPanels` leaves it alone while
 * `expandedPanels` names it. On close the node returns to the exact spot a comment marker was
 * left in, and the next paint rebuilds the travelling film around it if it had one.
 *
 * ## What it deliberately does NOT do
 *
 * It grows no detail view. The rows hand off to the same screens they always did (the board,
 * Status, the console) — the drawer just shows the list at rest first. `DashboardLinks`' note
 * about "no detail view of its own" still holds: this is the list, not a thing beside it.
 */
const EXPAND_SKIP = new Set([
  // Read in one glance already — the district counters and the six emergency tiles.
  'keys',
  'situation',
  // Just a frame around weather + news; no heading and no list of its own.
  'outside',
]);

/** Panels whose list is in the drawer right now. `flowPanels` skips these. */
const expandedPanels = new Set<string>();

/**
 * Make every eligible panel's heading an "expand" control. Idempotent — a heading already
 * wired carries `data-expand` — and safe to call on every paint, like `makeCard`.
 *
 * The heading itself is the control: the district asked for the header, not a new button. The
 * corner glyph is the stylesheet's, and shows only on hover or keyboard focus.
 */
function mountExpanders(): void {
  const root = document.getElementById('dashboardView');
  if (root === null) return;

  for (const section of Array.from(
    root.querySelectorAll<HTMLElement>('.panels .panel[data-panel]'),
  )) {
    const id = section.dataset['panel'] ?? '';
    if (EXPAND_SKIP.has(id)) continue;

    // `makeCard` moves the heading down into `.lift`; a `data-flat` panel keeps it a direct
    // child. Either way a panel has exactly one.
    const heading = section.querySelector<HTMLElement>('h2');
    if (heading === null || heading.dataset['expand'] === 'on') continue;

    const label = (heading.querySelector('span')?.textContent ?? heading.textContent ?? '').trim();
    heading.dataset['expand'] = 'on';
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');
    heading.setAttribute('aria-label', `Expand ${label}`);

    const go = (): void => {
      expandPanel(section, heading, label);
    };
    heading.addEventListener('click', go);
    heading.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go();
      }
    });
  }
}

function expandPanel(section: HTMLElement, heading: HTMLElement, label: string): void {
  const id = section.dataset['panel'] ?? '';
  if (expandedPanels.has(id)) return;

  // Where the rows live: a `data-flat` panel keeps them a direct child of the section; a
  // carded one keeps them under `.lift`, and once `flowPanels` has run they are one level
  // deeper again, inside `.pflow > .pfilm`. "Still running" keeps its list inside a `.slist`.
  const holder = section.querySelector<HTMLElement>('.lift') ?? section;
  const flowed = holder.querySelector<HTMLElement>(':scope > .pflow');

  let list: HTMLElement | null;
  if (flowed !== null) {
    list = flowed.querySelector<HTMLElement>('.pfilm > div:not(.pflow-echo)');
  } else {
    list =
      Array.from(holder.children).find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement &&
          node !== heading &&
          node.tagName === 'DIV' &&
          !node.classList.contains('pflow') &&
          !node.classList.contains('od-parked'),
      ) ?? null;
    if (list !== null && list.classList.contains('slist')) {
      list = list.querySelector<HTMLElement>(':scope > div') ?? list;
    }
  }
  if (list === null) return;
  const listNode = list;

  // The node whose place is kept: the whole travelling film if there was one — the next paint
  // builds a fresh film once the list is home — otherwise the list itself.
  const anchor = document.createComment('od-anchor');
  (flowed ?? listNode).replaceWith(anchor);

  const parked = document.createElement('div');
  parked.className = 'od-parked';
  parked.textContent = 'Shown in the drawer →';
  anchor.parentNode?.insertBefore(parked, anchor);

  expandedPanels.add(id);
  section.dataset['expanded'] = 'on';

  const ageText = heading.querySelector<HTMLElement>('.age')?.textContent?.trim();

  const drawer = openDrawer({
    title: label,
    sub: ageText !== undefined && ageText !== '' ? ageText : undefined,
    returnFocusTo: heading,
    onClose: () => {
      parked.remove();
      anchor.replaceWith(listNode);
      expandedPanels.delete(id);
      delete section.dataset['expanded'];
      // Put the panel back exactly as a paint would leave it — `flowPanels` wraps every
      // non-skip panel's list in a `.pflow` window whether it rolls or not, and a bare list
      // sitting unclipped in the `.lift` until the next poll is the panel visibly the wrong
      // height (and shoving the wall's layout) for up to twenty seconds. Idempotent, so
      // calling it for this one panel now costs nothing and heals it in the same tick.
      flowPanels();
    },
  });

  drawer.body.appendChild(listNode);

  // A row leads where it always led; once it has, the drawer's work is done, so it closes.
  // Capture phase and a microtask, so the row's own handler runs first and the view switch is
  // already asked for. A headline opening a new tab is not leaving this screen — leave it up.
  drawer.body.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target === null || target.closest('a[target="_blank"]') !== null) return;
      if (target.closest('.go, [role="button"]') !== null) {
        queueMicrotask(() => {
          drawer.close();
        });
      }
    },
    true,
  );
}

/**
 * The ticker line.
 *
 * One sentence about the district, refreshed with the rest. It leads with whatever is wrong,
 * because a scrolling line somebody catches half of should give them the bad news in the half
 * they caught.
 */
/** How long one ticker frame holds before the next fades in. */
const TICKER_HOLD_MS = 8_000;

/** How many frames the facts are dealt into. */
const TICKER_FRAMES = 3;

let tickerTimer: number | null = null;

/**
 * Stop the ticker rotating. Called by `stop()` — a timer left running behind the board mutates
 * a bar nobody is looking at, for ever.
 */
function stopTicker(): void {
  if (tickerTimer !== null) clearInterval(tickerTimer);
  tickerTimer = null;
}

/**
 * Deal the facts into frames, **in order**, keeping bad news at the front.
 *
 * Not round-robin: `parts` is built worst-first on purpose, and dealing alternately would scatter
 * "3 nobody has been told about" into the third frame behind the district's name.
 */
function tickerChunks<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [];
  const size = Math.ceil(items.length / TICKER_FRAMES);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function renderTicker(feed: DashboardFeed): void {
  const bar = el('ticker');
  const line = el('tickerText');
  bar.hidden = false;

  const d = feed.district;
  const parts: { text: string; className?: string; sinceMs?: number | null }[] = [];

  // Same change as the lede above: the ticker on a wall screen says who has not been told,
  // which is the thing somebody in the room can act on, rather than what routing could not
  // place — which they cannot fix from where they are standing.
  if (d.nobodyTold > 0) {
    // The age is carried separately rather than baked into the string, so phase 1's ticker can
    // keep it moving. "oldest 9 min ago" sat frozen between polls exactly like the panels did.
    parts.push({
      text: `${String(d.nobodyTold)} with no one chosen${
        d.oldestUnassignedMinutes === null ? '' : ' — oldest '
      }`,
      className: 'bad',
      sinceMs: sinceMinutes(d.oldestUnassignedMinutes),
    });
  }
  if (d.overdueUnacknowledged > 0) {
    // `past deadline`, not `not acknowledged`: this counts OVERDUE ones, and `Issued` is what
    // the deck calls unanswered. Two different facts had one name (2026-08-18).
    parts.push({ text: `${String(d.overdueUnacknowledged)} past deadline`, className: 'bad' });
  }

  const quiet = feed.reporting.utilities.quiet + feed.reporting.presence.quiet;
  if (quiet > 0) parts.push({ text: `${String(quiet)} panels not reporting` });

  parts.push({ text: `${String(d.openIncidents)} open`, className: 'b' });
  parts.push({ text: `${String(d.today)} reported today` });
  parts.push({ text: feed.scope });

  /**
   * The ticker **rotates** rather than standing still — phase 5, 2026-08-14.
   *
   * It used to render every fact into one line, once per paint, and that line was identical on
   * the next paint and the one after. On a wall screen it read as a photograph: the single widest
   * piece of the dashboard, never moving.
   *
   * **⚠️ The cost, stated plainly: at any instant only about a third of the facts are on screen.**
   * A passer-by can look up during the frame that does not carry the thing they needed. Two
   * alternatives were considered and are recorded in CLAUDE.md — leaving it static, and pinning
   * the `bad` items into every frame while rotating only the rest. **The owner chose full
   * rotation** (2026-08-14); the other two remain available and neither requires undoing this.
   *
   * What holds the cost down is `tickerChunks` keeping source order: `parts` is built worst-first,
   * so the bad news is in the first frame, which is the one on screen when the panel paints and
   * the one it returns to every cycle.
   */
  stopTicker();

  const frames = tickerChunks(parts);
  if (frames.length === 0) {
    clear(line);
    return;
  }

  let at = 0;
  const show = (index: number, fade: boolean): void => {
    clear(line);
    (frames[index] ?? []).forEach((part, i) => {
      if (i > 0) line.appendChild(document.createTextNode('  ·  '));
      const node = document.createElement(part.className === 'b' ? 'b' : 'span');
      if (part.className === 'bad') node.className = 'bad';
      node.textContent = part.text;
      line.appendChild(node);
      // The age rides inside the same element run, so it inherits the part's colour and the
      // one-second sweep in `startAges` finds it like any other.
      if (part.sinceMs !== undefined && part.sinceMs !== null) {
        line.appendChild(ageSpan(part.className === 'bad' ? 'bad' : '', part.sinceMs));
      }
    });

    if (!fade) return;
    line.classList.remove('tickfade');
    // Forces the class to be re-applied as a new animation rather than ignored as unchanged.
    void line.offsetWidth;
    line.classList.add('tickfade');
  };

  show(0, false);

  // One frame is the whole of it, and a district quiet enough to produce one frame does not need
  // its ticker moving. Reduced motion holds the first frame for the same reason.
  if (frames.length < 2 || reducedMotion()) return;

  tickerTimer = window.setInterval(() => {
    at = (at + 1) % frames.length;
    show(at, true);
  }, TICKER_HOLD_MS);
}

/**
 * Put the panels where the district put them — ADR-0015, M6-30.
 *
 * **Reordering the markup that already exists**, rather than rendering panels from a
 * description. Every panel keeps its own element, its own render function and its own careful
 * wording; what the layout controls is which are shown, in what order, and how much width each
 * takes. Building them from a generic template would have meant rewriting fourteen panels to
 * gain nothing the district asked for, and losing the specific care in each one.
 *
 * The server decides. This function never chooses a panel and never chooses to hide one — it
 * applies `feed.layout`, which `resolveLayout` has already filtered by audience. A client that
 * decided its own arrangement would be a client deciding what it may see (INV-05).
 *
 * A panel not in the layout is **hidden, not removed**. Its element stays in the document, so
 * a render that runs against it fails silently rather than throwing — and `el()` throwing in
 * the middle of `paint` would take every panel after it down with the one that was cut.
 */
function applyLayout(feed: DashboardFeed): void {
  const grid = document.querySelector<HTMLElement>('#dashboardView .panels');
  if (grid === null) return;

  /**
   * No layout means **leave the markup alone**, not "hide everything".
   *
   * A cached shell talking to an older server, or an older shell talking to a newer one, must
   * render the arrangement this file shipped with. Hiding every panel because a field was
   * missing would turn a version skew into a blank wall in the DC office — and a service
   * worker makes version skew a normal Tuesday, not an edge case.
   */
  const layout = feed.layout;
  if (layout === undefined || layout.length === 0) return;

  const panels = new Map<string, HTMLElement>();
  for (const node of Array.from(grid.querySelectorAll<HTMLElement>('[data-panel]'))) {
    const id = node.dataset['panel'];
    if (id !== undefined) panels.set(id, node);
    node.hidden = true;
  }

  /**
   * Anything framed by a previous paint comes back out **first**.
   *
   * The placement loop below decides where a panel goes by appending it in layout order, and it
   * cannot put a panel in the right place while that panel is somebody else's child. So the
   * frame is emptied before the layout is applied and refilled after it — which also means a
   * district that stops choosing `outside` gets its two panels back where its layout says,
   * rather than stranded inside a hidden box.
   */
  for (const node of Array.from(grid.querySelectorAll<HTMLElement>('[data-nested]'))) {
    delete node.dataset['nested'];
    grid.appendChild(node);
  }

  for (const placed of layout) {
    const node = panels.get(placed.id);
    if (node === undefined) continue;

    // A panel that said it has nothing to show stays hidden. Chosen and empty is not the same
    // as chosen and full, and a titled panel with a blank body reads as a page that failed.
    if (node.dataset['empty'] === 'true') continue;

    node.hidden = false;
    // `wide` is the markup's own word for a two-column panel and predates the registry. The
    // layout's `large` means the same thing, so it drives the same class rather than a second
    // one that would have to be kept in step with it.
    node.classList.toggle('wide', placed.size === 'large');
    node.classList.toggle('narrow', placed.size === 'small');

    // Appending an element that is already a child moves it. Applied in layout order, so the
    // last append leaves the whole grid in the order the district chose.
    grid.appendChild(node);
  }

  frameOutside(panels);
}

/**
 * Weather above, headlines below, in one frame — 2026-08-19, the owner's decision.
 *
 * ## It moves the two panels; it does not draw them
 *
 * `renderWeather` and `renderNews` are untouched by any of this, every element id is untouched,
 * and neither the canvas nor the ticker is rebuilt — a moved node keeps running. The alternative
 * was a second copy of both panels' markup inside the frame, which would have duplicated every
 * id on the page and left the renderers painting whichever copy `getElementById` reached first.
 *
 * ## The two panels stay in the registry, and that is what makes this safe
 *
 * `outside` is a **third** choice rather than a replacement (ADR-0015). A district whose stored
 * layout names `weather` or `news` keeps rendering it exactly as before, and this function does
 * nothing at all for them.
 *
 * ⚠️ **The frame hides itself when either half is missing.** An empty bordered box on a wall
 * reads as a panel that failed to load, and this one has no words of its own to say otherwise.
 */
function frameOutside(panels: Map<string, HTMLElement>): void {
  const frame = panels.get('outside');
  if (frame === undefined) return;

  const weather = panels.get('weather');
  const news = panels.get('news');

  if (frame.hidden || weather === undefined || news === undefined) {
    frame.hidden = true;
    return;
  }

  for (const part of [weather, news]) {
    part.hidden = false;
    part.dataset['nested'] = 'true';
    // The frame decides its own width. A `narrow`/`wide` left on a nested panel would be a
    // column rule applying inside a single column, which is a class doing nothing until the day
    // somebody gives `.narrow` a second meaning.
    part.classList.remove('wide', 'narrow');
    frame.appendChild(part);
  }
}

export function paint(feed: DashboardFeed): void {
  /**
   * Every panel on this screen becomes a card, once.
   *
   * Here rather than at module load because `paint` is the first thing that runs with the
   * markup in place, and it is the one door every path goes through — `show()`, the twenty-second
   * poll and `/board/live`'s doorbell all end up on this line. `makeCard` returns immediately
   * for a panel it has already done, so the cost after the first paint is one attribute read
   * apiece.
   *
   * `#dashboardView` and not `document`: the Status screen mounts its own, and the board and the
   * shift screen have panels of their own that were never part of this.
   */
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('#dashboardView .panel'))) {
    makeCard(node);
    /**
     * A panel is a card, and it is a card that does not move — owner, 2026-08-27.
     *
     * *"ye cards tilt ho rahe hain … just ye tilt band kar du … en cards ki andar ju hai us ki
     * bath nhe kar raha hon"*: the panel stops answering the pointer, the rows inside it do not.
     *
     * ⚠️ **Here and not inside `makeCard`.** `status.ts` builds cards with the same call and
     * has no `mountTilt` at all, so its panels were never going to move either way — putting
     * `.still` in the shared builder would state a rule about the dashboard in a place that
     * cannot see it. `MOVES` in `tilt.ts` is what reads this class; the stylesheet's
     * `.panel.tilt.still` block is the backstop under it.
     *
     * Idempotent, like the `makeCard` above it — every poll comes through this line.
     */
    node.classList.add('still');
  }
  for (const deck of Array.from(document.querySelectorAll<HTMLElement>('#dashboardView .panels'))) {
    mountTilt(deck);
  }

  // Every eligible panel's heading becomes "expand into a drawer" — idempotent, like the two
  // loops above (ADR-0036).
  mountExpanders();

  el('dashTitle').textContent = feed.scope;
  el('dashAsOf').textContent = `as of ${hhmm(new Date(feed.asOf))}`;
  el('dashScope').textContent = feed.isAdministration
    ? 'The whole district. Every department, every emergency.'
    : `${feed.scope} — your own work, and the district facts everybody needs.`;

  panel('keys', () => {
    renderKeys(feed);
  });
  panel('categories', () => {
    renderCounts(
      'dashCategories',
      feed.categories.map((c) => ({
        name: c.label,
        count: c.open,
        label: `Open the board for ${c.label}`,
        ...(links.onOpenCategory === undefined
          ? {}
          : { open: (): void => links.onOpenCategory?.(c.category, c.label) }),
      })),
      'nothing open',
    );
  });
  panel('departments', () => {
    /**
     * **Open by officer** — ADR-0029, and the panel id stays `departments` on purpose.
     *
     * That id is a key in the district's own stored layout (ADR-0015). Renaming it would drop
     * the panel off the wall of every district that had chosen it, silently, with nothing on
     * any screen saying why — so what changed is the rows and the heading, never the handle.
     *
     * ⚠️ `feed.officers` is read with a fallback because this bundle is fetched at runtime and
     * can meet a server older than itself. An absent field means *this server does not send
     * one*, and drawing nothing is the honest answer; `?? []` rather than a throw, because a
     * missing panel is a gap and an exception is the whole screen.
     */
    /**
     * 🔴 **THIS PANEL COUNTED AND LED NOWHERE, WHICH IS THE DEFECT M11-06 EXISTS TO REFUSE.**
     *
     * `renderCounts` wires `leadsTo` only where an `open` handler is given, and the ADR-0029
     * rewrite did not carry one over — so every other figure on this wall drilled through to its
     * own rows and this one, alone, was a column of inert names. The rule this screen is built on
     * is that a figure somebody can read is a figure they will try to open.
     *
     * ⚠️ **And the door it opens had to be repointed before it could be opened.**
     * `onOpenDepartment` filters the board on `data-told` — see `incidentRow.ts`. It read
     * `data-departments` until ADR-0030, a value no row carries any more, so wiring this up
     * without that fix would have led every officer to *"nothing matches"* — the exact sentence
     * the owner reported, through the exact door that produced it the first time.
     */
    renderCounts(
      'dashDepartments',
      (feed.officers ?? []).map((d) => ({
        name: d.name,
        count: d.open,
        label: `Open the board for ${d.name}`,
        ...(d.unacknowledged > 0 ? { warn: true } : {}),
        ...(links.onOpenDepartment === undefined
          ? {}
          : { open: (): void => links.onOpenDepartment?.(d.name) }),
      })),
      'nobody has been told about anything',
    );
  });
  panel('situation', () => {
    renderSituation(feed);
  });
  panel('importantEmergencies', () => {
    renderImportancePanel(
      feed.importantEmergencies,
      'dashImportant',
      'dashImportantCount',
      'dashImportantMore',
      'nothing important open',
    );
  });
  panel('routineEmergencies', () => {
    renderImportancePanel(
      feed.routineEmergencies,
      'dashRoutine',
      'dashRoutineCount',
      'dashRoutineMore',
      'nothing routine open',
    );
  });
  panel('news', () => {
    renderNews(feed);
  });
  panel('stillRunning', () => {
    renderStillRunning(feed);
  });
  panel('activity', () => {
    renderActivity(feed);
  });
  panel('alerts', () => {
    renderAlerts(feed);
  });
  panel('facts', () => {
    renderFacts(feed);
  });
  panel('services', () => {
    renderStatusList(
      'dashServices',
      'dashServiceGap',
      feed.services,
      feed.reporting.services.quiet,
    );
  });
  panel('utilities', () => {
    renderStatusList(
      'dashUtilities',
      'dashUtilityGap',
      feed.utilities,
      feed.reporting.utilities.quiet,
    );
  });
  panel('presence', () => {
    renderStatusList(
      'dashPresence',
      'dashPresenceGap',
      feed.presence,
      feed.reporting.presence.quiet,
      // Where somebody is expires; whether the power is on does not. See renderStatusList.
      true,
    );
  });
  panel('weather', () => {
    renderWeather(feed);
  });
  panel('resources', () => {
    renderResources(feed);
  });
  panel('performance', () => {
    renderPerformance(feed);
  });
  panel('condition', () => {
    renderCondition(feed);
  });
  panel('ticker', () => {
    renderTicker(feed);
  });

  /**
   * Last, and after every panel has been filled.
   *
   * Applying the arrangement first would reorder empty panels and then paint them, which on a
   * slow machine is a screen that visibly rearranges itself in front of a room. Filling then
   * arranging is one repaint.
   */
  panel('layout', () => {
    applyLayout(feed);
  });

  /**
   * After the arrangement, never before: `flowPanels` measures each list against the height it
   * actually has on the wall, and a panel `applyLayout` has just hidden must not be measured.
   */
  panel('flow', () => {
    flowPanels();
  });
}

/**
 * The clock, which is not decoration.
 *
 * A dashboard shows numbers that were true at some point. A visibly running clock is the
 * cheapest proof anybody has that the page itself is alive, and when it stops that is the
 * first thing somebody notices from across a room.
 */
export function startClock(): void {
  const tick = (): void => {
    const now = new Date();
    el('clock').textContent = hhmm(now);
    el('dateline').textContent = now.toLocaleDateString(dateLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
  };

  tick();
  window.setInterval(tick, 1000);
}

export interface DashboardScreen {
  show(): Promise<void>;
  stop(): void;
}

/**
 * Poll while it is open, and stop the moment it is not.
 *
 * `setTimeout` rather than `setInterval`: an interval fires whether or not the previous
 * request finished, so a server that has become slow collects a growing queue of requests
 * from every open screen — the failure mode where the monitoring makes the outage worse.
 */
export function createDashboard(
  options: { intervalMs?: number } & DashboardLinks = {},
): DashboardScreen {
  links = options;

  const every = options.intervalMs ?? 20_000;
  let timer: number | null = null;
  let open = false;

  /**
   * The heartbeat, and it is only ever allowed to report what happened — 2026-08-14.
   *
   * `beat()` is called on an answer that actually arrived, and on nothing else. A failed fetch
   * leaves the pip dark and the ring frozen where it stood, so a screen whose data has stopped
   * **looks** stopped. Getting that backwards — sweeping the ring on a timer regardless — would
   * put a confident little animation on a dashboard that had lost the server, which is INV-02
   * with a moving part.
   */
  function beat(): void {
    const pip = document.getElementById('beatPip');
    if (pip !== null) {
      pip.classList.remove('hit');
      // Reading `offsetWidth` restarts the animation; without it a class removed and re-added in
      // the same frame is no change at all and the pip never flashes a second time.
      void pip.offsetWidth;
      pip.classList.add('hit');
    }

    const ring = document.getElementById('beatRing');
    if (ring === null) return;

    // Empty, instantly, then sweep to full over exactly one poll interval. The `transition: none`
    // and the reflow between them are what stop the browser animating the reset backwards.
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '50.3';
    void ring.getBoundingClientRect();
    ring.style.transition = `stroke-dashoffset ${String(every)}ms linear`;
    ring.style.strokeDashoffset = '0';
  }

  async function tick(): Promise<void> {
    try {
      const response = await fetch('/dashboard', { headers: { accept: 'application/json' } });
      if (response.ok) {
        const feed = (await response.json()) as DashboardFeed;
        /**
         * 🔴 **A response that lands after the operator has left must not repaint — M11-20.**
         *
         * `stop()` closes the stream and stops the ticker's timer, but a `/dashboard` fetch
         * already in flight still resolved and ran the whole of `paint()` afterwards. That
         * includes `renderTicker`, which sets `bar.hidden = false` **unconditionally** — so the
         * dashboard's scrolling footer reappeared on whatever screen the operator had moved to,
         * and stayed there.
         *
         * **Found by building the Reports screen and photographing it**: a bar reading *"22
         * nobody has been told about"* — today's live figure — sat at the bottom of a report
         * about July. That is not clutter, it is two periods on one screen with nothing saying
         * which is which, on the artefact most likely to be read by somebody who was not there.
         *
         * The guard is here rather than in `renderTicker` because the whole repaint is wrong,
         * not just the bar: every counter, every panel and every age on a screen nobody is
         * looking at, twenty seconds after they left it.
         */
        if (!open) return;
        paint(feed);
        beat();
      }
    } catch {
      // Offline, or the server is restarting. The panels keep whatever they had, with their
      // ages still ticking up — which is the honest thing for them to show, and the ring stays
      // where it stopped rather than pretending another refresh is on its way.
    } finally {
      if (open) timer = window.setTimeout(() => void tick(), every);
    }
  }

  /**
   * A fetch already in flight, so a second `show()` joins it instead of starting another.
   *
   * `tick` was already careful not to let a *timer* pile requests up on a slow server — "the
   * failure mode where the monitoring makes the outage worse". It was not careful about being
   * **shown twice**, and that turned out to be easy: arriving at the dashboard calls `show()`,
   * and issuing an advisory calls it again through `onChanged`.
   *
   * Each build of this feed runs about ten queries at once. Three overlapping builds want
   * thirty connections from a pool of ten, and the ones holding connections wait for ones that
   * will never come — so every request hangs, the browser's `fetch` never settles, and the
   * screen sits blank with no error anywhere. Found exactly that way: a test where three
   * `show()` calls overlapped and all three ticks stopped at the fetch, with the catch never
   * running because nothing ever failed.
   *
   * A blank dashboard that is not even trying is worse than one saying it cannot reach the
   * server, which is the whole of INV-02.
   */
  let inFlight: Promise<void> | null = null;

  /**
   * One guarded refresh, shared by the poll, the screen opening, and the doorbell below.
   *
   * Everything that wants a fresh feed goes through here, so the overlap protection above is not
   * something a new caller has to remember. The doorbell made that matter: before it, `show()`
   * was the only door.
   */
  async function refresh(): Promise<void> {
    if (timer !== null) clearTimeout(timer);
    if (inFlight !== null) return inFlight;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  /**
   * The dashboard's doorbell — phase 4, 2026-08-14.
   *
   * `GET /board/live` has existed since M8 and **only the board was listening**. So an emergency
   * reported now reached the wall up to twenty seconds later, with nothing on screen to say a
   * change was on its way. The stream says only *something changed* — never what — so this does
   * exactly what the poll it accelerates already did: ask `/dashboard` again.
   *
   * **The poll is not removed and must not be.** It is the reliability floor: if the stream never
   * connects, is blocked by a proxy, or the browser has no `EventSource`, the screen updates in
   * twenty seconds exactly as it always did. Nothing here is load-bearing for correctness — only
   * for speed. That is the same division the board settled on in M8.
   */
  const NUDGE_MS = 3_000;
  let stream: EventSource | null = null;
  let nudge: number | null = null;

  function openStream(): void {
    // Every browser this app targets has it; a handset that does not simply keeps the poll.
    if (typeof EventSource === 'undefined') return;
    if (stream !== null) return;

    stream = new EventSource('/board/live');
    stream.addEventListener('changed', () => {
      /**
       * **Coalesced, and this is not an optimisation — it is the reason the feature is safe.**
       *
       * Building this feed runs about ten queries at once (see `inFlight` above, and the outage
       * it was written for). A dispatch to eight officers announces repeatedly, and one rebuild
       * per announcement would aim a burst of eighty queries at the one machine that is also
       * taking emergency reports — the failure mode where the monitoring makes the outage worse.
       *
       * The first ring schedules the refresh and every ring inside that window is absorbed into
       * it, so a burst costs exactly one rebuild. Three seconds is far below the twenty it
       * replaces and far above the width of any single burst.
       */
      if (nudge !== null) return;
      nudge = window.setTimeout(() => {
        nudge = null;
        if (open) void refresh();
      }, NUDGE_MS);
    });
    // No reconnect logic on purpose: `EventSource` retries on its own using the server's `retry:`
    // value, and a connection that never recovers just leaves the poll — which is what this
    // screen had before today.
  }

  function closeStream(): void {
    stream?.close();
    stream = null;
    if (nudge !== null) clearTimeout(nudge);
    nudge = null;
  }

  return {
    async show(): Promise<void> {
      open = true;
      // The heartbeat belongs to this screen and to no other. Left visible behind the board it
      // would be a ring sweeping towards a refresh that is not happening.
      const beatBox = document.getElementById('beat');
      if (beatBox !== null) beatBox.hidden = false;
      openStream();
      await refresh();
    },
    stop(): void {
      open = false;
      const beatBox = document.getElementById('beat');
      if (beatBox !== null) beatBox.hidden = true;
      // Closed with the screen. A stream left open behind the board holds a connection on the
      // district's one server for a dashboard nobody is looking at.
      closeStream();
      // Same reasoning: a ticker left rotating behind the board redraws a bar nobody is reading.
      stopTicker();
      // And the same again, with teeth: the scene is a requestAnimationFrame loop, so leaving it
      // running behind another screen is the district's kiosk drawing rain nobody can see, for
      // as long as the machine is on.
      stopWeatherScene();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
