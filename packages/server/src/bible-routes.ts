import type { Context } from "hono";
import type { Hono } from "hono";
import { OperationError } from "./operations.ts";
import type { NovelWorkspace } from "./workspace.ts";

export type Env = { Variables: { ws: NovelWorkspace } };

const STATUS = { BAD_REQUEST: 400, NOT_FOUND: 404, STALE: 409, REFERENCED: 409, BLOCKED: 409 } as const;

/** Answer an operation's result, or its refusal with a code (and the references or path it's about). */
export async function operation(c: Context, run: () => Promise<object>, status: 200 | 201 = 200): Promise<Response> {
  try {
    return c.json(await run(), status);
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    return c.json({ code: e.code, error: e.message, ...e.details }, STATUS[e.code]);
  }
}

export async function body(c: Context): Promise<Record<string, unknown>> {
  const data: unknown = await c.req.json().catch(() => ({}));
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/**
 * POST  /:id/bible/entities                    { type, name, …fields, notes? } → 201 { id, file, commit }
 * PATCH /:id/bible/entities/:entity            { base, changes } → { file, commit }
 * POST  /:id/bible/entities/:entity/delete     { base, confirm? } → { commit }, or 409 REFERENCED { references }
 * POST  /:id/bible/relationships               { from, to, type, since?, until?, note? } → 201 { id, commit }
 * PATCH /:id/bible/relationships/:rel          { changes }
 * POST  /:id/bible/relationships/:rel/change   { at, type?, note? } → { id, commit }
 * POST  /:id/bible/relationships/:rel/end      { at }
 * POST  /:id/bible/relationships/:rel/delete
 * POST  /:id/bible/entity-types                { key, prefix, label, folder?, color? }
 * PATCH /:id/bible/entity-types/:key           { label?, color? }
 * POST  /:id/bible/relationship-types          { key, label, inverse_label?, symmetric?, from_types?, to_types? }
 * PATCH /:id/bible/relationship-types/:key     { …changes }
 * Refusals: 400 BAD_REQUEST, 404 NOT_FOUND, 409 STALE { path }, 409 REFERENCED { references }, 409 BLOCKED (no git identity).
 */
export function bibleRoutes(routes: Hono<Env>): void {
  const bible = (c: Context<Env>) => c.var.ws.bible;
  routes.post("/:id/bible/entities", async (c) => {
    const { type, notes, ...fields } = await body(c);
    return operation(c, () => bible(c).createEntity(String(type ?? ""), fields as never, typeof notes === "string" ? notes : ""), 201);
  });
  routes.patch("/:id/bible/entities/:entity", async (c) => {
    const { base, changes } = await body(c);
    return operation(c, () => bible(c).updateEntity(c.req.param("entity"), String(base ?? ""), (changes ?? {}) as never));
  });
  routes.post("/:id/bible/entities/:entity/delete", async (c) => {
    const { base, confirm } = await body(c);
    return operation(c, () => bible(c).deleteEntity(c.req.param("entity"), String(base ?? ""), confirm === true));
  });
  routes.post("/:id/bible/relationships", async (c) => operation(c, async () => bible(c).createRelationship((await body(c)) as never), 201));
  routes.patch("/:id/bible/relationships/:rel", async (c) => {
    const { changes } = await body(c);
    return operation(c, () => bible(c).updateRelationship(c.req.param("rel"), (changes ?? {}) as never));
  });
  routes.post("/:id/bible/relationships/:rel/change", async (c) => {
    const { at, ...changes } = await body(c);
    return operation(c, () => bible(c).changeRelationship(c.req.param("rel"), String(at ?? ""), changes as never));
  });
  routes.post("/:id/bible/relationships/:rel/end", async (c) => {
    const { at } = await body(c);
    return operation(c, () => bible(c).endRelationship(c.req.param("rel"), String(at ?? "")));
  });
  routes.post("/:id/bible/relationships/:rel/delete", async (c) => operation(c, () => bible(c).deleteRelationship(c.req.param("rel"))));
  routes.post("/:id/bible/entity-types", async (c) => operation(c, async () => bible(c).createEntityType((await body(c)) as never), 201));
  routes.patch("/:id/bible/entity-types/:key", async (c) => operation(c, async () => bible(c).updateEntityType(c.req.param("key"), (await body(c)) as never)));
  routes.post("/:id/bible/relationship-types", async (c) => operation(c, async () => bible(c).createRelationshipType((await body(c)) as never), 201));
  routes.patch("/:id/bible/relationship-types/:key", async (c) => operation(c, async () => bible(c).updateRelationshipType(c.req.param("key"), (await body(c)) as never)));
}
