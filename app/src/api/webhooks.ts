/**
 * What Meta tells us back — M6-20, M6-21, M6-22, M6-23.
 *
 * Three things arrive here and only one of them meets an obligation:
 *
 *   * **Status webhooks** — `sent`, `delivered`, `read`, `failed`. They move the ledger, and
 *     `read` moves it without ever meeting the duty (ADR-0014).
 *   * **Inbound replies** — an officer answering the alert. A reply *is* a deliberate act, so
 *     it does meet the obligation, and it lands on the incident as a response action.
 *   * **The acknowledge tap** — a single-use link in the message. **This is the thing the whole
 *     channel exists for**: an attributable acknowledgement from an officer who may hold no
 *     account and may never sign in, which is most of the district's directory (M0-51).
 *
 * ## The one rule this file cannot get wrong
 *
 * **Signature first, before the body is parsed and long before anything is written.** An
 * unverified webhook is an unauthenticated write to the district's record: this endpoint's job
 * is to move attempts to `delivered`, so anybody able to forge one could mark every obligation
 * in Bajaur as met — and the board would go quiet on a night when nothing had been delivered at
 * all. INV-03 defeated from the outside, with no error anywhere.
 *
 * It is also the only endpoint in this system reachable without a session, by necessity: Meta
 * has no account here. That makes it the one place where the check is the entire perimeter.
 */

import { randomUUID } from 'node:crypto';

import { append, loadIncident } from '../db/eventStore.js';
import type { Pool } from '../db/pool.js';
import type { IncidentEvent } from '../domain/events.js';
import { foldIncident, type IncidentState } from '../domain/incident.js';
import { markObligationMet, recordWhatTheySaid } from '../jobs/notify.js';
import {
  answerQuestion,
  applyStatus,
  claimStageOffer,
  lastMessageTo,
  messageById,
  noteInbound,
  recordAccountNotice,
  pendingQuestion,
  recordQuestion,
  sessionWindowOpen,
  mintAckToken,
  peekAckToken,
  redeemAckToken,
  type AckStage,
  type AckSubject,
} from '../db/whatsappStore.js';
import {
  STAGES,
  STAGE_BUTTON,
  stageButtonWords,
  WHERE_BUTTON,
  WHERE_BUTTON_WORDS,
  availabilityButtonId,
  stageButtonId,
  stageIsStillAhead,
  stageLabel,
  stagesOfferedFrom,
  type Stage,
} from '../domain/stages.js';
import { PRESENCE_STATUSES, type PresenceStatus } from '../domain/wall.js';
import {
  CHOOSE_LINE,
  RESPONSE_THANKS,
  acknowledgementThanks,
} from '../domain/acknowledgementThanks.js';
import {
  UNABLE_BRANCH,
  listFor,
  listTitle,
  optionById,
  optionOfSaid,
  optionTyped,
  optionsOf,
  optionsWrittenOut,
  templateOptionFor,
  type ResponseOption,
} from '../domain/responseOptions.js';
import { reportPresence } from '../db/wallStore.js';
import { dutySeatOfPerson } from '../db/rosterStore.js';
import {
  downloadMedia,
  markRead,
  readWebhook,
  sendSession,
  toE164,
  verifySignature,
  type InboundLocation,
  type InboundMedia,
  type InboundReaction,
  type WhatsAppConfig,
} from '../ops/whatsapp.js';
import { defaultEvidenceRoot, store } from '../ops/evidence.js';
import {
  takeForActivities,
  type EmergencyPathFor,
  type Prefetched,
  type WhatsAppActivities,
} from './whatsappActivities.js';
import {
  ACKNOWLEDGE_REPLY,
  ATTENDING_REPLY,
  DECLINED_REPLY,
  SUBSTITUTE_REPLY,
} from '../ops/whatsappTemplate.js';
import { log } from '../obs/log.js';

export interface WebhookReply {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

const TEXT = 'text/plain; charset=utf-8';

/**
 * Meta's one-time subscription handshake.
 *
 * A GET carrying a challenge and the verify token this district chose. Echo the challenge back
 * **only** if the token matches, otherwise anybody who guesses the URL can point their own app
 * at it.
 */
export function verifyWebhookSubscription(
  config: WhatsAppConfig | null,
  params: URLSearchParams,
): WebhookReply {
  if (config === null) {
    return { status: 404, body: 'whatsapp is not configured', contentType: TEXT };
  }

  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode !== 'subscribe' || token !== config.verifyToken || challenge === null) {
    return { status: 403, body: 'no', contentType: TEXT };
  }

  return { status: 200, body: challenge, contentType: TEXT };
}

/**
 * A status or a reply from Meta.
 *
 * **Always answers 200 once the signature checks out**, even when an entry inside referred to a
 * message this district never sent. Meta retries any non-2xx for hours, and a retry storm
 * caused by one unrecognised id would arrive on the machine that is also taking emergency
 * reports. What could not be understood is logged and skipped; the rest of the batch still
 * applies — the same rule `api/protocol.ts` follows for a sync batch, and for the same reason.
 */
export async function handleWhatsAppWebhook(
  pool: Pool,
  config: WhatsAppConfig | null,
  rawBody: Buffer,
  signature: string | undefined,
  /**
   * How the follow-up question reaches Meta — Phase B.
   *
   * This route **answers back** now, which no webhook in this system did before: a tap on
   * *"Sending someone"* is replied to inside the officer's own thread. So it needs a way out,
   * and tests need it stubbed — the same seam `whatsappChannel` has taken since M6-18, for the
   * same reason. Defaulted, so nothing in production passes it.
   */
  fetchImpl: typeof fetch = fetch,
  /**
   * Where an inbound file is written — 2026-08-21.
   *
   * Passed rather than computed, for the reason `defaultEvidenceRoot` itself exists: the upload
   * path, the download path and the WhatsApp channel already had to agree about this directory,
   * and the symptom of two copies disagreeing is *"the picture did not come"* on a system where
   * every row is right. This is the fourth place that needs the same answer, and it takes it
   * from the same place the other three do.
   */
  evidenceRoot: string = defaultEvidenceRoot(),
  /**
   * WhatsApp → Activities (ADR-0040). Absent: switched off, and every photo and video takes
   * today's path exactly as before. Present: a photo or video is decided on first — see
   * `api/whatsappActivities.ts` — and only the emergency branch reaches `recordReply`.
   */
  activities?: WhatsAppActivities,
): Promise<WebhookReply> {
  if (config === null) {
    return { status: 404, body: 'whatsapp is not configured', contentType: TEXT };
  }

  // Before anything else. See the header.
  if (!verifySignature(config.appSecret, rawBody, signature)) {
    log('warn', 'whatsapp webhook rejected: signature did not verify');
    return { status: 401, body: 'signature did not verify', contentType: TEXT };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Verified as Meta's and still unreadable. A 400 rather than a retry-inducing 500: there is
    // nothing in it for them to send again.
    return { status: 400, body: 'not json', contentType: TEXT };
  }

  const { statuses, replies, notices } = readWebhook(parsed);

  /**
   * **What Meta says about the district's own account — read FIRST, and until 2026-08-21 not read
   * at all.**
   *
   * First because it is the cheapest and because it is the one thing here that can explain why
   * everything below it is failing: a paused template refuses every send on it, and a district
   * reading *"3 of 40 delivered"* has no way to know that is the reason.
   *
   * ⚠️ **Logged at the severity Meta itself reported.** A paused template is an `error` line in
   * the journal, not an `info` one — this is the same class of fact as the backup failing, and
   * the operator's habit of scanning for red is the only thing that finds it before a screen
   * does. It is written to the wall as well (`districtCondition`), because a journal is opened on
   * purpose and a wall is read by accident.
   */
  for (const notice of notices) {
    await recordAccountNotice(pool, notice);
    log(
      notice.severity === 'critical' ? 'error' : notice.severity === 'warn' ? 'warn' : 'info',
      'meta says something about this account',
      {
        kind: notice.kind,
        subject: notice.subject,
        event: notice.event,
        ...(notice.detail === null ? {} : { detail: notice.detail }),
      },
    );
  }

  for (const update of statuses) {
    const applied = await applyStatus(
      pool,
      update.providerMessageId,
      update.status,
      update.failure,
    );

    if (applied === null) {
      // A message this district did not send — a shared test account, or a webhook retried
      // across a database restore. Logged so it is visible, skipped so it is harmless.
      log('info', 'whatsapp status for an unknown message', {
        providerMessageId: update.providerMessageId,
      });
      continue;
    }

    // A retried webhook, or a status that would walk the message backwards. Meta retries as a
    // matter of routine, so this is the ordinary path and not an edge case.
    if (!applied.changed) continue;

    /**
     * `delivered` and `read` are **not** the same thing, and only one of them touches the
     * ledger — neither of them by meeting the obligation.
     *
     * `delivered` means the handset received it, which is what the notification ledger's
     * `delivered` has always meant for the in-app channel too: it arrived where somebody could
     * see it. `read` means blue ticks, and ADR-0014 is explicit that it never counts — an
     * officer who has disabled read receipts never produces one, so a board built on them
     * manufactures invisible failures at exactly the rate officers value their privacy. It is
     * recorded on the message row and appended to no event.
     */
    if (update.status === 'delivered') {
      await settleAttempt(pool, applied.message.incidentId, applied.message.attemptId, 'delivered');
    }

    if (update.status === 'failed') {
      await settleAttempt(
        pool,
        applied.message.incidentId,
        applied.message.attemptId,
        'failed',
        update.failure ?? 'whatsapp reported a failure with no reason',
      );
    }
  }

  for (const reply of replies) {
    /**
     * **Recorded before anything is decided about what this message means.**
     *
     * A service window opens on Meta's side for *any* inbound — a tap, a typed word, a message
     * from somebody who was never alerted at all and whose reply `recordReply` will drop. All of
     * those open it, so all of them are noted here rather than further down where the ones that
     * matched an incident are.
     *
     * Noting only the inbounds this system understood would leave the district believing the
     * window shut while Meta considered it open, and the officer would get a link instead of the
     * follow-up they were promised — which is the exact failure this whole path exists to end.
     */
    await noteInbound(pool, reply.fromPhone, reply.at);

    /**
     * **Two blue ticks on the officer's own message** — Phase 7.
     *
     * Before anything is decided about what the message *means*, because the answer to *"has
     * anybody looked at this?"* is **yes** the moment it is in our hands — whether or not it
     * matches an incident, and whether or not `recordReply` goes on to drop it. An officer who
     * messaged this number and got one grey tick reads it as nobody having looked, which is the
     * opposite of what happened, on the one channel this district relies on to be answered.
     *
     * ⚠️ **Awaited, and every outcome swallowed.** A throw here is a 500, and Meta retries a 500
     * for hours onto the machine also taking emergency reports — so a tick that did not appear
     * must never cost the district its webhook. Logged at `info` rather than `warn` because a
     * refusal is **ordinary**: Meta will not mark a message read once it is a few days old, and a
     * webhook retried across a deploy window can easily be that old.
     *
     * ⚠️ **It sends no message and settles nothing.** See `markRead` — this is the district
     * telling an officer *we read yours*, which is the opposite direction from ADR-0014's rule
     * about read receipts, and it touches no ledger and no clock.
     */
    if (reply.messageId !== null) {
      const receipt = await markRead(config, reply.messageId, fetchImpl);
      if (!receipt.ok) {
        log('info', 'could not mark an inbound message read', { failure: receipt.failure });
      }
    }

    /**
     * **Activities first, for a photo or a video, and for a tap on its two buttons** — ADR-0040.
     *
     * A sender with an open emergency is asked which it is, and *Emergency report* hands the media
     * back to `recordReply` below, unchanged, with the bytes already fetched. Everything else —
     * words, a voice note, a document, a pin, every other tap — returns `false` here and goes on
     * exactly as before.
     */
    if (activities !== undefined) {
      const taken = await takeForActivities(
        {
          pool,
          config,
          fetchImpl,
          activities,
          emergency: (held) =>
            recordReply({
              pool,
              config,
              evidenceRoot,
              fromPhone: reply.fromPhone,
              text: held.text,
              at: held.at,
              tapped: false,
              fetchImpl,
              media: held.media,
              prefetched: held.prefetched,
              chosen: held.why,
              ...(held.replyContextId === undefined ? {} : { replyContextId: held.replyContextId }),
            }),
        },
        {
          fromPhone: reply.fromPhone,
          messageId: reply.messageId,
          text: reply.text,
          at: reply.at,
          tapped: reply.tapped,
          ...(reply.media === undefined ? {} : { media: reply.media }),
          ...(reply.location === undefined ? {} : { location: reply.location }),
          ...(reply.reaction === undefined ? {} : { reaction: reply.reaction }),
          ...(reply.replyId === undefined ? {} : { replyId: reply.replyId }),
          ...(reply.contextMessageId === undefined
            ? {}
            : { replyContextId: reply.contextMessageId }),
        },
      );
      if (taken) continue;
    }

    await recordReply({
      pool,
      config,
      evidenceRoot,
      fromPhone: reply.fromPhone,
      text: reply.text,
      at: reply.at,
      tapped: reply.tapped,
      fetchImpl,
      ...(reply.replyId === undefined ? {} : { replyId: reply.replyId }),
      ...(reply.media === undefined ? {} : { media: reply.media }),
      ...(reply.location === undefined ? {} : { location: reply.location }),
      ...(reply.reaction === undefined ? {} : { reaction: reply.reaction }),
      ...(reply.contextMessageId === undefined ? {} : { replyContextId: reply.contextMessageId }),
    });
  }

  return { status: 200, body: 'ok', contentType: TEXT };
}

/**
 * Today's evidence path for a held picture, for the minute sweep — ADR-0041 §3.
 *
 * An officer asked *emergency report or daily activity?* who does not answer within the hour has
 * their picture treated exactly as *Emergency report*: `recordReply`, unchanged, with the bytes
 * already fetched. Built here because `recordReply` is this file's and stays private to it.
 */
export function emergencyPathFor(
  pool: Pool,
  config: WhatsAppConfig,
  evidenceRoot: string = defaultEvidenceRoot(),
  fetchImpl: typeof fetch = fetch,
): EmergencyPathFor {
  return (fromPhone) => (held) =>
    recordReply({
      pool,
      config,
      evidenceRoot,
      fromPhone,
      text: held.text,
      at: held.at,
      tapped: false,
      fetchImpl,
      media: held.media,
      prefetched: held.prefetched,
      chosen: held.why,
      ...(held.replyContextId === undefined ? {} : { replyContextId: held.replyContextId }),
    });
}

/** Append the outcome of one WhatsApp attempt, if the log does not already carry one. */
async function settleAttempt(
  pool: Pool,
  incidentId: string,
  attemptId: string,
  outcome: 'delivered' | 'failed',
  failure?: string,
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;

  const state = foldIncident(incidentId, events);
  const attempt = state.notifications.find((a) => a.attemptId === attemptId);

  // Already settled. `applyStatus` guards the common retry, and this guards the rest: a
  // delivery that arrived while the acknowledge tap was already being processed.
  if (attempt === undefined || attempt.state !== 'pending') return;

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      clientSeq: state.eventCount + 1,
      // Nobody did this; a provider reported it. Rendered as "the system", which is a real and
      // important distinction from a blank (see `readIncident`).
      actorPersonId: null,
      actorSeatId: null,
      sourceChannel: 'system',
      type: outcome === 'delivered' ? 'notification_delivered' : 'notification_failed',
      payload: {
        attemptId,
        seatId: attempt.seatId,
        ...(attempt.personId === undefined ? {} : { personId: attempt.personId }),
        channel: 'whatsapp',
        // **`provider`, and deliberately not one of the acknowledgement routes.** Meta saying
        // a handset received it is the machine observing a handset — nobody decided anything,
        // and ADR-0014 is built on that gap. It is recorded because "the message arrived and
        // then nothing happened" is a real and useful shape; it is named apart so no report
        // can add it to the confirmations (M7-30).
        ...(outcome === 'delivered' ? { via: 'provider' } : {}),
        ...(outcome === 'failed' ? { failure: failure ?? 'whatsapp failed' } : {}),
      },
    } as unknown as IncidentEvent,
  ]);
}

/**
 * An officer replied — M6-23.
 *
 * Matched to the incident by **that officer's most recent open attempt**, and the screen says
 * the match is inferred, because it is. An officer told about two emergencies ten minutes apart
 * who replies "on my way" is answering one of them and nothing in the message says which.
 * Guessing the most recent is the best available answer and a guess all the same; presenting it
 * as certainty would put a fact in the record that nobody established.
 *
 * A reply **does** meet the obligation. It is a deliberate act by the person who was owed the
 * message, which is exactly what ADR-0014 names as the thing that counts — unlike a read
 * receipt, which happens without anybody choosing anything.
 */
/**
 * One reply, and everything needed to record it.
 *
 * **An object rather than nine positional parameters, since 2026-08-21.** It was eight, and the
 * file it lives in is about matching an answer to the obligation it settles — a call site where
 * `tapped` and a media object are told apart by counting commas is one that eventually passes the
 * wrong thing silently. There is exactly one caller and it names every field.
 */
