import { readFrontMatter, type Scene, type YamlEdit } from "@gh-writer/core";
import { joinSceneFile } from "@gh-writer/editor";
import { useQueryClient } from "@tanstack/react-query";
import { api, keys } from "../api.ts";
import { useNotice } from "./notice.tsx";
import type { Workspace } from "./workspace.ts";

/**
 * Edit a scene's front matter from a view: `edits` works out the changes from the front matter as
 * written (the open file's, or the file on disk), they're made through the workspace (autosaved,
 * merged like typing), and the model is reloaded so every view shows them. `done` is announced.
 */
export function useSceneEdit(novelId: string, workspace: Workspace) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  return async (scene: Scene, edits: (fm: Record<string, unknown>) => YamlEdit[], done?: string) => {
    try {
      const open = workspace.store.getState().files[scene.file];
      const text = open ? joinSceneFile(open) : (await api.readFile(novelId, scene.file)).content;
      const changes = edits(readFrontMatter(text) ?? {});
      if (!changes.length) return;
      await workspace.editFrontMatter(scene.file, changes);
      await workspace.autosave.flush();
      await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
      if (done) show({ message: done });
    } catch (e) {
      show({ message: `Couldn't change “${scene.title}”: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
}
