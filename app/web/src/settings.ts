/**
 * The Settings panel — ADR-0032, phase 3.
 *
 * A **new top-level nav panel**, beside Dashboard · Report · Record · Administration · Status ·
 * How to use — the owner asked for it twice, and it is **not** a tab inside the Administration
 * console. Administration keeps the district's operational record (rosters, groups, deadlines,
 * backups, history); this holds **accounts**, the **access log** (read only) and — read only
 * for now — the **security policy**.
 *
 * ## What this file is not
 *
 * It is not the gate. Every `/settings` endpoint asks `requirePermission` for itself
 * (`api/settings.ts`, INV-05); the client **hides** the tab and enforces nothing. A `viewer`
 * who reached these endpoints anyway is refused by the server, whatever this bundle draws.
 *
 * ## Why its own bundle
 *
 * `settings.js` is fetched the first time somebody opens the panel, the shape `office.js`,
 * `reports.js` and the rest already follow — the shell is what a field officer downloads at a
 * scene, and account management is desk work that is useless without a connection. The M1 gate
 * is what enforces that: `admin.ts` is already out of the shell, and this would push it over
 * the budget if it were not (`backlog/settings-and-accounts.md`, "Shell budget").
 *
 * ## The rail and the drawer (2026-09-01)
 *
 * The owner: the panel's UI must read like Administration and the Record — the grouped sticky
 * rail, and Administration's *click a row → a drawer slides in from the right* everywhere it
 * fits. So every editable row here opens a right-hand drawer rather than an inline control:
 * `admin.ts`'s `createDrawer()` pattern, self-contained here (each lazy bundle owns its own
 * copy of a shared visual pattern — `lazyStyles.e2e`'s rule that a screen must arrive styled).
 * **No endpoint, `data-*` value or behaviour changed** — only the container did.
 */

type SettingsTab = 'overview' | 'accounts' | 'access' | 'security' | 'capabilities' | 'layout';

/**
 * The nav, grouped by what kind of thing each tab holds — `admin.ts`'s `TAB_GROUPS` shape,
 * copied deliberately (2026-09-01) so the two panels' rails read as one design rather than
 * two. Overview stands alone; Accounts/Access log/Security policy are the access-control
 * surface; Which screens are on/Dashboard layout are installation configuration, moved here
 * from Administration by ADR-0032 phase 4 and still gated there on `capabilities.write` /
 * `dashboard_layout.write`.
 *
 * ⚠️ Every `data-tab` value is unchanged — `settings.e2e` addresses these buttons by it.
 */
const TAB_GROUPS: readonly {
  readonly group: string | null;
  readonly items: readonly { readonly id: SettingsTab; readonly label: string }[];
}[] = [
  { group: null, items: [{ id: 'overview', label: 'Overview' }] },
  {
    group: 'Access control',
    items: [
      { id: 'accounts', label: 'Accounts' },
      { id: 'access', label: 'Access log' },
      { id: 'security', label: 'Security policy' },
    ],
  },
  {
    group: 'This installation',
    items: [
      { id: 'capabilities', label: 'Which screens are on' },
      { id: 'layout', label: 'Dashboard layout' },
    ],
  },
];

/**
 * The rail's right-aligned tag — `#adminTabs`'s `.badge-count`, and for its reason: a short
 * word beside each label gives the rail the same visual weight Administration's has. A few
 * are live counts, filled in by the renderer once its data lands (`setBadge`); the rest are
 * category tags the way Administration's `Posts` / `SLA` / `Audit` are.
 */
const RAIL_BADGES: Record<SettingsTab, string> = {
  overview: 'Live',
  accounts: '—',
  access: 'Log',
  security: 'Policy',
  capabilities: 'Screens',
  layout: 'Wall',
};

/** The roles (ADR-0032), plus `member` — an officer who signs in for Activities only (ADR-0038). */
const ROLES = ['owner', 'admin', 'operator', 'viewer', 'member'] as const;
type Role = (typeof ROLES)[number];

/**
 * The closed permission enumeration, mirrored from `domain/roles.ts` for the overrides editor.
 *
 * Hardcoded rather than fetched: the list is stable, the server validates every write against
 * its own copy (`isPermission`), and an unknown string here would simply be refused. The label
 * is what an administrator reads — the dotted key is what the API takes.
 */
const PERMISSIONS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'accounts.read', label: 'See the list of accounts' },
  { key: 'accounts.create', label: 'Create an account' },
  { key: 'accounts.remove', label: 'Remove an account' },
  { key: 'accounts.suspend', label: 'Suspend or reactivate an account' },
  { key: 'accounts.set_role', label: "Change an account's role" },
  { key: 'accounts.set_permission', label: 'Restrict or elevate another account' },
  { key: 'accounts.reset_password', label: "Reset another account's password" },
  { key: 'accounts.force_logout', label: 'Force an account to sign out' },
  { key: 'access_log.read', label: 'Read the access and login history' },
  { key: 'security_policy.read', label: 'Read the security policy' },
  { key: 'security_policy.write', label: 'Change the security policy' },
  { key: 'capabilities.write', label: 'Turn installation screens on and off' },
  { key: 'dashboard_layout.write', label: 'Arrange the dashboard wall' },
  { key: 'activities.upload', label: 'Activities: post pictures and videos' },
  { key: 'activities.read_all', label: "Activities: see everyone's posts" },
  { key: 'activities.delete_own', label: 'Activities: delete own posts' },
  { key: 'activities.moderate', label: "Activities: hide, restore or delete anyone's post" },
  { key: 'activities.departments', label: 'Activities: keep the Department list' },
  { key: 'activities.pending', label: 'Activities: approve pictures from unknown numbers' },
];

interface Override {
  readonly permission: string;
  readonly effect: 'allow' | 'deny';
}

interface AccountView {
  readonly personId: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly phone: string;
  readonly role: Role;
  readonly suspended: boolean;
  readonly mustChangePassword: boolean;
  readonly lastSignInAt: string | null;
  readonly overrides: readonly Override[];
}

interface AccessRow {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly actorPersonId: string | null;
  readonly actorName: string | null;
  readonly subjectPersonId: string | null;
  readonly subjectName: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
}

interface AccessPage {
  readonly rows: readonly AccessRow[];
  readonly nextBeforeSeq: number | null;
}

interface SecurityPolicyView {
  readonly minPasswordLength: number;
  readonly sessionTtlHours: number;
}

