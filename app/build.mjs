/**
 * Build the web client into `web/dist`.
 *
 * esbuild only, and it is **declared** in package.json rather than borrowed.
 *
 * It used to be imported without being declared, on the reasoning that vitest already ships
 * it so nothing new was being installed. True, and still a phantom dependency: the import
 * resolved because npm happened to hoist another package's internals to the top level. It
 * would break on a vite bump, on a stricter package manager, or on a clean install that
 * deduped differently — and it would break the *build*, at a moment nobody was touching the
 * build. Declaring it installs nothing extra (it dedupes to the same copy) and costs one
 * line; the alternative was a failure mode with no obvious cause. See ADR-0007.
 * The service worker is a separate entry point because it must be served from the origin
 * root as its own file; a bundler that inlined it would silently limit its scope.
 */

import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, 'web');
const dist = join(web, 'dist');

/**
 * The manifest, and the icons it needs to be installable.
 *
 * It had none until the district's installer was built, and a manifest with no icons is not a
 * cosmetic gap: **Chrome will not offer "Install" without a 192 and a 512**, so every officer
 * who was meant to add this to a home screen got a browser tab instead. The whole reason
 * ADR-0013 has one application on every screen is that the phone in a field officer's hand
 * opens it like an app.
 *
 * `maskable` is listed separately rather than as a second `purpose` on the same file. Android
 * crops an icon to whatever shape the launcher uses; the edge-to-edge drawing loses its pulse
 * line to a circular mask, and the inset one has a visible border everywhere else.
 * `scripts/make-icons.mjs` renders both from `web/icon.svg`.
 */
