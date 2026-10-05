import { Schema, type AttributeSpec } from "prosemirror-model";

/**
 * Source attributes on top-level blocks. `src` is the block's original Markdown and `gap` the
 * whitespace before it; the serializer reuses them while the block is unchanged, which is what
 * makes an unedited round-trip byte-for-byte. Nested blocks leave them null.
 */
const source: Record<string, AttributeSpec> = { src: { default: null }, gap: { default: null } };

export const proseSchema = new Schema({
  nodes: {
    doc: {
      content: "block+",
      // `trailing` is the whitespace after the last block, `eol` the file's line ending and
      // `style` the scene's emphasis and break syntax, used for blocks with none of their own.
      attrs: { trailing: { default: "\n" }, eol: { default: "\n" }, style: { default: null } },
    },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: source,
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
      attrs: source,
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    /** An in-scene section break (`***`). Scene files themselves are never separated by one. */
    horizontal_rule: {
      group: "block",
      attrs: source,
      parseDOM: [{ tag: "hr" }],
      toDOM: () => ["hr"],
    },
    /** Markdown the editor doesn't model (lists, tables, HTML, code…), kept and saved verbatim. */
    raw_block: {
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      attrs: source,
      parseDOM: [{ tag: "pre[data-raw]", preserveWhitespace: "full" }],
      toDOM: () => ["pre", { "data-raw": "" }, ["code", 0]],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    /** A mention of a bible entity: `[label](#id)`. */
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { id: {}, label: { default: "" } },
      parseDOM: [
        {
          tag: "span[data-mention]",
          getAttrs: (dom) => ({ id: dom.getAttribute("data-mention"), label: dom.textContent ?? "" }),
        },
      ],
      toDOM: (node) => ["span", { "data-mention": node.attrs.id }, node.attrs.label],
    },
    /** Inline Markdown the editor doesn't model (code, images, strikethrough, HTML…), kept verbatim. */
    raw_inline: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { text: {} },
      parseDOM: [{ tag: "code[data-raw]", getAttrs: (dom) => ({ text: dom.textContent ?? "" }) }],
      toDOM: (node) => ["code", { "data-raw": "" }, node.attrs.text],
    },
  },
  // Order is nesting order when serializing: links wrap emphasis, emphasis wraps strong.
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      parseDOM: [
        { tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href"), title: dom.getAttribute("title") }) },
      ],
      toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title }, 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: () => ["em", 0],
    },
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: () => ["strong", 0],
    },
  },
});
