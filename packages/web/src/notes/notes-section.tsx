import { proseText, type Novel } from "@gh-writer/core";
import { ChevronDown, ChevronRight, LayoutGrid, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Link, NavLink } from "react-router";
import { useStore } from "zustand";
import type { Workspace } from "../novel/workspace.ts";
import { cn } from "../ui/cn.ts";
import { useNewNote } from "./new-note.tsx";

const KEY = "ghw.notesSection";

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) !== "collapsed";
  } catch {
    return true;
  }
}

/**
 * The book pane's Notes section (#205), a sibling of Off the page: the writer's notes newest first,
 * narrowed by a tag or by their words. Each opens its page (a scene's notes are also on the right
 * sidebar's Notes tab, #222). Collapsed or not, remembered in this browser.
 */
export function NotesSection({ novelId, novel, workspace }: { novelId: string; novel: Novel; workspace: Workspace }) {
  const id = useId();
  const [open, setOpen] = useState(remembered);
  const [tag, setTag] = useState("");
  const [words, setWords] = useState("");
  const add = useNewNote((s) => s.set);
  const notes = useMemo(
    () => [...novel.notes].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "") || a.title.localeCompare(b.title)),
    [novel.notes],
  );
  const tags = useMemo(() => [...new Set(novel.notes.flatMap((n) => n.tags))].sort((a, b) => a.localeCompare(b)), [novel.notes]);
  // An open note's text as typed, saved or not.
  const typed = useStore(workspace.store, (s) => s.files);
  const query = words.trim().toLowerCase();
  const shown = notes.filter(
    (n) => (!tag || n.tags.includes(tag)) && (!query || [n.title, proseText(typed[n.file]?.body ?? n.body), ...n.tags].some((t) => t.toLowerCase().includes(query))),
  );
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(KEY, open ? "collapsed" : "expanded");
    } catch {
      // Not remembered where storage is blocked.
    }
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-labelledby={id} className="mt-3 grid gap-1 border-t border-rule pt-2">
      <div className="flex items-center gap-1">
        <h3 id={id} className="flex-1">
          <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold tracking-wide text-muted uppercase hover:text-ink">
            <Chevron className="size-3.5" aria-hidden />
            Notes
            <span className="ml-auto font-normal tabular-nums normal-case">{notes.length}</span>
          </button>
        </h3>
        <Link to={`/novels/${novelId}/notes`} aria-label="Every note, as cards" title="Every note, as cards" className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
          <LayoutGrid className="size-3.5" aria-hidden />
        </Link>
        <button type="button" onClick={() => add(true)} aria-label="New note" title="New note" className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      {open && (
        <>
          {notes.length > 1 && (
            <div role="group" aria-label="Find notes" className="grid gap-1 px-1">
              <input
                type="search"
                aria-label="Find in notes"
                placeholder="Find in notes"
                value={words}
                onChange={(e) => setWords(e.target.value)}
                className="h-7 w-full rounded-md border border-rule bg-raised px-2 text-xs"
              />
              {tags.length > 0 && (
                <select aria-label="Notes tagged" value={tag} onChange={(e) => setTag(e.target.value)} className="h-7 w-full rounded-md border border-rule bg-raised px-1.5 text-xs">
                  <option value="">Every tag</option>
                  {tags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {shown.length ? (
            <ul className="grid gap-px text-sm">
              {shown.map((n) => (
                <li key={n.id}>
                  <NavLink
                    to={`/novels/${novelId}/note/${n.id}`}
                    className={({ isActive }) => cn("block truncate rounded-md px-2 py-1 hover:bg-paper", isActive && "bg-accent-soft")}
                  >
                    {n.title}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="px-2 text-xs text-muted">
              {notes.length ? "No note matches." : "Ideas, what-ifs, questions for later. None yet."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
