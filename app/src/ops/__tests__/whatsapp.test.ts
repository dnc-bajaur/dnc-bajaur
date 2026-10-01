/**
 * The WhatsApp transport — M6-18…M6-24, ADR-0014.
 *
 * Pure, and against a stubbed `fetch`, because everything worth testing here is a decision this
 * code makes about somebody else's answer rather than the network trip itself:
 *
 *   * **A signature that does not verify is refused before the body is read.** This is the only
 *     endpoint in the system reachable without a session, so the check is the entire perimeter —
 *     anybody able to forge one could mark every obligation in Bajaur as met, and the board would
 *     go quiet on a night when nothing was delivered at all.
 *   * **A rate limit is not a failure.** A new number is capped by Meta until its usage earns
 *     the tier up, and recording that as "nobody could be told" turns ninety seconds into a
 *     permanent hole in the district's record.
 *   * **A webhook that cannot be understood does not take the batch with it.** Meta retries any
 *     non-2xx for hours, onto the machine that is also accepting emergency reports.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  readWebhook,
  sendWhatsApp,
  toE164,
  verifySignature,
  whatsappFromEnv,
  type WhatsAppConfig,
} from '../whatsapp.js';

const config: WhatsAppConfig = {
  phoneNumberId: '123456',
  accessToken: 'token-not-real',
  appSecret: 'secret-not-real',
  verifyToken: 'verify-not-real',
  templateName: 'district_message',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
  // Off, as it is in production until Meta approves a template with a media header (M9-17).
};

function reply(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('numbers', () => {
  it('turns a Pakistani local number into the form Meta wants', () => {
    // The one place the server assumes a country, stated rather than hidden. `wa.me` links in
    // the client make the same assumption, and if it ever stops being true it stops being true
    // in exactly those two places.
    expect(toE164('0300-1112222')).toBe('923001112222');
    expect(toE164('+92 300 111 2222')).toBe('923001112222');
    expect(toE164('923001112222')).toBe('923001112222');
  });
});

describe('configuration', () => {
  it('is absent until every part of it is set', () => {
    // Half-configured is the dangerous state: the district would believe messages were going
    // out. Absent is honest, and the product is complete without it (R-05, R-19, R-20).
    expect(whatsappFromEnv({})).toBeNull();
    expect(
      whatsappFromEnv({
        WHATSAPP_PHONE_NUMBER_ID: '1',
        WHATSAPP_TOKEN: 't',
        WHATSAPP_APP_SECRET: 's',
        // No verify token.
      }),
    ).toBeNull();
  });

  it('reads a complete configuration', () => {
    const found = whatsappFromEnv({
      WHATSAPP_PHONE_NUMBER_ID: '1',
      WHATSAPP_TOKEN: 't',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
    });

    expect(found?.phoneNumberId).toBe('1');
    // A default template name, because a district that has not chosen one still needs the
    // request to be well-formed enough for Meta to say *which* template is missing.
    //
    // It tracks `ALERT_TEMPLATE`, which is the one description of what this district sends —
    // `_v3` since 2026-08-18. The default has moved twice now and both moves were new
    // submissions rather than edits, so an installation pinned to an older name keeps working
    // by setting `WHATSAPP_TEMPLATE` and changing nothing else.
    expect(found?.templateName).toBe('district_message_v3');
  });
});

describe('sending', () => {
  it('returns the provider id when Meta accepts it', async () => {
    const result = await sendWhatsApp(
      config,
      {
        toPhone: '03001112222',
        what: 'fire · high',
        where: 'Khar Road',
        ackToken: 'tok_abc123',
      },
      reply(200, { messages: [{ id: 'wamid.ABC' }] }),
    );

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.ABC' });
  });

  it('treats a rate limit as retryable, and an unapproved template as not', async () => {
    /**
     * The distinction M6-24 exists for. A capped number will accept the next message; an
     * unapproved template will never accept any. Collapsing them means either retrying
     * something that cannot work — a notification storm at a wall nothing gets through — or
     * recording a ninety-second cap as an emergency nobody could be told about.
     */
    const capped = await sendWhatsApp(
      config,
      { toPhone: '03001112222', what: 'x', where: 'y', ackToken: 'z' },
      reply(429, { error: { message: 'rate limit hit', code: 130_429 } }),
    );
    expect(capped).toMatchObject({ ok: false, retryable: true });

    const refused = await sendWhatsApp(
      config,
      { toPhone: '03001112222', what: 'x', where: 'y', ackToken: 'z' },
      reply(400, { error: { message: 'Template name does not exist', code: 132_001 } }),
    );
    expect(refused).toMatchObject({ ok: false, retryable: false });
    // Meta's own words, kept verbatim — a paraphrased provider error is one nobody can look up.
    expect(refused.ok === false && refused.failure).toContain('Template name does not exist');
  });

  it('fails a 200 that carried no message id', async () => {
    // Worth its own failure rather than a shrug: with no id, no webhook can ever be matched to
    // this attempt, so it would stay pending for ever while very possibly having arrived.
    const result = await sendWhatsApp(
      config,
      { toPhone: '03001112222', what: 'x', where: 'y', ackToken: 'z' },
      reply(200, { messages: [] }),
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.failure).toContain('no_message_id');
  });

  it('treats an unreachable provider as retryable rather than as a refusal', async () => {
    const result = await sendWhatsApp(
      config,
      { toPhone: '03001112222', what: 'x', where: 'y', ackToken: 'z' },
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    );

    // The district's line being down is not the district being unable to tell anybody, ever.
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});

