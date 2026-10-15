import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hardWrappedLines, memorySource, RULES, validate, type Diagnostic } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const SAMPLE = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));

const NOVEL = `schema_version: 1
id: nv_4k8h2c
title: Fixture
relationship_types:
  - key: sibling
    symmetric: true
  - key: mentor
    from_types: [character]
    to_types: [character]
`;

const scene = (id: string, title: string, extra = "", body = "Prose.\n") => `---\nid: ${id}\ntitle: ${title}\n${extra}---\n${body}`;

/** A small valid novel: one chapter, three scenes, a few bible entries. Override or delete (undefined) files per test. */
function fixture(overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    "novel.yaml": NOVEL,
    "manuscript/_order.yaml": "chapters: [ch_aaaaaa]\n",
    "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_aaaaaa, sc_bbbbbb, sc_cccccc]\n",
    "manuscript/01-one/01-a.md": scene("sc_aaaaaa", "A", "pov: char_aaaaaa\ncharacters: [char_aaaaaa]\nlocations: [loc_aaaaaa]\nplotlines: [plot_aaaaaa]\nthemes: [theme_aaaaaa]\n"),
    "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B"),
    "manuscript/01-one/03-c.md": scene("sc_cccccc", "C"),
    "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\n---\n",
    "bible/characters/ben.md": "---\nid: char_bbbbbb\nname: Ben\n---\n",
    "bible/locations/bridge.md": "---\nid: loc_aaaaaa\nname: Bridge\n---\n",
    "bible/plotlines/sale.md": "---\nid: plot_aaaaaa\nname: Sale\n---\n",
    "bible/themes/trust.md": "---\nid: theme_aaaaaa\nname: Trust\n---\n",
    "bible/relationships.yaml": "relationships:\n  - {id: rel_aaaaaa, from: char_aaaaaa, to: char_bbbbbb, type: sibling, since: sc_aaaaaa, until: sc_cccccc}\n",
    ...overrides,
  };
  const defined = Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => e[1] !== undefined));
  return validate(memorySource(defined));
}

const rels = (...lines: string[]) => `relationships:\n${lines.map((l) => `  - ${l}\n`).join("")}`;
const only = (ds: Diagnostic[]) => ds.map((d) => d.code);

