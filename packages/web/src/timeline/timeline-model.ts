import { storyTimeline, type Novel, type StoryInstant, type TimelineItem } from "@gh-writer/core";

export type LaneMode = "pov" | "plotline" | "location";

export interface Lane {
  id: string;
  name: string;
}

export const itemId = (i: TimelineItem) => (i.kind === "scene" ? i.scene.id : i.event.id);
export const itemTitle = (i: TimelineItem) => (i.kind === "scene" ? i.scene.title : i.event.title);

/** The lanes an item runs in: its point of view, plotlines or locations; none of them, the "none" lane. Events have no point of view: "off page". */
export function lanesOf(i: TimelineItem, mode: LaneMode): string[] {
  if (mode === "pov") return i.kind === "scene" ? [i.scene.pov ?? NONE] : [OFF_PAGE];
  const ids = mode === "plotline" ? (i.kind === "scene" ? i.scene.plotlines.map((p) => p.id) : (i.event.plotlines ?? [])) : i.kind === "scene" ? i.scene.locations : (i.event.locations ?? []);
  return ids.length ? ids : [NONE];
}

export const NONE = "(none)";
export const OFF_PAGE = "(off page)";

const DAY = 86_400_000;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** How far apart two moments in story time are, in words: "same time", "3 hours later", "4 days later", "14 years later". */
export function jump(from: StoryInstant, to: StoryInstant): string {
  if (from.dated !== to.dated) return "";
  const ms = to.start - from.start;
  if (ms <= 0) return "same time";
  const hours = Math.round(ms / 3_600_000);
  if (ms < DAY) return hours < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min later` : `${plural(hours, "hour")} later`;
  const days = Math.round(ms / DAY);
  if (days < 60) return `${plural(days, "day")} later`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${plural(months, "month")} later`;
  return `${plural(Math.round(days / 365.25), "year")} later`;
}

/** When, in words: a date (and time), or "Day 3, 18:30" (with its date when the calendar gives one). */
export function when(i: TimelineItem): string {
  const w = i.kind === "scene" ? i.scene.when : i.event.when;
  const date = new Date(i.at.start);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  if (w && "day" in w) return `Day ${w.day}${w.time ? `, ${w.time}` : ""}${i.at.dated ? ` (${day})` : ""}`;
  return w && "at" in w && w.at.length > 10 ? `${day}, ${time}` : day;
}

export interface Timeline {
  items: TimelineItem[];
  /** Each item's place in story-time order, by ID. */
  storyRank: Map<string, number>;
  /** Scenes read after a scene that happens later: early in story time, late in the book. */
  flashbacks: Set<string>;
  undated: ReturnType<typeof storyTimeline>["undatedScenes"];
  undatedEvents: ReturnType<typeof storyTimeline>["undatedEvents"];
  lanes: Lane[];
}

/** The book's timeline, with lanes for `mode`: in order of first appearance, "none" and "off page" last. */
export function timeline(novel: Novel, mode: LaneMode): Timeline {
  const t = storyTimeline(novel);
  const storyRank = new Map(t.items.map((i, k) => [itemId(i), k]));
  // A flashback: some scene read before it happens after it.
  const flashbacks = new Set<string>();
  let latest = -1;
  for (const scene of novel.scenes) {
    const rank = storyRank.get(scene.id);
    if (rank === undefined) continue;
    if (rank < latest) flashbacks.add(scene.id);
    latest = Math.max(latest, rank);
  }
  const seen: string[] = [];
  for (const i of t.items) for (const l of lanesOf(i, mode)) if (!seen.includes(l)) seen.push(l);
  const special = [NONE, OFF_PAGE];
  const ordered = [...seen.filter((l) => !special.includes(l)), ...special.filter((l) => seen.includes(l))];
  const name = (id: string) => (id === NONE ? (mode === "pov" ? "No point of view" : mode === "plotline" ? "No plotline" : "No location") : id === OFF_PAGE ? "Off page" : (novel.entities.find((e) => e.id === id)?.name ?? id));
  return { items: t.items, storyRank, flashbacks, undated: t.undatedScenes, undatedEvents: t.undatedEvents, lanes: ordered.map((id) => ({ id, name: name(id) })) };
}
