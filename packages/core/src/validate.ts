import { idPrefix, STRUCTURE_PREFIXES } from "./ids.ts";
import { loadNovel } from "./load.ts";
import { allRecords, mentions, picturePath, pictures, type Novel, type Picture, type RecordRef } from "./model.ts";
import type { FileSource } from "./source.ts";
import { overlaps, storyTimeline, type TimelineItem } from "./time.ts";
import type { Diagnostic, Severity } from "./types.ts";

/** Every diagnostic code, with its severity. docs/format/v2.md documents each one. */
export const RULES: Readonly<Record<string, Severity>> = {
  E_MISSING_FILE: "error",
  E_PARSE: "error",
  E_SCHEMA: "error",
  E_SCHEMA_VERSION: "error",
  E_ENTITY_TYPE: "error",
  E_UNKNOWN_FOLDER: "error",
  E_DUPLICATE_ID: "error",
  E_ID_PREFIX: "error",
  E_DANGLING_REF: "error",
  E_REF_TYPE: "error",
  E_MISPLACED: "error",
  E_ORDER_MISSING: "error",
  E_ORDER_UNKNOWN: "error",
  E_ORDER_DUPLICATE: "error",
  E_UNKNOWN_REL_TYPE: "error",
  E_REL_ENDPOINT_TYPE: "error",
  E_REL_RANGE: "error",
  W_UNKNOWN_KEY: "warning",
  W_FILENAME_ORDER: "warning",
  W_HARD_WRAP: "warning",
  W_POV_NOT_PRESENT: "warning",
  W_REL_SELF: "warning",
  W_LAYOUT_UNKNOWN: "warning",
  W_TIME_OVERLAP: "warning",
  W_MISSING_IMAGE: "warning",
  W_IMAGE_OUTSIDE: "warning",
  W_EVENTS_YAML: "warning",
  W_NOTE_PIN: "warning",
};

