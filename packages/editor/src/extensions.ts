import { TextSelection } from "@tiptap/pm/state";
import { Mark, Node, markInputRule, mergeAttributes, nodeInputRule, wrappingInputRule, type Attributes, type Editor } from "@tiptap/core";

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

/** Markdown the editor doesn't model (lists, tables, HTML, code…), edited as plain Markdown text. */
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
export const proseContent = [Doc, Text, Paragraph, Blockquote, SectionBreak, RawBlock, HardBreak, Mention, RawInline, Link, Emphasis, Strong];