interface ReplyToRecord {
  readonly pool: Pool;
  /** Needed to answer back. See `askWhoIsComing`. */
  readonly config: WhatsAppConfig;
  /** Where an inbound file is written. See `handleWhatsAppWebhook`. */
  readonly evidenceRoot: string;
  readonly fromPhone: string;
  /** Empty when the officer sent only a file. See `InboundReply.text`. */
  readonly text: string;
  readonly at: string;
  /**
   * The officer tapped a quick reply rather than typing — 2026-08-19.
   *
   * **It changes the words on the incident and nothing else.** *"Replied on WhatsApp: Attending"*
   * would be a small untruth about the one record the district reads afterwards: nobody wrote
   * that word, they chose it from three the district itself put in front of them. The obligation,
   * the route and the acknowledgement are identical because the evidence is — see `InboundReply`.
   */
  readonly tapped?: boolean;
  readonly fetchImpl?: typeof fetch;
  /** Set only on a tap of a button **this system** built. See `InboundReply.replyId`. */
  readonly replyId?: string;
  /** The file the officer sent, when they sent one — 2026-08-21. */
  readonly media?: InboundMedia;
  /** The pin they dropped, when they answered by tapping rather than typing — Phase 6. */
  readonly location?: InboundLocation;
  /** The emoji they put on one of our messages — Phase 6. */
  readonly reaction?: InboundReaction;
  /**
   * The message the officer used WhatsApp's reply control on — 2026-08-21.
   *
   * The exact answer to a question this file has been inferring since M6-23. See
   * `InboundReply.contextMessageId`, and `messageById`.
   */
  readonly replyContextId?: string;
  /**
   * The file's bytes, already fetched — ADR-0040. Set only when the media was held while the
   * officer was asked *emergency report or daily activity?*, so it is not fetched from Meta twice
   * (and Meta's link may have expired in the meantime).
   */
  readonly prefetched?: Prefetched;
  /**
   * Why a held picture is coming down this path (ADR-0040 / ADR-0041), so the note says what
   * happened rather than claiming they used WhatsApp's reply control:
   *
   *   * `tapped` — the officer **chose** this incident with *Emergency report*: the match is exact;
   *   * `unanswered` — they were asked and did not answer within the hour;
   *   * `unasked` — the question could not be sent.
   */
  readonly chosen?: 'tapped' | 'unanswered' | 'unasked';
}

