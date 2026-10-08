import { fileURLToPath } from "node:url";
import { loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { describe, expect, it } from "vitest";
import { itemTitle, jump, lanesOf, timeline, when } from "../src/timeline/timeline-model.ts";

const novel = await loadNovel(nodeSource(fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url))));
const H = 3_600_000;

describe("the timeline", () => {
  it("marks The Flood as a flashback: first in story time, sixth in the book", () => {
    const t = timeline(novel, "pov");
    expect([...t.flashbacks]).toEqual(["sc_f100d0"]);
    expect(t.storyRank.get("sc_f100d0")).toBe(1);
    expect(novel.scenes.findIndex((s) => s.id === "sc_f100d0")).toBe(5);
  });

  it("puts items in lanes by point of view (events off page), plotline or location", () => {
    expect(timeline(novel, "pov").lanes.map((l) => l.name)).toEqual(["Ben Varn", "Ada Varn", "Off page"]);
    const byPlace = timeline(novel, "location");
    expect(byPlace.lanes[0]!.name).toBe("The Varn Bridge");
    const flood = byPlace.items.find((i) => itemTitle(i) === "The flood of '09")!;
    expect(lanesOf(flood, "location")).toEqual(["loc_br1dg3"]);
    expect(lanesOf(flood, "pov")).toEqual(["(off page)"]);
  });

  it("says how far apart things are, and when they happen", () => {
    const at = (start: number) => ({ start, end: start, dated: true });
    expect(jump(at(0), at(0))).toBe("same time");
    expect(jump(at(0), at(3 * H))).toBe("3 hours later");
    expect(jump(at(0), at(96 * H))).toBe("4 days later");
    expect(jump(at(0), at(14 * 365.25 * 24 * H))).toBe("14 years later");
    expect(jump(at(0), { start: 5, end: 5, dated: false })).toBe("");
    const t = timeline(novel, "pov");
    expect(when(t.items.find((i) => itemTitle(i) === "The Betrayal")!)).toBe("Day 3, 18:30 (3 Mar 2024)");
    expect(when(t.items.find((i) => itemTitle(i) === "The Flood")!)).toBe("2 Nov 2009, 23:00");
  });
});
