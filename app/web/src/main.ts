/**
 * App shell boot: sign-in, rapid intake, outbox queue.
 *
 * Four behaviours here are load-bearing and must survive into anything that replaces this:
 *
 *   1. The connectivity rung is always stated, never implied — and "signed out" is a
 *      distinct state from "no signal", because they need different actions from the user.
 *   2. A queued entry never renders as delivered. "Saved" and "sent" are different words
 *      and the difference can matter to someone's life.
 *   3. An emergency can be recorded whether or not anyone is signed in (see the submit
 *      handler).
 *   4. **Submit first, enrich after.** The critical path is two taps and a button, with no
 *      typing and nothing blocking on the network or on GPS. Detail is offered only once
 *      the report is already safe. This is what makes the fifteen-second budget reachable,
 *      and the budget is a requirement — if this is slower than the phone call it replaces,
 *      the district keeps using the phone.
 */

import { Outbox } from '../../src/outbox/outbox.js';
import { IndexedDbOutboxStore, requestPersistence } from '../../src/outbox/adapters/indexeddb.js';
import { HttpTransport } from '../../src/outbox/adapters/httpTransport.js';
import { isGeneral, type IncidentEvent, type MessageKind } from '../../src/domain/events.js';
import { hasCategory, labelFor } from '../../src/domain/communications.js';
/**
 * Types only — the implementation is a lazy bundle (M9-08).
 *
 * `import type` is erased entirely by esbuild, so naming `compose.ts` here costs the shell
 * nothing. The M1 gate caught the version that imported it for real: 162 KB against a 160 KB
 * budget, for boxes a field officer never sees.
 */
import type { ComposeFields, mountComposeFields } from './compose.js';

interface ComposeModule {
  mountComposeFields: typeof mountComposeFields;
}
import { buildCapture } from './location.js';
// Types only — erased at build time, so naming them here does not pull the office screens
// into the shell. The values arrive from `/office.js` when somebody opens one.
import type { AdminConsole } from './admin.js';
import type { RosterHost, RosterPanel } from './roster.js';
import type { StatusPanel } from './status.js';
/**
 * ⚠️ **Two functions, and it must stay two — M11-34.**
 *
 * `startClock` and `startAges` are global chrome: the running clock and every age on screen
 * counting up, on *every* screen, signed in or out. They belong in the shell. The dashboard
 * itself does not, and it leaves by way of this import list and nothing else — esbuild
 * tree-shakes `dashboard.ts` down to **1,351 bytes of 20,446** as long as nothing else here
 * imports from it, and drops `tilt.ts` with it because nothing else in the shell wants it.
 *
 * So adding `createDashboard` back to this line silently returns 22 KB to the shell. It is the
 * M1 gate's budget that would notice, not a type error. `createDashboard` arrives through
 * `loadDashboard()` below.
 */
import { startAges, startClock } from './dashboard.js';
import type { DashboardLinks, DashboardScreen } from './dashboard.js';
import type { DispatchPanel, RecordOutcome, ToldEntry } from './dispatch.js';
import { incidentRow, type IncidentRowData } from './incidentRow.js';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Mirrors `Identity` in `src/auth/sessions.ts`, which is what `/auth/me` returns.
 *
 * It used to declare three of these fields, and the board read `departmentId` off it anyway
 * — `undefined === null` is false, so the district control room was labelled "your
 * department" and nobody noticed. That compiled because `web/` was not in the tsconfig at
 * all. It is now; see the note there.
 */
interface Identity {
  personId: string;
  fullName: string;
  seatId: string | null;
  seatTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  /**
   * The DC Office and the AC Headquarter Bajaur Office (ADR-0010).
   *
   * Decides whether the Administration tab is offered. It decides nothing else: every
   * `/admin` request is checked server-side against the caller's department, so this is a
   * courtesy to the operator and not a control (INV-05).
   */
  isAdministration: boolean;
  /**
   * The seat's tier — **what actually decides how wide this seat's view is** (M11-04).
   *
   * Already sent by `/auth/me`; it simply was not declared here, so the board's own label read
   * `departmentId` instead and got the answer wrong for the two offices that hold a department
   * *and* see the district. Derived by migration 0010's trigger from the seat's office, so no
   * caller can assert it — which is exactly why the M5 security review moved `viewerFor` onto it
   * and off `departmentId === null`.
   *
   * Null when the person holds no seat at all. Like `isAdministration`, this is a courtesy to
   * the operator and never a control: every response is scoped server-side (INV-05).
   *
   * ⚠️ The lower value is `'post'`, not `'department'` — ADR-0031, phase 1 renamed the tier and
   * migration 0042 rewrote every row. Only `=== 'district'` is ever tested, so the old spelling
   * was never a runtime bug, but the type was a lie about what `/auth/me` sends.
   */
  tier: 'post' | 'district' | null;
  /**
   * The access role — ADR-0032. `owner` · `admin` · `operator` · `viewer`, on `person.role`.
   * Sent by `/auth/me` since phase 1. The shell reads it for nothing more than deciding whether
   * the Settings tab is offered (`owner`/`admin` only, via `isAdministration`); every
   * `/settings` endpoint gates itself server-side regardless (INV-05).
   */
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  /**
   * Set when an administrator reset this account's password (ADR-0032 phase 3). Sign-in lands
   * the holder on "change my password" and they cannot leave it until they comply — the forced
   * dialog lives here in the shell, not in the lazy Settings bundle, because a forced `operator`
   * may have no Settings access at all.
   */
  mustChangePassword: boolean;
}

