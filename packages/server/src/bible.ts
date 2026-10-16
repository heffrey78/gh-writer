import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  backlinks,
  editFrontMatter,
  editYaml,
  eventFile,
  EVENTS_FOLDER,
  mentions,
  NOTES_FOLDER,
  proseText,
  indexById,
  loadNovel,
  nextSeriesSlot,
  SERIES,
  ID_PATTERN,
  RESERVED_PREFIXES,
  slugify,
  uniqueFileName,
  uniqueId,
  type Novel,
  type Relationship,
  type SeriesSlot,
  type YamlEdit,
} from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { parse, stringify } from "yaml";
import { hashText, IMAGES_DIR, MAX_IMAGE_BYTES, sniffImage } from "./files.ts";
import type { ManuscriptOperations } from "./manuscript.ts";
import { migrateNovel, migrationWrites, overlay } from "./migrate.ts";
import { OperationError, transaction, type FileWrite, type OperationResult } from "./operations.ts";

/** What an entity's front matter holds, apart from its ID. */
export interface EntityFields {
  name?: string;
  aliases?: string[];
  summary?: string | null;
  image?: string | null;
  image_focus?: [number, number] | null;
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
  /** The scene that dramatizes it. */
  scene?: string | null;
  /** Its note: the prose of its file. */
  note?: string | null;
}

/** A writer's note's fields (null removes one); `note` is its prose. */
export interface NoteFields {
  title?: string;
  tags?: string[] | null;
  /** The scenes it belongs to (#222); taking a scene off takes its pin too. */
  scenes?: string[] | null;
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
  /** How it's drawn: a palette slot and a line. */
  style?: { color?: SeriesSlot; line?: "solid" | "dashed" | "dotted" };
}

const LINES = ["solid", "dashed", "dotted"];

/** A style as the app may save it: only palette slots (never the status colours) and the three lines. */
function checkStyle(style: RelationshipTypeFields["style"]): void {
  if (!style) return;
  if (style.color !== undefined && !SERIES.some((s) => s.slot === style.color)) throw new OperationError("BAD_REQUEST", `“${style.color}” isn't one of the palette's colours.`);
  if (style.line !== undefined && !LINES.includes(style.line)) throw new OperationError("BAD_REQUEST", `A line is solid, dashed or dotted.`);
}

