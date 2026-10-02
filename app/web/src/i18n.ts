/**
 * Urdu / English — the whole app, one switch (Bajaur, PLAN §4 E4, ADR-0042).
 *
 * The screens are written in English, as they always were. When a device has chosen Urdu, this
 * module puts Urdu in place of the English **as it reaches the page**: once over the document,
 * then over everything drawn afterwards (a `MutationObserver`). No screen had to be rewritten to
 * take part, and a screen nobody has translated yet still works — it is simply in English.
 *
 * What it will and will not touch:
 *
 * - **Only whole phrases it knows.** A text node is replaced when its trimmed text is a key in
 *   the dictionary (`web/ur.json`), or matches one of its `{placeholder}` patterns. Nothing
 *   is guessed, machine-translated or assembled word by word — the dictionary is the owner's to
 *   read and correct (ADR-0042 §3). No AI anywhere on this path.
 * - **Never what people wrote.** Anything under `translate="no"` is left as it is: names,
 *   captions, an incident's description, a phone number. A screen that draws someone's words
 *   marks the element; the switch itself is marked too, so it always reads in the language it
 *   offers.
 * - **Never what a person is typing**: `<input>` values and `<textarea>` are skipped.
 * - Attributes a person reads or hears: `placeholder`, `title`, `aria-label`, `alt`.
 *
 * The choice is per device, like the theme (`dnc-bajaur.lang` in `localStorage`), and the head
 * script of each page applies `lang="ur" dir="rtl"` before the first paint. Changing it reloads
 * the page: the English is the source, and a reload is the one way back to it that cannot leave
 * half a screen in each language.
 */

export type Lang = 'en' | 'ur';

export const LANG_KEY = 'dnc-bajaur.lang';

/** The dictionary, made ready to look phrases up. */
export interface Dictionary {
  readonly exact: ReadonlyMap<string, string>;
  readonly patterns: readonly {
    readonly re: RegExp;
    readonly names: readonly string[];
    readonly to: string;
  }[];
}

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/g;

/**
 * Placeholders that stand for a number only. `"{n} today"` must match "3 today" and never
 * "Nothing reported today" — a free placeholder there would turn any sentence ending in "today"
 * into half-Urdu. Every other name (`{name}`, `{when}`) matches any text.
 */
const NUMERIC = new Set(['n', 'm', 'i', 'p', 'h', 'count', 'status']);

/**
 * Builds the lookup from the JSON file: `"English": "اردو"`. A key with `{name}` in it is a
 * pattern — `"Pending ({n})": "زیر التوا ({n})"` — whose captured part is carried across, itself
 * translated when it is a known phrase (a department or a category name, say).
 */
