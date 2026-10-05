import { Hono } from "hono";
import { libraryRoutes } from "./library-routes.ts";
import type { Library } from "./library.ts";
import { hasSession, security } from "./security.ts";

export interface AppOptions {
  token: string;
  /** The listening port, read per request. */
  port: () => number;
  library: Library;
}

/** The API, behind the security middleware. Routes added later go through it too. */
export function createApp({ token, port, library }: AppOptions): Hono {
  const app = new Hono();
  app.use(security({ token, port, publicPaths: new Set(["/api/session"]) }));

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/session", (c) => c.json({ authenticated: hasSession(c, token, port()) }));
  app.route("/api/library", libraryRoutes(library));

  // Until the web app is served (#7), the launch URL lands here.
  const placeholder = (title: string) =>
    `<!doctype html><meta charset="utf-8"><title>gh-writer</title>\n<p>gh-writer is running${title ? `: <strong>${escapeHtml(title)}</strong>` : ""}.</p>`;
  app.get("/", (c) => c.html(placeholder("")));
  app.get("/novels/:id", (c) => {
    const novel = library.get(c.req.param("id"));
    return novel ? c.html(placeholder(novel.title)) : c.notFound();
  });

  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