async function recordReply(reply: ReplyToRecord): Promise<void> {
  const { pool, config, evidenceRoot, fromPhone, text, at, media, location, reaction } = reply;
  const tapped = reply.tapped ?? false;
  const fetchImpl = reply.fetchImpl ?? fetch;
  const replyId = reply.replyId;
  const replyContextId = reply.replyContextId;

  const phone = toE164(fromPhone);

  /**
   * **A tap on one of our own buttons — Phase C, and it is checked first.**
   *
   * This is the one inbound in the whole file whose subject is carried on the message itself
   * rather than inferred from the number it came from. It must not fall through to
   * `lastMessageTo`: an officer told about two emergencies ten minutes apart, tapping *Resolved*
   * on the first, would otherwise close the second — the one nobody has been to yet.
   */
  if (replyId !== undefined && OURS.some((prefix) => replyId.startsWith(`${prefix}:`))) {
    await handleOurChoice(pool, config, phone, replyId, fetchImpl);
    return;
  }

  /**
   * **Is this the answer to something the district asked?** — Phase B.
   *
   * Checked **before** the ordinary reply path, because otherwise the name of a deputy would be
   * recorded as an acknowledgement of whatever was last sent to that number — *"Replied on
   * WhatsApp: Officer Lima"* against a meeting, and no answer at all to the question actually put.
   *
   * ⚠️ **A tap is never an answer to this, and that guard is the whole care in it.** The question
   * asks for a person's name, typed. An officer who taps *Attending* on a **different** meeting
   * while this one is outstanding is answering that meeting, not naming a substitute — and
   * `InboundReply.tapped` is what tells the two apart, which is exactly what it was added for.
   */
  /**
   * ⚠️ **A message with no words is never the answer to a question, and that guard is new** —
   * 2026-08-21, with inbound files.
   *
   * Both questions this district asks want **words**: a substitute's name, or what happened. An
   * officer who photographs the scene while a resolution question is outstanding has answered
   * neither — and recording an empty outcome would close an emergency with a blank sentence,
   * which is the one thing `recordResolution` has refused since the day it was written.
   *
   * Falling through leaves the question **standing**, so the officer can still type, and the
   * photograph lands on the incident by the ordinary path below.
   */
  /**
   * ⚠️ **A pin and an emoji are not words, so neither answers a standing question** — Phase 6,
   * and it is the rule a photograph already follows one line above.
   *
   * Both questions this district asks want **words** — a substitute's name, or what happened — and
   * `text` is empty on both of these, so the guard below already excludes them. It is said out
   * loud because the tempting reading is the other one: an officer who drops a pin while
   * *"who is coming in your place?"* is outstanding has answered a different question, and
   * recording a coordinate as a person's name would put a place in the record where a human
   * belongs.
   */
  if (!tapped && text.trim() !== '') {
    const question = await pendingQuestion(pool, phone);
    if (question !== null) {
      if (question.asks === 'resolution') {
        await recordResolution(pool, config, phone, question, text, fetchImpl);
      } else if (
        question.asks === 'clarification' ||
        question.asks === 'reason' ||
        question.asks === 'absence'
      ) {
        await recordInTheirWords(pool, config, phone, question, text, at, fetchImpl);
      } else {
        await recordSubstitute(pool, question, text, at);
        /**
         * **Both kinds close with the district's own sentence** — the owner's decision of
         * 2026-08-25, and it closes a silence rather than only changing a wording.
         *
         * 🔴 **A meeting's *Sending someone* used to answer with NOTHING AT ALL.** The officer
         * tapped, was asked who was coming, typed a name — and the district said nothing back.
         * On a handset that is indistinguishable from a message that failed to send, and the one
         * thing every confirmation in this file exists to prevent is an officer wondering whether
         * their answer arrived.
         *
         * ⚠️ **The argument for the old split is kept here rather than deleted**, because it is
         * the reason to revisit this line if the district ever objects: answering a **meeting**
         * with *"in case of any emergency, contact the control room"* is the class of mismatch
         * `thanksKindFor` exists to prevent. The owner was asked and chose one sentence for every
         * path — *"pdf wala msg hi closing msg ho"* — and their document's *Final Automated
         * Message* page names no category, while its §9 is a category like any other.
         *
         * ⚠️ **`substitute` and `representative` stay two kinds**, because they still write two
         * different notes onto two different sorts of record. Only the ending is now shared.
         */
        await closeTheWorkflow(pool, config, phone, question.incidentId, fetchImpl);
      }
      return;
    }
  }

  /**
   * **Which of our messages this answers, and the stronger claim is tried first** — 2026-08-21.
   *
   * Since M6-23 this has been one question with one answer: *the most recent alert to that
   * number*, stated as an inference wherever it appears because it is one. WhatsApp's own reply
   * control has been answering it exactly on every webhook since the first, in `context.id`, and
   * nothing read the field.
   *
   * ⚠️ **The number is still checked, and that check is not ceremony.** A reply arriving from one
   * handset whose context names a message sent to a **different** one is a claim this system has
   * no reason to accept: the id is chosen by the sender, the endpoint is public, and a webhook is
   * verified as *Meta's* rather than as *this officer's*. Refusing it falls back to the guess,
   * which is where this district has been all along — never worse.
   *
   * Absent context is the ordinary case and stays the ordinary path: typing into the thread is
   * easier than long-pressing a message to reply to it.
   */
  const named = replyContextId === undefined ? null : await messageById(pool, replyContextId);

  if (named !== null && named.toPhone !== phone) {
    log('warn', 'whatsapp reply named a message sent to a different number', {
      incidentId: named.incidentId,
    });
  }

  const exact = named !== null && named.toPhone === phone;
  const message = exact ? named : await lastMessageTo(pool, phone);

  if (message === null) {
    // Somebody messaged the district's number without having been alerted. Not an error and
    // not something to guess about — there is no incident to attach it to, and inventing one
    // would be worse than losing a message that was never part of a conversation.
    log('info', 'whatsapp reply with no recent message to match it to');
    return;
  }

  const events = await loadIncident(pool, message.incidentId);
  if (events.length === 0) return;
  const state = foldIncident(message.incidentId, events);

  const attempt = state.notifications.find((a) => a.attemptId === message.attemptId);

  /**
   * 🔴 **An officer who types `2` has answered, and until 2026-08-26 this district lost it.**
   *
   * The options are now written into the message (`optionsWrittenOut`), so they can be read
   * without opening anything — and an officer who can read a numbered list will type the number.
   * Before this, that reply went onto the record as the character `2` and matched no option, so
   * `optionOfSaid` returned null on every screen, in every count and in the export.
   *
   * ⚠️ **The loss was quiet rather than loud, which is what made it worth fixing.** `action_logged`
   * nudges an acknowledged incident to `responding` for any typed reply, so the board did **not**
   * sit there looking unanswered — it looked answered, while the record of *what was answered* read
   * `2`. Three things went missing behind that:
   *
   *   * **an option that closes an emergency did not close it.** *Matter Already Being Handled*
   *     records `resolved`; typed, it reached `responding` and the incident stayed open.
   *   * **an option that asks a question asked nothing.** *Unable to Respond* is the district's own
   *     §9 — typed, the branch asking **why** never went, which is the whole of what a control room
   *     does with a decline.
   *   * **the district's closing sentence never arrived**, so the officer was left unsure their
   *     answer had landed — the one thing every confirmation in this file exists to prevent.
   *
   * The tap did all three. The obvious thing an officer would do instead did none of them.
   *
   * Resolved against **the list this incident would have been offered**, which is derived rather
   * than stored — see `offeredFor`.
   *
   * ## What is deliberately NOT read this way
   *
   * ⚠️ **A tap, a photograph, a pin, or a reaction.** A tap carries a row id and needs no
   * guessing; the rest are not answers to “which of these?” at all, and a caption reading `2`
   * beneath a photograph of a wreck is a caption.
   *
   * ⚠️ **An attempt whose answer is already one of the district’s options.** After an officer
   * chooses *Unable to Respond* they are offered the three-row branch, and from that moment a
   * bare `2` is ambiguous between two lists that were both on their screen. Their first answer
   * stands and a second number stays their own words; the branch’s own options ask their
   * questions through `whatsapp_question`, which is answered further up this function.
   */
  /**
   * 🔴 **A tap on a `dnc_response_<category>` template IS the officer's response — ADR-0034.**
   *
   * These templates carry three category-specific quick replies and **no *Acknowledge* button**,
   * so unlike `district_emergency_v2` the first tap is not "I have this" — it is *what* the officer
   * is doing. The label carries no id (it is a template quick reply, not a `resp:` row), so it is
   * matched against the template's own three, **scoped to this incident's category** so a label
   * shared across templates (`Coordinating w/ Dept` is on five of them) cannot land on the wrong
   * one.
   *
   * When it matches, the tap flows through the same `chosen !== null` machinery a typed option
   * does — `recordWhatTheySaid`, `appendAcknowledgement` (the first tap still stops the clock),
   * `applyResponseStage`, `askWhatFollows` (which sends the district's closing sentence, since
   * every template option `asks: 'nothing'`). A tap on the ordinary emergency / notice templates,
   * or a typed sentence, returns `null` here and takes the paths below unchanged.
   */
  const templateChoice =
    tapped && media === undefined && location === undefined && reaction === undefined
      ? templateOptionFor(state.kind, state.category?.value ?? null, text)
      : null;

  const chosen =
    templateChoice !== null
      ? templateChoice
      : tapped || media !== undefined || location !== undefined || reaction !== undefined
        ? null
        : optionOfSaid(attempt?.said) !== null
          ? null
          : optionTyped(text, offeredFor(state));

  /**
   * **The file is fetched and stored BEFORE the event is appended, and it must never decide
   * whether that event happens** — 2026-08-21.
   *
   * Two rules meet here and they pull opposite ways, so the order settles it.
   *
   * INV-03's own order of operations says the record comes first: a download reaches across the
   * network to Meta, on the machine that is also taking emergency reports, and an officer's
   * answer must not be lost because a provider was slow. So `keepEvidence` **returns a reason and
   * never throws**, exactly as the transport does, and every path below appends.
   *
   * The evidence id is what has to arrive first, because `action_logged` carries `evidenceIds` on
   * the event itself and the log is append-only — a file stored afterwards would be a second event
   * pointing back at the first, and *"the photograph that came with this reply"* would stop being
   * one fact. A failed download is written **in words on the same note**, which is the whole of
   * INV-03 applied to a file: the district finds out that something was sent and could not be
   * fetched, rather than never learning a photograph existed.
   */
  const kept =
    media === undefined
      ? null
      : await keepEvidence(
          pool,
          evidenceRoot,
          config,
          media,
          message.incidentId,
          attempt,
          fetchImpl,
          reply.prefetched,
        );

  /**
   * What the record says the officer did.
   *
   * `text` is their own words wherever there are any — typed, or the caption on the photograph,
   * which is the same act and is why `readWebhook` folds a caption into `text` rather than
   * carrying it separately. With no words at all the district's record says what **kind** of
   * thing arrived, because *"Replied on WhatsApp: "* with nothing after it reads as the software
   * having lost something.
   */
  /**
   * **Where they said they are, in the district's own words** — Phase 6.
   *
   * The name and the address are the handset's, when the sender chose a place rather than dropping
   * a raw pin, and they are worth far more to a control room than six decimal places — so they
   * lead, and the coordinates follow in brackets for whoever has to type them into a map.
   *
   * ⚠️ **Six decimal places, fixed, and never the raw float.** `String(34.71670000000001)` is what
   * arrives when a handset's own arithmetic has rounded, and a coordinate printed to fourteen
   * places on an emergency reads as machine noise rather than as a place somebody can be sent.
   */
  const placeWords =
    location === undefined
      ? null
      : [
          location.name,
          location.address,
          `(${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)})`,
        ]
          .filter((part): part is string => part !== null && part !== '')
          .join(' — ');

  /**
   * What goes on the record as the officer's own answer.
   *
   * ⚠️ **A reaction's emoji is NOT put in `said`.** `said` is what the officer *told* the district,
   * and it feeds the acknowledgement's own record; an emoji is a gesture rather than a sentence,
   * and a report reading *"they said: ✅"* claims words nobody typed. The gesture is named in the
   * note, verbatim, where a human reads it.
   */
  const said =
    /**
     * ⚠️ **The district’s sentence when the officer named one of their options, never the
     * characters they typed.** `said` is what `optionOfSaid` reads an option back out of on
     * every screen and in every count, so a `2` here would be an answer nothing could
     * interpret. The characters themselves are kept on the `action_logged` note below, in full,
     * where a human reads them.
     */
    chosen !== null
      ? chosen.wording
      : text.trim() !== ''
        ? text
        : placeWords !== null
          ? placeWords
          : media === undefined
            ? ''
            : `sent ${MEDIA_WORDS[media.kind]}`;

  const what = tapped
    ? `Tapped "${text}" on WhatsApp`
    : text.trim() !== ''
      ? /**
         * ⚠️ **Their characters, and then how those characters were read** — never one in
         * place of the other. `said` above carries the district’s sentence so the record can be
         * counted; this line is what a human reads, and an officer who typed `2` must be shown
         * to have typed `2`. The inference is stated in the same breath, on the rule the
         * matched-from-the-most-recent-alert line below already follows.
         */
        `Replied on WhatsApp: ${text}` +
        (chosen === null || chosen.wording.toLowerCase() === text.trim().toLowerCase()
          ? ''
          : `\n(read as the district’s option “${chosen.wording}”)`)
      : reaction !== undefined
        ? // Their gesture, their characters, on our message. Worded as what it is rather than as a
          // reply, because nobody wrote anything — the same distinction `tapped` draws.
          `Reacted ${reaction.emoji} to this on WhatsApp`
        : placeWords !== null
          ? `Shared their location on WhatsApp: ${placeWords}`
          : `Sent ${MEDIA_WORDS[media?.kind ?? 'document']} on WhatsApp`;

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: message.incidentId,
      occurredAt: at,
      recordedAt: new Date().toISOString(),
      clientSeq: state.eventCount + 1,
      // Attributed to the officer the message was sent to, which is an inference from the
      // number and is said to be one in the note itself. A handset is not a person.
      actorPersonId: attempt?.personId ?? null,
      actorSeatId: attempt?.seatId ?? null,
      sourceChannel: 'sms',
      type: 'action_logged',
      payload: {
        note:
          what +
          (kept === null || kept.ok
            ? ''
            : // Named on the incident rather than only in the log, because INV-03 is about a
              // failure being visible **where somebody acts on it**. The district can ask the
              // officer to send it again; a log line cannot.
              `\n(they sent ${MEDIA_WORDS[media?.kind ?? 'document']} and it could not be fetched: ${kept.why})`) +
          /**
           * **Two different claims, and they are never worded the same** — M7-30's rule, applied
           * to the one line a district actually reads afterwards.
           *
           * The officer replying **to this message** is a fact WhatsApp reported; the most recent
           * alert to that number is our own guess. A note that said *"matched from the most
           * recent alert"* over an exact match would understate what the record knows, and the
           * reverse would be worse — so the sentence follows which of the two actually happened.
           */
          (reply.chosen === 'tapped'
            ? '\n(they chose this incident on WhatsApp when asked about their picture — the match is exact)'
            : reply.chosen === 'unanswered'
              ? '\n(they were asked whether this was a report for this incident and did not answer within the hour, so it is attached here — matched from the alert sent to that number)'
              : reply.chosen === 'unasked'
                ? '\n(the question about this picture could not be sent, so it is attached here — matched from the alert sent to that number)'
                : exact
                  ? '\n(they replied to this incident’s own message — the match is exact)'
                  : '\n(matched to this incident from the most recent alert sent to that number — the match is inferred)'),
        ...(kept !== null && kept.ok ? { evidenceIds: [kept.evidenceId] } : {}),
        /**
         * 🔴 **This note IS the officer's acknowledgement when it IS their response — 2026-09-04.**
         *
         * `chosen.records === 'responded'` means the note above already says exactly what the
         * officer did (`Tapped "Fire Team Dispatched" on WhatsApp`, or `Replied on WhatsApp: 2
         * (read as the district's option "…")`) — a **second** event a moment later saying the
         * same thing again, plus a *third* `acknowledged` event beside both, is what read as a
         * duplicate on the record panel. `domain/incident.ts`'s fold only treats an `action_logged`
         * event as an acknowledgement when this flag is set — never on the ordinary "what they
         * typed" note a free-text or declined reply produces — so this one note both records the
         * response and stops the clock, and nothing else has to.
         *
         * ⚠️ **Never set for `chosen === null` or `chosen.records !== 'responded'`.** A decline, a
         * free-text reply that matched nothing, and a resolved outcome (which gets its own
         * unambiguous `resolved` event below) must not be read as this district's four templates
         * reading — only a matched, non-resolving response is.
         */
        ...(chosen !== null && chosen.records === 'responded' ? { acknowledges: true } : {}),
      },
    } as unknown as IncidentEvent,
  ]);

  /**
   * ⚠️ **One writer of what they said, whichever road this reply came down.**
   *
   * `recordWhatTheySaid` **is** `markObligationMet` while the attempt still has `pending`
   * siblings — settling them too — and a second `notification_delivered` carrying the same
   * `via` and `said` once it is already settled. Both states are ordinary here, and the settled
   * one is not an edge case: a notice chased twice before the officer taps is `delivered` by
   * the time the tap lands, and `markObligationMet` **alone writes nothing** for a settled
   * attempt.
   *
   * 🔴 **The `chosen === null` branch called `markObligationMet` directly until 2026-09-10.** So
   * a tap on *Attending* / *Sending someone* / *Not attending* — none of which `optionTyped`
   * matches, because a meeting carries no options list — set neither `via` nor `said` on an
   * already-delivered obligation. The tap reached *Latest update* through the `action_logged`
   * note above and nowhere else: *The response we received* read “No reply received yet”, the
   * attendance tally counted the officer silent, and *Who was told* offered the operator a
   * “They confirmed / No answer” recorder for a recipient who had already answered.
   */
  await recordWhatTheySaid(pool, message.incidentId, message.attemptId, {
    // `reply`, not `link`. Both are the officer's own deliberate act, but this one is matched
    // back to an obligation **by the number it came from**, and that match is an inference. A
    // report that merges the two overstates how certain the weaker half is (M7-30).
    //
    // ⚠️ **A file with no caption settles the obligation exactly as words do, and a failed
    // download does not change that.** The officer answered; whether this district managed to
    // fetch what they sent is our problem and not theirs, and marking them unreached over it
    // would be the invisible failure INV-03 exists to prevent, manufactured by us.
    via: 'reply',
    said: chosen !== null ? chosen.wording : said,
  });

  /**
   * **And it acknowledges the incident, which until now it did not — the owner's instruction,
   * 2026-08-17:** *"jaise hi acknowledge officer dabaye ya reply kare, whatever bhi kare, fauran
   * dashboard par aana chahiye."*
   *
   * ADR-0014 already said the right thing and only half of it was built. What meets an obligation
   * is a **deliberate act** — the tap, the in-app acknowledgement, **or a reply** — as against a
   * read receipt, which happens without anybody choosing anything. A reply was settling the
   * ledger and stopping there, so an officer who typed *"on my way"* left the emergency sitting
   * on the board as unacknowledged, escalating over their head for the rest of the district day.
   *
   * ⚠️ **The inference is carried, not hidden, and this is the cost the owner accepted.** Which
   * incident a reply answers is matched from the most recent alert to that number — an officer
   * told about two emergencies ten minutes apart who replies once is answering one of them and
   * nothing in the message says which. That guess now stops an SLA clock. It is visible in three
   * places rather than buried: the `action_logged` note above says in words that the match is
   * inferred, `route: 'reply'` is on the acknowledgement itself, and the fold's `acknowledgedVia`
   * is rendered in different words per route precisely so *"Rescue confirmed"* and *"matched from
   * a reply"* are never read as the same claim. **Never merge the routes in a report** (M7-30).
   *
   * The officer's own words ride along as `said`, so the board shows what they actually replied
   * rather than only that they did.
   *
   * The seat is resolved **now**, unlike the tap's: there is no token here to have frozen one, and
   * the reply arrived from that handset at this moment. An officer holding no post still settles
   * the ledger and still does not stop the clock, which is `appendAcknowledgement`'s own rule.
   *
   * 🔴 **AND IT IS SKIPPED WHEN THE NOTE ABOVE ALREADY RECORDS THE RESPONSE — 2026-09-04.**
   *
   * `respondsWithoutAction` is true exactly when the `action_logged` event just appended above
   * carries `acknowledges: true` — a matched option (`optionTyped`, or a tapped
   * `dnc_response_<category>` button via `templateOptionFor`) whose `records` is `'responded'`.
   * Every one of the new per-category templates' three buttons is exactly that kind of option
   * (ADR-0034 — none of them offers a bare "I saw this"). Writing a **second**, near-identical
   * `action_logged` event a few lines below (`applyResponseStage`) plus **this** `acknowledged`
   * event, both at the same instant as the note already written, put three rows with the same
   * timestamp on the record for one tap — which read as a duplicate rather than as one fact.
   *
   * There is only one fact: the officer responded, and the note above already says so in their own
   * words. `domain/incident.ts`'s fold reads that flag and stops the SLA clock from it directly —
   * so the clock still stops on this same tap, with nothing else appended to say so.
   *
   * `resolvesDirectly` is the other matched case, and it is NOT folded into the same skip: a
   * resolution genuinely needs its own `resolved` event below — it is what moves the status and
   * carries the outcome, and nothing else can. That event already acknowledges unconditionally
   * (`domain/incident.ts`'s fold, the `resolved` case), so the explicit acknowledgement is skipped
   * for it too, but for a different reason — not redundant wording, a genuinely different event.
   *
   * A reply that matches **neither** — free text that matched nothing, or an option that records
   * nothing further, such as a decline — still acknowledges here, exactly as before: that officer
   * engaged and said something, and nothing else is going to record that they did.
   */
  const seatId =
    attempt?.seatId ??
    (attempt?.personId === undefined ? null : await dutySeatOfPerson(pool, attempt.personId));

  const respondsWithoutAction = chosen !== null && chosen.records === 'responded';
  const resolvesDirectly = chosen !== null && chosen.records === 'resolved';

  if (!respondsWithoutAction && !resolvesDirectly) {
    await appendAcknowledgement(pool, {
      incidentId: message.incidentId,
      seatId,
      personId: attempt?.personId ?? null,
      route: 'reply',
      said,
      sourceChannel: 'sms',
    });
  }

  /**
   * **And a typed option is a response, not only an acknowledgement** — 2026-08-26.
   *
   * `applyResponseStage` and `askWhatFollows`, exactly as a tapped row reaches them through
   * `chooseResponse`: the same stage, the same follow-up question, the same closing sentence.
   * Typing `2` and opening the sheet to tap the second row are the same answer, and the officer
   * who did the quicker of the two should not end up with the poorer record.
   *
   * ⚠️ **`applyResponseStage` is called ONLY for `resolvesDirectly` — 2026-09-04.** The `responded`
   * case already has its `action_logged` event, written above with `acknowledges: true`; calling
   * `applyResponseStage` for it too would write a second, near-duplicate `action_logged` event
   * whose only job would be to move the status to `responding` — which the event above has already
   * done (the fold moves it on any `action_logged`, unconditionally). A resolution has no such
   * earlier event: nothing else can move the status to `resolved` or carry the outcome, so it is
   * always written.
   *
   * ⚠️ **Last, and after the acknowledgement (or the response that stands in for it) is already
   * written.** Everything above is the district's record of what the officer said and must survive
   * a Meta outage, a shut window or a rate limit — `askWhatFollows` sends, and a send that fails
   * must not cost the record. This is the rule the substitute question one screen below already
   * follows, for the same reason.
   *
   * ⚠️ **`recordWhatTheySaid` is NOT called a second time here.** It already ran above, in
   * place of `markObligationMet` — which is the one step of `chooseResponse` this path does
   * differently, and the reason the three are called out rather than shared as one function.
   */
  if (chosen !== null) {
    if (resolvesDirectly) {
      await applyResponseStage(pool, chosen, message.incidentId, message.attemptId);
    }
    await askWhatFollows(
      pool,
      config,
      phone,
      chosen,
      message.incidentId,
      message.attemptId,
      fetchImpl,
    );
  }

  /**
   * **And if they said somebody else is coming, ask who** — Phase B, the owner's own gap.
   *
   * Last, deliberately. Everything above is the district's record of what the officer answered
   * and it must be written whether or not the follow-up can be sent — a Meta outage, a shut
   * window, a rate limit. A question that fails to go leaves the tap correctly recorded and the
   * district no worse off than it was yesterday, which is the only acceptable direction.
   */
  if (tapped && text.trim().toLowerCase() === SUBSTITUTE_REPLY.toLowerCase()) {
    await askWhoIsComing(pool, config, phone, message.incidentId, message.attemptId, fetchImpl);
  }

  /**
   * **And if they are not coming, ask why** — the district's §9, 2026-08-24.
   *
   * Their document is the first thing to ask for this. *Not Attending* has been a tappable answer
   * since the notice template was approved, and it has always been recorded — what the district
   * never got was the sentence after it, which is the whole of what a control room does with a
   * declined meeting: chase the officer, or send the papers to somebody else.
   *
   * ⚠️ **The BUTTON is untouched and untouchable.** It is approved at Meta by position on
   * `district_notice_v2`, and the district's first condition was that no template changes. All
   * that is new is a free-form question inside the window this very tap opened.
   *
   * Last, and after the answer is already on the record, exactly as the substitute question is: a
   * Meta outage must cost the follow-up and never the answer.
   */
  if (tapped && text.trim().toLowerCase() === DECLINED_REPLY.toLowerCase()) {
    await askWhyNotAttending(pool, config, phone, message.incidentId, message.attemptId, fetchImpl);
  }

  /**
   * **And if they acknowledged an emergency, hand them the rest of it** — Phase C.
   *
   * Until now this was the end of the conversation: the officer had answered, and *On scene* and
   * *Resolved* lived on a **web page** reached by a link — so the whole lifecycle happened
   * outside WhatsApp even though the acknowledgement had happened inside it. The link is still
   * there and still works; it is a fallback now rather than the only road.
   *
   * Last, and after the acknowledgement is already written, for the same reason the substitute
   * question is: a Meta outage must cost the buttons and never the answer.
   */
  if (tapped && text.trim().toLowerCase() === ACKNOWLEDGE_REPLY.toLowerCase()) {
    /**
     * 🔴 **The district's thank-you, and NOTHING under it** — the owner's correction of
     * 2026-08-23, read off a real handset.
     *
     * This is the route their request is about: the officer pressed *Acknowledge* on the template,
     * which is the tap the whole system is built around. ⚠️ **Until this morning this line called
     * `offerNextStages`**, so the thank-you arrived carrying *On scene*, *Resolved* and *Where I
     * am* — action buttons under a message whose only job is to say thank you. See
     * `thankForAcknowledgement` for what the officer keeps instead.
     *
     * ⚠️ **Sent whether or not the `acknowledged` event was written.** A colleague may have
     * acknowledged the same emergency ninety seconds earlier, and `appendAcknowledgement` is
     * once-only — but that rule is about the incident's clock, not about whether *this* officer
     * answered. They pressed the button; the district thanks them for pressing it.
     */
    await answerTheAcknowledgement(
      pool,
      config,
      phone,
      message.incidentId,
      message.attemptId,
      fetchImpl,
    );
  }

  /**
   * 🔴 **And if they said they are attending a meeting, thank them for it — 2026-09-10.**
   *
   * *Sending someone* and *Not attending* each open a follow-up question (`askWhoIsComing`,
   * `askWhyNotAttending`) and are answered at the end of it. *Attending* asks nothing — and so,
   * until now, it was answered with **nothing at all**: the officer tapped the button on a
   * meeting notice and the thread stayed silent, which on a handset is indistinguishable from a
   * tap that failed to send. That silence is the one thing every confirmation in this file
   * exists to prevent.
   *
   * `acknowledgementThanks` returns the district's own verbatim `THANKS.meeting` for a meeting —
   * *"Thank you for the Acknowledgement. Kindly make it convenient to attend the subject
   * meeting."* — which carries no buttons (the owner's rule of 2026-08-23) and was, until this
   * line, defined and never sent on this path. `say` checks the service window and swallows a
   * failed send, because the tap is already on the record above.
   *
   * ⚠️ **Gated on `kind === 'meeting'`.** *"Attending"* is a plainer word than the other two and
   * `THANKS.meeting`'s sentence only makes sense for a meeting; a non-meeting template carries no
   * such button today, and this keeps it that way if one ever does.
   */
  if (
    state.kind === 'meeting' &&
    tapped &&
    text.trim().toLowerCase() === ATTENDING_REPLY.toLowerCase()
  ) {
    await say(
      pool,
      config,
      phone,
      acknowledgementThanks(state.kind, state.category?.value ?? null),
      fetchImpl,
      message.incidentId,
    );
  }

  /**
   * 🔴 **AND IF THEY TYPED SOMETHING, OFFER THE BUTTONS BACK — Phase 9b, 2026-08-21.**
   *
   * The owner found the gap on a real handset: the control room chased, the officer typed
   * **"It is resolved"**, and the emergency sat on the board as *Responded*. Their words are on
   * the incident, verbatim — **the record is not the thing that was missing.** What was missing is
   * that nothing acted on them and nobody was told to look.
   *
   * 🔴 **THE ANSWER IS NOT TO READ THE WORDS, AND THAT REFUSAL IS OLDER THAN THIS DEFECT.**
   * Auto-closing from a free-text reply was proposed on 2026-08-08 and turned down, for reasons
   * that have not weakened: *"not handled yet"* contains *"handled"*; an emergency can be
   * dispatched to several people and one person's reply is not everyone's; closure needs a reason
   * from an overrider that a one-word reply cannot carry; and **a real emergency marked done
   * because a reply was misread is worse than the extra step.** It would also have to work in
   * Roman Urdu, English and both mixed, which is a word list this system has no business owning.
   *
   * So it **offers**. One tap runs the machinery that has existed since Phase C — including the
   * *"what happened?"* question, so a resolution still arrives with a sentence behind it. Being
   * wrong costs one extra message; guessing costs an emergency nobody attended.
   *
   * ⚠️ **Claimed once per (incident, handset, status), and the claim is the whole restraint.**
   * Without it an officer who types four times is answered four times, which is the chattiness
   * the owner named and deferred rather than accepted. It re-arms when the emergency actually
   * moves, because then the question has changed.
   *
   * ⚠️ **Never after a tap.** A tap is already one of these buttons, and `handleOurChoice` answers
   * it — offering again would be the software replying to its own reply.
   *
   * 🔴 **And never after a typed answer that named one of the district's options** — 2026-08-26.
   *
   * The reasoning below turns on *"`webhooks.ts` deliberately does not read words for meaning"*,
   * and since the options are written into the message that is no longer true: a typed `2` **is**
   * read, and `askWhatFollows` has already put the right thing on the officer's screen — the
   * district's closing sentence, or the question the option asks. Offering the stage buttons on
   * top of it would send two messages where a tap sends one, and the second would answer *"Thank
   * you for your response"* with *"Thank you. When there is something to record, tap below."*
   *
   * ⚠️ **A typed sentence that is NOT one of their options still gets these buttons**, unchanged,
   * and that is the case the reasoning below was written for. It is the ordinary one.
   *
   * ⚠️ **The status is re-read from the fold**, not taken from `state` above: the acknowledgement
   * and the `action_logged` this function has just appended are exactly what moves it, and
   * offering *Acknowledged* to an officer who has this second acknowledged it is the software
   * asking for something it already has.
   *
   * Last, and after everything is recorded — a Meta outage must cost the buttons, never the
   * answer. `offerNextStages` swallows its own failures for the same reason.
   */
  if (!tapped && chosen === null) {
    const after = foldIncident(message.incidentId, await loadIncident(pool, message.incidentId));
    if (stagesOfferedFrom(after.status).length > 0) {
      const mine = await claimStageOffer(pool, {
        incidentId: message.incidentId,
        phone,
        atStatus: after.status,
      });
      if (mine) {
        /**
         * ⚠️ **This one keeps its buttons and does NOT carry the district's thank-you** — the
         * owner's rule of 2026-08-23, applied where it points rather than everywhere.
         *
         * Their words were *"action wale msgs nhe hote hain, just a thank you msg hote hain"*, and
         * this message is the opposite of that: an officer typed something into the thread,
         * `webhooks.ts` deliberately does not read words for meaning, and **offering the controls
         * is the entire reason this message exists** (Phase 9b, and it closed a defect the owner
         * found themselves — an officer typed *"It is resolved"* and the board went on saying
         * *Responded*).
         *
         * So the rule holds in both directions: a thank-you carries no buttons, and a message that
         * exists to carry buttons is not dressed up as a thank-you. It says what it has always
         * said.
         */
        await offerNextStages(
          pool,
          config,
          phone,
          message.incidentId,
          message.attemptId,
          fetchImpl,
        );
      }
    }
  }
}

/**
 * What the district's record calls each kind of thing an officer can send — 2026-08-21.
 *
 * Words, not media types. *"Sent a voice note on WhatsApp"* is what happened; *"Sent
 * audio/ogg"* is what the wire carried, and the incident log is read six months later by
 * somebody asking what the officer did.
 *
 * ⚠️ **`voice` and `audio` say different things and that is the point of keeping them apart.**
 * A voice note is an officer holding the microphone button — which is very often the fastest
 * and most detailed report this district will ever get — and an audio file is something they
 * forwarded from somewhere else.
 */
const MEDIA_WORDS: Readonly<Record<InboundMedia['kind'], string>> = {
  image: 'a photograph',
  video: 'a video',
  voice: 'a voice note',
  audio: 'an audio recording',
  document: 'a file',
  sticker: 'a sticker',
};

type KeptEvidence =
  { readonly ok: true; readonly evidenceId: string } | { readonly ok: false; readonly why: string };

