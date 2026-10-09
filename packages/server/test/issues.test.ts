import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadNovel, readAnchor } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { createServer, GitHub, Library, memoryStore, sessionCookie, type TokenStore } from "../src/index.ts";
import { IssueStore, type IssuesError } from "../src/issues.ts";
import { fakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { gitIn, novelRepo, scratch } from "./fixtures.ts";
import { send } from "./http.ts";

const TOKEN = "gho_issues";
let fake: FakeGitHub;
let fresh: (name: string) => string;
let cleanUp: () => void;
let dir: string;
let store: TokenStore;
let github: GitHub;
/** Answers to the API's GET requests, as "STATUS path?query". */
let answers: string[];
/** GitHub can't be reached. */
let offline = false;
/** The next request to this method and path reaches GitHub, but its answer is lost. */
let loseNext: string | undefined;
/** GitHub answers this much later (ms). */
let slow = 0;

beforeAll(async () => {
  ({ fresh, cleanUp } = scratch("issues"));
  fake = await fakeGitHub();
  fake.users.set(TOKEN, { login: "ada" });
});
afterAll(async () => {
  await fake.close();
  cleanUp();
});

beforeEach(async () => {
  dir = novelRepo(fresh("novel"));
  const name = `salt-${Math.random().toString(36).slice(2, 8)}`;
  gitIn(dir, "remote", "add", "origin", `${fake.url}/ada/${name}.git`);
  fake.repos.push({ owner: "ada", name, private: true, pushedAt: fake.now() });
  store = memoryStore();
  await store.set(TOKEN);
  answers = [];
  offline = false;
  loseNext = undefined;
  slow = 0;
  const recording: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError("fetch failed");
    const res = await fetch(input, init);
    // The answer comes back late: GitHub has already answered as things were when asked.
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (loseNext === `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`) {
      loseNext = undefined;
      throw new TypeError("fetch failed");
    }
    if ((init?.method ?? "GET") === "GET") answers.push(`${res.status} ${new URL(String(input)).pathname}${new URL(String(input)).search}`);
    return res;
  };
  github = new GitHub({ clientId: fake.clientId, webUrl: fake.url, apiUrl: fake.url, store, gh: async () => undefined, fetch: recording });
  fake.rateLimitedUntil = undefined;
});

const repoName = () => gitIn(dir, "remote", "get-url", "origin").trim().replace(/^.*\/ada\/(.*)\.git$/, "$1");
const issuesOf = () => fake.issues("ada", repoName());
const open = () => new IssueStore(dir, github, async () => ({ owner: "ada", name: repoName(), url: `${fake.url}/ada/${repoName()}` }));

/** A repository with a few issues, a pull request, comments, labels and a milestone. */
function seed() {
  const data = issuesOf();
  data.milestones.push({ number: 1, title: "Second draft", state: "open" });
  const hole = fake.addIssue("ada", repoName(), { title: "Ada can't be on the bridge and at the station", labels: ["kind/continuity", "char/ada"], milestone: 1 });
  fake.comment(hole, "The clock in chapter two says otherwise.");
  const research = fake.addIssue("ada", repoName(), { title: "Research 1920s rail timetables", labels: ["kind/research"] });
  fake.addIssue("ada", repoName(), { title: "A pull request", pullRequest: true });
  const done = fake.addIssue("ada", repoName(), { title: "Rename the ferry", labels: ["kind/idea"] });
  fake.touch(done, { state: "closed" });
  return { hole, research, done };
}

