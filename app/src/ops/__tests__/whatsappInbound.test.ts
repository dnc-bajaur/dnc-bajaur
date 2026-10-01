/**
 * What an officer sends **to** the district — 2026-08-21.
 *
 * ## What these tests are really guarding
 *
 * `readWebhook` read `text` and a button's label and dropped everything else, **without a word in
 * the log**. So an officer who photographed the scene and sent it had, as far as this system was
 * concerned, said nothing: the obligation stayed open, the SLA clock kept running, escalation
 * climbed over their head, and the board carried them all day as somebody nobody had reached —
 * while their own photograph sat in their own thread.
 *
 * That is the same shape as the quick-reply defect of 2026-08-19 and it is what test 1 pins.
 *
 * The download tests guard the half that is easy to get wrong and impossible to notice locally:
 * **Meta's media URL is not a public link.** `GET /{id}` hands back a lookaside URL, and fetching
 * it without the access token is a 401 — a district where every inbound photograph fails with an
 * authentication error against a URL that looks like it should not need one.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { downloadMedia, readWebhook, type WhatsAppConfig } from '../whatsapp.js';

const config: WhatsAppConfig = {
  phoneNumberId: '1234567890',
  accessToken: 'the-token',
  appSecret: 'secret',
  verifyToken: 'verify',
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

/** One inbound message, in the envelope Meta actually delivers. */
function inbound(message: unknown): unknown {
  return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
}

const BYTES = Buffer.from('a photograph, as far as this test is concerned');
const HASH = createHash('sha256').update(BYTES).digest('hex');

/**
 * Meta's two steps, stubbed as one function.
 *
 * It answers the lookup on the Graph URL and the bytes on the lookaside URL, and **records the
 * headers of both**, because the second request's `authorization` is the whole point of test 5.
 */
function meta(
  over: {
    lookup?: { status?: number; body?: unknown };
    file?: { status?: number; bytes?: Buffer };
  } = {},
): { fetch: typeof fetch; calls: () => { url: string; auth: string | undefined }[] } {
  const calls: { url: string; auth: string | undefined }[] = [];

  const impl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers['authorization'] });

    if (String(url).startsWith(config.baseUrl!)) {
      return new Response(
        JSON.stringify(
          over.lookup?.body ?? {
            url: 'https://lookaside.invalid/whatsapp/media/abc',
            mime_type: 'image/jpeg',
            sha256: HASH,
            file_size: BYTES.length,
          },
        ),
        { status: over.lookup?.status ?? 200 },
      );
    }

    const body = over.file?.bytes ?? BYTES;
    return new Response(new Uint8Array(body), { status: over.file?.status ?? 200 });
  }) as unknown as typeof fetch;

  return { fetch: impl, calls: () => calls };
}

