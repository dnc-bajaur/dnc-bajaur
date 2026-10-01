/**
 * Notifications — M0-32, and INV-03 made true of a running system.
 *
 * The invariant is one sentence: *a message that did not reach the duty officer surfaces on
 * the central board as an unmet obligation, not as a log line.* Every test here is about
 * some way that could quietly stop being true:
 *
 *   - an attempt that fails leaves no trace
 *   - "we queued it" gets recorded as "somebody knows"
 *   - a vacant post swallows the obligation, exactly as it once nearly did for escalation
 *   - a crash between attempting and recording loses the attempt
 *   - someone else can clear an unmet obligation off the board
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../../api/server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { unmetObligations, UNDELIVERED_AFTER_MINUTES } from '../../domain/notifications.js';
import { buildBoard } from '../../api/board.js';
import { seatOf } from '../../api/lifecycle.js';
import { hashPassword } from '../../auth/passwords.js';
import { login, resolveIdentity } from '../../auth/sessions.js';
import { seedDepartment } from '../../testing/seed.js';
import { runNotifyPass, type NotificationChannel } from '../notify.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const PASSWORD = 'duty-officer-2026';

describe.skipIf(dbUrl === undefined)('notifications (INV-03)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let rescueDept: string;
  let policeDept: string;
  /** A department with a seat that nobody currently holds. */
  let vacantSeatId: string;

  let rescuePersonId: string;
  let rescueSeatId: string;
  let controlRoomToken: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    rescueDept = await seedDepartment(pool, 'Rescue 1122 (test)');
    policeDept = await seedDepartment(pool, 'Police (test)');

    const rescue = await actor('Rescue Duty Officer', 'station');
    rescuePersonId = rescue.personId;
    rescueSeatId = rescue.seatId;

    await actor('Police Duty Officer', 'station');
    controlRoomToken = (await actor('Control Room', 'district')).token;

    // A post with nobody in it. The case that must never swallow an obligation.
    vacantSeatId = await makeSeat('Vacant Station In-Charge', 'station');
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function makeSeat(title: string, tier: string): Promise<string> {
    const res = await pool.query<{ seat_id: string }>(
      // ADR-0030 — the trigger derives `tier` from `is_administration` alone (migration 0039), so
      // the value passed for it is overwritten. Asking for `district` and writing nothing else
      // gets a `department` seat, and every assertion below then fails a long way from the cause.
      `INSERT INTO seat (title, tier, can_break_glass, is_administration)
       VALUES ($1, $2, false, $3) RETURNING seat_id`,
      [title, tier, tier === 'district'],
    );
    return res.rows[0]!.seat_id;
  }

  async function actor(
    name: string,
    tier: string,
  ): Promise<{ token: string; personId: string; seatId: string }> {
    const seatId = await makeSeat(name, tier);
    const phone = `+92300${randomUUID().slice(0, 10)}`;
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, password_hash)
       VALUES ($1, $2, $3) RETURNING person_id`,
      [name, phone, await hashPassword(PASSWORD)],
    );
    const personId = person.rows[0]!.person_id;
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      personId,
    ]);
    const result = await login(pool, phone, PASSWORD);
    if (result === null) throw new Error(`login failed for ${name}`);
    return { token: result.token, personId, seatId };
  }

  async function post(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * An emergency the control room has told one post about.
   *
   * ⚠️ **IT USED TO BE ROUTED TO A DEPARTMENT, AND THAT PATH CAN NO LONGER REACH ANYBODY.**
   * A department obligation resolves through `dutySeatFor`, which since ADR-0030 returns null
   * and queries nothing — so every one of these tests would have been exercising a path that
   * fails before the channel is reached, and most of them would have gone on passing, because
   * what they assert is that a failure is recorded rather than swallowed. Passing for the wrong
   * reason is the shape this file's own header warns about.
   *
   * A post is what the control room can choose now, and it is what these obligations are made
   * of, so the pass under test is the one Bajaur actually runs.
   */
  async function toldAbout(seatId: string): Promise<string> {
    const created = await post('/incidents', controlRoomToken, {
      category: 'rta',
      severity: 'high',
    });
    const id = created['incidentId'] as string;

    /**
     * ⚠️ **APPENDED, NOT POSTED TO `dispatch-to`, AND THAT IS THE WHOLE POINT OF THIS FILE.**
     *
     * That route calls `notifyNow`, so the obligation is created AND settled inside the request
     * — with the server's own channel, which in a test has no WhatsApp account. Every attempt
     * would already read `no_channel` before `runNotifyPass` ran, and the injected channels
     * below would settle nothing: the tests about a gateway timeout, a throw, and a pending
     * hand-off would all pass while exercising none of it. `/route` did not notify, which is
     * why this was invisible for as long as the fixture routed.
     */
    const now = new Date().toISOString();
    await append(pool, [
      {
        eventId: randomUUID(),
        incidentId: id,
        type: 'dispatched',
        occurredAt: now,
        recordedAt: now,
        actorPersonId: null,
        actorSeatId: null,
        sourceChannel: 'web',
        clientSeq: 50,
        payload: { targets: [{ kind: 'post', id: seatId }] },
      },
    ]);
    return id;
  }

  const attempts = async (incidentId: string) =>
    foldIncident(incidentId, await loadIncident(pool, incidentId)).notifications;

  /**
   * A provider that accepted the message and has said nothing since.
   *
   * The honest shape of WhatsApp: Meta returns 200, the attempt stays open, and it settles only
   * when a status webhook arrives or — better — the officer taps the acknowledge link. Used by
   * the tests below that are about `pending`, which is now a WhatsApp-only state.
   */
  const handedOff: NotificationChannel = {
    name: 'whatsapp',
    deliver: () =>
      Promise.resolve({ ok: false, failure: 'sent: waiting for delivery', pending: true }),
  };

  /**
   * A channel that hands the message off **and says what it said** — ADR-0026.
   *
   * Identical to `handedOff` but for `sent`, so the two tests below differ in exactly the thing
   * under test: whether the words reach the log, and whether recording them changes anything
   * about the obligation.
   */
  const handedOffSaying: NotificationChannel = {
    name: 'whatsapp',
    deliver: () =>
      Promise.resolve({
        ok: false as const,
        failure: 'sent: waiting for delivery',
        pending: true,
        sent: { what: 'Road accident — high', where: 'Bypass road, near the grain market' },
      }),
  };

  describe('what we sent goes onto the record (ADR-0026)', () => {
    it('appends the words the officer read, bound to the attempt', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOffSaying });

      const attempt = (await attempts(id)).find((a) => a.channel === 'whatsapp');
      expect(attempt?.sent?.what).toBe('Road accident — high');
      expect(attempt?.sent?.where).toBe('Bypass road, near the grain market');
    });

    /**
     * ⚠️ **The one that matters.** Recording what we said must not look like delivery.
     *
     * `message_sent` carries words, not an outcome. If folding it ever settled the attempt, the
     * control room would read *an officer knows about this* off the fact that a message was
     * composed — which is the same lie ADR-0014 and the `pending` branch exist to refuse, arriving
     * through a new door.
     */
    it('settles nothing — the attempt is still pending afterwards', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOffSaying });

      const attempt = (await attempts(id)).find((a) => a.channel === 'whatsapp');
      expect(attempt?.state).toBe('pending');
    });

    /**
     * Every message before 2026-08-23, and every channel that hands off without saying what it
     * said. Absence is **unknown**, and the fold must leave it absent rather than inventing an
     * empty message — a screen reading `''` would draw a blank line under the words *we sent*.
     */
    it('records nothing when the channel does not say what it sent', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOff });

      const attempt = (await attempts(id)).find((a) => a.channel === 'whatsapp');
      expect(attempt?.sent).toBeUndefined();
      expect(attempt?.state).toBe('pending');
    });
  });

  describe('an attempt is recorded before it is made', () => {
    it('notifies the post an incident was told to', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id] });

      const list = await attempts(id);
      expect(list).toHaveLength(1);
      /**
       * `failed`, not `pending` — and that is the M7-03 rule, not a regression.
       *
       * With the in-app channel gone (ADR-0018) and no WhatsApp account configured, there is
       * nothing that can carry a message by itself. The obligation is still recorded — somebody
       * was owed one — and settled **immediately**, naming why, so an operator can act.
       *
       * Leaving it `pending` is precisely what the deleted channel did, and precisely why it was
       * deleted: an attempt nobody can settle ages into a permanent unmet obligation. **Pending
       * must mean "we are waiting on an answer", never "we never had a way to ask."**
       */
      // `dispatched`, not `routed`: choosing who to tell is the only thing that creates an
      // obligation now, and it is the more specific fact either way (`oneMessagePerRecipient`).
      expect(list[0]).toMatchObject({
        seatId: rescueSeatId,
        reason: 'dispatched',
        state: 'failed',
      });
      expect(list[0]!.failure).toContain('no_channel');
    });

    it('does not notify the same seat twice for the same obligation', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id] });
      await runNotifyPass(pool, { incidentIds: [id] });
      await runNotifyPass(pool, { incidentIds: [id] });

      // Idempotency comes from comparing obligations against the log, not from a marker.
      // Three passes are one notification, which is what stops a scan loop becoming a
      // notification storm (INV-08).
      expect(await attempts(id)).toHaveLength(1);
    });

    it('leaves the attempt pending — queued is not delivered', async () => {
      /**
       * The lie this prevents: telling the control room an officer knows about an emergency
       * when all that happened is a row was written.
       *
       * It used to be proved through the in-app channel. That channel is gone (ADR-0018), so it
       * is proved through the one that remains — and the property is **more** important there,
       * because WhatsApp accepting a message really does look like success. An HTTP 200 from a
       * datacentre is not an officer knowing about an emergency.
       */
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOff });

      const attempt = (await attempts(id)).find((a) => a.channel === 'whatsapp');
      expect(attempt?.state).toBe('pending');
    });
  });

  describe('a failure is never invisible', () => {
    it('records a failure when the post is vacant, rather than skipping it', async () => {
      // A vacant post must not swallow an obligation — the same rule ADR-0004 forces on
      // escalation, and the same reasoning: nobody is coming, so somebody has to be told
      // that nobody is coming.
      const id = await toldAbout(vacantSeatId);
      await runNotifyPass(pool, { incidentIds: [id] });

      const list = await attempts(id);
      expect(list).toHaveLength(1);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.seatId).toBe(vacantSeatId);
      expect(list[0]!.failure).toContain('no_duty_holder');
    });

    it('records a failure when the channel itself fails', async () => {
      const id = await toldAbout(rescueSeatId);
      const broken: NotificationChannel = {
        name: 'whatsapp',
        deliver: () => Promise.resolve({ ok: false, failure: 'gateway timeout after 30s' }),
      };
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: broken });

      const list = await attempts(id);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.failure).toContain('gateway timeout');
    });

    it('records a failure when the channel throws rather than returning', async () => {
      // A channel that throws must not take the pass down with it, and must not leave the
      // attempt looking like it might have worked.
      const id = await toldAbout(rescueSeatId);
      const exploding: NotificationChannel = {
        name: 'whatsapp',
        deliver: () => Promise.reject(new Error('DNS lookup failed')),
      };
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: exploding });

      const list = await attempts(id);
      expect(list[0]!.state).toBe('failed');
      expect(list[0]!.failure).toContain('DNS lookup failed');
    });

    /**
     * A stand-in number is not a contact.
     *
     * Migration 0008 fills Rescue 1122's post with a placeholder so the roster is complete
     * and editable before the real number arrives — the owner's instruction was to stop
     * waiting on it. The hazard that comes with it is precise: a fake number silences the
     * vacant-post warning while changing nothing about whether a human is actually told.
     * That is strictly worse than the empty post, because the screen stops asking.
     */
    it('treats a placeholder contact as unreachable, not as a holder', async () => {
      const seat = await pool.query<{ seat_id: string }>(
        `INSERT INTO seat (title, tier, can_break_glass)
         VALUES ('Post With A Stand-In', 'station', false) RETURNING seat_id`,
        [],
      );
      const person = await pool.query<{ person_id: string }>(
        `INSERT INTO person (full_name, phone, placeholder)
         VALUES ('Awaiting A Real Number', $1, true) RETURNING person_id`,
        [`1111111-${randomUUID().slice(0, 8)}`],
      );
      await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
        seat.rows[0]!.seat_id,
        person.rows[0]!.person_id,
      ]);

      const id = await toldAbout(seat.rows[0]!.seat_id);
      const outcome = await runNotifyPass(pool, { incidentIds: [id] });

      expect(outcome.failed).toBe(1);

      const state = foldIncident(id, await loadIncident(pool, id));
      const attempt = state.notifications[0];
      expect(attempt?.state).toBe('failed');
      // Named for what it is. "Nobody holds this seat" would send an administrator looking
      // for a roster gap that does not exist; the post is filled, the number is not real.
      expect(attempt?.failure).toContain('placeholder_contact');
    });

    it('surfaces a failed attempt on the central board, not in a log line', async () => {
      // The literal words of INV-03. If this test is deleted the invariant is gone, whatever
      // the notification code still does.
      const id = await toldAbout(vacantSeatId);
      await runNotifyPass(pool, { incidentIds: [id] });

      const identity = await resolveIdentity(pool, rescuePersonId);
      const control = seatOf({
        personId: 'x',
        fullName: 'Control',
        seatId: randomUUID(),
        seatTitle: 'District Control Room',
        departmentId: null,
        departmentName: null,
        tier: 'district',
        canBreakGlass: false,
        role: 'operator',
        mustChangePassword: false,
        isAdministration: false,
      })!;

      const board = await buildBoard(pool, control);
      const row = board.incidents.find((r) => r.incidentId === id);

      expect(row?.notificationsFailed).toBe(1);
      expect(board.summary.notificationsUnmet).toBeGreaterThan(0);
      expect(identity).not.toBeNull();
    });

    it('counts a pending attempt as unmet once it has waited too long', async () => {
      // Sent and never picked up is a different problem from could-not-send, and the board
      // reports them separately: one needs a roster fixed, the other needs a phone answered.
      // Through WhatsApp, because that is the only channel that can leave an attempt open now.
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOff });

      const list = (await attempts(id)).filter((a) => a.channel === 'whatsapp');
      const later = new Date(
        Date.parse(list[0]!.attemptedAt) + (UNDELIVERED_AFTER_MINUTES + 1) * 60_000,
      ).toISOString();

      const unmet = unmetObligations(list, later);
      expect(unmet).toHaveLength(1);
      expect(unmet[0]!.why).toBe('undelivered');
    });

    it('does not count a fresh pending attempt as unmet', async () => {
      const id = await toldAbout(rescueSeatId);
      await runNotifyPass(pool, { incidentIds: [id], whatsapp: handedOff });
      const list = (await attempts(id)).filter((a) => a.channel === 'whatsapp');
      expect(unmetObligations(list, list[0]!.attemptedAt)).toHaveLength(0);
    });
  });

  // The inbox describe was here. Removed with the inbox itself — ADR-0018, M7-02.
  describe('a handover has two sides', () => {
    /**
     * ⚠️ **NOTHING IN THE PRODUCT CAN REACH THIS SINCE ADR-0030, AND IT IS KEPT ANYWAY.**
     *
     * A handover moves an emergency from one department to another, and there are no
     * departments — no screen offers one, and both ids below name rows that no longer exist.
     * What is under test is not the screen: it is that `obligationsFor` still produces BOTH
     * sides of a handover from the events, because Bajaur's own append-only record contains
     * handovers and always will. A fold that quietly stopped producing `lost_responsibility`
     * would change what a past incident says happened, which is the one thing ADR-0001 exists
     * to prevent — and it would do it silently, since no live traffic would notice.
     */
    it('tells the department losing an incident, not just the one gaining it', async () => {
      // A handover nobody announced is how two departments each assume the other went.
      const id = await toldAbout(rescueSeatId);
      await post(`/incidents/${id}/route`, controlRoomToken, {
        departmentIds: [rescueDept],
        reason: 'the historical shape of the record',
      });
      await runNotifyPass(pool, { incidentIds: [id] });
      await post(`/incidents/${id}/reassign`, controlRoomToken, {
        departmentIds: [policeDept],
        reason: 'law and order, not medical',
      });
      await runNotifyPass(pool, { incidentIds: [id] });

      const reasons = (await attempts(id)).map((a) => a.reason);
      expect(reasons).toContain('reassigned');
      expect(reasons).toContain('lost_responsibility');
    });
  });
});
