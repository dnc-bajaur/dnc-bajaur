/**
 * The service window and the question waiting on an answer — Phase A, 2026-08-20.
 *
 * Against real PostgreSQL, because everything here is about *time* and *ordering* and both are
 * the database's answers rather than this code's. What the tests hold down:
 *
 *   * **A retried webhook must never walk the window backwards.** Meta redelivers inbound
 *     messages out of order as a matter of routine, and a window that shuts because an older
 *     timestamp arrived second is a follow-up the officer never receives — replaced by the link
 *     they were promised they would not need.
 *   * **A question is claimed exactly once.** The same redelivery would otherwise append the
 *     same substitute's name to an incident twice, and the district's record would show a
 *     meeting two people are attending in one officer's place.
 *   * **An expired question is not an answer.** A sentence typed on Thursday is not the reply to
 *     a meeting answered on Monday, and attaching it would be inventing the record.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../pool.js';
import {
  SESSION_WINDOW_HOURS,
  answerQuestion,
  noteInbound,
  pendingQuestion,
  recordQuestion,
  sessionWindowOpen,
} from '../whatsappStore.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));

/** Unique per run, so two suites against one database cannot read each other's numbers. */
const PHONE = `9230011${String(Math.floor(Math.random() * 90000) + 10000)}`;

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

describe.skipIf(dbUrl === undefined)('the 24-hour service window', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, join(here, '..', '..', '..', 'db', 'migrations'));
  }, 60_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM whatsapp_question WHERE phone LIKE $1', ['9230011%']);
    await pool?.query('DELETE FROM whatsapp_window WHERE phone LIKE $1', ['9230011%']);
    await pool?.end();
  });

  it('is shut for a number nobody has ever heard from', async () => {
    // No row is a shut window, and that is the safe answer as well as the true one: it means the
    // ordinary template path, which is what every message did before any of this existed.
    expect(await sessionWindowOpen(pool, `${PHONE}0`)).toBe(false);
  });

  it('opens when the number says something, and shuts when that goes stale', async () => {
    const fresh = `${PHONE}1`;
    const stale = `${PHONE}2`;

    await noteInbound(pool, fresh, new Date().toISOString());
    await noteInbound(pool, stale, hoursAgo(SESSION_WINDOW_HOURS + 1));

    expect(await sessionWindowOpen(pool, fresh)).toBe(true);
    expect(await sessionWindowOpen(pool, stale)).toBe(false);
  });

  it('does not let a redelivered older webhook shut a window that is open', async () => {
    /**
     * The ordering failure, and the reason `noteInbound` uses `GREATEST`.
     *
     * An officer taps at 02:00. Meta redelivers a message from yesterday afternoon at 02:01 —
     * which it does, on any non-2xx, for hours. A plain overwrite would date the window from
     * yesterday, `sessionWindowOpen` would say shut, and the follow-up asking who is coming in
     * their place would never be sent. Nothing would fail; the officer would simply be handed a
     * link, and the whole point of this work would be quietly undone at the moment it mattered.
     */
    const phone = `${PHONE}3`;

    await noteInbound(pool, phone, new Date().toISOString());
    await noteInbound(pool, phone, hoursAgo(SESSION_WINDOW_HOURS + 5));

    expect(await sessionWindowOpen(pool, phone)).toBe(true);
  });
});

describe.skipIf(dbUrl === undefined)('the question the district is waiting on', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, join(here, '..', '..', '..', 'db', 'migrations'));
  }, 60_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM whatsapp_question WHERE phone LIKE $1', ['9230012%']);
    await pool?.end();
  });

  const ask = async (
    pool: Pool,
    phone: string,
  ): Promise<{ questionId: string; incidentId: string; attemptId: string }> => {
    const incidentId = randomUUID();
    const attemptId = randomUUID();
    const questionId = await recordQuestion(pool, {
      phone,
      incidentId,
      attemptId,
      asks: 'substitute',
    });
    return { questionId, incidentId, attemptId };
  };

  it('has nothing pending for a number that was never asked', async () => {
    expect(await pendingQuestion(pool, '923001299999')).toBeNull();
  });

  it('carries the incident and attempt the question was about', async () => {
    const phone = '923001200001';
    const asked = await ask(pool, phone);

    const found = await pendingQuestion(pool, phone);
    expect(found).toEqual({
      questionId: asked.questionId,
      incidentId: asked.incidentId,
      attemptId: asked.attemptId,
      asks: 'substitute',
    });
  });

  it('answers the most recent question, and says so by returning that one', async () => {
    // Two meetings, two substitutes. The officer is answering what they were most recently
    // asked — the same inference `lastMessageTo` makes about which incident a reply belongs to,
    // and it is stated as an inference in both places rather than presented as a certainty.
    const phone = '923001200002';
    await ask(pool, phone);
    const second = await ask(pool, phone);

    expect((await pendingQuestion(pool, phone))?.questionId).toBe(second.questionId);
  });

  it('is claimed exactly once, so a redelivered reply appends nothing twice', async () => {
    const phone = '923001200003';
    const asked = await ask(pool, phone);

    expect(await answerQuestion(pool, asked.questionId, 'Nasir Khan, ADC')).toBe(true);
    // Meta redelivers. The second call must not be the one that writes the event.
    expect(await answerQuestion(pool, asked.questionId, 'Nasir Khan, ADC')).toBe(false);

    // And it is no longer waiting, so the officer's next message is an ordinary reply again.
    expect(await pendingQuestion(pool, phone)).toBeNull();
  });

  it('keeps an answered question rather than deleting it', async () => {
    // A question nobody answered is exactly the failure worth surfacing later, so rows are never
    // removed on answer — the district must be able to see that it asked.
    const phone = '923001200004';
    const asked = await ask(pool, phone);
    await answerQuestion(pool, asked.questionId, 'Bilal, AAC Mamund');

    const row = await pool.query<{ answer: string; answered_at: Date }>(
      'SELECT answer, answered_at FROM whatsapp_question WHERE question_id = $1',
      [asked.questionId],
    );
    expect(row.rows[0]?.answer).toBe('Bilal, AAC Mamund');
    expect(row.rows[0]?.answered_at).not.toBeNull();
  });

  it('stops treating a stale question as pending', async () => {
    const phone = '923001200005';
    const asked = await ask(pool, phone);

    // Aged past the window. Past this, a typed reply is an ordinary reply again.
    await pool.query(
      "UPDATE whatsapp_question SET expires_at = now() - interval '1 minute' WHERE question_id = $1",
      [asked.questionId],
    );

    expect(await pendingQuestion(pool, phone)).toBeNull();
  });
});