export function compile(raw: Readonly<Record<string, string>>): Dictionary {
  const exact = new Map<string, string>();
  const patterns: { re: RegExp; names: string[]; to: string }[] = [];
  for (const [en, ur] of Object.entries(raw)) {
    if (en.startsWith('//') || ur === '') continue; // a note in the file, or not yet translated
    if (!en.includes('{')) {
      exact.set(normalise(en), ur);
      continue;
    }
    const names: string[] = [];
    let source = '';
    let last = 0;
    for (const m of en.matchAll(PLACEHOLDER)) {
      source += escape(normalise(en.slice(last, m.index)));
      source += NUMERIC.has(m[1]!) ? '(\\d[\\d,.]*)' : '(.+?)';
      names.push(m[1]!);
      last = m.index + m[0].length;
    }
    source += escape(normalise(en.slice(last)));
    patterns.push({ re: new RegExp(`^${source}$`, 's'), names, to: ur });
  }
  // Longest first, so "Show older posts ({n})" is tried before a shorter pattern that would also
  // match it.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  return { exact, patterns };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Runs of white space are one space; the screens wrap their HTML however they like. */
function normalise(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/**
 * The Urdu for one phrase, or `null` when the dictionary does not know it.
 *
 * A line built of labels joined by " · " or " — " ("0300… · Login: Activities only · not in
 * the Directory", "fire — issued") is tried label by label when the whole is unknown: the known
 * labels become Urdu, the rest (a number, a name, a date) stay as they are.
 */
export function translateText(dict: Dictionary, text: string): string | null {
  const key = normalise(text).trim();
  if (key === '') return null;
  return translatePhrase(dict, key) ?? translateLabels(dict, key, 0);
}

const SEPARATORS = [' · ', ' — '] as const;

function translateLabels(dict: Dictionary, key: string, level: number): string | null {
  const sep = SEPARATORS[level];
  if (sep === undefined) return null;
  if (!key.includes(sep)) return translateLabels(dict, key, level + 1);
  let changed = false;
  const parts = key.split(sep).map((part) => {
    const t = translatePhrase(dict, part) ?? translateLabels(dict, part, level + 1);
    if (t === null) return part;
    changed = true;
    return t;
  });
  return changed ? parts.join(sep) : null;
}

function translatePhrase(dict: Dictionary, key: string): string | null {
  const hit = dict.exact.get(key);
  if (hit !== undefined) return hit;
  for (const p of dict.patterns) {
    const m = p.re.exec(key);
    if (m === null) continue;
    let out = p.to;
    p.names.forEach((name, i) => {
      const part = m[i + 1]!;
      out = out.split(`{${name}}`).join(dict.exact.get(part) ?? part);
    });
    return out;
  }
  return null;
}

/**
 * A dialog's text (`confirm`, `prompt`, `alert`): paragraphs separated by a blank line are
 * translated one by one, so a known question above an unknown detail (someone's name, an
 * incident's words) still reads in Urdu.
 */
export function translateMessage(dict: Dictionary, text: string): string {
  const whole = translateText(dict, text);
  if (whole !== null) return whole;
  return text
    .split(/\n\s*\n/)
    .map((part) => translateText(dict, part) ?? part)
    .join('\n\n');
}

/** Keeps the white space around a phrase: "  Sign out " stays spaced as it was. */
function replaceKeepingSpace(original: string, translated: string): string {
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + translated + trail;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'CODE', 'PRE']);
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'] as const;

function skipped(el: Element | null): boolean {
  if (el === null) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  return el.closest('[translate="no"], [contenteditable="true"]') !== null;
}

function translateElementAttributes(dict: Dictionary, el: Element): void {
  if (skipped(el)) return;
  for (const name of ATTRIBUTES) {
    const v = el.getAttribute(name);
    if (v === null) continue;
    const t = translateText(dict, v);
    if (t !== null && t !== v) el.setAttribute(name, t);
  }
  // A button drawn as `<input type="submit" value="…">` shows its value.
  if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button')) {
    const t = translateText(dict, el.value);
    if (t !== null) el.value = t;
  }
}

function translateTextNode(dict: Dictionary, node: Text): void {
  if (skipped(node.parentElement)) return;
  const t = translateText(dict, node.data);
  if (t !== null) {
    const next = replaceKeepingSpace(node.data, t);
    if (next !== node.data) node.data = next;
  }
}

/**
 * A paragraph with markup inside it — `<p>An emergency <b>must</b> reach…</p>` — cannot be put
 * into Urdu piece by piece: Urdu orders its words differently, so the bold word lands somewhere
 * else. Such an element is marked `data-i18n="html"` and its whole inner HTML is the key; the
 * Urdu side is HTML too. The word list is this product's own static file, never anyone's input.
 * Returns true when the element is handled as one piece (translated now, or earlier).
 */
function translateWhole(dict: Dictionary, el: Element): boolean {
  const mode = el.getAttribute('data-i18n');
  if (mode === 'done') return true;
  if (mode !== 'html') return false;
  const hit = dict.exact.get(normalise(el.innerHTML).trim());
  if (hit === undefined) return false; // not in the list: its pieces are tried one by one
  el.setAttribute('data-i18n', 'done');
  el.innerHTML = hit;
  return true;
}

