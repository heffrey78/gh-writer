import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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

describe("gh-writer serve", () => {
  it("opens the novel, prints a launch URL with a token, serves it, and exits cleanly on SIGTERM", async () => {
    const child = spawn("node", [main, "serve", sample, "--no-open"], { env: env() });
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
    expect(out).toContain(`gh-writer is serving The Bridge at Varn (${realpathSync(sample)})`);

    const exchange = await fetch(launch, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0] ?? "";
    const library = (await (await fetch(new URL("/api/library", launch), { headers: { cookie } })).json()) as { novels: { path: string }[] };
    expect(library.novels.map((n) => n.path)).toEqual([realpathSync(sample)]);
    expect((await fetch(new URL("/api/library", launch))).status).toBe(403);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(out).toContain("SIGTERM: stopping…\nStopped.");
  }, 15_000);

  it("refuses a folder that isn't a novel repository, a missing folder and a bad port", () => {
    expect(run(main, "serve", broken, "--no-open")).toMatchObject({ code: 1, err: expect.stringContaining("isn't a git repository") });
    expect(run(main, "serve", join(tmp, "missing"), "--no-open").err).toContain("isn't a folder");
    expect(run(main, "serve", sample, "--port", "70000")).toMatchObject({ code: 1 });
    expect(run(main, "serve", sample, "--sync-every", "soon")).toMatchObject({ code: 1, err: expect.stringContaining("--sync-every") });
  });
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
