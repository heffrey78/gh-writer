import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { countWords, parseMarkdown, wordChange, writingDays, type CommitWords } from "@gh-writer/core";
import type { Hono } from "hono";
import { body, operation, type Env } from "./bible-routes.ts";
import { gitPlumbing } from "./git.ts";

/*
 * The novel's writing history (#20, D8): for every commit reachable from HEAD that changed scenes,
 * the words it added and removed, word-diffed against its parent. Merges are skipped: the commits
 * they join are counted themselves. Results are kept per commit in the clone's .git, so only new
 * commits are diffed; a fresh clone works them all out again, the same.
 */

/** Bumped when the counting changes, so cached results from an older method are worked out again. */
const METHOD = 1;
const CACHE = "gh-writer/stats.json";
const EMPTY = "0".repeat(40);

interface Cache {
  method: number;
  commits: Record<string, { date: string; added: number; removed: number }>;
}

/** One scene file a commit changed: its blob before and after (undefined: not there). */
interface Change {
  before?: string;
  after?: string;
  path: string;
}

const isScene = (path: string) => path.startsWith("manuscript/") && path.endsWith(".md");

/** What each commit since the start did to the manuscript, oldest first. */
export async function writingHistory(root: string): Promise<CommitWords[]> {
  const log = await gitPlumbing(root, ["log", "--reverse", "--no-merges", "--root", "-M", "--raw", "-z", "--no-abbrev", "--relative", "--format=%x01%H%x00%aI", "HEAD", "--", "manuscript"]).catch(
    // No commits yet.
    () => Buffer.alloc(0),
  );
  const commits = parseLog(log.toString("utf8"));
  const cacheFile = join(await gitDir(root), CACHE);
  const cache = await readCache(cacheFile);

  const todo = commits.filter((c) => !cache.commits[c.commit]);
  if (todo.length) {
    const blobs = [...new Set(todo.flatMap((c) => c.changes.flatMap((ch) => [ch.before, ch.after]).filter((b): b is string => b !== undefined)))];
    const texts = await readBlobs(root, blobs);
    const body = (oid: string | undefined, path: string) => {
      if (oid === undefined) return undefined;
      const text = texts.get(oid) ?? "";
      return /^---\r?\n/.test(text) ? parseMarkdown(text, path).body : text;
    };
    for (const c of todo) {
      let added = 0;
      let removed = 0;
      for (const ch of c.changes) {
        const change = wordChange(body(ch.before, ch.path), body(ch.after, ch.path));
        added += change.added;
        removed += change.removed;
      }
      cache.commits[c.commit] = { date: c.date, added, removed };
    }
    await writeCache(cacheFile, cache);
  }
  return commits.map((c) => ({ commit: c.commit, ...cache.commits[c.commit]! }));
}

/** git log's records: each commit's hash, author date and the scene files it changed. */
function parseLog(out: string): { commit: string; date: string; changes: Change[] }[] {
  const commits: { commit: string; date: string; changes: Change[] }[] = [];
  for (const record of out.split("\x01").slice(1)) {
    const fields = record.split("\0");
    const [commit, date] = [fields[0]!, fields[1]!];
    const changes: Change[] = [];
    for (let i = 2; i < fields.length; i++) {
      const header = fields[i]!.replace(/^\n/, "");
      if (!header.startsWith(":")) continue;
      const [, , before, after, status = ""] = header.slice(1).split(" ");
      const copied = status.startsWith("R") || status.startsWith("C");
      const from = fields[++i]!;
      const to = copied ? fields[++i]! : from;
      // A scene moved in or out of the manuscript counts as added or removed; within it, as itself.
      // A copy leaves its source where it was: only the new file is new.
      const [was, now] = [isScene(from), isScene(to)];
      if (!was && !now) continue;
      changes.push({
        path: now ? to : from,
        ...(was && before !== EMPTY && !status.startsWith("C") ? { before } : {}),
        ...(now && after !== EMPTY ? { after } : {}),
      });
    }
    commits.push({ commit, date, changes });
  }
  return commits;
}

/** Blobs' texts by object ID, with one git process. */
async function readBlobs(root: string, oids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!oids.length) return out;
  const data = await gitPlumbing(root, ["cat-file", "--batch"], { input: `${oids.join("\n")}\n` });
  let at = 0;
  for (const oid of oids) {
    const header = data.indexOf(0x0a, at);
    const [, type, size] = data.subarray(at, header).toString().split(" ");
    if (type === "missing" || size === undefined) {
      at = header + 1;
      continue;
    }
    out.set(oid, data.subarray(header + 1, header + 1 + Number(size)).toString("utf8"));
    at = header + 1 + Number(size) + 1;
  }
  return out;
}

async function gitDir(root: string): Promise<string> {
  return (await gitPlumbing(root, ["rev-parse", "--absolute-git-dir"])).toString().trim();
}

async function readCache(file: string): Promise<Cache> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as Cache;
    if (cache.method === METHOD && cache.commits && typeof cache.commits === "object") return cache;
  } catch {
    // None yet, or unreadable: worked out again.
  }
  return { method: METHOD, commits: {} };
}

async function writeCache(file: string, cache: Cache): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  // Another request may be writing it too: each writes a whole file of its own, then renames.
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(temp, JSON.stringify(cache));
  await rename(temp, file);
}

/**
 * GET /:id/stats  { days, words, target }: the open version's writing days (words added, removed, net,
 * and the book's length at each day's end), the manuscript's words now (as saved), and novel.yaml's target.
 */
export function statsRoutes(routes: Hono<Env>): void {
  /** PUT /:id/target  { words?, date?, daily? } (null removes one) → { commit, files }: novel.yaml's targets, one commit. */
  routes.put("/:id/target", async (c) => {
    const raw = await body(c);
    const pick = (k: string) => (k in raw ? (raw[k] as never) : undefined);
    return operation(c, () => c.var.ws.bible.updateTarget({ words: pick("words"), date: pick("date"), daily: pick("daily") }));
  });

  routes.get("/:id/stats", async (c) => {
    const { novel } = await c.var.ws.loadModel();
    const words = novel.allScenes.reduce((n, s) => n + countWords(s.body), 0);
    const days = writingDays(await writingHistory(c.var.ws.root), words);
    return c.json({ days, words, target: novel.config?.target ?? null });
  });
}
