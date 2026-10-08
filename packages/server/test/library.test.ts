import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyGitError, cloneUrl, createServer, expandHome, GitFailure, Library, LibraryError, sessionCookie, type LibraryEntry } from "../src/index.ts";
import { gitIn, novelRepo as novelRepoIn, sample, scratch } from "./fixtures.ts";
import { send, sseEvents } from "./http.ts";

let tmp: string;
let fresh: (name: string) => string;
let cleanUp: () => void;

const novelRepo = (dir = fresh("novel")) => novelRepoIn(dir);

/** A bare repository to clone from over file://. */
function bareRemote(source: string): string {
  const bare = fresh("remote") + ".git";
  execFileSync("git", ["clone", "-q", "--bare", source, bare]);
  return pathToFileURL(bare).href;
}

const openLibrary = (configDir = fresh("config")) => Library.open({ configDir, cloneDir: join(tmp, "clones") });

beforeAll(() => ({ tmp, fresh, cleanUp } = scratch("library")));

afterAll(() => cleanUp());

describe("Library.add", () => {
  it("adds a git repository holding novel.yaml, with its title and remote", async () => {
    const library = await openLibrary();
    const dir = novelRepo();
    gitIn(dir, "remote", "add", "origin", "https://writer:ghp_secret@github.com/writer/the-bridge.git");
    const novel = await library.add(dir);
    expect(novel).toMatchObject({ path: dir, title: "The Bridge at Varn", remote: "https://github.com/writer/the-bridge.git" });
    expect(novel.id).toMatch(/^lib_[0-9a-z]{6}$/);
    expect(await library.list()).toEqual([novel]);
    expect(readFileSync(library.file, "utf8")).not.toContain("ghp_secret");
  });

  it("refreshes the entry when a folder is added again", async () => {
    const library = await openLibrary();
    const dir = novelRepo();
    const first = await library.add(dir);
    const again = await library.add(join(dir, "."));
    expect(again.id).toBe(first.id);
    expect(await library.list()).toHaveLength(1);
  });

  it("rejects a folder that isn't a git repository", async () => {
    const library = await openLibrary();
    const dir = fresh("plain");
    cpSync(sample, dir, { recursive: true });
    await expect(library.add(dir)).rejects.toMatchObject({ code: "NOT_A_REPO" });
  });

  it("rejects a git repository without novel.yaml", async () => {
    const library = await openLibrary();
    const dir = novelRepo();
    rmSync(join(dir, "novel.yaml"));
    await expect(library.add(dir)).rejects.toMatchObject({ code: "NOT_A_NOVEL" });
  });

  it("rejects a path that isn't a folder", async () => {
    const library = await openLibrary();
    await expect(library.add(join(tmp, "nowhere"))).rejects.toMatchObject({ code: "NOT_A_DIRECTORY" });
    await expect(library.add(join(novelRepo(), "novel.yaml"))).rejects.toBeInstanceOf(LibraryError);
  });
});

