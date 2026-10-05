import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { FileError, MAX_FILE_BYTES } from "./files.ts";
import type { Library } from "./library.ts";
import type { NovelWorkspace, Workspaces } from "./workspace.ts";

const HEARTBEAT_MS = 25_000;

type NovelEnv = { Variables: { ws: NovelWorkspace } };

/**
 * GET /api/novels/:id               { novel, files }: the story model and the hash of each file it was read from
 * GET /api/novels/:id/files/<path>  { path, content, hash }
 * PUT /api/novels/:id/files/<path>  { content, base } → 200 { hash }, or 409 { current } when base is stale
 * GET /api/novels/:id/events        event stream: "ready", then a "file" event { type, path, hash } per outside change
 */
export function novelRoutes(library: Library, workspaces: Workspaces): Hono<NovelEnv> {
  const routes = new Hono<NovelEnv>();

  routes.use("/:id/*", async (c, next) => {
    const ws = workspaces.get(c.req.param("id")!);
    if (!ws) return c.json({ code: "UNKNOWN_NOVEL", error: "No such novel in the library." }, 404);
    c.set("ws", ws);
    await next();
  });

  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    const ws = workspaces.get(id);
    if (!ws) return c.json({ code: "UNKNOWN_NOVEL", error: "No such novel in the library." }, 404);
    await library.touch(id);
    return c.json(await ws.loadModel());
  });

  routes.get("/:id/files/*", async (c) => {
    try {
      const path = filePath(c);
      const file = await c.var.ws.read(path);
      return file ? c.json({ path, ...file }) : c.json({ code: "NOT_FOUND", error: `No file "${path}".` }, 404);
    } catch (e) {
      return fileFailure(c, e);
    }
  });

  routes.put(
    "/:id/files/*",
    // JSON escaping can double the size of the text.
    bodyLimit({ maxSize: MAX_FILE_BYTES * 2 + 1024, onError: (c) => c.json({ code: "TOO_LARGE", error: "The file is too large." }, 413) }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const { content, base } = (body ?? {}) as { content?: unknown; base?: unknown };
      if (typeof content !== "string" || (base !== null && typeof base !== "string")) {
        return c.json({ code: "BAD_REQUEST", error: "Send { content, base }: the text, and the hash it was based on (null for a new file)." }, 400);
      }
      try {
        const result = await c.var.ws.write(filePath(c), content, base);
        if (result.ok) return c.json({ hash: result.hash });
        return c.json(
          { code: "CONFLICT", error: "The file changed on disk since it was read. Nothing was written.", current: result.current ?? null },
          409,
        );
      } catch (e) {
        return fileFailure(c, e);
      }
    },
  );

  routes.get("/:id/events", (c) =>
    streamSSE(c, async (stream) => {
      const ws = c.var.ws;
      const aborted = new Promise<void>((resolve) => stream.onAbort(resolve));
      const unsubscribe = await ws.subscribe((e) => void stream.writeSSE({ event: "file", data: JSON.stringify(e) }));
      const heartbeat = setInterval(() => void stream.write(": ping\n\n"), HEARTBEAT_MS);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        await Promise.race([aborted, ws.closed]);
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }),
  );

  return routes;
}

/** The repository-relative path after /files/, percent-decoded. */
function filePath(c: Context): string {
  const raw = new URL(c.req.url).pathname;
  const encoded = raw.slice(raw.indexOf("/files/") + "/files/".length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new FileError("BAD_PATH", "The path isn't valid percent-encoding.");
  }
}

const STATUS = { BAD_PATH: 400, NOT_FOUND: 404, NOT_TEXT: 415, TOO_LARGE: 413, NOT_WRITABLE: 400 } as const;

function fileFailure(c: Context, e: unknown): Response {
  if (!(e instanceof FileError)) throw e;
  return c.json({ code: e.code, error: e.message }, STATUS[e.code]);
}
