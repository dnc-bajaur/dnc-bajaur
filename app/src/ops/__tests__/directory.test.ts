/**
 * The department registry — M0-51.
 *
 * A directory is where a system quietly starts lying about the district: a merged duplicate,
 * an inferred hierarchy, an invented login. The tests here are about what the loader
 * **refuses** to do at least as much as what it does.
 *
 * Every fixture below is invented. The real list is `db/seed/directory.json`, which is
 * gitignored — real officers' mobile numbers do not belong in a repository's history.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createPool, migrate, type Pool } from '../../db/pool.js';
import { login } from '../../auth/sessions.js';
import { hashPassword } from '../../auth/passwords.js';
import { codeFor, departmentDirectory, loadDirectory, normalisePhone } from '../directory.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

/** Long enough for `assertUsable`; only ever used by fixtures in this file. */
const ACCOUNT_PASSWORD = 'directory-test-account-2026';

describe('slug and phone normalisation', () => {
  it('makes a stable slug from a department name', () => {
    expect(codeFor('Rescue 1122')).toBe('rescue-1122');
    expect(codeFor('C&W Building Division')).toBe('c-and-w-building-division');
    expect(codeFor('  Excise, Taxation & Narcotics  ')).toBe('excise-taxation-and-narcotics');
  });

  it('recognises the same number written differently', () => {
    expect(normalisePhone('0300 123 9000')).toBe('03001239000');
    expect(normalisePhone('+923001239000')).toBe('03001239000');
    expect(normalisePhone('923001239000')).toBe('03001239000');
  });

  it('does not reject a number that looks wrong', () => {
    // It is still the number the district gave us. Losing a contact to satisfy a regex is a
    // worse outcome than holding one that needs checking.
    expect(normalisePhone('12345')).toBe('12345');
  });
});

