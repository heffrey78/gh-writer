import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSchema, type SchemaKind } from "../src/schemas.ts";
import { ID_PATTERN, newId } from "../src/ids.ts";

const codes = (kind: SchemaKind, data: unknown) => checkSchema(kind, data).map((d) => d.code);

describe("schemas", () => {
  const valid: [SchemaKind, unknown][] = [
    ["novel", { schema_version: 1, id: "nv_4k8h2c", title: "T" }],
    ["manuscript-order", { chapters: [] }],
    ["part", { id: "pt_1a2b3c", title: "Act One", chapters: ["ch_7g8h9j"] }],
    ["chapter", { id: "ch_7g8h9j", scenes: [] }],
    ["scene", {
      id: "sc_0d9wm4", title: "The Bridge", status: "drafted",
      plotlines: ["plot_h315tz", { id: "plot_gr1efa", weight: "minor" }],
      themes: [{ id: "theme_trvst5", strength: 2 }],
      when: { day: 3, time: "18:30" }, duration: "PT45M",
    }],
    ["scene", { id: "sc_0d9wm4", title: "x", when: { at: "2024-03-01T18:30" } }],
    ["entity", { id: "char_7f3k2q", name: "Ada", fields: { age: 34, alive: true } }],
    ["relationships", { relationships: [{ id: "rel_q2m9xa", from: "char_7f3k2q", to: "char_b3n0vs", type: "sibling" }] }],
    ["events", { events: [{ id: "evt_9ab3kd", title: "Flood", when: { at: "2009-11-02" }, duration: "P3D" }] }],
    ["layouts", { layouts: { "relationship-graph": { nodes: { char_7f3k2q: { x: 1, y: 2 } } } } }],
  ];

  it.each(valid)("accepts a valid %s", (kind, data) => {
    expect(checkSchema(kind, data)).toEqual([]);
  });

  it("reports a missing required field", () => {
    const [d] = checkSchema("scene", { id: "sc_0d9wm4" }, "manuscript/x.md");
    expect(d).toMatchObject({ code: "E_SCHEMA", severity: "error", file: "manuscript/x.md" });
    expect(d!.message).toContain('"title"');
  });

  it("rejects malformed IDs, including the excluded letters i l o u", () => {
    for (const id of ["sc_0d9wm", "SC_0d9wm4", "sc_0d9wmi", "sc_0d9wmo", "s_0d9wm4"]) {
      expect(codes("chapter", { id: "ch_7g8h9j", scenes: [id] })).toEqual(["E_SCHEMA"]);
    }
  });

  it("rejects bad enums, story times and durations", () => {
    expect(codes("scene", { id: "sc_0d9wm4", title: "x", status: "done" })).toEqual(["E_SCHEMA"]);
    expect(codes("scene", { id: "sc_0d9wm4", title: "x", when: { day: 3, time: "25:00" } })).toEqual(["E_SCHEMA"]);
    expect(codes("scene", { id: "sc_0d9wm4", title: "x", when: { at: "March 3" } })).toEqual(["E_SCHEMA"]);
    expect(codes("scene", { id: "sc_0d9wm4", title: "x", duration: "45 minutes" })).toEqual(["E_SCHEMA"]);
    expect(codes("scene", { id: "sc_0d9wm4", title: "x", duration: "P" })).toEqual(["E_SCHEMA"]);
  });

  it("reports unknown fields as warnings, including inside nested objects", () => {
    const ds = checkSchema("scene", {
      id: "sc_0d9wm4", title: "x", povv: "char_7f3k2q",
      plotlines: [{ id: "plot_h315tz", wieght: "minor" }],
      when: { day: 1, tiem: "10:00" },
    });
    expect(ds.map((d) => [d.code, d.pointer])).toEqual([
      ["W_UNKNOWN_KEY", "/povv"],
      ["W_UNKNOWN_KEY", "/plotlines/0/wieght"],
      ["W_UNKNOWN_KEY", "/when/tiem"],
    ]);
  });

  it("requires exactly one of parts or chapters in the manuscript order", () => {
    expect(codes("manuscript-order", {})).toEqual(["E_SCHEMA"]);
    expect(codes("manuscript-order", { parts: [], chapters: [] })).toEqual(["E_SCHEMA"]);
  });

  it("rejects a since reference that is not an ID", () => {
    const data = { relationships: [{ id: "rel_q2m9xa", from: "char_7f3k2q", to: "char_b3n0vs", type: "rival", since: "the bridge" }] };
    const [d] = checkSchema("relationships", data);
    expect(d).toMatchObject({ code: "E_SCHEMA", pointer: "/relationships/0/since" });
  });
});

describe("format spec examples", () => {
  const spec = readFileSync(new URL("../../../docs/format/v1.md", import.meta.url), "utf8");

  /** Fenced yaml/markdown blocks under the "## ..." heading that starts with `heading`. */
  function blocks(heading: string): string[] {
    const section = spec.split(/^## /m).find((s) => s.startsWith(heading));
    if (!section) throw new Error(`No section ${heading}`);
    return [...section.matchAll(/```(yaml|markdown)\n([\s\S]*?)```/g)].map((m) =>
      m[1] === "markdown" ? m[2]!.split(/^---$/m)[1]! : m[2]!,
    );
  }

  const cases: [string, SchemaKind[]][] = [
    ["`novel.yaml`", ["novel"]],
    ["Order files", ["manuscript-order", "manuscript-order", "part", "chapter"]],
    ["Scenes", ["scene"]],
    ["Bible entries", ["entity"]],
    ["`bible/relationships.yaml`", ["relationships"]],
    ["`bible/events.yaml`", ["events"]],
    ["`diagrams/layouts.yaml`", ["layouts"]],
  ];

  it.each(cases)("examples under %s are valid", (heading, kinds) => {
    const found = blocks(heading);
    expect(found).toHaveLength(kinds.length);
    found.forEach((text, i) => expect(checkSchema(kinds[i]!, parse(text))).toEqual([]));
  });
});

describe("ids", () => {
  it("generates well-formed IDs", () => {
    for (let i = 0; i < 200; i++) expect(newId("char")).toMatch(ID_PATTERN);
  });

  it("rejects invalid prefixes", () => {
    expect(() => newId("Char")).toThrow();
    expect(() => newId("c")).toThrow();
  });
});
