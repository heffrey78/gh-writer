import type { Chapter, Novel, Scene } from "@gh-writer/core";
import { countWords } from "@gh-writer/core";
import {
  caretBlock,
  caretScene,
  findCommands,
  getMarkdown,
  linkCommands,
  liveCounts,
  MENTION_INFO_KEYS,
  mentionAtCaret,
  serializeProse,
  sessionCommands,
  spellCommands,
  writingModeCommands,
  type EditorCommand,
  type Manuscript,
  type MentionTarget,
} from "@gh-writer/editor";
import { ChapterEditor, FindReplace, SceneEditor, WordCount, type SpellService } from "@gh-writer/editor/react";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { create, useStore } from "zustand";
import { joinSceneFile, splitSceneFile } from "@gh-writer/editor";
import { api } from "../api.ts";
import { useCommands } from "../commands.ts";
import type { QuickEntries } from "../bible/quick-entries.ts";
import { useQuickEntry } from "../bible/quick-entry.ts";
import { mentionEntities } from "../bible/types.ts";
import { useCurrentScene } from "./current.ts";
import { EntryPanel, leaveMention, MentionCard, useEntryPanel, useMentionCard } from "./mention-card.tsx";
import { mentionEdits } from "./mention-sync.ts";
import { useNotice } from "./notice.tsx";
import { SceneDetails, useSceneDetails } from "./scene-details.tsx";
import { useStructure } from "./structure.ts";
import { TitleDialog } from "./structure-dialogs.tsx";
import { chapterTitle } from "./navigation.tsx";
import type { Workspace } from "./workspace.ts";

interface Props {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  /** A chapter (continuous) or a single scene. */
  view: { chapter: Chapter } | { scene: Scene; chapter: Chapter | undefined };
  spell: { service: SpellService; onAddWord: (word: string) => void } | undefined;
  /** Where entries made from the @ menu go (see createQuickEntries). */
  entries?: QuickEntries | undefined;
}

/** The editor of the writing view on screen, if any: where a panel opened from elsewhere returns focus. */
export const useWritingEditor = create<{ editor: Editor | undefined }>(() => ({ editor: undefined }));

