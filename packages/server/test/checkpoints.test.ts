import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countWords, loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Checkpoints, Committer, createServer, Library, sessionCookie, Syncer, type Checkpoint, type RestoreResult } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const SCENE2 = "manuscript/01-return/01-arrival/02-the-bridge.md";
const ARRIVAL = "manuscript/01-return/01-arrival/_chapter.yaml";
const OLD_DEBTS = "manuscript/01-return/02-old-debts/_chapter.yaml";
const ADA = "bible/characters/ada.md";

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
let dir: string;
let checkpoints: Checkpoints;
let clock: number;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("checkpoints")));
afterAll(() => cleanUp());

/** Checkpoints with a clock that moves a minute per call, so tag names sort the way they were made. */
const open = (root: string, deps: { onCreate?: () => void } = {}) =>
  new Checkpoints(root, { committer: new Committer(root), now: () => new Date(Date.UTC(2026, 9, 5, 18, clock++)), ...deps });

beforeEach(() => {
  clock = 0;
  dir = novelRepo(fresh("novel"));
  checkpoints = open(dir);
});

const read = (path: string, root = dir) => readFileSync(join(root, path), "utf8");
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const append = (path: string, text: string) => write(path, read(path) + text);
const commitAll = (message: string) => {
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", message);
};
const tree = (rev: string, ...paths: string[]) => gitIn(dir, "ls-tree", "-r", rev, "--", ...paths);
const manuscriptWords = async (root = dir) => (await loadNovel(nodeSource(root))).allScenes.reduce((n, s) => n + countWords(s.body), 0);

describe("creating and listing", () => {
  it("commits pending work, then tags it with the name and the word count", async () => {
    append(SCENE, "Three more words.\n");
    const checkpoint = await checkpoints.create("Before the big cut");
    expect(checkpoint).toEqual({
      id: "2026-10-05-180000-before-the-big-cut",
      name: "Before the big cut",
      date: expect.any(String),
      words: await manuscriptWords(),
      auto: false,
      commit: gitIn(dir, "rev-parse", "HEAD").trim(),
    });
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
    expect(gitIn(dir, "log", "-1", "--format=%s")).toMatch(/^Draft: The Station \(\+3 words\)/);
    expect(gitIn(dir, "cat-file", "-t", "checkpoint/2026-10-05-180000-before-the-big-cut").trim()).toBe("tag");
    expect(gitIn(dir, "tag", "-l", "--format=%(contents)", "checkpoint/*")).toBe(`Before the big cut\n\nWords: ${checkpoint.words}\n\n`);
  });

  it("lists checkpoints newest first, with their word counts", async () => {
    await checkpoints.create("First draft done");
    append(SCENE, "One two three four five.\n");
    await checkpoints.create("Second pass");
    const list = await checkpoints.list();
    expect(list.map((c) => c.name)).toEqual(["Second pass", "First draft done"]);
    expect(list[0]!.words - list[1]!.words).toBe(5);
  });

  it("makes tag names safe, unique and in order when made within one second", async () => {
    const a = await new Checkpoints(dir, { committer: new Committer(dir), now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) }).create("  Ça   va? Résumé / “quotes” ");
    expect(a).toMatchObject({ id: "2026-01-02-030405-ca-va-resume-quotes", name: "Ça va? Résumé / “quotes”" });
    const same = new Checkpoints(dir, { committer: new Committer(dir), now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) });
    expect((await same.create("Ça va? Résumé / quotes")).id).toBe("2026-01-02-030406-ca-va-resume-quotes");
    expect((await same.create("✨")).id).toBe("2026-01-02-030407-checkpoint");
    expect((await same.list()).map((c) => c.id.slice(0, 17))).toEqual(["2026-01-02-030407", "2026-01-02-030406", "2026-01-02-030405"]);
  });

  it("refuses an empty or overlong name", async () => {
    await expect(checkpoints.create("  ")).rejects.toMatchObject({ code: "BAD_NAME" });
    await expect(checkpoints.create("x".repeat(201))).rejects.toMatchObject({ code: "BAD_NAME" });
  });

  it("makes no checkpoint when the work can't be committed", async () => {
    const global = process.env.GIT_CONFIG_GLOBAL;
    const empty = join(tmp, "empty-gitconfig");
    writeFileSync(empty, "");
    process.env.GIT_CONFIG_GLOBAL = empty;
    try {
      append(SCENE, "x\n");
      await expect(checkpoints.create("Nope")).rejects.toMatchObject({ code: "BLOCKED", message: expect.stringContaining("git config --global user.name") });
      expect(await checkpoints.list()).toEqual([]);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = global;
    }
  });
});

