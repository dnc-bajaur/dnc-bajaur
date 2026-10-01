/**
 * Types for `build.mjs`.
 *
 * The build script is plain ESM rather than TypeScript so it can be run directly with
 * `node build.mjs` and needs no compile step of its own. Two e2e suites import it to build
 * the web client before serving it, so it needs a declaration.
 */

/**
 * Build the web client. Returns the output directory.
 *
 * `out` defaults to `web/dist`. `shellDigest` passes its own directory instead, because
 * `web/dist` is shared with every browser suite and vitest runs them in parallel — see the
 * comment on `shellDigest` in `build.mjs`.
 */
export function buildWeb(out?: string): Promise<string>;

/**
 * Hash the files a browser caches under `sw.ts`'s `CACHE`, as one digest.
 *
 * Builds in production mode **into its own directory**, which it removes afterwards — it used
 * to measure inside the shared `web/dist` and was a race. Both `shell:record` and
 * `shellVersion.test.ts` call this, so the recorder and the check cannot disagree — which they
 * did once, on 2026-08-12. The list of files lives beside the implementation in `build.mjs`.
 */
export function shellDigest(): Promise<string>;

/**
 * The same measurement, file by file, for a failure message.
 *
 * The digest says *something* moved and never *what*. This is how somebody finds out which of
 * the fourteen files did, on the machine where it moved.
 */
export function shellFiles(): Promise<
  { name: string; bytes: number; sha256: string }[]
>;

/** The cache version `web/src/sw.ts` declares, read from its source. */
export function cacheVersion(): Promise<string>;
