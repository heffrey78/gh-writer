import type { Novel } from "./model.ts";
import type { FileSource } from "./source.ts";

/*
 * Imported as "@gh-writer/core/dictionary", not from the package index, so the vendored
 * validator's bundle doesn't change with it.
 *
 * The novel's own dictionary: dictionary.txt at the repository root, words the spell checker
 * accepts on top of the language dictionary and the story bible's names. One word per line,
 * kept sorted so adding a word is a one-line diff that merges cleanly; blank lines and lines
 * starting with # are ignored.
 */

export const DICTIONARY_FILE = "dictionary.txt";

const HEADER = "# Words the spell checker accepts in this novel, one per line.\n# Names and aliases from the story bible are accepted already.\n";

export function parseDictionary(text: string): string[] {
  const words: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim();
    if (word && !word.startsWith("#")) words.push(word);
  }
  return words;
}

/** The dictionary file with `word` added in sorted position (unchanged if it's already there). */
export function addToDictionary(text: string, word: string): string {
  word = word.trim();
  if (!word || /\s/.test(word) || parseDictionary(text).includes(word)) return text;
  if (!text.trim()) return `${HEADER}${word}\n`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/(\r?\n)$/, "").split(/\r?\n/);
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
  let at = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line && !line.startsWith("#") && compare(word, line) < 0) {
      at = i;
      break;
    }
  }
  lines.splice(at, 0, word);
  return lines.join(eol) + eol;
}

/** Read the novel's dictionary; a missing file is an empty dictionary. */
export async function readDictionary(source: FileSource): Promise<string[]> {
  return parseDictionary((await source.read(DICTIONARY_FILE)) ?? "");
}

/**
 * Words the spell checker should accept for a novel: every word of its entities' names and
 * aliases, plus its dictionary.
 */
export function knownWords(novel: Pick<Novel, "entities">, dictionary: string[] = []): string[] {
  const words = new Set(dictionary);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const entity of novel.entities) {
    for (const name of [entity.name, ...(entity.aliases ?? [])]) {
      if (!name) continue;
      for (const { segment, isWordLike } of segmenter.segment(name)) if (isWordLike) words.add(segment);
    }
  }
  return [...words];
}
