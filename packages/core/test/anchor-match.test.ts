import { describe, expect, it } from "vitest";
import { resolveAnchor } from "../src/index.ts";

const SCENE = [
  "The train gave up the last of its heat as it pulled into Varn, and Ada was the only passenger who stood.",
  "",
  "Twelve years had not moved the station clock. It still ran four minutes fast, as it had when her father set it, so that nobody in Varn would ever miss the last train out.",
  "",
  "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.",
].join("\n");
const QUOTE = "She stood with her bag at her feet and counted them twice, the way you count stitches in a wound.";
const at = (text: string, m: { from: number; to: number } | undefined) => (m ? text.slice(m.from, m.to) : undefined);

describe("finding an anchored passage again", () => {
  it("finds it as quoted", () => {
    const m = resolveAnchor(SCENE, QUOTE);
    expect(m).toMatchObject({ kind: "exact", similarity: 1 });
    expect(at(SCENE, m)).toBe(QUOTE);
  });

  it("is unmoved by paragraphs written above it", () => {
    const longer = `A new opening paragraph.\n\nAnd another, with ${"many words ".repeat(200)}\n\n${SCENE}`;
    expect(at(longer, resolveAnchor(longer, QUOTE))).toBe(QUOTE);
  });

  it("finds it after spacing, quote marks, dashes and case changed", () => {
    const quote = 'Ada said, "It\'s ten - no, twelve - years."';
    const text = `Before.\n\nAda  said,\n“It’s ten — no, Twelve — years.” After.`;
    const m = resolveAnchor(text, quote);
    expect(m?.kind).toBe("normalized");
    expect(at(text, m)).toBe("Ada  said,\n“It’s ten — no, Twelve — years.”");
  });

  it("finds a passage edited a little since: a word changed, one added, one taken out", () => {
    const edited = SCENE.replace("counted them twice", "counted the flags twice").replace("the way you count", "the way a surgeon counts").replace("at her feet and", "at her feet, and");
    const m = resolveAnchor(edited, QUOTE);
    expect(m?.kind).toBe("approximate");
    expect(m!.similarity).toBeGreaterThanOrEqual(0.75);
    expect(at(edited, m)).toBe("She stood with her bag at her feet, and counted the flags twice, the way a surgeon counts stitches in a wound.");
  });

  it("finds it in the scene wherever the scene now is: only the text matters", () => {
    expect(at(`${SCENE}\n\nA new last paragraph.`, resolveAnchor(`${SCENE}\n\nA new last paragraph.`, QUOTE))).toBe(QUOTE);
  });

  it("is orphaned when the passage is gone or rewritten", () => {
    const without = SCENE.replace(QUOTE, "She left.");
    expect(resolveAnchor(without, QUOTE)).toBeUndefined();
    expect(resolveAnchor(SCENE.replace(QUOTE, "Her bag sat by her feet while she counted the flags over and over, like a nurse counting stitches."), QUOTE)).toBeUndefined();
    expect(resolveAnchor("", QUOTE)).toBeUndefined();
    expect(resolveAnchor(SCENE, "   ")).toBeUndefined();
  });

  it("is fast enough for every open issue of a long chapter on each change", () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} of the chapter goes on about the bridge, the river and the people of Varn, number ${i * 7}.`);
    const chapter = paragraphs.join("\n\n");
    const quotes = Array.from({ length: 20 }, (_, i) => paragraphs[i * 19]!.replace("bridge", "old bridge"));
    const start = performance.now();
    quotes.forEach((q, i) => {
      const m = resolveAnchor(chapter, q);
      expect(m?.kind).toBe("approximate");
      // In the right paragraph, not a look-alike.
      expect(chapter.slice(m!.from, m!.to)).toBe(paragraphs[i * 19]);
    });
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
