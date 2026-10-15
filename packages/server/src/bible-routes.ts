import type { Context } from "hono";
import type { Hono } from "hono";
import { OperationError } from "./operations.ts";
import type { NovelWorkspace } from "./workspace.ts";

export type Env = { Variables: { ws: NovelWorkspace } };

const STATUS = { BAD_REQUEST: 400, NOT_FOUND: 404, STALE: 409, REFERENCED: 409, BLOCKED: 409, NEEDS_MIGRATION: 409, NOTES_LEFT: 409 } as const;

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
 * POST  /:id/bible/entities                    { type, name, …fields, notes?, id? } → 201 { id, file, commit }
 * PATCH /:id/bible/entities/:entity            { base, changes } → { file, commit }
 * POST  /:id/bible/entities/:entity/delete     { base, confirm? } → { commit }, or 409 REFERENCED { references }
 * POST  /:id/bible/relationships               { from, to, type, since?, until?, note? } → 201 { id, commit }
 * PATCH /:id/bible/relationships/:rel          { changes }
 * POST  /:id/bible/relationships/:rel/change   { at, type?, note? } → { id, commit }
 * POST  /:id/bible/relationships/:rel/end      { at }
 * POST  /:id/bible/relationships/:rel/delete
 * POST  /:id/bible/events                      { title, when?, duration?, characters?, locations?, plotlines?, scene?, note?, migrate? } → 201 { id, file, commit }
 * PATCH /:id/bible/events/:event               { changes, base?, migrate? } (null removes a field; note replaces the prose) → { file, commit }
 * POST  /:id/bible/events/:event/delete        { base?, confirm?, migrate? }
 *       (each: a novel in format v1 is 409 NEEDS_MIGRATION { from, to } unless migrate, which moves it to v2 in the same commit)
 * POST  /:id/bible/events/:event/scene         { chapter, keep, migrate? } → 201 { scene, file }: written as a scene at the chapter's end; kept (naming it) or removed
 * POST  /:id/notes                              { title, tags?, scenes?, note? } → 201 { id, file }: a writer's note (D12)
 * PATCH /:id/notes/:note                       { changes: { title?, tags?, scenes?, note? }, base? } → { file }
 * POST  /:id/notes/:note/pin                   { scene, pinned }: pinned to the top of the scene's notes (its other unpinned), or not
 * POST  /:id/notes/:note/delete                { base? }
 * POST  /:id/notes/:note/promote               { to: "event" | "scene", chapter?, keep, migrate? } → 201 { id, file }: what it became
 * POST  /:id/migrate                           → { migrated, commit }: the novel in the newest format, one commit (D11)
 * POST  /:id/bible/entity-types                { key, prefix, label, folder?, color? }
 * PATCH /:id/bible/entity-types/:key           { label?, color? }
 * POST  /:id/bible/relationship-types          { key, label, inverse_label?, symmetric?, from_types?, to_types? }
 * PATCH /:id/bible/relationship-types/:key     { …changes }
 * Refusals: 400 BAD_REQUEST, 404 NOT_FOUND, 409 STALE { path }, 409 REFERENCED { references }, 409 BLOCKED (no git identity), 409 NEEDS_MIGRATION.
 */
export function bibleRoutes(routes: Hono<Env>): void {
  const bible = (c: Context<Env>) => c.var.ws.bible;
  routes.post("/:id/bible/entities", async (c) => {
    const { type, notes, id, ...fields } = await body(c);
    return operation(c, () => bible(c).createEntity(String(type ?? ""), fields as never, typeof notes === "string" ? notes : "", id === undefined ? undefined : String(id)), 201);
  });
  routes.patch("/:id/bible/entities/:entity", async (c) => {
    const { base, changes } = await body(c);
    return operation(c, async () => {
      const result = await bible(c).updateEntity(c.req.param("entity"), String(base ?? ""), (changes ?? {}) as never);
      // A new name: its GitHub label follows (#10).
      if ((changes as { name?: unknown } | undefined)?.name !== undefined) void c.var.ws.issues?.refresh().catch(() => {});
      return result;
    });
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
  routes.post("/:id/bible/events", async (c) => {
    const { migrate, ...fields } = await body(c);
    return operation(c, () => bible(c).createEvent(fields as never, migrate === true), 201);
  });
  routes.patch("/:id/bible/events/:event", async (c) => {
    const { changes, base, migrate } = await body(c);
    return operation(c, () => bible(c).updateEvent(c.req.param("event"), (changes ?? {}) as never, { ...(typeof base === "string" ? { base } : {}), migrate: migrate === true }));
  });
  routes.post("/:id/bible/events/:event/delete", async (c) => {
    const { base, confirm, migrate } = await body(c);
    return operation(c, () => bible(c).deleteEvent(c.req.param("event"), { ...(typeof base === "string" ? { base } : {}), confirm: confirm === true, migrate: migrate === true }));
  });
  routes.post("/:id/bible/events/:event/scene", async (c) => {
    const { chapter, keep, migrate } = await body(c);
    return operation(c, () => bible(c).writeAsScene(c.req.param("event"), { chapter: String(chapter ?? ""), keep: keep === true, migrate: migrate === true }, c.var.ws.manuscript), 201);
  });
  routes.post("/:id/notes", async (c) => operation(c, async () => bible(c).createNote((await body(c)) as never), 201));
  routes.patch("/:id/notes/:note", async (c) => {
    const { changes, base } = await body(c);
    return operation(c, () => bible(c).updateNote(c.req.param("note"), (changes ?? {}) as never, typeof base === "string" ? { base } : {}));
  });
  routes.post("/:id/notes/:note/pin", async (c) => {
    const { scene, pinned } = await body(c);
    return operation(c, () => bible(c).pinNote(c.req.param("note"), String(scene ?? ""), pinned !== false));
  });
  routes.post("/:id/notes/:note/delete", async (c) => {
    const { base } = await body(c);
    return operation(c, () => bible(c).deleteNote(c.req.param("note"), typeof base === "string" ? { base } : {}));
  });
  routes.post("/:id/notes/:note/promote", async (c) => {
    const { to, chapter, keep, migrate } = await body(c);
    const target = to === "scene" ? { to: "scene" as const, chapter: String(chapter ?? "") } : { to: "event" as const };
    return operation(c, () => bible(c).promoteNote(c.req.param("note"), target, { keep: keep === true, migrate: migrate === true }, c.var.ws.manuscript), 201);
  });
  routes.post("/:id/migrate", async (c) => operation(c, () => bible(c).migrate()));
  routes.post("/:id/bible/relationships/:rel/delete", async (c) => operation(c, () => bible(c).deleteRelationship(c.req.param("rel"))));
  routes.post("/:id/bible/entity-types", async (c) => operation(c, async () => bible(c).createEntityType((await body(c)) as never), 201));
  routes.patch("/:id/bible/entity-types/:key", async (c) => operation(c, async () => bible(c).updateEntityType(c.req.param("key"), (await body(c)) as never)));
  routes.post("/:id/bible/relationship-types", async (c) => operation(c, async () => bible(c).createRelationshipType((await body(c)) as never), 201));
  routes.patch("/:id/bible/relationship-types/:key", async (c) => operation(c, async () => bible(c).updateRelationshipType(c.req.param("key"), (await body(c)) as never)));
}
