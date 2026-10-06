import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Library, sessionCookie, type RunningServer } from "@gh-writer/server";
import { createApi, type Api, type CloneProgress } from "../src/index.ts";

const sample = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));
let tmp: string;
let server: RunningServer;
let api: Api;
let bare: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "gh-writer-clone-"));
  const config = join(tmp, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  const seed = join(tmp, "seed");
  cpSync(sample, seed, { recursive: true });
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git(seed, "init", "-q");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "Start");
  bare = join(tmp, "novel.git");
  git(tmp, "clone", "-q", "--bare", seed, bare);
  server = await createServer({ library: await Library.open({ configDir: join(tmp, "config"), cloneDir: join(tmp, "books") }), token: "t", sync: false });
  api = createApi({ baseUrl: server.url, headers: { cookie: `${sessionCookie(server.port)}=t`, origin: server.url } });
});

afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("clone", () => {
  it("reports progress and resolves with the new library entry", async () => {
    const progress: CloneProgress[] = [];
    const novel = await api.clone(`file://${bare}`, { onProgress: (p) => progress.push(p) });
    expect(novel).toMatchObject({ title: "The Bridge at Varn", path: join(tmp, "books", "novel") });
    expect(progress.length).toBeGreaterThan(0);
    expect((await api.library()).novels.map((n) => n.id)).toContain(novel.id);
  });

  it("rejects with git's code and the guidance", async () => {
    await expect(api.clone(`file://${join(tmp, "nowhere.git")}`)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Check the owner and name") });
    await expect(api.clone("not a repo")).rejects.toMatchObject({ code: "BAD_REPO" });
  });
});