describe("validate", () => {
  it("passes the sample novel with no errors or warnings", async () => {
    const result = await validate(nodeSource(SAMPLE));
    expect(result.diagnostics).toEqual([]);
  });

  it("passes the base fixture", async () => {
    expect((await fixture()).diagnostics).toEqual([]);
  });

  it("W_MISSING_IMAGE for a cover or an entry's picture that isn't in the repository", async () => {
    const present = await fixture({
      "novel.yaml": `${NOVEL}cover: images/cover.jpg\n`,
      "images/cover.jpg": "\xff\xd8",
      "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\nimage: images/ada.jpg\nimage_focus: [0.5, 0.3]\n---\n",
      "images/ada.jpg": "\xff\xd8",
    });
    expect(present.diagnostics).toEqual([]);
    expect(present.novel.config?.cover).toBe("images/cover.jpg");
    expect(present.novel.entities.find((e) => e.id === "char_aaaaaa")).toMatchObject({ image: "images/ada.jpg", imageFocus: [0.5, 0.3] });

    const missing = await fixture({
      "novel.yaml": `${NOVEL}cover: images/cover.jpg\n`,
      "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\nimage: bible/images/ada.jpg\n---\n",
      "images/other.jpg": "\xff\xd8",
    });
    expect(missing.diagnostics).toMatchObject([
      { code: "W_MISSING_IMAGE", file: "bible/characters/ada.md", pointer: "/image", message: "Ada's picture, bible/images/ada.jpg, isn't in the repository" },
      { code: "W_MISSING_IMAGE", file: "novel.yaml", pointer: "/cover", message: "The cover, images/cover.jpg, isn't in the repository" },
    ]);
  });

  it("pictures in prose: W_MISSING_IMAGE for a missing file, W_IMAGE_OUTSIDE for one not under /images/ (D10)", async () => {
    const body = "A map:\n\n![The valley](/images/valley.jpg \"As Tomas drew it\")\n\n![Gone](/images/gone.png)\n\n![Here](images/here.jpg) and ![Web](https://example.com/x.png)\n";
    const r = await fixture({ "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "", body), "images/valley.jpg": "\xff\xd8" });
    expect(r.diagnostics).toMatchObject([
      { code: "W_MISSING_IMAGE", file: "manuscript/01-one/02-b.md", line: 9, message: "The picture “Gone”, images/gone.png, isn't in the repository" },
      { code: "W_IMAGE_OUTSIDE", file: "manuscript/01-one/02-b.md", line: 11, message: expect.stringContaining("“Here”") },
      { code: "W_IMAGE_OUTSIDE", file: "manuscript/01-one/02-b.md", line: 11, message: expect.stringContaining("“Web”") },
    ]);
    expect(r.diagnostics).toHaveLength(3);
  });

  it("E_SCHEMA for a cover that isn't a repository path, or a focal point outside the picture", async () => {
    const r = await fixture({
      "novel.yaml": `${NOVEL}cover: /home/me/cover.jpg\n`,
      "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\nimage_focus: [0.5, 1.2]\n---\n",
    });
    expect(r.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["E_SCHEMA", "bible/characters/ada.md"],
      ["E_SCHEMA", "novel.yaml"],
    ]);
    expect(r.novel.entities.find((e) => e.id === "char_aaaaaa")?.imageFocus).toBeUndefined();
  });

  it("E_DUPLICATE_ID across files and within a file", async () => {
    const r = await fixture({ "bible/characters/cal.md": "---\nid: char_aaaaaa\nname: Cal\n---\n" });
    expect(r.diagnostics).toMatchObject([{ code: "E_DUPLICATE_ID", file: "bible/characters/cal.md" }]);
    const r2 = await fixture({ "bible/relationships.yaml": rels(
      "{id: rel_aaaaaa, from: char_aaaaaa, to: char_bbbbbb, type: sibling}",
      "{id: rel_aaaaaa, from: char_aaaaaa, to: char_bbbbbb, type: mentor}") });
    expect(only(r2.diagnostics)).toEqual(["E_DUPLICATE_ID"]);
    expect(r2.diagnostics[0]!.message).toContain("earlier in this file");
  });

  it("E_ID_PREFIX for scenes and for entities in the wrong folder", async () => {
    const r = await fixture({
      "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_aaaaaa, ch_bbbbbb, sc_cccccc]\n",
      "manuscript/01-one/02-b.md": scene("ch_bbbbbb", "B"),
      "bible/locations/ben.md": "---\nid: char_cccccc\nname: Ben\n---\n",
    });
    expect(only(r.diagnostics)).toEqual(["E_ID_PREFIX", "E_ID_PREFIX"]);
  });

  it("E_DANGLING_REF for scene fields, relationships, events and mentions (with line numbers)", async () => {
    const r = await fixture({
      "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "characters: [char_zzzzzz]\n", "Fine.\n\nThen [Zed](#char_zzzzzz) arrived.\n"),
      "bible/relationships.yaml": rels("{id: rel_aaaaaa, from: char_aaaaaa, to: char_yyyyyy, type: sibling, since: sc_xxxxxx}"),
      "bible/events.yaml": "events:\n  - {id: evt_aaaaaa, title: Flood, locations: [loc_zzzzzz]}\n",
    });
    expect(r.diagnostics.map((d) => [d.code, d.file, d.pointer ?? d.line])).toEqual([
      ["E_DANGLING_REF", "bible/events.yaml", "/events/0/locations/0"],
      ["E_DANGLING_REF", "bible/relationships.yaml", "/relationships/0/since"],
      ["E_DANGLING_REF", "bible/relationships.yaml", "/relationships/0/to"],
      ["E_DANGLING_REF", "manuscript/01-one/02-b.md", "/characters/0"],
      ["E_DANGLING_REF", "manuscript/01-one/02-b.md", 8],
    ]);
  });

  it("E_REF_TYPE when a reference names the wrong kind of record", async () => {
    const r = await fixture({
      "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "pov: loc_aaaaaa\ncharacters: [loc_aaaaaa]\nthemes: [plot_aaaaaa]\n"),
      "bible/relationships.yaml": rels("{id: rel_aaaaaa, from: char_aaaaaa, to: sc_aaaaaa, type: sibling, until: char_bbbbbb}"),
    });
    expect(only(r.diagnostics).filter((c) => c.startsWith("E_"))).toEqual(Array(5).fill("E_REF_TYPE"));
    expect(r.diagnostics.find((d) => d.pointer === "/pov")!.message).toBe("pov must be a character, but loc_aaaaaa is a location");
  });

  it("a scene's entities are entries of custom types", async () => {
    const custom = `${NOVEL}entity_types:\n  - {key: artifact, prefix: art, folder: artifacts, label: Artifact}\n`;
    const ok = await fixture({
      "novel.yaml": custom,
      "bible/artifacts/plans.md": "---\nid: art_aaaaaa\nname: Plans\n---\n",
      "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "entities: [art_aaaaaa]\n"),
    });
    expect(ok.diagnostics).toEqual([]);
    expect(ok.novel.scenes.find((s) => s.id === "sc_bbbbbb")!.entities).toEqual(["art_aaaaaa"]);

    const wrong = await fixture({ "novel.yaml": custom, "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "entities: [char_aaaaaa, art_zzzzzz]\n") });
    expect(wrong.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["E_REF_TYPE", "/entities/0"],
      ["E_DANGLING_REF", "/entities/1"],
    ]);
    expect(wrong.diagnostics[0]!.message).toBe("entities must be an entry of a custom type, but char_aaaaaa is a character");
  });

  it("E_UNKNOWN_REL_TYPE, E_REL_ENDPOINT_TYPE and E_REL_RANGE", async () => {
    const r = await fixture({ "bible/relationships.yaml": rels(
      "{id: rel_aaaaaa, from: char_aaaaaa, to: char_bbbbbb, type: enemies}",
      "{id: rel_bbbbbb, from: char_aaaaaa, to: loc_aaaaaa, type: mentor}",
      "{id: rel_cccccc, from: char_aaaaaa, to: char_bbbbbb, type: sibling, since: sc_cccccc, until: sc_bbbbbb}",
      "{id: rel_dddddd, from: char_aaaaaa, to: char_bbbbbb, type: sibling, since: sc_bbbbbb, until: sc_bbbbbb}") });
    expect(only(r.diagnostics)).toEqual(["E_UNKNOWN_REL_TYPE", "E_REL_ENDPOINT_TYPE", "E_REL_RANGE", "E_REL_RANGE"]);
  });

  it("E_ENTITY_TYPE and E_SCHEMA for bad relationship type definitions", async () => {
    const r = await fixture({ "novel.yaml": `${NOVEL}  - key: sibling\n  - key: owns\n    to_types: [artifact]\n` });
    expect(only(r.diagnostics)).toEqual(["E_SCHEMA", "E_ENTITY_TYPE"]);
  });

  it("W_FILENAME_ORDER when NN- prefixes disagree with reading order", async () => {
    const r = await fixture({ "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_bbbbbb, sc_aaaaaa, sc_cccccc]\n" });
    expect(r.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["W_FILENAME_ORDER", "manuscript/01-one/01-a.md"],
      ["W_FILENAME_ORDER", "manuscript/01-one/02-b.md"],
    ]);
    expect(r.errors).toBe(0);
  });

  it("W_HARD_WRAP, W_POV_NOT_PRESENT and W_REL_SELF", async () => {
    const r = await fixture({
      "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "pov: char_bbbbbb\n", "A wrapped\nparagraph.\n"),
      "bible/relationships.yaml": rels("{id: rel_aaaaaa, from: char_aaaaaa, to: char_aaaaaa, type: sibling}"),
    });
    expect(only(r.diagnostics)).toEqual(["W_REL_SELF", "W_POV_NOT_PRESENT", "W_HARD_WRAP"]);
    expect(r.diagnostics.find((d) => d.code === "W_HARD_WRAP")!.line).toBe(7);
    expect([r.errors, r.warnings]).toEqual([0, 3]);
  });

  it("W_LAYOUT_UNKNOWN for a placed ID that isn't in the novel; relationship type styles are checked", async () => {
    const r = await fixture({ "diagrams/layouts.yaml": "layouts:\n  relationship-graph:\n    nodes:\n      char_aaaaaa: { x: 0, y: 0 }\n      char_zzzzzz: { x: 1, y: 1 }\n" });
    expect(only(r.diagnostics)).toEqual(["W_LAYOUT_UNKNOWN"]);
    expect(r.diagnostics[0]!.pointer).toBe("/layouts/relationship-graph/nodes/char_zzzzzz");
    const styled = await fixture({ "novel.yaml": NOVEL.replace("    symmetric: true\n", "    symmetric: true\n    style: { color: danger, line: dashed }\n") });
    expect(styled.diagnostics).toEqual([]);
    // A palette slot, as the app writes it.
    const slotted = await fixture({ "novel.yaml": NOVEL.replace("    symmetric: true\n", "    symmetric: true\n    style: { color: series-7, line: dotted }\n") });
    expect(slotted.diagnostics).toEqual([]);
    const nine = await fixture({ "novel.yaml": NOVEL.replace("    symmetric: true\n", "    symmetric: true\n    style: { color: series-9 }\n") });
    expect(nine.diagnostics.length).toBeGreaterThan(0);
    const bad = await fixture({ "novel.yaml": NOVEL.replace("    symmetric: true\n", "    symmetric: true\n    style: { color: \"#ff0000\" }\n") });
    expect(only(bad.diagnostics)).toEqual(["E_SCHEMA"]);
  });

  it("accepts a plotline gap in scenes or in words, and refuses anything else", async () => {
    expect((await fixture({ "novel.yaml": `${NOVEL}plotline_gap: { scenes: 2 }\n` })).diagnostics).toEqual([]);
    expect((await fixture({ "novel.yaml": `${NOVEL}plotline_gap: { words: 4000 }\n` })).diagnostics).toEqual([]);
    expect(only((await fixture({ "novel.yaml": `${NOVEL}plotline_gap: { scenes: 2, words: 10 }\n` })).diagnostics)).toContain("E_SCHEMA");
    expect(only((await fixture({ "novel.yaml": `${NOVEL}plotline_gap: { pages: 3 }\n` })).diagnostics)).toContain("E_SCHEMA");
  });

  describe("off-page events as files (format v2, D11)", () => {
    const V2 = NOVEL.replace("schema_version: 1", "schema_version: 2");
    const event = (id: string, front = "", body = "") => `---\nid: ${id}\ntitle: Flood\n${front}---\n${body}`;

    it("loads an event file, its note as prose, and validates mentions of events", async () => {
      const r = await fixture({
        "novel.yaml": V2,
        "bible/events/flood.md": event("evt_aaaaaa", "when: {at: 2009-11-02}\ncharacters: [char_aaaaaa]\nscene: sc_bbbbbb\n", "\n[Ada](#char_aaaaaa) holds the pier.\n"),
        "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "", "After [the flood](#evt_aaaaaa).\n"),
        "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\n---\nShe remembers [the flood](#evt_aaaaaa).\n",
      });
      expect(r.diagnostics).toEqual([]);
      const [ev] = r.novel.events;
      expect(ev).toMatchObject({ id: "evt_aaaaaa", title: "Flood", when: { at: "2009-11-02" }, characters: ["char_aaaaaa"], scene: "sc_bbbbbb", file: "bible/events/flood.md", bodyLine: 8 });
      expect(ev!.body).toBe("\n[Ada](#char_aaaaaa) holds the pier.\n");
      expect(ev!.index).toBeUndefined();
    });

    it("checks an event file's references, its scene and the mentions in its note, by pointer and line", async () => {
      const r = await fixture({
        "novel.yaml": V2,
        "bible/events/flood.md": event("evt_aaaaaa", "locations: [char_aaaaaa]\nscene: char_aaaaaa\n", "\nThen [Zed](#char_zzzzzz).\n"),
      });
      expect(r.diagnostics.map((d) => [d.code, d.file, d.pointer ?? d.line])).toEqual([
        ["E_REF_TYPE", "bible/events/flood.md", "/locations/0"],
        ["E_REF_TYPE", "bible/events/flood.md", "/scene"],
        ["E_DANGLING_REF", "bible/events/flood.md", 8],
      ]);
    });

    it("an event's prefix must be evt_; a v1 events.yaml left in a v2 novel is W_EVENTS_YAML", async () => {
      const r = await fixture({
        "novel.yaml": V2,
        "bible/events/flood.md": event("sc_dddddd"),
        "bible/events.yaml": "events:\n  - {id: evt_bbbbbb, title: Leaving}\n",
      });
      expect(only(r.diagnostics)).toEqual(["W_EVENTS_YAML", "E_ID_PREFIX"]);
      expect(r.novel.events.map((e) => e.id).sort()).toEqual(["evt_bbbbbb", "sc_dddddd"]);
    });

    it("bible/events.yaml in a v1 novel is fine, its note the event's prose", async () => {
      const r = await fixture({ "bible/events.yaml": "events:\n  - {id: evt_bbbbbb, title: Leaving, note: By the night train.}\n" });
      expect(r.diagnostics).toEqual([]);
      expect(r.novel.events[0]).toMatchObject({ body: "By the night train.", index: 0, file: "bible/events.yaml" });
    });

    it("events is no custom type's folder", async () => {
      const r = await fixture({ "novel.yaml": `${V2}entity_types:\n  - {key: happening, prefix: hap, folder: events, label: Happening}\n` });
      expect(only(r.diagnostics)).toEqual(["E_ENTITY_TYPE"]);
    });
  });

  describe("notes (D12)", () => {
    const note = (id: string, front = "", body = "") => `---\nid: ${id}\ntitle: An idea\n${front}---\n${body}`;

    it("loads a note: title, tags, when it was made, what it became, its prose", async () => {
      const r = await fixture({ "notes/an-idea.md": note("note_aaaaaa", "tags: [ending]\ncreated: 2026-10-15\nbecame: sc_bbbbbb\n", "What if [Ada](#char_aaaaaa) stays?\n") });
      expect(r.diagnostics).toEqual([]);
      expect(r.novel.notes).toEqual([
        { id: "note_aaaaaa", title: "An idea", tags: ["ending"], scenes: [], pinned: [], created: "2026-10-15", became: "sc_bbbbbb", body: "What if [Ada](#char_aaaaaa) stays?\n", bodyLine: 8, file: "notes/an-idea.md" },
      ]);
    });

    it("checks a note's mentions, what it became, and its prefix", async () => {
      const r = await fixture({
        "notes/an-idea.md": note("note_aaaaaa", "became: char_aaaaaa\n", "What if [Zed](#char_zzzzzz)?\n"),
        "notes/another.md": note("evt_cccccc"),
      });
      expect(r.diagnostics.map((d) => [d.code, d.file, d.pointer ?? d.line])).toEqual([
        ["E_REF_TYPE", "notes/an-idea.md", "/became"],
        ["E_DANGLING_REF", "notes/an-idea.md", 6],
        ["E_ID_PREFIX", "notes/another.md", undefined],
      ]);
    });

    it("a note's scenes and pins name scenes; a pin outside its scenes is W_NOTE_PIN", async () => {
      const ok = await fixture({ "notes/an-idea.md": note("note_aaaaaa", "scenes: [sc_aaaaaa, sc_bbbbbb]\npinned: [sc_bbbbbb]\n") });
      expect(ok.diagnostics).toEqual([]);
      expect(ok.novel.notes[0]).toMatchObject({ scenes: ["sc_aaaaaa", "sc_bbbbbb"], pinned: ["sc_bbbbbb"] });
      const bad = await fixture({ "notes/an-idea.md": note("note_aaaaaa", "scenes: [char_aaaaaa]\npinned: [sc_cccccc]\n") });
      expect(bad.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
        ["E_REF_TYPE", "/scenes/0"],
        ["W_NOTE_PIN", "/pinned/0"],
      ]);
    });

    it("a note is never mentioned; note is no custom type's prefix", async () => {
      const r = await fixture({
        "notes/an-idea.md": note("note_aaaaaa"),
        "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "", "See [the idea](#note_aaaaaa).\n"),
        "novel.yaml": `${NOVEL}entity_types:\n  - {key: memo, prefix: note, folder: memos, label: Memo}\n`,
      });
      expect(only(r.diagnostics)).toEqual(["E_REF_TYPE", "E_ENTITY_TYPE"]);
    });
  });

  it("skips cross-reference checks for a newer schema version", async () => {
    const r = await fixture({ "novel.yaml": "schema_version: 9\nid: nv_4k8h2c\ntitle: Future\n", "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "B", "pov: char_zzzzzz\n") });
    expect(only(r.diagnostics)).toEqual(["E_SCHEMA_VERSION"]);
  });
});

describe("hardWrappedLines", () => {
  it("allows intentional breaks, lists, quotes, headings and code", () => {
    const body = [
      "One paragraph on one line.",
      "",
      "Verse with a break\\",
      "and another  ",
      "and the end.",
      "",
      "- a list",
      "- item",
      "",
      "> a quote",
      "> continued",
      "",
      "```",
      "code",
      "lines",
      "```",
    ].join("\n");
    expect(hardWrappedLines(body)).toEqual([]);
  });

  it("reports one warning per wrapped paragraph", () => {
    expect(hardWrappedLines("a\nb\nc\n\nd\ne")).toEqual([2, 6]);
  });
});

describe("rule documentation", () => {
  it("documents exactly the codes the validator can emit, with matching severities", () => {
    const spec = readFileSync(new URL("../../../docs/format/v2.md", import.meta.url), "utf8");
    const documented = Object.fromEntries(
      [...spec.matchAll(/^\| `([EW]_[A-Z_]+)` \|/gm)].map((m) => [m[1]!, m[1]!.startsWith("E_") ? "error" : "warning"]),
    );
    expect(documented).toEqual(RULES);
  });

  it("every code used in the source is a known rule", () => {
    const sources = ["load.ts", "schemas.ts", "parse.ts", "validate.ts"].map((f) =>
      readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"));
    const used = new Set(sources.flatMap((s) => [...s.matchAll(/"([EW]_[A-Z_]+)"/g)].map((m) => m[1]!)));
    for (const code of used) expect(RULES).toHaveProperty(code);
  });
});
