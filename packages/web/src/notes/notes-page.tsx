import { proseText, type Novel } from "@gh-writer/core";
import { Pin, Plus, Search } from "lucide-react";
import { useId, useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../ui/button.tsx";
import { useNewNote } from "./new-note.tsx";
import { PAGE } from "../ui/page.ts";
import { cn } from "../ui/cn.ts";

type Sort = "newest" | "title";

/**
 * Every note at a glance (#223), as cards like the Story bible's: title, an excerpt, its tags and its
 * scenes (pinned ones marked). Filtered by a tag and by words, sorted newest first or by title; the
 * choices are in the address. A note opens in a modal over it (`over`, #235).
 */
export function NotesPage({ novelId, novel, over }: { novelId: string; novel: Novel; over?: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const sort: Sort = params.get("sort") === "title" ? "title" : "newest";
  const ids = { search: useId(), tag: useId(), sort: useId() };
  const add = useNewNote((s) => s.set);
  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const tags = useMemo(() => [...new Set(novel.notes.flatMap((n) => n.tags))].sort((a, b) => a.localeCompare(b)), [novel.notes]);
  const q = query.trim().toLowerCase();
  const shown = novel.notes
    .filter((n) => (!tag || n.tags.includes(tag)) && (!q || [n.title, proseText(n.body), ...n.tags].some((t) => t.toLowerCase().includes(q))))
    .sort((a, b) => (sort === "title" ? a.title.localeCompare(b.title) : (b.created ?? "").localeCompare(a.created ?? "") || a.title.localeCompare(b.title)));
  const sceneTitle = (id: string) => novel.allScenes.find((s) => s.id === id)?.title ?? id;

  return (
    <div className={cn(PAGE, "grid gap-6")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          Notes <span className="text-base font-normal text-muted">{novel.notes.length}</span>
        </h1>
        <Button variant="primary" onClick={() => add(true)}>
          <Plus className="size-4" aria-hidden /> New note
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <label htmlFor={ids.search} className="sr-only">
            Search the notes
          </label>
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
          <input
            id={ids.search}
            type="search"
            placeholder="Search by title, words or tag"
            value={query}
            onChange={(e) => setParam("q", e.target.value || undefined)}
            className="h-9 w-full rounded-md border border-rule bg-raised pr-3 pl-9 text-sm"
          />
        </div>
        {tags.length > 0 && (
          <label htmlFor={ids.tag} className="flex items-center gap-2 text-sm text-muted">
            Tag
            <select id={ids.tag} value={tag} onChange={(e) => setParam("tag", e.target.value || undefined)} className="h-9 rounded-md border border-rule bg-raised px-2 text-ink">
              <option value="">Every tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        )}
        <label htmlFor={ids.sort} className="flex items-center gap-2 text-sm text-muted">
          Sort
          <select id={ids.sort} value={sort} onChange={(e) => setParam("sort", e.target.value === "newest" ? undefined : e.target.value)} className="h-9 rounded-md border border-rule bg-raised px-2 text-ink">
            <option value="newest">Newest</option>
            <option value="title">Title</option>
          </select>
        </label>
      </div>
      {(q || tag) && (
        <p role="status" className="text-sm text-muted">
          {shown.length === 1 ? "1 note matches" : `${shown.length} notes match`}
        </p>
      )}
      {shown.length ? (
        <ul aria-label="Notes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((n) => {
            const text = proseText(n.body).replace(/\s+/g, " ").trim();
            return (
              <li key={n.id} className="grid">
                <Link
                  to={`/novels/${novelId}/note/${n.id}`}
                  state={{ fromGallery: true }}
                  className="grid content-start gap-1.5 rounded-lg border border-l-4 border-rule border-l-warn/60 bg-raised px-4 py-3 hover:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <span className="font-semibold">{n.title}</span>
                  {text && <span className="line-clamp-3 font-prose leading-snug">{text}</span>}
                  {n.tags.length > 0 && <span className="text-[13px] text-muted">{n.tags.join(" · ")}</span>}
                  {n.scenes.length > 0 && (
                    <span className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
                      On{" "}
                      {n.scenes.map((id, i) => (
                        <span key={id} className="inline-flex items-center gap-0.5">
                          {n.pinned.includes(id) && <Pin className="size-3" fill="currentColor" aria-label="pinned in" />}
                          {sceneTitle(id)}
                          {i < n.scenes.length - 1 && ","}
                        </span>
                      ))}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">{novel.notes.length ? "No note matches." : "No notes yet: ideas, what-ifs and questions for later."}</p>
      )}
      {over}
    </div>
  );
}