describe.skipIf(dbUrl === undefined)('loading a directory (integration)', () => {
  let pool: Pool;
  /** Namespaced per run so suites sharing a database cannot collide. */
  let tag: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  /** Digits only. A uuid slice contains hex letters, which `normalisePhone` strips — so a
   *  fixture built from one is stored in a different form than the test looks it up by. */
  let phoneTag: string;

  beforeEach(() => {
    tag = randomUUID().slice(0, 8);
    phoneTag = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  });

  const dept = (n: string): string => `Test Dept ${tag} ${n}`;
  const phone = (n: number): string => `03${phoneTag}${String(n).padStart(3, '0')}`;

  it('creates a department, a seat, a person and a duty assignment', async () => {
    const out = await loadDirectory(pool, [
      {
        department: dept('A'),
        designation: 'District Emergency Officer',
        name: 'Test Officer One',
        phone: phone(1),
        tier: 'district',
      },
    ]);

    expect(out.problems).toEqual([]);
    // ADR-0030 — the loader creates no department. The field is reported and always zero;
    // see load-directory.mjs, which keeps it so its summary does not appear to lose a count.
    expect(out.departments).toBe(0);
    expect(out.seats).toBe(1);
    expect(out.people).toBe(1);
    expect(out.assignments).toBe(1);

    const row = await pool.query<{ title: string; full_name: string }>(
      `SELECT s.title, p.full_name
         FROM seat s
         JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
         JOIN person p ON p.person_id = a.person_id
        WHERE s.title = $1`,
      ['District Emergency Officer'],
    );
    expect(row.rows[0]).toMatchObject({
      title: 'District Emergency Officer',
      full_name: 'Test Officer One',
    });
  });

  it('is idempotent — the district will send a longer list next time', async () => {
    const rows = [{ department: dept('B'), designation: 'XEN', name: 'Test Two', phone: phone(2) }];
    await loadDirectory(pool, rows);
    const second = await loadDirectory(pool, rows);

    expect(second.departments).toBe(0);
    expect(second.seats).toBe(0);
    expect(second.people).toBe(0);
    expect(second.assignments).toBe(0);
    expect(second.problems).toEqual([]);
  });

  it('lets one officer hold two posts', async () => {
    // The same ADC covers General and Relief; one XEN covers two canal divisions. Real, and
    // the model already allows it — the unique index only forbids two people in one seat.
    const out = await loadDirectory(pool, [
      { department: dept('C1'), designation: 'XEN Canal', name: 'Test Three', phone: phone(3) },
      { department: dept('C2'), designation: 'XEN Salarzai', name: 'Test Three', phone: phone(3) },
    ]);

    expect(out.problems).toEqual([]);
    expect(out.people).toBe(1);
    expect(out.assignments).toBe(2);
  });

  describe('what it refuses to do', () => {
    it('will not quietly hand a held seat to someone else', async () => {
      // A handover is a deliberate, auditable act (docs/04-authority-model.md), not something
      // an import does because a spreadsheet changed.
      const d = dept('E');
      await loadDirectory(pool, [
        { department: d, designation: 'Post', name: 'Test Six', phone: phone(6) },
      ]);
      const out = await loadDirectory(pool, [
        { department: d, designation: 'Post', name: 'Test Seven', phone: phone(7) },
      ]);

      expect(out.problems).toHaveLength(1);
      expect(out.problems[0]!.problem).toMatch(/already held/);
      expect(out.assignments).toBe(0);
    });

    it('reports a row with no department rather than skipping it', async () => {
      const out = await loadDirectory(pool, [{ department: '  ', name: 'Nobody' }]);
      expect(out.problems).toHaveLength(1);
      expect(out.seats).toBe(0);
    });
  });

  describe('two officers on one handset (Q-19)', () => {
    it('loads both, and says so', async () => {
      // Confirmed by the owner as ordinary here: an office handset covering two posts. Both
      // load — but it is surfaced as a note, because a mistyped digit produces exactly this
      // shape and nothing in the data distinguishes them.
      const shared = phone(4);
      const out = await loadDirectory(pool, [
        { department: dept('D1'), designation: 'Post One', name: 'Test Four', phone: shared },
        { department: dept('D2'), designation: 'Post Two', name: 'Test Five', phone: shared },
      ]);

      expect(out.problems).toEqual([]);
      expect(out.people).toBe(2);
      expect(out.assignments).toBe(2);

      expect(out.notes).toHaveLength(1);
      expect(out.notes[0]!.problem).toMatch(/shared handset, both loaded/);
    });

    it('keeps each officer attached to their own post', async () => {
      // The failure this guards: matching a row to a person by phone alone would hand the
      // second post to whichever officer was inserted first, silently.
      const shared = phone(5);
      await loadDirectory(pool, [
        // ⚠️ NAMESPACED, and ADR-0030 is why. A designation is now unique across the DISTRICT,
        // so the plain 'Post One' these used to carry is the same post the D1/D2 test above just
        // created and filled — this load would attach to it, report it already held, and fail on
        // an assertion about the wrong officers. It is the district's own new rule biting a
        // fixture: two offices can no longer both have a Duty Officer.
        { department: dept('E1'), designation: `Post One ${tag}`, name: 'Test Six', phone: shared },
        {
          department: dept('E2'),
          designation: `Post Two ${tag}`,
          name: 'Test Seven',
          phone: shared,
        },
      ]);

      const held = await pool.query<{ title: string; full_name: string }>(
        `SELECT s.title, p.full_name
           FROM seat s
           JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
           JOIN person p ON p.person_id = a.person_id
          WHERE s.title IN ($1, $2)
          ORDER BY s.title`,
        [`Post One ${tag}`, `Post Two ${tag}`],
      );

      expect(held.rows).toEqual([
        { title: `Post One ${tag}`, full_name: 'Test Six' },
        { title: `Post Two ${tag}`, full_name: 'Test Seven' },
      ]);
    });

    it('still refuses two accounts on one number', async () => {
      // Uniqueness moved rather than disappeared (migration 0006). A directory contact may
      // share a handset; two people who can *sign in* may not, because "who is signing in?"
      // has to have exactly one answer.
      const shared = phone(6);
      await pool.query('INSERT INTO person (full_name, phone, password_hash) VALUES ($1,$2,$3)', [
        'Account One',
        shared,
        'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ]);

      await expect(
        pool.query('INSERT INTO person (full_name, phone, password_hash) VALUES ($1,$2,$3)', [
          'Account Two',
          shared,
          'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        ]),
      ).rejects.toThrow();
    });

    it('signs in the account holder, not the contact sharing their number', async () => {
      const shared = phone(7);
      await loadDirectory(pool, [
        {
          department: dept('F1'),
          designation: 'Contact Post',
          name: 'Directory Only',
          phone: shared,
        },
      ]);
      await pool.query('INSERT INTO person (full_name, phone, password_hash) VALUES ($1,$2,$3)', [
        'Real Account',
        shared,
        await hashPassword(ACCOUNT_PASSWORD),
      ]);

      const result = await login(pool, shared, ACCOUNT_PASSWORD);
      expect(result).not.toBeNull();
      expect(result!.identity.fullName).toBe('Real Account');
    });
  });

  describe('a post with nobody in it', () => {
    it('loads as a vacant seat, because that is a real state', async () => {
      // Thirty-eight of the district's first eighty-one posts arrived with no contact. A
      // loader that skipped them would report a district with no gaps in it.
      const out = await loadDirectory(pool, [
        { department: dept('F'), designation: 'Vacant Post' },
      ]);

      expect(out.problems).toEqual([]);
      expect(out.seats).toBe(1);
      expect(out.vacant).toBe(1);
      expect(out.people).toBe(0);

      const held = await pool.query(
        `SELECT 1 FROM seat s
          WHERE s.title = $1
            AND NOT EXISTS (SELECT 1 FROM duty_assignment a
                             WHERE a.seat_id = s.seat_id AND a.to_at IS NULL)`,
        ['Vacant Post'],
      );
      expect(held.rowCount).toBe(1);
    });

    it('🔴 does NOT count a named officer with no number as a vacancy', async () => {
      /**
       * **The defect this exists for, and it would have cost the district four contacts.**
       *
       * The loader tested `isBlank(row.name) || isBlank(row.phone)`, so a post held by a named
       * officer whose number was never recorded loaded as a **vacancy** — no person, no duty
       * assignment, and the name thrown away. On Bajaur's own list that is four rows, and the
       * first of them is **Rescue 1122's District Emergency Officer**.
       *
       * It looked harmless while nothing acted on a vacancy. **Migration 0038 retires every seat
       * nobody holds**, so it would have taken all four off the district's contact list — the
       * exact outcome ADR-0029 §3 was written to prevent, one layer below where that argument
       * was made. Nothing in this file could see it: sixteen tests were green over it.
       *
       * A vacancy needs somebody appointed. This needs a telephone call. They are different
       * gaps and the loader now counts them apart.
       */
      const out = await loadDirectory(pool, [
        { department: dept('J'), designation: 'Named No Number', name: 'Noor Rahman Khan' },
      ]);

      expect(out.problems).toEqual([]);
      expect(out.vacant, 'a held post was counted as a vacancy').toBe(0);
      expect(out.placeholders).toBe(1);
      expect(out.people).toBe(1);

      /**
       * **Held, and held by a placeholder** — migration 0008's own mechanism, and its own text
       * names Rescue 1122 as the case it was written for. The post is filled so it survives the
       * vacancy sweep and can be edited; the number is labelled a stand-in everywhere it is
       * shown, and is never dialled, messaged or counted as reached.
       */
      const holder = await pool.query<{ full_name: string; placeholder: boolean }>(
        `SELECT p.full_name, p.placeholder
           FROM seat s
           JOIN duty_assignment a ON a.seat_id = s.seat_id AND a.to_at IS NULL
           JOIN person p ON p.person_id = a.person_id
          WHERE s.title = $1`,
        ['Named No Number'],
      );
      expect(holder.rowCount, 'the post was left unheld and the sweep would retire it').toBe(1);
      expect(holder.rows[0]?.full_name).toBe('Noor Rahman Khan');
      expect(holder.rows[0]?.placeholder, 'a stand-in number was not labelled as one').toBe(true);

      // And it is said out loud rather than counted silently — this needs a telephone call,
      // and a count nobody reads is not a gap anybody closes.
      expect(out.notes.some((n) => n.problem.includes('no number on file'))).toBe(true);
    });
  });

  describe('a directory entry is not an account (migration 0005)', () => {
    it('loads people with no password, and they cannot sign in', async () => {
      // ~80 named officials must be *notifiable*. That is not the same as ~80 people who can
      // sign in. An account nobody was told about is a credential nobody is watching.
      const number = phone(8);
      await loadDirectory(pool, [
        { department: dept('G'), designation: 'Post', name: 'Test Eight', phone: number },
      ]);

      const stored = await pool.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM person WHERE phone = $1',
        [number],
      );
      expect(stored.rows[0]!.password_hash).toBeNull();

      // Fails closed, and pinned rather than left to the hash comparison happening to miss.
      expect(await login(pool, number, 'anything')).toBeNull();
      expect(await login(pool, number, '')).toBeNull();
    });
  });

  describe('naming departments for a screen', () => {
    /**
     * ⚠️ **TWO TESTS WERE REPLACED BY THIS ONE, AND ONE OF THEM WOULD HAVE PASSED — ADR-0030.**
     *
     * They were *"returns a map from id to name"* and *"leaves out retired departments"*. The
     * first now fails honestly: there is no map. **The second would have gone GREEN**, because
     * a retired department is absent from an empty map exactly as it was absent from a filtered
     * one — a test passing for a reason its own name does not describe, which is worse than one
     * that fails.
     *
     * What is asserted instead is the rule that replaced them: the map is empty, and getting it
     * costs no query. That second half matters — migration 0039 dropped the table, so a lookup
     * would throw rather than miss, and every caller of this names targets on the district's own
     * past record.
     */
    it('is empty, and asks the database nothing', async () => {
      await loadDirectory(pool, [
        { department: dept('H'), designation: 'Post', name: 'Test Nine', phone: phone(9) },
      ]);

      expect(await departmentDirectory(pool)).toEqual({});

      // Proved rather than assumed: a pool that throws on use. If this ever starts querying
      // again it fails here rather than on the night the table is gone.
      const refuses = {
        query: () => {
          throw new Error('departmentDirectory must not query');
        },
      } as unknown as typeof pool;
      expect(await departmentDirectory(refuses)).toEqual({});
    });
  });
});
