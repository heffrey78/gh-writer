import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGACY_COLOURS, nextSeriesSlot, relationshipStyle, SERIES, seriesHex, seriesSlot } from "../src/index.ts";
import type { RelationshipTypeFile } from "../src/index.ts";

const types = (...list: RelationshipTypeFile[]) => ({ relationshipTypes: list });

describe("relationship colours", () => {
  it("are the chart palette's eight slots, with the web app's CSS in step", () => {
    expect(SERIES.map((s) => s.slot)).toEqual(["series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "series-8"]);
    const css = readFileSync(fileURLToPath(new URL("../../web/src/styles.css", import.meta.url)), "utf8");
    const values = (slot: string) => [...css.matchAll(new RegExp(`--ghw-${slot}: (#[0-9a-f]{6});`, "g"))].map((m) => m[1]);
    // Light, then dark under the media query and under the dark theme.
    for (const s of SERIES) expect(values(s.slot)).toEqual([s.light, s.dark, s.dark]);
  });

  it("read the older colour names as their nearest slot, and nothing else", () => {
    expect(seriesSlot("series-3")).toBe("series-3");
    expect(seriesSlot("danger")).toBe("series-8");
    expect(seriesSlot("ok")).toBe("series-6");
    expect(seriesSlot("accent")).toBe("series-1");
    expect(seriesSlot("#ff0000")).toBeUndefined();
    expect(seriesSlot(undefined)).toBeUndefined();
    expect(Object.keys(LEGACY_COLOURS).sort()).toEqual(["accent", "danger", "ink", "muted", "ok", "warn"]);
  });

  it("draw a type in its colour and line, or by its place in the list without one", () => {
    const novel = types({ key: "sibling" }, { key: "allies", style: { color: "ok" } }, { key: "rivals", style: { color: "series-2", line: "dashed" } });
    expect(relationshipStyle(novel, "sibling")).toEqual({ slot: "series-1", line: "solid" });
    expect(relationshipStyle(novel, "allies")).toEqual({ slot: "series-6", line: "solid" });
    expect(relationshipStyle(novel, "rivals")).toEqual({ slot: "series-2", line: "dashed" });
    expect(relationshipStyle(novel, "unknown")).toEqual({ slot: "series-1", line: "solid" });
    expect(seriesHex("series-8")).toBe("#e34948");
    expect(seriesHex("series-8", "dark")).toBe("#e66767");
  });

  it("give a new type the first colour no type uses, then the least used", () => {
    expect(nextSeriesSlot(types())).toBe("series-1");
    // sibling takes series-1 by its place; allies is green; rivals orange.
    expect(nextSeriesSlot(types({ key: "sibling" }, { key: "allies", style: { color: "ok" } }, { key: "rivals", style: { color: "series-2" } }))).toBe("series-3");
    const all = SERIES.map((s, i) => ({ key: `t${i}`, style: { color: s.slot } }));
    expect(nextSeriesSlot(types(...all, { key: "extra", style: { color: "series-1" } }))).toBe("series-2");
  });
});
