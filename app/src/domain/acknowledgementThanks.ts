/**
 * **What the district says back the moment an officer acknowledges** — their own words,
 * 2026-08-23.
 *
 * The district asked for one thing: *"jab bhi koi officer alert, emergency meeting etc etc k msg
 * ko acknowledge kr de tou un ko aik automated msg chala jaye"* — and they sent the three texts
 * themselves, split by what the message was about.
 *
 * ## Three texts, and they are the district's to write
 *
 * Every sentence below is **verbatim**, including the spacing they typed in the third one
 * (`Control Room/ District Nerve Center`) and the fact that the first names Bajaur before the
 * control room while the third names it after. Those are not typos to tidy — they are what a
 * Deputy Commissioner's office signed off, and an officer who reads two different phrasings on
 * two nights is reading exactly what the district sent. **Do not reword them without asking.**
 *
 * The telephone number is written here rather than pulled from config for the same reason it is
 * written in `.env` for the templates: there is one installation and the number is part of the
 * sentence, not a parameter of it. A second district changes this file, which is one file and a
 * grep away — as against a settings screen nobody would ever open twice.
 *
 * ## Why this is a function of the two labels the record already holds
 *
 * `carrying.ts`'s argument, applied again. The district described their three buckets as
 * *Alert/Advisory, Security, Flood* — *Meetings* — *Information*, which reads like a taxonomy
 * and is not: a security alert is **both** an alert and about security, and it keeps both labels.
 * So nothing here is stored, no event carries a "reply type", and there is no third place for a
 * message's subject to be recorded and start disagreeing with the other two.
 *
 * ⚠️ **`kind` is checked before `category`, and it is the opposite order from `laneOf`.** That
 * function answers *which word sits in the panel's first column*, where a room scanning for
 * floods wants **FLOOD** on a flood meeting. This one answers *what should this officer be told
 * to do*, and an officer summoned to a meeting about the flood should be told to attend the
 * meeting — not given the control room's number. The subject of the message and the act asked of
 * the reader are different questions, so the two orders are both right.
 *
 * ⚠️ **`emergency` and `order` take the urgent text, and the district did not list either.**
 * They named *Alert/Advisory, Security, Flood* — the things their General screen sends. An
 * emergency is the one message on this system where *"ring the control room"* is most obviously
 * the right sentence, and an order from the DC office carries the same expectation of contact if
 * something goes wrong. Filing them under *Information* on the grounds that nobody named them
 * would hand the wrong sentence to the most urgent message the district has. Written down for
 * the owner to confirm in `backlog/for-the-owner.md`.
 *
 * ⚠️ **`schedule` takes the information text.** A duty roster is not a meeting somebody is asked
 * to make it convenient to attend, and *"kindly attend the subject meeting"* against a week's
 * rota is a sentence that means nothing. `carrying.ts` records the same uncertainty about
 * `schedule` from the other side; the owner answers both at once.
 */

import type { MessageKind } from './events.js';

/** Which of the district's three sentences a message earns. */
export type ThanksKind = 'urgent' | 'meeting' | 'information';

/**
 * The district's three texts, verbatim.
 *
 * ⚠️ **Every one of these is sent as a free-form session message**, so it is bounded by Meta's
 * plain-body cap and not by a template's. All three are well inside it even with the lifecycle
 * sentence appended, and `sendSession` refuses anything that is not — the check is there rather
 * than here because a length is a property of the wire, not of what the district wanted to say.
 */
export const THANKS: Readonly<Record<ThanksKind, string>> = {
  urgent:
    'Thank you for the Acknowledgement.\n\n' +
    "In case of any emergency, feel free to contact Deputy Commissioner Bajaur's Control " +
    'Room/District Nerve Center on 0000-000000.',
  meeting:
    'Thank you for the Acknowledgement. Kindly make it convenient to attend the subject meeting.',
  information:
    'Thank you for the Acknowledgement. For further information, feel free to contact Deputy ' +
    'Commissioner Control Room/ District Nerve Center Bajaur on 0000-000000.',
};

