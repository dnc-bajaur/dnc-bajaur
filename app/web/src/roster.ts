/**
 * The roster on screen — M1a-10.
 *
 * **One component, two doors.** A department officer reaches it as "My department" and sees
 * their own; the two administrative offices reach it from the console and can pick any of
 * the 79. Same markup, same operations — the server decides what is permitted, and this
 * module only decides what to draw (INV-05).
 *
 * The screen is organised around the question the roster answers — *who is in that post
 * right now?* — so posts lead and people follow, rather than the other way round. A post
 * with nobody in it is the thing an administrator needs to see first, because it is the one
 * that silently swallows an alert at 02:00.
 *
 * Three rules, all the same rule:
 *
 * 1. **Unreachable is stated, in words.** Empty post, placeholder number — both mean nothing
 *    can be told, and both say so (ADR-0005, INV-04).
 * 2. **Anything that stops somebody being reachable confirms first, then acts.** The server
 *    and the config log still require a reason (INV-06 — the actor, the seat and the time
 *    are what that invariant turns on); the console supplies a fixed one so an ordinary
 *    edit is one confirmation, not an interrogation.
 * 3. **Adding a contact and granting a login are separate buttons**, because they are
 *    separate decisions. A credential for somebody who has not been told the system exists
 *    is a password nobody chose on an account nobody watches.
 */

import { findDuplicate, duplicateSentence } from './duplicates.js';

export interface RosterPerson {
  personId: string;
  fullName: string;
  phone: string;
  placeholder: boolean;
  hasAccount: boolean;
  disabledAt: string | null;
}

export interface RosterPost {
  seatId: string;
  title: string;
  tier: string;
  retiredAt: string | null;
  holder: RosterPerson | null;
  heldSince: string | null;
}

export interface RosterView {
  departmentId: string;
  departmentName: string;
  posts: RosterPost[];
  people: RosterPerson[];
  unreachablePosts: number;
  editable: boolean;
}

/**
 * ⚠️ **The decorative scope segment — ADR-0030. It has to LOOK like an id while naming nothing.**
 *
 * `rosterFor` returns `departmentId: null` now: there is one roster and it is the district's.
 * Interpolated straight into a URL that null reads back as the literal string `"null"`, and it
 * is also written into a dataset attribute two suites read.
 *
 * `api/roster.ts` ignores the segment entirely — its own note says the id is decorative and is
 * kept so that `/roster/<anything>` and `/roster` cannot drift apart. But `server.ts` matches
 * `/roster/:id` and **refuses a segment that is not a uuid**, which is a real guard:
 * `/roster/posts/…` and `/roster/people/…` are matched above it, and a bare word could collide
 * with a sub-resource added later. The nil uuid passes the route's shape check, names nothing,
 * and is voided on the next line.
 */
const DISTRICT_SCOPE = '00000000-0000-0000-0000-000000000000';

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}

export interface RosterHost {
  /** Where to draw. Cleared and replaced on every render. */
  readonly container: HTMLElement;
  /** Show a refusal. The console and the department view surface these differently. */
  fail(message: string): void;
  clearError(): void;
}

export interface RosterPanel {
  /** `null` means "whichever department my own seat sits in" — the server resolves it. */
  show(departmentId: string | null): Promise<void>;
}