const RELATIONSHIPS = "bible/relationships.yaml";
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

  /**
   * Add an entity of `type` (an entity type key, built-in or custom). `wanted` is an ID the app picked
   * (for a mention written before the file): it must have the type's prefix and be unused, except
   * that asking again for one already made with that type and name (a retry) returns it unchanged.
   */
  createEntity(type: string, fields: EntityFields & { name: string }, notes = "", wanted?: string): Promise<OperationResult & { id: string; file: string }> {
    return this.#run(async (novel) => {
      const def = novel.entityTypes.find((t) => t.key === type);
      if (!def) throw new OperationError("BAD_REQUEST", `No entity type “${type}”.`);
      const name = required(fields.name, "name");
      const ids = new Set(indexById(novel).keys());
      if (wanted !== undefined) {
        const made = novel.entities.find((e) => e.id === wanted);
        if (made && made.type === type && made.name === name) return { commit: null, files: [], id: made.id, file: made.file };
        if (ID_PATTERN.exec(wanted)?.[1] !== def.prefix || ids.has(wanted)) throw new OperationError("BAD_REQUEST", `“${wanted}” can't be a new ${def.label.toLowerCase()}'s ID.`);
      }
      const id = wanted ?? uniqueId(def.prefix, ids);
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
        ...mentionsOf(novel, id).filter((r) => r.kind === "note"),
      ];
      if (references.length && !confirm) {
        throw new OperationError("REFERENCED", `“${entity.name}” is referred to in ${references.length} place${references.length === 1 ? "" : "s"}.`, { references });
      }
      // Its picture goes with it, unless something else shows the same file.
      const picture = this.#ownPicture(novel, entity.image, id);
      return transaction(this.root, [{ path: entity.file, content: null, base }, ...(picture ? [{ path: picture, content: null }] : [])], `Bible: remove ${entity.name}`);
    });
  }

  /**
   * Give an entity a picture (or a new one): `bytes` (JPEG or PNG, already resized by the app) saved
   * in images/ under a name from the entity's (images/ada-varn.jpg, with a suffix if taken), and its
   * `image` and `image_focus` set, in one commit. A picture it had before is replaced: its file is
   * reused when the name and format are the same, otherwise deleted.
   */
  setPicture(id: string, base: string, bytes: Uint8Array, focus?: [number, number]): Promise<OperationResult & { file: string; image: string }> {
    return this.#run(async (novel) => {
      const entity = novel.entities.find((e) => e.id === id);
      if (!entity) throw new OperationError("NOT_FOUND", `No entity “${id}”.`);
      const text = await this.#read(entity.file);
      if (hashText(text) !== base) throw new OperationError("STALE", `“${entity.name}” changed since it was read.`, { path: entity.file });
      const own = this.#ownPicture(novel, entity.image, id);
      const image = await this.#imagePath(slugify(entity.name), checkImage(bytes), own);
      const content = editFrontMatter(text, [{ path: ["image"], value: image }, focus ? { path: ["image_focus"], value: checkFocus(focus) } : { path: ["image_focus"], remove: true }]);
      const writes: FileWrite[] = [{ path: image, content: bytes }, { path: entity.file, content, base }];
      if (own && own !== image) writes.push({ path: own, content: null });
      const message = entity.image ? `Bible: change the picture of ${entity.name}` : `Bible: add a picture of ${entity.name}`;
      return { ...(await transaction(this.root, writes, message)), file: entity.file, image };
    });
  }

  /** Take an entity's picture away: its `image` and `image_focus` cleared and its file in images/ deleted, in one commit. */
  removePicture(id: string, base: string): Promise<OperationResult & { file: string }> {
    return this.#run(async (novel) => {
      const entity = novel.entities.find((e) => e.id === id);
      if (!entity) throw new OperationError("NOT_FOUND", `No entity “${id}”.`);
      const text = await this.#read(entity.file);
      if (hashText(text) !== base) throw new OperationError("STALE", `“${entity.name}” changed since it was read.`, { path: entity.file });
      if (!entity.image) return { commit: null, files: [], file: entity.file };
      const own = this.#ownPicture(novel, entity.image, id);
      const content = editFrontMatter(text, [{ path: ["image"], remove: true }, { path: ["image_focus"], remove: true }]);
      const writes: FileWrite[] = [{ path: entity.file, content, base }, ...(own ? [{ path: own, content: null }] : [])];
      return { ...(await transaction(this.root, writes, `Bible: remove the picture of ${entity.name}`)), file: entity.file };
    });
  }

  /** Give the book a cover (or a new one): images/cover.jpg (or .png) and `cover:` in novel.yaml, in one commit. */
  setCover(bytes: Uint8Array): Promise<OperationResult & { cover: string }> {
    return this.#run(async (novel) => {
      const old = novel.config?.cover;
      const own = this.#ownPicture(novel, old, "novel");
      const cover = await this.#imagePath("cover", checkImage(bytes), own);
      const writes: FileWrite[] = [{ path: cover, content: bytes }, { path: NOVEL, content: editYaml(await this.#read(NOVEL), [{ path: ["cover"], value: cover }]) }];
      if (own && own !== cover) writes.push({ path: own, content: null });
      return { ...(await transaction(this.root, writes, old ? "Change the book's cover" : "Add a cover to the book")), cover };
    });
  }

  /** Take the cover away: `cover:` out of novel.yaml and its file in images/ deleted, in one commit. */
  removeCover(): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const old = novel.config?.cover;
      if (!old) return { commit: null, files: [] };
      const own = this.#ownPicture(novel, old, "novel");
      const writes: FileWrite[] = [{ path: NOVEL, content: editYaml(await this.#read(NOVEL), [{ path: ["cover"], remove: true }]) }, ...(own ? [{ path: own, content: null }] : [])];
      return transaction(this.root, writes, "Remove the book's cover");
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

  /**
   * Add an off-page event: a file of its own, bible/events/<slug>.md, its note as the prose (D11). A novel
   * in format v1 is moved to v2 in the same commit when `migrate`, and refused with NEEDS_MIGRATION otherwise.
   */
  createEvent(fields: EventFields, migrate = false): Promise<OperationResult & { id: string; file: string }> {
    return this.#eventChange(migrate, async (novel) => {
      const title = required(fields.title, "title");
      this.#checkEvent(novel, fields);
      const id = uniqueId("evt", new Set(indexById(novel).keys()));
      const { note, ...front } = clean({ ...fields, title });
      const file = this.#eventFileName(novel, title);
      return { writes: [{ path: file, content: eventFile({ id, ...front }, note), base: null }], message: `Bible: add event “${title}”`, extra: { id, file } };
    });
  }

  /**
   * Change an event's fields (null removes one; `note` replaces its prose). A new title moves its file to
   * match. `base`, when given, is the hash of the file the change was made from. Migrates as createEvent does.
   */
  updateEvent(id: string, changes: EventFields, { base, migrate = false }: { base?: string; migrate?: boolean } = {}): Promise<OperationResult & { file: string }> {
    return this.#eventChange(migrate, async (novel, read, migrated) => {
      const event = this.#findEvent(novel, id);
      if (changes.title !== undefined) required(changes.title, "title");
      this.#checkEvent(novel, changes);
      const { note, ...fields } = changes;
      const tidy = Object.entries(fields).map(([key, v]) => (v === null || v === "" || (Array.isArray(v) && !v.length) ? { path: [key], remove: true as const } : { path: [key], value: v }));
      const text = (await read(event.file)) ?? "";
      if (base !== undefined && !migrated.has(event.file) && hashText(text) !== base) throw new OperationError("STALE", `“${event.title}” changed since it was read.`, { path: event.file });
      let content = editFrontMatter(text, tidy);
      if (note !== undefined) content = withProse(content, note ?? "");
      const check = migrated.has(event.file) ? {} : { base: hashText(text) };
      const title = changes.title?.trim() || event.title;
      const renamed = changes.title && changes.title.trim() !== event.title ? this.#eventFileName(novel, title, event.file) : event.file;
      const writes: FileWrite[] = renamed === event.file ? [{ path: event.file, content, ...check }] : [{ path: event.file, content: null, ...check }, { path: renamed, content, base: null }];
      const message = renamed === event.file ? `Bible: edit event “${title}”` : `Bible: rename event “${event.title}” to “${title}”`;
      return { writes, message, extra: { file: renamed } };
    });
  }

  /**
   * Remove an event's file. If prose mentions it (scenes, entries, other events), it's refused with every
   * mention unless `confirm`; they're then left for the validator to report. Migrates as createEvent does.
   */
  deleteEvent(id: string, { base, confirm = false, migrate = false }: { base?: string; confirm?: boolean; migrate?: boolean } = {}): Promise<OperationResult> {
    return this.#eventChange(migrate, async (novel, read, migrated) => {
      const event = this.#findEvent(novel, id);
      const references = mentionsOf(novel, id);
      if (references.length && !confirm) {
        throw new OperationError("REFERENCED", `“${event.title}” is mentioned in ${references.length} place${references.length === 1 ? "" : "s"}.`, { references });
      }
      const text = (await read(event.file)) ?? "";
      if (base !== undefined && !migrated.has(event.file) && hashText(text) !== base) throw new OperationError("STALE", `“${event.title}” changed since it was read.`, { path: event.file });
      return { writes: [{ path: event.file, content: null, ...(migrated.has(event.file) ? {} : { base: hashText(text) }) }], message: `Bible: remove event “${event.title}”`, extra: {} };
    });
  }

  /**
   * Write an off-page event as a scene (#165): a new scene at the end of `chapter` with the event's
   * title, time, duration, characters, locations and plotlines, and its note as the synopsis. The event
   * is kept, its `scene` naming the new one, or removed: refused (REFERENCED) while prose mentions it.
   * One commit; migrates as createEvent does.
   */
  writeAsScene(id: string, { chapter, keep, migrate = false }: { chapter: string; keep: boolean; migrate?: boolean }, manuscript: ManuscriptOperations): Promise<OperationResult & { scene: string; file: string }> {
    return this.#eventChange(migrate, async (novel, read) => {
      const event = this.#findEvent(novel, id);
      if (!keep) {
        const references = mentionsOf(novel, id);
        if (references.length) throw new OperationError("REFERENCED", `“${event.title}” is mentioned in ${references.length} place${references.length === 1 ? "" : "s"}, so it's kept.`, { references });
      }
      const synopsis = proseText(event.body).replace(/\s+/g, " ").trim();
      const front = clean({ synopsis, characters: event.characters, locations: event.locations, plotlines: event.plotlines, when: event.when, duration: event.duration });
      const scene = await manuscript.sceneWrites(novel, chapter, { title: event.title, front });
      const text = (await read(event.file)) ?? "";
      const writes: FileWrite[] = [...scene.writes, keep ? { path: event.file, content: editFrontMatter(text, [{ path: ["scene"], value: scene.id }]) } : { path: event.file, content: null }];
      return { writes, message: `Manuscript: write “${event.title}” as a scene${keep ? "" : ", removing the event"}`, extra: { scene: scene.id, file: scene.file } };
    });
  }

  /** Add a writer's note (D12): notes/<slug>.md, dated today, with `note` as its prose. */
  createNote(fields: NoteFields): Promise<OperationResult & { id: string; file: string }> {
    return this.#run(async (novel) => {
      const title = required(fields.title, "title");
      const id = uniqueId("note", new Set(indexById(novel).keys()));
      const file = this.#noteFileName(novel, title);
      const front = editYaml("", [
        { path: ["id"], value: id },
        { path: ["title"], value: title },
        ...(fields.tags?.length ? [{ path: ["tags"], value: fields.tags }] : []),
        ...(fields.scenes?.length ? [{ path: ["scenes"], value: this.#checkScenes(novel, fields.scenes) }] : []),
        // Local date and time to the second, so a day's notes still list newest first.
        { path: ["created"], value: localDateTime(new Date()) },
      ]);
      const content = withProse(`---\n${front}---\n`, fields.note ?? "");
      return { ...(await transaction(this.root, [{ path: file, content, base: null }], `Notes: add “${title}”`)), id, file };
    });
  }

  /** Change a note's title (its file moves to match), tags or prose (`note`). `base`: the file's hash as read. */
  updateNote(id: string, changes: NoteFields, { base }: { base?: string } = {}): Promise<OperationResult & { file: string }> {
    return this.#run(async (novel) => {
      const note = this.#findNote(novel, id);
      if (changes.title !== undefined) required(changes.title, "title");
      const text = await this.#read(note.file);
      if (base !== undefined && hashText(text) !== base) throw new OperationError("STALE", `“${note.title}” changed since it was read.`, { path: note.file });
      const edits: YamlEdit[] = [];
      if (changes.title !== undefined) edits.push({ path: ["title"], value: changes.title.trim() });
      if (changes.tags !== undefined) edits.push(changes.tags?.length ? { path: ["tags"], value: changes.tags } : { path: ["tags"], remove: true });
      if (changes.scenes !== undefined) {
        const scenes = this.#checkScenes(novel, changes.scenes ?? []);
        const pinned = note.pinned.filter((id) => scenes.includes(id));
        edits.push(scenes.length ? { path: ["scenes"], value: scenes } : { path: ["scenes"], remove: true });
        if (pinned.length !== note.pinned.length) edits.push(pinned.length ? { path: ["pinned"], value: pinned } : { path: ["pinned"], remove: true });
      }
      let content = editFrontMatter(text, edits);
      if (changes.note !== undefined) content = withProse(content, changes.note ?? "");
      const title = changes.title?.trim() || note.title;
      const file = title !== note.title ? this.#noteFileName(novel, title, note.file) : note.file;
      const writes: FileWrite[] = file === note.file ? [{ path: note.file, content, base: hashText(text) }] : [{ path: note.file, content: null, base: hashText(text) }, { path: file, content, base: null }];
      const message = title !== note.title ? `Notes: rename “${note.title}” to “${title}”` : `Notes: edit “${title}”`;
      return { ...(await transaction(this.root, writes, message)), file };
    });
  }

  /**
   * Pin a note to the top of a scene's notes, or unpin it (#222). A scene has one pinned note: pinning
   * this one unpins the scene's other, in the same commit. Pinning in a scene the note isn't on puts it there.
   */
  pinNote(id: string, scene: string, pinned: boolean): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const note = this.#findNote(novel, id);
      this.#checkScenes(novel, [scene]);
      const writes: FileWrite[] = [];
      const edit = async (n: Novel["notes"][number], scenes: string[], pins: string[]) => {
        const text = await this.#read(n.file);
        const edits: YamlEdit[] = [];
        if (scenes.join() !== n.scenes.join()) edits.push(scenes.length ? { path: ["scenes"], value: scenes } : { path: ["scenes"], remove: true });
        if (pins.join() !== n.pinned.join()) edits.push(pins.length ? { path: ["pinned"], value: pins } : { path: ["pinned"], remove: true });
        if (edits.length) writes.push({ path: n.file, content: editFrontMatter(text, edits), base: hashText(text) });
      };
      if (pinned) {
        for (const other of novel.notes) if (other.id !== id && other.pinned.includes(scene)) await edit(other, other.scenes, other.pinned.filter((s) => s !== scene));
        await edit(note, note.scenes.includes(scene) ? note.scenes : [...note.scenes, scene], note.pinned.includes(scene) ? note.pinned : [...note.pinned, scene]);
      } else await edit(note, note.scenes, note.pinned.filter((s) => s !== scene));
      const title = novel.allScenes.find((s) => s.id === scene)?.title ?? scene;
      return transaction(this.root, writes, pinned ? `Notes: pin “${note.title}” in “${title}”` : `Notes: unpin “${note.title}” in “${title}”`);
    });
  }

  deleteNote(id: string, { base }: { base?: string } = {}): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const note = this.#findNote(novel, id);
      const text = await this.#read(note.file);
      if (base !== undefined && hashText(text) !== base) throw new OperationError("STALE", `“${note.title}” changed since it was read.`, { path: note.file });
      return transaction(this.root, [{ path: note.file, content: null, base: hashText(text) }], `Notes: remove “${note.title}”`);
    });
  }

  /**
   * Promote a note (#205): to an off-page event (its title, and its prose as the event's note), or to a
   * scene at the end of `chapter` (its title, and its prose as the synopsis). The note is kept, `became`
   * naming what it became, or removed; one commit. To an event in a novel in format v1, migrates as createEvent does.
   */
  promoteNote(
    id: string,
    to: { to: "event" } | { to: "scene"; chapter: string },
    { keep, migrate = false }: { keep: boolean; migrate?: boolean },
    manuscript: ManuscriptOperations,
  ): Promise<OperationResult & { id: string; file: string }> {
    const noteWrite = async (novel: Novel, read: (path: string) => Promise<string | undefined>, made: string): Promise<FileWrite> => {
      const note = this.#findNote(novel, id);
      const text = (await read(note.file)) ?? "";
      return keep ? { path: note.file, content: editFrontMatter(text, [{ path: ["became"], value: made }]), base: hashText(text) } : { path: note.file, content: null, base: hashText(text) };
    };
    if (to.to === "event") {
      return this.#eventChange(migrate, async (novel, read) => {
        const note = this.#findNote(novel, id);
        const made = uniqueId("evt", new Set(indexById(novel).keys()));
        const file = this.#eventFileName(novel, note.title);
        const writes = [{ path: file, content: eventFile({ id: made, title: note.title }, note.body), base: null }, await noteWrite(novel, read, made)];
        return { writes, message: `Notes: promote “${note.title}” to an off-page event${keep ? "" : ", removing the note"}`, extra: { id: made, file } };
      });
    }
    return this.#run(async (novel) => {
      const note = this.#findNote(novel, id);
      const synopsis = proseText(note.body).replace(/\s+/g, " ").trim();
      const scene = await manuscript.sceneWrites(novel, to.chapter, { title: note.title, front: synopsis ? { synopsis } : {} });
      const writes = [...scene.writes, await noteWrite(novel, (path) => this.#read(path), scene.id)];
      const message = `Notes: write “${note.title}” as a scene${keep ? "" : ", removing the note"}`;
      return { ...(await transaction(this.root, writes, message)), id: scene.id, file: scene.file };
    });
  }

  /** Move the novel to the newest format (D11), on its own, in one commit. */
  migrate(): Promise<OperationResult & { migrated: boolean }> {
    return this.#exclusive(async () => {
      const { migration, result } = await migrateNovel(this.root);
      if (migration.status === "refused") throw new OperationError("BAD_REQUEST", migration.reason);
      return { ...(result ?? { commit: null, files: [] }), migrated: migration.status === "migrate" };
    });
  }

  /**
   * An event change, made on the novel as format v2 has it. A v1 novel is migrated first, in the same
   * commit, if `migrate`; otherwise it's NEEDS_MIGRATION, for the app to ask the writer. `fn` reads files
   * as they'll be after the migration, and is told which paths the migration writes (no base to check).
   */
  #eventChange<T extends object>(
    migrate: boolean,
    fn: (novel: Novel, read: (path: string) => Promise<string | undefined>, migrated: ReadonlySet<string>) => Promise<{ writes: FileWrite[]; message: string; extra: T }>,
  ): Promise<OperationResult & T> {
    return this.#exclusive(async () => {
      const { migration, writes: moved } = await migrationWrites(this.root);
      if (migration.status === "refused") throw new OperationError("BAD_REQUEST", migration.reason);
      if (migration.status === "migrate" && !migrate) {
        throw new OperationError("NEEDS_MIGRATION", `Off-page events are kept differently in format v${migration.to}: the novel must move to it first.`, { from: migration.from, to: migration.to });
      }
      const source = overlay(nodeSource(this.root), moved);
      const { writes, message, extra } = await fn(await loadNovel(source), (path) => source.read(path), new Set(moved.map((w) => w.path)));
      // A file the change writes again (an event file the migration made) is written once, as the change has it.
      const again = new Set(writes.map((w) => w.path));
      const all = [...moved.filter((w) => !again.has(w.path)), ...writes];
      const result = await transaction(this.root, all, migration.status === "migrate" ? `${migration.message}; ${message}` : message);
      return { ...result, ...extra };
    });
  }

  /** Scene IDs that are scenes, each once; anything else is refused. */
  #checkScenes(novel: Novel, ids: string[]): string[] {
    for (const id of ids) if (!novel.allScenes.some((s) => s.id === id)) throw new OperationError("BAD_REQUEST", `No scene “${id}”.`);
    return [...new Set(ids)];
  }

  #findNote(novel: Novel, id: string) {
    const note = novel.notes.find((n) => n.id === id);
    if (!note) throw new OperationError("NOT_FOUND", `No note “${id}”.`);
    return note;
  }

  /** notes/<slug>.md for a title, unused by any other note (`own` is the note's file now, free to keep). */
  #noteFileName(novel: Novel, title: string, own?: string): string {
    const taken = new Set(novel.notes.filter((n) => n.file !== own).map((n) => n.file.slice(NOTES_FOLDER.length + 1)));
    return `${NOTES_FOLDER}/${uniqueFileName(slugify(title), ".md", taken)}`;
  }

  /** bible/events/<slug>.md for a title, unused by any other event (`own` is the event's file now, free to keep). */
  #eventFileName(novel: Novel, title: string, own?: string): string {
    const folder = `bible/${EVENTS_FOLDER}`;
    const taken = new Set(novel.events.filter((e) => e.file !== own && e.file.startsWith(`${folder}/`)).map((e) => e.file.slice(folder.length + 1)));
    return `${folder}/${uniqueFileName(slugify(title), ".md", taken)}`;
  }

  /**
   * Set the book's targets in novel.yaml: the length to reach, by when, and the words a day aimed for
   * (null removes one). One commit.
   */
  updateTarget(changes: { words?: number | null; date?: string | null; daily?: number | null }): Promise<OperationResult> {
    return this.#run(async (novel) => {
      for (const key of ["words", "daily"] as const) {
        const v = changes[key];
        if (v !== undefined && v !== null && !(Number.isInteger(v) && v > 0)) throw new OperationError("BAD_REQUEST", `${key === "words" ? "The target length" : "The daily goal"} is a whole number of words, more than none.`);
      }
      if (changes.date !== undefined && changes.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(changes.date)) throw new OperationError("BAD_REQUEST", "The date is YYYY-MM-DD.");
      const current = { ...(novel.config?.target ?? {}) } as Record<string, unknown>;
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) (v === null ? delete current[k] : (current[k] = v));
      // An empty target goes altogether, rather than leaving `target: {}`.
      const edits = Object.keys(current).length ? editsAt(["target"], changes as Record<string, unknown>) : [{ path: ["target"], remove: true as const }];
      const content = editYaml(await this.#read(NOVEL), edits.filter((e) => !("value" in e) || e.value !== undefined));
      return transaction(this.root, [{ path: NOVEL, content }], "Set the book's targets");
    });
  }

  /**
   * Say when Day 1 is (#239): novel.yaml's calendar.start, so days of the story sit among dates (Day 0
   * the day before). null removes it, and the calendar with it. One commit.
   */
  updateCalendar(start: string | null): Promise<OperationResult> {
    return this.#run(async () => {
      if (start !== null && !(typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start) && !Number.isNaN(Date.parse(`${start}T00:00:00Z`)))) throw new OperationError("BAD_REQUEST", "Day 1 is a date, YYYY-MM-DD.");
      const content = editYaml(await this.#read(NOVEL), [start === null ? { path: ["calendar"], remove: true } : { path: ["calendar", "start"], value: start }]);
      return transaction(this.root, [{ path: NOVEL, content }], start === null ? "Day 1 has no date" : "Set when Day 1 is");
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
      checkStyle(fields.style);
      // Its own colour from the start, the first no type uses, so adding a type never repaints the others.
      const style = { color: fields.style?.color ?? nextSeriesSlot(novel), line: fields.style?.line ?? "solid" };
      const content = await this.#appendToList(NOVEL, "relationship_types", clean({ ...fields, label: required(fields.label, "label"), style }));
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: add the “${fields.label}” relationship`);
    });
  }

  updateRelationshipType(key: string, changes: Partial<Omit<RelationshipTypeFields, "key">>): Promise<OperationResult> {
    return this.#run(async (novel) => {
      const index = novel.relationshipTypes.findIndex((t) => t.key === key);
      if (index < 0) throw new OperationError("NOT_FOUND", `No relationship type “${key}”.`);
      const { style, ...rest } = changes;
      checkStyle(style);
      // The style's own lines, so the rest of the type is left as written.
      const styleEdits = Object.entries(style ?? {}).map(([k, value]) => ({ path: ["relationship_types", index, "style", k], value }));
      const content = editYaml(await this.#read(NOVEL), [...editsAt(["relationship_types", index], rest), ...styleEdits]);
      return transaction(this.root, [{ path: NOVEL, content }], `Bible: edit the “${key}” relationship`);
    });
  }

  // ——— Helpers ———

  /**
   * `image` (the picture of entity `owner`, or of the book for "novel"), if it's one the app may delete
   * along with it: a file in images/ that nothing else shows. A picture kept elsewhere is the author's.
   */
  #ownPicture(novel: Novel, image: string | undefined, owner: string): string | undefined {
    if (!image?.startsWith(`${IMAGES_DIR}/`) || image.split("/").some((s) => s === ".." || s === "." || s.startsWith("."))) return undefined;
    const shared = (owner !== "novel" && novel.config?.cover === image) || novel.entities.some((e) => e.id !== owner && e.image === image);
    return shared ? undefined : image;
  }

  /** images/<slug><ext>, with a suffix if another file has the name; `replacing` (the picture it takes over) doesn't count. */
  async #imagePath(slug: string, ext: string, replacing: string | undefined): Promise<string> {
    const names = await readdir(join(this.root, IMAGES_DIR)).catch(() => [] as string[]);
    const taken = new Set(names.filter((n) => `${IMAGES_DIR}/${n}` !== replacing));
    return `${IMAGES_DIR}/${uniqueFileName(slug, ext, taken)}`;
  }

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
    if (f.scene && !novel.allScenes.some((sc) => sc.id === f.scene)) throw new OperationError("BAD_REQUEST", `No scene “${f.scene}”.`);
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

/** The extension for image bytes the app sent: JPEG or PNG, within GitHub's limit. */
function checkImage(bytes: Uint8Array): ".jpg" | ".png" {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new OperationError("BAD_REQUEST", "The image is larger than GitHub's 100 MB limit.");
  const format = sniffImage(bytes);
  if (!format) throw new OperationError("BAD_REQUEST", "That isn't a JPEG or PNG image.");
  return format.ext;
}

/** A focal point within the picture, rounded to three places. */
function checkFocus(focus: [number, number]): [number, number] {
  if (!Array.isArray(focus) || focus.length !== 2 || !focus.every((n) => typeof n === "number" && n >= 0 && n <= 1)) {
    throw new OperationError("BAD_REQUEST", "A focal point is two fractions, x and y, from 0 to 1.");
  }
  return [Math.round(focus[0] * 1000) / 1000, Math.round(focus[1] * 1000) / 1000];
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new OperationError("BAD_REQUEST", `A ${field} is required.`);
  return value.trim();
}

/** "2026-10-15T14:03:09": a moment as the writer's clock reads it. */
function localDateTime(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** The prose that mentions a record: scenes, entries, other events and notes, for a delete to list. */
function mentionsOf(novel: Novel, id: string) {
  const mentioned = (body: string) => mentions(body).some((m) => m.id === id);
  return [
    ...novel.allScenes.filter((s) => mentioned(s.body)).map((s) => ({ kind: "scene", id: s.id, title: s.title, via: ["mention"] })),
    ...novel.entities.filter((e) => e.id !== id && mentioned(e.body)).map((e) => ({ kind: "entity", id: e.id, title: e.name })),
    ...novel.events.filter((e) => e.id !== id && mentioned(e.body)).map((e) => ({ kind: "event", id: e.id, title: e.title })),
    ...novel.notes.filter((n) => mentioned(n.body)).map((n) => ({ kind: "note", id: n.id, title: n.title })),
  ];
}

/** A Markdown file with its prose replaced, and its front matter kept byte for byte. */
function withProse(text: string, prose: string): string {
  const m = /^(\uFEFF?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$))/m.exec(text);
  const front = m && m.index === 0 ? m[1]! : "";
  return `${front}${front.endsWith("\n") || !front ? "" : "\n"}${prose.trim() ? `\n${prose.trim()}\n` : ""}`;
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
