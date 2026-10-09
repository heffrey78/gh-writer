import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileBook, countWords, loadNovel, memorySource, numberWords, type Book, type FileSource } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const sample: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

async function open(overrides: Record<string, string> = {}) {
  const source: FileSource = memorySource({ ...sample, ...overrides });
  const novel = await loadNovel(source);
  return { novel, source };
}
const text = (book: Book) => JSON.stringify(book);
const words = (b: Book["chapters"][number]) => b.blocks.flatMap((x) => (x.kind === "paragraph" ? x.runs.map((r) => r.text) : ["#"])).join(" ");

describe("compiling the manuscript", () => {
  it("puts the chapters and their scenes in reading order, parts marked, scenes set apart by breaks", async () => {
    const { novel, source } = await open();
    const book = await compileBook(novel, source);
    expect(book).toMatchObject({ title: "The Bridge at Varn", author: "gh-writer sample", language: "en", sceneBreak: "#", header: { surname: "sample", shortTitle: "BRIDGE AT VARN" } });
    expect(book.chapters.map((c) => [c.number, c.heading, c.part?.title])).toEqual([
      [1, "Chapter One: Arrival", "Return"],
      [2, "Chapter Two: Old Debts", undefined],
      [3, "Chapter Three: Night Crossing", "The Sale"],
      [4, "Chapter Four: Varn Holds", undefined],
    ]);
    for (const [i, chapter] of novel.chapters.entries()) {
      const scenes = chapter.sceneIds.filter((id) => novel.allScenes.find((s) => s.id === id)?.body.trim());
      expect(book.chapters[i]!.blocks.filter((b) => b.kind === "break").length, chapter.id).toBeGreaterThanOrEqual(scenes.length - 1);
      expect(book.chapters[i]!.blocks[0]?.kind).toBe("paragraph");
      expect(book.chapters[i]!.blocks.at(-1)?.kind).toBe("paragraph");
    }
    expect(book.words).toBe(novel.scenes.reduce((n, s) => n + countWords(s.body), 0));
    expect(book.titlePage.wordCount).toBe(`about ${(Math.round(book.words / 100) * 100).toLocaleString("en-US")} words`);
  });

  it("keeps only the story's words: mentions as their words, no IDs, front matter or hidden notes", async () => {
    const { novel, source } = await open();
    const book = await compileBook(novel, source);
    expect(text(book)).not.toMatch(/#char_|#loc_|\]\(|<!--|^---|synopsis/);
    expect(words(book.chapters[1]!)).toContain(`Tomas did not look up from the lathe when she came in.`);
  });

  it("keeps italic and bold, line breaks, quotes and breaks written in a scene", async () => {
    const station = sample[STATION]!.replace(/\n---\n[\s\S]*$/, "\n---\n");
    const { novel, source } = await open({
      [STATION]: `${station}She said it _twice_, **loudly**, and _**both**_.\n\nA line\\\nbroken.\n\n<!-- a note for later -->\n\n***\n\n> A letter, quoted.\n`,
    });
    const book = await compileBook(novel, source, { to: novel.chapters[0]!.id });
    const blocks = book.chapters[0]!.blocks;
    expect(blocks[0]).toEqual({ kind: "paragraph", runs: [{ text: "She said it " }, { text: "twice", em: true }, { text: ", " }, { text: "loudly", strong: true }, { text: ", and " }, { text: "both", em: true, strong: true }, { text: "." }] });
    expect(blocks[1]).toEqual({ kind: "paragraph", runs: [{ text: "A line\nbroken." }] });
    expect(blocks[2]).toEqual({ kind: "break" });
    expect(blocks[3]).toEqual({ kind: "paragraph", runs: [{ text: "A letter, quoted." }], quote: true });
    // Then the next scene, after one break.
    expect(blocks[4]).toEqual({ kind: "break" });
  });

  it("compiles a range of chapters, keeping their numbers", async () => {
    const { novel, source } = await open();
    const book = await compileBook(novel, source, { from: novel.chapters[1]!.id, to: novel.chapters[2]!.id });
    expect(book.chapters.map((c) => [c.number, c.heading, c.part?.title])).toEqual([
      [2, "Chapter Two: Old Debts", undefined],
      [3, "Chapter Three: Night Crossing", "The Sale"],
    ]);
    expect(book.words).toBeLessThan((await compileBook(novel, source)).words);
    await expect(compileBook(novel, source, { from: novel.chapters[2]!.id, to: novel.chapters[1]!.id })).rejects.toThrow("ends before it starts");
    await expect(compileBook(novel, source, { from: "ch_nope00" })).rejects.toThrow("isn't in the book");
  });

  it("follows a preset: title page, header, scene break, headings, word count, front and back matter", async () => {
    const { novel, source } = await open({
      "compile.yaml": [
        "presets:",
        "  submission:",
        "    title_page:",
        "      author: Ada Writer",
        "      contact: [Ada Writer, 1 Bridge Street, ada@example.com]",
        "      short_title: Varn",
        "    scene_break: '* * *'",
        "    chapter_heading: number",
        "    word_count: exact",
        "    front: [front/dedication.md]",
        "    back: [back/thanks.md]",
        "  ebook:",
        "    chapter_heading: title",
        "    word_count: none",
        "",
      ].join("\n"),
      "front/dedication.md": "# For my father\n\nWho set the clock four minutes fast.\n",
      "back/thanks.md": "Thank you, _Varn_.\n",
    });
    expect(novel.diagnostics.filter((d) => d.file === "compile.yaml")).toEqual([]);
    const book = await compileBook(novel, source);
    expect(book.header).toEqual({ surname: "Writer", shortTitle: "VARN" });
    expect(book.titlePage).toEqual({ contact: ["Ada Writer", "1 Bridge Street", "ada@example.com"], wordCount: `${book.words.toLocaleString("en-US")} words` });
    expect(book.sceneBreak).toBe("* * *");
    expect(book.chapters[0]!.heading).toBe("Chapter One");
    expect(book.front).toEqual([{ title: "For my father", blocks: [{ kind: "paragraph", runs: [{ text: "Who set the clock four minutes fast." }] }] }]);
    expect(book.back).toEqual([{ title: "thanks", blocks: [{ kind: "paragraph", runs: [{ text: "Thank you, " }, { text: "Varn", em: true }, { text: "." }] }] }]);
    const ebook = await compileBook(novel, source, { preset: "ebook" });
    expect(ebook.chapters[0]!.heading).toBe("Arrival");
    expect(ebook.titlePage.wordCount).toBeUndefined();
    await expect(compileBook(novel, source, { preset: "nope" })).rejects.toThrow("no preset “nope”");
  });

  it("reports a preset naming a missing file, or a setting it doesn't know", async () => {
    const { novel } = await open({ "compile.yaml": "presets:\n  draft:\n    front: [front/missing.md]\n    chapter_heading: fancy\n" });
    expect(novel.diagnostics.filter((d) => d.file === "compile.yaml").map((d) => d.code).sort()).toEqual(["E_MISSING_FILE", "E_SCHEMA"]);
  });

  it("writes chapter numbers in words", () => {
    expect([1, 12, 20, 21, 42, 99, 100, 101, 345].map(numberWords)).toEqual(["One", "Twelve", "Twenty", "Twenty-One", "Forty-Two", "Ninety-Nine", "One Hundred", "One Hundred One", "Three Hundred Forty-Five"]);
  });
});
