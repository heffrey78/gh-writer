// The desktop app's smoke test (#193), run against an installed package on a machine without git:
// the packaged Node runs this, and the packaged server and git do the work, against a fake GitHub.
//
//   1. Sign in to GitHub; clone a novel; take the name and email the account offers.
//   2. Edit a scene; sync: committed by the app's git, pushed through the app's own askpass.
//   3. Quit (stdin closed): the server exits 0 and nothing of the app is left running.
//   With --gui, also start the app itself (a display is needed: xvfb-run) and quit it with SIGTERM.
//
// Usage: <packaged node> smoke-desktop.mjs --root /usr/lib/gh-writer --app /usr/bin/gh-writer --sample <sample novel> [--gui]
// CI bundles it (scripts/build-smoke.ts), since a clean machine has no node_modules.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { fakeGitHub } from "../packages/server/test/fake-github.ts";

const { values } = parseArgs({ options: { root: { type: "string" }, app: { type: "string" }, sample: { type: "string" }, gui: { type: "boolean" } } });
const root = values.root ?? "/usr/lib/gh-writer";
const app = values.app ?? "/usr/bin/gh-writer";
const sample = values.sample ?? new URL("../examples/sample-novel", import.meta.url).pathname;
const node = join(root, "runtime/node/node");
const bundledGit = join(root, "runtime/git");
const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const LINE = "Smoke test: written in the installed app.";

const step = (s: string) => console.log(`• ${s}`);
function fail(message: string): never {
  throw new Error(message);
}

