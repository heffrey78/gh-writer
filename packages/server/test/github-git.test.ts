import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { git, gitInstall, gitPlumbing } from "../src/git.ts";
import { GitHub, Library, memoryStore, Syncer } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";

let fake: FakeGitHub;
let tmp: string;
let fresh: (name: string) => string;
let cleanUp: () => void;
let globalConfig: string;
const TOKEN = "gho_signed_in_token";

/** The connection, signed in with TOKEN unless told otherwise. */
async function connection(signedIn = true) {
  const store = memoryStore();
  if (signedIn) await store.set(TOKEN);
  return new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined });
}

const openLibrary = () => Library.open({ configDir: fresh("config"), cloneDir: fresh("clones") });

/** Every file under `dir`, for looking for the token. */
const everyFile = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

beforeAll(async () => {
  ({ tmp, fresh, cleanUp } = scratch("github-git"));
  globalConfig = process.env.GIT_CONFIG_GLOBAL!;
  fake = await fakeGitHub({ gitRoot: join(tmp, "github") });
  fake.users.set(TOKEN, { login: "ada" });
  // ada/varn: the sample novel.
  const bare = fake.repoPath("ada", "varn");
  execFileSync("git", ["clone", "--quiet", "--bare", novelRepo(fresh("seed")), bare]);
});

afterAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  await fake.close();
  cleanUp();
});

