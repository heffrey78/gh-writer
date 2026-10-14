import { picturePath } from "@gh-writer/core";
import { Mark, Node, markInputRule, mergeAttributes, nodeInputRule, textblockTypeInputRule, wrappingInputRule, type Attributes, type Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { addRowAfter, goToNextCell, isInTable, tableEditing } from "@tiptap/pm/tables";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/*
 * TipTap extensions for scene prose. They define the schema (see schema.ts), so node and mark
 * names and attributes must stay in step with markdown.ts. Behaviour (shortcuts, input rules)
 * is included because TipTap keeps it with the node definitions.
 */

/** Attributes that only the Markdown round-trip uses: never rendered, never copied on split. */
export function hidden(names: Record<string, unknown>): Attributes {
  return Object.fromEntries(
    Object.entries(names).map(([name, value]) => [name, { default: value, rendered: false, keepOnSplit: false, parseHTML: () => value }]),
  );
}

/** Source attributes on top-level blocks; see markdown.ts. */
const source = () => hidden({ src: null, gap: null });

export const Doc = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
  // `trailing` is the whitespace after the last block, `eol` the file's line ending and
  // `style` the scene's emphasis and break syntax, used for blocks with none of their own.
  addAttributes: () => hidden({ trailing: "\n", eol: "\n", style: null }),
});

export const Text = Node.create({ name: "text", group: "inline" });

export const Paragraph = Node.create({
  name: "paragraph",
  // The default block: highest priority puts it first in the schema.
  priority: 1000,
  group: "block",
  content: "inline*",
  addAttributes: source,
  parseHTML: () => [{ tag: "p" }],
  renderHTML: ({ HTMLAttributes }) => ["p", HTMLAttributes, 0],
});

export const Blockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: source,
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: ({ HTMLAttributes }) => ["blockquote", HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { "Mod-Shift-b": () => this.editor.commands.toggleWrap(this.name) };
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});

/**
 * Insert an in-scene section break at the cursor: before the paragraph at its start, after it
 * at its end (moving into a new paragraph), or splitting it in the middle.
 */
export function insertSectionBreak(editor: Editor): boolean {
  const { schema } = editor.state;
  if (editor.state.selection.$from.parent.type.spec.code) return false;
  return editor
    .chain()
    .deleteSelection()
    .command(({ tr }) => {
      const $pos = tr.selection.$from;
      const rule = schema.nodes.horizontal_rule!.create();
      if ($pos.parentOffset === 0) {
        tr.insert($pos.before(), rule);
      } else if ($pos.parentOffset === $pos.parent.content.size) {
        const after = $pos.after();
        tr.insert(after, [rule, schema.nodes.paragraph!.create()]);
        tr.setSelection(TextSelection.create(tr.doc, after + rule.nodeSize + 1));
      } else {
        tr.split($pos.pos).insert($pos.pos + 1, rule);
      }
      return true;
    })
    .scrollIntoView()
    .run();
}

/** An in-scene section break (`***`). Scene files themselves are never separated by one. */
export const SectionBreak = Node.create({
  name: "horizontal_rule",
  group: "block",
  addAttributes: source,
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: ({ HTMLAttributes }) => ["hr", mergeAttributes(HTMLAttributes, { "aria-label": "Section break" })],
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => insertSectionBreak(this.editor) };
  },
  addInputRules() {
    return [nodeInputRule({ find: /^(?:\*\*\*|---|___)\s$/, type: this.type })];
  },
});

/**
 * A scene's own heading (a letter's date, a document's title), levels 1-3 (D10). Shown a level below
 * the page's own headings, so a scene's # sits beneath the chapter's title.
 */
