/**
 * What `main.ts` actually hands the server — the gap no other test can see.
 *
 * ## Why this file is allowed to read source code
 *
 * On 2026-08-13 a deploy's boot journal said *"the acknowledge button will not be reachable"*,
 * naming `http://127.0.0.1:3000` — a port this deployment does not even listen on. That literal
 * could only have come from `server.ts`'s fallback, which meant `main.ts` had never passed
 * `publicOrigin`. Every acknowledge link the **API** sent addressed officers' handsets at a
 * loopback origin, while the **scheduler**, wired four lines further down the same file, had the
 * real https origin all along. Two channels, two origins, one of them dead.
 *
 * **994 tests did not catch it, and could not have.** `whatsappLoop.test.ts` builds its server
 * with `publicOrigin: 'https://dnc.example.invalid'` — correctly, faithfully, and that is exactly
 * the problem: every test supplies the option itself, so the only place the omission could hide
 * was the one file no test constructs. `main.ts` is a process entry point; it opens a pool, binds
 * a port, installs signal handlers and never returns. Importing it in a test runs the district's
 * server.
 *
 * So this reads the file. That is a real cost — a rename breaks it, and it asserts on text rather
 * than behaviour. It is worth paying, because the alternative is the class of bug that got
 * through: **an option that exists, is documented as required, is honoured everywhere it is
 * given, and is simply never given.** Nothing about behaviour is wrong anywhere; only the wiring
 * is missing, and wiring is what this file is about.
 *
 * If these ever fail after a legitimate refactor, fix the assertion — do not delete it without
 * replacing the guarantee.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, '..', 'main.ts'), 'utf8');

/** The `createSyncServer({ ... })` call's own text, brace-matched from its opening. */
function serverOptions(): string {
  const start = mainSource.indexOf('createSyncServer({');
  expect(start, 'main.ts no longer calls createSyncServer — this guard needs rewriting').not.toBe(
    -1,
  );

  let depth = 0;
  for (let i = mainSource.indexOf('{', start); i < mainSource.length; i += 1) {
    if (mainSource[i] === '{') depth += 1;
    else if (mainSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return mainSource.slice(start, i + 1);
    }
  }
  throw new Error('could not find the end of the createSyncServer call');
}

describe('main.ts wires the server with what production needs', () => {
  it('passes publicOrigin, so acknowledge links are not built from a loopback default', () => {
    // The bug, exactly. `ServerOptions.publicOrigin` has existed since M6-04 and its own comment
    // says it is needed here as well as in the scheduler, because a dispatch notifies
    // immediately and that pass mints the acknowledge link.
    expect(serverOptions()).toMatch(/\bpublicOrigin\b/);
  });

  it('computes publicOrigin from the environment rather than a literal', () => {
    expect(mainSource).toMatch(/PUBLIC_ORIGIN/);
  });

  it('gives the scheduler the same origin it gives the server', () => {
    // Two channels are constructed — one by the server for immediate dispatch, one by the
    // scheduler for the notify pass — and they mint links into the same WhatsApp messages.
    // Whatever else changes here, they must not be able to disagree about where an officer's
    // handset should point. One variable, referenced twice, is what makes that true.
    const uses = mainSource.match(/\bpublicOrigin\b/g) ?? [];
    expect(
      uses.length,
      'publicOrigin should be declared once and passed to both the server and the scheduler',
    ).toBeGreaterThanOrEqual(3);
  });

  it("does not hardcode the district's own origin anywhere in main", () => {
    // `dnc.example.com` belongs in .env and in the approved template, never in the source —
    // ADR-0017. A second copy here is a copy that will be wrong for the next district.
    expect(mainSource).not.toMatch(/bajaurzone/i);
  });
});
