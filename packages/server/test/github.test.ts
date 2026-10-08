import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, GitHub, Library, memoryStore, sessionCookie, type TokenStore } from "../src/index.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { scratch } from "./fixtures.ts";
import { send } from "./http.ts";

let fake: FakeGitHub;
let cleanUp: () => void;
let fresh: (name: string) => string;

/** A connection to the fake GitHub; `clientId: null` for a build without one. */
const connect = ({ store = memoryStore(), gh = async () => undefined as string | undefined, clientId = fake.clientId as string | null } = {}) => ({
  store,
  github: new GitHub({ clientId: clientId ?? "", webUrl: fake.url, apiUrl: fake.url, store, gh }),
});

beforeAll(async () => {
  ({ cleanUp, fresh } = scratch("github"));
  fake = await fakeGitHub();
});

afterAll(async () => {
  await fake.close();
  cleanUp();
});

describe("GitHub", () => {
  it("signs in with the device flow, keeps the token in the store, and never hands it out", async () => {
    const { github, store } = connect();
    const results: unknown[] = [];
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true });

    const code = await github.startDevice();
    results.push(code);
    expect(code).toEqual({ userCode: fake.userCode, verificationUri: `${fake.url}/login/device`, expiresIn: 900, interval: 0 });
    expect(fake.requests.at(-1)?.body).toContain("scope=repo+read%3Auser");

    results.push(await github.pollDevice());
    expect(results.at(-1)).toEqual({ status: "pending", interval: 0 });
    fake.slowDown();
    results.push(await github.pollDevice());
    expect(results.at(-1)).toEqual({ status: "pending", interval: 5 });

    fake.approve();
    const done = await github.pollDevice();
    results.push(done);
    expect(done).toEqual({ status: "done", account: { signedIn: true, deviceFlow: true, account: { login: "ada", name: "Ada Writer", avatarUrl: `${fake.url}/avatars/ada.png` } } });
    expect(await store.get()).toBe(fake.deviceToken);
    results.push(await github.status());
    expect(results.at(-1)).toMatchObject({ signedIn: true, account: { login: "ada" } });
    expect(JSON.stringify(results)).not.toContain(fake.deviceToken);

    // The account is remembered: no request to GitHub for every status.
    const before = fake.requests.length;
    await github.status();
    expect(fake.requests.length).toBe(before);

    // Polling again after it's done: nothing is waiting.
    expect(await github.pollDevice()).toEqual({ status: "none" });

    await github.signOut();
    expect(await store.get()).toBeUndefined();
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true });
  });

  it("reports a code that was refused or ran out", async () => {
    const { github, store } = connect();
    await github.startDevice();
    fake.deny();
    expect(await github.pollDevice()).toEqual({ status: "denied" });
    await github.startDevice();
    fake.expire();
    expect(await github.pollDevice()).toEqual({ status: "expired" });
    expect(await store.get()).toBeUndefined();
  });

  it("can't sign in with a code without a client ID, but gh still works", async () => {
    const ghToken = "gho_from_gh_cli";
    fake.users.set(ghToken, { login: "ada-gh" });
    const { github, store } = connect({ clientId: null, gh: async () => ghToken });
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: false, gh: { login: "ada-gh" } });
    await expect(github.startDevice()).rejects.toMatchObject({ code: "NO_CLIENT_ID" });

    expect(await github.useGh()).toMatchObject({ signedIn: true, account: { login: "ada-gh" } });
    expect(await store.get()).toBe(ghToken);
  });

  it("says when gh isn't signed in", async () => {
    const { github } = connect();
    await expect(github.useGh()).rejects.toMatchObject({ code: "NO_GH" });
  });

  it("forgets a revoked token and says so once, not in a loop", async () => {
    const token = "gho_soon_revoked";
    fake.users.set(token, { login: "ada" });
    const store = memoryStore();
    await store.set(token);
    const { github } = connect({ store });
    expect(await github.status()).toMatchObject({ signedIn: true });

    fake.revoke(token);
    await expect(github.api("/user/repos")).rejects.toMatchObject({ code: "NO_SIGN_IN" });
    expect(await store.get()).toBeUndefined();
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true, expired: true });
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true });
  });

  it("finds a revoked token on the next status too", async () => {
    const token = "gho_revoked_before_start";
    const store = memoryStore();
    await store.set(token);
    const { github } = connect({ store });
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true, expired: true });
  });

  it("stays signed in while GitHub can't be reached", async () => {
    const store = memoryStore();
    await store.set("gho_offline");
    const github = new GitHub({ clientId: "x", store, gh: async () => undefined, fetch: () => Promise.reject(new TypeError("fetch failed")) });
    expect(await github.status()).toEqual({ signedIn: true, deviceFlow: true, offline: true });
  });

  it("explains a keychain it can't reach, without failing the status", async () => {
    const broken: TokenStore = { get: () => Promise.reject(new Error("no keychain here")), set: () => Promise.reject(new Error("no")), delete: () => Promise.reject(new Error("no")) };
    const { github } = connect({ store: broken });
    expect(await github.status()).toEqual({ signedIn: false, deviceFlow: true, keychain: "no keychain here" });
  });
});

