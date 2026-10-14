import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook, loadNovel, memorySource, type Book } from "@gh-writer/core";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { coverImage, toDocx, toEpub, toPdf, type CoverImage } from "../src/index.ts";

/** A scene's own headings, lists, tables and pictures in every format (D10, #204). */

const JPEG = new Uint8Array(readFileSync(new URL("fixtures/cover.jpg", import.meta.url)));
const ALPHA_PNG = new Uint8Array(readFileSync(new URL("fixtures/cover-alpha.png", import.meta.url)));
const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const files: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const RICH = [
  "## The letter",
  "Dear [Ada](#char_7f3k2q),",
  "3. Sell the *workshop*.\n4. Pay Ben:\n   - the rent\n   - the debt",
  "| Day | Miles |\n|:---|---:|\n| Monday | **12** |\n| Tuesday | 4 |",
  "![A map of Varn](/images/maps/varn.jpg \"The valley, as Tomas drew it\")",
  "![The seal](/images/seal.png)",
  "### Postscript",
  "Burn this.",
].join("\n\n");
files[STATION] = files[STATION]!.replace(/\n---\n[\s\S]*$/, `\n---\n${RICH}\n`);
const source = memorySource(files);
const book: Book = await compileBook(await loadNovel(source), source);
const pictures = new Map<string, CoverImage>([
  ["images/maps/varn.jpg", coverImage(JPEG)!],
  ["images/seal.png", coverImage(ALPHA_PNG)!],
]);
const DATE = new Date("2026-10-14T12:00:00Z");
const window = new JSDOM("").window;
const parse = (s: string, type: DOMParserSupportedType) => new window.DOMParser().parseFromString(s, type);

describe("the EPUB", () => {
  const zip = unzipSync(toEpub(book, { date: DATE, pictures }));
  const text = (path: string) => strFromU8(zip[path]!);
  const chapter = parse(text("OEBPS/chapter-001.xhtml"), "application/xhtml+xml");

  it("sets headings beneath the chapter's, lists nested and numbered from their start, and tables with their header", () => {
    expect(chapter.getElementsByTagName("parsererror")).toHaveLength(0);
    expect([...chapter.querySelectorAll(".scene-heading")].map((h) => [h.tagName, h.textContent])).toEqual([
      ["h4", "The letter"],
      ["h5", "Postscript"],
    ]);
    const ol = chapter.querySelector("ol")!;
    expect(ol.getAttribute("start")).toBe("3");
    expect([...ol.querySelectorAll(":scope > li > p")].map((p) => p.textContent)).toEqual(["Sell the workshop.", "Pay Ben:"]);
    expect([...ol.querySelectorAll("li ul > li")].map((li) => li.textContent)).toEqual(["the rent", "the debt"]);
    expect(ol.querySelector("em")!.textContent).toBe("workshop");
    const th = [...chapter.querySelectorAll("table thead th")];
    expect(th.map((t) => [t.getAttribute("scope"), t.className, t.textContent])).toEqual([
      ["col", "align-left", "Day"],
      ["col", "align-right", "Miles"],
    ]);
    expect([...chapter.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual(["Monday12", "Tuesday4"]);
    expect(chapter.querySelector("tbody strong")!.textContent).toBe("12");
  });

  it("shows each picture with its description and caption, and carries it in the book", () => {
    const figures = [...chapter.querySelectorAll("figure")];
    expect(figures.map((f) => [f.querySelector("img")!.getAttribute("src"), f.querySelector("img")!.getAttribute("alt"), f.querySelector("figcaption")?.textContent])).toEqual([
      ["pictures/maps/varn.jpg", "A map of Varn", "The valley, as Tomas drew it"],
      ["pictures/seal.png", "The seal", undefined],
    ]);
    const opf = text("OEBPS/content.opf");
    expect(opf).toContain('<item id="picture-1" href="pictures/maps/varn.jpg" media-type="image/jpeg"/>');
    expect(opf).toContain('<item id="picture-2" href="pictures/seal.png" media-type="image/png"/>');
    expect(zip["OEBPS/pictures/maps/varn.jpg"]).toEqual(JPEG);
  });

  it("without a picture's file, keeps its caption", () => {
    const without = parse(strFromU8(unzipSync(toEpub(book, { date: DATE }))["OEBPS/chapter-001.xhtml"]!), "application/xhtml+xml");
    expect(without.querySelector("figure")).toBeNull();
    expect(without.querySelector(".caption")!.textContent).toBe("The valley, as Tomas drew it");
  });
});

describe("the Word manuscript", () => {
  const zip = unzipSync(toDocx(book, { date: DATE, pictures }));
  const text = (path: string) => strFromU8(zip[path]!);
  const document = text("word/document.xml");

  it("styles headings, numbers lists from their start, nests them, and repeats a table's header row", () => {
    expect(parse(document, "application/xml").getElementsByTagName("parsererror")).toHaveLength(0);
    expect(document).toMatch(/<w:pStyle w:val="SceneHeading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">The letter<\/w:t>/);
    expect(document).toContain('<w:pStyle w:val="SceneHeading3"/>');
    // The numbered list is list 1 at level 0; its nested bullets list 2 at level 1.
    expect(document).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    expect(document).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>');
    const numbering = text("word/numbering.xml");
    expect(numbering).toMatch(/<w:num w:numId="1"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/);
    expect(numbering).toMatch(/<w:num w:numId="2"><w:abstractNumId w:val="0"\/>/);
    expect(document).toContain("<w:tblHeader/>");
    expect(document).toMatch(/<w:jc w:val="right"\/><\/w:pPr><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Miles/);
  });

  it("embeds each picture at its shape, described, with its caption under it", () => {
    expect(document).toMatch(/<wp:docPr id="1" name="Picture 1" descr="A map of Varn"\/>/);
    expect(document).toContain('<a:blip r:embed="rIdPicture1"/>');
    // 400 × 640 px, as tall as 7 inches allows: 4.375 × 7 in.
    expect(document).toContain('<wp:extent cx="4000500" cy="6400800"/>');
    expect(document).toMatch(/<w:pStyle w:val="Caption"\/><\/w:pPr><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">The valley, as Tomas drew it/);
    expect(text("word/_rels/document.xml.rels")).toContain('Id="rIdPicture2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/picture2.png"');
    expect(text("[Content_Types].xml")).toContain('<Default Extension="jpg" ContentType="image/jpeg"/>');
    expect(zip["word/media/picture1.jpg"]).toEqual(JPEG);
  });
});

describe("the PDF", async () => {
  const { pdf } = await toPdf(book, { date: DATE, pictures });
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const pages = await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => (await (await doc.getPage(i + 1)).getTextContent()).items.map((x) => ("str" in x ? x.str : "")).join(" ")));
  const all = pages.join("\n");

  it("sets the headings, the list's numbers and bullets, the table's cells and the captions", () => {
    for (const words of ["The letter", "3.", "Sell the", "workshop", "4.", "•", "the rent", "Day", "Miles", "Monday", "12", "The valley, as Tomas drew it", "Postscript", "Burn this."]) {
      expect(all, words).toContain(words);
    }
  });

  it("draws both pictures, and is the same file each time", async () => {
    let images = 0;
    for (let i = 1; i <= doc.numPages; i++) images += (await (await doc.getPage(i)).getOperatorList()).fnArray.filter((op) => op === OPS.paintImageXObject).length;
    expect(images).toBe(2);
    const again = await toPdf(book, { date: DATE, pictures });
    expect(Buffer.from(again.pdf).equals(Buffer.from(pdf))).toBe(true);
  });
});
