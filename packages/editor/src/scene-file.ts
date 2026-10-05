/** A scene file split into its front matter (kept byte for byte) and the prose body the editor edits. */
export interface SceneFile {
  /** Everything up to and including the closing `---` line: BOM, delimiters and line endings as in the file. */
  frontMatter: string;
  body: string;
}

// Same block as core's parseMarkdown, matched on the raw text so BOM and CRLF survive.
const FRONT_MATTER = /^﻿?---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitSceneFile(text: string): SceneFile {
  const match = FRONT_MATTER.exec(text);
  return match ? { frontMatter: match[0], body: text.slice(match[0].length) } : { frontMatter: "", body: text };
}

export function joinSceneFile(file: SceneFile): string {
  return file.frontMatter + file.body;
}
