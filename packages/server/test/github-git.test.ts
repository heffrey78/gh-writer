import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
