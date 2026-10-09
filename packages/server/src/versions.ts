import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNovel } from "@gh-writer/core";
import { slug, wordsIn, type Checkpoint, type Checkpoints } from "./checkpoints.ts";
import { operationInProgress, type Committer } from "./committer.ts";
import { commitSource } from "./git-source.ts";
import { git } from "./git.ts";

/*
 * Alternate versions of a novel (#17, D7): a different ending, a cut subplot, written alongside the
 * main version. Each is a git branch version/<slug> in the novel's clone, its name kept as the
 * branch's description; the main version is the branch the novel lives on. Only one is open at a
 * time: switching checks the other out, and the app sees the files change as it would after a sync.
 */

export const VERSION_PREFIX = "version/";

export interface Version {
  /** "main" for the main version; otherwise the slug after version/. */
  id: string;
  name: string;
  main: boolean;
  /** The one open now. */
  current: boolean;
  /** Made on another computer and not opened here yet: switching to it brings it here. */
  remoteOnly: boolean;
  /** The manuscript's words at its latest commit. */
  words: number;
  /** When it last changed (ISO): its latest commit. */
  date: string;
  commit: string;
}

export interface DiscardResult {
  /** The automatic checkpoint the version is kept as: restoring it brings the text back. */
  checkpoint: Checkpoint;
  /** The version open after discarding (the main version, if the discarded one was open). */
  current: string;
}

export type VersionErrorCode = "BAD_NAME" | "NOT_FOUND" | "MAIN" | "BLOCKED" | "BUSY";

export class VersionError extends Error {
  readonly code: VersionErrorCode;

  constructor(code: VersionErrorCode, message: string) {
    super(message);
    this.name = "VersionError";
    this.code = code;
  }
}

export interface VersionsDeps {
  committer: Committer;
  checkpoints: Checkpoints;
  /** Runs a change to the work tree with writes and background commits held off. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Told when the open version changes, or one is made or discarded, so sync can carry it. */
  onChange?: () => void;
}

/** Versions discarded here whose copy on the remote the next sync deletes, kept in the clone's .git. */
const DISCARDED = "gh-writer/discarded-versions.json";

export class Versions {
  readonly root: string;
  #committer: Committer;
  #checkpoints: Checkpoints;
  #exclusive: NonNullable<VersionsDeps["exclusive"]>;
  #onChange: () => void;
  /** Words at a commit, which never change. */
  #words = new Map<string, number>();

  constructor(root: string, { committer, checkpoints, exclusive, onChange = () => {} }: VersionsDeps) {
    this.root = root;
    this.#committer = committer;
    this.#checkpoints = checkpoints;
    this.#exclusive = exclusive ?? ((fn) => committer.hold(fn));
    this.#onChange = onChange;
  }

