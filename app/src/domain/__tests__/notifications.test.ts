/**
 * Who is owed a message, and what makes two obligations the same one — M6-03.
 *
 * The pure half. `api/__tests__/dispatch.test.ts` proves the loop works against a real database;
 * this proves the rules underneath it, including the two that read as bugs until the reasoning
 * is:
 *
 *   * **`targetKey` prefers the person over the seat**, so *"tell the DEO"* and *"tell Nawaz,
 *     who holds the DEO post"* stay two obligations. A post is held by whoever holds it
 *     tonight; merging them loses the one somebody actually chose at the next shift change.
 *   * **a routed department and a dispatched one are two obligations**, deliberately. One is the
 *     district's standing configuration and one is a named operator at 02:00, and when the
 *     second goes unmet somebody has to answer for it.
 */

import { describe, expect, it } from 'vitest';

import { foldIncident } from '../incident.js';
import { alreadyAttempted, obligationsFor, targetKey, unmetObligations } from '../notifications.js';
import { ev, INCIDENT, POLICE, RESCUE } from './fixtures.js';

const NAWAZ = 'person-nawaz';
const DEO_POST = 'seat-deo';

function state(events: Parameters<typeof foldIncident>[1]) {
  return foldIncident(INCIDENT, events);
}

describe('an escalation tells nobody — the district’s decision, 2026-08-21', () => {
  /**
   * 🔴 **THE ONE ASSERTION THAT STOPS THIS BEING PUT BACK BY A TIDY-UP.**
   *
   * `obligationsFor` used to push a target for `currentEscalationSeatId`, under a comment reading
   * ***"an escalation that nobody is told about is just a row in a table."*** The district
   * overturned the assumption: *"un ke high up office ko inform/shikayat nahi karni hai … software
   * khud se koi follow up na bheje — control room hi follow up bheje."*
   *
   * A ladder that messages an officer's superior when a timer expires is **exactly** that, with no
   * person in the loop. So the message stops and **nothing else does** — which is what the second
   * half of this test is for.
   */
  it('produces no obligation at all when an emergency escalates', () => {
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'critical' }),
      ev('escalated', { fromSeatId: null, toSeatId: 'seat-dc', trigger: 'sla_breach' }),
    ]);

    // Not "no escalated obligation" — NO obligation. Nobody was dispatched and nothing was
    // routed, so an escalation on its own must leave the ledger empty.
    expect(obligationsFor(s)).toHaveLength(0);
  });

  /**
   * ⚠️ **THE HALF THAT MUST NOT MOVE: THE ESCALATION STILL HAPPENED.**
   *
   * This is a decision about **who is messaged**, never about whether the district's record knows
   * a deadline went past. The event is still in the log and the fold still carries the seat it
   * reached — which is also what keeps the ladder idempotent (INV-08), since an incident only
   * escalates to a tier strictly above the one already reached.
   *
   * A "simplification" that stopped appending the event would pass the test above and silently
   * break both the record and the idempotency.
   */
  it('still records that it escalated, and to whom', () => {
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'critical' }),
      ev('escalated', { fromSeatId: null, toSeatId: 'seat-dc', trigger: 'sla_breach' }),
    ]);

    expect(s.currentEscalationSeatId).toBe('seat-dc');
    expect(s.escalationCount).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **And what the control room chose is untouched.** The district did not ask for fewer
   * messages — they asked for the **software** to stop choosing to send them. An officer the
   * control room dispatched to is still owed one, and still owed it after an escalation.
   */
  it('leaves an operator’s own dispatch owed, escalation or not', () => {
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'critical' }),
      ev('dispatched', { targets: [{ kind: 'person', id: NAWAZ }] }),
      ev('escalated', { fromSeatId: null, toSeatId: 'seat-dc', trigger: 'sla_breach' }),
    ]);

    const targets = obligationsFor(s);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.personId).toBe(NAWAZ);
    expect(targets[0]?.reason).toBe('dispatched');
  });
});

