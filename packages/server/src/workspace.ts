import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadNovel, type FileSource, type Novel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { watch, type FSWatcher } from "chokidar";
import { BibleOperations } from "./bible.ts";
import { Checkpoints } from "./checkpoints.ts";
import { Committer, type CommitStatus, type CommitterOptions } from "./committer.ts";
import { atomicWrite, hashText, isVisible, readText, writablePath, type TextFile, type WriteHooks } from "./files.ts";
import type { Library } from "./library.ts";
import { Syncer, type SyncerOptions, type SyncStatus } from "./sync.ts";

/** A file that changed on disk. `hash` is null once the file is gone. */
export interface FileEvent {
  type: "add" | "change" | "unlink";
  path: string;
  hash: string | null;
}

export type WriteResult = { ok: true; hash: string } | { ok: false; current: TextFile | undefined };

/** What GET /sync reports: the sync state ("off" when sync is turned off), with the background commit status. */
export type NovelSyncStatus = (SyncStatus | { state: "off" }) & { commit: CommitStatus | { state: "off" } };

export interface WorkspaceOptions {
  /** Background commits; false turns them off. */
  commit?: CommitterOptions | false;
  /** Sync with the remote; false turns it off. */
  sync?: SyncerOptions | false;
}

/**
 * One open novel: reads, conflict-checked atomic writes, and a watcher that tells subscribers about
 * changes made outside the app (another editor, a git pull) but not about the server's own writes.
 */
export class NovelWorkspace {
  readonly root: string;
  /** Commits saved work in the background, unless turned off. */
  readonly committer: Committer | undefined;
  /** Syncs with the remote in the background, unless turned off. */
  readonly syncer: Syncer | undefined;
  readonly checkpoints: Checkpoints;
  /** Story bible changes, one commit each. */
  readonly bible: BibleOperations;
  /** Resolves when the workspace stops: event streams end then. */
  readonly stopped: Promise<void>;
  #stop!: () => void;
  #locks = new Map<string, Promise<unknown>>();
  /** path → hash of what the server last wrote there: a watcher event with that hash is an echo. */
  #written = new Map<string, string>();
  #listeners = new Set<(e: FileEvent) => void>();
  #watcher?: FSWatcher;
  #ready?: Promise<void>;
  /** Writes under way, and the exclusive task (sync, restore) that new writes wait for. */
  #writing = 0;
  #drained?: () => void;
  #exclusive?: Promise<unknown>;

  constructor(root: string, { commit = {}, sync = {} }: WorkspaceOptions = {}) {
    this.root = root;
    this.committer = commit === false ? undefined : new Committer(root, commit);
    this.syncer =
      sync === false ? undefined : new Syncer(root, sync, { ...(this.committer ? { committer: this.committer } : {}), exclusive: (fn) => this.exclusive(fn) });
    this.checkpoints = new Checkpoints(root, {
      // Checkpoints commit saved work even when background commits are off.
      committer: this.committer ?? new Committer(root),
      exclusive: (fn) => this.exclusive(fn),
      onCreate: () => this.syncer?.tagsChanged(),
    });
    this.bible = new BibleOperations(root, (fn) => this.exclusive(fn));
    this.stopped = new Promise((resolve) => (this.#stop = resolve));
    this.syncer?.start();
  }

  async syncStatus(): Promise<NovelSyncStatus> {
    const [sync, commit] = await Promise.all([this.syncer?.status() ?? { state: "off" as const }, this.committer?.status() ?? { state: "off" as const }]);
    return { ...sync, commit };
  }

  /** Listen for changes to the sync or commit status. Returns a function that removes the listener. */
  onSyncChange(listener: () => void): () => void {
    const off = [this.syncer?.onChange(listener), this.committer?.onChange(listener)];
    return () => off.forEach((f) => f?.());
  }

  /**
   * Run `fn` alone: writes under way finish first, new ones wait until it's done, and background commits
   * are held off. For changes to the work tree that mustn't interleave with saves (a rebase, a restore).
   */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#exclusive) await this.#exclusive.catch(() => {});
    const run = (async () => {
      if (this.#writing) await new Promise<void>((resolve) => (this.#drained = resolve));
      return this.committer ? this.committer.hold(fn) : fn();
    })();
    this.#exclusive = run;
    try {
      return await run;
    } finally {
      this.#exclusive = undefined;
    }
  }

  /** The story model, with the hash of every file it was read from (the bases for writes). */
  async loadModel(): Promise<{ novel: Novel; files: Record<string, string> }> {
    const files: Record<string, string> = {};
    const disk = nodeSource(this.root);
    const source: FileSource = {
      list: (dir) => disk.list(dir),
      read: async (path) => {
        const bytes = await readFile(join(this.root, path)).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR") return undefined;
          throw e;
        });
        if (bytes === undefined) return undefined;
        files[path] = hashText(bytes);
        return bytes.toString("utf8");
      },
    };
    return { novel: await loadNovel(source), files };
  }

