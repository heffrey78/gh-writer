import { countWords, loadNovel, parseMarkdown } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import type { Committer } from "./committer.ts";
import { atomicWrite, writablePath } from "./files.ts";
import { git } from "./git.ts";

/** Checkpoints are annotated tags under this prefix; sync fetches and pushes them. */
export const CHECKPOINT_PREFIX = "refs/tags/checkpoint/";

/** What "the whole manuscript" means for a restore: the prose and the story bible. */
const RESTORED_PATHS = ["manuscript", "bible"];

const WORDS_TRAILER = "Words";
const AUTO_TRAILER = "Checkpoint";

export interface Checkpoint {
  /** The tag without its "checkpoint/" prefix, e.g. "2026-10-05-183012-before-the-big-cut": the id in URLs. */
  id: string;
  name: string;
  /** When it was made (ISO). */
  date: string;
  /** Manuscript words at the checkpoint. */
  words: number;
  /** Taken by gh-writer itself (before a restore), not named by the author. */
  auto: boolean;
  commit: string;
}

export interface RestoreResult {
  /** The checkpoint taken just before the restore: restoring it undoes the restore. */
  undo: Checkpoint;
  /** The commit that made the restore, or null if nothing differed. */
  commit: string | null;
  /** The files the restore changed, relative to the novel. */
  files: string[];
}

export type CheckpointErrorCode = "BAD_NAME" | "NOT_FOUND" | "SCENE_NOT_FOUND" | "BLOCKED";

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;

  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

export interface CheckpointDeps {
  /** Commits saved work, so a checkpoint holds everything written up to it. */
  committer: Committer;
  /** Runs a restore with writes and background commits held off. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Told when a checkpoint is made, so the next sync pushes it. */
  onCreate?: () => void;
  /** Clock for the date in tag names (tests). */
  now?: () => Date;
}

/**
 * Named checkpoints of a novel: annotated git tags checkpoint/<date>-<slug>, carrying the name and the
 * word count. The manuscript (manuscript/ and bible/), or one scene, can be restored from one; every
 * restore first takes an automatic checkpoint, which undoes it.
 */
export class Checkpoints {
  readonly root: string;
  #committer: Committer;
  #exclusive: NonNullable<CheckpointDeps["exclusive"]>;
  #onCreate: () => void;
  #now: () => Date;

  constructor(root: string, { committer, exclusive, onCreate = () => {}, now = () => new Date() }: CheckpointDeps) {
    this.root = root;
    this.#committer = committer;
    this.#exclusive = exclusive ?? ((fn) => committer.hold(fn));
    this.#onCreate = onCreate;
    this.#now = now;
  }

