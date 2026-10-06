import type { Editor } from "@tiptap/core";
import type { Node, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Extension } from "@tiptap/core";
import type { SceneMarkdown, SceneSource } from "./chapter.ts";
import { parseProse, serializeProse } from "./markdown.ts";
import { proseSchema } from "./schema.ts";

/*
 * Find and replace across a manuscript.
 *
 * Each textblock is searched as the text a reader sees: text runs joined across formatting, a
 * mention as its label, a line break as "\n", and raw inline Markdown as an object replacement
 * character, so it can't match. Front matter and mention IDs are never part of the text.
 * Scenes open in an editor are searched in the editor's live document; the rest are parsed from
 * their Markdown (cached by content).
 */

export interface SearchQuery {
  text: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export type SearchScope = "scene" | "chapter" | "manuscript";

export interface ManuscriptChapter {
  id: string;
  title: string;
  /** Scenes in reading order. */
  scenes: SceneSource[];
}

/** Chapters in reading order. */
export type Manuscript = ManuscriptChapter[];

export interface SearchMatch {
  sceneId: string;
  /** Range in the document holding the scene: the editor's when `live`, else the scene's own. */
  from: number;
  to: number;
  text: string;
  /** Up to a few words either side, for showing the match in context. */
  before: string;
  after: string;
  /** False when the match covers only part of a mention, which can't be partly replaced. */
  replaceable: boolean;
  /** Capture groups, for $1… in a regex replacement. */
  groups: (string | undefined)[];
  named: Record<string, string | undefined>;
}

export interface SceneResult {
  sceneId: string;
  title: string;
  /** Searched in the open editor's document (positions are the editor's). */
  live: boolean;
  matches: SearchMatch[];
}

export interface ChapterResult {
  chapterId: string;
  title: string;
  scenes: SceneResult[];
}

export interface SearchResults {
  chapters: ChapterResult[];
  count: number;
  error?: string;
}

/** Compile a query to a global regular expression, or explain why it can't be. */
export function compileQuery(query: SearchQuery): RegExp | { error: string } {
  if (!query.text) return { error: "" };
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${query.caseSensitive ? "" : "i"}`);
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid regular expression: /, "") };
  }
}

// ---------------------------------------------------------------------------
// Text index

interface Piece {
  /** Offsets in the textblock's text. */
  start: number;
  end: number;
  /** Document offset of the piece's first character within the textblock's content. */
  pos: number;
  /** Set for an atom (mention, raw inline): the whole piece is one document position. */
  atom?: Node;
}

interface TextIndex {
  text: string;
  pieces: Piece[];
}

const OBJECT = "￼";
const indexes = new WeakMap<Node, TextIndex>();

function textIndex(block: Node): TextIndex {
  let index = indexes.get(block);
  if (index) return index;
  let text = "";
  const pieces: Piece[] = [];
  block.forEach((child, offset) => {
    let piece: string;
    if (child.isText) piece = child.text!;
    else if (child.type.name === "mention") piece = child.attrs.label || OBJECT;
    else if (child.type.name === "hard_break") piece = "\n";
    else piece = OBJECT;
    pieces.push({ start: text.length, end: text.length + piece.length, pos: offset, atom: child.isText ? undefined : child });
    text += piece;
  });
  index = { text, pieces };
  indexes.set(block, index);
  return index;
}

/**
 * Map a text offset to a document offset within the textblock's content. An offset inside an
 * atom's text snaps to the atom's edge and is `partial`, since an atom can't be partly replaced.
 */
function toPos(index: TextIndex, offset: number, side: "start" | "end"): { pos: number; partial: boolean } {
  for (const piece of index.pieces) {
    const inside = side === "start" ? offset >= piece.start && offset < piece.end : offset > piece.start && offset <= piece.end;
    if (!inside) continue;
    if (!piece.atom) return { pos: piece.pos + offset - piece.start, partial: false };
    const edge = offset === (side === "start" ? piece.start : piece.end);
    return { pos: side === "start" ? piece.pos : piece.pos + 1, partial: !edge };
  }
  return { pos: 0, partial: true }; // unreachable for a non-empty match
}

function context(text: string, from: number, to: number): { before: string; after: string } {
  const before = text.slice(Math.max(0, from - 40), from);
  const after = text.slice(to, to + 40);
  return {
    before: (from > 40 ? "…" + before.replace(/^\S*\s/, "") : before).replace(/\n/g, " "),
    after: (to + 40 < text.length ? after.replace(/\s\S*$/, "") + "…" : after).replace(/\n/g, " "),
  };
}

/** Matches in a scene's blocks. `node` holds the blocks; `contentStart` is where its content begins in the document. */
export function findInNode(node: Node, contentStart: number, re: RegExp, sceneId: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  node.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const index = textIndex(block);
    const start = contentStart + pos + 1;
    re.lastIndex = 0;
    for (let m = re.exec(index.text); m; m = re.exec(index.text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (m[0].includes(OBJECT)) continue;
      const from = toPos(index, m.index, "start");
      const to = toPos(index, m.index + m[0].length, "end");
      matches.push({
        sceneId,
        from: start + from.pos,
        to: start + to.pos,
        text: m[0],
        ...context(index.text, m.index, m.index + m[0].length),
        replaceable: !from.partial && !to.partial,
        groups: m.slice(1),
        named: { ...m.groups },
      });
    }
    return false;
  });
  return matches;
}

// ---------------------------------------------------------------------------
// Manuscript search

const parsed = new Map<string, Node>();

/** A closed scene's document, parsed once per content. */
function sceneDoc(markdown: string, schema: Schema = proseSchema): Node {
  let doc = parsed.get(markdown);
  if (!doc || doc.type.schema !== schema) {
    doc = parseProse(markdown, schema);
    if (parsed.size > 2000) parsed.clear();
    parsed.set(markdown, doc);
  }
  return doc;
}

/** The scenes an editor holds: each scene's node and where its content starts in the editor's document. */
export function editorScenes(editor: Editor): Map<string, { node: Node; contentStart: number }> {
  const scenes = new Map<string, { node: Node; contentStart: number }>();
  const { doc } = editor.state;
  if (doc.type.name === "chapter") doc.forEach((scene, offset) => void scenes.set(scene.attrs.id, { node: scene, contentStart: offset + 1 }));
  else {
    const id = editor.extensionManager.extensions.find((e) => e.name === "wordCount")?.options.sceneId ?? "scene";
    scenes.set(id, { node: doc, contentStart: 0 });
  }
  return scenes;
}

/** The scene the editor's caret is in. */
export function caretScene(editor: Editor): string | undefined {
  const { doc, selection } = editor.state;
  if (doc.type.name === "chapter") return doc.child(Math.min(selection.$head.index(0), doc.childCount - 1)).attrs.id;
  return [...editorScenes(editor).keys()][0];
}

export interface SearchOptions {
  manuscript: Manuscript;
  query: SearchQuery;
  scope: SearchScope;
  /** The open editor: its scenes are searched live. */
  editor?: Editor | null;
  /** The scene the search is about, for the scene and chapter scopes; defaults to the caret's. */
  sceneId?: string;
}

/** Search a manuscript, grouped by chapter and scene in reading order. */
export function searchManuscript({ manuscript, query, scope, editor, sceneId }: SearchOptions): SearchResults {
  const re = compileQuery(query);
  if (!(re instanceof RegExp)) return { chapters: [], count: 0, error: re.error || undefined };
  const live = editor && !editor.isDestroyed ? editorScenes(editor) : new Map();
  const here = sceneId ?? (editor && !editor.isDestroyed ? caretScene(editor) : undefined);
  const chapterOf = manuscript.find((c) => c.scenes.some((s) => s.id === here));
  const chapters: ChapterResult[] = [];
  let count = 0;
  for (const chapter of manuscript) {
    if (scope !== "manuscript" && chapter !== chapterOf) continue;
    const scenes: SceneResult[] = [];
    for (const scene of chapter.scenes) {
      if (scope === "scene" && scene.id !== here) continue;
      const open = live.get(scene.id);
      const matches = open ? findInNode(open.node, open.contentStart, re, scene.id) : findInNode(sceneDoc(scene.markdown), 0, re, scene.id);
      if (matches.length) scenes.push({ sceneId: scene.id, title: scene.title ?? scene.id, live: !!open, matches });
      count += matches.length;
    }
    if (scenes.length) chapters.push({ chapterId: chapter.id, title: chapter.title, scenes });
  }
  return { chapters, count };
}

// ---------------------------------------------------------------------------
// Replacing

/** The replacement for a match: literal, or with $&, $1…, $<name> and $$ expanded for a regex. */
export function expandReplacement(template: string, match: SearchMatch, regex: boolean): string {
  if (!regex) return template;
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, token: string, name?: string) => {
    if (token === "$") return "$";
    if (token === "&") return match.text;
    if (name !== undefined) return match.named[name] ?? "";
    const n = Number(token);
    return n >= 1 && n <= match.groups.length ? (match.groups[n - 1] ?? "") : all;
  });
}

/** Apply replacements to a transform, last first so earlier positions stay valid. Returns how many were made. */
export function applyReplacements(tr: Transform, matches: SearchMatch[], replacement: string, regex: boolean): number {
  let made = 0;
  for (const match of [...matches].sort((a, b) => b.from - a.from)) {
    if (!match.replaceable) continue;
    const text = expandReplacement(replacement, match, regex);
    const atom = tr.doc.nodeAt(match.from);
    if (atom?.type.name === "mention" && match.to === match.from + 1) {
      // The whole of a mention's label: rename the mention, keep the link to its entity.
      if (text) tr.setNodeMarkup(match.from, undefined, { ...atom.attrs, label: text });
      else tr.delete(match.from, match.to);
    } else {
      const marks = tr.doc.resolve(match.from).marksAcross(tr.doc.resolve(match.to)) ?? atom?.marks ?? [];
      if (text) tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(text, marks));
      else tr.delete(match.from, match.to);
    }
    made++;
  }
  return made;
}

/** Replace matches in a closed scene's Markdown. */
export function replaceInMarkdown(markdown: string, matches: SearchMatch[], replacement: string, regex: boolean): string {
  const tr = new Transform(sceneDoc(markdown));
  return applyReplacements(tr, matches, replacement, regex) ? serializeProse(tr.doc) : markdown;
}

export interface ReplaceAllResult {
  /** Closed scenes whose Markdown changed, for the app to save. */
  changed: SceneMarkdown[];
  /** Their Markdown before, for undo. */
  previous: SceneMarkdown[];
  /** The editor transaction, if any open scene changed (already dispatched as one undoable step). */
  editorChanged: boolean;
  replaced: number;
}

/**
 * Replace every replaceable match in the results: open scenes in one editor transaction (one
 * undo step), closed scenes as new Markdown. Scenes without matches are left alone.
 */
export function replaceAll(results: SearchResults, manuscript: Manuscript, replacement: string, regex: boolean, editor?: Editor | null): ReplaceAllResult {
  const markdown = new Map(manuscript.flatMap((c) => c.scenes.map((s) => [s.id, s.markdown] as const)));
  const changed: SceneMarkdown[] = [];
  const previous: SceneMarkdown[] = [];
  let replaced = 0;
  const liveMatches: SearchMatch[] = [];
  for (const chapter of results.chapters) {
    for (const scene of chapter.scenes) {
      if (scene.live) {
        liveMatches.push(...scene.matches);
        continue;
      }
      const before = markdown.get(scene.sceneId);
      if (before === undefined) continue;
      const after = replaceInMarkdown(before, scene.matches, replacement, regex);
      replaced += scene.matches.filter((m) => m.replaceable).length;
      if (after !== before) {
        changed.push({ id: scene.sceneId, markdown: after });
        previous.push({ id: scene.sceneId, markdown: before });
      }
    }
  }
  let editorChanged = false;
  if (liveMatches.length && editor && !editor.isDestroyed) {
    const tr = editor.state.tr;
    const made = applyReplacements(tr, liveMatches, replacement, regex);
    if (made) {
      editor.view.dispatch(tr.scrollIntoView());
      editorChanged = true;
      replaced += made;
    }
  }
  return { changed, previous, editorChanged, replaced };
}

/** Replace one match in the open editor, selecting the replacement. */
export function replaceInEditor(editor: Editor, match: SearchMatch, replacement: string, regex: boolean): boolean {
  const tr: Transaction = editor.state.tr;
  if (!applyReplacements(tr, [match], replacement, regex)) return false;
  const end = tr.mapping.map(match.to);
  tr.setSelection(TextSelection.create(tr.doc, end));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------
// Highlighting

const highlightKey = new PluginKey<DecorationSet>("ghwSearchHighlight");

/** Highlight search matches in the editor; the current one is marked separately. */
export function setSearchHighlights(editor: Editor, ranges: { from: number; to: number }[], current?: { from: number; to: number }): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(highlightKey, { ranges, current }).setMeta("addToHistory", false));
}

export const SearchHighlightExtension = Extension.create({
  name: "searchHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: highlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => {
            const meta = tr.getMeta(highlightKey) as { ranges: { from: number; to: number }[]; current?: { from: number; to: number } } | undefined;
            if (!meta) return set.map(tr.mapping, tr.doc);
            const size = tr.doc.content.size;
            const valid = (r: { from: number; to: number }) => r.from >= 0 && r.to <= size && r.from < r.to;
            return DecorationSet.create(
              tr.doc,
              meta.ranges.filter(valid).map((r) => {
                const isCurrent = meta.current && r.from === meta.current.from && r.to === meta.current.to;
                return Decoration.inline(r.from, r.to, { class: isCurrent ? "ghw-match ghw-match-current" : "ghw-match" });
              }),
            );
          },
        },
        props: { decorations: (state) => highlightKey.getState(state) },
      }),
    ];
  },
});

/**
 * Where the caret is, as the scene it's in (its ID; "scene" or the sceneId option for a single-scene
 * editor) and the index of its top-level block in that scene: the paragraph a split would start.
 */
export function caretBlock(editor: Editor): { sceneId: string; block: number } | undefined {
  const { doc, selection } = editor.state;
  const $head = selection.$head;
  if (doc.type.name === "chapter") {
    if ($head.depth < 2) return undefined;
    return { sceneId: doc.child($head.index(0)).attrs.id as string, block: $head.index(1) };
  }
  const sceneId = [...editorScenes(editor).keys()][0];
  return sceneId === undefined || $head.depth < 1 ? undefined : { sceneId, block: $head.index(0) };
}
