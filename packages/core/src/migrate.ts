import { editYaml, slugify, uniqueFileName, type YamlEdit } from "./edit.ts";
import { EVENTS_FOLDER, SCHEMA_VERSION } from "./load.ts";
import { parseYaml } from "./parse.ts";
import type { FileSource } from "./source.ts";

/*
 * Moving a novel to the newest format (D11). Format v2 gives each off-page event a file of its own,
 * bible/events/<slug>.md, with its note as prose; bible/events.yaml goes. The result is the files to
 * write, for the caller to commit as one change.
 */

/** A file to write, or to remove (content null). */
export interface MigrationWrite {
  path: string;
  content: string | null;
}

export type Migration =
  | { status: "current" }
  | { status: "refused"; reason: string }
  | { status: "migrate"; from: number; to: number; writes: MigrationWrite[]; message: string };

const EVENTS_YAML = "bible/events.yaml";
/** An event's fields in the order an event file lists them; `note` becomes the prose. */
const EVENT_FIELDS = ["id", "title", "when", "duration", "characters", "locations", "plotlines"] as const;

/** What moving the novel in `source` to the newest format would write, or why it can't be. */
export async function migration(source: FileSource): Promise<Migration> {
  const novelText = await source.read("novel.yaml");
  if (novelText === undefined) return { status: "refused", reason: "There's no novel.yaml here." };
  const novel = parseYaml(novelText, "novel.yaml");
  if (novel.diagnostics.length || !isObject(novel.data)) return { status: "refused", reason: "novel.yaml can't be read: fix it first (gh-writer validate)." };
  const from = typeof novel.data["schema_version"] === "number" ? novel.data["schema_version"] : 1;
  if (from > SCHEMA_VERSION) return { status: "refused", reason: `This novel is in format v${from}, newer than this gh-writer (v${SCHEMA_VERSION}).` };
  if (from === SCHEMA_VERSION) return { status: "current" };

  const types = Array.isArray(novel.data["entity_types"]) ? novel.data["entity_types"].filter(isObject) : [];
  const clash = types.find((t) => t["folder"] === EVENTS_FOLDER);
  if (clash) {
    return {
      status: "refused",
      reason: `The entry type “${String(clash["label"] ?? clash["key"])}” keeps its entries in bible/${EVENTS_FOLDER}/, where format v2 keeps off-page events. Give that type another folder (in novel.yaml, and move its files), then migrate.`,
    };
  }

  const writes: MigrationWrite[] = [];
  const eventsText = await source.read(EVENTS_YAML);
  if (eventsText !== undefined) {
    const parsed = parseYaml(eventsText, EVENTS_YAML);
    if (parsed.diagnostics.length) return { status: "refused", reason: `${EVENTS_YAML} can't be read: fix it first (gh-writer validate).` };
    const list = isObject(parsed.data) && Array.isArray(parsed.data["events"]) ? parsed.data["events"] : [];
    const folder = `bible/${EVENTS_FOLDER}`;
    const taken = new Set((await source.list(folder)).map((e) => e.name));
    for (const item of list) {
      if (!isObject(item) || typeof item["id"] !== "string") return { status: "refused", reason: `${EVENTS_YAML} has an event without an ID: fix it first (gh-writer validate).` };
      const title = typeof item["title"] === "string" ? item["title"] : item["id"];
      const name = uniqueFileName(slugify(title), ".md", taken);
      taken.add(name);
      writes.push({ path: `${folder}/${name}`, content: eventFile(item) });
    }
    writes.push({ path: EVENTS_YAML, content: null });
  }
  writes.push({ path: "novel.yaml", content: editYaml(novelText, [{ path: ["schema_version"], value: SCHEMA_VERSION }]) });
  return { status: "migrate", from, to: SCHEMA_VERSION, writes, message: `Format v${SCHEMA_VERSION}: off-page events as files` };
}

/** An event file: its fields as front matter, and its note as the prose below. */
export function eventFile(event: Record<string, unknown>, note = event["note"]): string {
  // Its fields in order, then any others it has (never lost), all but the note.
  const keys = [...EVENT_FIELDS, ...Object.keys(event).filter((k) => !(EVENT_FIELDS as readonly string[]).includes(k))];
  const edits: YamlEdit[] = keys.flatMap((k) => (k === "note" || event[k] === undefined || event[k] === null ? [] : [{ path: [k], value: event[k] }]));
  const front = editYaml("", edits);
  const prose = typeof note === "string" && note.trim() ? `\n${note.trim()}\n` : "";
  return `---\n${front}---\n${prose}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
