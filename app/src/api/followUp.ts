/**
 * **The control room chases, by hand — Phase 8b, 2026-08-21.**
 *
 * ## Why this exists, and it is the other half of a deletion
 *
 * Phase 8a stopped the escalation ladder messaging an officer's superior, because the district
 * asked for it: *"un ke high up office ko inform/shikayat nahi karni hai … officers ke paas
 * ikhtiyar hai ke woh jab chahen din ke andar response den … software khud se koi follow up na
 * bheje — **control room hi follow up bheje**."*
 *
 * That last clause is this file. Taking the chasing off the software is only honest if the **room**
 * is given it — otherwise the district ends up with an emergency it can see is overdue and nothing
 * it can do about it, which is worse than where it started. Until this landed, that was exactly the
 * position: the incident screen reaches no officer at all, and the recipient picker sits *"below
 * the report, never above it"* (M6-06), reachable from a fresh report only.
 *
 * ## 🔴 A FOLLOW-UP IS NOT AN `action_logged`, AND THAT IS THE SHARPEST THING HERE
 *
 * `foldIncident` moves an incident to **`responding`** on an `action_logged` — correctly, because
 * that event means *somebody did something about this emergency*. A follow-up is sent **because
 * nobody has answered**. Recorded as an action it would put the emergency on the board as
 * **Responded**, claiming an officer is working on it, at the precise moment the truth is that
 * nobody is — **a false state on the one screen a district acts on, written by the act of
 * chasing.** So `followed_up` is its own event and the fold deliberately has no case for it.
 *
 * ## And it is not a notification attempt either
 *
 * `alreadyAttempted` keys on the target **and the reason**, so a second follow-up to one officer
 * would collide with the first and silently never send. And the obligation to tell them was
 * **already discharged** — this chases one that went unanswered rather than creating a new duty.
 * A second unmet row for one emergency is INV-03's own failure mode, manufactured.
 *
 * ## 🔴 THE 24-HOUR WINDOW DECIDES WHICH OF TWO MESSAGES GOES, AND IT BITES WHERE THIS IS AIMED
 *
 * Meta allows a free-form message only to a number that has written to this one in the last day.
 * **An officer who has gone quiet is, by definition, one who has not** — which is precisely the
 * officer a control room wants to chase. So there are two paths and both are real:
 *
 *   * **Window open** — a plain message, **quoted under the original alert** on the officer's own
 *     screen, which is what the district described.
 *   * **Window shut** — the alert goes again on an **already-approved template**. ⚠️ **No template
 *     is created or edited for this**, which is the owner's standing instruction: it rides
 *     `district_emergency_v2` exactly as an ordinary dispatch does.
 *
 * ⚠️ **The ack token is minted against the ORIGINAL attempt, never a new one.** The follow-up
 * chases that obligation, so an officer who taps *Acknowledge* on it settles **the attempt that
 * was already pending** — the ledger closes where it was opened, rather than growing a second row
 * for one emergency.
 *
 * ## What is recorded, and it works whether or not the send did
 *
 * The district asked that the record name the message being followed up on — *"pehle bheje gaye
 * msg ke baare mein ho … taake record maintain kiya ja sake."* `followed_up` carries the original
 * `provider_message_id` and the instant it went, read from `whatsapp_message`. **That half is
 * entirely ours.** A refused send is written **in words on the same event**, which is
 * `keepEvidence`'s rule: INV-03 is about a failure being visible **where somebody acts on it**, and
 * a control room that pressed the button and saw nothing must be told on the incident.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import {
  handsetsToldAbout,
  mintAckToken,
  recordSent,
  sessionWindowOpen,
} from '../db/whatsappStore.js';
import type { Identity } from '../auth/sessions.js';
import { defaultRules, evaluateRead, evaluateWrite } from '../domain/authority.js';
import type { IncidentEvent } from '../domain/events.js';
import { isGathering, isGeneral } from '../domain/events.js';
import { followUpTemplateAsk, followUpText } from '../domain/followUpWords.js';
import { labelFor } from '../domain/communications.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import {
  stageButtonWords,
  WHERE_BUTTON_WORDS,
  availabilityButtonId,
  stageButtonId,
  stagesOfferedFrom,
} from '../domain/stages.js';
import { log } from '../obs/log.js';
import {
  sendSession,
  sendWhatsApp,
  toE164,
  type SendResult,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import { seatOf } from './lifecycle.js';

export interface FollowUpOptions {
  readonly pool: Pool;
  readonly identity: Identity;
  readonly incidentId: string;
  /** The district's own words. Absent is ordinary — most chases say the same thing. */
  readonly note?: string | null;
  /** One handset, or every handset told about this emergency when absent. */
  readonly toPhone?: string | null;
  readonly config: WhatsAppConfig | null;
  readonly fetchImpl?: typeof fetch;
}

