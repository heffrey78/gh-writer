import { strToU8, zipSync, type Zippable } from "fflate";

/** A file in an archive: stored as is (an EPUB's mimetype must be) or compressed. */
export interface ZipEntry {
  path: string;
  data: string | Uint8Array;
  store?: boolean;
}

/**
 * A zip of `entries`, in their order, every file dated `date`: the same entries and date always give
 * the same bytes, so a book compiled twice from one commit is the same file, on any machine.
 */
/** What fflate is told (in local time, which it takes): `stamp` writes the real date over it. */
const PLACEHOLDER = new Date(2000, 0, 1);

export function zip(entries: ZipEntry[], date: Date): Uint8Array {
  // Zip can't hold a date before 1980: its first day instead.
  const d = date.getUTCFullYear() < 1980 ? new Date(Date.UTC(1980, 0, 1)) : date;
  const files: Zippable = {};
  for (const e of entries) files[e.path] = [typeof e.data === "string" ? strToU8(e.data) : e.data, { level: e.store ? 0 : 6, mtime: PLACEHOLDER }];
  return stamp(zipSync(files), d);
}

/**
 * Date every file `date` in UTC. A zip's dates are wall-clock times without a zone, and fflate writes
 * the machine's local time: the author's machine and GitHub's (UTC) would make different bytes.
 */
function stamp(archive: Uint8Array, d: Date): Uint8Array {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let p = 0;
  // Each file's local header (its size known: fflate writes no data descriptors), then the central directory.
  while (p + 30 <= archive.length && view.getUint32(p, true) === 0x04034b50) {
    view.setUint16(p + 10, time, true);
    view.setUint16(p + 12, day, true);
    p += 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true) + view.getUint32(p + 18, true);
  }
  while (p + 46 <= archive.length && view.getUint32(p, true) === 0x02014b50) {
    view.setUint16(p + 12, time, true);
    view.setUint16(p + 14, day, true);
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return archive;
}
