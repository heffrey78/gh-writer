import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  backlinks,
  editFrontMatter,
  editYaml,
  indexById,
  loadNovel,
  RESERVED_PREFIXES,
  slugify,
  uniqueFileName,
  uniqueId,
  type Novel,
  type Relationship,
} from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { parse, stringify } from "yaml";
import { hashText } from "./files.ts";
import { OperationError, transaction, type FileWrite, type OperationResult } from "./operations.ts";

/** What an entity's front matter holds, apart from its ID. */
export interface EntityFields {
  name?: string;
  aliases?: string[];
  summary?: string | null;
  image?: string | null;
  fields?: Record<string, string | number | boolean>;
  tags?: string[];
}

export interface RelationshipFields {
  from?: string;
  to?: string;
  type?: string;
  since?: string | null;
  until?: string | null;
  note?: string | null;
}

/** An off-page story event's fields (null removes one on update). */
export interface EventFields {
  title?: string;
  when?: { at: string } | { day: number; time?: string } | null;
  duration?: string | null;
  characters?: string[] | null;
  locations?: string[] | null;
  plotlines?: string[] | null;
  note?: string | null;
}

export interface EntityTypeFields {
  key: string;
  prefix: string;
  label: string;
  folder?: string;
  color?: string;
}

export interface RelationshipTypeFields {
  key: string;
  label: string;
  inverse_label?: string;
  symmetric?: boolean;
  from_types?: string[];
  to_types?: string[];
}

const RELATIONSHIPS = "bible/relationships.yaml";
const EVENTS = "bible/events.yaml";
const NOVEL = "novel.yaml";

/**
 * The story bible's changes, each one commit: entities of any type, relationships (including a change
 * at a scene), and the entity and relationship types themselves. `exclusive` holds writes off while
 * an operation runs.
 */
