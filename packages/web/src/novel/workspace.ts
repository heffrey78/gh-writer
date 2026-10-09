import { createAutosave, type Api, type Autosave, type Conflict, type StorageLike } from "@gh-writer/client";
import { editFrontMatter, merge2, merge3, type MergeChunk, type YamlEdit } from "@gh-writer/core";
import { joinSceneFile, splitSceneFile } from "@gh-writer/editor";
import { createStore, type StoreApi } from "zustand/vanilla";

/** A scene file open for writing. */
export interface OpenFile {
  path: string;
  /** Kept byte for byte; the editor edits `body`. */
  frontMatter: string;
  /** The body as the editor last reported it (or as loaded). */
  body: string;
  /** The whole file as it is on disk, as far as we know: the base for merging, and how we tell unsaved text. */
  disk: string;
  hash: string;
}

/** A save refused because the file changed on disk, with changes that clash: for the conflict resolver. */
export interface SaveConflict {
  path: string;
  chunks: MergeChunk[];
  /** The file was deleted on disk. */
  deleted: boolean;
}

export interface WorkspaceState {
  files: Record<string, OpenFile>;
  /** Saves waiting for the author to settle a clash, oldest first. */
  conflicts: SaveConflict[];
  /** A file that couldn't be opened. */
  error: string | undefined;
}

/** A file changed on disk (the server's /events). */
export interface FileEvent {
  type: "add" | "change" | "unlink";
  path: string;
  hash: string | null;
}

export interface WorkspaceOptions {
  api: Api;
  novelId: string;
  /** How long typing must pause before a save (ms). */
  interval?: number;
  storage?: StorageLike | null;
  /**
   * A save changed a file's front matter (a scene's details, an entry's fields): the story model,
   * which other views read, needs loading again. Changes on disk from elsewhere come as file events.
   */
  onFrontMatterSaved?: (path: string) => void;
}

export interface Workspace {
  store: StoreApi<WorkspaceState>;
  autosave: Autosave;
  /** Read these scene files (those not open yet). */
  open(paths: string[]): Promise<void>;
  /** The editor's new body for a file: saved after a pause. */
  change(path: string, body: string): void;
  /** An open file's body as it stands, with text typed but not reported yet. */
  current(path: string): string | undefined;
  /** Hear of the author's edits to a body (not reloads from disk). Returns a function that stops it. */
  onEdit(listener: (path: string, before: string, after: string) => void): () => void;
  /**
   * Let the workspace ask the editor for text it hasn't reported yet (typing goes on), so a change on
   * disk never replaces it. Returns a function that removes it.
   */
  live(path: string, body: () => string | undefined): () => void;
  /**
   * Change fields of a scene's front matter, leaving the rest byte for byte: through the editor's
   * autosave if the file is open, otherwise read, edited and written with its hash (once more if it
   * changed meanwhile).
   */
  editFrontMatter(path: string, edits: YamlEdit[]): Promise<void>;
  /** A file changed on disk. Returns whether it was an open file (otherwise the model may need reloading). */
  fileChanged(e: FileEvent): Promise<boolean>;
  /** Settle the oldest save conflict: the merged text, or null to accept the deletion on disk. */
  resolve(path: string, content: string | null): void;
  dispose(): void;
}

/**
 * The files a writing view has open, kept in step with the disk. Edits autosave. A change on disk
 * reloads a file with no unsaved text; one with unsaved text is left for its next save, which the
 * server refuses (409) and which is then merged paragraph by paragraph with what's on disk. A clean
 * merge applies by itself; a clash goes to the author.
 */
