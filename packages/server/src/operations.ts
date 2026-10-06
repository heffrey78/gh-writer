import { readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasGitIdentity, IDENTITY_MESSAGE } from "./committer.ts";
import { atomicWrite, readText, writablePath } from "./files.ts";
import { git } from "./git.ts";

/** One file an operation writes (new text) or deletes (null). */
export interface FileWrite {
  path: string;
  content: string | null;
  /** The hash the caller read: the change is refused if the file is different now. Null: must not exist. Omitted: not checked. */
  base?: string | null;
}

export type OperationErrorCode = "BAD_REQUEST" | "NOT_FOUND" | "STALE" | "REFERENCED" | "BLOCKED";

export class OperationError extends Error {
  readonly code: OperationErrorCode;
  /** More for the client: the references that block a delete, the file that changed. */
  readonly details: Record<string, unknown>;

  constructor(code: OperationErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.details = details;
  }
}

export interface OperationResult {
  /** The commit that recorded it, or null if nothing changed. */
  commit: string | null;
  /** The files written or deleted. */
  files: string[];
}

/**
 * Apply `changes` to the novel at `root` as one unit and commit them as `message`. Every file is
 * checked against its base first; then they're written one by one (each atomically), and if any write
 * fails, the ones already made are put back as they were. Only these paths are committed: other saved
 * work stays for the background committer. Run it inside the workspace's exclusive section.
 */
export async function transaction(root: string, changes: FileWrite[], message: string): Promise<OperationResult> {
  if (!changes.length) return { commit: null, files: [] };
  if (!(await hasGitIdentity(root))) throw new OperationError("BLOCKED", IDENTITY_MESSAGE);

  // What's there now, for the base checks and to put back.
  const before = new Map<string, string | null>();
  for (const change of changes) {
    const current = await readText(root, change.path);
    if (change.base !== undefined && (current?.hash ?? null) !== change.base) {
      throw new OperationError("STALE", `“${change.path}” changed since it was read.`, { path: change.path });
    }
    before.set(change.path, current?.content ?? null);
  }

  const done: string[] = [];
  try {
    for (const change of changes) {
      if (change.content === null) await remove(root, change.path);
      else await atomicWrite(await writablePath(root, change.path, change.content), change.content);
      done.push(change.path);
    }
  } catch (e) {
    for (const path of done.reverse()) {
      const old = before.get(path)!;
      if (old === null) await remove(root, path).catch(() => {});
      else await atomicWrite(join(root, path), old).catch(() => {});
    }
    throw e;
  }

  const paths = [...new Set(changes.map((c) => c.path))];
  const g = git(root);
  await g.raw(["add", "-A", "--", ...paths]);
  const staged = (await g.raw(["diff", "--cached", "--name-only", "--", ...paths])).trim();
  if (!staged) return { commit: null, files: paths };
  await g.raw(["commit", "--quiet", "--no-verify", "-m", message, "--", ...paths]);
  return { commit: (await g.raw(["rev-parse", "HEAD"])).trim(), files: paths };
}

/** Delete a file, and the folders it leaves empty up to the novel's root. */
async function remove(root: string, path: string): Promise<void> {
  await unlink(join(root, path)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  for (let dir = dirname(path); dir !== "." && dir !== ""; dir = dirname(dir)) {
    const full = join(root, dir);
    if ((await readdir(full).catch(() => ["?"])).length) break;
    await rmdir(full).catch(() => {});
  }
}
