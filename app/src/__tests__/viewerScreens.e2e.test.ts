/**
 * What a `viewer` is offered on a real screen — ADR-0032, PLAN F3.
 *
 * The server refuses every write a viewer sends (`viewerGate.test.ts`, INV-05); that is the
 * control. This file pins the courtesy on top of it: the screens do not offer a viewer what would
 * only be refused. Before 2026-10-03 a viewer was shown the Report form and the Status buttons,
 * pressed them, and was told no.
 *
 *   1. no Report tab, and no report form — at sign-in, on a phone, and after a reload;
 *   2. the account says it is read-only, on every screen;
 *   3. the Status screen is readable and none of its controls can be pressed;
 *   4. an operator beside it is offered all of it, unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createSyncServer } from '../api/server.js';
import { createPool, migrate, type Pool } from '../db/pool.js';
import { buildWeb } from '../../build.mjs';
import {
  seedActor,
  TEST_PASSWORD,
  type TestActor,
  enableAllCapabilities,
} from '../testing/seed.js';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'db', 'migrations');

describe.skipIf(dbUrl === undefined)('what a viewer is offered (ADR-0032)', () => {
  let pool: Pool;
  let api: Server;
  let origin: string;
  let browser: Browser;
  let viewer: TestActor;
  let operator: TestActor;

  /** A phone: the width at which every other account lands on the report form. */
  const PHONE = { width: 390, height: 800 };

  async function signIn(actor: TestActor, viewport = PHONE): Promise<Page> {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(origin);
    await page.waitForSelector('#login');
    await page.fill('#phone', actor.phone);
    await page.fill('#password', TEST_PASSWORD);
    await page.click('#loginSubmit');
    await page.waitForSelector('#nav:not([hidden])');
    return page;
  }

  beforeAll(async () => {
    const webRoot = await buildWeb();
    pool = createPool(dbUrl);
    await migrate(pool, migrationsDir);
    // Field intake on: without it the Report tab is hidden from every non-administration seat,
    // and this file would pass for the wrong reason.
    await enableAllCapabilities(pool);
    api = createSyncServer({ pool, authMode: 'stub', nodeEnv: 'test', webRoot });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    viewer = await seedActor(pool, { title: `Viewer Screens ${Date.now()}`, role: 'viewer' });
    operator = await seedActor(pool, { title: `Viewer Screens Op ${Date.now()}` });
    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => api?.close(() => r()));
    await pool?.end();
  });

  it('1. gives a viewer no Report tab and no report form, even on a phone and after a reload', async () => {
    const page = await signIn(viewer);
    await page.waitForSelector('#dashboardView:not([hidden])');
    expect(await page.isHidden('#navReport')).toBe(true);
    expect(await page.isHidden('#reportView')).toBe(true);

    await page.reload();
    await page.waitForSelector('#nav:not([hidden])');
    await page.waitForSelector('#dashboardView:not([hidden])');
    expect(await page.isHidden('#navReport')).toBe(true);
    expect(await page.isHidden('#reportView')).toBe(true);
    await page.context().close();
  });

  it('2. says the account is read-only, beside the name', async () => {
    const page = await signIn(viewer);
    expect(await page.isVisible('#readOnlyNote')).toBe(true);
    expect(await page.locator('#readOnlyNote').textContent()).toBe('Read-only account');
    await page.context().close();
  });

  it('3. shows a viewer the Status screen and lets none of it be pressed', async () => {
    const page = await signIn(viewer, { width: 1366, height: 768 });
    await page.click('#navStatus');
    await page.waitForSelector('#statusView:not([hidden]) .sbtn');
    expect(await page.locator('#statusView .sbtn').count()).toBeGreaterThan(0);

    // `inert`: on screen, out of reach of the pointer and the keyboard alike.
    expect(await page.evaluate(() => document.getElementById('statusView')!.inert)).toBe(true);
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await page.locator('#statusView .sbtn').first().click({ force: true });
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);
    await page.context().close();
  });

  it('4. leaves an operator everything a viewer is not offered', async () => {
    const page = await signIn(operator);
    expect(await page.isVisible('#navReport')).toBe(true);
    expect(await page.isHidden('#readOnlyNote')).toBe(true);
    await page.click('#navStatus');
    await page.waitForSelector('#statusView:not([hidden]) .sbtn');
    expect(await page.evaluate(() => document.getElementById('statusView')!.inert)).toBe(false);
    await page.context().close();
  });
});
