import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Committer, createServer, hashText, Library, NovelWorkspace, sessionCookie, Syncer, type NovelSyncStatus, type SyncerDeps, type SyncStatus } from "../src/index.ts";
import { fakeClock, gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const SCENE2 = "manuscript/01-return/01-arrival/02-the-bridge.md";
const MIN = 60_000;

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
let remote: string;
let clock: ReturnType<typeof fakeClock>;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("sync")));
afterAll(() => cleanUp());

beforeEach(() => {
  remote = fresh("remote.git");
  gitIn(tmp, "clone", "-q", "--bare", novelRepo(fresh("seed")), remote);
  clock = fakeClock();
});

const clone = () => {
  const dir = fresh("clone");
  gitIn(tmp, "clone", "-q", remote, dir);
  return dir;
};
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const append = (dir: string, path: string, text: string) => writeFileSync(join(dir, path), read(dir, path) + text);
/** Replace the scene's last paragraph, as an edit to the same lines on two machines would. */
const rewriteEnding = (dir: string, path: string, text: string) => {
  const lines = read(dir, path).trimEnd().split("\n");
  lines[lines.length - 1] = text;
  writeFileSync(join(dir, path), `${lines.join("\n")}\n`);
};
const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
const commitAll = (dir: string, message: string) => {
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", message);
};

/** A syncer with a committer, both on the fake clock. */
function syncer(dir: string, deps: Omit<SyncerDeps, "committer"> = {}) {
  const committer = new Committer(dir, { schedule: clock.schedule });
  return { committer, syncer: new Syncer(dir, { intervalMs: 5 * MIN, retryMs: 15_000, schedule: clock.schedule }, { committer, ...deps }) };
}

describe("syncing two copies", () => {
  it("carries saved work from one copy to the other", async () => {
    const [a, b] = [clone(), clone()];
    append(a, SCENE, "Written on the laptop.\n");
    const status = await syncer(a).syncer.sync();
    expect(status).toMatchObject({ state: "synced", remote: "origin", branch: "main", ahead: 0, behind: 0, lastSync: expect.any(String) });
    expect(gitIn(a, "log", "-1", "--format=%s")).toMatch(/^Draft: The Station/);

    expect(await syncer(b).syncer.sync()).toMatchObject({ state: "synced" });
    expect(read(b, SCENE)).toBe(read(a, SCENE));
    expect(head(b)).toBe(head(a));
  });

  it("merges edits to different scenes on both sides into one linear history", async () => {
    const [a, b] = [clone(), clone()];
    append(a, SCENE, "From A.\n");
    expect((await syncer(a).syncer.sync()).state).toBe("synced");
    append(b, SCENE2, "From B.\n");
    const status = await syncer(b).syncer.sync();
    expect(status).toMatchObject({ state: "synced", ahead: 0, behind: 0 });
    expect(read(b, SCENE)).toContain("From A.");
    expect(read(b, SCENE2)).toContain("From B.");
    // B's commit was rebased onto A's: no merge commits.
    expect(gitIn(b, "rev-list", "--merges", "--count", "HEAD").trim()).toBe("0");
    expect(gitIn(b, "rev-list", "--count", "HEAD").trim()).toBe("3");

    expect((await syncer(a).syncer.sync()).state).toBe("synced");
    expect(read(a, SCENE2)).toContain("From B.");
  });

  it("reports a conflict for edits to the same lines, keeping local commits and the work tree as they were", async () => {
    const [a, b] = [clone(), clone()];
    rewriteEnding(a, SCENE, "The ending, as written on A.");
    await syncer(a).syncer.sync();
    rewriteEnding(b, SCENE, "The ending, as written on B.");
    append(b, SCENE2, "Unrelated work on B.\n");
    const { syncer: s, committer } = syncer(b);
    await committer.commit();
    const before = head(b);

    const status = await s.sync();
    expect(status).toMatchObject({ state: "conflict", conflict: { files: [SCENE] }, ahead: 1, behind: 1 });
    expect(head(b)).toBe(before);
    expect(gitIn(b, "status", "--porcelain")).toBe("");
    expect(read(b, SCENE)).toContain("The ending, as written on B.");
    expect(existsSync(join(b, ".git/rebase-merge"))).toBe(false);
    // Nothing reached the remote.
    expect(gitIn(remote, "log", "-1", "--format=%B", "main")).not.toContain("Unrelated");
  });

  it("pushes the first commit to an empty remote and starts tracking it", async () => {
    const empty = fresh("empty.git");
    gitIn(tmp, "init", "-q", "--bare", empty);
    const dir = novelRepo(fresh("novel"));
    gitIn(dir, "remote", "add", "origin", empty);
    expect(await syncer(dir).syncer.sync()).toMatchObject({ state: "synced", ahead: 0 });
    expect(gitIn(empty, "rev-parse", "main").trim()).toBe(head(dir));
    expect(gitIn(dir, "rev-parse", "--abbrev-ref", "main@{upstream}").trim()).toBe("origin/main");
  });

  it("re-integrates and pushes again when the remote moves during the sync", async () => {
    const [a, b] = [clone(), clone()];
    append(b, SCENE2, "Pushed by B mid-sync.\n");
    commitAll(b, "From B");
    let first = true;
    const { syncer: s } = syncer(a, {
      // After A has fetched, B pushes: A's push is rejected and A must bring B's commit in.
      exclusive: async (fn) => {
        if (first) gitIn(b, "push", "-q", "origin", "main");
        first = false;
        return fn();
      },
    });
    append(a, SCENE, "From A.\n");
    expect(await s.sync()).toMatchObject({ state: "synced" });
    expect(read(a, SCENE2)).toContain("Pushed by B mid-sync.");
    expect(gitIn(remote, "log", "-1", "--format=%s", "main")).toMatch(/^Draft: The Station/);
    expect(gitIn(remote, "rev-list", "--count", "main").trim()).toBe("3");
  });
});