describe("issues", () => {
  it("brings the repository's issues, comments, labels and milestones into the cache, not its pull requests", async () => {
    seed();
    const issues = open();
    expect(await issues.refresh()).toBe(true);
    const { issues: open_, labels, milestones, status } = await issues.list();
    expect(open_.map((i) => i.title)).toEqual(["Research 1920s rail timetables", "Ada can't be on the bridge and at the station"]);
    expect(open_[1]).toMatchObject({ number: 1, state: "open", labels: ["kind/continuity", "char/ada"], milestone: 1, author: "ada", commentCount: 1, url: `${fake.url}/ada/${repoName()}/issues/1` });
    expect(labels.map((l) => l.name).sort()).toEqual(["char/ada", "kind/continuity", "kind/idea", "kind/research"]);
    expect(milestones).toEqual([{ number: 1, title: "Second draft", state: "open" }]);
    expect(status).toMatchObject({ repo: { owner: "ada" }, refreshedAt: expect.any(String) });
    expect((await issues.get(1)).comments.map((c) => c.body)).toEqual(["The clock in chapter two says otherwise."]);
  });

  it("filters by state, labels, milestone and words in the title, body or comments", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    const titles = async (f: Parameters<IssueStore["list"]>[0]) => (await issues.list(f)).issues.map((i) => i.number);
    expect(await titles({ state: "all" })).toEqual([4, 2, 1]);
    expect(await titles({ state: "closed" })).toEqual([4]);
    expect(await titles({ labels: ["kind/continuity", "char/ada"] })).toEqual([1]);
    expect(await titles({ labels: ["kind/continuity", "kind/research"] })).toEqual([]);
    expect(await titles({ milestone: 1 })).toEqual([1]);
    expect(await titles({ milestone: "none" })).toEqual([2]);
    expect(await titles({ text: "CLOCK chapter" })).toEqual([1]);
    expect(await titles({ text: "timetables", state: "all" })).toEqual([2]);
  });

  it("asks only for what changed: an unchanged repository is answered 304, a change on github.com is picked up", async () => {
    const { research } = seed();
    const issues = open();
    await issues.refresh();
    // The first refresh with a `since` learns its ETag; from then on, nothing changed costs only 304s.
    expect(await issues.refresh()).toBe(false);
    answers = [];
    expect(await issues.refresh()).toBe(false);
    expect(answers.every((a) => a.startsWith("304 ")), answers.join("\n")).toBe(true);
    expect(answers).toHaveLength(4);

    fake.touch(research, { title: "Research 1912 rail timetables" });
    fake.comment(research, "The Bradshaw for 1912 is in the library.");
    answers = [];
    expect(await issues.refresh()).toBe(true);
    expect(answers.filter((a) => a.startsWith("200 ")).map((a) => a.split("?")[0])).toEqual([`200 /repos/ada/${repoName()}/issues`, `200 /repos/ada/${repoName()}/issues/comments`]);
    expect(answers.find((a) => a.includes("/issues?"))).toContain("since=");
    expect((await issues.get(2)).title).toBe("Research 1912 rail timetables");
    expect((await issues.get(2)).comments.map((c) => c.body)).toEqual(["The Bradshaw for 1912 is in the library."]);
  });

  it("creates, edits, comments on, closes and reopens issues on GitHub, and the cache follows at once", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    let heard = 0;
    issues.onChange(() => heard++);

    const made = await issues.create({ title: "  The ferry's name changes in chapter four  ", body: "It's *Marta* in chapter one.", labels: ["kind/continuity"], milestone: 1 });
    expect(made).toMatchObject({ number: 5, title: "The ferry's name changes in chapter four", labels: ["kind/continuity"], milestone: 1, state: "open" });
    // On GitHub with gh-writer's marker hidden after it; in gh-writer without.
    expect(issuesOf().issues.find((i) => i.number === 5)).toMatchObject({ body: expect.stringMatching(/^It's \*Marta\* in chapter one\.\n\n<!-- gh-writer-create: [\w-]+ -->$/), user: "ada" });
    expect(made.body).toBe("It's *Marta* in chapter one.");

    await issues.update(5, { title: "The ferry is Marta, not Martha", labels: ["kind/continuity", "kind/revision"] });
    const comment = await issues.comment(5, "Fixed in chapter four.");
    expect(comment).toMatchObject({ body: "Fixed in chapter four.", author: "ada" });
    await issues.update(5, { state: "closed" });
    expect(issuesOf().issues.find((i) => i.number === 5)).toMatchObject({ title: "The ferry is Marta, not Martha", state: "closed", labels: ["kind/continuity", "kind/revision"] });
    expect(await issues.get(5)).toMatchObject({ state: "closed", comments: [{ body: "Fixed in chapter four." }] });
    expect(issuesOf().labels.map((l) => l.name)).toContain("kind/revision");
    await issues.update(5, { state: "open", milestone: null });
    expect(await issues.get(5)).toMatchObject({ state: "open", milestone: null });
    expect(heard).toBeGreaterThanOrEqual(5);

    await expect(issues.create({ title: "  " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(issues.update(99, { state: "closed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the cache in the clone's .git, not the novel, and serves it after a restart without GitHub", async () => {
    seed();
    await open().refresh();
    expect(existsSync(join(dir, ".git", "gh-writer", "issues.json"))).toBe(true);
    expect(gitIn(dir, "status", "--porcelain")).toBe("");
    await store.delete();
    const again = open();
    expect((await again.list()).issues).toHaveLength(2);
    await expect(again.create({ title: "Offline" })).rejects.toMatchObject({ code: "NO_SIGN_IN" });
  });

  it("a refresh asked for while one is under way sees what happened since that one began", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    slow = 40;
    const first = issues.refresh();
    await new Promise((r) => setTimeout(r, 10));
    fake.addIssue("ada", repoName(), { title: "Added meanwhile" });
    const second = issues.refresh();
    await Promise.all([first, second]);
    expect((await issues.list()).issues.map((i) => i.title)).toContain("Added meanwhile");
  });

  it("reports a rate limit with when it resets, and keeps serving the cache", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    fake.rateLimitedUntil = Math.floor(Date.now() / 1000) + 600;
    const error = (await issues.refresh().catch((e: unknown) => e)) as IssuesError;
    expect(error).toMatchObject({ code: "RATE_LIMITED", resetAt: new Date(fake.rateLimitedUntil * 1000).toISOString() });
    expect((await issues.status()).error).toMatchObject({ code: "RATE_LIMITED", resetAt: error.resetAt });
    expect((await issues.list()).issues).toHaveLength(2);
    fake.rateLimitedUntil = undefined;
    await issues.refresh();
    expect((await issues.status()).error).toBeUndefined();
  });

  it("has nothing, and refuses changes, for a novel that isn't on GitHub", async () => {
    const issues = new IssueStore(dir, github, async () => null);
    expect(await issues.refresh()).toBe(false);
    expect((await issues.list()).issues).toEqual([]);
    await expect(issues.create({ title: "x" })).rejects.toMatchObject({ code: "NOT_ON_GITHUB" });
  });
});

describe("labels for bible entries", () => {
  const withNovel = () => new IssueStore(dir, github, async () => ({ owner: "ada", name: repoName(), url: `${fake.url}/ada/${repoName()}` }), () => loadNovel(nodeSource(dir)));

  it("makes an entry's or a kind's label with its colour when an issue first uses it", async () => {
    seed();
    const issues = withNovel();
    await issues.refresh();
    await issues.create({ title: "What does Ada know?", labels: ["char/ada-varn", "kind/idea"] });
    expect(issuesOf().labels.find((l) => l.name === "char/ada-varn")).toEqual({ name: "char/ada-varn", color: "1f77b4", description: "Ada Varn · char_7f3k2q" });
    expect(issuesOf().labels.find((l) => l.name === "kind/idea")).toMatchObject({ color: "a2eeef" });
  });

  it("follows a rename: the label is renamed on GitHub, its issues keep it; one GitHub made by itself gets its colour", async () => {
    seed();
    const issues = withNovel();
    await issues.refresh();
    const made = await issues.create({ title: "What does Ada know?", labels: ["char/ada-varn"] });
    // Labelled on github.com by name, before gh-writer made the label: GitHub made it, uncoloured.
    fake.addIssue("ada", repoName(), { title: "Ben's debts", labels: ["char/ben-varn"] });
    const ada = join(dir, "bible/characters/ada.md");
    writeFileSync(ada, readFileSync(ada, "utf8").replace("name: Ada Varn", "name: Ada Kost"));
    await issues.refresh();
    expect(issuesOf().labels.map((l) => l.name)).toContain("char/ada-kost");
    expect(issuesOf().labels.map((l) => l.name)).not.toContain("char/ada-varn");
    expect(issuesOf().issues.find((i) => i.number === made.number)?.labels).toEqual(["char/ada-kost"]);
    expect((await issues.get(made.number)).labels).toEqual(["char/ada-kost"]);
    expect(issuesOf().labels.find((l) => l.name === "char/ben-varn")).toEqual({ name: "char/ben-varn", color: "1f77b4", description: "Ben Varn · char_b3n0vs" });
  });

  it("deletes a label (a deleted entry's): its issues lose it", async () => {
    seed();
    const issues = withNovel();
    await issues.refresh();
    const made = await issues.create({ title: "Ada?", labels: ["char/ada-varn", "kind/idea"] });
    await issues.deleteLabel("char/ada-varn");
    expect(issuesOf().labels.map((l) => l.name)).not.toContain("char/ada-varn");
    expect(issuesOf().issues.find((i) => i.number === made.number)?.labels).toEqual(["kind/idea"]);
    expect((await issues.get(made.number)).labels).toEqual(["kind/idea"]);
  });
});

describe("milestones and labels", () => {
  it("makes, renames, closes and reopens milestones on GitHub, the cache following", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    const made = await issues.createMilestone({ title: "  First draft  " });
    expect(made).toEqual({ number: 2, title: "First draft", state: "open" });
    expect(issuesOf().milestones.find((m) => m.number === 2)).toMatchObject({ title: "First draft" });
    await issues.updateMilestone(2, { title: "First full draft" });
    await issues.updateMilestone(2, { state: "closed" });
    expect(issuesOf().milestones.find((m) => m.number === 2)).toEqual({ number: 2, title: "First full draft", state: "closed" });
    expect((await issues.list()).milestones).toEqual([
      { number: 1, title: "Second draft", state: "open" },
      { number: 2, title: "First full draft", state: "closed" },
    ]);
    await expect(issues.createMilestone({ title: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    offline = true;
    await expect(issues.createMilestone({ title: "Offline" })).rejects.toMatchObject({ code: "OFFLINE" });
  });

  it("makes a label with its colour once", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    await issues.ensureLabel({ name: "kind/idea-new", color: "a2eeef", description: "x" });
    await issues.ensureLabel({ name: "kind/idea-new", color: "000000", description: "y" });
    expect(issuesOf().labels.filter((l) => l.name === "kind/idea-new")).toEqual([{ name: "kind/idea-new", color: "a2eeef", description: "x" }]);
  });
});

describe("offline", () => {
  /** Let background sends (a queued change tries straight away) settle. */
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("makes changes in the cache and queues them, through a restart, then sends them in order once back", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    offline = true;
    const made = await issues.create({ title: "Check the tide tables", body: "For the flood.", labels: ["kind/research"] });
    expect(made).toMatchObject({ number: -1, title: "Check the tide tables", pending: true, url: "" });
    await issues.comment(-1, "High tide at 6.");
    await issues.update(-1, { labels: ["kind/research", "loc/varn"] });
    await issues.update(1, { state: "closed" });
    const c = await issues.comment(1, "Fixed offline.");
    expect(c).toMatchObject({ id: -3, pending: true });
    await settle();
    expect(await issues.status()).toMatchObject({ queued: 5, failed: [], error: { code: "OFFLINE" } });
    expect((await issues.list()).issues.map((i) => [i.number, i.pending ?? false])).toEqual([[-1, true], [2, false]]);
    expect(await issues.get(1)).toMatchObject({ state: "closed", pending: true, comments: [{ body: "The clock in chapter two says otherwise." }, { body: "Fixed offline.", pending: true }] });
    expect(issuesOf().issues).toHaveLength(4);

    // gh-writer restarts: the queue is still there.
    const again = open();
    expect((await again.status()).queued).toBe(5);
    offline = false;
    expect(await again.refresh()).toBe(true);
    expect(await again.status()).toMatchObject({ queued: 0, failed: [] });
    expect((await again.status()).error).toBeUndefined();
    const tide = issuesOf().issues.find((i) => i.title === "Check the tide tables")!;
    expect(tide).toMatchObject({ number: 5, labels: ["kind/research", "loc/varn"], comments: [{ body: "High tide at 6." }] });
    expect(issuesOf().issues.find((i) => i.number === 1)).toMatchObject({ state: "closed", comments: [{}, { body: "Fixed offline." }] });
    // Its temporary number still finds it.
    expect(await again.get(-1)).toMatchObject({ number: 5, body: "For the flood." });
    expect((await again.get(5)).pending).toBeUndefined();
    expect((await again.get(1)).comments.every((x) => !x.pending && x.id > 0)).toBe(true);
    expect(issuesOf().issues.filter((i) => i.title === "Check the tide tables")).toHaveLength(1);
  });

  it("never makes an issue twice when GitHub's answer to making it was lost", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    loseNext = `POST /repos/ada/${repoName()}/issues`;
    const made = await issues.create({ title: "Did this get made?" });
    expect(made.number).toBe(-1);
    await settle();
    await issues.refresh();
    expect(issuesOf().issues.filter((i) => i.title === "Did this get made?")).toHaveLength(1);
    expect(await issues.get(-1)).toMatchObject({ number: 5, title: "Did this get made?" });
    expect((await issues.status()).queued).toBe(0);
  });

  it("queues while rate limited too", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    fake.rateLimitedUntil = Math.floor(Date.now() / 1000) + 600;
    expect(await issues.update(2, { state: "closed" })).toMatchObject({ state: "closed", pending: true });
    fake.rateLimitedUntil = undefined;
    await issues.refresh();
    expect(issuesOf().issues.find((i) => i.number === 2)?.state).toBe("closed");
  });

  it("keeps a change GitHub refuses, says why, sends the rest, and drops it when asked", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    offline = true;
    await issues.update(2, { title: "Timetables" });
    await issues.comment(1, "Still here.");
    await settle();
    // Meanwhile, #2 is deleted on github.com.
    issuesOf().issues.splice(issuesOf().issues.findIndex((i) => i.number === 2), 1);
    offline = false;
    await issues.refresh();
    const status = await issues.status();
    expect(status).toMatchObject({ queued: 0, failed: [{ description: "Change to #2", error: expect.stringContaining("doesn't have") }] });
    expect(issuesOf().issues.find((i) => i.number === 1)?.comments.map((x) => x.body)).toContain("Still here.");
    await issues.discard(status.failed[0]!.id);
    expect((await issues.status()).failed).toEqual([]);
  });
});

describe("raising an issue about a passage", () => {
  const STATION = "manuscript/01-return/01-arrival/01-the-station.md";
  const quote = "Twelve years had not moved the station clock.";
  const kind = { name: "kind/plot-hole", color: "d73a4a", description: "Something that can't happen" };

  it("quotes the passage, links the scene at its commit and line, labels its kind, and hides the anchor", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    const made = await issues.raise({ path: STATION, scene: "sc_5tat1n", sceneTitle: "The Station", quote, title: "The clock ran fast, or slow?", details: "Chapter two says slow.", kind, labels: ["char/ada"] });
    const commit = gitIn(dir, "rev-parse", "HEAD").trim();
    const line = readFileSync(join(dir, STATION), "utf8").split("\n").findIndex((l) => l.includes(quote)) + 1;
    expect(line).toBeGreaterThan(0);
    const onGitHub = issuesOf().issues.find((i) => i.number === made.number)!;
    expect(onGitHub.labels).toEqual(["kind/plot-hole", "char/ada"]);
    expect(onGitHub.body).toContain(`Chapter two says slow.\n\n> ${quote}\n\nFrom [*The Station*](${fake.url}/ada/${repoName()}/blob/${commit}/${STATION}?plain=1#L${line}).`);
    expect(readAnchor(onGitHub.body)).toEqual({ scene: "sc_5tat1n", quote, commit });
    // The kind's label, made with its colour once.
    expect(issuesOf().labels.find((l) => l.name === "kind/plot-hole")).toEqual(kind);
    await issues.raise({ path: STATION, scene: "sc_5tat1n", sceneTitle: "The Station", quote, title: "Again", kind });
    expect(issuesOf().labels.filter((l) => l.name === "kind/plot-hole")).toHaveLength(1);
  });

  it("is queued like any change while GitHub can't be reached", async () => {
    seed();
    const issues = open();
    await issues.refresh();
    offline = true;
    const made = await issues.raise({ path: STATION, scene: "sc_5tat1n", sceneTitle: "The Station", quote, title: "Offline note", kind });
    expect(made).toMatchObject({ number: -1, pending: true, labels: ["kind/plot-hole"] });
    expect(readAnchor(made.body)?.scene).toBe("sc_5tat1n");
    // The queued raise's own try, still offline, settles first.
    await new Promise((r) => setTimeout(r, 50));
    offline = false;
    await issues.refresh();
    expect(issuesOf().issues.find((i) => i.title === "Offline note")?.labels).toEqual(["kind/plot-hole"]);
    await expect(issues.raise({ path: STATION, scene: "sc_5tat1n", sceneTitle: "The Station", quote: "  ", title: "Nothing" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("through the server", () => {
  it("lists, filters, creates, changes and comments over HTTP, with refusals as codes", async () => {
    seed();
    const library = await Library.open({ configDir: fresh("config") });
    const novel = await library.add(dir);
    const server = await createServer({ library, token: "t", github, sync: false, commit: false });
    const headers = { cookie: `${sessionCookie(server.port)}=t`, origin: server.url, "content-type": "application/json" };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await send(server.port, `/api/novels/${novel.id}/issues${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
    };
    try {
      expect((await call("POST", "/refresh")).body).toMatchObject({ changed: true });
      const listed = await call("GET", "?labels=kind/continuity&q=clock");
      expect((listed.body.issues as { number: number }[]).map((i) => i.number)).toEqual([1]);
      expect((await call("GET", "?state=closed")).body.issues).toHaveLength(1);
      const made = await call("POST", "", { title: "Check the tide tables", labels: ["kind/research"], extra: "ignored" });
      expect(made).toMatchObject({ status: 201, body: { number: 5, title: "Check the tide tables" } });
      expect((await call("PATCH", "/5", { state: "closed" })).body).toMatchObject({ state: "closed" });
      expect((await call("POST", "/5/comments", { body: "Done." })).status).toBe(201);
      expect((await call("GET", "/5")).body).toMatchObject({ comments: [{ body: "Done." }] });
      expect(await call("GET", "/99")).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
      expect(await call("POST", "", { title: "" })).toMatchObject({ status: 400, body: { code: "BAD_REQUEST" } });
      fake.rateLimitedUntil = Math.floor(Date.now() / 1000) + 60;
      expect(await call("POST", "/refresh")).toMatchObject({ status: 429, body: { code: "RATE_LIMITED", resetAt: expect.any(String) } });
    } finally {
      fake.rateLimitedUntil = undefined;
      await server.close();
    }
  });
});
