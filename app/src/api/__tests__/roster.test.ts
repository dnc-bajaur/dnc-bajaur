/**
 * The roster — M1a-10, over HTTP, against a real PostgreSQL.
 *
 * Most of this file is about **who may touch whose data**, because that is the requirement
 * the owner set and it is the one with a silent failure mode. A roster edit that reaches too
 * far does not throw: it quietly changes the number an emergency alert will be sent to.
 *
 * The split under test, from the owner (2026-08-02):
 *
 *   - a department edits **its own** people and posts
 *   - the two administrative offices edit **anyone's**
 *   - SLA deadlines stay with the two offices, and a department must not reach them — it
 *     could otherwise give itself a night to answer a critical call, and nothing on any
 *     screen would show that it had happened
 *
 * Routing signals were the other half of that line until ADR-0022 removed them. The rule the
 * owner drew is unchanged: what the two offices decide **about** a department is not the
 * department's to edit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../server.js';
import { createPool, migrate, type Pool } from '../../db/pool.js';
import { seedActor, seedDepartment, TEST_PASSWORD } from '../../testing/seed.js';
import type { NotificationChannel } from '../../jobs/notify.js';
import { loadIncident } from '../../db/eventStore.js';
import { foldIncident } from '../../domain/incident.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('the roster (integration)', () => {
  let pool: Pool;
  let server: Server;
  let base: string;

  let dcToken: string;
  /** Rescue: an ordinary department, editing itself. */
  let rescueToken: string;
  let rescueDept: string;
  /** Police: a second ordinary department, so "its own" can be told from "anyone's". */
  let policeToken: string;
  let policeDept: string;

  beforeAll(async () => {
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);

    server = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (roster ${RUN})`);
    dcToken = (
      await seedActor(pool, { title: `DC (roster ${RUN})`, departmentId: dcDept, tier: 'district' })
    ).token;

    rescueDept = await seedDepartment(pool, `Rescue (roster ${RUN})`);
    rescueToken = (
      await seedActor(pool, { title: `Rescue Duty (roster ${RUN})`, departmentId: rescueDept })
    ).token;

    policeDept = await seedDepartment(pool, `Police (roster ${RUN})`);
    policeToken = (
      await seedActor(pool, { title: `Police Duty (roster ${RUN})`, departmentId: policeDept })
    ).token;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  async function call(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    return {
      status: res.status,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    };
  }

  //----------------------------------------------------------------------------
  // Who may touch whose
  //----------------------------------------------------------------------------

  /**
   * 🔴 **WAS *"a department edits its own, and only its own"* — 2026-08-22.**
   *
   * That was `D-02`, decided because routing every account request through the DC office does not
   * scale and ends in shared passwords. The district reversed it outright:
   *
   * > *"Department ko koi access nahi milne wala hai, un ka koi account nahi banega … mujhe yeh
   * > concept hi nahi chahiye ke department khud kuch kar sake app ke andar."*
   *
   * ⚠️ **`reachPerson` was the most consequential of the gates it closes, because it was
   * self-propagating:** a department seat could grant a login to anybody holding a post in its
   * own department, and each of those could grant more. So *"no department holds an account"*
   * could not be enforced by simply never issuing the first one.
   *
   * The "My department" screen went on 2026-08-06 at the owner's instruction and **this lock did
   * not** — the capability survived with no door to it, true only for as long as nobody was given
   * an account.
   */
  describe('only the two offices touch the roster', () => {
    it('refuses an ordinary department seat the roster', async () => {
      // ADR-0031 phase 3: one flat `/roster`, no `/roster/:dept` — the "by id" half is gone.
      expect((await call('GET', '/roster', rescueToken)).status).toBe(403);
    });

    it('refuses a department seat adding a post or a person', async () => {
      const post = await call('POST', '/roster/posts', rescueToken, {
        title: `Station Officer ${RUN}`,
      });
      expect(post.status).toBe(403);

      const person = await call('POST', '/roster/people', rescueToken, {
        fullName: 'Rescue Officer One',
        phone: `0300${RUN}01`,
      });
      expect(person.status).toBe(403);
    });

    it('refuses one department reading or writing another’s', async () => {
      // The narrower rule this file was built around. It still holds — it is simply no longer
      // the only one, and the one above is the half that changed.
      expect((await call('GET', '/roster', policeToken)).status).toBe(403);

      const write = await call('POST', '/roster/posts', policeToken, {
        title: 'Police Trying It On',
      });
      expect(write.status).toBe(403);
    });

    it('lets the administration edit any department’s roster', async () => {
      const post = await call('POST', '/roster/posts', dcToken, {
        title: `Added By The DC ${RUN}`,
      });
      expect(post.status).toBe(201);

      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Rescue Officer One',
        phone: `0300${RUN}01`,
        seatId: post.body['seatId'],
      });
      expect(person.status).toBe(201);

      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as {
        title: string;
        holder: { fullName: string } | null;
      }[];
      expect(posts.find((p) => p.title === `Added By The DC ${RUN}`)?.holder?.fullName).toBe(
        'Rescue Officer One',
      );
    });

    it('refuses an unauthenticated caller with 401, not 403', async () => {
      expect((await call('GET', '/roster', null)).status).toBe(401);
    });
  });

  //----------------------------------------------------------------------------
  // The line the owner drew
  //----------------------------------------------------------------------------

  describe('deadlines stay with the two offices (ADR-0010)', () => {
    /**
     * ⚠️ **There were two tests here and one of them is gone with its endpoint.**
     *
     * The owner was explicit that "a department edits its own data" does not extend to what
     * the two offices decide about a department, and routing signals were the first example:
     * a department able to edit its own could remove the signal that sent it night-time fire
     * calls, stop receiving them, and nothing anywhere would show it. ADR-0022 removed
     * signals, so that route refuses everybody by not existing.
     *
     * The rule it was protecting is unchanged, and the deadline test below is now the only
     * thing asserting it. Worth knowing if a third administration-owned setting is ever
     * added: it belongs in this describe, behind `requireAdministration`, with a test here.
     */
    it('refuses a department its own acknowledgement deadlines', async () => {
      const res = await call('PUT', '/admin/sla', rescueToken, {
        departmentId: rescueDept,
        severity: 'critical',
        ackMinutes: 600,
      });
      expect(res.status).toBe(403);
    });

    it('refuses a department the district performance table', async () => {
      expect((await call('GET', '/admin/performance', rescueToken)).status).toBe(403);
    });

    it('refuses a department a post above station tier', async () => {
      // `evaluateRead` widens at tehsil, so a department granting itself a tehsil post would
      // be granting itself sight of every incident in the district.
      const res = await call('POST', '/roster/posts', rescueToken, {
        title: 'Self-Promoted',
        tier: 'district',
      });
      expect(res.status).toBe(403);
    });

    /**
     * Tier is derived, not chosen — by anybody.
     *
     * The administration can create a post in any department; what it cannot do is make that
     * post district-tier while the department is ordinary, because migration 0010 derives
     * tier from `is_administration` at the database. That is stricter than the API check
     * above it, deliberately: a tier that drifts out of step with the office it belongs to is
     * a silent widening of who may read what, and one enforcement point beats two.
     */
    it('gives an ordinary post-tier designation even when the DC asks for district', async () => {
      const res = await call('POST', '/roster/posts', dcToken, {
        title: `Coordinator ${RUN}`,
        tier: 'district',
      });
      expect(res.status).toBe(201);
      expect(res.body['tier']).toBe('post');
    });

    /**
     * 🔴 **WAS *"gives an administrative office district-tier posts without being asked"* —
     * ADR-0030, and the rule it asserted did not go away, it moved.**
     *
     * It read `GET /admin/departments`, took the first office with `isAdministration`, and added
     * a post to it. That list answers **empty** now and the office it looked for does not exist,
     * so the test failed on `undefined.departmentId` — a fixture fault hiding a real question:
     * *what makes a post district-tier, now that no post belongs to an office?*
     *
     * ⚠️ **The tick on the contact, and nothing else.** Which is a narrower door than the one it
     * replaced, deliberately: `is_administration` is the only thing left between a designation
     * and sight of every incident in Bajaur, and it is granted one row at a time on the contact
     * screen — never as a side effect of where a post was filed. So the roster route can no
     * longer mint a district-tier post **for anybody, including the DC**, and that half is
     * asserted here rather than assumed.
     */
    it('makes a post district-tier from the tick on the contact, and from nothing else', async () => {
      const plain = await call('POST', '/roster/posts', dcToken, {
        title: `Additional Officer ${RUN}`,
      });
      expect(plain.status).toBe(201);
      expect(plain.body['tier']).toBe('post');

      const ticked = await call('POST', '/roster/contacts', dcToken, {
        fullName: 'Assistant Commissioner Headquarter',
        designation: `AC Headquarter (roster ${RUN})`,
        phone: `0300${RUN}22`,
        isAdministration: true,
      });
      expect(ticked.status).toBe(201);
      expect(ticked.body['isAdministration']).toBe(true);

      // Asserted at the database, because that is where the rule lives: the trigger derives
      // `tier` and overwrites whatever any caller asked for.
      const tier = await pool.query<{ tier: string }>('SELECT tier FROM seat WHERE seat_id = $1', [
        ticked.body['seatId'],
      ]);
      expect(tier.rows[0]?.tier).toBe('district');
    });
  });

  //----------------------------------------------------------------------------
  // A contact is not an account
  //----------------------------------------------------------------------------

  describe('adding somebody, and separately giving them a login', () => {
    it('adds a person with no account at all', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Contact Only',
        phone: `0300${RUN}03`,
      });
      expect(person.status).toBe(201);
      // The district's list is ~80 officials the system must be able to notify. That is not
      // ~80 people who should have credentials.
      expect(person.body['hasAccount']).toBe(false);
    });

    it('grants a login as a separate, deliberate act', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Gets A Login',
        phone: `0300${RUN}04`,
      });
      const personId = person.body['personId'] as string;

      const granted = await call('POST', `/roster/people/${personId}/account`, dcToken, {
        password: 'a-real-password-2026',
      });
      expect(granted.status).toBe(200);

      const login = await call('POST', '/auth/login', null, {
        phone: `0300${RUN}04`,
        password: 'a-real-password-2026',
      });
      expect(login.status).toBe(200);
    });

    it('refuses a password short enough to guess', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Weak Password',
        phone: `0300${RUN}05`,
      });
      const res = await call(
        'POST',
        `/roster/people/${person.body['personId'] as string}/account`,
        dcToken,
        { password: 'short' },
      );
      expect(res.status).toBe(400);
    });

    /**
     * Migration 0006 put phone uniqueness only where a password hash exists: a shared office
     * handset is ordinary for a contact and impossible for an account, because "who is
     * signing in?" must have exactly one answer. This is that boundary from the roster side.
     */
    it('refuses a second login on a shared handset, loudly and at the right moment', async () => {
      const shared = `0300${RUN}99`;
      const first = await call('POST', '/roster/people', dcToken, {
        fullName: 'Shares A Handset A',
        phone: shared,
      });
      const second = await call('POST', '/roster/people', dcToken, {
        fullName: 'Shares A Handset B',
        phone: shared,
      });
      // Both load as contacts. The handset is genuinely shared (Q-19).
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const a = await call(
        'POST',
        `/roster/people/${first.body['personId'] as string}/account`,
        dcToken,
        { password: 'a-real-password-2026' },
      );
      expect(a.status).toBe(200);

      const b = await call(
        'POST',
        `/roster/people/${second.body['personId'] as string}/account`,
        dcToken,
        { password: 'another-real-password-2026' },
      );
      expect(b.status).toBe(409);
      expect(String(b.body['error'])).toContain('shared handset');
    });
  });

  //----------------------------------------------------------------------------
  // Placeholders
  //----------------------------------------------------------------------------

  describe('placeholder numbers (R-01)', () => {
    it('fills a post while still counting it as unreachable', async () => {
      const post = await call('POST', '/roster/posts', dcToken, {
        title: `Awaiting A Number ${RUN}`,
      });
      await call('POST', '/roster/people', dcToken, {
        fullName: 'Number To Follow',
        phone: `1111111-${RUN}`,
        placeholder: true,
        seatId: post.body['seatId'],
      });

      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as {
        title: string;
        holder: { placeholder: boolean } | null;
      }[];
      const filled = posts.find((p) => p.title === `Awaiting A Number ${RUN}`);

      // The post is held — and the holder says the number is a stand-in, so nothing on any
      // screen reads as though this post can be reached.
      expect(filled?.holder?.placeholder).toBe(true);
      expect(Number(roster.body['unreachablePosts'])).toBeGreaterThan(0);
    });

    /**
     * The way a placeholder is meant to end.
     *
     * Clearing the flag automatically, rather than requiring a second deliberate action, is
     * the whole point: a placeholder that somebody forgets to clear is a post that silently
     * stops escalating, and nobody who typed a real number into a form would ever think to
     * go and clear a flag afterwards.
     */
    it('stops being a placeholder the moment a real number is typed over it', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Real Number Coming',
        phone: `1111111-${RUN}-b`,
        placeholder: true,
      });
      const personId = person.body['personId'] as string;

      const updated = await call('PATCH', `/roster/people/${personId}`, dcToken, {
        phone: `0300${RUN}77`,
      });
      expect(updated.status).toBe(200);
      expect(updated.body['placeholder']).toBe(false);
    });

    it('refuses an account on a placeholder number', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Placeholder Account Attempt',
        phone: `1111111-${RUN}-c`,
        placeholder: true,
      });
      const res = await call(
        'POST',
        `/roster/people/${person.body['personId'] as string}/account`,
        dcToken,
        { password: 'a-real-password-2026' },
      );
      // An account nobody can be told about, reachable at a number that is not theirs.
      expect(res.status).toBe(409);
      expect(String(res.body['error'])).toContain('real number');
    });
  });

  //----------------------------------------------------------------------------
  // Handovers, and what they must not erase
  //----------------------------------------------------------------------------

  describe('handovers', () => {
    it('moves a post to a new holder and ends the old assignment', async () => {
      const post = await call('POST', '/roster/posts', dcToken, {
        title: `Handover Post ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;

      const outgoing = await call('POST', '/roster/people', dcToken, {
        fullName: 'Outgoing Officer',
        phone: `0300${RUN}11`,
        seatId,
      });
      const incoming = await call('POST', '/roster/people', dcToken, {
        fullName: 'Incoming Officer',
        phone: `0300${RUN}12`,
      });

      const moved = await call('POST', `/roster/posts/${seatId}/assign`, dcToken, {
        personId: incoming.body['personId'],
      });
      expect(moved.status).toBe(200);

      const roster = await call('GET', '/roster', dcToken);
      const posts = roster.body['posts'] as {
        seatId: string;
        holder: { fullName: string } | null;
      }[];
      expect(posts.find((p) => p.seatId === seatId)?.holder?.fullName).toBe('Incoming Officer');

      // The outgoing officer's dates stay in the record. A handover with no history is how
      // "who was on duty that night" becomes unanswerable (ADR-0004).
      const past = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM duty_assignment WHERE person_id = $1 AND to_at IS NOT NULL',
        [outgoing.body['personId']],
      );
      expect(Number(past.rows[0]!.n)).toBe(1);
    });

    it('will not relieve somebody without a reason', async () => {
      const post = await call('POST', '/roster/posts', dcToken, {
        title: `Reasonless Relief ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;
      await call('POST', '/roster/people', dcToken, {
        fullName: 'Will Stay Put',
        phone: `0300${RUN}13`,
        seatId,
      });

      // This is the change most likely to be asked about afterwards: who took the duty
      // officer off that post the week nobody answered?
      expect((await call('POST', `/roster/posts/${seatId}/relieve`, dcToken, {})).status).toBe(400);
    });

    it('retiring a post takes its holder off it, so nothing is notified into a void', async () => {
      const post = await call('POST', '/roster/posts', dcToken, {
        title: `Short-Lived Post ${RUN}`,
      });
      const seatId = post.body['seatId'] as string;
      await call('POST', '/roster/people', dcToken, {
        fullName: 'Briefly Posted',
        phone: `0300${RUN}14`,
        seatId,
      });

      const retired = await call('POST', `/roster/posts/${seatId}/retire`, dcToken, {
        reason: 'post abolished after the season',
      });
      expect(retired.status).toBe(200);
      expect(retired.body['holder']).toBeNull();
    });

    it('will not let somebody remove themselves', async () => {
      const me = await call('GET', '/auth/me', dcToken);
      const personId = (me.body['identity'] as { personId: string }).personId;

      // For the last administrator this would leave the district with nobody able to undo
      // it, and for anybody it ends their own session mid-request.
      const res = await call('POST', `/roster/people/${personId}/remove`, dcToken, {
        reason: 'testing',
      });
      expect(res.status).toBe(409);
    });

    it('removing somebody keeps them in the record and out of the roster', async () => {
      const person = await call('POST', '/roster/people', dcToken, {
        fullName: 'Transferred Away',
        phone: `0300${RUN}15`,
      });
      const personId = person.body['personId'] as string;

      const removed = await call('POST', `/roster/people/${personId}/remove`, dcToken, {
        reason: 'transferred out of the district',
      });
      expect(removed.status).toBe(200);

      const roster = await call('GET', '/roster', dcToken);
      const names = (roster.body['people'] as { fullName: string }[]).map((p) => p.fullName);
      expect(names).not.toContain('Transferred Away');

      // Still there, so every event naming them keeps resolving to a name (ADR-0001).
      const still = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM person WHERE person_id = $1',
        [personId],
      );
      expect(Number(still.rows[0]!.n)).toBe(1);
    });
  });

  //----------------------------------------------------------------------------
  // The thing the roster is for
  //----------------------------------------------------------------------------

  describe('what the roster actually buys', () => {
    /**
     * The whole point, end to end: an emergency reaches a department, the notifier looks for
     * somebody to tell, and finds them **because a human typed them in on a screen**.
     */
    /**
     * 🔴 **THE MECHANISM CHANGED UNDER THIS TEST TWICE, AND THE CLAIM HAS NOT MOVED ONCE.**
     *
     * It was: seed a routing signal, let intake pick the department, watch the in-app inbox.
     * Then ADR-0022 removed signals and it became: route the incident to a department by hand.
     * ADR-0030 removed departments, so `dutySeatFor` answers `null` for every one of them — the
     * obligation named nobody, the stub failed it, and **the test went red on its second half
     * while its first half passed for the wrong reason.**
     *
     * ⚠️ It is a **post** that is told now, chosen by the control room on `dispatch-to`. That is
     * the whole of ADR-0024 and ADR-0030 arriving here: there is no layer between the emergency
     * and the officer, so the thing a human types in on a screen is the thing that gets the
     * message. Which is what this test always said.
     *
     * The stub goes in through `whatsappChannel` rather than into a later `runNotifyPass`,
     * because **`dispatch-to` notifies inside the request** (M6-04) — the operator is on the
     * telephone. A pass run afterwards would find the obligation already settled, and settled as
     * `no_channel` on a district with no WhatsApp account, which would prove nothing about the
     * roster at all.
     */
    it('a person added from the roster becomes the one who gets notified', async () => {
      /**
       * A stub standing where WhatsApp stands in Bajaur, recording who it was handed.
       *
       * It used to be the in-app inbox that proved this, and that channel is **gone**
       * (ADR-0018) — nobody outside the control room signs in. What the test asserts is
       * unchanged and is the only thing that ever mattered: before a human types a name on
       * a screen there is nobody to send to, and afterwards there is.
       */
      const told: (string | null)[] = [];
      const whatsapp: NotificationChannel = {
        name: 'whatsapp',
        deliver: async (t) => {
          told.push(t.seatId);
          /**
           * Faithful to the real channel on the one point this test turns on: `numberFor`
           * resolves a **handset**, from the person holding the post, and a post nobody holds
           * has no number to send to. So the stub asks the roster the same question, rather
           * than answering "sent" — which would pass whether or not anybody had ever been
           * added, and that is the whole claim under test.
           */
          if (t.personId !== null) return { ok: true as const };
          if (t.seatId === null) {
            return { ok: false as const, failure: 'no_addressee: this obligation names nobody' };
          }
          const holder = await pool.query(
            `SELECT 1 FROM duty_assignment d
               JOIN person p ON p.person_id = d.person_id AND p.removed_at IS NULL
              WHERE d.seat_id = $1 AND d.to_at IS NULL`,
            [t.seatId],
          );
          return (holder.rowCount ?? 0) > 0
            ? { ok: true as const }
            : { ok: false as const, failure: 'no_duty_holder: nobody currently holds this post' };
        },
      };

      const notifying = createSyncServer({
        pool,
        authMode: 'stub',
        nodeEnv: 'test',
        whatsappChannel: whatsapp,
      });
      await new Promise<void>((r) => notifying.listen(0, '127.0.0.1', r));
      const notifyingBase = `http://127.0.0.1:${(notifying.address() as AddressInfo).port}`;

      const dispatchTo = async (incidentId: string, seatId: string): Promise<void> => {
        const res = await fetch(`${notifyingBase}/incidents/${incidentId}/dispatch-to`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${dcToken}` },
          body: JSON.stringify({
            targets: [{ kind: 'post', id: seatId }],
            reason: `roster notify ${RUN}`,
          }),
        });
        expect(res.status).toBe(200);
      };

      try {
        // The post exists on the roster and nobody holds it. This is the vacancy the district
        // sees on the console, and it is the state an emergency must not disappear into.
        const post = await call('POST', '/roster/posts', dcToken, {
          title: `Duty Officer ${RUN}`,
        });
        expect(post.status).toBe(201);
        const seatId = post.body['seatId'] as string;

        const before = await call('POST', '/incidents', dcToken, {
          category: `roster-notify-${RUN}`,
        });
        await dispatchTo(before.body['incidentId'] as string, seatId);
        const beforeState = foldIncident(
          before.body['incidentId'] as string,
          await loadIncident(pool, before.body['incidentId'] as string),
        );
        expect(beforeState.notifications[0]?.state).toBe('failed');
        // And it says **why**, in the words the control room needs — not "delivery failed" but
        // "nobody holds this post". One sends somebody to the console; the other sends them
        // looking for a network fault that does not exist.
        expect(beforeState.notifications[0]?.failure).toContain('no_duty_holder');

        // The administration staffs it from the console.
        const added = await call('POST', '/roster/people', dcToken, {
          fullName: 'Now There Is Somebody',
          phone: `0300${RUN}88`,
          seatId,
        });
        expect(added.status).toBe(201);

        const after = await call('POST', '/incidents', dcToken, {
          category: `roster-notify-${RUN}`,
        });
        await dispatchTo(after.body['incidentId'] as string, seatId);
        const afterState = foldIncident(
          after.body['incidentId'] as string,
          await loadIncident(pool, after.body['incidentId'] as string),
        );
        expect(afterState.notifications[0]?.state).not.toBe('failed');

        // Handed the same post both times — and the only thing that changed between them is
        // that a human typed a name and a number onto it. The addressee is identical; the
        // outcome is not, which is the whole claim.
        expect(told).toEqual([seatId, seatId]);
      } finally {
        await new Promise<void>((r) => notifying.close(() => r()));
      }
    });

    it('records every roster change with who made it and why', async () => {
      const res = await call('GET', '/admin/history', dcToken);
      const changes = res.body as unknown as {
        subject: string;
        action: string;
        reason: string | null;
      }[];

      expect(changes.some((c) => c.subject === 'seat')).toBe(true);
      expect(changes.some((c) => c.subject === 'person')).toBe(true);
      // Anything that stops somebody being reachable carries its reason.
      const retire = changes.find((c) => c.subject === 'person' && c.action === 'retired');
      expect(retire?.reason).toBeTruthy();
    });

    it('never writes a contact number into the configuration log', async () => {
      // `config_event` is rendered on a screen and copied into every backup. The person row
      // is the one place a number needs to live, and `obs/log.ts` already keeps one out of
      // a log line — this is the same rule, one table over.
      const leaked = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM config_event
          WHERE (after::text LIKE $1 OR before::text LIKE $1)`,
        [`%0300${RUN}%`],
      );
      expect(Number(leaked.rows[0]!.n)).toBe(0);
    });
  });

  /**
   * ⚠️ **Was *"a department officer sees their own roster after signing in fresh"* — 2026-08-22.**
   *
   * Belt and braces on the scoping, and it stays that: a **real login**, not a seeded token,
   * because a rule that only holds for tokens this file mints is a rule that holds nowhere. What
   * flipped is the expected answer.
   *
   * The district's decision is that no department will ever hold an account. This is the test
   * that would notice if one did and still got in — the refusal has to survive a genuine
   * sign-in, not merely a synthetic identity.
   */
  it('refuses a department officer their own roster, even on a fresh real login', async () => {
    const person = await pool.query<{ phone: string }>(
      `SELECT p.phone FROM person p
         JOIN duty_assignment d ON d.person_id = p.person_id AND d.to_at IS NULL
         JOIN seat s ON s.seat_id = d.seat_id
        WHERE s.title = $1`,
      [`Rescue Duty (roster ${RUN})`],
    );
    const login = await call('POST', '/auth/login', null, {
      phone: person.rows[0]!.phone,
      password: TEST_PASSWORD,
    });
    // Signing in still works — they are a real officer. It buys them no roster.
    expect(login.status).toBe(200);

    const roster = await call('GET', '/roster', login.body['token'] as string);
    expect(roster.status).toBe(403);
  });
});
