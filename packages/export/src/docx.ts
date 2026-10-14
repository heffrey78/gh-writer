import { bookImages, numberWords, type Align, type Block, type Book, type Run } from "@gh-writer/core";
import type { CoverImage } from "./cover.ts";
import { isoSeconds, xml } from "./xml.ts";
import { zip } from "./zip.ts";

/*
 * The book as a Word document in standard manuscript format (the conventions agents and editors ask
 * for): Letter pages with 1-inch margins; Times New Roman 12 pt, double-spaced, first lines indented
 * half an inch, no space between paragraphs; a title page with the contact details top left, the word
 * count top right and the title and byline centred, without a header; from page 2 a running header,
 * right-aligned: Surname / SHORT TITLE / page; each chapter on a new page with its heading a third
 * of the way down; scene breaks as the preset's marker, centred; "THE END" after the last chapter.
 */

export interface DocxOptions {
  /** The document's dates (and the zip's): the commit's, so the same commit gives the same file. */
  date?: Date;
  /** The pictures in the text, by repository path (readPictures). */
  pictures?: Map<string, CoverImage>;
}

/** What the text's blocks need beyond the document itself: list numbering and embedded pictures. */
interface Parts {
  /** Each list, numbered on its own: bullets or decimals, and where a numbered one starts. */
  lists: { ordered: boolean; start: number }[];
  /** The pictures embedded, in order: their file in word/media and its relationship. */
  media: { path: string; file: string; rel: string; image: CoverImage }[];
  pictures: Map<string, CoverImage>;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
/** Twips: 1440 to the inch. */
const INCH = 1440;
const PAGE = { width: 12240, height: 15840 };
const TEXT_WIDTH = PAGE.width - 2 * INCH;

export function toDocx(book: Book, { date = new Date(0), pictures = new Map() }: DocxOptions = {}): Uint8Array {
  const body: string[] = [];
  const parts: Parts = { lists: [], media: [], pictures };
  // Pictures embedded in the order they're first shown, each once.
  for (const path of bookImages(book)) {
    const image = pictures.get(path);
    if (!image) continue;
    const n = parts.media.length + 1;
    parts.media.push({ path, file: `media/picture${n}.${image.type === "image/png" ? "png" : "jpg"}`, rel: `rIdPicture${n}`, image });
  }
  const blocks = (list: Block[], sceneBreak: string) => docxBlocks(list, sceneBreak, parts, 0);
  const pageBreak = () => body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');

  // Title page.
  const [firstContact = "", ...contact] = book.titlePage.contact;
  body.push(p("Contact", [...runs([{ text: firstContact }]), ...(book.titlePage.wordCount ? ["<w:r><w:tab/></w:r>", ...runs([{ text: book.titlePage.wordCount }])] : [])], `<w:tabs><w:tab w:val="right" w:pos="${TEXT_WIDTH}"/></w:tabs>`));
  for (const line of contact) body.push(p("Contact", runs([{ text: line }])));
  body.push(p("Title", runs([{ text: book.title }])));
  if (book.author) body.push(p("Byline", runs([{ text: `by ${book.author}` }])));

  for (const section of book.front) {
    pageBreak();
    body.push(p("Heading2", runs([{ text: section.title }])));
    body.push(...blocks(section.blocks, book.sceneBreak));
  }
  for (const chapter of book.chapters) {
    if (chapter.part) {
      pageBreak();
      body.push(p("PartHeading", runs([{ text: `Part ${numberWords(chapter.part.number)}` }])));
      if (chapter.part.title) body.push(p("PartTitle", runs([{ text: chapter.part.title }])));
    }
    pageBreak();
    body.push(p("Heading1", runs([{ text: chapter.heading }])));
    body.push(...blocks(chapter.blocks, book.sceneBreak));
  }
  if (book.chapters.length) body.push(p("TheEnd", runs([{ text: "THE END" }])));
  for (const section of book.back) {
    pageBreak();
    body.push(p("Heading2", runs([{ text: section.title }])));
    body.push(...blocks(section.blocks, book.sceneBreak));
  }

  const sectPr = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:headerReference w:type="first" r:id="rIdHeaderFirst"/><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"/><w:pgMar w:top="${INCH}" w:right="${INCH}" w:bottom="${INCH}" w:left="${INCH}" w:header="${INCH / 2}" w:footer="${INCH / 2}" w:gutter="0"/><w:titlePg/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body.join("")}${sectPr}</w:body></w:document>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>${runs([{ text: `${book.header.surname} / ${book.header.shortTitle} / ` }]).join("")}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:hdr>`;
  const headerFirst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr></w:p></w:hdr>`;

  return zip(
    [
      { path: "[Content_Types].xml", data: contentTypes },
      { path: "_rels/.rels", data: packageRels },
      { path: "docProps/core.xml", data: core(book, date) },
      { path: "docProps/app.xml", data: app },
      { path: "word/document.xml", data: document },
      { path: "word/styles.xml", data: styles(book.language) },
      { path: "word/settings.xml", data: settings(book.language) },
      { path: "word/header1.xml", data: header },
      { path: "word/header2.xml", data: headerFirst },
      { path: "word/numbering.xml", data: numbering(parts.lists) },
      { path: "word/_rels/document.xml.rels", data: documentRels(parts.media) },
      // Already compressed: stored as they are.
      ...parts.media.map((m) => ({ path: `word/${m.file}`, data: m.image.bytes, store: true })),
    ],
    date,
  );
}

/** EMUs (DrawingML's unit): 914,400 to the inch. */
const EMU = 914400;
/** A picture's largest size on the page: the text's width, and most of its height. */
const PICTURE_MAX = { width: 6.5 * EMU, height: 7 * EMU };

/** The text's blocks as WordprocessingML. `depth`: how far into lists, for their paragraphs' numbering and indents. */
function docxBlocks(list: Block[], sceneBreak: string, parts: Parts, depth: number): string[] {
  return list.flatMap((b): string[] => {
    switch (b.kind) {
      case "paragraph":
        return [p(b.quote ? "Quote" : "Normal", runs(b.runs))];
      case "break":
        return [p("SceneBreak", runs([{ text: sceneBreak }]))];
      case "heading":
        return [p(`SceneHeading${b.level}`, runs(b.runs))];
      case "list": {
        parts.lists.push({ ordered: b.ordered, start: b.start });
        const numId = parts.lists.length;
        return b.items.flatMap((item) =>
          item.flatMap((x, i) => {
            // An item's first paragraph carries its bullet or number; what follows in it is indented to its text.
            if (x.kind === "paragraph" && i === 0) return [p("ListParagraph", runs(x.runs), `<w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${numId}"/></w:numPr>`)];
            if (x.kind === "paragraph") return [p("ListParagraph", runs(x.runs), `<w:ind w:left="${(depth + 1) * (INCH / 2)}" w:firstLine="0"/>`)];
            return docxBlocks([x], sceneBreak, parts, depth + 1);
          }),
        );
      }
      case "table":
        return [table(b.header, b.rows, b.align)];
      case "image": {
        const media = parts.media.find((m) => m.path === b.path);
        const caption = b.caption ? [p("Caption", runs([{ text: b.caption, em: true }]))] : [];
        return media ? [picture(media, parts.media.indexOf(media) + 1, b.alt), ...caption] : caption;
      }
    }
  });
}

