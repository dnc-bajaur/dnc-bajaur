/**
 * The one description of the message this district sends — M6-26.
 *
 * ## Why this file exists at all
 *
 * A WhatsApp template is approved **once** and changed slowly. The district submits wording to
 * Meta, waits for a review, and from then on the software may send exactly that shape and
 * nothing else: the right number of body parameters, in the right order, with a URL button or
 * without one. Get it wrong and every send fails — not at submission, not in a test, but **at
 * 02:00 on the first real night**, with a provider error nobody in a district office can read.
 *
 * `CLAUDE.md` §5 says in as many words that the template approval is where the surprise will be.
 * This file is the answer to that: **the sender and the checker read the same definition**, so
 * "what the code sends" and "what we asked Meta to approve" cannot drift into disagreeing.
 * `scripts/doctor.mjs` compares this against the template Meta actually approved and refuses to
 * call the installation ready when they differ.
 *
 * ## Why the wording is what it is
 *
 * Meta's own rules and this project's rules point the same way here:
 *
 *   * **A `utility` template, not `marketing`.** Utility templates are for a transaction or an
 *     event the recipient is party to, which is what this is, and they are priced and rate
 *     limited accordingly. Submitted as marketing, a district's emergency alerts would be
 *     throttled as advertising.
 *   * **Nothing about a caller, ever.** These messages land on officers' personal handsets and
 *     stay in their history for months. Capability 12 keeps citizen contact detail out of
 *     anything that leaves this system, and a WhatsApp message leaves it entirely.
 *   * **The acknowledge link is a button, not text in the body.** One tap on a handset, and it
 *     is the thing that actually meets the obligation (ADR-0014). A URL pasted into body text
 *     is a link somebody has to long-press.
 *   * **No time, no severity word in the fixed part.** Everything that varies is a parameter.
 *     A template whose fixed text says "URGENT" is a template that cannot be used for the
 *     routine half of the district's traffic, and one approved template is easier to keep than
 *     two.
 */

/** What Meta must have approved, and what `sendWhatsApp` builds against. */
export interface TemplateShape {
  /** The name submitted to Meta. Lowercase and underscores — Meta refuses anything else. */
  readonly name: string;
  /** As approved. `en` and `en_US` are different templates to Meta, and mixing them 404s. */
  readonly language: string;
  readonly category: 'UTILITY';
  /** Body parameters, in order. The count is what a mismatch is detected on. */
  readonly body: readonly { readonly what: string; readonly example: string }[];
  /**
   * Whether the approved template carries a dynamic URL button, and **where it sits**.
   *
   * `index` is the button's position in the approved `BUTTONS` component, and it is here because
   * of `district_emergency_v2` — the first template this district approved where the acknowledge
   * link is **not** the first button. Meta identifies a button parameter by position and nothing
   * else, so a send that names index `0` against a template whose quick reply is first attaches
   * the token to the quick reply. Meta refuses the message, and it refuses it for every message
   * on that template, not only the one that got it wrong.
   *
   * It was hardcoded as `'0'` at the call site until 2026-08-19, which was true of every template
   * this district had approved until that day and is a fact about the template rather than about
   * the sender — so it now lives beside the name it belongs to.
   */
  readonly urlButton: {
    readonly label: string;
    readonly base: string;
    readonly index: number;
  } | null;
  /**
   * The quick-reply buttons the template was approved with, **in the approved order** — 2026-08-19.
   *
   * Empty on every template the district sent on before that date, and empty is not the same as
   * unknown: these carry no parameters and are never built into a send, so nothing here changes
   * what is posted to Meta. They are declared so that `templateProblems` can say *the wording on
   * the button an officer taps has changed* — which is the one way this pair breaks without any
   * send ever failing, because a tap arrives back as its own label and `webhooks.ts` records those
   * words on the incident.
   */
  readonly quickReplies: readonly string[];
  /**
   * The media header the template was approved with, if any — M10-29.
   *
   * ⚠️ **This is a property of the approved template and never a switch.** Meta refuses **every**
   * message on a template whose components do not match what was approved — so a header sent to a
   * body-only template fails the emergencies too, not only the message that carried a file. That
   * is why it lives here, beside the name it belongs to, rather than in a boolean somebody can set
   * against the wrong template.
   *
   * `null` is the ordinary case and the one Bajaur has been sending on since August.
   */
  readonly header: 'IMAGE' | null;
  /**
   * The body wording to submit, when it is **not** {@link ALERT_TEMPLATE_TEXT}.
   *
   * Every template Bajaur sent on before the response workflow carries the same three-line body,
   * held in one place so a human pastes one thing into Meta's form. The 2026 category-response
   * templates carry their own shorter body instead (no Acknowledge line, no option list — the
   * three buttons say what the options are), so their wording lives here — still static text at
   * both ends (Meta refuses a body that starts or ends with a parameter), still `{{1}}` then
   * `{{2}}` in the middle, still the same two parameters `body` names.
   *
   * `undefined` means *use `ALERT_TEMPLATE_TEXT`*, which is every template that predates this.
   */
  readonly bodyText?: string;
  /**
   * **This template's own static text already says what kind of thing this is** — 2026-09-05.
   *
   * True only for `responseTemplateV2`'s six shapes (`security`, `flood`, `other`, `alert`,
   * `advisory`, `order`), whose `bodyText` opens `Deputy Commissioner Bajaur — Flood Alert` (or
   * `District Alert`, `District Advisory`, …) before `{{1}}` ever renders. A control room read
   * that header and then `{{1}}` repeating it — `ALERT · other · high` under `District Alert` —
   * and asked why a message said *Alert* twice. `messageFor` reads this flag to drop the kind and
   * category out of `{{1}}` on exactly these templates, leaving severity alone; every other
   * template's `{{1}}` is the *only* place that says what this is, and keeps saying it.
   *
   * `undefined`/falsy elsewhere, including `responseTemplate`'s six plain shapes (`fire`,
   * `road_accident`, `medical`, `rescue`, `schedule`, `information`) — their header is the
   * generic `Deputy Commissioner Bajaur - District Nerve Center`, which names no kind or category
   * for `{{1}}` to repeat.
   */
  readonly namesKindInHeader?: boolean;
}

/**
 * The district's alert template.
 *
 * **Change this and the district must submit a new template to Meta and wait for review.** It
 * is not a string to tune — it is a contract with somebody else's approval queue, which is why
 * the shape lives beside the reasoning rather than inline at the call site.
 */
