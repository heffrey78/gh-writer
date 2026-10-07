import { fileURLToPath } from "node:url";
import { loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { describe, expect, it } from "vitest";
import { cellKey, gaps, swimlanes, zoomed } from "../src/swimlanes/swimlane-model.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));

describe("swimlanes", () => {
  it("lays plotlines, by name, against every scene in reading order, grouped by chapter and part", () => {
    const s = swimlanes(novel);
    expect(s.lanes.map((l) => l.name)).toEqual(["Ben's Debt", "The Sale"]);
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

describe("gaps and zoom", () => {
  const book = swimlanes(novel);
  it("finds stretches longer than the threshold between beats, and after the last one to the end", () => {
    // The Sale: The Station, Span, Workshop, Betrayal, Offer, Rivet; quiet only for Ben's Ledger (1) and The Flood (1).
    // Ben's Debt: Span, Ledger, Betrayal, Flood, Rivet; quiet for Workshop (1), Offer (1).
    expect(gaps(book, { scenes: 1 })).toEqual([]);
    expect(gaps(book, { scenes: 0 }).map((g) => [g.lane, g.from, g.to, g.scenes, g.open])).toEqual([
      ["plot_gr1efa", "sc_w0rk5h", "sc_w0rk5h", 1, false],
      ["plot_gr1efa", "sc_0ffer5", "sc_0ffer5", 1, false],
      ["plot_h315tz", "sc_1edger", "sc_1edger", 1, false],
      ["plot_h315tz", "sc_f100d0", "sc_f100d0", 1, false],
    ]);
  });

  it("counts words when asked, and reports a thread that's never picked up again", () => {
    const ledgerWords = gaps(book, { scenes: 0 }).find((g) => g.from === "sc_1edger")!.words;
    expect(gaps(book, { words: ledgerWords }).some((g) => g.from === "sc_1edger")).toBe(false);
    expect(gaps(book, { words: ledgerWords - 1 }).some((g) => g.from === "sc_1edger")).toBe(true);
    // The first four scenes alone: The Sale's last beat is Tomas's Workshop, and Ben's Ledger follows without it.
    const early = gaps(swimlanes(novel, novel.scenes.slice(0, 4)), { scenes: 0 });
    expect(early.find((g) => g.lane === "plot_h315tz")).toMatchObject({ from: "sc_1edger", to: "sc_1edger", scenes: 1, open: true });
  });

  it("zooms to a part or a chapter", () => {
    expect(zoomed(novel, novel.scenes, "pt_5a1e00").map((s) => s.title)).toEqual(["The Betrayal", "The Flood", "Mirela's Offer", "The Last Rivet"]);
    expect(zoomed(novel, novel.scenes, "ch_arr1va").map((s) => s.title)).toEqual(["The Station", "Walking the Span"]);
    expect(zoomed(novel, novel.scenes, undefined)).toHaveLength(8);
    expect(zoomed(novel, novel.scenes, "ch_gone00")).toHaveLength(8);
  });
});