  /** The main version first, then the others by name. */
  async list(): Promise<Version[]> {
    const state = await this.#state();
    const discarded = await this.#discarded();
    const found = new Map<string, { commit: string; date: string; remoteOnly: boolean }>();
    for (const [branch, ref] of state.local) {
      if (branch === state.main || branch.startsWith(VERSION_PREFIX)) found.set(branch, { ...ref, remoteOnly: false });
    }
    // Versions on the remote not made here yet.
    for (const [branch, ref] of state.onRemote) {
      if (branch.startsWith(VERSION_PREFIX) && !found.has(branch) && !discarded.includes(branch)) found.set(branch, { ...ref, remoteOnly: true });
    }
    const versions: Version[] = [];
    for (const [branch, { commit, date, remoteOnly }] of found) {
      const isMain = branch === state.main;
      versions.push({
        id: isMain ? "main" : branch.slice(VERSION_PREFIX.length),
        name: isMain ? "Main version" : (state.descriptions.get(branch) ?? humanise(branch)),
        main: isMain,
        current: branch === state.current,
        remoteOnly,
        words: await this.#wordsAt(commit),
        date,
        commit,
      });
    }
    return versions.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name));
  }

  /** The open version's ID, or null when the novel is on some other branch (or none). */
  async current(): Promise<string | null> {
    const { current, main } = await this.#state();
    if (current === main) return "main";
    return current?.startsWith(VERSION_PREFIX) ? current.slice(VERSION_PREFIX.length) : null;
  }

  /**
   * Start a version called `name` from the one open now (its saved work committed first), or from
   * checkpoint `from` (a discarded version brought back), and open it. The first sync puts it on the remote.
   */
  start(name: string, { from }: { from?: string } = {}): Promise<Version> {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 100) return Promise.reject(new VersionError("BAD_NAME", "Give the version a name of 1 to 100 characters."));
    return this.#change(async () => {
      const g = git(this.root);
      const taken = new Set((await this.list()).map((v) => v.id));
      const base = slug(clean, "version");
      let id = base;
      for (let n = 2; taken.has(id) || id === "main"; n++) id = `${base}-${n}`;
      const branch = `${VERSION_PREFIX}${id}`;
      const start = from === undefined ? "HEAD" : (await this.#checkpoints.get(from)).commit;
      await g.raw(["switch", "--quiet", "--no-track", "-c", branch, start]);
      await g.raw(["config", `branch.${branch}.description`, clean]);
      return this.#get(id);
    });
  }

  /** Open version `id` (saved work in the one open now is committed first). */
  switch(id: string): Promise<Version> {
    return this.#change(async () => {
      const version = await this.#get(id);
      if (version.current) return version;
      const g = git(this.root);
      const branch = await this.#branch(version);
      if (version.remoteOnly) {
        const remote = await this.#remote();
        await g.raw(["switch", "--quiet", "--track", "-c", branch, `${remote}/${branch}`]);
      } else {
        await g.raw(["switch", "--quiet", branch]);
      }
      return this.#get(id);
    });
  }

  /**
   * Discard version `id`: it's kept as an automatic checkpoint first (restoring that brings the text
   * back), then the branch goes, here at once and on the remote at the next sync. The main version
   * opens if this one was open.
   */
  discard(id: string): Promise<DiscardResult> {
    return this.#change(async () => {
      const version = await this.#get(id);
      if (version.main) throw new VersionError("MAIN", "The main version can't be discarded.");
      const g = git(this.root);
      const branch = await this.#branch(version);
      const checkpoint = await this.#checkpoints.keep(`Discarded version “${version.name}”`, version.commit);
      if (version.current) await g.raw(["switch", "--quiet", await this.mainBranch()]);
      if (!version.remoteOnly) await g.raw(["branch", "--quiet", "-D", branch]);
      const remote = await this.#remote();
      if (remote && (await g.raw(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]).catch(() => "")).trim()) {
        await this.#setDiscarded([...new Set([...(await this.#discarded()), branch])]);
      }
      return { checkpoint, current: (await this.current()) ?? "main" };
    });
  }

  /** The branch the novel lives on: the remote's default branch, else main, else master, else the first that isn't a version. */
  async mainBranch(): Promise<string> {
    return (await this.#state()).main;
  }

  /** The open branch, branches here and on the remote, their names and the main one: three git commands. */
  async #state(): Promise<RepoState> {
    const g = git(this.root);
    const [head, refs, config] = await Promise.all([
      g.raw(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
      g.raw(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)", "refs/heads/", "refs/remotes/"]),
      g.raw(["config", "--get-regexp", "^(branch\\..*\\.(description|remote)|remote\\..*\\.url)$"]).catch(() => ""),
    ]);
    const current = head.trim() || undefined;
    const descriptions = new Map<string, string>();
    const branchRemotes = new Map<string, string>();
    const remotes: string[] = [];
    for (const line of config.split("\n").filter(Boolean)) {
      const space = line.indexOf(" ");
      const key = line.slice(0, space);
      const value = line.slice(space + 1);
      // Branch names may hold dots: the key is branch.<name>.<setting>.
      const branch = /^branch\.(.+)\.(description|remote)$/i.exec(key);
      if (branch?.[2] === "description") descriptions.set(branch[1]!, value);
      else if (branch) branchRemotes.set(branch[1]!, value);
      const remote = /^remote\.(.+)\.url$/i.exec(key);
      if (remote) remotes.push(remote[1]!);
    }
    const configured = current ? branchRemotes.get(current) : undefined;
    const remote = configured && remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;

    const local = new Map<string, { commit: string; date: string }>();
    const onRemote = new Map<string, { commit: string; date: string }>();
    let remoteHead: string | undefined;
    for (const line of refs.split("\n").filter(Boolean)) {
      const [ref, commit, date, symref] = line.split("\0") as [string, string, string, string];
      if (ref.startsWith("refs/heads/")) local.set(ref.slice("refs/heads/".length), { commit, date });
      else if (remote && ref.startsWith(`refs/remotes/${remote}/`)) {
        const name = ref.slice(`refs/remotes/${remote}/`.length);
        if (name === "HEAD") remoteHead = symref.slice(`refs/remotes/${remote}/`.length) || undefined;
        else onRemote.set(name, { commit, date });
      }
    }
    const main =
      remoteHead ??
      ["main", "master"].find((b) => local.has(b)) ??
      (current && !current.startsWith(VERSION_PREFIX) ? current : undefined) ??
      [...local.keys()].find((b) => !b.startsWith(VERSION_PREFIX)) ??
      "main";
    return { current, main, remote, local, onRemote, descriptions };
  }

  /** Commit saved work, then make the change with writes held off; tell sync. */
  async #change<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.#exclusive(async () => {
      if (await operationInProgress(this.root)) throw new VersionError("BUSY", "Another change to the novel's history is under way (a sync being settled). Try again once it's finished.");
      const committed = await this.#committer.commit();
      if ("skipped" in committed && committed.skipped !== "NOTHING") {
        const blocked = (await this.#committer.status()).blocked;
        throw new VersionError("BLOCKED", `Your latest work couldn't be saved into the novel's history, so nothing changed. ${blocked?.message ?? ""}`.trim());
      }
      return fn();
    });
    this.#onChange();
    return result;
  }

  async #get(id: string): Promise<Version> {
    const version = (await this.list()).find((v) => v.id === id);
    if (!version) throw new VersionError("NOT_FOUND", `There's no version “${id}”.`);
    return version;
  }

  async #branch(version: Version): Promise<string> {
    return version.main ? this.mainBranch() : `${VERSION_PREFIX}${version.id}`;
  }

  async #wordsAt(commit: string): Promise<number> {
    let words = this.#words.get(commit);
    if (words === undefined) {
      words = wordsIn(await loadNovel(await commitSource(this.root, commit)));
      this.#words.set(commit, words);
    }
    return words;
  }

  /** The remote versions sync with: the open branch's, else origin, else the only one. */
  async #remote(): Promise<string | undefined> {
    return (await this.#state()).remote;
  }

  #discarded(): Promise<string[]> {
    return discardedVersions(this.root);
  }

  #setDiscarded(branches: string[]): Promise<void> {
    return setDiscardedVersions(this.root, branches);
  }
}

