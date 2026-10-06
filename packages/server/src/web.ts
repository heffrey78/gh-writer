import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Hono, type Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".aff": "text/plain; charset=utf-8",
  ".dic": "text/plain; charset=utf-8",
};

/**
 * The page may load only what the server itself serves. Styles allow inline attributes (React's
 * style prop); the spell checker runs in a worker from the same origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * The built web app (packages/web/dist): hashed files under /assets/ cached for good, other files at
 * the top as they are, and index.html for every other path outside /api, where the app routes itself.
 */
export function webRoutes(dir: string): Hono {
  const routes = new Hono();
  const index = join(dir, "index.html");

  routes.get("*", async (c) => {
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/")) return c.json({ code: "NOT_FOUND", error: "No such endpoint." }, 404);
    c.header("X-Content-Type-Options", "nosniff");
    const file = inside(dir, path);
    if (file && path !== "/" && path !== "/index.html") {
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) {
        c.header("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        c.header("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        return c.body(new Uint8Array(await readFile(file)));
      }
      // A missing build file is an error, not a page of the app.
      if (path.startsWith("/assets/") || extname(path)) return c.text("Not found", 404);
    }
    return page(c, index);
  });

  return routes;
}

async function page(c: Context, index: string): Promise<Response> {
  const html = await readFile(index, "utf8");
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("Cache-Control", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html);
}

/** The file for a URL path, or undefined if the path would leave `dir`. */
function inside(dir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const full = normalize(join(dir, decoded));
  return full === dir || full.startsWith(dir.endsWith(sep) ? dir : dir + sep) ? full : undefined;
}
