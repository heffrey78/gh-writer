import { bookImages, numberWords, type Align, type Block, type Book, type Run } from "@gh-writer/core";
import type { CoverImage } from "./cover.ts";
import { isoSeconds, xml } from "./xml.ts";
import { zip, type ZipEntry } from "./zip.ts";

/*
 * The book as an EPUB 3 e-book: its cover (if it has one), a title page, front matter, a page for each part, a file per
 * chapter, back matter, a navigation document (the table of contents, chapters under their parts)
 * and a small stylesheet. Metadata from novel.yaml; its identifier the novel's ID, so editions of
 * one novel are known as one book.
 */

export interface EpubOptions {
  /** dcterms:modified (and the zip's dates): the commit's, so the same commit gives the same file. */
  date?: Date;
  /** The book's cover: the first page, and the image reading systems show for the book. */
  cover?: CoverImage;
  /** The pictures in the text, by repository path (readPictures). */
  pictures?: Map<string, CoverImage>;
}

/** A picture in the e-book: where it is in it, and its bytes. */
interface PictureFile {
  id: string;
  href: string;
  type: string;
  bytes: Uint8Array;
}

interface Page {
  id: string;
  file: string;
  title: string;
  body: string;
  /** For the table of contents: a part's chapters go under it. */
  level: 0 | 1;
  /** Shown in the table of contents. */
  toc: boolean;
}

