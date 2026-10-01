/**
 * **The control room chases, by hand — Phase 8b, 2026-08-21.**
 *
 * ## The first test is the one this file exists for, and it is a defect that was nearly shipped
 *
 * A follow-up looks exactly like an `action_logged` — *the district did something about this
 * emergency* — and the first draft of this feature used one. `foldIncident` moves an incident to
 * **`responding`** on that event. So pressing *follow up* would have put the emergency on the
 * board as **Responded**, claiming an officer was working on it, **at the precise moment the truth
 * was that nobody had answered** — which is the only reason anybody presses it.
 *
 * It was caught by reading the fold rather than by a test, so test 1 exists to make sure it stays
 * caught. **A false state on the one screen a district acts on, written by the act of chasing.**
 *
 * ## What is real here
 *
 * Real PostgreSQL, real migrations, the real fold, real ack tokens, the real authority table.
 * **Only Meta is stubbed**, and every assertion about a message reads the body the stub was
 * handed rather than anything this file passed in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { noteInbound, recordSent } from '../../db/whatsappStore.js';
import { foldIncident } from '../../domain/incident.js';
import type { IncidentEvent } from '../../domain/events.js';
import { resolveIdentity } from '../../auth/sessions.js';
import type { Identity } from '../../auth/sessions.js';
import { toE164, type WhatsAppConfig } from '../../ops/whatsapp.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { followUp } from '../followUp.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const CONFIG: WhatsAppConfig = {
  phoneNumberId: '999',
  accessToken: 'not-a-real-token',
  appSecret: 'secret',
  verifyToken: 'verify',
  templateName: 'district_message_v3',
  templateLanguage: 'en',
  baseUrl: 'https://example.invalid/v21.0',
};

describe.skipIf(dbUrl === undefined)('the control room chases by hand (integration)', () => {
  let pool: Pool;
  let identity: Identity;
  let seatId: string;
  let personId: string;
  let officerPhone: string;
  /**
   * A handset that has **never written to this number**, kept apart on purpose.
   *
   * ⚠️ **Meta's window is keyed on the NUMBER and lasts a day**, so the test above that opens it
   * leaves it open for every test after it — and the one asserting *"a shut window falls back to a
   * template"* then ran against an open window and reported the feature broken.
   *
   * 🔴 **This is the second time in one day the same trap was walked into**, the first being
   * `jobs/__tests__/proactive.test.ts`, which carries a comment about it written by the same hand
   * that then repeated it here. **A shared, day-long piece of provider state is not a fixture two
   * tests may borrow** — the honest answer is one handset per question, not a looser assertion.
   */
  let silentPhone: string;
  let departmentId: string;

  let sent: string[];
  let refuseNext: boolean;

  const stubFetch = (async (_url: string, init?: { body?: unknown }) => {
    sent.push(typeof init?.body === 'string' ? init.body : '');
    if (refuseNext) {
      return new Response(JSON.stringify({ error: { message: 'bucket said no', code: 131047 } }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ messages: [{ id: `wamid.out.${String(sent.length)}` }] }),
      {
        status: 200,
      },
    );
  }) as unknown as typeof fetch;

  /**
   * A message the control room told one officer about, and nobody has answered.
   *
   * Defaults to the emergency every test in this file was written against. The `what` hook was
   * added on 2026-08-24 so a chase can be driven on a **meeting**, which is the case the owner
   * asked about and the one where this endpoint behaves differently rather than merely reading
   * differently.
   */
  async function toldButUnanswered(
    to: string = officerPhone,
    what: Record<string, unknown> = {},
  ): Promise<{ incidentId: string; wamid: string }> {
    const incidentId = randomUUID();
    const attemptId = randomUUID();
    const wamid = `wamid.first.${randomUUID()}`;

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
          description: 'follow-up test',
          ...what,
        },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 2,
        actorPersonId: personId,
        actorSeatId: seatId,
        sourceChannel: 'web',
        payload: { departmentIds: [departmentId], ruleId: 'manual' },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'notified',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 3,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'system',
        payload: { attemptId, seatId, channel: 'whatsapp', reason: 'dispatched' },
      } as unknown as IncidentEvent,
    ]);

    await recordSent(pool, {
      providerMessageId: wamid,
      attemptId,
      incidentId,
      toPhone: toE164(to),
    });

    return { incidentId, wamid };
  }

  const chase = (incidentId: string, note?: string): ReturnType<typeof followUp> =>
    followUp({
      pool,
      identity,
      incidentId,
      config: CONFIG,
      fetchImpl: stubFetch,
      ...(note === undefined ? {} : { note }),
    });

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    // District tier, because the control room is what this feature is for and `incident.dispatch`
    // is governed by the authority table rather than by anything this test asserts.
    const actor = await seedActor(pool, { title: 'Control Room (follow-up)', tier: 'district' });
    seatId = actor.seatId;
    personId = actor.personId;
    officerPhone = actor.phone;
    departmentId = await seedDepartment(pool, `Rescue (fu ${randomUUID().slice(0, 6)})`);

    const silent = await seedActor(pool, { title: 'Duty Officer (never replies, fu)' });
    silentPhone = silent.phone;

    const resolved = await resolveIdentity(pool, actor.personId);
    if (resolved === null) throw new Error('could not resolve the seeded identity');
    identity = resolved;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => {
    sent = [];
    refuseNext = false;
  });

  it('does NOT move the emergency to Responded — the defect this file exists for', async () => {
    /**
     * 🔴 **An `action_logged` would move the status to `responding`.** A follow-up is sent because
     * nobody has answered, so recording it as an action would tell the board an officer is working
     * on it at exactly the moment nobody is. `followed_up` is its own event and the fold has no
     * case for it, deliberately — and this asserts that stays true.
     */
    const { incidentId } = await toldButUnanswered();

    const before = foldIncident(incidentId, await loadIncident(pool, incidentId));
    const result = await chase(incidentId);
    expect(result.ok).toBe(true);

    const after = foldIncident(incidentId, await loadIncident(pool, incidentId));

    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe('responding');
    // And it did not sneak in as an action either, which is the other half of the same mistake.
    expect(after.actions).toHaveLength(before.actions.length);
  });

  it('names the message it is following up on, in the record', async () => {
    // The district's own requirement: "pehle bheje gaye msg ke baare mein ho … taake record
    // maintain kiya ja sake." Read off the event rather than off the message that was sent,
    // because this half must hold whether or not Meta accepted anything.
    const { incidentId, wamid } = await toldButUnanswered();

    await chase(incidentId, 'Please confirm you are on the way');

    const events = await loadIncident(pool, incidentId);
    const chased = events.filter((e) => e.type === 'followed_up');

    expect(chased).toHaveLength(1);
    const payload = chased[0]?.payload as {
      followsProviderMessageId: string;
      delivered: boolean;
      note: string;
      toPhone: string;
    };
    expect(payload.followsProviderMessageId).toBe(wamid);
    expect(payload.delivered).toBe(true);
    expect(payload.toPhone).toBe(toE164(officerPhone));
    expect(payload.note).toContain('Please confirm you are on the way');
  });

  /**
   * **The fold carries the chases, so a screen can show them** — 2026-08-23.
   *
   * Until today `followed_up` was appended here and read only by the post-incident report,
   * straight off the event list. The state knew nothing about it, so no screen could ask — which
   * is why the board said nothing and the detail timeline printed the bare words *followed up*
   * with no note and no outcome beside them.
   */
  it('puts every chase into the folded state, with whether it got through', async () => {
    const { incidentId } = await toldButUnanswered();

    refuseNext = true;
    await chase(incidentId, 'first try');
    refuseNext = false;
    await chase(incidentId, 'second try');

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.followUps).toHaveLength(2);
    expect(state.followUps[0]?.delivered).toBe(false);
    expect(state.followUps[1]?.delivered).toBe(true);
    expect(state.followUps[0]?.note).toContain('first try');

    /**
     * 🔴 **The rule the board is built on: ANY failed chase counts, not the latest one.**
     *
     * This is `BoardRow.followUp.failed`, asserted here because this is the file that can produce
     * the two-chase history it turns on. A handset the district could not reach stays a fact
     * somebody has to fix — usually a dead number in the roster — and a later chase that happened
     * to go through does not undo it. Reading only the most recent would hide exactly the row an
     * operator needs to act on, which is the failure INV-03 exists to refuse.
     */
    expect(state.followUps.some((f) => !f.delivered)).toBe(true);
  });

  it('quotes the original alert when the officer’s window is open', async () => {
    const { incidentId, wamid } = await toldButUnanswered();
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    const result = await chase(incidentId);

    expect(result.ok && result.chased[0]?.path).toBe('thread');
    expect(sent).toHaveLength(1);

    const body = JSON.parse(sent[0] as string) as {
      type: string;
      context?: { message_id: string };
    };
    /**
     * ⚠️ **This asserted `type: 'text'` until Phase 9a, and the shape legitimately changed.**
     *
     * The follow-up carries the stage buttons now — see the test below for why — so a chase on an
     * emergency with anything still ahead is an `interactive` message rather than a plain one.
     * **The property this test exists for is unchanged and is the sharper half**: the quote rides
     * whichever shape was built. `sendSession` adds `context` to the body it produced rather than
     * building it into each of the three, and this is what says so.
     */
    expect(body.type).toBe('interactive');
    expect(body.context?.message_id).toBe(wamid);
  });

  it('carries the stages still ahead, as buttons bound to this handset’s own attempt', async () => {
    /**
     * 🔴 **The defect the owner found on a real handset, hours after Phase 8c shipped.**
     *
     * The control room chased, the officer typed **"It is resolved"**, and the emergency stayed on
     * the board as *Responded*. It was not a fold bug: the follow-up went as **plain text**, so
     * the officer had no way to answer but typing — and a typed reply is recorded, settles the
     * obligation and acknowledges, and its **words are never read for meaning** (a decision from
     * 2026-08-08, and still the right one).
     *
     * The safe machinery has existed since Phase C. The chase simply did not offer it.
     */
    const { incidentId } = await toldButUnanswered();
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    const attemptId = (
      (await loadIncident(pool, incidentId)).find((e) => e.type === 'notified')?.payload as {
        attemptId: string;
      }
    ).attemptId;

    await chase(incidentId);

    const body = JSON.parse(sent[0] as string) as {
      interactive?: { action?: { buttons?: { reply: { id: string; title: string } }[] } };
    };
    const buttons = body.interactive?.action?.buttons ?? [];

    /**
     * Nothing is recorded yet, so both remaining stages are still ahead — was three
     * (`Acknowledged` included) until 2026-09-04, see `domain/stages.ts`'s header. That is the
     * whole reason `roomForAvailability` now reads true here where it used to read false: from
     * `routed` there were three stages ahead, exactly Meta's cap, and no room for a third button;
     * now there are two, so "Where I am" rides beside them — not a new choice, the same
     * `roomForAvailability` rule in `api/followUp.ts` finding room it did not have before.
     */
    expect(buttons.map((b) => b.reply.title)).toEqual(['Responding', 'Resolved', 'Where I am']);

    /**
     * ⚠️ **Every id names THIS handset's own attempt.** A tap settles the obligation the button
     * was minted against, so a set built once outside the loop would land every officer's answer
     * on whichever attempt happened to be first.
     */
    for (const button of buttons) {
      expect(button.reply.id.endsWith(`:${incidentId}:${attemptId}`)).toBe(true);
    }
  });

  it('offers nothing on an emergency that is already resolved, and stays plain text', async () => {
    /**
     * `stagesOfferedFrom` is the one transition table, and an empty answer is a complete one:
     * a button that cannot move anything is worse than no button, because an officer presses it
     * and is told it did nothing.
     */
    const { incidentId } = await toldButUnanswered();
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    const events = await loadIncident(pool, incidentId);
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId,
        type: 'resolved',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: events.length + 1,
        actorPersonId: personId,
        actorSeatId: seatId,
        sourceChannel: 'web',
        payload: { outcome: 'crew stood down' },
      } as unknown as IncidentEvent,
    ]);

    await chase(incidentId);

    const body = JSON.parse(sent[0] as string) as { type: string };
    expect(body.type).toBe('text');
  });

  it('falls back to an already-approved template when the window is shut, and binds the tap to the original attempt', async () => {
    /**
     * 🔴 **This is the case the feature is actually aimed at.** Meta allows a free-form message
     * only to a number that has written to us in the last day, and an officer who has gone quiet
     * is by definition one who has not. So the alert goes again on a template — **and no template
     * is created or edited for it**, which is the owner's standing instruction.
     *
     * ⚠️ **The ack token is minted against the ORIGINAL attempt.** A tap must settle the row that
     * is already pending rather than open a second one for one emergency.
     */
    const { incidentId } = await toldButUnanswered(silentPhone);
    const attemptId = (
      (await loadIncident(pool, incidentId)).find((e) => e.type === 'notified')?.payload as {
        attemptId: string;
      }
    ).attemptId;

    const result = await chase(incidentId);

    expect(result.ok && result.chased[0]?.path).toBe('template');
    const body = JSON.parse(sent[0] as string) as { type: string };
    expect(body.type).toBe('template');

    const tokens = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM ack_token WHERE attempt_id = $1 AND incident_id = $2',
      [attemptId, incidentId],
    );
    expect(Number(tokens.rows[0]?.n)).toBeGreaterThan(0);
  });

  it('records the chase even when Meta refuses it, and says so on the incident', async () => {
    /**
     * `keepEvidence`'s rule, applied to a message. INV-03 is about a failure being visible **where
     * somebody acts on it** — a control room that pressed the button and saw nothing has to be
     * told on the incident, because they can telephone and a log line cannot.
     */
    const { incidentId } = await toldButUnanswered();
    refuseNext = true;

    const result = await chase(incidentId);

    expect(result.ok).toBe(true);
    expect(result.ok && result.chased[0]?.delivered).toBe(false);

    const events = await loadIncident(pool, incidentId);
    const payload = events.find((e) => e.type === 'followed_up')?.payload as {
      delivered: boolean;
      note: string;
    };
    expect(payload.delivered).toBe(false);
    expect(payload.note).toContain('could not be sent');
  });

  it('refuses to chase an emergency nobody was ever told about, and says what to do instead', async () => {
    // Not an error to be swallowed: there is nothing to follow up **on**, and the answer is to
    // choose who should know rather than to chase. The words matter — an operator reads them.
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
        payload: { reportId: randomUUID(), category: 'fire', severity: 'high', kind: 'emergency' },
      } as unknown as IncidentEvent,
    ]);

    const result = await chase(incidentId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain('choose who should know');
    }
    expect(sent).toHaveLength(0);
  });

  /**
   * 🔴 **A gathering is reminded, not chased** — the owner, 2026-08-24, having read one on a real
   * handset: *"Meeting k follow up mai kuch button dene ki zarurt nhe hi just simple ho, a kind of
   * reminder ho, acknowledge etc karne ki zarurt nhe hai"*.
   *
   * ⚠️ **Attendance was already asked once**, on `district_notice_v2`, which carries the three
   * attendance quick replies. A chase is a reminder and not a second poll.
   */
  it('reminds a meeting, and offers nothing to press', async () => {
    const { incidentId } = await toldButUnanswered(officerPhone, {
      kind: 'meeting',
      category: 'flood',
      details: { subject: 'Flood coordination', date: '2026-08-25', time: '11:00' },
    });
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    await chase(incidentId);

    const body = JSON.parse(sent[0] as string) as {
      type: string;
      text?: { body?: string };
      interactive?: unknown;
    };

    expect(body.type).toBe('text');
    expect(body.interactive).toBeUndefined();

    const said = body.text?.body ?? '';
    expect(said).toContain('Reminder regarding the subject meeting');
    expect(said).toContain('Flood coordination');
    expect(said).toContain('no reply is required');
    /**
     * ⚠️ **A meeting about the flood is still a meeting.** `category` is `flood` above on
     * purpose: it must not reach past `kind` and turn this back into a chase.
     */
    expect(said).not.toContain('following up');
    expect(said).not.toContain('tap');
  });

  it('records a meeting reminder as fully as it records a chase', async () => {
    /**
     * 🔴 **No buttons is not no record.** The same distinction the acknowledgement thank-you was
     * given on 2026-08-23: what a message carries and what the log keeps are separate questions,
     * and INV-03 is about a failure being visible where somebody acts on it.
     */
    const { incidentId } = await toldButUnanswered(officerPhone, {
      kind: 'meeting',
      details: { subject: 'Revenue review', date: '2026-08-26' },
    });
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    await chase(incidentId, 'Meeting moved to Wednesday, 11:00.');

    const said = (JSON.parse(sent[0] as string) as { text?: { body?: string } }).text?.body ?? '';
    // The typed note replaces the ask and never the subject line — otherwise an officer holding
    // several of the district's notices cannot tell which meeting moved.
    expect(said).toContain('Revenue review');
    expect(said).toContain('Meeting moved to Wednesday, 11:00.');

    const events = await loadIncident(pool, incidentId);
    const followed = events.filter((e) => e.type === 'followed_up');
    expect(followed).toHaveLength(1);
    const payload = followed[0]?.payload as { note: string; delivered: boolean };
    expect(payload.note).toContain('Meeting moved to Wednesday, 11:00.');
    expect(payload.delivered).toBe(true);
  });

  it('keeps the buttons on an emergency, and asks where it stands', async () => {
    // The other half of the owner’s rule. Removing controls from a gathering must not quietly
    // remove them from the thing they were built for.
    const { incidentId } = await toldButUnanswered();
    await noteInbound(pool, toE164(officerPhone), new Date().toISOString());

    await chase(incidentId);

    const body = JSON.parse(sent[0] as string) as {
      interactive?: {
        action?: { buttons?: { reply: { title: string } }[] };
        body?: { text?: string };
      };
    };
    expect((body.interactive?.action?.buttons ?? []).length).toBeGreaterThan(0);
    expect(body.interactive?.body?.text ?? '').toContain('Kindly record where this stands');
  });
});
