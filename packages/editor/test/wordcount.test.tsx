// @vitest-environment jsdom
import "./dom.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countWords } from "@gh-writer/core";
import { Editor } from "@tiptap/core";
import { Transform } from "@tiptap/pm/transform";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  chapterContent,
  countNode,
  documentCounts,
  liveCounts,
  loadChapter,
  parseChapter,
  parseProse,
  proseContent,
  proseSchema as schema,
  serializeProse,
  sessionWords,
  splitSceneFile,
  WordCountExtension,
  writingModes,
  writingSession,
} from "../src/index.ts";
import { ChapterEditor, SceneEditor, WordCount } from "../src/react.tsx";

const root = join(import.meta.dirname, "../../..");
const bodies = readdirSync(join(root, "examples/sample-novel/manuscript"), { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".md"))
  .map((f) => splitSceneFile(readFileSync(join(root, "examples/sample-novel/manuscript", f), "utf8")).body);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  writingSession.setState({ startedAt: Date.now(), goal: null, scenes: {} });
  writingModes.setState({ focus: false, dim: false, typewriter: false, pinCount: false, spellcheck: true, linkSuggestions: false });
  liveCounts.setState({ view: null, sceneId: null, scene: 0, chapter: 0 });
});
afterEach(cleanup);

describe("counting documents", () => {
  test.each<[string, string]>([
    ...bodies.map((b, i): [string, string] => [`sample scene ${i + 1}`, b]),
    ["mentions and emphasis", "[Ada](#char_7f3k2q) met *[Ben Varn](#char_b3n0vs)* at the well-known bridge.\n"],
    ["quotes, breaks and rules", "> Dear Ben,\\\n> come home.\n\n***\n\nRoses are red,  \nviolets blue.\n"],
    ["raw Markdown", "Run `make` and ~~cut~~ it.\n\n| Day | Event |\n|---|---|\n| 1 | Arrival |\n\n- one\n- two\n"],
    ["escapes and entities", "5 \\* 3 &amp; caf&eacute; &mdash; done\n"],
  ])("%s counts as core counts its Markdown", (_name, body) => {
    expect(countNode(parseProse(body))).toBe(countWords(body));
  });

  test("a chapter counts per scene", () => {
    const chapter = parseChapter(
      [
        { id: "a", markdown: "One two three.\n" },
        { id: "b", markdown: "Four five.\n" },
      ],
      new Editor({ extensions: chapterContent }).schema,
    );
    const { scenes, total } = documentCounts(chapter, "unused");
    expect([...scenes]).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(total).toBe(5);
  });

  test("the cached count after random edits equals a full recount", () => {
    const words = fc.constantFrom("word", " ", "well-known", "[Ada](#x)", "don't", "—", "*em*", "\n\n", "x");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.nat({ max: 12 }), fc.array(words, { minLength: 1, maxLength: 4 })), { maxLength: 25 }),
        (edits) => {
          const tr = new Transform(parseProse(bodies[0]!));
          countNode(tr.doc); // warm the cache, as the editor does
          for (const [insert, at, length, text] of edits) {
            const textPositions: number[] = [];
            tr.doc.descendants((node, pos) => void (node.isTextblock && textPositions.push(pos + 1)));
            const start = textPositions[at % textPositions.length]!;
            const block = tr.doc.resolve(start).parent;
            const from = start + (at % (block.content.size + 1));
            if (insert) tr.insert(from, schema.text(text.join("")));
            else tr.delete(from, Math.min(from + length, start + block.content.size));
            expect(countNode(tr.doc)).toBe(countWords(serializeProse(tr.doc)));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("an edit recounts only the edited paragraph", () => {
    const doc = parseProse(bodies[0]!);
    countNode(doc);
    const tr = new Transform(doc).insert(5, schema.text(" more words"));
    const untouched: boolean[] = [];
    tr.doc.forEach((block, _, i) => untouched.push(block === doc.child(i)));
    expect(untouched.filter((u) => !u)).toHaveLength(1);
  });
});

describe("writing session", () => {
  test("the first count of a scene is its baseline; session words are the net change", () => {
    const s = writingSession.getState();
    s.record("a", 100);
    s.record("b", 50);
    s.record("a", 130);
    s.record("b", 40);
    expect(sessionWords(writingSession.getState())).toBe(20);
    writingSession.getState().restart();
    expect(sessionWords(writingSession.getState())).toBe(0);
    writingSession.getState().record("a", 135);
    expect(sessionWords(writingSession.getState())).toBe(5);
  });

  test("the session survives a reload in sessionStorage; the goal is remembered in localStorage", () => {
    writingSession.getState().record("a", 10);
    writingSession.getState().record("a", 25);
    writingSession.getState().setGoal(500);
    const stored = JSON.parse(sessionStorage.getItem("gh-writer:writing-session")!).state;
    expect(stored.scenes).toEqual({ a: { baseline: 10, current: 25 } });
    expect(stored.goal).toBe(500);
    expect(localStorage.getItem("gh-writer:session-goal")).toBe("500");
    writingSession.getState().setGoal(null);
    expect(localStorage.getItem("gh-writer:session-goal")).toBeNull();
  });
});

describe("live counts", () => {
  const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

  test("an editor publishes counts and records its scene for the session", async () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: [...proseContent, WordCountExtension.configure({ sceneId: "sc_1" })] });
    editor.commands.insertContent("One two three.");
    await frame();
    expect(liveCounts.getState()).toMatchObject({ view: "scene", sceneId: "sc_1", scene: 3 });
    editor.commands.insertContent(" Four.");
    await frame();
    expect(writingSession.getState().scenes.sc_1).toEqual({ baseline: 0, current: 4 });
    editor.destroy();
  });

  test("in a chapter, the scene count follows the caret", async () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: [...chapterContent, WordCountExtension] });
    loadChapter(editor, [
      { id: "a", markdown: "One two three.\n" },
      { id: "b", markdown: "Four five.\n" },
    ]);
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    await frame();
    expect(liveCounts.getState()).toMatchObject({ view: "chapter", sceneId: "b", scene: 2, chapter: 5 });
    editor.commands.setTextSelection(2);
    await frame();
    expect(liveCounts.getState()).toMatchObject({ sceneId: "a", scene: 3 });
    expect(writingSession.getState().scenes).toEqual({ a: { baseline: 3, current: 3 }, b: { baseline: 2, current: 2 } });
    editor.destroy();
  });
});

