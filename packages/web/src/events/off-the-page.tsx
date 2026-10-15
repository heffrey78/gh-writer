import { storyTimeline, type Novel } from "@gh-writer/core";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { NavLink } from "react-router";
import { useEntryPanel } from "../novel/entry-tab.tsx";
import { cn } from "../ui/cn.ts";
import { useNewEvent } from "./new-event.tsx";

const KEY = "ghw.offThePage";

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) !== "collapsed";
  } catch {
    return true;
  }
}

/**
 * The book pane's Off the page section (#165): the off-page events in story-time order, undated last,
 * below the parts and chapters. Each opens its page, or, while a chapter or scene is open, the right
 * sidebar's Entry tab beside the text. Collapsed or not, remembered in this browser.
 */
export function OffThePage({ novelId, novel, writing }: { novelId: string; novel: Novel; writing: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(remembered);
  const add = useNewEvent((s) => s.set);
  const events = useMemo(() => {
    const t = storyTimeline(novel);
    return [...t.items.flatMap((i) => (i.kind === "event" ? [i.event] : [])), ...t.undatedEvents];
  }, [novel]);
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
            Off the page
            <span className="ml-auto font-normal tabular-nums normal-case">{events.length}</span>
          </button>
        </h3>
        <button type="button" onClick={() => add(true)} aria-label="New off-page event" title="New off-page event" className="rounded p-1 text-muted hover:bg-paper hover:text-ink">
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      {open &&
        (events.length ? (
          <ul className="grid gap-px text-sm">
            {events.map((e) => (
              <li key={e.id}>
                <NavLink
                  to={`/novels/${novelId}/event/${e.id}`}
                  onClick={(click) => {
                    if (!writing) return;
                    // Beside the text, not instead of it.
                    click.preventDefault();
                    useEntryPanel.getState().open(e.id);
                  }}
                  className={({ isActive }) => cn("block truncate rounded-md px-2 py-1 italic hover:bg-paper", isActive && "bg-accent-soft")}
                >
                  {e.title}
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 text-xs text-muted">Backstory and what happens between scenes. None yet.</p>
        ))}
    </section>
  );
}
