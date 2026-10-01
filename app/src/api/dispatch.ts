/**
 * The control room chooses who should know — M6-04, ADR-0016.
 *
 * This is the command the whole of M6 exists for. Today an alert reaches Bajaur's control room
 * by telephone, an operator writes it in a paper register and forwards it by hand on a personal
 * WhatsApp, forty times a day — and **nothing about who was told survives past the notebook.**
 * This endpoint is the thing that makes *"who was told about this, and did they respond?"* a
 * question the district can answer six months later.
 *
 * ## Why it is not part of intake
 *
 * It would be one fewer round trip, and it would break INV-01. `POST /incidents` **cannot
 * refuse**: an empty body, nonsense severity and unparseable JSON all produce a stored report,
 * because the thing on the other end is somebody saying an emergency is happening. A dispatch
 * *can* refuse — a post that does not exist is a typo, and accepting it silently would
 * record that somebody was told who cannot be. Folding a command that refuses into one that
 * must not leaves two bad options: intake starts refusing, or dispatch failures are swallowed
 * on the one screen that needed to see them.
 *
 * So: report first, then dispatch. The report is safe before the selection is even validated,
 * which is the same ordering `submit first, enrich after` already uses on the handset (M0-36).
 *
 * ## What it is careful about
 *
 * **Authority is the policy table, never a role comparison** (ADR-0003, INV-05). `incident.dispatch`
 * is a row like any other.
 *
 * **The selection is collapsed before it is recorded**, so one emergency is one message per
 * person — and what was absorbed is recorded *with what absorbed it*, never dropped. An operator
 * who ticks four things and watches three go stops trusting the control.
 *
 * **An unreachable target is dispatched to anyway.** Selecting a vacant post records that
 * somebody was owed a message and did not get one, which surfaces on the board. Refusing it
 * here would produce silence, and silence reads as everybody having been told (ADR-0004,
 * ADR-0005).
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import { defaultRules, evaluateRead, evaluateWrite } from '../domain/authority.js';
import type { DispatchTarget, IncidentEvent, RecipientKind, Uuid } from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { collapseSelection, effectiveTargets, type ResolvedTarget } from '../domain/recipients.js';
import { listGroups } from '../db/groupStore.js';
import { seatOf } from './lifecycle.js';
import type { Identity } from '../auth/sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KINDS: readonly RecipientKind[] = ['post', 'person'];

export interface DispatchInput {
  readonly targets?: unknown;
  /**
   * Group ids the operator ticked — M7-10. Expanded here, into `targets`, before anything else
   * looks at the selection.
   *
   * Sent alongside `targets` rather than as a fourth `kind`, deliberately. A group is a
   * shorthand for a selection, not a thing that can be told anything: making it a
   * `RecipientKind` would push it into `collapseSelection`, `obligationsFor`, `targetKey` and
   * the notification ledger, all of which would then have to keep answering "and what if it is
   * a group?" for a concept that stops existing one line into this function.
   */
  readonly groups?: unknown;
  readonly proposed?: unknown;
  /** What the district's own history proposed. Recorded apart from `proposed` — see the event. */
  readonly learned?: unknown;
  readonly reason?: unknown;
}

/** One line of what happened to one thing the operator ticked. */
export interface DispatchOutcome {
  readonly kind: RecipientKind;
  readonly id: Uuid;
  /** The department name, the post title, or the officer's name. */
  readonly label: string;
  /** Null when this one is actually being told; otherwise what covered it. */
  readonly coveredBy: {
    readonly kind: RecipientKind;
    readonly id: Uuid;
    readonly label: string;
  } | null;
  /**
   * Why nobody will be reached, when nobody will be.
   *
   * Reported and **not** refused. See the header: a vacancy the district can see is a vacancy
   * the district can fill, and one it cannot see swallows an obligation in silence.
   */
  readonly unreachable: string | null;
}

export interface DispatchValue {
  readonly incidentId: Uuid;
  readonly outcomes: readonly DispatchOutcome[];
  readonly state: IncidentState;
}