export const ALERT_TEMPLATE: TemplateShape = {
  /**
   * **Renamed on 2026-08-06 (M7-24), before the district submitted anything.**
   *
   * It was `district_emergency_alert`, and the district then asked for advisories, alerts and
   * orders to go out through the same machinery (M7-23). One template serves all four, so the
   * district submits **one** thing to Meta and waits **once** — a second template is a second
   * approval queue, a second rejection to read and a second thing to keep in step.
   *
   * The rename is free today and would have been expensive in a fortnight: a template's name is
   * fixed at approval, and an advisory arriving from something called "emergency alert" is a
   * message officers learn to discount.
   *
   * **Now `_v3`, since 2026-08-18 — the third name and the second replacement.** `district_message`
   * carried `I have this`; `_v2` carried `Acknowledged` and is what Bajaur sent on from 14 August;
   * `_v3` carries `Acknowledge` and ends `Please Acknowledge Below`. **Each was a new submission
   * rather than an edit**, because editing an approved template returns it to `PENDING` and
   * whether Meta keeps serving the previous version during that review is not something this
   * project knows — so an edit risks a district that cannot send at all for minutes to days.
   *
   * The old names are not reused and not deleted at Meta; they simply stop being named here.
   */
  name: 'district_message_v3',
  language: 'en',
  category: 'UTILITY',
  /**
   * **A subject line and a body, and neither is named after emergencies.**
   *
   * These used to be *"what happened, and how serious"* and *"where, in plain words"*, and the
   * approved text said `Location: {{2}}` — which would have trapped the template. An advisory
   * about a road closure has no location worth a labelled line, and an order has none at all;
   * both would have gone out with `Location: place not stated`, which reads as the software
   * being broken rather than as the message being a different kind of thing.
   *
   * Generic parameters mean the **software** decides what a message of each kind says, in code
   * that can be changed in an afternoon, rather than in wording that needs Meta's review.
   */
  body: [
    { what: 'the subject line — what this is', example: 'EMERGENCY · Road accident · critical' },
    {
      what: 'the message itself, in plain words',
      example: 'Khar Road, near the bypass. Two vehicles, injuries reported.',
    },
  ],
  /**
   * **`base` is a placeholder, and it is written so that it cannot be mistaken for one that
   * works.** It used to read `https://dnc.example.gov.pk/ack/`, which is the shape of a real
   * Pakistani government address — so it was submitted to Meta, approved, and sent to officers
   * for as long as the district had a template, and every acknowledge button was dead. Nothing
   * reported a fault: the send succeeded, `doctor` said the template matched, and the only
   * symptom was a browser saying `DNS_PROBE_FINISHED_NXDOMAIN` on somebody's handset.
   *
   * This is §7's own rule — *a placeholder must be visibly a placeholder* — broken in the one
   * file where the placeholder leaves the building. `{PUBLIC_ORIGIN}` is not a valid host, so
   * the same mistake now fails at the point it is made rather than at the point it is read.
   *
   * The real value belongs to the installation, not to the source: use {@link ackBase}, which
   * is what `doctor` compares Meta's approved button against.
   */
  /**
   * **`Acknowledge`, not `Acknowledged` — O-26 closed in the owner's own direction, 2026-08-18.**
   *
   * The two live templates differed by a letter for four days: `district_message_v2` said
   * `Acknowledged` and `district_message_img` said `Acknowledge`, and the standing instruction is
   * that a live template is not edited. `_v3` and `_img_v2` were submitted together so the pair
   * agrees, and this is the switch that makes it true in the software.
   *
   * ⚠️ **This is the WhatsApp button's label and nothing else.** *Acknowledged* is also the second
   * of the district's four words (`domain/stages.ts`), and that one does not move — a stage in the
   * ledger and a word on a button are different things that happened to share a spelling.
   */
  urlButton: { label: 'Acknowledge', base: '{PUBLIC_ORIGIN}/ack/', index: 0 },
  /** The only button on it, so the acknowledge link is first by having nothing to be second to. */
  quickReplies: [],
  /** Body and buttons only. This is what Bajaur has been sending on since August. */
  header: null,
};

/**
 * The district's alert template **with a picture on it** — M10-26, M10-29.
 *
 * **Now `_img_v2`, since 2026-08-18.** `district_message_img` was submitted 2026-08-14 and carried
 * the 105-character closing sentence; `_img_v2` was submitted 2026-08-17 alongside `_v3` and ends
 * `Please Acknowledge Below`. Everything else about it is `ALERT_TEMPLATE` except one thing: it
 * carries an `IMAGE` header.
 *
 * **The body is byte-identical to `ALERT_TEMPLATE`'s, and that was not a coincidence.** It was
 * read back from the Graph API before submission rather than retyped, so a message reads the same
 * whether or not a photograph rode with it.
 *
 * ✅ **O-26 is closed, and the pair now agrees.** For four days `district_message_v2` said
 * `Acknowledged` while `district_message_img` said `Acknowledge`, and the standing instruction —
 * a live template is not edited — meant the difference had to be waited out rather than fixed.
 * `_v3` and `_img_v2` were submitted as a pair so that both read `Acknowledge`, and switching to
 * them is what retires the discrepancy instead of documenting it again.
 *
 * **There is deliberately no document template.** The owner chose images only, so a PDF travels
 * as a link permanently — which is what promotes the three fixes in `3f70f4d` from a fallback to
 * the load-bearing path.
 */
export const ALERT_TEMPLATE_IMAGE: TemplateShape = {
  name: 'district_message_img_v2',
  language: 'en',
  category: 'UTILITY',
  body: ALERT_TEMPLATE.body,
  urlButton: { label: 'Acknowledge', base: '{PUBLIC_ORIGIN}/ack/', index: 0 },
  quickReplies: [],
  header: 'IMAGE',
};

/**
 * **The two templates an officer can answer with a tap — approved 2026-08-19.**
 *
 * ## What is actually new here, and it is not the wording
 *
 * Every template before these carried a **URL button**, so answering meant leaving WhatsApp: the
 * handset opens an in-app browser, resolves `dnc.example.com`, and renders a page — on a
 * district signal, at 02:00, on whatever handset an officer happens to own. The tap is one
 * gesture and everything after it is a network round trip that can fail, and when it fails the
 * officer has answered and the board does not know.
 *
 * A **quick reply** costs no round trip on the officer's side. The tap becomes an inbound message
 * on the district's own webhook — the same path a typed reply already travels (M6-23) — so the
 * answer arrives over a connection the district controls rather than one the officer's browser
 * has to make. `readWebhook` reads it and `recordReply` records it.
 *
 * ## Why two templates and not one
 *
 * Because the district asks two different questions and only one of them is *"did you get this"*.
 *
 *   * An emergency asks to be **acknowledged** — one answer, and it stops a clock.
 *   * A meeting asks whether somebody is **coming** — and *"Not attending"* is a real answer that
 *     the old template had no way to give. An officer who could not attend either replied in
 *     words or said nothing, and saying nothing is indistinguishable from not having read it.
 *
 * ⚠️ **Neither replaces `ALERT_TEMPLATE`, and the district is not moved onto them by this file.**
 * They are named in `.env` per installation, exactly like the picture template, because a
 * template is approved once and changed slowly (M6-26) and switching every message the district
 * sends is a decision the district makes rather than one an upgrade makes for them.
 */

