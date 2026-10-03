/**
 * Activities — the page a `member` account lives on (ADR-0038 / ADR-0039, Bajaur — C1–C3).
 *
 * Posts with photos and videos, filtered by department, person and date; the Department list; the
 * Officers list (everyone who posts: department, Activities on/off, Give login); the Recycle bin;
 * the log; and the account's own password and default department.
 *
 * Nothing here enforces anything. The server decides what this account may do (INV-05): this
 * page reads `/activities/me` to know which tabs and buttons to draw, and every action is asked
 * again on the server. Everything from the server is put on the page with `textContent` — never
 * `innerHTML` — because names and captions are typed by people.
 *
 * Photos are shrunk on the phone before they leave it (ADR-0039 §4): long edge 2048 px, JPEG
 * at high quality, plus a 480 px copy for the list. Re-encoding through a canvas also drops the
 * photo's embedded location and camera data, which nobody asked to publish.
 *
 * Videos are not touched on the phone (ADR-0039 rejects it: slow, heavy on the battery, and
 * unreliable across browsers). They go as they are, in chunks, and a dropped connection carries
 * on from the last chunk that arrived. The server converts them to 720p.
 */

import { offerInstall } from './install.js';
import { dateLocale, drawLangSwitch, startUrdu } from './i18n.js';

interface Me {
  readonly personId: string;
  readonly fullName: string;
  readonly role: string;
  readonly mustChangePassword: boolean;
  readonly permissions: readonly string[];
  readonly defaultUnitId: string | null;
  readonly today: string;
}

interface Unit {
  readonly unitId: string;
  readonly name: string;
  readonly retired: boolean;
}

interface Person {
  readonly personId: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly defaultUnitId: string | null;
}

/** Everyone who posts, for the DC (ADR-0041 §9). */
interface Officer {
  readonly personId: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly phone: string;
  readonly defaultUnitId: string | null;
  readonly inDirectory: boolean;
  readonly role: string | null;
  readonly suspended: boolean;
  readonly placeholder: boolean;
  readonly activitiesOn: boolean;
  /** The newest sign-in link (ADR-0043). */
  readonly link: {
    readonly state: 'waiting' | 'used' | 'expired' | 'cancelled';
    readonly sentVia: 'whatsapp' | 'by_hand' | 'failed';
  } | null;
}

/** How a sign-in link went out — what the DC is told at once (ADR-0043, INV-03). */
interface LinkSent {
  readonly sentVia: 'whatsapp' | 'by_hand' | 'failed';
  readonly failure: string | null;
  /** Only when it did not go by WhatsApp: for the DC to send by hand. */
  readonly url: string | null;
  readonly expiresAt: string;
}

interface Post {
  readonly postId: string;
  readonly unitName: string;
  readonly authorName: string;
  readonly authorDesignation: string | null;
  readonly activityDate: string;
  readonly caption: string;
  readonly place: string | null;
  readonly createdAt: string;
  readonly hiddenAt: string | null;
  readonly expiresAt: string;
  readonly photos: readonly { readonly mediaId: string; readonly hasThumb: boolean }[];
  readonly videos: readonly Video[];
  /** Voice notes, sent by WhatsApp (ADR-0041). */
  readonly audios: readonly { readonly mediaId: string }[];
  readonly mayDelete: boolean;
  readonly mayModerate: boolean;
  /** Sent to the district's WhatsApp number rather than posted here (ADR-0040). */
  readonly source: 'app' | 'whatsapp';
  readonly mayChangeDate: boolean;
}

/** WhatsApp media waiting for the DC (ADR-0040). */
interface PendingGroup {
  readonly inboundId: string;
  readonly fromPhone: string;
  readonly reason: 'unknown_sender' | 'no_department' | 'not_allowed' | 'no_answer';
  readonly personId: string | null;
  readonly personName: string | null;
  readonly suggestedUnitId: string | null;
  readonly incidentReference: string | null;
  readonly receivedAt: string;
  readonly activityDate: string;
  readonly captions: readonly string[];
  readonly messages: readonly string[];
  readonly media: readonly {
    readonly mediaId: string;
    readonly kind: 'photo' | 'video' | 'audio';
  }[];
  readonly expiresAt: string;
}

interface Video {
  readonly mediaId: string;
  readonly status: 'uploading' | 'processing' | 'ready' | 'failed';
  readonly durationSeconds: number | null;
  readonly failure: string | null;
  readonly hasPoster: boolean;
}

interface UploadState {
  readonly mediaId: string;
  readonly status: Video['status'];
  readonly received: number;
  readonly bytes: number;
  readonly chunkBytes: number;
}

interface Expiring {
  readonly retentionDays: number;
  readonly warningDays: number;
  readonly posts: number;
  readonly photos: number;
  readonly videos: number;
  readonly bytes: number;
  readonly firstExpiresAt: string | null;
  readonly zipFits: boolean;
  readonly conversion: { readonly waiting: number; readonly failed: number };
  readonly backup: {
    readonly configured: boolean;
    readonly why: string | null;
    readonly notCopied: number;
    readonly removalsWaiting: number;
    readonly lastError: string | null;
  };
}

interface LogLine {
  readonly type: string;
  readonly actorName: string | null;
  readonly unitName: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly recordedAt: string;
}

const MAX_PHOTOS = 10;
const MAX_VIDEOS = 3;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 180;
const LONG_EDGE = 2048;
const THUMB_EDGE = 480;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`#${id} is missing from activities.html`);
  return found as T;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

/** What someone wrote — a caption, a name — stays as written in Urdu too (E4). */
function untranslated<T extends HTMLElement>(node: T): T {
  node.setAttribute('translate', 'no');
  node.dir = 'auto'; // English words in an Urdu page, or Urdu in an English one, read the right way
  return node;
}

function button(label: string, className?: string): HTMLButtonElement {
  const b = make('button', className, label);
  b.type = 'button';
  return b;
}

/** The server's error text, or a plain one. Thrown so callers can show it where they are. */
class ApiError extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 401) {
    location.replace('/');
    throw new ApiError('Signed out.');
  }
  const parsed = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    throw new ApiError(
      typeof parsed?.error === 'string' ? parsed.error : `The server refused (${res.status}).`,
    );
  }
  return parsed as T;
}

