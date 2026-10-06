import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { commitMessage, type FileChange } from "./commit-message.ts";
import { TEMP_SUFFIX } from "./files.ts";
import { classifyGitError, git } from "./git.ts";

export interface CommitterOptions {
  /** Commit after this long without a save (ms). Default 2 minutes. */
  quietMs?: number;
  /** While saves keep coming, commit at least this often (ms). Default 10 minutes. */
  maxMs?: number;
  /** Timer source: tests pass a fake clock. Returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LastCommit {
  hash: string;
  summary: string;
  date: string;
}

export type BlockedCode = "IDENTITY" | "MERGE" | "ERROR";

export interface CommitStatus {
  /** idle: nothing waiting; pending: saves waiting for the timer; committing; blocked: a commit couldn't be made. */
  state: "idle" | "pending" | "committing" | "blocked";
  /** Files in the novel that differ from the last commit. */
  pendingChanges: number;
  lastCommit: LastCommit | null;
  blocked?: { code: BlockedCode; message: string };
}

export type CommitResult = { committed: LastCommit } | { skipped: "NOTHING" | BlockedCode };

// Atomic-write temp files are never committed, even if one is left behind by a crash.
const PATHSPEC = ["--", ".", `:(exclude,glob)**/.*${TEMP_SUFFIX}`];
const IN_PROGRESS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

/** Whether a merge, rebase, cherry-pick or revert is under way in the repository holding `root`. */
export async function operationInProgress(root: string): Promise<boolean> {
  const g = git(root);
  const paths = (await g.raw(["rev-parse", ...IN_PROGRESS.flatMap((p) => ["--git-path", p])])).trim().split("\n");
  if (paths.some((p) => existsSync(resolve(root, p)))) return true;
  return (await g.raw(["ls-files", "--unmerged", "--", "."])).trim() !== "";
}

export const IDENTITY_MESSAGE =
  'git doesn\'t know who you are, so your work can\'t be committed. Set your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com".';

/** Whether git has a name and email to commit with (config or GIT_AUTHOR_* / GIT_COMMITTER_*). */
export async function hasGitIdentity(root: string): Promise<boolean> {
  const g = git(root);
  const get = async (key: string) => (await g.raw(["config", "--get", key]).catch(() => "")).trim();
  const env = process.env;
  const name = env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME || (await get("user.name"));
  const email = env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL || (await get("user.email"));
  return Boolean(name && email);
}

const realSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Commits a novel's saved work in the background: after a quiet period without saves, and at least
 * every `maxMs` while saving goes on. Only the novel's folder is staged and committed. Nothing is
 * committed during a merge or rebase, without a git identity, or when nothing changed.
 */
export class Committer {
  readonly root: string;
  #quietMs: number;
  #maxMs: number;
  #schedule: NonNullable<CommitterOptions["schedule"]>;
  #cancelQuiet?: () => void;
  #cancelMax?: () => void;
  #dirty = false;
  #committing = false;
  #running: Promise<CommitResult> | undefined;
  #lastCommit: LastCommit | null = null;
  #blocked: CommitStatus["blocked"];
  #held = 0;
  #listeners = new Set<() => void>();

  constructor(root: string, { quietMs = 120_000, maxMs = 600_000, schedule = realSchedule }: CommitterOptions = {}) {
    this.root = root;
    this.#quietMs = quietMs;
    this.#maxMs = maxMs;
    this.#schedule = schedule;
  }

  /** A save happened: restart the quiet timer, and start the cap if this is the first save since a commit. */
  notify(): void {
    const wasDirty = this.#dirty;
    this.#dirty = true;
    this.#cancelQuiet?.();
    this.#cancelQuiet = this.#schedule(() => this.#onTimer(), this.#quietMs);
    this.#cancelMax ??= this.#schedule(() => this.#onTimer(), this.#maxMs);
    if (!wasDirty) this.#changed();
  }

