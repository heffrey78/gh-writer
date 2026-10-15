import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memorySource, migration, validate, type Migration, type StoryEvent } from "../src/index.ts";

const SAMPLE = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));

/** Every file of a folder, by repository path. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[join(e.parentPath, e.name).slice(root.length + 1)] = readFileSync(join(e.parentPath, e.name), "utf8");
  }
  return out;
}

/** The files after a migration's writes. */
function applied(files: Record<string, string>, m: Migration): Record<string, string> {
  if (m.status !== "migrate") throw new Error(`No migration: ${m.status}`);
  const out = { ...files };
  for (const w of m.writes) {
    if (w.content === null) delete out[w.path];
    else out[w.path] = w.content;
  }
  return out;
}

/** What an event says, wherever it's kept. */
const facts = (e: StoryEvent) => ({ id: e.id, title: e.title, when: e.when, duration: e.duration, characters: e.characters, locations: e.locations, plotlines: e.plotlines, note: e.body.trim() });

const V1 = "schema_version: 1\nid: nv_4k8h2c\ntitle: Tiny\n";

describe("migration to format v2 (D11)", () => {
  it("moves the sample in format v1 to exactly the sample as it is, losing nothing, and validates clean", async () => {
    const now = filesOf(SAMPLE);
    // The sample as format v1 had it: its events in bible/events.yaml.
    const before = Object.fromEntries(Object.entries(now).filter(([p]) => !p.startsWith("bible/events/")));
    before["bible/events.yaml"] = readFileSync(new URL("fixtures/sample-events-v1.yaml", import.meta.url), "utf8");
    before["novel.yaml"] = now["novel.yaml"]!.replace("schema_version: 2", "schema_version: 1");

    const m = await migration(memorySource(before));
    expect(m).toMatchObject({ status: "migrate", from: 1, to: 2, message: "Format v2: off-page events as files" });
    const after = applied(before, m);
    expect(after).toEqual(now);

    const [old, migrated] = await Promise.all([validate(memorySource(before)), validate(memorySource(after))]);
    expect(migrated.diagnostics).toEqual([]);
    const byId = (es: StoryEvent[]) => es.map(facts).sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(migrated.novel.events)).toEqual(byId(old.novel.events));
    expect(after["bible/events/the-plans-are-stolen.md"]).toBe(
      "---\nid: evt_p1an5t\ntitle: The plans are stolen\nwhen:\n  day: -5\ncharacters:\n  - char_b3n0vs\nlocations:\n  - loc_w0rk5p\nplotlines:\n  - plot_h315tz\n  - plot_gr1efa\n---\n\nOff page. Ben uses Tomas's key.\n",
    );
  });

  it("gives events of the same title their own names, and quotes clock times", async () => {
    const m = await migration(memorySource({
      "novel.yaml": V1,
      "bible/events.yaml": 'events:\n  - {id: evt_aaaaaa, title: Storm, when: {day: 2, time: "22:00"}}\n  - {id: evt_bbbbbb, title: Storm}\n',
    }));
    expect(m.status === "migrate" && m.writes.map((w) => [w.path, w.content])).toEqual([
      ["bible/events/storm.md", '---\nid: evt_aaaaaa\ntitle: Storm\nwhen:\n  day: 2\n  time: "22:00"\n---\n'],
      ["bible/events/storm-2.md", "---\nid: evt_bbbbbb\ntitle: Storm\n---\n"],
      ["bible/events.yaml", null],
      ["novel.yaml", "schema_version: 2\nid: nv_4k8h2c\ntitle: Tiny\n"],
    ]);
  });

  it("only sets the version for a novel without events", async () => {
    const m = await migration(memorySource({ "novel.yaml": V1 }));
    expect(m.status === "migrate" && m.writes).toEqual([{ path: "novel.yaml", content: "schema_version: 2\nid: nv_4k8h2c\ntitle: Tiny\n" }]);
  });

  it("has nothing to do for a novel in format v2", async () => {
    expect(await migration(memorySource({ "novel.yaml": V1.replace("1", "2") }))).toEqual({ status: "current" });
  });

  it("refuses a newer format, a custom type in bible/events/, and files it can't read", async () => {
    const reason = async (files: Record<string, string>) => {
      const m = await migration(memorySource(files));
      return m.status === "refused" ? m.reason : m.status;
    };
    expect(await reason({ "novel.yaml": V1.replace("1", "3") })).toMatch(/format v3, newer than this gh-writer/);
    expect(await reason({ "novel.yaml": `${V1}entity_types:\n  - {key: happening, prefix: hap, folder: events, label: Happening}\n` })).toMatch(/“Happening” keeps its entries in bible\/events\//);
    expect(await reason({ "novel.yaml": V1, "bible/events.yaml": "events: [\n" })).toMatch(/bible\/events.yaml can't be read/);
    expect(await reason({})).toMatch(/no novel.yaml/);
  });
});
