import { ISSUE_KINDS, kindLabel, STOCK_LABELS } from "@gh-writer/core";
import { classifyGitError, git } from "./git.ts";
import { GitHubError, type GitHub } from "./github.ts";
import type { NovelWorkspace } from "./workspace.ts";

export interface PublishOptions {
  /** The repository's name on GitHub. */
  name: string;
  description?: string;
  /** Private unless the author says otherwise. */
  private?: boolean;
}

export type PublishErrorCode = "BAD_NAME" | "HAS_REMOTE" | "NAME_TAKEN" | "PUSH_FAILED";

export class PublishError extends Error {
  readonly code: PublishErrorCode;
  /** git's own output, when the push failed. */
  readonly detail: string | undefined;

  constructor(code: PublishErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.detail = detail;
  }
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Put a local novel on GitHub: create a repository for the signed-in author (private by default),
 * make it the novel's origin, and push, through the novel's own sync so that it syncs from then on.
 * Trying again after a failed push pushes to the repository already made, rather than making another.
 */
export async function publish(ws: NovelWorkspace, github: GitHub, { name, description, private: priv = true }: PublishOptions): Promise<{ remote: string }> {
  if (!NAME.test(name) || name === "." || name === "..") {
    throw new PublishError("BAD_NAME", "A repository name can have letters, digits, '-', '_' and '.', and no spaces.");
  }
  const status = await github.status();
  const login = status.account?.login;
  if (!status.signedIn || !login) throw new GitHubError("NO_SIGN_IN", "Connect gh-writer to GitHub first.");

  const g = git(ws.root);
  let remote = (await g.raw(["remote", "get-url", "origin"]).catch(() => "")).trim();
  if (remote) {
    // Only a retry of this same publish may go on: never repoint a novel that has a remote.
    const mine = `${new URL(github.webUrl).origin}/${login}/${name}.git`.toLowerCase();
    if (remote.toLowerCase() !== mine) throw new PublishError("HAS_REMOTE", `This novel is already connected to ${remote}.`);
  } else {
    const res = await github.api("/user/repos", { method: "POST", body: { name, private: priv, ...(description ? { description } : {}) } });
    const body = (await res.json().catch(() => ({}))) as { clone_url?: string; message?: string; errors?: { message?: string }[] };
    if (res.status === 422 && body.errors?.some((e) => /already exists/i.test(e.message ?? ""))) {
      throw new PublishError("NAME_TAKEN", `You already have a repository called “${name}” on GitHub. Choose another name.`);
    }
    if (!res.ok || !body.clone_url) {
      throw new GitHubError("GITHUB", `GitHub didn't create the repository: ${body.errors?.[0]?.message ?? body.message ?? `HTTP ${res.status}`}`);
    }
    remote = body.clone_url;
    await g.raw(["remote", "add", "origin", remote]);
    await writingLabels(github, login, name);
  }

  const failed = (message: string, detail?: string) =>
    new PublishError("PUSH_FAILED", `The repository is on GitHub (${remote}), but sending the novel to it failed. ${message} Then try again: it goes to the same repository.`, detail);
  if (ws.syncer) {
    // A sync that started before the remote was added wouldn't push: sync again.
    const synced = await ws.syncer.syncAgain();
    if (synced.error) throw failed(synced.error.message, synced.error.detail);
    if (synced.state === "local") throw failed("the novel didn't see its new remote.");
  } else {
    const branch = (await g.raw(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    try {
      await git(ws.root, undefined, undefined, await github.gitAuth(remote)).raw(["push", "--quiet", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
    } catch (e) {
      const failure = classifyGitError(e);
      throw failed(failure.message, failure.detail);
    }
  }
  return { remote };
}

/**
 * A new repository's labels for a novel: GitHub's stock ones (bug, enhancement, …) taken out, the
 * writing kinds put in. Best effort: a label left over is only hidden in gh-writer.
 */
async function writingLabels(github: GitHub, owner: string, name: string): Promise<void> {
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  try {
    const res = await github.api(`${repo}/labels?per_page=100`);
    const have = res.ok ? ((await res.json()) as { name: string }[]).map((l) => l.name) : [];
    for (const label of have.filter((l) => STOCK_LABELS.has(l))) await github.api(`${repo}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
    for (const kind of ISSUE_KINDS) {
      if (!have.includes(kindLabel(kind))) await github.api(`${repo}/labels`, { method: "POST", body: { name: kindLabel(kind), color: kind.color, description: kind.description } });
    }
  } catch {
    // Labels are a nicety: publishing goes on.
  }
}
