import type { Content } from "@tiptap/core";
import type { Fragment, Node } from "@tiptap/pm/model";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { chapterContent, loadChapter, parseChapter, replaceScene, type SceneMarkdown, type SceneSource } from "./chapter.ts";
import { loadMarkdown, setInitialMarkdown } from "./editor.ts";
import { proseContent } from "./extensions.ts";
import { FindExtension } from "./find.ts";
import { SearchHighlightExtension } from "./search.ts";
import { SpellCheckExtension, type SpellService } from "./spell.ts";
import { writingModes, WritingModesExtension, type WritingModes } from "./modes.ts";
import { liveCounts, sessionWords, WordCountExtension, writingSession } from "./wordcount.ts";
import { serializeProse } from "./markdown.ts";

export interface SceneEditorProps {
  /**
   * The scene body (Markdown after the front matter). A value other than the editor's own last
   * output is loaded as a new document, discarding unreported edits. To switch scenes, give
   * each scene its own `key` so pending edits are reported for the scene they belong to.
   */
  markdown: string;
  /** Called with the new body once typing pauses, and straight away on blur, page hide and unmount. */
  onChange?: (markdown: string) => void;
  /** How long typing must pause before onChange, in milliseconds. */
  changeDelay?: number;
  /** Accessible name of the text area. */
  label?: string;
  placeholder?: string;
  autofocus?: boolean;
  className?: string;
  /** Receives the TipTap editor once it exists, for commands and state outside the component. */
  onReady?: (editor: Editor) => void;
  /** The scene's ID, for word counts across the writing session. */
  sceneId?: string;
  /** Spell checking: the checker, and where to save words added to the novel's dictionary. */
  spell?: SpellProps;
}

export interface SpellProps {
  service: SpellService;
  onAddWord?: (word: string) => void;
}

/** The spell-check extension for an editor; `onAddWord` reads the latest prop, as extensions are set up once. */
function useSpellExtension(spell: SpellProps | undefined) {
  const latest = useRef(spell);
  latest.current = spell;
  return SpellCheckExtension.configure({
    service: spell?.service ?? null,
    onAddWord: spell?.onAddWord ? (word) => latest.current?.onAddWord?.(word) : undefined,
  });
}

/** A WYSIWYG editor for one scene's prose. */
export function SceneEditor({
  markdown,
  onChange,
  changeDelay = 300,
  label = "Scene text",
  placeholder = "Start writing…",
  autofocus = false,
  className,
  onReady,
  sceneId = "scene",
  spell,
}: SceneEditorProps) {
  const spellExtension = useSpellExtension(spell);
  const callbacks = useRef({ onChange, onReady });
  callbacks.current = { onChange, onReady };
  // The Markdown the editor last loaded or reported, to tell its own output from a new value.
  const known = useRef(markdown);
  const pending = useRef<{ doc: Node; timer: ReturnType<typeof setTimeout> } | null>(null);

  const flush = useRef(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    const md = serializeProse(p.doc);
    if (md === known.current) return;
    known.current = md;
    callbacks.current.onChange?.(md);
  }).current;

  const editor = useEditor({
    extensions: [
      ...proseContent,
      UndoRedo,
      WritingModesExtension,
      WordCountExtension.configure({ sceneId }),
      FindExtension,
      SearchHighlightExtension,
      spellExtension,
      Placeholder.configure({ placeholder }),
    ],
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label, class: "ghw-prose" },
    },
    autofocus,
    onBeforeCreate: ({ editor }) => setInitialMarkdown(editor, known.current),
    onUpdate: ({ editor }) => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { doc: editor.state.doc, timer: setTimeout(flush, changeDelay) };
    },
    onBlur: flush,
  });

  // From the instance useEditor returns: under StrictMode TipTap creates a second editor and
  // destroys it, and both fire their own create and mount events.
  useEffect(() => {
    if (editor) callbacks.current.onReady?.(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor || markdown === known.current) return;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    known.current = markdown;
    loadMarkdown(editor, markdown);
  }, [editor, markdown]);

  useFlushOnLeave(flush);

  return <EditorContent editor={editor} className={className} />;
}