export interface FollowUpChased {
  readonly phone: string;
  readonly delivered: boolean;
  /** Why not, when it did not go. Null on success. */
  readonly failure: string | null;
  /** Which of the two paths was taken. Reported so a screen can explain itself. */
  readonly path: 'thread' | 'template';
}

export type FollowUpResult =
  | { readonly ok: true; readonly chased: readonly FollowUpChased[] }
  | { readonly ok: false; readonly status: number; readonly error: string };

const refuse = (status: number, error: string): FollowUpResult => ({ ok: false, status, error });

/**
 * Chase everybody this district told about one emergency, or one named handset.
 *
 * ⚠️ **Never partially refused once it has begun.** A control room told *"two of your three went"*
 * has to work out which, on a telephone, at 02:00 — `dispatchTo`'s own rule. Every refusal that
 * can be made is made **before the first message**; after that every handset is attempted and each
 * outcome is reported on its own, because a provider's bad minute for one officer must not stop
 * the other two being chased.
 */
export async function followUp(options: FollowUpOptions): Promise<FollowUpResult> {
  const { pool, identity, incidentId } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const seat = seatOf(identity);

  if (options.config === null) {
    // Not a 500. The district may simply not have bought the account yet (R-05), and the screen
    // should say so rather than reporting a fault in software that is working correctly.
    return refuse(409, 'WhatsApp is not configured for this installation');
  }
  const config = options.config;

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return refuse(404, 'no such incident');

  const state = foldIncident(incidentId, events);

  // A refused read is a 404, never a 403 — confirming an incident exists is itself a disclosure
  // about another department's operations.
  const readable = evaluateRead({ seat, responsibleDepartmentIds: state.responsibleDepartmentIds });
  if (!readable.allowed) return refuse(404, 'no such incident');

  /**
   * ⚠️ **`incident.dispatch`, deliberately not a new authority row.**
   *
   * A follow-up **is** telling somebody about this emergency — the same act as choosing them in the
   * first place, performed again. Whoever may dispatch may chase. A second policy row for one act
   * would be two answers to *who may reach an officer about this*, and the day they disagree is
   * the day nobody can say which is the district's rule (ADR-0003).
   */
  const rule = defaultRules(state.responsibleDepartmentIds[0] ?? null).find(
    (r) => r.fieldKey === 'incident.dispatch',
  );
  // Fails closed: a field with no rule is refused rather than allowed.
  if (rule === undefined) return refuse(403, 'no authority rule governs incident.dispatch');

  const decision = evaluateWrite(rule, { fieldKey: 'incident.dispatch', seat });
  if (!decision.allowed) return refuse(403, decision.why);

  const wanted =
    options.toPhone === undefined || options.toPhone === null ? null : toE164(options.toPhone);

  const told = await handsetsToldAbout(pool, incidentId);
  const handsets = wanted === null ? told : told.filter((h) => h.phone === wanted);

  if (handsets.length === 0) {
    /**
     * Two different situations, and the district can act on the difference.
     *
     * Nobody was ever told — so there is nothing to follow up **on**, and the answer is to choose
     * who should know rather than to chase. Or the named handset was never one of them, which is
     * a caller error and says so.
     */
    return refuse(
      409,
      wanted === null
        ? 'nobody has been told about this yet — choose who should know first'
        : 'that number was never told about this emergency',
    );
  }

  const what = describe(state);
  const chased: FollowUpChased[] = [];

  /**
   * 🔴 **THE FOLLOW-UP CARRIES THE BUTTONS, AND IT SHIPPED WITHOUT THEM — 2026-08-21, PHASE 9a.**
   *
   * The owner found it on a real handset within hours of 8c landing: the control room chased, the
   * officer typed **"It is resolved"**, and the emergency sat on the board as *Responded*. Read
   * off the live database afterwards rather than reasoned about — **two** outbound messages on
   * that incident, the alert and this follow-up, and this one went as **plain text**.
   *
   * So the chase handed an officer a message with **no way to answer but typing** — and typing
   * moves nothing, deliberately: `webhooks.ts` records a reply, settles the obligation and
   * acknowledges, and **never reads the words for meaning**, which is a decision from 2026-08-08
   * and is still the right one. The machinery to move a stage safely has existed since Phase C,
   * and **the follow-up simply did not offer it** — while Phase 5's nudge, which is switched off,
   * did.
   *
   * ⚠️ **Whatever is still ahead, and nothing else.** `stagesOfferedFrom` is the one transition
   * table this system has; an already-resolved emergency offers nothing and the message stays
   * plain text. Until 2026-09-04 this was **three from `routed`**, Meta's cap exactly, so
   * *"Where I am"* was deliberately **not** added here as `offerNextStages` adds it. That function
   * answers an officer who has just acknowledged, where two stages leave room for a third button;
   * this one could already be at the cap, and a fourth is a send Meta refuses outright.
   *
   * 🔴 **AMENDED 2026-08-23: it IS added, but only when there is room — and that is a REPAIR
   * rather than a change of mind.** The reasoning above is untouched and is exactly what
   * `roomForAvailability` encodes; what changed is that the acknowledgement stopped carrying
   * buttons at all (the owner's correction, `api/webhooks.ts`'s `thankForAcknowledgement`), so
   * `offerNextStages` no longer offers availability to anybody and **this became the only place
   * an officer can say where they are without leaving WhatsApp.** Phase C2's whole claim — *the
   * last thing that needed a browser does not* — died silently otherwise, and three tests in
   * `availabilityInWhatsApp.test.ts` said so.
   *
   * 🔴 **2026-09-04: `stagesOfferedFrom` stopped ever returning three.** `Acknowledged` is gone
   * as a stage (`domain/stages.ts`'s header), so what was ahead from `routed` is now the same two
   * stages it was from `acknowledged` — `roomForAvailability` is written the same way and needed
   * no change, but it is now true from every status that offers anything at all, not only some of
   * them. *"Where I am"* rides beside the stage buttons everywhere this chase has something to say.
   */
  const ahead = stagesOfferedFrom(state.status);

  /**
   * ⚠️ **Three is Meta's cap and this is the guard on it, at the one point that can breach it.**
   * Never `ahead.length + 1 <= 3` written at the call site: the arithmetic belongs beside the
   * sentence that explains it. `ahead` cannot exceed two since 2026-09-04 (`STAGES` narrowed to
   * three, and `issued` is never offered), so this reads as `ahead.length > 0` in practice now —
   * left as the general guard rather than hand-simplified, so a stage added back later cannot
   * silently breach the cap by having nobody update an inequality nothing here would flag.
   */
  const roomForAvailability = ahead.length > 0 && ahead.length < 3;

  /**
   * 🔴 **A gathering is reminded, not chased** — the owner, 2026-08-24: *"Meeting k follow up
   * mai kuch button dene ki zarurt nhe hi just simple ho, a kind of reminder ho, acknowledge etc
   * karne ki zarurt nhe hai"*.
   *
   * ⚠️ **Attendance was already asked once.** The meeting notice goes on `district_notice_v2`,
   * which carries the three attendance quick replies. A chase is a reminder, and re-polling
   * forty officers who already answered is how a district teaches its officers to stop reading
   * its messages.
   *
   * ⚠️ **This removes the buttons, never the record.** The `followed_up` event below is
   * appended exactly as before, note and delivery included — INV-03 is about a failure being
   * visible where somebody acts on it, and that is untouched by what the message carries.
   */
  const remindOnly = isGathering(state.kind);

  for (const handset of handsets) {
    const open = await sessionWindowOpen(pool, handset.phone);
    const words = options.note?.trim();

    /**
     * ⚠️ **Built per handset, because the id carries that handset's OWN attempt.** A tap settles
     * the obligation the button was minted against — `mintAckToken`'s rule, applied to a button —
     * so one shared set would land every officer's answer on whichever attempt happened to be
     * first in the list.
     */
    const buttons = remindOnly
      ? []
      : [
          ...ahead.map((stage) => ({
            id: stageButtonId(stage, incidentId, handset.attemptId),
            title: stageButtonWords(stage, state.kind),
          })),
          ...(roomForAvailability
            ? [
                {
                  id: availabilityButtonId(incidentId, handset.attemptId),
                  title: WHERE_BUTTON_WORDS,
                },
              ]
            : []),
        ];

    const result: SendResult = open
      ? await sendSession(
          config,
          {
            toPhone: handset.phone,
            text: followUpText(
              state.kind,
              state.category?.value ?? null,
              what,
              words,
              buttons.length > 0,
            ),
            // Quoted under the alert it chases, on the officer's own screen.
            replyTo: handset.providerMessageId,
            ...(buttons.length === 0 ? {} : { buttons }),
          },
          fetchImpl,
        )
      : await sendOnTemplate(pool, config, handset, incidentId, state, what, words, fetchImpl);

    /**
     * Recorded against the **same attempt**, which is what lets a reply to the follow-up be
     * matched back to this emergency: `lastMessageTo` reads the most recent row for the number,
     * and a follow-up that wrote no row would leave a reply landing on whatever the district
     * happened to send that handset last — quite possibly a different emergency.
     */
    if (result.ok) {
      await recordSent(pool, {
        providerMessageId: result.providerMessageId,
        attemptId: handset.attemptId,
        incidentId,
        toPhone: handset.phone,
      });
    } else {
      log('warn', 'a follow-up could not be sent', { incidentId, failure: result.failure });
    }

    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'followed_up',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: state.eventCount + chased.length + 1,
        actorPersonId: identity.personId,
        actorSeatId: seat.seatId,
        sourceChannel: 'web',
        payload: {
          toPhone: handset.phone,
          followsProviderMessageId: handset.providerMessageId,
          followsSentAt: handset.sentAt,
          delivered: result.ok,
          note:
            (words === undefined || words === '' ? 'Followed up' : `Followed up: ${words}`) +
            ` (on the alert sent ${handset.sentAt})` +
            // Named on the incident rather than only in the log, because INV-03 is about a
            // failure being visible where somebody acts on it. The room can telephone; a log
            // line cannot.
            (result.ok ? '' : `\n(it could not be sent: ${result.failure})`),
        },
      } as unknown as IncidentEvent,
    ]);

    chased.push({
      phone: handset.phone,
      delivered: result.ok,
      failure: result.ok ? null : result.failure,
      path: open ? 'thread' : 'template',
    });
  }

  return { ok: true, chased };
}

