import { relationshipsAt, type Novel, type Scene } from "@gh-writer/core";
import type { MentionTarget } from "@gh-writer/editor";
import type { SpellService } from "@gh-writer/editor/react";
import type { Editor } from "@tiptap/core";
import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { describe, EntryPage } from "../bible/entry-page.tsx";
import { typeOf } from "../bible/types.ts";
import { Button } from "../ui/button.tsx";
import type { Workspace } from "./workspace.ts";

interface Card extends MentionTarget {
  /** The scene the mention is in: relationships are shown as they stand there. */
  scene: Scene | undefined;
  editor: Editor;
}

interface CardState {
  card: Card | null;
  /** The pointer is over the card: it stays when the pointer leaves the mention for it. */
  hovered: boolean;
  show: (card: Card) => void;
  /** Close it; with `refocus`, the text gets focus back with the caret where it was. */
  hide: (refocus?: boolean) => void;
}

export const useMentionCard = create<CardState>((set, get) => ({
  card: null,
  hovered: false,
  show: (card) => set({ card }),
  hide: (refocus) => {
    const editor = get().card?.editor;
    set({ card: null, hovered: false });
    if (refocus && editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  },
}));

/** The pointer left a mention: its card goes, unless the pointer went into it. */
export function leaveMention(): void {
  setTimeout(() => {
    const { card, hovered, hide } = useMentionCard.getState();
    if (card?.via === "pointer" && !hovered) hide();
  }, 250);
}

interface PanelState {
  /** The entry shown beside the text, and the editor to return to. */
  entry: { id: string; editor: Editor } | null;
  open: (id: string, editor: Editor) => void;
  close: () => void;
}

export const useEntryPanel = create<PanelState>((set, get) => ({
  entry: null,
  open: (id, editor) => set({ entry: { id, editor } }),
  close: () => {
    const editor = get().entry?.editor;
    set({ entry: null });
    if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  },
}));

const FIELDS = 4;

/**
 * What's known about a mentioned entity, by the mention: its current name, summary, a few fields,
 * and its relationships as they stand at the scene holding the mention. Shown on hover (it stays
 * while pointed at) or with Alt+Enter beside a mention, which moves focus into it; Escape closes
 * it and returns to the text. "Open entry" shows the whole entry in a side panel.
 */
export function MentionCard({ novel }: { novel: Novel }) {
  const card = useMentionCard((s) => s.card);
  const hide = useMentionCard((s) => s.hide);
  const openEntry = useEntryPanel((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [place, setPlace] = useState<{ left: number; top: number }>();

  const entity = card && novel.entities.find((e) => e.id === card.id);

  // Placed under the mention, or above it when there's no room.
  useLayoutEffect(() => {
    if (!card || !ref.current) return setPlace(undefined);
    const anchor = card.element.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = ref.current;
    const below = anchor.bottom + 6;
    setPlace({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
      top: below + height <= window.innerHeight - 8 || anchor.top - 6 - height < 8 ? below : anchor.top - 6 - height,
    });
  }, [card]);

  // By keyboard, focus goes into the card.
  useEffect(() => {
    if (card?.via === "keyboard" && place) ref.current?.focus();
  }, [card, place]);

  // Escape closes; so do typing, scrolling away and clicking elsewhere.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide(card.via === "keyboard" || ref.current?.contains(document.activeElement) === true);
    };
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && hide();
    const onType = () => hide();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    card.editor.on("update", onType);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      card.editor.off("update", onType);
    };
  }, [card, hide]);

  if (!card) return null;
  const type = entity && typeOf(novel, entity);
  const relationships = entity && card.scene ? relationshipsAt(novel, card.scene.id).filter((r) => r.from === entity.id || r.to === entity.id) : [];
  const fields = entity ? Object.entries(entity.fields).slice(0, FIELDS) : [];

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={headingId}
      tabIndex={-1}
      onPointerEnter={() => useMentionCard.setState({ hovered: true })}
      onPointerLeave={() => {
        useMentionCard.setState({ hovered: false });
        if (card.via === "pointer") leaveMention();
      }}
      style={place ?? { visibility: "hidden", left: 0, top: 0 }}
      className="fixed z-50 grid w-80 gap-2 rounded-lg border border-rule bg-raised p-4 text-sm text-ink shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">{type?.label ?? "Unknown entry"}</p>
          <h2 id={headingId} className="font-semibold">
            {entity?.name ?? card.id}
          </h2>
        </div>
        <button type="button" onClick={() => hide(true)} aria-label="Close" className="rounded p-1 text-muted hover:bg-panel">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {!entity ? (
        <p className="text-muted">No entry has this ID. It may have been deleted.</p>
      ) : (
        <>
          {entity.summary && <p>{entity.summary}</p>}
          {fields.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {fields.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted capitalize">{k.replace(/_/g, " ")}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {card.scene && (
            <section aria-label={`Relationships at “${card.scene.title}”`} className="grid gap-1 border-t border-rule pt-2">
              <p className="text-xs text-muted">At “{card.scene.title}”</p>
              {relationships.length ? (
                <ul className="grid gap-0.5">
                  {relationships.map((r) => (
                    <li key={r.id}>{describe(novel, entity.id, r)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No relationships here.</p>
              )}
            </section>
          )}
          <div>
            <Button
              size="sm"
              onClick={() => {
                const editor = card.editor;
                useMentionCard.setState({ card: null });
                openEntry(entity.id, editor);
              }}
            >
              Open entry
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** A bible entry beside the text, opened from a mention's card. Closing it returns to the text, caret where it was. */
export function EntryPanel({
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
  const entry = useEntryPanel((s) => s.entry);
  const close = useEntryPanel((s) => s.close);
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  const entity = entry && novel.entities.find((e) => e.id === entry.id);

  useEffect(() => {
    if (entry) ref.current?.focus();
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry) return null;
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && e.target === e.currentTarget) close();
      }}
      className="relative grid content-start gap-3 border-rule bg-panel p-4 outline-none lg:overflow-y-auto lg:border-l"
    >
      <Button size="sm" variant="ghost" onClick={close} className="justify-self-end">
        <X className="size-4" aria-hidden /> Back to the text
      </Button>
      {entity ? (
        <EntryPage novelId={novelId} novel={novel} entity={entity} workspace={workspace} spell={spell} embedded={{ headingId }} />
      ) : (
        <p id={headingId}>This entry no longer exists.</p>
      )}
    </aside>
  );
}