function showError(target: HTMLElement, e: unknown): void {
  target.textContent = e instanceof Error ? e.message : String(e);
  target.hidden = false;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function day(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(dateLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

//------------------------------------------------------------------------------
// State
//------------------------------------------------------------------------------

let me: Me;
let units: Unit[] = [];
let people: Person[] = [];
const can = (p: string): boolean => me.permissions.includes(`activities.${p}`);

//------------------------------------------------------------------------------
// Tabs
//------------------------------------------------------------------------------

// E3: fewer tabs. The DC sees Activities · New post · Pending (with its count) · Officers (the
// Department list sits under it) · History (Log and Recycle bin) · My account; a member sees
// Activities · New post · My account. Which tabs exist still follows the permissions — the server
// refuses everything else regardless.
type Tab = 'posts' | 'new' | 'pending' | 'officers' | 'history' | 'account';

const TAB_LABEL: Readonly<Record<Tab, string>> = {
  posts: 'Activities',
  new: 'New post',
  pending: 'Pending',
  officers: 'Officers',
  history: 'History',
  account: 'My account',
};

function tabsFor(): Tab[] {
  const tabs: Tab[] = ['posts'];
  if (can('upload')) tabs.push('new');
  if (can('pending')) tabs.push('pending');
  if (can('departments')) tabs.push('officers');
  if (can('moderate')) tabs.push('history');
  tabs.push('account');
  return tabs;
}

function show(tab: Tab): void {
  for (const t of Object.keys(TAB_LABEL) as Tab[]) el(`view-${t}`).hidden = t !== tab;
  for (const b of Array.from(el('tabs').querySelectorAll('button'))) {
    if (b.dataset['tab'] === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (tab === 'posts') {
    void loadFeed(false);
    void loadExpiring();
  }
  if (tab === 'pending') void loadPending();
  if (tab === 'officers') {
    void loadOfficers();
    drawUnits();
  }
  if (tab === 'history') showHistory(historyPart);
}

/** History holds two lists; the log is shown first. */
type HistoryPart = 'log' | 'bin';
let historyPart: HistoryPart = 'log';

function showHistory(part: HistoryPart): void {
  historyPart = part;
  el('history-log').hidden = part !== 'log';
  el('history-bin').hidden = part !== 'bin';
  for (const b of Array.from(el('historyPick').querySelectorAll('button'))) {
    b.setAttribute('aria-pressed', String(b.dataset['part'] === part));
  }
  if (part === 'log') void loadLog();
  else void loadBin();
}

for (const b of Array.from(el('historyPick').querySelectorAll('button'))) {
  b.addEventListener('click', () => showHistory(b.dataset['part'] === 'bin' ? 'bin' : 'log'));
}

/** The Pending tab carries its count, so the DC sees there is something without opening it. */
function setPendingCount(count: number): void {
  const b = el('tabs').querySelector<HTMLButtonElement>('button[data-tab="pending"]');
  if (b === null) return;
  b.textContent = count > 0 ? `${TAB_LABEL.pending} (${count})` : TAB_LABEL.pending;
}

async function refreshPendingCount(): Promise<void> {
  if (!can('pending')) return;
  try {
    setPendingCount((await api<PendingGroup[]>('GET', '/activities/pending')).length);
  } catch {
    // The count is a convenience; the tab itself still opens and shows any error.
  }
}

/**
 * The count keeps itself current: asked again every minute while the page is in front, and at
 * once when the DC comes back to it. Something sent on WhatsApp shows on the tab without a reload.
 * A hidden page asks nothing.
 */
const PENDING_EVERY_MS = 60_000;

function watchPendingCount(): void {
  if (!can('pending')) return;
  setInterval(() => {
    if (document.visibilityState === 'visible') void refreshPendingCount();
  }, PENDING_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshPendingCount();
  });
}

//------------------------------------------------------------------------------
// Department and person selects
//------------------------------------------------------------------------------

function fillSelect(
  select: HTMLSelectElement,
  options: readonly { value: string; label: string }[],
  value: string,
): void {
  select.replaceChildren(
    ...options.map((o) => {
      const opt = make('option', undefined, o.label);
      opt.value = o.value;
      return opt;
    }),
  );
  select.value = value;
}

const liveUnits = (): Unit[] => units.filter((u) => !u.retired);

function fillUnitSelects(): void {
  fillSelect(
    el<HTMLSelectElement>('fUnit'),
    [
      { value: '', label: 'All departments' },
      ...units.map((u) => ({ value: u.unitId, label: u.name })),
    ],
    el<HTMLSelectElement>('fUnit').value,
  );
  const live = liveUnits().map((u) => ({ value: u.unitId, label: u.name }));
  fillSelect(
    el<HTMLSelectElement>('pUnit'),
    [{ value: '', label: 'Choose a department' }, ...live],
    me.defaultUnitId ?? '',
  );
  fillSelect(
    el<HTMLSelectElement>('myUnit'),
    [{ value: '', label: '— none —' }, ...live],
    me.defaultUnitId ?? '',
  );
}

async function loadUnits(): Promise<void> {
  units = await api<Unit[]>('GET', '/activities/units');
  fillUnitSelects();
}

async function loadPeople(): Promise<void> {
  if (!can('read_all')) return;
  people = await api<Person[]>('GET', '/activities/people');
  fillSelect(
    el<HTMLSelectElement>('fPerson'),
    [
      { value: '', label: 'Everyone' },
      ...people.map((p) => ({
        value: p.personId,
        label: p.designation ? `${p.fullName} — ${p.designation}` : p.fullName,
      })),
    ],
    el<HTMLSelectElement>('fPerson').value,
  );
}

//------------------------------------------------------------------------------
// The feed
//------------------------------------------------------------------------------

function openViewer(src: string, kind: 'photo' | 'video' = 'photo'): void {
  const img = el<HTMLImageElement>('viewerImg');
  const video = el<HTMLVideoElement>('viewerVideo');
  img.hidden = kind !== 'photo';
  video.hidden = kind !== 'video';
  if (kind === 'photo') img.src = src;
  else {
    video.src = src;
    void video.play().catch(() => {});
  }
  el('viewer').hidden = false;
}

el('viewer').addEventListener('click', (e) => {
  // A tap on the player's own controls must not close it; a tap anywhere else does.
  if (e.target === el('viewerVideo')) return;
  const video = el<HTMLVideoElement>('viewerVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  el('viewer').hidden = true;
  el<HTMLImageElement>('viewerImg').removeAttribute('src');
});

function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const VIDEO_STATE: Readonly<Record<Exclude<Video['status'], 'ready'>, string>> = {
  uploading: 'Still being sent from the phone…',
  processing: 'Being prepared — ready in a few minutes. Refresh to see it.',
  failed: 'This video could not be used',
};

function videoTile(video: Video, post: Post, refresh: () => void): HTMLElement {
  const tile = make('div', 'video');
  if (video.status !== 'ready') {
    const state = make('div', 'state', VIDEO_STATE[video.status]);
    if (video.status === 'failed' && video.failure !== null) {
      // ffmpeg's or the length rule's own words: shown as they are, never put into Urdu.
      state.append(untranslated(make('span', 'why', video.failure)));
    }
    tile.append(state);
    // A video that could not be used comes off on its own — by whoever may delete the post.
    if (video.status === 'failed' && post.mayDelete) {
      const remove = button('Remove this video', 'danger');
      remove.addEventListener('click', () => {
        if (!confirm('Remove this video from the post? The rest of the post stays.')) return;
        remove.disabled = true;
        void api('DELETE', `/activities/media/${video.mediaId}`)
          .then(refresh)
          .catch((e: unknown) => {
            remove.disabled = false;
            alert(e instanceof Error ? e.message : 'The video could not be removed.');
          });
      });
      tile.append(remove);
    }
    return tile;
  }
  const src = `/activities/media/${video.mediaId}`;
  if (video.hasPoster) {
    const poster = make('img');
    poster.loading = 'lazy';
    poster.alt = 'Activity video';
    poster.src = `${src}?size=thumb`;
    poster.addEventListener('click', () => openViewer(src, 'video'));
    tile.append(poster);
  }
  const play = button('▶', 'play');
  play.setAttribute('aria-label', 'Play video');
  play.addEventListener('click', () => openViewer(src, 'video'));
  tile.append(play);
  if (video.durationSeconds !== null) {
    tile.append(make('span', 'length', clock(video.durationSeconds)));
  }
  return tile;
}

function postCard(post: Post, inBin: boolean, refresh: () => void): HTMLElement {
  const card = make('article');
  card.append(make('div', 'meta', `${post.unitName} · ${day(post.activityDate)}`));
  const by = post.authorDesignation
    ? `${post.authorName} — ${post.authorDesignation}`
    : post.authorName;
  const how = post.source === 'whatsapp' ? 'sent on WhatsApp' : 'posted';
  card.append(make('div', 'meta', `${by} · ${how} ${when(post.createdAt)}`));
  if (post.place !== null) card.append(make('div', 'meta', `Place: ${post.place}`));
  // Within the last days of its thirty, everyone who can see the post is told (ADR-0039 §7).
  if (Date.parse(post.expiresAt) - Date.now() < WARNING_MS) {
    card.append(make('div', 'meta expires', `Deleted automatically on ${when(post.expiresAt)}`));
  }
  card.append(untranslated(make('p', 'caption', post.caption)));

  if (post.photos.length > 0) {
    const grid = make('div', 'photos');
    for (const photo of post.photos) {
      const img = make('img');
      img.loading = 'lazy';
      img.alt = 'Activity photo';
      img.src = `/activities/media/${photo.mediaId}${photo.hasThumb ? '?size=thumb' : ''}`;
      img.addEventListener('click', () => openViewer(`/activities/media/${photo.mediaId}`));
      grid.append(img);
    }
    card.append(grid);
  }
  if (post.videos.length > 0) {
    const grid = make('div', 'videos');
    grid.append(...post.videos.map((v) => videoTile(v, post, refresh)));
    card.append(grid);
  }
  for (const a of post.audios) card.append(audioTile(`/activities/media/${a.mediaId}`));
  if (post.photos.length === 0 && post.videos.length === 0 && post.audios.length === 0) {
    card.append(make('p', 'meta', 'No photos, videos or voice notes.'));
  }

  const actions = make('div', 'row');
  const error = make('p', 'error');
  error.hidden = true;
  const act = (b: HTMLButtonElement, run: () => Promise<unknown>, ask?: string): void => {
    b.addEventListener('click', () => {
      if (ask !== undefined && !confirm(ask)) return;
      void (async () => {
        b.disabled = true;
        error.hidden = true;
        try {
          await run();
          refresh();
        } catch (e) {
          showError(error, e);
          b.disabled = false;
        }
      })();
    });
    actions.append(b);
  };

  if (!inBin && post.mayChangeDate) {
    // A WhatsApp post is dated the day it arrived (ADR-0040 §5); the activity may be older.
    const change = button('Change date');
    change.addEventListener('click', () => {
      const input = make('input');
      input.type = 'date';
      input.max = me.today;
      input.value = post.activityDate;
      input.setAttribute('aria-label', 'Date of the activity');
      const save = button('Save date', 'primary');
      change.replaceWith(input);
      act(save, () =>
        api('PUT', `/activities/posts/${post.postId}/date`, { activityDate: input.value }),
      );
      input.focus();
    });
    actions.append(change);
  }
  if (inBin) {
    act(button('Restore'), () => api('POST', `/activities/posts/${post.postId}/restore`));
  } else if (post.mayModerate) {
    act(button('Move to Recycle bin'), () => api('POST', `/activities/posts/${post.postId}/hide`));
  }
  if (post.mayDelete) {
    const del = button(inBin || post.mayModerate ? 'Delete permanently' : 'Delete', 'danger');
    act(
      del,
      () => api('DELETE', `/activities/posts/${post.postId}`),
      'Delete this post, its photos and its videos for good? This cannot be undone.',
    );
  }
  if (actions.childElementCount > 0) card.append(actions, error);
  return card;
}

let oldest: string | null = null;

/** Matches the server's warning window; only decides when the note on a card is drawn. */
const WARNING_MS = 3 * 24 * 60 * 60 * 1000;

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * The DC's warning: what the 30-day rule is about to delete, the ZIP to keep it, and whether the
 * media backup is running. Only drawn for a moderator; the server refuses anyone else.
 */
async function loadExpiring(): Promise<void> {
  const box = el('expiring');
  if (!can('moderate')) return;
  let x: Expiring;
  try {
    x = await api<Expiring>('GET', '/activities/expiring');
  } catch {
    box.hidden = true;
    return;
  }
  const parts: HTMLElement[] = [];
  if (x.posts > 0 && x.firstExpiresAt !== null) {
    parts.push(
      make('h2', undefined, `${x.posts} post${x.posts === 1 ? '' : 's'} will be deleted soon`),
      make(
        'p',
        undefined,
        `Posts are kept for ${x.retentionDays} days after upload. ${x.photos} photo${
          x.photos === 1 ? '' : 's'
        }${x.videos > 0 ? ` and ${x.videos} video${x.videos === 1 ? '' : 's'}` : ''} (${megabytes(
          x.bytes,
        )}) will be deleted from ${when(x.firstExpiresAt)} onwards, ` +
          'Recycle bin included. Download them now to keep a copy.',
      ),
    );
    if (x.zipFits) {
      const link = make('a', 'button primary', 'Download ZIP');
      link.setAttribute('href', '/activities/expiring.zip');
      link.setAttribute('download', '');
      const row = make('div', 'row');
      row.append(link);
      parts.push(row);
    } else {
      parts.push(make('p', 'error', 'Too much for one ZIP. Ask for a copy from the server.'));
    }
  }
  const b = x.backup;
  let backupNote: string | null = null;
  if (!b.configured) {
    backupNote = 'Media backup is not set up: photos and videos exist only on the server.';
  } else if (b.notCopied > 0 || b.removalsWaiting > 0) {
    backupNote =
      `Media backup is behind: ${b.notCopied} file(s) not copied, ` +
      `${b.removalsWaiting} delete(s) waiting${b.lastError === null ? '' : ` (${b.lastError})`}.`;
  }
  if (backupNote !== null) parts.push(make('p', 'meta expires', backupNote));
  // Videos the server has not converted: waiting means ffmpeg is missing or stuck (ADR-0039 §4).
  const v = x.conversion;
  if (v.waiting > 0) {
    parts.push(
      make(
        'p',
        'meta expires',
        `${v.waiting} video(s) have waited over an hour to be prepared. Ask the server ` +
          'administrator to run "npm run doctor".',
      ),
    );
  }
  if (v.failed > 0) {
    parts.push(make('p', 'meta', `${v.failed} video(s) could not be used; their posts say why.`));
  }
  box.replaceChildren(...parts);
  box.hidden = parts.length === 0;
}

function feedQuery(): URLSearchParams {
  const q = new URLSearchParams();
  const unit = el<HTMLSelectElement>('fUnit').value;
  const person = el<HTMLSelectElement>('fPerson').value;
  const from = el<HTMLInputElement>('fFrom').value;
  const to = el<HTMLInputElement>('fTo').value;
  if (unit !== '') q.set('unit', unit);
  if (person !== '' && can('read_all')) q.set('person', person);
  if (from !== '') q.set('from', from);
  if (to !== '') q.set('to', to);
  return q;
}

async function loadFeed(more: boolean): Promise<void> {
  const feed = el('feed');
  const moreBtn = el<HTMLButtonElement>('more');
  const q = feedQuery();
  if (more && oldest !== null) q.set('before', oldest);
  if (!more) {
    oldest = null;
    feed.replaceChildren(make('p', 'muted', 'Loading…'));
  }
  try {
    const page = await api<{ posts: Post[]; more: boolean }>('GET', `/activities/posts?${q}`);
    if (!more) feed.replaceChildren();
    for (const p of page.posts) feed.append(postCard(p, false, () => void loadFeed(false)));
    if (!more && page.posts.length === 0) {
      feed.append(make('p', 'muted', 'No activities match.'));
    }
    oldest = page.posts.at(-1)?.createdAt ?? oldest;
    moreBtn.hidden = !page.more;
  } catch (e) {
    const p = make('p', 'error');
    showError(p, e);
    feed.replaceChildren(p);
  }
}

for (const id of ['fUnit', 'fPerson', 'fFrom', 'fTo']) {
  el(id).addEventListener('change', () => void loadFeed(false));
}
el('more').addEventListener('click', () => void loadFeed(true));

async function loadBin(): Promise<void> {
  const feed = el('binFeed');
  feed.replaceChildren(make('p', 'muted', 'Loading…'));
  try {
    const page = await api<{ posts: Post[] }>('GET', '/activities/posts?bin=1');
    feed.replaceChildren(...page.posts.map((p) => postCard(p, true, () => void loadBin())));
    if (page.posts.length === 0) feed.append(make('p', 'muted', 'The Recycle bin is empty.'));
  } catch (e) {
    const p = make('p', 'error');
    showError(p, e);
    feed.replaceChildren(p);
  }
}

//------------------------------------------------------------------------------
// The Pending list (ADR-0040)
//------------------------------------------------------------------------------

function whyPending(g: PendingGroup): string {
  switch (g.reason) {
    case 'unknown_sender':
      return 'This number is not in the Directory.';
    case 'no_department':
      return 'This account has no default department.';
    case 'not_allowed':
      return 'This person may not post (suspended, or not permitted).';
    case 'no_answer':
      return `Asked whether this was a report for ${g.incidentReference ?? 'their open emergency'} or a daily activity — no answer within an hour.`;
  }
}

/** A voice note, playable where it is. */
function audioTile(src: string): HTMLElement {
  const player = make('audio');
  player.controls = true;
  player.preload = 'none';
  player.src = src;
  player.setAttribute('aria-label', 'Voice note');
  return player;
}

/** The "General" department, when it exists — where a person with none posts (ADR-0041 §2). */
const generalUnitId = (): string =>
  liveUnits().find((u) => u.name.trim().toLowerCase() === 'general')?.unitId ?? '';

function pendingCard(g: PendingGroup): HTMLElement {
  const card = make('article');
  const who = g.personName ?? 'Not in the Directory';
  card.append(make('div', 'meta', `+${g.fromPhone} · ${who} · sent ${when(g.receivedAt)}`));
  card.append(make('div', 'meta', whyPending(g)));
  card.append(make('div', 'meta expires', `Deleted automatically on ${when(g.expiresAt)}`));
  if (g.captions.length > 0) {
    card.append(untranslated(make('p', 'caption', g.captions.join('\n'))));
  }
  for (const m of g.messages) card.append(untranslated(make('p', 'caption message', m)));

  const src = (mediaId: string): string => `/activities/pending/media/${mediaId}`;
  const photos = g.media.filter((m) => m.kind === 'photo');
  if (photos.length > 0) {
    const grid = make('div', 'photos');
    for (const m of photos) {
      const img = make('img');
      img.loading = 'lazy';
      img.alt = 'Photo sent on WhatsApp';
      img.src = src(m.mediaId);
      img.addEventListener('click', () => openViewer(src(m.mediaId)));
      grid.append(img);
    }
    card.append(grid);
  }
  const clips = g.media.filter((m) => m.kind === 'video');
  if (clips.length > 0) {
    const grid = make('div', 'videos');
    for (const m of clips) {
      const tile = make('div', 'video');
      const play = button('▶', 'play');
      play.setAttribute('aria-label', 'Play video');
      play.addEventListener('click', () => openViewer(src(m.mediaId), 'video'));
      tile.append(play);
      grid.append(tile);
    }
    card.append(grid);
  }
  for (const m of g.media.filter((x) => x.kind === 'audio')) card.append(audioTile(src(m.mediaId)));

  const hasFiles = g.media.length > 0;
  const id = (name: string): string => `${name}-${g.inboundId}`;
  const field = (text: string, control: HTMLElement): HTMLElement => {
    const wrap = make('div');
    const label = make('label', undefined, text);
    label.htmlFor = control.id;
    wrap.append(label, control);
    return wrap;
  };
  const live = liveUnits().map((u) => ({ value: u.unitId, label: u.name }));
  const unitSelect = (name: string, value: string): HTMLSelectElement => {
    const s = make('select');
    s.id = id(name);
    fillSelect(s, [{ value: '', label: 'Choose a department' }, ...live], value);
    return s;
  };
  const dateInput = (): HTMLInputElement => {
    const d = make('input');
    d.id = id('date');
    d.type = 'date';
    d.max = me.today;
    d.value = g.activityDate;
    return d;
  };

  const error = make('p', 'error');
  error.hidden = true;
  const buttons: HTMLButtonElement[] = [];
  const run = (go: () => Promise<unknown>): void => {
    void (async () => {
      for (const b of buttons) b.disabled = true;
      error.hidden = true;
      try {
        await go();
        void loadPending();
      } catch (e) {
        showError(error, e);
        for (const b of buttons) b.disabled = false;
      }
    })();
  };
  const reject = button(hasFiles ? 'Reject' : 'Delete', 'danger');
  reject.addEventListener('click', () => {
    if (!confirm('Delete this for good? This cannot be undone.')) return;
    run(() => api('POST', `/activities/pending/${g.inboundId}/reject`));
  });

  // ---- A known person, with something to post: one tap (option 6) ----
  if (g.personId !== null && hasFiles) {
    const person = people.find((p) => p.personId === g.personId);
    const unitId = g.suggestedUnitId ?? generalUnitId();
    const unitName = units.find((u) => u.unitId === unitId)?.name ?? 'a department';
    const approve = button(
      `Approve — ${person?.fullName ?? 'this person'}, ${unitName}`,
      'primary wrap',
    );
    const change = button('Change');
    buttons.push(approve, change, reject);
    const form = make('div');
    form.hidden = true;
    const personSelect = make('select');
    personSelect.id = id('who');
    fillSelect(personSelect, peopleOptions(), g.personId);
    const unit = unitSelect('unit', unitId);
    const date = dateInput();
    form.append(
      field('Person', personSelect),
      field('Department', unit),
      field('Date of the activity', date),
    );
    change.addEventListener('click', () => {
      form.hidden = false;
      change.hidden = true;
    });
    approve.addEventListener('click', () =>
      run(() =>
        api('POST', `/activities/pending/${g.inboundId}/approve`, {
          personId: form.hidden ? g.personId : personSelect.value,
          unitId: form.hidden ? unitId : unit.value,
          activityDate: date.value,
        }),
      ),
    );
    const row = make('div', 'row');
    row.append(approve, change, reject);
    card.append(form, row, error);
    return card;
  }

  // ---- An unknown number: add it to the Directory (option 3), or post under someone ----
  const name = make('input');
  name.id = id('name');
  name.maxLength = 200;
  name.placeholder = 'Full name';
  const post = make('input');
  post.id = id('post');
  post.maxLength = 200;
  post.placeholder = 'Post, e.g. Health Officer';
  const unit = unitSelect('newUnit', generalUnitId());
  const add = button('Add to Directory', 'primary');
  buttons.push(add, reject);
  add.addEventListener('click', () => {
    if (name.value.trim() === '') return name.focus();
    if (post.value.trim() === '') return post.focus();
    run(() =>
      api('POST', `/activities/pending/${g.inboundId}/add-contact`, {
        fullName: name.value.trim(),
        designation: post.value.trim(),
        unitId: unit.value,
      }),
    );
  });
  const addBox = make('div');
  addBox.append(
    make('h3', undefined, 'Add this number to the Directory'),
    make(
      'p',
      'meta',
      hasFiles
        ? 'Their pictures are posted under them now, and from now on post by themselves. A Directory contact can also be sent emergency alerts — add officers only.'
        : 'From now on their pictures post by themselves. A Directory contact can also be sent emergency alerts — add officers only.',
    ),
    field('Name', name),
    field('Post', post),
    field('Department', unit),
  );
  const addRow = make('div', 'row');
  addRow.append(add, reject);
  card.append(addBox, addRow);

  if (hasFiles) {
    const other = make('details');
    other.append(make('summary', undefined, 'Or post it under someone already in the Directory'));
    const personSelect = make('select');
    personSelect.id = id('who');
    fillSelect(personSelect, peopleOptions(), '');
    const unit2 = unitSelect('unit', generalUnitId());
    personSelect.addEventListener('change', () => {
      const chosen = people.find((p) => p.personId === personSelect.value);
      const u = chosen?.defaultUnitId ?? null;
      if (u !== null && live.some((x) => x.value === u)) unit2.value = u;
    });
    const date = dateInput();
    const approve = button('Approve');
    buttons.push(approve);
    approve.addEventListener('click', () =>
      run(() =>
        api('POST', `/activities/pending/${g.inboundId}/approve`, {
          personId: personSelect.value,
          unitId: unit2.value,
          activityDate: date.value,
        }),
      ),
    );
    const row = make('div', 'row');
    row.append(approve);
    other.append(
      field('Person', personSelect),
      field('Department', unit2),
      field('Date of the activity', date),
      row,
    );
    card.append(other);
  }
  card.append(error);
  return card;
}

function peopleOptions(): { value: string; label: string }[] {
  return [
    { value: '', label: 'Choose a person' },
    ...people.map((p) => ({
      value: p.personId,
      label: p.designation ? `${p.fullName} — ${p.designation}` : p.fullName,
    })),
  ];
}

async function loadPending(): Promise<void> {
  const list = el('pendingList');
  list.replaceChildren(make('p', 'muted', 'Loading…'));
  try {
    if (people.length === 0) await loadPeople();
    const groups = await api<PendingGroup[]>('GET', '/activities/pending');
    setPendingCount(groups.length);
    list.replaceChildren(...groups.map(pendingCard));
    if (groups.length === 0) list.append(make('p', 'muted', 'Nothing is waiting.'));
  } catch (e) {
    const p = make('p', 'error');
    showError(p, e);
    list.replaceChildren(p);
  }
}

//------------------------------------------------------------------------------
// The log
//------------------------------------------------------------------------------

const LOG_TEXT: Readonly<Record<string, string>> = {
  posted: 'posted an activity',
  photo_added: 'added a photo',
  video_added: 'added a video',
  video_failed: 'could not prepare a video',
  video_removed: 'removed a video that could not be used',
  hidden: 'moved a post to the Recycle bin',
  restored: 'restored a post',
  deleted: 'deleted a post permanently',
  expired: 'removed a post after 30 days',
  zip_downloaded: 'downloaded the posts about to be deleted',
  unit_created: 'added a department',
  unit_renamed: 'renamed a department',
  unit_retired: 'retired a department',
  default_unit_set: "set a person's default department",
  date_changed: 'changed the date of a post',
  pending_approved: 'approved pictures sent on WhatsApp',
  pending_rejected: 'rejected pictures sent on WhatsApp',
  pending_expired: 'removed pictures sent on WhatsApp after 30 days',
  audio_added: 'added a voice note',
  contact_added: 'added a WhatsApp number to the Directory',
};

async function loadLog(): Promise<void> {
  const list = el('logList');
  list.replaceChildren(make('p', 'muted', 'Loading…'));
  try {
    const lines = await api<LogLine[]>('GET', '/activities/log');
    list.replaceChildren(
      ...lines.map((l) => {
        const row = make('div', 'list-row');
        // An expiry has no person: the 30-day rule did it.
        const who =
          l.type === 'expired' || l.type === 'video_failed' || l.type === 'pending_expired'
            ? 'The app'
            : (l.actorName ?? 'Someone');
        // Who, what and the details as their own pieces, so each can be put into Urdu on its
        // own (E4) — a name is never translated, the words around it are.
        const name = make('span', undefined, who);
        if (l.actorName !== null && who === l.actorName) name.setAttribute('translate', 'no');
        const extra: string[] = [];
        if (l.unitName !== null) extra.push(`— ${l.unitName}`);
        const d = l.detail ?? {};
        if ((l.type === 'deleted' || l.type === 'expired') && typeof d['author'] === 'string') {
          extra.push(`(by ${d['author']}, ${String(d['activityDate'] ?? '')})`);
        }
        if (l.type === 'unit_renamed') extra.push(`(was ${String(d['from'] ?? '')})`);
        if (l.type === 'video_failed' || l.type === 'video_removed') {
          extra.push(`(${String(d['reason'] ?? '')})`);
        }
        if (l.type === 'date_changed') {
          extra.push(`(${String(d['from'] ?? '')} to ${String(d['to'] ?? '')})`);
        }
        if (l.type.startsWith('pending_') && typeof d['fromPhone'] === 'string') {
          extra.push(`(from +${d['fromPhone']})`);
        }
        const line = make('span');
        line.append(name, ' ', make('span', undefined, LOG_TEXT[l.type] ?? l.type));
        if (extra.length > 0) {
          const details = make('span', undefined, extra.join(' '));
          details.setAttribute('translate', 'no');
          line.append(' ', details);
        }
        row.append(line, make('span', 'meta', when(l.recordedAt)));
        return row;
      }),
    );
    if (lines.length === 0) list.append(make('p', 'muted', 'Nothing yet.'));
  } catch (e) {
    const p = make('p', 'error');
    showError(p, e);
    list.replaceChildren(p);
  }
}

//------------------------------------------------------------------------------
// Departments
//------------------------------------------------------------------------------

function drawUnits(): void {
  const list = el('unitList');
  list.replaceChildren();
  const error = el('unitError');
  for (const u of units) {
    const row = make('div', 'list-row');
    row.append(
      make('span', u.retired ? 'muted' : undefined, u.retired ? `${u.name} (retired)` : u.name),
    );
    if (!u.retired) {
      const buttons = make('span', 'row');
      buttons.style.marginTop = '0';
      const rename = button('Rename');
      rename.addEventListener('click', () => {
        const name = prompt('New name for this department', u.name);
        if (name === null || name.trim() === '' || name.trim() === u.name) return;
        void api('PATCH', `/activities/units/${u.unitId}`, { name: name.trim() })
          .then(() => loadUnits().then(drawUnits))
          .catch((e: unknown) => showError(error, e));
      });
      const retire = button('Retire', 'danger');
      retire.addEventListener('click', () => {
        if (!confirm(`Retire "${u.name}"? Its old posts keep its name.`)) return;
        void api('POST', `/activities/units/${u.unitId}/retire`)
          .then(() => loadUnits().then(drawUnits))
          .catch((e: unknown) => showError(error, e));
      });
      buttons.append(rename, retire);
      row.append(buttons);
    }
    list.append(row);
  }
  if (units.length === 0)
    list.append(make('p', 'muted', 'No departments yet. Add the first one above.'));
}

el<HTMLFormElement>('unitForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = el<HTMLInputElement>('unitName');
  const error = el('unitError');
  error.hidden = true;
  void api('POST', '/activities/units', { name: input.value.trim() })
    .then(async () => {
      input.value = '';
      await loadUnits();
      drawUnits();
    })
    .catch((err: unknown) => showError(error, err));
});

//------------------------------------------------------------------------------
// Officers — everyone who posts (ADR-0041 §9). The server checks every change (INV-05).
//------------------------------------------------------------------------------

let officers: Officer[] = [];

async function loadOfficers(): Promise<void> {
  const list = el('officerList');
  list.replaceChildren(make('p', 'muted', 'Loading…'));
  try {
    officers = await api<Officer[]>('GET', '/activities/officers');
    drawOfficers();
  } catch (e) {
    const p = make('p', 'error');
    showError(p, e);
    list.replaceChildren(p);
  }
}

function loginText(o: Officer): string {
  if (o.role === null) return 'WhatsApp only — no login';
  if (o.role === 'member') return 'Login: Activities only';
  return `Login: ${o.role} — control room`;
}

/** A waiting link that never reached the officer is the one thing on this line worth a look. */
function linkText(o: Officer): string {
  if (o.link === null || o.link.state !== 'waiting') return '';
  return o.link.sentVia === 'failed'
    ? 'sign-in link could not be sent'
    : 'sign-in link not used yet';
}

/**
 * What happened to a sign-in link, said where the DC pressed the button. Sent: that is all.
 * Not sent (no login template yet) or refused by Meta: the link itself, to send by hand — the
 * officer must not be left waiting for a message that is not coming.
 */
function linkOutcome(sent: LinkSent): HTMLElement {
  const box = make('div', 'link-sent');
  if (sent.sentVia === 'whatsapp') {
    box.append(make('p', 'ok', 'Sign-in link sent on WhatsApp. It works once, for 3 days.'));
    return box;
  }
  box.append(
    make(
      'p',
      sent.sentVia === 'failed' ? 'error' : 'meta',
      sent.sentVia === 'failed'
        ? 'The sign-in link could not be sent on WhatsApp. Send this link to them yourself — it works once, for 3 days:'
        : 'WhatsApp cannot send sign-in links yet. Send this link to them yourself — it works once, for 3 days:',
    ),
  );
  if (sent.failure !== null) box.append(untranslated(make('p', 'meta', sent.failure)));
  const line = make('div', 'row');
  const url = make('input');
  url.readOnly = true;
  url.value = sent.url ?? '';
  url.setAttribute('aria-label', 'Sign-in link');
  url.setAttribute('translate', 'no');
  url.dir = 'ltr';
  const copy = button('Copy link');
  copy.addEventListener('click', () => {
    url.select();
    void navigator.clipboard
      ?.writeText(url.value)
      .then(() => {
        copy.textContent = 'Copied';
      })
      .catch(() => {
        // No clipboard (an old browser, or no permission): the link is selected to copy by hand.
      });
  });
  line.append(url, copy);
  box.append(line);
  return box;
}

function officerRow(o: Officer, sent?: LinkSent): HTMLElement {
  const row = make('div', 'list-row officer');
  const error = make('p', 'error');
  error.hidden = true;
  const fail = (e: unknown): void => showError(error, e);
  const replace = (next: Officer & { readonly sent?: LinkSent }): void => {
    officers = officers.map((x) => (x.personId === next.personId ? next : x));
    row.replaceWith(officerRow(next, next.sent));
  };

  row.append(
    untranslated(
      make('div', 'officer-name', o.designation ? `${o.fullName} — ${o.designation}` : o.fullName),
    ),
  );
  const facts = [o.phone, loginText(o), linkText(o)];
  if (!o.inDirectory) facts.push('not in the Directory');
  if (o.placeholder) facts.push('stand-in number');
  if (o.suspended) facts.push('suspended');
  row.append(make('div', 'meta', facts.filter((f) => f !== '').join(' · ')));

  const controls = make('div', 'row');

  const unit = make('select');
  unit.setAttribute('aria-label', `Department of ${o.fullName}`);
  fillSelect(
    unit,
    [
      { value: '', label: 'Department — none (General)' },
      ...liveUnits().map((u) => ({ value: u.unitId, label: u.name })),
    ],
    o.defaultUnitId ?? '',
  );
  unit.addEventListener('change', () => {
    error.hidden = true;
    const unitId = unit.value === '' ? null : unit.value;
    void api('PUT', '/activities/default-unit', { personId: o.personId, unitId })
      .then(() => replace({ ...o, defaultUnitId: unitId }))
      .catch((e: unknown) => {
        unit.value = o.defaultUnitId ?? '';
        fail(e);
      });
  });

  const toggle = make('label', 'switch');
  const box = make('input');
  box.type = 'checkbox';
  box.checked = o.activitiesOn;
  box.addEventListener('change', () => {
    error.hidden = true;
    box.disabled = true;
    void api<Officer>('POST', `/activities/officers/${o.personId}/activities`, { on: box.checked })
      .then(replace)
      .catch((e: unknown) => {
        box.checked = o.activitiesOn;
        box.disabled = false;
        fail(e);
      });
  });
  toggle.append(box, document.createTextNode('Activities on'));
  controls.append(unit, toggle);

  // Always `member` here: a control-room login is given from the console, never from Activities.
  if (o.role === null && !o.placeholder) {
    const give = button('Give login');
    give.addEventListener('click', () => {
      give.hidden = true;
      const form = make('div', 'give-login');
      // A sign-in link is the default (ADR-0043): nobody, the DC included, sees their password.
      const byLink = make('label', 'switch');
      const linkBox = make('input');
      linkBox.type = 'checkbox';
      linkBox.checked = true;
      byLink.append(
        linkBox,
        document.createTextNode('Send a sign-in link — they choose their own password'),
      );
      const password = make('input');
      password.type = 'password';
      password.autocomplete = 'new-password';
      password.placeholder = 'Temporary password (12+ characters)';
      password.hidden = true;
      const note = make('span', 'meta', 'Activities only. The link works once, for 3 days.');
      linkBox.addEventListener('change', () => {
        password.hidden = linkBox.checked;
        note.textContent = linkBox.checked
          ? 'Activities only. The link works once, for 3 days.'
          : 'Activities only. They change this password at first sign-in.';
        if (!linkBox.checked) password.focus();
      });
      const send = button('Give login', 'primary');
      const cancel = button('Cancel');
      cancel.addEventListener('click', () => {
        form.remove();
        give.hidden = false;
      });
      send.addEventListener('click', () => {
        if (!linkBox.checked && password.value === '') return password.focus();
        error.hidden = true;
        send.disabled = true;
        void api<Officer & { readonly sent?: LinkSent }>(
          'POST',
          `/activities/officers/${o.personId}/login`,
          linkBox.checked
            ? { link: true, activityUnitId: unit.value }
            : { password: password.value, activityUnitId: unit.value },
        )
          .then(replace)
          .catch((e: unknown) => {
            send.disabled = false;
            fail(e);
          });
      });
      const buttons = make('div', 'row');
      buttons.append(send, cancel);
      form.append(note, byLink, password, buttons);
      row.insertBefore(form, error);
    });
    controls.append(give);
  }

  // A member who has a login: a new sign-in link — their first, or a forgotten password.
  if (o.role === 'member' && !o.suspended) {
    const again = button('Send sign-in link');
    again.addEventListener('click', () => {
      error.hidden = true;
      again.disabled = true;
      void api<LinkSent>('POST', `/activities/officers/${o.personId}/login-link`, {})
        .then((sent) => replace({ ...o, link: { state: 'waiting', sentVia: sent.sentVia }, sent }))
        .catch((e: unknown) => {
          again.disabled = false;
          fail(e);
        });
    });
    controls.append(again);
  }

  row.append(controls, error);
  if (sent !== undefined) row.append(linkOutcome(sent));
  return row;
}

function drawOfficers(): void {
  const list = el('officerList');
  const find = el<HTMLInputElement>('officerFind').value.trim().toLowerCase();
  const shown = officers.filter(
    (o) =>
      find === '' ||
      [o.fullName, o.designation ?? '', o.phone].some((t) => t.toLowerCase().includes(find)),
  );
  list.replaceChildren(...shown.map((o) => officerRow(o)));
  if (officers.length === 0) {
    list.append(
      make('p', 'muted', 'Nobody yet. Add officers to the Directory in the control room.'),
    );
  } else if (shown.length === 0) {
    list.append(make('p', 'muted', 'Nobody matches.'));
  }
}

el<HTMLInputElement>('officerFind').addEventListener('input', drawOfficers);

//------------------------------------------------------------------------------
// New post — photos are shrunk on the phone
//------------------------------------------------------------------------------

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older browsers: an <img> applies the photo's orientation itself.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function encode(
  source: ImageBitmap | HTMLImageElement,
  longEdge: number,
  quality: number,
): Promise<Blob> {
  const w = source.width;
  const h = source.height;
  const scale = Math.min(1, longEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Promise.reject(new Error('this phone cannot prepare photos'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null ? reject(new Error('the photo could not be prepared')) : resolve(blob),
      'image/jpeg',
      quality,
    );
  });
}

async function prepare(file: File): Promise<{ photo: Blob; thumb: Blob }> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decode(file);
  } catch {
    throw new Error(
      `${file.name}: this phone cannot read that kind of picture — choose a JPEG or PNG`,
    );
  }
  const photo = await encode(source, LONG_EDGE, 0.88);
  const thumb = await encode(source, THUMB_EDGE, 0.72);
  if ('close' in source) source.close();
  return { photo, thumb };
}

async function sendPhoto(postId: string, file: File): Promise<void> {
  const { photo, thumb } = await prepare(file);
  let res: Response;
  try {
    res = await fetch(`/activities/posts/${postId}/photos`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-thumb-bytes': String(thumb.size) },
      body: new Blob([thumb, photo]),
    });
  } catch {
    throw new Error(`${file.name}: the connection dropped`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(`${file.name}: ${typeof body?.error === 'string' ? body.error : res.status}`);
  }
}

let picked: File[] = [];

/**
 * A video chosen for a post. `mediaId` is set once the server has given it a place, so "try
 * again" carries on with the same upload — from the last chunk that arrived — rather than taking
 * a second place on the post.
 */
interface PickedVideo {
  readonly file: File;
  readonly seconds: number | null;
  mediaId?: string | undefined;
}
let pickedVideos: PickedVideo[] = [];

/** The post whose files are still being sent, and the ones that failed — for "try again". */
let pending: { postId: string; photos: File[]; videos: PickedVideo[] } | null = null;

function drawPicked(): void {
  const grid = el('picked');
  for (const img of Array.from(grid.querySelectorAll('img'))) URL.revokeObjectURL(img.src);
  grid.replaceChildren(
    ...picked.map((file, i) => {
      const box = make('div', 'pick');
      const img = make('img');
      img.alt = file.name;
      img.src = URL.createObjectURL(file);
      const remove = button('×');
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => {
        picked.splice(i, 1);
        drawPicked();
      });
      box.append(img, remove);
      return box;
    }),
  );
}

