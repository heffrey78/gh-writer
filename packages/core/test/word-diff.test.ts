import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffParagraphs, diffSequences, diffWords, tokenize, type DiffPart } from "../src/word-diff.ts";

const before = (parts: DiffPart[]) => parts.filter((p) => p.op !== "ins").map((p) => p.text).join("");
const after = (parts: DiffPart[]) => parts.filter((p) => p.op !== "del").map((p) => p.text).join("");

describe("diffWords", () => {
  it("marks the reworded words, not the whole paragraph", () => {
    expect(diffWords("The train gave up the last of its heat as it pulled into Varn.", "The train gave up the last of its warmth as it crawled into Varn.")).toEqual([
      { op: "same", text: "The train gave up the last of its " },
      { op: "del", text: "heat" },
      { op: "ins", text: "warmth" },
      { op: "same", text: " as it " },
      { op: "del", text: "pulled" },
      { op: "ins", text: "crawled" },
      { op: "same", text: " into Varn." },
    ]);
  });

  it("keeps words whole, with their apostrophes and hyphens, and punctuation apart", () => {
    expect(tokenize("Ben's half-built bridge — gone.")).toEqual(["Ben's", " ", "half-built", " ", "bridge", " ", "—", " ", "gone", "."]);
    expect(diffWords("It was over.", "It was over!")).toEqual([
      { op: "same", text: "It was over" },
      { op: "del", text: "." },
      { op: "ins", text: "!" },
    ]);
  });

  it("reads a run of changed words as one change", () => {
    expect(diffWords("a very old bridge", "a brand new bridge")).toEqual([
      { op: "same", text: "a " },
      { op: "del", text: "very old" },
      { op: "ins", text: "brand new" },
      { op: "same", text: " bridge" },
    ]);
  });

  it("gives back both texts exactly, whatever they are", () => {
    const words = fc.constantFrom("the", "bridge", "Ada", "fell", ",", ".", " ", "  ", "—", "Varn's", "\n");
    const text = fc.array(words, { maxLength: 40 }).map((w) => w.join(""));
    fc.assert(
      fc.property(text, text, (a, b) => {
        const parts = diffWords(a, b);
        expect(before(parts)).toBe(a);
        expect(after(parts)).toBe(b);
      }),
    );
  });
});

describe("diffSequences", () => {
  it("finds the shortest edit", () => {
    expect(diffSequences([..."ABCABBA"], [..."CBABAC"]).filter((r) => r.op !== "same").reduce((n, r) => n + r.items.length, 0)).toBe(5);
  });
  it("gives up past the edit limit with all deleted and all inserted", () => {
    expect(diffSequences(["a", "b"], ["c", "d"], 1)).toEqual([
      { op: "del", items: ["a", "b"] },
      { op: "ins", items: ["c", "d"] },
    ]);
  });
});

describe("diffParagraphs", () => {
  it("pairs a reworded paragraph, and keeps added and removed ones apart", () => {
    const a = ["She stood with her bag at her feet.", "Twelve years had not moved the station clock.", "It was cold."];
    const b = ["She stood with her bag at her feet.", "Twelve long years had not moved the clock.", "Nobody came.", "It was cold."];
    expect(diffParagraphs(a, b)).toEqual([
      { kind: "same", text: a[0] },
      {
        kind: "changed",
        parts: [
          { op: "same", text: "Twelve " },
          { op: "ins", text: "long " },
          { op: "same", text: "years had not moved the " },
          { op: "del", text: "station " },
          { op: "same", text: "clock." },
        ],
      },
      { kind: "added", text: "Nobody came." },
      { kind: "same", text: a[2] },
    ]);
  });

  it("shows an unrelated replacement as removed and added", () => {
    expect(diffParagraphs(["The bridge held."], ["Mirela laughed at him."])).toEqual([
      { kind: "removed", text: "The bridge held." },
      { kind: "added", text: "Mirela laughed at him." },
    ]);
  });
});