/**
 * *"Sending someone"* — re-exported from the domain, never restated here.
 *
 * The district asks a **second question** when this one is tapped, so `webhooks.ts` has to
 * recognise the answer, and a tap comes back as **nothing but the words on the button**. Those
 * words are now declared once, in `domain/attendance.ts`, because two things need them for two
 * different reasons: this file because Meta approved them and `doctor` compares them, and the
 * attendance tally because they are the only thing that says which answer a tap was.
 *
 * ⚠️ **Reword it at Meta without changing the domain constant and two things break at once, both
 * silently:** the follow-up stops being asked, and the tally stops counting that answer. Nothing
 * fails, no line is logged, and the district goes on believing it knows who is coming.
 * `npm run doctor` is what notices, by reading the approved buttons back from the Graph API.
 */
import { ATTENDANCE_ANSWERS } from '../domain/attendance.js';
export { SENDING_SOMEONE as SUBSTITUTE_REPLY } from '../domain/attendance.js';

/**
 * **The quick reply that means an officer is coming in person** — the first answer on
 * `district_notice_v2`.
 *
 * Re-exported here for `SUBSTITUTE_REPLY`'s reason and no other: `api/webhooks.ts` matches an
 * inbound tap against these words so it can send the district's *"kindly make it convenient to
 * attend"* back. ⚠️ *Sending someone* and *Not attending* each open a follow-up question and are
 * answered at the end of it; *Attending* asks nothing, so without this it was answered with
 * **nothing at all** — a tap on a handset that looked like a message that failed to send.
 */
export { ATTENDING as ATTENDING_REPLY } from '../domain/attendance.js';

/**
 * **The quick reply that means an officer is not coming** — the district's workflow, §9,
 * 2026-08-24.
 *
 * Re-exported here for `SUBSTITUTE_REPLY`'s reason and no other: `api/webhooks.ts` matches an
 * inbound tap against these words, and the words belong to the domain while **which template
 * carries them** belongs to this file. ⚠️ The button itself is unchanged and unchangeable —
 * it is approved at Meta by position on `district_notice_v2`. What is new is that the
 * district now asks **why**.
 */
export { NOT_ATTENDING as DECLINED_REPLY } from '../domain/attendance.js';

/**
 * The meeting template — `district_notice_v2`, three ways to answer and **no link at all**.
 *
 * ⚠️ **`urlButton: null` is the load-bearing line.** This template was approved with three
 * quick replies and nothing else, so a send that attaches an acknowledge token has a parameter
 * for a button that does not exist — and Meta refuses the whole message. `templateFor` is what
 * makes that unreachable: the button component is built from this shape rather than assumed.
 *
 * The token is still minted for a message on this template, and that is deliberate rather than
 * waste. It expires unused in 24 hours, and minting it keeps the one ordering that matters
 * intact (`whatsappChannel.ts`): the ledger's attempt exists before anything is sent, whichever
 * template it goes out on.
 *
 * **Meetings only, by `templateFor`.** *"Attending"* is not an answer to a schedule or to a
 * notice about a road closure, and offering it on one teaches officers that the buttons do not
 * mean what they say.
 */
export const NOTICE_TEMPLATE: TemplateShape = {
  name: 'district_notice_v2',
  language: 'en',
  category: 'UTILITY',
  /** The same two parameters, so `messageFor` needs no second shape to build. */
  body: ALERT_TEMPLATE.body,
  /**
   * **`Please Answer Below`, not `Please Acknowledge Below`** — the owner's own wording,
   * 2026-08-18 (`docs/whatsapp-template.md`, `CLAUDE.md` §5): a meeting is not being
   * acknowledged, it is being answered. Left unset until 2026-09-04, which cost nothing a send
   * could feel — a send transmits only the two parameters, never the template's static text, so
   * every message this shape ever sent read correctly regardless. It matters now because
   * {@link NOTICE_TEMPLATE_IMAGE} inherits whichever wording is declared here, and *that* is what
   * a human reads back from `npm run submit:template`'s dry run.
   *
   * Written out rather than derived from {@link ALERT_TEMPLATE_TEXT}: that constant is declared
   * later in this file, and a `const` referencing it here would read before it exists.
   */
  bodyText: `District Nerve Center — Bajaur

{{1}}

{{2}}

Please Answer Below`,
  urlButton: null,
  /**
   * **In the approved order, because a tap comes back as nothing but its own words.**
   *
   * `webhooks.ts` writes what the officer tapped onto the incident, so these three strings are
   * the record the district reads afterwards. Change one at Meta without changing it here and
   * the check goes quiet while the board starts carrying a word nobody chose.
   *
   * *"Sending someone"* is the third because the district asked for it: a DEO who cannot come but
   * is sending a deputy has answered the question, and a two-button template would have recorded
   * that officer as absent.
   */
  /**
   * **Built from the domain's list rather than typed out**, so the words the district offers and
   * the words Meta approved cannot drift apart. Spread into a mutable array because
   * `TemplateShape.quickReplies` is `readonly string[]` and `ATTENDANCE_ANSWERS` is a tuple of
   * literals — the order is preserved, and the order is load-bearing (Meta matches by position).
   */
  quickReplies: [...ATTENDANCE_ANSWERS],
  header: null,
};

/**
 * *"Acknowledge"*, named — because tapping it now **starts a conversation** rather than ending one.
 *
 * Since Phase C the district answers this tap with the rest of the lifecycle, as buttons, inside
 * the officer's own thread. So the same rule as `SUBSTITUTE_REPLY` applies and applies harder:
 * this string is **Meta's**, a tap comes back as nothing but the words on the button, and
 * rewording it at Meta without changing it here stops the follow-up being offered at all — no
 * error, no log line, and an officer who acknowledged an emergency and was then handed nothing.
 *
 * ⚠️ **This is the WhatsApp button's label and nothing else.** *Acknowledged* is also the second
 * of the district's four stages (`domain/stages.ts`), and that one does not move — the same
 * warning `urlButton.label` already carries, for the same pair of words.
 */
export const ACKNOWLEDGE_REPLY = 'Acknowledge';

