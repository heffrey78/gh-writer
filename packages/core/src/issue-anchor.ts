/*
 * Issues about a passage of the prose (#9, D1): the issue's body reads well on github.com (the note,
 * the passage quoted, where it is), and ends with a hidden footer that tells gh-writer which scene and
 * words it's about: <!-- gh-writer {"scene":"sc_…","quote":"…","commit":"…"} -->.
 */

/** What an issue is about: a passage of a scene, as it read when the issue was raised. */
export interface IssueAnchor {
  /** The scene's ID (sc_…): found again wherever its file moves. */
  scene: string;
  /** The passage's words. */
  quote: string;
  /** The commit the scene was at, when known. */
  commit?: string;
}

const FOOTER = /<!-- gh-writer (\{[\s\S]*?\}) -->/g;

/**
 * The hidden footer for `anchor`: JSON in an HTML comment, with "--", "<" and ">" written as \u
 * escapes, so no quote can end the comment early or show as markup.
 */
export function writeAnchor(anchor: IssueAnchor): string {
  const json = JSON.stringify({ scene: anchor.scene, quote: anchor.quote, ...(anchor.commit ? { commit: anchor.commit } : {}) })
    .replace(/-(?=-)/g, "\\u002d")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `<!-- gh-writer ${json} -->`;
}

/** The anchor in an issue's body (the last footer, if edited in twice), or undefined. */
export function readAnchor(body: string): IssueAnchor | undefined {
  const last = [...body.matchAll(FOOTER)].at(-1);
  if (!last) return undefined;
  try {
    const data = JSON.parse(last[1]!) as Record<string, unknown>;
    if (typeof data.scene !== "string" || typeof data.quote !== "string" || !data.quote) return undefined;
    return { scene: data.scene, quote: data.quote, ...(typeof data.commit === "string" ? { commit: data.commit } : {}) };
  } catch {
    return undefined;
  }
}

export interface PassageIssue {
  /** The author's note (Markdown); may be empty. */
  details: string;
  quote: string;
  sceneTitle: string;
  /** The scene file on GitHub at the commit, when known. */
  link?: string;
  anchor: IssueAnchor;
}

/** An issue's body for a passage: the note, the passage quoted, where it's from, and the hidden anchor. */
export function passageIssueBody({ details, quote, sceneTitle, link, anchor }: PassageIssue): string {
  const quoted = quote
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const from = link ? `From [*${sceneTitle}*](${link}).` : `From *${sceneTitle}*.`;
  return [details.trim(), quoted, from, writeAnchor(anchor)].filter(Boolean).join("\n\n");
}