export interface ValidationResult {
  novel: Novel;
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

/** Load and fully validate a novel repository. */
export async function validate(source: FileSource): Promise<ValidationResult> {
  const novel = await loadNovel(source);
  const diagnostics = sortDiagnostics([...novel.diagnostics, ...validateNovel(novel), ...(await missingImages(novel, source))]);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return { novel, diagnostics, errors, warnings: diagnostics.length - errors };
}

/** What a mention in prose may name: any bible entry, or an off-page event (format v2). */
const MENTIONABLE = ["*entity", "event"];

/** Cross-reference checks and advisory warnings on a loaded novel. */
export function validateNovel(novel: Novel): Diagnostic[] {
  if (novel.diagnostics.some((d) => d.code === "E_SCHEMA_VERSION")) return [];
  const out: Diagnostic[] = [];
  const push = (severity: Severity, code: string, file: string, message: string, extra: Partial<Diagnostic> = {}) =>
    out.push({ severity, code, file, message, ...extra });

  const records = allRecords(novel);
  const index = new Map<string, RecordRef>();
  for (const r of records) if (!index.has(r.id)) index.set(r.id, r);
  const typeByKey = new Map(novel.entityTypes.map((t) => [t.key, t]));

  // IDs: duplicates and prefixes.
  for (const r of records) {
    const first = index.get(r.id)!;
    if (first !== r) {
      const where = first.file === r.file ? "earlier in this file" : `in ${first.file}`;
      push("error", "E_DUPLICATE_ID", r.file, `ID ${r.id} is already used ${where}`);
    }
    const expected = r.kind === "entity" ? typeByKey.get(r.type!)?.prefix : STRUCTURE_PREFIXES[r.kind];
    const actual = idPrefix(r.id);
    if (expected && actual && actual !== expected) {
      push("error", "E_ID_PREFIX", r.file, `${describe(r)} ID ${r.id} should start with "${expected}_"`);
    }
  }

  const builtinTypes = new Set(novel.entityTypes.filter((t) => t.builtin).map((t) => t.key));
  /** Check that `id` names a record of an allowed kind (entity type keys, "scene", "*entity": any entry, "*custom": a custom type's). */
  function ref(id: string | undefined, allowed: string[], file: string, pointer: string, field: string, line?: number) {
    if (id === undefined) return;
    const target = index.get(id);
    const where = line === undefined ? { pointer } : { line };
    if (!target) {
      push("error", "E_DANGLING_REF", file, `${field} refers to ${id}, which does not exist`, where);
      return;
    }
    const kind = target.kind === "entity" ? target.type! : target.kind;
    const custom = target.kind === "entity" && !builtinTypes.has(kind);
    if (!allowed.includes(kind) && !(allowed.includes("*entity") && target.kind === "entity") && !(allowed.includes("*custom") && custom)) {
      const wanted = allowed.map((a) => (a === "*entity" ? "a bible entity" : a === "*custom" ? "an entry of a custom type" : `a ${a}`)).join(" or ");
      push("error", "E_REF_TYPE", file, `${field} must be ${wanted}, but ${id} is ${article(describe(target))}`, where);
    }
  }

  /** A picture in prose must be under /images/, written from the repository root as github.com reads it (D10). */
  function outsideImages(p: Picture, file: string, bodyLine: number) {
    if (picturePath(p.src)) return;
    push("warning", "W_IMAGE_OUTSIDE", file, `The picture “${p.alt || p.src}” isn't in the novel's images folder: use /images/<name> (from the repository's root, as github.com reads it)`, { line: bodyLine + p.line - 1 });
  }

  // Scenes. `entities` holds custom types only: the built-in four have their own lists.
  for (const s of novel.allScenes) {
    ref(s.pov, ["character"], s.file, "/pov", "pov");
    s.characters.forEach((id, i) => ref(id, ["character"], s.file, `/characters/${i}`, "characters"));
    s.locations.forEach((id, i) => ref(id, ["location"], s.file, `/locations/${i}`, "locations"));
    s.entities.forEach((id, i) => ref(id, ["*custom"], s.file, `/entities/${i}`, "entities"));
    s.plotlines.forEach((p, i) => ref(p.id, ["plotline"], s.file, `/plotlines/${i}`, "plotlines"));
    s.themes.forEach((t, i) => ref(t.id, ["theme"], s.file, `/themes/${i}`, "themes"));
    if (s.pov && !s.characters.includes(s.pov)) {
      push("warning", "W_POV_NOT_PRESENT", s.file, `POV character ${s.pov} is not listed in characters`, { pointer: "/pov" });
    }
    for (const m of mentions(s.body)) ref(m.id, MENTIONABLE, s.file, "", `Mention "${m.text}"`, s.bodyLine + m.line - 1);
    for (const p of pictures(s.body)) outsideImages(p, s.file, s.bodyLine);
    for (const line of hardWrappedLines(s.body)) {
      push("warning", "W_HARD_WRAP", s.file, "Paragraph continues on the next line; keep each paragraph on one line", { line: s.bodyLine + line - 1 });
    }
  }

  // Bible entries: mentions in notes.
  for (const e of novel.entities) {
    for (const m of mentions(e.body)) ref(m.id, MENTIONABLE, e.file, "", `Mention "${m.text}"`, e.bodyLine + m.line - 1);
    for (const p of pictures(e.body)) outsideImages(p, e.file, e.bodyLine);
  }

  // Events: items of bible/events.yaml (v1), or files of their own with a note in prose (v2).
  for (const ev of novel.events) {
    const p = ev.index === undefined ? "" : `/events/${ev.index}`;
    ev.characters?.forEach((id, i) => ref(id, ["character"], ev.file, `${p}/characters/${i}`, "characters"));
    ev.locations?.forEach((id, i) => ref(id, ["location"], ev.file, `${p}/locations/${i}`, "locations"));
    ev.plotlines?.forEach((id, i) => ref(id, ["plotline"], ev.file, `${p}/plotlines/${i}`, "plotlines"));
    ref(ev.scene, ["scene"], ev.file, `${p}/scene`, "scene");
    if (ev.index !== undefined) continue;
    for (const m of mentions(ev.body)) ref(m.id, MENTIONABLE, ev.file, "", `Mention "${m.text}"`, ev.bodyLine + m.line - 1);
    for (const pic of pictures(ev.body)) outsideImages(pic, ev.file, ev.bodyLine);
  }
  // Notes (D12): their mentions, and what they became.
  for (const n of novel.notes) {
    ref(n.became, ["event", "scene"], n.file, "/became", "became");
    n.scenes.forEach((id, i) => ref(id, ["scene"], n.file, `/scenes/${i}`, "scenes"));
    n.pinned.forEach((id, i) => {
      ref(id, ["scene"], n.file, `/pinned/${i}`, "pinned");
      if (!n.scenes.includes(id)) push("warning", "W_NOTE_PIN", n.file, `Pinned in ${id}, which isn't one of the note's scenes`, { pointer: `/pinned/${i}` });
    });
    for (const m of mentions(n.body)) ref(m.id, MENTIONABLE, n.file, "", `Mention "${m.text}"`, n.bodyLine + m.line - 1);
    for (const pic of pictures(n.body)) outsideImages(pic, n.file, n.bodyLine);
  }
  if ((novel.config?.schema_version ?? 1) >= 2) {
    const leftover = novel.events.find((e) => e.index !== undefined);
    if (leftover) push("warning", "W_EVENTS_YAML", leftover.file, "Events in bible/events.yaml are format v1's: run gh-writer migrate to give each its own file in bible/events/");
  }

  // Relationship types.
  const relTypes = new Map<string, (typeof novel.relationshipTypes)[number]>();
  novel.relationshipTypes.forEach((t, i) => {
    if (relTypes.has(t.key)) push("error", "E_SCHEMA", "novel.yaml", `Relationship type "${t.key}" is defined twice`, { pointer: `/relationship_types/${i}` });
    else relTypes.set(t.key, t);
    for (const k of [...(t.from_types ?? []), ...(t.to_types ?? [])]) {
      if (!typeByKey.has(k)) push("error", "E_ENTITY_TYPE", "novel.yaml", `Relationship type "${t.key}" refers to unknown entity type "${k}"`, { pointer: `/relationship_types/${i}` });
    }
  });

  // Story time: someone in two places at once.
  const entityName = (id: string) => novel.entities.find((e) => e.id === id)?.name ?? id;
  const where = (i: TimelineItem) => {
    const locations = i.kind === "scene" ? i.scene.locations : (i.event.locations ?? []);
    const what = i.kind === "scene" ? `“${i.scene.title}”` : `the event “${i.event.title}”`;
    return `at ${locations.map(entityName).join(" and ")} in ${what}`;
  };
  for (const o of overlaps(storyTimeline(novel))) {
    const file = o.a.kind === "scene" ? o.a.scene.file : o.a.event.file;
    push("warning", "W_TIME_OVERLAP", file, `${entityName(o.character)} is ${where(o.a)} and ${where(o.b)} at the same time`);
  }

  // Diagram layouts: positions for records that no longer exist are harmless, but stale.
  for (const [name, layout] of Object.entries(novel.layouts)) {
    for (const id of Object.keys(layout.nodes ?? {})) {
      if (!index.has(id)) push("warning", "W_LAYOUT_UNKNOWN", "diagrams/layouts.yaml", `Layout "${name}" places ${id}, which isn't in the novel`, { pointer: `/layouts/${name}/nodes/${id}` });
    }
  }

  // Relationships.
  const scenePos = new Map(novel.scenes.map((s) => [s.id, s.position]));
  for (const r of novel.relationships) {
    const p = `/relationships/${r.index}`;
    ref(r.from, ["*entity"], r.file, `${p}/from`, "from");
    ref(r.to, ["*entity"], r.file, `${p}/to`, "to");
    ref(r.since, ["scene"], r.file, `${p}/since`, "since");
    ref(r.until, ["scene"], r.file, `${p}/until`, "until");
    if (r.from === r.to) push("warning", "W_REL_SELF", r.file, `Relationship ${r.id} connects ${r.from} to itself`, { pointer: p });

    const type = relTypes.get(r.type);
    if (!type) {
      push("error", "E_UNKNOWN_REL_TYPE", r.file, `Relationship type "${r.type}" is not defined in novel.yaml`, { pointer: `${p}/type` });
    } else {
      for (const [end, allowed] of [["from", type.from_types], ["to", type.to_types]] as const) {
        const target = index.get(r[end]);
        if (allowed?.length && target?.kind === "entity" && !allowed.includes(target.type!)) {
          push("error", "E_REL_ENDPOINT_TYPE", r.file,
            `"${r.type}" relationships need ${end} to be ${allowed.join(" or ")}, but ${r[end]} is a ${target.type}`, { pointer: `${p}/${end}` });
        }
      }
    }
    const since = r.since === undefined ? undefined : scenePos.get(r.since);
    const until = r.until === undefined ? undefined : scenePos.get(r.until);
    if (since !== undefined && until !== undefined && until <= since) {
      push("error", "E_REL_RANGE", r.file, `Relationship ${r.id} ends (until ${r.until}) at or before it starts (since ${r.since})`, { pointer: p });
    }
  }

  // Cosmetic NN- prefixes against reading order.
  const checkPrefixes = (items: { dir?: string; file: string }[], kind: string) =>
    items.forEach((item, i) => {
      const path = item.dir ?? item.file;
      const name = path.slice(path.lastIndexOf("/") + 1);
      const n = /^(\d+)-/.exec(name)?.[1];
      if (n !== undefined && Number(n) !== i + 1) {
        push("warning", "W_FILENAME_ORDER", path, `${kind} "${name}" is number ${i + 1} in reading order`);
      }
    });
  checkPrefixes(novel.parts, "Part folder");
  if (novel.topLevel === "parts") {
    for (const part of novel.parts) checkPrefixes(novel.chapters.filter((c) => c.partId === part.id), "Chapter folder");
  } else {
    checkPrefixes(novel.chapters, "Chapter folder");
  }
  for (const c of novel.chapters) checkPrefixes(novel.scenes.filter((s) => s.chapterId === c.id), "Scene file");

  return out;
}

/**
 * Pictures named by the cover and the bible's entries that aren't in the repository. Found by listing
 * their folders rather than reading them: images can be large, and aren't text.
 */
async function missingImages(novel: Novel, source: FileSource): Promise<Diagnostic[]> {
  if (novel.diagnostics.some((d) => d.code === "E_SCHEMA_VERSION")) return [];
  const listings = new Map<string, Promise<Set<string>>>();
  const exists = (path: string) => {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    if (!listings.has(dir)) listings.set(dir, source.list(dir).then((entries) => new Set(entries.filter((e) => !e.dir).map((e) => e.name))));
    return listings.get(dir)!.then((names) => names.has(path.slice(slash + 1)));
  };
  // Pictures in prose (D10) by the line they're on; a path outside images/ is W_IMAGE_OUTSIDE's.
  const inProse = (body: string, file: string, bodyLine: number) =>
    pictures(body).flatMap((p) => {
      const path = picturePath(p.src);
      return path ? [{ path, file, line: bodyLine + p.line - 1, what: `The picture “${p.alt || path}”` }] : [];
    });
  const wanted: { path: string; file: string; pointer?: string; line?: number; what: string }[] = [
    ...(novel.config?.cover ? [{ path: novel.config.cover, file: "novel.yaml", pointer: "/cover", what: "The cover" }] : []),
    ...novel.entities.flatMap((e) => (e.image ? [{ path: e.image, file: e.file, pointer: "/image", what: `${e.name}'s picture` }] : [])),
    ...novel.allScenes.flatMap((s) => inProse(s.body, s.file, s.bodyLine)),
    ...novel.entities.flatMap((e) => inProse(e.body, e.file, e.bodyLine)),
    ...novel.events.flatMap((e) => (e.index === undefined ? inProse(e.body, e.file, e.bodyLine) : [])),
    ...novel.notes.flatMap((n) => inProse(n.body, n.file, n.bodyLine)),
  ];
  const out: Diagnostic[] = [];
  for (const w of wanted) {
    // A path that isn't a plain repository path is the schema's to report.
    if (/^\/|\\|(^|\/)\.\.?(\/|$)/.test(w.path)) continue;
    if (await exists(w.path)) continue;
    out.push({ severity: "warning", code: "W_MISSING_IMAGE", file: w.file, ...(w.pointer ? { pointer: w.pointer } : {}), ...(w.line ? { line: w.line } : {}), message: `${w.what}, ${w.path}, isn't in the repository` });
  }
  return out;
}

/**
 * 1-based body lines that continue a prose paragraph from the previous line
 * without an intentional break (trailing backslash or two spaces).
 */
export function hardWrappedLines(body: string): number[] {
  const lines = body.split("\n");
  const out: number[] = [];
  let fenced = false;
  let reported = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim() === "") {
      reported = false;
      continue;
    }
    const prev = lines[i - 1];
    if (!reported && prev !== undefined && isProse(prev) && isProse(line) && !/(\\| {2,})$/.test(prev)) {
      out.push(i + 1);
      reported = true;
    }
  }
  return out;
}

function isProse(line: string): boolean {
  if (line.trim() === "") return false;
  return !/^\s{0,3}([#>|<]|[-*+]\s|\d+[.)]\s|(=+|-+|\*{3,}|_{3,})\s*$)/.test(line);
}

function describe(r: RecordRef): string {
  return r.kind === "entity" ? r.type! : r.kind;
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** Sort diagnostics by file, then line/pointer, keeping errors before warnings within a file. */
export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) =>
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.pointer ?? "").localeCompare(b.pointer ?? ""));
}
