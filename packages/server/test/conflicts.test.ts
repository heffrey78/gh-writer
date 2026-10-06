import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveMerge, type Resolution } from "@gh-writer/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Committer, createServer, Library, sessionCookie, Syncer, type Conflicts, type FileResolution } from "../src/index.ts";
import { gitIn, novelRepo, sample, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const SCENE2 = "manuscript/01-return/01-arrival/02-the-bridge.md";

// Each scenario runs a few full syncs on two clones: dozens of git processes.
vi.setConfig({ testTimeout: 20_000 });

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
let remote: string;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("conflicts")));
afterAll(() => cleanUp());

beforeEach(() => {
  remote = fresh("remote.git");
  gitIn(tmp, "clone", "-q", "--bare", novelRepo(fresh("seed")), remote);
});

const clone = (from = remote) => {
  const dir = fresh("clone");
  gitIn(tmp, "clone", "-q", from, dir);
  return dir;
};
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const write = (dir: string, path: string, text: string) => writeFileSync(join(dir, path), text);
const syncer = (dir: string) => new Syncer(dir, { schedule: () => () => {} }, { committer: new Committer(dir) });
const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").trim();
const parents = (dir: string, rev = "HEAD") => gitIn(dir, "rev-list", "--parents", "-n", "1", rev).trim().split(" ").slice(1);

