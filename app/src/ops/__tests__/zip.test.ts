/**
 * The ZIP writer — the Activities "download before it expires" archive (ADR-0039 §7), PLAN F6.
 *
 * Until 2026-10-03 the writer stopped at the classic format's limits and the route refused the
 * download past 4 GB — which three days of videos can reach, on the day the DC most needs the
 * copy. It now writes ZIP64 past either limit. Pinned here, read back by a reader written from
 * the format's own specification (APPNOTE 4.3.14–4.3.16, 4.5.3), not by the writer's own code:
 *
 *   * a small archive is still the classic one — no ZIP64 record anywhere in it;
 *   * past 65 535 entries, the count is in the ZIP64 end record and every entry reads back;
 *   * past 4 GB, an entry that starts beyond 32 bits carries its true offset, and the ZIP64 end
 *     record says where the directory is.
 */

import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { fits, zipWriter } from '../zip.js';

const MAX_32 = 0xffff_ffff;

interface Listed {
  readonly name: string;
  readonly size: number;
  readonly crc: number;
  readonly offset: number;
  readonly version: number;
  readonly zip64: boolean;
}

interface Read {
  readonly entries: Listed[];
  readonly count: number;
  readonly directoryOffset: number;
  /** Whether a ZIP64 end record and its locator are present. */
  readonly zip64: boolean;
  /** The classic end record's own fields, as written. */
  readonly classic: { readonly count: number; readonly directoryOffset: number };
}

/**
 * Read an archive's directory from its tail. `tail` is the end of the archive and `tailStart`
 * is where in the archive it begins — so a 4 GB archive can be checked without holding it.
 */
function readDirectory(tail: Buffer, tailStart: number): Read {
  const at = (absolute: number): number => absolute - tailStart;
  const end = tail.length - 22;
  expect(tail.readUInt32LE(end)).toBe(0x06054b50);
  const classic = {
    count: tail.readUInt16LE(end + 10),
    directoryOffset: tail.readUInt32LE(end + 16),
  };

  let count = classic.count;
  let directorySize = tail.readUInt32LE(end + 12);
  let directoryOffset = classic.directoryOffset;
  const zip64 = end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50;
  if (zip64) {
    const locator = end - 20;
    expect(tail.readUInt32LE(locator + 16)).toBe(1); // one disk
    const end64 = at(Number(tail.readBigUInt64LE(locator + 8)));
    expect(tail.readUInt32LE(end64)).toBe(0x06064b50);
    expect(tail.readBigUInt64LE(end64 + 4)).toBe(44n);
    expect(tail.readUInt16LE(end64 + 14)).toBe(45);
    expect(tail.readBigUInt64LE(end64 + 24)).toBe(tail.readBigUInt64LE(end64 + 32));
    count = Number(tail.readBigUInt64LE(end64 + 32));
    directorySize = Number(tail.readBigUInt64LE(end64 + 40));
    directoryOffset = Number(tail.readBigUInt64LE(end64 + 48));
    // The record sits immediately after the directory it describes.
    expect(end64).toBe(at(directoryOffset) + directorySize);
  }

  const entries: Listed[] = [];
  let p = at(directoryOffset);
  for (let i = 0; i < count; i++) {
    expect(tail.readUInt32LE(p)).toBe(0x02014b50);
    const version = tail.readUInt16LE(p + 6);
    const nameLength = tail.readUInt16LE(p + 28);
    const extraLength = tail.readUInt16LE(p + 30);
    let offset = tail.readUInt32LE(p + 42);
    const extra = p + 46 + nameLength;
    const has64 = extraLength > 0;
    if (has64) {
      // Only the overflowed value is in the field (4.5.3): here, the offset alone.
      expect(tail.readUInt16LE(extra)).toBe(0x0001);
      expect(tail.readUInt16LE(extra + 2)).toBe(8);
      expect(offset).toBe(MAX_32);
      offset = Number(tail.readBigUInt64LE(extra + 4));
    }
    entries.push({
      name: tail.toString('utf8', p + 46, p + 46 + nameLength),
      size: tail.readUInt32LE(p + 24),
      crc: tail.readUInt32LE(p + 16),
      offset,
      version,
      zip64: has64,
    });
    p += 46 + nameLength + extraLength;
  }
  expect(p).toBe(at(directoryOffset) + directorySize);
  return { entries, count, directoryOffset, zip64, classic };
}