export function mountRoster(host: RosterHost): RosterPanel {
  let current: string | null = null;

  /**
   * Same guard as the console's tabs: only the newest render may paint.
   *
   * An administrator switching between departments faster than the requests return would
   * otherwise see whichever answered last, attributed to whichever they clicked last. On a
   * screen full of phone numbers that is not a cosmetic problem.
   */
  let generation = 0;

  async function api<T>(method: string, path: string, payload?: unknown): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      host.fail('Could not reach the server. Nothing was changed.');
      return null;
    }

    const raw = await res.text();
    const parsed: unknown = raw === '' ? {} : JSON.parse(raw);

    if (!res.ok) {
      host.fail(
        (parsed as { error?: string }).error ?? `The server refused that (${String(res.status)}).`,
      );
      return null;
    }
    host.clearError();
    return parsed as T;
  }

  const reload = (): void => void show(current);

  function link(label: string, onClick: () => void, danger = false): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = danger ? 'link danger' : 'link';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Confirm a destructive action, then run it. The server and the config log still
   * require a reason (INV-06 — the actor, the seat and the time are what that invariant
   * is about); the console supplies a fixed one so the operator only has to confirm,
   * and is never asked to type an excuse for an ordinary edit.
   */
  function confirmThen(
    message: string,
    reason: string,
    run: (reason: string) => Promise<unknown>,
  ): () => void {
    return () => {
      if (!confirm(message)) return;
      void (async () => {
        const done = await run(reason);
        if (done !== null) reload();
      })();
    };
  }

  function personLine(person: RosterPerson): HTMLElement {
    const line = document.createElement('span');
    line.className = 'holder';
    line.dataset['placeholder'] = String(person.placeholder);
    line.append(text('span', 'pname', person.fullName));
    line.append(text('span', 'pphone', person.phone));

    if (person.placeholder) {
      // The number is a stand-in. Said in words, on the row, because the whole hazard of a
      // placeholder is that it looks exactly like a contact.
      line.append(text('strong', 'warn', 'placeholder number — nothing will be sent here'));
    }
    if (person.hasAccount) line.append(text('span', 'tag', 'can sign in'));
    return line;
  }

  function postCard(view: RosterView, post: RosterPost): HTMLElement {
    const card = document.createElement('article');
    card.className = 'post';
    card.dataset['post'] = post.seatId;
    card.dataset['retired'] = String(post.retiredAt !== null);

    const head = document.createElement('header');
    head.append(text('h4', 'title', post.title));
    if (post.tier !== 'station') head.append(text('span', 'tag', post.tier));
    if (post.retiredAt !== null) head.append(text('span', 'tag retired', 'retired'));
    card.append(head);

    if (post.holder === null) {
      if (post.retiredAt === null) {
        // The gap this whole screen exists to close. An alert addressed to this post reaches
        // nobody, and the escalation ladder is designed to surface that rather than swallow
        // it (ADR-0004).
        card.append(
          text('p', 'nobody', 'Nobody holds this designation — an alert sent here reaches no one'),
        );
      }
    } else {
      card.append(personLine(post.holder));
    }

    if (!view.editable || post.retiredAt !== null) {
      if (post.retiredAt !== null && view.editable) {
        card.append(
          link(
            'Bring back',
            confirmThen(
              `Bring ${post.title} back? It becomes selectable again.`,
              'Restored from the console',
              (reason) => api('POST', `/roster/posts/${post.seatId}/restore`, { reason }),
            ),
          ),
        );
      }
      return card;
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    // Putting somebody in the post. Only people already on this department's roster, so a
    // department cannot reach across and staff itself from somebody else's list.
    const assignable = view.people.filter((p) => p.personId !== post.holder?.personId);
    if (assignable.length > 0) {
      const picker = document.createElement('select');
      picker.className = 'assign';
      picker.setAttribute('aria-label', `Put somebody in ${post.title}`);
      picker.append(new Option(post.holder === null ? 'Put somebody in…' : 'Hand over to…', ''));
      for (const p of assignable) picker.append(new Option(p.fullName, p.personId));
      picker.addEventListener('change', () => {
        if (picker.value === '') return;
        void (async () => {
          const done = await api('POST', `/roster/posts/${post.seatId}/assign`, {
            personId: picker.value,
          });
          if (done !== null) reload();
        })();
      });
      actions.append(picker);
    }

    actions.append(
      link('Rename', () => {
        const title = prompt('New title for this designation', post.title);
        if (title === null || title.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/posts/${post.seatId}`, { title });
          if (done !== null) reload();
        })();
      }),
    );

    if (post.holder !== null) {
      actions.append(
        link(
          'Take off this designation',
          confirmThen(
            `Take ${post.holder.fullName} off ${post.title}?`,
            'Reassigned from the console',
            (reason) => api('POST', `/roster/posts/${post.seatId}/relieve`, { reason }),
          ),
          true,
        ),
      );
    }

    actions.append(
      link(
        'Retire designation',
        confirmThen(
          `Retire ${post.title}? Its holder comes off it and it leaves every screen. It stays in the record.`,
          'Retired from the console',
          (reason) => api('POST', `/roster/posts/${post.seatId}/retire`, { reason }),
        ),
        true,
      ),
    );

    card.append(actions);
    return card;
  }

  function personCard(view: RosterView, person: RosterPerson): HTMLElement {
    const card = document.createElement('article');
    card.className = 'rosterperson';
    card.dataset['person'] = person.personId;
    card.append(personLine(person));

    if (!view.editable) return card;

    const actions = document.createElement('div');
    actions.className = 'actions';

    actions.append(
      link('Change number', () => {
        const phone = prompt(`Number for ${person.fullName}`, person.phone);
        if (phone === null || phone.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/people/${person.personId}`, { phone });
          if (done !== null) reload();
        })();
      }),
      link('Rename', () => {
        const fullName = prompt('Name', person.fullName);
        if (fullName === null || fullName.trim() === '') return;
        void (async () => {
          const done = await api('PATCH', `/roster/people/${person.personId}`, { fullName });
          if (done !== null) reload();
        })();
      }),
    );

    if (!person.hasAccount) {
      // A second, deliberate act — never folded into "add a person". See rule 3 in the
      // header: an account for somebody who has not been told the system exists is a
      // password nobody chose, on an account nobody watches.
      actions.append(
        link('Give a login', () => {
          if (
            !confirm(
              `Give ${person.fullName} a login?\n\nOnly do this if you have spoken to them. ` +
                'They will be able to sign in and act on emergencies.',
            )
          ) {
            return;
          }
          const password = prompt('A starting password — at least 12 characters');
          if (password === null || password.length < 12) return;
          void (async () => {
            const done = await api('POST', `/roster/people/${person.personId}/account`, {
              password,
            });
            if (done !== null) reload();
          })();
        }),
      );
    }

    actions.append(
      link(
        'Remove',
        confirmThen(
          `Remove ${person.fullName}?\n\nThey stay in the record; they stop being someone to notify.`,
          'Removed from the console',
          (reason) => api('POST', `/roster/people/${person.personId}/remove`, { reason }),
        ),
        true,
      ),
    );

    card.append(actions);
    return card;
  }

  function addPersonForm(view: RosterView): HTMLElement {
    const form = document.createElement('form');
    form.className = 'addperson';
    form.innerHTML = `
      <input type="text" class="pn" placeholder="Name" aria-label="Name" required />
      <input type="text" class="pp" placeholder="Phone number" aria-label="Phone number" required />
      <select class="ps" aria-label="Put them in a post">
        <option value="">No post yet</option>
      </select>
      <label class="ph"><input type="checkbox" class="pc" /> stand-in number</label>
      <button type="submit">Add person</button>`;

    const picker = form.querySelector<HTMLSelectElement>('.ps')!;
    for (const p of view.posts.filter((p) => p.retiredAt === null && p.holder === null)) {
      picker.append(new Option(p.title, p.seatId));
    }

    /**
     * "Somebody with that name is already here" — M10-35.
     *
     * ⚠️ **This form can only see its own department, and the wording says so.** The roster is
     * loaded one department at a time, so `view.people` is this department's officers and nothing
     * else. A sentence implying the district had been checked would be **worse than no warning**:
     * it would be read as *"nobody else has this number"*, which this screen cannot know. The
     * recipient picker's copy of this check does see the whole district, and says that instead.
     *
     * It warns and never refuses. Two officers in Bajaur share one handset (Q-19, migration 0006),
     * so a form that refused a repeated number could not enter the district's own roster.
     */
    const nameInput = form.querySelector<HTMLInputElement>('.pn')!;
    const phoneInput = form.querySelector<HTMLInputElement>('.pp')!;
    const duplicate = text('p', 'note dupe', '');
    duplicate.hidden = true;

    function checkDuplicate(): void {
      const match = findDuplicate(
        nameInput.value,
        phoneInput.value,
        view.people.map((p) => ({ name: p.fullName, phone: p.phone })),
      );
      duplicate.hidden = match === null;
      duplicate.textContent = match === null ? '' : duplicateSentence(match, 'department');
    }

    nameInput.addEventListener('input', checkDuplicate);
    phoneInput.addEventListener('input', checkDuplicate);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const fullName = form.querySelector<HTMLInputElement>('.pn')!.value.trim();
      const phone = form.querySelector<HTMLInputElement>('.pp')!.value.trim();
      const seatId = picker.value;
      const placeholder = form.querySelector<HTMLInputElement>('.pc')!.checked;
      if (fullName === '' || phone === '') return;

      void (async () => {
        const done = await api('POST', '/roster/people', {
          fullName,
          phone,
          placeholder,
          ...(seatId === '' ? {} : { seatId }),
        });
        if (done !== null) reload();
      })();
    });

    form.append(duplicate);
    return form;
  }

  function addPostForm(): HTMLElement {
    const form = document.createElement('form');
    form.className = 'addpost';
    form.innerHTML = `
      <input type="text" class="tt" placeholder="New designation, e.g. Station Officer" aria-label="Designation" required />
      <button type="submit">Add designation</button>`;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = form.querySelector<HTMLInputElement>('.tt')!.value.trim();
      if (title === '') return;
      void (async () => {
        const done = await api('POST', '/roster/posts', { title });
        if (done !== null) reload();
      })();
    });
    return form;
  }

  async function show(departmentId: string | null): Promise<void> {
    generation += 1;
    const mine = generation;
    current = departmentId;

    host.container.replaceChildren(text('p', 'meta', 'Loading…'));

    // ADR-0031 phase 3: one flat roster, one route — `/roster/:dept` is gone. `departmentId`
    // is still tracked as `current` above but no longer shapes the request.
    const view = await api<RosterView>('GET', '/roster');
    if (view === null || mine !== generation) return;

    const wrap = document.createElement('div');
    wrap.id = 'rosterBody';
    // The scope segment is decorative — see `DISTRICT_SCOPE`. Two suites read this attribute.
    wrap.dataset['department'] = view.departmentId ?? DISTRICT_SCOPE;

    wrap.append(text('h3', 'rostername', view.departmentName));

    if (view.unreachablePosts > 0) {
      // Above everything. A post nothing can reach is not a tidy-up job — it is an alert
      // that will be recorded as failed on the night somebody needed it.
      const n = view.unreachablePosts;
      wrap.append(
        text(
          'p',
          'unreachable',
          `${String(n)} post${n === 1 ? '' : 's'} cannot be reached — empty, or holding a ` +
            'stand-in number. An alert sent to one is recorded as failed.',
        ),
      );
    }

    /**
     * The cards go in their own container so a wide screen can lay them out in columns.
     *
     * The heading and the add form stay outside it: a form stretched across three columns is
     * harder to fill in, and an empty-state sentence broken into a narrow column reads as a
     * card rather than as an explanation.
     */
    wrap.append(text('h4', 'sectionhead', 'Designations'));
    if (view.editable) wrap.append(addPostForm());
    if (view.posts.length === 0) {
      wrap.append(
        text(
          'p',
          'nobody',
          'This department has no designations, so nothing can ever be sent to it.',
        ),
      );
    }
    const posts = document.createElement('div');
    posts.className = 'rosterposts';
    for (const post of view.posts) posts.append(postCard(view, post));
    wrap.append(posts);

    wrap.append(text('h4', 'sectionhead', 'People'));
    if (view.editable) wrap.append(addPersonForm(view));
    if (view.people.length === 0) wrap.append(text('p', 'meta', 'Nobody on this roster yet.'));
    const people = document.createElement('div');
    people.className = 'rosterpeople';
    for (const person of view.people) people.append(personCard(view, person));
    wrap.append(people);

    if (mine === generation) host.container.replaceChildren(wrap);
  }

  return { show };
}
