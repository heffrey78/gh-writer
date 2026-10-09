import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { GitHubError, unreachable, type GitHub, type GitHubRepo } from "./github.ts";

/*
 * A novel's GitHub issues (#8), as gh-writer keeps them: fetched from the novel's repository and
 * cached per clone in .git/gh-writer/issues.json (never committed: issues are work, not story facts,
 * D1), so they're there offline and cost few API calls. Changes go to GitHub, and its answer goes
 * into the cache.
 */

export interface IssueComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  /** Its milestone's number, or null. */
  milestone: number | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Its page on GitHub. */
  url: string;
  commentCount: number;
  comments: IssueComment[];
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Milestone {
  number: number;
  title: string;
  state: "open" | "closed";
}

export type IssuesErrorCode = "NOT_ON_GITHUB" | "NO_SIGN_IN" | "OFFLINE" | "RATE_LIMITED" | "NOT_FOUND" | "BAD_REQUEST" | "GITHUB";

export class IssuesError extends Error {
  readonly code: IssuesErrorCode;
  /** For RATE_LIMITED: when GitHub will answer again (ISO). */
  readonly resetAt: string | undefined;

  constructor(code: IssuesErrorCode, message: string, resetAt?: string) {
    super(message);
    this.name = "IssuesError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

/** How the cache stands: when it was last brought up to date, and why the last refresh failed, if it did. */
export interface IssuesStatus {
  repo: GitHubRepo | null;
  refreshedAt: string | null;
  error?: { code: IssuesErrorCode; message: string; resetAt?: string };
}

export interface IssueFilter {
  state?: "open" | "closed" | "all";
  /** All of these labels. */
  labels?: string[];
  /** A milestone's number, or "none" for issues without one. */
  milestone?: number | "none";
  /** Words that must all appear in the title, body or comments (any case). */
  text?: string;
}

export interface IssueInput {
  title?: string;
  body?: string;
  labels?: string[];
  milestone?: number | null;
  state?: "open" | "closed";
}

interface Cache {
  /** owner/name: a cache for another repository is started afresh. */
  repo: string;
  refreshedAt: string | null;
  /** The newest updated_at seen, for the next refresh's `since`. */
  since: string | null;
  etags: Record<string, string>;
  issues: Issue[];
  labels: Label[];
  milestones: Milestone[];
}

const PER_PAGE = 100;

export class IssueStore {
  readonly root: string;
  #github: GitHub;
  #repo: () => Promise<GitHubRepo | null>;
  #cache: Cache | undefined;
  #file: string | undefined;
  #status: IssuesStatus = { repo: null, refreshedAt: null };
  #refreshing: Promise<boolean> | undefined;
  #listeners = new Set<() => void>();
  #used = new Set<string>();

  constructor(root: string, github: GitHub, repo: () => Promise<GitHubRepo | null>) {
    this.root = root;
    this.#github = github;
    this.#repo = repo;
  }

  /** Hear when the cached issues change. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async status(): Promise<IssuesStatus> {
    await this.#load();
    return this.#status;
  }

  /** The cached issues matching `filter`, most recently updated first, without their comments. */
  async list(filter: IssueFilter = {}): Promise<{ issues: Omit<Issue, "comments">[]; labels: Label[]; milestones: Milestone[]; status: IssuesStatus }> {
    const cache = await this.#load();
    const state = filter.state ?? "open";
    const words = (filter.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const issues = cache.issues
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => (filter.labels ?? []).every((l) => i.labels.includes(l)))
      .filter((i) => filter.milestone === undefined || (filter.milestone === "none" ? i.milestone === null : i.milestone === filter.milestone))
      .filter((i) => {
        if (!words.length) return true;
        const text = [i.title, i.body, ...i.comments.map((c) => c.body)].join("\n").toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
      .map(({ comments: _, ...rest }) => rest);
    return { issues, labels: cache.labels, milestones: cache.milestones, status: this.#status };
  }

  /** One cached issue with its comments. */
  async get(number: number): Promise<Issue> {
    const issue = (await this.#load()).issues.find((i) => i.number === number);
    if (!issue) throw new IssuesError("NOT_FOUND", `No issue #${number}.`);
    return issue;
  }

  /**
   * Bring the cache up to date: issues and comments changed since the last refresh, and the labels and
   * milestones (ETags make an unchanged list nearly free). Resolves to whether anything changed; a
   * failure is kept in the status (and thrown) while the cache keeps serving.
   */
  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#refresh().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async create(input: IssueInput & { title: string }): Promise<Issue> {
    if (!input.title.trim()) throw new IssuesError("BAD_REQUEST", "An issue needs a title.");
    const repo = await this.#requireRepo();
    const json = await this.#send(repo, "/issues", "POST", clean(input));
    return this.#upsert(fromIssue(json as GhIssue), []);
  }

  async update(number: number, input: IssueInput): Promise<Issue> {
    if (input.title !== undefined && !input.title.trim()) throw new IssuesError("BAD_REQUEST", "An issue needs a title.");
    const repo = await this.#requireRepo();
    const json = await this.#send(repo, `/issues/${number}`, "PATCH", clean(input));
    const known = (await this.#load()).issues.find((i) => i.number === number);
    return this.#upsert(fromIssue(json as GhIssue), known?.comments ?? []);
  }

  async comment(number: number, body: string): Promise<IssueComment> {
    if (!body.trim()) throw new IssuesError("BAD_REQUEST", "A comment needs some text.");
    const repo = await this.#requireRepo();
    const comment = fromComment((await this.#send(repo, `/issues/${number}/comments`, "POST", { body })) as GhComment);
    const cache = await this.#load();
    const issue = cache.issues.find((i) => i.number === number);
    if (issue) {
      issue.comments = [...issue.comments.filter((c) => c.id !== comment.id), comment];
      issue.commentCount = Math.max(issue.commentCount, issue.comments.length);
      issue.updatedAt = comment.updatedAt > issue.updatedAt ? comment.updatedAt : issue.updatedAt;
      await this.#save();
      this.#changed();
    }
    return comment;
  }

  async #refresh(): Promise<boolean> {
    const cache = await this.#load();
    const repo = this.#status.repo;
    if (!repo) return false;
    try {
      const since = cache.since;
      const q = since ? `&since=${encodeURIComponent(since)}` : "";
      let changed = false;
      const issues = await this.#pages<GhIssue>(repo, `/issues?state=all&sort=updated&direction=asc${q}`);
      if (issues) {
        for (const json of issues) {
          // GitHub lists pull requests with the issues: they aren't the novel's issues.
          if (json.pull_request) continue;
          const known = cache.issues.find((i) => i.number === json.number);
          const issue = fromIssue(json);
          // `since` takes in the newest one again each time: only a real change counts.
          if (known && JSON.stringify({ ...known, comments: [] }) === JSON.stringify(issue)) continue;
          this.#upsert(issue, known?.comments ?? [], { quiet: true });
          changed = true;
        }
      }
      const comments = await this.#pages<GhComment>(repo, `/issues/comments?sort=updated&direction=asc${q}`);
      if (comments) {
        for (const json of comments) {
          const number = Number(/\/issues\/(\d+)$/.exec(json.issue_url)?.[1]);
          const issue = cache.issues.find((i) => i.number === number);
          if (!issue) continue;
          const c = fromComment(json);
          const known = issue.comments.find((x) => x.id === c.id);
          if (known && JSON.stringify(known) === JSON.stringify(c)) continue;
          issue.comments = [...issue.comments.filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          changed = true;
        }
      }
      const labels = await this.#pages<Label>(repo, "/labels?");
      if (labels) {
        const next = labels.map(({ name, color, description }) => ({ name, color, description: description ?? "" }));
        changed ||= JSON.stringify(next) !== JSON.stringify(cache.labels);
        cache.labels = next;
      }
      const milestones = await this.#pages<{ number: number; title: string; state: "open" | "closed" }>(repo, "/milestones?state=all");
      if (milestones) {
        const next = milestones.map(({ number, title, state }) => ({ number, title, state }));
        changed ||= JSON.stringify(next) !== JSON.stringify(cache.milestones);
        cache.milestones = next;
      }
      // Only the ETags this refresh used: an old `since` won't be asked for again.
      cache.etags = Object.fromEntries(Object.entries(cache.etags).filter(([url]) => this.#used.has(url)));
      this.#used.clear();
      const newest = [...cache.issues.map((i) => i.updatedAt), ...cache.issues.flatMap((i) => i.comments.map((c) => c.updatedAt))].sort().at(-1);
      cache.since = newest ?? cache.since;
      cache.refreshedAt = new Date().toISOString();
      this.#status = { repo, refreshedAt: cache.refreshedAt };
      await this.#save();
      if (changed) this.#changed();
      return changed;
    } catch (e) {
      const error = asIssuesError(e);
      this.#status = { ...this.#status, error: { code: error.code, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) } };
      this.#changed();
      throw error;
    }
  }

  /**
   * Every page of a list, or undefined when GitHub says the first page hasn't changed (304 to its
   * ETag): then nothing in it has, as far as gh-writer needs to know.
   */
  async #pages<T>(repo: GitHubRepo, path: string): Promise<T[] | undefined> {
    const cache = this.#cache!;
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.endsWith("?") ? "" : "&";
      const url = `${apiPath(repo)}${path}${sep}per_page=${PER_PAGE}&page=${page}`;
      // Only the first page's ETag: a 304 there means the whole list is as it was.
      const etagKey = page === 1 ? url : undefined;
      const etag = etagKey ? cache.etags[etagKey] : undefined;
      if (etagKey) this.#used.add(etagKey);
      const res = await this.#call(url, { ...(etag ? { headers: { "If-None-Match": etag } } : {}) });
      if (res.status === 304) return undefined;
      await check(res);
      if (etagKey) {
        const fresh = res.headers.get("etag");
        if (fresh) cache.etags[etagKey] = fresh;
      }
      const items = (await res.json()) as T[];
      out.push(...items);
      if (items.length < PER_PAGE) return out;
    }
  }

  async #send(repo: GitHubRepo, path: string, method: string, body: unknown): Promise<unknown> {
    const res = await this.#call(`${apiPath(repo)}${path}`, { method, body });
    await check(res);
    return res.json();
  }

  async #call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    try {
      return await this.#github.api(path, init);
    } catch (e) {
      throw asIssuesError(e);
    }
  }

  #upsert(issue: Issue, comments: IssueComment[], { quiet = false } = {}): Issue {
    const cache = this.#cache!;
    const merged = { ...issue, comments };
    cache.issues = [...cache.issues.filter((i) => i.number !== issue.number), merged];
    if (!quiet) {
      void this.#save();
      this.#changed();
    }
    return merged;
  }

  async #requireRepo(): Promise<GitHubRepo> {
    await this.#load();
    if (!this.#status.repo) throw new IssuesError("NOT_ON_GITHUB", "This novel isn't on GitHub.");
    return this.#status.repo;
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  /** The cache for the novel's current repository (a novel put on GitHub, or moved, starts afresh). */
  async #load(): Promise<Cache> {
    const repo = await this.#repo();
    const key = repo ? `${repo.owner}/${repo.name}` : "";
    this.#status = { ...this.#status, repo };
    if (this.#cache && this.#cache.repo === key) return this.#cache;
    this.#file ??= join(await gitDir(this.root), "gh-writer", "issues.json");
    const saved = await readFile(this.#file, "utf8")
      .then((t) => JSON.parse(t) as Cache)
      .catch(() => undefined);
    this.#cache = saved && saved.repo === key ? saved : { repo: key, refreshedAt: null, since: null, etags: {}, issues: [], labels: [], milestones: [] };
    this.#status = { repo, refreshedAt: this.#cache.refreshedAt };
    return this.#cache;
  }

  async #save(): Promise<void> {
    if (!this.#cache || !this.#file) return;
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#cache));
    await rename(tmp, this.#file);
  }
}

async function gitDir(root: string): Promise<string> {
  return (await git(root).raw(["rev-parse", "--absolute-git-dir"])).trim();
}

const apiPath = (repo: GitHubRepo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/** Only the fields given, as GitHub takes them. */
function clean(input: IssueInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title.trim();
  if (input.body !== undefined) out.body = input.body;
  if (input.labels !== undefined) out.labels = input.labels;
  if (input.milestone !== undefined) out.milestone = input.milestone;
  if (input.state !== undefined) out.state = input.state;
  return out;
}

/** A GitHub answer that isn't a success, as an IssuesError. */
async function check(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429)) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    throw new IssuesError("RATE_LIMITED", "GitHub has had enough requests from gh-writer for now.", resetAt);
  }
  if (res.status === 404) throw new IssuesError("NOT_FOUND", "GitHub doesn't have that (or doesn't let this sign-in see it).");
  if (res.status === 422) throw new IssuesError("BAD_REQUEST", `GitHub refused it: ${body.message ?? "invalid"}.`);
  if (res.status === 403) throw new IssuesError("NO_SIGN_IN", `GitHub refused: ${body.message ?? "not allowed"}. Reconnect GitHub with the permissions gh-writer asks for.`);
  throw new IssuesError("GITHUB", `GitHub answered ${res.status}${body.message ? `: ${body.message}` : ""}.`);
}

function asIssuesError(e: unknown): IssuesError {
  if (e instanceof IssuesError) return e;
  if (e instanceof GitHubError) return new IssuesError(e.code === "NO_SIGN_IN" ? "NO_SIGN_IN" : "GITHUB", e.message);
  if (unreachable(e)) return new IssuesError("OFFLINE", "GitHub can't be reached right now.");
  return new IssuesError("GITHUB", e instanceof Error ? e.message : String(e));
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: ({ name: string } | string)[];
  milestone: { number: number } | null;
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
}

interface GhComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  issue_url: string;
}

function fromIssue(j: GhIssue): Issue {
  return {
    number: j.number,
    title: j.title,
    body: j.body ?? "",
    state: j.state,
    labels: j.labels.map((l) => (typeof l === "string" ? l : l.name)),
    milestone: j.milestone?.number ?? null,
    author: j.user?.login ?? "",
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    closedAt: j.closed_at,
    url: j.html_url,
    commentCount: j.comments,
    comments: [],
  };
}

function fromComment(j: GhComment): IssueComment {
  return { id: j.id, body: j.body ?? "", author: j.user?.login ?? "", createdAt: j.created_at, updatedAt: j.updated_at, url: j.html_url };
}
