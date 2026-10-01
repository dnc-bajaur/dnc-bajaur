/**
 * The boot-time configuration check — M0-05.
 *
 * The property under test is not "does it spot a missing variable". It is **which mistakes
 * stop the process and which ones only warn**, because getting that backwards is how a
 * district stops being able to report emergencies over a backup setting.
 */

import { describe, expect, it } from 'vitest';
import { checkConfiguration, type Env } from '../config.js';

const REAL_DB = 'postgres://dnc:s3cret@10.0.0.4:5432/dnc';
const REAL_PASSPHRASE = 'a-real-passphrase-kept-off-this-machine';

function env(overrides: Env = {}): Env {
  return { DATABASE_URL: REAL_DB, ...overrides };
}

describe('the boot configuration check', () => {
  describe('what stops the process', () => {
    it('refuses to start with no DATABASE_URL', () => {
      const result = checkConfiguration({}, 'production');

      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]).toMatch(/DATABASE_URL/);
    });

    it('refuses a production deployment still holding the example connection string', () => {
      const result = checkConfiguration(
        { DATABASE_URL: 'postgres://user:password@localhost:5432/dnc_dev' },
        'production',
      );

      expect(result.refusals.join(' ')).toMatch(/never configured/);
    });

    it('allows that same example value in development, which is what it is for', () => {
      const result = checkConfiguration(
        { DATABASE_URL: 'postgres://user:password@localhost:5432/dnc_dev' },
        'development',
      );

      expect(result.refusals).toHaveLength(0);
    });

    it('refuses a production passphrase that is still an example', () => {
      const result = checkConfiguration(
        env({ GCS_BUCKET: 'b', GCS_TOKEN: 't', BACKUP_PASSPHRASE: 'change-me-please!!' }),
        'production',
      );

      // Every off-site copy would be encrypted with a passphrase published in this repository.
      expect(result.refusals.join(' ')).toMatch(/example value/);
    });
  });

  describe('what must only ever warn', () => {
    /**
     * The one that matters most.
     *
     * A district with no cloud bucket must still be able to take emergencies. Refusing to
     * start here would mean R-06 — an unanswered procurement question — could stop Bajaur
     * reporting a road accident. INV-01 outranks a backup that has not left the building,
     * exactly as it does on `/health`.
     */
    it('starts perfectly well with no off-site backup at all, and says so', () => {
      const result = checkConfiguration(env(), 'production');

      expect(result.refusals).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/no off-site backup configured/);
      expect(result.warnings.join(' ')).toMatch(/R-06/);
    });

    it('warns when a bucket is set with no passphrase, rather than refusing', () => {
      const result = checkConfiguration(env({ GCS_BUCKET: 'b', GCS_TOKEN: 't' }), 'production');

      expect(result.refusals).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/BACKUP_PASSPHRASE is not set/);
    });

    it('warns on a passphrase the upload will reject as too short', () => {
      const result = checkConfiguration(
        env({ GCS_BUCKET: 'b', GCS_TOKEN: 't', BACKUP_PASSPHRASE: 'short' }),
        'production',
      );

      expect(result.refusals).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/shorter than 16/);
    });

    it('warns when half the off-site pair is set — the half nobody notices', () => {
      const result = checkConfiguration(
        env({ GCS_BUCKET: 'b', BACKUP_PASSPHRASE: REAL_PASSPHRASE }),
        'production',
      );

      expect(result.refusals).toHaveLength(0);
      expect(result.warnings.join(' ')).toMatch(/GCS_BUCKET is set but GCS_TOKEN is not/);
    });
  });

  describe('the boot line', () => {
    it('reports a fully configured deployment as configured', () => {
      const result = checkConfiguration(
        env({ GCS_BUCKET: 'b', GCS_TOKEN: 't', BACKUP_PASSPHRASE: REAL_PASSPHRASE }),
        'production',
      );

      expect(result.refusals).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.summary['offsiteBackup']).toBe('configured');
      expect(result.summary['database']).toBe('configured');
    });

    /**
     * The summary goes into a log line, and `obs/log.ts` redacts by key name. This asserts the
     * value never got there in the first place — the redactor is the second line of defence,
     * not the first.
     */
    it('never carries a secret, or anything derived from one', () => {
      const result = checkConfiguration(
        env({ GCS_BUCKET: 'bucket-name', GCS_TOKEN: 't', BACKUP_PASSPHRASE: REAL_PASSPHRASE }),
        'production',
      );

      const rendered = JSON.stringify(result.summary);
      expect(rendered).not.toContain(REAL_PASSPHRASE);
      expect(rendered).not.toContain('s3cret');
      expect(rendered).not.toContain(String(REAL_PASSPHRASE.length));
    });

    it('names the weather point as a default until the district picks one (R-16)', () => {
      expect(checkConfiguration(env(), 'production').summary['weatherPoint']).toMatch(/default/);
      expect(
        checkConfiguration(env({ WEATHER_LAT: '32.9' }), 'production').summary['weatherPoint'],
      ).toBe('overridden');
    });
  });
});