/**
 * Fetch what an officer sent and attach it to the incident — 2026-08-21.
 *
 * ## Why this is evidence and not a new kind of row
 *
 * `ops/evidence.ts` already answers every question a file raises: where the bytes go, what the
 * declared type is worth (nothing — the magic number decides), how big is too big, how it is
 * served back safely, and what hash proves it has not changed. A second store for *files that
 * arrived by WhatsApp* would be all of that written again, and the half that would drift is the
 * one nobody looks at: an incident's screen already lists evidence, so this appears there by
 * having been stored rather than by anybody adding a panel.
 *
 * `allowed` is left at the evidence default rather than narrowed to `COMMUNICATION_TYPES`. Those
 * two lists differ for a stated reason — a **communication** is a document going *out* to fifty
 * handsets, so every extra format is one more thing that has to open on all of them, while
 * **evidence** is a crew documenting a scene. This is unambiguously the second: it is coming in,
 * from the scene, and video and voice are exactly what it will carry.
 *
 * ## What it refuses, and why every refusal is a returned sentence
 *
 * Nothing here throws. The caller appends the officer's answer to the incident whatever happens
 * (see its own note), so a thrown error would turn *"the picture could not be fetched"* into
 * *"the reply was never recorded"* — a provider's bad minute costing an officer their
 * acknowledgement, which is the failure this whole file is written against.
 */
async function keepEvidence(
  pool: Pool,
  root: string,
  config: WhatsAppConfig,
  media: InboundMedia,
  incidentId: string,
  attempt: { readonly personId?: string | null; readonly seatId?: string | null } | undefined,
  fetchImpl: typeof fetch,
  /** Already fetched while the officer was asked which it is (ADR-0040). */
  prefetched?: Prefetched,
): Promise<KeptEvidence> {
  const got =
    prefetched === undefined
      ? await downloadMedia(config, media.mediaId, fetchImpl)
      : ({ ok: true, ...prefetched } as const);

  if (!got.ok) {
    log('warn', 'inbound whatsapp media could not be fetched', {
      incidentId,
      kind: media.kind,
      failure: got.failure,
      retryable: got.retryable,
    });
    return { ok: false, why: got.failure };
  }

  /**
   * The filename is a **label** and never a path — `ops/evidence.ts` derives the path from ids it
   * generates itself, which is why a document called `../../0001.sql` is merely an odd label here.
   *
   * A photograph and a voice note carry none, because a handset does not name what the camera or
   * the microphone just produced. One is composed from the kind and the day so the incident's
   * evidence list reads as something rather than as a bare uuid.
   */
  const filename =
    media.filename ?? `whatsapp-${media.kind}-${new Date().toISOString().slice(0, 10)}`;

  const stored = await store(pool, root, {
    incidentId,
    filename,
    // Meta's word for it, and it is a claim like any other upload's. `decideType` reads the
    // bytes, the bytes win, and a mismatch is refused rather than quietly corrected (M9-14).
    contentType: got.contentType,
    bytes: got.bytes,
    /**
     * **Attributed to the officer the message was sent to, and it is the same inference the note
     * beside it states in words.** A handset is not a person — but this is the strongest claim
     * available and leaving it blank would file the district's own field photographs under
     * nobody, which is worse than an inference the record admits to.
     */
    seatId: attempt?.seatId ?? null,
    personId: attempt?.personId ?? null,
  });

  if (!stored.ok) {
    // A refusal from the evidence layer, not from Meta — too large, or a kind this district does
    // not store. Logged and returned in the same shape, because from the officer's side they are
    // one situation: they sent something and it is not on the incident.
    log('warn', 'inbound whatsapp media was refused', {
      incidentId,
      kind: media.kind,
      why: stored.why,
    });
    return { ok: false, why: stored.why };
  }

  return { ok: true, evidenceId: stored.value.evidenceId };
}

/**
 * Offer the stages this officer may still record, as buttons — Phase C.
 *
 * **What `mintOffers` does for the page, done for the thread.** The page mints a single-use token
 * per stage; a button carries the same two facts in its id and needs no token at all, because the
 * message it sits in was delivered to that number by Meta and nothing else can produce an inbound
 * claiming to be it.
 *
 * ⚠️ **Read from the incident's CURRENT status, never from what was offered last time.** An
 * emergency a colleague has already resolved offers nothing, and this sends nothing at all rather
 * than a button that would refuse — the same shape the page holds: *there is no such thing here
 * as a control that is present and refuses.*
 */
async function offerNextStages(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);

  const stages = stagesOfferedFrom(state.status);
  if (stages.length === 0) return;

  if (!(await sessionWindowOpen(pool, phone))) {
    log('info', 'not offering the lifecycle: the service window is shut', { incidentId });
    return;
  }

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      text: 'Thank you. When there is something to record, tap below.',
      buttons: [
        ...stages.map((stage) => ({
          id: stageButtonId(stage, incidentId, attemptId),
          title: stageButtonWords(stage, state.kind),
        })),
        /**
         * **Where are you** rides with the stages, exactly as it does on the page — which offers
         * the availability form beside the two stage links rather than on a screen of its own.
         *
         * ⚠️ **Two stages plus this is three, which is Meta's cap exactly.** A fourth button
         * cannot be added here without deciding which of these stops being offered; the honest
         * place for a fourth thing is a list, which is what availability itself uses.
         */
        { id: availabilityButtonId(incidentId, attemptId), title: WHERE_BUTTON_WORDS },
      ],
    },
    fetchImpl,
  );

  if (!result.ok) {
    /**
     * Logged and swallowed. The officer still has the **link** on the original message, which is
     * exactly what this replaces rather than removes — so a failure here costs one fewer road to
     * the same place, never the road itself.
     */
    log('warn', 'could not offer the lifecycle buttons', {
      incidentId,
      failure: result.failure,
    });
  }
}

/**
 * **Answer the acknowledgement, in the district's words, and offer NOTHING** — the owner's
 * correction of 2026-08-23, made on a real handset.
 *
 * The district's three sentences shipped this morning **folded into `offerNextStages`'s message**,
 * so an officer who acknowledged a flood alert got the thank-you with *On scene*, *Resolved* and
 * *Where I am* underneath it. The owner read that on their own phone and said what it is:
 * *"ye chunki action wale msgs nhe hote hain just a thank you msg hote hain es lye es pr action
 * wale button nhe hone chaye hai."*
 *
 * 🔴 **A message that thanks somebody and a message that asks them to do something are two
 * different messages, and merging them was the mistake.** The merge was made for a cost reason
 * that was real — one send instead of two, which matters from 1 October 2026 when Meta starts
 * charging for free-form replies inside the service window. **That reason survives this change
 * intact**, because the buttons are not moved to a second message: they are simply not offered
 * here at all. The acknowledge tap still produces **exactly one** outbound message, as it did
 * yesterday and as it did this morning.
 *
 * ## What an officer loses, and what they keep
 *
 * ⚠️ **This is a real cost and it should not be written down as none.** Since Phase C the tap on
 * *Acknowledge* was the moment the rest of the lifecycle appeared in the thread, and it no longer
 * is. What remains, in the order an officer meets them:
 *
 *   * **the link on the alert they just acknowledged** — `district_emergency_v2` carries a quick
 *     reply *and* a URL button, so the page with *On scene*, *Resolved* and *where are you* is one
 *     tap away on the message directly above this one;
 *   * **typing anything** — Phase 9b re-offers the buttons to an officer who writes into the
 *     thread, which is the road most of them take anyway;
 *   * **the control room's *Follow up*** — `api/followUp.ts` sends the stages as buttons.
 *
 * ⚠️ **A meeting keeps no link** (`district_notice_v2` is quick replies only) — and needs none.
 * *On scene* and *Resolved* were never sensible under a meeting notice, which is half of why the
 * buttons looked wrong here at all. ✅ **The other half is fixed too, 2026-08-24**: a gathering's
 * button says *Attending* now — `stageButtonWords`.
 *
 * ## Why it is a separate function rather than a flag
 *
 * It was a flag on `offerNextStages` for one morning, and the flag was the thing that made the
 * merge look reasonable. Two jobs — *say thank you* and *offer the controls* — sharing one body
 * meant every change to either had to be reasoned about against the other. `offerNextStages` is
 * back to exactly what it was before this feature; this owns the district's words and sends
 * nothing else.
 */
async function thankForAcknowledgement(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);

  if (!(await sessionWindowOpen(pool, phone))) {
    log('info', 'not thanking for the acknowledgement: the service window is shut', { incidentId });
    return;
  }

  /**
   * The district's words are chosen from the **message's own two labels** — never from anything
   * this function was told. `domain/acknowledgementThanks.ts` holds the mapping and the reasons;
   * what matters here is that it is read off the fold, so a category corrected by the control
   * room after the alert went out is the category the officer is answered against.
   *
   * ⚠️ **No stage is read and none is offered**, so unlike `offerNextStages` there is no status
   * this returns early on. An officer who acknowledges an emergency a colleague resolved a minute
   * ago is still an officer who acknowledged, and the district thanks them for it.
   */
  const result = await sendSession(
    config,
    { toPhone: phone, text: acknowledgementThanks(state.kind, state.category?.value ?? null) },
    fetchImpl,
  );

  if (!result.ok) {
    // Logged and swallowed, on `offerNextStages`'s own reasoning: the acknowledgement is already
    // recorded, and a courtesy that failed to send must never cost the district the record of it.
    log('warn', 'could not thank the officer for acknowledging', {
      incidentId,
      failure: result.failure,
    });
  }
}

/**
 * **What an acknowledgement is answered with now** — the district's own workflow, 2026-08-24.
 *
 * Until today this line was `thankForAcknowledgement` and nothing else: the officer tapped
 * *Acknowledge*, the district said thank you, and the conversation was over. The district asked
 * for the conversation to continue — *"template msg k jane k baad, yaane k report ko acknowledge
 * karne k baad ju thank you msg jata hai … distrct ese msg ko change karna chah rahe hain, and wo
 * chahte hain k har category k lye wo msg ka workflow bani"*.
 *
 * 🔴 **No template is touched by any of this.** The tap opened Meta's 24-hour service window
 * moments ago, and everything below is a free-form message inside it.
 *
 * ## The thank-you is not gone, it is in the question's first line
 *
 * `CHOOSE_LINE` opens with *"Thank you for the Acknowledgement."* and the district's closing
 * sentence waits for an answer — because their own final message thanks the officer for their
 * **response**, which is a different act. An officer who taps at 02:00 and puts the phone down
 * still hears something back, which is what they get today and must not lose.
 *
 * ## ⚠️ Three ways this falls back to exactly today's behaviour, and all three are deliberate
 *
 *   * **a meeting** — `listFor` gives it no list, because its three answers are approved at Meta
 *     as quick replies and attendance owns that conversation
 *   * **a shut service window** — a webhook Meta retried an hour later, against a window that
 *     closed in between
 *   * **a refused or failed send**
 *
 * In every one of them the officer gets `THANKS`, exactly as they did yesterday. **A district that
 * loses its thank-you because a list would not send is worse off than one that never had a list.**
 */
async function answerTheAcknowledgement(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);

  /**
   * Read off the **message's own two labels**, never from anything this function was told — so a
   * category the control room corrected after the alert went out is the category the officer is
   * asked about. `thankForAcknowledgement` takes the district's three sentences the same way.
   */
  const list = listFor(state.kind, state.category?.value ?? null);
  if (list === null) {
    await thankForAcknowledgement(pool, config, phone, incidentId, fetchImpl);
    return;
  }

  const sent = await offerOptions(
    pool,
    config,
    phone,
    CHOOSE_LINE,
    optionsOf(list),
    incidentId,
    attemptId,
    fetchImpl,
  );

  if (!sent) await thankForAcknowledgement(pool, config, phone, incidentId, fetchImpl);
}

/**
 * The options this incident **would have been offered**, derived rather than remembered.
 *
 * `answerTheAcknowledgement` asks `listFor` the same question with the same two labels when it
 * sends them, so a typed answer is matched against exactly what was on the screen without a
 * column recording it. A category the control room corrected after the alert went out moves both
 * halves together, because there is only one half.
 */
function offeredFor(state: IncidentState): readonly ResponseOption[] {
  const list = listFor(state.kind, state.category?.value ?? null);
  return list === null ? [] : optionsOf(list);
}

/**
 * Put a set of the district's options on the officer's screen, as a list.
 *
 * **A list and never buttons**, and that is Meta's arithmetic rather than a preference: the
 * longest of these is five options and a message carries at most three buttons. `offerAvailability`
 * is here for the same reason and says so.
 *
 * 🔴 **The headline is the row's title and the district's sentence is its description.** That
 * split is the whole of `responseOptions.ts`: twenty-two of their thirty-three options are longer
 * than Meta's 24-character title, and `sendSession` refuses an over-long row rather than letting
 * Meta refuse the message. **Nothing they wrote is shortened** — it rides the 72-character line
 * underneath, in full.
 *
 * Returns whether the officer actually has it, so a caller can put something else on the screen
 * instead of leaving them with silence.
 */
async function offerOptions(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  text: string,
  options: readonly ResponseOption[],
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (!(await sessionWindowOpen(pool, phone))) {
    log('info', 'not offering the response options: the service window is shut', { incidentId });
    return false;
  }

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      /**
       * 🔴 **The options are written into the message as well as into the sheet** — the owner,
       * 2026-08-26. `optionsWrittenOut` carries the argument in full.
       *
       * ⚠️ **Both callers get this, and both should.** The acknowledgement list and the
       * *Unable to Respond* branch below are the only two, and an officer asked *“which of
       * these?”* with no *these* on screen is the same complaint in a smaller place.
       *
       * ⚠️ **A body too long is refused by `sendSession` and this function returns `false`**,
       * which drops the officer to the plain thank-you with no options at all. The longest of
       * the district’s lists composes to roughly 250 of Meta’s 1024 characters, and
       * `responseOptions.test.ts` holds every list to that cap so a future option cannot
       * quietly cross it.
       */
      text: optionsWrittenOut(text, options),
      list: {
        /**
         * **`Tap to reply`, not `Choose one`** — the owner, 2026-08-26. Ours to word, twenty
         * characters, nothing approved at Meta. With the options now written above it, the
         * button’s job is no longer to announce that there is a choice; it is to say how to
         * make one.
         */
        button: 'Tap to reply',
        rows: options.map((option) => ({
          id: `${RESP_ROW}:${option.id}:${incidentId}:${attemptId}`,
          title: option.headline,
          description: option.wording,
        })),
      },
    },
    fetchImpl,
  );

  if (!result.ok) {
    log('warn', 'could not offer the response options', { incidentId, failure: result.failure });
    return false;
  }
  return true;
}

/**
 * One of the district's options, chosen — their workflow, 2026-08-24.
 *
 * ## The order of what happens here is the whole safety of it
 *
 * **The words are written first, every time**, and only then is anything sent. An officer can tap
 * twice faster than a webhook round trip completes, and a district that recorded an answer *after*
 * confirming it would lose the answer to any restart between the two. Every send below is logged
 * and swallowed for the same reason `offerNextStages` swallows its own: a Meta outage must cost
 * the confirmation and never the record.
 *
 * ## ⚠️ What is written, and what is deliberately not
 *
 * `recordWhatTheySaid` puts **the district's full sentence** on the obligation — never the
 * headline, which exists only on the glass of a handset. That one field is what the board, the
 * incident screen, the daily report, the export and `ownershipOf` all read.
 *
 * On top of it, and only where the option means one:
 *
 *   * `responded` → `appendStage`, which is the `action_logged` the fold turns into *Responding*
 *   * `resolved` → `appendStage`, which carries the district's sentence as the outcome
 *   * `acknowledged` and `no_owner` → **nothing further, and that is the point rather than an
 *     omission.** They acknowledged when they tapped the template. *"I cannot"* and *"this is not
 *     mine"* are answers, so the obligation is met and the officer leaves the chase list — while
 *     nobody has taken the emergency, which is exactly what `domain/ownership.ts` reads back out
 *     of these same words.
 */
async function chooseResponse(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  replyId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const [, optionId, incidentId, attemptId] = replyId.split(':');
  const option = optionId === undefined ? null : optionById(optionId);

  if (option === null || incidentId === undefined || attemptId === undefined) {
    // A row this version does not know, or one from a build that structured its ids differently.
    // Logged rather than guessed at: acting on half an id is how a tap lands on the wrong answer.
    log('info', 'a response row that means nothing here', { replyId });
    return;
  }

  await recordWhatTheySaid(pool, incidentId, attemptId, {
    via: 'reply',
    /**
     * ⚠️ **The district’s sentence, never the characters the officer typed.** `said` is what
     * every screen, count and report reads an option back out of (`optionOfSaid`), so a record
     * holding `2` would be an answer nothing could interpret. What they actually typed is not
     * lost — it goes on the `action_logged` note, in their own characters, where a human reads
     * it.
     */
    said: option.wording,
  });

  if (option.records === 'responded' || option.records === 'resolved') {
    await applyResponseStage(pool, option, incidentId, attemptId);
  }

  await askWhatFollows(pool, config, phone, option, incidentId, attemptId, fetchImpl);
}

/**
 * Move the emergency, where the option says one has moved.
 *
 * ⚠️ **Re-read from the incident's CURRENT status and never from what was offered.** A row is
 * tapped from a message history hours later, on an emergency a colleague may have resolved in the
 * meantime — and `stageIsStillAhead` is the same guard `applyStageFromButton` uses. *Somebody got
 * there first* is not an error and never reads as one: unlike the stage button, this path has
 * something to send either way — the district's closing sentence follows in `askWhatFollows` — so
 * the officer is thanked for answering rather than told their tap did nothing.
 *
 * ⚠️ **A resolution here does NOT ask what happened, and that is the one place this path diverges
 * from the *Resolved* button.** That button asks because *"resolved"* is not an answer six weeks
 * later. This one does not need to: the officer chose *"Issue Already Resolved"*, which is the
 * district's own sentence and is written into the outcome as it stands. Asking again would be the
 * software declining to read what it had just been told.
 */
