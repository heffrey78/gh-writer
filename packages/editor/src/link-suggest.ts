import { Extension, type Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MentionEntity } from "./mention-suggest.ts";
import { writingModes, type EditorCommand } from "./modes.ts";

export interface LinkSuggestOptions {
  /** The entries whose names and aliases are looked for; read on each change. */
  entities: () => readonly MentionEntity[];
}

interface Matcher {
  pattern: RegExp;
  /** Each name or alias, to the entity it names (the first, if two share one). */
  ids: Map<string, string>;
}

/** Names and aliases as one pattern, longest first, matching whole words only and with their case. */
function matcher(entities: readonly MentionEntity[]): Matcher | undefined {
  const ids = new Map<string, string>();
  for (const e of entities) for (const term of [e.name, ...e.aliases]) if (term.trim().length > 1 && !ids.has(term)) ids.set(term, e.id);
  if (!ids.size) return undefined;
  const terms = [...ids.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { pattern: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.join("|")})(?![\\p{L}\\p{N}_])`, "gu"), ids };
}

/** Unmarked names in a textblock, as [from, to, id] offsets into it (one character per position). */
function scan(block: Node, m: Matcher): [number, number, string][] {
  const text = block.textBetween(0, block.content.size, undefined, "￼");
  const out: [number, number, string][] = [];
  for (const hit of text.matchAll(m.pattern)) {
    const from = hit.index;
    const to = from + hit[0].length;
    // Not inside a link: it already points somewhere.
    let linked = false;
    block.nodesBetween(from, to, (n) => void (n.marks.some((mark) => mark.type.name === "link") && (linked = true)));
    if (!linked) out.push([from, to, m.ids.get(hit[0])!]);
  }
  return out;
}

export const linkSuggestKey = new PluginKey<DecorationSet>("linkSuggest");

/**
 * Underlines names and aliases of bible entries written as plain text, as suggestions to link
 * them (the "linkSuggestions" writing mode, off by default). Nothing changes until the author
 * links one: Alt+Enter, or "Link the name at the caret", turns it into a mention showing the
 * words as written.
 */
export const LinkSuggestExtension = Extension.create<LinkSuggestOptions>({
  name: "linkSuggest",
  addOptions: () => ({ entities: () => [] }),

  addKeyboardShortcuts() {
    return { "Alt-Enter": ({ editor }) => linkNameAtCaret(editor) };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let cache = new WeakMap<Node, [number, number, string][]>();
    let source: readonly MentionEntity[] | undefined;
    let m: Matcher | undefined;

    const decorate = (state: EditorState): DecorationSet => {
      if (!writingModes.getState().linkSuggestions) return DecorationSet.empty;
      const entities = options.entities();
      if (entities !== source) {
        source = entities;
        m = matcher(entities);
        cache = new WeakMap();
      }
      if (!m) return DecorationSet.empty;
      const decorations: Decoration[] = [];
      const names = new Map(entities.map((e) => [e.id, e.name]));
      state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type.spec.code) return false;
        let hits = cache.get(node);
        if (!hits) cache.set(node, (hits = scan(node, m!)));
        for (const [from, to, id] of hits) {
          decorations.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { class: "ghw-unlinked", title: `Not linked: Alt+Enter links it to ${names.get(id)}` }, { id }));
        }
        return false;
      });
      return DecorationSet.create(state.doc, decorations);
    };

    return [
      new Plugin<DecorationSet>({
        key: linkSuggestKey,
        state: {
          init: (_, state) => decorate(state),
          apply: (tr, set, _old, state) => (tr.docChanged || tr.getMeta(linkSuggestKey) ? decorate(state) : set),
        },
        props: { decorations: (state) => linkSuggestKey.getState(state) },
        view: (view) => {
          const off = writingModes.subscribe((modes, prev) => {
            if (modes.linkSuggestions !== prev.linkSuggestions && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(linkSuggestKey, true));
          });
          return { destroy: off };
        },
      }),
    ];
  },
});

/** Link the underlined name at the caret: it becomes a mention showing the words as written. False if there's none. */
export function linkNameAtCaret(editor: Editor): boolean {
  const { state } = editor;
  const head = state.selection.head;
  const found = linkSuggestKey.getState(state)?.find(head, head) ?? [];
  const hit = found.find((d) => d.from <= head && head <= d.to);
  const mention = state.schema.nodes.mention;
  if (!hit || !mention) return false;
  const label = state.doc.textBetween(hit.from, hit.to);
  const node = mention.create({ id: (hit.spec as { id: string }).id, label }, null, state.doc.nodeAt(hit.from)?.marks ?? []);
  editor.view.dispatch(state.tr.replaceWith(hit.from, hit.to, node).scrollIntoView());
  return true;
}

export const linkCommands: EditorCommand[] = [
  {
    id: "editor.toggleLinkSuggestions",
    title: "Suggest links for names written without a mention",
    run: (editor) => {
      writingModes.getState().toggle("linkSuggestions");
      if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
    },
    isActive: () => writingModes.getState().linkSuggestions,
  },
  { id: "editor.linkName", title: "Link the name at the caret", keys: "Alt-Enter", run: (editor) => void (editor && !editor.isDestroyed && linkNameAtCaret(editor) && editor.commands.focus()) },
];
