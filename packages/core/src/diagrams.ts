import { countWords, mentions, relationshipsAt, storyTimeline, type Chapter, type Entity, type Novel, type Part, type Relationship, type RelationshipStyle, type Scene, type StoryInstant, type TimelineItem } from "./index.ts";

/*
 * The data behind every diagram: the relationship graph, the plotline swimlanes, the presence matrix
 * and the timeline. The app draws them and the snapshots (Mermaid, SVG) are written from them, so a
 * diagram on github.com always shows what the app does.
 */

/** A chapter's title, or "Chapter N" for one without. */
export const chapterTitle = (novel: Novel, chapter: Chapter) => chapter.title ?? `Chapter ${novel.chapters.indexOf(chapter) + 1}`;

/** A relationship as a sentence from `id`'s side: "Rivals with Ben Varn, from “The Betrayal” (After the bridge betrayal.)". */
export function describeRelationship(novel: Novel, id: string, r: Relationship): string {
  const type = novel.relationshipTypes.find((t) => t.key === r.type);
  const forward = r.from === id;
  const label = (forward || type?.symmetric ? type?.label : (type?.inverse_label ?? type?.label)) ?? r.type;
  const other = novel.entities.find((e) => e.id === (forward ? r.to : r.from))?.name ?? (forward ? r.to : r.from);
  const scene = (sceneId?: string) => novel.allScenes.find((s) => s.id === sceneId)?.title;
  const when = [r.since && `from “${scene(r.since) ?? r.since}”`, r.until && `until “${scene(r.until) ?? r.until}”`].filter(Boolean).join(", ");
  return `${label} ${other}${when ? `, ${when}` : ""}${r.note ? ` (${r.note})` : ""}`;
}

/** An entity on the relationship graph, where it's drawn. */
export interface GraphNode {
  id: string;
  label: string;
  /** The entity type's label, shown under the name. */
  type: string;
  x: number;
  y: number;
}

/** A relationship on the graph, styled by its type. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  /** A colour token name (accent, warn, ok, danger, ink, muted); muted when unset. */
  tone?: string;
  line?: "solid" | "dashed" | "dotted";
  /** Symmetric relationships have no arrow. */
  directed?: boolean;
  /** What a screen reader says for it, e.g. "Ada Varn, Allied with, Ben Varn". */
  ariaLabel?: string;
}

// ——— Columns ———

/** A grid cell's key: its row's ID and its scene's. */
export const gridKey = (row: string, scene: string) => `${row}|${scene}`;

/** Scenes grouped for column headers: by chapter, and by part when the book has them. */
export function sceneColumns(novel: Novel, scenes: Scene[]) {
  const chapters: { chapter: Chapter; title: string; span: number }[] = [];
  const parts: { part: Part; span: number }[] = [];
  for (const scene of scenes) {
    const chapter = novel.chapters.find((c) => c.id === scene.chapterId);
    if (!chapter) continue;
    const last = chapters.at(-1);
    if (last?.chapter.id === chapter.id) last.span++;
    else chapters.push({ chapter, title: chapterTitle(novel, chapter), span: 1 });
    const part = novel.parts.find((p) => p.id === chapter.partId);
    if (!part) continue;
    const lastPart = parts.at(-1);
    if (lastPart?.part.id === part.id) lastPart.span++;
    else parts.push({ part, span: 1 });
  }
  return { chapters, parts };
}

// ——— Relationship graph ———

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
  const list = rels.map((r) => ({ id: r.id, text: `${name(r.from)}: ${describeRelationship(novel, r.from, r)}` })).sort((a, b) => a.text.localeCompare(b.text));
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

// ——— Plotline swimlanes ———

export interface Mark {
  weight: "major" | "minor";
  beat?: string;
}

export interface Swimlanes {
  /** Plotlines, by name: an order that edits never shuffle. */
  lanes: Entity[];
  /** Scenes in reading order. */
  scenes: Scene[];
  /** Column groups over the scenes: chapters, and (when the book has them) parts. */
  chapters: { chapter: Chapter; title: string; span: number }[];
  parts: { part: Part; span: number }[];
  /** How a scene advances a plotline, by `${plotline}|${scene}`; absent: it doesn't. */
  marks: Map<string, Mark>;
  /** Each scene's words, counted once (gaps in words read them on every threshold). */
  words: number[];
}

export const cellKey = gridKey;

/** The book as plotline lanes against scene columns, from the scenes' plotlines. */
export function swimlanes(novel: Novel, scenes: Scene[] = novel.scenes): Swimlanes {
  const marks = new Map<string, Mark>();
  for (const scene of scenes) for (const p of scene.plotlines) marks.set(cellKey(p.id, scene.id), { weight: p.weight, ...(p.beat ? { beat: p.beat } : {}) });
  const lanes = novel.entities.filter((e) => e.type === "plotline").sort((a, b) => a.name.localeCompare(b.name));

  const { chapters, parts } = sceneColumns(novel, scenes);
  return { lanes, scenes, chapters, parts, marks, words: scenes.map((scene) => countWords(scene.body)) };
}

/** How long a plotline may go unmentioned before it counts as a gap: in scenes, or in words. */
export type GapThreshold = { scenes: number } | { words: number };

export const DEFAULT_GAP: GapThreshold = { scenes: 3 };

export interface Gap {
  lane: string;
  /** The first and last scene of the quiet stretch. */
  from: string;
  to: string;
  scenes: number;
  words: number;
  /** It runs to the end of the book: the thread is never picked up again. */
  open: boolean;
}

/**
 * Where each plotline goes quiet for longer than the threshold: the stretches between two of its
 * beats, and after its last beat to the end of the book. (Before its first beat it hasn't started.)
 */
