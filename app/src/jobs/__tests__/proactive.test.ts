/**
 * **The district speaks first, and only when it has been told to** — Phase 5, 2026-08-21.
 *
 * ## The test this file exists for is the first one
 *
 * Everything else here proves a feature works. **Test 1 proves the feature does not exist**
 * unless somebody switched it on, and it is written the only way that claim can honestly be
 * made: against a `fetch` that **throws if it is called at all**, with a database seeded so that
 * every one of the three would otherwise fire. A test that asserted *"zero messages were sent"*
 * against a counting stub would pass just as happily if the code sent one and miscounted.
 *
 * That is not belt and braces. This is the first code in the product that messages a handset
 * because **time passed** rather than because a person asked, on a number capped at 250 unique
 * recipients a day, and the deploy carrying it goes out with the flag unset. *"Not one message"*
 * is the shipping condition, so it gets the sharpest assertion in the file.
 *
 * ## What is real here and what is not
 *
 * Real PostgreSQL, real migrations, the real fold, the real claim table and the real SLA clock.
 * **Only Meta is stubbed** — and the send bodies are read back off what the stub was handed,
 * never off anything this file passed in, which is `whatsappPicture.test.ts`'s own rule after
 * four tests once proved a transport could carry a picture nothing ever gave it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append } from '../../db/eventStore.js';
import { noteInbound, recordSent } from '../../db/whatsappStore.js';
import {
  districtDate,
  endOfNamedDistrictDay,
  startOfNamedDistrictDay,
} from '../../domain/districtTime.js';
import type { IncidentEvent } from '../../domain/events.js';
import type { SlaTargets } from '../../domain/sla.js';
import { proactiveFromEnv, toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { runProactivePass, type ProactiveOptions } from '../proactive.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const MINUTE = 60_000;

const CONFIG: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: 'secret',
  verifyToken: 'verify',
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

/**
 * The district's deadlines, supplied rather than read.
 *
 * Thirty minutes for `high` because the arithmetic then has room to be unambiguous: two thirds is
 * twenty, so twenty-five minutes in is past the fraction with five minutes of lead still to run —
 * comfortably clear of `MIN_NUDGE_LEAD_MINUTES` at both ends. Read from `sla_target` instead, this
 * file would be asserting against whatever figures the shared database happened to hold today.
 */
const TARGETS: SlaTargets = {
  critical: 30,
  high: 30,
  moderate: 30,
  low: 30,
  unknown: 30,
};

