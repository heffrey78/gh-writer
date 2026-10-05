import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadNovel, type FileSource, type Novel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { watch, type FSWatcher } from "chokidar";
import { atomicWrite, hashText, isVisible, readText, writablePath, type TextFile, type WriteHooks } from "./files.ts";
import type { Library } from "./library.ts";

/** A file that changed on disk. `hash` is null once the file is gone. */
export interface FileEvent {
  type: "add" | "change" | "unlink";
  path: string;
  hash: string | null;
}

export type WriteResult = { ok: true; hash: string } | { ok: false; current: TextFile | undefined };

/**
 * One open novel: reads, conflict-checked atomic writes, and a watcher that tells subscribers about
 * changes made outside the app (another editor, a git pull) but not about the server's own writes.
 */
export class NovelWorkspace {
  readonly root: string;
  /** Resolves when the workspace closes: event streams end then. */
  readonly closed: Promise<void>;
  #close!: () => void;
  #locks = new Map<string, Promise<unknown>>();
  /** path → hash of what the server last wrote there: a watcher event with that hash is an echo. */
  #written = new Map<string, string>();
  #listeners = new Set<(e: FileEvent) => void>();
  #watcher?: FSWatcher;
  #ready?: Promise<void>;

  constructor(root: string) {
    this.root = root;
    this.closed = new Promise((resolve) => (this.#close = resolve));
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
    return this.#locked(path, async () => {
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
      return { ok: true, hash };
    });
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

  async close(): Promise<void> {
    this.#listeners.clear();
    this.#close();
    await this.#unwatch();
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
  #open = new Map<string, NovelWorkspace>();

  constructor(library: Library) {
    this.#library = library;
  }

  /** The workspace for a library novel, or undefined if there is no such novel. */
  get(id: string): NovelWorkspace | undefined {
    const entry = this.#library.get(id);
    if (!entry) return undefined;
    let ws = this.#open.get(id);
    if (ws?.root !== entry.path) {
      void ws?.close();
      ws = new NovelWorkspace(entry.path);
      this.#open.set(id, ws);
    }
    return ws;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#open.values()].map((ws) => ws.close()));
    this.#open.clear();
  }
}
