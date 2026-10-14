// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chapterContent, getMarkdown, insertPicture, loadChapter, loadMarkdown, pictureAt, PicturesExtension, proseContent, serializeChapter, setPicture, type PictureCallbacks } from "../src/index.ts";

/** Pictures put in, changed and handed to the app (D10, #203). */

const MAP = { url: "/images/map.jpg", alt: "A map of Varn", caption: "The valley" };
let editor: Editor;
afterEach(() => editor?.destroy());

function open(md: string, callbacks: PictureCallbacks = {}) {
  editor = new Editor({ element: document.createElement("div"), extensions: [...proseContent, UndoRedo, PicturesExtension.configure({ callbacks: () => callbacks })] });
  loadMarkdown(editor, md);
  return editor;
}

/** The position just inside the first textblock holding `text`. */
function inText(text: string): number {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent.includes(text)) at = pos + 1;
  });
  return at;
}

describe("insertPicture", () => {
  test("goes after the block holding the caret, which moves on into the next paragraph", () => {
    open("One _here_.\n\nTwo.\n");
    insertPicture(editor, MAP, inText("One"));
    expect(getMarkdown(editor)).toBe('One _here_.\n\n![A map of Varn](/images/map.jpg "The valley")\n\nTwo.\n');
    expect(editor.state.selection.$from.parent.textContent).toBe("Two.");
  });

  test("at the end, leaves an empty paragraph to write on in, unwritten until something's typed", () => {
    open("One.\n");
    insertPicture(editor, { url: "/images/seal.png", alt: "The seal" }, inText("One"));
    expect(getMarkdown(editor)).toBe("One.\n\n![The seal](/images/seal.png)\n");
    editor.commands.insertContent("After.");
    expect(getMarkdown(editor)).toBe("One.\n\n![The seal](/images/seal.png)\n\nAfter.\n");
  });

  test("takes an empty paragraph's place, and goes after a whole list from inside one", () => {
    open("One.\n\n- a\n- b\n\nTwo.\n");
    insertPicture(editor, { url: "/images/x.jpg", alt: "X" }, inText("a"));
    expect(getMarkdown(editor)).toBe("One.\n\n- a\n- b\n\n![X](/images/x.jpg)\n\nTwo.\n");
    editor.chain().setTextSelection(inText("One") + 4).splitBlock().run();
    insertPicture(editor, { url: "/images/y.jpg", alt: "Y" });
    expect(getMarkdown(editor)).toBe("One.\n\n![Y](/images/y.jpg)\n\n- a\n- b\n\n![X](/images/x.jpg)\n\nTwo.\n");
  });

  test("between two of a chapter's scenes, goes in the scene before, adding none", () => {
    editor = new Editor({ element: document.createElement("div"), extensions: [...chapterContent, UndoRedo] });
    loadChapter(editor, [
      { id: "a", title: "A", markdown: "First.\n" },
      { id: "b", title: "B", markdown: "Second.\n" },
    ]);
    const between = editor.state.doc.firstChild!.nodeSize;
    insertPicture(editor, MAP, between);
    expect(editor.state.doc.childCount).toBe(2);
    expect(serializeChapter(editor.state.doc)).toEqual([
      { id: "a", markdown: 'First.\n\n![A map of Varn](/images/map.jpg "The valley")\n' },
      { id: "b", markdown: "Second.\n" },
    ]);
  });
});

describe("a picture in the text", () => {
  const md = "Some _emphasis_ here.\n\n![Old](/images/map.jpg 'Old caption')\n\nMore  text.\n";

  test("is read, and changed with only its own line rewritten", () => {
    open(md);
    const at = inText("Some") - 1 + editor.state.doc.firstChild!.nodeSize;
    expect(pictureAt(editor, at)).toEqual({ url: "/images/map.jpg", alt: "Old", caption: "Old caption" });
    expect(pictureAt(editor, 0)).toBeUndefined();
    setPicture(editor, at, { alt: "New", caption: "" });
    expect(getMarkdown(editor)).toBe("Some _emphasis_ here.\n\n![New](/images/map.jpg)\n\nMore  text.\n");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    // Selected, Delete takes it.
    editor.commands.deleteSelection();
    expect(getMarkdown(editor)).toBe("Some _emphasis_ here.\n\nMore  text.\n");
  });

  test("selected, Enter hands it to the app to change; elsewhere Enter is Enter", () => {
    const edit = vi.fn();
    open(md, { edit });
    const at = editor.state.doc.firstChild!.nodeSize;
    const enter = () => editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key: "Enter" })));
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)));
    expect(enter()).toBe(true);
    expect(edit).toHaveBeenCalledWith(at);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, inText("More"))));
    enter();
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
