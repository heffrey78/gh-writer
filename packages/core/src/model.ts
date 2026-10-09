import type { EntityTypeDef } from "./ids.ts";
import type {
  CompileFile,
  Diagnostic,
  EventRecord,
  NovelFile,
  RelationshipRecord,
  RelationshipTypeFile,
  SceneStatus,
  StoryTime,
} from "./types.ts";

/** A novel loaded into memory. Collections are in reading order where that applies. */
export interface Novel {
  config: NovelFile | undefined;
  entityTypes: EntityTypeDef[];
  relationshipTypes: RelationshipTypeFile[];
  /** Whether the manuscript is organised in parts or directly in chapters. */
  topLevel: "parts" | "chapters" | undefined;
  /** Parts, chapters and scenes listed in order files, in reading order. */
  parts: Part[];
  chapters: Chapter[];
  scenes: Scene[];
  /** Every part, chapter and scene found on disk, including ones missing from order files. */
  allParts: Part[];
  allChapters: Chapter[];
  allScenes: Scene[];
  entities: Entity[];
  relationships: Relationship[];
  events: StoryEvent[];
  layouts: Record<string, { nodes: Record<string, { x: number; y: number }> }>;
  /** compile.yaml, if there is one. */
  compile?: CompileFile;
  /** Diagnostics found while loading (parse, schema and structure problems). */
  diagnostics: Diagnostic[];
}

export interface Part {
  id: string;
  title: string;
  synopsis?: string;
  chapterIds: string[];
  /** Folder of the part, and its _part.yaml. */
  dir: string;
  file: string;
}

export interface Chapter {
  id: string;
  title?: string;
  synopsis?: string;
  sceneIds: string[];
  partId?: string;
  dir: string;
  file: string;
}

export interface PlotlineRef {
  id: string;
  weight: "major" | "minor";
  beat?: string;
}

export interface ThemeRef {
  id: string;
  strength?: number;
  note?: string;
}

export interface Scene {
  id: string;
  title: string;
  synopsis?: string;
  status: SceneStatus;
  pov?: string;
  characters: string[];
  locations: string[];
  /** Entries of custom types (not characters, locations, plotlines or themes) in the scene. */
  entities: string[];
  plotlines: PlotlineRef[];
  themes: ThemeRef[];
  when?: StoryTime;
  duration?: string;
  tags: string[];
  chapterId?: string;
  /** Position in reading order, or -1 if the scene is not in any order file. */
  position: number;
  body: string;
  bodyLine: number;
  file: string;
}

export interface Entity {
  id: string;
  /** Entity type key, e.g. "character". */
  type: string;
  name: string;
  aliases: string[];
  summary?: string;
  image?: string;
  fields: Record<string, string | number | boolean>;
  tags: string[];
  body: string;
  bodyLine: number;
  file: string;
}

export interface Relationship extends RelationshipRecord {
  file: string;
  /** Index within relationships.yaml, for diagnostics. */
  index: number;
}

export interface StoryEvent extends EventRecord {
  file: string;
  index: number;
}

export type RecordKind = "novel" | "part" | "chapter" | "scene" | "entity" | "relationship" | "event";

export interface RecordRef {
  kind: RecordKind;
  id: string;
  file: string;
  /** Entity type key, for entities. */
  type?: string;
}

/** Every record with an ID, in discovery order. Duplicate IDs appear more than once. */
export function allRecords(novel: Novel): RecordRef[] {
  const out: RecordRef[] = [];
  if (novel.config?.id) out.push({ kind: "novel", id: novel.config.id, file: "novel.yaml" });
  for (const p of novel.allParts) out.push({ kind: "part", id: p.id, file: p.file });
  for (const c of novel.allChapters) out.push({ kind: "chapter", id: c.id, file: c.file });
  for (const s of novel.allScenes) out.push({ kind: "scene", id: s.id, file: s.file });
  for (const e of novel.entities) out.push({ kind: "entity", id: e.id, file: e.file, type: e.type });
  for (const r of novel.relationships) out.push({ kind: "relationship", id: r.id, file: r.file });
  for (const e of novel.events) out.push({ kind: "event", id: e.id, file: e.file });
  return out;
}

/** Index of records by ID (first occurrence wins). */
export function indexById(novel: Novel): Map<string, RecordRef> {
  const map = new Map<string, RecordRef>();
  for (const r of allRecords(novel)) if (!map.has(r.id)) map.set(r.id, r);
  return map;
}

export function entityById(novel: Novel, id: string): Entity | undefined {
  return novel.entities.find((e) => e.id === id);
}

export function sceneById(novel: Novel, id: string): Scene | undefined {
  return novel.allScenes.find((s) => s.id === id);
}

function positionOf(novel: Novel, sceneId: string | undefined): number | undefined {
  if (sceneId === undefined) return undefined;
  const p = sceneById(novel, sceneId)?.position;
  return p === undefined || p < 0 ? undefined : p;
}

/**
 * Relationships in effect at a scene: `since` is inclusive, `until` exclusive.
 * A bound that does not resolve to an ordered scene is ignored (the validator reports it).
 */
export function relationshipsAt(novel: Novel, sceneId: string): Relationship[] {
  const at = positionOf(novel, sceneId);
  if (at === undefined) return [];
  return novel.relationships.filter((r) => {
    const since = positionOf(novel, r.since);
    const until = positionOf(novel, r.until);
    return (since === undefined || since <= at) && (until === undefined || at < until);
  });
}

const MENTION = /\[([^\]\n]*)\]\(#([a-z]{2,8}_[0-9a-hjkmnp-tv-z]{6})\)/g;

export interface Mention {
  text: string;
  id: string;
  /** 1-based line within the body. */
  line: number;
}

/** Entity mentions (`[Name](#id)`) in Markdown prose. */
export function mentions(body: string): Mention[] {
  const out: Mention[] = [];
  body.split("\n").forEach((lineText, i) => {
    for (const m of lineText.matchAll(MENTION)) out.push({ text: m[1]!, id: m[2]!, line: i + 1 });
  });
  return out;
}
