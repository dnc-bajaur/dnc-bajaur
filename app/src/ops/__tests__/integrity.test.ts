/**
 * The configuration sweep — W-01.
 *
 * These tests build the broken district on purpose and check the sweep notices. Each one
 * corresponds to a way Bajaur can be misconfigured such that an emergency reaches nobody and
 * **nothing anywhere says so** — which is the entire reason the sweep exists.
 *
 * The most important test in the file is the last one: the sweep must not change anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor } from '../../testing/seed.js';
import { formatReport, sweep, type Finding } from '../integrity.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the configuration sweep', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  function find(findings: readonly Finding[], code: string): Finding | undefined {
    return findings.find((f) => f.code === code);
  }

  /**
   * A post with nobody behind it.
   *
   * ⚠️ It used to take a department id, because `seat.department_id` was a real foreign key.
   * ADR-0030 dropped the column, and a post is now just a title the district is responsible for
   * keeping unique — which is the same constraint the contact screen puts in front of an
   * operator, so the fixture and the product now fail on the same thing.
   */
  async function postWithNoHolder(title: string): Promise<string> {
    const { rows } = await pool.query<{ seat_id: string }>(
      `INSERT INTO seat (title) VALUES ($1) RETURNING seat_id`,
      [title],
    );
    return rows[0]!.seat_id;
  }

  /**
   * The two checks ADR-0030 left standing as shapes, and why they were not deleted.
   *
   * `department-with-no-post` and `unregistered-department` both asked about a table that is
   * gone. Their queries are now `SELECT NULL WHERE false` — ⚠️ **deliberately not a query
   * against `department`**, because the sweep runs every check in one loop and a single throw
   * would take the other six down with it. That is the failure worth a test of its own: a report
   * about whether the district is reachable must never be the thing that stops being readable.
   *
   * So this asserts both halves at once — the two never fire, and the checks either side still do.
   */
  it('never reports a department, and the checks either side of it still run', async () => {
    await postWithNoHolder(`Nobody Holds This ${RUN}`);

    const table = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'department'`,
    );
    expect(Number(table.rows[0]!.n)).toBe(0);

    const { findings } = await sweep(pool);

    expect(find(findings, 'department-with-no-post')).toBeUndefined();
    expect(find(findings, 'unregistered-department')).toBeUndefined();
    expect(find(findings, 'vacant-post')?.count).toBeGreaterThan(0);
  });

  it('counts a placeholder number as unreachable, not as covered', async () => {
    const seatId = await postWithNoHolder(`Awaiting A Number ${RUN}`);
    const person = await pool.query<{ person_id: string }>(
      `INSERT INTO person (full_name, phone, placeholder) VALUES ($1, $2, true)
       RETURNING person_id`,
      [`Placeholder Holder ${RUN}`, `1111111-${RUN}`],
    );
    await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
      seatId,
      person.rows[0]!.person_id,
    ]);
    const report = await sweep(pool);

    /**
     * A stand-in number is a post nobody can be reached on, and the sweep must not read it as
     * covered — that is the whole claim, and it is Rescue 1122's actual situation (R-01).
     *
     * It used to be asserted twice: once as an unreachable post, and once as a department
     * `signals-but-unreachable` would send work to. That second finding went with routing
     * (ADR-0022). Nothing is sent anywhere on its own now, so the department half of the
     * claim has no mechanism behind it and the post half carries it alone.
     *
     * Asserted on counts rather than on the examples list, which is capped at ten and sorted
     * by name — a shared test database will usually have pushed this run's row past the cut.
     * The cap is the right behaviour for a report somebody reads; it just makes `examples`
     * the wrong thing to assert on.
     */
    const placeholders = find(report.findings, 'placeholder-number');
    expect(placeholders?.severity).toBe('serious');
    expect(placeholders?.count).toBeGreaterThan(0);
  });

  it('finds a post nobody holds', async () => {
    await postWithNoHolder(`Unfilled Post ${RUN}`);

    const finding = find((await sweep(pool)).findings, 'vacant-post');
    expect(finding?.severity).toBe('serious');
    expect(finding?.examples.join(' ') + ' ').toBeTruthy();
    expect(finding?.count).toBeGreaterThan(0);
  });

  it('keeps the one finding control-room-first makes worse, not better', async () => {
    /**
     * The blocking finding that survived every change of mechanism — and ADR-0030 made it the
     * only one left, which makes it matter more than it did.
     *
     * It used to be `department-with-no-post`: a department the control room could pick in
     * "who should know", be told the message went, and nobody ever reachable behind it. With
     * departments gone the same failure lives one level down and is worse, because it is about
     * **authority** rather than about one message. `seat.is_administration` is now the ONLY
     * thing deciding who may set a deadline or issue a district advisory. If nobody carries it
     * the district can still sign in, still read the board, and simply cannot act — and
     * **nothing fails at the moment it happens.** That is the INV-03 shape, which is why this
     * check is `blocking` and why it is asserted in both directions rather than one.
     */
    await pool.query('UPDATE seat SET is_administration = false');

    const missing = find((await sweep(pool)).findings, 'no-administration');
    expect(missing?.severity).toBe('blocking');
    expect(missing?.consequence).toContain('deadlines');
    expect(missing?.count).toBe(1);

    await pool.query(`INSERT INTO seat (title, is_administration) VALUES ($1, true)`, [
      `Deputy Commissioner ${RUN}`,
    ]);

    expect(find((await sweep(pool)).findings, 'no-administration')).toBeUndefined();
  });

  it('finds somebody who can sign in but holds no post', async () => {
    const actor = await seedActor(pool, { title: `Will Be Relieved ${RUN}` });
    await pool.query(
      'UPDATE duty_assignment SET to_at = now() WHERE person_id = $1 AND to_at IS NULL',
      [actor.personId],
    );

    const finding = find((await sweep(pool)).findings, 'account-without-post');
    expect(finding?.severity).toBe('serious');
    expect(finding?.count).toBeGreaterThan(0);
  });

  it('reports a shared handset as a note, not a problem', async () => {
    const shared = `0300-shared-${RUN}`;
    await pool.query('INSERT INTO person (full_name, phone) VALUES ($1, $2), ($3, $2)', [
      `Shares A ${RUN}`,
      shared,
      `Shares B ${RUN}`,
    ]);

    const finding = find((await sweep(pool)).findings, 'shared-handset');
    // An office handset covering two posts is ordinary in Bajaur (Q-19). Reporting it as a
    // problem would train whoever reads this to ignore the list.
    //
    // Counted rather than found in `examples`, which is capped at ten and sorted by name —
    // on a shared test database this run's pair is usually past the cut. The cap is right for
    // a report somebody reads; it just makes `examples` the wrong thing to assert on.
    expect(finding?.severity).toBe('note');
    expect(finding?.count).toBeGreaterThan(0);

    const pair = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM person WHERE phone = $1 AND removed_at IS NULL',
      [shared],
    );
    expect(Number(pair.rows[0]!.n)).toBe(2);
  });

  /**
   * This one should never fire. It is here because migration 0010 enforces tier by trigger, and
   * a check that can only fail when something has bypassed the database is exactly the check
   * worth keeping — a district-tier post can read every incident in Bajaur.
   *
   * ⚠️ **ADR-0030 narrowed what the trigger reads and did not narrow what this proves.** The
   * tier used to be derived from the office; it is derived from `is_administration` on the post
   * itself now. So the INSERT below asks for `district` on a post nothing ticked, and the
   * trigger overrules it — the same claim, against the one rule that is left.
   */
  it('reports no tier disagreeing with the tick, because a trigger prevents it', async () => {
    const { rows } = await pool.query<{ tier: string }>(
      `INSERT INTO seat (title, tier) VALUES ($1, 'district') RETURNING tier`,
      [`Trying It On ${RUN}`],
    );
    expect(rows[0]?.tier).toBe('post');

    expect(find((await sweep(pool)).findings, 'tier-disagrees-with-tick')).toBeUndefined();
  });

  it('orders findings by consequence, worst first', async () => {
    const { findings } = await sweep(pool);
    const rank = { blocking: 0, serious: 1, note: 2 } as const;
    const ranks = findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('says something useful when there is nothing to say', async () => {
    // ⚠️ `departments` is a literal zero since ADR-0030, and the field is kept on the reply so
    // the console's overview does not move in the same commit. Asserted on `posts`, which is
    // the number that still counts something that exists.
    const text = formatReport({
      asOf: '2026-08-02T00:00:00.000Z',
      findings: [],
      summary: { blocking: 0, serious: 0, notes: 0, departments: 0, posts: 9, people: 9 },
    });
    expect(text).toContain('Nothing to report');
    expect(text).toContain('9 posts');
  });

  it('names the consequence, never just the fact', async () => {
    // A finding that says "3 vacant posts" and stops is a number somebody scrolls past. The
    // whole value of this report is the second line.
    for (const f of (await sweep(pool)).findings) {
      expect(f.consequence.length).toBeGreaterThan(40);
      expect(f.consequence).not.toMatch(/may cause|might be|could lead/i);
    }
  });

  /**
   * The rule the whole module is built around.
   *
   * Everything the sweep finds is either a decision for the district or a fact somebody has
   * to look at. A sweep that quietly corrected things would destroy the evidence that
   * anything was wrong — and would make the next report look clean while the district was
   * still misconfigured.
   */
  it('changes nothing at all', async () => {
    // `routing_signal` was counted here too until ADR-0022 dropped the table, and `department`
    // until ADR-0030 dropped that one.
    const counts = `SELECT (SELECT count(*) FROM seat)            AS s,
              (SELECT count(*) FROM person)          AS p,
              (SELECT count(*) FROM duty_assignment) AS a`;

    const before = await pool.query<{ s: string; p: string; a: string }>(counts);

    await sweep(pool);

    const after = await pool.query<{ s: string; p: string; a: string }>(counts);

    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
