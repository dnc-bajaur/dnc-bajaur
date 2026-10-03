/**
 * The software sends the message — ADR-0014, M6-18…M6-26.
 *
 * On one number the district is buying, through Meta's WhatsApp Cloud API, and **this is not
 * ADR-0012 returning.** That decision built a four-rung provider ladder — WhatsApp, a voice
 * provider, an SMS gateway, a GSM modem in the DC office — so that delivery would always
 * *succeed*. This builds **one** channel so that delivery is always *known*: who was told, when,
 * whether it arrived, and — the part that matters — whether they did anything about it.
 *
 * Three things carried over from the 3 August reversal, and none of them is reopened here:
 *
 *   * **"Reach them" stays exactly as it is.** On the night the API is down it is the entire
 *     system, and nothing in this file may become a reason to remove it.
 *   * **There is still no ladder.** No SMS gateway, no voice provider, no modem. A chain of
 *     providers fails in ways nobody sees — a template unapproved, a gateway out of credit —
 *     and every one of those is discovered on the night it matters.
 *   * **A read receipt is never the obligation being met.** An officer who has disabled read
 *     receipts never produces one, so a dashboard built on blue ticks manufactures invisible
 *     failures at exactly the rate officers value their privacy. `read` is carried because the
 *     district asked to see it, and it settles nothing. What meets the obligation is a
 *     deliberate act: the acknowledge tap (M6-22), an in-app acknowledgement, or a reply.
 *
 * ## What this file is, and is not
 *
 * It is the transport and nothing else: build a message, post it, read what came back, say
 * plainly what happened. It records no events and touches no ledger — `jobs/notify.ts` owns the
 * order of operations that INV-03 rests on, and a channel that decided for itself whether an
 * attempt was worth recording is exactly how a failure becomes invisible.
 *
 * **Nothing here throws for an ordinary failure.** Every path returns a reason, because "why
 * did this not arrive" is the question the control room asks at 02:00 and an exception message
 * is not an answer anybody can act on.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  ACTIVITY_RESPONSE_TEMPLATE,
  ALERT_TEMPLATE_IMAGE,
  ALERT_TEMPLATE,
  EMERGENCY_TEMPLATE,
  LOGIN_LINK_TEMPLATE,
  NOTICE_TEMPLATE,
  NOTICE_TEMPLATE_IMAGE,
  RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY,
  RESPONSE_TEMPLATE_BY_CATEGORY,
  responseImageTemplateFor,
  responseTemplateFor,
  shapeNamed,
} from './whatsappTemplate.js';

/** Meta's version-pinned base. Pinned deliberately: an API that moves under a district's one server is an outage nobody scheduled. */
const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConfig {
  /** The phone number id Meta assigns — not the number itself. */
  readonly phoneNumberId: string;
  /** A permanent system-user token. Never logged, never returned, never put in an event. */
  readonly accessToken: string;
  /** Shared with Meta, used to verify that a webhook is genuinely theirs (M6-20). */
  readonly appSecret: string;
  /** Echoed back during Meta's one-time subscription handshake. */
  readonly verifyToken: string;
  /**
   * The approved template's name and language.
   *
   * Defaulted from `ALERT_TEMPLATE`, which is **the one description of the message this district
   * sends** — the same definition `scripts/doctor.mjs` compares against what Meta actually
   * approved. A template is approved once and changed slowly (M6-26), and "what the code sends"
   * drifting from "what we asked Meta to approve" is a failure that surfaces at 02:00 on the
   * first real night, as a provider error nobody in a district office can read.
   *
   * Overridable because a district that has already approved something under a different name
   * should not have to resubmit to use this software.
   */
  readonly templateName: string;
  /** As approved. `en` and `en_US` are different templates to Meta, and mixing them 404s. */
  readonly templateLanguage: string;
  /** Overridden by tests. Never by configuration — one provider, no ladder. */
  readonly baseUrl?: string;
  /**
   * The template that carries a picture, when the district has one approved — M10-28.
   *
   * ⚠️ **This replaced a global `templateHasMediaHeader` boolean, and the reason is the whole
   * task.** That boolean said *"the template we send on has a media header"* — one value, for
   * every message. Turning it on would have put a header on **every** send, including the ones
   * with no file, and Meta refuses a message whose components do not match what it approved. The
   * first emergency of the day would have failed for the same reason as the meeting notice.
   *
   * Naming the image template instead makes that state unreachable rather than guarded. A header
   * is only ever built for **this** template, and this template is only ever chosen for a message
   * that actually carries a picture — so there is no configuration in which a body-only template
   * is sent a header. The dangerous combination cannot be expressed.
   *
   * Absent is the ordinary state and the one Bajaur is in today: a picture then travels the way a
   * PDF always will, as a single-use link in the body (M9-18).
   */
  readonly imageTemplate?: { readonly name: string; readonly language: string };
  /**
   * The sign-in link's template (ADR-0043), once Meta has approved it. Absent: no sign-in link is
   * sent by WhatsApp, and the DC is handed the link to send by hand instead.
   */
  readonly loginTemplate?: { readonly name: string; readonly language: string };
  /**
   * The Activities Respond template (ADR-0044 §6), once Meta has approved it. Absent: a Respond
   * goes only inside the 24-hour window, and outside it the DC office is told nothing was sent.
   */
  readonly activityTemplate?: { readonly name: string; readonly language: string };
  /**
   * The template whose buttons an officer can **tap to answer** — 2026-08-19.
   *
   * Named separately from `templateName` for the same reason `imageTemplate` is: these are facts
   * about *which approved template*, and each one carries button positions that only match itself.
   * `district_emergency_v2` puts its acknowledge link second, behind a quick reply; sending it
   * under the name of a template whose link is first is a message Meta refuses.
   *
   * Absent is the ordinary state and the one every installation is in until the district names it.
   * Everything then goes out exactly as it did before — one link, no quick replies.
   */
  readonly emergencyTemplate?: { readonly name: string; readonly language: string };
  /**
   * The meeting template, whose three quick replies are the only way to answer it — 2026-08-19.
   *
   * ⚠️ **It has no URL button**, so choosing it also means *not* sending an acknowledge parameter.
   * `templateFor` returns both halves of that decision together, exactly as it does for the
   * picture header, so no arrangement of `.env` can ask for a token on a template that has
   * nowhere to put one.
   */
  readonly noticeTemplate?: { readonly name: string; readonly language: string };
  /**
   * **The meeting template, WITH a picture on it** — 2026-09-04, the owner's own line.
   *
   * Every other picture-carrying template offers only `Acknowledge` / `Open details`, because
   * that is the one shape Meta has ever approved with a media header. The owner asked for
   * meetings (among five kinds) to keep their real question — `Attending` / `Not attending` /
   * `Sending someone` — **with the photograph riding in the message**, rather than trading it
   * for a file link the way every other kind still does.
   *
   * Named separately from `noticeTemplate` for the reason every template here is named
   * separately: it is a different approved shape, with its own name, and Meta refuses a send
   * naming the wrong one. Absent is the ordinary state — a meeting notice with a photograph then
   * sends the photograph as a file link, exactly as it does for every kind this pair is not set
   * for.
   */
  readonly noticeImageTemplate?: { readonly name: string; readonly language: string };
  /**
   * **Which emergency categories answer on their own `dnc_response_<category>` template** —
   * 2026-09-03, ADR-0034.
   *
   * The district approved one template per category (`RESPONSE_TEMPLATES` in
   * `whatsappTemplate.ts`), each carrying three category-specific quick replies and **no
   * *Acknowledge* button and no link**. When a category is in this set, an alert of that category
   * goes out on its template instead of `emergencyTemplate` / `templateName`, and the officer's
   * first tap **is** their response — there is no separate acknowledge step (`backlog/whatsapp-
   * response-workflow.md`).
   *
   * Read from the one `.env` line `WHATSAPP_RESPONSE_CATEGORIES` as a comma list. Absent or empty
   * is the ordinary state and the one every installation is in until the district names it —
   * everything then goes out exactly as it does today. Only categories whose template is
   * **approved `UTILITY`** should be listed; `npm run doctor` grades each one. Six of the twelve
   * were still `PENDING` at Meta when this was built, and stay off until the owner adds them.
   */
  readonly responseCategories?: ReadonlySet<string>;
  /**
   * **Which of those categories also answer WITH a picture in the message** — 2026-09-04, the
   * owner's own line: *"Ju Administration & directives, jis mai Advisory, Order, Meeting,
   * Schedule and Information hain just en k sath image template ki andar hi jana chaye hain …
   * baki categories ki sath beshak link mai image jaye agar attach ho."*
   *
   * A strict subset of `responseCategories` in effect — this is only ever consulted for a
   * category already answering on its own template — and of
   * {@link import('./whatsappTemplate.js').RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY}'s four keys
   * (`advisory`, `order`, `schedule`, `information`) in fact, since those are the only categories
   * the owner asked for and the only ones this source has a picture-carrying shape for. Read from
   * `WHATSAPP_RESPONSE_IMAGE_CATEGORIES` as a comma list, filtered the same way
   * `responseCategories` is. Absent or empty is the ordinary state: every category's photograph
   * travels as a file link, exactly as it did before this pair existed.
   */
  readonly responseImageCategories?: ReadonlySet<string>;
}

/**
 * Read the WhatsApp configuration, or say why there is none.
 *
 * Returns null rather than throwing when nothing is configured, because **nothing configured is
 * the normal state until the district's Meta account exists** (R-05, R-19, R-20). The system
 * runs without it: obligations are recorded, the in-app inbox works, and "Reach them" is there.
 * What must not happen is the district believing messages are going out when no account exists,
 * which is what the `condition` row is for (M6-25).
 */
