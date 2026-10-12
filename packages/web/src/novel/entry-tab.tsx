import type { Novel } from "@gh-writer/core";
import type { SpellService } from "@gh-writer/editor/react";
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { create } from "zustand";
import { EntryPage } from "../bible/entry-page.tsx";
import { typeOf } from "../bible/types.ts";
import { cn } from "../ui/cn.ts";
import { useNotice } from "./notice.tsx";
import { useRightSidebar } from "./right-sidebar.tsx";
import type { Workspace } from "./workspace.ts";

interface EntryState {
  /** The entries opened on the Entry tab, in order, and the one shown. */
  history: string[];
  at: number;
  /** Pinned: names opened elsewhere don't replace it. */
  pinned: boolean;
  /** Opened with its name ready to edit (a quick entry's Add details). */
  editing: boolean;
  /** Counts openings, so opening the same entry again starts it afresh. */
  opened: number;
  /** The tab should take the focus when it next shows the entry: the sheet, or the form's first field. */
  focus: boolean;
  /** Show an entry on the Entry tab (or its form, with `edit`) and move the focus to it. */
  open: (id: string, options?: { edit?: boolean }) => void;
  step: (by: -1 | 1) => void;
  setPinned: (pinned: boolean) => void;
}

export const useEntryPanel = create<EntryState>((set, get) => ({
  history: [],
  at: -1,
  pinned: false,
  editing: false,
  opened: 0,
  focus: false,
  open: (id, options) => {
    const { history, at, pinned } = get();
    const current = history[at];
    if (pinned && current && current !== id) {
      useNotice.getState().show({
        message: "The Entry tab is pinned to another entry.",
        action: {
          label: "Unpin and open",
          run: () => {
            set({ pinned: false });
            get().open(id, options);
          },
        },
      });
      return;
    }
    const opened = get().opened + 1;
    if (current === id) set({ editing: options?.edit ?? false, focus: true, opened });
    else set({ history: [...history.slice(0, at + 1), id], at: at + 1, editing: options?.edit ?? false, focus: true, opened });
    useRightSidebar.getState().show("entry");
  },
  step: (by) => {
    const { history, at } = get();
    const to = at + by;
    if (to >= 0 && to < history.length) set({ at: to, editing: false });
  },
  setPinned: (pinned) => set({ pinned }),
}));


/**
 * The right sidebar's Entry tab (#155, #163): a story bible entry's profile at the sidebar's size,
 * read first and edited in place as on its page, with its strip and arcs; Back and Forward through
 * the entries opened, and a pin to keep it while names are opened elsewhere.
 */
export function EntryTab({
  novelId,
  novel,
  workspace,
  spell,
}: {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  spell: { service: SpellService; onAddWord: (w: string) => void } | undefined;
}) {
  const { history, at, pinned, editing, opened, focus, step, setPinned } = useEntryPanel();
  const id = history[at];
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  const entity = id ? novel.entities.find((e) => e.id === id) : undefined;

  // To the profile as it opens; or, with its name ready to edit, the profile has put the focus there.
  useEffect(() => {
    if (!focus) return;
    useEntryPanel.setState({ focus: false });
    if (!editing) ref.current?.focus();
  }, [focus, id, editing]);

  if (!id) {
    return (
      <p className="p-4 text-sm text-muted">
        No entry open. Choose a name on the Scene tab, or point at a name in the text (or put the caret on it and press Alt+Enter) and choose “Open entry”.
      </p>
    );
  }

  const type = entity && typeOf(novel, entity);
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={headingId} className="grid content-start gap-3 p-4 text-sm outline-none">
      <div className="flex items-center gap-1">
        <button type="button" disabled={at <= 0} onClick={() => step(-1)} aria-label="Back" title="Back" className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-40">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button type="button" disabled={at >= history.length - 1} onClick={() => step(1)} aria-label="Forward" title="Forward" className="rounded p-1 text-muted hover:bg-paper hover:text-ink disabled:opacity-40">
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <span className="flex-1 text-xs text-muted">{type?.label ?? "Entry"}</span>
        <button
          type="button"
          onClick={() => setPinned(!pinned)}
          aria-pressed={pinned}
          aria-label="Keep this entry here"
          title={pinned ? "Kept here: names opened elsewhere won't replace it" : "Keep this entry here"}
          className={cn("rounded p-1 hover:bg-paper hover:text-ink", pinned ? "text-accent" : "text-muted")}
        >
          <Pin className="size-3.5" fill={pinned ? "currentColor" : "none"} aria-hidden />
        </button>
      </div>
      {entity ? (
        <EntryPage
          key={`${entity.id}:${opened}`}
          novelId={novelId}
          novel={novel}
          entity={entity}
          workspace={workspace}
          spell={spell}
          embedded={{ headingId }}
          size="tab"
          {...(editing ? { startEditing: "name" as const } : {})}
        />
      ) : (
        <p id={headingId}>This entry no longer exists.</p>
      )}
    </section>
  );
}
