import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadNovel, memorySource, mentions, relationshipsAt, type Novel } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const SAMPLE = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));

describe("loading the sample novel", () => {
  let novel: Novel;

  it("loads without diagnostics", async () => {
    novel = await loadNovel(nodeSource(SAMPLE));
    expect(novel.diagnostics).toEqual([]);
  });

  it("builds the structure in reading order", () => {
    expect(novel.config?.title).toBe("The Bridge at Varn");
    expect(novel.topLevel).toBe("parts");
    expect(novel.parts.map((p) => p.title)).toEqual(["Return", "The Sale"]);
    expect(novel.chapters.map((c) => c.title)).toEqual(["Arrival", "Old Debts", "Night Crossing", "Varn Holds"]);
    expect(novel.scenes.map((s) => s.title)).toEqual([
      "The Station", "Walking the Span", "Tomas's Workshop", "Ben's Ledger",
      "The Betrayal", "The Flood", "Mirela's Offer", "The Last Rivet",
    ]);
    expect(novel.scenes.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("loads the bible, including the custom entity type", () => {
    const count = (type: string) => novel.entities.filter((e) => e.type === type).length;
    expect([count("character"), count("location"), count("plotline"), count("theme"), count("artifact")]).toEqual([4, 4, 2, 2, 1]);
    expect(novel.relationships).toHaveLength(8);
    expect(novel.events).toHaveLength(3);
    expect(Object.keys(novel.layouts["relationship-graph"]!.nodes)).toHaveLength(5);
  });

  it("normalises scene references", () => {
    const betrayal = novel.scenes.find((s) => s.id === "sc_0d9wm4")!;
    expect(betrayal.plotlines).toEqual([
      { id: "plot_h315tz", weight: "major", beat: "The plans have been sold" },
      { id: "plot_gr1efa", weight: "major", beat: "Ben confesses the debt" },
    ]);
    expect(betrayal.when).toEqual({ day: 3, time: "18:30" });
    expect(betrayal.body.startsWith("The wind came off the river")).toBe(true);
    expect(novel.scenes.find((s) => s.id === "sc_f100d0")!.when).toEqual({ at: "2009-11-02T23:00" });
  });

  it("resolves time-scoped relationships", () => {
    const adaBen = (sceneId: string) =>
      relationshipsAt(novel, sceneId)
        .filter((r) => r.from === "char_7f3k2q" && r.to === "char_b3n0vs")
        .map((r) => r.type)
        .sort();
    expect(adaBen("sc_br1dg3")).toEqual(["allies", "sibling"]); // before the betrayal
    expect(adaBen("sc_0d9wm4")).toEqual(["rivals", "sibling"]); // since is inclusive, until exclusive
    expect(adaBen("sc_0ffer5")).toEqual(["rivals", "sibling"]);
    expect(adaBen("sc_r1vet8")).toEqual(["allies", "sibling"]); // reconciled
  });

  it("finds mentions in prose", () => {
    const betrayal = novel.scenes.find((s) => s.id === "sc_0d9wm4")!;
    expect(mentions(betrayal.body).map((m) => [m.id, m.line])).toEqual([["char_7f3k2q", 3], ["char_b3n0vs", 7]]);
  });
});

/** A minimal valid novel organised directly in chapters. */
function tiny(overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    "novel.yaml": "schema_version: 1\nid: nv_4k8h2c\ntitle: Tiny\n",
    "manuscript/_order.yaml": "chapters: [ch_aaaaaa]\n",
    "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_aaaaaa, sc_bbbbbb]\n",
    "manuscript/01-one/01-a.md": "---\nid: sc_aaaaaa\ntitle: A\n---\nOne.\n",
    "manuscript/01-one/02-b.md": "---\nid: sc_bbbbbb\ntitle: B\n---\nTwo.\n",
    "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\n---\n",
    ...overrides,
  };
  const defined = Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => e[1] !== undefined));
  return loadNovel(memorySource(defined));
}

const codes = (n: Novel) => n.diagnostics.map((d) => d.code);