export function whatsappFromEnv(
  env: Readonly<Partial<Record<string, string>>>,
): WhatsAppConfig | null {
  const phoneNumberId = env['WHATSAPP_PHONE_NUMBER_ID'];
  const accessToken = env['WHATSAPP_TOKEN'];
  const appSecret = env['WHATSAPP_APP_SECRET'];
  const verifyToken = env['WHATSAPP_VERIFY_TOKEN'];

  const set = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

  if (!set(phoneNumberId) || !set(accessToken) || !set(appSecret) || !set(verifyToken)) {
    return null;
  }

  return {
    phoneNumberId: phoneNumberId.trim(),
    accessToken: accessToken.trim(),
    appSecret: appSecret.trim(),
    verifyToken: verifyToken.trim(),
    templateName: env['WHATSAPP_TEMPLATE'] ?? ALERT_TEMPLATE.name,
    templateLanguage: env['WHATSAPP_TEMPLATE_LANG'] ?? ALERT_TEMPLATE.language,
    /**
     * Configured only when the district names it — M10-28, M10-31.
     *
     * A blank or absent value leaves the district exactly where it is: every message on the
     * body-only template, every file as a link. There is no half-configured state — a name
     * without a language falls back to the image template's own approved language rather than
     * borrowing the other template's, because two templates approved in different languages is
     * a 404 from Meta and not something to guess at.
     */
    ...(set(env['WHATSAPP_TEMPLATE_IMAGE'])
      ? {
          imageTemplate: {
            name: env['WHATSAPP_TEMPLATE_IMAGE'].trim(),
            language: env['WHATSAPP_TEMPLATE_IMAGE_LANG'] ?? ALERT_TEMPLATE_IMAGE.language,
          },
        }
      : {}),
    /**
     * The two tappable templates, each configured on its own and neither implying the other.
     *
     * A district may well have the emergency one approved and not the meeting one — they were
     * submitted together here, but approval is per template and Meta reviews them separately.
     * Two independent reads mean the half that is approved starts being used the day it is,
     * rather than waiting on the other.
     */
    ...(set(env['WHATSAPP_TEMPLATE_LOGIN'])
      ? {
          loginTemplate: {
            name: env['WHATSAPP_TEMPLATE_LOGIN'].trim(),
            language: env['WHATSAPP_TEMPLATE_LOGIN_LANG'] ?? LOGIN_LINK_TEMPLATE.language,
          },
        }
      : {}),
    ...(set(env['WHATSAPP_TEMPLATE_ACTIVITY'])
      ? {
          activityTemplate: {
            name: env['WHATSAPP_TEMPLATE_ACTIVITY'].trim(),
            language: env['WHATSAPP_TEMPLATE_ACTIVITY_LANG'] ?? ACTIVITY_RESPONSE_TEMPLATE.language,
          },
        }
      : {}),
    ...(set(env['WHATSAPP_TEMPLATE_EMERGENCY'])
      ? {
          emergencyTemplate: {
            name: env['WHATSAPP_TEMPLATE_EMERGENCY'].trim(),
            language: env['WHATSAPP_TEMPLATE_EMERGENCY_LANG'] ?? EMERGENCY_TEMPLATE.language,
          },
        }
      : {}),
    ...(set(env['WHATSAPP_TEMPLATE_NOTICE'])
      ? {
          noticeTemplate: {
            name: env['WHATSAPP_TEMPLATE_NOTICE'].trim(),
            language: env['WHATSAPP_TEMPLATE_NOTICE_LANG'] ?? NOTICE_TEMPLATE.language,
          },
        }
      : {}),
    /**
     * The meeting's picture-carrying template — 2026-09-04, independent of `noticeTemplate` for
     * the same reason `imageTemplate` is independent of `templateName`: a district may have one
     * approved and not the other, and Meta reviews each on its own schedule.
     */
    ...(set(env['WHATSAPP_TEMPLATE_NOTICE_IMAGE'])
      ? {
          noticeImageTemplate: {
            name: env['WHATSAPP_TEMPLATE_NOTICE_IMAGE'].trim(),
            language: env['WHATSAPP_TEMPLATE_NOTICE_IMAGE_LANG'] ?? NOTICE_TEMPLATE.language,
          },
        }
      : {}),
    /**
     * The per-category response templates the district has switched on — ADR-0034.
     *
     * One `.env` line, a comma list of category slugs. Trimmed, lowercased, and filtered to the
     * slugs this source actually has a `dnc_response_*` shape for — a typo names nothing rather
     * than 404ing Meta on a real night. Omitted entirely when the line is absent or lists nothing
     * usable, the same `set()` discipline as the optional templates above: absent means *send
     * exactly as before*.
     */
    ...(() => {
      const raw = env['WHATSAPP_RESPONSE_CATEGORIES'];
      if (!set(raw)) return {};
      const wanted = new Set(
        raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s !== '' && RESPONSE_TEMPLATE_BY_CATEGORY.has(s)),
      );
      return wanted.size === 0 ? {} : { responseCategories: wanted };
    })(),
    /**
     * The `advisory` / `order` / `schedule` / `information` subset that also carries a picture
     * in the message — 2026-09-04, the owner's own line. Filtered against
     * `RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY` rather than `RESPONSE_TEMPLATE_BY_CATEGORY`: a slug
     * this source has no picture-carrying shape for names nothing here, the same discipline as
     * `responseCategories` above.
     */
    ...(() => {
      const raw = env['WHATSAPP_RESPONSE_IMAGE_CATEGORIES'];
      if (!set(raw)) return {};
      const wanted = new Set(
        raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s !== '' && RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY.has(s)),
      );
      return wanted.size === 0 ? {} : { responseImageCategories: wanted };
    })(),
    ...(env['WHATSAPP_BASE_URL'] === undefined ? {} : { baseUrl: env['WHATSAPP_BASE_URL'] }),
  };
}

/**
 * **Which proactive messages this district has switched on — Phase 5, 2026-08-21.**
 *
 * ## The default is silence, and the default is the whole design
 *
 * Everything WhatsApp has ever sent from this system was **asked for**: an alert somebody in the
 * control room dispatched, or an answer to something an officer typed into their own thread.
 * Phase 5 is the first code that messages a handset **because time passed**. That is a different
 * kind of thing to put on a district's number, and Bajaur is on `TIER_250` — two hundred and fifty
 * unique handsets in a rolling day, with every one spent on a message nobody asked for being one
 * not available for an emergency.
 *
 * 🔴 **So `WHATSAPP_PROACTIVE` absent or blank is not "the sensible default": it is OFF, and the
 * deploy that carries this code sends nothing at all.** Switching it on is a decision about how
 * the district's number behaves towards its own officers, and that decision belongs to whoever
 * owns the number rather than to whoever ships the build.
 *
 * ## Why an unrecognised word turns things OFF rather than on
 *
 * `WHATSAPP_PROACTIVE=nudges` is a plausible thing to type and it names nothing. Read
 * generously — *"they clearly meant all of it"* — it would start messaging a district's officers
 * on the strength of a guess about a typo. Read strictly, it does nothing and says so at boot, in
 * `checkConfiguration`'s own summary line, where somebody looking for it will find it.
 *
 * **A false silence is a feature that did not arrive; a false send is a message on a real
 * officer's handset at 02:00.** ADR-0005's rule pointed at a switch: when the two errors are not
 * the same size, the default goes to the smaller one.
 */
export type ProactiveKind = 'nudge' | 'closed' | 'summary';

export const PROACTIVE_KINDS: readonly ProactiveKind[] = ['nudge', 'closed', 'summary'];

export interface ProactiveSettings {
  /** Empty is the ordinary state, and an empty set means nothing is sent by anything. */
  readonly enabled: ReadonlySet<ProactiveKind>;
  /**
   * Words in the value that name nothing here.
   *
   * Reported rather than swallowed, because a district that typed one and got silence needs to be
   * told which word was the problem — and told at boot, not by noticing over a week that no
   * nudges arrived.
   */
  readonly unrecognised: readonly string[];
}

const PROACTIVE_ALL: readonly string[] = ['on', 'true', '1', 'yes', 'all'];
const PROACTIVE_NONE: readonly string[] = ['off', 'false', '0', 'no', 'none'];

/**
 * Read the switch.
 *
 * Accepts a plain *on* for the district that wants all three, and a comma-separated list for the
 * one that wants to try a single kind first — which is the likely way this actually gets adopted:
 * a closing word costs nothing and reads as courtesy, where a nudge is the district interrupting
 * an officer who has not answered yet, and an owner may well want those on different days.
 *
 * Pure, and exported so the interesting cases are unit tests rather than something a district
 * finds out by deploying — `checkConfiguration`'s own rule, applied to the same `.env` file.
 */
export function proactiveFromEnv(
  env: Readonly<Partial<Record<string, string>>>,
): ProactiveSettings {
  const raw = (env['WHATSAPP_PROACTIVE'] ?? '').trim().toLowerCase();
  if (raw === '') return { enabled: new Set(), unrecognised: [] };

  const words = raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '');

  // A bare `on` means all three and a bare `off` means none. Checked as the whole value rather
  // than per word, so `nudge,on` is a contradiction that names `on` as unrecognised instead of
  // quietly widening a list somebody wrote deliberately.
  if (words.length === 1) {
    const only = words[0] as string;
    if (PROACTIVE_ALL.includes(only))
      return { enabled: new Set(PROACTIVE_KINDS), unrecognised: [] };
    if (PROACTIVE_NONE.includes(only)) return { enabled: new Set(), unrecognised: [] };
  }

  const enabled = new Set<ProactiveKind>();
  const unrecognised: string[] = [];

  for (const word of words) {
    const kind = PROACTIVE_KINDS.find((k) => k === word);
    if (kind === undefined) unrecognised.push(word);
    else enabled.add(kind);
  }

  return { enabled, unrecognised };
}

/**
 * A number as Meta wants it: digits, international, no plus.
 *
 * The one place the server assumes a country, and it is stated rather than hidden — the same
 * assumption `web/src/contact.ts` makes for `wa.me` links, for the same reason: the district is
 * Bajaur, and a number typed by somebody in Bajaur with a leading zero is a Pakistani number. If
 * that ever stops being true, it stops being true in these two places.
 */
export function toE164(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('92')) return digits;
  if (digits.startsWith('0')) return `92${digits.slice(1)}`;
  return digits;
}

export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | {
      readonly ok: false;
      readonly failure: string;
      /**
       * Meta refused *for now* rather than *at all* — M6-24.
       *
       * A new number is rate limited by Meta until its usage earns the tier up, and hitting
       * that cap is not the same as a bad number or an unapproved template. The caller queues
       * rather than dropping, and says so on screen: an emergency Meta deferred for ninety
       * seconds must not be recorded as one nobody could be told about.
       */
      readonly retryable: boolean;
    };

export interface OutboundMessage {
  readonly toPhone: string;
  /** The incident's category and severity, in the words the district reads. */
  readonly what: string;
  /** Where, in plain words. A placeholder is fine; an empty string is not — Meta refuses it. */
  readonly where: string;
  /**
   * The single-use acknowledge **token** (M6-22). This is what meets the obligation.
   *
   * **The token alone, never the whole URL** — and that distinction is the bug of 2026-08-12.
   * A WhatsApp URL button is approved with a fixed prefix and one `{{1}}` at the end; Meta
   * appends the parameter to that prefix rather than replacing it. This field used to carry
   * `https://dnc.example.com/ack/<token>`, so an officer tapping the button was sent to
   * `https://<template-prefix>/ack/https://dnc.example.com/ack/<token>` — the browser reads
   * the *template's* host and everything after it is a path. Every acknowledge link the
   * district ever sent was dead, and the send itself succeeded, so nothing reported a fault.
   *
   * The prefix lives in the approved template and is checked against `PUBLIC_ORIGIN` by
   * `templateProblems`. Change one and the other must change with it.
   */
  readonly ackToken: string;
  /**
   * A file to carry with the message — M9-17. Absent on almost every send.
   *
   * `mediaId` is what `uploadMedia` returned; `filename` is what the officer sees in their
   * WhatsApp before opening it, and Meta shows it only for documents.
   *
   * **A picture rides the message only when the district has an image template approved; a
   * document never does.** `templateFor` decides, per message, and the header is built only for
   * the template that was approved to carry one — sending a header component to a body-only
   * template is a 400 from Meta on *every* message using it, emergencies included.
   */
  readonly media?: {
    readonly mediaId: string;
    readonly filename: string;
    readonly kind: 'document' | 'image';
  };
  /**
   * What this message asks the officer for — 2026-08-19, and it is what picks the template.
   *
   * **Not the incident's kind, deliberately.** This file is the transport and nothing else (see
   * the header), and a transport that knows what a meeting is has started deciding things the
   * domain owns. `jobs/whatsappChannel.ts` reads `state.kind` and answers the only question
   * transport needs answering: *which buttons should be under this message*.
   *
   *   * `attendance` — three quick replies and no link. Meetings.
   *   * `acknowledgement` — one quick reply and a link. Emergencies, alerts, advisories, orders.
   *   * absent — the plain template, one link. What every message sent before this date used, and
   *     still the fallback whenever the district has not named the template for the other two.
   */
  readonly answers?: 'attendance' | 'acknowledgement';
  /**
   * The emergency-category slug for a `dnc_response_<category>` template — ADR-0034.
   *
   * `whatsappChannel.ts` resolves it from the incident's kind and category and sets it on every
   * emergency-family message. `templateFor` sends on that template **only when the category is
   * also in `config.responseCategories`** — so this being present is not on its own a decision to
   * route onto it. Absent for a meeting, and ignored for a message carrying a picture (the image
   * template wins).
   */
  readonly responseCategory?: string;
}

