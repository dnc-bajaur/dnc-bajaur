/**
 * Test identities.
 *
 * Every suite that touches `/sync` now needs a real session, because there is no longer a
 * way in without one — which is the point of INV-05. This creates a person holding a seat
 * and returns a usable token.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from '../db/pool.js';
import { hashPassword } from '../auth/passwords.js';
import { login } from '../auth/sessions.js';
import type { Role } from '../domain/roles.js';

export const TEST_PASSWORD = 'test-duty-officer-2026';

export interface TestActor {
  readonly personId: string;
  readonly seatId: string;
  readonly departmentId: string;
  readonly phone: string;
  readonly token: string;
}

/**
 * A department row, because `seat.department_id` is a real foreign key from migration 0005.
 *
 * Before that, tests invented a uuid and the database accepted it — which was the whole
 * problem: a department id that referenced nothing, rendered to operators as a uuid. Tests
 * now have to create the thing they point at, exactly as the district does.
 */
export async function seedDepartment(pool: Pool, name?: string): Promise<string> {
  return ensureDepartment(pool, randomUUID(), name);
}

/**
 * Make sure a specific department id exists.
 *
 * Some suites pin a department to a constant so the same id appears in fixtures and
 * assertions. Those ids used to reference nothing, which the database happily allowed — the
 * exact bug M0-51 fixes. Rather than make every such suite remember to create the row, the
 * helper they already call guarantees it.
 */
/**
 * ⚠️ **A NO-OP SINCE ADR-0030, AND KEPT SO THE SUITE DOES NOT MOVE IN THIS COMMIT.**
 *
 * Migration 0039 dropped the table. Every caller passes an id and uses it afterwards to scope
 * something, and every one of those scopes is now the district's whole list — so handing the id
 * straight back keeps each test asking the same question and getting the answer the product now
 * gives, rather than failing on a table that is not there.
 *
 * The tests that genuinely ASSERTED on department scoping are a separate pass. This one keeps
 * the ones that merely needed a department to exist.
 */
export function ensureDepartment(
  _pool: Pool,
  departmentId: string,
  _name?: string,
): Promise<string> {
  return Promise.resolve(departmentId);
}

export async function seedActor(
  pool: Pool,
  options: {
    title?: string;
    departmentId?: string;
    tier?: 'post' | 'district';
    canBreakGlass?: boolean;
    /**
     * The access role (ADR-0032). Defaults to `admin` for a `district`-tier (administrative)
     * seat and `operator` otherwise, so an existing `tier: 'district'` caller keeps the
     * administrator authority it had — and keeps it once phase 2 removes the seat-tick bridge.
     */
    role?: Role;
  } = {},
): Promise<TestActor> {
  const departmentId =
    options.departmentId === undefined
      ? await seedDepartment(pool)
      : await ensureDepartment(pool, options.departmentId);

  // Asking for a district-tier seat means asking for an administrative office.
  //
  // Migration 0042 derives tier from `seat.is_administration` — the tick on the seat itself —
  // so an ordinary seat is `post` tier whatever the INSERT says, and a test that asked for
  // `district` and silently got `post` would go on to fail somewhere far away, as a 403 on the
  // board rather than as "this seat is not what you asked for". Marking the seat administrative
  // is the honest way to get the thing the caller wanted. The trigger overwrites `tier` from
  // that tick, which is why the value passed below is written explicitly anyway: reading this
  // should not suggest a caller has a say.
  const seat = await pool.query<{ seat_id: string }>(
    `INSERT INTO seat (title, tier, can_break_glass, is_administration)
     VALUES ($1, $2, $3, $4) RETURNING seat_id`,
    [
      options.title ?? 'Test Duty Seat',
      options.tier ?? 'post',
      options.canBreakGlass ?? false,
      options.tier === 'district',
    ],
  );
  const seatId = seat.rows[0]!.seat_id;

  const phone = `+92300${Math.floor(Math.random() * 900 + 100)}${randomUUID().slice(0, 6)}`;
  const role: Role = options.role ?? (options.tier === 'district' ? 'admin' : 'operator');
  const person = await pool.query<{ person_id: string }>(
    `INSERT INTO person (full_name, phone, password_hash, role)
     VALUES ($1, $2, $3, $4) RETURNING person_id`,
    ['Test Officer', phone, await hashPassword(TEST_PASSWORD), role],
  );
  const personId = person.rows[0]!.person_id;

  await pool.query('INSERT INTO duty_assignment (seat_id, person_id) VALUES ($1, $2)', [
    seatId,
    personId,
  ]);

  const result = await login(pool, phone, TEST_PASSWORD);
  if (result === null) throw new Error('seedActor: login failed immediately after seeding');

  return { personId, seatId, departmentId, phone, token: result.token };
}

/** Headers for an authenticated JSON request. */
export function authHeaders(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/**
 * Turn every screen on, for a suite that exercises one — ADR-0016, M6-45.
 *
 * **A fresh installation offers the control room and nothing else.** That is the decision, and
 * it is why five browser suites went red the moment it landed: the M1 gate, the roster, the
 * shift screen and search all drive tabs a default installation does not show.
 *
 * The fix is not to weaken the default. It is that **a test asserting a screen works has to make
 * that screen available first** — and calling this is the visible act of doing so. M6-45's rule
 * is that every hidden screen stays in `npm run check` and in CI, because a test suite that
 * shrinks when scope narrows was measuring scope rather than correctness; this is what keeps
 * that true rather than aspirational.
 *
 * It also happens to prove the other half by construction: the screens come back when the
 * capability is turned on.
 */
export async function enableAllCapabilities(pool: Pool): Promise<void> {
  const { CAPABILITIES } = await import('../domain/capabilities.js');
  const state: Record<string, boolean> = {};
  for (const capability of CAPABILITIES) state[capability.id] = true;

  await pool.query(
    `INSERT INTO capability_state (only_row, state) VALUES (true, $1::jsonb)
     ON CONFLICT (only_row) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [JSON.stringify(state)],
  );
}

/**
 * The other half of the pair above, and the one a suite needs when what it is proving is that
 * something stays visible **without** any capability turned on.
 *
 * `capability_state` is one row for the whole installation (`only_row`), not scoped per test —
 * so a suite cannot assume a freshly migrated database means every capability is off. Db tests
 * share one cluster and run one file at a time, and a file that ran earlier and called
 * `enableAllCapabilities` leaves that row set for whoever runs next. Call this rather than
 * trusting the ambient state, for the same reason `enableAllCapabilities` exists: make the
 * precondition true, don't assume it.
 */
export async function disableAllCapabilities(pool: Pool): Promise<void> {
  const { CAPABILITIES } = await import('../domain/capabilities.js');
  const state: Record<string, boolean> = {};
  for (const capability of CAPABILITIES) state[capability.id] = false;

  await pool.query(
    `INSERT INTO capability_state (only_row, state) VALUES (true, $1::jsonb)
     ON CONFLICT (only_row) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [JSON.stringify(state)],
  );
}
