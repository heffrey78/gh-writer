import type { Reference } from "@gh-writer/client";
import { imageUrl } from "@gh-writer/client";
import { readFrontMatter, sceneNeighbours, storyTimeline, type Novel, type StoryEvent, type YamlEdit } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { SceneEditor, type SpellService } from "@gh-writer/editor/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PenLine, Trash2 } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useStore } from "zustand";
import { api, keys } from "../api.ts";
import { AddButton, EditorButtons, EditorFrame, Lead, PencilButton, ProfileSection, TextEditor, useInPlace, type InPlace } from "../bible/profile.tsx";
import { mentionEntities } from "../bible/types.ts";
import { useNotice } from "../novel/notice.tsx";
import { Chips, Group, StoryTimeFields, whenOf } from "../novel/scene-details.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Picker } from "../ui/picker.tsx";
import { useCommands } from "../commands.ts";
import { NotesAbout } from "../notes/notes-about.tsx";
import { useFormatMove } from "./format-move.tsx";
import { WriteAsSceneDialog } from "./write-as-scene.tsx";

/** Who, where and which plotlines: the lists an event names, with their entry types. */
const LISTS = [
  { key: "characters", label: "Who", group: "Characters", type: "character" },
  { key: "locations", label: "Where", group: "Locations", type: "location" },
  { key: "plotlines", label: "Plotlines", group: "Plotlines", type: "plotline" },
] as const;

/**
 * An off-page event as a profile (#165), in the design of an entry's (#148): its title, when and how
 * long as the lead, who, where and its plotlines as rows, its note as prose, and where it falls among
 * the scenes in story time. Each part edits in place, saved to the event's file as it's made, like a
 * scene card's details. In a novel in format v1, the first change asks to move it to v2 (D11).
 */
