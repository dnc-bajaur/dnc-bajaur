/**
 * Groups over HTTP — M7-09, M7-13.
 *
 * The console's half of the sets an operator ticks at intake. Four routes, all under `/admin`
 * because a group is a **district configuration**, not an operational act: creating one is the
 * same kind of decision as writing a routing signal, and it belongs to the two offices.
 *
 * ## What each route hands back, and why it is the whole list
 *
 * Every one of these returns the full group list rather than the row it touched. A console that
 * patched its own state from a response is a console that eventually disagrees with the
 * database about what the district's groups are — and the moment that matters is the moment an
 * operator ticks one at 02:00. One round trip is not worth that.
 *
 * ## The members are returned resolved, and unreachable ones are marked
 *
 * M7-12: a member that reaches nobody is shown, marked, and left in the group. Filtering it out
 * would hide a vacancy from the one person about to notice it, and would let a **vacant post
 * disappear inside a group** — which is `collapseSelection`'s failure mode with a bigger blast
 * radius, because a group is precisely the thing somebody ticks without reading the six names.
 */

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import type { RecipientKind, Uuid } from '../domain/events.js';
import { listGroups, retireGroup, saveGroup, type GroupMember } from '../db/groupStore.js';
import { validatePicture } from '../domain/picture.js';
import type { Recipient } from '../domain/recipients.js';
import { requireAdministration, type AdminResult } from './admin.js';
import { listDirectory } from './contacts.js';
import { loadDispatchHistory } from '../db/dispatchHistory.js';
import { groupSuggestions } from '../domain/learning.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly RecipientKind[] = ['post', 'person'];

/** A group as the console shows it: members with names, and why any of them is unreachable. */
export interface GroupView {
  readonly groupId: Uuid;
  readonly name: string;
  /** A `data:` URI or null — the group's photo (2026-09-01). The console renders it, cards and drawer. */
  readonly picture: string | null;
  readonly members: readonly {
    readonly kind: RecipientKind;
    readonly id: Uuid;
    /** The id itself when the directory does not know it — never blank. See below. */
    readonly label: string;
    /** Null when this member can be reached. A sentence, not a code. */
    readonly unreachable: string | null;
    /**
     * True when the member no longer names anything live — a retired department, an abolished
     * post, a removed officer.
     *
     * A different fact from `unreachable`, and the difference is what the district does about
     * it: an unreachable member needs somebody appointed or a number filled in, a **missing**
     * one needs taking out of the group. Merging them would leave a group quietly one member
     * short with a screen implying somebody could still be rung.
     */
    readonly missing: boolean;
  }[];
}

function refuse<T>(status: number, error: string): AdminResult<T> {
  return { ok: false, status, error };
}

export async function groupsForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<readonly GroupView[]>> {
  const denied = requireAdministration<readonly GroupView[]>(identity);
  if (denied !== null) return denied;

  return { ok: true, value: await describe(pool, await listGroups(pool)) };
}

/** A set the district keeps choosing together, offered for saving — M7-21. */
export interface SuggestedGroup {
  readonly members: readonly {
    readonly kind: RecipientKind;
    readonly id: Uuid;
    readonly label: string;
  }[];
  readonly times: number;
  readonly because: string;
}

/**
 * *"You have chosen these six together four times — save as a group?"* — M7-21.
 *
 * A suggestion and never an action, for the same reason a learned proposal pre-ticks rather
 * than routes (M7-17): a group the software created is a group nobody named, and a name is what
 * makes it recognisable at 02:00. Somebody presses Save, or nobody does.
 *
 * Returned from the console rather than pushed at intake. The operator on a telephone call has
 * no business being asked to make a configuration decision; the person in the console does.
 */
export async function suggestedGroupsForConsole(
  pool: Pool,
  identity: Identity,
): Promise<AdminResult<readonly SuggestedGroup[]>> {
  const denied = requireAdministration<readonly SuggestedGroup[]>(identity);
  if (denied !== null) return denied;

  const [history, saved, directory] = await Promise.all([
    loadDispatchHistory(pool),
    listGroups(pool),
    listDirectory(pool),
  ]);

  const known = new Map(directory.recipients.map((r) => [`${r.kind}:${r.id}`, r]));

  return {
    ok: true,
    value: groupSuggestions(
      history,
      saved.map((g) => g.members),
    ).map((s) => ({
      times: s.times,
      because: s.because,
      members: s.members.map((m) => {
        const row = known.get(`${m.kind}:${m.id}`);
        return {
          kind: m.kind,
          id: m.id,
          // The id when the directory has forgotten them, never blank — a suggestion showing a
          // gap where a name should be is a suggestion nobody can judge.
          label: row === undefined ? m.id : memberLabel(row),
        };
      }),
    })),
  };
}

