import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { chapterTitle, describeRelationship } from "./diagrams.ts";
import type { Chapter, Entity, Novel, Relationship, Scene, StoryEvent } from "./model.ts";
import type { StoryTime } from "./types.ts";
import { diffParagraphs, diffSequences, type ParagraphDiff } from "./word-diff.ts";
import { countWords } from "./words.ts";

/*
 * Two states of a novel side by side (#17): two versions, a checkpoint and now. Everything is matched
 * by ID, so a renamed or moved scene is the same scene. The prose of one scene is compared word by
 * word on demand (compareProse); the rest says what changed in plain words.
 */

export { diffParagraphs, diffWords, type DiffOp, type DiffPart, type ParagraphDiff } from "./word-diff.ts";

export type ChangeStatus = "added" | "removed" | "changed" | "unchanged";

/** A field that differs: missing on one side when it was added or removed. Lists read "Ada Varn, Ben Varn". */
export interface FieldChange {
  label: string;
  before?: string;
  after?: string;
}

export interface WordChange {
  before: number;
  after: number;
}

export interface SceneComparison {
  id: string;
  /** Its title now (or, removed, as it was). */
  title: string;
  status: ChangeStatus;
  /** In another chapter, or in another place among the scenes both have. */
  moved: boolean;
  /** The chapter it was in, when that's another one. */
  movedFrom?: string;
  fields: FieldChange[];
  /** Its text differs (compareProse shows how). */
  prose: boolean;
  words: WordChange;
}

export interface ChapterComparison {
  id: string;
  title: string;
  status: ChangeStatus;
  moved: boolean;
  fields: FieldChange[];
  scenes: SceneComparison[];
  words: WordChange;
}

export interface EntryComparison {
  id: string;
  name: string;
  /** Its type's label: "Character". */
  type: string;
  status: Exclude<ChangeStatus, "unchanged">;
  fields: FieldChange[];
}

export interface RelationshipComparison {
  id: string;
  status: Exclude<ChangeStatus, "unchanged">;
  /** As sentences: "Ada Varn: Allied with Ben Varn, until “The Betrayal”". */
  before?: string;
  after?: string;
}

export interface EventComparison {
  id: string;
  title: string;
  status: Exclude<ChangeStatus, "unchanged">;
  fields: FieldChange[];
}

export interface Comparison {
  words: WordChange;
  /** How many scenes were added, removed, changed (text or details) and moved. */
  counts: { added: number; removed: number; changed: number; moved: number };
  /** The chapters in reading order as they are now, removed ones where they were. Every scene is listed. */
  chapters: ChapterComparison[];
  /** Only what changed. */
  entries: EntryComparison[];
  relationships: RelationshipComparison[];
  events: EventComparison[];
}

/** What changed from `before` to `after`. */
export function compareNovels(before: Novel, after: Novel): Comparison {
  const sceneA = new Map(before.allScenes.map((s) => [s.id, s]));
  const sceneB = new Map(after.allScenes.map((s) => [s.id, s]));
  const chapterA = new Map(before.chapters.map((c) => [c.id, c]));
  const chapterB = new Map(after.chapters.map((c) => [c.id, c]));

  // Moved: scenes (and chapters) both have, out of the longest run they share in reading order.
  const movedScenes = outOfOrder(
    before.allScenes.map((s) => s.id).filter((id) => sceneB.has(id)),
    after.allScenes.map((s) => s.id).filter((id) => sceneA.has(id)),
  );
  const movedChapters = outOfOrder(
    before.chapters.map((c) => c.id).filter((id) => chapterB.has(id)),
    after.chapters.map((c) => c.id).filter((id) => chapterA.has(id)),
  );

  const scene = (id: string, chapter: Chapter): SceneComparison => {
    const a = sceneA.get(id);
    const b = sceneB.get(id);
    const fields = sceneFields(before, a, after, b);
    const prose = (a?.body ?? "") !== (b?.body ?? "");
    const fromChapter = a?.chapterId !== undefined && b && a.chapterId !== b.chapterId ? chapterA.get(a.chapterId) : undefined;
    const status: ChangeStatus = !a ? "added" : !b ? "removed" : prose || fields.length ? "changed" : "unchanged";
    return {
      id,
      title: (b ?? a)!.title,
      status,
      moved: !!a && !!b && (movedScenes.has(id) || a.chapterId !== b.chapterId),
      ...(fromChapter && chapter.id !== fromChapter.id ? { movedFrom: chapterTitle(before, fromChapter) } : {}),
      fields,
      prose,
      words: { before: a ? countWords(a.body) : 0, after: b ? countWords(b.body) : 0 },
    };
  };

  const chapters: ChapterComparison[] = [];
  for (const id of interleave(before.chapters.map((c) => c.id), after.chapters.map((c) => c.id))) {
    const a = chapterA.get(id);
    const b = chapterB.get(id);
    const chapter = (b ?? a)!;
    // A chapter's scenes now, and those it had that are gone from the book, where they were.
    const kept = b ? b.sceneIds : [];
    const gone = (a?.sceneIds ?? []).filter((s) => !sceneB.has(s));
    const ids = interleave(a?.sceneIds.filter((s) => kept.includes(s) || gone.includes(s)) ?? [], kept);
    const scenes = ids.filter((s) => sceneA.has(s) || sceneB.has(s)).map((s) => scene(s, chapter));
    const fields = [
      field("Title", a && chapterTitle(before, a), b && chapterTitle(after, b), !!a && !!b),
      field("Synopsis", a?.synopsis, b?.synopsis, !!a && !!b),
      field("Part", a && partTitle(before, a), b && partTitle(after, b), !!a && !!b),
    ].filter((f): f is FieldChange => !!f);
    const words = scenes.reduce((w, s) => ({ before: w.before + s.words.before, after: w.after + s.words.after }), { before: 0, after: 0 });
    // A chapter whose scenes left is changed, though they're listed where they went.
    const lost = (a?.sceneIds ?? []).some((s) => sceneB.has(s) && !kept.includes(s));
    const status: ChangeStatus = !a ? "added" : !b ? "removed" : fields.length || lost || scenes.some((s) => s.status !== "unchanged" || s.moved) ? "changed" : "unchanged";
    chapters.push({ id, title: chapterTitle(b ? after : before, chapter), status, moved: !!a && !!b && movedChapters.has(id), fields, scenes, words });
  }

  const all = chapters.flatMap((c) => c.scenes);
  return {
    words: { before: wordsOf(before), after: wordsOf(after) },
    counts: {
      added: all.filter((s) => s.status === "added").length,
      removed: all.filter((s) => s.status === "removed").length,
      changed: all.filter((s) => s.status === "changed").length,
      moved: all.filter((s) => s.moved).length,
    },
    chapters,
    entries: compareEntries(before, after),
    relationships: compareRelationships(before, after),
    events: compareEvents(before, after),
  };
}