const manifest = {
  name: 'District Nerve Center — Bajaur',
  short_name: 'Nerve Center',
  start_url: '/',
  display: 'standalone',
  /**
   * Both colours are `index.html`'s `--paper`, and both were wrong once already — before the
   * installer existed they carried an older paper-ground palette while the page had already
   * moved to the prototype's deep navy (ADR-0013). `background_color` is what Android paints
   * the splash screen — so launching from a home screen flashed cream and then went dark, on a
   * handset, at night, which is the one time that is worst.
   *
   * That older palette lived on in `theme.css`, which **no page has ever linked**. It was
   * deleted on 2026-08-14: a second, hand-maintained copy of the district's colours that had
   * already drifted once is not a safety net, it is the thing somebody later copies from. It
   * could not have become the token source either — it was never in `sw.ts`'s `SHELL`, so a
   * page that linked it would boot **unstyled with no network**, which is ADR-0002's whole
   * promise. Tokens live in `index.html`'s `:root`, beside the measured palette.
   *
   * Bumped again 2026-08-13 with the white palette (M9-42), and again on 2026-08-11. Three places carry this literal by
   * hand — this file, `index.html`'s `<meta theme-color>`, and the `.mark`/`.clock` glow
   * effects a few lines above `--primary` in the same file — because none of them can read a
   * CSS custom property. Change one, change all three, or the drift this comment already
   * describes once happens a second time.
   */
  background_color: '#f7f8fa',
  theme_color: '#f7f8fa',
  description: 'District emergency coordination for Bajaur.',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

/**
 * Read `NODE_ENV` **per build**, not once at import.
 *
 * These used to be computed at module load. Nothing noticed until the M1 gate tried to weigh
 * the shipped bundle by setting `NODE_ENV=production` around a call — and got the development
 * build back, because the flag had already been read minutes earlier. The gate then measured
 * an artefact 40% larger than anything the district downloads.
 */
/**
 * ...and `--production` is accepted as well as `NODE_ENV`, because the deploy was silently
 * shipping the development build — 2026-08-15.
 *
 * The live server was serving an **unminified** `app.js` with a `sourceMappingURL` on the end and
 * a 340 KB `.map` beside it: **118,911 bytes where the production build is 61,634**. Fifty-seven
 * kilobytes, to every handset in Bajaur, on first load, on one bar of signal — against a budget
 * whose whole existence is that number.
 *
 * The cause is the ordinary one. `dnc.service` sets `NODE_ENV=production` for the **running
 * process**; the deploy builds in a login shell, which has no such thing, so `npm run build`
 * produced a development bundle and nothing anywhere said so. The environment variable that
 * decides what the district downloads was set on the wrong side of the deploy.
 *
 * A flag can be written into the deploy command and read back from it. An absent environment
 * variable looks exactly like a correct one.
 */
function options() {
  const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

  return {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    // Sourcemaps in dev only; a production bundle should not ship internals.
    sourcemap: !production,
    minify: production,
  };
}

/**
 * The shell's comments, removed from what the district downloads — 2026-08-14.
 *
 * HTML comments have been stripped since M9-20, for 17 KB. **The CSS comments inside `<style>`
 * were not, and they measured 34.7 KB** — twice as much, and 46% of the entire style block.
 * Every one of them went to every handset in Bajaur, on one bar of signal, on first load.
 *
 * The note that stood here refused this, and its reasoning was sound: *"a regex would have to
 * understand where the style block ends and where a `/*` inside a string does not start one"*.
 * It would, and it cannot. **So this is not a regex.** It walks the characters, and the only
 * thing it has to know is whether it is inside a string — CSS has no nested comments, which is
 * what makes the rest of it a two-state machine rather than a parser.
 *
 * The comments themselves are untouched in `web/index.html` and must stay that way. They are
 * for whoever opens that file at 02:00; **nobody has ever read `web/dist/index.html`.**
 *
 * Verified the way a build step that rewrites CSS has to be: the full suite renders this exact
 * output across every screen, and the contrast pass reads computed colours back out of it. A
 * strip that broke a rule would not be subtle.
 */
function stripCssComments(css) {
  let out = '';
  let i = 0;
  let quote = null;

  while (i < css.length) {
    const c = css[i];

    if (quote !== null) {
      // Inside a string nothing starts a comment, and a backslash hides the next character —
      // including the closing quote. `content: "\""` is the case that punishes a regex.
      out += c;
      if (c === '\\') {
        out += css[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      // An unterminated comment means the source is already broken; drop the rest rather than
      // shipping half a rule, and the build's own output will show it immediately.
      i = end === -1 ? css.length : end + 2;
      continue;
    }

    out += c;
    i += 1;
  }

  // Comments leave their indentation and blank lines behind. Collapsing runs of them is worth
  // roughly another kilobyte and cannot change meaning: CSS treats all whitespace alike outside
  // strings, and strings have already been preserved above.
  return out.replace(/\n[ \t]*(?=\n)/g, '');
}

/** Both kinds, and only inside the shell's own `<style>` for the CSS half. */
function stripShellComments(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /(<style>)([\s\S]*?)(<\/style>)/g,
      (_match, open, css, close) => open + stripCssComments(css) + close,
    );
}

/**
 * **The shell's own stylesheet, minified — 2026-08-25, and it is 33 KB.**
 *
 * `app.js` has been minified since the build learned what `--production` meant. The stylesheet
 * never was, and it is **76% of `index.html`**: 90,004 bytes of the 118,302 an officer downloads,
 * carrying 4,126 newlines and 4,058 runs of indentation into Mamund on a handset.
 *
 * It went unnoticed because the two halves look alike from a distance. Comments *were* being
 * stripped from inside `<style>` — `stripCssComments` exists and was written for exactly this
 * file — so the CSS had visibly been thought about, and what remained was whitespace rather than
 * anything that reads as waste.
 *
 * ## Why this rather than a bigger budget
 *
 * The M1 gate's shell budget failed at 169 KB while this session was adding what the district
 * asked for, and **the budget is never the thing that moves** — this file says so twice already,
 * once for `dispatch.js` and once for `compose.js`: *"a budget which fails on a file nobody
 * downloads teaches everybody to raise the budget — so it was not raised."* The answer had to be
 * bytes that are not doing anything, and 33,151 of them were sitting in the indentation of a
 * stylesheet nobody reads in its built form. The shell lands at **137 KB against the 160 KB
 * budget**, which is more headroom than it has had since M4.
 *
 * ⚠️ **Production only.** The development build keeps every newline: `contrast.mjs` and the
 * browser suites read the shipped file, and a stylesheet on one line is one a human debugging at
 * 02:00 cannot step through. Nothing about the rules changes either way — this is whitespace and
 * colour notation, not a rewrite.
 *
 * ⚠️ **The source is untouched and must stay that way**, on the same terms as the comments above:
 * `web/index.html` is for whoever opens it, and nobody has ever read `web/dist/index.html`.
 */
async function minifyShellCss(html) {
  const blocks = [...html.matchAll(/(<style>)([\s\S]*?)(<\/style>)/g)];
  let out = html;
  for (const [match, open, css, close] of blocks) {
    const { code } = await transform(css, { loader: 'css', minify: true });
    out = out.replace(match, open + code + close);
  }
  return out;
}

export async function buildWeb(out = dist) {
  const common = options();
  await mkdir(out, { recursive: true });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'main.ts')],
    outfile: join(out, 'app.js'),
  });

  /**
   * The post-incident report, as its own file — **not part of the shell**.
   *
   * The shell is what a field officer downloads at a scene on a weak connection, and the M1
   * gate holds it to a budget from `docs/00-thesis.md`. When this screen was written the shell
   * stood at 159 KB against 160 KB: one kilobyte of headroom, which the budget existed to make
   * visible and duly did.
   *
   * The answer is not a bigger budget. **An officer standing at a road accident has no use for
   * a post-incident report**, and neither does the phone in their hand — this screen is office
   * work, read after everything is over, always with a connection. So it ships separately and
   * loads the first time somebody asks for one.
   *
   * Deliberately a second entry point rather than `splitting: true`: that needs ESM output and
   * hashed chunk names, and the service worker names the shell's files explicitly so the app
   * opens with no network (INV-01). Trading a known offline boot for a tidier build config is
   * not a trade this project makes.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'report.ts')],
    outfile: join(out, 'report.js'),
    // Attached to the window because the shell loads this with a script tag, not an import —
    // see the note above on why this is not an ESM chunk.
    globalName: 'DncReport',
  });

  /**
   * The office screens — console, roster, Status — in one file.
   *
   * One bundle rather than three because `admin.ts` already imports `roster.ts`: the console
   * reaches every department's roster, and "My department" is the same component through its
   * other door (M1a-10). Three entry points would put a second copy of the roster in one of
   * them, and the point of this is fewer bytes rather than tidier filenames.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'office.ts')],
    outfile: join(out, 'office.js'),
    globalName: 'DncOffice',
  });

  /**
   * The Settings panel — ADR-0032 phase 3, its own bundle for the reason `office.js` is one:
   * account management is desk work, useless without a connection, and a field officer at a
   * scene never opens it. `admin.ts` is already out of the shell; folding this in would push
   * it past the M1 budget (`backlog/settings-and-accounts.md`, "Shell budget").
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'settings.ts')],
    outfile: join(out, 'settings.js'),
    globalName: 'DncSettings',
  });

  /**
   * The dashboard (M4), out of the shell — M11-34.
   *
   * ## Why this one is different from every other lazy bundle here
   *
   * The rule `dispatchBundle.ts` writes down is **"lazy-loading is for screens somebody chooses
   * to open, never for the one they land on"** — and an office seat on a laptop *lands* on the
   * dashboard (see the sign-in handler in `main.ts`). So this entry point is only honest with
   * the prefetch that goes with it: the moment sign-in says this seat can see a dashboard, the
   * client fetches this file, rather than waiting for the click. Nobody who lands here waits
   * for a network round trip, and the service worker holds it afterwards.
   *
   * ## What it buys
   *
   * **22,371 bytes of shell**, measured — 19,095 of `dashboard.ts` and the whole of `tilt.ts`,
   * which nothing else in the shell imports. The shell was at **162,040 of 163,840** when this
   * was written: 1,800 bytes, and the faceted panel (M11-16) does not fit in 1,800 bytes. The
   * budget's own comment says the answer is never a bigger number.
   *
   * ⚠️ **`main.ts` must keep importing `startClock` and `startAges` from `dashboard.js`, and
   * nothing else.** They are global chrome — the running clock and the ages that count up on
   * *every* screen, signed in or out — so they stay in the shell. esbuild tree-shakes the rest
   * of the module away on its own, which is why there is no `dashboardBundle.ts` wrapper here:
   * the split is the import list, and it is 1,351 bytes against 20,446. Add one more import
   * from this module to `main.ts` and the saving quietly reverses with no test to say so —
   * `m1gate.e2e.test.ts` test 3 is what would notice, at the budget.
   *
   * The 1,351 bytes are therefore in both files. That is deliberate and it is the cheap half:
   * a wrapper module to save it would cost more in a second entry point than it returns.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'dashboard.ts')],
    outfile: join(out, 'dashboard.js'),
    globalName: 'DncDashboard',
  });

  /**
   * The recipient picker and the “who was told” panel — control-room work, and not in the
   * shell (M7-26). See `web/src/dispatchBundle.ts` for why: an officer at a road accident will
   * never open it, and the M1 gate is what noticed.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'dispatchBundle.ts')],
    outfile: join(out, 'dispatch.js'),
    globalName: 'DncDispatch',
  });

  /**
   * The compose form's kind-specific boxes — M9-08, and out of the shell for the same reason
   * as the picker above.
   *
   * The `#whatBlock` it fills is revealed only for an administrative seat, so a field officer
   * never fetches this. **The M1 gate is what decided it**, exactly as it did for `dispatch.js`:
   * the first version imported `domain/communications.ts` straight into `main.ts` and the shell
   * went to 162 KB against a 160 KB budget. That budget's own comment warns that a budget which
   * fails on a file nobody downloads teaches everybody to raise the budget — so it was not
   * raised.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'compose.ts')],
    outfile: join(out, 'compose.js'),
    globalName: 'DncCompose',
  });

  /**
   * Reports — the district reads its own record inside the app (M11-20).
   *
   * Lazy for the reason `search.js` and `report.js` are, and one more: it could not be in the
   * shell even if it should be. The shell had **4,803 bytes** of headroom against its 160 KB
   * budget when this was written, and the budget is never the thing that moves.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'reports.ts')],
    outfile: join(out, 'reports.js'),
    globalName: 'DncReports',
  });

  /** Search, on the same terms as the report: office work, and useless without a connection. */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'search.ts')],
    outfile: join(out, 'search.js'),
    globalName: 'DncSearch',
  });

  /**
   * "How to use" — the in-product guide (`web/src/help.ts`). Not in the shell for the same
   * reason search and report are not: a field officer at a scene never opens it. Unlike those
   * two it needs no connection *after* the first fetch — there is nothing dynamic in it to go
   * stale between loads.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'help.ts')],
    outfile: join(out, 'help.js'),
    globalName: 'DncHelp',
  });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'sw.ts')],
    outfile: join(out, 'sw.js'),
  });

  /**
   * `index.html`, with its comments left behind — M9-20.
   *
   * **This file is the single largest thing the district downloads**, and it was not close:
   * 114 KB against `app.js`'s 51 KB, on a 160 KB budget. The JavaScript is minified; the HTML
   * was copied byte for byte, so **every explanatory comment in it was shipped to every handset
   * in Bajaur**, on one bar of signal, on first load.
   *
   * That is 17 KB of prose. This project writes long comments on purpose and should keep doing
   * so — the comments are for whoever opens `web/index.html` at 02:00, and they stay exactly
   * where they are. Nobody has ever read `web/dist/index.html`.
   *
   * Found while adding four lines of CSS and watching the M1 gate fail by 2.7 KB. The gate was
   * right, the CSS was not the problem, and the honest fix was not to move more code out of the
   * shell — it was to stop shipping the documentation.
   *
   * **And the CSS comments too, since 2026-08-14** — see `stripCssComments` below. The note
   * that used to sit here said a regex could not do it safely, and that was right. It is not a
   * regex any more, and the reason for revisiting it was the number: **34.7 KB**, twice what
   * the HTML comments cost and 46% of the entire style block.
   */
  /**
   * ⚠️ **Line endings are normalised HERE, before anything strips a comment — 2026-08-16.**
   *
   * `git` checks this file out with CRLF on Windows and LF on Linux, and **the stripping below
   * does not produce the same output for the two.** Measured on one commit: 78,346 bytes from a
   * CRLF checkout against **77,052** from an LF one — 1,294 bytes of comment text that survived
   * on one platform and not the other, in the file every handset in Bajaur downloads.
   *
   * That cost most of an afternoon, because the symptom was `shellVersion.test.ts` disagreeing
   * between this laptop and CI about a **byte-identical tree**, and three plausible explanations
   * were tried and disproved first — a genuine parallel-build race (real, fixed, and not this),
   * line endings in the *output* (there are none), and the esbuild version (identical). The
   * per-file breakdown that finally answered it is now printed by the guard on failure.
   *
   * The digest normalises `\r\n` when it hashes, which is why this looked impossible: by then
   * the size difference is already baked in. **The convention of whoever checked the repository
   * out must not reach the built artifact at all**, so it is removed at the one point it enters.
   */
  const shellHtml = (await readFile(join(web, 'index.html'), 'utf8')).replace(/\r\n/g, '\n');
  // Read here rather than threaded down from `options()`, which is the only other place that
  // asks: one expression, and both of them are answering the same question about the same run.
  const production =
    process.env.NODE_ENV === 'production' || process.argv.includes('--production');
  const stripped = stripShellComments(shellHtml);
  await writeFile(
    join(out, 'index.html'),
    production ? await minifyShellCss(stripped) : stripped,
    'utf8',
  );
  // Fetched by the report screen, not by the shell — see the report entry point above.
  await cp(join(web, 'report.css'), join(out, 'report.css'));
  // search.css is GONE (Phase 4b): its rules moved into the shell when the find controls
  // moved onto the Record, which is a shell screen. A lazily fetched stylesheet there
  // would leave the form unstyled until somebody first focused it.
  await cp(join(web, 'reports.css'), join(out, 'reports.css'));
  await cp(join(web, 'help.css'), join(out, 'help.css'));
  /**
   * The office screens' and the recipient picker's styling — 2026-08-14.
   *
   * Both bundles have been lazy for a while (`office.js` since 2026-08-04, `dispatch.js` since
   * M7-26) and **their CSS had never followed them out of the shell**. An audit that asked of
   * every rule in `index.html` *which bundle could ever produce this selector* found 20 KB of
   * rules a field officer downloads and can never use, and two blocks — the inbox and the
   * alert ladder — that no bundle draws at all any more. Those two were deleted; these moved.
   */
  await cp(join(web, 'office.css'), join(out, 'office.css'));
  await cp(join(web, 'dispatch.css'), join(out, 'dispatch.css'));
  // The Settings panel — fetched beside `settings.js` on first open (ADR-0032 phase 3), held
  // under `CACHE` by the generic handler exactly as `office.css` is.
  await cp(join(web, 'settings.css'), join(out, 'settings.css'));
  /**
   * The icons, copied rather than generated.
   *
   * `scripts/make-icons.mjs` renders them from `web/icon.svg` and needs Playwright to do it.
   * Putting that in the build would make a browser download a prerequisite for producing a
   * favicon, on the district's own machine, for files that change about once a year. Same
   * argument as `npm run shell:record` being a separate command.
   *
   * `app.ico` rides along in the same folder: the Windows installer takes the desktop icon
   * from the built output, so the shortcut on a DC office desktop and the tile on a duty
   * officer's phone cannot drift apart.
   */
  await cp(join(web, 'icons'), join(out, 'icons'), { recursive: true });
  /**
   * The one typeface this product ships — 2026-08-19.
   *
   * Noto Nastaliq Urdu, SIL Open Font License, the **Arabic subset only** (161 KB), at weight
   * 600 to match `--w1`. It exists for one thing: the Urdu headlines in the Pakistan panel.
   * Everything else in this product is English in the system stack and stays that way — the
   * owner's line, not a default.
   *
   * ⚠️ **It is deliberately NOT in `sw.ts`'s `SHELL`.** Precaching it would put 161 KB into what
   * a field officer downloads at a scene, for a panel that only exists on the dashboard — and
   * the dashboard is itself a lazy bundle (M11-34). The generic handler caches it on first use
   * under the same `CACHE` string as `help.css` and `office.css`, which is the same trade those
   * two already make.
   *
   * Self-hosted rather than linked, because this application opens with no network (ADR-0002)
   * and a district on a bad line does not get to wait for Google's CDN.
   */
  await cp(join(web, 'fonts'), join(out, 'fonts'), { recursive: true });
  await writeFile(join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

  /**
   * A production build removes any `.map` left behind by a development one — 2026-08-15.
   *
   * **This does not make `build.mjs` clean `web/dist`, and it deliberately must not.** That
   * property is documented above and is load-bearing: a deleted source asset leaves its built
   * copy behind, the digest keeps moving, and somebody notices. Sweeping the directory would
   * hide exactly the thing that note exists to surface.
   *
   * A sourcemap is the one file this build can be certain about. A production build declares
   * `sourcemap: false`, so any `.map` sitting here was written by a different build and is stale
   * **by definition** — it cannot be a deliberate artefact of this one.
   *
   * Found the way these things are: the live server had eight of them, one 340 KB, served
   * alongside a minified bundle they no longer described.
   */
  if (options().minify) {
    for (const name of await readdir(out)) {
      if (name.endsWith('.map')) await rm(join(out, name));
    }
  }

  return out;
}