function deviceId(): string {
  const KEY = 'dnc-bajaur-device-id';
  // `localStorage` is not merely empty in a browser with site data blocked — the accessor
  // itself THROWS, and this runs synchronously inside `boot()`, so an unguarded read takes
  // the whole bundle down before the intake form is wired: an officer at a scene cannot
  // report an emergency at all (INV-01). A fresh id per launch is a worse device fingerprint
  // and a working app, which is the right trade.
  try {
    let id = localStorage.getItem(KEY);
    if (id === null) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * **The thirteen tiles, and what each one writes** — 2026-08-24.
 *
 * The district asked for one grid holding what today are two separate controls: `category`
 * (*what it is about* — fire, flood, security…) and `kind` (*what kind of message this is* —
 * emergency, alert, advisory, order, meeting, schedule, notice). `five-categories-questions.md`
 * calls a single hand-picked list option (c) and advises against it, because a security alert is
 * genuinely both at once and one tile can only say one of them. The owner chose it, and attached
 * a condition to the same decision: **the WhatsApp flow does not change.**
 *
 * That condition is what this table is. Every pair below is what the two controls already
 * produce today, so `listFor`, `thanksKindFor`, `CARRIES_SLA` and `laneOf` see exactly what
 * they saw yesterday — an *Alert* tile still earns the alert response list and the control
 * room's telephone number, a *Meeting* still earns no clock and the attendance sentence. The
 * record keeps both fields; only the screen merged.
 *
 * ⚠️ **`rescue` is a category this product has never written**, and it is safe on purpose
 * rather than by luck: both label maps (`words.ts` and `api/dashboard.ts`) already fall back to
 * the capitalised code for anything unmapped — they say so in their own comments — and
 * `listFor` sends every unknown category to the *other* list, which is where an unclassified
 * rescue call goes today. Both maps are given the word anyway, so no screen prints a code.
 *
 * ⚠️ **`order` and `schedule` are here and are NOT on the district's mock-up.** Leaving them
 * off would have quietly removed two things the app can do today — a DC office instruction that
 * carries an SLA, and a duty roster — which is the one outcome *"the WhatsApp flow does not
 * change"* forbids.
 */
const TILES: Readonly<Record<string, { category: string; kind: MessageKind }>> = {
  security: { category: 'security', kind: 'emergency' },
  fire: { category: 'fire', kind: 'emergency' },
  rta: { category: 'rta', kind: 'emergency' },
  medical: { category: 'medical', kind: 'emergency' },
  flood: { category: 'flood', kind: 'emergency' },
  rescue: { category: 'rescue', kind: 'emergency' },
  other: { category: 'other', kind: 'emergency' },
  alert: { category: 'other', kind: 'alert' },
  advisory: { category: 'other', kind: 'advisory' },
  order: { category: 'other', kind: 'order' },
  meeting: { category: 'other', kind: 'meeting' },
  schedule: { category: 'other', kind: 'schedule' },
  information: { category: 'other', kind: 'other' },
};

function checkedValue(name: string): string | null {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return input?.value ?? null;
}

const EYE_SVG =
  '<svg class="pwd-eye-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" ' +
  'd="M12 5C6.6 5 2 8.6 .3 12 2 15.4 6.6 19 12 19s10-3.6 11.7-7C22 8.6 17.4 5 12 5Z ' +
  'M15.2 12C15.2 13.77 13.77 15.2 12 15.2 10.23 15.2 8.8 13.77 8.8 12 8.8 10.23 10.23 8.8 12 ' +
  '8.8 13.77 8.8 15.2 10.23 15.2 12Z"/></svg>';
const EYE_OFF_SVG =
  '<svg class="pwd-eye-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" ' +
  'd="M12 5C6.6 5 2 8.6 .3 12 2 15.4 6.6 19 12 19s10-3.6 11.7-7C22 8.6 17.4 5 12 5Z ' +
  'M15.2 12C15.2 13.77 13.77 15.2 12 15.2 10.23 15.2 8.8 13.77 8.8 12 8.8 10.23 10.23 8.8 12 ' +
  '8.8 13.77 8.8 15.2 10.23 15.2 12Z"/><path d="M4 4 20 20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"/></svg>';

/**
 * A show/hide toggle on a password field — wraps the `<input>` in place, so any screen that
 * already has one gets the eye from a single call rather than a parallel bit of markup.
 *
 * The button is `type="button"` so it can never submit the form it sits in, and it returns
 * focus to the field on every toggle, because tapping the eye is not the reason anyone opened
 * this form.
 */
function wirePasswordEye(input: HTMLInputElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'pwd-wrap';
  input.replaceWith(wrap);
  wrap.append(input);

  const eye = document.createElement('button');
  eye.type = 'button';
  eye.className = 'pwd-eye';
  eye.setAttribute('aria-label', 'Show password');
  eye.setAttribute('aria-pressed', 'false');
  eye.innerHTML = EYE_SVG;
  wrap.append(eye);

  eye.addEventListener('click', () => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    eye.innerHTML = shown ? EYE_SVG : EYE_OFF_SVG;
    eye.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    eye.setAttribute('aria-pressed', shown ? 'false' : 'true');
    input.focus();
  });
}

async function boot(): Promise<void> {
  // Ask the browser not to evict an unreported emergency under storage pressure. Best
  // effort — it may refuse, and the app works either way.
  void requestPersistence();

  const store = await IndexedDbOutboxStore.open();
  const outbox = new Outbox({
    store,
    transport: new HttpTransport({ baseUrl: location.origin, deviceId: deviceId() }),
  });

  const status = el('status');
  const entries = el('entries');
  const count = el('count');
  const reportForm = el<HTMLFormElement>('report');
  const submit = el<HTMLButtonElement>('submit');
  /** Why the button is off, when it is. See `gateSubmit`. */
  const submitWhy = el('submitWhy');
  const sent = el('sent');
  const sentDetail = el('sentDetail');
  const loginForm = el<HTMLFormElement>('login');
  wirePasswordEye(el<HTMLInputElement>('password'));
  const loginView = el('loginView');
  const loginError = el('loginError');
  const offlineLoginNote = el('offlineLoginNote');
  const who = el('who');
  const whoName = el('whoName');

  /**
   * The control room's choice of who should know (M6-06).
   *
   * Mounted once and reused, so the operator's search box, scroll position and the district it
   * loaded survive between reports — forty calls a shift is forty rebuilds otherwise.
   */
  /**
   * Fetched on first use — see `web/src/dispatchBundle.ts` for why it left the shell.
   *
   * Still mounted **once** and reused after that, which is the property the old comment was
   * about: the operator's search box, scroll position and the district it loaded survive
   * between reports, and forty calls a shift is otherwise forty rebuilds.
   */
  /**
   * ⚠️ This is `mountDispatch`'s signature written a **second** time, and it has to be kept in
   * step by hand. The bundle is fetched at runtime and read off `window.DncDispatch`, so there is
   * no import here to carry the real type across — which is the price of it having left the shell
   * (M7-26), and the reason `beforeSend` below arrived as a typecheck failure rather than as a
   * silent mismatch. `tsc` is the guard; do not weaken this to `unknown` to quieten it.
   */
  interface DispatchModule {
    mountDispatch: (
      root: HTMLElement,
      onDispatched?: (incidentId: string) => void,
      beforeSend?: () => Promise<void>,
    ) => DispatchPanel;
    renderWhoWasTold: (
      target: HTMLElement,
      state: {
        notifications: ToldEntry[];
        kind?: string;
        dispatchedTo: { kind: string; id: string }[];
        dispatchAbsorbed: {
          target: { kind: string; id: string };
          coveredBy: { kind: string; id: string };
        }[];
        contactsOpened: { at: string; channel: string; label: string | null }[];
      },
      name: (t: { kind: string; id: string }) => string,
      record?: (attemptId: string, outcome: RecordOutcome, said: string) => Promise<void>,
      /**
       * The saved groups a dispatch expanded — Case 3. Absent / `[]` means tell it flat, which
       * is every incident dispatched by hand and every server that predates this.
       */
      recipientGroups?: {
        groupId: string;
        name: string;
        members: { kind: string; id: string }[];
      }[],
    ) => void;
    renderTakeAction: (
      target: HTMLElement,
      state: {
        incidentId: string;
        status: string;
        toldAnybody: boolean;
        escalationCount: number;
      },
      onChanged: (incidentId: string) => void,
    ) => void;
  }

  let dispatchModule: DispatchModule | null = null;
  let dispatchPanel: DispatchPanel | null = null;

  async function loadDispatch(): Promise<DispatchModule | null> {
    if (dispatchModule !== null) return dispatchModule;
    // `true` since 2026-08-14: this bundle's stylesheet left the shell with it. It had been
    // `false` because the CSS was still in `index.html` — the bundle went lazy in M7-26 and its
    // styling did not follow, so the shell drew a picker a field officer never opens.
    if (!(await loadScreen('dispatch', true))) return null;

    dispatchModule = (window as unknown as { DncDispatch?: DispatchModule }).DncDispatch ?? null;
    return dispatchModule;
  }

  async function ensureDispatchPanel(): Promise<DispatchPanel | null> {
    if (dispatchPanel !== null) return dispatchPanel;

    const module = await loadDispatch();
    if (module === null) return null;

    dispatchPanel = module.mountDispatch(
      el('dispatchPanel'),
      (incidentId) => {
        // The board's `nobodyTold` flag has just changed for this row, and an operator who tells
        // somebody and then sees the board still saying nobody was told stops believing the
        // board.
        void refreshBoard();
        void incidentId;
      },
      // The attachment has to be on the server before anybody is told, or the message goes out
      // without it and nothing reports a fault. See `settled()` in `compose.ts`.
      async () => {
        await composeFields?.settled();
      },
    );
    return dispatchPanel;
  }

  type Reachability = 'unknown' | 'reachable' | 'unreachable' | 'refused';
  let reachability: Reachability = 'unknown';
  let identity: Identity | null = null;

  /** The shape of this installation, or null when the server has not said (M6-43). */
  interface AuthMe {
    identity: Identity;
    capabilities: Record<string, boolean> | null;
  }
  let capabilities: Record<string, boolean> | null = null;
  /** The incident just reported, so enrichment can be attached to it. */
  let lastIncidentId: string | null = null;

  /**
   * Whether the signed-out visitor has pressed "Report an emergency" — 2026-09-09.
   *
   * The intake form used to be visible the instant a signed-out visitor opened the app; the
   * owner asked for it collapsed behind that link instead, revealed on demand. This is what
   * `paintIdentity()` checks before re-collapsing `#reportView` on every repaint while signed
   * out (a reconnect, an online/offline flip) — without it, a caller mid-way through reporting
   * would watch the form vanish under them the next time the network status changed.
   */
  let reportRevealed = false;

  /**
   * Connectivity is derived from whether we actually reached the server — never from
   * `navigator.onLine`, which reports whether the browser has *an interface*, not whether
   * anything gets through. A handset on a tower with dead backhaul reports `true` while
   * nothing reaches the control room. The negative is still trustworthy, so `false` is
   * believed and `true` is not.
   */
  function paintStatus(): void {
    const state =
      reachability === 'refused'
        ? 'signedout'
        : navigator.onLine === false || reachability === 'unreachable'
          ? 'offline'
          : reachability === 'reachable'
            ? 'online'
            : 'unknown';

    status.dataset['state'] = state;
    status.textContent =
      state === 'online'
        ? 'Connected. Reports are delivered immediately.'
        : state === 'offline'
          ? 'No connection. Reports are saved on this device and sent automatically when signal returns.'
          : state === 'signedout'
            ? 'Signed out. Reports are saved on this device and sent once you sign in.'
            : 'Checking connection. Reports are saved on this device either way.';
  }

  function paintIdentity(): void {
    const signedIn = identity !== null;
    loginView.hidden = signedIn;
    who.hidden = !signedIn;
    if (identity !== null) {
      // Holding no seat means signed in with no authority to act (ADR-0004). Saying so is
      // the difference between understanding why a report will not send and assuming the
      // system is broken.
      whoName.textContent =
        identity.seatId === null
          ? `${identity.fullName} — no current duty assignment`
          : identity.fullName;
    }
    // The board and the inbox both need a seat to scope them, so they are offered only once
    // signed in. Intake never is — an emergency can be captured signed out (INV-01).
    nav.hidden = !signedIn;
    // Offered only to the two offices that are the authority for the whole district
    // (ADR-0010). The server does the actual refusing.
    navAdmin.hidden = !signedIn || identity?.isAdministration !== true;
    // Settings — the `owner` and `admin` roles (ADR-0032 line 8). `isAdministration` is exactly
    // `role === 'owner' || 'admin'` since phase 2b, so it is the same gate as Administration; the
    // server refuses every /settings call without the permission regardless (INV-05).
    navSettings.hidden = !signedIn || identity?.isAdministration !== true;
    // Offered to a seat that belongs to a department. A district-wide seat with no
    // department of its own — the control room, the DC — has no "my department" to show, and
    // the two offices reach every roster through the console instead.
    /**
     * Two questions, and they are different — ADR-0016, M6-43.
     *
     * *Does this seat have one of these?* has been asked here since M1: a district-wide seat
     * has no "my department" to show. *Does this district offer this screen at all?* is new,
     * and the control room is the reason — a product that opens on nine screens they did not
     * ask for is a product they have to be taught before it helps them.
     *
     * **Neither is a control.** Hiding a tab is a courtesy to the operator; every endpoint
     * behind every one of these still asks the policy table, and the server refuses whatever it
     * would have refused with the tab visible (INV-05). An administrator who turns a capability
     * off has tidied a menu, and the console says so in those words.
     */
    const offers = (capability: string): boolean => capabilities?.[capability] !== false;

    /**
     * ⚠️ **The shift screen is retired — O-44, 2026-08-22, the owner's decision.**
     *
     * It was M1-01's whole claim: a department's duty officer works one emergency from one
     * screen — *needs you now*, their fleet, acknowledge, send, log, resolve, without leaving it.
     * [ADR-0024](../../docs/adr/ADR-0024-no-department-holds-a-seat.md) took the writing half
     * away, and what was left was a window somebody could look through and touch nothing.
     *
     * **It never had a user.** Read off the district's own database on the day it was retired:
     * **one account exists in Bajaur**, `AC HQ Bajaur`, which is the control room. Not one
     * department officer has ever been able to open it.
     *
     * The four controls that matter — follow up, escalate, resolve, close — are on the Record's
     * incident screen and always were. Two screens doing one job is how two screens start
     * disagreeing.
     */
    /**
     * The Search tab is gone; its controls live on the Record (Phase 4b), and the capability
     * still decides whether they are offered at all (ADR-0016).
     *
     * ⚠️ Read through `el()` rather than the `boardFind` binding further down this file. This
     * runs during the synchronous boot, and a `const` declared below it would be read in the
     * temporal dead zone — the same trap `applyViewBeforeFetch` already carries a note about.
     */
    /**
     * ⚠️ **Remembered, not just applied.** The Rows view hides this element when the Record
     * switches to Summary or Download, and this paint runs on identity rather than on every
     * board refresh — so without a record of the decision, coming back to Rows would leave the
     * find controls hidden and look exactly like the capability being off.
     */
    findOffered = signedIn && offers('search');
    // The DOOR carries the capability now, not the form behind it (Phase C). An installation
    // with search switched off shows no button; one with it on shows a button and not a panel.
    el('boardFindToggle').hidden = !findOffered;
    if (!findOffered) el('boardFind').hidden = true;
    /**
     * Reports needs a seat to mean anything — `GET /summary` is scoped by it (INV-05), so a
     * signed-out tab would open a screen that can only ever say 401. Deliberately NOT behind a
     * capability: reading the district's own record is not an optional feature of the product,
     * it is the thing ADR-0016 calls the control room's own work.
     */
    /**
     * Intake is the exception, and it is the one worth stating.
     *
     * `field_intake` off means an officer at a scene does not get their own reporting screen —
     * but the **control room's** intake is the same screen, and it is the product (ADR-0016).
     * So the tab stays for a control-room seat and goes for everybody else, rather than
     * disappearing for the people the whole milestone is about.
     */
    navReport.hidden = !signedIn && false;
    if (signedIn && identity?.isAdministration !== true && !offers('field_intake')) {
      navReport.hidden = true;
    }
    /**
     * "Incident details" belonged to the control room and to nobody else, until 2026-09-09.
     *
     * That gate existed for M0-36's reason: an officer at a scene gets two taps and a button
     * with no typing, because a system slower than the phone call it replaces loses to the
     * phone, and a text box above the button pushes the button down a handset screen.
     *
     * 🔴 **The owner asked for this form for everyone — signed in or not — and was told that
     * cost before it shipped: `#whatBlock` now sits above `#submit` for a signed-out reporter
     * too, so the two-tap no-typing guarantee is no longer universal.** Chosen anyway. The gate
     * is `true` unconditionally rather than deleted, so the day this is reconsidered there is
     * one line to change back, not a re-derivation of what "control room" meant.
     */
    const controlRoom = true;
    el('whatBlock').hidden = !controlRoom;
    // The six message-kind tiles, on the same line as the box they belong with.
    el('category').classList.toggle('all', controlRoom);
    // The block has just been revealed, and nothing has fired a `change` yet.
    refreshInvite();

    /**
     * The kind-specific boxes are fetched **only once this block is actually shown** — M9-08.
     *
     * Which is to say: only for an administrative seat, in the control room, and never on a
     * field officer's handset. That is the whole reason `compose.ts` is a separate bundle, and
     * the M1 gate's shell budget is what enforces it.
     *
     * Not awaited. `paintIdentity` is called from a sync path and from two async ones, and
     * making any of them wait on a script fetch would delay the screen for a file that only
     * adds optional boxes. `ensureComposeFields` is idempotent and resolves quietly on failure.
     *
     * ⚠️ **Gated on `signedIn || reportRevealed`, not on `controlRoom` alone — 2026-09-09.**
     * `controlRoom` is `true` unconditionally now, and `#whatBlock`'s own `hidden` is set
     * regardless of whether `#reportView` (its ancestor) is currently showing. Without this a
     * signed-out visitor who has not yet pressed "Report an emergency" would have `compose.js`
     * fetched onto their handset the instant `/auth/me` answers — before they have asked for
     * anything — which is exactly the needless-download-on-a-weak-connection cost this bundle
     * was split out of the shell to avoid (M9-08, the M1 gate's budget). The click handler on
     * `revealReport` calls this directly for the case this line intentionally skips.
     */
    if (controlRoom && (signedIn || reportRevealed)) void ensureComposeFields();

    // Everybody signed in gets a dashboard. What it *contains* is scoped by the server.
    navDashboard.hidden = !signedIn;
    /**
     * And fetch it now rather than on the click — M11-34.
     *
     * This is the half that lets the dashboard be a lazy screen at all: an office seat on a
     * laptop *lands* here after sign-in, and "lazy-loading is never for the screen they land
     * on". Starting the fetch the moment the menu grows a Dashboard means nobody waits, and
     * the service worker keeps it for the reload after that, connection or no connection.
     */
    if (signedIn) prefetchDashboard();
    // And the rest of the nav's screens, in the background, so opening one is not a Helsinki
    // round trip on the first click (and the first click after every deploy) — see below.
    if (signedIn) prefetchScreens();
    // And the GET each of those panels opens onto, so the first open paints filled rather than
    // onto "Loading…" — one-shot, 20 s ceiling, the panel fetches live for everything after.
    if (signedIn) prefetchScreenData();
    // Everybody signed in may state something. What, exactly, is decided server-side.
    navStatus.hidden = !signedIn;
    // Documentation about the product, not a capability of it (see help.ts) — offered to
    // anyone signed in, never behind `offers(...)`, so turning a screen off never hides the
    // paragraph explaining what it does.
    navHelp.hidden = !signedIn;

    if (!signedIn) {
      if (
        boardView.hidden === false ||
        adminView.hidden === false ||
        dashboardView.hidden === false ||
        statusView.hidden === false
      ) {
        showView('report');
      }
      /**
       * Collapsed behind its own link now (2026-09-09), not shown the instant the visitor is
       * signed out. `showView('report')` above still unhides it when that is genuinely what is
       * being switched TO (leaving the board behind on logout, say) — this line is what puts it
       * straight back behind the link on every other repaint while signed out, until
       * `revealReport`'s handler sets `reportRevealed`.
       *
       * ⚠️ Never re-hidden once revealed, on purpose: a caller mid-report must not watch the
       * form vanish under them because the network status changed while they were typing.
       *
       * 🔴 **Gated on `reachability === 'refused'`, never on `!signedIn` alone — this is the
       * fix for a real regression caught by `rapidIntake.e2e.test.ts` while building this.**
       * `identity` reads `null` for two very different reasons: the server answered "you have
       * no session" (a 401 from `/auth/me`, which is what `refused` means), and `/auth/me`
       * could not be reached AT ALL (`unreachable` — no network). An authenticated duty
       * officer who loses signal and reloads mid-emergency hits the second case: their cookie
       * is still good, the client simply cannot prove it offline. Collapsing the form there
       * would put exactly the extra click INV-01 exists to remove in front of the one person
       * this system is built hardest for. Only a confirmed "no" collapses it; "cannot tell"
       * leaves the form exactly where it always was — open.
       */
      if (!reportRevealed && reachability === 'refused') reportView.hidden = true;
    }

    const unreachable = reachability === 'unreachable' || navigator.onLine === false;
    offlineLoginNote.hidden = signedIn || !unreachable;
    el<HTMLButtonElement>('loginSubmit').disabled = unreachable;
  }

  async function paintQueue(): Promise<void> {
    const all = await store.all();
    count.textContent = `(${all.length})`;
    entries.innerHTML = '';

    for (const entry of all) {
      const payload = entry.event.payload as { category?: string; severity?: string };
      const row = document.createElement('div');
      row.className = 'entry';

      const label = document.createElement('span');
      label.textContent = `${payload.severity ?? 'unknown'} · ${payload.category ?? 'unknown'}`;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset['s'] = entry.state;
      // Never "sent", never a tick. Only what is actually true.
      badge.textContent = entry.state === 'blocked' ? 'needs attention' : 'saved on this device';

      row.append(label, badge);
      entries.append(row);
    }
  }

  async function trySync(): Promise<void> {
    // `runSync` catches every transport error internally, so the only way `outbox.sync()`
    // throws is an unguarded IndexedDB store op — a wedged or blocked `dnc-bajaur-outbox`. If that
    // escapes here, `reachability` never advances past `'unknown'` and the status line stays
    // on "Checking connection…" for good. Swallow it, keep the last known reachability, and
    // still repaint so the rest of the screen is not frozen mid-update.
    let result: Awaited<ReturnType<typeof outbox.sync>>;
    try {
      result = await outbox.sync();
    } catch (err) {
      console.error('outbox sync failed', err);
      paintIdentity();
      paintStatus();
      return;
    }
    reachability = result.authRequired ? 'refused' : result.offline ? 'unreachable' : 'reachable';
    if (result.authRequired && identity !== null) identity = null;

    paintIdentity();
    paintStatus();
    await paintQueue();
  }

  async function loadIdentity(): Promise<void> {
    try {
      const res = await fetch('/auth/me');
      const body = res.ok ? ((await res.json()) as AuthMe) : null;
      identity = body?.identity ?? null;
      /**
       * What this installation offers — ADR-0016, M6-43.
       *
       * Kept as **null** when the server did not say, rather than defaulted to "everything
       * off". A cached shell talking to an older server would otherwise hide every screen it
       * has, which is a version skew turned into a district that has lost its product — and a
       * service worker makes version skew a normal Tuesday. `offers()` treats null as "show
       * it", so an unknown answer is the generous one.
       */
      capabilities = body?.capabilities ?? null;
      // A 200 from `/auth/me` is a completed server round-trip and is the earliest honest
      // proof the connection is fine. Without this line `reachability` only ever leaves
      // `'unknown'` inside `trySync`, so an outbox that cannot open leaves the status line
      // stuck on "Checking connection…" for the whole session even though the network is up.
      if (res.ok) reachability = 'reachable';
      else if (res.status === 401 || res.status === 403) reachability = 'refused';
    } catch {
      identity = null;
      reachability = 'unreachable';
    }
    paintIdentity();
    paintStatus();
  }

  // ---------------------------------------------------------------- intake

  /**
   * The button's state and the reason for it, set in the same breath — 2026-08-14.
   *
   * Screenshotting this screen showed a pale, obviously-dead "Report emergency" and **nothing
   * anywhere saying why**. The disabling is right and long-standing; the silence was the defect.
   * Under stress a control that looks broken and a control that is waiting are not the same
   * thing, and this is the screen where that matters most.
   *
   * Written as one function that sets both, rather than a hint maintained beside the gate,
   * because a reason that can disagree with the button is worse than no reason at all — the
   * operator would be told to do something they have already done.
   */
  function gateSubmit(off: boolean, why: string): void {
    submit.disabled = off;
    // Empty rather than hidden: `.note:empty` takes the whole box out of the flow, so a live
    // button leaves nothing behind it.
    submitWhy.textContent = off ? why : '';
  }

  function refreshSubmit(): void {
    // Category is the only thing that must be chosen. Severity is pre-set to High, so the
    // fastest valid report is one tap and the button.
    if (checkedValue('category') === null) {
      gateSubmit(true, 'Choose what happened, and this turns on.');
      return;
    }

    /**
     * A General communication also wants its subject — M9-08.
     *
     * **A disabled button, never a refused submit.** The distinction is the whole of INV-01 at
     * this layer: the record accepts whatever arrives, and this is a courtesy that stops an
     * operator sending a meeting whose subject line would read "Meeting · general". An
     * emergency is never gated on anything but the category, and nothing here touches that path.
     *
     * Null when the lazy module has not loaded — on a field officer's handset it never will,
     * and there the answer is correctly "nothing more is required".
     */
    gateSubmit(
      composeFields?.missingRequired() ?? false,
      // The only other gate there is: a General communication wants its subject line. Said in
      // its own words rather than the category one, which the operator has already satisfied.
      'Add a subject, and this turns on.',
    );
  }

  //----------------------------------------------------------------------------------
  // The form follows the kind — M9-08. Lazy; see web/src/compose.ts for why.
  //----------------------------------------------------------------------------------

  let composeFields: ComposeFields | null = null;

  /**
   * Load the kind-specific boxes, once, when an administrative seat reveals `#whatBlock`.
   *
   * `.catch`-free by construction: `loadScreen` resolves false rather than throwing, and a
   * false here costs the operator the Meeting fields and costs a field officer nothing —
   * they never see this block at all. Reporting an emergency is untouched either way, which
   * is the property that matters (INV-01).
   */
  /**
   * The invitation control belongs to **Information** and to nothing else.
   *
   * Kept in the shell rather than in `compose.ts`'s rebuilt fields, beside the two other
   * top-level controls — see the markup's own note. Hidden rather than removed, so an operator
   * who switches away from Information and back finds their tick where they left it.
   */
  function refreshInvite(): void {
    el('asksAttendanceRow').hidden = el<HTMLSelectElement>('kind').value !== 'other';
  }

  async function ensureComposeFields(): Promise<void> {
    if (composeFields !== null) return;
    if (!(await loadScreen('compose', false))) return;

    const module = (window as unknown as { DncCompose?: ComposeModule }).DncCompose;
    if (module === undefined) return;

    composeFields = module.mountComposeFields(
      el('detailsBlock'),
      el<HTMLSelectElement>('kind'),
      submit,
      // The outbox lives in the shell; the upload waits on it, because evidence hangs off an
      // incident that only exists server-side once the report has synced.
      trySync,
    );
    refreshSubmit();
  }

  /**
   * `input` as well as `change`.
   *
   * `change` fires on **blur** for a text box, so an operator who types a subject and reaches
   * straight for the button would find it still disabled — and would reasonably conclude the
   * form was broken rather than that they needed to click elsewhere first.
   */
  /**
   * The tile is the control; `#kind` is the field it writes.
   *
   * Dispatched on the select rather than assigned silently, because three separate things read
   * it and none of them polls: `compose.ts` rebuilds the kind-specific boxes and the submit
   * button's own words, and `refreshInvite` shows the invitation row for Information alone.
   * A silent assignment would leave a *Meeting* tile with an emergency's button and no subject
   * box — which is the failure this listener exists to prevent.
   *
   * It cannot loop: the event it dispatches is read by listeners that never write back here.
   */
  el('category').addEventListener('change', () => {
    const chosen = checkedValue('category');
    if (chosen === null) return;
    const kind = TILES[chosen]?.kind ?? 'emergency';
    const select = el<HTMLSelectElement>('kind');
    if (select.value === kind) return;
    select.value = kind;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  reportForm.addEventListener('change', refreshSubmit);
  // The invitation control belongs to Information alone. On the form's own `change`, so it
  // follows the kind select without a second listener that could be removed independently.
  reportForm.addEventListener('change', refreshInvite);
  reportForm.addEventListener('input', refreshSubmit);
  refreshSubmit();

  /**
   * Reporting is available whether or not anyone is signed in.
   *
   * The one place the app is deliberately more permissive than the server. A duty officer
   * whose session expired overnight, on a handset with no signal, *cannot* sign in — and
   * refusing them would lose the emergency outright (INV-01). Nothing is weakened: the
   * server still requires a session to accept anything, so the report waits in the outbox.
   * The trade is attribution to whoever delivered it rather than whoever typed it, which
   * is the honest available answer.
   */
  reportForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const tile = checkedValue('category');
    if (tile === null) return;
    // One tile, two fields — see `TILES`. The fallback is the pair a bare category always
    // produced, so a value this table has never heard of is still a reportable emergency
    // (INV-01) rather than a submit that silently does nothing.
    const { category, kind: tileKind } = TILES[tile] ?? { category: tile, kind: 'emergency' };

    // Read before anything else touches the form. Never validated and never required — the
    // critical path is two taps and a button (M0-36), and an emergency is never refused for
    // a missing field (INV-01).
    const what = el<HTMLTextAreaElement>('what').value.trim();
    /**
     * **"Anything else?" stays removed; "Where is it?" is restored — 2026-09-05, same day as
     * the removal.**
     *
     * The two boxes were pulled together on one reasoning: neither one's own text was ever read
     * back anywhere a human could see it — not the board, not the printed report, not the
     * WhatsApp message. That reasoning held for "Anything else?", whose text duplicated
     * "Incident details" (`what`) below. It did not hold for the place a caller gave: nothing
     * else on this form asks for it, and a control room read "Location kahi nahi record hoti"
     * (`CLAUDE.md` §5) and was right. So the box is back and, this time, its text actually goes
     * somewhere: `location.text` rides the `reported` event below, and
     * `domain/communications.ts`'s `locationLine` is what puts it on the WhatsApp message and the
     * Record row's expanded title (`jobs/whatsappChannel.ts`'s `messageFor`). `description` stays
     * `what` alone — the place is a separate fact, not joined into it.
     */
    const description = what;
    const place = el<HTMLInputElement>('place').value.trim();
    // Read from the tile, not from the select the tile writes: one source, and it is the one
    // the operator actually touched.
    const messageKind: string = tileKind;
    // M10-20/22. A top-level field on `reported`, not one of compose.ts's dynamically-rebuilt
    // boxes — those nest everything into `details`, which is the wrong place for a field the
    // server writes beside `kind`.
    //
    // **It was a `<select>` until 2026-08-24 and is now two tiles**, read like every other radio
    // group on this form. The fallback is not defensive: `checkedValue` returns null only if the
    // `checked` attribute is ever removed from the markup, and `important` is what that markup
    // ships — M10-41 asks an operator to move importance DOWN, never to remember to raise it.
    const importance = checkedValue('importance') ?? 'important';
    const details = composeFields?.read() ?? {};
    /**
     * **Ask who is coming, on an Information notice** — the district's five, 2026-08-22.
     *
     * Read the way `kind` and `importance` are, and for the same reason: it is a top-level
     * field on `reported`, not one of `compose.ts`'s dynamically-rebuilt boxes — that path
     * nests everything into `details`, which is the wrong place for a field the server writes
     * beside `kind`.
     */
    const asksAttendance = el<HTMLInputElement>('asksAttendance').checked;

    const incidentId = crypto.randomUUID();
    const draft = {
      eventId: crypto.randomUUID(),
      incidentId,
      type: 'reported',
      occurredAt: new Date().toISOString(),
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'mobile',
      payload: {
        reportId: crypto.randomUUID(),
        category,
        severity: checkedValue('severity') ?? 'high',
        /**
         * What the caller said, when somebody typed it.
         *
         * **This was missing entirely**, and three things were broken by its absence rather
         * than by anything that looked like a bug:
         *
         *   * the incident detail, the board and the post-incident report could only ever say
         *     *"fire · critical"*, because that was genuinely all the record held;
         *   * **keyword routing signals could never match** — `route()` searches this text, so
         *     a district that wrote "canal breach" as a signal would have watched it match
         *     nothing, for ever, with the board saying *no routing signal* and the
         *     configuration being perfectly correct;
         *   * a WhatsApp alert would go out saying the place was not stated.
         *
         * Omitted rather than sent empty when nobody typed anything: an empty string is a
         * description somebody wrote, and `route()` and every screen would treat it as one.
         */
        ...(description === '' ? {} : { description }),
        /**
         * What kind of thing this is — M7-23.
         *
         * Omitted when it is an emergency, matching the server: the absent value already means
         * that, and a field on 95% of rows repeating the default is a field somebody eventually
         * matches on instead of using the fold.
         *
         * The select is control-room only, so on a field officer's handset `messageKind` is
         * always `emergency` and this line contributes nothing — which is correct. An officer
         * standing at a road accident is not choosing between four kinds of message.
         */
        ...(messageKind === 'emergency' ? {} : { kind: messageKind }),
        /**
         * Importance — M10-20/41. **This report goes through the outbox, not `intake()`** — a
         * draft `reported` event is built right here and delivered by `/sync`, which appends it
         * as sent (`server.ts`'s push handler) with no defaulting of its own. `api/lifecycle.ts`'s
         * write-time default only ever runs for the one path that calls `intake()` directly, so
         * this form must write the value itself rather than lean on that.
         *
         * **This was omitted-when-important at first, mirroring `kind` two lines up, and it was
         * wrong** — found by a browser test reading the payload back from Postgres and finding no
         * `importance` field at all on a fresh emergency. `kind`'s own omission is safe only
         * because the fold's absent-value reading agrees with it (`emergency`); the fold's
         * absent-value reading for `importance` is `routine` (M10-21) — the *opposite* of what a
         * fresh emergency should get — so omitting it here silently inverted M10-41 for every
         * report this form ever sent.
         *
         * Omitted only for General communications, where importance has no meaning
         * (`isGeneral`) — the same condition `api/lifecycle.ts`'s `intake()` uses, so a report
         * built here and one built there agree on when the field exists at all.
         *
         * `messageKind === 'emergency'` two lines up means "the select was never touched", not
         * "this is definitely an emergency" — a field officer's handset never reveals
         * `#whatBlock` at all, so `importance` reads its own default value ('important') on
         * every rapid-intake report, which is exactly right (M10-41).
         */
        ...(!isGeneral(messageKind as MessageKind)
          ? { importance: importance === 'routine' ? 'routine' : 'important' }
          : {}),
        /**
         * The structured detail for a General communication — M9-08.
         *
         * Omitted entirely when nothing was typed, matching the server's own `cleanDetails`:
         * `{}` is a claim that somebody was asked and left every box blank, and this goes into
         * an append-only payload that can never be corrected afterwards.
         *
         * **Not validated here, and that is deliberate.** A required subject is enforced by
         * `refreshSubmit` disabling the button, which is a courtesy to the operator; the record
         * itself never refuses (INV-01). A meeting typed into this form is a meeting somebody
         * meant to announce, and losing it to a client-side check would be the same failure for
         * a smaller reason.
         */
        ...(Object.keys(details).length === 0 ? {} : { details }),
        /**
         * Written only for a notice that asked, and absent means no — which every notice sent
         * before today was, so the fold's absent-value reading agrees with the omission. That
         * is what `importance` two blocks up could NOT do, and why this one is safe to omit.
         */
        ...(messageKind === 'other' && asksAttendance ? { asksAttendance: true } : {}),
        // The place the operator typed, or nothing — the device's own fix was tried alongside
        // this for one day and removed the same day, see `web/src/location.ts`.
        location: buildCapture(place),
      },
    } as unknown as Omit<IncidentEvent, 'clientSeq' | 'recordedAt'>;

    // Durable first, always. Nothing here waits on the network.
    await outbox.enqueue(draft);
    lastIncidentId = incidentId;

    /**
     * The attachment goes **after** the report is durable, and never blocks it — M9-15.
     *
     * The order is the whole of INV-01 at this layer. The report is in the outbox before a byte
     * of the file moves, so an upload that fails, times out, or is interrupted by the operator
     * closing the laptop cannot cost the district the emergency. The file is the enrichment;
     * the record is the point.
     *
     * Not awaited by the screen either — `sent` is revealed immediately below, because an
     * operator watching a twenty-megabyte upload before being told their report was saved is an
     * operator who will reach for the telephone next time.
     */
    void composeFields?.send(incidentId);

    // The operator's job is done at this point. Everything below is optional.
    sent.hidden = false;
    sentDetail.textContent = 'Saved.';
    submit.disabled = true;

    await paintQueue();

    /**
     * Sync first, then offer the choice of who to tell (M6-06).
     *
     * `dispatch-to` is a server command against an incident that has to exist there — and
     * intake writes to the outbox and syncs afterwards (ADR-0002), so on a bad connection the
     * report is safe on this device and not yet on the server. Awaiting the sync makes the
     * common case work; the panel says what happened honestly when it does not, and the report
     * is never at risk either way.
     */
    await trySync();

    // The same words the report carries, so the routing signals propose against what the
    // caller actually said rather than against the category alone (M6-07).
    /**
     * Fetched now, after the report is already safe — never before it.
     *
     * The ordering is the whole of M0-36 and it survives the panel becoming a lazy bundle: the
     * emergency is in the outbox and syncing by the time this line runs, so a failed fetch of
     * `/dispatch.js` costs the operator the picker and costs the district nothing. `.catch`
     * because nothing here may throw into the intake path.
     */
    void ensureDispatchPanel()
      .then((panel) => panel?.open(incidentId, { category, description }))
      .catch(() => {
        /* The panel renders its own failure. Nothing here may throw into the intake path. */
      });
  });

  el('newReport').addEventListener('click', () => {
    reportForm.reset();
    sent.hidden = true;
    lastIncidentId = null;
    // The previous emergency's recipients must not be carried into the next one. A control
    // room takes forty calls a day and a pre-ticked list from the last one is how the wrong
    // department gets told at 02:00.
    // Only if it was ever mounted. Nothing to forget when nobody has chosen anybody yet.
    dispatchPanel?.reset();
    refreshSubmit();
  });

  // ---------------------------------------------------------------- board (M0-33)

  const nav = el('nav');
  const navReport = el<HTMLButtonElement>('navReport');
  const navBoard = el<HTMLButtonElement>('navBoard');
  const reportsView = el('reportsView');
  const reportView = el('reportView');

  /**
   * "No account? Report an emergency" reveals the form rather than opening onto it — see
   * `reportRevealed` and the `!signedIn` block in `paintIdentity()`. `preventDefault` because
   * the anchor's `href="#reportView"` exists for anybody reading the markup without a browser
   * (and as a target `:target`-based CSS could key off later); the reveal itself is this click.
   */
  el<HTMLAnchorElement>('revealReport').addEventListener('click', (event) => {
    event.preventDefault();
    reportRevealed = true;
    reportView.hidden = false;
    reportView.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // `paintIdentity()`'s own trigger deliberately skips a signed-out, not-yet-revealed
    // visitor (see the comment beside it) — this is that fetch, now that they have asked.
    void ensureComposeFields();
  });

  const boardView = el('boardView');
  const boardAsOfText = el('boardAsOfText');
  const boardScope = el('boardScope');
  const boardSummary = el('boardSummary');
  const boardRows = el('boardRows');
  const boardEmpty = el('boardEmpty');
  const boardAsOf = el('boardAsOf');
  const boardDate = el('boardDate') as HTMLInputElement;
  const boardPrev = el('boardPrev');
  const boardNext = el('boardNext');
  const boardToday = el('boardToday');

  /**
   * Which district day the board is showing — ADR-0020.
   *
   * `null` means today, and today is **resolved by the server**, never here. A handset in a
   * different timezone that computed its own "today" would quietly ask for a different day and
   * show a board that is real, current, and not Bajaur's — the same reason `occurredToday` is
   * decided on the server (see `BoardRow`).
   */
  let boardDay: string | null = null;

  /**
   * **The Record's own view: every record, newest first, whatever day it started** — Phase 4c;
   * widened 2026-09-06 to carry closed rows too (the owner's call).
   *
   * `true` on arrival from the nav and **`false` the moment somebody names a day** or arrives
   * from a Dashboard figure, because both of those are questions about a period and this is not
   * one. The server refuses being asked for both at once rather than guessing.
   *
   * ⚠️ **The name is historical** — it once meant *open only*. This is where the older cases
   * live now: the Dashboard is one district day and an incident belongs to the day it started,
   * so nothing above this screen counts them and no escalation chases them, and the Record
   * opening on today would have left them reachable only by somebody who already knew they were
   * there. Dropping the finished rows on top of that put a stale still-open case at the head of
   * the list while the newest thing that happened — resolved by lunchtime — was off-screen, so
   * this view now folds open and closed alike, ordered newest-entered first, however the Record
   * is reached. The wire param it sends is still `?open=1`.
   */
  let boardOpenOnly = true;

  const boardAllOpen = el('boardAllOpen');
  const boardScopeNote = el('boardScopeNote');
  const boardTruncated = el('boardTruncated');
  // A board refresh continues while another Record view is open. Keep a queue warning in the
  // Rows view it describes rather than letting a background refresh draw it over Summary.
  let boardRowsVisible = true;
  /** Whether the rows view is showing a search rather than a day. */
  let findActive = false;

  function shiftDay(by: number): void {
    boardOpenOnly = false;
    const from = boardDate.value === '' ? null : boardDate.value;
    if (from === null) return;
    const next = new Date(`${from}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + by);
    boardDay = next.toISOString().slice(0, 10);
    if (
      (boardDate.min !== '' && boardDay < boardDate.min) ||
      (boardDate.max !== '' && boardDay > boardDate.max)
    ) {
      return;
    }
    void refreshBoard();
  }

  boardPrev.addEventListener('click', () => shiftDay(-1));
  boardNext.addEventListener('click', () => shiftDay(1));
  boardDate.addEventListener('change', () => {
    // Naming a day is asking a different question from "the whole record, newest first", so it
    // leaves the Record's own view rather than quietly narrowing it.
    boardOpenOnly = false;
    boardDay = boardDate.value === '' ? null : boardDate.value;
    void refreshBoard();
  });
  boardToday.addEventListener('click', () => {
    boardOpenOnly = false;
    boardDay = null;
    void refreshBoard();
  });
  boardAllOpen.addEventListener('click', () => {
    boardOpenOnly = true;
    boardDay = null;
    boardFilter = null;
    applyBoardFilter();
    void refreshBoard();
  });

  const boardScopeWhat = el('boardScopeWhat');
  const boardDayRow = el('boardDay');
  const boardPickDay = el<HTMLButtonElement>('boardPickDay');

  /**
   * **"A day" — the other half of a control that only ever had one half.**
   *
   * Stepping into a day was possible before this and was never *offered*: it happened as a
   * side effect of touching the date input, or of arriving from a Dashboard figure. So the
   * screen had a button for leaving the day view and none for entering it, and an operator
   * who wanted yesterday had to know that typing in a box they could not see below the queue
   * was the way.
   *
   * It asks for **today** rather than for whatever day was last looked at. `boardDay = null`
   * means today and today is the server's answer, never this file's — the same reason
   * `boardDate` is written from the response and not from a midnight computed here.
   */
  boardPickDay.addEventListener('click', () => {
    if (!boardOpenOnly) return;
    boardOpenOnly = false;
    boardDay = null;
    void refreshBoard();
  });

  /**
   * Say what this screen is showing, in words, in the largest type on the band — ADR-0020.
   *
   * ⚠️ **Driven by the date the SERVER echoed back, never by what was asked for.** `date` comes
   * back `null` for the still-open view and as the day it actually folded for every other, so a
   * bar that reads "Tuesday, 19 August" cannot appear above rows belonging to Wednesday. The
   * first load asks for nothing at all and only the server knows what Bajaur's today is.
   *
   * ⚠️ **Find mode does not come through here.** `enterFindMode` writes its own sentence, and a
   * refresh landing mid-search must not overwrite it with the day underneath — see the guard.
   */
  function paintScope(shown: string | null): void {
    boardAllOpen.setAttribute('aria-pressed', String(boardOpenOnly));
    boardPickDay.setAttribute('aria-pressed', String(!boardOpenOnly));
    // The day navigation is only an answer to a question somebody is asking. In the still-open
    // view it is a date box with nothing in it, which is the screen offering a day it is not
    // showing — the confusion ADR-0020 spends a section refusing.
    boardDayRow.hidden = boardOpenOnly;

    if (findActive) return;
    boardScopeWhat.textContent = boardOpenOnly
      ? 'Every record — newest first'
      : shown === null
        ? 'Today'
        : namedDay(shown);
  }

  /**
   * `2026-08-19` as `Tuesday, 19 August 2026`.
   *
   * Built from the parts rather than `toLocaleDateString` on a bare date string: `new
   * Date('2026-08-19')` is parsed as UTC midnight and rendered in the reader's own zone, which
   * in Bajaur (UTC+5) is still 19 August and in Honolulu is the 18th. The board's day is the
   * district's day, so the string is read as the district wrote it and never re-zoned.
   */
  function namedDay(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    if (y === undefined || m === undefined || d === undefined) return iso;
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  const boardUnassigned = el('boardUnassigned');
  const boardFind = el('boardFind');
  const boardResults = el('boardResults');

  /**
   * The way back onto the board — M10-13/17/40.
   *
   * `?withdrawn=1` is the server's own door (`server.ts`'s note on `showWithdrawn`); this is
   * where an operator reaches it. Off by default for the same reason `hideWithdrawn` is opt
   * out server-side: the ordinary board is the live queue, and a withdrawn row sitting among
   * it unmarked would read as an emergency nobody had answered.
   */
  let showWithdrawn = false;
  const boardWithdrawn = el('boardWithdrawn');
  const boardWithdrawnText = el('boardWithdrawnText');
  const boardWithdrawnToggle = el<HTMLButtonElement>('boardWithdrawnToggle');
  boardWithdrawnToggle.addEventListener('click', () => {
    showWithdrawn = !showWithdrawn;
    void refreshBoard();
  });

  /**
   * **Which column the board is ordered by — M11-11. The server does the ordering.**
   *
   * This holds only what to *ask for*; nothing here sorts anything. ⚠️ A comparator in the
   * browser would be a second ordering rule beside `compareRows`, and the drift would be
   * specific and harmful: `attentionRank` puts an **unassessed** report just above `critical`
   * because it could be anything (ADR-0009), and a client sorting on the row's own severity word
   * would bury it at the bottom under a heading claiming to be sorted by severity. The screen
   * would look perfectly correct.
   *
   * `null` is the server's triage order (`compareRows`) — what "Queue order" resets to and what
   * every other caller of `buildBoard` gets.
   *
   * **The Record opens on the most recently recorded incident — 2026-09-06, the owner's call.**
   * However the Record is reached — the nav, a Dashboard figure, a search, a shared link — the
   * first row is whatever was entered into the record most recently, so an operator filing a
   * report and opening the Record finds it at the top. `-recorded` orders on `arrivedAt` (the
   * incident's first `reported` event reaching the server), **not** `-age` (`occurredAt`, when
   * it is said to have happened): a report typed in now about last night must still lead, and
   * under `-age` it would sink to wherever last night falls. `recorded` is an order `board.ts`
   * offers in `BOARD_SORTS`, so this is still one ordering rule decided on the server; the
   * client only picks it as the opening choice. A `sort=` in the URL still wins
   * (`applyViewBeforeFetch`), every column header still works, and `#boardSortReset`
   * ("Queue order") is the one tap back to triage order. The wall board is untouched.
   */
  let boardSort: { key: string; desc: boolean } | null = { key: 'recorded', desc: true };
  const boardTable = el('boardTable');
  const boardHead = el('boardHead');
  const boardSortReset = el<HTMLButtonElement>('boardSortReset');

  /**
   * Paint the sort indicator — **from what was asked for, never from what was clicked.**
   *
   * Called after a refresh returns, so an arrow can never describe an ordering the rows do not
   * have. A header that says "sorted by age" over rows the server refused to sort that way is
   * the same class of lie as a board that claims to be live during an outage (INV-02), in a
   * quieter place, and quieter is worse here: nobody checks a column heading.
   */
  function paintSortState(): void {
    for (const head of Array.from(boardHead.querySelectorAll<HTMLElement>('button.bh'))) {
      const key = head.dataset['sort'];
      if (key === undefined) continue;
      const on = boardSort !== null && boardSort.key === key;
      if (on) {
        head.dataset['dir'] = boardSort?.desc === true ? 'desc' : 'asc';
        head.setAttribute('aria-sort', boardSort?.desc === true ? 'descending' : 'ascending');
      } else {
        delete head.dataset['dir'];
        head.setAttribute('aria-sort', 'none');
      }
    }
    // Offered only when there is something to go back from. A permanent "Queue order" button
    // beside a board that is already in queue order is a control that does nothing, which is
    // exactly what the seven tiles this milestone removed were.
    boardSortReset.hidden = boardSort === null;
  }

  boardHead.addEventListener('click', (event) => {
    const head = (event.target as HTMLElement | null)?.closest<HTMLElement>('button.bh') ?? null;
    const key = head?.dataset['sort'];
    if (key === undefined) return;
    // Same column again reverses it; a different column starts ascending. Never a third state:
    // three-way cycling on a header is the pattern people click past without noticing, and
    // `#boardSortReset` is the visible way back.
    boardSort =
      boardSort !== null && boardSort.key === key
        ? { key, desc: !boardSort.desc }
        : { key, desc: false };
    void refreshBoard();
  });

  boardSortReset.addEventListener('click', () => {
    boardSort = null;
    void refreshBoard();
  });

  /**
   * Comfortable ↔ compact — M11-12. **CSS only**, and that is the whole of it.
   *
   * The wall is read at four metres (ADR-0015) and the operator's own laptop at sixty
   * centimetres. Nothing is added, removed, reworded or reordered between the two — an operator
   * who compacts the board is looking at the same rows, closer together.
   */
  const boardDensity = el<HTMLButtonElement>('boardDensity');
  boardDensity.addEventListener('click', () => {
    const compact = boardTable.dataset['density'] !== 'compact';
    boardTable.dataset['density'] = compact ? 'compact' : 'comfortable';
    boardDensity.setAttribute('aria-pressed', String(compact));
    boardDensity.textContent = compact ? 'Comfortable' : 'Compact';
    // Density is presentation and nothing else, so it rides in the URL with the rest of the
    // view: a link to "the board, compact, worst first" is one link.
    writeView();
  });

  /**
   * The Record's ONE date range — M7-27, and from Phase 5 the boxes drive the find controls and
   * the Summary view. Defaulted to the current month here so both work before anybody touches
   * them.
   *
   * The per-period file downloads that used to read this same pair (`ackReportLink` and
   * friends) moved onto Administration → History on 2026-09-05, at the owner's request, and
   * carry their own From/To there — this block no longer retargets anything, only defaults it.
   */
  {
    const from = el<HTMLInputElement>('reportFrom');
    const to = el<HTMLInputElement>('reportTo');

    const today = new Date();
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    from.value = iso(new Date(today.getFullYear(), today.getMonth(), 1));
    to.value = iso(today);
  }

  // The administration console (M1a). Mounted for everyone and shown to nobody until the
  // identity says so — building it lazily would mean the tab appearing a beat after the
  // rest of the app, on the screen whose whole job is to be trusted.
  const navAdmin = el<HTMLButtonElement>('navAdmin');
  const adminView = el('adminView');

  // Settings (ADR-0032 phase 3). Its own top-level panel; the tab is shown to the `owner` and
  // `admin` roles, and `#settingsView` is filled lazily by `settings.js` on first open.
  const navSettings = el<HTMLButtonElement>('navSettings');
  const settingsView = el('settingsView');
  /**
   * The office screens, fetched together on first use — see `web/src/office.ts`.
   *
   * The console, the roster and the Status screen are one bundle because `admin.ts` already
   * imports `roster.ts` (the console reaches every department's roster, and "My department" is
   * the same component through its other door). Splitting them would put a second copy of the
   * roster in one of the two files, and the point of this is fewer bytes.
   *
   * None of the three is any use at a scene, and none works without a connection.
   */
  interface Office {
    mountAdmin: () => AdminConsole;
    mountRoster: (host: RosterHost) => RosterPanel;
    mountStatus: (options: { onChanged?: () => void }) => StatusPanel;
  }

  let office: Office | null = null;

  /**
   * A department to scroll the console to once it has loaded — M6-15.
   *
   * A pending intention rather than a call, because the console is a lazily fetched bundle:
   * `showView('admin')` starts the fetch and cannot wait for it, and a fetch that fails (no
   * connection) must leave nothing half-applied. Consumed exactly once, by whoever mounts it.
   */
  let pendingConsoleDepartment: string | null | undefined;

  async function loadOffice(): Promise<Office | null> {
    if (office !== null) return office;
    // `true` since 2026-08-14 — see the note in `loadDispatch`. The console, the roster and the
    // Status screen have been fetched on first use since 2026-08-04; their CSS stayed behind.
    if (!(await loadScreen('office', true))) return null;

    office = (window as unknown as { DncOffice?: Office }).DncOffice ?? null;
    return office;
  }

  let admin: AdminConsole | null = null;

  // A department's own roster (M1a-10) — the other door onto the same component the console
  // uses. The server resolves "my department" from the caller's seat, so a department
  // officer never has to know their own uuid and cannot change the answer by sending one.
  const navDashboard = el<HTMLButtonElement>('navDashboard');
  const navHelp = el<HTMLButtonElement>('navHelp');
  const helpView = el('helpView');
  const navStatus = el<HTMLButtonElement>('navStatus');
  const statusView = el('statusView');
  const dashboardView = el('dashboardView');

  /**
   * The dashboard (M4). Refreshes only while it is the screen somebody is looking at.
   */
  /**
   * The dashboard, and where its panels lead.
   *
   * A summary that cannot be opened is a summary somebody has to act on by memory: they read
   * "Fire — 2 open", switch to the board, and hunt. Each panel therefore leads to the screen
   * that already answers the next question, rather than growing a second detail view beside
   * the one the board already has.
   */
  /**
   * Built the first time somebody opens the dashboard, from a file fetched then — M11-34.
   *
   * These are only the links, held apart from the screen so the callbacks can be written here,
   * beside the views they open, while the code that draws the panels lives in `dashboard.js`.
   */
  const dashboardLinks: DashboardLinks = {
    onOpenCategory: (category, label) => {
      showBoardFiltered('category', category, label);
    },
    /**
     * A carried thing, opened on itself.
     *
     * `showView('board')` before `openDetail` and not instead of it: the detail renders into
     * the board's own panel, so opening it while the dashboard is on screen would write into a
     * view nobody is looking at. The board is also where **Resolve** and **Close** live
     * (`renderTakeAction`), which is the reason somebody follows one of these rows at all.
     */
    onOpenIncident: (incidentId) => {
      showView('board');
      void openDetail(incidentId);
    },
    onOpenDepartment: (name) => {
      showBoardFiltered('department', name, name);
    },
    /**
     * A district counter, opened on exactly what it counted.
     *
     * `open` is the board with no filter — everything live, which is what that counter counts.
     * The rest filter on an attribute the **server** set, so the number and the rows agree by
     * construction rather than by two implementations happening to match.
     *
     * The board is refetched rather than filtered in place, because "today" needs closed rows
     * the current fetch did not ask for.
     */
    onOpenFlag: (flag) => {
      // Today's figure, so today's rows. The Record's still-open view spans every day and would
      // land on more rows than the number that was clicked — the counter-and-rows disagreement
      // M11-06 exists to refuse.
      boardOpenOnly = false;
      boardFilter = flag === 'open' ? null : { kind: flag, value: flag, label: flag };
      pendingLanding = true;
      showView('board');
      void refreshBoard();
    },
    // Utilities, services and presence are *changed* on the Status screen, so that is where
    // "tell me more" leads: the row, with its note and its buttons.
    onOpenStatus: () => {
      showView('status');
    },
    onOpenAdmin: () => {
      showView('admin');
    },
    /**
     * Straight to the department's card, from where something about it was noticed — M6-15.
     *
     * The console is a lazily fetched bundle, so it may not exist yet when this fires — and it
     * cannot be fetched at all with no connection. `showView('admin')` starts that load and
     * reports its own failure; this waits for it rather than racing it, and if the load failed
     * there is simply nothing to scroll to, which is the correct outcome and already visible
     * on screen.
     */
    onOpenDepartmentInConsole: (departmentName) => {
      pendingConsoleDepartment = departmentName;
      showView('admin');
    },
    canAdmin: () => identity?.isAdministration === true,
  };

  let dashboard: DashboardScreen | null = null;

  /**
   * Fetch the dashboard bundle and build the screen. Once, then held.
   *
   * ## Why the dashboard is lazy at all, when somebody *lands* on it
   *
   * The rule this project wrote for lazy screens is **"for screens somebody chooses to open,
   * never for the one they land on"** (`dispatchBundle.ts`), and the sign-in handler below
   * lands an office seat on this very screen. The rule is not being bent — it is being paid
   * for, by `prefetchDashboard()`: any seat whose menu carries a Dashboard fetches this file
   * as soon as sign-in says so, before anybody clicks anything. What is lazy for a field
   * officer, who will never open it, is already in hand for the office that will.
   *
   * The shell was **1,800 bytes** under its budget when this was written and this moved 22 KB
   * out of it. The budget is not the thing that moves — `m1gate.e2e.test.ts` says so in its
   * own comment, and this is the fourth screen to leave for that reason.
   *
   * Returns null rather than throwing, like every other screen here: a screen that did not
   * arrive is a sentence on the page, not a dead tab.
   */
  let dashboardLoad: Promise<DashboardScreen | null> | null = null;

  async function loadDashboard(): Promise<DashboardScreen | null> {
    if (dashboard !== null) return dashboard;
    /**
     * ⚠️ The in-flight promise is held, not just the result.
     *
     * `prefetchDashboard()` runs from `paintIdentity`, which is called from three paths, and a
     * guard on the *result* alone is still null while the first fetch is in the air — so two
     * calls a few milliseconds apart would append two `<script>` tags and build two screens,
     * each with its own poll timer against the district's one server. That is the same shape
     * as the `EventSource` leak this milestone already paid for, one screen along.
     */
    if (dashboardLoad !== null) return dashboardLoad;

    dashboardLoad = buildDashboard();
    return dashboardLoad;
  }

  async function buildDashboard(): Promise<DashboardScreen | null> {
    // No stylesheet: the dashboard's CSS stays in the shell. `:root`, the focus ring, `main`
    // and `#loginView` are interleaved with it, so moving that block is a different change
    // from moving this one — and leaving it means the screen can never paint unstyled.
    if (!(await loadScreen('dashboard', false))) {
      dashboardLoad = null;
      return null;
    }

    const factory = (
      window as unknown as {
        DncDashboard?: { createDashboard: (links: DashboardLinks) => DashboardScreen };
      }
    ).DncDashboard;

    dashboard = factory?.createDashboard(dashboardLinks) ?? null;
    // A failed fetch is not remembered as an answer: the operator may be offline now and
    // connected in a minute, and the next click should try again rather than repeat a sentence.
    if (dashboard === null) dashboardLoad = null;
    return dashboard;
  }

  /**
   * Start the fetch early, for a seat that will land on it or reach for it.
   *
   * Deliberately not awaited by anything: it warms the browser cache and, through it, the
   * service worker's, so the screen is there on the first click **and** on a later reload with
   * no connection. A failure here is silent on purpose — `showDashboard()` is what reports one,
   * in words, at the moment somebody is actually looking.
   */
  function prefetchDashboard(): void {
    void loadDashboard();
  }

  /**
   * Warm every other lazy screen bundle in the background, the moment sign-in says there is a
   * control room at the keyboard — `prefetchDashboard()`'s reasoning, widened to the whole nav.
   *
   * Every screen but the Record and the report form is its own `*.js` (+ `*.css`) bundle,
   * fetched on the first click by `loadScreen`. On a control-room laptop ~150 ms from Helsinki
   * that first open waits on a round trip before the panel can even mount — and a `CACHE` bump
   * empties the service worker's copy, so it is the first open *after every deploy* too. A
   * signed-in seat is an office seat on a laptop (ADR-0018): it will open the console, Settings
   * and the reports, so the bytes are fetched now, at idle, before anybody reaches for them.
   *
   * `<link rel="prefetch">`, never the `loadScreen` wrappers: this warms the browser cache and
   * through it the service worker's, without appending a `<script>` that would execute a bundle
   * twice if the real open races the prefetch — the trap `ensureSearchPanel` documents. The ids
   * are suffixed so they cannot be mistaken for the real `#<name>Css` stylesheet `loadScreen`
   * appends; a prefetch link is not a stylesheet and applies nothing.
   */
  let screensPrefetched = false;

  function prefetchScreens(): void {
    if (screensPrefetched) return;
    screensPrefetched = true;

    const bundles: [string, 'script' | 'style'][] = [
      ['office.js', 'script'],
      ['office.css', 'style'],
      ['dispatch.js', 'script'],
      ['dispatch.css', 'style'],
      ['compose.js', 'script'],
      ['search.js', 'script'],
      ['report.js', 'script'],
      ['report.css', 'style'],
      ['reports.js', 'script'],
      ['reports.css', 'style'],
      ['settings.js', 'script'],
      ['settings.css', 'style'],
      ['help.js', 'script'],
      ['help.css', 'style'],
    ];

    const warm = (): void => {
      for (const [file, as] of bundles) {
        const id = `prefetch-${file}`;
        if (document.getElementById(id) !== null) continue;
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'prefetch';
        link.as = as;
        link.href = `/${file}`;
        document.head.append(link);
      }
    };

    // After the screen somebody actually landed on has had its turn — the dashboard prefetch
    // and the first `/dashboard` fetch share the district's one server, and this must not race
    // them for it.
    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (typeof idle === 'function') idle(warm, { timeout: 3000 });
    else window.setTimeout(warm, 2000);
  }

  /**
   * The GET each nav panel fires on the tab it opens on, fetched once at idle after sign-in and
   * held for the first — and only the first — time that panel asks for it.
   *
   * `prefetchScreens` above warms the *bundle*; this warms the *data*. Even with the bundle in
   * hand a panel still opens onto "Loading…" while its overview `Promise.all` makes one ~150 ms
   * Helsinki round trip. These are `NEVER_CACHE` routes (accounts, the roster, integrity) — the
   * service worker will not hold them and must not — so the warm copy lives here, in memory, and
   * comes with two guards that keep it from ever being stale in a way that matters:
   *
   *   • one-shot — `__dncPrefetchGet` deletes the entry as it hands it back, so only the very
   *     first read of the session is ever served from here; every re-open, tab switch and
   *     Refresh goes to the server exactly as before;
   *   • a 20-second ceiling — past that the entry is dropped unread and the panel fetches live.
   *
   * A mutation is a POST/PUT/PATCH/DELETE and never comes through here. A failed prefetch is
   * silent: the panel fetches the route itself, which is the behaviour without this at all.
   */
  const prefetchedGets = new Map<string, { at: number; body: unknown }>();
  (window as unknown as { __dncPrefetchGet?: (path: string) => unknown }).__dncPrefetchGet = (
    path,
  ) => {
    const hit = prefetchedGets.get(path);
    if (hit === undefined) return undefined;
    prefetchedGets.delete(path);
    if (Date.now() - hit.at > 20_000) return undefined;
    return hit.body;
  };

  let screenDataPrefetched = false;

  function prefetchScreenData(): void {
    if (screenDataPrefetched) return;
    screenDataPrefetched = true;

    // `settings.ts` computes this exact string from the browser's clock for its access-log
    // window (`startOfToday`); it must match to the millisecond or the entry simply misses.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = encodeURIComponent(midnight.toISOString());

    const paths = [
      '/roster/contacts',
      '/admin/integrity',
      '/admin/backups',
      '/admin/groups',
      '/settings/accounts',
      `/settings/access-log?type=login_succeeded&since=${today}&limit=200`,
      `/settings/access-log?type=login_failed&since=${today}&limit=200`,
      '/status',
      '/summary',
    ];

    const warm = (): void => {
      for (const path of paths) {
        void fetch(path, { headers: { accept: 'application/json' } })
          .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
          .then((body) => {
            if (body !== null) prefetchedGets.set(path, { at: Date.now(), body });
          })
          .catch(() => {
            /* the panel will fetch it live — exactly as it does today */
          });
      }
    };

    // Behind the bundle warm above, which is itself behind the dashboard's: three idle passes
    // against the district's one server, in the order a seat actually needs them.
    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (typeof idle === 'function') idle(warm, { timeout: 4000 });
    else window.setTimeout(warm, 2500);
  }

  /** Open the dashboard, saying so if the file could not be fetched. */
  async function showDashboard(): Promise<void> {
    const error = el('dashError');
    const screen = await loadDashboard();

    if (screen === null) {
      error.hidden = false;
      error.textContent =
        'Could not load the dashboard. It is fetched when first needed, so it needs a ' +
        'connection — the Record and the report form do not, and both still work.';
      return;
    }

    error.hidden = true;
    await screen.show();
  }

  /**
   * The Status screen (M4).
   *
   * `onChanged` refreshes the dashboard's numbers the next time it is opened, so an officer
   * who reports a power cut and switches tabs does not see their own report missing.
   */
  let statusPanel: StatusPanel | null = null;

  // Runs from load, on every screen, signed in or out. See `startClock`.
  startClock();
  // Beside it, and for the same reason: every age on screen counts up on its own between polls,
  // so nothing sits frozen next to a running clock. Costs no request. See `startAges`.
  startAges();
  const piReportView = el('piReportView');

  /**
   * Open one of the office screens, fetching the bundle if this is the first.
   *
   * A failure to arrive is said in words on the screen the operator asked for, rather than
   * left as a tab that does nothing — the same rule every other screen here follows when it
   * cannot reach the server.
   */
  async function openOfficeScreen(which: 'admin' | 'status'): Promise<void> {
    const loaded = await loadOffice();

    if (loaded === null) {
      const error = which === 'admin' ? el('adminError') : el('statusNote');
      error.hidden = false;
      error.textContent =
        'Could not load this screen. It is fetched when first needed, so it needs a connection.';
      return;
    }

    if (which === 'admin') {
      admin ??= loaded.mountAdmin();

      // Arrived from the dashboard's unassigned counter or a department row (M6-15). Consumed
      // here rather than left set, so opening the console normally afterwards does not scroll
      // somebody to a department they were not asking about.
      if (pendingConsoleDepartment !== undefined) {
        const departmentName = pendingConsoleDepartment;
        pendingConsoleDepartment = undefined;
        admin.showDepartment(departmentName);
        return;
      }

      admin.show();
      return;
    }

    /**
     * Two screens here, not three. **"My department" was the third and it is gone**
     * (2026-08-06, the owner's instruction, under ADR-0018).
     *
     * It mounted the same `mountRoster` the console uses, through a second door, for a
     * department officer looking at their own people. There are no department officers.
     *
     * `mountRoster` itself is untouched and still exported by `office.js` — the control room
     * reaches **every** department's roster through it from the console. What went is one
     * caller, not the component.
     */
    statusPanel ??= loaded.mountStatus({ onChanged: () => void dashboard?.show() });
    await statusPanel.show();
  }

  interface BoardRow {
    incidentId: string;
    status: string;
    /** The four-stage view of `status`, decided by the server (M9-25). */
    stage: string;
    severity: string;
    assessed: boolean;
    overriddenFrom: string | null;
    category: string;
    occurredAt: string | null;
    lastRecordedAt: string | null;
    acknowledgedAt: string | null;
    escalationCount: number;
    overdue: boolean;
    overdueByMinutes: number;
    notificationsFailed: number;
    notificationsUndelivered: number;
    responsibleDepartments: string[];
    /**
     * Who was actually told, by name — the district asked for this on the row, 2026-08-23.
     *
     * ⚠️ **Optional, and absent is not "nobody".** An older server simply does not send it,
     * and the row must go on rendering what it always did rather than assert an empty list.
     * See `api/board.ts` for why this is not `responsibleDepartments`.
     */
    toldNames?: string[];
    /** What the officer said when they resolved it. Null or absent until it actually is. */
    resolution?: string | null;
    /**
     * What the district actually told people — 2026-08-23, Phase B.
     *
     * ⚠️ Null or absent means **unknown**, never “nothing was sent” — see `api/board.ts`.
     */
    sentMessage?: { what: string; where: string } | null;
    /** Whether this alert was chased, and whether the chase got through. See `api/board.ts`. */
    followUp?: { note: string; count: number; failed: boolean } | null;
    /**
     * What came back from the people who were told — the Record's "Response", 2026-08-31.
     * Mirrors `BoardRow.response`; passed straight through to `incidentRow.ts`. Null or absent
     * means nobody was dispatched.
     */
    response?: {
      told: number;
      holding: number;
      declined: number;
      silent: number;
      ownerless: boolean;
      latest: { who: string | null; said: string; at: string | null } | null;
      breakdown: {
        who: string | null;
        holding: 'holding' | 'declined' | 'silent';
        said: string | null;
      }[];
    } | null;
    /**
     * Who is coming, when this row asked who is coming — the Case 2 (meeting) work, 2026-09-10.
     * Mirrors `BoardRow.attendance`; passed straight through to `incidentRow.ts`. Null or absent
     * for every emergency, a plain notice and `schedule`.
     */
    attendance?: {
      told: number;
      coming: number;
      answered: number;
      attending: number;
      sendingSomeone: number;
      notAttending: number;
      other: number;
      unanswered: number;
    } | null;
    /** Routing ran and matched nothing. Nobody has this one (ADR-0010). */
    unassigned: boolean;
    /**
     * Whether this is a General communication — M9-11, and read here by M11-03.
     *
     * Optional for the same reason `IncidentRowData` marks it optional: an older server simply
     * does not send it, and absent must mean *emergency*, which is what the board has always
     * assumed. Never write a rule that reads a missing value as "general".
     */
    general?: boolean;
    /** Server-decided flags the district counters lead through — see incidentRow.ts. */
    held: boolean;
    acknowledged: boolean;
    occurredToday: boolean;
    notificationsUnmet: boolean;
    /** Nobody has been chosen to be told about this at all — M6-09. */
    nobodyTold: boolean;
    /** The deadline actually applied to this row, set by the administration (Q-06). */
    targetMinutes: number;
    /** Taken off the board, but not off the record — M10-11/17. Always present. */
    withdrawn: boolean;
    withdrawalReason: string | null;
  }
  /**
   * One narrowing the **server** offers, with the count it lands on — M11-16.
   *
   * ⚠️ **This file must never invent one of these, and never re-derive `count`.** The server
   * sends the `data-` attribute it already wrote onto the row, the value, and how to compare —
   * so the panel holds no rule of its own and a facet reading 4 lands on 4 rows by construction.
   * A count worked out in the browser would be a second implementation of a rule the fold has
   * already applied, and the first one to drift is a number above the wrong rows.
   */
  interface BoardFacet {
    attr: string;
    value: string;
    label: string;
    count: number;
    /** `is` — equals. `has` — one member of a ``-separated list, e.g. two departments. */
    match: 'is' | 'has';
  }
  interface BoardData {
    asOf: string;
    /** Which district day these rows belong to — ADR-0020. Null only on a span export. */
    date: string | null;
    /** The server's Bajaur-time limits for a day view of the Record. */
    recordWindow?: { from: string; to: string };
    /** A working limit was reached; the rows cannot be presented as the whole answer. */
    truncated?: boolean;
    summary: {
      open: number;
      unacknowledged: number;
      /**
       * How many are at `Issued` — the district's own first word, and what the strip prints.
       *
       * ⚠️ **Not `unacknowledged` under a new name.** That figure excludes a General
       * communication (M11-02); this one counts every incident at that stage, which is what the
       * wall counts. They differ by exactly the notices, and `board.ts` carries the reasoning.
       */
      issued: number;
      overdue: number;
      worst: string | null;
      unassessed: number;
      notificationsUnmet: number;
      unassigned: number;
      /**
       * **Live emergencies nobody was ever chosen to be told about — M6-09, drawn by M11-09.**
       *
       * The server has sent this since M6 and this file never read it: the strip's *nobody told*
       * tile was fed `unassigned` instead, which is a different question with a different fix.
       */
      nobodyTold: number;
      /** Over today's rows before they were dropped, so it can never disagree with the board. */
      withdrawn: number;
    };
    /** What the board can be narrowed by — M11-16. Counted in the fold that made the rows. */
    facets: {
      severity: BoardFacet[];
      /** Beside the severities, never among them — ADR-0009. */
      unassessed: BoardFacet;
      kind: BoardFacet[];
      stage: BoardFacet[];
    };
    incidents: BoardRow[];
  }

  let boardTimer: ReturnType<typeof setInterval> | null = null;
  /** When the board last actually reached the server. Not when we last tried. */
  let boardFetchedAt: number | null = null;

  /** Beyond this the board is openly called stale rather than shown as if it were live. */
  const BOARD_STALE_MS = 30_000;

  /**
   * One figure on the board's context strip — M11-06/07.
   *
   * **This used to be `tally()`, and the difference is the whole task.** It returned a bare
   * `<div>`: seven of the district's own numbers sat across the top of the screen an operator
   * works in for a whole shift, and **nothing anywhere listened for a click on any of them** —
   * `boardSummary` appeared exactly twice in this file, once to bind the element and once to
   * `replaceChildren` it. The *same* seven numbers on the Dashboard have led straight to their
   * own rows since M4. The machinery was built, proven, and never wired to the screen it
   * describes.
   *
   * `flag` names a key of `FLAG_FILTERS`, or `open`, which is the board itself and therefore
   * clears the filter rather than applying one. A segment with no `flag` is a figure that is not
   * a set — `worst assessed` is a *value*, and there is no such thing as "the rows that are
   * high".
   *
   * ⚠️ **A figure reading zero is drawn, and is not clickable.** Both halves are deliberate and
   * both are already this product's own rule (`districtKeys.e2e.test.ts`): a zero that opens a
   * board saying *"nothing matches"* answers a question the figure had already answered, and
   * teaches that these numbers lead somewhere unreliable — expensive for the one that matters at
   * 02:00. It is still **drawn**, because on a wall the absence of a figure and a figure reading
   * zero are not the same statement (ADR-0005).
   */
  /**
   * Which half of the strip a figure belongs to — the deck's own split, in one band.
   *
   * `queue` is where the work stands; `attention` is what is waiting on a person. They are two
   * questions and `board.ts` already keeps them apart: a stage cannot say a message failed
   * (INV-03) or that nobody has assessed it (ADR-0009), so folding those in beside `issued`
   * would be seven undifferentiated words again.
   *
   * ⚠️ **A group is presentation and decides nothing.** It changes which side of one rule a tile
   * sits on and how loud its label is; every figure, every filter and every count is the
   * server's, exactly as before.
   */
  const ATTENTION: ReadonlySet<string> = new Set([
    'unassessed',
    'unmet',
    'nobodytold',
    'unassigned',
  ]);

  function segment(
    kind: string,
    label: string,
    value: string,
    flag: 'open' | keyof typeof FLAG_FILTERS | null,
  ): HTMLElement {
    const clickable = flag !== null && value !== '0';
    const box = document.createElement(clickable ? 'button' : 'span');
    box.className = 'seg';
    box.dataset['kind'] = kind;
    box.dataset['group'] = ATTENTION.has(kind) ? 'attention' : 'queue';
    // Tone is carried by the figure and only when there is something to carry — a strip with
    // "0 past deadline" permanently in red is a strip nobody reads on the night it says 4. The
    // word beside it never changes, so nothing is being said by colour alone (INV-04).
    box.dataset['zero'] = String(value === '0' || value === 'none');
    if (clickable) {
      (box as HTMLButtonElement).type = 'button';
      box.dataset['flag'] = flag;
      // Says where it goes before it is clicked rather than after — the dashboard's counters
      // already carry exactly this, and `districtKeys.e2e.test.ts` requires it of them.
      box.setAttribute('aria-label', `Show ${flag === 'open' ? 'the whole board' : label}`);
    }
    const strong = document.createElement('b');
    strong.textContent = value;
    const word = document.createElement('span');
    word.className = 'segl';
    word.textContent = label;
    box.append(strong, word);
    return box;
  }

  /**
   * A slice of the board, chosen on the dashboard.
   *
   * Applied in the browser rather than by asking the server for a narrower board. The board
   * is already loaded and capped at 500 rows; a second endpoint taking a filter would be a
   * second definition of what the board contains, and the two would drift.
   */
  /**
   * The flags the dashboard's district counters lead through.
   *
   * Each names a `data-` attribute the **server** set on the row, so a counter reading 5 lands
   * on 5 rows. None of these is a predicate this file works out for itself — that would be a
   * second implementation of a rule the counter already applied, and the first one to drift
   * would put a number on the district's home screen that its own board disagrees with.
   */
  const FLAG_FILTERS = {
    /**
     * ⚠️ **`unassigned` is gone from this table — 2026-08-18.** It was the department figure, and
     * nothing links to it any more: the deck dropped it on 2026-08-17 and the board's strip on
     * 2026-08-18, both on the owner's instruction. A filter no figure leads to is a rule nothing
     * draws, which this project has already paid to delete twice.
     *
     * **`unacknowledged` stays and is deliberately not removed with it.** It is off the strip
     * (the `issued` segment says the same thing in the district's own word) but it is still a
     * true server-side figure with a real row flag behind it — unlike the department one, which
     * was removed because the district does not act on it.
     */
    unacknowledged: { attr: 'unacknowledged', want: 'true', label: 'not yet acknowledged' },
    today: { attr: 'today', want: 'true', label: 'reported today' },
    unmet: { attr: 'unmet', want: 'true', label: 'where a message failed' },
    // M6-09. Distinct from `unmet`, which is a message that failed: this is an emergency where
    // no message was ever owed, because nobody was chosen to be told.
    nobodyTold: { attr: 'nobodytold', want: 'true', label: 'with no one chosen' },
    /**
     * Everybody answered and every one of them declined — RX-03, 2026-08-25.
     *
     * Reads `data-ownerless`, which `incidentRow.ts` writes from the server’s own flag. No
     * predicate is expressed here, deliberately, and for `stageIssued`’s reason: the question
     * *is anybody holding this* is answered once, in `domain/ownership.ts`, off the officers’ own
     * words — and a second copy in the browser is the first one to drift.
     */
    ownerless: { attr: 'ownerless', want: 'true', label: 'nobody has taken' },
    // Both server-set already, and both are counted over exactly the rows they mark — M11-07.
    // `overdue` has carried its attribute since the board was built and nothing ever led to it.
    overdue: { attr: 'overdue', want: 'true', label: 'past their deadline' },
    unassessed: { attr: 'unassessed', want: 'true', label: 'not yet assessed' },
    /**
     * **The three stages — 2026-08-17, narrowed from four 2026-09-04, and they are the wall's
     * main row now.**
     *
     * Each reads `data-stage`, which the server decided (`stageOf`) and `incidentRow.ts` writes.
     * No predicate is expressed here, deliberately: a stage is a **word the server chose**, and
     * re-deriving it from a status in the browser would be the second implementation this table's
     * own `unacknowledged` note exists to warn about.
     *
     * `stageAcknowledged` was the middle of four and is gone with the word: ADR-0034 means
     * confirming receipt is no longer a distinct act from responding, so what used to be
     * `acknowledged` now reads `issued` — see `domain/stages.ts`'s header on the server.
     */
    stageIssued: { attr: 'stage', want: 'issued', label: 'still to be answered' },
    stageResponded: { attr: 'stage', want: 'responded', label: 'somebody is working on' },
    stageResolved: { attr: 'stage', want: 'resolved', label: 'resolved today' },
  } as const;

  type FlagKind = keyof typeof FLAG_FILTERS;

  let boardFilter: {
    kind: 'category' | 'department' | 'facet' | FlagKind;
    /** What the rows are matched on — the stored code, e.g. `rta`. */
    value: string;
    /** What the operator is told, e.g. "Road accident". Never the code. */
    label: string;
    /**
     * Set only for `kind: 'facet'` — the attribute and comparison **the server chose** (M11-16).
     *
     * Carried rather than looked up, so this file never maps a facet's name onto an attribute.
     * That mapping is the second implementation this milestone keeps deleting.
     */
    facet?: { attr: string; match: 'is' | 'has' };
  } | null = null;

  /**
   * **Arriving from the Dashboard means arriving AT the emergency — not near it.**
   *
   * The district asked for this in one sentence: *clicking on the Dashboard has to land me on
   * the alert, not wander.* Until now every dashboard panel led to the **top of the Record** —
   * a date picker, a From/To pair, the staleness clock, the red banner and a seven-figure strip
   * — with the row that was actually clicked somewhere below all of it. The number was right,
   * the filter was right, and the operator still had to hunt for the thing they had just
   * pointed at. At 02:00 that hunt is the whole cost of the screen.
   *
   * Set by the dashboard links, spent by `landOnFiltered()` on the **first render after the
   * fetch returns** — never on the render already on screen, which holds the previous board and
   * would land somebody on a row the figure did not count.
   */
  let pendingLanding = false;

  /**
   * Put the operator on what they clicked, once the rows for it have arrived.
   *
   * **One match opens.** A counter reading *1* leading to a list of one is a click the screen
   * made somebody spend to be told what the counter already said. Anything else selects the
   * first row and brings the queue under the eye — the same selection `j`/`k` moves, so `Enter`
   * opens it and nothing new had to be learnt.
   *
   * ⚠️ **Spent whether or not anything matched.** A filter that landed on nothing has already
   * said so in the chip (`applyBoardFilter`); leaving the flag set would let the next
   * ten-second poll yank a reading operator onto a row that arrived afterwards.
   *
   * ⚠️ **Only the Dashboard sets it.** The strip's own segments are on this screen and under
   * the pointer — scrolling the board out from under somebody who just clicked a figure on it
   * is the M11-07 defect, in the other direction.
   */
  function landOnFiltered(): void {
    if (!pendingLanding) return;
    pendingLanding = false;

    const rows = Array.from(boardRows.querySelectorAll<HTMLElement>('.row')).filter(
      (r) => !r.hidden,
    );
    if (rows.length === 0) return;

    const only = rows.length === 1 ? rows[0]?.dataset['incident'] : undefined;
    if (only !== undefined && only !== '') {
      void openDetail(only);
      return;
    }

    // `start`, not `nearest`: the point is to put the queue at the top of the screen, past the
    // strip and the banner that pushed it down. `selectRow` scrolls `nearest` for the keyboard,
    // which would leave the first row exactly where it already was.
    selectRow(rows[0]);
    boardTable.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /**
   * Which segment of the context strip is the view currently standing in — M11-07.
   *
   * Presentation only, and it is the answer to *"why am I looking at nine rows when the board
   * says seventeen?"* — a question an operator otherwise answers by clearing the filter to find
   * out, which loses their place. `open` is marked when nothing is applied, because the whole
   * live board **is** what that figure counts.
   */
  function paintStripState(): void {
    for (const seg of Array.from(boardSummary.querySelectorAll<HTMLElement>('.seg'))) {
      const flag = seg.dataset['flag'];
      if (flag === undefined) continue;
      const on = boardFilter === null ? flag === 'open' : flag === boardFilter.kind;
      seg.dataset['on'] = String(on);
      seg.setAttribute('aria-pressed', String(on));
    }
  }

  function applyBoardFilter(): void {
    const bar = el('boardFilter');
    const rows = Array.from(boardRows.querySelectorAll<HTMLElement>('.row'));

    if (boardFilter === null) {
      bar.hidden = true;
      for (const row of rows) row.hidden = false;
      paintStripState();
      // Clearing is a view change too, so the link stops describing a narrowing nobody is in.
      writeView();
      return;
    }

    bar.hidden = false;
    paintStripState();
    // The URL follows the screen — M11-17. Kept current so it can be copied; never pushed, so
    // four clicks in a row do not become four entries in an operator's Back button.
    writeView();

    const flag =
      boardFilter.kind in FLAG_FILTERS ? FLAG_FILTERS[boardFilter.kind as FlagKind] : null;

    const what =
      flag !== null
        ? flag.label
        : boardFilter.kind === 'facet'
          ? boardFilter.label
          : boardFilter.kind === 'category'
            ? boardFilter.label
            : `what is with ${boardFilter.label}`;

    let shown = 0;
    for (const row of rows) {
      /**
       * ⚠️ Every branch reads an attribute the **server** wrote. None derives a predicate.
       *
       * The `facet` branch is the newest and is the only one that does not name its attribute
       * here at all — the server sent it (M11-16), so a facet counting 4 lands on 4 rows without
       * this file knowing what *critical* or *acknowledged* mean.
       */
      const facet = boardFilter.facet;
      const match =
        flag !== null
          ? row.dataset[flag.attr] === flag.want
          : facet !== undefined
            ? facet.match === 'has'
              ? (row.dataset[facet.attr] ?? '').split('').includes(boardFilter.value)
              : (row.dataset[facet.attr] ?? '') === boardFilter.value
            : boardFilter.kind === 'category'
              ? row.dataset['category'] === boardFilter.value
              : // ⚠️ `told`, not `departments` — ADR-0030. The panel this opens counts OFFICERS
                // (ADR-0029) and the kind is still called `department` on purpose: it is written
                // into the URL, and renaming it would break every link somebody has already
                // copied out of the address bar. What changed is which attribute it reads.
                (row.dataset['told'] ?? '').split('').includes(boardFilter.value);

      row.hidden = !match;
      if (match) shown += 1;
    }

    /**
     * "Nothing matches" is only said once there is a board to match against.
     *
     * Arriving from the dashboard, this runs before the board's own fetch has returned, so
     * there are no rows yet — and saying "nothing matches Fire" at that moment is a false
     * statement shown at the exact instant somebody is looking for a fire. It resolves a
     * second later, which is worse than useless: it teaches people to distrust the message
     * when it is true.
     *
     * A filter that genuinely hides everything still has to say so, because that looks
     * identical to a quiet district (ADR-0005).
     */
    /**
     * **The chip says how much was narrowed away, not only what was narrowed to — M11-08.**
     *
     * `9 of 17` is the sentence that stops a filtered board being mistaken for the district. A
     * chip reading *"Showing only: not yet acknowledged"* is true and still leaves an operator
     * reading eight rows as though they were the whole of Bajaur — which is INV-02's failure
     * arriving through presentation rather than through staleness.
     *
     * `rows.length` is the board's own row count, not the summary's figure, and deliberately so:
     * it is the denominator of what is **on this screen**, which is the only thing the numerator
     * was counted out of.
     */
    if (shown === 0 && rows.length > 0) {
      el('boardFilterText').textContent =
        `Nothing on the Record matches ${boardFilter.label} — it may already be resolved.`;
    } else {
      // No count until there is a board to count out of — the same race the guard above is
      // about. `0 of 0` is not a false statement about Bajaur, but it is a meaningless one, and
      // it appears at exactly the moment somebody is waiting to see whether their filter worked.
      el('boardFilterText').textContent =
        rows.length === 0
          ? `Showing only: ${what}`
          : `Showing only: ${what} — ${String(shown)} of ${String(rows.length)}`;
    }
  }

  /** Open the board narrowed to one slice. Called from the dashboard. */
  function showBoardFiltered(kind: 'category' | 'department', value: string, label: string): void {
    // Arriving from a Dashboard figure is a question about TODAY — that is the period the
    // figure counted. Landing on the Record's still-open view would show more rows than the
    // number that was clicked, which is the counter-and-rows disagreement M11-06 exists to
    // refuse, arriving through the one door that had not been closed.
    boardOpenOnly = false;
    boardFilter = { kind, value, label };
    // Land on it, not above it. `showView` refetches; `landOnFiltered` spends this on the
    // render that fetch produces.
    pendingLanding = true;
    showView('board');
    applyBoardFilter();
  }

  /**
   * Everything about a row that is worth drawing an eye to, as a comparable string — everything
   * **except** what drifts on its own as the clock runs.
   *
   * `overdueByMinutes` climbs by one every sixty seconds for any row that is already overdue,
   * with nothing having happened. Comparing rendered text (or the raw row data) without
   * excluding it means the board would flash *every already-overdue row at once* whenever a
   * refresh happens to straddle a minute boundary — found by watching two real tabs, where a
   * single new incident lit up the entire board, not the one row that actually changed.
   * `overdue` itself stays in the comparison: crossing from "not yet" to "overdue" is real news.
   */
  function meaningfulSignature(row: IncidentRowData): string {
    const meaningful: Partial<IncidentRowData> = { ...row };
    delete meaningful.overdueByMinutes;
    return JSON.stringify(meaningful);
  }

  /**
   * Reconcile the board's rows in place, by incident id, instead of tearing every row down and
   * rebuilding the list on every refresh.
   *
   * This is what `/board/live` (the SSE push) is actually for. A push that still triggers
   * `boardRows.replaceChildren(...everything)` would make the board *flicker faster*, which is
   * a worse screen than the one it replaced — a control room's eye is on this for a whole
   * shift, and a full repaint draws attention to every row, including the ones nobody touched.
   *
   * **The row is always kept numerically current** — its "5d ago" and "past deadline" text is
   * rebuilt on every call, poll or push, so nothing on screen is ever stale text sitting next
   * to a "Live as of…" banner claiming otherwise. **The `.updated` flash is separate, and only
   * fires when `meaningfulSignature` actually differs** — so the clock advancing does not read
   * as news, and an operator's eye is drawn only to rows where something genuinely happened.
   *
   * ---
   *
   * 🔴 **This function could not reorder the board, and it had not been able to since M8.**
   * Found by rendering the table and reading it: the header said `AGE ↑` above rows that were
   * plainly in the queue's own order. The server was right — `?sort=age` returns age order, and
   * a direct probe of the route confirmed it before anything here was touched. Two faults, and
   * they hid each other:
   *
   * 1. **`existing.outerHTML !== fresh.outerHTML` was always true.** `existing` carries
   *    `data-sig`, written on a previous pass; `fresh` had not been given one yet at the moment
   *    of the comparison. So the "nothing meaningful changed" branch fired for **every row on
   *    every poll**, and node identity — the thing this whole function exists to preserve — was
   *    never actually preserved.
   * 2. **Both replace branches used `replaceWith`, which puts the new node exactly where the old
   *    one was.** Position was only ever corrected in the final `else if`, which fault 1 made
   *    unreachable. So the board rendered every row's *content* correctly and its *order* not at
   *    all.
   *
   * Invisible until now, and that is why it survived: before this milestone the only things that
   * changed row order were a new arrival (which takes the insert path and is placed correctly)
   * and an escalation, which is rare and moves one row. **A sort control makes reordering the
   * ordinary case**, and the defect became the whole feature failing silently.
   *
   * The shape now is: decide *which node* represents this incident, then **place it at its index
   * unconditionally**. Position is no longer one branch's responsibility.
   */
  function applyBoardRows(
    container: HTMLElement,
    incidents: readonly IncidentRowData[],
    at: number,
  ): void {
    const existingById = new Map<string, HTMLElement>();
    for (const node of Array.from(container.children) as HTMLElement[]) {
      const id = node.dataset['incident'];
      if (id !== undefined) existingById.set(id, node);
    }

    const seen = new Set<string>();

    incidents.forEach((rowData, index) => {
      seen.add(rowData.incidentId);
      const existing = existingById.get(rowData.incidentId);
      const signature = meaningfulSignature(rowData);

      /** Which node stands for this incident after this pass — new, replaced, or the one there. */
      let node: HTMLElement;

      if (existing === undefined) {
        // A genuinely new row — the "look here" flash.
        node = incidentRow(rowData, at);
        node.classList.add('entering');
        node.dataset['sig'] = signature;
      } else if (existing.dataset['sig'] !== signature) {
        // Something an operator should notice changed.
        node = incidentRow(rowData, at);
        node.classList.add('updated');
        node.dataset['sig'] = signature;
        existing.replaceWith(node);
      } else {
        const fresh = incidentRow(rowData, at);
        /**
         * ⚠️ **Stamped BEFORE the comparison, and that one line is fault 1 above.** `existing`
         * carries `data-sig` from an earlier pass and `data-sig` is part of `outerHTML`, so
         * comparing an unstamped `fresh` against it could never report "the same" — every row
         * was replaced on every poll, and node identity was never preserved at all.
         */
        fresh.dataset['sig'] = signature;
        if (existing.outerHTML !== fresh.outerHTML) {
          // Nothing meaningful changed, but the rendered text did — the "ago" clock, or an
          // overdue counter ticking. Swapped in quietly: correct on screen, no flash to justify.
          node = fresh;
          existing.replaceWith(fresh);
        } else {
          // Byte-identical. Keep the node that is already there, which is the whole point.
          node = existing;
        }
      }

      /**
       * **Position, for every row, whatever happened above** — and this is fault 2.
       *
       * `replaceWith` puts the new node exactly where the old one was, so a board whose *order*
       * changed but whose rows were replaced for any reason stayed in its old order for ever.
       * Correcting position inside one branch made it that branch's private responsibility;
       * doing it here makes it the function's.
       */
      if (container.children[index] !== node) {
        container.insertBefore(node, container.children[index] ?? null);
      }
    });

    // Whatever is left in `existingById` was on screen and is not in the fresh list at all —
    // closed, or scrolled out of the board's own window. Gone, not merely unmatched.
    for (const [id, node] of existingById) {
      if (!seen.has(id)) node.remove();
    }
  }

  const boardNarrow = el('boardNarrow');
  const boardFacets = el('boardFacets');
  const boardNarrowToggle = el<HTMLButtonElement>('boardNarrowToggle');

  boardNarrowToggle.addEventListener('click', () => {
    const open = boardFacets.hidden;
    boardFacets.hidden = !open;
    boardNarrowToggle.setAttribute('aria-expanded', String(open));
    boardNarrowToggle.textContent = open ? 'Hide' : 'Narrow';
  });

  /**
   * Saved views, in the URL — M11-17.
   *
   * ## What a saved view is, and the line it may not cross
   *
   * ⚠️ **A saved view is presentation and never authority (INV-05).** It narrows what is drawn
   * from what the seat could already see; it can never widen it. Everything below is applied to
   * rows the server has already scoped and sent — a link cannot ask for another department's
   * board, because the board it lands in was fetched with the recipient's own session and the
   * server decided its contents before any of this ran.
   *
   * That is a property of *where* this is applied, not of the parsing, which is why the parsing
   * is allowed to be permissive: anything unrecognised is dropped rather than rejected, and the
   * operator gets the whole board — the safe direction.
   *
   * ## Why a restored facet is checked against the server's own list
   *
   * `narrow=facet:severity:critical` names an attribute, and the URL is written by whoever sends
   * the link. Left unchecked, that would make the URL a **second** source for the one thing
   * M11-16 exists to keep in one place: which attribute a count belongs to. It cannot leak
   * anything — a facet only ever hides rows — but it could draw a chip saying *critical* over
   * rows selected by something else, which is the same lie one layer down.
   *
   * So a facet from a URL is only applied if the board's own `facets` payload contains it. The
   * server still chooses the attribute; the link only chooses which of the server's offers to
   * take.
   *
   * ## Why `replaceState` and not `push`
   *
   * Clicking four figures in a row should not put four entries in the operator's Back button on
   * a screen they are scanning. The URL is a description of what is on screen, kept current so
   * it can be copied — not a trail.
   */
  const VIEW_PREFIX = '#board?';

  /** A facet asked for by a URL, held until a board arrives that can confirm it exists. */
  let pendingFacet: { attr: string; value: string } | null = null;

  function writeView(): void {
    if (boardView.hidden) return;

    const params = new URLSearchParams();
    if (boardSort !== null) params.set('sort', `${boardSort.desc ? '-' : ''}${boardSort.key}`);
    if (boardTable.dataset['density'] === 'compact') params.set('density', 'compact');

    if (boardFilter !== null) {
      const f = boardFilter.facet;
      params.set(
        'narrow',
        f !== undefined
          ? `facet:${f.attr}:${boardFilter.value}`
          : boardFilter.kind === 'category' || boardFilter.kind === 'department'
            ? `${boardFilter.kind}:${boardFilter.value}`
            : `flag:${boardFilter.kind}`,
      );
    }

    const qs = params.toString();
    const next = qs === '' ? '#board' : `${VIEW_PREFIX}${qs}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  /** What the current URL asks for. Anything unrecognised is simply absent. */
  function readView(): URLSearchParams | null {
    const hash = location.hash;
    if (!hash.startsWith('#board')) return null;
    const q = hash.indexOf('?');
    return new URLSearchParams(q === -1 ? '' : hash.slice(q + 1));
  }

  /**
   * Apply what the URL asks for, before the first fetch.
   *
   * Sort goes into the query the board is about to make, which is the one piece of a saved view
   * the **server** sees — and it is already validated there: an order `BOARD_SORTS` does not
   * contain is a 400, by the same rule `?date=` follows. So a crafted `sort` cannot become a
   * board; it becomes an error.
   */
  function applyViewBeforeFetch(): void {
    const params = readView();
    if (params === null) return;

    const sort = params.get('sort');
    if (sort !== null && sort !== '') {
      const desc = sort.startsWith('-');
      boardSort = { key: desc ? sort.slice(1) : sort, desc };
    }

    if (params.get('density') === 'compact') {
      boardTable.dataset['density'] = 'compact';
      boardDensity.setAttribute('aria-pressed', 'true');
      boardDensity.textContent = 'Comfortable';
    }

    const narrow = params.get('narrow');
    if (narrow === null || narrow === '') return;

    const [kind, ...rest] = narrow.split(':');
    const value = rest.join(':');

    if (kind === 'flag' && value in FLAG_FILTERS) {
      const flag = FLAG_FILTERS[value as FlagKind];
      boardFilter = { kind: value as FlagKind, value, label: flag.label };
    } else if ((kind === 'category' || kind === 'department') && value !== '') {
      boardFilter = { kind, value, label: value };
    } else if (kind === 'facet') {
      const at = value.indexOf(':');
      if (at > 0) {
        // Held, not applied. The board's own facet list is what confirms this is a narrowing
        // the server offered rather than one the link invented — see the note above.
        pendingFacet = { attr: value.slice(0, at), value: value.slice(at + 1) };
      }
    }
  }

  /** Confirm a URL's facet against the ones the server actually sent, then apply it. */
  function applyPendingFacet(data: BoardData): void {
    if (pendingFacet === null) return;
    const asked = pendingFacet;
    pendingFacet = null;

    const offered = [
      ...data.facets.severity,
      data.facets.unassessed,
      ...data.facets.kind,
      ...data.facets.stage,
    ].find((f) => f.attr === asked.attr && f.value === asked.value);

    // Not one of the server's offers — so it is not applied, and the operator gets the whole
    // board rather than a chip describing a selection nobody made. The safe direction.
    if (offered === undefined) return;

    boardFilter = {
      kind: 'facet',
      value: offered.value,
      label: offered.label,
      facet: { attr: offered.attr, match: offered.match },
    };
    applyBoardFilter();
  }

  /**
   * The faceted panel — M11-16.
   *
   * ## What this function is not allowed to do
   *
   * It does not count anything, and it does not know what any of these words mean. Each facet
   * arrives from the server carrying the `data-` attribute the same fold wrote onto the rows,
   * the value, and how to compare — so clicking one narrows to exactly the rows it counted, by
   * construction rather than by two implementations agreeing. A `count` computed here, or an
   * attribute chosen here from the facet's name, would rebuild the defect this milestone has
   * now removed three times (the strip's figures, the dashboard's counters, the officer panel).
   *
   * **A facet reading zero is drawn and is not clickable**, exactly as the strip's segments are,
   * and for the reason ADR-0005 gives: at 02:00 the absence of the word *critical* and
   * *"critical 0"* are two different statements, and only one of them answers the question.
   */
  function renderFacets(data: BoardData): void {
    const groups: { title: string; note?: string; facets: BoardFacet[] }[] = [
      // Severity and *not assessed* in one group but never as one list — the heading says
      // severity, and the last entry says it was never assessed, which is not a severity
      // (ADR-0009). Keeping them adjacent is what stops somebody reading the bands as the whole
      // board when a third of it has never been looked at.
      { title: 'severity', facets: [...data.facets.severity, data.facets.unassessed] },
      { title: 'stage', facets: data.facets.stage },
      { title: 'kind', facets: data.facets.kind },
      // ⚠️ The `department` group is gone — ADR-0031, phase 4. The board does not narrow by a
      // word this product no longer uses, and migration 0039 left its facet list empty anyway.
    ];

    while (boardFacets.firstChild !== null) boardFacets.firstChild.remove();

    for (const group of groups) {
      if (group.facets.length === 0) continue;

      const section = document.createElement('section');
      section.className = 'fgroup';

      const head = document.createElement('h4');
      head.textContent = group.title;
      section.append(head);

      if (group.note !== undefined) {
        const note = document.createElement('p');
        note.className = 'fnote';
        note.textContent = group.note;
        section.append(note);
      }

      for (const facet of group.facets) {
        const clickable = facet.count > 0;
        const box = document.createElement(clickable ? 'button' : 'span');
        box.className = 'facet';
        box.dataset['zero'] = String(!clickable);

        const word = document.createElement('span');
        word.className = 'fl';
        word.textContent = facet.label;
        const n = document.createElement('b');
        n.textContent = String(facet.count);
        box.append(word, n);

        if (clickable) {
          const button = box as HTMLButtonElement;
          button.type = 'button';
          // Says where it goes before it is clicked, like the strip and the dashboard's
          // counters — `districtKeys.e2e.test.ts` requires exactly this of those.
          button.setAttribute('aria-label', `Show ${facet.label}`);
          const on =
            boardFilter?.kind === 'facet' &&
            boardFilter.facet?.attr === facet.attr &&
            boardFilter.value === facet.value;
          box.dataset['on'] = String(on);
          button.setAttribute('aria-pressed', String(on));
          button.addEventListener('click', () => {
            // Clicking the one already applied clears it — the same gesture back out, so
            // nobody has to find "Show all" to undo a click they just made.
            boardFilter = on
              ? null
              : {
                  kind: 'facet',
                  value: facet.value,
                  label: facet.label,
                  facet: { attr: facet.attr, match: facet.match },
                };
            applyBoardFilter();
            renderFacets(data);
          });
        }

        section.append(box);
      }

      boardFacets.append(section);
    }

    // Offered only once there is a board to narrow. A panel of zeros above an empty queue is a
    // control that cannot do anything, which is worse than one that is not there yet.
    boardNarrow.hidden = data.incidents.length === 0;
  }

  function renderBoard(data: BoardData): void {
    const at = Date.parse(data.asOf);
    paintBoardTruncation(data);

    /**
     * The context strip — M11-06…09. Every figure the board can honestly narrow to, in one
     * line, each one leading to exactly the rows it counted.
     *
     * **INV-04 survives the compression, and that is the constraint that shaped the line.**
     * `worst assessed` and `not yet assessed` stay **two figures in words**, never folded into
     * one (ADR-0009) — a strip that read *"worst: critical (3 unknown)"* would be the aggregate
     * hiding a critical in the one place the invariant is most tempting to break, because the
     * space is tight.
     */
    boardSummary.replaceChildren(
      segment('open', 'open', String(data.summary.open), 'open'),
      /**
       * **The strip speaks the district's four words now — 2026-08-18, and it removes a figure
       * rather than only renaming two.**
       *
       * The owner asked for the wall's vocabulary to be true everywhere. It read
       * `unacknowledged · nobody reached · nobody told · nobody has it`, which is three of the
       * four names he could not tell apart on the deck, still side by side on the screen an
       * operator works in for a whole shift.
       *
       * | Was | Is | Why |
       * |---|---|---|
       * | `unacknowledged` | **`issued`** | the district's own first word (M9-25) |
       * | `nobody reached` | **`message failed`** | INV-03 said in the words the deck uses |
       * | `nobody told` | **`no one chosen`** | the same set, the wall's name for it |
       * | `nobody has it` | **gone** | the department figure, taken off the wall 2026-08-17 |
       *
       * **`nobody has it` is removed rather than renamed, and that is the owner's decision
       * carried through.** It read `unassigned` — true of **31 of Bajaur's 40** incidents, because
       * ADR-0018 makes departments a directory the control room picks from rather than an
       * audience. A figure red four rows in five is one nobody reads. `summary.unassigned` is
       * still sent, still on every row, and still in the export and the console: this takes it
       * off the **operational** strip, which is not the same as deleting it.
       *
       * ⚠️ **`issued` is a NEW server figure, not `unacknowledged` relabelled** — see
       * `board.ts`. A General notice is issued and is never unacknowledged, so the cheap rename
       * would have put one word on two screens over two different numbers.
       *
       * **Seven segments where there were eight**, so `board.e2e` test 16's one-band requirement
       * at 1920×1080 gets easier rather than harder.
       */
      segment('issued', 'issued', String(data.summary.issued), 'stageIssued'),
      segment('overdue', 'past deadline', String(data.summary.overdue), 'overdue'),
      // Two numbers, never one. An unassessed report is not a severity level, and folding
      // it into one would hide either it or the criticals beside it (ADR-0009, INV-04).
      //
      // `worst` is the one figure on the strip that leads nowhere, and it is not an oversight:
      // it is a **value**, not a set. "Show me the rows that are `high`" is a category filter and
      // the board already has one; "show me the worst" is not a question rows can answer.
      segment(
        data.summary.worst === 'critical' ? 'worst-critical' : 'worst',
        'worst assessed',
        data.summary.worst ?? 'none',
        null,
      ),
      segment('unassessed', 'not yet assessed', String(data.summary.unassessed), 'unassessed'),
      // INV-03, on the board, in words: "a message that did not reach the duty officer
      // surfaces as an unmet obligation, not as a log line."
      segment('unmet', 'message failed', String(data.summary.notificationsUnmet), 'unmet'),
      /**
       * **M11-09: `nobody told` and `nobody has it` are two figures, because they are two
       * questions with two different fixes.**
       *
       * This strip carried one tile labelled *nobody told* and fed it `summary.unassigned` —
       * the wrong number under the right words, and `board.ts`'s own comment says plainly they
       * are not the same question. `summary.nobodyTold` had been sent by the server since M6-09
       * and **rendered nowhere on this screen at all**.
       *
       * - **nobody told** — no recipient was ever chosen. An operator fixes it from this screen
       *   in ten seconds: open it, pick who should know.
       * - **nobody has it** — no department is responsible. `held` is not the negation of
       *   `unassigned` and the filter follows `held`, exactly as the dashboard's counter does.
       *
       * The banner above still reads `unassigned`, deliberately unchanged: this settles what the
       * *strip* says, and moving the loudest line on the board is a separate decision with its
       * own wording history (see `boardUnassigned` below).
       */
      segment('nobodytold', 'no one chosen', String(data.summary.nobodyTold), 'nobodyTold'),
    );

    // The panel, from the same payload — M11-16. Redrawn on every board paint so its counts move
    // with the queue rather than going stale beneath it, which is INV-02 applied to a control.
    renderFacets(data);
    // A facet asked for by the URL is confirmed against the offers that just arrived, then
    // applied — M11-17. Never before: until this payload exists there is nothing to confirm it
    // against, and an unconfirmed facet is the URL choosing an attribute the server should own.
    applyPendingFacet(data);
    writeView();

    /**
     * Above everything, because an emergency nobody has been told about is not low priority —
     * it is one nobody is coming to.
     *
     * **The sentence changed on 2026-08-06 and the old one is worth remembering.** It read:
     * *"N emergencies have no department. The routing signals matched nothing — assign them,
     * and add a signal so the next one goes straight through."*
     *
     * Both halves had stopped being true. Routing is no longer the mechanism — the control
     * room chooses recipients and choosing **places** the emergency (M6) — so the signals
     * "matching nothing" describes the district's own workflow as damage. And *add a signal*
     * sends an operator to a settings screen for a problem M7 solved: the system learns who
     * they usually tell and pre-ticks them.
     *
     * This is the **third** copy of that advice. The dashboard's button and the department
     * cards' red line went earlier the same day, and the loudest one — top of the board, above
     * every row — was left standing. Say what the operator does, on the screen they are on.
     */
    /**
     * 🔴 **THIS LINE COUNTED THE WRONG NUMBER FROM THE DAY IT WAS WRITTEN — fixed 2026-08-18.**
     *
     * It says *"N that nobody has been told about"* and it read **`summary.unassigned`**, which
     * is the **department** question: *the routing signals placed this nowhere*. `board.ts`'s own
     * comment has said for months that the two are not the same question, and M11-09 split them
     * on the strip below while deliberately leaving this banner alone as *"a separate decision
     * with its own wording history"*. It was the same decision, and it was not made.
     *
     * **Measured on the live record before the change: 31 where the honest answer is 12.** Every
     * emergency the control room dispatched to an officer **by name** was being announced, in the
     * loudest position on the board, as one nobody had been told about — and since M10-07/08/09
     * that is most of Bajaur's traffic. The sentence then tells the operator to *"open it and
     * choose who should know"*, about an emergency they have already chosen for.
     *
     * `summary.nobodyTold` is what the words describe, and it is already the figure the wall's
     * `No one chosen` tile and this screen's own strip segment both count — so all three now
     * agree by reading one number rather than by three people remembering to.
     */
    //
    // ⚠️ **`boardRowsVisible` is not decoration here.** The board keeps refreshing while
    // Summary is open, and this line ran on every one of those refreshes — so the loudest
    // banner on the Record redrew itself over a screen of figures that does not carry it,
    // seconds after `setRecordView` had hidden it. Same guard, same reason, as
    // `paintBoardTruncation`. Returning to Rows re-runs this render and puts it back.
    boardUnassigned.hidden = !boardRowsVisible || data.summary.nobodyTold === 0;
    if (data.summary.nobodyTold > 0) {
      const n = data.summary.nobodyTold;
      /**
       * **The noun follows what is actually there — M11-03.**
       *
       * This sentence said *"N emergencies"* about whatever `unassigned` counted, and a General
       * communication can be counted: a meeting notice routing placed nowhere made the loudest
       * line on the board announce an emergency that does not exist. The district learns quickly
       * what a red banner is worth, and this is the one that must keep its meaning at 02:00.
       *
       * **`emergencies` is kept wherever it is true**, deliberately, rather than replaced with a
       * neutral word everywhere. That is the sharpest word available and this banner is where it
       * belongs; softening every case to protect the rare one would cost more than the lie did.
       *
       * ⚠️ **Choosing a noun from `general` is presentation, not a re-derived rule.** The flag is
       * the server's own (`isGeneral`, resolved in `board.ts`), and `incidentRow.ts` already
       * switches a severity word for a kind chip off exactly this value. Nothing here decides
       * *what counts* — `summary.unassigned` is untouched, and which rows it counts is still
       * entirely the server's answer.
       */
      const anyGeneral = data.incidents.some((r) => r.nobodyTold && r.general === true);
      const noun = anyGeneral
        ? n === 1
          ? 'report'
          : 'reports'
        : n === 1
          ? 'emergency'
          : 'emergencies';
      /**
       * Built as three nodes rather than one string — Phase E.
       *
       * ⚠️ **`textContent` IS BYTE-FOR-BYTE WHAT IT WAS, and that is not a coincidence.**
       * `admin.e2e` asserts this banner's wording and M11-03 asserts its noun, both by reading
       * the element's text — and `textContent` concatenates descendants with no separator, so
       * the space after the count lives INSIDE the sentence node. Split it the obvious way and
       * the board announces `5emergencies` to two green suites.
       */
      const count = document.createElement('span');
      count.className = 'ucount';
      count.textContent = String(n);

      const say = document.createElement('span');
      say.className = 'usay';
      const doThis = document.createElement('span');
      doThis.className = 'udo';
      doThis.textContent = `Open ${n === 1 ? 'it' : 'one'} and choose who should know — that is what gives it to them.`;
      say.append(document.createTextNode(` ${noun} that nobody has been told about. `), doThis);

      boardUnassigned.replaceChildren(count, say);
    }

    /**
     * **"N withdrawn today"** — M10-40, and it is what makes M10-17 safe to have shipped.
     *
     * Zero-suppressed, deliberately: a permanent "0 withdrawn" is a line people learn to stop
     * reading, the same argument `board.ts`'s own comment makes about this count. The toggle's
     * label always reflects `showWithdrawn`, not the count, so a room that has already opened
     * the withdrawn rows and then watches the last one get restored still sees "Hide withdrawn"
     * rather than a control that silently flipped itself off.
     */
    boardWithdrawn.hidden = data.summary.withdrawn === 0 && !showWithdrawn;
    boardWithdrawnText.textContent =
      data.summary.withdrawn === 0
        ? 'Nothing withdrawn today.'
        : `${String(data.summary.withdrawn)} withdrawn today.`;
    boardWithdrawnToggle.textContent = showWithdrawn ? 'Hide withdrawn' : 'Show withdrawn';

    // Reconciled by incident id, not torn down and rebuilt — see `applyBoardRows`. A control
    // room's eye is on this screen for a whole shift; a full repaint every time anything
    // anywhere changed was the board visibly flickering for rows nobody touched.
    applyBoardRows(boardRows, data.incidents, at);

    boardEmpty.hidden = data.incidents.length > 0;
    boardFetchedAt = Date.now();
    paintBoardAge(data);

    // The board polls every ten seconds. A repaint that forgot the filter would silently
    // widen the view under somebody's eye, mid-read.
    applyBoardFilter();
    // Only ever after the rows the server sent have been filtered — and only when somebody
    // arrived here from the Dashboard. Costs nothing on the other ~360 renders an hour.
    landOnFiltered();
    // Painted after the rows the server sent, never when the header was clicked — see
    // `paintSortState`. The arrow describes the order that arrived.
    paintSortState();

    // Update real-time Search & Count header
    try {
      const countEl = document.getElementById('boardResultsCount');
      if (countEl) {
        countEl.textContent = `Showing ${data.incidents.length} Incident${data.incidents.length === 1 ? '' : 's'}`;
      }
      const quickSearch = document.getElementById('boardQuickSearch') as HTMLInputElement | null;
      if (quickSearch && !quickSearch.dataset['bound']) {
        quickSearch.dataset['bound'] = 'true';
        quickSearch.addEventListener('input', () => {
          const q = quickSearch.value.trim().toLowerCase();
          const rows = Array.from(boardRows.querySelectorAll<HTMLElement>('.row'));
          let visible = 0;
          for (const r of rows) {
            const text = r.textContent?.toLowerCase() ?? '';
            const match = q === '' || text.includes(q);
            r.style.display = match ? '' : 'none';
            if (match) visible++;
          }
          const cnt = document.getElementById('boardResultsCount');
          if (cnt) cnt.textContent = `Showing ${visible} Incident${visible === 1 ? '' : 's'}`;
        });
      }
    } catch {
      // Safe fallback
    }
  }

  /**
   * A queue cut at its working limit must not look like a complete Record.
   *
   * This is deliberately a sentence above the rows, not a tiny count in the footer: an operator
   * decides what is absent before they decide what to open, and the safe answer is to narrow the
   * question with Find rather than assume an older incident is not there.
   */
  function paintBoardTruncation(data: BoardData | null): void {
    const truncated = boardRowsVisible && !findActive && data?.truncated === true;
    boardTruncated.hidden = !truncated;
    boardTruncated.textContent = truncated
      ? 'This Record view reached its working limit and may omit older rows. Use Find to narrow the question before relying on this list as complete.'
      : '';
  }

  let lastBoard: BoardData | null = null;

  /**
   * Say how old this is, always, and say it loudly once it is old.
   *
   * INV-02 in the one place it is easiest to violate: a board that keeps showing its last
   * good data during an outage, with no indication, is worse than a blank screen — someone
   * decides not to send a crew because the screen says a crew is already going.
   */
  function paintBoardAge(data: BoardData | null): void {
    if (data === null || boardFetchedAt === null) {
      boardAsOfText.textContent = 'Loading…';
      return;
    }
    const age = Date.now() - boardFetchedAt;
    const stale = age > BOARD_STALE_MS;
    boardAsOf.dataset['stale'] = String(stale);
    boardAsOfText.textContent = stale
      ? `NOT LIVE — last reached the server ${Math.round(age / 1000)}s ago. Do not act on this without checking.`
      : `Live as of ${new Date(data.asOf).toLocaleTimeString()}`;
  }

  /**
   * Read once, on the first fetch — M11-17.
   *
   * Deliberately here rather than at start-up. `boardFilter` and `boardSort` are `let` bindings
   * declared further down this file, and a restore running during the synchronous boot would
   * read them in the temporal dead zone. The first refresh is the earliest moment everything a
   * view refers to actually exists, and it is still before any row has been drawn.
   */
  let viewRestored = false;

  async function refreshBoard(): Promise<void> {
    if (!viewRestored) {
      viewRestored = true;
      applyViewBeforeFetch();
    }
    try {
      /**
       * Closed rows are asked for only when the filter in force is about a day rather than a
       * queue.
       *
       * "Reported today" counts everything that happened today, including what was dealt with
       * by lunchtime — so arriving from that counter and being shown only what is still open
       * would land on fewer rows than the number that was clicked. Every other view is a
       * working queue, where yesterday's closed incidents are in the way.
       */
      // `today` and `stageResolved` are the two slices that need rows the default fetch drops:
      // both are about work that is finished, and a finished emergency is not on the live board.
      // A figure that leads to "nothing matches" is the defect M11-A1 was written to remove.
      const wantsClosed = boardFilter?.kind === 'today' || boardFilter?.kind === 'stageResolved';
      const query = new URLSearchParams();
      /**
       * ⚠️ **`open` and `date` are never sent together** — the server answers 400 rather than
       * choosing, because *"the whole record, newest first"* and *"this Tuesday"* are two
       * questions and a caller sending both has lost track of which it is asking.
       *
       * `closed` is not sent here either, and does not need to be: `?open=1` is the Record's
       * own view, and since 2026-09-06 the server folds open and closed alike into it. `open`
       * is a historical param name for *this whole-record view* — see `server.ts`.
       */
      if (boardOpenOnly) query.set('open', '1');
      else {
        if (wantsClosed) query.set('closed', '1');
        if (boardDay !== null) query.set('date', boardDay);
      }
      if (showWithdrawn) query.set('withdrawn', '1');
      // M11-11. `-` reverses. The Record opens on `-recorded` (most recently entered first,
      // 2026-09-06); "Queue order" sets this back to null, the server's triage order — what
      // every other caller of `buildBoard` still gets.
      if (boardSort !== null) query.set('sort', `${boardSort.desc ? '-' : ''}${boardSort.key}`);
      const qs = query.toString();
      const res = await fetch(qs === '' ? '/incidents' : `/incidents?${qs}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        // Signed out or holding no seat. Say so rather than showing an empty district.
        boardAsOf.dataset['stale'] = 'true';
        const problem = (await res.json().catch(() => ({}))) as { error?: string };
        boardAsOfText.textContent =
          res.status === 401
            ? 'Signed out — sign in to see the district board.'
            : res.status === 403
              ? 'You hold no duty seat, so there is no board to show.'
              : (problem.error ?? 'Could not load this Record view.');
        boardRows.replaceChildren();
        boardEmpty.hidden = true;
        paintBoardTruncation(null);
        return;
      }
      lastBoard = (await res.json()) as BoardData;
      if (lastBoard.recordWindow !== undefined) {
        boardDate.min = lastBoard.recordWindow.from;
        boardDate.max = lastBoard.recordWindow.to;
      }

      /**
       * The server says which day this is; the control follows it.
       *
       * Set from the response rather than from what was asked for, so the box can never show a
       * date the rows do not belong to — including the very first load, where nothing was asked
       * for at all and only the server knows what Bajaur's today is.
       */
      const shown = lastBoard.date ?? null;
      if (shown !== null) {
        boardDate.value = shown;
        // Only when there is something to go back to. A button permanently offering "today"
        // while you are already on today is a button that stops being read.
        boardToday.hidden = boardDay === null;
      }

      /**
       * **Say which period this is, always** — ADR-0020's rule, and the Record's own view (every
       * record, newest first) is the one thing on this screen that is not a day.
       *
       * The date input is emptied rather than left holding whatever day was last looked at: a
       * control showing `19 Aug` above a list spanning two years is the screen naming a day it
       * is not showing, which is the exact confusion that rule exists to refuse.
       */
      boardScopeNote.hidden = !boardOpenOnly;
      if (boardOpenOnly) {
        boardScopeNote.textContent = 'Every record, newest first — not one day';
        boardDate.value = '';
        boardToday.hidden = true;
      }
      paintScope(shown);

      renderBoard(lastBoard);
      // Say whose view this is, by name (M0-34). The same endpoint and the same projection
      // serve both — the scoping falls out of the seat, so a department board is not a
      // second query that could disagree with the district one. What differs is the label.
      /**
       * ⚠️ **Keyed on `tier`, not on `departmentId` — M11-04.**
       *
       * `evaluateRead` gives a **district-tier** seat every incident in Bajaur (`as: 'override'`).
       * This label asked a different question — *is this seat department-agnostic?* — and the two
       * offices that run the district are not: AC HQ Bajaur holds its own department id, so a
       * board carrying **the whole district** was labelled *"Assistant Commissioner Bajaur"* and
       * read as *this is only my office's work*. An operator who believes that stops looking at
       * the rest of the district on the one screen that is showing it to them.
       *
       * This is the same fault the M5 security review found in `viewerFor`, in the harmless
       * direction: there, `departmentId === null` was read as *the district* and widened what a
       * seatless caller could see. **An absent value is not a scope.** The fix is the same one —
       * key on the tier the database derives, which says what the null only implied.
       */
      /**
       * ⚠️ **`'your department'` NAMED A THING THAT NO LONGER EXISTS — ADR-0030.**
       *
       * The fallback was right while a registry could be incomplete: a seat whose department
       * was missing from it had a real configuration fault, and *"your department"* was the
       * honest placeholder for a name we ought to have had. Migration 0039 dropped the table,
       * so `departmentName` is null for every non-district seat for ever and the placeholder
       * became the permanent label — a board headed with a scope its reader does not have.
       *
       * What that board actually holds now is what this seat was told about, so that is what
       * it is called. It is the same phrase as the acknowledge guard and the report's gap
       * line, which is deliberate: one idea, one wording, wherever the district meets it.
       *
       * ⚠️ **Still keyed on `tier`, never on an absent id.** *An absent value is not a scope*
       * — the M5 review's finding in `viewerFor`, where `departmentId === null` was read as
       * *the district* and widened what a seatless caller could see.
       */
      boardScope.textContent =
        identity === null
          ? ''
          : identity.tier === 'district'
            ? 'district-wide'
            : 'what you were told about';
    } catch {
      // Offline. Keep what is on screen — and make sure it is labelled for what it is.
      paintBoardAge(lastBoard);
    }
  }

  function showBoard(show: boolean): void {
    showView(show ? 'board' : 'report');
  }

  function showView(
    view:
      | 'report'
      | 'board'
      | 'detail'
      | 'admin'
      | 'settings'
      | 'dashboard'
      | 'status'
      | 'piReport'
      | 'help',
  ): void {
    dashboardView.hidden = view !== 'dashboard';
    statusView.hidden = view !== 'status';
    reportView.hidden = view !== 'report';
    boardView.hidden = view !== 'board';
    detailView.hidden = view !== 'detail';
    adminView.hidden = view !== 'admin';
    settingsView.hidden = view !== 'settings';
    // `#reportsView` is a VIEW OF THE RECORD now (Phase 5), not a screen of its own — it is
    // shown and hidden by `setRecordView`, and leaving the Record hides it with the section
    // around it. A line here would fight that switch on every navigation.
    piReportView.hidden = view !== 'piReport';
    helpView.hidden = view !== 'help';

    // Detail is reached from the board or the inbox, so whichever tab you came from stays
    // current while reading one.
    navReport.setAttribute('aria-current', view === 'report' ? 'page' : 'false');
    navBoard.setAttribute('aria-current', view === 'board' || view === 'detail' ? 'page' : 'false');
    navAdmin.setAttribute('aria-current', view === 'admin' ? 'page' : 'false');
    navSettings.setAttribute('aria-current', view === 'settings' ? 'page' : 'false');
    navDashboard.setAttribute('aria-current', view === 'dashboard' ? 'page' : 'false');
    navStatus.setAttribute('aria-current', view === 'status' ? 'page' : 'false');
    navHelp.setAttribute('aria-current', view === 'help' ? 'page' : 'false');

    // Polling stops the moment the operator leaves. A background refresh against a screen
    // nobody is looking at is a request the district's one server did not need to serve.
    if (view !== 'dashboard') {
      dashboard?.stop();
      el('ticker').hidden = true;
    }
    if (view === 'dashboard') void showDashboard();
    if (view === 'status') void openOfficeScreen('status');
    // Leaving the Record drops any search back to its own day, so returning to it does not
    // land on results somebody ran twenty minutes ago and has forgotten running.
    if (view !== 'board') leaveFindMode();
    if (view === 'help') void openHelpScreen();
    if (view === 'admin') void openOfficeScreen('admin');
    if (view === 'settings') void openSettingsScreen();

    /**
     * **The queue stays mounted while an incident is open — M11-14.**
     *
     * ⚠️ This block used to tear the board down for **every** view change, `detail` included.
     * That is the fault the plan singles out: opening an incident closed `/board/live`, cleared
     * the poll and unmounted the rows, so the operator lost their place — and worse, **the board
     * behind the pane silently stopped updating** while its own "Live as of…" clock kept ticking
     * beside it. That is INV-02 with the clock still running.
     *
     * `detail` is now part of the board's own life rather than a screen that replaces it. The
     * poll costs one request every ten seconds while somebody reads an incident, which is what
     * the board already costs when it is the visible screen — and coming back to a current queue
     * rather than a stale one is the whole point.
     */
    const boardAlive = view === 'board' || view === 'detail';

    if (!boardAlive) {
      if (boardTimer !== null) clearInterval(boardTimer);
      boardTimer = null;
      closeBoardStream();
    }

    /**
     * **The side pane, decided by CSS and never by reading the viewport — ADR-0013.**
     *
     * `data-pane` says only *an incident is open*. Whether that means a pane beside the queue or
     * a full sheet is a **media query's** answer at 75rem — deliberately the same breakpoint the
     * table uses, so the board has one width at which it becomes a desk screen rather than two
     * that can disagree. The client reads the viewport in exactly one place in this application
     * and this is not it.
     */
    /**
     * **The drawer SLIDES in from the right — 2026-09-01, and it is one forced reflow.**
     *
     * `#detailView.drawer` has carried `transition: transform 0.28s` and a `translateX(100%)`
     * resting position since it was built, but it never played: line ~2876 above takes the
     * section from `display:none` to `display:flex` in the same synchronous pass that sets
     * `data-pane` here, so the browser folds both into one style recalc and the pane simply
     * appears at `translateX(0)`. The Administration drawer slides because `admin.ts` keeps it
     * in the DOM off-screen the whole time and only toggles `.open` — the transform already has
     * a rendered `translateX(100%)` frame to move from.
     *
     * Reading `offsetWidth` once, after the un-hide and before `data-pane`, flushes that frame
     * so the existing transition runs. Nothing else changes: no CSS, no class, no timing.
     */
    if (view === 'detail') void detailView.offsetWidth;
    mainEl.dataset['pane'] = view === 'detail' ? 'open' : 'closed';
    // Kept in the DOM and kept updating; the media query decides whether it is on screen.
    if (view === 'detail') boardView.hidden = false;

    if (view === 'board') {
      void refreshBoard();
      // The poll is the reliability floor, unchanged from before `/board/live` existed — a
      // board that silently stops updating is exactly what the staleness clock above is there
      // to expose, and it must keep working whether or not the stream below ever connects.
      if (boardTimer === null) {
        boardTimer = setInterval(() => {
          void refreshBoard();
          paintBoardAge(lastBoard);
        }, 10_000);
      }
      // The push is purely an accelerant on top of that floor: told the instant something
      // changes, rather than up to ten seconds late. If it never connects, is blocked by a
      // proxy, or the browser doesn't support it, the poll above already covers the board
      // completely — nothing here is load-bearing for correctness, only for speed.
      openBoardStream();
    }
  }

  let boardStream: EventSource | null = null;

  function openBoardStream(): void {
    if (typeof EventSource === 'undefined') return; // every browser this app targets has it
    /**
     * 🔴 **Idempotent, and it was not — M11-14 broke this and the browser tests caught it.**
     *
     * `showView` used to `closeBoardStream()` on **every** view change and reopen on arrival, so
     * this could only ever be called with nothing open. Keeping the board alive across `detail`
     * removed that close — and arriving at the board again then opened a **second** stream, and a
     * third, one per visit, each holding a connection on the district's one server.
     *
     * The visible cost is worse than the leak: every `changed` announcement fired `refreshBoard`
     * once per stream, so the board repainted several times per event and never sat still. Two
     * browser tests timed out clicking a control that was being replaced underneath the pointer,
     * which is exactly what an operator would have experienced.
     */
    if (boardStream !== null) return;
    boardStream = new EventSource('/board/live');
    boardStream.addEventListener('changed', () => {
      void refreshBoard();
    });
    // No manual reconnect logic: EventSource retries on its own using the `retry:` value the
    // server sends, and a connection that never recovers just leaves the 10s poll as the only
    // source of updates — exactly what this screen already did before today.
  }

  function closeBoardStream(): void {
    boardStream?.close();
    boardStream = null;
  }

  // ------------------------------------------------------- the inbox: removed (M7-02)
  //
  // It served seat holders, and settling a message meant one of them opening the app. Nobody
  // outside the control room signs in (ADR-0018), so every obligation it created aged into a
  // permanent unmet one on the board — INV-03 manufacturing false failures rather than showing
  // real ones. The ledger it read is untouched; WhatsApp settles the same events.

  // Registered here rather than beside `showView`, because these consts are declared above
  // and referencing them earlier would be a temporal-dead-zone error at boot.
  navBoard.addEventListener('click', () => {
    /**
     * Clicking "Record" means the Record. A filter left over from a dashboard panel would make
     * the tab show a slice with no explanation of why — and from Phase 4b the same is true of
     * a search somebody ran an hour ago.
     *
     * ⚠️ `showView` only drops find mode when the view actually CHANGES, so pressing the tab
     * while already on this screen would otherwise leave the results standing under a tab that
     * has just promised the whole Record. That is the one path a test found.
     */
    boardFilter = null;
    // Clicking the tab means the Record's own view, not whichever day somebody stepped into an
    // hour ago — the same reasoning that clears the filter one line up.
    boardOpenOnly = true;
    boardDay = null;

    /**
     * 🔴 **`leaveFindMode()` here is NOT redundant, and removing it as "waste" was a bug.**
     *
     * `setRecordView('rows')` **replays** whichever state the Rows view is in — and after a
     * search that state is *find mode*. So dropping this line left the results standing under a
     * tab that had just promised the whole Record: the row was on the page, `#boardTable` was
     * hidden, and the test comparing a found row against the board's own waited out its timeout.
     *
     * This is what resets `findActive`; `setRecordView` then replays the day view rather than
     * the search. The genuine duplication — a second `applyBoardFilter()` and a second
     * `leaveFindMode()` *after* it — is what is gone.
     */
    leaveFindMode();
    setRecordView('rows');
    showView('board');
    void refreshBoard();
  });
  /**
   * **Find, on the Record** — Phase 4b, and the three listeners are three different moments.
   *
   * `focusin` is the one that matters: it is the first sign somebody intends to search, and it
   * is where `search.js` is fetched. Waiting for `submit` would make the first search of a shift
   * sit on a network round trip before it does anything, on a screen whose whole point is that
   * it answers quickly.
   *
   * ⚠️ **The submit listener does NOT run the search.** `mountSearch` owns that and has since
   * M0; this only switches the Record into showing results. Running it here too would be two
   * implementations of one action, and the second would eventually disagree about what was asked.
   */
  el('viewRows').addEventListener('click', () => setRecordView('rows'));
  el('viewSummary').addEventListener('click', () => setRecordView('summary'));
  el('viewDownload').addEventListener('click', () => setRecordView('download'));

  boardFind.addEventListener('focusin', () => {
    void ensureSearchPanel();
  });

  /**
   * **Find is a door — Phase C.**
   *
   * The form stood open on every visit to a screen an operator sits in for a whole shift, to
   * serve a control most openings never touch. Narrow was already collapsed on exactly that
   * reasoning (M11-16); this is the same judgement applied to its neighbour.
   *
   * ⚠️ **It fetches `search.js` on opening rather than waiting for the first keystroke.**
   * Pressing this button IS the intent the `focusin` listener above was inferring, and the
   * panel it opens should be usable the moment it is on screen. That listener stays: it is
   * still the one that fires when somebody tabs into the box from the keyboard.
   */
  const boardFindToggle = el<HTMLButtonElement>('boardFindToggle');
  boardFindToggle.addEventListener('click', () => {
    const open = boardFind.hidden;
    boardFind.hidden = !open;
    boardFindToggle.setAttribute('aria-expanded', String(open));
    boardFindToggle.textContent = open ? 'Hide find' : 'Find';
    if (open) {
      void ensureSearchPanel();
      el<HTMLInputElement>('searchText').focus();
    }
  });

  el('searchForm').addEventListener('submit', () => {
    enterFindMode();
  });

  el('boardFindBack').addEventListener('click', () => {
    leaveFindMode();
    void refreshBoard();
  });

  navReport.addEventListener('click', () => showView('report'));
  navAdmin.addEventListener('click', () => showView('admin'));
  navSettings.addEventListener('click', () => showView('settings'));
  navDashboard.addEventListener('click', () => showView('dashboard'));
  navHelp.addEventListener('click', () => showView('help'));

  /**
   * **The keyboard — M11-15.** `j`/`k` move, `Enter` opens, `Esc` comes back.
   *
   * The 8-hour-a-day pattern: an operator working a queue should not have to reach for a mouse
   * to walk it. Deliberately the shape every queue in the world already uses, so nobody has to
   * be taught it.
   *
   * ⚠️ **It must never capture a key while somebody is typing**, and that is not a nicety: the
   * board carries a date box and a filter chip, and an operator typing `2026-08-1j` into a date
   * field because the board stole the letter would be a screen that fights its own controls.
   * Anything with a text-editing surface is left alone.
   *
   * ⚠️ **Selection is presentation and never authority** (INV-05). It moves through the rows the
   * server sent and the filter left visible — it cannot reach a row that was not drawn, and it
   * grants nothing.
   */
  function typingInto(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (node === null) return false;
    const tag = node.tagName;
    return (
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true
    );
  }

  /** The rows a keystroke can reach: drawn, and not hidden by the filter in force. */
  function walkableRows(): HTMLElement[] {
    return Array.from(boardRows.querySelectorAll<HTMLElement>('.row')).filter((r) => !r.hidden);
  }

  function selectRow(next: HTMLElement | undefined): void {
    if (next === undefined) return;
    for (const row of Array.from(boardRows.querySelectorAll<HTMLElement>('.row[data-on]'))) {
      delete row.dataset['on'];
    }
    next.dataset['on'] = 'true';
    // `nearest` rather than `center`: a queue that jumps under the eye on every keystroke is
    // harder to read than one that scrolls only when it has to.
    next.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('keydown', (event) => {
    if (typingInto(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // Esc comes back from an incident to the queue it was opened from, wherever the pane is.
    if (event.key === 'Escape' && !detailView.hidden) {
      event.preventDefault();
      showView('board');
      return;
    }

    if (boardView.hidden) return;

    const rows = walkableRows();
    if (rows.length === 0) return;
    const current = rows.findIndex((r) => r.dataset['on'] === 'true');

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectRow(rows[current < 0 ? 0 : Math.min(current + 1, rows.length - 1)]);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectRow(rows[current < 0 ? 0 : Math.max(current - 1, 0)]);
      return;
    }
    if (event.key === 'Enter' && current >= 0) {
      const id = rows[current]?.dataset['incident'];
      if (id !== undefined) {
        event.preventDefault();
        void openDetail(id);
      }
    }
  });

  el('boardFilterClear').addEventListener('click', () => {
    boardFilter = null;
    applyBoardFilter();
  });

  /**
   * **The strip's figures lead to their own rows — M11-07.**
   *
   * Delegated to the container because `renderBoard` rebuilds the segments on every poll and
   * every push; a listener bound to a segment would be thrown away on the next refresh and stop
   * responding, silently, some seconds after the screen was opened. Same trap `tilt.ts` records
   * for the dashboard's cards, which is why its listener is on the deck.
   *
   * ⚠️ **It refetches rather than filtering what is on screen**, and that is not laziness. The
   * `today` slice needs closed rows the current fetch did not ask for, and this is the exact
   * path the Dashboard's counters already take (`onOpenFlag`) — one behaviour, reached through
   * two doors, rather than a second one written here that could come to differ.
   */
  boardSummary.addEventListener('click', (event) => {
    const seg = (event.target as HTMLElement | null)?.closest<HTMLElement>('button.seg') ?? null;
    const flag = seg?.dataset['flag'];
    if (flag === undefined) return;
    boardFilter = flag === 'open' ? null : { kind: flag as FlagKind, value: flag, label: flag };
    void refreshBoard();
  });

  /**
   * Search, fetched on first use — the same reasoning as the report screen below.
   *
   * An officer standing at a scene is reporting an emergency, not looking one up. Search needs
   * a connection to be of any use at all, so nothing is lost by fetching it when somebody
   * actually opens it, and the shell stays small enough to arrive on a weak one.
   */
  let searchPanel: { show(): void; reset(): void } | null = null;
  /**
   * The fetch in flight, held rather than its result — `paintIdentity`'s rule for the
   * dashboard prefetch, and it is needed here for the same reason now that there are TWO
   * call sites: `focusin` and the Find button, milliseconds apart when somebody presses the
   * button (it focuses the box itself). `searchPanel` is only assigned once the script has
   * loaded, so a null check alone lets both callers past — and `loadScreen` appends a
   * `<script>` every time it is asked, so the second mount registers a SECOND submit
   * listener and every search after it asks the server twice, all shift, silently.
   */
  let searchLoading: Promise<void> | null = null;

  /**
   * **Fetched the first time somebody types, never when the Record opens** — Phase 4b.
   *
   * The Record is a screen an operator sits in for a whole shift. Loading `search.js` on every
   * open, to serve a control most openings never touch, is the trade `dashboard.ts` already
   * refused in the other direction: *lazy-loading is for screens somebody chooses to open, never
   * for the one they land on* — and the same sentence says a control somebody chooses to use is
   * exactly where a lazy fetch belongs.
   */
  async function ensureSearchPanel(): Promise<void> {
    if (searchPanel === null) {
      searchLoading ??= mountSearchPanel();
      await searchLoading;
      if (searchPanel === null) return;
    }
    searchPanel.show();
  }

  async function mountSearchPanel(): Promise<void> {
    // `false`: there is no `search.css` any more. Its rules moved into the shell with the
    // find controls (Phase 4b), because a form on a shell screen cannot wait for a fetch to
    // become styled.
    const ok = await loadScreen('search', false);
    const factory = (
      window as unknown as {
        DncSearch?: {
          mountSearch: (o: { onOpen: (id: string) => void }) => {
            show(): void;
            reset(): void;
          };
        };
      }
    ).DncSearch;

    if (!ok || factory === undefined) {
      /**
       * ⚠️ **The results region has to be opened for this to be seen at all** — Phase 4b.
       *
       * `#searchError` used to live on a screen of its own; it now sits inside
       * `#boardResults`, which is hidden until a search runs. Unhiding only the sentence left
       * it inside a hidden parent — **the failure that reports itself to nobody**, which is
       * the shape this project has been caught by more than once.
       */
      boardResults.hidden = false;
      const error = el('searchError');
      error.hidden = false;
      error.textContent =
        'Could not load the find controls. They are fetched when first needed, so they need ' +
        'a connection — as does searching the record.';
      /**
       * ⚠️ **A refusal must not become permanent.** The held promise is what stops two
       * callers double-mounting; kept after a failed fetch it would also stop the NEXT press
       * of Find from trying again, on the one screen whose own error sentence says the
       * controls need a connection. Cleared, so pressing it again is a retry.
       */
      searchLoading = null;
      return;
    }
    searchPanel = factory.mountSearch({ onOpen: (id) => void openDetail(id) });
  }

  /**
   * **The Record answers a search instead of a day, and says which it is doing.**
   *
   * The day's table is *replaced*, never sat beside: two lists of incidents on one screen, one a
   * day and one a search, is the "two surfaces describing two periods" confusion this whole
   * milestone exists to remove. The strip, the facets and the reports block go with it — every
   * one of them describes the **day**, and leaving them above a set of search results would put
   * a figure over rows it did not count, which is the M11-06 defect wearing a new hat.
   */
  function enterFindMode(): void {
    findActive = true;
    boardResults.hidden = false;
    boardTable.hidden = true;
    el('boardEmpty').hidden = true;
    boardTruncated.hidden = true;
    el('boardSummary').hidden = true;
    el('boardUnassigned').hidden = true;
    el('boardDay').hidden = true;
    /**
     * The band names the search, because a search is not a period either — ADR-0020's rule
     * applied to the one view that spans every day the record holds.
     *
     * Set here rather than in `search.ts` so the sentence and the two buttons beside it are
     * written by one function: the panel owns *what was searched for*, this owns *what the
     * screen is showing*, and only the second of those is what this band is about.
     */
    el('boardScopeWhat').textContent = 'Search results';
    el('boardAllOpen').setAttribute('aria-pressed', 'false');
    el('boardPickDay').setAttribute('aria-pressed', 'false');
  }

  /**
   * Back to the day. **Called on leaving the Record as well as on the button**, so a search run
   * before lunch is not what greets somebody returning to the screen at four.
   *
   * Deliberately does not clear what was typed: an operator narrowing a search and stepping away
   * to open an incident should come back to their own words, not to an empty box.
   */
  /**
   * **One period, asked two ways** — Phase 5, and one fewer since 2026-09-05.
   *
   * Rows is the list, Summary is the same period as numbers. They are *views* and never
   * screens: a district that has narrowed to the week of the flood reads it and counts it
   * without choosing the week again. Download remains a third view but no longer answers to
   * the shared range at all — it is one fixed export (`#boardExport`, the last 30 days); the
   * per-period file downloads ("The same period, as a file") that used to live there too moved
   * onto Administration → History, at the owner's request.
   *
   * ⚠️ **The date range and the day controls stay on screen in Rows and Summary**, because they
   * are the question both answer. Everything else belongs to exactly one view and is hidden
   * with it — a summary sitting under the day's own strip would put figures over rows they did
   * not count, which is the M11-06 defect this product keeps having to refuse.
   */
  type RecordView = 'rows' | 'summary' | 'download';

  /**
   * Everything that belongs to the Rows view and to no other. **Hidden when Rows is not the
   * view; never blanket-SHOWN when it is** — see `setRecordView`.
   */
  const ROWS_ONLY = [
    'boardFind',
    'boardResults',
    'boardSummary',
    'boardUnassigned',
    'boardTable',
    'boardEmpty',
    'boardTruncated',
    'boardFilter',
    'boardDay',
    /**
     * The scope band belongs to Rows and to no other view.
     *
     * Summary and Download answer *which period* with `#boardRange` — two dates, deliberately
     * shared by all three views — and a live clock, a district scope and a still-open/day
     * picker sitting above them would be a second answer to the same question on the same
     * screen. That is the fault Phase 5 removed when it folded three date controls into one.
     */
    'boardScopeBar',
    /**
     * The find DOOR belongs to Rows too — `boardFind` above is the panel behind it.
     *
     * Both are hidden on the way out; only the door is put back, and whether the panel is
     * reopened is a decision the operator makes again rather than one this file replays.
     */
    'boardFindToggle',
    /**
     * ⚠️ **The two containers the Command Center redesign added, and the reason this list
     * has to be read against the markup rather than trusted (2026-09-08).**
     *
     * This list hides by id. The 2026-08-31 redesign rebuilt the Record's markup into a
     * two-column `admin-split-layout` and a `.viewtools` group — and gave neither an id, so
     * neither could be named here. Summary therefore opened underneath a facet sidebar
     * counting rows it does not show, a search box filtering a table that is not there, a
     * "Showing 24 Incidents" over no incidents, Queue order / Compact for a queue that is
     * gone, and an empty grid column the height of all of it.
     *
     * Naming the CHILDREN would not have fixed it: the wrapper's own `display: grid` is what
     * held the column open. Both carry a `[hidden]` guard in `index.html` because an author
     * `display` beats the UA sheet's `[hidden]` — without it this entry is a no-op.
     *
     * Both are put back explicitly below, like `#boardScopeBar`: on Rows they are always on
     * screen, so asserting them states a fact rather than guessing at one. Everything INSIDE
     * them stays state-driven and is replayed by its own owner — `#boardSortReset` by
     * `paintSortState`, `#boardFindToggle` by the capability paint, `#boardUnassigned` and
     * `#boardTable` by the render that follows.
     */
    'boardSplit',
    'boardTools',
  ];

  function setRecordView(view: RecordView): void {
    boardRowsVisible = view === 'rows';
    /**
     * ⚠️ **Leaving Rows HIDES this list; returning does NOT show it.** That asymmetry is the
     * whole of it, and getting it wrong cost twelve tests.
     *
     * Half of these elements are already state-driven: `#boardResults` is up only during a
     * search, `#boardEmpty` only when there is nothing, `#boardFilter` only when something is
     * narrowed. Unhiding them all on the way back does not restore the view — it asserts a
     * state that may not be true. The first version did exactly that, and because `#boardResults`
     * became visible the line below read it as *a search is running* and hid the day's table,
     * on a screen nobody had searched on. **Restore by re-running the state, never by unhiding.**
     */
    if (view !== 'rows') {
      for (const id of ROWS_ONLY) {
        const node = document.getElementById(id);
        if (node !== null) node.hidden = true;
      }
    }

    el('reportsView').hidden = view !== 'summary';
    el('boardExport').hidden = view !== 'download';

    for (const [id, name] of [
      ['viewRows', 'rows'],
      ['viewSummary', 'summary'],
      ['viewDownload', 'download'],
    ] as const) {
      el(id).setAttribute('aria-pressed', String(view === name));
    }

    if (view === 'rows') {
      /**
       * Put back, explicitly, and that is not a breach of the rule above it.
       *
       * The rule refuses *blanket* unhiding because half of `ROWS_ONLY` is state-driven — a
       * search that may not be running, a banner that may be zero. This band is not: on Rows it
       * is always on screen, so asserting it states a fact rather than a guess. `#boardDay`
       * inside it stays state-driven and is put back by `paintScope`.
       */
      el('boardScopeBar').hidden = false;
      // The two redesign containers, for the same reason and on the same terms — see the note
      // beside them in `ROWS_ONLY`. What sits inside each keeps its own state.
      el('boardSplit').hidden = false;
      el('boardTools').hidden = false;
      // The door, not the panel. Whether the panel is open is something somebody decided, and
      // this function's own rule is that a state is REPLAYED rather than asserted.
      el('boardFindToggle').hidden = !findOffered;
      // The state, replayed. `enterFindMode`/`leaveFindMode` each put the Rows view into one of
      // its two shapes, and both are the same calls the search controls themselves make.
      if (findActive) enterFindMode();
      else leaveFindMode();
      applyBoardFilter();
    }
    if (view === 'summary') void openReportsScreen();
  }

  /** Whether this installation offers the find controls at all (ADR-0016) — see the paint above. */
  let findOffered = false;

  function leaveFindMode(): void {
    findActive = false;
    boardResults.hidden = true;
    boardTable.hidden = false;
    // Put back what leaving the Rows view hid. `#boardEmpty` and `#boardFilter` are deliberately
    // NOT here: both are state-driven, and asserting them would draw "Nothing here." over a full
    // board — see `setRecordView`.
    // `#boardFind` and `#boardUnassigned` are put back by the code that owns them — the
    // capability paint and the board render — on the refresh that follows. Asserting either
    // here would offer a control an installation has switched off, or draw a banner over a
    // figure that is zero.
    boardSummary.hidden = false;
    el('boardSummary').hidden = false;
    // `#boardDay` is put back by `paintScope` on the refresh that follows, because whether it
    // belongs on screen is a fact about the view rather than about find mode — asserting it
    // here would offer a date box in the still-open view, which is what the band is for.
    paintScope(lastBoard?.date ?? null);
    paintBoardTruncation(lastBoard);
    searchPanel?.reset();
  }

  /**
   * Reports, fetched on first use — M11-20, and the same terms as search and the report screen.
   *
   * ⚠️ **`loadScreen('reports', true)` — the second argument fetches `reports.css`.** Get it
   * wrong and the screen renders **unstyled with no error**: it loads, it works, every other
   * test passes, and `contrast.e2e` passes too because black on white is comfortable AA. That
   * failure has this project's worst signature — *the action succeeds* — and
   * `lazyStyles.e2e.test.ts` is the shape of test that catches it.
   */
  let reportsPanel: { show(): void } | null = null;

  async function openReportsScreen(): Promise<void> {
    if (reportsPanel === null) {
      const ok = await loadScreen('reports', true);
      const factory = (
        window as unknown as {
          DncReports?: {
            mountReports: (o: { onOpen: (id: string) => void }) => { show(): void };
          };
        }
      ).DncReports;

      if (!ok || factory === undefined) {
        /**
         * Said in words rather than left as a dead tab — the rule every lazy screen here
         * follows. Reading the record needs a connection whether or not this file arrived.
         *
         * ⚠️ Written into `#reportsView` itself, **not** into a child. The bundle builds this
         * screen's own markup, so when the bundle is the thing that failed there is no
         * `#reportPeriod` to write to — an error handler that reached for one would throw and
         * leave the tab silently blank, which is the failure it exists to prevent.
         */
        reportsView.textContent =
          'Could not load the reports screen. It is fetched when first needed, so it needs a ' +
          'connection — as does reading the record.';
        return;
      }
      reportsPanel = factory.mountReports({ onOpen: (id) => void openDetail(id) });
    }
    reportsPanel.show();
  }

  /**
   * Settings, fetched on first use — ADR-0032 phase 3, the same terms as Reports above.
   *
   * ⚠️ `loadScreen('settings', true)` fetches `settings.css` too. A wrong second argument here
   * renders the panel unstyled with no error and passes every test — `lazyStyles.e2e` is the
   * shape that catches it, and it asserts a property only `settings.css` supplies.
   */
  let settingsPanel: { refresh(): Promise<void>; show(): void } | null = null;

  async function openSettingsScreen(): Promise<void> {
    if (settingsPanel === null) {
      const ok = await loadScreen('settings', true);
      const factory = (
        window as unknown as {
          DncSettings?: { mountSettings: () => { refresh(): Promise<void>; show(): void } };
        }
      ).DncSettings;

      if (!ok || factory === undefined) {
        // Said in words, not left as a dead tab — the rule every lazy screen here follows.
        // Written into `#settingsBody`, which is in the shell, so it survives the bundle itself
        // being the thing that failed to arrive.
        el('settingsBody').textContent =
          'Could not load Settings. It is fetched when first needed, so it needs a connection.';
        return;
      }
      settingsPanel = factory.mountSettings();
    }
    settingsPanel.show();
  }

  /**
   * "Change my password" — ADR-0032, for every account whatever its role.
   *
   * `forced` is a `must_change_password` account: the dialog has no cancel and Esc is refused,
   * and it re-opens until the change goes through. The server (`POST /auth/password`) requires
   * the current password, revokes every other session, and clears the flag — so on success the
   * identity is re-fetched and a forced account is off this screen.
   *
   * Resolves `true` once the password was changed, `false` if a non-forced dialog was cancelled.
   */
  async function changePasswordDialog(forced: boolean): Promise<boolean> {
    const dlg = document.createElement('dialog');
    dlg.className = 'pwdlg';

    const field = (labelText: string, autocomplete: string): HTMLInputElement => {
      const label = document.createElement('label');
      label.className = 'text';
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'password';
      input.setAttribute('autocomplete', autocomplete);
      input.required = true;
      label.append(input);
      form.append(label);
      wirePasswordEye(input);
      return input;
    };

    const form = document.createElement('form');
    const heading = document.createElement('h2');
    heading.textContent = 'Change my password';
    form.append(heading);

    if (forced) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent =
        'An administrator reset this account. Choose a new password to continue — you cannot ' +
        'use the app until you do.';
      form.append(note);
    }

    const current = field('Current password', 'current-password');
    const next = field('New password', 'new-password');
    const confirm = field('New password again', 'new-password');

    const err = document.createElement('p');
    err.className = 'pwerr';
    err.hidden = true;
    form.append(err);

    const actions = document.createElement('div');
    actions.className = 'pwactions';
    if (!forced) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'plain';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => dlg.close('cancel'));
      actions.append(cancel);
    }
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'plain';
    submit.textContent = 'Change password';
    actions.append(submit);
    form.append(actions);
    dlg.append(form);
    document.body.append(dlg);

    // Esc must not dismiss a forced change — there is nowhere else for the account to go.
    if (forced) dlg.addEventListener('cancel', (e) => e.preventDefault());

    return new Promise<boolean>((resolve) => {
      const finish = (changed: boolean): void => {
        dlg.remove();
        resolve(changed);
      };

      dlg.addEventListener('close', () => {
        if (dlg.returnValue !== 'done') finish(false);
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void (async () => {
          err.hidden = true;
          if (next.value !== confirm.value) {
            err.textContent = 'The two new-password boxes do not match.';
            err.hidden = false;
            return;
          }
          submit.disabled = true;
          try {
            const res = await fetch('/auth/password', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                currentPassword: current.value,
                newPassword: next.value,
              }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
              err.textContent =
                typeof body?.error === 'string'
                  ? body.error
                  : 'The password could not be changed — try again in a moment.';
              err.hidden = false;
              submit.disabled = false;
              return;
            }
            dlg.returnValue = 'done';
            dlg.close('done');
            // Other sessions are revoked and the flag is cleared server-side; re-read so the
            // shell stops forcing this and the profile menu is current.
            await loadIdentity();
            finish(true);
          } catch {
            err.textContent = 'Cannot reach the server. Check your connection and try again.';
            err.hidden = false;
            submit.disabled = false;
          }
        })();
      });

      dlg.showModal();
    });
  }

  /**
   * Land a forced account on "change my password" and hold it there.
   *
   * The dialog itself re-opens on Esc; this loop is the guard against the fetch failing — a
   * `false` from a forced dialog only happens if `loadIdentity` did not clear the flag, and
   * re-opening is the honest answer.
   */
  async function enforcePasswordChange(): Promise<void> {
    while (identity?.mustChangePassword === true) {
      const changed = await changePasswordDialog(true);
      if (!changed) return; // network gone — trySync / the next load will bring us back here
    }
  }

  /**
   * The in-product guide, fetched on first use — see `web/src/help.ts`.
   *
   * Everything in it is authored once and never rebuilt, so `show()` after the first call is
   * free — there is nothing here that goes stale between one open and the next the way a board
   * or a dashboard does.
   */
  let helpPanel: { show(): void } | null = null;

  async function openHelpScreen(): Promise<void> {
    if (helpPanel === null) {
      const ok = await loadScreen('help', true);
      const factory = (window as unknown as { DncHelp?: { mountHelp: () => { show(): void } } })
        .DncHelp;

      if (!ok || factory === undefined) {
        const body = el('helpBody');
        body.textContent =
          'Could not load the guide. It is fetched when first needed, so it needs a ' +
          'connection the first time — after that it works with none.';
        return;
      }
      helpPanel = factory.mountHelp();
    }
    helpPanel.show();
  }

  /**
   * Which incident the detail screen is showing.
   *
   * The screen had never needed this: it renders what it fetched and nothing asked it
   * afterwards. The post-incident report does — it is reached *from* an incident, and it
   * has to know which one to fold and which one Back returns to.
   */
  let openIncidentId: string | null = null;

  /**
   * The report screen, fetched the first time somebody asks for one.
   *
   * **Not imported.** It is built as its own file (see `build.mjs`) and kept out of the shell,
   * because the shell is what a field officer downloads at a scene and an officer at a scene
   * has no use for a post-incident report. The shell stood at **159 KB against a 160 KB
   * budget** when this screen was written — the budget existed to make that visible and did,
   * and the answer to it is not a bigger number.
   *
   * A failure to load is said plainly rather than left as a dead button. This screen needs a
   * connection, and so does the report it folds.
   */
  let piReport: { show(incidentId: string): Promise<void> } | null = null;

  /**
   * Fetch a screen that is not part of the shell.
   *
   * Each of these is office work that always has a connection, so nothing is lost by fetching
   * it on first use — and the shell stays the thing a field officer can download at a scene.
   *
   * Returns false rather than throwing. A screen that failed to arrive is a message, not a
   * dead button: the caller says so in words, which is the same rule every other screen here
   * follows when it cannot reach the server.
   */
  async function loadScreen(name: string, withCss: boolean): Promise<boolean> {
    if (withCss && document.getElementById(`${name}Css`) === null) {
      const css = document.createElement('link');
      css.id = `${name}Css`;
      css.rel = 'stylesheet';
      css.href = `/${name}.css`;
      document.head.append(css);
    }

    return new Promise<boolean>((resolve) => {
      const tag = document.createElement('script');
      tag.src = `/${name}.js`;
      tag.onload = () => resolve(true);
      tag.onerror = () => resolve(false);
      document.head.append(tag);
    });
  }

  async function loadReportScreen(): Promise<boolean> {
    if (piReport !== null) return true;
    if (!(await loadScreen('report', true))) return false;

    const factory = (
      window as unknown as {
        DncReport?: { mountReport: () => { show(incidentId: string): Promise<void> } };
      }
    ).DncReport;

    piReport = factory?.mountReport() ?? null;
    return piReport !== null;
  }

  /** The incident whose report is on screen, so Back knows where to return. */
  let piReportFor: string | null = null;

  /**
   * The record tools (Report · Plain text · Correct this · Withdraw) live behind this one
   * button in the footer — 2026-09-06. They are not what an operator opens this screen to do,
   * and on a laptop the reading area needs the height more than four buttons on show. The menu
   * opens upward (`main.css`), closes on a pick, on an outside click, and on Escape. Every
   * button inside keeps its own id, listener and `confirm()` — only its parent moved.
   */
  const detailMoreBtn = el<HTMLButtonElement>('detailMoreBtn');
  const detailMoreMenu = el('detailMoreMenu');
  function closeDetailMore(): void {
    if (detailMoreMenu.hidden) return;
    detailMoreMenu.hidden = true;
    detailMoreBtn.setAttribute('aria-expanded', 'false');
  }
  detailMoreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = detailMoreMenu.hidden;
    detailMoreMenu.hidden = !open;
    detailMoreBtn.setAttribute('aria-expanded', String(open));
  });
  detailMoreMenu.addEventListener('click', () => closeDetailMore());
  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (target !== null && (detailMoreMenu.contains(target) || target === detailMoreBtn)) return;
    closeDetailMore();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDetailMore();
  });

  el('detailReport').addEventListener('click', () => {
    if (openIncidentId === null) return;
    const forIncident = openIncidentId;
    piReportFor = forIncident;
    showView('piReport');

    void (async () => {
      const ready = await loadReportScreen();
      const error = el('piReportError');
      if (!ready || piReport === null) {
        error.hidden = false;
        error.textContent =
          'Could not load the report screen. It is fetched when first needed, so it needs a ' +
          'connection — as does the report it folds.';
        return;
      }
      await piReport.show(forIncident);
    })();
  });
  el('piReportPrint').addEventListener('click', () => window.print());
  el('piReportBack').addEventListener('click', () => {
    if (piReportFor !== null) void openDetail(piReportFor);
    else showView('board');
  });

  navStatus.addEventListener('click', () => showView('status'));
  el('back').addEventListener('click', () => showView('board'));
  document.querySelectorAll('#detailTabs .d-tab').forEach((t) => {
    t.addEventListener('click', () =>
      showDetailTab(t.getAttribute('data-tab') === 'hist' ? 'hist' : 'ov'),
    );
  });
  const detailBackdrop = document.getElementById('detailBackdrop');
  if (detailBackdrop) {
    detailBackdrop.addEventListener('click', (e) => {
      if (e.target === detailBackdrop) showView('board');
    });
  }

  // ------------------------------------------------------- incident detail (M0-35)

  const detailView = el('detailView');
  /**
   * The layout container. Bound rather than queried each time, and it is the only element
   * `showView` touches that is not a screen — see the `data-pane` note there.
   */
  const mainEl: HTMLElement = ((): HTMLElement => {
    const node = document.querySelector('main');
    if (node === null) throw new Error('missing element: main');
    return node;
  })();
  const detailHead = el('detailHead');
  const detailQuick = el('detailQuick');
  const detailValues = el('detailValues');
  const timelineRows = el('timelineRows');

  interface Actor {
    personId: string | null;
    seatId: string | null;
  }
  interface Provenanced<T> {
    value: T;
    setBy: Actor;
    setAt: string;
    overriddenFrom?: {
      value: T;
      setBy: Actor;
      setAt: string;
      reason: string;
      overriddenBy: Actor;
      overriddenAt: string;
    };
  }
  interface DetailEvent {
    eventId: string;
    type: string;
    occurredAt: string;
    recordedAt: string;
    actorPersonId: string | null;
    actorSeatId: string | null;
    sourceChannel: string;
    payload: Record<string, unknown>;
  }
  interface Detail {
    state: {
      incidentId: string;
      status: string;
      /**
       * Always sent — `IncidentState.kind` defaults to `'emergency'` and is never absent, even
       * from a server that predates this field's use on this screen. Read by `hasCategory` so
       * the drawer's heading agrees with the message and the Record row about the same `'other'`
       * — 2026-09-05.
       */
      kind: MessageKind;
      severity: Provenanced<string> | null;
      category: Provenanced<string> | null;
      responsibleDepartmentIds: string[];
      acknowledgedAt: string | null;
      acknowledgedBySeatId: string | null;
      /** The officer who took it, when the event named one. Person leads the post — ADR-0035. */
      acknowledgedByPersonId: string | null;
      escalationCount: number;
      resolution: string | null;
      closureNotes: string | null;
      /** What was wrong with what we sent, and what is true instead — M9-52. */
      correctionReason?: string | null;
      correction?: string | null;
      /** Taken off the board, but not off the record — M10-11/17. Null when it is on it. */
      withdrawnAt?: string | null;
      withdrawalReason?: string | null;
      occurredAt: string | null;
      lastRecordedAt: string | null;
      /** Who the control room chose, and what became of each — M6-08. */
      dispatchedTo: { kind: string; id: string }[];
      dispatchAbsorbed: {
        target: { kind: string; id: string };
        coveredBy: { kind: string; id: string };
      }[];
      contactsOpened: { at: string; channel: string; label: string | null }[];
      notifications: {
        attemptId: string;
        seatId: string | null;
        personId?: string;
        departmentId?: string;
        reason: string;
        state: 'pending' | 'delivered' | 'failed';
        failure?: string;
        via?: 'link' | 'reply' | 'operator' | 'provider';
        said?: string;
        /**
         * **The words that went to this recipient** — 2026-08-24, from `message_sent`.
         *
         * ⚠️ **Absent means UNKNOWN, never "nothing was sent".** Nothing before 2026-08-23
         * carries one and none can be reconstructed: the composer runs off current state, so
         * rebuilding an old message would produce what it *would* say today. See
         * `NotificationAttempt.sent` on the server for the whole of the reasoning.
         */
        sent?: { what: string; where: string };
        attemptedAt: string;
        /** When the attempt settled — what "Taken by" is ordered by. Absent on older attempts. */
        settledAt?: string;
      }[];
    };
    events: DetailEvent[];
    /**
     * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
     *
     * Optional and nullable for the two ordinary reasons: an older server sends no field, and a
     * current one sends null until the numbering sweep reaches the incident.
     */
    reference?: string | null;
    actors: {
      people: Record<string, string>;
      /**
       * `holder` is the officer in a post now, when it has one — so a `post` recipient reads
       * `Imtiaz Ahmad — IT Soft`. Absent for a vacant post and on an older server; provenance
       * (`nameOf`) reads only `title`.
       */
      seats: Record<string, { title: string; tier: string; holder?: string }>;
      /**
       * personId → the post that officer holds now — 2026-09-07. Composed onto the name as
       * `Rustam Khan — DDMA` for a `person` recipient (whatsapp-response-workflow.md §6).
       * **Optional, and absent means an older server**, never "holds no post".
       */
      personSeats?: Record<string, string>;
      /**
       * A department the control room **told**, named — 2026-08-24. Not the same set as
       * `responsibleDepartments`, which is who holds this. **Optional, and absent means an
       * older server**, never "no department was told".
       */
      departments?: Record<string, string>;
    };
    responsibleDepartments: string[];
    responsibleDepartmentIds: string[];
    /**
     * The stage view of `state.status`, decided by the server (M9-25, narrowed to three
     * 2026-09-04 — `acknowledged` is gone with the word, see `domain/stages.ts`'s header).
     *
     * Lower-case — `domain/stages.ts`'s `stageOf` returns exactly these words. Typed as the
     * union rather than `string` so `tsc` catches a comparison against a capitalised literal:
     * the redesigned drawer (2026-09-04) shipped `data.stage === 'Responded'`, which can never
     * match, so every non-closed incident fell to the `else` pill "Awaiting response".
     */
    stage?: 'issued' | 'responded' | 'resolved';
    /**
     * The acknowledgement deadline for this incident, right now — for the Deadline tile
     * (2026-09-04). Optional: an older server sends no field. `carries: false` for a General
     * communication and for anything with no `occurredAt`.
     */
    sla?: {
      carries: boolean;
      targetMinutes: number;
      overdueByMinutes: number;
      lateArrival: boolean;
    };
    /**
     * Who is holding a wide dispatch, off the officers' own words — Option C, 2026-09-10.
     *
     * Optional (an older server sends nothing) and null when nobody was told. The drawer reads
     * `takenBy*` / `respondedAt` in place of the fold's first-tap `acknowledgedBy*` slot **only
     * once `told > 1`** — on a single recipient the two agree, and the slot stays the source so
     * Case 1 is untouched. `takenBy*` and `respondedAt` are null while everyone is still silent
     * and when `ownerless` (answered, nobody holding — reassign).
     */
    response?: {
      told: number;
      holding: number;
      declined: number;
      silent: number;
      ownerless: boolean;
      takenBySeatId: string | null;
      takenByPersonId: string | null;
      takenBySaid: string | null;
      respondedAt: string | null;
    } | null;
    /**
     * Who is coming, when this notice asks who is coming — the Case 2 (meeting) work,
     * 2026-09-10.
     *
     * Optional (an older server sends nothing) and **null for everything that is not asking** —
     * every emergency, a plain notice, `schedule`. When it is present the drawer shows the
     * attendance summary and per-person answers instead of incident `status` / "Taken by" / "The
     * response we received"; when it is null the drawer is exactly as it was. `rows` is every
     * recipient the control room told, in order.
     */
    attendance?: {
      told: number;
      coming: number;
      answered: number;
      attending: number;
      sendingSomeone: number;
      notAttending: number;
      other: number;
      unanswered: number;
      stale: number;
      late: number;
      closesAt: string | null;
      rows: {
        attemptId: string;
        seatId: string | null;
        personId: string | null;
        answer: 'attending' | 'not_attending' | 'sending_someone' | 'other' | 'unanswered';
        said: string | null;
        stale: boolean;
        late: boolean;
      }[];
    } | null;
    /**
     * The saved groups a dispatch on this incident expanded — Case 3, 2026-09-10.
     *
     * Optional (an older server sends nothing) and `[]` for every incident told only by hand.
     * When it carries a group the "Who was told" panel puts its recipient rows under the
     * group's name — *"All Tehsildars — 6 of 8 responded"* — with anybody chosen individually
     * beneath; when it is empty the panel is exactly as it was. Display only: no group entity
     * is in `state`, and nothing here changes who is holding anything.
     */
    recipientGroups?: {
      groupId: string;
      name: string;
      members: { kind: string; id: string }[];
    }[];
  }

  /**
   * Name an actor, leading with the person — ADR-0035.
   *
   * Authority still attaches to the post, not the person (ADR-0004) — that is unchanged. But
   * the district asked to read the officer's name first, because that is who they quote on the
   * telephone; the post follows it. When the two would restate each other — a control-room
   * seat whose holder's name is the seat's name — it is printed once, not as "X — X".
   */
  function nameOf(actor: Actor, actors: Detail['actors']): string {
    const seat = actor.seatId === null ? null : (actors.seats[actor.seatId] ?? null);
    const person = actor.personId === null ? null : (actors.people[actor.personId] ?? null);

    if (seat === null && person === null) {
      // Server-issued events (escalation) carry no actor. Saying so is better than a blank:
      // "nobody did this, the deadline did" is a real and important distinction.
      return 'the system';
    }
    if (person === null) return seat === null ? 'unknown' : seat.title;
    if (seat === null) return person;
    return person === seat.title ? person : `${person} — ${seat.title}`;
  }

  function when(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** A value with the answer to "who set this, when, and what did it replace". */
  function valueBlock(
    label: string,
    prov: Provenanced<string> | null,
    actors: Detail['actors'],
    fallback: string,
  ): HTMLElement {
    const box = document.createElement('div');
    box.className = 'value';
    box.dataset['field'] = label.toLowerCase();

    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;

    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = prov === null ? fallback : prov.value;

    box.append(k, v);

    if (prov !== null) {
      const by = document.createElement('span');
      by.className = 'prov';
      by.textContent = `set by ${nameOf(prov.setBy, actors)} · ${when(prov.setAt)}`;
      box.append(by);

      // ADR-0003, the heart of it: an override never erases what the department entered.
      // Nobody can be blamed for a figure they did not enter, and nobody can quietly
      // rewrite a department's assessment.
      const from = prov.overriddenFrom;
      if (from !== undefined) {
        const was = document.createElement('span');
        was.className = 'was';
        const strong = document.createElement('b');
        strong.textContent = from.value;
        was.append(
          document.createTextNode('was '),
          strong,
          document.createTextNode(
            `, set by ${nameOf(from.setBy, actors)} · overridden by ${nameOf(
              from.overriddenBy,
              actors,
            )} on ${when(from.overriddenAt)} — "${from.reason}"`,
          ),
        );
        box.append(was);
      }
    }

    return box;
  }

  /** The current answer first; provenance remains in the expanded record. */
  function quickValue(label: string, value: string, field: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'value';
    box.dataset['field'] = field;

    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = label;

    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = value;
    box.append(k, v);
    return box;
  }

  /** The human-readable heart of an event, when it has one. */
  function detailOf(event: DetailEvent): string | null {
    const p = event.payload;
    const str = (k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null);

    switch (event.type) {
      case 'reported':
        return `${str('category') ?? 'unknown'} · ${str('severity') ?? 'unknown'}`;
      case 'triaged':
        return `${str('category') ?? ''} · ${str('severity') ?? ''}${
          str('reason') === null ? '' : ` — "${str('reason')!}"`
        }`;
      case 'overridden':
        return `${str('field') ?? ''} → ${str('value') ?? ''} — "${str('reason') ?? ''}"`;
      case 'reassigned':
      case 'reopened':
        return str('reason') === null ? null : `"${str('reason')!}"`;
      case 'routed':
        return str('reason') === null ? null : `"${str('reason')!}"`;
      case 'action_logged':
        return str('note');
      case 'resolved':
        return str('outcome');
      case 'closed':
        return str('notes');
      /**
       * 🔴 **A follow-up that could not be sent looked exactly like one that was.**
       *
       * The timeline prints the event type as its own heading — `followed_up` becomes *followed
       * up* — and that word is the same whether Meta took the message or refused it. With no case
       * here the line fell through to `default: return null`, so the screen showed *followed up*
       * and the operator’s name and **nothing else**: not what was said, not which alert it
       * chased, and not that it never left the building.
       *
       * The post-incident report has said *“Follow-up could not be sent”* since the feature
       * shipped, so the printed document and the screen disagreed about the same act. INV-03 is
       * about a failure being visible **where somebody acts on it**, and nobody acts on a PDF at
       * 02:00 — they are looking at this screen.
       *
       * `note` already carries the operator’s words and the alert being chased, composed by
       * `api/followUp.ts`. This adds no second wording of its own; it only refuses to hide the
       * half that says it failed.
       */
      case 'followed_up': {
        const note = str('note');
        // `delivered` is Meta ACCEPTING it, never the officer reading it (ADR-0014) — so the
        // words say `sent`, not `received`. Absent is treated as sent: only events written
        // before this field existed lack it, and they were all successful sends.
        const sent = p['delivered'] !== false;
        if (sent) return note;
        return note === null ? 'could not be sent' : `could not be sent — ${note}`;
      }
      /**
       * **The words that went out, in the timeline** — 2026-08-24.
       *
       * With no case here this fell through to `default: return null`, so the line read *message
       * sent* and nothing else: the one event in the log that exists purely to record **what was
       * said** was the one event rendering none of it. The district asked *"msg mein kya tha"*
       * and the answer was already in the record, one `case` away from being on screen.
       *
       * Both halves, in the order they reach a handset. Nothing is reworded — `notify.ts` writes
       * what the channel composed, and a screen that rephrased it would be showing an officer a
       * sentence nobody was sent.
       */
      case 'message_sent': {
        const what = str('what');
        const where = str('where');
        if (what === null && where === null) return null;
        return [what, where].filter((part): part is string => part !== null).join(' — ');
      }
      case 'escalated':
        // The reason, when a person gave one - Phase 8c. An escalation tells nobody now, so this
        // line in the timeline is the whole of what happened.
        return [`trigger: ${str('trigger') ?? 'unknown'}`, str('reason')]
          .filter((part): part is string => part !== null)
          .join(' — ');
      default:
        return null;
    }
  }

  /**
   * The three stages, in order — the Stage tile's step bar reads against this (2026-09-04,
   * narrowed from four the same day `acknowledged` stopped being a distinct stage — see
   * `domain/stages.ts`'s header). `domain/stages.ts` owns the mapping from the seven statuses;
   * these are its exact words, so `indexOf(data.stage)` lands on the right segment (it did not
   * while this array was capitalised and `data.stage` is not).
   */
  const STAGE_STEPS = ['issued', 'responded', 'resolved'] as const;

  /**
   * "48 min ago", "2h 14m ago", "3d ago" — the Reported tile and "How it came in" (2026-09-04).
   *
   * The owner asked for the *minutes-ago* reading rather than a wall-clock time: on the one
   * screen a control room quotes over a telephone, "how long has this been running" is the
   * question, and `toLocaleString()` is not the answer. Grows only — which is what is true
   * while nothing fresh has arrived (INV-02, the dashboard's `startAges` rule).
   */
  function relAge(iso: string | null): string {
    if (iso === null) return 'time unknown';
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 24) return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** Overview / History — the drawer's two tabs (2026-09-04). Wired once, in `boot`. */
  function showDetailTab(name: 'ov' | 'hist'): void {
    document.querySelectorAll('#detailTabs .d-tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name));
    });
    el('detailOverview').hidden = name !== 'ov';
    el('detailHistory').hidden = name !== 'hist';
    el('detailView').querySelector('.drawer-body')?.scrollTo({ top: 0 });
  }

  /** A small labelled section in the Overview panel. */
  function dBlock(label: string): { box: HTMLElement; body: HTMLElement } {
    const box = document.createElement('div');
    const l = document.createElement('p');
    l.className = 'd-block-label';
    l.textContent = label;
    const body = document.createElement('div');
    box.append(l, body);
    return { box, body };
  }

  /** A verbatim message, in a quote block — "The alert we sent" / "The response we received". */
  function quoteBlock(text: string, meta: string | null, incoming: boolean): HTMLElement {
    const q = document.createElement('blockquote');
    q.className = incoming ? 'd-msg in' : 'd-msg';
    q.textContent = text;
    if (meta !== null) {
      const m = document.createElement('span');
      m.className = 'd-msg-meta';
      m.textContent = meta;
      q.append(m);
    }
    return q;
  }

  function renderDetail(data: Detail): void {
    const s = data.state;
    el('detailFoot').hidden = false;

    /**
     * 🔴 **Who took a wide dispatch — the officers' own words, not the first tap** — Option C,
     * 2026-09-10.
     *
     * `s.acknowledgedBy*` / `s.acknowledgedAt` is the fold's single slot, filled by whoever
     * answered first — a decline included — so on a message that went to four offices "Taken by"
     * has been naming the office that said *Not Related to Me*. `roll` is the server's
     * `ownershipOf` roll-up; `wide` gates every switch below on `told > 1`, so a single-recipient
     * incident renders exactly as before (the slot and the roll-up name the same office there).
     * `roll` absent = an older server: same fallback, the slot.
     */
    const roll = data.response ?? null;
    const wide = roll !== null && roll.told > 1;
    /** The wide dispatch answered, and nobody is holding it — reassign, do not read "met". */
    const unheld = wide && roll !== null && roll.ownerless;
    /** Who to name as having taken it, and when — the roll-up on a wide dispatch, else the slot. */
    const takenByIds =
      wide && roll !== null
        ? { personId: roll.takenByPersonId, seatId: roll.takenBySeatId }
        : { personId: s.acknowledgedByPersonId, seatId: s.acknowledgedBySeatId };
    const respondedAt = wide && roll !== null ? roll.respondedAt : s.acknowledgedAt;
    /** True once somebody is holding it — the honest "this has been taken", slot or roll-up. */
    const taken = wide && roll !== null ? roll.holding > 0 : s.acknowledgedAt !== null;

    /**
     * 🔴 **When this notice asked who is coming, attendance IS the state** — the Case 2
     * (meeting) work, 2026-09-10.
     *
     * `data.attendance` is non-null only for a `meeting` or an `asksAttendance` notice. Where it
     * is, the "Taken by" tile, the "Responded" row and "The response we received" stop reading
     * the single-answer machinery — a meeting has no owner and every reply counts equally — and
     * read the tally instead: *"3 of 5 coming — 2 attending, 1 sending someone, 2 silent"* and
     * the per-person answers. Every other kind (`att === null`) is byte-for-byte unchanged.
     */
    const att = data.attendance ?? null;
    const gathering = att !== null;
    /** "3 of 5 coming — 2 attending, 1 sending someone, 2 silent" — the sentence every surface reads. */
    const attendanceLine = (a: NonNullable<Detail['attendance']>): string => {
      const parts = [
        a.attending > 0 ? `${a.attending} attending` : '',
        a.sendingSomeone > 0 ? `${a.sendingSomeone} sending someone` : '',
        a.notAttending > 0 ? `${a.notAttending} not attending` : '',
        a.other > 0 ? `${a.other} answered another way` : '',
        a.unanswered > 0 ? `${a.unanswered} silent` : '',
      ].filter((p) => p !== '');
      const head = `${a.coming} of ${a.told} coming`;
      return parts.length === 0 ? head : `${head} — ${parts.join(', ')}`;
    };
    /** The district's word for each attendance answer, for the per-person list. */
    const ATTENDANCE_WORD: Record<
      NonNullable<Detail['attendance']>['rows'][number]['answer'],
      string
    > = {
      attending: 'Attending',
      sending_someone: 'Sending someone',
      not_attending: 'Not attending',
      other: 'Answered',
      unanswered: 'No answer yet',
    };
    /**
     * **`'other'` is not "uncategorised" on every kind — 2026-09-05.** `web/src/main.ts`'s own
     * `TILES` writes the literal category `'other'` on Alert, Advisory, Order, Meeting, Schedule
     * and Information, because none of those tiles ever asks the operator to classify anything —
     * only the seven emergency tiles have a real category. Printing it here read as "this could
     * not be classified" on a drawer whose own `h1` said `ALERT` a moment later in the message
     * quoted below it. `hasCategory` is the one rule `jobs/whatsappChannel.ts` and the Record row
     * (`incidentRow.ts`) already apply, so this heading never disagrees with either.
     */
    const rawCategory = s.category?.value ?? 'unknown';
    const catWord =
      rawCategory === 'unknown' || hasCategory(s.kind, rawCategory)
        ? rawCategory
        : labelFor(s.kind);
    const latestSent = [...s.notifications].reverse().find((n) => n.sent !== undefined)?.sent;

    // ---------------------------------------------------------------- head band
    const eyebrow = document.createElement('p');
    eyebrow.className = 'd-eyebrow';
    eyebrow.textContent = data.reference == null ? catWord : `${catWord} · ${data.reference}`;

    const h2 = document.createElement('h2');
    /**
     * A plain-language title — the owner's complaint was that this read as machine output.
     * The message's own `where` is the location a control room recognises; the category word
     * carries what it is. The stage/status pair moves to the pills below, so the title stays
     * one readable line rather than `rta — Acknowledged · responding`.
     */
    h2.textContent =
      latestSent?.where !== undefined && latestSent.where.trim() !== ''
        ? `${catWord} — ${latestSent.where}`
        : `${catWord} — ${data.stage ?? s.status}`;

    const pills = document.createElement('div');
    pills.className = 'd-pills';
    const addPill = (text: string, tone: 'good' | 'warn' | 'bad' | 'flat'): void => {
      const p = document.createElement('span');
      p.className = `d-pill ${tone}`;
      p.textContent = text;
      pills.append(p);
    };
    if (s.withdrawnAt != null) {
      addPill('Off the Record', 'flat');
    } else if (data.stage === 'resolved' || s.status === 'closed') {
      addPill('Resolved', 'good');
    } else if (data.stage === 'responded') {
      addPill('Responded', 'warn');
    } else {
      // Covers `issued` — which, since 2026-09-04, is also where a merely-confirmed-receipt
      // incident reads: `acknowledged` stopped being a distinct pill the same day it stopped
      // being a distinct stage (`domain/stages.ts`'s header).
      addPill('Awaiting response', 'warn');
    }
    if (
      data.sla?.carries === true &&
      (s.acknowledgedAt === null || unheld) &&
      (data.sla.overdueByMinutes ?? 0) > 0
    ) {
      addPill(`${data.sla.overdueByMinutes} min past deadline`, 'bad');
    }
    if (s.escalationCount > 0) addPill(`Escalated ${s.escalationCount}×`, 'flat');

    const ref = document.createElement('p');
    ref.className = 'd-ref';
    ref.textContent = data.reference ?? 'not yet numbered';

    /**
     * The post-incident report (M1-06), from the incident it describes.
     *
     * Opened in a new tab as plain text rather than rendered here. Two reasons: an operator
     * needs to copy it into whatever their department submits upward (Q-02 made export the
     * point rather than integration), and re-rendering the same fold in a second place is
     * how the screen and the document start disagreeing about the same night.
     */
    const takeReport = document.createElement('button');
    takeReport.type = 'button';
    takeReport.id = 'takeReport';
    takeReport.className = 'act';
    /**
     * "The same report, as plain text" — renamed 2026-08-14.
     *
     * This said "Post-incident report", and so did `#detailReport` six lines above it, while the
     * two did entirely different things: that one opens the report in the app for printing, this
     * one fetches `?format=text` to paste into a message. Two identical labels, two different
     * outcomes, on the screen the authority model exists for.
     *
     * "The same" is doing real work in that sentence — it tells the reader this is not a second
     * report but a second form of the one above, which is the whole distinction the board
     * already draws between "to read and to print" and "as a spreadsheet".
     */
    takeReport.textContent = 'The same report, as plain text';
    takeReport.addEventListener('click', () => {
      window.open(`/incidents/${s.incidentId}/report?format=text`, '_blank', 'noopener');
    });

    /**
     * **Correct this** — M9-52/53. Never "Delete", never "Undo".
     *
     * The button's own wording is the first line of defence against the misunderstanding this
     * whole phase is about, and the confirmation is the second: it says, before anything is
     * recorded, that the message has already reached people and this does not recall it.
     *
     * The confirmation carries the cost; it no longer asks *why* (2026-09-01). The server still
     * demands a reason for `incident.correction` (INV-06 — the actor, the seat and the time are
     * what that invariant turns on), so a fixed one is sent. What the correction should *say*
     * stays an operator's own words: "What is true instead?" is the substance, and it is kept.
     * One native `prompt` for that, because the shell has no dialog and building one costs bytes
     * a field officer downloads to never use — this is a control-room screen (ADR-0018).
     */
    const correctIt = document.createElement('button');
    correctIt.type = 'button';
    correctIt.id = 'correctIncident';
    correctIt.className = 'act';
    correctIt.textContent = 'Correct this';
    correctIt.addEventListener('click', () => {
      if (
        !confirm(
          'Correct what was sent about this?\n\n' +
            'This does NOT unsend anything. Everybody already told still has the original ' +
            'message on their handset — WhatsApp does not recall a delivered message, and ' +
            'neither does this. If it matters, tell them again or ring them.',
        )
      ) {
        return;
      }

      // Optional, deliberately. "Ignore this, we will confirm later" is an honest answer, and
      // demanding a replacement produces invented ones.
      const correction = prompt('What is true instead? Leave this blank if you do not know yet.');

      void (async () => {
        const res = await fetch(`/incidents/${s.incidentId}/correct`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reason: 'Corrected from the console',
            ...(correction === null || correction.trim() === '' ? {} : { correction }),
          }),
        });
        if (res.ok) void openDetail(s.incidentId);
        else {
          const problem = (await res.json().catch(() => ({}))) as { error?: string };
          alert(problem.error ?? 'That could not be recorded.');
        }
      })();
    });

    /**
     * **"Withdraw from the board"** — M10-17. Never "Delete", never "Undo" — the same rule
     * `correctIt` follows, and the confirmation carries the same second sentence: this does not
     * unsend anything. It carries two more the correction confirmation does not need, because
     * withdrawing is a different claim: it does not resolve anything, and it does not touch
     * search or the daily report — see `withdrawal.test.ts`'s own header for why those two
     * surfaces are what keep this from being a delete wearing another name.
     *
     * The confirmation states the cost and no longer asks *why* (2026-09-01). The server still
     * demands a reason for `incident.withdrawal`, so a fixed one is sent — INV-06 turns on the
     * actor, the seat and the time, and all three are still recorded.
     *
     * **Restore** replaces it once withdrawn, in the same slot — a control room reading this
     * screen after taking something off never has to go looking for the way back.
     */
    const isWithdrawn = s.withdrawnAt != null;

    const withdrawIt = document.createElement('button');
    withdrawIt.type = 'button';
    withdrawIt.id = 'withdrawIncident';
    withdrawIt.className = 'act';
    withdrawIt.textContent = 'Withdraw from the Record';
    withdrawIt.addEventListener('click', () => {
      if (
        !confirm(
          'Withdraw this from the Record?\n\n' +
            'This does NOT resolve it and does NOT unsend anything already told. Nothing is ' +
            'deleted: it stays on the daily report and can be shown again at any time. ' +
            'It only leaves the Dashboard and the Record’s ordinary view.',
        )
      ) {
        return;
      }

      void (async () => {
        const res = await fetch(`/incidents/${s.incidentId}/withdraw`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'Withdrawn from the console' }),
        });
        if (res.ok) void openDetail(s.incidentId);
        else {
          const problem = (await res.json().catch(() => ({}))) as { error?: string };
          alert(problem.error ?? 'That could not be recorded.');
        }
      })();
    });

    const restoreIt = document.createElement('button');
    restoreIt.type = 'button';
    restoreIt.id = 'restoreIncident';
    restoreIt.className = 'act';
    restoreIt.textContent = 'Restore to the Record';
    restoreIt.addEventListener('click', () => {
      // No reason, deliberately — see `restored` in `domain/events.ts`. Withdrawing owes an
      // explanation; restoring undoes that and the act carries its own.
      void (async () => {
        const res = await fetch(`/incidents/${s.incidentId}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.ok) void openDetail(s.incidentId);
        else {
          const problem = (await res.json().catch(() => ({}))) as { error?: string };
          alert(problem.error ?? 'That could not be recorded.');
        }
      })();
    });

    detailHead.replaceChildren(eyebrow, h2, pills, ref);

    /**
     * The actions move to the sticky footer (2026-09-04), and since 2026-09-06 into the "More"
     * menu (`#detailMoreMenu`) so the reading area gets the footer's height back. `#detailReport`
     * is a static element there and keeps its own listener; the rest are rebuilt each render
     * because they close over `s.incidentId`. `takeReport` is the plain-text form of the report
     * — kept, because pasting the report into a message is a distinct act from opening it to
     * print (M8-14).
     */
    takeReport.textContent = 'Plain text';
    el('detailMoreMenu').replaceChildren(
      el('detailReport'),
      takeReport,
      correctIt,
      isWithdrawn ? restoreIt : withdrawIt,
    );
    closeDetailMore();

    /**
     * The "Responded" row — or, when this notice asked who is coming, the "Replies" row.
     *
     * A meeting has no single responder and no clock: the row counts how many of the people
     * asked have answered and when the count closes (`att.closesAt`). Every other kind keeps the
     * "Responded" reading — the first office to commit (Option C), 2026-09-04 / 09-10.
     */
    const ack = document.createElement('div');
    ack.className = 'value';
    ack.dataset['field'] = 'acknowledged';
    const ackK = document.createElement('span');
    ackK.className = 'k';
    const ackV = document.createElement('span');
    ackV.className = 'v';
    if (gathering && att !== null) {
      // A meeting has no owner and no acknowledgement clock — the row says how many of the
      // people asked have answered, and when the count closes.
      ackK.textContent = 'Replies';
      ackV.textContent =
        att.told === 0 ? 'nobody asked yet' : `${att.answered} of ${att.told} answered`;
      ack.append(ackK, ackV);
      if (att.closesAt !== null) {
        const by = document.createElement('span');
        by.className = 'prov';
        by.textContent = `count closes ${when(att.closesAt)}`;
        ack.append(by);
      }
    } else {
      // Reads "Responded", not "Acknowledged" — 2026-09-04. The field underneath
      // (`acknowledgedAt`) is still the moment the SLA/escalation clock stopped; `data-field`
      // stays `acknowledged` and nothing reads the word off it. On a wide dispatch this is the
      // first office to COMMIT, not the first to tap (Option C); `unheld` — everyone answered
      // and none can take it — is neither "not yet" nor a time.
      ackK.textContent = 'Responded';
      ackV.textContent = unheld
        ? 'nobody has taken it'
        : respondedAt === null
          ? 'not yet'
          : when(respondedAt);
      ack.append(ackK, ackV);
      if (!unheld && (takenByIds.seatId !== null || takenByIds.personId !== null)) {
        const by = document.createElement('span');
        by.className = 'prov';
        by.textContent = `by ${nameOf(takenByIds, data.actors)}`;
        ack.append(by);
      }
    }

    const dept = document.createElement('div');
    dept.className = 'value';
    dept.dataset['field'] = 'responsible';
    const deptK = document.createElement('span');
    deptK.className = 'k';
    deptK.textContent = 'Responsible';
    const deptV = document.createElement('span');
    deptV.className = 'v';
    deptV.textContent =
      data.responsibleDepartments.length > 0
        ? data.responsibleDepartments.join(', ')
        : 'not yet routed';
    dept.append(deptK, deptV);

    /**
     * ⚠️ **The per-department "Reach them" buttons are gone — ADR-0031, phase 4.** They iterated
     * `responsibleDepartmentIds` and each fetched `/contacts/department/:id`, a route that has
     * answered 404 on every id since migration 0039 dropped the table. `web/src/contact.ts` and
     * that route went with the loop. Reaching a person about an emergency is the recipient
     * picker's job now (`dispatch.ts`), which works off posts and people.
     */

    /**
     * **What we sent** — the district asked for it 2026-08-24, on the row *and* in this window.
     *
     * The Record's row now carries the latest message on its face; this block is the same fact
     * where somebody who opened the incident expects to find it, beside Severity and Responsible
     * rather than three screens down in the timeline. **Not a second projection**: it reads the
     * same `notifications[].sent` the panel below draws per recipient, and takes the LAST one —
     * an incident told twice was told about the second state of the world, and that is the
     * sentence the officer is acting on. Same rule as `api/board.ts`'s `sentMessage`, so the row
     * and this block can never disagree about one emergency.
     *
     * ⚠️ **Three states, and the middle one is the whole point.** Nobody told yet is *nothing
     * sent*; told with words is the words; told **without** words is *not recorded*, and it is
     * never drawn as a blank — nothing before 2026-08-23 carries a `message_sent` event and none
     * can be reconstructed, so an empty value here would read as silence about a message that
     * definitely went out.
     */
    const sent = document.createElement('div');
    sent.className = 'value';
    sent.dataset['field'] = 'sent';
    const sentK = document.createElement('span');
    sentK.className = 'k';
    sentK.textContent = 'What we sent';
    const sentV = document.createElement('span');
    sentV.className = 'v';
    const latest = [...s.notifications].reverse().find((n) => n.sent !== undefined)?.sent;
    if (latest !== undefined) {
      sentV.textContent = `${latest.what} — ${latest.where}`;
    } else if (s.dispatchedTo.length === 0) {
      sentV.textContent = 'nothing sent — nobody has been told yet';
    } else {
      sentV.textContent = 'not recorded';
    }
    sent.append(sentK, sentV);
    if (latest === undefined && s.dispatchedTo.length > 0) {
      const why = document.createElement('span');
      why.className = 'prov';
      // The reason, not just the gap. An operator who reads "not recorded" and stops has learnt
      // nothing they can act on; this says the message did go and the words are simply not in
      // the log — which is every message the district sent before 2026-08-23.
      why.textContent =
        'the message went out — its words were not kept before 2026-08-23 and cannot be rebuilt';
      sent.append(why);
    }

    const dispatched = s.notifications.filter(
      (notification) => notification.reason === 'dispatched',
    );
    const confirmed = dispatched.filter(
      (notification) =>
        notification.via === 'link' ||
        notification.via === 'reply' ||
        notification.via === 'operator',
    ).length;
    const failed = dispatched.filter((notification) => notification.state === 'failed').length;
    const waiting = Math.max(s.dispatchedTo.length - confirmed - failed, 0);
    const response =
      gathering && att !== null
        ? att.told === 0
          ? 'No one has been asked yet'
          : [
              `${att.coming} of ${att.told} coming`,
              ...(att.attending === 0 ? [] : [`${att.attending} attending`]),
              ...(att.sendingSomeone === 0 ? [] : [`${att.sendingSomeone} sending someone`]),
              ...(att.notAttending === 0 ? [] : [`${att.notAttending} not attending`]),
              ...(att.unanswered === 0 ? [] : [`${att.unanswered} silent`]),
            ].join(' · ')
        : wide && roll !== null
          ? [
              `${roll.told} told`,
              `${roll.holding} responding`,
              ...(roll.declined === 0 ? [] : [`${roll.declined} not their remit`]),
              ...(roll.silent === 0 ? [] : [`${roll.silent} no answer`]),
            ].join(' · ')
          : s.dispatchedTo.length === 0
            ? 'No one has been told yet'
            : [
                `${s.dispatchedTo.length} told`,
                `${confirmed} confirmed`,
                ...(failed === 0 ? [] : [`${failed} not reached`]),
                ...(waiting === 0 ? [] : [`${waiting} waiting`]),
              ].join(' · ');

    /**
     * `#detailQuick` is `hidden` now — its Severity / Responsible / Response reading is carried
     * by the tiles and the recipient list. It is still populated so the `Response` string is
     * computed in one place and nothing that reaches for the element finds it empty.
     */
    detailQuick.replaceChildren(
      quickValue('Severity', s.severity?.value ?? 'not yet assessed', 'quick-severity'),
      dept,
      quickValue('Response', response, 'response'),
    );
    // "More incident details" keeps the provenance — who set each value, and what it replaced.
    detailValues.replaceChildren(
      valueBlock('Severity', s.severity, data.actors, 'not yet assessed'),
      valueBlock('Category', s.category, data.actors, 'unknown'),
      sent,
      ack,
    );

    // ------------------------------------------------------------------------ tiles
    const tiles = el('detailTiles');
    tiles.replaceChildren();

    /**
     * Name one dispatch target — a post, a person, or (older records) a department.
     *
     * Used by the "Status by recipient" list below; hoisted to `renderDetail` scope
     * so the list's renderer and anything else on this screen resolve a recipient the
     * same way. `post`/`person` first because the district dispatches to those now;
     * the department arms are for records made before ADR-0030 flattened the directory.
     *
     * Both a `person` and a `post` recipient are named `<human> — <post>` — the person-first
     * rule `nameOf` above follows for provenance (ADR-0035), reaching the recipient list that
     * ADR left name-only; `backlog/whatsapp-response-workflow.md` §6 asked for it here. A
     * `person` leads with their name and adds the post they hold; a `post` leads with its
     * holder and adds the title. A vacant post, an officer holding no post, an older server, or
     * a human whose name and post restate each other all fall back to the bare single string.
     */
    const compose = (human: string, post: string | undefined): string => {
      const p = post?.trim() ?? '';
      return p === '' || p.toLowerCase() === human.trim().toLowerCase() ? human : `${human} — ${p}`;
    };
    const nameForTarget = (t: { kind: string; id: string }): string => {
      if (t.kind === 'post') {
        const seat = data.actors.seats[t.id];
        if (seat === undefined) return t.id;
        return seat.holder !== undefined ? compose(seat.holder, seat.title) : seat.title;
      }
      if (t.kind === 'person') {
        const name = data.actors.people[t.id];
        if (name === undefined) return t.id;
        return compose(name, data.actors.personSeats?.[t.id]);
      }
      const told = (data.actors.departments ?? {})[t.id];
      if (told !== undefined) return told;
      const at = data.responsibleDepartmentIds.indexOf(t.id);
      return at === -1 ? t.id : (data.responsibleDepartments[at] ?? t.id);
    };

    const stageIx = data.stage === undefined ? 0 : Math.max(0, STAGE_STEPS.indexOf(data.stage));
    const stageTile = document.createElement('div');
    stageTile.className = 'd-tile d-tile-wide';
    const stageK = document.createElement('p');
    stageK.className = 'd-tile-k';
    stageK.textContent = 'Stage';
    const steps = document.createElement('div');
    steps.className = 'd-steps';
    steps.setAttribute('aria-hidden', 'true');
    STAGE_STEPS.forEach((_, i) => {
      const seg = document.createElement('span');
      if (i < stageIx) seg.className = 'done';
      else if (i === stageIx) seg.className = 'now';
      steps.append(seg);
    });
    const stageV = document.createElement('p');
    stageV.className = 'd-tile-step';
    stageV.textContent = data.stage ?? s.status;
    const stageSmall = document.createElement('small');
    /**
     * The four-word stage is the headline; the full status stays beside it — *routed* and
     * *reported* are the same stage while being different situations, and this screen is the
     * one that carries the difference (M9-25). The step count reads "step 3 of 4".
     */
    const step =
      data.stage !== undefined && stageIx < STAGE_STEPS.length - 1
        ? ` · step ${stageIx + 1} of ${STAGE_STEPS.length}`
        : data.stage !== undefined
          ? ' · complete'
          : '';
    stageSmall.textContent = ` · ${s.status}${step}`;
    stageV.append(stageSmall);
    stageTile.append(stageK, steps, stageV);

    const tile = (
      k: string,
      v: string,
      small: string | null,
      tone: '' | 'alert' | 'watch',
    ): HTMLElement => {
      const box = document.createElement('div');
      box.className = tone === '' ? 'd-tile' : `d-tile ${tone}`;
      const kk = document.createElement('p');
      kk.className = 'd-tile-k';
      kk.textContent = k;
      const vv = document.createElement('p');
      vv.className = 'd-tile-v';
      vv.textContent = v;
      if (small !== null) {
        const sm = document.createElement('small');
        sm.textContent = ` ${small}`;
        vv.append(sm);
      }
      box.append(kk, vv);
      return box;
    };

    let deadlineTile: HTMLElement;
    if (data.sla?.carries !== true) {
      deadlineTile = tile('Deadline', 'no deadline', 'this kind carries none', '');
    } else if (s.acknowledgedAt !== null && !unheld) {
      // `unheld` — a wide dispatch everyone declined — is not "met": the server's clock is
      // still running (it was handed `ownerless`), so this falls through to overdue / on track.
      deadlineTile = tile('Deadline', 'met', `target ${data.sla.targetMinutes}m`, '');
    } else if ((data.sla.overdueByMinutes ?? 0) > 0) {
      deadlineTile = tile(
        'Deadline',
        `${data.sla.overdueByMinutes}m overdue`,
        `target ${data.sla.targetMinutes}m`,
        'alert',
      );
    } else {
      deadlineTile = tile('Deadline', 'on track', `target ${data.sla.targetMinutes}m`, '');
    }

    /**
     * 🔴 **"Taken by" — who has actually accepted this, not who was routed it.**
     *
     * This tile read "Assigned to" and showed `responsibleDepartments` — the district
     * routing an incident to a *department*. ADR-0030 deleted the department table and
     * migration 0039 the route with it, so that field is empty on every live incident
     * for ever, and the tile fell through to "see recipients below" (a tile pointing at
     * the section under it) and then to naming the recipients (a second copy of that
     * section). Routing is what used to make "who holds this" a different question from
     * "who was told"; with it gone, the only honest at-a-glance owner is **whoever
     * acknowledged** — the seat that said *we have this* (ADR-0004: authority is the
     * post's). Until somebody does, nobody holds it, and the tile says so.
     */
    let assignedTo: string;
    let assignedSmall: string | null = null;
    let assignedTone: '' | 'alert' | 'watch' = '';
    if (wide && roll !== null) {
      // A wide dispatch: "Taken by" is the first office to COMMIT, read from the roll-up, not
      // the incident's first-tap slot — which on four recipients has named whoever answered
      // first, a decline included. `unheld` = everyone answered and none can take it.
      if (unheld) {
        assignedTo = 'not taken';
        assignedSmall = 'reassign below';
        assignedTone = 'watch';
      } else if (roll.holding === 0) {
        assignedTo = 'not yet taken';
      } else if (takenByIds.seatId !== null || takenByIds.personId !== null) {
        assignedTo = nameOf(takenByIds, data.actors);
        assignedSmall = respondedAt === null ? null : relAge(respondedAt);
      } else {
        assignedTo = 'taken';
        assignedSmall = respondedAt === null ? null : relAge(respondedAt);
      }
    } else if (s.acknowledgedAt === null) {
      assignedTo = 'not yet taken';
    } else if (s.acknowledgedBySeatId !== null || s.acknowledgedByPersonId !== null) {
      assignedTo = nameOf(
        { personId: s.acknowledgedByPersonId, seatId: s.acknowledgedBySeatId },
        data.actors,
      );
      assignedSmall = relAge(s.acknowledgedAt);
    } else {
      // Acknowledged, but by nobody nameable — an app confirmation from a signed-in
      // officer before routes carried a seat (see `acknowledgedBySeatId`'s own note).
      assignedTo = 'taken';
      assignedSmall = relAge(s.acknowledgedAt);
    }
    const priority = s.severity?.value ?? 'not assessed';

    /**
     * When this notice asked who is coming, the fourth tile is **Coming** — `N of M`, with the
     * count that have answered beneath it — not "Taken by". A meeting has no owner; the number
     * the district reads out is how many will be in the room.
     */
    const fourthTile =
      gathering && att !== null
        ? tile(
            'Coming',
            att.told === 0 ? 'nobody asked yet' : `${att.coming} of ${att.told}`,
            att.told === 0 ? null : `${att.answered} answered`,
            '',
          )
        : tile('Taken by', assignedTo, assignedSmall, assignedTone);

    tiles.append(
      stageTile,
      tile('Reported', relAge(s.occurredAt), null, ''),
      deadlineTile,
      fourthTile,
      tile(
        'Priority',
        priority,
        null,
        priority === 'critical' || priority === 'high' ? 'watch' : '',
      ),
    );

    // ------------------------------------------------ notes (correction / withdrawal)
    const notes = el('detailNotes');
    notes.replaceChildren();
    if (s.correctionReason != null && s.correctionReason !== '') {
      const note = document.createElement('p');
      note.className = 'cnote';
      const head = document.createElement('strong');
      head.textContent = 'Corrected: ';
      note.append(head, document.createTextNode(s.correctionReason));
      if (s.correction != null && s.correction !== '') {
        const instead = document.createElement('span');
        instead.textContent = ` Instead: ${s.correction}`;
        note.append(instead);
      }
      const truth = document.createElement('span');
      truth.className = 'meta';
      truth.textContent =
        ' — nothing was deleted, and everybody already told still has the original message. ' +
        'If it matters, tell them again or ring them.';
      note.append(truth);
      notes.append(note);
    }
    if (s.withdrawnAt != null) {
      const note = document.createElement('p');
      note.className = 'cnote wnote';
      const head = document.createElement('strong');
      head.textContent = 'Taken off the Record: ';
      note.append(head, document.createTextNode(s.withdrawalReason ?? ''));
      const truth = document.createElement('span');
      truth.className = 'meta';
      truth.textContent =
        ' — nothing was deleted. It is still on the daily report and can be shown again, ' +
        'and Restore puts it back.';
      note.append(truth);
      notes.append(note);
    }

    // ---------------------------------- the alert we sent / the response we received
    {
      const label = document.createElement('p');
      label.className = 'd-block-label';
      label.textContent = 'The alert we sent';
      let quote: HTMLElement;
      if (latest !== undefined) {
        quote = quoteBlock(
          `“${latest.what} — ${latest.where}”`,
          `sent to ${s.dispatchedTo.length} recipient${s.dispatchedTo.length === 1 ? '' : 's'}`,
          false,
        );
      } else if (s.dispatchedTo.length === 0) {
        quote = quoteBlock('Nothing sent yet — nobody has been told.', null, false);
        quote.classList.add('none');
      } else {
        quote = quoteBlock(
          'Not recorded — the message went out, but its words were not kept before 2026-08-23 ' +
            'and cannot be rebuilt.',
          null,
          false,
        );
        quote.classList.add('none');
      }
      el('detailSent').replaceChildren(label, quote);
    }
    if (gathering && att !== null) {
      /**
       * When this notice asked who is coming, this block IS the attendance answer — the summary
       * sentence the district reads out, then every person asked with the answer they gave. It
       * replaces "The response we received" (a single last reply is not the answer to a
       * meeting) and stands in for the single-answer machinery entirely.
       */
      const label = document.createElement('p');
      label.className = 'd-block-label';
      label.textContent = 'Who is coming';

      const summary = document.createElement('p');
      summary.className = 'd-next';
      summary.textContent = att.told === 0 ? 'Nobody has been asked yet.' : attendanceLine(att);

      const list = document.createElement('ul');
      list.className = 'd-attendance';
      for (const r of att.rows) {
        const li = document.createElement('li');
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = nameOf({ personId: r.personId, seatId: r.seatId }, data.actors);
        const ans = document.createElement('span');
        ans.className = `answer a-${r.answer}${r.stale || r.late ? ' set-aside' : ''}`;
        ans.textContent = r.stale
          ? `${ATTENDANCE_WORD[r.answer]} · about the old date`
          : r.late
            ? `${ATTENDANCE_WORD[r.answer]} · after the count closed`
            : ATTENDANCE_WORD[r.answer];
        li.append(who, ans);
        if (r.said !== null && r.said !== '' && r.answer === 'other') {
          const said = document.createElement('span');
          said.className = 'said';
          said.textContent = `“${r.said}”`;
          li.append(said);
        }
        list.append(li);
      }

      const box = document.createElement('div');
      box.append(summary);
      if (att.rows.length > 0) box.append(list);
      el('detailReceived').replaceChildren(label, box);
    } else {
      const label = document.createElement('p');
      label.className = 'd-block-label';
      label.textContent = 'The response we received';
      let quote: HTMLElement;
      if (unheld && roll !== null) {
        // A wide dispatch where every office answered and none can take it. The single last
        // reply is not the answer here — the count is, and each reply is on the list below.
        quote = quoteBlock(
          'Every office answered and none can take it.',
          `${roll.declined} declined · see each reply below`,
          true,
        );
        // `none` greys the text (no single reply is the answer); `unheld` turns the left edge
        // burnt orange — the one reply state that asks for an action. See `.d-msg.in.unheld`.
        quote.classList.add('none', 'unheld');
      } else if (wide && roll !== null && (taken || respondedAt !== null)) {
        // The office that committed first, and how many more answered — the full set is the
        // recipient list under this block, so this names the commit and points at the rest.
        const more = roll.told - 1;
        const meta = `${nameOf(takenByIds, data.actors)}${
          respondedAt === null ? '' : ` · ${when(respondedAt)}`
        }${more > 0 ? ` · +${more} more below` : ''}`;
        quote =
          roll.takenBySaid !== null && roll.takenBySaid !== ''
            ? quoteBlock(`“${roll.takenBySaid}”`, meta, true)
            : quoteBlock('Taken — no words recorded with the confirmation.', meta, true);
        if (roll.takenBySaid === null || roll.takenBySaid === '') quote.classList.add('none');
      } else {
        const reply = [...s.notifications]
          .reverse()
          .find((n) => n.said !== undefined && n.said !== '');
        if (reply?.said !== undefined) {
          quote = quoteBlock(
            `“${reply.said}”`,
            `${nameOf(
              { personId: reply.personId ?? null, seatId: reply.seatId ?? null },
              data.actors,
            )} · ${when(reply.attemptedAt)}`,
            true,
          );
        } else {
          quote = quoteBlock('No reply received yet.', null, true);
          quote.classList.add('none');
        }
      }
      el('detailReceived').replaceChildren(label, quote);
    }

    /**
     * Who was told (M6-08).
     *
     * Names resolved from what the response already carries — the actor directory has every
     * seat and person the incident touched, and the department names arrive beside their ids.
     * A second request for names is a second thing that can be half-loaded on a bad connection,
     * on the screen where "who was told" must never be blank because a fetch failed.
     *
     * An id with no name is shown **as an id**, not hidden. A recipient missing from the
     * directory is a real problem, and a blank row would read as nobody having been told.
     */
    /**
     * **Take action — Phase 8c, and it is the first thing on this screen that DOES anything.**
     *
     * Fetched with the same bundle as the panel below it and drawn the same way: `void` rather
     * than `await`, because the record must stay readable on a connection that never delivers
     * one more file.
     *
     * ⚠️ **Withheld entirely on a withdrawn incident.** A row taken off the board is one the
     * district has said it is not acting on; offering four ways to act on it is the screen
     * arguing with the decision somebody just made. The buttons return with Restore.
     */
    const takeAction = el('takeAction');
    takeAction.hidden = s.withdrawnAt != null;

    if (!takeAction.hidden) {
      void loadDispatch().then((module) => {
        module?.renderTakeAction(
          el('takeActionRows'),
          {
            incidentId: s.incidentId,
            status: s.status,
            toldAnybody: s.dispatchedTo.length > 0,
            escalationCount: s.escalationCount,
          },
          (incidentId) => void openDetail(incidentId),
        );
      });
    }

    /**
     * Fetched, then rendered — the panel is a lazy bundle now (M7-26).
     *
     * `void` and not `await`: everything else on this screen is already painted, and an
     * incident whose whole detail waited on one more file would be an incident that looks
     * broken on a bad connection. The panel appears a beat later, or it does not appear and
     * the rest of the record is still readable.
     */
    void loadDispatch().then((module) => {
      module?.renderWhoWasTold(
        el('whoToldRows'),
        s,
        /**
         * 🔴 **This printed a uuid per recipient, and the server is where it was fixed.**
         * `actors` named the people and posts that had **performed an event**; a named officer
         * the control room dispatched to usually performs none, so `people[t.id]` missed and the
         * panel fell through to the id — four raw uuids under *"who was told"*, on the one screen
         * the district opens for *"kis ko gaya hai"*. `actorsFor` takes `dispatchedTo` now, so
         * this lookup finds them; the fallback stays, because an id is still a better answer than
         * a blank when somebody has genuinely left the roster. `nameForTarget` is defined once in
         * `renderDetail` scope so this screen resolves a recipient one way everywhere.
         */
        nameForTarget,
        /**
         * What the operator was told, going into the record — M7-05/08.
         *
         * Withheld on a closed incident, because the server refuses it there and a control that
         * offers something the server will refuse is worse than no control: it is discovered by
         * an operator who has already had the conversation.
         */
        s.status === 'closed'
          ? undefined
          : async (attemptId, outcome, said) => {
              const res = await fetch(`/incidents/${s.incidentId}/acknowledged-by`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ attemptId, outcome, said }),
              });
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(body.error ?? `refused (${res.status})`);
              }
              // Reload rather than patch the row. The server may have settled other messages to
              // the same recipient and may have acknowledged the incident, and a screen that
              // guessed at those would be a second implementation of rules the server owns.
              await openDetail(s.incidentId);
            },
        /**
         * The saved groups this incident's dispatches expanded — Case 3, 2026-09-10. `?? []`
         * because an older server sends no field, and the panel then draws its flat list.
         */
        data.recipientGroups ?? [],
      );
    });

    el('whoToldSummary').textContent =
      s.dispatchedTo.length <= 1
        ? 'Status by recipient'
        : `Status by recipient — ${confirmed} of ${s.dispatchedTo.length} confirmed`;

    // ------------------------------------------------------------- latest update
    {
      const lastAction = [...data.events].reverse().find((e) => e.type === 'action_logged');
      const { box, body } = dBlock('Latest update');
      if (lastAction === undefined) {
        const p = document.createElement('p');
        p.className = 'd-quiet';
        p.textContent = 'No updates logged yet.';
        body.append(p);
      } else {
        const card = document.createElement('div');
        card.className = 'd-update';
        const w = document.createElement('p');
        w.className = 'd-update-when';
        w.textContent = `${relAge(lastAction.occurredAt)} · ${nameOf(
          { personId: lastAction.actorPersonId, seatId: lastAction.actorSeatId },
          data.actors,
        )}`;
        const t = document.createElement('p');
        t.className = 'd-update-txt';
        t.textContent = detailOf(lastAction) ?? '(no note)';
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'd-link';
        link.textContent = 'See full history →';
        link.addEventListener('click', () => showDetailTab('hist'));
        card.append(w, t, link);
        body.append(card);
      }
      el('detailLatest').replaceChildren(box);
    }

    // --------------------------------------------------------------- next step
    {
      const { box, body } = dBlock('Next step');
      let step: string;
      if (s.withdrawnAt != null) step = 'Off the Record — restore it to act on it again.';
      else if (data.stage === 'resolved' || s.status === 'closed') step = 'Nothing outstanding.';
      else if (gathering && att !== null) {
        // A meeting is not chased with an escalation ladder — the next step is the chase list.
        step =
          att.told === 0
            ? 'Nobody has been asked yet — choose who to tell below.'
            : att.unanswered > 0
              ? `${att.unanswered} of ${att.told} have not answered — follow up below.`
              : `Everyone asked has answered — ${att.coming} of ${att.told} coming.`;
      } else if (unheld) step = 'Nobody has taken this — reassign below.';
      else if (waiting > 0)
        step = `${waiting} recipient${waiting === 1 ? '' : 's'} still silent — follow up or escalate below.`;
      else if (!taken) step = 'Waiting for a recipient to confirm.';
      else step = 'In progress — log the next update below.';
      const p = document.createElement('p');
      p.className = 'd-next';
      p.textContent = step;
      body.append(p);
      el('detailNext').replaceChildren(box);
    }

    // ------------------------------------------------------------ how it came in
    {
      const reported = data.events.find((e) => e.type === 'reported');
      const { box, body } = dBlock('How it came in');
      const line = document.createElement('p');
      line.className = 'd-kv';
      const channel =
        reported === undefined || reported.sourceChannel === ''
          ? 'the control room'
          : reported.sourceChannel;
      line.textContent = `By ${channel} — ${relAge(s.occurredAt)}`;
      body.append(line);
      if (reported !== undefined) {
        const gap = Math.round(
          (Date.parse(reported.recordedAt) - Date.parse(reported.occurredAt)) / 60_000,
        );
        if (gap >= 15) {
          const late = document.createElement('p');
          late.className = 'd-kv-sub';
          late.textContent = `Reached the server ${gap} min later — saved offline, synced when the signal came back.`;
          body.append(late);
        }
      }
      el('detailIntake').replaceChildren(box);
    }

    el('timelineSummary').textContent = `Full history — ${data.events.length} events`;
    timelineRows.replaceChildren(
      ...data.events.map((event) => {
        const row = document.createElement('div');
        row.className = 'tl';
        row.dataset['type'] = event.type;
        /**
         * **Something we tried to send and could not** — marked, not merely worded.
         *
         * `followed_up` prints the same heading either way, so without this the only difference
         * between a follow-up that went and one that did not is a phrase halfway along a line
         * somebody is scanning. INV-03 asks for failures to be visible so that somebody fixes
         * them, and a fixable failure here is a dead number in the roster.
         *
         * A `data-` attribute rather than a class, so the rule can key on it exactly the way
         * `.row[data-overdue]` does on the board — one vocabulary for *this went wrong*, in both
         * places somebody reads it.
         */
        if (event.type === 'followed_up' && event.payload['delivered'] === false) {
          row.dataset['failed'] = 'true';
        }

        const whenEl = document.createElement('span');
        whenEl.className = 'when';
        whenEl.textContent = when(event.occurredAt);

        const what = document.createElement('span');
        what.className = 'what';
        const type = document.createElement('b');
        type.textContent = event.type.replace(/_/g, ' ');
        what.append(type);

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = nameOf(
          { personId: event.actorPersonId, seatId: event.actorSeatId },
          data.actors,
        );
        what.append(who);

        const why = detailOf(event);
        if (why !== null && why.trim().length > 0) {
          const whyEl = document.createElement('span');
          whyEl.className = 'why';
          whyEl.textContent = why;
          what.append(whyEl);
        }

        // The occurred/recorded gap is the district's connectivity picture, not noise
        // (ADR-0002). A report that took two hours to surface is an operational fact.
        const gapMinutes = Math.round(
          (Date.parse(event.recordedAt) - Date.parse(event.occurredAt)) / 60_000,
        );
        if (gapMinutes >= 15) {
          const late = document.createElement('span');
          late.className = 'late';
          late.textContent = `reached the server ${gapMinutes}m later — ${when(event.recordedAt)}`;
          what.append(late);
        }

        row.append(whenEl, what);
        return row;
      }),
    );
  }

  async function openDetail(incidentId: string): Promise<void> {
    openIncidentId = incidentId;
    showView('detail');
    el<HTMLDetailsElement>('detailFacts').open = false;
    showDetailTab('ov');
    detailHead.textContent = 'Loading…';
    try {
      const res = await fetch(`/incidents/${incidentId}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        detailHead.textContent =
          res.status === 404
            ? 'That incident is not available to your seat.'
            : 'Could not load this incident.';
        clearDetailBody();
        return;
      }
      renderDetail((await res.json()) as Detail);
    } catch {
      // Offline. Say so rather than showing an empty incident, which reads as "nothing
      // happened" when the truth is "we cannot see" (INV-02).
      detailHead.textContent = 'No connection — cannot load this incident right now.';
      clearDetailBody();
    }
  }

  /** Empty every part of the drawer body — used on a failed load. */
  function clearDetailBody(): void {
    for (const id of [
      'detailTiles',
      'detailNotes',
      'detailSent',
      'detailReceived',
      'whoToldRows',
      'detailLatest',
      'detailNext',
      'detailIntake',
      'detailQuick',
      'detailValues',
      'timelineRows',
    ]) {
      el(id).replaceChildren();
    }
    el('takeAction').hidden = true;
    el('detailFoot').hidden = true;
    closeDetailMore();
  }

  /**
   * **The board's Follow up button — one confirm, then it sends — 2026-08-31.**
   *
   * `incidentRow.ts` draws the button (with `data-followup` and `data-waiting`) and no handler
   * of its own; the send lives here, beside the other row actions. The click bubbles to this
   * one delegated listener, which catches `[data-followup]` before the row-open branch, so the
   * incident does **not** open behind the confirm.
   *
   * `POST /incidents/:id/follow-up` with an empty body re-reaches everyone told about the
   * emergency — `api/followUp.ts`'s deliberate rule (a chase is a reminder to all, not a
   * message to one), so the confirm says exactly that. The button reports its own outcome and
   * does not refresh the board: a chase changes nothing an operator needs to see move.
   */
  async function followUpFromBoard(btn: HTMLButtonElement): Promise<void> {
    const id = btn.dataset['followup'];
    if (id === undefined || btn.disabled) return;
    const waiting = btn.dataset['waiting'] ?? '0';
    if (
      !confirm(
        `Send a follow-up? ${waiting} still waited on.\n\n` +
          'It re-sends the alert to everyone told about this emergency, not only those still waiting.',
      )
    ) {
      return;
    }
    btn.disabled = true;
    btn.textContent = 'sending…';
    try {
      const res = await fetch(`/incidents/${id}/follow-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        btn.textContent = 'follow-up sent';
      } else {
        const problem = (await res.json().catch(() => ({}))) as { error?: string };
        alert(problem.error ?? 'The follow-up could not be sent.');
        btn.disabled = false;
        btn.textContent = 'Follow up';
      }
    } catch {
      alert('The follow-up could not be sent.');
      btn.disabled = false;
      btn.textContent = 'Follow up';
    }
  }

  boardRows.addEventListener('click', (e) => {
    const followUpBtn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      'button[data-followup]',
    );
    if (followUpBtn !== null && followUpBtn !== undefined) {
      void followUpFromBoard(followUpBtn);
      return;
    }
    const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.row');
    const id = row?.dataset['incident'];
    if (id !== undefined) void openDetail(id);
  });

  // ---------------------------------------------------------------- auth

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const data = new FormData(loginForm);

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Trimmed, because a number pasted out of a message carries a space the person
          // pasting it cannot see, and the server is not the place to discover that. The
          // password is deliberately *not* trimmed — a space can be part of one, and quietly
          // removing it would make a legitimate password impossible to type.
          phone: String(data.get('phone') ?? '').trim(),
          password: String(data.get('password') ?? ''),
        }),
      });

      if (!res.ok) {
        /**
         * 401 is the only status that is about the credentials.
         *
         * This said "Phone number or password is not correct" for every failure, including the
         * 503 that means *the machine is too busy to check a password right now* — which sent
         * the control room hunting for a typo that was not there, during exactly the flood
         * that produced the 503. A wrong password and an overloaded server are different
         * facts and the screen now says which one happened.
         */
        let message = 'Phone number or password is not correct.';
        if (res.status !== 401) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          message =
            typeof body?.error === 'string'
              ? body.error
              : 'Sign-in could not be completed — try again in a moment.';
        }
        loginError.textContent = message;
        loginError.hidden = false;
        return;
      }

      const body = (await res.json()) as { identity: Identity };
      identity = body.identity;
      loginForm.reset();
      // Sign-in answers with the identity alone, so the capability set is fetched here rather
      // than assumed — a menu drawn from a stale set is a screen missing tabs for a reason
      // nobody can see.
      await loadIdentity();
      paintIdentity();

      // A `must_change_password` account is held on "change my password" and cannot leave it.
      // `enforcePasswordChange` is a no-op when the flag is not set.
      await enforcePasswordChange();

      /**
       * Where somebody lands depends on what they are holding.
       *
       * On a phone, the report form — that is the officer standing at a scene, and putting a
       * summary in front of them first would cost seconds at the only moment seconds matter.
       *
       * On a laptop or an office screen, the dashboard — nobody carries one of those to an
       * incident, and the question they opened it to answer is "what is happening".
       *
       * This is the *only* place in the client that reads the viewport, and it chooses a
       * starting screen rather than a layout. Every layout decision stays in CSS, where it
       * responds to a resized window and a turned phone without any code being involved.
       *
       * **A control-room seat lands on intake, whatever they are holding — M6-11.**
       *
       * The exception, and it is not a viewport question at all. What a control-room operator
       * opens this for is *"the telephone is ringing"*, forty times a day (ADR-0016). The
       * dashboard is the right first screen for an office that wants to know what is
       * happening, and the wrong one for the room where things start happening — a summary
       * followed by a click is a click spent while somebody is talking.
       *
       * Keyed on the seat rather than the screen size, because that is the actual question,
       * and the district's own control room runs on a desk PC that would otherwise land on the
       * dashboard by size alone.
       */
      if (identity.isAdministration) showView('report');
      else if (window.matchMedia('(min-width: 56rem)').matches) showView('dashboard');

      await trySync();
    } catch {
      loginError.textContent = 'Cannot reach the server. Check your connection and try again.';
      loginError.hidden = false;
    }
  });

  el('logout').addEventListener('click', async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {
      // Offline. The cookie stays until it expires; the server refuses it either way.
    }
    identity = null;
    // A fresh signed-out session starts collapsed behind "Report an emergency" again, the same
    // as a first visit — see `reportRevealed`.
    reportRevealed = false;
    paintIdentity();
    await trySync();
  });

  el('changePw').addEventListener('click', () => void changePasswordDialog(false));

  /**
   * The theme switch — 2026-08-20.
   *
   * The head script in `index.html` already applied the stored choice before the first pixel;
   * everything here is about the press. Three things move together and none of them can be
   * left out:
   *
   * - the attribute on `<html>`, which is what the whole stylesheet keys off;
   * - the value in `localStorage`, which is what the head script reads on the next launch;
   * - `theme-color`, the strip the phone paints around the page. Miss it and a dark app has a
   *   white bar welded to the top of it, on exactly the device where it is most obvious.
   *
   * The label names **what the next press does**, not what the screen currently is. A button
   * that reads "Dark" while the screen is already dark is the oldest bug in this shape of
   * control, and a screen reader user has nothing else to go on.
   *
   * `localStorage` throws — not returns null — in a browser with site data blocked and in an
   * iOS private window. The theme still changes when it does; it simply will not survive a
   * reload, which is the right half to lose.
   */
  {
    const root = document.documentElement;
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name=theme-color]');
    const themeButton = el('theme');

    const paintTheme = (): void => {
      const dark = root.dataset['theme'] === 'dark';
      const next = dark ? 'Light theme' : 'Dark theme';
      themeButton.title = next;
      themeButton.setAttribute('aria-label', next);
      el('themeWord').textContent = dark ? 'Light' : 'Dark';
      if (themeMeta) themeMeta.content = dark ? '#08090c' : '#f7f8fa';
    };

    themeButton.addEventListener('click', () => {
      const dark = root.dataset['theme'] !== 'dark';
      if (dark) root.dataset['theme'] = 'dark';
      else delete root.dataset['theme'];
      try {
        localStorage.setItem('dnc-bajaur.theme', dark ? 'dark' : 'light');
      } catch {
        // Site data blocked. The theme holds for this session and is forgotten on reload.
      }
      paintTheme();
    });

    paintTheme();
  }

  // Hints that something changed, worth a sync attempt — but they never set the displayed
  // state on their own. Only a sync outcome does that.
  addEventListener('online', () => {
    paintIdentity();
    void trySync();
  });
  addEventListener('offline', () => {
    reachability = 'unreachable';
    paintIdentity();
    paintStatus();
  });

  paintStatus();
  await paintQueue();
  await loadIdentity();

  // A session that came back with `must_change_password` set — an administrator reset it while
  // the tab was closed — lands straight on the forced dialog (ADR-0032 phase 3). No-op otherwise.
  void enforcePasswordChange();

  /**
   * A link to the board lands on the board — M11-17.
   *
   * Without this the rest of a saved view is unreachable by the only route that matters: a
   * pasted link boots, decides a landing screen from the seat and the viewport (the rule in the
   * sign-in handler above), and never looks at the address it was opened with. The view would
   * restore correctly onto a screen nobody was looking at.
   *
   * ⚠️ **This chooses a screen and nothing else.** It cannot reach a screen the seat does not
   * have — `showView` draws what `paintIdentity` has already decided to offer, and the board
   * itself is fetched with this session and scoped by the server. A link is still presentation
   * (INV-05): it can put somebody on their own board, narrowed. It cannot put them on anybody
   * else's.
   */
  if (identity !== null && location.hash.startsWith('#board')) showView('board');

  void trySync();

  (globalThis as unknown as { __dnc: unknown }).__dnc = {
    outbox,
    store,
    trySync,
    paintQueue,
    identity: () => identity,
    refreshBoard,
    showBoard,
    openDetail,
    /**
     * Move the board's "last reached the server" mark backwards, and repaint.
     *
     * A test seam, and a deliberate one. The alternative is a suite that sits for thirty
     * real seconds to watch a clock tick over, and a staleness warning nobody verifies is
     * exactly the kind of thing that rots — INV-02 is worth a hook.
     */
    backdateBoard: (ms: number) => {
      if (boardFetchedAt !== null) boardFetchedAt -= ms;
      paintBoardAge(lastBoard);
    },
    // So tests can assert against the incident itself rather than against the shape of a
    // payload, which would couple every suite to the intake form's field names.
    lastIncidentId: () => lastIncidentId,
  };
}