describe('the webhook signature — M6-20', () => {
  const body = Buffer.from('{"entry":[]}', 'utf8');
  const good = `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;

  it('accepts Meta’s own signature', () => {
    expect(verifySignature(config.appSecret, body, good)).toBe(true);
  });

  it('refuses a forged one, a missing one and a malformed one', () => {
    // The entire perimeter of the one endpoint with no session behind it.
    expect(verifySignature(config.appSecret, body, 'sha256=deadbeef')).toBe(false);
    expect(verifySignature(config.appSecret, body, undefined)).toBe(false);
    expect(verifySignature(config.appSecret, body, 'not-a-signature')).toBe(false);
    expect(verifySignature(config.appSecret, body, 'sha256=zzzz')).toBe(false);
  });

  it('refuses a signature over different bytes', () => {
    // Why the raw body is verified rather than a re-serialised parse: a document that differs
    // from Meta's in key order or whitespace fails here, which is correct and is also what
    // would happen to *every genuine webhook* if the check were done after parsing.
    const other = Buffer.from('{"entry":[{}]}', 'utf8');
    expect(verifySignature(config.appSecret, other, good)).toBe(false);
  });
});

describe('reading a webhook — M6-21, M6-23', () => {
  it('pulls out the four states', () => {
    const { statuses } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.1', status: 'sent' },
                  { id: 'wamid.2', status: 'delivered' },
                  { id: 'wamid.3', status: 'read' },
                  {
                    id: 'wamid.4',
                    status: 'failed',
                    errors: [{ title: 'Re-engagement message', code: 131_047 }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(statuses.map((s) => s.status)).toEqual(['sent', 'delivered', 'read', 'failed']);
    expect(statuses[3]?.failure).toContain('Re-engagement message');
  });

  it('skips what it cannot understand and keeps the rest', () => {
    // Meta retries any non-2xx for hours, onto the machine also taking emergency reports. One
    // unrecognised entry must not cost the district a retry storm — the same rule the sync
    // protocol follows for a batch, and for the same reason.
    const { statuses } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.1', status: 'teleported' },
                  { status: 'delivered' },
                  { id: 'wamid.2', status: 'delivered' },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.providerMessageId).toBe('wamid.2');
  });

  it('returns nothing rather than throwing on a body that is not a webhook at all', () => {
    // `notices` joined this shape on 2026-08-21, when `readWebhook` started reading
    // `change.field`. The property here is unchanged and is the one that matters: an unusable
    // body produces EMPTY rather than an exception, because a throw on this endpoint is a 500
    // and Meta retries a 500 for hours onto the machine also taking emergency reports.
    const nothing = { statuses: [], replies: [], notices: [] };
    expect(readWebhook({})).toEqual(nothing);
    expect(readWebhook(null)).toEqual(nothing);
    expect(readWebhook({ entry: 'no' })).toEqual(nothing);
  });

  it('reads a text reply and normalises the sender’s number', () => {
    const { replies } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '923001112222', timestamp: '1780000000', text: { body: '  on my way ' } },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.fromPhone).toBe('923001112222');
    expect(replies[0]?.text).toBe('on my way');
  });

  /**
   * **This asserted the opposite until 2026-08-21, and the old reasoning is kept because it was
   * right about its own premise and wrong about the conclusion.**
   *
   * It read: *"A voice note or an image cannot be put on the incident as words, and storing a
   * media id the district cannot open would be a row that looks like a reply and is not one."*
   * True — and the answer was to make the district **able** to open it, not to go on discarding
   * an officer's answer. `downloadMedia` fetches the bytes and `ops/evidence.ts` stores them
   * against the incident, so the condition that sentence set is now met.
   *
   * What it cost while it stood was not a missing feature: an officer who photographed the scene
   * had answered, the message was dropped before anything looked at it, and the board carried
   * them for the rest of the district day as somebody nobody had reached.
   */
  it('reads a reply that carries a file and no words', () => {
    const { replies } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: { messages: [{ from: '923001112222', type: 'audio', audio: { id: 'x' } }] },
            },
          ],
        },
      ],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.media?.mediaId).toBe('x');
    // Empty rather than invented — `api/webhooks.ts` owns the words for a message with none.
    expect(replies[0]?.text).toBe('');
  });

  /**
   * **The guard was widened, not removed**, and this is the half that must not move.
   *
   * A reaction, a location, a contact card: nothing readable and no file. Skipped exactly as
   * before, because there is nothing to put on an incident and nothing to fetch.
   */
  it('still ignores a message carrying neither words nor a file', () => {
    const { replies } = readWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: '923001112222', type: 'reaction', reaction: { emoji: '👍' } }],
              },
            },
          ],
        },
      ],
    });

    expect(replies).toHaveLength(0);
  });
});

/**
 * The two templates an officer can answer with a tap — 2026-08-19.
 *
 * Everything here is about **which buttons are under the message and where their parameters go**,
 * because that is the half Meta refuses outright when it is wrong — and refuses for every message
 * on the template, not only the one that got it wrong. The words are `messageFor`'s business and
 * are tested there.
 */
describe('choosing a template — 2026-08-19', () => {
  /** Captures the body actually posted to Meta, which is the only thing under test here. */
  function capture(): { fetch: typeof fetch; sent: () => Record<string, unknown> } {
    let body: Record<string, unknown> = {};

    const impl = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    return { fetch: impl, sent: () => body };
  }

  function buttonOf(sent: Record<string, unknown>): Record<string, unknown> | undefined {
    const template = sent['template'] as { components: Record<string, unknown>[] };
    return template.components.find((c) => c['type'] === 'button');
  }

  function nameOf(sent: Record<string, unknown>): string {
    return (sent['template'] as { name: string }).name;
  }

  const message = { toPhone: '03001112222', what: 'x', where: 'y', ackToken: 'tok_1' };

  it('sends the acknowledge token to the SECOND button on the emergency template', async () => {
    /**
     * **The trap this whole change carries.** `district_emergency_v2` is the first template this
     * district approved whose acknowledge link is not the first button — a quick reply sits in
     * front of it. Meta matches a button parameter by position and nothing else, so an index of
     * `0` here attaches the acknowledge token to the quick reply and Meta refuses the message.
     * Not this message: every message on that template, emergencies included, until somebody in
     * a district office reads a provider error at 02:00.
     */
    const cap = capture();
    await sendWhatsApp(
      { ...config, emergencyTemplate: { name: 'district_emergency_v2', language: 'en' } },
      { ...message, answers: 'acknowledgement' },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_emergency_v2');
    expect(buttonOf(cap.sent())).toMatchObject({
      sub_type: 'url',
      index: '1',
      parameters: [{ type: 'text', text: 'tok_1' }],
    });
  });

  it('sends NO button component at all on the meeting template', async () => {
    /**
     * `district_notice_v2` was approved with three quick replies and no link. A quick reply takes
     * no parameter, so a send that carries a button component is naming a parameter for a button
     * that does not exist — which Meta refuses outright.
     *
     * The token is still minted upstream and simply expires unused. That is deliberate: the
     * ledger's attempt exists before anything is sent, whichever template it goes out on.
     */
    const cap = capture();
    await sendWhatsApp(
      { ...config, noticeTemplate: { name: 'district_notice_v2', language: 'en' } },
      { ...message, answers: 'attendance' },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_notice_v2');
    expect(buttonOf(cap.sent())).toBeUndefined();
  });

  it('keeps every message on the ordinary template until the district names the new ones', async () => {
    // The ordinary state, and the one every other installation is in. Nothing about this change
    // may move a district onto a template it has not approved.
    const cap = capture();
    await sendWhatsApp(config, { ...message, answers: 'acknowledgement' }, cap.fetch);

    expect(nameOf(cap.sent())).toBe('district_message');
    expect(buttonOf(cap.sent())).toMatchObject({ index: '0' });
  });

  it('puts a photograph on the picture template even when the message asks to be acknowledged', async () => {
    /**
     * Only one template this district has approved carries a header, so a message with a
     * photograph has exactly one place it can go — and its officer gets a link rather than a
     * quick reply. That is the owner's own trade, made when the picture template was submitted
     * alone: a photograph of the scene is worth more to somebody driving to it than one fewer tap.
     */
    const cap = capture();
    await sendWhatsApp(
      {
        ...config,
        imageTemplate: { name: 'district_message_img_v2', language: 'en' },
        emergencyTemplate: { name: 'district_emergency_v2', language: 'en' },
      },
      {
        ...message,
        answers: 'acknowledgement',
        media: { mediaId: 'media_1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_message_img_v2');
    expect(buttonOf(cap.sent())).toMatchObject({ index: '0' });
  });

  /**
   * 🔴 **The picture template’s button position is read from the CONFIGURED NAME — 2026-08-25.**
   *
   * Until this test existed, `templateFor` took the index straight off `ALERT_TEMPLATE_IMAGE`:
   * a hardcoded `0`, and correct for exactly as long as `district_message_img_v2` was the only
   * picture template that existed. `_img_v3` was submitted to Meta on 2026-08-25 with a quick
   * reply first and the link **second**, so this is what the switch-on day would have hit.
   *
   * **The failure would have been total, silent in advance, and at 02:00.** Meta identifies a
   * button parameter by position and nothing else, so the acknowledge token would have
   * attached to the quick reply — and Meta refuses **every** message on a template it is wrong
   * about, the emergencies without pictures too, not merely the send that carried one.
   *
   * ⚠️ **Nothing here says Bajaur sends on `_img_v3`.** `WHATSAPP_TEMPLATE_IMAGE` still names
   * `_img_v2` and stays that way until a person changes it — the owner’s instruction of
   * 2026-08-25. This pins what happens on the day they do.
   */
  it('sends the token to the SECOND button when the picture template has a tap on it', async () => {
    const cap = capture();
    await sendWhatsApp(
      {
        ...config,
        imageTemplate: { name: 'district_message_img_v3', language: 'en' },
      },
      {
        ...message,
        answers: 'acknowledgement',
        media: { mediaId: 'media_1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_message_img_v3');
    expect(buttonOf(cap.sent())).toMatchObject({ index: '1' });
  });

  /**
   * ⚠️ **A district sending on its own picture template is not moved by any of this.**
   *
   * `shapeNamed` returns `undefined` for a name this source has never heard of, and the
   * fallback is the shape it documents — which is the behaviour every installation had before
   * the lookup existed. A silent change here would break a district nobody in Bajaur can see.
   */
  it('falls back to the documented shape for a picture template it has never heard of', async () => {
    const cap = capture();
    await sendWhatsApp(
      {
        ...config,
        imageTemplate: { name: 'some_other_district_photo', language: 'en' },
      },
      {
        ...message,
        answers: 'acknowledgement',
        media: { mediaId: 'media_1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('some_other_district_photo');
    expect(buttonOf(cap.sent())).toMatchObject({ index: '0' });
  });
  it('reads the two names out of the environment, each on its own', () => {
    // Approval is per template and Meta reviews them separately, so the half that is approved
    // starts being used the day it is rather than waiting on the other.
    const found = whatsappFromEnv({
      WHATSAPP_PHONE_NUMBER_ID: '1',
      WHATSAPP_TOKEN: 't',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
      WHATSAPP_TEMPLATE_EMERGENCY: 'district_emergency_v2',
    });

    expect(found?.emergencyTemplate).toEqual({ name: 'district_emergency_v2', language: 'en' });
    expect(found?.noticeTemplate).toBeUndefined();
  });

  /**
   * **A switched-on category answers on its own template, with no button at all — ADR-0034.**
   *
   * `dnc_response_fire_v1` carries three quick replies and no link, so the send names no button
   * parameter — a quick reply takes none, and a component for one Meta did not approve is a
   * refused message. The officer's first tap on one of the three IS their response.
   */
  it('sends a switched-on category alert on its own response template, no button', async () => {
    const cap = capture();
    await sendWhatsApp(
      { ...config, responseCategories: new Set(['fire']) },
      { ...message, answers: 'acknowledgement', responseCategory: 'fire' },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('dnc_response_fire_v1');
    expect(buttonOf(cap.sent())).toBeUndefined();
  });

  /**
   * ⚠️ **The slug being present is not on its own a decision to route onto it.** Every emergency
   * carries a `responseCategory`; only the ones the district has named in `.env` answer on their
   * own template. An unnamed one goes out exactly as it did before this change.
   */
  it('ignores the response category when the district has not switched it on', async () => {
    const cap = capture();
    await sendWhatsApp(
      { ...config, responseCategories: new Set(['medical']) },
      { ...message, answers: 'acknowledgement', responseCategory: 'fire' },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_message');
    expect(buttonOf(cap.sent())).toMatchObject({ index: '0' });
  });

  /**
   * ⚠️ **The picture still wins.** None of the `dnc_response_*` templates has a media header, so
   * an alert carrying a photograph goes on the image template and its officer gets a link — the
   * category branch sits after the picture branch in `templateFor` for exactly this.
   */
  it('puts a photograph on the picture template even for a switched-on category', async () => {
    const cap = capture();
    await sendWhatsApp(
      {
        ...config,
        responseCategories: new Set(['fire']),
        imageTemplate: { name: 'district_message_img_v2', language: 'en' },
      },
      {
        ...message,
        answers: 'acknowledgement',
        responseCategory: 'fire',
        media: { mediaId: 'm1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    expect(nameOf(cap.sent())).toBe('district_message_img_v2');
  });

  it('reads WHATSAPP_RESPONSE_CATEGORIES as a comma list and drops what it cannot name', () => {
    const found = whatsappFromEnv({
      WHATSAPP_PHONE_NUMBER_ID: '1',
      WHATSAPP_TOKEN: 't',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
      WHATSAPP_RESPONSE_CATEGORIES: 'fire, Medical ,  , not_a_category',
    });

    expect([...(found?.responseCategories ?? [])].sort()).toEqual(['fire', 'medical']);
  });

  it('omits responseCategories entirely when the line is blank or names nothing usable', () => {
    const base = {
      WHATSAPP_PHONE_NUMBER_ID: '1',
      WHATSAPP_TOKEN: 't',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
    };

    expect(whatsappFromEnv(base)?.responseCategories).toBeUndefined();
    expect(
      whatsappFromEnv({ ...base, WHATSAPP_RESPONSE_CATEGORIES: '  ' })?.responseCategories,
    ).toBeUndefined();
    expect(
      whatsappFromEnv({ ...base, WHATSAPP_RESPONSE_CATEGORIES: 'nope, still_nope' })
        ?.responseCategories,
    ).toBeUndefined();
  });
});

describe('a tapped quick reply — 2026-08-19', () => {
  function tap(button: Record<string, unknown>): unknown {
    return {
      entry: [
        {
          changes: [
            { value: { messages: [{ from: '923001112222', timestamp: '1780000000', ...button }] } },
          ],
        },
      ],
    };
  }

  it('reads a template quick reply, which arrives with no text field at all', () => {
    /**
     * **The silent drop this fixes.** Meta delivers a tap on a template quick reply as an
     * ordinary inbound message with `type: "button"` and no `text` — so the old guard skipped it
     * without a word. An officer could tap *Attending*, see their own answer sitting in their
     * WhatsApp thread, and the board would carry them for ever as somebody nobody had reached.
     */
    const { replies } = readWebhook(
      tap({ type: 'button', button: { text: 'Attending', payload: 'Attending' } }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('Attending');
    // Carried rather than inferred from the words: "Acknowledge" is a sentence somebody could
    // also type, and the incident's own record should not have to guess which happened.
    expect(replies[0]?.tapped).toBe(true);
    expect(replies[0]?.fromPhone).toBe('923001112222');
  });

  it('falls back to the payload when the label is missing, and reads an interactive reply', () => {
    expect(
      readWebhook(tap({ type: 'button', button: { payload: 'Acknowledge' } })).replies[0],
    ).toMatchObject({ text: 'Acknowledge', tapped: true });

    // Not speculative — it is the shape a tap arrives in on an interactive message rather than a
    // template. Nothing sends those today; it costs one line and means the district's first one
    // is not also its first silently-dropped answer.
    expect(
      readWebhook(
        tap({ type: 'interactive', interactive: { button_reply: { title: 'Attending' } } }),
      ).replies[0],
    ).toMatchObject({ text: 'Attending', tapped: true });
  });

  it('still marks a typed reply as typed', () => {
    const { replies } = readWebhook(tap({ type: 'text', text: { body: 'on my way' } }));
    expect(replies[0]).toMatchObject({ text: 'on my way', tapped: false });
  });
});
