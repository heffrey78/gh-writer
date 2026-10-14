import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/*
 * A line to write on after a scene that ends in a table, a picture or a list (D10): an empty paragraph,
 * so the caret can go below it by keyboard or a click. Markdown can't hold an empty paragraph, so it's
 * never written to the file; it isn't in the Undo history either.
 */

const ENDS_IN_TEXT = new Set(["paragraph", "heading"]);

/** Where each scene (or the one scene) that doesn't end in text needs its paragraph, last first. */
function missing(state: EditorState): number[] {
  const { doc } = state;
  const at: number[] = [];
  if (doc.firstChild?.type.name === "scene") {
    doc.forEach((scene, offset) => {
      if (scene.lastChild && !ENDS_IN_TEXT.has(scene.lastChild.type.name)) at.push(offset + scene.nodeSize - 1);
    });
  } else if (doc.lastChild && !ENDS_IN_TEXT.has(doc.lastChild.type.name)) {
    at.push(doc.content.size);
  }
  return at.reverse();
}

function addParagraphs(state: EditorState): Transaction | null {
  const at = missing(state);
  if (!at.length) return null;
  const tr = state.tr;
  for (const pos of at) tr.insert(pos, state.schema.nodes.paragraph!.create());
  return tr.setMeta("addToHistory", false);
}

export const TrailingParagraphExtension = Extension.create({
  name: "ghwTrailingParagraph",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ghwTrailingParagraph"),
        // Opening: once the editor is set up, which it isn't yet while its plugins' views are made.
        view: (view) => {
          const timer = setTimeout(() => {
            const tr = !view.isDestroyed && addParagraphs(view.state);
            if (tr) view.dispatch(tr);
          });
          return { destroy: () => clearTimeout(timer) };
        },
        // After every change: an edit, or text loaded anew.
        appendTransaction: (trs, _old, state) => (trs.some((t) => t.docChanged) ? addParagraphs(state) : null),
      }),
    ];
  },
});
