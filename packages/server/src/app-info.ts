import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitInstall } from "./git.ts";

/**
 * What the running app is (D9): its version, the Node and git it runs on, the licences it ships, and
 * whether a newer release is out. The desktop app says what it is through the environment:
 * GH_WRITER_APP_VERSION and GH_WRITER_LICENSES (a folder of licence texts). From a terminal
 * (`gh-writer serve`) there's no app version and no update check: updating is the checkout's.
 */
export interface AppInfo {
  desktop: boolean;
  version: string | null;
  node: string;
  git: { version: string | null; bundled: boolean };
  /** A newer release than this one, if the desktop app is running and GitHub says so. */
  update: Release | null;
}

export interface Release {
  version: string;
  /** The release's page on GitHub, with its downloads. */
  url: string;
  /** Its notes, in Markdown. */
  notes: string;
}

export interface License {
  /** Its file name, e.g. "git-COPYING.txt". */
  name: string;
  text: string;
}

/** Where releases come from. */
export const RELEASES_REPO = "heffrey78/gh-writer";
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** "1.2.3" or "v1.2.3" as numbers; anything after a "-" (a pre-release) makes it no release at all. */
function parseVersion(v: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Whether `a` is a later version than `b`. */
export function newer(a: string, b: string): boolean {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/**
 * GitHub's latest release, asked at most once a day (once an hour after a failure, which counts as
 * no update): the API allows 60 unauthenticated requests an hour, and a writer needn't hear sooner.
 */
export class UpdateCheck {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #last: { at: number; ok: boolean; latest: Release | null } | undefined;

  constructor(apiUrl: string, { fetch: f = fetch, now = Date.now }: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#apiUrl = apiUrl.replace(/\/$/, "");
    this.#fetch = f;
    this.#now = now;
  }

  /** A release newer than `current`, or null. */
  async newerThan(current: string): Promise<Release | null> {
    const last = this.#last;
    const fresh = last && this.#now() - last.at < (last.ok ? DAY : HOUR);
    if (!fresh) this.#last = { at: this.#now(), ...(await this.#latest()) };
    const latest = this.#last!.latest;
    return latest && newer(latest.version, current) ? latest : null;
  }

  async #latest(): Promise<{ ok: boolean; latest: Release | null }> {
    try {
      const res = await this.#fetch(`${this.#apiUrl}/repos/${RELEASES_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
      // No release yet is a 404: nothing to offer, and nothing wrong.
      if (res.status === 404) return { ok: true, latest: null };
      if (!res.ok) return { ok: false, latest: null };
      const r = (await res.json()) as { tag_name?: string; html_url?: string; body?: string | null; draft?: boolean; prerelease?: boolean };
      if (r.draft || r.prerelease || !r.tag_name || !r.html_url || !parseVersion(r.tag_name)) return { ok: true, latest: null };
      return { ok: true, latest: { version: r.tag_name.replace(/^v/, ""), url: r.html_url, notes: r.body ?? "" } };
    } catch {
      return { ok: false, latest: null };
    }
  }
}

export async function appInfo(updates: UpdateCheck): Promise<AppInfo> {
  const version = process.env.GH_WRITER_APP_VERSION || null;
  let gitVersion: string | null = null;
  try {
    const { major, minor, patch } = await git().version();
    gitVersion = `${major}.${minor}.${patch}`;
  } catch {
    // No git at all: the app says so where it's needed.
  }
  return {
    desktop: version !== null,
    version,
    node: process.versions.node,
    git: { version: gitVersion, bundled: gitInstall().bundled },
    update: version ? await updates.newerThan(version) : null,
  };
}

/** The licence texts the desktop app ships (GH_WRITER_LICENSES), by name; none from a terminal. */
export async function licenses(): Promise<License[]> {
  const dir = process.env.GH_WRITER_LICENSES;
  if (!dir) return [];
  const names = (await readdir(dir).catch(() => [])).filter((n) => /\.(txt|md)$/.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })));
}
