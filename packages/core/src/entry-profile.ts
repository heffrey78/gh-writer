import { DEFAULT_GAP, gaps, swimlanes, when, type Gap } from "./diagrams.ts";
import type { Novel, Scene } from "./model.ts";
import { storyInstant, type TimelineItem } from "./time.ts";

/*
 * What a profile says that depends on the entry's type (#161): a location's visitors and the story
 * time its scenes span; a plotline's beats in reading order, the scenes it skips, who's in it and
 * where, and where it goes quiet; a theme's strength scene by scene.
 */

/** Entries counted by how many scenes they're in, most first, then by name. */
export interface Tally {
  id: string;
  name: string;
  scenes: number;
}

function tally(novel: Novel, ids: Iterable<string>[]): Tally[] {
  const counts = new Map<string, number>();
  for (const list of ids) for (const id of new Set(list)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .map(([id, scenes]) => ({ id, name: novel.entities.find((e) => e.id === id)?.name ?? id, scenes }))
    .sort((a, b) => b.scenes - a.scenes || a.name.localeCompare(b.name));
}

const castOf = (s: Scene) => [...(s.pov ? [s.pov] : []), ...s.characters];

/** The story time a set of scenes covers: its earliest and latest, as read ("Day 1, 09:10"). */
export function storySpan(novel: Novel, scenes: Scene[]): { from: string; to: string } | undefined {
  const calendar = novel.config?.calendar?.start;
  const timed = scenes
    .flatMap((scene): TimelineItem[] => {
      const at = storyInstant(scene.when, scene.duration, calendar);
      return at ? [{ kind: "scene", scene, at }] : [];
    })
    // Dated times first, as the timeline orders them; a book mixing scales reads its dated span.
    .sort((a, b) => Number(b.at.dated) - Number(a.at.dated) || a.at.start - b.at.start);
  const dated = timed.filter((t) => t.at.dated === timed[0]?.at.dated);
  if (!dated.length) return undefined;
  return { from: when(dated[0]!), to: when(dated.at(-1)!) };
}

export interface LocationProfile {
  /** Who's in its scenes (point of view or characters), by how often. */
  visitors: Tally[];
  /** The scenes set there, in reading order. */
  scenes: Scene[];
  span?: { from: string; to: string };
}

export function locationProfile(novel: Novel, id: string): LocationProfile {
  const scenes = novel.scenes.filter((s) => s.locations.includes(id));
  const span = storySpan(novel, scenes);
  return { visitors: tally(novel, scenes.map(castOf)), scenes, ...(span ? { span } : {}) };
}

export interface PlotlineProfile {
  /** Its beats in reading order; `beat` is missing where the scene says nothing of what happens. */
  beats: { scene: Scene; index: number; weight: "major" | "minor"; beat?: string }[];
  /** Scenes between its first and last beat that it isn't in. */
  skips: Scene[];
  /** Who's in its scenes, and where they're set, by how often. */
  who: Tally[];
  where: Tally[];
  /** Where it goes quiet for longer than the Story map's threshold. */
  quiet: Gap[];
}

export function plotlineProfile(novel: Novel, id: string): PlotlineProfile {
  const scenes = novel.scenes;
  const beats = scenes.flatMap((scene) =>
    scene.plotlines.flatMap((p, index) => (p.id === id ? [{ scene, index, weight: p.weight, ...(p.beat ? { beat: p.beat } : {}) }] : [])),
  );
  const first = scenes.indexOf(beats[0]?.scene as Scene);
  const last = scenes.indexOf(beats.at(-1)?.scene as Scene);
  const skips = first < 0 ? [] : scenes.slice(first, last + 1).filter((s) => !s.plotlines.some((p) => p.id === id));
  const lanes = swimlanes(novel);
  return {
    beats,
    skips,
    who: tally(novel, beats.map((b) => castOf(b.scene))),
    where: tally(novel, beats.map((b) => b.scene.locations)),
    quiet: gaps({ ...lanes, lanes: lanes.lanes.filter((l) => l.id === id) }, DEFAULT_GAP),
  };
}

export interface ThemeProfile {
  /** Each scene in reading order: the theme's strength there (0: not listed; listed without one: 2). */
  strengths: { scene: Scene; strength: 0 | 1 | 2 | 3; note?: string }[];
}

export function themeProfile(novel: Novel, id: string): ThemeProfile {
  return {
    strengths: novel.scenes.map((scene) => {
      const t = scene.themes.find((x) => x.id === id);
      const strength = !t ? 0 : t.strength === 1 || t.strength === 2 || t.strength === 3 ? t.strength : 2;
      return { scene, strength, ...(t?.note ? { note: t.note } : {}) };
    }),
  };
}
