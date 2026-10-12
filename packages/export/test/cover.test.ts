import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBook, loadNovel, memorySource, type Book } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { strFromU8, unzipSync, unzlibSync } from "fflate";
import { JSDOM } from "jsdom";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { coverImage, pdfCover, readCover, render, toEpub, toPdf } from "../src/index.ts";

const JPEG = new Uint8Array(readFileSync(new URL("fixtures/cover.jpg", import.meta.url)));
const ALPHA_PNG = new Uint8Array(readFileSync(new URL("fixtures/cover-alpha.png", import.meta.url)));
const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const files: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const source = memorySource(files);
const book: Book = await compileBook(await loadNovel(source), source);
const DATE = new Date("2026-10-09T12:00:00Z");
const cover = coverImage(JPEG)!;
const window = new JSDOM("").window;

describe("a cover image", () => {
  it("is a JPEG or a PNG, with its size read from the file", () => {
    expect(coverImage(JPEG)).toMatchObject({ type: "image/jpeg", width: 400, height: 640 });
    expect(coverImage(ALPHA_PNG)).toMatchObject({ type: "image/png", width: 200, height: 320 });
    expect(coverImage(new TextEncoder().encode("GIF89a, not one"))).toBeUndefined();
  });

  it("goes into a PDF as it is when it's a JPEG; a PNG with transparency is flattened onto white, the same bytes each time", () => {
    expect(pdfCover(cover)).toBe(JPEG);
    const png = coverImage(ALPHA_PNG)!;
    const flat = pdfCover(png)!;
    expect(pdfCover(png)).toEqual(flat);
    const flattened = coverImage(flat)!;
    expect(flattened).toMatchObject({ type: "image/png", width: 200, height: 320 });
    // Opaque RGB, and our own rows (no filter): the transparent corner is white, the middle the drawing's.
    expect(flat[25]).toBe(2);
    const idat = flat.subarray(41, 41 + new DataView(flat.buffer, flat.byteOffset).getUint32(33));
    const rows = unzlibSync(idat);
    const pixel = (x: number, y: number) => [...rows.subarray(y * (1 + 600) + 1 + x * 3, y * (1 + 600) + 4 + x * 3)];
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(100, 120)[0]).toBeGreaterThan(200);
    expect(pixel(100, 120)[2]).toBeLessThan(120);
  });

  it("is read from novel.yaml's cover, or says why it can't be", async () => {
    const root = mkdtempSync(join(tmpdir(), "gh-writer-cover-"));
    mkdirSync(join(root, "images"));
    writeFileSync(join(root, "images/cover.jpg"), JPEG);
    writeFileSync(join(root, "images/notes.jpg"), "not an image");
    const novel = async (yaml: string) => {
      writeFileSync(join(root, "novel.yaml"), `schema_version: 1\nid: nv_4k8h2c\ntitle: T\n${yaml}`);
      return loadNovel(nodeSource(root));
    };
    expect(await readCover(root, await novel(""))).toEqual({});
    expect(await readCover(root, await novel("cover: images/cover.jpg\n"))).toMatchObject({ cover: { type: "image/jpeg", width: 400 } });
    expect((await readCover(root, await novel("cover: images/gone.jpg\n"))).problem).toBe("The cover, images/gone.jpg, isn't there, so the book goes out without it.");
    expect((await readCover(root, await novel("cover: images/notes.jpg\n"))).problem).toContain("isn't a JPEG or PNG image");
    expect((await readCover(root, await novel("cover: ../outside.jpg\n"))).problem).toContain("isn't a path in the novel");
  });
});

describe("the EPUB's cover", () => {
  const bytes = toEpub(book, { date: DATE, cover });
  const zip = unzipSync(bytes);
  const text = (path: string) => strFromU8(zip[path]!);
  const parse = (s: string, type: DOMParserSupportedType) => new window.DOMParser().parseFromString(s, type);

  it("is the cover image in the manifest, and the first page in the spine", () => {
    const opf = text("OEBPS/content.opf");
    expect(opf).toContain('<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect([...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]).slice(0, 2)).toEqual(["cover", "title"]);
    expect(zip["OEBPS/images/cover.jpg"]).toEqual(JPEG);
  });

  it("shows the image with alternative text, and is a landmark to open on, not in the contents", () => {
    const page = parse(text("OEBPS/cover.xhtml"), "application/xhtml+xml");
    expect(page.getElementsByTagName("parsererror")).toHaveLength(0);
    const img = page.querySelector("section img")!;
    expect(img.getAttribute("src")).toBe("images/cover.jpg");
    expect(img.getAttribute("alt")).toBe("The cover of The Bridge at Varn");
    const nav = parse(text("OEBPS/nav.xhtml"), "application/xhtml+xml");
    expect(nav.getElementsByTagName("parsererror")).toHaveLength(0);
    expect([...nav.querySelectorAll("nav#landmarks a")].map((a) => [a.getAttribute("epub:type"), a.getAttribute("href")])).toEqual([["cover", "cover.xhtml"], ["bodymatter", "part-1.xhtml"]]);
    expect(nav.querySelector("nav#toc")!.textContent).not.toContain("Cover");
  });

  it("is a PNG's own type when the cover is one", () => {
    const png = unzipSync(toEpub(book, { date: DATE, cover: coverImage(ALPHA_PNG)! }));
    expect(strFromU8(png["OEBPS/content.opf"]!)).toContain('href="images/cover.png" media-type="image/png" properties="cover-image"');
  });

  it("leaves an e-book without one as it was", () => {
    const plain = unzipSync(toEpub(book, { date: DATE }));
    expect(Object.keys(plain).some((k) => k.includes("cover"))).toBe(false);
    expect(strFromU8(plain["OEBPS/nav.xhtml"]!)).not.toContain("landmarks");
  });
});

describe("the PDF's cover", async () => {
  const { pdf } = await toPdf(book, { date: DATE, cover });
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const textOf = async (n: number) => (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ").trim();

  it("is the first page, alone; the title page follows, and the header counts from it", async () => {
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(OPS.paintImageXObject);
    expect(await textOf(1)).toBe("");
    expect(await textOf(2)).toContain("The Bridge at Varn");
    expect(await textOf(2)).not.toContain("BRIDGE AT VARN /");
    expect(await textOf(3)).toMatch(/BRIDGE AT VARN \/ 2/);
  });

  it("is the same file, byte for byte, each time, with a JPEG or a transparent PNG", async () => {
    expect((await toPdf(book, { date: DATE, cover })).pdf).toEqual(pdf);
    const png = coverImage(ALPHA_PNG)!;
    expect((await toPdf(book, { date: DATE, cover: png })).pdf).toEqual((await toPdf(book, { date: DATE, cover: png })).pdf);
  });
});

describe("a Word manuscript", () => {
  it("goes out without the cover", async () => {
    expect((await render(book, "docx", { date: DATE, cover })).bytes).toEqual((await render(book, "docx", { date: DATE })).bytes);
  });
});
