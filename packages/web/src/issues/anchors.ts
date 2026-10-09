import type { Issue } from "@gh-writer/client";
import { readAnchor, resolveAnchor, type IssueAnchor, type Novel, type Scene } from "@gh-writer/core";
import { sceneText } from "@gh-writer/editor";

/** Where an issue about a passage stands: its anchor, its scene (wherever it moved), and whether the passage is still there. */
export interface PassageOf {
  anchor: IssueAnchor;
  scene: Scene | undefined;
  /** False: the passage was rewritten or deleted (or its scene is gone): the issue is orphaned. */
  found: boolean;
}

const texts = new Map<string, string>();
const textOf = (markdown: string) => {
  let text = texts.get(markdown);
  if (text === undefined) {
    if (texts.size > 500) texts.clear();
    texts.set(markdown, (text = sceneText(markdown)));
  }
  return text;
};

/**
 * The passage an issue is about, if it was raised about one, as the novel stands: `bodyOf` gives a
 * scene file's text as it is now when it's open (what's typed counts before the model reloads).
 */
export function passageOf(issue: Pick<Issue, "body">, novel: Novel, bodyOf: (file: string) => string | undefined = () => undefined): PassageOf | undefined {
  const anchor = readAnchor(issue.body);
  if (!anchor) return undefined;
  const scene = novel.allScenes.find((s) => s.id === anchor.scene);
  return { anchor, scene, found: !!scene && !!resolveAnchor(textOf(bodyOf(scene.file) ?? scene.body), anchor.quote) };
}
