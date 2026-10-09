import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, Library, sessionCookie } from "../src/index.ts";
import { novelRepo, scratch } from "./fixtures.ts";

const SCENE = "manuscript/02-the-sale/02-varn-holds/02-the-last-rivet.md";

let fresh: (name: string) => string;
let cleanUp: () => void;
beforeAll(() => ({ fresh, cleanUp } = scratch("compare")));
afterAll(() => cleanUp());

describe("GET /compare", { timeout: 30_000 }, () => {
  it("compares versions, checkpoints and what's saved now, and one scene word by word", async () => {
    const dir = novelRepo(fresh("novel"));
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/novels/${novel.id}${path}`, {
        method,
        headers: { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    try {
      const checkpoint = (await call("POST", "/checkpoints", { name: "First draft" })).json.checkpoint as { id: string };
      await call("POST", "/versions", { name: "Darker ending" });
      const text = readFileSync(join(dir, SCENE), "utf8");
      const last = text.trimEnd().split("\n").at(-1)!;
      writeFileSync(join(dir, SCENE), text.replace(last, `${last} Then the bridge fell into the river.`));

      // Saved but not yet committed: in "now", not yet in the version as committed.
      const now = await call("GET", "/compare?from=version:main&to=now");
      expect(now.status).toBe(200);
      const comparison = now.json.comparison as { counts: unknown; words: { before: number; after: number }; chapters: { scenes: { id: string; status: string; prose: boolean }[] }[] };
      expect(comparison.counts).toEqual({ added: 0, removed: 0, changed: 1, moved: 0 });
      expect(comparison.words.after - comparison.words.before).toBe(7);
      expect(comparison.chapters.flatMap((c) => c.scenes).find((s) => s.status === "changed")).toMatchObject({ id: "sc_r1vet8", prose: true });
      expect((await call("GET", "/compare?from=version:main&to=version:darker-ending")).json.comparison).toMatchObject({ counts: { changed: 0 } });

      const scene = await call("GET", `/compare/scene/sc_r1vet8?from=checkpoint:${checkpoint.id}&to=now`);
      expect(scene.json.paragraphs).toContainEqual({ kind: "changed", parts: [{ op: "same", text: last }, { op: "ins", text: " Then the bridge fell into the river." }] });

      expect(await call("GET", "/compare?from=now")).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
      expect(await call("GET", "/compare?from=now&to=branch:x")).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
      expect(await call("GET", "/compare?from=now&to=version:nope")).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
      expect(await call("GET", "/compare?from=now&to=checkpoint:nope")).toMatchObject({ status: 404 });
      expect(await call("GET", "/compare/scene/sc_nope?from=now&to=now")).toMatchObject({ status: 404 });
    } finally {
      await server.close();
    }
  });
});