/** Replace a scene's last paragraph. */
const rewriteEnding = (dir: string, path: string, text: string) => {
  const lines = read(dir, path).trimEnd().split("\n");
  lines[lines.length - 1] = text;
  write(dir, path, `${lines.join("\n")}\n`);
};
const setField = (dir: string, path: string, key: string, value: string) => write(dir, path, read(dir, path).replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`));

/** A pushes one ending, B writes another and syncs into a conflict. */
async function sameParagraph() {
  const [a, b] = [clone(), clone()];
  rewriteEnding(a, SCENE, "The ending, as written on A.");
  await syncer(a).sync();
  rewriteEnding(b, SCENE, "The ending, as written on B.");
  const s = syncer(b);
  expect(await s.sync()).toMatchObject({ state: "conflict", conflict: { files: [SCENE] } });
  return { a, b, s, conflicts: (await s.conflicts())! };
}

describe("merging paragraph by paragraph", () => {
  it("merges front matter fields git can't, in a merge commit, and pushes it", async () => {
    const [a, b] = [clone(), clone()];
    setField(a, SCENE, "status", "revised");
    await syncer(a).sync();
    // The synopsis is the line above status: git alone would call this a conflict.
    setField(b, SCENE, "synopsis", "Ada comes home and sees the flags.");
    rewriteEnding(b, SCENE2, "A new ending for the bridge.");
    const status = await syncer(b).sync();
    expect(status).toMatchObject({ state: "synced", ahead: 0, behind: 0 });
    expect(read(b, SCENE)).toMatch(/^synopsis: Ada comes home and sees the flags\.$/m);
    expect(read(b, SCENE)).toMatch(/^status: revised$/m);
    expect(parents(b)).toHaveLength(2);
    expect(gitIn(b, "log", "-1", "--format=%B")).toBe(`Merge changes from origin\n\n- ${SCENE}: merged paragraph by paragraph\n\n`);
    expect(gitIn(remote, "rev-parse", "main").trim()).toBe(head(b));
    expect(gitIn(b, "status", "--porcelain")).toBe("");

    await syncer(a).sync();
    expect(read(a, SCENE)).toBe(read(b, SCENE));
  });

  it("leaves edits to the same paragraph to the author: exactly one hunk", async () => {
    const { b, conflicts } = await sameParagraph();
    expect(conflicts.files).toHaveLength(1);
    const [file] = conflicts.files;
    expect(file).toMatchObject({ path: SCENE, inOurs: true, inTheirs: true, binary: false });
    const hunks = file!.chunks.filter((c) => c.type === "conflict");
    expect(hunks).toEqual([{ type: "conflict", base: expect.any(String), ours: "The ending, as written on B.\n", theirs: "The ending, as written on A.\n" }]);
    expect(file!.ours).toBe((await import("../src/index.ts")).hashText(readFileSync(join(b, SCENE))));
    expect(conflicts.upstream).toBe(gitIn(remote, "rev-parse", "main").trim());
  });
});

describe("resolving", () => {
  const choices: [string, Resolution, (ours: string, theirs: string) => string][] = [
    ["keep mine", "ours", (o) => o],
    ["keep theirs", "theirs", (_, t) => t],
    ["keep both", "both", (o, t) => `${o}\n${t}`],
    ["an edit", { text: "The ending, rewritten.\n" }, () => "The ending, rewritten.\n"],
  ];

  it.each(choices)("with %s: writes the file, commits the merge and pushes it", async (_name, choice, ending) => {
    const { a, b, s, conflicts } = await sameParagraph();
    const file = conflicts.files[0]!;
    const before = head(b);
    const content = resolveMerge(file.chunks, [choice]);
    expect(await s.resolve(conflicts.upstream, { [SCENE]: { ours: file.ours, content } })).toMatchObject({ state: "synced", ahead: 0, behind: 0 });

    const expected = read(a, SCENE).replace("The ending, as written on A.\n", ending("The ending, as written on B.\n", "The ending, as written on A.\n"));
    expect(read(b, SCENE)).toBe(expected);
    expect(parents(b)).toEqual([before, conflicts.upstream]);
    expect(gitIn(b, "log", "-1", "--format=%B")).toBe(`Merge changes from origin\n\n- ${SCENE}: resolved\n\n`);
    expect(gitIn(remote, "rev-parse", "main").trim()).toBe(head(b));
    expect(gitIn(b, "status", "--porcelain")).toBe("");

    await syncer(a).sync();
    expect(read(a, SCENE)).toBe(expected);
  });

  it("keeps one side's file as it is", async () => {
    const { a, b, s, conflicts } = await sameParagraph();
    await s.resolve(conflicts.upstream, { [SCENE]: { ours: conflicts.files[0]!.ours, keep: "theirs" } });
    expect(read(b, SCENE)).toBe(read(a, SCENE));
  });

  it("settles an edit against a deletion", async () => {
    const [a, b] = [clone(), clone()];
    rmSync(join(a, SCENE2));
    await syncer(a).sync();
    rewriteEnding(b, SCENE2, "Edited where it was deleted.");
    const s = syncer(b);
    expect((await s.sync()).state).toBe("conflict");
    const conflicts = (await s.conflicts())!;
    expect(conflicts.files).toEqual([expect.objectContaining({ path: SCENE2, inOurs: true, inTheirs: false })]);

    await s.resolve(conflicts.upstream, { [SCENE2]: { ours: conflicts.files[0]!.ours, keep: "theirs" } });
    expect(() => read(b, SCENE2)).toThrow();
    expect(gitIn(remote, "ls-tree", "--name-only", "main", "--", SCENE2)).toBe("");
  });

  it("is refused when the remote moved, or the file changed, since the conflicts were read", async () => {
    const { a, b, s, conflicts } = await sameParagraph();
    const file = conflicts.files[0]!;
    const content = resolveMerge(file.chunks, ["ours"]);

    // The file changes after the conflict was shown (the author kept writing).
    write(b, SCENE, `${read(b, SCENE)}\nOne more line.\n`);
    await expect(s.resolve(conflicts.upstream, { [SCENE]: { ours: file.ours, content } })).rejects.toMatchObject({ code: "STALE" });

    // The other machine pushes again, and the next sync fetches it.
    write(a, SCENE2, `${read(a, SCENE2)}\nMore from A.\n`);
    await syncer(a).sync();
    expect((await s.sync()).state).toBe("conflict");
    const fresh = (await s.conflicts())!;
    await expect(s.resolve(conflicts.upstream, { [SCENE]: { ours: fresh.files[0]!.ours, content } })).rejects.toMatchObject({ code: "STALE" });
    // With what's current, it goes through.
    await s.resolve(fresh.upstream, { [SCENE]: { ours: fresh.files[0]!.ours, keep: "ours" } });
    expect(read(b, SCENE)).toContain("One more line.");
    expect(read(b, SCENE2)).toContain("More from A.");
  });

  it("refuses resolutions that don't fit the conflicts", async () => {
    const { s, conflicts } = await sameParagraph();
    const ours = conflicts.files[0]!.ours;
    await expect(s.resolve(conflicts.upstream, {})).rejects.toMatchObject({ code: "BAD_RESOLUTION" });
    await expect(s.resolve(conflicts.upstream, { [SCENE]: { ours, keep: "ours" }, [SCENE2]: { ours, keep: "ours" } })).rejects.toMatchObject({
      code: "BAD_RESOLUTION",
    });
  });

  it("leaves both versions safe while the conflict waits, and can be resolved later", async () => {
    const { b, s } = await sameParagraph();
    const local = head(b);
    // Abandoned for now: syncing again changes nothing.
    expect((await s.sync()).state).toBe("conflict");
    expect(head(b)).toBe(local);
    expect(read(b, SCENE)).toContain("The ending, as written on B.");
    expect(gitIn(b, "show", `origin/main:${SCENE}`)).toContain("The ending, as written on A.");
    // A fresh syncer (the app restarted) finds the same conflict.
    const again = syncer(b);
    expect((await again.sync()).state).toBe("conflict");
    expect((await again.conflicts())!.files).toHaveLength(1);
    expect(await syncer(b).conflicts()).toBeNull();
  });

  it("works for a novel in a folder of a larger repository", async () => {
    const seed = fresh("mono");
    mkdirSync(seed);
    gitIn(seed, "init", "-q");
    cpSync(sample, join(seed, "books/varn"), { recursive: true });
    gitIn(seed, "add", "-A");
    gitIn(seed, "commit", "-qm", "Start");
    const bare = fresh("mono.git");
    gitIn(tmp, "clone", "-q", "--bare", seed, bare);
    const [a, b] = [join(clone(bare), "books/varn"), join(clone(bare), "books/varn")];
    rewriteEnding(a, SCENE, "From A.");
    await syncer(a).sync();
    rewriteEnding(b, SCENE, "From B.");
    const s = syncer(b);
    expect(await s.sync()).toMatchObject({ state: "conflict", conflict: { files: [SCENE] } });
    const conflicts = (await s.conflicts())!;
    expect(conflicts.files.map((f) => f.path)).toEqual([SCENE]);
    await s.resolve(conflicts.upstream, { [SCENE]: { ours: conflicts.files[0]!.ours, content: resolveMerge(conflicts.files[0]!.chunks, ["both"]) } });
    expect(read(b, SCENE)).toMatch(/From B\.\n\nFrom A\.\n$/);
    expect(gitIn(bare, "show", `main:books/varn/${SCENE}`)).toBe(read(b, SCENE));
  });
});

describe("through the server", () => {
  it("shows the conflicts, refuses a stale resolution with fresh ones, and resolves", async () => {
    const [a, b] = [clone(), clone()];
    rewriteEnding(a, SCENE, "From A.");
    await syncer(a).sync();
    rewriteEnding(b, SCENE, "From B.");
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(b);
    const server = await createServer({ library, token: "t", sync: { schedule: () => () => {} } });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
    const base = `/api/novels/${novel.id}`;
    const post = (path: string, body: unknown) => send(server.port, `${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      expect(JSON.parse((await send(server.port, `${base}/conflicts`, { headers })).body)).toEqual({ conflicts: null });
      expect(JSON.parse((await post("/sync", {})).body)).toMatchObject({ state: "conflict" });
      const { conflicts } = JSON.parse((await send(server.port, `${base}/conflicts`, { headers })).body) as { conflicts: Conflicts };
      const file = conflicts.files[0]!;
      const resolution = (ours: string | null): Record<string, FileResolution> => ({ [SCENE]: { ours, content: resolveMerge(file.chunks, ["theirs"]) } });

      const stale = await post("/conflicts/resolve", { upstream: conflicts.upstream, files: resolution("0".repeat(64)) });
      expect(stale.status).toBe(409);
      expect(JSON.parse(stale.body)).toMatchObject({ code: "STALE", conflicts: { upstream: conflicts.upstream, files: [{ path: SCENE }] } });
      expect((await post("/conflicts/resolve", { upstream: conflicts.upstream, files: { [SCENE]: { ours: file.ours } } })).status).toBe(400);
      expect((await post("/conflicts/resolve", { files: {} })).status).toBe(400);

      const done = await post("/conflicts/resolve", { upstream: conflicts.upstream, files: resolution(file.ours) });
      expect(done.status).toBe(200);
      expect(JSON.parse(done.body)).toMatchObject({ state: "synced" });
      expect(read(b, SCENE)).toBe(read(a, SCENE));
      expect(JSON.parse((await post("/conflicts/resolve", { upstream: conflicts.upstream, files: {} })).body)).toMatchObject({ code: "NO_CONFLICT" });
    } finally {
      await server.close();
    }
  });
});
