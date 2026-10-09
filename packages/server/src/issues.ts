import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entityLabel, entityOfLabel, ISSUE_KINDS, kindLabel, kindOf, passageIssueBody, type Novel } from "@gh-writer/core";
import { git } from "./git.ts";
import { GitHubError, unreachable, type GitHub, type GitHubRepo } from "./github.ts";

/*
 * A novel's GitHub issues (#8), as gh-writer keeps them: fetched from the novel's repository and
 * cached per clone in .git/gh-writer/issues.json (never committed: issues are work, not story facts,
 * D1), so they're there offline and cost few API calls. Changes go to GitHub, and its answer goes
 * into the cache. Changes made while GitHub can't be reached are made in the cache at once, queued
 * there, and sent in order once it can (#112).
 */

export interface IssueComment {
  /** GitHub's ID; negative for one made offline and not sent yet. */
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  /** Made offline, not on GitHub yet. */
  pending?: boolean;
}

export interface Issue {
  /** GitHub's number; negative for one made offline, until it's sent (then the negative one finds it). */
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  /** Its milestone's number, or null. */
  milestone: number | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Its page on GitHub. */
  url: string;
  commentCount: number;
  comments: IssueComment[];
  /** Changes made offline and not on GitHub yet. */
  pending?: boolean;
  /** The marker of the queued create that made it (hidden in its body on GitHub), so a resend adopts it. */
  marker?: string;
}

/** A change made while GitHub couldn't be reached, waiting to be sent. */
export interface QueuedChange {
  id: string;
  /** For the author: "New issue “…”", "Comment on #12", "Change to #12". */
  description: string;
  /** When it was made (ISO): also the time it shows in the cache until sent. */
  at: string;
  change:
    | { kind: "create"; key: number; marker: string; input: IssueInput & { title: string } }
    | { kind: "update"; number: number; input: IssueInput }
    | { kind: "comment"; number: number; key: number; body: string };
  /** Why GitHub refused it, if it did: kept for the author, not sent again. */
  error?: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Milestone {
  number: number;
  title: string;
  state: "open" | "closed";
}

export type IssuesErrorCode = "NOT_ON_GITHUB" | "NO_SIGN_IN" | "OFFLINE" | "RATE_LIMITED" | "NOT_FOUND" | "BAD_REQUEST" | "GITHUB";

export class IssuesError extends Error {
  readonly code: IssuesErrorCode;
  /** For RATE_LIMITED: when GitHub will answer again (ISO). */
  readonly resetAt: string | undefined;

  constructor(code: IssuesErrorCode, message: string, resetAt?: string) {
    super(message);
    this.name = "IssuesError";
    this.code = code;
    this.resetAt = resetAt;
  }
}

/** How the cache stands: when it was last brought up to date, and why the last refresh failed, if it did. */
export interface IssuesStatus {
  repo: GitHubRepo | null;
  refreshedAt: string | null;
  error?: { code: IssuesErrorCode; message: string; resetAt?: string };
  /** Changes made offline, waiting to be sent. */
  queued: number;
  /** Changes GitHub refused: kept until the author drops them. */
  failed: { id: string; description: string; error: string }[];
}

export interface IssueFilter {
  state?: "open" | "closed" | "all";
  /** All of these labels. */
  labels?: string[];
  /** A milestone's number, or "none" for issues without one. */
  milestone?: number | "none";
  /** Words that must all appear in the title, body or comments (any case). */
  text?: string;
}

/** An issue about a passage of a scene (#9). */
export interface Passage {
  /** The scene file, relative to the novel. */
  path: string;
  /** The scene's ID (sc_…) and title. */
  scene: string;
  sceneTitle: string;
  quote: string;
  title: string;
  details?: string;
  /** Its kind, as a label made on the repository with this colour when first used. */
  kind?: Label;
  labels?: string[];
}

export interface IssueInput {
  title?: string;
  body?: string;
  labels?: string[];
  milestone?: number | null;
  state?: "open" | "closed";
}

interface Cache {
  /** owner/name: a cache for another repository is started afresh. */
  repo: string;
  refreshedAt: string | null;
  /** The newest updated_at seen, for the next refresh's `since`. */
  since: string | null;
  etags: Record<string, string>;
  issues: Issue[];
  labels: Label[];
  milestones: Milestone[];
  /** Changes made offline, in the order made. */
  outbox: QueuedChange[];
  /** An offline issue's temporary (negative) number → its number on GitHub, once sent. */
  renumbered: Record<string, number>;
  /** The next temporary number (or comment ID): -1, -2, … */
  nextKey: number;
}

const PER_PAGE = 100;
const MARKER = /\n*<!-- gh-writer-create: ([\w-]+) -->\s*$/;

export class IssueStore {
  readonly root: string;
  #github: GitHub;
  #repo: () => Promise<GitHubRepo | null>;
  #cache: Cache | undefined;
  #file: string | undefined;
  #status: IssuesStatus = { repo: null, refreshedAt: null, queued: 0, failed: [] };
  #refreshing: Promise<boolean> | undefined;
  #again: Promise<boolean> | undefined;
  #listeners = new Set<() => void>();
  #used = new Set<string>();
  #saving: Promise<void> = Promise.resolve();

