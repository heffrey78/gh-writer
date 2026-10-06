import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Something in the story bible that can be mentioned. */
export interface MentionEntity {
  id: string;
  name: string;
  aliases: string[];
  /** Its type's label ("Character"): suggestions are grouped by it, in the order entities are given. */
  type: string;
}

export interface MentionSuggestion {
  entity: MentionEntity;
  /** The words the mention will show: the name or alias the query matched. */
  label: string;
}

const LIMIT = 10;

/**
 * The entities a query after @ finds, best first, grouped by type. A name or alias starting with
 * the query ranks highest, then one with a word starting with it, then one containing it. The
 * label is the shortest name or alias that starts with the query (so "@ad" writes "Ada", "@ada v"
 * writes "Ada Varn"), or the name.
 */
export function suggestMentions(entities: readonly MentionEntity[], query: string, limit = LIMIT): MentionSuggestion[] {
  const q = query.trim().toLowerCase();
  const scored = entities.flatMap((entity) => {
    const terms = [entity.name, ...entity.aliases];
    let score = q ? 0 : 1;
    let label: string | undefined;
    for (const term of terms) {
      const t = term.toLowerCase();
      if (!q) break;
      if (t.startsWith(q)) {
        score = Math.max(score, 3);
        if (label === undefined || term.length < label.length) label = term;
      } else if (t.includes(` ${q}`)) score = Math.max(score, 2);
      else if (t.includes(q)) score = Math.max(score, 1);
    }
    return score ? [{ entity, label: label ?? entity.name, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name));
  const top = scored.slice(0, limit);
  const types = [...new Set(entities.map((e) => e.type))];
  return types.flatMap((type) => top.filter((s) => s.entity.type === type)).map(({ entity, label }) => ({ entity, label }));
}

export interface MentionSuggestOptions {
  /** The entities to suggest; read on every keystroke, so it can change without remounting. */
  entities: () => readonly MentionEntity[];
}

interface Active {
  /** Where the @ is. */
  from: number;
  /** The caret: the end of the query. */
  to: number;
  query: string;
  items: MentionSuggestion[];
  index: number;
}

interface MentionState {
  active: Active | null;
  /** The @ the author dismissed with Escape: no suggestions for it until they leave it. */
  dismissed: number | null;
}

type Meta = { index: number } | { dismiss: true };

export const mentionSuggestKey = new PluginKey<MentionState>("mentionSuggest");

// "@" at the start of a block or after a space or opening punctuation, then up to three words.
const TRIGGER = /(?:^|[\s(\u201c"\u2018'\u2014\u2013-])@((?:[^\s@\ufffc][^\s@\ufffc]*)(?: [^\s@\ufffc]+){0,2})?$/u;

function trigger(state: EditorState): { from: number; to: number; query: string } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$from;
  if (!$at.parent.isTextblock || $at.parent.type.spec.code) return null;
  const start = Math.max(0, $at.parentOffset - 60);
  const before = $at.parent.textBetween(start, $at.parentOffset, undefined, "\ufffc");
  const m = TRIGGER.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { from: $at.pos - query.length - 1, to: $at.pos, query };
}

/** The listbox's ID, and its options', for aria-activedescendant. */
const LISTBOX = "ghw-mention-suggestions";
const optionId = (i: number) => `${LISTBOX}-${i}`;

/**
 * Type @ and a few letters to mention something from the story bible. Suggestions are a listbox
 * the text box points at (aria-activedescendant), so focus stays in the text: arrows move, Enter
 * or Tab inserts the mention, Escape leaves the @ as typed.
 */
export const MentionSuggestExtension = Extension.create<MentionSuggestOptions>({
  name: "mentionSuggest",
  // Before the keymaps, so Enter and Tab choose a suggestion rather than split or indent.
  priority: 1000,
  addOptions: () => ({ entities: () => [] }),
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;

    const insert = (view: EditorView, active: Active, item: MentionSuggestion) => {
      const { state } = view;
      const mention = state.schema.nodes.mention;
      if (!mention) return;
      const marks = state.doc.resolve(active.from).marks();
      const after = state.doc.textBetween(active.to, Math.min(active.to + 1, state.doc.content.size - 1), undefined, "\ufffc");
      const tr = state.tr.replaceWith(active.from, active.to, mention.create({ id: item.entity.id, label: item.label }, null, marks));
      // A space after it, unless the text goes on with one or with punctuation.
      if (!/^[\s.,;:!?…’'”")\]—–-]/u.test(after)) tr.insertText(" ", active.from + 1);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    };

    return [
      new Plugin<MentionState>({
        key: mentionSuggestKey,
        state: {
          init: () => ({ active: null, dismissed: null }),
          apply(tr: Transaction, prev: MentionState, _old: EditorState, state: EditorState): MentionState {
            const meta = tr.getMeta(mentionSuggestKey) as Meta | undefined;
            const at = trigger(state);
            const dismissed = at && prev.dismissed !== null ? tr.mapping.map(prev.dismissed) : null;
            if (meta && "dismiss" in meta && at) return { active: null, dismissed: at.from };
            if (!at || dismissed === at.from) return { active: null, dismissed: at ? dismissed : null };
            const items = suggestMentions(options.entities(), at.query);
            if (!items.length) return { active: null, dismissed: null };
            const same = prev.active && prev.active.from === at.from && prev.active.query === at.query;
            const index = meta && "index" in meta ? meta.index : same ? prev.active!.index : 0;
            return { active: { ...at, items, index: Math.min(Math.max(index, 0), items.length - 1) }, dismissed: null };
          },
        },
        props: {
          attributes(state): Record<string, string> {
            const active = mentionSuggestKey.getState(state)?.active;
            return active ? { "aria-controls": LISTBOX, "aria-activedescendant": optionId(active.index), "aria-haspopup": "listbox" } : {};
          },
          handleKeyDown(view, event) {
            const active = mentionSuggestKey.getState(view.state)?.active;
            if (!active || event.isComposing) return false;
            const n = active.items.length;
            const move = (index: number) => view.dispatch(view.state.tr.setMeta(mentionSuggestKey, { index: (index + n) % n } satisfies Meta));
            if (event.key === "ArrowDown") move(active.index + 1);
            else if (event.key === "ArrowUp") move(active.index - 1);
            else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) insert(view, active, active.items[active.index]!);
            else if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(mentionSuggestKey, { dismiss: true } satisfies Meta));
              // Only the suggestions close, not whatever Escape means around the editor.
              event.stopPropagation();
            } else return false;
            event.preventDefault();
            return true;
          },
        },
        view(view) {
          const list = document.createElement("div");
          list.id = LISTBOX;
          list.className = "ghw-mention-menu";
          list.setAttribute("role", "listbox");
          list.setAttribute("aria-label", "Mention suggestions");
          let shown: Active | null = null;

          const render = (active: Active) => {
            list.replaceChildren();
            const types = [...new Set(active.items.map((i) => i.entity.type))];
            let i = 0;
            for (const type of types) {
              const group = document.createElement("div");
              group.setAttribute("role", "group");
              const heading = document.createElement("div");
              heading.className = "ghw-mention-group";
              heading.id = `${LISTBOX}-group-${type.replace(/\W+/g, "-")}`;
              heading.setAttribute("role", "presentation");
              heading.textContent = type;
              group.setAttribute("aria-labelledby", heading.id);
              group.append(heading);
              for (const item of active.items.filter((s) => s.entity.type === type)) {
                const index = i++;
                const option = document.createElement("div");
                option.id = optionId(index);
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", String(index === active.index));
                option.textContent = item.entity.name;
                if (item.label !== item.entity.name) {
                  const as = document.createElement("span");
                  as.className = "ghw-mention-as";
                  as.textContent = ` as “${item.label}”`;
                  option.append(as);
                }
                // Keep focus in the text; choose on click.
                option.addEventListener("mousedown", (e) => e.preventDefault());
                option.addEventListener("click", () => {
                  const now = mentionSuggestKey.getState(view.state)?.active;
                  if (now) insert(view, now, now.items[index] ?? item);
                });
                group.append(option);
              }
              list.append(group);
            }
            const coords = view.coordsAtPos(active.from);
            list.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 280))}px`;
            const height = list.offsetHeight;
            const below = coords.bottom + 6;
            const above = coords.top - 6 - height;
            list.style.top = `${below + height <= window.innerHeight - 8 || above < 8 ? below : above}px`;
            document.getElementById(optionId(active.index))?.scrollIntoView({ block: "nearest" });
          };

          const update = () => {
            const active = mentionSuggestKey.getState(view.state)?.active ?? null;
            if (active === shown) return;
            shown = active;
            if (!active || !editor.isEditable) {
              list.remove();
              return;
            }
            // Beside the text, so it's in the same landmark (it's fixed, so it still floats).
            if (!list.isConnected) (view.dom.parentElement ?? document.body).append(list);
            render(active);
          };
          return { update, destroy: () => list.remove() };
        },
      }),
    ];
  },
});
