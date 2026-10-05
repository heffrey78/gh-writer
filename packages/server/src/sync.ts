import { operationInProgress, type Committer } from "./committer.ts";
import { classifyGitError, git, GitFailure } from "./git.ts";

export interface SyncerOptions {
  /** Sync this often (ms), and once when the novel is opened. Default 5 minutes; 0 syncs only on demand. */
  intervalMs?: number;
  /** First retry after a network failure (ms), doubling up to `intervalMs`. Default 15 s. */
  retryMs?: number;
  /** Timer source: tests pass a fake clock. Returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * local: no remote to sync with. syncing: a sync is under way. synced: up to date with the remote.
 * ahead / behind: commits not yet pushed / not yet brought in. offline: the remote couldn't be reached
 * (retried by itself). needs-sign-in: the remote refused the credentials. conflict: the remote has
 * changes that clash with local ones (for the resolver, #47). error: anything else.
 */
export type SyncState = "local" | "syncing" | "synced" | "ahead" | "behind" | "offline" | "needs-sign-in" | "conflict" | "error";

export type SyncErrorCode = "DETACHED" | "BUSY" | GitFailure["code"];

export interface SyncStatus {
  state: SyncState;
  /** The remote synced with (e.g. "origin"), and the local branch. */
  remote: string | null;
  branch: string | null;
  /** Local commits the remote doesn't have, and remote commits not brought in, as of the last fetch. */
  ahead: number;
  behind: number;
  /** When the last sync finished cleanly (ISO), or null. */
  lastSync: string | null;
  /** The novel's files changed on both sides, relative to the novel's folder. */
  conflict?: { files: string[] };
  error?: { code: SyncErrorCode; message: string; detail?: string };
}

interface Target {
  remote: string;
  branch: string;
  /** The branch on the remote, e.g. refs/heads/main. */
  mergeRef: string;
  /** Its remote-tracking ref, e.g. refs/remotes/origin/main. */
  tracking: string;
  /** Whether the branch already tracks it (otherwise the first push sets that up). */
  upstream: boolean;
}

type Outcome =
  | { kind: "ok" }
  | { kind: "local" }
  | { kind: "conflict"; files: string[] }
  | { kind: "failed"; state: "offline" | "needs-sign-in" | "error"; error: NonNullable<SyncStatus["error"]> };

class SyncFailure extends Error {
  readonly code: "DETACHED" | "BUSY";

