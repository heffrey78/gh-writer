import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkPath, createServer, hashText, Library, MAX_FILE_BYTES, sessionCookie, TEMP_SUFFIX, type FileEvent, type RunningServer } from "../src/index.ts";
import { novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const CHAPTER = "manuscript/01-return/01-arrival";

let fresh: (name: string) => string;
let cleanUp: () => void;
let server: RunningServer;
let root: string;
let base: string;
let headers: Record<string, string>;

const api = (method: string, path: string, body?: unknown) =>
  send(server.port, `${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = <T = Record<string, unknown>>(r: { body: string }) => JSON.parse(r.body) as T;
const getFile = async (path: string) => json<{ path: string; content: string; hash: string }>(await api("GET", `/files/${path}`));

/** An open event stream: collects "file" events until closed. */
function events(): Promise<{ received: FileEvent[]; next: (match: (e: FileEvent) => boolean, ms: number) => Promise<FileEvent>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const received: FileEvent[] = [];
    const waiters = new Set<() => void>();
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path: `${base}/events`, headers: { ...headers, host: `127.0.0.1:${server.port}` } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === "ready") resolve({ received, next, close: () => req.destroy() });
          if (event === "file" && data) {
            received.push(JSON.parse(data) as FileEvent);
            for (const w of waiters) w();
          }
        }
      });
    });
    req.on("error", () => {});
    req.on("response", (res) => res.statusCode !== 200 && reject(new Error(`events: ${res.statusCode}`)));
    req.end();

    function next(match: (e: FileEvent) => boolean, ms: number): Promise<FileEvent> {
      return new Promise((done, fail) => {
        const check = () => {
          const found = received.find(match);
          if (!found) return;
          waiters.delete(check);
          clearTimeout(timer);
          done(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          fail(new Error(`no matching event within ${ms} ms; got ${JSON.stringify(received)}`));
        }, ms);
        waiters.add(check);
        check();
      });
    }
  });
}

beforeAll(() => ({ fresh, cleanUp } = scratch("novel")));
afterAll(() => cleanUp());

beforeEach(async () => {
  const library = await Library.open({ configDir: fresh("config") });
  const novel = await library.add(novelRepo(fresh("novel")));
  root = novel.path;
  server = await createServer({ library, token: "t" });
  base = `/api/novels/${novel.id}`;
  headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
});

afterEach(() => server.close());

describe("GET /api/novels/:id", () => {
  it("returns the story model and the hash of each file it read", async () => {
    const r = await api("GET", "");
    expect(r.status).toBe(200);
    const { novel, files } = json<{ novel: { config: { title: string }; allScenes: { file: string }[] }; files: Record<string, string> }>(r);
    expect(novel.config.title).toBe("The Bridge at Varn");
    expect(novel.allScenes.map((s) => s.file)).toContain(SCENE);
    expect(files[SCENE]).toBe(hashText(readFileSync(join(root, SCENE))));
    expect(files["novel.yaml"]).toBeDefined();
  });

  it("404s for a novel that isn't in the library", async () => {
    expect((await send(server.port, "/api/novels/lib_zzzzzz", { headers })).status).toBe(404);
    expect((await send(server.port, `/api/novels/lib_zzzzzz/files/${SCENE}`, { headers })).status).toBe(404);
  });
});

describe("files", () => {
  it("reads a scene file raw, with its hash", async () => {
    const file = await getFile(SCENE);
    expect(file.content).toBe(readFileSync(join(root, SCENE), "utf8"));
    expect(file.hash).toBe(hashText(readFileSync(join(root, SCENE))));
  });

  it("writes, then reads back byte for byte", async () => {
    const { hash } = await getFile(SCENE);
    const content = "---\nid: sc_5tat1n\ntitle: The Station\n---\n\nNew text — with “quotes”, emoji 🌉 and CRLF\r\nlines.\n";
    const r = await api("PUT", `/files/${SCENE}`, { content, base: hash });
    expect(r.status).toBe(200);
    expect(json(r)).toEqual({ hash: hashText(content) });
    expect(readFileSync(join(root, SCENE))).toEqual(Buffer.from(content, "utf8"));
    expect(await getFile(SCENE)).toEqual({ path: SCENE, content, hash: hashText(content) });
  });

  it("refuses a write based on an old version with 409 and the current content", async () => {
    const { hash } = await getFile(SCENE);
    writeFileSync(join(root, SCENE), "Changed in another editor.\n");
    const r = await api("PUT", `/files/${SCENE}`, { content: "Mine.\n", base: hash });
    expect(r.status).toBe(409);
    expect(json(r)).toMatchObject({ code: "CONFLICT", current: { content: "Changed in another editor.\n", hash: hashText("Changed in another editor.\n") } });
    expect(readFileSync(join(root, SCENE), "utf8")).toBe("Changed in another editor.\n");
  });

  it("lets only one of two writes from the same base through", async () => {
    const { hash } = await getFile(SCENE);
    const [a, b] = await Promise.all([api("PUT", `/files/${SCENE}`, { content: "A\n", base: hash }), api("PUT", `/files/${SCENE}`, { content: "B\n", base: hash })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "A\n" : "B\n";
    expect(readFileSync(join(root, SCENE), "utf8")).toBe(winner);
  });

  it("creates a new file, folders included, only when base is null", async () => {
    const path = "manuscript/04-new/01-first.md";
    expect((await api("PUT", `/files/${path}`, { content: "Hello\n", base: "0".repeat(64) })).status).toBe(409);
    const created = await api("PUT", `/files/${path}`, { content: "Hello\n", base: null });
    expect(created.status).toBe(200);
    expect(readFileSync(join(root, path), "utf8")).toBe("Hello\n");
    const again = await api("PUT", `/files/${path}`, { content: "Again\n", base: null });
    expect(again.status).toBe(409);
    expect(json(again)).toMatchObject({ current: { content: "Hello\n" } });
  });

  it("keeps the file's permissions and leaves no temp file", async () => {
    chmodSync(join(root, SCENE), 0o600);
    const { hash } = await getFile(SCENE);
    expect((await api("PUT", `/files/${SCENE}`, { content: "x\n", base: hash })).status).toBe(200);
    if (process.platform !== "win32") expect(statSync(join(root, SCENE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, CHAPTER)).filter((f) => f.endsWith(TEMP_SUFFIX))).toEqual([]);
  });

  it("404s for a missing file", async () => {
    expect((await api("GET", "/files/manuscript/nope.md")).status).toBe(404);
  });

  it.each([
    ["%2Fetc%2Fpasswd", "an absolute path"],
    [".git/config", "the git folder"],
    [".github/workflows/x.yaml", "hidden folders"],
    ["manuscript%5C..%5C..%5Cx.md", "backslashes"],
    ["C:%5Cx.md", "a drive letter"],
    ["manuscript%2F%2Fx.md", "empty segments"],
    ["x%00.md", "NUL"],
    ["%E0%A4%A", "bad percent-encoding"],
  ])("rejects %s (%s) with 400", async (path) => {
    expect((await api("GET", `/files/${path}`)).status).toBe(400);
    expect((await api("PUT", `/files/${path}`, { content: "x", base: null })).status).toBe(400);
  });

  it.each(["%2e%2e/%2e%2e/escaped.md", "manuscript/%2e%2e/%2e%2e/%2e%2e/escaped.md", "..%2F..%2Fescaped.md", "manuscript%2F..%2F..%2Fescaped.md"])(
    "never lets %s out of the novel",
    async (path) => {
      // The URL parser resolves some of these before routing (404); the rest reach checkPath (400).
      expect([400, 404]).toContain((await api("PUT", `/files/${path}`, { content: "x", base: null })).status);
      expect([400, 404]).toContain((await api("GET", `/files/${path}`)).status);
      expect(existsSync(join(root, "..", "escaped.md"))).toBe(false);
      expect(existsSync(join(root, "../..", "escaped.md"))).toBe(false);
    },
  );

  it("checkPath accepts plain relative paths only", () => {
    expect(checkPath("manuscript/01-return/01-arrival/01-the-station.md")).toBe("manuscript/01-return/01-arrival/01-the-station.md");
    for (const bad of ["", "/etc/passwd", "../x.md", "a/../../x.md", "a/./x.md", "a//x.md", "a/", ".git/config", "a\\x.md", "C:x.md", "x\0.md", "node_modules/x.md"]) {
      expect(() => checkPath(bad), bad).toThrow();
    }
  });

  it("rejects symlinks that lead outside the novel", async () => {
    const outside = fresh("outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(outside, join(root, "manuscript/linked"));
    symlinkSync(join(outside, "secret.md"), join(root, "manuscript/secret.md"));
    expect((await api("GET", "/files/manuscript/linked/secret.md")).status).toBe(400);
    expect((await api("PUT", "/files/manuscript/linked/new.md", { content: "x", base: null })).status).toBe(400);
    expect((await api("GET", "/files/manuscript/secret.md")).status).toBe(400);
    expect(existsSync(join(outside, "new.md"))).toBe(false);
  });

  it("writes text files only, as well-formed UTF-8, within the size limit", async () => {
    expect((await api("PUT", "/files/diagrams/map.png", { content: "x", base: null })).status).toBe(400);
    expect((await api("PUT", "/files/notes.md", { content: "half a pair \ud800", base: null })).status).toBe(415);
    expect((await api("PUT", "/files/notes.md", { content: "x".repeat(MAX_FILE_BYTES + 1), base: null })).status).toBe(413);
    expect((await api("PUT", "/files/notes.md", { content: 42, base: null })).status).toBe(400);
    expect((await api("PUT", "/files/notes.md", { content: "x" })).status).toBe(400);
  });

  it("refuses to read a file that isn't UTF-8", async () => {
    writeFileSync(join(root, "bible/latin1.md"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect((await api("GET", "/files/bible/latin1.md")).status).toBe(415);
  });

  it("needs the Origin and session like every other route", async () => {
    const { hash } = await getFile(SCENE);
    const { origin: _, ...noOrigin } = headers;
    const r = await send(server.port, `${base}/files/${SCENE}`, { method: "PUT", headers: noOrigin, body: JSON.stringify({ content: "x", base: hash }) });
    expect(r.status).toBe(403);
    expect((await send(server.port, `${base}/files/${SCENE}`)).status).toBe(403);
  });
});

describe("events", () => {
  it("reports an outside change within a second", async () => {
    const stream = await events();
    try {
      const started = Date.now();
      writeFileSync(join(root, SCENE), "Edited elsewhere.\n");
      const e = await stream.next((e) => e.path === SCENE, 1000);
      expect(e).toEqual({ type: "change", path: SCENE, hash: hashText("Edited elsewhere.\n") });
      expect(Date.now() - started).toBeLessThan(1000);

      writeFileSync(join(root, `${CHAPTER}/09-new.md`), "New.\n");
      expect(await stream.next((e) => e.type === "add", 1000)).toMatchObject({ path: `${CHAPTER}/09-new.md` });
    } finally {
      stream.close();
    }
  });

  it("reports deletions, and ignores .git and temp files", async () => {
    const stream = await events();
    try {
      writeFileSync(join(root, ".git/ghw-test"), "x");
      writeFileSync(join(root, `manuscript/.x.md.abc${TEMP_SUFFIX}`), "x");
      const { rmSync } = await import("node:fs");
      rmSync(join(root, SCENE));
      expect(await stream.next((e) => e.path === SCENE, 1000)).toEqual({ type: "unlink", path: SCENE, hash: null });
      await new Promise((r) => setTimeout(r, 200));
      expect(stream.received.map((e) => e.path)).toEqual([SCENE]);
    } finally {
      stream.close();
    }
  });

  it("doesn't echo the server's own writes", async () => {
    const stream = await events();
    try {
      const { hash } = await getFile(SCENE);
      expect((await api("PUT", `/files/${SCENE}`, { content: "From the app.\n", base: hash })).status).toBe(200);
      expect((await api("PUT", `/files/${CHAPTER}/09-new.md`, { content: "Also the app.\n", base: null })).status).toBe(200);
      // An outside change after them proves the watcher was live and has caught up.
      writeFileSync(join(root, "bible/marker.md"), "marker\n");
      await stream.next((e) => e.path === "bible/marker.md", 1000);
      await new Promise((r) => setTimeout(r, 100));
      expect(stream.received.map((e) => e.path)).toEqual(["bible/marker.md"]);

      // The same file changed outside afterwards is reported again.
      writeFileSync(join(root, SCENE), "Then elsewhere.\n");
      await stream.next((e) => e.path === SCENE, 1000);
    } finally {
      stream.close();
    }
  });

  it("ends event streams when the server closes", async () => {
    const stream = await events();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    stream.close();
  });
});

describe("atomic writes", () => {
  it("leave the original intact when the process dies between the temp write and the rename", () => {
    const file = join(root, SCENE);
    const original = readFileSync(file, "utf8");
    const files = fileURLToPath(new URL("../src/files.ts", import.meta.url));
    const script = `
      import { atomicWrite } from ${JSON.stringify(files)};
      await atomicWrite(${JSON.stringify(file)}, "NEW CONTENT\\n", { beforeRename: () => process.kill(process.pid, "SIGKILL") });
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(r.signal).toBe("SIGKILL");
    expect(readFileSync(file, "utf8")).toBe(original);
    // The new text was fully on disk in the temp file, which the watcher and API ignore.
    const temps = readdirSync(join(root, CHAPTER)).filter((f) => f.endsWith(TEMP_SUFFIX));
    expect(temps).toHaveLength(1);
    expect(readFileSync(join(root, CHAPTER, temps[0]!), "utf8")).toBe("NEW CONTENT\n");
  });
});
