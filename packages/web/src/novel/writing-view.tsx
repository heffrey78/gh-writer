import { readAnchor, readFrontMatter, type Chapter, type Novel, type Scene } from "@gh-writer/core";
import { countWords } from "@gh-writer/core";
import {
  appContextMenu,
  caretBlock,
  caretScene,
  contributeMenuItems,
  findCommands,
  getMarkdown,
  insertPicture,
  linkCommands,
  liveCounts,
  MENTION_INFO_KEYS,
  mentionAtCaret,
  pictureAt,
  serializeProse,
  sessionCommands,
  setPicture,
  spellCommands,
  structureCommands,
  writingModeCommands,
  type EditorCommand,
  type Manuscript,
  type MentionTarget,
  type PictureCallbacks,
} from "@gh-writer/editor";
import { ChapterEditor, FindReplace, SceneEditor, useWritingModes, WordCount, type SpellService } from "@gh-writer/editor/react";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { create, useStore } from "zustand";
import { joinSceneFile, splitSceneFile } from "@gh-writer/editor";
import { imageUrl } from "@gh-writer/client";
import { api } from "../api.ts";
import { useCommands } from "../commands.ts";
import type { QuickEntries } from "../bible/quick-entries.ts";
import { NameEntryDialog } from "../bible/name-entry.tsx";
import { useGitHubRepo } from "../github/repo.ts";
import { RaisePanel, selectedPassage, useRaise } from "../issues/raise.tsx";
import { IssuePanel, useIssuePanel } from "../issues/issue-panel.tsx";
import { useIssueList } from "../issues/use-issues.ts";
import { useQuickEntry } from "../bible/quick-entry.ts";
import { mentionEntities } from "../bible/types.ts";
import { useCurrentScene } from "./current.ts";
import { EntryTab, useEntryPanel } from "./entry-tab.tsx";
import { SceneNotes, useSceneNotes } from "../notes/scene-notes.tsx";
import { leaveMention, MentionCard, useMentionCard } from "./mention-card.tsx";
import { mentionEdits } from "./mention-sync.ts";
import { useNotice } from "./notice.tsx";
import { RightSidebar, useRightSidebar } from "./right-sidebar.tsx";
import { pinnedLine, SceneDetails, usePins } from "./scene-details.tsx";
import { TodayCount } from "./today-count.tsx";
import { useStructure } from "./structure.ts";
import { TitleDialog } from "./structure-dialogs.tsx";
import { chapterTitle } from "./navigation.tsx";
import { PictureInTextDialog, type PictureRequest } from "./picture-in-text.tsx";
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

  // Pictures in the text load from the server's images route.
  const pictureUrl = useCallback((path: string) => imageUrl(novelId, path), [novelId]);
  // A picture to add (dropped, pasted or from the palette) or change (Enter or a double-click on it): asked about in a dialog (#203).
  const [pictureRequest, setPictureRequest] = useState<PictureRequest>();
  const pictures: PictureCallbacks = {
    add: (files, at) => setPictureRequest({ kind: "add", at, ...(files[0] ? { file: files[0] } : {}) }),
    edit: (at) => {
      const picture = editor && !editor.isDestroyed ? pictureAt(editor, at) : undefined;
      if (picture) setPictureRequest({ kind: "edit", at, picture });
    },
  };
  useCommands(
    () => [
      {
        id: "writing.insertPicture",
        title: "Insert a picture…",
        group: "Writing",
        keywords: ["image", "map", "illustration", "figure"],
        run: () => editor && !editor.isDestroyed && setPictureRequest({ kind: "add", at: editor.state.selection.from }),
      },
    ],
    [editor],
  );

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

  // The right sidebar: the Scene tab follows the scene the author is in.
  const current = useCurrentScene((s) => s.scene);
  const sidebar = useRightSidebar();
  const entryShown = useEntryPanel((s) => s.history[s.at]);
  const focusMode = useWritingModes((m) => m.focus);
  useCommands(
    () => [
      {
        id: "writing.sidebar",
        title: sidebar.open ? "Hide the right sidebar" : "Show the right sidebar",
        group: "Writing",
        keys: "Mod-Shift-\\",
        keywords: ["scene details", "entry", "panel"],
        run: sidebar.toggle,
      },
      { id: "writing.sceneTab", title: "Show the scene's details", group: "Writing", keywords: ["sidebar", "panel"], run: () => sidebar.show("scene") },
      { id: "writing.entryTab", title: "Show the open entry", group: "Writing", keywords: ["sidebar", "story bible", "panel"], run: () => sidebar.show("entry") },
      { id: "writing.notesTab", title: "Show the scene's notes", group: "Writing", keywords: ["sidebar", "panel", "sticky"], run: () => sidebar.show("notes") },
      {
        id: "writing.newSceneNote",
        title: "New note on this scene",
        group: "Notes",
        keywords: ["idea", "sticky", "brainstorm"],
        run: () => {
          sidebar.show("notes");
          useSceneNotes.getState().request();
        },
      },
    ],
    [sidebar.open, sidebar.toggle, sidebar.show],
  );
  const toText = () => {
    if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
  };

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

  // Mentions: a card on hover or Alt+Enter, and the entry on the sidebar's Entry tab.
  useEffect(
    () => () => {
      useMentionCard.getState().hide();
      useRaise.setState({ passage: undefined, editor: undefined });
      useIssuePanel.setState({ numbers: [], editor: undefined });
    },
    [viewId],
  );

  // Issues about a passage (#9), for a novel on GitHub: from a command, or the selection's context menu.
  const repo = useGitHubRepo(novelId);
  const raising = useRaise((s) => s.passage !== undefined);
  const issueOpen = useIssuePanel((s) => s.numbers.length > 0);
  // Open issues about passages, beside them in the margin.
  const openIssues = useIssueList(novelId, { state: "open" }, { enabled: !!repo });
  const anchored = useMemo(
    () =>
      repo
        ? (openIssues.data?.issues ?? []).flatMap((i) => {
            const anchor = readAnchor(i.body);
            const scene = anchor && novel.allScenes.find((s) => s.id === anchor.scene);
            return anchor && scene ? [{ number: i.number, title: i.title, scene: scene.file, quote: anchor.quote }] : [];
          })
        : [],
    [repo, openIssues.data, novel],
  );
  const issueMarks = {
    issues: anchored,
    onOpen: (numbers: number[]) => {
      if (!editor || editor.isDestroyed) return;
      useRaise.setState({ passage: undefined, editor: undefined });
      useIssuePanel.getState().open(numbers, editor);
    },
  };
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const raiseFromSelection = () => {
    if (!editor || editor.isDestroyed) return;
    const passage = selectedPassage(editor, novel);
    if (!passage) {
      useNotice.getState().show({ message: "Select the passage the issue is about first." });
      return;
    }
    useIssuePanel.setState({ numbers: [], editor: undefined });
    useRaise.getState().open(passage, editor);
  };
  useCommands(
    () => (repo ? [{ id: "writing.raiseIssue", title: "Raise an issue about the selection…", group: "GitHub", keywords: ["note", "plot hole", "continuity", "research", "github"], run: raiseFromSelection }] : []),
    [repo, editor, novel],
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
    return [...writingModeCommands, ...structureCommands, ...sessionCommands, ...findCommands, ...spellCommands, ...linkCommands].map((c: EditorCommand) => ({
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

  // The pinned details under each scene's title, following the details as they change (not the text).
  const pinKeys = usePins((p) => p.keys);
  const frontMatters = scenes.map((s) => files[s.file]?.frontMatter ?? "").join("\0");
  const pinned = useMemo(
    () =>
      Object.fromEntries(
        scenes.flatMap((s) => {
          const f = files[s.file];
          const line = f && pinKeys.length ? pinnedLine(novel, readFrontMatter(joinSceneFile({ ...f, body: "" })) ?? {}, pinKeys) : "";
          return line ? [[s.file, line]] : [];
        }),
      ),
    [frontMatters, pinKeys, novel], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The Scene tab shows the scene the caret is in, or one stepped to from it (◀ ▶) until the caret moves.
  const [stepped, setStepped] = useState<{ from: string; to: string }>();
  const atCaret = current && scenes.find((s) => s.id === current.id);
  useEffect(() => {
    if (!editor) return;
    const back = () => setStepped(undefined);
    editor.on("selectionUpdate", back);
    return () => void editor.off("selectionUpdate", back);
  }, [editor]);
  const detailsScene = (stepped && stepped.from === atCaret?.id && novel.allScenes.find((s) => s.id === stepped.to)) || atCaret;

  // The text scrolls on its own, so the sidebar beside it stays put.
  return (
    <div className="flex min-h-full flex-col lg:h-full lg:min-h-0 lg:flex-row">
      <div className="flex min-w-0 flex-1 flex-col lg:overflow-y-auto">
      <div
        className="mx-auto grid w-full max-w-[calc(var(--ghw-prose-measure)+3rem)] flex-1 content-start gap-3 px-6 py-6"
        onContextMenu={(e) => {
          // On selected text in the editor, unless something there (the spelling menu) took the click.
          if (!repo || !editor || editor.isDestroyed || e.defaultPrevented || !editor.view.dom.contains(e.target as Node)) return;
          if (!selectedPassage(editor, novel)) return;
          // The desktop app's menu shows it with its own items.
          if (appContextMenu()) return contributeMenuItems(e.nativeEvent, { items: [{ label: "Raise an issue…", run: raiseFromSelection }] });
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold">{heading}</h1>
          {/* The chapter's length by its title; the scene's is on its card, the session's and today's below. */}
          <WordCount chapterWords={chapterWords} show={["chapter"]} />
        </div>
        {"scene" in view && pinned[view.scene.file] && <p className="ghw-pinned -mt-2 text-[13px] text-muted">{pinned[view.scene.file]}</p>}
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
            issueMarks={issueMarks}
            onMention={onMention}
            pictureUrl={pictureUrl}
            pictures={pictures}
            {...(spell ? { spell } : {})}
          />
        ) : (
          <ChapterEditor
            key={view.chapter.id}
            scenes={scenes.map((s) => ({ id: s.file, title: s.title, markdown: files[s.file]!.body }))}
            pinned={pinned}
            onChange={(changed) => changed.forEach((c) => workspace.change(c.id, c.markdown))}
            onReady={setEditor}
            autofocus={autofocus}
            entities={entities}
            newEntry={newEntry}
            issueMarks={issueMarks}
            onMention={onMention}
            pictureUrl={pictureUrl}
            pictures={pictures}
            {...(spell ? { spell } : {})}
          />
        )}
      </div>
      <StatusBar novelId={novelId} workspace={workspace} />
      </div>
      {raising || issueOpen ? (
        // An issue being raised or read takes the sidebar's place until it's closed.
        <div className="shrink-0 border-rule bg-panel lg:w-[28rem] lg:overflow-y-auto lg:border-l">
          <RaisePanel novelId={novelId} novel={novel} />
          {!raising && <IssuePanel novelId={novelId} />}
        </div>
      ) : (
        !focusMode && (
          <RightSidebar
            toText={toText}
            labels={{ entry: entryShown && novel.events.some((e) => e.id === entryShown) ? "Event" : "Entry" }}
            content={{
              scene: detailsScene ? (
                <SceneDetails
                  key={detailsScene.file}
                  novel={novel}
                  workspace={workspace}
                  path={detailsScene.file}
                  title={detailsScene.title}
                  onStep={(to) => atCaret && setStepped({ from: atCaret.id, to })}
                  newEntry={newEntry.create}
                  issues={repo ? anchored.filter((a) => a.scene === detailsScene.file).map(({ number, title }) => ({ number, title })) : undefined}
                  onOpenIssue={(n) => issueMarks.onOpen([n])}
                />
              ) : (
                <p className="p-4 text-sm text-muted">{loaded ? "A scene’s details show here once the chapter has one." : "Opening…"}</p>
              ),
              notes: detailsScene ? (
                <SceneNotes key={detailsScene.id} novelId={novelId} novel={novel} workspace={workspace} scene={detailsScene} spell={spell} />
              ) : (
                <p className="p-4 text-sm text-muted">{loaded ? "A scene’s notes show here once the chapter has one." : "Opening…"}</p>
              ),
              entry: <EntryTab novelId={novelId} novel={novel} workspace={workspace} spell={spell} />,
            }}
          />
        )
      )}
      {menu && (
        <SelectionMenu
          at={menu}
          onClose={(back) => {
            setMenu(undefined);
            if (back && editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
          }}
          onRaise={() => {
            setMenu(undefined);
            raiseFromSelection();
          }}
        />
      )}
      {pictureRequest && (
        <PictureInTextDialog
          novelId={novelId}
          request={pictureRequest}
          pictureUrl={pictureUrl}
          onDone={(picture) => {
            const request = pictureRequest;
            setPictureRequest(undefined);
            // Once the dialog has closed and given the text its focus back.
            requestAnimationFrame(() => {
              if (!editor || editor.isDestroyed) return;
              if (request.kind === "add") insertPicture(editor, picture, request.at);
              else setPicture(editor, request.at, picture);
            });
          }}
          onClose={() => setPictureRequest(undefined)}
        />
      )}
      <NameEntryDialog novel={novel} />
      <MentionCard novelId={novelId} novel={novel} />
    </div>
  );
}

/** What can be done with the selected text: a menu at the pointer, by keyboard too (Escape returns to the text). */
function SelectionMenu({ at, onClose, onRaise }: { at: { x: number; y: number }; onClose: (back: boolean) => void; onRaise: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    // On Linux and macOS the menu opens as the button goes down; the editor takes the focus back as it
    // comes up: take it again then.
    const refocus = () => setTimeout(() => first.current?.focus());
    // Closed by a click anywhere else (not by losing focus, for the same reason).
    const outside = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && onClose(false);
    document.addEventListener("mouseup", refocus, { once: true });
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("mouseup", refocus);
      document.removeEventListener("pointerdown", outside);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Selected text"
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          onClose(true);
        }
      }}
      style={{ left: Math.min(at.x, window.innerWidth - 220), top: Math.min(at.y, window.innerHeight - 60) }}
      className="fixed z-50 grid min-w-48 rounded-md border border-rule bg-raised p-1 text-sm shadow-lg"
    >
      <button ref={first} type="button" role="menuitem" onClick={onRaise} className="rounded px-2 py-1.5 text-left hover:bg-accent-soft focus:bg-accent-soft focus:outline-none">
        Raise an issue…
      </button>
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

/**
 * Under the text, quietly: the writing session's words, and today's against the daily goal. In
 * focus mode, only while the count is pinned there.
 */
function StatusBar({ novelId, workspace }: { novelId: string; workspace: Workspace }) {
  const hidden = useWritingModes((m) => m.focus && !m.pinCount);
  if (hidden) return null;
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1 border-t border-rule bg-paper px-6 py-1.5 text-[13px] text-muted">
      <WordCount show={["session"]} label="This session" />
      <TodayCount novelId={novelId} workspace={workspace} />
    </div>
  );
}
