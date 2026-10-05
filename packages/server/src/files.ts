import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/** Largest file the API reads or writes. Scenes are a few kB; this leaves room for long chapters and bibles. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Text files the API writes. Reading is open to any non-hidden UTF-8 file. */
const WRITABLE = /\.(md|markdown|yaml|yml|txt|json)$/i;

/** Suffix of the temporary files atomic writes leave behind if the process dies mid-write. */
export const TEMP_SUFFIX = ".ghw-tmp";

export type FileErrorCode = "BAD_PATH" | "NOT_FOUND" | "NOT_TEXT" | "TOO_LARGE" | "NOT_WRITABLE";

export class FileError extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileError";
    this.code = code;
  }
}

export function hashText(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Check a repository-relative path: "/"-separated, no empty, "." or ".." segments, no hidden segments
 * (".git", ".github", temp files), no backslashes or NUL. Returns it unchanged.
 */
export function checkPath(path: string): string {
  const segments = path.split("/");
  if (
    !path ||
    path.length > 1024 ||
    /[\\\0]/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((s) => s === "" || s.startsWith(".") || s === "node_modules")
  ) {
    throw new FileError("BAD_PATH", `Not a path inside the novel: "${path}"`);
  }
  return path;
}

/** Whether a repository-relative path is one the API serves and the watcher reports. */
export function isVisible(path: string): boolean {
  try {
    checkPath(path);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of `path` under `root`, refusing symlinks that lead out of the novel. */
async function resolveInside(root: string, path: string): Promise<string> {
  const full = join(root, ...checkPath(path).split("/"));
  const realRoot = await realpath(root);
  // The deepest existing ancestor must still be inside the root once symlinks are followed.
  let dir = dirname(full);
  for (;;) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined) {
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new FileError("BAD_PATH", `"${path}" leads outside the novel.`);
      break;
    }
    dir = dirname(dir);
  }
  const link = await lstat(full).catch(() => undefined);
  if (link?.isSymbolicLink()) throw new FileError("BAD_PATH", `"${path}" is a symbolic link.`);
  if (link?.isDirectory()) throw new FileError("BAD_PATH", `"${path}" is a folder.`);
  return full;
}

export interface TextFile {
  content: string;
  hash: string;
}

/** A UTF-8 file in the novel, or undefined if it doesn't exist. */
export async function readText(root: string, path: string): Promise<TextFile | undefined> {
  const full = await resolveInside(root, path);
  const info = await stat(full).catch(() => undefined);
  if (!info) return undefined;
  if (info.size > MAX_FILE_BYTES) throw new FileError("TOO_LARGE", `"${path}" is larger than ${MAX_FILE_BYTES} bytes.`);
  const bytes = await readFile(full);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileError("NOT_TEXT", `"${path}" isn't UTF-8 text.`);
  }
  return { content, hash: hashText(bytes) };
}

export interface WriteHooks {
  /** Called once the temp file is on disk, before it replaces the target (fault-injection tests). */
  beforeRename?: (temp: string) => void | Promise<void>;
}

/** Check that `content` may be written to `path`, and return its full path. */
export async function writablePath(root: string, path: string, content: string): Promise<string> {
  if (!WRITABLE.test(path)) throw new FileError("NOT_WRITABLE", `Only text files can be written (.md, .yaml, .txt, .json): "${path}"`);
  if (!content.isWellFormed()) throw new FileError("NOT_TEXT", "The content isn't valid Unicode text.");
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new FileError("TOO_LARGE", `The content is larger than ${MAX_FILE_BYTES} bytes.`);
  return resolveInside(root, path);
}

/**
 * Replace `full` with `content` so that a crash at any point leaves the old file or the new one, never a
 * mix: write a temp file in the same folder, fsync it, rename it over the target, then fsync the folder
 * so the rename itself is durable. The file keeps its permissions.
 */
export async function atomicWrite(full: string, content: string, hooks: WriteHooks = {}): Promise<void> {
  const dir = dirname(full);
  await mkdir(dir, { recursive: true });
  const mode = (await stat(full).catch(() => undefined))?.mode;
  const temp = join(dir, `.${basename(full)}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
  const handle = await open(temp, "wx", mode === undefined ? 0o644 : mode & 0o777);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (e) {
    await handle.close();
    await unlink(temp).catch(() => {});
    throw e;
  }
  await handle.close();
  try {
    await hooks.beforeRename?.(temp);
    await rename(temp, full);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
  await syncDir(dir);
}

async function syncDir(dir: string): Promise<void> {
  // Windows can't open a folder for fsync; NTFS journals the rename itself.
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
