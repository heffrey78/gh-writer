import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export interface SecurityOptions {
  /** The per-launch secret from the launch URL. */
  token: string;
  /** The listening port, read per request: a random port is only known once the server listens. */
  port: () => number;
  /** Paths that answer without a session. Host and Origin are still checked. */
  publicPaths?: ReadonlySet<string>;
}

/** The launch URL's query parameter that carries the token. */
export const TOKEN_PARAM = "token";

/** Cookies are not scoped by port, so the name carries it: two servers must not overwrite each other's session. */
export const sessionCookie = (port: number): string => `ghw_session_${port}`;

const SAFE_METHODS = new Set(["GET", "HEAD"]);
// "none" is a navigation the user started (the launch URL opened from the terminal, a bookmark).
// "same-site" is rejected too: every port on localhost is the same site.
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * Guards every request: an exact Host allow-list (defeats DNS rebinding), the request's Origin and
 * Sec-Fetch-Site (defeat other pages in the browser), then the session cookie. A GET carrying the
 * token in its query trades it for the cookie and is redirected to the same URL without it.
 */
export function security({ token, port, publicPaths = new Set() }: SecurityOptions): MiddlewareHandler {
  return async (c, next) => {
    const p = port();
    const host = c.req.header("host")?.toLowerCase();
    if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return forbidden(c, "Host not allowed");

    const site = c.req.header("sec-fetch-site");
    if (site !== undefined && !ALLOWED_FETCH_SITES.has(site)) return forbidden(c, "Cross-site request");

    const origin = c.req.header("origin");
    if (origin !== undefined) {
      if (origin !== `http://127.0.0.1:${p}` && origin !== `http://localhost:${p}`) return forbidden(c, "Origin not allowed");
    } else if (!SAFE_METHODS.has(c.req.method) || c.req.header("upgrade") !== undefined) {
      // Browsers send Origin with every unsafe request and WebSocket handshake; its absence means
      // the request did not come from a page we can vouch for.
      return forbidden(c, "Origin required");
    }

    const url = new URL(c.req.url);
    const offered = url.searchParams.get(TOKEN_PARAM);
    if (offered !== null && SAFE_METHODS.has(c.req.method)) {
      if (!matches(offered, token)) return forbidden(c, "Invalid token");
      setCookie(c, sessionCookie(p), token, { httpOnly: true, sameSite: "Strict", path: "/" });
      url.searchParams.delete(TOKEN_PARAM);
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(url.pathname + url.search, 303);
    }

    if (!publicPaths.has(c.req.path) && !hasSession(c, token, p)) return forbidden(c, "No valid session");
    await next();
  };
}

/** Whether the request carries this server's session cookie. */
export function hasSession(c: Context, token: string, port: number): boolean {
  const cookie = getCookie(c, sessionCookie(port));
  return cookie !== undefined && matches(cookie, token);
}

function matches(offered: string, token: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(c: Context, error: string): Response {
  return c.json({ error }, 403);
}