export async function saveGroupForConsole(
  pool: Pool,
  identity: Identity,
  input: Record<string, unknown>,
  groupId?: string,
): Promise<AdminResult<readonly GroupView[]>> {
  const denied = requireAdministration<readonly GroupView[]>(identity);
  if (denied !== null) return denied;

  const name = typeof input['name'] === 'string' ? input['name'].trim() : '';
  if (name === '') return refuse(400, 'give the group a name somebody will recognise at 02:00');
  if (name.length > 120) return refuse(400, 'that name is too long (120 characters)');

  const members = parseMembers(input['members']);
  if (typeof members === 'string') return refuse(400, members);

  if (groupId !== undefined && !UUID_RE.test(groupId)) return refuse(404, 'no such group');

  // `picture` absent → leave whatever is there. Present (a data: URI or null) → judged and written.
  let picture: string | null | undefined;
  if ('picture' in input) {
    const judged = validatePicture(input['picture']);
    if (!judged.ok) return refuse(400, judged.why);
    picture = judged.value;
  }

  const result = await saveGroup(
    pool,
    {
      ...(groupId === undefined ? {} : { groupId }),
      name,
      members,
      ...(picture === undefined ? {} : { picture }),
    },
    {
      seatId: identity.seatId,
      personId: identity.personId,
      ...(typeof input['reason'] === 'string' && input['reason'].trim() !== ''
        ? { reason: input['reason'].trim() }
        : {}),
    },
  );

  if (!result.ok) {
    if (result.problem.kind === 'name_taken') {
      return refuse(409, `there is already a group called “${name}”`);
    }
    if (result.problem.kind === 'no_such_group') return refuse(404, 'no such group');
    return refuse(
      400,
      `that ${result.problem.member.kind} no longer exists — take it out and save again`,
    );
  }

  return { ok: true, value: await describe(pool, await listGroups(pool)) };
}

export async function retireGroupForConsole(
  pool: Pool,
  identity: Identity,
  groupId: string,
  reason: unknown,
): Promise<AdminResult<readonly GroupView[]>> {
  const denied = requireAdministration<readonly GroupView[]>(identity);
  if (denied !== null) return denied;

  if (!UUID_RE.test(groupId)) return refuse(404, 'no such group');

  const done = await retireGroup(pool, groupId, {
    seatId: identity.seatId,
    personId: identity.personId,
    ...(typeof reason === 'string' && reason.trim() !== '' ? { reason: reason.trim() } : {}),
  });
  if (!done.ok) return refuse(404, 'no such group');

  return { ok: true, value: await describe(pool, await listGroups(pool)) };
}

/**
 * Members, or the sentence to hand back.
 *
 * Duplicates within a group are dropped here rather than refused. Ticking Rescue twice in one
 * group is a slip with an obvious intention and no consequence — the table's primary key would
 * reject the second write anyway, and turning that into an error message would make the console
 * fail on something it could simply do.
 */
function parseMembers(raw: unknown): readonly GroupMember[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'members must be a list';

  const seen = new Set<string>();
  const out: GroupMember[] = [];

  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return 'every member must be an object';
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    const id = record['id'];
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      return `kind must be one of ${KINDS.join(', ')}`;
    }
    if (typeof id !== 'string' || !UUID_RE.test(id)) return 'each member id must be a uuid';

    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as RecipientKind, id });
  }

  return out;
}

/**
 * Put names and reachability on the members, from the directory the intake screen already uses.
 *
 * `listDirectory` and nothing else, deliberately. If this module worked out reachability for
 * itself, a post could read as fine in the group editor and unreachable at intake — two answers
 * to one question, and the district would trust whichever screen they happened to be looking at.
 *
 * ⚠️ **`listDirectory`, not `listRecipients`, since the flat contact directory (2026-08-22).**
 * The picker offers contacts only; a group saved before that may hold a `department` or a
 * `person` member, and those still have to be **named**. Read through the narrower list they
 * would come back `missing`, and `missing` prints a raw uuid over a district's own saved set —
 * the exact reading the rule below says must never be available.
 */
async function describe(
  pool: Pool,
  groups: readonly {
    groupId: Uuid;
    name: string;
    picture: string | null;
    members: readonly GroupMember[];
  }[],
): Promise<readonly GroupView[]> {
  if (groups.length === 0) return [];

  const directory = await listDirectory(pool);
  const known = new Map(directory.recipients.map((r) => [`${r.kind}:${r.id}`, r]));

  return groups.map((group) => ({
    groupId: group.groupId,
    name: group.name,
    picture: group.picture,
    members: group.members.map((member) => {
      const row = known.get(`${member.kind}:${member.id}`);
      return {
        kind: member.kind,
        id: member.id,
        // An id with no name is shown **as an id**, never blank. A blank row in a list of who
        // gets told reads as nobody, which is the one reading that must never be available.
        label: row === undefined ? member.id : memberLabel(row),
        unreachable: row === undefined ? null : wordsFor(row.unreachable),
        missing: row === undefined,
      };
    }),
  }));
}

/**
 * *"Name — Post"*, so a member reads the way a phone's contact list does — 2026-09-01.
 *
 * The district asked that opening the directory to add somebody shows **who they are and what
 * they hold**, not the post alone. A `post` row carries its holder's name; a `person` row
 * carries the designation they hold in that department. Whichever field is missing — a vacant
 * post, a contact with no designation — falls back to the one thing the row has, never a blank.
 */
function memberLabel(row: Recipient): string {
  if (row.kind === 'post') {
    return row.holderName ? `${row.holderName} — ${row.label}` : row.label;
  }
  if (row.kind === 'person') {
    return row.designation ? `${row.label} — ${row.designation}` : row.label;
  }
  return row.label;
}

/** The same four sentences the intake screen shows. Each one names a different fix. */
function wordsFor(reason: string | null): string | null {
  if (reason === 'vacant') return 'nobody holds this designation';
  if (reason === 'disabled') return "the holder's account is disabled";
  if (reason === 'placeholder') return 'this holds a stand-in number, not a real one';
  if (reason === 'no_number') return 'no number on file';
  return null;
}