export const Heading = Node.create({
  name: "heading",
  group: "block",
  // A line of text: a Markdown heading can't hold a break.
  content: "(text | mention | raw_inline)*",
  defining: true,
  addAttributes: () => ({ level: { default: 1, rendered: false, parseHTML: (el) => Math.min(3, Math.max(1, Number(el.tagName.slice(1)) - 1)) }, ...source() }),
  parseHTML: () => [2, 3, 4].map((n) => ({ tag: `h${n}` })),
  renderHTML: ({ node, HTMLAttributes }) => [`h${Math.min(3, node.attrs.level as number) + 1}`, mergeAttributes(HTMLAttributes, { class: "ghw-heading" }), 0],
  addKeyboardShortcuts() {
    const level = (n: number) => () => this.editor.commands.setNode(this.name, { level: n });
    return { "Mod-Alt-1": level(1), "Mod-Alt-2": level(2), "Mod-Alt-3": level(3), "Mod-Alt-0": () => this.editor.commands.setNode("paragraph") };
  },
  addInputRules() {
    // `# `, `## `, `### ` at a line's start, as in Markdown.
    return [textblockTypeInputRule({ find: /^(#{1,3})\s$/, type: this.type, getAttributes: (m) => ({ level: m[1]!.length }) })];
  },
  addProseMirrorPlugins: () => [headingLevels],
});

/**
 * Headings as screen readers hear them: a heading looks its Markdown level, but is announced by its rank
 * among the levels the text uses, beneath the page's own heading (aria-level 2 and on). A scene that
 * starts at ## then reads as the next level down from the page's title, never skipping one.
 */
const headingLevels: Plugin<DecorationSet> = new Plugin<DecorationSet>({
  key: new PluginKey("ghwHeadingLevels"),
  state: {
    init: (_, state) => headingDecorations(state.doc),
    apply: (tr, old) => (tr.docChanged ? headingDecorations(tr.doc) : old),
  },
  props: { decorations: (state) => headingLevels.getState(state) },
});

function headingDecorations(doc: ProseNode): DecorationSet {
  const headings: { pos: number; node: ProseNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") headings.push({ pos, node });
    return node.isBlock && !node.isTextblock;
  });
  if (!headings.length) return DecorationSet.empty;
  const levels = [...new Set(headings.map((h) => h.node.attrs.level as number))].sort();
  return DecorationSet.create(
    doc,
    headings.map((h) => Decoration.node(h.pos, h.pos + h.node.nodeSize, { "aria-level": String(2 + levels.indexOf(h.node.attrs.level as number)) })),
  );
}

/** A list's attributes: tight (no blank lines between items) as written, and its source. */
const listAttributes = () => ({ tight: { default: true, rendered: false }, ...source() });

export const BulletList = Node.create({
  name: "bullet_list",
  group: "block",
  content: "list_item+",
  addAttributes: listAttributes,
  parseHTML: () => [{ tag: "ul" }],
  renderHTML: ({ HTMLAttributes }) => ["ul", HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { "Mod-Shift-8": () => this.editor.commands.toggleList(this.name, "list_item") };
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*([-+*])\s$/, type: this.type })];
  },
});

export const OrderedList = Node.create({
  name: "ordered_list",
  group: "block",
  content: "list_item+",
  addAttributes: () => ({
    start: { default: 1, parseHTML: (el) => Number(el.getAttribute("start") ?? 1), renderHTML: (attrs) => (attrs.start === 1 ? {} : { start: attrs.start }) },
    ...listAttributes(),
  }),
  parseHTML: () => [{ tag: "ol" }],
  renderHTML: ({ HTMLAttributes }) => ["ol", HTMLAttributes, 0],
  addKeyboardShortcuts() {
    return { "Mod-Shift-7": () => this.editor.commands.toggleList(this.name, "list_item") };
  },
  addInputRules() {
    // `1. ` (or any number) at a line's start; a list right before it continues if the number follows on.
    return [
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: (m) => ({ start: Number(m[1]) }),
        joinPredicate: (m, node) => node.childCount + (node.attrs.start as number) === Number(m[1]),
      }),
    ];
  },
});

/** A list item: a paragraph, then any blocks (another list, more paragraphs). */
export const ListItem = Node.create({
  name: "list_item",
  content: "paragraph block*",
  defining: true,
  parseHTML: () => [{ tag: "li" }],
  renderHTML: ({ HTMLAttributes }) => ["li", HTMLAttributes, 0],
  addKeyboardShortcuts() {
    // Enter: a new item (in an empty one, out of the list); Tab nests an item, Shift+Tab lifts it. Tab
    // where an item can't nest (the first) isn't taken, so it still leaves the text.
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      "Shift-Tab": () => this.editor.commands.liftListItem(this.name),
    };
  },
});

declare module "@tiptap/core" {
  interface NodeConfig {
    /** The part a node plays in a table, for ProseMirror's table commands. */
    tableRole?: "table" | "row" | "cell" | "header_cell";
  }
}

