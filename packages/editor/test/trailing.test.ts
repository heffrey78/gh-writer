// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { afterEach, expect, test } from "vitest";
import { chapterContent, getMarkdown, loadChapter, loadMarkdown, proseContent, serializeChapter } from "../src/index.ts";
import { TrailingParagraphExtension } from "../src/trailing.ts";

/** A line to write on after a scene ending in a table, a picture or a list (D10), never written to the file. */

let editor: Editor;
afterEach(() => editor?.destroy());
const tick = () => new Promise((r) => setTimeout(r));
const last = (node: { lastChild: { type: { name: string }; content: { size: number } } | null }) => node.lastChild && [node.lastChild.type.name, node.lastChild.content.size];

test("a scene ending in a table gets an empty paragraph after it, unwritten, and kept out of Undo", async () => {
  const md = "Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
  editor = new Editor({ element: document.createElement("div"), extensions: [...proseContent, UndoRedo, TrailingParagraphExtension] });
  loadMarkdown(editor, md);
  await tick();
  expect(last(editor.state.doc)).toEqual(["paragraph", 0]);
  expect(getMarkdown(editor)).toBe(md);
  editor.commands.insertContentAt(1, "Just ");
  editor.commands.undo();
  expect(getMarkdown(editor)).toBe(md);
  expect(last(editor.state.doc)).toEqual(["paragraph", 0]);
  // Text ends it now: nothing more is added.
  loadMarkdown(editor, "Before.\n\n- a\n\nAfter.\n");
  expect(editor.state.doc.childCount).toBe(3);
});

test("each of a chapter's scenes that ends in a picture or a list gets its own", async () => {
  editor = new Editor({ element: document.createElement("div"), extensions: [...chapterContent, UndoRedo, TrailingParagraphExtension] });
  const scenes = [
    { id: "a", title: "A", markdown: "One.\n\n![Map](/images/map.jpg)\n" },
    { id: "b", title: "B", markdown: "Two.\n" },
    { id: "c", title: "C", markdown: "- three\n" },
  ];
  loadChapter(editor, scenes);
  await tick();
  const ends: unknown[] = [];
  editor.state.doc.forEach((scene) => ends.push(last(scene)));
  expect(ends).toEqual([["paragraph", 0], ["paragraph", 4], ["paragraph", 0]]);
  expect(serializeChapter(editor.state.doc)).toEqual(scenes.map(({ id, markdown }) => ({ id, markdown })));
});
