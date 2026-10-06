import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { editFrontMatter, editYaml, indexById, loadNovel, numberedName, slugify, uniqueId, type Chapter, type Novel, type Part, type Scene } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { parse, stringify } from "yaml";
import { git } from "./git.ts";
import { OperationError, transaction, type FileWrite, type OperationResult } from "./operations.ts";

const ORDER = "manuscript/_order.yaml";

/** A scene, chapter or part that was deleted and can be brought back. */
export interface DeletedItem {
  /** The commit that deleted it: restore it from the one before. */
  commit: string;
  date: string;
  kind: "scene" | "chapter" | "part";
  id: string;
  title: string;
  /** Where it was, relative to the novel. */
  path: string;
}

type Container = { kind: "chapter"; chapter: Chapter } | { kind: "part"; part: Part } | { kind: "top" };

/** Pending changes on top of the disk: what every step of an operation reads and writes. */
class Overlay {
  readonly writes = new Map<string, string | null>();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async read(path: string): Promise<string | null> {
    if (this.writes.has(path)) return this.writes.get(path)!;
    return readFile(join(this.root, path), "utf8").catch(() => null);
  }

  set(path: string, content: string | null): void {
    this.writes.set(path, content);
  }

  /** Text files under `dir`, as they are now (pending changes included). */
  async files(dir: string): Promise<string[]> {
    const out = new Set<string>();
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(join(this.root, d), { withFileTypes: true }).catch(() => [])) {
        const p = posix.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.startsWith(".")) out.add(p);
      }
    };
    await walk(dir);
    for (const [p, c] of this.writes) {
      if (!p.startsWith(`${dir}/`)) continue;
      if (c === null) out.delete(p);
      else out.add(p);
    }
    return [...out].sort();
  }

  /** Move files from → to all at once (contents read first, so names can be swapped). */
  async move(moves: [string, string][]): Promise<void> {
    const real = moves.filter(([a, b]) => a !== b);
    const contents = await Promise.all(real.map(([from]) => this.read(from)));
    for (const [from] of real) this.set(from, null);
    real.forEach(([, to], i) => this.set(to, contents[i]!));
  }

  /** The net changes: a file created and then moved on within the operation was never there. */
  changes(): FileWrite[] {
    return [...this.writes].filter(([path, content]) => content !== null || existsSync(join(this.root, path))).map(([path, content]) => ({ path, content }));
  }
}

/**
 * Reshaping the manuscript: create, rename, move, split, merge, delete and restore scenes, chapters and
 * parts. Each is one commit. IDs never change; order files are edited in place; numbered file and
 * folder names follow the order (only the number changes, unless the item is renamed).
 */