export function createWorkspace({ api, novelId, interval, storage, onFrontMatterSaved }: WorkspaceOptions): Workspace {
  const store = createStore<WorkspaceState>(() => ({ files: {}, conflicts: [], error: undefined }));
  const live = new Map<string, () => string | undefined>();
  const editListeners = new Set<(path: string, before: string, after: string) => void>();
  const loading = new Map<string, Promise<void>>();
  // Front-matter edits written straight to files that aren't open: opening one waits for them.
  const writing = new Map<string, Promise<void>>();

  const file = (path: string) => store.getState().files[path];
  const setFile = (path: string, f: OpenFile | undefined) =>
    store.setState((s) => {
      const files = { ...s.files };
      if (f) files[path] = f;
      else delete files[path];
      return { files };
    });

  const autosave = createAutosave({
    api,
    novelId,
    ...(interval !== undefined ? { interval } : {}),
    ...(storage !== undefined ? { storage } : {}),
    onSaved: (path, content, hash) => {
      const f = file(path);
      if (f) setFile(path, { ...f, disk: content, hash });
      if (f && splitSceneFile(f.disk).frontMatter !== splitSceneFile(content).frontMatter) onFrontMatterSaved?.(path);
    },
    onConflict: (c) => void merge(c),
  });

  function load(path: string, content: string, hash: string): void {
    const { frontMatter, body } = splitSceneFile(content);
    setFile(path, { path, frontMatter, body, disk: content, hash });
    autosave.track(path, hash);
  }

  /** Unsaved text: reported but not on disk, or typed and not reported yet. */
  function dirty(f: OpenFile): boolean {
    const typed = live.get(f.path)?.();
    return joinSceneFile(f) !== f.disk || (typed !== undefined && typed !== f.body);
  }

  function merge(c: Conflict): void {
    const f = file(c.path);
    const base = f?.disk ?? "";
    if (c.disk === null) {
      store.setState((s) => ({ conflicts: [...s.conflicts, { path: c.path, chunks: [{ type: "conflict", base, ours: c.mine, theirs: "" }], deleted: true }] }));
      return;
    }
    const merged = f ? merge3(base, c.mine, c.disk.content) : merge2(c.mine, c.disk.content);
    if (merged.text !== undefined) {
      apply(c.path, merged.text, c.disk.content, c.disk.hash);
      return;
    }
    store.setState((s) => ({ conflicts: [...s.conflicts, { path: c.path, chunks: merged.chunks, deleted: false }] }));
  }

  /** Text that settles a conflict: into the editor, and saved over the disk version it was merged with. */
  function apply(path: string, text: string, disk: string, hash: string): void {
    const { frontMatter, body } = splitSceneFile(text);
    setFile(path, { path, frontMatter, body, disk, hash });
    autosave.resolve(path, text);
  }

  return {
    store,
    autosave,

    async open(paths) {
      await Promise.all(
        paths
          .filter((p) => !file(p))
          .map((path) => {
            let p = loading.get(path);
            if (!p) {
              p = (writing.get(path) ?? Promise.resolve())
                .then(() => api.readFile(novelId, path))
                .then(({ content, hash }) => {
                  // Unsaved text from before a reload (sessionStorage) wins over the disk: autosave saves it.
                  if (!file(path)) load(path, content, hash);
                })
                .catch((e: unknown) => store.setState({ error: `Couldn't open ${path}: ${e instanceof Error ? e.message : String(e)}` }))
                .finally(() => loading.delete(path));
              loading.set(path, p);
            }
            return p;
          }),
      );
    },

    change(path, body) {
      const f = file(path);
      if (!f || f.body === body) return;
      const next = { ...f, body };
      setFile(path, next);
      autosave.change(path, joinSceneFile(next));
      for (const listener of editListeners) listener(path, f.body, body);
    },

    current(path) {
      const f = file(path);
      return f && (live.get(path)?.() ?? f.body);
    },

    onEdit(listener) {
      editListeners.add(listener);
      return () => void editListeners.delete(listener);
    },

    async editFrontMatter(path, edits) {
      // A file being opened is edited once it's open, or the open would load what was there before.
      // Only then: awaiting nothing would let an open() start before this edit is under way.
      const opening = loading.get(path);
      if (opening) await opening;
      const f = file(path);
      if (f) {
        const next = splitSceneFile(editFrontMatter(joinSceneFile(f), edits));
        setFile(path, { ...f, frontMatter: next.frontMatter });
        autosave.change(path, joinSceneFile({ ...f, frontMatter: next.frontMatter }));
        return;
      }
      // After any earlier edit to the same file, so each reads what the last one wrote.
      const write = (writing.get(path) ?? Promise.resolve()).then(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const { content, hash } = await api.readFile(novelId, path);
          const result = await api.writeFile(novelId, path, editFrontMatter(content, edits), hash);
          if (result.ok) return;
        }
        throw new Error(`“${path}” keeps changing on disk; try again.`);
      });
      const settled = write.catch(() => undefined);
      writing.set(path, settled);
      void settled.then(() => writing.get(path) === settled && writing.delete(path));
      await write;
    },

    live(path, body) {
      live.set(path, body);
      return () => {
        if (live.get(path) === body) live.delete(path);
      };
    },

    async fileChanged(e) {
      const f = file(e.path);
      if (!f) return false;
      if (e.hash === f.hash) return true;
      // Unsaved text: its save will meet the change and merge with it.
      if (dirty(f)) return true;
      if (e.type === "unlink") {
        // Left open with its text: saving it again would bring it back; the model drops it from the list.
        return true;
      }
      const current = await api.readFile(novelId, e.path).catch(() => undefined);
      const now = file(e.path);
      if (current && now && !dirty(now)) load(e.path, current.content, current.hash);
      return true;
    },

    resolve(path, content) {
      const conflict = store.getState().conflicts.find((c) => c.path === path);
      if (!conflict) return;
      store.setState((s) => ({ conflicts: s.conflicts.filter((c) => c !== conflict) }));
      const disk = autosave.store.getState().conflicts.find((c) => c.path === path)?.disk;
      if (content === null) {
        autosave.discard(path);
        setFile(path, undefined);
        return;
      }
      if (disk) apply(path, content, disk.content, disk.hash);
      else {
        // Deleted on disk, and the author keeps the text: it's written back.
        const { frontMatter, body } = splitSceneFile(content);
        setFile(path, { path, frontMatter, body, disk: "", hash: "" });
        autosave.resolve(path, content);
      }
    },

    dispose() {
      void autosave.flush().finally(() => autosave.dispose());
    },
  };
}
