/*
 * Word counting, shared by the editor, the CLI and progress tracking so every count agrees.
 *
 * Words are what Intl.Segmenter calls word-like, so punctuation (and Markdown's own markers)
 * never count, contractions are one word and non-Latin scripts are segmented properly. Words
 * joined by a hyphen with no spaces ("well-known") count once, as word processors do; words
 * joined by a dash ("word—word") count separately.
 */

// Created on first use, so bundles that never count words (the vendored validator) drop it.
let segmenter: Intl.Segmenter | undefined;

// Hyphen-minus, hyphen, non-breaking hyphen.
const HYPHEN = /^[-‐‑]$/;

/** Words in plain text. */
export function countText(text: string): number {
  return wordList(text).length;
}

/** The words of plain text, in order, as counted: a hyphenated word is one ("well-known"). */
export function wordList(text: string): string[] {
  const words: string[] = [];
  let afterWord = false;
  let hyphen: string | undefined;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) {
      if (hyphen !== undefined && words.length) words[words.length - 1] += hyphen + segment;
      else words.push(segment);
      afterWord = true;
      hyphen = undefined;
    } else {
      hyphen = afterWord && HYPHEN.test(segment) ? segment : undefined;
      afterWord = false;
    }
  }
  return words;
}

const ENTITIES: Record<string, string> = { amp: "&", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/**
 * Markdown prose as the text a reader sees: link and mention text without their targets,
 * pictures' captions without their alt text or path, HTML tags, footnote references, link
 * definitions and numbered lists' numbers removed, escapes and common character references
 * decoded. Emphasis and other markers are left, as they never count.
 */
export function proseText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gm, "") // link reference definitions (footnotes are prose)
    .replace(/!\[[^\]\n]*\]\(\s*<?[^\s)>]*>?(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?\s*\)/g, (_, double?: string, single?: string) => ` ${double ?? single ?? ""} `) // pictures: their captions
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ") // other images
    .replace(/^[ \t]*(?:[-*+][ \t]+)*\d{1,9}[.)](?=[ \t]|$)/gm, "") // numbered lists' numbers (D10), nested in bullets too
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // links and mentions: [text](target)
    .replace(/\[\^[^\]\n]+\]/g, "") // footnote references
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1") // reference links: [text][ref]
    .replace(/<[^>\n]*>/g, " ") // HTML tags and autolinks
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (ref, dec?: string, hex?: string, name?: string) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[name!.toLowerCase()] ?? " "),
    )
    .replace(/\\([!-/:-@[-`{-~])/g, "$1"); // backslash escapes
}

/** Words in a Markdown body (a scene or note after its front matter). */
export function countWords(markdown: string): number {
  return countText(proseText(markdown));
}

/** The words of a Markdown body, as countWords counts them. */
export function markdownWords(markdown: string): string[] {
  return wordList(proseText(markdown));
}
