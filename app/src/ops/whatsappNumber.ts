/**
 * How many officers this district may still reach today — 2026-08-21.
 *
 * ## The number nobody could see
 *
 * Meta caps a business number at a fixed count of **unique recipients per rolling 24 hours**, and
 * raises the cap as the number earns trust. Read off the district's own account the day this was
 * written, Bajaur is on **`TIER_250`**: two hundred and fifty handsets a day, and **nothing in this
 * product said so.** `whatsappHealth` counted sent, delivered and failed — how the sends that
 * happened went — which is a different question from *how many more may happen*.
 *
 * That gap has a shape this file has met three times already: it is invisible until the night it
 * matters. A district-wide alert plus an escalation ladder over a bad evening is the case where
 * the cap binds, and the symptom is Meta refusing sends to officers nobody has messaged yet —
 * an error in a provider reply, at 02:00, that reads like nothing in particular.
 *
 * ## Two halves, and only one of them needs Meta
 *
 * The **denominator** is Meta's and has to be asked for. The **numerator** — how many distinct
 * handsets this district has already reached today — has been sitting in `whatsapp_message` since
 * M6-19 and costs one query. So the expensive half is polled slowly and the cheap half is counted
 * at the moment the wall is drawn.
 *
 * ## Why this polls rather than waiting to be told
 *
 * `phone_number_quality_update` (Phase 3) reports a number being **flagged**, and this asks the
 * same account the same question on a timer. That is deliberate duplication and it is the point:
 * a webhook that never arrives — a deploy window, a Meta incident, an endpoint that was briefly
 * down — leaves the district believing a stale green. **A poll cannot miss what it asks for.**
 *
 * The two write **the same row** (`kind: 'number'`), so there is one answer to *what is wrong with
 * our number* whether it was pushed or pulled, and a webhook arriving between polls is not
 * overwritten by an older truth — `recordAccountNotice` stamps `noticed_at` on every write and the
 * poll only writes what it actually found.
 */

import type { Pool } from '../db/pool.js';
import { LIMIT_SUBJECT, recordAccountNotice } from '../db/whatsappStore.js';
import type { AccountNotice, WhatsAppConfig } from './whatsapp.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface NumberHealth {
  /** `GREEN`, `YELLOW`, `RED`, or `UNKNOWN` when Meta declines to say. */
  readonly quality: string | null;
  /** `TIER_250`, `TIER_1K`, `TIER_10K`, `TIER_100K`, `TIER_UNLIMITED`. */
  readonly tier: string | null;
  /** The number as Meta displays it, for the district's own record of which line this is. */
  readonly displayNumber: string | null;
}

export type NumberHealthResult =
  | { readonly ok: true; readonly health: NumberHealth }
  | { readonly ok: false; readonly failure: string };

/**
 * Ask Meta about this district's own number.
 *
 * ⚠️ **Reads only. It changes nothing at Meta**, which is what makes it safe to run on a timer
 * against somebody else's account — the same rule `npm run doctor` holds itself to.
 */
export async function readNumberHealth(
  config: WhatsAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<NumberHealthResult> {
  const url =
    `${config.baseUrl ?? GRAPH}/${config.phoneNumberId}` +
    `?fields=display_phone_number,quality_rating,messaging_limit_tier`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.accessToken}` },
      // Bounded, and shorter than a send: this runs on the machine also taking emergency
      // reports, and nothing on the wall is worth holding a socket open for.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      failure: `number_unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  if (!res.ok) return { ok: false, failure: `number_${String(res.status)}: ${text.slice(0, 200)}` };

  let body: {
    quality_rating?: unknown;
    messaging_limit_tier?: unknown;
    display_phone_number?: unknown;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return { ok: false, failure: 'number_unreadable: not json' };
  }

  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

  return {
    ok: true,
    health: {
      quality: str(body.quality_rating),
      tier: str(body.messaging_limit_tier),
      displayNumber: str(body.display_phone_number),
    },
  };
}

/**
 * How many handsets a tier allows in a rolling day, or null for one this code does not know.
 *
 * ⚠️ **An unknown tier returns null and the wall then says nothing about capacity**, rather than
 * guessing a number. Meta renames these occasionally, and a fraction drawn against a made-up
 * denominator is worse than no fraction: it would read as measured.
 */
export function tierAllows(tier: string | null): number | null {
  switch ((tier ?? '').trim().toUpperCase()) {
    case 'TIER_50':
      return 50;
    case 'TIER_250':
      return 250;
    case 'TIER_1K':
      return 1_000;
    case 'TIER_10K':
      return 10_000;
    case 'TIER_100K':
      return 100_000;
    // Meta's own word for "no cap". Null rather than Infinity: the caller's question is *should
    // the wall carry a fraction*, and the answer for an uncapped number is no.
    case 'TIER_UNLIMITED':
      return null;
    default:
      return null;
  }
}

export interface RefreshOutcome {
  readonly ok: boolean;
  readonly failure?: string;
}

/**
 * Poll Meta and write what it says into the same table the webhooks write to.
 *
 * ## What it writes, and what it deliberately does not
 *
 * **A quality that is not green becomes a notice**, in exactly the shape
 * `phone_number_quality_update` produces — so `accountTrouble` surfaces it on the wall without
 * knowing or caring whether it was pushed or pulled.
 *
 * **A green quality writes an `ok` row rather than nothing.** That matters: without it, a number
 * that recovered would keep the district's last red row for ever, because nothing would ever
 * overwrite it. The webhook would clear it too — but only if the webhook arrives, and this
 * function exists precisely for the times it does not.
 *
 * **A failed poll writes nothing at all.** Meta being unreachable is not evidence about the
 * district's number, and recording it as one would put a fault on the wall belonging to the
 * district's own line rather than to its WhatsApp account — `refreshWeather`'s rule, for the same
 * reason: a failure to ask is not an answer.
 */
export async function refreshWhatsAppNumber(
  pool: Pool,
  config: WhatsAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  const got = await readNumberHealth(config, fetchImpl);
  if (!got.ok) return { ok: false, failure: got.failure };

  const subject = got.health.displayNumber ?? 'the district’s number';

  if (got.health.quality !== null) {
    const quality = got.health.quality.toUpperCase();
    const notice: AccountNotice = {
      kind: 'number',
      subject,
      event: quality,
      // The same vocabulary the webhook path grades: GREEN is ok, RED is critical, and anything
      // Meta has newly invented is worth a look rather than assumed fine.
      severity: quality === 'GREEN' ? 'ok' : quality === 'RED' ? 'critical' : 'warn',
      detail: quality === 'GREEN' ? null : 'quality rating, read from Meta',
    };
    await recordAccountNotice(pool, notice);
  }

  if (got.health.tier !== null) {
    await recordAccountNotice(pool, {
      kind: 'number',
      subject: LIMIT_SUBJECT,
      event: got.health.tier,
      // Always `ok`: a tier is where the number stands, not something wrong with it. Being NEAR
      // it is the fault, and that is decided where the day's usage is known.
      severity: 'ok',
      detail: null,
    });
  }

  return { ok: true };
}
