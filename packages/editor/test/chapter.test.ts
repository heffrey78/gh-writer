// @vitest-environment jsdom
import "./dom.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, test } from "vitest";
import { chapterContent, getMarkdown, loadChapter, replaceScene, serializeChapter, splitSceneFile, touchedScenes, type SceneSource } from "../src/index.ts";

const chapterDir = join(import.meta.dirname, "../../../examples/sample-novel/manuscript/02-the-sale/01-night-crossing");
const sample: SceneSource[] = readdirSync(chapterDir)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ id: f, title: f, markdown: splitSceneFile(readFileSync(join(chapterDir, f), "utf8")).body }));

const three: SceneSource[] = [
  { id: "sc_1", title: "One", markdown: "First scene, _first_ paragraph.\n\nFirst scene ends.\n" },
  { id: "sc_2", title: "Two", markdown: "Second scene.\r\n\r\n***\r\n\r\nSecond scene ends.\r\n" },
  { id: "sc_3", title: "Three", markdown: "Third scene, no final newline." },
];

let editor: Editor;
afterEach(() => editor?.destroy());

function open(scenes: SceneSource[]): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: [...chapterContent, UndoRedo] });
  loadChapter(editor, scenes);
  return editor;
}

const bodies = () => Object.fromEntries(serializeChapter(editor.state.doc).map((s) => [s.id, s.markdown]));
const original = (scenes: SceneSource[]) => Object.fromEntries(scenes.map((s) => [s.id, s.markdown]));

function at(text: string, end = false): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    const i = found < 0 && node.isText ? node.text!.indexOf(text) : -1;
    if (i >= 0) found = pos + i + (end ? text.length : 0);
    return found < 0;
  });
  if (found < 0) throw new Error(`"${text}" not in document`);
  return found;
}

function press(key: string): boolean {
  return !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key, bubbles: true })));
}

