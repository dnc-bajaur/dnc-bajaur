/**
 * "Who should know?" — the control room's own control (M6-06, M6-07, M6-08).
 *
 * This is the screen the milestone exists for. An alert reaches Bajaur's control room by
 * telephone; an operator types it, and then decides who to tell. Today that decision happens on
 * a personal handset and leaves no trace at all.
 *
 * ## Where it sits, and why that is not an accident
 *
 * **After the report is already safe**, in the enrichment half of the intake screen. The
 * critical path stays two taps and a button with no typing (M0-36), because a system slower
 * than the phone call it replaces loses to the phone. Choosing recipients is the second act,
 * exactly like the place and the description — and it is the same rule the server follows by
 * keeping `dispatch-to` out of intake: intake cannot refuse (INV-01), and this can.
 *
 * ## Three things it is careful about
 *
 * **The history proposes; the operator decides.** Whoever this district usually tells for this
 * kind of emergency arrives pre-ticked, with the count that earned it named beside the tick. An
 * operator who cannot see *why* a department was pre-ticked cannot disagree with it — and the
 * point of showing a proposal is that somebody is judging it.
 *
 * Configured routing signals were the other proposer until ADR-0022 and are gone; `learning.ts`
 * is the only one left, and it is the better half. A rule nobody remembers writing can be
 * silently wrong for a year; a habit read back off the district's own dispatches corrects itself
 * the moment they dispatch differently.
 *
 * **An unreachable recipient is shown, marked, and still selectable.** A vacant post, a stand-in
 * number, an officer with no sign-in. Hiding them takes the vacancy away from the one person
 * who was about to notice it, and lets a vacant post swallow an obligation in silence
 * (ADR-0004). Selecting one records that somebody was owed a message and did not get it.
 *
 * **What the server absorbed is said out loud.** Ticking a department and a post inside it is
 * one message, correctly — and an operator who ticks four things and watches three go stops
 * trusting the control. The reply names what covered what.
 */

import { findDuplicate, duplicateSentence } from './duplicates.js';
import { attendanceFor, type AttendanceAnswer } from '../../src/domain/attendance.js';
import type { MessageKind } from '../../src/domain/events.js';
import { ownershipOf } from '../../src/domain/ownership.js';
import { groupRecipients, targetKey } from '../../src/domain/recipientGroups.js';
import { optionOfSaid } from '../../src/domain/responseOptions.js';

interface Recipient {
  kind: 'department' | 'post' | 'person';
  id: string;
  label: string;
  departmentId: string | null;
  departmentName: string | null;
  holderName: string | null;
  /** The designation this person holds **in this department** — M10-06. Per row, not per person. */
  designation: string | null;
  phone: string | null;
  unreachable: 'vacant' | 'placeholder' | 'no_number' | 'disabled' | null;
}

/** A saved set the control room tells together — M7-14. */
interface Group {
  groupId: string;
  name: string;
  members: { kind: string; id: string }[];
  /** A `data:` URI photo, or null/absent — 2026-09-01. Shown beside the name so a room recognises the group at a glance. */
  picture?: string | null;
}

interface RecipientList {
  recipients: Recipient[];
  groups?: Group[];
  sharedNumbers: { phone: string; labels: string[] }[];
  /**
   * What the district's configured routing signals matched — **never sent since ADR-0022.**
   *
   * Kept in the shape, and every read of it below is `?? []`, because handsets cache the shell:
   * an older `dispatch.js` and a newer server have to agree, and in both directions. It is a
   * field that is now always absent, not a field that was removed.
   */
  proposed?: { kind: string; id: string }[];
  /** What the district's own habit proposes, each with the sentence that explains it. */
  learned?: { kind: string; id: string; times: number; outOf: number; because: string }[];
  /**
   * Where a newly added officer can be **filed** — 2026-08-22, and never what may be ticked.
   *
   * The add-an-officer form used to read its options out of `recipients`, which stopped holding
   * a department row when the directory went flat — so the select came back empty and nobody
   * could be added at all. Its own field now, because these are two different questions and
   * merging them is how a department finds its way back onto the list the district asked to have
   * it taken off.
   *
   * Optional, and read as `?? []`: an older server does not send it, and the form then says it
   * needs a department rather than filing somebody in the wrong place.
   */
  departments?: { id: string; label: string }[];
  /**
   * Whether this seat may add to the directory — M9-23. The server decides; see `contacts.ts`.
   * Absent means no: an older server that does not send it draws no doors, which is the safe
   * way round for a flag whose false value is the restrictive one.
   */
  canEditDirectory?: boolean;
}

interface Outcome {
  kind: string;
  id: string;
  label: string;
  coveredBy: { kind: string; id: string; label: string } | null;
  unreachable: string | null;
}

/** What each reachability answer means to the person about to tick it. */
const WHY: Record<string, string> = {
  vacant: 'nobody holds this designation',
  placeholder: 'stand-in number — reaches nobody',
  no_number: 'no number on the roster',
  disabled: 'account disabled',
};

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

function key(t: { kind: string; id: string }): string {
  return `${t.kind}:${t.id}`;
}

export interface DispatchPanel {
  /** Load the district and pre-tick whatever its own history proposes for this report. */
  open: (incidentId: string, draft: { category: string; description: string }) => Promise<void>;
  /** Forget the previous report's selection. Called when a new one starts. */
  reset: () => void;
}

/**
 * Mount the panel into a container the page already owns.
 *
 * `onDispatched` fires after the server has recorded the choice, so the screen that owns the
 * incident can refresh — the obligations exist by then, because the endpoint runs the notify
 * pass before it answers.
 */