el<HTMLInputElement>('pPhotos').addEventListener('change', (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const error = el('postError');
  error.hidden = true;
  for (const f of Array.from(input.files ?? [])) {
    if (picked.length >= MAX_PHOTOS) {
      showError(error, new Error(`A post holds at most ${MAX_PHOTOS} photos.`));
      break;
    }
    picked.push(f);
  }
  input.value = '';
  drawPicked();
});

/** How long a video is, read by the browser from the file; null when it cannot say. */
function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (seconds: number | null): void => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      resolve(seconds);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () =>
      done(Number.isFinite(video.duration) ? video.duration : null),
    );
    video.addEventListener('error', () => done(null));
    setTimeout(() => done(null), 10_000);
    video.src = url;
  });
}

/** The type a camera file is, when the phone does not say: by its name, as a last resort. */
function videoType(file: File): string {
  if (file.type !== '') return file.type;
  return /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4';
}

function drawPickedVideos(): void {
  const list = el('pickedVideos');
  list.replaceChildren(
    ...pickedVideos.map((v, i) => {
      const row = make('div', 'list-row');
      const length = v.seconds === null ? '' : ` · ${clock(v.seconds)}`;
      row.append(make('span', undefined, `${v.file.name} · ${megabytes(v.file.size)}${length}`));
      const remove = button('×');
      remove.setAttribute('aria-label', `Remove ${v.file.name}`);
      remove.addEventListener('click', () => {
        pickedVideos.splice(i, 1);
        drawPickedVideos();
      });
      row.append(remove);
      return row;
    }),
  );
}

