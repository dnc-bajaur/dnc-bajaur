/**
 * The thing we actually ship, actually starting.
 *
 * This exists because `npm start` had **never worked** — not regressed, never. It ran
 * `node --experimental-strip-types src/main.ts`, and type stripping does not remap a `.js`
 * import specifier to the `.ts` file beside it. Vitest resolves those specifiers itself, so
 * 338 tests passed against code that could not be launched. Three consecutive green runs and
 * a green CI said nothing about it, because nothing had ever tried.
 *
 * The second failure was the same shape: the process started and exited immediately with
 * `DATABASE_URL is not set`, because `app/.env` — the file `CLAUDE.md` and `docs/05-stack.md`
 * both name as where configuration lives — was only ever read by the **test** setup.
 *
 * So this test does the one thing all the others were structurally unable to do: it builds
 * the real artifact, runs it the way a district server would, and waits for it to answer.
 * Everything else here proves the system is correct. This proves it can be turned on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dbUrl = process.env['TEST_DATABASE_URL'];
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');

/** High and arbitrary, to stay clear of a developer's own server on 3000. */
const PORT = 34_517;

describe.skipIf(dbUrl === undefined)('the built server starts and answers', () => {
  let child: ChildProcess | null = null;

  beforeAll(() => {
    // Compile it the way `npm start` does. A stale `dist/` would make this test a lie.
    // One command string rather than an args array: with `shell: true` Node deprecates the
    // array form, and there is no user input anywhere near this.
    const built = spawnSync('npx tsc -p tsconfig.build.json', {
      cwd: appRoot,
      shell: true,
      encoding: 'utf8',
    });
    expect(built.status, `tsc failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
  }, 180_000);

  afterAll(() => {
    child?.kill();
  });

  it('boots, connects to the database, and serves /health', async () => {
    child = spawn(process.execPath, [join(appRoot, 'dist', 'main.js')], {
      cwd: appRoot,
      env: {
        ...process.env,
        // Explicit, and it wins: `process.loadEnvFile` does not override variables already
        // set in the environment, so a developer's own `.env` cannot redirect this test at
        // their working database.
        DATABASE_URL: dbUrl!,
        PORT: String(PORT),
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));

    // A process that exits during startup is the failure this test was written for, so it
    // is reported as itself rather than as a timeout twenty seconds later.
    let exited: string | null = null;
    child.on('exit', (code) => {
      exited = `process exited with code ${String(code)}:\n${output}`;
    });

    const deadline = Date.now() + 30_000;
    let health: Response | null = null;
    while (Date.now() < deadline && health === null) {
      if (exited !== null) throw new Error(exited);
      try {
        health = await fetch(`http://127.0.0.1:${PORT}/health`);
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    expect(health, `server never answered:\n${output}`).not.toBeNull();
    expect(health!.status).toBe(200);

    const body = (await health!.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    // Not just "the process is alive" — it reached PostgreSQL. A server that starts and
    // cannot see its database is not started.
    expect(body.db).toBe('up');
  }, 60_000);

  it('serves the built web client, so an operator gets an app and not a 404', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('District Nerve Center');
  });
});
