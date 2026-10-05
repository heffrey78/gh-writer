import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, Library, sessionCookie, type RunningServer } from "@gh-writer/server";
import { createApi, createAutosave, type Api, type Autosave, type AutosaveState, type StorageLike } from "../src/index.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const sample = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));
const TOKEN = "test-token";

let tmp: string;
let n = 0;
let library: Library;
let novelId: string;
let root: string;
let server: RunningServer;
let port: number;
let puts: { keepalive: boolean; body: string }[];
let api: Api;
let autosave: Autosave | undefined;

const start = async (onPort?: number) => {
  // No background commits: these tests are about files reaching the disk.
  server = await createServer({ library, token: TOKEN, commit: false, ...(onPort ? { port: onPort } : {}) });
  port = server.port;
};

/** A Storage in memory, like sessionStorage. */
function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const disk = () => readFileSync(join(root, SCENE), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until the store's state matches, or fail after `ms`. */
const until = (a: Autosave, match: (s: AutosaveState) => boolean, ms = 3000) =>
  new Promise<AutosaveState>((resolve, reject) => {
    if (match(a.store.getState())) return resolve(a.store.getState());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`state never matched; last: ${JSON.stringify(a.store.getState())}`));
    }, ms);
    const stop = a.store.subscribe((s) => {
      if (!match(s)) return;
      clearTimeout(timer);
      stop();
      resolve(s);
    });
  });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gh-writer-client-"));
  const config = join(tmp, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = config;
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  root = join(tmp, `novel-${++n}`);
  cpSync(sample, root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  library = await Library.open({ configDir: join(tmp, `config-${n}`) });
  novelId = (await library.add(root)).id;
  await start();
  puts = [];
  api = createApi({
    baseUrl: `http://127.0.0.1:${port}`,
    // The browser sends these by itself: the session cookie and the page's origin.
    headers: { cookie: `${sessionCookie(port)}=${TOKEN}`, origin: `http://127.0.0.1:${port}` },
    fetch: (input, init) => {
      if (init?.method === "PUT") puts.push({ keepalive: Boolean(init.keepalive), body: String(init.body) });
      return fetch(input, init);
    },
  });
});

afterEach(async () => {
  autosave?.dispose();
  autosave = undefined;
  await server.close();
});

/** Autosave for the scene, tracking the hash it was read with. */
async function open(options: Partial<Parameters<typeof createAutosave>[0]> = {}): Promise<Autosave> {
  autosave = createAutosave({ api, novelId, storage: null, ...options });
  const { hash } = await api.readFile(novelId, SCENE);
  autosave.track(SCENE, hash);
  return autosave;
}

