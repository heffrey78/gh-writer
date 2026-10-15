import { resolve } from "node:path";
import { migrateNovel } from "@gh-writer/server";

/** Move the novel in `dir` to the newest format, as one commit, and return the process exit code. */
export async function runMigrate(dir: string, out: (s: string) => void = console.log, err: (s: string) => void = console.error): Promise<number> {
  const root = resolve(dir);
  const { migration, result } = await migrateNovel(root);
  if (migration.status === "current") {
    out("Already in the newest format: nothing to do.");
    return 0;
  }
  if (migration.status === "refused") {
    err(migration.reason);
    return 1;
  }
  out(`Moved from format v${migration.from} to v${migration.to}, ${result?.commit ? `in commit ${result.commit.slice(0, 7)}` : "with nothing to commit"}: “${migration.message}”.`);
  for (const path of result?.files ?? []) out(`  ${path}`);
  return 0;
}
