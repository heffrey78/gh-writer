// Compile the sample novel to every format, for checks that need real files (epubcheck in CI),
// with a cover from the export tests' fixtures, and a heading, lists, a table and a picture in its
// first chapter (D10), so the check covers them too.
// Usage: node scripts/compile-sample.ts [outdir]   (default dist/sample)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileBook, loadNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { coverImage, toDocx, toEpub, toPdf } from "@gh-writer/export";

const out = process.argv[2] ?? "dist/sample";
const source = nodeSource(new URL("../examples/sample-novel/", import.meta.url).pathname);
const book = await compileBook(await loadNovel(source), source);
const date = new Date("2026-01-01T00:00:00Z");
const cover = coverImage(readFileSync(new URL("../packages/export/test/fixtures/cover.jpg", import.meta.url)))!;
book.chapters[0]!.blocks.push(
  { kind: "heading", level: 1, runs: [{ text: "A letter" }] },
  { kind: "list", ordered: true, start: 3, items: [[{ kind: "paragraph", runs: [{ text: "Sell the " }, { text: "workshop", em: true }] }, { kind: "list", ordered: false, start: 1, items: [[{ kind: "paragraph", runs: [{ text: "the rent" }] }]] }]] },
  { kind: "table", align: ["left", "right"], header: [[{ text: "Day" }], [{ text: "Miles" }]], rows: [[[{ text: "Monday" }], [{ text: "12" }]]] },
  { kind: "image", path: "images/map.jpg", alt: "A map of Varn", caption: "The valley" },
);
const pictures = new Map([["images/map.jpg", cover]]);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "the-bridge-at-varn.docx"), toDocx(book, { date, pictures }));
writeFileSync(join(out, "the-bridge-at-varn.epub"), toEpub(book, { date, cover, pictures }));
const { pdf, missing } = await toPdf(book, { date, cover, pictures });
writeFileSync(join(out, "the-bridge-at-varn.pdf"), pdf);
if (missing.length) console.warn(`The PDF's type has no letter for: ${missing.join(" ")}`);
console.log(`Compiled ${book.chapters.length} chapters (${book.words} words) to ${out}`);
