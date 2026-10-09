import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slugify, type Book } from "@gh-writer/core";
import { toDocx } from "./docx.ts";
import { toEpub } from "./epub.ts";
import { toPdf, type PdfFonts } from "./pdf.ts";

/*
 * A compiled book as files, the same wherever it's made (the app, the command line, the novel's
 * GitHub Action): one name for each, one date from the commit, one renderer per format.
 */

export const FORMATS = ["docx", "epub", "pdf"] as const;
export type Format = (typeof FORMATS)[number];

export const MEDIA_TYPES: Record<Format, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  pdf: "application/pdf",
};

export const isFormat = (s: unknown): s is Format => FORMATS.includes(s as Format);

export interface Rendered {
  bytes: Uint8Array;
  /** Characters the PDF's type has no letter for (other formats: none). */
  missing: string[];
}

/** The book in one format. */
export async function render(book: Book, format: Format, { date, fonts }: { date: Date; fonts?: PdfFonts }): Promise<Rendered> {
  if (format === "docx") return { bytes: toDocx(book, { date }), missing: [] };
  if (format === "epub") return { bytes: toEpub(book, { date }), missing: [] };
  const { pdf, missing } = await toPdf(book, { date, ...(fonts ? { fonts } : {}) });
  return { bytes: pdf, missing };
}

/** "the-bridge-at-varn.docx"; for some of its `total` chapters "the-bridge-at-varn-chapters-1-2.docx", or "…-chapter-3.docx". */
export function fileName(book: Book, total: number, format: Format): string {
  const whole = book.chapters.length === total || !book.chapters.length;
  const [first, last] = [book.chapters[0]?.number, book.chapters.at(-1)?.number];
  const range = whole ? "" : first === last ? `-chapter-${first}` : `-chapters-${first}-${last}`;
  return `${slugify(book.title) || "novel"}${range}.${format}`;
}

/**
 * The files' date: when the novel was last committed, if everything in it is (so a commit compiles to
 * the same bytes anywhere); otherwise now.
 */
export async function commitDate(root: string): Promise<Date> {
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
  const dirty = await git("status", "--porcelain", "--", ".").catch(() => "not a repository");
  const when = dirty ? "" : await git("log", "-1", "--format=%cI").catch(() => "");
  return when ? new Date(when) : new Date();
}
