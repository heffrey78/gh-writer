/*
 * What a novel's issues are about (#8, #9): writing kinds rather than GitHub's software labels. A
 * kind is the label kind/<key> on GitHub, with its own colour.
 */

export interface IssueKind {
  key: string;
  /** As the author reads it: "Plot hole". */
  label: string;
  /** Its label's colour on GitHub (hex, no #). */
  color: string;
  description: string;
}

export const ISSUE_KINDS: readonly IssueKind[] = [
  { key: "plot-hole", label: "Plot hole", color: "d73a4a", description: "Something in the story that can't happen" },
  { key: "continuity", label: "Continuity", color: "fbca04", description: "Facts that don't agree" },
  { key: "research", label: "Research", color: "0075ca", description: "Something to look up" },
  { key: "idea", label: "Idea", color: "a2eeef", description: "Something to try" },
  { key: "revision", label: "Revision", color: "7057ff", description: "Something to rewrite" },
];

/** The label on GitHub for a kind. */
export const kindLabel = (kind: IssueKind) => `kind/${kind.key}`;

/** The kind a label stands for, if it's a kind's. */
export function kindOf(label: string): IssueKind | undefined {
  return label.startsWith("kind/") ? ISSUE_KINDS.find((k) => kindLabel(k) === label) : undefined;
}

/** The labels GitHub gives every new repository: for software, not novels. */
export const STOCK_LABELS: ReadonlySet<string> = new Set(["bug", "documentation", "duplicate", "enhancement", "good first issue", "help wanted", "invalid", "question", "wontfix"]);
