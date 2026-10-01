/**
 * **An escalation by a person's hand — Phase 8c, 2026-08-21.**
 *
 * ## Test 1 is the reason this file exists, and it is a defect the obvious implementation has
 *
 * `jobs/escalation.ts` decides which rung to climb from with
 * `currentEscalationSeatId ?? lastActingSeat(events)`, and copying that into the manual path is
 * the natural thing to do — it is the ladder, already written, already tested.
 *
 * **It would refuse every escalation on this district's ordinary journey.** The control room
 * receives the emergency and dispatches it, so *the last acting seat is the control room's own*,
 * which is district tier; the ladder has two rungs (ADR-0010); and `nextSeatUp` from `district`
 * returns null. The operator would press *Escalate* on exactly the case it was built for and be
 * told **"there is nobody above it"** — a correct sentence about the wrong seat.
 *
 * So the manual path starts from the **department that holds the emergency**, and test 1 walks
 * the real journey to prove it: reported, dispatched by the control room, escalated by that same
 * control room, landing on the district.
 *
 * ## Test 2 is the district's own instruction, asserted rather than assumed
 *
 * Option (b): *"escalate kar diya jaye"* — and **nobody is messaged**. Phase 8a deleted the four
 * lines that produced an obligation for the escalated seat, and this asserts that an escalation
 * appended here still produces none. It is the guard on a deletion, which is the kind of thing
 * that gets undone by somebody restoring "missing" behaviour in good faith.
 *
 * Real PostgreSQL, real migrations, the real fold, the real authority table. Nothing is stubbed
 * here at all — this path never touches Meta, which is itself the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { append, loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';
import { obligationsFor } from '../../domain/notifications.js';
import type { IncidentEvent } from '../../domain/events.js';
import { resolveIdentity } from '../../auth/sessions.js';
import type { Identity } from '../../auth/sessions.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import { escalateByHand } from '../escalate.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('escalating by hand (integration)', () => {
  let pool: Pool;

  /** The control room: district tier, and the seat that presses the button. */
  let room: Identity;
  let roomSeatId: string;

  /** Rescue: where the emergency actually sits, and the rung the climb starts from. */
  let rescueDept: string;
  let rescueSeatId: string;

  /**
   * One emergency, walked the way the district walks it.
   *
   * ⚠️ **The control room's seat is the last to act**, because that is what happens in the real
   * building — and it is precisely what makes test 1 worth writing.
   */
  async function reportedAndDispatched(): Promise<string> {
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
        actorSeatId: roomSeatId,
        sourceChannel: 'mobile',
        payload: {
          reportId: randomUUID(),
          category: 'fire',
          severity: 'high',
          kind: 'emergency',
          description: 'escalate test',
        },
      } as unknown as IncidentEvent,
      {
        eventId: randomUUID(),
        incidentId,
        type: 'routed',
        occurredAt: new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        clientSeq: 2,
        actorPersonId: room.personId,
        actorSeatId: roomSeatId,
        sourceChannel: 'web',
        payload: { departmentIds: [rescueDept], ruleId: 'manual' },
      } as unknown as IncidentEvent,
    ]);

    return incidentId;
  }

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    const controlRoom = await seedActor(pool, {
      title: `Control Room (esc ${randomUUID().slice(0, 6)})`,
      tier: 'district',
    });
    roomSeatId = controlRoom.seatId;

    const resolved = await resolveIdentity(pool, controlRoom.personId);
    if (resolved === null) throw new Error('could not resolve the seeded identity');
    room = resolved;

    rescueDept = await seedDepartment(pool, `Rescue (esc ${randomUUID().slice(0, 6)})`);
    const officer = await seedActor(pool, {
      title: `Duty Officer (esc ${randomUUID().slice(0, 6)})`,
      departmentId: rescueDept,
    });
    rescueSeatId = officer.seatId;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('climbs from the department that holds it, not from whoever last touched the screen', async () => {
    /**
     * 🔴 **The defect this file exists for.** Starting at `lastActingSeat` — which the job does —
     * would begin the climb at the control room's own district-tier seat and refuse with *"there
     * is nobody above it"*, on the ordinary journey, every single time.
     */
    const incidentId = await reportedAndDispatched();

    const result = await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'Two hours, no answer from Rescue',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // It landed somewhere real, and it is NOT the department it came from.
    expect(result.escalated.toSeatId).not.toBe(rescueSeatId);

    const tier = await pool.query<{ tier: string }>('SELECT tier FROM seat WHERE seat_id = $1', [
      result.escalated.toSeatId,
    ]);
    expect(tier.rows[0]?.tier).toBe('district');

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.currentEscalationSeatId).toBe(result.escalated.toSeatId);
    expect(state.escalationCount).toBe(1);
  });

  it('produces no obligation to message anybody — the district’s own instruction', async () => {
    /**
     * ⚠️ Option (b), asserted. Phase 8a deleted the four lines in `domain/notifications.ts` that
     * owed the escalated seat a message; this is the guard on that deletion, because "the seat we
     * escalated to was never told" reads like a bug to somebody who did not hear the district say
     * it was the requirement.
     */
    const incidentId = await reportedAndDispatched();

    const before = obligationsFor(foldIncident(incidentId, await loadIncident(pool, incidentId)));

    const result = await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'Nobody has answered',
    });
    expect(result.ok).toBe(true);

    const after = obligationsFor(foldIncident(incidentId, await loadIncident(pool, incidentId)));

    expect(after).toHaveLength(before.length);
    if (result.ok) {
      expect(after.some((t) => t.seatId === result.escalated.toSeatId)).toBe(false);
    }
  });

  it('records why, and who decided it — never “the system”', async () => {
    // The mark IS the act now, so the reason is the record. And the actor separates a person's
    // decision from the ladder's: the job appends this event with no actor at all, and the detail
    // screen reads a null actor as "the system".
    const incidentId = await reportedAndDispatched();

    await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'DC asked for this to be raised tonight',
    });

    const escalations = (await loadIncident(pool, incidentId)).filter(
      (e) => e.type === 'escalated',
    );
    expect(escalations).toHaveLength(1);

    const event = escalations[0];
    expect(event?.actorSeatId).toBe(roomSeatId);
    expect(event?.actorPersonId).toBe(room.personId);
    expect(event?.sourceChannel).toBe('web');

    const payload = event?.payload as { trigger: string; reason: string };
    expect(payload.trigger).toBe('manual');
    expect(payload.reason).toBe('DC asked for this to be raised tonight');
  });

  it('refuses with no reason, because a mark nobody can read is not a record', async () => {
    const incidentId = await reportedAndDispatched();

    const result = await escalateByHand({ pool, identity: room, incidentId, reason: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('say why');
    }
    expect((await loadIncident(pool, incidentId)).some((e) => e.type === 'escalated')).toBe(false);
  });

  it('says there is nobody above, rather than escalating a second time into the same seat', async () => {
    // Two rungs (ADR-0010), so once it is at the district there is nowhere to climb. The refusal
    // names the act that IS available, because "refused" on its own sends an operator to ring a
    // developer instead of ringing the officer.
    const incidentId = await reportedAndDispatched();

    const first = await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'No answer',
    });
    expect(first.ok).toBe(true);

    const second = await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'Still no answer',
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.error).toContain('top of the district ladder');
      expect(second.error).toContain('Follow up');
    }

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.escalationCount).toBe(1);
  });

  it('refuses an emergency nobody holds, and says to choose who should know', async () => {
    // Nothing to escalate FROM. The honest next act is to give it to somebody, which is a
    // different button on the same screen.
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
        actorSeatId: roomSeatId,
        sourceChannel: 'mobile',
        payload: { reportId: randomUUID(), category: 'fire', severity: 'high', kind: 'emergency' },
      } as unknown as IncidentEvent,
    ]);

    const result = await escalateByHand({
      pool,
      identity: room,
      incidentId,
      reason: 'Nobody has answered',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain('choose who should know');
    }
  });
});
