import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook, loadNovel, memorySource, type Book } from "@gh-writer/core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { toPdf } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const files: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
files[STATION] = files[STATION]!.replace(/\n---\n[\s\S]*$/, "\n---\nShe said it _twice_, “quietly” — café.\n\nThe second paragraph runs on long enough to wrap onto a second line of the page, so the spacing between its lines can be measured.\n");
files["compile.yaml"] = "presets:\n  submission:\n    title_page:\n      author: Ada Writer\n      contact: [Ada Writer, 1 Bridge Street]\n";
const source = memorySource(files);
const book: Book = await compileBook(await loadNovel(source), source);
const DATE = new Date("2026-10-09T12:00:00Z");
const { pdf, missing } = await toPdf(book, { date: DATE });

interface Line {
  text: string;
  y: number;
}
/** Each page's lines of text, top to bottom. */
async function pages(bytes: Uint8Array): Promise<Line[][]> {
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const out: Line[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const lines = new Map<number, string>();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const y = Math.round(item.transform[5]);
      lines.set(y, (lines.get(y) ?? "") + item.str);
    }
    out.push([...lines].sort((a, b) => b[0] - a[0]).map(([y, text]) => ({ y, text: text.trim() })).filter((l) => l.text));
  }
  return out;
}
const read = await pages(pdf);

describe("PDF", () => {
  it("opens with a title page: contact top left, word count top right, title and byline, no header", () => {
    const first = read[0]!.map((l) => l.text);
    expect(first[0]).toMatch(/^Ada Writer\s*about [\d,]+ words$/);
    expect(first).toEqual(expect.arrayContaining(["1 Bridge Street", "The Bridge at Varn", "by Ada Writer"]));
    expect(first.join(" ")).not.toContain("BRIDGE AT VARN /");
  });

  it("runs a header from page 2: Surname / SHORT TITLE / page number", () => {
    expect(read.length).toBeGreaterThanOrEqual(1 + 2 + 4);
    read.slice(1).forEach((page, i) => expect(page[0]!.text).toBe(`Writer / BRIDGE AT VARN / ${i + 2}`));
  });

  it("starts parts and chapters on new pages, and ends with THE END", () => {
    const starts = read.map((p) => p[1]?.text);
    for (const c of book.chapters) expect(starts).toContain(c.heading);
    expect(starts).toEqual(expect.arrayContaining(["Part One", "Part Two"]));
    expect(read.at(-1)!.map((l) => l.text)).toContain("THE END");
  });

  it("double-spaces the text: a line every 24 pt", () => {
    const page = read.find((p) => p.some((l) => l.text.startsWith("The second paragraph")))!;
    const at = page.findIndex((l) => l.text.startsWith("The second paragraph"));
    expect(page[at]!.y - page[at + 1]!.y).toBe(24);
    expect(page[at - 1]!.y - page[at]!.y).toBe(24);
    expect(page.map((l) => l.text)).toContain("She said it twice, “quietly” — café.");
  });

  it("embeds Liberation Serif, and reports characters it can't show", async () => {
    const text = Buffer.from(pdf).toString("latin1");
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSerif\b/);
    expect(text).toMatch(/LiberationSerif-Italic/);
    expect(missing).toEqual([]);
    const s2 = memorySource({ ...files, [STATION]: files[STATION]!.replace("café", "café 漢字") });
    expect((await toPdf(await compileBook(await loadNovel(s2), s2), { date: DATE })).missing).toEqual(["漢", "字"]);
  });

  it("is the same file, byte for byte, from the same book and date", async () => {
    expect(Buffer.from((await toPdf(book, { date: DATE })).pdf).equals(Buffer.from(pdf))).toBe(true);
  });
});
