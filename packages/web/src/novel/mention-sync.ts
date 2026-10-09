import { mentions, readFrontMatter, type Novel, type YamlEdit } from "@gh-writer/core";

/** The scene lists a mention of each entity type adds to. */
// Characters and locations, and custom types (`entities`); plotlines and themes are the author's to list.
const listFor = (type: string): "characters" | "locations" | "entities" | undefined =>
  type === "character" ? "characters" : type === "location" ? "locations" : type === "plotline" || type === "theme" ? undefined : "entities";

/**
 * The front-matter edits that list, in a scene's characters or locations, the people and places
 * just mentioned in it (in `after` but not `before`) and not listed yet. Only new mentions count:
 * someone the author took off the list stays off while the old mentions stay, and nothing is
 * ever removed.
 */
export function mentionEdits(novel: Novel, file: string, before: string, after: string): YamlEdit[] {
  const had = new Set(mentions(before).map((m) => m.id));
  const added = [...new Set(mentions(after).map((m) => m.id))].filter((id) => !had.has(id));
  if (!added.length) return [];
  const fm = readFrontMatter(file) ?? {};
  const lists = { characters: [...asList(fm.characters)], locations: [...asList(fm.locations)], entities: [...asList(fm.entities)] };
  const edits: YamlEdit[] = [];
  for (const id of added) {
    // By its ID's prefix when it isn't in the model yet (just made from the @ menu).
    const type = novel.entities.find((e) => e.id === id)?.type ?? novel.entityTypes.find((t) => id.startsWith(`${t.prefix}_`))?.key;
    const key = type && listFor(type);
    if (!key || lists[key].includes(id)) continue;
    const list = lists[key];
    edits.push(list.length ? { path: [key, list.length], value: id } : { path: [key], value: [id] });
    list.push(id);
  }
  return edits;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