el<HTMLInputElement>('pVideos').addEventListener('change', (e) => {
  const input = e.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  const error = el('postError');
  error.hidden = true;
  void (async () => {
    const refused: string[] = [];
    for (const file of files) {
      if (pickedVideos.length >= MAX_VIDEOS) {
        refused.push(`a post holds at most ${MAX_VIDEOS} videos`);
        break;
      }
      if (file.size > MAX_VIDEO_BYTES) {
        refused.push(`${file.name} is larger than 300 MB`);
        continue;
      }
      // Checked here so an officer is not left sending a long video only to have it refused.
      // The server checks again from the file itself.
      const seconds = await videoSeconds(file);
      if (seconds !== null && seconds > MAX_VIDEO_SECONDS + 1) {
        refused.push(`${file.name} is ${clock(seconds)} long — videos may be at most 3 minutes`);
        continue;
      }
      pickedVideos.push({ file, seconds });
    }
    drawPickedVideos();
    if (refused.length > 0) showError(error, new Error(`Not added: ${refused.join('; ')}.`));
  })();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A refusal from the server that sending again will not change. */
class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `the server refused (${res.status})`;
}

/**
 * Send one video, chunk by chunk. A dropped connection is retried with a growing pause, each
 * time asking the server how much arrived — so nothing already sent is sent twice. Gives up
 * after several drops in a row; "try again" then carries on from where it stopped.
 */
async function sendVideo(
  postId: string,
  video: PickedVideo,
  progress: (fraction: number) => void,
): Promise<void> {
  const name = video.file.name;
  const call = async (method: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(path, { method, cache: 'no-store', ...init });
    if (res.status === 401) {
      location.replace('/');
      throw new Refused('Signed out.', 401);
    }
    return res;
  };
  const state = async (res: Response): Promise<UploadState> => {
    if (!res.ok) throw new Refused(`${name}: ${await errorOf(res)}`, res.status);
    return (await res.json()) as UploadState;
  };

  let current: UploadState | null = null;
  if (video.mediaId !== undefined) {
    const res = await call('GET', `/activities/uploads/${video.mediaId}`);
    // Gone (given up after a day, or refused): start again with a fresh place.
    if (res.status === 404) video.mediaId = undefined;
    else current = await state(res);
  }
  if (current === null) {
    current = await state(
      await call('POST', `/activities/posts/${postId}/videos`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bytes: video.file.size,
          contentType: videoType(video.file),
          ...(video.seconds === null ? {} : { durationSeconds: video.seconds }),
        }),
      }),
    );
    video.mediaId = current.mediaId;
  }

  let drops = 0;
  while (current.status === 'uploading') {
    progress(current.received / current.bytes);
    const chunk = video.file.slice(current.received, current.received + current.chunkBytes);
    let res: Response;
    try {
      res = await call('PUT', `/activities/uploads/${current.mediaId}`, {
        headers: {
          'content-type': 'application/octet-stream',
          'x-upload-offset': String(current.received),
        },
        body: chunk,
      });
    } catch (e) {
      if (e instanceof Refused) throw e;
      drops += 1;
      if (drops > 6) throw new Error(`${name}: the connection keeps dropping`);
      await sleep(Math.min(30_000, 2_000 * drops));
      try {
        current = await state(await call('GET', `/activities/uploads/${current.mediaId}`));
      } catch (again) {
        if (again instanceof Refused) throw again;
        // Still offline: the next round sends the same chunk, and counts another drop.
      }
      continue;
    }
    if (res.status === 409) {
      // Out of step (a chunk that did arrive although its answer did not): ask where to go on.
      current = await state(await call('GET', `/activities/uploads/${current.mediaId}`));
      continue;
    }
    if (res.status === 415 || res.status === 404) video.mediaId = undefined;
    current = await state(res);
    drops = 0;
  }
  progress(1);
}

