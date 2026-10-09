import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export interface FakeUser {
  login: string;
  name?: string;
  /** The token's OAuth scopes; by default all a novel needs. */
  scopes?: string[];
}

export interface FakeComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  milestone: number | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** A pull request: GitHub lists them with the issues. */
  pullRequest?: boolean;
  comments: FakeComment[];
}

/** A repository's issues side: what the issues API serves. */
export interface FakeIssues {
  issues: FakeIssue[];
  labels: { name: string; color: string; description: string }[];
  milestones: { number: number; title: string; state: "open" | "closed" }[];
}

export interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  pushedAt: string;
}

/**
 * A stand-in for github.com and api.github.com: the OAuth device flow, GET /user, the user's
 * repositories, and with `gitRoot` git over HTTP for them (git http-backend, with basic auth as
 * x-access-token and a token GitHub knows, as github.com takes it). The test drives the sign-in (approve, deny, slow down, revoke) through its methods,
 * or over HTTP at /__fake/* from another process.
 */
export interface FakeGitHub {
  url: string;
  clientId: string;
  /** The code the author would type on github.com. */
  userCode: string;
  /** The token the device flow hands out once approved. */
  deviceToken: string;
  users: Map<string, FakeUser>;
  repos: FakeRepo[];
  /** Every request, as "METHOD /path" with the Authorization header's token when there was one. */
  requests: { method: string; path: string; token?: string; body?: string }[];
  approve(): void;
  deny(): void;
  /** The next poll answers slow_down. */
  slowDown(): void;
  /** The code runs out. */
  expire(): void;
  /** GitHub stops accepting the token. */
  revoke(token: string): void;
  /** Set to make the next created repository refuse pushes (its git side missing), once. */
  brokenNextRepo: boolean;
  /** The bare repository behind owner/name (with `gitRoot`). */
  repoPath(owner: string, name: string): string;
  /** owner/name's issues, labels and milestones (made empty on first use). */
  issues(owner: string, name: string): FakeIssues;
  /** Add an issue as if made on github.com; times come from the fake's clock. */
  addIssue(owner: string, name: string, issue: Partial<FakeIssue> & { title: string }): FakeIssue;
  /** Change an issue or add a comment as if on github.com, moving its updatedAt on. */
  touch(issue: FakeIssue, change?: Partial<FakeIssue>): void;
  comment(issue: FakeIssue, body: string, user?: string): FakeComment;
  /** The API refuses every repository request as rate limited until this time (epoch seconds), when set. */
  rateLimitedUntil: number | undefined;
  /** The fake's clock: each change happens one second after the last. */
  now(): string;
  close(): Promise<void>;
}

