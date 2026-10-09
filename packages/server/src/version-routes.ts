import type { Context, Hono } from "hono";
import { body, type Env } from "./bible-routes.ts";
import { CheckpointError } from "./checkpoints.ts";
import { VersionError } from "./versions.ts";

/*
 * Alternate versions (#17, D7):
 * GET    /:id/versions                    { versions }: the main version first
 * POST   /:id/versions                    { name } → 201 { version }: started from the open one, and opened
 * POST   /:id/versions/:version/switch    → { version }: opened
 * DELETE /:id/versions/:version           → { checkpoint, current }: kept as an automatic checkpoint, then gone
 * Refusals: 400 BAD_NAME, MAIN (the main version can't be discarded); 404 NOT_FOUND; 409 BLOCKED (saved
 * work couldn't be committed), BUSY.
 */

const STATUS = { BAD_NAME: 400, MAIN: 400, NOT_FOUND: 404, BLOCKED: 409, BUSY: 409 } as const;

function failure(c: Context, e: unknown): Response {
  if (e instanceof VersionError) return c.json({ code: e.code, error: e.message }, STATUS[e.code]);
  if (e instanceof CheckpointError && e.code === "BLOCKED") return c.json({ code: e.code, error: e.message }, 409);
  throw e;
}

export function versionRoutes(routes: Hono<Env>): void {
  routes.get("/:id/versions", async (c) => c.json({ versions: await c.var.ws.versions.list() }));

  routes.post("/:id/versions", async (c) => {
    const { name } = await body(c);
    if (typeof name !== "string") return c.json({ code: "BAD_REQUEST", error: "Send { name }: what to call the version." }, 400);
    try {
      return c.json({ version: await c.var.ws.versions.start(name) }, 201);
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

  routes.delete("/:id/versions/:version", async (c) => {
    try {
      return c.json(await c.var.ws.versions.discard(c.req.param("version")));
    } catch (e) {
      return failure(c, e);
    }
  });
}
