import { Node, type Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Doc, hidden, proseContent } from "./extensions.ts";
import { parseProse, serializeProse } from "./markdown.ts";

/*
 * A chapter as one continuous document: the top node holds one `scene` node per scene file, in
 * reading order, and each scene holds that file's blocks and file attributes. Scenes split back
 * into per-file Markdown with serializeProse, and ProseMirror reuses untouched scene nodes, so
 * identity tells which files changed.
 */

/** Transaction meta that allows adding, removing or reordering scenes (not ordinary editing). */
export const SCENE_STRUCTURE = "ghwSceneStructure";

export interface SceneSource {
  id: string;
  title?: string;
  /** The scene body: the Markdown after the front matter. */
  markdown: string;
}

export interface SceneMarkdown {
  id: string;
  markdown: string;
}

export const ChapterDoc = Node.create({
  name: "chapter",
  topNode: true,
  content: "scene+",
});

const sceneGuardKey = new PluginKey("ghwSceneGuard");

export const Scene = Node.create({
  name: "scene",
  // Ahead of the core keymap, so a Backspace over several scenes is handled here first.
  priority: 1100,
  content: "block+",
  // Isolating: Backspace at a scene's start or Delete at its end won't join it with its neighbour.
  isolating: true,
  defining: true,
  selectable: false,
  addAttributes: () => ({
    id: { default: null, rendered: false, parseHTML: (el) => el.getAttribute("data-scene") },
    title: { default: "", rendered: false, parseHTML: (el) => el.getAttribute("data-title") ?? "" },
    ...hidden({ trailing: "\n", eol: "\n", style: null }),
  }),
  parseHTML: () => [{ tag: "section[data-scene]" }],
  renderHTML: ({ node }) => [
    "section",
    {
      class: "ghw-scene",
      "data-scene": node.attrs.id,
      "data-title": node.attrs.title,
      role: "group",
      "aria-label": node.attrs.title ? `Scene: ${node.attrs.title}` : "Scene",
    },
    0,
  ],
  addKeyboardShortcuts() {
    const remove = () => deleteAcrossScenes(this.editor);
    return { Backspace: remove, Delete: remove, "Mod-Backspace": remove, "Mod-Delete": remove };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: sceneGuardKey,
        // Ordinary editing may change what is inside scenes but never which scenes there are.
        filterTransaction: (tr, state) => !tr.docChanged || !!tr.getMeta(SCENE_STRUCTURE) || sameScenes(state.doc, tr.doc),
        props: {
          // Typing over a selection that spans scenes replaces each scene's part separately.
          handleTextInput: (_view, from, to, text) => {
            if (!spansScenes(editor.state.doc, from, to) || !deleteAcrossScenes(editor)) return false;
            editor.view.dispatch(editor.state.tr.insertText(text));
            return true;
          },
        },
      }),
    ];
  },
});

/** The nodes and marks of a chapter: scene prose with a chapter of scenes as the top node. */
export const chapterContent = [ChapterDoc, Scene, ...proseContent.filter((e) => e !== Doc)];

function sameScenes(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) if (a.child(i).attrs.id !== b.child(i).attrs.id) return false;
  return true;
}

function spansScenes(doc: PMNode, from: number, to: number): boolean {
  return from !== to && doc.resolve(from).index(0) !== doc.resolve(to).index(0);
}

/**
 * Delete a selection that spans scenes by deleting each scene's part of it, so the scenes stay
 * separate files. A scene whose whole text is selected keeps one empty paragraph.
 */
export function deleteAcrossScenes(editor: Editor): boolean {
  const { state } = editor;
  const { from, to } = state.selection;
  if (!spansScenes(state.doc, from, to)) return false;
  const tr = state.tr;
  const first = state.doc.resolve(from).index(0);
  for (let i = state.doc.resolve(to).index(0); i >= first; i--) {
    let start = 0;
    for (let j = 0; j < i; j++) start += state.doc.child(j).nodeSize;
    const scene = state.doc.child(i);
    const contentStart = start + 1;
    const contentEnd = contentStart + scene.content.size;
    const a = Math.max(from, contentStart);
    const b = Math.min(to, contentEnd);
    if (a >= b) continue;
    if (a === contentStart && b === contentEnd) tr.replaceWith(a, b, state.schema.nodes.paragraph!.create());
    else tr.delete(a, b);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(from, -1))));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** A scene node for a scene body. */
export function parseScene(scene: SceneSource, schema: Schema): PMNode {
  return parseProse(scene.markdown, schema, schema.nodes.scene!, { id: scene.id, title: scene.title ?? "" });
}

/** A chapter document from its scenes in reading order. */
export function parseChapter(scenes: SceneSource[], schema: Schema): PMNode {
  if (!scenes.length) throw new Error("A chapter needs at least one scene");
  return schema.topNodeType.create(null, scenes.map((s) => parseScene(s, schema)));
}

/** Each scene's body, in reading order. */
export function serializeChapter(doc: PMNode): SceneMarkdown[] {
  const out: SceneMarkdown[] = [];
  doc.forEach((scene) => out.push({ id: scene.attrs.id, markdown: serializeProse(scene) }));
  return out;
}

/** The scenes of `doc` whose node isn't the one `before` had: the only ones that may have changed. */
export function touchedScenes(before: PMNode, doc: PMNode): PMNode[] {
  const old = new Map<string, PMNode>();
  before.forEach((scene) => old.set(scene.attrs.id, scene));
  const out: PMNode[] = [];
  doc.forEach((scene) => void (old.get(scene.attrs.id) !== scene && out.push(scene)));
  return out;
}

/** Load a chapter into an editor built with chapterContent, with a fresh undo history. */
export function loadChapter(editor: Editor, scenes: SceneSource[]): void {
  const doc = parseChapter(scenes, editor.schema);
  editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins, selection: TextSelection.atStart(doc) }));
}

/**
 * Replace one scene's content, e.g. after the file changed on disk, keeping the rest of the
 * chapter, the selection where it can and the undo history (the replacement isn't undoable).
 */
export function replaceScene(editor: Editor, scene: SceneSource): boolean {
  const { doc } = editor.state;
  let pos = -1;
  doc.forEach((node, offset) => void (node.attrs.id === scene.id && (pos = offset)));
  if (pos < 0) return false;
  const tr: Transaction = editor.state.tr
    .replaceWith(pos, pos + doc.nodeAt(pos)!.nodeSize, parseScene(scene, editor.schema))
    .setMeta(SCENE_STRUCTURE, true)
    .setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}
