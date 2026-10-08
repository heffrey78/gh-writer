import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { editYaml, loadNovel, newId } from "@gh-writer/core";
import { nodeSource } from "@gh-writer/core/node";
import { snapshots } from "@gh-writer/core/snapshots";
import { hasGitIdentity } from "./committer.ts";
import { git } from "./git.ts";

/** The novel template in this checkout of gh-writer: the same files a "Use this template" repository gets. */
export const DEFAULT_TEMPLATE = fileURLToPath(new URL("../../../templates/novel", import.meta.url));

/** The template's placeholder IDs, replaced with fresh ones in every new novel (as its init.mjs does on GitHub). */
const TEMPLATE_IDS = ["nv_temp1a", "ch_temp1a", "sc_temp1a"];
const STORY_FILE = /\.(md|ya?ml)$/;
const STORY_ROOTS = ["novel.yaml", "manuscript/", "bible/", "diagrams/"];

export interface NewNovel {
  title: string;
  author?: string;
  /** Who commits, set in the new repository only: for authors whose git doesn't know them yet. */
  identity?: { name: string; email: string };
}

export class NeedsIdentity extends Error {
  constructor() {
    super("git doesn't know your name and email yet, so the novel's history can't be started. Give a name and email for this novel's history.");
    this.name = "NeedsIdentity";
  }
}

/**
 * Fill the empty folder `dest` with a new novel from `template`: fresh IDs, the title and author,
 * diagrams drawn for it, and a git repository on main with the whole of it in a first commit.
 * Throws NeedsIdentity when git has no name and email and none were given; the caller cleans up.
 */
export async function writeNewNovel(template: string, dest: string, { title, author, identity }: NewNovel): Promise<void> {
  const ids = new Map(TEMPLATE_IDS.map((id) => [id, newId(id.split("_")[0]!)]));
  const pattern = new RegExp(`\\b(${TEMPLATE_IDS.join("|")})\\b`, "g");

  for (const file of await files(template)) {
    const to = join(dest, file);
    await mkdir(dirname(to), { recursive: true });
    if (!STORY_FILE.test(file) || !STORY_ROOTS.some((r) => file === r || file.startsWith(r))) {
      await copyFile(join(template, file), to);
      continue;
    }
    let text = (await readFile(join(template, file), "utf8")).replace(pattern, (id) => ids.get(id)!);
    if (file === "novel.yaml") text = editYaml(text, [{ path: ["title"], value: title }, ...(author ? [{ path: ["author"], value: author }] : [])]);
    await writeFile(to, text);
  }
  const readme = join(dest, "README.md");
  await writeFile(readme, (await readFile(readme, "utf8")).replace(/^# .*$/m, `# ${title}`));
  for (const [file, text] of snapshots(await loadNovel(nodeSource(dest)))) await writeFile(join(dest, file), text);

  const g = git(dest);
  await g.raw(["init", "-q", "-b", "main"]);
  if (identity) {
    await g.raw(["config", "user.name", identity.name]);
    await g.raw(["config", "user.email", identity.email]);
  } else if (!(await hasGitIdentity(dest))) {
    throw new NeedsIdentity();
  }
  await g.raw(["add", "-A"]);
  await g.raw(["commit", "-q", "-m", `Start ${title}`]);
}

/** Every file under `dir`, as paths relative to it with forward slashes. */
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
    .sort();
}
