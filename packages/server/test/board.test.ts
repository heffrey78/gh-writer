import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { countWords } from "@gh-writer/core";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, GitHub, Library, memoryStore, sessionCookie } from "../src/index.ts";
import type { BoardStatus } from "../src/board.ts";
import { NovelWorkspace } from "../src/workspace.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import type { FakeProject } from "./fake-projects.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const TOKEN = "gho_board";
const BRIDGE = "manuscript/01-return/01-arrival/02-the-bridge.md";
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
let fake: FakeGitHub;
let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
let dir: string;
let name: string;
let github: GitHub;
let offline = false;
const open: NovelWorkspace[] = [];

beforeAll(async () => {
  ({ tmp, fresh, cleanUp } = scratch("board"));
  fake = await fakeGitHub({ gitRoot: join(tmp, "github") });
  fake.users.set(TOKEN, { login: "ada" });
});
afterAll(async () => {
  await fake.close();
  cleanUp();
});

beforeEach(async () => {
  dir = novelRepo(fresh("novel"));
  name = `varn-${Math.random().toString(36).slice(2, 8)}`;
  gitIn(dir, "remote", "add", "origin", `${fake.url}/ada/${name}.git`);
  fake.repos.push({ owner: "ada", name, private: true, pushedAt: fake.now() });
  const store = memoryStore();
  await store.set(TOKEN);
  offline = false;
  const f: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError("fetch failed");
    return fetch(input, init);
  };
  github = new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined, fetch: f });
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((ws) => ws.close()));
});

const workspace = (root = dir) => {
  const ws = new NovelWorkspace(root, { commit: false, sync: false, github });
  open.push(ws);
  return ws;
};
/** The novel's project on the fake GitHub. */
const project = (): FakeProject => fake.projects.all.find((p) => p.repositories.includes(`ada/${name}`))!;
const item = (scene: string) => fake.projects.find(project(), "Scene ID", scene)!;
const value = (scene: string, field: string) => fake.projects.value(project(), item(scene), field);
const statusIn = (path: string) => /^status: (\w+)$/m.exec(readFileSync(join(dir, path), "utf8"))?.[1];
const setStatusIn = (path: string, status: string) => writeFileSync(join(dir, path), readFileSync(join(dir, path), "utf8").replace(/^status: \w+$/m, `status: ${status}`));
const ok = (status: BoardStatus) => {
  expect(status.error).toBeUndefined();
  return status;
};