export class BibleOperations {
  readonly root: string;
  #exclusive: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(root: string, exclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
    this.root = root;
    this.#exclusive = exclusive;
  }

  /** Add an entity of `type` (an entity type key, built-in or custom). */
  createEntity(type: string, fields: EntityFields & { name: string }, notes = ""): Promise<OperationResult & { id: string; file: string }> {
    return this.#run(async (novel) => {
      const def = novel.entityTypes.find((t) => t.key === type);
      if (!def) throw new OperationError("BAD_REQUEST", `No entity type “${type}”.`);
      const name = required(fields.name, "name");
      const id = uniqueId(def.prefix, new Set(indexById(novel).keys()));
      const folder = `bible/${def.folder}`;
      const taken = new Set(novel.entities.filter((e) => e.file.startsWith(`${folder}/`)).map((e) => e.file.slice(folder.length + 1)));
      const file = `${folder}/${uniqueFileName(slugify(name), ".md", taken)}`;
      const front = stringify({ id, ...clean({ ...fields, name }) }, { lineWidth: 0 });
      const content = `---\n${front}---\n${notes ? `\n${notes.trimEnd()}\n` : ""}`;
      const result = await transaction(this.root, [{ path: file, content, base: null }], `Bible: add ${name}`);
      return { ...result, id, file };
    });
  }

  /** Change an entity's fields (null removes one). A new name moves its file to match; nothing else changes. */
  updateEntity(id: string, base: string, changes: EntityFields): Promise<OperationResult & { file: string }> {
    return this.#run(async (novel) => {
      const entity = novel.entities.find((e) => e.id === id);
      if (!entity) throw new OperationError("NOT_FOUND", `No entity “${id}”.`);
      const text = await this.#read(entity.file);
      if (hashText(text) !== base) throw new OperationError("STALE", `“${entity.name}” changed since it was read.`, { path: entity.file });
      if (changes.name !== undefined) required(changes.name, "name");
      const edits = Object.entries(changes).map(([key, value]) => (value === null ? { path: [key], remove: true as const } : { path: [key], value }));
      const content = editFrontMatter(text, edits);
      let file = entity.file;
      const writes: FileWrite[] = [];
      if (changes.name && changes.name !== entity.name) {
        const folder = entity.file.slice(0, entity.file.lastIndexOf("/"));
        const taken = new Set(novel.entities.filter((e) => e.file.startsWith(`${folder}/`) && e.id !== id).map((e) => e.file.slice(folder.length + 1)));
        const renamed = `${folder}/${uniqueFileName(slugify(changes.name), ".md", taken)}`;
        if (renamed !== entity.file) {
          file = renamed;
          writes.push({ path: entity.file, content: null, base }, { path: renamed, content, base: null });
        }
      }
      if (!writes.length) writes.push({ path: entity.file, content, base });
      const message = changes.name && changes.name !== entity.name ? `Bible: rename ${entity.name} to ${changes.name}` : `Bible: edit ${entity.name}`;
      return { ...(await transaction(this.root, writes, message)), file };
    });
  }

  /**
   * Remove an entity's file. If anything refers to it (scenes, prose, relationships, events), it's
   * refused with every reference unless `confirm`; references are then left for the validator to report.
   */
  deleteEntity(id: string, base: string, confirm = false): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const entity = novel.entities.find((e) => e.id === id);
      if (!entity) throw new OperationError("NOT_FOUND", `No entity “${id}”.`);
      const links = backlinks(novel, id);
      const references = [
        ...links.scenes.map((s) => ({ kind: "scene", id: s.scene.id, title: s.scene.title, via: s.via })),
        ...links.relationships.map((r) => ({ kind: "relationship", id: r.id, type: r.type, other: r.from === id ? r.to : r.from })),
        ...links.events.map((e) => ({ kind: "event", id: e.id, title: e.title })),
      ];
      if (references.length && !confirm) {
        throw new OperationError("REFERENCED", `“${entity.name}” is referred to in ${references.length} place${references.length === 1 ? "" : "s"}.`, { references });
      }
      return transaction(this.root, [{ path: entity.file, content: null, base }], `Bible: remove ${entity.name}`);
    });
  }

  /** Add a relationship. */
  createRelationship(fields: RelationshipFields & { from: string; to: string; type: string }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel) => {
      this.#checkRelationship(novel, fields);
      const id = uniqueId("rel", new Set(indexById(novel).keys()));
      const record = { id, ...clean(fields) };
      const content = await this.#appendRelationship(record);
      const result = await transaction(this.root, [{ path: RELATIONSHIPS, content }], `Bible: ${this.#describe(novel, fields)}`);
      return { ...result, id };
    });
  }

  /** Edit a relationship's fields in place (null removes one). */
  updateRelationship(id: string, changes: RelationshipFields): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const { index, relationship } = this.#find(novel, id);
      this.#checkRelationship(novel, { ...relationship, ...nullsToUndefined(changes) });
      const text = await this.#read(RELATIONSHIPS);
      const content = editYaml(
        text,
        Object.entries(changes).map(([key, value]) => (value === null ? { path: ["relationships", index, key], remove: true as const } : { path: ["relationships", index, key], value })),
      );
      return transaction(this.root, [{ path: RELATIONSHIPS, content }], `Bible: edit ${this.#describe(novel, relationship)}`);
    });
  }

  /**
   * Change a relationship from scene `at` on: the current record ends there, and a new one (with the new
   * type or note) starts there and runs as long as the old one did.
   */
  changeRelationship(id: string, at: string, changes: { type?: string; note?: string | null }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel) => {
      const { index, relationship } = this.#find(novel, id);
      this.#checkSpan(novel, relationship.since, at, "The change must come after the relationship starts.");
      this.#checkSpan(novel, at, relationship.until, "The change must come before the relationship ends.");
      const next = clean({
        from: relationship.from,
        to: relationship.to,
        type: changes.type ?? relationship.type,
        since: at,
        until: relationship.until,
        note: changes.note === undefined ? relationship.note : changes.note,
      });
      this.#checkRelationship(novel, next as RelationshipFields);
      const newId = uniqueId("rel", new Set(indexById(novel).keys()));
      const ended = editYaml(await this.#read(RELATIONSHIPS), [{ path: ["relationships", index, "until"], value: at }]);
      const content = await this.#appendRelationship({ id: newId, ...next }, ended);
      const scene = novel.allScenes.find((s) => s.id === at)!;
      const result = await transaction(this.root, [{ path: RELATIONSHIPS, content }], `Bible: ${this.#describe(novel, relationship)} becomes ${next.type} at “${scene.title}”`);
      return { ...result, id: newId };
    });
  }

  /** End a relationship at scene `at` (it no longer holds from there). */
  endRelationship(id: string, at: string): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const { index, relationship } = this.#find(novel, id);
      this.#checkSpan(novel, relationship.since, at, "The end must come after the relationship starts.");
      const content = editYaml(await this.#read(RELATIONSHIPS), [{ path: ["relationships", index, "until"], value: at }]);
      const scene = novel.allScenes.find((s) => s.id === at)!;
      return transaction(this.root, [{ path: RELATIONSHIPS, content }], `Bible: ${this.#describe(novel, relationship)} ends at “${scene.title}”`);
    });
  }

  deleteRelationship(id: string): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const { index, relationship } = this.#find(novel, id);
      const content = editYaml(await this.#read(RELATIONSHIPS), [{ path: ["relationships", index], remove: true }]);
      return transaction(this.root, [{ path: RELATIONSHIPS, content }], `Bible: remove ${this.#describe(novel, relationship)}`);
    });
  }

  /** Add an off-page event to bible/events.yaml. */
  createEvent(fields: EventFields): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel) => {
      const title = required(fields.title, "title");
      this.#checkEvent(novel, fields);
      const id = uniqueId("evt", new Set(indexById(novel).keys()));
      const content = await this.#appendToList(EVENTS, "events", { id, ...clean({ ...fields, title }) });
      const result = await transaction(this.root, [{ path: EVENTS, content }], `Bible: add event “${title}”`);
      return { ...result, id };
    });
  }

  /** Edit an event's fields in place (null removes one). */
  updateEvent(id: string, changes: EventFields): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const event = this.#findEvent(novel, id);
      if (changes.title !== undefined) required(changes.title, "title");
      this.#checkEvent(novel, changes);
      const tidy = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, Array.isArray(v) && !v.length ? null : v === "" ? null : v]));
      const content = editYaml(await this.#read(EVENTS), editsAt(["events", event.index], tidy));
      return transaction(this.root, [{ path: EVENTS, content }], `Bible: edit event “${changes.title?.trim() || event.title}”`);
    });
  }

  deleteEvent(id: string): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const event = this.#findEvent(novel, id);
      const content = editYaml(await this.#read(EVENTS), [{ path: ["events", event.index], remove: true }]);
      return transaction(this.root, [{ path: EVENTS, content }], `Bible: remove event “${event.title}”`);
    });
  }

  /** Add a custom entity type to novel.yaml. Its folder is bible/<folder> (default: the key, plural). */
  createEntityType(fields: EntityTypeFields): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const key = required(fields.key, "key");
      if (!/^[a-z][a-z0-9_-]*$/.test(key)) throw new OperationError("BAD_REQUEST", "A type's key is lowercase letters, digits, - or _.");
      if (!/^[a-z]{2,8}$/.test(fields.prefix)) throw new OperationError("BAD_REQUEST", "A prefix is 2 to 8 lowercase letters.");
      if (novel.entityTypes.some((t) => t.key === key)) throw new OperationError("BAD_REQUEST", `There's already a type “${key}”.`);
      if (RESERVED_PREFIXES.has(fields.prefix) || novel.entityTypes.some((t) => t.prefix === fields.prefix)) {
        throw new OperationError("BAD_REQUEST", `The prefix “${fields.prefix}” is taken.`);
      }
      const folder = fields.folder ?? `${key}s`;
      const def = clean({ key, prefix: fields.prefix, folder, label: required(fields.label, "label"), color: fields.color });
      const content = await this.#appendToList(NOVEL, "entity_types", def);
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: add the ${fields.label} type`);
    });
  }

  /** Change a custom entity type's label or colour. */
  updateEntityType(key: string, changes: { label?: string; color?: string | null }): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const custom = (novel.config?.entity_types ?? []) as { key: string }[];
      const index = custom.findIndex((t) => t.key === key);
      if (index < 0) throw new OperationError("NOT_FOUND", `No custom entity type “${key}”.`);
      const content = editYaml(await this.#read(NOVEL), editsAt(["entity_types", index], changes));
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: edit the ${key} type`);
    });
  }

  createRelationshipType(fields: RelationshipTypeFields): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const key = required(fields.key, "key");
      if (!/^[a-z][a-z0-9_-]*$/.test(key)) throw new OperationError("BAD_REQUEST", "A type's key is lowercase letters, digits, - or _.");
      if (novel.relationshipTypes.some((t) => t.key === key)) throw new OperationError("BAD_REQUEST", `There's already a relationship type “${key}”.`);
      for (const t of [...(fields.from_types ?? []), ...(fields.to_types ?? [])]) {
        if (!novel.entityTypes.some((e) => e.key === t)) throw new OperationError("BAD_REQUEST", `No entity type “${t}”.`);
      }
      const content = await this.#appendToList(NOVEL, "relationship_types", clean({ ...fields, label: required(fields.label, "label") }));
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: add the “${fields.label}” relationship`);
    });
  }

  updateRelationshipType(key: string, changes: Partial<Omit<RelationshipTypeFields, "key">>): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const index = novel.relationshipTypes.findIndex((t) => t.key === key);
      if (index < 0) throw new OperationError("NOT_FOUND", `No relationship type “${key}”.`);
      const content = editYaml(await this.#read(NOVEL), editsAt(["relationship_types", index], changes));
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: edit the “${key}” relationship`);
    });
  }

  // ——— Helpers ———

  #run<T>(fn: (novel: Novel) => Promise<T>): Promise<T> {
    return this.#exclusive(async () => fn(await loadNovel(nodeSource(this.root))));
  }

  async #read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8").catch(() => "");
  }

  #find(novel: Novel, id: string): { index: number; relationship: Relationship } {
    const relationship = novel.relationships.find((r) => r.id === id);
    if (!relationship) throw new OperationError("NOT_FOUND", `No relationship “${id}”.`);
    return { index: relationship.index, relationship };
  }

  #checkRelationship(novel: Novel, r: RelationshipFields): void {
    for (const end of [r.from, r.to]) {
      if (!end || !novel.entities.some((e) => e.id === end)) throw new OperationError("BAD_REQUEST", `No entity “${end ?? ""}”.`);
    }
    if (!r.type || !novel.relationshipTypes.some((t) => t.key === r.type)) throw new OperationError("BAD_REQUEST", `No relationship type “${r.type ?? ""}”.`);
    for (const scene of [r.since, r.until]) {
      if (scene && !novel.allScenes.some((s) => s.id === scene)) throw new OperationError("BAD_REQUEST", `No scene “${scene}”.`);
    }
    this.#checkSpan(novel, r.since ?? undefined, r.until ?? undefined, "A relationship must start before it ends.");
  }

  #findEvent(novel: Novel, id: string) {
    const event = novel.events.find((e) => e.id === id);
    if (!event) throw new OperationError("NOT_FOUND", `No event “${id}”.`);
    return event;
  }

  /** A time, a duration and entries of the right types, where given. */
  #checkEvent(novel: Novel, f: EventFields): void {
    const w = f.when;
    if (w) {
      const ok = "at" in w ? /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(w.at) : Number.isInteger(w.day) && (w.time === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(w.time));
      if (!ok) throw new OperationError("BAD_REQUEST", "A time is a date (YYYY-MM-DD, optionally THH:MM) or a day of the story with an optional HH:MM.");
    }
    if (f.duration && !/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(f.duration)) {
      throw new OperationError("BAD_REQUEST", "A duration is ISO 8601, like PT45M or P2D.");
    }
    for (const [key, type] of [["characters", "character"], ["locations", "location"], ["plotlines", "plotline"]] as const) {
      for (const id of f[key] ?? []) {
        if (!novel.entities.some((e) => e.id === id && e.type === type)) throw new OperationError("BAD_REQUEST", `No ${type} “${id}”.`);
      }
    }
  }

  /** `first` must come strictly before `second` in reading order, where both are given. */
  #checkSpan(novel: Novel, first: string | null | undefined, second: string | null | undefined, message: string): void {
    if (!first || !second) return;
    const a = novel.allScenes.find((s) => s.id === first)?.position ?? -1;
    const b = novel.allScenes.find((s) => s.id === second)?.position ?? -1;
    if (a < 0 || b < 0 || a >= b) throw new OperationError("BAD_REQUEST", message);
  }

  #describe(novel: Novel, r: { from?: string; to?: string; type?: string }): string {
    const name = (id?: string) => novel.entities.find((e) => e.id === id)?.name ?? id ?? "?";
    return `${name(r.from)} ${r.type} ${name(r.to)}`;
  }

  /** relationships.yaml with `record` appended (written fresh, in block style, when the list is empty). */
  async #appendRelationship(record: Record<string, unknown>, text?: string): Promise<string> {
    return this.#appendToList(RELATIONSHIPS, "relationships", record, text);
  }

  async #appendToList(path: string, key: string, item: Record<string, unknown>, text?: string): Promise<string> {
    const current = text ?? (await this.#read(path));
    const data = (current.trim() ? (parse(current) ?? {}) : {}) as Record<string, unknown>;
    const items = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
    if (items.length) return editYaml(current, [{ path: [key, items.length], value: item }]);
    // An empty list (`relationships: []`) or none: filled in as a block list.
    return editYaml(current, [{ path: [key], value: [item] }]);
  }

}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new OperationError("BAD_REQUEST", `A ${field} is required.`);
  return value.trim();
}

/** Fields with undefined, null and empty values left out. */
function clean(fields: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
}

function nullsToUndefined(fields: RelationshipFields): RelationshipFields {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === null ? undefined : v])) as RelationshipFields;
}

function editsAt(path: (string | number)[], changes: Record<string, unknown>) {
  return Object.entries(changes).map(([key, value]) => (value === null ? { path: [...path, key], remove: true as const } : { path: [...path, key], value }));
}
