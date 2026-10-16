import { imageUrl } from "@gh-writer/client";
import { notesOfScene, proseText, readFrontMatter, type Note, type Novel, type Scene } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { SceneEditor, type SpellService } from "@gh-writer/editor/react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pin, Plus, Unlink } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { create, useStore } from "zustand";
import { api, keys } from "../api.ts";
import { AddButton, PencilButton, TextEditor, useInPlace } from "../bible/profile.tsx";
import { mentionEntities } from "../bible/types.ts";
import { useNotice } from "../novel/notice.tsx";
import type { Workspace } from "../novel/workspace.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Picker } from "../ui/picker.tsx";

/** A new note asked for on the open scene (the palette's New note on this scene), until the tab takes it up. */
export const useSceneNotes = create<{ pending: boolean; request: () => void }>((set) => ({ pending: false, request: () => set({ pending: true }) }));

type Spell = { service: SpellService; onAddWord: (w: string) => void } | undefined;

/**
 * The right sidebar's Notes tab (#222): the notes on the scene the caret is in, as sticky-note cards,
 * the one pinned there first, then newest. A card is truncated until opened, when it expands in place
 * to edit its title, tags and prose, pin it here, take it off this scene, or open its page. + Note makes
 * one on the scene, opened, with the caret in its prose; Add a note puts one already written on it too (#238).
 */