async function sendAll(
  postId: string,
  photos: readonly File[],
  videos: readonly PickedVideo[],
): Promise<{ photos: File[]; videos: PickedVideo[] }> {
  const progress = el('postProgress');
  const failedPhotos: File[] = [];
  const failedVideos: PickedVideo[] = [];
  const reasons: string[] = [];
  for (const [i, file] of photos.entries()) {
    progress.textContent = `Sending photo ${i + 1} of ${photos.length}…`;
    try {
      await sendPhoto(postId, file);
    } catch (e) {
      failedPhotos.push(file);
      reasons.push(e instanceof Error ? e.message : String(e));
    }
  }
  for (const [i, video] of videos.entries()) {
    const label = `Sending video ${i + 1} of ${videos.length}`;
    progress.textContent = `${label}…`;
    try {
      await sendVideo(postId, video, (f) => {
        progress.textContent = `${label} — ${Math.floor(f * 100)}%`;
      });
    } catch (e) {
      // A refusal (too long, not a video) will not change by trying again; a drop will.
      if (!(e instanceof Refused) || e.status >= 500) failedVideos.push(video);
      reasons.push(e instanceof Error ? e.message : String(e));
    }
  }
  progress.textContent = '';
  const failed = failedPhotos.length + failedVideos.length;
  if (reasons.length > 0) {
    showError(
      el('postError'),
      new Error(
        `The post is saved, but ${reasons.length} file(s) did not go: ${reasons.join('; ')}`,
      ),
    );
  }
  if (failed === 0 && videos.length > 0 && reasons.length === 0) {
    // Said once, so nobody waits on the page for a conversion that happens on the server.
    progress.textContent = 'Sent. Videos are being prepared and appear on the post shortly.';
  }
  return { photos: failedPhotos, videos: failedVideos };
}