/** One scene's text, before and after, paragraph by paragraph with reworded paragraphs word by word. Hidden notes are left out. */
export function compareProse(before: string | undefined, after: string | undefined): ParagraphDiff[] {
  return diffParagraphs(before === undefined ? [] : proseParagraphs(before), after === undefined ? [] : proseParagraphs(after));
}

/** A scene body's paragraphs as read: a mention is its words, a link its text; hidden notes are left out; a break is "* * *". */
export function proseParagraphs(markdown: string): string[] {
  const tree = fromMarkdown(markdown.replace(/\r\n?/g, "\n"), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const out: string[] = [];
  const walk = (node: Nodes) => {
    switch (node.type) {
      case "html":
        return;
      case "thematicBreak":
        out.push("* * *");
        return;
      case "blockquote":
      case "list":
      case "listItem":
        for (const child of node.children) walk(child);
        return;
      default: {
        // Soft line breaks (hard-wrapped prose) read as spaces.
        const text = toString(node, { includeHtml: false }).replace(/[ \t]*\n[ \t]*/g, " ").trim();
        if (text) out.push(text);
      }
    }
  };
  for (const child of tree.children) walk(child);
  return out;
}

const wordsOf = (novel: Novel) => novel.allScenes.reduce((n, s) => n + countWords(s.body), 0);

/** Items not in the longest common subsequence of two orders of the same items. */
function outOfOrder(a: string[], b: string[]): Set<string> {
  const moved = new Set<string>();
  for (const run of diffSequences(a, b)) if (run.op === "ins") run.items.forEach((id) => moved.add(id));
  return moved;
}

/** The IDs in `after`'s order, with those only in `before` placed after the one that preceded them there. */
function interleave(before: string[], after: string[]): string[] {
  const out = [...after];
  const present = new Set(after);
  let anchor = -1;
  for (const id of before) {
    if (present.has(id)) {
      anchor = out.indexOf(id);
      continue;
    }
    out.splice(++anchor, 0, id);
    present.add(id);
  }
  return out;
}

/**
 * A field's change, or undefined when it's the same. `both`: the record is on both sides (a record
 * added or removed lists its fields as values on one side only).
 */
function field(label: string, before: string | undefined, after: string | undefined, both = true): FieldChange | undefined {
  const a = before || undefined;
  const b = after || undefined;
  if (a === b) return undefined;
  if (!both && !a && !b) return undefined;
  return { label, ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}) };
}

const names = (novel: Novel, ids: readonly string[] | undefined) => (ids ?? []).map((id) => novel.entities.find((e) => e.id === id)?.name ?? id).join(", ") || undefined;
const nameOf = (novel: Novel, id: string | undefined) => (id ? (novel.entities.find((e) => e.id === id)?.name ?? id) : undefined);

function partTitle(novel: Novel, chapter: Chapter): string | undefined {
  return chapter.partId ? novel.allParts.find((p) => p.id === chapter.partId)?.title : undefined;
}

function when(time: StoryTime | undefined): string | undefined {
  if (!time) return undefined;
  if ("at" in time) return time.at;
  return `Day ${time.day}${time.time ? `, ${time.time}` : ""}`;
}

