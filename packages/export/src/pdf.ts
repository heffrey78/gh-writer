import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import nodeZlib from "node:zlib";
import { numberWords, type Block, type Book, type Run } from "@gh-writer/core";
import { zlibSync } from "fflate";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import { pdfCover, type CoverImage } from "./cover.ts";

/*
 * The book as a PDF, laid out like the DOCX (standard manuscript format), after its cover if it has one: Letter pages, 1-inch
 * margins, 12 pt type double-spaced with first lines indented half an inch, a title page without a
 * header, then Surname / SHORT TITLE / page at the top right; each chapter on a new page, its heading
 * a third of the way down; scene breaks centred; "THE END". The type is Liberation Serif (SIL Open Font
 * License), metric-compatible with Times New Roman, embedded (only the letters used).
 */

/** The four faces of the type, as TrueType data. */
export interface PdfFonts {
  regular: Uint8Array;
  italic: Uint8Array;
  bold: Uint8Array;
  boldItalic: Uint8Array;
}

export interface PdfOptions {
  /** The PDF's dates: the commit's, so the same commit gives the same file. */
  date?: Date;
  /** Default: Liberation Serif, shipped with gh-writer. */
  fonts?: PdfFonts;
  /** The book's cover, alone on the first page. */
  cover?: CoverImage;
  /** The pictures in the text, by repository path (readPictures). */
  pictures?: Map<string, CoverImage>;
}

export interface PdfResult {
  pdf: Uint8Array;
  /** Characters the type has no letter for (shown as boxes): worth telling the author. */
  missing: string[];
}

const PT = 72;
const PAGE = { width: 8.5 * PT, height: 11 * PT };
const MARGIN = PT;
const WIDTH = PAGE.width - 2 * MARGIN;
const SIZE = 12;
/** Double spacing: a line every 24 pt. */
const LINE = 2 * SIZE;
const INDENT = PT / 2;

/** Liberation Serif from a folder holding its four LiberationSerif-*.ttf files. */
export function readFonts(dir: URL): PdfFonts {
  const read = (name: string) => readFileSync(new URL(`LiberationSerif-${name}.ttf`, dir));
  return { regular: read("Regular"), italic: read("Italic"), bold: read("Bold"), boldItalic: read("BoldItalic") };
}

let bundled: PdfFonts | undefined;
/** Liberation Serif, from gh-writer's fonts folder (or beside the server bundle: GH_WRITER_FONTS). */
export function defaultFonts(): PdfFonts {
  const dir = process.env.GH_WRITER_FONTS;
  bundled ??= readFonts(dir ? pathToFileURL(join(dir, "/")) : new URL("../fonts/", import.meta.url));
  return bundled;
}

/**
 * Run `fn` with pdfkit compressing through fflate, as its browser build does, rather than Node's zlib:
 * Node's bytes vary with its version (zlib or zlib-ng), fflate's don't, so a book makes the same PDF
 * on the author's machine and in the novel's GitHub Action. pdfkit compresses only as it writes the
 * document out (pages are buffered), all within `fn`, synchronously: nothing else sees the swap.
 */
function portableDeflate<T>(fn: () => T): T {
  const original = nodeZlib.deflateSync;
  nodeZlib.deflateSync = ((data: Uint8Array) => Buffer.from(zlibSync(data))) as typeof nodeZlib.deflateSync;
  try {
    return fn();
  } finally {
    nodeZlib.deflateSync = original;
  }
}