/** The writing modes (focus, dimming, typewriter), for the app to hide its chrome in focus mode. */
export function useWritingModes(): WritingModes;
export function useWritingModes<T>(select: (modes: WritingModes) => T): T;
export function useWritingModes<T>(select: (modes: WritingModes) => T = (m) => m as T): T {
  return useStore(writingModes, select);
}

/** Report pending changes when the page is hidden or closed, and on unmount. */
function useFlushOnLeave(flush: () => void) {
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
}

export interface ChapterEditorProps {
  /**
   * The chapter's scenes in reading order. A scene whose markdown isn't the editor's own last
   * output for it is replaced in place (other scenes and the undo history stay); a different
   * set or order of scenes reloads the chapter. Give each chapter its own `key`.
   */
  scenes: SceneSource[];
  /** Called with the scenes whose body changed, once typing pauses, and straight away on blur, page hide and unmount. */
  onChange?: (changed: SceneMarkdown[]) => void;
  /** How long typing must pause before onChange, in milliseconds. */
  changeDelay?: number;
  /** Accessible name of the text area. */
  label?: string;
  autofocus?: boolean;
  className?: string;
  /** Receives the TipTap editor once it exists, for commands and state outside the component. */
  onReady?: (editor: Editor) => void;
  /** Spell checking: the checker, and where to save words added to the novel's dictionary. */
  spell?: SpellProps;
}

/**
 * A chapter as one continuous, editable text, with each scene still its own file: edits are
 * reported per scene, and ordinary editing can't merge, split or delete scenes.
 */
export function ChapterEditor({
  scenes,
  onChange,
  changeDelay = 300,
  label = "Chapter text",
  autofocus = false,
  className,
  onReady,
  spell,
}: ChapterEditorProps) {
  const spellExtension = useSpellExtension(spell);
  const callbacks = useRef({ onChange, onReady });
  callbacks.current = { onChange, onReady };
  // Per scene: the Markdown last loaded or reported, and the content it was serialized from.
  // Content identity tells which scenes an edit touched; title changes keep content as is.
  const known = useRef(new Map(scenes.map((s) => [s.id, s.markdown])));
  const reported = useRef(new Map<string, Fragment>());
  const pending = useRef<{ doc: Node; timer: ReturnType<typeof setTimeout> } | null>(null);

  const remember = (doc: Node) => {
    reported.current = new Map();
    doc.forEach((scene) => reported.current.set(scene.attrs.id, scene.content));
  };

  const flush = useRef(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    const changed: SceneMarkdown[] = [];
    p.doc.forEach((scene) => {
      const id: string = scene.attrs.id;
      if (reported.current.get(id) === scene.content) return;
      reported.current.set(id, scene.content);
      const markdown = serializeProse(scene);
      if (markdown === known.current.get(id)) return;
      known.current.set(id, markdown);
      changed.push({ id, markdown });
    });
    if (changed.length) callbacks.current.onChange?.(changed);
  }).current;

  const editor = useEditor({
    extensions: [...chapterContent, UndoRedo, WritingModesExtension, WordCountExtension, FindExtension, SearchHighlightExtension, spellExtension],
    editorProps: {
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label, class: "ghw-prose ghw-chapter" },
    },
    autofocus,
    onBeforeCreate: ({ editor }) => {
      editor.options.content = parseChapter(scenes, editor.schema) as unknown as Content;
    },
    onUpdate: ({ editor }) => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { doc: editor.state.doc, timer: setTimeout(flush, changeDelay) };
    },
    onBlur: flush,
  });

  useEffect(() => {
    if (!editor) return;
    remember(editor.state.doc);
    callbacks.current.onReady?.(editor);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const ids: string[] = [];
    editor.state.doc.forEach((scene) => void ids.push(scene.attrs.id));
    if (ids.join("\n") !== scenes.map((s) => s.id).join("\n")) {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
      known.current = new Map(scenes.map((s) => [s.id, s.markdown]));
      loadChapter(editor, scenes);
      remember(editor.state.doc);
      return;
    }
    for (const scene of scenes) {
      if (scene.markdown !== known.current.get(scene.id)) {
        known.current.set(scene.id, scene.markdown);
        replaceScene(editor, scene);
        const node = findScene(editor.state.doc, scene.id);
        if (node) reported.current.set(scene.id, node.content);
      } else if ((scene.title ?? "") !== findScene(editor.state.doc, scene.id)?.attrs.title) {
        setSceneTitle(editor, scene.id, scene.title ?? "");
      }
    }
    // Pending edits elsewhere in the chapter are reported from the document with the new scene.
    if (pending.current) pending.current.doc = editor.state.doc;
  }, [editor, scenes]);

  useFlushOnLeave(flush);

  return <EditorContent editor={editor} className={className} />;
}

