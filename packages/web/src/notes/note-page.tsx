import { imageUrl } from "@gh-writer/client";
import { readFrontMatter, type Novel, type Note } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { SceneEditor, type SpellService } from "@gh-writer/editor/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useStore } from "zustand";
import { api, keys } from "../api.ts";
import { realDay } from "../format.ts";
import { AddButton, EditorButtons, EditorFrame, PencilButton, TextEditor, useInPlace } from "../bible/profile.tsx";
import { chapterTitle } from "@gh-writer/core/diagrams";
import { Chips, Group } from "../novel/scene-details.tsx";
import { Picker } from "../ui/picker.tsx";
import { mentionEntities } from "../bible/types.ts";
import { useCommands } from "../commands.ts";
import { useNotice } from "../novel/notice.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { PromoteNoteDialog } from "./promote.tsx";

/**
 * A writer's note (#205): its title, tags and prose, each edited in place, and what it became if it
 * was promoted. Make it an event or Write it as a scene turns it into story; Delete takes it away.
 * The prose and tags save to its file as they're made; a new title moves the file.
 */
export function NotePage({
  novelId,
  novel,
  note,
  workspace,
  spell,
  embedded,
}: {
  novelId: string;
  novel: Novel;
  note: Note;
  workspace: Workspace;
  spell?: { service: SpellService; onAddWord: (w: string) => void } | undefined;
  /** Shown in a modal over the Notes gallery (#235): its title is a level-2 heading with this ID. */
  embedded?: { headingId: string; /** In a modal (#233), the dialog's own top heading. */ modal?: boolean };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const show = useNotice((n) => n.show);
  const file = useStore(workspace.store, (s) => s.files[note.file]);
  const fm = useMemo(() => (file ? (readFrontMatter(joinSceneFile(file)) ?? {}) : {}), [file?.frontMatter]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string") : note.tags;
  const mentions = useMemo(() => mentionEntities(novel), [novel]);
  const proseId = useId();
  const place = useInPlace();
  const [promoting, setPromoting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => void workspace.open([note.file]), [workspace, note.file]);
  useCommands(() => [{ id: "note.promote", title: `Make “${note.title}” an event or a scene`, group: "Notes", keywords: ["promote", "event", "scene"], run: () => setPromoting(true) }], [note.title]);

  // A note just made: the caret goes into its prose, ready to write (#222).
  const { state } = useLocation() as { state: { focusProse?: boolean } | null };
  const prose = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!state?.focusProse || focused.current || !file) return;
    const text = prose.current?.querySelector<HTMLElement>("[contenteditable=true]");
    if (!text) return;
    focused.current = true;
    text.focus();
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  /** The file's current hash, after anything still being saved. */
  const base = async () => {
    await workspace.autosave.flush();
    return workspace.store.getState().files[note.file]?.hash;
  };
  const rename = async (title: string) => {
    const { file: path } = await api.notes.update(novelId, note.id, { title }, await base());
    await workspace.open([path]);
    await refresh();
  };
  const setTags = async (text: string) => {
    const list = [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
    await workspace.editFrontMatter(note.file, [list.length ? { path: ["tags"], value: list } : { path: ["tags"], remove: true }]).catch((e: unknown) => {
      show({ message: `Couldn't change the tags: ${e instanceof Error ? e.message : String(e)}` });
    });
  };
  const sceneTitle = (id: string) => novel.allScenes.find((x) => x.id === id)?.title ?? id;
  const setScenes = async (scenes: string[]) => {
    try {
      await api.notes.update(novelId, note.id, { scenes }, await base());
      // The server wrote the file: the open copy follows.
      await workspace.fileChanged({ type: "change", path: note.file, hash: null });
      await refresh();
    } catch (e) {
      show({ message: `Couldn't change its scenes: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const remove = useMutation({
    mutationFn: async () => api.notes.delete(novelId, note.id, await base()),
    onSuccess: async () => {
      await refresh();
      void navigate(`/novels/${novelId}/notes`);
    },
  });

  const becameScene = note.became ? novel.allScenes.find((s) => s.id === note.became) : undefined;
  const becameEvent = note.became ? novel.events.find((e) => e.id === note.became) : undefined;
  const Heading = embedded && !embedded.modal ? "h2" : "h1";
  return (
    <div className={embedded ? "grid gap-4" : "mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] gap-5 px-6 py-6"}>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <p className="flex-1 text-sm text-muted">Note{note.created && ` · ${realDay(note.created)}`}</p>
          <Button variant="ghost" size="sm" onClick={() => setPromoting(true)}>
            <ArrowUpRight className="size-4" aria-hidden /> Make it an event or a scene
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(true)} disabled={remove.isPending}>
            <Trash2 className="size-4" aria-hidden /> Delete
          </Button>
        </div>
        {place.editing === "title" ? (
          <>
            <Heading id={embedded?.headingId} className="sr-only">
              {note.title}
            </Heading>
            <TextEditor place={place} label="Title" value={note.title} required onSave={rename} />
          </>
        ) : (
          <div className="group flex items-center gap-1">
            <Heading id={embedded?.headingId} className={embedded && !embedded.modal ? "text-xl font-semibold" : "text-2xl font-semibold"}>
              {note.title}
            </Heading>
            <PencilButton place={place} part="title" label="title" />
          </div>
        )}
        {place.editing === "tags" ? (
          <TextEditor place={place} label="Tags" hint="Separated by commas." value={tags.join(", ")} onSave={setTags} />
        ) : tags.length ? (
          <div className="group flex flex-wrap items-center gap-1.5">
            <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <li key={t} className="rounded-full border border-rule px-2 py-0.5 text-xs">
                  {t}
                </li>
              ))}
            </ul>
            <PencilButton place={place} part="tags" label="tags" />
          </div>
        ) : (
          <AddButton place={place} part="tags">
            Add tags
          </AddButton>
        )}
        {place.editing === "scenes" ? (
          <EditorFrame place={place}>
            <Group label="Scenes">
              <Chips items={note.scenes.map((id) => ({ id, label: sceneTitle(id), remove: () => void setScenes(note.scenes.filter((x) => x !== id)) }))} />
              <Picker
                label="Add to scenes"
                items={novel.chapters.flatMap((c) =>
                  c.sceneIds.filter((id) => !note.scenes.includes(id)).map((id) => ({ value: id, label: sceneTitle(id), group: chapterTitle(novel, c) })),
                )}
                value={undefined}
                onChange={(v) => v && void setScenes([...note.scenes, v])}
                placeholder="Add a scene…"
              />
            </Group>
            <EditorButtons onCancel={() => place.done()} hint="Each change is saved as it's made · Esc returns" />
          </EditorFrame>
        ) : note.scenes.length ? (
          <div className="group flex flex-wrap items-center gap-1 text-sm">
            <span className="text-muted">On</span>
            {note.scenes.map((id, i) => (
              <span key={id}>
                {i > 0 && ", "}
                <Link to={`/novels/${novelId}/scene/${id}`} className="text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent">
                  {sceneTitle(id)}
                </Link>
                {note.pinned.includes(id) && <span className="text-muted"> (pinned)</span>}
              </span>
            ))}
            <PencilButton place={place} part="scenes" label="scenes" />
          </div>
        ) : (
          <AddButton place={place} part="scenes">
            Put it on a scene
          </AddButton>
        )}
        {(becameScene || becameEvent) && (
          <p className="text-sm">
            Became {becameScene ? "the scene" : "the off-page event"}{" "}
            <Link
              to={becameScene ? `/novels/${novelId}/scene/${becameScene.id}` : `/novels/${novelId}/event/${becameEvent!.id}`}
              className="text-accent underline decoration-accent/35 underline-offset-[3px] hover:decoration-accent"
            >
              “{becameScene?.title ?? becameEvent!.title}”
            </Link>
            .
          </p>
        )}
      </div>

      <section aria-labelledby={proseId} className="grid gap-1">
        <h2 id={proseId} className="sr-only">
          The note
        </h2>
        {file ? (
          <div ref={prose} className="-mx-1 rounded-md px-1 focus-within:bg-panel/60">
            <SceneEditor
              key={note.file}
              sceneId={note.file}
              label={`Note: ${note.title}`}
              placeholder="What if…"
              markdown={file.body}
              onChange={(md) => workspace.change(note.file, md)}
              entities={mentions}
              pictureUrl={(path) => imageUrl(novelId, path)}
              className="ghw-notes"
              {...(spell ? { spell } : {})}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">Opening…</p>
        )}
      </section>

      {promoting && <PromoteNoteDialog novelId={novelId} novel={novel} note={note} flush={() => workspace.autosave.flush()} open onOpenChange={setPromoting} />}
      <Confirm open={deleting} onOpenChange={setDeleting} title={`Delete “${note.title}”?`} description="The note goes from the novel. It stays in the history." action="Delete" danger onConfirm={() => remove.mutate()} />
      {remove.isError && <ErrorAlert title="Couldn't delete it">{remove.error.message}</ErrorAlert>}
    </div>
  );
}
