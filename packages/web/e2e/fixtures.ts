import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
export const sample = join(repo, "examples/sample-novel");
const cli = join(repo, "packages/cli/src/main.ts");

export interface App {
  /** A temp folder standing in for the author's home: config, clones and novels live here. */
  home: string;
  /** The launch URL, with its token. */
  launchUrl: string;
  /** The server's own address. */
  url: string;
  env: NodeJS.ProcessEnv;
  /** Start (or restart) the server; options are `gh-writer serve` arguments. */
  restart: (...args: string[]) => Promise<void>;
  /** A git repository holding a copy of the sample novel, committed. */
  novelRepo: (name?: string) => string;
  /** A bare repository with the sample novel, for cloning from. */
  bareRepo: (name?: string) => string;
  git: (dir: string, ...args: string[]) => string;
}

export const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Open the app with its launch URL, and wait until it has traded the token for a session. */
export async function launch(page: Page, app: App, path = "/") {
  await page.goto(app.launchUrl.replace("/?", `${path}?`));
  await expect(page).not.toHaveURL(/token=/);
}

export const test = base.extend<{ app: App }>({
  app: async ({}, use) => {
    const home = mkdtempSync(join(tmpdir(), "gh-writer-web-"));
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test Author\n\temail = author@example.com\n[init]\n\tdefaultBranch = main\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      GH_WRITER_CONFIG_DIR: join(home, "config"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      FORCE_COLOR: "0",
    };
    const gitHere = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    let n = 0;
    let child: ChildProcess | undefined;
    const app: App = {
      home,
      launchUrl: "",
      url: "",
      env,
      git: gitHere,
      novelRepo: (name = `novel-${++n}`) => {
        const dir = join(home, "novels", name);
        mkdirSync(join(home, "novels"), { recursive: true });
        cpSync(sample, dir, { recursive: true });
        gitHere(dir, "init", "-q");
        gitHere(dir, "add", "-A");
        gitHere(dir, "commit", "-qm", "Start");
        return dir;
      },
      bareRepo: (name = `remote-${++n}.git`) => {
        const seed = app.novelRepo(`seed-${n}`);
        const bare = join(home, "remotes", name);
        mkdirSync(join(home, "remotes"), { recursive: true });
        gitHere(home, "clone", "-q", "--bare", seed, bare);
        return bare;
      },
      restart: async (...args) => {
        await stop(child);
        child = spawn("node", [cli, "serve", "--no-open", ...args], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
        const launchUrl = await new Promise<string>((resolve, reject) => {
          let out = "";
          child!.stdout!.on("data", (chunk: Buffer) => {
            out += chunk.toString();
            const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*\?token=\S+)/.exec(out);
            if (m) resolve(m[1]!);
          });
          child!.stderr!.on("data", (chunk: Buffer) => (out += chunk.toString()));
          child!.once("exit", (code) => reject(new Error(`gh-writer serve exited (${code}):\n${out}`)));
        });
        app.launchUrl = launchUrl;
        app.url = new URL(launchUrl).origin;
      },
    };
    await app.restart();
    await use(app);
    await stop(child);
    rmSync(home, { recursive: true, force: true });
  },
});

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

export { expect };
