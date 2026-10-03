/**
 * What a reinstall must not lose from `.env`.
 *
 * `first-run.mjs` writes `.env` afresh on every run — it has to, because the port, the database
 * password and the paths are its own to decide. But the district adds settings to that file by
 * hand afterwards (the WhatsApp keys, the backup bucket and its passphrase), and a reinstall
 * that wrote the file from scratch silently took WhatsApp and off-site backup away.
 *
 * So: every `KEY=value` line the installer does not own is carried across, in the order it
 * stood. Comments and blank lines are not — the installer writes its own — and neither is a line
 * for a key the installer owns, because the value it is about to write is the true one.
 */

/** The keys `first-run.mjs` decides. Anything else in the file is the district's. */
export const INSTALLER_KEYS = Object.freeze([
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'DATABASE_URL',
  'PG_BIN',
  'BACKUP_DIR',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
]);

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The lines of an existing `.env` to keep, exactly as written.
 *
 * A key set twice keeps only its last line: that is the one the application was reading.
 *
 * @param {string} existing the file's text ('' when there was none)
 * @param {readonly string[]} [owned] keys the caller writes itself
 * @returns {string[]}
 */
export function keptLines(existing, owned = INSTALLER_KEYS) {
  const kept = new Map();
  for (const line of existing.split(/\r?\n/)) {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key === undefined || owned.includes(key)) continue;
    kept.delete(key); // so a repeated key takes its last position as well as its last value
    kept.set(key, line.trimEnd());
  }
  return [...kept.values()];
}
