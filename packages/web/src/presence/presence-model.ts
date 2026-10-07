import { countWords, mentions, type Entity, type Novel, type Scene } from "@gh-writer/core";
import { gridKey, sceneColumns } from "../diagrams/columns.ts";

/** The scene field an entity type is listed in; other (custom) types are present only by mention. */
export const LISTS: Record<string, "characters" | "locations" | "themes" | "plotlines"> = {
  character: "characters",
  location: "locations",
  theme: "themes",
  plotline: "plotlines",
};

export interface Presence {
  /** In the scene's metadata (for a character: its characters, or its point of view). */
  listed: boolean;
  pov: boolean;
  /** Named in the prose (a mention). */
  mentioned: boolean;
  /** A theme's strength (1–3), or a plotline's weight. */
  strength?: number;
  weight?: "major" | "minor";
  note?: string;
}

export interface PresenceMatrix {
  type: string;
  /** Entries of the type, by name; the view sorts them. */
  rows: Entity[];
  scenes: Scene[];
  /** By gridKey(entry, scene); absent: not there at all. */
  marks: Map<string, Presence>;
  /** Each scene's words, counted once. */
  words: number[];
  chapters: ReturnType<typeof sceneColumns>["chapters"];
  parts: ReturnType<typeof sceneColumns>["parts"];
}

/**
 * Where each entry of a type is in the book: listed in a scene's metadata (characters: point of
 * view or characters; locations, themes and plotlines: their lists), and named in its prose.
 */
export function presence(novel: Novel, type: string, scenes: Scene[] = novel.scenes): PresenceMatrix {
  const rows = novel.entities.filter((e) => e.type === type).sort((a, b) => a.name.localeCompare(b.name));
  const ids = new Set(rows.map((r) => r.id));
  const marks = new Map<string, Presence>();
  for (const scene of scenes) {
    const named = new Set(mentions(scene.body).map((m) => m.id));
    const listed = new Map<string, Omit<Presence, "listed" | "pov" | "mentioned">>();
    if (type === "character") for (const id of [...(scene.pov ? [scene.pov] : []), ...scene.characters]) listed.set(id, {});
    if (type === "location") for (const id of scene.locations) listed.set(id, {});
    if (type === "theme") for (const t of scene.themes) listed.set(t.id, { ...(t.strength !== undefined ? { strength: t.strength } : {}), ...(t.note ? { note: t.note } : {}) });
    if (type === "plotline") for (const p of scene.plotlines) listed.set(p.id, { weight: p.weight, ...(p.beat ? { note: p.beat } : {}) });
    for (const id of new Set([...listed.keys(), ...named])) {
      if (!ids.has(id)) continue;
      marks.set(gridKey(id, scene.id), { ...listed.get(id), listed: listed.has(id), pov: type === "character" && scene.pov === id, mentioned: named.has(id) });
    }
  }
  return { type, rows, scenes, marks, words: scenes.map((s) => countWords(s.body)), ...sceneColumns(novel, scenes) };
}

/** How many scenes each entry is in (listed or mentioned). */
export function totals(m: PresenceMatrix): Map<string, number> {
  const out = new Map(m.rows.map((r) => [r.id, 0]));
  for (const key of m.marks.keys()) {
    const row = key.slice(0, key.indexOf("|"));
    out.set(row, (out.get(row) ?? 0) + 1);
  }
  return out;
}

export type RowOrder = "first" | "total" | "name";

/** Rows by first appearance (never-seen last), by how many scenes they're in (most first), or by name. */
export function sortRows(m: PresenceMatrix, order: RowOrder): Entity[] {
  const first = new Map<string, number>();
  m.scenes.forEach((scene, i) => {
    for (const r of m.rows) if (!first.has(r.id) && m.marks.has(gridKey(r.id, scene.id))) first.set(r.id, i);
  });
  const count = totals(m);
  const byName = (a: Entity, b: Entity) => a.name.localeCompare(b.name);
  if (order === "name") return [...m.rows].sort(byName);
  if (order === "total") return [...m.rows].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || byName(a, b));
  return [...m.rows].sort((a, b) => (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity) || byName(a, b));
}
