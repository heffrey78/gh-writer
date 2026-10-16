import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apartInTime, dayOneFor, durationMs, loadNovel, memorySource, overlaps, sceneNeighbours, storyInstant, storyTimeline, validate } from "../src/index.ts";
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

  it("finds Day 1 from a day and its date, and the days that can't be placed among dates without it (#239)", async () => {
    expect(dayOneFor("2026-10-12", 3)).toBe("2026-10-10");
    expect(dayOneFor("2026-10-10", 1)).toBe("2026-10-10");
    expect(dayOneFor("2026-07-01", -100)).toBe("2026-10-10");
    expect(dayOneFor("2024-03-01T18:30", 0)).toBe("2024-03-02");

    // The owner's book: 16 Oct 1999, 10 Oct 2026 and Day -100.
    const files = (calendar: string) => ({
      "novel.yaml": `schema_version: 2\nid: nv_aaaaaa\ntitle: T\n${calendar}`,
      "manuscript/_order.yaml": "chapters: [ch_aaaaaa]\n",
      "manuscript/01-one/_chapter.yaml": "id: ch_aaaaaa\nscenes: [sc_0pen1n]\n",
      "manuscript/01-one/01-opening.md": "---\nid: sc_0pen1n\ntitle: Opening\nwhen:\n  at: 2026-10-10\n---\nText.\n",
      "bible/events/backstory.md": "---\nid: evt_back99\ntitle: Backstory\nwhen:\n  at: 1999-10-16\n---\n",
      "bible/events/before.md": "---\nid: evt_bef0re\ntitle: Before\nwhen:\n  day: -100\n---\n",
    });
    const order = (t: ReturnType<typeof storyTimeline>) => t.items.map((i) => (i.kind === "scene" ? i.scene.title : i.event.title));
    const apart = storyTimeline(await loadNovel(memorySource(files(""))));
    expect(order(apart)).toEqual(["Backstory", "Opening", "Before"]);
    expect(apartInTime(apart).map((i) => (i.kind === "event" ? i.event.title : ""))).toEqual(["Before"]);
    const together = storyTimeline(await loadNovel(memorySource(files("calendar:\n  start: 2026-10-10\n"))));
    expect(order(together)).toEqual(["Backstory", "Before", "Opening"]);
    expect(storyInstant({ day: -100 }, undefined, "2026-10-10")?.start).toBe(Date.UTC(2026, 6, 1));
    expect(apartInTime(together)).toEqual([]);
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

  it("finds the scenes either side of an event in story time", async () => {
    const t = storyTimeline(await loadNovel(nodeSource(SAMPLE)));
    const titles = (id: string) => {
      const { before, after } = sceneNeighbours(t, id);
      return [before?.title, after?.title];
    };
    expect(titles("evt_9ab3kd")).toEqual([undefined, "The Flood"]);
    expect(titles("evt_1eave5")).toEqual(["The Flood", "The Station"]);
    expect(titles("evt_p1an5t")).toEqual(["The Flood", "The Station"]);
    expect(titles("evt_zzzzzz")).toEqual([undefined, undefined]);
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
