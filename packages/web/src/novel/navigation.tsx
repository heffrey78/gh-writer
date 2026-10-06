import type { Chapter, Novel } from "@gh-writer/core";


export const chapterTitle = (novel: Novel, chapter: Chapter) => chapter.title ?? `Chapter ${novel.chapters.indexOf(chapter) + 1}`;
