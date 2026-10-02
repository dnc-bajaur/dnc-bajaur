import { appendFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, expect } from 'vitest';

import { TRACE_DIR, TRACE_FILE } from './crashTraceFile.js';

/**
 * Which test file was running when a test process died — 2026-10-02.
 *
 * On this machine a full run now and then ends with *"Worker exited unexpectedly"* and no file
 * named: one file's results are simply missing, and finding which took guesswork. Every file now
 * writes one line when it starts and one when it ends, **synchronously** — an asynchronous write
 * could still be in a buffer when the process dies, which is the one moment this exists for.
 * `crashTraceGlobal.ts` reads the lines back at the end of the run and names any file that started
 * and never ended.
 *
 * Costs two small appends per file. Changes nothing a test sees.
 */

let file = 'unknown file';

function note(event: string, extra = ''): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true });
    appendFileSync(
      TRACE_FILE,
      `${event}\t${String(process.pid)}\t${new Date().toISOString()}\t${file}${extra}\n`,
    );
  } catch {
    // A trace that cannot be written must never be the reason a test fails.
  }
}

/**
 * Written as this module loads — before any hook, including the per-file database clean in
 * `loadEnv.ts`. Found the hard way: written from a `beforeAll`, a process that died during that
 * clean left no line at all, and the file it was running stayed nameless.
 */
let started = false;
function start(): void {
  const path = expect.getState().testPath;
  if (started || path === undefined) return;
  file = path;
  started = true;
  note('start');
}
start();

// Only if the path was not known yet at load — never a second line for the same file.
beforeAll(start);

afterAll(() => {
  note('end');
});

// Seen for an exit with a code (an uncaught error, `process.exit`). A native crash or a kill
// skips this — and the missing `end` above still names the file.
process.on('exit', (code) => {
  if (code !== 0) note('exit', `\tcode ${String(code)}`);
});
