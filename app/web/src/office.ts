/**
 * The office screens, in one file that is not part of the shell.
 *
 * The shell is what a field officer downloads at a scene on a weak connection, and the M1
 * gate holds it to a budget from `docs/00-thesis.md`. **None of the three screens re-exported
 * here is of any use at a scene**: the administration console configures departments, the
 * roster maintains people and posts, and the Status screen is where the district types what
 * the dashboard shows. All three are desk work, and all three are useless without a
 * connection — so nothing is lost by fetching them when somebody actually opens one.
 *
 * ## Why one bundle and not three
 *
 * `admin.ts` already imports `roster.ts` — the console reaches every department's roster, and
 * the "My department" tab is the same component through its other door (M1a-10). Splitting
 * them would put a second copy of the roster in one of the two bundles, and the point of this
 * exercise is fewer bytes, not tidier filenames. Status joins them because it is opened by the
 * same people in the same sitting.
 *
 * ## Why a barrel rather than `splitting: true`
 *
 * ESM output with hashed chunk names would mean the service worker could no longer name the
 * shell's files, and the app opening with no network is INV-01. See `build.mjs`.
 */

export { mountAdmin, type AdminConsole } from './admin.js';
export { mountRoster, type RosterPanel, type RosterHost } from './roster.js';
export { mountStatus, type StatusPanel } from './status.js';