/**
 * The emergency template — `district_emergency_v2`, a tap **and** a link, in that order.
 *
 * ⚠️ **The acknowledge link is the second button here, and that is the trap this pair carries.**
 * Meta identifies a button parameter by position, so the `index: 1` below is not a detail — sent
 * as `0` the token attaches to the quick reply, Meta refuses the message, and it refuses every
 * message on this template until somebody notices. `sendWhatsApp` reads the index from here for
 * exactly that reason.
 *
 * **Both routes reach the same obligation and either may arrive first.** An officer can tap
 * *Acknowledge* and then open *Open details* out of curiosity, and both land: the quick reply as
 * an inbound message, the link as a token redemption. Nothing needs to be deduplicated for that
 * to be safe — `appendAcknowledgement` refuses a second `acknowledged` event on an incident that
 * has one, and `markObligationMet` only settles attempts that are still pending. The second
 * arrival records that it happened and changes nothing, which is the honest outcome.
 *
 * The URL button is labelled **`Open details`** rather than `Acknowledge`, and the rename is the
 * point rather than cosmetic: with a quick reply beside it, a link labelled *Acknowledge* offers
 * two buttons that claim to do the same thing and an officer has to guess which one counts.
 */
export const EMERGENCY_TEMPLATE: TemplateShape = {
  name: 'district_emergency_v2',
  language: 'en',
  category: 'UTILITY',
  body: ALERT_TEMPLATE.body,
  urlButton: { label: 'Open details', base: '{PUBLIC_ORIGIN}/ack/', index: 1 },
  quickReplies: [ACKNOWLEDGE_REPLY],
  header: null,
};

/**
 * **The photograph template that can be ANSWERED — `district_message_img_v3`, submitted
 * 2026-08-25 on the owner's instruction: *"agar Meta sai new template approve karwana hai tou
 * bhi submit kr du"*.**
 *
 * ## What this is for
 *
 * `district_message_img_v2` carries a picture and a **link**, and a link is the one button that
 * answers nothing. Meta opens its 24-hour service window only when the officer **sends**
 * something; a tap on a URL button sends nothing at all. So an emergency that happened to carry
 * a photograph was the one kind of message after which the district could not put a single
 * further message in front of that officer — no options, no follow-up question, no closing
 * sentence. Every other kind reached the workflow inside WhatsApp on 2026-08-25; this one could
 * not, because **a media header with a quick reply on it is a new submission to Meta** and no
 * amount of code changes what somebody else already approved.
 *
 * This is `EMERGENCY_TEMPLATE` with a picture on it, and deliberately nothing else. The body is
 * `ALERT_TEMPLATE.body` — the same two parameters every template in this file has carried since
 * August — so a message reads the same whether or not a photograph rides with it, and
 * `messageFor` needs no second shape to build.
 *
 * ## 🔴 The link is the SECOND button here and `_img_v2`'s was the first
 *
 * Meta identifies a button parameter by **position and nothing else**. Point
 * `WHATSAPP_TEMPLATE_IMAGE` at this name while anything still sends index `0` and the
 * acknowledge token attaches to the **quick reply** — Meta then refuses **every** message on
 * this template, emergencies included, until somebody reads a provider error at 02:00. That is
 * why `templateFor` resolves the index from {@link shapeNamed} by the configured **name** rather
 * than assuming the shape of whichever picture template was current when it was written.
 *
 * ## ⚠️ Nothing sends on this until the district names it, and that is the point
 *
 * Declaring it here changes no send. `WHATSAPP_TEMPLATE_IMAGE` still names `_img_v2` in Bajaur,
 * and it stays that way until Meta approves this one — the owner's instruction was explicit:
 * *"ju chal rahe hain abhi unko cherrne ki zarurt nhe hai, jub template approve ho jaega tou
 * phir hum laga denge"*. Approval is per template and reviewed separately, so the district can
 * go on sending photographs on `_img_v2` for as long as the review takes, and **a rejection
 * costs nothing** — `_img_v2` is not edited, not resubmitted and not deleted by any of this.
 *
 * Submit it with `npm run submit:template -- --name district_message_img_v3`, which refuses to
 * touch a template that already exists.
 */
export const ALERT_TEMPLATE_IMAGE_V3: TemplateShape = {
  name: 'district_message_img_v3',
  language: 'en',
  category: 'UTILITY',
  body: ALERT_TEMPLATE.body,
  /** 🔴 `index: 1` — second, because the quick reply is first. See above. */
  urlButton: { label: 'Open details', base: '{PUBLIC_ORIGIN}/ack/', index: 1 },
  quickReplies: [ACKNOWLEDGE_REPLY],
  /** The whole reason this is a separate submission rather than a line in `.env`. */
  header: 'IMAGE',
};

/**
 * **The 2026 category-response templates — one per emergency category, meeting excluded.**
 *
 * The district's *Official WhatsApp Response Workflow* removes the Acknowledge step: an officer's
 * first interaction is the response itself, as three quick-reply buttons approved on the template.
 * Every one carries the same body and differs only in its three button labels — the buttons say
 * what the options are, so the body does not repeat them (the owner's call, 2026-09-01: a numbered
 * list above three tappable buttons reads as *type a number*, which WhatsApp quick replies are
 * not). Meeting is absent — `district_notice_v2` already offers its three answers directly, and
 * the district asked for it to be left alone.
 *
 * ⚠️ **Submitted ahead of the send path, exactly like `ALERT_TEMPLATE_IMAGE_V3`.** Nothing routes
 * a category alert onto these yet; `npm run submit:template` puts them in front of Meta so the
 * review — days — runs in parallel with wiring `answersFor`/`templateFor` to send on them. Until
 * a `.env` line names one, `doctor` ignores it and Bajaur sends exactly as it does today.
 *
 * ⚠️ **A button label is what a tap comes back as.** These labels and the option catalogue in
 * `domain/responseOptions.ts` must stay in step: reword one at Meta and `webhooks.ts` silently
 * starts writing different words onto the incident, with no send ever failing.
 */
const RESPONSE_OPENER =
  'Deputy Commissioner Bajaur - District Nerve Center\n\n{{1}}\nLocation: {{2}}';
const RESPONSE_CLOSER = 'Please tap one of the buttons below to respond.';

function responseTemplate(name: string, labels: readonly [string, string, string]): TemplateShape {
  return {
    name,
    language: 'en',
    category: 'UTILITY',
    /** The same two parameters as every other template, so `messageFor` needs no second shape. */
    body: ALERT_TEMPLATE.body,
    /** Static text at both ends, `{{1}}` then `{{2}}` between — Meta refuses a body that ends on a parameter. */
    bodyText: `${RESPONSE_OPENER}\n\n${RESPONSE_CLOSER}`,
    /** No link at all, like `NOTICE_TEMPLATE` — the answer IS the interaction. */
    urlButton: null,
    quickReplies: [...labels],
    header: null,
  };
}

