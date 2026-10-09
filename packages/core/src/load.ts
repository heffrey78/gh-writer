import { BUILTIN_ENTITY_TYPES, RESERVED_PREFIXES, type EntityTypeDef } from "./ids.ts";
import type { Chapter, Entity, Novel, Part, PlotlineRef, Relationship, Scene, StoryEvent, ThemeRef } from "./model.ts";
import { parseMarkdown, parseYaml } from "./parse.ts";
import { checkSchema, type SchemaKind } from "./schemas.ts";
import { joinPath, type FileSource } from "./source.ts";
import type { Diagnostic, NovelFile, RelationshipTypeFile, SceneStatus, StoryTime } from "./types.ts";

/** Highest novel repository schema version this build understands. */
export const SCHEMA_VERSION = 1;

const SCENE_STATUSES: readonly SceneStatus[] = ["idea", "outlined", "drafted", "revised", "final"];

/**
 * Load a novel repository into a story model.
 *
 * Loading never throws on bad content: parse, schema and structure problems are
 * collected in `novel.diagnostics`, and the model holds whatever could be read.
 * Cross-reference checks are done separately by `validateNovel`.
 */
export async function loadNovel(source: FileSource): Promise<Novel> {
  const diagnostics: Diagnostic[] = [];
  const novel: Novel = {
    config: undefined,
    entityTypes: [...BUILTIN_ENTITY_TYPES],
    relationshipTypes: [],
    topLevel: undefined,
    parts: [],
    chapters: [],
    scenes: [],
    allParts: [],
    allChapters: [],
    allScenes: [],
    entities: [],
    relationships: [],
    events: [],
    layouts: {},
    diagnostics,
  };

  /** Read, parse and schema-check a YAML file. Returns undefined if missing or unparseable. */
  async function yamlFile(path: string, kind: SchemaKind): Promise<Record<string, unknown> | undefined> {
    const text = await source.read(path);
    if (text === undefined) return undefined;
    const parsed = parseYaml(text, path);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.diagnostics.length) return undefined;
    diagnostics.push(...checkSchema(kind, parsed.data, path));
    return isObject(parsed.data) ? parsed.data : {};
  }

  async function markdownFile(path: string, kind: SchemaKind) {
    const parsed = parseMarkdown((await source.read(path)) ?? "", path);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.diagnostics.length) return undefined;
    diagnostics.push(...checkSchema(kind, parsed.data, path));
    return { data: isObject(parsed.data) ? parsed.data : {}, body: parsed.body, bodyLine: parsed.bodyLine };
  }

  // novel.yaml
  const config = await yamlFile("novel.yaml", "novel");
  if (config === undefined) {
    if ((await source.read("novel.yaml")) === undefined) {
      diagnostics.push(error("E_MISSING_FILE", "novel.yaml", "novel.yaml is missing"));
    }
  } else {
    const version = config["schema_version"];
    if (typeof version === "number" && version > SCHEMA_VERSION) {
      // Don't guess at a newer format: report only this.
      novel.diagnostics = [error("E_SCHEMA_VERSION", "novel.yaml",
        `schema_version ${version} is newer than this validator supports (${SCHEMA_VERSION}); update gh-writer`)];
      return novel;
    }
    novel.config = config as unknown as NovelFile;
    novel.entityTypes = entityTypes(config["entity_types"], diagnostics);
    novel.relationshipTypes = objList(config["relationship_types"]).filter((t) => str(t["key"])) as unknown as RelationshipTypeFile[];
  }

  await loadManuscript();
  await loadBible();

  const layouts = await yamlFile("diagrams/layouts.yaml", "layouts");
  if (layouts && isObject(layouts["layouts"])) novel.layouts = layouts["layouts"] as Novel["layouts"];

  return novel;

  async function loadManuscript() {
    const order = await yamlFile("manuscript/_order.yaml", "manuscript-order");
    if (order === undefined && (await source.read("manuscript/_order.yaml")) === undefined) {
      diagnostics.push(error("E_MISSING_FILE", "manuscript/_order.yaml", "manuscript/_order.yaml is missing"));
    }
    const topLevel = order && "parts" in order ? "parts" : order && "chapters" in order ? "chapters" : undefined;
    novel.topLevel = topLevel;

    const discoveredParts: Part[] = [];
    const discoveredChapters: Chapter[] = [];
    for (const entry of await source.list("manuscript")) {
      const path = joinPath("manuscript", entry.name);
      if (!entry.dir) {
        if (entry.name.endsWith(".md")) diagnostics.push(error("E_MISPLACED", path, "Scene files must be inside a chapter folder"));
        continue;
      }
      const children = await source.list(path);
      if (children.some((c) => c.name === "_part.yaml")) {
        const part = await loadPart(path);
        if (part) discoveredParts.push(part);
      } else if (children.some((c) => c.name === "_chapter.yaml")) {
        const chapter = await loadChapter(path, undefined);
        if (chapter) discoveredChapters.push(chapter);
      } else {
        diagnostics.push(error("E_MISPLACED", path, "Folder has neither _part.yaml nor _chapter.yaml"));
      }
    }

    if (topLevel === "parts") {
      for (const c of discoveredChapters) diagnostics.push(error("E_MISPLACED", c.file, "Chapter folder at the top level of a book organised in parts"));
    } else if (topLevel === "chapters") {
      for (const p of discoveredParts) diagnostics.push(error("E_MISPLACED", p.file, "Part folder in a book organised directly in chapters"));
    }

    // Reading order.
    const orderList = topLevel ? strList(order?.[topLevel]) : [];
    if (topLevel === "parts") {
      novel.parts = resolveOrder(orderList, discoveredParts, "manuscript/_order.yaml", "/parts", "part");
      novel.chapters = novel.parts.flatMap((p) =>
        resolveOrder(p.chapterIds, novel.allChapters.filter((c) => c.partId === p.id), p.file, "/chapters", "chapter"));
    } else if (topLevel === "chapters") {
      novel.chapters = resolveOrder(orderList, discoveredChapters, "manuscript/_order.yaml", "/chapters", "chapter");
    }
    // Chapters inside parts that are not themselves ordered still need their scenes checked.
    for (const p of novel.allParts) {
      if (!novel.parts.includes(p)) resolveOrder(p.chapterIds, novel.allChapters.filter((c) => c.partId === p.id), p.file, "/chapters", "chapter");
    }
    const orderedChapters = new Set(novel.chapters);
    for (const c of novel.allChapters) {
      const scenes = resolveOrder(c.sceneIds, novel.allScenes.filter((s) => s.chapterId === c.id && s.file.startsWith(`${c.dir}/`)), c.file, "/scenes", "scene");
      if (orderedChapters.has(c)) novel.scenes.push(...scenes);
    }
    // Keep novel.scenes in chapter reading order.
    const chapterRank = new Map(novel.chapters.map((c, i) => [c.id, i]));
    novel.scenes.sort((a, b) => (chapterRank.get(a.chapterId!) ?? 0) - (chapterRank.get(b.chapterId!) ?? 0));
    novel.scenes.forEach((s, i) => (s.position = i));
  }

  async function loadPart(dir: string): Promise<Part | undefined> {
    const file = joinPath(dir, "_part.yaml");
    const data = await yamlFile(file, "part");
    if (!data || !str(data["id"])) return undefined;
    const part: Part = {
      id: str(data["id"])!,
      title: str(data["title"]) ?? "",
      synopsis: str(data["synopsis"]),
      chapterIds: strList(data["chapters"]),
      dir,
      file,
    };
    novel.allParts.push(part);
    for (const entry of await source.list(dir)) {
      const path = joinPath(dir, entry.name);
      if (entry.dir) {
        if ((await source.list(path)).some((c) => c.name === "_chapter.yaml")) await loadChapter(path, part.id);
        else diagnostics.push(error("E_MISPLACED", path, "Folder inside a part has no _chapter.yaml"));
      } else if (entry.name.endsWith(".md")) {
        diagnostics.push(error("E_MISPLACED", path, "Scene files must be inside a chapter folder"));
      }
    }
    return part;
  }

  async function loadChapter(dir: string, partId: string | undefined): Promise<Chapter | undefined> {
    const file = joinPath(dir, "_chapter.yaml");
    const data = await yamlFile(file, "chapter");
    if (!data || !str(data["id"])) return undefined;
    const chapter: Chapter = {
      id: str(data["id"])!,
      title: str(data["title"]),
      synopsis: str(data["synopsis"]),
      sceneIds: strList(data["scenes"]),
      partId,
      dir,
      file,
    };
    novel.allChapters.push(chapter);
    for (const entry of await source.list(dir)) {
      const path = joinPath(dir, entry.name);
      if (entry.dir) diagnostics.push(error("E_MISPLACED", path, "Chapters cannot contain folders"));
      else if (entry.name.endsWith(".md")) await loadScene(path, chapter.id);
    }
    return chapter;
  }

  async function loadScene(file: string, chapterId: string) {
    const md = await markdownFile(file, "scene");
    if (!md || !str(md.data["id"])) return;
    const d = md.data;
    const status = str(d["status"]);
    const scene: Scene = {
      id: str(d["id"])!,
      title: str(d["title"]) ?? "",
      synopsis: str(d["synopsis"]),
      status: SCENE_STATUSES.includes(status as SceneStatus) ? (status as SceneStatus) : "idea",
      pov: str(d["pov"]),
      characters: strList(d["characters"]),
      locations: strList(d["locations"]),
      entities: strList(d["entities"]),
      plotlines: refList(d["plotlines"]).map((r): PlotlineRef => ({
        id: r.id,
        weight: r.obj?.["weight"] === "minor" ? "minor" : "major",
        beat: str(r.obj?.["beat"]),
      })),
      themes: refList(d["themes"]).map((r): ThemeRef => ({
        id: r.id,
        strength: typeof r.obj?.["strength"] === "number" ? r.obj["strength"] : undefined,
        note: str(r.obj?.["note"]),
      })),
      when: storyTime(d["when"]),
      duration: str(d["duration"]),
      tags: strList(d["tags"]),
      chapterId,
      position: -1,
      body: md.body,
      bodyLine: md.bodyLine,
      file,
    };
    novel.allScenes.push(scene);
  }

  async function loadBible() {
    for (const entry of await source.list("bible")) {
      const path = joinPath("bible", entry.name);
      if (!entry.dir) continue;
      const type = novel.entityTypes.find((t) => t.folder === entry.name);
      const files = (await source.list(path)).filter((f) => !f.dir && f.name.endsWith(".md"));
      if (!type) {
        if (files.length) diagnostics.push(error("E_UNKNOWN_FOLDER", path, `bible/${entry.name} is not the folder of any entity type`));
        continue;
      }
      for (const f of files) await loadEntity(joinPath(path, f.name), type.key);
    }

    const rels = await yamlFile("bible/relationships.yaml", "relationships");
    objList(rels?.["relationships"]).forEach((r, index) => {
      const id = str(r["id"]), from = str(r["from"]), to = str(r["to"]), type = str(r["type"]);
      if (!id || !from || !to || !type) return;
      const rel: Relationship = { id, from, to, type, file: "bible/relationships.yaml", index };
      const since = str(r["since"]), until = str(r["until"]), note = str(r["note"]);
      if (since) rel.since = since;
      if (until) rel.until = until;
      if (note) rel.note = note;
      novel.relationships.push(rel);
    });

    const events = await yamlFile("bible/events.yaml", "events");
    objList(events?.["events"]).forEach((e, index) => {
      const id = str(e["id"]);
      if (!id) return;
      const ev: StoryEvent = {
        id,
        title: str(e["title"]) ?? "",
        when: storyTime(e["when"]),
        duration: str(e["duration"]),
        characters: strList(e["characters"]),
        locations: strList(e["locations"]),
        plotlines: strList(e["plotlines"]),
        note: str(e["note"]),
        file: "bible/events.yaml",
        index,
      };
      novel.events.push(ev);
    });
  }

  async function loadEntity(file: string, type: string) {
    const md = await markdownFile(file, "entity");
    if (!md || !str(md.data["id"])) return;
    const d = md.data;
    const fields: Entity["fields"] = {};
    if (isObject(d["fields"])) {
      for (const [k, v] of Object.entries(d["fields"])) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = v;
      }
    }
    novel.entities.push({
      id: str(d["id"])!,
      type,
      name: str(d["name"]) ?? "",
      aliases: strList(d["aliases"]),
      summary: str(d["summary"]),
      image: str(d["image"]),
      fields,
      tags: strList(d["tags"]),
      body: md.body,
      bodyLine: md.bodyLine,
      file,
    });
  }

  /**
   * Resolve an order list against the children found on disk: report unknown,
   * duplicate and missing entries, and return the listed children in order.
   */
  function resolveOrder<T extends { id: string; file: string }>(
    listed: string[], present: T[], orderFile: string, pointer: string, what: string,
  ): T[] {
    const byId = new Map<string, T>();
    for (const c of present) if (!byId.has(c.id)) byId.set(c.id, c);
    const seen = new Set<string>();
    const out: T[] = [];
    listed.forEach((id, i) => {
      if (seen.has(id)) {
        diagnostics.push({ ...error("E_ORDER_DUPLICATE", orderFile, `${id} is listed more than once`), pointer: `${pointer}/${i}` });
        return;
      }
      seen.add(id);
      const child = byId.get(id);
      if (!child) {
        diagnostics.push({ ...error("E_ORDER_UNKNOWN", orderFile, `Lists ${what} ${id}, which is not in this folder`), pointer: `${pointer}/${i}` });
        return;
      }
      out.push(child);
    });
    for (const c of present) {
      if (!seen.has(c.id)) diagnostics.push(error("E_ORDER_MISSING", c.file, `${capitalize(what)} ${c.id} is not listed in ${orderFile}`));
    }
    return out;
  }
}