interface CapabilityRow {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly offered: boolean;
}
interface CapabilitiesView {
  readonly capabilities: readonly CapabilityRow[];
  readonly chosen: boolean;
}

interface PanelDef {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly audience: string;
  readonly sizes: readonly string[];
}
interface Placed {
  id: string;
  size: string;
}
interface LayoutView {
  readonly available: readonly PanelDef[];
  readonly layout: readonly Placed[];
  readonly isDefault: boolean;
  readonly slots: number;
  readonly overflows: boolean;
  readonly problems: readonly { readonly panelId: string; readonly why: string }[];
}

const ACCESS_TYPES = [
  'granted',
  'role_changed',
  'permission_set',
  'permission_cleared',
  'password_reset',
  'password_changed',
  'suspended',
  'reactivated',
  'removed',
  'session_revoked',
  'login_succeeded',
  'login_failed',
  'login_link_issued',
  'login_link_used',
] as const;

//----------------------------------------------------------------------------
// Small DOM helpers — local, because this is its own bundle (see `office.ts`).
//----------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`#${id} is missing from the shell`);
  return node as T;
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  node.textContent = content;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

/** A `<label>` wrapping a caps field name over its control — `admin.ts`'s `.d-field` shape. */
function labelledField(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'settings-field';
  wrap.append(text('span', 'settings-fieldlabel', label), control);
  return wrap;
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
 * A show/hide toggle on a password field — wraps the `<input>` in place (`main.ts` carries the
 * identical copy; this bundle owns its own per this file's own rule, see the header above).
 * Must be called once the input already has a parent — `replaceWith` is a no-op otherwise.
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

function textInput(kind: 'text' | 'password' = 'text'): HTMLInputElement {
  const input = document.createElement('input');
  input.type = kind;
  input.className = 'settings-askinput';
  return input;
}

function choiceSelect(
  choices: readonly { readonly value: string; readonly label: string }[],
  value: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'settings-askinput';
  for (const c of choices) {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = c.label;
    select.append(opt);
  }
  select.value = value;
  return select;
}

/** A read-only key/value block for a drawer — the Record's detail view, in small. */
function detailList(rows: readonly (readonly [string, string])[]): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'settings-detail';
  for (const [k, v] of rows) {
    dl.append(text('dt', 'settings-detail-key', k), text('dd', 'settings-detail-val', v));
  }
  return dl;
}

/** A vertical stack of full-width buttons under a drawer body. */
function drawerActions(...buttons: HTMLElement[]): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'settings-drawer-actions';
  bar.append(...buttons);
  return bar;
}

/** The trailing `›` cell that marks a row as a door. */
function chevronCell(): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'settings-rowchevron';
  td.setAttribute('aria-hidden', 'true');
  td.textContent = '›';
  return td;
}

/** Wire a `<tr>` (or any element) so a click or Enter/Space opens something. */
function makeRowOpen(row: HTMLElement, open: () => void): void {
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

/** A timestamp said the way a person reads one — the console's own `agoHours` is hours-only. */
function whenWords(iso: string | null): string {
  if (iso === null) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${String(hrs)}h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** Local midnight, as an instant — "today" for the Overview's two counters. */
function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

//----------------------------------------------------------------------------
// ask() — one value, and where the server demands one, a reason. Not `prompt()`.
//----------------------------------------------------------------------------

interface Ask {
  readonly title: string;
  /** The consequence, said BEFORE the act rather than discovered after it (M10-17). */
  readonly body?: string;
  /** Omit for a confirm-only dialog; the promise then resolves `''` on confirm, `null` on cancel. */
  readonly label?: string;
  readonly kind?: 'text' | 'password';
  /** Turns the single field into a `<select>` of these options. */
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly value?: string;
  readonly confirm: string;
  readonly danger?: boolean;
  /** `false` where an empty answer is a real answer; ignored for confirm-only. */
  readonly required?: boolean;
}

/**
 * The same `<dialog>` the console uses (`admin.ts`), and for the same three reasons: a native
 * `prompt()` cannot state a consequence, cannot refuse a blank answer well, and — the one that
 * decided it — cannot be reached by `admin.e2e`, so no reason-required path was ever exercised
 * in a browser. `showModal()` gives the focus trap, the page inertness and Esc for free
 * (ADR-0007).
 */
function ask(options: Ask): Promise<string | null> {
  const hasField = options.label !== undefined;
  const required = hasField && options.required !== false;

  return new Promise<string | null>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-ask';
    if (options.danger === true) dialog.dataset['danger'] = 'true';

    const form = document.createElement('form');
    form.className = 'settings-askform';

    const heading = text('h4', 'settings-asktitle', options.title);
    heading.id = 'settingsAskTitle';
    dialog.setAttribute('aria-labelledby', heading.id);
    form.append(heading);

    if (options.body !== undefined) form.append(text('p', 'settings-askbody', options.body));

    let control: HTMLInputElement | HTMLSelectElement | null = null;
    if (hasField) {
      const field = document.createElement('label');
      field.className = 'settings-askfield';
      field.append(text('span', 'settings-asklabel', options.label ?? ''));
      if (options.choices !== undefined) {
        const select = document.createElement('select');
        select.className = 'settings-askinput';
        for (const c of options.choices) {
          const opt = document.createElement('option');
          opt.value = c.value;
          opt.textContent = c.label;
          select.append(opt);
        }
        if (options.value !== undefined) select.value = options.value;
        control = select;
      } else {
        const input = document.createElement('input');
        input.type = options.kind === 'password' ? 'password' : 'text';
        input.className = 'settings-askinput';
        input.value = options.value ?? '';
        control = input;
      }
      field.append(control);
      form.append(field);
      if (control instanceof HTMLInputElement && control.type === 'password') {
        wirePasswordEye(control);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'settings-askactions';
    const cancel = button('settings-askno', 'Cancel');
    const confirm = button('settings-askyes', options.confirm);
    confirm.type = 'submit';
    actions.append(cancel, confirm);
    form.append(actions);
    dialog.append(form);

    let settled = false;
    const finish = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
      dialog.close();
      dialog.remove();
    };

    const gate = (): void => {
      confirm.disabled = required && (control?.value.trim() ?? '') === '';
    };
    control?.addEventListener('input', gate);
    control?.addEventListener('change', gate);
    gate();

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (confirm.disabled) return;
      finish(control?.value ?? '');
    });
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    dialog.showModal();
    control?.focus();
    if (control instanceof HTMLInputElement) control.select();
  });
}