export type MediaResult =
  | { readonly ok: true; readonly mediaId: string }
  | { readonly ok: false; readonly failure: string; readonly retryable: boolean };

/**
 * Put a file on Meta's servers and get an id back — M9-17.
 *
 * Meta will not take a URL for an outbound template header; the bytes must be uploaded first and
 * referenced by id. The id is good for 30 days, which is far longer than the send that follows
 * it, so nothing here caches or reuses one: a message that fails and is retried re-uploads, and
 * that is cheaper than a stale id producing a message with somebody else's attachment.
 *
 * **`multipart/form-data`, assembled by hand.** `FormData` and `Blob` are global in Node 22 and
 * this uses them rather than hand-rolling the boundary — the one place in this file where a
 * built-in does the tedious part. ADR-0007's question ("who restarts this when it fails, and how
 * do they know it failed") is answered by it being the runtime's own.
 */
export async function uploadMedia(
  config: WhatsAppConfig,
  file: { readonly bytes: Buffer; readonly contentType: string; readonly filename: string },
  fetchImpl: typeof fetch = fetch,
): Promise<MediaResult> {
  const url = `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/media`;

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', file.contentType);
  form.append(
    'file',
    new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
    file.filename,
  );

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: form,
      /**
       * Longer than a send, and still bounded.
       *
       * A twenty-megabyte upload on a district line takes real time, and cutting it at the
       * send's ten seconds would mean attachments never worked on a bad connection — which is
       * every connection this system was built for. Sixty is long enough to be honest and short
       * enough that a hung provider does not hold a notify pass open behind it.
       */
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return {
      ok: false,
      failure: `media_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const text = await res.text();

  if (!res.ok) {
    return {
      ok: false,
      failure: `media_${String(res.status)}: ${readError(text)}`,
      retryable: res.status === 429 || res.status >= 500,
    };
  }

  try {
    const id = (JSON.parse(text) as { id?: string }).id;
    if (typeof id === 'string' && id !== '') return { ok: true, mediaId: id };
  } catch {
    /* falls through to the failure below */
  }

  // Accepted, and nothing to reference it by. Worth its own failure rather than a shrug: the
  // send that follows would silently go out without the attachment the operator chose.
  return {
    ok: false,
    failure: 'media_no_id: accepted, but returned no id to attach it by',
    retryable: false,
  };
}

export type MediaDownload =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      /** What Meta said it is. A claim — `ops/fileType.ts` reads the bytes and the bytes win. */
      readonly contentType: string;
      /** Meta's own hash, when it gave one, already checked against the bytes that arrived. */
      readonly sha256: string | null;
    }
  | { readonly ok: false; readonly failure: string; readonly retryable: boolean };

/**
 * The largest inbound file this will pull down.
 *
 * **Meta's own caps are lower than this** — 16 MB for image, audio and video, 100 MB for a
 * document — and `MAX_EVIDENCE_BYTES` is 20 MB, which is what actually decides whether the
 * district keeps it. This exists so that the *download* is bounded independently of both: a
 * provider that announces one size and sends another must not be able to fill a district
 * server's memory on a public endpoint, and "the evidence layer will refuse it later" is not a
 * bound on what has already been read.
 *
 * Deliberately a little above the evidence cap. A file between the two is fetched and then
 * refused **by name**, so the district is told *that file is larger than 20 MB* rather than
 * *the download failed* — one of those is actionable by the officer who sent it.
 */
export const MAX_INBOUND_MEDIA_BYTES = 24 * 1024 * 1024;

/**
 * Fetch a file an officer sent — 2026-08-21.
 *
 * ## Two requests, and the second one is the part that surprises people
 *
 * A webhook carries a media **id** and nothing else. `GET /{id}` returns metadata containing a
 * one-use `url` on Meta's lookaside host, and **that URL still requires the access token** — it
 * is not a signed public link, and a plain fetch of it returns 401. Getting this wrong produces
 * a district where every inbound photograph fails with an authentication error against a URL
 * that looks like it should not need one.
 *
 * ## What it refuses, and why it refuses rather than trusts
 *
 * The announced size is checked **before** the bytes are asked for, and the delivered size is
 * checked again after — because the first is Meta's claim and the second is what arrived, and
 * this runs on the one machine also taking emergency reports.
 *
 * The hash is verified when Meta gives one. It is not security — the transport is TLS to Meta
 * and the webhook was signature-checked long before this is reached — it is **integrity**, and
 * it matters because the bytes are about to become evidence attached to an incident, which is a
 * thing somebody may have to defend in a review six months from now. A truncated download that
 * silently became a corrupt photograph would be discovered by exactly that person.
 *
 * ⚠️ **Nothing here throws and nothing here writes.** Same rule as the rest of this file: every
 * path returns a reason, because *"why did the picture not arrive"* is a question somebody asks
 * afterwards and an exception message is not an answer they can act on.
 */
export async function downloadMedia(
  config: WhatsAppConfig,
  mediaId: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes: number = MAX_INBOUND_MEDIA_BYTES,
): Promise<MediaDownload> {
  const auth = { authorization: `Bearer ${config.accessToken}` };

  let lookup: Response;
  try {
    lookup = await fetchImpl(`${config.baseUrl ?? GRAPH}/${mediaId}`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      failure: `media_lookup_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const lookupText = await lookup.text();

  if (!lookup.ok) {
    return {
      ok: false,
      failure: `media_lookup_${String(lookup.status)}: ${readError(lookupText)}`,
      retryable: lookup.status === 429 || lookup.status >= 500,
    };
  }

  let meta: { url?: unknown; mime_type?: unknown; sha256?: unknown; file_size?: unknown };
  try {
    meta = JSON.parse(lookupText) as typeof meta;
  } catch {
    return { ok: false, failure: 'media_lookup_unreadable: not json', retryable: false };
  }

  if (typeof meta.url !== 'string' || meta.url === '') {
    // Meta answered and gave nothing to fetch. Not retryable: the same id will answer the same
    // way, and retrying would put a public endpoint into a loop against somebody else's server.
    return { ok: false, failure: 'media_no_url: no download url in the reply', retryable: false };
  }

  /**
   * The announced size, refused before a byte is asked for.
   *
   * Meta reports `file_size` in bytes. A file above the cap is refused here rather than after a
   * twenty-four megabyte download that was always going to be thrown away.
   */
  const announced = Number(meta.file_size);
  if (Number.isFinite(announced) && announced > maxBytes) {
    return {
      ok: false,
      failure: `media_too_large: ${String(announced)} bytes, and this district accepts ${String(maxBytes)}`,
      retryable: false,
    };
  }

  let file: Response;
  try {
    file = await fetchImpl(meta.url, {
      method: 'GET',
      // The lookaside URL is **not** public. Without this it is a 401 that reads like a bug.
      headers: auth,
      // The same sixty seconds `uploadMedia` allows, and for the same reason: a district line
      // moving twenty megabytes is slow, and ten seconds would mean photographs never worked.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return {
      ok: false,
      failure: `media_fetch_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  if (!file.ok) {
    return {
      ok: false,
      failure: `media_fetch_${String(file.status)}`,
      retryable: file.status === 429 || file.status >= 500,
    };
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // What arrived, as against what was announced. Both are checked because they are two
  // different claims and only this one is a fact.
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      failure: `media_too_large: ${String(bytes.length)} bytes, and this district accepts ${String(maxBytes)}`,
      retryable: false,
    };
  }
  if (bytes.length === 0) {
    return { ok: false, failure: 'media_empty: nothing came back', retryable: true };
  }

  const stated = typeof meta.sha256 === 'string' && meta.sha256 !== '' ? meta.sha256 : null;
  if (stated !== null) {
    const got = createHash('sha256').update(bytes).digest('hex');
    /**
     * Meta gives the hash as hex. Compared case-insensitively rather than assumed, because a
     * comparison that fails on capitalisation would reject every genuine file while still
     * passing nothing corrupt — a check broken in the direction that looks like it is working,
     * which is the same trap `verifySignature` is written against.
     */
    if (got.toLowerCase() !== stated.toLowerCase()) {
      return {
        ok: false,
        // Retryable: a truncated body on a bad line is the likely cause, and the next pass may
        // well get all of it. A genuinely corrupt file fails the same way twice and stops.
        failure: 'media_hash_mismatch: the bytes are not the ones meta described',
        retryable: true,
      };
    }
  }

  const contentType =
    typeof meta.mime_type === 'string' && meta.mime_type !== ''
      ? meta.mime_type
      : 'application/octet-stream';

  return { ok: true, bytes, contentType, sha256: stated };
}

/**
 * Which template this one message goes on — M10-28, and the whole of it.
 *
 * ## Why this is a function and not a setting
 *
 * It used to be neither: one template name in `.env` and one boolean saying whether that
 * template had a media header. **Those are two facts about one thing, and configuration let them
 * disagree.** Setting the boolean against the body-only template would have put a header on every
 * send — including the ones with no file — and Meta rejects a message whose components do not
 * match the template it approved. Not the message with the picture: **all of them.** The first
 * emergency of the day would have failed for the same reason as the meeting notice, and the only
 * symptom is a provider error nobody in a district office can read.
 *
 * Deciding per message means the header and the name are chosen together, once, here. There is
 * no arrangement of `.env` in which a body-only template is sent a header, because nothing can
 * ask for one.
 *
 * ## The three cases, and why the third is permanent
 *
 * | what the message carries | template | the file reaches the officer by |
 * |---|---|---|
 * | a picture, and an image template is approved | the image template | riding the message |
 * | a picture, and none is approved | the ordinary one | a single-use link |
 * | a PDF, or nothing | the ordinary one | a single-use link, or nothing |
 *
 * **A PDF is never in the first row and that is a decision rather than a gap.** The owner chose
 * images only, so no document template was ever submitted — which is what turns the file-link
 * page from a fallback into the load-bearing path it now is.
 */
function templateFor(
  config: WhatsAppConfig,
  message: OutboundMessage,
): {
  readonly name: string;
  readonly language: string;
  readonly withHeader: boolean;
  /**
   * Which button the acknowledge token belongs to, or `null` when the template has no link.
   *
   * Returned **beside** the name for the same reason `withHeader` is: Meta matches a button
   * parameter by position, so the index and the template it belongs to are one fact. Split into
   * two places they can disagree, and disagreeing means Meta refuses every message on that
   * template — see `TemplateShape.urlButton`.
   */
  readonly ackButtonIndex: number | null;
} {
  const image = config.imageTemplate;

  /**
   * **A picture must go on a template approved with a media header, so it decides the template
   * before anything else about the message does — but it no longer means the same picture always
   * wins the same way.**
   *
   * Until 2026-09-04 there was one shape with a header at all, so a photograph and a tappable
   * answer could never share a message: an emergency with a picture got a link where it would
   * otherwise have got `Acknowledge`, and a meeting or a response-category alert with a picture
   * lost its real question entirely — `district_message_img_v3` carries only `Acknowledge` /
   * `Open details`, so a meeting sent on it asked to be *Acknowledged* rather than answered
   * `Attending` / `Not attending` / `Sending someone`.
   *
   * The owner's line, 2026-09-04: meetings, advisories, orders, schedules and information notices
   * keep their own buttons **with the picture riding in the message**, once Meta approves a
   * picture-carrying version of each; every other kind still trades the picture for a file link
   * exactly as it did before. So this now checks, in order: a meeting with its own picture
   * template approved and named; a response category with its own picture template approved and
   * named; and only then the one shape every other picture has always gone on.
   */
  if (message.media?.kind === 'image') {
    /**
     * A meeting, when the district has `district_notice_img_v1` (or whatever it is named)
     * approved and named. `ackButtonIndex: null` because this template carries no URL button —
     * the same fact `NOTICE_TEMPLATE_IMAGE.urlButton === null` states, checked rather than
     * assumed for the reason every other `null` here is.
     */
    const noticeImage = config.noticeImageTemplate;
    if (noticeImage !== undefined && message.answers === 'attendance') {
      return {
        name: noticeImage.name,
        language: noticeImage.language,
        withHeader: true,
        ackButtonIndex: NOTICE_TEMPLATE_IMAGE.urlButton?.index ?? null,
      };
    }

    /**
     * A response category, when the owner asked for a picture template on it AND the district
     * has one approved. `config.responseImageCategories` is read as a strict subset of
     * `config.responseCategories` in effect — a category not already answering on its own
     * template has no picture-carrying version of one either.
     */
    const imageCategory = message.responseCategory;
    if (
      imageCategory !== undefined &&
      config.responseImageCategories?.has(imageCategory) === true
    ) {
      const shape = responseImageTemplateFor(imageCategory);
      if (shape !== undefined) {
        return {
          name: shape.name,
          language: shape.language,
          withHeader: true,
          ackButtonIndex: null,
        };
      }
    }

    /**
     * Every other picture: the one shape every picture has always gone on, when the district has
     * it approved and named.
     */
    if (image !== undefined) {
      return {
        name: image.name,
        language: image.language,
        withHeader: true,
        /**
         * 🔴 **Resolved from the CONFIGURED NAME, not from whichever picture template this source
         * happened to declare first — 2026-08-25.**
         *
         * This line read `ALERT_TEMPLATE_IMAGE.urlButton?.index` — a hardcoded `0`, correct for
         * exactly as long as `_img_v2` was the only picture template that existed. `_img_v3` puts
         * a quick reply first and the link **second**, so the day the district pointed
         * `WHATSAPP_TEMPLATE_IMAGE` at it, this would have attached the acknowledge token to the
         * quick reply. Meta identifies a button parameter by position and nothing else: it would
         * have refused **every** message on that template — the emergencies too, not only the one
         * that carried a photograph — with nothing failing here to say why.
         *
         * ⚠️ **The fallback is `ALERT_TEMPLATE_IMAGE` and stays the old behaviour**, because a
         * district that approved its own picture template under its own name is sending on a
         * shape this source cannot see, and the one honest guess is the shape it documents.
         */
        ackButtonIndex: (shapeNamed(image.name) ?? ALERT_TEMPLATE_IMAGE).urlButton?.index ?? null,
      };
    }
    // No picture template of any kind is approved. Falls through — `jobs/whatsappChannel.ts`
    // never hands this function a `media.kind === 'image'` in that case; see `pictureFor`.
  }

  /**
   * **A category alert, when the district has switched that category's own template on** —
   * ADR-0034, 2026-09-03.
   *
   * `dnc_response_<category>` carries three category-specific quick replies and nothing else — no
   * header, no URL button — so `withHeader: false` and `ackButtonIndex: null`, and the officer's
   * first tap on it is their response (`api/webhooks.ts` reads the label through
   * `templateOptionFor`). Checked **before** the emergency and notice branches: a category that is
   * switched on answers on its own template rather than on `district_emergency_v2`.
   *
   * ⚠️ **After the picture branch, never before it.** A photograph on a category with no approved
   * picture template of its own still goes on the ordinary image template above, exactly as
   * before, and its officer gets a link rather than these three buttons — see `wantsButtons` in
   * `jobs/whatsappChannel.ts`, which is what keeps such a photograph off this branch entirely by
   * sending it as a file link instead.
   */
  const responseCategory = message.responseCategory;
  if (responseCategory !== undefined && config.responseCategories?.has(responseCategory) === true) {
    const shape = responseTemplateFor(responseCategory);
    if (shape !== undefined) {
      return {
        name: shape.name,
        language: shape.language,
        withHeader: false,
        ackButtonIndex: null,
      };
    }
  }

  /**
   * A meeting, when the district has the meeting template approved.
   *
   * `ackButtonIndex: null` and `NOTICE_TEMPLATE.urlButton === null` are the same fact said twice,
   * and the second is the one that would catch a mistake: if that template is ever resubmitted
   * with a link on it, this line starts sending the token to it rather than silently dropping it.
   */
  const notice = config.noticeTemplate;
  if (notice !== undefined && message.answers === 'attendance') {
    return {
      name: notice.name,
      language: notice.language,
      withHeader: false,
      ackButtonIndex: NOTICE_TEMPLATE.urlButton?.index ?? null,
    };
  }

  /** An emergency, alert, advisory or order — a tap **and** a link, the link second. */
  const emergency = config.emergencyTemplate;
  if (emergency !== undefined && message.answers === 'acknowledgement') {
    return {
      name: emergency.name,
      language: emergency.language,
      withHeader: false,
      ackButtonIndex: EMERGENCY_TEMPLATE.urlButton?.index ?? null,
    };
  }

  /**
   * Everything else, and everything at all until a district names the templates above.
   *
   * ⚠️ **The index comes from `ALERT_TEMPLATE` rather than from a literal `0`.** A district that
   * has overridden `WHATSAPP_TEMPLATE` is sending on a template this file cannot see, and the one
   * honest guess is the shape this source documents — which is what `doctor` compares against.
   */
  return {
    name: config.templateName,
    language: config.templateLanguage,
    withHeader: false,
    ackButtonIndex: ALERT_TEMPLATE.urlButton?.index ?? null,
  };
}

/**
 * Send one templated message.
 *
 * **A template, not free text**, and that is Meta's rule rather than a preference: outside a
 * 24-hour window opened by the recipient replying, only an approved template may be sent. Every
 * alert this district sends is the first message of a conversation at 02:00, so every alert is
 * a template — which is why M6-26 has the district review the wording before submission, and
 * why changing it later means another approval.
 */
export async function sendWhatsApp(
  config: WhatsAppConfig,
  message: OutboundMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const url = `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/messages`;

  const chosen = templateFor(config, message);

  const body = {
    messaging_product: 'whatsapp',
    to: toE164(message.toPhone),
    type: 'template',
    template: {
      name: chosen.name,
      language: { code: chosen.language },
      components: [
        /**
         * The picture, when this message is going on the template approved to carry one.
         *
         * **`templateFor` has already decided both halves**, which is what M10-28 changed: the
         * header and the template name can no longer disagree, because one chooses the other. A
         * header component sent to a body-only template is rejected by Meta for *every* message
         * on that template, emergencies included — so the two must not be separate decisions.
         *
         * Only ever an image. There is no document template by the owner's choice, so a PDF is
         * never here — it travels as a single-use link in the body (M9-18), permanently.
         *
         * Spread into the array rather than pushed, so the body below stays visibly first and
         * the parameter order the approved template depends on cannot be disturbed by an `if`
         * somebody adds later.
         */
        ...(chosen.withHeader && message.media !== undefined
          ? [
              {
                type: 'header',
                parameters: [{ type: 'image', image: { id: message.media.mediaId } }],
              },
            ]
          : []),
        {
          type: 'body',
          parameters: [
            { type: 'text', text: message.what },
            { type: 'text', text: message.where },
          ],
        },
        /**
         * The acknowledge link, as a URL button suffix — the token only. Meta *appends* this
         * to the prefix the template was approved with; it does not replace it. See the note
         * on `ackToken`, which is the whole of the 2026-08-12 dead-link bug.
         *
         * **Both the index and whether this exists at all come from `templateFor`** — 2026-08-19.
         * It was a literal `index: '0'`, unconditional, which was true of every template the
         * district had approved until `district_notice_v2` had no link and `district_emergency_v2`
         * put its link second. Meta matches a button parameter by position, and refuses the whole
         * message when it names one the template does not have — for every message on that
         * template, not only this one.
         *
         * Spread rather than pushed, so no `if` added later can disturb the order the approved
         * template depends on.
         */
        ...(chosen.ackButtonIndex === null
          ? []
          : [
              {
                type: 'button',
                sub_type: 'url',
                index: String(chosen.ackButtonIndex),
                parameters: [{ type: 'text', text: message.ackToken }],
              },
            ]),
      ],
    },
  };

  return post(config, url, body, fetchImpl);
}

/**
 * POST one message to Meta and turn whatever comes back into a `SendResult`.
 *
 * **Extracted so the template sender and the session sender fail identically**, which matters
 * more than the duplication it saves. Every one of the outcomes below is a sentence somebody
 * reads at 02:00 when a message did not arrive, and a second copy of this logic would drift
 * within a month — the free-form path would grow its own wording for a 429, and the district
 * would learn that "the tier cap" and "whatsapp_429" are different problems.
 *
 * Nothing here knows what kind of message it sent. That is the point: an unapproved template
 * and a shut service window are both *Meta refused this and said why*, and the caller's job is
 * to have not made the mistake, not to have a bespoke error for it.
 */
/**
 * Send a sign-in link (ADR-0043) on the district's login template.
 *
 * The token only — Meta appends it to the approved button prefix `{PUBLIC_ORIGIN}/set-password/`,
 * exactly as with the acknowledge link (see `OutboundMessage.ackToken` for the defect that rule
 * came from). The caller checks `config.loginTemplate` first: with none, nothing is sent.
 */
export async function sendLoginLink(
  config: WhatsAppConfig,
  message: { readonly toPhone: string; readonly name: string; readonly token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const template = config.loginTemplate;
  if (template === undefined) {
    return { ok: false, failure: 'no_login_template', retryable: false };
  }
  return post(
    config,
    `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toE164(message.toPhone),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: message.name }] },
          {
            type: 'button',
            sub_type: 'url',
            index: String(LOGIN_LINK_TEMPLATE.urlButton?.index ?? 0),
            parameters: [{ type: 'text', text: message.token }],
          },
        ],
      },
    },
    fetchImpl,
  );
}

