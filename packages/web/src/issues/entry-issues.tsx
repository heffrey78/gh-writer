import type { IssueLabel } from "@gh-writer/client";
import { entityLabel, entityOfLabel, type Entity, type Novel } from "@gh-writer/core";
import { useId } from "react";
import { Link } from "react-router";
import { useGitHubRepo } from "../github/repo.ts";
import { useIssueList } from "./use-issues.ts";

/** The labels an entry's issues carry: its label, and any of the repository's that stands for it (by ID, before a rename reaches GitHub). */
export function labelsOf(novel: Novel, entity: Entity, labels: readonly IssueLabel[]): Set<string> {
  return new Set([entityLabel(novel, entity).name, ...labels.filter((l) => entityOfLabel(novel, l)?.id === entity.id).map((l) => l.name)]);
}

/** A bible entry's open issues (those with its label, as label:… finds them on github.com), for a novel on GitHub. */
export function EntryIssues({ novelId, novel, entity }: { novelId: string; novel: Novel; entity: Entity }) {
  const repo = useGitHubRepo(novelId);
  const list = useIssueList(novelId, { state: "open" }, { enabled: !!repo });
  const headingId = useId();
  if (!repo) return null;
  const names = labelsOf(novel, entity, list.data?.labels ?? []);
  const issues = list.data?.issues.filter((i) => i.labels.some((l) => names.has(l))) ?? [];
  const label = entityLabel(novel, entity).name;
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h2 id={headingId} className="font-semibold">
        Open issues <span className="text-sm font-normal text-muted">{issues.length}</span>
      </h2>
      {issues.length ? (
        <ul className="grid gap-1 text-sm">
          {issues.map((i) => (
            <li key={i.number}>
              <Link to={`/novels/${novelId}/issues/${i.number}`} className="underline-offset-2 hover:underline">
                {i.title}
              </Link>{" "}
              <span className="text-muted">{i.number > 0 ? `#${i.number}` : "not on GitHub yet"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nothing open about {entity.name}.</p>
      )}
      <p className="text-sm text-muted">
        On GitHub it's the label <code>{label}</code>.{" "}
        <Link to={`/novels/${novelId}/issues?state=all&labels=${encodeURIComponent(label)}`} className="text-accent underline">
          All its issues
        </Link>
      </p>
    </section>
  );
}
