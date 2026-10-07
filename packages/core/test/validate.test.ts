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
    const bad = await fixture({ "novel.yaml": NOVEL.replace("    symmetric: true\n", "    symmetric: true\n    style: { color: \"#ff0000\" }\n") });
    expect(only(bad.diagnostics)).toEqual(["E_SCHEMA"]);
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
    const spec = readFileSync(new URL("../../../docs/format/v1.md", import.meta.url), "utf8");
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
