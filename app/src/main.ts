/**
 * Process entry point.
 *
 * One process runs the API, serves the client, and drives the escalation loop — ADR-0007's
 * single deployable. Splitting them would mean two things to start, two to monitor and two
 * to restart at 02:00, in exchange for nothing this district needs.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkConfiguration } from './config.js';
import { createSyncServer } from './api/server.js';
import { closeServer } from './api/shutdown.js';
import { createPool, migrate } from './db/pool.js';
import { assignReferences } from './db/referenceStore.js';
import { createScheduler } from './jobs/scheduler.js';
import { whatsappChannel } from './jobs/whatsappChannel.js';
import { proactiveFromEnv, whatsappFromEnv } from './ops/whatsapp.js';
import { refreshWhatsAppNumber } from './ops/whatsappNumber.js';
import { defaultEvidenceRoot } from './ops/evidence.js';
import { createNightly } from './jobs/nightly.js';
import { refreshWeather } from './ops/weather.js';
import { refreshNews } from './ops/news.js';
import { log } from './obs/log.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Load `app/.env` if it is there.
 *
 * `docs/05-stack.md` and `CLAUDE.md` both say connection strings live in `app/.env`, and
 * until now **only the test setup ever read it** — the actual process started, found no
 * `DATABASE_URL`, and exited. The documented way to configure the system did not configure
 * the system.
 *
 * Absent is not an error: a real deployment will pass real environment variables, and a
 * file that is not there simply means they came from somewhere else. Node 22 can do this
 * without a dependency, so it does.
 */
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

