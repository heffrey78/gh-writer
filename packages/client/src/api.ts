/**
 * A typed client for the local server's API (packages/server). In the browser it rides on the session
 * cookie and the page's own Origin; elsewhere (tests, tools) pass them as `headers`.
 */

import type { Comparison, ParagraphDiff } from "@gh-writer/core/compare";
import type { SeriesSlot, WritingDay } from "@gh-writer/core";

/** GET /stats: the open version's writing days, the manuscript's words now, and novel.yaml's target. */
/** How a relationship type is drawn: a palette slot and a line. */
export interface RelationshipTypeStyle {
  color?: SeriesSlot;
  line?: "solid" | "dashed" | "dotted";
}

export interface WritingStats {
  days: WritingDay[];
  words: number;
  target: { words?: number; date?: string; daily?: number } | null;
  /** Saved work not committed yet: what today's history will add. */
  pending: { added: number; removed: number };
}

export type { ChapterComparison, ChangeStatus, Comparison, DiffPart, EntryComparison, EventComparison, FieldChange, ParagraphDiff, RelationshipComparison, SceneComparison } from "@gh-writer/core/compare";

/** The GitHub connection, as the server describes it (never with the token). */
/** A name and email git signs commits with. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** What the running app is: GET /api/app. */
export interface AppInfo {
  /** Running as the desktop app (otherwise from a terminal). */
  desktop: boolean;
  version: string | null;
  node: string;
  git: { version: string | null; bundled: boolean };
  /** A newer release, for the desktop app. */
  update: Release | null;
}

export interface Release {
  version: string;
  /** Its page on GitHub, with the downloads. */
  url: string;
  /** Markdown. */
  notes: string;
}

export interface License {
  name: string;
  text: string;
}

