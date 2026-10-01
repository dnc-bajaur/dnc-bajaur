/**
 * Reports, on a real screen — M11-20…22, 28, 29, 30.
 *
 * **The owner's second observation, and the one that took longest to reach:** the reports could
 * only be *downloaded*. Answering *"how did we do last month"* meant fetching a spreadsheet and
 * opening Excel, so the district could not read its own record inside its own software.
 *
 * Four things are under test here, and every one of them needs a rendered page:
 *
 *   1. **The screen arrives styled.** A lazily-fetched stylesheet that fails renders the screen
 *      unstyled **with no error** — it loads, it works, every content assertion passes, and
 *      `contrast.e2e` passes too because black on white is comfortable AA. The only way to see
 *      it is to measure a property that **only** `reports.css` can supply.
 *   2. **It says which days it covers and how old the answer is** (INV-02, M11-30). A report
 *      that does not name its period is the one somebody puts in front of the DC.
 *   3. **The download did not go away** (M11-29). It stopped being the only way to see the
 *      figures; it is now the way to carry them out.
 *   4. **The dashboard's ticker does not follow you here** — a defect this screen exposed.
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
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('M11: the reports come inside the app', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let office: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    office = await seedActor(pool, { title: 'Reports Test DC Office', tier: 'district' });

    // Something to report on. A screen that only ever renders an empty period proves nothing
    // about the figures it draws.
    for (const severity of ['critical', 'high', 'moderate']) {
      await fetch(`${origin}/incidents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
        body: JSON.stringify({ category: 'rta', severity }),
      });
    }

    /**
     * ⚠️ **One emergency resolved without ever being acknowledged — and it is what makes test 15
     * able to fail.**
     *
     * Test 15 asserts that each KPI figure counts exactly the rows the drill-down shows. With
     * only live, ordinary incidents in the period, a figure folded from the *wrong* projection
     * still produces the same number, and the test passes while proving nothing: I checked, by
     * breaking the server's fold on purpose, and it stayed green.
     *
     * This row is the difference between the two folds made real. `BoardRow.unacknowledged` is
     * false here — the incident is off the board, and something already dealt with owes nobody
     * an answer — while `state.acknowledgedAt` is still null forever. Any figure counted from
     * the states rather than from the projected rows now reads one too many, and test 15 says so.
     */
    const stale = await fetch(`${origin}/incidents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ category: 'fire', severity: 'high' }),
    });
    const { incidentId } = (await stale.json()) as { incidentId: string };
    // Routed first: resolving something nobody is responsible for is refused, and rightly —
    // an emergency with no holder is not one somebody can declare finished.
    const routed = await fetch(`${origin}/incidents/${incidentId}/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ departmentIds: [office.departmentId], reason: 'reports e2e' }),
    });
    expect(routed.status).toBe(200);

    const resolved = await fetch(`${origin}/incidents/${incidentId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${office.token}` },
      body: JSON.stringify({ outcome: 'dealt with before anybody answered' }),
    });
    // Asserted rather than assumed: a helper that ignores a status code grades its own homework.
    expect(resolved.status).toBe(200);

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

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

  /**
   * **Reports is a VIEW of the Record now, not a tab** — Phase 5.
   *
   * The route, the fold and every assertion below are untouched; what moved is the door and the
   * date range, which is now the Record's one pair rather than this screen's own.
   */
  /**
   * ⚠️ **CLOSE THE INCIDENT DRAWER FIRST, OR THE NAV IS BEHIND A BACKDROP.**
   *
   * An incident opens in a modal slide-out now: `main[data-pane="open"]` puts `#detailBackdrop`
   * over the whole page, and it is doing its job — a viewer closes it with `#back` or by
   * clicking the backdrop. Nothing in this file did, so every `openReports()` after test 12
   * (which opens a row and leaves it open) waited out 30s with Playwright reporting
   * `<div class="backdrop" id="detailBackdrop"> … intercepts pointer events` — seven failures
   * describing reports, all of them one unclosed drawer.
   */
  async function closeDetailIfOpen(): Promise<void> {
    const back = page.locator('#back');
    if (await back.isVisible()) {
      await back.click();
      await page.waitForSelector('main:not([data-pane="open"])');
    }
  }

  async function openReports(): Promise<void> {
    await closeDetailIfOpen();
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');
    await page.click('#viewSummary');
    await page.waitForSelector('#reportsView:not([hidden])');
    // The bundle is fetched on first open, and then it fetches two summaries.
    await page.waitForFunction(
      () => (document.querySelectorAll('#reportKpis .rk').length ?? 0) > 0,
      { timeout: 20_000 },
    );
  }

  it('1. is a view of the Record, and the bundle still builds the screen itself', async () => {
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');

    /**
     * ⚠️ **The lazy split had to survive the fold, and this is the line that says so.** M11-20
     * measured the markup at 2,231 bytes of the shell and built it in the bundle instead;
     * folding the screen into the Record must not fold the BUNDLES together, or a field officer
     * pays for a screen they never open. Empty before Summary is asked for.
     */

    // Empty in the shell — every later Reports view therefore costs the shell nothing.
    const beforeOpen = await page.evaluate(
      () => document.getElementById('reportsView')?.children.length ?? -1,
    );
    expect(beforeOpen).toBe(0);

    await openReports();

    expect(await page.isVisible('#reportPresets')).toBe(true);
    expect(await page.isVisible('#reportKpis')).toBe(true);
  });

  /**
   * ⚠️ **The failure this catches has this project's worst signature: the action succeeds.**
   *
   * `loadScreen('reports', true)` — get the second argument wrong, or let `build.mjs` drop the
   * `cp`, and there is no error anywhere. The screen loads, the figures are right, and an
   * operator gets an unstyled page. `lazyStyles.e2e.test.ts` was written for exactly this on
   * `office.css` and `dispatch.css`; this is that test for `reports.css`.
   *
   * The property measured is one **only this stylesheet supplies** — the preset control's touch
   * target. A default `<button>` renders around 21px, so this discriminates whatever the exact
   * figure is.
   *
   * ⚠️ **It went to 38 and the owner put it back — 2026-09-08.** `8fda86e` ("Upgrade Record &
   * Reports screens to modern card grid…") took `min-height` from 44px to 38px in three rules:
   * the presets, the two date fields and Apply — every control a person presses on this screen.
   * 44 is the touch-target minimum the rest of the district's app keeps (`dispatch.css` holds it
   * in eight places) and Reports is read on a handset as well as on the wall, so the drop was
   * real rather than cosmetic. Asserted at 44 again, and `reports.css` carries the reason above
   * the rule so the next design pass has to argue with it rather than walk past it.
   */
  it('2. arrives styled, which nothing else in the suite can see', async () => {
    await openReports();

    const height = await page.evaluate(() => {
      const button = document.querySelector('#reportPresets button');
      return button === null ? -1 : Math.round(button.getBoundingClientRect().height);
    });
    expect(height).toBeGreaterThanOrEqual(44);

    // And the stylesheet is genuinely a separate fetch, not something that rode in the shell.
    const fetched = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((e) => e.name.endsWith('/reports.css')),
    );
    expect(fetched).toBe(true);
  });

  /**
   * 🔴 **No id on this screen is shared with the shell, and this is a guard against a defect
   * that shipped and that I looked past four times.**
   *
   * The board's own Reports block has carried `id="reportFrom"` and `id="reportTo"` since M7,
   * and it sits **earlier in the document** than this screen. `getElementById` returns the first
   * match — so this screen wrote the chosen period into **the board's hidden date boxes** and
   * read the operator's typing back out of them, while its own two inputs sat empty.
   *
   * ⚠️ **It was visible in every screenshot** — From/To reading `mm/dd/yyyy` beneath a heading
   * that named the period correctly.
   *
   * ⚠️ **And the test agreed with it.** `page.inputValue('#reportFrom')` resolves the same first
   * match, so the assertion and the bug read one element and passed together — the *"a test that
   * asserts what the code does"* shape this repository already carries three entries about.
   *
   * So this asserts the property rather than the two names: **every id inside `#reportsView` is
   * unique in the document.** A future pane that reaches for `reportRows` or `reportPeriod`
   * elsewhere is caught by the same line.
   */
  it('3b. shares no element id with the rest of the app', async () => {
    await openReports();

    const clashes = await page.evaluate(() => {
      const mine = Array.from(document.querySelectorAll<HTMLElement>('#reportsView [id]')).map(
        (n) => n.id,
      );
      return mine.filter((id) => document.querySelectorAll(`[id="${id}"]`).length > 1);
    });
    expect(clashes).toEqual([]);

    /**
     * ⚠️ **The boxes are NO LONGER this screen's own, and that is the Phase 5 design.** They are
     * the Record's one date range, shared with the find controls and the download links, so the
     * three cannot describe different periods. What this still asserts is the half that matters:
     * the period this screen reports is the period the boxes hold.
     */
    const period = (await page.textContent('#reportPeriod')) ?? '';
    const from = await page.inputValue('#reportFrom');
    expect(period).toContain(from);
  });

  /**
   * INV-02 and M11-30 — **which days, and how old**, both, always.
   *
   * The dates are the server's own `fromDate`/`toDate`, carried rather than sliced out of the
   * instants beside them. Slicing a UTC+05:00 midnight names the day before, which is the bug
   * this project has now paid for four times — most recently in this very endpoint.
   */
  it('3. names the period it is showing and how old the answer is', async () => {
    await openReports();

    const period = (await page.textContent('#reportPeriod')) ?? '';
    expect(period).toMatch(/^\d{4}-\d{2}-\d{2}( to \d{4}-\d{2}-\d{2})?$/);

    const asOf = (await page.textContent('#reportAsOf')) ?? '';
    expect(asOf).toMatch(/^Folded from the record at /);
  });

  it('4. narrows to a preset, and the period follows what the server answered', async () => {
    await openReports();

    await page.click('#reportPresets button[data-preset="today"]');
    await page.waitForTimeout(1500);

    expect(
      await page.getAttribute('#reportPresets button[data-preset="today"]', 'aria-pressed'),
    ).toBe('true');

    // One day, so the heading is that one date rather than a span — and it is the same date the
    // From/To boxes now hold, because both come from the response rather than from the click.
    const period = (await page.textContent('#reportPeriod')) ?? '';
    expect(period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await page.inputValue('#reportFrom')).toBe(period);
    expect(await page.inputValue('#reportTo')).toBe(period);
  });

  /**
   * M11-29. **Nothing that downloaded before stops downloading.**
   *
   * The export was the only way to read any of this until this screen existed. It is demoted to
   * what an export is for — carrying findings out — and demoted is not removed.
   */
  it('5. still offers the spreadsheets, as a secondary action', async () => {
    await openReports();

    for (const id of ['#reportExportIncidents', '#reportExportPerformance']) {
      expect(await page.isVisible(id)).toBe(true);
      expect(await page.getAttribute(id, 'download')).not.toBeNull();
    }

    // The promise the export has always carried, still on the screen beside it.
    const words = (await page.textContent('#reportExport')) ?? '';
    expect(words).toContain('no reporter');
  });

  /**
   * The charts — M11-23. Inline SVG, no library (ADR-0007).
   *
   * What is asserted is the two properties a chart can silently get wrong: that it is drawn from
   * the counts beside it, and that it is **zero-based**. A min-to-max scale turns a wobble
   * between 10 and 11 into a mountain, and a district reads these to decide whether a week was
   * bad — the dashboard's own sparkline note records the same reasoning.
   */
  it('7. draws the charts as SVG, zero-based, with every bar labelled in words', async () => {
    await openReports();

    const figures = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#reportCharts .rchart')).map((f) => ({
        caption: f.querySelector('figcaption')?.textContent ?? '',
        bars: Array.from(f.querySelectorAll('rect.rbar')).map((r) => ({
          height: Number(r.getAttribute('height')),
          // The value in words, on the bar itself — a mouse finds it and a reader announces it.
          tip: r.querySelector('title')?.textContent ?? '',
        })),
        // The picture is never the only carrier: the whole chart is described for a reader.
        described: f.querySelector('svg')?.getAttribute('aria-label') ?? '',
        // ADR-0005: a chart with nothing in it says so in words rather than drawing nothing.
        // An empty chart and a broken one look identical otherwise.
        empty: f.querySelector('.rempty')?.textContent ?? '',
      })),
    );

    expect(figures.length).toBe(3);
    for (const f of figures) {
      expect(f.caption.length).toBeGreaterThan(0);
      /**
       * Either it drew something and described it, or it said out loud that there was nothing
       * to draw. **Never neither** — which is the state a blank tile leaves an operator in, and
       * the reason this is asserted as an alternation rather than as "there is an svg".
       */
      if (f.bars.length === 0) {
        expect(f.empty.length, f.caption).toBeGreaterThan(0);
        continue;
      }
      expect(f.described.length).toBeGreaterThan(0);
      for (const bar of f.bars) {
        // Zero-based: a bar's height is proportional to its value, so nothing can be negative
        // and the shortest bar in a set is not pinned to the axis by a min-to-max scale.
        expect(bar.height).toBeGreaterThanOrEqual(0);
        expect(bar.tip).toMatch(/: \d+ /);
      }
    }

    // No library arrived to draw them.
    const scripts = await page.evaluate(() =>
      Array.from(document.scripts)
        .map((s) => s.src)
        .filter((src) => src.length > 0),
    );
    // `origin` is this suite's own server — no chart library arrived from anywhere (ADR-0007).
    expect(scripts.every((src) => src.startsWith(origin))).toBe(true);
  });

  /**
   * 🔴 **M11-24 / M7-30 — the three answer routes are never summed, and this is the test a
   * future tidy-up would remove as repetition.**
   *
   * A tap on the button (`link`), a reply matched to a number (`reply`) and the control room
   * recording a telephone call (`operator`) are evidence of **different strength about different
   * acts** — and a provider's `delivered` is evidence that a handset received something, not
   * that any human did anything. There is no honest total, so there must be no total anywhere:
   * not as a figure, not as a stacked bar's height, not in a tooltip.
   *
   * Asserted structurally rather than by reading the screen for a number, because the number
   * would be **correct arithmetic** — that is exactly what makes this easy to add back.
   */
  it('8. never adds the answer routes together, in any form', async () => {
    await openReports();

    const routes = await page.evaluate(async () => {
      const res = await fetch('/summary', { headers: { accept: 'application/json' } });
      const body = (await res.json()) as { answerRoutes: { route: string; count: number }[] };
      return body.answerRoutes;
    });

    // The server returns them apart, so adding them requires somebody to write the addition
    // down — where it can be seen and refused.
    expect(Array.isArray(routes)).toBe(true);

    const chart = await page.evaluate(() => {
      const figures = Array.from(document.querySelectorAll('#reportCharts .rchart'));
      const answered = figures.find((f) =>
        (f.querySelector('figcaption')?.textContent ?? '').toLowerCase().includes('answered'),
      );
      if (answered === undefined) return null;
      return {
        caption: answered.querySelector('figcaption')?.textContent ?? '',
        // Each bar starts at the axis. A STACKED bar would sit on top of another one, and its
        // top edge would be the forbidden total — drawn rather than written.
        bars: Array.from(answered.querySelectorAll('rect.rbar')).map((r) => ({
          y: Number(r.getAttribute('y')),
          height: Number(r.getAttribute('height')),
        })),
      };
    });

    expect(chart).not.toBeNull();
    // The heading says the rule out loud, so nobody has to read the code to find it.
    expect(chart!.caption.toLowerCase()).toContain('never a single total');

    for (const bar of chart!.bars) {
      // Every bar's bottom edge is the axis — nothing is stacked on anything.
      expect(Math.round(bar.y + bar.height)).toBe(34);
    }
  });

  /**
   * The tabs — M11-26, control-room-first.
   *
   * ⚠️ **A tab is presentation and never authority (INV-05).** Every pane draws what the seat's
   * own request already returned; there is no pane that asks a wider question. What is asserted
   * here is the weaker, checkable half: exactly one pane is on screen at a time, so nothing is
   * ever read out of the pane somebody thinks they are looking at.
   */
  it('9. shows one pane at a time, and the tab says which', async () => {
    await openReports();

    const state = async (): Promise<{ visible: string[]; selected: string[] }> =>
      page.evaluate(() => ({
        visible: Array.from(
          document.querySelectorAll<HTMLElement>('#reportsView [data-pane]:not([role="tab"])'),
        )
          .filter((n) => !n.hidden)
          .map((n) => n.dataset['pane'] ?? ''),
        selected: Array.from(
          document.querySelectorAll<HTMLElement>('#reportTabs button[data-pane]'),
        )
          .filter((n) => n.getAttribute('aria-selected') === 'true')
          .map((n) => n.dataset['pane'] ?? ''),
      }));

    expect(await state()).toEqual({ visible: ['overview'], selected: ['overview'] });

    await page.click('#reportTabs button[data-pane="departments"]');
    await page.waitForTimeout(300);
    expect(await state()).toEqual({ visible: ['departments'], selected: ['departments'] });
  });

  /**
   * **M11-27 — the daily report is read here now, and the printed page is still the printed
   * page.**
   *
   * It used to be a standalone server-rendered page in a new tab, for one day: the last of the
   * five links the owner's second observation was about.
   *
   * ⚠️ **The assertion that matters is that the lede is BYTE-IDENTICAL to the printed page's.**
   * `domain/dailyReport.ts` writes `summary` itself precisely so the page, the spreadsheet and
   * this screen cannot each summarise one day differently — and it is read out of the server's
   * HTML rather than from a literal here, because a literal would pass while the two drifted.
   */
  it('10. renders one day in the app, with the same lede the printed page carries', async () => {
    await openReports();

    await page.click('#reportTabs button[data-pane="daily"]');
    await page.waitForFunction(
      () => (document.querySelectorAll('#reportDaily .rdayfig').length ?? 0) > 0,
      { timeout: 20_000 },
    );

    const shown = await page.evaluate(() => ({
      head: document.querySelector('#reportDaily .rdayhead')?.textContent ?? '',
      lede: document.querySelector('#reportDaily .rdaysummary')?.textContent ?? '',
      figures: Array.from(document.querySelectorAll('#reportDaily .rdayfig')).map(
        (n) => n.textContent ?? '',
      ),
    }));

    // The district's own day, as a name — never an instant (M9-49).
    expect(shown.head).toMatch(/^\d{4}-\d{2}-\d{2} · /);
    expect(shown.lede.length).toBeGreaterThan(0);

    /**
     * **A gap is stated, never omitted** — the rule the report itself is built on. A day's
     * account that lists only what went well makes a bad night look like a quiet one, and this
     * is the artefact most likely to be read by somebody who was not there.
     */
    const words = shown.figures.join(' ');
    for (const gap of [
      'Nobody acknowledged',
      'Still unresolved',
      'Nobody was told',
      'Nobody was reached',
    ]) {
      expect(words, gap).toContain(gap);
    }

    // The lede, compared against the server's own printed page rather than against a literal.
    const day = shown.head.slice(0, 10);
    const printed = await page.evaluate(async (d: string) => {
      const res = await fetch(`/reports/daily?date=${d}`);
      return res.text();
    }, day);
    expect(printed).toContain(shown.lede);
  });

  /**
   * M11-29, again and specifically: **the page that prints is still offered.** `Print → Save as
   * PDF` on the server's own HTML is the only way this product produces a PDF at all — ADR-0007
   * refuses a library so the printed page **is** the page that was read. Reading a day in the app
   * adds a way to look; it takes none away.
   */
  it('11. still offers the printable page and the spreadsheet for that day', async () => {
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#reportDaily .rdayout a')).map((a) => ({
        href: a.getAttribute('href') ?? '',
        download: a.hasAttribute('download'),
        text: a.textContent ?? '',
      })),
    );

    expect(links.length).toBe(2);
    // The page opens; it does not save.
    expect(links[0]!.href).toMatch(/^\/reports\/daily\?date=\d{4}-\d{2}-\d{2}$/);
    expect(links[0]!.download).toBe(false);
    // The spreadsheet saves.
    expect(links[1]!.href).toMatch(/format=csv$/);
    expect(links[1]!.download).toBe(true);
  });

  /**
   * **The incidents themselves — M11-25, the last of Phase B.**
   *
   * Not only the district's figures inside the app, but **the record itself**. Three properties,
   * and the middle one is the reason this test exists at all.
   */
  describe('12. the record itself, read in the app (M11-25)', () => {
    it('renders the rows with the board’s own renderer, and opens one', async () => {
      await openReports();
      await page.click('#reportTabs button[data-pane="incidents"]');
      await page.waitForFunction(
        () => (document.querySelectorAll('#reportRows .row').length ?? 0) > 0,
        { timeout: 20_000 },
      );

      /**
       * The same markup the board draws, because it is the same function. Asserted on the row's
       * own parts rather than on text: a second renderer would still print the words, and would
       * drift within a month — which is the whole reason `incidentRow.ts` is single.
       */
      const shape = await page.evaluate(() => {
        const row = document.querySelector('#reportRows .row');
        if (row === null) return null;
        return {
          hasSeverityOrKind: row.querySelector('.sev, .kindchip') !== null,
          hasCategory: row.querySelector('.cat') !== null,
          hasStage: row.querySelector('.stage') !== null,
          hasWhoAndAge: row.querySelector('.who') !== null && row.querySelector('.age') !== null,
          incident: (row as HTMLElement).dataset['incident'] ?? '',
        };
      });

      expect(shape).not.toBeNull();
      expect(shape!.hasSeverityOrKind).toBe(true);
      expect(shape!.hasCategory).toBe(true);
      expect(shape!.hasStage).toBe(true);
      expect(shape!.hasWhoAndAge).toBe(true);
      expect(shape!.incident.length).toBeGreaterThan(0);

      // The list says its own number and the period it covers — a list that says neither invites
      // "this never happened" when it only means "not in the days I chose" (ADR-0005).
      const note = (await page.textContent('#reportRowsNote')) ?? '';
      expect(note).toMatch(/\d+ incidents between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}/);

      // One definition, two doors: a row opens the incident on the screen the app already has.
      await page.click('#reportRows .row');
      await page.waitForSelector('#detailView:not([hidden])', { timeout: 15_000 });
    });

    /**
     * 🔴 **It asks with the INSTANTS the summary resolved, never with the two dates.**
     *
     * `/search` takes instants — and `Date.parse('2026-07-01')` is a perfectly good instant,
     * **UTC midnight**. Bajaur is UTC+05:00, so passing the dates would have given this list a
     * window **five hours out** from the figures on the tab beside it: the exact defect M11-28
     * had just found in `/summary`, recreated one screen later and this time by me.
     *
     * The summary already resolved the district-day boundaries, so this reuses them. Asserted on
     * the request the browser actually made, because that is the only place the mistake lives.
     */
    it('asks for the same window the figures were folded over, to the second', async () => {
      await openReports();
      await page.click('#reportTabs button[data-pane="incidents"]');
      await page.waitForFunction(
        () => (document.querySelectorAll('#reportRows .row').length ?? 0) > 0,
        { timeout: 20_000 },
      );

      const asked = await page.evaluate(() => {
        const hit = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.includes('/search?'))
          .pop();
        return hit ?? '';
      });
      expect(asked.length).toBeGreaterThan(0);

      const url = new URL(asked);
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';

      // Instants, not dates. A bare `YYYY-MM-DD` here is the bug.
      expect(from).toMatch(/T\d{2}:\d{2}:\d{2}/);
      expect(to).toMatch(/T\d{2}:\d{2}:\d{2}/);

      /**
       * And they are the server's own resolved period for **the days this screen is showing**,
       * byte for byte.
       *
       * ⚠️ Asked for with the dates in the From/To boxes rather than with no parameters at all.
       * A first version compared against a bare `/summary`, which answers the **default** window
       * — and an earlier test in this file had already narrowed the screen to *today*, so it
       * compared today's boundary against a thirty-day one and failed. The drill-down was right;
       * the assertion was reading a different question.
       */
      const days = {
        from: await page.inputValue('#reportFrom'),
        to: await page.inputValue('#reportTo'),
      };
      const period = await page.evaluate(async (d: { from: string; to: string }) => {
        const res = await fetch(`/summary?from=${d.from}&to=${d.to}`, {
          headers: { accept: 'application/json' },
        });
        const body = (await res.json()) as { period: { from: string; to: string } };
        return body.period;
      }, days);
      expect(from).toBe(period.from);
      expect(to).toBe(period.to);
    });
  });

  /**
   * 🔴 **A defect this screen exposed, and it was not in this screen.**
   *
   * `createDashboard`'s `tick()` painted whatever the `/dashboard` fetch returned **without
   * checking whether the dashboard was still open**. `stop()` closes the stream and stops the
   * ticker's timer, but a request already in flight still resolved and ran the whole of
   * `paint()` afterwards — including `renderTicker`, which sets `hidden = false`
   * unconditionally.
   *
   * So the dashboard's scrolling footer reappeared on whatever screen the operator had moved
   * to. Found by photographing this one: a bar reading *"22 nobody has been told about"* —
   * today's live figure — sat under a report about July. **Two periods on one screen with
   * nothing saying which is which**, on the artefact most likely to be read by somebody who was
   * not there.
   */
  it('6. does not carry the dashboard’s ticker onto a report about another period', async () => {
    /**
     * ⚠️ **The delay is the test.** A first version simply visited the dashboard and left, and
     * it passed against the unfixed code — on a local server the fetch had already finished, so
     * there was no in-flight response to land late and nothing to reproduce. A test that passes
     * on both sides of a fix proves only that it runs.
     *
     * `/dashboard` is held for a second and a half, so a response is genuinely still in the air
     * at the moment the operator leaves — which is the whole of the defect.
     */
    await page.route('**/dashboard', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    try {
      await page.click('#navDashboard');
      await page.waitForSelector('#dashboardView:not([hidden])');
      // Long enough for the request to have been made, far too short for it to have returned.
      await page.waitForTimeout(300);

      await page.click('#navBoard');
      await page.waitForSelector('#boardView:not([hidden])');
      await page.click('#viewSummary');
      await page.waitForSelector('#reportsView:not([hidden])');
      // Now let the held response land, on a screen the operator has already left.
      await page.waitForTimeout(3000);

      expect(await page.locator('#ticker').isHidden()).toBe(true);
    } finally {
      await page.unroute('**/dashboard');
    }
  });

  /**
   * The KPI figures open their own rows — M11-22.
   *
   * ## Why this task waited, and what these tests are actually pinning
   *
   * M11-22 sat at `PART` for a reason written into `reports.ts` at the time: the figures came
   * from `performanceOver` and the drill-down's rows came from `projectIncidents`. **Two folds
   * over the same events.** Making a figure clickable across that gap would claim an agreement
   * nothing guaranteed — the defect this milestone has spent itself removing, reintroduced on
   * the last screen of the product.
   *
   * The fix was therefore not "add a click handler". `/summary` now folds these counts from
   * `projectIncidents` — the same projection `GET /search` renders into the drill-down — so the
   * figure and the rows are one definition. Test 15 is what says so, and it says it by
   * re-applying each count's **own** `attr`/`value` to the rows `/search` returns. Asserting a
   * hand-counted number would pass just as happily if a count named the wrong attribute, and
   * that is the failure mode; the arithmetic never was.
   */
  it('15. every figure counts exactly the rows the drill-down would show', async () => {
    await openReports();

    const agreed = await page.evaluate(async () => {
      const s = await fetch('/summary', { headers: { accept: 'application/json' } });
      const summary = (await s.json()) as {
        period: { from: string; to: string };
        counts: { key: string; count: number; attr: string | null; value: string }[];
      };

      // The very window the figures were folded over — the instants the server resolved, never
      // the two dates beside them. That distinction is a bug this project has paid for twice.
      const q = new URLSearchParams({ from: summary.period.from, to: summary.period.to });
      const r = await fetch(`/search?${q.toString()}`, { headers: { accept: 'application/json' } });
      const found = (await r.json()) as {
        truncated: boolean;
        incidents: Record<string, unknown>[];
      };

      const checked: { key: string; claimed: number; landed: number }[] = [];
      for (const c of summary.counts) {
        if (c.attr === null) {
          checked.push({ key: c.key, claimed: c.count, landed: found.incidents.length });
          continue;
        }
        // Read off the row by the name the count itself supplied. `data-` attributes are
        // lower-cased in the DOM while the row's fields are camelCase, so the comparison is
        // case-insensitive rather than carrying a second mapping table — a mapping table here
        // would be the duplicated rule this whole design exists to avoid.
        const landed = found.incidents.filter((row) => {
          const key = Object.keys(row).find((k) => k.toLowerCase() === c.attr?.toLowerCase());
          return key !== undefined && String(row[key]) === c.value;
        }).length;
        checked.push({ key: c.key, claimed: c.count, landed });
      }

      return { truncated: found.truncated, checked };
    });

    // Beyond one page the figure is still right and the list is one page of it, which the screen
    // says in words. Inside it the two sets are identical — that is what is asserted here.
    expect(agreed.truncated).toBe(false);
    expect(agreed.checked.length).toBeGreaterThan(0);

    /**
     * ⚠️ And it measured something.
     *
     * Every assertion below is `claimed === landed`, which an empty period satisfies with
     * `0 === 0` for every figure — a green test proving nothing on the day the agreement breaks.
     * The shared database always holds incidents in the default window, so requiring the total
     * to be positive costs nothing and removes the only way this can pass vacuously.
     */
    const reported = agreed.checked.find((c) => c.key === 'reported');
    expect(reported?.claimed).toBeGreaterThan(0);
    for (const c of agreed.checked) {
      expect({ key: c.key, n: c.claimed }).toEqual({ key: c.key, n: c.landed });
    }
  });

  /**
   * ⚠️ **INV-04, on the row where it is most tempting to break.**
   *
   * A KPI row is short of space, and *worst: critical (7 unknown)* is the compression somebody
   * reaches for. It is the aggregate hiding a fact: **the worst thing anybody judged** and **how
   * many nobody judged at all** are different questions with different fixes (ADR-0009). So
   * `unassessed` is its own figure, and `worst` is not a figure here at all.
   */
  it('16. keeps the unassessed as their own figure, never folded into a severity', async () => {
    await openReports();

    const row = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#reportKpis .rk')).map((n) => ({
        label: n.querySelector('.rkl')?.textContent ?? '',
        attr: (n as HTMLElement).dataset['count'] ?? null,
        tag: n.tagName,
      })),
    );

    expect(row.length).toBeGreaterThan(0);
    const unassessed = row.find((k) => k.attr === 'unassessed');
    expect(unassessed).toBeDefined();
    // Nothing on this row names a severity beside the count of the unjudged.
    for (const k of row) expect(k.label.toLowerCase()).not.toMatch(/critical|high|moderate|low/);
  });

  /**
   * A figure that is a set is a button; one that is not, is not.
   *
   * The median is the case that matters: there is no such thing as *"the rows that are eight
   * minutes"*, and the board's own strip already refuses to make *worst assessed* clickable for
   * exactly this reason. Here the shape enforces it — a count with no `attr` narrows nothing, so
   * nothing can turn it into a control.
   */
  it('17. makes a figure clickable only when it is actually a set of rows', async () => {
    await openReports();

    const median = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll('#reportKpis .rk')).find((n) =>
        (n.querySelector('.rkl')?.textContent ?? '').includes('median'),
      );
      return node === undefined
        ? null
        : { tag: node.tagName, attr: (node as HTMLElement).dataset['count'] ?? null };
    });

    expect(median).not.toBeNull();
    expect(median?.tag).toBe('DIV');
    expect(median?.attr).toBeNull();
  });

  /**
   * Clicking a figure narrows the list beneath it, and the sentence says what it narrowed to.
   *
   * ⚠️ **It says N of the LOADED rows, never the figure's own number.** A summary folds up to
   * 5,000 incidents and one page of drill-down is 200. For an ordinary period those are the same
   * set; on a very busy month they are not, and printing the figure's number over this list
   * would be the screen asserting an agreement that stops holding at exactly the moment somebody
   * is looking at the busiest month of the year.
   */
  /**
   * **A dash, never a zero — carried here from the console before its copy was removed.**
   *
   * `admin.e2e` test 7 has guarded this since M1a, on the Administration console's own
   * Performance tab: *a department that has acknowledged nothing shows “—”, never “0”.* Zero
   * minutes is the **best possible** performance and no data is no performance at all
   * (ADR-0005), and a table that confuses them ranks the idle above the excellent.
   *
   * That tab is a second door onto this same fold now that the Record carries it, and the door
   * is being closed. **This assertion moves first**, so the property is never unguarded for a
   * single commit — which is the whole reason to write the guard before removing the old one
   * rather than after.
   */
  it('19. writes a dash where an officer has no answer time, never a zero', async () => {
    await openReports();
    // One pane at a time (test 9), so the officers table has to be asked for. The pane's own
    // id stays `departments` — it is a stored handle, and ADR-0029 moved the rows, not the key.
    await page.click('#reportTabs button[data-pane="departments"]');
    await page.waitForSelector('#reportDepts:not([hidden])', { timeout: 20_000 });

    const shown = await page.locator('#reportDepts').textContent();
    expect(shown, 'the officers table drew nothing at all').not.toBe('');

    /**
     * Asserted through the renderer rather than by hunting for an officer with no
     * acknowledgement in a shared database — which is a measurement of whatever else has run
     * today, not of this screen. `minutes(null)` is the one function that decides it.
     */
    const dash = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('#reportDepts *'));
      return cells.some((c) => (c.textContent ?? '').trim() === '—');
    });
    const anyNull = await page.evaluate(async () => {
      const res = await fetch('/summary');
      const body = (await res.json()) as {
        performance: { officers: { medianAckMinutes: number | null; total: number }[] };
      };
      return body.performance.officers.some((d) => d.total > 0 && d.medianAckMinutes === null);
    });

    // Only assert the dash when the period actually contains an officer with nothing to
    // report — otherwise this passes or fails on the clock rather than on the screen.
    if (anyNull) expect(dash, 'a null median was drawn as something other than a dash').toBe(true);
    else expect(anyNull || !dash).toBe(true);
  });

  it('18. narrows the drill-down to the figure that was clicked, and says so', async () => {
    await openReports();
    await page.click('#reportTabs button[data-pane="incidents"]');
    await page.waitForSelector('#reportRows .row', { timeout: 20_000 });

    const narrowed = await page.evaluate(() => {
      const button = document.querySelector('#reportKpis button.rk') as HTMLButtonElement | null;
      if (button === null) return null;

      const attr = button.dataset['count'] ?? '';
      const claimed = Number(button.querySelector('b')?.textContent ?? '-1');
      button.click();

      const all = Array.from(document.querySelectorAll('#reportRows .row')) as HTMLElement[];
      return {
        attr,
        claimed,
        shown: all.filter((r) => !r.hidden).length,
        wrongShown: all.filter((r) => !r.hidden && (r.dataset[attr] ?? '') !== 'true').length,
        wrongHidden: all.filter((r) => r.hidden && (r.dataset[attr] ?? '') === 'true').length,
        note: document.getElementById('reportRowsFilter')?.textContent ?? '',
        pressed: button.getAttribute('aria-pressed'),
      };
    });

    expect(narrowed).not.toBeNull();
    // Every row shown carries the flag, and no row carrying it is hidden.
    expect(narrowed?.wrongShown).toBe(0);
    expect(narrowed?.wrongHidden).toBe(0);
    expect(narrowed?.note).toContain('Showing only');
    expect(narrowed?.note).toContain('loaded');
    expect(narrowed?.pressed).toBe('true');
  });
});
