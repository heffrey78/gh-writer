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
  async function request<T>(method: string, path: string, body?: unknown, { keepalive = false }: RequestOptions = {}): Promise<{ status: number; data: T }> {
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
    if (!res.ok && res.status !== 409) throw new ApiError(res.status, data?.code ?? "HTTP", data?.error ?? `${method} ${path}: HTTP ${res.status}`);
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
      const { status, data } = await request<{ hash: string; current: TextFile | null }>("PUT", file(novelId, path), { content, base }, options);
      return status === 409 ? { ok: false, current: data.current } : { ok: true, hash: data.hash };
    },
    sync: async (id: string) => (await request<CommitStatus>("GET", `/api/novels/${encodeURIComponent(id)}/sync`)).data,
  };
}
