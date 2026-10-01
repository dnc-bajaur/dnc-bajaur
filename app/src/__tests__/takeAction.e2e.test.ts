/**
 * **Take action, on a real screen — Phase 8c, 2026-08-21.**
 *
 * ## Why this file is the one that matters for the whole of 8a–8c
 *
 * Phase 8a deleted the escalation's message at the district's request. Phase 8b built the chase
 * the room was given in its place. **Both are proved by `api/__tests__` and neither could be
 * reached by a person**, because the incident screen had no button — which is this repository's
 * own standing lesson (*an endpoint with no door is an endpoint nobody has checked*) and is
 * exactly what the district reported:
 *
 * > *"control room wale ke paas koi option nahi hota — na escalation bhej sakta hai, na follow up
 * > le sakta hai."*
 *
 * So the assertions here are about **the door**: does it appear, does it say what it will do
 * before it does it, and does it say what happened afterwards.
 *
 * ## 🔴 Test 1 is a sentence, and that is not a soft assertion
 *
 * *Escalate* now **messages nobody**. That is the opposite of what the word promises, and an
 * operator who presses it believing a telephone rings somewhere has been misled by their own
 * software at 02:00. The confirmation carrying that sentence is the whole safety of the button,
 * and it is precisely the kind of prose a later tidy-up shortens.
 *
 * ## What is deliberately NOT asserted here
 *
 * The wording of a **refusal** — those come from the server and are pinned in
 * `api/__tests__/escalate.test.ts` and `followUp.test.ts`, where they belong. A browser test that
 * also pinned them would fail twice for one change and teach nobody anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  seedDepartment,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('Phase 8c: take action, from the incident', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  /** District tier — `incident.escalation` and `incident.closure` are both district overrides. */
  let controlRoom: TestActor;
  /** Where an emergency sits, so the ladder has a rung to climb from. */
  let rescue: string;
  /** Somebody to have been told, so *Follow up* has something to follow up on. */
  let dutyOfficer: TestActor;

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Every screen this suite drives, made available first — ADR-0016, M6-45.
    await enableAllCapabilities(pool);

    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    controlRoom = await seedActor(pool, {
      title: `Take Action Control Room ${Date.now()}`,
      tier: 'district',
    });
    rescue = await seedDepartment(pool, `Rescue (8c ${Date.now()})`);
    dutyOfficer = await seedActor(pool, {
      title: `Duty Officer (8c ${Date.now()})`,
      departmentId: rescue,
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', controlRoom.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  /** An emergency, through the real route, in the signed-in seat's own session. */
  async function seedIncident(marker: string): Promise<string> {
    const created = await page.evaluate(async (description: string) => {
      const res = await fetch('/incidents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'fire', severity: 'high', description }),
      });
      return (await res.json()) as { incidentId: string };
    }, marker);
    return created.incidentId;
  }

  /**
   * Give it to a department, the way the control room does.
   *
   * `incident.responsibleDepartment` is owned by nobody, so a district seat is always an
   * overrider here and ADR-0003 requires a reason — which is why one is sent rather than
   * discovered as a 403.
   */
  async function routeTo(incidentId: string, departmentId: string): Promise<void> {
    await page.evaluate(
      async ([id, dept]: [string, string]) => {
        await fetch(`/incidents/${id}/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ departmentIds: [dept], reason: 'take-action e2e' }),
        });
      },
      [incidentId, departmentId] as [string, string],
    );
  }

  /**
   * Tell somebody, so there is something to follow up **on**.
   *
   * `/dispatch-to` writes the event the fold reads and needs no WhatsApp account, which is what
   * lets this suite reach an **enabled** *Follow up* button while `config` is null.
   */
  async function dispatchTo(incidentId: string, personId: string): Promise<void> {
    await page.evaluate(
      async ([id, person]: [string, string]) => {
        await fetch(`/incidents/${id}/dispatch-to`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targets: [{ kind: 'person', id: person }] }),
        });
      },
      [incidentId, personId] as [string, string],
    );
  }

  /**
   * **`#detailView:not([hidden]) #detailTiles .d-tile`, not `.value` — 2026-09-05.**
   *
   * This suite's own selector was left pointing at `#detailQuick`'s `.value` rows from before
   * the `dnc-shell-v212` drawer redesign (2026-09-04), which moved that reading onto the tiles
   * and left `#detailQuick` permanently `hidden` (still populated, never shown — see
   * `web/index.html`'s `#detailQuick`). Every test in this file hung for the full 30s on that
   * `waitForSelector` — `hidden` fails Playwright's default `visible` wait, so it never resolved
   * and never threw. `detail.e2e.test.ts`'s own `openDetail` was updated for the same redesign
   * at the time; this file's copy was missed. Matched to that file's selector rather than
   * invented fresh, so the two cannot drift apart the same way twice.
   */
  async function openDetail(id: string): Promise<void> {
    await page.evaluate(async (target: string) => {
      const dnc = (globalThis as unknown as { __dnc: { openDetail(x: string): Promise<void> } })
        .__dnc;
      await dnc.openDetail(target);
    }, id);
    await page.waitForSelector('#detailView:not([hidden]) #detailTiles .d-tile');
    // The panel is a lazy bundle, so it lands a beat after the record does.
    await page.waitForSelector('#takeActionRows .takeacts', { timeout: 15_000 });
  }

  /**
   * Answer the next dialogs in order, and record what each one asked.
   *
   * One listener for the whole queue rather than a `page.once` per dialog — two `once`
   * listeners both fire on the first, and the second `accept()` then throws against one already
   * handled. `withdrawal.e2e.test.ts` and `roster.e2e.test.ts` carry the same helper and the
   * same warning.
   *
   * ⚠️ **A confirm and a prompt are both dialogs here**, so an act that states its consequence
   * and then asks a question consumes **two** entries.
   */
  function answer(replies: readonly (string | true | null)[]): string[] {
    const messages: string[] = [];
    const pending = [...replies];
    const handler = (dialog: {
      message(): string;
      accept(v?: string): Promise<void>;
      dismiss(): Promise<void>;
    }): void => {
      messages.push(dialog.message());
      const next = pending.shift();
      if (next === undefined || next === null) void dialog.dismiss();
      else void dialog.accept(next === true ? undefined : next);
      if (pending.length === 0) page.off('dialog', handler);
    };
    page.on('dialog', handler);
    return messages;
  }

  const escalationsOn = async (incidentId: string): Promise<number> =>
    page.evaluate(async (id: string) => {
      const res = await fetch(`/incidents/${id}`);
      const body = (await res.json()) as { state: { escalationCount: number } };
      return body.state.escalationCount;
    }, incidentId);

  it('1. says Escalate messages nobody, before it does anything — and backing out records nothing', async () => {
    /**
     * 🔴 **The sentence this phase turns on.** Since 8a an escalation reaches no handset, at the
     * district's own instruction, and the button's name says the opposite. If this assertion is
     * ever loosened, the software is misleading a control room about whether help is coming.
     */
    const id = await seedIncident(`8c escalate cancel ${Date.now()}`);
    await routeTo(id, rescue);
    await openDetail(id);

    const before = await escalationsOn(id);
    const messages = answer([null]); // dismissed at the confirmation

    await page.click('#take-escalate');
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBe(1);

    expect(messages[0]).toMatch(/MESSAGES NOBODY/);
    expect(messages[0]).toMatch(/MARKS THE BOARD/);
    // And it names the button that does reach a person, rather than leaving them stuck.
    expect(messages[0]).toMatch(/Follow up/);

    await page.waitForTimeout(300);
    expect(await escalationsOn(id)).toBe(before);
  });

  it('2. escalates with a reason, and says on the screen that nobody was messaged', async () => {
    const id = await seedIncident(`8c escalate do ${Date.now()}`);
    await routeTo(id, rescue);
    await openDetail(id);

    // The confirmation, then the reason.
    const messages = answer([true, 'Two hours, no answer from Rescue']);
    await page.click('#take-escalate');
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBe(2);
    expect(messages[1]).toMatch(/Why should this go up/);

    await expect.poll(() => escalationsOn(id), { timeout: 15_000 }).toBe(1);

    /**
     * ⚠️ **The outcome survives the repaint the act itself caused.** A success reloads the
     * incident, which redraws this panel — so without `carried` in `dispatch.ts` the sentence is
     * painted and destroyed in the same tick, and the operator sees nothing at the moment the
     * panel has most to report.
     */
    /**
     * ⚠️ **Waited for the REPAINT, then read once — never polled.**
     *
     * A poll is satisfied by the paint that happens *before* the reload lands, so it goes green
     * against a panel that wipes its own outcome a tick later — which is exactly the defect
     * `carried` exists to fix, and is how this assertion first passed with that code neutered.
     * `.takecount` is hidden until an escalation exists, so its appearance **is** the repaint.
     */
    await page.waitForSelector('#takeActionRows .takecount:not([hidden])', { timeout: 15_000 });

    expect(await page.textContent('#takeActionRows .takenote')).toMatch(/Nobody was messaged/);

    // And the panel says what the board's own `escalated 1×` does not: nobody was told.
    expect(await page.textContent('#takeActionRows .takecount')).toMatch(/Nobody was messaged/);
  });

  it('3. greys Follow up when nobody was ever told, and says why', async () => {
    /**
     * A disabled button that explains itself, which is `renderTakeAction`'s own rule. There is
     * nothing to follow up **on** here, and the answer is a different act on the same screen —
     * an operator who reads that acts; one who meets a dead button rings a developer.
     */
    const id = await seedIncident(`8c nothing to chase ${Date.now()}`);
    await openDetail(id);

    expect(await page.isDisabled('#take-follow-up')).toBe(true);
    const why = await page.textContent('#takeActionRows .takeheld .takewhy');
    expect(why).toMatch(/Nobody has been told/);
    expect(why).toMatch(/Choose who should know/);
  });

  it('4. will not close before anything is resolved, and un-greys the moment it is', async () => {
    /**
     * `lifecycle.ts` refuses it — *"an incident closed with no recorded outcome is exactly what
     * the closure-completeness metric exists to catch"* — and the panel says so **instead of**
     * offering a button the server will refuse, which is M9-08's rule: a disabled button, never
     * a refused submit.
     */
    const id = await seedIncident(`8c close order ${Date.now()}`);
    await routeTo(id, rescue);
    await openDetail(id);

    expect(await page.isDisabled('#take-close')).toBe(true);
    expect(await page.textContent('#takeActionRows .takeheld:last-of-type .takewhy')).toMatch(
      /Mark it resolved first/,
    );

    /**
     * Resolve it. **Exactly two dialogs** — the confirmation, then the outcome — and no third
     * "why are you recording this on the department's behalf" reason prompt.
     *
     * ⚠️ **That third prompt was real once and is stale since 2026-08-22 — see
     * `domain/authority.ts`'s own note on `defaultRules`.** Department ownership was removed
     * outright that day: `incident.closure`'s owner tier is now `district` itself, so a
     * district seat resolving *any* incident — Rescue-routed or not — is the **owner**, never
     * an overrider, and `evaluateWrite` never asks it for a reason. A third reply here would
     * go unconsumed, `answer`'s handler would never see `pending.length === 0`, and it would
     * stay attached to `page` for the rest of this file's tests — silently double-handling the
     * next test's first dialog. Found exactly that way on 2026-09-05: this file's tests had
     * been hanging outright since the `dnc-shell-v212` drawer redesign (`openDetail`'s
     * selector), which had masked this leak until that selector was fixed and the suite could
     * run its tests for the first time since.
     */
    const messages = answer([true, 'Crew stood down, nothing further']);
    await page.click('#take-resolve');

    await expect
      .poll(async () => page.textContent('#takeActionRows .takenote'), { timeout: 20_000 })
      .toMatch(/Marked resolved/);

    // The confirmation and the outcome.
    expect(messages.length).toBe(2);

    // And Close is now offered rather than explained away.
    await expect.poll(() => page.isDisabled('#take-close'), { timeout: 15_000 }).toBe(false);
  });

  it('5. follows up on ONE press — no confirmation, and nothing to type', async () => {
    /**
     * 🔴 **The owner's instruction of 2026-08-22, and the assertion is THE COUNT OF DIALOGS.**
     *
     * > *"bas Follow Up dabane par direct aik professional follow up msg chala jaye, msg/text
     * > type karna na pare."*
     *
     * Two dialogs stood between a control room and the only button on this screen that reaches a
     * person: a paragraph about Meta's 24-hour window, then a question asking what to say — whose
     * honest answer, on nearly every chase, is *the usual thing*.
     *
     * ⚠️ **Playwright dismisses a dialog nobody is listening for**, so a version of this test
     * with no handler would pass just as happily against a panel that still asks twice. The
     * counting handler **is** the test, and `expect(seen).toEqual([])` is the line to protect.
     *
     * ⚠️ **And this proves the request was actually SENT**, not merely that nothing was asked —
     * a button wired to nothing would also raise no dialog. `config` is null in this suite, so
     * the server refuses **in its own words** and the panel prints them, which is INV-03's rule
     * and happens to be the cheapest available proof that one press reached the endpoint.
     *
     * ⚠️ Test 1 is the bookend and must stay: *Escalate* keeps its confirmation, because that
     * sentence is the only thing telling an operator the word on the button no longer means
     * anybody is coming.
     */
    const id = await seedIncident(`8c one tap chase ${Date.now()}`);
    await routeTo(id, rescue);
    await dispatchTo(id, dutyOfficer.personId);
    await openDetail(id);

    expect(await page.isDisabled('#take-follow-up')).toBe(false);

    const seen: string[] = [];
    const watch = (dialog: { message(): string; dismiss(): Promise<void> }): void => {
      seen.push(dialog.message());
      void dialog.dismiss();
    };
    page.on('dialog', watch);
    try {
      await page.click('#take-follow-up');
      await expect
        .poll(() => page.textContent('#takeActionRows .takenote'), { timeout: 15_000 })
        .toMatch(/WhatsApp is not configured/);
    } finally {
      page.off('dialog', watch);
    }

    expect(seen).toEqual([]);
  });

  it('6. once resolved, Follow up and Escalate ask first — the emergency is already over', async () => {
    /**
     * 🔴 **The gap a control room found on 2026-09-05, on a real alert.**
     *
     * Test 5 proves Follow up is silent and one-tap on a **live** incident, and that silence
     * is exactly wrong once the incident is `resolved`: the officer who pressed it had already
     * been told it was over, and got the same alert a second time. `resolve` and `close` already
     * refuse themselves against their own status (test 4); Follow up and Escalate write no
     * status, so neither had a check — this is the one this suite was missing.
     *
     * Still **offered**, not greyed — the owner's decision was that the control room keeps the
     * choice, informed rather than blocked. So both buttons stay enabled, both dialogs now open
     * with the same sentence, and dismissing either sends nothing.
     */
    const id = await seedIncident(`8c resolved still chased ${Date.now()}`);
    await routeTo(id, rescue);
    await dispatchTo(id, dutyOfficer.personId);
    await openDetail(id);

    const resolveMessages = answer([true, 'Crew stood down, nothing further']);
    await page.click('#take-resolve');
    await expect
      .poll(async () => page.textContent('#takeActionRows .takenote'), { timeout: 20_000 })
      .toMatch(/Marked resolved/);
    expect(resolveMessages.length).toBeGreaterThanOrEqual(1);

    expect(await page.isDisabled('#take-follow-up')).toBe(false);
    expect(await page.isDisabled('#take-escalate')).toBe(false);

    const followMessages = answer([null]); // dismissed — nothing should be sent
    await page.click('#take-follow-up');
    await expect.poll(() => followMessages.length, { timeout: 10_000 }).toBe(1);
    expect(followMessages[0]).toMatch(/already marked resolved/);

    const escalateMessages = answer([null]); // dismissed at the confirmation
    await page.click('#take-escalate');
    await expect.poll(() => escalateMessages.length, { timeout: 10_000 }).toBe(1);
    expect(escalateMessages[0]).toMatch(/already marked resolved/);
    expect(escalateMessages[0]).toMatch(/MESSAGES NOBODY/);
  });
});
