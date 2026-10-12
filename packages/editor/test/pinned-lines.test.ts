// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { chapterContent, loadChapter, PinnedLinesExtension, refreshPinnedLines, serializeChapter } from "../src/index.ts";

const ONE = "First scene opens.\n\nShe counted the flags twice.\n";
const TWO = "Second scene, by the toll house.\n";

let editor: Editor;
let lines: Record<string, string>;
afterEach(() => editor?.destroy());

function open() {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...chapterContent, PinnedLinesExtension.configure({ lines: () => lines })],
  });
  loadChapter(editor, [
    { id: "one.md", title: "The Station", markdown: ONE },
    { id: "two.md", title: "Walking the Span", markdown: TWO },
  ]);
}

/** Each scene's line, in reading order: its text, or null where it has none. */
const shown = () => [...editor.view.dom.querySelectorAll(".ghw-scene")].map((s) => s.querySelector(":scope > .ghw-pinned")?.textContent ?? null);

describe("pinned lines", () => {
  it("shows each scene's line at its start, never in the text, its Markdown or its words", () => {
    lines = { "one.md": "Ada Varn · Day 1, 08:10" };
    open();
    expect(shown()).toEqual(["Ada Varn · Day 1, 08:10", null]);
    const line = editor.view.dom.querySelector(".ghw-pinned")!;
    expect(line.getAttribute("contenteditable")).toBe("false");
    // First in its scene, before the first paragraph.
    expect(line.nextElementSibling?.textContent).toBe("First scene opens.");
    expect(serializeChapter(editor.state.doc)).toEqual([
      { id: "one.md", markdown: ONE },
      { id: "two.md", markdown: TWO },
    ]);
    expect(editor.state.doc.textContent).not.toContain("Ada Varn");
  });

  it("follows the details as they change, and stays with its scene as the text is edited", () => {
    lines = {};
    open();
    expect(shown()).toEqual([null, null]);
    lines = { "one.md": "Ada Varn", "two.md": "Ben Varn" };
    refreshPinnedLines(editor);
    expect(shown()).toEqual(["Ada Varn", "Ben Varn"]);
    // Typing at the start of the second scene: the line stays first.
    const start = editor.state.doc.child(0).nodeSize + 2;
    editor.chain().setTextSelection(start).insertContent("Later. ").run();
    expect(shown()).toEqual(["Ada Varn", "Ben Varn"]);
    expect(editor.view.dom.querySelectorAll(".ghw-scene")[1]!.querySelector(":scope > .ghw-pinned")!.nextElementSibling?.textContent).toBe("Later. Second scene, by the toll house.");
    lines = { "two.md": "Ben Varn · Day 1, 17:40" };
    refreshPinnedLines(editor);
    expect(shown()).toEqual([null, "Ben Varn · Day 1, 17:40"]);
  });
});