describe("git with gh-writer's GitHub connection", () => {
  it("clones from GitHub over HTTPS when signed in, and only then", async () => {
    const url = `${fake.url}/ada/varn.git`;
    const signedOut = await connection(false);
    await expect((await openLibrary()).clone(url, { auth: (u) => signedOut.gitAuth(u) })).rejects.toMatchObject({ code: "AUTH" });

    const github = await connection();
    const library = await openLibrary();
    const novel = await library.clone(url, { auth: (u) => github.gitAuth(u) });
    expect(novel).toMatchObject({ title: "The Bridge at Varn", remote: url });
    // Nothing of the token is kept: not in the repository, not in the library.
    for (const file of [...everyFile(join(novel.path, ".git")), library.file]) expect(readFileSync(file).includes(TOKEN), file).toBe(false);
    expect(readFileSync(globalConfig, "utf8")).not.toContain(TOKEN);
  });

  it("syncs with the connection, and says so when GitHub stops accepting it", async () => {
    const github = await connection();
    const novel = await (await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) });
    let refused = 0;
    const syncer = new Syncer(novel.path, { intervalMs: 0 }, { auth: (u) => github.gitAuth(u), onAuthRefused: () => void (refused++, github.recheck()) });
    try {
      writeFileSync(join(novel.path, "dictionary.txt"), "Varn\nOssery\n");
      gitIn(novel.path, "add", "-A");
      gitIn(novel.path, "commit", "-qm", "Words");
      expect(await syncer.sync()).toMatchObject({ state: "synced", ahead: 0 });
      expect(execFileSync("git", ["-C", fake.repoPath("ada", "varn"), "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("Words");

      fake.revoke(TOKEN);
      gitIn(novel.path, "commit", "-q", "--allow-empty", "-m", "More");
      const status = await syncer.sync();
      expect(status).toMatchObject({ state: "needs-sign-in", error: { code: "AUTH", message: expect.stringContaining("Connect to GitHub again") } });
      expect(JSON.stringify(status)).not.toContain(TOKEN);
      expect(refused).toBe(1);
      await expect.poll(() => github.status()).toMatchObject({ signedIn: false, expired: true });
    } finally {
      await syncer.close();
      fake.users.set(TOKEN, { login: "ada" });
    }
  });

  it("wins over a stale credential the author's git has stored for GitHub", async () => {
    const stale = fresh("gitconfig-stale");
    writeFileSync(stale, `${readFileSync(globalConfig, "utf8")}[credential]\n\thelper = "!f() { echo username=ada; echo password=stale; }; f"\n`);
    process.env.GIT_CONFIG_GLOBAL = stale;
    try {
      const github = await connection();
      await expect((await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) })).resolves.toMatchObject({ title: "The Bridge at Varn" });
    } finally {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
    }
  });

  it("leaves the author's own credentials alone when not signed in", async () => {
    const own = fresh("gitconfig-own");
    writeFileSync(own, `${readFileSync(globalConfig, "utf8")}[credential]\n\thelper = "!f() { echo username=x-access-token; echo password=${TOKEN}; }; f"\n`);
    process.env.GIT_CONFIG_GLOBAL = own;
    try {
      const github = await connection(false);
      await expect((await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) })).resolves.toMatchObject({ title: "The Bridge at Varn" });
    } finally {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
    }
  });

  describe("with an askpass program in place of a shell helper (the desktop app, D9)", () => {
    /** A stand-in for the app's executable: answers git's prompts as it does, and notes each one. */
    function askpass() {
      const dir = fresh("askpass");
      mkdirSync(dir);
      const log = join(dir, "prompts.log");
      const program = join(dir, "askpass");
      writeFileSync(
        program,
        `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\ncase "$1" in Username*) echo x-access-token;; Password*) printf '%s\\n' "$GH_WRITER_GIT_TOKEN";; *) exit 1;; esac\n`,
      );
      chmodSync(program, 0o755);
      return { program, prompts: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
    }

    afterEach(() => {
      delete process.env.GH_WRITER_ASKPASS;
      delete process.env.GH_WRITER_GIT;
    });

    it("clones and syncs through it, with the stale helpers cleared, and fails as AUTH once the token is refused", async () => {
      const { program, prompts } = askpass();
      process.env.GH_WRITER_ASKPASS = program;
      const stale = fresh("gitconfig-stale-askpass");
      writeFileSync(stale, `${readFileSync(globalConfig, "utf8")}[credential]\n\thelper = "!f() { echo username=ada; echo password=stale; }; f"\n`);
      process.env.GIT_CONFIG_GLOBAL = stale;
      try {
        const github = await connection();
        const novel = await (await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) });
        expect(prompts()).toEqual([`Username for '${fake.url}': `, `Password for 'http://x-access-token@${fake.url.slice("http://".length)}': `]);
        for (const file of everyFile(join(novel.path, ".git"))) expect(readFileSync(file).includes(TOKEN), file).toBe(false);

        const syncer = new Syncer(novel.path, { intervalMs: 0 }, { auth: (u) => github.gitAuth(u) });
        try {
          gitIn(novel.path, "commit", "-q", "--allow-empty", "-m", "Through askpass");
          expect(await syncer.sync()).toMatchObject({ state: "synced", ahead: 0 });
          expect(execFileSync("git", ["-C", fake.repoPath("ada", "varn"), "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("Through askpass");
          fake.revoke(TOKEN);
          gitIn(novel.path, "commit", "-q", "--allow-empty", "-m", "Refused");
          expect(await syncer.sync()).toMatchObject({ state: "needs-sign-in", error: { code: "AUTH" } });
        } finally {
          await syncer.close();
          fake.users.set(TOKEN, { login: "ada" });
        }
      } finally {
        process.env.GIT_CONFIG_GLOBAL = globalConfig;
      }
    });

    it("runs every git command with the git in GH_WRITER_GIT, telling it where its parts are", async () => {
      // A portable git's layout, whose git notes how it was run and hands over to the system's.
      const root = fresh("portable-git");
      const log = join(root, "calls.log");
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(
        join(root, "bin/git"),
        `#!/bin/sh\nprintf '%s %s %s\\n' "$GIT_EXEC_PATH" "$GIT_TEMPLATE_DIR" "$1" >> '${log}'\nunset GIT_EXEC_PATH GIT_TEMPLATE_DIR GIT_SSL_CAINFO\nexec git "$@"\n`,
      );
      chmodSync(join(root, "bin/git"), 0o755);
      process.env.GH_WRITER_GIT = root;

      expect(gitInstall()).toMatchObject({ binary: join(root, "bin/git"), bundled: true });
      const github = await connection();
      const novel = await (await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) });
      await gitPlumbing(novel.path, ["rev-parse", "HEAD"]);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) expect(call).toMatch(new RegExp(`^${join(root, "libexec/git-core")} ${join(root, "share/git-core/templates")} `));
      expect(calls.at(-1)).toMatch(/ rev-parse$/);
    });

    const runtime = join(fileURLToPath(new URL("../../../", import.meta.url)), `dist/runtime/${process.platform}-${process.arch}/git`);
    it.skipIf(!existsSync(runtime))("clones and syncs with the portable git itself (npm run fetch:runtime)", async () => {
      const { program, prompts } = askpass();
      process.env.GH_WRITER_ASKPASS = program;
      process.env.GH_WRITER_GIT = runtime;
      // The portable git's version, not the system's.
      const { major, minor, patch } = await git().version();
      expect(`git version ${major}.${minor}.${patch}`).toBe(execFileSync(join(runtime, "bin/git"), ["version"], { encoding: "utf8" }).trim());

      const github = await connection();
      const novel = await (await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) });
      const syncer = new Syncer(novel.path, { intervalMs: 0 }, { auth: (u) => github.gitAuth(u) });
      try {
        gitIn(novel.path, "commit", "-q", "--allow-empty", "-m", "With the portable git");
        expect(await syncer.sync()).toMatchObject({ state: "synced", ahead: 0 });
      } finally {
        await syncer.close();
      }
      expect(prompts().length).toBeGreaterThanOrEqual(2);
    });

    const app = join(fileURLToPath(new URL("../../../", import.meta.url)), "packages/desktop/src-tauri/target/debug/gh-writer");
    it.skipIf(!existsSync(runtime) || !existsSync(app))("clones and syncs with the portable git asking the desktop app's own executable (npm run desktop)", async () => {
      process.env.GH_WRITER_ASKPASS = app;
      process.env.GH_WRITER_GIT = runtime;
      const github = await connection();
      const novel = await (await openLibrary()).clone(`${fake.url}/ada/varn.git`, { auth: (u) => github.gitAuth(u) });
      const syncer = new Syncer(novel.path, { intervalMs: 0 }, { auth: (u) => github.gitAuth(u) });
      try {
        gitIn(novel.path, "commit", "-q", "--allow-empty", "-m", "Answered by the app");
        expect(await syncer.sync()).toMatchObject({ state: "synced", ahead: 0 });
        expect(execFileSync("git", ["-C", fake.repoPath("ada", "varn"), "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("Answered by the app");
      } finally {
        await syncer.close();
      }
    });
  });

  it("gives the token only to http(s) remotes on GitHub", async () => {
    const github = await connection();
    expect(await github.gitAuth(`${fake.url}/ada/varn.git`)).toEqual({ origin: fake.url, token: TOKEN });
    expect(await github.gitAuth("https://gitlab.com/ada/varn.git")).toBeUndefined();
    expect(await github.gitAuth("git@github.com:ada/varn.git")).toBeUndefined();
    expect(await github.gitAuth("/some/path.git")).toBeUndefined();
    const real = new GitHub({ store: memoryStore(), gh: async () => undefined });
    expect(await real.gitAuth("https://github.com/ada/varn.git")).toBeUndefined();
  });
});
