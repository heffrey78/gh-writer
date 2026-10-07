import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/*
 * Writing modes: focus mode (the app hides its chrome; optionally everything but the current
 * paragraph is dimmed) and typewriter scrolling (the caret line stays at a fixed height).
 * They are settings of the writer, not of a scene, so one store holds them for every editor and
 * for the app shell, and keeps them between sessions.
 */

export interface WritingModes {
  /** Focus mode: the app hides everything but the text. */
  focus: boolean;
  /** In focus mode, dim every paragraph except the current one. */
  dim: boolean;
  /** Keep the caret line at a fixed height while typing and moving by keyboard. */
  typewriter: boolean;
  /** Keep the word count visible in focus mode. */
  pinCount: boolean;
  /** Underline misspelled words (when the app provides a spell checker). */
  spellcheck: boolean;
  /** Underline names of bible entries written without a mention, offering to link them. */
  linkSuggestions: boolean;
}

export type WritingMode = keyof WritingModes;

interface WritingModesStore extends WritingModes {
  toggle(mode: WritingMode): void;
  set(modes: Partial<WritingModes>): void;
}

/** Where the caret line sits in typewriter mode, as a fraction of the scrolling area's height. */
export const TYPEWRITER_LINE = 0.4;

// Storage can be missing or throw (private windows, blocked site data): the modes then just
// don't persist.
const storage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {}
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {}
  },
};

export const writingModes = createStore<WritingModesStore>()(
  persist(
    (set) => ({
      focus: false,
      dim: false,
      typewriter: false,
      pinCount: false,
      spellcheck: true,
      linkSuggestions: false,
      toggle: (mode) => set((s) => ({ [mode]: !s[mode] })),
      set: (modes) => set(modes),
    }),
    {
      name: "gh-writer:writing-modes",
      storage: createJSONStorage(() => storage),
      partialize: ({ focus, dim, typewriter, pinCount, spellcheck, linkSuggestions }) => ({ focus, dim, typewriter, pinCount, spellcheck, linkSuggestions }),
    },
  ),
);

/** A named action for the command palette, with its default shortcut in TipTap notation. */
export interface EditorCommand {
  id: string;
  title: string;
  /** Default shortcut, e.g. "Mod-Shift-f", or undefined for none. */
  keys?: string;
  run(editor?: Editor): void;
  /** For toggles: whether the setting is on. */
  isActive?(): boolean;
}

function toggleMode(mode: WritingMode, editor?: Editor) {
  writingModes.getState().toggle(mode);
  // Back to the text with the selection as it was, e.g. when run from the palette.
  if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
}

export const writingModeCommands: EditorCommand[] = [
  {
    id: "editor.toggleFocusMode",
    title: "Focus mode",
    keys: "Mod-Shift-f",
    run: (editor) => toggleMode("focus", editor),
    isActive: () => writingModes.getState().focus,
  },
  {
    id: "editor.toggleTypewriterScrolling",
    title: "Typewriter scrolling",
    keys: "Mod-Shift-l",
    run: (editor) => toggleMode("typewriter", editor),
    isActive: () => writingModes.getState().typewriter,
  },
  {
    id: "editor.toggleFocusDimming",
    title: "Dim all but the current paragraph in focus mode",
    run: (editor) => toggleMode("dim", editor),
    isActive: () => writingModes.getState().dim,
  },
  {
    id: "editor.togglePinnedWordCount",
    title: "Show the word count in focus mode",
    run: (editor) => toggleMode("pinCount", editor),
    isActive: () => writingModes.getState().pinCount,
  },
];

const modesKey = new PluginKey<DecorationSet>("ghwWritingModes");

