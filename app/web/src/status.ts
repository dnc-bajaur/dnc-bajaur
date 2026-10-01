/**
 * The Status screen — M4.
 *
 * Where the district says how it is doing. Everything the dashboard *shows* is entered here,
 * and it is one screen rather than four because the four things are the same shape: somebody
 * with authority states a fact, and the fact is stamped with who and when.
 *
 * **Scoped, not hidden.** A department sees the services it answers for and the posts it
 * holds; the two administrative offices see everything, plus the district's advisories and
 * standing facts. Everything on this screen that a caller may not do is simply not drawn —
 * and every one of those is refused server-side as well, because a hidden control is a
 * courtesy and never a control (INV-05).
 *
 * **Nothing here is entered on the dashboard.** The prototype this came from puts an Edit
 * button on every panel, which follows from having no backend: the display has to be its own
 * admin because there is nowhere else for the data to live. Here there is somewhere else, and
 * it is this screen — which knows who is typing.
 */

import { makeCard } from './tilt.js';

interface Utility {
  utilityId: string;
  name: string;
  panel: 'utility' | 'services';
  departmentId: string | null;
  departmentName: string | null;
  status: 'normal' | 'degraded' | 'down' | null;
  note: string | null;
  reportedAt: string | null;
  reportedBy: string | null;
  /**
   * How long a report on this service stays believable — M10-03.
   *
   * Already on the wire since M4: `/status` returns `listUtilities` wholesale and this column has
   * been in it all along. It was simply never declared here, so nothing could draw it.
   */
  staleMinutes: number;
}

interface Presence {
  seatId: string;
  seatTitle: string;
  departmentName: string | null;
  isAdministration: boolean;
  /** ADR-0033 — two states, set by hand. No timer, no *until when*. */
  status: 'available' | 'unavailable' | null;
  note: string | null;
  reportedAt: string | null;
  /** Whoever holds this post now, from today's roster. Null when the post is vacant. */
  officer: string | null;
  /** The control room has picked this seat onto the Dashboard wall. */
  onWall: boolean;
}

interface Alert {
  alertId: string;
  tag: string;
  message: string;
  issuedAt: string;
  untilAt: string;
}

interface Fact {
  key: string;
  label: string;
  value: string | null;
}

interface StatusFeed {
  utilities: Utility[];
  presence: Presence[];
  facts: Fact[];
  alerts: Alert[];
  departments: { departmentId: string; name: string }[];
  canConfigure: boolean;
  departmentId: string | null;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

function clear(node: HTMLElement): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A field whose contents survive the panel being rebuilt — 2026-09-08, the owner.
 *
 * 🔴 **The panel threw away what somebody had typed and said nothing.** `paint()` does
 * `clear(root)` and builds a new tree, and ten places call `reload()` after a save — a service
 * marked Down, a district fact leaving its field, an advisory withdrawn. Any one of them landing
 * while an operator was part-way through the advisory box took their words with it: the box came
 * back empty, `POST /status/alerts` answered *"say what the advisory is"*, and that refusal shows
 * in a note beside a form the operator has already looked away from. They believe it was sent.
 *
 * ⚠️ **Only what the operator changed is carried over, never what the server said.** `rendered`
 * holds the value the field was built with, so "dirty" is `value !== rendered` — an untouched
 * field takes the fresh value from the server as it always did, and a field somebody is editing
 * keeps their version. Restoring everything would let a stale reading sit on screen looking
 * current, which is the failure this screen exists to prevent.
 *
 * The caret comes back too. A cursor that jumps to the end mid-sentence is its own small way of
 * losing what somebody typed.
 */
function keep(node: HTMLInputElement, key: string): void {
  node.dataset['keep'] = key;
  node.dataset['rendered'] = node.value;
}

interface KeptField {
  readonly value: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly focused: boolean;
}

function takeKept(root: HTMLElement): Map<string, KeptField> {
  const held = new Map<string, KeptField>();
  // `Array.from`, not `for…of` on the NodeList — the build's lib target has no iterator on it.
  for (const node of Array.from(root.querySelectorAll<HTMLInputElement>('[data-keep]'))) {
    const key = node.dataset['keep'];
    if (key === undefined || node.value === (node.dataset['rendered'] ?? '')) continue;
    held.set(key, {
      value: node.value,
      start: node.selectionStart,
      end: node.selectionEnd,
      focused: document.activeElement === node,
    });
  }
  return held;
}

function putKept(root: HTMLElement, held: Map<string, KeptField>): void {
  for (const [key, was] of held) {
    const node = root.querySelector<HTMLInputElement>(`[data-keep="${key}"]`);
    if (node === null) continue;
    node.value = was.value;
    if (!was.focused) continue;
    node.focus();
    // `datetime-local` and friends throw on `setSelectionRange`; the focus is the part that
    // matters there and the caret is not addressable anyway.
    if (was.start === null || was.end === null) continue;
    try {
      node.setSelectionRange(was.start, was.end);
    } catch {
      /* not a field with a caret */
    }
  }
}

function ago(iso: string | null): string {
  if (iso === null) return 'never reported';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never reported';

  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)} min ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${String(hours)} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${String(days)} days ago`;
}

/**
 * A local time as an input[type=datetime-local] wants it.
 *
 * `toISOString()` is UTC, and a district officer typing "back at two" means two o'clock in
 * Bajaur. Getting this wrong by five hours in a field that decides when an advisory expires
 * is worse than having no default at all.
 */
function localStamp(hoursFromNow: number): string {
  const when = new Date(Date.now() + hoursFromNow * 3600_000);
  const pad = (n: number): string => String(n).padStart(2, '0');

  return (
    `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