describe("setting up the board", () => {
  it("makes a project linked to the repository, marked as the novel's, with a card per scene and its fields", async () => {
    const board = workspace().board!;
    expect(await board.isSetUp()).toBe(false);
    const status = ok(await board.setUp());
    const p = project();
    expect(status.project).toEqual({ number: p.number, title: "The Bridge at Varn: drafting board", url: `${fake.url}/users/ada/projects/${p.number}` });
    expect(p.readme).toContain("<!-- gh-writer-board: nv_4k8h2c -->");
    expect(p.items).toHaveLength(8);
    expect(status.last).toMatchObject({ added: 8, removed: 0, fromBoard: [], putBack: [] });

    // The project's own Status field has the scene statuses for options, GitHub's stock ones gone.
    expect(p.fields.find((f) => f.name === "Status")!.options!.map((o) => o.name)).toEqual(["Idea", "Outlined", "Drafted", "Revised", "Final"]);
    expect(p.items[0]!.content.title).toBe("The Station");
    expect(value("sc_5tat1n", "Status")).toBe("Drafted");
    expect(value("sc_5tat1n", "POV")).toBe("Ada Varn");
    expect(value("sc_5tat1n", "Part")).toBe("1. Return");
    expect(value("sc_5tat1n", "Chapter")).toBe("1. Arrival");
    expect(value("sc_5tat1n", "Order")).toBe(1);
    expect(value("sc_5tat1n", "Words")).toBe(stationWords());
  });

  it("keeps the status in a field of its own when GitHub won't change the project's Status field", async () => {
    fake.projects.lockStatus = true;
    try {
      const ws = workspace();
      ok(await ws.board!.setUp());
      expect(project().fields.find((f) => f.name === "Status")!.options!.map((o) => o.name)).toEqual(["Todo", "In Progress", "Done"]);
      expect(value("sc_br1dg3", "Scene status")).toBe("Drafted");
      fake.projects.set(project(), item("sc_br1dg3"), "Scene status", "Final");
      ok(await ws.board!.sync());
      expect(statusIn(BRIDGE)).toBe("final");
    } finally {
      fake.projects.lockStatus = false;
    }
  });

  it("adopts the novel's project when another clone made it, rather than making another", async () => {
    ok(await workspace().board!.setUp());
    const other = fresh("clone");
    gitIn(dir, "clone", "-q", dir, other);
    gitIn(other, "remote", "set-url", "origin", `${fake.url}/ada/${name}.git`);
    const board = workspace(other).board!;
    const status = ok(await board.sync());
    expect(status.project?.number).toBe(project().number);
    expect(fake.projects.all.filter((p) => p.repositories.includes(`ada/${name}`))).toHaveLength(1);
    expect(status.last).toMatchObject({ added: 0, removed: 0 });
  });

  it("says when the novel isn't on GitHub, or the sign-in can't use Projects", async () => {
    gitIn(dir, "remote", "remove", "origin");
    await expect(workspace().board!.setUp()).rejects.toMatchObject({ code: "NOT_ON_GITHUB" });

    gitIn(dir, "remote", "add", "origin", `${fake.url}/ada/${name}.git`);
    fake.users.set("gho_board_narrow", { login: "ada", scopes: ["repo", "workflow", "read:user"] });
    const store = memoryStore();
    await store.set("gho_board_narrow");
    github = new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined });
    const board = workspace().board!;
    await expect(board.setUp()).rejects.toMatchObject({ code: "NEEDS_SCOPE" });
    expect((await board.status()).error?.code).toBe("NEEDS_SCOPE");
  });

  it("waits, and says why, before a board is set up or while another version is open", async () => {
    const ws = workspace();
    expect((await ws.board!.sync()).error?.code).toBe("NOT_SET_UP");
    ok(await ws.board!.setUp());
    await ws.versions.start("Darker ending");
    expect((await ws.board!.sync()).error?.code).toBe("NOT_MAIN");
  });
});