export async function fakeGitHub({ clientId = "Iv1.fakeclient", login = "ada", interval = 0, gitRoot }: { clientId?: string; login?: string; interval?: number; gitRoot?: string } = {}): Promise<FakeGitHub> {
  let approved = false;
  let denied = false;
  let slow = false;
  let expired = false;
  let deviceStarted = false;
  let requestedScopes: string[] = [];
  const fake: FakeGitHub = {
    url: "",
    clientId,
    userCode: "WDJB-MJHT",
    deviceToken: `gho_device_${Math.random().toString(36).slice(2)}`,
    users: new Map(),
    repos: [],
    requests: [],
    brokenNextRepo: false,
    rateLimitedUntil: undefined,
    issues: (owner, name) => {
      const key = `${owner}/${name}`;
      let data = issueData.get(key);
      if (!data) issueData.set(key, (data = { issues: [], labels: [], milestones: [] }));
      return data;
    },
    addIssue: (owner, name, partial) => {
      const data = fake.issues(owner, name);
      const at = fake.now();
      const issue: FakeIssue = { number: data.issues.length + 1, body: "", state: "open", labels: [], milestone: null, user: owner, createdAt: at, updatedAt: at, closedAt: null, comments: [], ...partial };
      for (const l of issue.labels) if (!data.labels.some((x) => x.name === l)) data.labels.push({ name: l, color: "ededed", description: "" });
      data.issues.push(issue);
      return issue;
    },
    touch: (issue, change = {}) => {
      Object.assign(issue, change);
      issue.updatedAt = fake.now();
      if (change.state) issue.closedAt = change.state === "closed" ? issue.updatedAt : null;
    },
    comment: (issue, body, user = "ada") => {
      const at = fake.now();
      const c: FakeComment = { id: ++commentIds, body, user, createdAt: at, updatedAt: at };
      issue.comments.push(c);
      issue.updatedAt = at;
      return c;
    },
    now: () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    approve: () => void (approved = true),
    deny: () => void (denied = true),
    slowDown: () => void (slow = true),
    expire: () => void (expired = true),
    revoke: (token) => void fake.users.delete(token),
    repoPath: (owner, name) => join(gitRoot ?? "", owner, `${name}.git`),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const issueData = new Map<string, FakeIssues>();
  let clock = 0;
  let commentIds = 1000;
  const scopesOf = (user: FakeUser) => user.scopes ?? ["repo", "workflow", "read:user"];
  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => resolve(body));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const git = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (git && gitRoot) return serveGit(req, res, url, git[1]!, git[2]!);
    const auth = /^(?:Bearer|token) (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const body = await read(req);
    fake.requests.push({ method: req.method ?? "GET", path: url.pathname, ...(auth ? { token: auth } : {}), ...(body ? { body } : {}) });
    const form = new URLSearchParams(body);
    const user = auth ? fake.users.get(auth) : undefined;
    const repoApi = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (repoApi) return serveIssues(req, res, url, body, user, repoApi[1]!, repoApi[2]!, repoApi[3]!);

    switch (`${req.method} ${url.pathname}`) {
      case "POST /login/device/code":
        if (form.get("client_id") !== clientId) return json(res, 401, { error: "incorrect_client_credentials", error_description: "The client_id is not valid." });
        deviceStarted = true;
        approved = denied = expired = false;
        requestedScopes = (form.get("scope") ?? "").split(/[\s,]+/).filter(Boolean);
        return json(res, 200, { device_code: "device-123", user_code: fake.userCode, verification_uri: `${fake.url}/login/device`, expires_in: 900, interval });
      case "POST /login/oauth/access_token":
        if (form.get("client_id") !== clientId || form.get("device_code") !== "device-123" || !deviceStarted) return json(res, 200, { error: "incorrect_device_code" });
        if (slow) {
          slow = false;
          return json(res, 200, { error: "slow_down", interval: interval + 5 });
        }
        if (denied) return json(res, 200, { error: "access_denied" });
        if (expired) return json(res, 200, { error: "expired_token" });
        if (!approved) return json(res, 200, { error: "authorization_pending" });
        deviceStarted = false;
        fake.users.set(fake.deviceToken, { login, name: "Ada Writer", scopes: requestedScopes });
        return json(res, 200, { access_token: fake.deviceToken, token_type: "bearer", scope: requestedScopes.join(",") });
      case "GET /user":
        if (!user) return json(res, 401, { message: "Bad credentials" });
        res.setHeader("X-OAuth-Scopes", scopesOf(user).join(", "));
        return json(res, 200, { login: user.login, name: user.name ?? null, avatar_url: `${fake.url}/avatars/${user.login}.png` });
      case "GET /user/repos": {
        if (!user) return json(res, 401, { message: "Bad credentials" });
        const mine = fake.repos.filter((r) => r.owner === user.login).sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
        return json(
          res,
          200,
          mine.map((r) => ({ name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, description: r.description ?? null, pushed_at: r.pushedAt, clone_url: `${fake.url}/${r.owner}/${r.name}.git`, owner: { login: r.owner } })),
        );
      }
      case "POST /user/repos": {
        if (!user) return json(res, 401, { message: "Bad credentials" });
        const { name, description, private: priv } = JSON.parse(body || "{}") as { name?: string; description?: string; private?: boolean };
        if (!name) return json(res, 422, { message: "Validation Failed" });
        if (fake.repos.some((r) => r.owner === user.login && r.name === name)) {
          return json(res, 422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
        }
        const repo: FakeRepo = { owner: user.login, name, private: priv ?? false, ...(description ? { description } : {}), pushedAt: new Date().toISOString() };
        fake.repos.push(repo);
        // GitHub's stock labels, as on a real new repository.
        fake.issues(user.login, name).labels.push(...["accessibility", "bug", "documentation", "duplicate", "enhancement", "good first issue", "help wanted", "invalid", "question", "wontfix"].map((n) => ({ name: n, color: "d4c5f9", description: "" })));
        if (gitRoot && !fake.brokenNextRepo) execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", fake.repoPath(user.login, name)]);
        fake.brokenNextRepo = false;
        return json(res, 201, { name, full_name: `${user.login}/${name}`, private: repo.private, html_url: `${fake.url}/${user.login}/${name}`, clone_url: `${fake.url}/${user.login}/${name}.git`, owner: { login: user.login } });
      }
      case "POST /__fake/approve":
        fake.approve();
        return json(res, 200, {});
      case "POST /__fake/deny":
        fake.deny();
        return json(res, 200, {});
      case "POST /__fake/revoke":
        fake.revoke(form.get("token") ?? fake.deviceToken);
        return json(res, 200, {});
      default:
        return json(res, 404, { message: "Not Found" });
    }
  });
  /**
   * The issues API for a repository the user owns: issues (pull requests among them, as GitHub lists
   * them), comments, labels and milestones, with `since`, paging and ETags (a matching If-None-Match
   * gets 304), and a rate limit the test can switch on.
   */
  function serveIssues(req: IncomingMessage, res: ServerResponse, url: URL, body: string, user: FakeUser | undefined, owner: string, name: string, rest: string) {
    if (!user) return json(res, 401, { message: "Bad credentials" });
    if (fake.rateLimitedUntil !== undefined && Date.now() / 1000 < fake.rateLimitedUntil) {
      res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(fake.rateLimitedUntil) });
      return res.end(JSON.stringify({ message: "API rate limit exceeded" }));
    }
    if (user.login !== owner || !fake.repos.some((r) => r.owner === owner && r.name === name)) return json(res, 404, { message: "Not Found" });
    const data = fake.issues(owner, name);
    const api = `${fake.url}/repos/${owner}/${name}`;
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
    const labelOf = (n: string) => data.labels.find((l) => l.name === n) ?? { name: n, color: "ededed", description: "" };
    const ensureLabels = (names: string[]) => names.forEach((n) => data.labels.some((l) => l.name === n) || data.labels.push(labelOf(n)));
    const issueJson = (i: FakeIssue) => ({
      number: i.number,
      title: i.title,
      body: i.body || null,
      state: i.state,
      labels: i.labels.map(labelOf),
      milestone: i.milestone === null ? null : (data.milestones.find((m) => m.number === i.milestone) ?? null),
      user: { login: i.user },
      comments: i.comments.length,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      closed_at: i.closedAt,
      html_url: `${fake.url}/${owner}/${name}/${i.pullRequest ? "pull" : "issues"}/${i.number}`,
      ...(i.pullRequest ? { pull_request: { url: `${api}/pulls/${i.number}` } } : {}),
    });
    const commentJson = (i: FakeIssue, c: FakeComment) => ({
      id: c.id,
      body: c.body,
      user: { login: c.user },
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      html_url: `${fake.url}/${owner}/${name}/issues/${i.number}#issuecomment-${c.id}`,
      issue_url: `${api}/issues/${i.number}`,
    });
    /** A list, paged like GitHub's, with an ETag. */
    const list = (items: unknown[]) => {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const text = JSON.stringify(items.slice((page - 1) * per, page * per));
      const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) return res.writeHead(304, { etag }).end();
      return res.writeHead(200, { "content-type": "application/json", etag }).end(text);
    };
    const since = url.searchParams.get("since");
    const find = (n: string) => data.issues.find((i) => i.number === Number(n));
    let m: RegExpExecArray | null;

    if (rest === "/issues" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const items = data.issues
        .filter((i) => (state === "all" || i.state === state) && (!since || i.updatedAt >= since))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return list(items.map(issueJson));
    }
    if (rest === "/issues" && req.method === "POST") {
      if (typeof input.title !== "string" || !input.title) return json(res, 422, { message: "Validation Failed" });
      const labels = Array.isArray(input.labels) ? (input.labels as string[]) : [];
      ensureLabels(labels);
      const issue = fake.addIssue(owner, name, { title: input.title, body: typeof input.body === "string" ? input.body : "", labels, milestone: typeof input.milestone === "number" ? input.milestone : null, user: user.login });
      return json(res, 201, issueJson(issue));
    }
    if (rest === "/issues/comments" && req.method === "GET") {
      const all = data.issues.flatMap((i) => i.comments.map((c) => ({ i, c }))).filter(({ c }) => !since || c.updatedAt >= since);
      return list(all.sort((a, b) => a.c.updatedAt.localeCompare(b.c.updatedAt)).map(({ i, c }) => commentJson(i, c)));
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const issue = find(m[1]!);
      if (!issue) return json(res, 404, { message: "Not Found" });
      if (req.method === "GET") return json(res, 200, issueJson(issue));
      if (req.method === "PATCH") {
        const change: Partial<FakeIssue> = {};
        if (typeof input.title === "string") change.title = input.title;
        if (typeof input.body === "string") change.body = input.body;
        if (input.state === "open" || input.state === "closed") change.state = input.state;
        if (Array.isArray(input.labels)) {
          ensureLabels(input.labels as string[]);
          change.labels = input.labels as string[];
        }
        if ("milestone" in input) change.milestone = typeof input.milestone === "number" ? input.milestone : null;
        fake.touch(issue, change);
        return json(res, 200, issueJson(issue));
      }
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const issue = find(m[1]!);
      if (!issue) return json(res, 404, { message: "Not Found" });
      if (req.method === "GET") return list(issue.comments.map((c) => commentJson(issue, c)));
      if (req.method === "POST") {
        if (typeof input.body !== "string" || !input.body) return json(res, 422, { message: "Validation Failed" });
        return json(res, 201, commentJson(issue, fake.comment(issue, input.body, user.login)));
      }
    }
    if (rest === "/labels" && req.method === "GET") return list(data.labels);
    if (rest === "/labels" && req.method === "POST") {
      if (typeof input.name !== "string" || data.labels.some((l) => l.name === input.name)) return json(res, 422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
      const label = { name: input.name, color: typeof input.color === "string" ? input.color : "ededed", description: typeof input.description === "string" ? input.description : "" };
      data.labels.push(label);
      return json(res, 201, label);
    }
    if ((m = /^\/labels\/(.+)$/.exec(rest)) && req.method === "DELETE") {
      const name = decodeURIComponent(m[1]!);
      const at = data.labels.findIndex((l) => l.name === name);
      if (at < 0) return json(res, 404, { message: "Not Found" });
      data.labels.splice(at, 1);
      for (const i of data.issues) i.labels = i.labels.filter((l) => l !== name);
      return res.writeHead(204).end();
    }
    if (rest === "/milestones" && req.method === "POST") {
      if (typeof input.title !== "string" || !input.title || data.milestones.some((x) => x.title === input.title)) return json(res, 422, { message: "Validation Failed" });
      const milestone = { number: data.milestones.length + 1, title: input.title, state: "open" as const };
      data.milestones.push(milestone);
      return json(res, 201, milestone);
    }
    if ((m = /^\/milestones\/(\d+)$/.exec(rest)) && req.method === "PATCH") {
      const milestone = data.milestones.find((x) => x.number === Number(m![1]));
      if (!milestone) return json(res, 404, { message: "Not Found" });
      if (typeof input.title === "string") milestone.title = input.title;
      if (input.state === "open" || input.state === "closed") milestone.state = input.state;
      return json(res, 200, milestone);
    }
    if (rest === "/milestones" && req.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      return list(data.milestones.filter((x) => state === "all" || x.state === state));
    }
    return json(res, 404, { message: "Not Found" });
  }

  /**
   * git's smart HTTP protocol through git http-backend. Like github.com: no credentials → 401 with a
   * Basic challenge; credentials GitHub doesn't know → 401; a repository that isn't there → 404.
   */
  function serveGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string) {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const [user, token] = basic ? Buffer.from(basic, "base64").toString().split(":") : [];
    fake.requests.push({ method: req.method ?? "GET", path: url.pathname, ...(token ? { token } : {}) });
    if (user !== "x-access-token" || !token || !fake.users.has(token)) {
      req.resume();
      return res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end("Invalid username or token.");
    }
    if (!existsSync(fake.repoPath(owner, name))) {
      req.resume();
      return res.writeHead(404).end("Repository not found.");
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: gitRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: fake.users.get(token)!.login,
        // GitHub's rule, enforced by the pre-receive hook: no adding or changing workflows without the workflow scope.
        FAKE_SCOPES: scopesOf(fake.users.get(token)!).join(" "),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: join(gitRoot!, ".hooks"),
        REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("close", () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf("\r\n\r\n");
      const headerEnd = split >= 0 ? split : out.indexOf("\n\n");
      const gap = split >= 0 ? 4 : 2;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, headerEnd).toString().split(/\r?\n/)) {
        const [key, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        if (key?.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else if (key) headers[key] = value;
      }
      res.writeHead(status, headers).end(out.subarray(headerEnd + gap));
    });
  }

  if (gitRoot) {
    mkdirSync(join(gitRoot, ".hooks"), { recursive: true });
    const hook = join(gitRoot, ".hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh
case " $FAKE_SCOPES " in *" workflow "*) exit 0 ;; esac
zero=0000000000000000000000000000000000000000
while read old new ref; do
  [ "$new" = "$zero" ] && continue
  if [ "$old" = "$zero" ]; then files=$(git ls-tree -r --name-only "$new"); else files=$(git diff --name-only "$old" "$new"); fi
  file=$(printf '%s\\n' "$files" | grep '^\\.github/workflows/' | head -n 1)
  if [ -n "$file" ]; then
    echo "refusing to allow an OAuth App to create or update workflow \\\`$file\\\` without \\\`workflow\\\` scope" >&2
    exit 1
  fi
done
exit 0
`,
    );
    chmodSync(hook, 0o755);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
