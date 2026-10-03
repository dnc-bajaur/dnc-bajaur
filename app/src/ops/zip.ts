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
 * **ZIP64 where it is needed, and only there.** The classic format stops at 4 GB and 65 535
 * entries, and three days of a district's *videos* can pass 4 GB — the archive used to be refused
 * there, on the one day the DC most needed it. Past either limit the central directory carries
 * 64-bit offsets and a ZIP64 end record follows it; an archive below both is byte for byte the
 * classic one it always was. Windows Explorer, 7-Zip and `unzip` 6 all read ZIP64.
 *
 * One entry is still at most 4 GB (the largest file here is a 300 MB video), so an entry's own
 * sizes never need 64 bits — only where it sits in the archive does.
 */

import { crc32 } from 'node:zlib';

/** Where the classic format's 32-bit and 16-bit fields run out. */
const MAX_32 = 0xffff_ffff;
const MAX_16 = 0xffff;

/** One entry's own limit: its size is written in 32 bits. */
export const ZIP_MAX_ENTRY_BYTES = MAX_32 - 1;
/** Far beyond anything a server holds; the sum must stay an exact integer. */
export const ZIP_MAX_BYTES = Number.MAX_SAFE_INTEGER;
export const ZIP_MAX_ENTRIES = MAX_32 - 1;

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
      const size = entry.bytes.length;
      if (size > ZIP_MAX_ENTRY_BYTES) {
        throw new Error('one file in a ZIP may be at most 4 GB');
      }
      const crc = crc32(entry.bytes);
      const { time, date } = dosTime(entry.modified);
      // Past 4 GB into the archive, where this entry starts no longer fits in 32 bits.
      const far = offset >= MAX_32;
      const version = far ? 45 : 20; // 4.5 is the version that reads ZIP64

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

      // The ZIP64 extra field: only the value that overflowed is in it — here, the offset.
      const extra = Buffer.alloc(far ? 12 : 0);
      if (far) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(offset), 4);
      }

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(version, 4); // version made by
      header.writeUInt16LE(version, 6); // version needed
      header.writeUInt16LE(UTF8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(size, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      // comment, disk, internal attributes, external attributes: all zero
      header.writeUInt32LE(far ? MAX_32 : offset, 42);
      central.push(header, name, extra);

      const out = Buffer.concat([local, name, entry.bytes]);
      offset += out.length;
      count += 1;
      return out;
    },

    finish(): Buffer {
      const directory = Buffer.concat(central);
      const big = count >= MAX_16 || offset >= MAX_32 || directory.length >= MAX_32;

      // The classic end record always closes the file; a field that overflowed holds all ones,
      // which is what sends a reader to the ZIP64 record in front of it.
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(Math.min(count, MAX_16), 8);
      end.writeUInt16LE(Math.min(count, MAX_16), 10);
      end.writeUInt32LE(Math.min(directory.length, MAX_32), 12);
      end.writeUInt32LE(Math.min(offset, MAX_32), 16);
      if (!big) return Buffer.concat([directory, end]);

      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4); // the size of the rest of this record
      end64.writeUInt16LE(45, 12); // version made by
      end64.writeUInt16LE(45, 14); // version needed
      // disk numbers: zero
      end64.writeBigUInt64LE(BigInt(count), 24);
      end64.writeBigUInt64LE(BigInt(count), 32);
      end64.writeBigUInt64LE(BigInt(directory.length), 40);
      end64.writeBigUInt64LE(BigInt(offset), 48);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); // where `end64` starts
      locator.writeUInt32LE(1, 16); // one disk
      return Buffer.concat([directory, end64, locator, end]);
    },
  };
}