/**
 * Send an Activities Respond on the district's template (ADR-0044 §6) — the path for a number
 * whose 24-hour window is shut. The caller checks `config.activityTemplate` first: with none,
 * nothing is sent.
 *
 * The message goes as one line: Meta refuses a parameter holding a line break, a tab or more than
 * four spaces in a row, and it refuses the whole message, not the parameter.
 */
export async function sendActivityResponse(
  config: WhatsAppConfig,
  message: { readonly toPhone: string; readonly postDate: string; readonly message: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const template = config.activityTemplate;
  if (template === undefined) {
    return { ok: false, failure: 'no_activity_template', retryable: false };
  }
  return post(
    config,
    `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: toE164(message.toPhone),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: message.postDate },
              { type: 'text', text: message.message.replace(/\s+/g, ' ').trim() },
            ],
          },
        ],
      },
    },
    fetchImpl,
  );
}

async function post(
  config: WhatsAppConfig,
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      // Bounded. The notify pass runs on the one machine also accepting emergency reports, and
      // a provider that stops answering must not hold a pass open behind it.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // The district's line, Meta, or DNS. All the same from here, all retryable, and none of
    // them a reason to record that nobody could be told.
    return {
      ok: false,
      failure: `whatsapp_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const text = await res.text();

  if (!res.ok) {
    /**
     * Meta's own words, kept verbatim.
     *
     * A paraphrased provider error is a provider error nobody can look up, and the two that
     * will actually happen here — an unapproved template and an unregistered number — are both
     * things somebody fixes in a Meta console by searching for the exact string.
     */
    const detail = readError(text);

    // 429 is the tier cap; 5xx is Meta having a bad day. Neither means nobody can be told.
    const retryable = res.status === 429 || res.status >= 500;

    return {
      ok: false,
      failure: `whatsapp_${String(res.status)}: ${detail}`,
      retryable,
    };
  }

  const id = readMessageId(text);
  if (id === null) {
    // A 200 with nothing to hold on to. Worth its own failure rather than a shrug: without an
    // id no webhook can ever be matched to this attempt, so it would stay pending for ever
    // while having very possibly arrived.
    return {
      ok: false,
      failure: 'whatsapp_no_message_id: accepted, but returned no id to track it by',
      retryable: false,
    };
  }

  return { ok: true, providerMessageId: id };
}

/**
 * A message sent **inside the 24-hour service window**, with no template and no approval.
 *
 * ## The rule this is built on, and the half of it the district has never used
 *
 * Meta requires the **first** message of a conversation to be an approved template. Every
 * message this system has ever sent has been one, and that rule has shaped the whole product:
 * anything the district wanted to ask an officer had to be a button approved weeks earlier, or
 * a link out of WhatsApp into a browser — on a district signal, at 02:00, on whatever handset
 * the officer owns.
 *
 * The moment the officer sends anything back — a typed word, a tap on a quick reply — a
 * **service window** opens on that number for 24 hours, and inside it free-form messages are
 * accepted. `sessionWindowOpen` is what knows whether that is true; this function is what uses
 * it. **No template, no submission, nothing PENDING at Meta.**
 *
 * ⚠️ **The caller must check the window first.** This function does not, and that is deliberate
 * rather than an omission: the check needs the database and this file is the transport and
 * nothing else — the same line `sendWhatsApp` holds, which records no events and touches no
 * ledger. Sent against a shut window, Meta refuses with a `131047` and the failure says so.
 *
 * ## Why the limits are refused here rather than by Meta
 *
 * A title of 21 characters, or a fourth button, is a 400 from Meta with a message about a
 * parameter path — and the district would see an officer who never got their follow-up and a
 * log line nobody can act on. Refused locally, it is a sentence that names the actual mistake,
 * in a codebase where somebody can fix it. Meta's caps, as of v21.0: three buttons, a 20
 * character title, a 256 character id, and a body of 1024 with buttons or 4096 without.
 */
export interface SessionMessage {
  readonly toPhone: string;
  /** What it says. The whole message when there are no buttons; the question above them when there are. */
  readonly text: string;
  /**
   * Up to three, or none for a plain text message.
   *
   * `id` is what comes back on the tap and `title` is what the officer reads. They are separate
   * because the answer has to be matched to the question that asked it, and matching on the
   * words shown to a human is how a district ends up unable to reword a button.
   */
  readonly buttons?: readonly { readonly id: string; readonly title: string }[];
  /**
   * A list, when three buttons is not enough — Phase C2.
   *
   * ⚠️ **This exists because *"where are you?"* has five answers and Meta allows three buttons.**
   * The alternative was two messages of three, which asks an officer to hold half a question in
   * their head at 02:00, or dropping two of the five — and `wall.ts` argues at length that
   * `present` is not a synonym for `office` and that collapsing them puts an officer at a desk
   * they are not at.
   *
   * Ten rows is Meta's cap and it is not close to binding here. What binds is the row **title**
   * at 24 characters, which is why the words on these rows are shorter than the ones the page
   * uses for the same five answers.
   *
   * Mutually exclusive with `buttons`: Meta's `interactive` carries one `type`, and a message
   * asking to be both is refused by `sendSession` rather than by Meta.
   */
  /**
   * **Quote a message already in this thread — Phase 8b, 2026-08-21.**
   *
   * Meta's `context.message_id`, which is the outbound half of the field `readWebhook` has been
   * reading on the way in since 21 August. The officer sees the follow-up **attached under the
   * original alert**, on their own screen, rather than as a loose sentence in a thread that may
   * hold several of the district's notices.
   *
   * ⚠️ **It is a courtesy on the phone and never the record.** Which alert a follow-up chases is
   * written into the `followed_up` event from `whatsapp_message`'s own key, so the district's
   * account holds together whether or not Meta honours this — and Meta refuses a context whose
   * message is too old, which is exactly the case a chase is aimed at.
   */
  readonly replyTo?: string;
  readonly list?: {
    /** What the officer taps to open it. Twenty characters, same as a button title. */
    readonly button: string;
    readonly rows: readonly {
      readonly id: string;
      readonly title: string;
      /** One line under the title. Optional, and worth spending on anything that needs saying. */
      readonly description?: string;
    }[];
  };
}

const BUTTON_TITLE_MAX = 20;
const BUTTON_ID_MAX = 256;
const BUTTONS_MAX = 3;
const BODY_MAX_WITH_BUTTONS = 1024;
const BODY_MAX_PLAIN = 4096;
/** Meta's caps on a list. The **title** is what binds in practice, not the row count. */
const ROWS_MAX = 10;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;
const ROW_ID_MAX = 200;

export async function sendSession(
  config: WhatsAppConfig,
  message: SessionMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  const buttons = message.buttons ?? [];
  const text = message.text.trim();

  const bodyMax =
    buttons.length > 0 || message.list !== undefined ? BODY_MAX_WITH_BUTTONS : BODY_MAX_PLAIN;

  /**
   * Every refusal below is `retryable: false`, and that is the honest answer rather than a
   * cautious one. A message too long for Meta is too long on the next pass as well; marking it
   * retryable would put the same rejected message through the ladder every interval until
   * somebody noticed, which is the failure mode `alreadyAttempted` exists to prevent.
   */
  if (text === '') {
    return { ok: false, failure: 'session_empty: nothing to say', retryable: false };
  }
  if (text.length > bodyMax) {
    return {
      ok: false,
      failure: `session_too_long: ${String(text.length)} characters, and Meta accepts ${String(bodyMax)}`,
      retryable: false,
    };
  }
  if (buttons.length > BUTTONS_MAX) {
    return {
      ok: false,
      failure: `session_too_many_buttons: ${String(buttons.length)}, and Meta accepts ${String(BUTTONS_MAX)}`,
      retryable: false,
    };
  }
  for (const button of buttons) {
    if (button.title.trim() === '' || button.title.length > BUTTON_TITLE_MAX) {
      return {
        ok: false,
        failure: `session_bad_button: "${button.title}" must be 1 to ${String(BUTTON_TITLE_MAX)} characters`,
        retryable: false,
      };
    }
    if (button.id.trim() === '' || button.id.length > BUTTON_ID_MAX) {
      return {
        ok: false,
        failure: `session_bad_button_id: "${button.id}" must be 1 to ${String(BUTTON_ID_MAX)} characters`,
        retryable: false,
      };
    }
  }

  const list = message.list;

  if (list !== undefined && buttons.length > 0) {
    /**
     * Refused here rather than at Meta, and it is a programming error rather than a district one.
     * `interactive` carries exactly one `type`; a message asking to be both would be built as one
     * of the two silently, and the officer would get whichever half the code happened to write.
     */
    return {
      ok: false,
      failure: 'session_buttons_and_list: a message is one or the other, never both',
      retryable: false,
    };
  }

  if (list !== undefined) {
    if (list.rows.length === 0 || list.rows.length > ROWS_MAX) {
      return {
        ok: false,
        failure: `session_bad_list: ${String(list.rows.length)} rows, and Meta accepts 1 to ${String(ROWS_MAX)}`,
        retryable: false,
      };
    }
    if (list.button.trim() === '' || list.button.length > BUTTON_TITLE_MAX) {
      return {
        ok: false,
        failure: `session_bad_list_button: "${list.button}" must be 1 to ${String(BUTTON_TITLE_MAX)} characters`,
        retryable: false,
      };
    }
    for (const row of list.rows) {
      if (row.title.trim() === '' || row.title.length > ROW_TITLE_MAX) {
        return {
          ok: false,
          failure: `session_bad_row: "${row.title}" must be 1 to ${String(ROW_TITLE_MAX)} characters`,
          retryable: false,
        };
      }
      if (row.id.trim() === '' || row.id.length > ROW_ID_MAX) {
        return {
          ok: false,
          failure: `session_bad_row_id: "${row.id}" must be 1 to ${String(ROW_ID_MAX)} characters`,
          retryable: false,
        };
      }
      if (row.description !== undefined && row.description.length > ROW_DESCRIPTION_MAX) {
        return {
          ok: false,
          failure: `session_bad_row_description: "${row.title}" carries more than ${String(ROW_DESCRIPTION_MAX)} characters`,
          retryable: false,
        };
      }
    }
  }

  const url = `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/messages`;

  /**
   * Quoting is added to whichever shape was built, never built into each of the three — Phase 8b.
   * Three copies of one optional field is how two of them keep it and the third quietly does not.
   */
  const quoted = message.replyTo === undefined ? {} : { context: { message_id: message.replyTo } };

  const body =
    list !== undefined
      ? {
          messaging_product: 'whatsapp',
          to: toE164(message.toPhone),
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text },
            action: {
              button: list.button,
              // One section, unnamed. Sections exist to group a long catalogue; five answers to
              // one question are not a catalogue, and a heading over them would be the question
              // asked twice.
              sections: [
                {
                  rows: list.rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    ...(row.description === undefined ? {} : { description: row.description }),
                  })),
                },
              ],
            },
          },
        }
      : buttons.length === 0
        ? {
            messaging_product: 'whatsapp',
            to: toE164(message.toPhone),
            type: 'text',
            text: { body: text },
          }
        : {
            messaging_product: 'whatsapp',
            to: toE164(message.toPhone),
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text },
              action: {
                buttons: buttons.map((b) => ({
                  type: 'reply',
                  reply: { id: b.id, title: b.title },
                })),
              },
            },
          };

  return post(config, url, { ...body, ...quoted }, fetchImpl);
}

