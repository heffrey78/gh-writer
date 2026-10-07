import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
export const sample = join(repo, "examples/sample-novel");
const cli = join(repo, "packages/cli/src/main.ts");

/** A running `gh-writer serve`. */
export interface Server {
  launchUrl: string;
  url: string;
  stop: () => Promise<void>;
  kill: () => Promise<void>;
}

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
  /** Stop the server (SIGTERM, a clean shutdown). */
  stop: () => Promise<void>;
  /** Kill the server outright (SIGKILL): no shutdown, no last commit, as in a crash. */
  kill: () => Promise<void>;
  /** Another gh-writer on this machine (another "computer" when given its own config dir), stopped after the test. */
  serveAnother: (args: string[], env?: Record<string, string>) => Promise<Server>;
  /** A git repository holding a copy of the sample novel, committed. */
  novelRepo: (name?: string) => string;
  /** A bare repository with the sample novel, for cloning from. */
  bareRepo: (name?: string) => string;
  git: (dir: string, ...args: string[]) => string;
}

export const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * No axe violations on the page as it settles: colour transitions (a theme switch, a hover) finish
 * first, or axe would measure the colours halfway.
 */
export async function axe(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== "running"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** Open the app with its launch URL, and wait until it has traded the token for a session. */
export async function launch(page: Page, app: App, path = "/") {
  await page.goto(app.launchUrl.replace("/?", `${path}?`));
  await expect(page).not.toHaveURL(/token=/);
}

export const test = base.extend<{ app: App; csp: void }>({
  // Every test fails on a Content Security Policy violation: the page must work within its own policy.
  csp: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text().slice(0, 300)));
      await use();
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  app: async ({}, use, testInfo) => {
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
    /** Everything the servers printed, for a failed test's report. */
    let log = "";
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
        const started = await serve(args, env, (s) => (log += s));
        child = started.child;
        app.launchUrl = started.launchUrl;
        app.url = new URL(started.launchUrl).origin;
      },
      stop: () => stop(child),
      kill: () => stop(child, "SIGKILL"),
      serveAnother: async (args, extra = {}) => {
        const started = await serve(args, { ...env, ...extra }, (s) => (log += `[another] ${s}`));
        others.push(started.child);
        return { launchUrl: started.launchUrl, url: new URL(started.launchUrl).origin, stop: () => stop(started.child), kill: () => stop(started.child, "SIGKILL") };
      },
    };
    const others: ChildProcess[] = [];
    await app.restart();
    await use(app);
    await Promise.all([stop(child), ...others.map((o) => stop(o))]);
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("gh-writer serve output", { body: log, contentType: "text/plain" });
    rmSync(home, { recursive: true, force: true });
  },
});

/** Start `gh-writer serve` and wait for its launch URL. */
function serve(args: string[], env: NodeJS.ProcessEnv, log: (s: string) => void): Promise<{ child: ChildProcess; launchUrl: string }> {
  const child = spawn("node", [cli, "serve", "--no-open", ...args], { cwd: env.HOME, env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      log(chunk.toString());
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*\?token=\S+)/.exec(out);
      if (m) resolve({ child, launchUrl: m[1]! });
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      log(chunk.toString());
    });
    child.once("exit", (code, signal) => log(`[gh-writer serve exited: ${code ?? signal}]\n`));
    child.once("exit", (code) => reject(new Error(`gh-writer serve exited (${code}):\n${out}`)));
  });
}

async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill(signal);
  await exited;
}

export { expect };

/**
 * Wait until the editor has taken in a click's caret. ProseMirror reads the selection on the
 * browser's selectionchange event, which comes after the click; a key pressed sooner (as
 * Playwright can, and no person does) acts on the old selection.
 */
export async function selectionSettled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.activeElement?.contains(getSelection()?.anchorNode ?? null) ?? false)).toBe(true);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}