/**
 * Offline only works on a secure origin, and **saying so is the fix** — M6-39, ADR-0017.
 *
 * ## What went wrong, and why nothing caught it
 *
 * Service workers and geolocation run only in a secure context. The install guide told officers
 * to open `http://<office-IP>:3000`, which is not one — so on every real handset in Bajaur the
 * service worker never registered and **the app did not open without a network**, which is the
 * single claim ADR-0002 exists to make. Location capture fell back to typed guesses.
 * `navigator.clipboard` failed for the same reason, and that one symptom was noticed, patched
 * where it appeared, and never traced to its cause.
 *
 * **Nothing in the test suite could see it.** Playwright drives `127.0.0.1`, which *is* a secure
 * context by explicit exception in the specification — so the offline gate passes against the
 * one origin where the fault cannot occur. Same shape as the `npm start` fault of 2026-08-04,
 * where 338 tests passed against an application that could not be launched: the tests were right
 * about the code and wrong about the deployment.
 *
 * ## What this does about it
 *
 * The proxy (M6-36) is the actual fix and it is somebody's afternoon plus a DNS record (R-21).
 * Until every handset has been re-added from the district's domain, some of them will still be
 * on an IP address — and **the failure has to stop being silent.** An officer whose app quietly
 * does not work offline finds out at the scene; an officer told on the sign-in screen finds out
 * in the office, where it can be fixed.
 *
 * `isSecureContext` is the browser's own answer to the exact question, which is better than
 * matching on the protocol: it is already true for `localhost` and `127.0.0.1`, so a developer
 * and the test suite see nothing, and an officer on `192.168.1.40` sees the warning.
 */