function resetForm(): void {
  el<HTMLFormElement>('postForm').reset();
  el<HTMLSelectElement>('pUnit').value = me.defaultUnitId ?? '';
  el<HTMLInputElement>('pDate').value = me.today;
  picked = [];
  pickedVideos = [];
  drawPicked();
  drawPickedVideos();
}

function afterSending(
  postId: string,
  failed: { photos: File[]; videos: PickedVideo[] },
  anyRefused: boolean,
): void {
  if (failed.photos.length + failed.videos.length > 0) {
    pending = { postId, photos: failed.photos, videos: failed.videos };
    el('retryPhotos').hidden = false;
  } else {
    pending = null;
    // Stay on the form when something was refused, so the officer reads why.
    if (!anyRefused) show('posts');
  }
}

el<HTMLFormElement>('postForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const submit = el<HTMLButtonElement>('postSubmit');
  const error = el('postError');
  const retry = el('retryPhotos');
  error.hidden = true;
  retry.hidden = true;
  void (async () => {
    submit.disabled = true;
    try {
      el('postProgress').textContent = 'Saving the post…';
      const post = await api<{ postId: string }>('POST', '/activities/posts', {
        unitId: el<HTMLSelectElement>('pUnit').value,
        activityDate: el<HTMLInputElement>('pDate').value,
        caption: el<HTMLTextAreaElement>('pCaption').value,
        place: el<HTMLInputElement>('pPlace').value,
      });
      const failed = await sendAll(post.postId, picked, pickedVideos);
      resetForm();
      afterSending(post.postId, failed, !error.hidden);
    } catch (err) {
      el('postProgress').textContent = '';
      showError(error, err);
    } finally {
      submit.disabled = false;
    }
  })();
});

