import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runCompile } from "../src/compile-command.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const template = join(repo, "templates/novel");
const tmp = mkdtempSync(join(tmpdir(), "gh-writer-template-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const node = (args: string[], cwd = repo) => spawnSync("node", args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("novel template", () => {
  it("validates cleanly with its own vendored validator", () => {
    const r = node([join(template, ".github/gh-writer/validate.mjs"), template]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("0 errors, 0 warnings");
  });

  it("vendors a validator that matches the current source", () => {
    const fresh = join(tmp, "validate.mjs");
    expect(node([join(repo, "scripts/build-validator.ts"), fresh]).status).toBe(0);
    const vendored = readFileSync(join(template, ".github/gh-writer/validate.mjs"), "utf8");
    expect(vendored === readFileSync(fresh, "utf8"), "run `npm run build:template`").toBe(true);
  }, 30_000);

  it("vendors a snapshot writer that matches the current source, and its own snapshots are current", () => {
    const fresh = join(tmp, "snapshots.mjs");
    expect(node([join(repo, "scripts/build-validator.ts"), "--snapshots", fresh]).status).toBe(0);
    const vendored = readFileSync(join(template, ".github/gh-writer/snapshots.mjs"), "utf8");
    expect(vendored === readFileSync(fresh, "utf8"), "run `npm run build:template`").toBe(true);
    for (const dir of [template, join(repo, "examples/sample-novel")]) {
      const check = node([join(template, ".github/gh-writer/snapshots.mjs"), dir, "--check"]);
      expect(check.status, `${dir}: ${check.stdout} (run \`npm run build:template\`)`).toBe(0);
    }
  }, 30_000);

  it("vendors a compiler that matches the current source, with gh-writer's type alongside", () => {
    const fresh = join(tmp, "compile", "compile.mjs");
    expect(node([join(repo, "scripts/build-validator.ts"), "--compile", fresh]).status).toBe(0);
    const vendored = join(template, ".github/gh-writer");
    expect(readFileSync(join(vendored, "compile.mjs"), "utf8") === readFileSync(fresh, "utf8"), "run `npm run build:template`").toBe(true);
    const fonts = join(repo, "packages/export/fonts");
    expect(readdirSync(join(vendored, "fonts")).sort()).toEqual(readdirSync(fonts).sort());
    for (const f of readdirSync(fonts)) expect(readFileSync(join(vendored, "fonts", f)).equals(readFileSync(join(fonts, f))), f).toBe(true);
  }, 60_000);

  it("the vendored compiler makes the same files, byte for byte, as the app's compiler from the same commit", async () => {
    const novel = join(tmp, "compile-sample");
    cpSync(join(repo, "examples/sample-novel"), novel, { recursive: true });
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Draft"]]) spawnSync("git", ["-C", novel, ...args]);
    const bundled = node([join(template, ".github/gh-writer/compile.mjs"), novel, "--out", join(tmp, "by-bundle")]);
    expect(bundled.status, bundled.stdout + bundled.stderr).toBe(0);
    expect(await runCompile(novel, { out: join(tmp, "by-app") }, () => {})).toBe(0);
    const files = readdirSync(join(tmp, "by-app")).sort();
    expect(files).toEqual(["the-bridge-at-varn.docx", "the-bridge-at-varn.epub", "the-bridge-at-varn.pdf"]);
    expect(readdirSync(join(tmp, "by-bundle")).sort()).toEqual(files);
    for (const f of files) expect(readFileSync(join(tmp, "by-bundle", f)).equals(readFileSync(join(tmp, "by-app", f))), f).toBe(true);
  }, 60_000);

  it("compiles named checkpoints into a Release, and on demand with a preset and range", () => {
    const wf = parse(readFileSync(join(template, ".github/workflows/compile.yml"), "utf8")) as {
      on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, unknown> } };
      permissions: { contents: string };
      jobs: { compile: { if: string; steps: { if?: string; run?: string; uses?: string }[] } };
    };
    expect(wf.on.push.tags).toEqual(["checkpoint/**"]);
    expect(Object.keys(wf.on.workflow_dispatch.inputs)).toEqual(["preset", "from", "to", "format"]);
    expect(wf.permissions.contents).toBe("write");
    expect(wf.jobs.compile.if).toContain("is_template");
    const steps = wf.jobs.compile.steps;
    const runs = steps.map((s) => s.run ?? "").join("\n");
    // Checkpoints gh-writer takes by itself carry this trailer (packages/server/src/checkpoints.ts).
    expect(runs).toContain("grep -q '^Checkpoint: *auto$'");
    expect(runs).toContain("node .github/gh-writer/compile.mjs . --out compiled");
    expect(runs).toContain('gh release create "$TAG" compiled/* --verify-tag --title "$NAME"');
    expect(steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))?.if).toBe("github.event_name == 'workflow_dispatch'");
  });

  it("the vendored snapshot writer redraws a novel's relationships after a relationship changes", () => {
    const novel = join(tmp, "sample-copy");
    cpSync(join(repo, "examples/sample-novel"), novel, { recursive: true });
    // The sample carries its snapshots: start from none.
    for (const f of ["README.md", "relationships.svg", "plotlines.svg", "presence-characters.svg", "presence-themes.svg", "timeline.svg"]) rmSync(join(novel, "diagrams", f), { force: true });
    const writer = join(template, ".github/gh-writer/snapshots.mjs");
    expect(node([writer, novel]).stdout).toContain("Wrote diagrams/relationships.svg");
    const before = readFileSync(join(novel, "diagrams/relationships.svg"), "utf8");
    const rels = join(novel, "bible/relationships.yaml");
    writeFileSync(rels, readFileSync(rels, "utf8").replace("    type: allies\n    since: sc_r1vet8", "    type: rivals\n    since: sc_r1vet8"));
    expect(node([writer, novel]).stdout).toContain("Wrote diagrams/relationships.svg, diagrams/README.md");
    const after = readFileSync(join(novel, "diagrams/relationships.svg"), "utf8");
    expect(before).toContain(">Allied with<");
    expect(after).not.toContain(">Allied with<");
    expect(after).toContain(">Rivals with<");
  });

  it("runs the snapshot writer on pushes that change the story, and commits only diagrams/", () => {
    const wf = parse(readFileSync(join(template, ".github/workflows/diagrams.yml"), "utf8")) as {
      on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown };
      permissions: { contents: string };
      jobs: { snapshots: { if: string; steps: { run?: string }[] } };
    };
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.on.push.paths).toEqual(["manuscript/**", "bible/**", "novel.yaml", "diagrams/layouts.yaml"]);
    expect(wf.permissions.contents).toBe("write");
    expect(wf.jobs.snapshots.if).toContain("is_template");
    const runs = wf.jobs.snapshots.steps.map((s) => s.run ?? "");
    expect(runs).toContain("node .github/gh-writer/snapshots.mjs");
    expect(runs.find((r) => r.includes("git commit"))).toMatch(/git add diagrams\n/);
    const setup = readFileSync(join(template, ".github/workflows/setup.yml"), "utf8");
    expect(setup).toContain("run: node .github/gh-writer/snapshots.mjs");
  });

  it("init.mjs gives a copy fresh IDs and a title, stays valid, and is idempotent", () => {
    const copy = join(tmp, "my-great-novel");
    cpSync(template, copy, { recursive: true });
    const init = join(copy, ".github/gh-writer/init.mjs");

    expect(node([init, "my-great-novel"], copy).status).toBe(0);
    const novel = parse(readFileSync(join(copy, "novel.yaml"), "utf8")) as { id: string; title: string };
    expect(novel.title).toBe("My Great Novel");
    expect(novel.id).toMatch(/^nv_[0-9a-hjkmnp-tv-z]{6}$/);
    expect(novel.id).not.toBe("nv_temp1a");
    const scene = readFileSync(join(copy, "manuscript/01-chapter-one/01-opening.md"), "utf8");
    expect(scene).not.toContain("temp1a");

    expect(node([join(copy, ".github/gh-writer/validate.mjs"), copy]).status).toBe(0);

    const again = node([init, "Something Else"], copy);
    expect(again.stdout).toContain("already set up");
    expect((parse(readFileSync(join(copy, "novel.yaml"), "utf8")) as { id: string }).id).toBe(novel.id);
  });
});
