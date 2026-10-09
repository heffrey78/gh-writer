import { resolveAnchor } from "@gh-writer/core";
import { Extension, type Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { parseProse } from "./markdown.ts";
import { proseSchema } from "./schema.ts";
import { editorScenes } from "./search.ts";

/*
 * Notes on passages in the margin (#9): each open issue raised about a passage is found in the text
 * (resolveAnchor, after whatever editing since) and shown with a marker beside its paragraph. The
 * marker opens it; while hovered or focused, its passage is highlighted.
 */

/** An open issue about a passage, for the editor to place. */
export interface AnchoredIssue {
  number: number;
  title: string;
  /** The scene it's about, as the editor knows scenes (the scene file). */
  scene: string;
  quote: string;
}

export interface IssueMarksOptions {
  /** The issues to show; read again whenever the editor is told they changed (refreshIssueMarks). */
  issues: () => readonly AnchoredIssue[];
  /** A marker (or the shortcut beside a passage) was chosen: the issues there. */
  onOpen: (numbers: number[]) => void;
}

/** The placed decorations, and the issues whose passages are lit (their marker hovered or focused). */
interface MarksState {
  set: DecorationSet;
  active: readonly number[];
}

export const issueMarksKey = new PluginKey<MarksState>("ghwIssueMarks");

/** The shortcut that opens the issues about the passage at the caret. */
export const ISSUE_MARKS_KEY = "Mod-Alt-i";

/** How long typing must pause before markers follow the text (ms). */
const DELAY = 250;

/**
 * A scene's text as raising an issue quotes it: paragraphs two newlines apart, a hard break as a
 * newline, a mention as its words. `from[i]`/`to[i]` are where the i-th character is in the document.
 */
export function sceneTextAt(scene: Node, contentStart: number): { text: string; from: number[]; to: number[] } {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let lastEnd = contentStart;
  const push = (s: string, a: number, b: number) => {
    for (let i = 0; i < s.length; i++) {
      text += s[i];
      from.push(a);
      to.push(b);
    }
  };
  scene.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const start = contentStart + pos + 1;
    if (text) push("\n\n", lastEnd, lastEnd);
    node.forEach((child, offset) => {
      const p = start + offset;
      if (child.isText) for (let i = 0; i < child.text!.length; i++) push(child.text![i]!, p + i, p + i + 1);
      else if (child.type.name === "hardBreak") push("\n", p, p + 1);
      else push(String(child.attrs.label ?? ""), p, p + child.nodeSize);
    });
    lastEnd = start + node.content.size;
    return false;
  });
  return { text, from, to };
}

/** A scene body's text as the editor reads it (for finding a passage without an editor: the Issues view). */
export function sceneText(markdown: string): string {
  return sceneTextAt(parseProse(markdown, proseSchema), 0).text;
}

/** Tell the editor its issues changed: markers are placed again, now. */
export function refreshIssueMarks(editor: Editor): void {
  if (!editor.isDestroyed) place(editor);
}

function place(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(issueMarksKey, decorate(editor)).setMeta("addToHistory", false));
}

