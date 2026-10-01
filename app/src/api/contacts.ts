/**
 * Who to ring, and on what number — M5.
 *
 * The owner's correction, 2026-08-03, after I built a great deal that was not asked for:
 *
 *   > mai ye chahta tha k jub departments k sath ju numbers hain … un ko DC and AC HQ offices
 *   > ya koi bhi … kese department ko asign karna chahe tou un k number pr directly call kar
 *   > skte ho, es ka ye matlab nhe hai k software call karega … ju banda alert jare karega ya
 *   > escalate karega … un ko mutalqa number mil jaye and us pr click kare tou contact karne
 *   > ka channel selection mai ho … es mai Meta business account, telephony ya SMS gateway ki
 *   > koi zarurt nhe hai
 *
 * So this endpoint does one thing: **it hands an officer the number.** What happens next is a
 * `wa.me` link, a `tel:` link or an `sms:` link opening on their own handset, and a human
 * having a conversation. Nothing here sends anything, and nothing here needs an account with
 * anybody.
 *
 * That is a better design than the one it replaces, and not only because it is smaller. A
 * ladder of providers can fail in ways nobody sees — a template unapproved, a gateway out of
 * credit, a modem with no signal — and every one of those failures is discovered on the night
 * it matters. An officer who dialled a number knows within ten seconds whether it rang.
 *
 * ## What this is careful about
 *
 * **Behind a session, always.** These are officers' personal mobiles. The dashboard's own
 * safety check still refuses to let a number anywhere near a screen a room can read — this is
 * the other kind of screen, the one a named person signed into.
 *
 * **A placeholder is never offered as a number.** A stand-in fills a post so the roster is
 * complete; dialling it reaches nobody, and finding that out at 02:00 is the failure this
 * whole system exists to prevent. It is returned, and it is returned marked.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { reachabilityOf, sharedNumbers, type Recipient } from '../domain/recipients.js';
import { listGroups } from '../db/groupStore.js';
import { loadDispatchHistory } from '../db/dispatchHistory.js';
import { proposalsFor } from '../domain/learning.js';
import { ASSUMED_CATEGORY } from '../domain/assumptions.js';

export interface ContactLine {
  /**
   * The post's id, so a contact attempt can name what it was for (M6-10).
   *
   * The title alone would not do: two departments can both have a "Duty Officer", and a record
   * saying somebody rang "Duty Officer" answers nothing six months later.
   */
  readonly seatId: string;
  /** The post — "District Emergency Officer". Authority attaches here, not to a name. */
  readonly seatTitle: string;
  /** Who currently holds it. Null when nobody does, which is a fact worth showing. */
  readonly holder: string | null;
  readonly phone: string | null;
  /**
   * A stand-in number, filling the post so the roster is complete.
   *
   * Offered, and offered marked. Hiding it would leave a post looking unreachable when it is
   * merely un-filled, and those need different actions from the district.
   */
  readonly placeholder: boolean;
}

export interface ContactsReply {
  readonly status: number;
  readonly body: unknown;
}

// ⚠️ `departmentContacts` and `DepartmentContacts` are gone — ADR-0031, phase 4, and with them
// the `/contacts/department/:id` route. That route answered `{"error":"no such department"}` for
// every id after migration 0039 dropped the table (it was the last place the software could
// produce that sentence, and the live bug ADR-0031 exists to end). Reaching a person about an
// emergency is `/contacts/recipients` and the recipient picker now — a contact IS a post and
// whoever holds it, ordered duty-bearing first, which is all the removed query ever did.

export interface RecipientList {
  /** Everything selectable, in one flat list. The screen groups it; the server ranks it. */
  readonly recipients: readonly Recipient[];
  /**
   * Numbers held by more than one recipient.
   *
   * Reported, never resolved. Two officers sharing a handset is ordinary here and a mistyped
   * digit looks identical — the district decides which it is looking at.
   */
  readonly sharedNumbers: readonly { readonly phone: string; readonly labels: readonly string[] }[];
}