function sceneFields(novelA: Novel, a: Scene | undefined, novelB: Novel, b: Scene | undefined): FieldChange[] {
  // Added and removed scenes are listed as such; their fields aren't changes.
  if (!a || !b) return [];
  const plotlines = (novel: Novel, s: Scene) =>
    s.plotlines.map((p) => `${nameOf(novel, p.id)} (${p.weight}${p.beat ? `: ${p.beat}` : ""})`).join(", ") || undefined;
  const themes = (novel: Novel, s: Scene) => s.themes.map((t) => nameOf(novel, t.id)).join(", ") || undefined;
  return [
    field("Title", a.title, b.title),
    field("Synopsis", a.synopsis, b.synopsis),
    field("Status", a.status, b.status),
    field("Point of view", nameOf(novelA, a.pov), nameOf(novelB, b.pov)),
    field("Characters", names(novelA, a.characters), names(novelB, b.characters)),
    field("Locations", names(novelA, a.locations), names(novelB, b.locations)),
    field("Also in it", names(novelA, a.entities), names(novelB, b.entities)),
    field("Plotlines", plotlines(novelA, a), plotlines(novelB, b)),
    field("Themes", themes(novelA, a), themes(novelB, b)),
    field("When", when(a.when), when(b.when)),
    field("Duration", a.duration, b.duration),
    field("Tags", a.tags.join(", "), b.tags.join(", ")),
  ].filter((f): f is FieldChange => !!f);
}

function typeLabel(novel: Novel, entity: Entity): string {
  return novel.entityTypes.find((t) => t.key === entity.type)?.label ?? entity.type;
}

function compareEntries(before: Novel, after: Novel): EntryComparison[] {
  const a = new Map(before.entities.map((e) => [e.id, e]));
  const out: EntryComparison[] = [];
  const entryFields = (x: Entity | undefined, y: Entity | undefined) => {
    const keys = [...new Set([...Object.keys(x?.fields ?? {}), ...Object.keys(y?.fields ?? {})])];
    const both = !!x && !!y;
    return [
      field("Name", x?.name, y?.name, both),
      field("Other names", x?.aliases.join(", "), y?.aliases.join(", "), both),
      field("Summary", x?.summary, y?.summary, both),
      ...keys.map((k) => field(k, x?.fields[k]?.toString(), y?.fields[k]?.toString(), both)),
      field("Tags", x?.tags.join(", "), y?.tags.join(", "), both),
      field("Image", x?.image, y?.image, both),
      field("Notes", x?.body.trim(), y?.body.trim(), both),
    ].filter((f): f is FieldChange => !!f);
  };
  for (const y of after.entities) {
    const x = a.get(y.id);
    const fields = x ? entryFields(x, y) : [];
    if (!x || fields.length) out.push({ id: y.id, name: y.name, type: typeLabel(after, y), status: x ? "changed" : "added", fields });
  }
  for (const x of before.entities) if (!after.entities.some((e) => e.id === x.id)) out.push({ id: x.id, name: x.name, type: typeLabel(before, x), status: "removed", fields: [] });
  return out;
}

function compareRelationships(before: Novel, after: Novel): RelationshipComparison[] {
  const sentence = (novel: Novel, r: Relationship) => `${nameOf(novel, r.from)}: ${describeRelationship(novel, r.from, r)}`;
  const same = (x: Relationship, y: Relationship) => x.from === y.from && x.to === y.to && x.type === y.type && x.since === y.since && x.until === y.until && x.note === y.note;
  const a = new Map(before.relationships.map((r) => [r.id, r]));
  const b = new Map(after.relationships.map((r) => [r.id, r]));
  const out: RelationshipComparison[] = [];
  for (const y of after.relationships) {
    const x = a.get(y.id);
    if (!x) out.push({ id: y.id, status: "added", after: sentence(after, y) });
    else if (!same(x, y)) out.push({ id: y.id, status: "changed", before: sentence(before, x), after: sentence(after, y) });
  }
  for (const x of before.relationships) if (!b.has(x.id)) out.push({ id: x.id, status: "removed", before: sentence(before, x) });
  return out;
}

function compareEvents(before: Novel, after: Novel): EventComparison[] {
  const a = new Map(before.events.map((e) => [e.id, e]));
  const out: EventComparison[] = [];
  const eventFields = (x: StoryEvent, y: StoryEvent) =>
    [
      field("Title", x.title, y.title),
      field("When", when(x.when), when(y.when)),
      field("Duration", x.duration, y.duration),
      field("Characters", names(before, x.characters), names(after, y.characters)),
      field("Locations", names(before, x.locations), names(after, y.locations)),
      field("Plotlines", names(before, x.plotlines), names(after, y.plotlines)),
      field("Note", x.note, y.note),
    ].filter((f): f is FieldChange => !!f);
  for (const y of after.events) {
    const x = a.get(y.id);
    const fields = x ? eventFields(x, y) : [];
    if (!x || fields.length) out.push({ id: y.id, title: y.title, status: x ? "changed" : "added", fields });
  }
  for (const x of before.events) if (!after.events.some((e) => e.id === x.id)) out.push({ id: x.id, title: x.title, status: "removed", fields: [] });
  return out;
}
