import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Checkpoints, Committer, createServer, discardedVersions, Library, sessionCookie, Syncer, Versions } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";

const SCENE = "manuscript/02-the-sale/02-varn-holds/02-the-last-rivet.md";

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("versions")));
afterAll(() => cleanUp());

const read = (dir: string, path = SCENE) => readFileSync(join(dir, path), "utf8");
const append = (dir: string, text: string, path = SCENE) => writeFileSync(join(dir, path), read(dir, path) + text);
const branch = (dir: string) => gitIn(dir, "symbolic-ref", "--short", "HEAD").trim();

/** Versions (and the checkpoints and syncer around them) on one copy of the novel. */
function open(dir: string) {
  const committer = new Committer(dir);
  let clock = 0;
  const checkpoints = new Checkpoints(dir, { committer, now: () => new Date(Date.UTC(2026, 9, 9, 12, clock++)) });
  const syncer = new Syncer(dir, { intervalMs: 0 }, { committer });
  const versions = new Versions(dir, { committer, checkpoints, onChange: () => syncer.branchChanged() });
  return { committer, checkpoints, syncer, versions };
}

// Each step commits and checks out with git: seconds on a slow disk.
describe("versions in one copy", { timeout: 20_000 }, () => {
  let dir: string;
  let v: Versions;
  let checkpoints: Checkpoints;
  beforeEach(() => {
    dir = novelRepo(fresh("novel"));
    ({ versions: v, checkpoints } = open(dir));
  });

  it("lists the main version, with its words and latest change", async () => {
    expect(await v.list()).toEqual([
      { id: "main", name: "Main version", main: true, current: true, remoteOnly: false, words: expect.any(Number), date: expect.any(String), commit: gitIn(dir, "rev-parse", "HEAD").trim() },
    ]);
    expect((await v.list())[0]!.words).toBeGreaterThan(700);
    expect(await v.current()).toBe("main");
  });

  it("starts a version from saved work, writes in it apart from the main version, and switches back and forth", async () => {
    append(dir, "Saved before the version began.\n");
    const ending = await v.start("A darker ending");
    expect(ending).toMatchObject({ id: "a-darker-ending", name: "A darker ending", main: false, current: true });
    expect(branch(dir)).toBe("version/a-darker-ending");
    // What was saved went with the version, and is in the main version too.
    expect(gitIn(dir, "show", `main:./${SCENE}`)).toContain("Saved before the version began.");

    append(dir, "The bridge fell.\n");
    await v.switch("main");
    expect(branch(dir)).toBe("main");
    expect(read(dir)).not.toContain("The bridge fell.");
    expect(read(dir)).toContain("Saved before the version began.");

    await v.switch("a-darker-ending");
    expect(read(dir)).toContain("The bridge fell.");
    const list = await v.list();
    expect(list.map((x) => [x.id, x.current])).toEqual([
      ["main", false],
      ["a-darker-ending", true],
    ]);
    expect(list[1]!.words).toBe(list[0]!.words + 3);
  });

  it("gives each version its own ID, never main's, and refuses an empty name", async () => {
    await v.start("Ending");
    await v.switch("main");
    expect((await v.start("Ending")).id).toBe("ending-2");
    await v.switch("main");
    expect((await v.start("Main")).id).toBe("main-2");
    await v.switch("main");
    expect((await v.start("Été — à Varn!")).id).toBe("ete-a-varn");
    await expect(v.start("   ")).rejects.toMatchObject({ code: "BAD_NAME" });
    await expect(v.switch("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("discards a version, keeping it as a checkpoint that brings it back; the main version opens", async () => {
    await v.start("Cut the subplot");
    append(dir, "Only in the cut.\n");
    const result = await v.discard("cut-the-subplot");
    expect(result.current).toBe("main");
    expect(branch(dir)).toBe("main");
    expect(gitIn(dir, "branch", "--list", "version/*").trim()).toBe("");
    expect(result.checkpoint).toMatchObject({ name: "Discarded version “Cut the subplot”", auto: true });
    expect(gitIn(dir, "show", `${result.checkpoint.commit}:./${SCENE}`)).toContain("Only in the cut.");
    expect(read(dir)).not.toContain("Only in the cut.");
    // A version started from the checkpoint brings it back.
    const back = await v.start("Cut the subplot", { from: result.checkpoint.id });
    expect(back).toMatchObject({ id: "cut-the-subplot", current: true });
    expect(read(dir)).toContain("Only in the cut.");
    await expect(v.start("x", { from: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(v.discard("main")).rejects.toMatchObject({ code: "MAIN" });
  });

  it("finds the main version when the novel lives on master", async () => {
    gitIn(dir, "branch", "-m", "main", "master");
    expect(await v.mainBranch()).toBe("master");
    await v.start("Other");
    expect(await v.mainBranch()).toBe("master");
    expect((await v.list()).map((x) => x.id)).toEqual(["main", "other"]);
  });
});

describe("versions across computers", () => {
  let remote: string;
  beforeEach(() => {
    remote = fresh("remote.git");
    gitIn(tmp, "clone", "-q", "--bare", novelRepo(fresh("seed")), remote);
  });
  const clone = () => {
    const dir = fresh("clone");
    gitIn(tmp, "clone", "-q", remote, dir);
    return dir;
  };

  it("syncs a version to the remote, where another copy lists it and opens it; discarding deletes it there", async () => {
    const [a, b] = [clone(), clone()];
    const laptop = open(a);
    await laptop.versions.start("Alternate ending");
    append(a, "Written in the version.\n");
    expect(await laptop.syncer.sync()).toMatchObject({ state: "synced", branch: "version/alternate-ending" });
    expect(gitIn(remote, "branch", "--list", "version/*").trim()).toBe("version/alternate-ending");
    expect(gitIn(remote, "show", `main:${SCENE}`)).not.toContain("Written in the version.");

    const desk = open(b);
    await desk.syncer.sync();
    const listed = await desk.versions.list();
    expect(listed.map((x) => [x.id, x.name, x.remoteOnly])).toEqual([
      ["main", "Main version", false],
      // The name typed on the laptop stays there; here it's made from the ID.
      ["alternate-ending", "Alternate ending", true],
    ]);
    await desk.versions.switch("alternate-ending");
    expect(read(b)).toContain("Written in the version.");
    expect(gitIn(b, "config", "--get", "branch.version/alternate-ending.merge").trim()).toBe("refs/heads/version/alternate-ending");

    // Discarded on the desk: gone on the remote after the next sync, and on the laptop after its next.
    await desk.versions.discard("alternate-ending");
    expect(await discardedVersions(b)).toEqual(["version/alternate-ending"]);
    expect(await desk.syncer.sync()).toMatchObject({ state: "synced", branch: "main" });
    expect(gitIn(remote, "branch", "--list", "version/*").trim()).toBe("");
    expect(await discardedVersions(b)).toEqual([]);

    await laptop.versions.switch("main");
    await laptop.syncer.sync();
    expect(gitIn(a, "for-each-ref", "refs/remotes/origin/version/").trim()).toBe("");
    // Still on the laptop, where it was made: discarding it there is the author's choice.
    expect((await laptop.versions.list()).map((x) => [x.id, x.remoteOnly])).toEqual([
      ["main", false],
      ["alternate-ending", false],
    ]);
  }, 30_000);
});

describe("routes", { timeout: 20_000 }, () => {
  it("start, list, switch and discard over HTTP, with refusals", async () => {
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
      return { status: res.status, json: (await res.json()) as unknown };
    };
    try {
      const started = await call("POST", "/versions", { name: "New ending" });
      expect(started.status).toBe(201);
      expect(started.json).toMatchObject({ version: { id: "new-ending", current: true } });
      expect((await call("GET", "/versions")).json).toMatchObject({ versions: [{ id: "main", current: false }, { id: "new-ending", current: true }] });
      expect((await call("POST", "/versions/main/switch")).json).toMatchObject({ version: { id: "main", current: true } });
      expect(await call("POST", "/versions", {})).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
      expect(await call("POST", "/versions/nope/switch")).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
      expect(await call("DELETE", "/versions/main")).toMatchObject({ status: 400, json: { code: "MAIN" } });
      expect(await call("DELETE", "/versions/new-ending")).toMatchObject({ status: 200, json: { current: "main", checkpoint: { auto: true } } });
    } finally {
      await server.close();
    }
  });
});
