import type { Node } from "@tiptap/pm/model";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { loadMarkdown, setInitialMarkdown } from "./editor.ts";
import { proseContent } from "./extensions.ts";
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
}: SceneEditorProps) {
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
    extensions: [...proseContent, UndoRedo, Placeholder.configure({ placeholder })],
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

  return <EditorContent editor={editor} className={className} />;
}
