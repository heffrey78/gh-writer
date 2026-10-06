import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, createServer, Library, sessionCookie, type RunningServer } from "../src/index.ts";
import { scratch } from "./fixtures.ts";
import { send } from "./http.ts";

let cleanUp: () => void;
let server: RunningServer;
let headers: Record<string, string>;
let outside: string;

beforeAll(async () => {
  const s = scratch("web");
  cleanUp = s.cleanUp;
  const web = s.fresh("dist");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), '<!doctype html><title>gh-writer</title><script type="module" src="/assets/app-1a2b.js"></script>');
  writeFileSync(join(web, "assets/app-1a2b.js"), "console.log('app')");
  writeFileSync(join(web, "favicon.svg"), "<svg/>");
  outside = s.fresh("secret");
  writeFileSync(outside, "not for the browser");
  server = await createServer({ library: await Library.open({ configDir: s.fresh("config") }), token: "t", web });
  headers = { cookie: `${sessionCookie(server.port)}=t` };
});

afterAll(async () => {
  await server.close();
  cleanUp();
});

describe("the web app", () => {
  it("answers app routes with index.html and a strict content security policy", async () => {
    for (const path of ["/", "/novels/lib_abc123", "/novels/lib_abc123/scenes/sc_1"]) {
      const r = await send(server.port, path, { headers });
      expect(r.status, path).toBe(200);
      expect(r.body).toContain("<title>gh-writer</title>");
      expect(r.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("serves hashed assets for good, and other files fresh", async () => {
    const asset = await send(server.port, "/assets/app-1a2b.js", { headers });
    expect(asset).toMatchObject({ status: 200, body: "console.log('app')" });
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    const icon = await send(server.port, "/favicon.svg", { headers });
    expect(icon.headers).toMatchObject({ "content-type": "image/svg+xml", "cache-control": "no-cache" });
  });

  it("404s missing build files and unknown API paths instead of answering with the app", async () => {
    expect((await send(server.port, "/assets/gone-0000.js", { headers })).status).toBe(404);
    expect((await send(server.port, "/missing.png", { headers })).status).toBe(404);
    const api = await send(server.port, "/api/nope", { headers });
    expect(api.status).toBe(404);
    expect(JSON.parse(api.body)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("never serves files outside the build", async () => {
    const name = outside.split("/").pop()!;
    for (const path of [`/../${name}`, `/assets/..%2F..%2F${name}`, `/%2e%2e/${name}`, "/assets/%00", "/assets/..%5C..%5Cx"]) {
      const r = await send(server.port, path, { headers });
      expect(r.body, path).not.toContain("not for the browser");
    }
  });

  it("stays behind the session", async () => {
    expect((await send(server.port, "/")).status).toBe(403);
    expect((await send(server.port, "/assets/app-1a2b.js")).status).toBe(403);
  });
});