/** The Station's words, as the app counts them. */
const stationWords = () => countWords(readFileSync(join(dir, STATION), "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""));

describe("syncing", () => {
  it("takes a card moved on the board into the scene's file, keeping the rest of it byte for byte", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    const before = readFileSync(join(dir, BRIDGE), "utf8");
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Revised");
    const status = ok(await ws.board!.sync());
    expect(statusIn(BRIDGE)).toBe("revised");
    expect(readFileSync(join(dir, BRIDGE), "utf8")).toBe(before.replace(/^status: \w+$/m, "status: revised"));
    expect(status.last?.fromBoard).toEqual([{ scene: "sc_br1dg3", title: "Walking the Span", status: "revised" }]);
    // And the next sync has nothing to do.
    expect(ok(await ws.board!.sync()).last).toEqual({ added: 0, removed: 0, updated: 0, fromBoard: [], putBack: [] });
  });

  it("tells open editors of the change, as of one made outside the app", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    const events: string[] = [];
    await ws.subscribe((e) => events.push(`${e.type} ${e.path}`));
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Final");
    ok(await ws.board!.sync());
    await expect.poll(() => events).toContain(`change ${BRIDGE}`);
  });

  it("takes a status changed in the file to the board, and keeps words, POV and order in step", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    setStatusIn(STATION, "final");
    writeFileSync(join(dir, STATION), `${readFileSync(join(dir, STATION), "utf8")}\nFour more words here.\n`);
    const words = value("sc_5tat1n", "Words") as number;
    const status = ok(await ws.board!.sync());
    expect(value("sc_5tat1n", "Status")).toBe("Final");
    expect(value("sc_5tat1n", "Words")).toBe(words + 4);
    expect(value("sc_5tat1n", "Words")).toBe(stationWords());
    expect(status.last).toMatchObject({ updated: 1, fromBoard: [], putBack: [] });
  });

  it("puts back board edits to the fields the files own, and says so", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    fake.projects.set(project(), item("sc_5tat1n"), "Words", 12);
    fake.projects.set(project(), item("sc_5tat1n"), "POV", "Ben Varn");
    const status = ok(await ws.board!.sync());
    expect(value("sc_5tat1n", "POV")).toBe("Ada Varn");
    expect(value("sc_5tat1n", "Words")).not.toBe(12);
    expect(status.last?.putBack).toEqual([{ scene: "sc_5tat1n", title: "The Station", fields: ["POV", "Words"] }]);
  });

  it("keeps a status changed on both sides as a conflict, writes neither, and settles it the author's way", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    const before = readFileSync(join(dir, BRIDGE), "utf8");
    setStatusIn(BRIDGE, "final");
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Outlined");
    let status = ok(await ws.board!.sync());
    expect(status.conflicts).toEqual([{ scene: "sc_br1dg3", title: "Walking the Span", file: "final", board: "outlined" }]);
    expect(statusIn(BRIDGE)).toBe("final");
    expect(value("sc_br1dg3", "Status")).toBe("Outlined");
    // Still a conflict at the next sync: nothing has settled it.
    status = ok(await ws.board!.sync());
    expect(status.conflicts).toHaveLength(1);
    expect(statusIn(BRIDGE)).toBe("final");

    status = ok(await ws.board!.resolve("sc_br1dg3", "board"));
    expect(status.conflicts).toEqual([]);
    expect(statusIn(BRIDGE)).toBe("outlined");
    expect(readFileSync(join(dir, BRIDGE), "utf8")).toBe(before.replace(/^status: \w+$/m, "status: outlined"));

    setStatusIn(BRIDGE, "revised");
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Idea");
    expect(ok(await ws.board!.sync()).conflicts).toHaveLength(1);
    status = ok(await ws.board!.resolve("sc_br1dg3", "file"));
    expect(status.conflicts).toEqual([]);
    expect(value("sc_br1dg3", "Status")).toBe("Revised");
    expect(statusIn(BRIDGE)).toBe("revised");
  });

  it("treats every difference as a conflict on a fresh clone, which knows no last-synced status", async () => {
    ok(await workspace().board!.setUp());
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Final");
    const other = fresh("clone");
    gitIn(dir, "clone", "-q", dir, other);
    gitIn(other, "remote", "set-url", "origin", `${fake.url}/ada/${name}.git`);
    const board = workspace(other).board!;
    expect(ok(await board.sync()).conflicts).toEqual([{ scene: "sc_br1dg3", title: "Walking the Span", file: "drafted", board: "final" }]);
    expect(ok(await board.sync()).conflicts).toHaveLength(1);
  });

  it("adds a card for a new scene, removes the card of a deleted one, and leaves cards it didn't make alone", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    const p = project();
    p.items.push({ id: "PVTI_mine", type: "DRAFT_ISSUE", content: { id: "DI_mine", title: "Buy a map of Varn", body: "" }, values: {}, isArchived: false, updatedAt: fake.now() });
    const chapter = "manuscript/01-return/01-arrival";
    writeFileSync(join(dir, chapter, "03-the-ferry.md"), "---\nid: sc_f3rry0\ntitle: The Ferry\nstatus: outlined\n---\nThe ferry was late.\n");
    writeFileSync(join(dir, chapter, "_chapter.yaml"), readFileSync(join(dir, chapter, "_chapter.yaml"), "utf8").replace(/scenes: \[(.*)\]/, "scenes: [$1, sc_f3rry0]"));
    gitIn(dir, "rm", "-q", BRIDGE);
    writeFileSync(join(dir, chapter, "_chapter.yaml"), readFileSync(join(dir, chapter, "_chapter.yaml"), "utf8").replace(", sc_br1dg3", ""));
    const status = ok(await ws.board!.sync());
    expect(status.last).toMatchObject({ added: 1, removed: 1 });
    expect(value("sc_f3rry0", "Status")).toBe("Outlined");
    expect(value("sc_f3rry0", "Order")).toBe(2);
    expect(fake.projects.find(p, "Scene ID", "sc_br1dg3")).toBeUndefined();
    expect(p.items.some((i) => i.id === "PVTI_mine")).toBe(true);
  });

  it("loses nothing when the project is deleted on GitHub, says so, and makes a new one when asked", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    const head = gitIn(dir, "rev-parse", "HEAD");
    const status = gitIn(dir, "status", "--porcelain");
    fake.projects.remove(project());
    const gone = await ws.board!.sync();
    expect(gone).toMatchObject({ project: null, gone: true, syncedAt: null, last: null, error: { code: "GONE" } });
    expect(gitIn(dir, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(dir, "status", "--porcelain")).toBe(status);

    const again = ok(await ws.board!.setUp());
    expect(again.gone).toBeUndefined();
    expect(project().items).toHaveLength(8);
  });

  it("keeps the board as it was while GitHub can't be reached, and catches up after", async () => {
    const ws = workspace();
    ok(await ws.board!.setUp());
    setStatusIn(STATION, "revised");
    offline = true;
    expect((await ws.board!.sync()).error?.code).toBe("OFFLINE");
    expect(value("sc_5tat1n", "Status")).toBe("Drafted");
    offline = false;
    ok(await ws.board!.sync());
    expect(value("sc_5tat1n", "Status")).toBe("Revised");
  });

  it("sends its changes in a few batched requests, not one per field", async () => {
    const ws = workspace();
    const before = fake.projects.operations.length;
    ok(await ws.board!.setUp());
    // Find, create, describe, the Status options, five fields, read, the cards, then their values.
    expect(fake.projects.operations.length - before).toBeLessThan(20);
    expect(fake.projects.operations.slice(before).some((ops) => ops.length > 10)).toBe(true);
  });
});

