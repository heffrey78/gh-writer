import type { Content } from "@tiptap/core";
import type { Fragment, Node } from "@tiptap/pm/model";
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { chapterContent, loadChapter, parseChapter, replaceScene, type SceneMarkdown, type SceneSource } from "./chapter.ts";
import { loadMarkdown, setInitialMarkdown } from "./editor.ts";
import { Picture, proseContent } from "./extensions.ts";
import { FindExtension } from "./find.ts";
import { SearchHighlightExtension } from "./search.ts";
import { SelectFocusExtension } from "./select-focus.ts";
import { IssueMarksExtension, refreshIssueMarks, type AnchoredIssue } from "./issue-marks.ts";
import { PinnedLinesExtension, refreshPinnedLines } from "./pinned-lines.ts";
import { LinkSuggestExtension } from "./link-suggest.ts";
import { MentionInfoExtension, type MentionTarget } from "./mention-info.ts";
import { PicturesExtension, type PictureCallbacks } from "./pictures.ts";
import { TrailingParagraphExtension } from "./trailing.ts";
import { MentionSuggestExtension, type MentionEntity, type MentionType } from "./mention-suggest.ts";
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
  /** What @ suggests: the story bible's entries. */
  entities?: readonly MentionEntity[];
  /** "New <type>" in the @ menu: the types, and a function making an entry that returns its ID at once. */
  newEntry?: NewEntryProps;
  /** Open issues about passages, shown in the margin beside them; `onOpen` gets the ones chosen. */
  issueMarks?: IssueMarksProps;
  /** A mention was hovered, or Alt+Enter pressed beside one: for a card about its entity. */
  onMention?: MentionCallbacks;
  /** Where a picture in the text loads from, given its repository path (images/…): the app's server. */
  pictureUrl?: (path: string) => string | undefined;
  /** Image files dropped or pasted in, and a picture to change: for the app to ask about and save. */
  pictures?: PictureCallbacks;
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

export interface MentionCallbacks {
  show: (target: MentionTarget) => void;
  /** The pointer left the mention. */
  leave: () => void;
}

/** Mention hover and shortcut, calling the latest `onMention` prop. */
function useMentionInfoExtension(callbacks: MentionCallbacks | undefined) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  return MentionInfoExtension.configure({ onShow: (t) => latest.current?.show(t), onLeave: () => latest.current?.leave() });
}

/**
 * Getting around tables and pictures (D10): a line to write on after a scene ending in one, the gap
 * cursor between two (a caret where there's no text), and a mark where something dragged will land.
 */
const movingAround = [TrailingParagraphExtension, Gapcursor, Dropcursor.configure({ color: false, width: 3, class: "ghw-dropcursor" })];

/** Pictures dropped, pasted or changed (Enter or a double-click on one), handed to the latest `pictures` prop. */
function usePicturesExtension(callbacks: PictureCallbacks | undefined) {
  const latest = useRef(callbacks);
  latest.current = callbacks;
  return PicturesExtension.configure({
    callbacks: () => ({
      ...(latest.current?.add ? { add: (files: File[], at: number) => latest.current?.add?.(files, at) } : {}),
      ...(latest.current?.edit ? { edit: (at: number) => latest.current?.edit?.(at) } : {}),
    }),
  });
}

export interface IssueMarksProps {
  issues: readonly AnchoredIssue[];
  onOpen: (numbers: number[]) => void;
}

/** Margin markers for the latest `issueMarks` prop, placed again when the issues change. */
function useIssueMarksExtension(issueMarks: IssueMarksProps | undefined) {
  const latest = useRef(issueMarks);
  latest.current = issueMarks;
  return IssueMarksExtension.configure({ issues: () => latest.current?.issues ?? [], onOpen: (n) => latest.current?.onOpen(n) });
}

/** Re-place the markers when the list of issues changes (not on every render). */
function useIssueMarksRefresh(editor: Editor | null, issueMarks: IssueMarksProps | undefined) {
  const key = JSON.stringify(issueMarks?.issues ?? []);
  useEffect(() => {
    if (editor) refreshIssueMarks(editor);
  }, [editor, key]);
}

export interface NewEntryProps {
  types: readonly MentionType[];
  create: (type: string, name: string) => string | undefined;
  /** Ask for a new entry's name (a dialog), for "New <type>…" chosen right after @: undefined if cancelled. */
  ask?: (type: string) => Promise<string | undefined>;
}

/** @ suggestions and link suggestions over the latest `entities` and `newEntry` props, as extensions are set up once. */
function useMentionExtension(entities: readonly MentionEntity[] | undefined, newEntry: NewEntryProps | undefined) {
  const latest = useRef({ entities, newEntry });
  latest.current = { entities, newEntry };
  const read = () => latest.current.entities ?? [];
  return [
    MentionSuggestExtension.configure({
      entities: read,
      types: () => latest.current.newEntry?.types ?? [],
      onCreate: (type, name) => latest.current.newEntry?.create(type, name),
      // Set up once, like the editor's extensions: "New <type>…" right after @ only if the app can ask.
      ...(newEntry?.ask ? { askName: (type: string) => latest.current.newEntry?.ask?.(type) ?? Promise.resolve(undefined) } : {}),
    }),
    LinkSuggestExtension.configure({ entities: read }),
  ];
}

