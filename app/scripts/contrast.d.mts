/**
 * Types for `scripts/contrast.mjs`.
 *
 * Plain ESM rather than TypeScript for the same reason `build.mjs` is: it is run directly, as
 * `node scripts/contrast.mjs`, by whoever is changing a colour and wants an answer in one
 * command. `src/__tests__/contrast.e2e.test.ts` imports `MEASURE` from it so the check and the
 * command measure with **the same code** — the alternative is two implementations of WCAG
 * compositing, and the first one to drift makes a green suite mean nothing.
 */

/**
 * The measuring routine, as source, to be handed to `page.evaluate`.
 *
 * A string rather than a function because it runs inside the browser, not in Node: it reads
 * `getComputedStyle` and walks the real DOM. It evaluates to
 * `{ results, unmeasured }` — see the header in `contrast.mjs` for what "unmeasured" means and
 * why reporting it is better than guessing a ground.
 */
export const MEASURE: string;

/** Run `MEASURE` against a Playwright page. Same shape, for callers that have a page already. */
export function measurePage(page: {
  evaluate: (script: string) => Promise<unknown>;
}): Promise<unknown>;
