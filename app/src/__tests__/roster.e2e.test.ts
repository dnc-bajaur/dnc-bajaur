/**
 * The roster on a real screen — M1a-10.
 *
 * `api/__tests__/roster.test.ts` proves the endpoints and the scoping. This proves the two
 * things that only exist once something renders them:
 *
 *   1. ~~**A department officer can maintain their own roster**, from their own tab.~~
 *      **Deleted 2026-08-06** with the screen it describes — ADR-0018 leaves no department
 *      officers, and the owner asked for the door to go rather than be hidden. What replaced
 *      it: **the control room maintains every department's roster from the console**, choosing
 *      the department by name from eighty.
 *   2. **A post nothing can reach says so, in words** — empty, or holding a stand-in number.
 *      Both mean an alert sent there is recorded as failed, and both are the reason this
 *      screen exists (ADR-0005, INV-04). **Unchanged**, and it is now the whole point of the
 *      file: the component survived, only its second door went.
 *
 * The end-to-end claim underneath it: Rescue 1122's missing number stops being a thing
 * somebody has to ask a developer for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
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

const RUN = randomUUID().slice(0, 8);

describe.skipIf(dbUrl === undefined)('M1a-10: the roster', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  let dc: TestActor;
  let rescue: TestActor;
  let rescueDept: string;

  /**
   * Answer the next dialogs, in order.
   *
   * Not two `page.once('dialog')` calls. Both are listeners for the same event, so both fire
   * on the **first** dialog — the second `accept()` then throws against an already-handled
   * one, and the flow stalls waiting for a prompt nobody answered. One listener, one queue.
   */
  function answer(replies: readonly (string | true)[]): void {
    const pending = [...replies];
    const handler = (dialog: {
      accept(v?: string): Promise<void>;
      dismiss(): Promise<void>;
    }): void => {
      const next = pending.shift();
      if (next === undefined) void dialog.dismiss();
      else void dialog.accept(next === true ? undefined : next);
      if (pending.length === 0) page.off('dialog', handler);
    };
    page.on('dialog', handler);
  }

  async function signIn(actor: TestActor): Promise<void> {
    await context.clearCookies();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
  }

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
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const dcDept = await seedDepartment(pool, `DC Office (roster e2e ${RUN})`);
    dc = await seedActor(pool, {
      title: `Deputy Commissioner (roster e2e ${RUN})`,
      departmentId: dcDept,
      tier: 'district',
    });

    rescueDept = await seedDepartment(pool, `Rescue (roster e2e ${RUN})`);
    rescue = await seedActor(pool, {
      title: `Rescue Duty (roster e2e ${RUN})`,
      departmentId: rescueDept,
    });

    browser = await chromium.launch();
    context = await browser.newContext();
    page = await context.newPage();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. has no "My department" door left at all', async () => {
    /**
     * **This step used to assert the opposite**, and the inversion is the decision.
     *
     * It read *"offers a department officer their own roster, and not the console"*, signed in
     * as a Rescue officer and clicked `#navMine`. Under ADR-0018 there are no department
     * officers, so on 2026-08-06 the owner had that screen deleted: *"department ko main delete
     * hi karna chah raha hoon, baad mein hum us time ki situation ke sath naye departments le
     * aayenge."*
     *
     * **The roster component is untouched** and every step below still exercises it — the
     * control room reaches every department's roster from the console. One door went, not the
     * thing behind it.
     */
    await signIn(dc);
    await page.waitForSelector('#navAdmin:not([hidden])');

    expect(await page.locator('#navMine').count()).toBe(0);
    expect(await page.locator('#mineView').count()).toBe(0);
  });

  /**
   * ⚠️ **Was *"chosen rather than resolved"* — and there is nothing left to choose between.**
   *
   * The picker filled itself from `GET /admin/departments`, which has answered an empty list
   * since migration 0039 — so the tab rendered **a blank dropdown and nothing under it**, with no
   * error anywhere because every request succeeded, and this test waited thirty seconds for a
   * `<select>` that would never have an option.
   *
   * There is one roster and it is the district's. The claim that replaces *chosen* is the one
   * that now matters on this tab: it opens **on the roster**, not on a control asking which.
   */
  it('2. opens the district’s roster directly, with nothing to choose first', async () => {
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="roster"]');
    await page.waitForSelector('#rosterBody');

    // The control that went, asserted as gone: a picker with one option is still a question,
    // and a question with one answer is the shape this tab had when it was unusable.
    expect(await page.locator('#rosterPicker').count()).toBe(0);

    // `#rosterPanel` keeps its id and `mountRoster` is untouched — see `admin.ts`.
    expect(await page.locator('#rosterPanel').count()).toBe(1);
    expect(await page.textContent('.rostername')).toBeTruthy();
    // Rescue's own officer is still seeded and still holds the post asserted below.
    expect(rescue.seatId).toBeTruthy();
  });

  it('3. lists the post this officer already holds', async () => {
    // `seedActor` creates a seat and puts the officer in it, so the department is never
    // postless here — an earlier version of this test asserted the empty-department message
    // and waited thirty seconds for a state the fixture cannot produce. The "no posts at
    // all" wording is covered from the console in test 9, against a department created with
    // none.
    const posts = await page.locator('.post').count();
    expect(posts).toBeGreaterThan(0);
    expect(await page.locator('.post .pname').first().textContent()).toBeTruthy();
  });

  it('4. a department adds its own post, and the post says nobody holds it', async () => {
    await page.fill('.addpost .tt', `Station Officer ${RUN}`);
    await page.click('.addpost button');

    const card = page.locator('.post', { hasText: `Station Officer ${RUN}` });
    await card.waitFor();

    // The gap the roster exists to close, named on the card rather than left to be worked
    // out from a blank space.
    expect(await card.locator('.nobody').textContent()).toContain('reaches no one');
  });

  it('5. a department adds its own person and puts them in the post', async () => {
    await page.fill('.addperson .pn', 'Station Officer On Duty');
    await page.fill('.addperson .pp', `0300${RUN}21`);
    await page.selectOption('.addperson .ps', { label: `Station Officer ${RUN}` });
    await page.click('.addperson button');

    const card = page.locator('.post', { hasText: `Station Officer ${RUN}` });
    await card.locator('.holder').waitFor();

    expect(await card.locator('.pname').textContent()).toBe('Station Officer On Duty');
    // Added as a contact, not as an account. Those are separate decisions.
    expect(await card.locator('.holder .tag').count()).toBe(0);
    expect(await page.locator('.unreachable').count()).toBe(0);
  });

  it('6. a stand-in number fills the post and still reads as unreachable (R-01)', async () => {
    await page.fill('.addpost .tt', `Awaiting A Number ${RUN}`);
    await page.click('.addpost button');
    await page.locator('.post', { hasText: `Awaiting A Number ${RUN}` }).waitFor();

    await page.fill('.addperson .pn', 'Number To Follow');
    await page.fill('.addperson .pp', '1111111');
    await page.selectOption('.addperson .ps', { label: `Awaiting A Number ${RUN}` });
    await page.check('.addperson .pc');
    await page.click('.addperson button');

    const card = page.locator('.post', { hasText: `Awaiting A Number ${RUN}` });
    await card.locator('.holder').waitFor();

    // Filled, and still saying nothing will be sent. This is the whole point of the
    // placeholder flag: a fake number that looked like a contact would silence the warning
    // while changing nothing about whether anybody is told.
    expect(await card.locator('.warn').textContent()).toContain('nothing will be sent');
    expect(await page.textContent('.unreachable')).toContain('cannot be reached');
  });

  it('7. typing the real number over it clears the warning', async () => {
    // Changed from the person's own card, which is where an operator would do it.
    const personCard = page.locator('.rosterperson', { hasText: 'Number To Follow' });
    answer([`0300${RUN}22`]);
    await personCard.getByRole('button', { name: 'Change number' }).click();

    await page.waitForFunction(() => document.querySelectorAll('.holder .warn').length === 0);
    expect(await page.locator('.unreachable').count()).toBe(0);
  });

  it('8. giving somebody a login is a separate, deliberate act', async () => {
    const personCard = page.locator('.rosterperson', { hasText: 'Station Officer On Duty' });

    // Confirm, then a password. Two dialogs, on purpose: an account for somebody who has
    // never been told the system exists is a password nobody chose, on an account nobody
    // watches. The confirmation is the pause where an operator remembers that.
    answer([true, 'a-real-password-2026']);
    await personCard.getByRole('button', { name: 'Give a login' }).click();

    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.rosterperson')).some(
        (c) =>
          c.textContent?.includes('Station Officer On Duty') === true &&
          c.textContent.includes('can sign in'),
      ),
    );
  });

  it('9. every edit above survives a reload, on the one roster there is', async () => {
    /**
     * This proved the roster was *"reached two ways"*, then that *"the picker names a department
     * and everything typed goes there"*. ⚠️ **Both doors are gone with the departments** — there
     * is one roster, and no picker that could paint one name over another's rows.
     *
     * What is still at risk is what the step was always really guarding: that the edits made in
     * tests 4–8 went to the **server** and not merely onto the screen. A reload is what separates
     * those two, and it is the half that survives ADR-0030 intact.
     */
    await page.reload();
    await page.click('#navAdmin');
    await page.click('#adminTabs button[data-tab="roster"]');
    await page.waitForSelector('#rosterBody');

    expect(await page.locator('.post', { hasText: `Station Officer ${RUN}` }).count()).toBe(1);
  });

  /**
   * ⚠️ **Step 9b is gone with the button that produced its subject — ADR-0030.**
   *
   * It created a department with no designations from the console and checked that the roster
   * said *"no designations"* — the state in which a routing signal sends emergencies into a
   * void. `POST /admin/departments` answers **404** now and there is no department to create,
   * so the state cannot be reached from any screen.
   *
   * The number is left with the gap rather than closed up, for the same reason board.e2e leaves
   * steps 8–10: these are cited in CLAUDE.md and the changelog, and renumbering would silently
   * repoint every one of those references at a different test.
   *
   * The rule itself is **not** repealed. A post nobody holds is still surfaced as vacant, and
   * `dispatch-to` still refuses a retired one outright — which is the stronger version of the
   * same protection, and is covered in `roster.test.ts` and `admin.test.ts`.
   */

  it('10. and the console disappears the moment the operator signs out', async () => {
    // It was the department view that vanished here before ADR-0018. The property is the same
    // and it is the one that matters on a shared machine in a control room: signing out takes
    // the roster editor with it, rather than leaving somebody else's district open on a screen.
    await page.click('#logout');
    await page.waitForSelector('#nav[hidden]', { state: 'attached' });
    expect(await page.locator('#adminView').isVisible()).toBe(false);
    expect(await page.locator('#navAdmin').isVisible()).toBe(false);
  });
});
