import type { Chapter, Novel, Part, Scene } from "@gh-writer/core";
import { chapterTitle } from "../novel/navigation.tsx";

/** A grid cell's key: its row's ID and its scene's. */
export const gridKey = (row: string, scene: string) => `${row}|${scene}`;

/** Scenes grouped for column headers: by chapter, and by part when the book has them. */
export function sceneColumns(novel: Novel, scenes: Scene[]) {
  const chapters: { chapter: Chapter; title: string; span: number }[] = [];
  const parts: { part: Part; span: number }[] = [];
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
  return { chapters, parts };
}