describe("through the server", () => {
  it("sets up, syncs and settles conflicts over HTTP, with refusals as codes", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", github, sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "application/json" };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await send(server.port, `/api/novels/${novel.id}/board${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: JSON.parse(r.body) as BoardStatus & { code?: string } };
    };
    try {
      expect(await call("GET", "")).toMatchObject({ status: 200, body: { project: null, conflicts: [] } });
      expect((await call("POST", "/sync")).body.error?.code).toBe("NOT_SET_UP");
      const made = await call("POST", "");
      expect(made).toMatchObject({ status: 200, body: { project: { number: project().number }, last: { added: 8 } } });

      setStatusIn(BRIDGE, "final");
      fake.projects.set(project(), item("sc_br1dg3"), "Status", "Idea");
      expect((await call("POST", "/sync")).body.conflicts).toEqual([{ scene: "sc_br1dg3", title: "Walking the Span", file: "final", board: "idea" }]);
      expect(await call("POST", "/conflicts/sc_br1dg3", { keep: "neither" })).toMatchObject({ status: 400, body: { code: "BAD_REQUEST" } });
      expect((await call("POST", "/conflicts/sc_br1dg3", { keep: "file" })).body.conflicts).toEqual([]);
      expect(value("sc_br1dg3", "Status")).toBe("Final");
      expect(await call("POST", "/conflicts/sc_br1dg3", { keep: "file" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    } finally {
      await server.close();
    }
  });
});

describe("timing", () => {
  it("syncs the board after each sync with GitHub, so a card moved there reaches the file within one cycle", async () => {
    execFileSync("git", ["clone", "--quiet", "--bare", dir, fake.repoPath("ada", name)]);
    // Its upstream, without fetching here: the fake GitHub's git wants the sign-in, which the syncer has.
    gitIn(dir, "config", "branch.main.remote", "origin");
    gitIn(dir, "config", "branch.main.merge", "refs/heads/main");
    const ws = new NovelWorkspace(dir, { commit: false, sync: { intervalMs: 0 }, github });
    open.push(ws);
    ok(await ws.board!.setUp());
    fake.projects.set(project(), item("sc_br1dg3"), "Status", "Revised");
    await ws.syncer!.sync();
    await expect.poll(() => statusIn(BRIDGE), { timeout: 5000 }).toBe("revised");
  });
});