/**
 * The shut-window path: the alert goes again, on a template Meta has already approved.
 *
 * ⚠️ **Nothing here creates or edits a Meta template**, which is the owner's standing instruction
 * since the 2026-08-12 category mistake. It rides whatever `templateFor` already chooses for an
 * acknowledgement, exactly as an ordinary dispatch does.
 */
async function sendOnTemplate(
  pool: Pool,
  config: WhatsAppConfig,
  handset: { readonly phone: string; readonly attemptId: string; readonly sentAt: string },
  incidentId: string,
  state: ReturnType<typeof foldIncident>,
  what: string,
  words: string | undefined,
  fetchImpl: typeof fetch,
): Promise<SendResult> {
  const attempt = state.notifications.find((a) => a.attemptId === handset.attemptId);

  /**
   * ⚠️ **Minted against the ORIGINAL attempt.** The follow-up chases that obligation, so a tap on
   * it must settle the row that is already pending rather than open a second one for the same
   * emergency. `seatId`/`personId` come from the attempt for the same reason `mintAckToken`'s own
   * comment gives: a handover between the first alert and this tap must not move the
   * acknowledgement onto whoever holds the post tonight (ADR-0004).
   */
  const token = await mintAckToken(pool, {
    attemptId: handset.attemptId,
    incidentId,
    seatId: attempt?.seatId ?? null,
    personId: attempt?.personId ?? null,
  });

  return sendWhatsApp(
    config,
    {
      toPhone: handset.phone,
      // Meta refuses an empty parameter, and both of these are always non-empty by construction.
      what: `Follow-up · ${what}`,
      /**
       * ⚠️ **Only the PARAMETER changes here — `district_message_v3` itself is untouched.** A
       * template is approved artwork and is never edited without asking; its parameters are free
       * text and need no approval from anybody.
       *
       * 🔴 **A reminder still arrives with a link under it on this road, and that is known.**
       * The URL button is baked into the template, so a gathering chased outside the service
       * window cannot be given the button-free message it gets inside one. Removing it means a
       * new template and a fresh Meta approval; the owner was shown both and chose to accept the
       * link for now (2026-08-24). The words at least stop pretending an answer is wanted.
       */
      where:
        words === undefined || words === ''
          ? followUpTemplateAsk(state.kind, state.category?.value ?? null)
          : words,
      ackToken: token,
      answers: 'acknowledgement',
    },
    fetchImpl,
  );
}