/**
 * Which of the three this message is owed — the whole decision, in five lines.
 *
 * Total over every `MessageKind` and every category, on purpose: a kind added later falls to
 * `information`, which is the sentence that is merely unhelpful rather than the one that is
 * wrong. A new kind that genuinely needs the control room's number is a line here and a test.
 */
export function thanksKindFor(kind: MessageKind, category: string | null): ThanksKind {
  if (kind === 'meeting') return 'meeting';
  if (category === 'security' || category === 'flood') return 'urgent';
  if (kind === 'emergency' || kind === 'alert' || kind === 'advisory' || kind === 'order') {
    return 'urgent';
  }
  return 'information';
}

/** What to say back. */
export function acknowledgementThanks(kind: MessageKind, category: string | null): string {
  return THANKS[thanksKindFor(kind, category)];
}

/**
 * **The two sentences the response workflow added** — the district's own, 2026-08-24.
 *
 * Their *Official WhatsApp Response and Acknowledgement Workflow* moves the thank-you. Until now
 * an acknowledgement was answered with one of the three above and the conversation ended there.
 * Now it is answered with a **question** — the category's options, from `responseOptions.ts` — and
 * the closing sentence waits until the officer has picked one.
 *
 * ## Why that is two sentences and not one moved
 *
 * ⚠️ **Read their final message closely: it thanks the officer for their *response*, not their
 * acknowledgement.** Those are two different acts and the district wrote a sentence for the second
 * one only. If the whole thank-you simply waited for an answer, an officer who taps *Acknowledge*
 * at 02:00 and puts the phone down would receive **nothing at all** — which is worse than what
 * they get today, and it is the officers who are hardest pressed who would notice first.
 *
 * So the acknowledgement is thanked in the first line of the question, and their closing sentence
 * says what they wrote it to say. The owner approved this shape before any of it was built.
 *
 * ## ⚠️ This does not undo the rule of 2026-08-23, and the distinction is worth keeping straight
 *
 * That rule was *"action wale msgs nhe hote hain, just a thank you msg hote hain"* — **a thank-you
 * carries no buttons**, and `RESPONSE_THANKS` still carries none. What changed is that the first
 * message is no longer a thank-you at all. It is a question, and a question is allowed to carry
 * the controls that answer it. The rule holds in both directions, exactly as `offerNextStages`
 * already documents it from the other side.
 *
 * ## ⚠️ The three above are NOT deleted, and two of them are still reached
 *
 * `THANKS.meeting` is untouched, because `listFor` gives a meeting no list: its three answers are
 * approved at Meta and attendance owns that conversation. And all three remain the **fallback**
 * for the night Meta refuses the list or the service window has shut — on which the officer gets
 * exactly what they get today rather than silence. §9 Q10 of the design document asks the district
 * to confirm the replacement everywhere else; until they answer, nothing they signed off has been
 * thrown away.
 */
export const ACKNOWLEDGED_LINE = 'Thank you for the Acknowledgement.';

/**
 * The district's closing message, verbatim.
 *
 * ⚠️ **Their spacing and their wording, including `Control Room / District Nerve Center` with
 * spaces on both sides of the stroke** — where `THANKS.urgent` has none. Both are what a Deputy
 * Commissioner's office typed, on two different days, and an officer who reads two phrasings on
 * two nights is reading exactly what the district sent. **Do not tidy either without asking.**
 */
export const RESPONSE_THANKS =
  'Thank you for your response.\n\n' +
  "In case of any emergency, please contact the Deputy Commissioner Bajaur's Control Room / " +
  'District Nerve Center at 0000-000000.';

/**
 * The question that replaces the thank-you, for a message that has a list.
 *
 * The district's document specifies the options and never the sentence above them, so this is
 * ours — written in their register (*"The recipient shall select one of the following options"*)
 * and kept to two lines, because it lands on a locked handset under an alert somebody has just
 * acknowledged.
 */
export const CHOOSE_LINE = `${ACKNOWLEDGED_LINE}\n\nKindly select one:`;