describe("status", () => {
  it("is local without a remote, and doesn't commit before its time", async () => {
    const dir = novelRepo(fresh("novel"));
    append(dir, SCENE, "x\n");
    expect(await syncer(dir).syncer.sync()).toMatchObject({ state: "local", remote: null, branch: null });
    expect(gitIn(dir, "status", "--porcelain")).not.toBe("");
  });

  it("counts commits made since the last sync as ahead", async () => {
    const a = clone();
    const { syncer: s, committer } = syncer(a);
    await s.sync();
    append(a, SCENE, "x\n");
    await committer.commit();
    expect(await s.status()).toMatchObject({ state: "ahead", ahead: 1, behind: 0 });
  });

  it("syncs only on demand with an interval of 0", async () => {
    const a = clone();
    const s = new Syncer(a, { intervalMs: 0, schedule: clock.schedule });
    s.start();
    append(a, SCENE, "x\n");
    commitAll(a, "Local");
    expect(await s.status()).toMatchObject({ state: "ahead", ahead: 1, remote: "origin" });
    expect(await s.sync()).toMatchObject({ state: "synced" });
    expect(clock.pending()).toEqual([]);
  });

  it("refuses a detached HEAD", async () => {
    const a = clone();
    gitIn(a, "checkout", "-q", "--detach");
    expect(await syncer(a).syncer.sync()).toMatchObject({ state: "error", error: { code: "DETACHED" } });
  });

  it("waits out a merge in progress", async () => {
    const a = clone();
    writeFileSync(join(a, ".git/MERGE_HEAD"), `${head(a)}\n`);
    const b = clone();
    append(b, SCENE, "x\n");
    commitAll(b, "B");
    gitIn(b, "push", "-q");
    expect(await syncer(a).syncer.sync()).toMatchObject({ state: "error", error: { code: "BUSY" } });
  });
});

