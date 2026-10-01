/**
 * The M0 gate.
 *
 * One emergency, reported on a handset with no network, all the way to a closed incident
 * with a complete audit trail. Every layer is real: a real Chromium with real IndexedDB,
 * the browser's network genuinely cut by the driver rather than a flag, the real HTTP
 * sync server, and real PostgreSQL.
 *
 * If this test passes, the central claim of the project holds. If it does not, nothing
 * else in the system matters — see backlog/milestones.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { append, loadIncident } from '../db/eventStore.js';
import { foldIncident } from '../domain/incident.js';
import { evaluateWrite, defaultRules } from '../domain/authority.js';
import { checkEscalation } from '../domain/sla.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';
import type { IncidentEvent } from '../domain/events.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, '..', 'outbox', 'adapters', '__tests__', 'browser-harness.ts');
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

const RESCUE = randomUUID();
const RESCUE_DUTY_SEAT = randomUUID();
const CONTROL_ROOM_SEAT = randomUUID();

describe.skipIf(dbUrl === undefined)('M0 gate: the offline emergency spine', () => {
  let pool: Pool;
  let api: Server;
  let apiUrl: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let bundle: string;
  let incidentId: string;
  let reportEventId: string;
  let actor: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();

    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Every screen this suite drives, made available first — ADR-0016, M6-45. A fresh
    // installation offers the control room and nothing else, so a test asserting a screen
    // works has to turn it on, and this is the visible act of doing so.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const built = await build({
      entryPoints: [harness],
      bundle: true,
      format: 'iife',
      globalName: 'DNC',
      write: false,
      platform: 'browser',
      target: 'chrome110',
    });
    bundle = built.outputFiles[0]!.text;

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    // Load the real app, not a bare page. The service worker it registers is what makes
    // step 4 — reopening the handset with no network — possible at all.
    //
    // `state: 'attached'` rather than the default `visible`: `#reportView` starts collapsed
    // behind its own "Report an emergency" link for a signed-out visitor since 2026-09-09
    // (see `reportRevealed` in `main.ts`), so `#report` is real but not on screen at this
    // point. This gate drives the outbox directly through the harness below and never clicks
    // the visible form, so attached is all the readiness this check needs to prove.
    await page.goto(apiUrl);
    await page.waitForSelector('#report', { state: 'attached', timeout: 20_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
      timeout: 20_000,
    });

    // The harness rides on top of the real app, adding only what the test needs to drive
    // the outbox directly.
    await page.addScriptTag({ content: bundle });

    // Sign in through the real login endpoint so the session cookie is set on the origin.
    // The transport then carries it automatically, exactly as it does on a handset — there
    // is no test-only way past authentication, which is the point of INV-05.
    actor = await seedActor(pool, { title: 'Rescue 1122 Duty Officer', departmentId: RESCUE });
    const loggedIn = await page.evaluate(
      async ([phone, password]) => {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        });
        return res.ok;
      },
      [actor.phone, TEST_PASSWORD],
    );
    if (!loggedIn) throw new Error('browser login failed');

    incidentId = randomUUID();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  async function inject(): Promise<void> {
    await page.addScriptTag({ content: bundle });
  }

  it('1. a report is captured with the network genuinely down', async () => {
    await context.setOffline(true);

    const result = await page.evaluate(
      async ([url, incident]) => {
        const store = await DNC.openStore('spine');
        const outbox = DNC.makeRealOutbox(store, url!);
        const draft = DNC.reportDraft(
          incident!,
          'RTA on Khar-Nawagai road, 2 casualties',
          'critical',
        );
        const event = await outbox.enqueue(draft);
        const sync = await outbox.sync();
        const pending = await outbox.pendingCount();
        store.close();
        return { eventId: event.eventId, offline: sync.offline, pushed: sync.pushed, pending };
      },
      [apiUrl, incidentId],
    );

    reportEventId = result.eventId;

    // Saved, explicitly not delivered. The operator must never be told otherwise.
    expect(result.offline).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.pending).toBe(1);
  });

  it('2. nothing reached the server', async () => {
    expect(await loadIncident(pool, incidentId)).toHaveLength(0);
  });

  it('3. it is committed to storage, not held in memory — verified while still offline', async () => {
    // A fresh IndexedDB connection, opened with the network still down. If the entry were
    // living in a JS variable rather than on disk, this would come back empty.
    const survived = await page.evaluate(async () => {
      const store = await DNC.openStore('spine');
      const all = await store.all();
      store.close();
      return all.map((e) => ({ id: e.event.eventId, state: e.state }));
    });

    expect(survived).toHaveLength(1);
    expect(survived[0]!.id).toBe(reportEventId);
    expect(survived[0]!.state).toBe('pending');
  });

  it('4. it survives the handset being closed and reopened, still with no network', async () => {
    // The real scenario, now that M0-12 has landed: the browser is closed during a
    // shutdown and reopened before signal returns. The service worker serves the shell
    // from cache, so the app opens and the queued report is reachable.
    //
    // Before the service worker this reload failed outright with
    // ERR_INTERNET_DISCONNECTED, and this step had to be weakened to restore the network
    // first. It no longer does.
    await page.reload();
    await inject();

    const survived = await page.evaluate(async () => {
      const store = await DNC.openStore('spine');
      const all = await store.all();
      store.close();
      return all.map((e) => ({ id: e.event.eventId, state: e.state }));
    });

    expect(survived).toHaveLength(1);
    expect(survived[0]!.id).toBe(reportEventId);
    expect(survived[0]!.state).toBe('pending');

    // Still nothing on the server: a reload delivers nothing by itself.
    expect(await loadIncident(pool, incidentId)).toHaveLength(0);
  });

  it('5. it delivers itself when signal returns, with no operator action', async () => {
    await context.setOffline(false);

    const result = await page.evaluate(
      async ([url]) => {
        const store = await DNC.openStore('spine');
        const outbox = DNC.makeRealOutbox(store, url!);
        const sync = await outbox.sync();
        const pending = await outbox.pendingCount();
        store.close();
        return { pushed: sync.pushed, offline: sync.offline, pending };
      },
      [apiUrl],
    );

    expect(result.offline).toBe(false);
    expect(result.pushed).toBe(1);
    expect(result.pending).toBe(0);

    /**
     * One: the report the handset was holding.
     *
     * There were two — a routing pass ran the moment it arrived, and the M1 gate is the
     * reason that pass existed on the `/sync` path at all: before it, an emergency captured
     * on a handset reached nobody. ADR-0022 removed the pass, and the hole it was patching is
     * closed differently now: the emergency appears in the control room's queue of things to
     * assign, on both administrative dashboards, rather than being routed by a rule.
     */
    const stored = await loadIncident(pool, incidentId);
    expect(stored.map((e) => e.type)).toEqual(['reported']);
    expect(stored[0]!.eventId).toBe(reportEventId);
  });

  it('6. the delay is recorded honestly, not disguised', async () => {
    const [stored] = await loadIncident(pool, incidentId);
    // occurred_at is when the reporter said it happened; recorded_at is when we learned.
    // The gap is the district's real connectivity picture and must not be flattened.
    expect(Date.parse(stored!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(stored!.occurredAt));

    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: stored!.occurredAt,
      recordedAt: stored!.recordedAt,
      acknowledgedAt: null,
      now: stored!.recordedAt,
    });
    expect(verdict.reason).toBeTruthy();
  });

  it('7. it is triaged and routed to a duty seat', async () => {
    await append(pool, [
      serverEvent('triaged', { severity: 'critical', category: 'rta' }, 2, RESCUE_DUTY_SEAT),
      serverEvent('routed', { departmentIds: [RESCUE], ruleId: 'manual' }, 3, null),
    ]);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.responsibleDepartmentIds).toEqual([RESCUE]);
  });

  it('8. an unacknowledged critical escalates on the server alone', async () => {
    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    const verdict = checkEscalation({
      severity: 'critical',
      occurredAt: state.occurredAt!,
      recordedAt: state.lastRecordedAt!,
      acknowledgedAt: null,
      // Ten minutes later, with every client closed.
      now: new Date(Date.parse(state.lastRecordedAt!) + 10 * 60_000).toISOString(),
    });

    expect(verdict.shouldEscalate).toBe(true);

    await append(pool, [
      serverEvent(
        'escalated',
        { fromSeatId: RESCUE_DUTY_SEAT, toSeatId: CONTROL_ROOM_SEAT, trigger: 'sla_breach' },
        4,
        null,
      ),
    ]);
  });

  it('9. the duty seat acknowledges and responds', async () => {
    await append(pool, [
      serverEvent('acknowledged', { seatId: RESCUE_DUTY_SEAT }, 5, RESCUE_DUTY_SEAT),
      serverEvent('action_logged', { note: 'ambulance dispatched' }, 6, RESCUE_DUTY_SEAT),
    ]);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.acknowledgedBySeatId).toBe(RESCUE_DUTY_SEAT);
    expect(state.actions).toHaveLength(1);
  });

  it("10. the control room overrides, and the department's own value survives", async () => {
    const rule = defaultRules(RESCUE).find((r) => r.fieldKey === 'incident.severity')!;
    const decision = evaluateWrite(rule, {
      fieldKey: 'incident.severity',
      seat: { seatId: CONTROL_ROOM_SEAT, tier: 'district' },
      reason: 'third reporter confirms four casualties',
    });
    expect(decision.allowed).toBe(true);

    await append(pool, [
      serverEvent(
        'overridden',
        {
          field: 'severity',
          value: 'critical',
          reason: 'third reporter confirms four casualties',
        },
        7,
        CONTROL_ROOM_SEAT,
      ),
    ]);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.severity?.value).toBe('critical');
    // Nobody can be blamed for a figure they did not enter.
    expect(state.severity?.overriddenFrom?.setBy.seatId).toBe(RESCUE_DUTY_SEAT);
    expect(state.severity?.overriddenFrom?.reason).toMatch(/four casualties/);
  });

  it('11. it resolves and closes', async () => {
    await append(pool, [
      serverEvent('resolved', { outcome: 'casualties shifted to DHQ Bajaur' }, 8, RESCUE_DUTY_SEAT),
      serverEvent('closed', { notes: 'road cleared, handed to C&W' }, 9, RESCUE_DUTY_SEAT),
    ]);

    const state = foldIncident(incidentId, await loadIncident(pool, incidentId));
    expect(state.status).toBe('closed');
    expect(state.resolution).toMatch(/DHQ Bajaur/);
  });

  it('12. the whole chain is reconstructable, in order, with every actor named', async () => {
    const events = await loadIncident(pool, incidentId);

    /**
     * **One `routed` event, and it is the control room's own decision.**
     *
     * There were two. The first was the automatic pass that ran when the report arrived
     * through `/sync` — the fix the M1 gate forced, without which a handset's emergency
     * reached nobody — and keeping the two apart was how the record answered which of them
     * actually sent help. ADR-0022 removed the pass, so that question has one answer and the
     * chain is one event shorter.
     */
    expect(events.map((e) => e.type)).toEqual([
      'reported',
      'triaged',
      'routed',
      'escalated',
      'acknowledged',
      'action_logged',
      'overridden',
      'resolved',
      'closed',
    ]);

    // Every state transition names the seat that made it (INV-06).
    const attributed = events.filter((e) => e.type !== 'reported' && e.type !== 'routed');
    for (const e of attributed) {
      if (e.type === 'escalated') continue; // system-triggered
      expect(e.actorSeatId).toBeTruthy();
    }
  });

  it('13. the history cannot be rewritten, even now that it is closed', async () => {
    await expect(
      pool.query(`UPDATE incident_event SET payload = '{}'::jsonb WHERE incident_id = $1`, [
        incidentId,
      ]),
    ).rejects.toThrow(/append-only/i);

    expect(await loadIncident(pool, incidentId)).toHaveLength(9);
  });

  it('14. any past moment can be reconstructed as it was seen then', async () => {
    const events = await loadIncident(pool, incidentId);
    const beforeOverride = events.find((e) => e.type === 'overridden')!;

    const asItWas = foldIncident(incidentId, events, {
      happenedBy: new Date(Date.parse(beforeOverride.occurredAt) - 1).toISOString(),
    });

    expect(asItWas.status).not.toBe('closed');
    expect(asItWas.severity?.overriddenFrom).toBeUndefined();
  });

  function serverEvent(
    type: string,
    payload: Record<string, unknown>,
    clientSeq: number,
    seatId: string | null,
  ): IncidentEvent {
    return {
      eventId: randomUUID(),
      incidentId,
      type,
      occurredAt: new Date(Date.now() + clientSeq * 1000).toISOString(),
      recordedAt: new Date().toISOString(),
      clientSeq,
      actorPersonId: seatId === null ? null : randomUUID(),
      actorSeatId: seatId,
      sourceChannel: seatId === null ? 'system' : 'web',
      payload,
    } as unknown as IncidentEvent;
  }
});
