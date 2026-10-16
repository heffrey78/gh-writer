import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countWords, loadNovel, writingDays } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uncommittedChange, writingHistory } from "../src/index.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";

const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
const RIVET = "manuscript/02-the-sale/02-varn-holds/02-the-last-rivet.md";
const LEDGER = "manuscript/01-return/02-old-debts/02-bens-ledger.md";

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;
beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("stats")));
afterAll(() => cleanUp());

/** Commit everything as written at `date` (ISO with the writer's offset). */
const commitAt = (dir: string, message: string, date: string) => {
  gitIn(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "commit", "-qm", message], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const edit = (dir: string, path: string, from: string, to: string) => writeFileSync(join(dir, path), read(dir, path).replace(from, to));
const wordsNow = async (dir: string) => (await loadNovel(nodeSource(dir))).allScenes.reduce((n, s) => n + countWords(s.body), 0);

describe("writingHistory", { timeout: 30_000 }, () => {
  it("counts each day's words added and removed from the commits, on the writer's own date", async () => {
    const dir = novelRepo(fresh("novel"));
    const start = await wordsNow(dir);
    edit(dir, RIVET, "walk across.", "walk across. One two three.");
    // The synopsis, in the front matter, isn't the story: it doesn't count.
    edit(dir, RIVET, "stall the sale.", "stall the sale for good.");
    commitAt(dir, "draft", "2026-11-01T22:00:00-04:00");
    // Late on the 2nd where the writer was, though already the 3rd in UTC.
    edit(dir, STATION, "counted them twice", "counted them three times");
    commitAt(dir, "reword", "2026-11-02T23:30:00-07:00");
    gitIn(dir, "mv", STATION, "manuscript/01-return/01-arrival/01-arrival.md");
    commitAt(dir, "rename", "2026-11-02T23:40:00-07:00");
    const ledgerWords = countWords((await loadNovel(nodeSource(dir))).allScenes.find((s) => s.file === LEDGER)!.body);
    gitIn(dir, "rm", "-q", LEDGER);
    edit(dir, "manuscript/01-return/02-old-debts/_chapter.yaml", ", sc_1edger", "");
    commitAt(dir, "cut", "2026-11-03T09:00:00+01:00");

    // A side line, merged: each of its commits is counted once, the merge not at all.
    gitIn(dir, "switch", "-q", "-c", "side");
    edit(dir, RIVET, "One two three.", "One two three. Side words.");
    commitAt(dir, "side", "2026-11-03T10:00:00+01:00");
    gitIn(dir, "switch", "-q", "main");
    edit(dir, "manuscript/01-return/01-arrival/02-the-bridge.md", "with two coffees", "with two hot coffees");
    commitAt(dir, "main", "2026-11-03T11:00:00+01:00");
    execFileSync("git", ["-C", dir, "merge", "-q", "--no-edit", "side"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-03T12:00:00+01:00", GIT_COMMITTER_DATE: "2026-11-03T12:00:00+01:00" } });

    const history = await writingHistory(dir);
    expect(history.map((c) => [c.date.slice(0, 10), c.added, c.removed])).toEqual([
      [expect.any(String), start, 0],
      ["2026-11-01", 3, 0],
      ["2026-11-02", 2, 1],
      ["2026-11-02", 0, 0],
      ["2026-11-03", 0, ledgerWords],
      ["2026-11-03", 2, 0],
      ["2026-11-03", 1, 0],
    ]);
    const now = await wordsNow(dir);
    const days = writingDays(history, now);
    expect(days.slice(1)).toEqual([
      { day: "2026-11-01", added: 3, removed: 0, net: 3, words: start + 3 },
      { day: "2026-11-02", added: 2, removed: 1, net: 1, words: start + 4 },
      { day: "2026-11-03", added: 3, removed: ledgerWords, net: 3 - ledgerWords, words: now },
    ]);
    expect(now).toBe(start + 7 - ledgerWords);

    // A fresh clone, with nothing but git, works out the same.
    const clone = fresh("clone");
    gitIn(tmp, "clone", "-q", dir, clone);
    expect(writingDays(await writingHistory(clone), await wordsNow(clone))).toEqual(days);

    // Kept in the clone's .git: a new commit is the only one worked out again.
    const cache = join(dir, ".git/gh-writer/stats.json");
    expect(Object.keys((JSON.parse(read(dir, ".git/gh-writer/stats.json")) as { commits: object }).commits)).toHaveLength(7);
    edit(dir, RIVET, "Side words.", "Side words. More.");
    commitAt(dir, "more", "2026-11-04T08:00:00+01:00");
    expect(existsSync(cache)).toBe(true);
    const again = await writingHistory(dir);
    expect(again.at(-1)).toMatchObject({ added: 1, removed: 0 });
    expect(Object.keys((JSON.parse(read(dir, ".git/gh-writer/stats.json")) as { commits: object }).commits)).toHaveLength(8);
  });

  it("counts saved work not yet committed: edits and new scenes, against the last commit", async () => {
    const dir = novelRepo(fresh("novel"));
    expect(await uncommittedChange(dir)).toEqual({ added: 0, removed: 0 });
    edit(dir, STATION, "counted them twice", "counted them three times");
    writeFileSync(join(dir, "manuscript/01-return/01-arrival/03 a new scene.md"), "---\nid: sc_new001\ntitle: New\n---\n\nFour brand new words.\n");
    expect(await uncommittedChange(dir)).toEqual({ added: 6, removed: 1 });
    commitAt(dir, "commit it", "2026-11-05T10:00:00Z");
    expect(await uncommittedChange(dir)).toEqual({ added: 0, removed: 0 });
  });

  it("is empty for a novel with no commits yet", async () => {
    const dir = fresh("empty");
    execFileSync("git", ["init", "-q", dir]);
    expect(await writingHistory(dir)).toEqual([]);
  });
});

describe("PUT /target and GET /stats", { timeout: 30_000 }, () => {
  it("sets the targets in novel.yaml, one commit each, and answers them with the history", async () => {
    const { createServer, Library, sessionCookie } = await import("../src/index.ts");
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
      expect((await call("PUT", "/target", { words: 90000, date: "2027-06-30", daily: 500 })).status).toBe(200);
      expect(read(dir, "novel.yaml")).toMatch(/target:\n {2}words: 90000\n {2}date: 2027-06-30\n {2}daily: 500\n/);
      expect(gitIn(dir, "log", "-1", "--format=%s").trim()).toBe("Set the book's targets");
      const stats = await call("GET", "/stats");
      expect(stats.json).toMatchObject({ target: { words: 90000, date: "2027-06-30", daily: 500 }, words: await wordsNow(dir), days: [{ added: await wordsNow(dir) }] });

      await call("PUT", "/target", { daily: null });
      expect(read(dir, "novel.yaml")).not.toContain("daily:");
      expect(await call("PUT", "/target", { words: 0 })).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
      expect(await call("PUT", "/target", { date: "June" })).toMatchObject({ status: 400 });
      await call("PUT", "/target", { words: null, date: null });
      expect(read(dir, "novel.yaml")).not.toContain("target");
      expect((await call("GET", "/stats")).json.target).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("says when Day 1 is in novel.yaml, or that it has no date, one commit each (#239)", async () => {
    const { createServer, Library, sessionCookie } = await import("../src/index.ts");
    const dir = novelRepo(fresh("calendar"));
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", sync: false, commit: false });
    const put = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/novels/${novel.id}/calendar`, {
        method: "PUT",
        headers: { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    try {
      expect((await put({ start: "2026-10-10" })).status).toBe(200);
      expect(read(dir, "novel.yaml")).toMatch(/calendar:\n {2}start: 2026-10-10\n/);
      expect(gitIn(dir, "log", "-1", "--format=%s").trim()).toBe("Set when Day 1 is");
      await put({ start: "2026-07-01" });
      expect(read(dir, "novel.yaml")).toMatch(/calendar:\n {2}start: 2026-07-01\n/);
      for (const bad of [{ start: "10 Oct" }, { start: "2026-13-40" }, { start: 5 }, {}]) expect(await put(bad)).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
      await put({ start: null });
      expect(read(dir, "novel.yaml")).not.toContain("calendar");
      expect(gitIn(dir, "log", "-1", "--format=%s").trim()).toBe("Day 1 has no date");
    } finally {
      await server.close();
    }
  });
});
