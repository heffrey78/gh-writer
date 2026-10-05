import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, sessionCookie, type RunningServer } from "../src/index.ts";

const TOKEN = "test-token-0123456789";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP to the server, so tests control Host, Origin and the rest the way an attacker could. */
function send(
  port: number,
  path: string,
  { method = "GET", headers = {}, agent }: { method?: string; headers?: Record<string, string>; agent?: Agent | false } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, agent, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let server: RunningServer;
let session: Record<string, string>;
let origin: string;

beforeEach(async () => {
  server = await createServer({ root: "/novels/the-bridge", token: TOKEN });
  session = { cookie: `${sessionCookie(server.port)}=${TOKEN}` };
  origin = `http://127.0.0.1:${server.port}`;
});

afterEach(() => server.close());

describe("createServer", () => {
  it("listens on 127.0.0.1 and gives a launch URL carrying the token", () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    expect(server.launchUrl).toBe(`${server.url}/?token=${TOKEN}`);
  });

  it("makes a fresh URL-safe token per launch by default", async () => {
    const a = await createServer({ root: "." });
    const b = await createServer({ root: "." });
    try {
      expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(a.token).not.toBe(b.token);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe("session", () => {
  it("trades the launch token for an HttpOnly SameSite=Strict cookie and drops it from the URL", async () => {
    const r = await send(server.port, `/?token=${TOKEN}`, { headers: { "sec-fetch-site": "none" } });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = r.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain(`${sessionCookie(server.port)}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("keeps the rest of the query when it drops the token", async () => {
    const r = await send(server.port, `/scene?token=${TOKEN}&id=sc_1`);
    expect(r.headers.location).toBe("/scene?id=sc_1");
  });

  it("rejects a wrong token", async () => {
    const r = await send(server.port, "/?token=nope");
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("serves a valid session", async () => {
    const r = await send(server.port, "/api/health", { headers: session });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: "ok", root: "/novels/the-bridge" });
  });

  it("rejects a missing or wrong session cookie", async () => {
    expect((await send(server.port, "/api/health")).status).toBe(403);
    expect((await send(server.port, "/api/health", { headers: { cookie: `${sessionCookie(server.port)}=nope` } })).status).toBe(403);
    expect((await send(server.port, "/", { headers: { cookie: `${sessionCookie(server.port + 1)}=${TOKEN}` } })).status).toBe(403);
  });

  it("answers /api/session without a session, saying whether there is one", async () => {
    expect(JSON.parse((await send(server.port, "/api/session")).body)).toEqual({ authenticated: false });
    expect(JSON.parse((await send(server.port, "/api/session", { headers: session })).body)).toEqual({ authenticated: true });
  });

  it("rejects unknown paths without a session before they can 404", async () => {
    expect((await send(server.port, "/api/nothing")).status).toBe(403);
    expect((await send(server.port, "/api/nothing", { headers: session })).status).toBe(404);
  });
});

describe("Host allow-list", () => {
  it("accepts 127.0.0.1 and localhost on the bound port", async () => {
    expect((await send(server.port, "/api/health", { headers: session })).status).toBe(200);
    expect((await send(server.port, "/api/health", { headers: { ...session, host: `localhost:${server.port}` } })).status).toBe(200);
  });

  it("rejects DNS rebinding: evil.example resolving to 127.0.0.1", async () => {
    for (const host of [`evil.example:${server.port}`, "evil.example", `127.0.0.1.evil.example:${server.port}`]) {
      const r = await send(server.port, "/api/health", { headers: { ...session, host } });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "Host not allowed" });
    }
  });

  it("rejects the right host on the wrong port, and other loopback names", async () => {
    for (const host of [`127.0.0.1:${server.port + 1}`, "127.0.0.1", `[::1]:${server.port}`, `0.0.0.0:${server.port}`]) {
      expect((await send(server.port, "/api/health", { headers: { ...session, host } })).status, host).toBe(403);
    }
  });

  it("checks Host even on public paths and the token exchange", async () => {
    const evil = { host: `evil.example:${server.port}` };
    expect((await send(server.port, "/api/session", { headers: evil })).status).toBe(403);
    expect((await send(server.port, `/?token=${TOKEN}`, { headers: evil })).status).toBe(403);
  });
});

describe("Origin and fetch metadata", () => {
  it("accepts a same-origin POST", async () => {
    server.app.post("/api/echo", (c) => c.json({ ok: true }));
    const r = await send(server.port, "/api/echo", { method: "POST", headers: { ...session, origin, "sec-fetch-site": "same-origin" } });
    expect(r.status).toBe(200);
  });

  it("rejects a cross-origin POST, even with the session cookie", async () => {
    server.app.post("/api/echo", (c) => c.json({ ok: true }));
    for (const foreign of ["https://evil.example", "null", `http://localhost:${server.port + 1}`, `https://127.0.0.1:${server.port}`]) {
      const r = await send(server.port, "/api/echo", { method: "POST", headers: { ...session, origin: foreign } });
      expect(r.status, foreign).toBe(403);
    }
  });

  it("rejects a POST with no Origin", async () => {
    server.app.post("/api/echo", (c) => c.json({ ok: true }));
    const r = await send(server.port, "/api/echo", { method: "POST", headers: session });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "Origin required" });
  });

  it("rejects a GET with a foreign Origin", async () => {
    expect((await send(server.port, "/api/health", { headers: { ...session, origin: "https://evil.example" } })).status).toBe(403);
  });

  it("rejects a WebSocket handshake without our Origin", async () => {
    const upgrade = { ...session, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    expect((await send(server.port, "/api/events", { headers: upgrade })).status).toBe(403);
    expect((await send(server.port, "/api/events", { headers: { ...upgrade, origin: "https://evil.example" } })).status).toBe(403);
  });

  it("rejects an event stream request from another origin", async () => {
    const r = await send(server.port, "/api/events", { headers: { ...session, accept: "text/event-stream", origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("rejects requests the browser marks cross-site or same-site (another localhost port)", async () => {
    for (const site of ["cross-site", "same-site"]) {
      expect((await send(server.port, "/api/health", { headers: { ...session, "sec-fetch-site": site } })).status, site).toBe(403);
    }
    expect((await send(server.port, "/api/health", { headers: { ...session, "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });
});

describe("close", () => {
  it("finishes in-flight requests before it resolves, and refuses new connections", async () => {
    let finished = false;
    server.app.post("/api/slow", async (c) => {
      await new Promise((r) => setTimeout(r, 200));
      finished = true;
      return c.json({ saved: true });
    });
    const inFlight = send(server.port, "/api/slow", { method: "POST", headers: { ...session, origin } });
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await server.close();
    expect(finished).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await inFlight).status).toBe(200);
    await expect(send(server.port, "/api/health", { headers: session, agent: false })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("resolves promptly with idle keep-alive connections open", async () => {
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve) => {
      httpRequest({ host: "127.0.0.1", port: server.port, path: "/api/session", agent }, (res) => {
        res.resume();
        res.on("end", resolve);
      }).end();
    });
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    agent.destroy();
  });

  it("can be called more than once", async () => {
    await Promise.all([server.close(), server.close()]);
  });
});