export function toPdf(book: Book, { date = new Date(0), fonts = defaultFonts(), cover, pictures = new Map() }: PdfOptions = {}): Promise<PdfResult> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    // Our own type from the start: no built-in Helvetica (whose metrics are files on disk).
    font: fonts.regular as unknown as string,
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: book.title, Author: book.author, Creator: "gh-writer", Producer: "gh-writer", CreationDate: date, ModDate: date },
    lang: book.language,
    displayTitle: true,
  });
  doc.registerFont("regular", fonts.regular as unknown as string);
  doc.registerFont("italic", fonts.italic as unknown as string);
  doc.registerFont("bold", fonts.bold as unknown as string);
  doc.registerFont("boldItalic", fonts.boldItalic as unknown as string);
  doc.font("regular").fontSize(SIZE);
  // Extra space added to the type's own line height, for a line every 24 pt.
  const gap = LINE - doc.currentLineHeight(true);
  // For the whole document: text continued in another face keeps it (an option per call doesn't).
  doc.lineGap(gap);
  const single = 0;

  const coverage = (["regular", "italic", "bold", "boldItalic"] as const).map((f) => [f, fontkit.create(Buffer.from(fonts[f])) as fontkit.Font] as const);
  const has = new Map(coverage);
  const missing = new Set<string>();
  const face = (r: Pick<Run, "em" | "strong">) => (r.em && r.strong ? "boldItalic" : r.strong ? "bold" : r.em ? "italic" : "regular");
  const check = (text: string, f: ReturnType<typeof face>) => {
    for (const ch of text) if (!/\s/.test(ch) && !has.get(f)!.hasGlyphForCodePoint(ch.codePointAt(0)!)) missing.add(ch);
  };

  const centred = (text: string, f: ReturnType<typeof face> = "regular", lineGap = gap) => {
    check(text, f);
    doc.font(f).text(text, MARGIN, doc.y, { width: WIDTH, align: "center", lineGap });
  };
  const newPage = (down = 0) => {
    doc.addPage();
    doc.y = MARGIN + down;
  };
  /** A third of the way down the text block, where a chapter's heading goes. */
  const third = (PAGE.height - 2 * MARGIN) / 3;

  /** Runs set as one paragraph at `x`, `width` wide, its first line indented by `indent`. */
  const text = (runs: Run[], { x = MARGIN, width = WIDTH, indent = 0, align = "left" as "left" | "center" | "right" } = {}) => {
    runs.forEach((r, i) => {
      const f = face(r);
      check(r.text, f);
      const continued = i < runs.length - 1;
      // The paragraph's first run places it; the rest carry on along the line (given no position).
      if (i === 0) doc.font(f).text(r.text, x, doc.y, { width, indent, align, continued });
      else doc.font(f).text(r.text, { continued });
    });
  };
  const paragraph = (runs: Run[], quote: boolean) =>
    text(runs, quote ? { x: MARGIN + INDENT, width: WIDTH - 2 * INDENT } : { indent: INDENT });
  const bottom = () => PAGE.height - MARGIN;
  /** A new page unless `height` more fits on this one. */
  const room = (height: number) => {
    if (doc.y + height > bottom()) newPage();
  };

  // A scene's own headings: centred bold, bold, italic; kept with the line after them.
  const heading = (level: 1 | 2 | 3, runs: Run[]) => {
    room(3 * LINE);
    const styled = runs.map((r) => (level === 3 ? { ...r, em: !r.em } : { ...r, strong: true }));
    text(styled, { align: level === 1 ? "center" : "left" });
  };

  // A list: each item's bullet or number hanging in its margin, its blocks indented to its text.
  const list = (b: Extract<Block, { kind: "list" }>, depth: number) => {
    const x = MARGIN + (b.quote ? INDENT : 0) + depth * INDENT;
    b.items.forEach((item, n) => {
      item.forEach((child, i) => {
        if (child.kind === "list") return list(child, depth + 1);
        if (child.kind !== "paragraph") return block(child);
        room(LINE);
        if (i === 0) {
          const marker = b.ordered ? `${b.start + n}.` : "•";
          check(marker, "regular");
          const y = doc.y;
          doc.font("regular").text(marker, x, y, { width: INDENT, lineBreak: false });
          doc.y = y;
        }
        text(child.runs, { x: x + INDENT, width: WIDTH - (x + INDENT - MARGIN) });
      });
    });
  };

  // A table: ruled, the header row bold; single-spaced so a row reads as one; a row too tall for the page starts the next.
  const table = (b: Extract<Block, { kind: "table" }>) => {
    const columns = b.header.length;
    const colWidth = WIDTH / columns;
    const pad = 4;
    doc.lineGap(single);
    const row = (cells: Run[][], bold: boolean) => {
      const content = Array.from({ length: columns }, (_, i) => (cells[i] ?? []).map((r) => (bold ? { ...r, strong: true } : r)));
      const height = Math.max(LINE / 2, ...content.map((runs) => doc.font("regular").heightOfString(runs.map((r) => r.text).join("") || " ", { width: colWidth - 2 * pad }))) + 2 * pad;
      room(height);
      const top = doc.y;
      content.forEach((runs, i) => {
        doc.y = top + pad;
        if (runs.length) text(runs, { x: MARGIN + i * colWidth + pad, width: colWidth - 2 * pad, align: b.align[i] ?? "left" });
        doc.rect(MARGIN + i * colWidth, top, colWidth, height).lineWidth(0.5).stroke();
      });
      doc.y = top + height;
    };
    row(b.header, true);
    for (const r of b.rows) row(r, false);
    doc.lineGap(gap);
    doc.y += LINE / 2;
  };

  // A picture as wide as the text at most, and no taller than half the page, centred, its caption under it.
  const picture = (b: Extract<Block, { kind: "image" }>) => {
    const image = pictures.get(b.path);
    const bytes = image && pdfCover(image);
    if (image && bytes) {
      const scale = Math.min(WIDTH / image.width, (bottom() - MARGIN) / 2 / image.height);
      const [w, h] = [image.width * scale, image.height * scale];
      room(h + LINE);
      portableDeflate(() => doc.image(Buffer.from(bytes), MARGIN + (WIDTH - w) / 2, doc.y, { width: w, height: h }));
      doc.y += h + LINE / 4;
    }
    if (b.caption) centred(b.caption, "italic", single);
    doc.y += LINE / 2;
  };

  const block = (b: Block): void => {
    switch (b.kind) {
      case "break":
        return centred(book.sceneBreak);
      case "paragraph":
        return paragraph(b.runs, !!b.quote);
      case "heading":
        return heading(b.level, b.runs);
      case "list":
        return list(b, 0);
      case "table":
        return table(b);
      case "image":
        return picture(b);
    }
  };
  const blocks = (list: Block[]) => list.forEach(block);

  // The cover, as large as the page allows, centred; the manuscript starts on the next page.
  const coverBytes = cover && pdfCover(cover);
  if (coverBytes) {
    // An image is embedded as it is (its own filter), but under fflate all the same, should pdfkit deflate anything here.
    portableDeflate(() => doc.image(Buffer.from(coverBytes), 0, 0, { fit: [PAGE.width, PAGE.height], align: "center", valign: "center" }));
    newPage();
  }

  // Title page: contact details top left (single-spaced), word count top right, title and byline centred.
  doc.y = MARGIN;
  const top = doc.y;
  for (const line of book.titlePage.contact) {
    check(line, "regular");
    doc.font("regular").text(line, MARGIN, doc.y, { width: WIDTH, lineGap: single });
  }
  if (book.titlePage.wordCount) {
    check(book.titlePage.wordCount, "regular");
    doc.font("regular").text(book.titlePage.wordCount, MARGIN, top, { width: WIDTH, align: "right", lineGap: single });
  }
  doc.y = PAGE.height / 2 - LINE;
  centred(book.title);
  if (book.author) centred(`by ${book.author}`);

  const section = (title: string, list: Block[]) => {
    newPage(third);
    centred(title);
    doc.y += LINE;
    blocks(list);
  };
  for (const s of book.front) section(s.title, s.blocks);
  for (const chapter of book.chapters) {
    if (chapter.part) {
      newPage(third);
      centred(`Part ${numberWords(chapter.part.number)}`);
      if (chapter.part.title) centred(chapter.part.title);
    }
    section(chapter.heading, chapter.blocks);
  }
  if (book.chapters.length) {
    doc.y += LINE / 2;
    centred("THE END");
  }
  for (const s of book.back) section(s.title, s.blocks);

  // The running header, from the manuscript's page 2 (the title page is its page 1), once every page is there.
  const range = doc.bufferedPageRange();
  const titlePage = range.start + (coverBytes ? 1 : 0);
  for (let i = titlePage + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const header = `${book.header.surname} / ${book.header.shortTitle} / ${i - titlePage + 1}`;
    check(header, "regular");
    // In the top margin: no new page for writing there.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("regular").text(header, MARGIN, MARGIN / 2, { width: WIDTH, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    doc.on("data", (c: Uint8Array) => chunks.push(c));
    doc.on("end", () => resolve({ pdf: Buffer.concat(chunks), missing: [...missing] }));
    doc.on("error", reject);
    portableDeflate(() => doc.end());
  });
}
