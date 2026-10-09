import { editFrontMatter } from "@gh-writer/core";
import { joinSceneFile, splitSceneFile } from "@gh-writer/editor";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { unlink } from "../src/bible/quick-entry.ts";
import type { OpenFile, Workspace, WorkspaceState } from "../src/novel/workspace.ts";

/** The parts of a workspace unlink uses, over files kept as text. */
function workspace(texts: Record<string, string>, typed: Record<string, string> = {}) {
  const files: Record<string, OpenFile> = {};
  for (const [path, text] of Object.entries(texts)) files[path] = { path, ...splitSceneFile(text), disk: text, hash: "h" };
  const store = createStore<WorkspaceState>(() => ({ files, conflicts: [], error: undefined }));
  const set = (path: string, f: OpenFile) => store.setState((s) => ({ files: { ...s.files, [path]: f } }));
  const ws = {
    store,
    current: (path: string) => typed[path] ?? store.getState().files[path]?.body,
    change: (path: string, body: string) => set(path, { ...store.getState().files[path]!, body }),
    editFrontMatter: async (path: string, edits: Parameters<Workspace["editFrontMatter"]>[1]) => {
      const f = store.getState().files[path]!;
      set(path, { ...f, frontMatter: splitSceneFile(editFrontMatter(joinSceneFile(f), edits)).frontMatter });
    },
  } as unknown as Workspace;
  const text = (path: string) => joinSceneFile(store.getState().files[path]!);
  return { ws, text };
}

describe("unlinking an entry that won't be made", () => {
  it("turns its mentions into their words, with what's been typed, and takes it off the scene's lists", () => {
    const { ws, text } = workspace(
      {
        "a.md": "---\nid: sc_aaaaaa\ntitle: A\npov: char_m1rak0\ncharacters: [char_7f3k2q, char_m1rak0]\n---\nShe met [Mira](#char_m1rak0) and [Ada](#char_7f3k2q).\n",
        "b.md": "---\nid: sc_bbbbbb\ntitle: B\nentities: [art_1edg3r]\nthemes:\n  - id: theme_aaaaaa\n---\nNothing here.\n",
      },
      { "a.md": "She met [Mira](#char_m1rak0) and [Ada](#char_7f3k2q). [Mira Kostova](#char_m1rak0) left.\n" },
    );
    unlink(ws, "char_m1rak0");
    expect(text("a.md")).toBe("---\nid: sc_aaaaaa\ntitle: A\ncharacters: [char_7f3k2q]\n---\nShe met Mira and [Ada](#char_7f3k2q). Mira Kostova left.\n");
    unlink(ws, "art_1edg3r");
    expect(text("b.md")).toBe("---\nid: sc_bbbbbb\ntitle: B\nentities: []\nthemes:\n  - id: theme_aaaaaa\n---\nNothing here.\n");
  });
});