/**
 * **Put the two blue ticks on the officer's own message** — Phase 7, 2026-08-21.
 *
 * ## What was actually wrong, and it is smaller than a feature and larger than a nicety
 *
 * An officer replies, taps a button or sends a photograph. This system reads it, records it on the
 * incident, settles the obligation and often answers back — and **their own message sits in their
 * own thread showing one grey tick, unread, for ever.** Every WhatsApp user in Pakistan reads that
 * as *nobody has looked at this yet*, which is the precise opposite of what happened, on the one
 * channel this district uses to be answered.
 *
 * It is the mirror of the defect this file has now closed four times. Those were **Meta sending
 * something and nothing reading it**; this is **this system reading something and never saying so
 * back.** An officer who believes their acknowledgement went nowhere rings the control room, or —
 * worse, and this is the one that costs — stops bothering to answer at all.
 *
 * ## What it is not
 *
 * ⚠️ **This is a read receipt, not a message.** It creates no conversation, opens no service
 * window, needs no template and **costs nothing against `TIER_250`** — Meta's cap counts unique
 * recipients of *messages*, and this is a status on one they already sent. It is therefore
 * deliberately **not** behind `WHATSAPP_PROACTIVE`: that switch exists because proactive sending
 * is a decision about how the district's number behaves, and marking something read is not
 * sending.
 *
 * ⚠️ **AND IT SETTLES NOTHING, WHICH IS THE LINE THIS FILE'S OWN HEADER DRAWS.** ADR-0014: *a read
 * receipt is never the obligation being met.* That rule is about **Meta telling us an officer read
 * ours** — evidence about a handset rather than about a person. This is the district telling an
 * officer **we** read **theirs**, which is a courtesy in the other direction and touches no ledger,
 * no clock and no event. The two are one word apart and must not be confused.
 *
 * ## Why it returns a reason instead of throwing
 *
 * Every failure path in this file does, and here it matters more than most: the caller is a
 * **webhook handler**, and a throw there is a 500, and Meta retries a 500 for hours onto the
 * machine that is also taking emergency reports. A tick that did not appear costs an officer a
 * moment's doubt. A retry storm costs the district its server.
 */