function offlineReadiness(): void {
  if (window.isSecureContext) {
    if ('serviceWorker' in navigator) {
      addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js');
      });
    }
    return;
  }

  const warning = document.getElementById('insecureOrigin');
  if (warning !== null) warning.hidden = false;

  // Deliberately not registered. The browser would refuse anyway; what matters is that nothing
  // here pretends it succeeded — a caught-and-ignored rejection is how this stayed invisible.
  console.warn(
    'This address is not a secure origin, so the app cannot work offline and cannot read the ' +
      "phone's location. Open the district's https:// address instead (ADR-0017).",
  );
}

offlineReadiness();

/**
 * `boot()` opens IndexedDB, reads `localStorage` and wires every screen. If any of that
 * throws — site data blocked, a wedged `dnc-bajaur-outbox`, a private-window storage denial — an
 * unhandled rejection leaves the shell frozen on "Checking connection…" with nothing said.
 * Catch it, log it, and replace that line with something an operator can act on.
 */
void boot().catch((err: unknown) => {
  console.error('boot failed', err);
  const status = document.getElementById('status');
  if (status !== null) {
    status.dataset['state'] = 'offline';
    status.textContent =
      'This app could not start in this browser. It usually means site data (storage) is ' +
      'blocked — allow it for this site, or try a normal (non-private) window, then reload.';
  }
});