/**
 * **The 2026-09 resubmission — a per-category body for the six categories Meta reclassified.**
 *
 * `advisory`, `alert`, `flood`, `order`, `other` and `security` were submitted as `UTILITY` on the
 * shared {@link responseTemplate} wording and Meta moved all six to `MARKETING` — the classifier
 * reads only the static body text and the button labels, and that shared body names no event, no
 * reason the recipient got it and no ongoing obligation, so it scores as a broadcast. Their `_v2`
 * shapes name the message **type** in the first line and the **obligation** in the last, with
 * concrete action-verb buttons — every readable signal pushed toward `UTILITY`.
 *
 * The middle is unchanged: `{{1}}` then `Location: {{2}}`, the same two parameters `body` names,
 * static text at both ends. The six categories that Meta left `UTILITY` — `fire`, `medical`,
 * `road_accident`, `rescue`, `information`, `schedule` — keep their approved `_v1` shapes below.
 */
function responseTemplateV2(
  name: string,
  typeLine: string,
  closer: string,
  labels: readonly [string, string, string],
): TemplateShape {
  return {
    name,
    language: 'en',
    category: 'UTILITY',
    body: ALERT_TEMPLATE.body,
    bodyText: `Deputy Commissioner Bajaur — ${typeLine}\n\n{{1}}\nLocation: {{2}}\n\n${closer}`,
    urlButton: null,
    quickReplies: [...labels],
    header: null,
    // This header names the kind already — see `TemplateShape.namesKindInHeader`.
    namesKindInHeader: true,
  };
}

/** In the order the workflow document lists the categories. `meeting` is deliberately not here. */
export const RESPONSE_TEMPLATES: readonly TemplateShape[] = [
  responseTemplateV2(
    'dnc_response_security_v2',
    'Security Alert',
    'This security matter has been assigned to you for action. Please review the details above and confirm your response using a button below.',
    ['Security Deployed', 'Coordinating w/ Dept', 'Being Handled'],
  ),
  responseTemplate('dnc_response_fire_v1', [
    'Fire Team Dispatched',
    'Coordinating w/ Dept',
    'Being Handled',
  ]),
  responseTemplate('dnc_response_road_accident_v1', [
    'Response Team Sent',
    'Coordinating w/ Dept',
    'Being Attended',
  ]),
  responseTemplate('dnc_response_medical_v1', [
    'Medical Aid Arranged',
    'Coord w/ Health Dept',
    'Aid Already Provided',
  ]),
  responseTemplateV2(
    'dnc_response_flood_v2',
    'Flood Alert',
    'This flood situation has been assigned to you for action. Please review the details above and confirm your response using a button below.',
    ['Relief Team Sent', 'Coordinating w/ Dept', 'Being Handled'],
  ),
  responseTemplate('dnc_response_rescue_v1', [
    'Rescue Aid Arranged',
    'Coordinating w/ Dept',
    'Operation Underway',
  ]),
  responseTemplateV2(
    'dnc_response_other_v2',
    'District Communication',
    'This matter has been referred to you for action. Please review the details above and confirm your response using a button below.',
    ['Action Taken', 'Coordinating w/ Dept', 'Already Handled'],
  ),
  responseTemplateV2(
    'dnc_response_alert_v2',
    'District Alert',
    'This alert has been issued to you and requires your acknowledgement. Please review the details above and confirm your response using a button below.',
    ['Acting on Alert', 'Coordinating w/ Dept', 'Being Handled'],
  ),
  responseTemplateV2(
    'dnc_response_advisory_v2',
    'District Advisory',
    'This advisory has been issued to you and requires your acknowledgement. Please review the details above and confirm your response using a button below.',
    ['Acting on Advisory', 'Conveyed to Dept', 'Already Addressed'],
  ),
  responseTemplateV2(
    'dnc_response_order_v2',
    'Official Order',
    'This official order has been issued to you for action. Please review the details above and confirm your response using a button below.',
    ['Received & Acting', 'Action Completed', 'Unable to Act'],
  ),
  responseTemplate('dnc_response_schedule_v1', [
    'Schedule Accepted',
    'Coord. Accordingly',
    'Unable to Follow',
  ]),
  responseTemplate('dnc_response_information_v1', [
    'Received & Acting',
    'Conveyed to Dept',
    'Already Addressed',
  ]),
];

/**
 * **The `dnc_response_*` shape for each category slug, keyed the way the send path asks for it.**
 *
 * `templateFor` (`ops/whatsapp.ts`) is handed a category slug — `fire`, `road_accident`, … — by
 * `whatsappChannel.ts`, and needs the template's *name* and *language* for that category without
 * caring whether it is the `_v1` that stayed `UTILITY` or the `_v2` that was resubmitted. The
 * name in `RESPONSE_TEMPLATES` already carries the version; this map strips the `dnc_response_`
 * prefix and the `_v<n>` suffix so a caller keys on the category alone.
 *
 * ⚠️ **The slugs here must match `domain/responseOptions.ts`'s `TemplateCategory`** — one is the
 * template shape, the other is what a tap on it comes back as, and `whatsappTemplate.test.ts`
 * asserts the two catalogues agree label for label.
 */
export const RESPONSE_TEMPLATE_BY_CATEGORY: ReadonlyMap<string, TemplateShape> = new Map(
  RESPONSE_TEMPLATES.map((shape) => {
    const slug = shape.name.replace(/^dnc_response_/, '').replace(/_v\d+$/, '');
    return [slug, shape] as const;
  }),
);

/**
 * The `dnc_response_*` shape for a category slug, or `undefined` for one this source has never
 * heard of — the caller then sends on `WHATSAPP_TEMPLATE` exactly as it did before.
 */
export function responseTemplateFor(category: string): TemplateShape | undefined {
  return RESPONSE_TEMPLATE_BY_CATEGORY.get(category);
}

/**
 * Whether `category`'s own `dnc_response_*` template already names the kind in its static
 * header — see `TemplateShape.namesKindInHeader`. `false` for a category with no response
 * template at all, which is the honest answer: nothing there to repeat against.
 */
export function categoryNamesKindInHeader(category: string): boolean {
  return responseTemplateFor(category)?.namesKindInHeader === true;
}

/**
 * The literal Meta writes before `{{2}}` on every `dnc_response_*` shape, and on nothing else.
 *
 * Kept as a constant so {@link categoryLabelsLocation} and the bodies above cannot drift: a
 * template whose wording is edited here stops matching, and the send falls back to the ordering
 * every other template uses rather than putting a place under a label that is no longer there.
 */