/**
 * The files a browser caches under `sw.ts`'s `CACHE`, hashed as one.
 *
 * ## Why this lives here, and in exactly one place
 *
 * It used to live in two: `src/__tests__/shellVersion.test.ts` computed it to *check*, and
 * `scripts/record-shell.mjs` computed it again to *record*. Two copies of the same rule, which
 * agreed only for as long as nobody edited one of them — and on 2026-08-12 somebody did. A file
 * was added to the check and not to the recorder, so `npm run shell:record` wrote a hash the
 * test then rejected: a red suite about nothing, naming a fix ("bump CACHE") that was already
 * done. The next person's reasonable move at that point is to distrust the guard.
 *
 * It belongs in `build.mjs` because this is the file that decides what the shell *is*. Add a
 * file to the build below, add it here, and both the check and the recorder follow — which is
 * the property the two copies could not have.
 *
 * ## Why it reads the directory instead of naming three files
 *
 * It named `index.html`, `app.js` and `help.css`, and **that was still a hand-maintained list
 * with the same failure as the two copies before it.** On 2026-08-13 one word changed in
 * `help.ts` — the acknowledge button's label — which rebuilds `help.js`, which **was not in the
 * list**. The guard would have passed, the version would not have been bumped, and every browser
 * that had already opened the app would have kept the old guide for ever. Exactly the fault of
 * 2026-08-04, in the one file nobody had thought to add, for the third time.
 *
 * `help.css` had been added by hand for precisely this reason and its sibling had not: it is
 * **not** in `sw.ts`'s `SHELL`, so it is never precached — but the generic fetch handler stores
 * it under the same versioned cache, and a stale copy outlives a deploy exactly like a stale
 * `index.html` does. **That is true of every lazy bundle**: `search.js`, `report.js`,
 * `office.js`, `dispatch.js` and their stylesheets were all one edit away from the same bug.
 *
 * So the list is gone. Everything the build emits at the top level is hashed, which means a
 * bundle added next year is covered by having been built rather than by being remembered.
 *
 * **`sw.js` is excluded, and not as an oversight.** `CACHE` is declared inside it, so hashing it
 * would make the digest change every time the version changes — the record could never be
 * written. A browser re-fetches `sw.js` and compares bytes on its own, so a service-worker change
 * ships without a cache version anyway. `.map` files are excluded because nothing serves them to
 * a district, and `icons/` because it is a directory whose contents change only when somebody
 * deliberately regenerates them.
 *
 * Names are hashed alongside contents, and the list is sorted, so a renamed file is a changed
 * shell and two machines agree on the order.
 *
 * Line endings are normalised so a Windows checkout and a Linux CI runner agree; without that
 * the test fails on whichever machine did not record it, which is a failure about nobody's
 * mistake and the kind people learn to ignore.
 */