/**
 * The emergency in as few words as a handset needs.
 *
 * Degrades rather than apologises: an unassessed report has no severity by design (ADR-0009), and
 * printing *"unknown"* on an officer's phone is the software reporting its own gap to somebody who
 * cannot fill it. The fallback still names something real.
 */
function describe(state: IncidentState): string {
  /**
   * 🔴 **A meeting is described by its subject and its DATE, not by a category and a
   * severity** — the district's five, 2026-08-22.
   *
   * This function was written when every message was an emergency, and on a meeting it produced
   * *"the other — moderate report"*, which is not a sentence about anything. It matters now
   * because a **reschedule** is the case a follow-up exists for: the district moves a meeting
   * and presses *Follow up*, and every officer already told has to be handed **the new date**.
   *
   * ⚠️ **`state.details` is read, never the `reported` payload.** The fold replaces the date
   * there when a meeting is rescheduled; the original event still carries Monday, and a message
   * built from it would tell forty officers to come on a day the meeting is no longer on — the
   * whole failure this phase exists to prevent, arriving through the one message that goes out
   * because of it.
   */
  if (isGeneral(state.kind)) {
    const subject = state.details?.subject?.trim();
    const date = state.details?.date?.trim();
    const time = state.details?.time?.trim();
    const venue = state.details?.venue?.trim();
    const when = [date, time].filter((w): w is string => w !== undefined && w !== '').join(' at ');
    const parts = [
      subject === undefined || subject === '' ? labelFor(state.kind).toLowerCase() : subject,
      when === '' ? null : when,
      venue === undefined || venue === '' ? null : venue,
    ].filter((w): w is string => w !== null);
    return parts.join(' — ');
  }

  const words = [state.category?.value ?? null, state.severity?.value ?? null].filter(
    (w): w is string => w !== null && w.trim() !== '',
  );
  return words.length === 0 ? 'this emergency' : `the ${words.join(' — ')} report`;
}
