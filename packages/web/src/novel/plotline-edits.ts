import type { YamlEdit } from "@gh-writer/core";

/** A scene's lists of entries. */
export type SceneList = "characters" | "locations" | "themes" | "plotlines" | "entities";

/** One change to an entry in a scene's list: add it, remove it, or set (undefined: drop) one of its fields. */
export type EntryChange = { add: true } | { remove: true } | { field: string; value: string | number | undefined };

type Item = string | { id: string; [key: string]: unknown };

/**
 * The front-matter edits for one change to an entry in a scene's list, touching only the lines it
 * must: adding appends the bare ID; a field on a bare ID turns it into a map; a field set to
 * undefined is removed; removing takes the item's lines out (an emptied list stays, as `[]`).
 * `fm` is the scene's front matter as written.
 */
export function entryEdits(fm: Record<string, unknown>, list: SceneList, id: string, change: EntryChange): YamlEdit[] {
  const items: Item[] = Array.isArray(fm[list]) ? (fm[list] as Item[]) : [];
  const i = items.findIndex((p) => (typeof p === "string" ? p : p.id) === id);
  if ("add" in change) {
    if (i >= 0) return [];
    return [items.length ? { path: [list, items.length], value: id } : { path: [list], value: [id] }];
  }
  if (i < 0) return [];
  if ("remove" in change) return [items.length === 1 ? { path: [list], value: [] } : { path: [list, i], remove: true }];
  const { field, value } = change;
  const item = items[i]!;
  if (typeof item === "string") return value === undefined ? [] : [{ path: [list, i], value: { id: item, [field]: value } }];
  return [value === undefined ? { path: [list, i, field], remove: true } : { path: [list, i, field], value }];
}

export type PlotlineChange = { link: true } | { remove: true } | { weight: "major" | "minor" } | { beat: string };

/** A change to a scene's link to a plotline (major is the default weight, so it's never written). */
export function plotlineEdits(fm: Record<string, unknown>, plotline: string, change: PlotlineChange): YamlEdit[] {
  if ("link" in change) return entryEdits(fm, "plotlines", plotline, { add: true });
  if ("remove" in change) return entryEdits(fm, "plotlines", plotline, { remove: true });
  if ("weight" in change) return entryEdits(fm, "plotlines", plotline, { field: "weight", value: change.weight === "major" ? undefined : change.weight });
  return entryEdits(fm, "plotlines", plotline, { field: "beat", value: change.beat.trim() || undefined });
}
