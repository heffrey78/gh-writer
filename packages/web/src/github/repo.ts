import type { GitHubRepo } from "@gh-writer/client";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "../api.ts";

/**
 * The GitHub repository the novel is on, or null for a local-only novel. GitHub work tracking (issues,
 * notes on passages) shows only when there is one: everything it adds goes behind this. It follows the
 * sync status, which the novel's event stream keeps current, so putting a novel on GitHub turns it on
 * in the same session.
 */
export function useGitHubRepo(novelId: string): GitHubRepo | null | undefined {
  const sync = useQuery({ queryKey: keys.sync(novelId), queryFn: () => api.sync(novelId) });
  // Undefined until the status is known: a page shouldn't send the author away while it loads.
  return sync.data ? (sync.data.github ?? null) : undefined;
}
