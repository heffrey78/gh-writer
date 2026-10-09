import { ApiError, type Api, type StorageLike } from "@gh-writer/client";
import { createStore, type StoreApi } from "zustand/vanilla";

/** A bible entry made where the author was (an @ mention, a scene's details), on its way to its file. */
export interface QuickEntry {
  id: string;
  /** Entity type key. */
  type: string;
  name: string;
}

export interface PendingEntry extends QuickEntry {
  /** Why the server refused it, if it did: it waits for the author (try again, or unlink it). */
  refused?: string;
}

export interface QuickEntriesState {
  pending: PendingEntry[];
}

export interface QuickEntriesOptions {
  api: Pick<Api, "bible">;
  novelId: string;
  /** Keeps the queue until the server has each entry (survives a reload). Default: sessionStorage; null for none. */
  storage?: StorageLike | null;
  /** First retry delay after the server couldn't be reached (ms), doubling up to `maxRetryDelay`. */
  retryDelay?: number;
  maxRetryDelay?: number;
  onMade?: (entry: QuickEntry) => void;
  onRefused?: (entry: QuickEntry, reason: string) => void;
}

export interface QuickEntries {
  store: StoreApi<QuickEntriesState>;
  /** Make an entry with an ID already handed out (and maybe already written into the text). */
  add(entry: QuickEntry): void;
  /** Send a refused entry again (the author fixed what was wrong). */
  retry(id: string): void;
  /** Give up on an entry: it won't be made. */
  discard(id: string): void;
  /** IDs handed out and not made yet, so none is handed out twice. */
  ids(): Set<string>;
  dispose(): void;
}

const STORAGE_PREFIX = "ghw:entries:";

/**
 * The entries made in place, each kept (in memory and in sessionStorage) until the server has
 * written its file: the mention naming it is already in the text, so it mustn't be lost. A server
 * that can't be reached is tried again, waiting longer each time; one that refuses (no git
 * identity, an ID taken meanwhile) holds the entry for the author to try again or give up on.
 */
export function createQuickEntries({ api, novelId, storage: storageOption, retryDelay = 1000, maxRetryDelay = 30_000, onMade, onRefused }: QuickEntriesOptions): QuickEntries {
  const storage = storageOption === null ? undefined : (storageOption ?? sessionStorage());
  const key = `${STORAGE_PREFIX}${novelId}`;
  const store = createStore<QuickEntriesState>(() => ({ pending: restore() }));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sending = new Set<string>();
  let disposed = false;

  function restore(): PendingEntry[] {
    try {
      const saved = JSON.parse(storage?.getItem(key) ?? "[]") as unknown;
      if (!Array.isArray(saved)) return [];
      // A refusal is tried once more after a reload: the author may have fixed it meanwhile.
      return saved.filter((e): e is QuickEntry => !!e && typeof e.id === "string" && typeof e.type === "string" && typeof e.name === "string").map(({ id, type, name }) => ({ id, type, name }));
    } catch {
      return [];
    }
  }

  function set(pending: PendingEntry[]) {
    store.setState({ pending });
    try {
      if (pending.length) storage?.setItem(key, JSON.stringify(pending.map(({ id, type, name }) => ({ id, type, name }))));
      else storage?.removeItem(key);
    } catch {
      // Not kept across a reload; still sent.
    }
  }

  const find = (id: string) => store.getState().pending.find((e) => e.id === id);
  const update = (id: string, change: Partial<PendingEntry> | null) =>
    set(store.getState().pending.flatMap((e) => (e.id !== id ? [e] : change ? [{ ...e, ...change }] : [])));

  async function send(id: string, attempt = 0) {
    const entry = find(id);
    if (!entry || disposed || sending.has(id)) return;
    sending.add(id);
    try {
      await api.bible.createEntity(novelId, entry.type, { name: entry.name }, undefined, entry.id);
      if (!find(id)) return;
      update(id, null);
      onMade?.({ id: entry.id, type: entry.type, name: entry.name });
    } catch (e) {
      if (!find(id) || disposed) return;
      if (e instanceof ApiError && !e.retryable) {
        update(id, { refused: e.message });
        onRefused?.({ id: entry.id, type: entry.type, name: entry.name }, e.message);
        return;
      }
      timers.set(id, setTimeout(() => (timers.delete(id), void send(id, attempt + 1)), Math.min(retryDelay * 2 ** attempt, maxRetryDelay)));
    } finally {
      sending.delete(id);
    }
  }

  for (const e of store.getState().pending) void send(e.id);

  return {
    store,
    add(entry) {
      if (find(entry.id)) return;
      set([...store.getState().pending, { id: entry.id, type: entry.type, name: entry.name }]);
      void send(entry.id);
    },
    retry(id) {
      if (!find(id)) return;
      clearTimeout(timers.get(id));
      timers.delete(id);
      update(id, { refused: undefined });
      void send(id);
    },
    discard(id) {
      clearTimeout(timers.get(id));
      timers.delete(id);
      update(id, null);
    },
    ids: () => new Set(store.getState().pending.map((e) => e.id)),
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
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
