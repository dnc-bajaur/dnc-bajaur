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
      source += '(.+?)';
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

/** The Urdu for one phrase, or `null` when the dictionary does not know it. */
export function translateText(dict: Dictionary, text: string): string | null {
  const key = normalise(text).trim();
  if (key === '') return null;
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

/** Translates everything under `root` — the node itself included. */
export function translateTree(dict: Dictionary, root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(dict, root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root instanceof Element) {
    if (skipped(root)) return;
    translateElementAttributes(dict, root);
  }
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.ELEMENT_NODE && skipped(n as Element)) {
        return NodeFilter.FILTER_REJECT; // and everything under it
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

let active: Dictionary | null = null;

/**
 * For words that never reach the page as text — `confirm()`, `prompt()`, `alert()`. The English
 * comes back unchanged on an English page, or before the word list has arrived.
 */
export function t(text: string): string {
  return active === null ? text : (translateText(active, text) ?? text);
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
    active = dict;
    translateTree(dict, document);
    document.title = translateText(dict, document.title) ?? document.title;
    keepTranslating(dict, document.body);
  } catch {
    // Offline before the word list was ever fetched, or the file is missing: English it is.
  } finally {
    reveal();
  }
}
