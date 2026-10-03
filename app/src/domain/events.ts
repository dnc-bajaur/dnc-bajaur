/**
 * The event catalog. See docs/03-data-model.md and ADR-0001.
 *
 * Events are immutable and append-only. There is no update and no delete: a mistake is
 * corrected by a new event, never by editing an old one. An incident's state is the fold
 * of its events (see incident.ts), which is why the audit trail cannot drift from the
 * data — it IS the data.
 */

export type Uuid = string;

/** ISO-8601 instant. */
export type Instant = string;

/** A severity somebody actually assessed. */
export type AssessedSeverity = 'low' | 'moderate' | 'high' | 'critical';

/**
 * `unknown` is the absence of an assessment, not a fifth level. See ADR-0009.
 *
 * Intake cannot refuse a report (INV-01), so it must store something when nobody stated a
 * severity. It records `unknown` rather than guessing a level, because on a screen a guess
 * is indistinguishable from a judgement — and a value the system invented, rendered as a
 * fact someone established, is the failure this project exists not to build.
 */
export type Severity = AssessedSeverity | 'unknown';

/**
 * Ordered worst-last so aggregation can take a max and never hide a critical (INV-04).
 *
 * `unknown` is deliberately absent. It has no rank, because a rank is precisely what it
 * does not have — see `worstSeverity`, which counts it instead of ranking it.
 */
export const SEVERITY_ORDER: readonly AssessedSeverity[] = ['low', 'moderate', 'high', 'critical'];

export function isAssessed(s: Severity): s is AssessedSeverity {
  return s !== 'unknown';
}

export type SourceChannel = 'web' | 'mobile' | 'sms' | 'call' | 'radio' | 'walk_in' | 'system';

export type EscalationTrigger = 'sla_breach' | 'manual' | 'severity' | 'no_duty_holder';

/**
 * Why someone is being told. Every one of these is an obligation arriving at a seat.
 *
 * `lost_responsibility` is the odd one and the reason this is an enum rather than a
 * boolean: the department a reassignment takes an incident *away from* has to be told too
 * (`visible_to_owner: yes_and_notify` in docs/04-authority-model.md). A handover nobody
 * announced is how two departments each assume the other went.
 *
 * `dispatched` is the district's own (M6-03, ADR-0016). Every other reason here is the
 * system concluding somebody is owed a message; this one is **a named operator deciding it**,
 * in the control room, on a telephone call. The two must stay distinguishable: an obligation
 * nobody chose and an obligation somebody chose are answered differently when one goes unmet.
 */
export type NotifyReason =
  'routed' | 'reassigned' | 'lost_responsibility' | 'escalated' | 'dispatched';

/**
 * What carried a notification attempt.
 *
 * Not a `SourceChannel`, which is how an *event* reached the system, and which is what these
 * payloads used to be typed as — wrongly, and harmlessly only because every write site casts.
 * The values actually written have never been source channels.
 *
 * `web` is history: the in-app inbox, removed by ADR-0018. It is kept here because events
 * carrying it are in the log for ever and a reader that cannot name them cannot read them
 * (ADR-0001). Nothing writes it any more.
 *
 * `manual` means **a human is the transport** — the district has no WhatsApp account yet, or
 * had one and it failed, and somebody picked up a telephone.
 */
export type NotifyChannel = 'whatsapp' | 'manual' | 'web';

/**
 * How we know somebody answered — M7-06, M7-30.
 *
 * Three routes, and they are never merged into one number. A report that adds *the officer
 * tapped a link* to *an operator says they were told on the phone* produces a figure nobody can
 * defend in a meeting, because the two are evidence of very different strength.
 *
 * - `link` — the officer tapped the acknowledge link in their own WhatsApp. The machine
 *   observed a deliberate act by the recipient.
 * - `reply` — the officer replied to the message. Also theirs, also deliberate, but the match
 *   from a handset back to an obligation is **inferred** from the number.
 * - `operator` — the control room rang them and is recording what they were told. This is a
 *   person's statement about a conversation, and the system observed none of it.
 *
 * A provider's `delivered` status is deliberately **not** on this list. It is the machine
 * observing a handset, not a human deciding anything, and ADR-0014 already refuses to let it
 * meet an obligation.
 *
 * ## A tapped quick reply is `reply`, and there is deliberately no fourth route — 2026-08-19
 *
 * `district_emergency_v2` and `district_notice_v2` let an officer answer by tapping a button on
 * the message itself. That is tempting to name apart, and it would be wrong: **these routes are
 * graded by how strong the evidence is, not by which gesture produced it.** A tap on a quick
 * reply is a deliberate act by the recipient, arriving from their handset, matched back to an
 * obligation by the number it came from — which is `reply` exactly, inference and all. A fourth
 * name would be a fourth column in every report that splits these, distinguishing two things of
 * identical strength, and M7-30's rule is that the split must mean something.
 *
 * What the tap does carry is **which words the officer chose**, and those are on the event as
 * `said` — *"Attending"*, *"Not attending"*. The `action_logged` note says `Tapped "…"` rather
 * than `Replied on WhatsApp: …`, so the record does not claim somebody typed a sentence they
 * picked from a list. That distinction belongs in the words, not in the taxonomy.
 */
export type AcknowledgementRoute = 'link' | 'reply' | 'operator';

