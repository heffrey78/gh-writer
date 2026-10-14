import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { insertBlock } from "./structure.ts";

/*
 * Pictures in the prose (D10, #203): the editor hands image files dropped or pasted in, and a picture
 * to change (Enter on it, or a double-click), to the app, which asks for its description and caption
 * and saves its file; then puts it in, or changes it, with these commands. Backspace and Delete remove
 * a selected picture like any other block.
 */

export interface PictureAttrs {
  /** As written in the Markdown: /images/<name>, from the repository's root. */
  url: string;
  alt: string;
  caption?: string | null;
}

export interface PictureCallbacks {
  /** Image files dropped or pasted into the text, to put in at `at` (a position in the document). */
  add?: (files: File[], at: number) => void;
  /** The picture at `at` to change: Enter on it while it's selected, or a double-click. */
  edit?: (at: number) => void;
}

export const PicturesExtension = Extension.create<{ callbacks: () => PictureCallbacks }>({
  name: "ghwPictures",
  addOptions: () => ({ callbacks: () => ({}) }),
  addProseMirrorPlugins() {
    const callbacks = this.options.callbacks;
    return [
      new Plugin({
        key: new PluginKey("ghwPictures"),
        props: {
          handleDrop: (view, event, _slice, moved) => {
            const files = imageFiles(event.dataTransfer);
            const add = callbacks().add;
            if (moved || !files.length || !add) return false;
            event.preventDefault();
            add(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from);
            return true;
          },
          handlePaste: (view, event) => {
            const files = imageFiles(event.clipboardData);
            const add = callbacks().add;
            if (!files.length || !add) return false;
            event.preventDefault();
            add(files, view.state.selection.from);
            return true;
          },
          handleKeyDown: (view, event) => {
            const { selection } = view.state;
            const edit = callbacks().edit;
            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !edit) return false;
            if (!(selection instanceof NodeSelection) || selection.node.type.name !== "picture") return false;
            event.preventDefault();
            edit(selection.from);
            return true;
          },
          handleDoubleClickOn: (view, _pos, node, nodePos) => {
            const edit = callbacks().edit;
            if (node.type.name !== "picture" || !edit) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
            edit(nodePos);
            return true;
          },
        },
      }),
    ];
  },
});

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
}

/**
 * Put a picture in at `at` (after the block holding it, or in place of an empty paragraph), with an
 * empty paragraph after it to write on in, the caret there.
 */
export function insertPicture(editor: Editor, picture: PictureAttrs, at = editor.state.selection.from): boolean {
  const { schema } = editor.state;
  const node = schema.nodes.picture!.create({ url: picture.url, alt: picture.alt, caption: picture.caption || null });
  const { tr, at: start } = insertBlock(editor.state, node, Math.min(at, editor.state.doc.content.size));
  const after = start + node.nodeSize;
  const next = tr.doc.resolve(after).nodeAfter;
  if (!next?.isTextblock) tr.insert(after, schema.nodes.paragraph!.create());
  tr.setSelection(TextSelection.create(tr.doc, after + 1));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** The picture at `at`, or undefined if there isn't one. */
export function pictureAt(editor: Editor, at: number): PictureAttrs | undefined {
  const node = at >= 0 && at < editor.state.doc.content.size ? editor.state.doc.nodeAt(at) : null;
  return node?.type.name === "picture" ? { url: node.attrs.url, alt: node.attrs.alt, caption: node.attrs.caption } : undefined;
}

/** Change the description and caption of the picture at `at`, leaving it selected. */
export function setPicture(editor: Editor, at: number, { alt, caption }: { alt: string; caption?: string | null }): boolean {
  const node = editor.state.doc.nodeAt(at);
  if (node?.type.name !== "picture") return false;
  const tr = editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, alt, caption: caption || null });
  tr.setSelection(NodeSelection.create(tr.doc, at));
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}
