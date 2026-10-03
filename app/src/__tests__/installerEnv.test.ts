/**
 * A reinstall keeps the settings the district added to `.env` by hand.
 *
 * The Windows installer's `first-run.mjs` writes `.env` afresh on every run. Until 2026-10-03 it
 * wrote only its own lines, so running Setup again took the WhatsApp keys and the backup bucket
 * away without a word — the district would have found out when a message did not go, or when a
 * backup was needed. `installer/runtime/env-merge.mjs` decides what is carried across.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { INSTALLER_KEYS, keptLines } from '../../../installer/runtime/env-merge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const firstRun = readFileSync(
  join(here, '..', '..', '..', 'installer', 'runtime', 'first-run.mjs'),
  'utf8',
);

describe('what a reinstall keeps from .env', () => {
  const old = [
    '# District Nerve Center — written by the installer.',
    'NODE_ENV=production',
    'PORT=3000',
    'DATABASE_URL=postgres://dnc:old@127.0.0.1:5432/dnc',
    '',
    '# GCS_BUCKET=',
    'WHATSAPP_TOKEN=abc=def',
    '  BACKUP_PASSPHRASE = a long passphrase kept offline  ',
    'export ACTIVITIES_S3_BUCKET=media',
  ].join('\r\n');

  it('carries every setting the installer does not own, as written', () => {
    expect(keptLines(old)).toEqual([
      'WHATSAPP_TOKEN=abc=def',
      '  BACKUP_PASSPHRASE = a long passphrase kept offline',
      'export ACTIVITIES_S3_BUCKET=media',
    ]);
  });

  it('drops the installer’s own keys, comments and blank lines', () => {
    const kept = keptLines(old).join('\n');
    expect(kept).not.toContain('DATABASE_URL');
    expect(kept).not.toContain('PORT=');
    expect(kept).not.toContain('#');
  });

  it('keeps only the last line of a key set twice', () => {
    expect(keptLines('A=1\nB=2\nA=3\n')).toEqual(['B=2', 'A=3']);
  });

  it('keeps nothing from a missing or empty file', () => {
    expect(keptLines('')).toEqual([]);
  });

  it('lets the caller keep a key it is not writing this time', () => {
    const owned = INSTALLER_KEYS.filter((key) => !key.startsWith('FF'));
    expect(keptLines('FFMPEG_PATH=C:\\tools\\ffmpeg.exe\nPORT=1', owned)).toEqual([
      'FFMPEG_PATH=C:\\tools\\ffmpeg.exe',
    ]);
  });

  it('owns exactly the keys first-run writes', () => {
    // A key first-run starts writing must be added to INSTALLER_KEYS, or a reinstall writes it
    // twice — once fresh, once carried — and the carried (older) line wins.
    const from = firstRun.search(/writeFileSync\(\s*envFile/);
    expect(from).toBeGreaterThan(-1);
    const block = firstRun.slice(from, firstRun.indexOf("'utf8'", from));
    const written = [...block.matchAll(/[`'](?:# )?([A-Z][A-Z0-9_]*)=/g)]
      .map((m) => m[1]!)
      .filter((key) => !['GCS_BUCKET', 'GCS_TOKEN', 'BACKUP_PASSPHRASE'].includes(key));
    expect([...new Set(written)].sort()).toEqual([...INSTALLER_KEYS].sort());
  });

  it('is what first-run uses', () => {
    expect(firstRun).toContain("from './env-merge.mjs'");
    expect(firstRun).toContain('...carried');
  });
});
