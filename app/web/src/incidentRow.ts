/**
 * One incident, as a row — used by the board and by search.
 *
 * Moved out of `main.ts` when search arrived, for the same reason `projectIncidents` was
 * split out of `buildBoard` on the server: **the two surfaces already share one projection,
 * and it would be undone by two renderers.** A second copy of this drifts within a month, and
 * then the same emergency reads as `unassessed` on one screen and `unknown` on the other, or
 * shows its unmet notification on the board and not in the search result somebody found it in.
 *
 * Everything load-bearing about how an incident is *displayed* lives here and nowhere else:
 * the severity word carrying the meaning rather than the colour (INV-04), "nobody told yet"
 * said out loud rather than left blank, and an unmet notification spelled out on the row it
 * belongs to rather than counted in a corner (INV-03).
 */

import { hasCategory, labelFor } from '../../src/domain/communications.js';
import type { MessageKind } from '../../src/domain/events.js';
import { categoryWords, duration } from './words.js';

/**
 * What a General communication is called on a row — M9-11.
 *
 * Deliberately short: this sits where a severity word sits, in the same narrow column, and it
 * is read at a glance beside forty other rows. "Notice" covers `other` because that is what the
 * district calls it out loud.
 */
const KIND_WORDS: Record<string, string> = {
  meeting: 'meeting',
  schedule: 'schedule',
  other: 'notice',
};

/**
 * How many recipients fit in the `who` column before the row starts counting instead of naming.
 *
 * Two, measured against the column the table already gives that cell — not a round number. A
 * third name wraps it onto a second line at desk width, and one row two lines taller than its
 * neighbours is exactly the raggedness M11-10 removed.
 */
const NAMES_INLINE = 2;

export interface IncidentRowData {
  incidentId: string;
  /**
   * **The district's own number** — `DNC-BAJAUR-42`, 2026-08-24.
   *
   * Formatted by the server, never here. One template for the board, the detail screen and the
   * printed report, or the three begin quoting one incident three ways.
   *
   * Optional, and `null` is an ordinary value: an older server sends no field at all, and a
   * current one sends null for an incident the numbering sweep has not reached — which it can
   * be for a moment, because the record is committed before the counter is touched (INV-01).
   * The row draws nothing in both cases rather than a placeholder, because a row is scanned and
   * "no number" is not something anybody acts on.
   */
  reference?: string | null;
  status: string;
  /** The four-stage view of `status`, decided by the server (M9-25). */
  stage: string;
  /**
   * What kind of thing this is, and whether it is a General communication — M9-11.
   * Optional so an older server simply renders what it always did.
   */
  kind?: string;
  general?: boolean;
  /** Something we sent about this was wrong, and has been corrected (M9-52). */
  corrected?: boolean;
  correctionReason?: string | null;
  /**
   * Taken off the board, but not off the record — M10-11/17. Required, not optional: the
   * server sets it on every row, live or withdrawn, so a row that omits it is a bug rather
   * than an older server (unlike `corrected`, which really did predate this field).
   */
  withdrawn: boolean;
  withdrawalReason: string | null;
  severity: string;
  assessed: boolean;
  overriddenFrom: string | null;
  category: string;
  occurredAt: string | null;
  acknowledgedAt: string | null;
  escalationCount: number;
  overdue: boolean;
  overdueByMinutes: number;
  notificationsFailed: number;
  /** Why, in a sentence the server chose. Absent on an older server, or when nothing failed. */
  notificationsWhy?: string;
  notificationsUndelivered: number;
  responsibleDepartments: string[];
  /**
   * Who was actually told, by name — the district asked for this on the row, 2026-08-23.
   *
   * ⚠️ **Optional, and absent is not "nobody".** This bundle can meet a server older than
   * itself, and an absent field means *this server does not send names* — which must keep
   * rendering exactly what the board rendered before, not assert that nobody was told.
   */
  toldNames?: string[];
  /** What the officer said when they resolved it. Null or absent until it actually is. */
  resolution?: string | null;
  /**
   * What the district actually told people — 2026-08-23, Phase B.
   *
   * ⚠️ **Null or absent means UNKNOWN, never “nothing was sent”.** Nothing sent before
   * 2026-08-23 carries one and none can be reconstructed — see `api/board.ts`. The row says
   * *not recorded* in those words rather than drawing a blank somebody would read as silence.
   */
  sentMessage?: { what: string; where: string } | null;
  /**
   * Whether this alert was chased, and whether the chase got through — 2026-08-23.
   * Absent on an older server. See `api/board.ts`.
   */
  followUp?: { note: string; count: number; failed: boolean } | null;
  unassigned: boolean;
  /**
   * Server-decided, so the dashboard's counters land on exactly what they counted.
   *
   * Not recomputed here. Each of these is the same predicate the counter used, on the same
   * fold — `occurredToday` especially, which is measured against the *server's* midnight and
   * would ask a different question if a handset decided it locally.
   */
  held: boolean;
  acknowledged: boolean;
  occurredToday: boolean;
  notificationsUnmet: boolean;
  /**
   * Everybody who answered said they could not — RX-02, 2026-08-25.
   *
   * ⚠️ **Optional, and absent is not `false`.** This row is drawn by a bundle that can meet a
   * server older than itself; an absent field means *this server does not answer that question*,
   * and the honest response is to say nothing rather than to assert that somebody has it.
   */
  ownerless?: boolean;
  declined?: number;
  /**
   * **What came back from the people who were told — the Record's "Response", 2026-08-31.**
   *
   * Mirrors `BoardRow.response` exactly. The `state` sentence beside it says where the
   * *incident* stands; this says what the *officers* said. `latest` is the most recent reply
   * an officer typed, verbatim, with who and when — null until one exists (an acknowledgement
   * tap is a gesture, not a response). `breakdown` is one line per dispatched recipient, for
   * the row's own in-place disclosure.
   *
   * ⚠️ **Null or absent means nobody was dispatched** — an older server, or an emergency with
   * no recipients. The cell then falls back to the stage sentence it always drew, never a
   * "no responses yet" line about a conversation that never started.
   */
  response?: {
    told: number;
    holding: number;
    declined: number;
    silent: number;
    ownerless: boolean;
    latest: { who: string | null; said: string; at: string | null } | null;
    breakdown: {
      who: string | null;
      holding: 'holding' | 'declined' | 'silent';
      said: string | null;
      /**
       * The saved group this recipient came from — Case 3, 2026-09-10. The disclosure heads
       * its lines with it; `null` / absent for anybody ticked by hand and for an older server,
       * and the list then reads flat as before.
       */
      group?: string | null;
    }[];
  } | null;
  /** Nobody has been chosen to be told about this at all — M6-09. */
  nobodyTold: boolean;
  /**
   * **Who is coming, when this row asked who is coming** — the Case 2 (meeting) work, 2026-09-10.
   *
   * Non-null only for a `meeting` or an `asksAttendance` notice. Where it is set the *Response*
   * column reads `N of M coming · … attending · … sending someone · … silent` rather than the
   * generic reply words. Optional and absent-means-no, like `unacknowledged` above.
   */
  attendance?: {
    told: number;
    coming: number;
    answered: number;
    attending: number;
    sendingSomeone: number;
    notAttending: number;
    other: number;
    unanswered: number;
  } | null;
  /**
   * The two the board's own summary is folded from — M11-06.
   *
   * Optional so an older server renders exactly what it always did. **Absent must read as
   * "no", never as "yes"**: the strip's segments narrow *to* these, so a missing value that
   * defaulted true would put every row under a figure that counted none of them.
   */
  unacknowledged?: boolean;
  unassessed?: boolean;
}

