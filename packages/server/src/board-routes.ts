import type { Context, Hono } from "hono";
import { body, type Env } from "./bible-routes.ts";
import { BoardError } from "./board.ts";

/*
 * The open novel's drafting board on GitHub (#11, D8):
 *
 * GET  /:id/board                       → the board's status
 * POST /:id/board                       → makes the novel's project on GitHub (or adopts the one it has), syncs it: the status
 * POST /:id/board/sync                  → syncs now: the status, with why it couldn't in `error`
 * POST /:id/board/conflicts/:scene      { keep: "file" | "board" } → settles a status conflict and syncs: the status
 * Refusals: 400 BAD_REQUEST, 403 NO_SIGN_IN / NEEDS_SCOPE, 404 NOT_ON_GITHUB / NOT_SET_UP / NOT_FOUND, 409 NOT_MAIN,
 * 410 GONE, 429 RATE_LIMITED { resetAt }, 503 OFFLINE, 502 GITHUB.
 */

const STATUS = { BAD_REQUEST: 400, NO_SIGN_IN: 403, NEEDS_SCOPE: 403, NOT_ON_GITHUB: 404, NOT_SET_UP: 404, NOT_FOUND: 404, NOT_MAIN: 409, GONE: 410, RATE_LIMITED: 429, OFFLINE: 503, GITHUB: 502 } as const;

async function answer(c: Context<Env>, run: () => Promise<object>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    return c.json({ code: e.code, error: e.message, ...(e.resetAt ? { resetAt: e.resetAt } : {}) }, STATUS[e.code]);
  }
}

function board(c: Context<Env>) {
  const store = c.var.ws.board;
  if (!store) throw new BoardError("NOT_ON_GITHUB", "GitHub isn't set up for this server.");
  return store;
}

export function boardRoutes(routes: Hono<Env>): void {
  routes.get("/:id/board", (c) => answer(c, () => board(c).status()));
  routes.post("/:id/board", (c) => answer(c, () => board(c).setUp()));
  routes.post("/:id/board/sync", (c) => answer(c, () => board(c).sync()));
  routes.post("/:id/board/conflicts/:scene", (c) =>
    answer(c, async () => {
      const { keep } = await body(c);
      if (keep !== "file" && keep !== "board") throw new BoardError("BAD_REQUEST", "Say which status to keep: the file's or the board's.");
      return board(c).resolve(c.req.param("scene"), keep);
    }),
  );
}
