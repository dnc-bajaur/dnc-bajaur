/**
 * Searching the record, on a real screen — capability group 9.
 *
 * `api/__tests__/search.test.ts` proves the query. This proves the part that only exists once
 * something renders it, and it is the part this screen was built for:
 *
 *   1. **A search that finds nothing says what it looked at.** "Nothing matched" and "nothing
 *      matched in the window you happened to pick" are different statements about the
 *      district, and only the screen can tell them apart. ADR-0005, applied to a query.
 *   2. **A found incident reads exactly as it does on the board**, because both are built by
 *      the same renderer. A second one would drift, and then an emergency would say
 *      `unassessed` on one screen and something else on the other (INV-04).
 *   3. **The endpoint is reachable by a person**, which is the whole reason this file exists:
 *      `/search` shipped with nothing calling it, and an endpoint with no door is not a
 *      capability.
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

describe.skipIf(dbUrl === undefined)('searching the record, on a screen', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let actor: TestActor;
  let controlRoom: TestActor;

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

    actor = await seedActor(pool, { title: 'Search Test Duty Officer' });
    controlRoom = await seedActor(pool, { title: 'Search Test Control Room', tier: 'district' });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', controlRoom.phone);
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
   * An incident somebody has actually been told about, so it is genuinely theirs to find.
   *
   * ⚠️ **THE BROWSER SIGNS IN AS THE CONTROL ROOM SINCE ADR-0030, AND THIS DISPATCHES
   * RATHER THAN ROUTES.** It drove as a station officer and routed at that officer's department,
   * which worked while a department could hold an emergency. Migration 0039 left
   * `seat.department_id` behind, so `evaluateRead` refuses a non-administrative seat every routed
   * incident and every search came back **empty** — six tests sitting out their thirty seconds
   * waiting for a result that could not arrive. And `actor.departmentId` is now an id naming
   * nothing (`seedDepartment` is a no-op returning a fresh uuid), so routing at it wrote a
   * `routed` event about a department that does not exist while still answering 200.
   *
   * Nobody outside the control room signs in anyway (ADR-0024), so the browser is the reader this
   * screen actually has, and a dispatch is what places an emergency with somebody now.
   */
  async function seedIncident(description: string): Promise<string> {
    const created = await page.evaluate(async (words: string) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'rta', description: words }),
      });
      return (await res.json()) as { incidentId: string };
    }, description);

    const told = await fetch(`${origin}/incidents/${created.incidentId}/dispatch-to`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${controlRoom.token}`,
      },
      body: JSON.stringify({
        targets: [{ kind: 'post', id: actor.seatId }],
        reason: 'search e2e',
      }),
    });
    expect(told.status).toBe(200);

    return created.incidentId;
  }

  /**
   * **Search is a control on the Record now, not a tab of its own** — Phase 4b.
   *
   * The route, the projection and every assertion below are untouched: `api/search.ts` always
   * shared `projectIncidents` with the board and differed only in which incidents it selected,
   * so folding the two joined two SELECTIONS behind one screen rather than merging two
   * implementations. What moved is the door.
   *
   * ⚠️ `search.js` is still lazy, and it is now fetched on the **first focus** in the find
   * area rather than on opening the Record — so this clicks into the box and then waits, which
   * is what the old comment about waiting for the tab already established.
   *
   * ⚠️ **AND THE FORM IS BEHIND A DOOR SINCE 2026-08-26.** It used to stand open on every visit
   * to the Record — a text box, a status select and a submit button, about 250 pixels above the
   * queue — to serve a control most openings never touch, on the one screen an operator sits in
   * for a whole shift. `#boardFindToggle` opens it, and every test in this file goes through
   * this helper, so the door is opened in exactly one place.
   *
   * **What did not change is everything this file asserts**: the route, the projection, the
   * lazy fetch and the way a result reads. Search is one press away rather than zero.
   */
  /**
   * ⚠️ **CLOSE THE INCIDENT DRAWER FIRST, OR THE NAV IS BEHIND A BACKDROP.**
   *
   * An incident opens in a modal slide-out now: `main[data-pane="open"]` puts `#detailBackdrop`
   * over the whole page, correctly — a viewer closes it with `#back` or by clicking the
   * backdrop. `openReportFor` opens an incident and leaves it open, so the next `openSearch()`
   * burned its full timeout with Playwright reporting `<div class="backdrop" id="detailBackdrop">
   * … intercepts pointer events`. Four failures about the post-incident report and the export,
   * all of them one unclosed drawer.
   */
  async function closeDetailIfOpen(): Promise<void> {
    const back = page.locator('#back');
    if (await back.isVisible()) {
      await back.click();
      await page.waitForSelector('main:not([data-pane="open"])');
    }
  }

  async function openSearch(): Promise<void> {
    await closeDetailIfOpen();
    await page.click('#navBoard');
    await page.waitForSelector('#boardView:not([hidden])');
    /**
     * ⚠️ **`#boardFindToggle` IS A TOGGLE, AND EVERY TEST IN THIS FILE SHARES ONE PAGE.**
     *
     * Clicked unconditionally it *shuts* a panel the previous test left open, and the wait
     * below then burns its whole timeout on a door being closed rather than opened — five of
     * these tests, thirty seconds each, all of them pointing at the search rather than at the
     * helper. Which tests are hit depends on whether the one before happened to navigate away
     * (`setRecordView` hides the panel on leaving Rows), so the failures come and go with the
     * order of the file, which is exactly what makes it read as a defect in the product.
     *
     * Ask the panel, never the button. A helper that has to know what the last test did is not
     * a helper.
     */
    if (await page.locator('#boardFind').isHidden()) await page.click('#boardFindToggle');
    await page.waitForSelector('#boardFind:not([hidden])');
    await page.click('#searchText');
  }

  it('is reachable from the navigation, which is the point of it', async () => {
    await openSearch();

    /**
     * The date range fills itself in, so the first search somebody tries is a real one rather
     * than an error about a missing field.
     *
     * ⚠️ **The race this used to wait out is GONE, and the wait is kept anyway.** These are
     * `#reportFrom`/`#reportTo` now — the Record's one date range (Phase 5), shared with the
     * Summary and Download views — and the shell fills them at boot rather than `mountSearch`
     * filling them after a lazy fetch. So the CI flake this comment was written about cannot
     * happen here any more. The wait stays because `search.js` is still lazy and this test's
     * subject is still *the controls work once they arrive*; a wait that is now cheap is not a
     * wait worth removing.
     */
    await page.waitForFunction(
      () =>
        /^\d{4}-\d{2}-\d{2}$/.test(
          (document.getElementById('reportFrom') as HTMLInputElement)?.value ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    );

    expect(await page.inputValue('#reportFrom')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await page.inputValue('#reportTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('finds an incident by the words in the report', async () => {
    const marker = `bypass-tanker-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');

    await page.waitForSelector(`#searchRows .row[data-incident="${id}"]`);
    expect(await page.locator('#searchSummary').textContent()).toMatch(/emergenc/);
  });

  /**
   * The reason the response echoes its window at all.
   *
   * An operator who searches, finds nothing, and is shown only "no results" concludes the
   * emergency never happened. The truth may be that it happened outside the fortnight they
   * happened to pick. The screen has to say which.
   */
  it('says what it searched when it finds nothing, rather than only "nothing"', async () => {
    await openSearch();
    await page.fill('#searchText', `no-such-thing-${Date.now()}`);
    await page.click('#searchForm button[type="submit"]');

    await page.waitForFunction(() => {
      const text = document.getElementById('searchSummary')?.textContent ?? '';
      return text.includes('Nothing');
    });

    const summary = (await page.locator('#searchSummary').textContent()) ?? '';

    // The window, in words, both ends of it.
    expect(summary).toMatch(/between .+ to .+/);
    expect(await page.locator('#searchRows .row').count()).toBe(0);
  });

  /**
   * One renderer, so a found incident cannot read differently from a live one.
   *
   * An unassessed report says the **word** on the board (INV-04, ADR-0009); if search built
   * its own rows it would eventually stop doing that, and the screen somebody uses to write a
   * post-incident report would be the one telling a different story.
   */
  it('renders a found incident exactly as the board does', async () => {
    const marker = `same-renderer-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');
    await page.waitForSelector(`#searchRows .row[data-incident="${id}"]`);

    const inSearch = await page.locator(`#searchRows .row[data-incident="${id}"]`).innerHTML();

    await page.click('#navBoard');
    await page.waitForSelector(`#boardRows .row[data-incident="${id}"]`);
    const onBoard = await page.locator(`#boardRows .row[data-incident="${id}"]`).innerHTML();

    expect(inSearch).toBe(onBoard);
  });

  /**
   * **One screen answers one question at a time** — Phase 4b.
   *
   * The Record can show a **day** or a **search**, and it must never show both: two lists of
   * incidents on one screen, one of them a period and one of them a query, is precisely the
   * "two surfaces describing two periods" confusion this milestone exists to remove. The strip
   * and the reports block go with the table, because every figure on them describes the **day**
   * — leaving them above a set of search results would put a count over rows it did not count,
   * which is the M11-06 defect wearing a new hat.
   *
   * And there is a way back. Without one a search is a dead end, which is what the Dashboard's
   * counters were before M11-A1.
   */
  it('shows a search INSTEAD of the day, and gives the day back', async () => {
    const marker = `find-mode-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');
    await page.waitForSelector(`#searchRows .row[data-incident="${id}"]`);

    // The day is not underneath it, and neither are the figures that describe the day.
    expect(await page.isVisible('#boardTable')).toBe(false);
    expect(await page.isVisible('#boardSummary')).toBe(false);
    expect(await page.isVisible('#boardReports')).toBe(false);

    await page.click('#boardFindBack');
    await page.waitForSelector('#boardTable:not([hidden])');

    expect(await page.isVisible('#boardResults')).toBe(false);
    expect(await page.isVisible('#boardSummary')).toBe(true);
  });

  it('opens an incident from a result, through the same detail screen', async () => {
    const marker = `open-from-search-${Date.now()}`;
    const id = await seedIncident(marker);

    await openSearch();
    await page.fill('#searchText', marker);
    await page.click('#searchForm button[type="submit"]');
    await page.click(`#searchRows .row[data-incident="${id}"]`);

    await page.waitForSelector('#detailView:not([hidden])');
  });

  /**
   * The post-incident report, and the PDF the scope list asks for.
   *
   * M1-06 built the report and served it at `GET /incidents/:id/report`. Like search and
   * export, **nothing in the client ever called it** — an operator asked for a report had no
   * way to get one. It is reached from the incident it is about rather than from a tab,
   * because nobody wants "a report": they want the report for the emergency in front of them.
   *
   * The PDF is the browser's own print dialogue driven by a print stylesheet, so there is
   * nothing to assert about the file itself — only that the document exists, says the true
   * things, and that the navigation is marked not to print.
   */
  describe('the post-incident report', () => {
    async function openReportFor(marker: string): Promise<string> {
      const id = await seedIncident(marker);

      await openSearch();
      await page.fill('#searchText', marker);
      await page.click('#searchForm button[type="submit"]');
      await page.click(`#searchRows .row[data-incident="${id}"]`);
      await page.waitForSelector('#detailView:not([hidden])');

      // The record tools live behind the footer's "More" menu since 2026-09-06.
      await page.click('#detailMoreBtn');
      await page.click('#detailReport');
      await page.waitForSelector('#piReportView:not([hidden])');
      await page.waitForFunction(() =>
        (document.getElementById('piReportBody')?.textContent ?? '').includes('Incident'),
      );

      return id;
    }

    it('is reached from the incident, and folds without anything being typed', async () => {
      const id = await openReportFor(`report-screen-${Date.now()}`);

      const text = (await page.locator('#piReportBody').textContent()) ?? '';
      expect(text).toContain(id);
      expect(text).toMatch(/Post-incident report/);
    });

    /**
     * The page the owner prints and files. It carried only the software's own title line; the
     * district asked for it on the Deputy Commissioner's letterhead — the office, not the tool.
     */
    it('opens with the district’s official letterhead, above its own title', async () => {
      await openReportFor(`report-letterhead-${Date.now()}`);

      const text = (await page.locator('#piReportBody').textContent()) ?? '';
      expect(text).toContain('Office of the Deputy Commissioner');
      expect(text).toContain('Khyber Pakhtunkhwa');
      expect(text).toContain('DNC Bajaur');

      // The seal rides IN the document as an <img> — so it prints even with the browser's
      // "background graphics" off — and it is a <div>, not a <header> (print CSS hides those).
      const seal = await page.getAttribute('#piReportBody .reportLetterhead__seal', 'src');
      expect(seal).toMatch(/^data:image\/jpeg;base64,/);

      // Masthead first, then the report's own <h2>.
      const beforeTitle = await page.evaluate(() => {
        const body = document.getElementById('piReportBody');
        if (body === null) return false;
        const lh = body.querySelector('.reportLetterhead');
        const h2 = body.querySelector('h2');
        if (lh === null || h2 === null) return false;
        return Boolean(lh.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      expect(beforeTitle).toBe(true);

      // And it survives print, unlike the page chrome.
      await page.emulateMedia({ media: 'print' });
      try {
        const printed = await page.evaluate(() => {
          const node = document.querySelector('#piReportBody .reportLetterhead');
          return node !== null && getComputedStyle(node).display !== 'none';
        });
        expect(printed).toBe(true);
      } finally {
        await page.emulateMedia({ media: 'screen' });
      }
    });

    it('prints the report and nothing else, whatever screens exist', async () => {
      /**
       * The one surface in this product with no undo — and it had no test at all.
       *
       * ADR-0007 refuses a PDF library, so the document put in front of the DC is this page
       * through the browser's own Print, and until today nothing anywhere checked what came
       * out of it.
       *
       * **What this test does not do.** It does not prove the exclusion rule in `report.css`
       * is needed. That was checked directly: the old rule listing each view by name and the
       * new `main > *:not(#piReportView)` both pass this, because inactive views also carry
       * `hidden` and `[hidden]` already means `display: none`. Two mechanisms, one outcome.
       *
       * What it does pin is the outcome itself — that printing yields the report and nothing
       * else — which is the property that actually matters and the one that would break if
       * *either* mechanism were later removed.
       *
       * Asserted under `emulateMedia({ media: 'print' })` against **every** section the
       * document actually has, discovered at runtime rather than listed here: a test that
       * names the screens would drift for exactly the same reason the stylesheet did.
       */
      await openReportFor(`report-print-${Date.now()}`);
      await page.emulateMedia({ media: 'print' });

      try {
        const shown = await page.evaluate(() =>
          Array.from(document.querySelectorAll('main > section'))
            .filter((s) => getComputedStyle(s).display !== 'none')
            .map((s) => s.id),
        );
        expect(shown).toEqual(['piReportView']);

        // The chrome goes too: a printed page has no clock, no ticker and no navigation.
        const chrome = await page.evaluate(() =>
          ['nav', 'status', 'ticker']
            .filter((id) => {
              const node = document.getElementById(id);
              return node !== null && getComputedStyle(node).display !== 'none';
            })
            .concat(
              document.querySelector('header') !== null &&
                getComputedStyle(document.querySelector('header')!).display !== 'none'
                ? ['header']
                : [],
            ),
        );
        expect(chrome).toEqual([]);
      } finally {
        // Every later test in this file reads the screen, and a page left in print media
        // would answer for paper.
        await page.emulateMedia({ media: 'screen' });
      }
    });

    /**
     * The section a hand-written report always omits, and the one a review most needs.
     *
     * Printed always — including when there is nothing missing, because "we checked and found
     * no gaps" and "nobody looked" must not read identically (ADR-0005).
     */
    it('always states what the record does not contain', async () => {
      await openReportFor(`report-gaps-${Date.now()}`);

      expect(await page.locator('#piReportBody').textContent()).toMatch(
        /What this record does not contain/,
      );
    });

    it('keeps the navigation off the printed page', async () => {
      // The PDF is the browser's print of this screen. A printed page has no tab bar, and a
      // report carrying one is a report somebody has to explain when they file it.
      const marked = await page.evaluate(
        () => document.getElementById('piReportActions')?.classList.contains('noPrint') ?? false,
      );

      expect(marked).toBe(true);
    });
  });

  describe('taking the record out', () => {
    it('offers the export from the board, as a real download link', async () => {
      // The report tests above leave an incident open; its backdrop covers the nav.
      await closeDetailIfOpen();
      await page.click('#navBoard');
      await page.waitForSelector('#boardView:not([hidden])');

      const href = await page.getAttribute('#boardExportLink', 'href');
      expect(href).toMatch(/^\/export\/incidents\.csv/);
      // A plain link, so the browser does the download. A fetch-and-blob would take that away.
      expect(await page.getAttribute('#boardExportLink', 'download')).not.toBeNull();
    });

    it('serves a spreadsheet that carries the caller’s own incidents', async () => {
      const marker = `exported-${Date.now()}`;
      const id = await seedIncident(marker);

      const csv = await page.evaluate(async () => {
        const res = await fetch('/export/incidents.csv?days=7', { cache: 'no-store' });
        return {
          status: res.status,
          type: res.headers.get('content-type'),
          body: await res.text(),
        };
      });

      expect(csv.status).toBe(200);
      expect(csv.type).toMatch(/text\/csv/);
      expect(csv.body).toContain(id);
      /**
       * Capability 12: nothing a reporter told us in confidence leaves in this file.
       *
       * **Bounded by non-hex, and that is not pedantry.** The first version was
       * `/\+92|03\d{9}/`, which matches happily **inside a uuid** — the last group of
       * `e44fe9cb-e4cc-41f9-b819-703833414977` contains `03833414977`. Every row of this export
       * carries an incident id, so the check failed at random as the test database filled up,
       * and it was failing for a reason that has nothing to do with privacy.
       *
       * A false alarm on the one assertion that guards a privacy promise is worse than no
       * assertion: it gets muted. A real number in a cell is surrounded by a quote or a comma,
       * never by hex.
       */
      expect(csv.body).not.toMatch(/(?<![0-9a-f-])(\+92\d|03\d{9})(?![0-9a-f-])/i);
    });
  });
});
