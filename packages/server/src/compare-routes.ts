import { loadNovel, type Novel } from "@gh-writer/core";
import { compareNovels, compareProse } from "@gh-writer/core/compare";
import type { Hono } from "hono";
import type { Env } from "./bible-routes.ts";
import { CheckpointError } from "./checkpoints.ts";
import { commitSource } from "./git-source.ts";
import type { NovelWorkspace } from "./workspace.ts";

/*
 * Comparing two states of the novel (#17):
 * GET /:id/compare?from=&to=                    { comparison }: chapters and scenes, bible, relationships, events
 * GET /:id/compare/scene/:sceneId?from=&to=     { paragraphs }: the scene's text, word by word where reworded
 * Each side is "now" (what's saved), "version:<id>" (a version as last committed) or "checkpoint:<id>".
 * Refusals: 400 BAD_REQUEST (a side missing or malformed), 404 NOT_FOUND (no such version or checkpoint).
 */

class SideError extends Error {}

async function side(ws: NovelWorkspace, ref: string | undefined): Promise<Novel> {
  if (!ref) throw new SideError("Say what to compare: from and to, each now, version:<id> or checkpoint:<id>.");
  if (ref === "now") return (await ws.loadModel()).novel;
  const colon = ref.indexOf(":");
  const [kind, id] = [ref.slice(0, colon), ref.slice(colon + 1)];
  let commit: string | undefined;
  if (kind === "version") commit = (await ws.versions.list()).find((v) => v.id === id)?.commit;
  else if (kind === "checkpoint") commit = await ws.checkpoints.get(id).then((c) => c.commit, (e: unknown) => (e instanceof CheckpointError ? undefined : Promise.reject(e)));
  else throw new SideError(`“${ref}” isn't something to compare: use now, version:<id> or checkpoint:<id>.`);
  if (!commit) throw Object.assign(new SideError(`There's no ${kind} “${id}”.`), { notFound: true });
  return loadNovel(await commitSource(ws.root, commit));
}

export function compareRoutes(routes: Hono<Env>): void {
  routes.get("/:id/compare", async (c) => {
    try {
      const [before, after] = [await side(c.var.ws, c.req.query("from")), await side(c.var.ws, c.req.query("to"))];
      return c.json({ comparison: compareNovels(before, after) });
    } catch (e) {
      if (!(e instanceof SideError)) throw e;
      return "notFound" in e ? c.json({ code: "NOT_FOUND", error: e.message }, 404) : c.json({ code: "BAD_REQUEST", error: e.message }, 400);
    }
  });

  routes.get("/:id/compare/scene/:sceneId", async (c) => {
    try {
      const [before, after] = [await side(c.var.ws, c.req.query("from")), await side(c.var.ws, c.req.query("to"))];
      const id = c.req.param("sceneId");
      const [a, b] = [before.allScenes.find((s) => s.id === id), after.allScenes.find((s) => s.id === id)];
      if (!a && !b) return c.json({ code: "NOT_FOUND", error: `Neither side has the scene “${id}”.` }, 404);
      return c.json({ paragraphs: compareProse(a?.body, b?.body) });
    } catch (e) {
      if (!(e instanceof SideError)) throw e;
      return "notFound" in e ? c.json({ code: "NOT_FOUND", error: e.message }, 404) : c.json({ code: "BAD_REQUEST", error: e.message }, 400);
    }
  });
}
