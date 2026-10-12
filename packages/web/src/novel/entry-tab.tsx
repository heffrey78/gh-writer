import { backlinks, relationshipsAt, type Novel } from "@gh-writer/core";
import type { SpellService } from "@gh-writer/editor/react";
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router";
import { create } from "zustand";
import { describe, EntryPage } from "../bible/entry-page.tsx";
import { typeOf } from "../bible/types.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { useCurrentScene } from "./current.ts";
import { useNotice } from "./notice.tsx";
import { useRightSidebar } from "./right-sidebar.tsx";
import type { Workspace } from "./workspace.ts";

interface EntryState {
  /** The entries opened on the Entry tab, in order, and the one shown. */
  history: string[];
  at: number;
  /** Pinned: names opened elsewhere don't replace it. */
  pinned: boolean;
  /** Showing the form rather than the sheet. */
  editing: boolean;
  /** The tab should take the focus when it next shows the entry: the sheet, or the form's first field. */
  focus: boolean;
  /** Show an entry on the Entry tab (or its form, with `edit`) and move the focus to it. */
  open: (id: string, options?: { edit?: boolean }) => void;
  step: (by: -1 | 1) => void;
  setPinned: (pinned: boolean) => void;
  setEditing: (editing: boolean) => void;
}

export const useEntryPanel = create<EntryState>((set, get) => ({
  history: [],
  at: -1,
  pinned: false,
  editing: false,
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
    if (current === id) set({ editing: options?.edit ?? false, focus: true });
    else set({ history: [...history.slice(0, at + 1), id], at: at + 1, editing: options?.edit ?? false, focus: true });
    useRightSidebar.getState().show("entry");
  },
  step: (by) => {
    const { history, at } = get();
    const to = at + by;
    if (to >= 0 && to < history.length) set({ at: to, editing: false });
  },
  setPinned: (pinned) => set({ pinned }),
  setEditing: (editing) => set({ editing, focus: true }),
}));

const FIELD = /_/g;
const MENTION = /\[([^\]\n]*)\]\(#[a-z]{2,8}_\w{6}\)/g;

/**
 * The right sidebar's Entry tab (#155): a story bible entry as a sheet to read beside the text — its
 * type, name and other names, summary, fields, relationships at the caret's scene, the scenes it's
 * in, notes — with Back and Forward through the entries opened, a pin to keep it while names are
 * opened elsewhere, and "Edit details" for the entry's form in place.
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
  const { history, at, pinned, editing, focus, step, setPinned, setEditing } = useEntryPanel();
  const id = history[at];
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const current = useCurrentScene((s) => s.scene);
  const entity = id ? novel.entities.find((e) => e.id === id) : undefined;
  const links = useMemo(() => (entity ? backlinks(novel, entity.id) : undefined), [novel, entity]);

  useEffect(() => {
    if (!focus) return;
    useEntryPanel.setState({ focus: false });
    const field = editing ? ref.current?.querySelector<HTMLElement>("input, textarea") : undefined;
    (field ?? ref.current)?.focus();
  }, [focus, id, editing]);

  if (!id) {
    return (
      <p className="p-4 text-sm text-muted">
        No entry open. Choose a name on the Scene tab, or point at a name in the text (or put the caret on it and press Alt+Enter) and choose “Open entry”.
      </p>
    );
  }

  const type = entity && typeOf(novel, entity);
  const relationships = entity && current ? relationshipsAt(novel, current.id).filter((r) => r.from === entity.id || r.to === entity.id) : [];
  const fields = entity ? Object.entries(entity.fields) : [];
  // The notes as plain text: mentions as their words, without Markdown's emphasis marks.
  const notes =
    entity?.body
      .replace(MENTION, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
      .trim()
      .split(/\n{2,}/)
      .filter(Boolean) ?? [];

  const toolbar = (
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
  );

  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={headingId} className="grid content-start gap-4 p-4 text-sm outline-none">
      {toolbar}
      {!entity ? (
        <p id={headingId}>This entry no longer exists.</p>
      ) : editing ? (
        <>
          <EntryPage novelId={novelId} novel={novel} entity={entity} workspace={workspace} spell={spell} embedded={{ headingId }} startEditing="name" />
          <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setEditing(false)}>
            Back to the sheet
          </Button>
        </>
      ) : (
        <>
          <div className="grid gap-1">
            <h2 id={headingId} className="text-xl font-semibold">
              {entity.name}
            </h2>
            {entity.aliases.length > 0 && <p className="text-xs text-muted">Also {entity.aliases.join(", ")}</p>}
            {entity.tags.length > 0 && <p className="text-xs text-muted">Tagged {entity.tags.join(", ")}</p>}
          </div>
          {entity.summary && <p className="font-prose text-base leading-normal">{entity.summary}</p>}
          {fields.length > 0 && (
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2.5 gap-y-1">
              {fields.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[13px] text-muted capitalize">{k.replace(FIELD, " ")}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          </div>

          {current && (
            <section aria-labelledby={`${headingId}-rels`} className="grid gap-1.5 border-t border-rule pt-3">
              <h3 id={`${headingId}-rels`} className="text-xs font-semibold tracking-wide text-muted uppercase">
                At “{current.title}”
              </h3>
              {relationships.length ? (
                <ul className="grid list-disc gap-1 pl-4">
                  {relationships.map((r) => (
                    <li key={r.id}>{describe(novel, entity.id, r)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No relationships here.</p>
              )}
            </section>
          )}

          <section aria-labelledby={`${headingId}-scenes`} className="grid gap-1.5 border-t border-rule pt-3">
            <h3 id={`${headingId}-scenes`} className="text-xs font-semibold tracking-wide text-muted uppercase">
              In {links?.scenes.length ?? 0} {links?.scenes.length === 1 ? "scene" : "scenes"}
            </h3>
            {links && links.scenes.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {links.scenes.map(({ scene }) => (
                  <li key={scene.id}>
                    <button
                      type="button"
                      aria-current={scene.id === current?.id ? "true" : undefined}
                      onClick={() => void navigate(`/novels/${novelId}/scene/${scene.id}`)}
                      className={cn("rounded-full border border-rule px-2 py-0.5 text-[13px] hover:border-accent", scene.id === current?.id && "border-accent bg-accent-soft font-medium")}
                    >
                      {scene.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Not in any scene yet.</p>
            )}
          </section>

          {notes.length > 0 && (
            <section aria-labelledby={`${headingId}-notes`} className="grid gap-1.5 border-t border-rule pt-3">
              <h3 id={`${headingId}-notes`} className="text-xs font-semibold tracking-wide text-muted uppercase">
                Notes
              </h3>
              {notes.map((n, i) => (
                <p key={i} className="whitespace-pre-line">
                  {n}
                </p>
              ))}
            </section>
          )}

          <Link to={`/novels/${novelId}/bible/${entity.id}`} className="justify-self-start text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
            Open the full entry
          </Link>
        </>
      )}
    </section>
  );
}
