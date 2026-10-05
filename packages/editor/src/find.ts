import { Extension, type Editor } from "@tiptap/core";
import { createStore } from "zustand/vanilla";
import type { EditorCommand } from "./modes.ts";
import type { SearchScope } from "./search.ts";

/*
 * Opening the find panel. The panel belongs to the app, so the editor's shortcuts (and the
 * command palette) only ask for it through this store; the panel opens, takes focus and seeds
 * its query from the selection.
 */

export interface FindPanelState {
  open: boolean;
  scope: SearchScope;
  /** Text to search for when the panel opens (the selection), or "" to keep the last query. */
  seed: string;
  /** Changes on every request to open, so the panel refocuses even if it's already open. */
  request: number;
}

export const findPanel = createStore<FindPanelState>()(() => ({ open: false, scope: "scene", seed: "", request: 0 }));

/** Open the find panel for a scope, seeded with the editor's selected text if it's on one line. */
export function openFind(scope: SearchScope, editor?: Editor | null): void {
  let seed = "";
  if (editor && !editor.isDestroyed) {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "\n");
    if (text && !text.includes("\n") && text.length <= 200) seed = text;
  }
  findPanel.setState((s) => ({ open: true, scope, seed, request: s.request + 1 }));
}

export function closeFind(): void {
  findPanel.setState({ open: false });
}

export const findCommands: EditorCommand[] = [
  { id: "editor.findInScene", title: "Find in scene", keys: "Mod-f", run: (editor) => openFind("scene", editor) },
  { id: "editor.findInChapter", title: "Find in chapter", run: (editor) => openFind("chapter", editor) },
  { id: "editor.findInManuscript", title: "Find and replace in manuscript", keys: "Mod-Shift-h", run: (editor) => openFind("manuscript", editor) },
];

/** The find shortcuts, from inside the text. */
export const FindExtension = Extension.create({
  name: "find",
  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {};
    for (const command of findCommands) if (command.keys) shortcuts[command.keys] = () => (command.run(this.editor), true);
    return shortcuts;
  },
});
