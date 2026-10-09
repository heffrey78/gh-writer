import { uniqueId, type Novel } from "@gh-writer/core";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useRef } from "react";
import { api, keys } from "../api.ts";
import { useEntryPanel } from "../novel/mention-card.tsx";
import { useNotice } from "../novel/notice.tsx";

/**
 * Make a story bible entry where the author is (the @ menu, a scene's details) without leaving it.
 * `create` picks the new entry's ID at once and returns it, so a mention or a scene's list can use it
 * straight away; the file is written in the background, and a notice offers to fill in the details
 * beside the text.
 */
export function useQuickEntry(novelId: string, novel: Novel, editor: Editor | undefined) {
  const queryClient = useQueryClient();
  const show = useNotice((n) => n.show);
  // IDs handed out whose files aren't in the model yet: never handed out twice.
  const pending = useRef(new Set<string>());
  const latest = useRef({ novel, editor });
  latest.current = { novel, editor };

  const create = (type: string, name: string): string | undefined => {
    const { novel } = latest.current;
    const def = novel.entityTypes.find((t) => t.key === type);
    const trimmed = name.trim();
    if (!def || !trimmed) return undefined;
    const id = uniqueId(def.prefix, new Set([...novel.entities.map((e) => e.id), ...pending.current]));
    pending.current.add(id);
    api.bible
      .createEntity(novelId, type, { name: trimmed }, undefined, id)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
        const ed = latest.current.editor;
        show({
          message: `Added ${def.label.toLowerCase()} “${trimmed}” to the story bible.`,
          ...(ed ? { action: { label: "Add details", run: () => useEntryPanel.getState().open(id, ed) } } : {}),
        });
      })
      .catch((e: unknown) => show({ message: `Couldn't add “${trimmed}”: ${e instanceof Error ? e.message : String(e)}` }))
      .finally(() => pending.current.delete(id));
    return id;
  };

  return { types: novel.entityTypes.map((t) => ({ key: t.key, label: t.label })), create };
}
