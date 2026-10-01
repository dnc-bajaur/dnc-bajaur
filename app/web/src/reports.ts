/**
 * Reports — the district reads its own record, inside its own software (M11-20…22, 28, 30).
 *
 * **This screen exists because of one sentence from the owner:** the reports could only be
 * *downloaded*. Four of the five links on the Board are files, so answering *"how did we do last
 * month"* meant downloading a spreadsheet and opening Excel. A district that cannot read its own
 * record without leaving the product does not really have the record in the product.
 *
 * **The download is not removed and must not be** (M11-29). It moves from being the only way to
 * see the numbers to being the way to carry them out — which is what an export is for.
 *
 * ---
 *
 * ### Three rules this file is built under, each already paid for elsewhere
 *
 * **1. Nothing here calculates anything.** Every figure comes from `GET /summary`, which folds
 * the same events the board folds, through `performanceOver` — the same medians the console
 * shows. A second calculation in the browser is how a district comes to have two answers to one
 * question, and this milestone has already found that exact fault twice.
 *
 * **2. The district's "today" comes from the server, never from the handset.** Bajaur is
 * UTC+05:00 and a browser's clock is wherever the browser is. The presets below are built from
 * `period.toDate` — the district's own date, echoed by the server — and then moved with **plain
 * calendar arithmetic on `YYYY-MM-DD` strings**, which involves no timezone at all. That is the
 * whole reason there is no `new Date()` anywhere in the range logic.
 *
 * **3. It says which days it is showing, and how old the answer is** (INV-02, M11-30). A report
 * that does not name its period is the one somebody puts in front of the DC.
 */

import { incidentRow, type IncidentRowData } from './incidentRow.js';

interface Summary {
  period: { from: string; to: string; fromDate: string; toDate: string };
  /**
   * The clickable figures — M11-22.
   *
   * ⚠️ Optional on purpose: an older server has none, and a screen that assumed them would draw
   * an empty KPI row rather than one without buttons. The rule this file follows everywhere —
   * an absent field is "no", never the whole thing.
   */
  counts?: {
    key: string;
    label: string;
    count: number;
    attr: string | null;
    value: string;
    match: 'is' | 'has';
  }[];
  truncated: boolean;
  scope: 'district' | 'department';
  performance: {
    asOf: string;
    windowDays: number;
    district: {
      total: number;
      open: number;
      overdue: number;
      unassigned: number;
      medianAckMinutes: number | null;
      notificationsUnmet: number;
    };
    /**
     * ⚠️ **This was `departments` — ADR-0029, CD-05b.** The fold key moved from the department
     * that held an emergency to **whoever was told about it**, so the field moved with it rather
     * than keeping a name that had stopped being true.
     *
     * ⚠️ **A historical department still gets a row**, keyed `department:<id>`. Bajaur's record
     * before this change is department-shaped, and a table that dropped them would make every
     * period before today read as though nobody was responsible for anything.
     */
    officers: readonly {
      key: string;
      name: string;
      total: number;
      open: number;
      unacknowledged: number;
      overdue: number;
      escalated: number;
      closed: number;
      medianAckMinutes: number | null;
      withinTarget: number | null;
      notificationsUnmet: number;
    }[];
  };
  overTime: readonly { date: string; reported: number }[];
  severityMix: readonly { severity: string; count: number }[];
  answerRoutes: readonly { route: string; count: number }[];
}

/** `YYYY-MM-DD` → `YYYY-MM-DD`, `n` days later or earlier. Calendar arithmetic, no timezone. */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  // `Date.UTC` is used purely as a calendar, never as an instant: the value is converted straight
  // back to a `YYYY-MM-DD` string and no clock is consulted at either end.
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Which day of the week, 0 = Sunday. Again a calendar question, not a clock one. */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** How many whole days a range covers, inclusive — used to size the comparison period. */
function spanDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Minutes, in the district's own words. Null is said, never drawn as a zero. */
function minutes(value: number | null): string {
  if (value === null) return '—';
  const whole = Math.round(value);
  if (whole < 60) return `${String(whole)} min`;
  const hours = Math.floor(whole / 60);
  return `${String(hours)} h ${String(whole % 60)} min`;
}

/**
 * The change against the previous period of the same length.
 *
 * ⚠️ **Direction is stated in words, never by colour alone** (INV-04's rule, applied to a figure
 * rather than to a severity). "3 more" and "3 fewer" read the same to somebody who cannot
 * separate the two hues, and this is a screen a district puts in front of people.
 *
 * **A comparison against nothing is not drawn at all.** A period with no previous data would
 * otherwise show "+12" as though something had improved or worsened, when the honest answer is
 * that there is nothing to compare with.
 */
function delta(now: number, before: number | null): { text: string; tone: string } | null {
  if (before === null) return null;
  const diff = now - before;
  if (diff === 0) return { text: 'no change', tone: 'flat' };
  return {
    text: `${String(Math.abs(diff))} ${diff > 0 ? 'more' : 'fewer'} than the period before`,
    tone: diff > 0 ? 'up' : 'down',
  };
}