describe('reading a file off an inbound webhook', () => {
  /**
   * **The defect this whole change exists to close.**
   *
   * A photograph with no caption is a complete answer and the commonest one an officer sends from
   * a vehicle. Before 2026-08-21 this produced no reply at all.
   */
  it('reads a photograph with no caption as a reply', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc' },
      }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]?.media?.mediaId).toBe('media-1');
    expect(replies[0]?.media?.kind).toBe('image');
    // Empty rather than invented. `api/webhooks.ts` owns the words for a message with none —
    // a transport that wrote "sent a photograph" would be deciding what the record says.
    expect(replies[0]?.text).toBe('');
    expect(replies[0]?.tapped).toBe(false);
  });

  /**
   * A caption and its picture are **one** answer, not two.
   *
   * Meta puts the caption inside the media envelope rather than in `text`, so reading only `text`
   * would put the officer's words nowhere and the picture on the incident unexplained.
   */
  it('folds a caption into the reply text', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'image',
        image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'road is clear now' },
      }),
    );

    expect(replies[0]?.text).toBe('road is clear now');
    expect(replies[0]?.media?.mediaId).toBe('media-2');
  });

  /**
   * **`voice` is its own kind and is never flattened into `audio`.**
   *
   * An officer holding the microphone button is a different act from forwarding a file, and the
   * district's record should be able to say which. Meta already tells them apart; collapsing them
   * here would throw away a distinction nothing downstream could recover.
   */
  it('tells a voice note apart from an audio file', () => {
    const voice = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'audio',
        voice: { id: 'v-1', mime_type: 'audio/ogg; codecs=opus' },
      }),
    );
    const audio = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'audio',
        audio: { id: 'a-1', mime_type: 'audio/mpeg' },
      }),
    );

    expect(voice.replies[0]?.media?.kind).toBe('voice');
    expect(audio.replies[0]?.media?.kind).toBe('audio');
  });

  /**
   * A document keeps the name the sending handset had for it; a photograph genuinely has none.
   *
   * `null` rather than a guess, because `keepEvidence` composes something readable from the kind
   * and the day, and a filename invented here would look like the officer's own.
   */
  it('carries a document filename and reports a photograph as having none', () => {
    const doc = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'document',
        document: { id: 'd-1', mime_type: 'application/pdf', filename: 'survey.pdf' },
      }),
    );
    const pic = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'image',
        image: { id: 'i-1', mime_type: 'image/jpeg' },
      }),
    );

    expect(doc.replies[0]?.media?.filename).toBe('survey.pdf');
    expect(pic.replies[0]?.media?.filename).toBeNull();
  });

  /**
   * 🔴 **THIS ASSERTION IS NOW THE OPPOSITE OF WHAT IT WAS, AND THE OLD REASONING IS KEPT RATHER
   * THAN DELETED** — Phase 6, 2026-08-21.
   *
   * It read: *"nothing readable and no file is still skipped, exactly as before — a reaction, a
   * location, a contact card. This is the behaviour the change had to preserve: the guard was
   * widened to admit a file, not removed."* Every word of that was true of 21 August's change and
   * **two of its three examples were defects nobody had priced.** O-43(d) and O-43(e) named them:
   * a location is *"where are you"* answered exactly, and a ✅ is the cheapest deliberate answer an
   * officer can give. Both were dropped in silence while the board carried that officer as
   * somebody nobody had reached.
   *
   * The guard was widened again, not removed. The contact card below is what it still refuses.
   */
  it('reads a reaction, and matches it to our own message exactly', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'reaction',
        reaction: { message_id: 'wamid.ours', emoji: '✅' },
      }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]?.reaction?.emoji).toBe('✅');
    /**
     * **The strongest match this system ever gets.** Meta sends no `context` on a reaction — the
     * message being reacted to is named inside `reaction` — so without that being carried across,
     * the one inbound that names its own subject exactly would fall back to *"the most recent
     * alert to that number"*, which is the guess it exists to replace.
     */
    expect(replies[0]?.contextMessageId).toBe('wamid.ours');
    // No words were typed. The caller decides what the record calls a gesture.
    expect(replies[0]?.text).toBe('');
  });

  /**
   * 🔴 **A REACTION BEING TAKEN OFF IS NOT AN ANSWER, AND THIS IS THE LOAD-BEARING TEST OF THE
   * PAIR.**
   *
   * Meta reports a removal as the same message shape with `emoji` empty. Read as an answer, this
   * records an officer **un-answering** as though they had just answered — which is not merely
   * wrong, it is backwards, and it arrives at the exact moment somebody changed their mind. The
   * obvious implementation (`if (m.reaction) …`) has this defect and looks correct.
   */
  it('skips a reaction being removed, which is the same shape with no emoji', () => {
    for (const reaction of [
      { message_id: 'wamid.ours', emoji: '' },
      { message_id: 'wamid.ours' },
      // An emoji attached to nothing cannot be matched to an incident either.
      { emoji: '👍' },
    ]) {
      const { replies } = readWebhook(
        inbound({ from: '923001234567', timestamp: '1755700000', type: 'reaction', reaction }),
      );
      expect(replies).toHaveLength(0);
    }
  });

  /** A pin is an answer, and it is the one the five-row list could never carry — O-43(d). */
  it('reads a location, and keeps the name the handset gave it', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'location',
        location: {
          latitude: 34.7167,
          longitude: 71.5167,
          name: 'Khar Road',
          address: 'Bajaur',
        },
      }),
    );

    expect(replies).toHaveLength(1);
    expect(replies[0]?.location).toEqual({
      latitude: 34.7167,
      longitude: 71.5167,
      name: 'Khar Road',
      address: 'Bajaur',
    });
    expect(replies[0]?.text).toBe('');
  });

  /**
   * ⚠️ **A pin this system cannot believe is refused, and a refusal costs less than a bad one.**
   *
   * This is somebody else's JSON on a public endpoint. A latitude of 900, or a string, or the
   * `NaN` that arrives when a handset divided by a missing value, would be written onto an
   * emergency as **a place a crew could be sent to** — and it would read exactly like one they
   * could. Refusing costs the district a pin.
   */
  it('refuses a location that is not two believable degrees', () => {
    for (const location of [
      { latitude: 900, longitude: 70.6 },
      { latitude: 32.9, longitude: 'east' },
      { longitude: 70.6 },
      {},
    ]) {
      const { replies } = readWebhook(
        inbound({ from: '923001234567', timestamp: '1755700000', type: 'location', location }),
      );
      expect(replies).toHaveLength(0);
    }
  });

  /**
   * **The half that must NOT move: the guard was widened, not removed.**
   *
   * A contact card carries no words, no file, no pin and no emoji, and there is nothing this
   * district can honestly put on an incident about it. It is still skipped — which is what makes
   * the four exceptions above exceptions rather than the guard having been deleted.
   */
  it('still skips a message with no words, no file, no pin and no emoji', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'contacts',
        contacts: [{ name: { formatted_name: 'Somebody Else' } }],
      }),
    );

    expect(replies).toHaveLength(0);
  });

  /** Phase 7 needs Meta's id for THEIR message, and nothing had ever read it. */
  it('carries the inbound message id, which is what a read receipt needs', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        id: 'wamid.theirs',
        text: { body: 'on my way' },
      }),
    );

    expect(replies[0]?.messageId).toBe('wamid.theirs');
    // ⚠️ Their message, never ours. Confusing the two marks the district's own alert as read by
    // the district, which is meaningless and untraceable.
    expect(replies[0]?.contextMessageId).toBeUndefined();
  });

  /** A quick-reply tap is unchanged and carries no media. The 2026-08-19 path must not move. */
  it('leaves a quick-reply tap exactly as it was', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        button: { text: 'Acknowledge', payload: 'Acknowledge' },
      }),
    );

    expect(replies[0]?.text).toBe('Acknowledge');
    expect(replies[0]?.tapped).toBe(true);
    expect(replies[0]?.media).toBeUndefined();
  });

  /**
   * **The exact answer that was on every webhook and nobody was reading** — 2026-08-21.
   *
   * `context.id` is the id of the message the officer used WhatsApp's reply control on, and it is
   * this district's own `provider_message_id`. Since M6-23 the match has been inferred from *the
   * most recent alert to that number* while this field sat unread beside it.
   */
  it('carries the message an officer replied to', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'text',
        text: { body: 'on my way' },
        context: { from: '923339999999', id: 'wamid.THE_FIRST_ONE' },
      }),
    );

    expect(replies[0]?.contextMessageId).toBe('wamid.THE_FIRST_ONE');
  });

  /**
   * A quick-reply tap carries one too, naming the template message the button sat on — so
   * *Acknowledge* and *Attending*, matched by the number since 19 August, become exact as well.
   */
  it('carries it on a quick-reply tap as well as on typed words', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        button: { text: 'Acknowledge', payload: 'Acknowledge' },
        context: { id: 'wamid.THE_TEMPLATE' },
      }),
    );

    expect(replies[0]?.tapped).toBe(true);
    expect(replies[0]?.contextMessageId).toBe('wamid.THE_TEMPLATE');
  });

  /**
   * **Absent is the ordinary state and must stay ordinary.** Typing into the thread is easier
   * than long-pressing a message to reply to it, so most replies will carry nothing at all — and
   * `lastMessageTo`'s guess is what those still fall back to.
   */
  it('is absent when the officer simply typed into the thread', () => {
    const { replies } = readWebhook(
      inbound({
        from: '923001234567',
        timestamp: '1755700000',
        type: 'text',
        text: { body: 'on my way' },
      }),
    );

    expect(replies[0]?.contextMessageId).toBeUndefined();
  });
});

