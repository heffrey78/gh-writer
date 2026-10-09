import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
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

/** A type of entry the @ menu can make a new one of. */
export interface MentionType {
  key: string;
  /** "Character": as entities give their type, so one named alike hides this type's row. */
  label: string;
}

export interface MentionSuggestOptions {
  /** The entities to suggest; read on every keystroke, so it can change without remounting. */
  entities: () => readonly MentionEntity[];
  /** The types offered as "New <type>" for what's typed after @; only with onCreate. */
  types: () => readonly MentionType[];
  /**
   * Make an entry of `type` named `name` and return its ID at once, so the mention goes in while
   * the file is written in the background; undefined if it can't be made.
   */
  onCreate?: ((type: string, name: string) => string | undefined) | undefined;
  /**
   * Ask the author to name a new entry of `type` (a dialog), for "New <type>…" chosen before any
   * name is typed: resolves with the name, or undefined if they cancelled. Without it, those rows
   * aren't offered.
   */
  askName?: ((type: string) => Promise<string | undefined>) | undefined;
}

interface Active {
  /** Where the @ is. */
  from: number;
  /** The caret: the end of the query. */
  to: number;
  query: string;
  items: MentionSuggestion[];
  /** "New <type>" rows, after the items: what's typed, as a new entry's name. */
  creates: MentionType[];
  /** Across items then creates; -1 when nothing is chosen (no match yet), so Enter stays Enter. */
  index: number;
}

interface MentionState {
  active: Active | null;
  /** The @ the author dismissed with Escape: no suggestions for it until they leave it. */
  dismissed: number | null;
  /** The @ (and what follows it) whose new entry the author is naming, kept in step with edits meanwhile. */
  naming: { from: number; to: number } | null;
}

