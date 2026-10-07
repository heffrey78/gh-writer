import { countWords, type Chapter, type Entity, type Novel, type Part, type Scene } from "@gh-writer/core";
import { gridKey, sceneColumns } from "../diagrams/columns.ts";

export interface Mark {
  weight: "major" | "minor";
  beat?: string;
}

export interface Swimlanes {
  /** Plotlines, by name: an order that edits never shuffle. */
  lanes: Entity[];
  /** Scenes in reading order. */
  scenes: Scene[];
  /** Column groups over the scenes: chapters, and (when the book has them) parts. */
  chapters: { chapter: Chapter; title: string; span: number }[];
  parts: { part: Part; span: number }[];
  /** How a scene advances a plotline, by `${plotline}|${scene}`; absent: it doesn't. */
  marks: Map<string, Mark>;
  /** Each scene's words, counted once (gaps in words read them on every threshold). */
  words: number[];
}

export const cellKey = gridKey;

/** The book as plotline lanes against scene columns, from the scenes' plotlines. */
export function swimlanes(novel: Novel, scenes: Scene[] = novel.scenes): Swimlanes {
  const marks = new Map<string, Mark>();
  for (const scene of scenes) for (const p of scene.plotlines) marks.set(cellKey(p.id, scene.id), { weight: p.weight, ...(p.beat ? { beat: p.beat } : {}) });
  const lanes = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));

  const { chapters, parts } = sceneColumns(novel, scenes);
  return { lanes, scenes, chapters, parts, marks, words: scenes.map((scene) => countWords(scene.body)) };
}

/** How long a plotline may go unmentioned before it counts as a gap: in scenes, or in words. */
export type GapThreshold = { scenes: number } | { words: number };

export const DEFAULT_GAP: GapThreshold = { scenes: 3 };

export interface Gap {
  lane: string;
  /** The first and last scene of the quiet stretch. */
  from: string;
  to: string;
  scenes: number;
  words: number;
  /** It runs to the end of the book: the thread is never picked up again. */
  open: boolean;
}

/**
 * Where each plotline goes quiet for longer than the threshold: the stretches between two of its
 * beats, and after its last beat to the end of the book. (Before its first beat it hasn't started.)
 */
export function gaps(s: { lanes: { id: string }[]; scenes: Scene[]; marks: Map<string, unknown>; words: number[] }, threshold: GapThreshold): Gap[] {
  const { words } = s;
  const out: Gap[] = [];
  for (const lane of s.lanes) {
    const beats = s.scenes.flatMap((scene, i) => (s.marks.has(cellKey(lane.id, scene.id)) ? [i] : []));
    if (!beats.length) continue;
    const stretches = beats.map((b, k) => [b + 1, (beats[k + 1] ?? s.scenes.length) - 1, beats[k + 1] === undefined] as const);
    for (const [first, last, open] of stretches) {
      if (last < first) continue;
      const n = last - first + 1;
      const w = words.slice(first, last + 1).reduce((a, b) => a + b, 0);
      const over = "scenes" in threshold ? n > threshold.scenes : w > threshold.words;
      if (over) out.push({ lane: lane.id, from: s.scenes[first]!.id, to: s.scenes[last]!.id, scenes: n, words: w, open });
    }
  }
  return out;
}

/** The scenes a zoom shows: a part's, a chapter's, or (no zoom, or one that's gone) all. */
export function zoomed(novel: Novel, scenes: Scene[], zoom: string | undefined): Scene[] {
  if (!zoom) return scenes;
  const part = novel.parts.find((p) => p.id === zoom);
  if (part) return scenes.filter((s) => part.chapterIds.includes(s.chapterId ?? ""));
  const chapter = novel.chapters.find((c) => c.id === zoom);
  return chapter ? scenes.filter((s) => s.chapterId === chapter.id) : scenes;
}
