import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, GitHub, Library, memoryStore, sessionCookie, type RunningServer } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

/** Who git signs as (#186): GET and PUT /api/identity, from the GitHub account when there's one. */

const TOKEN = "test-token-0123456789";
const SIGNED_IN = "gho_signed_in";
let fake: FakeGitHub;
let tmp: string;
let fresh: (name: string) => string;
let cleanUp: () => void;
let globalConfig: string;

beforeAll(async () => {
  ({ tmp, fresh, cleanUp } = scratch("identity"));
  fake = await fakeGitHub();
  fake.users.set(SIGNED_IN, { login: "ada", id: 583231, name: "Ada Varn" });
});

afterAll(async () => {
  await fake.close();
  cleanUp();
});

// Each test starts on a computer where git doesn't know the writer.
beforeEach(() => {
  globalConfig = fresh("gitconfig");
  writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
});

async function serve({ signedIn, library }: { signedIn: boolean; library?: Library }) {
  const store = memoryStore();
  if (signedIn) await store.set(SIGNED_IN);
  const github = new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined });
  const server = await createServer({ library: library ?? (await Library.open({ configDir: fresh("config") })), token: TOKEN, github, commit: { quietMs: 20, maxMs: 1000 } });
  const headers = { cookie: `${sessionCookie(server.port)}=${TOKEN}`, origin: server.url, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await send(server.port, path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: JSON.parse(r.body) as Record<string, unknown> };
  };
  return { server, call };
}

async function closing<T>(server: RunningServer, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await server.close();
  }
}

describe("GET /api/identity", () => {
  it("has nothing to offer signed out, and the account's name and noreply address signed in", async () => {
    const out = await serve({ signedIn: false });
    await closing(out.server, async () => expect((await out.call("GET", "/api/identity")).json).toEqual({ identity: null, suggestion: null }));

    const host = new URL(fake.url).hostname;
    const signedIn = await serve({ signedIn: true });
    await closing(signedIn.server, async () =>
      expect((await signedIn.call("GET", "/api/identity")).json).toEqual({ identity: null, suggestion: { name: "Ada Varn", email: `583231+ada@users.noreply.${host}` } }),
    );
  });

  it("says who git signs as when it knows", async () => {
    writeFileSync(globalConfig, "[user]\n\tname = Ada Varn\n\temail = ada@example.com\n");
    const { server, call } = await serve({ signedIn: false });
    await closing(server, async () => expect((await call("GET", "/api/identity")).json).toMatchObject({ identity: { name: "Ada Varn", email: "ada@example.com" } }));
  });
});

describe("PUT /api/identity", () => {
  it("refuses a missing name or an address that isn't one", async () => {
    const { server, call } = await serve({ signedIn: false });
    await closing(server, async () => {
      expect(await call("PUT", "/api/identity", { name: "", email: "ada@example.com" })).toMatchObject({ status: 400, json: { code: "BAD_IDENTITY" } });
      expect(await call("PUT", "/api/identity", { name: "Ada", email: "ada" })).toMatchObject({ status: 400 });
      expect(readFileSync(globalConfig, "utf8")).not.toContain("[user]");
    });
  });

  it("saves the name and email in git's own configuration for this computer, and commits work that waited for them", async () => {
    // A novel with a saved change that couldn't be committed: git doesn't know the writer.
    writeFileSync(globalConfig, "[user]\n\tname = Seed\n\temail = seed@example.com\n");
    const novel = novelRepo(fresh("varn"));
    writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
    const library = await Library.open({ configDir: fresh("config") });
    const { id } = await library.add(novel);
    const { server, call } = await serve({ signedIn: true, library });
    await closing(server, async () => {
      const path = "manuscript/01-return/01-arrival/01-the-station.md";
      const before = readFileSync(join(novel, path));
      const put = await call("PUT", `/api/novels/${id}/files/${path}`, { content: `${before.toString("utf8")}\nOne more line.\n`, base: createHash("sha256").update(before).digest("hex") });
      expect(put.status).toBe(200);
      await expect.poll(async () => (await call("GET", `/api/novels/${id}/sync`)).json.commit).toMatchObject({ state: "blocked", blocked: { code: "IDENTITY" } });

      const { suggestion } = (await call("GET", "/api/identity")).json as { suggestion: { name: string; email: string } };
      expect(await call("PUT", "/api/identity", suggestion)).toMatchObject({ status: 200, json: { identity: suggestion } });
      expect(execFileSync("git", ["config", "--global", "user.email"], { encoding: "utf8" }).trim()).toBe(suggestion.email);
      expect(gitIn(novel, "log", "-1", "--format=%an <%ae>").trim()).toBe(`${suggestion.name} <${suggestion.email}>`);
      expect(gitIn(novel, "status", "--porcelain")).toBe("");
    });
  });
});
