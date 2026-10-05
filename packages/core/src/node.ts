import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirEntry, FileSource } from "./source.ts";

/** A FileSource over a directory on disk. Hidden entries (".git", ".github", ...) are not listed. */
export function nodeSource(root: string): FileSource {
  return {
    async list(dir) {
      let entries;
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
      return entries
        .filter((e) => !e.name.startsWith("."))
        .map((e): DirEntry => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    },
  };
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
