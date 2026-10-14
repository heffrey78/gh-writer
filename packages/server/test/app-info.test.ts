import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, GitHub, Library, memoryStore, newer, sessionCookie, UpdateCheck } from "../src/index.ts";
import { send } from "./http.ts";

/** A fetch that answers GitHub's latest release with `answer`, counting the requests. */
function releases(answer: () => Response) {
  const asked: string[] = [];
  const f = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return answer();
  }) as typeof fetch;
  return { fetch: f, asked };
}

const release = (tag: string, extra: Record<string, unknown> = {}) =>
  Response.json({ tag_name: tag, html_url: `https://github.com/heffrey78/gh-writer/releases/tag/${tag}`, body: "What's new.", draft: false, prerelease: false, ...extra });

describe("newer", () => {
  it("compares versions as numbers, with or without a v, and never a pre-release", () => {
    expect(newer("0.2.0", "0.1.0")).toBe(true);
    expect(newer("v0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
    expect(newer("0.1.0", "0.2.0")).toBe(false);
    expect(newer("0.3.0-beta.1", "0.2.0")).toBe(false);
    expect(newer("soon", "0.1.0")).toBe(false);
  });
});

describe("UpdateCheck", () => {
  it("offers a newer release, with its page and notes, and nothing for the same or an older one", async () => {
    const { fetch } = releases(() => release("v0.2.0"));
    const check = new UpdateCheck("https://api.example", { fetch });
    expect(await check.newerThan("0.1.0")).toEqual({ version: "0.2.0", url: "https://github.com/heffrey78/gh-writer/releases/tag/v0.2.0", notes: "What's new." });
    expect(await check.newerThan("0.2.0")).toBeNull();
    expect(await check.newerThan("0.3.0")).toBeNull();
  });

  it("asks GitHub at most once a day, and after a failure again an hour later", async () => {
    let now = 0;
    let fail = true;
    const { fetch, asked } = releases(() => (fail ? new Response("", { status: 502 }) : release("v0.2.0")));
    const check = new UpdateCheck("https://api.example/", { fetch, now: () => now });

    expect(await check.newerThan("0.1.0")).toBeNull();
    now += 30 * 60 * 1000;
    fail = false;
    expect(await check.newerThan("0.1.0")).toBeNull();
    expect(asked).toEqual(["https://api.example/repos/heffrey78/gh-writer/releases/latest"]);

    now += 31 * 60 * 1000;
    expect(await check.newerThan("0.1.0")).toMatchObject({ version: "0.2.0" });
    now += 23 * 60 * 60 * 1000;
    await check.newerThan("0.1.0");
    expect(asked).toHaveLength(2);
    now += 2 * 60 * 60 * 1000;
    await check.newerThan("0.1.0");
    expect(asked).toHaveLength(3);
  });

  it("offers nothing when there's no release yet, or it's a draft or pre-release, or GitHub can't be reached", async () => {
    for (const answer of [() => new Response("", { status: 404 }), () => release("v9.0.0", { draft: true }), () => release("v9.0.0", { prerelease: true }), () => release("nightly")]) {
      expect(await new UpdateCheck("https://api.example", { fetch: releases(answer).fetch }).newerThan("0.1.0")).toBeNull();
    }
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await new UpdateCheck("https://api.example", { fetch: offline }).newerThan("0.1.0")).toBeNull();
  });
});

describe("GET /api/app and /api/app/licenses", () => {
  const TOKEN = "test-token-0123456789";
  let tmp: string;
  let library: Library;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "gh-writer-app-"));
    library = await Library.open({ configDir: tmp });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.GH_WRITER_APP_VERSION;
    delete process.env.GH_WRITER_LICENSES;
  });

  async function ask(path: string) {
    // Nothing listens on port 9: the update check fails quietly, as offline.
    const github = new GitHub({ apiUrl: "http://127.0.0.1:9", store: memoryStore(), gh: async () => undefined });
    const server = await createServer({ library, token: TOKEN, github });
    try {
      const r = await send(server.port, path, { headers: { cookie: `${sessionCookie(server.port)}=${TOKEN}` } });
      return JSON.parse(r.body) as Record<string, unknown>;
    } finally {
      await server.close();
    }
  }

  it("from a terminal: no app version, no update, the Node and git it runs on, and no licences", async () => {
    expect(await ask("/api/app")).toEqual({ desktop: false, version: null, node: process.versions.node, git: { version: expect.stringMatching(/^\d+\.\d+\.\d+$/), bundled: false }, update: null });
    expect(await ask("/api/app/licenses")).toEqual({ licenses: [] });
  });

  it("in the desktop app: its version, and the licence texts it ships, by name", async () => {
    process.env.GH_WRITER_APP_VERSION = "0.1.0";
    const dir = join(tmp, "licenses");
    mkdirSync(dir);
    writeFileSync(join(dir, "git-COPYING.txt"), "GNU GENERAL PUBLIC LICENSE");
    writeFileSync(join(dir, "gh-writer-LICENSE.md"), "MIT License");
    writeFileSync(join(dir, "README"), "not a licence");
    process.env.GH_WRITER_LICENSES = dir;
    expect(await ask("/api/app")).toMatchObject({ desktop: true, version: "0.1.0", update: null });
    expect(await ask("/api/app/licenses")).toEqual({
      licenses: [
        { name: "gh-writer-LICENSE.md", text: "MIT License" },
        { name: "git-COPYING.txt", text: "GNU GENERAL PUBLIC LICENSE" },
      ],
    });
  });
});
