import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitMessage, Committer, createServer, Library, sessionCookie, TEMP_SUFFIX } from "../src/index.ts";
import { gitIn, novelRepo, sample, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const SCENE = "manuscript/01-return/01-arrival/01-the-station.md";
const SCENE2 = "manuscript/01-return/01-arrival/02-the-bridge.md";
const MIN = 60_000;

let fresh: (name: string) => string;
let cleanUp: () => void;
let tmp: string;

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
  };
}

const commits = (dir: string) => Number(gitIn(dir, "rev-list", "--count", "HEAD").trim());
const lastMessage = (dir: string) => gitIn(dir, "log", "-1", "--format=%B").trim();
const edit = (dir: string, path: string, append: string) => writeFileSync(join(dir, path), readFileSync(join(dir, path), "utf8") + append);

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let committer: Committer;

beforeAll(() => ({ fresh, cleanUp, tmp } = scratch("commit")));
afterAll(() => cleanUp());

beforeEach(() => {
  dir = novelRepo(fresh("novel"));
  clock = fakeClock();
  committer = new Committer(dir, { quietMs: 2 * MIN, maxMs: 10 * MIN, schedule: clock.schedule });
});

describe("timing", () => {
  it("batches saves within the quiet period into one commit", async () => {
    for (const word of ["one", "two", "three"]) {
      edit(dir, SCENE, ` ${word}`);
      committer.notify();
      clock.advance(MIN);
    }
    await committer.idle();
    expect(commits(dir)).toBe(1);

    clock.advance(MIN); // two minutes after the last save
    await committer.idle();
    expect(commits(dir)).toBe(2);
    expect(lastMessage(dir)).toMatch(/^Draft: The Station \(\+3 words\)/);
  });

  it("commits at the cap while saving goes on", async () => {
    let made = 0;
    for (let minute = 1; minute <= 15; minute++) {
      edit(dir, SCENE, " more");
      committer.notify();
      clock.advance(MIN);
      await committer.idle();
      if (commits(dir) - 1 > made) {
        made = commits(dir) - 1;
        expect(minute, "first commit at the 10-minute cap").toBe(10);
      }
    }
    expect(made).toBe(1);
  });

  it("makes no empty commits", async () => {
    committer.notify();
    clock.advance(2 * MIN);
    expect(await committer.commit()).toEqual({ skipped: "NOTHING" });
    expect(commits(dir)).toBe(1);
    expect((await committer.status()).state).toBe("idle");
  });
});

