/**
 * Which screens this installation offers — ADR-0016, M6-42…M6-45.
 *
 * Three of these are about the same fear, and it is the reason the decision is *hide* rather
 * than *delete*:
 *
 *   * **A capability is not an authority boundary.** Turning a screen off tidies a menu.
 *     Everything behind it still refuses exactly what it refused before (INV-05) — and an
 *     administrator who believes otherwise will act on that belief.
 *   * **Nothing is deleted.** Migration 0018 is the precedent: the provider ladder was dropped
 *     for excellent reasons on 3 August and ADR-0014 rebuilt a version of it forty-eight hours
 *     later.
 *   * **M6-45: every hidden screen stays in `npm run check` and in CI.** A test suite that
 *     shrinks when scope narrows was measuring scope, not correctness — and the offline
 *     substrate is the sharp case, because removing the outbox would not make INV-01's proof
 *     *fail*, it would make it *disappear*.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { authHeaders, seedActor, seedDepartment } from '../../testing/seed.js';
import { CAPABILITIES, defaultCapabilities, parseCapabilities } from '../../domain/capabilities.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

interface CapabilitiesView {
  capabilities: { id: string; name: string; what: string; offered: boolean }[];
  chosen: boolean;
  error?: string;
}

describe('the capability set (pure)', () => {
  it('offers the control room and nothing else by default', () => {
    // ADR-0016. A product that opens on nine screens the district did not ask for is a product
    // they have to be taught before it helps them.
    const state = defaultCapabilities();
    expect(Object.values(state).every((on) => on === false)).toBe(true);
  });

  it('says what turning each one off actually costs', () => {
    // A toggle with no consequence written beside it is a toggle somebody flips to tidy up.
    for (const capability of CAPABILITIES) {
      expect(capability.what.length).toBeGreaterThan(20);
    }
  });

  it('takes defaults for anything the stored set does not mention', () => {
    // A flag added in a later release must not need a migration to have a value, and one
    // removed must not leave a row resolving to nothing.
    const state = parseCapabilities({ search: true, a_flag_from_2027: true });

    expect(state.search).toBe(true);
    expect(state.fleet).toBe(false);
    expect(Object.keys(state).sort()).toEqual(CAPABILITIES.map((c) => c.id).sort());
  });

  it('never throws on a stored value that is not a set at all', () => {
    // Read on the way to every screen. A district whose console cannot render because a
    // configuration row was malformed has lost more than a menu.
    expect(parseCapabilities(null)).toEqual(defaultCapabilities());
    expect(parseCapabilities('everything')).toEqual(defaultCapabilities());
    expect(parseCapabilities({ search: 'yes' })).toEqual(defaultCapabilities());
  });
});

describe.skipIf(dbUrl === undefined)('the capability set (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let adminToken: string;
  let departmentToken: string;
  let incidentId: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (cap ${RUN})`);
    adminToken = (
      await seedActor(pool, {
        title: `Control Room (cap ${RUN})`,
        departmentId: dcDept,
        tier: 'district',
      })
    ).token;

    const rescue = await seedDepartment(pool, `Rescue (cap ${RUN})`);
    departmentToken = (
      await seedActor(pool, { title: `Duty Officer (cap ${RUN})`, departmentId: rescue })
    ).token;

    const created = (await (
      await fetch(`${base}/incidents`, {
        method: 'POST',
        headers: authHeaders(adminToken),
        body: JSON.stringify({ category: 'fire', severity: 'high' }),
      })
    ).json()) as { incidentId: string };
    incidentId = created.incidentId;
  }, 90_000);

  afterAll(async () => {
    await pool?.query('DELETE FROM capability_state');
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function read(token: string): Promise<{ status: number; body: CapabilitiesView }> {
    const res = await fetch(`${base}/settings/capabilities`, { headers: authHeaders(token) });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? ({} as CapabilitiesView) : JSON.parse(raw) };
  }

  async function toggle(
    token: string,
    capability: string,
    offered: boolean,
  ): Promise<{ status: number; body: CapabilitiesView }> {
    const res = await fetch(`${base}/settings/capabilities`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ capability, offered }),
    });
    const raw = await res.text();
    return { status: res.status, body: raw === '' ? ({} as CapabilitiesView) : JSON.parse(raw) };
  }

  it('says whether anybody has ever chosen', async () => {
    await pool.query('DELETE FROM capability_state');
    const { status, body } = await read(adminToken);

    expect(status).toBe(200);
    // "Nobody has looked at this" and "somebody chose exactly these" render identically and
    // mean entirely different things — only the first is an invitation.
    expect(body.chosen).toBe(false);
    expect(body.capabilities.every((c) => !c.offered)).toBe(true);
  });

  it('turns one on, and remembers', async () => {
    const { status, body } = await toggle(adminToken, 'search', true);

    expect(status).toBe(200);
    expect(body.chosen).toBe(true);
    expect(body.capabilities.find((c) => c.id === 'search')?.offered).toBe(true);
    // And only that one. One flag per call, so the log reads as a sentence rather than a diff
    // of six booleans somebody has to compare carefully.
    expect(body.capabilities.find((c) => c.id === 'fleet')?.offered).toBe(false);
  });

  it('records who changed it, like every other setting', async () => {
    await toggle(adminToken, 'evidence', true);

    const history = await pool.query<{ subject_id: string; actor_seat_id: string | null }>(
      `SELECT subject_id, actor_seat_id FROM config_event
        WHERE subject = 'capability' ORDER BY seq DESC LIMIT 1`,
    );

    // "Why could nobody find the search screen in March?" is exactly the question a hidden
    // screen generates, and a settings table alone cannot answer it.
    expect(history.rows[0]?.subject_id).toBe('evidence');
    expect(history.rows[0]?.actor_seat_id).not.toBeNull();
  });

  it('is administration only', async () => {
    expect((await read(departmentToken)).status).toBe(403);
    expect((await toggle(departmentToken, 'fleet', true)).status).toBe(403);
  });

  it('refuses a capability that does not exist', async () => {
    const { status, body } = await toggle(adminToken, 'delete_everything', true);
    expect(status).toBe(400);
    expect(body.error).toContain('capability must be one of');
  });

  //--------------------------------------------------------------------------
  // The line this must never cross
  //--------------------------------------------------------------------------

  it('changes nothing about what a caller may do', async () => {
    /**
     * **The assertion this whole file exists for.**
     *
     * With `evidence` turned off, the screen is not offered — and the endpoint behind it
     * behaves exactly as it did before, refusing precisely what the policy table refuses and
     * accepting precisely what it accepts. A capability that started refusing requests would be
     * a second authority model beside `domain/authority.ts`, and two authority models is one
     * more than anybody can audit (INV-05).
     */
    await toggle(adminToken, 'evidence', false);

    const listed = await fetch(`${base}/incidents/${incidentId}/evidence`, {
      headers: authHeaders(adminToken),
    });

    // Still answers. Turning the tab off tidied a menu; it revoked nothing.
    expect(listed.status).toBe(200);
  });

  it('answers on /health without a session, so an installation’s shape is knowable', async () => {
    /**
     * M6-44. Somebody asked to look at a district's system — a second person on the phone at
     * 02:00, or whoever is holding the restore drill — should find out whether a screen is even
     * switched on before hunting for a login. **A screen that is off looks exactly like a screen
     * that is broken**, and the two send you to entirely different places.
     *
     * Safe unauthenticated precisely because a capability is not an authority boundary.
     */
    const health = (await (await fetch(`${base}/health`)).json()) as {
      capabilities: Record<string, boolean> | null;
      capabilitiesChosen: boolean;
    };

    expect(health.capabilities).not.toBeNull();
    expect(Object.keys(health.capabilities ?? {}).sort()).toEqual(
      CAPABILITIES.map((c) => c.id).sort(),
    );
    expect(health.capabilitiesChosen).toBe(true);
  });

  it('tells a signed-in client what it may offer', async () => {
    const me = (await (
      await fetch(`${base}/auth/me`, { headers: authHeaders(adminToken) })
    ).json()) as { capabilities: Record<string, boolean> | null };

    // Sent with the identity rather than fetched separately: a second request is a second thing
    // that can be half-loaded on a bad connection, leaving an officer looking at a menu missing
    // tabs for a reason nobody can see.
    expect(me.capabilities).not.toBeNull();
  });
});

