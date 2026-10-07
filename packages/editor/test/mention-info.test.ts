// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, expect, test, vi } from "vitest";
import { chapterContent, loadChapter, loadMarkdown, mentionAtCaret, MentionInfoExtension, proseContent, type MentionTarget } from "../src/index.ts";

let editor: Editor;
afterEach(() => editor?.destroy());

const altEnter = () => {
  const event = new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true });
  return editor.view.someProp("handleKeyDown", (f) => f(editor.view, event)) ?? false;
};

test("finds the mention beside the caret, and Alt+Enter reports it", () => {
  const onShow = vi.fn<(t: MentionTarget) => void>();
  editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...proseContent, MentionInfoExtension.configure({ onShow })] });
  loadMarkdown(editor, "Then [Ada](#char_7f3k2q) waved.\n");
  editor.commands.setTextSelection(6); // before the mention
  expect(mentionAtCaret(editor)).toEqual({ id: "char_7f3k2q", pos: 6 });
  editor.commands.setTextSelection(7); // after it
  expect(mentionAtCaret(editor)).toEqual({ id: "char_7f3k2q", pos: 6 });
  expect(altEnter()).toBe(true);
  expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: "char_7f3k2q", pos: 6, sceneId: undefined, via: "keyboard" }));
  editor.commands.setTextSelection(3);
  expect(mentionAtCaret(editor)).toBeUndefined();
  expect(altEnter()).toBe(false);
});

test("in a chapter, says which scene holds the mention", () => {
  const onShow = vi.fn<(t: MentionTarget) => void>();
  editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...chapterContent, MentionInfoExtension.configure({ onShow })] });
  loadChapter(editor, [
    { id: "a.md", title: "A", markdown: "Nothing here.\n" },
    { id: "b.md", title: "B", markdown: "[Ben](#char_b3n0vs) came.\n" },
  ]);
  let at = -1;
  editor.state.doc.descendants((n, pos) => void (n.type.name === "mention" && (at = pos)));
  editor.commands.setTextSelection(at + 1);
  altEnter();
  expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ id: "char_b3n0vs", sceneId: "b.md" }));
});
