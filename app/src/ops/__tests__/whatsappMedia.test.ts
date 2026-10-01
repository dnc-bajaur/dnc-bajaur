/**
 * Attachments over WhatsApp — M9-17, M9-19.
 *
 * ## The thing these tests are really guarding
 *
 * **A header component sent to a template that has no header is rejected by Meta for every
 * message on that template — emergencies included.** `district_message_v2` has no media header
 * and is the only approved template the district has, so the switch below is off in production
 * and the most important test in this file is the one asserting that an attachment is silently
 * *not sent* rather than breaking the message.
 *
 * The owner's rule is that coding never waits on a template review. So this is built, tested,
 * and shipped configured off: the day a media-header template is approved, one `.env` value
 * changes and none of this code does.
 */

import { describe, expect, it } from 'vitest';

import { sendWhatsApp, uploadMedia, type WhatsAppConfig } from '../whatsapp.js';

const base: WhatsAppConfig = {
  phoneNumberId: '1234567890',
  accessToken: 'token',
  appSecret: 'secret',
  verifyToken: 'verify',
  templateName: 'district_message_v2',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

/**
 * A district whose image template Meta has approved — M10-28.
 *
 * ⚠️ **Naming the template IS turning the feature on, and that is the point.** There used to be a
 * `templateHasMediaHeader` boolean here that could be set against the body-only template, which
 * would have put a header on every send and had Meta refuse all of them, emergencies included.
 * That state is not expressible any more: a header is only ever built for this template, and this
 * template is only ever chosen for a message carrying a picture.
 */
const withImageTemplate: WhatsAppConfig = {
  ...base,
  imageTemplate: { name: 'district_message_img', language: 'en' },
};

const MEDIA = {
  mediaId: 'media_9988',
  filename: 'notification.pdf',
  kind: 'document',
} as const;

/** Captures the request so the assertion can be about what Meta would actually receive. */
function capture(
  status: number,
  body: unknown,
): {
  fetch: typeof fetch;
  seen: () => { url: string; init: RequestInit };
} {
  let url = '';
  let init: RequestInit = {};
  const impl = (async (u: string, i: RequestInit) => {
    url = u;
    init = i;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, seen: () => ({ url, init }) };
}

function componentsOf(init: RequestInit): { type: string }[] {
  const parsed = JSON.parse(String(init.body)) as {
    template: { components: { type: string }[] };
  };
  return parsed.template.components;
}

describe('no image template configured, which is production today', () => {
  it('sends NOTHING about the attachment, and the message still goes', async () => {
    const cap = capture(200, { messages: [{ id: 'wamid.1' }] });
    const result = await sendWhatsApp(
      base,
      { toPhone: '03001112222', what: 'Meeting: x', where: 'y', ackToken: 'tok', media: MEDIA },
      cap.fetch,
    );

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.1' });

    // The whole point. A header here would break every message on this template.
    const types = componentsOf(cap.seen().init).map((c) => c.type);
    expect(types).not.toContain('header');
    expect(types).toEqual(['body', 'button']);
  });

  it('leaves the two body parameters exactly where the approved template expects them', async () => {
    // A parameter count off by one fails every send. `whatsappTemplate.test.ts` holds the count
    // against the template; this holds the *order* against an attachment being spliced in.
    const cap = capture(200, { messages: [{ id: 'wamid.2' }] });
    await sendWhatsApp(
      base,
      { toPhone: '03001112222', what: 'A', where: 'B', ackToken: 'tok', media: MEDIA },
      cap.fetch,
    );

    const body = componentsOf(cap.seen().init).find((c) => c.type === 'body') as unknown as {
      parameters: { text: string }[];
    };
    expect(body.parameters.map((p) => p.text)).toEqual(['A', 'B']);
  });
});

describe('which template a message goes on, decided per message', () => {
  /**
   * ⚠️ **These four are the whole of M10-28, and the first two are the ones that matter.**
   *
   * The configuration this replaced was a single boolean saying *"our template has a media
   * header"*. Turning it on would have attached a header to **every** send, and Meta refuses a
   * message whose components do not match the template it approved — so the emergencies would
   * have failed alongside the meeting notice, on the day somebody flipped a flag to make
   * photographs work.
   *
   * Choosing per message means the header and the template name cannot disagree, because one
   * decides the other.
   */

  it('a picture goes on the image template, with the picture in a header', async () => {
    const cap = capture(200, { messages: [{ id: 'wamid.4' }] });
    await sendWhatsApp(
      withImageTemplate,
      {
        toPhone: '03001112222',
        what: 'A',
        where: 'B',
        ackToken: 'tok',
        media: { mediaId: 'media_1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    const sent = JSON.parse(String(cap.seen().init?.body)) as {
      template: { name: string; language: { code: string } };
    };
    expect(sent.template.name).toBe('district_message_img');
    expect(sent.template.language.code).toBe('en');

    const header = componentsOf(cap.seen().init)[0] as unknown as {
      parameters: { type: string; image?: { id: string } }[];
    };
    // No filename. Meta shows one for documents and ignores it here.
    expect(header.parameters[0]).toEqual({ type: 'image', image: { id: 'media_1' } });
  });

  it('a PDF stays on the ordinary template and carries no header at all', async () => {
    const cap = capture(200, { messages: [{ id: 'wamid.3' }] });
    await sendWhatsApp(
      withImageTemplate,
      { toPhone: '03001112222', what: 'A', where: 'B', ackToken: 'tok', media: MEDIA },
      cap.fetch,
    );

    const sent = JSON.parse(String(cap.seen().init?.body)) as { template: { name: string } };

    /**
     * **There is no document template, by the owner's choice**, so a PDF has nowhere to ride and
     * travels as a single-use link in the body instead — permanently, which is what promotes the
     * file-link page from a fallback to the load-bearing path.
     *
     * Putting a document header on the IMAGE template would be refused by Meta for every message
     * on it, so this is the case that has to stay boring.
     */
    expect(sent.template.name).toBe('district_message_v2');
    expect(componentsOf(cap.seen().init).map((c) => c.type)).toEqual(['body', 'button']);
  });

  it('a message with no file stays on the ordinary template', async () => {
    const cap = capture(200, { messages: [{ id: 'wamid.5' }] });
    await sendWhatsApp(
      withImageTemplate,
      { toPhone: '03001112222', what: 'A', where: 'B', ackToken: 'tok' },
      cap.fetch,
    );

    const sent = JSON.parse(String(cap.seen().init?.body)) as { template: { name: string } };
    expect(sent.template.name).toBe('district_message_v2');
    expect(componentsOf(cap.seen().init).map((c) => c.type)).toEqual(['body', 'button']);
  });

  it('with no image template configured, even a picture goes the ordinary way', async () => {
    const cap = capture(200, { messages: [{ id: 'wamid.6' }] });
    await sendWhatsApp(
      base,
      {
        toPhone: '03001112222',
        what: 'A',
        where: 'B',
        ackToken: 'tok',
        media: { mediaId: 'media_1', filename: 'scene.jpg', kind: 'image' },
      },
      cap.fetch,
    );

    // The state Bajaur is in today, and the one it stays in until Meta approves the template.
    // A district that attaches a photograph gets a message with a link, which is far better
    // than a district whose alerts have all stopped.
    const sent = JSON.parse(String(cap.seen().init?.body)) as { template: { name: string } };
    expect(sent.template.name).toBe('district_message_v2');
    expect(componentsOf(cap.seen().init).map((c) => c.type)).toEqual(['body', 'button']);
  });
});

describe('uploadMedia', () => {
  const file = {
    bytes: Buffer.from('%PDF-1.7\n'),
    contentType: 'application/pdf',
    filename: 'notice.pdf',
  };

  it('returns the id Meta hands back', async () => {
    const cap = capture(200, { id: 'media_777' });
    expect(await uploadMedia(base, file, cap.fetch)).toEqual({ ok: true, mediaId: 'media_777' });
    expect(cap.seen().url).toContain('/1234567890/media');
  });

  it('posts multipart, not JSON', async () => {
    const cap = capture(200, { id: 'media_777' });
    await uploadMedia(base, file, cap.fetch);
    expect(cap.seen().init.body).toBeInstanceOf(FormData);
  });

  it('treats a 429 and a 5xx as retryable, and a 400 as not', async () => {
    // The same distinction M6-24 draws for sending: a capped number will accept the next one,
    // a refused file never will.
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const cap = capture(status, { error: { message: 'no', code: status } });
      const result = await uploadMedia(base, file, cap.fetch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable, `status ${String(status)}`).toBe(retryable);
    }
  });

  it('treats an unreachable provider as retryable', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const result = await uploadMedia(base, file, boom);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.failure).toContain('ECONNRESET');
    }
  });

  it('refuses a 200 that carries no id, rather than sending a message with no attachment', async () => {
    const cap = capture(200, { ok: true });
    const result = await uploadMedia(base, file, cap.fetch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toContain('no id');
  });
});

describe('reading the image template from the environment', () => {
  it('is off unless the district names an image template, and a name alone is enough', async () => {
    const { whatsappFromEnv } = await import('../whatsapp.js');
    const env = (v?: string): Record<string, string> => ({
      WHATSAPP_PHONE_NUMBER_ID: 'p',
      WHATSAPP_TOKEN: 't',
      WHATSAPP_APP_SECRET: 's',
      WHATSAPP_VERIFY_TOKEN: 'v',
      ...(v === undefined ? {} : { WHATSAPP_TEMPLATE_IMAGE: v }),
    });

    /**
     * ⚠️ **This replaced a test about the exact string `"true"`, and the replacement is the
     * safer shape rather than the same guard reworded.**
     *
     * The old configuration was a boolean, so a half-typed value was dangerous in one direction:
     * anything truthy turned media headers on globally and Meta then refused every message on
     * that template. The guard was that only `'true'` counted.
     *
     * A name cannot be half-typed into danger. A blank leaves the district exactly where it is,
     * and a **wrong** name is refused by Meta for that one message rather than for all of them,
     * because the body-only template is still what every other send goes on.
     */
    for (const blank of [undefined, '', '   ']) {
      expect(whatsappFromEnv(env(blank))?.imageTemplate, `for ${String(blank)}`).toBeUndefined();
    }

    const named = whatsappFromEnv(env('district_message_img'));
    expect(named?.imageTemplate?.name).toBe('district_message_img');
    // Its own approved language, never the other template's — two templates approved in
    // different languages is a 404 from Meta and not something to guess at.
    expect(named?.imageTemplate?.language).toBe('en');
  });
});