/** A WYSIWYG editor for one scene's prose. */
/** The prose's extensions with pictures loading from `url`, when the app says where. */
function withPictures<T>(content: T[], url: ((path: string) => string | undefined) | undefined): T[] {
  return url ? content.map((e) => ((e as unknown) === Picture ? (Picture.configure({ url }) as T) : e)) : content;
}

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
  entities,
  newEntry,
  issueMarks,
  onMention,
  pictureUrl,
  pictures,
}: SceneEditorProps) {
  const picturesExtension = usePicturesExtension(pictures);
  const spellExtension = useSpellExtension(spell);
  const mentionExtension = useMentionExtension(entities, newEntry);
  const issueMarksExtension = useIssueMarksExtension(issueMarks);
  const mentionInfo = useMentionInfoExtension(onMention);
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
      ...withPictures(proseContent, pictureUrl),
      UndoRedo,
      SelectFocusExtension,
      issueMarksExtension,
      WritingModesExtension,
      WordCountExtension.configure({ sceneId }),
      FindExtension,
      SearchHighlightExtension,
      spellExtension,
      ...mentionExtension,
      mentionInfo,
      picturesExtension,
      ...movingAround,
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

  useIssueMarksRefresh(editor, issueMarks);
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
  /** What @ suggests: the story bible's entries. */
  entities?: readonly MentionEntity[];
  /** "New <type>" in the @ menu: the types, and a function making an entry that returns its ID at once. */
  newEntry?: NewEntryProps;
  /** Open issues about passages, shown in the margin beside them; `onOpen` gets the ones chosen. */
  issueMarks?: IssueMarksProps;
  /** A mention was hovered, or Alt+Enter pressed beside one: for a card about its entity. */
  onMention?: MentionCallbacks;
  /** A line of pinned details under each scene's title, by scene ID; display only. */
  pinned?: Readonly<Record<string, string>>;
  /** Where a picture in the text loads from, given its repository path (images/…): the app's server. */
  pictureUrl?: (path: string) => string | undefined;
  /** Image files dropped or pasted in, and a picture to change: for the app to ask about and save. */
  pictures?: PictureCallbacks;
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
  entities,
  newEntry,
  issueMarks,
  onMention,
  pinned,
  pictureUrl,
  pictures,
}: ChapterEditorProps) {
  const picturesExtension = usePicturesExtension(pictures);
  const spellExtension = useSpellExtension(spell);
  const latestPinned = useRef(pinned);
  latestPinned.current = pinned;
  const pinnedLines = useRef(PinnedLinesExtension.configure({ lines: () => latestPinned.current ?? {} })).current;
  const mentionExtension = useMentionExtension(entities, newEntry);
  const issueMarksExtension = useIssueMarksExtension(issueMarks);
  const mentionInfo = useMentionInfoExtension(onMention);
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
    extensions: [...withPictures(chapterContent, pictureUrl), UndoRedo, SelectFocusExtension, issueMarksExtension, pinnedLines, WritingModesExtension, WordCountExtension, FindExtension, SearchHighlightExtension, spellExtension, ...mentionExtension, mentionInfo, picturesExtension, ...movingAround],
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

  useIssueMarksRefresh(editor, issueMarks);
  const pinnedKey = JSON.stringify(pinned ?? {});
  useEffect(() => {
    if (editor) refreshPinnedLines(editor);
  }, [editor, pinnedKey]);
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
  /** Which counts to show (all by default). */
  show?: readonly ("scene" | "chapter" | "session")[];
  /** Its name for screen readers ("Word count"). */
  label?: string;
  className?: string;
}

const format = new Intl.NumberFormat();
const signed = (n: number) => (n > 0 ? `+${format.format(n)}` : n < 0 ? `−${format.format(-n)}` : "0");

/**
 * Scene, chapter and session word counts. It follows the editor the writer last used, and hides in
 * focus mode unless the count is pinned.
 */
export function WordCount({ chapterWords, show = ["scene", "chapter", "session"], label = "Word count", className }: WordCountProps) {
  const counts = useStore(liveCounts);
  const session = useStore(writingSession);
  const hidden = useWritingModes((m) => m.focus && !m.pinCount);
  const words = sessionWords(session);
  const chapter = counts.view === "chapter" ? counts.chapter : chapterWords;

  return (
    <div className={["ghw-wordcount", className].filter(Boolean).join(" ")} role="group" aria-label={label} hidden={hidden}>
      {show.includes("scene") && (
        <span>
          Scene <strong>{format.format(counts.scene)}</strong>
        </span>
      )}
      {show.includes("chapter") && chapter !== undefined && (
        <span>
          Chapter <strong>{format.format(chapter)}</strong>
        </span>
      )}
      {show.includes("session") && (
        <span className="ghw-session">
          Session <strong>{signed(words)}</strong>
        </span>
      )}
    </div>
  );
}

export { FindReplace, type FindReplaceProps } from "./find-panel.tsx";
export type { SpellService } from "./spell.ts";
export { ConflictResolver, type ConflictFileView, type ConflictResolverProps, type ResolvedFile } from "./conflict-resolver.tsx";