describe("persistence", () => {
  it("survives a restart", async () => {
    const configDir = fresh("config");
    const novel = await (await openLibrary(configDir)).add(novelRepo());
    const reopened = await openLibrary(configDir);
    expect(await reopened.list()).toEqual([novel]);
    expect(reopened.notices).toEqual([]);
  });

  it("drops a novel whose folder has gone, with a notice", async () => {
    const configDir = fresh("config");
    const library = await openLibrary(configDir);
    const kept = await library.add(novelRepo());
    const gone = await library.add(novelRepo());
    rmSync(gone.path, { recursive: true });

    const reopened = await openLibrary(configDir);
    expect((await reopened.list()).map((e) => e.id)).toEqual([kept.id]);
    expect(reopened.notices).toEqual([{ code: "MISSING", path: gone.path, message: expect.stringContaining("The Bridge at Varn") }]);
    expect(JSON.parse(readFileSync(reopened.file, "utf8")).novels).toHaveLength(1);
  });

  it("notices a folder that goes while the server runs", async () => {
    const library = await openLibrary();
    const novel = await library.add(novelRepo());
    rmSync(novel.path, { recursive: true });
    expect(await library.list()).toEqual([]);
    expect(library.notices.map((x) => x.code)).toEqual(["MISSING"]);
  });

  it("starts empty, keeping the old file, when library.json is unreadable", async () => {
    const configDir = fresh("config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "library.json"), "{ not json");
    const library = await openLibrary(configDir);
    expect(await library.list()).toEqual([]);
    expect(library.notices[0]?.code).toBe("UNREADABLE");
    expect(existsSync(library.notices[0]!.path)).toBe(true);
  });

  it("refreshes the title and author when a novel is opened", async () => {
    const library = await openLibrary();
    const novel = await library.add(novelRepo());
    expect(novel.author).toBe("gh-writer sample");
    const yaml = join(novel.path, "novel.yaml");
    writeFileSync(yaml, readFileSync(yaml, "utf8").replace(/^title: .*$/m, "title: Varn").replace(/^author: .*$/m, "") + "author: Ada Writer\n");
    await library.touch(novel.id);
    expect(library.get(novel.id)).toMatchObject({ title: "Varn", author: "Ada Writer" });
  });

  it("orders novels by when they were last opened", async () => {
    const library = await openLibrary();
    const a = await library.add(novelRepo());
    const b = await library.add(novelRepo());
    await new Promise((r) => setTimeout(r, 5));
    await library.touch(a.id);
    expect((await library.list()).map((e) => e.id)).toEqual([a.id, b.id]);
    await expect(library.touch("lib_zzzzzz")).rejects.toMatchObject({ code: "UNKNOWN_NOVEL" });
  });
});

describe("Library.clone", () => {
  it("clones over file:// with progress and adds the novel", async () => {
    const library = await openLibrary();
    const url = bareRemote(novelRepo());
    const stages = new Set<string>();
    const novel = await library.clone(url, { onProgress: (e) => stages.add(e.stage) });
    expect(novel.path).toBe(join(tmp, "clones", url.split("/").pop()!.replace(/\.git$/, "")));
    expect(novel).toMatchObject({ title: "The Bridge at Varn", remote: url });
    expect(existsSync(join(novel.path, "manuscript"))).toBe(true);
    expect(stages.size).toBeGreaterThan(0);
  });

  it("refuses a destination that has files in it", async () => {
    const library = await openLibrary();
    const into = novelRepo();
    await expect(library.clone(bareRemote(novelRepo()), { into })).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
    expect(existsSync(join(into, "novel.yaml"))).toBe(true);
  });

  it("removes a clone that isn't a novel", async () => {
    const library = await openLibrary();
    const notNovel = novelRepo();
    gitIn(notNovel, "rm", "-q", "novel.yaml");
    gitIn(notNovel, "commit", "-qm", "No novel");
    const into = fresh("clone");
    await expect(library.clone(bareRemote(notNovel), { into })).rejects.toMatchObject({ code: "NOT_A_NOVEL" });
    expect(existsSync(into)).toBe(false);
    expect(await library.list()).toEqual([]);
  });

  it("reports a missing repository as NOT_FOUND and leaves nothing behind", async () => {
    const library = await openLibrary();
    const into = fresh("clone");
    await expect(library.clone(pathToFileURL(join(tmp, "no-such.git")).href, { into })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(existsSync(into)).toBe(false);
  });

  it("reports an unreachable server as NETWORK", async () => {
    const library = await openLibrary();
    await expect(library.clone("http://127.0.0.1:1/novel.git", { into: fresh("clone") })).rejects.toMatchObject({ code: "NETWORK" });
  });

  describe("a remote that needs credentials", () => {
    let remote: Server;
    let url: string;

    beforeAll(async () => {
      remote = createHttpServer((_req, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end());
      await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/writer/the-bridge.git`;
    });

    afterAll(() => new Promise<void>((r) => remote.close(() => r())));

    it("fails fast as AUTH with what to do, without prompting", async () => {
      process.env.GIT_ASKPASS = "false";
      try {
        const library = await openLibrary();
        const error = await library.clone(url, { into: fresh("clone") }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GitFailure);
        expect(error).toMatchObject({ code: "AUTH", message: expect.stringContaining("gh auth setup-git") });
        expect((error as GitFailure).message).toContain("SSH key");
      } finally {
        delete process.env.GIT_ASKPASS;
      }
    });

    it("fails as AUTH with no askpass program either", async () => {
      const library = await openLibrary();
      await expect(library.clone(url, { into: fresh("clone") })).rejects.toMatchObject({ code: "AUTH" });
    });
  });
});

describe("expandHome", () => {
  it("reads a leading ~ as the home folder, as a shell does, and leaves other paths alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/gh-writer/varn")).toBe(join(homedir(), "gh-writer/varn"));
    expect(expandHome("  ~/novels ")).toBe(join(homedir(), "novels"));
    expect(expandHome("/srv/novels/~draft")).toBe("/srv/novels/~draft");
    expect(expandHome("relative/~/x")).toBe("relative/~/x");
  });
});

describe("cloneUrl", () => {
  it("expands owner/name to GitHub over https", () => {
    expect(cloneUrl("writer/the-bridge")).toBe("https://github.com/writer/the-bridge.git");
    expect(cloneUrl(" writer/the-bridge.git ")).toBe("https://github.com/writer/the-bridge.git");
  });

  it("passes URLs and scp-style addresses through", () => {
    for (const url of ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@github.com/a/b", "file:///srv/b.git"]) {
      expect(cloneUrl(url)).toBe(url);
    }
  });

  it("rejects options and anything else", () => {
    for (const bad of ["--upload-pack=touch /tmp/x", "-c", "just words", "ext::sh -c touch% /tmp/x", "a/b/c", ""]) {
      expect(() => cloneUrl(bad), bad).toThrow(expect.objectContaining({ code: "BAD_REPO" }));
    }
  });
});

describe("classifyGitError", () => {
  it.each([
    ["fatal: Authentication failed for 'https://github.com/a/b.git/'", "AUTH"],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "AUTH"],
    ["fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403", "AUTH"],
    ["ERROR: Repository not found.\nfatal: Could not read from remote repository.", "NOT_FOUND"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found", "NOT_FOUND"],
    ["fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", "NETWORK"],
    ["spawn git ENOENT", "GIT_MISSING"],
    ["fatal: something unexpected", "GIT"],
  ])("%s → %s", (message, code) => {
    expect(classifyGitError(new Error(message)).code).toBe(code);
  });
});

describe("/api/library", () => {
  it("adds, lists, clones with streamed progress, and forgets novels", async () => {
    const library = await openLibrary();
    const server = await createServer({ library, token: "t" });
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin, "content-type": "application/json" };
    const api = (method: string, path: string, body?: unknown) =>
      send(server.port, `/api/library${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    try {
      const added = await api("POST", "", { path: novelRepo() });
      expect(added.status).toBe(201);
      const novel = (JSON.parse(added.body) as { novel: LibraryEntry }).novel;

      const rejected = await api("POST", "", { path: tmp });
      expect(rejected.status).toBe(400);
      expect(JSON.parse(rejected.body)).toMatchObject({ code: "NOT_A_REPO" });
      expect((await api("POST", "", { nope: 1 })).status).toBe(400);

      const cloned = await api("POST", "/clone", { repo: bareRemote(novelRepo()), path: fresh("clone") });
      expect(cloned.headers["content-type"]).toContain("text/event-stream");
      const events = sseEvents(cloned.body);
      expect(events.some((e) => e.event === "progress")).toBe(true);
      expect(events.at(-1)).toMatchObject({ event: "done", data: { novel: { title: "The Bridge at Varn" } } });

      const failed = sseEvents((await api("POST", "/clone", { repo: "not a repo" })).body);
      expect(failed).toEqual([{ event: "error", data: { code: "BAD_REPO", error: expect.stringContaining("owner/name") } }]);

      const listed = JSON.parse((await api("GET", "")).body) as { novels: LibraryEntry[]; notices: unknown[] };
      expect(listed.novels).toHaveLength(2);
      expect(listed.notices).toEqual([]);

      expect((await api("DELETE", `/${novel.id}`)).status).toBe(204);
      expect((await api("DELETE", `/${novel.id}`)).status).toBe(404);
      expect(existsSync(novel.path)).toBe(true);
    } finally {
      await server.close();
    }
  }, 20_000);
});