/** Translates everything under `root` — the node itself included. */
export function translateTree(dict: Dictionary, root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(dict, root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root instanceof Element) {
    if (skipped(root)) return;
    if (translateWhole(dict, root)) return;
    translateElementAttributes(dict, root);
  }
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        // Skipped, or already put into Urdu as one piece: nothing under it is looked at again.
        if (skipped(n as Element) || translateWhole(dict, n as Element)) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(dict, n as Text);
    else translateElementAttributes(dict, n as Element);
  }
}

/** Keeps translating whatever the screens draw from now on. */
export function keepTranslating(dict: Dictionary, root: Node): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) translateTree(dict, n);
      } else if (r.type === 'characterData') {
        translateTextNode(dict, r.target as Text);
      } else if (r.type === 'attributes' && r.target instanceof Element) {
        translateElementAttributes(dict, r.target);
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
  return observer;
}

/** The language this page was opened in — set by the head script before the first paint. */
export function currentLang(): Lang {
  return document.documentElement.lang === 'ur' ? 'ur' : 'en';
}

/**
 * The locale dates and times are written in: Urdu month and day names on an Urdu page, with
 * the digits 0–9 kept (ADR-0042 §7). `undefined` — the browser's own — on an English page,
 * which is what every screen passed before.
 */
export function dateLocale(): string | undefined {
  return currentLang() === 'ur' ? 'ur-PK-u-nu-latn' : undefined;
}

/** Remembers the choice on this device and reopens the page in it. */
export function chooseLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Site data blocked: the choice cannot be remembered, so there is nothing a reload would
    // change. Say so rather than appear to do nothing.
    alert(
      lang === 'ur'
        ? 'This browser does not keep settings, so Urdu cannot be switched on here.'
        : 'This browser does not keep settings.',
    );
    return;
  }
  location.reload();
}

/**
 * Puts the switch in `slot`: it reads "اردو" while the page is English and "English" while it
 * is Urdu — the language the press gives, in that language.
 */
export function drawLangSwitch(slot: HTMLElement): void {
  const lang = currentLang();
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'langSwitch';
  b.setAttribute('translate', 'no');
  b.textContent = lang === 'ur' ? 'English' : 'اردو';
  b.lang = lang === 'ur' ? 'en' : 'ur';
  b.title = lang === 'ur' ? 'Show the app in English' : 'ایپ اردو میں دکھائیں';
  b.addEventListener('click', () => chooseLang(lang === 'ur' ? 'en' : 'ur'));
  slot.replaceChildren(b);
}

/**
 * Words that never reach the page as text — `confirm()`, `prompt()`, `alert()` — are caught at
 * the browser's own functions, so no screen has to remember to ask for them.
 */
function translateDialogs(dict: Dictionary): void {
  const { alert: a, confirm: c, prompt: p } = window;
  window.alert = (message?: unknown) => {
    a.call(window, translateMessage(dict, String(message ?? '')));
  };
  window.confirm = (message?: string) => c.call(window, translateMessage(dict, message ?? ''));
  window.prompt = (message?: string, value?: string) =>
    p.call(window, translateMessage(dict, message ?? ''), value);
}

/** Lifts the head script's "hold the paint" class — the page shows, translated or not. */
function reveal(): void {
  document.documentElement.classList.remove('i18n-pending');
}

/**
 * On an Urdu page: fetch the dictionary, translate the page, keep translating. Whatever goes
 * wrong, the page is revealed — in English if it has to be. A screen that stays blank because a
 * word list did not arrive is a far worse failure than a screen in the other language.
 */
export async function startUrdu(): Promise<void> {
  if (currentLang() !== 'ur') return;
  try {
    const res = await fetch('/ur.json');
    if (!res.ok) throw new Error(String(res.status));
    const dict = compile((await res.json()) as Record<string, string>);
    translateDialogs(dict);
    translateTree(dict, document);
    document.title = translateText(dict, document.title) ?? document.title;
    keepTranslating(dict, document.body);
  } catch {
    // Offline before the word list was ever fetched, or the file is missing: English it is.
  } finally {
    reveal();
  }
}