  #novel: (() => Promise<Novel>) | undefined;

  /** `novel`: the story model, for the labels of kinds and bible entries (made, renamed to follow their entries). */
  constructor(root: string, github: GitHub, repo: () => Promise<GitHubRepo | null>, novel?: () => Promise<Novel>) {
    this.root = root;
    this.#github = github;
    this.#repo = repo;
    this.#novel = novel;
  }

  /** Hear when the cached issues change. Returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  async status(): Promise<IssuesStatus> {
    await this.#load();
    return this.#status;
  }

  /** The cached issues matching `filter`, most recently updated first, without their comments. */
  async list(filter: IssueFilter = {}): Promise<{ issues: Omit<Issue, "comments">[]; labels: Label[]; milestones: Milestone[]; status: IssuesStatus }> {
    const cache = await this.#load();
    const state = filter.state ?? "open";
    const words = (filter.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const issues = cache.issues
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => (filter.labels ?? []).every((l) => i.labels.includes(l)))
      .filter((i) => filter.milestone === undefined || (filter.milestone === "none" ? i.milestone === null : i.milestone === filter.milestone))
      .filter((i) => {
        if (!words.length) return true;
        const text = [i.title, i.body, ...i.comments.map((c) => c.body)].join("\n").toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
      .map(({ comments: _, ...rest }) => rest);
    return { issues, labels: cache.labels, milestones: cache.milestones, status: this.#status };
  }

  /** One cached issue with its comments. */
  async get(number: number): Promise<Issue> {
    await this.#load();
    const issue = this.#cache!.issues.find((i) => i.number === this.#resolve(number));
    if (!issue) throw new IssuesError("NOT_FOUND", `No issue #${number}.`);
    return issue;
  }

  /**
   * Bring the cache up to date: issues and comments changed since the last refresh, and the labels and
   * milestones (ETags make an unchanged list nearly free). Resolves to whether anything changed; a
   * failure is kept in the status (and thrown) while the cache keeps serving.
   */
  refresh(): Promise<boolean> {
    // Asked again while one is under way: that one may have started before what's asked about
    // happened, so one more follows it (shared by everyone asking meanwhile).
    if (this.#refreshing) {
      this.#again ??= this.#refreshing
        .catch(() => false)
        .then(() => {
          this.#again = undefined;
          return this.refresh();
        });
      return this.#again;
    }
    this.#refreshing = this.#refresh().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async create(input: IssueInput & { title: string }): Promise<Issue> {
    if (!input.title.trim()) throw new IssuesError("BAD_REQUEST", "An issue needs a title.");
    const repo = await this.#requireRepo();
    const fields = { ...clean(input), title: input.title.trim() } as IssueInput & { title: string };
    await this.#ensureKnown(input.labels);
    // Marked from the first try: if GitHub makes it but its answer is lost, the resend finds it.
    const marker = randomUUID();
    const sent = await this.#direct(() => this.#send(repo, "/issues", "POST", { ...fields, body: withMarker(fields.body, marker) }));
    if (sent) return this.#upsert(fromIssue(sent as GhIssue), []);
    const key = this.#cache!.nextKey--;
    return this.#queue({ kind: "create", key, marker, input: fields }, `New issue “${fields.title}”`, key);
  }

  async update(number: number, input: IssueInput): Promise<Issue> {
    if (input.title !== undefined && !input.title.trim()) throw new IssuesError("BAD_REQUEST", "An issue needs a title.");
    const repo = await this.#requireRepo();
    const n = this.#resolve(number);
    if (!this.#cache!.issues.some((i) => i.number === n)) throw new IssuesError("NOT_FOUND", `No issue #${number}.`);
    const fields = clean(input);
    await this.#ensureKnown(input.labels);
    // An issue made offline can only be changed in the queue, after it.
    const sent = n > 0 ? await this.#direct(() => this.#send(repo, `/issues/${n}`, "PATCH", fields)) : undefined;
    if (sent) return this.#upsert(fromIssue(sent as GhIssue), this.#cache!.issues.find((i) => i.number === n)?.comments ?? []);
    return this.#queue({ kind: "update", number: n, input: fields }, `Change to ${label(n)}`, n);
  }

  async comment(number: number, body: string): Promise<IssueComment> {
    if (!body.trim()) throw new IssuesError("BAD_REQUEST", "A comment needs some text.");
    const repo = await this.#requireRepo();
    const n = this.#resolve(number);
    if (!this.#cache!.issues.some((i) => i.number === n)) throw new IssuesError("NOT_FOUND", `No issue #${number}.`);
    const sent = n > 0 ? await this.#direct(() => this.#send(repo, `/issues/${n}/comments`, "POST", { body })) : undefined;
    if (sent) {
      const comment = fromComment(sent as GhComment);
      this.#addComment(n, comment);
      await this.#save();
      this.#changed();
      return comment;
    }
    const key = this.#cache!.nextKey--;
    const issue = await this.#queue({ kind: "comment", number: n, key, body }, `Comment on ${label(n)}`, n);
    return issue.comments.find((c) => c.id === key)!;
  }

  /**
   * Raise an issue about a passage: its body has the note, the passage quoted and a link to the scene
   * on GitHub at the latest commit holding it (at the passage's line when found there), and the
   * hidden anchor gh-writer finds the passage by (D1). Queued like any other while offline.
   */
  async raise(passage: Passage): Promise<Issue> {
    if (!passage.quote.trim()) throw new IssuesError("BAD_REQUEST", "Select the passage the issue is about.");
    const repo = await this.#requireRepo();
    if (passage.kind) await this.ensureLabel(passage.kind);
    const where = await this.#permalink(repo, passage.path, passage.quote).catch(() => undefined);
    const body = passageIssueBody({
      details: passage.details ?? "",
      quote: passage.quote,
      sceneTitle: passage.sceneTitle,
      ...(where ? { link: where.link } : {}),
      anchor: { scene: passage.scene, quote: passage.quote, ...(where ? { commit: where.commit } : {}) },
    });
    const labels = [...new Set([...(passage.kind ? [passage.kind.name] : []), ...(passage.labels ?? [])])];
    return this.create({ title: passage.title, body, labels });
  }

  /** Delete a label from the repository (an entry's, once the entry is gone): its issues lose it. */
  async deleteLabel(name: string): Promise<void> {
    const repo = await this.#requireRepo();
    const res = await this.#call(`${apiPath(repo)}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.status !== 404) await check(res);
    const cache = this.#cache!;
    cache.labels = cache.labels.filter((l) => l.name !== name);
    for (const i of cache.issues) i.labels = i.labels.filter((l) => l !== name);
    await this.#save();
    this.#changed();
  }

  /** What a label of gh-writer's should be: a kind's, or a bible entry's (by its current name). */
  async #known(name: string): Promise<Label | undefined> {
    const kind = kindOf(name);
    if (kind) return { name, color: kind.color, description: kind.description };
    if (!this.#novel || !name.includes("/")) return undefined;
    const novel = await this.#novel().catch(() => undefined);
    const entity = novel && entityOfLabel(novel, { name });
    return entity && entityLabel(novel, entity);
  }

  /** Make the kind and entry labels among `labels` that the repository doesn't have yet, with their colours. */
  async #ensureKnown(labels: string[] | undefined): Promise<void> {
    for (const name of labels ?? []) {
      if (this.#cache!.labels.some((l) => l.name === name)) continue;
      const def = await this.#known(name);
      if (def) await this.ensureLabel(def);
    }
  }

  /**
   * Keep entry and kind labels as they should be: an entry renamed (here, elsewhere or offline) has
   * its label renamed, so its issues stay with it; one GitHub made by itself (from a change sent
   * offline) gets its colour and description. Returns whether anything changed.
   */
  async #reconcileLabels(repo: GitHubRepo): Promise<boolean> {
    const cache = this.#cache!;
    const novel = this.#novel ? await this.#novel().catch(() => undefined) : undefined;
    let changed = false;
    for (const label of [...cache.labels]) {
      const kind = kindOf(label.name);
      const entity = !kind && novel ? entityOfLabel(novel, label) : undefined;
      const want = kind ? { name: label.name, color: kind.color, description: kind.description } : entity && novel ? entityLabel(novel, entity) : undefined;
      if (!want || (want.name === label.name && want.color === label.color && want.description === label.description)) continue;
      // Another label already has the name it should have: leave both.
      if (want.name !== label.name && cache.labels.some((l) => l.name === want.name)) continue;
      try {
        await this.#send(repo, `/labels/${encodeURIComponent(label.name)}`, "PATCH", { new_name: want.name, color: want.color, description: want.description });
      } catch {
        continue;
      }
      cache.labels = cache.labels.map((l) => (l.name === label.name ? want : l));
      if (want.name !== label.name) for (const i of cache.issues) i.labels = i.labels.map((l) => (l === label.name ? want.name : l));
      changed = true;
    }
    return changed;
  }

  /** Make a milestone on GitHub (it needs GitHub: milestones aren't queued offline). */
  async createMilestone(input: { title: string; description?: string }): Promise<Milestone> {
    if (!input.title.trim()) throw new IssuesError("BAD_REQUEST", "A milestone needs a name.");
    const repo = await this.#requireRepo();
    const made = (await this.#send(repo, "/milestones", "POST", { title: input.title.trim(), ...(input.description ? { description: input.description } : {}) })) as Milestone;
    return this.#keepMilestone(made);
  }

  /** Rename, close or reopen a milestone on GitHub. */
  async updateMilestone(number: number, input: { title?: string; state?: "open" | "closed" }): Promise<Milestone> {
    if (input.title !== undefined && !input.title.trim()) throw new IssuesError("BAD_REQUEST", "A milestone needs a name.");
    const repo = await this.#requireRepo();
    const body = { ...(input.title !== undefined ? { title: input.title.trim() } : {}), ...(input.state ? { state: input.state } : {}) };
    return this.#keepMilestone((await this.#send(repo, `/milestones/${number}`, "PATCH", body)) as Milestone);
  }

  async #keepMilestone({ number, title, state }: Milestone): Promise<Milestone> {
    const cache = this.#cache!;
    const milestone = { number, title, state };
    cache.milestones = [...cache.milestones.filter((m) => m.number !== number), milestone].sort((a, b) => a.number - b.number);
    await this.#save();
    this.#changed();
    return milestone;
  }

  /** Make a label on the repository if it isn't there yet, with its colour (best effort: GitHub makes a missing one anyway). */
  async ensureLabel(label: Label): Promise<void> {
    const cache = await this.#load();
    const repo = this.#status.repo;
    if (!repo || cache.labels.some((l) => l.name === label.name)) return;
    try {
      const made = (await this.#send(repo, "/labels", "POST", { name: label.name, color: label.color, description: label.description })) as Label;
      cache.labels = [...cache.labels.filter((l) => l.name !== made.name), { name: made.name, color: made.color, description: made.description ?? "" }];
      await this.#save();
      this.#changed();
    } catch {
      // Already there (made meanwhile), or GitHub can't be reached: the issue still gets the label.
    }
  }

  /** The scene file on GitHub at the latest commit that has it, at the passage's first line if found there. */
  async #permalink(repo: GitHubRepo, path: string, quote: string): Promise<{ commit: string; link: string } | undefined> {
    const g = git(this.root);
    const commit = (await g.raw(["log", "-1", "--format=%H", "--", path])).trim();
    if (!commit) return undefined;
    const inRepo = `${(await g.raw(["rev-parse", "--show-prefix"])).trim()}${path}`;
    const text = await g.raw(["show", `${commit}:${inRepo}`]).catch(() => "");
    const first = quote.trim().split("\n")[0]!.slice(0, 80);
    const line = first ? text.split("\n").findIndex((l) => l.includes(first)) + 1 : 0;
    const file = inRepo.split("/").map(encodeURIComponent).join("/");
    return { commit, link: `${repo.url}/blob/${commit}/${file}${line ? `?plain=1#L${line}` : ""}` };
  }

  /** Drop a queued change (one GitHub refused): what it made in the cache goes with it. */
  async discard(id: string): Promise<void> {
    const cache = await this.#load();
    const q = cache.outbox.find((x) => x.id === id);
    if (!q) throw new IssuesError("NOT_FOUND", "No such change waiting.");
    cache.outbox = cache.outbox.filter((x) => x !== q);
    if (q.change.kind === "create") {
      const key = q.change.key;
      cache.issues = cache.issues.filter((i) => i.number !== key);
      // Its later changes can't happen now.
      cache.outbox = cache.outbox.filter((x) => !(x.change.kind !== "create" && x.change.number === key));
    }
    if (q.change.kind === "comment") {
      const key = q.change.key;
      for (const i of cache.issues) i.comments = i.comments.filter((c) => c.id !== key);
    }
    this.#updateStatus();
    await this.#save();
    this.#changed();
    // What GitHub has comes back with the next refresh.
    void this.refresh().catch(() => {});
  }

  /**
   * Send a change straight to GitHub when nothing is queued before it; undefined when it has to be
   * queued (GitHub unreachable or rate limited, or earlier changes still waiting).
   */
  async #direct(send: () => Promise<unknown>): Promise<unknown> {
    if (this.#cache!.outbox.length) return undefined;
    try {
      return await send();
    } catch (e) {
      if (queueable(e)) return undefined;
      throw e;
    }
  }

  /** Queue a change, make it in the cache now, and try to send the queue. Resolves to the issue it touches. */
  async #queue(change: QueuedChange["change"], description: string, number: number): Promise<Issue> {
    const cache = this.#cache!;
    const q: QueuedChange = { id: randomUUID(), description, at: new Date().toISOString(), change };
    cache.outbox.push(q);
    this.#applyLocal(q);
    this.#updateStatus();
    await this.#save();
    this.#changed();
    // Back online already? The refresh sends the queue.
    void this.refresh().catch(() => {});
    return cache.issues.find((i) => i.number === number)!;
  }

  /** Make a queued change in the cache (again, after a refresh brought GitHub's version back). */
  #applyLocal(q: QueuedChange): void {
    const cache = this.#cache!;
    const c = q.change;
    if (c.kind === "create") {
      if (cache.issues.some((i) => i.number === c.key)) return;
      cache.issues.push({
        number: c.key,
        title: c.input.title,
        body: c.input.body ?? "",
        state: c.input.state ?? "open",
        labels: c.input.labels ?? [],
        milestone: c.input.milestone ?? null,
        author: "",
        createdAt: q.at,
        updatedAt: q.at,
        closedAt: null,
        url: "",
        commentCount: 0,
        comments: [],
        pending: true,
      });
      return;
    }
    const issue = cache.issues.find((i) => i.number === this.#resolve(c.number));
    if (!issue) return;
    issue.pending = true;
    if (q.at > issue.updatedAt) issue.updatedAt = q.at;
    if (c.kind === "update") {
      const { title, body, labels, milestone, state } = c.input;
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      if (labels !== undefined) issue.labels = labels;
      if (milestone !== undefined) issue.milestone = milestone;
      if (state !== undefined) {
        issue.state = state;
        issue.closedAt = state === "closed" ? q.at : null;
      }
      return;
    }
    if (!issue.comments.some((x) => x.id === c.key)) {
      issue.comments.push({ id: c.key, body: c.body, author: "", createdAt: q.at, updatedAt: q.at, url: "", pending: true });
      issue.commentCount += 1;
    }
  }

  /**
   * Send the queue, in order, after a refresh (so the cache knows what GitHub has). A create whose
   * marker is already on GitHub (its answer was lost) is adopted, not made again. Unreachable, rate
   * limited or signed out: stop, and try again next time. Refused: kept with the reason, and the rest go on.
   */
  async #flush(repo: GitHubRepo): Promise<boolean> {
    const cache = this.#cache!;
    let changed = false;
    for (const q of [...cache.outbox]) {
      if (q.error) continue;
      const c = q.change;
      try {
        if (c.kind === "create") {
          const adopted = cache.issues.find((i) => i.number > 0 && i.marker === c.marker);
          const issue = adopted ?? fromIssue((await this.#send(repo, "/issues", "POST", { ...c.input, body: withMarker(c.input.body, c.marker) })) as GhIssue);
          cache.renumbered[String(c.key)] = issue.number;
          cache.issues = cache.issues.filter((i) => i.number !== c.key);
          if (!adopted) this.#upsert(issue, [], { quiet: true });
        } else {
          const n = this.#resolve(c.number);
          if (n < 0) {
            q.error = "Its issue couldn't be made on GitHub.";
            changed = true;
            continue;
          }
          if (c.kind === "update") {
            const json = (await this.#send(repo, `/issues/${n}`, "PATCH", c.input)) as GhIssue;
            this.#upsert(fromIssue(json), cache.issues.find((i) => i.number === n)?.comments.filter((x) => !x.pending) ?? [], { quiet: true });
          } else {
            const comment = fromComment((await this.#send(repo, `/issues/${n}/comments`, "POST", { body: c.body })) as GhComment);
            for (const i of cache.issues) i.comments = i.comments.filter((x) => x.id !== c.key);
            this.#addComment(n, comment);
          }
        }
        cache.outbox = cache.outbox.filter((x) => x !== q);
        changed = true;
      } catch (e) {
        const error = asIssuesError(e);
        if (queueable(error) || error.code === "NO_SIGN_IN") break;
        q.error = error.message;
        changed = true;
      }
    }
    // What's still waiting shows in the cache over GitHub's version.
    for (const q of cache.outbox) if (!q.error) this.#applyLocal(q);
    for (const i of cache.issues) if (i.pending && !cache.outbox.some((q) => !q.error && touches(q, i.number, (n) => this.#resolve(n)))) delete i.pending;
    return changed;
  }

  #addComment(number: number, comment: IssueComment): void {
    const issue = this.#cache!.issues.find((i) => i.number === number);
    if (!issue) return;
    issue.comments = [...issue.comments.filter((c) => c.id !== comment.id), comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    issue.commentCount = Math.max(issue.commentCount, issue.comments.filter((c) => !c.pending).length);
    if (comment.updatedAt > issue.updatedAt) issue.updatedAt = comment.updatedAt;
  }

  /** An issue's number now: a temporary one that has been sent becomes its number on GitHub. */
  #resolve(number: number): number {
    return number < 0 ? (this.#cache?.renumbered[String(number)] ?? number) : number;
  }

  #updateStatus(): void {
    const outbox = this.#cache?.outbox ?? [];
    this.#status = {
      ...this.#status,
      queued: outbox.filter((q) => !q.error).length,
      failed: outbox.flatMap((q) => (q.error ? [{ id: q.id, description: q.description, error: q.error }] : [])),
    };
  }

  async #refresh(): Promise<boolean> {
    const cache = await this.#load();
    const repo = this.#status.repo;
    if (!repo) return false;
    try {
      const since = cache.since;
      const q = since ? `&since=${encodeURIComponent(since)}` : "";
      let changed = false;
      const issues = await this.#pages<GhIssue>(repo, `/issues?state=all&sort=updated&direction=asc${q}`);
      if (issues) {
        for (const json of issues) {
          // GitHub lists pull requests with the issues: they aren't the novel's issues.
          if (json.pull_request) continue;
          const known = cache.issues.find((i) => i.number === json.number);
          const issue = fromIssue(json);
          // `since` takes in the newest one again each time: only a real change counts.
          if (known && JSON.stringify({ ...known, comments: [] }) === JSON.stringify(issue)) continue;
          this.#upsert(issue, known?.comments ?? [], { quiet: true });
          changed = true;
        }
      }
      const comments = await this.#pages<GhComment>(repo, `/issues/comments?sort=updated&direction=asc${q}`);
      if (comments) {
        for (const json of comments) {
          const number = Number(/\/issues\/(\d+)$/.exec(json.issue_url)?.[1]);
          const issue = cache.issues.find((i) => i.number === number);
          if (!issue) continue;
          const c = fromComment(json);
          const known = issue.comments.find((x) => x.id === c.id);
          if (known && JSON.stringify(known) === JSON.stringify(c)) continue;
          issue.comments = [...issue.comments.filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          changed = true;
        }
      }
      const labels = await this.#pages<Label>(repo, "/labels?");
      if (labels) {
        const next = labels.map(({ name, color, description }) => ({ name, color, description: description ?? "" }));
        changed ||= JSON.stringify(next) !== JSON.stringify(cache.labels);
        cache.labels = next;
      }
      const milestones = await this.#pages<{ number: number; title: string; state: "open" | "closed" }>(repo, "/milestones?state=all");
      if (milestones) {
        const next = milestones.map(({ number, title, state }) => ({ number, title, state }));
        changed ||= JSON.stringify(next) !== JSON.stringify(cache.milestones);
        cache.milestones = next;
      }
      if (await this.#reconcileLabels(repo)) changed = true;
      if (await this.#flush(repo)) changed = true;
      // Only the ETags this refresh used: an old `since` won't be asked for again.
      cache.etags = Object.fromEntries(Object.entries(cache.etags).filter(([url]) => this.#used.has(url)));
      this.#used.clear();
      // GitHub's own times only: not those of changes still queued here.
      const sent = cache.issues.filter((i) => i.number > 0 && !i.pending);
      const newest = [...sent.map((i) => i.updatedAt), ...sent.flatMap((i) => i.comments.filter((c) => !c.pending).map((c) => c.updatedAt))].sort().at(-1);
      cache.since = newest ?? cache.since;
      cache.refreshedAt = new Date().toISOString();
      this.#status = { repo, refreshedAt: cache.refreshedAt, queued: 0, failed: [] };
      this.#updateStatus();
      await this.#save();
      if (changed) this.#changed();
      return changed;
    } catch (e) {
      const error = asIssuesError(e);
      this.#status = { ...this.#status, error: { code: error.code, message: error.message, ...(error.resetAt ? { resetAt: error.resetAt } : {}) } };
      // GitHub's answers so far are in the cache; what's queued still shows over them.
      for (const q of cache.outbox) if (!q.error) this.#applyLocal(q);
      this.#changed();
      throw error;
    }
  }

  /**
   * Every page of a list, or undefined when GitHub says the first page hasn't changed (304 to its
   * ETag): then nothing in it has, as far as gh-writer needs to know.
   */
  async #pages<T>(repo: GitHubRepo, path: string): Promise<T[] | undefined> {
    const cache = this.#cache!;
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.endsWith("?") ? "" : "&";
      const url = `${apiPath(repo)}${path}${sep}per_page=${PER_PAGE}&page=${page}`;
      // Only the first page's ETag: a 304 there means the whole list is as it was.
      const etagKey = page === 1 ? url : undefined;
      const etag = etagKey ? cache.etags[etagKey] : undefined;
      if (etagKey) this.#used.add(etagKey);
      const res = await this.#call(url, { ...(etag ? { headers: { "If-None-Match": etag } } : {}) });
      if (res.status === 304) return undefined;
      await check(res);
      if (etagKey) {
        const fresh = res.headers.get("etag");
        if (fresh) cache.etags[etagKey] = fresh;
      }
      const items = (await res.json()) as T[];
      out.push(...items);
      if (items.length < PER_PAGE) return out;
    }
  }

  async #send(repo: GitHubRepo, path: string, method: string, body: unknown): Promise<unknown> {
    const res = await this.#call(`${apiPath(repo)}${path}`, { method, body });
    await check(res);
    return res.json();
  }

  async #call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    try {
      return await this.#github.api(path, init);
    } catch (e) {
      throw asIssuesError(e);
    }
  }

  #upsert(issue: Issue, comments: IssueComment[], { quiet = false } = {}): Issue {
    const cache = this.#cache!;
    const merged = { ...issue, comments };
    cache.issues = [...cache.issues.filter((i) => i.number !== issue.number), merged];
    if (!quiet) {
      void this.#save().catch(() => {});
      this.#changed();
    }
    return merged;
  }

  async #requireRepo(): Promise<GitHubRepo> {
    await this.#load();
    if (!this.#status.repo) throw new IssuesError("NOT_ON_GITHUB", "This novel isn't on GitHub.");
    return this.#status.repo;
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  /** The cache for the novel's current repository (a novel put on GitHub, or moved, starts afresh). */
  async #load(): Promise<Cache> {
    const repo = await this.#repo();
    const key = repo ? `${repo.owner}/${repo.name}` : "";
    this.#status = { ...this.#status, repo };
    if (this.#cache && this.#cache.repo === key) return this.#cache;
    this.#file ??= join(await gitDir(this.root), "gh-writer", "issues.json");
    const saved = await readFile(this.#file, "utf8")
      .then((t) => JSON.parse(t) as Cache)
      .catch(() => undefined);
    const fresh: Cache = { repo: key, refreshedAt: null, since: null, etags: {}, issues: [], labels: [], milestones: [], outbox: [], renumbered: {}, nextKey: -1 };
    this.#cache = saved && saved.repo === key ? { ...fresh, ...saved } : fresh;
    this.#status = { repo, refreshedAt: this.#cache.refreshedAt, queued: 0, failed: [] };
    this.#updateStatus();
    return this.#cache;
  }

  /** Write the cache, one write at a time (each with its own temporary file), the last one winning. */
  #save(): Promise<void> {
    // A write that failed doesn't stop the next one.
    this.#saving = this.#saving.catch(() => {}).then(async () => {
      if (!this.#cache || !this.#file) return;
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#cache));
      await rename(tmp, this.#file);
    });
    return this.#saving;
  }
}

async function gitDir(root: string): Promise<string> {
  return (await git(root).raw(["rev-parse", "--absolute-git-dir"])).trim();
}

const apiPath = (repo: GitHubRepo) => `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/** Only the fields given, as GitHub takes them. */
function clean(input: IssueInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title.trim();
  if (input.body !== undefined) out.body = input.body;
  if (input.labels !== undefined) out.labels = input.labels;
  if (input.milestone !== undefined) out.milestone = input.milestone;
  if (input.state !== undefined) out.state = input.state;
  return out;
}

/** Worth queuing rather than refusing: GitHub will take it later. */
function queueable(e: unknown): boolean {
  const error = asIssuesError(e);
  return error.code === "OFFLINE" || error.code === "RATE_LIMITED";
}

/** A new issue's body with gh-writer's marker after it (an HTML comment: invisible on github.com). */
const withMarker = (body: string | undefined, marker: string) => `${body ?? ""}\n\n<!-- gh-writer-create: ${marker} -->`;

const label = (n: number) => (n > 0 ? `#${n}` : "a new issue");

/** Whether a queued change is about issue `number`. */
function touches(q: QueuedChange, number: number, resolve: (n: number) => number): boolean {
  return q.change.kind === "create" ? resolve(q.change.key) === number || q.change.key === number : resolve(q.change.number) === number;
}

/** A GitHub answer that isn't a success, as an IssuesError. */
async function check(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429)) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
    throw new IssuesError("RATE_LIMITED", "GitHub has had enough requests from gh-writer for now.", resetAt);
  }
  if (res.status === 404) throw new IssuesError("NOT_FOUND", "GitHub doesn't have that (or doesn't let this sign-in see it).");
  if (res.status === 422) throw new IssuesError("BAD_REQUEST", `GitHub refused it: ${body.message ?? "invalid"}.`);
  if (res.status === 403) throw new IssuesError("NO_SIGN_IN", `GitHub refused: ${body.message ?? "not allowed"}. Reconnect GitHub with the permissions gh-writer asks for.`);
  throw new IssuesError("GITHUB", `GitHub answered ${res.status}${body.message ? `: ${body.message}` : ""}.`);
}

function asIssuesError(e: unknown): IssuesError {
  if (e instanceof IssuesError) return e;
  if (e instanceof GitHubError) return new IssuesError(e.code === "NO_SIGN_IN" ? "NO_SIGN_IN" : "GITHUB", e.message);
  if (unreachable(e)) return new IssuesError("OFFLINE", "GitHub can't be reached right now.");
  return new IssuesError("GITHUB", e instanceof Error ? e.message : String(e));
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: ({ name: string } | string)[];
  milestone: { number: number } | null;
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  pull_request?: unknown;
}

interface GhComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  issue_url: string;
}

function fromIssue(j: GhIssue): Issue {
  const raw = j.body ?? "";
  const marker = MARKER.exec(raw)?.[1];
  return {
    number: j.number,
    title: j.title,
    // The marker of an issue gh-writer queued offline is for gh-writer only.
    body: marker ? raw.replace(MARKER, "") : raw,
    state: j.state,
    labels: j.labels.map((l) => (typeof l === "string" ? l : l.name)),
    milestone: j.milestone?.number ?? null,
    author: j.user?.login ?? "",
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    closedAt: j.closed_at,
    url: j.html_url,
    commentCount: j.comments,
    comments: [],
    ...(marker ? { marker } : {}),
  };
}

function fromComment(j: GhComment): IssueComment {
  return { id: j.id, body: j.body ?? "", author: j.user?.login ?? "", createdAt: j.created_at, updatedAt: j.updated_at, url: j.html_url };
}
