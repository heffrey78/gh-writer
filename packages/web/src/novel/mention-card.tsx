import { proseText, relationshipsAt, type Novel, type Scene } from "@gh-writer/core";
import type { MentionTarget } from "@gh-writer/editor";
import type { Editor } from "@tiptap/core";
import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Picture, usePictureUrl } from "../bible/picture.tsx";
import { pictureAlt, shapeForType } from "../bible/pictures.ts";
import { FieldRows, Lead } from "../bible/profile.tsx";
import { RelationshipLines } from "../bible/relationship-types.tsx";
import { OFF_THE_PAGE, typeOf } from "../bible/types.ts";
import { whenOf } from "./scene-details.tsx";
import { Button } from "../ui/button.tsx";
import { useEntryPanel } from "./entry-tab.tsx";

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

const FIELDS = 4;

/**
 * What's known about a mentioned entity, by the mention: its picture, small and round, its current name, summary, a few fields,
 * and its relationships as they stand at the scene holding the mention. Shown on hover (it stays
 * while pointed at) or with Alt+Enter beside a mention, which moves focus into it; Escape closes
 * it and returns to the text. "Open entry" shows the whole entry in a side panel.
 */
export function MentionCard({ novelId, novel }: { novelId: string; novel: Novel }) {
  const card = useMentionCard((s) => s.card);
  const hide = useMentionCard((s) => s.hide);
  const openEntry = useEntryPanel((s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [place, setPlace] = useState<{ left: number; top: number }>();

  const entity = card && novel.entities.find((e) => e.id === card.id);
  // An off-page event (#165): when, who and where, and its note.
  const event = card && !entity ? novel.events.find((e) => e.id === card.id) : undefined;
  const picture = usePictureUrl(novelId, entity?.image);

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

  // By keyboard, focus goes into the card. WebKit can hand it back to the text as the key that opened
  // the card finishes, so the card takes it again on the next frame if it has lost it.
  useEffect(() => {
    if (card?.via !== "keyboard" || !place) return;
    ref.current?.focus();
    const frame = requestAnimationFrame(() => {
      if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
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
        {entity && picture && <Picture src={picture} alt={pictureAlt(shapeForType(entity.type), entity.name)} focus={entity.imageFocus} className="size-13 shrink-0 rounded-full" />}
        <div className="flex-1">
          <p className="text-xs text-muted">{event ? OFF_THE_PAGE : (type?.label ?? "Unknown entry")}</p>
          <h2 id={headingId} className="font-semibold">
            {entity?.name ?? event?.title ?? card.id}
          </h2>
        </div>
        <button type="button" onClick={() => hide(true)} aria-label="Close" className="rounded p-1 text-muted hover:bg-panel">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {event ? (
        <>
          {(() => {
            const time = whenOf({ when: event.when, duration: event.duration });
            return time.when && <Lead size="card">{[time.when, time.duration].filter(Boolean).join(" · ")}</Lead>;
          })()}
          <FieldRows
            compact
            fields={(
              [
                ["who", event.characters],
                ["where", event.locations],
              ] as const
            ).flatMap(([label, ids]) => (ids?.length ? [[label, ids.map((id) => novel.entities.find((e) => e.id === id)?.name ?? id).join(", ")] as [string, string]] : []))}
          />
          {proseText(event.body).trim() && <p className="line-clamp-3 text-muted">{proseText(event.body).trim()}</p>}
          <div>
            <Button
              size="sm"
              onClick={() => {
                useMentionCard.setState({ card: null });
                openEntry(event.id);
              }}
            >
              Open event
            </Button>
          </div>
        </>
      ) : !entity ? (
        <p className="text-muted">No entry or event has this ID. It may have been deleted.</p>
      ) : (
        <>
          {entity.summary && <Lead size="card">{entity.summary}</Lead>}
          {fields.length > 0 && <FieldRows fields={fields} compact />}
          {card.scene && (
            <section aria-label={`Relationships at “${card.scene.title}”`} className="grid gap-1 border-t border-rule pt-2">
              <p className="text-xs text-muted">At “{card.scene.title}”</p>
              {relationships.length ? (
                <RelationshipLines novel={novel} entityId={entity.id} relationships={relationships} />
              ) : (
                <p className="text-muted">No relationships here.</p>
              )}
            </section>
          )}
          <div>
            <Button
              size="sm"
              onClick={() => {
                useMentionCard.setState({ card: null });
                openEntry(entity.id);
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
