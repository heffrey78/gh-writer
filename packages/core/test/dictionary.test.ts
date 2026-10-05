import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { addToDictionary, knownWords, parseDictionary, readDictionary } from "../src/dictionary.ts";
import { loadNovel, memorySource } from "../src/index.ts";
import { nodeSource } from "../src/node.ts";

describe("dictionary.txt", () => {
  test("one word per line; blank lines and comments ignored", () => {
    expect(parseDictionary("# words\nVarn\n\n  ironwork \r\n# more\nsteamline\n")).toEqual(["Varn", "ironwork", "steamline"]);
  });

  test("adding a word keeps the file sorted, so the diff is one line", () => {
    const text = "# Words\nalpha\ngamma\n";
    expect(addToDictionary(text, "beta")).toBe("# Words\nalpha\nbeta\ngamma\n");
    expect(addToDictionary(text, "Zeta")).toBe("# Words\nalpha\ngamma\nZeta\n");
    expect(addToDictionary(text, "Aardvark")).toBe("# Words\nAardvark\nalpha\ngamma\n");
    expect(addToDictionary(text, "alpha")).toBe(text);
    expect(addToDictionary(text, "two words")).toBe(text);
    expect(addToDictionary("a\r\nc\r\n", "b")).toBe("a\r\nb\r\nc\r\n");
  });

  test("a new file gets a header explaining it", () => {
    const text = addToDictionary("", "Varn");
    expect(text).toMatch(/^# Words the spell checker accepts/);
    expect(parseDictionary(text)).toEqual(["Varn"]);
  });

  test("a missing file is an empty dictionary", async () => {
    expect(await readDictionary(memorySource({}))).toEqual([]);
    expect(await readDictionary(memorySource({ "dictionary.txt": "Varn\n" }))).toEqual(["Varn"]);
  });
});

test("known words are every word of the bible's names and aliases, plus the dictionary", async () => {
  const novel = await loadNovel(nodeSource(join(import.meta.dirname, "../../../examples/sample-novel")));
  const words = knownWords(novel, ["steamline"]);
  for (const w of ["Ada", "Varn", "Mirela", "Kost", "Tomas", "Hale", "steamline"]) expect(words).toContain(w);
  expect(new Set(words).size).toBe(words.length);
});
