import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asFormatV1 } from "../../server/test/fixtures.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const main = join(repo, "packages/cli/src/main.ts");
const sample = join(repo, "examples/sample-novel");

// Plain output: FORCE_COLOR (set by some terminals and runners) would override NO_COLOR.
// The library goes to a temporary config directory, not the author's.
const env = () => {
  const { FORCE_COLOR: _, ...rest } = process.env;
  return { ...rest, NO_COLOR: "1", GH_WRITER_CONFIG_DIR: join(tmp, "config") };
};

const run = (file: string, ...args: string[]) => {
  const r = spawnSync("node", [file, ...args], { encoding: "utf8", env: env() });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let tmp: string;
let broken: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gh-writer-cli-"));
  broken = join(tmp, "broken");
  cpSync(sample, broken, { recursive: true });
  const scene = join(broken, "manuscript/02-the-sale/01-night-crossing/01-the-betrayal.md");
  writeFileSync(scene, readFileSync(scene, "utf8").replace("pov: char_7f3k2q", "pov: char_zzzzzz"));
});

// Servers the tests start, stopped even when a test fails before stopping its own.
const servers: ChildProcess[] = [];

afterAll(() => {
  for (const server of servers) server.kill("SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

describe("gh-writer validate", () => {
  it("exits 0 and summarises a valid novel", () => {
    const r = run(main, "validate", sample);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✔ The Bridge at Varn: 0 errors, 0 warnings");
  });

  it("exits 1 and lists errors grouped by file", () => {
    const r = run(main, "validate", broken);
    expect(r.code).toBe(1);
    expect(r.out).toContain("manuscript/02-the-sale/01-night-crossing/01-the-betrayal.md\n  error    E_DANGLING_REF");
    expect(r.out).toContain("✖ The Bridge at Varn: 1 error, 1 warning"); // the POV is also not among the characters
  });

  it("emits JSON with --json", () => {
    const r = run(main, "validate", broken, "--json");
    const report = JSON.parse(r.out) as { errors: number; diagnostics: { code: string }[] };
    expect(report.errors).toBe(1);
    expect(report.diagnostics.map((d) => d.code).sort()).toEqual(["E_DANGLING_REF", "W_POV_NOT_PRESENT"]);
  });
});

describe("gh-writer snapshots", () => {
  it("writes the diagrams, then has nothing to do; a relationship change rewrites its snapshots and nothing else", () => {
    const novel = join(tmp, "snapshots");
    cpSync(sample, novel, { recursive: true });
    // The sample carries its snapshots: start from none.
    for (const f of ["README.md", "relationships.svg", "plotlines.svg", "presence-characters.svg", "presence-themes.svg", "timeline.svg"]) rmSync(join(novel, "diagrams", f), { force: true });
    const first = run(main, "snapshots", novel);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Wrote diagrams/relationships.svg, diagrams/plotlines.svg, diagrams/presence-characters.svg, diagrams/presence-themes.svg, diagrams/timeline.svg, diagrams/README.md");
    expect(readFileSync(join(novel, "diagrams/README.md"), "utf8")).toMatch(/^# Diagrams of The Bridge at Varn\n/);
    expect(run(main, "snapshots", novel).out).toContain("Diagram snapshots are up to date.");
    expect(run(main, "snapshots", novel, "--check").code).toBe(0);

    // Ben and Ada end the book as rivals, not allies.
    const rels = join(novel, "bible/relationships.yaml");
    writeFileSync(rels, readFileSync(rels, "utf8").replace("    type: allies\n    since: sc_r1vet8", "    type: rivals\n    since: sc_r1vet8"));
    const check = run(main, "snapshots", novel, "--check");
    expect(check.code).toBe(1);
    expect(check.out).toContain("Out of date: diagrams/relationships.svg, diagrams/README.md");
    const again = run(main, "snapshots", novel);
    expect(again.out).toContain("Wrote diagrams/relationships.svg, diagrams/README.md");
    expect(readFileSync(join(novel, "diagrams/README.md"), "utf8")).toContain('-.-|"Rivals with"|');
  }, 15_000); // Runs the CLI five times: about 3.5 s alone, past 5 s on a busy machine.

  it("removes a snapshot it drew once a diagram has nothing to show, and never a file it didn't write", () => {
    const novel = join(tmp, "snapshots-stale");
    cpSync(sample, novel, { recursive: true });
    run(main, "snapshots", novel);
    writeFileSync(join(novel, "diagrams/my-sketch.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    rmSync(join(novel, "bible/plotlines"), { recursive: true });
    const r = run(main, "snapshots", novel);
    expect(r.out).toContain("Removed diagrams/plotlines.svg");
    expect(readFileSync(join(novel, "diagrams/my-sketch.svg"), "utf8")).toContain("svg");
    expect(readFileSync(join(novel, "diagrams/README.md"), "utf8")).toContain("No plotlines yet.");
  });

  it("says so when there's no novel", () => {
    const r = run(main, "snapshots", tmp);
    expect(r.code).toBe(1);
    expect(r.out).toContain("No novel here");
  });
});

/** `serve` from `file` (the source or the bundle), once it has printed its launch URL. */
async function serve(file: string, ...args: string[]) {
  const child = spawn("node", [file, "serve", ...args, "--no-open"], { env: env() });
  servers.push(child);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const launch = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", () => {
      const url = /http:\/\/127\.0\.0\.1:\d+\/novels\/lib_[0-9a-z]{6}\?token=[\w-]{43}/.exec(out)?.[0];
      if (url) resolve(url);
    });
    child.once("exit", () => reject(new Error(`serve exited early:\n${out}`)));
  });
  const exchange = await fetch(launch, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { child, exited, launch, exchange, cookie, out: () => out };
}

describe("gh-writer serve", () => {
  it("opens the novel, prints a launch URL with a token, serves it, and exits cleanly on SIGTERM", async () => {
    const { child, exited, launch, exchange, cookie, out } = await serve(main, sample);
    expect(out()).toContain(`gh-writer is serving The Bridge at Varn (${realpathSync(sample)})`);

    expect(exchange.status).toBe(303);
    const library = (await (await fetch(new URL("/api/library", launch), { headers: { cookie } })).json()) as { novels: { path: string }[] };
    expect(library.novels.map((n) => n.path)).toEqual([realpathSync(sample)]);
    expect((await fetch(new URL("/api/library", launch))).status).toBe(403);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out()).toContain("SIGTERM: stopping…\nStopped.");
  }, 15_000);

  it("refuses a folder that isn't a novel repository, a missing folder and a bad port", () => {
    expect(run(main, "serve", broken, "--no-open")).toMatchObject({ code: 1, err: expect.stringContaining("isn't a git repository") });
    expect(run(main, "serve", join(tmp, "missing"), "--no-open").err).toContain("isn't a folder");
    expect(run(main, "serve", sample, "--port", "70000")).toMatchObject({ code: 1 });
    expect(run(main, "serve", sample, "--sync-every", "soon")).toMatchObject({ code: 1, err: expect.stringContaining("--sync-every") });
  }, 15_000); // Runs the CLI four times: past 5 s on a busy machine.
});

describe("gh-writer serve --sidecar", () => {
  /** The first line on stdout, as JSON; with the rest of stdout, which should stay empty. */
  function sidecar(...args: string[]) {
    const child = spawn("node", [main, "serve", ...args, "--sidecar"], { env: env() });
    servers.push(child);
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const first = new Promise<Record<"url" | "token" | "launchUrl" | "error", string>>((resolve, reject) => {
      child.stdout.on("data", () => out.includes("\n") && resolve(JSON.parse(out.slice(0, out.indexOf("\n"))) as Record<"url" | "token" | "launchUrl" | "error", string>));
      child.once("exit", () => reject(new Error(`serve exited before its line: ${out}`)));
    });
    return { child, exited, first, rest: () => out.slice(out.indexOf("\n") + 1) };
  }

  it("prints its address as one JSON line, and when stdin closes commits waiting work and exits 0", async () => {
    const novel = join(tmp, "sidecar-novel");
    cpSync(sample, novel, { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.name", "t"], ["config", "user.email", "t@t"], ["add", "-A"], ["commit", "-qm", "Draft"]]) spawnSync("git", ["-C", novel, ...args]);

    const { child, exited, first, rest } = sidecar(novel);
    const { url, token, launchUrl } = await first;
    expect(launchUrl).toBe(`${url}/novels/${/lib_[0-9a-z]{6}/.exec(launchUrl)?.[0]}?token=${token}`);
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";

    const path = "manuscript/01-return/01-arrival/01-the-station.md";
    const before = readFileSync(join(novel, path));
    const id = /lib_[0-9a-z]{6}/.exec(launchUrl)?.[0];
    const put = await fetch(`${url}/api/novels/${id}/files/${path}`, {
      method: "PUT",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({ content: `${before.toString("utf8")}\nOne more line.\n`, base: createHash("sha256").update(before).digest("hex") }),
    });
    expect(put.status).toBe(200);

    child.stdin.end();
    expect(await exited).toBe(0);
    expect(rest()).toBe("");
    expect(spawnSync("git", ["-C", novel, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync("git", ["-C", novel, "show", "HEAD", "--", path], { encoding: "utf8" }).stdout).toContain("+One more line.");
  }, 20_000);

  it("reports a novel it can't open as {error}, exiting 1", async () => {
    const { exited, first } = sidecar(broken);
    expect((await first).error).toContain("isn't a git repository");
    expect(await exited).toBe(1);
  });

  it("stops when the app that started it is killed", async () => {
    // A stand-in app: starts the sidecar with stdin piped, reports its pid, and waits to be killed.
    const app = spawn("node", ["-e", `const c = require("node:child_process").spawn("node", ${JSON.stringify([main, "serve", "--sidecar"])}, { stdio: ["pipe", "pipe", "inherit"] }); c.stdout.once("data", () => console.log(c.pid));`], { env: env() });
    const pid = Number(await new Promise<string>((resolve) => app.stdout.setEncoding("utf8").once("data", resolve)));
    app.kill("SIGKILL");
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 20_000);
});

describe("gh-writer commands", () => {
  it("new-id prints a valid ID", () => {
    expect(run(main, "new-id", "char").out.trim()).toMatch(/^char_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(run(main, "new-id", "X").code).toBe(1);
  });

  it("rejects unknown commands", () => {
    const r = run(main, "frobnicate");
    expect(r.code).toBe(1);
    expect(r.err).toContain('Unknown command "frobnicate"');
  });
});

describe("standalone validator bundle", () => {
  it("runs with plain node and no node_modules", () => {
    const out = join(tmp, "bundle", "validate.mjs");
    const build = spawnSync("node", [join(repo, "scripts/build-validator.ts"), out], { encoding: "utf8", cwd: repo });
    expect(build.status, build.stderr).toBe(0);
    expect(run(out, sample)).toMatchObject({ code: 0 });
    expect(run(out, broken)).toMatchObject({ code: 1 });
  }, 30_000);
});

describe("server bundle", () => {
  let bundle: string;
  beforeAll(() => {
    // A stand-in web app, so the test needn't build the real one.
    const web = join(tmp, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Stand-in</title>");
    const out = join(tmp, "server");
    const build = spawnSync("node", [join(repo, "scripts/build-server.ts"), out, "--web", web], { encoding: "utf8", cwd: repo });
    expect(build.status, build.stderr).toBe(0);
    bundle = join(out, "gh-writer.mjs");
  }, 60_000);

  it("serves the web app beside it and the API, away from the repository's node_modules", async () => {
    const { child, exited, launch, cookie } = await serve(bundle, sample);
    expect(await (await fetch(new URL("/", launch), { headers: { cookie } })).text()).toContain("<title>Stand-in</title>");
    const library = (await (await fetch(new URL("/api/library", launch), { headers: { cookie } })).json()) as { novels: { path: string }[] };
    expect(library.novels.map((n) => n.path)).toContain(realpathSync(sample));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 15_000);

  it("compiles the same bytes as the source, with the type beside it", () => {
    const novel = join(tmp, "compile-bundled");
    cpSync(sample, novel, { recursive: true });
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Draft"]]) spawnSync("git", ["-C", novel, ...args]);
    for (const [file, out] of [[main, "from-source"], [bundle, "from-bundle"]] as const) {
      const r = run(file, "compile", novel, "--format", "epub,pdf", "--out", join(tmp, out));
      expect(r.code, r.out + r.err).toBe(0);
    }
    for (const name of ["the-bridge-at-varn.epub", "the-bridge-at-varn.pdf"]) {
      expect(readFileSync(join(tmp, "from-bundle", name)).equals(readFileSync(join(tmp, "from-source", name))), name).toBe(true);
    }
  });

  it("loads the keychain's native module from beside it", () => {
    const r = spawnSync("node", ["-e", "process.stdout.write(typeof require('@napi-rs/keyring').AsyncEntry)"], { cwd: dirname(bundle), encoding: "utf8" });
    expect(r.stdout, r.stderr).toBe("function");
  });
});

describe("gh-writer migrate", () => {
  it("moves the sample to format v2 in one commit, with the template's tools; it compiles the same and its own validator passes", () => {
    const novel = join(tmp, "migrate-me");
    cpSync(sample, novel, { recursive: true });
    asFormatV1(novel);
    mkdirSync(join(novel, ".github/gh-writer"), { recursive: true });
    writeFileSync(join(novel, ".github/gh-writer/validate.mjs"), "// an older validator\n");
    // One date for both commits, so the compiles can be compared byte for byte.
    const date = { GIT_AUTHOR_DATE: "2026-10-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T12:00:00Z" };
    const git = (...args: string[]) => spawnSync("git", ["-C", novel, ...args], { encoding: "utf8", env: { ...process.env, ...date } }).stdout;
    for (const args of [["init", "-q"], ["config", "user.name", "t"], ["config", "user.email", "t@t"], ["add", "-A"], ["commit", "-qm", "Draft"]]) git(...args);
    const compiled = () => {
      expect(run(main, "compile", novel, "--format", "docx", "--out", join(tmp, "migrate-out")).code).toBe(0);
      return readFileSync(join(tmp, "migrate-out/the-bridge-at-varn.docx"));
    };
    const before = compiled();

    const r = spawnSync("node", [main, "migrate", novel], { encoding: "utf8", env: { ...env(), ...date } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^Moved from format v1 to v2, in commit [0-9a-f]{7}: “Format v2: off-page events as files”\.\n/);
    expect(git("log", "-1", "--format=%s")).toBe("Format v2: off-page events as files\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "--name-status", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "A\t.github/gh-writer/compile.mjs",
      ...["LICENSE-LiberationSerif.txt", "LiberationSerif-Bold.ttf", "LiberationSerif-BoldItalic.ttf", "LiberationSerif-Italic.ttf", "LiberationSerif-Regular.ttf"].map((f) => `A\t.github/gh-writer/fonts/${f}`),
      "A\t.github/gh-writer/init.mjs",
      "A\t.github/gh-writer/snapshots.mjs",
      "A\tbible/events/ada-leaves-for-the-polytechnic.md",
      "A\tbible/events/the-flood-of-09.md",
      "A\tbible/events/the-plans-are-stolen.md",
      "D\tbible/events.yaml",
      "M\t.github/gh-writer/validate.mjs",
      "M\tnovel.yaml",
    ].sort());
    expect(readFileSync(join(novel, ".github/gh-writer/validate.mjs")).equals(readFileSync(join(repo, "templates/novel/.github/gh-writer/validate.mjs")))).toBe(true);
    expect(run(join(novel, ".github/gh-writer/validate.mjs"), novel)).toMatchObject({ code: 0, out: expect.stringContaining("0 errors, 0 warnings") });
    expect(compiled().equals(before)).toBe(true);

    expect(run(main, "migrate", novel)).toMatchObject({ code: 0, out: "Already in the newest format: nothing to do.\n" });
  }, 30_000); // Runs the CLI five times and two compiles: about 3 s alone, past 5 s on a busy machine.

  it("says why it can't migrate, exiting 1", () => {
    const novel = join(tmp, "migrate-clash");
    cpSync(sample, novel, { recursive: true });
    asFormatV1(novel);
    const config = join(novel, "novel.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("folder: artifacts", "folder: events"));
    expect(run(main, "migrate", novel)).toMatchObject({ code: 1, err: expect.stringContaining("keeps its entries in bible/events/") });
  });
});

describe("gh-writer compile", () => {
  it("writes each format into compiled/ (which ignores itself), dated from the commit, chapters as asked", () => {
    const novel = join(tmp, "compile-me");
    cpSync(sample, novel, { recursive: true });
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Draft"]]) spawnSync("git", ["-C", novel, ...args]);
    const r = run(main, "compile", novel, "--format", "docx,pdf", "--from", "ch_01dde6", "--to", "ch_01dde6");
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/^Compiled 1 chapter \(145 words\): .*compiled\/the-bridge-at-varn-chapter-2\.docx, .*compiled\/the-bridge-at-varn-chapter-2\.pdf\n$/);
    expect(readFileSync(join(novel, "compiled/.gitignore"), "utf8")).toContain("*");
    // The files leave the novel as committed: compiling again gives the same bytes.
    expect(spawnSync("git", ["-C", novel, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
    const first = readFileSync(join(novel, "compiled/the-bridge-at-varn-chapter-2.pdf"));
    expect(run(main, "compile", novel, "--format", "pdf", "--from", "ch_01dde6", "--to", "ch_01dde6").code).toBe(0);
    expect(readFileSync(join(novel, "compiled/the-bridge-at-varn-chapter-2.pdf")).equals(first)).toBe(true);
  });

  it("says what's wrong with a format, preset or range, exiting 1", () => {
    const out = join(tmp, "nowhere");
    expect(run(main, "compile", sample, "--format", "odt", "--out", out)).toMatchObject({ code: 1, out: expect.stringContaining('not "odt"') });
    expect(run(main, "compile", sample, "--preset", "nope", "--out", out)).toMatchObject({ code: 1, out: expect.stringContaining("nope") });
    expect(run(main, "compile", sample, "--from", "ch_h01d50", "--to", "ch_arr1va", "--out", out)).toMatchObject({ code: 1, out: expect.stringContaining("ends before it starts") });
  });
});
