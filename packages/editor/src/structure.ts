import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable } from "@tiptap/pm/tables";
import type { Command } from "@tiptap/pm/state";
import type { EditorCommand } from "./modes.ts";

/*
 * Headings, lists and tables from the keyboard and the palette (D10, #202). The keys that work as you
 * type (Enter, Tab and Backspace in lists; Tab between cells; # and - at a line's start) are with their
 * nodes in extensions.ts; these are the commands to name them by.
 */

/** Make the block at the caret a heading of `level`, or (0) text again. */
export function setHeading(editor: Editor, level: 0 | 1 | 2 | 3): boolean {
  const chain = editor.chain().focus();
  return (level ? chain.setNode("heading", { level }) : chain.setNode("paragraph")).run();
}

/** Insert a table, three columns by a header and two rows, after the block at the caret (or in place of an empty one), the caret in its first cell. */
export function insertTable(editor: Editor): boolean {
  const { schema } = editor.state;
  if (isInTable(editor.state)) return false;
  const cell = (header: boolean) => (header ? schema.nodes.table_header! : schema.nodes.table_cell!).create();
  const row = (header: boolean) => schema.nodes.table_row!.create(null, [cell(header), cell(header), cell(header)]);
  const table = schema.nodes.table!.create(null, [row(true), row(false), row(false)]);
  const { tr, at } = insertBlock(editor.state, table, editor.state.selection.from);
  // Into the first header cell: the table, its row, its cell.
  tr.setSelection(TextSelection.create(tr.doc, at + 3));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/**
 * A transaction putting `block` in at the top level of the scene holding `at`: in place of an empty
 * paragraph there, between blocks if `at` is between them, else after the block holding it (a whole
 * list or table, from inside one). `at` in the result is where the block starts.
 */
export function insertBlock(state: EditorState, block: Node, at: number): { tr: Transaction; at: number } {
  const { tr } = state;
  // Between two of a chapter's scenes: into the end of the one before (or the start of the first).
  if (state.doc.firstChild?.type.name === "scene" && state.doc.resolve(at).depth === 0) at = at === 0 ? 1 : at - 1;
  const $at = state.doc.resolve(at);
  // The depth of a scene's blocks: 2 in a chapter (doc, scene, block), 1 in a scene of its own.
  const depth = $at.depth > 0 && $at.node(1).type.name === "scene" ? 2 : 1;
  if ($at.depth < depth) {
    tr.insert(at, block);
    return { tr, at };
  }
  const holder = $at.node(depth);
  const empty = holder.type.name === "paragraph" && holder.content.size === 0;
  const pos = empty ? $at.before(depth) : $at.after(depth);
  if (empty) tr.replaceWith(pos, pos + holder.nodeSize, block);
  else tr.insert(pos, block);
  return { tr, at: pos };
}

/** A table command from ProseMirror's tables, run on the editor and back to the text. */
const table = (command: Command) => (editor?: Editor) => {
  if (!editor || editor.isDestroyed) return;
  command(editor.state, editor.view.dispatch);
  editor.view.focus();
};

export const structureCommands: EditorCommand[] = [
  { id: "editor.heading1", title: "Heading 1", keys: "Mod-Alt-1", run: (e) => void (e && setHeading(e, 1)) },
  { id: "editor.heading2", title: "Heading 2", keys: "Mod-Alt-2", run: (e) => void (e && setHeading(e, 2)) },
  { id: "editor.heading3", title: "Heading 3", keys: "Mod-Alt-3", run: (e) => void (e && setHeading(e, 3)) },
  { id: "editor.text", title: "Text (not a heading)", keys: "Mod-Alt-0", run: (e) => void (e && setHeading(e, 0)) },
  { id: "editor.bulletList", title: "Bulleted list", keys: "Mod-Shift-8", run: (e) => void e?.chain().focus().toggleList("bullet_list", "list_item").run() },
  { id: "editor.orderedList", title: "Numbered list", keys: "Mod-Shift-7", run: (e) => void e?.chain().focus().toggleList("ordered_list", "list_item").run() },
  { id: "editor.insertTable", title: "Insert table", run: (e) => void (e && insertTable(e)) },
  { id: "editor.addRowAbove", title: "Table: add a row above", run: table(addRowBefore) },
  { id: "editor.addRowBelow", title: "Table: add a row below", run: table(addRowAfter) },
  { id: "editor.addColumnBefore", title: "Table: add a column before", run: table(addColumnBefore) },
  { id: "editor.addColumnAfter", title: "Table: add a column after", run: table(addColumnAfter) },
  { id: "editor.deleteRow", title: "Table: delete the row", run: table(deleteRow) },
  { id: "editor.deleteColumn", title: "Table: delete the column", run: table(deleteColumn) },
  { id: "editor.deleteTable", title: "Table: delete the table", run: table(deleteTable) },
];