describe("GitHub.repos", () => {
  it("lists the author's repositories, most recently pushed first", async () => {
    const token = "gho_lister";
    fake.users.set(token, { login: "lister" });
    fake.repos.push(
      { owner: "lister", name: "old-book", private: false, pushedAt: "2025-01-01T00:00:00Z" },
      { owner: "lister", name: "new-book", private: true, description: "Drafting", pushedAt: "2026-09-01T00:00:00Z" },
      { owner: "someone-else", name: "theirs", private: false, pushedAt: "2026-10-01T00:00:00Z" },
    );
    const store = memoryStore();
    await store.set(token);
    const { github } = connect({ store });
    expect(await github.repos()).toEqual([
      { fullName: "lister/new-book", private: true, description: "Drafting", pushedAt: "2026-09-01T00:00:00Z", cloneUrl: `${fake.url}/lister/new-book.git` },
      { fullName: "lister/old-book", private: false, pushedAt: "2025-01-01T00:00:00Z", cloneUrl: `${fake.url}/lister/old-book.git` },
    ]);
    await expect(connect().github.repos()).rejects.toMatchObject({ code: "NO_SIGN_IN" });
  });
});

describe("/api/github", () => {
  it("signs in and out over HTTP, and the token never appears in a response", async () => {
    const { github } = connect();
    const configDir = fresh("config");
    const library = await Library.open({ configDir, cloneDir: fresh("novels") });
    await library.create({ title: "Signed" });
    const server = await createServer({ library, token: "t", github });
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin };
    const call = (method: string, path: string) => send(server.port, `/api/github${path}`, { method, headers });
    const bodies: string[] = [];
    const json = async (method: string, path: string, status = 200) => {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}: ${res.body}`).toBe(status);
      bodies.push(res.body);
      return JSON.parse(res.body) as Record<string, unknown>;
    };
    try {
      expect(await json("GET", "/account")).toEqual({ signedIn: false, deviceFlow: true });
      expect(await json("POST", "/device")).toMatchObject({ userCode: fake.userCode });
      expect(await json("POST", "/device/poll")).toEqual({ status: "pending", interval: 0 });
      fake.approve();
      expect(await json("POST", "/device/poll")).toMatchObject({ status: "done", account: { signedIn: true, account: { login: "ada" } } });
      expect(await json("GET", "/account")).toMatchObject({ signedIn: true });
      expect(await json("POST", "/gh", 400)).toMatchObject({ code: "NO_GH" });
      expect(await json("DELETE", "/account")).toEqual({ signedIn: false, deviceFlow: true });
      for (const body of bodies) expect(body).not.toContain(fake.deviceToken);
      // Nor in a file: the config folder holds only the library.
      for (const file of readdirSync(configDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
        expect(readFileSync(join(file.parentPath, file.name), "utf8")).not.toContain(fake.deviceToken);
      }

      // Without the session, nothing.
      expect((await send(server.port, "/api/github/account", { headers: { origin } })).status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("says when GitHub can't be reached", async () => {
    const github = new GitHub({ clientId: "x", store: memoryStore(), gh: async () => undefined, fetch: () => Promise.reject(new TypeError("fetch failed")) });
    const library = await Library.open({ configDir: fresh("config") });
    const server = await createServer({ library, token: "t", github });
    try {
      const res = await send(server.port, "/api/github/device", { method: "POST", headers: { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}` } });
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body)).toMatchObject({ code: "NETWORK" });
    } finally {
      await server.close();
    }
  });
});
