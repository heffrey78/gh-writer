// @vitest-environment jsdom
import "./dom.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Editor } from "@tiptap/core";
import { UndoRedo } from "@tiptap/extensions";
import { afterEach, describe, expect, test } from "vitest";
import {
  chapterContent,
  compileQuery,
  expandReplacement,
  loadChapter,
  replaceAll,
  replaceInEditor,
  replaceInMarkdown,
  SearchHighlightExtension,
  searchManuscript,
  serializeChapter,
  setSearchHighlights,
  splitSceneFile,
  type Manuscript,
  type SearchQuery,
  type SearchScope,
} from "../src/index.ts";

const manuscript: Manuscript = [
  {
    id: "ch_1",
    title: "Arrival",
    scenes: [
      { id: "sc_a", title: "The Station", markdown: "She said _no_, and **meant** it. [Ada](#char_7f3k2q) nodded.\n\nThe bridge held.\n" },
      { id: "sc_b", title: "The Bridge", markdown: "No one crossed the bridge.\n\nRun `bridge` in code.\n" },
    ],
  },
  {
    id: "ch_2",
    title: "Night",
    scenes: [{ id: "sc_c", title: "Spans", markdown: "Bridges everywhere: bridge, Bridge, BRIDGE.\n" }],
  },
];

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

const search = (text: string, opts: Partial<SearchQuery> = {}, scope: SearchScope = "manuscript", sceneId?: string) =>
  searchManuscript({ manuscript, query: { text, ...opts }, scope, sceneId, editor });
const found = (r: ReturnType<typeof search>) => r.chapters.flatMap((c) => c.scenes.flatMap((s) => s.matches.map((m) => `${s.sceneId}:${m.text}`)));