/** A table: the header row repeated on each page, columns sharing the text's width, cells aligned as written. */
function table(header: Run[][], rows: Run[][][], align: Align[]): string {
  const width = Math.floor(TEXT_WIDTH / header.length);
  const jc = (i: number) => (align[i] ? `<w:jc w:val="${align[i]}"/>` : "");
  const cell = (content: Run[], i: number, bold: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p("TableText", runs(bold ? content.map((r) => ({ ...r, strong: true })) : content), jc(i))}</w:tc>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${width * header.length}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${header.map(() => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header.map((c, i) => cell(c, i, true)).join("")}</w:tr>` +
    rows.map((row) => `<w:tr>${header.map((_, i) => cell(row[i] ?? [], i, false)).join("")}</w:tr>`).join("") +
    "</w:tbl>"
  );
}

/** A picture in its own centred paragraph, as large as the page allows at its shape, described by its alt text. */
function picture(media: Parts["media"][number], n: number, alt: string): string {
  const { width, height } = media.image;
  const scale = Math.min(PICTURE_MAX.width / width, PICTURE_MAX.height / height);
  const [cx, cy] = [Math.round(width * scale), Math.round(height * scale)];
  const a = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const pic = "http://schemas.openxmlformats.org/drawingml/2006/picture";
  return (
    `<w:p><w:pPr><w:pStyle w:val="Picture"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="Picture ${n}" descr="${xml(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${a}"><a:graphicData uri="${pic}"><pic:pic xmlns:pic="${pic}"><pic:nvPicPr><pic:cNvPr id="${n}" name="${media.file.slice("media/".length)}" descr="${xml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${media.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

/** List numbering: bullets and decimals as two abstract definitions, nine levels deep; each list numbered from its own start. */
function numbering(lists: Parts["lists"]): string {
  const levels = (ordered: boolean) =>
    Array.from({ length: 9 }, (_, i) => {
      const left = (i + 1) * (INCH / 2);
      const format = ordered ? `<w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/>` : `<w:numFmt w:val="bullet"/><w:lvlText w:val="${["•", "◦", "▪"][i % 3]}"/>`;
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>${format}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="${INCH / 4}"/></w:pPr></w:lvl>`;
    }).join("");
  const abstract = (id: number, ordered: boolean) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="multilevel"/>${levels(ordered)}</w:abstractNum>`;
  // Each list its own instance, so its numbers restart; overrides at every level, as a list is numbered at its depth.
  const nums = lists.map((l, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${l.ordered ? 1 : 0}"/>${Array.from({ length: 9 }, (_, lvl) => `<w:lvlOverride w:ilvl="${lvl}"><w:startOverride w:val="${l.start}"/></w:lvlOverride>`).join("")}</w:num>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}>${abstract(0, false)}${abstract(1, true)}${nums.join("")}</w:numbering>`;
}

function p(style: string, content: string[], extraPPr = ""): string {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extraPPr}</w:pPr>${content.join("")}</w:p>`;
}

/** Runs as WordprocessingML: italic and bold as such, a "\n" in the text as a line break. */
function runs(list: Run[]): string[] {
  return list.map((r) => {
    const props = r.em || r.strong ? `<w:rPr>${r.strong ? "<w:b/>" : ""}${r.em ? "<w:i/>" : ""}</w:rPr>` : "";
    const parts = r.text.split("\n").map((t) => `<w:t xml:space="preserve">${xml(t)}</w:t>`);
    return `<w:r>${props}${parts.join("<w:br/>")}</w:r>`;
  });
}

function styles(language: string): string {
  const paragraph = (id: string, name: string, pPr: string, rPr = "", extra = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"${id === "Normal" ? ' w:default="1"' : ""}><w:name w:val="${name}"/>${id === "Normal" ? "" : '<w:basedOn w:val="Normal"/>'}${extra}<w:pPr>${pPr}</w:pPr>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`;
  const centred = '<w:ind w:firstLine="0"/><w:jc w:val="center"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${xml(language)}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[
    paragraph("Normal", "Normal", `<w:widowControl/><w:spacing w:after="0" w:line="480" w:lineRule="auto"/><w:ind w:firstLine="${INCH / 2}"/>`),
    paragraph("Contact", "Contact", '<w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/>'),
    paragraph("Title", "Title", `<w:spacing w:before="${INCH * 3}"/>${centred}`),
    paragraph("Byline", "Byline", centred),
    paragraph("Heading1", "heading 1", `<w:keepNext/><w:spacing w:before="${INCH * 2}" w:after="${240}"/>${centred}<w:outlineLvl w:val="0"/>`, "", '<w:next w:val="Normal"/><w:qFormat/>'),
    paragraph("Heading2", "heading 2", `<w:keepNext/><w:spacing w:before="${INCH * 2}" w:after="${240}"/>${centred}<w:outlineLvl w:val="1"/>`, "", '<w:next w:val="Normal"/><w:qFormat/>'),
    paragraph("PartHeading", "Part heading", `<w:keepNext/><w:spacing w:before="${INCH * 3}"/>${centred}<w:outlineLvl w:val="0"/>`),
    paragraph("PartTitle", "Part title", centred),
    paragraph("SceneBreak", "Scene break", `<w:keepNext/>${centred}`),
    paragraph("Quote", "Quote", `<w:ind w:left="${INCH / 2}" w:right="${INCH / 2}" w:firstLine="0"/>`),
    paragraph("SceneHeading1", "heading 3", `<w:keepNext/><w:spacing w:before="240"/>${centred}<w:outlineLvl w:val="2"/>`, "<w:b/>", '<w:next w:val="Normal"/><w:qFormat/>'),
    paragraph("SceneHeading2", "heading 4", '<w:keepNext/><w:spacing w:before="240"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="3"/>', "<w:b/>", '<w:next w:val="Normal"/><w:qFormat/>'),
    paragraph("SceneHeading3", "heading 5", '<w:keepNext/><w:ind w:firstLine="0"/><w:outlineLvl w:val="4"/>', "<w:i/>", '<w:next w:val="Normal"/><w:qFormat/>'),
    paragraph("ListParagraph", "List Paragraph", '<w:ind w:firstLine="0"/>'),
    paragraph("TableText", "Table text", '<w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/>'),
    paragraph("Picture", "Picture", `<w:keepNext/><w:spacing w:before="240" w:line="240" w:lineRule="auto"/>${centred}`),
    paragraph("Caption", "caption", `<w:spacing w:line="240" w:lineRule="auto"/>${centred}`),
    paragraph("TheEnd", "The end", `<w:spacing w:before="${INCH / 2}"/>${centred}`),
    paragraph("Header", "header", '<w:spacing w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="right"/>'),
  ].join("")}</w:styles>`;
}

const settings = (language: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings ${W}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:themeFontLang w:val="${xml(language)}"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const core = (book: Book, date: Date) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(book.title)}</dc:title><dc:creator>${xml(book.author)}</dc:creator><dc:language>${xml(book.language)}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${isoSeconds(date)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${isoSeconds(date)}</dcterms:modified></cp:coreProperties>`;

const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>gh-writer</Application></Properties>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const documentRels = (media: Parts["media"]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdHeaderFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>${media.map((m) => `<Relationship Id="${m.rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.file}"/>`).join("")}</Relationships>`;
