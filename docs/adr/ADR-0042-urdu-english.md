# ADR-0042 — Urdu / English: one switch, the whole app, a word list the owner can read

**Status:** Accepted · 2026-10-03 (Urdu wording **to be checked by the owner**)
**Decided by:** the owner asked for an Urdu/English toggle across the whole app, control room
included, with right-to-left layout (PLAN §4 E4, agreed 2026-10-01). The mechanism below was
chosen while the owner was away, under their instruction to keep going; every choice in it can be
changed without touching the screens.
**Rests on:** [ADR-0002](ADR-0002-offline-first.md) (the shell opens with no network).
**Reversal cost:** Low — one module, one JSON file, two head scripts. Removing it leaves the
English app exactly as it was.

## Context

The client is ~36,000 lines of HTML and TypeScript with every word written in English inline.
Officers who use Activities read Urdu more easily than English; the owner wants the whole app —
the control room too — switchable. Rewriting every screen to look its words up by key would touch
every file, and the shell has a hard download budget (`m1gate.e2e.test.ts`, 52 KB compressed) that
a full Urdu text cannot fit in.

## Decision

1. **The English stays the source.** Screens are written in English as before. On a device that
   chose Urdu, `web/src/i18n.ts` replaces English with Urdu **as it reaches the page**: once over
   the document, then everything drawn later (a `MutationObserver`). A screen nobody has
   translated yet still works — it is in English.
2. **Whole phrases only.** A text node (or `placeholder` / `title` / `aria-label` / `alt`) is
   replaced only when its whole trimmed text is a key in the word list, or matches a key with
   `{placeholders}` (`"Pending ({n})"`). No word-by-word assembly, no machine translation, **no AI
   on this path** (CLAUDE.md §8).
3. **The word list is a file the owner can read and correct:** `app/web/ur.json`,
   `"English": "اردو"`. An empty Urdu side means "not yet" and shows the English. Every placeholder
   on the left must appear on the right (`i18n.test.ts`).
4. **People's words are never translated.** Anything under `translate="no"` is left alone:
   captions, names, an incident's description, phone numbers. Screens mark such elements; the
   switch itself is marked so it always reads in the language it offers ("اردو" / "English").
5. **Per device, like the theme.** `dnc-bajaur.lang` in `localStorage`. The head script of each
   page sets `lang="ur" dir="rtl"` before the first paint and hides the page until the word list
   is applied — **for at most four seconds**; whatever fails, the page is shown, in English if it
   must be. Changing the language reloads the page.
6. **Outside the shell budget.** The engine (~2 KB) is in the bundles; the word list is fetched
   only by an Urdu device, as `/ur.json`. It sits at the top level of the build so the shell digest
   covers it — a corrected word is a new shell version and reaches cached browsers.
7. **Not translated:** WhatsApp messages and templates (Meta-approved text, and officers receive
   them whatever the control room's screen shows), server-side error text not in the word list,
   dates and digits (Western digits are kept: phone numbers and incident numbers are read aloud
   and typed back).
8. **Font:** the system's Naskh-style Urdu faces (Segoe UI on Windows, Noto Naskh on Android).
   Nastaliq stays on the news panel only — at the line height Nastaliq needs, dense control-room
   screens would not fit (`index.html`, the news-panel note).

## Consequences

### We gain
- Every screen can become Urdu without being rewritten; translation proceeds screen by screen, by
  adding lines to one file.
- English devices pay nothing.

### We give up
- A sentence built from pieces (a name, then a verb) must be drawn as separate elements to be
  translatable; screens that join them into one string stay English until split.
- User data that happens to equal a UI phrase exactly (a caption reading just "Approve") would be
  translated unless its element is marked `translate="no"`.
- Right-to-left is the browser's: flex rows and text flip. Every stylesheet's margins, paddings,
  borders and alignment were moved to logical properties (`margin-inline-start`), which change
  nothing in English; positions (`left:`/`right:`) were moved only where a control sits at a
  line's end (the password eye, the expand mark). What hangs past the left edge is clipped on an
  Urdu page, as it already was, unseen, on an English one.
- The guide ("How to use") is translated a paragraph at a time: `help.ts` marks each block, and the
  word list's keys for it are that block's inner HTML. Editing a guide paragraph in English makes
  that paragraph English again on an Urdu page until its line in `ur.json` is updated.

### We must therefore also
- Mark people's words `translate="no"` on every screen that is translated.
- Have the owner read `ur.json` — the wording is a draft.

## Alternatives considered
- **Keys in every screen (`t('activities.tab.posts')`).** Cleaner in theory; touches every one of
  ~6,000 strings and every file, for the same result. Rejected for size of change.
- **Machine translation at runtime.** No: wording in an emergency system must be fixed, reviewed
  and identical on every screen, and nothing may call out to a service to draw a button.

## How we would know this was wrong
- An Urdu device shows a blank or half-translated screen that does not settle — the hold/reveal
  is wrong.
- Officers report a name or caption altered on an Urdu screen — a `translate="no"` is missing.
- The word list grows past ~150 KB, at which point it should be split per screen.
