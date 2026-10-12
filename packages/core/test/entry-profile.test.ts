import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadNovel, locationProfile, plotlineProfile, themeProfile } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));
const tally = (t: { name: string; scenes: number }[]) => t.map((v) => `${v.name}: ${v.scenes}`);

describe("profiles by type", () => {
  it("a location: who comes there, its scenes and the story time they span", () => {
    const bridge = locationProfile(novel, "loc_br1dg3");
    expect(tally(bridge.visitors)).toEqual(["Ada Varn: 4", "Ben Varn: 4", "Tomas Hale: 2"]);
    expect(bridge.scenes.map((s) => s.title)).toEqual(["Walking the Span", "The Betrayal", "The Flood", "The Last Rivet"]);
    // The flashback's date to the last scene, through the calendar.
    expect(bridge.span).toEqual({ from: "2 Nov 2009, 23:00", to: "Day 5, 06:00 (5 Mar 2024)" });
    expect(locationProfile(novel, "loc_5tat10").span).toEqual({ from: "Day 1, 09:10 (1 Mar 2024)", to: "Day 1, 09:10 (1 Mar 2024)" });
  });

  it("a plotline: its beats in order, the beats not yet written, the scenes it skips, who and where", () => {
    const sale = plotlineProfile(novel, "plot_h315tz");
    expect(sale.beats.map((b) => [b.scene.title, b.weight, b.beat ?? null])).toEqual([
      ["The Station", "minor", "First sign of the sale"],
      ["Walking the Span", "major", null],
      ["Tomas's Workshop", "major", null],
      ["The Betrayal", "major", "The plans have been sold"],
      ["Mirela's Offer", "major", null],
      ["The Last Rivet", "major", "The sale stalls"],
    ]);
    expect(sale.skips.map((s) => s.title)).toEqual(["Ben's Ledger", "The Flood"]);
    expect(tally(sale.who)).toEqual(["Ada Varn: 6", "Ben Varn: 3", "Tomas Hale: 2", "Mirela Kost: 1"]);
    expect(tally(sale.where)).toEqual(["The Varn Bridge: 3", "Tomas's Workshop: 2", "Varn Station: 1"]);
    expect(sale.quiet).toEqual([]);
    // Each beat knows its place in the scene's list, to write it there.
    expect(plotlineProfile(novel, "plot_gr1efa").beats.find((b) => b.scene.title === "Walking the Span")?.index).toBe(1);
  });

  it("a plotline that goes quiet, and one in no scene", async () => {
    const { memorySource } = await import("../src/index.ts");
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
    const files: Record<string, string> = Object.fromEntries(
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => [relative(root, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
    );
    // The Sale only at the station and the last rivet: quiet for the six between.
    for (const [path, text] of Object.entries(files)) {
      if (!path.startsWith("manuscript/") || /01-the-station|02-the-last-rivet/.test(path)) continue;
      files[path] = text.replace(/^  - plot_h315tz\n/m, "").replace(/^  - id: plot_h315tz\n(    .*\n)*/m, "");
    }
    const book = await loadNovel(memorySource(files));
    const sale = plotlineProfile(book, "plot_h315tz");
    expect(sale.beats.map((b) => b.scene.title)).toEqual(["The Station", "The Last Rivet"]);
    expect(sale.quiet).toMatchObject([{ scenes: 6, open: false }]);
    expect(plotlineProfile(book, "plot_nope00")).toMatchObject({ beats: [], skips: [], who: [], where: [], quiet: [] });
  });

  it("a theme: its strength in each scene", () => {
    expect(themeProfile(novel, "theme_1nher1").strengths.map((s) => s.strength).join("")).toBe("10202203");
    expect(themeProfile(novel, "theme_trvst5").strengths.map((s) => s.strength).join("")).toBe("02033022");
  });
});