export function SceneNotes({ novelId, novel, workspace, scene, spell }: { novelId: string; novel: Novel; workspace: Workspace; scene: Scene; spell: Spell }) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  const headingId = useId();
  const notes = useMemo(() => notesOfScene(novel, scene.id), [novel, scene.id]);
  const [expanded, setExpanded] = useState<string>();
  const [justMade, setJustMade] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // Asked for from the palette, perhaps before this tab was showing.
  const pending = useSceneNotes((s) => s.pending);
  useEffect(() => {
    if (!pending) return;
    useSceneNotes.setState({ pending: false });
    setAdding(true);
  }, [pending]);

  // Notes not on this scene yet: those on none first, then those on others.
  const others = useMemo(() => {
    const sceneTitle = (id: string) => novel.allScenes.find((x) => x.id === id)?.title ?? id;
    const off = novel.notes.filter((n) => !n.scenes.includes(scene.id));
    return [...off.filter((n) => !n.scenes.length), ...off.filter((n) => n.scenes.length)].map((n) => ({
      value: n.id,
      label: n.title,
      group: n.scenes.length ? "On other scenes" : "On no scene",
      keywords: [...n.tags, ...n.scenes.map(sceneTitle)],
    }));
  }, [novel, scene.id]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  const addExisting = async (id: string) => {
    const note = novel.notes.find((n) => n.id === id);
    if (!note || busy) return;
    setBusy(true);
    try {
      await workspace.autosave.flush();
      await api.notes.update(novelId, id, { scenes: [...note.scenes, scene.id] });
      // The server wrote the note's file: an open copy follows.
      await workspace.fileChanged({ type: "change", path: note.file, hash: null });
      await refresh();
      setExpanded(id);
    } catch (err) {
      show({ message: `Couldn't add the note: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };
  const create_ = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const { id } = await api.notes.create(novelId, { title: title.trim(), scenes: [scene.id] });
      await refresh();
      setTitle("");
      setAdding(false);
      setExpanded(id);
      setJustMade(id);
    } catch (err) {
      show({ message: `Couldn't add the note: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="grid content-start gap-3 p-4 text-sm">
      <div className="flex items-center gap-2">
        <h2 id={headingId} className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">
          Notes on “{scene.title}”
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)} aria-label="New note on this scene" title="New note on this scene">
          <Plus className="size-4" aria-hidden /> Note
        </Button>
      </div>
      {adding && (
        <form onSubmit={(e) => void create_(e)} className="grid gap-1.5 rounded-md border border-l-4 border-rule border-l-warn/60 bg-raised p-2">
          <label className="grid gap-1 text-xs font-medium">
            Title of the new note
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setAdding(false);
                  setTitle("");
                }
              }}
              placeholder="What if…"
              className="h-8 rounded-md border border-rule bg-raised px-2 text-sm font-normal"
            />
          </label>
          <span className="text-xs text-muted">Enter adds it · Esc cancels</span>
        </form>
      )}
      {notes.length ? (
        <ul aria-label={`Notes on “${scene.title}”`} className="grid gap-2">
          {notes.map((n) => (
            <li key={n.id}>
              <NoteCard
                novelId={novelId}
                novel={novel}
                workspace={workspace}
                note={n}
                scene={scene}
                spell={spell}
                open={expanded === n.id}
                justMade={justMade === n.id}
                onToggle={() => setExpanded(expanded === n.id ? undefined : n.id)}
                refresh={refresh}
              />
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="text-muted">No notes on this scene yet. + Note makes one, kept beside the text while you write{others.length > 0 && ", or add one already written below"}.</p>
      )}
      {/* After the scene's own notes: bringing in another is the less usual thing to do. */}
      {others.length > 0 && <Picker label="Add a note already written" items={others} value={undefined} onChange={(v) => v && void addExisting(v)} placeholder="Choose a note…" className="border-t border-rule pt-3" />}
    </section>
  );
}

function NoteCard({
  novelId,
  novel,
  workspace,
  note,
  scene,
  spell,
  open,
  justMade,
  onToggle,
  refresh,
}: {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  note: Note;
  scene: Scene;
  spell: Spell;
  open: boolean;
  justMade: boolean;
  onToggle: () => void;
  refresh: () => Promise<unknown>;
}) {
  const show = useNotice((n) => n.show);
  const file = useStore(workspace.store, (s) => s.files[note.file]);
  const fm = useMemo(() => (file ? (readFrontMatter(joinSceneFile(file)) ?? {}) : {}), [file?.frontMatter]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string") : note.tags;
  const text = proseText(file?.body ?? note.body).replace(/\s+/g, " ").trim();
  const pinned = note.pinned.includes(scene.id);
  const mentions = useMemo(() => mentionEntities(novel), [novel]);
  const place = useInPlace();
  const card = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  useEffect(() => {
    if (open) void workspace.open([note.file]);
  }, [open, workspace, note.file]);
  // Just made: the caret goes into its prose once it's there.
  const focused = useRef(false);
  useEffect(() => {
    if (!justMade || !open || focused.current || !file) return;
    const prose = card.current?.querySelector<HTMLElement>("[contenteditable=true]");
    if (!prose) return;
    focused.current = true;
    prose.focus();
  });

  const act = async (what: string, run: () => Promise<unknown>) => {
    try {
      await workspace.autosave.flush();
      await run();
      // The server wrote this note's file (and, pinning, perhaps another's): open copies follow.
      for (const n of novel.notes.filter((x) => x.scenes.includes(scene.id) || x.id === note.id)) await workspace.fileChanged({ type: "change", path: n.file, hash: null });
      await refresh();
    } catch (e) {
      show({ message: `Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  const base = async () => {
    await workspace.autosave.flush();
    return workspace.store.getState().files[note.file]?.hash;
  };

  return (
    <div
      ref={card}
      // A sticky note: its coloured edge, on the raised surface (so muted text keeps its contrast).
      className={cn("grid gap-1.5 rounded-md border border-l-4 border-rule border-l-warn/60 bg-raised p-2.5 shadow-sm", pinned && "border-l-warn", justMade && "ghw-just-made")}
    >
      <div className="flex items-start gap-1">
        {pinned && <Pin className="mt-0.5 size-3.5 shrink-0 text-warn" fill="currentColor" aria-label="Pinned here" />}
        {open && place.editing === "title" ? (
          <div className="flex-1">
            <TextEditor
              place={place}
              label="Title"
              value={note.title}
              required
              onSave={async (t) => {
                const { file: path } = await api.notes.update(novelId, note.id, { title: t }, await base());
                await workspace.open([path]);
                await refresh();
              }}
            />
          </div>
        ) : (
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} className="flex-1 text-left font-semibold underline-offset-2 hover:underline">
            {note.title}
          </button>
        )}
        {open && place.editing !== "title" && <PencilButton place={place} part="title" label="title" />}
      </div>
      {!open ? (
        <>
          {text && <p className="line-clamp-3 font-prose text-[15px] leading-snug">{text}</p>}
          {tags.length > 0 && <p className="text-xs text-muted">{tags.join(" · ")}</p>}
        </>
      ) : (
        <div id={bodyId} className="grid gap-2">
          {place.editing === "tags" ? (
            <TextEditor
              place={place}
              label="Tags"
              hint="Separated by commas."
              value={tags.join(", ")}
              onSave={async (v) => {
                const list = [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))];
                await workspace.editFrontMatter(note.file, [list.length ? { path: ["tags"], value: list } : { path: ["tags"], remove: true }]);
              }}
            />
          ) : tags.length ? (
            <div className="group flex flex-wrap items-center gap-1 text-xs text-muted">
              <span>{tags.join(" · ")}</span>
              <PencilButton place={place} part="tags" label="tags" />
            </div>
          ) : (
            <AddButton place={place} part="tags">
              Add tags
            </AddButton>
          )}
          {file ? (
            <div className="-mx-1 rounded-md bg-raised/60 px-1">
              <SceneEditor
                key={note.file}
                sceneId={note.file}
                label={`Note: ${note.title}`}
                placeholder="What if…"
                markdown={file.body}
                onChange={(md) => workspace.change(note.file, md)}
                entities={mentions}
                pictureUrl={(path) => imageUrl(novelId, path)}
                className="ghw-notes [--ghw-prose-size:1rem]"
                {...(spell ? { spell } : {})}
              />
            </div>
          ) : (
            <p className="text-muted">Opening…</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="ghost" aria-pressed={pinned} onClick={() => void act(pinned ? "unpin it" : "pin it", () => api.notes.pin(novelId, note.id, scene.id, !pinned))}>
              <Pin className="size-3.5" fill={pinned ? "currentColor" : "none"} aria-hidden /> {pinned ? "Unpin" : "Pin to the top"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void act("take it off this scene", () => api.notes.update(novelId, note.id, { scenes: note.scenes.filter((s) => s !== scene.id) }))}>
              <Unlink className="size-3.5" aria-hidden /> Take off this scene
            </Button>
            <Link to={`/novels/${novelId}/note/${note.id}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-paper">
              <ExternalLink className="size-3.5" aria-hidden /> Open the note
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
