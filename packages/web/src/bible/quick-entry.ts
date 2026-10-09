import { readFrontMatter, uniqueId, type Novel, type YamlEdit } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { useRef } from "react";
import { create } from "zustand";
import type { Workspace } from "../novel/workspace.ts";
import type { QuickEntries } from "./quick-entries.ts";

/**
 * Make story bible entries where the author is (the @ menu, a scene's details) without leaving it:
 * `create` picks the new entry's ID and returns it at once, so a mention or a scene's list can use
 * it straight away, and queues the entry to be written (see createQuickEntries).
 */
export function useQuickEntry(novel: Novel, entries: QuickEntries | undefined) {
  const latest = useRef(novel);
  latest.current = novel;

  const create = (type: string, name: string): string | undefined => {
    const novel = latest.current;
    const def = novel.entityTypes.find((t) => t.key === type);
    const trimmed = name.trim();
    if (!entries || !def || !trimmed) return undefined;
    const id = uniqueId(def.prefix, new Set([...novel.entities.map((e) => e.id), ...entries.ids()]));
    entries.add({ id, type, name: trimmed });
    return id;
  };

  return { types: novel.entityTypes.map((t) => ({ key: t.key, label: t.label })), create, ask: askName };
}

/** The name the author is being asked for (NameEntryDialog), and where the answer goes. */
export const useNaming = create<{ type: string | undefined; answer: (name: string | undefined) => void }>(() => ({ type: undefined, answer: () => {} }));

/** Ask the author to name a new entry of `type`: undefined if they cancel. */
function askName(type: string): Promise<string | undefined> {
  useNaming.getState().answer(undefined);
  return new Promise((resolve) =>
    useNaming.setState({
      type,
      answer: (name) => {
        useNaming.setState({ type: undefined, answer: () => {} });
        resolve(name);
      },
    }),
  );
}

const LISTS = ["characters", "locations", "entities", "plotlines", "themes"] as const;

/**
 * Undo the links to an entry that won't be made: in every open file its mentions become their
 * words as plain text, and it comes off the scene's lists and point of view.
 */
export function unlink(workspace: Workspace, id: string): void {
  const link = new RegExp(`\\[([^\\]\\n]*)\\]\\(#${id}\\)`, "g");
  for (const path of Object.keys(workspace.store.getState().files)) {
    const body = workspace.current(path);
    if (body?.includes(`(#${id})`)) workspace.change(path, body.replace(link, "$1"));
    const f = workspace.store.getState().files[path];
    const fm = f ? readFrontMatter(joinSceneFile(f)) : undefined;
    if (!fm) continue;
    const edits: YamlEdit[] = fm.pov === id ? [{ path: ["pov"], remove: true }] : [];
    for (const key of LISTS) {
      const list: unknown[] = Array.isArray(fm[key]) ? fm[key] : [];
      const at = list.flatMap((item, i) => ((typeof item === "string" ? item : (item as { id?: unknown } | null)?.id) === id ? [i] : []));
      if (!at.length) continue;
      if (at.length === list.length) edits.push({ path: [key], value: [] });
      else for (const i of at.reverse()) edits.push({ path: [key, i], remove: true });
    }
    if (edits.length) void workspace.editFrontMatter(path, edits);
  }
}
