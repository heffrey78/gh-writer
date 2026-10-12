import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gridKey, presence } from "../src/diagrams.ts";
import { entryPresence, entryPresences, loadNovel, memorySource } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));
const strip = (id: string) =>
  entryPresence(novel, id)!
    .scenes.map((s) => ({ carries: "C", present: "p", mentioned: "m", absent: "." })[s.mark])
    .join("");

describe("entryPresence", () => {
  it("marks each scene as the Presence view does, with what carries a scene by type", () => {
    // A character carries her point of view.
    expect(strip("char_7f3k2q")).toBe("CCCCCpCC");
    // A plotline carries its major beats; a theme its strongest scenes.
    expect(strip("plot_h315tz")).toBe("pCC.C.CC");
    expect(strip("theme_trvst5")).toBe(".p.CC.pp");
    expect(strip("loc_br1dg3")).toBe(".p..pp.p");
    // Every scene it's in, any way, is in the Presence view, and only those.
    for (const e of novel.entities) {
      const m = presence(novel, e.type);
      for (const { scene, mark } of entryPresence(novel, e.id)!.scenes) expect(mark !== "absent").toBe(m.marks.has(gridKey(e.id, scene.id)));
    }
  });

  it("works out every entry's at once, the same as one by one", () => {
    const all = entryPresences(novel);
    expect([...all.keys()].sort()).toEqual(novel.entities.map((e) => e.id).sort());
    for (const e of novel.entities) expect(all.get(e.id)).toEqual(entryPresence(novel, e.id));
  });

  it("says where it starts and ends, how often it carries the scene, its longest absence and its events", () => {
    const ada = entryPresence(novel, "char_7f3k2q")!;
    expect(ada).toMatchObject({ count: 8, carries: 7, first: { title: "The Station" }, last: { title: "The Last Rivet" } });
    expect(ada.longestAbsence).toBeUndefined();
    expect(ada.events.map((e) => e.title).sort()).toEqual(["Ada leaves for the polytechnic", "The flood of '09"]);
    const workshop = entryPresence(novel, "loc_w0rk5p")!;
    expect(workshop.longestAbsence).toMatchObject({ scenes: 3, from: { title: "Ben's Ledger" }, to: { title: "The Flood" } });
    expect(workshop.chapters.map((c) => [c.title, c.span])).toEqual([["Arrival", 2], ["Old Debts", 2], ["Night Crossing", 2], ["Varn Holds", 2]]);
    expect(workshop.parts.map((p) => [p.part.title, p.span])).toEqual([["Return", 4], ["The Sale", 4]]);
  });

  it("knows an entry no scene uses yet, and nothing of an ID the novel doesn't have", async () => {
    const book = await loadNovel(memorySource({ "novel.yaml": "schema_version: 1\nid: nv_aaaaaa\ntitle: T\n", "bible/characters/x.md": "---\nid: char_xxxxxx\nname: X\n---\n" }));
    expect(entryPresence(book, "char_xxxxxx")).toMatchObject({ scenes: [], count: 0, carries: 0 });
    expect(entryPresence(book, "char_xxxxxx")!.first).toBeUndefined();
    expect(entryPresence(novel, "char_nope00")).toBeUndefined();
  });
});
