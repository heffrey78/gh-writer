import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { newId, parseYaml, slugify } from "@gh-writer/core";
import type { SimpleGitProgressEvent } from "simple-git";
import { classifyGitError, cloneUrl, git, repoName } from "./git.ts";
import { DEFAULT_TEMPLATE, NeedsIdentity, writeNewNovel, type NewNovel } from "./new-novel.ts";

/** A novel the author has opened or cloned. */
export interface LibraryEntry {
  id: string;
  /** Absolute path of the folder holding novel.yaml. */
  path: string;
  title: string;
  /** The origin remote, without any credentials embedded in it. */
  remote?: string;
  /** ISO timestamp. */
  lastOpened: string;
}

export interface LibraryNotice {
  code: "MISSING" | "UNREADABLE";
  message: string;
  path: string;
}

export type LibraryErrorCode = "NOT_A_DIRECTORY" | "NOT_A_REPO" | "NOT_A_NOVEL" | "UNKNOWN_NOVEL" | "NOT_EMPTY" | "NEEDS_IDENTITY";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
  }
}

export interface CloneOptions {
  /** Where to clone to. Default: a folder named after the repository in the library's clone directory. */
  into?: string;
  onProgress?: (e: SimpleGitProgressEvent) => void;
  signal?: AbortSignal;
}

interface LibraryFile {
  version: 1;
  novels: LibraryEntry[];
}

/** The per-user platform config directory for gh-writer, or $GH_WRITER_CONFIG_DIR. */
export function defaultConfigDir(): string {
  const env = process.env;
  if (env.GH_WRITER_CONFIG_DIR) return resolve(env.GH_WRITER_CONFIG_DIR);
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gh-writer");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "gh-writer");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gh-writer");
}

/**
 * The author's novels, kept in library.json in the config directory. Entries whose folder has gone
 * are dropped when the library is read, and each drop leaves a notice for the UI.
 */
export class Library {
  readonly file: string;
  /** Where new novels and clones go unless the author says otherwise. */
  readonly cloneDir: string;
  /** The template new novels are made from. */
  readonly templateDir: string;
  /** What changed behind the author's back: shown once by the UI, kept for the server's lifetime. */
  readonly notices: LibraryNotice[] = [];
  #novels: LibraryEntry[] = [];
  #saving: Promise<void> = Promise.resolve();

  private constructor(file: string, cloneDir: string, templateDir: string) {
    this.file = file;
    this.cloneDir = cloneDir;
    this.templateDir = templateDir;
  }

  static async open({
    configDir = defaultConfigDir(),
    cloneDir = join(homedir(), "gh-writer"),
    templateDir = DEFAULT_TEMPLATE,
  }: { configDir?: string; cloneDir?: string; templateDir?: string } = {}): Promise<Library> {
    const library = new Library(join(configDir, "library.json"), cloneDir, templateDir);
    await library.#load();
    await library.list();
    return library;
  }