export type DispatchResult =
  | { readonly ok: true; readonly value: DispatchValue }
  | { readonly ok: false; readonly status: number; readonly error: string };

function refuse(status: number, error: string): DispatchResult {
  return { ok: false, status, error };
}

/**
 * Parse the selection, refusing anything that cannot mean a real recipient.
 *
 * Duplicates are kept rather than stripped — `collapseSelection` owns that, and doing it in two
 * places is how the two answers eventually differ.
 */
function parseTargets(raw: unknown, what: string): readonly DispatchTarget[] | string {
  if (!Array.isArray(raw)) return `${what} must be a list`;

  const out: DispatchTarget[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return `every ${what} entry must be an object`;
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    const id = record['id'];
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
      return `kind must be one of ${KINDS.join(', ')}`;
    }
    if (typeof id !== 'string' || !UUID_RE.test(id)) return 'each id must be a uuid';
    out.push({ kind: kind as RecipientKind, id });
  }
  return out;
}

/** A list of uuids, or the sentence to hand back. Absent is an empty list, never an error. */
function parseIds(raw: unknown): readonly Uuid[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'groups must be a list of ids';
  const out: Uuid[] = [];
  for (const id of raw as readonly unknown[]) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return 'each group id must be a uuid';
    out.push(id);
  }
  return out;
}

/**
 * Turn group ids into their members, as they stand right now.
 *
 * **A group that does not exist refuses the whole dispatch**, for the same reason a missing
 * department does: an operator told "three of your four went" has to work out which, on a
 * telephone call, and the failure mode of guessing is that somebody is not told at all. Here it
 * is worse than for a single target — a group is precisely the thing an operator ticks *without*
 * reading the six names, so a silently dropped one is a silently dropped six.
 */
async function expand(
  pool: Pool,
  groupIds: readonly Uuid[],
): Promise<
  | { readonly ok: true; readonly groups: readonly ExpandedGroup[] }
  | { readonly ok: false; readonly error: string }
> {
  const all = await listGroups(pool);
  const byId = new Map(all.map((g) => [g.groupId, g]));

  const groups: ExpandedGroup[] = [];
  for (const id of groupIds) {
    const group = byId.get(id);
    if (group === undefined) return { ok: false, error: `no such group: ${id}` };
    groups.push({
      groupId: group.groupId,
      name: group.name,
      members: group.members.map((m) => ({ kind: m.kind, id: m.id })),
    });
  }
  return { ok: true, groups };
}

interface ExpandedGroup {
  readonly groupId: Uuid;
  readonly name: string;
  readonly members: readonly DispatchTarget[];
}

interface Directory {
  /** Every id that exists and is selectable, with what to call it. */
  readonly labels: ReadonlyMap<string, string>;
  /** Selectable ids that would reach nobody, with why. */
  readonly unreachable: ReadonlyMap<string, string>;
  readonly departmentOfPost: ReadonlyMap<Uuid, Uuid | null>;
  readonly postsOfPerson: ReadonlyMap<Uuid, readonly Uuid[]>;
  /** seatId → who holds it. What tells `collapseSelection` two designations are one handset. */
  readonly holderOfPost: ReadonlyMap<Uuid, Uuid | null>;
}

/**
 * Everything needed to validate, collapse and describe a selection — in three queries.
 *
 * Three and not one per target. The control room ticks a handful of things but the district has
 * 79 offices and 81 posts, and a per-target round trip on the machine that is also accepting
 * emergency reports is the shape `listRecipients` was written to avoid.
 */
