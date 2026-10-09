import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook, loadNovel, memorySource, type Book } from "@gh-writer/core";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { toEpub } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const files: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
files[STATION] = files[STATION]!.replace(/\n---\n[\s\S]*$/, "\n---\nShe said it _twice_ & **loudly**.\n\n> A letter,\\\n> quoted.\n\n***\n\nAfter the break.\n");
files["compile.yaml"] = "presets:\n  ebook:\n    title_page: { author: Ada Writer }\n    back: [back/thanks.md]\n";
files["back/thanks.md"] = "# Thanks\n\nTo Varn.\n";
const source = memorySource(files);
const book: Book = await compileBook(await loadNovel(source), source);
const DATE = new Date("2026-10-09T12:00:00Z");
const bytes = toEpub(book, { date: DATE });
const epub = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
const window = new JSDOM("").window;
const parse = (text: string, type: DOMParserSupportedType) => new window.DOMParser().parseFromString(text, type);

describe("EPUB 3", () => {
  it("starts with the mimetype, stored uncompressed, as EPUB requires", () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(strFromU8(bytes.subarray(30, 38))).toBe("mimetype");
    expect(epub.mimetype).toBe("application/epub+zip");
  });

  it("is well-formed: container, package document, navigation and every page", () => {
    expect(epub["META-INF/container.xml"]).toContain('full-path="OEBPS/content.opf"');
    for (const [name, text] of Object.entries(epub)) {
      if (name.endsWith(".xhtml")) expect(parse(text, "application/xhtml+xml").getElementsByTagName("parsererror"), name).toHaveLength(0);
      if (name.endsWith(".opf") || name.endsWith(".xml")) expect(parse(text, "application/xml").getElementsByTagName("parsererror"), name).toHaveLength(0);
    }
  });

  it("describes the book: identifier from the novel's ID, title, author, language, modified date", () => {
    const opf = epub["OEBPS/content.opf"]!;
    expect(opf).toContain('<dc:identifier id="book-id">urn:gh-writer:nv_4k8h2c</dc:identifier><dc:title>The Bridge at Varn</dc:title><dc:creator>Ada Writer</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-09T12:00:00Z</meta>');
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(spine).toEqual(["title", "part-1", "chapter-001", "chapter-002", "part-2", "chapter-003", "chapter-004", "back-1"]);
    for (const id of spine) expect(epub[`OEBPS/${id}.xhtml`], id).toBeDefined();
  });

  it("lists the chapters under their parts in the table of contents", () => {
    const nav = parse(epub["OEBPS/nav.xhtml"]!, "application/xhtml+xml");
    const top = [...nav.querySelectorAll("nav > ol > li")].map((li) => li.querySelector(":scope > a")!.textContent);
    expect(top).toEqual(["Part One: Return", "Part Two: The Sale", "Thanks"]);
    const first = [...nav.querySelectorAll("nav > ol > li:first-child > ol > li > a")].map((a) => a.textContent);
    expect(first).toEqual(["Chapter One: Arrival", "Chapter Two: Old Debts"]);
  });

  it("writes the prose as XHTML: italic, bold, line breaks, quotes, scene breaks", () => {
    const one = epub["OEBPS/chapter-001.xhtml"]!;
    expect(one).toContain("<h2>Chapter One: Arrival</h2><p>She said it <em>twice</em> &amp; <strong>loudly</strong>.</p><blockquote><p>A letter,<br/>quoted.</p></blockquote>");
    expect(one).toContain('<p class="scene-break" role="separator" aria-label="Scene break">#</p><p>After the break.</p>');
    expect(one).toContain('xml:lang="en" lang="en"');
  });

  it("is the same file, byte for byte, from the same book and date", () => {
    expect(Buffer.from(toEpub(book, { date: DATE })).equals(Buffer.from(bytes))).toBe(true);
  });
});