describe("what gets committed", () => {
  it("stages new, changed and deleted files in the novel, but not atomic-write leftovers", async () => {
    writeFileSync(join(dir, "manuscript/01-return/01-arrival/09-new.md"), "---\nid: sc_aaaaaa\ntitle: The New One\n---\n\nFresh words here.\n");
    writeFileSync(join(dir, `manuscript/01-return/01-arrival/.01-the-station.md.abc${TEMP_SUFFIX}`), "half");
    rmSync(join(dir, SCENE2));
    const result = await committer.commit();
    expect(result).toMatchObject({ committed: { summary: expect.stringContaining("New scene: The New One") } });
    expect(gitIn(dir, "status", "--porcelain")).toBe(`?? manuscript/01-return/01-arrival/.01-the-station.md.abc${TEMP_SUFFIX}\n`);
    expect(gitIn(dir, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      `A\tmanuscript/01-return/01-arrival/09-new.md`,
      `D\t${SCENE2}`,
    ]);
  });

  it("commits only the novel's folder when the novel lives inside a larger repository", async () => {
    const repo = fresh("repo");
    mkdirSync(repo);
    gitIn(repo, "init", "-q");
    cpSync(sample, join(repo, "novel"), { recursive: true });
    writeFileSync(join(repo, "other.txt"), "other\n");
    writeFileSync(join(repo, "staged.txt"), "staged by the author\n");
    gitIn(repo, "add", "novel");
    gitIn(repo, "commit", "-qm", "Start");
    gitIn(repo, "add", "staged.txt");
    edit(join(repo, "novel"), SCENE, " added");

    const result = await new Committer(join(repo, "novel")).commit();
    expect(result).toHaveProperty("committed");
    expect(gitIn(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe(`novel/${SCENE}`);
    // The author's own staging and untracked files elsewhere are left as they were.
    expect(gitIn(repo, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual(["?? other.txt", "A  staged.txt"]);
  });

  it("reports the last commit and the pending changes", async () => {
    edit(dir, SCENE, " a");
    edit(dir, SCENE2, " b");
    committer.notify();
    expect(await committer.status()).toMatchObject({ state: "pending", pendingChanges: 2, lastCommit: null });
    clock.advance(2 * MIN);
    await committer.idle();
    const status = await committer.status();
    expect(status).toMatchObject({ state: "idle", pendingChanges: 0, lastCommit: { summary: "Draft: The Station, Walking the Span (+2 words)" } });
    expect(status.lastCommit!.hash).toBe(gitIn(dir, "rev-parse", "HEAD").trim());
  });
});

describe("when not to commit", () => {
  it("waits out a merge in progress", async () => {
    gitIn(dir, "checkout", "-qb", "other");
    edit(dir, SCENE, " theirs");
    gitIn(dir, "commit", "-qam", "Theirs");
    gitIn(dir, "checkout", "-q", "main");
    edit(dir, SCENE, " ours");
    gitIn(dir, "commit", "-qam", "Ours");
    try {
      gitIn(dir, "merge", "other");
    } catch {
      // the conflict is the point
    }
    edit(dir, SCENE2, " more");
    committer.notify();
    const before = commits(dir);
    clock.advance(2 * MIN);
    await committer.idle();
    expect(commits(dir)).toBe(before);
    expect(await committer.status()).toMatchObject({ state: "blocked", blocked: { code: "MERGE" } });

    gitIn(dir, "merge", "--abort");
    clock.advance(2 * MIN); // retried after another quiet period
    await committer.idle();
    expect(commits(dir)).toBe(before + 1);
    expect((await committer.status()).blocked).toBeUndefined();
  });

  it("waits out a rebase in progress", async () => {
    mkdirSync(join(dir, ".git/rebase-merge"));
    edit(dir, SCENE, " x");
    expect(await committer.commit()).toEqual({ skipped: "MERGE" });
    rmSync(join(dir, ".git/rebase-merge"), { recursive: true });
    expect(await committer.commit()).toHaveProperty("committed");
  });

  it("asks for a git identity instead of committing without one", async () => {
    const global = process.env.GIT_CONFIG_GLOBAL;
    const empty = join(tmp, "empty-gitconfig");
    writeFileSync(empty, "");
    process.env.GIT_CONFIG_GLOBAL = empty;
    try {
      edit(dir, SCENE, " x");
      expect(await committer.commit()).toEqual({ skipped: "IDENTITY" });
      expect(commits(dir)).toBe(1);
      const status = await committer.status();
      expect(status).toMatchObject({ state: "blocked", blocked: { code: "IDENTITY", message: expect.stringContaining("git config --global user.name") } });
    } finally {
      process.env.GIT_CONFIG_GLOBAL = global;
    }
    expect(await committer.commit()).toHaveProperty("committed");
  });
});

describe("through the server", () => {
  it("commits a save after the quiet period, and what's waiting when the server closes", async () => {
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", commit: { quietMs: 2 * MIN, maxMs: 10 * MIN, schedule: clock.schedule } });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" };
    const base = `/api/novels/${novel.id}`;
    const put = async (content: string) => {
      const { hash } = JSON.parse((await send(server.port, `${base}/files/${SCENE}`, { headers })).body) as { hash: string };
      return send(server.port, `${base}/files/${SCENE}`, { method: "PUT", headers, body: JSON.stringify({ content, base: hash }) });
    };
    const sync = async () => JSON.parse((await send(server.port, `${base}/sync`, { headers })).body) as { state: string; pendingChanges: number };

    const original = readFileSync(join(dir, SCENE), "utf8");
    expect((await put(`${original} first`)).status).toBe(200);
    expect(await sync()).toMatchObject({ state: "pending", pendingChanges: 1 });
    clock.advance(2 * MIN);
    for (let i = 0; i < 50 && commits(dir) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(commits(dir)).toBe(2);

    expect((await put(`${original} first second`)).status).toBe(200);
    await server.close();
    expect(commits(dir)).toBe(3);
    expect(lastMessage(dir)).toMatch(/^Draft: The Station \(\+1 word\)/);
  });
});

describe("commitMessage", () => {
  const scene = (title: string, body: string) => `---\nid: sc_aaaaaa\ntitle: ${title}\n---\n\n${body}\n`;
  const entry = (name: string) => `---\nid: char_aaaaaa\nname: ${name}\n---\nNotes.\n`;

  it("names edited scenes with the net word change", () => {
    const m = commitMessage([
      { status: "M", path: SCENE, before: scene("The Station", "One two."), after: scene("The Station", "One two three four.") },
      { status: "M", path: SCENE2, before: scene("The Bridge", "A b c."), after: scene("The Bridge", "A b c d e f.") },
    ]);
    expect(m.summary).toBe("Draft: The Station, The Bridge (+5 words)");
    expect(m.body).toBe(`M ${SCENE} (+2 words)\nM ${SCENE2} (+3 words)`);
  });

  it("names new and removed scenes, bible entries and other files", () => {
    expect(commitMessage([{ status: "A", path: "manuscript/a/03-dawn.md", after: scene("Dawn", "It was light.") }]).summary).toBe("New scene: Dawn (+3 words)");
    expect(commitMessage([{ status: "D", path: SCENE, before: scene("The Station", "Gone now.") }]).summary).toBe("Remove scene: The Station (-2 words)");
    expect(commitMessage([{ status: "M", path: "bible/characters/ada.md", before: entry("Ada"), after: entry("Ada Varn") }]).summary).toBe("Bible: Ada Varn");
    expect(commitMessage([{ status: "M", path: "manuscript/01-return/_part.yaml" }, { status: "M", path: "novel.yaml" }]).summary).toBe("Update _part.yaml, novel.yaml");
  });

  it("combines kinds, and shortens long lists", () => {
    const m = commitMessage([
      ...["A", "B", "C", "D", "E"].map((t, i) => ({ status: "M" as const, path: `manuscript/c/0${i}-x.md`, before: scene(t, "x"), after: scene(t, "x y") })),
      { status: "A", path: "bible/locations/varn.md", after: entry("Varn") },
    ]);
    expect(m.summary).toBe("Draft: A, B, C and 2 more; Bible: Varn (+5 words)");
  });

  it("follows renames, and falls back to the file name without a title", () => {
    const m = commitMessage([{ status: "R", oldPath: "manuscript/c/01-old.md", path: "manuscript/c/02-the-last-rivet.md", before: "no front matter", after: "no front matter either" }]);
    expect(m.summary).toBe("Draft: the last rivet (+1 word)");
    expect(m.body).toBe("R manuscript/c/01-old.md → manuscript/c/02-the-last-rivet.md (+1 word)");
  });
});
