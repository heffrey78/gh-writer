import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook, loadNovel, memorySource, type Book } from "@gh-writer/core";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { toDocx } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const files: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
files["compile.yaml"] = "presets:\n  submission:\n    title_page:\n      author: Ada Writer\n      contact: [Ada Writer, 1 Bridge Street, ada@example.com]\n    front: [front/dedication.md]\n";
files["front/dedication.md"] = "# For my father\n\nWho set the clock fast.\n";
const source = memorySource(files);
const book: Book = await compileBook(await loadNovel(source), source);
const DATE = new Date("2026-10-09T12:00:00Z");
const parts = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
const parse = (text: string) => new new JSDOM("").window.DOMParser().parseFromString(text, "application/xml");

describe("DOCX in standard manuscript format", () => {
  const docx = parts(toDocx(book, { date: DATE }));
  const doc = docx["word/document.xml"]!;
  const styles = docx["word/styles.xml"]!;

  it("is a well-formed Word package", () => {
    expect(Object.keys(docx).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "word/_rels/document.xml.rels", "word/document.xml", "word/header1.xml", "word/header2.xml", "word/settings.xml", "word/styles.xml"]);
    for (const [name, text] of Object.entries(docx)) expect(parse(text).getElementsByTagName("parsererror"), name).toHaveLength(0);
    expect(docx["docProps/core.xml"]).toContain("<dc:title>The Bridge at Varn</dc:title><dc:creator>Ada Writer</dc:creator>");
    expect(docx["docProps/core.xml"]).toContain("2026-10-09T12:00:00Z");
  });

  it("sets Times New Roman 12 pt, double-spaced, first lines indented half an inch, 1-inch margins on Letter pages", () => {
    expect(styles).toContain('w:ascii="Times New Roman"');
    expect(styles).toContain('<w:sz w:val="24"/>');
    expect(styles).toMatch(/w:styleId="Normal" w:default="1">.*<w:spacing w:after="0" w:line="480" w:lineRule="auto"\/><w:ind w:firstLine="720"\/>/);
    expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"');
  });

  it("opens with a title page: contact top left, word count top right, title and byline centred, no header", () => {
    expect(doc).toMatch(/^.*?<w:body><w:p><w:pPr><w:pStyle w:val="Contact"\/><w:tabs><w:tab w:val="right" w:pos="9360"\/><\/w:tabs><\/w:pPr><w:r><w:t xml:space="preserve">Ada Writer<\/w:t><\/w:r><w:r><w:tab\/><\/w:r><w:r><w:t xml:space="preserve">about [\d,]+ words<\/w:t><\/w:r><\/w:p>/s);
    expect(doc).toContain('<w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">The Bridge at Varn</w:t>');
    expect(doc).toContain(">by Ada Writer<");
    // The first page's header is the empty one.
    expect(doc).toContain("<w:titlePg/>");
    expect(docx["word/header2.xml"]).not.toContain("<w:t");
  });

  it("runs a header from page 2: Surname / SHORT TITLE / page number, right-aligned", () => {
    expect(docx["word/header1.xml"]).toContain('<w:t xml:space="preserve">Writer / BRIDGE AT VARN / </w:t>');
    expect(docx["word/header1.xml"]).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>');
    expect(styles).toMatch(/w:styleId="Header">.*<w:jc w:val="right"\/>/);
  });

  it("starts front matter, parts and chapters on new pages, chapter headings a third down; breaks centred; THE END", () => {
    const pageBreaks = doc.split('<w:br w:type="page"/>').length - 1;
    expect(pageBreaks).toBe(book.front.length + book.chapters.length + book.chapters.filter((c) => c.part).length);
    expect([...doc.matchAll(/<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">([^<]+)</g)].map((m) => m[1])).toEqual(book.chapters.map((c) => c.heading));
    expect(doc).toContain(">Part One<");
    expect(doc).toContain(">For my father<");
    expect(styles).toMatch(/w:styleId="Heading1">.*<w:spacing w:before="2880"/);
    expect(doc.split('<w:pStyle w:val="SceneBreak"/>').length - 1).toBe(book.chapters.flatMap((c) => c.blocks).filter((b) => b.kind === "break").length);
    expect(doc).toMatch(/<w:pStyle w:val="TheEnd"\/><\/w:pPr><w:r><w:t xml:space="preserve">THE END<\/w:t><\/w:r><\/w:p><w:sectPr>/);
  });

  it("keeps italic and bold, escapes what XML needs, and breaks lines", async () => {
    const station = "manuscript/01-return/01-arrival/01-the-station.md";
    const s2 = memorySource({ ...files, [station]: files[station]!.replace(/\n---\n[\s\S]*$/, "\n---\n_Quiet_ & **bold**, 1 < 2 > 0,\\\nthen on.\n") });
    const one = parts(toDocx(await compileBook(await loadNovel(s2), s2), { date: DATE }))["word/document.xml"]!;
    expect(one).toContain('<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">Quiet</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t></w:r><w:r><w:t xml:space="preserve">, 1 &lt; 2 &gt; 0,</w:t><w:br/><w:t xml:space="preserve">then on.</w:t></w:r>');
  });

  it("is the same file, byte for byte, from the same book and date", () => {
    expect(Buffer.from(toDocx(book, { date: DATE })).equals(Buffer.from(toDocx(book, { date: DATE })))).toBe(true);
    expect(Buffer.from(toDocx(book, { date: DATE })).equals(Buffer.from(toDocx(book, { date: new Date("2027-01-01T00:00:00Z") })))).toBe(false);
  });
});
