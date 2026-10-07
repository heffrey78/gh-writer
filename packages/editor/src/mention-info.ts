import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** A mention the author is pointing at or has the caret on. */
export interface MentionTarget {
  /** The entity's ID. */
  id: string;
  /** The mention's position in the document. */
  pos: number;
  /** Its element, to place a card by. */
  element: HTMLElement;
  /** In a chapter, the scene holding it (the scene node's ID); otherwise undefined. */
  sceneId: string | undefined;
  /** By pointer (hover) or by keyboard (the shortcut). */
  via: "pointer" | "keyboard";
}

export interface MentionInfoOptions {
  /** Show what's known about the mention. */
  onShow: (target: MentionTarget) => void;
  /** The pointer left the mention (a card may stay open while it's pointed at). */
  onLeave: () => void;
}

/** The shortcut that shows the card of the mention at the caret. */
export const MENTION_INFO_KEYS = "Alt-Enter";

function sceneAt(view: EditorView, pos: number): string | undefined {
  const { doc } = view.state;
  if (doc.type.name !== "chapter") return undefined;
  return doc.resolve(pos).node(1).attrs.id as string | undefined;
}

/** The mention right before or after the caret, if there is one. */
export function mentionAtCaret(editor: Editor): { id: string; pos: number } | undefined {
  const { selection } = editor.state;
  const $at = selection.$head;
  if (!selection.empty) return undefined;
  if ($at.nodeAfter?.type.name === "mention") return { id: $at.nodeAfter.attrs.id as string, pos: $at.pos };
  if ($at.nodeBefore?.type.name === "mention") return { id: $at.nodeBefore.attrs.id as string, pos: $at.pos - $at.nodeBefore.nodeSize };
  return undefined;
}

const HOVER_DELAY = 350;

/**
 * Tells the app when a mention is hovered, or when Alt+Enter is pressed with the caret beside one,
 * so it can show a card about the entity. The editor shows nothing itself.
 */
export const MentionInfoExtension = Extension.create<MentionInfoOptions>({
  name: "mentionInfo",
  addOptions: () => ({ onShow: () => {}, onLeave: () => {} }),

  addKeyboardShortcuts() {
    return {
      [MENTION_INFO_KEYS]: ({ editor }) => {
        const at = mentionAtCaret(editor);
        const element = at && (editor.view.nodeDOM(at.pos) as HTMLElement | null);
        if (!at || !element) return false;
        this.options.onShow({ ...at, element, sceneId: sceneAt(editor.view, at.pos), via: "keyboard" });
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over: HTMLElement | null = null;
    return [
      new Plugin({
        key: new PluginKey("mentionInfo"),
        props: {
          handleDOMEvents: {
            mouseover(view, event) {
              const element = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-mention]") ?? null;
              if (element === over) return false;
              over = element;
              clearTimeout(timer);
              if (!element) {
                options.onLeave();
                return false;
              }
              timer = setTimeout(() => {
                if (over !== element || !element.isConnected || view.isDestroyed) return;
                const pos = view.posAtDOM(element, 0);
                const id = element.getAttribute("data-mention");
                if (id) options.onShow({ id, pos, element, sceneId: sceneAt(view, pos), via: "pointer" });
              }, HOVER_DELAY);
              return false;
            },
            mouseleave() {
              clearTimeout(timer);
              if (over) options.onLeave();
              over = null;
              return false;
            },
          },
        },
        view: () => ({ destroy: () => clearTimeout(timer) }),
      }),
    ];
  },
});
