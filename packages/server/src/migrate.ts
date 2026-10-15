import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { migration, type FileSource, type Migration } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { readToolBytes, TOOLS_DIR } from "./files.ts";
import { DEFAULT_TEMPLATE } from "./new-novel.ts";
import { transaction, type FileWrite, type OperationResult } from "./operations.ts";

/*
 * Moving a novel to the newest format (D11) as one commit: core's migration of its files, and the
 * novel template's vendored tools (.github/gh-writer/), so the novel's own workflows read the new format.
 */

/** What migrating the novel at `root` would write, with the tools from `templateDir` where the novel has them. */
export async function migrationWrites(root: string, templateDir = DEFAULT_TEMPLATE): Promise<{ migration: Migration; writes: FileWrite[] }> {
  const m = await migration(nodeSource(root));
  if (m.status !== "migrate") return { migration: m, writes: [] };
  return { migration: m, writes: [...m.writes, ...(await toolWrites(root, templateDir))] };
}

/** Migrate the novel at `root` in one commit. Nothing is written unless the migration's status is "migrate". */
export async function migrateNovel(root: string, templateDir = DEFAULT_TEMPLATE): Promise<{ migration: Migration; result?: OperationResult }> {
  const { migration: m, writes } = await migrationWrites(root, templateDir);
  if (m.status !== "migrate") return { migration: m };
  return { migration: m, result: await transaction(root, writes, m.message) };
}

/**
 * `base` as it will be once `writes` are made: their text read in place of what's on disk, files they
 * remove gone, and files they add listed. (Binary writes read as nothing: no model reads them.)
 */
export function overlay(base: FileSource, writes: FileWrite[]): FileSource {
  const changed = new Map(writes.map((w) => [w.path, w.content]));
  return {
    async list(dir) {
      const prefix = dir ? `${dir}/` : "";
      const entries = new Map((await base.list(dir)).map((e) => [e.name, e.dir]));
      for (const [path, content] of changed) {
        if (!path.startsWith(prefix) || path.split("/").some((s) => s.startsWith("."))) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) entries.set(rest.slice(0, slash), true);
        else if (content === null) entries.delete(rest);
        else entries.set(rest, false);
      }
      return [...entries].map(([name, isDir]) => ({ name, dir: isDir })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(path) {
      if (!changed.has(path)) return base.read(path);
      const content = changed.get(path);
      return typeof content === "string" ? content : undefined;
    },
  };
}

/** The template's tools that differ from the novel's, for a novel that carries tools at all. */
async function toolWrites(root: string, templateDir: string): Promise<FileWrite[]> {
  const theirs = await listFiles(join(root, TOOLS_DIR));
  if (!theirs.length) return [];
  const writes: FileWrite[] = [];
  for (const name of await listFiles(join(templateDir, TOOLS_DIR))) {
    const path = `${TOOLS_DIR}/${name}`;
    const bytes = await readFile(join(templateDir, TOOLS_DIR, name));
    const current = await readToolBytes(root, path);
    if (!current || !current.bytes.equals(bytes)) writes.push({ path, content: new Uint8Array(bytes), tool: true });
  }
  return writes;
}

/** Files under `dir`, as paths relative to it, sorted; none if it isn't there. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/"))
    .sort();
}
