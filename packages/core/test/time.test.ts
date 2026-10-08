import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { durationMs, loadNovel, memorySource, overlaps, storyInstant, storyTimeline, validate } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const SAMPLE = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));
const H = 3_600_000;

describe("story time", () => {
  it("reads ISO durations", () => {
    expect(durationMs("PT45M")).toBe(45 * 60_000);
    expect(durationMs("P3D")).toBe(72 * H);
    expect(durationMs("P1Y2M")).toBe((365 + 60) * 24 * H);
    expect(durationMs("PT1.5S")).toBe(1500);
    expect(durationMs("3 days")).toBeUndefined();
  });

  it("places dates as given and relative days through the calendar, or on their own scale without one", () => {
    expect(storyInstant({ at: "2009-11-02T23:00" }, "PT2H", undefined)).toEqual({ start: Date.UTC(2009, 10, 2, 23), end: Date.UTC(2009, 10, 3, 1), dated: true });
    expect(storyInstant({ at: "2009-11-02" }, undefined, undefined)).toMatchObject({ start: Date.UTC(2009, 10, 2), dated: true });
    // Day 1 is calendar.start.
    expect(storyInstant({ day: 3, time: "18:30" }, undefined, "2024-03-01")).toMatchObject({ start: Date.UTC(2024, 2, 3, 18, 30), dated: true });
    expect(storyInstant({ day: -5 }, undefined, "2024-03-01")).toMatchObject({ start: Date.UTC(2024, 1, 24), dated: true });
    expect(storyInstant({ day: 2, time: "06:00" }, "PT1H", undefined)).toEqual({ start: 30 * H, end: 31 * H, dated: false });
    expect(storyInstant(undefined, "PT1H", undefined)).toBeUndefined();
  });

  it("orders the sample's scenes and events by story time: the flashback first", async () => {
    const novel = await loadNovel(nodeSource(SAMPLE));
    const t = storyTimeline(novel);
    const titles = t.items.map((i) => (i.kind === "scene" ? i.scene.title : `[${i.event.title}]`));
    expect(titles).toEqual([
      "[The flood of '09]",
      "The Flood",
      "[Ada leaves for the polytechnic]",
      "[The plans are stolen]",
      "The Station",
      "Walking the Span",
      "Tomas's Workshop",
      "Ben's Ledger",
      "The Betrayal",
      "Mirela's Offer",
      "The Last Rivet",
    ]);
    expect(t.undatedScenes).toEqual([]);
    expect(overlaps(t)).toEqual([]);
  });
});

describe("W_TIME_OVERLAP", () => {
  const NOVEL = "schema_version: 1\nid: nv_4k8h2c\ntitle: Fixture\ncalendar:\n  start: 2024-03-01\n";
  const scene = (id: string, title: string, fm: string) => `---\nid: ${id}\ntitle: ${title}\n${fm}---\nProse.\n`;
  const files = (b: string, events = "events: []\n") => ({
    "novel.yaml": NOVEL,
    "manuscript/_order.yaml": "chapters: [ch_aaaaaa]\n",
    "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_aaaaaa, sc_bbbbbb]\n",
    "manuscript/01-one/01-a.md": scene("sc_aaaaaa", "On the Bridge", "characters: [char_aaaaaa]\nlocations: [loc_aaaaaa]\nwhen: { day: 2, time: \"10:00\" }\nduration: PT2H\n"),
    "manuscript/01-one/02-b.md": scene("sc_bbbbbb", "At the Station", b),
    "bible/characters/ada.md": "---\nid: char_aaaaaa\nname: Ada\n---\n",
    "bible/locations/bridge.md": "---\nid: loc_aaaaaa\nname: The Bridge\n---\n",
    "bible/locations/station.md": "---\nid: loc_bbbbbb\nname: The Station\n---\n",
    "bible/events.yaml": events,
  });
  const codes = async (f: Record<string, string>) => (await validate(memorySource(f))).diagnostics;

  it("names both scenes when a character is in two places at once", async () => {
    const d = await codes(files('pov: char_aaaaaa\ncharacters: [char_aaaaaa]\nlocations: [loc_bbbbbb]\nwhen: { day: 2, time: "11:00" }\n'));
    expect(d.map((x) => [x.code, x.message])).toEqual([["W_TIME_OVERLAP", "Ada is at The Bridge in “On the Bridge” and at The Station in “At the Station” at the same time"]]);
  });

  it("and an off-page event; but not after the first ends, in the same place, or without places", async () => {
    const event = "events:\n  - id: evt_aaaaaa\n    title: The meeting\n    when: { day: 2, time: \"11:30\" }\n    characters: [char_aaaaaa]\n    locations: [loc_bbbbbb]\n";
    expect((await codes(files("characters: []\n", event))).map((x) => x.message)).toEqual(["Ada is at The Bridge in “On the Bridge” and at The Station in the event “The meeting” at the same time"]);
    expect(await codes(files('characters: [char_aaaaaa]\nlocations: [loc_bbbbbb]\nwhen: { day: 2, time: "12:00" }\n'))).toEqual([]);
    expect(await codes(files('characters: [char_aaaaaa]\nlocations: [loc_aaaaaa]\nwhen: { day: 2, time: "11:00" }\n'))).toEqual([]);
    expect(await codes(files('characters: [char_aaaaaa]\nwhen: { day: 2, time: "11:00" }\n'))).toEqual([]);
  });
});
