import { ID_PATTERN, picturePath } from "@gh-writer/core";
import type { AlignType, BlockContent, List as MdList, ListItem, Nodes, PhrasingContent, Root, RootContent, TableCell, TableRow } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Handle, type Options } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { Fragment, type Attrs, type Mark, type Node, type NodeType, type Schema } from "@tiptap/pm/model";
import { proseSchema } from "./schema.ts";

/*
 * Scene prose <-> ProseMirror.
 *
 * Every top-level block keeps the exact Markdown it came from (`src`) and the whitespace before
 * it (`gap`). On save, a block whose content still matches its source is written back verbatim,
 * so an unedited scene round-trips byte for byte whatever syntax it used. Only edited or new
 * blocks are serialized, in canonical syntax: one paragraph per line, `*em*`, `**strong**`,
 * `***` section breaks, using the emphasis markers and break style of the block's source, else
 * of the scene's.
 *
 * Headings, lists, tables and pictures on a line of their own are modelled too (D10): edited, they're
 * written with `#` headings, `-` bullets, `1.` numbering, aligned `|` tables and `![alt](src "caption")`.
 *
 * Markdown the schema doesn't model is never dropped: unknown blocks become raw_block and
 * unknown inline syntax becomes raw_inline, both saved verbatim.
 */

const MENTION_URL = new RegExp(`^#(${ID_PATTERN.source.slice(1, -1)})$`);