  constructor(code: "DETACHED" | "BUSY", message: string) {
    super(message);
    this.code = code;
  }
}

/** A push refused because the remote moved is retried after bringing its changes in, this many times. */
const PUSH_ATTEMPTS = 3;

const realSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface SyncerDeps {
  /** Saved work is committed before each sync. */
  committer?: Committer;
  /** Runs the step that changes the work tree with writes to the novel and background commits held off. Default: commits only. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Keeps a novel in step with its remote: every `intervalMs` and on demand it commits saved work, fetches,
 * brings remote changes in (fast-forward, or rebasing local commits onto them for a linear history), and
 * pushes. One sync runs at a time. When the remote changed the same lines, nothing in the work tree is
 * touched: the status is `conflict`, with the files, and local commits are kept.
 */
export class Syncer {
  readonly root: string;
  #committer: Committer | undefined;
  #exclusive: NonNullable<SyncerDeps["exclusive"]>;
  #intervalMs: number;
  #retryMs: number;
  #schedule: NonNullable<SyncerOptions["schedule"]>;
  #cancelNext?: () => void;
  #running: Promise<SyncStatus> | undefined;
  #syncing = false;
  #abort: AbortController | undefined;
  #closed = false;
  #target: Target | null | undefined;
  #outcome: Outcome | undefined;
  #failures = 0;
  #lastSync: string | null = null;
  #listeners = new Set<() => void>();

  constructor(root: string, { intervalMs = 300_000, retryMs = 15_000, schedule = realSchedule }: SyncerOptions = {}, { committer, exclusive }: SyncerDeps = {}) {
    this.root = root;
    this.#committer = committer;
    this.#exclusive = exclusive ?? ((fn) => (committer ? committer.hold(fn) : fn()));
    this.#intervalMs = intervalMs;
    this.#retryMs = retryMs;
    this.#schedule = schedule;
  }

  /** Sync now, then every interval (unless syncing only on demand). */
  start(): void {
    if (this.#intervalMs > 0) void this.sync();
  }

  /** Sync now. A sync already under way is joined, not repeated. Resolves with the status after it. */
  sync(): Promise<SyncStatus> {
    if (this.#closed) return this.status();
    // The next sync is scheduled once this one has let go, so its timer can never join a finished run.
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
      if (!this.#closed && this.#intervalMs > 0) this.#cancelNext = this.#schedule(() => void this.sync(), this.#nextDelay());
    });
    return this.#running;
  }

  /** Called when the status may have changed. Returns a function that removes it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async status(): Promise<SyncStatus> {
    // Not synced yet (on demand only): counts as of the last fetch, whoever made it.
    if (this.#target === undefined && !this.#syncing) this.#target = await this.#resolveTarget().catch(() => undefined);
    const target = this.#target;
    const { ahead, behind } = target ? await this.#counts(target).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 };
    const outcome = this.#outcome;
    let state: SyncState;
    if (this.#syncing) state = "syncing";
    else if (outcome?.kind === "conflict") state = "conflict";
    else if (outcome?.kind === "failed") state = outcome.state;
    else if (outcome?.kind === "local" || target === null) state = "local";
    else state = ahead ? "ahead" : behind ? "behind" : "synced";
    return {
      state,
      remote: target?.remote ?? null,
      branch: target?.branch ?? null,
      ahead,
      behind,
      lastSync: this.#lastSync,
      ...(outcome?.kind === "conflict" ? { conflict: { files: outcome.files } } : {}),
      ...(outcome?.kind === "failed" ? { error: outcome.error } : {}),
    };
  }

  /** Stop syncing: a fetch or push under way is cut short; bringing changes in is let finish. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelNext?.();
    this.#abort?.abort();
    await this.#running?.catch(() => {});
  }

  async #run(): Promise<SyncStatus> {
    this.#cancelNext?.();
    this.#syncing = true;
    this.#changed();
    this.#abort = new AbortController();
    try {
      this.#outcome = await this.#attempt(this.#abort.signal);
      if (this.#outcome.kind === "ok") this.#lastSync = new Date().toISOString();
    } catch (e) {
      this.#outcome = this.#failure(e);
    } finally {
      this.#abort = undefined;
      this.#syncing = false;
    }
    // Consecutive network failures, for the backoff.
    this.#failures = this.#offline() ? this.#failures + 1 : 0;
    this.#changed();
    return this.status();
  }

  async #attempt(signal: AbortSignal): Promise<Outcome> {
    const target = await this.#resolveTarget();
    this.#target = target;
    if (!target) return { kind: "local" };
    // Network steps can be cut short by close(); the work-tree step can't, so it never stops halfway.
    const remote = git(this.root, undefined, signal);
    await this.#committer?.commit();

    for (let attempt = 1; ; attempt++) {
      await remote.raw(["fetch", "--quiet", target.remote]);
      const conflict = await this.#exclusive(() => this.#integrate(target));
      if (conflict) return { kind: "conflict", files: conflict };
      const { ahead } = await this.#counts(target);
      if (!ahead) return { kind: "ok" };
      try {
        await remote.raw(["push", "--quiet", ...(target.upstream ? [] : ["--set-upstream"]), target.remote, `HEAD:${target.mergeRef}`]);
        target.upstream = true;
        return { kind: "ok" };
      } catch (e) {
        const failure = classifyGitError(e);
        // The remote moved during the sync: bring its changes in and push again.
        if (failure.code !== "REJECTED" || attempt >= PUSH_ATTEMPTS) throw failure;
      }
    }
  }

  /** Bring the remote's changes into the work tree. Returns the conflicting files, if any (nothing touched then). */
  async #integrate(target: Target): Promise<string[] | undefined> {
    const g = git(this.root);
    // Work saved while fetching.
    await this.#committer?.commit();
    if (await operationInProgress(this.root)) {
      throw new SyncFailure("BUSY", "A merge or rebase is in progress in this repository; sync will resume once it's finished.");
    }
    const { ahead, behind } = await this.#counts(target);
    if (!behind) return undefined;
    if (!ahead) {
      await g.raw(["merge", "--ff-only", "--quiet", target.tracking]);
      return undefined;
    }
    // Try the merge in memory first, so that a conflict leaves the work tree (and the editor) untouched.
    const merged = await g.raw(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", target.tracking]);
    const conflicted = merged.split("\n").filter(Boolean).slice(1);
    if (conflicted.length) return this.#novelPaths(conflicted);
    try {
      await g.raw(["rebase", "--quiet", "--no-verify", target.tracking]);
    } catch (e) {
      // A clean merge of the tips can still conflict commit by commit.
      const unmerged = (await g.raw(["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      await g.raw(["rebase", "--abort"]).catch(() => {});
      if (unmerged.length) return this.#novelPaths(unmerged);
      throw e;
    }
    return undefined;
  }

  async #resolveTarget(): Promise<Target | null> {
    const g = git(this.root);
    const get = async (...args: string[]) => (await g.raw(args).catch(() => "")).trim();
    const branch = await get("symbolic-ref", "--quiet", "--short", "HEAD");
    if (!branch) throw new SyncFailure("DETACHED", "This copy isn't on a branch (detached HEAD), so it can't sync. Check out a branch first.");
    const remotes = (await get("remote")).split("\n").filter(Boolean);
    const configured = await get("config", "--get", `branch.${branch}.remote`);
    const remote = remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : "";
    if (!remote) return null;
    const upstream = remote === configured && (await get("config", "--get", `branch.${branch}.merge`)) !== "";
    const mergeRef = (upstream && (await get("config", "--get", `branch.${branch}.merge`))) || `refs/heads/${branch}`;
    return { remote, branch, mergeRef, tracking: `refs/remotes/${remote}/${mergeRef.replace(/^refs\/heads\//, "")}`, upstream };
  }

  async #counts(target: Target): Promise<{ ahead: number; behind: number }> {
    const g = git(this.root);
    // --quiet: a missing ref exits 1 with no output (which simple-git doesn't treat as an error).
    const tracked = (await g.raw(["rev-parse", "--verify", "--quiet", target.tracking]).catch(() => "")).trim() !== "";
    // Nothing on the remote yet: every local commit is ahead.
    if (!tracked) return { ahead: Number((await g.raw(["rev-list", "--count", "HEAD"])).trim()), behind: 0 };
    const [ahead, behind] = (await g.raw(["rev-list", "--left-right", "--count", `HEAD...${target.tracking}`])).trim().split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  /** Repository-relative paths as paths in the novel's folder. */
  async #novelPaths(paths: string[]): Promise<string[]> {
    const prefix = (await git(this.root).raw(["rev-parse", "--show-prefix"])).trim();
    return paths.map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p));
  }

  #offline(): boolean {
    return this.#outcome?.kind === "failed" && this.#outcome.state === "offline";
  }

  /** The normal interval, or while offline a retry that backs off from `retryMs` up to it. */
  #nextDelay(): number {
    return this.#offline() ? Math.min(this.#retryMs * 2 ** (this.#failures - 1), this.#intervalMs) : this.#intervalMs;
  }

  #failure(e: unknown): Outcome {
    if (e instanceof SyncFailure) return { kind: "failed", state: "error", error: { code: e.code, message: e.message } };
    const failure = classifyGitError(e);
    const state = failure.code === "NETWORK" ? "offline" : failure.code === "AUTH" ? "needs-sign-in" : "error";
    return { kind: "failed", state, error: { code: failure.code, message: failure.message, ...(failure.detail ? { detail: failure.detail } : {}) } };
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