const LOCATION_LABEL = 'Location: {{2}}';

/**
 * Whether `category`'s own `dnc_response_*` template writes `Location: ` immediately before its
 * second parameter — 2026-09-08.
 *
 * **Read off the approved body text rather than declared as a flag**, unlike
 * `namesKindInHeader`. The label is not a property somebody remembers to set; it is a fact about
 * the twelve strings above, and reading it from them is what stops a thirteenth template from
 * silently sending a description under a `Location:` heading — the exact defect this answers.
 *
 * `false` for a category with no response template at all: that message goes out on
 * `WHATSAPP_TEMPLATE`, whose body has no such label and whose second parameter has read as free
 * prose since the district's first send.
 */
export function categoryLabelsLocation(category: string): boolean {
  const shape = responseTemplateFor(category);
  if (shape === undefined) return false;
  /**
   * An absent `bodyText` means *this shape sends on {@link ALERT_TEMPLATE_TEXT}* — see the field's
   * own note — and that wording carries no label at all, so the fallback answers `false` on its
   * own rather than needing a special case. Read inside the function because the constant is
   * declared further down this file.
   */
  return (shape.bodyText ?? ALERT_TEMPLATE_TEXT).includes(LOCATION_LABEL);
}

/**
 * **The "Administration & Directives" picture templates — meeting, advisory, order, schedule,
 * information — 2026-09-04, the owner's own line.**
 *
 * Every other template that carries a picture also carries only `Acknowledge` / `Open details`,
 * because that is the one shape Meta has ever approved with a media header. The owner drew a
 * line rather than asking for all of them: `fire`, `medical`, `road_accident`, `rescue`,
 * `security`, `flood`, `alert` and `other` keep sending a photograph as an ordinary file link —
 * *"baki categories ki sath beshak link mai image jaye agar attach ho"* — while these five keep
 * their own tap-to-answer buttons **with the picture riding in the message**, not behind a link.
 *
 * Each is the district's existing shape, unchanged in body and buttons, with an `IMAGE` header
 * added and a new name — new, because a live template is never edited (M6-26): editing one
 * returns it to `PENDING` and risks the district being unable to send at all while Meta reviews
 * it. **Declared here and nowhere wired to a send** — exactly `ALERT_TEMPLATE_IMAGE_V3`'s own
 * pattern: `npm run submit:template` puts each one in front of Meta, and nothing in `ops/
 * whatsapp.ts` reaches for it until a `.env` line names it, which is only sensible once Meta has
 * approved it. Days of review, sometimes minutes — but the district's photographs travel exactly
 * as they did this morning for every one of these five until that line is written.
 */
function imageVariant(base: TemplateShape, name: string): TemplateShape {
  return { ...base, name, header: 'IMAGE' };
}

/** The meeting's attendance template, with a picture on it. Not yet submitted to Meta. */
export const NOTICE_TEMPLATE_IMAGE: TemplateShape = imageVariant(
  NOTICE_TEMPLATE,
  'district_notice_img_v1',
);

/**
 * Which category slugs get a picture-carrying `dnc_response_*` template — the owner's line, not
 * a technical one. Every category in {@link RESPONSE_TEMPLATE_BY_CATEGORY} could have one; these
 * five are the ones asked for.
 */
const IMAGE_CAPABLE_CATEGORIES = ['advisory', 'order', 'schedule', 'information'] as const;

/**
 * The four category shapes above, each with a picture on it — not yet submitted to Meta.
 *
 * `RESPONSE_TEMPLATE_BY_CATEGORY.get(slug)` is asserted rather than checked: every slug in
 * {@link IMAGE_CAPABLE_CATEGORIES} is typed as one of `RESPONSE_TEMPLATES`'s own categories, so a
 * miss here is a typo in this file rather than something a caller could ever trigger.
 */
export const RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY: ReadonlyMap<string, TemplateShape> = new Map(
  IMAGE_CAPABLE_CATEGORIES.map((slug) => {
    const base = RESPONSE_TEMPLATE_BY_CATEGORY.get(slug);
    if (base === undefined) {
      throw new Error(
        `whatsappTemplate.ts: no dnc_response_* shape for "${slug}" to add a picture to`,
      );
    }
    return [slug, imageVariant(base, `dnc_response_${slug}_img_v1`)] as const;
  }),
);

export const RESPONSE_IMAGE_TEMPLATES: readonly TemplateShape[] = [
  ...RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY.values(),
];

/**
 * The picture-carrying `dnc_response_*` shape for a category slug, or `undefined` for one the
 * owner did not ask for a picture template on — the caller then sends the photograph as a file
 * link instead, on whichever template the category already answers on.
 */
export function responseImageTemplateFor(category: string): TemplateShape | undefined {
  return RESPONSE_IMAGE_TEMPLATE_BY_CATEGORY.get(category);
}

/**
 * The sign-in link — ADR-0043, Bajaur E5.
 *
 * A login was made for an officer; the button lets them set their own password. One parameter,
 * the officer's name, so the message is plainly theirs on a shared handset. The link is the
 * button, as with the acknowledge link: Meta appends the token to the approved prefix, so the
 * prefix must be exactly `{PUBLIC_ORIGIN}/set-password/`.
 *
 * Utility, like the rest: it is about an account the recipient has, not an offer.
 */
export const LOGIN_LINK_TEMPLATE: TemplateShape = {
  name: 'dnc_bajaur_login_link',
  language: 'en',
  category: 'UTILITY',
  body: [{ what: "the officer's name", example: 'Amina Khan' }],
  urlButton: { label: 'Set my password', base: '{PUBLIC_ORIGIN}/set-password/', index: 0 },
  quickReplies: [],
  header: null,
  bodyText: `District Nerve Center — Bajaur

{{1}}, a login to the district's Activities app has been made for you.

Tap the button below to choose your own password. The link works once and stops working after 3 days. If you did not expect this message, ignore it.`,
};

/**
 * Respond — ADR-0044 §6, Bajaur. A message from the DC office to the officer who sent an
 * Activities post, for when Meta's 24-hour window is shut (inside it, a plain message goes and no
 * template is needed).
 *
 * Two parameters: the date of the post, so the officer knows which one, and the message itself.
 * No button — the answer is a reply, which comes back to the post. The fixed text says **what
 * this is and what it is not**: it must never read as an alert, and static text at both ends is
 * what Meta requires anyway.
 *
 * ⚠️ A template parameter may not hold a line break, a tab or more than four spaces in a row —
 * Meta refuses the whole message — so `sendActivityResponse` puts the message on one line.
 */
