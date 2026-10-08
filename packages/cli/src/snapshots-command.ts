import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { snapshots } from "@gh-writer/core/snapshots";

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
  for (const [path, content] of snapshots(novel)) {
    const full = join(root, path);
    const current = await readFile(full, "utf8").catch(() => undefined);
    if (current === content) continue;
    changed.push(path);
    if (options.check) continue;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  if (!changed.length) out("Diagram snapshots are up to date.");
  else if (options.check) out(`Out of date: ${changed.join(", ")}`);
  else out(`Wrote ${changed.join(", ")}`);
  return options.check && changed.length ? 1 : 0;
}
