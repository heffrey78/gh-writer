import { readFile } from "node:fs/promises";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { body, operation, type Env } from "./bible-routes.ts";
import { FileError, IMAGES_DIR, MAX_IMAGE_BYTES, servableImage } from "./files.ts";
import type { Library } from "./library.ts";

/*
 * Pictures (#168, #203): the bible's portraits, the book's cover and the prose's pictures, in images/.
 *
 * GET  /:id/images/<path>                         the image at images/<path>, with its media type; ETag, revalidated each time
 * PUT  /:id/bible/entities/:entity/picture?base=&focus=x,y   the image's bytes (JPEG or PNG) → { file, image, commit }
 * POST /:id/bible/entities/:entity/picture/delete  { base } → { file, commit }
 * PUT  /:id/cover                                 the image's bytes → { cover, commit }
 * POST /:id/cover/delete                          → { commit }
 * PUT  /:id/images?name=                          a picture for the prose (#203): the bytes → { path }, images/<name>.jpg or .png
 *
 * Uploads are refused over GitHub's 100 MB limit before they're read (413 TOO_LARGE), and anything but
 * JPEG or PNG bytes is 400 BAD_REQUEST. The app resizes pictures before sending them.
 */
export function imageRoutes(routes: Hono<Env>, library: Library): void {
  routes.get("/:id/images/*", async (c) => {
    const raw = new URL(c.req.url).pathname;
    let path: string;
    try {
      path = `${IMAGES_DIR}/${decodeURIComponent(raw.slice(raw.indexOf("/images/") + "/images/".length))}`;
    } catch {
      return c.json({ code: "BAD_PATH", error: "The path isn't valid percent-encoding." }, 400);
    }
    try {
      const image = await servableImage(c.var.ws.root, path);
      if (!image) return c.json({ code: "NOT_FOUND", error: `No image "${path}".` }, 404);
      const etag = `"${image.size.toString(36)}-${Math.round(image.mtimeMs).toString(36)}"`;
      const headers = { etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" };
      if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(await readFile(image.full), { headers: { ...headers, "content-type": image.type, "content-length": String(image.size) } });
    } catch (e) {
      if (!(e instanceof FileError)) throw e;
      return c.json({ code: e.code, error: e.message }, e.code === "TOO_LARGE" ? 413 : 400);
    }
  });

  const upload = bodyLimit({
    maxSize: MAX_IMAGE_BYTES,
    onError: (c) => c.json({ code: "TOO_LARGE", error: "The image is larger than GitHub's 100 MB limit, so it can't be kept in the novel." }, 413),
  });

  routes.put("/:id/bible/entities/:entity/picture", upload, async (c) => {
    const focus = parseFocus(c.req.query("focus"));
    if (focus === null) return c.json({ code: "BAD_REQUEST", error: "focus is x,y: two fractions from 0 to 1." }, 400);
    const bytes = await bytesOf(c);
    return operation(c, () => c.var.ws.bible.setPicture(c.req.param("entity"), c.req.query("base") ?? "", bytes, focus));
  });
  routes.post("/:id/bible/entities/:entity/picture/delete", async (c) => {
    const { base } = await body(c);
    return operation(c, () => c.var.ws.bible.removePicture(c.req.param("entity"), String(base ?? "")));
  });

  // Not committed on its own: the scene naming it is saved next, and the two are committed together.
  routes.put("/:id/images", upload, async (c) => {
    const bytes = await bytesOf(c);
    try {
      return c.json(await c.var.ws.addPicture(c.req.query("name") ?? "", bytes));
    } catch (e) {
      if (!(e instanceof FileError)) throw e;
      return c.json({ code: e.code === "TOO_LARGE" ? e.code : "BAD_REQUEST", error: e.message }, e.code === "TOO_LARGE" ? 413 : 400);
    }
  });

  // The library shelf shows the cover: its entry is read again after each change.
  routes.put("/:id/cover", upload, async (c) => {
    const bytes = await bytesOf(c);
    return operation(c, async () => {
      const result = await c.var.ws.bible.setCover(bytes);
      await library.refresh(c.req.param("id"));
      return result;
    });
  });
  routes.post("/:id/cover/delete", async (c) =>
    operation(c, async () => {
      const result = await c.var.ws.bible.removeCover();
      await library.refresh(c.req.param("id"));
      return result;
    }),
  );
}

async function bytesOf(c: Context): Promise<Uint8Array> {
  return new Uint8Array(await c.req.arrayBuffer());
}

/** "0.5,0.3" → [0.5, 0.3]; none → undefined; anything else → null. */
function parseFocus(text: string | undefined): [number, number] | undefined | null {
  if (text === undefined || text === "") return undefined;
  const parts = text.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  return parts.length === 2 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ? [parts[0]!, parts[1]!] : null;
}
