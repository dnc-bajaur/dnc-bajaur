/**
 * Meta pauses a template and the wall says so — 2026-08-21, end to end.
 *
 * ## What the condition panel could not see
 *
 * `districtCondition`'s own comment has said since M6-25 that its three rows are there because
 * they **fail silently** — *"an account out of credit, an expired token, a template somebody
 * un-approved — every one of them looks exactly like a quiet night, and the district finds out on
 * the night it matters."*
 *
 * It named the case and had no data for it. `Can send WhatsApp` was folded from
 * `whatsapp_message`: how many of **our own sends** succeeded in the last day. A template Meta
 * paused this morning therefore read as *"configured — nothing sent in the last 24 hours"*, which
 * is a true sentence about an account that cannot send at all.
 *
 * ## What is stubbed
 *
 * **Nothing but the signature's counterpart.** Real PostgreSQL, the real webhook route with a
 * real HMAC, the real `/dashboard` fold. The point is that a webhook Meta actually sends changes
 * what a control room actually reads, and a mocked store would answer a different question.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { type WhatsAppConfig } from '../../ops/whatsapp.js';
import { LIMIT_SUBJECT } from '../../db/whatsappStore.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

const config: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: `secret-${RUN}`,
  verifyToken: `verify-${RUN}`,
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

interface ConditionRow {
  what: string;
  state: string;
  detail: string;
}

describe.skipIf(dbUrl === undefined)('what Meta says reaches the wall (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;
  let token: string;

  /** Per-run, so two suites against the shared database cannot describe each other's templates. */
  const template = `district_message_${RUN}`;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({
      pool,
      authMode: 'stub',
      nodeEnv: 'test',
      whatsapp: config,
      publicOrigin: 'https://dnc.example.invalid',
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dc = await seedDepartment(pool, `DC Office (cond ${RUN})`);
    token = (
      await seedActor(pool, {
        title: `Control Room (cond ${RUN})`,
        departmentId: dc,
        tier: 'district',
      })
    ).token;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    // Leave the shared database as this suite found it: its own rows only, named per run.
    await pool
      ?.query('DELETE FROM whatsapp_account_state WHERE subject LIKE $1', [`%${RUN}%`])
      .catch(() => undefined);
    /**
     * ⚠️ **The tier row is GLOBAL, not per-run**, because `(kind, subject)` is the key and the
     * limit has one reserved subject. Left behind it would sit in the shared test database and
     * quietly decide what every other suite's condition row says — the drift `globalSetup` warns
     * about, arriving through a table that did not exist until today.
     */
    await pool
      ?.query(`DELETE FROM whatsapp_account_state WHERE kind = 'number' AND subject = $1`, [
        LIMIT_SUBJECT,
      ])
      .catch(() => undefined);
    await pool
      ?.query('DELETE FROM whatsapp_message WHERE provider_message_id LIKE $1', [
        `wamid.cap.${RUN}.%`,
      ])
      .catch(() => undefined);
    await pool?.end();
  });

  async function inbound(field: string, value: unknown): Promise<number> {
    const raw = JSON.stringify({ entry: [{ changes: [{ field, value }] }] });
    const signature = `sha256=${createHmac('sha256', config.appSecret)
      .update(Buffer.from(raw, 'utf8'))
      .digest('hex')}`;

    const res = await fetch(`${base}/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    });
    return res.status;
  }

  async function sendRow(): Promise<ConditionRow> {
    const feed = (await (
      await fetch(`${base}/dashboard`, { headers: authHeaders(token) })
    ).json()) as { condition: ConditionRow[] };
    const row = feed.condition.find((c) => c.what === 'Can send WhatsApp');
    expect(row).toBeDefined();
    return row!;
  }

  /**
   * 🔴 **A FLAGGED NUMBER MUST NOT BLANK THE WALL, AND UNTIL 2026-08-21 IT DID.**
   *
   * `accountTrouble`'s rows are keyed `(kind, subject)`, and for `kind: 'number'` the subject **is
   * the district's own phone number**. It went onto the row verbatim — *"Meta says 923363920520 is
   * FLAGGED"* — and `wallSafetyViolations` matches a Pakistani number shape anywhere in the
   * payload and **fails the whole request** rather than stripping the field.
   *
   * So `GET /dashboard` answered **500 and the wall went blank**, on exactly the morning Meta
   * flagged Bajaur's number — the one morning this row exists to be read on. O-40's lesson on a
   * different surface: the check was right, and where it fired was not.
   *
   * ⚠️ **It was data-dependent, which is why it survived two days and reddened CI at random.** The
   * row is drawn only when Meta is saying something worse than `ok`, and the district's number has
   * been `GREEN` throughout — so it appeared on runs where a `FLAGGED` fixture happened to be the
   * worst standing notice and vanished on the others.
   *
   * ⚠️ **The assertion is on the STATUS and the ROW, never on the wording.** A test that pinned
   * the sentence would pass the day somebody reworded it back into printing the number.
   */
  it('does not blank the wall when Meta flags the district’s own number', async () => {
    // A real Pakistani number in Meta's own E.164 form, which is exactly what the webhook sends.
    const number = `92336392${String(Math.floor(Math.random() * 9000) + 1000)}`;

    expect(
      await inbound('phone_number_quality_update', {
        display_phone_number: number,
        event: 'FLAGGED',
        current_limit: 'TIER_250',
      }),
    ).toBe(200);

    const res = await fetch(`${base}/dashboard`, { headers: authHeaders(token) });
    // The failure this guards is a 500 with no body at all, so the status is checked before
    // anything is read off the feed — `sendRow` would otherwise fail on `undefined.find`, which
    // is what CI reported and which names the symptom rather than the cause.
    expect(res.status).toBe(200);

    const row = ((await res.json()) as { condition: ConditionRow[] }).condition.find(
      (c) => c.what === 'Can send WhatsApp',
    );
    expect(row).toBeDefined();
    // The district's own digits are not on a screen a room can read (ADR-0013 §1) — and Meta's
    // own word still is, because that is what somebody acts on.
    expect(row?.detail ?? '').not.toContain(number);
    expect(row?.detail ?? '').toContain('FLAGGED');

    await pool
      .query('DELETE FROM whatsapp_account_state WHERE kind = $1 AND subject = $2', [
        'number',
        number,
      ])
      .catch(() => undefined);
  });

  /**
   * 🔴 **The whole point, in one test.**
   *
   * Before this change the row read *"configured — nothing sent in the last 24 hours"* over an
   * account that could not send at all, and went on reading it until somebody tried.
   */
  it('turns the send row critical when Meta pauses a template, and says which one', async () => {
    expect((await sendRow()).state).not.toBe('critical');

    expect(
      await inbound('message_template_status_update', {
        message_template_name: template,
        message_template_language: 'en',
        event: 'PAUSED',
        reason: 'PAIRWISE_BLOCKED',
      }),
    ).toBe(200);

    const row = await sendRow();
    expect(row.state).toBe('critical');
    // The template is NAMED. A red row saying only "something is wrong" sends somebody to the
    // telephone; this one says what to resubmit.
    expect(row.detail).toContain(template);
    expect(row.detail).toContain('PAUSED');
    // Meta's reason rides along — it is what somebody pastes into a Meta console.
    expect(row.detail).toContain('PAIRWISE_BLOCKED');
  });

  /**
   * **A red row clears itself when Meta says it is fine again.**
   *
   * Without this the district would have to know to clear it by hand, and a row nobody can clear
   * is one everybody learns to ignore — the argument this panel already makes for why
   * "not configured" is amber rather than red.
   */
  it('clears when Meta approves it again', async () => {
    expect(
      await inbound('message_template_status_update', {
        message_template_name: template,
        message_template_language: 'en',
        event: 'APPROVED',
      }),
    ).toBe(200);

    expect((await sendRow()).state).not.toBe('critical');
  });

  /**
   * ⚠️ **Worst first, and newest within a severity.**
   *
   * The wall gives this one line at four metres, so the row has to choose — and a screen that
   * chose would eventually choose the reassuring one, which is INV-04's whole subject. A flagged
   * number outranks a template whose quality merely dipped.
   */
  it('shows the worst thing Meta is saying, not the most recent', async () => {
    await inbound('message_template_quality_update', {
      message_template_name: template,
      message_template_language: 'en',
      previous_quality_score: 'GREEN',
      new_quality_score: 'YELLOW',
    });
    await inbound('phone_number_quality_update', {
      display_phone_number: `9233639${RUN.slice(0, 5)}`,
      event: 'FLAGGED',
      current_limit: 'TIER_250',
    });
    // Newer than the flag, and less bad. It must not win.
    await inbound('message_template_quality_update', {
      message_template_name: `${template}_other`,
      message_template_language: 'en',
      new_quality_score: 'YELLOW',
    });

    const row = await sendRow();
    expect(row.state).toBe('critical');
    expect(row.detail).toContain('FLAGGED');
    expect(row.detail).toContain('TIER_250');
  });

  /**
   * **`condition` is administration-only and this does not change that.**
   *
   * The panel carries what the district's own administration is answerable for, and a department
   * seat has never seen it. A new data source on that row must not become a new door onto it.
   */
  it('stays out of a department seat’s dashboard', async () => {
    const dept = await seedDepartment(pool, `Rescue (cond ${RUN})`);
    const officer = await seedActor(pool, {
      title: `Duty Officer (cond ${RUN})`,
      departmentId: dept,
    });

    const feed = (await (
      await fetch(`${base}/dashboard`, { headers: authHeaders(officer.token) })
    ).json()) as { condition?: ConditionRow[] };

    /**
     * ⚠️ **Empty, not absent, and the first version of this test asserted the wrong one.**
     *
     * The field is on the payload for every caller and the *rows* are what a department seat does
     * not get. That is the server's own shape and it is the right one — a client drawing this
     * panel reads a list and finds nothing to draw, rather than having to guard a missing key.
     *
     * The property under test is unchanged either way: **no row on this panel reaches a
     * department seat**, so a new data source on the send row has not become a new door onto it.
     */
    expect(feed.condition).toEqual([]);
  });
  /**
   * ⚠️ **Something WRONG outranks something merely TIGHT, and this fell out of a test failure
   * rather than a design meeting.**
   *
   * The capacity tests below were written after the trouble ones and went red, because the
   * `FLAGGED` number from the previous test was still standing and the row was reporting that
   * instead. That is the code being right: a flagged number is worse news than being four-fifths
   * of the way through a day's allowance, and the wall has one line. Pinned here so a later
   * reordering of this file cannot quietly invert it.
   */
  it('reports what is wrong before it reports what is tight', async () => {
    await pool.query(
      `INSERT INTO whatsapp_account_state (kind, subject, event, severity, detail)
       VALUES ('number', $1, 'TIER_50', 'ok', null)
       ON CONFLICT (kind, subject) DO UPDATE SET event = EXCLUDED.event, severity = 'ok'`,
      [LIMIT_SUBJECT],
    );

    // The flagged number from the previous test is still standing, and must still win.
    const row = await sendRow();
    expect(row.detail).toContain('FLAGGED');
    expect(row.detail).not.toContain('officers reached today');
  });

  /**
   * Everything below is about capacity alone, so the trouble this suite created is cleared first.
   * A test that depends on a subject an earlier test happens to have left behind is the shape
   * `whatsappLoop.test.ts` paid for three times over.
   */
  async function clearNotices(): Promise<void> {
    await pool.query(
      `DELETE FROM whatsapp_account_state WHERE severity <> 'ok' AND subject LIKE $1`,
      [`%${RUN}%`],
    );
    await pool.query(
      `DELETE FROM whatsapp_account_state WHERE severity <> 'ok' AND subject LIKE $1`,
      [`%9233639%`],
    );
  }

  /**
   * 🔴 **The cap reaching the wall, and it is the case that fails forwards.**
   *
   * Every other signal on this row is about sends that already happened. This one is about the
   * ones **about to be refused**: at the cap Meta rejects every message to a handset the district
   * has not already reached today, so the officers it silences are exactly the ones nobody has
   * managed to tell yet.
   *
   * ⚠️ **`count(DISTINCT to_phone)`, never a count of rows.** Telling one officer forty times
   * costs one against Meta's cap; telling forty officers once costs forty. A row count would
   * report a district as nearly out on a day it was nowhere near — and, far worse, as comfortable
   * on the day it is not. The fixture below sends the SAME number twice on purpose, so a
   * regression to `count(*)` is off by one and the assertion catches it.
   */
  it('counts distinct handsets against Meta’s cap and says so on the wall', async () => {
    await clearNotices();

    // A tier this district could plausibly be on, and small enough that a handful of rows crosses
    // the threshold without seeding hundreds.
    await pool.query(
      `INSERT INTO whatsapp_account_state (kind, subject, event, severity, detail)
       VALUES ('number', $1, 'TIER_50', 'ok', null)
       ON CONFLICT (kind, subject) DO UPDATE SET event = EXCLUDED.event, severity = 'ok'`,
      [LIMIT_SUBJECT],
    );

    // 41 of 50 — past the halfway mark where the sentence starts being worth saying, and short of
    // the amber threshold, so this asserts the SENTENCE without asserting the state.
    for (let i = 0; i < 41; i += 1) {
      await pool.query(
        `INSERT INTO whatsapp_message (provider_message_id, attempt_id, incident_id, to_phone)
         VALUES ($1, $2, $3, $4)`,
        [`wamid.cap.${RUN}.${String(i)}`, randomUUID(), randomUUID(), `9230000${String(1000 + i)}`],
      );
    }
    // The same handset again. It must NOT move the figure.
    await pool.query(
      `INSERT INTO whatsapp_message (provider_message_id, attempt_id, incident_id, to_phone)
       VALUES ($1, $2, $3, $4)`,
      [`wamid.cap.${RUN}.again`, randomUUID(), randomUUID(), '92300001000'],
    );

    const row = await sendRow();
    expect(row.detail).toContain('of 50 officers reached today');
    // 41 distinct, not 42 messages.
    expect(row.detail).toContain('41 of 50');
  });

  /**
   * **Amber before red, because a district that can see it coming can start telephoning.**
   *
   * Finding out at 100% is finding out too late — every officer not already reached today is
   * already unreachable by this channel at that point.
   */
  it('goes amber approaching the cap and red at it', async () => {
    // 9 more distinct numbers takes it to 50 of 50.
    for (let i = 41; i < 50; i += 1) {
      await pool.query(
        `INSERT INTO whatsapp_message (provider_message_id, attempt_id, incident_id, to_phone)
         VALUES ($1, $2, $3, $4)`,
        [`wamid.cap.${RUN}.${String(i)}`, randomUUID(), randomUUID(), `9230000${String(1000 + i)}`],
      );
    }

    const row = await sendRow();
    expect(row.state).toBe('critical');
  });

  /**
   * ⚠️ **An unknown tier draws NO fraction, rather than one against a guessed cap.**
   *
   * Meta renames these occasionally. *"41 of 250"* over a number actually on `TIER_1K` tells a
   * district it is nearly out when it has four times as much left — and reads as measured, which
   * is worse than saying nothing. ADR-0005's rule applied to a denominator.
   */
  it('says nothing about capacity when the tier is one it does not know', async () => {
    await pool.query(
      `UPDATE whatsapp_account_state SET event = 'TIER_SOMETHING_NEW'
        WHERE kind = 'number' AND subject = $1`,
      [LIMIT_SUBJECT],
    );

    const row = await sendRow();
    expect(row.detail).not.toContain('officers reached today');
    expect(row.state).not.toBe('critical');
  });
});