function entityTypes(raw: unknown, diagnostics: Diagnostic[]): EntityTypeDef[] {
  const types = [...BUILTIN_ENTITY_TYPES];
  objList(raw).forEach((t, i) => {
    const key = str(t["key"]), prefix = str(t["prefix"]), folder = str(t["folder"]);
    if (!key || !prefix || !folder) return;
    const clash =
      types.find((x) => x.key === key) ? `key "${key}"` :
      RESERVED_PREFIXES.has(prefix) || types.find((x) => x.prefix === prefix) ? `prefix "${prefix}"` :
      types.find((x) => x.folder === folder) ? `folder "${folder}"` : undefined;
    if (clash) {
      diagnostics.push({ ...error("E_ENTITY_TYPE", "novel.yaml", `Entity type ${clash} is reserved or already used`), pointer: `/entity_types/${i}` });
      return;
    }
    types.push({ key, prefix, folder, label: str(t["label"]) ?? key, color: str(t["color"]), builtin: false });
  });
  return types;
}

function error(code: string, file: string, message: string): Diagnostic {
  return { severity: "error", code, file, message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function objList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isObject) : [];
}

/** A list of IDs given either as plain strings or as objects with an id. */
function refList(v: unknown): { id: string; obj?: Record<string, unknown> }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x === "string") return [{ id: x }];
    if (isObject(x) && typeof x["id"] === "string") return [{ id: x["id"], obj: x }];
    return [];
  });
}

function storyTime(v: unknown): StoryTime | undefined {
  if (!isObject(v)) return undefined;
  if (typeof v["at"] === "string") return { at: v["at"] };
  if (typeof v["day"] === "number") return typeof v["time"] === "string" ? { day: v["day"], time: v["time"] } : { day: v["day"] };
  return undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
