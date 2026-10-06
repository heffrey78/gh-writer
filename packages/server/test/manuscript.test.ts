import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadNovel, validateNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BibleOperations, createServer, Library, ManuscriptOperations, sessionCookie } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

vi.setConfig({ testTimeout: 20_000 });

const ARRIVAL = "manuscript/01-return/01-arrival";
const OLD_DEBTS = "manuscript/01-return/02-old-debts";
const NIGHT = "manuscript/02-the-sale/01-night-crossing";

let fresh: (name: string) => string;
let cleanUp: () => void;
let dir: string;
let ops: ManuscriptOperations;

beforeAll(() => ({ fresh, cleanUp } = scratch("manuscript")));
afterAll(() => cleanUp());

beforeEach(() => {
  dir = novelRepo(fresh("novel"));
  ops = new ManuscriptOperations(dir, (fn) => fn());
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const lastCommit = () => gitIn(dir, "log", "-1", "--format=%s").trim();
const clean = () => expect(gitIn(dir, "status", "--porcelain")).toBe("");
/** The last commit's changes: status, similarity for renames, paths. */
const changes = () => gitIn(dir, "show", "-M", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
const order = async () => (await loadNovel(nodeSource(dir))).scenes.map((s) => s.id);
async function valid() {
  const novel = await loadNovel(nodeSource(dir));
  expect([...novel.diagnostics, ...validateNovel(novel)].filter((d) => d.severity === "error")).toEqual([]);
  return novel;
}
const START = ["sc_5tat1n", "sc_br1dg3", "sc_w0rk5h", "sc_1edger", "sc_0d9wm4", "sc_f100d0", "sc_0ffer5", "sc_r1vet8"];

describe("moving", () => {
  it("moves a scene to another chapter: its content and every other file's unchanged, only order files edited", async () => {
    const station = read(`${ARRIVAL}/01-the-station.md`);
    await ops.move("sc_5tat1n", { to: "ch_01dde6", index: 1 });
    expect(await order()).toEqual(["sc_br1dg3", "sc_w0rk5h", "sc_5tat1n", "sc_1edger", ...START.slice(4)]);
    expect(read(`${OLD_DEBTS}/02-the-station.md`)).toBe(station);
    const changed = changes();
    // Content changes: the two order files. Everything else is a pure rename (100% similar).
    expect(changed.filter((c) => c.startsWith("M"))).toEqual([`M\t${ARRIVAL}/_chapter.yaml`, `M\t${OLD_DEBTS}/_chapter.yaml`]);
    expect(changed.filter((c) => !c.startsWith("M")).every((c) => c.startsWith("R100"))).toBe(true);
    expect(changed).toContain(`R100\t${ARRIVAL}/01-the-station.md\t${OLD_DEBTS}/02-the-station.md`);
    expect(read(`${ARRIVAL}/_chapter.yaml`)).toBe("id: ch_arr1va\ntitle: Arrival\nscenes: [sc_br1dg3]\n");
    expect(lastCommit()).toBe("Manuscript: move scene “The Station”");
    await valid();
    clean();
  });

  it("reorders scenes within a chapter, swapping their numbers", async () => {
    await ops.move("sc_br1dg3", { index: 0 });
    expect((await order()).slice(0, 2)).toEqual(["sc_br1dg3", "sc_5tat1n"]);
    expect(existsSync(join(dir, `${ARRIVAL}/01-the-bridge.md`))).toBe(true);
    expect(existsSync(join(dir, `${ARRIVAL}/02-the-station.md`))).toBe(true);
    await valid();
  });

  it("moves a chapter into another part, and reorders parts, folders and all", async () => {
    await ops.move("ch_01dde6", { to: "pt_5a1e00", index: 0 });
    expect(await order()).toEqual(["sc_5tat1n", "sc_br1dg3", "sc_w0rk5h", "sc_1edger", ...START.slice(4)]);
    expect(existsSync(join(dir, "manuscript/02-the-sale/01-old-debts/_chapter.yaml"))).toBe(true);
    expect(existsSync(join(dir, "manuscript/02-the-sale/02-night-crossing/01-the-betrayal.md"))).toBe(true);
    await valid();

    await ops.move("pt_5a1e00", { index: 0 });
    expect(await order()).toEqual(["sc_w0rk5h", "sc_1edger", "sc_0d9wm4", "sc_f100d0", "sc_0ffer5", "sc_r1vet8", "sc_5tat1n", "sc_br1dg3"]);
    expect(existsSync(join(dir, "manuscript/01-the-sale/_part.yaml"))).toBe(true);
    expect(existsSync(join(dir, "manuscript/02-return/01-arrival/01-the-station.md"))).toBe(true);
    await valid();
    clean();
  });
});

describe("creating and renaming", () => {
  it("adds a scene after another, with a new ID and the right number", async () => {
    const { id } = await ops.createScene("ch_arr1va", { title: "On the Platform", after: "sc_5tat1n" });
    expect(await order()).toEqual(["sc_5tat1n", id, "sc_br1dg3", ...START.slice(2)]);
    expect(read(`${ARRIVAL}/02-on-the-platform.md`)).toBe(`---\nid: ${id}\ntitle: On the Platform\nstatus: idea\n---\n`);
    expect(existsSync(join(dir, `${ARRIVAL}/03-the-bridge.md`))).toBe(true);
    expect(lastCommit()).toBe("Manuscript: add scene “On the Platform”");
    await valid();
  });

  it("adds a chapter to a part and a part to the book", async () => {
    const { id: chapter } = await ops.createChapter("pt_r3tvrn", { title: "Homecoming", after: "ch_arr1va" });
    expect(read("manuscript/01-return/02-homecoming/_chapter.yaml")).toBe(`id: ${chapter}\ntitle: Homecoming\nscenes: []\n`);
    expect(existsSync(join(dir, "manuscript/01-return/03-old-debts/_chapter.yaml"))).toBe(true);
    const { id: part } = await ops.createPart({ title: "Afterwards" });
    expect(read("manuscript/03-afterwards/_part.yaml")).toBe(`id: ${part}\ntitle: Afterwards\nchapters: []\n`);
    await ops.createScene(chapter, { title: "Back Again" });
    expect((await valid()).chapters.find((c) => c.id === chapter)?.sceneIds).toHaveLength(1);
  });

  it("renames a scene, chapter and part; the names on disk follow, references don't change", async () => {
    await ops.rename("sc_5tat1n", "Arrival at Varn");
    expect(read(`${ARRIVAL}/01-arrival-at-varn.md`)).toMatch(/^---\nid: sc_5tat1n\ntitle: Arrival at Varn\n/);
    await ops.rename("ch_arr1va", "Coming Home");
    expect(read("manuscript/01-return/01-coming-home/_chapter.yaml")).toMatch(/^id: ch_arr1va\ntitle: Coming Home\n/);
    // The folder moved: its order file changed (a rename with an edit), its scenes are pure renames.
    expect(changes().filter((c) => !c.startsWith("R100"))).toEqual([expect.stringMatching(/^R\d+\tmanuscript\/01-return\/01-arrival\/_chapter\.yaml\tmanuscript\/01-return\/01-coming-home\/_chapter\.yaml$/)]);
    await ops.rename("pt_5a1e00", "The Selling");
    expect(existsSync(join(dir, "manuscript/02-the-selling/01-night-crossing/02-the-flood.md"))).toBe(true);
    expect(await order()).toEqual(START);
    await valid();
  });
});

describe("splitting and merging", () => {
  it("splits a scene between paragraphs and merges it back to the same prose", async () => {
    const original = await loadNovel(nodeSource(dir));
    const station = original.allScenes.find((s) => s.id === "sc_5tat1n")!;
    const { id } = await ops.split("sc_5tat1n", { paragraph: 2, title: "The Flags" });
    let novel = await valid();
    const first = novel.allScenes.find((s) => s.id === "sc_5tat1n")!;
    const second = novel.allScenes.find((s) => s.id === id)!;
    expect(novel.scenes.map((s) => s.id).slice(0, 3)).toEqual(["sc_5tat1n", id, "sc_br1dg3"]);
    expect(second).toMatchObject({ title: "The Flags", pov: station.pov, characters: station.characters, status: station.status });
    const paragraphs = (body: string) => body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    expect(paragraphs(first.body)).toEqual(paragraphs(station.body).slice(0, 2));
    expect(paragraphs(second.body)).toEqual(paragraphs(station.body).slice(2));
    expect(lastCommit()).toBe("Manuscript: split “The Station”, the rest as “The Flags”");

    await ops.merge("sc_5tat1n");
    novel = await valid();
    expect(paragraphs(novel.allScenes.find((s) => s.id === "sc_5tat1n")!.body)).toEqual(paragraphs(station.body));
    expect(novel.allScenes.some((s) => s.id === id)).toBe(false);
    expect(await order()).toEqual(START);
    clean();
  });

  it("refuses to split outside the paragraphs or merge the last scene", async () => {
    await expect(ops.split("sc_5tat1n", { paragraph: 0, title: "X" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(ops.split("sc_5tat1n", { paragraph: 99, title: "X" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(ops.merge("sc_br1dg3")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("moves relationships that started at the merged-away scene to the scene it joined", async () => {
    const bible = new BibleOperations(dir, (fn) => fn());
    const { id } = await bible.createRelationship({ from: "char_7f3k2q", to: "char_t0ma5h", type: "allies", since: "sc_f100d0" });
    await ops.merge("sc_0d9wm4");
    const novel = await valid();
    expect(novel.relationships.find((r) => r.id === id)?.since).toBe("sc_0d9wm4");
  });
});

describe("deleting and restoring", () => {
  it("deletes a scene and brings it back, identical, in its place", async () => {
    const original = read(`${ARRIVAL}/01-the-station.md`);
    await ops.delete("sc_5tat1n");
    expect(await order()).toEqual(START.slice(1));
    expect(lastCommit()).toBe("Manuscript: delete scene “The Station”");
    const deleted = await ops.recentlyDeleted();
    expect(deleted).toEqual([expect.objectContaining({ kind: "scene", id: "sc_5tat1n", title: "The Station", path: `${ARRIVAL}/01-the-station.md` })]);

    await ops.restore(deleted[0]!.commit, "sc_5tat1n");
    expect(await order()).toEqual(START);
    expect(read(`${ARRIVAL}/01-the-station.md`)).toBe(original);
    expect(lastCommit()).toBe("Manuscript: restore scene “The Station”");
    expect(await ops.recentlyDeleted()).toEqual([]);
    await valid();
    clean();
  });

  it("deletes a chapter with its scenes and brings the whole chapter back", async () => {
    await ops.delete("ch_n1ght0");
    expect(existsSync(join(dir, NIGHT))).toBe(false);
    expect(await order()).toEqual([...START.slice(0, 4), ...START.slice(6)]);
    const [item] = await ops.recentlyDeleted();
    expect(item).toMatchObject({ kind: "chapter", id: "ch_n1ght0", title: "Night Crossing" });
    await ops.restore(item!.commit, "ch_n1ght0");
    expect(await order()).toEqual(START);
    expect(existsSync(join(dir, `${NIGHT}/02-the-flood.md`))).toBe(true);
    await valid();
  });

  it("changes nothing when an operation can't be done", async () => {
    const head = gitIn(dir, "rev-parse", "HEAD").trim();
    await expect(ops.move("sc_5tat1n", { to: "ch_zzzzzz", index: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ops.createScene("ch_arr1va", { title: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(gitIn(dir, "rev-parse", "HEAD").trim()).toBe(head);
    clean();
  });
});

describe("through the server", () => {
  it("answers each operation", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "application/json" };
    const call = (path: string, body: unknown = {}, method = "POST") => send(server.port, `/api/novels/${novel.id}/manuscript${path}`, { method, headers, body: JSON.stringify(body) });
    try {
      const created = await call("/scenes", { chapter: "ch_arr1va", title: "New" });
      expect(created.status).toBe(201);
      const { id } = JSON.parse(created.body) as { id: string };
      expect((await call(`/items/${id}/move`, { index: 0 })).status).toBe(200);
      expect((await call(`/items/${id}/rename`, { title: "Newer" })).status).toBe(200);
      expect((await call(`/items/${id}/delete`)).status).toBe(200);
      const { deleted } = JSON.parse((await send(server.port, `/api/novels/${novel.id}/manuscript/deleted`, { headers })).body) as { deleted: { commit: string; id: string }[] };
      expect(deleted[0]).toMatchObject({ id });
      expect((await call("/deleted/restore", { commit: deleted[0]!.commit, id })).status).toBe(200);
      expect((await call("/items/sc_zzzzzz/move", { index: 0 })).status).toBe(404);
      expect((await call(`/items/${id}/move`, {})).status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe("random reshaping", () => {
  it("keeps every scene, byte for byte, and the order it was told, through any sequence of moves", async () => {
    const fc = (await import("fast-check")).default;
    const sceneContent = async () => Object.fromEntries((await loadNovel(nodeSource(dir))).allScenes.map((s) => [s.id, read(s.file)]));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.boolean()), { minLength: 1, maxLength: 4 }), async (steps) => {
        dir = novelRepo(fresh("random"));
        ops = new ManuscriptOperations(dir, (fn) => fn());
        const before = await sceneContent();
        for (const [a, b, c, chapterMove] of steps) {
          const novel = await loadNovel(nodeSource(dir));
          if (chapterMove) {
            const chapter = novel.allChapters[a % novel.allChapters.length]!;
            const part = novel.allParts[b % novel.allParts.length]!;
            await ops.move(chapter.id, { to: part.id, index: c % (part.chapterIds.length + 1) });
          } else {
            const scene = novel.allScenes[a % novel.allScenes.length]!;
            const chapter = novel.allChapters[b % novel.allChapters.length]!;
            await ops.move(scene.id, { to: chapter.id, index: c % (chapter.sceneIds.length + 1) });
          }
        }
        // Structure must stay valid. A reorder may put a relationship's end before its start
        // (E_REL_RANGE): that's the story's consistency, for the author to fix, not the operation's.
        const novel = await loadNovel(nodeSource(dir));
        expect([...novel.diagnostics, ...validateNovel(novel)].filter((d) => d.severity === "error" && d.code !== "E_REL_RANGE")).toEqual([]);
        expect(await sceneContent()).toEqual(before);
        // Reading order is the order files' order, and every file name's number matches its place.
        for (const chapter of novel.allChapters) {
          chapter.sceneIds.forEach((id, i) => expect(novel.allScenes.find((s) => s.id === id)!.file).toMatch(new RegExp(`/${String(i + 1).padStart(2, "0")}-[^/]+\\.md$`)));
        }
        clean();
      }),
      { numRuns: 12 },
    );
  }, 120_000);
});
