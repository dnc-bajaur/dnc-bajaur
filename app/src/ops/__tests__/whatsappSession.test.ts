/**
 * The session sender — free-form messages inside Meta's 24-hour window, 2026-08-20.
 *
 * Pure and against a stubbed `fetch`, exactly as `whatsapp.test.ts` is, because everything
 * worth testing here is a decision this code makes before the network trip rather than the trip
 * itself. What the tests are actually holding down:
 *
 *   * **The shape Meta accepts.** A free-form message is not a template and shares none of its
 *     structure — `type: 'text'` with no components, or `type: 'interactive'` with buttons that
 *     carry an id the officer never sees. Get it wrong and Meta answers 400 with a parameter
 *     path, which in a district office reads as the follow-up simply not arriving.
 *   * **The caps are refused HERE, in words somebody can act on.** A 21-character button title
 *     is a 400 from Meta about `action.buttons[0].reply.title`; refused locally it is a sentence
 *     naming the button. That is the difference between a bug somebody fixes and one they log.
 *   * **A refusal is never retryable.** A message too long is too long on the next pass too, and
 *     a retryable refusal is the same message re-sent every interval for ever.
 */

import { describe, expect, it } from 'vitest';

import { sendSession, type WhatsAppConfig } from '../whatsapp.js';

const config: WhatsAppConfig = {
  phoneNumberId: '123456',
  accessToken: 'token-not-real',
  appSecret: 'secret-not-real',
  verifyToken: 'verify-not-real',
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

/** Captures what was posted, so the assertion is about the body Meta would actually receive. */
function capture(): { sent: unknown[]; fetchImpl: typeof fetch } {
  const sent: unknown[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.SESSION' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe('a plain message inside the window', () => {
  it('goes as text, with no template and no components', async () => {
    const { sent, fetchImpl } = capture();

    const result = await sendSession(
      config,
      { toPhone: '0300-1112222', text: '  Who is coming in your place?  ' },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.SESSION' });
    expect(sent[0]).toEqual({
      messaging_product: 'whatsapp',
      // Normalised the same way every other send normalises it. A number stored two ways is a
      // conversation the district believes it is having with somebody who never hears from it.
      to: '923001112222',
      type: 'text',
      text: { body: 'Who is coming in your place?' },
    });
  });
});

describe('buttons inside the window', () => {
  it('goes as an interactive message, and the id is not the words the officer reads', async () => {
    const { sent, fetchImpl } = capture();

    await sendSession(
      config,
      {
        toPhone: '923001112222',
        text: 'What is happening?',
        buttons: [
          { id: 'stage:responded', title: 'Responding' },
          { id: 'stage:resolved', title: 'Resolved' },
        ],
      },
      fetchImpl,
    );

    expect(sent[0]).toEqual({
      messaging_product: 'whatsapp',
      to: '923001112222',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'What is happening?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'stage:responded', title: 'Responding' } },
            { type: 'reply', reply: { id: 'stage:resolved', title: 'Resolved' } },
          ],
        },
      },
    });
  });
});

describe('what it refuses before Meta can', () => {
  /** Nothing may reach the network in any of these. A refusal that still sent is not a refusal. */
  async function refused(message: Parameters<typeof sendSession>[1]): Promise<string> {
    const { sent, fetchImpl } = capture();
    const result = await sendSession(config, message, fetchImpl);
    expect(sent).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Never retryable: none of these get better by being sent again on the next pass.
    expect(result.retryable).toBe(false);
    return result.failure;
  }

  it('refuses a fourth button', async () => {
    expect(
      await refused({
        toPhone: '923001112222',
        text: 'pick one',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      }),
    ).toContain('session_too_many_buttons');
  });

  it('names the button whose title is too long, rather than its index', async () => {
    const failure = await refused({
      toPhone: '923001112222',
      text: 'pick one',
      buttons: [{ id: 'x', title: 'Acknowledged and on my way' }],
    });
    expect(failure).toContain('session_bad_button');
    // The words, so somebody reading the log knows which button to shorten without counting.
    expect(failure).toContain('Acknowledged and on my way');
  });

  it('refuses a body longer than an interactive message may carry', async () => {
    // 1024 with buttons. The plain-text cap is four times that, and the same message is fine
    // without them — which is exactly why the two limits are not one constant.
    const long = 'x'.repeat(1025);
    expect(
      await refused({
        toPhone: '923001112222',
        text: long,
        buttons: [{ id: 'a', title: 'A' }],
      }),
    ).toContain('session_too_long');

    const { sent, fetchImpl } = capture();
    const ok = await sendSession(config, { toPhone: '923001112222', text: long }, fetchImpl);
    expect(ok.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('refuses an empty message', async () => {
    // Whitespace is empty. A message of three spaces is accepted by Meta and read by nobody.
    expect(await refused({ toPhone: '923001112222', text: '   ' })).toContain('session_empty');
  });
});

describe('when Meta refuses it', () => {
  it('carries Meta’s own words, and a shut window is not retryable', async () => {
    /**
     * `131047` is what a shut service window actually returns, and it is the failure this path
     * is most likely to hit in production: a follow-up sent minutes after the officer's tap, to
     * a number whose window closed in between. It must read as itself in the journal rather than
     * as a generic send failure, and it must NOT be retried — the window does not reopen because
     * we asked twice.
     */
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Re-engagement message',
            code: 131047,
            error_data: {
              details: 'Message failed to send because more than 24 hours have passed',
            },
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const result = await sendSession(
      config,
      { toPhone: '923001112222', text: 'Who is coming in your place?' },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toContain('whatsapp_400');
    expect(result.failure).toContain('Re-engagement message');
    expect(result.failure).toContain('code 131047');
    expect(result.retryable).toBe(false);
  });
});