/**
 * The charts — M11-23, and there is no library (ADR-0007).
 *
 * **Inline SVG, built from the same counts the figures above are built from.** The server sends
 * numbers and never a picture: a chart the server drew would have to be redeployed to change a
 * colour, and it could not be read by a screen reader or a table view.
 *
 * ### Three rules, and the first two are the ones charts usually break
 *
 * **Zero-based, always.** `sparkline()` on the dashboard is zero-based for the reason recorded
 * there: a min-to-max scale turns a wobble between 10 and 11 into a mountain. A district reads
 * these to decide whether a week was bad.
 *
 * **Every bar is labelled, and the value is on the bar's own tooltip.** Nothing here is carried
 * by colour alone (INV-04), so it survives a photocopy, a colour-blind reader and print.
 *
 * **Nothing is stacked.** A stack has a total, and one of these charts must never have one —
 * see `answerRoutes`. Rather than allow stacking for the two where it would be harmless and
 * forbid it for the third, there is simply no stacked form in this file to reach for.
 */
const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * A column chart. `title` names it; `unit` is what one bar counts, in words.
 *
 * Sized in a `viewBox` and stretched by CSS, so it cannot grow its tile and push the page — the
 * failure the dashboard's sparkline note records paying for.
 */
function columns(
  title: string,
  data: readonly { label: string; value: number; tone?: string }[],
  unit: string,
): HTMLElement {
  const box = document.createElement('figure');
  box.className = 'rchart';

  const caption = document.createElement('figcaption');
  caption.textContent = title;
  box.append(caption);

  if (data.length === 0 || data.every((d) => d.value === 0)) {
    const empty = document.createElement('p');
    empty.className = 'rempty';
    // ADR-0005 again: an empty chart must say it is empty, not just draw nothing.
    empty.textContent = `Nothing to draw — no ${unit} in this period.`;
    box.append(empty);
    return box;
  }

  const W = 100;
  const H = 34;
  // ⚠️ ZERO-BASED. The top of the axis is the largest value, never the range between the
  // largest and the smallest — see the header.
  const top = Math.max(...data.map((d) => d.value));
  const slot = W / data.length;
  /**
   * ⚠️ **Capped, and the cap is not cosmetic.** `preserveAspectRatio: none` stretches the
   * horizontal units to the tile's full width, so a chart with three bars drew three enormous
   * blocks — found by rendering it: *"how they were answered"* came out as two colour swatches
   * rather than as a comparison. A bar chart whose bars are wider than they are tall stops being
   * read as a measurement.
   *
   * The slots stay evenly spaced whatever the cap does, so the axis labels below still line up
   * with the bars they name.
   */
  const barW = Math.min(Math.max(slot * 0.55, 0.8), 7);

  const chart = svg('svg', {
    viewBox: `0 0 ${String(W)} ${String(H)}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `${title}. ${data.map((d) => `${d.label}: ${String(d.value)}`).join(', ')}`,
  });

  data.forEach((d, i) => {
    const h = top === 0 ? 0 : (d.value / top) * H;
    const bar = svg('rect', {
      x: i * slot + (slot - barW) / 2,
      y: H - h,
      width: barW,
      height: h,
      rx: 0.6,
    });
    bar.setAttribute('class', `rbar${d.tone === undefined ? '' : ` ${d.tone}`}`);
    // The value in words, on the bar itself — a tooltip a mouse finds and a reader announces.
    const tip = document.createElementNS(SVG, 'title');
    tip.textContent = `${d.label}: ${String(d.value)} ${unit}`;
    bar.append(tip);
    chart.append(bar);
  });

  box.append(chart);

  /**
   * The axis, in words. Drawn as HTML beneath the SVG rather than as `<text>` inside it, because
   * `preserveAspectRatio: none` stretches the drawing — and it would stretch the lettering with
   * it, which is how a chart ends up with type nobody can read at one width and not the other.
   *
   * Only the ends are labelled when there are many bars: twenty-nine dates across a laptop is a
   * grey smear, and the tooltip carries every one of them.
   */
  const axis = document.createElement('div');
  axis.className = 'raxis';
  const many = data.length > 8;
  data.forEach((d, i) => {
    const t = document.createElement('span');
    t.textContent = !many || i === 0 || i === data.length - 1 ? d.label : '';
    axis.append(t);
  });
  box.append(axis);
  return box;
}

export interface ReportsScreen {
  show(): void;
}

/**
 * The screen's own markup, built here rather than written into `index.html` — M11-20.
 *
 * ⚠️ **This is a shell-budget decision and it was measured, not guessed.** The same markup in
 * `index.html` cost **2,231 bytes of the shell**, which is what a field officer downloads at a
 * scene and which had 4,803 bytes of headroom when this was written. A field officer never opens
 * Reports. Building it here means every later view — charts, the drill-down, the daily report —
 * costs the shell **nothing**, which is what makes the rest of Phase B possible without the M1
 * gate refusing the build.
 *
 * `help.ts` already does exactly this with `#helpBody`; this is that pattern, not a new one.
 */
function buildMarkup(host: HTMLElement): void {
  /**
   * 🔴 **`reportRangeFrom`/`reportRangeTo`, and the plain names were a live defect of mine.**
   *
   * The board's own Reports block has carried `id="reportFrom"` and `id="reportTo"` since M7, and
   * it sits **earlier in the document** than this screen. `getElementById` returns the first
   * match — so for as long as those names were shared, this screen wrote the chosen period into
   * **the board's hidden date boxes** and read the operator's typing back out of them, while its
   * own two inputs sat empty.
   *
   * ⚠️ **It was on screen in every screenshot** — the From/To boxes reading `mm/dd/yyyy` under a
   * heading that named the period correctly — and I looked past it four times.
   *
   * ⚠️ **And the test agreed with it.** `page.inputValue('#reportFrom')` resolves the same first
   * match, so the assertion and the bug were reading one element and passed together. That is the
   * *"a test that asserts what the code does"* shape this repository already carries three
   * entries about, and this one is mine.
   */
  host.innerHTML = `
    <div id="reportRange">
      <div id="reportPresets">
        <button type="button" data-preset="today" aria-pressed="false">Today</button>
        <button type="button" data-preset="yesterday" aria-pressed="false">Yesterday</button>
        <button type="button" data-preset="week" aria-pressed="false">This week</button>
        <button type="button" data-preset="month" aria-pressed="false">This month</button>
        <button type="button" data-preset="lastmonth" aria-pressed="false">Last month</button>
      </div>
      <!--
        ⚠️ THIS SCREEN NO LONGER OWNS A DATE RANGE — Phase 5.

        It had its own From/To here, which made THREE range controls for one question across the
        product: the find controls, the download links and these. Nothing kept them in step, so
        "the week of the flood" meant whatever box was touched last. The Record now has one pair
        (#reportFrom / #reportTo) and this screen reads it.

        The PRESETS stay, because they are the useful half — and they write into the shared pair
        rather than into anything of their own, so the range on screen is always the range being
        shown.
      -->
      <button type="button" id="reportApply">Show</button>
    </div>
    <div id="reportHead">
      <span id="reportPeriod">Loading&hellip;</span>
      <span id="reportAsOf"></span>
    </div>
    <p id="reportNote" hidden></p>
    <div id="reportTabs" role="tablist">
      <button type="button" role="tab" data-pane="overview" aria-selected="true">Overview</button>
      <button type="button" role="tab" data-pane="departments" aria-selected="false">Officers</button>
      <button type="button" role="tab" data-pane="incidents" aria-selected="false">The incidents themselves</button>
      <button type="button" role="tab" data-pane="daily" aria-selected="false">One day, to read and print</button>
    </div>
    <div id="reportOverview" data-pane="overview">
      <div id="reportKpis"></div>
      <div id="reportCharts"></div>
    </div>
    <div id="reportDepartments" data-pane="departments" hidden>
      <div id="reportDepts"></div>
    </div>
    <div id="reportIncidents" data-pane="incidents" hidden>
      <p id="reportRowsNote"></p>
      <p id="reportRowsFilter" hidden></p>
      <div id="reportRows"></div>
    </div>
    <div id="reportDaily" data-pane="daily" hidden></div>
    <p id="reportExport">
      <a id="reportExportIncidents" href="/export/incidents.csv?days=30" download>
        Incidents, as a spreadsheet
      </a>
      <a id="reportExportPerformance" href="/export/performance.csv" download>
        Response times per officer, as a spreadsheet
      </a>
      <span>Carries no reporter's name, number or location.</span>
    </p>`;
}

export function mountReports(options: { onOpen: (incidentId: string) => void }): ReportsScreen {
  const host = document.getElementById('reportsView');
  if (host === null) throw new Error('missing element: reportsView');
  buildMarkup(host);

  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`missing element: ${id}`);
    return node as T;
  };

  const presets = el('reportPresets');
  /**
   * **The Record's one date range**, shared with the find controls (Phase 5). Read by id, so
   * this screen and they cannot describe different periods. The per-period file downloads that
   * used to share this pair too moved onto Administration → History on 2026-09-05, with their
   * own From/To.
   */
  const fromInput = el<HTMLInputElement>('reportFrom');
  const toInput = el<HTMLInputElement>('reportTo');
  const applyBtn = el<HTMLButtonElement>('reportApply');
  const period = el('reportPeriod');
  const asOf = el('reportAsOf');
  const note = el('reportNote');
  const kpis = el('reportKpis');
  const charts = el('reportCharts');
  const depts = el('reportDepts');
  const tabs = el('reportTabs');
  const daily = el('reportDaily');
  const rows = el('reportRows');
  const rowsNote = el('reportRowsNote');
  const rowsFilterNote = el('reportRowsFilter');

  /** The district's own today, as the server reports it. Never `new Date()` — see the header. */
  let districtToday: string | null = null;
  let loading = false;

  async function fetchSummary(from: string | null, to: string | null): Promise<Summary | null> {
    const query = new URLSearchParams();
    if (from !== null) query.set('from', from);
    if (to !== null) query.set('to', to);
    const qs = query.toString();
    // The first open asks for the server's default window (`from`/`to` both null → no query),
    // and that one GET is warmed at idle after sign-in (see `prefetchScreenData` in `main.ts`).
    // Served once so the screen paints filled; the comparison fetch and every later period go
    // to the server. A `?from=…` request never matches and always fetches live.
    if (qs === '') {
      const warm = (
        window as unknown as { __dncPrefetchGet?: (p: string) => unknown }
      ).__dncPrefetchGet?.('/summary');
      if (warm !== undefined) return warm as Summary;
    }
    const res = await fetch(qs === '' ? '/summary' : `/summary?${qs}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Summary;
  }

  /**
   * A figure the server counted over the rows it can also hand back — M11-22.
   *
   * ⚠️ **The number shown is the COUNT'S, not `performance`'s.** That is the whole of what
   * M11-22 was waiting for. Drawing `performance.overdue` and then narrowing the drill-down by
   * `data-overdue` would put two folds either side of one click, which is the defect this
   * milestone exists to remove — and it is why this task sat at `PART` until `/summary` began
   * folding these from `projectIncidents`, the same projection `/search` renders.
   */
  interface SummaryCount {
    key: string;
    label: string;
    count: number;
    /** `null` for the figure that IS the whole list — clicking it clears rather than narrows. */
    attr: string | null;
    value: string;
    match: 'is' | 'has';
  }

  /** What the drill-down is currently narrowed to, if anything — M11-22. */
  let rowFilter: { attr: string | null; value: string; match: 'is' | 'has'; label: string } | null =
    null;

  /**
   * Narrow the rows already on screen, exactly the way the board's facets do.
   *
   * Applied to what the drill-down fetched rather than asking a third question: the rows are
   * here, the server decided every attribute being read, and a second request would be a second
   * selection to keep in step with the first.
   */
  function applyRowFilter(): void {
    const all = Array.from(rows.querySelectorAll<HTMLElement>('.row'));
    let shown = 0;

    for (const row of all) {
      const match =
        rowFilter === null || rowFilter.attr === null
          ? true
          : rowFilter.match === 'has'
            ? (row.dataset[rowFilter.attr] ?? '').split('').includes(rowFilter.value)
            : (row.dataset[rowFilter.attr] ?? '') === rowFilter.value;
      row.hidden = !match;
      if (match) shown += 1;
    }

    for (const box of Array.from(kpis.querySelectorAll<HTMLElement>('.rk'))) {
      const on =
        rowFilter !== null && rowFilter.attr !== null && box.dataset['count'] === rowFilter.attr;
      box.dataset['on'] = String(on);
      if (box.tagName === 'BUTTON') box.setAttribute('aria-pressed', String(on));
    }

    if (rowFilter === null || rowFilter.attr === null) {
      rowsFilterNote.hidden = true;
      return;
    }

    /**
     * ⚠️ **It says N of the LOADED rows, never the KPI's own number.**
     *
     * A summary folds up to 5,000 incidents and one page of drill-down is 200. For any ordinary
     * period those are the same set and the two numbers agree; beyond it the figure is still
     * right and this list is one page of it. Printing the KPI's number over this list would be
     * the screen asserting an agreement that stops holding at exactly the moment somebody is
     * looking at a very busy month.
     */
    rowsFilterNote.hidden = false;
    rowsFilterNote.textContent = `Showing only: ${rowFilter.label} — ${String(shown)} of ${String(all.length)} loaded`;
  }

  function kpi(
    label: string,
    value: string,
    change: { text: string; tone: string } | null,
    kind: string,
    /**
     * Present when the **server** counted this figure over rows it can also hand back — M11-22.
     *
     * Its presence is what makes the figure a button, and it carries the `data-` attribute to
     * narrow by. A figure without one is not a set: the median is not clickable for the same
     * reason the board's strip refuses to make *worst assessed* clickable — there is no such
     * thing as "the rows that are 8 minutes".
     */
    count?: SummaryCount,
  ): HTMLElement {
    const clickable = count !== undefined && count.count > 0 && count.attr !== null;
    const box = document.createElement(clickable ? 'button' : 'div');
    box.className = 'rk';
    box.dataset['kind'] = kind;

    if (count !== undefined && count.attr !== null) box.dataset['count'] = count.attr;

    if (clickable) {
      const button = box as HTMLButtonElement;
      button.type = 'button';
      // Says where it goes before it is clicked, like the board's strip and the dashboard's
      // counters — districtKeys.e2e.test.ts requires exactly this of those.
      button.setAttribute('aria-label', `Show ${count.label}`);
      button.addEventListener('click', () => {
        const on = rowFilter !== null && rowFilter.attr === count.attr;
        // The same gesture back out — clicking the applied figure clears it.
        rowFilter = on
          ? null
          : { attr: count.attr, value: count.value, match: count.match, label: count.label };
        applyRowFilter();
      });
    }

    const v = document.createElement('b');
    v.textContent = value;

    const l = document.createElement('span');
    l.className = 'rkl';
    l.textContent = label;

    box.append(v, l);

    if (change !== null) {
      const c = document.createElement('span');
      c.className = 'rkc';
      c.dataset['tone'] = change.tone;
      // The words carry it; the tone only repeats them (INV-04).
      c.textContent = change.text;
      box.append(c);
    }
    return box;
  }

  function renderDepartments(summary: Summary): void {
    const district = summary.performance.district;
    const rows = summary.performance.officers
      // `total > 0` still holds and still matters: nothing is pre-seeded any more, so this is
      // now belt and braces rather than the whole filter. `retired` is gone with the registry.
      .filter((d) => d.total > 0)
      .slice()
      .sort((a, b) => b.total - a.total);

    depts.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'rempty';
      /**
       * **ADR-0005: silence is a signal, and an empty table must say WHICH silence it is.**
       *
       * ⚠️ Found by rendering the screen and reading it. The first version said only *"No
       * department held an emergency in this period"* — and printed that directly beneath
       * **"REPORTED 15"**. Both sentences were true and together they read as a contradiction,
       * which is worse than either: an operator concludes the screen is broken and stops
       * believing the figures above it too.
       *
       * The two cases are genuinely different and only one of them is quiet news. A period with
       * nothing in it is a quiet month. A period with fifteen emergencies and no department
       * responsible for any of them is **the district's own worst number**, and the table going
       * blank is exactly where it would hide.
       */
      empty.textContent =
        district.total === 0
          ? 'Nothing was reported in this period.'
          : `${String(district.total)} reported, and nobody was told about any of them. ` +
            'Choosing who should know is what puts an emergency with somebody.';
      depts.append(empty);
      return;
    }

    const head = document.createElement('div');
    head.className = 'rrow rhead';
    for (const label of [
      'Officer',
      'Reported',
      'Still open',
      'Past deadline',
      'Median answer',
    ]) {
      const cell = document.createElement('span');
      cell.textContent = label;
      head.append(cell);
    }
    depts.append(head);

    for (const d of rows) {
      const row = document.createElement('div');
      row.className = 'rrow';
      // ADR-0029: the row's own handle is the recipient key (`person:…`, `post:…`, or a
      // historical `department:…`) rather than a department id. `data-department` keeps its
      // attribute NAME because a stylesheet and the drill-down both address it, and renaming an
      // attribute alongside a data change is two migrations reviewed as one.
      row.dataset['department'] = d.key;

      /**
       * ⚠️ **Each cell carries its own label, and that is not decoration.**
       *
       * Below 52rem the header row is not drawn — five numeric columns at 420px is five columns
       * nobody can read. Found by photographing the phone: the row then rendered as bare figures
       * — `7  7  0  0 min` — with **nothing on screen saying which number was which**. A column
       * of unlabelled numbers about a district's emergencies is worse than no table.
       *
       * The label is written into `data-label` and drawn by CSS only at the narrow width, so the
       * table keeps its header where there is room for one and the card keeps its labels where
       * there is not. Same words either way; one place they are authored.
       */
      const cells: readonly [string, string][] = [
        ['', d.name],
        ['Reported', String(d.total)],
        ['Still open', String(d.open)],
        ['Past deadline', String(d.overdue)],
        ['Median answer', minutes(d.medianAckMinutes)],
      ];
      cells.forEach(([label, text], i) => {
        const cell = document.createElement('span');
        cell.textContent = text;
        if (label !== '') cell.dataset['label'] = label;
        if (i === 3 && d.overdue > 0) cell.className = 'rbad';
        row.append(cell);
      });
      depts.append(row);
    }
  }

  /** What the district calls each answer route, in words an operator would use. */
  const ROUTE_WORDS: Record<string, string> = {
    link: 'tapped the button',
    reply: 'replied to the message',
    operator: 'told the control room',
    unrecorded: 'route not recorded',
  };

  const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown'];

  function renderCharts(summary: Summary): void {
    const over = summary.overTime.map((d) => ({
      // The day of the month alone: the heading above already says which month, and a chart
      // that repeats it twenty-nine times is a chart nobody can read.
      label: d.date.slice(8),
      value: d.reported,
    }));

    const mix = SEVERITY_ORDER.map((severity) => ({
      // `unassessed` is a value and never a level (ADR-0009), so it keeps its own bar and its
      // own word rather than being folded into one of the four.
      label: severity === 'unknown' ? 'unassessed' : severity,
      value: summary.severityMix.find((m) => m.severity === severity)?.count ?? 0,
      // Spread rather than `tone: undefined` — `exactOptionalPropertyTypes` is on, and an
      // explicit undefined is not the same thing as an absent property.
      ...(severity === 'critical'
        ? { tone: 'bad' }
        : severity === 'unknown'
          ? { tone: 'unset' }
          : {}),
    })).filter((m) => m.value > 0);

    /**
     * 🔴 **The three routes, side by side, and NEVER added up — M11-24, M7-30.**
     *
     * A tap, a reply and an operator's telephone note are evidence of different strength about
     * different acts, so there is no honest total. They are drawn as separate columns for
     * exactly that reason: a **stacked** bar would have a height, and that height would be the
     * forbidden number, drawn rather than written — which is how this rule gets broken without
     * anybody deciding to break it.
     *
     * Nothing in this file sums them, and `columns()` has no stacked form to reach for.
     */
    const routes = summary.answerRoutes
      .slice()
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ label: ROUTE_WORDS[r.route] ?? r.route, value: r.count }));

    charts.replaceChildren(
      columns('Reported, by day', over, 'reported'),
      columns('How bad they were', mix, 'emergencies'),
      columns('How they were answered — never a single total', routes, 'answered'),
    );
  }

  function render(summary: Summary, before: Summary | null): void {
    const now = summary.performance.district;
    const was = before?.performance.district ?? null;

    /**
     * **INV-02, and M11-30: which days, and how old.** Both, always, in words.
     *
     * `fromDate`/`toDate` come from the server and are never sliced out of the instants beside
     * them — that slice is the bug this project has paid for four times, most recently in this
     * very endpoint.
     */
    period.textContent =
      summary.period.fromDate === summary.period.toDate
        ? `${summary.period.fromDate}`
        : `${summary.period.fromDate} to ${summary.period.toDate}`;
    asOf.textContent = `Folded from the record at ${new Date(summary.performance.asOf).toLocaleTimeString()}`;

    /**
     * ⚠️ **Truncation is said out loud.** A total nobody can tell is short is a number somebody
     * writes into a report and defends in a meeting — the server carries the flag for exactly
     * this, and a screen that dropped it would waste it.
     */
    note.hidden = !summary.truncated;
    if (summary.truncated) {
      note.textContent =
        'More emergencies happened in this period than one summary can fold, so these figures ' +
        'are short. Narrow the period and they will be complete.';
    }

    /**
     * The KPI row — M11-22, and every set-valued figure here now opens its own rows.
     *
     * ⚠️ **Each clickable figure prints the SERVER'S count, not `performance`'s.** Those two are
     * different folds; drawing one and narrowing by the other would put two definitions either
     * side of a single click. `counts` comes from `projectIncidents`, which is the projection
     * `/search` renders into this very list — so the number and the rows are one definition, and
     * that is what the task was waiting for.
     *
     * ⚠️ **INV-04 holds across the row: `worst` and `unassessed` are never one figure.** They are
     * different facts and a KPI row is where the space is tightest, which is exactly where the
     * temptation to fold them together is strongest.
     *
     * The median is not a set and so is not clickable — the same rule the board's strip applies
     * to *worst assessed*: there is no such thing as "the rows that are 8 minutes".
     */
    const counted = new Map<string, SummaryCount>();
    for (const c of summary.counts ?? []) counted.set(c.key, c);
    const earlier = new Map<string, SummaryCount>();
    for (const c of before?.counts ?? []) earlier.set(c.key, c);

    /** A figure the server counted, drawn from its own number and leading to its own rows. */
    function counter(key: string, fallbackLabel: string): HTMLElement {
      const c = counted.get(key);
      if (c === undefined) return kpi(fallbackLabel, '—', null, key);

      const prev = earlier.get(key)?.count ?? null;
      const box = kpi(c.label, String(c.count), delta(c.count, prev), key, c);
      return box;
    }

    kpis.replaceChildren(
      counter('reported', 'reported'),
      kpi('still open', String(now.open), delta(now.open, was?.open ?? null), 'open'),
      counter('unacknowledged', 'nobody answered'),
      counter('overdue', 'past deadline'),
      counter('unassigned', 'no department'),
      counter('nobodyTold', 'no one chosen'),
      /**
       * ⚠️ **The median, and never a count of "acknowledged" — M11-24.**
       *
       * An emergency is answered by a tap, a reply, or the control room recording a telephone
       * call, and those are evidence of different strength; a provider's `delivered` is evidence
       * of nothing a human did. **They are never added together** (M7-30), so there is no single
       * "acknowledged: 43" to put here — not as a figure, not as a chart total, not in a
       * tooltip. What can honestly be said is *how long it took*, which is one measurement of
       * one thing.
       */
      kpi('median time to answer', minutes(now.medianAckMinutes), null, 'ack'),
      counter('unmet', 'message failed'),
      counter('unassessed', 'nobody assessed'),
    );

    // A new period invalidates whatever narrowing was in force — it described other rows.
    rowFilter = null;
    applyRowFilter();

    renderCharts(summary);
    renderDepartments(summary);
  }

  async function load(from: string | null, to: string | null): Promise<void> {
    if (loading) return;
    loading = true;
    note.hidden = true;
    period.textContent = 'Loading…';

    try {
      const summary = await fetchSummary(from, to);
      if (summary === null) {
        period.textContent = 'Could not read the record.';
        asOf.textContent = '';
        kpis.replaceChildren();
        depts.replaceChildren();
        return;
      }

      districtToday ??= summary.period.toDate;
      /**
       * The **instants** the server resolved, kept so the drill-down asks for exactly the window
       * the figures above it were folded over — see `loadIncidents`.
       */
      lastPeriod = summary.period;
      // A new period invalidates whatever the drill-down is holding.
      rowsFor = null;
      fromInput.value = summary.period.fromDate;
      toInput.value = summary.period.toDate;

      /**
       * The same length of period, immediately before this one — M11-21.
       *
       * Fetched as a **second request against the same route**, so the comparison is folded by
       * exactly the code that folded the figures it is compared against. Working it out from a
       * wider window would be a second definition of the period, which is the fault this whole
       * milestone keeps finding.
       *
       * A failure here is silent by design: the comparison is a courtesy and the figures are
       * the point, so a screen that could not fetch it simply does not draw one.
       */
      const span = spanDays(summary.period.fromDate, summary.period.toDate);
      const prevTo = shiftDate(summary.period.fromDate, -1);
      const prevFrom = shiftDate(prevTo, -(span - 1));
      const before = await fetchSummary(prevFrom, prevTo);

      render(summary, before);
    } finally {
      loading = false;
    }
  }

  /** The presets, built from the district's own today rather than from the browser's. */
  function rangeFor(preset: string): { from: string; to: string } | null {
    const today = districtToday;
    if (today === null) return null;

    switch (preset) {
      case 'today':
        return { from: today, to: today };
      case 'yesterday': {
        const y = shiftDate(today, -1);
        return { from: y, to: y };
      }
      // The week the district is in, Monday-first, ending today rather than on a future Sunday:
      // a period that runs past now would report days that have not happened.
      case 'week': {
        const dow = weekday(today);
        const backToMonday = dow === 0 ? 6 : dow - 1;
        return { from: shiftDate(today, -backToMonday), to: today };
      }
      case 'month':
        return { from: firstOfMonth(today), to: today };
      case 'lastmonth': {
        const endOfLast = shiftDate(firstOfMonth(today), -1);
        return { from: firstOfMonth(endOfLast), to: endOfLast };
      }
      default:
        return null;
    }
  }

  presets.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      'button[data-preset]',
    );
    const preset = button?.dataset['preset'];
    if (preset === undefined) return;

    const range = rangeFor(preset);
    if (range === null) return;

    for (const b of Array.from(presets.querySelectorAll<HTMLElement>('button[data-preset]'))) {
      const on = b === button;
      b.dataset['on'] = String(on);
      b.setAttribute('aria-pressed', String(on));
    }
    void load(range.from, range.to);
  });

  applyBtn.addEventListener('click', () => {
    for (const b of Array.from(presets.querySelectorAll<HTMLElement>('button[data-preset]'))) {
      b.dataset['on'] = 'false';
      b.setAttribute('aria-pressed', 'false');
    }
    void load(fromInput.value || null, toInput.value || null);
  });

  /**
   * **The tabs — M11-26, and the order is control-room-first.**
   *
   * They open it daily; the DC reads a month at a time. So *Overview* leads, and the day somebody
   * prints at 08:00 sits beside it. Reversing this is reordering three buttons, not rebuilding —
   * which is exactly why the plan recorded it as a decision rather than leaving it to block work.
   *
   * ⚠️ **A tab is presentation and never authority (INV-05).** Every pane draws what the seat's
   * own request already returned; nothing here widens what the server sent, and there is no
   * "show everything" pane that asks a different question.
   */
  function showPane(next: string): void {
    for (const node of Array.from(
      document.querySelectorAll<HTMLElement>('#reportsView [data-pane]:not([role="tab"])'),
    )) {
      node.hidden = node.dataset['pane'] !== next;
    }
    for (const tab of Array.from(tabs.querySelectorAll<HTMLElement>('button[data-pane]'))) {
      const on = tab.dataset['pane'] === next;
      tab.setAttribute('aria-selected', String(on));
      tab.dataset['on'] = String(on);
    }
    if (next === 'daily') void loadDaily();
    if (next === 'incidents') void loadIncidents();
  }

  tabs.addEventListener('click', (event) => {
    const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('button[data-pane]');
    const next = tab?.dataset['pane'];
    if (next !== undefined) showPane(next);
  });

  /**
   * **The daily report, rendered inside the app — M11-27.**
   *
   * Until now this was a **standalone server-rendered page in a new tab**, for one day. The
   * district asked to read its reports here, and this is the last of the five links to come in.
   *
   * ⚠️ **The server route stays and is still the thing that prints.** `Print → Save as PDF` on
   * the server's own HTML is how this district produces a PDF at all — ADR-0007 refuses a PDF
   * library precisely so the printed page **is** the page that was read. So this pane draws the
   * report and then offers that page beside it, rather than replacing it.
   *
   * The figures are the server's `?format=json`, which is the same object the printed page and
   * the spreadsheet are built from — including `summary`, which `domain/dailyReport.ts` writes
   * itself so three renderers cannot summarise one day three ways.
   */
  interface Daily {
    date: string;
    scope: string;
    summary: string;
    empty: boolean;
    totals: Record<string, number>;
    emergencies: { headline?: string; category?: string; severity?: string; status?: string }[];
    communications: unknown[];
    outstanding?: unknown[];
  }

  let dailyFor: string | null = null;

  async function loadDaily(): Promise<void> {
    // The day shown is the END of the chosen period — "one day, to read and print" is a day, and
    // the last day of what the operator asked for is the one they are most likely to want.
    const day = toInput.value || null;
    if (day !== null && day === dailyFor) return;

    daily.replaceChildren();
    const heading = document.createElement('p');
    heading.className = 'rdayhead';
    heading.textContent = 'Loading…';
    daily.append(heading);

    const res = await fetch(`/reports/daily?format=json${day === null ? '' : `&date=${day}`}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      heading.textContent = 'Could not read that day.';
      return;
    }
    const report = (await res.json()) as Daily;
    dailyFor = report.date;

    daily.replaceChildren();

    const head = document.createElement('p');
    head.className = 'rdayhead';
    head.textContent = `${report.date} · ${report.scope}`;
    daily.append(head);

    /**
     * The lede, exactly as the printed page carries it. Written by the domain rather than by
     * whichever renderer got there first — three surfaces, one sentence.
     */
    const lede = document.createElement('p');
    lede.className = 'rdaysummary';
    lede.textContent = report.summary;
    daily.append(lede);

    /**
     * ⚠️ **A gap is stated, never omitted** — the rule the report itself is built on. A day's
     * account that lists only what went well makes a bad night look like a quiet one, and this is
     * the artefact most likely to be read by somebody who was not there.
     */
    const figures = document.createElement('div');
    figures.className = 'rdayfigs';
    const rows: readonly [string, number, boolean][] = [
      ['Emergencies', report.totals['emergencies'] ?? 0, false],
      ['Communications', report.totals['communications'] ?? 0, false],
      ['Nobody acknowledged', report.totals['unacknowledged'] ?? 0, true],
      ['Still unresolved', report.totals['unresolved'] ?? 0, true],
      ['Nobody was told', report.totals['nobodyTold'] ?? 0, true],
      ['Nobody was reached', report.totals['unmet'] ?? 0, true],
    ];
    for (const [label, value, gap] of rows) {
      const cell = document.createElement('span');
      cell.className = gap && value > 0 ? 'rdayfig bad' : 'rdayfig';
      const b = document.createElement('b');
      b.textContent = String(value);
      const l = document.createElement('span');
      l.textContent = label;
      cell.append(b, l);
      figures.append(cell);
    }
    daily.append(figures);

    if (report.empty) {
      const none = document.createElement('p');
      none.className = 'rempty';
      // An empty day says so. A blank page is a fault somebody chases, and the chase ends with
      // the district trusting the report less (M9-51).
      none.textContent = 'Nothing was reported or sent on this day.';
      daily.append(none);
    }

    /**
     * The printed page, offered beside what was just read rather than instead of it — M11-29.
     * This is the only route that produces a PDF in this product, so it is not a fallback.
     */
    const out = document.createElement('p');
    out.className = 'rdayout';
    const print = document.createElement('a');
    print.href = `/reports/daily?date=${report.date}`;
    print.target = '_blank';
    print.rel = 'noopener';
    print.textContent = 'Open the printable page';
    const sheet = document.createElement('a');
    sheet.href = `/reports/daily?date=${report.date}&format=csv`;
    sheet.setAttribute('download', '');
    sheet.textContent = 'This day, as a spreadsheet';
    out.append(print, sheet);
    daily.append(out);
  }

  /**
   * **The incidents themselves — M11-25.**
   *
   * The last of the owner's second observation: not only the district's figures inside the app,
   * but **the record itself**, readable here rather than only in a spreadsheet.
   *
   * ### Three things this does not do, each for a reason already paid for
   *
   * **It does not re-render anything.** Rows come from `incidentRow.ts` — the single renderer the
   * board and search already share. A second copy drifts within a month, and then one emergency
   * reads as `unassessed` on one screen and `unknown` on another.
   *
   * **It does not ask a second question.** `GET /search` runs the same `projectIncidents` fold
   * behind the same `evaluateRead`, so a department sees its own work here and nothing of a
   * neighbour's (INV-05). There is no new endpoint to fall out of step with the board.
   *
   * ⚠️ **It asks with the INSTANTS the summary resolved, never with the two dates.** `/search`
   * takes instants — and `Date.parse('2026-07-01')` is a perfectly good instant, **UTC midnight**.
   * Passing the dates would have given this list a window five hours out from the figures above
   * it: the very defect M11-28 had just found in `/summary`, recreated one screen later. The
   * summary already resolved the district-day boundaries; this reuses them.
   */
  let lastPeriod: Summary['period'] | null = null;
  let rowsFor: string | null = null;

  async function loadIncidents(): Promise<void> {
    const period = lastPeriod;
    if (period === null) return;
    if (rowsFor === period.from) return;

    rowsNote.textContent = 'Loading…';
    rows.replaceChildren();

    const query = new URLSearchParams({ from: period.from, to: period.to, limit: '200' });
    const res = await fetch(`/search?${query.toString()}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      rowsNote.textContent = 'Could not read the record.';
      return;
    }

    const data = (await res.json()) as {
      asOf: string;
      total: number;
      truncated: boolean;
      incidents: readonly IncidentRowData[];
    };
    rowsFor = period.from;

    const at = Date.parse(data.asOf);
    rows.replaceChildren(...data.incidents.map((row) => incidentRow(row, at)));

    /**
     * ⚠️ **This list says its OWN number, and it is deliberately not presented as a KPI's rows.**
     *
     * The figures above come from `performanceOver`; these rows come from `projectIncidents`.
     * They are two folds over the same events, and this whole milestone has been about a figure
     * landing on exactly what it counted. Wiring a KPI straight to this list would claim an
     * agreement **nothing here guarantees** — which is the defect I have spent the milestone
     * removing, reintroduced on the last screen. M11-22's clickable figures wait for the server
     * to answer both questions from one fold.
     */
    rowsNote.textContent =
      data.incidents.length === 0
        ? `Nothing was reported between ${period.fromDate} and ${period.toDate}.`
        : `${String(data.incidents.length)} incidents between ${period.fromDate} and ` +
          `${period.toDate}${data.truncated ? ' — more matched than one page can fold, so narrow the period' : ''}. ` +
          'Open one to read it.';
  }

  /**
   * A row opens the incident, on the screen the app already has for it — one definition, two
   * doors. Delegated, because the list is replaced whenever the period changes.
   */
  rows.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.row');
    const id = row?.dataset['incident'];
    if (id !== undefined) options.onOpen(id);
  });

  return {
    show(): void {
      // The first open asks for the server's default window, which is also how this screen
      // learns what "today" is in Bajaur without ever reading the handset's clock.
      if (districtToday === null) void load(null, null);
    },
  };
}