describe('obligations from a dispatch', () => {
  it('gives a named officer an obligation of their own', () => {
    // The gap M6-03 closes. Before this, `obligationsFor` derived per seat or per department
    // only — a named individual had no representation at all, so the district's own request
    // ("mutalqa department ya personal ya post") could only be half honoured.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', { targets: [{ kind: 'person', id: NAWAZ }] }),
    ]);

    const targets = obligationsFor(s).filter((t) => t.reason === 'dispatched');

    expect(targets).toHaveLength(1);
    expect(targets[0]?.personId).toBe(NAWAZ);
    expect(targets[0]?.seatId).toBeNull();
    expect(targets[0]?.departmentId).toBeNull();
  });

  it('maps each kind to the addressee it names', () => {
    // ADR-0031 (phase 2): a dispatch names a post or a person — `'department'` left
    // `RecipientKind`. The `routed` path below still resolves a department to its seats.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', {
        targets: [
          { kind: 'post', id: DEO_POST },
          { kind: 'person', id: NAWAZ },
        ],
      }),
    ]);

    const targets = obligationsFor(s).filter((t) => t.reason === 'dispatched');

    expect(targets.map((t) => t.seatId)).toContain(DEO_POST);
    expect(targets.map((t) => t.personId)).toContain(NAWAZ);
  });

  it('owes a routed department its own obligation, keyed by department', () => {
    /**
     * ADR-0031 (phase 2): `'department'` left `RecipientKind`, so the control room can no
     * longer *dispatch* to a department — this test used to assert a routed department and a
     * dispatched one produce two obligations for the pass to merge. The `routed` half stands:
     * a department that holds an emergency is still owed a message, resolved to its seats in
     * `jobs/notify.ts`, and this file is pure so it carries the `departmentId` only.
     */
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('routed', { departmentIds: [RESCUE], ruleId: 'auto' }),
    ]);

    const forRescue = obligationsFor(s).filter((t) => t.departmentId === RESCUE);

    expect(forRescue.map((t) => t.reason)).toEqual(['routed']);
  });

  it('accumulates across dispatches rather than replacing the last one', () => {
    // The control room dispatches more than once per incident, routinely — a second department
    // is remembered a minute later. Replacing would make the ledger answer "who was named most
    // recently" when the question is "who has been told".
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', { targets: [{ kind: 'post', id: DEO_POST }] }),
      ev('dispatched', { targets: [{ kind: 'person', id: NAWAZ }] }),
    ]);

    expect(s.dispatchedTo).toHaveLength(2);
    expect(obligationsFor(s).filter((t) => t.reason === 'dispatched')).toHaveLength(2);
  });

  it('records what was absorbed, and by what', () => {
    // ADR-0031 (phase 2): a post is absorbed by another post held by the same officer — the
    // two-designations-one-handset case (`collapseSelection`). A post absorbed by its own
    // department was the other case and is gone with `'department'` leaving `RecipientKind`.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', {
        targets: [{ kind: 'post', id: POLICE }],
        absorbed: [
          {
            target: { kind: 'post', id: DEO_POST },
            coveredBy: { kind: 'post', id: POLICE },
          },
        ],
      }),
    ]);

    // Kept rather than dropped: six months later "why was the DEO not told" has an answer.
    expect(s.dispatchAbsorbed).toHaveLength(1);
    expect(s.dispatchAbsorbed[0]?.coveredBy.id).toBe(POLICE);
    // And it produces no obligation, because the covering post already carries it.
    expect(obligationsFor(s).filter((t) => t.seatId === DEO_POST)).toHaveLength(0);
  });

  it('never retracts a target that an earlier dispatch already sent', () => {
    // Ticked and sent at 02:04; ticked again at 02:09 alongside another post held by the same
    // officer, which absorbs it. The message went. A ledger that then reported it as merely
    // covered would be claiming something did not happen that did.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', { targets: [{ kind: 'post', id: DEO_POST }] }),
      ev('dispatched', {
        targets: [{ kind: 'post', id: POLICE }],
        absorbed: [
          {
            target: { kind: 'post', id: DEO_POST },
            coveredBy: { kind: 'post', id: POLICE },
          },
        ],
      }),
    ]);

    expect(s.dispatchedTo.some((t) => t.id === DEO_POST)).toBe(true);
    expect(s.dispatchAbsorbed).toHaveLength(0);
  });
});

describe('what makes two obligations the same one', () => {
  it('tells a named officer apart from a post they hold', () => {
    // The whole reason `personId` is kept beside `seatId` on the attempt. A person-addressed
    // obligation is normally resolved to a seat before delivery, so both fields are set — and
    // keying on the seat would silently merge the two.
    const asPerson = targetKey({ seatId: DEO_POST, personId: NAWAZ });
    const asPost = targetKey({ seatId: DEO_POST, personId: null });

    expect(asPerson).not.toBe(asPost);
  });

  it('falls back to the department when there is no seat at all', () => {
    // Without this every pass records a fresh failure against a department with no post — the
    // notification storm INV-08 exists to prevent, aimed at the department least able to
    // answer it.
    expect(targetKey({ seatId: null, departmentId: RESCUE })).toBe(
      targetKey({ seatId: null, departmentId: RESCUE }),
    );
    expect(targetKey({ seatId: null, departmentId: RESCUE })).not.toBe(
      targetKey({ seatId: null, departmentId: POLICE }),
    );
  });

  it('does not re-attempt a person-addressed obligation on the next pass', () => {
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('dispatched', { targets: [{ kind: 'person', id: NAWAZ }] }),
      ev('notified', {
        attemptId: 'a1',
        seatId: null,
        personId: NAWAZ,
        channel: 'web',
        reason: 'dispatched',
      }),
    ]);

    expect(
      alreadyAttempted(s.notifications, { seatId: null, personId: NAWAZ }, 'dispatched', 'web'),
    ).toBe(true);
  });

  it('keeps the attempt’s addressee when an outcome settles it', () => {
    // A settling event carries enough to be found by its own id. If the fold preferred *its*
    // copy of the addressee, a delivery could silently retarget the obligation it settles —
    // `targetKey` would stop matching and the next pass would attempt the same thing again.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('notified', {
        attemptId: 'a1',
        seatId: null,
        personId: NAWAZ,
        channel: 'web',
        reason: 'dispatched',
      }),
      ev('notification_delivered', { attemptId: 'a1', seatId: null, channel: 'web' }),
    ]);

    expect(s.notifications[0]?.personId).toBe(NAWAZ);
    expect(s.notifications[0]?.state).toBe('delivered');
  });
});

describe('an unmet obligation is still unmet after somebody opened WhatsApp', () => {
  it('does not settle anything when a contact is opened', () => {
    // ADR-0014, and the line M6-10 was written not to cross. An opened app observed no ring, no
    // answer and no conversation. A board that can be quietened by tapping a link is worse than
    // no board.
    const s = state([
      ev('reported', { reportId: 'r1', category: 'fire', severity: 'high' }),
      ev('notified', {
        attemptId: 'a1',
        seatId: DEO_POST,
        channel: 'web',
        reason: 'dispatched',
      }),
      ev('contact_opened', { channel: 'whatsapp', seatId: DEO_POST, label: 'DEO' }),
    ]);

    expect(s.contactsOpened).toHaveLength(1);
    expect(s.notifications[0]?.state).toBe('pending');
    expect(unmetObligations(s.notifications, '2026-08-01T12:00:00.000Z')).toHaveLength(1);
  });
});
