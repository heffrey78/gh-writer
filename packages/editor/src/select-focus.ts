import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Take the focus, with its selection, when the mouse selects text in the editor while the editor
 * isn't focused. Firefox does that for a drag that starts beside or below the text (outside the
 * editor): the text shows as selected, but typing, Backspace and Delete go nowhere.
 */
export const SelectFocusExtension = Extension.create({
  name: "ghwSelectFocus",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ghwSelectFocus"),
        view: (view) => {
          const doc = view.dom.ownerDocument;
          const onMouseUp = () => focusDomSelection(view);
          doc.addEventListener("mouseup", onMouseUp);
          return { destroy: () => doc.removeEventListener("mouseup", onMouseUp) };
        },
      }),
    ];
  },
});

/** If the page's selection lies in the unfocused editor, make it the editor's and focus it. */
function focusDomSelection(view: EditorView): void {
  if (view.isDestroyed || !view.editable || view.hasFocus()) return;
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return;
  if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return;
  const { doc } = view.state;
  const anchor = doc.resolve(view.posAtDOM(sel.anchorNode, sel.anchorOffset));
  const head = doc.resolve(view.posAtDOM(sel.focusNode, sel.focusOffset));
  view.dispatch(view.state.tr.setSelection(TextSelection.between(anchor, head)));
  view.focus();
}