export interface StatusPanel {
  show(): Promise<void>;
}

export function mountStatus(options: { onChanged?: () => void } = {}): StatusPanel {
  const root = el('statusBody');
  const note = el('statusNote');

  let feed: StatusFeed | null = null;
  let busy = false;

  /**
   * One write, with the server's own words on the way back.
   *
   * `method` is a parameter because renaming a post is `PATCH /roster/posts/:id` — the roster's
   * route, reached from this screen rather than copied onto it. ADR-0033 put the officers on this
   * panel; a second rename endpoint would be a second place for the two to disagree about what a
   * designation is called, and `mayEditRoster` is already the identical gate to `canConfigure`
   * (both are `identity.isAdministration`), so nothing is widened by asking it from here.
   */
  async function send(path: string, body: unknown, method = 'POST'): Promise<boolean> {
    // One in flight at a time. Two clicks on "Down" while the first is still going would
    // write the same report twice, and the second is indistinguishable from a real one.
    if (busy) return false;
    busy = true;
    note.textContent = 'Saving…';
    note.className = 'note';

    try {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { error?: string };
        // The server's own words. It knows why it refused; a generic "could not save" would
        // send somebody to find a developer for a message that was already written.
        note.textContent = problem.error ?? `Refused (${String(res.status)}).`;
        note.className = 'note state-critical';
        return false;
      }

      note.textContent = 'Saved.';
      note.className = 'note state-ok';
      options.onChanged?.();
      return true;
    } catch {
      note.textContent = 'Could not reach the server. Nothing was saved.';
      note.className = 'note state-critical';
      return false;
    } finally {
      busy = false;
    }
  }

  async function reload(): Promise<void> {
    // `/status` warmed at idle after sign-in (see `prefetchScreenData` in `main.ts`), served
    // once so the screen paints filled rather than blank on the first open. Every later reload
    // — a report saved, a tab returned to — goes to the server.
    const warm = (
      window as unknown as { __dncPrefetchGet?: (p: string) => unknown }
    ).__dncPrefetchGet?.('/status');
    if (warm !== undefined) {
      feed = warm as StatusFeed;
      paint();
      return;
    }
    const res = await fetch('/status', { headers: { accept: 'application/json' } });
    if (!res.ok) {
      clear(root);
      root.appendChild(make('p', 'note state-critical', 'Could not load the status screen.'));
      return;
    }

    feed = (await res.json()) as StatusFeed;
    paint();
  }

  /**
   * A panel, and it is a card — the same one the dashboard's counters are made of.
   *
   * ⚠️ **It returns the element callers should append INTO, which is no longer the section.**
   * `makeCard` moves a panel's children down into a `.lift` inside the card, so a caller that
   * kept appending to the outer node would drop its rows outside the face — invisible, with
   * nothing erroring. Returning the inner container makes that impossible to get wrong rather
   * than something every call site has to remember.
   *
   * The upgrade is additive: if it never ran, this screen would be exactly the screen it was
   * before, because `.panel` still paints on its own and the card's rules hang off `.panel.tilt`.
   */
  function section(title: string, hint?: string): HTMLElement {
    const panel = make('section', 'panel');
    panel.appendChild(make('h2', '', title));
    if (hint !== undefined) panel.appendChild(make('p', 'note', hint));
    root.appendChild(panel);
    makeCard(panel);
    return panel.querySelector<HTMLElement>('.lift') ?? panel;
  }

  //----------------------------------------------------------------------------
  // Conditions — what the control room reports about a service the district watches
  //----------------------------------------------------------------------------

  /**
   * 🔴 **NO AGE ON A CARD ON THIS SCREEN — the district, 2026-09-08.**
   *
   * The owner, watching this screen: *"en k sath ju time show hota hai jese k: 1 hr ago, 2 days
   * ago … ye time yaha par show nhe hona chaye hai, YE SAHE NHE lag raha hai."* Said three times
   * over, and scoped by the owner in the same breath — **this screen and nothing else**: *"status
   * sai bahar kese bhi jaga sai nhe hatana chah raha hon."*
   *
   * ⚠️ **The wall keeps its age and that is not an oversight.** [ADR-0025] removed the expiry
   * timer on a utility reading and answered INV-02 with exactly one sentence — *the row is dated
   * rather than degraded, and the wall prints the age beside the status*. `renderStatusList` in
   * `dashboard.ts` is where that promise is kept, and it is untouched. **A later reader tidying
   * "the same age in two places" must not reach for the dashboard one.**
   *
   * The screen it came off is the one where the age was never load-bearing: this is the **input**
   * side, where somebody states a condition. What they need to see is the service and the answer
   * they are about to give it. On the utility cards the removed span had stopped carrying an age
   * at all — since [ADR-0030] every `departmentName` is null, so the only branch that could still
   * render read **"nobody assigned"** on every row, about departments that no longer exist.
   */
  function conditionRows(panel: HTMLElement, rows: Utility[], board: 'utility' | 'services'): void {
    // ⚠️ **Says its piece and carries on, where it used to `return`.** An empty panel is the
    // one state where the Add control below matters most — a control room that has just removed
    // its last service could otherwise never add one back, and the screen would look broken
    // rather than empty.
    if (rows.length === 0) {
      panel.appendChild(
        make(
          'p',
          'empty',
          feed?.canConfigure === true
            ? 'Nothing on this panel yet.'
            : 'Nothing here is yours to report. The control room sets these.',
        ),
      );
    }

    for (const row of rows) {
      const item = make('div', 'sreport');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', row.name));
      item.appendChild(head);

      const noteField = make('input', 'snote');
      noteField.type = 'text';
      noteField.placeholder = 'What is happening? e.g. load shedding, 4 hrs on 2 off';
      noteField.maxLength = 120;
      noteField.value = row.note ?? '';
      keep(noteField, `note:${row.utilityId}`);

      const buttons = make('div', 'sbuttons');
      for (const [value, label] of [
        ['normal', 'Normal'],
        ['degraded', 'Degraded'],
        ['down', 'Down'],
      ] as const) {
        const button = make('button', `sbtn ${value}`, label);
        button.type = 'button';
        if (row.status === value) button.setAttribute('aria-pressed', 'true');

        button.addEventListener('click', () => {
          void (async () => {
            const ok = await send('/status/utility', {
              utilityId: row.utilityId,
              status: value,
              note: noteField.value,
            });
            if (ok) await reload();
          })();
        });

        buttons.appendChild(button);
      }

      item.appendChild(noteField);
      item.appendChild(buttons);
      if (feed?.canConfigure === true) item.appendChild(serviceAdmin(row));

      panel.appendChild(item);
    }

    if (feed?.canConfigure === true) addServiceForm(panel, board);
  }

  /**
   * Rename and Remove, on the card itself — the district, 2026-09-08.
   *
   * *"subi panels mai … add and remove buttons plus rename button hona chaye hain taake control
   * es ko accordingly adjust kar ske."* Every one of these has been served by the API since M4
   * (`/status/utilities`, `/status/utilities/retire`) or since today (`/status/utilities/rename`),
   * and **no screen has ever offered one** — so which services Bajaur watches has been whatever
   * migration 0017 seeded, editable only by somebody with a database prompt.
   *
   * **Administration only, and drawn only for them.** The routes refuse everybody else with or
   * without this check (INV-05); what `canConfigure` decides is whether a duty officer is shown
   * two buttons that will be refused.
   *
   * `prompt` and `confirm` rather than a dialog, deliberately: this is the same weight as the
   * roster's own Rename (`roster.ts`) and the advisory Withdraw four panels down, and matching
   * them costs nothing. `admin.ts`'s argument against `prompt()` was about **five** questions
   * that each needed a typed reason under INV-06; one name is not that.
   */
  function serviceAdmin(row: Utility): HTMLElement {
    const actions = make('div', 'sadmin');

    const rename = make('button', 'plain small calm', 'Rename');
    rename.type = 'button';
    rename.addEventListener('click', () => {
      const name = prompt('New name for this service', row.name);
      if (name === null || name.trim() === '') return;
      void (async () => {
        const ok = await send('/status/utilities/rename', { utilityId: row.utilityId, name });
        if (ok) await reload();
      })();
    });
    actions.appendChild(rename);

    const remove = make('button', 'plain small', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      // Retired, never deleted — every report filed against this service stays answerable
      // (ADR-0001), exactly as a withdrawn advisory does. The sentence says so, because a
      // control room that believes "Remove" erases the record will use it to erase a record.
      if (
        !confirm(
          `Remove "${row.name}" from this panel?

` +
            'It leaves the Status screen and the dashboard. Everything already reported ' +
            'against it stays in the record.',
        )
      ) {
        return;
      }

      void (async () => {
        const ok = await send('/status/utilities/retire', {
          utilityId: row.utilityId,
          reason: 'Removed from the status board',
        });
        if (ok) await reload();
      })();
    });
    actions.appendChild(remove);

    return actions;
  }

  /**
   * Add a service to this panel.
   *
   * The `panel` field is what makes this two controls rather than one: `/status/utilities`
   * ignored it until today, so anything the product created landed on **Public utilities** and
   * District services could only ever hold migration 0017's seed. The button knows which panel
   * drew it, so nobody has to be asked a question the screen already knows the answer to.
   */
  function addServiceForm(panel: HTMLElement, board: 'utility' | 'services'): void {
    const form = make('div', 'sform sadd');

    const name = make('input', '');
    name.type = 'text';
    name.maxLength = 60;
    name.placeholder =
      board === 'utility' ? 'Add a utility — e.g. Sui Gas' : 'Add a service — e.g. DHQ Hospital';
    keep(name, `add:${board}`);

    const add = make('button', 'plain go', 'Add');
    add.type = 'button';
    add.addEventListener('click', () => {
      if (name.value.trim() === '') {
        note.textContent = 'Give it a name first.';
        note.className = 'note state-critical';
        return;
      }
      void (async () => {
        const ok = await send('/status/utilities', { name: name.value.trim(), panel: board });
        if (ok) {
          name.value = '';
          await reload();
        }
      })();
    });

    form.appendChild(name);
    form.appendChild(add);
    panel.appendChild(form);
  }

  //----------------------------------------------------------------------------
  // Presence
  //----------------------------------------------------------------------------

  /**
   * Which posts to draw, and why not all of them.
   *
   * The two offices may set presence for any seat in the district — 83 of them. Drawing all 83
   * with three buttons and two fields each produced a column two thousand pixels long, which
   * is not a screen anybody uses: the six posts somebody actually wants are lost in it.
   *
   * So the default is the posts an office would look for — its own, plus anything already
   * reported — and a search box reaches the rest. Nothing is withheld; it is one word away.
   */
  function visiblePresence(rows: Presence[], search: string): Presence[] {
    const needle = search.trim().toLowerCase();

    if (needle !== '') {
      return rows.filter((r) => r.seatTitle.toLowerCase().includes(needle)).slice(0, 40);
    }

    const shortlist = rows.filter((r) => r.isAdministration || r.status !== null);

    // A department seeing only its own posts is already a short list; do not shorten it again.
    return (feed?.canConfigure === true ? shortlist : rows).slice(0, 40);
  }

  let presenceSearch = '';

  function presenceRows(panel: HTMLElement, all: Presence[]): void {
    if (all.length === 0) {
      panel.appendChild(make('p', 'empty', 'No posts to report on.'));
      return;
    }

    if (feed?.canConfigure === true) {
      const find = make('input', 'snote');
      find.type = 'search';
      find.id = 'presenceSearch';
      find.placeholder = `Find a post — showing the administration's own of ${String(all.length)}`;
      find.value = presenceSearch;
      find.addEventListener('input', () => {
        presenceSearch = find.value;
        paint();
        // Re-painting replaces the field, so put the cursor back where it was.
        const again = document.getElementById('presenceSearch');
        if (again !== null) (again as HTMLInputElement).focus();
      });
      panel.appendChild(find);
    }

    const rows = visiblePresence(all, presenceSearch);

    if (rows.length === 0) {
      panel.appendChild(make('p', 'empty', 'No post matches that.'));
      return;
    }

    for (const row of rows) {
      const item = make('div', 'sreport');

      const head = make('div', 'shead');
      // The seat title is the designation; the officer's name sits beside it so the control
      // room knows whose availability it is setting (and the wall shows both — ADR-0033 §1).
      head.appendChild(make('span', 'sname', row.seatTitle));
      if (row.officer !== null) head.appendChild(make('span', 'sofficer', row.officer));
      item.appendChild(head);

      /**
       * **Two states, set by hand — ADR-0033.** The district asked for exactly this: mark an
       * officer available or unavailable, no auto-mark, no timer, no reset. The old five-answer
       * list and its *until when* are gone; nothing polls an officer.
       */
      const buttons = make('div', 'sbuttons');
      for (const [value, label] of [
        ['available', 'Available'],
        ['unavailable', 'Unavailable'],
      ] as const) {
        const button = make('button', `sbtn ${value}`, label);
        button.type = 'button';
        if (row.status === value) button.setAttribute('aria-pressed', 'true');

        button.addEventListener('click', () => {
          void (async () => {
            const ok = await send('/status/presence', { seatId: row.seatId, status: value });
            if (ok) await reload();
          })();
        });

        buttons.appendChild(button);
      }
      item.appendChild(buttons);

      if (feed?.canConfigure === true) item.appendChild(officerAdmin(row));

      panel.appendChild(item);
    }
  }

  /**
   * Add / Remove / Rename on an officer card — the district, 2026-09-08.
   *
   * 🔴 **"Add" and "Remove" mean *this panel on the wall*, NOT the post itself.** The owner was
   * offered both readings and took this one: a designation is created and retired on the
   * **Roster**, which is where its holder, its history and its authority live (ADR-0004), and
   * two doors onto one record is how the two end up disagreeing about whether a post exists.
   * What this screen decides is [ADR-0033]'s curated pick — **which of Bajaur's 83 posts the
   * Dashboard wall carries** — and that is a display choice this screen already owned.
   *
   * ⚠️ **So a "Remove"d officer is still a post, still on this screen, still reportable.** The
   * button says *Remove from dashboard*, in those words, for exactly that reason; anything
   * shorter would read as *retire this designation* to somebody who has not read this comment.
   *
   * It replaces the **Show on dashboard** checkbox that shipped with ADR-0033 phase 2 — same
   * route, same one field, said as the district says it.
   *
   * **Rename is the roster's route**, `PATCH /roster/posts/:seatId` — the one `roster.ts` calls,
   * with the same prompt and the same wording. Not a copy of it: a designation has one name and
   * one place that changes it, and `mayEditRoster` is `identity.isAdministration`, which is
   * `canConfigure` under another name.
   */
  function officerAdmin(row: Presence): HTMLElement {
    const actions = make('div', 'sadmin');

    const wall = make(
      'button',
      'plain small calm',
      row.onWall ? 'Remove from dashboard' : 'Add to dashboard',
    );
    wall.type = 'button';
    wall.setAttribute('aria-pressed', row.onWall ? 'true' : 'false');
    wall.addEventListener('click', () => {
      void (async () => {
        const ok = await send('/status/presence/wall', { seatId: row.seatId, onWall: !row.onWall });
        if (ok) await reload();
      })();
    });
    actions.appendChild(wall);

    const rename = make('button', 'plain small calm', 'Rename');
    rename.type = 'button';
    rename.addEventListener('click', () => {
      const title = prompt('New title for this designation', row.seatTitle);
      if (title === null || title.trim() === '') return;
      void (async () => {
        const ok = await send(`/roster/posts/${row.seatId}`, { title }, 'PATCH');
        if (ok) await reload();
      })();
    });
    actions.appendChild(rename);

    return actions;
  }

  //----------------------------------------------------------------------------
  // Advisories — the two offices issue them
  //----------------------------------------------------------------------------

  function advisories(panel: HTMLElement): void {
    if (feed === null) return;

    if (feed.canConfigure) {
      const form = make('div', 'sform');

      const tag = make('select', '');
      for (const [value, label] of [
        ['vip', 'VIP movement'],
        ['security', 'Security'],
        ['road', 'Road'],
        ['weather', 'Weather'],
        ['other', 'Other'],
      ] as const) {
        const option = make('option', '', label);
        option.value = value;
        tag.appendChild(option);
      }

      const message = make('input', '');
      message.type = 'text';
      message.id = 'alertMessage';
      message.placeholder = 'What is being advised?';
      message.maxLength = 200;
      keep(message, 'alert:message');

      const until = make('input', '');
      until.type = 'datetime-local';
      until.id = 'alertUntil';
      until.value = localStamp(12);
      until.title = 'When does it stop mattering?';
      keep(until, 'alert:until');

      // `.plain` is the critical-red submit used for reporting an emergency. An advisory is
      // an announcement, not an alarm, so it gets the accent instead.
      const issue = make('button', 'plain go', 'Issue advisory');
      issue.type = 'button';
      issue.id = 'issueAlert';
      issue.addEventListener('click', () => {
        void (async () => {
          const ok = await send('/status/alerts', {
            tag: tag.value,
            message: message.value,
            untilAt: new Date(until.value).toISOString(),
          });
          if (ok) {
            message.value = '';
            await reload();
          }
        })();
      });

      form.appendChild(tag);
      form.appendChild(message);
      form.appendChild(until);
      form.appendChild(issue);
      panel.appendChild(form);
    }

    if (feed.alerts.length === 0) {
      panel.appendChild(make('p', 'empty', 'Nothing in force.'));
      return;
    }

    for (const alert of feed.alerts) {
      const item = make('div', 'sreport');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', alert.message));
      head.appendChild(make('span', 'age', `${alert.tag} · ${ago(alert.issuedAt)}`));
      item.appendChild(head);

      if (feed.canConfigure) {
        const withdraw = make('button', 'plain small', 'Withdraw');
        withdraw.type = 'button';
        withdraw.addEventListener('click', () => {
          // Withdrawn, never deleted — "we told the district the road was shut" is a thing
          // somebody may have to answer for (ADR-0001). It confirms rather than asking why
          // (2026-09-01); the server still requires a reason, so a fixed one is sent, and the
          // actor, the seat and the time — what INV-06 turns on — are still recorded.
          if (!confirm(`Withdraw this advisory?\n\n${alert.message}\n\nIt stays in the record.`)) {
            return;
          }

          void (async () => {
            const ok = await send('/status/alerts/withdraw', {
              alertId: alert.alertId,
              reason: 'Withdrawn from the console',
            });
            if (ok) await reload();
          })();
        });
        item.appendChild(withdraw);
      }

      panel.appendChild(item);
    }
  }

  //----------------------------------------------------------------------------
  // The standing facts
  //----------------------------------------------------------------------------

  function facts(panel: HTMLElement): void {
    if (feed === null) return;

    for (const fact of feed.facts) {
      const item = make('div', 'sreport');

      const head = make('div', 'shead');
      head.appendChild(make('span', 'sname', fact.label));
      item.appendChild(head);

      const input = make('input', 'snote');
      input.type = 'text';
      input.maxLength = 60;
      input.value = fact.value ?? '';
      input.placeholder = 'not supplied yet';
      keep(input, `fact:${fact.key}`);

      // Saved on blur rather than on every keystroke: four fields, changed once a year, and a
      // request per character would be four hundred writes to record a population.
      input.addEventListener('blur', () => {
        if ((fact.value ?? '') === input.value.trim()) return;
        void send('/status/facts', { key: fact.key, value: input.value.trim() });
      });

      item.appendChild(input);
      panel.appendChild(item);
    }
  }

  function paint(): void {
    if (feed === null) return;
    // Taken before the tree goes, put back after it is rebuilt — see `keep()`.
    const held = takeKept(root);
    clear(root);

    /**
     * 🔴 **`null === null` WAS TRUE, SO THIS FILTER PASSED EVERYTHING — ADR-0030.**
     *
     * It kept the utilities whose `departmentId` matched the viewer's. Migration 0039 dropped
     * both columns, so every utility carries `null` and so does every seat — and the comparison
     * that was meant to narrow the list stopped narrowing anything at all, while the sentence
     * above it went on telling the reader these were **their department's**. Both halves wrong
     * in the same breath: everything shown, and a false reason given for showing it.
     *
     * ⚠️ **The fifth time an absent value has been read as a permissive one here** — after
     * `Tier` defaulting to `district`, `navigator.onLine`, `viewerFor`'s null department, and
     * `evaluateRead`'s empty responsible list. *An absent value is not a scope.*
     *
     * There is no ownership left to filter on, so the list is not filtered and the sentence says
     * what is actually true: the control room reports these, and nobody else may (`mayReportFor`
     * has refused everybody else since 2026-08-22).
     */
    const mine = feed.utilities;

    conditionRows(
      section(
        'Public utilities',
        feed.canConfigure ? 'You may report any of these.' : 'The control room reports these.',
      ),
      mine.filter((u) => u.panel === 'utility'),
      'utility',
    );

    conditionRows(
      section('District services', 'Markets, schools, the hospital, the roads.'),
      mine.filter((u) => u.panel === 'services'),
      'services',
    );

    presenceRows(
      section(
        'Where the officers are',
        'Set against the post, not the person — so it keeps reading correctly across a transfer.',
      ),
      feed.presence,
    );

    advisories(
      section(
        'Alerts & advisories',
        feed.canConfigure
          ? 'Issued to the whole district. Every one must say when it ends.'
          : 'Issued by the DC and AC Headquarter offices.',
      ),
    );

    if (feed.canConfigure) {
      facts(section('District status', 'The facts that do not change on a Tuesday.'));
    }

    putKept(root, held);
  }

  return {
    async show(): Promise<void> {
      note.textContent = '';
      note.className = 'note';
      await reload();
    },
  };
}