// No git of the machine's own: the app must bring everything it needs.
const onPath = (process.env.PATH ?? "").split(delimiter).some((dir) => {
  try {
    execFileSync(join(dir, "git"), ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
if (onPath && !process.env.GH_WRITER_SMOKE_ALLOW_GIT) fail("git is installed on this machine: the smoke test proves the app needs none (GH_WRITER_SMOKE_ALLOW_GIT=1 to run anyway).");

const scratch = mkdtempSync(join(tmpdir(), "gh-writer-smoke-"));
const home = join(scratch, "home");
mkdirSync(home);
cpSync(sample, join(scratch, "seed"), { recursive: true });

// The fake GitHub (test infrastructure, standing in for github.com) serves git over HTTP with the
// app's own git, which this process alone puts on its PATH.
const gitEnv = { GIT_EXEC_PATH: join(bundledGit, "libexec/git-core"), GIT_TEMPLATE_DIR: join(bundledGit, "share/git-core/templates") };
Object.assign(process.env, gitEnv, { PATH: [join(bundledGit, "bin"), process.env.PATH].join(delimiter), HOME: scratch });
const git = (cwd: string, ...args: string[]) => execFileSync(join(bundledGit, "bin/git"), args, { cwd, encoding: "utf8" });
const fake = await fakeGitHub({ gitRoot: join(scratch, "github") });
git(join(scratch, "seed"), "init", "-q", "--initial-branch=main");
git(join(scratch, "seed"), "add", "-A");
git(join(scratch, "seed"), "-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "-qm", "Start");
git(scratch, "clone", "-q", "--bare", join(scratch, "seed"), fake.repoPath("ada", "varn"));

// The server as the app starts it, in an environment without the bundled git on PATH.
const serverEnv: Record<string, string> = {
  PATH: process.env.PATH!.split(delimiter).filter((d) => !d.startsWith(root)).join(delimiter),
  HOME: home,
  GH_WRITER_CONFIG_DIR: join(scratch, "config"),
  GH_WRITER_GIT: bundledGit,
  GH_WRITER_ASKPASS: app,
  GH_WRITER_APP_VERSION: "0.0.0-smoke",
  GH_WRITER_GITHUB_URL: fake.url,
  GH_WRITER_GITHUB_API_URL: fake.url,
  GH_WRITER_GITHUB_CLIENT_ID: fake.clientId,
  // No Secret Service on a bare test machine: the sign-in is kept in memory.
  GH_WRITER_TOKEN_STORE: "memory",
};

const leftovers = () => {
  try {
    return execFileSync("pgrep", ["-f", join(root, "server/gh-writer.mjs")], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const exited = (child: ChildProcess, ms: number) =>
  new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running after ${ms / 1000} s`)), ms);
    child.once("exit", (code) => (clearTimeout(timer), resolve(code)));
  });

try {
  step("Starting the packaged server");
  const server = spawn(node, [join(root, "server/gh-writer.mjs"), "serve", "--sidecar"], { env: serverEnv, stdio: ["pipe", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    server.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d).includes("\n") && resolve(out.slice(0, out.indexOf("\n"))));
    server.once("exit", (code) => reject(new Error(`the server exited (${code}) before it started`)));
  });
  const { url, token, error } = JSON.parse(line) as { url?: string; token?: string; error?: string };
  if (!url || !token) fail(`the server couldn't start: ${error}`);
  const headers = { cookie: `ghw_session_${new URL(url).port}=${token}`, origin: url, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) fail(`${method} ${path}: ${res.status} ${text}`);
    return text;
  };

  step("Signing in to GitHub");
  await call("POST", "/api/github/device");
  fake.approve();
  for (let i = 0; ; i++) {
    const { status } = JSON.parse(await call("POST", "/api/github/device/poll")) as { status: string };
    if (status === "done") break;
    if (i > 50) fail(`the sign-in didn't finish: ${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  step("Cloning the novel with the app's git");
  const stream = await call("POST", "/api/library/clone", { repo: `${fake.url}/ada/varn.git` });
  const done = /event: done\ndata: (.*)\n/.exec(stream)?.[1] ?? fail(`the clone didn't finish:\n${stream}`);
  const { novel } = JSON.parse(done) as { novel: { id: string; path: string } };

  step("Taking the name and email the GitHub account offers");
  const { identity, suggestion } = JSON.parse(await call("GET", "/api/identity")) as { identity: unknown; suggestion: { name: string; email: string } | null };
  if (identity || !suggestion) fail("expected no git identity yet, and one offered from the account");
  await call("PUT", "/api/identity", suggestion);

  step("Editing a scene and syncing");
  const file = JSON.parse(await call("GET", `/api/novels/${novel.id}/files/${SCENE}`)) as { content: string; hash: string };
  await call("PUT", `/api/novels/${novel.id}/files/${SCENE}`, { content: `${file.content.trimEnd()}\n\n${LINE}\n`, base: file.hash });
  const status = JSON.parse(await call("POST", `/api/novels/${novel.id}/sync`)) as { state: string; ahead: number; error?: { message: string } };
  if (status.state !== "synced" || status.ahead !== 0) fail(`the sync didn't finish: ${JSON.stringify(status)}`);
  const pushed = git(fake.repoPath("ada", "varn"), "log", "-1", "--format=%an <%ae>");
  if (pushed.trim() !== `${suggestion.name} <${suggestion.email}>`) fail(`GitHub's latest commit is by ${pushed.trim()}`);
  if (!git(fake.repoPath("ada", "varn"), "show", `HEAD:${SCENE}`).includes(LINE)) fail("GitHub doesn't have the edit");
  const hash = createHash("sha256").update(readFileSync(join(novel.path, SCENE))).digest("hex");
  if (hash === file.hash) fail("the scene on disk wasn't changed");

  step("Quitting: the server commits, stops and leaves nothing running");
  server.stdin!.end();
  const code = await exited(server, 20_000);
  if (code !== 0) fail(`the server exited with ${code}`);
  if (leftovers()) fail(`still running: ${leftovers()}`);

  if (values.gui) {
    step("Starting the app itself, then quitting it as the system does (SIGTERM)");
    // The display and session the app needs, from this process (xvfb-run and dbus-run-session in CI).
    const session = ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []));
    const appEnv = { ...serverEnv, ...Object.fromEntries(session) };
    const window = spawn(app, [], { env: appEnv, stdio: ["ignore", "inherit", "pipe"] });
    let said = "";
    window.stderr!.setEncoding("utf8").on("data", (d: string) => (said += d));
    for (let i = 0; !said.includes("server listening"); i++) {
      if (i > 300 || window.exitCode !== null) fail(`the app didn't start its server:\n${said}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!leftovers()) fail("the app says its server is listening, but it isn't running");
    window.kill("SIGTERM");
    const quit = await exited(window, 30_000);
    if (quit !== 0) fail(`the app exited with ${quit}:\n${said}`);
    if (leftovers()) fail(`still running after the app quit: ${leftovers()}`);
  }
  console.log("✔ The installed app works with nothing else installed.");
} finally {
  await fake.close();
}
