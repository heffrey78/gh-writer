import { Hono, type Context } from "hono";
import { GitHubError, unreachable, type GitHub } from "./github.ts";

/**
 * GET    /api/github/account       the connection's status (never the token)
 * POST   /api/github/device        start signing in with a code → { userCode, verificationUri, expiresIn, interval }
 * POST   /api/github/device/poll   ask once whether the code was entered → { status, interval? | account? }
 * POST   /api/github/gh            sign in with the gh CLI's account → the status
 * DELETE /api/github/account       sign out → the status
 * GET    /api/github/repos         { repos }: the author's repositories, most recently pushed first
 */
export function githubRoutes(github: GitHub): Hono {
  const routes = new Hono();
  const answer = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json((await fn()) as object);
    } catch (e) {
      if (e instanceof GitHubError) return c.json({ code: e.code, error: e.message }, e.code === "GITHUB" ? 502 : 400);
      if (!unreachable(e)) throw e;
      // No network, or GitHub unreachable. The message never carries the token.
      return c.json({ code: "NETWORK", error: "Couldn't reach GitHub. Check your connection and try again." }, 502);
    }
  };
  routes.get("/account", (c) => answer(c, () => github.status()));
  routes.post("/device", (c) => answer(c, () => github.startDevice()));
  routes.post("/device/poll", (c) => answer(c, () => github.pollDevice()));
  routes.post("/gh", (c) => answer(c, () => github.useGh()));
  routes.get("/repos", (c) => answer(c, async () => ({ repos: await github.repos() })));
  routes.delete("/account", (c) =>
    answer(c, async () => {
      await github.signOut();
      return github.status();
    }),
  );
  return routes;
}
