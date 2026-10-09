import { readFileSync } from "node:fs";
import { numberWords, type Block, type Book, type Run } from "@gh-writer/core";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

/*
 * The book as a PDF, laid out like the DOCX (standard manuscript format): Letter pages, 1-inch
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

let bundled: PdfFonts | undefined;
/** Liberation Serif, from gh-writer's fonts folder. */
export function defaultFonts(): PdfFonts {
  const read = (name: string) => readFileSync(new URL(`../fonts/LiberationSerif-${name}.ttf`, import.meta.url));
  bundled ??= { regular: read("Regular"), italic: read("Italic"), bold: read("Bold"), boldItalic: read("BoldItalic") };
  return bundled;
}

export function toPdf(book: Book, { date = new Date(0), fonts = defaultFonts() }: PdfOptions = {}): Promise<PdfResult> {
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

  const paragraph = (runs: Run[], quote: boolean) => {
    const x = quote ? MARGIN + INDENT : MARGIN;
    const width = quote ? WIDTH - 2 * INDENT : WIDTH;
    runs.forEach((r, i) => {
      const f = face(r);
      check(r.text, f);
      const continued = i < runs.length - 1;
      // The paragraph's first run places it; the rest carry on along the line (given no position).
      if (i === 0) doc.font(f).text(r.text, x, doc.y, { width, indent: quote ? 0 : INDENT, continued });
      else doc.font(f).text(r.text, { continued });
    });
  };
  const blocks = (list: Block[]) => {
    for (const b of list) {
      if (b.kind === "break") centred(book.sceneBreak);
      else paragraph(b.runs, !!b.quote);
    }
  };

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

  // The running header, from page 2, once every page is there.
  const range = doc.bufferedPageRange();
  for (let i = range.start + 1; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const header = `${book.header.surname} / ${book.header.shortTitle} / ${i - range.start + 1}`;
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
    doc.end();
  });
}
