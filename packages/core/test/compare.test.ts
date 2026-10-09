import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareNovels, compareProse, proseParagraphs } from "../src/compare.ts";
import { loadNovel, memorySource } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const sample: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const ARRIVAL = "manuscript/01-return/01-arrival/_chapter.yaml";
const OLD_DEBTS = "manuscript/01-return/02-old-debts/_chapter.yaml";

const novel = (changes: Record<string, string | undefined> = {}) => {
  const files = { ...sample, ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete files[k];
  return loadNovel(memorySource(files as Record<string, string>));
};
const edit = (path: string, from: string, to: string) => {
  const text = sample[path]!;
  if (!text.includes(from)) throw new Error(`${path} has no “${from}”`);
  return { [path]: text.replace(from, to) };
};

describe("compareNovels", () => {
  it("finds nothing between a novel and itself", async () => {
    const c = compareNovels(await novel(), await novel());
    expect(c.counts).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
    expect(c.chapters.every((ch) => ch.status === "unchanged")).toBe(true);
    expect([c.entries, c.relationships, c.events]).toEqual([[], [], []]);
    expect(c.words.before).toBe(c.words.after);
  });

  it("reports a scene's reworded text, its details and the word counts", async () => {
    const after = await novel({
      ...edit(STATION, "the only passenger who stood", "the only passenger still standing, and the last"),
      [STATION]: edit(STATION, "the only passenger who stood", "the only passenger still standing, and the last")[STATION]!.replace("status: drafted", "status: revised").replace("pov: char_7f3k2q", "pov: char_b3n0vs"),
    });
    const c = compareNovels(await novel(), after);
    const station = c.chapters[0]!.scenes[0]!;
    expect(station).toMatchObject({ id: "sc_5tat1n", title: "The Station", status: "changed", moved: false, prose: true });
    expect(station.fields).toEqual([
      { label: "Status", before: "drafted", after: "revised" },
      { label: "Point of view", before: "Ada Varn", after: "Ben Varn" },
    ]);
    expect(station.words.after - station.words.before).toBe(3);
    expect(c.words.after - c.words.before).toBe(3);
    expect(c.chapters[0]).toMatchObject({ title: "Arrival", status: "changed", words: { before: expect.any(Number), after: expect.any(Number) } });
    expect(c.chapters[1]).toMatchObject({ title: "Old Debts", status: "unchanged" });
    expect(c.counts).toEqual({ added: 0, removed: 0, changed: 1, moved: 0 });
  });

  it("lists added and removed scenes where they are, and a scene moved to another chapter where it went", async () => {
    const after = await novel({
      [ARRIVAL]: "id: ch_arr1va\ntitle: Arrival\nscenes: [sc_br1dg3, sc_w0rk5h]\n",
      [OLD_DEBTS]: "id: ch_01dde6\ntitle: Old Debts\nscenes: [sc_new001]\n",
      "manuscript/01-return/02-old-debts/03-new.md": "---\nid: sc_new001\ntitle: A New Scene\nstatus: idea\n---\n\nFresh words here.\n",
      [STATION]: undefined,
      "manuscript/01-return/02-old-debts/01-the-workshop.md": undefined,
      "manuscript/01-return/02-old-debts/02-bens-ledger.md": undefined,
      "manuscript/01-return/01-arrival/03-the-workshop.md": sample["manuscript/01-return/02-old-debts/01-the-workshop.md"]!,
    });
    const before = await novel();
    const c = compareNovels(before, after);
    const arrival = c.chapters.find((ch) => ch.id === "ch_arr1va")!;
    const debts = c.chapters.find((ch) => ch.id === "ch_01dde6")!;
    expect(arrival.scenes.map((s) => [s.title, s.status, s.moved])).toEqual([
      ["The Station", "removed", false],
      ["Walking the Span", "unchanged", false],
      ["Tomas's Workshop", "unchanged", true],
    ]);
    expect(arrival.scenes[2]!.movedFrom).toBe("Old Debts");
    expect(debts.scenes.map((s) => [s.title, s.status])).toEqual([
      ["Ben's Ledger", "removed"],
      ["A New Scene", "added"],
    ]);
    expect(c.counts).toMatchObject({ added: 1, removed: 2, moved: 1 });
  });

  it("says what changed in the story bible, its relationships and events, in words", async () => {
    const after = await novel({
      ...edit("bible/characters/ada.md", "occupation: Structural engineer", "occupation: Bridge inspector"),
      ...edit("bible/relationships.yaml", "    type: allies\n    until: sc_0d9wm4", "    type: allies\n    until: sc_f100d0"),
    });
    const c = compareNovels(await novel(), after);
    expect(c.entries).toEqual([{ id: "char_7f3k2q", name: "Ada Varn", type: "Character", status: "changed", fields: [{ label: "occupation", before: "Structural engineer", after: "Bridge inspector" }] }]);
    expect(c.relationships).toEqual([
      { id: "rel_a11e5a", status: "changed", before: "Ada Varn: Allied with Ben Varn, until “The Betrayal”", after: "Ada Varn: Allied with Ben Varn, until “The Flood”" },
    ]);
  });
});

describe("compareProse", () => {
  it("reads mentions as their words and leaves hidden notes out", () => {
    expect(proseParagraphs("[Ada](#char_7f3k2q) *looked* up.\nAt the bridge.\n\n<!-- a note -->\n\n***\n\n> A quote.\n")).toEqual(["Ada looked up. At the bridge.", "* * *", "A quote."]);
  });

  it("shows the reworded words of a paragraph, not the whole of it", () => {
    expect(compareProse("She stood with her bag at her feet and counted them twice.\n", "She stood with her bag at her feet and counted them three times.\n")).toEqual([
      {
        kind: "changed",
        parts: [
          { op: "same", text: "She stood with her bag at her feet and counted them " },
          { op: "del", text: "twice" },
          { op: "ins", text: "three times" },
          { op: "same", text: "." },
        ],
      },
    ]);
  });

  it("shows a scene added or removed as all its paragraphs", () => {
    expect(compareProse(undefined, "One.\n\nTwo.\n")).toEqual([
      { kind: "added", text: "One." },
      { kind: "added", text: "Two." },
    ]);
  });
});