export async function markRead(
  config: WhatsAppConfig,
  messageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: string }> {
  if (messageId.trim() === '') {
    return { ok: false, failure: 'mark_read_no_id: there is no message to mark' };
  }

  const url = `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId.trim(),
      }),
    });
  } catch (error) {
    return {
      ok: false,
      failure: `mark_read_unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    /**
     * ⚠️ **A refusal here is ordinary and is not a fault to chase.** Meta will not mark a message
     * read once it is more than a few days old, and a webhook it retried across a deploy window
     * can easily be that old. The reason is returned in Meta's own words so a log line is
     * searchable, and the caller logs it at `info` rather than `warn` for exactly this reason.
     */
    return { ok: false, failure: readError(await response.text().catch(() => '')) };
  }

  return { ok: true };
}

function readError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: number; error_data?: { details?: string } };
    };
    const parts = [
      parsed.error?.message,
      parsed.error?.error_data?.details,
      parsed.error?.code === undefined ? undefined : `code ${String(parsed.error.code)}`,
    ].filter((p): p is string => typeof p === 'string' && p !== '');
    return parts.length > 0 ? parts.join(' · ') : text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function readMessageId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
    const id = parsed.messages?.[0]?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/**
 * Is this webhook genuinely Meta's? — M6-20.
 *
 * **Verified before the body is parsed, let alone acted on.** An unverified webhook is an
 * unauthenticated write to the district's record: the endpoint's whole job is to move an
 * attempt to `delivered`, so anybody who could forge one could mark every obligation in Bajaur
 * as met, and the board would go quiet on a night when nothing had been delivered at all.
 *
 * Compared in constant time. A byte-by-byte comparison that returns early leaks the expected
 * signature one character at a time to anybody willing to send a few thousand requests — and
 * this endpoint is, by necessity, reachable from the internet.
 */
export function verifySignature(
  appSecret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest();

  let given: Buffer;
  try {
    given = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }

  // `timingSafeEqual` throws on a length mismatch, which would itself be a length oracle and a
  // 500 on every malformed request.
  if (given.length !== expected.length) return false;

  return timingSafeEqual(given, expected);
}

/** The four states Meta reports, mapped to the four ADR-0014 named. */
export type ProviderStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface StatusUpdate {
  readonly providerMessageId: string;
  readonly status: ProviderStatus;
  readonly failure: string | null;
}

/**
 * A file an officer sent **to** the district — 2026-08-21.
 *
 * ## Why this did not exist until now, and why that was a defect rather than a gap
 *
 * `readWebhook` read `text` and a button's label, and skipped everything else with one line of
 * comment: *"a voice note or an image cannot be put on the incident as words, and storing a media
 * id the district cannot open would be a row that looks like a reply and is not one."* Every word
 * of that was true, and the conclusion drawn from it was the wrong one.
 *
 * What it cost was not a feature. An officer who photographed the scene and sent it **answered**,
 * and the message was dropped before anything looked at it — so the obligation stayed open, the
 * SLA clock kept running, escalation climbed over that officer's head, and the board carried them
 * for the rest of the district day as somebody nobody had reached. They could see their own
 * photograph sitting in their own thread the whole time. It is the same shape as the quick-reply
 * defect of 2026-08-19, and it was found the same way: by asking what Meta sends that this file
 * does not read.
 *
 * The premise is answered rather than argued with. The district **can** open it now:
 * {@link downloadMedia} fetches the bytes and `ops/evidence.ts` stores them against the incident,
 * so the row points at a file somebody can actually look at — which is exactly the condition the
 * original comment set and nobody had met.
 *
 * ## What is carried, and what is deliberately not
 *
 * This is the transport still. It reports **what Meta said arrived**; it downloads nothing on its
 * own, decides nothing about what a photograph means, and writes no row. `api/webhooks.ts` owns
 * all three, for the same reason it owns the order of operations for a send.
 */
export interface InboundMedia {
  /** Meta's handle for the bytes. Valid for a fortnight, and useless without the access token. */
  readonly mediaId: string;
  /**
   * What Meta says the file is — and it is a **claim**, exactly like the `content-type` on a
   * console upload.
   *
   * `ops/fileType.ts` reads the file's own magic number and the bytes win. It is carried because a
   * mismatch between what the provider announced and what arrived is worth refusing loudly rather
   * than correcting quietly (M9-14), not because anything downstream trusts it.
   */
  readonly mimeType: string;
  /** Meta's own SHA-256 of the bytes, when it gives one. Checked after the download. */
  readonly sha256: string | null;
  /**
   * A document's own filename, as the sending handset had it.
   *
   * Absent on photographs and voice notes, which genuinely have none — a handset does not name
   * what the camera just took. `safeLabel` decides what is displayed either way.
   */
  readonly filename: string | null;
  /**
   * Which of Meta's kinds it arrived as.
   *
   * Kept because the district's record should say *a voice note* rather than *audio/ogg*, and
   * because `voice` and `audio` are different acts: one is an officer holding the microphone
   * button, the other is a file somebody forwarded.
   */
  readonly kind: 'image' | 'video' | 'voice' | 'audio' | 'document' | 'sticker';
}

/**
 * **Where the officer is, said by tapping rather than typed** — Phase 6, 2026-08-21.
 *
 * ## Why this was dropped, and what dropping it cost
 *
 * `readWebhook` skipped anything with no words and no file, so a location message was discarded
 * without a line in the log — the same shape as the quick-reply tap (19 August) and the officer's
 * photograph (21 August), for the third and fourth time. O-43(d) named the consequence in one
 * sentence: *"location messages are dropped, so 'where are you' still needs the five-row list."*
 *
 * It cost more than a list. **An officer who drops a pin has answered** — deliberately, precisely,
 * and with the one piece of information the five rows cannot carry. `present` is the honest answer
 * when somebody is working and nobody knows where; a pin says exactly where. That message was
 * thrown away, so the obligation stayed open, the clock kept running, and the board carried them
 * as somebody nobody had reached.
 *
 * ## What is carried, and what the district does with it
 *
 * Meta sends degrees, and optionally a name and a street address when the sender picked a place
 * rather than dropping a raw pin. All four are carried; `api/webhooks.ts` decides the words.
 *
 * ⚠️ **A LOCATION IS NEVER PUT ON THE WALL, AND THAT IS NOT A STYLE PREFERENCE.**
 * `wallSafetyViolations` refuses a coordinate anywhere in the dashboard payload and **fails the
 * whole request** rather than stripping the field — so a note reading `34.7167, 71.5167` reaching
 * a wall panel would blank the DC office's screen over one officer's pin. It is safe today because
 * the activity panel carries `category — stage` and never an incident's notes. **Anything that
 * later puts a note on that panel has to deal with this first.**
 */
export interface InboundLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** What the sender's handset called the place, when they chose one rather than dropping a pin. */
  readonly name: string | null;
  readonly address: string | null;
}

/**
 * **A reaction — the cheapest deliberate answer an officer can give, and it was invisible** —
 * Phase 6, 2026-08-21.
 *
 * O-43(e): *"a ✅ is the cheapest deliberate answer an officer can give and it is invisible to
 * us."* One long-press, no typing, no data worth speaking of, from a moving vehicle at 02:00 —
 * and `readWebhook` dropped it in silence, so the district went on chasing somebody who had
 * answered.
 *
 * 🔴 **IT IS THE STRONGEST MATCH THIS SYSTEM EVER GETS, AND THAT IS THE PART WORTH KNOWING.**
 * Every other inbound is matched to an incident by *the most recent alert to that number* and says
 * in three places that the match is a guess. A reaction is **attached to one specific message** by
 * WhatsApp itself — `reaction.message_id` is this district's own `provider_message_id` — so there
 * is nothing to infer. It rides on `contextMessageId`, which is the field that already carries
 * exactly that claim, so `messageById` and the handset check apply to it unchanged.
 *
 * ⚠️ **AN EMPTY EMOJI IS A REACTION BEING TAKEN OFF, AND IT IS SKIPPED.** Meta reports a removal
 * as the same message shape with `emoji` absent or empty. Reading it as an answer would record an
 * officer **un-answering** as though they had just answered, which is not merely wrong — it is
 * backwards, and it would arrive at the exact moment somebody changed their mind.
 */
export interface InboundReaction {
  /** Meta's own characters, verbatim. The district's record should say what they actually sent. */
  readonly emoji: string;
}

export interface InboundReply {
  readonly fromPhone: string;
  /**
   * **Meta's id for the message the officer sent us** — Phase 7, 2026-08-21.
   *
   * Carried for one reason: {@link markRead}. Until now nothing in this system had any use for the
   * id of an *inbound* message — every id it handled was one of its own sends — so `readWebhook`
   * read `from`, `timestamp` and the content and never looked at `id`.
   *
   * ⚠️ **Not to be confused with `contextMessageId`.** This is *their* message; that one is *ours*,
   * the one they were answering. Reading one for the other would mark the district's own alert as
   * read by the district, which is both meaningless and untraceable.
   */
  readonly messageId: string | null;
  /**
   * What the officer said, or **empty when they sent only a file** — 2026-08-21.
   *
   * Empty was previously impossible: a message with nothing readable in it was skipped here, so
   * every caller could assume words. It is now a real state, because a photograph with no caption
   * is a complete answer and the commonest one an officer sends from a vehicle.
   *
   * ⚠️ **The words for that message are `api/webhooks.ts`'s to choose, not this file's.** A
   * transport that wrote *"sent a photograph"* onto an incident would be deciding what the
   * district's record says, which is the line this file does not cross.
   */
  readonly text: string;
  readonly at: string;
  /**
   * The officer **tapped a button** rather than typing — 2026-08-19.
   *
   * Carried rather than inferred from the words, because *"Acknowledge"* is a sentence somebody
   * could also type, and the district's record should not have to guess which happened. It changes
   * only how the note is worded on the incident; the obligation, the route and the acknowledgement
   * are identical, because the evidence is identical — a deliberate act by the recipient, matched
   * back to an obligation by the number it came from, which is an inference either way.
   */
  readonly tapped: boolean;
  /**
   * The **id** on a button this system sent itself — 2026-08-20, Phase C.
   *
   * ⚠️ **Only ever present on an interactive reply, and never on a template's quick reply.** A
   * template's buttons are approved at Meta and come back as nothing but their own words; a
   * button *this* software built carries an id the officer never sees, and that id is how the tap
   * is matched to the incident and the stage it is about.
   *
   * That distinction is the whole reason it exists. Matching on the **words** would work today
   * and would make *"Resolved"* — a sentence somebody could also type, about an emergency that
   * may not be the one on screen — into a control that resolves an incident. The id says which
   * incident and which stage, in a string the handset cannot have invented.
   */
  readonly replyId?: string;
  /**
   * The file the officer sent, when they sent one — 2026-08-21.
   *
   * One per reply because Meta delivers one per message: an officer attaching four photographs
   * sends four messages, and they arrive here as four replies. Nothing needs to group them.
   */
  readonly media?: InboundMedia;
  /**
   * Where they are, when they dropped a pin instead of typing — Phase 6.
   *
   * ⚠️ **Present with `text` empty is the ordinary case.** A location message carries no words at
   * all, exactly as a photograph with no caption does, and the caller chooses what the record says
   * about it — this file does not name an officer's act.
   */
  readonly location?: InboundLocation;
  /**
   * The emoji they put on one of our messages — Phase 6.
   *
   * Always arrives with `contextMessageId` set, because a reaction without a message to attach to
   * does not exist. A removal never arrives here at all; see {@link InboundReaction}.
   */
  readonly reaction?: InboundReaction;
  /**
   * **The message this one is a reply to — Meta's own answer to the question this system has
   * been guessing at since M6-23.**
   *
   * Every inbound is matched to an incident by *the most recent alert sent to that number*, and
   * `lastMessageTo` says in three places that the match is an inference. It has to be, for a
   * typed *"on my way"* that names nothing. **But when the officer uses WhatsApp's own reply
   * control, Meta puts the id of the message they replied to right here** — and that id is this
   * district's own `provider_message_id`. The exact answer has been on every webhook since the
   * first one and nothing was reading it.
   *
   * ⚠️ **A quick-reply tap carries one too**, naming the template message the button sat on. So
   * *Acknowledge* and *Attending* — matched by the number since 19 August — become exact as well.
   *
   * Absent is ordinary and stays ordinary: typing into the thread is easier than long-pressing a
   * message to reply to it, so most replies will carry nothing and fall back to the guess.
   *
   * ⚠️ **It is not necessarily one of ours.** An officer can reply to their **own** earlier
   * message, and Meta reports that identically. Resolving it is `db/whatsappStore.ts`'s job and
   * finding nothing is not an error.
   */
  readonly contextMessageId?: string;
}

