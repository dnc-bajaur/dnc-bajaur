/**
 * Uploading and fetching evidence — M1-05, over HTTP.
 *
 * **Raw body, not multipart.** A phone posts the file as the request body with the filename
 * in a header. Parsing multipart by hand in `node:http` is a hundred lines of state machine
 * that has historically been where the interesting bugs are, and adding a framework to avoid
 * writing it would be exactly the dependency ADR-0007 exists to refuse. A single file per
 * request loses nothing: the client sends three requests for three photographs, and each one
 * that succeeds is durable on its own — which is better behaviour on a bad connection than
 * one request that fails at 90%.
 *
 * **Authority comes from the incident**, always. You may attach evidence to an emergency you
 * are permitted to read and act on, and you may fetch evidence from an incident you are
 * permitted to read. There is no separate evidence permission to get out of step with the
 * incident one (INV-05).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Pool } from '../db/pool.js';
import type { Identity } from '../auth/sessions.js';
import { readIncident } from './lifecycle.js';
import { isGeneral } from '../domain/events.js';
import {
  fetch as fetchEvidence,
  find as findEvidence,
  COMMUNICATION_TYPES,
  isAcceptedType,
  listFor,
  store,
  MAX_EVIDENCE_BYTES,
  type Evidence,
} from '../ops/evidence.js';

export type EvidenceReply =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

/**
 * Read the body with a hard cap, applied **while reading**.
 *
 * Not after. Buffering an unbounded upload into memory and then measuring it is the same
 * denial of service with an extra step, and the district's server is one machine that is also
 * handling emergencies.
 */
async function readBinary(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_EVIDENCE_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Attach a file to an incident.
 *
 * The permission check runs **before** the body is read. Reading twenty megabytes off a
 * congested link and then refusing is rude to a field officer's data allowance and pointless
 * to the server.
 */
export async function upload(
  pool: Pool,
  root: string,
  req: IncomingMessage,
  incidentId: string,
  identity: Identity,
): Promise<EvidenceReply> {
  const readable = await readIncident(pool, incidentId, identity);
  if (!readable.ok) return { ok: false, status: readable.status, error: readable.error };

  const contentType = header(req, 'content-type');
  if (contentType === undefined)
    return { ok: false, status: 400, error: 'content-type is required' };
  if (!isAcceptedType(contentType)) {
    return {
      ok: false,
      status: 415,
      error: `${contentType} is not a kind of file this system stores`,
    };
  }

  const bytes = await readBinary(req);
  if (bytes === null) return { ok: false, status: 413, error: 'that file is larger than 20 MB' };

  const result = await store(pool, root, {
    incidentId,
    filename: header(req, 'x-filename') ?? 'file',
    contentType,
    /**
     * What this incident may carry, decided by **what kind of thing it is** — M9-16.
     *
     * An emergency is a crew documenting a scene: video and audio belong, and a thirty-second
     * clip of a collapsed culvert is exactly the evidence a review will want. A meeting notice
     * is a document going out to fifty officers on WhatsApp, and every format on that list is
     * one more thing that has to open on every handset in the district.
     *
     * Taken from the fold rather than from a header, so a client cannot widen its own limit.
     * The client's `accept` attribute filters the picker and is trivially bypassed; this is the
     * check (INV-05 — the UI is never the enforcement layer).
     */
    ...(isGeneral(readable.state.kind) ? { allowed: COMMUNICATION_TYPES } : {}),
    bytes,
    ...(header(req, 'x-captured-at') !== undefined
      ? { capturedAt: header(req, 'x-captured-at') }
      : {}),
    ...(header(req, 'x-caption') !== undefined ? { caption: header(req, 'x-caption') } : {}),
    seatId: identity.seatId,
    personId: identity.personId,
  });

  return result.ok
    ? { ok: true, status: 201, body: result.value }
    : { ok: false, status: 409, error: result.why };
}

export async function listEvidence(
  pool: Pool,
  incidentId: string,
  identity: Identity,
): Promise<EvidenceReply> {
  const readable = await readIncident(pool, incidentId, identity);
  if (!readable.ok) return { ok: false, status: readable.status, error: readable.error };
  return { ok: true, status: 200, body: { evidence: await listFor(pool, incidentId) } };
}

/**
 * Hand the file back.
 *
 * **Always as a download, never as something the browser will render or run.** The declared
 * content type is recorded as a fact about what the device claimed and is deliberately not
 * used to decide how this is served — an operator's browser executing a file somebody
 * uploaded is the obvious way into a control room, and `image/svg+xml` is a script.
 *
 * A file whose bytes no longer match the recorded hash is **still served**, with a header
 * saying so. It may be the only photograph of the scene. What must never happen is presenting
 * it as verified.
 */
export async function download(
  pool: Pool,
  root: string,
  res: ServerResponse,
  evidenceId: string,
  identity: Identity,
): Promise<EvidenceReply | null> {
  /**
   * Authority first, bytes second — the same rule `upload` states above, applied in the
   * direction it had been missed.
   *
   * This used to call `fetchEvidence` first, which reads the whole file off disk and hashes
   * it, and only then asked whether the caller was allowed to see the incident. Up to 20 MB
   * of disk read and a SHA-256 over it, for a request that was about to be refused — on the
   * one machine in the DC office that is also taking emergency reports. Any signed-in officer
   * could aim that at files they had no authority for.
   *
   * `find` is the row on its own: enough to learn which incident this belongs to, and nothing
   * touched on disk until the answer is yes.
   */
  const row = await findEvidence(pool, evidenceId);
  if (row === null) return { ok: false, status: 404, error: 'no such evidence' };

  const readable = await readIncident(pool, row.incidentId, identity);
  if (!readable.ok) return { ok: false, status: readable.status, error: readable.error };

  const found = await fetchEvidence(pool, root, evidenceId);
  if (!found.ok) return { ok: false, status: 404, error: found.why };

  const { evidence, bytes, intact } = found.value;

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${encodeURIComponent(evidence.filename)}"`,
    'cache-control': 'no-store',
    // What the device said it was, and whether the bytes still match what was recorded.
    // Both are facts about the evidence; neither decides how it is served.
    'x-declared-type': evidence.contentType,
    'x-sha256': evidence.sha256,
    'x-integrity': intact ? 'verified' : 'MISMATCH',
    // A browser must not be able to sniff its way to executing this.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(bytes);
  return null;
}

export type { Evidence };