/**
 * Everyone the control room can tell — **one row per contact** since 2026-08-22.
 *
 * `departmentContacts` above answers *"how do I reach this one department"*, which is the
 * question an officer asks mid-incident. This answers a different one: **"who could I tell?"**,
 * asked at intake, with the whole district in view and several answers about to be ticked.
 *
 * **Unreachable rows are returned, marked.** A vacant post, a stand-in number, a disabled
 * account — all present, all labelled, all selectable. Filtering them would hide the vacancy
 * from the one person who was about to notice it, and would let a vacant post swallow an
 * obligation in silence (ADR-0004). See `assertOfferedAnyway` in `domain/recipients.ts`.
 *
 * **Retired departments and removed people are gone entirely**, which is a different thing:
 * they are not a gap in the district's cover, they are rows that should no longer exist.
 *
 * ## What changed, and why it is a deletion rather than a filter
 *
 * This used to return three kinds of row — a **department**, a **post** and a **person** — and
 * one officer appeared in all three. Counted against Bajaur's own directory that is
 * `79 + 81 + 40 = 200 selectable rows for 40 real handsets`: **five rows per human being.**
 *
 * The district's report was *"names bhi aa jate hain aur department bhi aa jate hain … bahut
 * confusion ho jati hai"*, and they were describing the model showing through rather than a
 * rendering fault. `collapseSelection` has been quietly cleaning it up **at send time** ever
 * since M6 — which is exactly why this screen has always looked wrong and worked correctly, and
 * why nobody could say what was wrong with it.
 *
 * ⚠️ **The department layer it came from is not there.** 79 departments for 81 posts: almost
 * every one holds a single person and its name restates the designation (`ADC (General)` /
 * `ADC (G) Bajaur`). Only **two** in the whole district hold more than one person. Bajaur is a flat
 * list of ~81 posts, and the hierarchy was this software's assumption.
 *
 * **ADR-0004 is what makes this safe rather than a loss:** authority attaches to the post, and
 * the designation **is** the post. What goes is the layer above it.
 *
 * ## A contact is a post and whoever holds it
 *
 * No new table, no migration. `seat.title` is the designation, the current holder is the name,
 * their `phone` is the number — the three fields the district asked for, already stored.
 *
 * **A vacant post stays in the list, marked** (`unreachable: 'vacant'`). A phone's contact list
 * has no such idea, and that is the one thing the district would otherwise stop being told: 38
 * of its 81 posts have nobody in them, and this is where somebody notices.
 *
 * ## Old records are not touched
 *
 * `department` and `person` targets are all over the event log and stay readable for ever
 * (ADR-0001). `listDirectory` below is what names them. This function answers only *"who can be
 * ticked now"*, which is the one question whose answer is allowed to get smaller.
 */
export async function listRecipients(pool: Pool): Promise<RecipientList> {
  return buildRecipients(pool, { legacyKinds: false });
}

/**
 * The same directory, **plus the kinds nothing may select any more** — 2026-08-22.
 *
 * Groups saved before the flat directory may hold `department` and `person` members, and the
 * event log holds them for ever. A group editor that could not name them would print raw uuids
 * over a district's own saved sets — and `describe`'s own rule is that a member with no name
 * reads as *nobody was told*, which is the one reading that must never be available.
 *
 * **Selection is what narrowed, not the record.** Nothing here is offered at intake; this exists
 * so the past can still be read aloud.
 */
export async function listDirectory(pool: Pool): Promise<RecipientList> {
  return buildRecipients(pool, { legacyKinds: true });
}

/**
 * The departments a new officer can be **placed** into — 2026-08-22, and nothing else.
 *
 * ⚠️ **Not a way back onto the picker.** The add-an-officer form (M9-23) asks where somebody
 * goes, and until the roster itself is flattened a seat still belongs to a department — so the
 * form needs the list even though nothing may be *told* a department any more.
 *
 * It broke the moment the picker went flat: the form read its options out of the recipient list,
 * which no longer holds a department row, so the select came back empty and **nobody could be
 * added at all**. Caught by `directory.e2e.test.ts` test 5 rather than by reading the code.
 *
 * Kept apart from `recipients` deliberately. One field is what may be ticked; this one is where
 * a person is filed. Merging them is how a department finds its way back onto the screen the
 * district asked to have it taken off.
 */