  /** Newest first: tag names start with a time that only goes up (see #create). */
  async list(): Promise<Checkpoint[]> {
    const out = await git(this.root).raw([
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname)%00%(creatordate:iso-strict)%00%(*objectname)%00%(objectname)%00%(contents)%1e",
      CHECKPOINT_PREFIX,
    ]);
    return out
      .split("\x1e")
      .map((r) => r.replace(/^\n/, ""))
      .filter(Boolean)
      .map((record) => {
        const [ref, date, peeled, object, contents = ""] = record.split("\0");
        const [subject = "", ...rest] = contents.trim().split("\n");
        const trailer = (key: string) => rest.map((l) => new RegExp(`^${key}: *(.*)$`).exec(l)?.[1]).find((v) => v !== undefined);
        return {
          id: ref!.slice(CHECKPOINT_PREFIX.length),
          name: subject,
          date: date!,
          words: Number(trailer(WORDS_TRAILER) ?? 0),
          auto: trailer(AUTO_TRAILER) === "auto",
          // A lightweight tag (made by hand) points at the commit itself.
          commit: peeled || object!,
        };
      });
  }

  async get(id: string): Promise<Checkpoint> {
    const found = (await this.list()).find((c) => c.id === id);
    if (!found) throw new CheckpointError("NOT_FOUND", `No checkpoint "${id}".`);
    return found;
  }

  /** Commit saved work and mark it with `name`. */
  create(name: string): Promise<Checkpoint> {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 200) return Promise.reject(new CheckpointError("BAD_NAME", "Give the checkpoint a name of 1 to 200 characters."));
    return this.#exclusive(() => this.#create(clean, false));
  }

  /**
   * Bring back the whole manuscript (manuscript/ and bible/), or with `sceneId` that one scene, as it was
   * at checkpoint `id`. The scene is found by its ID, so it's restored where it is now even if it moved;
   * a scene since deleted comes back where it was. Restoring `undo` from the result undoes it.
   */
  restore(id: string, { sceneId }: { sceneId?: string } = {}): Promise<RestoreResult> {
    return this.#exclusive(async () => {
      const checkpoint = await this.get(id);
      const tag = `${CHECKPOINT_PREFIX}${id}`;
      const scene = sceneId === undefined ? undefined : await this.#sceneAt(tag, sceneId);
      const what = scene ? `“${scene.title}”` : "the manuscript";
      const undo = await this.#create(`Before restoring ${what} from “${checkpoint.name}”`, true);
      const g = git(this.root);

      let paths: string[];
      if (scene) {
        const target = (await this.#currentScenePath(sceneId!)) ?? scene.path;
        // The same checks as a save: a plain path inside the novel, no symlinks.
        await atomicWrite(await writablePath(this.root, target, scene.content), scene.content);
        await g.raw(["add", "--", target]);
        paths = [target];
      } else {
        // Paths in neither the checkpoint nor the work tree would be an error for git.
        paths = [];
        for (const p of RESTORED_PATHS) {
          const atCheckpoint = (await g.raw(["ls-tree", "--name-only", tag, "--", p])).trim();
          const now = (await g.raw(["ls-files", "--", p])).trim();
          if (atCheckpoint || now) paths.push(p);
        }
        // Removes what the checkpoint didn't have, in the index and the work tree.
        if (paths.length) await g.raw(["restore", `--source=${tag}`, "--staged", "--worktree", "--", ...paths]);
      }

      const files = paths.length ? (await g.raw(["diff", "--cached", "--name-only", "--relative", "--", ...paths])).split("\n").filter(Boolean) : [];
      if (!files.length) return { undo, commit: null, files };
      const message = `Restore ${scene ? `scene ${what}` : what} from checkpoint “${checkpoint.name}”`;
      await g.raw(["commit", "--quiet", "--no-verify", "-m", message, "--", ...paths]);
      return { undo, commit: (await g.raw(["rev-parse", "HEAD"])).trim(), files };
    });
  }

  async #create(name: string, auto: boolean): Promise<Checkpoint> {
    const result = await this.#committer.commit();
    if ("skipped" in result && result.skipped !== "NOTHING") {
      const blocked = (await this.#committer.status()).blocked;
      throw new CheckpointError("BLOCKED", `Your latest work couldn't be committed, so no checkpoint was made. ${blocked?.message ?? ""}`.trim());
    }
    const words = await this.#words();
    const g = git(this.root);
    // A second after the newest checkpoint at the latest, so names sort in the order they were made even
    // within one second (a restore right after a checkpoint) or after the clock steps back.
    const stamps = (await g.raw(["tag", "--list", "checkpoint/*"])).split("\n").map((t) => STAMP.exec(t.slice("checkpoint/".length))?.[0]);
    const newest = stamps.filter((s) => s !== undefined).sort().at(-1);
    let at = this.#now();
    if (newest && stamp(at) <= newest) at = new Date(parseStamp(newest).getTime() + 1000);
    const tag = `checkpoint/${stamp(at)}-${slug(name)}`;
    const trailers = [`${WORDS_TRAILER}: ${words}`, ...(auto ? [`${AUTO_TRAILER}: auto`] : [])];
    await g.raw(["tag", "--annotate", "-m", name, "-m", trailers.join("\n"), tag, "HEAD"]);
    this.#onCreate();
    return this.get(tag.slice("checkpoint/".length));
  }

  /** Manuscript words in the work tree, which matches HEAD once saved work is committed. */
  async #words(): Promise<number> {
    const novel = await loadNovel(nodeSource(this.root));
    return novel.allScenes.reduce((sum, scene) => sum + countWords(scene.body), 0);
  }

  async #sceneAt(tag: string, sceneId: string): Promise<{ path: string; title: string; content: string }> {
    const g = git(this.root);
    const files = (await g.raw(["ls-tree", "-r", "-z", "--name-only", tag, "--", "manuscript"])).split("\0").filter((f) => f.endsWith(".md"));
    for (const path of files) {
      const content = await g.raw(["show", `${tag}:./${path}`]);
      const { data } = parseMarkdown(content, path);
      const fm = (data ?? {}) as { id?: unknown; title?: unknown };
      if (fm.id === sceneId) return { path, title: typeof fm.title === "string" ? fm.title : sceneId, content };
    }
    throw new CheckpointError("SCENE_NOT_FOUND", `The checkpoint has no scene "${sceneId}".`);
  }

  async #currentScenePath(sceneId: string): Promise<string | undefined> {
    const novel = await loadNovel(nodeSource(this.root));
    return novel.allScenes.find((s) => s.id === sceneId)?.file;
  }
}

/** UTC date and time, for tag names that sort: 2026-10-05-183012. */
function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace("T", "-").replaceAll(":", "");
}

const STAMP = /^\d{4}-\d{2}-\d{2}-\d{6}/;

function parseStamp(s: string): Date {
  return new Date(`${s.slice(0, 10)}T${s.slice(11, 13)}:${s.slice(13, 15)}:${s.slice(15, 17)}Z`);
}

/** A tag-safe slug of the name: "Before the big cut" → "before-the-big-cut". */
function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "checkpoint";
}
