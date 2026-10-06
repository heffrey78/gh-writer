import type { Novel } from "@gh-writer/core";
import { chapterTitle } from "../novel/navigation.tsx";
import type { PickerItem } from "../ui/picker.tsx";

/** Every scene in reading order, under its chapter, findable by title or chapter. */
export function sceneItems(novel: Novel): PickerItem[] {
  return novel.scenes.map((s) => {
    const chapter = novel.chapters.find((c) => c.id === s.chapterId);
    const group = chapter ? chapterTitle(novel, chapter) : "";
    return { value: s.id, label: s.title, group, keywords: [group] };
  });
}

/** Every entry, under its type, findable by name or alias. */
export function entityItems(novel: Novel, except?: string): PickerItem[] {
  return novel.entityTypes.flatMap((t) =>
    novel.entities
      .filter((e) => e.type === t.key && e.id !== except)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ value: e.id, label: e.name, group: t.label, keywords: e.aliases })),
  );
}