//------------------------------------------------------------------------------
// M6-45 — a hidden screen is still a screen this project maintains
//------------------------------------------------------------------------------

describe('nothing was deleted (M6-45)', () => {
  /**
   * **A test suite that shrinks when scope narrows was measuring scope, not correctness.**
   *
   * The offline substrate is the case that matters. `spine.e2e.test.ts` *is* INV-01's proof — an
   * emergency captured on a handset with the network genuinely cut, delivering itself on
   * reconnect. Removing the outbox would not make that gate fail; it would make it **disappear**,
   * and the suite would go green having stopped measuring the one claim this project exists to
   * make.
   *
   * So this asserts the files are still there. It is a crude test and deliberately so: what it
   * is defending against is not a bug, it is a future session reading "hide the field intake"
   * as "delete the field intake" — and a crude assertion with this comment attached is exactly
   * the right amount of friction at that moment.
   *
   * **The inbox left this list on 2026-08-06, deliberately (ADR-0018, M7-02).** That is not the
   * rule failing; it is the rule working. The friction was applied, the reasoning was put to the
   * owner, and the owner decided — which is exactly what a crude assertion with a comment is
   * for. The distinction that made it defensible: the inbox was removed over a **population**
   * (nobody outside the control room has an account or will get one) rather than a preference,
   * and it was **actively harmful** rather than merely unused — every obligation it created aged
   * into a permanent unmet one on the board.
   *
   * The outbox line below is now the most important one in this test.
   */
  it('keeps every hidden screen in the suite', async () => {
    const suites = await readdir(join(here, '..', '..', '__tests__'));

    for (const gate of [
      // The offline substrate. INV-01's proof, and the sharpest case (ADR-0016).
      'spine.e2e.test.ts',
      'offlineLaunch.e2e.test.ts',
      // Field intake — the 15-second budget, measured with the CPU throttled.
      'rapidIntake.e2e.test.ts',
      /**
       * ~~The shift screen.~~ **Left this list 2026-08-22 — O-44, the owner's decision, and the
       * second time this rule has worked exactly as designed.**
       *
       * The friction was applied, the reasoning was put to the owner in writing, and the owner
       * chose. The distinctions that made the inbox's removal defensible hold here too, and one
       * of them is sharper:
       *
       *   * **A population, not a preference.** The screen was M1-01's claim about a *department
       *     duty officer*, and ADR-0024 settled that no department will ever hold an account.
       *     Read off the district's own database the day it went: **Bajaur holds ONE account**,
       *     `AC HQ Bajaur`, the control room. **Not one officer had ever been able to open it.**
       *   * **Actively harmful, not merely unused.** After ADR-0024 every control on it was
       *     refused while the screen still drew them — buttons that look like they work and do
       *     not, which is this project's worst signature wearing a different face.
       *
       * Nothing it did was lost: follow up, escalate, resolve and close are on the Record's
       * incident screen and always were.
       */
      /**
       * The roster editor — and it is here for a **different** reason from the others now.
       *
       * The rest of this list is screens that are *hidden* and must not be deleted. The roster
       * is not hidden at all: the control room reaches every department's through the console,
       * and it is how Rescue 1122's missing number stops being a developer's job.
       *
       * What was deleted on 2026-08-06 was its **second door**, "My department" — the
       * `department_workspace` capability went with it, because ADR-0018 leaves nobody to walk
       * through it. This line stays so that deleting one door never turns into deleting the
       * component behind both.
       */
      'roster.e2e.test.ts',
      // Searching the record.
      'search.e2e.test.ts',
    ]) {
      expect(suites, `${gate} is gone — see ADR-0016 and M6-45`).toContain(gate);
    }
  });

  it('keeps the outbox itself', async () => {
    /**
     * **The most important assertion in this file, and more so since 2026-08-06.**
     *
     * The inbox was deleted that day for good reasons (ADR-0018). The outbox sits one word away
     * from it and is the opposite kind of thing: it is not a surface for an audience that no
     * longer exists, it is how the **control room's own** reports become durable before they
     * reach the server — used every day, by the only user there is.
     *
     * Deleting it because the phrase "in-app" appears near it would remove the one claim this
     * project exists to make, and `spine.e2e.test.ts` would not fail. It would simply stop
     * proving INV-01, and the suite would go green.
     */
    const outbox = await readdir(join(here, '..', '..', 'outbox'));

    expect(outbox).toContain('outbox.ts');
    expect(outbox).toContain('adapters');
  });
});