export function toEpub(book: Book, { date = new Date(0), cover, pictures = new Map() }: EpubOptions = {}): Uint8Array {
  const pages: Page[] = [];
  // The text's pictures under pictures/ (the cover is images/cover.*): images/maps/varn.jpg is pictures/maps/varn.jpg.
  const files = new Map<string, PictureFile>();
  for (const path of bookImages(book)) {
    const image = pictures.get(path);
    if (!image) continue;
    const href = `pictures/${path.slice("images/".length).split("/").map(encodeURIComponent).join("/")}`;
    files.set(path, { id: `picture-${files.size + 1}`, href, type: image.type, bytes: image.bytes });
  }
  const blocks = (list: Block[]) => xhtmlBlocks(list, book.sceneBreak, files);
  const add = (page: Omit<Page, "file">) => pages.push({ ...page, file: `${page.id}.xhtml` });

  const image = cover && { href: `images/cover.${cover.type === "image/png" ? "png" : "jpg"}`, type: cover.type };
  if (image) {
    add({ id: "cover", title: "Cover", toc: false, level: 0, body: `<section epub:type="cover" class="cover"><img src="${image.href}" alt="${xml(`The cover of ${book.title}`)}"/></section>` });
  }

  add({
    id: "title",
    title: book.title,
    toc: false,
    level: 0,
    body: `<section epub:type="titlepage" class="titlepage"><h1>${xml(book.title)}</h1>${book.author ? `<p class="author">${xml(book.author)}</p>` : ""}</section>`,
  });
  book.front.forEach((s, i) => add({ id: `front-${i + 1}`, title: s.title, toc: true, level: 0, body: `<section epub:type="frontmatter"><h2>${xml(s.title)}</h2>${blocks(s.blocks)}</section>` }));
  let inPart = false;
  for (const chapter of book.chapters) {
    if (chapter.part) {
      inPart = true;
      const name = `Part ${numberWords(chapter.part.number)}`;
      add({ id: `part-${chapter.part.number}`, title: chapter.part.title ? `${name}: ${chapter.part.title}` : name, toc: true, level: 0, body: `<section epub:type="part" class="part"><h1>${xml(name)}</h1>${chapter.part.title ? `<p class="part-title">${xml(chapter.part.title)}</p>` : ""}</section>` });
    }
    add({ id: `chapter-${String(chapter.number).padStart(3, "0")}`, title: chapter.heading, toc: true, level: inPart ? 1 : 0, body: `<section epub:type="chapter"><h2>${xml(chapter.heading)}</h2>${blocks(chapter.blocks)}</section>` });
  }
  book.back.forEach((s, i) => add({ id: `back-${i + 1}`, title: s.title, toc: true, level: 0, body: `<section epub:type="backmatter"><h2>${xml(s.title)}</h2>${blocks(s.blocks)}</section>` }));

  const lang = xml(book.language);
  const page = (title: string, body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"><head><meta charset="UTF-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;

  const entries: ZipEntry[] = [
    { path: "mimetype", data: "application/epub+zip", store: true },
    { path: "META-INF/container.xml", data: container },
    { path: "OEBPS/content.opf", data: opf(book, pages, date, image, [...files.values()]) },
    { path: "OEBPS/nav.xhtml", data: page("Contents", nav(pages)) },
    { path: "OEBPS/style.css", data: css },
    // Already compressed: stored as it is.
    ...(cover && image ? [{ path: `OEBPS/${image.href}`, data: cover.bytes, store: true }] : []),
    ...[...files.values()].map((f) => ({ path: `OEBPS/${decodeURI(f.href)}`, data: f.bytes, store: true })),
    ...pages.map((p) => ({ path: `OEBPS/${p.file}`, data: page(p.title, p.body) })),
  ];
  return zip(entries, date);
}

/** Blocks as XHTML: quoted paragraphs and lists together in one blockquote, breaks as the preset's marker. */
function xhtmlBlocks(list: Block[], sceneBreak: string, pictures: Map<string, PictureFile>): string {
  let out = "";
  let quote = false;
  for (const b of list) {
    const q = (b.kind === "paragraph" || b.kind === "list") && !!b.quote;
    if (q !== quote) {
      out += q ? "<blockquote>" : "</blockquote>";
      quote = q;
    }
    out += xhtmlBlock(b, sceneBreak, pictures);
  }
  return quote ? `${out}</blockquote>` : out;
}

const alignClass = (a: Align) => (a ? ` class="align-${a}"` : "");

function xhtmlBlock(b: Block, sceneBreak: string, pictures: Map<string, PictureFile>): string {
  switch (b.kind) {
    case "paragraph":
      return `<p>${runs(b.runs)}</p>`;
    case "break":
      return `<p class="scene-break" role="separator" aria-label="Scene break">${xml(sceneBreak)}</p>`;
    case "heading":
      // Beneath the chapter's h2: a scene's # is h3.
      return `<h${b.level + 2} class="scene-heading">${runs(b.runs)}</h${b.level + 2}>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      return `<${tag}${start}>${b.items.map((item) => `<li>${item.map((x) => xhtmlBlock(x, sceneBreak, pictures)).join("")}</li>`).join("")}</${tag}>`;
    }
    case "table": {
      const head = b.header.map((cell, i) => `<th scope="col"${alignClass(b.align[i] ?? null)}>${runs(cell)}</th>`).join("");
      const body = b.rows.map((row) => `<tr>${b.header.map((_, i) => `<td${alignClass(b.align[i] ?? null)}>${runs(row[i] ?? [])}</td>`).join("")}</tr>`).join("");
      return `<table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table>`;
    }
    case "image": {
      const file = pictures.get(b.path);
      const caption = b.caption ? `<figcaption>${xml(b.caption)}</figcaption>` : "";
      // Without its file, the caption still says what was there.
      if (!file) return b.caption ? `<p class="caption">${xml(b.caption)}</p>` : "";
      return `<figure><img src="${file.href}" alt="${xml(b.alt)}"/>${caption}</figure>`;
    }
  }
}

function runs(list: Run[]): string {
  return list
    .map((r) => {
      let html = r.text.split("\n").map(xml).join("<br/>");
      if (r.em) html = `<em>${html}</em>`;
      if (r.strong) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

function nav(pages: Page[]): string {
  const items: string[] = [];
  let open = false;
  for (const p of pages.filter((x) => x.toc)) {
    if (p.level === 1 && !open) {
      // Chapters under the part just listed: reopen its item to hold them.
      items[items.length - 1] = items.at(-1)!.replace(/<\/li>$/, "<ol>");
      open = true;
    } else if (p.level === 0 && open) {
      items.push("</ol></li>");
      open = false;
    }
    items.push(`<li><a href="${p.file}">${xml(p.title)}</a></li>`);
  }
  if (open) items.push("</ol></li>");
  // A contents list can't be empty: with nothing else, the title page.
  const titlePage = pages.find((p) => p.id === "title");
  if (!items.length && titlePage) items.push(`<li><a href="${titlePage.file}">${xml(titlePage.title)}</a></li>`);
  const toc = `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${items.join("")}</ol></nav>`;
  // Where the book starts: reading systems open a book with a cover there, and offer a way to it.
  const cover = pages.find((p) => p.id === "cover");
  const start = pages.find((p) => p.toc) ?? titlePage;
  const landmarks = cover && start ? `<nav epub:type="landmarks" id="landmarks" hidden=""><h2>Landmarks</h2><ol><li><a epub:type="cover" href="${cover.file}">Cover</a></li><li><a epub:type="bodymatter" href="${start.file}">Start</a></li></ol></nav>` : "";
  return toc + landmarks;
}

function opf(book: Book, pages: Page[], date: Date, image: { href: string; type: string } | undefined, pictures: PictureFile[]): string {
  const id = book.id ? `urn:gh-writer:${book.id}` : `urn:gh-writer:${xml(book.title)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${xml(book.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${xml(id)}</dc:identifier><dc:title>${xml(book.title)}</dc:title>${book.author ? `<dc:creator>${xml(book.author)}</dc:creator>` : ""}<dc:language>${xml(book.language)}</dc:language><meta property="dcterms:modified">${isoSeconds(date)}</meta>${image ? '<meta name="cover" content="cover-image"/>' : ""}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>${image ? `<item id="cover-image" href="${image.href}" media-type="${image.type}" properties="cover-image"/>` : ""}${pictures.map((p) => `<item id="${p.id}" href="${p.href}" media-type="${p.type}"/>`).join("")}${pages.map((p) => `<item id="${p.id}" href="${p.file}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${pages.map((p) => `<itemref idref="${p.id}"/>`).join("")}</spine></package>`;
}

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const css = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1, h2 { text-align: center; font-weight: normal; margin: 3em 0 1.5em; page-break-before: always; }
p { margin: 0; text-indent: 1.5em; }
h1 + p, h2 + p, .scene-break + p, blockquote + p { text-indent: 0; }
.scene-break { text-align: center; text-indent: 0; margin: 1em 0; }
blockquote { margin: 1em 2em; font-style: italic; }
blockquote em { font-style: normal; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage h1 { font-size: 2em; margin: 0 0 1em; page-break-before: auto; }
.author, .part-title { text-align: center; text-indent: 0; }
.part { text-align: center; margin-top: 30%; }
.cover { margin: 0; padding: 0; text-align: center; }
.cover img { max-width: 100%; max-height: 100%; }
.scene-heading { font-weight: bold; text-indent: 0; margin: 1.5em 0 0.5em; }
h3.scene-heading { text-align: center; }
h5.scene-heading { font-weight: normal; font-style: italic; }
.scene-heading + p, ul + p, ol + p, table + p, figure + p, .caption + p { text-indent: 0; }
ul, ol { margin: 0.5em 0; padding-left: 2em; }
li p { text-indent: 0; }
table { border-collapse: collapse; margin: 1em auto; }
th, td { border: 1px solid #888; padding: 0.2em 0.6em; vertical-align: top; text-align: left; }
th { font-weight: bold; }
.align-left { text-align: left; }
.align-center { text-align: center; }
.align-right { text-align: right; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; }
figcaption, .caption { font-style: italic; font-size: 0.9em; text-align: center; text-indent: 0; }
`;
