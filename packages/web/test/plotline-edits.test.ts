import { editFrontMatter, readFrontMatter } from "@gh-writer/core";
import { describe, expect, it } from "vitest";
import { plotlineEdits, type PlotlineChange } from "../src/novel/plotline-edits.ts";

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
