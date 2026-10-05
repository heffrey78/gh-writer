import { basename } from "node:path";
import { Hono } from "hono";
import { hasSession, security } from "./security.ts";

export interface AppOptions {
  /** The novel repository the server reads and writes. */
  root: string;
  token: string;
  /** The listening port, read per request. */
  port: () => number;
}

/** The API, behind the security middleware. Routes added later go through it too. */
export function createApp({ root, token, port }: AppOptions): Hono {
  const app = new Hono();
  app.use(security({ token, port, publicPaths: new Set(["/api/session"]) }));

  app.get("/api/health", (c) => c.json({ status: "ok", root }));
  app.get("/api/session", (c) => c.json({ authenticated: hasSession(c, token, port()) }));

  // Until the web app is served (#7), the launch URL lands here.
  app.get("/", (c) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>gh-writer</title>
<p>gh-writer is serving <strong>${escapeHtml(basename(root))}</strong>.</p>`),
  );

  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