describe("restoring", () => {
  it("brings back the whole manuscript and bible byte for byte, leaving other files alone", async () => {
    const checkpoint = await checkpoints.create("Before the big cut");
    const tag = `checkpoint/${checkpoint.id}`;
    append(SCENE, "A rewrite.\n");
    rmSync(join(dir, SCENE2));
    write("manuscript/01-return/01-arrival/03-new.md", "---\nid: sc_n3wn3w\ntitle: New\n---\n\nNew.\n");
    append(ADA, "New notes.\n");
    write("novel.yaml", `${read("novel.yaml")}# kept\n`);
    commitAll("Big cut");

    const result = await checkpoints.restore(checkpoint.id);
    expect(tree("HEAD", "manuscript", "bible")).toBe(tree(tag, "manuscript", "bible"));
    expect(existsSync(join(dir, "manuscript/01-return/01-arrival/03-new.md"))).toBe(false);
    expect(read(SCENE)).toBe(gitIn(dir, "show", `${tag}:${SCENE}`));
    expect(read("novel.yaml")).toContain("# kept");
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
    expect(gitIn(dir, "log", "-1", "--format=%s").trim()).toBe("Restore the manuscript from checkpoint “Before the big cut”");
    expect(result.files.sort()).toEqual(["manuscript/01-return/01-arrival/03-new.md", SCENE, SCENE2, ADA].sort());
    expect(result.commit).toBe(gitIn(dir, "rev-parse", "HEAD").trim());
  });

  it("restores one scene by ID after it moved to another chapter, and nothing else", async () => {
    const checkpoint = await checkpoints.create("Before moving");
    const original = read(SCENE);
    // Move The Station into the next chapter and rewrite it; edit another scene too.
    const moved = "manuscript/01-return/02-old-debts/00-the-station.md";
    gitIn(dir, "mv", SCENE, moved);
    write(ARRIVAL, read(ARRIVAL).replace("sc_5tat1n, ", ""));
    write(OLD_DEBTS, read(OLD_DEBTS).replace("scenes: [", "scenes: [sc_5tat1n, "));
    write(moved, `${original.trimEnd()}\nRewritten ending.\n`);
    append(SCENE2, "Kept edit.\n");
    commitAll("Move and rewrite");
    const chapters = [read(ARRIVAL), read(OLD_DEBTS)];

    const result = await checkpoints.restore(checkpoint.id, { sceneId: "sc_5tat1n" });
    expect(read(moved)).toBe(original);
    expect(existsSync(join(dir, SCENE))).toBe(false);
    expect(read(SCENE2)).toContain("Kept edit.");
    expect([read(ARRIVAL), read(OLD_DEBTS)]).toEqual(chapters);
    expect(result.files).toEqual([moved]);
    expect(gitIn(dir, "log", "-1", "--format=%s").trim()).toBe("Restore scene “The Station” from checkpoint “Before moving”");
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
  });

  it("brings a deleted scene back where it was", async () => {
    const checkpoint = await checkpoints.create("Before deleting");
    const original = read(SCENE2);
    rmSync(join(dir, SCENE2));
    commitAll("Delete");
    await checkpoints.restore(checkpoint.id, { sceneId: "sc_br1dg3" });
    expect(read(SCENE2)).toBe(original);
  });

  it("can be undone, back to the exact state before, including work not yet committed", async () => {
    const checkpoint = await checkpoints.create("Early");
    append(SCENE, "Later work.\n");
    commitAll("Later");
    append(SCENE2, "Saved but not committed.\n");
    const before = { scene: read(SCENE), scene2: read(SCENE2) };

    const { undo } = await checkpoints.restore(checkpoint.id);
    expect(undo).toMatchObject({ auto: true, name: "Before restoring the manuscript from “Early”" });
    expect(read(SCENE2)).not.toContain("Saved but not committed.");
    const undoTree = tree(`checkpoint/${undo.id}`);

    const redo = await checkpoints.restore(undo.id);
    expect({ scene: read(SCENE), scene2: read(SCENE2) }).toEqual(before);
    expect(tree("HEAD")).toBe(undoTree);
    // Undoing took its own checkpoint, so the undo can be undone too.
    expect(redo.undo).toMatchObject({ auto: true, name: "Before restoring the manuscript from “Before restoring the manuscript from “Early””" });
  });

  it("undoes a one-scene restore", async () => {
    const checkpoint = await checkpoints.create("Early");
    append(SCENE, "Later work.\n");
    commitAll("Later");
    const before = gitIn(dir, "rev-parse", "HEAD^{tree}").trim();
    const { undo } = await checkpoints.restore(checkpoint.id, { sceneId: "sc_5tat1n" });
    expect(undo.name).toBe("Before restoring “The Station” from “Early”");
    await checkpoints.restore(undo.id);
    expect(gitIn(dir, "rev-parse", "HEAD^{tree}").trim()).toBe(before);
  });

  it("makes no commit when nothing differs", async () => {
    const checkpoint = await checkpoints.create("Now");
    expect(await checkpoints.restore(checkpoint.id)).toMatchObject({ commit: null, files: [] });
  });

  it("reports an unknown checkpoint or scene", async () => {
    await expect(checkpoints.restore("2026-01-01-000000-nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const checkpoint = await checkpoints.create("Now");
    await expect(checkpoints.restore(checkpoint.id, { sceneId: "sc_zzzzzz" })).rejects.toMatchObject({ code: "SCENE_NOT_FOUND" });
    // Nothing was taken or changed for a restore that couldn't start.
    expect((await checkpoints.list()).length).toBe(1);
  });
});

describe("sync", () => {
  it("carries checkpoints to another clone", async () => {
    const remote = fresh("remote.git");
    gitIn(tmp, "clone", "-q", "--bare", dir, remote);
    const [a, b] = [fresh("a"), fresh("b")];
    gitIn(tmp, "clone", "-q", remote, a);
    gitIn(tmp, "clone", "-q", remote, b);

    const syncA = new Syncer(a, { schedule: () => () => {} }, { committer: new Committer(a) });
    await syncA.sync();
    // A checkpoint with nothing new to commit still reaches the remote with the next sync.
    const made = await open(a, { onCreate: () => syncA.tagsChanged() }).create("Shared");
    expect(await syncA.sync()).toMatchObject({ state: "synced" });

    await new Syncer(b, { schedule: () => () => {} }).sync();
    expect(await open(b).list()).toEqual([made]);
  });
});

describe("through the server", () => {
  it("creates, lists and restores checkpoints, and undoes a restore", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
    const base = `/api/novels/${novel.id}/checkpoints`;
    const post = (path: string, body: unknown) => send(server.port, `${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      const created = await post("", { name: "Before the big cut" });
      expect(created.status).toBe(201);
      const { checkpoint } = JSON.parse(created.body) as { checkpoint: Checkpoint };
      expect(checkpoint).toMatchObject({ name: "Before the big cut", auto: false });

      const original = read(SCENE);
      append(SCENE, "Cut later.\n");
      commitAll("Later");

      const restored = await post(`/${checkpoint.id}/restore`, { sceneId: "sc_5tat1n" });
      expect(restored.status).toBe(200);
      const { undo } = JSON.parse(restored.body) as RestoreResult;
      expect(read(SCENE)).toBe(original);

      const list = JSON.parse((await send(server.port, base, { headers })).body) as { checkpoints: Checkpoint[] };
      expect(list.checkpoints.map((c) => [c.name, c.auto])).toEqual([
        [undo.name, true],
        ["Before the big cut", false],
      ]);

      expect((await post(`/${undo.id}/restore`, {})).status).toBe(200);
      expect(read(SCENE)).toContain("Cut later.");

      expect((await post("", { name: "" })).status).toBe(400);
      expect((await post("", {})).status).toBe(400);
      expect(JSON.parse((await post("/2026-01-01-000000-nope/restore", {})).body)).toMatchObject({ code: "NOT_FOUND" });
      expect((await post(`/${checkpoint.id}/restore`, { sceneId: "sc_zzzzzz" })).status).toBe(404);
      expect((await post(`/${checkpoint.id}/restore`, { sceneId: 7 })).status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