export class ManuscriptOperations {
  readonly root: string;
  #exclusive: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(root: string, exclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
    this.root = root;
    this.#exclusive = exclusive;
  }

  /** A new scene in a chapter, after `after` (null: first; omitted: last). */
  createScene(chapterId: string, { title, after }: { title: string; after?: string | null }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel, o) => {
      const chapter = this.#chapter(novel, chapterId);
      const name = required(title, "title");
      const id = uniqueId("sc", new Set(indexById(novel).keys()));
      const path = `${chapter.dir}/${slugify(name)}.md`;
      o.set(path, `---\n${stringify({ id, title: name, status: "idea" }, { lineWidth: 0 })}---\n`);
      await this.#insert(o, { kind: "chapter", chapter }, id, after);
      await this.#renumber(o, novel, { kind: "chapter", chapter }, new Map([[id, path]]));
      return { message: `Manuscript: add scene “${name}”`, id };
    });
  }

  /** A new, empty chapter in a part (or at the top level), after `after`. */
  createChapter(partId: string | null, { title, after }: { title?: string; after?: string | null }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel, o) => {
      const parent = this.#parentFor(novel, partId);
      const id = uniqueId("ch", new Set(indexById(novel).keys()));
      const dir = `${parent.kind === "part" ? parent.part.dir : "manuscript"}/${slugify(title?.trim() || "chapter")}`;
      o.set(`${dir}/_chapter.yaml`, stringify({ id, ...(title?.trim() ? { title: title.trim() } : {}), scenes: [] }, { lineWidth: 0, flowCollectionPadding: false }));
      await this.#insert(o, parent, id, after);
      await this.#renumber(o, novel, parent, new Map([[id, dir]]));
      return { message: `Manuscript: add chapter${title?.trim() ? ` “${title.trim()}”` : ""}`, id };
    });
  }

  /** A new, empty part, after `after`. Only in a book organised in parts. */
  createPart({ title, after }: { title: string; after?: string | null }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel, o) => {
      if (novel.topLevel !== "parts") throw new OperationError("BAD_REQUEST", "This book is organised in chapters, not parts.");
      const name = required(title, "title");
      const id = uniqueId("pt", new Set(indexById(novel).keys()));
      const dir = `manuscript/${slugify(name)}`;
      o.set(`${dir}/_part.yaml`, stringify({ id, title: name, chapters: [] }, { lineWidth: 0, flowCollectionPadding: false }));
      await this.#insert(o, { kind: "top" }, id, after);
      await this.#renumber(o, novel, { kind: "top" }, new Map([[id, dir]]));
      return { message: `Manuscript: add part “${name}”`, id };
    });
  }

  /** A new title for a scene, chapter or part; its file or folder name follows. */
  rename(id: string, title: string): Promise<OperationResult> {
    return this.#run(async (novel, o) => {
      const name = title.trim();
      const item = this.#find(novel, id);
      if (item.kind !== "chapter" && !name) throw new OperationError("BAD_REQUEST", "A title is required.");
      if (item.kind === "scene") {
        o.set(item.scene.file, editFrontMatter((await o.read(item.scene.file))!, [{ path: ["title"], value: name }]));
        await o.move([[item.scene.file, rename(item.scene.file, slugify(name), ".md")]]);
      } else {
        const file = item.kind === "chapter" ? item.chapter.file : item.part.file;
        const dir = item.kind === "chapter" ? item.chapter.dir : item.part.dir;
        o.set(file, editYaml((await o.read(file))!, [name ? { path: ["title"], value: name } : { path: ["title"], remove: true }]));
        await this.#moveDir(o, dir, rename(dir, slugify(name || "chapter"), ""));
      }
      return { message: `Manuscript: rename ${item.kind} to “${name || "untitled"}”` };
    });
  }

  /**
   * Move a scene into a chapter (or a chapter into a part, or a part) at position `index` among its new
   * siblings. Reordering is a move within the same container.
   */
  move(id: string, { to, index }: { to?: string | null; index: number }): Promise<OperationResult> {
    return this.#run(async (novel, o) => {
      const item = this.#find(novel, id);
      const from: Container =
        item.kind === "scene" ? { kind: "chapter", chapter: this.#chapter(novel, item.scene.chapterId!) } : item.kind === "chapter" ? this.#parentFor(novel, item.chapter.partId ?? null) : { kind: "top" };
      const target: Container =
        item.kind === "scene" ? { kind: "chapter", chapter: this.#chapter(novel, to ?? item.scene.chapterId!) } : item.kind === "chapter" ? this.#parentFor(novel, to === undefined ? (item.chapter.partId ?? null) : to) : { kind: "top" };
      await this.#removeFrom(o, from, id);
      const list = await this.#list(o, target);
      const position = Math.max(0, Math.min(index, list.length));
      await this.#setList(o, target, [...list.slice(0, position), id, ...list.slice(position)]);
      const paths = new Map<string, string>();
      if (!sameContainer(from, target)) {
        const dir = targetDir(target);
        if (item.kind === "scene") {
          const dest = `${dir}/${posix.basename(item.scene.file)}`;
          await o.move([[item.scene.file, dest]]);
          paths.set(id, dest);
        } else if (item.kind === "chapter") {
          const dest = `${dir}/${posix.basename(item.chapter.dir)}`;
          await this.#moveDir(o, item.chapter.dir, dest);
          paths.set(id, dest);
        }
        await this.#renumber(o, novel, from, new Map());
      }
      await this.#renumber(o, novel, target, paths);
      const title = item.kind === "scene" ? `scene “${item.scene.title}”` : item.kind === "chapter" ? `chapter${item.chapter.title ? ` “${item.chapter.title}”` : ""}` : `part “${item.part.title}”`;
      return { message: `Manuscript: move ${title}` };
    });
  }

  /**
   * Split a scene before its paragraph `paragraph` (0-based, counting blocks separated by blank lines):
   * the rest becomes a new scene, right after, titled `title`, keeping the first's status, point of view,
   * people, places, plotlines, themes and tags.
   */
  split(sceneId: string, { paragraph, title }: { paragraph: number; title: string }): Promise<OperationResult & { id: string }> {
    return this.#run(async (novel, o) => {
      const scene = this.#scene(novel, sceneId);
      const name = required(title, "title");
      const text = (await o.read(scene.file))!;
      const fmEnd = text.length - bodyOf(text).length;
      const body = text.slice(fmEnd);
      const starts = paragraphStarts(body);
      if (paragraph < 1 || paragraph >= starts.length) throw new OperationError("BAD_REQUEST", "Split between two paragraphs of the scene.");
      const cut = starts[paragraph]!;
      const first = text.slice(0, fmEnd) + body.slice(0, cut).replace(/\s*$/, "\n");
      const id = uniqueId("sc", new Set(indexById(novel).keys()));
      const keep = Object.fromEntries(
        Object.entries(parse(text.slice(0, fmEnd).replace(/^﻿?---\r?\n/, "").replace(/---[ \t]*\r?\n?$/, "")) ?? {}).filter(([k]) =>
          ["status", "pov", "characters", "locations", "plotlines", "themes", "tags"].includes(k),
        ),
      );
      const path = `${posix.dirname(scene.file)}/${slugify(name)}.md`;
      o.set(scene.file, first);
      o.set(path, `---\n${stringify({ id, title: name, ...keep }, { lineWidth: 0 })}---\n${body.slice(cut)}`);
      const chapter: Container = { kind: "chapter", chapter: this.#chapter(novel, scene.chapterId!) };
      await this.#insert(o, chapter, id, sceneId);
      await this.#renumber(o, novel, chapter, new Map([[id, path]]));
      return { message: `Manuscript: split “${scene.title}”, the rest as “${name}”`, id };
    });
  }

  /**
   * Merge a scene with the next one in its chapter: the next one's prose follows, its people and places
   * join the first's, and its file goes. Relationships that started or ended at it move to the first.
   */
  merge(sceneId: string): Promise<OperationResult> {
    return this.#run(async (novel, o) => {
      const scene = this.#scene(novel, sceneId);
      const chapter = this.#chapter(novel, scene.chapterId!);
      const at = chapter.sceneIds.indexOf(sceneId);
      const next = novel.allScenes.find((s) => s.id === chapter.sceneIds[at + 1]);
      if (!next) throw new OperationError("BAD_REQUEST", `“${scene.title}” is the last scene of its chapter.`);
      const firstText = (await o.read(scene.file))!;
      const nextText = (await o.read(next.file))!;
      const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
      const edits = [
        ...(union(scene.characters, next.characters).length > scene.characters.length ? [{ path: ["characters"], value: union(scene.characters, next.characters) }] : []),
        ...(union(scene.locations, next.locations).length > scene.locations.length ? [{ path: ["locations"], value: union(scene.locations, next.locations) }] : []),
      ];
      const merged = editFrontMatter(firstText, edits).replace(/\s*$/, "\n") + "\n" + bodyOf(nextText).replace(/^\s+/, "");
      o.set(scene.file, merged);
      o.set(next.file, null);
      await this.#removeFrom(o, { kind: "chapter", chapter }, next.id);
      await this.#retarget(o, novel, next.id, sceneId);
      await this.#renumber(o, novel, { kind: "chapter", chapter }, new Map());
      return { message: `Manuscript: merge “${next.title}” into “${scene.title}”` };
    });
  }

  /** Delete a scene, chapter or part (with what's in it). It stays in history: see recentlyDeleted. */
  delete(id: string): Promise<OperationResult> {
    return this.#run(async (novel, o) => {
      const item = this.#find(novel, id);
      if (item.kind === "scene") {
        o.set(item.scene.file, null);
        await this.#removeFrom(o, { kind: "chapter", chapter: this.#chapter(novel, item.scene.chapterId!) }, id);
        await this.#renumber(o, novel, { kind: "chapter", chapter: this.#chapter(novel, item.scene.chapterId!) }, new Map());
        return { message: `Manuscript: delete scene “${item.scene.title}”` };
      }
      const dir = item.kind === "chapter" ? item.chapter.dir : item.part.dir;
      for (const f of await o.files(dir)) o.set(f, null);
      const parent = item.kind === "chapter" ? this.#parentFor(novel, item.chapter.partId ?? null) : ({ kind: "top" } as Container);
      await this.#removeFrom(o, parent, id);
      await this.#renumber(o, novel, parent, new Map());
      const title = item.kind === "chapter" ? (item.chapter.title ?? "untitled") : item.part.title;
      return { message: `Manuscript: delete ${item.kind} “${title}”` };
    });
  }

  /** Scenes, chapters and parts deleted from the manuscript, newest first, that aren't back already. */
  async recentlyDeleted(limit = 30): Promise<DeletedItem[]> {
    const g = git(this.root);
    const log = await g.raw(["log", "--diff-filter=D", "--name-only", "--relative", "--format=%x1e%H%x1f%cI", "-n", "200", "--", "manuscript"]).catch(() => "");
    const present = new Set(indexById(await loadNovel(nodeSource(this.root))).keys());
    const out: DeletedItem[] = [];
    for (const record of log.split("\x1e").filter((r) => r.trim())) {
      const [head, ...files] = record.trim().split("\n");
      const [commit, date] = head!.split("\x1f") as [string, string];
      const deleted = files.filter(Boolean);
      const containers = deleted.filter((f) => /\/_(part|chapter)\.yaml$/.test(f)).map((f) => posix.dirname(f));
      // A container's own files are part of it; the outermost containers are the items.
      const tops = containers.filter((d) => !containers.some((other) => other !== d && d.startsWith(`${other}/`)));
      for (const dir of tops) {
        const kind = deleted.includes(`${dir}/_part.yaml`) ? "part" : "chapter";
        const data = parse((await this.#show(`${commit}^`, `${dir}/_${kind}.yaml`)) ?? "") as { id?: string; title?: string } | null;
        if (data?.id && !present.has(data.id)) out.push({ commit, date, kind, id: data.id, title: data.title ?? "untitled", path: dir });
      }
      for (const file of deleted.filter((f) => f.endsWith(".md") && !tops.some((d) => f.startsWith(`${d}/`)))) {
        const text = (await this.#show(`${commit}^`, file)) ?? "";
        const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
        const data = (fm ? parse(fm) : null) as { id?: string; title?: string } | null;
        if (data?.id && !present.has(data.id)) out.push({ commit, date, kind: "scene", id: data.id, title: data.title ?? posix.basename(file), path: file });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  /** Bring back a deleted item from the commit before `commit` deleted it, into its place in the order. */
  restore(commit: string, id: string): Promise<OperationResult> {
    return this.#exclusive(async () => {
      const item = (await this.recentlyDeleted(200)).find((d) => d.commit === commit && d.id === id);
      if (!item) throw new OperationError("NOT_FOUND", "That isn't among the recently deleted.");
      const novel = await loadNovel(nodeSource(this.root));
      const o = new Overlay(this.root);
      const before = `${commit}^`;
      // Where it was: its old container (by ID), and the sibling it followed.
      const parentDir = posix.dirname(item.path);
      const parentFile = item.kind === "scene" ? `${parentDir}/_chapter.yaml` : item.kind === "chapter" && parentDir !== "manuscript" ? `${parentDir}/_part.yaml` : ORDER;
      const oldParent = (parse((await this.#show(before, parentFile)) ?? "") ?? {}) as Record<string, unknown>;
      const key = item.kind === "scene" ? "scenes" : item.kind === "part" ? "parts" : "chapters";
      const oldList = Array.isArray(oldParent[key]) ? (oldParent[key] as string[]) : [];
      let container: Container;
      if (item.kind === "scene") {
        const chapter = novel.allChapters.find((c) => c.id === oldParent["id"]);
        if (!chapter) throw new OperationError("BAD_REQUEST", "The chapter it was in is gone: bring that back first.");
        container = { kind: "chapter", chapter };
      } else if (item.kind === "chapter" && parentFile !== ORDER) {
        const part = novel.allParts.find((p) => p.id === oldParent["id"]);
        if (!part) throw new OperationError("BAD_REQUEST", "The part it was in is gone: bring that back first.");
        container = { kind: "part", part };
      } else container = { kind: "top" };

      // Its files, back under the container's current folder.
      const destDir = targetDir(container);
      const files = item.kind === "scene" ? [item.path] : (await git(this.root).raw(["ls-tree", "-r", "--name-only", before, "--", `./${item.path}`])).split("\n").filter(Boolean);
      const taken = new Set((await o.files(destDir)).map((f) => f.slice(destDir.length + 1).split("/")[0]!));
      const base = posix.basename(item.path);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = item.kind === "scene" ? base.replace(/\.md$/, `-${n}.md`) : `${base}-${n}`;
      const newPath = `${destDir}/${name}`;
      for (const f of files) o.set(item.kind === "scene" ? newPath : `${newPath}${f.slice(item.path.length)}`, (await this.#show(before, f)) ?? "");

      const current = await this.#list(o, container);
      const previous = oldList.slice(0, oldList.indexOf(id)).reverse().find((s) => current.includes(s));
      const at = previous === undefined ? 0 : current.indexOf(previous) + 1;
      await this.#setList(o, container, [...current.slice(0, at), id, ...current.slice(at)]);
      await this.#renumber(o, novel, container, new Map([[id, newPath]]));
      return transaction(this.root, o.changes(), `Manuscript: restore ${item.kind} “${item.title}”`);
    });
  }

  // ——— Steps ———

  #run<T extends object>(fn: (novel: Novel, o: Overlay) => Promise<T & { message: string }>): Promise<OperationResult & Omit<T, "message">> {
    return this.#exclusive(async () => {
      const novel = await loadNovel(nodeSource(this.root));
      const o = new Overlay(this.root);
      const { message, ...rest } = await fn(novel, o);
      return { ...(await transaction(this.root, o.changes(), message)), ...(rest as Omit<T, "message">) };
    });
  }

  async #show(rev: string, path: string): Promise<string | undefined> {
    return git(this.root).raw(["show", `${rev}:./${path}`]).catch(() => undefined);
  }

  #find(novel: Novel, id: string): { kind: "scene"; scene: Scene } | { kind: "chapter"; chapter: Chapter } | { kind: "part"; part: Part } {
    const scene = novel.allScenes.find((s) => s.id === id);
    if (scene) return { kind: "scene", scene };
    const chapter = novel.allChapters.find((c) => c.id === id);
    if (chapter) return { kind: "chapter", chapter };
    const part = novel.allParts.find((p) => p.id === id);
    if (part) return { kind: "part", part };
    throw new OperationError("NOT_FOUND", `Nothing in the manuscript has the ID “${id}”.`);
  }

  #scene(novel: Novel, id: string): Scene {
    const scene = novel.allScenes.find((s) => s.id === id);
    if (!scene) throw new OperationError("NOT_FOUND", `No scene “${id}”.`);
    return scene;
  }

  #chapter(novel: Novel, id: string): Chapter {
    const chapter = novel.allChapters.find((c) => c.id === id);
    if (!chapter) throw new OperationError("NOT_FOUND", `No chapter “${id}”.`);
    return chapter;
  }

  /** The container for chapters: a part, or the top level in a book organised in chapters. */
  #parentFor(novel: Novel, partId: string | null): Container {
    if (partId) {
      const part = novel.allParts.find((p) => p.id === partId);
      if (!part) throw new OperationError("NOT_FOUND", `No part “${partId}”.`);
      return { kind: "part", part };
    }
    if (novel.topLevel === "parts") throw new OperationError("BAD_REQUEST", "In a book organised in parts, a chapter belongs to a part.");
    return { kind: "top" };
  }

  #orderFile(c: Container): { path: string; key: string } {
    if (c.kind === "chapter") return { path: c.chapter.file, key: "scenes" };
    if (c.kind === "part") return { path: c.part.file, key: "chapters" };
    return { path: ORDER, key: "" };
  }

  async #list(o: Overlay, c: Container): Promise<string[]> {
    const { path, key } = this.#orderFile(c);
    const data = (parse((await o.read(path)) ?? "") ?? {}) as Record<string, unknown>;
    const k = key || ("parts" in data ? "parts" : "chapters");
    return Array.isArray(data[k]) ? (data[k] as string[]) : [];
  }

  async #setList(o: Overlay, c: Container, list: string[]): Promise<void> {
    const { path, key } = this.#orderFile(c);
    const text = (await o.read(path)) ?? "";
    const k = key || ("parts" in ((parse(text) ?? {}) as object) ? "parts" : "chapters");
    o.set(path, editYaml(text, [{ path: [k], value: list }]));
  }

  async #insert(o: Overlay, c: Container, id: string, after: string | null | undefined): Promise<void> {
    const list = await this.#list(o, c);
    const at = after === undefined ? list.length : after === null ? 0 : list.indexOf(after) + 1;
    if (after && !list.includes(after)) throw new OperationError("BAD_REQUEST", `“${after}” isn't in that ${c.kind === "chapter" ? "chapter" : "list"}.`);
    await this.#setList(o, c, [...list.slice(0, at), id, ...list.slice(at)]);
  }

  async #removeFrom(o: Overlay, c: Container, id: string): Promise<void> {
    await this.#setList(o, c, (await this.#list(o, c)).filter((x) => x !== id));
  }

  /** Move every file under `from` to `to`. */
  async #moveDir(o: Overlay, from: string, to: string): Promise<void> {
    if (from === to) return;
    await o.move((await o.files(from)).map((f) => [f, `${to}${f.slice(from.length)}`] as [string, string]));
  }

  /**
   * Give a container's children their numbered names in list order. `paths` has the current path of
   * children that moved or are new in this operation (the model has the rest).
   */
  async #renumber(o: Overlay, novel: Novel, c: Container, paths: Map<string, string>): Promise<void> {
    const list = await this.#list(o, c);
    const current = (id: string): string | undefined =>
      paths.get(id) ?? novel.allScenes.find((s) => s.id === id)?.file ?? novel.allChapters.find((x) => x.id === id)?.dir ?? novel.allParts.find((p) => p.id === id)?.dir;
    const fileMoves: [string, string][] = [];
    const dirMoves: [string, string][] = [];
    list.forEach((id, i) => {
      const path = current(id);
      if (!path) return;
      const isFile = path.endsWith(".md");
      const base = posix.basename(path, isFile ? ".md" : "");
      const slug = base.replace(/^\d+-/, "") || "untitled";
      const wanted = `${targetDir(c)}/${numberedName(i, list.length, slug)}${isFile ? ".md" : ""}`;
      if (wanted !== path) (isFile ? fileMoves : dirMoves).push([path, wanted]);
    });
    await o.move(fileMoves);
    // Folders move file by file; reading them all first lets two folders swap names.
    const all: [string, string][] = [];
    for (const [from, to] of dirMoves) for (const f of await o.files(from)) all.push([f, `${to}${f.slice(from.length)}`]);
    await o.move(all);
  }

  /** Relationships that start or end at `from` now do at `to` (merged scenes). */
  async #retarget(o: Overlay, novel: Novel, from: string, to: string): Promise<void> {
    const path = "bible/relationships.yaml";
    let text = await o.read(path);
    if (text === null) return;
    for (const r of novel.relationships) {
      for (const bound of ["since", "until"] as const) {
        if (r[bound] === from) text = editYaml(text, [{ path: ["relationships", r.index, bound], value: to }]);
      }
    }
    o.set(path, text);
  }
}

