import type { Nodes, PhrasingContent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import type { Novel } from "./model.ts";
import { parseMarkdown } from "./parse.ts";
import type { FileSource } from "./source.ts";
import type { CompilePreset } from "./types.ts";
import { countWords } from "./words.ts";

/*
 * Compiling the manuscript (#19, D6): the scenes in reading order, as a book every output format
 * (DOCX, EPUB, PDF) renders the same way. Only the story's words come through: a mention is its words,
 * a link its text; front matter, hidden notes (HTML comments) and other markup stay behind.
 */

/** A stretch of text in one style. `text` may hold "\n" for a line break within a paragraph. */
export interface Run {
  text: string;
  em?: boolean;
  strong?: boolean;
}

export type Block =
  | { kind: "paragraph"; runs: Run[]; quote?: boolean }
  /** A break between scenes, or one written within a scene: the preset's marker. */
  | { kind: "break" };

export interface BookChapter {
  id: string;
  /** Its number in the whole book (a range keeps the numbers), and its heading as the preset has it. */
  number: number;
  heading: string;
  /** The part it opens, when it's the first chapter of one. */
  part?: { id: string; title: string; number: number };
  blocks: Block[];
}

/** Front or back matter: a page with a title (its first heading) and its text. */
export interface BookSection {
  title: string;
  blocks: Block[];
}

export interface Book {
  /** The novel's ID: e-books' identifier. */
  id: string;
  title: string;
  author: string;
  language: string;
  titlePage: {
    contact: string[];
    /** As the title page shows it ("about 82,000 words"), or undefined for none. */
    wordCount: string | undefined;
  };
  /** The running header: Surname / SHORT TITLE / page. */
  header: { surname: string; shortTitle: string };
  sceneBreak: string;
  front: BookSection[];
  chapters: BookChapter[];
  back: BookSection[];
  /** Words in the chapters compiled (exact). */
  words: number;
}

export interface CompileOptions {
  /** A preset in compile.yaml; default: the first there, or gh-writer's own. */
  preset?: string;
  /** The chapters to compile, by ID, inclusive; default the whole book. */
  from?: string;
  to?: string;
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

/** The presets to choose from: compile.yaml's, or gh-writer's own "manuscript". */
export function presets(novel: Novel): Record<string, CompilePreset> {
  return novel.compile?.presets ?? { manuscript: {} };
}

/** Compile the novel (or chapters `from`…`to`) with a preset into a book. Reads front and back matter through `source`. */
export async function compileBook(novel: Novel, source: Pick<FileSource, "read">, options: CompileOptions = {}): Promise<Book> {
  const all = presets(novel);
  const name = options.preset ?? Object.keys(all)[0]!;
  const preset = all[name];
  if (!preset) throw new CompileError(`There's no preset “${name}” in compile.yaml.`);
  const title = novel.config?.title ?? "Untitled";
  const author = preset.title_page?.author ?? novel.config?.author ?? "";

  const chapters = novel.chapters;
  const first = options.from ? chapters.findIndex((c) => c.id === options.from) : 0;
  const last = options.to ? chapters.findIndex((c) => c.id === options.to) : chapters.length - 1;
  if (first < 0 || last < 0) throw new CompileError("The range names a chapter that isn't in the book.");
  if (first > last) throw new CompileError("The range ends before it starts.");

  const byId = new Map(novel.allScenes.map((s) => [s.id, s]));
  const parts = new Map(novel.parts.map((p, i) => [p.id, { ...p, number: i + 1 }]));
  const chapterOut: BookChapter[] = [];
  let words = 0;
  for (let i = first; i <= last; i++) {
    const chapter = chapters[i]!;
    const blocks: Block[] = [];
    for (const sceneId of chapter.sceneIds) {
      const scene = byId.get(sceneId);
      if (!scene) continue;
      const body = prose(scene.body);
      if (!body.length) continue;
      // Scenes are set apart by the break; a scene's own break that starts or ends it would double it.
      if (blocks.length) blocks.push({ kind: "break" });
      blocks.push(...trimBreaks(body));
      words += countWords(scene.body);
    }
    const part = chapter.partId ? parts.get(chapter.partId) : undefined;
    const opensPart = part && part.chapterIds[0] === chapter.id;
    chapterOut.push({
      id: chapter.id,
      number: i + 1,
      heading: heading(preset, i + 1, chapter.title),
      ...(opensPart ? { part: { id: part.id, title: part.title, number: part.number } } : {}),
      blocks,
    });
  }

  const matter = async (paths: string[] | undefined) => {
    const out: BookSection[] = [];
    for (const path of paths ?? []) {
      const text = await source.read(path);
      if (text === undefined) throw new CompileError(`The preset names ${path}, which is missing.`);
      out.push(section(text, path));
    }
    return out;
  };

  const surname = preset.title_page?.surname ?? (author.trim().split(/\s+/).at(-1) || "Anonymous");
  const shortTitle = (preset.title_page?.short_title ?? shortOf(title)).toUpperCase();
  return {
    id: novel.config?.id ?? "",
    title,
    author,
    language: novel.config?.language ?? "en",
    titlePage: { contact: preset.title_page?.contact ?? (author ? [author] : []), wordCount: wordCount(preset, words) },
    header: { surname, shortTitle },
    sceneBreak: preset.scene_break ?? "#",
    front: await matter(preset.front),
    chapters: chapterOut,
    back: await matter(preset.back),
    words,
  };
}

/** "Chapter Four: The Flood", "Chapter Four" or "The Flood", as the preset asks (a chapter without a title: its number). */
function heading(preset: CompilePreset, n: number, title: string | undefined): string {
  const number = `Chapter ${numberWords(n)}`;
  const style = preset.chapter_heading ?? "number-and-title";
  if (style === "number" || !title) return number;
  if (style === "title") return title;
  return `${number}: ${title}`;
}

/** The title page's word count: manuscript format rounds it (to hundreds under 10,000 words, thousands above). */
function wordCount(preset: CompilePreset, words: number): string | undefined {
  const style = preset.word_count ?? "rounded";
  if (style === "none") return undefined;
  const format = (n: number) => n.toLocaleString("en-US");
  if (style === "exact") return `${format(words)} words`;
  const step = words < 10_000 ? 100 : 1000;
  return `about ${format(Math.max(step, Math.round(words / step) * step))} words`;
}

/** A short title for the running header: the title's first three words without a leading article. */
function shortOf(title: string): string {
  const words = title.replace(/^(the|a|an)\s+/i, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ") || title;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** A number in words, as chapter headings write it: 1 → "One", 42 → "Forty-Two", 101 → "One Hundred One". */
export function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  return String(n);
}

/** A front- or back-matter file: its first heading is its title, the rest its text. */
function section(text: string, path: string): BookSection {
  // Front matter of its own, if it has any, isn't part of the page.
  const body = /^---\r?\n/.test(text) ? parseMarkdown(text, path).body : text;
  const tree = mdast(body);
  const first = tree.children.findIndex((n) => n.type === "heading");
  const titleNode = first >= 0 ? tree.children[first] : undefined;
  const title = titleNode ? toString(titleNode).trim() : (path.split("/").at(-1) ?? path).replace(/\.md$/, "").replace(/[-_]+/g, " ");
  return { title, blocks: trimBreaks(tree.children.filter((_, i) => i !== first).flatMap((n) => blocks(n, false))) };
}

/** A scene body's blocks. */
function prose(markdown: string): Block[] {
  return mdast(markdown).children.flatMap((n) => blocks(n, false));
}

function mdast(markdown: string): Root {
  return fromMarkdown(markdown.replace(/\r\n?/g, "\n"), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Breaks at the start or end, or two together, said once or not at all. */
function trimBreaks(list: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of list) {
    if (b.kind === "break" && (!out.length || out.at(-1)!.kind === "break")) continue;
    out.push(b);
  }
  while (out.at(-1)?.kind === "break") out.pop();
  return out;
}

function blocks(node: Nodes, quote: boolean): Block[] {
  switch (node.type) {
    case "paragraph": {
      const runs = merge(inline(node.children, {}));
      return runs.length ? [{ kind: "paragraph", runs, ...(quote ? { quote: true } : {}) }] : [];
    }
    case "blockquote":
      return node.children.flatMap((c) => blocks(c, true));
    case "thematicBreak":
      return [{ kind: "break" }];
    case "html":
      // Hidden notes (<!-- … -->) and other raw HTML aren't the story.
      return [];
    case "list":
      return node.children.flatMap((item) => item.children.flatMap((c) => blocks(c, quote)));
    case "heading":
    case "code":
    case "table": {
      const text = toString(node).trim();
      return text ? [{ kind: "paragraph", runs: [{ text }], ...(quote ? { quote: true } : {}) }] : [];
    }
    default:
      return "children" in node ? (node.children as Nodes[]).flatMap((c) => blocks(c, quote)) : [];
  }
}

/** Soft line breaks (hard-wrapped prose) read as spaces, as in the editor. */
const unwrap = (text: string) => text.replace(/[ \t]*\n[ \t]*/g, " ");

function inline(nodes: PhrasingContent[], style: { em?: boolean; strong?: boolean }): Run[] {
  const out: Run[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out.push({ text: unwrap(n.value), ...style });
        break;
      case "emphasis":
        out.push(...inline(n.children, { ...style, em: true }));
        break;
      case "strong":
        out.push(...inline(n.children, { ...style, strong: true }));
        break;
      case "break":
        out.push({ text: "\n", ...style });
        break;
      case "link":
      case "linkReference":
      case "delete":
        // A mention ([Ada](#char_…)) or a link: its words.
        out.push(...inline(n.children, style));
        break;
      case "inlineCode":
        out.push({ text: n.value, ...style });
        break;
      case "html":
        break;
      default:
        if ("children" in n) out.push(...inline(n.children as PhrasingContent[], style));
        else if ("value" in n && typeof n.value === "string") out.push({ text: n.value, ...style });
    }
  }
  return out;
}

/** Neighbouring runs in the same style as one; empty ones gone; the paragraph's ends trimmed. */
function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && !!last.em === !!r.em && !!last.strong === !!r.strong) last.text += r.text;
    else out.push({ text: r.text, ...(r.em ? { em: true } : {}), ...(r.strong ? { strong: true } : {}) });
  }
  if (out.length) {
    out[0]!.text = out[0]!.text.replace(/^\s+/, "");
    out[out.length - 1]!.text = out.at(-1)!.text.replace(/\s+$/, "");
  }
  return out.filter((r) => r.text);
}
