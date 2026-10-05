// @vitest-environment jsdom
import "./dom.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import { loadNovel } from "@gh-writer/core";
import { knownWords } from "@gh-writer/core/dictionary";
import { nodeSource } from "@gh-writer/core/node";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  closeSpellingMenu,
  createLocalSpellService,
  loadMarkdown,
  openSpellingMenu,
  proseContent,
  SpellCheckExtension,
  SpellEngine,
  writingModes,
  type SpellDictionary,
  type SpellService,
} from "../src/index.ts";

const dir = join(import.meta.dirname, "../../../node_modules/dictionary-en");
let dictionary: SpellDictionary;
beforeAll(() => {
  dictionary = { aff: readFileSync(join(dir, "index.aff"), "utf8"), dic: readFileSync(join(dir, "index.dic"), "utf8") };
});

describe("SpellEngine", () => {
  test("flags misspellings and accepts known words, possessives and curly apostrophes", () => {
    const engine = new SpellEngine(dictionary, ["Varn", "steamline"]);
    const text = "Mirela’s train reached Varn's statoin; the steamline was well-known. VARN don't recieve 1984 e.g. U.S.A. I";
    expect(engine.misspellings(text).map(([a, b]) => text.slice(a, b))).toEqual(["Mirela’s", "statoin", "recieve"]);
    engine.setKnown(["Mirela", "Varn"]);
    expect(engine.misspellings(text).map(([a, b]) => text.slice(a, b))).toEqual(["statoin", "steamline", "recieve"]);
    expect(engine.suggest("statoin")).toContain("station");
  });

  test("known words keep their case: a capitalised name doesn't accept lower case", () => {
    const engine = new SpellEngine(dictionary, ["Varn", "zorbing"]);
    expect([engine.correct("Varn"), engine.correct("VARN"), engine.correct("varn")]).toEqual([true, true, false]);
    expect([engine.correct("zorbing"), engine.correct("Zorbing")]).toEqual([true, true]);
  });
});

test("no name or alias in the sample novel's bible is ever flagged", async () => {
  const novel = await loadNovel(nodeSource(join(import.meta.dirname, "../../../examples/sample-novel")));
  const known = knownWords(novel);
  const engine = new SpellEngine(dictionary, known);
  const flagged = novel.scenes.flatMap((s) => engine.misspellings(s.body).map(([a, b]) => s.body.slice(a, b)));
  for (const name of known) expect(engine.misspellings(name)).toEqual([]);
  expect(flagged.filter((w) => known.includes(w.replace(/[’']s$/, "")))).toEqual([]);
  // The sample's prose is otherwise clean, apart from mention targets (IDs never reach the editor's checker).
  expect(flagged.filter((w) => !/^(?:char|loc|plot|theme)_/.test(w))).toEqual([]);
});

describe("SpellCheckExtension", () => {
  let editor: Editor;
  let service: SpellService;
  const misspelled = () => [...editor.view.dom.querySelectorAll(".ghw-misspelled")].map((el) => el.textContent);

  beforeEach(() => {
    writingModes.setState({ spellcheck: true });
    service = createLocalSpellService(dictionary, ["Ada", "Varn"]);
  });
  afterEach(() => {
    closeSpellingMenu();
    editor?.destroy();
  });

  function open(markdown: string, onAddWord?: (word: string) => void) {
    editor = new Editor({ element: document.body.appendChild(document.createElement("div")), extensions: [...proseContent, SpellCheckExtension.configure({ service, onAddWord, delay: 0 })] });
    loadMarkdown(editor, markdown);
    editor.view.dispatch(editor.state.tr.insertText("")); // a no-op edit, to trigger a check of the loaded scene
    return editor;
  }

  test("underlines misspellings, never names, mentions or raw Markdown", async () => {
    open("Ada reached Varn statoin.\n\n[Benn](#char_b3n0vs) waved *recieve*.\n\n| tabel | x |\n|---|---|\n");
    await vi.waitFor(() => expect(misspelled()).toEqual(["statoin", "recieve"]));
    expect(editor.view.dom.querySelector(".ghw-misspelled")!.getAttribute("aria-invalid")).toBe("spelling");
    expect(editor.view.dom.getAttribute("spellcheck")).toBe("false");
  });

  test("after an edit, only the edited paragraph is checked again", async () => {
    const check = vi.spyOn(service, "check");
    open("First paragrph.\n\nSecond paragraph.\n\nThird paragraph.\n");
    await vi.waitFor(() => expect(misspelled()).toEqual(["paragrph"]));
    check.mockClear();
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Fourht.");
    await vi.waitFor(() => expect(misspelled()).toEqual(["paragrph", "Fourht"]));
    expect(check.mock.calls).toEqual([[["Third paragraph. Fourht."]]]);
  });

  test("turning spell check off clears the underlines; on brings them back", async () => {
    open("A statoin.\n");
    await vi.waitFor(() => expect(misspelled()).toEqual(["statoin"]));
    writingModes.getState().toggle("spellcheck");
    await vi.waitFor(() => expect(misspelled()).toEqual([]));
    writingModes.getState().toggle("spellcheck");
    await vi.waitFor(() => expect(misspelled()).toEqual(["statoin"]));
  });

  test("Mod-. opens suggestions at the caret; choosing one replaces the word", async () => {
    open("A statoin here.\n");
    await vi.waitFor(() => expect(misspelled()).toEqual(["statoin"]));
    editor.commands.setTextSelection(5);
    const event = new KeyboardEvent("keydown", { key: ".", ctrlKey: true, bubbles: true });
    expect(editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))).toBe(true);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("Spelling of “statoin”");
    await vi.waitFor(() => expect(menu.querySelector('[role="menuitem"]')!.textContent).toBe("station"));
    expect(document.activeElement!.textContent).toBe("station");
    (document.activeElement as HTMLElement).click();
    expect(editor.getText()).toBe("A station here.");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test("the menu is keyboard-driven: arrows move, Escape closes", async () => {
    open("A statoin here.\n");
    await vi.waitFor(() => expect(misspelled()).toEqual(["statoin"]));
    openSpellingMenu(editor, 5);
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    await vi.waitFor(() => expect(menu.textContent).toContain("station"));
    const key = (k: string) => menu.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("End");
    expect(document.activeElement!.textContent).toBe("Ignore");
    key("ArrowDown");
    expect(document.activeElement!.textContent).toBe("station");
    key("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test("Add to dictionary saves the word and stops flagging it", async () => {
    const added: string[] = [];
    open("The steamline ran. A steamline again.\n", (w) => added.push(w));
    await vi.waitFor(() => expect(misspelled()).toEqual(["steamline", "steamline"]));
    openSpellingMenu(editor, 6);
    const add = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((b) => b.textContent === "Add “steamline” to dictionary")!;
    add.click();
    expect(added).toEqual(["steamline"]);
    await vi.waitFor(() => expect(misspelled()).toEqual([]));
  });

  test("no menu where nothing is misspelled", async () => {
    open("A station here.\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(openSpellingMenu(editor, 5)).toBe(false);
  });
});
