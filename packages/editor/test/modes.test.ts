// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { centreCaret, loadMarkdown, proseContent, TYPEWRITER_LINE, writingModeCommands, writingModes, WritingModesExtension } from "../src/index.ts";

let editor: Editor;

beforeEach(() => {
  localStorage.clear();
  writingModes.setState({ focus: false, dim: false, typewriter: false, pinCount: false });
  editor = new Editor({ element: document.createElement("div"), extensions: [...proseContent, WritingModesExtension] });
  loadMarkdown(editor, "First paragraph.\n\nSecond paragraph.\n\n> Quoted.\n");
});
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

function press(combo: string): boolean {
  const parts = combo.split("-");
  const base = parts.pop()!;
  const shift = parts.includes("Shift");
  const event = new KeyboardEvent("keydown", { key: shift ? base.toUpperCase() : base, ctrlKey: parts.includes("Mod"), shiftKey: shift, bubbles: true });
  Object.defineProperty(event, "keyCode", { value: base.toUpperCase().charCodeAt(0) });
  return !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event));
}

const classes = () => [...editor.view.dom.classList].filter((c) => c.startsWith("ghw-")).sort();
const current = () => [...editor.view.dom.querySelectorAll(".ghw-current")].map((el) => el.textContent);

describe("writing modes", () => {
  test("Mod-Shift-F and Mod-Shift-L toggle focus mode and typewriter scrolling", () => {
    expect(press("Mod-Shift-f")).toBe(true);
    expect(writingModes.getState().focus).toBe(true);
    expect(press("Mod-Shift-l")).toBe(true);
    expect(writingModes.getState().typewriter).toBe(true);
    press("Mod-Shift-f");
    expect(writingModes.getState()).toMatchObject({ focus: false, typewriter: true });
  });

  test("the editor's classes follow the modes", () => {
    expect(classes()).toEqual([]);
    writingModes.getState().toggle("focus");
    expect(classes()).toEqual(["ghw-focus"]);
    writingModes.getState().set({ dim: true, typewriter: true });
    expect(classes()).toEqual(["ghw-dim", "ghw-focus", "ghw-typewriter"]);
  });

  test("dimming marks only the paragraph holding the caret, and follows it", () => {
    editor.commands.setTextSelection(3);
    writingModes.getState().set({ focus: true });
    expect(current()).toEqual([]);
    writingModes.getState().set({ dim: true });
    expect(current()).toEqual(["First paragraph."]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    expect(current()).toEqual(["Quoted."]);
    writingModes.getState().set({ focus: false });
    expect(current()).toEqual([]);
  });

  test("toggling a mode keeps the selection", () => {
    editor.commands.setTextSelection({ from: 3, to: 8 });
    const before = editor.state.selection.toJSON();
    for (const command of writingModeCommands) {
      command.run(editor);
      command.run(editor);
    }
    press("Mod-Shift-f");
    expect(editor.state.selection.toJSON()).toEqual(before);
  });

  test("modes persist to local storage, without the actions", () => {
    writingModes.getState().set({ focus: true, typewriter: true });
    expect(JSON.parse(localStorage.getItem("gh-writer:writing-modes")!).state).toEqual({ focus: true, dim: false, typewriter: true, pinCount: false });
  });

  test("commands describe themselves for the palette", () => {
    expect(writingModeCommands.map((c) => [c.id, c.keys ?? null])).toEqual([
      ["editor.toggleFocusMode", "Mod-Shift-f"],
      ["editor.toggleTypewriterScrolling", "Mod-Shift-l"],
      ["editor.toggleFocusDimming", null],
      ["editor.togglePinnedWordCount", null],
    ]);
    writingModeCommands[1]!.run();
    expect(writingModeCommands[1]!.isActive!()).toBe(true);
  });
});

describe("typewriter scrolling", () => {
  test("scrolls so the caret line sits at the typewriter height", () => {
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top: 900, bottom: 920, left: 0, right: 0 });
    centreCaret(editor.view);
    expect(scrollBy).toHaveBeenCalledWith({ top: 910 - window.innerHeight * TYPEWRITER_LINE, behavior: "instant" });
  });

  test("replaces ProseMirror's scroll-into-view while on", () => {
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top: 50, bottom: 70, left: 0, right: 0 });
    const ask = () => editor.view.someProp("handleScrollToSelection", (f) => f(editor.view));
    expect(ask()).toBeFalsy();
    writingModes.getState().set({ typewriter: true });
    expect(ask()).toBe(true);
    expect(scrollBy).toHaveBeenCalled();
  });

  test("moving by keyboard recentres; moving after a click doesn't", () => {
    writingModes.getState().set({ typewriter: true });
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top: 600, bottom: 620, left: 0, right: 0 });
    press("ArrowDown");
    editor.commands.setTextSelection(8);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    editor.view.dom.dispatchEvent(new Event("pointerdown"));
    editor.commands.setTextSelection(12);
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });

  test("typing recentres; a selection change without a key press doesn't", () => {
    writingModes.getState().set({ typewriter: true });
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ top: 600, bottom: 620, left: 0, right: 0 });
    editor.commands.setTextSelection(5);
    expect(scrollBy).not.toHaveBeenCalled();
    editor.view.dispatch(editor.state.tr.insertText("x"));
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });
});
