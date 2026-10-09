// Compile the sample novel to every format, for checks that need real files (epubcheck in CI).
// Usage: node scripts/compile-sample.ts [outdir]   (default dist/sample)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileBook, loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { toDocx, toEpub } from "@gh-writer/export";

const out = process.argv[2] ?? "dist/sample";
const source = nodeSource(new URL("../examples/sample-novel/", import.meta.url).pathname);
const book = await compileBook(await loadNovel(source), source);
const date = new Date("2026-01-01T00:00:00Z");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "the-bridge-at-varn.docx"), toDocx(book, { date }));
writeFileSync(join(out, "the-bridge-at-varn.epub"), toEpub(book, { date }));
console.log(`Compiled ${book.chapters.length} chapters (${book.words} words) to ${out}`);
