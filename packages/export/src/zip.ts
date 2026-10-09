import { strToU8, zipSync, type Zippable } from "fflate";

/** A file in an archive: stored as is (an EPUB's mimetype must be) or compressed. */
export interface ZipEntry {
  path: string;
  data: string | Uint8Array;
  store?: boolean;
}

/**
 * A zip of `entries`, in their order, every file dated `date`: the same entries and date always give
 * the same bytes, so a book compiled twice from one commit is the same file.
 */
export function zip(entries: ZipEntry[], date: Date): Uint8Array {
  const files: Zippable = {};
  for (const e of entries) files[e.path] = [typeof e.data === "string" ? strToU8(e.data) : e.data, { level: e.store ? 0 : 6, mtime: date }];
  return zipSync(files);
}