describe("queries", () => {
  test("literal text is escaped; invalid regexes explain themselves", () => {
    expect((compileQuery({ text: "a.b(" }) as RegExp).test("a.b(")).toBe(true);
    expect(compileQuery({ text: "a(", regex: true })).toEqual({ error: expect.stringMatching(/a\(/) });
    expect(search("a(", { regex: true }).error).toBeTruthy();
    expect(search("").count).toBe(0);
  });

  test("case, whole word and regex options", () => {
    expect(search("bridge", {}, "scene", "sc_c").count).toBe(4);
    expect(search("bridge", { wholeWord: true }, "scene", "sc_c").count).toBe(3);
    expect(search("bridge", { caseSensitive: true }, "scene", "sc_c").count).toBe(1);
    expect(search("BRIDGE|Bridges", { regex: true, caseSensitive: true }, "scene", "sc_c").count).toBe(2);
  });
});

describe("what is searched", () => {
  test("matches run across formatting", () => {
    expect(found(search("no, and meant it"))).toEqual(["sc_a:no, and meant it"]);
  });

  test("mentions match on their label, never their ID; raw inline Markdown doesn't match", () => {
    expect(found(search("Ada nodded"))).toEqual(["sc_a:Ada nodded"]);
    expect(search("char_7f3k2q").count).toBe(0);
    expect(found(search("bridge", { wholeWord: true }, "chapter", "sc_b"))).toEqual(["sc_a:bridge", "sc_b:bridge"]);
  });

  test("results are grouped by chapter and scene in reading order, with context", () => {
    const r = search("bridge", { wholeWord: true });
    expect(r.chapters.map((c) => [c.title, c.scenes.map((s) => [s.title, s.matches.length])])).toEqual([
      ["Arrival", [["The Station", 1], ["The Bridge", 1]]],
      ["Night", [["Spans", 3]]],
    ]);
    expect(r.count).toBe(5);
    const first = r.chapters[0]!.scenes[0]!.matches[0]!;
    expect([first.before, first.text, first.after]).toEqual(["The ", "bridge", " held."]);
  });

  test("scope: the scene, its chapter or the whole manuscript", () => {
    expect(search("bridge", { wholeWord: true }, "scene", "sc_a").count).toBe(1);
    expect(search("bridge", { wholeWord: true }, "chapter", "sc_a").count).toBe(2);
    expect(search("bridge", { wholeWord: true }, "chapter", "sc_c").count).toBe(3);
  });
});

describe("replacing", () => {
  const matchesIn = (id: string, text: string, opts: Partial<SearchQuery> = {}) =>
    search(text, opts).chapters.flatMap((c) => c.scenes).find((s) => s.sceneId === id)!.matches;

  test("replacement keeps the formatting it lands in and touches no other paragraph", () => {
    const md = manuscript[0]!.scenes[0]!.markdown;
    expect(replaceInMarkdown(md, matchesIn("sc_a", "meant"), "intended", false)).toBe(md.replace("**meant**", "**intended**"));
  });

  test("regex replacements expand groups", () => {
    const md = manuscript[1]!.scenes[0]!.markdown;
    const matches = matchesIn("sc_c", "(\\w+), (bridge)", { regex: true });
    expect(replaceInMarkdown(md, matches, "$2 and $1 ($$)", true)).toBe("Bridges everywhere: Bridge and bridge ($), BRIDGE.\n");
    expect(expandReplacement("$<w>!", { ...matches[0]!, named: { w: "x" } }, true)).toBe("x!");
    expect(expandReplacement("$1", matches[0]!, false)).toBe("$1");
  });

  test("a whole mention label renames the mention; part of one can't be replaced", () => {
    const md = manuscript[0]!.scenes[0]!.markdown;
    expect(replaceInMarkdown(md, matchesIn("sc_a", "Ada"), "Ava", false)).toBe(md.replace("[Ada]", "[Ava]"));
    const partial = matchesIn("sc_a", "Ad");
    expect(partial.map((m) => m.replaceable)).toEqual([false]);
    expect(replaceInMarkdown(md, partial, "X", false)).toBe(md);
  });

  test("replace all changes only scenes with matches", () => {
    const results = search("bridge", { wholeWord: true, caseSensitive: true });
    const r = replaceAll(results, manuscript, "span", false);
    expect(r.changed).toEqual([
      { id: "sc_a", markdown: "She said _no_, and **meant** it. [Ada](#char_7f3k2q) nodded.\n\nThe span held.\n" },
      { id: "sc_b", markdown: "No one crossed the span.\n\nRun `bridge` in code.\n" },
      { id: "sc_c", markdown: "Bridges everywhere: span, Bridge, BRIDGE.\n" },
    ]);
    expect(r.previous.map((p) => p.markdown)).toEqual(manuscript.flatMap((c) => c.scenes.map((s) => s.markdown)));
    expect(r.replaced).toBe(3);
  });
});

describe("with an open editor", () => {
  function open() {
    editor = new Editor({ element: document.createElement("div"), extensions: [...chapterContent, UndoRedo, SearchHighlightExtension] });
    loadChapter(editor, manuscript[0]!.scenes);
    return editor;
  }

  test("open scenes are searched live, in the editor's positions", () => {
    open();
    editor!.commands.insertContentAt(editor!.state.doc.content.size - 2, " The bridge again.");
    const r = search("bridge", { wholeWord: true });
    const live = r.chapters[0]!.scenes;
    expect(live.map((s) => [s.sceneId, s.live, s.matches.length])).toEqual([
      ["sc_a", true, 1],
      ["sc_b", true, 2],
    ]);
    const m = live[1]!.matches[1]!;
    expect(editor!.state.doc.textBetween(m.from, m.to)).toBe("bridge");
    expect(r.chapters[1]!.scenes[0]!.live).toBe(false);
  });

  test("the scene scope follows the caret", () => {
    open();
    editor!.commands.setTextSelection(editor!.state.doc.content.size - 3);
    expect(search("bridge", { wholeWord: true }, "scene").chapters[0]!.scenes.map((s) => s.sceneId)).toEqual(["sc_b"]);
  });

  test("replace all is one undo step in the editor, and new Markdown for closed scenes", () => {
    open();
    const before = serializeChapter(editor!.state.doc);
    const r = replaceAll(search("bridge", { wholeWord: true }), manuscript, "span", false, editor);
    expect(r.editorChanged).toBe(true);
    expect(r.changed.map((c) => c.id)).toEqual(["sc_c"]);
    expect(serializeChapter(editor!.state.doc).map((s) => s.markdown)).toEqual([
      "She said _no_, and **meant** it. [Ada](#char_7f3k2q) nodded.\n\nThe span held.\n",
      "No one crossed the span.\n\nRun `bridge` in code.\n",
    ]);
    editor!.commands.undo();
    expect(serializeChapter(editor!.state.doc)).toEqual(before);
  });

  test("replacing one match leaves the caret after it", () => {
    open();
    const m = search("meant").chapters[0]!.scenes[0]!.matches[0]!;
    replaceInEditor(editor!, m, "intended", false);
    expect(serializeChapter(editor!.state.doc)[0]!.markdown).toContain("**intended**");
    expect(editor!.state.selection.from).toBe(m.from + "intended".length);
  });

  test("matches are highlighted, the current one distinctly", () => {
    open();
    const matches = search("bridge", { wholeWord: true }).chapters[0]!.scenes.flatMap((s) => s.matches);
    setSearchHighlights(editor!, matches, matches[1]);
    expect([...editor!.view.dom.querySelectorAll(".ghw-match")].map((el) => el.textContent)).toEqual(["bridge", "bridge"]);
    expect(editor!.view.dom.querySelectorAll(".ghw-match-current")).toHaveLength(1);
    setSearchHighlights(editor!, []);
    expect(editor!.view.dom.querySelectorAll(".ghw-match")).toHaveLength(0);
  });
});

test("replace all over the sample novel changes only the lines with matches", () => {
  const root = join(import.meta.dirname, "../../../examples/sample-novel/manuscript");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).sort();
  const novel: Manuscript = [...new Set(files.map((f) => dirname(f)))].map((dir) => ({
    id: dir,
    title: dir,
    scenes: files.filter((f) => dirname(f) === dir).map((f) => ({ id: f, markdown: splitSceneFile(readFileSync(join(root, f), "utf8")).body })),
  }));
  const results = searchManuscript({ manuscript: novel, query: { text: "Ben", wholeWord: true, caseSensitive: true }, scope: "manuscript" });
  const r = replaceAll(results, novel, "Benedict", false);
  expect(r.changed.map((c) => c.id)).toEqual(results.chapters.flatMap((c) => c.scenes.map((s) => s.sceneId)));
  expect(r.changed).toHaveLength(5);
  for (const { id, markdown } of r.changed) {
    const before = novel.flatMap((c) => c.scenes).find((s) => s.id === id)!.markdown.split("\n");
    const after = markdown.split("\n");
    expect(after).toHaveLength(before.length);
    after.forEach((line, i) => expect(line, `${id}:${i + 1}`).toBe(/\bBen\b/.test(before[i]!) ? before[i]!.replace(/\bBen\b/g, "Benedict") : before[i]));
  }
});