async function applyResponseStage(
  pool: Pool,
  option: ResponseOption,
  incidentId: string,
  attemptId: string,
): Promise<void> {
  const stage: Stage = option.records === 'resolved' ? 'resolved' : 'responded';

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);

  if (!stageIsStillAhead(stage, state.status)) {
    log('info', 'the emergency has already moved past this option', { incidentId, stage });
    return;
  }

  const attempt = state.notifications.find((a) => a.attemptId === attemptId);

  await appendStage(pool, {
    incidentId,
    eventCount: state.eventCount,
    // From the obligation this answers, exactly as the button path takes them — neither resolves
    // the roster as it stands now (ADR-0004).
    personId: attempt?.personId ?? null,
    seatId: attempt?.seatId ?? null,
    stage,
    said: option.wording,
    from: 'WhatsApp',
  });
}

/**
 * What the district asks next, if anything — their workflow's second and third layers.
 *
 * Five endings, and the reason there is no shared *"ask something"* helper is `askWhatHappened`'s:
 * these are different questions, asked at different moments, about different things, and one
 * helper is a single wording away from asking an officer who is coming when the district wanted to
 * know why they cannot.
 */
async function askWhatFollows(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  option: ResponseOption,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (option.asks === 'branch') {
    /**
     * ⚠️ **If the branch cannot be sent, the officer still said they are unable** — that is
     * already on the record above — so they are given the closing sentence rather than silence.
     * The district learns *that* they cannot, without learning *why*, which is where it stood
     * before any of this existed.
     */
    const sent = await offerOptions(
      pool,
      config,
      phone,
      `"${option.wording}" — which of these?`,
      UNABLE_BRANCH,
      incidentId,
      attemptId,
      fetchImpl,
    );
    if (!sent) await closeTheWorkflow(pool, config, phone, incidentId, fetchImpl);
    return;
  }

  if (option.asks === 'until') {
    /**
     * **On leave is recorded as `unavailable`, with no *how long* — ADR-0033.**
     *
     * The district used to ask how long, because `leave` was a claim it planned around. The
     * five-answer list is gone: availability is two states the control room manages by hand, so
     * this branch records the officer unavailable and sends the district's closing sentence in
     * the same breath. The record lands in the presence log where the wall reads it, exactly as
     * `chooseAvailability` writes it.
     */
    await recordAvailability(
      pool,
      config,
      phone,
      'unavailable',
      incidentId,
      attemptId,
      fetchImpl,
      RESPONSE_THANKS,
    );
    return;
  }

  if (option.asks === 'name') {
    await askTheirRepresentative(pool, config, phone, incidentId, attemptId, fetchImpl);
    return;
  }

  if (option.asks === 'message' || option.asks === 'reason') {
    await askInTheirWords(pool, config, phone, option, incidentId, attemptId, fetchImpl);
    return;
  }

  await closeTheWorkflow(pool, config, phone, incidentId, fetchImpl);
}

/**
 * The district's closing sentence — the end of every path through their workflow.
 *
 * ⚠️ **It carries no buttons, and that is the owner's rule of 2026-08-23 still standing.** *"action
 * wale msgs nhe hote hain, just a thank you msg hote hain"*. What changed today is that the
 * **first** message is no longer a thank-you; this one is, and it is bare.
 */
async function closeTheWorkflow(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  await say(pool, config, phone, RESPONSE_THANKS, fetchImpl, incidentId);
}

/**
 * Ask who is coming instead, on the response workflow's path.
 *
 * `askWhoIsComing` asks the identical question for a **meeting**, and the two are kept apart by
 * their question kind for one reason that matters on a handset: what is said afterwards. A meeting
 * is answered with *"kindly make it convenient to attend"*; an emergency is answered with the
 * district's closing sentence and the control room's number. One shared kind would hand a meeting
 * the emergency number, which is the mistake `thanksKindFor` exists to prevent.
 */
async function askTheirRepresentative(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) {
    await closeTheWorkflow(pool, config, phone, incidentId, fetchImpl);
    return;
  }

  // Recorded before it is sent, on `recordQuestion`'s own rule: an officer types a name faster
  // than a webhook round trip completes, and a question recorded afterwards is one whose answer
  // can arrive first and be read as an ordinary reply.
  const questionId = await recordQuestion(pool, {
    phone,
    incidentId,
    attemptId,
    asks: 'representative',
  });

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      text: 'Name and designation of the representative? Please reply with the details.',
    },
    fetchImpl,
  );

  if (!result.ok) {
    log('info', 'could not ask who is coming instead', {
      incidentId,
      questionId,
      failure: result.failure,
    });
  }
}

/**
 * Ask for the officer's own sentence — the district's two free-text moments.
 *
 * **`message` is theirs to give and `reason` is theirs to owe**, and the wording says which. Their
 * document is explicit about the difference: *"the recipient **may** enter a brief message"* under
 * *Further Information Required*, and *"shall be **required** to provide a brief reason"* under
 * *Otherwise Unavailable*. Nothing here enforces the second — a district cannot make an officer
 * type — but the sentence should not pretend they are the same request.
 */
async function askInTheirWords(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  option: ResponseOption,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) {
    await closeTheWorkflow(pool, config, phone, incidentId, fetchImpl);
    return;
  }

  const asking = option.asks === 'reason' ? 'reason' : 'clarification';

  const questionId = await recordQuestion(pool, {
    phone,
    incidentId,
    attemptId,
    asks: asking,
  });

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      text:
        asking === 'reason'
          ? `"${option.wording}" — please briefly state the reason.`
          : `"${option.wording}" — please say briefly what you need.`,
    },
    fetchImpl,
  );

  if (!result.ok) {
    log('info', 'could not ask for their words', {
      incidentId,
      questionId,
      failure: result.failure,
    });
  }
}

/**
 * Their sentence, written onto the emergency and answered with the district's closing message.
 *
 * ⚠️ **It is an `action_logged` and NOT a stage claim, on either path.** `foldIncident` moves an
 * acknowledged incident to *Responding* on an `action_logged`, and for a clarification that is
 * arguably generous — but the alternative is a note attached to no event at all, and the district
 * asking six weeks later what an officer needed would find nothing. The note says in words which
 * question it answers, so the record is never ambiguous about what was claimed.
 *
 * ⚠️ **Claimed before the event is written**, in one statement, exactly as `recordSubstitute` does
 * — a redelivered webhook must not append the same sentence twice.
 */
async function recordInTheirWords(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  question: {
    readonly questionId: string;
    readonly incidentId: string;
    readonly attemptId: string;
    readonly asks: string;
  },
  words: string,
  at: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await answerQuestion(pool, question.questionId, words))) return;

  const events = await loadIncident(pool, question.incidentId);
  if (events.length === 0) return;
  const state = foldIncident(question.incidentId, events);

  const attempt = state.notifications.find((a) => a.attemptId === question.attemptId);
  const said = words.trim().slice(0, 2000);

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: question.incidentId,
      occurredAt: at,
      recordedAt: new Date().toISOString(),
      clientSeq: state.eventCount + 1,
      actorPersonId: attempt?.personId ?? null,
      actorSeatId: attempt?.seatId ?? null,
      sourceChannel: 'sms',
      type: 'action_logged',
      payload: {
        note:
          (question.asks === 'reason'
            ? `Unable to respond — the reason given: "${said}"`
            : question.asks === 'absence'
              ? `Not attending — the reason given: "${said}"`
              : `Further information requested: "${said}"`) +
          "\n(answered on WhatsApp, to the district's own question — not inferred)",
      },
    } as unknown as IncidentEvent,
  ]);

  /**
   * **The district's closing sentence, on every path including a meeting** — the owner's
   * decision of 2026-08-25.
   *
   * ⚠️ **This shipped for one day with a meeting getting its own sentence instead**, and the
   * argument for that is written here rather than deleted, because it is the reason to look at
   * this line again if the district ever asks: an officer who has just said they **cannot attend
   * Thursday's meeting** was being handed *"in case of any emergency, contact the control room"*,
   * which is not an answer to what they said — and it is the same class of mismatch
   * `thanksKindFor` exists to prevent.
   *
   * 🔴 **The owner was asked precisely that and answered plainly: *"pdf wala msg hi closing msg
   * ho"*.** Their document's *Final Automated Message* page names no category and their §9 is a
   * category like any other, so one sentence closes every path. **Their words, their call.**
   */
  await say(pool, config, phone, RESPONSE_THANKS, fetchImpl, question.incidentId);
}

/**
 * Ask why an officer is not attending — the district's §9, 2026-08-24.
 *
 * The third of this file's *"ask one thing and read the next message as the answer"* pairs, and
 * kept apart from the other two for `askWhatHappened`'s reason: they are different questions,
 * asked at different moments, about different things, and one shared helper is a single wording
 * away from asking an officer what happened when the district wanted to know why they cannot come.
 */
async function askWhyNotAttending(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) {
    // Nothing is broken and nothing is retried. The answer is recorded; the district simply does
    // not learn the reason this time, which is exactly where it stood before this existed.
    log('info', 'not asking why: the service window is shut', { incidentId });
    return;
  }

  // Recorded before it is sent, on `recordQuestion`'s rule.
  const questionId = await recordQuestion(pool, {
    phone,
    incidentId,
    attemptId,
    asks: 'absence',
  });

  const result = await sendSession(
    config,
    { toPhone: phone, text: 'Reason for not attending? Please briefly state the reason.' },
    fetchImpl,
  );

  if (!result.ok) {
    log('info', 'could not ask why they are not attending', {
      incidentId,
      questionId,
      failure: result.failure,
    });
  }
}

/**
 * The button that opens *"where are you?"* — Phase C2.
 *
 * A **separate id space from the stages**, and the reasoning is `mintAvailability`'s own: an
 * officer saying they are in the field has not responded to anything and certainly has not
 * resolved it. Two different acts, and the page keeps them on two different tokens for exactly
 * this reason. Folding them into one prefix here would be that distinction lost at the one layer
 * where it is cheapest to lose.
 */
/** One of the two answers, chosen from the list `WHERE_BUTTON` opens (ADR-0033). */
const AVAIL_ROW = 'avail';

/**
 * One of the district's own response options — their workflow of 2026-08-24.
 *
 * `resp:<optionId>:<incidentId>:<attemptId>`. It carries both ids for `stageButtonId`'s reason and
 * it is the same reason twice over here: these rows sit in an officer's message history, and one
 * tapped an hour later must still know which emergency it answers rather than asking *"what was
 * the last thing we sent this number?"* — a question whose answer moves.
 */
const RESP_ROW = 'resp';

/** Every id this software puts on a button or a row. Anything else is not ours to act on. */
const OURS = [STAGE_BUTTON, WHERE_BUTTON, AVAIL_ROW, RESP_ROW];

/**
 * The post this obligation is owed to, resolved the same way every acknowledgement path resolves
 * it — extracted 2026-08-17's fix rather than written a fourth time.
 *
 * A dispatch to a **named officer** carries no seat, and reading that null as *"this officer
 * holds no post"* is the defect that stopped every acknowledgement in Bajaur for a day. It means
 * only that nobody looked.
 */
async function seatOfAttempt(
  pool: Pool,
  attempt: { readonly seatId?: string | null; readonly personId?: string } | undefined,
): Promise<string | null> {
  const seat = attempt?.seatId;
  // Both absences mean the same thing here and neither means "holds no post": an obligation to a
  // named officer simply carries no seat, and reading that as a fact is the defect of 2026-08-17.
  if (seat !== null && seat !== undefined) return seat;
  if (attempt?.personId === undefined) return null;
  return dutySeatOfPerson(pool, attempt.personId);
}

/**
 * Send the two answers as a list — ADR-0033.
 *
 * It is still a *list* rather than two buttons only because a list message can carry a heading
 * and a description; two quick-reply buttons would do just as well. Kept as a list so the id
 * space and the handler do not move.
 */
async function offerAvailability(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) return;

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      text: 'Are you available? The control room plans around this.',
      list: {
        button: 'Choose one',
        rows: PRESENCE_STATUSES.map((status) => ({
          id: `${AVAIL_ROW}:${status}:${incidentId}:${attemptId}`,
          title: PRESENCE_WORDS[status],
        })),
      },
    },
    fetchImpl,
  );

  if (!result.ok) {
    log('warn', 'could not offer availability', { incidentId, failure: result.failure });
  }
}

/**
 * One of the two, chosen — ADR-0033.
 *
 * Recorded here and now, with no end to ask for: nothing polls an officer, so *"until when"* is
 * a question the district no longer asks. `/status/presence` and the ack page write the same
 * thing the same way — one rule, three doors.
 */
async function chooseAvailability(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  replyId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const [, statusWord, incidentId, attemptId] = replyId.split(':');
  const status = PRESENCE_STATUSES.find((candidate) => candidate === statusWord);

  if (status === undefined || incidentId === undefined || attemptId === undefined) {
    log('info', 'an availability row that means nothing here', { replyId });
    return;
  }

  await recordAvailability(pool, config, phone, status, incidentId, attemptId, fetchImpl);
}

/**
 * Write where the officer is — Phase C2.
 *
 * ⚠️ **`reportPresence` needs a POST, and an officer holding none is not an error here.** The
 * page simply does not draw the form in that case (`mintAvailability` returns undefined), and
 * this says so in the thread instead — because a tap that produced silence reads as the software
 * being broken, which is the thing every one of these confirmations exists to prevent.
 *
 * **Three different people are recorded and they are not the same** (M9-32): the **post** it is
 * about, the **person** it is about, and who **said** it. Here the last two are the same officer,
 * and recording that rather than assuming it is the difference between their own word and a
 * clerk's.
 */
async function recordAvailability(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  status: PresenceStatus,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
  /**
   * The district's closing sentence, when this was reached through their response workflow.
   *
   * ⚠️ **Appended to the confirmation rather than sent as a second message.** The officer needs
   * both — *what was recorded* and *the district's thank-you* — and two bubbles in a row at 02:00
   * is the chattiness the owner named and deferred rather than accepted.
   */
  closing: string | null = null,
): Promise<void> {
  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);
  const attempt = state.notifications.find((a) => a.attemptId === attemptId);

  const seatId = await seatOfAttempt(pool, attempt);
  if (seatId === null) {
    await say(
      pool,
      config,
      phone,
      'Thank you — but this is recorded against a post, and the district has none on record ' +
        'for you tonight. Ring the control room and they can set it.',
      fetchImpl,
      incidentId,
    );
    return;
  }

  await reportPresence(pool, {
    seatId,
    status,
    note: null,
    reportedBy: seatId,
    personId: attempt?.personId ?? null,
  });

  const confirmation = `Recorded: ${PRESENCE_WORDS[status].toLowerCase()}. Thank you.`;

  await say(
    pool,
    config,
    phone,
    closing === null
      ? confirmation
      : `${confirmation}

${closing}`,
    fetchImpl,
    incidentId,
  );
}

/**
 * A tap on one of those buttons — Phase C.
 *
 * ## The two stages behave differently, and that asymmetry is the district's rule, not a shortcut
 *
 * *Responding* — *Attending* on a gathering — is recorded **immediately**: it says one thing and
 * says all of it. *Resolved* is
 * not — `POST /ack/:token` has demanded a sentence since M9-27 because **a resolution recorded
 * as "resolved" answers nothing**, and six weeks later the district is asked what happened and
 * the record holds one word. So the tap asks, and the officer's next message closes it.
 *
 * ⚠️ **Nothing is recorded on the way to that question.** An officer who taps *Resolved* and then
 * says nothing has resolved nothing, and the emergency stays open and keeps its clock — which is
 * the honest outcome and the same one the page produces when somebody closes the browser on an
 * empty box.
 */
async function applyStageFromButton(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  replyId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const [, stageWord, incidentId, attemptId] = replyId.split(':');

  const stage = STAGES.find((candidate) => candidate === stageWord);
  if (stage === undefined || incidentId === undefined || attemptId === undefined) {
    // A button this software did not build, or one from a version that structured its ids
    // differently. Logged rather than guessed at: acting on half an id is how a tap lands on the
    // wrong emergency.
    log('info', 'a lifecycle button id that means nothing here', { replyId });
    return;
  }

  const events = await loadIncident(pool, incidentId);
  if (events.length === 0) return;
  const state = foldIncident(incidentId, events);

  const attempt = state.notifications.find((a) => a.attemptId === attemptId);

  /**
   * **Somebody got there first, and that is not an error.** The page says so in words rather than
   * showing a failure (M9-28); this says the same thing in the thread. Sending nothing at all
   * would leave the officer looking at a button that appeared to do nothing.
   */
  if (!stageIsStillAhead(stage, state.status)) {
    await say(
      pool,
      config,
      phone,
      `Already recorded as ${stageLabel(stage).toLowerCase()} — nothing further is needed.`,
      fetchImpl,
      incidentId,
    );
    return;
  }

  if (stage === 'resolved') {
    await askWhatHappened(pool, config, phone, incidentId, attemptId, fetchImpl);
    return;
  }

  await appendStage(pool, {
    incidentId,
    eventCount: state.eventCount,
    // From the obligation the message answered, exactly as the link path takes them from the
    // token. Neither resolves the roster as it stands now (ADR-0004).
    personId: attempt?.personId ?? null,
    seatId: attempt?.seatId ?? null,
    stage,
    said: null,
    from: 'WhatsApp',
  });

  /**
   * And offer what is still ahead, re-read from the record rather than assumed — the same rule
   * `offerNextStages` follows, which is why it is called again instead of a button being
   * remembered from the message before.
   */
  await offerNextStages(pool, config, phone, incidentId, attemptId, fetchImpl);
}

/**
 * One door for every button and row this software builds — Phase C2.
 *
 * Written as a switch on the prefix rather than four checks in `recordReply`, because that
 * function's job is *what does this inbound mean* and this one's is *which of our own controls
 * was pressed*. Anything not recognised is logged and dropped: acting on an id this version does
 * not understand is how a tap lands on the wrong emergency.
 */