/** The decorations for the editor's issues in its scenes: a highlight per passage, a marker per paragraph. */
function decorate(editor: Editor): DecorationSet {
  const options = editor.extensionManager.extensions.find((e) => e.name === "issueMarks")?.options as IssueMarksOptions | undefined;
  if (!options) return DecorationSet.empty;
  const issues = options.issues();
  const onOpen = (numbers: number[]) => options.onOpen(numbers);
  const { doc } = editor.state;
  const decorations: Decoration[] = [];
  const scenes = editorScenes(editor);
  const byScene = new Map<string, AnchoredIssue[]>();
  for (const issue of issues) byScene.set(issue.scene, [...(byScene.get(issue.scene) ?? []), issue]);
  for (const [sceneId, list] of byScene) {
    const scene = scenes.get(sceneId);
    if (!scene) continue;
    const { text, from, to } = sceneTextAt(scene.node, scene.contentStart);
    const markers = new Map<number, AnchoredIssue[]>();
    for (const issue of list) {
      const match = resolveAnchor(text, issue.quote);
      if (!match) continue;
      const a = from[match.from]!;
      const b = to[match.to - 1]!;
      if (a >= b) continue;
      decorations.push(Decoration.inline(a, b, { class: "ghw-issue-passage", "data-ghw-issue": String(issue.number) }, { issue: issue.number }));
      const $a = doc.resolve(a);
      const block = $a.start($a.depth);
      markers.set(block, [...(markers.get(block) ?? []), issue]);
    }
    for (const [pos, here] of markers) {
      decorations.push(
        Decoration.widget(pos, (view) => marker(view, here, onOpen), {
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
          key: `ghw-issues-${here.map((i) => `${i.number}:${i.title}`).join(",")}`,
        }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

/** The margin marker for the issues about a paragraph's passages. */
function marker(view: EditorView, issues: AnchoredIssue[], onOpen: (numbers: number[]) => void): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghw-issue-marker";
  button.contentEditable = "false";
  button.textContent = String(issues.length);
  const label = issues.length === 1 ? `Issue #${issues[0]!.number}: ${issues[0]!.title}` : `${issues.length} issues: ${issues.map((i) => `#${i.number} ${i.title}`).join("; ")}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  // Lit by a decoration, not by changing the text's DOM (which the editor would redraw, marker and all).
  const highlight = (on: boolean) => view.dispatch(view.state.tr.setMeta(issueMarksKey, { active: on ? issues.map((i) => i.number) : [] }).setMeta("addToHistory", false));
  button.addEventListener("mouseenter", () => highlight(true));
  button.addEventListener("mouseleave", () => highlight(false));
  button.addEventListener("focus", () => highlight(true));
  button.addEventListener("blur", () => highlight(false));
  // The text keeps its selection; the click opens the issues.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => onOpen(issues.map((i) => i.number)));
  return button;
}

/**
 * Open issues beside their passages: a highlight on each passage and a marker in the margin of its
 * paragraph (a count when several), placed again as the text changes (after a pause) and when the
 * issues change. Mod-Alt-i opens those about the passage or paragraph at the caret.
 */
export const IssueMarksExtension = Extension.create<IssueMarksOptions>({
  name: "issueMarks",
  addOptions: () => ({ issues: () => [], onOpen: () => {} }),
  addKeyboardShortcuts() {
    return {
      [ISSUE_MARKS_KEY]: () => {
        const { state } = this.editor;
        const set = issueMarksKey.getState(state)?.set;
        const at = state.selection.from;
        const $at = state.doc.resolve(at);
        const blockStart = $at.start($at.depth);
        const numbers = new Set<number>();
        for (const d of set?.find(blockStart, $at.end($at.depth), (spec) => typeof spec.issue === "number") ?? []) numbers.add((d.spec as { issue: number }).issue);
        if (!numbers.size) return false;
        this.options.onOpen([...numbers]);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<MarksState>({
        key: issueMarksKey,
        state: {
          init: () => ({ set: DecorationSet.empty, active: [] }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(issueMarksKey) as DecorationSet | { active: number[] } | undefined;
            if (meta instanceof DecorationSet) return { set: meta, active: prev.active };
            if (meta) return { set: prev.set.map(tr.mapping, tr.doc), active: meta.active };
            return { set: prev.set.map(tr.mapping, tr.doc), active: prev.active };
          },
        },
        props: {
          decorations: (state) => {
            const marks = issueMarksKey.getState(state);
            if (!marks?.active.length) return marks?.set;
            const lit = marks.set.find(undefined, undefined, (spec) => marks.active.includes(spec.issue as number)).map((d) => Decoration.inline(d.from, d.to, { class: "is-active" }));
            return marks.set.add(state.doc, lit);
          },
        },
        view: () => {
          let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => !editor.isDestroyed && place(editor), 0);
          return {
            update: (view, prev) => {
              // The text changed: the markers follow it once typing pauses (mapped along meanwhile).
              if (view.state.doc === prev.doc) return;
              clearTimeout(timer);
              timer = setTimeout(() => !editor.isDestroyed && place(editor), DELAY);
            },
            destroy: () => clearTimeout(timer),
          };
        },
      }),
    ];
  },
});
