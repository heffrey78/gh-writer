import NSpell from "nspell";

/*
 * The spell checking engine: nspell (Hunspell-compatible) over a Hunspell dictionary, plus the
 * novel's known words. It runs inside a Web Worker in the app (spell.worker.ts), and directly
 * in tests and wherever workers aren't available.
 */

/** A Hunspell dictionary: the affix and dictionary files' text. */
export interface SpellDictionary {
  aff: string;
  dic: string;
}

/** Misspelled words in a text, as [start, end) offsets. */
export type Misspellings = [number, number][];

// Not checked: words with digits or underscores (numbers, identifiers), abbreviations and
// initials with dots (e.g., U.S.A.), and single letters.
const SKIP = /[\d_.]|^.$/u;

export class SpellEngine {
  private spell: ReturnType<typeof NSpell>;
  private known = new Set<string>();
  private segmenter = new Intl.Segmenter("en", { granularity: "word" });

  constructor(dictionary: SpellDictionary, known: string[] = []) {
    this.spell = NSpell(dictionary.aff, dictionary.dic);
    this.setKnown(known);
  }

  /** Replace the known words (the bible's names and the novel's dictionary). */
  setKnown(words: string[]): void {
    const next = new Set(words);
    for (const word of this.known) if (!next.has(word)) this.spell.remove(word);
    for (const word of next) if (!this.known.has(word)) this.spell.add(word);
    this.known = next;
  }

  /** Accept more words, e.g. ignored for this session. */
  add(words: string[]): void {
    for (const word of words) this.spell.add(word);
  }

  correct(word: string): boolean {
    const w = word.replace(/’/g, "'");
    if (this.spell.correct(w)) return true;
    // Possessives of names and other known words: Ada's, Tomas’s.
    return /'s$/i.test(w) && this.spell.correct(w.slice(0, -2));
  }

  misspellings(text: string): Misspellings {
    const out: Misspellings = [];
    for (const { segment, index, isWordLike } of this.segmenter.segment(text)) {
      if (isWordLike && !SKIP.test(segment) && !this.correct(segment)) out.push([index, index + segment.length]);
    }
    return out;
  }

  suggest(word: string): string[] {
    return this.spell.suggest(word.replace(/’/g, "'")).slice(0, 6);
  }
}
