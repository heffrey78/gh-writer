import { Hono } from "hono";
import { appInfo, licenses, UpdateCheck } from "./app-info.ts";
import { globalIdentity, setGlobalIdentity } from "./committer.ts";
import { gitInstall } from "./git.ts";
import { githubRoutes } from "./github-routes.ts";
import type { GitHub } from "./github.ts";
import { libraryRoutes } from "./library-routes.ts";
import type { Library } from "./library.ts";
import { novelRoutes } from "./novel-routes.ts";
import { hasSession, security } from "./security.ts";
import { webRoutes } from "./web.ts";
import type { Workspaces } from "./workspace.ts";

export interface AppOptions {
  token: string;
  /** The listening port, read per request. */
  port: () => number;
  library: Library;
  workspaces: Workspaces;
  github: GitHub;
  /** The built web app's folder (packages/web/dist). Without it, a placeholder page answers. */
  web?: string;
}

/** The API, behind the security middleware. Routes added later go through it too. */
export function createApp({ token, port, library, workspaces, github, web }: AppOptions): Hono {
  const app = new Hono();
  app.use(security({ token, port, publicPaths: new Set(["/api/session"]) }));

  // Which git runs (D9): the desktop app's own, or the system's.
  app.get("/api/health", (c) => c.json({ status: "ok", git: gitInstall().bundled ? "bundled" : "system" }));
  app.get("/api/session", (c) => c.json({ authenticated: hasSession(c, token, port()) }));
  // About the app (D9): versions, licences, and a newer release for the desktop app.
  const updates = new UpdateCheck(github.apiUrl);
  app.get("/api/app", async (c) => c.json(await appInfo(updates)));
  app.get("/api/app/licenses", async (c) => c.json({ licenses: await licenses() }));

  // Who git signs as (#186): the name and email set on this computer, and one from the GitHub account.
  app.get("/api/identity", async (c) =>
    c.json({ identity: await globalIdentity(), suggestion: (await github.suggestedIdentity().catch(() => undefined)) ?? null }),
  );
  app.put("/api/identity", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; email?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) return c.json({ code: "BAD_IDENTITY", error: "Give a name and an email address." }, 400);
    await setGlobalIdentity({ name, email });
    // Work that waited for a name and email is committed now.
    await workspaces.retryIdentity();
    return c.json({ identity: { name, email } });
  });
  app.route("/api/library", libraryRoutes(library, github));
  app.route("/api/novels", novelRoutes(library, workspaces, github));
  app.route("/api/github", githubRoutes(github));

  if (web) {
    app.route("/", webRoutes(web));
    return app;
  }

  // Without a built web app (tests, a bare server), the launch URL lands here.
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