/**
 * The three ways of naming somebody the control room can tell.
 *
 * Lives here rather than in `domain/recipients.ts` — which re-exports it — because the
 * `dispatched` event payload below carries it, and an event catalog that imported from a
 * module built on top of it would be the wrong way round.
 *
 * Two, not one, because the district asked for *"personal ya post"* and those are genuinely
 * different intentions. **Authority attaches to the post; knowledge attaches to the person**
 * (ADR-0004) — "tell the DEO" and "tell Officer Golf, he knows that road" are not the same sentence,
 * and an operator who can only say the first will put the second in the message text, where
 * nothing can act on it.
 *
 * ⚠️ **`'department'` was the third value and is gone — ADR-0031, phase 2.** ADR-0029 removed
 * the layer and ADR-0030 dropped the table; this installation's record was then rebuilt with
 * **zero** historical department-kinded targets (0030's own premise), so the value that stayed
 * threaded through this type, `db/groupStore.ts`, `api/dispatch.ts`'s auto-route and the
 * `dispatched` payload had nothing left to name. The ids and every past event on any
 * installation that still carries one are untouched — the type narrowed, the log did not.
 */
export type RecipientKind = 'post' | 'person';

/**
 * The things the control room sends — M7-23, extended by M9-06.
 *
 * One mechanism, several subjects. They differ in urgency and in the words on a screen and in
 * **nothing else**: each is written by an operator, addressed to a chosen set of people, sent
 * through the one WhatsApp template, and answered through the one ledger.
 *
 * `emergency` is the default and the absent value, so every event written before this field
 * existed reads correctly without being touched (ADR-0001 — the past is not rewritten).
 *
 * ## The last three are M9's "General", and they are on this list rather than beside it
 *
 * The client asked for a *General* category covering meetings, schedules and everything else
 * that is not an emergency, and asked for it to sit in **one list** with the rest. That is also
 * what this codebase already argued for: the note on `Payloads.reported.kind` says a second path
 * would mean *"a second ledger, a second acknowledgement route, a second set of reports and two
 * answers to who was told"*. So General is three more entries here, not a subsystem.
 *
 * What genuinely differs for them is **not** presentational, and that is the one place M9 departs
 * from M7-23's "the difference is entirely presentational": a meeting has no SLA clock and no
 * escalation ladder. See `CARRIES_SLA` below.
 */
export type MessageKind =
  'emergency' | 'alert' | 'advisory' | 'order' | 'meeting' | 'schedule' | 'other';

export const MESSAGE_KINDS: readonly MessageKind[] = [
  'emergency',
  'alert',
  'advisory',
  'order',
  'meeting',
  'schedule',
  'other',
];

/**
 * The kinds an acknowledgement deadline and an escalation ladder actually apply to.
 *
 * **The decision, and it is a real one rather than a tidy-up.** The escalation ladder exists
 * because an unanswered emergency costs somebody their life: it wakes people up, it climbs, and
 * it does not stop. A meeting notice nobody acknowledged by 02:00 does not cost anybody
 * anything, and escalating one teaches the district that escalations can be ignored — which is
 * INV-08's alert-fatigue failure arriving through the front door, and it would be paid for on
 * the night a real emergency escalates to somebody who has learned to swipe it away.
 *
 * `order` stays **inside** the fence. An order from the DC office is an instruction with an
 * expectation of compliance, and the district's own escalation is the right answer when one goes
 * unanswered. `alert` and `advisory` likewise: both are issued because something is happening.
 *
 * What the three General kinds keep is everything else — the full notification ledger, so a send
 * that fails is still visible (INV-03), the four-stage lifecycle, and the reports. **Only the
 * clock is removed.**
 */
export const CARRIES_SLA: ReadonlySet<MessageKind> = new Set<MessageKind>([
  'emergency',
  'alert',
  'advisory',
  'order',
]);

/** True when this kind is one of General's — the client's non-emergency communications. */
export function isGeneral(kind: MessageKind): boolean {
  return !CARRIES_SLA.has(kind);
}

/**
 * **Something people turn up to, rather than something people act on** — 2026-08-24.
 *
 * A narrower question than `isGeneral`, and the two must not be confused: `other` is General
 * too, but an office-timings notice is not a gathering and nobody attends it.
 *
 * 🔴 **It lives here because two very different things ask it and they must never drift.**
 * `stageButtonWords` asks it to choose between *Attending* and *Responding*;
 * `followUpWords` asks it to decide whether a chase is a **reminder with nothing under it**
 * or a chase with controls. Those two are read together in one WhatsApp bubble — a button
 * saying *Attending* under a sentence asking where an incident stands is the message arguing
 * with itself, and one shared predicate is what makes that impossible rather than merely
 * unlikely.
 */
export function isGathering(kind: MessageKind): boolean {
  return kind === 'meeting' || kind === 'schedule';
}

/**
 * The structured detail a General communication carries — M9-07.
 *
 * **One optional bag rather than a discriminated union per kind**, and the reason is the event
 * log. Every field here is written into a JSONB payload that will be read for years by code
 * nobody has written yet, and a union means a reader must know which variant a 2026 event used
 * before it can read any of it. A flat, entirely-optional shape degrades correctly: a reader that
 * has never heard of `venue` skips it, and one looking for `subject` finds it on every kind that
 * has one.
 *
 * Which fields a *screen* asks for is decided per kind by `domain/communications.ts`. That is a
 * presentation rule and it belongs somewhere it can change without touching the record.
 *
 * **No field here is validated into a `Date`.** `date` and `time` are the district's own calendar
 * and clock as an operator typed them, in Bajaur's reckoning — turning them into an instant at
 * intake would bake in a timezone assumption at exactly the layer that must not have one, and
 * this project has now paid for that mistake twice in two days.
 */
