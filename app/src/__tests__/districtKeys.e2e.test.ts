/**
 * The district counters lead to exactly what they counted.
 *
 * The owner's requirement, in their words: a counter reading `Unassigned 5` must be clickable
 * **straight to those unassigned** — *"naa k randomly clickable"*.
 *
 * So the property under test is not "does the click do something". It is **that the number and
 * the rows agree**. A counter saying 5 that lands on 4 rows is worse than one nobody can
 * click: the number is on the district's home screen, it is the thing somebody reads at 02:00,
 * and a board that quietly disagrees with it teaches that neither can be trusted.
 *
 * That agreement is why every flag behind these is decided **on the server**, in the same fold
 * that produced the count (`BoardRow.held`, `.acknowledged`, `.occurredToday`,
 * `.notificationsUnmet`). A predicate re-derived in the browser would be a second
 * implementation of each rule, and the first to drift would break exactly this.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('the district counters', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  let office: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Every screen this suite drives, made available first — ADR-0016, M6-45. A fresh
    // installation offers the control room and nothing else, so a test asserting a screen
    // works has to turn it on, and this is the visible act of doing so.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    // A district-tier seat: the DC and AC HQ offices, whose dashboard this is.
    office = await seedActor(pool, { title: 'Keys Test DC Office', tier: 'district' });

    browser = await chromium.launch();
    page = await browser.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', office.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** An emergency nobody is routed to — no routing signals exist, so this is the real path. */
  async function unroutedIncident(): Promise<void> {
    const res = await fetch(`${origin}/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ category: 'rta', severity: 'high' }),
    });
    expect(res.status).toBe(201);
  }

  async function openDashboard(): Promise<void> {
    await page.click('#navDashboard');
    await page.waitForSelector('#dashboardView:not([hidden])');
    await page.waitForFunction(() => (document.querySelectorAll('#dashKeys .key').length ?? 0) > 0);
  }

  /** The number a named counter is showing. */
  async function counter(label: string): Promise<number> {
    return page.evaluate((want: string) => {
      for (const node of Array.from(document.querySelectorAll('#dashKeys .key'))) {
        if (node.querySelector('.k')?.textContent === want) {
          return Number(node.querySelector('.n')?.textContent ?? '0');
        }
      }
      return -1;
    }, label);
  }

  async function clickCounter(label: string): Promise<void> {
    await page.evaluate((want: string) => {
      for (const node of Array.from(document.querySelectorAll('#dashKeys .key'))) {
        if (node.querySelector('.k')?.textContent === want) (node as HTMLElement).click();
      }
    }, label);
    await page.waitForSelector('#boardView:not([hidden])');
    // The board refetches on arrival; wait for the filter bar it lands with.
    await page.waitForSelector('#boardFilter:not([hidden]), #boardRows .row');
    await page.waitForTimeout(600);
  }

  /**
   * What the click actually selected: which rows are shown, and which are hidden.
   *
   * **Asserted as set membership rather than as a total**, deliberately. The local test
   * database is shared and never cleaned, so other suites are inserting incidents while this
   * one runs — a first version compared the counter's number to the row count and failed with
   * 129 against 127, because the dashboard's fetch and the board's fetch are moments apart and
   * the district had moved in between. The numbers were right; the assertion was measuring
   * the clock.
   *
   * Membership is the stronger property anyway, and it is the one the owner asked for:
   * *straight to those, not randomly clickable.* Every row shown carries the flag, and every
   * row hidden does not — which cannot be satisfied by a filter that merely narrows.
   */
  async function selection(
    attr: string,
    want: string,
  ): Promise<{ wrongShown: number; wrongHidden: number; shown: number }> {
    return page.evaluate(
      ({ attr: a, want: w }) => {
        const rows = Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[];
        return {
          shown: rows.filter((r) => !r.hidden).length,
          wrongShown: rows.filter((r) => !r.hidden && r.dataset[a] !== w).length,
          wrongHidden: rows.filter((r) => r.hidden && r.dataset[a] === w).length,
        };
      },
      { attr, want },
    );
  }

  it('leads No one chosen to exactly the emergencies nobody has been told about', async () => {
    /**
     * **This step used to be `Unassigned`, and swapping it is the point.**
     *
     * `Unassigned` meant *the routing signals matched no department*. It was the right first
     * number while routing was the mechanism (ADR-0010), and by 2026-08-06 it had become a
     * second red number for something `Nobody told` already said better — telling somebody now
     * **places** the emergency, so an incident can only stay unassigned while nobody has been
     * told. Two alarms for one situation is how a district learns to read neither, and the
     * owner had it removed.
     *
     * The counter that stayed is the sharper one: *"the signals could not place it"* is a
     * configuration complaint, *"nobody has been told"* is something an operator fixes in ten
     * seconds from this screen.
     */
    await unroutedIncident();
    await unroutedIncident();

    /**
     * ⚠️ **THE PANEL HAS TO BE PUT ON THE WALL, BECAUSE IT IS NOT ON IT BY DEFAULT.**
     *
     * `departments` is a choosable panel and not one of `DEFAULT_LAYOUT`'s nine (ADR-0015), so a
     * district that has never arranged its wall does not have it — and this test drove a screen
     * where the section was present but `hidden`, waiting twenty seconds for a row that was
     * rendered and invisible. Choosing it here is the district's own act, done explicitly, which
     * is what an end-to-end test of that panel has to include.
     */
    const laid = await fetch(`${origin}/settings/dashboard-layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({
        panels: [
          { id: 'keys', size: 'large' },
          { id: 'departments', size: 'large' },
        ],
      }),
    });
    expect(laid.status).toBe(200);

    await openDashboard();

    // And the one that went is gone from the screen, not merely renamed. `-1` is `counter`'s
    // "no such tile" answer — a real counter reading zero would be `0`.
    expect(await counter('Unassigned')).toBe(-1);
    expect(await counter('No one chosen')).toBeGreaterThan(0);

    await clickCounter('No one chosen');

    const { shown, wrongShown, wrongHidden } = await selection('nobodytold', 'true');
    expect(shown).toBeGreaterThan(0);
    // Nothing shown that somebody was told about, and nothing nobody was told about left out.
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);
  });

  /**
   * ⚠️ **`Issued` came off the dashboard deck 2026-09-04 — gone from the screen, not merely
   * renamed, exactly like `Unassigned` above.**
   *
   * `Reported today` already answers *how much arrived*; a stage tile answering *how much is
   * still unanswered* beside it was the same complaint the owner made about `nobody has it` on
   * 2026-08-17 — two red numbers for one situation. See `web/src/dashboard.ts`'s header.
   *
   * The stage itself is unchanged — an unanswered emergency is still `Issued` on the board and
   * on the incident it opens (`domain/stages.ts`), and that filter is still reachable from the
   * board's own strip (`board.e2e` covers it). It is simply not counted a second time here.
   */
  it('has no Issued tile on the dashboard any more', async () => {
    await unroutedIncident();

    await openDashboard();
    expect(await counter('Issued')).toBe(-1);
  });

  /**
   * The one that would have been wrong without asking the board for closed rows.
   *
   * "Reported today" counts everything that happened today whether or not it is still open —
   * an emergency dealt with by lunchtime still happened today. The board's default view hides
   * closed incidents, so this counter would have led to fewer rows than it displayed.
   */
  it('leads Reported today to today’s emergencies, closed ones included', async () => {
    await unroutedIncident();

    await openDashboard();
    expect(await counter('Reported today')).toBeGreaterThan(0);

    await clickCounter('Reported today');

    const { shown, wrongShown, wrongHidden } = await selection('today', 'true');
    expect(shown).toBeGreaterThan(0);
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);

    // The board was asked for closed rows, which the default view does not carry.
    const askedForClosed = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((e) => e.name.includes('/incidents?closed=1')),
    );
    expect(askedForClosed).toBe(true);
  });

  it('leads Responded to exactly the ones somebody is working on', async () => {
    /**
     * **Replaces *"leads Open now to the whole live board"*, which went with its tile.**
     *
     * `Open now` was `Issued + Acknowledged + Responded` printed a second time under a fifth
     * name — the duplication the owner spotted on 2026-08-17 and the reason the deck was
     * rearranged. What it proved is not lost: the *board itself* is still reachable, from the
     * board's own strip, and `board.e2e` covers that. `Acknowledged` itself is gone from that
     * sum too now — see `web/src/dashboard.ts`'s header, 2026-09-04.
     *
     * This asserts the property that actually matters for a stage tile and is new: the figure
     * and the rows it opens are **one set**, matched on `data-stage`, which the server decided
     * (`stageOf`) rather than anything the browser re-derived. That is M11-06's rule applied to
     * the words the wall is now arranged around.
     */
    await openDashboard();
    const n = await counter('Responded');

    // Zero is not clickable, by this product's own rule, so there is nothing to assert about a
    // quiet district here — and saying so is better than a test that silently proves nothing.
    if (n === 0) return;

    await clickCounter('Responded');

    const { shown, wrongShown, wrongHidden } = await selection('stage', 'responded');
    expect(shown).toBeGreaterThan(0);
    expect(wrongShown).toBe(0);
    expect(wrongHidden).toBe(0);
  });

  describe('a counter that counted nothing', () => {
    /**
     * A zero opening a board that says "nothing matches" answers a question the counter had
     * already answered — and teaches that these numbers lead somewhere unreliable, which is
     * expensive for the one that matters at 02:00.
     */
    it('is not clickable', async () => {
      await openDashboard();

      const zeros = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dashKeys .key'))
          .filter((n) => Number(n.querySelector('.n')?.textContent ?? '0') === 0)
          .map((n) => ({
            label: n.querySelector('.k')?.textContent ?? '',
            clickable: n.classList.contains('go'),
          })),
      );

      for (const zero of zeros) {
        expect(zero.clickable, `"${zero.label}" reads 0 and should not be clickable`).toBe(false);
      }
    });

    it('says so on the ones that did count something', async () => {
      await openDashboard();

      const live = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dashKeys .key'))
          .filter((n) => Number(n.querySelector('.n')?.textContent ?? '0') > 0)
          .map((n) => ({
            clickable: n.classList.contains('go'),
            // Says where it goes before it is clicked, rather than after.
            label: n.getAttribute('aria-label') ?? '',
          })),
      );

      expect(live.length).toBeGreaterThan(0);
      for (const key of live) {
        expect(key.clickable).toBe(true);
        expect(key.label).toMatch(/^Show /);
      }
    });
  });

  /**
   * The same property, one panel down — and it was **not** holding.
   *
   * The counters above were built with the rule this file exists for: the flag is decided in the
   * server's fold and written onto the row, so the number and the rows are one set. This panel
   * leads through a different door, and that door has now been broken twice, the same way both
   * times — **the panel counted one thing and the filter matched another.**
   *
   * The first time, `incidentRow.ts` wrote the list with `join()` and `main.ts` read it with
   * `split()`. For one department that round-trips and every existing test passes; for two it
   * fused the names, matched neither, and the panel said *3 open* over a board saying *nothing
   * matches* — the failure the owner named.
   *
   * ⚠️ **THE SECOND TIME IS WHAT THIS TEST NOW GUARDS, AND IT IS THE MORE DANGEROUS ONE.**
   * ADR-0029 re-aimed the panel from departments to **Open by officer** and left the door keyed
   * on `data-departments`. That still matched *something* while departments existed. Migration
   * 0039 empties `responsibleDepartments` on every row for ever, so every officer in that panel
   * would have opened a board that said *nothing matches* — not for a two-department incident,
   * but for **all of them**, permanently. The row carries `data-told` now, folded from the same
   * `dispatchedTo` the panel counts.
   *
   * So the subject moves from *two departments answer for it* to **two officers were told**,
   * which is the shape Bajaur's traffic actually has since ADR-0030, and the separator claim is
   * kept intact: two names must survive as two.
   */
  it('leads an officer to their incidents, including ones two officers were told about', async () => {
    const second = await seedActor(pool, { title: `Keys Second ${Date.now().toString(36)}` });

    const created = await fetch(`${origin}/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ category: 'fire', severity: 'high' }),
    });
    expect(created.status).toBe(201);
    const { incidentId } = (await created.json()) as { incidentId: string };

    // Two officers were told — a bazaar fire the control room hands to Rescue and the police at
    // once, which is the ordinary shape of a dispatch now that no department can absorb a post.
    const told = await fetch(`${origin}/incidents/${incidentId}/dispatch-to`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({
        targets: [
          { kind: 'post', id: office.seatId },
          { kind: 'post', id: second.seatId },
        ],
        reason: 'two officers answer for it',
      }),
    });
    expect(told.status).toBe(200);

    await openDashboard();

    /**
     * ⚠️ Wait for the **departments** panel, not just the counters.
     *
     * `openDashboard()` waits for `#dashKeys .key`, which is a different panel filled by a
     * different branch of the same paint. This test passed on timing alone until the shell was
     * re-split, then began failing in 125ms with "expected null not to be null" — the panel was
     * simply not drawn yet. Waiting for the thing being clicked is the fix; the previous version
     * was racing it.
     */
    await page.waitForFunction(
      () => document.querySelectorAll('#dashDepartments [aria-label]').length > 0,
      undefined,
      { timeout: 20_000 },
    );

    const opened = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('#dashDepartments [aria-label]')).find(
        (n) => (n.getAttribute('aria-label') ?? '').startsWith('Open the board for '),
      );
      if (node === undefined) return null;
      (node as HTMLElement).click();
      return (node.getAttribute('aria-label') ?? '').replace('Open the board for ', '');
    });
    expect(opened).not.toBeNull();

    await page.waitForSelector('#boardView:not([hidden])');
    await page.waitForSelector('#boardFilter:not([hidden]), #boardRows .row');
    await page.waitForTimeout(600);

    /**
     * Membership, like every assertion above it and for the same reason: the shared database
     * is never cleaned. Every row shown must name the department that was clicked, and no row
     * naming it may be hidden — which a filter that simply matched nothing cannot satisfy.
     */
    const result = await page.evaluate((want: string) => {
      const rows = Array.from(document.querySelectorAll('#boardRows .row')) as HTMLElement[];
      const names = (r: HTMLElement): string[] => (r.dataset['told'] ?? '').split('');
      return {
        shown: rows.filter((r) => !r.hidden).length,
        wrongShown: rows.filter((r) => !r.hidden && !names(r).includes(want)).length,
        wrongHidden: rows.filter((r) => r.hidden && names(r).includes(want)).length,
      };
    }, opened as string);

    // The board is not empty, which is the half that was failing.
    expect(result.shown).toBeGreaterThan(0);
    expect(result.wrongShown).toBe(0);
    expect(result.wrongHidden).toBe(0);
    /**
     * And the separator survived, rather than two names being fused into one.
     *
     * Read **after** the board has rendered, not while the dashboard was still up: the first
     * version of this line asked for the row before the board existed and got `null`, which is
     * the test measuring its own ordering rather than the product.
     */
    const carried = await page.evaluate(
      (id: string) =>
        document
          .querySelector(`#boardRows .row[data-incident="${id}"]`)
          ?.getAttribute('data-told') ?? null,
      incidentId,
    );
    expect(carried).not.toBeNull();
    expect((carried ?? '').split('')).toHaveLength(2);
  }, 120_000);
});
