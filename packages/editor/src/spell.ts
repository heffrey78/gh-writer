import { Extension, type Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { writingModes, type EditorCommand } from "./modes.ts";
import { SpellEngine, type Misspellings, type SpellDictionary } from "./spell-engine.ts";
import type { SpellRequest } from "./spell.worker.ts";

/*
 * Spell checking for scene prose.
 *
 * The browser's own spell checker can't be given the story's names, has no API for
 * suggestions and differs between webviews, so checking is done by nspell (Hunspell-compatible)
 * with a Hunspell dictionary, in a Web Worker. Known words are the story bible's names and
 * aliases plus the novel's dictionary.txt (see @gh-writer/core/dictionary).
 *
 * Paragraphs are checked once typing pauses, and only paragraphs that changed: results are
 * cached per node, and ProseMirror reuses untouched nodes. Misspellings are inline decorations
 * with aria-invalid="spelling".
 */

export type { SpellDictionary } from "./spell-engine.ts";

export interface SpellService {
  /** Misspelled ranges in each text. */
  check(texts: string[]): Promise<Misspellings[]>;
  suggest(word: string): Promise<string[]>;
  /** Accept words from now on (Ignore, or Add before the dictionary file is saved). */
  add(words: string[]): void;
  /** Replace the novel's known words: bible names and aliases, and dictionary.txt. */
  setKnown(words: string[]): void;
  /** Called when accepted words change, so editors check again. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

function listeners() {
  const set = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      set.add(listener);
      return () => void set.delete(listener);
    },
    notify: () => set.forEach((l) => l()),
  };
}

/** A service running the engine on this thread: for tests, or where workers aren't available. */
export function createLocalSpellService(dictionary: SpellDictionary, known: string[] = []): SpellService {
  const engine = new SpellEngine(dictionary, known);
  const { subscribe, notify } = listeners();
  return {
    check: async (texts) => texts.map((t) => engine.misspellings(t)),
    suggest: async (word) => engine.suggest(word),
    add: (words) => {
      engine.add(words);
      notify();
    },
    setKnown: (words) => {
      engine.setKnown(words);
      notify();
    },
    subscribe,
    dispose: () => {},
  };
}

/** A service running the engine in a Web Worker, so loading and suggestions never stall typing. */
export function createWorkerSpellService(
  dictionary: SpellDictionary,
  known: string[] = [],
  worker: Worker = new Worker(new URL("./spell.worker.ts", import.meta.url), { type: "module" }),
): SpellService {
  const { subscribe, notify } = listeners();
  const waiting = new Map<number, (result: unknown) => void>();
  let next = 0;
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const resolve = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    if (event.data.error) console.error("Spell checker:", event.data.error);
    resolve?.(event.data.result);
  };
  type Body = SpellRequest extends infer R ? (R extends SpellRequest ? Omit<R, "id"> : never) : never;
  const request = <T>(body: Body) =>
    new Promise<T>((resolve) => {
      const id = next++;
      waiting.set(id, resolve as (result: unknown) => void);
      worker.postMessage({ ...body, id });
    });
  void request({ type: "init", dictionary, known });
  return {
    check: (texts) => request<Misspellings[]>({ type: "check", texts }).then((r) => r ?? texts.map(() => [])),
    suggest: (word) => request<string[]>({ type: "suggest", word }).then((r) => r ?? []),
    add: (words) => void request({ type: "add", words }).then(notify),
    setKnown: (words) => void request({ type: "known", known: words }).then(notify),
    subscribe,
    dispose: () => worker.terminate(),
  };
}

// ---------------------------------------------------------------------------
// Extension

export interface SpellCheckOptions {
  service: SpellService | null;
  /** Called with a word the writer adds to the novel's dictionary, for the app to save. */
  onAddWord?: (word: string) => void;
  /** How long typing must pause before changed paragraphs are checked, in milliseconds. */
  delay: number;
}

const spellKey = new PluginKey<DecorationSet>("ghwSpellCheck");
const OBJECT = "￼";

/** A textblock's text with one character per position: atoms (mentions) are never checked. */
const textOf = (block: Node) => block.textBetween(0, block.content.size, undefined, (leaf) => (leaf.type.name === "hard_break" ? "\n" : OBJECT));

export const SpellCheckExtension = Extension.create<SpellCheckOptions>({
  name: "spellCheck",
  addOptions: () => ({ service: null, onAddWord: undefined, delay: 500 }),
  addKeyboardShortcuts() {
    return { "Mod-.": () => openSpellingMenu(this.editor) };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin<DecorationSet>({
        key: spellKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => (tr.getMeta(spellKey) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
        },
        props: {
          decorations: (state) => spellKey.getState(state),
          // With a checker of our own, the browser's would only double the underlines and flag names.
          attributes: (): Record<string, string> => (options.service ? { spellcheck: "false" } : {}),
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at || !misspellingAt(view, at.pos)) return false;
              event.preventDefault();
              openSpellingMenu(editor, at.pos);
              return true;
            },
          },
        },
        view: (view) => checker(view, options),
      }),
    ];
  },
});