describe("offline", () => {
  it("goes offline when the remote can't be reached, retries with backoff, and syncs once it's back", async () => {
    const a = clone();
    gitIn(a, "remote", "set-url", "origin", "http://127.0.0.1:1/novel.git");
    const { syncer: s, committer } = syncer(a);
    append(a, SCENE, "Written offline.\n");
    const status = await s.sync();
    expect(status).toMatchObject({ state: "offline", error: { code: "NETWORK" } });
    // Committing goes on while offline.
    expect(gitIn(a, "status", "--porcelain")).toBe("");
    expect(status.ahead).toBe(1);
    expect(clock.pending()).toContain(15_000);

    // The next attempts back off: 15 s, 30 s, 60 s…
    clock.advance(15_000);
    await waitFor(async () => clock.pending().includes(30_000));
    clock.advance(30_000);
    await waitFor(async () => clock.pending().includes(60_000));

    gitIn(a, "remote", "set-url", "origin", remote);
    clock.advance(60_000);
    await waitFor(async () => (await s.status()).state === "synced");
    expect(gitIn(remote, "log", "-1", "--format=%s", "main")).toMatch(/^Draft: The Station/);
    // Back to the normal interval.
    await waitFor(async () => clock.pending().includes(5 * MIN));
    await committer.close();
  });

  it("asks for sign-in when the remote refuses the credentials", async () => {
    const server: Server = createHttpServer((_req, res) => res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GIT_ASKPASS = "false";
    try {
      const a = clone();
      gitIn(a, "remote", "set-url", "origin", `http://127.0.0.1:${(server.address() as AddressInfo).port}/writer/novel.git`);
      const status = await syncer(a).syncer.sync();
      expect(status).toMatchObject({ state: "needs-sign-in", error: { code: "AUTH", message: expect.stringContaining("gh auth setup-git") } });
      // No fast retry: the author has to act.
      expect(clock.pending()).toEqual([5 * MIN]);
    } finally {
      delete process.env.GIT_ASKPASS;
      server.close();
    }
  });
});

describe("in the workspace", () => {
  it("holds writes while bringing remote changes in", async () => {
    const a = clone();
    const ws = new NovelWorkspace(a, { commit: false, sync: false });
    const { hash } = (await ws.read(SCENE))!;
    let release!: () => void;
    const exclusive = ws.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    let written = false;
    const write = ws.write(SCENE, "During the rebase.\n", hash).then(() => (written = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(written).toBe(false);
    release();
    await exclusive;
    await write;
    expect(read(a, SCENE)).toBe("During the rebase.\n");
    await ws.close();
  });

  it("waits for a write under way before running alone", async () => {
    const a = clone();
    const ws = new NovelWorkspace(a, { commit: false, sync: false });
    const { hash } = (await ws.read(SCENE))!;
    let landed!: () => void;
    const hook = new Promise<void>((resolve) => (landed = resolve));
    const write = ws.write(SCENE, "Slow write.\n", hash, { beforeRename: () => hook });
    await new Promise((r) => setTimeout(r, 20));
    let sawFile = "";
    const exclusive = ws.exclusive(async () => void (sawFile = read(a, SCENE)));
    await new Promise((r) => setTimeout(r, 20));
    expect(sawFile).toBe("");
    landed();
    await Promise.all([write, exclusive]);
    expect(sawFile).toBe("Slow write.\n");
    await ws.close();
  });
});

describe("through the server", () => {
  it("syncs on demand, streams the status, and passes remote changes to the editor without losing its text", async () => {
    const [a, b] = [clone(), clone()];
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(a);
    const server = await createServer({ library, token: "t", commit: { schedule: clock.schedule }, sync: { schedule: clock.schedule } });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
    const base = `/api/novels/${novel.id}`;
    try {
      const stream = await openStream(server.port, `${base}/events`, headers);
      // The editor has the scene open, with unsaved text, based on the version it read.
      const opened = JSON.parse((await send(server.port, `${base}/files/${SCENE}`, { headers })).body) as { hash: string };

      // Meanwhile, the other machine changes that scene.
      append(b, SCENE, "From the other machine.\n");
      commitAll(b, "From B");
      gitIn(b, "push", "-q");

      const r = await send(server.port, `${base}/sync`, { method: "POST", headers });
      expect(r.status).toBe(200);
      const status = JSON.parse(r.body) as NovelSyncStatus;
      expect(status).toMatchObject({ state: "synced", ahead: 0, behind: 0, commit: { state: "idle" } });

      // The change reaches the editor through the watcher…
      const event = await stream.next("file", (d) => (d as { path: string }).path === SCENE);
      expect(event).toEqual({ type: "change", path: SCENE, hash: hashText(readFileSync(join(a, SCENE))) });
      // …and the editor's save, based on the old version, is refused rather than overwriting it.
      const put = await send(server.port, `${base}/files/${SCENE}`, { method: "PUT", headers, body: JSON.stringify({ content: "Unsaved text.\n", base: opened.hash }) });
      expect(put.status).toBe(409);
      expect(read(a, SCENE)).toContain("From the other machine.");

      // The status went out on the stream: syncing, then synced.
      const states = stream.received.filter((e) => e.event === "sync").map((e) => (e.data as SyncStatus).state);
      expect(states).toContain("syncing");
      expect(states.at(-1)).toBe("synced");

      const get = JSON.parse((await send(server.port, `${base}/sync`, { headers })).body) as NovelSyncStatus;
      expect(get).toMatchObject({ state: "synced", remote: "origin", branch: "main", commit: { pendingChanges: 0 } });
      stream.close();
    } finally {
      await server.close();
    }
  });

  it("reports sync as off when turned off", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(clone());
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}` };
    try {
      const r = await send(server.port, `/api/novels/${novel.id}/sync`, { method: "POST", headers });
      expect(JSON.parse(r.body)).toEqual({ state: "off", commit: { state: "off" } });
    } finally {
      await server.close();
    }
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** An open event stream, collecting every event. */
function openStream(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{
    received: { event: string; data: unknown }[];
    next: (event: string, match: (data: unknown) => boolean) => Promise<unknown>;
    close: () => void;
  }>((resolve) => {
    const received: { event: string; data: unknown }[] = [];
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { ...headers, host: `127.0.0.1:${port}` } }, (res) => {
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
          if (!event || !data) continue;
          received.push({ event, data: JSON.parse(data) as unknown });
          if (event === "ready") resolve({ received, next, close: () => req.destroy() });
        }
      });
    });
    req.on("error", () => {});
    req.end();

    async function next(event: string, match: (data: unknown) => boolean): Promise<unknown> {
      let found: { data: unknown } | undefined;
      await waitFor(async () => Boolean((found = received.find((e) => e.event === event && match(e.data)))));
      return found!.data;
    }
  });
}