function required(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new OperationError("BAD_REQUEST", `A ${field} is required.`);
  return value.trim();
}

const sameContainer = (a: Container, b: Container) =>
  a.kind === b.kind && (a.kind === "top" || (a.kind === "chapter" ? a.chapter.id === (b as { chapter: Chapter }).chapter.id : a.part.id === (b as { part: Part }).part.id));

function targetDir(c: Container): string {
  return c.kind === "chapter" ? c.chapter.dir : c.kind === "part" ? c.part.dir : "manuscript";
}

/** `path` with a new slug, keeping its number prefix: 03-old.md → 03-new.md. */
function rename(path: string, slug: string, ext: string): string {
  const base = posix.basename(path, ext);
  const number = /^(\d+)-/.exec(base)?.[1];
  return `${posix.dirname(path)}/${number ? `${number}-` : ""}${slug}${ext}`;
}

/** The body after front matter. */
function bodyOf(text: string): string {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Offsets where each paragraph (block separated by blank lines) starts in `body`: at the start of its first line. */
function paragraphStarts(body: string): number[] {
  const first = body.search(/\S/);
  if (first < 0) return [];
  const starts = [body.lastIndexOf("\n", first) + 1];
  for (const m of body.matchAll(/\n[ \t]*\r?\n(?=[ \t]*\S)/g)) starts.push(m.index + m[0].length);
  return [...new Set(starts)].sort((a, b) => a - b);
}