function mdast(markdown: string): Root {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Thrown while converting a block the schema can't represent faithfully. */
class Unsupported extends Error {}

/**
 * Parse a scene body (the Markdown after the front matter) into a ProseMirror document, or into
 * another node holding the blocks and their file attributes, such as a scene in a chapter.
 */
export function parseProse(markdown: string, schema: Schema = proseSchema, type: NodeType = schema.nodes.doc!, attrs: Attrs = {}): Node {
  const tree = mdast(markdown);
  const blocks: Node[] = [];
  let pos = 0;
  for (const child of tree.children) {
    const { start, end } = offsets(child);
    const parsed = topBlock(child, markdown, schema);
    const node = parsed.type.create({ ...parsed.attrs, src: markdown.slice(start, end), gap: markdown.slice(pos, start) }, parsed.content);
    // Parsing in context is the authority: a block can read differently on its own (e.g. `-`).
    unchanged.set(node, true);
    if (!blocks.length) firstBlocks.add(node);
    blocks.push(node);
    pos = end;
  }
  if (!blocks.length) blocks.push(schema.nodes.paragraph!.create({ src: "", gap: "" }));
  return type.create({ ...attrs, trailing: markdown.slice(pos), eol: lineEnding(markdown), style: sourceStyle(tree, markdown) }, blocks);
}

/** Serialize a document (or scene) produced by parseProse, and possibly edited, back to Markdown. */
export function serializeProse(doc: Node): string {
  const eol = doc.attrs.eol === "\r\n" ? "\r\n" : "\n";
  let out = "";
  let prev: { text: string; reused: boolean } | null = null;
  doc.forEach((block) => {
    const reused = isUnchanged(block);
    if (!reused && isEmpty(block)) return;
    const text: string = reused ? block.attrs.src : withEol(canonicalBlock(block, doc.attrs.style, prev?.text), eol);
    out += separator(prev, out, block.attrs.gap, reused && (prev !== null || firstBlocks.has(block)), text, eol) + text;
    prev = { text, reused };
  });
  // Keep the file's ending after an unedited last block (even no final newline); otherwise end
  // with a newline, as a new scene or an edited last paragraph should.
  const trailing = doc.attrs.trailing;
  const valid = typeof trailing === "string" && /^\s*$/.test(trailing);
  if (!prev) return valid ? trailing : "";
  return out + (valid && ((prev as { reused: boolean }).reused || trailing.includes("\n")) ? trailing : eol);
}

// ---------------------------------------------------------------------------
// Markdown -> ProseMirror

function offsets(node: Nodes): { start: number; end: number } {
  return { start: node.position!.start.offset!, end: node.position!.end.offset! };
}

function lineEnding(markdown: string): "\n" | "\r\n" {
  const crlf = markdown.match(/\r\n/g)?.length ?? 0;
  const lf = (markdown.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** A top-level block, falling back to raw_block for anything the schema can't hold. */
function topBlock(node: RootContent, markdown: string, schema: Schema): Node {
  try {
    return block(node, markdown, schema, false);
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    const { start, end } = offsets(node);
    return rawBlock(markdown.slice(start, end), schema);
  }
}

function rawBlock(text: string, schema: Schema): Node {
  const value = text.replace(/\r\n/g, "\n");
  return schema.nodes.raw_block!.create(null, value ? schema.text(value) : null);
}

/**
 * A block from mdast. `nested`: inside a quote, list or table, where a raw slice spanning lines would
 * carry the container's prefixes or indentation; an unsupported child makes the whole top-level
 * block raw, so those stay intact.
 */
function block(node: Nodes, markdown: string, schema: Schema, nested: boolean): Node {
  switch (node.type) {
    case "paragraph": {
      const picture = pictureOf(node.children, schema);
      if (picture) return picture;
      return schema.nodes.paragraph!.create(null, inlines(node.children, [], markdown, schema, nested));
    }
    case "blockquote":
      if (!node.children.length) throw new Unsupported();
      return schema.nodes.blockquote!.create(null, node.children.map((c) => block(c, markdown, schema, true)));
    case "thematicBreak":
      return schema.nodes.horizontal_rule!.create();
    case "heading":
      // D10: levels 1-3; deeper read as 3 (an unedited #### keeps its source).
      return schema.nodes.heading!.create({ level: Math.min(node.depth, 3) }, inlines(node.children, [], markdown, schema, nested));
    case "list": {
      const items = node.children.map((item) => {
        // Task lists stay raw; an item must start with a paragraph (an empty `-` doesn't).
        if (item.checked !== null && item.checked !== undefined) throw new Unsupported();
        const children = item.children.map((c) => block(c, markdown, schema, true));
        // An item without words of its own (`-` alone, or `-` then a nested list) starts with an empty paragraph.
        if (!children.length || children[0]!.type.name.endsWith("_list")) children.unshift(schema.nodes.paragraph!.create());
        if (children[0]!.type.name !== "paragraph") throw new Unsupported();
        return schema.nodes.list_item!.create(null, children);
      });
      const tight = !node.spread && node.children.every((item) => !item.spread);
      return node.ordered
        ? schema.nodes.ordered_list!.create({ start: node.start ?? 1, tight }, items)
        : schema.nodes.bullet_list!.create({ tight }, items);
    }
    case "table": {
      const align = node.align ?? [];
      const rows = node.children.map((row, r) =>
        schema.nodes.table_row!.create(
          null,
          row.children.map((cell, c) => (r ? schema.nodes.table_cell! : schema.nodes.table_header!).create({ align: align[c] ?? null }, inlines(cell.children, [], markdown, schema, true))),
        ),
      );
      return schema.nodes.table!.create(null, rows);
    }
    default:
      throw new Unsupported();
  }
}

/** A paragraph that is only a picture under /images/ (D10), as a picture node; otherwise undefined. */
function pictureOf(children: PhrasingContent[], schema: Schema): Node | undefined {
  const content = children.filter((c) => !(c.type === "text" && !c.value.trim()));
  const image = content.length === 1 && content[0]!.type === "image" ? content[0]! : undefined;
  if (!image || !picturePath(image.url)) return undefined;
  return schema.nodes.picture!.create({ url: image.url, alt: image.alt ?? "", caption: image.title || null });
}

/** Soft line breaks (hard-wrapped prose) read as spaces, so an edited paragraph becomes one line. */
const unwrap = (text: string) => text.replace(/[ \t]*\r?\n[ \t]*/g, " ");

function inlines(nodes: PhrasingContent[], marks: readonly Mark[], markdown: string, schema: Schema, inContainer: boolean): Node[] {
  const out: Node[] = [];
  const nested = (children: PhrasingContent[], mark: Mark) =>
    out.push(...inlines(children, mark.addToSet(marks), markdown, schema, inContainer));
  for (const n of nodes) {
    switch (n.type) {
      case "text": {
        const value = unwrap(n.value);
        if (value) out.push(schema.text(value, marks));
        continue;
      }
      case "emphasis":
        nested(n.children, schema.marks.em!.create());
        continue;
      case "strong":
        nested(n.children, schema.marks.strong!.create());
        continue;
      case "break":
        out.push(schema.nodes.hard_break!.create(null, null, marks));
        continue;
      case "link": {
        const mention = MENTION_URL.exec(n.url);
        if (mention && !n.title && n.children.every((c) => c.type === "text")) {
          const label = unwrap(n.children.map((c) => (c as { value: string }).value).join(""));
          out.push(schema.nodes.mention!.create({ id: mention[1], label }, null, marks));
          continue;
        }
        if (n.children.length) {
          nested(n.children, schema.marks.link!.create({ href: n.url, title: n.title ?? null }));
          continue;
        }
        break; // An empty link has no text to carry the mark: keep it raw.
      }
    }
    const { start, end } = offsets(n);
    const text = markdown.slice(start, end);
    // Nested, a multi-line slice would include `>` prefixes or indentation; let the whole block go raw.
    if (inContainer && text.includes("\n")) throw new Unsupported();
    out.push(schema.nodes.raw_inline!.create({ text }, null, marks));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ProseMirror -> Markdown

const unchanged = new WeakMap<Node, boolean>();
/** Blocks that began their file: only their gap is leading whitespace worth keeping in first place. */
const firstBlocks = new WeakSet<Node>();

/**
 * Whether a block still matches the Markdown it was parsed from. ProseMirror reuses unchanged
 * nodes across edits, so blocks from parseProse are known by identity; others (e.g. a document
 * rebuilt from JSON) are checked by re-parsing their source.
 */
function isUnchanged(node: Node): boolean {
  let result = unchanged.get(node);
  if (result === undefined) {
    const src = node.attrs.src;
    const root = typeof src === "string" ? mdast(src) : undefined;
    const parsed = root?.children.length === 1 ? topBlock(root.children[0]!, src, node.type.schema) : undefined;
    result = !!parsed && parsed.type === node.type && sameAttrs(parsed, node) && parsed.content.eq(node.content);
    unchanged.set(node, result);
  }
  return result;
}

/** Whether two blocks' own attributes agree (a list's start or tightness, a heading's level), sources aside. */
function sameAttrs(a: Node, b: Node): boolean {
  return Object.keys(a.attrs).every((k) => k === "src" || k === "gap" || a.attrs[k] === b.attrs[k]);
}

/** A block with nothing to write. Markdown can't represent an empty paragraph. */
function isEmpty(node: Node): boolean {
  switch (node.type.name) {
    case "paragraph":
    case "heading":
      return trimInline(node).length === 0;
    case "blockquote":
    case "bullet_list":
    case "ordered_list":
    case "list_item": {
      let empty = true;
      node.forEach((child) => (empty &&= isEmpty(child)));
      return empty;
    }
    case "raw_block":
      return !/[^ \t\n]/.test(node.textContent);
    default:
      return false;
  }
}

/** The whitespace to put before a block, reusing the original gap where that is safe. */
function separator(prev: { text: string; reused: boolean } | null, before: string, gap: unknown, reused: boolean, text: string, eol: string): string {
  if (typeof gap !== "string" || !/^[ \t\r\n]*$/.test(gap)) return prev ? eol + eol : "";
  // Leading whitespace survives only on an untouched block that began the file.
  if (!prev) return reused ? gap : "";
  const blank = /\n[ \t\r]*\n/.test(gap);
  // Two untouched blocks may keep a gap without a blank line (e.g. `para\n***`) if they still parse apart,
  // in the context of everything before them: whether lines join can depend on blocks further back
  // (after an empty `>`, indented lines are separate code blocks; on their own, they're one).
  if (reused && prev.reused && gap.includes("\n") && (blank || mdast(before + gap + text).children.length === mdast(before).children.length + 1)) return gap;
  if (blank && gap.endsWith("\n")) return gap;
  return eol + eol;
}

function withEol(text: string, eol: string): string {
  return eol === "\n" ? text : text.replace(/\r?\n/g, eol);
}

export interface Style {
  emphasis?: "*" | "_";
  strong?: "*" | "_";
  /** Hard breaks as two trailing spaces rather than a backslash. */
  spaces?: boolean;
}

/** The emphasis markers and hard-break style a piece of Markdown uses first. */
function sourceStyle(tree: Nodes, markdown: string): Style {
  const style: Style = {};
  const visit = (n: Nodes) => {
    const ch = n.position ? markdown[n.position.start.offset!] : undefined;
    if (n.type === "break") style.spaces ??= ch !== "\\";
    else if ((n.type === "emphasis" || n.type === "strong") && (ch === "*" || ch === "_")) style[n.type] ??= ch;
    if ("children" in n) n.children.forEach(visit);
  };
  visit(tree);
  return style;
}

/** Use two spaces for a hard break, except right after another break, where only `\` survives. */
const spacesBreak: Handle = (_node, _parent, _state, info) => (info.before.endsWith("\n") ? "\\\n" : "  \n");

/** Whether a list opens, at any depth of first items, with a numbered list not starting at 1. */
function opensWithLateNumber(list: MdList): boolean {
  if (list.ordered && (list.start ?? 1) !== 1) return true;
  const first = list.children[0]?.children[0];
  return first?.type === "list" && opensWithLateNumber(first);
}

/**
 * A block in canonical syntax, styled like its own source, else like the rest of the scene. A list
 * right after another of its kind takes the other marker (`*` for `-`, `)` for `.`), or the two would
 * read back as one list.
 */
function canonicalBlock(node: Node, docStyle: Style | null, before?: string): string {
  const src = node.attrs.src;
  const style = { ...docStyle, ...(typeof src === "string" && src ? sourceStyle(mdast(src), src) : {}) };
  const options: Options = {
    extensions: [gfmToMarkdown()],
    emphasis: style.emphasis ?? "*",
    strong: style.strong ?? "*",
    rule: "*",
    ruleRepetition: 3,
    // D10: `-` bullets and `1.` numbering, unless the block before is a list using them.
    bullet: before !== undefined && /^-[ \t]/.test(before) ? "*" : "-",
    bulletOther: before !== undefined && /^-[ \t]/.test(before) ? "-" : "*",
    bulletOrdered: before !== undefined && /^\d{1,9}\.[ \t]/.test(before) ? ")" : ".",
    ruleSpaces: false,
    // to-markdown may write the character after a backslash as a character reference (`&#x61;`)
    // so emphasis can flank, which the backslash would then escape. to-markdown already escapes
    // a backslash before ASCII punctuation; escape it before anything else too.
    unsafe: [{ character: "\\", after: "[^!-/:-@\\[-`{-~]" }],
    ...(style.spaces ? { handlers: { break: spacesBreak } } : {}),
  };
  return toMarkdown({ type: "root", children: [blockToMdast(node)] }, options).replace(/\n$/, "");
}

function blockToMdast(node: Node): RootContent {
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: inlineToMdast(expelWhitespace(trimInline(node))) };
    case "blockquote": {
      const children: RootContent[] = [];
      node.forEach((child) => void (isEmpty(child) || children.push(blockToMdast(child))));
      return { type: "blockquote", children } as RootContent;
    }
    case "horizontal_rule":
      return { type: "thematicBreak" };
    case "heading":
      return { type: "heading", depth: Math.min(3, Math.max(1, node.attrs.level)) as 1 | 2 | 3, children: inlineToMdast(expelWhitespace(trimInline(node))) };
    case "bullet_list":
    case "ordered_list": {
      // Empty items aren't written: a lone `-` would read back as something else.
      const spread = !node.attrs.tight;
      const children: ListItem[] = [];
      node.forEach((item) => {
        if (isEmpty(item)) return;
        const content: BlockContent[] = [];
        item.forEach((c) => void (isEmpty(c) || content.push(blockToMdast(c) as BlockContent)));
        // A numbered list can interrupt a paragraph only if it starts at 1 (so can a list whose first item
        // begins with one): otherwise it needs a blank line.
        const interrupts = content.some((c, i) => i > 0 && content[i - 1]!.type === "paragraph" && c.type === "list" && opensWithLateNumber(c));
        children.push({ type: "listItem", spread: spread || interrupts, children: content });
      });
      const ordered = node.type.name === "ordered_list";
      return { type: "list", ordered, ...(ordered ? { start: node.attrs.start } : {}), spread, children };
    }
    case "table": {
      const align: AlignType[] = [];
      node.firstChild?.forEach((cell) => void align.push(cell.attrs.align ?? null));
      const rows: TableRow[] = [];
      node.forEach((row) => {
        const cells: TableCell[] = [];
        row.forEach((cell) => void cells.push({ type: "tableCell", children: inlineToMdast(expelWhitespace(trimInline(cell))) }));
        rows.push({ type: "tableRow", children: cells });
      });
      return { type: "table", align, children: rows };
    }
    case "picture":
      return { type: "paragraph", children: [{ type: "image", url: node.attrs.url, alt: node.attrs.alt, title: node.attrs.caption || null }] };
    default:
      return { type: "html", value: node.textContent };
  }
}

/**
 * A paragraph's inline content without whitespace that Markdown can't keep: at the paragraph's
 * edges and around hard breaks. Breaks at the edges are dropped too (a trailing `\` is literal).
 */
function trimInline(paragraph: Node): Node[] {
  const segments: Node[][] = [[]];
  const breaks: Node[] = [];
  paragraph.forEach((child) => {
    if (child.type.name === "hard_break") {
      breaks.push(child);
      segments.push([]);
    } else segments.at(-1)!.push(child);
  });
  const trimmed = segments.map((s) => trimEdge(trimEdge(s, true), false));
  let first = 0;
  let last = trimmed.length - 1;
  while (first <= last && !trimmed[first]!.length) first++;
  while (last > first && !trimmed[last]!.length) last--;
  const out: Node[] = [];
  for (let i = first; i <= last; i++) {
    if (i > first) out.push(breaks[i - 1]!);
    out.push(...trimmed[i]!);
  }
  return out;
}

function trimEdge(nodes: Node[], start: boolean): Node[] {
  const out = [...nodes];
  while (out.length) {
    const i = start ? 0 : out.length - 1;
    const n = out[i]!;
    if (!n.isText) break;
    // Only spaces and tabs: Markdown keeps other whitespace such as U+00A0.
    const text = n.text!.replace(start ? /^[ \t]+/ : /[ \t]+$/, "");
    if (text) {
      out[i] = n.type.schema.text(text, n.marks);
      break;
    }
    out.splice(i, 1);
  }
  return out;
}

/**
 * Move whitespace and breaks at the edges of emphasis out of it: `*a *b` can't open and close
 * as Markdown emphasis, and an emphasised space looks like a plain one.
 */
function expelWhitespace(nodes: Node[]): readonly Node[] {
  // One item per character of text, so a run can be trimmed at any character.
  const items = nodes.flatMap((n) => (n.isText ? [...n.text!].map((ch) => n.type.schema.text(ch, n.marks)) : [n]));
  const blank = (n: Node) => n.type.name === "hard_break" || (n.isText && /^[ \t]$/.test(n.text!));
  for (const name of ["em", "strong"]) {
    const has = (i: number) => !!items[i]?.marks.some((m) => m.type.name === name);
    const strip = (i: number) => {
      const n = items[i]!;
      const marks = n.marks.filter((m) => m.type.name !== name);
      items[i] = n.isText ? n.type.schema.text(n.text!, marks) : n.mark(marks);
    };
    for (let i = 0; i < items.length; i++) {
      if (!has(i) || has(i - 1)) continue;
      let end = i;
      while (has(end + 1)) end++;
      let a = i;
      let b = end;
      while (a <= b && blank(items[a]!)) strip(a++);
      while (b >= a && blank(items[b]!)) strip(b--);
      i = end;
    }
  }
  return Fragment.fromArray(items).content;
}

/** Inline nodes to mdast phrasing content, nesting marks so adjacent nodes share them. */
function inlineToMdast(nodes: readonly Node[]): PhrasingContent[] {
  const root: PhrasingContent[] = [];
  const open: { mark: Mark; children: PhrasingContent[] }[] = [];
  for (const node of nodes) {
    let keep = 0;
    while (keep < open.length && keep < node.marks.length && open[keep]!.mark.eq(node.marks[keep]!)) keep++;
    open.length = keep;
    let children = keep ? open[keep - 1]!.children : root;
    for (const mark of node.marks.slice(keep)) {
      const wrapper = markToMdast(mark);
      children.push(wrapper);
      children = wrapper.children;
      open.push({ mark, children });
    }
    children.push(leafToMdast(node));
  }
  return root;
}

function markToMdast(mark: Mark): PhrasingContent & { children: PhrasingContent[] } {
  switch (mark.type.name) {
    case "link":
      return { type: "link", url: mark.attrs.href, title: mark.attrs.title, children: [] };
    case "strong":
      return { type: "strong", children: [] };
    default:
      return { type: "emphasis", children: [] };
  }
}

function leafToMdast(node: Node): PhrasingContent {
  switch (node.type.name) {
    case "text":
      return { type: "text", value: node.text! };
    case "hard_break":
      return { type: "break" };
    case "mention":
      return { type: "link", url: `#${node.attrs.id}`, title: null, children: [{ type: "text", value: node.attrs.label }] };
    default:
      return { type: "html", value: node.attrs.text };
  }
}
