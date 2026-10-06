import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, type Api, type TextFile } from "./api.ts";

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

/** A save the server refused because the file changed on disk since it was read. */
export interface Conflict {
  path: string;
  /** The text the author wrote, still unsaved. */
  mine: string;
  /** What's on disk now, or null if the file is gone. */
  disk: TextFile | null;
}

export interface AutosaveState {
  status: SaveStatus;
  /** Files with changes not yet on disk. */
  unsaved: number;
  /** Why the last save failed, while it's being retried or held. */
  error: string | undefined;
  conflicts: Conflict[];
}

/** The part of the Web Storage API autosave uses. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The window, or anything that dispatches its page lifecycle events. */
export interface PageTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  document?: { visibilityState: string };
}

export interface AutosaveOptions {
  api: Api;
  novelId: string;
  /** Save this long after the last change to a file (ms). Default 2 s. */
  interval?: number;
  /** First retry delay after a failed save (ms), doubling up to `maxRetryDelay`. */
  retryDelay?: number;
  maxRetryDelay?: number;
  /** Keeps a copy of unsaved text until the server has it (survives a reload). Default: sessionStorage; null for none. */
  storage?: StorageLike | null;
  /** Called when a save meets newer text on disk: offer the conflict resolver (#47) or a reload. */
  onConflict?: (conflict: Conflict) => void;
  /** Called when a file's text is on disk: what was saved and its new hash. */
  onSaved?: (path: string, content: string, hash: string) => void;
}

interface Entry {
  /** Hash of the file as last read or written: the base the next save is checked against. */
  base: string | null;
  /** Text not yet on disk. */
  pending: string | undefined;
  saving: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  attempt: number;
  conflict: Conflict | undefined;
  /** A save failed and won't be retried by itself (the server refused it). */
  held: string | undefined;
}

export interface Autosave {
  store: StoreApi<AutosaveState>;
  /** Record the hash a file had when it was read (from the novel model or readFile), before editing it. */
  track(path: string, base: string | null): void;
  /** The editor's new text for a file: saved once changes pause for `interval`. */
  change(path: string, content: string): void;
  /** Save everything pending now. `keepalive` lets the requests outlive the page. */
  flush(options?: { keepalive?: boolean }): Promise<void>;
  /** After a conflict: save `content` (the merged text) over the disk version the conflict reported. */
  resolve(path: string, content: string): void;
  /** After a conflict: drop the unsaved text and take the disk version. */
  discard(path: string): void;
  /** Flush on page hide and before unload. Returns a function that removes the listeners. */
  attach(target: PageTarget): () => void;
  dispose(): void;
}

const STORAGE_PREFIX = "ghw:autosave:";

/**
 * Autosave for one novel: a queue per file that coalesces the editor's changes into one write after a
 * pause, sends the hash the text was based on, and keeps the text (in memory and in sessionStorage)
 * until the server has it. Failed saves are retried with backoff; a 409 conflict is handed to the UI
 * and never overwrites the newer text on disk.
 */
