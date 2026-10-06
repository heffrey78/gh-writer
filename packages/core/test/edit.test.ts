import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { isMap, parseDocument, type Node, type Pair } from "yaml";
import { describe, expect, it } from "vitest";
import { backlinks, editFrontMatter, editYaml, loadNovel, numberedName, readFrontMatter, relationshipHistory, relationshipsAt, slugify, uniqueFileName, uniqueId, type YamlEdit } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

const sample = new URL("../../../examples/sample-novel/", import.meta.url).pathname;

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const yamlFiles = files(sample, /\.ya?ml$/).map((p) => readFileSync(p, "utf8"));
const frontMatters = files(sample, /\.md$/).flatMap((p) => /^---\n([\s\S]*?\n)---\n/.exec(readFileSync(p, "utf8"))?.[1] ?? []);

describe("editYaml", () => {
  const chapter = "id: ch_arr1va\ntitle: Arrival # first chapter\nscenes: [sc_5tat1n, sc_br1dg3]\n";

  it("changes a scalar in place, keeping its comment", () => {
    expect(editYaml(chapter, [{ path: ["title"], value: "Arrivals" }])).toBe("id: ch_arr1va\ntitle: Arrivals # first chapter\nscenes: [sc_5tat1n, sc_br1dg3]\n");
  });

  it("keeps quoting, and quotes only when a value needs it", () => {
    expect(editYaml('time: "09:10"\n', [{ path: ["time"], value: "10:15" }])).toBe('time: "10:15"\n');
    expect(editYaml("title: Plain\n", [{ path: ["title"], value: "Colon: inside" }])).toBe('title: "Colon: inside"\n');
  });

  it("keeps a flow list on its line", () => {
    expect(editYaml(chapter, [{ path: ["scenes"], value: ["sc_br1dg3", "sc_5tat1n", "sc_n3wn3w"] }])).toBe(
      "id: ch_arr1va\ntitle: Arrival # first chapter\nscenes: [sc_br1dg3, sc_5tat1n, sc_n3wn3w]\n",
    );
  });

  it("adds a key after the map's last one, at its indentation, and removes one with its lines", () => {
    const text = "id: x\nwhen:\n  day: 1\n  time: \"09:10\"\ntags: [a]\n";
    expect(editYaml(text, [{ path: ["when", "zone"], value: "UTC" }])).toBe("id: x\nwhen:\n  day: 1\n  time: \"09:10\"\n  zone: UTC\ntags: [a]\n");
    expect(editYaml(text, [{ path: ["when"], remove: true }])).toBe("id: x\ntags: [a]\n");
    expect(editYaml(text, [{ path: ["status"], value: "drafted" }])).toBe(`${text}status: drafted\n`);
  });

  it("creates missing maps on the way", () => {
    expect(editYaml("id: char_x\nname: Ada\n", [{ path: ["fields", "eyes"], value: "grey" }])).toBe("id: char_x\nname: Ada\nfields:\n  eyes: grey\n");
  });

  it("edits inside block lists: an item's field, appending, removing", () => {
    const text = "plotlines:\n  - id: plot_a\n    weight: minor # not the main one\n  - plot_b\nthemes: []\n";
    expect(editYaml(text, [{ path: ["plotlines", 0, "beat"], value: "First sign" }])).toBe(
      "plotlines:\n  - id: plot_a\n    weight: minor # not the main one\n    beat: First sign\n  - plot_b\nthemes: []\n",
    );
    expect(editYaml(text, [{ path: ["plotlines", 2], value: "plot_c" }])).toBe("plotlines:\n  - id: plot_a\n    weight: minor # not the main one\n  - plot_b\n  - plot_c\nthemes: []\n");
    expect(editYaml(text, [{ path: ["plotlines", 1], remove: true }])).toBe("plotlines:\n  - id: plot_a\n    weight: minor # not the main one\nthemes: []\n");
  });

  it("writes a collection that replaces a scalar or an empty one as a block, at the pair's place", () => {
    expect(editYaml("a: 1\ntags: []\nz: 2\n", [{ path: ["tags"], value: ["x", "y"] }])).toBe("a: 1\ntags: [x, y]\nz: 2\n");
    expect(editYaml("a: 1\nwhen: soon\nz: 2\n", [{ path: ["when"], value: { day: 3 } }])).toBe("a: 1\nwhen:\n  day: 3\nz: 2\n");
  });

  it("keeps CRLF line endings", () => {
    expect(editYaml("a: 1\r\nb: 2\r\n", [{ path: ["c"], value: { d: 1 } }])).toBe("a: 1\r\nb: 2\r\nc:\r\n  d: 1\r\n");
  });

  it("changes only the edited key's lines, for any key of any of the sample's files", () => {
    const documents = [...yamlFiles, ...frontMatters];
    const value = fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean(), fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 4 }), fc.constant({ day: 4, time: "11:00" }));
    fc.assert(
      fc.property(fc.nat(), fc.nat(), value, fc.boolean(), (d, k, v, remove) => {
        const text = documents[d % documents.length]!;
        const doc = parseDocument(text);
        if (!isMap(doc.contents) || !doc.contents.items.length) return;
        const pair = doc.contents.items[k % doc.contents.items.length]! as Pair;
        const key = (pair.key as { value: string }).value;
        const edit: YamlEdit = remove ? { path: [key], remove: true } : { path: [key], value: v };
        const out = editYaml(text, [edit]);
        const expected = doc.toJS() as Record<string, unknown>;
        if (remove) delete expected[key];
        else expected[key] = v;
        expect(parseDocument(out).toJS() ?? {}).toEqual(expected);
        // Lines before and after the pair are untouched.
        const firstLine = text.slice(0, (pair.key as Node).range![0]).split("\n").length - 1;
        const valueNode = (pair.value ?? pair.key) as Node;
        const lastLine = text.slice(0, valueNode.range![1] - 1).split("\n").length - 1;
        const [a, b] = [text.split("\n"), out.split("\n")];
        expect(b.slice(0, firstLine)).toEqual(a.slice(0, firstLine));
        const after = a.slice(lastLine + 1);
        expect(b.slice(b.length - after.length)).toEqual(after);
      }),
      { numRuns: 500 },
    );
  });
});

