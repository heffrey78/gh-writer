import { fileURLToPath } from "node:url";
import { loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { describe, expect, it } from "vitest";
import { cellKey, swimlanes } from "../src/swimlanes/swimlane-model.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));

describe("swimlanes", () => {
  it("lays plotlines in order of first appearance against every scene in reading order, grouped by chapter and part", () => {
    const s = swimlanes(novel);
    expect(s.lanes.map((l) => l.name)).toEqual(["The Sale", "Ben's Debt"]);
    expect(s.scenes.map((x) => x.id)).toEqual(novel.scenes.map((x) => x.id));
    expect(s.chapters.map((c) => [c.title, c.span])).toEqual([["Arrival", 2], ["Old Debts", 2], ["Night Crossing", 2], ["Varn Holds", 2]]);
    expect(s.parts.map((p) => [p.part.title, p.span])).toEqual([["Return", 4], ["The Sale", 4]]);
  });

  it("marks each scene's plotlines with their weight and beat, exactly as in the scenes", () => {
    const s = swimlanes(novel);
    expect(s.marks.get(cellKey("plot_h315tz", "sc_0d9wm4"))).toEqual({ weight: "major", beat: "The plans have been sold" });
    expect(s.marks.get(cellKey("plot_gr1efa", "sc_1edger"))).toEqual({ weight: "major" });
    expect(s.marks.has(cellKey("plot_gr1efa", "sc_5tat1n"))).toBe(false);
    const total = novel.scenes.reduce((n, scene) => n + scene.plotlines.length, 0);
    expect(s.marks.size).toBe(total);
  });
});