async function start(): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const port = Number(process.env['PORT'] ?? 3000);

  /**
   * Check the configuration before anything is started (M0-05).
   *
   * Every one of these values used to be read at the point of use, which meant a mistake
   * surfaced in the backup job at 02:00, or in an escalation pass, or on a screen — none of
   * which anybody is watching. One line at boot instead.
   *
   * Warnings never stop the process. A district that cannot report an emergency because a
   * backup bucket is missing would be this system failing at the one thing it exists for.
   */
  const config = checkConfiguration(process.env, nodeEnv);
  log('info', 'configuration', config.summary);
  for (const warning of config.warnings) log('warn', 'configuration', { warning });

  if (config.refusals.length > 0) {
    for (const refusal of config.refusals) log('error', 'configuration', { refusal });
    log('error', 'refusing to start', { refusals: config.refusals.length });
    process.exit(1);
  }

  const pool = createPool();
  const applied = await migrate(pool, join(here, '..', 'db', 'migrations'));
  if (applied.length > 0) log('info', 'migrations applied', { applied });

  /**
   * **Every incident the district has recorded gets its number** — 2026-08-24.
   *
   * Here rather than in a backfill script, and here rather than only on the write path. The
   * first boot after this ships numbers a month of Bajaur's live record in one query; every boot
   * after that finds nothing and costs one round trip. It is also the repair: an assignment that
   * failed inside `append()` — which swallows, because the record outranks the counter (INV-01) —
   * is picked up by the next restart without anybody knowing it had to be.
   *
   * Warned, never fatal. A district that cannot number an emergency must still be able to
   * report one, which is the same rule the configuration warnings above follow.
   */
  try {
    const numbered = await assignReferences(pool);
    if (numbered.length > 0) {
      log('info', 'incident references assigned', {
        assigned: numbered.length,
        highest: Math.max(...numbered.map((n) => n.seq)),
      });
    }
  } catch (err) {
    log('warn', 'incident references not assigned', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const backupDirectory = process.env['BACKUP_DIR'] ?? join(here, '..', 'var', 'backups');

  /**
   * The district's WhatsApp account, if it has one — ADR-0014.
   *
   * Null until R-05, R-19 and R-20 are done, and **the product is complete without it**:
   * obligations are recorded, the inbox works, and "Reach them" is there. What must not happen
   * is the district believing messages go out when no account exists, which is why this is
   * logged at boot and shown as a condition row on the dashboard (M6-25).
   */
  const whatsapp = whatsappFromEnv(process.env);
  log('info', 'whatsapp', {
    configured: whatsapp !== null,
    // Never the token, never the secret. Only whether they are there.
    template: whatsapp?.templateName ?? null,
  });

  /**
   * **The proactive switch, and it is off unless this district turned it on** — Phase 5.
   *
   * Read here and logged here, in one line, exactly as the account is — `config.ts`'s own rule
   * about surfacing configuration at boot rather than at 02:00 in a job nobody is watching. On
   * every deployment that has not set `WHATSAPP_PROACTIVE` this reads `off`, no proactive pass is
   * given to the scheduler at all, and not one message from `jobs/proactive.ts` can be sent.
   */
  const proactive = proactiveFromEnv(process.env);
  log('info', 'whatsapp proactive', {
    enabled: proactive.enabled.size === 0 ? 'off' : [...proactive.enabled].sort().join(', '),
  });

  /**
   * Where officers' handsets can actually reach this — ADR-0017.
   *
   * The acknowledge link goes into a WhatsApp message. `http://<office-IP>:3000` resolves
   * inside the DC office and nowhere else, so a link built from it fails on every real handset
   * in Bajaur — the same class of fault ADR-0017 exists to close. Defaulted to the loopback
   * origin so development works; a district that has not set it will find every link broken,
   * which is a warning rather than a refusal because INV-01 outranks a broken link.
   */
  const publicOrigin = process.env['PUBLIC_ORIGIN'] ?? `http://127.0.0.1:${String(port)}`;
  if (whatsapp !== null && process.env['PUBLIC_ORIGIN'] === undefined) {
    log('warn', 'PUBLIC_ORIGIN is not set', {
      using: publicOrigin,
      why: 'acknowledge links will point at an address no handset outside this machine can reach (ADR-0017)',
    });
  }

  /**
   * Proxy addresses whose `X-Forwarded-For` may be believed — M6-37.
   *
   * Empty unless the district sets it, and empty means the header is ignored entirely. This
   * and the reverse proxy ship together: set it without a proxy and an attacker chooses their
   * own throttle key; ship the proxy without it and one mistyped password throttles Bajaur.
   */
  const trustedProxies = (process.env['TRUSTED_PROXIES'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const server = createSyncServer({
    pool,
    whatsapp,
    /**
     * **This line was missing, and every acknowledge link the server itself sent was dead.**
     *
     * `ServerOptions.publicOrigin` has existed since M6-04 and its own comment says why it is
     * needed *here* as well as in the scheduler: a dispatch notifies immediately rather than
     * waiting for the next tick, and that pass mints the acknowledge links. Nothing ever passed
     * it. So `server.ts` fell through to its hardcoded `http://127.0.0.1:3000`, and the channel
     * the **API** builds addressed officers' handsets at a loopback origin — while the channel
     * the **scheduler** builds, four lines below this one, had the real https origin all along.
     *
     * Two channels, two origins, one of them wrong. Found on 2026-08-13 by reading the boot
     * journal after a deploy: `"the acknowledge button will not be reachable"`, with a port
     * number (3000) that this deployment does not even listen on (3001) — which is what gave it
     * away, because that number can only have come from a literal in the code.
     *
     * It is the same failure as the 2026-08-12 dead-link bug in `ops/whatsapp.ts`, arriving from
     * the other end: **the send succeeds, so nothing reports a fault**, and the district finds
     * out only when an officer says the button did nothing.
     */
    publicOrigin,
    trustedProxies,
    /**
     * `session`, because that is what this process actually enforces.
     *
     * This said `stub` until the district's installer was built, and the comment beside it
     * claimed the value made a production deployment impossible. It did — literally.
     * `assertAuthUsable` throws for `stub` outside development, so **`NODE_ENV=production`
     * could not start this application at all**, and the only environment it would boot in
     * was the one where `/health` announces development authentication.
     *
     * The flag was always vestigial: every route resolves a real session through
     * `resolveSession` and there has never been a branch on `authMode` around any of them —
     * M0-19 landed and this line was not updated with it. What it still does is honest
     * reporting on `/health`, which is worth keeping; what it must not do is describe the
     * server as less authenticated than it is.
     */
    authMode: 'session',
    nodeEnv,
    webRoot: join(here, '..', 'web', 'dist'),
    backupDirectory,
    // Late-bound on purpose: the server is created before the job, and the console's
    // "back up now" button needs the job rather than a copy of its options.
    get nightly() {
      return nightly;
    },
  });

  const scheduler = createScheduler({
    pool,
    intervalMs: Number(process.env['ESCALATION_INTERVAL_MS'] ?? 15_000),
    // Beside the inbox, never below it. See the note in `runNotifyPass`: this is one channel,
    // not the second rung of a ladder — the ladder was removed and stays removed.
    ...(whatsapp === null
      ? {}
      : {
          whatsapp: whatsappChannel({
            pool,
            config: whatsapp,
            publicOrigin,
            /**
             * The scheduler's channel needs this as much as the server's — M10-34a.
             *
             * **An escalation sends a real message**, and it goes through this channel rather
             * than the one `createSyncServer` builds. Leaving it defaulted here would work only
             * for as long as both defaults agree, which is precisely the drift
             * `defaultEvidenceRoot()` exists to remove: the two channels once disagreed about
             * `publicOrigin` for a fortnight and every acknowledge link the API sent was dead.
             */
            evidenceRoot: defaultEvidenceRoot(),
          }),
        }),
    onOutcome: (o) => {
      // Only worth a line when something happened. A loop that logs every quiet tick
      // trains everyone to ignore it.
      if (o.escalated > 0 || o.exhausted.length > 0 || o.noHolder.length > 0 || o.truncated) {
        log(o.truncated ? 'warn' : 'info', 'escalation pass', {
          scanned: o.scanned,
          escalated: o.escalated,
          exhausted: o.exhausted,
          noHolder: o.noHolder,
          // More open incidents than the pass can examine: either a real crisis or a
          // backlog nobody is closing. Both need saying out loud.
          truncated: o.truncated,
        });
      }
    },
    onNotify: (o) => {
      if (o.attempted > 0 || o.failed > 0 || o.truncated) {
        log(o.failed > 0 ? 'warn' : 'info', 'notification pass', {
          scanned: o.scanned,
          attempted: o.attempted,
          // A vacant post or a dead channel. Somebody has to be told that nobody was told
          // (INV-03) — this is the log half of that; the board is the half operators see.
          failed: o.failed,
          truncated: o.truncated,
        });
      }
    },
    onError: (err) => log('error', 'background pass failed', { error: String(err) }),
    /**
     * ⚠️ **Given only when the district has named something, and never when WhatsApp is
     * unconfigured.** Two independent reasons to omit it, and omitting it means the tick has no
     * proactive pass in it at all — the switch is enforced by the absence of the work as well as
     * by the check inside it.
     */
    ...(whatsapp === null || proactive.enabled.size === 0
      ? {}
      : { proactive: { config: whatsapp, settings: proactive } }),
  });

  /**
   * The nightly backup (M0-53, ADR-0011).
   *
   * P-08 held this up for weeks: the backup was built and verified and nothing scheduled it,
   * because where the server runs decides how. ADR-0011 answered that, so it runs here — on
   * the machine in the DC office, at 02:00, with an encrypted copy going out of the district.
   *
   * Started even when there is no bucket yet. The local dump still happens and the ledger
   * still records that the off-site copy did not, which is the fact `/health` and the console
   * need in order to say the district is only half covered (R-06).
   */
  const nightly = createNightly({
    pool,
    backup: {
      directory: backupDirectory,
      // Stated rather than inherited. `runBackup` would fall back to `DATABASE_URL` anyway
      // here, and being explicit is what stops the job dumping one database and verifying
      // against another the day those two stop agreeing.
      ...(process.env['DATABASE_URL'] === undefined
        ? {}
        : { connectionString: process.env['DATABASE_URL'] }),
      ...(process.env['PG_BIN'] === undefined ? {} : { pgBin: process.env['PG_BIN'] }),
    },
    onRun: (o) => {
      if (!o.ran) return;
      log(o.backupOk === true && o.offsiteOk === true ? 'info' : 'warn', 'nightly backup', {
        reason: o.reason,
        backupOk: o.backupOk ?? false,
        offsiteOk: o.offsiteOk ?? false,
        ...(o.offsiteSkipped === undefined ? {} : { offsiteSkipped: o.offsiteSkipped }),
      });
    },
  });

  /**
   * The weather, refreshed for every screen at once (M4-04, ADR-0013).
   *
   * Fifteen minutes, and the first fetch happens at startup so a freshly installed screen has
   * something on it inside a minute rather than at the top of the next quarter hour.
   *
   * A failure is logged at `warn` and changes nothing else. Weather is the least important
   * thing on the wall and must never be able to take the process down with it — the previous
   * reading stays exactly where it was, ageing visibly, which is the honest outcome.
   */
  const weatherTimer = setInterval(
    () => {
      void refreshWeather(pool).then((r) => {
        if (!r.ok) log('warn', 'weather refresh failed', { error: r.error ?? 'unknown' });
      });
    },
    15 * 60 * 1000,
  );
  weatherTimer.unref();

  void refreshWeather(pool).then((r) => {
    if (!r.ok) log('warn', 'weather refresh failed', { error: r.error ?? 'unknown' });
  });

  /**
   * Headlines — M9-59. Twenty minutes, and the first fetch at startup.
   *
   * Slower than the weather on purpose: a news feed that moves faster than a room can read it is
   * a panel that only ever shows motion. Twenty minutes is roughly how often a control-room
   * screen is actually looked at, and it keeps this district well clear of anybody's rate limit.
   *
   * A failure is logged at `warn` and changes nothing else — the previous headlines stay exactly
   * where they are, ageing visibly, which is the honest outcome and the same rule the weather
   * follows. **This must never be able to take the process down**: it is the least important
   * thing on the wall and it depends on a machine nobody here controls.
   */
  const newsTimer = setInterval(
    () => {
      void refreshNews(pool).then((r) => {
        // On `error` rather than on `ok`: two editions are fetched, and one of them failing
        // still stores the other. That is a success worth having and a loss worth logging.
        if (r.error !== undefined) {
          log(r.ok ? 'info' : 'warn', 'news refresh incomplete', { error: r.error });
        }
      });
    },
    20 * 60 * 1000,
  );
  newsTimer.unref();

  void refreshNews(pool).then((r) => {
    if (r.error !== undefined) {
      log(r.ok ? 'info' : 'warn', 'news refresh incomplete', { error: r.error });
    }
  });

  /**
   * **How many officers this district may still reach today** — 2026-08-21.
   *
   * Meta caps a number at a fixed count of **unique recipients per rolling 24 hours** — Bajaur is
   * on `TIER_250` — and nothing in this product could see it. `whatsappHealth` counted how the
   * sends that happened went, which is a different question from how many more may happen.
   *
   * **Thirty minutes, and slower than the weather on purpose.** A messaging tier changes on the
   * order of weeks and a quality rating on the order of days; polling either every fifteen would
   * be asking somebody else's API a question whose answer has not moved. The first read is at
   * startup so a district that has just restarted is not blind until the first interval.
   *
   * ⚠️ **Skipped entirely when WhatsApp is not configured**, which is the ordinary state until a
   * district's Meta account exists (R-05). A poll with no credentials would log a failure every
   * half hour about a feature the installation has not bought.
   *
   * ⚠️ **This must never be able to take the process down.** It is a read against somebody else's
   * API on the machine that is also accepting emergency reports — the same rule the weather and
   * the headlines already hold themselves to, and the reason a failed poll writes nothing at all
   * rather than recording Meta's outage as a fault of the district's own number.
   */
  if (whatsapp !== null) {
    const numberTimer = setInterval(
      () => {
        void refreshWhatsAppNumber(pool, whatsapp).then((r) => {
          if (!r.ok)
            log('warn', 'whatsapp number refresh failed', { error: r.failure ?? 'unknown' });
        });
      },
      30 * 60 * 1000,
    );
    numberTimer.unref();

    void refreshWhatsAppNumber(pool, whatsapp).then((r) => {
      if (!r.ok) log('warn', 'whatsapp number refresh failed', { error: r.failure ?? 'unknown' });
    });
  }

  /**
   * Which interface to answer on — M6-38, ADR-0017.
   *
   * Unset means every interface, which is what a district with no proxy needs: officers reach
   * the office machine directly on the LAN. When the proxy is installed this becomes
   * `127.0.0.1`, and **that is a security boundary rather than tidiness**. If the application
   * stayed reachable directly, somebody could bypass the proxy — and then `X-Forwarded-For` is
   * a header the caller writes, which is a rate limiter an attacker opts out of (M6-37).
   */
  const host = process.env['HOST'];

  await new Promise<void>((resolve) => {
    if (host === undefined || host.trim() === '') server.listen(port, resolve);
    else server.listen(port, host.trim(), resolve);
  });
  scheduler.start();
  nightly.start();
  log('info', 'started', { port, nodeEnv });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });

    void (async () => {
      // Stop escalating first, then stop accepting requests, then release the pool.
      // Reversing this could leave a pass writing to a closed pool mid-escalation.
      nightly.stop();
      clearInterval(weatherTimer);
      await scheduler.stop();
      /**
       * **This line used to be `server.close()` on its own, and it never once completed in
       * production** — O-29. `close()` waits for every open connection to end, and `/board/live`
       * is held open for ever by design, so a single control-room tab hung the shutdown until
       * systemd's ninety-second timer SIGKILLed the process. Every deploy was a ninety-second
       * hole in which Bajaur could not report an emergency, and `"stopped"` below was unreachable.
       */
      const outcome = await closeServer(server);
      await pool.end();
      log('info', 'stopped', { connections: outcome });
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err: unknown) => {
  log('error', 'failed to start', { error: String(err) });
  process.exit(1);
});