describe("autosave", () => {
  it("coalesces rapid edits into one write, on disk within the interval", async () => {
    const a = await open({ interval: 300 });
    const original = disk();
    for (let i = 1; i <= 10; i++) {
      a.change(SCENE, `${original}${" word".repeat(i)}`);
      await sleep(20);
    }
    const lastChange = Date.now();
    expect(a.store.getState()).toMatchObject({ status: "unsaved", unsaved: 1 });
    await until(a, (s) => s.status === "saved");
    expect(Date.now() - lastChange).toBeLessThan(300 + 250);
    expect(puts).toHaveLength(1);
    expect(disk()).toBe(`${original}${" word".repeat(10)}`);
  });

  it("saves by default two seconds after a pause", async () => {
    const a = await open();
    a.change(SCENE, "Two seconds.\n");
    await sleep(1500);
    expect(puts).toHaveLength(0);
    await until(a, (s) => s.status === "saved", 1500);
    expect(disk()).toBe("Two seconds.\n");
  });

  it("goes through saving to saved, and follows a save with the text typed during it", async () => {
    const a = await open({ interval: 50 });
    const seen = new Set<string>();
    a.store.subscribe((s) => seen.add(s.status));
    a.change(SCENE, "First.\n");
    await until(a, (s) => s.status === "saving");
    a.change(SCENE, "First. Second.\n");
    await until(a, (s) => s.status === "saved" && puts.length === 2);
    expect(disk()).toBe("First. Second.\n");
    expect([...seen]).toEqual(expect.arrayContaining(["unsaved", "saving", "saved"]));
  });

  it("retries while the server is down and saves when it returns, losing nothing", async () => {
    const a = await open({ interval: 50, retryDelay: 50, maxRetryDelay: 200 });
    const lostPort = port;
    await server.close();
    a.change(SCENE, "Written while the server was down.\n");
    const failing = await until(a, (s) => s.status === "error");
    expect(failing.error).toContain("Couldn't reach gh-writer");
    expect(failing.unsaved).toBe(1);
    await sleep(300); // several retries
    await start(lostPort);
    await until(a, (s) => s.status === "saved");
    expect(disk()).toBe("Written while the server was down.\n");
  });

  it("surfaces a 409 with the disk text and leaves the disk untouched", async () => {
    const conflicts: unknown[] = [];
    const a = await open({ interval: 50, onConflict: (c) => conflicts.push(c) });
    writeFileSync(join(root, SCENE), "Edited in another editor.\n");
    a.change(SCENE, "Mine.\n");
    const state = await until(a, (s) => s.conflicts.length > 0);
    expect(state.status).toBe("error");
    expect(state.conflicts[0]).toMatchObject({ path: SCENE, mine: "Mine.\n", disk: { content: "Edited in another editor.\n" } });
    expect(conflicts).toHaveLength(1);
    expect(disk()).toBe("Edited in another editor.\n");

    // More typing while the conflict is open isn't saved over the disk either.
    a.change(SCENE, "Mine, more.\n");
    await sleep(200);
    expect(disk()).toBe("Edited in another editor.\n");
    expect(a.store.getState().conflicts[0]?.mine).toBe("Mine, more.\n");

    // The resolver's merged text goes over the disk version it was shown.
    a.resolve(SCENE, "Merged.\n");
    await until(a, (s) => s.status === "saved");
    expect(disk()).toBe("Merged.\n");
  });

  it("can drop the unsaved text and take the disk version instead", async () => {
    const a = await open({ interval: 50 });
    writeFileSync(join(root, SCENE), "Theirs.\n");
    a.change(SCENE, "Mine.\n");
    await until(a, (s) => s.conflicts.length > 0);
    a.discard(SCENE);
    expect(a.store.getState()).toMatchObject({ status: "saved", conflicts: [] });
    a.change(SCENE, "Theirs, then mine.\n");
    await until(a, (s) => s.status === "saved");
    expect(disk()).toBe("Theirs, then mine.\n");
  });

  it("holds a save the server refuses, without retrying it in a loop", async () => {
    const a = await open({ interval: 50, retryDelay: 20 });
    a.track("notes.png", null);
    a.change("notes.png", "not text");
    const state = await until(a, (s) => s.status === "error");
    expect(state.error).toContain("Only text files");
    await sleep(200);
    expect(puts).toHaveLength(1);
  });

  it("flushes on page hide with keepalive requests", async () => {
    const a = await open({ interval: 60_000 });
    const page = new EventTarget();
    const detach = a.attach(page);
    a.change(SCENE, "Saved as the page hides.\n");
    page.dispatchEvent(new Event("pagehide"));
    await until(a, (s) => s.status === "saved");
    expect(puts).toEqual([{ keepalive: true, body: expect.stringContaining("Saved as the page hides.") }]);
    expect(disk()).toBe("Saved as the page hides.\n");

    detach();
    a.change(SCENE, "After detaching.\n");
    page.dispatchEvent(new Event("beforeunload"));
    await sleep(50);
    expect(puts).toHaveLength(1);
  });

  it("flushes before unload and when the page is hidden", async () => {
    const a = await open({ interval: 60_000 });
    const page = Object.assign(new EventTarget(), { document: { visibilityState: "visible" } });
    a.attach(page);
    a.change(SCENE, "One.\n");
    page.dispatchEvent(new Event("beforeunload"));
    await until(a, (s) => s.status === "saved");
    a.change(SCENE, "Two.\n");
    page.document.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await until(a, (s) => s.status === "saved");
    expect(disk()).toBe("Two.\n");
  });

  it("keeps unsaved text in storage until the server has it, and requeues it after a reload", async () => {
    const storage = memoryStorage();
    const a = await open({ interval: 60_000, storage });
    a.change(SCENE, "Typed just before the tab reloaded.\n");
    expect([...storage.data.values()][0]).toContain("Typed just before the tab reloaded.");
    a.dispose(); // the tab goes away with the save still waiting

    const reloaded = createAutosave({ api, novelId, storage, interval: 50 });
    autosave = reloaded;
    expect(reloaded.store.getState()).toMatchObject({ unsaved: 1 });
    await until(reloaded, (s) => s.status === "saved");
    expect(disk()).toBe("Typed just before the tab reloaded.\n");
    expect(storage.data.size).toBe(0);
  });
});

describe("api", () => {
  it("reads the library and the novel, and reports errors with their code", async () => {
    expect(await api.session()).toEqual({ authenticated: true });
    expect((await api.library()).novels.map((x) => x.id)).toEqual([novelId]);
    const { novel, files } = await api.novel<{ config: { title: string } }>(novelId);
    expect(novel.config.title).toBe("The Bridge at Varn");
    expect(files[SCENE]).toMatch(/^[0-9a-f]{64}$/);
    await expect(api.readFile(novelId, "manuscript/missing.md")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND", retryable: false });
    await expect(createApi({ baseUrl: "http://127.0.0.1:1" }).session()).rejects.toMatchObject({ status: 0, retryable: true });
  });
});
