import type { Chapter, Novel, Scene } from "@gh-writer/core";
import { countWords } from "@gh-writer/core";
import { useMemo } from "react";
import { NavLink } from "react-router";
import { cn } from "../ui/cn.ts";

const number = new Intl.NumberFormat();

export const chapterTitle = (novel: Novel, chapter: Chapter) => chapter.title ?? `Chapter ${novel.chapters.indexOf(chapter) + 1}`;

/** The manuscript in reading order: parts, chapters with their word counts, and scenes. */
export function Navigation({ novelId, novel }: { novelId: string; novel: Novel }) {
  const base = `/novels/${novelId}`;
  const scenes = useMemo(() => new Map(novel.allScenes.map((s) => [s.id, s])), [novel]);
  const words = useMemo(() => new Map(novel.allScenes.map((s) => [s.id, countWords(s.body)])), [novel]);
  const groups = useMemo(() => {
    const out: { title?: string; id: string; chapters: Chapter[] }[] = [];
    for (const chapter of novel.chapters) {
      const part = chapter.partId ? novel.parts.find((p) => p.id === chapter.partId) : undefined;
      const last = out.at(-1);
      if (last && last.id === (part?.id ?? "")) last.chapters.push(chapter);
      else out.push({ id: part?.id ?? "", ...(part ? { title: part.title } : {}), chapters: [chapter] });
    }
    return out;
  }, [novel]);
  const link = ({ isActive }: { isActive: boolean }) =>
    cn("block rounded-md px-2 py-1 text-sm hover:bg-paper", isActive && "bg-accent-soft font-medium text-ink");

  return (
    <nav aria-label="Manuscript" className="text-sm">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.title ?? "Chapters"} className="mb-4">
          {group.title && <h2 className="mb-1 px-2 text-xs font-semibold tracking-wide text-muted uppercase">{group.title}</h2>}
          <ol className="grid gap-0.5">
            {group.chapters.map((chapter) => {
              const chapterScenes = chapter.sceneIds.map((id) => scenes.get(id)).filter((s): s is Scene => s !== undefined);
              const total = chapterScenes.reduce((n, s) => n + (words.get(s.id) ?? 0), 0);
              return (
                <li key={chapter.id}>
                  <NavLink to={`${base}/chapter/${chapter.id}`} className={link}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span>{chapterTitle(novel, chapter)}</span>
                      <span className="text-xs text-muted tabular-nums">{number.format(total)}</span>
                    </span>
                  </NavLink>
                  <ol className="ml-3 grid gap-0.5 border-l border-rule pl-1">
                    {chapterScenes.map((scene) => (
                      <li key={scene.id}>
                        <NavLink to={`${base}/scene/${scene.id}`} className={(s) => cn(link(s), "text-muted", s.isActive && "text-ink")}>
                          {scene.title}
                        </NavLink>
                      </li>
                    ))}
                  </ol>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </nav>
  );
}