export interface GitHubStatus {
  signedIn: boolean;
  account?: { login: string; name?: string; avatarUrl?: string };
  /** Whether signing in with a code on github.com is available. */
  deviceFlow: boolean;
  /** The gh CLI's account, offered while signed out. */
  gh?: { login: string };
  /** GitHub stopped accepting the sign-in (said once). */
  expired?: boolean;
  /** Signed in, but GitHub can't be reached. */
  offline?: boolean;
  /** Signed in, but without permissions gh-writer needs: reconnect to grant them. */
  missingScopes?: string[];
  /** Signed in, but without what the drafting board needs (`project`): only the board asks for a reconnect. */
  missingBoardScopes?: string[];
  /** Why the system keychain couldn't be read. */
  keychain?: string;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** One of the author's GitHub repositories. */
export interface RepoSummary {
  fullName: string;
  description?: string;
  private: boolean;
  pushedAt?: string;
  cloneUrl: string;
}

export type DevicePoll = { status: "pending"; interval: number } | { status: "expired" | "denied" | "none" } | { status: "done"; account: GitHubStatus };

export interface NewNovel {
  title: string;
  author?: string;
  /** The folder; default: one named after the title in the library's folder. */
  path?: string;
  /** Who commits, for this novel only. */
  identity?: { name: string; email: string };
}

export interface LibraryEntry {
  id: string;
  path: string;
  title: string;
  author?: string;
  /** The cover from novel.yaml, a path in the novel (images/cover.jpg), and its version for imageUrl. */
  cover?: string;
  coverVersion?: string;
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
  /** The GitHub repository the novel syncs with; null (or absent from an older server) when it isn't on GitHub. */
  github?: GitHubRepo | null;
}

/** A repository on GitHub. */
export interface GitHubRepo {
  owner: string;
  name: string;
  /** Its page, e.g. https://github.com/ada/the-salt-road. */
  url: string;
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
  /** The version it belongs to, or null for a discarded version's (absent where it isn't known: a new checkpoint). */
  version?: string | null;
}

/** An alternate version of the novel (or the main one). */
export interface Version {
  /** "main" for the main version. */
  id: string;
  name: string;
  main: boolean;
  current: boolean;
  /** Made on another computer: opening it brings it here. */
  remoteOnly: boolean;
  words: number;
  /** When it last changed (ISO). */
  date: string;
  commit: string;
}

export interface DiscardResult {
  /** Restoring this checkpoint brings the discarded version's text back. */
  checkpoint: Checkpoint;
  /** The version open now. */
  current: string;
}

export interface AdoptResult {
  /** The main version as it was: restoring it undoes the adoption. */
  checkpoint: Checkpoint;
  commit: string | null;
  /** Passages both changed, to settle (resolveAdoption); the main version is open meanwhile, unchanged. */
  conflicts?: Conflicts;
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

export type ResolveAdoptionResult = { ok: true; commit: string } | { ok: false; conflicts: Conflicts | null };

export type ResolveResult = { ok: true; status: SyncStatus } | { ok: false; conflicts: Conflicts | null };

/** git's progress while cloning. `progress` is a percentage of the current stage. */
export interface CloneProgress {
  stage: string;
  progress: number;
  processed: number;
  total: number;
}

export interface CloneOptions {
  /** Where to clone to. Default: a folder named after the repository in ~/gh-writer. */
  path?: string;
  onProgress?: (p: CloneProgress) => void;
  /** Aborting closes the request, which stops the clone. */
  signal?: AbortSignal;
}

/** What an operation committed: the commit (null if nothing changed) and the files it wrote. */
export interface OperationResult {
  commit: string | null;
  files: string[];
}

export interface EntityFields {
  name?: string;
  aliases?: string[];
  summary?: string | null;
  image?: string | null;
  image_focus?: [number, number] | null;
  fields?: Record<string, string | number | boolean>;
  tags?: string[];
}

/** An off-page event's fields (null removes one on update). */
export interface EventFields {
  title?: string;
  when?: { at: string } | { day: number; time?: string } | null;
  duration?: string | null;
  characters?: string[] | null;
  locations?: string[] | null;
  plotlines?: string[] | null;
  /** The scene that dramatizes it. */
  scene?: string | null;
  /** Its note: the prose of its file. */
  note?: string | null;
}

/** A writer's note's fields (null removes one); `note` is its prose. */
export interface NoteFields {
  title?: string;
  tags?: string[] | null;
  /** The scenes it belongs to (#222). */
  scenes?: string[] | null;
  note?: string | null;
}

/**
 * How an event change goes: `base`, the hash of the event's file it was made from; `migrate`, to move a
 * novel in format v1 to v2 in the same commit (without it, that's refused with NEEDS_MIGRATION).
 */
export interface EventChangeOptions {
  base?: string;
  migrate?: boolean;
}

export interface RelationshipFields {
  from?: string;
  to?: string;
  type?: string;
  since?: string | null;
  until?: string | null;
  note?: string | null;
}

/** Something that refers to an entity, listed when deleting it is refused. */
export type Reference =
  | { kind: "scene"; id: string; title: string; via: string[] }
  | { kind: "relationship"; id: string; type: string; other: string }
  | { kind: "event"; id: string; title: string }
  | { kind: "entity"; id: string; title: string }
  | { kind: "note"; id: string; title: string };

/** A scene, chapter or part that was deleted and can be brought back. */
export interface DeletedItem {
  commit: string;
  date: string;
  kind: "scene" | "chapter" | "part";
  id: string;
  title: string;
  path: string;
}

export type DeleteResult = ({ ok: true } & OperationResult) | { ok: false; references: Reference[] };

export type WriteResult = { ok: true; hash: string } | { ok: false; current: TextFile | null };

/** A non-2xx answer other than a write conflict. `status` 0 means the server couldn't be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** git's own output behind a git failure, for a "details" disclosure. */
  readonly detail: string | undefined;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
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

/**
 * Where the app shows a picture from: images/<path> through the server, with its version (the model's
 * `images`) so a replaced picture isn't shown from the cache. Undefined for a path outside images/,
 * which the server doesn't serve.
 */
export function imageUrl(novelId: string, path: string | undefined, version?: string, baseUrl = ""): string | undefined {
  if (!path?.startsWith("images/") || path.split("/").some((s) => s === "" || s.startsWith("."))) return undefined;
  const rest = path.slice("images/".length).split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/api/novels/${encodeURIComponent(novelId)}/images/${rest}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** A library novel's cover, for the shelf (read without opening the novel), or undefined if it has none. */
export function coverUrl(novel: { id: string; cover?: string; coverVersion?: string }, baseUrl = ""): string | undefined {
  if (!novel.cover || !novel.coverVersion) return undefined;
  return `${baseUrl}/api/library/${encodeURIComponent(novel.id)}/cover?v=${encodeURIComponent(novel.coverVersion)}`;
}

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
    const data = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T & { code?: string; error?: string; detail?: string };
    if (!res.ok && !(res.status === 409 && passing !== undefined && data?.code === passing)) {
      throw new ApiError(res.status, data?.code ?? "HTTP", data?.error ?? `${method} ${path}: HTTP ${res.status}`, typeof data?.detail === "string" ? data.detail : undefined);
    }
    return { status: res.status, data };
  }

  const file = (novelId: string, path: string) => `/api/novels/${encodeURIComponent(novelId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;

  /** Send an image's bytes (the request's body, with its type); failures throw as `request`'s do. */
  async function upload<T>(method: string, path: string, image: Blob): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method, headers: { "content-type": image.type || "application/octet-stream", ...headers }, body: image, credentials: "same-origin" });
    } catch (e) {
      throw new ApiError(0, "UNREACHABLE", `Couldn't reach gh-writer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = (await res.json().catch(() => undefined)) as T & { code?: string; error?: string };
    if (!res.ok) throw new ApiError(res.status, data?.code ?? "HTTP", data?.error ?? `${method} ${path}: HTTP ${res.status}`);
    return data;
  }

