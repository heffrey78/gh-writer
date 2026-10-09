import { mentions, sceneById, type Novel, type Relationship, type Scene, type StoryEvent } from "./model.ts";

/** How a scene refers to an entity. */
export type SceneLink = "pov" | "characters" | "locations" | "entities" | "plotlines" | "themes" | "mention";

export interface Backlinks {
  /** Scenes that name the entity, in reading order (scenes outside the order last), with how. */
  scenes: { scene: Scene; via: SceneLink[] }[];
  /** Relationships it takes part in, from either end. */
  relationships: Relationship[];
  /** Off-page events it's part of. */
  events: StoryEvent[];
}

/** Everywhere an entity is referred to: scene front matter, mentions in prose, relationships, events. */
export function backlinks(novel: Novel, id: string): Backlinks {
  const ordered = [...novel.scenes, ...novel.allScenes.filter((s) => s.position < 0)];
  const scenes: Backlinks["scenes"] = [];
  for (const scene of ordered) {
    const via: SceneLink[] = [];
    if (scene.pov === id) via.push("pov");
    if (scene.characters.includes(id)) via.push("characters");
    if (scene.locations.includes(id)) via.push("locations");
    if (scene.entities.includes(id)) via.push("entities");
    if (scene.plotlines.some((p) => p.id === id)) via.push("plotlines");
    if (scene.themes.some((t) => t.id === id)) via.push("themes");
    if (mentions(scene.body).some((m) => m.id === id)) via.push("mention");
    if (via.length) scenes.push({ scene, via });
  }
  return {
    scenes,
    relationships: novel.relationships.filter((r) => r.from === id || r.to === id),
    events: novel.events.filter((e) => [...(e.characters ?? []), ...(e.locations ?? []), ...(e.plotlines ?? [])].includes(id)),
  };
}

export interface RelationshipSpan {
  /** The span starts at this scene (null: the book's start)… */
  from: string | null;
  /** …and runs up to, not including, this one (null: the book's end). */
  until: string | null;
  /** The relationships holding throughout it. */
  relationships: Relationship[];
}

/**
 * How an entity's relationships (or, with `other`, those between the two) change through the book:
 * consecutive spans of reading order, split at every scene where one starts or ends. Bounds that
 * don't resolve to an ordered scene are ignored, as in relationshipsAt.
 */
export function relationshipHistory(novel: Novel, id: string, other?: string): RelationshipSpan[] {
  const involved = novel.relationships.filter(
    (r) => (r.from === id || r.to === id) && (other === undefined || r.from === other || r.to === other),
  );
  const position = (sceneId: string | undefined) => {
    const p = sceneId === undefined ? undefined : sceneById(novel, sceneId)?.position;
    return p === undefined || p < 0 ? undefined : p;
  };
  const cuts = [...new Set(involved.flatMap((r) => [position(r.since), position(r.until)]).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
  const starts = [undefined, ...cuts];
  return starts.map((start, i) => {
    const end = cuts[i];
    const holds = involved.filter((r) => {
      const since = position(r.since);
      const until = position(r.until);
      const from = start ?? -1;
      return (since === undefined || since <= from) && (until === undefined || from < until);
    });
    return {
      from: start === undefined ? null : novel.scenes[start]!.id,
      until: end === undefined ? null : novel.scenes[end]!.id,
      relationships: holds,
    };
  });
}
