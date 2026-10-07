import type { Chapter, Entity, Novel, Part, Scene } from "@gh-writer/core";
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