export interface CommunicationDetails {
  /** What it is about, in one line. Every General kind has one. */
  readonly subject?: string;
  /** `YYYY-MM-DD` in the district's calendar, as typed. Never parsed into an instant here. */
  readonly date?: string;
  /** `HH:MM` in the district's clock, as typed. */
  readonly time?: string;
  /** Where. A meeting's room, a schedule's location. */
  readonly venue?: string;
  /** `YYYY-MM-DD` — the far end of a schedule that spans days. */
  readonly untilDate?: string;
  /**
   * **"Kab tak?" — when somebody should be asked whether this is still running.**
   *
   * The district's own word, approved for Information and generalised to everything that
   * outlives the day. `YYYY-MM-DD` as the operator typed it, or `carrying.ts`'s
   * `UNTIL_FURTHER_NOTICE` when there is honestly no end in sight.
   *
   * ⚠️ **It is the control room's field and never reaches an officer's handset.** `untilDate`
   * was the obvious thing to reuse and is wrong for exactly one reason: `messageWhere` renders
   * `date` and `untilDate` as a span — *"24 August to 1 September"* — which on a meeting notice
   * would announce a two-week meeting. A schedule's `untilDate` genuinely *is* its review date
   * and `carrying.ts` reads it as one; every other kind gets this field, which no template
   * parameter touches.
   *
   * ⚠️ **Nothing here closes anything.** Past this date a row gains a mark asking *is this still
   * running?* It does not resolve, does not hide and does not stop notifying — the software
   * cannot know that a flood is over, and this is what makes sure a person is asked.
   */
  readonly reviewBy?: string;
  /** Everything else the operator wrote. Free text on purpose. */
  readonly note?: string;
}

/** One thing the control room ticked: a department, a post, or a named officer. */
export interface DispatchTarget {
  readonly kind: RecipientKind;
  readonly id: Uuid;
}

/**
 * Carried by every event without exception.
 *
 * `occurredAt` is when it happened, per the actor's device. `recordedAt` is when the
 * server first accepted it. They diverge whenever a client was offline, and the gap is
 * operationally meaningful — see ADR-0002 and docs/02-connectivity-ladder.md.
 *
 * `eventId` is generated on the client and is the idempotency key: replaying an event is
 * a no-op, which is what makes offline sync safe (INV-08).
 *
 * `actorSeatId` records the seat held *at that moment*, so a later transfer never
 * rewrites history (ADR-0004).
 */
export interface EventEnvelope {
  readonly eventId: Uuid;
  readonly incidentId: Uuid;
  readonly occurredAt: Instant;
  readonly recordedAt: Instant;
  /**
   * The client's own ordering of events it created, monotonic per incident.
   *
   * Timestamps are not enough. A batch created offline shares a millisecond, and
   * `recorded_at` is identical across one server transaction — so without this, ordering
   * falls to a random id and `triaged` can fold after `overridden`. Determinism was never
   * the hard part; causality is. See migration 0002.
   */
  readonly clientSeq: number;
  readonly actorPersonId: Uuid | null;
  readonly actorSeatId: Uuid | null;
  readonly sourceChannel: SourceChannel;
}

/**
 * Where a report said this happened — `web/src/location.ts`'s `Capture`, mirrored here so the
 * domain can fold it without importing a web module.
 *
 * **Typed only, as of 2026-09-05.** A device GPS fix rode alongside this for one day
 * (2026-08-24 to 2026-09-05) and was removed: the map link it produced was wrong often enough
 * that the owner asked for it gone rather than fixed, and the control room writes the location by
 * hand instead — the same way it writes everything else this field's sibling fields carry.
 * INV-01 refuses a report for lacking a location at all; `text` absent means nothing was typed.
 */
export interface ReportedLocation {
  readonly text?: string;
}

