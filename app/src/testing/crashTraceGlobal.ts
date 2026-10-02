import { existsSync, readFileSync, rmSync } from 'node:fs';
import { relative } from 'node:path';

import { TRACE_FILE } from './crashTraceFile.js';

/**
 * The other half of `crashTrace.ts`: start each run with an empty trace, and at the end name
 * every test file that started and never finished.
 *
 * Printed, not failed: vitest already fails the run on the crash itself. What was missing was
 * the file's name, so that it can be re-run alone and the cause looked for in the right place.
 */

export function setup(): void {
  rmSync(TRACE_FILE, { force: true });
}

/** Files that started and never ended, with how each process exited when it said. */
export function unfinished(trace: string): { file: string; exit: string | null }[] {
  const open = new Map<string, string>();
  const exits = new Map<string, string>();
  for (const line of trace.split('\n')) {
    const [event, pid, , file, extra] = line.split('\t');
    if (event === undefined || pid === undefined || file === undefined) continue;
    const key = `${pid}\t${file}`;
    if (event === 'start') open.set(key, file);
    else if (event === 'end') open.delete(key);
    else if (event === 'exit') exits.set(key, extra ?? '');
  }
  return [...open].map(([key, file]) => ({ file, exit: exits.get(key) ?? null }));
}

export function teardown(): void {
  if (!existsSync(TRACE_FILE)) return;
  const lost = unfinished(readFileSync(TRACE_FILE, 'utf8'));
  if (lost.length === 0) return;
  process.stderr.write(
    `\n  ${String(lost.length)} test file(s) started and never finished — the process running ` +
      'them died:\n\n' +
      lost
        .map(
          (l) =>
            `      ${relative(process.cwd(), l.file)}  (${l.exit ?? 'no exit code: killed or crashed'})`,
        )
        .join('\n') +
      `\n\n  Re-run each alone. The full trace is ${relative(process.cwd(), TRACE_FILE)}.\n\n`,
  );
}