export function createAutosave({
  api,
  novelId,
  interval = 2000,
  retryDelay = 1000,
  maxRetryDelay = 30_000,
  storage: storageOption,
  onConflict,
  onSaved,
}: AutosaveOptions): Autosave {
  const storage = storageOption === null ? undefined : (storageOption ?? sessionStorage());
  const store = createStore<AutosaveState>(() => ({ status: "saved", unsaved: 0, error: undefined, conflicts: [] }));
  const entries = new Map<string, Entry>();
  let lastError: string | undefined;
  let disposed = false;

  const entry = (path: string): Entry => {
    let e = entries.get(path);
    if (!e) {
      e = { base: null, pending: undefined, saving: undefined, timer: undefined, attempt: 0, conflict: undefined, held: undefined };
      entries.set(path, e);
    }
    return e;
  };

  const key = (path: string) => `${STORAGE_PREFIX}${novelId}:${path}`;
  const keep = (path: string, e: Entry) => {
    try {
      storage?.setItem(key(path), JSON.stringify({ content: e.pending, base: e.base }));
    } catch {
      // Storage full or blocked: the in-memory copy still holds the text.
    }
  };
  const forget = (path: string) => {
    try {
      storage?.removeItem(key(path));
    } catch {
      // nothing to do
    }
  };

  function publish(): void {
    const all = [...entries.values()];
    const conflicts = all.flatMap((e) => (e.conflict ? [e.conflict] : []));
    const held = all.find((e) => e.held)?.held;
    const unsaved = all.filter((e) => e.pending !== undefined).length;
    const error = conflicts.length ? "Some text changed on disk while you were writing." : (held ?? lastError);
    const status: SaveStatus = error ? "error" : all.some((e) => e.saving) ? "saving" : unsaved ? "unsaved" : "saved";
    store.setState({ status, unsaved, error, conflicts });
  }

  function schedule(path: string, e: Entry, ms: number): void {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => void save(path), ms);
  }

  /** Save a file's pending text. One request per file at a time; changes made meanwhile follow it. */
  function save(path: string, keepalive = false): Promise<void> {
    const e = entry(path);
    clearTimeout(e.timer);
    e.timer = undefined;
    if (disposed || e.pending === undefined || e.conflict) return e.saving ?? Promise.resolve();
    if (e.saving) return e.saving.then(() => save(path, keepalive));

    const content = e.pending;
    e.saving = (async () => {
      try {
        const result = await api.writeFile(novelId, path, content, e.base, { keepalive });
        e.attempt = 0;
        e.held = undefined;
        lastError = undefined;
        if (result.ok) {
          e.base = result.hash;
          onSaved?.(path, content, result.hash);
          if (e.pending === content) {
            e.pending = undefined;
            forget(path);
          } else {
            keep(path, e); // newer text was typed meanwhile: it now builds on this save
          }
        } else {
          e.conflict = { path, mine: e.pending ?? content, disk: result.current };
          onConflict?.(e.conflict);
        }
      } catch (err) {
        const retryable = !(err instanceof ApiError) || err.retryable;
        const message = err instanceof Error ? err.message : String(err);
        if (retryable) {
          lastError = message;
          const delay = Math.min(retryDelay * 2 ** e.attempt, maxRetryDelay);
          e.attempt++;
          if (!disposed) schedule(path, e, delay);
        } else {
          // Refused (bad path, too large…): retrying won't help. Keep the text; the next change tries again.
          e.held = `Couldn't save ${path}: ${message}`;
        }
      } finally {
        e.saving = undefined;
        publish();
      }
      // Text typed while this save was in flight.
      if (e.pending !== undefined && e.pending !== content && !e.conflict && !e.timer && !disposed) schedule(path, e, interval);
    })();
    publish();
    return e.saving;
  }

  // Text left unsaved by a reload or crash of this tab: queue it again. The base check keeps it from
  // overwriting anything newer on disk.
  if (storage) {
    const prefix = `${STORAGE_PREFIX}${novelId}:`;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(prefix)) continue;
      try {
        const saved = JSON.parse(storage.getItem(k) ?? "") as { content?: unknown; base?: unknown };
        if (typeof saved.content !== "string") continue;
        const e = entry(k.slice(prefix.length));
        e.base = typeof saved.base === "string" ? saved.base : null;
        e.pending = saved.content;
      } catch {
        // not ours, or damaged
      }
    }
    for (const [path, e] of entries) if (e.pending !== undefined) schedule(path, e, 0);
    publish();
  }

  const flush = async ({ keepalive = false } = {}) => {
    await Promise.all([...entries.keys()].map((path) => save(path, keepalive)));
  };

  return {
    store,
    track(path, base) {
      const e = entry(path);
      if (e.pending === undefined) e.base = base;
    },
    change(path, content) {
      const e = entry(path);
      e.pending = content;
      e.held = undefined;
      keep(path, e);
      // During a conflict nothing is saved; the resolver gets the latest text.
      if (e.conflict) e.conflict = { ...e.conflict, mine: content };
      else schedule(path, e, interval);
      publish();
    },
    flush,
    resolve(path, content) {
      const e = entry(path);
      if (!e.conflict) return;
      e.base = e.conflict.disk?.hash ?? null;
      e.conflict = undefined;
      e.pending = content;
      keep(path, e);
      void save(path);
    },
    discard(path) {
      const e = entry(path);
      e.base = e.conflict?.disk?.hash ?? e.base;
      e.conflict = undefined;
      e.pending = undefined;
      forget(path);
      publish();
    },
    attach(target) {
      const onHide = () => void flush({ keepalive: true });
      const onVisibility = () => target.document?.visibilityState === "hidden" && onHide();
      target.addEventListener("pagehide", onHide);
      target.addEventListener("beforeunload", onHide);
      target.addEventListener("visibilitychange", onVisibility);
      return () => {
        target.removeEventListener("pagehide", onHide);
        target.removeEventListener("beforeunload", onHide);
        target.removeEventListener("visibilitychange", onVisibility);
      };
    },
    dispose() {
      disposed = true;
      for (const e of entries.values()) clearTimeout(e.timer);
    },
  };
}

function sessionStorage(): StorageLike | undefined {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
  } catch {
    return undefined; // blocked by the browser's privacy settings
  }
}