interface Payloads {
  reported: {
    reportId: Uuid;
    category: string;
    severity: Severity;
    /**
     * What kind of thing this is — M7-23. Absent means `emergency`, which is what every
     * event written before this existed was.
     *
     * **One mechanism, four subjects, and that is the decision.** An advisory, an alert and an
     * order are the same act as an emergency from the software's point of view: the control
     * room writes something down and chooses who should know. Building a second path for them
     * would mean a second ledger, a second acknowledgement route, a second set of reports and
     * two answers to *"who was told?"* — and the district would then have to remember which
     * screen a given message went out from.
     *
     * What differs is entirely presentational: the subject line, and the words on the board.
     * That difference is worth one field and not a subsystem.
     *
     * It does **not** change what may be refused. `POST /incidents` still cannot refuse (INV-01):
     * an advisory typed into the emergency box is a message somebody meant to send, and losing
     * it to a validation error would be the same failure for a smaller reason.
     */
    kind?: MessageKind;
    /**
     * Two scales on one thing — M10-20/41/42. Severity is *how bad*; this is *how urgently the
     * wall should carry it*, and the two are independent — a routine matter can be severe and an
     * important one can be low-severity.
     *
     * **Absent means `routine`, and that reading is for events written before this field
     * existed** (M10-21) — it is never what a fresh emergency actually gets. Intake writes this
     * explicitly, defaulting a new emergency to `important` (M10-41), precisely because the
     * fold's own absent-value reading goes the other way and an omission here would silently
     * mean the opposite of what M10-41 asks for. Omitted on General communications, where it has
     * no meaning — see `isGeneral`.
     *
     * **M10-42 is the whole containment: this decides which of two dashboard panels a row
     * appears in, and nothing else.** The board, the SLA clock and the escalation ladder read
     * none of it — an emergency marked routine by mistake is still on the board, still escalates,
     * still counts. Only its column moves.
     */
    importance?: 'routine' | 'important';
    /**
     * Structured detail, for the kinds that have any — M9-07.
     *
     * Absent on every emergency and on everything written before M9, which is honest: those
     * events genuinely carry no subject and no venue, and an empty object would be a claim that
     * somebody was asked and left it blank.
     *
     * **This does not replace `description`.** That field is the reporter's own words, which an
     * operator reads when deciding who to tell; this is what the operator filled into named
     * boxes. A meeting has both — *"Monthly coordination"* in `subject`, and whatever the
     * operator wanted to add in `description` — and collapsing them would put the structure into
     * free text where nothing can act on it.
     */
    details?: CommunicationDetails;
    /**
     * **Ask who is coming to this, even though it is not a meeting** — the district's five,
     * 2026-08-22, and the district said yes to it.
     *
     * *Information* is the DC telling officers something — *"12 Rabi-ul-Awwal par programme
     * hoga, agar kisi ne join karna hai to kar sakta hai"* — and a Milad programme **can**
     * usefully ask who is coming, while a road-closure notice cannot.
     *
     * ⚠️ **Per message, never per kind, and that is what makes it safe.** `other` stays
     * outside `CARRIES_SLA`, so nothing here starts a clock or an escalation ladder, and
     * `summary.unacknowledged` still excludes it (M11-02). **An unanswered invitation is not a
     * gap** — nothing counts it as unmet — which is precisely why this costs nothing to offer.
     *
     * Absent means no, which is what every notice sent before today was.
     */
    asksAttendance?: boolean;
    placeId?: Uuid;
    /** The reporter's own words, as the control room reads them when assigning (ADR-0022). */
    description?: string;
    /**
     * Where this happened, as the control room typed it — 2026-08-24, removed 2026-09-05,
     * restored the same day once its own defect was found, narrowed to typed text only, also
     * 2026-09-05, once the device-fix half of it turned out to be the wrong kind of automatic.
     *
     * `web/src/location.ts`'s `Capture`. It was pulled the first time for a real reason
     * (`1d36b058`): the box existed, an operator could fill it in, and its text reached **nowhere
     * a human could read it back** — not the WhatsApp message, not the board, not the printed
     * report. That is a genuine defect, but the fix for a field nobody reads is to make somebody
     * read it, not to delete the field — `domain/communications.ts`'s `locationLine` and
     * `messageFor`'s use of it is that fix.
     *
     * A device GPS fix rode alongside the text for the rest of that same day, as a tappable map
     * link built from `navigator.geolocation`. It came out again just as fast: the pin it drew was
     * wrong often enough that a control room reading a confident-looking link and being wrong is
     * worse than a control room asked to type the place itself, which is what every other field
     * on this event already asks of it.
     *
     * Untyped and cast past this interface for the whole of the day it was first restored
     * (`as unknown as Omit<...>` in `web/src/main.ts`), which is why nothing caught that it went
     * unread the first time: a field with no declared shape is a field no test can assert reaches
     * anywhere, and none did.
     */
    location?: ReportedLocation;
    /**
     * Fields intake supplied because the caller did not (INV-01).
     *
     * Recorded so a downstream consumer can tell an assessment from a placeholder — which
     * ADR-0009 depends on for severity, and which the control room reads when assigning.
     */
    assumed?: readonly string[];
  };
  triaged: { severity: Severity; category: string; reason?: string };
  /**
   * Who holds this incident — **written by a human, always** (ADR-0022).
   *
   * Until ADR-0022 an automatic pass also wrote this at intake, matching the report against
   * signals the administration had configured. That is gone: the control room assigns, and
   * an incident nobody has assigned simply has no event of this type.
   *
   * `departmentIds` may still be empty — an operator can take every department off an
   * incident — and that stays a fact worth recording rather than an absence to be inferred.
   *
   * `ruleId` is `'manual'`. The `'auto'` and uuid forms, and `signalIds`, are **kept in the
   * type because the log is append-only**: incidents reported before ADR-0022 carry them and
   * must still parse (INV-08). Nothing writes them any more.
   */
  routed: {
    departmentIds: readonly Uuid[];
    ruleId: Uuid | 'manual' | 'auto';
    signalIds?: readonly Uuid[];
    reason?: string;
  };
  /**
   * The control room chose who should know — M6-04, M6-05.
   *
   * A **second, deliberately separate** provenance beside `routed`. `routed` answers *who is
   * responsible for this incident*; this answers *who was told about it on the night*. They
   * are usually the same people and they are not the same fact — an operator telephones the
   * DEO and Officer Golf without making either of them the holder. Folding the two into one event
   * would make the record unable to answer *who decided this*, and that question is the
   * entire reason the paper register is being replaced.
   *
   * `targets` is what will actually be told: the selection after `collapseSelection` has
   * absorbed a post into its own department and a person into a post they hold, so one
   * emergency is one message per person.
   *
   * `absorbed` is what was ticked and covered by something else, **kept rather than dropped**,
   * with what covered it. An operator who ticks four things and watches three go stops
   * trusting the control — and six months later "why was the DEO not told" has an answer.
   *
   * `proposed` named the targets the routing signals pre-ticked (M6-07). **Historical since
   * ADR-0022** — there are no signals, nothing writes it, and it is kept only so events from
   * before then still parse (INV-08).
   */
  dispatched: {
    targets: readonly DispatchTarget[];
    absorbed?: readonly { target: DispatchTarget; coveredBy: DispatchTarget }[];
    proposed?: readonly DispatchTarget[];
    /**
     * What the district's own history proposed — M7-18, kept **apart from** `proposed`.
     *
     * Since ADR-0022 this is the only thing that proposes anything. It is still written to its
     * own field rather than into `proposed`, because the gap between what was suggested and
     * what the operator actually chose is the measurement that says whether the suggestions
     * are worth keeping — and an event log that merged them could never be asked again.
     */
    learned?: readonly DispatchTarget[];
    reason?: string;
    /**
     * Groups the operator ticked, **expanded here and written down as they were at that
     * moment** — M7-10.
     *
     * `targets` above already holds every member individually, so nothing downstream needs to
     * know groups exist. This is provenance: *"the flood group"* is what the operator did, and
     * six departments is what happened, and a record that kept only the second cannot explain
     * why the AC was included.
     *
     * **The members are copied, never referenced.** A group edited next month must not change
     * who last month's incident says was told — an incident whose own history moves when
     * somebody saves a setting is exactly what ADR-0001 exists to prevent. The name is copied
     * for the same reason and a second one: a group can be retired, and a timeline reading
     * "told 7e3f-…" answers nothing.
     */
    fromGroups?: readonly {
      groupId: Uuid;
      name: string;
      members: readonly DispatchTarget[];
    }[];
  };
  /**
   * An officer opened WhatsApp, the dialler or messages from a number this system handed them.
   *
   * **It states only that an app was opened, because that is all that is known** — and that is
   * the whole of what this event is careful about. Nothing here observed a ring, an answer or a
   * conversation. Recording it as "contacted" would put a claim in the record that nobody
   * checked, which is the failure the notification ledger's three states exist to prevent.
   *
   * Reverses the "nothing is recorded" of 2026-08-03 (M6-10). That was right when the panel was
   * the only channel and wrong once the district needed to answer *who was told about this*:
   * an untraced contact is exactly the paper-register gap M6 exists to close. What has not
   * changed is that **this never settles an obligation** — only a deliberate act does
   * (ADR-0014).
   */
  contact_opened: {
    channel: 'whatsapp' | 'call' | 'sms';
    /** Whichever of these the number belonged to. All optional; at least one is present. */
    seatId?: Uuid;
    personId?: Uuid;
    departmentId?: Uuid;
    /** The post or person as displayed, so the timeline reads without a second lookup. */
    label?: string;
  };
  /**
   * A notification was **attempted**. Not "sent", and certainly not "received".
   *
   * Recorded before delivery is tried, so a crash between the two leaves a visibly pending
   * obligation rather than nothing at all. INV-03 turns on this trio staying three separate
   * facts: an attempt, and then either a delivery or a failure. Collapsing them into a
   * boolean on the incident is the failure the invariant names.
   */
  notified: {
    attemptId: Uuid;
    /**
     * The seat that was to be told, or **null when the department has no post at all**.
     *
     * A null seat is not a missing field, it is the failure itself: an obligation to a
     * department that has nobody in it. It used to be recorded as a counter in the job's
     * return value and nowhere on the incident, which is exactly the "log line" INV-03
     * forbids — the board showed nothing, so the emergency looked notified. Now the attempt
     * exists, fails, and is counted like any other unmet obligation.
     */
    seatId: Uuid | null;
    /** Set when the obligation was to a department rather than to a named seat. */
    departmentId?: Uuid;
    /**
     * Set when the obligation was to a **named officer** rather than to a post (M6-03).
     *
     * A third addressee, not a convenience field. `seatId` answers "which post is owed this",
     * and a post is held by whoever holds it tonight; `personId` answers "which human", and
     * survives them handing the post over. The control room asked for both, and an obligation
     * that could only be recorded against a post would have silently retargeted itself at the
     * next shift change.
     */
    personId?: Uuid;
    channel: NotifyChannel;
    reason: NotifyReason;
  };
  /**
   * **What we actually sent, in the words that reached the handset** — 2026-08-23.
   *
   * ## Why this is an event of its own and not a field on `notified`
   *
   * `notified` is appended **before** anything is sent — that order is the whole of INV-03, so a
   * process dying mid-send leaves a visibly pending obligation rather than nothing. The message
   * does not exist yet at that point: it is composed from the incident’s state inside the
   * channel, moments later. An append-only log cannot go back and fill it in, so the thing that
   * happened second gets an event of its own.
   *
   * ## Why not the `whatsapp_message` table
   *
   * That table’s own header says it is **not history** — *"drop both tables and the district
   * loses no record of anything that happened"*. Putting the sent text there would make that
   * false. The log is the record (ADR-0001), and what the district told an officer at 02:00 is
   * exactly the kind of thing a review asks about six weeks later.
   *
   * ## Why only these two fields
   *
   * The outbound message has five, and three are plumbing: an acknowledge token, a media id, a
   * template name. `what` and `where` are the only parts a human reads. Recording the rest would
   * be storing the envelope and calling it the letter.
   *
   * ⚠️ **Nothing before 2026-08-23 has one, and none can be reconstructed.** The composer runs
   * off current state, so recomposing an old message would produce what it *would* say today —
   * which is a different sentence wherever an incident has since been corrected, rescheduled or
   * reassessed. A screen must therefore treat "no message_sent" as **unknown**, never as "nothing
   * was sent": the `notified` event beside it already says something was.
   */
  message_sent: {
    /** The attempt this text was sent for. Binds it to the obligation the ledger tracks. */
    attemptId: Uuid;
    /** The incident’s category and severity, as the officer read them. */
    what: string;
    /** Where, in plain words. Never empty — Meta refuses an empty parameter. */
    where: string;
    /** Meta’s id for the message, so this can be tied to a delivery receipt later. */
    providerMessageId?: string;
  };
  notification_delivered: {
    attemptId: Uuid;
    seatId: Uuid | null;
    personId?: Uuid;
    channel: NotifyChannel;
    /**
     * How we know — M7-06. Absent on everything written before it existed, which is honest:
     * those events genuinely do not record a route, and inventing one for them retrospectively
     * would put a fact in the record that nobody observed.
     *
     * `provider` is the machine's own observation — Meta reporting a handset received it. It is
     * a delivery and never an acknowledgement; the three that are acknowledgements are named in
     * `AcknowledgementRoute`.
     */
    via?: AcknowledgementRoute | 'provider';
    /**
     * What the officer said, when a person heard it and typed it in (`via: 'operator'`).
     *
     * Free text on purpose. *"Ambulance nikal gai hai"* is the sentence the control room
     * actually wants back six weeks later, and a dropdown would have thrown it away.
     */
    said?: string;
  };
  notification_failed: {
    attemptId: Uuid;
    seatId: Uuid | null;
    personId?: Uuid;
    channel: NotifyChannel;
    /**
     * `operator` when a person rang and could not reach them — M7-07.
     *
     * A distinct fact from silence, and it needs a distinct next action: silence means try
     * again or escalate, *"I rang twice, the number is dead"* means fix the roster.
     */
    via?: 'operator';
    failure: string;
    /**
     * The provider refused **for now** rather than for good — M6-24.
     *
     * A new WhatsApp number is rate limited by Meta until its usage earns the tier up, and
     * hitting that cap is a message deferred, not an emergency nobody could be told about. The
     * distinction has to be on the event rather than inferred from the failure text, because
     * the next pass reads it: without it, `alreadyAttempted` would treat a ninety-second cap
     * as a permanent failure and the message would never go at all.
     *
     * A retry appends a **new** attempt with its own id rather than reviving this one, which is
     * both what the append-only log requires and what actually happened — two attempts, and the
     * district can see there were two.
     */
    retryable?: boolean;
  };
  /**
   * Somebody with a duty has taken this on.
   *
   * **`seatId` is the post that acknowledged, and it is not always the actor.** When an operator
   * records what they were told on the telephone (M7-05), the envelope's actor is the *operator*
   * — they are the one making the statement, and the record must say so — while `seatId` is the
   * post that accepted the emergency. Those are two different people and the district needs
   * both: one to know who is coming, one to ask afterwards who said so.
   *
   * Null when a named officer holding no post answered. Acknowledgement stops the incident's
   * clock because a **duty** took it (ADR-0004); somebody with no duty genuinely read the
   * message, which the notification ledger records, but has no post to take it with.
   */
  acknowledged: {
    seatId: Uuid | null;
    /** The officer, when the acknowledgement is theirs rather than a post's. */
    personId?: Uuid;
    /** Absent on events written before M7-05. See `AcknowledgementRoute`. */
    route?: AcknowledgementRoute;
    /** What they said, in their words, when a person heard it. Only ever with `operator`. */
    said?: string;
  };
  /** Units committed to this incident: vehicles, teams, equipment (M1-02). */
  assigned: { resourceIds: readonly Uuid[] };
  /**
   * Units stood down from this incident.
   *
   * Necessary because `assigned` only ever adds. Without it a vehicle stays committed to
   * every incident it ever attended until each of those is closed, so "what can Rescue send
   * right now" degrades over a shift into a list of things that all look busy — and the
   * answer an operator gets at 02:00 is wrong in the direction that stops help going out.
   *
   * A reason is required. Standing a unit down mid-incident is a decision somebody will be
   * asked about afterwards (INV-06).
   */
  released: { resourceIds: readonly Uuid[]; reason: string };
  /**
   * `acknowledges` — 2026-09-04, optional, and false/absent almost everywhere this is written.
   *
   * `action_logged` is the general "something happened" event and is appended for nearly every
   * reply a control room or an officer's handset produces — most of them answer no obligation at
   * all. `domain/incident.ts`'s fold only reads this note as an acknowledgement (stopping the SLA
   * clock) when the flag is explicitly `true`, which `api/webhooks.ts` sets on exactly one write:
   * the note recording a reply that matched one of the district's response options with
   * `records: 'responded'` — where the note's own words already are the officer's response, and a
   * second event saying so again would be the duplicate the district read on the record panel.
   */
  action_logged: { note: string; evidenceIds?: readonly Uuid[]; acknowledges?: boolean };
  /**
   * **The control room chased somebody, by hand — Phase 8b, 2026-08-21.**
   *
   * ## Why this is its own event and not an `action_logged`
   *
   * 🔴 **An `action_logged` MOVES THE STAGE TO `responding`.** That is correct for what it means —
   * *somebody did something about this emergency* — and it is exactly wrong here. A follow-up is
   * sent **because nobody has answered**; recording it as an action would put the emergency on the
   * board as **Responded**, claiming an officer is working on it, at the precise moment the truth
   * is that nobody is. That is a false state on the one screen a district acts on, written by the
   * act of chasing. **This event deliberately moves nothing.**
   *
   * ## Why it is not a `notified` attempt either
   *
   * `alreadyAttempted` keys on the target **and the reason**, so a second follow-up to the same
   * officer would collide with the first and silently never send. And the obligation to tell that
   * officer was **already discharged** — this is not a new duty, it is the room chasing one that
   * went unanswered. Calling it an obligation would put a second unmet row on the board for one
   * emergency (INV-03's own failure mode, manufactured).
   *
   * ## What it carries, and why each field is here
   *
   * ⚠️ **`followsProviderMessageId` is the district's own request**, in their words: *"pehle bheje
   * gaye msg ke baare mein ho … taake record maintain kiya ja sake."* It is the `wamid` of the
   * message being followed up on, which is `whatsapp_message`'s primary key — so the record ties
   * the chase to the exact alert rather than to *"some message we sent that number"*, whose answer
   * moves. **This half is entirely ours and works whether or not the send did.**
   *
   * ⚠️ **`delivered` is `false` when Meta refused, and the reason is written in `note`** rather
   * than only in the log — `keepEvidence`'s rule: INV-03 is about a failure being visible **where
   * somebody acts on it**. A control room that pressed *follow up* and saw nothing must be told
   * the message did not go, on the incident, not in a journal nobody opens.
   */
  followed_up: {
    /** The handset chased, in the form `whatsapp_message` stores. */
    toPhone: string;
    /** How the district described it — never a bare "followed up". */
    note: string;
    /** The alert this chases, by Meta's own id for it. Null when there is no message to name. */
    followsProviderMessageId: string | null;
    /** When that alert went out, so the record reads without a second lookup. */
    followsSentAt?: string;
    /** Whether Meta accepted it. Accepting is not delivery (ADR-0014); this claims no more. */
    delivered: boolean;
  };
  /**
   * **Moved up the ladder** - and since Phase 8a this event **tells nobody**.
   *
   * `domain/notifications.ts` no longer produces an obligation for `currentEscalationSeatId`, at
   * the district's own instruction, so what an escalation now does is **mark the board**. That
   * makes `reason` load-bearing rather than decorative: the mark is the whole of the act, and a
   * mark with nothing behind it is a row somebody reads at 02:00 and cannot act on.
   *
   * `trigger` still separates the two hands. `sla_breach` and `no_duty_holder` are the job's, and
   * carry no actor at all; `manual` is a person's, carries their seat, and arrives with a sentence.
   */
  escalated: {
    fromSeatId: Uuid | null;
    toSeatId: Uuid;
    trigger: EscalationTrigger;
    /**
     * Why, in the district's own words. Present on `manual` and absent on the job's escalations,
     * which have no words to offer beyond the trigger they already carry.
     */
    reason?: string;
  };
  /**
   * **The chase ended here, unacknowledged** — ADR-0020.
   *
   * The district decided that escalation runs for one district day and then stops, for
   * everything, including emergencies nobody has acknowledged. This event is what stops that
   * from being **silence**.
   *
   * A log that goes quiet without saying it went quiet cannot be read six months later: somebody
   * looking at an unacknowledged emergency with three escalations and then nothing has no way to
   * tell whether the ladder was exhausted, the job crashed, the server was off, or the day simply
   * ended. All four look identical, and only one of them is normal.
   *
   * **It is not a notification and never becomes one.** Escalation stops, as the district asked.
   * This is the record saying so, and it is what the daily report's *"still outstanding from
   * earlier days"* block counts.
   *
   * `escalations` is how far the ladder actually got before the day ran out — the number that
   * says whether anybody was ever reached.
   */
  escalation_ended: { reason: 'day_ended'; escalations: number; districtDate: string };
  reassigned: {
    fromDepartmentIds: readonly Uuid[];
    toDepartmentIds: readonly Uuid[];
    reason: string;
  };
  overridden: { field: string; value: string; reason: string };
  merged: { absorbedIncidentId: Uuid; reason: string };
  unmerged: { restoredIncidentId: Uuid; reason: string };
  resolved: { outcome: string; evidenceIds?: readonly Uuid[] };
  closed: { notes: string; evidenceIds?: readonly Uuid[] };
  reopened: { reason: string };
  /**
   * **What we sent was wrong** — M9-52.
   *
   * The client asked for *"undo/delete"* and the owner confirmed it is in scope. It cannot be
   * delete: `eventStore.ts` has no update and no delete, and that absence is the foundation the
   * whole audit trail rests on (ADR-0001). So it is a **correction** — a new event that
   * supersedes an earlier one, with a reason and an actor, leaving both readable. The log
   * already does exactly this for `overridden`, `unmerged` and `reopened`; this generalises it
   * to the mistake an operator actually makes, which is sending the wrong thing to 40 people.
   *
   * **It does not change the status, and that is deliberate.** You cannot un-happen a fire, and
   * a meeting notice that went out with the wrong date is not *resolved* — it is wrong. The
   * status answers *what is happening*; this answers *is what we said still true*, and folding
   * one into the other would lose whichever question was asked second.
   *
   * `correction` is what is true instead, when the operator knows. Optional, because *"ignore
   * this, we will confirm later"* is a real and honest thing to record — and forcing a
   * replacement would produce invented ones.
   */
  corrected: { reason: string; correction?: string };
  /**
   * **Take it off the board** — M10-11, and it is neither a delete nor a correction.
   *
   * Correction (M9-52) answers *is what we said still true*. This answers a different
   * question — *should this still be on the screen* — and the district asked for it about
   * **anything on the dashboard, emergencies included**: a duplicate report of one fire, a
   * notice sent to the wrong district, a test somebody ran at 11:00.
   *
   * **It leaves the SCREEN and never the RECORD.** There is no delete here and cannot be:
   * `eventStore.ts` has no update method and no delete method, and that absence is what the
   * whole audit trail rests on (ADR-0001). Search keeps it, the daily report keeps it, and
   * both mark it (M10-15) — so *"what happened to that 11:00 report?"* has an answer.
   *
   * **INV-01 is not broken by this and the distinction is exact:** that invariant is about the
   * record being durable, not about what a board displays. The same reading is already written
   * down in ADR-0020, which lets an unacknowledged emergency stop being pursued at midnight.
   *
   * **The status is untouched**, exactly as `corrected` leaves it. You cannot un-happen a fire,
   * and an emergency withdrawn from the board is not *resolved* — nobody resolved anything.
   */
  withdrawn: { reason: string };
  /**
   * **Put it back** — M10-18.
   *
   * ⚠️ **No reason, and that asymmetry is deliberate.** Withdrawing removes something from the
   * screen a control room acts on, so it owes an explanation. Restoring undoes that, and the
   * act carries its own — *it should not have been withdrawn*. Demanding one here produces
   * invented reasons, which is the argument `corrected.correction` already makes for being
   * optional.
   *
   * Both events stay in the log. A withdraw-then-restore is not a round trip that erases
   * itself; it is two facts about what the control room believed, ten minutes apart.
   */
  restored: Record<string, never>;
  /**
   * **The meeting moved. It has NOT finished** — the district's five, 2026-08-22.
   *
   * 🔴 **This is not an ending and must never be offered as one.** *Conducted* and *Cancelled*
   * close a meeting; a rescheduled one is still going to happen, on a new date, and folding all
   * three into one control would take a live meeting off the dashboard — the exact opposite of
   * what the district asked for when they said *"rahegi till its done"*.
   *
   * ⚠️ **Not `corrected`, and the distinction is the reason this event exists.** That one
   * means *what we sent was wrong*. A reschedule **was right when it was sent**; the
   * circumstances changed afterwards. Two different facts, and a record that merged them could
   * not answer either — *"did we send the wrong date, or did the date move?"* is the first
   * question anybody asks about a meeting notice that went out twice.
   *
   * The status is untouched, on `withdrawn`'s and `held_over`'s reasoning: nobody resolved
   * anything by moving a date.
   *
   * `date` is required and `time`/`venue` are not — a meeting whose room is not decided yet is
   * a real meeting, and refusing it would send the district back to WhatsApp from a personal
   * handset, which is what `requiredFieldsFor` already refuses for the same reason.
   */
  rescheduled: { date: string; time?: string; venue?: string; reason: string };
  /**
   * **Keep this one on the wall past midnight** — the district's five, 2026-08-22.
   *
   * `domain/carrying.ts` decides by default which things outlive the day. This is the control
   * room saying otherwise about **one item**, and `hold_ended` below is the other direction.
   *
   * **Why an event and not a column.** ADR-0001, and the same argument `withdrawn` already
   * makes: *"why was that flood still on the wall in October"* is a question somebody asks six
   * weeks later, and only an append-only record answers it. A boolean on a row answers *what is
   * true now* and destroys the question.
   *
   * **Why a reason**, unlike `restored` which deliberately asks for none. Restoring undoes a
   * removal and carries its own justification — *it should not have been withdrawn*. This does
   * not undo anything: it **changes what a room looks at for days**, and the sentence is the
   * whole content of that decision. The same argument as `escalated.reason`, where the mark is
   * the entire act.
   *
   * **It does not touch the status**, exactly as `withdrawn` and `corrected` do not. Nobody
   * resolved anything by deciding to keep watching it.
   */
  held_over: { reason: string };
  /**
   * **Stop carrying it; let it clear with the day** — the other end of `held_over`.
   *
   * Used both to undo a hold and to release something the default carries: a small flood that
   * was over by lunchtime should not sit on the wall for ever waiting for somebody to close it
   * by hand. Duration is a property of the **event**, not of its category.
   *
   * ⚠️ **This is not `resolved` and must never be offered as one.** It says *stop showing this
   * on the panel of things still running*; it says nothing about whether the flood is over. The
   * software cannot know that — see `docs/adr` and the panel's own rule: it flags, marks and
   * asks, and it never closes.
   *
   * `reason` for the same reason as above, and for the question it answers, which is the second
   * one the panel generates: *"why did this stop being tracked?"*
   */
  hold_ended: { reason: string };
  late_arrival_flagged: { gapMinutes: number };
}