describe.skipIf(dbUrl === undefined)('the district speaks first (integration)', () => {
  let pool: Pool;
  let seatId: string;
  let personId: string;
  let phone: string;
  let adminSeatId: string;
  let adminPersonId: string;
  let adminPhone: string;
  /**
   * A handset this district has messaged and **never heard from** — the ordinary state of almost
   * every number in Bajaur, and the one this file could not otherwise reach.
   *
   * ⚠️ **It exists because the shut-window test failed on its own predecessor.** Meta's window is
   * keyed on the number and lasts a day, so the nudge test two above it opens `phone` and leaves
   * it open — and the test asserting *"a shut window sends nothing"* then ran against an open one
   * and reported the feature broken. That shape passes until somebody reorders the file, which is
   * why the fixture is seeded here rather than the assertion loosened.
   */
  let silentPhone: string;

  /** Every body the provider was handed. The only evidence any assertion here reads. */
  let sent: string[];

  const stubFetch = (async (_url: string, init?: { body?: unknown }) => {
    sent.push(typeof init?.body === 'string' ? init.body : '');
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${String(sent.length)}` }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  /**
   * A `fetch` that cannot be called without failing the test.
   *
   * The whole of test 1. Counting sends would prove the counter; **throwing proves the network
   * was never reached**, which is the claim being made about the deploy.
   */
  const forbiddenFetch = (async () => {
    throw new Error('the proactive pass sent a message with the flag off');
  }) as unknown as typeof fetch;

  /**
   * Later today, and **never tomorrow**.
   *
   * `escalation.test.ts` and `districtDay.test.ts` both carry this clamp and the reason it is not
   * optional: every incident here is reported at real *now*, and this pass selects on the
   * district's own day, so `Date.now() + 25 minutes` silently becomes a **different day** for the
   * last half hour of every night and the whole file goes red at 23:59 having been green since
   * breakfast. Backdating `occurredAt` instead is not an alternative — `append` takes
   * `recorded_at` from the database clock, so a backdated report reads as a late arrival and the
   * ten-minute grace replaces the target.
   */
  function minutesLater(minutes: number): string {
    const wanted = Date.now() + minutes * MINUTE;
    const dayEnd = endOfNamedDistrictDay(districtDate());
    if (dayEnd === null) return new Date(wanted).toISOString();
    return new Date(Math.min(wanted, Date.parse(dayEnd) - 1_000)).toISOString();
  }

  /** An open, unacknowledged emergency, reported now. */
  async function anEmergency(): Promise<string> {
    const incidentId = randomUUID();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'reported',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 1,
        actorPersonId: null,
        actorSeatId: seatId,
        sourceChannel: 'mobile',
        payload: {
          reportId: randomUUID(),
          category: 'fire',
          severity: 'high',
          kind: 'emergency',
          description: 'proactive test',
        },
      } as unknown as IncidentEvent,
    ]);
    return incidentId;
  }

  /**
   * Record that the district actually messaged this handset about that emergency.
   *
   * **This is the precondition, not scaffolding.** `handsetsToldAbout` reads `whatsapp_message`,
   * so without a row here every pass finds nobody and every assertion below would be satisfied by
   * the feature being broken.
   */
  async function toldAbout(incidentId: string, to = phone): Promise<string> {
    const attemptId = randomUUID();
    await recordSent(pool, {
      providerMessageId: `wamid.seed.${randomUUID()}`,
      attemptId,
      incidentId,
      toPhone: toE164(to),
    });
    return attemptId;
  }

  /** Open Meta's window on a number, as an inbound message does. */
  async function windowOpen(to = phone): Promise<void> {
    await noteInbound(pool, toE164(to), new Date().toISOString());
  }

  async function resolveIt(incidentId: string, by: string | null): Promise<void> {
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'resolved',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 2,
        actorPersonId: by,
        actorSeatId: by === null ? null : seatId,
        sourceChannel: 'sms',
        payload: { outcome: 'the fire is out' },
      } as unknown as IncidentEvent,
    ]);
  }

  const run = (
    enabled: readonly ('nudge' | 'closed' | 'summary')[],
    extra: Partial<ProactiveOptions> = {},
  ): ReturnType<typeof runProactivePass> =>
    runProactivePass(pool, {
      config: CONFIG,
      settings: { enabled: new Set(enabled), unrecognised: [] },
      fetchImpl: stubFetch,
      targets: TARGETS,
      ...extra,
    });

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    const dept = await seedDepartment(pool, `Rescue (proactive ${randomUUID().slice(0, 6)})`);
    const actor = await seedActor(pool, { title: 'Duty Officer (proactive)', departmentId: dept });
    seatId = actor.seatId;
    personId = actor.personId;
    phone = actor.phone;

    // The administration's own duty holder, for the summary. `seedActor` marks the department
    // administrative when a district-tier seat is asked for, which is what `summaryPass` selects
    // on — the flag the schema maintains, never a department code.
    const admin = await seedActor(pool, {
      title: 'ADC General (proactive)',
      tier: 'district',
    });
    adminSeatId = admin.seatId;
    adminPersonId = admin.personId;
    adminPhone = admin.phone;

    const silent = await seedActor(pool, {
      title: 'Duty Officer (never replies)',
      departmentId: dept,
    });
    silentPhone = silent.phone;
  }, 60_000);

  afterAll(async () => {
    // Only this run's claims. The summary is keyed on a date, so leaving them would make a second
    // run today find its own row already standing and report a feature that works as broken.
    await pool?.query('DELETE FROM whatsapp_proactive WHERE phone = ANY($1::text[])', [
      [toE164(phone), toE164(adminPhone), toE164(silentPhone)],
    ]);
    await pool?.end();
  });

  beforeEach(() => {
    sent = [];
  });

  it('sends nothing at all when the flag is not set — and the fetch throws if it is asked to', async () => {
    /**
     * 🔴 **The shipping condition, and every one of the three is armed.**
     *
     * An emergency past two thirds of its allowance with a handset that was told and whose window
     * is open; the same emergency closed; and an administrator with an open window, after the
     * summary hour. With the flag on, all three send. With it absent, the pass must not reach the
     * network — so `forbiddenFetch` throws rather than counts, and `runProactivePass` is asked
     * three times: absent, an explicit `off`, and a word that names nothing.
     */
    const incidentId = await anEmergency();
    await toldAbout(incidentId);
    await windowOpen();
    await windowOpen(adminPhone);
    await resolveIt(incidentId, null);

    const morning = `${districtDate()}`;
    const at9 = new Date(Date.parse(startOfNamedDistrictDay(morning) ?? '') + 9 * 3_600_000);

    for (const env of [
      {},
      { WHATSAPP_PROACTIVE: '' },
      { WHATSAPP_PROACTIVE: 'off' },
      { WHATSAPP_PROACTIVE: 'nudges' },
    ]) {
      const settings = proactiveFromEnv(env);
      expect(settings.enabled.size).toBe(0);

      const outcome = await runProactivePass(pool, {
        config: CONFIG,
        settings,
        fetchImpl: forbiddenFetch,
        targets: TARGETS,
        incidentIds: [incidentId],
        now: at9.toISOString(),
      });

      expect(outcome).toEqual({ nudged: 0, closed: 0, summarised: 0, failed: 0 });
    }

    // And nothing was claimed either, which is the half a counter cannot see: a pass that claimed
    // and then failed to send would report zero and have spent the officer's one nudge.
    const claims = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM whatsapp_proactive WHERE phone = ANY($1::text[])',
      [[toE164(phone), toE164(adminPhone)]],
    );
    expect(Number(claims.rows[0]?.n)).toBe(0);
  });

  it('nudges the officer before the ladder climbs, once and only once', async () => {
    const incidentId = await anEmergency();
    await toldAbout(incidentId);
    await windowOpen();

    const first = await run(['nudge'], {
      incidentIds: [incidentId],
      now: minutesLater(25),
    });

    expect(first.nudged).toBe(1);
    expect(sent).toHaveLength(1);

    const body = JSON.parse(sent[0] as string) as {
      to: string;
      type: string;
      interactive: { body: { text: string }; action: { buttons: { reply: { id: string } }[] } };
    };

    expect(body.to).toBe(toE164(phone));
    // It says what happens next, and the button carries the emergency rather than relying on
    // whatever the last message to that number happened to be.
    expect(body.interactive.body.text).toContain('office above yours');
    expect(body.interactive.action.buttons[0]?.reply.id).toContain(incidentId);

    /**
     * ⚠️ **The second pass is the point of this test.** The scheduler ticks every fifteen
     * seconds and *"unacknowledged and running out of time"* is a standing condition, so without
     * `claimProactive` this is four messages a minute to an officer at 02:00.
     */
    const second = await run(['nudge'], { incidentIds: [incidentId], now: minutesLater(26) });
    expect(second.nudged).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('says nothing to a handset whose window is shut', async () => {
    /**
     * Told, and **never heard from** — the ordinary state of most of this district's numbers, and
     * the reason `sessionWindowOpen` is asked at all: sent anyway, Meta refuses this with a
     * `131047` that reads like nothing in particular in a district office.
     *
     * ⚠️ **Its own handset, and that is not tidiness.** The window belongs to the number and lasts
     * a day, so running this against `phone` measures whether the nudge test above happened to run
     * first — which it does, and this assertion failed for exactly that reason before the fixture
     * was split.
     */
    const incidentId = await anEmergency();
    await toldAbout(incidentId, silentPhone);

    const outcome = await run(['nudge'], { incidentIds: [incidentId], now: minutesLater(25) });

    expect(outcome.nudged).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('does not nudge an officer who still has most of their time', async () => {
    const incidentId = await anEmergency();
    await toldAbout(incidentId);
    await windowOpen();

    // Ten minutes into a thirty-minute allowance. A reminder here is the message that is there
    // every time, which is the message people stop reading.
    const outcome = await run(['nudge'], { incidentIds: [incidentId], now: minutesLater(10) });

    expect(outcome.nudged).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('tells the officers it is closed, and never the officer who closed it', async () => {
    const incidentId = await anEmergency();
    await toldAbout(incidentId);
    await toldAbout(incidentId, adminPhone);
    await windowOpen();
    await windowOpen(adminPhone);

    // The seeded officer resolved it from their own thread, so `say()` has already thanked them
    // by name. A second "this is closed" seconds later reads as the software having lost track.
    await resolveIt(incidentId, personId);

    const outcome = await run(['closed'], { incidentIds: [incidentId] });

    expect(outcome.closed).toBe(1);
    expect(sent).toHaveLength(1);

    const body = JSON.parse(sent[0] as string) as { to: string; text: { body: string } };
    expect(body.to).toBe(toE164(adminPhone));
    expect(body.to).not.toBe(toE164(phone));
    expect(body.text.body).toContain('closed');

    // Idempotent for the same reason the nudge is: this pass runs on every tick for six hours.
    const again = await run(['closed'], { incidentIds: [incidentId] });
    expect(again.closed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('sends the administration one summary a day, and not before the morning', async () => {
    await windowOpen(adminPhone);

    const today = districtDate();
    const dayStart = Date.parse(startOfNamedDistrictDay(today) ?? '');

    // 02:00 in Bajaur. The day it would report has ended, and nobody is at a desk.
    const tooEarly = await run(['summary'], {
      now: new Date(dayStart + 2 * 3_600_000).toISOString(),
    });
    expect(tooEarly.summarised).toBe(0);
    expect(sent).toHaveLength(0);

    const morning = new Date(dayStart + 9 * 3_600_000).toISOString();
    const first = await run(['summary'], { now: morning });

    expect(first.summarised).toBe(1);
    expect(sent).toHaveLength(1);

    const body = JSON.parse(sent[0] as string) as { to: string; text: { body: string } };
    expect(body.to).toBe(toE164(adminPhone));
    // Yesterday's date, because that is the only day it can report completely.
    const yesterday = districtDate(new Date(dayStart - 1).toISOString());
    expect(body.text.body).toContain(yesterday);

    const second = await run(['summary'], {
      now: new Date(dayStart + 11 * 3_600_000).toISOString(),
    });
    expect(second.summarised).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('leaves the officer alone when only the closing word is switched on', async () => {
    /**
     * The three are independent, and the flag is read per kind rather than as one boolean —
     * because a closing word costs nothing and reads as courtesy, where a nudge is the district
     * interrupting somebody who has not answered yet, and an owner may well want those on
     * different days.
     */
    const incidentId = await anEmergency();
    await toldAbout(incidentId);
    await windowOpen();

    const outcome = await run(['closed'], { incidentIds: [incidentId], now: minutesLater(25) });

    expect(outcome.nudged).toBe(0);
    expect(sent).toHaveLength(0);
    expect(adminSeatId).not.toBe(seatId);
    expect(adminPersonId).not.toBe(personId);
  });
});
