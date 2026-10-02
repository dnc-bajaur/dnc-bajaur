/**
 * "Install this app" — a banner offering to put the app on the home screen (Bajaur, PLAN §4 A).
 *
 * Officers open this on a phone, from a link. Installed, it opens full-screen from an icon like
 * any other app; left as a browser tab, it is lost among the tabs. So both pages that people
 * land on — the shell and Activities — offer it, once, until it is installed or turned down.
 *
 * Three cases, decided by what the browser can do rather than by guessing the device:
 *
 *   * **Chrome / Edge (Android, Windows)** fire `beforeinstallprompt` when the page is
 *     installable (manifest with 192 + 512 icons, served over HTTPS). The event is kept and the
 *     banner's button replays it — one tap, the browser's own dialog.
 *   * **iPhone / iPad** have no such event and never will; Safari installs only through
 *     Share → Add to Home Screen. The banner says exactly that.
 *   * **Anything else** — Firefox on a desktop, a plain-HTTP address — gets nothing. A button
 *     that cannot do anything is worse than no button.
 *
 * Already installed (opened from the icon) → nothing. "Not now" is remembered in this browser
 * for 14 days: a convenience for one viewer, so `localStorage`, and the banner still works if
 * storage is blocked.
 *
 * Nothing here is security or state: it is an offer. It changes nothing on the server.
 */

/** The browser's install event. Not in TypeScript's DOM types, because it is not a standard. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'dnc-bajaur.installDismissedAt';
const QUIET_DAYS = 14;
const BANNER_ID = 'installBanner';

function installed(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < QUIET_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the banner comes back next visit, which is the safe direction.
  }
}

/** iPhone, iPod, and an iPad that reports itself as a Mac (iPadOS 13+). */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const STYLE = `
#${BANNER_ID} {
  position: fixed; z-index: 50; left: 16px; right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  max-width: 420px; margin-left: auto;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); color: var(--ink);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.18); font-size: 0.9rem; line-height: 1.4;
}
#${BANNER_ID} .install-text { flex: 1 1 200px; margin: 0; }
#${BANNER_ID} .install-text strong { display: block; }
#${BANNER_ID} .install-text span { color: var(--muted); }
#${BANNER_ID} .install-actions { display: flex; gap: 8px; margin-left: auto; }
#${BANNER_ID} button {
  font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--ink);
}
#${BANNER_ID} button.install-yes {
  background: var(--primary-fill, var(--primary)); border-color: var(--primary-fill, var(--primary));
  color: var(--on-accent);
}
@media print { #${BANNER_ID} { display: none; } }
`;

function line(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

function show(detail: string, onInstall: (() => void) | null): void {
  if (document.getElementById(BANNER_ID) !== null) return;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);

  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Install this app');

  const text = document.createElement('p');
  text.className = 'install-text';
  text.append(line('strong', '', 'Install this app'), line('span', '', detail));

  const actions = document.createElement('div');
  actions.className = 'install-actions';

  const later = line('button', 'install-later', 'Not now');
  (later as HTMLButtonElement).type = 'button';
  later.addEventListener('click', () => {
    rememberDismissed();
    banner.remove();
  });
  actions.append(later);

  if (onInstall !== null) {
    const yes = line('button', 'install-yes', 'Install');
    (yes as HTMLButtonElement).type = 'button';
    yes.addEventListener('click', onInstall);
    actions.append(yes);
  }

  banner.append(text, actions);
  document.body.append(banner);
}

function hide(): void {
  document.getElementById(BANNER_ID)?.remove();
}

export function offerInstall(): void {
  if (installed() || recentlyDismissed()) return;

  if (isIos()) {
    show('Tap Share, then “Add to Home Screen”.', null);
    return;
  }

  addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own mini-bar from appearing as well; the banner is the one offer.
    event.preventDefault();
    const prompt = event as InstallPromptEvent;
    show('Opens from an icon, in its own window — like any other app.', () => {
      void (async () => {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        // Turned down in the browser's own dialog counts as "Not now".
        if (choice.outcome === 'dismissed') rememberDismissed();
        hide();
      })();
    });
  });

  addEventListener('appinstalled', hide);
}
