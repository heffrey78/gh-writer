import { execFile } from "node:child_process";
import { simpleGit, type SimpleGit, type SimpleGitProgressEvent } from "simple-git";

/** Stable codes for what went wrong, so the UI can say what to do. */
export type GitErrorCode = "AUTH" | "SCOPE" | "NOT_FOUND" | "NETWORK" | "REJECTED" | "DESTINATION_EXISTS" | "GIT_MISSING" | "BAD_REPO" | "GIT";

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
    "GitHub didn't accept your credentials, or none are set up. Connect gh-writer to GitHub (Connect GitHub, at the top of the page); or for an https:// address, run `gh auth setup-git` " +
    "(or sign in with Git Credential Manager); for a git@github.com: address, add an SSH key to GitHub " +
    "(https://github.com/settings/keys) and load it with ssh-add. Then try again.",
  SCOPE:
    "GitHub won't let gh-writer add or change the novel's GitHub workflows (.github/workflows) without the workflow permission. " +
    "Reconnect to GitHub with a code to grant it: Sign out of GitHub, then Connect GitHub. (With gh's account, run `gh auth refresh -s workflow` first.)",
  NOT_FOUND: "No repository at that address. Check the owner and name, and that your GitHub account can see it.",
  NETWORK: "Couldn't reach the server. Check your connection and try again.",
  REJECTED: "The remote has changes this copy doesn't have yet: bring them in, then push again.",
  DESTINATION_EXISTS: "The destination folder already exists and isn't empty. Choose another folder.",
  GIT_MISSING: "git isn't installed or isn't on the PATH. Install git (https://git-scm.com) and restart gh-writer.",
  BAD_REPO: "That isn't a repository address. Use owner/name or a URL such as https://github.com/owner/name.",
};

// Checked in order: a 403 "unable to access" is AUTH, not NETWORK. A push refused because the remote
// moved is REJECTED; one refused by the remote itself ("[remote rejected]", e.g. a protected branch) is GIT.
const PATTERNS: [GitErrorCode, RegExp][] = [
  ["GIT_MISSING", /spawn git ENOENT|git: (command )?not found/i],
  // GitHub refusing an OAuth token without the workflow scope a push that touches .github/workflows.
  ["SCOPE", /without `?workflow`? scope/i],
  [
    "AUTH",
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|invalid credentials|denied to /i,
  ],
  ["NOT_FOUND", /Repository not found|repository '.*' not found|does not appear to be a git repository|returned error: 404|does not exist/i],
  [
    "NETWORK",
    /Could not resolve host|Failed to connect|Connection refused|Connection timed out|Network is unreachable|Operation timed out|Could not read from remote repository|early EOF|unable to access/i,
  ],
  ["REJECTED", /\[rejected\]|\((fetch first|non-fast-forward)\)/i],
  ["DESTINATION_EXISTS", /already exists and is not an empty directory/i],
];

/** Turn git's output into a code and an actionable message. */
export function classifyGitError(e: unknown): GitFailure {
  if (e instanceof GitFailure) return e;
  const detail = e instanceof Error ? e.message.trim() : String(e);
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(detail)) return new GitFailure(code, GUIDANCE[code as Exclude<GitErrorCode, "GIT">], detail);
  }
  return new GitFailure("GIT", `git failed: ${reason(detail)}`, detail);
}

/**
 * The line of git's output that says why: a remote's refusal ("! [remote rejected] main -> main (why)")
 * or what it printed ("remote: …"), rather than the summary git ends with ("failed to push some refs").
 */
function reason(detail: string): string {
  const lines = detail.split("\n").map((l) => l.trim()).filter(Boolean);
  const rejected = lines.find((l) => /\[remote rejected\]/.test(l));
  const why = rejected && /\((.+)\)\s*$/.exec(rejected)?.[1];
  if (why && !/^pre-receive hook declined$/.test(why)) return why;
  const remote = lines.find((l) => /^remote: \S/.test(l) && !/^remote: (error: )?$/.test(l));
  if (remote) return remote.replace(/^remote: (error: )?/, "");
  return lines.findLast((l) => !/failed to push some refs/.test(l)) ?? lines.at(-1) ?? detail;
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

/** gh-writer's GitHub token for one host's https remotes (e.g. "https://github.com"), for one git command. */
export interface GitAuth {
  origin: string;
  token: string;
}

/** The credentials for a remote URL, if gh-writer has any for it. */
export type GitAuthSource = (url: string) => Promise<GitAuth | undefined>;

const TOKEN_VAR = "GH_WRITER_GIT_TOKEN";

/**
 * Configuration for one command (git -c) that answers for `origin` with the token in the command's
 * environment, as x-access-token, and with nothing else: the empty helper first clears the author's
 * own helpers for that host, so a stale stored credential can't win. Nothing is written to any git
 * config file, and the token never appears in git's arguments.
 */
function credentialConfig(origin: string): string[] {
  const helper = `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${TOKEN_VAR}"; }; f`;
  return [`credential.${origin}.helper=`, `credential.${origin}.helper=${helper}`];
}

/**
 * simple-git for `dir`. git must never wait for a password in the terminal the server runs in:
 * prompts are off and ssh runs in batch mode (unless the author set their own ssh command), so a
 * missing credential fails fast as AUTH. Credentials come from the author's git setup, or for a
 * GitHub remote from gh-writer's own sign-in (`auth`).
 */
export function git(dir?: string, onProgress?: (e: SimpleGitProgressEvent) => void, signal?: AbortSignal, auth?: GitAuth): SimpleGit {
  const env = { ...gitEnv(), ...(auth ? { [TOKEN_VAR]: auth.token } : {}) };
  return simpleGit({
    ...(dir ? { baseDir: dir } : {}),
    ...(auth ? { config: credentialConfig(auth.origin) } : {}),
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
      allowUnsafeCredentialHelper: true,
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

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/**
 * git plumbing that simple-git doesn't cover: text on stdin, extra environment (a temporary index),
 * raw bytes out. Same environment rules as `git()`. Rejects with git's stderr on a non-zero exit.
 */
export function gitPlumbing(dir: string, args: string[], { input, env }: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd: dir, env: { ...gitEnv(), ...env }, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(Object.assign(new Error(`${error.message}\n${stderr.toString()}`.trim()), { stdout })) : resolve(stdout)),
    );
    // git may exit without reading its input (or never read it at all): a broken pipe is git's answer,
    // reported through the callback, and must not become an unhandled error that stops the server.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