/** Writing-mode shortcuts, classes on the editor and typewriter scrolling. */
export const WritingModesExtension = Extension.create({
  name: "writingModes",
  addKeyboardShortcuts() {
    const shortcuts: Record<string, () => boolean> = {};
    for (const command of writingModeCommands) {
      if (command.keys) shortcuts[command.keys] = () => (command.run(this.editor), true);
    }
    return shortcuts;
  },
  addProseMirrorPlugins() {
    return [writingModesPlugin()];
  },
});

function writingModesPlugin(): Plugin {
  // Typewriter scrolling follows typing and keyboard movement, not clicks: recentring under
  // the pointer would move the text the writer just aimed at. So selection changes recentre
  // only when the last input was a key.
  let lastInput: "key" | "pointer" = "pointer";
  return new Plugin({
    key: modesKey,
    state: {
      init: (_, state) => currentParagraph(state),
      apply: (tr, old, _before, state) => (tr.docChanged || tr.selectionSet || tr.getMeta(modesKey) ? currentParagraph(state) : old),
    },
    props: {
      decorations: (state) => modesKey.getState(state),
      handleKeyDown: () => {
        lastInput = "key";
        return false;
      },
      handleDOMEvents: {
        pointerdown: () => {
          lastInput = "pointer";
          return false;
        },
      },
      // ProseMirror asks before scrolling the selection into view; in typewriter mode, centre it.
      handleScrollToSelection: (view) => {
        if (!writingModes.getState().typewriter) return false;
        centreCaret(view);
        return true;
      },
    },
    view: (view) => {
      const sync = () => {
        const { focus, dim, typewriter } = writingModes.getState();
        view.dom.classList.toggle("ghw-focus", focus);
        view.dom.classList.toggle("ghw-dim", focus && dim);
        view.dom.classList.toggle("ghw-typewriter", typewriter);
      };
      sync();
      const unsubscribe = writingModes.subscribe((modes, prev) => {
        if (view.isDestroyed) return;
        sync();
        if (modes.focus !== prev.focus || modes.dim !== prev.dim) view.dispatch(view.state.tr.setMeta(modesKey, true));
        // The app's chrome comes and goes with focus mode; keep the caret in sight once it has.
        if (modes.focus !== prev.focus || modes.typewriter !== prev.typewriter) {
          requestAnimationFrame(() => {
            if (view.isDestroyed) return;
            if (writingModes.getState().typewriter) centreCaret(view);
            else view.dispatch(view.state.tr.scrollIntoView());
          });
        }
      });
      return {
        update: (view, before) => {
          if (!writingModes.getState().typewriter) return;
          const moved = !before.selection.eq(view.state.selection);
          if (view.state.doc !== before.doc || (moved && lastInput === "key")) centreCaret(view);
        },
        destroy: unsubscribe,
      };
    },
  });
}

/** In dimmed focus mode, mark the textblock holding the caret. */
function currentParagraph(state: EditorState): DecorationSet {
  const { focus, dim } = writingModes.getState();
  const $head = state.selection.$head;
  if (!focus || !dim || !$head.parent.isTextblock || $head.depth === 0) return DecorationSet.empty;
  return DecorationSet.create(state.doc, [Decoration.node($head.before(), $head.after(), { class: "ghw-current" })]);
}

/** Scroll so the caret line sits at TYPEWRITER_LINE of the scrolling area's height. */
export function centreCaret(view: EditorView): void {
  let caret: { top: number; bottom: number };
  try {
    caret = view.coordsAtPos(view.state.selection.head);
  } catch {
    return; // Not laid out (e.g. hidden).
  }
  const line = (caret.top + caret.bottom) / 2;
  const scroller = scrollParent(view.dom);
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    const delta = line - (box.top + scroller.clientHeight * TYPEWRITER_LINE);
    if (Math.abs(delta) >= 1) scroller.scrollBy({ top: delta, behavior: "instant" });
  } else {
    const delta = line - window.innerHeight * TYPEWRITER_LINE;
    if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, behavior: "instant" });
  }
}

/** The nearest scrolling ancestor, or null for the page itself. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
