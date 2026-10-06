import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { merge3, type MergeChunk } from "@gh-writer/core";
import { hashText } from "./files.ts";
import { git, gitPlumbing } from "./git.ts";

/** A file both sides changed in ways that don't merge by themselves. */
export interface ConflictFile {
  /** Relative to the novel's folder. */
  path: string;
  /** Hash of our version (as the files API reports it), or null if we deleted the file: sent back with the resolution. */
  ours: string | null;
  /** Whether each side still has the file. */
  inOurs: boolean;
  inTheirs: boolean;
  /** Not text: only one side or the other can be kept. */
  binary: boolean;
  /** The merge, with conflicts where both sides changed the same paragraph or field. */
  chunks: MergeChunk[];
}

export interface Conflicts {
  /** The remote commit being merged: sent back with the resolution, which is refused if the remote moved. */
  upstream: string;
  files: ConflictFile[];
}

/** How a conflicting file ends up: new text, the file deleted (null), or one side's version kept as it is. */
export type FileResolution = { ours: string | null } & ({ content: string | null } | { keep: "ours" | "theirs" });

export type ConflictErrorCode = "NO_CONFLICT" | "STALE" | "BAD_RESOLUTION";

export class ConflictError extends Error {
  readonly code: ConflictErrorCode;

  constructor(code: ConflictErrorCode, message: string) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

/** One conflicted path of a prepared merge. */
interface PreparedFile extends ConflictFile {
  /** Repository-relative. */
  repoPath: string;
  /** The merged text, when merge3 settled every conflict by itself. */
  merged?: string;
}

export interface PreparedMerge {
  head: string;
  upstream: string;
  /** git's merge of the two: the tree for every path that merged cleanly. */
  tree: string;
  files: PreparedFile[];
}

/** What a merge commit does with a path that git couldn't merge. */
type Settled = { content: string } | { keep: string } | { remove: true };

/**
 * Merge HEAD with `upstream` in memory: git merges what it can, and each path it can't is merged
 * again with core's merge3, paragraph by paragraph and front matter field by field. Nothing in the
 * work tree changes.
 */
export async function prepareMerge(root: string, upstreamRef: string): Promise<PreparedMerge> {
  const g = git(root);
  const rev = async (r: string) => (await g.raw(["rev-parse", "--verify", `${r}^{commit}`])).trim();
  const [head, upstream] = [await rev("HEAD"), await rev(upstreamRef)];
  const base = (await g.raw(["merge-base", head, upstream]).catch(() => "")).trim();
  // From the repository's top: merge-tree names paths relative to where it runs.
  const top = (await g.raw(["rev-parse", "--show-toplevel"])).trim();
  const out = (await gitPlumbing(top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, upstream]).catch((e: unknown) => {
    // Exit 1 means conflicts, with the same output; anything else is a failure.
    const stdout = (e as { stdout?: Buffer }).stdout;
    if (stdout?.length) return stdout;
    throw e;
  }))
    .toString()
    .split("\n")
    .filter(Boolean);
  const [tree, ...conflicted] = out;
  const prefix = (await g.raw(["rev-parse", "--show-prefix"])).trim();

  const files: PreparedFile[] = [];
  for (const repoPath of [...new Set(conflicted)]) {
    const [b, o, t] = await Promise.all([base ? blob(root, base, repoPath) : undefined, blob(root, head, repoPath), blob(root, upstream, repoPath)]);
    const path = prefix && repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
    const binary = [b, o, t].some((x) => x !== undefined && x.includes(0));
    const common = { path, repoPath, ours: o === undefined ? null : hashText(o), inOurs: o !== undefined, inTheirs: t !== undefined, binary };
    const text = (x: Buffer | undefined) => x?.toString("utf8") ?? "";
    if (binary || o === undefined || t === undefined) {
      // Deleted on one side, or not text: a whole-file choice.
      files.push({ ...common, chunks: [{ type: "conflict", base: binary ? "" : text(b), ours: binary ? "" : text(o), theirs: binary ? "" : text(t) }] });
      continue;
    }
    const merged = merge3(text(b), text(o), text(t));
    files.push({ ...common, chunks: merged.chunks, ...(merged.text !== undefined ? { merged: merged.text } : {}) });
  }
  return { head, upstream, tree: tree!, files };
}

