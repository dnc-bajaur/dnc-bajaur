/**
 * IndexedDB durability, tested in a real browser across a real page reload.
 *
 * This suite exists because the property under test cannot be faked. `fake-indexeddb`
 * would satisfy the `OutboxStore` interface and pass every assertion below while proving
 * nothing about whether a report survives a phone dying mid-submit — which is the entire
 * claim of ADR-0002 and INV-01.
 *
 * The pattern that matters: write, **reload the page**, then read. A test that never
 * reloads is testing a Map with extra steps.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'browser-harness.ts');

let browser: Browser;
let page: Page;
let bundle: string;
let origin: string;
let httpServer: Server;

/**
 * Serve the harness page over http.
 *
 * `about:blank` is an opaque origin and browsers deny IndexedDB there entirely — which is
 * correct behaviour and worth knowing: storage is partitioned by origin, so the outbox
 * only exists where the app is actually served from.
 */
function startOriginServer(): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>outbox harness</title>');
    });
    httpServer.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`);
    });
  });
}

/**
 * Bundle the real adapter and outbox for the browser.
 *
 * The browser runs the same source the handset will. Nothing here is a browser-specific
 * reimplementation, because a reimplementation is what a test is supposed to catch.
 */
async function bundleHarness(): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: 'DNC',
    write: false,
    platform: 'browser',
    target: 'chrome110',
  });
  return result.outputFiles[0]!.text;
}

describe('IndexedDB outbox store (real browser)', () => {
  beforeAll(async () => {
    bundle = await bundleHarness();
    origin = await startOriginServer();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(origin);
    await page.addScriptTag({ content: bundle });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  });

  /** Reload and re-inject. Everything in IndexedDB should still be there; nothing else is. */
  async function reload(): Promise<void> {
    await page.reload();
    await page.addScriptTag({ content: bundle });
  }

  it('stores an entry that survives a page reload', async () => {
    const id = await page.evaluate(async () => {
      const store = await DNC.openStore('durability-1');
      const event = DNC.makeEvent('reported', { severity: 'critical' }, 1);
      await store.put({ event, state: 'pending', attempts: 0 });
      store.close();
      return event.eventId;
    });

    await reload();

    const survived = await page.evaluate(async () => {
      const store = await DNC.openStore('durability-1');
      const all = await store.all();
      store.close();
      return all.map((e) => ({ id: e.event.eventId, state: e.state }));
    });

    expect(survived).toHaveLength(1);
    expect(survived[0]!.id).toBe(id);
    expect(survived[0]!.state).toBe('pending');
  });

  it('keeps a queued emergency across a reload, unsent', async () => {
    // The scenario the whole project exists for: a report entered with no signal, and the
    // handset closed before it could be delivered.
    const before = await page.evaluate(async () => {
      const store = await DNC.openStore('durability-2');
      const outbox = DNC.makeOutbox(store, { offline: true });
      await outbox.enqueue(DNC.draft('reported', { severity: 'critical', note: 'RTA Khar road' }));
      const result = await outbox.sync();
      const pending = await outbox.pendingCount();
      store.close();
      return { offline: result.offline, pushed: result.pushed, pending };
    });

    expect(before).toEqual({ offline: true, pushed: 0, pending: 1 });

    await reload();

    const after = await page.evaluate(async () => {
      const store = await DNC.openStore('durability-2');
      const all = await store.all();
      store.close();
      return {
        count: all.length,
        severity: (all[0]?.event.payload as { severity?: string })?.severity,
        state: all[0]?.state,
      };
    });

    expect(after.count).toBe(1);
    expect(after.severity).toBe('critical');
    expect(after.state).toBe('pending');
  });

  it('delivers the queued report once the network returns after a reload', async () => {
    const result = await page.evaluate(async () => {
      const store = await DNC.openStore('durability-2');
      const outbox = DNC.makeOutbox(store, { offline: false });
      const sync = await outbox.sync();
      const remaining = await outbox.pendingCount();
      store.close();
      return { pushed: sync.pushed, remaining };
    });

    expect(result.pushed).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('continues clientSeq after a reload instead of restarting at 1', async () => {
    // A counter that resets on restart would hand out duplicate sequence numbers, which is
    // exactly the tie ADR-0008 exists to prevent.
    const first = await page.evaluate(async () => {
      const store = await DNC.openStore('seq-1');
      const outbox = DNC.makeOutbox(store, { offline: true });
      const a = await outbox.enqueue(DNC.draft('reported', {}, 'incident-fixed'));
      const b = await outbox.enqueue(DNC.draft('triaged', {}, 'incident-fixed'));
      store.close();
      return [a.clientSeq, b.clientSeq];
    });

    expect(first).toEqual([1, 2]);

    await reload();

    const afterReload = await page.evaluate(async () => {
      const store = await DNC.openStore('seq-1');
      const outbox = DNC.makeOutbox(store, { offline: true });
      const c = await outbox.enqueue(DNC.draft('acknowledged', {}, 'incident-fixed'));
      store.close();
      return c.clientSeq;
    });

    expect(afterReload).toBe(3);
  });

  it('keeps the sync cursor across a reload', async () => {
    await page.evaluate(async () => {
      const store = await DNC.openStore('cursor-1');
      await store.setCursor(4242);
      store.close();
    });

    await reload();

    const cursor = await page.evaluate(async () => {
      const store = await DNC.openStore('cursor-1');
      const c = await store.getCursor();
      store.close();
      return c;
    });

    expect(cursor).toBe(4242);
  });

  it('hands out unique sequence numbers under concurrent enqueues', async () => {
    const seqs = await page.evaluate(async () => {
      const store = await DNC.openStore('seq-concurrent');
      const outbox = DNC.makeOutbox(store, { offline: true });
      const results = await Promise.all(
        Array.from({ length: 25 }, () => outbox.enqueue(DNC.draft('action_logged', {}, 'inc-c'))),
      );
      store.close();
      return results.map((r) => r.clientSeq);
    });

    expect(new Set(seqs).size).toBe(25);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });
});
