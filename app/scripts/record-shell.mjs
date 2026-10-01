/**
 * Record the built shell against the cache version in `sw.ts` — `npm run shell:record`.
 *
 * Run this **after** bumping `CACHE`, never instead of it. The pair exists because on
 * 2026-08-04 the shell changed over four commits and the version string did not, so every
 * browser that had ever opened the app kept serving the old one — found by somebody opening it
 * and asking where the dashboard had gone.
 *
 * Deliberately a separate command rather than something a test writes for itself: a check that
 * silently repairs what it is checking is not a check.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheVersion, shellDigest } from '../build.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');

// Both of these come from `build.mjs` so that this script and `shellVersion.test.ts` cannot
// measure the shell differently — which they did, on 2026-08-12, for one commit. `shellDigest`
// handles the production build and puts the development one back afterwards.
const [sha256, cache] = await Promise.all([shellDigest(), cacheVersion()]);

await writeFile(
  join(app, 'web', 'shell-version.json'),
  `${JSON.stringify({ cache, sha256 }, null, 2)}\n`,
);

// eslint-disable-next-line no-console
console.log(`recorded ${cache} -> ${sha256.slice(0, 16)}…`);