async function directory(pool: Pool): Promise<Directory> {
  /**
   * ADR-0030 — there is no department query any more, and `departments` is empty.
   *
   * It fed `labels` so that a department-kinded target on the district's own past record could
   * still be NAMED, and `departmentOfPost` so that `collapseSelection` could absorb a post into
   * the department that held it. Migration 0039 dropped the table, so both answers are now the
   * same one: nothing.
   *
   * ⚠️ **`collapseSelection` is untouched and still runs.** What it can no longer collapse is a
   * post into a department — because neither the selection nor the directory carries one. It
   * still absorbs a PERSON into a post they hold, which is the case that actually fires on this
   * district's flat contact list and is what stops one handset being messaged twice.
   */
  const departments = { rows: [] as { department_id: string; name: string }[] };
  const [posts, people] = await Promise.all([
    pool.query<{
      seat_id: string;
      title: string;
      department_id: string | null;
      person_id: string | null;
      placeholder: boolean | null;
      disabled_at: string | null;
      phone: string | null;
    }>(
      `SELECT s.seat_id, s.title, NULL::uuid AS department_id,
              p.person_id, p.placeholder, p.disabled_at, p.phone
         FROM seat s
         LEFT JOIN duty_assignment a
                ON a.seat_id = s.seat_id
               AND a.from_at <= now()
               AND (a.to_at IS NULL OR a.to_at > now())
         LEFT JOIN person p ON p.person_id = a.person_id AND p.removed_at IS NULL
        WHERE s.retired_at IS NULL`,
    ),
    pool.query<{
      person_id: string;
      full_name: string;
      phone: string | null;
      placeholder: boolean | null;
      disabled_at: string | null;
    }>(
      `SELECT person_id, full_name, phone, placeholder, disabled_at
         FROM person
        WHERE removed_at IS NULL`,
    ),
  ]);

  const labels = new Map<string, string>();
  const unreachable = new Map<string, string>();
  const departmentOfPost = new Map<Uuid, Uuid | null>();
  const postsOfPerson = new Map<Uuid, Uuid[]>();
  const holderOfPost = new Map<Uuid, Uuid | null>();

  for (const d of departments.rows) labels.set(`department:${d.department_id}`, d.name);

  for (const s of posts.rows) {
    labels.set(`post:${s.seat_id}`, s.title);
    departmentOfPost.set(s.seat_id, s.department_id);
    holderOfPost.set(s.seat_id, s.person_id);

    if (s.person_id !== null) {
      const held = postsOfPerson.get(s.person_id) ?? [];
      held.push(s.seat_id);
      postsOfPerson.set(s.person_id, held);
    }

    // Deliberately the same order as `reachabilityOf`: a vacant post is reported vacant even
    // though it also has no number, because "nobody holds this" is the fact to act on and "no
    // number" is merely its consequence.
    const why =
      s.person_id === null
        ? 'nobody holds this designation'
        : s.disabled_at !== null
          ? "the holder's account is disabled"
          : s.placeholder === true
            ? 'this designation holds a stand-in number, not a real one'
            : (s.phone ?? '').trim() === ''
              ? 'the holder has no number on file'
              : null;
    if (why !== null) unreachable.set(`post:${s.seat_id}`, why);
  }

  for (const p of people.rows) {
    labels.set(`person:${p.person_id}`, p.full_name);
    const why =
      p.disabled_at !== null
        ? 'this account is disabled'
        : p.placeholder === true
          ? 'this is a stand-in entry, not a real officer'
          : (p.phone ?? '').trim() === ''
            ? 'this officer has no number on file'
            : null;
    if (why !== null) unreachable.set(`person:${p.person_id}`, why);
  }

  return { labels, unreachable, departmentOfPost, postsOfPerson, holderOfPost };
}

export interface DispatchOptions {
  readonly now?: string;
}

/**
 * Record who the control room chose to tell.
 *
 * Order is the same as every other command: exist, may-you-see-it, does-it-make-sense,
 * may-you-do-it — then append. A caller with no authority over an incident learns that it
 * exists and nothing more, and one who cannot read it learns nothing at all.
 */
