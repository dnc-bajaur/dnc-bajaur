/**
 * Every colour pairing in the product, measured on the rendered page — M9-43, M9-44.
 *
 * ## Why this is a test and not a checklist
 *
 * On 2026-08-12 every pairing here had been **screenshotted and looked fine**. None had been
 * measured. Two failed AA — white on the emergency report button at 4.35:1, white on every
 * critical action at 3.76:1 — and they would have shipped to Bajaur looking correct in any
 * screenshot anybody took.
 *
 * On 2026-08-13 the district asked for a white interface, and **not one of those measurements
 * survived inverting the ground**. Amber text is the clearest case: `#f59e0b` reads 7.31:1 on
 * the old near-black card and **2.1:1 on white**. A token swap would have been unreadable and
 * would have looked, again, perfectly fine.
 *
 * So the ratio is computed from `getComputedStyle` on a real page in a real browser, with alpha
 * composited against whatever is actually behind it — not read out of the stylesheet, which
 * measures what somebody meant rather than what an officer gets.
 *
 * ## What it walks
 *
 * Signed out, then signed in, then each screen the nav offers. The screens differ in what they
 * paint — the board has severity tiles, the dashboard has state washes, the status screen has
 * five filled presence buttons — and a palette can pass on one and fail on the next.
 *
 * ## Every screen is walked TWICE, once per theme — 2026-08-20
 *
 * The district ran dark until 2026-08-13 and white after it, and the commit that made the swap
 * said the quiet part out loud: **not one measurement survived inverting the ground.** Amber
 * read 7.31 on the old near-black card and 2.1 on white. Restoring dark as a choice the officer
 * makes means both grounds are now live at once, on the same build, and a palette that passes on
 * one says nothing at all about the other.
 *
 * So `measure()` sets `data-theme` on the root, reads every pairing, sets it back, and reads
 * them again — and the dark half's selectors are prefixed `dark ·` so a failure names the
 * theme as well as the element. Every `it` below therefore covers both without any of them
 * being written twice; a screen added here is covered in both themes by having been added.
 *
 * ⚠️ It waits after the switch. `.tilt .face` transitions its `box-shadow` over 420ms and a
 * `getComputedStyle` taken mid-transition measures a colour that exists for a quarter of a
 * second and belongs to neither palette.
 *
 * ## The last test is the one about colour-blindness
 *
 * INV-04: colour was never the only carrier of state, and inverting the palette must not have
 * made it one. A severity is a **word** on the row, and the word survives whatever the colour
 * does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import { MEASURE } from '../../scripts/contrast.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

interface Pair {
  selector: string;
  sample: string;
  colour: string;
  ground: string;
  size: number;
  weight: number;
  threshold: number;
  ratio: number;
  passes: boolean;
}

interface Measurement {
  results: Pair[];
  unmeasured: { selector: string; sample: string; why: string }[];
}

/** Every failure, printed in full — a count tells nobody which colour to change. */
function describeFailures(where: string, pairs: Pair[]): string {
  return (
    `${where}: ${String(pairs.length)} pairing(s) below AA\n` +
    pairs
      .map(
        (p) =>
          `  ${String(p.ratio)} (needs ${String(p.threshold)}) — ${p.colour} on ${p.ground}` +
          `  ${p.selector}  "${p.sample}"`,
      )
      .join('\n')
  );
}

