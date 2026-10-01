/**
 * "Who could I tell?" — M6, over HTTP, against a real PostgreSQL.
 *
 * `domain/__tests__/recipients.test.ts` covers the rules. This file covers the thing those
 * rules are useless without: that the query actually returns the district, that a vacant post
 * survives the trip, and that a retired post does not.
 *
 * The two assertions to read first are the ones that look like bugs:
 *
 *   * **an unreachable post is returned**, because hiding it is how a vacancy stays invisible
 *     to the one person who was about to notice it (ADR-0004)
 *   * **a retired post is not**, which is a different thing entirely — not a gap in the
 *     district's cover, but a row that should no longer exist
 *
 * ⚠️ **Both of those sentences said *department* until ADR-0030.** The rule they describe is the
 * one that survived the layer being dropped: it was always about a row the district has closed,
 * and the row the district closes now is the post.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment } from '../../testing/seed.js';
import type { Recipient } from '../../domain/recipients.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface RecipientReply {
  recipients: Recipient[];
  sharedNumbers: { phone: string; labels: string[] }[];
}

describe.skipIf(dbUrl === undefined)('who the control room can tell (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let controlToken: string;
  let rescueDept: string;
  let vacantSeat: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (recip ${RUN})`);
    controlToken = (
      await seedActor(pool, {
        title: `Control Room (recip ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    // ADR-0030 — the office line went with the table. It was seeded here so that a department
    // row WITH a number could be shown not to be offered; there is no such row to seed now.
    rescueDept = await seedDepartment(pool, `Rescue (recip ${RUN})`);

    // A held post, with a real officer on a real number.
    await seedActor(pool, { title: `Duty Officer (recip ${RUN})`, departmentId: rescueDept });

    // A post nobody holds. The row that must survive the trip.
    vacantSeat = randomUUID();
    await pool.query(`INSERT INTO seat (seat_id, title) VALUES ($1, $2)`, [
      vacantSeat,
      `Night Duty (recip ${RUN})`,
    ]);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function recipients(token: string | null): Promise<{
    status: number;
    body: RecipientReply;
  }> {
    const res = await fetch(`${base}/contacts/recipients`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? ({} as RecipientReply) : JSON.parse(raw) };
  }

  const mine = (body: RecipientReply, kind: Recipient['kind']): Recipient[] =>
    body.recipients.filter((r) => r.kind === kind && r.label.includes(RUN));

  it('refuses a caller with no session', async () => {
    // These are officers' personal mobiles. INV-05: the refusal is here, not in the UI.
    expect((await recipients(null)).status).toBe(401);
  });

  /**
   * 🔴 **ONE CONTACT PER DESIGNATION, AND NOTHING ELSE — 2026-08-22.**
   *
   * This asserted the opposite until today: *departments, posts and named people in one call*.
   * Counted against Bajaur's own directory that was `79 + 81 + 40 = 200 selectable rows for 40
   * real handsets` — five rows for every human being, and one officer appearing three times.
   *
   * The district reported it as *"names bhi aa jate hain aur department bhi aa jate hain … bahut
   * confusion ho jati hai"*, and they were describing the model rather than the markup.
   */
  it('returns one contact per designation, and no standalone person row', async () => {
    const { status, body } = await recipients(controlToken);

    expect(status).toBe(200);
    expect(mine(body, 'post').length).toBeGreaterThan(0);

    // `'department'` left `RecipientKind` entirely (ADR-0031, phase 2), so it cannot appear
    // here by construction. A standalone `person` row is the other kind that made one officer
    // into three; the picker draws the holder on the post row instead.
    expect(body.recipients.filter((r) => r.kind === 'person')).toHaveLength(0);
  });

  it('offers a vacant post, marked, rather than hiding it', async () => {
    const { body } = await recipients(controlToken);

    const vacant = body.recipients.find((r) => r.kind === 'post' && r.id === vacantSeat);

    expect(vacant).toBeDefined();
    expect(vacant?.unreachable).toBe('vacant');
    expect(vacant?.holderName).toBeNull();
  });

  /**
   * ⚠️ **TWO TESTS STOOD HERE UNTIL ADR-0030 AND NEITHER HAS A SUBJECT LEFT.**
   *
   * One seeded a live department **with an office line** and required it not to be offered; the
   * other retired a department and required the same. Together they held a distinction worth
   * holding — *absent* rather than *filtered out for being unreachable* — because a department
   * vanishing from the picker could otherwise have been a reachability rule quietly widening and
   * taking live offices off the screen for the wrong reason.
   *
   * Migration 0039 dropped the table, so there is no longer a department to seed either way, and
   * the surviving half of that claim is asserted at the top of this file: **no `department` row
   * is returned at all.** What is written here instead is the rule that outlived the layer — a
   * row the district has CLOSED does not reach the picker — one level down, where the district
   * now closes things. `WHERE s.retired_at IS NULL` in `buildRecipients` is the line under test.
   */
  it('drops a retired post, which is not the same as an unreachable one', async () => {
    const doomed = randomUUID();
    await pool.query(`INSERT INTO seat (seat_id, title, retired_at) VALUES ($1, $2, now())`, [
      doomed,
      `Abolished Post (recip ${RUN})`,
    ]);

    const { body } = await recipients(controlToken);

    expect(body.recipients.some((r) => r.id === doomed)).toBe(false);
    // And the vacant post above is still there, which is what makes this a different rule and
    // not reachability widening: both are unheld, only one has been closed.
    expect(body.recipients.some((r) => r.id === vacantSeat)).toBe(true);
  });

  it('never offers a stand-in number as somebody to tell', async () => {
    // Migration 0008 fills a post so the roster is complete. Dialling it reaches nobody, and
    // discovering that at 02:00 is the failure this whole system exists to prevent.
    const seatId = randomUUID();
    const personId = randomUUID();
    await pool.query(`INSERT INTO seat (seat_id, title) VALUES ($1, $2)`, [
      seatId,
      `Standin Post (recip ${RUN})`,
    ]);
    await pool.query(
      `INSERT INTO person (person_id, full_name, phone, placeholder) VALUES ($1, $2, $3, true)`,
      [personId, `Stand-in (recip ${RUN})`, `0300${RUN.slice(0, 6)}`],
    );
    await pool.query(
      `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())`,
      [seatId, personId],
    );

    const { body } = await recipients(controlToken);

    const post = body.recipients.find((r) => r.kind === 'post' && r.id === seatId);
    expect(post?.unreachable).toBe('placeholder');

    // And never as a person in their own right.
    expect(body.recipients.some((r) => r.kind === 'person' && r.id === personId)).toBe(false);
  });

  it('lists a person once even when they hold two posts in one department', async () => {
    // `resolveIdentity`'s missing ORDER BY is a standing reminder that this shape is
    // producible. Two identical rows is a checkbox that appears twice.
    //
    // ⚠️ **One department is now load-bearing in this test's own setup.** Both seats below are
    // `rescueDept`, and the test after this one is the other half: across *two* departments the
    // answer is deliberately two rows (M10-06). Move either seat and the pair stops meaning
    // anything.
    const actor = await seedActor(pool, {
      title: `Doubled (recip ${RUN})`,
      departmentId: rescueDept,
    });
    const secondSeat = randomUUID();
    await pool.query(`INSERT INTO seat (seat_id, title) VALUES ($1, $2)`, [
      secondSeat,
      `Doubled Second (recip ${RUN})`,
    ]);
    await pool.query(
      `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())`,
      [secondSeat, actor.personId],
    );

    const { body } = await recipients(controlToken);

    /**
     * **Two designations are two contacts, and that is the district's own model.**
     *
     * This asserted **one** row while the person row existed to carry the officer once. There is
     * no person row now: the contact **is** the designation, and somebody holding two holds two.
     * That is what a phone's contact list does, and it is what the district asked for — an
     * operator told to reach *Doubled Second* must find it under that name.
     *
     * ⚠️ **What must not follow is two messages.** `collapseSelection` absorbs the second
     * designation into the first when both are ticked, so one officer is one message for one
     * emergency — see `domain/__tests__/recipients.test.ts`, which holds that half.
     */
    const rows = body.recipients.filter(
      (r) => r.holderPersonId === actor.personId && r.label.includes(RUN),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'post')).toBe(true);
    expect(rows.map((r) => r.label).sort()).toEqual(
      [`Doubled (recip ${RUN})`, `Doubled Second (recip ${RUN})`].sort(),
    );
  });

  /**
   * **An officer serving two departments appears under both — M10-06, and this is O-27.**
   *
   * `backlog/m10-plan.md` said *"Nobody in Bajaur holds two posts today"*. The M10-05 audit
   * queried the live directory on 2026-08-16 and **three people do**, two of them across
   * different departments: Imran (C&W Buildings · C&W Highways) and Zubair Ahmad (ADC General ·
   * ADC Relief).
   *
   * Collapsing on `person_id` alone gave one row carrying **whichever department the database
   * returned first** — so a control room told to reach Highways would search the Highways
   * heading and not find him, while the record showed him present in the directory. The owner
   * chose one row per department on 2026-08-16.
   *
   * **The `id` is still the person**, which is the half that keeps this safe: ticking either row
   * is the same tick, and `collapseSelection` sends one message to one handset exactly as before.
   */
  it('lists a person under each department they serve, with that department’s designation', async () => {
    const first = await seedActor(pool, {
      title: `Buildings Officer (recip ${RUN})`,
      departmentId: rescueDept,
    });
    const otherSeat = randomUUID();
    await pool.query(`INSERT INTO seat (seat_id, title) VALUES ($1, $2)`, [
      otherSeat,
      `Highways Officer (recip ${RUN})`,
    ]);
    await pool.query(
      `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())`,
      [otherSeat, first.personId],
    );

    const { body } = await recipients(controlToken);

    const rows = body.recipients.filter(
      (r) => r.holderPersonId === first.personId && r.label.includes(RUN),
    );
    expect(rows).toHaveLength(2);

    /**
     * **Each contact is its own designation, and the officer's name is on both.**
     *
     * O-27's finding survives the flattening intact and is the reason this test stays: Imran is
     * *C&W Buildings* **and** *C&W Highways*, and a control room told to reach Highways must find
     * him there. What changed is only which row carries it — the designation is now the contact's
     * own label rather than a field on a person row.
     */
    expect(rows.map((r) => r.label).sort()).toEqual(
      [`Buildings Officer (recip ${RUN})`, `Highways Officer (recip ${RUN})`].sort(),
    );
    // One officer's name on both contacts — `seedActor` does not hand back the name, so this
    // asserts the shape that matters: both rows are held, and by the same person.
    expect(rows.every((r) => r.holderName !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.holderName)).size).toBe(1);

    // Two contacts, one officer — which is what `collapseSelection` reads to send one message.
    expect(new Set(rows.map((r) => r.holderPersonId)).size).toBe(1);
  });

  it('carries the designation as the label and never repeats it in `designation`', async () => {
    // A contact's designation IS its label. Sending it twice is one fact in two fields, and the
    // next screen to render both would print it twice.
    const { body } = await recipients(controlToken);

    const contact = body.recipients.find((r) => r.id === vacantSeat);

    expect(contact?.label).toContain('recip');
    expect(contact?.designation).toBeNull();
  });

  it('reports two officers sharing one number rather than collapsing them', async () => {
    const shared = `0333${RUN.slice(0, 6)}`;
    for (const which of ['A', 'B']) {
      const seatId = randomUUID();
      const personId = randomUUID();
      await pool.query(`INSERT INTO seat (seat_id, title) VALUES ($1, $2)`, [
        seatId,
        `Shared ${which} (recip ${RUN})`,
      ]);
      await pool.query(`INSERT INTO person (person_id, full_name, phone) VALUES ($1, $2, $3)`, [
        personId,
        `Shared Officer ${which} (recip ${RUN})`,
        shared,
      ]);
      await pool.query(
        `INSERT INTO duty_assignment (seat_id, person_id, from_at) VALUES ($1, $2, now())`,
        [seatId, personId],
      );
    }

    const { body } = await recipients(controlToken);

    const row = body.sharedNumbers.find((s) => s.phone === shared);
    expect(row).toBeDefined();
    // Both posts and both people carry the number, so all four are named. What matters is
    // that the district is told, not the exact count.
    expect(row!.labels.length).toBeGreaterThanOrEqual(2);
  });
});
