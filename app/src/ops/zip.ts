/**
 * A ZIP archive, written as it goes — for the Activities "download before it expires" button
 * (ADR-0039 §7, Bajaur — phase C2).
 *
 * **No dependency, and no compression.** Every file put in here is a JPEG, PNG or WebP that is
 * already compressed, plus one small text index; deflating them again would cost the server CPU
 * and save nothing. "Stored" entries are the simplest thing every unzip tool reads — Windows
 * Explorer included, which is what the DC office will open it with.
 *
 * Each entry is written whole (a photo is at most 8 MB), so its size and CRC are known before
 * its header is written: no data descriptors, nothing a strict reader could disagree with.
 *
 * **No ZIP64.** An archive is refused past 4 GB or 65 535 entries rather than written wrong —
 * the caller checks `fits` first. Three days of a district's photos are far below either.
 */

import { crc32 } from 'node:zlib';

/** The classic format's limits, with room left for the headers themselves. */
export const ZIP_MAX_BYTES = 0xffff_ffff - 64 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 0xffff;

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Buffer;
  readonly modified: Date;
}

/** Will `count` files totalling `bytes` fit in an archive this writer can make? */
export function fits(count: number, bytes: number): boolean {
  return count <= ZIP_MAX_ENTRIES && bytes <= ZIP_MAX_BYTES;
}

/** MS-DOS date and time — what the format stores. Local wall-clock of the given instant. */
function dosTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** Bit 11: the name is UTF-8 — department names and captions are not ASCII-only. */
const UTF8 = 0x0800;

export interface ZipWriter {
  /** The bytes of one entry's local header and data, to be written in order. */
  add(entry: ZipEntry): Buffer;
  /** The central directory and end record, written last. */
  finish(): Buffer;
}

export function zipWriter(): ZipWriter {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  return {
    add(entry): Buffer {
      const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
      const crc = crc32(entry.bytes);
      const size = entry.bytes.length;
      const { time, date } = dosTime(entry.modified);
      if (count + 1 > ZIP_MAX_ENTRIES || offset + size > ZIP_MAX_BYTES) {
        throw new Error('this archive would need ZIP64, which this writer does not produce');
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed: 2.0
      local.writeUInt16LE(UTF8, 6);
      local.writeUInt16LE(0, 8); // method: stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(UTF8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(size, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      // extra, comment, disk, internal attributes, external attributes: all zero
      header.writeUInt32LE(offset, 42);
      central.push(header, name);

      const out = Buffer.concat([local, name, entry.bytes]);
      offset += out.length;
      count += 1;
      return out;
    },

    finish(): Buffer {
      const directory = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(directory.length, 12);
      end.writeUInt32LE(offset, 16);
      return Buffer.concat([directory, end]);
    },
  };
}
