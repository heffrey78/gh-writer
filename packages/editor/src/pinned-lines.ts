import { Extension, type Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { SCENE_STRUCTURE } from "./chapter.ts";

/*
 * Pinned details (#149): in the chapter view, a quiet line under each scene's title holding the
 * details the author pinned (point of view, when, where…), given by the app per scene. The line is
 * a widget, not part of the document: it never reaches the Markdown, the word count or find.
 */

export interface PinnedLinesOptions {
  /** Each scene's line, by scene ID (the scene file); read again on refreshPinnedLines. */
  lines: () => Readonly<Record<string, string>>;
}

export const pinnedLinesKey = new PluginKey<DecorationSet>("ghwPinnedLines");

/** A line at the start of each scene that has one. */
export function decoratePinned(doc: Node, lines: Readonly<Record<string, string>>): DecorationSet {
  if (doc.type.name !== "chapter") return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.forEach((scene, offset) => {
    const text = lines[scene.attrs.id as string];
    if (!text) return;
    decorations.push(
      Decoration.widget(
        offset + 1,
        () => {
          const line = document.createElement("div");
          line.className = "ghw-pinned";
          line.setAttribute("contenteditable", "false");
          line.textContent = text;
          return line;
        },
        // Keyed by its text, so an unchanged line isn't drawn again.
        { side: -1, ignoreSelection: true, key: `pinned:${scene.attrs.id}:${text}` },
      ),
    );
  });
  return DecorationSet.create(doc, decorations);
}

function sameScenes(a: Node, b: Node): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (a.child(i).attrs.id !== b.child(i).attrs.id) return false;
  return true;
}

/** Draw the lines again: the pinned details, or the details themselves, changed. */
export function refreshPinnedLines(editor: Editor): void {
  if (editor.isDestroyed) return;
  const lines = (editor.extensionManager.extensions.find((e) => e.name === "pinnedLines")?.options as PinnedLinesOptions | undefined)?.lines() ?? {};
  editor.view.dispatch(editor.state.tr.setMeta(pinnedLinesKey, decoratePinned(editor.state.doc, lines)).setMeta("addToHistory", false));
}

export const PinnedLinesExtension = Extension.create<PinnedLinesOptions>({
  name: "pinnedLines",
  addOptions: () => ({ lines: () => ({}) }),
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: pinnedLinesKey,
        state: {
          init: (_, state) => decoratePinned(state.doc, options.lines()),
          apply: (tr, set) => {
            const meta = tr.getMeta(pinnedLinesKey) as DecorationSet | undefined;
            if (meta) return meta;
            if (!tr.docChanged) return set;
            // Scenes added, removed, moved or loaded afresh: each line goes with its scene.
            if (tr.getMeta(SCENE_STRUCTURE) || !sameScenes(tr.before, tr.doc)) return decoratePinned(tr.doc, options.lines());
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => pinnedLinesKey.getState(state) },
      }),
    ];
  },
});