export async function dispatchTo(
  pool: Pool,
  incidentId: Uuid,
  input: DispatchInput,
  identity: Identity,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const seat = seatOf(identity);

  const ticked = input.targets === undefined ? [] : parseTargets(input.targets, 'targets');
  if (typeof ticked === 'string') return refuse(400, ticked);

  const groupIds = parseIds(input.groups);
  if (typeof groupIds === 'string') return refuse(400, groupIds);

  /**
   * Groups are expanded **before** the selection is validated or collapsed — M7-10, M7-11.
   *
   * Which buys both of the rules the plan asks for, for free and in one place. A group
   * containing Rescue plus a separate tick of Rescue collapses to one message, because by the
   * time `collapseSelection` runs there is no such thing as a group. And an unreachable member
   * is offered, marked and dispatched to exactly like any other selection, because it *is* one
   * — a group must never be a way for a vacant post to disappear (M7-12, ADR-0004).
   */
  const expanded =
    groupIds.length === 0 ? { ok: true as const, groups: [] } : await expand(pool, groupIds);
  if (!expanded.ok) return refuse(404, expanded.error);

  const selected: readonly DispatchTarget[] = [
    ...ticked,
    ...expanded.groups.flatMap((g) => g.members),
  ];
  if (selected.length === 0) return refuse(400, 'name at least one person or post');

  const proposed = input.proposed === undefined ? [] : parseTargets(input.proposed, 'proposed');
  const learned = input.learned === undefined ? [] : parseTargets(input.learned, 'learned');
  if (typeof learned === 'string') return refuse(400, learned);
  if (typeof proposed === 'string') return refuse(400, proposed);

  const reason =
    typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null;

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  // A refused read is a 404, never a 403. Confirming an incident exists is itself a disclosure
  // about another department's operations.
  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  if (state.status === 'closed') {
    return refuse(409, 'incident is closed; reopen it before telling anybody else');
  }

  const rule = defaultRules(state.responsibleDepartmentIds[0] ?? null).find(
    (r) => r.fieldKey === 'incident.dispatch',
  );
  // Fails closed. A command naming a field with no rule is refused rather than allowed — an
  // unknown field is not an unrestricted one.
  if (rule === undefined) return refuse(403, 'no authority rule governs incident.dispatch');

  const decision = evaluateWrite(rule, {
    fieldKey: 'incident.dispatch',
    seat,
    ...(reason === null ? {} : { reason }),
  });
  if (!decision.allowed) return refuse(403, decision.why);

  const dir = await directory(pool);

  /**
   * A target that does not exist is refused, and the whole dispatch with it.
   *
   * Not partially applied. An operator told "three of your four went" has to work out which,
   * on a telephone call, at 02:00 — and the failure mode of guessing is that somebody is not
   * told at all. Refusing the lot is recoverable in one tap; a half-applied dispatch is not
   * recoverable at all, because the half that went cannot be unsent.
   */
  for (const target of selected) {
    if (!dir.labels.has(`${target.kind}:${target.id}`)) {
      return refuse(404, `no such ${target.kind}: ${target.id}`);
    }
  }

  /**
   * 🔴 **`holderOfPost` WAS BUILT, RETURNED, AND NEVER HANDED OVER — so the post-against-post
   * collapse has never once run on the dispatch path.**
   *
   * `collapseSelection` takes it as OPTIONAL, which is what let the omission compile and what
   * kept it quiet: with the map absent the rule simply does not fire, every screen looks right,
   * and the only symptom is an officer's handset buzzing twice for one emergency. It was masked
   * until now because a department absorbed its own posts one line above — and ADR-0030 removed
   * the department, so from migration 0039 onward **nothing** collapses two designations held by
   * one person. Four of Bajaur's officers are two contacts (M10-05); ticking both is the obvious
   * thing to do on a flat picker.
   */
  const resolved: readonly ResolvedTarget[] = collapseSelection(selected, {
    departmentOfPost: dir.departmentOfPost,
    postsOfPerson: dir.postsOfPerson,
    holderOfPost: dir.holderOfPost,
  });

  const targets = effectiveTargets(resolved);
  const absorbed = resolved
    .filter((t): t is ResolvedTarget & { coveredBy: DispatchTarget } => t.coveredBy !== null)
    .map((t) => ({
      target: { kind: t.kind, id: t.id },
      coveredBy: { kind: t.coveredBy.kind, id: t.coveredBy.id },
    }));

  const now = options.now ?? new Date().toISOString();

  const event = {
    eventId: randomUUID(),
    incidentId,
    type: 'dispatched',
    occurredAt: now,
    recordedAt: now,
    clientSeq: state.eventCount + 1,
    // Stamped from the session. Who decided this is the entire point of the event.
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web',
    payload: {
      targets,
      ...(absorbed.length > 0 ? { absorbed } : {}),
      ...(proposed.length > 0 ? { proposed } : {}),
      ...(learned.length > 0 ? { learned } : {}),
      ...(reason === null ? {} : { reason }),
      // Copied, never referenced. See the payload's own note: a group edited next month must
      // not change who last month's incident says was told.
      ...(expanded.groups.length > 0 ? { fromGroups: expanded.groups } : {}),
    },
  } as unknown as IncidentEvent;

  const events2: IncidentEvent[] = [event];

  /**
   * A dispatch on an emergency **nobody holds** is the human assignment ADR-0010 asks for.
   *
   * This was the sharpest thing missing, and it read as the product being broken: an operator
   * chose Rescue 1122, told them, and the board went on saying *"nobody has this"* with the
   * dashboard counting it as unassigned. Both statements were true of the data and neither was
   * true of the district — Rescue had it.
   *
   * The distinction between *responsible* and *told* is real and stays: telling four extra
   * departments about a fire does not make four departments responsible for it. But when
   * routing has run and matched nobody — or has not run at all — **the control room choosing a
   * department is the assignment**, and ADR-0010 says in as many words that an unassigned
   * incident needs a human to place it. That human is standing at this screen.
   *
   * So the rule is narrow and one-directional:
   *
   *   * only when the incident has **no responsible department at all**;
   *   * only from departments — directly, or the department a chosen post belongs to. A named
   *     officer with no post makes nobody responsible, correctly;
   *   * recorded as `ruleId: 'manual'`, so the record says a person decided this. Since
   *     ADR-0022 that is the only kind there is, and this is the path almost every routing
   *     event in Bajaur now comes through: the control room chooses who to tell, and the
   *     incident becomes that department's without anybody being asked a second question.
   *
   * **It never re-routes an incident that already has a department.** That would let telling
   * somebody quietly take an emergency away from whoever was holding it, which is the one
   * thing `reassign` exists to make deliberate and explainable.
   */
  if (state.responsibleDepartmentIds.length === 0) {
    const departments = [
      ...new Set(
        targets
          .map((t) => (t.kind === 'post' ? (dir.departmentOfPost.get(t.id) ?? null) : null))
          .filter((id): id is Uuid => id !== null),
      ),
    ];

    if (departments.length > 0) {
      events2.push({
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt: now,
        recordedAt: now,
        clientSeq: state.eventCount + 2,
        // The operator, named. An automatic pass used to write these with a null actor,
        // because nobody decided it tonight — the administration decided it when they wrote
        // the signal. There is no such pass since ADR-0022, and every routing event in the
        // log from here on names the person who made the call.
        actorPersonId: identity.personId,
        actorSeatId: identity.seatId,
        sourceChannel: 'web',
        payload: {
          departmentIds: departments,
          ruleId: 'manual',
          reason: reason ?? 'assigned by the control room when it chose who to tell',
        },
      } as unknown as IncidentEvent);
    }
  }

  await append(pool, events2);

  const label = (t: { kind: RecipientKind; id: Uuid }): string =>
    dir.labels.get(`${t.kind}:${t.id}`) ?? t.id;

  const outcomes: DispatchOutcome[] = resolved.map((t) => ({
    kind: t.kind,
    id: t.id,
    label: label(t),
    coveredBy:
      t.coveredBy === null
        ? null
        : { kind: t.coveredBy.kind, id: t.coveredBy.id, label: label(t.coveredBy) },
    // Only reported for what is actually being told. "Vacant, and covered by its department
    // anyway" is not a warning, it is noise on the one screen that must stay readable.
    unreachable: t.coveredBy !== null ? null : (dir.unreachable.get(`${t.kind}:${t.id}`) ?? null),
  }));

  return {
    ok: true,
    value: {
      incidentId,
      // Folded over everything just appended, not just the dispatch. The screen refreshes from
      // this, and a caller who was told the incident is still unassigned a moment after the
      // control room assigned it would be reading a stale answer from its own request.
      outcomes,
      state: foldIncident(incidentId, [...events, ...events2]),
    },
  };
}

