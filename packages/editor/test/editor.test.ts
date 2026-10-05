// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { afterEach, describe, expect, test } from "vitest";
import { getMarkdown, loadMarkdown, proseContent } from "../src/index.ts";

let editor: Editor;
afterEach(() => editor?.destroy());

function open(markdown: string): Editor {
  editor = new Editor({ element: document.createElement("div"), extensions: [...proseContent, UndoRedo] });
  loadMarkdown(editor, markdown);
  return editor;
}

/** Type text one character at a time, giving input rules the chance a real keyboard would. */
function type(text: string): void {
  for (const ch of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
  }
}

/** Press a key; `Mod` is Ctrl outside macOS (jsdom). */
function press(combo: string): boolean {
  const parts = combo.split("-");
  const shift = parts.includes("Shift");
  const base = parts.pop()!;
  // A browser reports the shifted character, e.g. "B" for Shift+b.
  const key = shift && base.length === 1 ? base.toUpperCase() : base;
  const event = new KeyboardEvent("keydown", { key, ctrlKey: parts.includes("Mod"), shiftKey: shift, bubbles: true });
  // ProseMirror falls back to keyCode for shifted letters; jsdom doesn't set it.
  if (base.length === 1) Object.defineProperty(event, "keyCode", { value: base.toUpperCase().charCodeAt(0) });
  return !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
}

/** Document position of `text`, or of its end with `end`. */
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

const select = (text: string) => editor.commands.setTextSelection({ from: at(text), to: at(text, true) });
const cursor = (pos: number) => editor.commands.setTextSelection(pos);

describe("loading", () => {
  test("a loaded scene saves unchanged", () => {
    const md = "She said _no_.\n\n> A letter.\n\n***\n\n| raw |\n|---|\n";
    expect(getMarkdown(open(md))).toBe(md);
  });

  test("loading starts a fresh undo history", () => {
    open("One.\n");
    type("x");
    loadMarkdown(editor, "Two.\n");
    expect(editor.can().undo()).toBe(false);
  });
});

describe("shortcuts", () => {
  test("Mod-i and Mod-b toggle emphasis on the selection", () => {
    open("The clock ran fast.\n");
    select("clock");
    expect(press("Mod-i")).toBe(true);
    expect(getMarkdown(editor)).toBe("The *clock* ran fast.\n");
    press("Mod-b");
    expect(getMarkdown(editor)).toBe("The ***clock*** ran fast.\n");
    press("Mod-i");
    press("Mod-b");
    expect(getMarkdown(editor)).toBe("The clock ran fast.\n");
  });

  test("shortcuts work with caps lock on", () => {
    open("The clock ran fast.\n");
    select("clock");
    press("Mod-I");
    expect(getMarkdown(editor)).toBe("The *clock* ran fast.\n");
  });

  test("Mod-Shift-b toggles a block quote", () => {
    open("A letter.\n\nAfter.\n");
    cursor(at("letter"));
    press("Mod-Shift-b");
    expect(getMarkdown(editor)).toBe("> A letter.\n\nAfter.\n");
    press("Mod-Shift-b");
    expect(getMarkdown(editor)).toBe("A letter.\n\nAfter.\n");
  });

  test("Mod-Enter inserts a section break", () => {
    open("Before.\n");
    cursor(at("Before.", true));
    press("Mod-Enter");
    type("After.");
    expect(getMarkdown(editor)).toBe("Before.\n\n***\n\nAfter.\n");
  });

  test("Shift-Enter inserts a line break", () => {
    open("Roses are red,\n");
    cursor(at("red,", true));
    press("Shift-Enter");
    type("violets are blue.");
    expect(getMarkdown(editor)).toBe("Roses are red,\\\nviolets are blue.\n");
  });

  test("Enter inside raw Markdown inserts a newline", () => {
    open("- one\n");
    cursor(at("one", true));
    press("Enter");
    type("- two");
    expect(getMarkdown(editor)).toBe("- one\n- two\n");
  });

  test("undo returns to the file as it was", () => {
    const md = "She said _no_, and __meant__ it.\n\nNext.\n";
    open(md);
    select("meant");
    press("Mod-i");
    cursor(at("Next.", true));
    type(" More.");
    expect(getMarkdown(editor)).not.toBe(md);
    while (editor.can().undo()) editor.commands.undo();
    expect(getMarkdown(editor)).toBe(md);
  });
});

describe("input rules", () => {
  test.each([
    ["*word* ", "*word*\n"],
    ["_word_ ", "*word*\n"],
    ["**word** ", "**word**\n"],
    ["__word__ ", "**word**\n"],
  ])("%j becomes formatting", (input, out) => {
    open("");
    type(input);
    expect(getMarkdown(editor)).toBe(out);
    expect(editor.state.doc.textContent).toBe("word ");
  });

  test("new emphasis follows the scene's markers", () => {
    open("She said _no_.\n");
    cursor(editor.state.doc.content.size - 1);
    press("Enter");
    type("*yes* ");
    expect(getMarkdown(editor)).toBe("She said _no_.\n\n_yes_\n");
  });

  test("> at the start of a paragraph starts a quote", () => {
    open("");
    type("> A letter.");
    expect(getMarkdown(editor)).toBe("> A letter.\n");
  });

  test.each(["***", "---", "___"])("%s and a space make a section break", (rule) => {
    open("Before.\n");
    cursor(at("Before.", true));
    press("Enter");
    type(`${rule} After.`);
    expect(getMarkdown(editor)).toBe("Before.\n\n***\n\nAfter.\n");
  });

  test("an asterisk inside a word stays literal", () => {
    open("");
    type("5*3 is 15 ");
    expect(getMarkdown(editor)).toBe("5\\*3 is 15\n");
  });
});

describe("mentions", () => {
  const md = "Then [Ada](#char_7f3k2q) left.\n";

  test("typing next to a mention leaves it whole", () => {
    open(md);
    const after = at(" left");
    cursor(after);
    type(" quietly");
    cursor(after - 1);
    type("!");
    // `!` before a link is escaped so it can't read as an image.
    expect(getMarkdown(editor)).toBe("Then \\![Ada](#char_7f3k2q) quietly left.\n");
  });

  test("renders as styled text without Markdown syntax", () => {
    open(md);
    const span = editor.view.dom.querySelector("span[data-mention]")!;
    expect(span.textContent).toBe("Ada");
    expect(span.getAttribute("data-mention")).toBe("char_7f3k2q");
    expect(editor.view.dom.textContent).toBe("Then Ada left.");
  });
});

describe("pasting", () => {
  test("HTML from elsewhere keeps emphasis and drops what prose doesn't use", () => {
    open("");
    editor.commands.insertContent('<p>A <i>very</i> <b style="color:red">bold</b> <span class="x">claim</span>.</p><ul><li>item</li></ul>');
    expect(getMarkdown(editor)).toBe("A *very* **bold** claim.\n\nitem\n");
  });
});
