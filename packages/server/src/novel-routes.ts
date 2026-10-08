import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { bibleRoutes } from "./bible-routes.ts";
import { diagramRoutes } from "./diagrams.ts";
import { manuscriptRoutes } from "./manuscript-routes.ts";
import { CheckpointError } from "./checkpoints.ts";
import { ConflictError, type FileResolution } from "./conflicts.ts";
import { FileError, MAX_FILE_BYTES } from "./files.ts";
import { GitHubError, unreachable, type GitHub } from "./github.ts";
import type { Library } from "./library.ts";
import { publish, PublishError } from "./publish.ts";
import type { NovelWorkspace, Workspaces } from "./workspace.ts";

const HEARTBEAT_MS = 25_000;

type NovelEnv = { Variables: { ws: NovelWorkspace } };

/**
 * GET /api/novels/:id               { novel, files }: the story model and the hash of each file it was read from
 * GET /api/novels/:id/files/<path>  { path, content, hash }
 * PUT /api/novels/:id/files/<path>  { content, base } → 200 { hash }, or 409 { current } when base is stale
 * GET /api/novels/:id/events        event stream: "ready", the sync status, then a "file" event { type, path, hash } per outside change
 *                                   and a "sync" event (the status) whenever it changes
 * GET /api/novels/:id/sync          sync status: { state, remote, branch, ahead, behind, lastSync, conflict?, error?, commit }
 * POST /api/novels/:id/sync         sync now; the status once it's done
 * POST /api/novels/:id/publish      { name, description?, private? } → { remote, status }: a new GitHub repository, pushed to
 * GET /api/novels/:id/checkpoints   { checkpoints }, newest first
 * POST /api/novels/:id/checkpoints  { name } → 201 { checkpoint }
 * POST /api/novels/:id/checkpoints/:checkpoint/restore  { sceneId? } → { undo, commit, files }
 * GET /api/novels/:id/conflicts     { conflicts }: what a sync conflict leaves to settle, or null
 * POST /api/novels/:id/conflicts/resolve  { upstream, files: { <path>: resolution } } → the sync status,
 *                                   or 409 STALE { conflicts } when they changed since they were read
 */