function type(text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

describe("splitting a chapter into scenes", () => {
  test("an unedited chapter splits back into its files byte for byte", () => {
    open(sample);
    expect(bodies()).toEqual(original(sample));
    open(three);
    expect(bodies()).toEqual(original(three));
  });

  test("editing one scene changes only that scene", () => {
    open(three);
    const before = editor.state.doc;
    editor.commands.insertContentAt(at("Second scene ends", true), " Really.");
    expect(touchedScenes(before, editor.state.doc).map((s) => s.attrs.id)).toEqual(["sc_2"]);
    expect(bodies()).toEqual({ ...original(three), sc_2: "Second scene.\r\n\r\n***\r\n\r\nSecond scene ends Really..\r\n" });
  });

  test("each scene keeps its own file conventions", () => {
    open(three);
    editor.commands.insertContentAt(at("Third scene", true), "!");
    editor.commands.insertContentAt(at(" paragraph", true), [{ type: "text", text: " and " }, { type: "text", text: "more", marks: [{ type: "em" }] }]);
    expect(bodies().sc_3).toBe("Third scene!, no final newline.\n");
    expect(bodies().sc_1).toBe("First scene, _first_ paragraph and _more_.\n\nFirst scene ends.\n");
  });

  test("scene boundaries are labelled sections", () => {
    open(three);
    const sections = [...editor.view.dom.querySelectorAll("section[data-scene]")];
    expect(sections.map((s) => [s.getAttribute("data-scene"), s.getAttribute("aria-label")])).toEqual([
      ["sc_1", "Scene: One"],
      ["sc_2", "Scene: Two"],
      ["sc_3", "Scene: Three"],
    ]);
  });
});

describe("scene boundaries", () => {
  test("Backspace at the start of a scene doesn't join it to the previous one", () => {
    open(three);
    editor.commands.setTextSelection(at("Second scene."));
    press("Backspace");
    expect(bodies()).toEqual(original(three));
    expect(editor.state.doc.childCount).toBe(3);
  });

  test("Delete at the end of a scene doesn't join the next one", () => {
    open(three);
    editor.commands.setTextSelection(at("First scene ends.", true));
    press("Delete");
    expect(bodies()).toEqual(original(three));
  });

  test("a transaction that would merge or remove scenes is rejected", () => {
    open(three);
    const before = editor.state.doc;
    editor.view.dispatch(editor.state.tr.delete(at("ends"), at("Second scene ends")));
    expect(editor.state.doc).toBe(before);
    editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
    expect(editor.state.doc).toBe(before);
  });

  test("deleting a selection across scenes deletes each scene's part", () => {
    open(three);
    editor.commands.setTextSelection({ from: at("ends."), to: at("Second scene ends") });
    expect(press("Backspace")).toBe(true);
    expect(bodies()).toEqual({ ...original(three), sc_1: "First scene, _first_ paragraph.\n\nFirst scene\n", sc_2: "Second scene ends.\r\n" });
    expect(editor.state.selection.from).toBe(at("First scene ", true));
  });

  test("typing over a selection across scenes replaces each part and keeps the scenes", () => {
    open(three);
    editor.commands.setTextSelection({ from: at("paragraph"), to: at("no final") });
    type("X");
    expect(editor.state.doc.childCount).toBe(3);
    expect(bodies()).toEqual({ sc_1: "First scene, _first_ X\n", sc_2: "\r\n", sc_3: "no final newline.\n" });
  });

  test("selecting everything and deleting leaves every scene, empty", () => {
    open(three);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, editor.state.doc.content.size - 2)));
    press("Backspace");
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.textContent).toBe("");
  });

  // Ctrl+A, and in Firefox a drag that starts below the text, select up to the chapter's own edges.
  const opening: SceneSource[] = [{ id: "sc_1", title: "Opening", markdown: "Write the first line here.\n" }];
  const everything = {
    "Ctrl+A": () => editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc))),
    "a selection to the chapter's edges": () => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 0, editor.state.doc.content.size))),
  };
  for (const [how, select] of Object.entries(everything)) {
    for (const key of ["Backspace", "Delete"])
      test(`${how} then ${key} empties every scene`, () => {
        for (const scenes of [opening, three]) {
          open(scenes);
          select();
          expect(press(key)).toBe(true);
          expect(editor.state.doc.childCount).toBe(scenes.length);
          expect(editor.state.doc.textContent).toBe("");
        }
      });

    test(`${how} then typing replaces everything, in the first scene`, () => {
      for (const scenes of [opening, three]) {
        open(scenes);
        select();
        type("New");
        expect(editor.state.doc.childCount).toBe(scenes.length);
        expect(serializeChapter(editor.state.doc).map((s) => s.markdown.trim())).toEqual(scenes.map((_, i) => (i ? "" : "New")));
      }
    });
  }

  test("the caret moves across scene boundaries", () => {
    open(three);
    editor.commands.setTextSelection(at("First scene ends.", true));
    // Moving one position forward lands in the next scene's first paragraph.
    const next = TextSelection.near(editor.state.doc.resolve(editor.state.selection.from + 1), 1);
    expect(next.$from.node(1).attrs.id).toBe("sc_2");
  });

  test("undo across scenes restores every file", () => {
    open(three);
    editor.commands.insertContentAt(at("First scene ends", true), " A");
    editor.commands.insertContentAt(at("Third scene", true), " B");
    while (editor.can().undo()) editor.commands.undo();
    expect(bodies()).toEqual(original(three));
  });
});

describe("replacing a scene", () => {
  test("replaces one scene's text without touching the others or the history", () => {
    open(three);
    editor.commands.insertContentAt(at("First scene ends", true), " Edited.");
    const before = editor.state.doc;
    replaceScene(editor, { id: "sc_3", title: "Three", markdown: "Changed on disk.\n" });
    expect(editor.state.doc.child(0)).toBe(before.child(0));
    expect(editor.state.doc.child(1)).toBe(before.child(1));
    expect(bodies().sc_3).toBe("Changed on disk.\n");
    editor.commands.undo();
    expect(bodies()).toEqual({ ...original(three), sc_3: "Changed on disk.\n" });
  });
});

test("getMarkdown is for single scenes; a chapter splits with serializeChapter", () => {
  open(three);
  expect(() => getMarkdown(editor)).not.toThrow();
});
