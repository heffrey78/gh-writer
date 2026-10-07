import type { Chapter, Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, keys } from "../api.ts";
import { chapterTitle } from "./navigation.tsx";
import { useNotice } from "./notice.tsx";
import type { Workspace } from "./workspace.ts";

export type ItemKind = "part" | "chapter" | "scene";

/** What an ID is in the manuscript, with its title for messages. */
export function itemOf(novel: Novel, id: string): { kind: ItemKind; title: string } | undefined {
  const scene = novel.allScenes.find((s) => s.id === id);
  if (scene) return { kind: "scene", title: scene.title };
  const chapter = novel.allChapters.find((c) => c.id === id);
  if (chapter) return { kind: "chapter", title: chapterTitle(novel, chapter) };
  const part = novel.allParts.find((p) => p.id === id);
  return part ? { kind: "part", title: part.title } : undefined;
}

/** The ordered list an item sits in, and the container it belongs to (null: the top level). */
export function siblingsOf(novel: Novel, id: string): { container: string | null; list: string[] } | undefined {
  const scene = novel.allScenes.find((s) => s.id === id);
  if (scene) {
    const chapter = novel.allChapters.find((c) => c.id === scene.chapterId);
    return chapter ? { container: chapter.id, list: chapter.sceneIds } : undefined;
  }
  const chapter = novel.allChapters.find((c) => c.id === id);
  if (chapter) {
    if (chapter.partId) return { container: chapter.partId, list: novel.allParts.find((p) => p.id === chapter.partId)?.chapterIds ?? [] };
    return { container: null, list: novel.chapters.map((c) => c.id) };
  }
  return novel.allParts.some((p) => p.id === id) ? { container: null, list: novel.parts.map((p) => p.id) } : undefined;
}

/**
 * Where moving `id` up or down one place takes it: the server's `index` (in the list after it's taken
 * out) and container. A scene at the edge of its chapter goes to the end of the previous chapter or
 * the start of the next; anything else at an edge stays put (undefined).
 */
export function stepMove(novel: Novel, id: string, direction: -1 | 1): { index: number; to: string | null } | undefined {
  const at = siblingsOf(novel, id);
  if (!at) return undefined;
  const i = at.list.indexOf(id);
  const j = i + direction;
  if (j >= 0 && j < at.list.length) return { index: j, to: at.container };
  if (itemOf(novel, id)?.kind !== "scene") return undefined;
  const chapters = novel.chapters;
  const c = chapters.findIndex((x) => x.id === at.container);
  const next: Chapter | undefined = chapters[c + direction];
  if (!next) return undefined;
  return { index: direction < 0 ? next.sceneIds.length : 0, to: next.id };
}

/** Moving `id` to just before or after `target`, an item of the same kind: the server's index and container. */
export function dropMove(novel: Novel, id: string, target: string, after: boolean): { index: number; to: string | null } | undefined {
  const at = siblingsOf(novel, target);
  if (!at || id === target) return undefined;
  const list = at.list.filter((x) => x !== id);
  return { index: list.indexOf(target) + (after ? 1 : 0), to: at.container };
}

/** Moves waiting their turn, per novel, shared by every view (tree, outline, corkboard, swimlanes). */
const queues = new Map<string, Promise<unknown>>();

/** Run `task` after the novel's earlier moves have finished. */
function enqueue<T>(novelId: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(novelId) ?? Promise.resolve()).catch(() => {}).then(task);
  queues.set(novelId, next);
  return next;
}

/**
 * Structural changes from the UI: unsaved text is saved first, the model is reloaded after, and the
 * result (or the reason it failed) is announced; a delete offers Undo.
 */
export function useStructure(novelId: string, novel: Novel, workspace: Workspace) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const show = useNotice((s) => s.show);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
  const m = api.manuscript;

  async function run<T>(what: string, op: () => Promise<T>, done?: (result: T) => string | undefined): Promise<T | undefined> {
    await workspace.autosave.flush();
    try {
      const result = await op();
      await refresh();
      const message = done?.(result);
      if (message) show({ message });
      return result;
    } catch (e) {
      show({ message: `Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}` });
      return undefined;
    }
  }

  const name = (id: string) => itemOf(novel, id)?.title ?? id;
  const where = (to: string | null) => (to ? (itemOf(novel, to)?.title ?? "") : "the top level");

  return {
    move: (id: string, index: number, to: string | null) =>
      enqueue(novelId, () => run("move it", () => m.move(novelId, id, index, to), () => `Moved “${name(id)}” to ${where(to)}, position ${index + 1}.`)),
    // Each step is worked out when its turn comes, from the model as the moves before it left it:
    // two quick presses move two places, not one twice.
    step: (id: string, direction: -1 | 1) =>
      enqueue(novelId, async () => {
        const now = queryClient.getQueryData<{ novel: Novel }>(keys.novel(novelId))?.novel ?? novel;
        const target = stepMove(now, id, direction);
        if (!target) return undefined;
        const into = target.to !== siblingsOf(now, id)?.container ? ` into “${(target.to && itemOf(now, target.to)?.title) || ""}”` : "";
        return run("move it", () => m.move(novelId, id, target.index, target.to), () => `Moved “${name(id)}” ${direction < 0 ? "up" : "down"}${into}.`);
      }),
    rename: (id: string, title: string) => run("rename it", () => m.rename(novelId, id, title), () => `Renamed to “${title}”.`),
    createScene: (chapter: string, title: string, after?: string | null) =>
      run("add the scene", () => m.createScene(novelId, chapter, title, after), ({ id }) => {
        void navigate(`/novels/${novelId}/scene/${id}`);
        return `Added the scene “${title}”.`;
      }),
    createChapter: (part: string | null, title: string | undefined, after?: string | null) =>
      run("add the chapter", () => m.createChapter(novelId, part, title, after), ({ id }) => {
        void navigate(`/novels/${novelId}/chapter/${id}`);
        return `Added the chapter${title ? ` “${title}”` : ""}.`;
      }),
    remove: (id: string) => {
      const item = itemOf(novel, id);
      return run("delete it", () => m.delete(novelId, id), (result) => {
        show({
          message: `Deleted the ${item?.kind ?? "item"} “${item?.title ?? id}”.`,
          ...(result.commit ? { action: { label: "Undo", run: () => void run("bring it back", () => m.restore(novelId, result.commit!, id), () => `“${item?.title ?? id}” is back.`) } } : {}),
        });
        return undefined;
      });
    },
    restore: (commit: string, id: string, title: string) => run("bring it back", () => m.restore(novelId, commit, id), () => `“${title}” is back.`),
    split: (scene: string, paragraph: number, title: string) =>
      run("split the scene", () => m.split(novelId, scene, paragraph, title), () => `Split “${name(scene)}”: the rest is now “${title}”.`),
    merge: (scene: string) => {
      const chapter = novel.allChapters.find((c) => c.sceneIds.includes(scene));
      const next = chapter?.sceneIds[chapter.sceneIds.indexOf(scene) + 1];
      return run("merge the scenes", () => m.merge(novelId, scene), () => `Merged “${next ? name(next) : "the next scene"}” into “${name(scene)}”.`);
    },
  };
}

export type Structure = ReturnType<typeof useStructure>;
