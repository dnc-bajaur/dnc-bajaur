/**
 * The link that carries a file to a handset — M9-18, M9-19.
 *
 * **This is a route with no session, reachable from the open internet.** So the tests that
 * matter are not the happy path — they are the ones about what a token does *not* grant, and
 * about telling an officer the truth when it does not work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createPool, migrate, type Pool } from '../pool.js';
import {
  FILE_TOKEN_TTL_DAYS,
  mintFileToken,
  redeemFileToken,
  sweepExpiredFileTokens,
} from '../fileTokenStore.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));

describe.skipIf(dbUrl === undefined)('file tokens', () => {
  let pool: Pool;
  let incidentId: string;
  let evidenceId: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, join(here, '..', '..', '..', 'db', 'migrations'));

    // A row to point at. The FK is real, so this cannot be a bare uuid.
    incidentId = randomUUID();
    evidenceId = randomUUID();
    await pool.query(
      `INSERT INTO evidence
         (evidence_id, incident_id, filename, content_type, byte_size, sha256, stored_path)
       VALUES ($1, $2, 'notice.pdf', 'application/pdf', 10, repeat('a', 64), 'x/y.pdf')`,
      [evidenceId, incidentId],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM file_token WHERE evidence_id = $1', [evidenceId]);
    await pool?.query('DELETE FROM evidence WHERE evidence_id = $1', [evidenceId]);
    await pool?.end();
  });

  function subject(): Parameters<typeof mintFileToken>[1] {
    return { evidenceId, incidentId, seatId: null, personId: null };
  }

  it('opens the file it was minted for', async () => {
    const token = await mintFileToken(pool, subject());
    const result = await redeemFileToken(pool, token);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.subject.evidenceId).toBe(evidenceId);
  });

  it('WORKS TWICE — an officer opens the notice again at the meeting', async () => {
    // The deliberate difference from the acknowledge token. A file link that died on first use
    // is indistinguishable from a broken one, and the officer's next action is a telephone call.
    const token = await mintFileToken(pool, subject());

    expect((await redeemFileToken(pool, token)).ok).toBe(true);
    expect((await redeemFileToken(pool, token)).ok).toBe(true);
    expect((await redeemFileToken(pool, token)).ok).toBe(true);
  });

  it('counts every open, which is the closest thing to a read receipt ADR-0014 allows', async () => {
    // Opening a file IS a deliberate act by the recipient, unlike a blue tick — so unlike a
    // read receipt, this is worth recording.
    const token = await mintFileToken(pool, subject());
    await redeemFileToken(pool, token);
    await redeemFileToken(pool, token);

    const { rows } = await pool.query<{ opened_count: number; last_opened_at: string | null }>(
      `SELECT opened_count, last_opened_at FROM file_token
        WHERE evidence_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [evidenceId],
    );
    expect(rows[0]?.opened_count).toBe(2);
    expect(rows[0]?.last_opened_at).not.toBeNull();
  });

  it('says "not recognised" for a token nobody minted', async () => {
    const result = await redeemFileToken(pool, 'a'.repeat(43));
    expect(result).toEqual({ ok: false, why: 'unknown' });
  });

  it('says "too old" for an expired one — a DIFFERENT answer, on purpose', async () => {
    // Two answers, never one. "Too old" means ask for a resend; "not recognised" means the link
    // was mangled in forwarding. A single "invalid" sends both officers to the telephone.
    const token = await mintFileToken(pool, subject());
    await pool.query(
      "UPDATE file_token SET expires_at = now() - interval '1 hour' WHERE evidence_id = $1",
      [evidenceId],
    );

    expect(await redeemFileToken(pool, token)).toEqual({ ok: false, why: 'expired' });

    // Put them back so later assertions are not affected.
    await pool.query(
      "UPDATE file_token SET expires_at = now() + interval '1 day' WHERE evidence_id = $1",
      [evidenceId],
    );
  });

  it('does not count an open it refused', async () => {
    const token = await mintFileToken(pool, subject());
    await pool.query(
      "UPDATE file_token SET expires_at = now() - interval '1 hour' WHERE token_hash = (SELECT token_hash FROM file_token WHERE evidence_id = $1 ORDER BY created_at DESC LIMIT 1)",
      [evidenceId],
    );

    await redeemFileToken(pool, token);

    const { rows } = await pool.query<{ opened_count: number }>(
      `SELECT opened_count FROM file_token
        WHERE evidence_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [evidenceId],
    );
    expect(rows[0]?.opened_count).toBe(0);
  });

  it('stores a hash, never the token — a backup leaves the district nightly', async () => {
    const token = await mintFileToken(pool, subject());
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM file_token WHERE encode(token_hash, 'escape') LIKE $1",
      [`%${token.slice(0, 12)}%`],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('mints a different token every time, so two recipients are distinguishable', async () => {
    // One token per recipient, never one shared per file. Otherwise "who opened it" and
    // "revoke this officer's access" are both unanswerable.
    const a = await mintFileToken(pool, subject());
    const b = await mintFileToken(pool, subject());
    expect(a).not.toBe(b);
  });

  it('lives long enough for a notice sent days before the meeting', async () => {
    // A meeting notice sent on Monday for Thursday must open on Thursday. The acknowledge
    // token's 24 hours would be wrong here, and the number is a judgement rather than a default.
    expect(FILE_TOKEN_TTL_DAYS).toBeGreaterThanOrEqual(7);
  });

  it('sweeps only what expired a week ago, so "too old" is still sayable meanwhile', async () => {
    await mintFileToken(pool, subject());
    await pool.query(
      "UPDATE file_token SET expires_at = now() - interval '2 days' WHERE evidence_id = $1",
      [evidenceId],
    );
    await sweepExpiredFileTokens(pool);

    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM file_token WHERE evidence_id = $1',
      [evidenceId],
    );
    // Still there — recently expired, so an officer tapping it is told "too old" rather than
    // "not recognised".
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);

    await pool.query(
      "UPDATE file_token SET expires_at = now() - interval '30 days' WHERE evidence_id = $1",
      [evidenceId],
    );
    expect(await sweepExpiredFileTokens(pool)).toBeGreaterThan(0);
  });
});
