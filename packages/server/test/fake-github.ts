import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

export interface FakeUser {
  login: string;
  name?: string;
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
  /** The bare repository behind owner/name (with `gitRoot`). */
  repoPath(owner: string, name: string): string;
  close(): Promise<void>;
}

export async function fakeGitHub({ clientId = "Iv1.fakeclient", login = "ada", interval = 0, gitRoot }: { clientId?: string; login?: string; interval?: number; gitRoot?: string } = {}): Promise<FakeGitHub> {
  let approved = false;
  let denied = false;
  let slow = false;
  let expired = false;
  let deviceStarted = false;
  const fake: FakeGitHub = {
    url: "",
    clientId,
    userCode: "WDJB-MJHT",
    deviceToken: `gho_device_${Math.random().toString(36).slice(2)}`,
    users: new Map(),
    repos: [],
    requests: [],
    approve: () => void (approved = true),
    deny: () => void (denied = true),
    slowDown: () => void (slow = true),
    expire: () => void (expired = true),
    revoke: (token) => void fake.users.delete(token),
    repoPath: (owner, name) => join(gitRoot ?? "", owner, `${name}.git`),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

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

    switch (`${req.method} ${url.pathname}`) {
      case "POST /login/device/code":
        if (form.get("client_id") !== clientId) return json(res, 401, { error: "incorrect_client_credentials", error_description: "The client_id is not valid." });
        deviceStarted = true;
        approved = denied = expired = false;
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
        fake.users.set(fake.deviceToken, { login, name: "Ada Writer" });
        return json(res, 200, { access_token: fake.deviceToken, token_type: "bearer", scope: "repo,read:user" });
      case "GET /user":
        if (!user) return json(res, 401, { message: "Bad credentials" });
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
        if (gitRoot) execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", fake.repoPath(user.login, name)]);
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

  if (gitRoot) mkdirSync(gitRoot, { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