/** The name made from a version's ID where it has none (another computer's): "alternate-ending" → "Alternate ending". */
function humanise(branch: string): string {
  const words = branch.slice(VERSION_PREFIX.length).replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A snapshot of the refs and config versions are made of. */
interface RepoState {
  /** The branch checked out, if any. */
  current: string | undefined;
  main: string;
  /** The remote sync uses: the open branch's, else origin, else the only one. */
  remote: string | undefined;
  local: Map<string, { commit: string; date: string }>;
  /** Branches on that remote, as last fetched. */
  onRemote: Map<string, { commit: string; date: string }>;
  /** Names of versions started here. */
  descriptions: Map<string, string>;
}

const gitDirs = new Map<string, string>();

async function gitDir(root: string): Promise<string> {
  let dir = gitDirs.get(root);
  if (!dir) gitDirs.set(root, (dir = (await git(root).raw(["rev-parse", "--absolute-git-dir"])).trim()));
  return dir;
}

/** Branches of versions discarded here, still to be deleted on the remote. */
export async function discardedVersions(root: string): Promise<string[]> {
  const text = await readFile(join(await gitDir(root), DISCARDED), "utf8").catch(() => "[]");
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? list.filter((b): b is string => typeof b === "string" && b.startsWith(VERSION_PREFIX)) : [];
  } catch {
    return [];
  }
}

export async function setDiscardedVersions(root: string, branches: string[]): Promise<void> {
  const file = join(await gitDir(root), DISCARDED);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(branches)}\n`);
}
