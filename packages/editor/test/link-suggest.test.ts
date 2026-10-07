// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getMarkdown, linkNameAtCaret, linkSuggestKey, LinkSuggestExtension, loadMarkdown, proseContent, writingModes, type MentionEntity } from "../src/index.ts";

const entities: MentionEntity[] = [
  { id: "char_7f3k2q", name: "Ada Varn", aliases: ["Ada"], type: "Character" },
  { id: "char_b3n0vs", name: "Ben Varn", aliases: ["Ben"], type: "Character" },
  { id: "loc_br1dg3", name: "The Varn Bridge", aliases: ["the bridge"], type: "Location" },
];

let editor: Editor;
beforeEach(() => writingModes.setState({ linkSuggestions: true }));
afterEach(() => {
  editor?.destroy();
  writingModes.setState({ linkSuggestions: false });
});

function open(markdown: string) {
  editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...proseContent, LinkSuggestExtension.configure({ entities: () => entities })] });
  loadMarkdown(editor, markdown);
  return editor;
}
const suggested = () => (linkSuggestKey.getState(editor.state)?.find() ?? []).map((d) => editor.state.doc.textBetween(d.from, d.to));

test("underlines whole names and aliases written as plain text, longest first, never mentions or links", () => {
  open("Ada Varn met Ben on the bridge. Adam and BEN didn't. [Ada](#char_7f3k2q) and [Ben](https://x.example) waved, and *Ada* too.\n");
  expect(suggested()).toEqual(["Ada Varn", "Ben", "the bridge", "Ada"]);
  expect(editor.view.dom.querySelectorAll(".ghw-unlinked")).toHaveLength(4);
});

test("off by default, and turning it off clears the underlines; nothing changes without the author", () => {
  open("Ada waved.\n");
  expect(suggested()).toEqual(["Ada"]);
  writingModes.setState({ linkSuggestions: false });
  expect(suggested()).toEqual([]);
  expect(getMarkdown(editor)).toBe("Ada waved.\n");
});

test("linking the name at the caret makes a mention showing the words as written", () => {
  open("Then the bridge held, and *Ben* laughed.\n");
  editor.commands.setTextSelection(8); // inside "the bridge"
  expect(linkNameAtCaret(editor)).toBe(true);
  editor.commands.setTextSelection(editor.state.doc.content.size - 10); // inside "Ben"
  expect(linkNameAtCaret(editor)).toBe(true);
  expect(getMarkdown(editor)).toBe("Then [the bridge](#loc_br1dg3) held, and *[Ben](#char_b3n0vs)* laughed.\n");
  editor.commands.setTextSelection(2);
  expect(linkNameAtCaret(editor)).toBe(false);
});

test("Alt+Enter links the name at the caret, beside the mention card's shortcut", async () => {
  const { MentionInfoExtension } = await import("../src/index.ts");
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...proseContent, LinkSuggestExtension.configure({ entities: () => entities }), MentionInfoExtension],
  });
  loadMarkdown(editor, "Then the bridge held.\n");
  editor.commands.setTextSelection(8);
  const event = new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true });
  expect(editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))).toBe(true);
  expect(getMarkdown(editor)).toBe("Then [the bridge](#loc_br1dg3) held.\n");
});