async function handleOurChoice(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  replyId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const [prefix, ...rest] = replyId.split(':');

  if (prefix === STAGE_BUTTON) {
    await applyStageFromButton(pool, config, phone, replyId, fetchImpl);
    return;
  }

  if (prefix === WHERE_BUTTON) {
    const [incidentId, attemptId] = rest;
    if (incidentId === undefined || attemptId === undefined) {
      log('info', 'a where-are-you button that means nothing here', { replyId });
      return;
    }
    await offerAvailability(pool, config, phone, incidentId, attemptId, fetchImpl);
    return;
  }

  if (prefix === AVAIL_ROW) {
    await chooseAvailability(pool, config, phone, replyId, fetchImpl);
    return;
  }

  if (prefix === RESP_ROW) {
    await chooseResponse(pool, config, phone, replyId, fetchImpl);
    return;
  }

  // `until` / `runtil` rows (the old "how long" list, ADR-0033) fall through here — a tap on
  // one sitting in an old message history is answered with the generic line below rather than
  // acted on.
  log('info', 'a choice this version does not recognise', { replyId });
}

/**
 * Ask what happened, before anything is resolved — Phase C.
 *
 * The mirror of `askWhoIsComing`, and deliberately not folded into it: the two ask different
 * questions, at different moments, about different things, and a shared "ask something" helper
 * would be one wording away from asking an officer who is coming when the district wanted to know
 * what happened.
 */
async function askWhatHappened(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) {
    log('info', 'not asking what happened: the service window is shut', { incidentId });
    return;
  }

  // Written before the send, for the reason `recordQuestion` gives: an officer can type faster
  // than a webhook round trip completes.
  const questionId = await recordQuestion(pool, {
    phone,
    incidentId,
    attemptId,
    asks: 'resolution',
  });

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      text:
        'Before this is closed — what happened? One line is enough.' +
        '\n\nReply here and it goes on the record.',
    },
    fetchImpl,
  );

  if (!result.ok) {
    log('warn', 'could not ask what happened', { incidentId, questionId, failure: result.failure });
  }
}

/**
 * Close the emergency with the officer's own sentence — Phase C.
 *
 * **The incident comes from the question, never from the number.** This is the sharpest place in
 * the whole file for that rule: `lastMessageTo` is a guess, stated as one in three places, and
 * **a guess must not resolve an emergency.** An officer told about two ten minutes apart, who
 * taps *Resolved* on the first and then types a sentence, would otherwise close the second — the
 * one nobody has been to yet.
 */
async function recordResolution(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  question: {
    readonly questionId: string;
    readonly incidentId: string;
    readonly attemptId: string;
  },
  outcome: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  // Claimed once, so a redelivered webhook cannot resolve the same emergency twice.
  if (!(await answerQuestion(pool, question.questionId, outcome))) return;

  const events = await loadIncident(pool, question.incidentId);
  if (events.length === 0) return;
  const state = foldIncident(question.incidentId, events);

  if (!stageIsStillAhead('resolved', state.status)) {
    await say(
      pool,
      config,
      phone,
      'Somebody resolved this while you were typing — nothing further is needed.',
      fetchImpl,
      question.incidentId,
    );
    return;
  }

  const attempt = state.notifications.find((a) => a.attemptId === question.attemptId);

  await appendStage(pool, {
    incidentId: question.incidentId,
    eventCount: state.eventCount,
    personId: attempt?.personId ?? null,
    seatId: attempt?.seatId ?? null,
    stage: 'resolved',
    said: outcome,
    from: 'WhatsApp',
  });

  await say(
    pool,
    config,
    phone,
    'Recorded as resolved. What you said has gone onto the record — thank you.',
    fetchImpl,
    question.incidentId,
  );
}

/**
 * One sentence back into the thread, and it is allowed to fail — Phase C.
 *
 * Every caller has **already written the record** by the time this runs. It exists so an officer
 * who tapped a button is not left looking at a message that appeared to do nothing — which is
 * what the acknowledge page's own title line does, and the reason M9-28 words it rather than
 * showing a failure.
 */
async function say(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  text: string,
  fetchImpl: typeof fetch,
  incidentId: string,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) return;
  const result = await sendSession(config, { toPhone: phone, text }, fetchImpl);
  if (!result.ok) {
    log('info', 'could not confirm in the thread', { incidentId, failure: result.failure });
  }
}

/**
 * Ask the officer who is coming in their place — Phase B.
 *
 * ## Why this is a plain message and not three more buttons
 *
 * The district needs a **person**, and a person is not a fixed vocabulary. Bajaur has forty
 * officers in the directory and a deputy may be somebody who holds no post at all; three buttons
 * would answer this question for three officers and mislead about the rest. So it is a sentence,
 * and the reply is the next thing they type — which `pendingQuestion` is what makes readable.
 *
 * ## The window, and why it is checked rather than assumed
 *
 * The tap that reached us **is** the thing that opened Meta's window, moments ago, so the check
 * below passes on the ordinary path. It is asked anyway because the ordinary path is the cheap
 * case: the expensive one is a webhook Meta retried an hour later, against a window that shut in
 * between, where the send is refused as a `131047` that nobody in a district office can read.
 *
 * ⚠️ **Nothing here fails the webhook.** Meta retries any non-2xx for hours, onto the machine
 * that is also taking emergency reports — and a retry would re-deliver the tap, not the
 * question. Every failure is logged and swallowed.
 */
async function askWhoIsComing(
  pool: Pool,
  config: WhatsAppConfig,
  phone: string,
  incidentId: string,
  attemptId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!(await sessionWindowOpen(pool, phone))) {
    // Nothing is broken and nothing is retried. The tap is recorded; the district simply does not
    // learn the name this time, which is exactly where it stood before this existed.
    log('info', 'not asking who is coming: the service window is shut', { incidentId });
    return;
  }

  /**
   * **Recorded before it is sent, never after** — the same ordering INV-03 rests on throughout
   * this system. An officer can type a name faster than a webhook round trip completes, and a
   * question recorded after its own send is one whose answer can arrive first and be read as an
   * ordinary reply. The cost is a row for a question that was never asked when the send then
   * fails; it expires unused in 24 hours, exactly as an ack token does.
   */
  const questionId = await recordQuestion(pool, {
    phone,
    incidentId,
    attemptId,
    asks: 'substitute',
  });

  const result = await sendSession(
    config,
    {
      toPhone: phone,
      /**
       * Their own words are quoted back, and that is not politeness.
       *
       * This arrives as a bare message in a thread that may already hold several of the
       * district's notices, seconds or minutes after the tap. Without the echo it is *"who is
       * coming?"* about nothing in particular, and the officer has to work out which meeting is
       * being asked about — the same failure as a link that opens a page not saying what it is
       * for.
       */
      text:
        `You tapped "${SUBSTITUTE_REPLY}". Who is coming in your place?` +
        '\n\nReply with their name and post, in one message.',
    },
    fetchImpl,
  );

  if (!result.ok) {
    /**
     * The question is **left standing** rather than withdrawn, and that is the honest direction.
     *
     * Meta refusing a send does not prove nothing arrived — a timeout is the ordinary case where
     * it did. Deleting the row would make an officer's reply, typed against a message they can see
     * in their own thread, land as an acknowledgement of something else. Left standing it expires
     * in 24 hours having cost nothing.
     */
    log('warn', 'could not ask who is coming', {
      incidentId,
      questionId,
      failure: result.failure,
    });
  }
}

/**
 * Record the name of the officer coming in somebody's place — Phase B.
 *
 * **On the incident the question was about, never on the most recent one.** Every other inbound
 * in this file is matched to an incident by the number it came from, which is an inference stated
 * as one in three places. This is not: the question carries the incident it was asked about, so
 * the substitute lands where it belongs even when the district has sent that officer three other
 * notices in between. It is the one reply in this system whose subject is actually known.
 */
async function recordSubstitute(
  pool: Pool,
  question: {
    readonly questionId: string;
    readonly incidentId: string;
    readonly attemptId: string;
  },
  name: string,
  at: string,
): Promise<void> {
  /**
   * Claimed **before** the event is written, in one statement, so a redelivered webhook cannot
   * append the same name twice — which would leave a meeting reading as though two people were
   * attending in one officer's place. Same shape as `redeemAckToken`, for the same reason.
   */
  if (!(await answerQuestion(pool, question.questionId, name))) return;

  const events = await loadIncident(pool, question.incidentId);
  if (events.length === 0) return;
  const state = foldIncident(question.incidentId, events);

  const attempt = state.notifications.find((a) => a.attemptId === question.attemptId);

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: question.incidentId,
      occurredAt: at,
      recordedAt: new Date().toISOString(),
      clientSeq: state.eventCount + 1,
      // The officer who was asked, not the officer named. Somebody sending a deputy is the person
      // making this statement, and the deputy has not spoken to this system at all.
      actorPersonId: attempt?.personId ?? null,
      actorSeatId: attempt?.seatId ?? null,
      sourceChannel: 'sms',
      type: 'action_logged',
      payload: {
        note:
          `Sending someone in their place: "${name}"` +
          "\n(answered on WhatsApp, to the district's own question — not inferred)",
      },
    } as unknown as IncidentEvent,
  ]);
}

//------------------------------------------------------------------------------
// The acknowledge tap — M6-22
//------------------------------------------------------------------------------

export interface AckResult {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  /**
   * What this officer may do next, each on its own freshly minted single-use token — M9-27.
   *
   * Empty is the ordinary case, not a failure: an emergency already resolved by a colleague
   * offers nothing further, and neither does a link that could not be spent.
   */
  readonly offers?: readonly { readonly stage: Stage; readonly token: string }[];
  /** A one-line box on the page, for the stage that needs a sentence before it is recorded. */
  readonly ask?: { readonly label: string; readonly hint: string } | undefined;
  /** Where the form posts. Present only when the page is asking for something. */
  readonly action?: string | undefined;
  /**
   * A separate single-use token for *"where are you?"* — M9-34.
   *
   * **Its own token, never the one that moves the emergency.** Two different acts: an officer
   * saying they are in the field has not responded to anything and certainly has not resolved
   * it. Sharing a token would make one tap do both, and the record could not tell them apart.
   */
  readonly availabilityToken?: string | undefined;
  /**
   * A single-use token for the district's own response options — their workflow, 2026-08-24.
   *
   * **Its own token for `availabilityToken`'s reason**, one step further on: choosing *"Not
   * Related to Me"* is not a claim to be dealing with anything, and a token that could do both
   * would leave the record unable to say which the officer meant.
   */
  readonly responseToken?: string | undefined;
  /** The options that token may record. Drawn at full length — a page has no 24-character cap. */
  readonly responseOptions?: readonly ResponseOption[] | undefined;
}

/**
 * Spend an acknowledge link.
 *
 * **This is what meets the obligation** (ADR-0014). One tap, from a message on somebody's own
 * handset, producing an attributable `acknowledged` event — for an officer who may hold no
 * account and may never sign in.
 *
 * Two things it is careful about, and both are about being honest at the point of failure.
 *
 * **A used link and an expired one say different things.** "You have already acknowledged this"
 * and "this link is too old" send an officer to two different next actions; a single "invalid"
 * sends them to the telephone to ask what happened, at 02:00.
 *
 * **It acknowledges the incident only if that is still a thing to do.** A link tapped after
 * somebody else acknowledged is not an error and must not read like one — the obligation is
 * still settled, because the officer demonstrably saw the message.
 */
export async function redeemAck(pool: Pool, token: string): Promise<AckResult> {
  const redeemed = await redeemAckToken(pool, token);

  if (!redeemed.ok) {
    if (redeemed.why === 'used') {
      return {
        status: 200,
        title: 'Already acknowledged',
        detail: 'This alert was acknowledged from this link before. Nothing further is needed.',
      };
    }
    if (redeemed.why === 'expired') {
      return {
        status: 410,
        title: 'This link is too old',
        detail:
          'Acknowledge links last 24 hours. The emergency it was about has moved on — open the ' +
          'app, or ring the control room.',
      };
    }
    return {
      status: 404,
      title: 'This link is not recognised',
      detail: 'It may have been mistyped. Open the app, or ring the control room.',
    };
  }

  /**
   * A token minted for a later stage must not acknowledge — M9-27.
   *
   * `/ack/:token` is one route and now carries three kinds of token, because the URL prefix is
   * baked into an approved Meta template and cannot grow a second one. The stage on the token is
   * what tells them apart, and it is checked **here**, not on the page: a respond token arriving
   * at the acknowledge path is a request to do something the token does not authorise, and it is
   * refused rather than quietly treated as the nearest thing.
   */
  if ((redeemed.subject.stage ?? 'acknowledge') !== 'acknowledge') {
    return {
      status: 405,
      title: 'That link needs to be opened, not followed',
      detail:
        'This is a link for recording progress, and it asks you to confirm first. Open it again ' +
        'from the page it came from, or ring the control room.',
    };
  }

  /**
   * The tap acknowledges for **whoever the control room chose**, post or no post — the owner's
   * reversal of 2026-08-17, and the sentence this page carried for a few hours went with it.
   *
   * That sentence warned a post-less officer that the emergency was *still waiting to be taken
   * up*, which was honest about the refusal it described and is now simply untrue: there is no
   * longer a case where somebody taps, is told the control room can see it, and the emergency
   * stays unanswered because of who they are.
   *
   * The remaining `false` cases — already acknowledged, already resolved — keep the plain
   * sentence, because in both a colleague genuinely has it and this officer's obligation is
   * genuinely settled. Neither needs a warning.
   */
  await acknowledgeFrom(pool, redeemed.subject);

  return {
    status: 200,
    title: 'Acknowledged',
    /**
     * ⚠️ **The district's thank-you is NOT on this line**, and that is the same decision the
     * thread makes. Their closing sentence thanks the officer for their **response**, which comes
     * after the options below; saying it here would spend it on the wrong act and leave nothing
     * to say when they actually answer.
     */
    detail: 'The control room can see that you have this. Kindly tell them what you are doing.',
    offers: await mintOffers(pool, redeemed.subject),
    availabilityToken: await mintAvailability(pool, redeemed.subject),
    ...offered(await mintResponse(pool, redeemed.subject)),
  };
}

/**
 * Spread a response offer onto an `AckResult`, or spread nothing.
 *
 * Written as one helper rather than two fields set by hand at each call site, because setting one
 * and forgetting the other is **exactly** the defect this pair caused on 2026-08-24 — a page with
 * a token and no options draws no form and says nothing about why.
 */
function offered(
  offer: { token: string; options: readonly ResponseOption[] } | undefined,
): Pick<AckResult, 'responseToken' | 'responseOptions'> {
  return offer === undefined ? {} : { responseToken: offer.token, responseOptions: offer.options };
}

/**
 * **A token for the district's response options, on the page** — their workflow, 2026-08-24.
 *
 * 🔴 **The page is the ONLY road for two of this district's templates**, and that is the whole
 * reason this exists. `district_message_img_v2` (anything with a photograph) and
 * `district_message_v3` (schedules, plain information, a cancelled meeting) carry a **link and no
 * quick reply** — so tapping one sends WhatsApp nothing, no service window opens, and the district
 * cannot put a single further message in front of that officer. For those messages the page is the
 * workflow or there is no workflow.
 *
 * ⚠️ **Minted for anybody the control room chose, post or none.** `mintAvailability` refuses a
 * post-less officer because presence is recorded against a **seat** and there would be nowhere for
 * the answer to go. Nothing here needs a seat: the answer lands on the **obligation**, which the
 * control room created for this person by name. Refusing them would silence exactly the officers
 * M0-51 is about — the ones who hold no account and never sign in.
 *
 * Returns undefined when the message has no list at all, which today means a meeting: its three
 * answers are approved at Meta and attendance owns that conversation.
 *
 * 🔴 **It returns the token AND the options together, and that pairing is the whole bug of
 * 2026-08-24.** The first version handed back only a token, so `redeemAck` set `responseToken`
 * and left `responseOptions` undefined — and `ackPage` draws the form only when it has **both**.
 * The result was an acknowledgement page in Bajaur with **no options on it at all**: the officer
 * whose message carried a photograph, for whom this page is the only road, acknowledged and was
 * offered nothing. It shipped, and `__tests__/responsePage.test.ts` caught it on its first run.
 *
 * ⚠️ **Two callers, one function, because they were two callers and two half-answers.** A token
 * without its options draws nothing; options without a token have nowhere to post.
 */
async function mintResponse(
  pool: Pool,
  subject: AckSubject,
): Promise<{ token: string; options: readonly ResponseOption[] } | undefined> {
  const events = await loadIncident(pool, subject.incidentId);
  if (events.length === 0) return undefined;
  const state = foldIncident(subject.incidentId, events);

  const list = listFor(state.kind, state.category?.value ?? null);
  if (list === null) return undefined;

  const token = await mintAckToken(pool, {
    attemptId: subject.attemptId,
    incidentId: subject.incidentId,
    seatId: subject.seatId,
    personId: subject.personId,
    stage: 'response',
  });

  return { token, options: optionsOf(list) };
}

/** Draw the options without spending anything. Same GET/POST split as the stages. */
export async function viewResponse(pool: Pool, token: string): Promise<AckResult> {
  const peeked = await peekAckToken(pool, token);
  if (!peeked.ok) return refusal(peeked.why);

  const events = await loadIncident(pool, peeked.subject.incidentId);
  if (events.length === 0) {
    return { status: 404, title: 'This link is not recognised', detail: 'Ring the control room.' };
  }
  const state = foldIncident(peeked.subject.incidentId, events);
  const list = listFor(state.kind, state.category?.value ?? null);

  if (list === null) {
    return {
      status: 404,
      title: 'This link is not recognised',
      detail: 'Open the app, or ring the control room.',
    };
  }

  return {
    status: 200,
    title: listTitle(list),
    detail: 'Kindly select one. The control room sees this straight away.',
    action: `/ack/${token}`,
    responseToken: token,
    responseOptions: optionsOf(list),
  };
}

