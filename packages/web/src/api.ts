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
  library: ["library"] as const,
  novel: (id: string) => ["novel", id] as const,
};