const CONTACT_CHANNELS: readonly string[] = ['whatsapp', 'call', 'sms'];

export interface ContactOpenedInput {
  readonly channel?: unknown;
  readonly seatId?: unknown;
  readonly personId?: unknown;
  readonly departmentId?: unknown;
  readonly label?: unknown;
}

/**
 * An officer opened WhatsApp, the dialler or messages from a number this system gave them —
 * M6-10.
 *
 * **This reverses a decision, and the reversal is narrower than it looks.** On 2026-08-03 the
 * owner removed the provider ladder and the "Reach them" panel was built to record *nothing*,
 * on the reasoning that recording an opened app implies a conversation nobody observed. That
 * reasoning still stands and is why the event says what it says. What changed is the question:
 * M6 exists so the district can answer **who was told about this**, and a contact that leaves
 * no trace is exactly the paper-register gap being closed. A record that states only what is
 * known beats no record at all.
 *
 * Three things it deliberately does not do.
 *
 * **It does not settle an obligation.** An opened app is not an acknowledgement, and only a
 * deliberate act — the acknowledge tap, an in-app acknowledgement, or a reply — meets the duty
 * (ADR-0014). Letting this clear an unmet obligation would quieten the board on the strength of
 * somebody having tapped a link.
 *
 * **It does not record the number.** The label is a post title or a name; officers' mobiles do
 * not go into the event log, which is replicated, dumped nightly and copied off-site.
 *
 * **It does not refuse a caller who is not in the owning department.** `/contacts` is
 * deliberately readable by any signed-in officer, because the person who needs to reach Rescue
 * at 02:00 is whoever is awake. A recording endpoint stricter than the panel it records would
 * mean the contacts nobody is allowed to log are exactly the out-of-hours ones.
 */