el('retryPhotos').addEventListener('click', () => {
  if (pending === null) return;
  const { postId, photos, videos } = pending;
  el('postError').hidden = true;
  el('retryPhotos').hidden = true;
  void sendAll(postId, photos, videos).then((failed) =>
    afterSending(postId, failed, !el('postError').hidden),
  );
});

//------------------------------------------------------------------------------
// My account
//------------------------------------------------------------------------------

el<HTMLSelectElement>('myUnit').addEventListener('change', (e) => {
  const select = e.currentTarget as HTMLSelectElement;
  const ok = el('myUnitOk');
  ok.hidden = true;
  void api<{ unitId: string | null }>('PUT', '/activities/default-unit', {
    unitId: select.value === '' ? null : select.value,
  }).then((r) => {
    me = { ...me, defaultUnitId: r.unitId };
    el<HTMLSelectElement>('pUnit').value = r.unitId ?? '';
    ok.hidden = false;
  });
});

el<HTMLFormElement>('password').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const error = el('passwordError');
  const ok = el('passwordOk');
  error.hidden = true;
  ok.hidden = true;

  const data = new FormData(form);
  void (async () => {
    try {
      const res = await fetch('/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: String(data.get('current') ?? ''),
          newPassword: String(data.get('next') ?? ''),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        error.textContent =
          typeof body?.error === 'string'
            ? body.error
            : 'The password could not be changed — try again in a moment.';
        error.hidden = false;
        return;
      }
      form.reset();
      ok.hidden = false;
      // Posting was held back until now; the server agrees from this request on.
      if (me.mustChangePassword) {
        me = { ...me, mustChangePassword: false };
        el('mustChange').hidden = true;
        drawTabs();
      }
    } catch {
      error.textContent = 'Cannot reach the server. Check your connection and try again.';
      error.hidden = false;
    }
  })();
});

