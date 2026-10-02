/**
 * Reading the crash trace back — `testing/crashTrace.ts`.
 *
 * A file that started and never ended is the one whose process died; it must be named, and a
 * file that finished must not be — or the report sends somebody to re-run the wrong thing.
 */

import { describe, expect, it } from 'vitest';

import { unfinished } from '../crashTraceGlobal.js';

const line = (event: string, pid: string, file: string, extra?: string): string =>
  [event, pid, '2026-10-02T00:00:00.000Z', file, ...(extra === undefined ? [] : [extra])].join(
    '\t',
  );

describe('the crash trace', () => {
  it('names a file that started and never ended, and only that one', () => {
    const trace = [
      line('start', '1', 'a.test.ts'),
      line('end', '1', 'a.test.ts'),
      line('start', '2', 'b.test.ts'),
      line('start', '3', 'c.test.ts'),
      line('end', '3', 'c.test.ts'),
      '',
    ].join('\n');
    expect(unfinished(trace)).toEqual([{ file: 'b.test.ts', exit: null }]);
  });

  it('says how the process exited when it said so', () => {
    const trace = [line('start', '7', 'd.test.ts'), line('exit', '7', 'd.test.ts', 'code 1')].join(
      '\n',
    );
    expect(unfinished(trace)).toEqual([{ file: 'd.test.ts', exit: 'code 1' }]);
  });

  it('tells apart the same file run twice by different processes', () => {
    const trace = [
      line('start', '1', 'e.test.ts'),
      line('start', '2', 'e.test.ts'),
      line('end', '2', 'e.test.ts'),
    ].join('\n');
    expect(unfinished(trace)).toEqual([{ file: 'e.test.ts', exit: null }]);
  });

  it('reads an empty trace as nothing lost', () => {
    expect(unfinished('')).toEqual([]);
  });
});
