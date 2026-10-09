import type { Context, Hono } from "hono";
import { body, type Env } from "./bible-routes.ts";
import { IssuesError, type IssueFilter, type IssueInput } from "./issues.ts";

/*
 * The open novel's GitHub issues (#8), from its cache and changed on GitHub:
 *
 * GET   /:id/issues?state=open|closed|all&labels=a,b&milestone=3|none&q=words → { issues, labels, milestones, status }
 * GET   /:id/issues/:number                    → the issue with its comments
 * POST  /:id/issues                            { title, body?, labels?, milestone? } → 201 the issue
 * PATCH /:id/issues/:number                    { title?, body?, labels?, milestone?, state? } → the issue
 * POST  /:id/issues/:number/comments           { body } → 201 the comment
 * POST  /:id/issues/refresh                    → { changed, status } (and sends changes queued offline)
 * DELETE /:id/issues/queue/:change             → drop a queued change (one GitHub refused)
 * While GitHub can't be reached, changes are made in the cache and queued: the answers say `pending`.
 * Refusals: 400 BAD_REQUEST, 403 NO_SIGN_IN, 404 NOT_ON_GITHUB / NOT_FOUND, 429 RATE_LIMITED { resetAt },
 * 503 OFFLINE, 502 GITHUB.
 */

const STATUS = { BAD_REQUEST: 400, NO_SIGN_IN: 403, NOT_ON_GITHUB: 404, NOT_FOUND: 404, RATE_LIMITED: 429, OFFLINE: 503, GITHUB: 502 } as const;

async function answer(c: Context<Env>, run: () => Promise<object>, status: 200 | 201 = 200): Promise<Response> {
  try {
    return c.json(await run(), status);
  } catch (e) {
    if (!(e instanceof IssuesError)) throw e;
    return c.json({ code: e.code, error: e.message, ...(e.resetAt ? { resetAt: e.resetAt } : {}) }, STATUS[e.code]);
  }
}

function issues(c: Context<Env>) {
  const store = c.var.ws.issues;
  if (!store) throw new IssuesError("NOT_ON_GITHUB", "GitHub isn't set up for this server.");
  return store;
}

const number = (c: Context<Env>) => {
  const n = Number(c.req.param("number"));
  // Negative: an issue made offline, by its temporary number (which still finds it once it's sent).
  if (!Number.isInteger(n) || n === 0) throw new IssuesError("NOT_FOUND", "No such issue.");
  return n;
};

/** Only the fields an issue change may carry, of the right types. */
function input(raw: Record<string, unknown>): IssueInput {
  const out: IssueInput = {};
  if (typeof raw.title === "string") out.title = raw.title;
  if (typeof raw.body === "string") out.body = raw.body;
  if (Array.isArray(raw.labels)) out.labels = raw.labels.filter((l): l is string => typeof l === "string");
  if (raw.milestone === null || typeof raw.milestone === "number") out.milestone = raw.milestone;
  if (raw.state === "open" || raw.state === "closed") out.state = raw.state;
  return out;
}

export function issueRoutes(routes: Hono<Env>): void {
  routes.get("/:id/issues", (c) =>
    answer(c, () => {
      const q = c.req.query();
      const filter: IssueFilter = {};
      if (q.state === "open" || q.state === "closed" || q.state === "all") filter.state = q.state;
      if (q.labels) filter.labels = q.labels.split(",").filter(Boolean);
      if (q.milestone === "none") filter.milestone = "none";
      else if (q.milestone && Number.isInteger(Number(q.milestone))) filter.milestone = Number(q.milestone);
      if (q.q) filter.text = q.q;
      return issues(c).list(filter);
    }),
  );
  routes.post("/:id/issues/refresh", (c) => answer(c, async () => ({ changed: await issues(c).refresh(), status: await issues(c).status() })));
  routes.delete("/:id/issues/queue/:change", (c) =>
    answer(c, async () => {
      await issues(c).discard(c.req.param("change"));
      return { status: await issues(c).status() };
    }),
  );
  routes.get("/:id/issues/:number", (c) => answer(c, () => issues(c).get(number(c))));
  routes.post("/:id/issues", (c) =>
    answer(
      c,
      async () => {
        const fields = input(await body(c));
        return issues(c).create({ ...fields, title: fields.title ?? "" });
      },
      201,
    ),
  );
  routes.patch("/:id/issues/:number", (c) => answer(c, async () => issues(c).update(number(c), input(await body(c)))));
  routes.post("/:id/issues/:number/comments", (c) =>
    answer(
      c,
      async () => {
        const { body: text } = await body(c);
        return issues(c).comment(number(c), typeof text === "string" ? text : "");
      },
      201,
    ),
  );
}
