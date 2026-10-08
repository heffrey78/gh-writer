import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { SNAPSHOT_MARKER, snapshots } from "@gh-writer/core/snapshots";

export interface SnapshotsOptions {
  /** Only report whether the snapshots are current: exit 1 if any would change. */
  check?: boolean;
}

/**
 * Write the novel's diagram snapshots (diagrams/*.svg and diagrams/README.md), only the files whose
 * content changes, and say which. Returns the process exit code.
 */
export async function runSnapshots(dir: string, options: SnapshotsOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const root = resolve(dir);
  const novel = await loadNovel(nodeSource(root));
  if (!novel.config) {
    out(`No novel here: ${root} has no novel.yaml.`);
    return 1;
  }
  const changed: string[] = [];
  const removed: string[] = [];
  const files = snapshots(novel);
  // A snapshot no longer drawn (its diagram has nothing to show now) goes, if it's one we wrote.
  for (const name of await readdir(join(root, "diagrams")).catch(() => [] as string[])) {
    const path = `diagrams/${name}`;
    if (!name.endsWith(".svg") || files.has(path)) continue;
    if (!(await readFile(join(root, path), "utf8")).includes(SNAPSHOT_MARKER)) continue;
    removed.push(path);
    if (!options.check) await rm(join(root, path));
  }
  for (const [path, content] of files) {
    const full = join(root, path);
    const current = await readFile(full, "utf8").catch(() => undefined);
    if (current === content) continue;
    changed.push(path);
    if (options.check) continue;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  if (!changed.length && !removed.length) out("Diagram snapshots are up to date.");
  else if (options.check) out(`Out of date: ${[...changed, ...removed].join(", ")}`);
  else out([changed.length ? `Wrote ${changed.join(", ")}` : "", removed.length ? `Removed ${removed.join(", ")}` : ""].filter(Boolean).join("; "));
  return options.check && (changed.length || removed.length) ? 1 : 0;
}
