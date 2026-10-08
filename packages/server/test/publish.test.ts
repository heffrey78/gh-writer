import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, GitHub, Library, memoryStore, sessionCookie, type RunningServer } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { gitIn, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

let fake: FakeGitHub;
let tmp: string;
let fresh: (name: string) => string;
let cleanUp: () => void;
const TOKEN = "gho_publisher";

beforeAll(async () => {
  ({ tmp, fresh, cleanUp } = scratch("publish"));
  fake = await fakeGitHub({ gitRoot: join(tmp, "github") });
  fake.users.set(TOKEN, { login: "ada" });
});

afterAll(async () => {
  await fake.close();
  cleanUp();
});

/** A server with a new local novel, signed in to the fake GitHub unless told otherwise. */
async function setUp({ signedIn = true } = {}) {
  const store = memoryStore();
  if (signedIn) await store.set(TOKEN);
  const github = new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined });
  const library = await Library.open({ configDir: fresh("config"), cloneDir: fresh("novels") });
  const novel = await library.create({ title: "Salt Road" });
  const server = await createServer({ library, token: "t", github, sync: { intervalMs: 0 } });
  const post = (body: unknown) =>
    send(server.port, `/api/novels/${novel.id}/publish`, {
      method: "POST",
      headers: { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { server, novel, library, post };
}

const bareLog = (name: string) => execFileSync("git", ["-C", fake.repoPath("ada", name), "log", "--format=%s", "main"], { encoding: "utf8" }).trim();

describe("POST /api/novels/:id/publish", () => {
  let server: RunningServer | undefined;
  afterAll(async () => server?.close());

  it("creates a private repository, pushes the novel, and syncs with it from then on", async () => {
    const s = await setUp();
    server = s.server;
    const res = await s.post({ name: "salt-road", description: "A novel" });
    expect(res.status, res.body).toBe(200);
    const remote = `${fake.url}/ada/salt-road.git`;
    expect(JSON.parse(res.body)).toMatchObject({ remote, status: { state: "synced", remote: "origin", branch: "main" } });
    expect(fake.repos.find((r) => r.name === "salt-road")).toMatchObject({ private: true, description: "A novel" });
    expect(bareLog("salt-road")).toBe("Start Salt Road");
    expect(s.library.get(s.novel.id)?.remote).toBe(remote);
    expect(gitIn(s.novel.path, "rev-parse", "--abbrev-ref", "main@{upstream}").trim()).toBe("origin/main");
    expect(gitIn(s.novel.path, "config", "--list", "--local")).not.toContain(TOKEN);

    // Publishing again to another name: it already has a home.
    const again = await s.post({ name: "elsewhere" });
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body)).toMatchObject({ code: "HAS_REMOTE" });
    await s.server.close();
    server = undefined;
  });

  it("can make it public, and refuses a name already taken", async () => {
    const s = await setUp();
    try {
      expect((await s.post({ name: "open-book", private: false })).status).toBe(200);
      expect(fake.repos.find((r) => r.name === "open-book")?.private).toBe(false);

      const other = await s.library.create({ title: "Second" });
      const res = await send(s.server.port, `/api/novels/${other.id}/publish`, {
        method: "POST",
        headers: { cookie: `${sessionCookie(s.server.port)}=t`, origin: `http://127.0.0.1:${s.server.port}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "open-book" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: "NAME_TAKEN", error: expect.stringContaining("open-book") });
      expect(gitIn(other.path, "remote").trim()).toBe("");
    } finally {
      await s.server.close();
    }
  });

  it("after a failed push, trying again pushes to the same repository instead of making another", async () => {
    const s = await setUp();
    try {
      fake.brokenNextRepo = true;
      const failed = await s.post({ name: "retry-me" });
      expect(failed.status).toBe(400);
      expect(JSON.parse(failed.body)).toMatchObject({ code: "PUSH_FAILED", error: expect.stringContaining("Try again") });

      // GitHub's side recovers; the author tries again.
      execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", fake.repoPath("ada", "retry-me")]);
      const ok = await s.post({ name: "retry-me" });
      expect(ok.status, ok.body).toBe(200);
      expect(fake.repos.filter((r) => r.name === "retry-me")).toHaveLength(1);
      expect(bareLog("retry-me")).toBe("Start Salt Road");
    } finally {
      await s.server.close();
    }
  });

  it("needs a sign-in and a usable name", async () => {
    const s = await setUp({ signedIn: false });
    try {
      expect(JSON.parse((await s.post({ name: "nope" })).body)).toMatchObject({ code: "NO_SIGN_IN" });
      expect(JSON.parse((await s.post({ name: "has spaces" })).body)).toMatchObject({ code: "BAD_NAME" });
      expect((await s.post({})).status).toBe(400);
    } finally {
      await s.server.close();
    }
  });
});