/**
 * **What Meta says about this district's own account** — 2026-08-21.
 *
 * ## Meta has been telling us this all along, and nothing was listening
 *
 * `readWebhook` reached into `change.value` for `messages` and `statuses` and **never looked at
 * `change.field`**. Read off the live app the day this was written, the subscription carries
 * `message_template_status_update`, `message_template_quality_update`,
 * `phone_number_quality_update`, `account_update`, `account_alerts`, `account_review_update` and
 * `security` — every one of them `active`, pointing at this district's own endpoint. So each of
 * those arrived, verified its signature, was answered 200, and was **discarded without a line in
 * the log**.
 *
 * That is the third instance of one shape in three days: the quick-reply tap (19 August), an
 * officer's photograph (21 August), and now this. **Meta sends it, nothing reads it, nobody finds
 * out.** The lesson is not about any one field — it is that a webhook handler which reads only
 * what it expects has no way of reporting what it did not.
 *
 * ## Why this matters more than it looks
 *
 * `api/dashboard.ts`'s condition panel already argues the case, in its own words: those rows are
 * there because they **fail silently**, and it names *"a template somebody un-approved"* as one
 * of the three. It then had no way to know. `Can send WhatsApp` was folded from how many of
 * **our own sends** succeeded in the last day — so a template Meta paused this morning reads as a
 * perfectly quiet night until the first send after it, and that send is at 02:00.
 */
export interface AccountNotice {
  /**
   * Which kind of thing this is about, because the three fail differently and lead to three
   * different actions: resubmit a template, appeal a number, or ring Meta about the account.
   */
  readonly kind: 'template' | 'number' | 'account';
  /** The template's name, or the number, or the account. */
  readonly subject: string;
  /**
   * Meta's own word — `APPROVED`, `PAUSED`, `REJECTED`, `FLAGGED`, `RED`.
   *
   * **Verbatim, never paraphrased**, for the reason `readError` already gives about provider
   * errors: this is the string somebody pastes into a Meta console to find out more, and a
   * translated one is a state nobody can look up.
   */
  readonly event: string;
  /** How bad it is. See {@link severityOf} — the mapping lives in one place on purpose. */
  readonly severity: 'ok' | 'warn' | 'critical';
  /** Meta's reason, when it gives one. Null is ordinary — an approval says nothing beyond itself. */
  readonly detail: string | null;
}

/**
 * How bad Meta's own word is, and **this is the only place that decides**.
 *
 * Written as a lookup rather than as a condition at each call site because the same word arrives
 * under four different fields — `PAUSED` on a template, `FLAGGED` on a number — and a screen that
 * re-derived severity from the string would eventually disagree with the log line about the same
 * notice.
 *
 * ⚠️ **An unrecognised word is `warn`, never `ok`.** Meta adds vocabulary without asking, and the
 * costly direction of that guess is obvious: a new word for *your account is restricted* read as
 * fine is exactly the silent failure this whole file exists to end. A false amber row is a
 * question somebody asks; a false green one is a district that finds out at 02:00.
 */
function severityOf(event: string): AccountNotice['severity'] {
  const word = event.trim().toUpperCase();

  // Everything is fine and says so. Kept explicit rather than defaulted, so that adding a word
  // here is a decision somebody makes rather than something that happens by falling through.
  if (
    word === 'APPROVED' ||
    word === 'UNFLAGGED' ||
    word === 'GREEN' ||
    word === 'VERIFIED' ||
    word === 'ACCOUNT_RESTORED' ||
    word === 'ONBOARDING'
  ) {
    return 'ok';
  }

  // The district cannot send on this, now.
  if (
    word === 'PAUSED' ||
    word === 'REJECTED' ||
    word === 'DISABLED' ||
    word === 'FLAGGED' ||
    word === 'RED' ||
    word === 'ACCOUNT_VIOLATION' ||
    word === 'ACCOUNT_RESTRICTION' ||
    word === 'DISABLED_UPDATE' ||
    word === 'ACCOUNT_DELETED' ||
    word === 'BANNED'
  ) {
    return 'critical';
  }

  return 'warn';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Turn one non-`messages` change into a notice, or nothing.
 *
 * **Returns null rather than guessing.** Meta publishes fields this district is subscribed to and
 * does not act on — `calls`, `phone_number_name_update` — and inventing a row for them would put
 * amber on a wall over something nobody needs to do anything about, which is how a district
 * learns to ignore amber.
 */
function noticeOf(field: string, value: Readonly<Record<string, unknown>>): AccountNotice | null {
  if (field === 'message_template_status_update') {
    const name = text(value['message_template_name']);
    const event = text(value['event']);
    if (name === null || event === null) return null;
    const language = text(value['message_template_language']);
    return {
      kind: 'template',
      subject: language === null ? name : `${name} (${language})`,
      event,
      severity: severityOf(event),
      detail: text(value['reason']),
    };
  }

  /**
   * A template's **quality**, which is a different thing from its status and is the early warning.
   *
   * Meta pauses a template after enough people block or report messages on it. The quality score
   * going yellow is the district's only chance to notice before that happens — and it arrives on
   * its own field, which is why this is not folded into the branch above.
   */
  if (field === 'message_template_quality_update') {
    const name = text(value['message_template_name']);
    const score = text(value['new_quality_score']);
    if (name === null || score === null) return null;
    const language = text(value['message_template_language']);
    const was = text(value['previous_quality_score']);
    return {
      kind: 'template',
      subject: language === null ? name : `${name} (${language})`,
      event: score,
      severity: severityOf(score),
      detail: was === null ? 'quality score' : `quality score, was ${was}`,
    };
  }

  if (field === 'phone_number_quality_update') {
    const event = text(value['event']);
    if (event === null) return null;
    const number = text(value['display_phone_number']);
    const limit = text(value['current_limit']);
    return {
      kind: 'number',
      subject: number ?? 'the district’s number',
      event,
      severity: severityOf(event),
      // The messaging tier rides along, because a flagged number is usually a *lowered* tier and
      // the district's next question is always "how many can we still reach today".
      detail: limit === null ? null : `messaging limit ${limit}`,
    };
  }

  if (field === 'account_update' || field === 'account_review_update') {
    const event = text(value['event']);
    if (event === null) return null;
    const ban = value['ban_info'];
    const violation = value['violation_info'];
    const reason =
      typeof ban === 'object' && ban !== null
        ? text((ban as Record<string, unknown>)['ban_state'])
        : typeof violation === 'object' && violation !== null
          ? text((violation as Record<string, unknown>)['violation_type'])
          : null;
    return {
      kind: 'account',
      subject: 'the WhatsApp business account',
      event,
      severity: severityOf(event),
      detail: reason,
    };
  }

  /**
   * Meta's own alerts, which carry their severity rather than a state word.
   *
   * Read last because it is the vaguest of the five: the payload is a description meant for a
   * human, and `alert_severity` is the only structured thing on it.
   */
  if (field === 'account_alerts') {
    const type = text(value['alert_type']);
    const status = text(value['alert_status']);
    if (type === null) return null;
    const level = (text(value['alert_severity']) ?? '').toUpperCase();
    return {
      kind: 'account',
      subject: `alert: ${type}`,
      event: status ?? level ?? 'ALERT',
      // Meta grades these itself, and its own grading is better than guessing from the words.
      severity: level === 'CRITICAL' ? 'critical' : level === 'WARNING' ? 'warn' : 'warn',
      detail: text(value['alert_description']),
    };
  }

  return null;
}

export interface WebhookContents {
  readonly statuses: readonly StatusUpdate[];
  readonly replies: readonly InboundReply[];
  /**
   * What Meta says about the district's own account — 2026-08-21.
   *
   * Empty on every ordinary webhook, which is nearly all of them: these arrive when something
   * changes at Meta rather than when a message moves. See {@link AccountNotice}.
   */
  readonly notices: readonly AccountNotice[];
}

/**
 * Which of Meta's five envelopes carried a file, and what was in it — 2026-08-21.
 *
 * **One function rather than five branches**, because the five differ only in the key they sit
 * under: every one of them carries `id`, `mime_type` and `sha256`, and reading them separately
 * would be the same code written five times, free to gain a bug in one of them.
 *
 * `voice` and `audio` are kept apart, and that is the one distinction worth making. Meta uses a
 * separate key for a message recorded by holding the microphone button, and the district's
 * record should be able to say *a voice note* — an officer speaking from a vehicle — rather than
 * flatten it into *audio*, which is also what a forwarded file is.
 *
 * `sticker` is read for completeness and will almost never appear. It costs one entry in a
 * table, and the alternative is the failure this whole change exists to end: an inbound Meta
 * sends, this file does not read, and nobody finds out because there is no log line for a
 * message that was never parsed.
 */
const MEDIA_KINDS = [
  ['image', 'image'],
  ['video', 'video'],
  ['voice', 'voice'],
  ['audio', 'audio'],
  ['document', 'document'],
  ['sticker', 'sticker'],
] as const;

function mediaOf(m: Readonly<Record<string, unknown>>): InboundMedia | undefined {
  for (const [key, kind] of MEDIA_KINDS) {
    const raw = m[key];
    if (typeof raw !== 'object' || raw === null) continue;

    const envelope = raw as {
      id?: unknown;
      mime_type?: unknown;
      sha256?: unknown;
      filename?: unknown;
    };

    // No id is no file. Meta always sends one; an envelope without it is something this code
    // does not understand, and inventing a download for it would be worse than skipping it.
    if (typeof envelope.id !== 'string' || envelope.id.trim() === '') continue;

    return {
      mediaId: envelope.id.trim(),
      mimeType:
        typeof envelope.mime_type === 'string' && envelope.mime_type.trim() !== ''
          ? envelope.mime_type.trim()
          : 'application/octet-stream',
      sha256:
        typeof envelope.sha256 === 'string' && envelope.sha256.trim() !== ''
          ? envelope.sha256.trim()
          : null,
      filename:
        typeof envelope.filename === 'string' && envelope.filename.trim() !== ''
          ? envelope.filename.trim()
          : null,
      kind,
    };
  }

  return undefined;
}

/**
 * The caption on whichever envelope carried the file.
 *
 * Only three of the five can have one — Meta accepts a caption on an image, a video and a
 * document, and not on a voice note or a sticker. Reading all five would be harmless and would
 * also be a claim about Meta's API that is not true, so it reads the three.
 */
function captionOf(m: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['image', 'video', 'document'] as const) {
    const raw = m[key];
    if (typeof raw !== 'object' || raw === null) continue;
    const caption = (raw as { caption?: unknown }).caption;
    if (typeof caption === 'string' && caption.trim() !== '') return caption;
  }
  return undefined;
}

/**
 * A pin, read defensively — Phase 6.
 *
 * Refuses anything that is not two finite numbers **in Meta's own range**. This is somebody else's
 * JSON on a public endpoint: a latitude of 900, or a string, or a `NaN` produced by dividing a
 * missing value, would be written onto an emergency as a place a crew could be sent to. A refusal
 * costs the district a pin; a bad one costs it a journey.
 */