describe('fetching the file', () => {
  /**
   * **The lookaside URL needs the access token, and this is the test that says so.**
   *
   * Nothing local can discover it: a stub answers whatever it is asked. Getting it wrong in
   * production is a 401 on every inbound photograph, against a URL that looks public.
   */
  it('sends the token to the lookaside url as well as to the lookup', async () => {
    const m = meta();
    const got = await downloadMedia(config, 'media-1', m.fetch);

    expect(got.ok).toBe(true);
    const calls = m.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${config.baseUrl!}/media-1`);
    expect(calls[0]?.auth).toBe('Bearer the-token');
    expect(calls[1]?.url).toBe('https://lookaside.invalid/whatsapp/media/abc');
    expect(calls[1]?.auth).toBe('Bearer the-token');
  });

  it('returns the bytes and the type meta declared', async () => {
    const got = await downloadMedia(config, 'media-1', meta().fetch);

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.bytes.equals(BYTES)).toBe(true);
    expect(got.contentType).toBe('image/jpeg');
  });

  /**
   * **Integrity, not security** — the webhook was signature-checked long before this runs.
   *
   * It matters because these bytes become evidence attached to an incident, and a truncated
   * download that silently became a corrupt photograph would be discovered by whoever went
   * looking for it during a review six months later.
   */
  it('refuses bytes that are not the ones meta described', async () => {
    const got = await downloadMedia(
      config,
      'media-1',
      meta({ file: { bytes: Buffer.from('something else entirely') } }).fetch,
    );

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.failure).toContain('media_hash_mismatch');
    // Retryable: a truncated body on a bad district line is the likely cause, and the next pass
    // may well get all of it. A genuinely corrupt file fails the same way twice and stops.
    expect(got.retryable).toBe(true);
  });

  /**
   * The announced size is refused **before** the bytes are asked for.
   *
   * `calls()` having one entry is the assertion — a file above the cap must not be downloaded and
   * then thrown away on the one machine that is also taking emergency reports.
   */
  it('refuses an oversized file without fetching it', async () => {
    const m = meta({
      lookup: {
        body: {
          url: 'https://lookaside.invalid/whatsapp/media/abc',
          mime_type: 'video/mp4',
          file_size: 40 * 1024 * 1024,
        },
      },
    });
    const got = await downloadMedia(config, 'media-1', m.fetch);

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.failure).toContain('media_too_large');
    expect(m.calls()).toHaveLength(1);
  });

  /** Meta's own status decides whether this is worth another pass; 5xx is, a 404 is not. */
  it('classifies a lookup failure the way the sender does', async () => {
    const gone = await downloadMedia(config, 'media-1', meta({ lookup: { status: 404 } }).fetch);
    const bad = await downloadMedia(config, 'media-1', meta({ lookup: { status: 503 } }).fetch);

    expect(gone.ok).toBe(false);
    expect(bad.ok).toBe(false);
    if (gone.ok || bad.ok) return;
    expect(gone.retryable).toBe(false);
    expect(bad.retryable).toBe(true);
  });

  /** Nothing here throws, on any path. Every failure is a sentence somebody can act on. */
  it('returns a reason rather than throwing when meta cannot be reached', async () => {
    const dead = (() => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const got = await downloadMedia(config, 'media-1', dead);

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.failure).toContain('media_lookup_unreachable');
    expect(got.retryable).toBe(true);
  });
});
