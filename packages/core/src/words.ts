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
  let count = 0;
  let afterWord = false;
  let joined = false;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) {
      if (!joined) count++;
      afterWord = true;
      joined = false;
    } else {
      joined = afterWord && HYPHEN.test(segment);
      afterWord = false;
    }
  }
  return count;
}

const ENTITIES: Record<string, string> = { amp: "&", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/**
 * Markdown prose as the text a reader sees: link and mention text without their targets,
 * images, HTML tags, footnote references and link definitions removed, escapes and common
 * character references decoded. Emphasis and other markers are left, as they never count.
 */
export function proseText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gm, "") // link reference definitions (footnotes are prose)
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ") // images
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
