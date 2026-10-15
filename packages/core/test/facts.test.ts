import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadNovel, memorySource, readableSpan, sceneFacts } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../examples/sample-novel/", import.meta.url));
const sample: Record<string, string> = Object.fromEntries(
  readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [relative(ROOT, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8")]),
);
const SPAN = "manuscript/01-return/01-arrival/02-the-bridge.md";
const STATION = "manuscript/01-return/01-arrival/01-the-station.md";

const novel = (changes: Record<string, string> = {}) => loadNovel(memorySource({ ...sample, ...changes }));
const edit = (path: string, from: string, to: string) => {
  const text = sample[path]!;
  if (!text.includes(from)) throw new Error(`${path} has no “${from}”`);
  return { [path]: text.replace(from, to) };
};

describe("sceneFacts", () => {
  it("says what holds of each of the sample's scenes", async () => {
    const book = await novel();
    expect(Object.fromEntries(book.scenes.map((s) => [s.title, sceneFacts(book, s.id)]))).toEqual({
      // Off-page events right before or after a scene in story time, with no scene between.
      "The Station": ["The book's first scene.", "6 days after the off-page event “The plans are stolen”.", "First appearance of Ada Varn.", "The Sale begins here."],
      "Walking the Span": ["8 h 10 min after “The Station”.", "First appearance of Ben Varn.", "Ben's Debt begins here."],
      "Tomas's Workshop": ["15 h 40 min after “Walking the Span”.", "First appearance of Tomas Hale."],
      "Ben's Ledger": ["11 h after “Tomas's Workshop”."],
      "The Betrayal": [
        "21 h 30 min after “Ben's Ledger”.",
        "Ends here: Ada Varn: allied with Ben Varn.",
        "Starts here: Ada Varn: rivals with Ben Varn.",
        "Ends here: Ben Varn: owes Mirela Kost.",
        "Starts here: Mirela Kost: holds The Original Plans.",
      ],
      // Fourteen years back; and the next scene is measured from where the story was before it.
      "The Flood": [
        "A flashback: 14 years before “The Betrayal”.",
        "During the off-page event “The flood of '09”.",
        "3 years before the off-page event “Ada leaves for the polytechnic”.",
      ],
      "Mirela's Offer": ["15 h 45 min after “The Betrayal”.", "First appearance of Mirela Kost."],
      "The Last Rivet": [
        "The book's last scene.",
        "19 h after “Mirela's Offer”.",
        "The Sale ends here.",
        "Ben's Debt ends here.",
        "Ends here: Ada Varn: rivals with Ben Varn.",
        "Starts here: Ada Varn: allied with Ben Varn.",
      ],
    });
  });

  it("says nothing of story time for a scene without one, and skips it for the next", async () => {
    const book = await novel(edit(SPAN, 'when:\n  day: 1\n  time: "17:40"\nduration: PT40M\n', ""));
    const facts = (title: string) => sceneFacts(book, book.scenes.find((s) => s.title === title)!.id);
    expect(facts("Walking the Span")).toEqual(["First appearance of Ben Varn.", "Ben's Debt begins here."]);
    expect(facts("Tomas's Workshop")[0]).toBe("1 day after “The Station”.");
  });

  it("notes someone back after a long absence", async () => {
    // Mirela at the station, then not again until her offer, five scenes later.
    const book = await novel(edit(STATION, "characters: [char_7f3k2q]", "characters: [char_7f3k2q, char_m1re1a]"));
    expect(sceneFacts(book, "sc_5tat1n")).toContain("First appearance of Ada Varn and Mirela Kost.");
    expect(sceneFacts(book, "sc_0ffer5")).toEqual(["15 h 45 min after “The Betrayal”.", "Mirela Kost is back after 5 scenes away."]);
  });

  it("names the off-page event a scene was written from", async () => {
    const book = await novel(edit("bible/events/the-plans-are-stolen.md", "---\n\nOff page", "scene: sc_1edger\n---\n\nOff page"));
    expect(sceneFacts(book, "sc_1edger")).toContain("Dramatizes the off-page event “The plans are stolen”.");
  });

  it("knows a book of one scene, and nothing of a scene outside the reading order", async () => {
    const book = await novel({
      "manuscript/_order.yaml": "parts: [pt_r3tvrn]\n",
      "manuscript/01-return/_part.yaml": sample["manuscript/01-return/_part.yaml"]!.replace("chapters: [ch_arr1va, ch_01dde6]", "chapters: [ch_arr1va]"),
      "manuscript/01-return/01-arrival/_chapter.yaml": sample["manuscript/01-return/01-arrival/_chapter.yaml"]!.replace("scenes: [sc_5tat1n, sc_br1dg3]", "scenes: [sc_5tat1n]"),
    });
    expect(book.scenes.map((s) => s.id)).toEqual(["sc_5tat1n"]);
    expect(sceneFacts(book, "sc_5tat1n")).toEqual(["The book's only scene.", "6 days after the off-page event “The plans are stolen”.", "First appearance of Ada Varn.", "The Sale begins and ends here."]);
    expect(sceneFacts(book, "sc_br1dg3")).toEqual([]);
    expect(sceneFacts(book, "sc_nope00")).toEqual([]);
  });

  it("reads spans of story time", () => {
    expect(readableSpan(40 * 60_000)).toBe("40 min");
    expect(readableSpan(3 * 3_600_000)).toBe("3 h");
    expect(readableSpan(26 * 3_600_000)).toBe("1 day");
    expect(readableSpan(3 * 365 * 86_400_000)).toBe("3 years");
  });
});