type Meta = { index: number } | { dismiss: true } | { naming: { from: number; to: number } | null };

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
  addOptions: () => ({ entities: () => [], types: () => [], onCreate: undefined, askName: undefined }),
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;

    const make = (type: MentionType, name: string): MentionSuggestion | undefined => {
      const id = options.onCreate?.(type.key, name);
      return id ? { entity: { id, name, aliases: [], type: type.label }, label: name } : undefined;
    };

    const choose = (view: EditorView, active: Active, index: number) => {
      const item = active.items[index];
      if (item) return insert(view, active, item);
      const type = active.creates[index - active.items.length];
      if (!type) return;
      const name = active.query.trim();
      if (name) {
        const made = make(type, name);
        if (made) insert(view, active, made);
        return;
      }
      // Nothing typed yet: the author names it in a dialog, and the mention goes where the @ is then.
      if (!options.askName) return;
      view.dispatch(view.state.tr.setMeta(mentionSuggestKey, { naming: { from: active.from, to: active.to } } satisfies Meta));
      void options.askName(type.key).then((named) => {
        if (view.isDestroyed) return;
        const at = mentionSuggestKey.getState(view.state)?.naming;
        const done = view.state.tr.setMeta(mentionSuggestKey, { naming: null } satisfies Meta);
        const made = at && named?.trim() ? make(type, named.trim()) : undefined;
        if (at && made) {
          view.dispatch(done);
          insert(view, at, made);
          return;
        }
        // Cancelled: the @ stays as typed, its suggestions closed, the caret after it.
        if (at) done.setSelection(TextSelection.near(done.doc.resolve(Math.min(at.to, done.doc.content.size)))).setMeta(mentionSuggestKey, { naming: null, dismissAt: at.from });
        view.dispatch(done);
        view.focus();
      });
    };

    const insert = (view: EditorView, active: { from: number; to: number }, item: MentionSuggestion) => {
      const { state } = view;
      const mention = state.schema.nodes.mention;
      if (!mention) return;
      // The marks of the @ itself (at a mark boundary, the position's would be the text before's).
      const marks = state.doc.nodeAt(active.from)?.marks ?? [];
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
          init: () => ({ active: null, dismissed: null, naming: null }),
          apply(tr: Transaction, prev: MentionState, _old: EditorState, state: EditorState): MentionState {
            const meta = tr.getMeta(mentionSuggestKey) as (Meta & { dismissAt?: number }) | undefined;
            const naming =
              meta && "naming" in meta ? meta.naming : prev.naming && { from: tr.mapping.map(prev.naming.from, 1), to: tr.mapping.map(prev.naming.to, 1) };
            // While the author names a new entry, the menu stays closed.
            if (naming) return { active: null, dismissed: null, naming };
            const at = trigger(state);
            const dismissed = meta?.dismissAt ?? (at && prev.dismissed !== null ? tr.mapping.map(prev.dismissed) : null);
            if (meta && "dismiss" in meta && at) return { active: null, dismissed: at.from, naming: null };
            if (!at || dismissed === at.from) return { active: null, dismissed: at ? dismissed : null, naming: null };
            const entities = options.entities();
            const items = suggestMentions(entities, at.query);
            const name = at.query.trim().toLowerCase();
            // A type is offered unless an entry of it already has that name; with no name yet, to be named in a dialog.
            const creates = !options.onCreate
              ? []
              : name
                ? options.types().filter((t) => !entities.some((e) => e.type === t.label && [e.name, ...e.aliases].some((n) => n.toLowerCase() === name)))
                : options.askName
                  ? [...options.types()]
                  : [];
            const n = items.length + creates.length;
            if (!n) return { active: null, dismissed: null, naming: null };
            const same = prev.active && prev.active.from === at.from && prev.active.query === at.query;
            const index = meta && "index" in meta ? meta.index : same ? prev.active!.index : items.length ? 0 : -1;
            return { active: { ...at, items, creates, index: Math.min(Math.max(index, -1), n - 1) }, dismissed: null, naming: null };
          },
        },
        props: {
          attributes(state): Record<string, string> {
            const active = mentionSuggestKey.getState(state)?.active;
            if (!active) return {};
            return { "aria-controls": LISTBOX, "aria-haspopup": "listbox", ...(active.index >= 0 ? { "aria-activedescendant": optionId(active.index) } : {}) };
          },
          handleKeyDown(view, event) {
            const active = mentionSuggestKey.getState(view.state)?.active;
            if (!active || event.isComposing) return false;
            const n = active.items.length + active.creates.length;
            const move = (index: number) => view.dispatch(view.state.tr.setMeta(mentionSuggestKey, { index: (index + n) % n } satisfies Meta));
            const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
            if (event.key === "ArrowDown") move(active.index + 1);
            else if (event.key === "ArrowUp") move(active.index < 0 ? n - 1 : active.index - 1);
            // Nothing chosen yet (only "New …" rows): Enter and Tab keep their usual meaning.
            else if ((event.key === "Enter" || event.key === "Tab") && plain && active.index >= 0) choose(view, active, active.index);
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
            if (active.creates.length) {
              const group = document.createElement("div");
              group.setAttribute("role", "group");
              const heading = document.createElement("div");
              heading.className = "ghw-mention-group";
              heading.id = `${LISTBOX}-group-new`;
              heading.setAttribute("role", "presentation");
              heading.textContent = "New entry";
              group.setAttribute("aria-labelledby", heading.id);
              group.append(heading);
              for (const type of active.creates) {
                const index = i++;
                const option = document.createElement("div");
                option.id = optionId(index);
                option.setAttribute("role", "option");
                option.setAttribute("aria-selected", String(index === active.index));
                const name = active.query.trim();
                option.textContent = name ? `New ${type.label.toLowerCase()} “${name}”` : `New ${type.label.toLowerCase()}…`;
                option.addEventListener("mousedown", (e) => e.preventDefault());
                option.addEventListener("click", () => {
                  const now = mentionSuggestKey.getState(view.state)?.active;
                  if (now) choose(view, now, index);
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
            if (active.index >= 0) document.getElementById(optionId(active.index))?.scrollIntoView({ block: "nearest" });
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
