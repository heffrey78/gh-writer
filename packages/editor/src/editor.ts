import type { Content, Editor } from "@tiptap/core";
import { EditorState, Selection } from "@tiptap/pm/state";
import { parseProse, serializeProse } from "./markdown.ts";

/**
 * Load a scene body into an editor as a fresh document with its own undo history.
 *
 * The parsed document goes in as is, not through setContent or JSON: that keeps its attributes
 * and the node identity serializeProse uses to write unchanged blocks back byte for byte.
 */
export function loadMarkdown(editor: Editor, markdown: string): void {
  const doc = parseProse(markdown, editor.schema);
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins, selection: Selection.atStart(doc) }));
}

/**
 * Start an editor with a scene body: call from `onBeforeCreate`, when the schema exists but the
 * document doesn't yet. TipTap takes a ProseMirror node as is, so like loadMarkdown this keeps
 * the parsed document whole, and it is in place for the first render.
 */
export function setInitialMarkdown(editor: Editor, markdown: string): void {
  editor.options.content = parseProse(markdown, editor.schema) as unknown as Content;
}

/** The editor's document as a scene body. */
export function getMarkdown(editor: Editor): string {
  return serializeProse(editor.state.doc);
}
