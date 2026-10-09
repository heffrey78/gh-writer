import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { compileBook, CompileError, loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { commitDate, fileName, FORMATS, isFormat, render, type Format, type PdfFonts } from "@gh-writer/export";

export interface CompileOptions {
  /** Comma-separated: docx, epub, pdf (default all three). */
  format?: string;
  preset?: string;
  /** Chapter IDs, inclusive; default the whole book. */
  from?: string;
  to?: string;
  /** Where the files go (default: compiled/ in the novel, which ignores itself in git). */
  out?: string;
  /** The PDF's type (default: gh-writer's own Liberation Serif). */
  fonts?: PdfFonts;
}

/**
 * Compile the novel in `dir` to files, as the app does: the same commit gives the same bytes. Says
 * which files it wrote, and any characters the PDF's type lacks. Returns the process exit code.
 */
export async function runCompile(dir: string, options: CompileOptions = {}, out: (s: string) => void = console.log): Promise<number> {
  const root = resolve(dir);
  const formats = (options.format ?? FORMATS.join(",")).split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
  const bad = formats.filter((f) => !isFormat(f));
  if (bad.length || !formats.length) {
    out(`--format takes docx, epub and pdf, comma-separated${bad.length ? `, not "${bad.join(", ")}"` : ""}.`);
    return 1;
  }
  const source = nodeSource(root);
  const novel = await loadNovel(source);
  if (!novel.config) {
    out(`No novel here: ${root} has no novel.yaml.`);
    return 1;
  }
  let book;
  try {
    book = await compileBook(novel, source, { ...(options.preset ? { preset: options.preset } : {}), ...(options.from ? { from: options.from } : {}), ...(options.to ? { to: options.to } : {}) });
  } catch (e) {
    if (e instanceof CompileError) {
      out(e.message);
      return 1;
    }
    throw e;
  }
  // Taken before anything is written: the files written mustn't make the novel look changed.
  const date = await commitDate(root);
  const target = options.out ? resolve(options.out) : join(root, "compiled");
  await mkdir(target, { recursive: true });
  if (!options.out) await writeFile(join(target, ".gitignore"), "# Compiled files: made by `gh-writer compile`, not kept in git.\n*\n");
  const written: string[] = [];
  const missing = new Set<string>();
  for (const format of new Set(formats as Format[])) {
    const rendered = await render(book, format, { date, ...(options.fonts ? { fonts: options.fonts } : {}) });
    const path = join(target, fileName(book, novel.chapters.length, format));
    await writeFile(path, rendered.bytes);
    written.push(relative(process.cwd(), path) || path);
    rendered.missing.forEach((c) => missing.add(c));
  }
  out(`Compiled ${book.chapters.length} chapter${book.chapters.length === 1 ? "" : "s"} (${book.words.toLocaleString("en-US")} words): ${written.join(", ")}`);
  if (missing.size) out(`The PDF's type has no letter for ${[...missing].join(" ")}: it shows boxes there.`);
  return 0;
}