export function gaps(s: { lanes: { id: string }[]; scenes: Scene[]; marks: Map<string, unknown>; words: number[] }, threshold: GapThreshold): Gap[] {
  const { words } = s;
  const out: Gap[] = [];
  for (const lane of s.lanes) {
    const beats = s.scenes.flatMap((scene, i) => (s.marks.has(cellKey(lane.id, scene.id)) ? [i] : []));
    if (!beats.length) continue;
    const stretches = beats.map((b, k) => [b + 1, (beats[k + 1] ?? s.scenes.length) - 1, beats[k + 1] === undefined] as const);
    for (const [first, last, open] of stretches) {
      if (last < first) continue;
      const n = last - first + 1;
      const w = words.slice(first, last + 1).reduce((a, b) => a + b, 0);
      const over = "scenes" in threshold ? n > threshold.scenes : w > threshold.words;
      if (over) out.push({ lane: lane.id, from: s.scenes[first]!.id, to: s.scenes[last]!.id, scenes: n, words: w, open });
    }
  }
  return out;
}

/** The scenes a zoom shows: a part's, a chapter's, or (no zoom, or one that's gone) all. */
export function zoomed(novel: Novel, scenes: Scene[], zoom: string | undefined): Scene[] {
  if (!zoom) return scenes;
  const part = novel.parts.find((p) => p.id === zoom);
  if (part) return scenes.filter((s) => part.chapterIds.includes(s.chapterId ?? ""));
  const chapter = novel.chapters.find((c) => c.id === zoom);
  return chapter ? scenes.filter((s) => s.chapterId === chapter.id) : scenes;
}

// ——— Presence ———

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

// ——— Timeline ———

export type LaneMode = "pov" | "plotline" | "location";

export interface Lane {
  id: string;
  name: string;
}

export const itemId = (i: TimelineItem) => (i.kind === "scene" ? i.scene.id : i.event.id);
export const itemTitle = (i: TimelineItem) => (i.kind === "scene" ? i.scene.title : i.event.title);

/** The lanes an item runs in: its point of view, plotlines or locations; none of them, the "none" lane. Events have no point of view: "off page". */
export function lanesOf(i: TimelineItem, mode: LaneMode): string[] {
  if (mode === "pov") return i.kind === "scene" ? [i.scene.pov ?? NONE] : [OFF_PAGE];
  const ids = mode === "plotline" ? (i.kind === "scene" ? i.scene.plotlines.map((p) => p.id) : (i.event.plotlines ?? [])) : i.kind === "scene" ? i.scene.locations : (i.event.locations ?? []);
  return ids.length ? ids : [NONE];
}

export const NONE = "(none)";
export const OFF_PAGE = "(off page)";

const DAY = 86_400_000;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** How far apart two moments in story time are, in words: "same time", "3 hours later", "4 days later", "14 years later". */
export function jump(from: StoryInstant, to: StoryInstant): string {
  if (from.dated !== to.dated) return "";
  const ms = to.start - from.start;
  if (ms <= 0) return "same time";
  const hours = Math.round(ms / 3_600_000);
  if (ms < DAY) return hours < 1 ? `${Math.max(1, Math.round(ms / 60_000))} min later` : `${plural(hours, "hour")} later`;
  const days = Math.round(ms / DAY);
  if (days < 60) return `${plural(days, "day")} later`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${plural(months, "month")} later`;
  return `${plural(Math.round(days / 365.25), "year")} later`;
}

/** When, in words: a date (and time), or "Day 3, 18:30" (with its date when the calendar gives one). */
export function when(i: TimelineItem): string {
  const w = i.kind === "scene" ? i.scene.when : i.event.when;
  const date = new Date(i.at.start);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  if (w && "day" in w) return `Day ${w.day}${w.time ? `, ${w.time}` : ""}${i.at.dated ? ` (${day})` : ""}`;
  return w && "at" in w && w.at.length > 10 ? `${day}, ${time}` : day;
}

export interface Timeline {
  items: TimelineItem[];
  /** Each item's place in story-time order, by ID. */
  storyRank: Map<string, number>;
  /** Scenes read after a scene that happens later: early in story time, late in the book. */
  flashbacks: Set<string>;
  undated: ReturnType<typeof storyTimeline>["undatedScenes"];
  undatedEvents: ReturnType<typeof storyTimeline>["undatedEvents"];
  lanes: Lane[];
}

/** The book's timeline, with lanes for `mode`: in order of first appearance, "none" and "off page" last. */
export function timeline(novel: Novel, mode: LaneMode): Timeline {
  const t = storyTimeline(novel);
  const storyRank = new Map(t.items.map((i, k) => [itemId(i), k]));
  // A flashback: some scene read before it happens after it.
  const flashbacks = new Set<string>();
  let latest = -1;
  for (const scene of novel.scenes) {
    const rank = storyRank.get(scene.id);
    if (rank === undefined) continue;
    if (rank < latest) flashbacks.add(scene.id);
    latest = Math.max(latest, rank);
  }
  const seen: string[] = [];
  for (const i of t.items) for (const l of lanesOf(i, mode)) if (!seen.includes(l)) seen.push(l);
  const special = [NONE, OFF_PAGE];
  const ordered = [...seen.filter((l) => !special.includes(l)), ...special.filter((l) => seen.includes(l))];
  const name = (id: string) => (id === NONE ? (mode === "pov" ? "No point of view" : mode === "plotline" ? "No plotline" : "No location") : id === OFF_PAGE ? "Off page" : (novel.entities.find((e) => e.id === id)?.name ?? id));
  return { items: t.items, storyRank, flashbacks, undated: t.undatedScenes, undatedEvents: t.undatedEvents, lanes: ordered.map((id) => ({ id, name: name(id) })) };
}