  read(path: string): Promise<TextFile | undefined> {
    return readText(this.root, path);
  }

  /**
   * Write `content` to `path` if the file on disk is still the one the client read: `base` is the hash
   * it read, or null for a file it expects not to exist. Otherwise nothing is written and the current
   * file comes back. Writes to one path run one at a time.
   */
  write(path: string, content: string, base: string | null, hooks?: WriteHooks): Promise<WriteResult> {
    return this.#locked(path, () => this.#shared(async () => {
      const full = await writablePath(this.root, path, content);
      const current = await readText(this.root, path);
      if ((current?.hash ?? null) !== base) return { ok: false, current };
      const hash = hashText(content);
      if (current?.hash === hash) return { ok: true, hash };
      // Recorded before the write, since the watcher may see the file before atomicWrite returns.
      this.#written.set(path, hash);
      try {
        await atomicWrite(full, content, hooks);
      } catch (e) {
        this.#written.delete(path);
        throw e;
      }
      this.committer?.notify();
      return { ok: true, hash };
    }));
  }

  async #shared<T>(task: () => Promise<T>): Promise<T> {
    while (this.#exclusive) await this.#exclusive.catch(() => {});
    this.#writing++;
    try {
      return await task();
    } finally {
      if (--this.#writing === 0) {
        this.#drained?.();
        this.#drained = undefined;
      }
    }
  }

  /** Listen for outside changes. Resolves once the watcher is ready: changes from then on are reported. */
  async subscribe(listener: (e: FileEvent) => void): Promise<() => void> {
    this.#listeners.add(listener);
    await this.#watch();
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) void this.#unwatch();
    };
  }

  /** End the event streams. */
  stop(): void {
    this.#listeners.clear();
    this.#stop();
  }

  /** End the event streams, stop syncing and watching, and commit any saved work still waiting. */
  async close(): Promise<void> {
    this.stop();
    await this.syncer?.close();
    await Promise.all([this.#unwatch(), this.committer?.close()]);
  }

  #watch(): Promise<void> {
    if (this.#ready) return this.#ready;
    const watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: (abs) => {
        const rel = this.#relative(abs);
        return rel !== "" && !isVisible(rel);
      },
    });
    this.#watcher = watcher;
    for (const type of ["add", "change", "unlink"] as const) {
      watcher.on(type, (abs: string) => void this.#onChange(type, this.#relative(abs)));
    }
    this.#ready = new Promise((resolve) => watcher.once("ready", () => resolve()));
    return this.#ready;
  }

  async #unwatch(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = undefined;
    this.#ready = undefined;
    await watcher?.close();
  }

  async #onChange(type: FileEvent["type"], path: string): Promise<void> {
    let hash: string | null = null;
    if (type !== "unlink") {
      const bytes = await readFile(join(this.root, path)).catch(() => undefined);
      if (bytes === undefined) return; // gone again; its unlink follows
      hash = hashText(bytes);
      if (this.#written.get(path) === hash) return;
    }
    this.#written.delete(path);
    for (const listener of this.#listeners) listener({ type, path, hash });
  }

  #relative(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  #locked<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(path) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.catch(() => {});
    this.#locks.set(path, settled);
    void settled.then(() => {
      if (this.#locks.get(path) === settled) this.#locks.delete(path);
    });
    return run;
  }
}

/** The open workspaces, one per library novel. */
export class Workspaces {
  #library: Library;
  #options: WorkspaceOptions;
  #open = new Map<string, NovelWorkspace>();

  constructor(library: Library, options: WorkspaceOptions = {}) {
    this.#library = library;
    this.#options = options;
  }

  /** The workspace for a library novel, or undefined if there is no such novel. */
  get(id: string): NovelWorkspace | undefined {
    const entry = this.#library.get(id);
    if (!entry) return undefined;
    let ws = this.#open.get(id);
    if (ws?.root !== entry.path) {
      void ws?.close();
      ws = new NovelWorkspace(entry.path, this.#options);
      this.#open.set(id, ws);
    }
    return ws;
  }

  /** End every event stream, so that the HTTP server can finish its requests. */
  stop(): void {
    for (const ws of this.#open.values()) ws.stop();
  }

  async close(): Promise<void> {
    await Promise.all([...this.#open.values()].map((ws) => ws.close()));
    this.#open.clear();
  }
}
