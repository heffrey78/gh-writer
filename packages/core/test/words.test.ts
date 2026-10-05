import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { countText, countWords, loadNovel, proseText } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

describe("countText", () => {
  test.each([
    ["", 0],
    ["One two three.", 3],
    ["  spaced   out  ", 2],
    ["A well-known, re-entrant idea", 4],
    ["word--word and word—word and word – word", 8],
    ["Don’t, can't, won't", 3],
    ["1,000 people paid $3.50 each, 50% more", 7],
    ["café naïve Ærøskøbing", 3],
    ["“Quoted,” she said… “again!”", 4],
    ["e.g. the U.S.A.", 3],
    ["東京は大きい都市です", 5],
  ])("%j has %i words", (text, words) => {
    expect(countText(text)).toBe(words);
  });
});

describe("countWords", () => {
  test.each([
    ["*Emphasis* and **strong** and _under_ __scores__", 6],
    ["[Ada](#char_7f3k2q) met [Ben Varn](#char_b3n0vs).", 4],
    ["See [the site](https://example.com/a-long/path?q=1 \"Title\").", 3],
    ["A ![map of the river](map.png) here.", 2],
    ["See [the plans][plans].\n\n[plans]: https://example.com/plans", 3],
    ["A claim.[^1]\n\n[^1]: The source.", 4],
    ["<span class=\"x\">raw</span> and <https://example.com>", 2],
    ["5 \\* 3 &amp; caf&eacute; &mdash; done", 4],
    ["> Quoted\n> text.\n\n***\n\n- one\n- two", 4],
    ["Roses are red,\\\nviolets are blue.", 6],
    ["| Day | Event |\n|-----|-------|\n| 1 | Arrival |", 4],
  ])("%j has %i words", (md, words) => {
    expect(countWords(md)).toBe(words);
  });

  test("proseText drops targets but keeps what a reader sees", () => {
    expect(proseText("[Ada](#char_7f3k2q) &mdash; *yes* \\_x\\_")).toBe("Ada — *yes* _x_");
  });

  test("the sample novel's scenes have the expected counts", async () => {
    const root = join(import.meta.dirname, "../../../examples/sample-novel");
    const novel = await loadNovel(nodeSource(root));
    // The sample's prose is plain: a naive whitespace count, ignoring mention targets, agrees.
    const naive = (body: string) => body.replace(/\]\(#[^)]+\)/g, "]").split(/\s+/).filter((w) => /\p{L}|\d/u.test(w)).length;
    for (const scene of novel.scenes) expect(countWords(scene.body), scene.file).toBe(naive(scene.body));
    const station = novel.scenes.find((s) => s.id === "sc_5tat1n")!;
    // Front matter is never part of a body.
    expect(station.body).not.toContain("title:");
    expect(readFileSync(join(root, station.file), "utf8")).toContain("title:");
  });
});
