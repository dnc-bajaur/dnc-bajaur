/**
 * One right-hand drawer, built once and shared.
 *
 * ## Why this file exists
 *
 * The app already slides a panel in from the right in three places and each one carries its
 * own copy of the mechanism: `admin.ts`'s `createDrawer()`, `settings.ts`'s private
 * `openDrawer`, and the Record's `#detailView` wired by hand in `main.ts`. They agree to about
 * ninety per cent — the widths, the easing and the close button all differ by a few pixels —
 * and changing the behaviour means editing three files. The dashboard's *expand a panel into a
 * drawer* (ADR-0036) is a fourth caller, and a fourth copy is the wrong way to add it.
 *
 * So the behaviour lives here once: backdrop, slide, Escape, click-outside, focus handling,
 * and a single-instance rule. The **look** is the shell's `.od-*` block in `index.html`, which
 * reuses the same tokens and the same measurements the Record's drawer already uses.
 *
 * ⚠️ **The Record's `#detailView` is deliberately NOT folded onto this yet.** It is welded to
 * one incident — it fetches `/incidents/:id`, drives `showView('detail')`, and its markup has
 * `timeline` / `whoTold` / `#takeAction` children a generic drawer knows nothing about.
 * Converging it is a separate change with its own risk; ADR-0036 records it as future work.
 *
 * ## What a caller gets
 *
 * `openDrawer({ title })` returns `{ body, close }`. The caller fills `body` with whatever it
 * wants shown and calls `close()` — or the viewer does, with Escape, the ✕, or a click on the
 * backdrop. `onClose` runs on every one of those paths, which is where the dashboard moves its
 * borrowed list node back where it came from.
 */

/** The handle a caller holds while its drawer is open. */
export interface DrawerHandle {
  /** The scroll region the caller fills. Emptied when the drawer closes. */
  readonly body: HTMLElement;
  /** Close it from code. Idempotent, and runs `onClose` exactly once. */
  close(): void;
}

export interface DrawerOptions {
  /** The heading, in the caller's own words. */
  title: string;
  /** A quiet second line under the title — an age, a count. Omitted leaves the line out. */
  sub?: string | undefined;
  /**
   * Runs once, on whichever close happened first — code, ✕, Escape or the backdrop. The
   * dashboard uses it to put its moved list node back before the drawer element goes away.
   */
  onClose?: (() => void) | undefined;
  /**
   * Focus lands here when the drawer closes. Passing the control that opened it keeps a
   * keyboard user where they were; omitted, focus is left alone.
   */
  returnFocusTo?: HTMLElement | null | undefined;
}

interface OpenState {
  backdrop: HTMLElement;
  onClose: (() => void) | undefined;
  returnFocusTo: HTMLElement | null | undefined;
  onKey: (event: KeyboardEvent) => void;
  closed: boolean;
}

/**
 * At most one drawer at a time.
 *
 * A second `openDrawer` while one is up closes the first — running its `onClose`, so nothing
 * it borrowed is stranded — and then opens fresh. Two stacked right-hand panels is not a
 * shape this app has anywhere, and letting them stack would leave the earlier one's `onClose`
 * owing.
 */
let open: OpenState | null = null;

const SLIDE_MS = 280;

function build(options: DrawerOptions): {
  backdrop: HTMLElement;
  body: HTMLElement;
  close: HTMLElement;
} {
  const backdrop = document.createElement('div');
  backdrop.className = 'od-backdrop';

  const drawer = document.createElement('div');
  drawer.className = 'od-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', options.title);

  const head = document.createElement('div');
  head.className = 'od-head';

  const titles = document.createElement('div');
  titles.className = 'od-titlewrap';

  const title = document.createElement('h3');
  title.className = 'od-title';
  title.textContent = options.title;
  titles.append(title);

  if (options.sub !== undefined && options.sub !== '') {
    const sub = document.createElement('p');
    sub.className = 'od-sub';
    sub.textContent = options.sub;
    titles.append(sub);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'od-close';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '&times;';

  head.append(titles, close);

  const body = document.createElement('div');
  body.className = 'od-body';

  drawer.append(head, body);
  backdrop.append(drawer);

  return { backdrop, body, close };
}

/**
 * Close whatever is open now.
 *
 * Runs `onClose` first — synchronously, before the element is touched — so the caller's
 * teardown (the dashboard putting its list back) happens while the DOM is still settled, then
 * slides the now-empty drawer out and removes it. Safe to call with nothing open.
 */
export function closeDrawer(): void {
  const state = open;
  if (state === null || state.closed) return;
  state.closed = true;
  open = null;

  document.removeEventListener('keydown', state.onKey, true);

  // The caller's teardown before the visual exit: it moves a live node out of `.od-body`, and
  // doing that while the drawer is still on screen avoids a frame of it sliding out full.
  try {
    state.onClose?.();
  } finally {
    state.backdrop.classList.remove('od-open');
    window.setTimeout(() => state.backdrop.remove(), SLIDE_MS);

    const target = state.returnFocusTo;
    if (target !== null && target !== undefined && document.contains(target)) {
      target.focus();
    }
  }
}

export function openDrawer(options: DrawerOptions): DrawerHandle {
  // One at a time — the earlier drawer's `onClose` is honoured by `closeDrawer`.
  closeDrawer();

  const { backdrop, body, close } = build(options);

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer();
    }
  };

  open = {
    backdrop,
    onClose: options.onClose,
    returnFocusTo: options.returnFocusTo,
    onKey,
    closed: false,
  };

  close.addEventListener('click', () => closeDrawer());
  backdrop.addEventListener('click', (event) => {
    // Only a click on the backdrop itself, never one that bubbled up from inside the drawer.
    if (event.target === backdrop) closeDrawer();
  });
  document.addEventListener('keydown', onKey, true);

  document.body.append(backdrop);

  // Two frames: the element has to be in the document at its off-screen transform before the
  // class that animates it to zero is added, or there is nothing to transition from.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => backdrop.classList.add('od-open'));
  });

  close.focus();

  return {
    body,
    close: () => closeDrawer(),
  };
}