/** The editor for a chapter or a scene, wired to the workspace's files, with word counts and find and replace. */
export function WritingView({ novelId, novel, workspace, view, spell, entries }: Props) {
  const navigate = useNavigate();
  const files = useStore(workspace.store, (s) => s.files);
  const [editor, setEditor] = useState<Editor>();
  const byId = useMemo(() => new Map(novel.allScenes.map((s) => [s.id, s])), [novel]);
  const scenes = useMemo(
    () => ("scene" in view ? [view.scene] : view.chapter.sceneIds.map((id) => byId.get(id)).filter((s): s is Scene => s !== undefined)),
    [view, byId],
  );
  const paths = scenes.map((s) => s.file);
  const entities = useMemo(() => mentionEntities(novel), [novel]);
  const newEntry = useQuickEntry(novel, entries);
  useEffect(() => {
    if (!editor) return;
    useWritingEditor.setState({ editor });
    return () => {
      if (useWritingEditor.getState().editor === editor) useWritingEditor.setState({ editor: undefined });
    };
  }, [editor]);
  // Focus goes to the text when a chapter or scene is opened, not when it reloads (files renamed by a move).
  const viewId = "scene" in view ? view.scene.id : view.chapter.id;
  const focusedView = useRef<string | undefined>(undefined);
  const autofocus = focusedView.current !== viewId;
  useEffect(() => {
    if (!editor) return;
    const mark = () => void (focusedView.current = viewId);
    if (editor.isFocused) mark();
    editor.on("focus", mark);
    return () => void editor.off("focus", mark);
  }, [editor, viewId]);
  const loaded = paths.every((p) => files[p]);

  useEffect(() => {
    void workspace.open(paths);
  }, [workspace, paths.join("\n")]);

  // Let the workspace see text typed but not reported yet, so a change on disk never replaces it.
  useEffect(() => {
    if (!editor) return;
    const offs = paths.map((path) =>
      workspace.live(path, () => {
        if (editor.isDestroyed) return undefined;
        if (editor.state.doc.type.name !== "chapter") return getMarkdown(editor);
        let md: string | undefined;
        editor.state.doc.forEach((node) => void (node.attrs.id === path && (md = serializeProse(node))));
        return md;
      }),
    );
    return () => offs.forEach((off) => off());
  }, [editor, workspace, paths.join("\n")]);

  // The scene the author is in, for "restore this scene": the open one, or the caret's in a chapter.
  const setCurrent = useCurrentScene((s) => s.set);
  useEffect(() => {
    const byPath = (path: string | undefined) => scenes.find((s) => s.file === path);
    const update = () => {
      const s = "scene" in view ? view.scene : editor && !editor.isDestroyed ? byPath(caretScene(editor)) : scenes[0];
      setCurrent(s ? { id: s.id, title: s.title, path: s.file } : undefined);
    };
    update();
    editor?.on("selectionUpdate", update);
    return () => {
      editor?.off("selectionUpdate", update);
      setCurrent(undefined);
    };
  }, [editor, view, scenes, setCurrent]);

  // The details panel follows the scene the author is in.
  const current = useCurrentScene((s) => s.scene);
  const details = useSceneDetails();
  useCommands(
    () => [{ id: "writing.details", title: details.open ? "Hide scene details" : "Show scene details", group: "Writing", keywords: ["scene details", "panel"], run: details.toggle }],
    [details.open, details.toggle],
  );

  // A new mention of someone or somewhere adds them to the scene's characters or locations.
  const latestNovel = useRef(novel);
  latestNovel.current = novel;
  useEffect(
    () =>
      workspace.onEdit((path, before, after) => {
        const book = latestNovel.current;
        const f = workspace.store.getState().files[path];
        if (!f || !book.allScenes.some((s) => s.file === path)) return;
        const edits = mentionEdits(book, joinSceneFile(f), before, after);
        if (edits.length) void workspace.editFrontMatter(path, edits);
      }),
    [workspace],
  );

  // Mentions: a card on hover or Alt+Enter, and the entry beside the text.
  const entryOpen = useEntryPanel((s) => s.entry !== null);
  useEffect(
    () => () => {
      useMentionCard.getState().hide();
      useEntryPanel.setState({ entry: null });
    },
    [viewId],
  );
  const sceneOf = (sceneId: string | undefined) => ("scene" in view ? view.scene : novel.allScenes.find((s) => s.file === sceneId));
  const onMention = {
    show: (target: MentionTarget) => editor && useMentionCard.getState().show({ ...target, scene: sceneOf(target.sceneId), editor }),
    leave: leaveMention,
  };
  useCommands(
    () => [
      {
        id: "writing.mentionCard",
        title: "Show the mention's card",
        group: "Writing",
        keys: MENTION_INFO_KEYS,
        run: () => {
          const at = editor && !editor.isDestroyed ? mentionAtCaret(editor) : undefined;
          const element = at && (editor!.view.nodeDOM(at.pos) as HTMLElement | null);
          if (!at || !element) return;
          const sceneId = editor!.state.doc.type.name === "chapter" ? (editor!.state.doc.resolve(at.pos).node(1).attrs.id as string) : undefined;
          // After the palette has closed and given focus back.
          requestAnimationFrame(() => onMention.show({ ...at, element, sceneId, via: "keyboard" }));
        },
      },
    ],
    [editor, view],
  );

  // Split the scene at the caret: the paragraph holding it starts the new scene.
  const structure = useStructure(novelId, novel, workspace);
  const [splitting, setSplitting] = useState<{ scene: string; block: number }>();
  const notify = useNotice((s) => s.show);
  useCommands(
    () => [
      {
        id: "writing.split",
        title: "Split the scene at the caret",
        group: "Manuscript",
        run: () => {
          const at = editor && !editor.isDestroyed ? caretBlock(editor) : undefined;
          const scene = at && scenes.find((s) => s.file === at.sceneId);
          if (scene && at.block > 0) setSplitting({ scene: scene.id, block: at.block });
          else if (scene) notify({ message: "The caret is in the scene's first paragraph: put it in the paragraph that should start the new scene." });
        },
      },
    ],
    [editor, scenes],
  );

  // The editor's own commands, run on this editor; their shortcuts work in the text.
  useCommands(() => {
    const group = (c: EditorCommand) => (findCommands.includes(c) ? "Find" : "Writing");
    return [...writingModeCommands, ...sessionCommands, ...findCommands, ...spellCommands, ...linkCommands].map((c: EditorCommand) => ({
      id: c.id,
      title: c.title,
      group: group(c),
      ...(c.keys ? { keys: c.keys } : {}),
      ...(c.isActive ? { isActive: () => c.isActive!() } : {}),
      run: () => c.run(editor),
    }));
  }, [editor]);

  // For the single-scene view, the chapter's count is the other scenes' plus this one's live count.
  const liveScene = useStore(liveCounts, (c) => c.scene);
  const chapterWords =
    "scene" in view && view.chapter
      ? view.chapter.sceneIds.filter((id) => id !== view.scene.id).reduce((n, id) => n + countWords(byId.get(id)?.body ?? ""), liveScene)
      : undefined;

  // Find and replace searches every scene; open ones live in the editor. Scene IDs here are file paths.
  const manuscript: Manuscript = useMemo(
    () =>
      novel.chapters.map((c) => ({
        id: c.id,
        title: chapterTitle(novel, c),
        scenes: c.sceneIds.flatMap((id) => {
          const s = byId.get(id);
          return s ? [{ id: s.file, title: s.title, markdown: s.body }] : [];
        }),
      })),
    [novel, byId],
  );

  const replaceClosed = (changed: { id: string; markdown: string }[]) => {
    for (const { id: path, markdown } of changed) {
      void api.readFile(novelId, path).then(({ content, hash }) => api.writeFile(novelId, path, joinSceneFile({ ...splitSceneFile(content), body: markdown }), hash));
    }
  };

  const openScene = (path: string) => {
    const scene = novel.allScenes.find((s) => s.file === path);
    if (!scene) return;
    // In the chapter view, open the chapter holding it; otherwise the scene.
    if (!("scene" in view) && scene.chapterId) void navigate(`/novels/${novelId}/chapter/${scene.chapterId}`);
    else void navigate(`/novels/${novelId}/scene/${scene.id}`);
  };

  const heading = "scene" in view ? view.scene.title : chapterTitle(novel, view.chapter);

  const detailsScene = current && scenes.find((s) => s.id === current.id);
  const showDetails = !entryOpen && details.open && loaded && detailsScene !== undefined;

  return (
    <div className={entryOpen ? "grid min-h-full lg:grid-cols-[minmax(0,1fr)_28rem]" : showDetails ? "grid min-h-full lg:grid-cols-[minmax(0,1fr)_20rem]" : "min-h-full"}>
      <div className="mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] content-start gap-3 px-6 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold">{heading}</h1>
          <WordCount chapterWords={chapterWords} />
        </div>
        {splitting && (
          <TitleDialog
            title="Split the scene here"
            label="Title of the new scene"
            action="Split"
            submit={(title) => structure.split(splitting.scene, splitting.block, title)}
            onClose={() => setSplitting(undefined)}
          />
        )}
        <FindReplace manuscript={manuscript} editor={editor ?? null} onReplace={replaceClosed} onOpenScene={openScene} />
        {!("scene" in view) && scenes.length === 0 ? (
          <EmptyChapter autofocus={autofocus} onAdd={(title) => structure.createScene(view.chapter.id, title)} />
        ) : !loaded ? (
          <p role="status" className="text-muted">
            Opening…
          </p>
        ) : "scene" in view ? (
          <SceneEditor
            key={view.scene.file}
            sceneId={view.scene.file}
            markdown={files[view.scene.file]!.body}
            onChange={(md) => workspace.change(view.scene.file, md)}
            onReady={setEditor}
            autofocus={autofocus}
            entities={entities}
            newEntry={newEntry}
            onMention={onMention}
            {...(spell ? { spell } : {})}
          />
        ) : (
          <ChapterEditor
            key={view.chapter.id}
            scenes={scenes.map((s) => ({ id: s.file, title: s.title, markdown: files[s.file]!.body }))}
            onChange={(changed) => changed.forEach((c) => workspace.change(c.id, c.markdown))}
            onReady={setEditor}
            autofocus={autofocus}
            entities={entities}
            newEntry={newEntry}
            onMention={onMention}
            {...(spell ? { spell } : {})}
          />
        )}
      </div>
      {showDetails && detailsScene && <SceneDetails key={detailsScene.file} novel={novel} workspace={workspace} path={detailsScene.file} title={detailsScene.title} newEntry={newEntry.create} />}
      <EntryPanel novelId={novelId} novel={novel} workspace={workspace} spell={spell} />
      <MentionCard novel={novel} />
    </div>
  );
}

/** A chapter with no scenes yet: there's nothing to write in until it has one. */
function EmptyChapter({ autofocus, onAdd }: { autofocus: boolean; onAdd: (title: string) => Promise<unknown> }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid justify-items-start gap-3 rounded-lg border border-dashed border-rule px-5 py-6">
      <p>This chapter has no scenes yet.</p>
      <Button autoFocus={autofocus} onClick={() => setAdding(true)}>
        <Plus className="size-4" aria-hidden /> Add a scene
      </Button>
      {adding && <TitleDialog title="New scene" action="Add scene" submit={onAdd} onClose={() => setAdding(false)} />}
    </div>
  );
}
