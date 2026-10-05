import { simpleGit, type SimpleGit, type SimpleGitProgressEvent } from "simple-git";

/** Stable codes for what went wrong, so the UI can say what to do. */
export type GitErrorCode = "AUTH" | "NOT_FOUND" | "NETWORK" | "DESTINATION_EXISTS" | "GIT_MISSING" | "BAD_REPO" | "GIT";

export class GitFailure extends Error {
  readonly code: GitErrorCode;
  /** git's own output, for a "details" disclosure. */
  readonly detail: string;

  constructor(code: GitErrorCode, message: string, detail = "") {
    super(message);
    this.name = "GitFailure";
    this.code = code;
    this.detail = detail;
  }
}

const GUIDANCE: Record<Exclude<GitErrorCode, "GIT">, string> = {
  AUTH:
    "GitHub didn't accept your credentials, or none are set up. For an https:// address, run `gh auth setup-git` " +
    "(or sign in with Git Credential Manager); for a git@github.com: address, add an SSH key to GitHub " +
    "(https://github.com/settings/keys) and load it with ssh-add. Then try again.",
  NOT_FOUND: "No repository at that address. Check the owner and name, and that your GitHub account can see it.",
  NETWORK: "Couldn't reach the server. Check your connection and try again.",
  DESTINATION_EXISTS: "The destination folder already exists and isn't empty. Choose another folder.",
  GIT_MISSING: "git isn't installed or isn't on the PATH. Install git (https://git-scm.com) and restart gh-writer.",
  BAD_REPO: "That isn't a repository address. Use owner/name or a URL such as https://github.com/owner/name.",
};

// Checked in order: a 403 "unable to access" is AUTH, not NETWORK.
const PATTERNS: [GitErrorCode, RegExp][] = [
  ["GIT_MISSING", /spawn git ENOENT|git: (command )?not found/i],
  [
    "AUTH",
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|invalid credentials|denied to /i,
  ],
  ["NOT_FOUND", /Repository not found|repository '.*' not found|does not appear to be a git repository|returned error: 404|does not exist/i],
  [
    "NETWORK",
    /Could not resolve host|Failed to connect|Connection refused|Connection timed out|Network is unreachable|Operation timed out|Could not read from remote repository|early EOF|unable to access/i,
  ],
  ["DESTINATION_EXISTS", /already exists and is not an empty directory/i],
];

/** Turn git's output into a code and an actionable message. */
export function classifyGitError(e: unknown): GitFailure {
  if (e instanceof GitFailure) return e;
  const detail = e instanceof Error ? e.message.trim() : String(e);
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(detail)) return new GitFailure(code, GUIDANCE[code as Exclude<GitErrorCode, "GIT">], detail);
  }
  return new GitFailure("GIT", `git failed: ${detail.split("\n").findLast((l) => l.trim()) ?? detail}`, detail);
}

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const URL_SCHEMES = /^(https?|ssh|git|file):\/\//;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

/**
 * The clone URL for what the author typed: "owner/name" means GitHub over https; URLs and
 * git@host:path pass through. Anything else, including a leading "-" that git would read
 * as an option, is BAD_REPO.
 */
export function cloneUrl(repo: string): string {
  const r = repo.trim();
  const m = OWNER_REPO.exec(r);
  if (m) return `https://github.com/${m[1]}/${m[2]!.replace(/\.git$/, "")}.git`;
  if ((URL_SCHEMES.test(r) || SCP_LIKE.test(r)) && !/\s/.test(r)) return r;
  throw new GitFailure("BAD_REPO", GUIDANCE.BAD_REPO);
}

/** The folder name a clone of `url` gets: its last path segment without ".git". */
export function repoName(url: string): string {
  const name = url.replace(/[/\\]+$/, "").replace(/\.git$/, "").split(/[/:\\]/).pop() ?? "";
  return name && name !== ".." && name !== "." ? name : "novel";
}

/**
 * simple-git for `dir`. git must never wait for a password in the terminal the server runs in:
 * prompts are off and ssh runs in batch mode (unless the author set their own ssh command), so a
 * missing credential fails fast as AUTH. Credentials come from the author's git setup.
 */
export function git(dir?: string, onProgress?: (e: SimpleGitProgressEvent) => void, signal?: AbortSignal): SimpleGit {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return simpleGit({
    ...(dir ? { baseDir: dir } : {}),
    ...(onProgress ? { progress: onProgress } : {}),
    ...(signal ? { abort: signal } : {}),
    // simple-git treats the environment as untrusted input: it strips GIT_* and EDITOR-like variables
    // and refuses some values. Here the environment is the author's own (their GIT_SSH_COMMAND,
    // credential setup, VS Code's GIT_ASKPASS…), so it passes through whole. The only outside input,
    // the clone URL, is checked by cloneUrl.
    allowEnvironment: Object.keys(env),
    unsafe: {
      allowUnsafeEditor: true,
      allowUnsafePager: true,
      allowUnsafeAskPass: true,
      allowUnsafeSshCommand: true,
      allowUnsafeConfigPaths: true,
      allowUnsafeConfigEnvCount: true,
      allowUnsafeGitProxy: true,
      allowUnsafeTemplateDir: true,
      allowUnsafeExec: true,
      allowUnsafeDiffExternal: true,
    },
  }).env(env);
}