export const ACTIVITY_RESPONSE_TEMPLATE: TemplateShape = {
  name: 'dnc_bajaur_activity_response',
  language: 'en',
  category: 'UTILITY',
  body: [
    { what: 'the date of the post', example: '3 October 2026' },
    {
      what: 'the message from the DC office',
      example: 'Good work. Please also send the staff attendance for that day.',
    },
  ],
  urlButton: null,
  quickReplies: [],
  header: null,
  bodyText: `District Nerve Center — Bajaur

Activities — a message from the DC office about your post of {{1}}:

{{2}}

This is not an emergency alert. To answer, reply to this message.`,
};

/**
 * **Every template shape this file declares, by the name Meta knows it as.**
 *
 * ⚠️ **This exists so that a name in `.env` and a button position in the source cannot
 * disagree.** Until 2026-08-25 the sender read the picture template's button index straight off
 * `ALERT_TEMPLATE_IMAGE` — correct for exactly as long as `_img_v2` was the only picture
 * template that existed, and wrong the moment a district pointed `WHATSAPP_TEMPLATE_IMAGE` at
 * one whose link is second. The failure is total and silent in advance: Meta refuses every
 * message on that template, and the district finds out at 02:00.
 *
 * `undefined` for a name this source has never heard of, which is the honest answer for a
 * district that approved something under its own name — the caller then falls back to the shape
 * it documents, exactly as it did before.
 */
export function shapeNamed(name: string): TemplateShape | undefined {
  return [
    ALERT_TEMPLATE,
    ALERT_TEMPLATE_IMAGE,
    ALERT_TEMPLATE_IMAGE_V3,
    NOTICE_TEMPLATE,
    NOTICE_TEMPLATE_IMAGE,
    EMERGENCY_TEMPLATE,
    LOGIN_LINK_TEMPLATE,
    ACTIVITY_RESPONSE_TEMPLATE,
    ...RESPONSE_TEMPLATES,
    ...RESPONSE_IMAGE_TEMPLATES,
  ].find((shape) => shape.name === name);
}

/**
 * The prefix the approved URL button must carry, for this installation.
 *
 * One function so that the sender, the checker and the wording a human pastes into Meta cannot
 * disagree about it — the same reason this whole file exists. Meta **appends** the `{{1}}`
 * parameter to this prefix rather than replacing it, so the template holds the origin and the
 * send holds only the token.
 */
