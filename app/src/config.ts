/**
 * What this process was configured with, checked once at boot — M0-05.
 *
 * The secret store for this deployment is **a file on the district's own machine**, and that
 * is the right answer rather than a gap. ADR-0011 puts one server in the DC office; ADR-0007
 * says it must be operable by one person at 02:00. A secrets manager would add a network
 * dependency, an account, and a renewal nobody is watching — to protect a file that sits on
 * the same disk as the database it unlocks. What a file needs is not a vault: it is to be
 * **out of git, readable only by the service user, and verified at boot** rather than at the
 * moment it is first needed.
 *
 * The last part is what was missing. Every value here used to be read where it was used, so a
 * mistake surfaced at 02:00 in the backup job, or in an escalation pass, or on a screen — the
 * three places nobody is watching. Now it surfaces at boot, in one line.
 *
 * **What refuses to start, and what only warns, is the whole design.** A refusal must be
 * reserved for a configuration that is broken or unsafe. Anything that merely leaves the
 * district *less protected* has to warn and keep running, because a process that will not
 * start is a district that cannot report an emergency — INV-01 outranks every other concern
 * here, exactly as it outranks a stale backup on `/health`.
 */

/** Values shipped in `.env.example`. Finding one in production means nobody filled it in. */
const EXAMPLE_VALUES: readonly string[] = [
  'postgres://user:password@localhost:5432/dnc_dev',
  'change-me',
  'REPLACE_ME',
];

export interface ConfigCheck {
  /** Fatal. The process must not start. */
  readonly refusals: readonly string[];
  /** Real gaps that must be visible, and must not stop the district working. */
  readonly warnings: readonly string[];
  /** One line for the boot log: what is on, what is off. Never contains a secret value. */
  readonly summary: Record<string, string>;
}

import { proactiveFromEnv } from './ops/whatsapp.js';

export type Env = Readonly<Partial<Record<string, string>>>;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function looksLikeExample(value: string): boolean {
  const v = value.trim();
  return EXAMPLE_VALUES.some((example) => v === example) || /\bchange[-_ ]?me\b/i.test(v);
}

/**
 * Decide what to say about this environment.
 *
 * Pure, so the interesting cases are unit tests rather than something you find out by
 * deploying. `main.ts` does the logging and the exiting.
 */
export function checkConfiguration(env: Env, nodeEnv: string): ConfigCheck {
  const production = nodeEnv === 'production';
  const refusals: string[] = [];
  const warnings: string[] = [];

  const databaseUrl = env['DATABASE_URL'];
  if (!present(databaseUrl)) {
    refusals.push('DATABASE_URL is not set — there is nowhere to read or write the record');
  } else if (production && looksLikeExample(databaseUrl)) {
    refusals.push(
      'DATABASE_URL is still the value from .env.example — this deployment was never configured',
    );
  }

  // Off-site backup. Two variables that only mean anything together, which is precisely the
  // pair somebody sets one half of.
  const bucket = env['GCS_BUCKET'];
  const token = env['GCS_TOKEN'];
  const passphrase = env['BACKUP_PASSPHRASE'];

  /**
   * S3 needs **four** values, and it is the same trap in a bigger size: somebody sets the
   * endpoint and the bucket, and the keys arrive tomorrow. Each half-set combination is named
   * rather than lumped into "not configured", because the second one reads as *nothing was
   * attempted* when the truth is *you nearly have it*.
   */
  const s3 = {
    endpoint: env['S3_ENDPOINT'],
    bucket: env['S3_BUCKET'],
    key: env['S3_ACCESS_KEY_ID'],
    secret: env['S3_SECRET_ACCESS_KEY'],
  };
  const s3Wanted = Object.values(s3).some(present);

  if (s3Wanted) {
    for (const [name, value] of [
      ['S3_ENDPOINT', s3.endpoint],
      ['S3_BUCKET', s3.bucket],
      ['S3_ACCESS_KEY_ID', s3.key],
      ['S3_SECRET_ACCESS_KEY', s3.secret],
    ] as const) {
      if (!present(value)) {
        warnings.push(`off-site backup is partly configured: ${name} is missing (R-06)`);
      }
    }
  }

  const offsiteWanted = s3Wanted || present(bucket) || present(token);

  if (offsiteWanted && !s3Wanted) {
    if (!present(bucket)) {
      warnings.push('GCS_TOKEN is set but GCS_BUCKET is not — nothing will be sent off-site');
    }
    if (!present(token)) {
      warnings.push('GCS_BUCKET is set but GCS_TOKEN is not — nothing will be sent off-site');
    }
  }

  if (offsiteWanted) {
    if (!present(passphrase)) {
      // Not a refusal. The upload already refuses to send anything unencrypted, so the record
      // is not at risk — what is at risk is somebody believing the off-site copy is happening.
      warnings.push(
        'off-site backup is configured but BACKUP_PASSPHRASE is not set — the upload will ' +
          'refuse every night rather than send the district’s record out in the clear (R-06)',
      );
    } else if (passphrase.length < 16) {
      warnings.push(
        'BACKUP_PASSPHRASE is shorter than 16 characters — the upload will refuse it (R-06)',
      );
    } else if (production && looksLikeExample(passphrase)) {
      refusals.push(
        'BACKUP_PASSPHRASE is still an example value — every off-site copy would be ' +
          'encrypted with a passphrase that is published in this repository',
      );
    }
  } else {
    warnings.push(
      'no off-site backup configured (S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / ' +
        'S3_SECRET_ACCESS_KEY / BACKUP_PASSPHRASE) — nightly dumps stay on the same machine as ' +
        'the database, so losing it loses both (R-06)',
    );
  }

  /**
   * **The proactive switch, said out loud at boot** — Phase 5.
   *
   * A warning rather than a refusal, and the direction is the whole of it: an unrecognised word
   * leaves the feature **off**, which is a message that does not arrive rather than one that does.
   * INV-01 outranks a courtesy message the same way it outranks a missing backup bucket, so
   * nothing here can stop a district reporting an emergency.
   *
   * Named in the warning, because a district that typed `WHATSAPP_PROACTIVE=nudges` and got
   * silence needs to be told which word was the problem — at boot, not by noticing over a week
   * that no nudges arrived.
   */
  const proactive = proactiveFromEnv(env);
  for (const word of proactive.unrecognised) {
    warnings.push(
      `WHATSAPP_PROACTIVE names "${word}", which is not one of nudge, closed or summary — ` +
        'that part of the value does nothing, and an unrecognised word never switches anything on',
    );
  }

  return {
    refusals,
    warnings,
    summary: {
      nodeEnv,
      database: present(databaseUrl) ? 'configured' : 'MISSING',
      // Never the value, and never its length: both are facts about a secret.
      offsiteBackup: offsiteWanted && present(passphrase) ? 'configured' : 'not configured',
      weatherPoint: present(env['WEATHER_LAT']) ? 'overridden' : 'Khar (Bajaur HQ) default (R-16)',
      escalationIntervalMs: env['ESCALATION_INTERVAL_MS'] ?? '15000',
      // Never a boolean. `off` is the default and the word somebody greps the boot log for.
      whatsappProactive:
        proactive.enabled.size === 0 ? 'off' : [...proactive.enabled].sort().join(', '),
    },
  };
}
