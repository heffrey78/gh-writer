import { numberWords, type Block, type Book, type Run } from "@gh-writer/core";
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
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** Twips: 1440 to the inch. */
const INCH = 1440;
const PAGE = { width: 12240, height: 15840 };
const TEXT_WIDTH = PAGE.width - 2 * INCH;

export function toDocx(book: Book, { date = new Date(0) }: DocxOptions = {}): Uint8Array {
  const body: string[] = [];
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
      { path: "word/_rels/document.xml.rels", data: documentRels },
    ],
    date,
  );
}

function blocks(list: Block[], sceneBreak: string): string[] {
  return list.map((b) => (b.kind === "break" ? p("SceneBreak", runs([{ text: sceneBreak }])) : p(b.quote ? "Quote" : "Normal", runs(b.runs))));
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
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdHeaderFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/></Relationships>`;