export function EventPage({
  novelId,
  novel,
  event,
  workspace,
  spell,
  embedded,
  size = "page",
}: {
  novelId: string;
  novel: Novel;
  event: StoryEvent;
  workspace: Workspace;
  spell?: { service: SpellService; onAddWord: (w: string) => void } | undefined;
  /** Shown in a side panel beside the text, or in a modal over the Story bible (#236): its title is a level-2 heading with this ID. */
  embedded?: { headingId: string; /** In a modal (#233), the dialog's own top heading. */ modal?: boolean };
  /** The whole page, or the right sidebar's Entry tab, which leaves out delete and links to the page. */
  size?: "page" | "tab";
}) {
  const tab = size === "tab";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const show = useNotice((n) => n.show);
  const { ensure, dialog } = useFormatMove(novelId, novel);
  // In format v1 the event has no file of its own: what's shown is the model's, until it's moved.
  const own = event.index === undefined;
  const file = useStore(workspace.store, (s) => (own ? s.files[event.file] : undefined));
  const fm = useMemo(() => (file ? (readFrontMatter(joinSceneFile(file)) ?? {}) : fromModel(event)), [file?.frontMatter, event]); // eslint-disable-line react-hooks/exhaustive-deps
  const mentions = useMemo(() => mentionEntities(novel), [novel]);
  const notesId = useId();
  const inPlace = useInPlace();
  // Every part's pencil asks to move a v1 novel first.
  const place: InPlace = { ...inPlace, start: (key: string) => ensure(() => inPlace.start(key)) };

  useEffect(() => {
    if (own) void workspace.open([event.file]);
  }, [workspace, own, event.file]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  /** The file's current hash, after anything still being saved. */
  const base = async () => {
    await workspace.autosave.flush();
    return workspace.store.getState().files[event.file]?.hash;
  };
  const edit = (edits: YamlEdit[]) =>
    void workspace.editFrontMatter(event.file, edits).catch((e: unknown) => show({ message: `Couldn't change the event: ${e instanceof Error ? e.message : String(e)}` }));
  const rename = async (title: string) => {
    const b = await base();
    const { file: path } = await api.bible.updateEvent(novelId, event.id, { title }, b ? { base: b } : {});
    await workspace.open([path]);
    await refresh();
  };

  const [references, setReferences] = useState<Reference[]>();
  const [writing, setWriting] = useState(false);
  useCommands(() => (tab ? [] : [{ id: "event.writeAsScene", title: `Write “${event.title}” as a scene`, group: "Off the page", run: () => setWriting(true) }]), [tab, event.title]);
  const remove = useMutation({
    mutationFn: async (confirm: boolean) => {
      const b = await base();
      return api.bible.deleteEvent(novelId, event.id, { confirm, ...(b ? { base: b } : {}) });
    },
    onSuccess: async (result) => {
      if (!result.ok) return setReferences(result.references);
      setReferences(undefined);
      await refresh();
      void navigate(`/novels/${novelId}/bible#off-the-page`);
    },
  });

  const when = fm.when && typeof fm.when === "object" ? (fm.when as { at?: string; day?: number; time?: string }) : undefined;
  const time = whenOf(fm);
  const list = (key: string) => (Array.isArray(fm[key]) ? (fm[key] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const entryLink = (id: string) => (
    <Link key={id} to={`/novels/${novelId}/bible/${id}`} className="underline decoration-rule underline-offset-[3px] hover:decoration-ink">
      {name(id)}
    </Link>
  );
  const { before, after } = useMemo(() => sceneNeighbours(storyTimeline(novel), event.id), [novel, event.id]);
  const sceneLink = (id: string, title: string) => (
    <Link to={`/novels/${novelId}/scene/${id}`} className="text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
      “{title}”
    </Link>
  );
  const dramatized = novel.allScenes.find((s) => s.id === fm.scene);

  const Heading = embedded && !embedded.modal ? "h2" : "h1";
  return (
    <div className={embedded ? (tab ? "grid gap-4" : "grid gap-5") : "mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] gap-5 px-6 py-6"}>
      <div className="grid gap-1.5">
        {!tab && (
          <div className={cn("flex items-center gap-2", embedded && "pr-8")}>
            <p className="flex-1 text-sm text-muted">
              <Link to={`/novels/${novelId}/bible#off-the-page`} className="underline-offset-2 hover:underline">
                Story bible
              </Link>{" "}
              · Off the page
            </p>
            <Button variant="ghost" size="sm" onClick={() => setWriting(true)}>
              <PenLine className="size-4" aria-hidden /> Write it as a scene
            </Button>
            <Button variant="ghost" size="sm" onClick={() => ensure(() => remove.mutate(false))} disabled={remove.isPending}>
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
          </div>
        )}
        {place.editing === "title" ? (
          <>
            <Heading id={embedded?.headingId} className="sr-only">
              {event.title}
            </Heading>
            <TextEditor place={place} label="Title" value={event.title} required onSave={rename} />
          </>
        ) : (
          <div className="group flex items-center gap-1">
            <Heading id={embedded?.headingId} className={embedded && !embedded.modal ? "text-xl font-semibold" : "text-2xl font-semibold"}>
              {event.title}
            </Heading>
            <PencilButton place={place} part="title" label="title" />
          </div>
        )}
      </div>

      {place.editing === "when" ? (
        <EditorFrame place={place}>
          <StoryTimeFields when={when} duration={typeof fm.duration === "string" ? fm.duration : ""} edit={edit} novel={novel} />
          <EditorButtons onCancel={() => place.done()} hint="Each change is saved as it's made · Esc returns" />
        </EditorFrame>
      ) : time.when || time.duration ? (
        <div className="group flex items-start gap-1">
          <div className="flex-1">
            <Lead size={tab ? "tab" : "page"}>
              {time.when || "Some time"}
              {time.duration && <span className="text-muted"> · {time.duration}</span>}
            </Lead>
          </div>
          <PencilButton place={place} part="when" label="when and how long" />
        </div>
      ) : (
        <AddButton place={place} part="when">
          Add when it happens
        </AddButton>
      )}

      <dl aria-label="Who, where and plotlines" className="grid gap-0.5">
        {LISTS.map(({ key, label, group, type }) => {
          const chosen = list(key);
          return (
            <Row key={key} label={label} compact={tab}>
              {place.editing === key ? (
                <EditorFrame place={place} className="flex-1">
                  <Group label={group}>
                    <Chips items={chosen.map((id, i) => ({ id, label: name(id), remove: () => edit([chosen.length === 1 ? { path: [key], remove: true } : { path: [key, i], remove: true }]) }))} />
                    <Picker
                      label={`Add to ${group.toLowerCase()}`}
                      items={novel.entities
                        .filter((e) => e.type === type && !chosen.includes(e.id))
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((e) => ({ value: e.id, label: e.name, keywords: e.aliases }))}
                      value={undefined}
                      onChange={(v) => v && edit([chosen.length ? { path: [key, chosen.length], value: v } : { path: [key], value: [v] }])}
                      placeholder={`Add ${type === "location" ? "a location" : type === "character" ? "a character" : "a plotline"}…`}
                    />
                  </Group>
                  <EditorButtons onCancel={() => place.done()} hint="Each change is saved as it's made · Esc returns" />
                </EditorFrame>
              ) : (
                <>
                  <span className="flex-1">{chosen.length ? chosen.map((id, i) => [i > 0 && ", ", entryLink(id)]) : <span className="text-muted">None</span>}</span>
                  <PencilButton place={place} part={key} label={label.toLowerCase()} />
                </>
              )}
            </Row>
          );
        })}
      </dl>

      <section aria-labelledby={notesId} className="grid gap-1 border-t border-rule pt-4">
        <h2 id={notesId} className="text-xs font-semibold tracking-wide text-muted uppercase">
          Note
        </h2>
        {file ? (
          <div className="-mx-1 rounded-md px-1 focus-within:bg-panel/60">
            <SceneEditor
              key={event.file}
              sceneId={event.file}
              label={`Note on ${event.title}`}
              placeholder="What happens, and why it matters…"
              markdown={file.body}
              onChange={(md) => workspace.change(event.file, md)}
              entities={mentions}
              pictureUrl={(path) => imageUrl(novelId, path)}
              className="ghw-notes"
              {...(spell ? { spell } : {})}
            />
          </div>
        ) : own ? (
          <p className="text-sm text-muted">Opening…</p>
        ) : (
          <div className="group flex items-start gap-1">
            <p className="flex-1 font-prose">{event.body || <span className="text-muted">No note yet.</span>}</p>
            <PencilButton place={place} part="note" label="the note" />
          </div>
        )}
      </section>

      <ProfileSection title="In story time">
        <p className="text-sm">
          {!time.when ? (
            "Not placed in story time: give it a time to see it among the scenes."
          ) : before || after ? (
            <>
              {before && <>After {sceneLink(before.id, before.title)}</>}
              {before && after && ", "}
              {after && <>{before ? "before" : "Before"} {sceneLink(after.id, after.title)}</>}.
            </>
          ) : (
            "No scene is placed near it in story time."
          )}
        </p>
        {dramatized && <p className="text-sm">Written as the scene {sceneLink(dramatized.id, dramatized.title)}.</p>}
      </ProfileSection>

      <NotesAbout novelId={novelId} novel={novel} id={event.id} />

      {tab && (
        <Link to={`/novels/${novelId}/event/${event.id}`} className="justify-self-start text-sm text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
          Open the full event
        </Link>
      )}

      {dialog}
      {writing && <WriteAsSceneDialog novelId={novelId} novel={novel} event={event} open onOpenChange={setWriting} />}
      <AlertDialog.Root open={references !== undefined} onOpenChange={(o) => !o && setReferences(undefined)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 z-[60] grid max-h-[80vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl">
            <AlertDialog.Title className="text-base font-semibold">Delete “{event.title}”? The story still mentions it.</AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted">These mentions will point at an event that no longer exists, and the validator will list them until they're changed:</AlertDialog.Description>
            <ul className="grid gap-1 text-sm">
              {references?.map((r) => (
                <li key={`${r.kind}:${r.id}`}>{r.kind === "scene" ? `Scene “${r.title}”` : r.kind === "entity" ? `Entry “${r.title}”` : r.kind === "event" ? `Event “${r.title}”` : r.kind === "note" ? `Note “${r.title}”` : r.id}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Keep it</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant="danger" onClick={() => remove.mutate(true)}>
                  Delete anyway
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      {remove.isError && <ErrorAlert title="Couldn't delete it">{remove.error.message}</ErrorAlert>}
    </div>
  );
}

/** A row of the profile: its name, then its value or its editor. */
function Row({ label, compact, children }: { label: string; compact?: boolean; children: ReactNode }) {
  return (
    <div className={`group -mx-1.5 flex items-baseline gap-2.5 rounded-md px-1.5 ${compact ? "py-0.5" : "py-1"}`}>
      <dt className={`shrink-0 text-[13px] text-muted ${compact ? "w-24" : "w-32"}`}>{label}</dt>
      <dd className="flex min-w-0 flex-1 items-baseline gap-1">{children}</dd>
    </div>
  );
}

/** An event's fields as front matter would hold them, from the model (an event of format v1, with no file). */
function fromModel(e: StoryEvent): Record<string, unknown> {
  return { ...(e.when ? { when: e.when } : {}), ...(e.duration ? { duration: e.duration } : {}), characters: e.characters ?? [], locations: e.locations ?? [], plotlines: e.plotlines ?? [], ...(e.scene ? { scene: e.scene } : {}) };
}
