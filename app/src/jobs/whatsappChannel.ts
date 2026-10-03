/**
 * WhatsApp as a `NotificationChannel` — M6-18, ADR-0014.
 *
 * **A second implementation of an interface that already existed, not a change to the ledger
 * around it.** `jobs/notify.ts` has carried the seam since M0-32, and its header said what
 * would eventually come through it. The order of operations does not move: the attempt is
 * appended *before* anything is sent, so a webhook that never arrives leaves `pending` — which
 * is the honest answer, because nobody knows whether the message landed.
 *
 * ## What this file resolves, and why the resolution lives here
 *
 * An obligation names a seat, a department or a person. WhatsApp needs a **number**. Turning
 * one into the other is a roster question with three careful cases, and it belongs beside the
 * sending rather than inside `obligationsFor`, which is pure and must stay that way:
 *
 *   * **A placeholder number is never dialled.** A stand-in fills a post so the roster is
 *     complete (migration 0008); sending to it reaches nobody, and the failure has to say
 *     *that* rather than "delivered".
 *   * **A vacant post fails loudly**, the same rule escalation and the in-app channel already
 *     follow (ADR-0004). Nobody is coming, so somebody has to be told nobody is coming.
 *   * **A person is resolved as themselves**, never quietly through a post they happen to
 *     hold. The control room asked for a named officer; substituting the post would send to
 *     whoever holds it tonight and record that the named officer was told.
 */