  return {
    session: async () => (await request<{ authenticated: boolean }>("GET", "/api/session")).data,
    /** The app's version, its Node and git, and a newer release if there is one. */
    app: async () => (await request<AppInfo>("GET", "/api/app")).data,
    /** Who git signs as on this computer (null if it doesn't know), and a suggestion from the GitHub account (null signed out). */
    identity: async () => (await request<{ identity: GitIdentity | null; suggestion: GitIdentity | null }>("GET", "/api/identity")).data,
    /** Set who git signs as on this computer. Work waiting for it is committed. Rejects with BAD_IDENTITY. */
    setIdentity: async (identity: GitIdentity) => (await request<{ identity: GitIdentity }>("PUT", "/api/identity", identity)).data.identity,
    /** The licence texts the desktop app ships. */
    licenses: async () => (await request<{ licenses: License[] }>("GET", "/api/app/licenses")).data.licenses,
    /** The library, its notices, and the folder new novels and clones go in (~ for home). */
    library: async () => (await request<{ novels: LibraryEntry[]; notices: LibraryNotice[]; folder: string }>("GET", "/api/library")).data,
    /** Start a novel from the template. Rejects with NEEDS_IDENTITY when git doesn't know the author: send `identity` then. */
    createNovel: async (novel: NewNovel) => (await request<{ novel: LibraryEntry }>("POST", "/api/library/new", novel)).data.novel,
    addNovel: async (path: string) => (await request<{ novel: LibraryEntry }>("POST", "/api/library", { path })).data.novel,
    /** Clone owner/name or a URL into the library. Rejects with an ApiError carrying git's code (AUTH, NOT_FOUND…) and guidance. */
    clone: async (repo: string, { path, onProgress, signal }: CloneOptions = {}): Promise<LibraryEntry> => {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/library/clone`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(path ? { repo, path } : { repo }),
          credentials: "same-origin",
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ApiError(0, "UNREACHABLE", `Couldn't reach gh-writer: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => undefined)) as { code?: string; error?: string } | undefined;
        throw new ApiError(res.status, data?.code ?? "HTTP", data?.error ?? `Clone: HTTP ${res.status}`);
      }
      for await (const { event, data } of serverEvents(res.body)) {
        if (event === "progress") onProgress?.(data as CloneProgress);
        else if (event === "done") return (data as { novel: LibraryEntry }).novel;
        else if (event === "error") {
          const { code, error, detail } = data as { code: string; error: string; detail?: string };
          throw new ApiError(400, code, error, detail);
        }
      }
      throw new ApiError(0, "UNREACHABLE", "The clone stopped before it finished.");
    },
    github: {
      account: async () => (await request<GitHubStatus>("GET", "/api/github/account")).data,
      /** Start signing in with a code entered on github.com. */
      startDevice: async () => (await request<DeviceCode>("POST", "/api/github/device")).data,
      /** Ask once whether the code has been entered. */
      pollDevice: async () => (await request<DevicePoll>("POST", "/api/github/device/poll")).data,
      /** Sign in with the gh CLI's account. */
      useGh: async () => (await request<GitHubStatus>("POST", "/api/github/gh")).data,
      signOut: async () => (await request<GitHubStatus>("DELETE", "/api/github/account")).data,
      /** The author's repositories, most recently pushed first. */
      repos: async () => (await request<{ repos: RepoSummary[] }>("GET", "/api/github/repos")).data.repos,
      /** Put a local novel on GitHub: a new repository (private unless `private: false`), pushed to and synced with. */
      publish: async (novelId: string, repo: { name: string; description?: string; private?: boolean }) =>
        (await request<{ remote: string; status: SyncStatus }>("POST", `/api/novels/${encodeURIComponent(novelId)}/publish`, repo)).data,
    },
    removeNovel: async (id: string) => void (await request("DELETE", `/api/library/${encodeURIComponent(id)}`)),
    /** The story model (core's Novel), the hash of each file it was read from, and a version of each picture it shows. */
    novel: async <Novel = unknown>(id: string) => (await request<{ novel: Novel; files: Record<string, string>; images: Record<string, string> }>("GET", `/api/novels/${encodeURIComponent(id)}`)).data,
    /** Give the book a cover (JPEG or PNG bytes, already resized): images/cover.jpg and `cover:` in novel.yaml, one commit. */
    setCover: (id: string, image: Blob) => upload<OperationResult & { cover: string }>("PUT", `/api/novels/${encodeURIComponent(id)}/cover`, image),
    /** Save a picture for the prose (JPEG or PNG, already resized) under images/, named from `name`; the scene that names it commits it. */
    addPicture: (id: string, image: Blob, name: string) => upload<{ path: string }>("PUT", `/api/novels/${encodeURIComponent(id)}/images?name=${encodeURIComponent(name)}`, image),
    removeCover: async (id: string) => (await request<OperationResult>("POST", `/api/novels/${encodeURIComponent(id)}/cover/delete`)).data,
    readFile: async (novelId: string, path: string) => (await request<TextFile & { path: string }>("GET", file(novelId, path))).data,
    /** Write if the file on disk still has hash `base` (null: doesn't exist); otherwise the current file comes back. */
    writeFile: async (novelId: string, path: string, content: string, base: string | null, options?: RequestOptions): Promise<WriteResult> => {
      const { status, data } = await request<{ hash: string; current: TextFile | null }>("PUT", file(novelId, path), { content, base }, { ...options, passing: "CONFLICT" });
      return status === 409 ? { ok: false, current: data.current } : { ok: true, hash: data.hash };
    },
    sync: async (id: string) => (await request<SyncStatus>("GET", `/api/novels/${encodeURIComponent(id)}/sync`)).data,
    /** Compile the manuscript (or chapters from…to) with a preset, to one format: the file, its name, and characters the PDF couldn't show. */
    compile: async (id: string, options: { format: "docx" | "epub" | "pdf"; preset?: string; from?: string; to?: string }) => {
      const res = await fetch(`${baseUrl}/api/novels/${encodeURIComponent(id)}/compile`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(options),
        credentials: "same-origin",
      }).catch((e: unknown) => {
        throw new ApiError(0, "UNREACHABLE", `Couldn't reach gh-writer: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        throw new ApiError(res.status, data.code ?? "HTTP", data.error ?? `Compile failed: HTTP ${res.status}`);
      }
      const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `novel.${options.format}`;
      const missing = [...decodeURIComponent(res.headers.get("x-missing-characters") ?? "")];
      const coverProblem = res.headers.get("x-cover-problem");
      return { blob: await res.blob(), filename, missing, ...(coverProblem ? { coverProblem: decodeURIComponent(coverProblem) } : {}) };
    },
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
    /** The main version first. */
    versions: async (id: string) => (await request<{ versions: Version[] }>("GET", `/api/novels/${encodeURIComponent(id)}/versions`)).data.versions,
    /** Start a version from the open one (or from checkpoint `from`: a discarded version brought back), and open it. */
    startVersion: async (id: string, name: string, from?: string) =>
      (await request<{ version: Version }>("POST", `/api/novels/${encodeURIComponent(id)}/versions`, from === undefined ? { name } : { name, from })).data.version,
    switchVersion: async (id: string, versionId: string) =>
      (await request<{ version: Version }>("POST", `/api/novels/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/switch`)).data.version,
    /** Merge a version into the main version (which opens). */
    adoptVersion: async (id: string, versionId: string) => (await request<AdoptResult>("POST", `/api/novels/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/adopt`)).data,
    /** Finish adopting with the author's choices; if things moved on, the fresh conflicts instead. */
    resolveAdoption: async (id: string, versionId: string, upstream: string, files: Record<string, FileResolution>): Promise<ResolveAdoptionResult> => {
      const { status, data } = await request<{ commit: string; conflicts?: Conflicts | null }>(
        "POST",
        `/api/novels/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/adopt/resolve`,
        { upstream, files },
        { passing: "STALE" },
      );
      return status === 409 ? { ok: false, conflicts: data.conflicts ?? null } : { ok: true, commit: data.commit };
    },
    /** A scene from another version, into the open one; `undo` in the result reverses it. */
    bringScene: async (id: string, versionId: string, sceneId: string) =>
      (await request<RestoreResult>("POST", `/api/novels/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/scenes/${encodeURIComponent(sceneId)}/bring`)).data,
    /** Kept as an automatic checkpoint first: `checkpoint` in the result brings it back. */
    discardVersion: async (id: string, versionId: string) =>
      (await request<DiscardResult>("DELETE", `/api/novels/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`)).data,
    /** Set novel.yaml's targets (null removes one): one commit. */
    setTarget: async (id: string, target: { words?: number | null; date?: string | null; daily?: number | null }) =>
      (await request<OperationResult>("PUT", `/api/novels/${encodeURIComponent(id)}/target`, target)).data,
    /** Say when Day 1 is (null: it has no date), in novel.yaml: one commit. */
    setCalendar: async (id: string, start: string | null) => (await request<OperationResult>("PUT", `/api/novels/${encodeURIComponent(id)}/calendar`, { start })).data,
    /** The writing history: days with words added and removed and the book's length, the words now, and the target. */
    stats: async (id: string) => (await request<WritingStats>("GET", `/api/novels/${encodeURIComponent(id)}/stats`)).data,
    /** What changed between two states of the novel: each "now", "version:<id>" or "checkpoint:<id>". */
    compare: async (id: string, from: string, to: string) =>
      (await request<{ comparison: Comparison }>("GET", `/api/novels/${encodeURIComponent(id)}/compare?${new URLSearchParams({ from, to })}`)).data.comparison,
    /** One scene's text between the two, paragraph by paragraph, word by word where reworded. */
    compareScene: async (id: string, sceneId: string, from: string, to: string) =>
      (await request<{ paragraphs: ParagraphDiff[] }>("GET", `/api/novels/${encodeURIComponent(id)}/compare/scene/${encodeURIComponent(sceneId)}?${new URLSearchParams({ from, to })}`)).data.paragraphs,
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
    /** The story bible's changes: each is one commit; refusals throw ApiError with the server's code (STALE, BAD_REQUEST, BLOCKED…). */
    bible: bibleApi((id) => `/api/novels/${encodeURIComponent(id)}/bible`, request, upload),
    issues: issuesApi((id) => `/api/novels/${encodeURIComponent(id)}/issues`, request),
    /** The drafting board on GitHub (#11): failures to sync are in the status's `error`; setting up throws ApiError. */
    board: boardApi((id) => `/api/novels/${encodeURIComponent(id)}/board`, request),
    /** Reshaping the manuscript: each is one commit; IDs never change. */
    manuscript: manuscriptApi((id) => `/api/novels/${encodeURIComponent(id)}/manuscript`, request),
    /** Hand-placed diagram positions (diagrams/layouts.yaml), saved like typing: committed with the next autosave. */
    saveLayout: async (id: string, diagram: string, positions: Record<string, { x: number; y: number }>) =>
      (await request<{ file: string; hash: string }>("PUT", `/api/novels/${encodeURIComponent(id)}/diagrams/${encodeURIComponent(diagram)}/layout`, { positions })).data,
    /** Sync with the remote now; resolves with the status once it's done. */
    syncNow: async (id: string) => (await request<SyncStatus>("POST", `/api/novels/${encodeURIComponent(id)}/sync`)).data,
    /** The writer's notes (D12), one commit each. */
    notes: {
      create: (id: string, fields: NoteFields & { title: string }) => request<OperationResult & { id: string; file: string }>("POST", `/api/novels/${encodeURIComponent(id)}/notes`, fields).then((r) => r.data),
      update: (id: string, note: string, changes: NoteFields, base?: string) =>
        request<OperationResult & { file: string }>("PATCH", `/api/novels/${encodeURIComponent(id)}/notes/${encodeURIComponent(note)}`, { changes, ...(base ? { base } : {}) }).then((r) => r.data),
      /** Pin it to the top of a scene's notes (the scene's other unpinned), or unpin it. */
      pin: (id: string, note: string, scene: string, pinned: boolean) =>
        request<OperationResult>("POST", `/api/novels/${encodeURIComponent(id)}/notes/${encodeURIComponent(note)}/pin`, { scene, pinned }).then((r) => r.data),
      delete: (id: string, note: string, base?: string) => request<OperationResult>("POST", `/api/novels/${encodeURIComponent(id)}/notes/${encodeURIComponent(note)}/delete`, base ? { base } : {}).then((r) => r.data),
      /** To an off-page event, or a scene at the end of `chapter`; the note kept (naming it) or removed. */
      promote: (id: string, note: string, target: { to: "event" } | { to: "scene"; chapter: string }, { keep, migrate }: { keep: boolean; migrate?: boolean }) =>
        request<OperationResult & { id: string; file: string }>("POST", `/api/novels/${encodeURIComponent(id)}/notes/${encodeURIComponent(note)}/promote`, { ...target, keep, ...(migrate ? { migrate } : {}) }).then((r) => r.data),
    },
    /** Move the novel to the newest format (D11), one commit; `migrated` false when it was already. */
    migrate: async (id: string) => (await request<OperationResult & { migrated: boolean }>("POST", `/api/novels/${encodeURIComponent(id)}/migrate`)).data,
  };
}

/** The events of a text/event-stream body, as they arrive. */
export async function* serverEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = block.split("\n");
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      yield { event, data: JSON.parse(data) as unknown };
    }
  }
}

type Request = <T>(method: string, path: string, body?: unknown, options?: RequestOptions & { passing?: string }) => Promise<{ status: number; data: T }>;

/** A comment on an issue; a negative ID until one made offline is on GitHub. */
export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  pending?: boolean;
}

/** A GitHub issue of the novel's repository, as gh-writer has it (number negative while made offline). */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  milestone: number | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  commentCount: number;
  comments: IssueComment[];
  /** Changes made offline and not on GitHub yet. */
  pending?: boolean;
}

export interface IssueLabel {
  name: string;
  color: string;
  description: string;
}

export interface Milestone {
  number: number;
  title: string;
  state: "open" | "closed";
}

export interface IssuesStatus {
  repo: GitHubRepo | null;
  refreshedAt: string | null;
  error?: { code: string; message: string; resetAt?: string };
  queued: number;
  failed: { id: string; description: string; error: string }[];
}

export interface IssueFilter {
  state?: "open" | "closed" | "all";
  labels?: string[];
  milestone?: number | "none";
  q?: string;
}

export interface IssueInput {
  title?: string;
  body?: string;
  labels?: string[];
  milestone?: number | null;
  state?: "open" | "closed";
}

export interface IssueList {
  issues: Omit<Issue, "comments">[];
  labels: IssueLabel[];
  milestones: Milestone[];
  status: IssuesStatus;
}

function issuesApi(root: (novelId: string) => string, request: Request) {
  const call = async <T>(method: string, novelId: string, path: string, body?: unknown) => (await request<T>(method, `${root(novelId)}${path}`, body)).data;
  return {
    list: (novelId: string, filter: IssueFilter = {}) => {
      const q = new URLSearchParams();
      if (filter.state) q.set("state", filter.state);
      if (filter.labels?.length) q.set("labels", filter.labels.join(","));
      if (filter.milestone !== undefined) q.set("milestone", String(filter.milestone));
      if (filter.q) q.set("q", filter.q);
      const query = q.toString();
      return call<IssueList>("GET", novelId, query ? `?${query}` : "");
    },
    get: (novelId: string, number: number) => call<Issue>("GET", novelId, `/${number}`),
    create: (novelId: string, input: IssueInput & { title: string }) => call<Issue>("POST", novelId, "", input),
    update: (novelId: string, number: number, input: IssueInput) => call<Issue>("PATCH", novelId, `/${number}`, input),
    comment: (novelId: string, number: number, body: string) => call<IssueComment>("POST", novelId, `/${number}/comments`, { body }),
    /** Raise an issue about a passage: quoted, linked, labelled with its kind, and anchored (#9). */
    raise: (novelId: string, passage: { path: string; scene: string; sceneTitle: string; quote: string; title: string; details?: string; kind?: IssueLabel; labels?: string[] }) =>
      call<Issue>("POST", novelId, "/passage", passage),
    /** Make a label on the repository (with its colour) if it isn't there yet. */
    ensureLabel: (novelId: string, label: IssueLabel) => call<IssueLabel>("POST", novelId, "/labels", label),
    /** Delete a label from the repository (a deleted entry's): its issues lose it. */
    deleteLabel: (novelId: string, name: string) => call<object>("DELETE", novelId, `/labels/${encodeURIComponent(name)}`),
    /** Make a milestone on GitHub (needs GitHub: not queued offline). */
    createMilestone: (novelId: string, title: string) => call<Milestone>("POST", novelId, "/milestones", { title }),
    updateMilestone: (novelId: string, number: number, change: { title?: string; state?: "open" | "closed" }) => call<Milestone>("PATCH", novelId, `/milestones/${number}`, change),
    /** Bring the cache up to date with GitHub, and send changes made offline. */
    refresh: (novelId: string) => call<{ changed: boolean; status: IssuesStatus }>("POST", novelId, "/refresh"),
    /** Drop a change GitHub refused. */
    discard: (novelId: string, change: string) => call<{ status: IssuesStatus }>("DELETE", novelId, `/queue/${encodeURIComponent(change)}`),
  };
}

export type SceneStatusName = "idea" | "outlined" | "drafted" | "revised" | "final";

/** A scene whose status was changed both in its file and on the GitHub board, to different values. */
export interface BoardConflict {
  scene: string;
  title: string;
  file: SceneStatusName;
  board: SceneStatusName;
}

/** What a sync of the board did. */
export interface BoardSummary {
  added: number;
  removed: number;
  updated: number;
  /** Status changes from the board, now in the scene files. */
  fromBoard: { scene: string; title: string; status: SceneStatusName }[];
  /** Board edits to fields the files own, put back. */
  putBack: { scene: string; title: string; fields: string[] }[];
}

export interface BoardStatus {
  repo: GitHubRepo | null;
  project: { number: number; title: string; url: string } | null;
  syncedAt: string | null;
  last: BoardSummary | null;
  conflicts: BoardConflict[];
  error?: { code: string; message: string; resetAt?: string };
  /** The project was deleted on GitHub. */
  gone?: boolean;
}

function boardApi(root: (novelId: string) => string, request: Request) {
  const call = async (method: string, novelId: string, path: string, body?: unknown) => (await request<BoardStatus>(method, `${root(novelId)}${path}`, body)).data;
  return {
    status: (novelId: string) => call("GET", novelId, ""),
    /** Make the novel's project on GitHub (or adopt the one it has) and sync it. */
    setUp: (novelId: string) => call("POST", novelId, ""),
    sync: (novelId: string) => call("POST", novelId, "/sync"),
    /** Settle a status conflict: keep the file's status, or the board's. */
    resolve: (novelId: string, scene: string, keep: "file" | "board") => call("POST", novelId, `/conflicts/${encodeURIComponent(scene)}`, { keep }),
  };
}

function bibleApi(root: (novelId: string) => string, request: Request, upload: <T>(method: string, path: string, image: Blob) => Promise<T>) {
  const call = async <T>(method: string, novelId: string, path: string, body?: unknown) => (await request<T>(method, `${root(novelId)}${path}`, body)).data;
  return {
    /**
     * Give an entry a picture (JPEG or PNG bytes, already cropped and resized), with the point its
     * thumbnails centre on: saved in images/ and set as its image, one commit. `base`: the entry file's hash.
     */
    setPicture: (novelId: string, id: string, base: string, image: Blob, focus?: [number, number]) =>
      upload<OperationResult & { file: string; image: string }>(
        "PUT",
        `${root(novelId)}/entities/${encodeURIComponent(id)}/picture?base=${encodeURIComponent(base)}${focus ? `&focus=${focus.join(",")}` : ""}`,
        image,
      ),
    /** Take an entry's picture away, and its file in images/. */
    removePicture: (novelId: string, id: string, base: string) => call<OperationResult & { file: string }>("POST", novelId, `/entities/${encodeURIComponent(id)}/picture/delete`, { base }),
    /** `id`: one the app picked (e.g. for a mention written before the file); otherwise the server picks. */
    createEntity: (novelId: string, type: string, fields: EntityFields & { name: string }, notes?: string, id?: string) =>
      call<OperationResult & { id: string; file: string }>("POST", novelId, "/entities", { type, ...fields, ...(notes ? { notes } : {}), ...(id ? { id } : {}) }),
    updateEntity: (novelId: string, id: string, base: string, changes: EntityFields) =>
      call<OperationResult & { file: string }>("PATCH", novelId, `/entities/${encodeURIComponent(id)}`, { base, changes }),
    /** Refused (not thrown) when something refers to it: the references come back; pass confirm to delete anyway. */
    deleteEntity: async (novelId: string, id: string, base: string, confirm = false): Promise<DeleteResult> => {
      const { status, data } = await request<OperationResult & { references?: Reference[] }>(
        "POST",
        `${root(novelId)}/entities/${encodeURIComponent(id)}/delete`,
        { base, confirm },
        { passing: "REFERENCED" },
      );
      return status === 409 ? { ok: false, references: data.references ?? [] } : { ok: true, ...data };
    },
    createRelationship: (novelId: string, fields: RelationshipFields & { from: string; to: string; type: string }) =>
      call<OperationResult & { id: string }>("POST", novelId, "/relationships", fields),
    updateRelationship: (novelId: string, id: string, changes: RelationshipFields) => call<OperationResult>("PATCH", novelId, `/relationships/${encodeURIComponent(id)}`, { changes }),
    /** From scene `at` on, the relationship is of `type` (or has `note`): the current record ends there and a new one starts. */
    changeRelationship: (novelId: string, id: string, at: string, changes: { type?: string; note?: string | null }) =>
      call<OperationResult & { id: string }>("POST", novelId, `/relationships/${encodeURIComponent(id)}/change`, { at, ...changes }),
    endRelationship: (novelId: string, id: string, at: string) => call<OperationResult>("POST", novelId, `/relationships/${encodeURIComponent(id)}/end`, { at }),
    deleteRelationship: (novelId: string, id: string) => call<OperationResult>("POST", novelId, `/relationships/${encodeURIComponent(id)}/delete`),
    /** Off-page story events, each a file in bible/events/ (D11), one commit each. */
    createEvent: (novelId: string, fields: EventFields & { title: string }, { migrate }: EventChangeOptions = {}) =>
      call<OperationResult & { id: string; file: string }>("POST", novelId, "/events", { ...fields, ...(migrate ? { migrate } : {}) }),
    updateEvent: (novelId: string, id: string, changes: EventFields, options: EventChangeOptions = {}) =>
      call<OperationResult & { file: string }>("PATCH", novelId, `/events/${encodeURIComponent(id)}`, { changes, ...options }),
    /**
     * Write an event as a scene at the end of `chapter`: its details filled in, its note the synopsis. The
     * event is kept (naming the scene) or removed; removing one that prose mentions is refused (REFERENCED).
     */
    writeAsScene: (novelId: string, id: string, { chapter, keep, migrate }: { chapter: string; keep: boolean; migrate?: boolean }) =>
      call<OperationResult & { scene: string; file: string }>("POST", novelId, `/events/${encodeURIComponent(id)}/scene`, { chapter, keep, ...(migrate ? { migrate } : {}) }),
    /** Refused (not thrown) when prose mentions it: the mentions come back; pass confirm to delete anyway. */
    deleteEvent: async (novelId: string, id: string, { confirm = false, ...options }: EventChangeOptions & { confirm?: boolean } = {}): Promise<DeleteResult> => {
      const { status, data } = await request<OperationResult & { references?: Reference[] }>(
        "POST",
        `${root(novelId)}/events/${encodeURIComponent(id)}/delete`,
        { confirm, ...options },
        { passing: "REFERENCED" },
      );
      return status === 409 ? { ok: false, references: data.references ?? [] } : { ok: true, ...data };
    },
    createEntityType: (novelId: string, fields: { key: string; prefix: string; label: string; folder?: string; color?: string }) =>
      call<OperationResult>("POST", novelId, "/entity-types", fields),
    updateEntityType: (novelId: string, key: string, changes: { label?: string; color?: string | null }) =>
      call<OperationResult>("PATCH", novelId, `/entity-types/${encodeURIComponent(key)}`, changes),
    createRelationshipType: (novelId: string, fields: { key: string; label: string; inverse_label?: string; symmetric?: boolean; from_types?: string[]; to_types?: string[]; style?: RelationshipTypeStyle }) =>
      call<OperationResult>("POST", novelId, "/relationship-types", fields),
    updateRelationshipType: (novelId: string, key: string, changes: { label?: string; inverse_label?: string; symmetric?: boolean; from_types?: string[]; to_types?: string[]; style?: RelationshipTypeStyle }) =>
      call<OperationResult>("PATCH", novelId, `/relationship-types/${encodeURIComponent(key)}`, changes),
  };
}

function manuscriptApi(root: (novelId: string) => string, request: Request) {
  const call = async <T>(method: string, novelId: string, path: string, body?: unknown) => (await request<T>(method, `${root(novelId)}${path}`, body)).data;
  const item = (id: string) => `/items/${encodeURIComponent(id)}`;
  return {
    /** A new scene in a chapter, after `after` (null: first; omitted: last). */
    createScene: (novelId: string, chapter: string, title: string, after?: string | null) =>
      call<OperationResult & { id: string }>("POST", novelId, "/scenes", { chapter, title, ...(after !== undefined ? { after } : {}) }),
    createChapter: (novelId: string, part: string | null, title?: string, after?: string | null) =>
      call<OperationResult & { id: string }>("POST", novelId, "/chapters", { part, ...(title ? { title } : {}), ...(after !== undefined ? { after } : {}) }),
    createPart: (novelId: string, title: string, after?: string | null) => call<OperationResult & { id: string }>("POST", novelId, "/parts", { title, ...(after !== undefined ? { after } : {}) }),
    rename: (novelId: string, id: string, title: string) => call<OperationResult>("POST", novelId, `${item(id)}/rename`, { title }),
    /** To position `index` in container `to` (a chapter for a scene, a part for a chapter; omitted: where it is). */
    move: (novelId: string, id: string, index: number, to?: string | null) => call<OperationResult>("POST", novelId, `${item(id)}/move`, { index, ...(to !== undefined ? { to } : {}) }),
    /**
     * Notes left on no scene by the delete are kept unattached or deleted as `notes` says; without it,
     * a delete that would leave some is refused (409 NOTES_LEFT { notes }) for the app to ask (#222).
     */
    delete: (novelId: string, id: string, notes?: "keep" | "delete") => call<OperationResult>("POST", novelId, `${item(id)}/delete`, notes ? { notes } : undefined),
    /** Before paragraph `paragraph` (0-based); the rest becomes a new scene titled `title`. */
    split: (novelId: string, scene: string, paragraph: number, title: string) => call<OperationResult & { id: string }>("POST", novelId, `/scenes/${encodeURIComponent(scene)}/split`, { paragraph, title }),
    /** With the next scene in its chapter. */
    merge: (novelId: string, scene: string) => call<OperationResult>("POST", novelId, `/scenes/${encodeURIComponent(scene)}/merge`),
    recentlyDeleted: async (novelId: string) => (await call<{ deleted: DeletedItem[] }>("GET", novelId, "/deleted", undefined)).deleted,
    restore: (novelId: string, commit: string, id: string) => call<OperationResult>("POST", novelId, "/deleted/restore", { commit, id }),
  };
}
