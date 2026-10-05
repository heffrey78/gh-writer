import { countWords, parseMarkdown } from "@gh-writer/core";

/** One staged file: its git status and its text before and after. */
export interface FileChange {
  status: "A" | "M" | "D" | "R";
  path: string;
  /** The path before a rename. */
  oldPath?: string;
  before?: string;
  after?: string;
}

const MAX_NAMES = 3;

/**
 * A commit message from what changed: a summary naming the scenes and bible entries, with the net
 * change in manuscript words, e.g. "Draft: The Station, The Bridge (+214 words)", then a body
 * listing each file.
 */
export function commitMessage(changes: FileChange[]): { summary: string; body: string } {
  const drafted: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const bible: string[] = [];
  const other: string[] = [];
  let words = 0;
  const lines: string[] = [];

  for (const change of changes) {
    const kind = kindOf(change.path);
    let line = `${change.status} ${change.oldPath ? `${change.oldPath} → ` : ""}${change.path}`;
    if (kind === "scene") {
      const title = field(change.after ?? change.before, "title") ?? fileTitle(change.path);
      const delta = bodyWords(change.after) - bodyWords(change.before);
      words += delta;
      if (delta) line += ` (${signed(delta)})`;
      (change.status === "A" ? added : change.status === "D" ? removed : drafted).push(title);
    } else if (kind === "bible") {
      bible.push(field(change.after ?? change.before, "name") ?? fileTitle(change.path));
    } else {
      other.push(change.path.split("/").pop()!);
    }
    lines.push(line);
  }

  const parts: string[] = [];
  if (drafted.length) parts.push(`Draft: ${names(drafted)}`);
  if (added.length) parts.push(`${added.length === 1 ? "New scene" : "New scenes"}: ${names(added)}`);
  if (removed.length) parts.push(`${removed.length === 1 ? "Remove scene" : "Remove scenes"}: ${names(removed)}`);
  if (bible.length) parts.push(`Bible: ${names(bible)}`);
  if (other.length) parts.push(`Update ${names(other)}`);
  const scenes = drafted.length + added.length + removed.length;
  const summary = (parts.join("; ") || "Update the novel") + (scenes && words ? ` (${signed(words)})` : "");
  return { summary, body: lines.join("\n") };
}

type Kind = "scene" | "bible" | "other";

function kindOf(path: string): Kind {
  const file = path.split("/").pop()!;
  if (!file.endsWith(".md") || file.startsWith("_")) return "other";
  if (path.startsWith("manuscript/")) return "scene";
  if (path.startsWith("bible/")) return "bible";
  return "other";
}

/** A string field from the front matter, if the file has one. */
function field(text: string | undefined, key: string): string | undefined {
  if (text === undefined) return undefined;
  const data = parseMarkdown(text, "").data as Record<string, unknown> | undefined;
  const value = data?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyWords(text: string | undefined): number {
  return text === undefined ? 0 : countWords(parseMarkdown(text, "").body);
}

/** "03-the-last-rivet.md" → "the last rivet" */
function fileTitle(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "").replace(/^\d+-/, "").replace(/-/g, " ");
}

function names(list: string[]): string {
  const unique = [...new Set(list)];
  if (unique.length <= MAX_NAMES) return unique.join(", ");
  return `${unique.slice(0, MAX_NAMES).join(", ")} and ${unique.length - MAX_NAMES} more`;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : "-"}${Math.abs(n)} ${Math.abs(n) === 1 ? "word" : "words"}`;
}