//----------------------------------------------------------------------------
export interface SettingsPanel {
  /** Re-read everything the visible tab needs. */
  refresh(): Promise<void>;
  show(tab?: SettingsTab): void;
}

export function mountSettings(): SettingsPanel {
  const view = el('settingsView');
  const tabs = el<HTMLElement>('settingsTabs');
  const body = el<HTMLElement>('settingsBody');
  const error = el<HTMLElement>('settingsError');

  let tab: SettingsTab = 'overview';
  let generation = 0;

  /** The rail badge spans, so a renderer can drop a live count into its own tab. */
  const badgeSpans = new Map<SettingsTab, HTMLElement>();

  /** The access-log tab's filters — held here, not in the DOM, so a re-render keeps them. */
  const accessFilter: { type: string; subject: string; since: string } = {
    type: '',
    subject: '',
    since: '',
  };

  function fail(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }
  function clearError(): void {
    error.hidden = true;
    error.textContent = '';
  }

  function setBadge(id: SettingsTab, value: string): void {
    const span = badgeSpans.get(id);
    if (span !== undefined) span.textContent = value;
  }

  function paint(mine: number, node: HTMLElement): void {
    if (mine !== generation) return;
    body.replaceChildren(node);
  }

  /**
   * One request helper for the whole panel.
   *
   * A failed account change is shown, always, and the screen is never repainted as though it
   * succeeded — the `admin.ts` rule, and for the same reason: a suspension that silently failed
   * to save is worse than one that visibly did.
   */
  async function api<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
    // A GET the shell warmed at idle after sign-in (see `prefetchScreenData` in `main.ts`) is
    // served once from there, so the Overview tab paints filled rather than onto "Loading…".
    // One-shot and time-capped on the shell side; every re-read goes to the server.
    if (method === 'GET') {
      const warm = (
        window as unknown as { __dncPrefetchGet?: (p: string) => unknown }
      ).__dncPrefetchGet?.(path);
      if (warm !== undefined) {
        clearError();
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
      fail('Could not reach the server. Nothing was changed.');
      return null;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      fail(t === '' ? `Action failed (${String(res.status)})` : t);
      return null;
    }
    clearError();
    if (res.status === 204) return {} as T;
    return (await res.json().catch(() => ({}))) as T;
  }

  //--------------------------------------------------------------------------
  // Overview — every count is a door, and a zero is never one (the dashboard's rule).
  //--------------------------------------------------------------------------

  async function renderOverview(mine: number): Promise<void> {
    const today = startOfToday();
    const [accounts, logins, failures] = await Promise.all([
      api<readonly AccountView[]>('GET', '/settings/accounts'),
      api<AccessPage>(
        'GET',
        `/settings/access-log?type=login_succeeded&since=${encodeURIComponent(today)}&limit=200`,
      ),
      api<AccessPage>(
        'GET',
        `/settings/access-log?type=login_failed&since=${encodeURIComponent(today)}&limit=200`,
      ),
    ]);
    if (accounts === null) return;

    setBadge('accounts', String(accounts.length));

    const active = accounts.filter((a) => !a.suspended).length;
    const suspended = accounts.filter((a) => a.suspended).length;
    const loginsToday = logins?.rows.length ?? 0;
    const failedToday = failures?.rows.length ?? 0;

    const wrap = document.createElement('div');
    wrap.id = 'settingsOverview';
    wrap.append(
      text('h2', 'canvas-title', 'Settings Overview'),
      text(
        'p',
        'note',
        'Accounts, and who has signed in. Every figure opens the screen that answers the next question — a figure of nought opens nothing.',
      ),
    );

    const grid = document.createElement('div');
    grid.className = 'settings-cards';

    const card = (count: number, label: string, leadsTo: (() => void) | null): HTMLElement => {
      const c = document.createElement(leadsTo !== null ? 'button' : 'div');
      c.className = 'settings-card';
      if (c instanceof HTMLButtonElement) c.type = 'button';
      c.append(
        text('span', 'settings-count', String(count)),
        text('span', 'settings-label', label),
      );
      if (leadsTo !== null) c.addEventListener('click', leadsTo);
      else c.setAttribute('aria-disabled', 'true');
      return c;
    };

    grid.append(
      card(active, 'Active accounts', active > 0 ? () => go('accounts') : null),
      card(suspended, 'Suspended', suspended > 0 ? () => go('accounts') : null),
      card(
        loginsToday,
        'Sign-ins today',
        loginsToday > 0
          ? () => {
              accessFilter.type = 'login_succeeded';
              accessFilter.since = today.slice(0, 10);
              go('access');
            }
          : null,
      ),
      card(
        failedToday,
        'Failed attempts today',
        failedToday > 0
          ? () => {
              accessFilter.type = 'login_failed';
              accessFilter.since = today.slice(0, 10);
              go('access');
            }
          : null,
      ),
    );

    wrap.append(grid);
    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Accounts
  //--------------------------------------------------------------------------

  function roleChoices(): { value: string; label: string }[] {
    // `owner` is never chosen from a form — it is established at go-live and moves only by
    // handover, which the server enforces. An admin creating/raising an admin is owner-only
    // there too; offering it here and letting the server refuse is the honest failure.
    return ROLES.filter((r) => r !== 'owner').map((r) => ({
      value: r,
      label: r === 'member' ? 'member — Activities only' : r,
    }));
  }

  /**
   * Add an account — one drawer form, `admin.ts`'s `openAddContactDrawer` shape. It replaced a
   * three-step `ask()` chain: a form with every field visible at once is the same UX the
   * console's *Add New Contact* gives, and it is where this panel diverged from Administration.
   * The POST is byte-for-byte what the old flow sent — `mustChangePassword: true` and all.
   */
  function openAddAccountDrawer(): void {
    const bodyEl = document.createElement('div');

    const name = textInput('text');
    const post = textInput('text');
    const phone = textInput('text');
    // `member` by default (ADR-0038 §5): most new accounts are officers posting Activities, and
    // the control room is the deliberate choice, not the one left in place.
    const role = choiceSelect(roleChoices(), 'member');
    // The default Activities department (ADR-0039 §2) — optional, filled once the list arrives.
    const unit = choiceSelect([{ value: '', label: '— none —' }], '');
    void api<readonly { unitId: string; name: string; retired: boolean }[]>(
      'GET',
      '/activities/units',
    ).then((units) => {
      for (const u of units ?? []) {
        if (u.retired) continue;
        const opt = document.createElement('option');
        opt.value = u.unitId;
        opt.textContent = u.name;
        unit.append(opt);
      }
    });
    const password = textInput('password');
    const passwordField = labelledField('Temporary password', password);
    wirePasswordEye(password);

    bodyEl.append(
      labelledField('Full name', name),
      labelledField('Post', post),
      labelledField('Phone number', phone),
      labelledField('Role', role),
      labelledField('Activities department', unit),
      passwordField,
    );
    bodyEl.append(
      text(
        'p',
        'settings-drawer-note',
        'They are made to change the password on first sign-in, so they never keep one you have seen. Only the owner may create an admin. Someone already in the contact list gets their login from their contact instead.',
      ),
    );

    const create = button('settings-btn primary', 'Create account');
    bodyEl.append(drawerActions(create));

    let close = (): void => {};
    create.addEventListener('click', () => {
      void (async () => {
        const fullName = name.value.trim();
        if (fullName === '') return name.focus();
        const number = phone.value.trim();
        if (number === '') return phone.focus();
        const pw = password.value;
        if (pw === '') return password.focus();

        create.disabled = true;
        const done = await api<{ personId: string }>('POST', '/settings/accounts', {
          fullName,
          designation: post.value.trim(),
          phone: number,
          role: role.value,
          activityUnitId: unit.value,
          password: pw,
          mustChangePassword: true,
        });
        create.disabled = false;
        if (done !== null) close();
      })();
    });

    close = openDrawer(
      'Add an account',
      'A new sign-in. A member uses Activities only; any other role is the control room. The name appears in the access log.',
      bodyEl,
    ).close;
  }

  /**
   * Run an async handler off a click without a floating promise — the `void (async () => {})()`
   * idiom `admin.ts` and `dispatch.ts` use at every one of these call sites.
   */
  function onClick(target: HTMLElement, handler: () => Promise<void>): void {
    target.addEventListener('click', () => {
      void handler();
    });
  }

  /**
   * Manage one account — a right-hand drawer, `admin.ts`'s contact drawer treatment. Every
   * action is exactly what the old per-row `Manage ▾` menu ran, in the same order, calling the
   * same endpoint with the same body; only the container is new. A successful change closes
   * the drawer, which re-reads the accounts table.
   */
  function openAccountDrawer(a: AccountView): void {
    const status = a.suspended
      ? 'Suspended'
      : a.mustChangePassword
        ? 'Must change password'
        : 'Active';

    const bodyEl = document.createElement('div');
    bodyEl.append(
      detailList([
        ['Post', a.designation ?? '—'],
        ['Phone', a.phone],
        ['Role', a.role],
        ['Status', status],
        ['Last sign-in', whenWords(a.lastSignInAt)],
      ]),
    );

    if (a.overrides.length > 0) {
      bodyEl.append(
        text(
          'p',
          'settings-drawer-note',
          'Restricted: ' +
            a.overrides.map((o) => `${o.effect === 'deny' ? '−' : '+'}${o.permission}`).join(', '),
        ),
      );
    }

    let close = (): void => {};
    const list = document.createElement('div');
    list.className = 'settings-drawer-list';

    const reset = button('settings-btn', 'Reset password');
    onClick(reset, async () => {
      const pw = await ask({
        title: `Reset ${a.fullName}'s password`,
        body: 'Forces a change on their next sign-in, and drops every session for this account now.',
        label: 'New temporary password',
        kind: 'password',
        confirm: 'Reset password',
      });
      if (pw === null || pw === '') return;
      if (
        (await api('POST', `/settings/accounts/${a.personId}/reset-password`, {
          newPassword: pw,
        })) !== null
      )
        close();
    });

    const suspendToggle = button('settings-btn', a.suspended ? 'Reactivate' : 'Suspend');
    onClick(suspendToggle, async () => {
      if (a.suspended) {
        const yes = await ask({
          title: `Reactivate ${a.fullName}`,
          body: 'They will be able to sign in again.',
          confirm: 'Reactivate',
        });
        if (yes === null) return;
        if ((await api('POST', `/settings/accounts/${a.personId}/reactivate`)) !== null) close();
        return;
      }
      const reason = await ask({
        title: `Suspend ${a.fullName}`,
        body: 'Every session for this account is dropped now. They cannot sign in until reactivated.',
        label: 'Why is this account being suspended?',
        danger: true,
        confirm: 'Suspend',
      });
      if (reason === null || reason.trim() === '') return;
      if ((await api('POST', `/settings/accounts/${a.personId}/suspend`, { reason })) !== null)
        close();
    });

    const changeRole = button('settings-btn', 'Change role');
    onClick(changeRole, async () => {
      const next = await ask({
        title: `Change ${a.fullName}'s role`,
        body: 'The owner account is handed over, not chosen here.',
        label: 'New role',
        choices: roleChoices(),
        value: a.role === 'owner' ? 'admin' : a.role,
        confirm: 'Change role',
      });
      if (next === null || next === a.role) return;
      if ((await api('PATCH', `/settings/accounts/${a.personId}/role`, { role: next })) !== null)
        close();
    });

    const restrict = button('settings-btn', 'Restrict or elevate access');
    restrict.addEventListener('click', () => openOverrides(a));

    const forceOut = button('settings-btn', 'Force sign-out');
    onClick(forceOut, async () => {
      const yes = await ask({
        title: `Force ${a.fullName} to sign out`,
        body: 'Every session for this account ends now. They keep their password.',
        confirm: 'Force sign-out',
      });
      if (yes === null) return;
      if ((await api('POST', `/settings/accounts/${a.personId}/force-logout`)) !== null) close();
    });

    const remove = button('settings-btn danger', 'Remove account');
    onClick(remove, async () => {
      const reason = await ask({
        title: `Remove ${a.fullName}'s account`,
        body:
          'The account leaves every screen. Its history and every incident it touched stay ' +
          'readable — this is not a delete. Sessions are dropped now.',
        label: 'Why is this account being removed?',
        danger: true,
        confirm: 'Remove account',
      });
      if (reason === null || reason.trim() === '') return;
      if ((await api('DELETE', `/settings/accounts/${a.personId}`, { reason })) !== null) close();
    });

    list.append(reset, suspendToggle, changeRole, restrict, forceOut, remove);
    bodyEl.append(list);

    close = openDrawer(
      `Manage ${a.fullName}`,
      'Every change is written to the access log. Sessions drop immediately where noted.',
      bodyEl,
    ).close;
  }

  /**
   * A drawer sliding in from the right, over a dimmed page — `admin.ts`'s `createDrawer()`,
   * self-contained here for the reason `settings.css`'s own note gives (2026-09-01). Built
   * fresh per call and torn down on close, since Settings never needs two open at once.
   */
  function openDrawer(title: string, sub: string, content: HTMLElement): { close(): void } {
    document.getElementById('settingsDrawerBackdrop')?.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.id = 'settingsDrawerBackdrop';

    const drawer = document.createElement('div');
    drawer.className = 'settings-drawer';

    const head = document.createElement('div');
    head.className = 'settings-drawer-head';
    const headLeft = document.createElement('div');
    headLeft.append(
      text('h4', 'settings-drawer-title', title),
      text('p', 'settings-drawer-sub', sub),
    );
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'settings-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    head.append(headLeft, closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'settings-drawer-body';
    bodyEl.append(content);

    drawer.append(head, bodyEl);
    backdrop.append(drawer);

    const close = (): void => {
      backdrop.classList.remove('open');
      backdrop.addEventListener('transitionend', () => backdrop.remove(), { once: true });
      void render();
    };
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      document.removeEventListener('keydown', onKey);
      close();
    };
    document.addEventListener('keydown', onKey);

    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));

    return { close };
  }

  /**
   * The overrides editor — *restrict access* and *elevate one account*.
   *
   * Each permission is inherit / allow / deny. A change is written immediately (`POST
   * .../permissions` or `DELETE .../permissions/:perm`), so the drawer is a live editor rather
   * than a form with a save button, and closing it re-reads the accounts table.
   */
  function openOverrides(a: AccountView): void {
    const list = document.createElement('div');
    list.className = 'settings-permlist';
    const current = new Map(a.overrides.map((o) => [o.permission, o.effect]));

    for (const p of PERMISSIONS) {
      const row = document.createElement('div');
      row.className = 'settings-permrow';
      row.append(text('span', 'settings-permlabel', p.label));

      const select = document.createElement('select');
      select.className = 'settings-askinput';
      for (const [value, label] of [
        ['inherit', 'From role'],
        ['allow', 'Allow'],
        ['deny', 'Deny'],
      ]) {
        const opt = document.createElement('option');
        opt.value = value ?? '';
        opt.textContent = label ?? '';
        select.append(opt);
      }
      select.value = current.get(p.key) ?? 'inherit';

      select.addEventListener('change', () => {
        void (async () => {
          const choice = select.value;
          const ok =
            choice === 'inherit'
              ? await api('DELETE', `/settings/accounts/${a.personId}/permissions/${p.key}`)
              : await api('POST', `/settings/accounts/${a.personId}/permissions`, {
                  permission: p.key,
                  effect: choice,
                });
          if (ok !== null) current.set(p.key, choice as 'allow' | 'deny');
        })();
      });

      row.append(select);
      list.append(row);
    }

    openDrawer(
      `Restrict or elevate ${a.fullName}`,
      'Deny always wins. An allow gives one account something its role does not; a deny takes ' +
        'something away. Clear it to fall back to the role.',
      list,
    );
  }

  async function renderAccounts(mine: number): Promise<void> {
    const accounts = await api<readonly AccountView[]>('GET', '/settings/accounts');
    if (accounts === null) return;

    setBadge('accounts', String(accounts.length));

    const wrap = document.createElement('div');
    wrap.id = 'settingsAccounts';

    const header = document.createElement('div');
    header.className = 'settings-head';
    header.append(text('h2', 'canvas-title', 'Accounts'));
    const add = button('settings-btn primary', 'Add account');
    add.addEventListener('click', () => openAddAccountDrawer());
    header.append(add);
    wrap.append(header);
    wrap.append(text('p', 'note', 'Open a row to manage that account.'));

    const table = document.createElement('table');
    table.className = 'settings-table';
    table.innerHTML =
      '<thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th>' +
      '<th>Last sign-in</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const a of accounts) {
      const tr = document.createElement('tr');
      tr.dataset['account'] = a.personId;
      makeRowOpen(tr, () => openAccountDrawer(a));

      const status = a.suspended
        ? 'Suspended'
        : a.mustChangePassword
          ? 'Must change password'
          : 'Active';

      tr.append(
        cell(a.fullName),
        cell(a.phone),
        cell(a.role),
        cell(status),
        cell(whenWords(a.lastSignInAt)),
        chevronCell(),
      );

      if (a.overrides.length > 0) {
        const note = document.createElement('tr');
        note.className = 'settings-overridenote';
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent =
          'Restricted: ' +
          a.overrides.map((o) => `${o.effect === 'deny' ? '−' : '+'}${o.permission}`).join(', ');
        note.append(td);
        tbody.append(tr, note);
      } else {
        tbody.append(tr);
      }
    }

    table.append(tbody);
    wrap.append(table);
    paint(mine, wrap);
  }

  function cell(content: string): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = content;
    return td;
  }

  //--------------------------------------------------------------------------
  // Access log — read only. Names are resolved from today's roster (a known limit).
  //--------------------------------------------------------------------------

  /** One access-log event, opened read-only — the Record's incident drawer, in small. */
  function openAccessDrawer(r: AccessRow): void {
    const bodyEl = document.createElement('div');
    bodyEl.append(
      detailList([
        ['When', new Date(r.recordedAt).toISOString().slice(0, 16).replace('T', ' ')],
        ['Type', r.type],
        ['Actor', r.actorName ?? (r.actorPersonId === null ? 'the system' : '—')],
        ['Account', r.subjectName ?? '—'],
        ['Reason', r.reason ?? '—'],
        ['Sequence', String(r.seq)],
        ['Event id', r.eventId],
      ]),
    );
    openDrawer(
      r.type,
      'Read only — the access log records every account and access change and cannot be edited.',
      bodyEl,
    );
  }

  async function renderAccess(mine: number): Promise<void> {
    const accounts = await api<readonly AccountView[]>('GET', '/settings/accounts');
    if (accounts === null) return;

    const params = new URLSearchParams();
    if (accessFilter.type !== '') params.set('type', accessFilter.type);
    if (accessFilter.subject !== '') params.set('subject', accessFilter.subject);
    if (accessFilter.since !== '') params.set('since', accessFilter.since);
    params.set('limit', '100');

    const first = await api<AccessPage>('GET', `/settings/access-log?${params.toString()}`);
    if (first === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'settingsAccess';
    wrap.append(
      text('h2', 'canvas-title', 'Access log'),
      text(
        'p',
        'note',
        'Every account and access change, newest first. Read only — open a row for the full ' +
          'record; names are shown as they read on the roster today.',
      ),
    );

    const filters = document.createElement('div');
    filters.className = 'settings-filters';

    const typeSel = labelledSelect('Type', [
      { value: '', label: 'Any type' },
      ...ACCESS_TYPES.map((t) => ({ value: t, label: t })),
    ]);
    typeSel.control.value = accessFilter.type;

    const subjSel = labelledSelect('Account', [
      { value: '', label: 'Any account' },
      ...accounts.map((a) => ({ value: a.personId, label: a.fullName })),
    ]);
    subjSel.control.value = accessFilter.subject;

    const sinceField = document.createElement('label');
    sinceField.className = 'settings-filter';
    sinceField.append(text('span', '', 'Since'));
    const sinceInput = document.createElement('input');
    sinceInput.type = 'date';
    sinceInput.className = 'settings-askinput';
    sinceInput.value = accessFilter.since;
    sinceField.append(sinceInput);

    const apply = button('settings-btn-min', 'Apply');
    apply.addEventListener('click', () => {
      accessFilter.type = typeSel.control.value;
      accessFilter.subject = subjSel.control.value;
      accessFilter.since = sinceInput.value;
      void render();
    });
    const clear = button('settings-btn-min', 'Clear');
    clear.addEventListener('click', () => {
      accessFilter.type = '';
      accessFilter.subject = '';
      accessFilter.since = '';
      void render();
    });

    filters.append(typeSel.field, subjSel.field, sinceField, apply, clear);
    wrap.append(filters);

    const table = document.createElement('table');
    table.className = 'settings-table';
    table.innerHTML =
      '<thead><tr><th>When</th><th>Type</th><th>Actor</th><th>Account</th><th>Reason</th>' +
      '<th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    table.append(tbody);

    const appendRows = (rows: readonly AccessRow[]): void => {
      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.dataset['access'] = r.eventId;
        makeRowOpen(tr, () => openAccessDrawer(r));
        tr.append(
          cell(new Date(r.recordedAt).toISOString().slice(0, 16).replace('T', ' ')),
          cell(r.type),
          cell(r.actorName ?? (r.actorPersonId === null ? 'the system' : '—')),
          cell(r.subjectName ?? '—'),
          cell(r.reason ?? ''),
          chevronCell(),
        );
        tbody.append(tr);
      }
    };
    appendRows(first.rows);

    if (first.rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'note';
      td.textContent = 'Nothing recorded for this filter.';
      tr.append(td);
      tbody.append(tr);
    }

    wrap.append(table);

    let cursor = first.nextBeforeSeq;
    if (cursor !== null) {
      const more = button('settings-btn-min', 'Load more');
      onClick(more, async () => {
        if (cursor === null) return;
        const next = await api<AccessPage>(
          'GET',
          `/settings/access-log?${params.toString()}&beforeSeq=${String(cursor)}`,
        );
        if (next === null) return;
        appendRows(next.rows);
        cursor = next.nextBeforeSeq;
        if (cursor === null) more.remove();
      });
      wrap.append(more);
    }

    paint(mine, wrap);
  }

  function labelledSelect(
    label: string,
    options: readonly { readonly value: string; readonly label: string }[],
  ): { field: HTMLElement; control: HTMLSelectElement } {
    const field = document.createElement('label');
    field.className = 'settings-filter';
    field.append(text('span', '', label));
    const control = document.createElement('select');
    control.className = 'settings-askinput';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      control.append(opt);
    }
    field.append(control);
    return { field, control };
  }

  //--------------------------------------------------------------------------
  // Security policy — READ ONLY for now (ADR-0032 phase 3, the owner's call).
  //--------------------------------------------------------------------------

  function openSecurityDrawer(name: string, value: string, explains: string): void {
    const bodyEl = document.createElement('div');
    bodyEl.append(
      detailList([
        ['Setting', name],
        ['Current value', value],
      ]),
    );
    bodyEl.append(text('p', 'settings-drawer-para', explains));
    bodyEl.append(
      text(
        'p',
        'settings-drawer-note',
        'Read only in this release. Making these editable — with floors the owner alone may ' +
          'lower — is its own step.',
      ),
    );
    openDrawer(name, 'What every account is held to.', bodyEl);
  }

  async function renderSecurity(mine: number): Promise<void> {
    const policy = await api<SecurityPolicyView>('GET', '/settings/security-policy');
    if (policy === null) return;

    const wrap = document.createElement('div');
    wrap.id = 'settingsSecurity';
    wrap.append(
      text('h2', 'canvas-title', 'Security policy'),
      text(
        'p',
        'note',
        'What every account is held to. Read only in this release — open a row for what each ' +
          'setting means.',
      ),
    );

    const table = document.createElement('table');
    table.className = 'settings-table';
    const tbody = document.createElement('tbody');
    const row = (name: string, value: string, explains: string): void => {
      const tr = document.createElement('tr');
      makeRowOpen(tr, () => openSecurityDrawer(name, value, explains));
      tr.append(cell(name), cell(value), chevronCell());
      tbody.append(tr);
    };
    row(
      'Minimum password length',
      `${String(policy.minPasswordLength)} characters`,
      'Every new or changed password must be at least this long. The floor is one value the ' +
        'whole installation shares.',
    );
    row(
      'Session length',
      `${String(policy.sessionTtlHours)} hours`,
      'How long a sign-in lasts before it must be renewed. `Force sign-out` ends every session ' +
        'for one account before this expires.',
    );
    table.append(tbody);
    wrap.append(table);
    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Which screens are on — ADR-0016, moved here from Administration (ADR-0032 phase 4).
  //--------------------------------------------------------------------------

  /**
   * One installation screen, opened as a drawer with its own turn-on / turn-off button. The
   * button still routes through `ask()` — the consequence is stated before the act (M10-17) —
   * and `POST /settings/capabilities` is unchanged.
   */
  function openCapabilityDrawer(c: CapabilityRow): void {
    const bodyEl = document.createElement('div');
    bodyEl.append(text('p', 'settings-drawer-para', c.what));
    bodyEl.append(
      detailList([
        ['Status', c.offered ? 'On — shown in the navigation menu' : 'Off — hidden from the menu'],
      ]),
    );

    const toggle = button(
      c.offered ? 'settings-btn danger' : 'settings-btn primary',
      c.offered ? 'Turn off' : 'Turn on',
    );

    let close = (): void => {};
    onClick(toggle, async () => {
      const yes = await ask({
        title: c.offered ? `Turn off ${c.name}` : `Turn on ${c.name}`,
        body: c.offered
          ? 'It leaves the navigation menu. Nothing is revoked and nothing recorded through ' +
            'it is lost — every endpoint behind it still refuses exactly what it refused before.'
          : 'It appears in the navigation menu. Every endpoint behind it still asks the policy ' +
            'table for itself.',
        confirm: c.offered ? 'Turn off' : 'Turn on',
        danger: c.offered,
      });
      if (yes === null) return;
      if (
        (await api('POST', '/settings/capabilities', {
          capability: c.id,
          offered: !c.offered,
        })) !== null
      )
        close();
    });

    bodyEl.append(drawerActions(toggle));
    close = openDrawer(
      c.name,
      'What people are shown on navigation — not what they are allowed to do.',
      bodyEl,
    ).close;
  }

  async function renderCapabilities(mine: number): Promise<void> {
    const data = await api<CapabilitiesView>('GET', '/settings/capabilities');
    if (data === null) return;

    setBadge(
      'capabilities',
      `${String(data.capabilities.filter((c) => c.offered).length)}/${String(
        data.capabilities.length,
      )}`,
    );

    const wrap = document.createElement('div');
    wrap.id = 'settingsCapabilities';
    wrap.append(
      text('h2', 'canvas-title', 'Which screens are on'),
      text(
        'p',
        'note',
        'What people are shown on navigation — not what they are allowed to do. Open a row to ' +
          'turn a screen on or off; turning one off tidies the menu and revokes nothing.',
      ),
    );
    if (!data.chosen) {
      wrap.append(
        text(
          'p',
          'note',
          'Nobody has chosen yet — this is the shape the product ships with (the control room, ' +
            'and nothing else).',
        ),
      );
    }

    const table = document.createElement('table');
    table.className = 'settings-table';
    table.innerHTML = '<thead><tr><th>Screen</th><th>Status</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const c of data.capabilities) {
      const tr = document.createElement('tr');
      tr.dataset['capability'] = c.id;
      makeRowOpen(tr, () => openCapabilityDrawer(c));

      const first = document.createElement('td');
      first.append(text('div', 'settings-capname', c.name), text('div', 'note', c.what));

      tr.append(first, cell(c.offered ? 'On' : 'Off'), chevronCell());
      tbody.append(tr);
    }

    table.append(tbody);
    wrap.append(table);
    paint(mine, wrap);
  }

  //--------------------------------------------------------------------------
  // Dashboard layout — ADR-0015, moved here from Administration (ADR-0032 phase 4).
  //--------------------------------------------------------------------------

  /** The working arrangement, so the whole thing is one save rather than a request per drag. */
  let draft: Placed[] = [];

  async function renderLayout(mine: number): Promise<void> {
    const data = await api<LayoutView>('GET', '/settings/dashboard-layout');
    if (data === null) return;
    draft = data.layout.map((p) => ({ ...p }));
    setBadge('layout', String(draft.length));
    paint(mine, layoutEditor(data, mine));
  }

  async function saveLayoutDraft(mine: number): Promise<void> {
    if (draft.length === 0) {
      // The server refuses this too — a dashboard with nothing on it renders as the default
      // anyway, so saving it would be a decision the district cannot see it made.
      fail('a dashboard needs at least one panel');
      await renderLayout(mine);
      return;
    }
    const saved = await api<LayoutView>('PUT', '/settings/dashboard-layout', {
      layout: { panels: draft },
    });
    if (saved === null) return;
    draft = saved.layout.map((p) => ({ ...p }));
    setBadge('layout', String(draft.length));
    paint(mine, layoutEditor(saved, mine));
  }

  /**
   * One placed panel, opened as a drawer: change its size, move it, or take it off the wall.
   * Every one of these was an inline control on the row before (2026-09-01); the mutation of
   * `draft` and the `PUT /settings/dashboard-layout` that follows are unchanged. A change
   * closes the drawer, which re-reads the layout so the row's stated position stays honest.
   */
  function openPanelDrawer(data: LayoutView, index: number, mine: number): void {
    const placed = draft[index];
    if (placed === undefined) return;
    const named = new Map(data.available.map((p) => [p.id, p]));
    const def = named.get(placed.id) ?? {
      id: placed.id,
      name: placed.id,
      what: '',
      audience: '',
      sizes: ['small', 'medium', 'large'],
    };

    const bodyEl = document.createElement('div');
    bodyEl.append(
      detailList([
        ['Panel', def.name],
        ['What', def.what !== '' ? def.what : '—'],
        ['Position', `${String(index + 1)} of ${String(draft.length)}`],
      ]),
    );

    let close = (): void => {};

    const sizeSel = choiceSelect(
      def.sizes.map((s) => ({ value: s, label: s })),
      placed.size,
    );
    bodyEl.append(labelledField('Size', sizeSel));
    sizeSel.addEventListener('change', () => {
      const here = draft[index];
      if (here === undefined) return;
      draft[index] = { id: here.id, size: sizeSel.value };
      void (async () => {
        await saveLayoutDraft(mine);
        close();
      })();
    });

    const list = document.createElement('div');
    list.className = 'settings-drawer-list';

    const up = button('settings-btn', 'Move up');
    up.disabled = index === 0;
    onClick(up, async () => {
      const above = draft[index - 1];
      const here = draft[index];
      if (above === undefined || here === undefined) return;
      draft[index - 1] = here;
      draft[index] = above;
      await saveLayoutDraft(mine);
      close();
    });

    const down = button('settings-btn', 'Move down');
    down.disabled = index === draft.length - 1;
    onClick(down, async () => {
      const below = draft[index + 1];
      const here = draft[index];
      if (below === undefined || here === undefined) return;
      draft[index + 1] = here;
      draft[index] = below;
      await saveLayoutDraft(mine);
      close();
    });

    const remove = button('settings-btn danger', 'Remove from the wall');
    onClick(remove, async () => {
      draft = draft.filter((_, at) => at !== index);
      await saveLayoutDraft(mine);
      close();
    });

    list.append(up, down, remove);
    bodyEl.append(list);

    close = openDrawer(
      def.name,
      'Where this sits on the 1920×1080 control-room wall.',
      bodyEl,
    ).close;
  }

  function layoutEditor(data: LayoutView, mine: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.id = 'settingsLayout';
    wrap.append(
      text('h2', 'canvas-title', 'Dashboard layout'),
      text(
        'p',
        'note',
        'What is on the control-room wall (1920×1080), in order. Open a row to change its size, ' +
          'move it, or take it off. An overflowing arrangement is accepted — this system does ' +
          'not decide what fits on your own television.',
      ),
    );
    if (data.isDefault) {
      wrap.append(
        text(
          'p',
          'note',
          'Nobody has arranged this yet — you are looking at the built-in default.',
        ),
      );
    }

    const fit = document.createElement('p');
    fit.className = 'settings-fit';
    fit.dataset['overflows'] = data.overflows ? 'true' : 'false';
    fit.textContent = data.overflows
      ? `About ${String(data.slots)} panels' worth — more than a 1920×1080 screen shows without scrolling.`
      : `About ${String(data.slots)} panels — fits a 1920×1080 wall without scrolling.`;
    wrap.append(fit);

    for (const p of data.problems) {
      wrap.append(text('p', 'settings-fit', `${p.panelId}: ${p.why}`));
    }

    const named = new Map(data.available.map((p) => [p.id, p]));

    const table = document.createElement('table');
    table.className = 'settings-table';
    table.innerHTML = '<thead><tr><th>Panel</th><th>Size</th><th>Order</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');

    draft.forEach((placed, index) => {
      const def = named.get(placed.id) ?? {
        id: placed.id,
        name: placed.id,
        what: '',
        audience: '',
        sizes: ['small', 'medium', 'large'],
      };
      const tr = document.createElement('tr');
      tr.dataset['panel'] = placed.id;
      makeRowOpen(tr, () => openPanelDrawer(data, index, mine));

      const nameCell = document.createElement('td');
      nameCell.append(text('div', 'settings-capname', def.name));
      if (def.what !== '') nameCell.append(text('div', 'note', def.what));

      tr.append(
        nameCell,
        cell(placed.size),
        cell(`${String(index + 1)} of ${String(draft.length)}`),
        chevronCell(),
      );
      tbody.append(tr);
    });

    table.append(tbody);
    wrap.append(table);

    // Add a panel that is not already placed.
    const rest = data.available.filter((p) => !draft.some((d) => d.id === p.id));
    if (rest.length > 0) {
      const addRow = document.createElement('div');
      addRow.className = 'settings-head';
      const addSel = document.createElement('select');
      addSel.className = 'settings-askinput';
      addSel.id = 'settingsLayoutAdd';
      for (const p of rest) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        addSel.append(opt);
      }
      const addBtn = button('settings-btn primary', 'Add panel');
      onClick(addBtn, async () => {
        const def = rest.find((p) => p.id === addSel.value);
        if (def === undefined) return;
        draft = [...draft, { id: def.id, size: def.sizes[0] ?? 'medium' }];
        await saveLayoutDraft(mine);
      });
      addRow.append(addSel, addBtn);
      wrap.append(addRow);
    }

    // What the television will show. The shell styles `#layoutPreview` / `#layoutPreviewFrame`.
    const preview = document.createElement('div');
    preview.id = 'layoutPreview';
    preview.append(
      text('h4', 'sectionhead', 'What the television will show'),
      text('p', 'note', '1920×1080, scaled to this window. Televisions crop the edges.'),
    );
    const frame = document.createElement('iframe');
    frame.id = 'layoutPreviewFrame';
    frame.src = '/#dashboard';
    frame.title = 'The dashboard at 1920×1080';
    preview.append(frame);
    const fitLabel = document.createElement('label');
    fitLabel.className = 'note';
    const overscan = document.createElement('input');
    overscan.type = 'checkbox';
    overscan.id = 'layoutOverscan';
    overscan.addEventListener('change', () => {
      frame.classList.toggle('overscan', overscan.checked);
    });
    fitLabel.append(
      overscan,
      document.createTextNode(' Show what a television crops (5% overscan)'),
    );
    preview.append(fitLabel);
    wrap.append(preview);

    return wrap;
  }

  //--------------------------------------------------------------------------
  // Nav + render
  //--------------------------------------------------------------------------

  function buildTabs(): void {
    tabs.replaceChildren();
    badgeSpans.clear();
    for (const { group, items } of TAB_GROUPS) {
      const box = document.createElement('div');
      box.className = 'settings-tabgroup';
      if (group !== null) box.append(text('span', 'settings-tabgroupname', group));

      for (const t of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset['tab'] = t.id;
        b.setAttribute('aria-current', t.id === tab ? 'page' : 'false');
        b.append(text('span', 'settings-rail-label', t.label));
        const badge = text('span', 'settings-badge', RAIL_BADGES[t.id]);
        badgeSpans.set(t.id, badge);
        b.append(badge);
        b.addEventListener('click', () => go(t.id));
        box.append(b);
      }
      tabs.append(box);
    }
  }

  function go(next: SettingsTab): void {
    tab = next;
    void render();
  }

  async function render(): Promise<void> {
    generation += 1;
    const mine = generation;
    for (const b of Array.from(tabs.querySelectorAll('button'))) {
      b.setAttribute('aria-current', b.dataset['tab'] === tab ? 'page' : 'false');
    }
    body.replaceChildren(text('p', 'note', 'Loading…'));

    if (tab === 'overview') await renderOverview(mine);
    else if (tab === 'accounts') await renderAccounts(mine);
    else if (tab === 'access') await renderAccess(mine);
    else if (tab === 'security') await renderSecurity(mine);
    else if (tab === 'capabilities') await renderCapabilities(mine);
    else await renderLayout(mine);
  }

  buildTabs();

  return {
    refresh: render,
    show(next?: SettingsTab): void {
      if (next !== undefined) tab = next;
      view.hidden = false;
      buildTabs();
      void render();
    },
  };
}
