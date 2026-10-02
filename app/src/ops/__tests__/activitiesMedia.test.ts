/**
 * Activities, phase C2 — the pieces with no database (ADR-0039 §7–8, Bajaur).
 *
 *   * the ZIP is a real ZIP: every entry readable back, its CRC right, its UTF-8 name intact —
 *     checked by reading the bytes, not by trusting the writer;
 *   * the media bucket is a separate bucket on the same S3 account, deletes are signed like
 *     uploads, an object already gone is not an error, and an unconfigured bucket says so.
 */

import { describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';

import { fits, zipWriter, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from '../zip.js';
import { mediaStore } from '../offsite.js';

interface Read {
  readonly name: string;
  readonly bytes: Buffer;
  readonly utf8: boolean;
}

/** Read an archive the way an unzip tool does: from the end record, through the directory. */
function unzip(zip: Buffer): Read[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Read[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(at + 8);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt16LE(local + 8)).toBe(0); // stored
    const localName = zip.readUInt16LE(local + 26);
    const extra = zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(
      local + 30 + localName + extra,
      local + 30 + localName + extra + size,
    );
    expect(crc32(bytes)).toBe(crc);

    out.push({ name, bytes: Buffer.from(bytes), utf8: (flags & 0x0800) !== 0 });
    at += 46 + nameLength;
  }
  return out;
}

describe('the ZIP', () => {
  it('reads back every entry, byte for byte, with its UTF-8 name', () => {
    const zip = zipWriter();
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const parts = [
      zip.add({
        name: '2026-10-01 ریسکیو - Officer/photo-01.jpg',
        bytes: photo,
        modified: new Date('2026-10-01T10:00:00Z'),
      }),
      zip.add({ name: 'activities.csv', bytes: Buffer.from('"a","b"\r\n'), modified: new Date() }),
      zip.finish(),
    ];
    const read = unzip(Buffer.concat(parts));
    expect(read.map((r) => r.name)).toEqual([
      '2026-10-01 ریسکیو - Officer/photo-01.jpg',
      'activities.csv',
    ]);
    expect(read[0]!.bytes.equals(photo)).toBe(true);
    expect(read.every((r) => r.utf8)).toBe(true);
  });

  it('is a valid empty archive with nothing in it', () => {
    expect(unzip(zipWriter().finish())).toEqual([]);
  });

  it('refuses what would need ZIP64 rather than writing it wrong', () => {
    expect(fits(10, 1024)).toBe(true);
    expect(fits(ZIP_MAX_ENTRIES + 1, 0)).toBe(false);
    expect(fits(1, ZIP_MAX_BYTES + 1)).toBe(false);
  });
});

describe('the media bucket', () => {
  const env = {
    S3_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com/',
    S3_BUCKET: 'bajaur-dnc-backups',
    ACTIVITIES_S3_BUCKET: 'bajaur-dnc-activities',
    S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_REGION: 'auto',
  };
  const at = (): Date => new Date('2026-10-02T00:00:00Z');

  it('says what is missing, and refuses rather than pretending', async () => {
    // The dump bucket alone is not a media bucket: the two are kept apart on purpose.
    const store = mediaStore({ ...env, ACTIVITIES_S3_BUCKET: undefined });
    expect(store.configured).toBe(false);
    expect(store.why).toContain('ACTIVITIES_S3_BUCKET');
    await expect(store.put('k', Buffer.from('x'))).rejects.toThrow();
    await expect(store.remove('k')).rejects.toThrow();
  });

  it('uploads to its own bucket, never the dump bucket', async () => {
    const http = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    await mediaStore(env, http as unknown as typeof fetch, at).put(
      'activities/a/b.jpg.enc',
      Buffer.from('x'),
    );
    expect(String((http.mock.calls[0] as unknown[])[0])).toBe(
      'https://acct123.r2.cloudflarestorage.com/bajaur-dnc-activities/activities/a/b.jpg.enc',
    );
  });

  it('signs a delete, and treats an object already gone as removed', async () => {
    const http = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    const store = mediaStore(env, http as unknown as typeof fetch, at);
    await store.remove('activities/a/b.jpg.enc');
    const init = (http.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['authorization']).toContain('AWS4-HMAC-SHA256');

    const gone = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(
      mediaStore(env, gone as unknown as typeof fetch, at).remove('k'),
    ).resolves.toBeUndefined();
  });

  it('throws on a refused delete, so it stays queued', async () => {
    const http = vi.fn(() => Promise.resolve(new Response('', { status: 403 })));
    await expect(mediaStore(env, http as unknown as typeof fetch, at).remove('k')).rejects.toThrow(
      /access key/,
    );
  });
});
