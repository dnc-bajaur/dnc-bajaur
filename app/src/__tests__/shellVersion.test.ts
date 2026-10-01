/**
 * The shell and the cache version have to change together.
 *
 * ## What went wrong
 *
 * `sw.ts` caches `/`, `/index.html` and `/app.js` under a version string, and its own comment
 * says a browser holding an older cache keeps serving the stale shell until that string
 * changes. Over four commits the shell changed a great deal — the office screens, search and
 * the post-incident report left `app.js` for their own files, and their styling left
 * `index.html` — and the string did not.
 *
 * Every browser that had ever opened the app therefore kept serving the old one. It was found
 * by somebody opening the app and asking where the dashboard had gone. Had it reached Bajaur,
 * every installed handset would have kept the previous app and no amount of deploying would
 * have changed that.
 *
 * ## Why a comment was not enough
 *
 * The comment was there. It was correct, and it was read, and the mistake happened anyway —
 * because **the shell can change in files `sw.ts` never mentions.** Nothing connected editing
 * `index.html` to editing a string in a different file, so the connection lived only in
 * somebody's memory, which is the same place INV-05 refuses to put authorisation.
 *
 * So this test holds the connection instead. Change the shell and it fails, naming what to do.
 * That is deliberately a small nuisance on every CSS tweak: **a CSS tweak is a shell change,
 * and a stale cache hides it exactly as thoroughly as it hides a missing dashboard.**
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheVersion, shellDigest, shellFiles } from '../../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const RECORD = join(app, 'web', 'shell-version.json');

interface Record {
  cache: string;
  sha256: string;
}

/*
 * `shellDigest` and `cacheVersion` are imported from `build.mjs`, not written here.
 *
 * They used to be written here *and* in `scripts/record-shell.mjs` — the same rule, twice, in
 * two files that had no reason to be edited together. On 2026-08-12 `help.css` was added to
 * this copy and not to that one, and `npm run shell:record` then wrote a hash this test
 * rejected: a red suite about nothing, telling the reader to do something they had already
 * done. The rule now lives in the file that decides what the shell is, and both callers follow
 * it. See the block above `shellDigest` in `build.mjs`.
 */

describe('the service worker cache version', () => {
  it('has been bumped for the shell that is actually built', async () => {
    const [digest, cache, recorded] = await Promise.all([
      shellDigest(),
      cacheVersion(),
      readFile(RECORD, 'utf8').then((t) => JSON.parse(t) as Record),
    ]);

    // Half of the pair: the record must describe the version sw.ts declares.
    expect(
      recorded.cache,
      `web/shell-version.json records "${recorded.cache}" but sw.ts declares "${cache}"`,
    ).toBe(cache);

    /**
     * The other half: the built shell must be the one that was recorded against it.
     *
     * **The per-file breakdown is printed on failure, and it is not decoration.** On 2026-08-16
     * this check disagreed between one laptop and CI about a commit that changed **one markdown
     * file** — and the message named no file, so three wrong explanations were tried before
     * anybody could see which of the fourteen had actually moved. A guard that says *something
     * changed* and stops there is one people re-record their way past.
     */
    const files = digest === recorded.sha256 ? [] : await shellFiles();

    expect(
      digest,
      [
        '',
        'The built shell has changed since this version was recorded.',
        '',
        'A browser that has already opened the app will keep serving the OLD shell until the',
        'cache version changes — that is what happened on 2026-08-04, four commits running.',
        '',
        'Two things, together:',
        `  1. bump CACHE in web/src/sw.ts (currently "${cache}")`,
        '  2. run `npm run shell:record` to store the new shell against it',
        '',
        'What this machine actually built — compare against the one that recorded:',
        ...files.map(
          (f) => `  ${f.sha256.slice(0, 16)}  ${String(f.bytes).padStart(7)}  ${f.name}`,
        ),
        '',
      ].join('\n'),
    ).toBe(recorded.sha256);
  }, 120_000);
});

/*
 * A `recordShell()` used to be exported from here, and nothing ever imported it —
 * `npm run shell:record` has always run `scripts/record-shell.mjs`, which did the same work
 * a third time. It is gone rather than rewired: a test file that can also *write* the thing it
 * checks is one careless import away from a check that repairs what it is checking, which is
 * the property `record-shell.mjs`'s own header says it exists to avoid.
 */
