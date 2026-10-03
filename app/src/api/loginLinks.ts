/**
 * Sign-in links on the wire (ADR-0043, Bajaur — E5): issue one and send it, open one, use one.
 *
 * `auth/loginLink.ts` holds the rules (a hash only, once, 72 hours); this file adds the two things
 * the rules do not know about — WhatsApp, and the address the link lives at.
 *
 * **What the DC is told is what happened (INV-03).** Sent: Meta accepted the message. Not sent:
 * the district has no approved login template yet, so the DC is handed the link to send by hand.
 * Failed: Meta refused, with its reason — and the link too, so the officer is not left waiting on
 * a message that is never coming.
 */

import type { Pool } from 'pg';

import { mintLoginLink, noteLinkSent, type LinkSentVia } from '../auth/loginLink.js';
import { sendLoginLink, type WhatsAppConfig } from '../ops/whatsapp.js';

export interface LinkDeps {
  readonly whatsapp: WhatsAppConfig | null;
  /** Where the app is reached from outside, e.g. `https://dnc.example.com`. */
  readonly publicOrigin: string;
  readonly fetchImpl?: typeof fetch;
}

export interface LinkOutcome {
  readonly sentVia: LinkSentVia;
  /** Meta's reason, when it refused. */
  readonly failure: string | null;
  /**
   * The link itself — only when it did NOT go by WhatsApp, for the DC to send by hand. When it
   * did, it is not handed back: the fewer places a live sign-in sits, the better.
   */
  readonly url: string | null;
  readonly expiresAt: string;
}

export function linkUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin.replace(/\/+$/, '')}/set-password/${token}`;
}

/** Make a new link for this person and send it the one way the district can. */
export async function issueAndSend(
  pool: Pool,
  deps: LinkDeps,
  person: { readonly personId: string; readonly fullName: string; readonly phone: string },
  issuedBy: string | null,
): Promise<LinkOutcome> {
  const { token, expiresAt } = await mintLoginLink(pool, person.personId, issuedBy);
  const url = linkUrl(deps.publicOrigin, token);

  if (deps.whatsapp === null || deps.whatsapp.loginTemplate === undefined) {
    await noteLinkSent(pool, token, 'by_hand', null, issuedBy, person.personId);
    return { sentVia: 'by_hand', failure: null, url, expiresAt };
  }

  const sent = await sendLoginLink(
    deps.whatsapp,
    { toPhone: person.phone, name: person.fullName, token },
    deps.fetchImpl,
  );
  if (sent.ok) {
    await noteLinkSent(pool, token, 'whatsapp', null, issuedBy, person.personId);
    return { sentVia: 'whatsapp', failure: null, url: null, expiresAt };
  }
  await noteLinkSent(pool, token, 'failed', sent.failure, issuedBy, person.personId);
  return { sentVia: 'failed', failure: sent.failure, url, expiresAt };
}