export function mountDispatch(
  root: HTMLElement,
  onDispatched?: (incidentId: string) => void,
  /**
   * Anything that must finish before a message goes — 2026-08-14. Today: the attachment upload.
   *
   * **Awaited on the send, never on the open.** The picker appears the instant the report is
   * safe, exactly as it always has, and the wait lands on the one action whose outcome depends
   * on it: `jobs/whatsappChannel.ts` reads the incident's attachments at send time, so a
   * dispatch that overtakes the upload sends a message with no file in it and reports success.
   *
   * It must never reject and must never hang for long — an attachment that cannot be sent is a
   * message without a file, while a picker that will not send is a district that cannot tell
   * anybody anything.
   */
  beforeSend?: () => Promise<void>,
): DispatchPanel {
  let incidentId: string | null = null;
  let list: RecipientList | null = null;
  /** The query `open()` used, kept so the directory can be re-read after an add (M9-23). */
  let lastQuery = '';
  const chosen = new Set<string>();
  /** Group ids ticked. Kept apart from `chosen`, because the server expands them (M7-10). */
  const pickedGroups = new Set<string>();
  let filter = '';

  /** A group member's name, from the directory this panel already has. */
  /**
   * Keep the "already ticked for you" band in step with a tick — M10-37.
   *
   * The band's heading goes with its last row. A heading over nothing reads as a panel that
   * failed to load, and this one appears only when it has something to say.
   */
  function syncHints(pick: string, on: boolean): void {
    body.querySelectorAll<HTMLElement>(`.dhintrow[data-pick="${pick}"]`).forEach((el) => {
      el.hidden = !on;
    });
    body.querySelectorAll<HTMLElement>('.dhint').forEach((band) => {
      band.hidden = band.querySelectorAll('.dhintrow:not([hidden])').length === 0;
    });
  }

  function nameOfMember(m: { kind: string; id: string }): string {
    // The id when the directory does not know it — never blank. A blank name in a list of who
    // gets told reads as nobody, which is the one reading that must never be available.
    return list?.recipients.find((r) => r.kind === m.kind && r.id === m.id)?.label ?? m.id;
  }

  const search = make('input', 'dsearch');
  search.type = 'search';
  // ADR-0030 — it said "Search departments, designations and officers" and named a thing the
  // district had already been told does not exist. It was left standing after ADR-0029 narrowed
  // the picker to one row per contact, and the owner spotted it on the screen rather than
  // anybody finding it here: a promise in a placeholder is still a promise.
  search.placeholder = 'Search by name, designation or number';
  search.setAttribute('aria-label', 'Search who to tell');

  const body = make('div', 'dbody');
  const note = make('p', 'note');
  const send = make('button', 'dsend', 'Tell them');
  send.type = 'button';
  send.disabled = true;

  const result = make('div', 'dresult');

  /**
   * Where a directory edit happens — M9-23.
   *
   * **Outside `body`, deliberately.** `paint()` replaces the list on every keystroke in the
   * search box, and a half-typed name in a form that lives inside the list would be wiped by
   * the operator's own typing. One container, several doors into it: the "Add an officer"
   * button on a department heading, and the two offers in the empty-search state.
   *
   * Below the send button, also deliberately. This is the screen somebody is on while a caller
   * is still on the line — administration is the second job here and must never sit between the
   * operator and "Tell them".
   */
  const tools = make('div', 'dtools');
  /** Always there once the list says this seat may edit — the standing door. */
  const toolsBar = make('div', 'dbar');
  /** Where a form is drawn. Cleared on cancel and on success; the bar above it is not. */
  const formHost = make('div', 'dformhost');
  tools.append(toolsBar, formHost);

  /**
   * The standing door — **a contact, not a department** (ADR-0029).
   *
   * It read *"Add a department"* and stood here permanently, which is the wrong offer twice
   * over now: departments are gone, and what an operator on a call actually needs is the
   * officer whose name is not in the list.
   */
  const addContact = make('button', 'dadd', 'Add a contact');
  addContact.type = 'button';
  toolsBar.appendChild(addContact);
  tools.hidden = true;

  root.appendChild(make('h2', '', 'Who should know?'));
  root.appendChild(note);
  root.appendChild(search);
  root.appendChild(body);
  root.appendChild(send);
  root.appendChild(tools);
  root.appendChild(result);

  //----------------------------------------------------------------------------
  // Adding to the directory, from the screen where the gap is found — M9-23
  //----------------------------------------------------------------------------

  /**
   * The client asked for departments and officers to be addable *in the app*, and they already
   * were — `POST /admin/departments` and `POST /roster/:id/people` have existed since M1a, and
   * the console has forms for both. **What did not exist was a way to reach them from the one
   * screen where somebody finds out they are needed.**
   *
   * That screen is this one. An operator on a call searches for an officer, the name is not
   * there, and the console is four navigations and a lost draft away — so what actually happens
   * is that they ring somebody from a personal handset, and the district's record of who was
   * told never comes into existence. The directory does not stay current because maintaining it
   * is a separate errand nobody is on their way to do.
   *
   * Nothing here is new authority. The server refuses exactly what it refused before (INV-05).
   */

  const canEdit = (): boolean => list?.canEditDirectory === true;

  /**
   * ⚠️ **`departmentsInList` AND `vacantPostsIn` WERE HERE AND ARE REMOVED — ADR-0029.**
   *
   * The first read `list.departments` — *where somebody can be filed*, kept deliberately apart
   * from `recipients` since 2026-08-22 because one is placement and the other is who may be
   * told. The second offered a department's empty posts when adding somebody, on the good
   * argument that the person being added is very often the answer to the vacancy already on
   * screen.
   *
   * Both questions stopped having answers: a contact is filed nowhere, and its designation is
   * created in the same breath as the person rather than chosen from posts that already exist.
   *
   * ⚠️ **`list.departments` is still SENT and is not removed from the type.** An older client
   * meeting this server keeps working, and the field is the record of a layer that existed —
   * the road ADR-0018, ADR-0022 and ADR-0023 all took.
   */

  function closeForms(): void {
    formHost.replaceChildren();
  }

  addContact.addEventListener('click', () => openPersonForm(null, ''));

  /**
   * Re-read the directory after an add, **keeping the selection**.
   *
   * Deliberately not `open()`. That re-applies `proposed` and `learned` into `chosen`, so an
   * operator who had removed a proposed department would watch it come back because they added
   * an unrelated officer — a selection changing itself while somebody is on a telephone call.
   * Nothing here touches `chosen`; the add already ticked whoever was added.
   */
  async function reloadDirectory(): Promise<void> {
    try {
      const res = await fetch(`/contacts/recipients?${lastQuery}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error('refused');
      list = (await res.json()) as RecipientList;
    } catch {
      /**
       * The add succeeded — the server answered 201 — and only the re-read failed. Saying
       * "could not add" here would be a lie that sends somebody to add them twice.
       */
      formHost.replaceChildren(
        make(
          'p',
          'dwarn',
          'They were added. This list could not be re-read, so they are not shown yet — ' +
            'reopen this report to see them.',
        ),
      );
      return;
    }
    tools.hidden = !canEdit();
    summarise();
    paint();
  }

  /** POST, and put the server's own refusal on the form rather than a sentence of our own. */
  async function sendJson<T>(path: string, payload: unknown, fail: (why: string) => void) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      fail('You are offline, so nothing was added. Ring them in the meantime.');
      return null;
    }
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      fail(parsed.error ?? `The server refused that (${String(res.status)}).`);
      return null;
    }
    return parsed as T;
  }

  /**
   * **Add a contact — ADR-0029, and it is the district's own sentence.**
   *
   *   > *"Mujhe simple phone ki tarha contact add karne ka option chahiye, jis mein main Name,
   *   >  phone, post/designation de sakta hoon."*
   *
   * Three fields, and nothing else to answer. It used to ask for a **department** and then, in
   * a second select, for one of that department's empty posts — and both questions have stopped
   * having an answer: the layer is gone, and a designation is now typed rather than chosen from
   * a list of things that already exist.
   *
   * ⚠️ **This is M9-23's own defect returning, and it would have been silent.** That form read
   * its department options out of the recipient list; ADR-0023 emptied that list once already
   * and *nobody could be added at all*. With ADR-0029 it empties for good — so the select would
   * have come back with one option reading *"Which department?"*, the submit would have refused
   * on `chosenDepartment() === null`, and the only door the district has to their own directory
   * would have looked broken rather than removed.
   *
   * `departmentId` is kept in the signature and ignored. Every caller still passes what it
   * passed, and a parameter list that changes under three call sites in the same commit as the
   * behaviour is two changes to review as one.
   */
  function openPersonForm(departmentId: string | null, prefill: string): void {
    void departmentId;
    closeForms();

    const form = make('form', 'dform');
    const heading = make('h3', '', 'Add a contact');
    form.appendChild(heading);

    const why = make('p', 'dwarn');
    why.hidden = true;

    const name = make('input', 'dfname');
    name.type = 'text';
    name.placeholder = 'Name';
    name.setAttribute('aria-label', 'Name');
    name.required = true;
    name.value = prefill;

    const phone = make('input', 'dfphone');
    phone.type = 'text';
    phone.placeholder = 'Phone number';
    phone.setAttribute('aria-label', 'Phone number');
    phone.required = true;

    /**
     * The designation, **typed** — not chosen from the posts that already exist.
     *
     * The old control offered a department's empty posts, which was right while a contact was
     * filed into one. A contact is a post and whoever holds it now (ADR-0023, ADR-0029), so the
     * post is being created in the same breath as the person and there is nothing to pick from.
     *
     * ⚠️ **Required, and the server refuses an empty one too.** A contact with no designation
     * has no row at all — the list IS designations — which is the surprise `describePlacement`
     * was written to prevent, arriving through a field somebody left blank.
     */
    const designation = make('input', 'dfpost');
    designation.type = 'text';
    designation.placeholder = 'Post or designation — AC HQ Bajaur';
    designation.setAttribute('aria-label', 'Post or designation');
    designation.required = true;

    const placement = make('p', 'note');

    /**
     * "Somebody with that name is already here" — M10-35.
     *
     * Live as they type rather than on submit, because it is advice about a decision they are
     * still making. Told afterwards it is not advice, it is a complaint about something already
     * done.
     *
     * ⚠️ **It never blocks.** Two officers in Bajaur share one handset, and this form is one of
     * only two ways the district's own roster is entered.
     *
     * The whole district is checked, not one department: this list is `/contacts/recipients`,
     * which is everyone the control room can tell. The roster's own form can only see its
     * department, and says so.
     */
    const duplicate = make('p', 'note dupe');
    duplicate.hidden = true;

    function checkDuplicate(): void {
      const known = (list?.recipients ?? [])
        .filter((r) => r.kind === 'person')
        .map((r) => ({ name: r.label, phone: r.phone }));
      const match = findDuplicate(name.value, phone.value, known);
      duplicate.hidden = match === null;
      duplicate.textContent = match === null ? '' : duplicateSentence(match, 'district');
    }

    /**
     * Say where they will actually appear, **before** the add — not after it.
     *
     * ⚠️ **Rewritten 2026-08-22, and the fact underneath it got sharper rather than merely
     * reworded.** It used to say an officer with no designation lands under *"No department"* and
     * that *"Tell all 8"* would miss them. Both halves are now false: there are no department
     * headings, and that control is gone (ADR-0023).
     *
     * What replaced them is worse for the operator and so matters more. **The list is
     * designations** — `listRecipients` returns one row per post — so somebody holding none has
     * **no row at all**. Not filed oddly: absent. That is exactly the surprise this sentence
     * exists to prevent, because finding it out afterwards looks precisely like the add having
     * gone wrong.
     */
    function describePlacement(): void {
      placement.textContent =
        designation.value.trim() === ''
          ? 'With no designation they will not be on this list at all — it is a list of ' +
            'designations. Give them one here.'
          : `They appear as “${designation.value.trim()}”, and can be told from this screen ` +
            'straight away.';
    }

    designation.addEventListener('input', describePlacement);
    describePlacement();

    const submit = make('button', 'dfsave', 'Add them');
    submit.type = 'submit';
    const cancel = make('button', 'dfcancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeForms);

    name.addEventListener('input', checkDuplicate);
    phone.addEventListener('input', checkDuplicate);
    // Run once: the name may be prefilled from what the operator already typed into the search.
    checkDuplicate();

    form.append(name, designation, phone, placement, duplicate, submit, cancel, why);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (
        name.value.trim() === '' ||
        designation.value.trim() === '' ||
        phone.value.trim() === ''
      ) {
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Adding…';
      void (async () => {
        /**
         * `/roster/contacts` — one call, one transaction (ADR-0029).
         *
         * It used to be `/roster/:department/people`, which needed a department in the path and
         * wrote the person into a post that already existed. The seat, the person and the duty
         * assignment are written together now: half of it succeeding would leave a post nobody
         * holds, which is the vacancy the district has just asked to stop seeing.
         */
        const created = await sendJson<{ seatId?: string; personId?: string }>(
          '/roster/contacts',
          {
            fullName: name.value.trim(),
            designation: designation.value.trim(),
            phone: phone.value.trim(),
          },
          (message) => {
            why.hidden = false;
            why.textContent = message;
          },
        );
        submit.disabled = false;
        submit.textContent = 'Add them';
        if (created === null) return;

        /**
         * Ticked, because telling them is why they were added — and **visibly** ticked, which
         * is the same rule "Tell all 8" follows. The repaint below is what makes it visible;
         * a selection the operator cannot see is one they did not make.
         *
         * 🔴 **KEYED ON THE SEAT, NOT THE PERSON, AND THE BROWSER TEST IS WHAT FOUND IT.**
         *
         * This ticked `person:<personId>` — correct when the endpoint was `/roster/:id/people`
         * and a person had a row of their own. Since ADR-0023 `listRecipients` returns **one row
         * per contact and it is `kind: 'post'`**, so that key matched nothing the picker draws:
         * the contact was created, appeared on the list, and sat **unticked** beside a form that
         * had just closed as though it had worked.
         *
         * Exactly the failure this project keeps paying for — the action succeeds — and no
         * server test could have seen it, because the server did everything right.
         */
        if (typeof created.seatId === 'string') chosen.add(`post:${created.seatId}`);
        closeForms();
        await reloadDirectory();
        send.disabled = chosen.size === 0 && pickedGroups.size === 0;
      })();
    });

    formHost.appendChild(form);
    form.scrollIntoView({ block: 'nearest' });
    name.focus();
  }

  /**
   * WARNING: openDepartmentForm WAS HERE AND IS REMOVED - ADR-0029.
   *
   * It posted to /admin/departments and then opened the officer form inside the department it
   * had just made, which was the right flow while a contact had to be filed into one. The
   * endpoint is untouched and still served; what went is the door, on the same road ADR-0018
   * took with the inbox and ADR-0022 with the routing editor.
   *
   * Left as a sentence rather than deleted silently, because the next person to look for it
   * will be looking for a bug.
   */

  /**
   * **When a department or a post earns a row of its own — M10-07, M10-08, M10-09.**
   *
   * The district's sentence: *"Only one name shall be appeared once."* One officer occupied up
   * to three rows — the department, the post they hold, and themselves — because all three were
   * drawn as peers. This is the one rule that collapses them, and all three tasks are the same
   * rule seen from different sides:
   *
   * | Row | Drawn when |
   * |---|---|
   * | **person** | always — this is the row the district reads |
   * | **post** | it is **unreachable**, or something is proposing it |
   * | **department** | something is proposing it. **Never merely to be selectable** |
   *
   * ## ⚠️ This is not `assertOfferedAnyway` being broken, and the difference is exact
   *
   * That rule says the **server** must never filter an unreachable recipient out of the list,
   * because hiding a vacancy hides it from the one person about to notice it, and a vacant post
   * must never swallow an obligation. **Every one of those still has a row here** — `unreachable`
   * is the first half of the post rule. What is withheld is a post whose holder is **reachable**,
   * and that holder is a person row three pixels below it, on the same handset. Nobody becomes
   * unreachable and no gap becomes invisible; one row stops being printed twice.
   *
   * ## The count on "Tell all N" was wrong before this, and this is what fixes it
   *
   * A department with four held posts drew **eight** rows, so the button read *Tell all 8* while
   * `collapseSelection` absorbed each person into the post they hold and **four** handsets were
   * told. Now the post rows and the person rows cannot overlap — the person query excludes
   * exactly the holders the post rule keeps (placeholder, disabled, no number) — so the number
   * on the button is the number of obligations recorded.
   *
   * ## Why a proposal forces the row rather than being re-pointed at somebody else
   *
   * `learned` is departments and posts and **never people**, deliberately — a model that learns
   * an individual wakes that individual nightly. It is pre-ticked into `chosen` on open.
   *
   * 🔴 **So a rule that simply stopped drawing those rows would tick them invisibly**, send to
   * them, and record it — with nothing on screen ever having shown a tick. That is this
   * project's worst signature: *the action succeeds*. It would also break M7-18, which requires
   * every proposal to say why **beside the tick**.
   *
   * Expanding a proposed department into its officers instead was refused: it changes what is
   * recorded from one seat-level obligation into eight person-level ones, and `learning.ts`
   * counts departments and posts, so the district's own habit would stop being counted and the
   * proposal would decay into nothing.
   *
   * ⚠️ **This had to be reasoned about rather than observed, and that has not changed.** It was
   * believed dormant because `routing_signal` was thought to hold 0 rows (R-04) — **a claim
   * this file made and nobody checked, and it was false**: the district had written one on
   * 2026-08-17, and it surfaced only when a migration refused to drop it. Signals are gone now
   * for real (ADR-0022), and
   * `learning.ts` needs five dispatches of one category before it says anything, so on a fresh
   * district this is still quiet on the day somebody reads it — and then switches itself on,
   * without anybody configuring or announcing it.
   */
  function drawnRows(rows: readonly Recipient[], spoken: ReadonlySet<string>): Recipient[] {
    /**
     * ⚠️ **Everything is drawn now, and the filter this replaces was load-bearing until
     * 2026-08-22.**
     *
     * M10-08 kept a **post** row off the screen whenever somebody reachable held it, because the
     * **person** row beside it was already reaching that handset — two rows for one officer, and
     * this chose which one to show. `listRecipients` no longer returns the person row: the post
     * **is** the contact, carrying the holder's name and number.
     *
     * So filtering here would now hide the officer entirely rather than de-duplicate them, which
     * is the one outcome this screen must never produce. `spoken` is still taken because the
     * caller has it and the signature is worth keeping stable for the fold below.
     */
    void spoken;
    return [...rows];
  }

  /**
   * Which departments have had their vacancies opened — M10-34.
   *
   * Closure state rather than a class on the DOM, because `paint()` replaces the list on every
   * keystroke and a fold that reset itself as the operator typed would be worse than no fold.
   */
  const opened = new Set<string>();

  function paint(): void {
    body.replaceChildren();
    if (list === null) return;

    const needle = filter.trim().toLowerCase();

    /**
     * Who the district's own history is saying something about, in one set.
     *
     * Read fresh on every paint rather than kept beside `chosen`: a proposal is a fact about the
     * report, and `chosen` is the operator's answer to it. Merging them would make an untick
     * look like the proposal having been withdrawn.
     */
    const spoken = new Set<string>([
      ...(list.proposed ?? []).map(key),
      ...(list.learned ?? []).map(key),
    ]);

    /**
     * Groups first, and the row is **the name and a count** — 2026-09-01.
     *
     * It used to list every member by name underneath the tick, on the M7-14 argument that a
     * group is never a black box. The owner read that on a real emergency and called it
     * *"buht bura"*: forty groups each unrolling five or ten names is a wall the operator scans
     * past to reach the checkbox they came for. So the visible row is `Flood · group · 6 members`
     * now, and the full list rides the row's `title` — the black-box concern is still answered
     * (hover reveals every name, and a group that quietly lost a member drops from 6 to 5 on the
     * face of the row) without the clutter.
     *
     * The members are **not** pre-ticked into `chosen`. The server expands the group at dispatch
     * time and records both the members and which group they came from (M7-10); ticking them
     * here as well would send the same six twice under two provenances and lose the fact that
     * the operator chose a group at all.
     */
    for (const group of list.groups ?? []) {
      if (
        needle !== '' &&
        !group.name.toLowerCase().includes(needle) &&
        !pickedGroups.has(group.groupId)
      ) {
        continue;
      }

      const id = `pick-group-${group.groupId}`;
      const row = make('label', 'dpick k-group');
      row.htmlFor = id;

      const tick = make('input', '');
      tick.type = 'checkbox';
      tick.id = id;
      tick.checked = pickedGroups.has(group.groupId);
      tick.addEventListener('change', () => {
        if (tick.checked) pickedGroups.add(group.groupId);
        else pickedGroups.delete(group.groupId);
        send.disabled = chosen.size === 0 && pickedGroups.size === 0;
        summarise();
      });

      row.appendChild(tick);
      if (typeof group.picture === 'string' && group.picture.startsWith('data:image/')) {
        const pic = make('img', 'davatar');
        pic.src = group.picture;
        pic.alt = '';
        row.appendChild(pic);
      }
      row.appendChild(make('span', 'dlabel', group.name));
      row.appendChild(make('span', 'dkind', 'group'));
      const count = group.members.length;
      const who = make(
        'span',
        'dwho',
        count === 0
          ? 'empty — nobody would be told'
          : `${String(count)} member${count === 1 ? '' : 's'}`,
      );
      // The names are still one hover away — the black-box concern (M7-14), without the wall.
      if (count > 0) who.title = group.members.map((m) => nameOfMember(m)).join(', ');
      row.appendChild(who);
      // An empty group is marked like an unreachable post, and for the same reason: it is
      // selectable, it records nothing, and the operator has to be able to see that.
      if (group.members.length === 0) row.classList.add('unreachable');

      body.appendChild(row);
    }

    /**
     * **"Usually told" — M10-37. A hint, and never a decision.**
     *
     * `learning.ts` has proposed for a milestone and its proposals were only ever visible
     * **beside the tick**, which is right (M7-18: every proposal says why) and is not enough:
     * the row can be the fortieth of eighty, inside a 22rem scroller, and the operator has to
     * scroll past everything to find out the software already made a choice for them. A
     * pre-selection somebody has not seen is a pre-selection they cannot disagree with.
     *
     * So this says, at the top and before any scrolling: **who is already ticked, and why.**
     * The sentence comes from the server — `learned.because` carries both numbers rather than a
     * percentage, because *"90%"* reads identically at nine-of-ten and ninety-of-a-hundred.
     *
     * **It ticks nothing and unticks nothing.** Every name in it is already in `chosen`; the
     * band is a window onto that, so an operator who unticks a row watches it leave here too.
     * Clicking a name scrolls to its row — the shortest path from *"the software chose Rescue"*
     * to *"and I disagree"*, which is the only reason this exists.
     *
     * **Hidden when there is nothing to say**, never rendered as *"usually told: nobody"*. A
     * band that is always there and usually empty is one people stop reading. Since ADR-0022 the
     * district's own dispatch history is the only thing that can fill it.
     */
    const hints = [...(list.proposed ?? []), ...(list.learned ?? [])].filter((t) =>
      chosen.has(key(t)),
    );

    if (hints.length > 0 && needle === '') {
      const band = make('div', 'dhint');
      band.appendChild(make('h3', '', 'Already ticked for you'));

      for (const t of hints) {
        const found = list.recipients.find((r) => r.kind === t.kind && r.id === t.id);
        const learned = list.learned?.find((l) => l.kind === t.kind && l.id === t.id);

        const line = make('button', 'dhintrow');
        line.type = 'button';
        line.dataset['pick'] = key(t);
        line.appendChild(make('span', 'dlabel', found?.label ?? t.id));
        /**
         * A fallback sentence, for a tick whose reason the server did not send.
         *
         * It named the routing signal that matched until ADR-0022. It can only be reached now
         * by a cached `proposed` from an older response, and *"suggested"* with no number is
         * exactly the unarguable pre-selection M7-18 forbids — so it says so plainly rather
         * than inventing a reason it does not have.
         */
        line.appendChild(
          make('span', 'dhintwhy', learned?.because ?? 'suggested — reason not recorded'),
        );
        line.addEventListener('click', () => {
          // The row may be folded away or filtered out; `scrollIntoView` on nothing is a click
          // that silently does nothing, which is worse than not offering it.
          const target = body.querySelector(
            `#pick-${t.kind}-${t.id}-${found?.departmentId ?? 'none'}`,
          );
          target?.closest('.dpick')?.scrollIntoView({ block: 'center' });
        });
        band.appendChild(line);
      }

      body.appendChild(band);
    }

    /**
     * Grouped by department, because that is how the district is organised and how an operator
     * thinks: *"tell Rescue"* then *"and the DEO"*. A flat list of 79 offices, 81 posts and 40
     * officers is unusable at 02:00.
     */
    const groups = new Map<string, { name: string; rows: Recipient[] }>();

    /** The one section every contact goes in. See the note at the push below. */
    const ALL = 'all';

    /**
     * **Search the whole row, not just the name — M10-06.**
     *
     * This matched `label` alone, which for a person is their name and nothing else. So typing
     * *"DHO"* or *"Health"* found **nobody**, on a box whose own placeholder promises
     * *"departments, designations and officers"*. An operator at 02:00 usually knows the post
     * they want and not the name of whoever holds it tonight — which is the search this screen
     * is most often asked for and the one it could not do.
     */
    const matches = (r: Recipient): boolean =>
      [r.label, r.designation, r.departmentName, r.holderName].some(
        (field) => field !== null && field.toLowerCase().includes(needle),
      );

    for (const r of list.recipients) {
      if (needle !== '' && !matches(r)) {
        // Kept when it is already ticked. A search that hides somebody's own selection is how
        // a selection gets silently un-made.
        if (!chosen.has(key(r))) continue;
      }
      /**
       * 🔴 **ONE LIST, NOT A SECTION PER DEPARTMENT — 2026-08-22.**
       *
       * This grouped by `departmentId`, which drew **79 headings** down the picker for a
       * district of 40 handsets. The district's report was *"names bhi aa jate hain aur
       * department bhi aa jate hain … bahut confusion ho jati hai"* — and they were describing
       * the model, not the markup: the server returned a department row, a post row and a
       * person row for one officer, and this loop then filed them under a heading that was the
       * designation said a second time (`ADC (General)` over `ADC (G) Bajaur`).
       *
       * `listRecipients` now returns **one contact per designation**, so there is nothing left
       * to group by. The constant key is deliberate rather than a stub: it keeps the section
       * chrome, the vacancy fold and the search below exactly as they were, and it is the one
       * line to change if the district ever asks for headings again.
       */
      const group = groups.get(ALL) ?? { name: '', rows: [] };
      group.rows.push(r);
      groups.set(ALL, group);
    }

    for (const [groupId, group] of groups) {
      const section = make('div', 'dgroup');
      // No heading: one list, and a heading over the only section is a word that says nothing.
      if (group.name !== '') section.appendChild(make('h3', '', group.name));

      /**
       * ⚠️ **"TELL ALL 8" IS GONE, AND ITS ARGUMENT IS WHY — 2026-08-22.**
       *
       * M9-20 built it from the client's own words: *"sirf department par click kar ke us
       * department ke officers ko auto-selected rakh kar message bheja ja sake."* It ticked
       * every officer in **one department's** section, and its long-standing warning was that it
       * must never tick the department row itself, or `collapseSelection` would absorb all eight
       * back into it and reach the single duty seat while eight ticks sat on the screen.
       *
       * There are no department sections left. On one flat list this control becomes **"Tell all
       * 40"** — the whole district in a click, next to the checkbox somebody is aiming for at
       * 02:00. That is not the sentence M9-20 was asked for; it is a way to alert Bajaur by
       * accident.
       *
       * **What replaces it is what the district asked for in the same breath:** *"humein agar
       * zaroorat hai to Groups ki hai — group mein mukhtalif department ke log add ho sakte hain,
       * department mein nahi."* A saved group is a named set somebody chose, it is offered above
       * this list, and it is the honest form of *tell all of them*.
       */
      const drawn = drawnRows(group.rows, spoken);

      /**
       * **Add somebody to this department, from here — M9-23.**
       *
       * Beside "Tell all 8" because it answers the sentence that control is about to make
       * false: *tell all of them* is only true if all of them are on the list. The operator
       * looking at a department with two officers in it, who knows there are five, is the
       * person best placed to fix that and the least likely to leave the screen to do it.
       *
       * Not offered for "No department" — those recipients hold no post anywhere, so there is
       * no roster to add to. `POST /roster/none/people` would be a 404 dressed as a button.
       */
      /**
       * **Add somebody from here — M9-23, and it now opens with nothing pre-chosen.**
       *
       * The door stays exactly where it was and for the reason it was cut: the picker is where a
       * gap in the directory is *discovered*, and an operator who has to leave this screen to fix
       * one rings somebody from a personal handset instead — which is the record not existing.
       *
       * ⚠️ **`null`, not `groupId`.** It used to hand the section's department straight to the
       * form, and with one flat section `groupId` is the literal `'all'` — an id no department
       * has. `openPersonForm` already takes `null` and already asks where the person goes, so the
       * form is the one place that question is answered.
       */
      if (canEdit()) {
        const add = make('button', 'dadd', 'Add an officer');
        add.type = 'button';
        add.title = 'Add somebody to the directory';
        add.addEventListener('click', () => openPersonForm(null, ''));
        section.appendChild(add);
      }

      /**
       * **Vacancies fold into one line — M10-34.**
       *
       * M10-08 leaves a post row standing only when nobody reachable holds it, and **38 of
       * Bajaur's 82 posts are vacant** (M10-05). In the worst department that is a column of grey
       * rows above the officers somebody is actually trying to reach — the gap shouting so
       * loudly that it buries the answer.
       *
       * **The count is never folded away, only the rows.** *"3 designations vacant — show"* is
       * still the district's cover gap stated as a number on the screen, which is what
       * `assertOfferedAnyway` and ADR-0005 are for: a vacancy nobody can see is a vacancy nobody
       * fills, and a vacant post that quietly swallows an obligation produces silence — and
       * silence reads as *everybody was told*.
       *
       * ⚠️ **A chosen row is never hidden**, and that guard is not a nicety. *Tell all N*
       * deliberately ticks vacant posts (M9-22: recorded as owed a message, warned about before
       * the send), so folding them after the tick would put ticks on the screen that cannot be
       * seen or undone — the invisible-selection fault M10-09 was written about, arriving from
       * the other direction. The same rule the search filter already follows.
       */
      let pendingFold: HTMLButtonElement | null = null;
      const foldable = drawn.filter((r) => r.kind === 'post' && r.unreachable === 'vacant');
      const anyChosen = foldable.some((r) => chosen.has(key(r)));
      const showVacant = opened.has(groupId) || anyChosen || needle !== '';
      const visible = showVacant ? drawn : drawn.filter((r) => !foldable.includes(r));

      if (!showVacant && foldable.length > 0) {
        const fold = make('button', 'dfold');
        fold.type = 'button';
        fold.textContent =
          foldable.length === 1
            ? '1 designation vacant — show'
            : `${String(foldable.length)} designations vacant — show`;
        fold.title = 'Nobody holds these. They can still be told, and it will be recorded as owed';
        fold.addEventListener('click', () => {
          opened.add(groupId);
          paint();
        });
        // Appended AFTER the rows, below. Above them it would be the same wall of vacancies
        // in one line, still sitting between the operator and the officers they came for.
        pendingFold = fold;
      }

      for (const r of visible) {
        /**
         * **The DOM id carries the department, and the tick key deliberately does not.**
         *
         * An officer serving two departments is two rows now (M10-06). `key()` is still
         * `kind:id`, because ticking either row must tell **one handset once** — that is
         * `collapseSelection`'s whole job and nothing about it changes here.
         *
         * ⚠️ **But `id` had to change, and forgetting it is a silent fault.** Two rows sharing
         * one `id` makes `<label for>` resolve to the **first** match, so clicking the C&W
         * Highways row would toggle the C&W Buildings checkbox — the operator ticks a row and
         * watches a different row tick. Nothing errors and the right person is still told.
         */
        const id = `pick-${r.kind}-${r.id}-${r.departmentId ?? 'none'}`;
        const row = make('label', `dpick k-${r.kind}`);
        row.htmlFor = id;

        const tick = make('input', '');
        tick.type = 'checkbox';
        tick.id = id;
        tick.dataset['pick'] = key(r);
        tick.checked = chosen.has(key(r));
        tick.addEventListener('change', () => {
          if (tick.checked) chosen.add(key(r));
          else chosen.delete(key(r));
          // The person's other rows are the same tick. Left alone they sit unticked while the
          // selection holds them — a screen disagreeing with what is about to be sent.
          body
            .querySelectorAll<HTMLInputElement>(`input[data-pick="${key(r)}"]`)
            .forEach((other) => {
              other.checked = tick.checked;
            });
          /**
           * **And the "already ticked for you" band lets go of them — M10-37.**
           *
           * The band is drawn by `paint()`, and a tick does not repaint (that would rebuild the
           * list under the operator's pointer mid-selection). Without this the band goes on
           * naming somebody who has just been removed — **a band describing a send that is not
           * going to happen**, which is worse than no band, because its whole promise is that it
           * shows what is about to be sent without scrolling.
           */
          syncHints(key(r), tick.checked);
          send.disabled = chosen.size === 0 && pickedGroups.size === 0;
          summarise();
        });

        row.appendChild(tick);
        /**
         * **Name first, designation beneath — a phone's contact list, 2026-09-01.**
         *
         * The district asked for the row to read *Name, post, phone* — the way a handset shows a
         * contact. A `post` row carries its holder's name, so when a real officer holds it that
         * name is the label and the designation drops to a quieter line under it (like `.dnum`).
         * A **vacant or stand-in** post has no real person to name, so it keeps the designation
         * as the label — there is nothing better to put there, and it is already sitting under a
         * "No department" heading. A `person` row was already name-first (M10-06).
         */
        const heldByReal =
          r.kind === 'post' &&
          r.holderName !== null &&
          r.holderName.trim() !== '' &&
          r.unreachable !== 'placeholder';
        const primary = heldByReal && r.holderName !== null ? r.holderName : r.label;
        row.appendChild(make('span', 'dlabel', primary));
        /**
         * ⚠️ **`designation`, not `post` — M10-36 renamed this everywhere and missed this chip.**
         * The district does not say *post*, and a screen that says it in one place and
         * *designation* in four others is teaching two words for one thing. The chip follows what
         * the label now is: a name reads as an *officer*, a bare designation as a *designation*.
         */
        row.appendChild(
          make(
            'span',
            'dkind',
            r.kind === 'department'
              ? 'department'
              : heldByReal || r.kind === 'person'
                ? 'officer'
                : 'designation',
          ),
        );
        /**
         * **The designation, on its own line beneath the name.**
         *
         * For a held post that is `r.label` (the seat title); for a `person` row it is
         * `r.designation`. Never drawn when it would just repeat the label — a vacant post has
         * only its designation and that is already the label above.
         */
        const secondary = heldByReal ? r.label : r.kind === 'person' ? r.designation : null;
        if (secondary !== null && secondary.trim() !== '') {
          row.appendChild(make('span', 'ddesig', secondary));
        }
        /**
         * **The number, small, on its own line beneath the name — M10-38.**
         *
         * The district asked for it and it is the one thing on this screen an operator sometimes
         * needs to read out loud: the API is down, and *"Reach them"* is the whole system (the
         * standing rule kept from the 2026-08-03 reversal). Hunting for it on another screen at
         * 02:00 is how a district goes back to a personal handset and the record stops existing.
         *
         * **It also makes a shared handset visible.** a shared office number can be Officer Alpha's *and* Officer
         * Aziz's — confirmed in the live directory (M10-05), and the reason
         * `collapseSelection` must never deduplicate by number. Two rows carrying one number is a
         * fact the operator can now see for themselves rather than being told about afterwards.
         *
         * Silent when there is none: the row already says why in `.dwarn`, and an empty line
         * where a number should be reads as a fault rather than as a vacancy.
         */
        if (r.kind !== 'department' && r.phone !== null && r.phone.trim() !== '') {
          row.appendChild(make('span', 'dnum', r.phone));
        }
        // A stand-in post still names its placeholder holder, since it is not the label there.
        if (r.holderName !== null && r.kind === 'post' && !heldByReal) {
          row.appendChild(make('span', 'dwho', r.holderName));
        }
        if (r.unreachable !== null) {
          // Marked, never removed, and never disabled. See the header.
          row.classList.add('unreachable');
          row.appendChild(make('span', 'dwarn', WHY[r.unreachable] ?? r.unreachable));
        }

        /**
         * **Every proposal says why** — M7-18.
         *
         * *"you told them for 9 of the last 10 fire reports"*, in words, beside the tick. A
         * silent pre-tick is a rule nobody can audit or disagree with, and an operator who
         * cannot see why the software chose somebody has no way to tell a good habit from one
         * bad Tuesday that repeated itself.
         *
         * The sentence is built on the server so the intake screen, the console and any later
         * report cannot each round the same two numbers differently.
         */
        const why = list.learned?.find((l) => l.kind === r.kind && l.id === r.id);
        if (why !== undefined) {
          row.classList.add('learned');
          row.appendChild(make('span', 'dlearn', why.because));
        }

        section.appendChild(row);
      }

      if (pendingFold !== null) section.appendChild(pendingFold);

      body.appendChild(section);
    }

    if (body.childElementCount === 0) {
      const typed = filter.trim();
      body.appendChild(
        make(
          'p',
          'cnone',
          typed === '' ? 'Nobody is in the directory yet.' : `Nothing matches “${typed}”.`,
        ),
      );

      /**
       * **The dead end becomes the door — M9-23.**
       *
       * This is the exact moment the client's request is about: somebody typed a name at 02:00
       * and the district does not have it. Until now the screen said "nothing matches" and
       * stopped, so the officer got rung from a personal handset and the record of it never
       * existed. The name they typed is carried into the form — they have already told us who
       * is missing, and asking them to type it a second time is how a good offer gets declined.
       */
      /**
       * ⚠️ **ONE OFFER NOW, NOT TWO — ADR-0029.** *"Add a department"* stood beside this and has
       * gone with the layer. A door onto a thing the district has just been told does not exist
       * is the screen arguing for the old model, which is this project's own most expensive
       * recurring failure: a re-aim is finished when nothing on any screen still says otherwise,
       * not when it compiles. `POST /admin/departments` is untouched and still served.
       */
      if (canEdit()) {
        const offer = make('div', 'doffer');
        const person = make('button', 'dadd', 'Add a contact');
        person.type = 'button';
        person.addEventListener('click', () => openPersonForm(null, typed));
        offer.appendChild(person);
        body.appendChild(offer);
      }
    }
  }

  function summarise(): void {
    if (list === null) return;

    /**
     * Measured against **what was proposed**, which since ADR-0022 is the learned set alone.
     *
     * `proposed` was the configured signals and is never sent now; it is still folded in, at
     * `?? []`, so a cached older response measures against what it was actually shown.
     */
    const proposedKeys = new Set([...(list.proposed ?? []), ...(list.learned ?? [])].map(key));
    const added = [...chosen].filter((k) => !proposedKeys.has(k)).length;
    const dropped = [...proposedKeys].filter((k) => !chosen.has(k)).length;

    /**
     * Says what the operator changed about the proposal, not just how many are ticked.
     *
     * The count alone is the least useful sentence available. "Two suggested, you added one and
     * removed one" is what tells somebody they have actually looked — and over a month it is
     * what tells the district whether the suggestions are worth having at all.
     */
    const parts = [`${String(chosen.size)} selected`];
    if (pickedGroups.size > 0)
      parts.push(`${String(pickedGroups.size)} group${pickedGroups.size === 1 ? '' : 's'}`);
    // One sentence, not two. There were two proposers and they answered two different
    // questions — is the configuration any good, and has the system learned anything — and
    // since ADR-0022 there is one, so saying it twice would double-count the same ticks.
    if ((list.learned ?? []).length > 0) {
      parts.push(`${String((list.learned ?? []).length)} from what you usually do`);
    }
    if (added > 0) parts.push(`${String(added)} you added`);
    if (dropped > 0) parts.push(`${String(dropped)} you removed`);

    note.textContent = parts.join(' · ');
  }

  search.addEventListener('input', () => {
    filter = search.value;
    paint();
  });

  send.addEventListener('click', () => {
    void (async () => {
      if (incidentId === null || (chosen.size === 0 && pickedGroups.size === 0)) return;

      send.disabled = true;

      /**
       * The attachment first, and the button says so.
       *
       * A button that reads "Telling them…" for eight seconds while a photograph uploads is a
       * button an operator presses again, or gives up on. This names the wait.
       */
      if (beforeSend !== undefined) {
        send.textContent = 'Sending the file first…';
        try {
          await beforeSend();
        } catch {
          // A file that could not be sent must never stop the district telling anybody. The
          // picker that owns the upload has already said what happened, in its own words.
        }
      }

      send.textContent = 'Telling them…';

      const targets = [...chosen].map((k) => {
        const [kind, id] = k.split(':');
        return { kind, id };
      });

      try {
        const res = await fetch(`/incidents/${incidentId}/dispatch-to`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            targets,
            // Ids, not members. The server expands them and writes down both what it expanded
            // and what it expanded to, so the record says the operator ticked "Flood" rather
            // than showing six departments that arrived from nowhere (M7-10).
            groups: [...pickedGroups],
            proposed: list?.proposed ?? [],
            // Separately from `proposed`, always. One measures the district's configuration
            // and the other its habit, and a merged number tells them nothing about either.
            learned: (list?.learned ?? []).map((l) => ({ kind: l.kind, id: l.id })),
          }),
        });

        const reply = (await res.json()) as { outcomes?: Outcome[]; error?: string };

        if (!res.ok) {
          /**
           * A 404 here almost always means one specific thing, and the generic message would
           * send an operator hunting for the wrong problem.
           *
           * Intake writes to the outbox and syncs afterwards (ADR-0002), so on a bad connection
           * the report is safe on this device and **not yet on the server** — which is exactly
           * what "no such incident" says from the server's point of view. The report is not
           * lost and the operator must not be told it is.
           */
          result.replaceChildren(
            make(
              'p',
              'cnone',
              res.status === 404
                ? 'The report has not reached the server yet, so nobody can be told through it. ' +
                    'It is saved on this device and will send itself — ring them in the meantime.'
                : (reply.error ?? 'Could not record who should know.'),
            ),
          );
          return;
        }

        showOutcomes(reply.outcomes ?? []);
        onDispatched?.(incidentId);
      } catch {
        result.replaceChildren(
          make(
            'p',
            'cnone',
            'You are offline, so nobody has been told. This is not queued — try again once you ' +
              'have a connection, and ring them in the meantime.',
          ),
        );
      } finally {
        send.textContent = 'Tell them';
        send.disabled = chosen.size === 0 && pickedGroups.size === 0;
      }
    })();
  });

  function showOutcomes(outcomes: readonly Outcome[]): void {
    result.replaceChildren();

    const told = outcomes.filter((o) => o.coveredBy === null);
    const absorbed = outcomes.filter((o) => o.coveredBy !== null);

    result.appendChild(
      make('p', 'dtold', `Told: ${told.map((o) => o.label).join(', ') || 'nobody'}`),
    );

    for (const o of told) {
      if (o.unreachable === null) continue;
      /**
       * The obligation was recorded and nothing reached anybody, and the screen says both.
       *
       * This is the sentence that stops the district believing somebody was told. It is also
       * what sends the operator to the telephone — which is the correct next action, and the
       * one the paper register used to get right by accident.
       */
      result.appendChild(
        make(
          'p',
          'dwarn',
          `${o.label}: ${o.unreachable}. Recorded as owed, and unmet — ring them.`,
        ),
      );
    }

    for (const o of absorbed) {
      result.appendChild(
        make(
          'p',
          'note',
          `${o.label} is already covered by ${o.coveredBy?.label ?? 'another selection'}.`,
        ),
      );
    }
  }

  return {
    reset(): void {
      incidentId = null;
      list = null;
      chosen.clear();
      pickedGroups.clear();
      filter = '';
      search.value = '';
      body.replaceChildren();
      result.replaceChildren();
      note.textContent = '';
      send.disabled = true;
      closeForms();
      tools.hidden = true;
    },

    async open(id, draft): Promise<void> {
      incidentId = id;
      chosen.clear();
      pickedGroups.clear();
      result.replaceChildren();
      body.replaceChildren(make('p', 'note', 'Loading the district…'));

      const query = new URLSearchParams({
        category: draft.category,
        description: draft.description,
      });
      lastQuery = query.toString();
      closeForms();

      try {
        const res = await fetch(`/contacts/recipients?${query.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          body.replaceChildren(make('p', 'cnone', 'Could not load who you can tell.'));
          return;
        }
        list = (await res.json()) as RecipientList;
      } catch {
        body.replaceChildren(
          make(
            'p',
            'cnone',
            'You are offline. The report is saved, but who to tell cannot be chosen until you ' +
              'have a connection.',
          ),
        );
        return;
      }

      /**
       * 🔴 **NOTHING IS PRE-TICKED THAT THIS SCREEN CANNOT DRAW — 2026-08-22.**
       *
       * A tick with no row is the worst thing this panel can do, and M10-09 is the whole
       * argument: it sends, it records, and it shows **no tick anybody could have disagreed
       * with**. This project's worst signature — *the action succeeds*.
       *
       * It became reachable the moment the directory went flat. `learning.ts` proposes out of the
       * district's own dispatch history, and every dispatch made before today is
       * **department-kinded** — so on a district with five nights of history behind it, opening
       * the picker would pre-tick a department that has not had a row since this morning.
       *
       * New history is post-kinded and will propose contacts, so this drains by itself. Until it
       * does, a proposal the operator cannot see is a proposal they cannot refuse, and it is
       * dropped rather than carried.
       */
      const drawable = new Set(list.recipients.map(key));

      // The proposal, pre-ticked. Not applied — the operator can remove every one of them, and
      // what they end up with is what gets recorded (M6-07).
      for (const t of list.proposed ?? []) if (drawable.has(key(t))) chosen.add(key(t));
      // And what the district's own history says — M7-16/17. Pre-ticked, never applied: the
      // operator can remove every one, and what they end up with is what gets recorded.
      for (const t of list.learned ?? []) if (drawable.has(key(t))) chosen.add(key(t));

      // Only now, from the server's own answer. Drawn before the list arrives it would be a
      // door offered to a seat the server is about to refuse (M9-23).
      tools.hidden = !canEdit();

      send.disabled = chosen.size === 0 && pickedGroups.size === 0;
      summarise();
      paint();
    },
  };
}

//------------------------------------------------------------------------------
// "Who was told" — M6-08
//------------------------------------------------------------------------------

export interface ToldEntry {
  attemptId: string;
  seatId: string | null;
  personId?: string;
  departmentId?: string;
  reason: string;
  state: 'pending' | 'delivered' | 'failed';
  failure?: string;
  /** How we know — `link`, `reply`, `operator`, `provider`. Absent on older attempts. */
  via?: string;
  /** What they said, when an operator heard it and typed it in. */
  said?: string;
  /**
   * **The words this recipient actually got** — 2026-08-24, from `message_sent`.
   *
   * The board's row shows the district's latest message once; this is per attempt, which is the
   * question the window exists to answer. An incident told twice was told two different things
   * — the second time about a reassessed severity or a corrected place — and a panel that
   * showed one sentence over both would be flattening the difference somebody opened it for.
   *
   * ⚠️ **Absent means UNKNOWN, never "nothing was sent"** — see `NotificationAttempt.sent` on
   * the server. Nothing before 2026-08-23 carries one and none can be reconstructed, so the row
   * says *not recorded* rather than drawing a blank somebody would read as silence.
   */
  sent?: { what: string; where: string };
  attemptedAt: string;
}

/** What the operator is recording about one recipient — M7-05/07. */
export type RecordOutcome = 'confirmed' | 'could_not_reach';

/**
 * The three routes that mean somebody answered, and the one that does not.
 *
 * `provider` is Meta reporting that a handset received the message. The ledger settles the
 * attempt on it — the message did arrive — but **nobody decided anything**, and the panel says
 * so in words, because an operator reading "delivered" as "they know" is the exact failure
 * ADR-0014 refuses to build on. It is also why a delivered-by-provider row keeps its controls:
 * ringing to find out whether anyone actually read it is the right next move.
 */
const ANSWERED: readonly string[] = ['link', 'reply', 'operator'];

/**
 * What the incident can say about who was told — the receiving half of the whole feature.
 *
 * Three states, rendered as three different sentences, because collapsing them is the failure
 * INV-03 names. **"Waiting" is not "told"**: an attempt stays pending until the recipient's own
 * client collects it, and a screen that renders queued as delivered is telling the control room
 * an officer knows about an emergency when nothing has established that.
 *
 * `contactsOpened` is rendered underneath and worded so it cannot be read as a conversation.
 * Somebody opened WhatsApp. That is all anyone knows (ADR-0014).
 *
 * **M7-08 adds the missing half.** Until it did, this panel could only report what the software
 * had observed — so the forty telephone calls an operator makes in a day reached the record as
 * nothing at all, and every obligation they had personally closed sat here for ever as somebody
 * nobody had told. `record` is how what the operator heard gets in, and it is rendered as **the
 * operator's statement**, never as the software having seen anything.
 */
export function renderWhoWasTold(
  target: HTMLElement,
  state: {
    notifications: ToldEntry[];
    dispatchedTo: { kind: string; id: string }[];
    dispatchAbsorbed: {
      target: { kind: string; id: string };
      coveredBy: { kind: string; id: string };
    }[];
    contactsOpened: { at: string; channel: string; label: string | null }[];
    /**
     * What kind of thing this is — Phase D. **Optional, and absent is not `emergency`.**
     *
     * This panel is built by a bundle fetched at runtime, so it can meet a server older than
     * itself. An absent kind means *this server does not send one*, and the honest answer there
     * is to draw no tally at all rather than to assert a kind nobody told us.
     */
    kind?: string;
    /**
     * 🔴 **Every time the control room chased this** — D-2, 2026-08-25.
     *
     * This panel exists to answer *who was told and what came back*, and until today it did
     * not mention follow-ups **at all** — so an operator reading it could not tell a silence
     * nobody had chased from one that had been chased three times. Those are opposite
     * situations and they were rendered identically.
     *
     * ⚠️ **Optional, because this bundle can meet a server older than itself.** Absent means
     * *this server does not send them*, and the honest answer is to say nothing rather than
     * to draw *never chased* over an incident that may well have been.
     */
    followUps?: { at: string; note: string; delivered: boolean }[];
  },
  name: (t: { kind: string; id: string }) => string,
  /**
   * Record what the operator was told. Omitted where there is nothing to record against — a
   * closed incident, or a build of this panel used for display only.
   */
  record?: (attemptId: string, outcome: RecordOutcome, said: string) => Promise<void>,
  /**
   * 🔴 **The saved groups a dispatch on this incident expanded** — Case 3, 2026-09-10.
   *
   * `api/dispatch.ts` `expand()` dissolves a ticked group into loose recipients before the
   * selection is validated, so `dispatchedTo` has no idea a group was ever ticked. This is the
   * name read back off `dispatched.payload.fromGroups` (`domain/recipientGroups.ts`), so this
   * panel can head the recipients with *"All Tehsildars — 6 of 8 responded"* and list anybody
   * chosen by hand beneath.
   *
   * ⚠️ **Absent / empty means tell it flat** — an incident dispatched by hand, and a server
   * that predates this. Display only: nothing here is in `IncidentState`, and grouping the rows
   * changes not one of the tallies above them.
   */
  recipientGroups: {
    groupId: string;
    name: string;
    members: { kind: string; id: string }[];
  }[] = [],
): void {
  target.replaceChildren();

  if (state.dispatchedTo.length === 0) {
    /**
     * Said plainly, and not left blank.
     *
     * An empty panel reads as "nothing to report". This is the opposite: nobody has been chosen
     * to be told, which before M6 was true of every emergency in the district and is the single
     * thing this milestone measures (ADR-0005 — the absence is the signal).
     */
    target.appendChild(
      make('p', 'cnone', 'Nobody has been told about this yet. Choose who should know.'),
    );
    return;
  }

  /**
   * The tally sits **above** the rows, and that placement is the feature.
   *
   * A reader looking for *"who is coming on Thursday"* wants the number; a reader chasing one
   * officer wants the row. Putting the count under twelve rows makes the first reader scroll past
   * the answer to find it, on the panel that exists to give it to them.
   */
  renderAttendance(target, state.kind, state.notifications);

  const dispatched = state.notifications.filter((n) => n.reason === 'dispatched');

  /**
   * **17 told · 9 confirmed · 8 silent** — M7-26.
   *
   * The line a control room stares at during a flood, and the reason it is three numbers rather
   * than one. *Told* is what the district did; *confirmed* is what came back; *silent* is the
   * gap, and the gap is the only one of the three anybody can act on. A single "9/17" makes
   * somebody do the subtraction, and at 02:00 they will not.
   *
   * **Confirmed counts the three acknowledgement routes and not a provider's delivery**
   * (M7-30). A message Meta says reached a handset that nobody answered is *silent*, because
   * that is what it is — and putting it in the confirmed column would be the read-receipt
   * failure ADR-0014 exists to prevent, arriving through a summary line.
   */
  if (state.dispatchedTo.length > 0) {
    const told = state.dispatchedTo.length;
    const confirmed = dispatched.filter((n) => ANSWERED.includes(n.via ?? '')).length;
    const owned = ownershipOf(dispatched);

    /**
     * ⚠️ **The three-number tally is for a room reading many rows at once.**
     *
     * With a single recipient it reads `1 told · 1 confirmed · 0 silent` — the one row
     * directly below already carries every one of those facts and their name besides, so
     * the line is nothing but noise the district asked us to take out (2026-09-04). It
     * returns the moment there is more than one recipient, because then the subtraction
     * it saves is real. The chase line and the ownerless flag are NOT gated on the count
     * — a single-recipient incident can be chased or left unheld just the same.
     */
    if (told > 1) {
      const line = make('p', 'ackline');
      line.append(
        make('b', 'ackn', String(told)),
        document.createTextNode(' told · '),
        make('b', 'ackn ok', String(confirmed)),
        document.createTextNode(' confirmed · '),
        make('b', `ackn ${told - confirmed > 0 ? 'silent' : ''}`, String(told - confirmed)),
        document.createTextNode(' silent'),
      );

      /**
       * 🔴 **And how many of those confirmations were somebody saying they cannot** — the
       * district's response workflow, 2026-08-24.
       *
       * Without this segment the line above reads `4 told · 4 confirmed · 0 silent` over a fire
       * two officers declined and nobody picked up — every number green, and every number true.
       * *Told* and *confirmed* answer *did the message land and did anybody reply*; neither of
       * them answers **is anybody going**, which is the question a control room is actually
       * asking at 02:00.
       *
       * ⚠️ **Drawn only when somebody has declined.** A fourth number reading `0 unable` on
       * every emergency in the district is a number that stops being read, and then the one
       * that matters is not read either — INV-08's alert fatigue, arriving in a summary line.
       */
      if (owned.declined > 0) {
        line.append(
          document.createTextNode(' · '),
          make('b', 'ackn unheld', String(owned.declined)),
          document.createTextNode(' unable'),
        );
      }

      target.appendChild(line);
    }

    /**
     * 🔴 **Nobody is holding this**, said in words directly under the numbers.
     *
     * The numbers are the evidence and this is the conclusion, and a control room at 02:00 needs
     * the conclusion. It appears only when **every** officer who answered declined — while
     * anybody at all is holding it, there is nothing to reassign and this sentence would be
     * false.
     *
     * ⚠️ **It says what to do, not what happened.** *"Nobody has taken this"* is a description
     * an operator still has to act on; *"reassign"* is the act, and naming it is the difference
     * between a panel that reports and a panel that helps.
     */
    /**
     * 🔴 **Whether anybody has chased this, and how many times** — D-2, 2026-08-25.
     *
     * It sits with the tally rather than on a row, because a follow-up is not something that
     * happened to **one** recipient: `api/followUp.ts` re-reaches everybody who was told, so
     * attaching it to a row would say something false about the others.
     *
     * ⚠️ **Quiet, and never a flag.** A chase that FAILED already has its own loud line on the
     * board (`.flag.unmet`) and is INV-03's business. This is the opposite fact — the district
     * did chase, and it went — and its whole value is telling an operator **not to chase
     * again**. A second alarm-coloured line here would be one more thing to scan past.
     */
    const chases = state.followUps ?? [];
    if (chases.length > 0) {
      const last = chases[chases.length - 1];
      const line = make(
        'p',
        'chaseline',
        chases.length === 1
          ? 'Chased once by the control room.'
          : `Chased ${String(chases.length)} times by the control room.`,
      );
      if (last !== undefined) {
        line.append(make('span', 'chasenote', ` “${last.note}”`));
        /**
         * ⚠️ **A chase that did not go is still a chase, and the panel must say both.**
         *
         * The first draft counted only delivered ones, which reads as *nobody has chased this*
         * about an operator who tried three times and could not get through — the opposite of
         * the truth, on the screen where somebody decides whether to try again.
         *
         * So the count is every attempt and the failure is named beside it — two facts, both
         * worth having, and neither able to hide the other. An operator deciding whether to
         * ring somebody needs to know **that a colleague already tried** as much as they need
         * to know it did not get through.
         */
        if (!last.delivered) {
          line.append(make('span', 'chasefailed', ' — the last one could not be sent'));
        }
      }
      target.appendChild(line);
    }

    if (owned.ownerless) {
      const flag = make('p', 'unheldflag');
      flag.append(
        make(
          'b',
          '',
          owned.declined === 1
            ? 'One recipient cannot attend'
            : `All ${String(owned.declined)} recipients cannot attend`,
        ),
        document.createTextNode(
          owned.silent > 0
            ? ` — nobody has taken this. ${String(owned.silent)} still to answer; reassign.`
            : ' — nobody has taken this. Reassign.',
        ),
      );
      target.appendChild(flag);
    }
  }

  /**
   * The recipients and the attempt each of them is drawn from, resolved once.
   *
   * Hoisted out of the loop below because the rule that follows has to look at **all** of the
   * rows before the first one is drawn, and a second copy of this predicate is a second place
   * for "which attempt is this recipient's" to drift.
   */
  const rows = state.dispatchedTo.map((t) => ({
    t,
    attempt: dispatched.find(
      (n) =>
        (t.kind === 'person' && n.personId === t.id) ||
        (t.kind === 'post' && n.seatId === t.id && n.personId === undefined) ||
        (t.kind === 'department' && n.departmentId === t.id),
    ),
  }));

  /**
   * 🔴 **The message is printed once at the top of this record, and repeating it under every
   * name was the district's own complaint — 2026-09-08.**
   *
   * `.tsent` was put on the row on 2026-08-24 to answer *"kis ko kya gaya"* **wherever an
   * incident was told twice**, and that question is real: a second alert goes out about a
   * reassessed severity or a corrected place, and this panel is the only screen that can show
   * two officers holding different sentences.
   *
   * But on the ordinary incident — one message, everybody got it — it printed those same four
   * lines under every recipient, immediately below *"The alert we sent"*, which had already
   * said them once. Three officers turned one sentence into four copies of it, and *"replied on
   * WhatsApp"* and what they actually said — the two facts this section exists for — were
   * pushed down the screen by a paragraph the reader had just finished reading.
   *
   * So it is drawn **only where the recipients do not all hold the same words**. The moment two
   * of them differ every row carries its own and the difference is visible; while they agree,
   * the line above is the entire answer and *Status by recipient* says only what it is for —
   * who was told, and what came back.
   */
  const messagesDiffer =
    new Set(
      rows
        .filter((r) => r.attempt !== undefined)
        .map((r) =>
          r.attempt?.sent === undefined ? '' : `${r.attempt.sent.what} — ${r.attempt.sent.where}`,
        ),
    ).size > 1;

  const renderToldRow = (
    dest: HTMLElement,
    t: { kind: string; id: string },
    attempt: ToldEntry | undefined,
  ): void => {
    const row = make('div', 'told');
    row.appendChild(make('span', 'tname', name(t)));

    const answered = attempt !== undefined && ANSWERED.includes(attempt.via ?? '');

    if (attempt === undefined) {
      // Chosen, and no attempt in the log yet. The scheduler takes at most one interval, and
      // saying "queued" here would claim more than is known.
      row.appendChild(make('span', 'tstate pending', 'being recorded'));
    } else if (answered) {
      /**
       * **Four routes, four sentences.** M7-06: a link tap and an operator's telephone call are
       * evidence of very different strength, and a screen that renders them with one word has
       * thrown that difference away before anybody could weigh it.
       */
      /**
       * ⚠️ **An officer who declined is not shown in the same green as one who is on the way.**
       *
       * Both answered, and `answerWording` is right about how we know. What it cannot say is
       * *what* they said — and rendering *"Not Related to Me"* with the tick that means
       * *somebody is dealing with this* is the whole failure this workflow exists to close,
       * reproduced one row lower down.
       *
       * The words themselves are already printed underneath, verbatim and unshortened, which is
       * exactly what the district asked for: the officer's name, that they are unable, and the
       * reason beside it.
       */
      const declined = optionOfSaid(attempt.said)?.records === 'no_owner';
      row.appendChild(make('span', `tstate ${declined ? 'unheld' : 'ok'}`, answerWording(attempt)));
      if (attempt.said !== undefined && attempt.said !== '') {
        row.appendChild(make('span', `tsaid${declined ? ' unheld' : ''}`, `“${attempt.said}”`));
      }
    } else if (attempt.state === 'delivered') {
      // Delivered by the provider and answered by nobody. Said in words, because "delivered"
      // read as "they know" is the failure ADR-0014 is built to prevent.
      row.appendChild(make('span', 'tstate part', 'reached their handset — no answer yet'));
    } else if (attempt.state === 'failed') {
      row.classList.add('failed');
      row.appendChild(make('span', 'tstate bad', 'not reached'));
      row.appendChild(make('span', 'twhy', attempt.failure ?? 'no reason recorded'));
    } else {
      row.appendChild(make('span', 'tstate pending', 'waiting — not yet opened'));
    }

    /**
     * **What this person was actually sent** — the district asked for it 2026-08-24.
     *
     * The Record's row carries the district's latest message; this window is where *"kis ko kya
     * gaya"* is answered per recipient, and it is a different question wherever an incident was
     * told twice: the second alert went out about a reassessed severity or a corrected place,
     * and only this panel can show that the two officers hold different sentences.
     *
     * ⚠️ **Drawn only when the attempt exists**, because an attempt is the district having sent
     * something. A recipient still `being recorded` has no message to show and saying *not
     * recorded* about one would be reporting an absence that is only a few seconds old.
     *
     * ⚠️ **And only where `messagesDiffer`** — see its note above. Everybody holding the same
     * sentence is the ordinary incident, and there the record has already printed it once.
     */
    if (attempt !== undefined && messagesDiffer) {
      row.appendChild(
        attempt.sent === undefined
          ? // Not a blank: absent means the words are not in the log, which is every message
            // before 2026-08-23 and none of them reconstructable. See `ToldEntry.sent`.
            make('span', 'tsent none', 'what was sent is not recorded')
          : make('span', 'tsent', `${attempt.sent.what} — ${attempt.sent.where}`),
      );
    }

    if (record !== undefined && attempt !== undefined && !answered) {
      row.appendChild(recorder(attempt.attemptId, record));
    }

    dest.appendChild(row);
  };

  /**
   * 🔴 **Under the group's name, when a dispatch expanded one** — Case 3, 2026-09-10.
   *
   * `groupRecipients` partitions the same `rows` into one block per group plus a hand-picked
   * remainder; the header counts *responded* the way the row beneath does (`ANSWERED`), so
   * *"All Tehsildars — 6 of 8 responded"* cannot disagree with the ticks under it. The
   * `dispatchAbsorbed` map lets a group still claim the row that stood in for a member the
   * collapse folded away.
   *
   * ⚠️ **`blocks.length === 0` falls through to the flat list** — no group was used, or a
   * server that sends no `recipientGroups`. Every recipient is drawn exactly once either way;
   * grouping only adds the headings.
   */
  const grouped = groupRecipients(
    recipientGroups,
    rows,
    (r) => targetKey(r.t),
    new Map(state.dispatchAbsorbed.map((a) => [targetKey(a.target), targetKey(a.coveredBy)])),
  );

  if (grouped !== null && grouped.blocks.length > 0) {
    for (const block of grouped.blocks) {
      const respondedInBlock = block.rows.filter(
        (r) => r.attempt !== undefined && ANSWERED.includes(r.attempt.via ?? ''),
      ).length;
      const head = make('div', 'toldgroup');
      head.append(
        make('b', 'toldgroupname', block.group.name),
        document.createTextNode(
          ` — ${String(respondedInBlock)} of ${String(block.rows.length)} responded`,
        ),
      );
      target.appendChild(head);
      for (const { t, attempt } of block.rows) renderToldRow(target, t, attempt);
    }
    if (grouped.ungrouped.length > 0) {
      target.appendChild(make('div', 'toldgroup', 'Individually notified'));
      for (const { t, attempt } of grouped.ungrouped) renderToldRow(target, t, attempt);
    }
  } else {
    for (const { t, attempt } of rows) renderToldRow(target, t, attempt);
  }

  for (const entry of state.dispatchAbsorbed) {
    target.appendChild(
      make(
        'p',
        'note',
        `${name(entry.target)} was selected and is covered by ${name(entry.coveredBy)}.`,
      ),
    );
  }

  for (const contact of state.contactsOpened) {
    target.appendChild(
      make(
        'p',
        'note',
        `${contact.channel === 'call' ? 'The dialler' : contact.channel} was opened for ` +
          `${contact.label ?? 'a number'} — whether anybody answered is not recorded.`,
      ),
    );
  }
}

//------------------------------------------------------------------------------
// "Who is coming" — the attendance tally, Phase D
//------------------------------------------------------------------------------

/**
 * How each answer reads on the tally, worst-first.
 *
 * ⚠️ **The order is the reading order and it is not alphabetical.** *Nobody has answered* is the
 * district's problem to chase and sits first for the same reason `No one chosen` outranks a stage
 * on the wall: an officer who has said nothing is the row somebody acts on, and a tally that led
 * with the good news would put it under four figures that need nothing done about them.
 */
const ATTENDANCE_WORDS: readonly { readonly of: AttendanceAnswer; readonly word: string }[] = [
  { of: 'unanswered', word: 'no answer yet' },
  { of: 'attending', word: 'attending' },
  { of: 'sending_someone', word: 'sending someone' },
  { of: 'not_attending', word: 'not attending' },
  { of: 'other', word: 'answered in their own words' },
];

/**
 * Who is coming to this meeting — Phase D, and the other half of O-34.
 *
 * The district has been able to **ask** since 19 August and could not **count**: twelve officers
 * answered and the only way to learn that eight were coming was to read twelve rows one at a
 * time. So the question the district actually says out loud — *"who is coming on Thursday?"* —
 * had no answer on any screen.
 *
 * ## Why this is drawn here rather than fetched
 *
 * **Nothing is added to any response.** `attendanceFor` folds the tally out of the very
 * `notifications` array this panel is already rendering, which is `stages.ts`'s rule applied to a
 * second question: **computed wherever it is shown, never stored.** A figure fetched separately
 * is a figure that can disagree with the rows beneath it, and this product has had to restore
 * that property four times in one milestone.
 *
 * ⚠️ **Drawn ONLY for a meeting**, and `attendanceFor` returns null for everything else rather
 * than a tally of zeroes. *"Attending"* is not an answer to a road accident — which is exactly
 * why `answersFor` refuses to put those buttons on one — and an empty tally on screen invites
 * *"nobody is coming"* about an emergency.
 */
function renderAttendance(
  target: HTMLElement,
  kind: string | undefined,
  attempts: readonly ToldEntry[],
): void {
  // Absent means *this server does not send a kind*, and asserting one here would draw a tally
  // on the strength of a default rather than of a fact. See the field's own note.
  if (kind === undefined) return;

  const tally = attendanceFor(kind as MessageKind, attempts);
  if (tally === null || tally.told === 0) return;

  const panel = make('div', 'att');
  panel.appendChild(make('h3', 'atth', 'Who is coming'));

  const counts = make('div', 'attn');
  for (const { of, word } of ATTENDANCE_WORDS) {
    const n =
      of === 'unanswered'
        ? tally.unanswered
        : of === 'attending'
          ? tally.attending
          : of === 'sending_someone'
            ? tally.sendingSomeone
            : of === 'not_attending'
              ? tally.notAttending
              : tally.other;

    /**
     * **A zero is not drawn, with one exception.** A figure that is always on screen is one
     * people stop reading, and then it is not there on the morning it says three — the rule
     * `moreSentence` and `.note:empty` already follow. The exception is *no answer yet*: that one
     * reading **zero** is the district's best news and the whole point of asking, so it is shown
     * when everybody has answered and only then.
     */
    if (n === 0 && !(of === 'unanswered' && tally.told > 0 && tally.unanswered === 0)) continue;

    const cell = make('span', `attc attc-${of.replace('_', '-')}`);
    /**
     * ⚠️ **The number carries a class, and it is not decoration.** `scripts/contrast.mjs` reports
     * an element as `tag#id.class`, so a bare `<b>` measures as `b` — indistinguishable from
     * every other bold run in the product, and unreachable by any filter naming this panel. The
     * colours here went in unmeasured for exactly that reason, and a deliberately unreadable one
     * passed the check that was meant to catch it.
     */
    cell.appendChild(make('b', 'attv', String(n)));
    cell.appendChild(document.createTextNode(` ${word}`));
    counts.appendChild(cell);
  }
  panel.appendChild(counts);

  /**
   * The denominator, said in words rather than left to arithmetic.
   *
   * *"of 12 told"* is what makes the figures above mean anything: eight attending out of twelve
   * and eight out of forty are different meetings, and a reader should not have to add five
   * numbers to find out which one they are looking at.
   */
  panel.appendChild(
    make('p', 'attof', `of ${String(tally.told)} ${tally.told === 1 ? 'person' : 'people'} told`),
  );

  target.appendChild(panel);
}

/**
 * How this recipient answered, in words that say how sure the district is.
 *
 * `'confirmed from the link'`, not `'acknowledged from the link'` — 2026-09-04. The word
 * described the channel, not a stage, but it was still the one this whole change removes; this
 * says the same fact (a tap, not a WhatsApp reply, not a phone call) in a word that survives it.
 */
function answerWording(attempt: ToldEntry): string {
  if (attempt.via === 'link') return 'confirmed from the link';
  if (attempt.via === 'reply') return 'replied on WhatsApp';
  return 'control room says they confirmed';
}

/**
 * The control — M7-08. Two taps from hearing it, and it demands the words.
 *
 * The first tap chooses which of the two things happened; the second saves. In between is a
 * box, and for a confirmation it is **required**: the entire value of this entry is what the
 * officer actually said, and a confirmation with nothing in it is a tick nobody can weigh
 * afterwards. The authority table demands the same thing for its own reasons
 * (`incident.acknowledgement`), so the two agree by construction rather than by memory.
 *
 * `could_not_reach` takes the note optionally. It asserts nothing about anybody else.
 */
function recorder(
  attemptId: string,
  record: (attemptId: string, outcome: RecordOutcome, said: string) => Promise<void>,
): HTMLElement {
  const wrap = make('span', 'trec');

  const confirmed = make('button', 'tbtn', 'They confirmed');
  const missed = make('button', 'tbtn tbtn-no', 'No answer');
  confirmed.type = 'button';
  missed.type = 'button';

  const open = (outcome: RecordOutcome): void => {
    wrap.replaceChildren();

    const said = make('input', 'tsaidin');
    said.type = 'text';
    said.placeholder = outcome === 'confirmed' ? 'What did they say?' : 'What happened? (optional)';

    const save = make('button', 'tbtn', 'Save');
    const cancel = make('button', 'tbtn tbtn-no', 'Cancel');
    save.type = 'button';
    cancel.type = 'button';

    const problem = make('span', 'twhy');

    const submit = (): void => {
      const text = said.value.trim();
      if (outcome === 'confirmed' && text === '') {
        problem.textContent = 'Say what they told you — that is the record.';
        said.focus();
        return;
      }
      save.disabled = true;
      cancel.disabled = true;
      problem.textContent = '';
      void record(attemptId, outcome, text).catch((err: unknown) => {
        // Never silently. The operator is on a telephone call and has to know whether this
        // reached the record, because the alternative is them assuming it did.
        save.disabled = false;
        cancel.disabled = false;
        problem.textContent = `Not recorded: ${String(err)}`;
      });
    };

    save.addEventListener('click', submit);
    // Enter saves. The operator is typing what they were just told; reaching for the mouse
    // is the difference between recording it and meaning to.
    said.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    cancel.addEventListener('click', () => {
      wrap.replaceChildren(confirmed, missed);
    });

    wrap.append(said, save, cancel, problem);
    said.focus();
  };

  confirmed.addEventListener('click', () => {
    open('confirmed');
  });
  missed.addEventListener('click', () => {
    open('could_not_reach');
  });

  wrap.append(confirmed, missed);
  return wrap;
}

/**
 * **Take action — Phase 8c, 2026-08-21, and it is the only part of phases 8a–8c a district
 * can see.**
 *
 * ## Why it exists
 *
 * Phase 8a stopped the escalation ladder messaging an officer's superior, at the district's own
 * instruction. Phase 8b gave the control room the means to chase by hand. **Neither had a
 * button.** The incident screen carried the report, the values and the timeline, and nothing on
 * it reached an officer — the recipient picker sits *"below the report, never above it"*
 * (M6-06), reachable from a fresh report only. So the district could see an emergency going
 * unanswered and had nothing to do about it, which is the gap they named themselves:
 *
 * > *"control room wale ke paas koi option nahi hota hai — woh na tou escalation bhej sakta hai
 * > aur na hi follow up le sakta hai."*
 *
 * Four acts, in the order a control room reaches for them: **follow up · escalate · mark
 * resolved · close.**
 *
 * ## 🔴 EVERY BUTTON STATES ITS CONSEQUENCE BEFORE IT DOES ANYTHING
 *
 * M10-17's rule, and here it is load-bearing twice over rather than a courtesy:
 *
 * * **Escalate messages NOBODY**, which is the district's own choice and is the opposite of what
 *   the word promises. An operator who presses it expecting a telephone to ring somewhere has
 *   misunderstood it, so the confirmation says so and names the button that *does* reach a
 *   person.
 * * **Follow up reaches only handsets already told**, and an officer who has gone quiet gets the
 *   **alert again on an approved template** rather than a quoted reply — Meta's rule, not ours,
 *   and it looks like a duplicate alert on their phone unless somebody was told to expect it.
 *
 * ## The panel never re-derives an authority rule, and the retry is why
 *
 * `incident.closure` requires a **reason** from an overrider, and the control room **is** an
 * overrider on another department's emergency — so resolving Rescue's incident needs a sentence
 * and resolving its own does not. **This panel does not work that out.** It asks its one
 * question, sends it, and if the server refuses for want of a reason it asks for one **in the
 * server's own words** and tries again. INV-05: the client is never the enforcement layer, and
 * a client that predicted this rule would be a second copy of it — wrong the day the district
 * edits the policy table.
 *
 * A demanded sentence forty times a day is what `incident.dispatch` deliberately refuses to
 * cost, so asking only when the rule actually bites is the whole point of doing it this way.
 *
 * ## What is offered, and what is greyed with a reason
 *
 * A disabled button **says why underneath**, never silently. *"Close"* before anything is
 * resolved is refused by `lifecycle.ts` — closure completeness is a metric this system exists
 * to be honest about — and *"follow up"* on an emergency nobody was told about has nothing to
 * follow up **on**. Both are states an operator can act on once they read the sentence; a dead
 * button they cannot.
 */
export type ActionKind = 'follow-up' | 'escalate' | 'resolve' | 'close';

export interface ActionOutcome {
  readonly ok: boolean;
  /** What the panel says afterwards. **The server's own words** whenever it refused. */
  readonly message: string;
  /**
   * The refusal was *"requires a reason to override"*.
   *
   * Reported as a flag rather than matched on the sentence here, so the panel asks the question
   * the policy table asked for without ever knowing which rule asked it.
   */
  readonly needsReason?: boolean;
}

export interface TakeActionState {
  readonly incidentId: string;
  readonly status: string;
  /**
   * Whether anybody was ever **chosen**, and deliberately not whether a department holds it.
   *
   * Those are two questions, and `whoHasIt`'s own lesson is what happens when the first is
   * answered with the second: nineteen of Bajaur's forty incidents were shown as reaching
   * nobody while an officer had been messaged by name.
   */
  readonly toldAnybody: boolean;
  /** How many times it has already gone up. Shown, never used to decide anything. */
  readonly escalationCount: number;
}

/**
 * Perform one act, and say what happened in words the panel prints unchanged.
 *
 * A refusal is **the server's own sentence**, because the server is the only thing that knows
 * why. A failure that reaches nobody is INV-03's own subject: an operator who pressed a button
 * and saw nothing has to be told, on the screen they are looking at.
 */
async function perform(
  incidentId: string,
  kind: ActionKind,
  body: Record<string, unknown>,
): Promise<ActionOutcome> {
  const res = await fetch(`/incidents/${incidentId}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await res.json().catch(() => ({}))) as {
    error?: string;
    chased?: { phone: string; delivered: boolean; failure: string | null }[];
    escalated?: { toSeatTitle: string; hasHolder: boolean };
  };

  if (!res.ok) {
    const error = answer.error ?? `That was refused (${String(res.status)}).`;
    return {
      ok: false,
      message: error,
      // Matched rather than reproduced: the wording is `evaluateWrite`'s, and this asks only
      // *was a reason demanded*, never *by which rule*.
      needsReason: res.status === 403 && error.includes('requires a reason'),
    };
  }

  if (kind === 'follow-up') {
    const chased = answer.chased ?? [];
    const failed = chased.filter((c) => !c.delivered);
    if (failed.length > 0) {
      return {
        ok: false,
        message:
          `Followed up ${String(chased.length - failed.length)} of ${String(chased.length)}. ` +
          `Could not send to ${failed.map((c) => c.phone).join(', ')} — ` +
          `${failed[0]?.failure ?? 'no reason given'}. Ring them.`,
      };
    }
    return {
      ok: true,
      message:
        chased.length === 1
          ? 'Followed up. It is on the incident.'
          : `Followed up ${String(chased.length)} handsets. It is on the incident.`,
    };
  }

  if (kind === 'escalate') {
    const to = answer.escalated?.toSeatTitle ?? 'the seat above';
    // ADR-0004: a vacant post must never swallow an obligation in silence, and this is the one
    // moment somebody can act on it.
    return {
      ok: true,
      message:
        answer.escalated?.hasHolder === false
          ? `Escalated to ${to} — but NOBODY HOLDS that post. Nothing was messaged and nobody ` +
            'is coming. Ring somebody.'
          : `Escalated to ${to}. Nobody was messaged, which is the district's rule.`,
    };
  }

  return { ok: true, message: kind === 'resolve' ? 'Marked resolved.' : 'Closed.' };
}

interface ActionSpec {
  readonly kind: ActionKind;
  readonly label: string;
  /**
   * Said before anything happens — M10-17's rule, and it is **absent on `follow-up` while the
   * emergency is still live.**
   *
   * The owner asked for that on 2026-08-22, having used the panel on a real night: *"bas Follow
   * Up dabane par direct aik professional follow up msg chala jaye, msg/text type karna na
   * pare."* Two dialogs stood between a control room and **the one act on this screen that
   * actually reaches a person**, and the second of them asked a question whose honest answer is
   * almost always *nothing, send the usual one*.
   *
   * ⚠️ **It loses its confirmation only while live, and what decides that is the cost of
   * pressing it by mistake.** Escalate, Mark resolved and Close each write a fact the board is
   * read from, and the server demands a sentence for every one of them. A stray follow-up on a
   * live incident sends one more chase to officers **who were already told about that same
   * emergency** — it reaches nobody new, it is recorded on the incident, and it is undone by
   * being ignored. That is the cheapest of the four to press wrongly, which is why it is the one
   * that may be pressed in one tap.
   *
   * **Once the incident is `resolved`, Follow up gets its confirmation back** — 2026-09-05. A
   * control room reading the Record found the button still live and one-tap on an emergency the
   * board itself already called finished, and pressed it: the officer who had just been told it
   * was over received the same alert a second time. Resolved is not live, so the cheap-mistake
   * reasoning above no longer holds; the confirmation says plainly that this is already resolved
   * and asks whether to chase anyway, so the control room decides with that fact in front of it
   * rather than out of the same reflex a live emergency earns. Escalate picks up the same line
   * for the same reason — see `specsFor`.
   *
   * ⚠️ **A second press sends a second message**, and nothing here stops it. That is the
   * trade the owner made knowingly; if officers report being chased too often, the restraint
   * belongs on the **server** as a cooling-off period the district can see and choose, not as a
   * dialog put back on the button they asked to have cleared.
   */
  readonly confirm?: string;
  /** What is asked for, and the field it travels in. Absent where nothing is asked. */
  readonly ask?: { readonly prompt: string; readonly field: string; readonly required: boolean };
  /** Null when it may be pressed; the sentence to show beneath it when it may not. */
  readonly why: string | null;
}

function specsFor(state: TakeActionState): readonly ActionSpec[] {
  const closed = state.status === 'closed';
  const resolved = state.status === 'resolved';

  /**
   * **Shared by Follow up and Escalate, and only the two of them — 2026-09-05.**
   *
   * `resolve` and `close` already refuse themselves once the status they write is the status
   * that is already there (`why` below). Follow up and Escalate are different: neither writes
   * `status`, so neither had anything to check, and both stayed pressable — one-tap, in Follow
   * up's case — on an incident the board had already called finished. See `ActionSpec.confirm`.
   */
  const resolvedWarning = 'This emergency is already marked resolved.\n\n';

  return [
    {
      /**
       * 🔴 **ONE PRESS. NO CONFIRMATION, AND NOTHING TO TYPE — while the incident is live.**
       *
       * **The saved message is the server's and always was.** `api/followUp.ts` composes it,
       * because it is the only place that knows what the emergency is, whether this handset is
       * inside Meta's 24-hour window (a plain message quoted under the alert) or outside it (the
       * approved template, unchanged — no template is created or edited for this, ever), and
       * **which stages are still ahead to put on the buttons.** A sentence composed here could
       * carry none of that, and would go out over the top of a message that already reads better.
       *
       * `note` stays in the API for the day a room wants its own words. Nothing on this screen
       * asks for them any more.
       */
      kind: 'follow-up',
      label: 'Follow up',
      ...(resolved
        ? {
            confirm: `${resolvedWarning}Send one more follow-up message to everyone who was told anyway?`,
          }
        : {}),
      why: state.toldAnybody
        ? null
        : 'Nobody has been told about this yet, so there is nothing to follow up on. ' +
          'Choose who should know first.',
    },
    {
      kind: 'escalate',
      label: 'Escalate',
      confirm:
        (resolved ? resolvedWarning : '') +
        'Escalate this emergency?\n\n' +
        'This MARKS THE BOARD and MESSAGES NOBODY — not the officer, not their office. ' +
        'That is the district\u2019s own instruction.\n\n' +
        'If you want somebody told, use Follow up instead, or ring them.',
      ask: {
        prompt:
          'Why should this go up?\n\n' +
          'Nothing is sent, so this sentence is the whole of what anybody reading the board ' +
          'afterwards will have.',
        field: 'reason',
        required: true,
      },
      why: closed ? 'This is closed. Reopen it before escalating.' : null,
    },
    {
      kind: 'resolve',
      label: 'Mark resolved',
      confirm:
        'Mark this emergency resolved?\n\n' +
        'It leaves the live board. Nothing is deleted and nothing is unsent — it stays in the ' +
        'record, on the daily report, and in search.',
      ask: {
        prompt: 'What was the outcome? This is what the record will say happened.',
        field: 'outcome',
        required: true,
      },
      why: closed ? 'This is closed.' : resolved ? 'This is already marked resolved.' : null,
    },
    {
      kind: 'close',
      label: 'Close',
      confirm:
        'Close this emergency?\n\n' +
        'Closing ends it. Corrections and withdrawals still work afterwards; nothing else does ' +
        'until it is reopened.',
      ask: {
        prompt: 'Anything to note on closing? This goes on the record.',
        field: 'notes',
        required: true,
      },
      why: closed
        ? 'This is already closed.'
        : resolved
          ? null
          : 'Mark it resolved first — an emergency closed with no recorded outcome is exactly ' +
            'what the closure figures exist to catch.',
    },
  ];
}

/**
 * Draw the take-action panel.
 *
 * The calls and every sentence they produce live in `perform`, in **this** file rather than in
 * the shell: they are control-room prose an officer at a scene will never read, and moving them
 * here is what kept the shell inside its budget when this phase landed.
 */
/**
 * What the last successful act said, waiting for the repaint that act caused.
 *
 * ⚠️ **Without this the panel is silent at exactly the moment it has most to report.** A success
 * calls `onChanged`, which reloads the incident, which redraws this panel from scratch — so the
 * sentence naming three messaged handsets, or a post nobody holds, was painted and destroyed in
 * the same tick. INV-03 is about a failure being visible **where somebody acts on it**, and a
 * repaint is not an exemption.
 *
 * Keyed on the incident and **consumed when it is shown**, so it appears once, on the render its
 * own act caused, and never as a stale sentence on a screen somebody came back to later.
 */
let carried: { incidentId: string; message: string; bad: boolean } | null = null;

export function renderTakeAction(
  target: HTMLElement,
  state: TakeActionState,
  /**
   * Something the server owns has moved — reload rather than patch.
   *
   * Closing, resolving and escalating all change state folded from the log, and a screen that
   * guessed at the new one would be a second fold of the same events.
   */
  onChanged: (incidentId: string) => void,
): void {
  target.replaceChildren();

  const row = make('div', 'takeacts');
  const said = make('p', 'takenote');
  said.hidden = true;

  const say = (message: string, bad: boolean): void => {
    said.textContent = message;
    said.classList.toggle('takebad', bad);
    said.hidden = false;
  };

  if (carried !== null && carried.incidentId === state.incidentId) {
    say(carried.message, carried.bad);
    carried = null;
  }

  for (const spec of specsFor(state)) {
    const button = make('button', 'act', spec.label);
    button.type = 'button';
    button.id = `take-${spec.kind}`;

    if (spec.why !== null) {
      button.disabled = true;
      const held = make('span', 'takeheld');
      held.append(button, make('span', 'takewhy', spec.why));
      row.append(held);
      continue;
    }

    button.addEventListener('click', () => {
      // Absent on `follow-up` while live, by the owner's instruction; present once resolved —
      // see `ActionSpec.confirm`.
      if (spec.confirm !== undefined && !confirm(spec.confirm)) return;

      const body: Record<string, unknown> = {};
      if (spec.ask !== undefined) {
        const answer = prompt(spec.ask.prompt);
        // Cancelled, and that is allowed at any point: a confirmation is not a commitment.
        if (answer === null) return;
        if (spec.ask.required && answer.trim() === '') return;
        if (answer.trim() !== '') body[spec.ask.field] = answer;
      }

      void (async () => {
        button.disabled = true;
        say(`${spec.label}\u2026`, false);
        try {
          let outcome = await perform(state.incidentId, spec.kind, body);

          /**
           * The policy table asked for a sentence, so ask for one — see this file’s header.
           * Once, never in a loop: a second refusal is a different refusal.
           */
          if (!outcome.ok && outcome.needsReason === true) {
            const why = prompt(
              `${outcome.message}\n\nWhy are you recording this on the department\u2019s behalf?`,
            );
            if (why === null || why.trim() === '') {
              say(outcome.message, true);
              return;
            }
            outcome = await perform(state.incidentId, spec.kind, { ...body, reason: why });
          }

          say(outcome.message, !outcome.ok);
          if (outcome.ok) {
            // Said before the reload and again after it — see `carried`.
            carried = { incidentId: state.incidentId, message: outcome.message, bad: false };
            onChanged(state.incidentId);
          }
        } finally {
          button.disabled = false;
        }
      })();
    });

    row.append(button);
  }

  /**
   * How many times it has already gone up, **and that nobody was messaged about any of them.**
   *
   * The second half is the point. `escalated N×` has been on the board and on this screen
   * since long before the ladder stopped sending, so the figure reads to anybody who has used
   * this system as *"their office was told N times"* — which stopped being true in Phase 8a.
   */
  const heard = make('p', 'takecount');
  if (state.escalationCount > 0) {
    heard.textContent =
      state.escalationCount === 1
        ? 'Escalated once already. Nobody was messaged about it.'
        : `Escalated ${String(state.escalationCount)} times already. Nobody was messaged about them.`;
  } else {
    heard.hidden = true;
  }

  target.append(row, heard, said);
}