/** A cell's column alignment and the spans ProseMirror's table commands expect (always 1: GitHub's tables can't merge). */
const cellAttributes = () => ({
  align: { default: null, parseHTML: (el: HTMLElement) => el.style.textAlign || null, renderHTML: (attrs: { align?: string | null }) => (attrs.align ? { style: `text-align: ${attrs.align}` } : {}) },
  colspan: { default: 1, rendered: false },
  rowspan: { default: 1, rendered: false },
  colwidth: { default: null, rendered: false },
});

/** A table (GitHub's): a header row, then rows of cells, each a line of text (D10). */
export const Table = Node.create({
  name: "table",
  group: "block",
  content: "table_row+",
  tableRole: "table",
  isolating: true,
  addAttributes: source,
  // ProseMirror's table commands find a schema's table nodes by this field of their spec.
  extendNodeSchema: (extension) => ({ tableRole: extension.config.tableRole }),
  parseHTML: () => [{ tag: "table" }],
  renderHTML: ({ HTMLAttributes }) => ["table", mergeAttributes(HTMLAttributes, { class: "ghw-table" }), ["tbody", 0]],
  addProseMirrorPlugins: () => [tableEditing()],
  addKeyboardShortcuts() {
    // Tab to the next cell (from the last, a new row), Shift+Tab back; Enter as Tab, as a cell is one line.
    const next = () => {
      if (!isInTable(this.editor.state)) return false;
      const { state, view } = this.editor;
      if (goToNextCell(1)(state, view.dispatch)) return true;
      return addRowAfter(state, view.dispatch) && goToNextCell(1)(this.editor.state, view.dispatch);
    };
    return {
      Tab: next,
      Enter: next,
      "Shift-Tab": () => isInTable(this.editor.state) && goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
    };
  },
});

export const TableRow = Node.create({
  name: "table_row",
  content: "(table_header | table_cell)+",
  tableRole: "row",
  parseHTML: () => [{ tag: "tr" }],
  renderHTML: ({ HTMLAttributes }) => ["tr", HTMLAttributes, 0],
});

/** Cells hold a line of text: no breaks, which a GitHub table cell can't. */
const CELL_CONTENT = "(text | mention | raw_inline)*";

export const TableHeader = Node.create({
  name: "table_header",
  content: CELL_CONTENT,
  tableRole: "header_cell",
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "th" }],
  renderHTML: ({ HTMLAttributes }) => ["th", mergeAttributes(HTMLAttributes, { scope: "col" }), 0],
});

export const TableCell = Node.create({
  name: "table_cell",
  content: CELL_CONTENT,
  tableRole: "cell",
  isolating: true,
  addAttributes: cellAttributes,
  parseHTML: () => [{ tag: "td" }],
  renderHTML: ({ HTMLAttributes }) => ["td", HTMLAttributes, 0],
});

export interface PictureOptions {
  /** The address to load a picture from, given its repository path (images/…): the app's server's. */
  url: (path: string) => string | undefined;
}

/**
 * A picture on a line of its own: `![alt](/images/name "caption")` (D10). `url` is as written (`src`,
 * like every block's, is its Markdown); the picture loads from the `url` option of its repository path.
 */
export const Picture = Node.create<PictureOptions>({
  name: "picture",
  group: "block",
  atom: true,
  selectable: true,
  // Dragged to move it, with a mark where it will land.
  draggable: true,
  addOptions: () => ({ url: (path) => `/${path}` }),
  addAttributes: () => ({
    url: { default: "", rendered: false, parseHTML: (el) => el.getAttribute("data-url") ?? "" },
    alt: { default: "", rendered: false, parseHTML: (el) => el.querySelector("img")?.getAttribute("alt") ?? "" },
    caption: { default: null, rendered: false, parseHTML: (el) => el.querySelector("figcaption")?.textContent ?? null },
    ...source(),
  }),
  parseHTML: () => [{ tag: "figure[data-url]" }],
  renderHTML({ node, HTMLAttributes }) {
    const path = picturePath(node.attrs.url as string);
    const img = ["img", { src: (path && this.options.url(path)) ?? "", alt: node.attrs.alt, loading: "lazy" }];
    const caption = node.attrs.caption as string | null;
    return ["figure", mergeAttributes(HTMLAttributes, { class: "ghw-picture", "data-url": node.attrs.url }), img, ...(caption ? [["figcaption", caption]] : [])];
  },
});

