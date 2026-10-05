import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { classifyGitError, GitFailure } from "./git.ts";
import { LibraryError, type Library } from "./library.ts";

/**
 * GET    /api/library        { novels, notices }
 * POST   /api/library        { path } → 201 { novel }
 * DELETE /api/library/:id    forget a novel (its folder stays) → 204
 * POST   /api/library/clone  { repo, path? } → an event stream: "progress"…, then "done" { novel } or "error"
 */
export function libraryRoutes(library: Library): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => c.json({ novels: await library.list(), notices: library.notices }));

  routes.post("/", async (c) => {
    const body = await jsonBody(c);
    if (typeof body?.path !== "string" || !body.path) return c.json({ code: "BAD_REQUEST", error: "Send { path }: the novel's folder." }, 400);
    try {
      return c.json({ novel: await library.add(body.path) }, 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.delete("/:id", async (c) => (await library.remove(c.req.param("id")) ? c.body(null, 204) : c.json({ code: "UNKNOWN_NOVEL", error: "No such novel." }, 404)));

  routes.post("/clone", async (c) => {
    const body = await jsonBody(c);
    if (typeof body?.repo !== "string" || !body.repo || (body.path !== undefined && typeof body.path !== "string")) {
      return c.json({ code: "BAD_REQUEST", error: "Send { repo, path? }: owner/name or a URL, and optionally the folder to clone into." }, 400);
    }
    const { repo, path } = body as { repo: string; path?: string };
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      let last = "";
      try {
        const novel = await library.clone(repo, {
          ...(path ? { into: path } : {}),
          signal: abort.signal,
          onProgress: ({ stage, progress, processed, total }) => {
            // git repeats lines while it works: send only what changed.
            const key = `${stage}:${progress}`;
            if (key === last) return;
            last = key;
            void stream.writeSSE({ event: "progress", data: JSON.stringify({ stage, progress, processed, total }) });
          },
        });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ novel }) });
      } catch (e) {
        const { code, error, detail } = describe(e);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ code, error, ...(detail ? { detail } : {}) }) });
      }
    });
  });

  return routes;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
}

function describe(e: unknown): { code: string; error: string; detail?: string } {
  if (e instanceof LibraryError) return { code: e.code, error: e.message };
  const failure = e instanceof GitFailure ? e : classifyGitError(e);
  return { code: failure.code, error: failure.message, ...(failure.detail ? { detail: failure.detail } : {}) };
}

function failure(c: Context, e: unknown): Response {
  if (!(e instanceof LibraryError) && !(e instanceof GitFailure)) throw e;
  return c.json(describe(e), e instanceof LibraryError && e.code === "UNKNOWN_NOVEL" ? 404 : 400);
}