import { loadIncident } from '../db/eventStore.js';
import { mintFileToken } from '../db/fileTokenStore.js';
import {
  defaultEvidenceRoot,
  fetch as fetchEvidence,
  listFor,
  type Evidence,
} from '../ops/evidence.js';
import { log } from '../obs/log.js';
import type { Pool } from '../db/pool.js';
import {
  hasCategory,
  labelFor,
  locationLine,
  messageSubject,
  messageWhere,
} from '../domain/communications.js';
import { isGeneral, type CommunicationDetails, type MessageKind } from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { templateCategoryFor } from '../domain/responseOptions.js';
import { categoryLabelsLocation, categoryNamesKindInHeader } from '../ops/whatsappTemplate.js';
import { mintAckToken, recordSent } from '../db/whatsappStore.js';
import { dutySeatOfPerson } from '../db/rosterStore.js';
import {
  sendWhatsApp,
  toE164,
  uploadMedia,
  type OutboundMessage,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import type { NotificationChannel } from './notify.js';

export interface WhatsAppChannelOptions {
  readonly pool: Pool;
  readonly config: WhatsAppConfig;
  /**
   * The origin officers' handsets can actually reach — ADR-0017.
   *
   * The acknowledge link goes into a message on somebody's phone, so it has to be the
   * district's own domain over TLS and never `http://<office-IP>:3000`. A link to an address
   * that only resolves inside the DC office is a link that fails on every handset in Bajaur,
   * which is the same class of fault ADR-0017 exists to close.
   *
   * **It is no longer this module's job to build that link, and that is the fix of 2026-08-12.**
   * A WhatsApp URL button carries its prefix in the *approved template*, and Meta appends the
   * `{{1}}` parameter to it. This module sends the token; the prefix must equal
   * `${PUBLIC_ORIGIN}/ack/` and `templateProblems` is what holds the two together. The origin is
   * still taken here so that a caller cannot construct this channel without having one — the
   * value is checked at the boundary rather than silently defaulted, exactly as before.
   */
  readonly publicOrigin: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Where the photographs are on disk — M10-34a.
   *
   * Needed because this channel now reads an attachment back to put it **on** the message rather
   * than only linking to it. Defaulted through `defaultEvidenceRoot()` so the sending path and
   * the uploading path cannot look in two different directories.
   */
  readonly evidenceRoot?: string;
}

interface Addressee {
  readonly phone: string;
  readonly label: string;
}

/** Resolve an obligation to one number, or say why there is not one. */
async function numberFor(
  pool: Pool,
  target: { readonly seatId: string | null; readonly personId: string | null },
): Promise<Addressee | { readonly failure: string }> {
  if (target.personId !== null) {
    const res = await pool.query<{
      full_name: string;
      phone: string | null;
      placeholder: boolean;
      disabled_at: string | null;
    }>(
      `SELECT full_name, phone, placeholder, disabled_at
         FROM person WHERE person_id = $1 AND removed_at IS NULL`,
      [target.personId],
    );

    const person = res.rows[0];
    if (person === undefined) {
      return { failure: 'no_such_person: this officer is no longer on the roster' };
    }
    if (person.disabled_at !== null) return { failure: 'disabled: this account is disabled' };
    if (person.placeholder) {
      return { failure: 'placeholder_contact: a stand-in entry, not a real officer' };
    }
    if (person.phone === null || person.phone.trim() === '') {
      return { failure: 'no_number: this officer has no number on the roster' };
    }

    return { phone: person.phone, label: person.full_name };
  }

  if (target.seatId === null) return { failure: 'no_addressee: this obligation names nobody' };

  const res = await pool.query<{
    title: string;
    full_name: string | null;
    phone: string | null;
    placeholder: boolean | null;
  }>(
    `SELECT s.title, p.full_name, p.phone, p.placeholder
       FROM seat s
       LEFT JOIN duty_assignment a
              ON a.seat_id = s.seat_id
             AND a.from_at <= now()
             AND (a.to_at IS NULL OR a.to_at > now())
       LEFT JOIN person p
              ON p.person_id = a.person_id
             AND p.removed_at IS NULL
             AND p.disabled_at IS NULL
      WHERE s.seat_id = $1`,
    [target.seatId],
  );

  const seat = res.rows[0];
  if (seat === undefined) return { failure: 'no_such_post: this post no longer exists' };
  if (seat.full_name === null) {
    return { failure: 'no_duty_holder: nobody currently holds this post' };
  }
  if (seat.placeholder === true) {
    return { failure: 'placeholder_contact: this post holds a stand-in number, not a real one' };
  }
  if (seat.phone === null || seat.phone.trim() === '') {
    return { failure: 'no_number: the holder has no number on the roster' };
  }

  return { phone: seat.phone, label: seat.title };
}

/**
 * The two facts that decide **which buttons this message needs**, resolved without a `fileLink`
 * — so `deliver` can ask *does this message want buttons a picture would take away* before it
 * has decided whether there is a picture at all. `messageFor`, called separately once that is
 * settled, is the only half that actually needs the link.
 */
async function answerPlan(
  pool: Pool,
  incidentId: string,
): Promise<{
  readonly state: IncidentState;
  readonly payload: { description?: string; details?: CommunicationDetails } | undefined;
  readonly answers?: 'attendance' | 'acknowledgement';
  readonly responseCategory?: string;
}> {
  const events = await loadIncident(pool, incidentId);
  const state = foldIncident(incidentId, events);

  const reported = events.find((e) => e.type === 'reported');
  const answers = answersFor(state.kind, {
    asking: stillAsking(state),
    invited: state.asksAttendance,
  });

  /**
   * The category slug for a `dnc_response_*` template — ADR-0034.
   *
   * Computed on every emergency-family message; `templateFor` sends on it only when the category
   * is also in `config.responseCategories`, so this is *which* template, never *whether*. Pure —
   * `whatsappChannel.ts` reads the fold, `ops/whatsapp.ts` stays the transport.
   */
  const responseCategory =
    templateCategoryFor(state.kind, state.category?.value ?? null) ?? undefined;

  return {
    state,
    payload: reported?.payload as
      { description?: string; details?: CommunicationDetails } | undefined,
    ...(answers === undefined ? {} : { answers }),
    ...(responseCategory === undefined ? {} : { responseCategory }),
  };
}

/**
 * Which buttons a message of this kind should carry — 2026-08-19, and the whole of the mapping.
 *
 * ## Three answers, and the third is *"leave it alone"*
 *
 * | kind | buttons | why |
 * |---|---|---|
 * | `meeting` | Attending · Not attending · Sending someone | the district is asking who is coming |
 * | the four that carry an SLA | Acknowledge, and a link | the district is asking to be answered |
 * | `schedule`, `other` | the plain link, unchanged | neither question fits |
 *
 * **`schedule` and `other` deliberately keep the old template**, and that is a decision rather
 * than an oversight. *"Attending"* is not an answer to a duty roster for the 14th to the 20th, and
 * it is not an answer to a notice about a road closure — offering it teaches officers that the
 * buttons do not mean what they say, and a button nobody trusts is worse than no button, because
 * the district still reads the taps as if they meant something.
 *
 * **The four SLA kinds are treated alike, exactly as `CARRIES_SLA` already treats them.** An
 * order and an advisory both ask to be acknowledged and both stop a clock when they are; a second
 * split here would be a second answer to a question `domain/events.ts` has already settled.
 *
 * Returns `undefined` rather than a third name, because the absence *is* the meaning: the message
 * goes on whatever `WHATSAPP_TEMPLATE` names, which is what every message did before this date.
 */
export interface AnswerOptions {
  /** Is this message still asking its own question? A finished meeting is not. */
  readonly asking?: boolean;
  /**
   * **This notice asked who is coming** — the district's five, 2026-08-22, and they said yes.
   *
   * Only read for `other`. A Milad programme can usefully ask; a notice about a closed road
   * cannot, and offering the buttons on both is how officers learn the buttons mean nothing.
   */
  readonly invited?: boolean;
}

export function answersFor(
  kind: MessageKind,
  options: AnswerOptions = {},
): 'attendance' | 'acknowledgement' | undefined {
  const asking = options.asking ?? true;
  /**
   * 🔴 **A meeting that is over asks nobody anything** — the district's five, 2026-08-22.
   *
   * The trap this closes is small and lands on a real handset. `district_notice_v2` carries
   * **Attending · Not attending · Sending someone**, and a **cancellation** sent on it hands
   * every officer three ways to answer a meeting that is not happening — and the taps come
   * back, and the tally counts them, and the district reads a number for a meeting nobody is
   * going to.
   *
   * `answers` was already a **per-message** decision rather than a per-kind one, which is what
   * makes this one parameter rather than a second template: the message rides the plain one,
   * exactly as a schedule and a notice already do. **No new template, and nothing waits on
   * Meta.**
   */
  /**
   * 🔴 **NOTHING FALLS THROUGH TO A LINK-ONLY TEMPLATE ANY MORE** — the owner, 2026-08-25:
   * *"whatsapp sai bahar kese bhi link pr nhe jana chaye hai"*.
   *
   * ## Why this one word decides whether an officer ever leaves WhatsApp
   *
   * Meta opens a 24-hour service window only when the officer **sends** something. A tap on a
   * **quick reply** is an inbound message and opens it; a tap on a **URL button sends nothing at
   * all**. So a template with only a link is a template after which the district cannot put one
   * further message in front of that officer — no options, no follow-up question, no closing
   * sentence. Their whole workflow has to happen on a web page instead.
   *
   * `undefined` used to mean *the plain template*, which is `district_message_v3` — **a link and
   * nothing else**. Every schedule, every plain notice and every cancelled meeting went out that
   * way. They now return `acknowledgement` instead, which is `district_emergency_v2`: a quick
   * reply **and** a link.
   *
   * ⚠️ **NO TEMPLATE IS SUBMITTED, CHANGED OR RESUBMITTED FOR THIS, AND THAT IS NOT LUCK.**
   * `district_emergency_v2.body` **is** `ALERT_TEMPLATE.body` — the same two parameters, the same
   * words, the same `UTILITY` category, the same language. An officer reads an identical message
   * to the one they read yesterday; only the buttons underneath it change. Checked in
   * `ops/whatsappTemplate.ts` rather than assumed.
   *
   * ⚠️ **`district_message_v3` is not deleted and is still reachable.** `templateFor` falls back
   * to it whenever a district has not named an emergency template, which is every installation
   * but this one and was every installation here until August. It remains the honest answer for a
   * district that has approved one template and no more.
   *
   * 🔴 **The photograph path is NOT fixed by this**, and it cannot be fixed in code:
   * `district_message_img_v2` carries a media header and a URL button, and giving it a quick
   * reply means a new submission to Meta. That is the owner's call and it is written up in
   * `backlog/for-the-owner.md`.
   */
  if (kind === 'meeting') return asking ? 'attendance' : 'acknowledgement';
  /**
   * **Information may ask who is coming, when the operator asked for it** — the district's
   * five, 2026-08-22.
   *
   * ⚠️ **It costs nothing and that is the argument for offering it at all.** `other` is
   * outside `CARRIES_SLA`, so there is no clock and no ladder, and `summary.unacknowledged`
   * excludes General kinds (M11-02) — so **an unanswered invitation is not a gap** and nothing
   * anywhere counts it as one. The same three buttons on a kind that owes nobody an answer.
   *
   * `schedule` deliberately gets nothing, unchanged: *"Attending"* is not an answer to a duty
   * roster for the 14th to the 20th.
   */
  if (kind === 'other' && asking && options.invited === true) return 'attendance';
  /**
   * Everything else — `schedule`, a plain `other`, an `order`, and a meeting that is over.
   *
   * ⚠️ **`CARRIES_SLA` is deliberately no longer asked here.** It answers *does this owe an
   * answer by a deadline*, and that is a question about **escalation**, not about which buttons
   * an officer should have. A duty roster owes nobody an answer by 02:00 and still deserves to be
   * answerable without leaving WhatsApp. The clock stays exactly where it was —
   * `jobs/escalation.ts` reads `CARRIES_SLA` itself and nothing here touches it.
   */
  return 'acknowledgement';
}

/**
 * Is this message still asking its own question?
 *
 * Read off the fold rather than from the caller, so a follow-up and a first send cannot
 * disagree about whether a meeting is still on. A resolved or closed meeting is one somebody
 * recorded as **Conducted** or **Cancelled**; a rescheduled one is neither, and it goes on
 * asking — which is the whole of why `rescheduled` is not an ending.
 */
function stillAsking(state: IncidentState): boolean {
  return state.status !== 'resolved' && state.status !== 'closed';
}

/**
 * The same decision, without a database — so it can be tested.
 *
 * Split out of `describe` in M9-12. What an officer reads on a locked handset at 02:00 is the
 * single most consequential string this system produces, and it had **no test at all**: every
 * assertion about it went through an integration path that needs a live Postgres, so in practice
 * nothing asserted on it. That is how "no details were entered" reached the district about an
 * emergency whose details had been entered.
 *
 * Everything here is a pure function of the fold and the report payload. Exported for the tests
 * and for nothing else.
 */
export function messageFor(
  state: IncidentState,
  payload: { description?: string; details?: CommunicationDetails } | undefined,
  /** A link to the first attachment, when there is one — M9-18. */
  fileLink?: string,
  /**
   * **This message is going out on its own `dnc_response_<category>` template, whose static
   * header already names the kind** — 2026-09-05. Resolved by the caller from
   * `categoryNamesKindInHeader` (`ops/whatsappTemplate.ts`), because that is a fact about
   * `config.responseCategories` — an installation's own choice of which templates are switched
   * on — and this function stays a pure read of the fold, taking no config.
   *
   * `undefined`/`false` on every plain template, where `{{1}}` remains the *only* place that says
   * what kind of thing a message is.
   */
  onOwnTypeHeader?: boolean,
  /**
   * **This message's template writes `Location: ` immediately before `{{2}}`** — 2026-09-08.
   * True on every `dnc_response_*` shape and on no other, resolved by the caller from
   * `categoryLabelsLocation` for the same reason `onOwnTypeHeader` is: it is a fact about which
   * templates an installation has switched on, and this function takes no config.
   *
   * It is deliberately **not** `onOwnTypeHeader` reused. That flag is true for the six `_v2`
   * shapes whose header names a kind; this one is true for all twelve, because all twelve carry
   * the label. Folding them into one boolean would leave the `_v1` six — `fire`, `medical`,
   * `road_accident`, `rescue`, `information`, `schedule` — still sending a description under a
   * `Location:` heading, which is the whole defect.
   */
  templateLabelsLocation?: boolean,
): { what: string; where: string } {
  const severity = state.severity?.value ?? 'unknown';
  const category = state.category?.value ?? 'unknown';
  const place = payload?.description;
  const locLine = locationLine(state.location);

  /**
   * A General communication builds both parameters from what the operator filled in — M9-09.
   *
   * **Into the two parameters the approved template already has**, never into new ones. Per the
   * owner's instruction, coding does not wait on a template review, and a message shape that
   * needs Meta's permission to improve is a message shape that will not improve. `messageWhere`
   * folds date, time, venue, note and now location into one line and bounds it.
   *
   * Emergencies fall through to exactly what they have always sent, untouched. That matters more
   * than it looks: this function's output is what every officer in Bajaur has learned to read at a
   * glance, and M9 has no business changing it.
   */
  if (isGeneral(state.kind)) {
    return {
      what: messageSubject(
        state.kind,
        hasCategory(state.kind, category)
          ? `${labelFor(state.kind)} · ${category}`
          : labelFor(state.kind),
        payload?.details,
      ),
      where: messageWhere(place ?? '', payload?.details, fileLink, locLine, templateLabelsLocation),
    };
  }

  /**
   * **The subject line says what kind of thing this is, first — M7-23/24, unless the template
   * has already said so — 2026-09-05.**
   *
   * One template carries all four, so the only thing distinguishing an advisory from an
   * emergency on a lock screen is this word. An officer who cannot tell them apart at a glance
   * learns to treat all four the same, and the one that mattered goes unread — which is
   * precisely the failure a district that sends forty messages a day should expect.
   *
   * Emergencies carry no prefix. They are the default and the majority, and prefixing them
   * would make the word meaningless by repetition. **A message on its own response template
   * carries no prefix either, for the same reason applied to a second case**: the header above
   * `{{1}}` already reads `District Alert` / `District Advisory` / … — a control room read
   * `District Alert` followed by `ALERT · high` and asked why the message said *Alert* twice.
   */
  const prefix =
    onOwnTypeHeader === true || state.kind === 'emergency' ? '' : `${state.kind.toUpperCase()} · `;

  /**
   * **The two-details-boxes defect — M9-12, and the owner walked into it themselves.**
   *
   * The report screen has `#what`, before submit, which becomes `description` on the `reported`
   * event and is what this function reads. It also has `#place` and `#detail`, offered *after*
   * submit, which become an `action_logged` note. The owner typed into the second pair and the
   * alert went out saying *"no details were entered"* — a message that was actively wrong, about
   * an emergency, to officers.
   *
   * Relabelling the boxes was the obvious fix and is the wrong one. The order of events is what
   * makes this happen: an operator submits fast (INV-01, two taps and a button), *then* fills in
   * the place, *then* chooses who to tell — so by the time anything is sent, the detail exists
   * and this function was simply not looking at it.
   *
   * So it looks. The message is built at send time from the fold, and the fold has the actions.
   * Nothing is rewritten, no event is edited, and an operator who typed into either box gets a
   * message carrying what they wrote — which is what they believed was happening all along.
   *
   * `description` still wins when both exist: it is what somebody wrote *about the emergency
   * itself*, before anything else, and an action note is a later addition.
   */
  const fromActions = state.actions.map((a) => a.note.trim()).filter((n) => n !== '');
  const said =
    place !== undefined && place.trim() !== ''
      ? place.trim()
      : // The most recent, not the first. A crew's later note is the more current picture, and
        // this is one parameter rather than a transcript.
        (fromActions[fromActions.length - 1] ?? '');

  /**
   * **`'other'` says nothing on any kind but `emergency` — see `hasCategory`.** Alert, Advisory
   * and Order are the three here that reach this branch (`isGeneral` already sent Meeting,
   * Schedule and Information the other way, above), and none of their tiles ever offer a
   * category to choose — `web/src/main.ts`'s `TILES` writes `'other'` on all three because the
   * field has to hold *something*. Printing it read as *"this alert could not be classified"*
   * next to a word, `ALERT`, that had already classified it.
   *
   * **Dropped outright when the header already names the kind — 2026-09-05**, the same case
   * `prefix` above carries: `District Alert` above `flood · high` repeats *flood* nowhere the
   * header does not already say `Flood Alert`, and repeats the word `Alert` twice on the four
   * that keep it in their own header.
   */
  const categorySegment =
    onOwnTypeHeader === true || !hasCategory(state.kind, category) ? '' : `${category} · `;

  /**
   * **Severity and location, and nothing this message has already said** — 2026-09-05.
   *
   * `said` is what happened; `locLine` is where. Both are real, independent facts an operator
   * may have given, so both ride when both exist, joined the same way every other part of this
   * message joins its parts — ` · `, read once and never mistaken for two separate messages.
   * Falling back only when **neither** exists keeps the old placeholder honest: "place not
   * stated" now means what it says, rather than firing whenever `description` alone was empty
   * on an incident whose location the device had already found.
   */
  const bodyParts = [said, locLine].filter((p): p is string => p !== null && p !== '');
  const bodyBase =
    bodyParts.length > 0
      ? bodyParts.join(' · ')
      : state.kind === 'emergency'
        ? 'place not stated'
        : 'no details were entered';

  /**
   * **On a `Location:`-labelled template the place leads and the description follows** —
   * 2026-09-08. `messageWhere` does the joining (`locationLabelled`), so the fallback wording,
   * the `not stated` placeholder and the link-reservation budget stay in one place rather than
   * being re-derived here.
   *
   * `said` is handed over as the fallback and `locLine` as the location, which is exactly what
   * the General branch above already does — the two branches differ in what they *have*, never
   * in how the labelled line is built.
   */
  if (templateLabelsLocation === true) {
    return {
      what: `${prefix}${categorySegment}${severity === 'unknown' ? 'not yet assessed' : severity}`,
      where: messageWhere(said, undefined, fileLink, locLine, true),
    };
  }

  return {
    what: `${prefix}${categorySegment}${severity === 'unknown' ? 'not yet assessed' : severity}`,
    // Meta refuses an empty template parameter outright, so a message with nothing in the body
    // would fail to send rather than send short. The placeholder says what is missing.
    //
    // The attachment link rides here too, through the same `messageWhere` the General kinds
    // use — so **the link is reserved and the words are cut around it**, identically on every
    // kind. An emergency is the case where this matters most: a photograph of the scene is
    // worth more to the officer driving to it than the last twenty characters of a description
    // they are about to see for themselves.
    where: messageWhere(bodyBase, undefined, fileLink),
  };
}

/** The picture, once resolved. The optional half of `OutboundMessage`, named so it can be returned. */
type OutboundPicture = NonNullable<OutboundMessage['media']>;

/**
 * How long one uploaded picture's media id is reused — M10-34a.
 *
 * **`deliver` is called once per RECIPIENT, and a dispatch routinely names a whole department.**
 * Without this, a notice to forty officers uploads the same photograph forty times — forty round
 * trips carrying the same megabytes, from the one machine that is also taking emergency reports,
 * and forty chances for a slow upload to delay a message that is already late.
 *
 * Meta's ids are good for thirty days; this keeps one for ten minutes, and the short window is
 * deliberate. It is long enough for a fan-out and its retries and short enough that nothing here
 * is a cache anybody has to reason about across a shift. **An expired entry simply uploads
 * again**, which is exactly the behaviour `uploadMedia`'s own comment describes as the safe
 * default — this narrows that default for the one case that repeats, rather than reversing it.
 */
const MEDIA_ID_TTL_MS = 10 * 60 * 1000;

export function whatsappChannel(options: WhatsAppChannelOptions): NotificationChannel {
  const { pool, config } = options;
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot();

  /**
   * Keyed by evidence id, and **per channel instance** rather than per module.
   *
   * A module-level map would be shared by every channel a test constructs, so one suite's upload
   * would satisfy another's assertion and the fan-out behaviour below could never be proved.
   */
  const mediaIds = new Map<string, { readonly mediaId: string; readonly expiresAt: number }>();

  /**
   * The photograph that rides the message, when there is one — M10-34a.
   *
   * **This is the wiring the whole of Phase E was missing.** `templateFor` has been choosing
   * between the two approved templates since `1d543eb`, and `uploadMedia` has been able to put
   * bytes on Meta's servers since M9-17 — but nothing ever called it, so `message.media` was
   * permanently `undefined`, the image branch was unreachable in production, and a photograph
   * went out as a link no matter what `.env` said. Four tests passed over it because every one
   * of them handed `sendWhatsApp` a `media` field itself.
   *
   * **Every refusal below returns `undefined`, and that is the design rather than laziness.**
   * `undefined` means *no picture on this message*, which sends the ordinary template with the
   * single-use link already built above — the exact behaviour of yesterday. So the worst case
   * for a photograph that cannot be uploaded is the district's status quo, never a failed send.
   * INV-01 outranks a nicer-looking message, and this is the same rule `settled()` follows when
   * an upload loses its race.
   */
  async function pictureFor(first: Evidence | undefined): Promise<OutboundPicture | undefined> {
    // Nothing attached, or no picture-carrying template of any kind approved yet. The second is
    // Bajaur's state until at least one of `WHATSAPP_TEMPLATE_IMAGE`,
    // `WHATSAPP_TEMPLATE_NOTICE_IMAGE` or `WHATSAPP_RESPONSE_IMAGE_CATEGORIES` is set, and it is
    // not a fault — it is the ordinary configuration.
    const hasAnyImageTemplate =
      config.imageTemplate !== undefined ||
      config.noticeImageTemplate !== undefined ||
      (config.responseImageCategories?.size ?? 0) > 0;
    if (first === undefined || !hasAnyImageTemplate) return undefined;

    /**
     * **A PDF is never here, and that is the owner's decision rather than a limitation to fix.**
     * They chose images only, so no document template was ever submitted — which is what makes
     * the file-link page load-bearing rather than a fallback.
     *
     * **The comparison is safe because `evidence.content_type` is the SNIFFED type** (M9-14):
     * `store()` writes `decideType`'s verdict, read from the file's own magic number, and refuses
     * a mismatch outright. So this is a fact about the bytes, not the claim a handset made about
     * them — which matters, because trusting the claim here would send Meta something that is
     * not a JPEG and have it refuse the message.
     */
    if (first.contentType !== 'image/jpeg') return undefined;

    const now = Date.now();
    const cached = mediaIds.get(first.evidenceId);
    if (cached !== undefined && cached.expiresAt > now) {
      return { mediaId: cached.mediaId, filename: first.filename, kind: 'image' };
    }

    const read = await fetchEvidence(pool, evidenceRoot, first.evidenceId);
    if (!read.ok) {
      log('warn', 'the picture could not be read, so it travels as a link', {
        evidenceId: first.evidenceId,
        why: read.why,
      });
      return undefined;
    }

    /**
     * A file whose bytes no longer hash to what was recorded is still sent, and still reported.
     *
     * `ops/evidence.ts` settles this: reported rather than enforced, because it may be the only
     * photograph of the scene. Withholding it would turn a detectable problem into a missing one
     * — and the officer driving to the scene is not the person who can act on a hash mismatch.
     */
    if (!read.value.intact) {
      log('warn', 'sending a picture whose bytes no longer match their recorded hash', {
        evidenceId: first.evidenceId,
      });
    }

    const uploaded = await uploadMedia(
      config,
      { bytes: read.value.bytes, contentType: first.contentType, filename: first.filename },
      options.fetchImpl,
    );

    if (!uploaded.ok) {
      log('warn', 'the picture could not be uploaded, so it travels as a link', {
        evidenceId: first.evidenceId,
        failure: uploaded.failure,
        retryable: uploaded.retryable,
      });
      return undefined;
    }

    // Expired entries are dropped on the way past, so this map cannot grow for the life of the
    // process. There is no timer to own and nothing to shut down — ADR-0007's question again.
    for (const [key, value] of mediaIds) if (value.expiresAt <= now) mediaIds.delete(key);
    mediaIds.set(first.evidenceId, { mediaId: uploaded.mediaId, expiresAt: now + MEDIA_ID_TTL_MS });

    return { mediaId: uploaded.mediaId, filename: first.filename, kind: 'image' };
  }

  /**
   * Said out loud at construction, and deliberately **not** refused.
   *
   * The tokens this channel mints are only reachable at `${publicOrigin}/ack/`, and that prefix
   * lives in the approved template where nothing in this process can see it. What *can* be
   * checked here is that the district has a real address at all — a channel built against a
   * loopback default sends links no handset in Bajaur can open, and it does it silently, which
   * is how the dead link of 2026-08-12 survived a send that reported success.
   *
   * A throw would be the wrong instrument. `config.ts`'s rule is that a refusal is for a
   * configuration that is broken or unsafe, and everything that merely leaves the district less
   * protected warns and keeps running — a process that will not start is a district that cannot
   * report an emergency. A dead acknowledge button costs an acknowledgement; refusing to boot
   * costs the emergency.
   */
  if (!options.publicOrigin.startsWith('https://')) {
    log('warn', 'the acknowledge button will not be reachable', {
      publicOrigin: options.publicOrigin,
      why: 'PUBLIC_ORIGIN is not an https address, so the /ack/ link goes nowhere a handset can reach',
    });
  }

  return {
    name: 'whatsapp',

    async deliver(target) {
      const addressee = await numberFor(pool, target);
      if ('failure' in addressee) return { ok: false, failure: addressee.failure };

      /**
       * The attachment, and the link that carries it — M9-18.
       *
       * **One token per recipient**, minted here rather than once per incident, so
       * `opened_count` answers *which officer opened it* and not merely *whether anybody did*.
       * `fileTokenStore` says why that matters.
       *
       * **The first attachment only.** One parameter carries the date, the venue, the note and
       * this link inside 300 characters; a second link would leave room for nothing else. An
       * operator who needs to send three documents sends three notices, which is also what the
       * officer receiving them can actually act on.
       *
       * Minted **before** the send, for the same reason the acknowledge token is: a token
       * created afterwards is lost if the process dies in between, leaving a message in
       * somebody's WhatsApp with a link that leads nowhere. A token for a message that never
       * went is harmless — it expires unused.
       */
      const attachments = await listFor(pool, target.incidentId);
      const first = attachments[0];

      /**
       * Which buttons this message needs, resolved **before** the picture — 2026-09-04.
       *
       * ⚠️ **A picture must not cost a meeting its RSVP, or a category its own buttons, unless
       * Meta has never been asked to approve a template that keeps both.**
       * `district_message_img_v3` is the *ordinary* picture template, and it carries only
       * `Acknowledge` / `Open details`. Letting every picture win unconditionally meant a meeting
       * notice with a photograph went out asking to be *Acknowledged* rather than *Attending /
       * Not attending / Sending someone* — and since `listFor` has nothing to offer a meeting on
       * tap, that RSVP was never asked at all, on WhatsApp or afterwards. A response-category
       * alert lost the same thing more gently: its three buttons arrived only after an extra
       * `Acknowledge` tap, as a list rather than as buttons.
       *
       * The owner then asked for a stronger fix on five kinds — meeting, advisory, order,
       * schedule, information — than "send it as a link": a picture-carrying version of each
       * one's own template, submitted to Meta separately (`NOTICE_TEMPLATE_IMAGE`,
       * `RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY` in `ops/whatsappTemplate.ts`). So a message that
       * needs either kind of button sends its picture as the ordinary file link **only when no
       * such template is approved and named yet** — `imageCapable` below is exactly `templateFor`
       * (`ops/whatsapp.ts`)'s own test for whether one is, kept in step with it rather than
       * guessed at a second time.
       */
      const plan = await answerPlan(pool, target.incidentId);
      const wantsAttendanceButtons = plan.answers === 'attendance';
      const wantsCategoryButtons =
        plan.responseCategory !== undefined &&
        config.responseCategories?.has(plan.responseCategory) === true;
      const wantsButtons = wantsAttendanceButtons || wantsCategoryButtons;

      const imageCapable =
        (wantsAttendanceButtons && config.noticeImageTemplate !== undefined) ||
        (wantsCategoryButtons &&
          config.responseImageCategories?.has(plan.responseCategory ?? '') === true);

      /**
       * The picture is resolved **first** otherwise, because whether it rode decides whether a
       * link is needed at all — the owner's instruction, 2026-08-17, after seeing both on one
       * message.
       */
      const picture = wantsButtons && !imageCapable ? undefined : await pictureFor(first);

      /**
       * **The link and the picture are alternatives, never both.**
       *
       * A link under a photograph the officer is already looking at is a tap that leads to the
       * same photograph. It reads as clutter on the message that matters most, and it costs the
       * ~40 characters `SEPARATOR` reserves out of `{{2}}` — which `messageWhere` pays for by
       * cutting the operator's own words.
       *
       * ⚠️ **The condition is `picture === undefined`, not "is this a JPEG", and that is the
       * whole care in this change.** An upload Meta refuses, a file missing from disk, an image
       * template not yet approved — every one of those leaves `picture` undefined, and every one
       * of them **must still send the link**, or the officer gets neither the photograph nor a
       * way to reach it. Written as *"a JPEG needs no link"* it would be right on the good day
       * and lose the file on the bad one, which is the day it matters.
       *
       * **What is given up, stated rather than buried:** `opened_count` no longer records that
       * this officer looked. For a picture rendered in the chat there was never anything to
       * record — WhatsApp reports no such thing — so the honest reading is that the count stops
       * over-claiming, not that a signal was lost. **A PDF keeps the link and keeps the count.**
       */
      /**
       * The post this officer holds, resolved **once, here, at mint time** — and the timing is
       * the whole care in it.
       *
       * A dispatch to a named officer carries no seat, so every acknowledgement path refused to
       * stop the incident's clock (see `dutySeatOfPerson`). Resolving it is what fixes that, but
       * it may only be resolved **now**: `mintAckToken`'s own comment says the seat and person
       * are captured as they are at mint time precisely so that a handover between the message
       * going out and the tap arriving does not attribute the acknowledgement to whoever holds
       * the post at that later moment (ADR-0004). Looking this up when the link is redeemed would
       * be the same bug that comment exists to prevent, arriving through a new door.
       *
       * `target.seatId` still wins when it is set. A post or a department chose the recipient
       * there, and that is a stronger statement than this lookup.
       *
       * ⚠️ **This deliberately does NOT touch the obligation or `targetKey`.** The ledger row
       * stays person-keyed, so *"tell the DEO"* and *"tell Officer Golf, who holds the DEO post"* remain
       * two obligations exactly as M6 decided — and `oneMessagePerRecipient` still sees the same
       * two recipients it saw yesterday. Only the token learns the seat.
       */
      const recipientSeatId =
        target.seatId ??
        (target.personId === null ? null : await dutySeatOfPerson(pool, target.personId));

      const fileLink =
        first === undefined || picture !== undefined
          ? undefined
          : `${options.publicOrigin.replace(/\/+$/, '')}/file/${await mintFileToken(pool, {
              evidenceId: first.evidenceId,
              incidentId: target.incidentId,
              seatId: recipientSeatId,
              personId: target.personId,
            })}`;

      /**
       * `wantsCategoryButtons` already IS "this message is going out on its own
       * `dnc_response_<category>` template" — the same condition `ops/whatsapp.ts`'s
       * `templateFor` resolves the category branch on, picture or no picture (an image variant
       * carries the identical `bodyText`, just with a header added). `categoryNamesKindInHeader`
       * narrows it to the six shapes whose header actually names a kind — the other six
       * (`fire`, `road_accident`, `medical`, `rescue`, `schedule`, `information`) keep the
       * generic `District Nerve Center` opener and have nothing for `{{1}}` to repeat.
       */
      const onOwnTypeHeader =
        wantsCategoryButtons && categoryNamesKindInHeader(plan.responseCategory ?? '');

      /**
       * **All twelve response shapes write `Location: ` before `{{2}}`, not only the six with a
       * kind in the header** — 2026-09-08, which is why this is resolved separately from
       * `onOwnTypeHeader` rather than reusing it. Same guard on `wantsCategoryButtons`: a
       * category the installation has not switched on sends on `WHATSAPP_TEMPLATE`, whose second
       * parameter carries no label and must keep reading as free prose.
       */
      const templateLabelsLocation =
        wantsCategoryButtons && categoryLabelsLocation(plan.responseCategory ?? '');

      const { what, where } = messageFor(
        plan.state,
        plan.payload,
        fileLink,
        onOwnTypeHeader,
        templateLabelsLocation,
      );
      const { answers, responseCategory } = plan;

      /**
       * True when this alert will go out on its own `dnc_response_<category>` template — ADR-0034.
       *
       * `picture === undefined` here is never *the picture won* for an enabled category — `plan`
       * already sent its photograph out as a link for exactly this reason. It still catches the
       * ordinary cases: no photograph at all, or one that failed to upload and fell back to a
       * link on its own.
       */
      const onResponseTemplate =
        responseCategory !== undefined &&
        picture === undefined &&
        config.responseCategories?.has(responseCategory) === true;

      /**
       * The acknowledge link is minted **before** the send, and that ordering matters.
       *
       * A token created after a successful send would be lost if the process died in between,
       * leaving a message in somebody's WhatsApp with a link that leads nowhere. A token minted
       * for a message that never went is harmless: it expires unused in 24 hours.
       *
       * The `attemptId` it is bound to is the one the caller already appended, so the tap
       * settles the obligation the ledger is actually tracking.
       */
      const token = await mintAckToken(pool, {
        attemptId: target.attemptId,
        incidentId: target.incidentId,
        // Resolved above. This is what lets the tap stop the incident's clock for an officer the
        // control room chose by name — until now it carried a null and the tap recorded nothing.
        seatId: recipientSeatId,
        personId: target.personId,
      });

      /**
       * **Said out loud when the buttons this message asked for are not the buttons it gets.**
       *
       * `templateFor` falls through to the ordinary template in two situations and until now it
       * did both of them in complete silence — which is the gap found on 2026-08-20, against an
       * owner who had been told that a missing template *"still sends, and says so in the log"*.
       * Half of that sentence was true.
       *
       * The two are not the same problem and are worth telling apart:
       *
       *   * **a picture won.** Only one approved template carries a header, so a photograph and
       *     a one-tap answer cannot ride the same message — the owner's own decision of
       *     2026-08-18. Expected, and still worth a line, because *"why did this emergency have
       *     no Acknowledge button"* has no other answer anywhere.
       *   * **the district has not named the template.** The `.env` line is missing or the
       *     approval lapsed. Bajaur has both today, so this one means something changed.
       *
       * A `warn` rather than an `info` for the second: an officer is about to be sent out to a
       * browser they were promised they would not need.
       */
      /**
       * **The photograph rode AND the buttons still came — the owner's own line, 2026-09-04.**
       *
       * `templateFor` only reaches `NOTICE_TEMPLATE_IMAGE` / a `dnc_response_*_img_*` shape when
       * `picture` is defined and the matching `*ImageTemplate` config is set — `wantsButtons` /
       * `imageCapable` above are what let `picture` survive at all for a message that needs
       * either kind of button, so these two are never true for a photograph that ended up on the
       * ordinary link path instead.
       */
      const pictureOnNoticeImage =
        picture !== undefined && wantsAttendanceButtons && config.noticeImageTemplate !== undefined;
      const pictureOnCategoryImage =
        picture !== undefined &&
        wantsCategoryButtons &&
        config.responseImageCategories?.has(responseCategory ?? '') === true;

      if (onResponseTemplate) {
        // Not a fallback and not a warning: this category answers on its own approved template,
        // with three quick replies and no link — the district's own workflow (ADR-0034).
        log('info', 'this category alert goes out on its own response template', {
          incidentId: target.incidentId,
          category: responseCategory,
        });
      } else if (pictureOnCategoryImage) {
        log(
          'info',
          'this category alert goes out on its own response template, with the photograph on it',
          {
            incidentId: target.incidentId,
            category: responseCategory,
          },
        );
      } else if (pictureOnNoticeImage) {
        log('info', 'this meeting notice carries its photograph and its RSVP buttons together', {
          incidentId: target.incidentId,
        });
      } else if (answers !== undefined) {
        const named = answers === 'attendance' ? config.noticeTemplate : config.emergencyTemplate;
        if (picture !== undefined) {
          log('info', 'a photograph rides this message, so it carries no tappable answer', {
            incidentId: target.incidentId,
            asked: answers,
          });
        } else if (named === undefined) {
          log('warn', 'this message asked for tappable answers and the template is not named', {
            incidentId: target.incidentId,
            asked: answers,
            why:
              answers === 'attendance'
                ? 'WHATSAPP_TEMPLATE_NOTICE is not set, so the meeting goes out with a link instead'
                : 'WHATSAPP_TEMPLATE_EMERGENCY is not set, so the alert goes out with a link instead',
          });
        }
      }

      const result = await sendWhatsApp(
        config,
        {
          toPhone: addressee.phone,
          what,
          where,
          // The token, not the URL. The prefix is baked into the approved template and Meta
          // appends this to it — see `ackToken` in `ops/whatsapp.ts`. `publicOrigin` is still
          // what that prefix must equal, and `templateProblems` is what holds them together.
          ackToken: token,
          // Resolved above, because it also decided whether `where` carries a link.
          ...(picture === undefined ? {} : { media: picture }),
          /**
           * Which buttons this message should carry — 2026-08-19.
           *
           * The kind is read here, where the fold already is, and handed across as *what this
           * message asks for* rather than as *what kind of thing it is*. `ops/whatsapp.ts` is
           * the transport and has no business knowing what a meeting is; it needs to know which
           * template's buttons to build, and that is a smaller question with a stabler answer.
           *
           * Spread rather than assigned, because `exactOptionalPropertyTypes` is on: absent and
           * present-but-undefined are different things here, and the first is what *"send this on
           * the plain template"* means.
           */
          ...(answers === undefined ? {} : { answers }),
          /**
           * Which `dnc_response_<category>` template this category answers on — ADR-0034.
           *
           * Passed whenever the fold produced one; `templateFor` sends on it only if the category
           * is in `config.responseCategories`, and the picture branch there wins first, so a
           * photograph alert is unaffected.
           */
          ...(responseCategory === undefined ? {} : { responseCategory }),
        },
        options.fetchImpl,
      );

      if (!result.ok) {
        /**
         * A retryable refusal is **not** recorded as a failure — M6-24.
         *
         * A new number is rate limited by Meta until its usage earns the tier up, and hitting
         * that cap is a message deferred rather than an emergency nobody could be told about.
         * Returning `ok: false` here would append `notification_failed`, and `alreadyAttempted`
         * would then never try again — a ninety-second cap turned into a permanent failure on
         * the district's board.
         *
         * So it throws, which `runNotifyPass` catches into a failure... no: the caller checks
         * `retryable` explicitly. See `notify.ts`.
         */
        return {
          ok: false,
          failure: result.failure,
          ...(result.retryable ? { retryable: true } : {}),
        };
      }

      await recordSent(pool, {
        providerMessageId: result.providerMessageId,
        attemptId: target.attemptId,
        incidentId: target.incidentId,
        /**
         * Stored **normalised**, in the form it was actually sent in.
         *
         * The roster holds numbers as the district typed them — `0300-0000001`, `+92 300 111
         * 2222` — and an inbound reply arrives from Meta as bare international digits. Storing
         * the roster's spelling and matching against Meta's would never match, so **every reply
         * would land nowhere** while looking like nobody ever answered. Caught by the reply
         * test, which is the only thing in this codebase that walks both halves.
         */
        toPhone: toE164(addressee.phone),
      });

      /**
       * **Accepted by Meta is not delivered**, so this reports no success.
       *
       * The attempt stays `pending` until a status webhook says `delivered` — or, better, until
       * the officer taps the acknowledge link, which is what actually meets the obligation
       * (ADR-0014). A channel that returned `ok: true` here would tell the control room an
       * officer knows about an emergency on the strength of an HTTP 200 from a datacentre.
       */
      /**
       * `what` and `where` ride back with it — 2026-08-23.
       *
       * They are the only two parts of the message a human reads; the token, the media id and
       * the template name are the envelope. The caller appends them to the log, because writing
       * the record is the caller’s job (see the contract in `notify.ts`).
       */
      return {
        ok: false,
        failure: 'sent: waiting for delivery',
        pending: true,
        sent: { what, where, providerMessageId: result.providerMessageId },
      };
    },
  };
}