el('backToApp').addEventListener('click', () => location.assign('/'));

el('signOut').addEventListener('click', () => {
  void (async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      location.replace('/');
    }
  })();
});

//------------------------------------------------------------------------------
// Start
//------------------------------------------------------------------------------

function drawTabs(): void {
  const nav = el('tabs');
  // Until the temporary password is replaced, only "My account" is offered (the server refuses
  // posting too — this only saves the officer a confusing refusal).
  const tabs: Tab[] = me.mustChangePassword ? ['account'] : tabsFor();
  nav.replaceChildren(
    ...tabs.map((t) => {
      const b = button(TAB_LABEL[t]);
      b.dataset['tab'] = t;
      b.addEventListener('click', () => show(t));
      return b;
    }),
  );
  nav.hidden = false;
  show(tabs[0]!);
  void refreshPendingCount();
}

async function load(): Promise<void> {
  const status = el('status');
  try {
    me = await api<Me>('GET', '/activities/me');
    await loadUnits();
    await loadPeople();
  } catch (e) {
    status.textContent =
      e instanceof Error ? e.message : 'Cannot reach the server. Check your connection and reload.';
    return;
  }

  el('who').textContent = me.fullName;
  // Anyone but a member came here from the control room; give them the way back.
  el('backToApp').hidden = me.role === 'member';
  el('mustChange').hidden = !me.mustChangePassword;
  el('fPersonWrap').hidden = !can('read_all');
  el('scopeNote').textContent = can('read_all')
    ? ''
    : 'You see your own posts. The DC office sees every department.';
  const date = el<HTMLInputElement>('pDate');
  date.max = me.today;
  date.value = me.today;
  status.hidden = true;
  drawTabs();
  watchPendingCount();
}

drawLangSwitch(el('langSlot'));
void startUrdu();
offerInstall();
void load();