describe.skipIf(dbUrl === undefined)('both palettes, measured', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // District tier, so every screen is reachable — the console and the status screen included.
    actor = await seedActor(pool, { title: 'M9 Contrast Operator', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /**
   * One theme, measured. `null` is light — the absence of the attribute IS the default palette,
   * so the light half must be read with nothing set rather than with `data-theme="light"`,
   * which is a state the product never writes and would not prove the default is sound.
   */
  const inTheme = async (theme: 'dark' | null): Promise<Measurement> => {
    await page.evaluate((t) => {
      if (t === null) delete document.documentElement.dataset['theme'];
      else document.documentElement.dataset['theme'] = t;
    }, theme);
    // Longer than the slowest colour transition on any screen (.tilt .face, 420ms).
    await page.waitForTimeout(500);
    return page.evaluate(MEASURE) as Promise<Measurement>;
  };

  const measure = async (): Promise<Measurement> => {
    const light = await inTheme(null);
    const dark = await inTheme('dark');
    await inTheme(null);

    const mark = <T extends { selector: string }>(rows: T[]): T[] =>
      rows.map((r) => ({ ...r, selector: `dark · ${r.selector}` }));

    return {
      results: [...light.results, ...mark(dark.results)],
      unmeasured: [...light.unmeasured, ...mark(dark.unmeasured)],
    };
  };

  async function signIn(): Promise<void> {
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#who', { state: 'visible', timeout: 20_000 });
  }

  it('1. the sign-in screen — the first thing anybody in Bajaur sees', async () => {
    await page.goto(origin);
    await page.waitForSelector('#login');

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);

    expect(results.length, 'nothing was measured at all').toBeGreaterThan(3);
    expect(failures, describeFailures('sign-in', failures)).toHaveLength(0);
  });

  it('2. the intake screen, where the severity and category tiles live', async () => {
    await signIn();
    await page.waitForSelector('#submit');

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('intake', failures)).toHaveLength(0);
  });

  it('3. a selected tile — the filled state, which is where the 2026-08-12 failures were', async () => {
    await page.click('label[for="cat-fire"]');
    await page.click('label[for="sev-critical"]');

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);

    /**
     * The pairing that failed twice before. `--critical-fill` under white text is the emergency
     * report button and every destructive action in the product; `--primary-fill` is every
     * confirming one. Asserted as present, not merely as passing — a selector that stopped
     * matching would make this test green by measuring nothing.
     */
    const filled = results.filter((r) => r.colour === 'rgb(255, 255, 255)');
    expect(filled.length, 'no white-on-fill pairing was found to measure').toBeGreaterThan(0);
    expect(failures, describeFailures('a selected tile', failures)).toHaveLength(0);
  });

  it('4. the board, with a real emergency on it', async () => {
    await page.click('#submit');
    await page.waitForSelector('#sent', { state: 'visible', timeout: 20_000 });
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])', { timeout: 20_000 });
    // A row, not an empty board — the severity word and the stage chip are what this measures.
    await page.waitForSelector('.row', { timeout: 20_000 });

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('board', failures)).toHaveLength(0);
  });

  it('5. the dashboard, which is read at four metres and never touched', async () => {
    await page.click('#navDashboard');
    await page.waitForSelector('#dashboardView:not([hidden])', { timeout: 20_000 });
    /**
     * ▶ **`#dashStill`, not `#dashActivity` — 2026-08-22.**
     *
     * `activity` came off `DEFAULT_LAYOUT` when the district's five landed, so its rows are no
     * longer visible on a default wall and waiting on them times out on a fault this test did
     * not cause. *Still running* is what a district now reads here, and it is also what brings
     * this pass the four pairings that arrived with it — the lane word, the two ages, and the
     * review mark, which sits on `--pending-wash` rather than on the card behind everything else.
     */
    /**
     * A carried row has to be ON THE PANEL before this measures anything new about it.
     *
     * An empty *Still running* draws one grey sentence and none of the four pairings that
     * arrived with it — the lane word, the two ages and the review mark — so a pass taken
     * against an empty panel would be green for the wrong reason. A flood carries by default
     * (`domain/carrying.ts`), which is why it is a flood.
     */
    await page.evaluate(async () => {
      await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category: 'flood',
          severity: 'serious',
          description: 'contrast pass — a carried row to measure',
        }),
      });
    });

    /**
     * ▶ **`#dashStill .srow`, not `#dashActivity` — 2026-08-22.**
     *
     * `activity` came off `DEFAULT_LAYOUT` when the district's five landed, so its rows are no
     * longer visible on a default wall and waiting on them times out on a fault this test did
     * not cause. *Still running* is what a district reads here now.
     */
    await page.waitForSelector('#dashKeys .key', { timeout: 20_000 });
    /**
     * ⚠️ **60 seconds, because the dashboard polls every 20.** This waited 20 and failed
     * on CI on somebody else's commit: on a fresh database the panel is empty until the poll
     * after the seed, so the wait and the cadence were the same number and the test was a coin
     * toss. It passed on a laptop only because that database already had carried rows.
     */
    await page.waitForSelector('#dashStill .srow', { timeout: 60_000 });

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('dashboard', failures)).toHaveLength(0);
  });

  it('6. the status screen, whose five presence buttons are all filled states', async () => {
    await page.click('#navStatus');
    await page.waitForSelector('#statusView:not([hidden])', { timeout: 20_000 });
    await page.waitForSelector('.sbtn', { timeout: 25_000 });

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('status', failures)).toHaveLength(0);
  });

  /**
   * Settings (ADR-0032 phase 3) — its own top-level panel, its own lazy stylesheet, and
   * nothing else in this file would ever reach it. It lands on the Overview: a grid of
   * counts-as-doors, a `--critical` error strip when a fetch fails, and a tab bar whose
   * active item is `--primary` on `--card2`. A palette can pass on one screen and fail on
   * the next; that is this suite's founding observation.
   */
  it('6b. the Settings panel, on its Overview tab', async () => {
    await page.click('#navSettings');
    await page.waitForSelector('#settingsView:not([hidden])', { timeout: 20_000 });
    await page.waitForSelector('#settingsTabs button', { timeout: 25_000 });
    await page.waitForTimeout(1_000);

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('settings overview', failures)).toHaveLength(0);
  });

  it('7. the administration console', async () => {
    await page.click('#navAdmin');
    await page.waitForSelector('#adminView:not([hidden])', { timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('console overview', failures)).toHaveLength(0);
  });

  /**
   * The console is two screens now, and measuring only the one it lands on would quietly stop
   * measuring the other.
   *
   * The Overview took over as the landing, so test 7 — unchanged in every other respect — now
   * reads the Overview's own pairings. The department cards, the findings, the signal chips and
   * the amber "has routing signals but a vacant designation" line are all on the tab below it,
   * and every one of them was inside test 7's subject until this change. This is that coverage,
   * kept rather than lost: a palette can pass on one screen and fail on the next, which is this
   * suite's own founding observation.
   */
  it('7b. the departments tab, which the console no longer lands on', async () => {
    await page.click('#adminTabs button[data-tab="departments"]');
    await page.waitForSelector('#adminDepartments', { timeout: 20_000 });
    await page.waitForTimeout(1_000);

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('console departments', failures)).toHaveLength(0);
  });

  /**
   * The dialog the console asks its four reason-required questions through.
   *
   * It carries pairings no other screen does — a body sentence in `--slate` on `--card`, white on
   * `--critical-fill` for a destructive confirm, and a disabled button — and it is only on screen
   * while somebody is answering it, so nothing else in this file would ever have measured it.
   * A palette can pass on one screen and fail on the next; that is this suite's founding
   * observation and a modal is the easiest screen in the product to forget.
   */
  it('7c. the dialog, which is only on screen while somebody is answering it', async () => {
    /**
     * ⚠️ **THE DOOR MOVED, THE DIALOG DID NOT — ADR-0030.**
     *
     * This opened the dialog by creating a department and retiring it. `POST /admin/departments`
     * answers **404** since migration 0039, so the card never appeared and the test sat out its
     * twenty seconds waiting for it — measuring nothing, on the one screen in the product whose
     * pairings no other test in this file can reach.
     *
     * A **group** is retired through the same `ask()` with the same `danger: true`, and groups
     * are alive and well. So the subject is unchanged: a body sentence in `--slate` on `--card`,
     * white on `--critical-fill` for a destructive confirm, and a disabled button.
     */
    await page.click('#adminTabs button[data-tab="groups"]');
    await page.waitForSelector('#adminGroups', { timeout: 20_000 });

    // Its own group, so the dialog has a delete button to open regardless of what else the
    // shared test database happens to hold.
    //
    // ⚠️ **Both doors are in the drawer now.** The tab used to carry a blank
    // `.card[data-group="new"]` and each card its own *Retire*; the redesign made creating a
    // group `+ Create New Group` in the header and the destructive action *Delete Group* inside
    // the group's own drawer. The dialog this test measures is the same `ask()`.
    const name = `Contrast dialog ${Date.now()}`;
    const drawer = page.locator('#adminDrawerBackdrop');

    /**
     * ⚠️ **FOUND BY ITS ID, NEVER BY ITS NAME.**
     *
     * Comparing the ids before and after the click survives a shared test database that already
     * holds groups, and does not depend on how a card happens to render the name.
     */
    const before = await page.$$eval('#adminGroups .g-card', (cards) =>
      cards.map((c) => (c as HTMLElement).dataset['group'] ?? ''),
    );

    await page.click('#adminGroups button:has-text("+ Create New Group")');
    await drawer.waitFor({ state: 'visible', timeout: 20_000 });
    await drawer.locator('.d-input').first().fill(name);
    await drawer.getByRole('button', { name: 'Create Group' }).click();

    const created = await page.waitForFunction(
      (prev: string[]) => {
        const ids = Array.from(document.querySelectorAll('#adminGroups .g-card')).map(
          (c) => (c as HTMLElement).dataset['group'] ?? '',
        );
        return ids.find((id) => id !== '' && !prev.includes(id)) ?? false;
      },
      before,
      { timeout: 20_000 },
    );
    const groupId = (await created.jsonValue()) as string;

    const card = page.locator(`#adminGroups .g-card[data-group="${groupId}"]`);
    await card.waitFor({ timeout: 20_000 });

    await card.click();
    await drawer.waitFor({ state: 'visible', timeout: 20_000 });
    await drawer.getByRole('button', { name: 'Delete Group' }).click();
    await page.waitForSelector('dialog.ask[open]', { timeout: 20_000 });
    await page.waitForTimeout(500);

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('console dialog', failures)).toHaveLength(0);

    /**
     * Leave nothing modal behind: an open dialog makes the page inert and every later test in
     * this file clicks something.
     *
     * ⚠️ **Two things are on top of the page now, not one.** Escape dismisses the `ask()`
     * dialog and leaves the group's drawer standing, and that drawer's own backdrop covers the
     * nav — tests 8 and 9 then sat out their timeouts clicking `#navHelp` through it. The
     * drawer's close button is what puts the page back.
     */
    await page.keyboard.press('Escape');
    await page.locator('#adminDrawerBackdrop .drawer-close').click();
  });

  it('8. the in-product guide, which carries its own stylesheet', async () => {
    // `help.css` is not in the shell and is cached separately. It had a
    // `rgba(255, 255, 255, 0.12)` border that became white-on-white the moment the ground
    // inverted — invisible, and invisible is the failure a screenshot never shows.
    await page.click('#navHelp');
    await page.waitForSelector('#helpView:not([hidden])', { timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const { results } = await measure();
    const failures = results.filter((r) => !r.passes);
    expect(failures, describeFailures('guide', failures)).toHaveLength(0);
  });

  it('9. state is still carried by words, not only by colour — INV-04', async () => {
    await page.click('#navBoard');
    await page.waitForSelector('.row', { timeout: 20_000 });

    /**
     * One man in twelve cannot separate the red from the green, and this is read by whoever is
     * on duty. Inverting a palette is exactly the kind of change that quietly leaves a state
     * legible only as a hue, so the words are asserted rather than assumed.
     */
    const words = await page.$$eval('.row', (rows) =>
      rows.map((row) => ({
        severity: row.querySelector('.sev')?.textContent?.trim() ?? '',
        stage: row.querySelector('.stage')?.textContent?.trim() ?? '',
        state: row.querySelector('.state')?.textContent?.trim() ?? '',
      })),
    );

    expect(words.length).toBeGreaterThan(0);
    for (const row of words) {
      expect(row.severity, 'a row states its severity as a word').not.toBe('');
      expect(row.stage, 'a row states its stage as a word').not.toBe('');
      expect(row.state, 'a row states what is happening as a sentence').not.toBe('');
    }
  });
});
