import { gridKey, presence, sceneColumns, type PresenceMatrix } from "./diagrams.ts";
import type { Novel, Scene, StoryEvent } from "./model.ts";
import { backlinks } from "./queries.ts";

/**
 * How an entry is in a scene: carrying it (a character's point of view, a plotline's major beat, a
 * theme at its strongest), present (in the scene's details), only mentioned in the prose, or absent.
 */
export type PresenceMark = "carries" | "present" | "mentioned" | "absent";

export interface EntryPresence {
  /** Every scene in reading order, with how the entry is in it. */
  scenes: { scene: Scene; mark: PresenceMark }[];
  chapters: ReturnType<typeof sceneColumns>["chapters"];
  parts: ReturnType<typeof sceneColumns>["parts"];
  /** Scenes it's in, any way. */
  count: number;
  /** Scenes it carries. */
  carries: number;
  first?: Scene;
  last?: Scene;
  /** The longest run of scenes without it between two it's in. */
  longestAbsence?: { scenes: number; from: Scene; to: Scene };
  /** Off-page events it's part of. */
  events: StoryEvent[];
}

/**
 * Where an entry is across the book (#159), from the same marks as the Presence view: the strip of
 * scenes on its profile, and the facts beneath it. Undefined for an ID the novel doesn't have.
 */
export function entryPresence(novel: Novel, id: string): EntryPresence | undefined {
  const entity = novel.entities.find((e) => e.id === id);
  return entity && fromMatrix(novel, presence(novel, entity.type), id);
}

/** Every entry's presence, by ID: each type's marks worked out once (the bible's gallery). */
export function entryPresences(novel: Novel): Map<string, EntryPresence> {
  const out = new Map<string, EntryPresence>();
  for (const type of new Set(novel.entities.map((e) => e.type))) {
    const matrix = presence(novel, type);
    for (const e of novel.entities) if (e.type === type) out.set(e.id, fromMatrix(novel, matrix, e.id));
  }
  return out;
}

function fromMatrix(novel: Novel, matrix: PresenceMatrix, id: string): EntryPresence {
  const scenes = matrix.scenes.map((scene) => {
    const p = matrix.marks.get(gridKey(id, scene.id));
    const mark: PresenceMark = !p
      ? "absent"
      : p.pov || p.weight === "major" || p.strength === 3
        ? "carries"
        : p.listed
          ? "present"
          : "mentioned";
    return { scene, mark };
  });
  const at = scenes.flatMap((s, i) => (s.mark === "absent" ? [] : [i]));
  let longestAbsence: EntryPresence["longestAbsence"];
  for (let k = 1; k < at.length; k++) {
    const away = at[k]! - at[k - 1]! - 1;
    if (away > 0 && away > (longestAbsence?.scenes ?? 0)) longestAbsence = { scenes: away, from: scenes[at[k - 1]! + 1]!.scene, to: scenes[at[k]! - 1]!.scene };
  }
  const first = at.length ? scenes[at[0]!]!.scene : undefined;
  const last = at.length ? scenes[at.at(-1)!]!.scene : undefined;
  return {
    scenes,
    chapters: matrix.chapters,
    parts: matrix.parts,
    count: at.length,
    carries: scenes.filter((s) => s.mark === "carries").length,
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(longestAbsence ? { longestAbsence } : {}),
    events: backlinks(novel, id).events,
  };
}