export async function recordContactOpened(
  pool: Pool,
  incidentId: Uuid,
  input: ContactOpenedInput,
  identity: Identity,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const seat = seatOf(identity);

  const channel = input.channel;
  if (typeof channel !== 'string' || !CONTACT_CHANNELS.includes(channel)) {
    return refuse(400, `channel must be one of ${CONTACT_CHANNELS.join(', ')}`);
  }

  const idOf = (v: unknown): Uuid | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

  const seatId = idOf(input.seatId);
  const personId = idOf(input.personId);
  const departmentId = idOf(input.departmentId);
  if (seatId === null && personId === null && departmentId === null) {
    return refuse(400, 'say whose number this was: a designation, a person or a department');
  }

  const label =
    typeof input.label === 'string' && input.label.trim() !== ''
      ? input.label.trim().slice(0, 120)
      : null;

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  const now = options.now ?? new Date().toISOString();

  const event = {
    eventId: randomUUID(),
    incidentId,
    type: 'contact_opened',
    occurredAt: now,
    recordedAt: now,
    clientSeq: state.eventCount + 1,
    actorPersonId: identity.personId,
    actorSeatId: identity.seatId,
    sourceChannel: 'web',
    payload: {
      channel,
      ...(seatId === null ? {} : { seatId }),
      ...(personId === null ? {} : { personId }),
      ...(departmentId === null ? {} : { departmentId }),
      ...(label === null ? {} : { label }),
    },
  } as unknown as IncidentEvent;

  // Appended even on a closed incident. A crew debrief the next morning is a fact that
  // happened, and so is somebody ringing a number about an incident that has since closed —
  // the same reasoning `action_logged` already follows.
  await append(pool, [event]);

  return {
    ok: true,
    value: {
      incidentId,
      outcomes: [],
      state: foldIncident(incidentId, [...events, event]),
    },
  };
}
