import type { Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { api, keys } from "../api.ts";
import { EntryPage } from "../bible/entry-page.tsx";
import { EventPage } from "../events/event-page.tsx";
import { FORMAT_MOVE, needsFormatMove } from "../events/format-move.tsx";
import { NotePage } from "../notes/note-page.tsx";
import { ItemModal, NewItem, useCloseTo, type OverState } from "../ui/item-modal.tsx";
import type { useSpell } from "./spell.ts";
import type { Workspace } from "./workspace.ts";

/*
 * The modals over the galleries (#233): /note/<id> over Notes, /event/<id> and /bible/<id> over the
 * Story bible; /note/new, /event/new and /bible/new (?type=) make one, starting from its title.
 */

type Props = { novelId: string; novel: Novel; workspace: Workspace; spell: ReturnType<typeof useSpell> };

/** Once made, the item in the same modal, the address naming it (in place of …/new). */
function useMade(novelId: string, kind: "note" | "event" | "bible") {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useLocation().state as OverState;
  return async (id: string) => {
    await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
    void navigate(`/novels/${novelId}/${kind}/${id}`, { replace: true, state: { ...state, focusProse: true } });
  };
}

function Gone({ what }: { what: string }) {
  return (
    <div className="grid gap-2">
      <h2 className="text-xl font-semibold">No such {what}</h2>
      <p className="text-muted">It may have been deleted.</p>
    </div>
  );
}

/** A note over the Notes gallery (#235). */
export function NoteOver({ novelId, novel, workspace, spell }: Props) {
  const { noteId } = useParams();
  const close = useCloseTo(`/novels/${novelId}/notes`);
  const made = useMade(novelId, "note");
  const headingId = useId();
  const note = novel.notes.find((n) => n.id === noteId);
  return (
    <ItemModal title={noteId === "new" ? "New note" : (note?.title ?? "Note")} onClose={close}>
      {noteId === "new" ? (
        <NewItem heading="New note" label="Title" placeholder="What if…" make={async (title) => made((await api.notes.create(novelId, { title })).id)} />
      ) : note ? (
        <NotePage key={note.id} novelId={novelId} novel={novel} note={note} workspace={workspace} spell={spell} embedded={{ headingId, modal: true }} />
      ) : (
        <Gone what="note" />
      )}
    </ItemModal>
  );
}

/** An off-page event over the Story bible (#236). Made in a novel in format v1, it moves the novel to v2 (D11). */
export function EventOver({ novelId, novel, workspace, spell }: Props) {
  const { eventId } = useParams();
  const close = useCloseTo(`/novels/${novelId}/bible#off-the-page`);
  const made = useMade(novelId, "event");
  const headingId = useId();
  const event = novel.events.find((e) => e.id === eventId);
  const moving = needsFormatMove(novel);
  return (
    <ItemModal title={eventId === "new" ? "New off-page event" : (event?.title ?? "Off-page event")} onClose={close}>
      {eventId === "new" ? (
        <NewItem heading="New off-page event" label="Title" placeholder="The flood of '09" make={async (title) => made((await api.bible.createEvent(novelId, { title }, { migrate: moving })).id)}>
          {moving && <p className="text-sm text-muted">{FORMAT_MOVE}</p>}
        </NewItem>
      ) : event ? (
        <EventPage key={event.id} novelId={novelId} novel={novel} event={event} workspace={workspace} spell={spell} embedded={{ headingId, modal: true }} />
      ) : (
        <Gone what="event" />
      )}
    </ItemModal>
  );
}

/** A story bible entry over the gallery (#237); a new one by its type (unless the address names it) and name. */
export function EntryOver({ novelId, novel, workspace, spell }: Props) {
  const { entityId } = useParams();
  const [params] = useSearchParams();
  const close = useCloseTo(`/novels/${novelId}/bible`);
  const made = useMade(novelId, "bible");
  const headingId = useId();
  const typeId = useId();
  const entity = novel.entities.find((e) => e.id === entityId);
  const asked = params.get("type") ?? undefined;
  const [chosen, setChosen] = useState(novel.entityTypes.some((t) => t.key === asked) ? asked! : (novel.entityTypes[0]?.key ?? "character"));
  const label = (novel.entityTypes.find((t) => t.key === chosen)?.label ?? "entry").toLowerCase();
  return (
    <ItemModal title={entityId === "new" ? `New ${label}` : (entity?.name ?? "Entry")} onClose={close}>
      {entityId === "new" ? (
        <NewItem heading={`New ${label}`} label="Name" make={async (name) => made((await api.bible.createEntity(novelId, chosen, { name })).id)}>
          {!asked && (
            <label htmlFor={typeId} className="flex items-center gap-2 text-sm text-muted">
              Type
              <select id={typeId} value={chosen} onChange={(e) => setChosen(e.target.value)} className="h-8 rounded-md border border-rule bg-raised px-2 text-ink">
                {novel.entityTypes.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </NewItem>
      ) : entity ? (
        <EntryPage key={entity.id} novelId={novelId} novel={novel} entity={entity} workspace={workspace} spell={spell} embedded={{ headingId, modal: true }} />
      ) : (
        <Gone what="entry" />
      )}
    </ItemModal>
  );
}
