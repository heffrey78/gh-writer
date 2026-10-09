import { memorySource, type FileSource } from "@gh-writer/core";
import { gitPlumbing } from "./git.ts";

/*
 * A novel as it was at a commit, for reading without touching the work tree: a version's last
 * commit, a checkpoint, or the latest one. One `git ls-tree` lists it and one `git cat-file --batch`
 * reads the story's files; anything else (images, fonts) is read when asked for.
 */

/** What the loader reads; everything else waits until it's asked for. */
const STORY_FILE = /\.(md|ya?ml|txt|json)$/;

export interface CommitSource extends FileSource {
  /** The commit, in full. */
  commit: string;
}

const cache = new Map<string, CommitSource>();
const CACHE_SIZE = 8;

/** The novel in `root` as it was at `rev` (a commit, branch or tag). Commits don't change, so a few are kept. */
export async function commitSource(root: string, rev: string): Promise<CommitSource> {
  const commit = (await gitPlumbing(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])).toString().trim();
  const key = `${root}\0${commit}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Run from the novel's folder, ls-tree lists that folder of the commit, with paths relative to it.
  const listing = (await gitPlumbing(root, ["ls-tree", "-r", "-z", commit])).toString();
  const blobs = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (match) blobs.set(match[2]!, match[1]!);
  }
  const story = [...blobs].filter(([path]) => STORY_FILE.test(path) && !path.startsWith(".github/"));
  const read = new Set(story.map(([path]) => path));
  const texts = await readBlobs(root, story.map(([, oid]) => oid));
  const files: Record<string, string> = {};
  story.forEach(([path], i) => (files[path] = texts[i]!));
  for (const path of blobs.keys()) files[path] ??= "";

  const listed = memorySource(files);
  const source: CommitSource = {
    commit,
    list: (dir) => listed.list(dir),
    async read(path) {
      const oid = blobs.get(path);
      if (oid === undefined) return undefined;
      return read.has(path) ? files[path] : (await readBlobs(root, [oid]))[0];
    },
  };
  cache.set(key, source);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return source;
}

/** The blobs' contents as text, in order, with one git process. */
async function readBlobs(root: string, oids: string[]): Promise<string[]> {
  if (!oids.length) return [];
  const out = await gitPlumbing(root, ["cat-file", "--batch"], { input: `${oids.join("\n")}\n` });
  const texts: string[] = [];
  let at = 0;
  for (let i = 0; i < oids.length; i++) {
    const header = out.indexOf(0x0a, at);
    // "<oid> blob <size>"
    const size = Number(out.subarray(at, header).toString().split(" ")[2]);
    texts.push(out.subarray(header + 1, header + 1 + size).toString("utf8"));
    at = header + 1 + size + 1;
  }
  return texts;
}