export function novelRoutes(library: Library, workspaces: Workspaces, github?: GitHub): Hono<NovelEnv> {
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

  routes.get("/:id/sync", async (c) => c.json(await c.var.ws.syncStatus()));
  routes.post("/:id/sync", async (c) => {
    await c.var.ws.syncer?.sync();
    return c.json(await c.var.ws.syncStatus());
  });

  routes.post("/:id/publish", async (c) => {
    if (!github) return c.json({ code: "NO_SIGN_IN", error: "This server has no GitHub connection." }, 400);
    const body = (await c.req.json().catch(() => undefined)) as { name?: unknown; description?: unknown; private?: unknown } | undefined;
    if (typeof body?.name !== "string" || (body.description !== undefined && typeof body.description !== "string") || (body.private !== undefined && typeof body.private !== "boolean")) {
      return c.json({ code: "BAD_REQUEST", error: "Send { name, description?, private? }." }, 400);
    }
    try {
      const { remote } = await publish(c.var.ws, github, {
        name: body.name.trim(),
        ...(typeof body.description === "string" && body.description.trim() ? { description: body.description.trim() } : {}),
        ...(typeof body.private === "boolean" ? { private: body.private } : {}),
      });
      // The library shows where the novel lives now.
      await library.add(c.var.ws.root);
      return c.json({ remote, status: await c.var.ws.syncStatus() });
    } catch (e) {
      if (e instanceof PublishError || e instanceof GitHubError) {
        const detail = e instanceof PublishError ? e.detail : undefined;
        return c.json({ code: e.code, error: e.message, ...(detail ? { detail } : {}) }, e instanceof GitHubError && e.code === "GITHUB" ? 502 : 400);
      }
      if (!unreachable(e)) throw e;
      return c.json({ code: "NETWORK", error: "Couldn't reach GitHub. Check your connection and try again." }, 502);
    }
  });

  routes.get("/:id/checkpoints", async (c) => c.json({ checkpoints: await c.var.ws.checkpoints.list() }));

  routes.post("/:id/checkpoints", async (c) => {
    const { name } = ((await c.req.json().catch(() => undefined)) ?? {}) as { name?: unknown };
    if (typeof name !== "string") return c.json({ code: "BAD_REQUEST", error: "Send { name }: what to call the checkpoint." }, 400);
    try {
      return c.json({ checkpoint: await c.var.ws.checkpoints.create(name) }, 201);
    } catch (e) {
      return checkpointFailure(c, e);
    }
  });

  routes.post("/:id/checkpoints/:checkpoint/restore", async (c) => {
    const { sceneId } = ((await c.req.json().catch(() => undefined)) ?? {}) as { sceneId?: unknown };
    if (sceneId !== undefined && typeof sceneId !== "string") return c.json({ code: "BAD_REQUEST", error: "sceneId must be a scene ID." }, 400);
    try {
      return c.json(await c.var.ws.checkpoints.restore(c.req.param("checkpoint"), sceneId === undefined ? {} : { sceneId }));
    } catch (e) {
      return checkpointFailure(c, e);
    }
  });

  routes.get("/:id/conflicts", async (c) => c.json({ conflicts: (await c.var.ws.syncer?.conflicts()) ?? null }));

  routes.post(
    "/:id/conflicts/resolve",
    bodyLimit({ maxSize: 16 * MAX_FILE_BYTES, onError: (c) => c.json({ code: "TOO_LARGE", error: "The resolution is too large." }, 413) }),
    async (c) => {
      const body = ((await c.req.json().catch(() => undefined)) ?? {}) as { upstream?: unknown; files?: unknown };
      const files = parseResolutions(body.files);
      if (typeof body.upstream !== "string" || !files) {
        return c.json(
          { code: "BAD_REQUEST", error: "Send { upstream, files }: the conflicts' upstream, and for each file { ours, content } (null deletes it) or { ours, keep: \"ours\" | \"theirs\" }." },
          400,
        );
      }
      const syncer = c.var.ws.syncer;
      try {
        if (!syncer) throw new ConflictError("NO_CONFLICT", "Sync is off.");
        await syncer.resolve(body.upstream, files);
        return c.json(await c.var.ws.syncStatus());
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        if (e.code === "BAD_RESOLUTION") return c.json({ code: e.code, error: e.message }, 400);
        return c.json({ code: e.code, error: e.message, conflicts: (await syncer?.conflicts()) ?? null }, 409);
      }
    },
  );

  bibleRoutes(routes);
  diagramRoutes(routes);
  manuscriptRoutes(routes);

  routes.get("/:id/events", (c) =>
    streamSSE(c, async (stream) => {
      const ws = c.var.ws;
      const aborted = new Promise<void>((resolve) => stream.onAbort(resolve));
      const unsubscribe = await ws.subscribe((e) => void stream.writeSSE({ event: "file", data: JSON.stringify(e) }));
      // Status reads are git calls: run them one after another, and skip ones overtaken by a newer change.
      let reading: Promise<void> = Promise.resolve();
      let changes = 0;
      const sendSync = () => {
        const n = ++changes;
        reading = reading.then(async () => {
          if (n !== changes) return;
          const status = await ws.syncStatus().catch(() => undefined);
          if (status) await stream.writeSSE({ event: "sync", data: JSON.stringify(status) });
        });
      };
      const offSync = ws.onSyncChange(sendSync);
      const heartbeat = setInterval(() => void stream.write(": ping\n\n"), HEARTBEAT_MS);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        sendSync();
        await Promise.race([aborted, ws.stopped]);
      } finally {
        clearInterval(heartbeat);
        offSync();
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

function parseResolutions(value: unknown): Record<string, FileResolution> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, FileResolution> = {};
  for (const [path, r] of Object.entries(value as Record<string, unknown>)) {
    if (!r || typeof r !== "object") return undefined;
    const { ours, content, keep } = r as { ours?: unknown; content?: unknown; keep?: unknown };
    if (ours !== null && typeof ours !== "string") return undefined;
    if (keep === "ours" || keep === "theirs") out[path] = { ours, keep };
    else if (content === null || (typeof content === "string" && content.isWellFormed())) out[path] = { ours, content };
    else return undefined;
  }
  return out;
}

const CHECKPOINT_STATUS = { BAD_NAME: 400, NOT_FOUND: 404, SCENE_NOT_FOUND: 404, BLOCKED: 409 } as const;

function checkpointFailure(c: Context, e: unknown): Response {
  if (!(e instanceof CheckpointError)) throw e;
  return c.json({ code: e.code, error: e.message }, CHECKPOINT_STATUS[e.code]);
}

function fileFailure(c: Context, e: unknown): Response {
  if (!(e instanceof FileError)) throw e;
  return c.json({ code: e.code, error: e.message }, STATUS[e.code]);
}
