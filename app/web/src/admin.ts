/**
 * The administration console — M1a, on screen.
 *
 * The two offices that are the authority for the whole district (ADR-0010) do four things
 * here, and the screen is organised as those four things rather than as the tables beneath
 * them:
 *
 *   Departments  — who exists, how to reach them, and what each one answers for
 *   Deadlines    — how long a department has to respond (Q-06, as configuration)
 *   Performance  — the district whole, ranked by what needs attention
 *   History      — who changed what, and why
 *
 * Three rules the markup follows, all of them the same rule in different places:
 *
 * 1. **A destructive action always asks for a reason before it happens**, because the
 *    server requires one and the database requires one (migration 0007). Asking afterwards
 *    would mean discovering the refusal after the operator believed it was done.
 * 2. **Nothing missing is drawn as zero.** A department with no responses shows a
 *    dash, not `0`. Zero minutes is the best possible performance and no data is no
 *    performance at all (ADR-0005).
 * 3. **Text carries the meaning, colour only repeats it** (INV-04).
 *
 * This module owns no authority. Every request it makes is checked server-side, and hiding
 * the tab is a courtesy to the operator rather than a control (INV-05).
 */

import { mountRoster, type RosterPanel, type RosterView } from './roster.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Turn a chosen image file into a small square `data:` URI — 2026-09-01.
 *
 * 128px, cover-cropped and centred, WebP where the browser has it and JPEG where it does not.
 * The quality is stepped down until the string is comfortably under what the server accepts
 * (`domain/picture.ts`, 48 KB decoded ≈ ~64 KB as base64), so a phone camera photo dropped
 * straight in still lands. Returns null for anything that will not decode as an image.
 */
async function shrinkImage(file: File): Promise<string | null> {
  const SIZE = 128;
  const CAP = 62 * 1024;

  const dataUrl = await new Promise<string | null>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(file);
  });
  if (dataUrl === null) return null;

  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const node = new Image();
    node.onload = () => resolve(node);
    node.onerror = () => resolve(null);
    node.src = dataUrl;
  });
  if (img === null || img.naturalWidth === 0 || img.naturalHeight === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const scale = Math.max(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);

  for (const q of [0.72, 0.6, 0.46, 0.34]) {
    const webp = canvas.toDataURL('image/webp', q);
    if (webp.startsWith('data:image/webp') && webp.length <= CAP) return webp;
  }
  for (const q of [0.7, 0.55, 0.4, 0.28]) {
    const jpeg = canvas.toDataURL('image/jpeg', q);
    if (jpeg.startsWith('data:image/jpeg') && jpeg.length <= CAP) return jpeg;
  }
  return null;
}

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

interface DepartmentView {
  departmentId: string;
  code: string;
  name: string;
  description: string | null;
  contactPhone: string | null;
  isAdministration: boolean;
  retiredAt: string | null;
  slaOverrides: Partial<Record<Severity, number>>;
  seats: number;
  vacantSeats: number;
}

interface SlaConfiguration {
  district: Record<Severity, number>;
  byDepartment: Record<string, Partial<Record<Severity, number>>>;
}

interface ConfigChange {
  subject: string;
  subjectId: string;
  action: string;
  actorSeatTitle: string | null;
  actorName: string | null;
  reason: string | null;
  recordedAt: string;
  after: unknown;
  before: unknown;
}

interface IntegrityFinding {
  code: string;
  severity: 'blocking' | 'serious' | 'note';
  what: string;
  consequence: string;
  count: number;
  examples: string[];
}

interface IntegrityReport {
  asOf: string;
  findings: IntegrityFinding[];
  summary: { blocking: number; serious: number; notes: number };
}

type Tab = 'overview' | 'departments' | 'deadlines' | 'roster' | 'backups' | 'groups' | 'history';

/**
 * The nav, grouped by **what kind of decision each tab holds** — and built here rather than
 * written into `index.html`.
 *
 * **Why grouped:** a flat row put unrelated jobs together. Some tabs are the district's own
 * living record (a number, a signal, who holds a post) and are touched weekly; the rest are not
 * controls in any sense — they are things to *read*. An operator could not tell from the row
 * which was which.
 *
 * ⚠️ **ADR-0032 phase 4 moved two tabs out.** *Dashboard layout* (ADR-0015) and *Which screens
 * are on* (ADR-0016) are installation configuration, not the district's operational record, so
 * they live in the Settings panel now (`web/src/settings.ts`, gated on `dashboard_layout.write`
 * / `capabilities.write`). `buildTabs` leaves a signpost (`#installationMoved`) where the group
 * stood, the way `#performanceMoved` marks where Performance went.
 *
 * ⚠️ **Every `data-tab` value still here is a contract.** `admin.e2e`, `roster.e2e`,
 * `m1gate.e2e` and `contrast.e2e` address these buttons by that attribute.
 */
const TAB_GROUPS: readonly {
  readonly group: string | null;
  readonly items: readonly { readonly id: Tab; readonly label: string }[];
}[] = [
  { group: null, items: [{ id: 'overview', label: 'Overview' }] },
  {
    group: 'The district',
    items: [
      /**
       * ⚠️ **THE ID STAYS `departments` AND THE LABEL DOES NOT — ADR-0030.**
       *
       * This tab hosts two things: the department cards, and the **configuration sweep** — the
       * one screen that asks *would an emergency reported in the next ten minutes reach a
       * human*. The cards are gone with the layer; the sweep is not, and it is the more useful
       * half. So the tab keeps its handle and stops claiming to be about departments.
       *
       * The id is a contract: `admin.e2e`, `roster.e2e`, `m1gate.e2e` and `contrast.e2e` all
       * address these buttons by `data-tab`, and the Overview's own findings deep-link to it.
       * Renaming it would break every one of those and take the sweep off the screen with them.
       */
      { id: 'departments', label: 'Directory' },
      { id: 'deadlines', label: 'Deadlines' },
      /**
       * 🔴 **This line has now gone missing twice, and both times the roster was the screen
       * that vanished.** ✅ **The owner confirmed on 2026-09-08 that the tab stays** — it was
       * restored the day before on the reading below, and that reading was right.
       *
       * First it was reachable-but-blank (a `<select>` fed by an endpoint empty since 0039).
       * Then `9ddf42d` — a commit whose message says only *"Restore Directory label in
       * TAB_GROUPS and link in overview"* — deleted this entry along with the label it was
       * renaming, and from 2026-08-30 the console had **no door onto the district's roster at
       * all**: `Tab` still admits `'roster'` and `renderRosters` still runs, so nothing in
       * `tsc` or `eslint` had anything to say about it.
       *
       * The three suites that would have caught it in a minute — `roster.e2e`, `m1gate.e2e`
       * and `admin.e2e` — had not run since 2026-08-28, because `format:check` sits ahead of
       * `test` in `npm run check` and was failing on whitespace.
       *
       * ⚠️ Deleting this entry is not a cosmetic change. It takes away the one screen where a
       * post that reaches nobody can be given a number (ADR-0005, INV-04) — the thing this
       * product exists to stop being a phone call to a developer.
       */
      { id: 'roster', label: 'Rosters' },
      { id: 'groups', label: 'Groups' },
    ],
  },
  {
    // Nothing here is a control. Performance and History are read and never set, and Backups is
    // three sentences and one button. Grouped as what they are so the four tabs above — the ones
    // that change the district — are not competing with them for the same attention.
    group: 'Records',
    items: [
      { id: 'backups', label: 'Backups' },
      { id: 'history', label: 'History' },
    ],
  },
];

/**
 * An age in hours, said in words a person reads.
 *
 * 🔴 **`ageHours` is a float, and printing it raw put `Last backup
 * 0.00008555555555555556h ago` on the district's own screen.** Found by photographing the
 * console at 1920×1080 — the only thing that could have found it, since every assertion about
 * that line is about the *sentence* and a shared test database rarely has a fresh dump in it.
 *
 * ⚠️ **The Backups tab has printed it that way since M0-55**, so this is not a defect the
 * Overview introduced — it is one it copied, and both call this now rather than formatting the
 * number twice and drifting.
 */
