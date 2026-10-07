import { editFrontMatter, readFrontMatter } from "@gh-writer/core";
import { describe, expect, it } from "vitest";
import { entryEdits, plotlineEdits, type EntryChange, type PlotlineChange, type SceneList } from "../src/novel/plotline-edits.ts";

const FILE = "---\nid: sc_aaaaaa\ntitle: A\nplotlines:\n  - id: plot_aaaaaa\n    weight: minor # quiet\n    beat: First sign\n  - plot_bbbbbb\nstatus: drafted\n---\nProse.\n";
const apply = (text: string, plotline: string, change: PlotlineChange) => editFrontMatter(text, plotlineEdits(readFrontMatter(text)!, plotline, change));
const changed = (a: string, b: string) => [b.split("\n").filter((l) => !a.split("\n").includes(l)), a.split("\n").filter((l) => !b.split("\n").includes(l))];

describe("plotline edits", () => {
  it("links a plotline by appending its bare ID, and unlinks by taking out its lines", () => {
    const linked = apply(FILE, "plot_cccccc", { link: true });
    expect(changed(FILE, linked)).toEqual([["  - plot_cccccc"], []]);
    expect(apply(linked, "plot_cccccc", { remove: true })).toBe(FILE);
    expect(apply(FILE, "plot_aaaaaa", { remove: true })).toBe("---\nid: sc_aaaaaa\ntitle: A\nplotlines:\n  - plot_bbbbbb\nstatus: drafted\n---\nProse.\n");
    expect(apply(FILE, "plot_aaaaaa", { link: true })).toBe(FILE);
  });

  it("sets weight and beat in place, turning a bare ID into a map, and drops defaults", () => {
    expect(changed(FILE, apply(FILE, "plot_aaaaaa", { weight: "major" }))).toEqual([[], ["    weight: minor # quiet"]]);
    expect(changed(FILE, apply(FILE, "plot_aaaaaa", { beat: "The flags" }))).toEqual([["    beat: The flags"], ["    beat: First sign"]]);
    expect(changed(FILE, apply(FILE, "plot_bbbbbb", { weight: "minor" }))).toEqual([["  - id: plot_bbbbbb", "    weight: minor"], ["  - plot_bbbbbb"]]);
    expect(apply(FILE, "plot_bbbbbb", { weight: "major" })).toBe(FILE);
    expect(changed(FILE, apply(FILE, "plot_aaaaaa", { beat: "  " }))).toEqual([[], ["    beat: First sign"]]);
  });

  it("starts the list on a scene with none", () => {
    const bare = "---\nid: sc_aaaaaa\ntitle: A\n---\n";
    expect(readFrontMatter(apply(bare, "plot_aaaaaa", { link: true }))?.plotlines).toEqual(["plot_aaaaaa"]);
  });
});

describe("entry edits, for every scene list", () => {
  const SCENE = "---\nid: sc_aaaaaa\ntitle: A\npov: char_aaaaaa\ncharacters: [char_aaaaaa, char_bbbbbb]\nlocations: [loc_aaaaaa]\nthemes:\n  - id: theme_aaaaaa\n    strength: 3\n  - theme_bbbbbb\n---\nProse.\n";
  const run = (list: SceneList, id: string, change: EntryChange) => editFrontMatter(SCENE, entryEdits(readFrontMatter(SCENE)!, list, id, change));

  it("adds to and removes from a flow list on its own line, keeping its style", () => {
    expect(run("characters", "char_cccccc", { add: true })).toBe(SCENE.replace("characters: [char_aaaaaa, char_bbbbbb]", "characters: [char_aaaaaa, char_bbbbbb, char_cccccc]"));
    expect(run("characters", "char_bbbbbb", { remove: true })).toBe(SCENE.replace("characters: [char_aaaaaa, char_bbbbbb]", "characters: [char_aaaaaa]"));
    expect(run("locations", "loc_aaaaaa", { remove: true })).toBe(SCENE.replace("locations: [loc_aaaaaa]", "locations: []"));
    expect(run("characters", "char_aaaaaa", { add: true })).toBe(SCENE);
  });

  it("sets and clears a theme's strength, on a map or a bare ID", () => {
    expect(run("themes", "theme_aaaaaa", { field: "strength", value: 1 })).toBe(SCENE.replace("    strength: 3", "    strength: 1"));
    expect(run("themes", "theme_aaaaaa", { field: "strength", value: undefined })).toBe(SCENE.replace("\n    strength: 3", ""));
    expect(run("themes", "theme_bbbbbb", { field: "strength", value: 2 })).toBe(SCENE.replace("  - theme_bbbbbb", "  - id: theme_bbbbbb\n    strength: 2"));
  });
});