export async function shellDigest() {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  /**
   * ⚠️ **Its own directory, and this is a defect fix rather than tidiness — 2026-08-16.**
   *
   * This measured into `web/dist`, the one directory **every browser suite also builds into**,
   * and vitest runs test files in parallel forks. So between this function's own build and the
   * `readFile` loop below, another suite's `buildWeb()` could — and did — replace the minified
   * bundles with development ones. The digest was a **race**, and it read as a content change:
   * `shellVersion.test.ts` went red on `57c9671`, a commit that changed **one markdown file and
   * nothing else**, which is what finally identified it. It had also produced two different
   * answers for one unchanged tree twice the same day.
   *
   * A guard that fails at random is worse than no guard, because the reasonable response to it
   * is to re-record until it goes green — which is precisely the "a check that silently repairs
   * what it is checking" failure `record-shell.mjs` exists to prevent, arriving through the one
   * door nobody was watching.
   *
   * Measuring somewhere else fixes both directions: nothing can overwrite what this is reading,
   * and this no longer leaves a **production** build in `web/dist` for the next suite to serve.
   */
  const root = join(here, 'web', '.digest');

  try {
    await rm(root, { recursive: true, force: true });
    await buildWeb(root);
    const hash = createHash('sha256');

    const cached = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name !== 'sw.js' && !e.name.endsWith('.map'))
      .map((e) => e.name)
      .sort();

    for (const name of cached) {
      hash.update(name);
      hash.update((await readFile(join(root, name), 'utf8')).replace(/\r\n/g, '\n'));
    }

    return hash.digest('hex');
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
    /**
     * Leave a development build in `web/dist`, and **do not remove this again.**
     *
     * ~~No longer needed, now that the measurement has its own directory.~~ **That was wrong and
     * CI proved it in one run: 22 failures, and `deployable.e2e.test.ts` fetching `/` got a 404.**
     * Several suites serve `web/dist` without building it first and had been relying on whatever
     * happened to have populated it — including this line. Taking it away left them serving an
     * empty directory.
     *
     * So the isolation above fixes the half that was actually broken — **nothing can overwrite
     * what this function is reading** — and this line stays for the half other suites depend on.
     * A development build, never the minified one just measured: `npm start` and the browser
     * suites should load what they expect.
     */
    await rm(root, { recursive: true, force: true });
    await buildWeb();
  }
}