describe("loader structure checks", () => {
  it("loads a novel without parts", async () => {
    const n = await tiny();
    expect(n.diagnostics).toEqual([]);
    expect(n.topLevel).toBe("chapters");
    expect(n.scenes.map((s) => s.id)).toEqual(["sc_aaaaaa", "sc_bbbbbb"]);
  });

  it("reports missing required files", async () => {
    expect(codes(await tiny({ "novel.yaml": undefined }))).toEqual(["E_MISSING_FILE"]);
    expect(codes(await tiny({ "manuscript/_order.yaml": undefined }))).toEqual(["E_MISSING_FILE"]);
  });

  it("reports YAML and front matter parse errors with a line number", async () => {
    const n = await tiny({ "manuscript/01-one/01-a.md": "---\nid: sc_aaaaaa\ntitle: [unclosed\n---\nOne.\n" });
    expect(n.diagnostics[0]).toMatchObject({ code: "E_PARSE", file: "manuscript/01-one/01-a.md" });
    expect(n.diagnostics[0]!.line).toBeGreaterThanOrEqual(3);
    expect(codes(await tiny({ "manuscript/01-one/01-a.md": "No front matter.\n" }))).toContain("E_PARSE");
  });

  it("stops at a newer schema version", async () => {
    expect(codes(await tiny({ "novel.yaml": "schema_version: 2\nid: nv_4k8h2c\ntitle: Tiny\n" }))).toEqual(["E_SCHEMA_VERSION"]);
  });

  it("reports order problems", async () => {
    const n = await tiny({ "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_aaaaaa, sc_aaaaaa, sc_cccccc]\n" });
    expect(codes(n).sort()).toEqual(["E_ORDER_DUPLICATE", "E_ORDER_MISSING", "E_ORDER_UNKNOWN"]);
    expect(n.scenes.map((s) => s.id)).toEqual(["sc_aaaaaa"]);
    expect(n.allScenes).toHaveLength(2);
  });

  it("reports misplaced files and folders", async () => {
    expect(codes(await tiny({ "manuscript/stray.md": "---\nid: sc_cccccc\ntitle: S\n---\n" }))).toEqual(["E_MISPLACED"]);
    expect(codes(await tiny({ "manuscript/notes/idea.txt": "x" }))).toEqual(["E_MISPLACED"]);
    expect(codes(await tiny({ "manuscript/01-one/sub/x.md": "x" }))).toEqual(["E_MISPLACED"]);
    expect(codes(await tiny({ "manuscript/02-act/_part.yaml": "id: pt_aaaaaa\ntitle: P\nchapters: []\n" }))).toEqual(["E_MISPLACED"]);
  });

  it("reports unknown bible folders that contain entries, but not asset folders", async () => {
    expect(codes(await tiny({ "bible/creatures/wolf.md": "---\nid: cr_aaaaaa\nname: Wolf\n---\n" }))).toEqual(["E_UNKNOWN_FOLDER"]);
    expect(codes(await tiny({ "bible/images/ada.jpg": "binary" }))).toEqual([]);
  });

  it("rejects custom entity types that clash with built-in ones", async () => {
    const n = await tiny({
      "novel.yaml": "schema_version: 1\nid: nv_4k8h2c\ntitle: T\nentity_types:\n  - {key: beast, prefix: char, folder: beasts}\n  - {key: ship, prefix: ship, folder: ships}\n",
    });
    expect(codes(n)).toEqual(["E_ENTITY_TYPE"]);
    expect(n.entityTypes.map((t) => t.key)).toContain("ship");
  });

  it("keeps renamed (re-slugged) entity files resolvable by ID", async () => {
    const n = await tiny({ "bible/characters/ada.md": undefined, "bible/characters/ada-varn-renamed.md": "---\nid: char_aaaaaa\nname: Ada Varn\n---\n" });
    expect(n.entities.map((e) => [e.id, e.file])).toEqual([["char_aaaaaa", "bible/characters/ada-varn-renamed.md"]]);
  });
});
