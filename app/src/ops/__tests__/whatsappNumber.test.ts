/**
 * How many officers this district may still reach today — 2026-08-21.
 *
 * ## The number nobody could see
 *
 * Meta caps a business number at a fixed count of **unique recipients per rolling 24 hours**.
 * Read off Bajaur's own account the day this was written: **`TIER_250`**. Two hundred and fifty
 * handsets a day, and nothing in this product said so — `whatsappHealth` counted sent, delivered
 * and failed, which is how the sends that happened went, not how many more may happen.
 *
 * The failure it hides is the worst-shaped one this system has: at the cap Meta refuses every
 * message to a handset the district has **not already reached today**, so the officers it silences
 * are exactly the ones nobody has managed to tell yet — and the symptom is a provider error at
 * 02:00 that reads like nothing in particular.
 */

import { describe, expect, it } from 'vitest';

import { readNumberHealth, refreshWhatsAppNumber, tierAllows } from '../whatsappNumber.js';
import type { WhatsAppConfig } from '../whatsapp.js';

const config: WhatsAppConfig = {
  phoneNumberId: '1000000000000001',
  accessToken: 'the-token',
  appSecret: 'secret',
  verifyToken: 'verify',
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

function graph(
  body: unknown,
  status = 200,
): { fetch: typeof fetch; seen: () => { url: string; auth: string | undefined } } {
  let url = '';
  let auth: string | undefined;
  const impl = (async (u: string, init?: RequestInit) => {
    url = String(u);
    auth = ((init?.headers ?? {}) as Record<string, string>)['authorization'];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, seen: () => ({ url, auth }) };
}

/** Records what was written, so the assertions are about the row rather than about the call. */
function recordingPool(): {
  pool: Parameters<typeof refreshWhatsAppNumber>[0];
  rows: () => { subject: string; event: string; severity: string }[];
} {
  const rows: { subject: string; event: string; severity: string }[] = [];
  const pool = {
    query: (_sql: string, params?: readonly unknown[]) => {
      if (params !== undefined && params.length >= 4) {
        rows.push({
          subject: String(params[1]),
          event: String(params[2]),
          severity: String(params[3]),
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Parameters<typeof refreshWhatsAppNumber>[0];
  return { pool, rows: () => rows };
}

describe('reading the district’s own number', () => {
  it('asks Meta for the three things that decide capacity, with the token', async () => {
    const g = graph({
      display_phone_number: '+92 336 3920520',
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_250',
    });

    const got = await readNumberHealth(config, g.fetch);

    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.health.tier).toBe('TIER_250');
    expect(got.health.quality).toBe('GREEN');
    expect(g.seen().url).toContain(config.phoneNumberId);
    expect(g.seen().url).toContain('messaging_limit_tier');
    expect(g.seen().auth).toBe('Bearer the-token');
  });

  it('returns a reason rather than throwing when Meta cannot be reached', async () => {
    const dead = (() => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const got = await readNumberHealth(config, dead);

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.failure).toContain('number_unreachable');
  });
});

describe('what a tier allows', () => {
  it('knows Meta’s published tiers', () => {
    expect(tierAllows('TIER_250')).toBe(250);
    expect(tierAllows('TIER_1K')).toBe(1_000);
    expect(tierAllows('tier_100k')).toBe(100_000);
  });

  /**
   * 🔴 **An unknown tier draws no fraction at all, and this is the assertion that matters.**
   *
   * Meta renames these occasionally. A fraction against a guessed denominator would read as
   * measured — *"180 of 250"* over a number that is actually on TIER_1K is a district told it is
   * nearly out of allowance when it has four times as much left, and the reverse on a worse day.
   */
  it('says nothing rather than guessing a cap it does not know', () => {
    expect(tierAllows('TIER_SOMETHING_NEW')).toBeNull();
    expect(tierAllows(null)).toBeNull();
    // Uncapped is null too: the question is *should the wall carry a fraction*, and for a number
    // with no cap the answer is no.
    expect(tierAllows('TIER_UNLIMITED')).toBeNull();
  });
});

describe('the poll, which exists because a webhook can be missed', () => {
  /**
   * **The tier is filed under its own reserved subject.**
   *
   * `whatsapp_account_state` is keyed on `(kind, subject)`, so sharing the number's subject would
   * make a `FLAGGED` notice and the tier overwrite each other — and the district would lose
   * whichever arrived first.
   */
  it('writes the tier and the quality as two separate rows', async () => {
    const r = recordingPool();
    const g = graph({
      display_phone_number: '+92 336 3920520',
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_250',
    });

    await refreshWhatsAppNumber(r.pool, config, g.fetch);

    const rows = r.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.subject)).toContain('messaging limit');
    expect(rows.map((x) => x.subject)).toContain('+92 336 3920520');
  });

  /**
   * **A tier is a fact, never a fault.** Every new number starts on TIER_250, and a permanently
   * amber row about the ordinary state of the account is how a district learns to ignore amber.
   * Being *near* the cap is the fault, and that is decided where the day's usage is known.
   */
  it('records the tier as ok, however small it is', async () => {
    const r = recordingPool();
    await refreshWhatsAppNumber(
      r.pool,
      config,
      graph({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_50' }).fetch,
    );

    expect(r.rows().find((x) => x.subject === 'messaging limit')?.severity).toBe('ok');
  });

  /**
   * **A degraded quality found by the poll is the same row a webhook would have written.**
   *
   * That is the point of polling at all: `phone_number_quality_update` reports this too, and a
   * webhook that never arrives — a deploy window, a Meta incident, an endpoint briefly down —
   * would otherwise leave the district believing a stale green. A poll cannot miss what it asks
   * for.
   */
  it('turns a red quality into a critical row, exactly as the webhook does', async () => {
    const r = recordingPool();
    await refreshWhatsAppNumber(
      r.pool,
      config,
      graph({
        display_phone_number: '+92 336 3920520',
        quality_rating: 'RED',
        messaging_limit_tier: 'TIER_250',
      }).fetch,
    );

    const number = r.rows().find((x) => x.subject === '+92 336 3920520');
    expect(number?.event).toBe('RED');
    expect(number?.severity).toBe('critical');
  });

  /**
   * **A green quality writes an `ok` row rather than nothing**, and without it a number that
   * recovered would keep the district's last red row for ever — nothing would overwrite it.
   */
  it('writes green as ok, so a red row can clear itself without a webhook', async () => {
    const r = recordingPool();
    await refreshWhatsAppNumber(
      r.pool,
      config,
      graph({ display_phone_number: '+92 336 3920520', quality_rating: 'GREEN' }).fetch,
    );

    expect(r.rows().find((x) => x.subject === '+92 336 3920520')?.severity).toBe('ok');
  });

  /**
   * 🔴 **A failed poll writes NOTHING.**
   *
   * Meta being unreachable is not evidence about the district's number, and recording it as one
   * would put a fault on the wall belonging to the district's own line rather than to its
   * WhatsApp account. `refreshWeather` holds the same rule for the same reason: **a failure to
   * ask is not an answer.**
   */
  it('writes nothing at all when Meta cannot be reached', async () => {
    const r = recordingPool();
    const dead = (() => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const outcome = await refreshWhatsAppNumber(r.pool, config, dead);

    expect(outcome.ok).toBe(false);
    expect(r.rows()).toHaveLength(0);
  });
});
