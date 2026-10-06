import type { Chapter, Novel, Scene } from "@gh-writer/core";
import { countWords } from "@gh-writer/core";
import { caretScene, findCommands, getMarkdown, liveCounts, serializeProse, sessionCommands, spellCommands, writingModeCommands, type EditorCommand, type Manuscript } from "@gh-writer/editor";
import { ChapterEditor, FindReplace, SceneEditor, WordCount, type SpellService } from "@gh-writer/editor/react";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useStore } from "zustand";
import { joinSceneFile, splitSceneFile } from "@gh-writer/editor";
import { api } from "../api.ts";
import { useCommands } from "../commands.ts";
import { useCurrentScene } from "./current.ts";
import { chapterTitle } from "./navigation.tsx";
import type { Workspace } from "./workspace.ts";

interface Props {
  novelId: string;
  novel: Novel;
  workspace: Workspace;
  /** A chapter (continuous) or a single scene. */
  view: { chapter: Chapter } | { scene: Scene; chapter: Chapter | undefined };
  spell: { service: SpellService; onAddWord: (word: string) => void } | undefined;
}

/** The editor for a chapter or a scene, wired to the workspace's files, with word counts and find and replace. */
export function WritingView({ novelId, novel, workspace, view, spell }: Props) {
  const navigate = useNavigate();
  const files = useStore(workspace.store, (s) => s.files);
  const [editor, setEditor] = useState<Editor>();
  const byId = useMemo(() => new Map(novel.allScenes.map((s) => [s.id, s])), [novel]);
  const scenes = useMemo(
    () => ("scene" in view ? [view.scene] : view.chapter.sceneIds.map((id) => byId.get(id)).filter((s): s is Scene => s !== undefined)),
    [view, byId],
  );
  const paths = scenes.map((s) => s.file);
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

  // The editor's own commands, run on this editor; their shortcuts work in the text.
  useCommands(() => {
    const group = (c: EditorCommand) => (findCommands.includes(c) ? "Find" : "Writing");
    return [...writingModeCommands, ...sessionCommands, ...findCommands, ...spellCommands].map((c: EditorCommand) => ({
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

  return (
    <div className="mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] gap-3 px-6 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">{heading}</h1>
        <WordCount chapterWords={chapterWords} />
      </div>
      <FindReplace manuscript={manuscript} editor={editor ?? null} onReplace={replaceClosed} onOpenScene={openScene} />
      {!loaded ? (
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
          autofocus
          {...(spell ? { spell } : {})}
        />
      ) : (
        <ChapterEditor
          key={view.chapter.id}
          scenes={scenes.map((s) => ({ id: s.file, title: s.title, markdown: files[s.file]!.body }))}
          onChange={(changed) => changed.forEach((c) => workspace.change(c.id, c.markdown))}
          onReady={setEditor}
          autofocus
          {...(spell ? { spell } : {})}
        />
      )}
    </div>
  );
}
