import { countWords, type Chapter, type Entity, type Novel, type Part, type Scene } from "@gh-writer/core";
import { chapterTitle } from "../novel/navigation.tsx";

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
}

export const cellKey = (plotline: string, scene: string) => `${plotline}|${scene}`;

/** The book as plotline lanes against scene columns, from the scenes' plotlines. */
export function swimlanes(novel: Novel, scenes: Scene[] = novel.scenes): Swimlanes {
  const marks = new Map<string, Mark>();
  for (const scene of scenes) for (const p of scene.plotlines) marks.set(cellKey(p.id, scene.id), { weight: p.weight, ...(p.beat ? { beat: p.beat } : {}) });
  const lanes = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));

  const chapters: Swimlanes["chapters"] = [];
  const parts: Swimlanes["parts"] = [];
  for (const scene of scenes) {
    const chapter = novel.chapters.find((c) => c.id === scene.chapterId);
    if (!chapter) continue;
    const last = chapters.at(-1);
    if (last?.chapter.id === chapter.id) last.span++;
    else chapters.push({ chapter, title: chapterTitle(novel, chapter), span: 1 });
    const part = novel.parts.find((p) => p.id === chapter.partId);
    if (!part) continue;
    const lastPart = parts.at(-1);
    if (lastPart?.part.id === part.id) lastPart.span++;
    else parts.push({ part, span: 1 });
  }
  return { lanes, scenes, chapters, parts, marks };
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
export function gaps(s: Swimlanes, threshold: GapThreshold): Gap[] {
  const words = s.scenes.map((scene) => countWords(scene.body));
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
