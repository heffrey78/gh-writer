import { createApi } from "@gh-writer/client";
import { QueryClient } from "@tanstack/react-query";

/** The local server's API, on the page's own origin and session cookie. */
export const api = createApi();

export const queryClient = new QueryClient({
  defaultOptions: {
    // The server is local: failures are real, not flaky networks.
    queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

export const keys = {
  app: ["app"] as const,
  licenses: ["licenses"] as const,
  library: ["library"] as const,
  novel: (id: string) => ["novel", id] as const,
  sync: (id: string) => ["sync", id] as const,
  /** Everything about a novel's GitHub issues: refetched together when they change. */
  issues: (id: string) => ["issues", id] as const,
  /** The drafting board's status on GitHub. */
  board: (id: string) => ["board", id] as const,
  checkpoints: (id: string) => ["checkpoints", id] as const,
  versions: (id: string) => ["versions", id] as const,
  stats: (id: string) => ["stats", id] as const,
};