/** How long ago, in words. `—` for an incident with no stated time rather than a fake one. */
export function ago(iso: string | null, from: number): string {
  if (iso === null) return '—';
  const mins = Math.floor((from - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ${mins % 60}m ago` : `${Math.floor(hours / 24)}d ago`;
}

export function incidentRow(row: IncidentRowData, at: number): HTMLElement {
  const div = document.createElement('div');
  div.className = 'row';
  div.dataset['overdue'] = String(row.overdue);
  div.dataset['unassigned'] = String(row.unassigned);
  div.dataset['incident'] = row.incidentId;
  // What the dashboard filters on when somebody arrives from one of its panels. Every one of
  // these is a value the server decided; nothing here re-derives a rule the counters used.
  div.dataset['category'] = row.category;
  /**
   * ⚠️ **``, and the separator is the whole point** — fixed 2026-08-18.
   *
   * This read `join('')` while `main.ts` matched with `split('')`. One department
   * round-trips correctly through that mismatch, so every test passed and every screen looked
   * right; **two** produce `"Rescue 1122Police"`, split into a single element, and match
   * neither name. The dashboard's departments panel said *3 open* and the board it opened said
   * *nothing matches* — the exact failure `districtKeys.e2e.test.ts` exists to refuse, reached
   * through the one door that file had not covered.
   *
   * A control character rather than a comma or a space because a department's **name** is the
   * value being carried, and Bajaur's list already contains both — `Rescue 1122` has a space,
   * and a punctuated name would break a comma. `` cannot occur in one.
   */
  div.dataset['departments'] = row.responsibleDepartments.join('');
  /**
   * 🔴 **WHO WAS TOLD, BECAUSE THE PANEL ABOVE COUNTS OFFICERS AND THE FILTER READ DEPARTMENTS.**
   *
   * ADR-0029 re-aimed the dashboard's panel from departments to **Open by officer** and left the
   * door it leads through keyed on `data-departments`. That still worked while departments
   * existed — the filter matched something, even if not what the panel had counted. Migration
   * 0039 empties `responsibleDepartments` on every row for ever, so clicking any officer in that
   * panel would have filtered the board on a value no row carries and answered **"nothing
   * matches"**, every time — which is word for word the failure the owner named and
   * `districtKeys.e2e` exists to refuse, arriving back through the same door.
   *
   * `toldNames` is what the panel folds (`dispatchedTo`), so the number and the rows are one set
   * again. Same `` separator and the same reason: a person's name contains spaces and
   * punctuation, and a control character cannot occur in one.
   */
  // `?? []` for the same reason `feed.officers` has one: this bundle is fetched at runtime
  // and can meet a server older than itself. An absent field means that server does not send
  // one, and an empty attribute is the honest answer — never a throw that takes the row with it.
  div.dataset['told'] = (row.toldNames ?? []).join('');
  div.dataset['held'] = String(row.held);
  div.dataset['acknowledged'] = String(row.acknowledged);
  div.dataset['today'] = String(row.occurredToday);
  div.dataset['unmet'] = String(row.notificationsUnmet);
  div.dataset['nobodytold'] = String(row.nobodyTold);
  div.dataset['ownerless'] = String(row.ownerless === true);
  // What the board's context strip narrows on — M11-06/07. `=== true` rather than a coercion,
  // so an older server's absent field is "no" and never quietly the whole board.
  div.dataset['unacknowledged'] = String(row.unacknowledged === true);
  div.dataset['unassessed'] = String(row.unassessed === true);
  /**
   * **The stage, on the row itself — 2026-08-17.**
   *
   * It was already written onto the `.stage` chip, which is where a human reads it; the board's
   * filter reads `row.dataset`, so a figure counting *Issued* had nothing to land on. Same shape
   * as M11-06: a number and the rows it leads to must be one set, and that only works when the
   * server's own decision is on the element the filter looks at.
   */
  div.dataset['stage'] = row.stage;
  /**
   * **Severity and kind, on the row itself — M11-16.**
   *
   * Both were already written onto the `.sev` chip, which is where a *human* reads them. The
   * filter reads `row.dataset`, so a facet counting `critical` had nothing to land on — the
   * same gap `data-stage` above was added to close, and the same gap M11-06 closed for the
   * strip. The rule this keeps arriving at: a figure and the rows it leads to are one set only
   * when the server's own decision is on the element the filter looks at.
   *
   * `severity` is written unconditionally, `unknown` included, so the attribute is never absent
   * — an absent attribute read as a value is this project's own recorded fault (`boardScope`).
   * A row with no assessment is narrowed by `data-unassessed`, never by a severity band.
   */
  div.dataset['severity'] = row.severity;
  div.dataset['kind'] = row.kind ?? 'other';
  // For the board's own recede rule, and for a test to find a marked row without parsing text.
  div.dataset['withdrawn'] = String(row.withdrawn);

  /**
   * **A meeting is not a mild emergency — M9-11.**
   *
   * This slot showed a severity for everything, so a meeting notice read as
   * *"moderate · unacknowledged"* and was indistinguishable, at a glance on a busy board, from
   * an emergency nobody had answered. The severity had a value only because intake asks for
   * one; it never meant anything for a notice.
   *
   * So a General communication shows **what it is** here instead. One renderer still (this
   * file is the only one, deliberately — see the header); it draws the honest word.
   */
  const sev = document.createElement('span');
  if (row.general === true) {
    sev.className = 'kindchip';
    sev.dataset['kind'] = row.kind ?? 'other';
    sev.textContent = KIND_WORDS[row.kind ?? 'other'] ?? 'notice';
  } else {
    sev.className = 'sev';
    sev.dataset['level'] = row.severity;
    // The word carries the meaning; the colour only repeats it (INV-04). "Unassessed"
    // is spelled out rather than shown as a level nobody chose.
    sev.textContent = row.assessed ? row.severity : 'unassessed';
  }

  const cat = document.createElement('span');
  cat.className = 'cat';
  /**
   * **The number leads the row** — 2026-08-24.
   *
   * In the `What` cell rather than a column of its own, and that is a layout decision with a
   * reason: `#boardTable` lays the header and every row out from one `--board-cols`, and a
   * seventh column would have to earn its width from the six that are already tight at desk
   * size and stacked into a card below 75rem. A dim prefix costs nothing at either width.
   *
   * It reads as a counter down the page, which is what the district asked for it for — the
   * highest number on the Record is how many emergencies Bajaur has recorded.
   */
  if (typeof row.reference === 'string' && row.reference !== '') {
    const ref = document.createElement('span');
    ref.className = 'ref';
    ref.textContent = row.reference;
    cat.append(ref);
  }
  /**
   * **`'other'` reads as "could not be classified" here on every kind but `emergency`, and it
   * is not that — 2026-09-05.** `web/src/main.ts`'s `TILES` (2026-08-24) writes the literal
   * category `'other'` on Alert, Advisory, Order, Meeting, Schedule and Information alike,
   * because none of those tiles ever asks the operator to classify anything — only the seven
   * emergency tiles have a real category to show. A control room read "Other" on the Record row
   * for an incident it had itself tagged Alert and asked why the category it never touched was
   * wrong. `hasCategory` is the same rule `jobs/whatsappChannel.ts` applies to the WhatsApp
   * message itself, so the row and the handset never disagree about the same incident. `kind`
   * being absent (an older server) reads as `hasCategory`'s own default: print the category, the
   * only thing that server ever sent.
   */
  cat.append(
    row.kind !== undefined && !hasCategory(row.kind as MessageKind, row.category)
      ? labelFor(row.kind as MessageKind)
      : categoryWords(row.category),
  );
  if (row.overriddenFrom !== null) {
    const note = document.createElement('span');
    note.className = 'meta';
    note.textContent = ` (overridden from ${row.overriddenFrom})`;
    cat.append(note);
  }

  /**
   * The stage, in the district's own words — M9-25, narrowed to three 2026-09-04.
   *
   * **Beside the state sentence, not instead of it.** *Issued* covers reported, triaged,
   * routed and acknowledged, and the row still has to say the thing an operator acts on:
   * *unacknowledged, 20 minutes past deadline*. The stage is the vocabulary; the sentence is
   * the job.
   *
   * The word comes from the **server** (`row.stage`). Mapping seven statuses to four here as
   * well would be a second implementation of the same table, and the first one to drift would
   * put a different word on the board than on the incident it opens.
   */
  const stage = document.createElement('span');
  stage.className = 'stage';
  stage.dataset['stage'] = row.stage;
  stage.textContent = row.stage;

  /**
   * **"unacknowledged" is a complaint, and a notice has nothing to complain about — M9-11.**
   *
   * Emergencies carry an acknowledgement duty and a deadline; General communications carry
   * neither, by decision (M9-02: escalating a meeting at 02:00 teaches everybody to ignore the
   * escalation that matters). Saying *unacknowledged* about one asks the district to chase
   * something nobody owes them.
   *
   * A notice still says whether anybody answered, because that is worth knowing — it just does
   * not say it as a fault.
   */
  const state = document.createElement('span');
  state.className = 'state';

  /**
   * **The column is "Response" now — 2026-08-31.**
   *
   * It still says where the incident stands when nothing has come back, because *"no reply
   * yet"* is the response then. Once an officer answers **in words** it shows what they said;
   * for a dispatch to more than one it shows the tally and keeps the words for the row's
   * disclosure (`response.breakdown`). RX-02's *reassign* verb is unchanged and still comes
   * first — everybody declining is the one answer an operator has to act on immediately.
   */
  const rsp = row.response ?? null;
  const replyTitle = (l: { who: string | null; said: string }): string =>
    (l.who !== null && l.who !== '' ? `${l.who}: ` : '') + l.said;
  /** The tally, zero terms dropped: `2 responded · 1 waiting · 1 declined`. */
  const tally = (r: NonNullable<IncidentRowData['response']>): string =>
    [
      r.holding > 0 ? `${String(r.holding)} responded` : '',
      r.silent > 0 ? `${String(r.silent)} waiting` : '',
      r.declined > 0 ? `${String(r.declined)} declined` : '',
    ]
      .filter((w) => w !== '')
      .join(' · ');

  const att = row.attendance ?? null;

  if (att !== null) {
    // This notice asked who is coming — the column IS the attendance tally, not a single reply.
    // "attending / sending someone / not attending / silent", never the generic reply words.
    state.textContent =
      att.told === 0
        ? 'nobody asked yet'
        : [
            `${String(att.coming)} of ${String(att.told)} coming`,
            att.attending > 0 ? `${String(att.attending)} attending` : '',
            att.sendingSomeone > 0 ? `${String(att.sendingSomeone)} sending someone` : '',
            att.notAttending > 0 ? `${String(att.notAttending)} not attending` : '',
            att.unanswered > 0 ? `${String(att.unanswered)} silent` : '',
          ]
            .filter((w) => w !== '')
            .join(' · ');
  } else if (row.general === true) {
    // A notice answers whether anybody replied, never as a fault — its own words if there are any.
    if (rsp?.latest != null) {
      state.textContent = rsp.latest.said;
      state.title = replyTitle(rsp.latest);
    } else {
      state.textContent = row.acknowledgedAt !== null ? 'answered' : 'sent · no answer needed';
    }
  } else if (rsp !== null && rsp.ownerless === true) {
    // Everybody answered and every one of them declined — RX-02, 2026-08-25. It says what to do.
    state.textContent =
      rsp.declined > 1
        ? `all ${String(rsp.declined)} declined — reassign`
        : 'nobody has taken it — reassign';
    state.classList.add('unheld');
  } else if (rsp !== null && rsp.latest !== null && rsp.told === 1) {
    // One recipient, answered in words — the words are the whole column.
    state.textContent = rsp.latest.said;
    state.title = replyTitle(rsp.latest);
    state.classList.add('replied');
  } else if (rsp !== null && rsp.told > 1 && (rsp.holding > 0 || rsp.declined > 0)) {
    // Many recipients, at least one has answered — the tally; the words are in the disclosure.
    state.textContent = tally(rsp);
    if (rsp.latest !== null) state.title = replyTitle(rsp.latest);
    state.classList.add('replied');
  } else if (rsp !== null && rsp.told > 0) {
    // Told, nobody has said anything back yet.
    state.textContent = rsp.declined > 0 ? tally(rsp) : 'awaiting a reply';
    if (row.overdue) {
      state.textContent += ` · ${duration(row.overdueByMinutes)} past deadline`;
      state.classList.add('flag');
    }
  } else {
    // Nobody was told — the stage sentence, exactly as the board always drew it.
    state.textContent =
      row.acknowledgedAt !== null
        ? row.status
        : row.overdue
          ? `unacknowledged · ${duration(row.overdueByMinutes)} past deadline`
          : 'unacknowledged';
    if (row.overdue) state.classList.add('flag');
  }

  /**
   * **Two cells, not one line — M11-10.**
   *
   * These were one `.meta` span reading `Rescue 1122 · 2h ago`. The board is a **table** at desk
   * width now, and *who has it* and *how old it is* are two columns an operator scans down
   * separately — so they have to be two grid children. This is the row gaining structure, not a
   * second renderer: `incidentRow.ts` is still the only one, and search gets the same two cells.
   *
   * ⚠️ **The separator between them is CSS and it is load-bearing.** Splitting a run-on span into
   * two adjacent spans with nothing between them is exactly how this board once shipped
   * `Fire — issuednobody told yet` — the fix then was ` · ` from a `::before`, and the same rule
   * applies here: in **card** mode `.age::before` supplies the middot, and in **table** mode it
   * is suppressed because a column boundary already separates them.
   */
  const who = document.createElement('span');
  who.className = 'meta who';
  // Whose incident it is, by name (M0-51). "Not yet routed" is said out loud rather
  // than left blank — an unrouted emergency is a state somebody has to act on.
  // "Nobody told yet", not "not yet routed" — the old words named the mechanism (routing) at a
  // point where the mechanism is a person choosing recipients. What an operator does about this
  // row is open it and choose; nothing about a routing signal is involved.
  /**
   * 🔴 **"Nobody told yet" was FALSE on nineteen of Bajaur's forty incidents — fixed 2026-08-18.**
   *
   * This read the **department** question and answered with a sentence about being **told**: an
   * empty `responsibleDepartments` printed *"nobody told yet"*, which is true of every emergency
   * the control room dispatched to an officer **by name**. Since M10-07/08/09 made the person row
   * the only row the picker draws, that is the ordinary case rather than an edge one — measured
   * on the live record: 40 incidents, 28 told, 9 with a department, **19 rows lying**.
   *
   * ⚠️ **`row.nobodyTold` is the only field that separates the two questions**, and it is the
   * server's own — the same value the wall's `No one chosen` tile and the strip above this board
   * both count, so the row and the figure cannot disagree. Re-deriving it from an empty
   * department list is what produced the defect.
   *
   * The fix on `api/dashboard.ts`'s panels is the same three cases and the same words; the two
   * were changed together deliberately, because a row and a panel describing one emergency in
   * two vocabularies is what this whole pass exists to remove.
   */
  /**
   * **Name them — the district asked for it on the row, 2026-08-23. Count them — 2026-08-24.**
   *
   * The order of these three questions is the whole of this block, and it is deliberate:
   *
   * 1. **A department holds it.** Unchanged, and still first. Authority attaches to the post
   *    (ADR-0004), so when there is a department answering for this, that is what the column
   *    called *who has it* means.
   * 2. **Named recipients.** This is the case that used to print **"told directly"** — a
   *    sentence naming nobody, on the ordinary path, since M10-07/08/09 made the person row the
   *    only row the picker draws. Two names fit the column; beyond that the **count** carries it
   *    alone, because a cell that wraps to four lines is the ragged board M11-10 exists to avoid.
   * 3. **Nobody, or nobody nameable.** `nobodyTold` is the server's own flag and the only field
   *    that separates *no one was chosen* from *we cannot name who was* — see the warning above.
   *
   * 🔴 **None of the three answered *how many*, and that was the 2026-08-24 defect.** Case 1 in
   * particular printed a department name and stopped: the district looked at a row reading
   * *"Information Technology"* and could not tell whether the alert had gone to one officer or
   * to fourteen. The count below is drawn for every case except the one where the column has
   * already named everybody, so *who has it* and *how many were told* are both on the row.
   *
   * ⚠️ `toldNames` absent means **an older server**, not an empty list. Falling through to the
   * old words is what keeps this bundle renderable against one.
   */
  const told = row.toldNames ?? [];

  /**
   * **Does the column already name every recipient?** — the question the count below turns on.
   *
   * True in the one case where it does: no department holds this, and the whole told list fits
   * inline. Everywhere else the column answers *who holds it* while saying nothing about how
   * many handsets the message actually reached — which is the gap the district reported on
   * 2026-08-24, looking at a row reading **"Information Technology"** and unable to tell whether
   * that meant one officer or fourteen.
   */
  const namesEveryone =
    row.responsibleDepartments.length === 0 && told.length > 0 && told.length <= NAMES_INLINE;

  if (row.responsibleDepartments.length > 0) {
    who.textContent = row.responsibleDepartments.join(', ');
  } else if (told.length === 0) {
    who.textContent = row.nobodyTold ? 'no one chosen' : 'told directly';
  } else if (namesEveryone) {
    who.textContent = told.join(', ');
  } else {
    /**
     * **The count carries it alone — the district's own words, 2026-08-24: *"just number ho"*.**
     *
     * This printed the first name and `+N`. One name out of fourteen is not an answer to *who
     * was told*: it is one fourteenth of one, and it reads as though that officer is the person
     * holding this. The number is the honest short answer, and the names are one click away —
     * in the button itself, and in the window the row opens.
     */
    who.textContent = '';
  }

  /**
   * **How many were told, as a number, on the row** — the district asked for it 2026-08-24.
   *
   * Drawn whenever the column above did not already name them all, which includes the case that
   * prompted the request: a **department** in the `who` column and nothing anywhere on the row
   * saying how many people the message went to.
   *
   * A **button**, not a span with a click handler: the board opens an incident when a row is
   * clicked, so this has to be the one thing in the row that is obviously its own control and
   * obviously not the row. It stops the click from reaching the row (see the handler below), and
   * being a real button is what makes that legible to somebody using a keyboard rather than a
   * surprise.
   */
  const countable = told.length > 0 && !namesEveryone;
  let counter: HTMLButtonElement | null = null;
  if (countable) {
    counter = document.createElement('button');
    counter.type = 'button';
    counter.className = 'toldmore';
    // The word, not the number alone. "4" beside a department name is a quantity of nothing in
    // particular; "4 told" is the sentence the column is being asked for.
    counter.textContent = `${String(told.length)} told`;
    counter.setAttribute('aria-label', `${String(told.length)} were told — show all of them`);
    counter.setAttribute('aria-expanded', 'false');
    if (who.textContent !== '') who.append(' ');
    who.append(counter);
  }

  const age = document.createElement('span');
  age.className = 'meta age';
  // Escalation rides with the age deliberately: it is what happened *because* the clock ran out,
  // and it belongs beside the clock rather than among the flags, which are things about the
  // message rather than about the waiting.
  age.textContent = `${ago(row.occurredAt, at)}${
    row.escalationCount > 0 ? ` · escalated ${row.escalationCount}×` : ''
  }`;

  /**
   * **Corrected**, on the row — M9-53.
   *
   * The word is chosen with care and nothing here strikes anything through. A struck-out row
   * reads as *this did not happen*; what actually happened is that the district sent something
   * and then found it was wrong, and **the people who were told still received it**. An
   * operator who believes the message is gone will not ring them, which is the failure this
   * whole phase exists to avoid.
   */
  const marks: HTMLElement[] = [];
  if (row.corrected === true) {
    const mark = document.createElement('span');
    mark.className = 'corrected';
    mark.textContent = 'corrected';
    if (row.correctionReason != null && row.correctionReason !== '') {
      mark.title = row.correctionReason;
    }
    marks.push(mark);
  }
  /**
   * **Withdrawn**, on the row — M10-17. Never absent from the board because it was hidden;
   * this only ever renders when the row was asked for with `?withdrawn=1` — see `board.ts`'s
   * own note on `hideWithdrawn` being opt out. Same rule as `corrected`: nothing is struck
   * through, because the row still happened.
   */
  if (row.withdrawn) {
    const mark = document.createElement('span');
    mark.className = 'withdrawn';
    mark.textContent = 'withdrawn';
    if (row.withdrawalReason != null && row.withdrawalReason !== '') {
      mark.title = row.withdrawalReason;
    }
    marks.push(mark);
  }
  /**
   * **Two wrappers, and both exist so the table can have columns without the card changing.**
   *
   * `.rmeta` holds *who* and *age*. In **card** mode it is an ordinary span spanning the card's
   * width — today's single grey line, unchanged. In **table** mode CSS gives it
   * `display: contents`, so `.who` and `.age` become direct grid children of `.row` and can be
   * placed in two columns. That is the whole trick: **one markup, two layouts**, which is what
   * ADR-0013 asks for and what "the table is a layout, not a second renderer" means in practice.
   *
   * `.marks` holds `corrected` and `withdrawn` and stays a **real** span in both modes, on
   * purpose. Placed individually they would both want the same column and the second would push
   * the row onto a second line — a table that is one line tall except on the rows that carry a
   * mark is the ragged board M11-10 exists to avoid. One cell, however many marks are in it.
   *
   * `.unmet` is deliberately **not** in either wrapper and keeps its own full-width line. It is a
   * sentence the server chose — *which* of three failures this is, because each has a different
   * fix (INV-03) — and squeezing that into a narrow column turns it back into the count it was
   * replaced for being.
   */
  const rmeta = document.createElement('span');
  rmeta.className = 'rmeta';
  rmeta.append(who, age);

  /**
   * **The Action cell answers "what now", not "open this" — 2026-08-31.**
   *
   *   * **Resolved or withdrawn** — nothing to do; it says so and steps back.
   *   * **Told, and somebody is still being waited on** (`response.silent > 0`, not a notice) —
   *     a **Follow up** button. It carries `data-followup` and no handler of its own: the click
   *     bubbles to `main.ts`'s board delegation, which confirms once and then POSTs
   *     `/incidents/:id/follow-up`, leaving the row where it is. `data-waiting` is how many the
   *     confirm names.
   *   * **Everything else** — the plain *Inspect →* affordance the row always had.
   */
  const inspect = document.createElement('span');
  inspect.className = 'inspect-btn';
  if (row.stage === 'resolved' || row.withdrawn) {
    inspect.classList.add('noact');
    inspect.textContent = 'no action needed';
  } else if (row.general !== true && rsp !== null && rsp.silent > 0) {
    const fb = document.createElement('button');
    fb.type = 'button';
    fb.className = 'followbtn';
    fb.dataset['followup'] = row.incidentId;
    fb.dataset['waiting'] = String(rsp.silent);
    fb.textContent = 'Follow up';
    inspect.append(fb);
  } else {
    inspect.textContent = 'Inspect →';
  }

  if (marks.length > 0) {
    const wrap = document.createElement('span');
    wrap.className = 'marks';
    wrap.append(...marks);
    div.append(sev, cat, stage, wrap, state, rmeta, inspect);
  } else {
    div.append(sev, cat, stage, state, rmeta, inspect);
  }

  // Spelled out, on the row, next to the incident it concerns. A count in a corner
  // tells you the district has a problem; this tells you which incident nobody is
  // coming to (INV-03).
  if (row.notificationsFailed > 0 || row.notificationsUndelivered > 0) {
    const unmet = document.createElement('span');
    unmet.className = 'flag unmet';
    /**
     * **The reason, in words the server chose — not "could not notify the duty seat".**
     *
     * That sentence said two untrue things by 2026-08-06. It said *we tried*, when until the
     * WhatsApp account exists nothing is sent at all and an operator reading it goes hunting a
     * network fault. And it said *duty seat*, when the control room routinely addresses a named
     * officer, or a department that has no post — which is the failure itself.
     *
     * Three failures with three different fixes — buy an account, appoint somebody, correct a
     * number — rendered as one sentence is a count, not a fault report, and INV-03 asks for
     * failures to be visible **so that somebody can fix them**.
     */
    unmet.textContent =
      row.notificationsFailed > 0
        ? (row.notificationsWhy ?? `could not tell ${String(row.notificationsFailed)}`)
        : `told, nobody has answered (${row.notificationsUndelivered})`;
    div.append(unmet);
  }

  /**
   * **What this row is about, without leaving the board — the district asked for it 2026-08-23.**
   *
   * Two things go in here and nothing else:
   *
   *   * **Everyone who was told**, when there were too many to name in the column above. The
   *     `+N` button is what opens it, so the count and the list are one control rather than a
   *     number on the board and a list on another screen.
   *   * **What the officer said when they resolved it** — `resolved.outcome`, which is an
   *     officer's own words: a WhatsApp reply lands there verbatim. *"Kya hua us ka"* was
   *     answerable only by opening the incident, and this is the district's actual question.
   *
   * ⚠️ **It is not built unless there is something to put in it.** An empty disclosure under
   * every live row is precisely the noise this screen has just had removed — the period controls
   * came off the top of the Record for the same reason on the same day.
   *
   * ⚠️ **It starts hidden and nothing auto-opens it.** A block that expanded itself when the
   * ten-second poll re-rendered the board would move rows under a reading operator's cursor,
   * which is the M11-07 defect this file has already paid for once.
   */
  /**
   * ⚠️ **The two are drawn differently on purpose, and the reason is a bug this caught.**
   *
   * The recipient list hides behind `+N`, because `+N` is the control that opens it. The
   * resolution has no such control — so written the same way it would have been a block nothing
   * on the row could ever open. It is drawn **in place** instead, which is also the honest
   * answer to what it is: a resolved incident is finished, it is not competing for attention in
   * the live queue, and the district's question about it — *"kya hua us ka"* — is the one thing
   * somebody opens that row to read.
   */
  const resolution = row.resolution ?? null;
  if (resolution !== null && resolution !== '') {
    const line = document.createElement('div');
    line.className = 'rowresolution';
    /**
     * Labelled *"Resolved:"* rather than *"Outcome:"* — the officer's word, not the schema's.
     * The field is `outcome` in the log because that is what the command is called; what an
     * operator reads on the wall is the sentence somebody sent back from a vehicle.
     */
    line.textContent = `Resolved: ${resolution}`;
    div.append(line);
  }

  /**
   * **What we sent, on the face of the row — the district asked for it 2026-08-24.**
   *
   * It was behind a button. That button was added on 2026-08-23 and the district came back the
   * next day with the same request, which is the answer: *"msg mein kya tha"* is not a detail
   * somebody goes looking for, it is **the thing the row is about**. An operator scanning the
   * Record wants to know what forty officers were told without pressing forty buttons.
   *
   * Drawn in place, like the resolution above it and for the same reason: it is a sentence, not
   * a column. It is also short — `what` is the category and severity as the officer read them
   * and `where` is a place name, both composed by the channel — so this is one line and the
   * board stays the even table M11-10 made it.
   *
   * ⚠️ **Null is UNKNOWN and the row says so in those words.** Nothing sent before 2026-08-23
   * carries a `message_sent` event and none can be reconstructed — see `api/board.ts`. Drawing
   * nothing would read as *nothing was sent*, which is the one thing it does not mean; the
   * `notified` events beside it say something was. So the line appears whenever somebody was
   * actually told, and says **not recorded** when the words are not in the log.
   *
   * ⚠️ It is **withheld entirely when nobody was told**, which is much of a live queue. *"We
   * sent: not recorded"* under a row nobody has been chosen for is a sentence about a message
   * that never existed, and forty of them is the noise this screen has twice had removed.
   */
  const said = row.sentMessage ?? null;
  if (told.length > 0) {
    const line = document.createElement('div');
    line.className = 'rowsaid';
    if (said === null) {
      // A separate class, so the CSS can say *this is an absence* without the words having to
      // shout it — the same quiet the `.meta` colour gives every other unknown on this row.
      line.classList.add('none');
      line.textContent = 'We sent: not recorded';
    } else {
      /**
       * The two halves as the officer read them, in the order they arrive on the handset.
       *
       * Labelled **"We sent"** — first person, because this is the district's own outgoing
       * words and *"Message"* would not say whose.
       */
      line.textContent = `We sent: ${said.what} — ${said.where}`;
    }
    div.append(line);
  }

  /**
   * 🔴 **A chase that could not be sent is a FLAG, not a disclosure.**
   *
   * Everything else added to this row lately hides behind a button, because the queue is read at
   * a glance and detail is what a glance does not want. This is the exception, and the rule that
   * makes it one is INV-03: a failure has to be visible **where somebody acts on it**. What an
   * operator does about this is ring the number or fix the roster — and they will not press a
   * button on forty rows to discover which one needs it.
   *
   * It sits with `.unmet`, in the same colour and the same full-width position, because it is the
   * same kind of fact: the district tried to reach somebody and did not.
   */
  const chase = row.followUp ?? null;
  if (chase !== null && chase.failed) {
    const flag = document.createElement('span');
    flag.className = 'flag unmet';
    // The count, because chased twice and failed twice is a worse sentence than chased once.
    flag.textContent =
      chase.count === 1
        ? 'follow-up could not be sent'
        : `follow-up could not be sent (${String(chase.count)} chased)`;
    div.append(flag);
  }

  /**
   * 🔴 **And when it DID go, said quietly on the face of the row** — D-2, 2026-08-25.
   *
   * Until today a successful chase lived only inside the disclosure, so a row nobody had ever
   * chased and a row chased three times looked **identical** in the queue. An operator working
   * down a silent board at 02:00 has exactly one question about each of them — *has anybody
   * rung this yet* — and the answer was one tap away, forty times.
   *
   * ⚠️ **`.meta`, not `.flag`.** A failed chase is a failure and wears the alarm colour; this
   * is the district having done the right thing, and dressing it in the same red would teach
   * an operator to scan past both. It is the quietest thing on the row that still answers a
   * question.
   */
  if (chase !== null && !chase.failed && chase.count > 0) {
    const mark = document.createElement('span');
    mark.className = 'meta chased';
    mark.textContent = chase.count === 1 ? 'chased once' : `chased ${String(chase.count)} times`;
    div.append(mark);
  }

  /**
   * **One disclosure per row, holding the names behind the count** — 2026-08-23, narrowed
   * 2026-08-24.
   *
   * What we sent used to live in here and now sits on the face of the row (above), because the
   * district asked for it twice. What is left is what genuinely does not belong in a live queue:
   * the **full recipient list** behind the `N told` count, and the follow-up note.
   *
   * ONE control, not two. A count and a *message* button side by side in every row is the clutter
   * this screen has twice had removed from it — so the button carries the count when there is one
   * to carry, and either way it opens the same block.
   *
   * ⚠️ **The list is drawn on exactly the rows the count is** (`countable`), and that pairing is
   * deliberate: a number with nothing behind it is a dead control, and a list with no number
   * above it is a block nothing on the row can open. They are one feature written twice.
   */
  /**
   * **The per-recipient breakdown — the district's call, 2026-08-31.**
   *
   * For a dispatch to more than one, the `state` cell shows the tally and this shows the
   * detail behind it: one line per recipient, whether they are holding it, waiting or
   * declined, and their own words when they sent any. Only when there is more than one — a
   * single recipient's words are already in the cell.
   */
  const showBreakdown = rsp !== null && rsp.told > 1 && rsp.breakdown.length > 0;
  const heldWord = (h: 'holding' | 'declined' | 'silent'): string =>
    h === 'holding' ? 'responded' : h === 'silent' ? 'waiting' : 'declined';

  if (countable || chase !== null || showBreakdown) {
    const more = document.createElement('div');
    more.className = 'rowmore';
    more.hidden = true;

    if (countable) {
      const line = document.createElement('span');
      line.className = 'toldall';
      // Every name, in the order the control room chose them. The column above shows the count;
      // this is the same list unabbreviated, so the two can never disagree.
      line.textContent = `Told: ${told.join(', ')}`;
      more.append(line);
    }

    if (showBreakdown && rsp !== null) {
      /**
       * 🔴 **Headed by the group a dispatch expanded, when one was** — Case 3, 2026-09-10.
       *
       * `expand()` dissolves a ticked group into loose recipients at send, so the lines below
       * are ordinary per-recipient lines; the server tags each with the group's name (or null),
       * and a heading is drawn wherever that changes — the group's name over its members,
       * "Individually notified" over anybody ticked by hand. `null` throughout (a hand dispatch,
       * an older server) draws no heading and the list is exactly as it was.
       */
      // Only when a dispatch actually expanded a group — otherwise not one heading, and the
      // list reads exactly as it did before Case 3.
      const anyGrouped = rsp.breakdown.some((b) => (b.group ?? null) !== null);
      let lastGroup: string | null | undefined;
      for (const b of rsp.breakdown) {
        const group = b.group ?? null;
        if (anyGrouped && group !== lastGroup) {
          const head = document.createElement('span');
          head.className = 'responsegroup';
          head.textContent = group ?? 'Individually notified';
          more.append(head);
          lastGroup = group;
        }
        const line = document.createElement('span');
        line.className = 'responsebreak';
        line.dataset['held'] = b.holding;
        const words = b.said !== null && b.said !== '' ? `: ${b.said}` : '';
        line.textContent = `${b.who ?? 'unnamed'} — ${heldWord(b.holding)}${words}`;
        more.append(line);
      }
    }

    if (chase !== null) {
      const line = document.createElement('span');
      line.className = 'rowchase';
      /**
       * The note already says what was said and which alert it chases — `api/followUp.ts` composes
       * it. Nothing is reworded here; the count is added because the note describes one chase and
       * the row is describing all of them.
       */
      line.textContent =
        chase.count === 1 ? chase.note : `${chase.note} · ${String(chase.count)} chased in all`;
      more.append(line);
    }

    div.append(more);

    /**
     * The button is the `N told` count when there is one; otherwise it is made here.
     *
     * Same class, so one rule styles both and they cannot drift apart, and the same reason it is
     * a real `button`: the row around it opens the incident on click, so this has to read as the
     * one thing in the row that is not the row.
     */
    let toggle = counter;
    if (toggle === null) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toldmore';
      // Named for what is actually behind it. `responses` when it opens the per-recipient
      // breakdown; `follow-up` when that is all there is.
      const forResponses = showBreakdown;
      toggle.textContent = forResponses ? 'responses' : 'follow-up';
      toggle.setAttribute(
        'aria-label',
        forResponses ? 'show what each recipient said' : 'show the follow-up sent about this',
      );
      toggle.setAttribute('aria-expanded', 'false');
      who.append(' ', toggle);
    }

    const control = toggle;
    control.addEventListener('click', (e) => {
      /**
       * ⚠️ **Both, and both are load-bearing.** `stopPropagation` keeps the board's own row
       * handler from opening the incident — the whole point is to stay on the board — and
       * `preventDefault` keeps a button inside a clickable row from doing anything else the
       * browser might think it means.
       */
      e.stopPropagation();
      e.preventDefault();
      const open = more.hidden;
      more.hidden = !open;
      control.setAttribute('aria-expanded', String(open));
    });
  }
  return div;
}