/** The conflicts the author has to settle: files merge3 couldn't settle alone. */
export function openConflicts(prepared: PreparedMerge): Conflicts {
  return {
    upstream: prepared.upstream,
    files: prepared.files.filter((f) => f.merged === undefined).map(({ repoPath: _r, merged: _m, ...file }) => file),
  };
}

/**
 * Commit the merge of `prepared`: the files merge3 settled, plus `resolutions` (by novel path) for the
 * rest, and move the branch and work tree to it. The commit has both sides as parents, so every local
 * commit stays in history. HEAD must not have moved since `prepared` was made.
 */
export async function commitMerge(root: string, prepared: PreparedMerge, resolutions: Record<string, FileResolution>, message: string): Promise<string> {
  const settled = new Map<string, Settled>();
  for (const file of prepared.files) {
    if (file.merged !== undefined) {
      settled.set(file.repoPath, { content: file.merged });
      continue;
    }
    const r = resolutions[file.path];
    if (!r) throw new ConflictError("BAD_RESOLUTION", `No resolution for "${file.path}".`);
    if (r.ours !== file.ours) throw new ConflictError("STALE", `"${file.path}" changed since the conflict was shown.`);
    if ("keep" in r) {
      const side = r.keep === "ours" ? prepared.head : prepared.upstream;
      settled.set(file.repoPath, (r.keep === "ours" ? file.inOurs : file.inTheirs) ? { keep: side } : { remove: true });
    } else if (r.content === null) settled.set(file.repoPath, { remove: true });
    else if (file.binary) throw new ConflictError("BAD_RESOLUTION", `"${file.path}" isn't text: keep one side.`);
    else settled.set(file.repoPath, { content: r.content });
  }
  const extra = Object.keys(resolutions).filter((p) => !prepared.files.some((f) => f.path === p));
  if (extra.length) throw new ConflictError("BAD_RESOLUTION", `No conflict in ${extra.map((p) => `"${p}"`).join(", ")}.`);

  // Build the tree in a temporary index, so the real one and the work tree are untouched until the end.
  const g = git(root);
  // Plumbing runs at the repository's top, where index paths start, whatever folder the novel is in.
  const top = (await g.raw(["rev-parse", "--show-toplevel"])).trim();
  const index = resolvePath(root, (await g.raw(["rev-parse", "--git-path", `ghw-merge-index-${process.pid}`])).trim());
  const run = (args: string[], input?: string) => gitPlumbing(top, args, { env: { GIT_INDEX_FILE: index }, ...(input !== undefined ? { input } : {}) });
  /** "<mode> blob <object>\t<path>" for the path at `rev`, as [mode, object], or undefined. */
  const entry = async (rev: string, repoPath: string) => {
    const [mode, , object] = (await run(["ls-tree", rev, "--", repoPath])).toString().trim().split(/\s+/);
    return mode && object ? ([mode, object] as const) : undefined;
  };
  try {
    await run(["read-tree", prepared.tree]);
    for (const [repoPath, how] of settled) {
      if ("remove" in how) {
        await run(["update-index", "--force-remove", "--", repoPath]);
        continue;
      }
      let mode: string;
      let object: string;
      if ("keep" in how) [mode, object] = (await entry(how.keep, repoPath))!;
      else {
        // Merged text keeps our file's mode (or theirs, for a file both added).
        mode = (await entry(prepared.head, repoPath))?.[0] ?? (await entry(prepared.upstream, repoPath))?.[0] ?? "100644";
        object = (await run(["hash-object", "-w", "--stdin", "--path", repoPath], how.content)).toString().trim();
      }
      await run(["update-index", "--add", "--cacheinfo", `${mode},${object},${repoPath}`]);
    }
    const tree = (await run(["write-tree"])).toString().trim();
    const commit = (await gitPlumbing(root, ["commit-tree", tree, "-p", prepared.head, "-p", prepared.upstream, "-F", "-"], { input: message })).toString().trim();
    // HEAD is the merge's first parent, so this fast-forwards the branch, index and work tree to it.
    await g.raw(["merge", "--ff-only", "--quiet", commit]);
    return commit;
  } finally {
    await rm(index, { force: true });
  }
}

/** A file's bytes at `rev`, by its repository path, or undefined if it isn't there. */
async function blob(root: string, rev: string, repoPath: string): Promise<Buffer | undefined> {
  return gitPlumbing(root, ["cat-file", "blob", `${rev}:${repoPath}`]).catch(() => undefined);
}
