// @vitest-environment jsdom
import "./dom.ts";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { chapterContent, IssueMarksExtension, issueMarksKey, loadChapter, refreshIssueMarks, sceneText, sceneTextAt, type AnchoredIssue } from "../src/index.ts";

const ONE = "First scene opens.\n\nShe stood with her bag at her feet and counted them twice, the way you count stitches in a wound.\n";
const TWO = "Second scene, where [Ben](#char_b3n0vs) waits by the toll house.\n\nThe clock ran four minutes fast.\n";
const QUOTE = "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.";

let editor: Editor;
let issues: AnchoredIssue[];
let opened: number[][];
afterEach(() => editor?.destroy());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(list: AnchoredIssue[]) {
  issues = list;
  opened = [];
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...chapterContent, IssueMarksExtension.configure({ issues: () => issues, onOpen: (n) => opened.push(n) })],
  });
  loadChapter(editor, [
    { id: "one.md", markdown: ONE },
    { id: "two.md", markdown: TWO },
  ]);
  refreshIssueMarks(editor);
  await wait(10);
}

const highlighted = () =>
  (issueMarksKey.getState(editor.state)?.set.find() ?? []).filter((d) => d.from < d.to).map((d) => [(d.spec as { issue: number }).issue, editor.state.doc.textBetween(d.from, d.to, "", (n) => String(n.attrs.label ?? ""))]);
const markers = () => [...editor.view.dom.querySelectorAll<HTMLButtonElement>(".ghw-issue-marker")];

describe("issue marks", () => {
  it("reads a scene as raising an issue quotes it, knowing where each character is", () => {
    const e = new Editor({ element: document.createElement("div"), extensions: chapterContent });
    loadChapter(e, [{ id: "two.md", markdown: TWO }]);
    const scene = e.state.doc.child(0);
    const { text, from, to } = sceneTextAt(scene, 1);
    expect(text).toBe("Second scene, where Ben waits by the toll house.\n\nThe clock ran four minutes fast.");
    const ben = text.indexOf("Ben");
    // A mention's letters all point at the mention.
    expect(e.state.doc.nodeAt(from[ben]!)?.type.name).toBe("mention");
    expect(to[ben + 2]! - from[ben]!).toBe(1);
    expect(e.state.doc.textBetween(from[text.indexOf("clock")]!, to[text.indexOf("clock") + 4]!)).toBe("clock");
    expect(sceneText(TWO)).toBe(text);
    e.destroy();
  });

  it("highlights each open issue's passage and puts a marker beside its paragraph, a count for several", async () => {
    await open([
      { number: 3, title: "Who counted the flags?", scene: "one.md", quote: QUOTE },
      { number: 5, title: "Twice or three times?", scene: "one.md", quote: "counted them twice" },
      { number: 7, title: "Which clock?", scene: "two.md", quote: "The clock ran four minutes fast." },
      { number: 9, title: "Orphaned", scene: "two.md", quote: "Words that are nowhere in the scene at all, gone." },
      { number: 11, title: "Not in this chapter", scene: "elsewhere.md", quote: "The clock" },
    ]);
    expect(highlighted()).toEqual([
      [3, QUOTE],
      [5, "counted them twice"],
      [7, "The clock ran four minutes fast."],
    ]);
    expect(markers().map((m) => [m.textContent, m.getAttribute("aria-label")])).toEqual([
      ["2", "2 issues: #3 Who counted the flags?; #5 Twice or three times?"],
      ["1", "Issue #7: Which clock?"],
    ]);
  });

  it("follows the passage after edits, once typing pauses, and through a lightly edited passage", async () => {
    await open([{ number: 3, title: "Who counted the flags?", scene: "one.md", quote: QUOTE }]);
    editor.commands.insertContentAt(1, { type: "paragraph", content: [{ type: "text", text: "A new paragraph above." }] });
    // Mapped along at once.
    expect(highlighted()).toEqual([[3, QUOTE]]);
    const at = editor.state.doc.textContent.indexOf("counted them twice");
    expect(at).toBeGreaterThan(0);
    let pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.isText && pos < 0 && n.text!.includes("counted them twice")) pos = p + n.text!.indexOf("counted them twice");
    });
    editor.view.dispatch(editor.state.tr.insertText("the flags", pos + "counted ".length, pos + "counted them".length));
    await wait(350);
    expect(highlighted()).toEqual([[3, "She stood with her bag at her feet and counted the flags twice, the way you count stitches in a wound."]]);
    expect(markers()).toHaveLength(1);
  });

  it("opens the issues from the marker, or by the shortcut beside the passage", async () => {
    await open([
      { number: 3, title: "Who counted the flags?", scene: "one.md", quote: QUOTE },
      { number: 7, title: "Which clock?", scene: "two.md", quote: "The clock ran four minutes fast." },
    ]);
    markers()[0]!.click();
    expect(opened).toEqual([[3]]);
    let clock = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.isText && n.text!.startsWith("The clock")) clock = p + 4;
    });
    editor.commands.setTextSelection(clock);
    const press = (key: string) => editor.view.someProp("handleKeyDown", (f) => f(editor.view, new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, bubbles: true })));
    expect(press("i")).toBe(true);
    expect(opened).toEqual([[3], [7]]);
    editor.commands.setTextSelection(3);
    expect(press("i")).toBeFalsy();
  });

  it("drops a marker when its issue goes (closed), once told", async () => {
    await open([{ number: 3, title: "Who counted the flags?", scene: "one.md", quote: QUOTE }]);
    expect(markers()).toHaveLength(1);
    issues = [];
    refreshIssueMarks(editor);
    expect(markers()).toHaveLength(0);
  });
});