/**
 * The same measurement, file by file — for the failure message only.
 *
 * A digest that has moved tells you *something* changed and **not what**, and this project has
 * now spent an afternoon on exactly that question: two machines disagreeing about one commit,
 * with nothing to say which of fourteen files was responsible. The check is the digest; this is
 * how somebody finds out why it moved, on the machine where it moved.
 */
export async function shellFiles() {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const root = join(here, 'web', '.digest-files');

  try {
    await rm(root, { recursive: true, force: true });
    await buildWeb(root);

    const names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name !== 'sw.js' && !e.name.endsWith('.map'))
      .map((e) => e.name)
      .sort();

    const out = [];
    for (const name of names) {
      const text = (await readFile(join(root, name), 'utf8')).replace(/\r\n/g, '\n');
      out.push({
        name,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text).digest('hex'),
      });
    }
    return out;
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
    await rm(root, { recursive: true, force: true });
  }
}

/** The cache version `sw.ts` declares. Read from the source, so the two cannot disagree. */
export async function cacheVersion() {
  const source = await readFile(join(here, 'web', 'src', 'sw.ts'), 'utf8');
  const match = /const CACHE = '([^']+)'/.exec(source);
  if (match?.[1] === undefined) throw new Error('could not read CACHE from web/src/sw.ts');
  return match[1];
}

// `file://${argv[1]}` does not round-trip on Windows — drive letters and separators differ.
// pathToFileURL is the only comparison that holds on every platform.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await buildWeb();
  // eslint-disable-next-line no-console
  console.log(`built -> ${out}`);
}