/** Markdown the editor doesn't model (code, HTML, footnotes…), edited as plain Markdown text. */
export const RawBlock = Node.create({
  name: "raw_block",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: source,
  parseHTML: () => [{ tag: "pre[data-raw]", preserveWhitespace: "full" }],
  renderHTML: ({ HTMLAttributes }) => [
    "pre",
    mergeAttributes(HTMLAttributes, { "data-raw": "", class: "ghw-raw", "aria-label": "Markdown" }),
    ["code", 0],
  ],
});

export const HardBreak = Node.create({
  name: "hard_break",
  inline: true,
  group: "inline",
  selectable: false,
  parseHTML: () => [{ tag: "br" }],
  renderHTML: () => ["br"],
  renderText: () => "\n",
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.insertContent({ type: this.name }) };
  },
});

/** A mention of a bible entity: `[label](#id)`. An atom, so typing can't split or partly delete it. */
export const Mention = Node.create({
  name: "mention",
  inline: true,
  group: "inline",
  atom: true,
  // Not selectable: arrow keys step over a mention instead of selecting it, where typing would replace it.
  selectable: false,
  addAttributes: () => ({
    id: { default: null, rendered: false, parseHTML: (el) => el.getAttribute("data-mention") },
    label: { default: "", rendered: false, parseHTML: (el) => el.textContent ?? "" },
  }),
  parseHTML: () => [{ tag: "span[data-mention]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, { "data-mention": node.attrs.id, class: "ghw-mention" }),
    node.attrs.label,
  ],
  renderText: ({ node }) => node.attrs.label,
});

/** Inline Markdown the editor doesn't model (code, images, strikethrough, HTML…), kept verbatim. */
export const RawInline = Node.create({
  name: "raw_inline",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes: () => ({ text: { default: "", rendered: false, parseHTML: (el) => el.textContent ?? "" } }),
  parseHTML: () => [{ tag: "code[data-raw]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "code",
    mergeAttributes(HTMLAttributes, { "data-raw": "", class: "ghw-raw-inline", title: "Markdown" }),
    node.attrs.text,
  ],
  renderText: ({ node }) => node.attrs.text,
});

// Marks, in nesting order when serializing: links wrap emphasis, emphasis wraps strong.

export const Link = Mark.create({
  name: "link",
  priority: 1002,
  inclusive: false,
  addAttributes: () => ({
    href: { default: null, parseHTML: (el) => el.getAttribute("href") },
    title: { default: null, parseHTML: (el) => el.getAttribute("title") },
  }),
  parseHTML: () => [{ tag: "a[href]" }],
  renderHTML: ({ HTMLAttributes }) => ["a", HTMLAttributes, 0],
});

export const Emphasis = Mark.create({
  name: "em",
  priority: 1001,
  parseHTML: () => [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
  renderHTML: () => ["em", 0],
  addKeyboardShortcuts() {
    // No "Mod-I" for caps lock: ProseMirror's keyCode fallback covers it, and the binding
    // would also catch Mod-Shift-i.
    return { "Mod-i": () => this.editor.commands.toggleMark(this.name) };
  },
  addInputRules() {
    return [
      markInputRule({ find: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/, type: this.type }),
      markInputRule({ find: /(?:^|\s)(_(?!\s+_)((?:[^_]+))_(?!\s+_))$/, type: this.type }),
    ];
  },
});

export const Strong = Mark.create({
  name: "strong",
  priority: 1000,
  parseHTML: () => [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }],
  renderHTML: () => ["strong", 0],
  addKeyboardShortcuts() {
    // No "Mod-B" for caps lock: ProseMirror's keyCode fallback covers it, and the binding
    // would also catch Mod-Shift-b.
    return { "Mod-b": () => this.editor.commands.toggleMark(this.name) };
  },
  addInputRules() {
    return [
      markInputRule({ find: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/, type: this.type }),
      markInputRule({ find: /(?:^|\s)(__(?!\s+__)((?:[^_]+))__(?!\s+__))$/, type: this.type }),
    ];
  },
});

/** The nodes and marks of scene prose, with their shortcuts and input rules. */
export const proseContent = [
  Doc,
  Text,
  Paragraph,
  Blockquote,
  SectionBreak,
  Heading,
  BulletList,
  OrderedList,
  ListItem,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  Picture,
  RawBlock,
  HardBreak,
  Mention,
  RawInline,
  Link,
  Emphasis,
  Strong,
];
