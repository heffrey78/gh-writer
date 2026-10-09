// File shapes of the v1 novel repository format, mirroring packages/core/schemas.
// Keep these in sync with the JSON Schemas; test/schemas.test.ts checks the examples.

export type SceneStatus = "idea" | "outlined" | "drafted" | "revised" | "final";

export type StoryTime = { at: string } | { day: number; time?: string };

export interface NovelFile {
  schema_version: number;
  id: string;
  title: string;
  author?: string;
  /** BCP 47; default "en". */
  language?: string;
  target?: { words?: number; date?: string };
  entity_types?: CustomEntityTypeFile[];
  relationship_types?: RelationshipTypeFile[];
  calendar?: { start?: string };
  /** How long a plotline may go unmentioned before the swimlanes show a gap. */
  plotline_gap?: { scenes: number } | { words: number };
}

export interface CustomEntityTypeFile {
  key: string;
  prefix: string;
  folder: string;
  label?: string;
  color?: string;
}

export interface RelationshipTypeFile {
  key: string;
  label?: string;
  inverse_label?: string;
  symmetric?: boolean;
  from_types?: string[];
  to_types?: string[];
  /** How diagrams draw it. */
  style?: RelationshipStyle;
}

/** A colour from the app's palette (light and dark) and a line style, for drawing a relationship. */
export interface RelationshipStyle {
  color?: "accent" | "danger" | "ok" | "warn" | "ink" | "muted";
  line?: "solid" | "dashed" | "dotted";
}

export type ManuscriptOrderFile = { parts: string[] } | { chapters: string[] };

export interface PartFile {
  id: string;
  title: string;
  synopsis?: string;
  chapters: string[];
}

export interface ChapterFile {
  id: string;
  title?: string;
  synopsis?: string;
  scenes: string[];
}

export type PlotlineRefFile = string | { id: string; weight?: "major" | "minor"; beat?: string };
export type ThemeRefFile = string | { id: string; strength?: number; note?: string };

export interface SceneFrontMatter {
  id: string;
  title: string;
  synopsis?: string;
  status?: SceneStatus;
  pov?: string;
  characters?: string[];
  locations?: string[];
  plotlines?: PlotlineRefFile[];
  themes?: ThemeRefFile[];
  when?: StoryTime;
  duration?: string;
  tags?: string[];
}

export interface EntityFrontMatter {
  id: string;
  name: string;
  aliases?: string[];
  summary?: string;
  image?: string;
  fields?: Record<string, string | number | boolean>;
  tags?: string[];
}

export interface RelationshipRecord {
  id: string;
  from: string;
  to: string;
  type: string;
  since?: string;
  until?: string;
  note?: string;
}

export interface RelationshipsFile {
  relationships: RelationshipRecord[];
}

export interface EventRecord {
  id: string;
  title: string;
  when?: StoryTime;
  duration?: string;
  characters?: string[];
  locations?: string[];
  plotlines?: string[];
  note?: string;
}

export interface EventsFile {
  events: EventRecord[];
}

export interface LayoutsFile {
  layouts: Record<string, { nodes: Record<string, { x: number; y: number }> }>;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** Repository-relative path of the file concerned, if any. */
  file?: string;
  /** JSON pointer within the file's data, if any. */
  pointer?: string;
  /** 1-based line number in the file, if known. */
  line?: number;
}

/** compile.yaml: how the manuscript is compiled (#19). */
export interface CompileFile {
  presets: Record<string, CompilePreset>;
}

export interface CompilePreset {
  title_page?: { author?: string; contact?: string[]; surname?: string; short_title?: string };
  /** Between scenes, and for a break within one. Default "#". */
  scene_break?: string;
  /** Default "number-and-title". */
  chapter_heading?: "number-and-title" | "number" | "title";
  /** Markdown files before and after the chapters. */
  front?: string[];
  back?: string[];
  /** On the title page: "rounded" (default, as manuscript format asks), "exact" or "none". */
  word_count?: "rounded" | "exact" | "none";
}