  /** Every novel whose folder still exists, most recently opened first. */
  async list(): Promise<LibraryEntry[]> {
    const present = await Promise.all(this.#novels.map(async (n) => (await stat(n.path).catch(() => undefined))?.isDirectory() ?? false));
    const gone = this.#novels.filter((_, i) => !present[i]);
    if (gone.length) {
      for (const n of gone) {
        this.notices.push({ code: "MISSING", path: n.path, message: `"${n.title}" was removed from the library: its folder ${n.path} is gone.` });
      }
      this.#novels = this.#novels.filter((_, i) => present[i]);
      await this.#save();
    }
    return [...this.#novels].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  get(id: string): LibraryEntry | undefined {
    return this.#novels.find((n) => n.id === id);
  }

  /** Check that `dir` is a git repository holding novel.yaml, and add it (or refresh its entry). */
  async add(folder: string): Promise<LibraryEntry> {
    const dir = expandHome(folder);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) throw new LibraryError("NOT_A_DIRECTORY", `${resolve(dir)} isn't a folder.`);
    const path = await realpath(dir);

    let isRepo: boolean;
    try {
      isRepo = await git(path).checkIsRepo();
    } catch (e) {
      throw classifyGitError(e);
    }
    if (!isRepo) throw new LibraryError("NOT_A_REPO", `${path} isn't a git repository. A novel needs one to keep its history and sync with GitHub.`);

    const yaml = await readFile(join(path, "novel.yaml"), "utf8").catch(() => undefined);
    if (yaml === undefined) throw new LibraryError("NOT_A_NOVEL", `${path} has no novel.yaml, so it isn't a gh-writer novel.`);
    const data = parseYaml(yaml, "novel.yaml").data as { title?: unknown } | undefined;
    const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : basename(path);
    const remote = await git(path)
      .remote(["get-url", "origin"])
      .then((url) => (url ? withoutCredentials(url.trim()) : undefined))
      .catch(() => undefined);

    const lastOpened = new Date().toISOString();
    const existing = this.#novels.find((n) => n.path === path);
    const entry: LibraryEntry = { id: existing?.id ?? newId("lib"), path, title, ...(remote ? { remote } : {}), lastOpened };
    this.#novels = [...this.#novels.filter((n) => n !== existing), entry];
    await this.#save();
    return entry;
  }

  /** Forget a novel. Its folder is left alone. */
  async remove(id: string): Promise<boolean> {
    const before = this.#novels.length;
    this.#novels = this.#novels.filter((n) => n.id !== id);
    if (this.#novels.length === before) return false;
    await this.#save();
    return true;
  }

  /** Record that the author opened a novel. */
  async touch(id: string): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new LibraryError("UNKNOWN_NOVEL", `No novel ${id} in the library.`);
    entry.lastOpened = new Date().toISOString();
    await this.#save();
  }

  /** Clone a novel with the system git and add it. A failed clone leaves no folder behind. */
  async clone(repo: string, { into, onProgress, signal }: CloneOptions = {}): Promise<LibraryEntry> {
    const url = cloneUrl(repo);
    const dest = resolve(into ? expandHome(into) : join(this.cloneDir, repoName(url)));
    const existing = await readdir(dest).catch(() => undefined);
    if (existing?.length) throw classifyGitError(new Error(`destination path '${dest}' already exists and is not an empty directory`));
    const cleanUp = () => (existing ? rm(dest, { recursive: true, force: true }).then(() => mkdir(dest)) : rm(dest, { recursive: true, force: true }));

    await mkdir(dirname(dest), { recursive: true });
    try {
      await git(undefined, onProgress, signal).clone(url, dest);
    } catch (e) {
      await cleanUp();
      throw classifyGitError(e);
    }
    try {
      return await this.add(dest);
    } catch (e) {
      await cleanUp();
      if (e instanceof LibraryError && e.code === "NOT_A_NOVEL") {
        throw new LibraryError("NOT_A_NOVEL", `${url} has no novel.yaml, so it isn't a gh-writer novel. Nothing was kept.`);
      }
      throw e;
    }
  }

  /** Where a new novel called `title` goes unless the author picks a folder. */
  defaultFolder(title: string): string {
    return join(this.cloneDir, slugify(title) || "novel");
  }

  /**
   * Start a novel from the template in `into` (default: a folder named after the title in the
   * clone directory), which must be new or empty, and add it. A failure leaves nothing behind.
   */
  async create({ into, ...novel }: NewNovel & { into?: string }): Promise<LibraryEntry> {
    const dest = resolve(into ? expandHome(into) : this.defaultFolder(novel.title));
    const info = await stat(dest).catch(() => undefined);
    if (info && !info.isDirectory()) throw new LibraryError("NOT_A_DIRECTORY", `${dest} is a file, not a folder. Choose another folder.`);
    const existing = info && (await readdir(dest));
    if (existing?.length) throw new LibraryError("NOT_EMPTY", `${dest} already exists and isn't empty. Choose another folder, or a new name.`);
    const cleanUp = () => (existing ? rm(dest, { recursive: true, force: true }).then(() => mkdir(dest)) : rm(dest, { recursive: true, force: true }));

    await mkdir(dest, { recursive: true });
    try {
      await writeNewNovel(this.templateDir, dest, novel);
      return await this.add(dest);
    } catch (e) {
      await cleanUp();
      if (e instanceof NeedsIdentity) throw new LibraryError("NEEDS_IDENTITY", e.message);
      throw e;
    }
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const data = JSON.parse(text) as LibraryFile;
      this.#novels = Array.isArray(data.novels) ? data.novels.filter(isEntry) : [];
    } catch {
      const backup = `${this.file}.unreadable-${Date.now()}`;
      await rename(this.file, backup);
      this.notices.push({ code: "UNREADABLE", path: backup, message: `The library file couldn't be read, so the library starts empty. The old file is at ${backup}.` });
    }
  }

  /** Saves are queued, and each replaces the file atomically. */
  #save(): Promise<void> {
    const data: LibraryFile = { version: 1, novels: this.#novels };
    this.#saving = this.#saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
        await rename(tmp, this.file);
      });
    return this.#saving;
  }
}

/** https://user:token@host/… → https://host/… (an ssh URL's user is not a secret, and stays). */
function withoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]*@/i, "$1");
}

function isEntry(n: unknown): n is LibraryEntry {
  const e = n as LibraryEntry;
  return typeof e === "object" && e !== null && typeof e.id === "string" && typeof e.path === "string" && typeof e.title === "string" && typeof e.lastOpened === "string";
}

/**
 * A path as a person types it: a leading ~ is their home folder, as in a shell. Without this,
 * "~/gh-writer/novel" would be a folder named "~" wherever gh-writer happened to start.
 */
export function expandHome(path: string): string {
  const p = path.trim();
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}