export function placementDepartments(
  _pool: Pool,
): Promise<readonly { readonly id: string; readonly label: string }[]> {
  /**
   * ⚠️ **ALWAYS EMPTY SINCE ADR-0030, AND UNCALLED.** Migration 0039 dropped the table.
   *
   * Kept for one turn rather than deleted, because the comment above it is the record of WHY
   * this was ever a separate field from `recipients` — *one is what may be ticked, this is where
   * a person is filed* — and that distinction is the thing a future change would otherwise
   * rediscover by merging them and putting a department back on the picker.
   */
  return Promise.resolve([]);
}

async function buildRecipients(
  pool: Pool,
  options: { readonly legacyKinds: boolean },
): Promise<RecipientList> {
  /**
   * Skipped entirely for the picker, not merely unused.
   *
   * This runs on the machine that is also accepting emergency reports, every time somebody opens
   * intake — the reasoning `listRecipients` was written with in M6. Two queries whose rows are
   * thrown away are two the control room waits for at 02:00.
   */
  /**
   * ⚠️ **NO DEPARTMENT ROWS — ADR-0030 dropped the table, ADR-0031 (phase 2) dropped the
   * `'department'` `RecipientKind`.** `listDirectory` still passes `legacyKinds: true` so a
   * **group saved before the flat directory** and a **department-kinded target on some other
   * installation's past incident** can still be named by their id — but this reader builds no
   * department rows to do it from. The flag now decides only whether the `person` rows below
   * are included.
   */
  const posts = await pool.query<{
    seat_id: string;
    title: string;
    department_id: string | null;
    department_name: string | null;
    person_id: string | null;
    full_name: string | null;
    phone: string | null;
    placeholder: boolean | null;
    disabled_at: string | null;
  }>(
    // ADR-0030 — a contact belongs to no department. Both columns are selected as NULL so the
    // row shape every caller destructures is unchanged, and the join is gone with the table.
    `SELECT s.seat_id, s.title,
            NULL::uuid AS department_id, NULL::text AS department_name,
            p.person_id, p.full_name, p.phone, p.placeholder, p.disabled_at
       FROM seat s
       LEFT JOIN duty_assignment a
              ON a.seat_id = s.seat_id
             AND a.from_at <= now()
             AND (a.to_at IS NULL OR a.to_at > now())
       LEFT JOIN person p
              ON p.person_id = a.person_id
             AND p.removed_at IS NULL
      WHERE s.retired_at IS NULL
      -- Held posts first: whoever is about to tell somebody wants a person, not a vacancy.
      --
      -- ADR-0030 -- THIS LINE STILL ORDERED BY d.name AFTER THE JOIN THAT DEFINED d WAS REMOVED
      -- WITH THE TABLE, so every caller of buildRecipients answered 500: the recipient picker the
      -- control room opens on every emergency, GET /contacts/recipients, and both of the
      -- console's group routes. A dropped column shows up in a SELECT list where anybody reading
      -- the diff sees it; in an ORDER BY it sits four lines below the change and the compiler has
      -- nothing to say about it. The department was the middle sort key and there is no middle.
      ORDER BY p.person_id IS NULL, s.title`,
  );

  const recipients: Recipient[] = [];

  for (const row of posts.rows) {
    recipients.push({
      kind: 'post',
      id: row.seat_id,
      label: row.title,
      departmentId: row.department_id,
      departmentName: row.department_name,
      holderName: row.full_name,
      holderPersonId: row.person_id,
      // A post's designation is its own label; repeating it here would be one fact in two fields.
      designation: null,
      phone: row.phone,
      unreachable: reachabilityOf({
        holderPersonId: row.person_id,
        phone: row.phone,
        placeholder: row.placeholder === true,
        disabledAt: row.disabled_at,
      }),
    });
  }

  /**
   * Named officers, as themselves.
   *
   * The district asked for *"mutalqa department ya personal ya post"* — three ways of naming
   * somebody, and this is the third. It overlaps the posts above on purpose: most of these
   * people hold one, and `collapseSelection` is what stops that overlap becoming two messages
   * to one phone.
   *
   * Why offer it at all when a post already reaches the same handset: **authority attaches to
   * the post, but knowledge attaches to the person** (ADR-0004). "Tell the DEO" and "tell
   * Nawaz, he knows that road" are different intentions, and an operator who can only express
   * the first will put the second in the message text where nothing can act on it.
   */
  type PersonRow = {
    person_id: string;
    full_name: string;
    phone: string | null;
    placeholder: boolean | null;
    disabled_at: string | null;
    department_id: string | null;
    designation: string | null;
    department_name: string | null;
  };

  // Skipped for the picker, for the same reason the department query above is — see its note.
  const people = !options.legacyKinds
    ? { rows: [] as PersonRow[] }
    : await pool.query<PersonRow>(
        `SELECT p.person_id, p.full_name, p.phone, p.placeholder, p.disabled_at,
            NULL::uuid AS department_id,
            s.title AS designation,
            NULL::text AS department_name
       FROM person p
       LEFT JOIN duty_assignment a
              ON a.person_id = p.person_id
             AND a.from_at <= now()
             AND (a.to_at IS NULL OR a.to_at > now())
       LEFT JOIN seat s ON s.seat_id = a.seat_id AND s.retired_at IS NULL
      WHERE p.removed_at IS NULL
        AND p.disabled_at IS NULL
        AND NOT p.placeholder
        AND p.phone IS NOT NULL
        AND btrim(p.phone) <> ''
      ORDER BY p.full_name, s.title`,
      );

  /**
   * One row per person **per department** — M10-06, O-27, 2026-08-16.
   *
   * ~~One row per person, even when they hold two posts.~~ The join above fans out across duty
   * assignments, and this used to collapse on `person_id` alone: a person holding two posts
   * became one row carrying **whichever designation and department the database happened to
   * return first**.
   *
   * ⚠️ **That is not hypothetical, and the plan's claim that it was cost this the audit to find.**
   * `backlog/m10-plan.md` said *"Nobody in Bajaur holds two posts today"*. M10-05 queried the live
   * directory on 2026-08-16: **three do**, and two of them across different departments — Imran
   * (C&W Buildings · C&W Highways) and Zubair Ahmad (ADC General · ADC Relief). Collapsing Imran to
   * one row labelled *C&W Building Division* **hides that he is also Highways**, and this list is
   * how the control room decides who to tell. A room told to reach Highways would not find him.
   *
   * So the key is the pair. The owner chose this on 2026-08-16: an officer appears **once under
   * each department they serve**, which is still *"one name, once"* in every list somebody reads,
   * and the control room can always find them where they expect to.
   *
   * The `id` is still the person, so ticking either row tells the same handset —
   * `collapseSelection` and the outbound message are unaffected, and this remains a change to
   * what the screen offers rather than to what the system sends.
   */
  const seenPeople = new Set<string>();

  for (const row of options.legacyKinds ? people.rows : []) {
    const key = `${row.person_id}:${row.department_id ?? ''}`;
    if (seenPeople.has(key)) continue;
    seenPeople.add(key);

    recipients.push({
      kind: 'person',
      id: row.person_id,
      label: row.full_name,
      departmentId: row.department_id,
      departmentName: row.department_name,
      holderName: row.full_name,
      holderPersonId: row.person_id,
      designation: row.designation,
      phone: row.phone,
      // The query already excludes everything `reachabilityOf` would object to. Asking it
      // anyway, rather than asserting null, so the two never drift apart.
      unreachable: reachabilityOf({
        holderPersonId: row.person_id,
        phone: row.phone,
        placeholder: row.placeholder === true,
        disabledAt: row.disabled_at,
      }),
    });
  }

  return { recipients, sharedNumbers: sharedNumbers(recipients) };
}