describe("editFrontMatter", () => {
  it("edits the front matter only, keeping BOM, CRLF and the body", () => {
    const file = "﻿---\r\nid: sc_a\r\ntitle: Old\r\n---\r\n\r\nBody text.\r\n";
    expect(editFrontMatter(file, [{ path: ["title"], value: "New" }])).toBe("﻿---\r\nid: sc_a\r\ntitle: New\r\n---\r\n\r\nBody text.\r\n");
    expect(readFrontMatter(file)).toEqual({ id: "sc_a", title: "Old" });
  });

  it("adds front matter to a file without any", () => {
    expect(editFrontMatter("Just prose.\n", [{ path: ["id"], value: "sc_b" }])).toBe("---\nid: sc_b\n---\nJust prose.\n");
  });
});

describe("names", () => {
  it("makes IDs that are new and well formed", () => {
    let n = 0;
    // A generator that repeats itself until the fourth try.
    const random = (len: number) => new Uint8Array(len).fill(n++ < 3 ? 0 : 1);
    expect(uniqueId("sc", new Set(["sc_000000"]), random)).toBe("sc_111111");
    expect(uniqueId("char", new Set())).toMatch(/^char_[0-9a-hjkmnp-tv-z]{6}$/);
  });

  it("makes slugs and unique, numbered file names", () => {
    expect(slugify("Ben's Ledger")).toBe("bens-ledger");
    expect(slugify("  Ça va? Résumé ")).toBe("ca-va-resume");
    expect(slugify("✨")).toBe("untitled");
    expect(uniqueFileName("ada", ".md", new Set(["ada.md", "ada-2.md"]))).toBe("ada-3.md");
    expect(numberedName(2, 9, "the-station")).toBe("03-the-station");
    expect(numberedName(9, 120, "x")).toBe("010-x");
  });
});

describe("queries", async () => {
  const novel = await loadNovel(nodeSource(sample));

  it("backlinks find every scene that names an entity, in front matter or prose", () => {
    for (const entity of novel.entities) {
      const expected = novel.scenes.filter((s) => readFileSync(join(sample, s.file), "utf8").includes(entity.id)).map((s) => s.id);
      expect(backlinks(novel, entity.id).scenes.map((b) => b.scene.id), entity.name).toEqual(expected);
    }
    const ada = backlinks(novel, "char_7f3k2q");
    expect(ada.relationships.length).toBeGreaterThan(0);
    expect(ada.scenes.find((b) => b.scene.id === "sc_5tat1n")?.via).toEqual(expect.arrayContaining(["pov", "characters"]));
  });

  it("relationship history agrees with relationshipsAt at every scene", () => {
    for (const entity of novel.entities) {
      const spans = relationshipHistory(novel, entity.id);
      for (const scene of novel.scenes) {
        const span = spans.find((s) => {
          const from = s.from === null ? -1 : novel.scenes.findIndex((x) => x.id === s.from);
          const until = s.until === null ? Infinity : novel.scenes.findIndex((x) => x.id === s.until);
          return from <= scene.position && scene.position < until;
        })!;
        const expected = relationshipsAt(novel, scene.id).filter((r) => r.from === entity.id || r.to === entity.id);
        expect(span.relationships.map((r) => r.id).sort()).toEqual(expected.map((r) => r.id).sort());
      }
    }
  });

  it("splits at a change: before and after read differently", () => {
    const changing = novel.relationships.find((r) => r.since)!;
    const spans = relationshipHistory(novel, changing.from, changing.to);
    const at = spans.findIndex((s) => s.from === changing.since);
    expect(at).toBeGreaterThan(0);
    expect(spans[at]!.relationships).toContainEqual(changing);
    expect(spans[at - 1]!.relationships).not.toContainEqual(changing);
  });
});



