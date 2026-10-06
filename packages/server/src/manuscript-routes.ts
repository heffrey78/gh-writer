import type { Context, Hono } from "hono";
import { body, operation, type Env } from "./bible-routes.ts";

/**
 * POST /:id/manuscript/scenes                { chapter, title, after? } → 201 { id, commit }
 * POST /:id/manuscript/chapters              { part, title?, after? } → 201 { id, commit }
 * POST /:id/manuscript/parts                 { title, after? } → 201 { id, commit }
 * POST /:id/manuscript/items/:item/rename    { title }
 * POST /:id/manuscript/items/:item/move      { to?, index }
 * POST /:id/manuscript/items/:item/delete
 * POST /:id/manuscript/scenes/:scene/split   { paragraph, title } → { id, commit }
 * POST /:id/manuscript/scenes/:scene/merge   (with the next scene)
 * GET  /:id/manuscript/deleted               { deleted }: recently deleted, newest first
 * POST /:id/manuscript/deleted/restore       { commit, id }
 */
export function manuscriptRoutes(routes: Hono<Env>): void {
  const m = (c: Context<Env>) => c.var.ws.manuscript;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const after = (b: Record<string, unknown>) => (b.after === undefined ? {} : { after: typeof b.after === "string" ? b.after : null });
  routes.post("/:id/manuscript/scenes", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).createScene(str(b.chapter), { title: str(b.title), ...after(b) }), 201);
  });
  routes.post("/:id/manuscript/chapters", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).createChapter(typeof b.part === "string" ? b.part : null, { title: str(b.title), ...after(b) }), 201);
  });
  routes.post("/:id/manuscript/parts", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).createPart({ title: str(b.title), ...after(b) }), 201);
  });
  routes.post("/:id/manuscript/items/:item/rename", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).rename(c.req.param("item"), str(b.title)));
  });
  routes.post("/:id/manuscript/items/:item/move", async (c) => {
    const b = await body(c);
    if (typeof b.index !== "number") return c.json({ code: "BAD_REQUEST", error: "Send { to?, index }." }, 400);
    const index = b.index;
    return operation(c, () => m(c).move(c.req.param("item"), { ...(b.to !== undefined ? { to: typeof b.to === "string" ? b.to : null } : {}), index }));
  });
  routes.post("/:id/manuscript/items/:item/delete", async (c) => operation(c, () => m(c).delete(c.req.param("item"))));
  routes.post("/:id/manuscript/scenes/:scene/split", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).split(c.req.param("scene"), { paragraph: Number(b.paragraph), title: str(b.title) }));
  });
  routes.post("/:id/manuscript/scenes/:scene/merge", async (c) => operation(c, () => m(c).merge(c.req.param("scene"))));
  routes.get("/:id/manuscript/deleted", async (c) => c.json({ deleted: await m(c).recentlyDeleted() }));
  routes.post("/:id/manuscript/deleted/restore", async (c) => {
    const b = await body(c);
    return operation(c, () => m(c).restore(str(b.commit), str(b.id)));
  });
}