/**
 * Serve the numbers for a department.
 *
 * **Any signed-in officer may read these, and that is the point.** The person who needs to
 * reach Rescue at 02:00 is whoever is awake, not whoever happens to hold the right department.
 * Scoping this the way the roster is scoped would mean a control room that can see an
 * emergency is with Rescue and cannot see how to ring them.
 *
 * The line that is *not* crossed: this is behind a session, and the numbers never reach the
 * dashboard, which is the screen a room can read (ADR-0013 §1).
 */
export async function handleContacts(
  pool: Pool,
  req: IncomingMessage,
  path: string,
  identity: Identity,
): Promise<ContactsReply> {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };

  /**
   * Everyone the control room could tell (M6).
   *
   * Behind a session, like everything else in this file, and deliberately **not** scoped to
   * the caller's department — the control room's whole job is telling other people's
   * departments. The line that is not crossed is the same one: these numbers never reach the
   * dashboard, which is the screen a room can read (ADR-0013 §1).
   */
  if (path === '/contacts/recipients') {
    /**
     * **May this seat add to the directory? — M9-23.**
     *
     * The picker is where a gap in the directory is *discovered*: an operator searches for an
     * officer at 02:00 and the name is not there. Until now the only door was the console, so
     * the answer was "leave this screen, find the department, add them, come back and start
     * again" — which in practice means ringing somebody from a personal handset instead, and
     * the district is back to a record that does not exist.
     *
     * This flag draws the door; it does not open it. Every one of `/admin/departments` and
     * `/roster/:id/people` still asks `requireAdministration` and `reach` for itself, and
     * refuses a seat that should not be there whatever this said (INV-05). Hiding a control
     * the server would refuse is a courtesy to the operator, exactly as the console tabs are.
     */
    const canEditDirectory = identity.isAdministration;

    /**
     * What the district's own habit suggests — M7-15…M7-18, and since ADR-0022 the only thing
     * that suggests anything at all.
     *
     * `?category=` returns the departments this district has actually told about this kind of
     * thing before, read back off their own `dispatched` events. There were two suggesters
     * until ADR-0022: this one, and the administration's configured routing signals. The
     * signals are gone — the control room found being pre-decided for confusing — and what
     * remains is the district's own record of itself rather than a rule somebody typed.
     *
     * Deliberately a **read**, on the recipients endpoint, before any incident exists. The
     * operator is still typing; nothing has been decided and nothing here decides it.
     */
    const url = new URL(req.url ?? '/', 'http://localhost');
    const category = url.searchParams.get('category');
    const description = url.searchParams.get('description');

    /**
     * The groups come back with the directory, on the same round trip — M7-14.
     *
     * Not a second fetch from the panel. The operator is on a telephone call and the panel is
     * already the one screen in the product that cannot afford a second thing to be
     * half-loaded: a groups list that arrives late is a groups list that is not there when
     * somebody ticks, and they select six departments by hand instead.
     */
    const [list, groups] = await Promise.all([listRecipients(pool), listGroups(pool)]);

    /**
     * ADR-0030 — `departments` IS SENT EMPTY AND NOTHING FETCHES IT.
     *
     * It was where a person is FILED, kept deliberately apart from who may be TOLD so that a
     * department could not find its way back onto the screen the district asked to have it taken
     * off. CD-07 then made the contact form TYPE a designation rather than pick one, and
     * migration 0039 dropped the table, so there is nothing left to fetch.
     *
     * ⚠️ The field stays on the reply because this bundle is fetched at runtime and can be older
     * than the server. An absent key reads as *this server does not send one*, which is a
     * different sentence from *there are none*; empty says the true one.
     */
    const withGroups = { ...list, groups, departments: [], canEditDirectory };

    if (category === null && description === null) return { status: 200, body: withGroups };

    const learned = proposalsFor(await loadDispatchHistory(pool), category ?? ASSUMED_CATEGORY);

    /**
     * `description` is read off the query string and deliberately unused.
     *
     * It fed the keyword half of routing, which is gone. The parameter stays accepted rather
     * than refused because handsets cache the shell: an older intake screen still sends it,
     * and a 400 on a call at 02:00 would be this change breaking the one screen it was meant
     * to simplify. Learning is category-only and always was (M7-16).
     */
    void description;

    return {
      status: 200,
      body: {
        ...withGroups,
        // Each one carries its own sentence. A silent pre-tick is a suggestion nobody can
        // audit or disagree with, and the point of showing one is that somebody is judging it.
        learned,
      },
    };
  }

  // `/contacts/recipients` is the only path this handler serves — `/contacts/department/:id`
  // went with the department table (ADR-0031, phase 4).
  return { status: 404, body: { error: 'no such endpoint' } };
}

export function writeContacts(res: ServerResponse, reply: ContactsReply): void {
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // Never cached. A number that changed this morning must not be served from this morning.
    'cache-control': 'no-store',
  });
  res.end(body);
}
