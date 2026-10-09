import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { body, type Env } from "./bible-routes.ts";
import { CheckpointError } from "./checkpoints.ts";
import { ConflictError, parseResolutions } from "./conflicts.ts";
import { MAX_FILE_BYTES } from "./files.ts";
import { VersionError } from "./versions.ts";

/*
 * Alternate versions (#17, D7):
 * GET    /:id/versions                    { versions }: the main version first
 * POST   /:id/versions                    { name, from? } → 201 { version }: started from the open one (or checkpoint
 *                                          `from`, to bring a discarded version back), and opened
 * POST   /:id/versions/:version/switch    → { version }: opened
 * DELETE /:id/versions/:version           → { checkpoint, current }: kept as an automatic checkpoint, then gone
 * POST   /:id/versions/:version/adopt     → { checkpoint, commit, conflicts? }: merged into the main version (opened)
 * GET    /:id/versions/:version/adopt/conflicts  { conflicts }: what adopting it leaves to settle, or null
 * POST   /:id/versions/:version/adopt/resolve    { upstream, files } → { commit }, or 409 STALE { conflicts }
 * POST   /:id/versions/:version/scenes/:sceneId/bring  → { undo, commit, files }: the scene from that version, into the open one
 * Refusals: 400 BAD_NAME, MAIN (the main version can't be discarded or adopted), OPEN (that version is
 * open), NOT_HERE (the scene's chapter isn't in the open version), BAD_RESOLUTION; 404 NOT_FOUND;
 * 409 BLOCKED (saved work couldn't be committed), BUSY, STALE.
 */

const STATUS = { BAD_NAME: 400, MAIN: 400, OPEN: 400, NOT_HERE: 400, NOT_FOUND: 404, BLOCKED: 409, BUSY: 409 } as const;

function failure(c: Context, e: unknown): Response {
  if (e instanceof VersionError) return c.json({ code: e.code, error: e.message }, STATUS[e.code]);
  if (e instanceof CheckpointError && e.code === "BLOCKED") return c.json({ code: e.code, error: e.message }, 409);
  if (e instanceof CheckpointError && e.code === "NOT_FOUND") return c.json({ code: e.code, error: e.message }, 404);
  if (e instanceof ConflictError) return c.json({ code: e.code, error: e.message }, e.code === "BAD_RESOLUTION" ? 400 : 409);
  throw e;
}

export function versionRoutes(routes: Hono<Env>): void {
  routes.get("/:id/versions", async (c) => c.json({ versions: await c.var.ws.versions.list() }));

  routes.post("/:id/versions", async (c) => {
    const { name, from } = await body(c);
    if (typeof name !== "string" || (from !== undefined && typeof from !== "string")) return c.json({ code: "BAD_REQUEST", error: "Send { name, from? }: what to call the version, and a checkpoint to start it from." }, 400);
    try {
      return c.json({ version: await c.var.ws.versions.start(name, from === undefined ? {} : { from }) }, 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.post("/:id/versions/:version/switch", async (c) => {
    try {
      return c.json({ version: await c.var.ws.versions.switch(c.req.param("version")) });
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.post("/:id/versions/:version/adopt", async (c) => {
    try {
      return c.json(await c.var.ws.versions.adopt(c.req.param("version")));
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.get("/:id/versions/:version/adopt/conflicts", async (c) => {
    try {
      return c.json({ conflicts: await c.var.ws.versions.adoptionConflicts(c.req.param("version")) });
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.post(
    "/:id/versions/:version/adopt/resolve",
    bodyLimit({ maxSize: 16 * MAX_FILE_BYTES, onError: (c) => c.json({ code: "TOO_LARGE", error: "The resolution is too large." }, 413) }),
    async (c) => {
      const raw = await body(c);
      const files = parseResolutions(raw.files);
      if (typeof raw.upstream !== "string" || !files) return c.json({ code: "BAD_REQUEST", error: "Send { upstream, files }, as for sync conflicts." }, 400);
      const versions = c.var.ws.versions;
      const id = c.req.param("version");
      try {
        return c.json(await versions.resolveAdoption(id, raw.upstream, files));
      } catch (e) {
        if (e instanceof ConflictError && e.code === "STALE") return c.json({ code: e.code, error: e.message, conflicts: await versions.adoptionConflicts(id).catch(() => null) }, 409);
        return failure(c, e);
      }
    },
  );

  routes.post("/:id/versions/:version/scenes/:sceneId/bring", async (c) => {
    try {
      return c.json(await c.var.ws.versions.bringScene(c.req.param("version"), c.req.param("sceneId")));
    } catch (e) {
      return failure(c, e);
    }
  });

  routes.delete("/:id/versions/:version", async (c) => {
    try {
      return c.json(await c.var.ws.versions.discard(c.req.param("version")));
    } catch (e) {
      return failure(c, e);
    }
  });
}
