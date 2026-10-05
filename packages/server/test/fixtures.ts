import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const sample = fileURLToPath(new URL("../../../examples/sample-novel", import.meta.url));

/** Run git in `dir`. */
export const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A temporary directory for a test file, with git isolated from the author's own config
 * (credential helpers, signing…). Returns it and a function for fresh paths inside it.
 */
export function scratch(prefix: string): { tmp: string; fresh: (name: string) => string; cleanUp: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), `gh-writer-${prefix}-`));
  const config = join(tmp, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  let n = 0;
  return { tmp, fresh: (name) => join(tmp, `${name}-${++n}`), cleanUp: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** A clock the test moves by hand: `schedule` has the shape the committer and syncer take. */
export function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
    /** Delays of the timers waiting now, soonest first. */
    pending: () => [...timers].map((t) => t.at - now).sort((a, b) => a - b),
  };
}

/** A git repository holding a copy of the sample novel, committed. */
export function novelRepo(dir: string): string {
  cpSync(sample, dir, { recursive: true });
  gitIn(dir, "init", "-q");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "Start");
  return dir;
}
