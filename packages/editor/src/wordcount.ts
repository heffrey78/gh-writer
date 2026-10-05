import { countText, countWords, proseText } from "@gh-writer/core";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/*
 * Live word counts: per scene, per chapter (the open document) and for the writing session.
 *
 * Counts follow core's countWords, so the editor agrees with the CLI and progress history. They
 * are cached per node: ProseMirror reuses untouched nodes, so after a keystroke only the edited
 * paragraph is recounted and every other block, and every untouched scene, is a cache hit.
 */

const counted = new WeakMap<Node, number>();

/** Words in a node, as countWords would count its Markdown. */
export function countNode(node: Node): number {
  let n = counted.get(node);
  if (n !== undefined) return n;
  if (node.type.name === "raw_block") n = countWords(node.textContent);
  else if (node.isTextblock) n = countText(node.textBetween(0, node.content.size, " ", leafText));
  else {
    n = 0;
    node.forEach((child) => void (n! += countNode(child)));
  }
  counted.set(node, n);
  return n;
}

function leafText(leaf: Node): string {
  switch (leaf.type.name) {
    case "mention":
      return leaf.attrs.label;
    case "raw_inline":
      return proseText(leaf.attrs.text);
    default:
      return " ";
  }
}

/** Word counts of a document: each scene's (a single-scene document is one scene) and the total. */
export function documentCounts(doc: Node, sceneId: string): { scenes: Map<string, number>; total: number } {
  const scenes = new Map<string, number>();
  // Scenes without an ID (an editor's empty placeholder document) aren't files to track.
  if (doc.type.name === "chapter") doc.forEach((scene) => void (scene.attrs.id != null && scenes.set(scene.attrs.id, countNode(scene))));
  else scenes.set(sceneId, countNode(doc));
  return { scenes, total: countNode(doc) };
}

// ---------------------------------------------------------------------------
// Stores

export interface LiveCounts {
  /** What the editor shows: one scene, or a chapter of scenes. */
  view: "scene" | "chapter" | null;
  /** The scene holding the caret. */
  sceneId: string | null;
  scene: number;
  /** The open document: the chapter in the chapter view, else the scene. */
  chapter: number;
}

/** Counts of the editor that last changed or moved its caret. */
export const liveCounts = createStore<LiveCounts>()(() => ({ view: null, sceneId: null, scene: 0, chapter: 0 }));

export interface SessionScene {
  /** Words when the session first saw the scene. */
  baseline: number;
  current: number;
}

export interface WritingSession {
  startedAt: number;
  /** Net words to write this session, or null for no goal. */
  goal: number | null;
  scenes: Record<string, SessionScene>;
}

interface WritingSessionStore extends WritingSession {
  /** Record a scene's current count; the first count seen in a session is its baseline. */
  record(sceneId: string, words: number): void;
  setGoal(goal: number | null): void;
  /** Start a new session from the counts as they are now. */
  restart(): void;
}

function safe(storage: () => Storage): StateStorage {
  return {
    getItem: (name) => {
      try {
        return storage().getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        storage().setItem(name, value);
      } catch {}
    },
    removeItem: (name) => {
      try {
        storage().removeItem(name);
      } catch {}
    },
  };
}

// The goal is a habit, so new sessions start with the last one set.
const GOAL_KEY = "gh-writer:session-goal";
const goalStorage = safe(() => localStorage);
const lastGoal = (): number | null => {
  const goal = Number(goalStorage.getItem(GOAL_KEY));
  return Number.isFinite(goal) && goal > 0 ? goal : null;
};

/**
 * The writing session: a browser tab's session (it survives reloads, not closing the tab), so
 * session words are the net words added in this sitting, across every scene opened.
 */
export const writingSession = createStore<WritingSessionStore>()(
  persist(
    (set) => ({
      startedAt: Date.now(),
      goal: lastGoal(),
      scenes: {},
      record: (sceneId, words) =>
        set((s) => {
          const known = s.scenes[sceneId];
          if (known?.current === words) return s;
          return { scenes: { ...s.scenes, [sceneId]: { baseline: known?.baseline ?? words, current: words } } };
        }),
      setGoal: (goal) => {
        const value = goal && goal > 0 ? Math.round(goal) : null;
        if (value) goalStorage.setItem(GOAL_KEY, String(value));
        else goalStorage.removeItem(GOAL_KEY);
        set({ goal: value });
      },
      restart: () =>
        set((s) => ({
          startedAt: Date.now(),
          scenes: Object.fromEntries(Object.entries(s.scenes).map(([id, { current }]) => [id, { baseline: current, current }])),
        })),
    }),
    {
      name: "gh-writer:writing-session",
      storage: createJSONStorage(() => safe(() => sessionStorage)),
      partialize: ({ startedAt, goal, scenes }) => ({ startedAt, goal, scenes }),
    },
  ),
);

export const sessionCommands = [
  {
    id: "editor.restartWritingSession",
    title: "Start a new writing session",
    run: () => writingSession.getState().restart(),
  },
];

/** Net words added this session (negative after cutting). */
export function sessionWords(session: WritingSession): number {
  let n = 0;
  for (const { baseline, current } of Object.values(session.scenes)) n += current - baseline;
  return n;
}

// ---------------------------------------------------------------------------
// Extension

export interface WordCountOptions {
  /** The scene's ID in a single-scene editor, for session totals; chapter scenes carry their own. */
  sceneId: string;
}

const countKey = new PluginKey("ghwWordCount");

/** Publishes live counts and records scene counts for the session as the document changes. */
export const WordCountExtension = Extension.create<WordCountOptions>({
  name: "wordCount",
  addOptions: () => ({ sceneId: "scene" }),
  addProseMirrorPlugins() {
    const { sceneId } = this.options;
    return [
      new Plugin({
        key: countKey,
        view: (view) => {
          // Publish once per frame at most, off the keystroke's critical path.
          let frame = 0;
          let docChanged = true;
          const publish = () => {
            frame = 0;
            if (view.isDestroyed) return;
            const { state } = view;
            if (docChanged) {
              const session = writingSession.getState();
              for (const [id, words] of documentCounts(state.doc, sceneId).scenes) session.record(id, words);
              docChanged = false;
            }
            liveCounts.setState(caretCounts(state, sceneId));
          };
          const schedule = () => {
            if (!frame) frame = requestAnimationFrame(publish);
          };
          // The document as loaded is each scene's baseline, before any edit can land.
          const session = writingSession.getState();
          for (const [id, words] of documentCounts(view.state.doc, sceneId).scenes) session.record(id, words);
          docChanged = false;
          schedule();
          return {
            update: (view, before) => {
              if (view.state.doc !== before.doc) docChanged = true;
              if (docChanged || !view.state.selection.eq(before.selection)) schedule();
            },
            destroy: () => {
              if (frame) cancelAnimationFrame(frame);
              // Record a last edit made within the frame before the editor went away.
              if (docChanged) {
                const session = writingSession.getState();
                for (const [id, words] of documentCounts(view.state.doc, sceneId).scenes) session.record(id, words);
              }
            },
          };
        },
      }),
    ];
  },
});

function caretCounts(state: EditorState, sceneId: string): LiveCounts {
  const chapter = countNode(state.doc);
  if (state.doc.type.name !== "chapter") return { view: "scene", sceneId, scene: chapter, chapter };
  const scene = state.doc.child(Math.min(state.selection.$head.index(0), state.doc.childCount - 1));
  return { view: "chapter", sceneId: scene.attrs.id, scene: countNode(scene), chapter };
}