function checker(view: EditorView, options: SpellCheckOptions) {
  let cache = new WeakMap<Node, Misspellings>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const { service } = options;

  const publish = (set: DecorationSet) => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(spellKey, set).setMeta("addToHistory", false));
  };

  const run = async () => {
    timer = undefined;
    if (!service || !writingModes.getState().spellcheck) {
      if (spellKey.getState(view.state) !== DecorationSet.empty) publish(DecorationSet.empty);
      return;
    }
    const gen = ++generation;
    const blocks = new Set<Node>();
    view.state.doc.descendants((node) => {
      if (!node.isTextblock) return true;
      if (!node.type.spec.code && !cache.has(node)) blocks.add(node);
      return false;
    });
    if (blocks.size) {
      const list = [...blocks];
      const results = await service.check(list.map(textOf));
      list.forEach((block, i) => cache.set(block, results[i] ?? []));
    }
    // A newer check is on its way; it will publish.
    if (gen !== generation || view.isDestroyed) return;
    const decorations: Decoration[] = [];
    view.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      for (const [from, to] of cache.get(node) ?? []) {
        decorations.push(Decoration.inline(pos + 1 + from, pos + 1 + to, { class: "ghw-misspelled", "aria-invalid": "spelling" }));
      }
      return false;
    });
    publish(DecorationSet.create(view.state.doc, decorations));
  };

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  schedule(0);
  const offModes = writingModes.subscribe((modes, prev) => modes.spellcheck !== prev.spellcheck && schedule(0));
  const offService = service?.subscribe(() => {
    cache = new WeakMap();
    schedule(0);
  });
  return {
    update: (view: EditorView, before: { doc: Node }) => {
      if (view.state.doc !== before.doc) schedule(options.delay);
    },
    destroy: () => {
      clearTimeout(timer);
      offModes();
      offService?.();
      closeSpellingMenu();
    },
  };
}

function misspellingAt(view: EditorView, pos: number): { from: number; to: number } | undefined {
  const found = spellKey.getState(view.state)?.find(pos, pos);
  return found?.[0] ? { from: found[0].from, to: found[0].to } : undefined;
}

// ---------------------------------------------------------------------------
// Suggestions menu

let openMenu: { element: HTMLElement; close: (refocus: boolean) => void } | null = null;

export function closeSpellingMenu(): void {
  openMenu?.close(false);
}

/**
 * Open the suggestions menu for the misspelling at `pos` (default: the caret). Keyboard:
 * arrows move, Enter chooses, Escape returns to the text. Returns false if there's no
 * misspelling there.
 */
export function openSpellingMenu(editor: Editor, pos = editor.state.selection.head): boolean {
  const ext = editor.extensionManager.extensions.find((e) => e.name === "spellCheck");
  const options = ext?.options as SpellCheckOptions | undefined;
  const view = editor.view;
  const range = misspellingAt(view, pos);
  if (!options?.service || !range) return false;
  const { service } = options;
  closeSpellingMenu();
  const word = view.state.doc.textBetween(range.from, range.to);

  const menu = document.createElement("div");
  menu.className = "ghw-spell-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Spelling of “${word}”`);
  const coords = view.coordsAtPos(range.from);
  menu.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 260))}px`;
  // Below the word, or above it when there isn't room (the menu grows when suggestions arrive).
  const place = () => {
    const height = menu.offsetHeight;
    const below = coords.bottom + 6;
    const above = coords.top - 6 - height;
    menu.style.top = `${below + height <= window.innerHeight - 8 || above < 8 ? below : above}px`;
  };

  const item = (label: string, action?: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.tabIndex = -1;
    if (action) button.addEventListener("click", action);
    else button.setAttribute("aria-disabled", "true");
    menu.append(button);
    return button;
  };
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')];

  const still = () => !view.isDestroyed && view.state.doc.textBetween(range.from, range.to) === word;
  const replace = (text: string) => () => {
    if (still()) view.dispatch(view.state.tr.insertText(text, range.from, range.to).scrollIntoView());
    close(true);
  };
  const accept = (persist: boolean) => () => {
    service.add([word]);
    if (persist) options.onAddWord?.(word);
    close(true);
  };

  const close = (refocus: boolean) => {
    if (openMenu?.element !== menu) return;
    openMenu = null;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    if (refocus && !view.isDestroyed) view.focus();
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as globalThis.Node)) close(false);
  };

  menu.addEventListener("keydown", (event) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") focus(at + 1);
    else if (event.key === "ArrowUp") focus(at - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(list.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") close(true);
    else return;
    event.preventDefault();
  });

  const pendingItem = item("Finding suggestions…");
  const separator = document.createElement("div");
  separator.setAttribute("role", "separator");
  menu.append(separator);
  if (options.onAddWord) item(`Add “${word}” to dictionary`, accept(true));
  item("Ignore", accept(false));

  document.body.append(menu);
  place();
  document.addEventListener("pointerdown", outside, true);
  openMenu = { element: menu, close };
  const first = items()[0];
  first?.focus();

  void service.suggest(word).then((suggestions) => {
    if (openMenu?.element !== menu) return;
    pendingItem.replaceWith(...(suggestions.length ? suggestions.map((s) => item(s, replace(s))) : [item("No suggestions")]));
    place();
    // Suggestions come first: focus the best one, unless the writer has already moved on.
    if (document.activeElement === first) items()[0]?.focus();
  });
  return true;
}

export const spellCommands: EditorCommand[] = [
  {
    id: "editor.toggleSpellCheck",
    title: "Spell check",
    run: (editor) => {
      writingModes.getState().toggle("spellcheck");
      if (editor && !editor.isDestroyed) editor.commands.focus(null, { scrollIntoView: false });
    },
    isActive: () => writingModes.getState().spellcheck,
  },
  { id: "editor.spellingSuggestions", title: "Spelling suggestions", keys: "Mod-.", run: (editor) => void (editor && openSpellingMenu(editor)) },
];
