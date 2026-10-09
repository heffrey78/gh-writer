import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, DEFAULT_TEMPLATE, Library, sessionCookie, type LibraryEntry } from "../src/index.ts";
import { gitIn, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

let tmp: string;
let fresh: (name: string) => string;
let cleanUp: () => void;

const openLibrary = () => Library.open({ configDir: fresh("config"), cloneDir: join(tmp, "novels") });

/** Every file under `dir` but .git, relative to it. */
const filesIn = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .filter((f) => !f.startsWith(".git/"))
    .sort();

/** Run `fn` with git knowing nobody: an empty global config and no GIT_AUTHOR_* / GIT_COMMITTER_*. */
async function withoutIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  const empty = fresh("empty-gitconfig");
  writeFileSync(empty, "[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = empty;
  try {
    return await fn();
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
  }
}

beforeAll(() => ({ tmp, fresh, cleanUp } = scratch("new-novel")));

afterAll(() => cleanUp());

describe("Library.create", () => {
  it("starts a valid novel from the template, with fresh IDs, the title and one commit", async () => {
    const library = await openLibrary();
    const novel = await library.create({ title: "The Salt Road", author: "Jeff Wikstrom" });
    expect(novel).toMatchObject({ title: "The Salt Road", author: "Jeff Wikstrom", path: join(tmp, "novels", "the-salt-road") });
    expect(await library.list()).toEqual([novel]);

    const result = await validate(nodeSource(novel.path));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const yaml = readFileSync(join(novel.path, "novel.yaml"), "utf8");
    expect(yaml).toMatch(/^title: The Salt Road$/m);
    expect(yaml).toMatch(/^author: "Jeff Wikstrom"$/m);
    expect(yaml).toMatch(/^id: nv_[0-9a-z]{6}$/m);
    expect(readFileSync(join(novel.path, "README.md"), "utf8")).toMatch(/^# The Salt Road\n/);
    expect(readFileSync(join(novel.path, "diagrams/README.md"), "utf8")).toMatch(/^# Diagrams of The Salt Road\n/);

    // Every template file is there, the scripts and workflows byte for byte, and no template ID is left.
    expect(filesIn(novel.path)).toEqual(filesIn(DEFAULT_TEMPLATE));
    for (const file of filesIn(DEFAULT_TEMPLATE).filter((f) => f.startsWith(".github/") || f === ".gitattributes")) {
      // Buffer.equals: toEqual compares a large file (the compiler, its fonts) byte by byte, slowly.
      expect(readFileSync(join(novel.path, file)).equals(readFileSync(join(DEFAULT_TEMPLATE, file))), file).toBe(true);
    }
    for (const file of filesIn(novel.path).filter((f) => !f.startsWith(".github/"))) {
      expect(readFileSync(join(novel.path, file), "utf8"), file).not.toMatch(/_temp1a\b/);
    }

    expect(gitIn(novel.path, "branch", "--show-current").trim()).toBe("main");
    expect(gitIn(novel.path, "log", "--format=%s").trim()).toBe("Start The Salt Road");
    expect(gitIn(novel.path, "status", "--porcelain")).toBe("");
  });

  it("gives every novel its own IDs", async () => {
    const library = await openLibrary();
    const a = await library.create({ title: "One" });
    const b = await library.create({ title: "Two" });
    const id = (n: LibraryEntry) => /^id: (\S+)$/m.exec(readFileSync(join(n.path, "novel.yaml"), "utf8"))![1];
    expect(id(a)).not.toBe(id(b));
  });

  it("goes into the folder the author chose if it's empty", async () => {
    const library = await openLibrary();
    const into = fresh("chosen");
    mkdirSync(into);
    const novel = await library.create({ title: "Chosen", into });
    expect(novel.path).toBe(into);
  });

  it("refuses a folder that has files in it, and leaves it alone", async () => {
    const library = await openLibrary();
    const into = fresh("full");
    mkdirSync(into);
    writeFileSync(join(into, "notes.txt"), "mine");
    await expect(library.create({ title: "Full", into })).rejects.toMatchObject({ code: "NOT_EMPTY", message: expect.stringContaining(into) });
    expect(readdirSync(into)).toEqual(["notes.txt"]);
  });

  it("asks who the author is when git doesn't know, leaving nothing behind", async () => {
    const library = await openLibrary();
    const into = fresh("nobody");
    await withoutIdentity(async () => {
      await expect(library.create({ title: "Nobody", into })).rejects.toMatchObject({ code: "NEEDS_IDENTITY" });
      expect(existsSync(into)).toBe(false);
      expect(await library.list()).toEqual([]);

      // Given a name and email, it sets them for this novel only.
      const novel = await library.create({ title: "Somebody", into, identity: { name: "Ada Writer", email: "ada@example.com" } });
      expect(gitIn(novel.path, "log", "--format=%an <%ae>").trim()).toBe("Ada Writer <ada@example.com>");
      expect(gitIn(novel.path, "config", "--local", "user.name").trim()).toBe("Ada Writer");
      expect(readFileSync(process.env.GIT_CONFIG_GLOBAL!, "utf8")).not.toContain("Ada");
    });
  });
});

describe("POST /api/library/new", () => {
  it("creates a novel, and says what's wrong otherwise", async () => {
    const library = await openLibrary();
    const server = await createServer({ library, token: "t" });
    const origin = `http://127.0.0.1:${server.port}`;
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin, "content-type": "application/json" };
    const post = (body: unknown) => send(server.port, "/api/library/new", { method: "POST", headers, body: JSON.stringify(body) });
    try {
      const created = await post({ title: " Night Ferry ", author: "", path: fresh("ferry") });
      expect(created.status).toBe(201);
      expect(JSON.parse(created.body)).toMatchObject({ novel: { title: "Night Ferry" } });

      const again = await post({ title: "Night Ferry", path: (JSON.parse(created.body) as { novel: LibraryEntry }).novel.path });
      expect(again.status).toBe(400);
      expect(JSON.parse(again.body)).toMatchObject({ code: "NOT_EMPTY" });

      for (const bad of [{}, { title: " " }, { title: "x", author: 3 }, { title: "x", identity: { name: "A" } }]) {
        expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
      }

      const listed = JSON.parse((await send(server.port, "/api/library", { headers })).body) as { folder: string };
      expect(listed.folder).toBe(join(tmp, "novels"));
    } finally {
      await server.close();
    }
  }, 20_000);
});
