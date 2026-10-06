import type { Entity, Novel } from "@gh-writer/core";
import type { MentionEntity } from "@gh-writer/editor";

/** A type's name for a list of its entries: "Characters". */
export const plural = (label: string) => (/(s|x|ch|sh)$/i.test(label) ? `${label}es` : /[^aeiou]y$/i.test(label) ? `${label.slice(0, -1)}ies` : `${label}s`);

export const typeOf = (novel: Novel, entity: Entity) => novel.entityTypes.find((t) => t.key === entity.type);

/** Entries of each type, sorted by name. */
export function entriesByType(novel: Novel): { type: Novel["entityTypes"][number]; entries: Entity[] }[] {
  return novel.entityTypes.map((type) => ({
    type,
    entries: novel.entities.filter((e) => e.type === type.key).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Whether an entry matches a search, by name or alias. */
export const matches = (entity: Entity, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || [entity.name, ...entity.aliases].some((n) => n.toLowerCase().includes(q));
};

/** Every entry, for @ suggestions: by type in the bible's order, then by name. */
export function mentionEntities(novel: Novel): MentionEntity[] {
  return novel.entityTypes.flatMap((t) =>
    novel.entities
      .filter((e) => e.type === t.key)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases, type: t.label })),
  );
}
