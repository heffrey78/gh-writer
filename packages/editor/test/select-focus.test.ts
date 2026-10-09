// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, expect, test } from "vitest";
import { chapterContent, loadChapter, SelectFocusExtension } from "../src/index.ts";

let editor: Editor;
let outside: HTMLElement;
afterEach(() => {
  editor?.destroy();
  document.body.replaceChildren();
});

function open(): Editor {
  // The page around the editor: focusable, as the app's <main> is.
  outside = Object.assign(document.createElement("main"), { tabIndex: -1 });
  const element = document.createElement("div");
  document.body.append(outside, element);
  editor = new Editor({ element, extensions: [...chapterContent, SelectFocusExtension] });
  loadChapter(editor, [{ id: "sc_1", markdown: "Write the first line here.\n" }]);
  return editor;
}

/** What Firefox leaves after a drag from beside the text: the text selected, the page focused. */
function selectFromOutside(start: number, end: number) {
  outside.focus();
  const text = editor.view.dom.querySelector("p")!.firstChild!;
  getSelection()!.setBaseAndExtent(text, start, text, end);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

test("a selection made in the unfocused editor focuses it, keeping the selection", () => {
  open();
  selectFromOutside(26, 0);
  expect(editor.view.hasFocus()).toBe(true);
  const { anchor, head } = editor.state.selection;
  expect(editor.state.doc.textBetween(Math.min(anchor, head), Math.max(anchor, head))).toBe("Write the first line here.");
  expect(head).toBeLessThan(anchor);
});

test("a click elsewhere, or a selection outside the editor, leaves the focus alone", () => {
  open();
  selectFromOutside(3, 3);
  expect(editor.view.hasFocus()).toBe(false);

  outside.textContent = "Chapter One";
  getSelection()!.selectAllChildren(outside);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(editor.view.hasFocus()).toBe(false);
});
