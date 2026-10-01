import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/testing/loadEnv.ts'],

    // One query, once, to say whether the local test database still looks like a district.
    // See the file — this failure mode has cost an evening twice.
    globalSetup: ['./src/testing/globalSetup.ts'],

    // Database tests share one cluster; run files serially so they cannot interleave.
    fileParallelism: false,

    // Each file gets its own child process.
    //
    // Two suites launch real Chromium, and under the default worker-thread pool a browser
    // teardown in one could take the shared worker down with it — which showed up as
    // "Worker exited unexpectedly" and ten silently unreported tests. A crash in one file
    // must never be able to hide results in another.
    pool: 'forks',

    // Browser launch and Postgres round-trips are slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
