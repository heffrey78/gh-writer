/**
 * A typed client for the local server's API (packages/server). In the browser it rides on the session
 * cookie and the page's own Origin; elsewhere (tests, tools) pass them as `headers`.
 */

export interface LibraryEntry {
  id: string;
  path: string;
  title: string;
  remote?: string;
  lastOpened: string;
}

export interface LibraryNotice {
  code: "MISSING" | "UNREADABLE";
  message: string;
  path: string;
}

export interface TextFile {
  content: string;
  hash: string;
}

export interface CommitStatus {
  state: "idle" | "pending" | "committing" | "blocked" | "off";
  pendingChanges?: number;
  lastCommit?: { hash: string; summary: string; date: string } | null;
  blocked?: { code: string; message: string };
}

/** The sync state ("off" when the server doesn't sync), with the background commit status. */
export interface SyncStatus {
  state: "local" | "syncing" | "synced" | "ahead" | "behind" | "offline" | "needs-sign-in" | "conflict" | "error" | "off";
  remote?: string | null;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  lastSync?: string | null;
  /** Files changed on both sides, for the resolver (#47). */
  conflict?: { files: string[] };
  error?: { code: string; message: string; detail?: string };
  commit: CommitStatus;
}

export interface Checkpoint {
  /** For URLs, e.g. "2026-10-05-183012-before-the-big-cut". */
  id: string;
  name: string;
  date: string;
  words: number;
  /** Taken automatically before a restore. */
  auto: boolean;
  commit: string;
}

export interface RestoreResult {
  /** Restore this checkpoint to undo the restore. */
  undo: Checkpoint;
  commit: string | null;
  files: string[];
}

/** A paragraph-level merge chunk (core's MergeChunk). */
export type MergeChunk = { type: "same"; text: string } | { type: "conflict"; base: string; ours: string; theirs: string; field?: string };

/** What a sync conflict leaves to settle (server: GET /conflicts). */
export interface Conflicts {
  /** The remote commit being merged: send it back with the resolution. */
  upstream: string;
  files: { path: string; ours: string | null; inOurs: boolean; inTheirs: boolean; binary: boolean; chunks: MergeChunk[] }[];
}

/** A file's resolution: its text (null deletes it) or one side kept, with the `ours` hash from the conflict. */
export type FileResolution = { ours: string | null } & ({ content: string | null } | { keep: "ours" | "theirs" });

export type ResolveResult = { ok: true; status: SyncStatus } | { ok: false; conflicts: Conflicts | null };

export type WriteResult = { ok: true; hash: string } | { ok: false; current: TextFile | null };

/** A non-2xx answer other than a write conflict. `status` 0 means the server couldn't be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** Worth trying again: the server was unreachable or failed, rather than refusing the request. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export interface ApiOptions {
  /** Where the server is. Default: the page's own origin. */
  baseUrl?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  /** Let the request outlive the page (page hide, unload). Browsers cap keepalive bodies at 64 kB. */
  keepalive?: boolean;
}

export type Api = ReturnType<typeof createApi>;

/** Browsers refuse keepalive requests with larger bodies; stay under their 64 kB budget. */
const KEEPALIVE_LIMIT = 60_000;

export function createApi({ baseUrl = "", headers = {}, fetch = globalThis.fetch.bind(globalThis) }: ApiOptions = {}) {
  /** `passing` names the 409 code the caller handles itself (a stale write or resolution); any other failure throws. */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    { keepalive = false, passing }: RequestOptions & { passing?: string } = {},
  ): Promise<{ status: number; data: T }> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...(text !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(text !== undefined ? { body: text } : {}),
        credentials: "same-origin",
        keepalive: keepalive && (text?.length ?? 0) < KEEPALIVE_LIMIT,
      });
    } catch (e) {
      throw new ApiError(0, "UNREACHABLE", `Couldn't reach gh-writer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T & { code?: string; error?: string };
    if (!res.ok && !(res.status === 409 && passing !== undefined && data?.code === passing)) throw new ApiError(res.status, data?.code ?? "HTTP", data?.error ?? `${method} ${path}: HTTP ${res.status}`);
    return { status: res.status, data };
  }

  const file = (novelId: string, path: string) => `/api/novels/${encodeURIComponent(novelId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

  return {
    session: async () => (await request<{ authenticated: boolean }>("GET", "/api/session")).data,
    library: async () => (await request<{ novels: LibraryEntry[]; notices: LibraryNotice[] }>("GET", "/api/library")).data,
    addNovel: async (path: string) => (await request<{ novel: LibraryEntry }>("POST", "/api/library", { path })).data.novel,
    removeNovel: async (id: string) => void (await request("DELETE", `/api/library/${encodeURIComponent(id)}`)),
    /** The story model (core's Novel) and the hash of each file it was read from. */
    novel: async <Novel = unknown>(id: string) => (await request<{ novel: Novel; files: Record<string, string> }>("GET", `/api/novels/${encodeURIComponent(id)}`)).data,
    readFile: async (novelId: string, path: string) => (await request<TextFile & { path: string }>("GET", file(novelId, path))).data,
    /** Write if the file on disk still has hash `base` (null: doesn't exist); otherwise the current file comes back. */
    writeFile: async (novelId: string, path: string, content: string, base: string | null, options?: RequestOptions): Promise<WriteResult> => {
      const { status, data } = await request<{ hash: string; current: TextFile | null }>("PUT", file(novelId, path), { content, base }, { ...options, passing: "CONFLICT" });
      return status === 409 ? { ok: false, current: data.current } : { ok: true, hash: data.hash };
    },
    sync: async (id: string) => (await request<SyncStatus>("GET", `/api/novels/${encodeURIComponent(id)}/sync`)).data,
    /** Newest first. */
    checkpoints: async (id: string) => (await request<{ checkpoints: Checkpoint[] }>("GET", `/api/novels/${encodeURIComponent(id)}/checkpoints`)).data.checkpoints,
    createCheckpoint: async (id: string, name: string) =>
      (await request<{ checkpoint: Checkpoint }>("POST", `/api/novels/${encodeURIComponent(id)}/checkpoints`, { name })).data.checkpoint,
    /** The whole manuscript, or one scene; `undo` in the result is the checkpoint that reverses it. */
    restoreCheckpoint: async (id: string, checkpointId: string, sceneId?: string) =>
      (
        await request<RestoreResult>(
          "POST",
          `/api/novels/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
          sceneId === undefined ? {} : { sceneId },
        )
      ).data,
    /** The conflicts a sync left to settle, or null. */
    conflicts: async (id: string) => (await request<{ conflicts: Conflicts | null }>("GET", `/api/novels/${encodeURIComponent(id)}/conflicts`)).data.conflicts,
    /**
     * Settle the conflicts: the merge is committed and pushed. If they changed since they were read
     * (the remote moved, or a file changed), nothing happens and the fresh conflicts come back.
     */
    resolveConflicts: async (id: string, upstream: string, files: Record<string, FileResolution>): Promise<ResolveResult> => {
      const { status, data } = await request<SyncStatus & { conflicts?: Conflicts | null }>(
        "POST",
        `/api/novels/${encodeURIComponent(id)}/conflicts/resolve`,
        { upstream, files },
        { passing: "STALE" },
      );
      return status === 409 ? { ok: false, conflicts: data.conflicts ?? null } : { ok: true, status: data };
    },
    /** Sync with the remote now; resolves with the status once it's done. */
    syncNow: async (id: string) => (await request<SyncStatus>("POST", `/api/novels/${encodeURIComponent(id)}/sync`)).data,
  };
}
