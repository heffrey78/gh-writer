import { mentions, relationshipsAt, type Novel, type Relationship, type RelationshipStyle, type Scene } from "@gh-writer/core";
import { describe } from "../bible/entry-page.tsx";
import type { GraphEdge, GraphNode } from "./graph-canvas.tsx";

/** The layouts.yaml diagram the relationship graph keeps its positions in. */
export const RELATIONSHIP_GRAPH = "relationship-graph";

const TONES: NonNullable<RelationshipStyle["color"]>[] = ["accent", "warn", "ok", "danger", "ink", "muted"];

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The same relationships as sentences, for the text alternative. */
  list: { id: string; text: string }[];
}

/** What the graph shows. Every filter that's set must hold. */
export interface GraphFilter {
  /** Entity types shown as nodes (default: characters). */
  types?: string[];
  /** Relationship types shown as edges (default: all). */
  relationshipTypes?: string[];
  /** Only entities present in a scene that advances this plotline. */
  plotline?: string;
  /** Only entities present in a scene from `from` to `to` (inclusive, reading order); either end may be open. */
  from?: string;
  to?: string;
}

/** Everything a scene refers to: point of view, people, places, plotlines, themes and mentions. */
export function presentIn(scene: Scene): Set<string> {
  return new Set([...(scene.pov ? [scene.pov] : []), ...scene.characters, ...scene.locations, ...scene.plotlines.map((p) => p.id), ...scene.themes.map((t) => t.id), ...mentions(scene.body).map((m) => m.id)]);
}

/** The entities the scene filters (plotline, range) allow, or undefined when neither is set. */
function presentInFiltered(novel: Novel, f: GraphFilter): Set<string> | undefined {
  if (!f.plotline && !f.from && !f.to) return undefined;
  const pos = (id: string | undefined, fallback: number) => (id ? Math.max(0, novel.scenes.findIndex((s) => s.id === id)) : fallback);
  const [lo, hi] = [pos(f.from, 0), pos(f.to, novel.scenes.length - 1)].sort((a, b) => a - b);
  const out = new Set<string>();
  novel.scenes.forEach((scene, i) => {
    if (i < lo! || i > hi!) return;
    if (f.plotline && !scene.plotlines.some((p) => p.id === f.plotline)) return;
    for (const id of presentIn(scene)) out.add(id);
  });
  return out;
}

/**
 * The relationship graph at a scene: entities of the filter's types (and present where the scene
 * filters say) as nodes, at their saved positions or laid out around them, and the relationships
 * of the filter's types holding at `sceneId` between two shown entities as edges, styled by type.
 */
export function graphAt(novel: Novel, sceneId: string | undefined, filter: GraphFilter = {}): GraphView {
  const types = filter.types ?? ["character"];
  const present = presentInFiltered(novel, filter);
  const entities = novel.entities.filter((e) => types.includes(e.type) && (!present || present.has(e.id))).sort((a, b) => a.name.localeCompare(b.name));
  const shown = new Set(entities.map((e) => e.id));
  const typeLabel = new Map(novel.entityTypes.map((t) => [t.key, t.label]));
  const saved = novel.layouts[RELATIONSHIP_GRAPH]?.nodes ?? {};
  const positions = layout(entities.map((e) => e.id), saved);
  const nodes: GraphNode[] = entities.map((e) => ({ id: e.id, label: e.name, type: typeLabel.get(e.type) ?? e.type, ...positions.get(e.id)! }));

  const holding = sceneId ? relationshipsAt(novel, sceneId) : novel.relationships.filter((r) => !r.since);
  const rels = holding.filter((r) => shown.has(r.from) && shown.has(r.to) && r.from !== r.to && (!filter.relationshipTypes || filter.relationshipTypes.includes(r.type)));
  const name = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const edges = rels.map((r) => {
    const e = edgeOf(novel, r);
    return { ...e, ariaLabel: `${name(r.from)}, ${e.label}, ${name(r.to)}` };
  });
  const list = rels.map((r) => ({ id: r.id, text: `${name(r.from)}: ${describe(novel, r.from, r)}` })).sort((a, b) => a.text.localeCompare(b.text));
  return { nodes, edges, list };
}

function edgeOf(novel: Novel, r: Relationship): GraphEdge {
  const index = novel.relationshipTypes.findIndex((t) => t.key === r.type);
  const type = novel.relationshipTypes[index];
  return {
    id: r.id,
    source: r.from,
    target: r.to,
    label: type?.label ?? r.type,
    tone: type?.style?.color ?? TONES[Math.max(index, 0) % TONES.length]!,
    line: type?.style?.line ?? "solid",
    directed: !type?.symmetric,
  };
}

/**
 * Saved positions as they are; the rest on a ring around them (or around the origin), far enough
 * apart not to overlap, in the order given, so the same novel always lays out the same way.
 */
export function layout(ids: string[], saved: Record<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const placed = ids.filter((id) => saved[id]);
  for (const id of placed) out.set(id, saved[id]!);
  const rest = ids.filter((id) => !saved[id]);
  if (!rest.length) return out;
  const cx = placed.length ? placed.reduce((s, id) => s + saved[id]!.x, 0) / placed.length : 0;
  const cy = placed.length ? placed.reduce((s, id) => s + saved[id]!.y, 0) / placed.length : 0;
  const spread = placed.length ? Math.max(...placed.map((id) => Math.hypot(saved[id]!.x - cx, saved[id]!.y - cy))) : 0;
  // Nodes are ~160 px wide: the ring's circumference gives each about 220 px.
  const radius = Math.max(spread + 220, (rest.length * 220) / (2 * Math.PI), 200);
  rest.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / rest.length - Math.PI / 2;
    out.set(id, { x: Math.round(cx + radius * Math.cos(angle)), y: Math.round(cy + radius * Math.sin(angle)) });
  });
  return out;
}