function locationOf(raw: Readonly<Record<string, unknown>> | undefined): InboundLocation | null {
  if (raw === undefined) return null;

  const latitude = Number(raw['latitude']);
  const longitude = Number(raw['longitude']);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const words = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : null;

  return {
    latitude,
    longitude,
    name: words(raw['name']),
    address: words(raw['address']),
  };
}

/**
 * Pull the statuses and replies out of a webhook body.
 *
 * Defensive to the point of dullness, and deliberately so: this is parsing somebody else's
 * JSON, on a public endpoint, and an exception here is a webhook Meta retries for hours. An
 * entry that cannot be understood is skipped and the rest of the batch is still applied — the
 * same rule `api/protocol.ts` follows for a sync batch, and for the same reason: during an
 * outage one message may be the only record that somebody was told.
 */
export function readWebhook(body: unknown): WebhookContents {
  const statuses: StatusUpdate[] = [];
  const replies: InboundReply[] = [];
  const notices: AccountNotice[] = [];

  // `null` is an object in JavaScript and reading a property off it throws — which on this
  // endpoint means a 500, which means Meta retries for hours onto the machine that is also
  // taking emergency reports. `JSON.parse('null')` is exactly how it arrives.
  if (typeof body !== 'object' || body === null) return { statuses, replies, notices };

  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return { statuses, replies, notices };

  for (const entry of entries as readonly unknown[]) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes as readonly unknown[]) {
      const value = (change as { value?: unknown }).value as
        | {
            statuses?: unknown;
            messages?: unknown;
          }
        | undefined;
      if (value === undefined) continue;

      /**
       * **Which kind of change this is, and until 2026-08-21 nothing looked.**
       *
       * Every webhook Meta sends carries `field`, and this loop read `value.messages` and
       * `value.statuses` regardless of it — so a paused template, a flagged number and an
       * account restriction all arrived, verified, answered 200, and were dropped in silence.
       * See {@link AccountNotice} for how long that had been true and for the two identical
       * defects before it.
       *
       * `messages` falls through to the code below, exactly as it always did. Everything else
       * is offered to `noticeOf`, which returns null for the fields this district is subscribed
       * to and does not act on — a row for `calls` would put amber on a wall over something
       * nobody needs to do anything about.
       */
      const field = (change as { field?: unknown }).field;
      if (typeof field === 'string' && field !== 'messages') {
        const notice = noticeOf(field, value as Readonly<Record<string, unknown>>);
        if (notice !== null) notices.push(notice);
        // Nothing else on a non-`messages` change can carry a reply or a status, and reading it
        // as though it might is how a shape nobody has seen becomes a row nobody can explain.
        continue;
      }

      if (Array.isArray(value.statuses)) {
        for (const raw of value.statuses as readonly unknown[]) {
          const s = raw as {
            id?: unknown;
            status?: unknown;
            errors?: { title?: string; message?: string; code?: number }[];
          };
          if (typeof s.id !== 'string') continue;
          if (
            s.status !== 'sent' &&
            s.status !== 'delivered' &&
            s.status !== 'read' &&
            s.status !== 'failed'
          ) {
            continue;
          }

          const error = s.errors?.[0];
          statuses.push({
            providerMessageId: s.id,
            status: s.status,
            failure:
              error === undefined
                ? null
                : [
                    error.title,
                    error.message,
                    error.code === undefined ? null : `code ${String(error.code)}`,
                  ]
                    .filter((p): p is string => typeof p === 'string' && p !== '')
                    .join(' · '),
          });
        }
      }

      if (Array.isArray(value.messages)) {
        for (const raw of value.messages as readonly unknown[]) {
          const m = raw as {
            from?: unknown;
            timestamp?: unknown;
            type?: unknown;
            text?: { body?: unknown };
            button?: { text?: unknown; payload?: unknown };
            interactive?: {
              button_reply?: { title?: unknown; id?: unknown };
              list_reply?: { title?: unknown; id?: unknown };
            };
            /**
             * The five envelopes a file arrives in — 2026-08-21.
             *
             * All five carry the same three things under different keys, which is why `mediaOf`
             * reads them with one function rather than five. `voice` is Meta's own separate kind
             * and not a flag on `audio`, so the district can tell an officer who spoke from a
             * file somebody forwarded.
             */
            image?: unknown;
            video?: unknown;
            audio?: unknown;
            voice?: unknown;
            document?: unknown;
            sticker?: unknown;
            /** Which message this one answers, when the officer used the reply control. */
            context?: { id?: unknown };
            /** Meta's own id for THEIR message — Phase 7, and the only thing `markRead` needs. */
            id?: unknown;
            /** A dropped pin, or a place the sender chose — Phase 6. */
            location?: {
              latitude?: unknown;
              longitude?: unknown;
              name?: unknown;
              address?: unknown;
            };
            /** An emoji on one of our own messages — Phase 6. */
            reaction?: { message_id?: unknown; emoji?: unknown };
          };
          if (typeof m.from !== 'string') continue;

          /**
           * **A quick-reply tap, which until 2026-08-19 was read as nothing at all.**
           *
           * Meta delivers a tap on a template's quick reply as an ordinary inbound message with
           * `type: "button"` and **no `text` field** — so the guard below dropped it silently.
           * With `district_notice_v2` and `district_emergency_v2` approved, that meant an officer
           * could tap *Attending*, see their answer sitting in their own WhatsApp thread, and the
           * board would carry them for ever as somebody nobody had reached.
           *
           * `button.text` is the words on the button; `payload` is what the template was approved
           * with and is the same string here, because these templates set no separate payload.
           * Text first: it is what the officer actually saw, and the record should say what they
           * saw rather than what the template author called it.
           *
           * `interactive.button_reply` is read too, and it is not speculative — it is the shape a
           * tap arrives in when a message is sent as an interactive one rather than as a template.
           * Nothing here sends those today. It costs one line and it means the district's first
           * interactive message is not also its first silently-dropped answer.
           */
          const button = m.button ?? {};
          /**
           * The id rides beside the words, never instead of them — Phase C.
           *
           * The **text** is still what goes onto the incident, because the record should say what
           * the officer actually saw. The id decides what the tap *does*. Keeping both means a
           * button can be reworded without changing what it means, which is the exact property
           * `TemplateShape.quickReplies` exists because Meta's buttons do **not** have.
           */
          /**
           * A **list** row is read exactly as a button is — Phase C2.
           *
           * The two arrive under different keys and mean the same thing: the officer chose one of
           * the things this software offered, and the id says which. Meta splits them because a
           * list is opened before it is answered; nothing downstream cares, and treating them
           * apart would mean every handler written twice for a distinction the record does not
           * make.
           */
          const chosen = m.interactive?.button_reply ?? m.interactive?.list_reply;

          const replyId =
            typeof chosen?.id === 'string' && chosen.id.trim() !== '' ? chosen.id : undefined;
          const tappedText =
            typeof button.text === 'string' && button.text.trim() !== ''
              ? button.text
              : typeof button.payload === 'string' && button.payload.trim() !== ''
                ? button.payload
                : typeof chosen?.title === 'string' && chosen.title.trim() !== ''
                  ? chosen.title
                  : null;

          /**
           * **A file, which until 2026-08-21 was dropped here without a word in the log.**
           *
           * The comment this replaces said a media id the district cannot open would be a row
           * that looks like a reply and is not one, and it was right. The answer was to make the
           * district able to open it — see {@link InboundMedia} — rather than to keep discarding
           * an officer's answer.
           */
          const media = mediaOf(m);

          /**
           * **A pin, and until 2026-08-21 it was dropped with the words** — Phase 6.
           *
           * Both degrees are required and both must be **finite numbers**: Meta sends them as
           * numbers, but this is somebody else's JSON on a public endpoint, and a `NaN` written
           * onto an incident is a location nobody can go to that reads exactly like one they can.
           * `name` and `address` are absent on a raw pin, which is the commonest case.
           */
          const location = locationOf(m.location);

          /**
           * **An emoji on one of our messages** — Phase 6, and the removal is the case that
           * matters. See {@link InboundReaction}: Meta reports taking a reaction off as the same
           * shape with an empty `emoji`, and reading that as an answer records an officer's change
           * of mind as an acknowledgement.
           */
          const reactionEmoji =
            typeof m.reaction?.emoji === 'string' && m.reaction.emoji.trim() !== ''
              ? m.reaction.emoji.trim()
              : null;
          const reactedTo =
            typeof m.reaction?.message_id === 'string' && m.reaction.message_id.trim() !== ''
              ? m.reaction.message_id.trim()
              : null;
          // Both halves or neither. An emoji attached to nothing cannot be matched to an incident,
          // and a message id with no emoji is the removal above.
          const reaction = reactionEmoji !== null && reactedTo !== null ? reactionEmoji : null;

          /**
           * A caption rides on the same message as the picture, and it is the officer's words.
           *
           * Read from whichever envelope carried the file, because Meta puts it there rather
           * than in `text`. A photograph captioned *"road is clear now"* is one answer, not two,
           * and splitting it would put the words on the incident and the picture somewhere else.
           */
          const captioned = media === undefined ? undefined : captionOf(m);

          const typed = m.text?.body ?? captioned;
          const text =
            tappedText ?? (typeof typed === 'string' && typed.trim() !== '' ? typed : null);

          /**
           * **Nothing readable, no file, no pin and no emoji** — a contact card, a sticker Meta
           * could not describe, a message shape this version has never seen. Skipped.
           *
           * ⚠️ **This guard has now been widened three times and each widening was a defect being
           * closed**, which is the thing to notice rather than any one of the four exceptions. A
           * message with a file and no caption joined it on 21 August; a pin and an emoji join it
           * here. Every one of them was **an officer answering**, dropped in silence, while the
           * board went on carrying them as somebody nobody had reached.
           *
           * The lesson is `AccountNotice`'s, in a second place: **a handler that reads only what
           * it expects has no way of reporting what it did not.** Before widening it a fourth
           * time, consider logging the shapes that fall through here instead.
           */
          if (
            (text === null || text.trim() === '') &&
            media === undefined &&
            location === null &&
            reaction === null
          ) {
            continue;
          }

          /**
           * Carried whether or not anything can be made of it — resolving it needs the database,
           * and this file is the transport. See `InboundReply.contextMessageId`.
           */
          /**
           * ⚠️ **A reaction's own `message_id` IS the context, and it outranks `context.id`.**
           * Meta does not send a `context` on a reaction — the thing being reacted to is named
           * inside `reaction` — so without this line the strongest match this system ever gets
           * would fall back to *"the most recent alert to that number"*, which is the guess it
           * exists to replace.
           */
          const contextMessageId =
            reactedTo !== null && reaction !== null
              ? reactedTo
              : typeof m.context?.id === 'string' && m.context.id.trim() !== ''
                ? m.context.id.trim()
                : undefined;

          const seconds = Number(m.timestamp);
          replies.push({
            fromPhone: toE164(m.from),
            text: text === null ? '' : text.trim().slice(0, 2000),
            at: Number.isFinite(seconds)
              ? new Date(seconds * 1000).toISOString()
              : new Date().toISOString(),
            tapped: tappedText !== null,
            messageId: typeof m.id === 'string' && m.id.trim() !== '' ? m.id.trim() : null,
            ...(replyId === undefined ? {} : { replyId }),
            ...(media === undefined ? {} : { media }),
            ...(location === null ? {} : { location }),
            ...(reaction === null ? {} : { reaction: { emoji: reaction } }),
            ...(contextMessageId === undefined ? {} : { contextMessageId }),
          });
        }
      }
    }
  }

  return { statuses, replies, notices };
}