export type EventType = keyof Payloads;

/** A single immutable fact about an incident. */
export type IncidentEvent = {
  [T in EventType]: EventEnvelope & { readonly type: T; readonly payload: Payloads[T] };
}[EventType];

/** Events whose payload must carry a non-empty reason (INV-06). */
export const REASON_REQUIRED: ReadonlySet<EventType> = new Set<EventType>([
  'reassigned',
  'overridden',
  'merged',
  'unmerged',
  'reopened',
  'released',
  // M10-11. "Withdrawn" with no reason tells the next reader something left the board and
  // nothing about why — and the row it left is the one a control room acts on.
  'withdrawn',
  // The district's five, 2026-08-22. Both directions change what a control room looks at for
  // days, and both generate a question — "why is this still here", "why did this stop being
  // tracked" — that only the sentence can answer.
  'held_over',
  'hold_ended',
  // A meeting that moved owes the officers who were already told an explanation, and the
  // follow-up message is built from it.
  'rescheduled',
]);

export function severityRank(s: AssessedSeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface SeveritySummary {
  /** The worst severity anyone actually assessed, or null if nobody has. */
  readonly worst: AssessedSeverity | null;
  /** How many are waiting on an assessment. Never folded into `worst`. */
  readonly unassessed: number;
}

/**
 * Max-severity semantics, plus a count of what has not been assessed at all.
 *
 * Two numbers, never one, and that is the whole design (ADR-0009). An average could hide a
 * critical; a max cannot (INV-04) — but a max over a set containing unassessed reports has
 * to do something with them, and both available answers are lies. Counting them as `low`
 * hides them. Counting them as `critical` drowns the real ones and the aggregate stops
 * meaning anything within a week.
 *
 * So they are counted separately and rendered separately: *3 critical · 2 unassessed*.
 */
export function worstSeverity(severities: readonly Severity[]): SeveritySummary {
  let worst: AssessedSeverity | null = null;
  let unassessed = 0;

  for (const s of severities) {
    if (!isAssessed(s)) {
      unassessed += 1;
      continue;
    }
    if (worst === null || severityRank(s) > severityRank(worst)) worst = s;
  }

  return { worst, unassessed };
}