/**
 * One of the district's options, chosen on the page — their workflow, 2026-08-24.
 *
 * ## Why this is ONE form and not the handset's three steps
 *
 * Their document branches — an option, then a sub-option, then a reason — because that is what a
 * handset needs: a WhatsApp list carries one question at a time. A page does not have that
 * constraint, and reproducing it here would cost an officer on one bar of signal **three round
 * trips** to say they are on leave. So the three sub-options are drawn nested under *Unable to
 * Respond* and the reason box sits below them, all in one form, all in one POST. The information
 * the district asked for is identical; only the number of taps differs.
 *
 * ⚠️ **And the page shows their sentences at full length.** Meta's 24-character row title is what
 * forced a short headline into the thread; nothing here is short, so the option an officer reads
 * is the option the district wrote.
 *
 * ## What is written
 *
 * The same three things `chooseResponse` writes, through the same functions, because the two paths
 * must not produce different records for one act — `appendStage`'s rule, applied to the workflow.
 */
export async function applyResponse(
  pool: Pool,
  token: string,
  optionId: string | null,
  said: string | null,
): Promise<AckResult> {
  const option = optionId === null ? null : optionById(optionId);

  /**
   * Asked for **before** the token is spent, exactly as a resolution is. Spending first would burn
   * the link on an officer who submitted without choosing, and leave them with nothing but the
   * control room's telephone number.
   */
  if (option === null) {
    const page = await viewResponse(pool, token);
    return page.status === 200 ? { ...page, detail: 'Choose one of these first.' } : page;
  }

  /**
   * ⚠️ **A reason is required and a message is not, and that is the district's own distinction.**
   * Their document says the recipient *"shall be **required** to provide a brief reason"* under
   * *Otherwise Unavailable*, and merely *"may enter a brief message"* under the three asking for
   * information. Asked again rather than recorded empty — and again, before anything is spent.
   */
  if (option.asks === 'reason' && (said === null || said.trim() === '')) {
    const page = await viewResponse(pool, token);
    return page.status === 200
      ? { ...page, detail: 'Please briefly state the reason before recording it.' }
      : page;
  }

  const redeemed = await redeemAckToken(pool, token);
  if (!redeemed.ok) return refusal(redeemed.why);

  await recordWhatTheySaid(pool, redeemed.subject.incidentId, redeemed.subject.attemptId, {
    via: 'link',
    said: option.wording,
  });

  if (option.records === 'responded' || option.records === 'resolved') {
    await applyResponseStage(pool, option, redeemed.subject.incidentId, redeemed.subject.attemptId);
  }

  /**
   * Their own words, when they gave any — a reason, a request for information, or the name of the
   * representative they are sending. Written as an `action_logged` so the district can answer
   * *"what did they actually say"* six weeks later, and saying in the note which question it
   * answers so the record is never ambiguous about what was claimed.
   */
  const words = said === null ? '' : said.trim().slice(0, 2000);
  if (words !== '' && option.asks !== 'nothing' && option.asks !== 'branch') {
    await noteTheirWords(pool, redeemed.subject, option, words);
  }

  return {
    status: 200,
    title: 'Recorded',
    detail: `${option.wording}. ${RESPONSE_THANKS}`,
  };
}

/**
 * Their sentence onto the emergency, from the page.
 *
 * The thread's twin is `recordInTheirWords`, and the two are deliberately not one function: that
 * one owns a **question row** it must claim before writing, so a redelivered webhook cannot append
 * the same sentence twice. A form POST has no such row and no such hazard — the token is
 * single-use and has already been spent by the time this runs, which is the same protection
 * arriving by a different route.
 */
async function noteTheirWords(
  pool: Pool,
  subject: AckSubject,
  option: ResponseOption,
  words: string,
): Promise<void> {
  const events = await loadIncident(pool, subject.incidentId);
  if (events.length === 0) return;
  const state = foldIncident(subject.incidentId, events);

  const note =
    option.asks === 'reason'
      ? `Unable to respond — the reason given: "${words}"`
      : option.asks === 'name'
        ? `Sending someone in their place: "${words}"`
        : `Further information requested: "${words}"`;

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: subject.incidentId,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      clientSeq: state.eventCount + 1,
      // From the token, never the roster as it stands now — ADR-0004, the same rule every other
      // act on this page follows.
      actorPersonId: subject.personId,
      actorSeatId: subject.seatId,
      sourceChannel: 'web',
      type: 'action_logged',
      payload: { note: `${note}\n(recorded from the alert link)` },
    } as unknown as IncidentEvent,
  ]);
}

/**
 * A token for *"where are you?"* — M9-34.
 *
 * Only for an officer who holds a post. Availability is recorded against a **seat** as well as a
 * person (`presence_report`), so a named officer with no duty has nowhere for the answer to go —
 * and a form that accepted it and dropped it would be worse than no form.
 */
async function mintAvailability(pool: Pool, subject: AckSubject): Promise<string | undefined> {
  if (subject.seatId === null) return undefined;
  return mintAckToken(pool, {
    attemptId: subject.attemptId,
    incidentId: subject.incidentId,
    seatId: subject.seatId,
    personId: subject.personId,
    stage: 'availability',
  });
}

/**
 * Mint the next stages this officer may record — M9-27.
 *
 * **Bound to the same person and seat, from the token just spent** — never resolved afresh. The
 * officer who tapped acknowledge is who these are for; looking the post up again would hand the
 * next two acts to whoever holds it at this later moment, which is exactly what ADR-0004 and
 * `mintAckToken`'s own comment refuse for acknowledgement.
 *
 * What is offered comes from the incident's **current** status, so an emergency a colleague has
 * already resolved offers nothing and the page simply does not draw buttons. That is the honest
 * shape: there is no such thing here as a control that is present and refuses.
 */
async function mintOffers(
  pool: Pool,
  subject: AckSubject,
): Promise<readonly { stage: Stage; token: string }[]> {
  // No post, no progress to record. A named officer with no duty has genuinely read the message
  // — the ledger says so — but `responding` and `resolved` are acts of a post (ADR-0004).
  if (subject.seatId === null) return [];

  const events = await loadIncident(pool, subject.incidentId);
  if (events.length === 0) return [];
  const state = foldIncident(subject.incidentId, events);

  const offers: { stage: Stage; token: string }[] = [];
  for (const stage of stagesOfferedFrom(state.status)) {
    const token = await mintAckToken(pool, {
      attemptId: subject.attemptId,
      incidentId: subject.incidentId,
      seatId: subject.seatId,
      personId: subject.personId,
      stage: stage === 'responded' ? 'respond' : 'resolve',
    });
    offers.push({ stage, token });
  }
  return offers;
}

/**
 * The two answers, in the words an officer reads on a handset — ADR-0033.
 *
 * Not `presenceLabel`'s words, though they now agree: this is a pair of buttons somebody is
 * about to press about themselves, in the present tense.
 */
const PRESENCE_WORDS: Readonly<Record<PresenceStatus, string>> = {
  available: 'Available',
  unavailable: 'Unavailable',
};

const STAGE_OF_TOKEN: Readonly<Record<AckStage, Stage | null>> = {
  acknowledge: null,
  respond: 'responded',
  resolve: 'resolved',
  // Not a lifecycle stage at all. It moves no emergency; it says where a person is.
  availability: null,
  /**
   * Also not a lifecycle stage. It authorises **one act** — choosing one of the district's
   * options — and what that then implies about the emergency is `responseOptions.ts`'s answer,
   * per option, applied by `applyResponse`.
   */
  response: null,
};

/**
 * Record where an officer is, on a token this system minted — M9-34.
 *
 * **This is the whole reason availability can be updated without a login.** The officer tapped a
 * link that only they received, seconds ago; the token carries the person and the seat captured
 * when it was minted. Nothing here reads a phone number, and that is deliberate — this codebase
 * refuses to identify anybody by phone number because two officers in Bajaur share one
 * (migration 0006, Q-19), and an availability update is exactly the kind of quiet write that a
 * spoofed sender would use.
 *
 * ADR-0033: two states, no end to ask for. `until` is still accepted on the wire — an old form
 * in flight may still send it — and ignored.
 */
export async function applyAvailability(
  pool: Pool,
  token: string,
  status: string | null,
  _until: string | null,
): Promise<AckResult> {
  const peeked = await peekAckToken(pool, token);
  if (!peeked.ok) return refusal(peeked.why);
  if ((peeked.subject.stage ?? 'acknowledge') !== 'availability') {
    return {
      status: 405,
      title: 'That link is not for this',
      detail: 'Open it again from the message, or ring the control room.',
    };
  }

  const seatId = peeked.subject.seatId;
  if (seatId === null) {
    return {
      status: 409,
      title: 'You hold no post right now',
      detail:
        'Where you are is recorded against a duty post, and you are not on one. The control ' +
        'room can record it for you.',
    };
  }

  /**
   * The refusal happens **before** the token is spent, for the reason test 7 of the lifecycle
   * suite established: burning an officer's one link on a bad value leaves them with nothing
   * but the control room's telephone number.
   */
  if (status === null || !(PRESENCE_STATUSES as readonly string[]).includes(status)) {
    return {
      ...(await viewAvailability(pool, token)),
      detail: 'Choose Available or Unavailable first.',
    };
  }

  const spent = await redeemAckToken(pool, token);
  if (!spent.ok) return refusal(spent.why);

  await reportPresence(pool, {
    seatId,
    status: status as PresenceStatus,
    note: null,
    // Who typed it and who it is about are the same person here, and that is worth recording
    // rather than assuming: it is the difference between an officer's own word and a clerk's.
    reportedBy: spent.subject.seatId,
    personId: spent.subject.personId,
  });

  return {
    status: 200,
    title: 'Thank you',
    detail: 'The district knows where you are.',
  };
}

/** Draw the availability form without spending anything. Same GET/POST split as the stages. */
export async function viewAvailability(pool: Pool, token: string): Promise<AckResult> {
  const peeked = await peekAckToken(pool, token);
  if (!peeked.ok) return refusal(peeked.why);

  return {
    status: 200,
    title: 'Where are you?',
    detail: 'This tells the control room whether they can send you somewhere. Nothing else.',
    action: `/ack/${token}`,
    availabilityToken: token,
  };
}

/**
 * Draw the page for a progress link, **without spending it** — M9-27, M9-28.
 *
 * A GET that changed the record would be wrong here for a reason particular to this channel:
 * WhatsApp fetches URLs to build link previews, so the act would be performed by a crawler
 * before any human saw it. The acknowledge link cannot be protected this way — it is a URL
 * button in an approved template and can only ever be a GET — but everything minted by *this*
 * system's own page can be, and is.
 *
 * It also lets the officer see which emergency they are about to mark, which is the difference
 * between recording progress and hoping.
 */
export async function viewStage(pool: Pool, token: string): Promise<AckResult> {
  const peeked = await peekAckToken(pool, token);
  if (!peeked.ok) return refusal(peeked.why);

  const stage = STAGE_OF_TOKEN[peeked.subject.stage ?? 'acknowledge'];
  if (stage === null) {
    return {
      status: 404,
      title: 'This link is not recognised',
      detail: 'Open the app, or ring the control room.',
    };
  }

  const events = await loadIncident(pool, peeked.subject.incidentId);
  if (events.length === 0) {
    return { status: 404, title: 'This link is not recognised', detail: 'Ring the control room.' };
  }
  const state = foldIncident(peeked.subject.incidentId, events);

  /**
   * **Already there is not an error, and must not read like one — M9-28.**
   *
   * A colleague resolved it first, or the officer logged an action in the app between the page
   * being drawn and this tap. Nothing has gone wrong and there is nothing for them to fix; the
   * only useful thing to say is that the district already knows.
   */
  if (!stageIsStillAhead(stage, state.status)) {
    return {
      status: 200,
      title: `Already recorded as ${stageLabel(stage).toLowerCase()}`,
      detail:
        'Somebody has already recorded this — you, from the app, or a colleague. Nothing ' +
        'further is needed.',
    };
  }

  return {
    status: 200,
    title: stage === 'responded' ? 'Mark this as responded?' : 'Mark this as resolved?',
    detail:
      stage === 'responded'
        ? 'This tells the control room that you are dealing with it. The emergency stays open.'
        : 'This records how it ended. Say what happened, in one line — it is what the district ' +
          'reads back afterwards.',
    action: `/ack/${token}`,
    ask:
      stage === 'resolved'
        ? {
            label: 'What happened?',
            hint: 'e.g. fire out, two taken to DHQ, crew stood down',
          }
        : undefined,
  };
}

/**
 * Spend a progress link and write what it authorises — M9-27, M9-28.
 *
 * `responding` is not a status anything sets directly, and that is deliberate in the fold: it
 * falls out of somebody having **done** something. So this writes what actually happened — an
 * action, in the officer's name — and the status follows from it. Inventing a `responding` event
 * to set the status would be a stage that can be claimed without an act.
 */
export async function applyStage(
  pool: Pool,
  token: string,
  said: string | null,
): Promise<AckResult> {
  const peeked = await peekAckToken(pool, token);
  if (peeked.ok) {
    const stage = STAGE_OF_TOKEN[peeked.subject.stage ?? 'acknowledge'];

    /**
     * **An acknowledge token is refused here without being spent** — found by test 9.
     *
     * This used to fall through to `redeemAckToken`, discover the stage afterwards and answer
     * 404. The 404 was the small half of the problem: the token was **already spent by then**,
     * so a POST to an acknowledge link — a crawler, a retry, anything that is not the template's
     * own GET — would silently destroy the officer's one acknowledge link. They would tap it,
     * see "already acknowledged", and the district would have no acknowledgement at all.
     *
     * Every refusal below the redemption line has the same hazard, which is why the stage is
     * settled up here where nothing has been consumed yet.
     */
    if (stage === null) {
      return {
        status: 405,
        title: 'That link is for acknowledging',
        detail: 'Open it from the message rather than from here.',
      };
    }

    /**
     * Asked for **before** the token is spent, so a resolution submitted with an empty box can
     * be asked for again. Spending first would burn the link on the officer's own typo and
     * leave them with nothing but the control room's telephone number.
     */
    if (stage === 'resolved' && (said === null || said.trim() === '')) {
      const page = await viewStage(pool, token);
      return { ...page, detail: 'Say what happened first — one line is enough.' };
    }
  }

  const redeemed = await redeemAckToken(pool, token);
  if (!redeemed.ok) return refusal(redeemed.why);

  const stage = STAGE_OF_TOKEN[redeemed.subject.stage ?? 'acknowledge'];
  if (stage === null) {
    return {
      status: 404,
      title: 'This link is not recognised',
      detail: 'Open the app, or ring the control room.',
    };
  }

  const events = await loadIncident(pool, redeemed.subject.incidentId);
  if (events.length === 0) {
    return { status: 404, title: 'This link is not recognised', detail: 'Ring the control room.' };
  }
  const state = foldIncident(redeemed.subject.incidentId, events);

  // Checked again after spending, because the record can move between the page and the submit.
  if (!stageIsStillAhead(stage, state.status)) {
    return {
      status: 200,
      title: `Already recorded as ${stageLabel(stage).toLowerCase()}`,
      detail: 'Somebody recorded this while you were on this page. Nothing further is needed.',
    };
  }

  await appendStage(pool, {
    incidentId: redeemed.subject.incidentId,
    eventCount: state.eventCount,
    // From the token, not from the roster as it stands now. Same rule as acknowledgement.
    personId: redeemed.subject.personId,
    seatId: redeemed.subject.seatId,
    stage,
    said,
    from: 'the alert link',
  });

  return stage === 'responded'
    ? {
        status: 200,
        title: 'Recorded as responded',
        detail: 'The control room can see you are dealing with it. Thank you.',
        offers: await mintOffers(pool, redeemed.subject),
        availabilityToken: await mintAvailability(pool, redeemed.subject),
      }
    : {
        status: 200,
        title: 'Recorded as resolved',
        detail: 'What you said has gone onto the record. Thank you.',
      };
}

/**
 * Write the event that moves an incident to a stage — extracted 2026-08-20, Phase C.
 *
 * **One rule, two doors.** The lifecycle is reachable from the page an acknowledge link opens
 * (M9-27) and, since Phase C, from **buttons inside WhatsApp** — and the two must not write
 * different records for the same act. Written twice they drift, and the drift is invisible: both
 * paths would go on working while the district's report started distinguishing officers by which
 * route their handset happened to take.
 *
 * ⚠️ **`responding` is not a status anything assigns, and this is where that shows.** A response
 * is an **action**, and the fold moves the incident itself — which is the honest definition and
 * the reason `stages.ts` says a stage that could be claimed without an act would be a button
 * saying work is happening. A resolution *is* its own event, because it carries an outcome.
 *
 * ⚠️ **The actor is passed in and never resolved here.** The link path froze the person and seat
 * at mint time (ADR-0004: a handover between the message going out and the tap arriving must not
 * reattribute the act) and the WhatsApp path takes them from the obligation the message answered.
 * Looking either up now would be that same bug through a third door.
 */
async function appendStage(
  pool: Pool,
  what: {
    readonly incidentId: string;
    readonly eventCount: number;
    readonly personId: string | null;
    readonly seatId: string | null;
    readonly stage: Stage;
    readonly said: string | null;
    /** How the officer did it, for the sentence written when they said nothing themselves. */
    readonly from: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const note =
    what.said === null || what.said.trim() === '' ? null : what.said.trim().slice(0, 2000);

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: what.incidentId,
      occurredAt: now,
      recordedAt: now,
      clientSeq: what.eventCount + 1,
      actorPersonId: what.personId,
      actorSeatId: what.seatId,
      // The same channel an acknowledge tap records, because it is the same act: something the
      // officer did from a message on a handset. It is what lets a report tell that apart from
      // progress typed into the app by the control room.
      sourceChannel: 'sms',
      ...(what.stage === 'responded'
        ? {
            type: 'action_logged',
            payload: {
              note: note ?? `Responding — recorded by the officer from ${what.from}.`,
            },
          }
        : {
            type: 'resolved',
            payload: { outcome: note ?? `Resolved from ${what.from}.` },
          }),
    } as unknown as IncidentEvent,
  ]);
}

