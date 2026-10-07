import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadNovel, validateNovel } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, LAYOUTS, Library, sessionCookie, withPositions } from "../src/index.ts";
import { novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

let fresh: (name: string) => string;
let cleanUp: () => void;
let dir: string;

beforeAll(() => ({ fresh, cleanUp } = scratch("diagrams")));
afterAll(() => cleanUp());
beforeEach(() => void (dir = novelRepo(fresh("novel"))));

const read = (path: string) => readFileSync(join(dir, path), "utf8");
/** Lines of `b` that `a` doesn't have. */
const changed = (a: string, b: string) => b.split("\n").filter((line) => !a.split("\n").includes(line));

describe("saving diagram positions", () => {
  it("moves a node by changing its one line, and adds a node as a line like the others", () => {
    const before = read(LAYOUTS);
    const moved = withPositions(before, "relationship-graph", { char_b3n0vs: { x: 300, y: 20 } });
    expect(changed(before, moved)).toEqual(["      char_b3n0vs: { x: 300, y: 20 }"]);
    const added = withPositions(before, "relationship-graph", { loc_br1dg3: { x: 10, y: -5 } });
    expect(added).toBe(`${before}      loc_br1dg3: { x: 10, y: -5 }\n`);
  });

  it("starts the file, or a new diagram in it, with one line per node", () => {
    expect(withPositions(undefined, "relationship-graph", { char_7f3k2q: { x: 1, y: 2 } })).toBe("layouts:\n  relationship-graph:\n    nodes:\n      char_7f3k2q: { x: 1, y: 2 }\n");
    const before = read(LAYOUTS);
    expect(withPositions(before, "swimlanes", { plot_h315tz: { x: 0, y: 40 } })).toBe(`${before}  swimlanes:\n    nodes:\n      plot_h315tz: { x: 0, y: 40 }\n`);
  });

  it("through the server: saves rounded positions for the next autosave commit, and refuses bad input", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "application/json" };
    const put = (name: string, body: unknown) => send(server.port, `/api/novels/${novel.id}/diagrams/${encodeURIComponent(name)}/layout`, { method: "PUT", headers, body: JSON.stringify(body) });
    try {
      const before = read(LAYOUTS);
      const ok = await put("relationship-graph", { positions: { char_7f3k2q: { x: 12.4, y: -7.6 }, loc_br1dg3: { x: 5, y: 5 } } });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ file: LAYOUTS });
      expect(changed(before, read(LAYOUTS))).toEqual(["      char_7f3k2q: { x: 12, y: -8 }", "      loc_br1dg3: { x: 5, y: 5 }"]);
      const novelNow = await loadNovel(nodeSource(dir));
      expect(novelNow.layouts["relationship-graph"]!.nodes["char_7f3k2q"]).toEqual({ x: 12, y: -8 });
      expect(validateNovel(novelNow)).toEqual([]);

      expect((await put("relationship-graph", { positions: { "not an id": { x: 1, y: 1 } } })).status).toBe(400);
      expect((await put("relationship-graph", { positions: { char_7f3k2q: { x: "1", y: 1 } } })).status).toBe(400);
      expect((await put("Bad Name", { positions: { char_7f3k2q: { x: 1, y: 1 } } })).status).toBe(400);
      expect((await put("relationship-graph", {})).status).toBe(400);

      // No file yet: it's created.
      rmSync(join(dir, LAYOUTS));
      expect((await put("relationship-graph", { positions: { char_7f3k2q: { x: 0, y: 0 } } })).status).toBe(200);
      expect(read(LAYOUTS)).toBe("layouts:\n  relationship-graph:\n    nodes:\n      char_7f3k2q: { x: 0, y: 0 }\n");
    } finally {
      await server.close();
    }
  });
});
