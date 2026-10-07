import type { YamlEdit } from "@gh-writer/core";

export type PlotlineChange = { link: true } | { remove: true } | { weight: "major" | "minor" } | { beat: string };

type Item = string | { id: string; [key: string]: unknown };

/**
 * The front-matter edits for one change to a scene's link to a plotline, touching only the lines it
 * must: linking appends the bare ID (major is the default); a weight or beat on a bare ID turns it
 * into a map; a field set to its default (major, or no beat) is removed; removing takes the item's
 * lines out. `fm` is the scene's front matter as written.
 */
export function plotlineEdits(fm: Record<string, unknown>, plotline: string, change: PlotlineChange): YamlEdit[] {
  const items: Item[] = Array.isArray(fm.plotlines) ? (fm.plotlines as Item[]) : [];
  const i = items.findIndex((p) => (typeof p === "string" ? p : p.id) === plotline);
  if ("link" in change) {
    if (i >= 0) return [];
    return [items.length ? { path: ["plotlines", items.length], value: plotline } : { path: ["plotlines"], value: [plotline] }];
  }
  if (i < 0) return [];
  if ("remove" in change) return [items.length === 1 ? { path: ["plotlines"], value: [] } : { path: ["plotlines", i], remove: true }];
  const [field, value] = "weight" in change ? ["weight", change.weight === "major" ? undefined : change.weight] : ["beat", change.beat.trim() || undefined];
  const item = items[i]!;
  if (typeof item === "string") return value === undefined ? [] : [{ path: ["plotlines", i], value: { id: item, [field]: value } }];
  return [value === undefined ? { path: ["plotlines", i, field], remove: true } : { path: ["plotlines", i, field], value }];
}