/** An entry's bytes, found from the directory and checked against its own local header. */
function extract(archive: Buffer, entry: Listed): Buffer {
  const p = entry.offset;
  expect(archive.readUInt32LE(p)).toBe(0x04034b50);
  const nameLength = archive.readUInt16LE(p + 26);
  expect(archive.toString('utf8', p + 30, p + 30 + nameLength)).toBe(entry.name);
  const start = p + 30 + nameLength + archive.readUInt16LE(p + 28);
  const data = archive.subarray(start, start + entry.size);
  expect(crc32(data)).toBe(entry.crc);
  return data;
}

const WHEN = new Date('2026-10-03T10:00:00');

describe('the ZIP writer', () => {
  it('writes a small archive as the classic format, with nothing ZIP64 in it', () => {
    const zip = zipWriter();
    const files = [
      { name: 'activities.csv', bytes: Buffer.from('a,b\r\n1,2\r\n') },
      {
        name: '2026-10-01 محکمہ/photo-01.jpg',
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      },
      { name: 'empty.txt', bytes: Buffer.alloc(0) },
    ];
    const parts = files.map((f) => zip.add({ ...f, modified: WHEN }));
    const archive = Buffer.concat([...parts, zip.finish()]);

    const read = readDirectory(archive, 0);
    expect(read.zip64).toBe(false);
    expect(read.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, entry] of read.entries.entries()) {
      expect(entry.version).toBe(20);
      expect(entry.zip64).toBe(false);
      expect(extract(archive, entry).equals(files[i]!.bytes)).toBe(true);
    }
    expect(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
    expect(archive.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(false);
  });

  it('writes more than 65 535 entries, and every one reads back', () => {
    const zip = zipWriter();
    const total = 70_000;
    const parts: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      parts.push(zip.add({ name: `f/${i}.txt`, bytes: Buffer.from(String(i)), modified: WHEN }));
    }
    const archive = Buffer.concat([...parts, zip.finish()]);

    const read = readDirectory(archive, 0);
    expect(read.zip64).toBe(true);
    expect(read.classic.count).toBe(0xffff); // "look in the ZIP64 record"
    expect(read.count).toBe(total);
    for (const i of [0, 65_534, 65_535, 65_536, total - 1]) {
      const entry = read.entries[i]!;
      expect(entry.name).toBe(`f/${i}.txt`);
      expect(extract(archive, entry).toString()).toBe(String(i));
    }
  }, 60_000);

  it('writes past 4 GB: an entry beyond 32 bits carries its true offset', () => {
    const zip = zipWriter();
    // 17 × 256 MB = 4.25 GB, written and dropped: only where each entry starts is kept.
    const block = Buffer.alloc(256 * 1024 * 1024, 7);
    const starts: number[] = [];
    let written = 0;
    for (let i = 0; i < 17; i++) {
      starts.push(written);
      written += zip.add({ name: `video-${i}.mp4`, bytes: block, modified: WHEN }).length;
    }
    expect(written).toBeGreaterThan(MAX_32);
    const tail = zip.finish();

    const read = readDirectory(tail, written);
    expect(read.zip64).toBe(true);
    expect(read.directoryOffset).toBe(written);
    expect(read.classic.directoryOffset).toBe(MAX_32);
    expect(read.entries.map((e) => e.offset)).toEqual(starts);
    for (const entry of read.entries) {
      const far = entry.offset >= MAX_32;
      expect(entry.zip64).toBe(far);
      expect(entry.version).toBe(far ? 45 : 20);
      expect(entry.size).toBe(block.length);
    }
    // Both kinds are in this archive, or the loop above proved nothing.
    expect(read.entries.some((e) => e.zip64)).toBe(true);
    expect(read.entries.some((e) => !e.zip64)).toBe(true);
  }, 180_000);

  it('refuses one file past 4 GB, which no entry here can be', () => {
    const huge = { length: MAX_32 } as unknown as Buffer;
    expect(() => zipWriter().add({ name: 'x', bytes: huge, modified: WHEN })).toThrow(/4 GB/);
  });

  it('says a download past the old 4 GB limit fits', () => {
    expect(fits(200, 6 * 1024 * 1024 * 1024)).toBe(true);
    expect(fits(100_000, 1024)).toBe(true);
  });
});