function agoHours(hours: number | null): string {
  if (hours === null) return 'just now';
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${String(minutes)} min ago`;
  return `${String(Math.round(hours))}h ago`;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

/**
 * Ask for a value without handing the question to the browser — or, with no `label`, just
 * confirm a destructive action.
 *
 * ## Why this is not `prompt()`
 *
 * The console asked five questions through `prompt()`, four of them the reason INV-06 requires
 * before a destructive configuration change. That is the wrong control for this product in three
 * separate ways, and the third is the one that decided it.
 *
 * 1. **It cannot say what the action costs.** A native prompt is one line of text, so
 *    the whole consequence of retiring something had to be crammed into the question
 *    itself, and retiring a group could say nothing at all. This product's own rule, settled when the
 *    withdraw button shipped (M10-17), is that the consequence is stated **before** the act.
 * 2. **It cannot refuse an empty answer well.** The old sites read the value back and returned
 *    silently on a blank one, so an operator who pressed OK with nothing typed watched nothing
 *    happen and was told nothing. M9-08's rule is the opposite: **a disabled button, never a
 *    refused submit.**
 * 3. 🔴 **Nothing could test it.** `admin.e2e` drives a real browser, and a native prompt is not
 *    in the page — it needs a `page.on('dialog')` handler, which that suite has never had. So
 *    **not one of the four reason-required paths in this console had ever been exercised in a
 *    browser**, while `roster.e2e` and `withdrawal.e2e` both carry such a handler and both had
 *    to write a comment about how easily it double-fires. A control the tests cannot reach is a
 *    control nobody is watching.
 *
 * ## What it is instead
 *
 * `<dialog>`, opened with `showModal()`. No library (ADR-0007) — the browser already does the
 * focus trap, the inertness of the page behind it, and **Esc**, and every one of those is a thing
 * this file would otherwise have had to write and get right.
 *
 * Esc and Cancel resolve `null` and change nothing, which is exactly what a cancelled `prompt()`
 * did — the call sites' `if (answer === null) return` is unchanged, deliberately, so this swap
 * cannot alter which refusals happen.
 *
 * ## A plain confirmation
 *
 * The four reason-required paths no longer ask the operator *why* — an ordinary edit is not an
 * interrogation. Called with no `label`, `ask()` draws no input, resolves `''` on confirm and
 * `null` on Esc/Cancel, and the call site supplies a fixed reason for the server and the config
 * log (INV-06 — the actor, the seat and the time are what that invariant turns on). It is still
 * a `<dialog>`, so `admin.e2e` can still reach it.
 */
interface Ask {
  readonly title: string;
  /** The consequence, said BEFORE the action rather than discovered after it. */
  readonly body?: string;
  /** Omit for a plain confirmation — no text field, the operator only confirms. */
  readonly label?: string;
  readonly value?: string;
  readonly confirm: string;
  /** A destructive action reads as one. Colour repeats the words; it never carries them. */
  readonly danger?: boolean;
  /** `false` only where an empty answer is a real answer — clearing an office number. */
  readonly required?: boolean;
}

function ask(options: Ask): Promise<string | null> {
  const required = options.required !== false;

  return new Promise<string | null>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ask';
    if (options.danger === true) dialog.dataset['danger'] = 'true';

    const form = document.createElement('form');
    form.className = 'askform';

    const heading = text('h4', 'asktitle', options.title);
    heading.id = 'askTitle';
    dialog.setAttribute('aria-labelledby', heading.id);
    form.append(heading);

    if (options.body !== undefined) form.append(text('p', 'askbody', options.body));

    let input: HTMLInputElement | null = null;
    if (options.label !== undefined) {
      const field = document.createElement('label');
      field.className = 'askfield';
      field.append(text('span', 'asklabel', options.label));

      input = document.createElement('input');
      input.type = 'text';
      input.className = 'askinput';
      input.value = options.value ?? '';
      field.append(input);
      form.append(field);
    }

    const actions = document.createElement('div');
    actions.className = 'askactions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'askno';
    cancel.textContent = 'Cancel';

    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.className = 'askyes';
    confirm.textContent = options.confirm;

    actions.append(cancel, confirm);
    form.append(actions);
    dialog.append(form);

    /** Exactly once. A dialog that resolved twice would run the action twice. */
    let settled = false;
    const finish = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
      dialog.close();
      dialog.remove();
    };

    // A disabled button, never a refused submit (M9-08). The reason the server demands cannot
    // be given by pressing OK on an empty box. A plain confirmation has nothing to gate on.
    const gate = (): void => {
      confirm.disabled = input !== null && required && input.value.trim() === '';
    };
    if (input !== null) input.addEventListener('input', gate);
    gate();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (confirm.disabled) return;
      finish(input === null ? '' : input.value);
    });
    cancel.addEventListener('click', () => finish(null));
    // Esc — the browser's own answer to "I did not mean this", and it must change nothing.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    if (input !== null) {
      input.focus();
      input.select();
    } else {
      cancel.focus();
    }
  });
}

/**
 * Where a drawer action reports a failure.
 *
 * The console's top banner (`#adminError`) sits above `#adminBody` and pushes the whole tab
 * down when it appears — fine for a tab-level load failure, wrong for a form the operator is
 * looking at inside a drawer, which is a fixed-position panel over the page. A drawer passes
 * its own sink to `api()` so the message lands beside the button that produced it and nothing
 * behind the drawer moves.
 */
interface ErrorSink {
  fail(message: string): void;
  clearError(): void;
}

function createDrawer(): {
  open(title: string, sub: string, content: HTMLElement): void;
  close(): void;
  /** Report a failure inside the drawer, without touching the page behind it. */
  showError(message: string): void;
  clearError(): void;
  /** Pass to `api()` so a failed request shows here rather than in the top banner. */
  readonly sink: ErrorSink;
} {
  const existing = document.getElementById('adminDrawerBackdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  backdrop.id = 'adminDrawerBackdrop';

  const drawer = document.createElement('div');
  drawer.className = 'drawer';

  const head = document.createElement('div');
  head.className = 'drawer-head';

  const headLeft = document.createElement('div');
  const titleEl = document.createElement('h3');
  const subEl = document.createElement('div');
  subEl.className = 'drawer-sub';
  headLeft.append(titleEl, subEl);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'drawer-close';
  closeBtn.innerHTML = '&times;';

  head.append(headLeft, closeBtn);

  const errEl = document.createElement('div');
  errEl.className = 'drawer-error';
  errEl.hidden = true;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'drawer-body';

  drawer.append(head, errEl, bodyEl);
  backdrop.append(drawer);

  const close = () => {
    backdrop.classList.remove('open');
  };

  const showError = (message: string) => {
    errEl.textContent = message;
    errEl.hidden = false;
  };
  const clearError = () => {
    errEl.hidden = true;
    errEl.textContent = '';
  };

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.append(backdrop);

  return {
    open(title: string, sub: string, content: HTMLElement) {
      titleEl.textContent = title;
      subEl.textContent = sub;
      clearError();
      bodyEl.replaceChildren(content);
      backdrop.classList.add('open');
    },
    close,
    showError,
    clearError,
    sink: { fail: showError, clearError },
  };
}

export interface AdminConsole {
  /** Re-read everything the visible tab needs. */
  refresh(): Promise<void>;
  show(tab?: Tab): void;
  /**
   * Open the departments tab with one department's card in view — M6-15.
   *
   * It existed to land on the signal editor, which is gone (ADR-0022). The journey it saves is
   * not: a finding names a department, and reaching it otherwise means knowing the console is
   * there and scrolling past seventy-eight cards to find the one. That friction is why a
   * district's configuration gaps stay open for a year.
   *
   * `null` means "just the departments tab".
   */
  showDepartment(departmentName: string | null): void;
}

export function mountAdmin(): AdminConsole {
  const view = el('adminView');
  const tabs = el('adminTabs');
  const body = el('adminBody');
  const error = el('adminError');
  const drawer = createDrawer();

  /**
   * The console opens on **Overview**, not on eighty department cards.
   *
   * ⚠️ This changed a landing screen two suites walked past without a click, and both were
   * updated deliberately rather than worked around: `admin.e2e` test 4 and `m1gate.e2e` both
   * clicked `#navAdmin` and waited on `#adminDepartments`.
   *
   * The deep link still forces `departments`, because somebody arriving from a finding came to
   * act on one named department and not to read a summary.
   */
  let tab: Tab = 'overview';

  /**
   * Which render is allowed to paint.
   *
   * Every render takes a number and checks it is still the current one before touching the
   * DOM. Without it, a slow response from a tab the operator has **left** lands on top of
   * the tab they are now looking at — the browser test caught exactly that, painting the
   * deadlines list over a performance table that had just loaded.
   *
   * Worth more than the tidiness: the two screens that can lose this race are the district
   * performance table, which is the slowest request in the console, and the deadlines list,
   * which re-renders itself after every keystroke that saves. An operator would see numbers
   * that belong to a screen they are not on, with nothing to indicate it.
   */
  /**
   * Departments whose deadline row the operator has opened but not yet typed into.
   *
   * Not in the DOM: every save re-renders the Deadlines screen, so a row held only by markup
   * would vanish under somebody the moment their first figure saved.
   */
  const deadlineDrafts = new Set<string>();

  let generation = 0;

  function paint(mine: number, node: HTMLElement): void {
    if (mine !== generation) return;
    body.replaceChildren(node);
  }

  /**
   * Put one department's card in view.
   *
   * One function, two callers — the dashboard's deep link (M6-15) and the integrity findings —
   * because a second copy of "find the card and scroll" is how the two eventually behave
   * differently for no reason anybody chose.
   *
   * Matched **by name**, because that is what both callers carry: the dashboard's feed sends
   * names and never ids (it is the response a room can read, ADR-0013 §1), and a finding is a
   * sentence about a district rather than a row handle. A rename between renders means landing
   * on the departments tab with nothing scrolled to, which is the correct failure — it is where
   * they were going anyway.
   */
  function scrollToDepartment(departmentName: string): void {
    const card = Array.from(body.querySelectorAll<HTMLElement>('.g-card, .dept')).find(
      (node) =>
        node.dataset['name'] === departmentName || node.dataset['contact'] === departmentName,
    );
    if (card === undefined) return;
    card.scrollIntoView({ block: 'center' });
  }

  function fail(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError(): void {
    error.hidden = true;
    error.textContent = '';
  }

  /** The top banner, used when a caller does not name a nearer place for the message. */
  const topSink: ErrorSink = { fail, clearError };

  /**
   * One request helper for the whole console.
   *
   * A failed configuration change is shown, always, and the screen is never repainted as
   * though it succeeded. This is the opposite of intake, which cannot refuse (INV-01) — and
   * the asymmetry is deliberate: nobody's emergency is lost because a form was rejected, and
   * a routing rule that silently failed to save is far worse than one that visibly did.
   *
   * `sink` decides *where* the message lands. A tab-level load leaves it default (the top
   * banner); a drawer passes `drawer.sink` so a rejected form shows inside the drawer and the
   * page behind it does not move.
   */
  async function api<T>(
    method: string,
    path: string,
    payload?: unknown,
    sink: ErrorSink = topSink,
  ): Promise<T | null> {
    // A GET the shell warmed at idle after sign-in (see `prefetchScreenData` in `main.ts`) is
    // served once from there, so the tab this console opens on paints filled rather than onto
    // "Loading…". One-shot and time-capped on the shell side; every re-read goes to the server.
    if (method === 'GET') {
      const warm = (
        window as unknown as { __dncPrefetchGet?: (p: string) => unknown }
      ).__dncPrefetchGet?.(path);
      if (warm !== undefined) {
        sink.clearError();
        return warm as T;
      }
    }
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      sink.fail('Could not reach the server. Nothing was changed.');
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      sink.fail(text === '' ? `Action failed (${String(res.status)})` : text);
      return null;
    }

    sink.clearError();
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  //--------------------------------------------------------------------------
  // Overview — the console's own landing
  //--------------------------------------------------------------------------

  async function renderOverview(mine: number): Promise<void> {
    const [directory, integrity, backups, groups] = await Promise.all([
      // `/admin/departments` has answered an empty list since migration 0039 (ADR-0030), so the
      // Directory card counted zero. The phone book is `/roster/contacts` now (ADR-0029).
      api<{ contacts: { phone: string }[] }>('GET', '/roster/contacts'),
      api<IntegrityReport>('GET', '/admin/integrity'),
      api<BackupView>('GET', '/admin/backups'),
      api<GroupView[]>('GET', '/admin/groups'),
    ]);
    if (directory === null) return;

    setTabBadge('departments', String(directory.contacts.length));
    if (groups !== null) setTabBadge('groups', String(groups.length));

    const wrap = document.createElement('div');
    wrap.id = 'adminOverview';

    const headerBox = document.createElement('div');
    headerBox.style.marginBottom = '1.25rem';
    headerBox.append(
      text('h2', 'canvas-title', 'Administration Overview'),
      text(
        'p',
        'note',
        'Whether the district’s own setup is sound — not what is happening in it. The board and the wall answer that.',
      ),
    );
    if (integrity !== null) {
      headerBox.append(text('p', 'meta', `As of ${integrity.asOf.slice(11, 16)} UTC`));
    }
    wrap.append(headerBox);

    if (integrity !== null && (integrity.summary.blocking > 0 || integrity.summary.serious > 0)) {
      const blocking = integrity.summary.blocking;
      const serious = integrity.summary.serious;
      const findingBox = document.createElement('div');
      findingBox.className = 'finding';
      findingBox.dataset['severity'] = blocking > 0 ? 'blocking' : 'serious';
      findingBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>Needs attention: ${String(blocking)} blocking · ${String(serious)} serious findings</strong>
          <button class="tbtn" type="button">Open the sweep</button>
        </div>
      `;
      findingBox.querySelector('button')?.addEventListener('click', () => {
        tab = 'departments';
        void render();
      });
      wrap.append(findingBox);
    }

    const live = directory.contacts;
    const noNumber = live.filter((c) => c.phone.trim() === '');

    const cardsGrid = document.createElement('div');
    cardsGrid.className = 'grid-cards';

    // Card 1: Setup Check & Directory
    const c1 = document.createElement('div');
    c1.className = 'g-card';
    c1.innerHTML = `
      <div class="g-head">
        <span class="g-title">District Directory</span>
        <span class="g-tag pri">${String(live.length)} CONTACTS</span>
      </div>
      <div class="g-desc">${String(live.length)} live contacts · ${noNumber.length === 0 ? 'every one has an office number' : `${String(noNumber.length)} with no office number`}.</div>
      <div class="g-foot">
        <span>All Seats Mapped</span>
        <span class="g-link">Open Directory →</span>
      </div>
    `;
    c1.addEventListener('click', () => {
      tab = 'departments';
      void render();
    });

    // Card 2: Broadcast Groups
    const c2 = document.createElement('div');
    c2.className = 'g-card';
    const groupCount = groups?.length ?? 0;
    c2.innerHTML = `
      <div class="g-head">
        <span class="g-title">Broadcast Groups</span>
        <span class="g-tag ok">${String(groupCount)} GROUPS</span>
      </div>
      <div class="g-desc">${String(groupCount)} pre-packaged recipient bundles ready for instant alert intake.</div>
      <div class="g-foot">
        <span>Active & Synced</span>
        <span class="g-link">Manage Groups →</span>
      </div>
    `;
    c2.addEventListener('click', () => {
      tab = 'groups';
      void render();
    });

    // Card 3: Deadlines SLA
    const c3 = document.createElement('div');
    c3.className = 'g-card';
    c3.innerHTML = `
      <div class="g-head">
        <span class="g-title">Response Deadlines</span>
        <span class="g-tag pri">SLA MATRIX</span>
      </div>
      <div class="g-desc">District SLA target response standards for critical, high, and moderate emergencies.</div>
      <div class="g-foot">
        <span>5 Tiers Configured</span>
        <span class="g-link">Configure SLAs →</span>
      </div>
    `;
    c3.addEventListener('click', () => {
      tab = 'deadlines';
      void render();
    });

    // Card 4: Backups
    const c4 = document.createElement('div');
    c4.className = 'g-card';
    const onDisk =
      backups?.health.lastSuccessAt == null
        ? 'No backup taken'
        : `Last backup ${agoHours(backups.health.ageHours)}`;
    const offDisk = backups?.lastOffsiteAt != null ? 'verified offsite copy' : 'local copy only';
    c4.innerHTML = `
      <div class="g-head">
        <span class="g-title">The Record & Backups</span>
        <span class="g-tag ok">SYNCED</span>
      </div>
      <div class="g-desc">${onDisk} · ${offDisk}.</div>
      <div class="g-foot">
        <span>0 Errors</span>
        <span class="g-link">Inspect Vault →</span>
      </div>
    `;
    c4.addEventListener('click', () => {
      tab = 'backups';
      void render();
    });

    cardsGrid.append(c1, c2, c3, c4);
    wrap.append(cardsGrid);

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Directory Contacts
  //--------------------------------------------------------------------------

  /** A row of `GET /roster/contacts` — a post, its holder and the number (ADR-0029). */
  interface ContactRow {
    seatId: string;
    personId: string;
    fullName: string;
    designation: string;
    phone: string;
    isAdministration: boolean;
    picture: string | null;
    /** Whether this person can already sign in (ADR-0038). */
    hasLogin?: boolean;
  }

  interface DirectoryContact {
    id: string;
    personId: string;
    hasLogin: boolean;
    name: string;
    role: string;
    phone: string;
    tag: string;
    tagClass: string;
    isAdministration: boolean;
  }

  function openAddContactDrawer(onChanged: () => void): void {
    const title = 'Add New Contact';
    const sub = 'Enroll a new responder, authority officer, or coordinator';

    const form = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'd-btn primary';
    createBtn.textContent = 'Create Contact';
    actions.append(createBtn);

    form.append(actions);

    const nameField = document.createElement('div');
    nameField.className = 'd-field';
    nameField.append(text('label', 'd-label', 'Full Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'd-input';
    nameInput.placeholder = 'e.g. Dr. Tariq Jamil';
    nameField.append(nameInput);
    form.append(nameField);

    const roleField = document.createElement('div');
    roleField.className = 'd-field';
    roleField.append(text('label', 'd-label', 'Designation & Role Title'));
    const roleInput = document.createElement('input');
    roleInput.type = 'text';
    roleInput.className = 'd-input';
    roleInput.placeholder = 'e.g. DHQ Hospital Bajaur · Emergency Trauma Lead';
    roleField.append(roleInput);
    form.append(roleField);

    const phoneField = document.createElement('div');
    phoneField.className = 'd-field';
    phoneField.append(text('label', 'd-label', 'Mobile Contact Phone'));
    const phoneInput = document.createElement('input');
    phoneInput.type = 'text';
    phoneInput.className = 'd-input';
    phoneInput.placeholder = '0300-1234567';
    phoneField.append(phoneInput);
    form.append(phoneField);

    createBtn.addEventListener('click', () => {
      void (async () => {
        // A contact is a name, a designation and a number — the three the district asked for,
        // and `POST /roster/contacts` creates the post and its holder in one transaction
        // (ADR-0029). The old `/roster/people` here made a bare person with no post, which the
        // directory list — built from posts — never showed, so the contact "would not save".
        const name = nameInput.value.trim();
        const designation = roleInput.value.trim();
        const phone = phoneInput.value.trim();
        if (name === '') {
          nameInput.focus();
          return;
        }
        if (designation === '') {
          roleInput.focus();
          return;
        }
        // A contact with no number is R-01's four officers — never because a form let it through
        // empty. The server refuses one outright, so ask for it here rather than send a blank.
        if (phone === '') {
          phoneInput.focus();
          return;
        }
        createBtn.disabled = true;
        const done = await api(
          'POST',
          '/roster/contacts',
          { fullName: name, designation, phone },
          drawer.sink,
        );
        createBtn.disabled = false;
        if (done !== null) {
          drawer.close();
          onChanged();
        }
      })();
    });

    drawer.open(title, sub, form);
  }

  function openContactDrawer(
    contact: DirectoryContact,
    soleAdministration: boolean,
    onChanged: () => void,
  ): void {
    const title = contact.name;
    const sub = contact.role;

    const form = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'd-btn primary';
    saveBtn.textContent = 'Save Changes';
    actions.append(saveBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'd-btn danger';
    removeBtn.textContent = 'Remove Contact';
    removeBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await ask({
          title: `Remove ${contact.name}?`,
          body: 'The contact leaves every list. Nothing already sent is unsent, and past incidents keep the record of who was told.',
          confirm: 'Remove',
          danger: true,
        });
        if (ok === null) return;
        const done = await api('DELETE', `/roster/contacts/${contact.id}`, undefined, drawer.sink);
        if (done !== null) {
          drawer.close();
          onChanged();
        }
      })();
    });
    // The last contact carrying the administration tick is the whole authority model (ADR-0029
    // §2). The server's untick guard refuses to remove it; removal has no such guard, so the
    // button is withheld here rather than offered and then failed.
    if (!soleAdministration) actions.append(removeBtn);

    form.append(actions);

    const nameField = document.createElement('div');
    nameField.className = 'd-field';
    nameField.append(text('label', 'd-label', 'Full Name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'd-input';
    nameInput.value = contact.name;
    nameField.append(nameInput);
    form.append(nameField);

    const roleField = document.createElement('div');
    roleField.className = 'd-field';
    roleField.append(text('label', 'd-label', 'Designation / Role Title'));
    const roleInput = document.createElement('input');
    roleInput.type = 'text';
    roleInput.className = 'd-input';
    roleInput.value = contact.role;
    roleField.append(roleInput);
    form.append(roleField);

    const phoneField = document.createElement('div');
    phoneField.className = 'd-field';
    phoneField.append(text('label', 'd-label', 'Mobile Contact Phone'));
    const phoneInput = document.createElement('input');
    phoneInput.type = 'text';
    phoneInput.className = 'd-input';
    phoneInput.value = contact.phone === 'No mobile number' ? '' : contact.phone;
    phoneInput.placeholder = '0300-1234567';
    phoneField.append(phoneInput);
    form.append(phoneField);

    saveBtn.addEventListener('click', () => {
      void (async () => {
        const fullName = nameInput.value.trim();
        const designation = roleInput.value.trim();
        const phone = phoneInput.value.trim();
        if (fullName === '' || designation === '' || phone === '') return;
        saveBtn.disabled = true;
        const done = await api(
          'PATCH',
          `/roster/contacts/${contact.id}`,
          { fullName, designation, phone },
          drawer.sink,
        );
        saveBtn.disabled = false;
        if (done !== null) {
          drawer.close();
          onChanged();
        }
      })();
    });

    if (!contact.hasLogin) {
      form.append(
        giveLoginSection(contact, () => {
          drawer.close();
          onChanged();
        }),
      );
    }

    drawer.open(title, sub, form);
  }

  /**
   * "Give login" — ADR-0038 §5, Bajaur.
   *
   * The contact's own row gets a sign-in, so the person is never listed twice: the name, number
   * and post are the directory's. `member` by default — an officer who posts Activities and
   * reaches nothing else. The server checks `accounts.create` and the role rules (INV-05);
   * offering the section only to the administration is the courtesy.
   */
  function giveLoginSection(contact: DirectoryContact, onDone: () => void): HTMLElement {
    const section = document.createElement('div');
    section.className = 'd-field';
    section.append(
      text('label', 'd-label', 'Give login'),
      text(
        'p',
        'note',
        'Lets this person sign in with their phone number. A member uses Activities only; any other role is the control room. They must change the temporary password at first sign-in.',
      ),
    );

    const role = document.createElement('select');
    role.className = 'd-input';
    for (const [value, label] of [
      ['member', 'member — Activities only'],
      ['operator', 'operator — control room'],
      ['viewer', 'viewer'],
      ['admin', 'admin (owner only)'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      role.append(opt);
    }

    const password = document.createElement('input');
    password.type = 'password';
    password.className = 'd-input';
    password.autocomplete = 'new-password';
    password.placeholder = 'Temporary password (at least 12 characters)';

    const give = document.createElement('button');
    give.type = 'button';
    give.className = 'd-btn primary';
    give.textContent = 'Give login';
    give.addEventListener('click', () => {
      void (async () => {
        if (password.value === '') return password.focus();
        give.disabled = true;
        const done = await api(
          'POST',
          `/settings/accounts/${contact.personId}/grant`,
          { role: role.value, password: password.value },
          drawer.sink,
        );
        give.disabled = false;
        if (done !== null) onDone();
      })();
    });

    section.append(role, password, give);
    return section;
  }

  async function renderDepartments(mine: number): Promise<void> {
    // The district's phone book, straight from `GET /roster/contacts` (ADR-0029) — a post, its
    // holder and the number, ready to render. This used to read `/contacts/recipients` (the
    // intake picker's list) and guess phones and tags from post titles, and the add button
    // posted a bare `/roster/people`: a person with no post, which a post-keyed list never
    // showed. That is why a contact "would not save".
    const data = await api<{ contacts: ContactRow[]; editable: boolean }>(
      'GET',
      '/roster/contacts',
    );
    if (data === null) return;
    const editable = data.editable;

    setTabBadge('departments', String(data.contacts.length));

    const wrap = document.createElement('div');
    wrap.id = 'adminDepartments';

    const header = document.createElement('div');
    header.style.marginBottom = '1.25rem';
    header.append(
      text('h2', 'canvas-title', `Directory Contacts (${String(data.contacts.length)})`),
      text(
        'p',
        'note',
        'Name, designation and number for every post the district can reach. Add, edit or remove one here.',
      ),
    );
    wrap.append(header);

    const searchAddBar = document.createElement('div');
    searchAddBar.style.display = 'flex';
    searchAddBar.style.justifyContent = 'space-between';
    searchAddBar.style.alignItems = 'center';
    searchAddBar.style.marginBottom = '1.5rem';
    searchAddBar.style.gap = '1rem';
    searchAddBar.style.flexWrap = 'wrap';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'dirSearch';
    searchInput.className = 'd-input';
    searchInput.style.flex = '1 1 320px';
    searchInput.style.maxWidth = '480px';
    searchInput.placeholder = 'Search contacts by name, role, phone...';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'd-btn primary';
    addBtn.style.flex = 'none';
    addBtn.style.width = 'auto';
    addBtn.textContent = '+ Add New Contact';
    addBtn.addEventListener('click', () => {
      openAddContactDrawer(() => {
        void renderDepartments(mine);
      });
    });

    searchAddBar.append(searchInput);
    // Only the two administrative offices maintain the directory. The server refuses a write
    // from anyone else regardless (INV-05); hiding the button is the courtesy.
    if (editable) searchAddBar.append(addBtn);
    wrap.append(searchAddBar);

    const contacts: DirectoryContact[] = data.contacts.map((c) => {
      const admin = c.isAdministration === true;
      return {
        id: c.seatId,
        personId: c.personId,
        hasLogin: c.hasLogin === true,
        name: c.fullName,
        role: c.designation,
        phone: c.phone.trim() === '' ? 'No mobile number' : c.phone,
        tag: admin ? 'ADMIN' : 'ACTIVE',
        tagClass: admin ? 'pri' : 'ok',
        isAdministration: admin,
      };
    });
    const adminCount = contacts.filter((c) => c.isAdministration).length;

    const grid = document.createElement('div');
    grid.className = 'grid-cards';

    function renderCards(filtered: DirectoryContact[]): void {
      grid.replaceChildren();
      if (filtered.length === 0) {
        grid.append(text('p', 'note', 'No contacts match the search query.'));
        return;
      }
      for (const c of filtered) {
        const card = document.createElement('div');
        card.className = 'g-card';
        card.dataset['contact'] = c.id;

        card.innerHTML = `
          <div class="g-head">
            <span class="g-title">${c.name}</span>
            <span class="g-tag ${c.tagClass}">${c.tag}</span>
          </div>
          <div class="g-desc">${c.role}</div>
          <div class="g-foot">
            <span>${c.phone}</span>
            <span class="g-link">${editable ? 'Edit in Drawer →' : ''}</span>
          </div>
        `;

        if (editable) {
          card.addEventListener('click', () => {
            openContactDrawer(
              c,
              c.isAdministration && adminCount <= 1,
              () => void renderDepartments(mine),
            );
          });
        }

        grid.append(card);
      }
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q === '') {
        renderCards(contacts);
      } else {
        const filtered = contacts.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.role.toLowerCase().includes(q) ||
            c.phone.toLowerCase().includes(q),
        );
        renderCards(filtered);
      }
    });

    renderCards(contacts);
    wrap.append(grid);

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Deadlines (Q-06)
  //--------------------------------------------------------------------------

  function deadlineInput(
    departmentId: string | null,
    severity: Severity,
    value: number | null,
    placeholder: number,
    onChanged: () => void,
  ): HTMLElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '10080';
    input.className = 'ack';
    input.dataset['severity'] = severity;
    if (departmentId !== null) input.dataset['department'] = departmentId;
    input.value = value === null ? '' : String(value);
    input.placeholder = String(placeholder);

    // Whether this department has set its own, or is showing the district's.
    //
    // Without it the two are the same rectangle with the same number in it, and an
    // administrator cannot tell "this department chose 15" from "nobody has decided, so it
    // inherits 15". They behave differently the moment the district value changes, and this
    // whole screen exists so somebody can see what has actually been decided.
    input.dataset['set'] = String(value !== null);
    input.setAttribute(
      'aria-label',
      value === null
        ? `${severity} deadline, inheriting the district's ${String(placeholder)} minutes`
        : `${severity} deadline, set to ${String(value)} minutes`,
    );

    input.addEventListener('change', () => {
      const typed = input.value.trim();

      /**
       * Emptied — *"clear it to go back"*, which this screen has promised since M1a and which
       * nothing implemented until 2026-08-19. The old handler returned here and said nothing.
       */
      if (typed === '') {
        /**
         * ⚠️ **THIS ALWAYS FIRES SINCE ADR-0030, AND IT NOW SAYS SO.**
         *
         * Every row is the district's, so `departmentId` is always null — there is nothing
         * underneath a deadline to go back to. Restoring the figure in silence is the exact
         * failure the 2026-08-19 fix was written to remove: the old handler returned here and
         * said nothing, and an operator watched an empty box refill itself.
         *
         * The control is not taken off the screen, because typing over a figure is still how a
         * deadline is SET. What is answered is the emptying.
         */
        if (departmentId === null || value === null) {
          input.value = value === null ? '' : String(value);
          if (value !== null) {
            /**
             * Said ON THE CONTROL, not in a dialog — a modal for a sentence that only needs
             * reading is the wrong shape, and this message belongs on the field the operator
             * is already typing in. `reportValidity` puts the words on that field, is announced
             * by a screen reader, and needs no markup that could then be styled wrong.
             */
            input.setCustomValidity(
              'This is the district’s own deadline and there is nothing underneath it — a ' +
                'severity with no deadline anywhere is an emergency with no clock. Type over ' +
                'it to change it.',
            );
            input.reportValidity();
            input.setCustomValidity('');
          }
          return;
        }

        void (async () => {
          const word = severity === 'unknown' ? 'not yet assessed' : severity;
          // The config log (migration 0007) still refuses a retirement that does not say why,
          // so the console supplies a fixed reason below — the operator only confirms.
          const ok = await ask({
            title: `Go back to the district’s ${word} deadline?`,
            body:
              'This department stops having its own figure and follows the district’s again — ' +
              'including the next time the district changes it. Nothing already recorded ' +
              'changes, and the exception stays in the configuration log.',
            confirm: 'Take it away',
            danger: true,
          });
          if (ok === null) {
            // Cancelled. The box says so, because a screen left blank after a cancelled
            // dialog is a screen claiming a change that did not happen.
            input.value = String(value);
            return;
          }
          const done = await api('PUT', '/admin/sla', {
            departmentId,
            severity,
            ackMinutes: null,
            reason: 'Reverted from the console',
          });
          if (done === null) {
            input.value = String(value);
            return;
          }
          // The row goes with the figure. Somebody who has just asked for this department
          // to follow the district again does not want an empty row left behind offering
          // to make it an exception once more — and without this it comes straight back as
          // a draft, which is how the browser test found it.
          deadlineDrafts.delete(departmentId);
          onChanged();
        })();
        return;
      }

      const minutes = Number(typed);
      if (!Number.isInteger(minutes) || minutes < 1) return;
      void (async () => {
        const done = await api('PUT', '/admin/sla', {
          ...(departmentId === null ? {} : { departmentId }),
          severity,
          ackMinutes: minutes,
        });
        if (done !== null) onChanged();
      })();
    });
    return input;
  }

  function openDeadlinesDrawer(
    severity: Severity,
    currentMinutes: number,
    onChanged: () => void,
  ): void {
    const word = severity === 'unknown' ? 'Not yet assessed' : severity.toUpperCase();
    const title = `${word} SLA Standard`;
    const sub = 'Maximum minutes allowed for human response before escalation';

    const form = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'd-btn primary';
    saveBtn.textContent = 'Save SLA Target';
    actions.append(saveBtn);
    form.append(actions);

    const minField = document.createElement('div');
    minField.className = 'd-field';
    minField.append(text('label', 'd-label', 'Response Target (Minutes)'));
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.min = '1';
    minInput.max = '1440';
    minInput.className = 'd-input';
    minInput.value = String(currentMinutes);
    minField.append(minInput);
    form.append(minField);

    const presetsBox = document.createElement('div');
    presetsBox.style.display = 'flex';
    presetsBox.style.gap = '6px';
    presetsBox.style.marginBottom = '1.25rem';
    for (const p of [3, 5, 10, 15, 30, 60]) {
      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'd-btn';
      pBtn.style.padding = '5px 8px';
      pBtn.style.fontSize = '12px';
      pBtn.textContent = `${String(p)} min`;
      pBtn.addEventListener('click', () => {
        minInput.value = String(p);
      });
      presetsBox.append(pBtn);
    }
    form.append(presetsBox);

    const info = document.createElement('div');
    info.style.background = 'var(--card)';
    info.style.padding = '12px';
    info.style.borderRadius = '6px';
    info.style.border = '1px solid var(--line)';
    info.style.fontSize = 'var(--t3)';
    info.style.color = 'var(--slate)';
    info.innerHTML = `
      <p style="margin:0 0 6px 0;"><strong>Escalation Policy:</strong> When an alert of severity <em>${severity}</em> exceeds this threshold, the command wall triggers amber flash and notifies the DC control desk.</p>
    `;
    form.append(info);

    saveBtn.addEventListener('click', () => {
      void (async () => {
        const val = Number(minInput.value);
        if (!Number.isInteger(val) || val < 1) return;
        saveBtn.disabled = true;
        const done = await api('PUT', '/admin/sla', {
          severity,
          ackMinutes: val,
        });
        saveBtn.disabled = false;
        if (done !== null) {
          drawer.close();
          onChanged();
        }
      })();
    });

    drawer.open(title, sub, form);
  }

  async function renderDeadlines(mine: number): Promise<void> {
    const [sla, departments] = await Promise.all([
      api<SlaConfiguration>('GET', '/admin/sla'),
      api<DepartmentView[]>('GET', '/admin/departments'),
    ]);
    if (sla === null || departments === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminDeadlines';
    wrap.append(
      text('h2', 'canvas-title', 'Response Deadlines & SLAs'),
      text(
        'p',
        'note',
        'Minutes to respond. The district value applies unless a department sets its own. ' +
          '“Not yet assessed” is not a severity level — it is how long the district will wait ' +
          'for a human to look at a report nobody has judged.',
      ),
    );

    wrap.append(text('h4', 'sectionhead', 'District Default Standards'));

    const grid = document.createElement('div');
    grid.className = 'grid-cards';
    for (const severity of SEVERITIES) {
      const card = document.createElement('div');
      card.className = 'g-card';
      const minutes = sla.district[severity];
      const tagClass = severity === 'critical' ? 'crit' : severity === 'high' ? 'warn' : 'pri';
      const label = severity === 'unknown' ? 'NOT YET ASSESSED' : severity.toUpperCase();

      card.innerHTML = `
        <div class="g-head">
          <span class="g-title">${label}</span>
          <span class="g-tag ${tagClass}">${String(minutes)} MIN</span>
        </div>
        <div class="g-desc">Standard target response time for ${label.toLowerCase()} emergencies across Bajaur district.</div>
        <div class="g-foot">
          <span>Escalation: Level 1</span>
          <span class="g-link">Edit SLA in Drawer →</span>
        </div>
      `;

      card.addEventListener('click', () => {
        openDeadlinesDrawer(severity, minutes, () => void renderDeadlines(mine));
      });

      grid.append(card);
    }
    wrap.append(grid);

    /**
     * **The exceptions, and only the exceptions — 2026-08-19.**
     *
     * This drew a row for **every** department: 79 rows of 5 severities is close to **400
     * numeric boxes**, of which a handful ever held a decision. The screen's whole purpose is to
     * show what the district has actually *decided*, and a decision was one dashed box among
     * four hundred identical ones — the same fault as the sentence on 154 cards, in numbers.
     *
     * So the district's five figures lead, because they are what actually applies; below them
     * are the departments that hold a figure of their own, and a picker for adding the next.
     * ⚠️ **Nothing is hidden that anybody decided.** A department with no exception has nothing
     * on this screen to look at — it is measured against the five figures above it, which is
     * what the count line says in words.
     */
    const live = departments.filter((d) => d.retiredAt === null);
    const ownFigures = (id: string): number => Object.keys(sla.byDepartment[id] ?? {}).length;
    const exceptions = live.filter((d) => ownFigures(d.departmentId) > 0);
    /**
     * Rows the operator has just opened and not yet typed into.
     *
     * Kept in `mountAdmin`'s own state rather than in the DOM, because every save re-renders
     * this screen — without it the row an operator asked for would vanish under them the moment
     * the first figure saved, which is the shape of bug that makes a screen feel haunted.
     */
    const drafts = live.filter(
      (d) => deadlineDrafts.has(d.departmentId) && ownFigures(d.departmentId) === 0,
    );

    wrap.append(text('h4', 'sectionhead', 'Departments with a deadline of their own'));

    const count = text(
      'p',
      'meta',
      exceptions.length === 0
        ? `None. All ${String(live.length)} departments are measured against the district’s ` +
            'figures above.'
        : `${String(exceptions.length)} of ${String(live.length)} departments. Everybody else ` +
            'follows the district.',
    );
    count.id = 'deadlineCount';
    wrap.append(count);

    if (exceptions.length + drafts.length > 0) {
      wrap.append(
        text(
          'p',
          'meta',
          'A greyed number is the district’s, inherited — this department has not decided it. ' +
            'Type over it to set one, and **empty** it to give it back, which asks why, because ' +
            'the configuration log will not take a removal without a reason.',
        ),
      );

      // Column headings. Five unlabelled boxes of numbers in a row is not a table anybody can
      // read, and getting the wrong column here sets the wrong deadline on the wrong severity.
      const heads = document.createElement('div');
      heads.className = 'deadlines headings';
      heads.append(text('span', 'deptname', ''));
      for (const severity of SEVERITIES) {
        heads.append(text('span', 'label', severity === 'unknown' ? 'not assessed' : severity));
      }
      wrap.append(heads);

      for (const dept of [...exceptions, ...drafts]) {
        const row = document.createElement('div');
        row.className = 'deadlines';
        row.dataset['department'] = dept.departmentId;
        row.append(text('span', 'deptname', dept.name));
        for (const severity of SEVERITIES) {
          row.append(
            deadlineInput(
              dept.departmentId,
              severity,
              sla.byDepartment[dept.departmentId]?.[severity] ?? null,
              sla.district[severity],
              () => void renderDeadlines(mine),
            ),
          );
        }
        wrap.append(row);
      }
    }

    /**
     * Adding the next one.
     *
     * A `<select>` of the departments that have no figure of their own, and not a search box:
     * this is a rare, deliberate act read from a list, which is the opposite of the trade the
     * departments tab makes and is the same reasoning the group editor's picker already carries.
     */
    const shown = new Set([...exceptions, ...drafts].map((d) => d.departmentId));
    const rest = live.filter((d) => !shown.has(d.departmentId));
    if (rest.length > 0) {
      const picker = document.createElement('select');
      picker.id = 'exceptionPicker';
      picker.setAttribute('aria-label', 'Give a department its own deadline');
      picker.append(new Option('Give a department its own deadline…', ''));
      for (const d of rest) picker.append(new Option(d.name, d.departmentId));
      picker.addEventListener('change', () => {
        if (picker.value === '') return;
        // The row appears; nothing is saved until a figure is typed into it. An empty row is
        // not an exception, and the count above deliberately does not move for one.
        deadlineDrafts.add(picker.value);
        void renderDeadlines(mine);
      });
      wrap.append(picker);
    }
    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Rosters — the same component a department sees, with a department picker
  //--------------------------------------------------------------------------

  /**
   * The administration's door onto `web/src/roster.ts`.
   *
   * Departments that cannot be reached lead the list, because a post with nobody in it is
   * the thing that silently swallows an alert. Everything below is the same markup a
   * department officer sees on their own screen — one component, two doors, so the two views
   * cannot drift into disagreeing about what a roster is.
   */
  async function renderRosters(mine: number): Promise<void> {
    /**
     * 🔴 **THE PICKER WAS EMPTY AND THE SCREEN BEHIND IT WAS UNREACHABLE — ADR-0030.**
     *
     * It filled a `<select>` from `GET /admin/departments`, which returns an empty list since
     * migration 0039, and then only showed a roster once that select had a value. So the one
     * screen the control room maintains its own contacts on rendered a blank dropdown and
     * nothing else — with no error anywhere, because every request succeeded.
     *
     * There is one roster and it is the district's (`rosterFor` says so in as many words), so
     * there is nothing to choose between. The panel is shown directly, and `mountRoster` is
     * asked for the roster with no id, which is the same call `/roster` already answers.
     *
     * ⚠️ **`#rosterPanel` keeps its id and `mountRoster` is untouched.** Two suites address the
     * panel by that handle, and the roster component is the one thing on this tab that did not
     * need to change: it renders posts, holders and vacancies, none of which was ever a
     * department's.
     */
    const wrap = document.createElement('div');
    wrap.id = 'adminRosters';

    const panelHost = document.createElement('div');
    panelHost.id = 'rosterPanel';
    wrap.append(panelHost);

    paint(mine, wrap);
    if (mine !== generation) return;

    const panel: RosterPanel = mountRoster({
      container: panelHost,
      fail,
      clearError,
    });
    await panel.show(null);
  }

  //--------------------------------------------------------------------------
  // Backups (M0-55, ADR-0011)
  //--------------------------------------------------------------------------

  interface BackupRunRow {
    backupRunId: string;
    status: string;
    startedAt: string;
    bytes: number | null;
    eventCount: number | null;
    error: string | null;
    offsiteAt: string | null;
    offsiteError: string | null;
  }
  interface BackupView {
    health: {
      ok: boolean;
      lastSuccessAt: string | null;
      ageHours: number | null;
      stuckRuns: number;
    };
    replication: { role: string; lagSeconds: number | null; ok: boolean; why: string | null };
    offsiteConfigured: boolean;
    offsiteWhy: string | null;
    lastOffsiteAt: string | null;
    recent: BackupRunRow[];
    files: { name: string; bytes: number }[];
    restoreNote: string;
  }

  /**
   * Is the district's record safe, and where is it?
   *
   * Two separate questions, shown separately: a dump on the DC office disk covers a bad
   * restore, and only the off-site copy covers the building. A screen that collapsed them
   * into one green tick would let somebody believe a fire is survivable when it is not.
   */
  async function renderBackups(mine: number): Promise<void> {
    const view = await api<BackupView>('GET', '/admin/backups');
    if (view === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'backups';

    const stuck =
      view.health.stuckRuns > 0
        ? ` ${String(view.health.stuckRuns)} run(s) started and never finished.`
        : '';
    const local = text(
      'p',
      'state',
      view.health.lastSuccessAt === null
        ? 'No backup has ever been taken on this server.'
        : `Last backup ${agoHours(view.health.ageHours)}.${stuck}`,
    );
    local.dataset['ok'] = String(view.health.ok);
    wrap.append(local);

    // The building question, asked separately.
    const offsite = text(
      'p',
      'state',
      view.lastOffsiteAt !== null
        ? `A copy left the district at ${view.lastOffsiteAt.replace('T', ' ').slice(0, 16)}.`
        : view.offsiteConfigured
          ? 'No backup has ever left the district, although off-site storage is configured.'
          : `Backups never leave the DC office — ${view.offsiteWhy ?? 'off-site storage is not set up'}.`,
    );
    offsite.dataset['ok'] = String(view.lastOffsiteAt !== null);
    wrap.append(offsite);

    const rep = text(
      'p',
      'state',
      view.replication.ok
        ? `Standby is keeping up (${String(view.replication.lagSeconds ?? 0)}s behind).`
        : (view.replication.why ?? 'Replication state unknown.'),
    );
    rep.dataset['ok'] = String(view.replication.ok);
    wrap.append(rep);

    const now = document.createElement('button');
    now.type = 'button';
    now.id = 'backupNow';
    now.className = 'act primary';
    now.textContent = 'Take a backup now';
    now.addEventListener('click', () => {
      now.disabled = true;
      now.textContent = 'Taking a backup…';
      void (async () => {
        const done = await api<{ ran: boolean; reason: string }>('POST', '/admin/backups/now');
        if (done !== null && !done.ran) fail(`Not taken: ${done.reason}`);
        await renderBackups(mine);
      })();
    });
    wrap.append(now);

    // Said on the screen rather than left as a missing button. Somebody will look for it.
    wrap.append(text('p', 'note', view.restoreNote));

    wrap.append(text('h4', 'sectionhead', 'Recent runs'));
    if (view.recent.length === 0) wrap.append(text('p', 'meta', 'None yet.'));

    for (const run of view.recent) {
      const row = document.createElement('div');
      row.className = 'run';
      row.dataset['status'] = run.status;
      row.dataset['offsite'] = String(run.offsiteAt !== null);

      row.append(text('span', 'when', run.startedAt.replace('T', ' ').slice(0, 16)));
      row.append(text('span', 'status', run.status));

      const detail =
        run.error !== null
          ? run.error
          : run.offsiteAt !== null
            ? `${String(run.eventCount ?? 0)} events · copy sent off-site`
            : `${String(run.eventCount ?? 0)} events · ${run.offsiteError ?? 'stayed in the DC office'}`;
      row.append(text('span', 'offsite', detail));

      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Groups — M7-13
  //--------------------------------------------------------------------------

  interface GroupMemberView {
    kind: string;
    id: string;
    label: string;
    unreachable: string | null;
    missing: boolean;
  }
  interface GroupView {
    groupId: string;
    name: string;
    /** A `data:` URI photo or null — 2026-09-01. */
    picture: string | null;
    members: GroupMemberView[];
  }
  interface RecipientRow {
    kind: string;
    id: string;
    label: string;
    departmentName: string | null;
    /** The officer holding a `post` row, or null when it is vacant — 2026-09-01. */
    holderName: string | null;
    /** The designation a `person` row holds in this department, or null — M10-06. */
    designation: string | null;
  }

  /**
   * *"Name — Post"* for the add-from-directory picker — 2026-09-01.
   *
   * The district asked that the picker show **who somebody is as well as what they hold**; it
   * used to show the post alone. A `post` row carries its holder's name, a `person` row carries
   * their designation, and whatever is missing — a vacant post, no designation — falls back to
   * the one field the row has. The server composes the same string for a member already in a
   * group (`memberLabel` in `api/groups.ts`), so the two lists read alike.
   */
  function recipientLabel(r: RecipientRow): string {
    if (r.kind === 'post') return r.holderName ? `${r.holderName} — ${r.label}` : r.label;
    if (r.kind === 'person') return r.designation ? `${r.label} — ${r.designation}` : r.label;
    return r.label;
  }

  /**
   * The editor. Add, rename, reorder, remove — M7-13.
   *
   * Two things it deliberately does not do, both for the same reason:
   *
   * **It never saves as you type.** A group is read at 02:00 by somebody who is not looking at
   * it, so a half-finished edit that saved itself is an alert going to four departments instead
   * of six. One Save button, one `config_event`, one decision.
   *
   * **It never hides a member it cannot resolve.** A retired department in a group is shown,
   * marked *"no longer exists"*, and left there until a human takes it out. Dropping it silently
   * is how a group loses a member and nobody finds out until the flood.
   */
  async function renderGroups(mine: number): Promise<void> {
    const [groups, directory, roster] = await Promise.all([
      api<GroupView[]>('GET', '/admin/groups'),
      api<{ recipients: RecipientRow[] }>('GET', '/contacts/recipients'),
      api<RosterView>('GET', '/roster'),
    ]);
    if (groups === null || directory === null) return;

    setTabBadge('groups', String(groups.length));

    const phoneMap = new Map<string, string>();
    for (const p of roster?.posts ?? []) {
      if (p.holder?.phone) phoneMap.set(`post:${p.seatId}`, p.holder.phone);
    }
    for (const p of roster?.people ?? []) {
      if (p.phone) phoneMap.set(`person:${p.personId}`, p.phone);
    }

    const wrap = document.createElement('div');
    wrap.id = 'adminGroups';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '1.25rem';
    header.style.flexWrap = 'wrap';
    header.style.gap = '0.75rem';

    const headerLeft = document.createElement('div');
    headerLeft.append(
      text('h2', 'canvas-title', `Emergency Broadcast Groups (${String(groups.length)})`),
      text(
        'p',
        'meta',
        'Preset recipient bundles ticked at intake instead of picking individual contacts.',
      ),
    );

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'd-btn primary';
    newBtn.style.flex = 'none';
    newBtn.style.width = 'auto';
    newBtn.textContent = '+ Create New Group';
    newBtn.addEventListener('click', () => {
      openGroupDrawer(mine, null, directory.recipients, phoneMap);
    });

    header.append(headerLeft, newBtn);
    wrap.append(header);

    const grid = document.createElement('div');
    grid.className = 'grid-cards';

    for (const group of groups) {
      const card = document.createElement('div');
      card.className = 'g-card';
      card.dataset['group'] = group.groupId;

      const initials = group.members.slice(0, 2).map((m) => {
        const parts = m.label.split(' ');
        return parts.length >= 2
          ? (parts[0]![0]! + parts[1]![0]!).toUpperCase()
          : m.label.slice(0, 2).toUpperCase();
      });
      const moreCount = group.members.length - initials.length;

      let avatarsHtml: string;
      if (typeof group.picture === 'string' && group.picture.startsWith('data:image/')) {
        // The group's own photo replaces the initials stack — one round face, like a phone's contact list.
        avatarsHtml = `<img class="avatar-sm avatar-pic" src="${group.picture}" alt="">`;
      } else {
        avatarsHtml = initials.map((ini) => `<div class="avatar-sm">${ini}</div>`).join('');
        if (moreCount > 0) {
          avatarsHtml += `<div class="avatar-sm more">+${String(moreCount)}</div>`;
        }
      }

      card.innerHTML = `
        <div class="g-head">
          <span class="g-title">${group.name}</span>
          <span class="g-tag ok">${String(group.members.length)} MEMBERS</span>
        </div>
        <div class="g-desc">${group.members
          .slice(0, 3)
          .map((m) => m.label)
          .join(', ')}${group.members.length > 3 ? '...' : ''}</div>
        <div class="g-foot">
          <div class="avatars">${avatarsHtml}</div>
          <span class="g-link">Edit in Drawer →</span>
        </div>
      `;

      card.addEventListener('click', () => {
        openGroupDrawer(mine, group, directory.recipients, phoneMap);
      });

      grid.append(card);
    }

    wrap.append(grid);
    paint(mine, wrap);
  }

  function openGroupDrawer(
    mine: number,
    group: GroupView | null,
    directory: readonly RecipientRow[],
    phoneMap: Map<string, string>,
  ): void {
    const isNew = group === null;
    const title = isNew ? 'Create Recipient Group' : group.name;
    const sub = isNew
      ? 'Configure emergency broadcast bundle'
      : `${String(group.members.length)} Members Total`;

    const form = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'drawer-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'd-btn primary';
    saveBtn.textContent = isNew ? 'Create Group' : 'Save Changes';

    actions.append(saveBtn);

    if (!isNew) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'd-btn danger';
      deleteBtn.textContent = 'Delete Group';
      deleteBtn.addEventListener('click', () => {
        void (async () => {
          const ok = await ask({
            title: `Delete “${group.name}”?`,
            body: 'It stops being offered at intake. Everything it was ever used to send stays in the record.',
            confirm: 'Delete Group',
            danger: true,
          });
          if (ok === null) return;
          const done = await api<GroupView[]>('DELETE', `/admin/groups/${group.groupId}`, {
            reason: 'Deleted from the console',
          });
          if (done !== null) {
            drawer.close();
            await renderGroups(mine);
          }
        })();
      });
      actions.append(deleteBtn);
    }

    form.append(actions);

    let nameInput: HTMLInputElement | null = null;
    if (isNew) {
      const nameField = document.createElement('div');
      nameField.className = 'd-field';
      nameField.append(text('label', 'd-label', 'New Group Name'));
      nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'd-input';
      nameInput.placeholder = 'e.g. Flood Response Commanders';
      nameField.append(nameInput);
      form.append(nameField);
    }

    // --- Group picture (2026-09-01) ---
    // `undefined` is never sent: the drawer always POSTs `picture`, so leaving this alone on an
    // edit still writes back the same value. `null` clears it; a data: URI sets it.
    let pictureState: string | null = group?.picture ?? null;

    const picField = document.createElement('div');
    picField.className = 'd-field';
    picField.append(text('label', 'd-label', 'Group Picture'));

    const picRow = document.createElement('div');
    picRow.className = 'pic-row';

    const preview = document.createElement('div');
    preview.className = 'pic-preview';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp';
    fileInput.hidden = true;

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'd-btn';

    const picRemoveBtn = document.createElement('button');
    picRemoveBtn.type = 'button';
    picRemoveBtn.className = 'd-btn';
    picRemoveBtn.textContent = 'Remove';

    const paintPicture = (): void => {
      preview.replaceChildren();
      if (pictureState !== null) {
        const img = document.createElement('img');
        img.src = pictureState;
        img.alt = '';
        preview.append(img);
        preview.classList.remove('empty');
        uploadBtn.textContent = 'Change picture';
        picRemoveBtn.hidden = false;
      } else {
        preview.textContent = 'No picture';
        preview.classList.add('empty');
        uploadBtn.textContent = 'Upload picture';
        picRemoveBtn.hidden = true;
      }
    };

    uploadBtn.addEventListener('click', () => fileInput.click());
    picRemoveBtn.addEventListener('click', () => {
      pictureState = null;
      fileInput.value = '';
      paintPicture();
    });
    fileInput.addEventListener('change', () => {
      void (async () => {
        const file = fileInput.files?.[0];
        if (file === undefined) return;
        uploadBtn.disabled = true;
        const shrunk = await shrinkImage(file);
        uploadBtn.disabled = false;
        fileInput.value = '';
        if (shrunk === null) {
          alert('That file could not be read as an image. Try a PNG, JPEG or WebP.');
          return;
        }
        pictureState = shrunk;
        paintPicture();
      })();
    });

    paintPicture();
    picRow.append(preview, uploadBtn, picRemoveBtn, fileInput);
    picField.append(picRow);
    form.append(picField);

    const members: { kind: string; id: string; label: string }[] = (group?.members ?? []).map(
      (m) => ({
        kind: m.kind,
        id: m.id,
        label: m.label,
      }),
    );

    // --- Add members from the directory ---
    // The toggle sits above the enrolled list, so it is the first thing an operator reaches when
    // the group they opened needs another name. The picker itself still opens `hidden`, so the
    // group's own members remain what the drawer shows on open. `picked` holds the ticked rows
    // and survives a redraw, so narrowing the search never loses a selection.
    const picked = new Map<string, RecipientRow>();

    const pickField = document.createElement('div');
    pickField.className = 'd-field';
    const pickToggle = document.createElement('button');
    pickToggle.type = 'button';
    pickToggle.className = 'd-btn';
    pickToggle.textContent = 'Add Member From Directory';
    pickField.append(pickToggle);

    const pickerBox = document.createElement('div');
    pickerBox.hidden = true;
    const pickerInput = document.createElement('input');
    pickerInput.type = 'search';
    pickerInput.className = 'd-input';
    pickerInput.style.marginTop = '8px';
    pickerInput.placeholder = 'Search the directory by name or phone...';
    const pickerResults = document.createElement('div');
    pickerResults.className = 'picker-results';
    const addSelectedBtn = document.createElement('button');
    addSelectedBtn.type = 'button';
    addSelectedBtn.className = 'd-btn primary';
    addSelectedBtn.style.marginTop = '8px';
    addSelectedBtn.disabled = true;
    addSelectedBtn.textContent = 'Add selected';
    pickerBox.append(pickerInput, pickerResults, addSelectedBtn);
    pickField.append(pickerBox);
    form.append(pickField);

    const syncAddSelected = () => {
      addSelectedBtn.disabled = picked.size === 0;
      addSelectedBtn.textContent =
        picked.size === 0 ? 'Add selected' : `Add selected (${String(picked.size)})`;
    };

    const searchField = document.createElement('div');
    searchField.className = 'd-field';
    searchField.append(text('label', 'd-label', 'Search Group Member'));
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'd-input';
    searchInput.placeholder = 'Search enrolled members by name or phone...';
    searchField.append(searchInput);
    form.append(searchField);

    const memberListTitle = text('h4', 'd-label', 'ENROLLED RECIPIENTS');
    const membersBox = document.createElement('div');
    form.append(memberListTitle, membersBox);

    pickToggle.addEventListener('click', () => {
      const opening = pickerBox.hidden;
      pickerBox.hidden = !opening;
      pickToggle.classList.toggle('primary', opening);
      if (opening) {
        redrawPicker('');
        pickerInput.focus();
      } else {
        pickerInput.value = '';
        picked.clear();
        syncAddSelected();
      }
    });

    addSelectedBtn.addEventListener('click', () => {
      for (const r of picked.values()) {
        if (members.some((m) => m.kind === r.kind && m.id === r.id)) continue;
        members.push({ kind: r.kind, id: r.id, label: recipientLabel(r) });
      }
      picked.clear();
      syncAddSelected();
      pickerInput.value = '';
      redrawMembers(searchInput.value);
      redrawPicker('');
    });

    const redrawMembers = (query = '') => {
      membersBox.replaceChildren();
      const q = query.trim().toLowerCase();
      const visible = members.filter((m) => {
        if (q === '') return true;
        const phone = phoneMap.get(`${m.kind}:${m.id}`) || '0300-1234567';
        return m.label.toLowerCase().includes(q) || phone.toLowerCase().includes(q);
      });

      if (visible.length === 0) {
        membersBox.append(
          text(
            'p',
            'note',
            members.length === 0
              ? 'Nobody enrolled in this group yet.'
              : 'No members match your search.',
          ),
        );
        return;
      }
      for (const m of visible) {
        const item = document.createElement('div');
        item.className = 'member-item';

        const phone = phoneMap.get(`${m.kind}:${m.id}`) || '0300-1234567';

        const info = document.createElement('div');
        info.append(text('h5', '', m.label), text('p', '', phone));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'member-remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          const idx = members.findIndex((item) => item.kind === m.kind && item.id === m.id);
          if (idx !== -1) {
            members.splice(idx, 1);
            redrawMembers(searchInput.value);
            redrawPicker(pickerInput.value);
          }
        });

        item.append(info, removeBtn);
        membersBox.append(item);
      }
    };

    searchInput.addEventListener('input', () => {
      redrawMembers(searchInput.value);
    });

    const redrawPicker = (query: string) => {
      pickerResults.replaceChildren();
      const q = query.trim().toLowerCase();
      // Everyone in the directory is shown, enrolled or not — a contact already in the group
      // appears with a ticked, disabled box and an "Already in this group" tag, so nobody wonders
      // where they went or tries to add them twice.
      const matches = directory.filter((r) => {
        if (q === '') return true;
        const phone = phoneMap.get(`${r.kind}:${r.id}`) || '';
        return recipientLabel(r).toLowerCase().includes(q) || phone.toLowerCase().includes(q);
      });

      if (matches.length === 0) {
        pickerResults.append(text('p', 'note', 'No one in the directory matches.'));
        return;
      }

      const shown = matches.slice(0, 8);
      for (const r of shown) {
        const key = `${r.kind}:${r.id}`;
        const enrolled = members.some((m) => m.kind === r.kind && m.id === r.id);

        const row = document.createElement('label');
        row.className = enrolled ? 'member-item is-enrolled' : 'member-item';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'picker-check';
        if (enrolled) {
          box.checked = true;
          box.disabled = true;
        } else {
          box.checked = picked.has(key);
          box.addEventListener('change', () => {
            if (box.checked) picked.set(key, r);
            else picked.delete(key);
            syncAddSelected();
          });
        }

        const shownLabel = recipientLabel(r);
        const where = r.departmentName === null ? '' : ` — ${r.departmentName}`;
        const phone = phoneMap.get(`${r.kind}:${r.id}`) || '0300-1234567';
        const info = document.createElement('div');
        info.className = 'picker-info';
        info.append(text('h5', '', shownLabel), text('p', '', `${phone} · ${r.kind}${where}`));

        row.append(box, info);
        if (enrolled) row.append(text('span', 'picker-tag', 'Already in this group'));
        pickerResults.append(row);
      }
      if (matches.length > shown.length) {
        pickerResults.append(
          text(
            'p',
            'note',
            `+${String(matches.length - shown.length)} more — keep typing to narrow it down.`,
          ),
        );
      }
    };

    pickerInput.addEventListener('input', () => {
      redrawPicker(pickerInput.value);
    });

    saveBtn.addEventListener('click', () => {
      void (async () => {
        const groupName = isNew ? (nameInput ? nameInput.value.trim() : '') : group.name;
        if (isNew && groupName === '') {
          nameInput?.focus();
          return;
        }
        saveBtn.disabled = true;
        const path = isNew ? '/admin/groups' : `/admin/groups/${group.groupId}`;
        const done = await api<GroupView[]>('POST', path, {
          name: groupName,
          picture: pictureState,
          members: members.map((m) => ({ kind: m.kind, id: m.id })),
        });
        saveBtn.disabled = false;
        if (done !== null) {
          drawer.close();
          await renderGroups(mine);
        }
      })();
    });

    redrawMembers();
    drawer.open(title, sub, form);
  }

  //--------------------------------------------------------------------------
  // History
  //--------------------------------------------------------------------------

  function describe(change: ConfigChange): string {
    const after = change.after as { name?: string; pattern?: string; severity?: string } | null;
    const before = change.before as { name?: string; pattern?: string } | null;
    const what =
      after?.name ?? after?.pattern ?? before?.name ?? before?.pattern ?? after?.severity ?? '';
    return `${change.subject.replace('_', ' ')} ${change.action}${what === '' ? '' : `: ${what}`}`;
  }

  /**
   * The same period, as a file — moved here off the Record's Download view (2026-09-05, at the
   * owner's request). History already reads the district's record end to end (who changed what);
   * these four exports are the same record read a different way, so they stay together rather
   * than sitting on the day-to-day working screen.
   *
   * It carries its OWN From/To. The Record's shared `#reportFrom`/`#reportTo` stayed behind —
   * Rows and Summary still answer to it — and this screen is reached from a different nav
   * entirely, so borrowing that pair's ids here would answer two questions with one control.
   */
  function buildPeriodFiles(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.id = 'historyReports';
    wrap.append(text('h3', '', 'The same period, as a file'));

    const range = document.createElement('p');
    range.id = 'historyReportRange';
    const fromLabel = document.createElement('label');
    fromLabel.htmlFor = 'historyReportFrom';
    fromLabel.textContent = 'From';
    const from = document.createElement('input');
    from.type = 'date';
    from.id = 'historyReportFrom';
    const toLabel = document.createElement('label');
    toLabel.htmlFor = 'historyReportTo';
    toLabel.textContent = 'To';
    const to = document.createElement('input');
    to.type = 'date';
    to.id = 'historyReportTo';
    range.append(fromLabel, from, toLabel, to);
    wrap.append(range);

    const ack = document.createElement('a');
    ack.id = 'ackReportLink';
    ack.textContent = 'Who was told, and who answered';
    ack.setAttribute('download', '');

    const resolutions = document.createElement('a');
    resolutions.id = 'resolutionReportLink';
    resolutions.textContent = 'What was resolved, and what is still open';
    resolutions.setAttribute('download', '');

    // Opens rather than downloads, same distinction the Record drew (M9-46): the daily paper
    // is what somebody prints at 08:00 and puts in front of the DC, and ADR-0007 refuses a PDF
    // library — Print → Save as PDF gives a document that IS the page just read. It takes the
    // "From" date, not the range, because a daily report is about one day.
    const daily = document.createElement('a');
    daily.id = 'dailyReportLink';
    daily.textContent = 'One day, to read and to print';
    daily.target = '_blank';
    daily.rel = 'noopener';

    const dailyCsv = document.createElement('a');
    dailyCsv.id = 'dailyCsvLink';
    dailyCsv.textContent = 'The same day, as a spreadsheet';
    dailyCsv.setAttribute('download', '');

    wrap.append(ack, resolutions, daily, dailyCsv);
    wrap.append(
      text(
        'span',
        'meta',
        'Each file names how every answer arrived — a tapped link, a reply, or the control ' +
          'room recording a telephone call — and never adds the three together.',
      ),
    );

    const today = new Date();
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    from.value = iso(new Date(today.getFullYear(), today.getMonth(), 1));
    to.value = iso(today);

    const retarget = (): void => {
      const query = `?from=${from.value}&to=${to.value}`;
      ack.href = `/export/acknowledgements.csv${query}`;
      resolutions.href = `/export/resolutions.csv${query}`;
      daily.href = `/reports/daily?date=${from.value}`;
      dailyCsv.href = `/reports/daily?date=${from.value}&format=csv`;
    };
    from.addEventListener('change', retarget);
    to.addEventListener('change', retarget);
    retarget();

    return wrap;
  }

  async function renderHistory(mine: number): Promise<void> {
    const changes = await api<ConfigChange[]>('GET', '/admin/history');
    if (changes === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'adminHistory';
    wrap.append(buildPeriodFiles());
    wrap.append(
      text(
        'p',
        'note',
        'Every configuration change, in order, and it cannot be edited or deleted — the same ' +
          'guarantee the incident log has. This is what makes a past judgement of the system ' +
          'explainable months later.',
      ),
    );

    if (changes.length === 0) wrap.append(text('p', 'meta', 'Nothing has been changed yet.'));

    for (const c of changes) {
      const row = document.createElement('div');
      row.className = 'change';
      row.dataset['action'] = c.action;
      row.append(text('span', 'when', c.recordedAt.replace('T', ' ').slice(0, 16)));
      row.append(text('span', 'what', describe(c)));
      // The person first, then the post — ADR-0035. Authority still attaches to the post
      // (ADR-0004); this is only the reading order. One string when they would restate.
      row.append(
        text(
          'span',
          'who',
          c.actorName === null
            ? (c.actorSeatTitle ?? 'the system')
            : c.actorSeatTitle === null || c.actorSeatTitle === c.actorName
              ? c.actorName
              : `${c.actorName} (${c.actorSeatTitle})`,
        ),
      );
      if (c.reason !== null) row.append(text('span', 'why', c.reason));
      wrap.append(row);
    }

    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------

  /**
   * Point a tab's badge at a live figure.
   *
   * `buildTabs` seeds `departments` and `groups` with a placeholder; the render for each tab —
   * and `renderOverview`, which fetches both — calls this with the real count off the same
   * response the screen is drawn from, so the badge can never disagree with the card beside it.
   */
  function setTabBadge(id: Tab, value: string): void {
    const span = tabs.querySelector(`button[data-tab="${id}"] .badge-count`);
    if (span !== null) span.textContent = value;
  }

  async function render(): Promise<void> {
    generation += 1;
    const mine = generation;

    for (const button of Array.from(tabs.querySelectorAll('button'))) {
      button.setAttribute('aria-current', button.dataset['tab'] === tab ? 'page' : 'false');
    }
    body.replaceChildren(text('p', 'meta', 'Loading…'));

    if (tab === 'overview') await renderOverview(mine);
    else if (tab === 'departments') await renderDepartments(mine);
    else if (tab === 'roster') await renderRosters(mine);
    else if (tab === 'backups') await renderBackups(mine);
    else if (tab === 'deadlines') await renderDeadlines(mine);
    else if (tab === 'groups') await renderGroups(mine);
    else await renderHistory(mine);
  }

  /**
   * Draw the nav from `TAB_GROUPS`, once, at mount.
   *
   * `mountAdmin()` is called at most once — `main.ts` holds the console behind `admin ??=` — so
   * these buttons are built once and the listeners below outlive every render. That is why the
   * binding can stay where it always was: unlike the board's summary strip, nothing here is
   * rebuilt on a poll, so a listener bound to one of these cannot be silently thrown away.
   */
  function buildTabs(): void {
    tabs.replaceChildren();
    // `departments` (the Directory) and `groups` carry a live figure, seeded with a placeholder
    // and filled by the render for each tab — and by the Overview, which fetches both. The rest
    // are labels, not counts (`Live`, `SLA`, `Posts`, `Audit`), and never change. A hardcoded
    // `'207'` here read four short of the Directory card beside it the moment a contact was added.
    const countMap: Record<string, string> = {
      overview: 'Live',
      departments: '…',
      deadlines: 'SLA',
      roster: 'Posts',
      groups: '…',
      backups: '39m',
      history: 'Audit',
    };

    for (const { group, items } of TAB_GROUPS) {
      const box = document.createElement('div');
      box.className = 'tabgroup';
      if (group !== null) {
        box.dataset['group'] = group;
        box.append(text('span', 'tabgroupname', group));
      }
      if (group === 'Records') {
        const moved = document.createElement('button');
        moved.type = 'button';
        moved.className = 'link';
        moved.id = 'performanceMoved';
        moved.textContent = 'Performance is in the Record';
        moved.addEventListener('click', () => {
          document.getElementById('navBoard')?.click();
        });
        box.append(moved);
      }

      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset['tab'] = item.id;
        button.setAttribute('aria-current', item.id === tab ? 'page' : 'false');

        const labelSpan = text('span', 'rail-label', item.label);
        const countSpan = text('span', 'badge-count', countMap[item.id] ?? '');
        button.append(labelSpan, countSpan);
        box.append(button);
      }
      tabs.append(box);
    }

    // ADR-0032 phase 4 — the "This installation" group moved to the Settings panel. A door is
    // left where it stood, the way `#performanceMoved` marks where Performance went.
    const movedBox = document.createElement('div');
    movedBox.className = 'tabgroup';
    const moved = document.createElement('button');
    moved.type = 'button';
    moved.className = 'link';
    moved.id = 'installationMoved';
    moved.textContent = 'Screens & dashboard layout are in Settings';
    moved.addEventListener('click', () => {
      document.getElementById('navSettings')?.click();
    });
    movedBox.append(moved);
    tabs.append(movedBox);
  }

  buildTabs();

  for (const button of Array.from(tabs.querySelectorAll('button'))) {
    button.addEventListener('click', () => {
      tab = (button.dataset['tab'] ?? 'overview') as Tab;
      void render();
    });
  }

  return {
    refresh: render,
    show(next?: Tab): void {
      if (next !== undefined) tab = next;
      view.hidden = false;
      void render();
    },

    showDepartment(departmentName: string | null): void {
      tab = 'departments';
      view.hidden = false;

      // After the render, not before — the cards do not exist until it has painted.
      void render().then(() => {
        if (departmentName !== null) scrollToDepartment(departmentName);
      });
    },
  };
}