/** The three ways a token can fail, in the three sentences they need. Shared by every stage. */
function refusal(why: 'used' | 'expired' | 'unknown'): AckResult {
  if (why === 'used') {
    return {
      status: 200,
      title: 'Already recorded',
      detail: 'This link has been used once already. Nothing further is needed.',
    };
  }
  if (why === 'expired') {
    return {
      status: 410,
      title: 'This link is too old',
      detail:
        'These links last 24 hours. Open the app if you have an account, or ring the control ' +
        'room — they can record it for you.',
    };
  }
  return {
    status: 404,
    title: 'This link is not recognised',
    detail: 'It may have been mistyped. Open the app, or ring the control room.',
  };
}

/**
 * Stop the incident's clock, if that is still a thing to do — the one place it happens.
 *
 * **Written once because it is asked from three doors and they must not disagree**: the
 * acknowledge tap, a reply on WhatsApp, and the control room recording a telephone call
 * (`api/acknowledgement.ts`, which keeps its own copy of the same three conditions and says so).
 * Returns whether an `acknowledged` event was actually appended, so a caller can tell an officer
 * the truth about what just happened rather than a sentence that is right most of the time.
 *
 * The three refusals are unchanged and each says a different thing:
 *
 *   * **already acknowledged** — a colleague got there first. Not an error, and it must not read
 *     like one; a second event would move `acknowledgedAt` and give an emergency taken at 02:04
 *     an acknowledgement time of 02:31.
 *   * **resolved or closed** — the emergency has moved past this.
 *   * **nobody at all** — neither a seat nor a person. An acknowledgement attributed to nobody
 *     says only that *something happened*, which is not what this event means.
 *
 * ⚠️ **Holding no post is NOT a refusal any more — the owner reversed that on 2026-08-17**, and
 * the reversal is right. It used to refuse a post-less officer, reasoning from ADR-0004 that the
 * clock stops because a **duty** took the emergency. But **the control room chose that officer**,
 * by name, on purpose. Software answering *"they hold no post, so this does not count"* overrules
 * an operational decision the district made deliberately — and it left the district's own record
 * unable to say that somebody it had assigned work to had answered. The owner's words:
 * *"control room se jin ko bhi assignment milti hai wo sab official hain, record hona, acknowledge
 * hona sab lazmi hai."* `seatId` is still written when there is one, so *which post took it* is
 * not lost where it exists; `personId` carries it where there is none, which is exactly what the
 * event's own schema has always allowed.
 *
 * ⚠️ **What that costs, stated rather than buried:** an acknowledgement stops the clock and stops
 * escalation, so if a post-less officer acknowledges and then does nothing, no software is chasing
 * it. That is **not a new class of risk** — the same is true of a post-holder who acknowledges and
 * goes quiet — it is a wider one, and the district widened it knowingly.
 *
 * ⚠️ **It re-folds rather than trusting a state the caller already has, and that is not tidiness.**
 * Both callers append something first — the obligation settlement, or the reply's own note — so a
 * `clientSeq` computed from their earlier fold would collide with the event they have just
 * written, and ADR-0008 is what a colliding sequence costs.
 */
async function appendAcknowledgement(
  pool: Pool,
  what: {
    readonly incidentId: string;
    readonly seatId: string | null;
    readonly personId: string | null;
    readonly route: 'link' | 'reply';
    readonly said?: string;
    readonly sourceChannel: string;
  },
): Promise<boolean> {
  const events = await loadIncident(pool, what.incidentId);
  if (events.length === 0) return false;

  const state = foldIncident(what.incidentId, events);

  if (state.acknowledgedAt !== null) return false;
  if (state.status === 'closed' || state.status === 'resolved') return false;
  // Somebody has to be named. A seat, a person, or both — but not neither.
  if (what.seatId === null && what.personId === null) return false;

  const now = new Date().toISOString();

  await append(pool, [
    {
      eventId: randomUUID(),
      incidentId: what.incidentId,
      occurredAt: now,
      recordedAt: now,
      clientSeq: state.eventCount + 1,
      actorPersonId: what.personId,
      actorSeatId: what.seatId,
      sourceChannel: what.sourceChannel,
      type: 'acknowledged',
      payload: {
        seatId: what.seatId,
        ...(what.personId === null ? {} : { personId: what.personId }),
        route: what.route,
        ...(what.said === undefined ? {} : { said: what.said }),
      },
    } as unknown as IncidentEvent,
  ]);

  return true;
}

/** Whether the tap actually stopped the clock — see `appendAcknowledgement`. */
async function acknowledgeFrom(pool: Pool, subject: AckSubject): Promise<boolean> {
  const events = await loadIncident(pool, subject.incidentId);
  if (events.length === 0) return false;

  /**
   * The obligation is settled **whether or not the incident gets an `acknowledged` event.**
   *
   * These are two different facts and conflating them was tempting. *Somebody read the message*
   * is true the moment the link is tapped, always. *The incident is acknowledged* can only
   * happen once, and may already have — by this officer in the app, or by a colleague a minute
   * earlier. The second failing must not swallow the first, or an officer who answered would
   * still show on the board as somebody nobody reached.
   */
  await markObligationMet(
    pool,
    subject.incidentId,
    subject.attemptId,
    { personId: subject.personId, seatId: subject.seatId },
    { via: 'link' },
  );

  /**
   * The seat comes off the **token**, resolved when the link was minted — never looked up now.
   * A handover between the message going out and the tap arriving must not attribute this to
   * whoever holds the post at this later moment (ADR-0004). `whatsappChannel.ts` is where a
   * named officer's post is resolved into it.
   */
  return appendAcknowledgement(pool, {
    incidentId: subject.incidentId,
    seatId: subject.seatId,
    personId: subject.personId,
    route: 'link',
    sourceChannel: 'sms',
  });
}

/**
 * The page an officer sees after tapping.
 *
 * Deliberately a complete, self-contained page with no script and no fetch. It opens inside
 * WhatsApp's in-app browser, on a handset, quite possibly on one bar of signal — and the one
 * thing it must do is render. The app shell would be the wrong answer here: it needs a session
 * this officer may not have, and it is a great deal of JavaScript to say one sentence.
 */
/**
 * What an officer sees when a file link does not work — M9-18.
 *
 * Three causes, three sentences, and they are not merged. *"Too old"* means ask the control room
 * to resend; *"not recognised"* means the link was mistyped or truncated by whatever forwarded
 * it; *"the file is missing"* means the record is intact and the bytes are not, which is the
 * district's problem and not the officer's — and saying so plainly is the only way anybody finds
 * out. A single "invalid" for all three sends every one of them to the telephone at 02:00.
 *
 * Self-contained, no script, no fetch — the same reasoning as `ackPage`: it opens inside
 * WhatsApp's in-app browser, on a handset, quite possibly on one bar of signal, and the one
 * thing it must do is render.
 */
export function filePage(why: 'expired' | 'unknown' | 'missing'): string {
  const said = {
    expired: {
      title: 'This link is too old',
      detail:
        'File links last two weeks. Ask the control room to send it again, or open the app if ' +
        'you have an account.',
    },
    unknown: {
      title: 'This link is not recognised',
      detail:
        'It may have been cut short by whatever forwarded it — try opening it from the original ' +
        'message. If that fails, ring the control room.',
    },
    missing: {
      title: 'The file is not there',
      detail:
        'The district has a record of this file and cannot produce it. This is a fault at our ' +
        'end, not yours. Please tell the control room.',
    },
  }[why];

  return ackPage({ status: why === 'expired' ? 410 : 404, ...said });
}

/**
 * Which kinds open **in** the handset rather than downloading to it — 2026-08-14.
 *
 * The district's own words: *"link se attachment khul jaye, jaise acknowledged wala click kar ke
 * page open hota hai"*. A file that arrives as a save prompt is a file most officers never see —
 * they are standing somewhere, one-handed, in WhatsApp's own browser, and a download that lands
 * in a folder is a second errand nobody runs.
 *
 * **Only these two, and both are safe to render.** `evidence.content_type` holds what
 * `ops/fileType.ts` **sniffed**, never what the uploading device claimed, so this switch is on a
 * fact rather than on a header. A JPEG cannot execute; a PDF opens in the browser's own sandboxed
 * viewer, and the bytes are still served under `nosniff` with `default-src 'none'; sandbox`,
 * which is the same envelope the authenticated download has always used. Everything else —
 * video, audio, PNG and WebP included — keeps the old `attachment` behaviour, because
 * `COMMUNICATION_TYPES` means only these two can ever ride a message anyway (M9-16) and widening
 * a rule past the case that asked for it is how a rule stops being read.
 */
export const OPENS_IN_PLACE: ReadonlySet<string> = new Set(['image/jpeg', 'application/pdf']);

/**
 * The page a file link opens — 2026-08-14.
 *
 * **The link used to answer with the bytes and nothing else**, so an officer who tapped it got a
 * download prompt with a filename and no idea what it belonged to, or — on a handset that
 * refused the type — a blank screen. The district reported it as *"the attachment does not come
 * with the message"*, which is exactly what it looks like from the receiving end.
 *
 * So the link now opens a **page**, the way the acknowledge button does. An image is shown on it;
 * a PDF gets a button that opens it in the phone's own viewer. Both point at `/file/:token/raw`,
 * which is the one place the bytes ever leave.
 *
 * Self-contained, no script, no fetch — the same reasoning as `ackPage` and `filePage`.
 *
 * **The heading deliberately names the incident's subject when there is one.** An officer who
 * has been sent four notices this week and taps the wrong link must be able to tell — and the
 * subject is a line the district itself wrote into the message this file travelled with, so it
 * discloses nothing the recipient was not already sent.
 */
export function fileReadyPage(file: {
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly token: string;
  /** What the message said this was about. Null when the incident could not be read. */
  readonly about: string | null;
}): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const raw = `/file/${encodeURIComponent(file.token)}/raw`;
  const kb = Math.max(1, Math.round(file.byteSize / 1024));

  /**
   * The image is drawn on the page; everything else is a button.
   *
   * A PDF is deliberately **not** put in an `<iframe>`. An in-app browser on a mid-range Android
   * renders a PDF frame as a grey box roughly as often as it renders the document, and a grey
   * box is indistinguishable from the fault this whole change exists to remove.
   */
  const body =
    file.contentType === 'image/jpeg' ? `<img src="${raw}" alt="${escape(file.filename)}" />` : '';

  const verb = file.contentType === 'application/pdf' ? 'Open the document' : 'Open the file';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(file.filename)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #0f1115; color: #e8eaed; line-height: 1.5; }
  h1 { font-size: 1.2rem; margin: 0 0 0.6rem; }
  p { margin: 0; color: #b6bcc6; font-size: 0.9rem; }
  img { display: block; margin: 1.25rem 0; max-width: 100%; height: auto; border-radius: 10px; }
  /* 48px targets: this is tapped on a handset, at night, often one-handed. */
  .go { display: block; margin-top: 1.25rem; padding: 0.85rem 1rem; border-radius: 10px;
        background: #7958ff; color: #fff; text-decoration: none; font-weight: 700;
        text-align: center; min-height: 48px; box-sizing: border-box; }
</style>
</head><body>
<h1>${escape(file.about ?? 'A file from the district')}</h1>
<p>${escape(file.filename)} · ${String(kb)} KB</p>
${body}
<a class="go" href="${raw}">${verb}</a>
</body></html>`;
}

export function ackPage(result: AckResult): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /**
   * What the officer may record next — M9-27.
   *
   * Plain links, because a link is a GET and a GET here only **draws** the confirm page; nothing
   * is written until that page is submitted. So a WhatsApp preview crawler following one of
   * these changes nothing, and the officer sees which emergency they are about to mark.
   */
  const offers = (result.offers ?? [])
    .map(
      (o) =>
        `<a class="go" href="/ack/${encodeURIComponent(o.token)}">Mark as ${escape(
          stageLabel(o.stage).toLowerCase(),
        )}</a>`,
    )
    .join('');

  /**
   * The one box, and the button that spends the token.
   *
   * A form with `method="post"` and no JavaScript at all. This page opens inside WhatsApp's
   * in-app browser on a handset, quite possibly on one bar of signal, and the one thing it must
   * do is work — which is the same reasoning that keeps the app shell out of here.
   */
  /**
   * *Are you available?* — ADR-0033. Two radios, no time, no JavaScript.
   *
   * Radios rather than a dropdown, deliberately: this is tapped one-handed on a handset at
   * night, and a native select on Android is a modal an officer has to aim at twice. The
   * *until when* box and its `NEEDS_END` label are gone — nothing polls an officer, so there is
   * no end to state.
   */
  const availability =
    result.availabilityToken === undefined
      ? ''
      : `<form method="post" action="/ack/${encodeURIComponent(result.availabilityToken)}" ` +
        `class="avail"><h2>Are you available?</h2>` +
        PRESENCE_STATUSES.map(
          (s) =>
            `<label class="opt"><input type="radio" name="status" value="${s}" /> ` +
            `${escape(PRESENCE_WORDS[s])}</label>`,
        ).join('') +
        `<button type="submit">Tell the control room</button></form>`;

  /**
   * **The district's own options, at full length** — their workflow, 2026-08-24.
   *
   * ⚠️ **Their sentences are the labels here, not the handset's short headlines.** The 24-character
   * headline exists because Meta caps a list row's title; a page has no such cap, so an officer
   * reading this sees exactly what the Deputy Commissioner's office wrote.
   *
   * ## The branch is drawn open, and that is the page doing what a page is for
   *
   * In the thread *Unable to Respond* is a row that opens a second list, because a WhatsApp list
   * asks one question at a time. Here the three sit **nested under a heading**, in one form, in
   * one POST — so an officer on one bar of signal says *"on leave"* in one round trip instead of
   * three. The parent is a heading rather than a radio: choosing it alone would tell the district
   * only that somebody cannot come, which is the answer their own document asks them to refine.
   *
   * ## No JavaScript, radios rather than a select
   *
   * The availability form's reasoning exactly: this opens in WhatsApp's in-app browser, at night,
   * one-handed, possibly in a moving car. Every target is 48px and the whole thing is one POST.
   *
   * ⚠️ **No *until when* box — ADR-0033 removed it everywhere.** An officer who picks *on leave*
   * here is recorded `unavailable`; nothing polls them, so there is no end to state.
   */
  const response =
    result.responseToken === undefined || (result.responseOptions ?? []).length === 0
      ? ''
      : `<form method="post" action="/ack/${encodeURIComponent(result.responseToken)}" ` +
        `class="avail"><h2>What are you doing about it?</h2>` +
        (result.responseOptions ?? [])
          .map((o) =>
            o.asks === 'branch'
              ? `<p class="sub">${escape(o.wording)} —</p>` +
                UNABLE_BRANCH.map(
                  (u) =>
                    `<label class="opt in"><input type="radio" name="option" ` +
                    `value="${escape(u.id)}" /> ${escape(u.wording)}</label>`,
                ).join('')
              : `<label class="opt"><input type="radio" name="option" ` +
                `value="${escape(o.id)}" /> ${escape(o.wording)}</label>`,
          )
          .join('') +
        `<label for="rsaid">If you are otherwise unavailable, or need more information — ` +
        `say briefly</label>` +
        `<input id="rsaid" name="said" type="text" maxlength="2000" autocomplete="off" />` +
        `<button type="submit">Record it</button></form>`;

  const form =
    result.action === undefined ||
    result.availabilityToken !== undefined ||
    result.responseToken !== undefined
      ? ''
      : `<form method="post" action="${escape(result.action)}">` +
        (result.ask === undefined
          ? ''
          : `<label for="said">${escape(result.ask.label)}</label>` +
            `<input id="said" name="said" type="text" maxlength="2000" autocomplete="off" ` +
            `placeholder="${escape(result.ask.hint)}" />`) +
        `<button type="submit">Record it</button></form>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(result.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #0f1115; color: #e8eaed; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 0.6rem; }
  p { margin: 0; color: #b6bcc6; }
  .ok { color: #4ade80; }
  /* 48px targets throughout: this is tapped on a handset, at night, often one-handed. */
  form { margin: 1.5rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
  label { font-size: 0.9rem; color: #e8eaed; }
  input { font: inherit; min-height: 48px; padding: 0 0.75rem; border-radius: 10px;
          border: 1px solid #2a2f3a; background: #171a21; color: #e8eaed; }
  button { font: inherit; font-weight: 700; min-height: 48px; border: none; border-radius: 10px;
           background: #7958ff; color: #fff; cursor: pointer; }
  .go { display: block; margin-top: 0.75rem; padding: 0.85rem 1rem; border-radius: 10px;
        border: 1px solid #2a2f3a; color: #e8eaed; text-decoration: none; font-weight: 600; }
  .avail { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid #2a2f3a; }
  .avail h2 { font-size: 1rem; margin: 0 0 0.25rem; }
  /* 48px targets, one per line. This is tapped one-handed, at night, often in a moving car. */
  .opt { display: flex; align-items: center; gap: 0.6rem; min-height: 48px; cursor: pointer; }
  .opt input { width: 22px; height: 22px; }
  /* The district's own nesting, kept visible: a heading, then the three answers under it. */
  .sub { margin: 0.75rem 0 0; font-size: 0.85rem; color: #b6bcc6; }
  .opt.in { padding-left: 1rem; border-left: 2px solid #2a2f3a; }
</style>
</head><body>
<h1 class="${result.status === 200 ? 'ok' : ''}">${escape(result.title)}</h1>
<p>${escape(result.detail)}</p>
${form}
${offers}
${response}
${availability}
</body></html>`;
}