export function ackBase(publicOrigin: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/ack/`;
}

/**
 * The wording to submit, exactly.
 *
 * Kept as text rather than assembled from the shape above, because **this is what a human pastes
 * into Meta's form** and it has to be readable on its own. The two are held together by
 * `templateProblems`, which counts the `{{n}}` markers here against `body` above.
 *
 * Read it once as an officer at 02:00 would: it says which district, what happened, where, and
 * gives one tap that answers. It does not say "please" and it does not say the officer's name —
 * both cost a line on a lock screen and neither changes what anybody does next.
 */
export const ALERT_TEMPLATE_TEXT = `District Nerve Center — Bajaur

{{1}}

{{2}}

Please Acknowledge Below`;

/**
 * **The fixed text says nothing about emergencies, and that is the whole of M7-24.**
 *
 * It used to read `Location: {{2}}`. One word, and it would have made this template usable for
 * exactly one of the four kinds of thing the district sends — so an advisory would have needed
 * a second template, a second submission and a second wait, and the district would have
 * discovered that after the first approval rather than before it.
 *
 * *"If you cannot act on it"* replaced *"if you cannot attend"* for the same reason: nobody
 * attends an advisory.
 */

export interface TemplateProblem {
  readonly what: string;
  readonly fix: string;
}

/**
 * What Meta actually approved, in the shape their API returns it.
 *
 * Deliberately loose: this is somebody else's JSON, fetched from a public API, and a field they
 * rename must produce a *report* rather than an exception. A checker that throws is a checker
 * somebody stops running.
 */
export interface ApprovedTemplate {
  readonly name?: unknown;
  readonly language?: unknown;
  readonly status?: unknown;
  readonly category?: unknown;
  readonly components?: unknown;
}

function componentsOf(template: ApprovedTemplate): readonly Record<string, unknown>[] {
  return Array.isArray(template.components)
    ? (template.components as readonly Record<string, unknown>[])
    : [];
}

/**
 * Compare what Meta approved against what this software sends.
 *
 * **Every one of these is a send that would fail on the first real night**, and each returns the
 * sentence that tells somebody in a district office what to do about it — not a provider error
 * code, which is what they would otherwise be reading at 02:00.
 *
 * An empty list means the template will work. It does not mean the message is good; a human
 * still has to read the wording, which is why the district reviews it before submission (M6-26).
 */
export function templateProblems(
  approved: ApprovedTemplate | null,
  expected: TemplateShape = ALERT_TEMPLATE,
): readonly TemplateProblem[] {
  if (approved === null) {
    return [
      {
        what: `No template called "${expected.name}" in "${expected.language}" exists on this account`,
        fix:
          'Submit it in WhatsApp Manager → Message templates. The exact wording is in ' +
          'docs/whatsapp-template.md. Approval usually takes minutes to a day.',
      },
    ];
  }

  const problems: TemplateProblem[] = [];

  /**
   * Status first, because everything below is noise if it was rejected.
   *
   * `PENDING` is not a failure — it is the ordinary state for a few hours after submission, and
   * saying "wait" is more useful than saying "broken".
   */
  const status = String(approved.status ?? 'UNKNOWN').toUpperCase();
  if (status === 'REJECTED') {
    problems.push({
      what: 'Meta rejected this template',
      fix:
        'Open WhatsApp Manager → Message templates and read the rejection reason. The usual ' +
        'cause is submitting it as MARKETING; it must be UTILITY.',
    });
  } else if (status === 'PENDING') {
    problems.push({
      what: 'Meta has not finished reviewing this template',
      fix: 'Nothing to do. Usually minutes to a day. Run this check again afterwards.',
    });
  } else if (status !== 'APPROVED') {
    problems.push({
      what: `Meta reports this template as "${status}"`,
      fix: 'Open WhatsApp Manager → Message templates and look at it.',
    });
  }

  const category = String(approved.category ?? '').toUpperCase();
  if (category !== '' && category !== expected.category) {
    /**
     * A real trap rather than a nicety.
     *
     * A `MARKETING` template is rate limited as advertising and priced as advertising, so a
     * district's emergency alerts would be throttled *and* cost more — and neither symptom
     * points at the category on the night it happens.
     */
    problems.push({
      what: `This template is categorised ${category}, not ${expected.category}`,
      fix:
        'Emergency alerts are a utility message. Marketing templates are rate limited and priced ' +
        'as advertising. Submit a new one with the category set to UTILITY.',
    });
  }

  const body = componentsOf(approved).find((c) => String(c['type'] ?? '').toUpperCase() === 'BODY');

  if (body === undefined) {
    problems.push({
      what: 'This template has no body',
      fix: 'Resubmit it using the wording in docs/whatsapp-template.md.',
    });
  } else {
    /**
     * The count of `{{n}}` markers, because that is what a send is validated against.
     *
     * Meta refuses the whole message when the parameter count differs by one — the commonest
     * way this breaks is somebody "tidying" the location line out of the template while the
     * software still sends two parameters.
     */
    const text = String(body['text'] ?? '');
    const markers = new Set(text.match(/\{\{\s*\d+\s*\}\}/g) ?? []);

    if (markers.size !== expected.body.length) {
      problems.push({
        what: `The template takes ${String(markers.size)} parameters; this software sends ${String(expected.body.length)}`,
        fix:
          `The two parameters are: ${expected.body.map((b, i) => `{{${String(i + 1)}}} ${b.what}`).join(', ')}. ` +
          'Meta refuses the whole message when the count differs, so this fails every send.',
      });
    }
  }

  const buttons = componentsOf(approved).find(
    (c) => String(c['type'] ?? '').toUpperCase() === 'BUTTONS',
  );
  const buttonList = Array.isArray(buttons?.['buttons'])
    ? (buttons['buttons'] as readonly Record<string, unknown>[])
    : [];
  const hasDynamicUrl = buttonList.some(
    (b) =>
      String(b['type'] ?? '').toUpperCase() === 'URL' && String(b['url'] ?? '').includes('{{1}}'),
  );

  /**
   * **Where the acknowledge button sits, which nothing checked until `district_emergency_v2`.**
   *
   * Every template before it had one button, so position could not be wrong. This one has a quick
   * reply first and the link second, and Meta identifies a button parameter by **position only** —
   * so a send naming the wrong index attaches the token to the quick reply and Meta refuses the
   * message. Not that message: **every** message on the template, emergencies included, until
   * somebody reads a provider error in a district office.
   *
   * Reported separately from *"there is no dynamic URL button"* above, because the fixes are
   * different things: one is a template missing a button, this one is the software counting from
   * the wrong end.
   */
  if (expected.urlButton !== null && hasDynamicUrl) {
    const at = buttonList.findIndex((b) => String(b['type'] ?? '').toUpperCase() === 'URL');

    if (at !== expected.urlButton.index) {
      problems.push({
        what:
          `The acknowledge button is button ${String(at + 1)} on the approved template; this ` +
          `software sends its parameter to button ${String(expected.urlButton.index + 1)}`,
        fix:
          'Meta matches a button parameter by position and nothing else, so this fails every ' +
          'send on this template — not only the one that got it wrong. Either reorder the ' +
          'buttons in WhatsApp Manager to match, or correct the index on this template in ' +
          'src/ops/whatsappTemplate.ts.',
      });
    }
  }

  /**
   * **The words on the buttons an officer taps.**
   *
   * A quick reply carries no parameter, so nothing about a send breaks when one is reworded at
   * Meta — which is exactly why this is worth checking. The tap arrives back as its own label and
   * `webhooks.ts` writes those words onto the incident, so a template quietly edited to say
   * *"Present"* instead of *"Attending"* changes the district's record with no error anywhere.
   *
   * Order matters and is compared as such: these buttons are read left to right on a handset, and
   * *Not attending* sitting first is a different message even though the set is the same.
   */
  if (expected.quickReplies.length > 0) {
    const approvedReplies = buttonList
      .filter((b) => String(b['type'] ?? '').toUpperCase() === 'QUICK_REPLY')
      .map((b) => String(b['text'] ?? ''));

    if (approvedReplies.join('|') !== expected.quickReplies.join('|')) {
      problems.push({
        what:
          `The quick-reply buttons read ${approvedReplies.map((r) => `"${r}"`).join(', ') || '(none)'}; ` +
          `this software expects ${expected.quickReplies.map((r) => `"${r}"`).join(', ')}`,
        fix:
          'A tap arrives back as the words on the button and those words are written onto the ' +
          'incident, so sends keep working while the district’s own record changes. Either ' +
          'restore the wording in WhatsApp Manager, or update quickReplies in ' +
          'src/ops/whatsappTemplate.ts to match what was approved.',
      });
    }
  }

  if (expected.urlButton !== null && !hasDynamicUrl) {
    problems.push({
      what: 'The template has no dynamic URL button',
      fix:
        'Add a button of type "Visit website" set to Dynamic, with the URL ' +
        `${expected.urlButton.base}{{1}} and the label "${expected.urlButton.label}". This ` +
        'button is the acknowledge link — without it an officer has no way to confirm they ' +
        'have an emergency, and every obligation stays unmet on the board.',
    });
  }

  /**
   * **The button's prefix, which nothing checked until 2026-08-12 — and this is the check that
   * would have caught the worst bug this system has had.**
   *
   * The template was approved with `https://dnc.example.gov.pk/ack/{{1}}` — a placeholder that
   * looks like a real government address. Every acknowledge button the district ever sent went
   * to a domain that does not exist. **Every part of the system reported success**: the send
   * returned 200, Meta reported the message delivered, and the check above passed, because it
   * only ever asked *is there a dynamic URL button* and never *does it point at us*.
   *
   * A button existing is not a button working. This compares the whole prefix, because the
   * failure is total either way: a wrong host resolves nowhere, and a right host with a wrong
   * path 404s. Both mean the officer taps and nothing happens, and the obligation stays unmet
   * on the board with no fault recorded anywhere (INV-03).
   */
  if (expected.urlButton !== null && hasDynamicUrl) {
    const approvedUrl = String(
      buttonList.find((b) => String(b['type'] ?? '').toUpperCase() === 'URL')?.['url'] ?? '',
    );
    const wanted = `${expected.urlButton.base}{{1}}`;

    if (approvedUrl !== wanted) {
      problems.push({
        what: `The acknowledge button points at ${approvedUrl}, not ${wanted}`,
        fix:
          'Meta appends the parameter to the URL the template was approved with, so this ' +
          'prefix is where every acknowledge link actually goes — the software only supplies ' +
          'the token. Edit the template in WhatsApp Manager → Message templates, set the ' +
          `button URL to ${wanted}, and resubmit it; a URL change needs review again. Until ` +
          'it is approved every officer who taps the acknowledge button reaches nothing, and the send ' +
          'still reports success.',
      });
    }
  }

  return problems;
}