function findScene(doc: Node, id: string): Node | undefined {
  let found: Node | undefined;
  doc.forEach((scene) => void (scene.attrs.id === id && (found = scene)));
  return found;
}

function setSceneTitle(editor: Editor, id: string, title: string) {
  let pos = -1;
  editor.state.doc.forEach((scene, offset) => void (scene.attrs.id === id && (pos = offset)));
  if (pos >= 0) editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "title", title).setMeta("addToHistory", false));
}

export interface WordCountProps {
  /** Words in the whole chapter, when the editor shows a single scene and the app knows the rest. */
  chapterWords?: number;
  className?: string;
}

const format = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${format.format(n)}` : n < 0 ? `−${format.format(-n)}` : "0");

/**
 * Scene, chapter and session word counts, with an optional session goal. It follows the editor
 * the writer last used, and hides in focus mode unless the count is pinned.
 */
export function WordCount({ chapterWords, className }: WordCountProps) {
  const counts = useStore(liveCounts);
  const session = useStore(writingSession);
  const hidden = useWritingModes((m) => m.focus && !m.pinCount);
  const [editing, setEditing] = useState(false);
  const inputId = useId();
  // After the goal form closes, focus goes back to its button rather than to the page.
  const goalButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  useEffect(() => {
    if (!editing && closing.current) goalButton.current?.focus();
    closing.current = false;
  }, [editing]);
  const close = () => {
    closing.current = true;
    setEditing(false);
  };
  const words = sessionWords(session);
  const { goal } = session;
  const reached = goal !== null && words >= goal;
  const chapter = counts.view === "chapter" ? counts.chapter : chapterWords;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = Number(new FormData(e.currentTarget).get("goal"));
    writingSession.getState().setGoal(Number.isFinite(value) && value > 0 ? value : null);
    close();
  };

  return (
    <div className={["ghw-wordcount", className].filter(Boolean).join(" ")} role="group" aria-label="Word count" hidden={hidden}>
      <span>
        Scene <strong>{format.format(counts.scene)}</strong>
      </span>
      {chapter !== undefined && (
        <span>
          Chapter <strong>{format.format(chapter)}</strong>
        </span>
      )}
      <span className="ghw-session">
        Session <strong>{signed(words)}</strong>
        {goal !== null && (
          <>
            {" "}
            of {format.format(goal)}
            <progress max={goal} value={Math.max(0, Math.min(words, goal))} aria-label="Session goal progress" />
          </>
        )}
      </span>
      {editing ? (
        <form onSubmit={save} onKeyDown={(e) => e.key === "Escape" && close()}>
          <label htmlFor={inputId}>Session goal</label>
          <input id={inputId} name="goal" type="number" min={0} defaultValue={goal ?? ""} autoFocus />
          <button type="submit">Save</button>
        </form>
      ) : (
        <button type="button" ref={goalButton} onClick={() => setEditing(true)}>
          {goal === null ? "Set goal" : "Change goal"}
        </button>
      )}
      {/* A quiet notice: shown in the bar and announced once, never a pop-up. */}
      <span role="status" className="ghw-goal-reached">
        {reached ? "Goal reached" : ""}
      </span>
    </div>
  );
}

export { FindReplace, type FindReplaceProps } from "./find-panel.tsx";
export type { SpellService } from "./spell.ts";
export { ConflictResolver, type ConflictFileView, type ConflictResolverProps, type ResolvedFile } from "./conflict-resolver.tsx";