  /** Called after each commit attempt and when saves start waiting. Returns a function that removes it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /**
   * Run `fn` with background commits held off (sync rebasing the work tree, a checkpoint restore).
   * Explicit commit() calls still run; timers that come due meanwhile wait until `fn` has finished.
   */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.#held++;
    try {
      await this.idle();
      return await fn();
    } finally {
      if (--this.#held === 0 && this.#dirty && !this.#cancelQuiet) {
        this.#cancelQuiet = this.#schedule(() => this.#onTimer(), this.#quietMs);
      }
    }
  }

  /** Commit now if there is anything to commit. Concurrent calls share one run. */
  commit(): Promise<CommitResult> {
    this.#cancelTimers();
    this.#running ??= this.#commit().finally(() => (this.#running = undefined));
    return this.#running;
  }

  /** Resolves once a commit in progress has finished. */
  async idle(): Promise<void> {
    await this.#running?.catch(() => {});
  }

  async status(): Promise<CommitStatus> {
    const pendingChanges = await this.#pendingChanges().catch(() => 0);
    const state = this.#committing ? "committing" : this.#blocked ? "blocked" : this.#dirty || pendingChanges ? "pending" : "idle";
    return { state, pendingChanges, lastCommit: this.#lastCommit, ...(this.#blocked ? { blocked: this.#blocked } : {}) };
  }

  /** Commit what's waiting and stop the timers. */
  async close(): Promise<void> {
    this.#cancelTimers();
    await this.idle();
    if (this.#dirty) await this.commit().catch(() => {});
  }

  #onTimer(): void {
    if (this.#held) {
      // Picked up again when the hold ends.
      this.#cancelTimers();
      return;
    }
    void this.commit();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  async #commit(): Promise<CommitResult> {
    this.#committing = true;
    // Saves from here on belong to the next commit.
    this.#dirty = false;
    try {
      const result = await this.#tryCommit();
      if ("committed" in result) {
        this.#lastCommit = result.committed;
        this.#blocked = undefined;
      } else if (result.skipped === "NOTHING") {
        this.#blocked = undefined;
      }
      return result;
    } catch (e) {
      const failure = classifyGitError(e);
      this.#block("ERROR", `Couldn't commit: ${failure.message}`);
      return { skipped: "ERROR" };
    } finally {
      this.#committing = false;
      this.#changed();
    }
  }

  async #tryCommit(): Promise<CommitResult> {
    const g = git(this.root);
    if (await operationInProgress(this.root)) {
      return this.#block("MERGE", "A merge or rebase is in progress in this repository; saved work will be committed once it's finished.");
    }
    if (!(await hasGitIdentity(this.root))) return this.#block("IDENTITY", IDENTITY_MESSAGE);

    await g.raw(["add", "-A", ...PATHSPEC]);
    const changes = await this.#stagedChanges();
    if (!changes.length) return { skipped: "NOTHING" };

    const { summary, body } = commitMessage(changes);
    // --no-verify: a background save must not run (or be stopped by) the author's commit hooks.
    await g.raw(["commit", "--quiet", "--no-verify", "-m", summary, "-m", body, ...PATHSPEC]);
    const [hash, date] = (await g.raw(["log", "-1", "--format=%H%n%cI"])).trim().split("\n");
    return { committed: { hash: hash!, summary, date: date! } };
  }

  /** Retry a blocked commit after the next quiet period, keeping the work marked as unsaved to git. */
  #block(code: BlockedCode, message: string): CommitResult {
    this.#blocked = { code, message };
    this.#dirty = true;
    this.#cancelQuiet = this.#schedule(() => this.#onTimer(), this.#quietMs);
    return { skipped: code };
  }



  async #stagedChanges(): Promise<FileChange[]> {
    const g = git(this.root);
    const out = await g.raw(["diff", "--cached", "--name-status", "-M", "--relative", "-z", ...PATHSPEC]);
    const fields = out.split("\0").filter(Boolean);
    // --quiet: no HEAD exits 1 with no output (which simple-git doesn't treat as an error).
    const hasHead = (await g.raw(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim() !== "";
    const show = (spec: string) => g.raw(["show", spec]).catch(() => undefined);

    const changes: FileChange[] = [];
    for (let i = 0; i < fields.length; ) {
      const code = fields[i++]![0] as string;
      if (code === "R") {
        const oldPath = fields[i++]!;
        const path = fields[i++]!;
        changes.push({ status: "R", path, oldPath, before: hasHead ? await show(`HEAD:./${oldPath}`) : undefined, after: await show(`:./${path}`) });
        continue;
      }
      const path = fields[i++]!;
      const status = code === "A" || code === "D" ? code : "M";
      changes.push({
        status,
        path,
        before: status !== "A" && hasHead ? await show(`HEAD:./${path}`) : undefined,
        after: status !== "D" ? await show(`:./${path}`) : undefined,
      });
    }
    return changes;
  }

  async #pendingChanges(): Promise<number> {
    const out = await git(this.root).raw(["status", "--porcelain", "-z", "--untracked-files=all", ...PATHSPEC]);
    // A rename entry carries its old path as an extra field.
    let count = 0;
    const fields = out.split("\0").filter(Boolean);
    for (let i = 0; i < fields.length; i++) {
      count++;
      if (fields[i]![0] === "R" || fields[i]![0] === "C") i++;
    }
    return count;
  }

  #cancelTimers(): void {
    this.#cancelQuiet?.();
    this.#cancelMax?.();
    this.#cancelQuiet = undefined;
    this.#cancelMax = undefined;
  }
}
