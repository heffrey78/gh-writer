import type { Novel, Scene, StoryEvent } from "./model.ts";
import type { StoryTime } from "./types.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Where something sits in story time, in milliseconds. `dated` instants are real dates (an `at`, or a
 * relative day placed through calendar.start); relative days without a calendar are on their own
 * scale (day 1 at 0), which can't be compared with dates.
 */
export interface StoryInstant {
  start: number;
  /** start + duration, or start when there's no duration. */
  end: number;
  dated: boolean;
}

/** An ISO 8601 duration in milliseconds (a year as 365 days, a month as 30), or undefined if it isn't one. */
export function durationMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return undefined;
  const [y, mo, w, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as number[];
  return ((((y! * 365 + mo! * 30 + w! * 7 + d!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

/** Midnight UTC of an ISO date ("2024-03-01"), or undefined. */
function dateMs(date: string): number | undefined {
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
}

/** A story time as an instant: dates as given; day N through `calendarStart` (day 1 is that date), or on the relative scale. */
export function storyInstant(when: StoryTime | undefined, duration: string | undefined, calendarStart?: string): StoryInstant | undefined {
  if (!when) return undefined;
  let start: number | undefined;
  let dated: boolean;
  if ("at" in when) {
    // A date-time without a zone is story time, not anyone's local time: read as UTC.
    const at = /T\d{2}:\d{2}(:\d{2})?$/.test(when.at) ? `${when.at}Z` : when.at.length === 10 ? `${when.at}T00:00:00Z` : when.at;
    const t = Date.parse(at);
    if (Number.isNaN(t)) return undefined;
    start = t;
    dated = true;
  } else {
    const [hh, mm] = (when.time ?? "00:00").split(":").map(Number) as [number, number];
    const base = calendarStart ? dateMs(calendarStart) : undefined;
    start = (base ?? 0) + (when.day - 1) * DAY + (hh * 60 + mm) * MINUTE;
    dated = base !== undefined;
  }
  return { start, end: start + (durationMs(duration) ?? 0), dated };
}

export type TimelineItem = { kind: "scene"; scene: Scene; at: StoryInstant } | { kind: "event"; event: StoryEvent; at: StoryInstant };

export interface StoryTimeline {
  /** Scenes and events with a time, in story-time order: dated first, then relative days; reading order breaks ties. */
  items: TimelineItem[];
  /** Scenes in reading order that have no time. */
  undatedScenes: Scene[];
  undatedEvents: StoryEvent[];
}

const itemId = (i: TimelineItem) => (i.kind === "scene" ? i.scene.id : i.event.id);

/** The book's scenes and off-page events in story-time order. */
export function storyTimeline(novel: Novel): StoryTimeline {
  const start = novel.config?.calendar?.start;
  const items: TimelineItem[] = [];
  const undatedScenes: Scene[] = [];
  const undatedEvents: StoryEvent[] = [];
  for (const scene of novel.scenes) {
    const at = storyInstant(scene.when, scene.duration, start);
    if (at) items.push({ kind: "scene", scene, at });
    else undatedScenes.push(scene);
  }
  for (const event of novel.events) {
    const at = storyInstant(event.when, event.duration, start);
    if (at) items.push({ kind: "event", event, at });
    else undatedEvents.push(event);
  }
  const reading = (i: TimelineItem) => (i.kind === "scene" ? i.scene.position : Infinity);
  items.sort((a, b) => Number(b.at.dated) - Number(a.at.dated) || a.at.start - b.at.start || reading(a) - reading(b) || itemId(a).localeCompare(itemId(b)));
  return { items, undatedScenes, undatedEvents };
}

/** Who is where in an item: its characters (a scene's point of view too) and its locations. */
function cast(i: TimelineItem): { characters: Set<string>; locations: Set<string> } {
  if (i.kind === "scene") return { characters: new Set([...(i.scene.pov ? [i.scene.pov] : []), ...i.scene.characters]), locations: new Set(i.scene.locations) };
  return { characters: new Set(i.event.characters ?? []), locations: new Set(i.event.locations ?? []) };
}

export interface Overlap {
  character: string;
  a: TimelineItem;
  b: TimelineItem;
}

/**
 * Someone in two places at once: a character in two items whose times overlap (on the same scale),
 * whose locations are given and share none. Items without a duration are moments: they overlap only
 * an item running across them, or a moment at the same time.
 */
export function overlaps(timeline: StoryTimeline): Overlap[] {
  const out: Overlap[] = [];
  const { items } = timeline;
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const ca = cast(a);
    if (!ca.locations.size) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (b.at.dated !== a.at.dated) continue;
      // Sorted by start: once b starts after a has ended (or after a's moment), nothing later overlaps a.
      if (b.at.start > a.at.end || (b.at.start === a.at.end && a.at.end > a.at.start)) break;
      const together = b.at.start < a.at.end || b.at.start === a.at.start;
      if (!together) continue;
      const cb = cast(b);
      if (!cb.locations.size || [...ca.locations].some((l) => cb.locations.has(l))) continue;
      for (const character of ca.characters) if (cb.characters.has(character)) out.push({ character, a, b });
    }
  }
  return out;
}