describe("WordCount", () => {
  test("shows scene, chapter and session counts", async () => {
    let editor: Editor | undefined;
    render(
      <>
        <ChapterEditor scenes={[{ id: "a", markdown: "One two three.\n" }, { id: "b", markdown: "Four five.\n" }]} onReady={(e) => (editor = e)} />
        <WordCount />
      </>,
    );
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    const bar = screen.getByRole("group", { name: "Word count" });
    expect(bar.textContent).toContain("Scene 3");
    expect(bar.textContent).toContain("Chapter 5");
    expect(bar.textContent).toContain("Session 0");
    act(() => void editor!.chain().setTextSelection(4).insertContent("and more ").run());
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(bar.textContent).toContain("Scene 5");
    expect(bar.textContent).toContain("Chapter 7");
    expect(bar.textContent).toContain("Session +2");
  });

  test("a single-scene editor shows the chapter count the app gives it", async () => {
    render(
      <>
        <SceneEditor sceneId="a" markdown={"One two.\n"} />
        <WordCount chapterWords={1234} />
      </>,
    );
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(screen.getByRole("group", { name: "Word count" }).textContent).toMatch(/Scene 2.*Chapter 1,234/);
  });

  test("sets a goal, shows progress and quietly notes when it's reached", () => {
    writingSession.getState().record("a", 100);
    render(<WordCount />);
    fireEvent.click(screen.getByRole("button", { name: "Set goal" }));
    fireEvent.change(screen.getByLabelText("Session goal"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(writingSession.getState().goal).toBe(50);
    const progress = screen.getByRole("progressbar", { name: "Session goal progress" });
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => writingSession.getState().record("a", 130));
    expect(progress.getAttribute("value")).toBe("30");
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => writingSession.getState().record("a", 160));
    expect(screen.getByRole("status").textContent).toBe("Goal reached");
  });

  test("hides in focus mode unless pinned", () => {
    render(<WordCount />);
    const bar = screen.getByRole("group", { name: "Word count", hidden: true });
    expect(bar.hidden).toBe(false);
    act(() => writingModes.getState().set({ focus: true }));
    expect(bar.hidden).toBe(true);
    act(() => writingModes.getState().set({ pinCount: true }));
    expect(bar.hidden).toBe(false);
  });
});

vi.setConfig({ testTimeout: 20_000 });
